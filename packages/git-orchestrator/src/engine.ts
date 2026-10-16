import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ArtifactReferenceSchema, ArtifactWriteOptionsSchema, GitChangeSetSchema, RoleMessageSchema,
  VerificationResultSchema, type ArtifactReference, type ArtifactStore, type GitChangeSet, type RoleMessage
} from "@bflow/contracts";
import { assertClean, changedFiles, git, inspectRepository, patch, resolveCommit, succeeds } from "./git.js";
import { readState, withRepositoryLock, writeState } from "./journal.js";
import {
  CommitHashSchema, GitOrchestrationError, IntegrationRequestSchema, TaskRequestSchema, requireCondition,
  type IntegrationRecord, type IntegrationRequest, type State, type TaskRecord, type TaskRequest
} from "./model.js";
import { PullRequestRequestSchema, PullRequestSchema, type GitProvider, type PullRequestRequest } from "./provider.js";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const identity = (...values: string[]) => digest(JSON.stringify(values));
const segment = (value: string) => `${value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "id"}-${digest(value).slice(0, 16)}`;
export function taskBranchName(input: TaskRequest): string {
  const request = TaskRequestSchema.parse(input);
  return `agent/bflow/${segment(request.runId)}/${segment(request.taskId)}/${segment(request.attemptId)}`;
}
function orderedTasks(tasks: z.output<typeof IntegrationRequestSchema>["tasks"]): string[] {
  const nodes = new Map(tasks.map(task => [task.taskKey, task]));
  requireCondition(nodes.size === tasks.length, "duplicate_task", "Integration task keys must be unique");
  const order: string[] = [], visiting = new Set<string>(), visited = new Set<string>();
  function visit(key: string): void {
    requireCondition(!visiting.has(key), "dependency_cycle", `Dependency cycle at ${key}`);
    if (visited.has(key)) return;
    const task = nodes.get(key);
    requireCondition(task, "missing_dependency", `Missing integration dependency ${key}`);
    visiting.add(key);
    for (const dependency of task.dependsOn) visit(dependency);
    visiting.delete(key); visited.add(key); order.push(key);
  }
  tasks.forEach(task => visit(task.taskKey));
  return order;
}
const under = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");
function scopeCheck(task: TaskRecord, paths: readonly string[]): void {
  for (const path of paths) {
    requireCondition(task.request.ownedPaths.some(prefix => under(path, prefix)), "outside_ownership", `Task ${task.request.taskId} does not own ${path}`);
    requireCondition(!task.request.forbiddenPaths.some(prefix => under(path, prefix)), "forbidden_path", `Forbidden task path: ${path}`);
    requireCondition(!path.split("/").some(part => ["node_modules", "dist", "coverage", ".git", ".bflow", ".env"].includes(part)) &&
      !/(^|\/)\.env\.|\.(?:pem|key|sqlite|sqlite3|db|tsbuildinfo)$/.test(path), "unexpected_file", `Generated or sensitive file: ${path}`);
  }
}

/** Git mechanics only: Runtime consumes durable RoleMessage requests and applies all business gates. */
export class GitIntegrationEngine {
  private constructor(
    readonly repositoryPath: string,
    readonly stateDirectory: string,
    private readonly artifactStore: ArtifactStore,
    private readonly provider: GitProvider | undefined
  ) {}

  static async open(options: { repositoryPath: string; artifactStore: ArtifactStore; provider?: GitProvider }): Promise<GitIntegrationEngine> {
    z.string().min(1).parse(options.repositoryPath);
    const repository = await inspectRepository(options.repositoryPath);
    const engine = new GitIntegrationEngine(repository.root, join(repository.commonDir, "bflow-git"), options.artifactStore, options.provider);
    await engine.transaction(async () => undefined);
    return engine;
  }

