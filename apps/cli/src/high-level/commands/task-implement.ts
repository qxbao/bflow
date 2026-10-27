import { prepareExecutionExpectation } from "../execution-preview.js";
import type { JsonValue, RuntimeService, TestStrategy } from "@bflow/contracts";
import type { TaskRecord } from "@bflow/git-orchestrator";
import type { CommandSpec } from "../args.js";
import {
  errorReport,
  HIGH_LEVEL_EXIT_CODES,
  HighLevelError,
  notFoundError,
  validationError,
  type CommandReport,
  type CommandStep
} from "../envelope.js";
import {
  describeError,
  guarded,
  readWorkflowFile,
  requireRepository,
  resolveInput,
  runJournaled,
  StepLog,
  type HighLevelContext,
  type HighLevelHandler
} from "../context.js";
import { bindSpecificationArtifacts, type HighLevelResources } from "../services.js";
import { assertApproved, loadSpecification, tracedTaskIds } from "./shared.js";

export const TASK_IMPLEMENT_SPEC: CommandSpec = {
  name: "task.implement",
  behavior: { summary: "Prepare worktree, specification context, TDD policy and Developer assignment request", mutates: "repository", retry: "resume_required", idempotencyKey: "task.implement:<run-id>:<task-id>:<attempt>", permissionFlags: [], outcomes: ["prepared", "failed", "reconciliation_required"] },
  words: ["task", "implement"],
  positionals: [{ name: "task-id", required: true }],
  flags: {
    "--expect-plan": { type: "string" },
    "--run": { type: "string", required: true },
    "--spec": { type: "string", required: true },
    "--workflow": { type: "string" },
    "--base": { type: "string" },
    "--attempt": { type: "string" },
    "--developer": { type: "string" },
    "--owned-path": { type: "string", multiple: true },
    "--forbidden-path": { type: "string", multiple: true },
    "--artifact-root": { type: "string" },
    "--artifact-store-id": { type: "string" },
    "--resume": { type: "boolean" }
  }
};

const GLOB = /[*?[\]{}]/;

export function strategySummary(strategy: TestStrategy): JsonValue {
  return {
    strategyId: strategy.strategyId,
    mode: strategy.tddDecision.mode,
    requiresFailingTestFirst: strategy.tddDecision.requiresFailingTestFirst,
    rationale: strategy.tddDecision.rationale,
    decisionId: strategy.tddDecision.decisionId,
    requiredTestLevels: [...strategy.requiredTestLevels],
    targetCommands: [...strategy.targetCommands],
    independentVerificationRequired: strategy.independentVerificationRequired
  };
}

async function openRuntime(ctx: HighLevelContext, root: string): Promise<{ runtime: RuntimeService; close(): Promise<void> } | undefined> {
  if (ctx.runtime !== undefined) return { runtime: ctx.runtime, close: async () => undefined };
  return ctx.services.openRuntime?.(root);
}

/** Read-only observation of Git task state and Runtime task state; never infers task success. */
export async function observeExecution(ctx: HighLevelContext, root: string, runId: string, taskId: string,
  taskKey: string | undefined, resources: HighLevelResources | undefined): Promise<CommandStep> {
  const data: Record<string, JsonValue> = {};
  if (taskKey !== undefined && resources !== undefined) {
    try {
      const task = await resources.git.getTask(taskKey);
      data.git = { status: task.status, headCommitHash: task.headCommitHash ?? null, submitted: task.changeSet !== undefined };
    } catch (error) {
      data.git = { status: "unobserved", reason: describeError(error) };
    }
  }
  let handle: Awaited<ReturnType<typeof openRuntime>>;
  try {
    handle = await openRuntime(ctx, root);
  } catch (error) {
    data.runtime = { observed: false, reason: describeError(error) };
  }
  if (handle !== undefined) {
    try {
      const run = await handle.runtime.getRun(runId, ctx.signal !== undefined ? { signal: ctx.signal } : undefined);
      if (!run.ok) data.runtime = { observed: false, reason: run.error.message };
      else if (run.value === null) data.runtime = { observed: false, reason: `Run '${runId}' is not known to Runtime yet` };
      else {
        const task = run.value.tasks.find(t => t.taskId === taskId);
        data.runtime = task === undefined
          ? { observed: true, runStatus: run.value.status, taskStatus: null, reason: `Run has no task '${taskId}'` }
          : { observed: true, runStatus: run.value.status, taskStatus: task.status, attempt: task.attempt,
              generation: task.generation, blockage: task.blockage?.code ?? null };
      }
    } finally {
      await handle.close();
    }
  } else if (data.runtime === undefined) {
    data.runtime = { observed: false, reason: "Runtime is not initialized for this repository (run 'bflow init')" };
  }
  return { id: "observe-execution", status: "succeeded", message: "Observed state only; Herdr done is not task success", data };
}

