import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  GitChangeSetSchema,
  VerificationCycleSchema,
  type GitChangeSet,
  type JsonValue,
  type Specification,
  type VerificationCycle
} from "@bflow/contracts";
import type { CommandSpec } from "../args.js";
import {
  errorReport,
  HIGH_LEVEL_EXIT_CODES,
  HighLevelError,
  notFoundError,
  validationError,
  type CommandReport
} from "../envelope.js";
import {
  assertStateIgnored,
  CLI_STATE_DIRECTORY,
  guarded,
  listJournalReports,
  openJournal,
  readJsonFile,
  requireRepository,
  resolveInput,
  runJournaled,
  StepLog,
  type HighLevelHandler
} from "../context.js";
import { requestDigest } from "../journal.js";
import type { HighLevelResources } from "../services.js";

export const VERIFY_SPEC: CommandSpec = {
  name: "verify",
  behavior: { summary: "Run VerificationPlan checks through the Verification Engine and return evidence", mutates: "repository", retry: "retry_safe", idempotencyKey: "verify:<run-id>:<task-id>:<plan-id>:<change-set-id>:<head>", permissionFlags: [], outcomes: ["passed", "not_passed", "failed"] },
  words: ["verify"],
  positionals: [{ name: "task-id", required: true }],
  flags: {
    "--run": { type: "string", required: true },
    "--plan": { type: "string", required: true },
    "--change-set": { type: "string" },
    "--repair": { type: "string" },
    "--integration": { type: "string" },
    "--artifact-root": { type: "string" },
    "--artifact-store-id": { type: "string" }
  }
};

const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

function cyclePath(root: string, runId: string, taskId: string): string {
  const id = createHash("sha256").update(`${runId}\0${taskId}`).digest("hex").slice(0, 32);
  return join(root, CLI_STATE_DIRECTORY, "verification", `${id}.cycle.json`);
}

async function readCycle(path: string): Promise<VerificationCycle | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return undefined; }
  const parsed = VerificationCycleSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new HighLevelError({ code: "corruption", retryable: false, message: `Verification cycle state is corrupt: ${path}` });
  return parsed.data;
}

async function writeCycle(path: string, cycle: VerificationCycle): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(cycle), { mode: 0o600 });
  await rename(temporary, path);
}