  private taskPath(key: string): string { return join(this.stateDirectory, "trees", `task-${key}`); }
  private integrationPath(key: string): string { return join(this.stateDirectory, "trees", `integration-${key}`); }
  private async transaction<T>(action: (state: State) => Promise<T>): Promise<T> {
    return withRepositoryLock(this.stateDirectory, async () => {
      // Common Git dir, rather than the caller's linked worktree, is the repository identity.
      const common = (await inspectRepository(this.repositoryPath)).commonDir;
      const state = await readState(this.stateDirectory, common);
      for (const [key, task] of Object.entries(state.tasks)) {
        requireCondition(key === identity(task.request.runId, task.request.taskId, task.request.attemptId) && key === task.key && task.worktreePath === this.taskPath(key) && task.branchName === taskBranchName(task.request), "invalid_journal", "Task binding does not match journal identity");
      }
      for (const [key, integration] of Object.entries(state.integrations)) {
        requireCondition(key === identity(integration.request.runId, integration.request.integrationId) && key === integration.key && integration.worktreePath === this.integrationPath(key) &&
          integration.branchName === this.integrationBranch(integration.request), "invalid_journal", "Integration binding does not match journal identity");
      }
      return action(state);
    });
  }
  private save(state: State): Promise<void> { return writeState(this.stateDirectory, state); }
  private task(state: State, key: string): TaskRecord {
    z.string().min(1).parse(key);
    const task = Object.hasOwn(state.tasks, key) ? state.tasks[key] : undefined; requireCondition(task, "unknown_task", `Unknown task ${key}`); return task;
  }
  private integration(state: State, key: string): IntegrationRecord {
    z.string().min(1).parse(key);
    const record = Object.hasOwn(state.integrations, key) ? state.integrations[key] : undefined; requireCondition(record, "unknown_integration", `Unknown integration ${key}`); return record;
  }
  private integrationBranch(request: IntegrationRequest): string {
    return `integration/bflow/${segment(request.runId)}/${segment(request.integrationId)}`;
  }
  inspect(): ReturnType<typeof inspectRepository> { return inspectRepository(this.repositoryPath); }
  getTask(key: string): Promise<TaskRecord> { return this.transaction(async state => structuredClone(this.task(state, key))); }
  getIntegration(key: string): Promise<IntegrationRecord> { return this.transaction(async state => structuredClone(this.integration(state, key))); }