export const taskImplement: HighLevelHandler = async (args, ctx, identity) => {
  const log = new StepLog(undefined, ctx.onProgress);
  const taskId = args.positionals["task-id"]!;
  const runId = args.strings.get("--run")!;
  const attemptId = args.strings.get("--attempt") ?? "attempt-1";
  const developerId = args.strings.get("--developer") ?? "developer-1";
  const base = args.strings.get("--base") ?? "HEAD";
  const partial = { runId, taskId };
  return guarded("task.implement", log, partial, async () => {
    let checkExpectation = args.strings.has("--expect-plan") ? await prepareExecutionExpectation(ctx.cwd, args.strings.get("--expect-plan")!, { runId, taskId, baseRevision: base }) : undefined;
    const repository = await requireRepository(ctx.cwd);
    const { spec, digest } = await loadSpecification(ctx, log, args.strings.get("--spec")!);
    await log.check("check-approval", () => assertApproved(spec), () => ({ approvedBy: spec.approvedBy ?? null }));
    if (args.strings.has("--expect-plan")) {
      const path = args.strings.get("--workflow");
      checkExpectation = await prepareExecutionExpectation(ctx.cwd, args.strings.get("--expect-plan")!, {
        runId, taskId, baseRevision: base, specification: spec,
        ...(path ? { workflow: await readWorkflowFile(resolveInput(ctx, path)) } : {})
      });
    }
    await log.check("check-run-binding", () => {
      if (spec.runId !== runId)
        throw new HighLevelError(validationError(`Specification '${spec.specId}' belongs to run '${spec.runId ?? "<none>"}', not '${runId}'`,
          { reason: "run_mismatch" }));
    });
    const workflowPath = args.strings.get("--workflow");
    await log.check("resolve-task", async () => {
      const traced = tracedTaskIds(spec);
      const workflow = workflowPath !== undefined ? await readWorkflowFile(resolveInput(ctx, workflowPath)) : undefined;
      const inWorkflow = workflow === undefined || workflow.tasks.some(task => task.id === taskId);
      if (!traced.includes(taskId) || !inWorkflow)
        throw new HighLevelError(notFoundError(`Task '${taskId}' is not traced by specification '${spec.specId}'` +
          (workflow !== undefined && !inWorkflow ? ` or workflow '${workflow.id}'` : ""), { reason: "task_not_found", knownTasks: traced }));
    }, () => ({ taskId }));
    const strategy = await log.check("resolve-tdd-policy", () => spec.testStrategy !== undefined
      ? ctx.services.strategy.validateAgainstSpecification(spec.testStrategy, spec)
      : ctx.services.strategy.resolve(spec), strategySummary);
    const matrix = ctx.services.specification.buildTraceabilityMatrix(spec);
    const criteria = spec.acceptanceCriteria.filter(c => (matrix.criterionToTasks[c.id] ?? []).includes(taskId));
    const ownedPaths = args.lists.get("--owned-path") ?? spec.affectedPaths;
    const forbiddenPaths = args.lists.get("--forbidden-path") ?? [];
    await log.check("build-context", () => {
      if (ownedPaths.some(path => GLOB.test(path)))
        throw new HighLevelError(validationError("Specification affected paths contain globs; pass literal --owned-path values",
          { reason: "glob_owned_path", affectedPaths: spec.affectedPaths }));
    }, () => ({ criteria: criteria.map(c => c.id), ownedPaths: [...ownedPaths], forbiddenPaths: [...forbiddenPaths] }));

    const key = args.idempotencyKey ?? `task.implement:${runId}:${taskId}:${attemptId}`;
    const request = { runId, taskId, attemptId, developerId, base, ownedPaths: [...ownedPaths], forbiddenPaths: [...forbiddenPaths], specDigest: digest };
    let resources: HighLevelResources | undefined;
    try {
      await checkExpectation?.();
      const report = await runJournaled({
        command: "task.implement", repositoryRoot: repository.root, key, request, retrySafe: false,
        resume: args.booleans.has("--resume"), identity, clock: ctx.clock, onProgress: ctx.onProgress
      }, async (journalLog): Promise<CommandReport> => {
        journalLog.steps.unshift(...log.steps);
        await checkExpectation?.();
        resources = await journalLog.check("open-resources", () => ctx.services.openResources(repository.root, {
          artifactRoot: args.strings.get("--artifact-root"), storeId: args.strings.get("--artifact-store-id") }));
        const specs = await bindSpecificationArtifacts(ctx.services.specification, resources.artifactStore);
        await journalLog.check("verify-specification-artifact", () => specs.verifyArtifact(spec),
          () => ({ artifactId: spec.artifactRef!.artifactId }));
        await checkExpectation?.();
        const task: TaskRecord = await journalLog.sideEffect("prepare-worktree", () => resources!.git.prepareTask({
          runId, taskId, attemptId, developerId, baseRevision: base, ownedPaths: [...ownedPaths], forbiddenPaths: [...forbiddenPaths]
        }), value => ({ taskKey: value.key, worktreePath: value.worktreePath, branchName: value.branchName,
          baseCommitHash: value.baseCommitHash, status: value.status }));
        const assignment: JsonValue = {
          kind: "developer_assignment_request",
          status: "awaiting_runtime_dispatch",
          runId, taskId, attemptId, role: "developer", developerId,
          taskKey: task.key, worktreePath: task.worktreePath, branchName: task.branchName, baseCommitHash: task.baseCommitHash,
          specification: { specId: spec.specId, version: spec.version ?? null, artifactId: spec.artifactRef!.artifactId, digest },
          tdd: strategySummary(strategy),
          acceptanceCriteria: criteria.map(c => ({ id: c.id, description: c.description, verificationMethod: c.verificationMethod, required: c.required })),
          ownedPaths: [...ownedPaths], forbiddenPaths: [...forbiddenPaths],
          dispatch: "Runtime issues the leased AgentAssignment (lease + fencing token) through the Coordinator; this command never dispatches an agent"
        };
        journalLog.add({ id: "prepare-assignment", status: "succeeded", data: { status: "awaiting_runtime_dispatch" } });
        return {
          command: "task.implement", outcome: "prepared", status: "succeeded", exitCode: HIGH_LEVEL_EXIT_CODES.SUCCESS,
          steps: journalLog.steps, runId, taskId, idempotencyKey: key,
          data: { taskKey: task.key, worktreePath: task.worktreePath, branchName: task.branchName, assignment }
        };
      }, (error, journalLog) => errorReport("task.implement", error, { ...partial, idempotencyKey: key, steps: journalLog.steps }));
      if (report.status !== "succeeded") return report;
      // Execution state is observed fresh on every invocation, including idempotent replays.
      if (resources === undefined) {
        try { resources = await ctx.services.openResources(repository.root, {
          artifactRoot: args.strings.get("--artifact-root"), storeId: args.strings.get("--artifact-store-id") }); }
        catch { resources = undefined; }
      }
      const data = report.data as { taskKey?: string };
      const observation = await observeExecution(ctx, repository.root, runId, taskId, data.taskKey, resources);
      return { ...report, steps: [...report.steps, observation] };
    } finally {
      await resources?.close();
    }
  });
};