/** Runs the VerificationPlan checks through the P17 engine and returns its structured result. */
export const verify: HighLevelHandler = async (args, ctx, identity) => {
  const log = new StepLog();
  const taskId = args.positionals["task-id"]!;
  const runId = args.strings.get("--run")!;
  const partial = { runId, taskId };
  return guarded("verify", log, partial, async () => {
    const repository = await requireRepository(ctx.cwd);
    const planPath = resolveInput(ctx, args.strings.get("--plan")!);
    const planInput = await log.check("load-plan", async () => {
      const raw = await readJsonFile(planPath, "Verification plan");
      if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        throw new HighLevelError(validationError("Verification plan must be a JSON object", { reason: "invalid_plan" }));
      const value = raw as Record<string, unknown>;
      if (value.runId !== runId || value.taskId !== taskId)
        throw new HighLevelError(notFoundError(`Plan '${planPath}' is for run '${String(value.runId)}' task '${String(value.taskId)}', not '${runId}'/'${taskId}'`,
          { reason: "task_not_found" }));
      return value;
    }, value => ({ scope: typeof value.scope === "string" ? value.scope : null,
      checks: Array.isArray(value.checks) ? value.checks.length : 0 }));

    let resources: HighLevelResources | undefined;
    try {
      await assertStateIgnored(repository.root);
      resources = await log.check("open-resources", () => ctx.services.openResources(repository.root, {
        artifactRoot: args.strings.get("--artifact-root"), storeId: args.strings.get("--artifact-store-id") }));
      const store = resources.artifactStore;
      const loadSpecification = async (specId: string): Promise<Specification> => {
        const current = (await readJsonFile(planPath, "Verification plan")) as { specification?: Specification };
        if (current.specification?.specId !== specId) throw new Error(`Specification '${specId}' is no longer in the plan`);
        return current.specification;
      };
      const engine = ctx.services.verification({ artifactStore: store, gates: ctx.services.gates ?? [], loadSpecification });
      const plan = await log.check("build-plan", () => {
        try { return engine.createPlan(planInput); } catch (error) {
          throw new HighLevelError(validationError(`Invalid verification plan: ${(error as Error).message}`, { reason: "invalid_plan" }));
        }
      }, value => ({ planId: value.planId, scope: value.scope, maxIterations: value.maxIterations,
        checks: value.checks.map(check => check.id), gatesConfigured: (ctx.services.gates ?? []).map(gate => gate.id) }));

      const change: GitChangeSet = await log.check("collect-change-set", async () => {
        const changePath = args.strings.get("--change-set");
        if (changePath !== undefined) {
          const parsed = GitChangeSetSchema.safeParse(await readJsonFile(resolveInput(ctx, changePath), "Change set"));
          if (!parsed.success) throw new HighLevelError(validationError(`Invalid change set: ${parsed.error.message}`, { reason: "invalid_change_set" }));
          return parsed.data;
        }
        // The most recently prepared attempt, consistent with `git prepare`.
        const prepared = (await listJournalReports(repository.root, "task.implement")).filter(r => r.runId === runId && r.taskId === taskId).at(-1);
        const taskKey = (prepared?.data as { taskKey?: unknown } | undefined)?.taskKey;
        if (typeof taskKey !== "string")
          throw new HighLevelError(notFoundError(`No prepared task '${taskId}' in run '${runId}'; run 'bflow task implement' or pass --change-set`,
            { reason: "task_not_found" }));
        return resources!.git.collectTask(taskKey);
      }, value => ({ changeSetId: value.changeSetId, headCommitHash: value.headCommitHash, files: value.filesChanged.length }));

      const options: Record<string, unknown> = {};
      const repairPath = args.strings.get("--repair");
      if (repairPath !== undefined) options.repair = await readJsonFile(resolveInput(ctx, repairPath), "Repair record");
      const integrationPath = args.strings.get("--integration");
      if (integrationPath !== undefined) options.integration = await readJsonFile(resolveInput(ctx, integrationPath), "Integration");

      const statePath = cyclePath(repository.root, runId, taskId);
      const key = args.idempotencyKey ?? `verify:${runId}:${taskId}:${plan.planId}:${change.changeSetId}:${change.headCommitHash}`;
      const request = json({ planId: plan.planId, changeSetId: change.changeSetId, head: change.headCommitHash,
        options: requestDigest(json(options)) });
      // One verification cycle per run/task: concurrent invocations with different change sets must
      // not both read and overwrite the same persisted cycle.
      const journal = await openJournal({ repositoryRoot: repository.root });
      return await journal.withLock(`verify-cycle:${runId}:${taskId}`, () => runJournaled({ command: "verify",
        repositoryRoot: repository.root, key, request, retrySafe: true, resume: false,
        identity, clock: ctx.clock }, async (journalLog): Promise<CommandReport> => {
        journalLog.steps.unshift(...log.steps);
        const cycle = await journalLog.check("load-cycle", async () => {
          // A new plan (e.g. a revised specification) starts a new bounded cycle.
          const cycleId = `cycle-${createHash("sha256").update(`${runId}\0${taskId}\0${plan.planId}`).digest("hex").slice(0, 24)}`;
          const persisted = await readCycle(statePath);
          return persisted !== undefined && persisted.cycleId === cycleId ? persisted : engine.start(plan, cycleId);
        }, value => ({ cycleId: value.cycleId, iteration: value.currentIteration, status: value.status }));
        const outcome = await journalLog.sideEffect("run-checks", () => engine.verify(plan, cycle, change, options),
          value => ({ status: value.result.status, findings: value.result.findings.length }));
        await journalLog.sideEffect("persist-cycle", () => writeCycle(statePath, outcome.cycle),
          () => ({ cycleStatus: outcome.cycle.status, iteration: outcome.cycle.currentIteration }));
        const passed = outcome.result.status === "passed";
        return {
          command: "verify", outcome: passed ? "passed" : "not_passed", status: "succeeded",
          exitCode: passed ? HIGH_LEVEL_EXIT_CODES.SUCCESS : HIGH_LEVEL_EXIT_CODES.NOT_READY,
          steps: journalLog.steps, runId, taskId, idempotencyKey: key, artifacts: outcome.result.evidenceArtifacts,
          data: {
            verification: json(outcome.result),
            cycle: { cycleId: outcome.cycle.cycleId, status: outcome.cycle.status, iteration: outcome.cycle.currentIteration,
              maxIterations: outcome.cycle.maxIterations },
            // Runtime delivers these through Herdr; the CLI never sends role messages itself.
            pendingMessages: json(outcome.messages)
          }
        };
      }, (error, journalLog) => errorReport("verify", error, { ...partial, idempotencyKey: key, steps: journalLog.steps })));
    } finally {
      await resources?.close();
    }
  });
};