  private async branchExists(branch: string): Promise<boolean> {
    return succeeds(this.repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  }
  private async worktrees(): Promise<{ path: string; branch?: string; locked: boolean }[]> {
    const output = await git(this.repositoryPath, ["worktree", "list", "--porcelain", "-z"]);
    return output.split("\0\0").filter(Boolean).map(block => {
      const fields = block.split("\0"), path = fields.find(field => field.startsWith("worktree "))?.slice(9);
      requireCondition(path, "invalid_git_output", "Invalid Git worktree listing");
      const branch = fields.find(field => field.startsWith("branch refs/heads/"))?.slice(18);
      const locked = fields.some(field => field === "locked" || field.startsWith("locked "));
      return branch === undefined ? { path, locked } : { path, branch, locked };
    });
  }
  private async provision(record: TaskRecord | IntegrationRecord): Promise<void> {
    const bindings = await this.worktrees();
    const existing = bindings.find(binding => binding.path === record.worktreePath);
    if (existing) {
      requireCondition(existing.branch === record.branchName, "worktree_mismatch", "Managed worktree points to another branch");
      await this.assertBinding(record);
      requireCondition(await resolveCommit(record.worktreePath, "HEAD") === record.baseCommitHash, "creation_changed", "Worktree changed before creation was acknowledged");
      await assertClean(record.worktreePath);
      if (!existing.locked) await git(this.repositoryPath, ["worktree", "lock", "--reason", "Bflow managed worktree", record.worktreePath]);
      return;
    }
    requireCondition(!bindings.some(binding => binding.branch === record.branchName), "branch_in_use", "Branch already belongs to another worktree");
    await mkdir(join(this.stateDirectory, "trees"), { recursive: true });
    if (await this.branchExists(record.branchName)) {
      requireCondition(await resolveCommit(this.repositoryPath, record.branchName) === record.baseCommitHash, "branch_collision", "Pending creation branch changed; manual reconciliation required");
      await git(this.repositoryPath, ["worktree", "add", record.worktreePath, record.branchName]);
    } else {
      await git(this.repositoryPath, ["worktree", "add", "-b", record.branchName, record.worktreePath, record.baseCommitHash]);
    }
    // Protect an in-use worktree from automatic Git pruning. Unlock only during explicit safe cleanup.
    await git(this.repositoryPath, ["worktree", "lock", "--reason", "Bflow managed worktree", record.worktreePath]);
  }
  private async assertBinding(record: TaskRecord | IntegrationRecord): Promise<void> {
    const info = await inspectRepository(record.worktreePath);
    const common = (await inspectRepository(this.repositoryPath)).commonDir;
    requireCondition(info.commonDir === common && info.root === record.worktreePath && info.branch === record.branchName &&
      await realpath(record.worktreePath) === record.worktreePath, "worktree_mismatch", "Task worktree/branch/repository binding changed");
  }

  async prepareTask(input: TaskRequest): Promise<TaskRecord> {
    const request = TaskRequestSchema.parse(input);
    return this.transaction(async state => {
      const key = identity(request.runId, request.taskId, request.attemptId);
      let task = state.tasks[key];
      if (task) {
        requireCondition(JSON.stringify(task.request) === JSON.stringify(request), "idempotency_conflict", "Task identity reused with different inputs");
        requireCondition(task.status === "creating" || task.status === "active", "inactive_task", "Cancelled or cleaned task cannot be reused");
        if (task.status === "active") { await this.assertBinding(task); return structuredClone(task); }
      } else {
        await assertClean(this.repositoryPath);
        const baseCommitHash = await resolveCommit(this.repositoryPath, request.baseRevision);
        const branchName = taskBranchName(request);
        requireCondition(!await this.branchExists(branchName), "branch_collision", `Branch already exists: ${branchName}`);
        task = { key, request, baseCommitHash, branchName, worktreePath: this.taskPath(key), status: "creating" };
        state.tasks[key] = task; await this.save(state);
      }
      await this.provision(task); task.status = "active"; await this.save(state); return structuredClone(task);
    });
  }

  private async validateTaskHead(task: TaskRecord, expected?: string): Promise<{ head: string; files: GitChangeSet["filesChanged"]; patch: string; commits: string[] }> {
    requireCondition(task.status === "active", "inactive_task", "Only active tasks may submit changes");
    await this.assertBinding(task); await assertClean(task.worktreePath);
    const head = await resolveCommit(task.worktreePath, "HEAD");
    requireCondition(!expected || head === expected, "stale_commit", "Task HEAD changed after submission");
    requireCondition(head !== task.baseCommitHash, "missing_commit", "Task has no implementation commit");
    requireCondition(await succeeds(task.worktreePath, ["merge-base", "--is-ancestor", task.baseCommitHash, head]), "unrelated_history", "Task history no longer descends from its recorded base");
    requireCondition((await git(task.worktreePath, ["rev-list", "--min-parents=2", `${task.baseCommitHash}..${head}`])).trim() === "", "task_merge_commit", "Submit linear task history; integrate branches through the engine");
    const commits = (await git(task.worktreePath, ["rev-list", "--reverse", `${task.baseCommitHash}..${head}`])).trim().split("\n");
    let previous = task.baseCommitHash;
    for (const commit of commits) {
      scopeCheck(task, (await changedFiles(task.worktreePath, previous, commit)).map(file => file.path));
      previous = commit;
    }
    const files = await changedFiles(task.worktreePath, task.baseCommitHash, head);
    requireCondition(files.length, "missing_changes", "Task has no net changes");
    scopeCheck(task, files.map(file => file.path));
    return { head, files, patch: await patch(task.worktreePath, task.baseCommitHash, head), commits };
  }

  collectTask(key: string): Promise<GitChangeSet> {
    return this.transaction(async state => {
      const task = this.task(state, key), change = await this.validateTaskHead(task);
      const bytes = Buffer.from(change.patch), hash = digest(bytes);
      const artifactId = `patch-${identity(key, change.head, hash)}`;
      const options = ArtifactWriteOptionsSchema.parse({ artifactId, runId: task.request.runId, taskId: task.request.taskId,
        kind: "patch", mediaType: "text/x-diff", expectedIntegrity: { checksum: { algorithm: "sha256", value: hash }, sizeBytes: bytes.length },
        idempotencyKey: artifactId });
      const stored = await this.artifactStore.put({ options, content: (async function* () { yield bytes; })() });
      requireCondition(stored.ok, "artifact_write_failed", "ArtifactStore could not persist the required patch");
      const reference = ArtifactReferenceSchema.parse(stored.value);
      requireCondition(reference.artifactId === artifactId && reference.runId === task.request.runId && reference.taskId === task.request.taskId &&
        reference.kind === "patch" && reference.checksum.algorithm === "sha256" && reference.checksum.value === hash &&
        (reference.sizeBytes === undefined || reference.sizeBytes === bytes.length), "artifact_mismatch", "ArtifactStore returned a mismatched patch reference");
      await this.validateTaskHead(task, change.head);
      const changeSet = GitChangeSetSchema.parse({ schemaVersion: 2, changeSetId: `change-${identity(key, change.head)}`,
        runId: task.request.runId, taskId: task.request.taskId, attemptId: task.request.attemptId,
        worktreePath: task.worktreePath, branchName: task.branchName, baseCommitHash: task.baseCommitHash, headCommitHash: change.head,
        dirtyWorkingTree: false, filesChanged: change.files, patchArtifact: reference, createdAt: new Date().toISOString(),
        metadata: { commits: change.commits, summary: `${change.commits.length} commits; ${change.files.length} files changed` } });
      task.changeSet = changeSet; task.headCommitHash = change.head; await this.save(state); return changeSet;
    });
  }

  private async checkStoredArtifact(input: ArtifactReference): Promise<void> {
    const reference = ArtifactReferenceSchema.parse(input);
    const resolved = await this.artifactStore.resolve(reference.artifactId);
    requireCondition(resolved.ok && resolved.value && JSON.stringify(ArtifactReferenceSchema.parse(resolved.value)) === JSON.stringify(reference),
      "missing_artifact", "Required artifact must resolve through ArtifactStore");
    const hash = createHash(reference.checksum.algorithm); let size = 0;
    for await (const chunk of this.artifactStore.get(reference)) {
      requireCondition(chunk.ok, "artifact_read_failed", "Cannot read required evidence artifact");
      hash.update(chunk.value); size += chunk.value.length;
    }
    requireCondition(hash.digest("hex") === reference.checksum.value && (reference.sizeBytes === undefined || reference.sizeBytes === size),
      "artifact_mismatch", "Required evidence artifact failed checksum or size validation");
  }

  private async validateSubmission(task: TaskRecord, snapshot: GitChangeSet): Promise<void> {
    const changeSet = GitChangeSetSchema.parse(snapshot);
    requireCondition(changeSet.runId === task.request.runId && changeSet.taskId === task.request.taskId && changeSet.attemptId === task.request.attemptId &&
      changeSet.worktreePath === task.worktreePath && changeSet.branchName === task.branchName && changeSet.baseCommitHash === task.baseCommitHash &&
      !changeSet.dirtyWorkingTree, "submission_mismatch", "ChangeSet does not match the assigned task");
    const change = await this.validateTaskHead(task, changeSet.headCommitHash);
    requireCondition(JSON.stringify(change.files) === JSON.stringify(changeSet.filesChanged), "submission_mismatch", "Changed-file evidence differs from Git");
    const resolved = await this.artifactStore.resolve(changeSet.patchArtifact.artifactId);
    requireCondition(resolved.ok && resolved.value, "missing_artifact", "Required patch artifact is unavailable");
    const reference = ArtifactReferenceSchema.parse(resolved.value);
    requireCondition(JSON.stringify(reference) === JSON.stringify(changeSet.patchArtifact), "artifact_mismatch", "Patch reference changed");
    const hash = createHash(reference.checksum.algorithm); let size = 0;
    for await (const chunk of this.artifactStore.get(reference)) {
      requireCondition(chunk.ok, "artifact_read_failed", "Cannot read required patch artifact");
      hash.update(chunk.value); size += chunk.value.length;
    }
    requireCondition(hash.digest("hex") === reference.checksum.value && digest(Buffer.from(change.patch)) === reference.checksum.value &&
      (reference.sizeBytes === undefined || reference.sizeBytes === size), "artifact_mismatch", "Patch content does not match Git and its trusted checksum");
  }

  async beginIntegration(input: IntegrationRequest): Promise<IntegrationRecord> {
    const request = IntegrationRequestSchema.parse(input);
    return this.transaction(async state => {
      const key = identity(request.runId, request.integrationId);
      const existing = state.integrations[key];
      if (existing) {
        requireCondition(JSON.stringify(existing.request) === JSON.stringify(request), "idempotency_conflict", "Integration identity reused with another plan");
        return structuredClone(await this.resume(state, existing));
      }
      await assertClean(this.repositoryPath);
      const order = orderedTasks(request.tasks), snapshots: Record<string, GitChangeSet> = {};
      for (const taskKey of order) {
        const task = this.task(state, taskKey);
        requireCondition(task.request.runId === request.runId && task.changeSet, "missing_submission", "Each task needs a commit and stored patch artifact for this run");
        await this.validateSubmission(task, task.changeSet); snapshots[taskKey] = structuredClone(task.changeSet);
      }
      const baseCommitHash = await resolveCommit(this.repositoryPath, request.baseRevision), branchName = this.integrationBranch(request);
      requireCondition(!await this.branchExists(branchName), "branch_collision", "Integration branch already exists");
      const record: IntegrationRecord = { key, request, branchName, baseCommitHash, expectedHead: baseCommitHash,
        worktreePath: this.integrationPath(key), order, snapshots, merged: [], status: "creating", conflictPaths: [], requests: [] };
      state.integrations[key] = record; await this.save(state);
      return structuredClone(await this.resume(state, record));
    });
  }
  resumeIntegration(key: string): Promise<IntegrationRecord> {
    return this.transaction(async state => structuredClone(await this.resume(state, this.integration(state, key))));
  }
  private message(record: IntegrationRecord, type: "verification.requested" | "task.status", taskKey?: string, developerId?: string): RoleMessage {
    const snapshot = taskKey ? record.snapshots[taskKey] : undefined;
    const id = `git-${identity(record.key, type, taskKey ?? record.expectedHead, record.expectedHead)}`;
    return RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: record.request.runId,
      run_id: record.request.runId, sender: { role: "runtime" }, recipient: { role: "coordinator" }, type,
      payload: snapshot ? { reason: "merge_conflict", integrationId: record.request.integrationId,
        taskKey, taskId: snapshot.taskId, developerId: developerId ?? "coordinator_selects_developer", conflictPaths: record.conflictPaths,
        worktreePath: record.worktreePath, branchName: record.branchName, beforeMerge: record.beforeMerge,
        incomingCommitHash: snapshot.headCommitHash } : {
        verificationScope: "workflow", integrationId: record.request.integrationId, integrationCommitHash: record.expectedHead,
        integratedTaskIds: record.order.map(key => record.snapshots[key]!.taskId),
        worktreePath: record.worktreePath, branchName: record.branchName, taskKeys: record.order },
      artifact_references: Object.values(record.snapshots).map(change => change.patchArtifact),
      occurred_at: new Date().toISOString(), idempotency_key: id });
  }
  private enqueue(record: IntegrationRecord, message: RoleMessage): void {
    if (!record.requests.some(request => request.message_id === message.message_id)) record.requests.push(message);
  }
  private async mergeHead(path: string): Promise<string | undefined> {
    if (!await succeeds(path, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])) return undefined;
    return resolveCommit(path, "MERGE_HEAD");
  }
  private async finishMerge(state: State, record: IntegrationRecord, taskKey: string): Promise<void> {
    await assertClean(record.worktreePath);
    const head = await resolveCommit(record.worktreePath, "HEAD"), snapshot = record.snapshots[taskKey];
    requireCondition(snapshot && record.beforeMerge, "invalid_journal", "Missing merge recovery data");
    const parents = (await git(record.worktreePath, ["show", "-s", "--format=%P", head])).trim().split(" ");
    // A no-op merge may already be contained in the previous integration tip.
    requireCondition(head === record.beforeMerge || (parents.length === 2 && parents[0] === record.beforeMerge && parents[1] === snapshot.headCommitHash),
      "unexpected_merge", "Integration HEAD does not match the recorded merge parents");
    requireCondition(await succeeds(record.worktreePath, ["merge-base", "--is-ancestor", snapshot.headCommitHash, head]), "missing_merge", "Task commit is not included in integration history");
    scopeCheck(this.task(state, taskKey), (await changedFiles(record.worktreePath, record.beforeMerge, head)).map(file => file.path));
    record.expectedHead = head; if (!record.merged.includes(taskKey)) record.merged.push(taskKey);
    delete record.currentTask; delete record.beforeMerge; record.conflictPaths = []; record.status = "ready"; await this.save(state);
  }

  private async resume(state: State, record: IntegrationRecord): Promise<IntegrationRecord> {
    requireCondition(record.status !== "cancelled" && record.status !== "cleaned", "inactive_integration", "Integration is cancelled or cleaned");
    if (record.status === "creating") { await this.provision(record); record.status = "ready"; await this.save(state); }
    await this.assertBinding(record);
    if (record.status === "conflict") return record; // Explicit human/agent resolution acknowledgement required.
    if (record.status === "awaiting_verification" || record.status === "verified") {
      await assertClean(record.worktreePath);
      requireCondition(await resolveCommit(record.worktreePath, "HEAD") === record.expectedHead, "integration_drift", "Integration changed after verification request");
      return record;
    }
    for (const taskKey of record.order) {
      if (record.merged.includes(taskKey)) continue;
      const task = this.task(state, taskKey), snapshot = record.snapshots[taskKey];
      requireCondition(snapshot, "invalid_journal", "Missing pinned task snapshot");
      await this.validateSubmission(task, snapshot);
      if (record.status === "merging") {
        requireCondition(record.currentTask === taskKey && record.beforeMerge === record.expectedHead, "invalid_journal", "Pending merge intent does not match task order");
        const merging = await this.mergeHead(record.worktreePath);
        if (merging) {
          requireCondition(merging === snapshot.headCommitHash, "unexpected_merge", "Unexpected MERGE_HEAD; manual reconciliation required");
          const conflicts = (await git(record.worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
          record.conflictPaths = conflicts.length > 0 || record.conflictPaths.length === 0 ? conflicts : record.conflictPaths;
          // Also require explicit acknowledgement after crash with a resolved but uncommitted merge.
          record.status = "conflict"; this.enqueue(record, this.message(record, "task.status", taskKey, task.request.developerId)); await this.save(state); return record;
        }
        const current = await resolveCommit(record.worktreePath, "HEAD");
        if (current !== record.beforeMerge || await succeeds(record.worktreePath, ["merge-base", "--is-ancestor", snapshot.headCommitHash, current])) {
          await this.finishMerge(state, record, taskKey); continue;
        }
        await assertClean(record.worktreePath); // Clean unchanged HEAD proves merge was not applied; retry pinned commit.
      } else {
        await assertClean(record.worktreePath);
        requireCondition(await resolveCommit(record.worktreePath, "HEAD") === record.expectedHead, "integration_drift", "Integration branch changed outside the engine");
        requireCondition(await succeeds(record.worktreePath, ["merge-base", "--is-ancestor", snapshot.baseCommitHash, record.expectedHead]), "missing_dependency", "Task base is not yet in integration history");
        record.currentTask = taskKey; record.beforeMerge = record.expectedHead; record.status = "merging"; await this.save(state);
      }
      try {
        await git(record.worktreePath, ["merge", "--no-ff", "--no-edit", "--no-stat", "--", snapshot.headCommitHash]);
      } catch (error) {
        if (!await this.mergeHead(record.worktreePath)) throw error;
        record.conflictPaths = (await git(record.worktreePath, ["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
        record.status = "conflict"; this.enqueue(record, this.message(record, "task.status", taskKey, task.request.developerId)); await this.save(state); return record;
      }
      await this.finishMerge(state, record, taskKey);
    }
    record.status = "awaiting_verification";
    this.enqueue(record, this.message(record, "verification.requested")); await this.save(state); return record;
  }

  async acceptConflictResolution(key: string, input: { taskKey: string; resolutionCommitHash: string }): Promise<IntegrationRecord> {
    const resolution = z.object({ taskKey: z.string().min(1), resolutionCommitHash: CommitHashSchema }).strict().parse(input);
    return this.transaction(async state => {
      const record = this.integration(state, key);
      requireCondition(record.status === "conflict" && record.currentTask === resolution.taskKey, "no_conflict", "No matching conflict awaiting resolution");
      await this.assertBinding(record); await assertClean(record.worktreePath);
      requireCondition(await resolveCommit(record.worktreePath, "HEAD") === resolution.resolutionCommitHash, "stale_commit", "Resolution commit must match integration HEAD");
      const task = this.task(state, resolution.taskKey);
      requireCondition(record.beforeMerge, "invalid_journal", "Missing pre-merge tip");
      scopeCheck(task, (await changedFiles(record.worktreePath, record.beforeMerge, resolution.resolutionCommitHash)).map(file => file.path));
      await this.finishMerge(state, record, resolution.taskKey);
      return structuredClone(await this.resume(state, record));
    });
  }

  async recordVerification(key: string, input: unknown): Promise<IntegrationRecord> {
    const result = VerificationResultSchema.parse(input);
    return this.transaction(async state => {
      const record = this.integration(state, key);
      requireCondition(record.status === "awaiting_verification", "verification_not_pending", "Integration is not awaiting workflow verification");
      await this.assertBinding(record); await assertClean(record.worktreePath);
      requireCondition(await resolveCommit(record.worktreePath, "HEAD") === record.expectedHead && result.verificationScope === "workflow" &&
        result.runId === record.request.runId && result.metadata?.integrationCommitHash === record.expectedHead,
      "stale_verification", "Verification must identify this run, workflow scope and exact integrationCommitHash");
      requireCondition(result.evidenceArtifacts.length > 0, "missing_artifact", "Verification evidence is required");
      for (const reference of [...result.evidenceArtifacts, ...Object.values(record.snapshots).map(snapshot => snapshot.patchArtifact)]) {
        await this.checkStoredArtifact(reference);
      }
      await assertClean(record.worktreePath);
      requireCondition(await resolveCommit(record.worktreePath, "HEAD") === record.expectedHead, "integration_drift", "Integration changed while validating evidence");
      record.verification = result;
      if (result.status === "passed") record.status = "verified";
      await this.save(state); return structuredClone(record);
    });
  }

  cancelTask(key: string): Promise<TaskRecord> {
    return this.transaction(async state => {
      const task = this.task(state, key);
      requireCondition(task.status !== "cleaned", "inactive_task", "Task already cleaned");
      requireCondition(!Object.values(state.integrations).some(record => record.order.includes(key) && !["cancelled", "cleaned"].includes(record.status)), "task_in_use", "Task is pinned by an integration");
      task.status = "cancelled"; await this.save(state); return structuredClone(task);
    });
  }
  cancelIntegration(key: string): Promise<IntegrationRecord> {
    return this.transaction(async state => {
      const record = this.integration(state, key);
      requireCondition(record.status !== "cleaned", "inactive_integration", "Integration already cleaned");
      // Preserve a pending merge and all conflict edits for explicit reconciliation. No reset/abort/clean.
      record.status = "cancelled"; await this.save(state); return structuredClone(record);
    });
  }
  private async cleanup(record: TaskRecord | IntegrationRecord): Promise<void> {
    const registered = (await this.worktrees()).find(binding => binding.path === record.worktreePath);
    if (!registered) {
      try { await lstat(record.worktreePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      throw new GitOrchestrationError("unregistered_worktree", "Unregistered directory exists; refusing removal");
    }
    await this.assertBinding(record); await assertClean(record.worktreePath);
    requireCondition((await git(record.worktreePath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).length === 0,
      "ignored_files", "Cleanup would delete ignored files; preserve or remove them explicitly first");
    if (registered.locked) await git(this.repositoryPath, ["worktree", "unlock", record.worktreePath]);
    await git(this.repositoryPath, ["worktree", "remove", record.worktreePath]);
  }
  cleanupTask(key: string): Promise<TaskRecord> {
    return this.transaction(async state => {
      const task = this.task(state, key);
      if (task.status === "cleaned") return structuredClone(task);
      requireCondition(task.status === "cancelled" || (task.changeSet && Object.values(state.integrations).some(record =>
        ["verified", "cleaned"].includes(record.status) && record.verification?.status === "passed" && record.snapshots[key]?.headCommitHash === task.changeSet?.headCommitHash)),
      "task_in_use", "Release task by cancellation or verified integration before cleanup");
      requireCondition(!Object.values(state.integrations).some(record => record.order.includes(key) && !["verified", "cancelled", "cleaned"].includes(record.status)), "task_in_use", "Task has a pending integration");
      await this.cleanup(task); task.status = "cleaned"; await this.save(state); return structuredClone(task);
    });
  }
  cleanupIntegration(key: string): Promise<IntegrationRecord> {
    return this.transaction(async state => {
      const record = this.integration(state, key);
      if (record.status === "cleaned") return structuredClone(record);
      requireCondition(record.status === "cancelled" || record.status === "verified", "integration_in_use", "Integration must be cancelled or verified before cleanup");
      await this.cleanup(record); record.status = "cleaned"; await this.save(state); return structuredClone(record);
    });
  }

  async requestPullRequest(key: string, input: PullRequestRequest): Promise<{ url: string }> {
    const request = PullRequestRequestSchema.parse(input);
    return this.transaction(async state => {
      const record = this.integration(state, key);
      requireCondition(this.provider, "provider_unavailable", "Configure a Git provider before requesting a pull request");
      requireCondition(record.status === "verified", "verification_required", "Workflow verification must pass before PR publication");
      await this.assertBinding(record); await assertClean(record.worktreePath);
      requireCondition(await resolveCommit(record.worktreePath, "HEAD") === record.expectedHead, "integration_drift", "Verified integration HEAD changed");
      requireCondition(record.verification?.status === "passed", "verification_required", "A passed workflow verification receipt is required");
      for (const reference of [...record.verification.evidenceArtifacts, ...Object.values(record.snapshots).map(snapshot => snapshot.patchArtifact)]) {
        await this.checkStoredArtifact(reference);
      }
      await git(this.repositoryPath, ["check-ref-format", "--branch", request.baseBranch]);
      const remoteUrls = (await git(this.repositoryPath, ["remote", "get-url", "--push", "--all", request.remote])).trim().split("\n");
      requireCondition(remoteUrls.length === 1, "ambiguous_remote", "Configure exactly one push URL for the selected remote");
      const remoteUrl = remoteUrls[0];
      requireCondition(remoteUrl, "remote_unavailable", "Remote is not configured");
      const providerRequest = { ...request, remoteUrl, headBranch: record.branchName, headCommitHash: record.expectedHead,
        idempotencyKey: `pr-${identity(record.key, record.expectedHead, request.remote, request.baseBranch)}` };
      const requestKey = digest(JSON.stringify(providerRequest));
      requireCondition(!record.pullRequest || record.pullRequest.requestKey === requestKey, "idempotency_conflict", "PR identity reused with changed remote, base or content");
      requireCondition(z.boolean().parse(await this.provider.checkAccess(providerRequest)), "provider_access_denied", "Provider access does not permit pull request publication");
      requireCondition((await git(this.repositoryPath, ["ls-remote", "--exit-code", "--", remoteUrl, `refs/heads/${request.baseBranch}`])).trim(),
        "remote_base_missing", "Pull request base branch is missing from remote");
      const found = PullRequestSchema.nullable().parse(await this.provider.find(providerRequest));
      if (found) { const pr = PullRequestSchema.parse(found); record.pullRequest = { state: "created", requestKey, ...pr }; await this.save(state); return pr; }
      if (record.pullRequest?.state === "created" && record.pullRequest.url) return { url: record.pullRequest.url };
      record.pullRequest = { state: "pending", requestKey }; await this.save(state);
      // Explicit PR request authorizes publication of this integration branch only. Never force or merge main.
      await git(this.repositoryPath, ["push", "--no-follow-tags", "--recurse-submodules=no", "--", remoteUrl, `${record.expectedHead}:refs/heads/${record.branchName}`]);
      const pr = PullRequestSchema.parse(await this.provider.create(providerRequest));
      record.pullRequest = { state: "created", requestKey, ...pr }; await this.save(state); return pr;
    });
  }
}
