import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { WorkflowDefinitionSchema, type JsonValue, type Specification, type WorkflowDefinition } from "@bflow/contracts";
import type { CommandSpec } from "../args.js";
import { conflictError, errorReport, HIGH_LEVEL_EXIT_CODES, HighLevelError, permissionError, validationError, type CommandReport } from "../envelope.js";
import { guarded, readWorkflowFile, requireRepository, resolveInput, runJournaled, StepLog, type HighLevelHandler } from "../context.js";
import { requestDigest } from "../journal.js";
import { loadSpecification, tracedTaskIds } from "./shared.js";

export const TASK_PLAN_SPEC: CommandSpec = {
  name: "task.plan",
  behavior: { summary: "Create (preview/write) or check the task graph of a specification", mutates: "repository", retry: "retry_safe", idempotencyKey: "task.plan:<spec-id>:<content-digest>", permissionFlags: ["--write", "--force"], outcomes: ["preview", "planned", "checked", "failed"] },
  words: ["task", "plan"],
  positionals: [],
  flags: {
    "--spec": { type: "string", required: true },
    "--workflow": { type: "string" },
    "--write": { type: "boolean" },
    "--out": { type: "string" },
    "--force": { type: "boolean" }
  }
};

export const PLAN_DIRECTORY = ".bflow/plans";

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The output must resolve inside the canonical repository root even through symlinks: the target
 * itself may not be a symlink and its nearest existing ancestor must resolve inside the root.
 */
