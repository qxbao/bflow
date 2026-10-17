import type { JsonValue } from "@bflow/contracts";
import type { IntegrationRecord, TaskRecord } from "@bflow/git-orchestrator";
import { readOnlyGit } from "../git.js";
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
  guarded,
  listJournalReports,
  readWorkflowFile,
  requireRepository,
  resolveInput,
  runJournaled,
  StepLog,
  type HighLevelHandler
} from "../context.js";
import type { HighLevelResources } from "../services.js";

export const GIT_PREPARE_SPEC: CommandSpec = {
  name: "git.prepare",
  behavior: { summary: "Check task commits/worktrees, prepare the integration branch, detect conflicts, request workflow verification", mutates: "repository", retry: "resume_required", idempotencyKey: "git.prepare:<run-id>:<integration-id>", permissionFlags: ["--yes"], outcomes: ["approval_required", "integration_prepared", "conflict_detected", "failed", "reconciliation_required"] },
  words: ["git", "prepare"],
  positionals: [{ name: "run-id", required: true }],
  flags: {
    "--task": { type: "string", multiple: true },
    "--workflow": { type: "string" },
    "--integration-id": { type: "string" },
    "--base": { type: "string" },
    "--yes": { type: "boolean" },
    "--resume": { type: "boolean" },
    "--artifact-root": { type: "string" },
    "--artifact-store-id": { type: "string" }
  }
};

const git = readOnlyGit;