export async function assertPlanPathInside(root: string, out: string): Promise<string> {
  const outside = (reason: string) => new HighLevelError(validationError(
    `Plan output must stay inside the repository (${reason}): ${out}`, { reason: "path_outside_repository" }));
  const canonicalRoot = await realpath(root);
  const lexical = relative(canonicalRoot, resolve(out));
  if (lexical === "" || lexical.startsWith("..") || isAbsolute(lexical)) throw outside("outside root");
  try {
    if ((await lstat(out)).isSymbolicLink()) throw outside("target is a symlink");
  } catch (error) {
    if (error instanceof HighLevelError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let ancestor = dirname(resolve(out));
  for (;;) {
    try {
      const real = await realpath(ancestor);
      const rel = relative(canonicalRoot, real);
      if (rel.startsWith("..") || isAbsolute(rel)) throw outside("a parent directory resolves outside the root");
      break;
    } catch (error) {
      if (error instanceof HighLevelError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  return lexical;
}

export function defaultPlanPath(root: string, specId: string): string {
  return join(root, PLAN_DIRECTORY, `${specId.replace(/[^A-Za-z0-9._-]/g, "_")}.workflow.json`);
}

/**
 * Deterministic projection of the specification's traceability into a task graph. Ordering
 * between tasks is not inferable from a specification; the Coordinator declares dependencies.
 */
export function deriveTaskGraph(spec: Specification): WorkflowDefinition {
  const taskIds = tracedTaskIds(spec);
  if (taskIds.length === 0)
    throw new HighLevelError(validationError(`Specification '${spec.specId}' traces no tasks; add traceabilityTaskIds and SDD traceability`,
      { reason: "no_traced_tasks" }));
  const sdd = spec.metadata?.sdd as { traceability?: { criterionId: string; taskIds: string[] }[] } | undefined;
  const criteriaFor = (taskId: string) => spec.acceptanceCriteria.filter(criterion =>
    (sdd?.traceability ?? []).some(m => m.criterionId === criterion.id && m.taskIds.includes(taskId)));
  return WorkflowDefinitionSchema.parse({
    schemaVersion: "1",
    id: `spec-${spec.specId}`,
    name: spec.title,
    version: String(spec.version ?? 1),
    description: spec.summary,
    tasks: taskIds.map(taskId => {
      const criteria = criteriaFor(taskId);
      return {
        id: taskId,
        title: `${spec.title} — ${taskId}`,
        role: "developer",
        instruction: `Implement task '${taskId}' of specification '${spec.specId}' v${spec.version ?? 1}: ${spec.summary}` +
          (criteria.length > 0 ? ` Criteria: ${criteria.map(c => `${c.id}: ${c.description}`).join(" ")}` : ""),
        // P15 traceability identifies criteria by ID inside workflow tasks.
        acceptanceCriteria: criteria.map(c => c.id),
        retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 1000, maxDelayMs: 1000, jitter: false },
        timeout: { executionTimeoutMs: 3_600_000, onTimeout: "block" },
        requiresApproval: false,
        qualityGates: [],
        metadata: { specId: spec.specId, specVersion: spec.version ?? 1, criterionIds: criteria.map(c => c.id) }
      };
    }),
    dependencies: [],
    qualityGates: [],
    maxConcurrency: Math.max(1, Math.min(taskIds.length, 2)),
    failurePolicy: "block",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" },
    metadata: { source: "bflow task plan", specId: spec.specId, specVersion: spec.version ?? 1,
      dependencyPolicy: "not derived from specification; declared by Coordinator" }
  });
}

function graphSummary(workflow: WorkflowDefinition): JsonValue {
  return {
    workflowId: workflow.id,
    tasks: workflow.tasks.map(task => ({ id: task.id, role: task.role,
      dependsOn: workflow.dependencies.filter(d => d.taskId === task.id).map(d => d.dependsOnTaskId) })),
    dependencyCount: workflow.dependencies.length
  };
}

function matrixData(matrix: unknown): JsonValue {
  return JSON.parse(JSON.stringify(matrix)) as JsonValue;
}

export const taskPlan: HighLevelHandler = async (args, ctx, identity) => {
  const log = new StepLog(undefined, ctx.onProgress);
  return guarded("task.plan", log, {}, async () => {
    const loaded = await loadSpecification(ctx, log, args.strings.get("--spec")!);
    const { spec } = loaded;
    const workflowPath = args.strings.get("--workflow");

    if (workflowPath !== undefined) {
      if (args.booleans.has("--write")) throw new HighLevelError(validationError("--write cannot be combined with --workflow", { reason: "usage" }));
      const workflow = await log.check("load-workflow", () => readWorkflowFile(resolveInput(ctx, workflowPath)), graphSummary);
      const matrix = await log.check("check-traceability", () => ctx.services.specification.buildTraceabilityMatrix(spec, workflow), matrixData);
      return {
        command: "task.plan", outcome: "checked", status: "succeeded",
        exitCode: matrix.valid ? HIGH_LEVEL_EXIT_CODES.SUCCESS : HIGH_LEVEL_EXIT_CODES.NOT_READY,
        steps: log.steps,
        data: { specId: spec.specId, valid: matrix.valid, traceability: matrixData(matrix), graph: graphSummary(workflow) }
      };
    }

    const workflow = await log.check("derive-task-graph", () => deriveTaskGraph(spec), graphSummary);
    const matrix = await log.check("check-traceability", () => ctx.services.specification.buildTraceabilityMatrix(spec, workflow), matrixData);
    if (!matrix.valid)
      throw new HighLevelError(validationError("Derived task graph does not satisfy specification traceability", { reason: "traceability_invalid" }));
    const document = `${JSON.stringify(workflow, null, 2)}\n`;
    const baseData = { specId: spec.specId, valid: true, traceability: matrixData(matrix), graph: graphSummary(workflow),
      workflow: JSON.parse(document) as JsonValue };

    if (!args.booleans.has("--write"))
      return { command: "task.plan", outcome: "preview", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS,
        steps: [...log.steps, { id: "write-plan", status: "skipped", message: "Preview only; pass --write to persist" }],
        data: { ...baseData, written: false } };

    const repository = await requireRepository(ctx.cwd);
    const outArg = args.strings.get("--out");
    const out = outArg === undefined ? defaultPlanPath(repository.root, spec.specId) : resolveInput(ctx, outArg);
    const rel = await log.check("check-output-path", () => assertPlanPathInside(repository.root, out), value => ({ path: value }));
    // The file's current content is part of the request: a replay can never report a write that a
    // later manual edit has since undone, and an edited plan is re-evaluated (and needs --force).
    const existing = await readExisting(out);
    if (existing === document)
      return { command: "task.plan", outcome: "planned", status: "succeeded", exitCode: 0,
        steps: [...log.steps, { id: "write-plan", status: "reused", message: "Plan already up to date", data: { path: rel } }],
        data: { ...baseData, written: false, unchanged: true, path: rel } };
    const existingDigest = existing === undefined ? null : requestDigest(existing);
    const key = args.idempotencyKey ?? `task.plan:${spec.specId}:${requestDigest({ out: rel, document, existingDigest })}`;
    return runJournaled({
      command: "task.plan", repositoryRoot: repository.root, key,
      request: { specDigest: loaded.digest, out: rel, document, existingDigest },
      retrySafe: true, resume: false, identity, clock: ctx.clock, onProgress: ctx.onProgress
    }, async (journalLog): Promise<CommandReport> => {
      journalLog.steps.unshift(...log.steps);
      // Re-read under the receipt lock; another invocation may have written meanwhile.
      if (await readExisting(out) !== existing)
        throw new HighLevelError(conflictError(`Plan '${rel}' changed while preparing the write; re-run the command`,
          { reason: "plan_changed" }));
      if (existing !== undefined && !args.booleans.has("--force"))
        throw new HighLevelError(permissionError(`Plan '${rel}' exists with different content; pass --force to replace it`, "--force"));
      await journalLog.sideEffect("write-plan", async () => {
        const { writeFile, rename } = await import("node:fs/promises");
        await mkdir(dirname(out), { recursive: true });
        const temporary = `${out}.${process.pid}.tmp`;
        await writeFile(temporary, document, { mode: 0o644 });
        await rename(temporary, out);
      }, () => ({ path: rel, replaced: existing !== undefined }));
      return { command: "task.plan", outcome: "planned", status: "succeeded", exitCode: 0, steps: journalLog.steps,
        idempotencyKey: key, data: { ...baseData, written: true, unchanged: false, path: rel } };
    }, (error, journalLog) => errorReport("task.plan", error, { steps: journalLog.steps, idempotencyKey: key }));
  });
};