/** Read-only inspection of a task worktree's commits and cleanliness. */
async function inspectTask(task: TaskRecord) {
  const [head, status, commits] = await Promise.all([
    git(task.worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD"]),
    git(task.worktreePath, ["status", "--porcelain=v1", "--untracked-files=normal"]),
    git(task.worktreePath, ["rev-list", "--count", `${task.baseCommitHash}..HEAD`])
  ]);
  const commitCount = commits.ok ? Number.parseInt(commits.stdout.trim(), 10) : 0;
  const clean = status.ok && status.stdout.trim().length === 0;
  return {
    taskId: task.request.taskId, taskKey: task.key, status: task.status, branchName: task.branchName,
    worktreePath: task.worktreePath, baseCommitHash: task.baseCommitHash,
    headCommitHash: head.ok ? head.stdout.trim() : null, clean, commitCount,
    ready: task.status === "active" && clean && commitCount > 0
  };
}

function integrationSummary(record: IntegrationRecord): JsonValue {
  return {
    integrationKey: record.key, status: record.status, branchName: record.branchName, worktreePath: record.worktreePath,
    baseCommitHash: record.baseCommitHash, headCommitHash: record.expectedHead, order: [...record.order], merged: [...record.merged],
    conflict: record.status === "conflict" ? { taskKey: record.currentTask ?? null, paths: [...record.conflictPaths] } : null
  };
}

export const gitPrepare: HighLevelHandler = async (args, ctx, identity) => {
  const log = new StepLog();
  const runId = args.positionals["run-id"]!;
  return guarded("git.prepare", log, { runId }, async () => {
    const repository = await requireRepository(ctx.cwd);
    const requested = args.lists.get("--task");
    const prepared = await log.check("resolve-tasks", async () => {
      const reports = (await listJournalReports(repository.root, "task.implement")).filter(r => r.runId === runId);
      const byTask = new Map<string, string>();
      for (const report of reports) {
        const key = (report.data as { taskKey?: unknown }).taskKey;
        if (typeof key === "string" && report.taskId !== undefined) byTask.set(report.taskId, key);
      }
      const ids = requested ?? [...byTask.keys()].sort();
      const missing = ids.filter(id => !byTask.has(id));
      if (ids.length === 0 || missing.length > 0)
        throw new HighLevelError(notFoundError(ids.length === 0 ? `Run '${runId}' has no prepared tasks; run 'bflow task implement' first`
          : `Run '${runId}' has no prepared task(s): ${missing.join(", ")}`, { reason: "task_not_found", missing }));
      return ids.map(id => ({ taskId: id, taskKey: byTask.get(id)! }));
    }, value => value.map(v => v.taskId));

    const workflowPath = args.strings.get("--workflow");
    const dependencies = await log.check("resolve-dependencies", async () => {
      if (workflowPath === undefined) return new Map<string, string[]>();
      const workflow = await readWorkflowFile(resolveInput(ctx, workflowPath));
      const keyOf = new Map(prepared.map(p => [p.taskId, p.taskKey]));
      const out = new Map<string, string[]>();
      for (const item of prepared)
        out.set(item.taskKey, workflow.dependencies.filter(d => d.taskId === item.taskId && keyOf.has(d.dependsOnTaskId))
          .map(d => keyOf.get(d.dependsOnTaskId)!));
      return out;
    }, value => Object.fromEntries([...value.entries()].map(([k, v]) => [k, v])));

    let resources: HighLevelResources | undefined;
    try {
      await assertStateIgnored(repository.root);
      resources = await log.check("open-resources", () => ctx.services.openResources(repository.root, {
        artifactRoot: args.strings.get("--artifact-root"), storeId: args.strings.get("--artifact-store-id") }));
      const inspections = await log.check("inspect-worktrees", async () => {
        const out = [];
        for (const item of prepared) out.push(await inspectTask(await resources!.git.getTask(item.taskKey)));
        return out;
      }, value => value);
      const notReady = inspections.filter(i => !i.ready);
      if (notReady.length > 0)
        throw new HighLevelError(validationError(`Task worktree(s) not ready for integration: ${notReady.map(i =>
          `${i.taskId} (${i.status !== "active" ? i.status : !i.clean ? "uncommitted changes" : "no commits"})`).join(", ")}`,
          { reason: "worktree_not_ready", tasks: notReady.map(i => i.taskId) }), HIGH_LEVEL_EXIT_CODES.NOT_READY);

      const integrationId = args.strings.get("--integration-id") ?? "integration-1";
      const base = args.strings.get("--base") ?? "HEAD";
      const integrationRequest = {
        runId, integrationId, baseRevision: base,
        tasks: prepared.map(p => ({ taskKey: p.taskKey, dependsOn: dependencies.get(p.taskKey) ?? [] }))
      };
      const preview: JsonValue = { ...integrationRequest, tasks: integrationRequest.tasks, mergesInto: "dedicated integration/bflow/... branch only" };

      if (!args.booleans.has("--yes"))
        return {
          command: "git.prepare", outcome: "approval_required", status: "waiting_user",
          exitCode: HIGH_LEVEL_EXIT_CODES.PERMISSION_REQUIRED, runId,
          steps: [...log.steps, { id: "begin-integration", status: "blocked",
            message: "Collecting submissions and merging needs --yes, after every Developer released write access" }],
          data: { preview, tasks: inspections }
        };

      const key = args.idempotencyKey ?? `git.prepare:${runId}:${integrationId}`;
      return await runJournaled({ command: "git.prepare", repositoryRoot: repository.root, key,
        request: JSON.parse(JSON.stringify(integrationRequest)) as JsonValue, retrySafe: false,
        resume: args.booleans.has("--resume"), identity, clock: ctx.clock }, async (journalLog): Promise<CommandReport> => {
        journalLog.steps.unshift(...log.steps);
        for (const item of prepared)
          await journalLog.sideEffect(`collect-submission:${item.taskId}`, async () => {
            const task = await resources!.git.getTask(item.taskKey);
            // An identical prior submission is retained by the engine; do not resubmit it.
            return task.changeSet ?? resources!.git.collectTask(item.taskKey);
          }, change => ({ changeSetId: change.changeSetId, headCommitHash: change.headCommitHash, files: change.filesChanged.length }));
        const record = await journalLog.sideEffect("begin-integration", () => resources!.git.beginIntegration(integrationRequest),
          value => ({ status: value.status, branchName: value.branchName }));
        const verificationRequests = record.requests.filter(m => m.type === "verification.requested");
        const conflict = record.status === "conflict";
        journalLog.add({ id: "request-workflow-verification", status: conflict ? "blocked" : "succeeded",
          message: conflict ? "Blocked until the merge conflict is resolved and acknowledged" :
            "Workflow-level verification requested from Runtime; integration is not verified yet",
          data: { requests: verificationRequests.map(m => m.message_id) } });
        const data: JsonValue = {
          integration: integrationSummary(record),
          workflowVerification: conflict ? null : {
            required: true,
            requestIds: verificationRequests.map(m => m.message_id),
            integration: { headCommitHash: record.expectedHead,
              integratedTaskIds: record.order.map(k => record.snapshots[k]?.taskId ?? k) }
          },
          pendingMessages: JSON.parse(JSON.stringify(record.requests)) as JsonValue,
          protectedBranches: "No merge to main/protected branches and no push are performed; publication needs separate human approval"
        };
        return {
          command: "git.prepare", outcome: conflict ? "conflict_detected" : "integration_prepared", status: "succeeded",
          exitCode: conflict ? HIGH_LEVEL_EXIT_CODES.NOT_READY : HIGH_LEVEL_EXIT_CODES.SUCCESS,
          steps: journalLog.steps, runId, idempotencyKey: key, data
        };
      }, (error, journalLog) => errorReport("git.prepare", error, { runId, idempotencyKey: key, steps: journalLog.steps }));
    } finally {
      await resources?.close();
    }
  });
};
