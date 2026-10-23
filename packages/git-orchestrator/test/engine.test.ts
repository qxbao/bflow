import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitChangeSetSchema, RoleMessageSchema, VerificationResultSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "./test-artifact-store.js";
import { GitIntegrationEngine, taskBranchName, type GitProvider } from "../src/index.js";

const execute = promisify(execFile);
async function git(directory: string, ...args: string[]) {
  return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd: directory, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  })).stdout.trim();
}

// The production repository journal uses Linux flock for cross-process exclusion.
describe.skipIf(process.platform !== "linux")("GitIntegrationEngine using real isolated repositories", () => {
  let temporary: string;
  let repository: string;
  let base: string;
  let store: FilesystemArtifactStore;
  let engine: GitIntegrationEngine;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "bflow-p18-"));
    repository = join(temporary, "repository");
    await mkdir(join(repository, "src"), { recursive: true });
    await git(repository, "init", "-b", "main");
    await git(repository, "config", "user.name", "Bflow Test");
    await git(repository, "config", "user.email", "bflow@example.invalid");
    await writeFile(join(repository, "src", "shared.txt"), "original\n");
    await writeFile(join(repository, "README.md"), "initial\n");
    await git(repository, "add", ".");
    await git(repository, "commit", "-m", "initial");
    base = await git(repository, "rev-parse", "HEAD");
    const opened = await openFilesystemArtifactStore({ root: join(temporary, "artifacts"), storeId: "p18-tests" });
    if (!opened.ok) throw new Error(opened.error.message);
    store = opened.value;
    engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    store?.close();
    await rm(temporary, { recursive: true, force: true });
  });
  function request(taskId = "task-a", extra: Record<string, unknown> = {}) {
    return { runId: "run-1", taskId, attemptId: "attempt-1", baseRevision: base, ownedPaths: ["src"], developerId: `developer-${taskId}`, ...extra };
  }
  async function committed(taskId = "task-a", path = `${taskId}.txt`, contents = `${taskId}\n`) {
    const task = await engine.prepareTask(request(taskId));
    await writeFile(join(task.worktreePath, "src", path), contents);
    await git(task.worktreePath, "add", "-A");
    await git(task.worktreePath, "commit", "-m", `Implement ${taskId}`);
    const changes = await engine.collectTask(task.key);
    return { task, changes };
  }
  function integration(tasks: { taskKey: string; dependsOn?: string[] }[], integrationId = "integration-1") {
    return engine.beginIntegration({ runId: "run-1", integrationId, baseRevision: base, tasks });
  }

  async function verifiedIntegration() {
    const { task, changes } = await committed();
    const result = await integration([{ taskKey: task.key }]);
    const verification = VerificationResultSchema.parse({
      schemaVersion: 2, verificationId: "verify-1", runId: "run-1", taskId: "integration", attemptId: "attempt-1", cycleNumber: 1,
      status: "passed", verificationScope: "workflow", independentExecution: true,
      evaluatedCriteria: [{ criterionId: "criterion-1", passed: true, evidenceArtifactId: changes.patchArtifact.artifactId, summary: "Verified" }],
      qualityGateResults: [], evidenceArtifacts: [changes.patchArtifact], findings: [], verifiedBy: "reviewer",
      startedAt: "2026-10-16T00:00:00.000Z", completedAt: "2026-10-16T00:00:01.000Z",
      metadata: { integrationCommitHash: await git(result.worktreePath, "rev-parse", "HEAD") }
    });
    return engine.recordVerification(result.key, verification);
  }
  async function remote() {
    const path = join(temporary, "remote.git");
    await git(temporary, "init", "--bare", path);
    await git(repository, "remote", "add", "origin", path);
    await git(repository, "push", "origin", "main");
    return path;
  }
  const prRequest = { remote: "origin", baseBranch: "main", title: "Implement task", body: "Verified integration" };

  it("creates managed worktrees under an explicit worktreeRoot outside the Git directory", async () => {
    const root = join(repository, ".bflow", "state", "worktrees");
    const placed = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, worktreeRoot: root });
    const task = await placed.prepareTask(request("task-root"));
    expect(task.worktreePath.startsWith(`${root}/`)).toBe(true);
    expect(task.worktreePath).not.toContain("/.git/");
    expect(await git(repository, "status", "--porcelain", "--untracked-files=all")).toBe("");
    await expect(GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, worktreeRoot: "relative" })).rejects.toThrow(/absolute/);
  });

  it("discovers root, branch, HEAD and dirty state from a nested directory", async () => {
    const nested = await GitIntegrationEngine.open({ repositoryPath: join(repository, "src"), artifactStore: store });
    expect(await nested.inspect()).toMatchObject({ root: repository, branch: "main", head: base, dirty: false });
    await writeFile(join(repository, "src", "uncommitted.txt"), "keep me\n");
    expect(await nested.inspect()).toMatchObject({ dirty: true });
  });

  it("isolates two developers and integrates in dependency order without moving main", async () => {
    const a = await committed("task-a");
    const b = await committed("task-b");
    expect(a.task.worktreePath).not.toBe(b.task.worktreePath);
    expect(a.task.branchName).not.toBe(b.task.branchName);
    expect(await readFile(join(a.task.worktreePath, "src", "task-a.txt"), "utf8")).toBe("task-a\n");
    await expect(readFile(join(b.task.worktreePath, "src", "task-a.txt"))).rejects.toThrow();
    const result = await integration([{ taskKey: b.task.key, dependsOn: [a.task.key] }, { taskKey: a.task.key }]);
    expect(result.status).toBe("awaiting_verification");
    expect(result.merged).toEqual([a.task.key, b.task.key]);
    await expect(engine.cleanupTask(a.task.key)).rejects.toThrow(/use|integration|release/i);
    expect(await readFile(join(result.worktreePath, "src", "task-a.txt"), "utf8")).toBe("task-a\n");
    expect(await readFile(join(result.worktreePath, "src", "task-b.txt"), "utf8")).toBe("task-b\n");
    expect(await git(repository, "rev-parse", "main")).toBe(base);
    expect(await git(repository, "status", "--porcelain")).toBe("");
    const verificationRequest = result.requests.find(message => message.type === "verification.requested");
    expect(verificationRequest).toBeDefined();
    expect((verificationRequest?.payload as Record<string, unknown>)?.integratedTaskIds).toEqual(["task-a", "task-b"]);
    for (const message of result.requests) expect(RoleMessageSchema.safeParse(message).success).toBe(true);
  });

  it("collects a validated change set and persists the actual Git patch through ArtifactStore", async () => {
    const { task, changes } = await committed();
    expect(GitChangeSetSchema.safeParse(changes).success).toBe(true);
    expect(changes).toMatchObject({ runId: "run-1", taskId: "task-a", attemptId: "attempt-1", baseCommitHash: base,
      branchName: task.branchName, worktreePath: task.worktreePath, dirtyWorkingTree: false,
      filesChanged: [{ path: "src/task-a.txt", changeType: "added", additions: 1, deletions: 0 }],
      patchArtifact: { trust: "stored", kind: "patch" } });
    expect(await git(task.worktreePath, "rev-parse", "HEAD")).toBe(changes.headCommitHash);
    const chunks = [];
    for await (const chunk of store.get(changes.patchArtifact)) {
      if (!chunk.ok) throw new Error(chunk.error.message);
      chunks.push(chunk.value);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toContain("+task-a");
    const collected = await engine.collectTask(task.key);
    expect(collected.headCommitHash).toBe(changes.headCommitHash);
    expect(collected.patchArtifact.checksum).toEqual(changes.patchArtifact.checksum);
  });

  it("refuses creating a task from a dirty source working tree and preserves its bytes", async () => {
    await writeFile(join(repository, "README.md"), "uncommitted edit\n");
    await expect(engine.prepareTask(request())).rejects.toThrow(/uncommitted|dirty/i);
    expect(await readFile(join(repository, "README.md"), "utf8")).toBe("uncommitted edit\n");
    expect(await git(repository, "rev-parse", "HEAD")).toBe(base);
  });

  it("refuses completion and integration when the task has no commit", async () => {
    const task = await engine.prepareTask(request());
    await expect(engine.collectTask(task.key)).rejects.toThrow(/commit|change/i);
    await expect(integration([{ taskKey: task.key }])).rejects.toThrow(/commit|change/i);
    await writeFile(join(task.worktreePath, "src", "pending.txt"), "not committed\n");
    await expect(engine.collectTask(task.key)).rejects.toThrow(/uncommitted|dirty/i);
    expect(await readFile(join(task.worktreePath, "src", "pending.txt"), "utf8")).toBe("not committed\n");
  });

  it("refuses committed out-of-scope edits without discarding their bytes", async () => {
    const task = await engine.prepareTask(request());
    await writeFile(join(task.worktreePath, "README.md"), "unauthorized\n");
    await git(task.worktreePath, "add", "-A");
    await git(task.worktreePath, "commit", "-m", "bad scope");
    await expect(engine.collectTask(task.key)).rejects.toThrow(/scope|own|forbidden/i);
    expect(await git(task.worktreePath, "diff", "--cached", "--name-only")).toBe("");
    expect(await readFile(join(task.worktreePath, "README.md"), "utf8")).toBe("unauthorized\n");
    expect(await git(task.worktreePath, "rev-parse", "HEAD")).not.toBe(base);
  });

  it("rejects a rename which deletes a file outside the task ownership", async () => {
    const task = await engine.prepareTask(request());
    await rename(join(task.worktreePath, "README.md"), join(task.worktreePath, "src", "renamed.txt"));
    await git(task.worktreePath, "add", "-A");
    await git(task.worktreePath, "commit", "-m", "move unauthorized file");
    await expect(engine.collectTask(task.key)).rejects.toThrow(/scope|own|forbidden/i);
  });

  it("rejects explicitly forbidden paths even inside an owned directory", async () => {
    const task = await engine.prepareTask(request("task-a", { forbiddenPaths: ["src/secret.txt"] }));
    await writeFile(join(task.worktreePath, "src", "secret.txt"), "unexpected\n");
    await git(task.worktreePath, "add", "-A");
    await git(task.worktreePath, "commit", "-m", "forbidden");
    await expect(engine.collectTask(task.key)).rejects.toThrow(/scope|own|forbidden/i);
  });

  it("rejects generated output even under broad ownership", async () => {
    const task = await engine.prepareTask(request());
    await mkdir(join(task.worktreePath, "src", "dist"));
    await writeFile(join(task.worktreePath, "src", "dist", "generated.js"), "generated\n");
    await git(task.worktreePath, "add", "-A");
    await git(task.worktreePath, "commit", "-m", "generated");
    await expect(engine.collectTask(task.key)).rejects.toThrow(/scope|generated|unexpected|forbidden/i);
  });

  it("rejects a pre-existing deterministic task branch without reusing it", async () => {
    const branch = taskBranchName(request());
    await git(repository, "branch", branch, base);
    await expect(engine.prepareTask(request())).rejects.toThrow(/branch|exist|collision/i);
    expect(await git(repository, "rev-parse", branch)).toBe(base);
  });

  it("validates request boundaries before creating any branch or directory", async () => {
    for (const ownedPaths of [["../outside"], ["/absolute"], ["src/**"], ["src/../README.md"]]) {
      await expect(async () => engine.prepareTask(request("task-invalid", { ownedPaths }))).rejects.toThrow();
    }
    expect(await git(repository, "branch", "--format=%(refname:short)")).toBe("main");
  });

  it("is idempotent for an unchanged task request and rejects changed ownership", async () => {
    const task = await engine.prepareTask(request());
    expect(await engine.prepareTask(request())).toMatchObject({ key: task.key, worktreePath: task.worktreePath, branchName: task.branchName });
    await expect(engine.prepareTask(request("task-a", { ownedPaths: ["README.md"] }))).rejects.toThrow();
  });

  it("cancels without discarding uncommitted files and refuses unsafe cleanup", async () => {
    const task = await engine.prepareTask(request());
    await writeFile(join(task.worktreePath, "src", "pending.txt"), "keep cancelled work\n");
    expect((await engine.cancelTask(task.key)).status).toBe("cancelled");
    await expect(engine.collectTask(task.key)).rejects.toThrow(/cancel|active/i);
    await expect(engine.cleanupTask(task.key)).rejects.toThrow(/uncommitted|dirty/i);
    expect(await readFile(join(task.worktreePath, "src", "pending.txt"), "utf8")).toBe("keep cancelled work\n");
  });

  it("removes a clean cancelled worktree while retaining its branch", async () => {
    const task = await engine.prepareTask(request());
    await engine.cancelTask(task.key);
    expect((await engine.cleanupTask(task.key)).status).toBe("cleaned");
    await expect(readFile(join(task.worktreePath, "README.md"))).rejects.toThrow();
    expect(await git(repository, "rev-parse", task.branchName)).toBe(base);
  });

  it("retains conflicting worktree and asks coordinator for explicit conflict repair", async () => {
    const a = await committed("task-a", "shared.txt", "developer A\n");
    const b = await committed("task-b", "shared.txt", "developer B\n");
    const result = await integration([{ taskKey: a.task.key }, { taskKey: b.task.key }]);
    expect(result.status).toBe("conflict");
    expect(result.conflictPaths).toContain("src/shared.txt");
    expect(await readFile(join(result.worktreePath, "src", "shared.txt"), "utf8")).toContain("<<<<<<<");
    expect(result.requests.some(message => message.type === "task.status" && message.recipient.role === "coordinator")).toBe(true);
    for (const message of result.requests) expect(RoleMessageSchema.safeParse(message).success).toBe(true);
    expect(await git(repository, "rev-parse", "main")).toBe(base);
    await expect(engine.cleanupIntegration(result.key)).rejects.toThrow();
    const reopened = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store });
    expect((await reopened.resumeIntegration(result.key)).status).toBe("conflict");
    expect(await readFile(join(result.worktreePath, "src", "shared.txt"), "utf8")).toContain("<<<<<<<");
  });

  it("continues after an agent explicitly resolves and commits a merge conflict", async () => {
    const a = await committed("task-a", "shared.txt", "A\n");
    const b = await committed("task-b", "shared.txt", "B\n");
    const conflict = await integration([{ taskKey: a.task.key }, { taskKey: b.task.key }]);
    await writeFile(join(conflict.worktreePath, "src", "shared.txt"), "A and B approved resolution\n");
    await git(conflict.worktreePath, "add", "src/shared.txt");
    await git(conflict.worktreePath, "commit", "-m", "Resolve conflict with both changes");
    await engine.acceptConflictResolution(conflict.key, { taskKey: b.task.key, resolutionCommitHash: await git(conflict.worktreePath, "rev-parse", "HEAD") });
    const result = await engine.resumeIntegration(conflict.key);
    expect(result.status).toBe("awaiting_verification");
    expect(result.merged).toEqual([a.task.key, b.task.key]);
    expect(result.conflictPaths).toEqual([]);
  });

  it("cancels an integration without aborting or removing its unresolved conflict", async () => {
    const a = await committed("task-a", "shared.txt", "A\n");
    const b = await committed("task-b", "shared.txt", "B\n");
    const result = await integration([{ taskKey: a.task.key }, { taskKey: b.task.key }]);
    const before = await readFile(join(result.worktreePath, "src", "shared.txt"), "utf8");
    expect((await engine.cancelIntegration(result.key)).status).toBe("cancelled");
    await expect(engine.cleanupIntegration(result.key)).rejects.toThrow();
    expect(await readFile(join(result.worktreePath, "src", "shared.txt"), "utf8")).toBe(before);
    expect(await git(result.worktreePath, "rev-parse", "--verify", "MERGE_HEAD")).toBe(b.changes.headCommitHash);
  });

  it("preserves unusual UTF-8 filenames, binary diffs and literal path characters", async () => {
    const task = await engine.prepareTask(request());
    const name = "src/tiếng Việt\tline\n[1].bin";
    await writeFile(join(task.worktreePath, name), Buffer.from([0, 255, 128, 1]));
    await git(task.worktreePath, "add", "-A");
    await git(task.worktreePath, "commit", "-m", "binary file");
    const changes = await engine.collectTask(task.key);
    expect(changes.filesChanged).toEqual([{ path: name, changeType: "added", additions: 0, deletions: 0 }]);
    const chunks = [];
    for await (const chunk of store.get(changes.patchArtifact)) {
      if (!chunk.ok) throw new Error(chunk.error.message);
      chunks.push(chunk.value);
    }
    expect(Buffer.concat(chunks).toString("utf8")).toContain("GIT binary patch");
  });

  it("requires a stored patch artifact before a committed task can be integrated", async () => {
    const task = await engine.prepareTask(request());
    await writeFile(join(task.worktreePath, "src", "task-a.txt"), "data\n");
    await git(task.worktreePath, "add", "-A");
    await git(task.worktreePath, "commit", "-m", "implementation");
    vi.spyOn(store, "put").mockRejectedValue(new Error("artifact store unavailable"));
    await expect(engine.collectTask(task.key)).rejects.toThrow(/artifact/i);
    await expect(integration([{ taskKey: task.key }])).rejects.toThrow(/artifact/i);
    expect(await git(repository, "rev-parse", "main")).toBe(base);
  });

  it("serializes independent engine instances with the repository lock", async () => {
    const task = await engine.prepareTask(request());
    await writeFile(join(task.worktreePath, "src", "pending.txt"), "data\n");
    await git(task.worktreePath, "add", "-A");
    await git(task.worktreePath, "commit", "-m", "implementation");
    const other = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store });
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const realPut = store.put.bind(store);
    vi.spyOn(store, "put").mockImplementationOnce(async (...args) => {
      entered();
      await waiting;
      return realPut(...args);
    });
    const collecting = engine.collectTask(task.key);
    try {
      await reached;
      await expect(other.collectTask(task.key)).rejects.toThrow(/busy|lock/i);
    } finally { release(); }
    expect((await collecting).filesChanged).toHaveLength(1);
    expect((await other.collectTask(task.key)).filesChanged).toHaveLength(1);
  });

  it("reloads task bindings and integration receipts on another engine instance", async () => {
    const { task, changes } = await committed();
    const result = await integration([{ taskKey: task.key }]);
    const reopened = await GitIntegrationEngine.open({ repositoryPath: join(repository, "src"), artifactStore: store });
    expect((await reopened.collectTask(task.key)).headCommitHash).toBe(changes.headCommitHash);
    const recovered = await reopened.resumeIntegration(result.key);
    expect(recovered.status).toBe("awaiting_verification");
    expect(recovered.merged).toEqual([task.key]);
    expect(await git(recovered.worktreePath, "rev-parse", "HEAD")).toBe(await git(result.worktreePath, "rev-parse", "HEAD"));
  });

  it("requires workflow verification of the current integration commit before publication or cleanup", async () => {
    const { task, changes } = await committed();
    const result = await integration([{ taskKey: task.key }]);
    await expect(engine.cleanupIntegration(result.key)).rejects.toThrow();
    await expect(engine.requestPullRequest(result.key, { remote: "origin", baseBranch: "main", title: "Task", body: "Change" })).rejects.toThrow();
    const verification = VerificationResultSchema.parse({
      schemaVersion: 2, verificationId: "verify-1", runId: "run-1", taskId: "integration", attemptId: "attempt-1", cycleNumber: 1,
      status: "passed", verificationScope: "task", independentExecution: true,
      evaluatedCriteria: [{ criterionId: "criterion-1", passed: true, evidenceArtifactId: changes.patchArtifact.artifactId, summary: "Verified" }],
      qualityGateResults: [], evidenceArtifacts: [changes.patchArtifact], findings: [], verifiedBy: "reviewer",
      startedAt: "2026-10-16T00:00:00.000Z", completedAt: "2026-10-16T00:00:01.000Z", metadata: { integrationCommitHash: base }
    });
    await expect(engine.recordVerification(result.key, verification)).rejects.toThrow();
    verification.verificationScope = "workflow";
    await expect(engine.recordVerification(result.key, verification)).rejects.toThrow();
    verification.metadata = { integrationCommitHash: await git(result.worktreePath, "rev-parse", "HEAD") };
    expect((await engine.recordVerification(result.key, verification)).status).toBe("verified");
    expect((await engine.cleanupIntegration(result.key)).status).toBe("cleaned");
    expect(await git(repository, "rev-parse", result.branchName)).not.toBe(base);
  });

  it("publishes a verified integration branch and creates one provider PR without moving main", async () => {
    let url: string | undefined;
    const provider: GitProvider = {
      checkAccess: vi.fn(async () => true),
      find: vi.fn(async () => url ? { url } : null),
      create: vi.fn(async () => { url = "https://provider.example/pull/1"; return { url }; })
    };
    engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, provider });
    const result = await verifiedIntegration();
    const remotePath = await remote();
    expect(await engine.requestPullRequest(result.key, prRequest)).toEqual({ url: "https://provider.example/pull/1" });
    expect(provider.create).toHaveBeenCalledOnce();
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ ...prRequest, remoteUrl: remotePath,
      headBranch: result.branchName, headCommitHash: result.expectedHead, idempotencyKey: expect.any(String) }));
    expect(await git(remotePath, "rev-parse", "main")).toBe(base);
    expect(await git(repository, "rev-parse", "main")).toBe(base);
    expect(await git(remotePath, "rev-parse", result.branchName)).toBe(result.expectedHead);
    expect(await engine.requestPullRequest(result.key, prRequest)).toEqual({ url: "https://provider.example/pull/1" });
    expect(provider.create).toHaveBeenCalledOnce();
  });

  it("publishes only the verified integration ref when push.followTags is enabled", async () => {
    const provider: GitProvider = { checkAccess: vi.fn(async () => true), find: vi.fn(async () => null),
      create: vi.fn(async () => ({ url: "https://provider.example/pull/1" })) };
    engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, provider });
    const result = await verifiedIntegration();
    const remotePath = await remote();
    await git(repository, "config", "push.followTags", "true");
    await git(repository, "tag", "-a", "private-release", result.expectedHead, "-m", "Unpublished release tag");
    await engine.requestPullRequest(result.key, prRequest);
    expect(await git(remotePath, "for-each-ref", "--format=%(refname)")).toBe(
      [`refs/heads/${result.branchName}`, "refs/heads/main"].sort().join("\n")
    );
    expect(await git(repository, "tag", "--list", "private-release")).toBe("private-release");
  });

  it("publishes the pinned verified commit when the branch advances during provider access checking", async () => {
    let integrationPath = "";
    const provider: GitProvider = { checkAccess: vi.fn(async () => {
      await writeFile(join(integrationPath, "src", "provider-drift.txt"), "concurrent unverified change\n");
      await git(integrationPath, "add", "-A");
      await git(integrationPath, "commit", "-m", "Concurrent branch advance after verification");
      return true;
    }), find: vi.fn(async () => null), create: vi.fn(async () => ({ url: "https://provider.example/pull/1" })) };
    engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, provider });
    const result = await verifiedIntegration();
    integrationPath = result.worktreePath;
    const remotePath = await remote();
    expect(await engine.requestPullRequest(result.key, prRequest)).toEqual({ url: "https://provider.example/pull/1" });
    expect(await git(integrationPath, "rev-parse", "HEAD")).not.toBe(result.expectedHead);
    expect(await git(remotePath, "rev-parse", result.branchName)).toBe(result.expectedHead);
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ headCommitHash: result.expectedHead }));
    expect(await git(repository, "rev-parse", "main")).toBe(base);
    expect(await git(remotePath, "rev-parse", "main")).toBe(base);
  });

  it("rejects changed PR target or content after its identity has been persisted", async () => {
    const provider: GitProvider = { checkAccess: vi.fn(async () => true), find: vi.fn(async () => null),
      create: vi.fn(async () => ({ url: "https://provider.example/pull/1" })) };
    engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, provider });
    const result = await verifiedIntegration();
    await remote();
    await engine.requestPullRequest(result.key, prRequest);
    const accessCount = vi.mocked(provider.checkAccess).mock.calls.length;
    for (const changed of [{ ...prRequest, baseBranch: "release" }, { ...prRequest, title: "Different title" }, { ...prRequest, body: "Different body" }]) {
      await expect(engine.requestPullRequest(result.key, changed)).rejects.toThrow(/identity|changed|idempotency/i);
    }
    expect(provider.checkAccess).toHaveBeenCalledTimes(accessCount);
    expect(provider.create).toHaveBeenCalledOnce();
  });

  it("does not call provider create when remote is missing or access is denied", async () => {
    const provider: GitProvider = { checkAccess: vi.fn(async () => false), find: vi.fn(async () => null),
      create: vi.fn(async () => ({ url: "https://provider.example/pull/1" })) };
    engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, provider });
    const result = await verifiedIntegration();
    await expect(engine.requestPullRequest(result.key, prRequest)).rejects.toThrow(/remote|origin/i);
    expect(provider.checkAccess).not.toHaveBeenCalled();
    const remotePath = await remote();
    await expect(engine.requestPullRequest(result.key, prRequest)).rejects.toThrow(/access/i);
    expect(provider.find).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
    expect(await git(repository, "ls-remote", "origin", `refs/heads/${result.branchName}`)).toBe("");
    expect(await git(remotePath, "rev-parse", "main")).toBe(base);
  });

  it("reconciles an ambiguous PR create response through provider lookup after restart", async () => {
    let created: { url: string } | null = null;
    const provider: GitProvider = { checkAccess: vi.fn(async () => true), find: vi.fn(async () => created),
      create: vi.fn(async () => { created = { url: "https://provider.example/pull/42" }; throw new Error("connection lost after provider accepted PR"); }) };
    engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, provider });
    const result = await verifiedIntegration();
    await remote();
    await expect(engine.requestPullRequest(result.key, prRequest)).rejects.toThrow(/connection lost/i);
    expect((await engine.getIntegration(result.key)).pullRequest?.state).toBe("pending");
    const reopened = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, provider });
    expect(await reopened.requestPullRequest(result.key, prRequest)).toEqual({ url: "https://provider.example/pull/42" });
    expect(provider.create).toHaveBeenCalledOnce();
    expect((await reopened.getIntegration(result.key)).pullRequest).toMatchObject({ state: "created", url: "https://provider.example/pull/42" });
  });

  it("refuses a non-fast-forward publication and preserves the divergent remote branch", async () => {
    const provider: GitProvider = { checkAccess: vi.fn(async () => true), find: vi.fn(async () => null),
      create: vi.fn(async () => ({ url: "https://provider.example/pull/1" })) };
    engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store, provider });
    const result = await verifiedIntegration();
    const remotePath = await remote();
    const tree = await git(repository, "rev-parse", `${base}^{tree}`);
    const divergent = await git(repository, "commit-tree", tree, "-p", base, "-m", "Independent remote commit");
    await git(repository, "push", "origin", `${divergent}:refs/heads/${result.branchName}`);
    await expect(engine.requestPullRequest(result.key, prRequest)).rejects.toThrow(/reject|fast-forward/i);
    expect(provider.create).not.toHaveBeenCalled();
    expect(await git(remotePath, "rev-parse", result.branchName)).toBe(divergent);
    expect(await git(remotePath, "rev-parse", "main")).toBe(base);
    expect(await git(repository, "rev-parse", "main")).toBe(base);
  });

  it("rejects cycles and unknown dependencies before integrating branches", async () => {
    const a = await committed("task-a");
    const b = await committed("task-b");
    await expect(integration([{ taskKey: a.task.key, dependsOn: [b.task.key] }, { taskKey: b.task.key, dependsOn: [a.task.key] }])).rejects.toThrow(/cycl|depend/i);
    await expect(integration([{ taskKey: a.task.key, dependsOn: ["missing"] }], "integration-unknown")).rejects.toThrow(/depend|unknown|missing/i);
    expect(await git(repository, "rev-parse", "main")).toBe(base);
  });
  describe("repair attempts based on the previous attempt's head", () => {
    async function attempt(taskId: string, attemptId: string, baseRevision: string, contents: string) {
      const task = await engine.prepareTask(request(taskId, { attemptId, baseRevision }));
      await writeFile(join(task.worktreePath, "src", `${taskId}.txt`), contents);
      await git(task.worktreePath, "add", "-A"); await git(task.worktreePath, "commit", "-m", `${taskId} ${attemptId}`);
      return { task, changes: await engine.collectTask(task.key) };
    }
    it("integrates attempt 2 whose base is the unmerged head of attempt 1", async () => {
      const first = await attempt("task-a", "attempt-1", base, "first\n");
      const second = await attempt("task-a", "attempt-2", first.changes.headCommitHash, "second\n");
      const result = await integration([{ taskKey: second.task.key }]);
      expect(result.status).toBe("awaiting_verification"); expect(result.merged).toEqual([second.task.key]);
      expect(await readFile(join(result.worktreePath, "src", "task-a.txt"), "utf8")).toBe("second\n");
      await git(result.worktreePath, "merge-base", "--is-ancestor", first.changes.headCommitHash, "HEAD");
      expect(await git(repository, "rev-parse", "main")).toBe(base);
    });
    it("integrates a three-attempt repair chain", async () => {
      const first = await attempt("task-a", "attempt-1", base, "first\n");
      const second = await attempt("task-a", "attempt-2", first.changes.headCommitHash, "second\n");
      const third = await attempt("task-a", "attempt-3", second.changes.headCommitHash, "third\n");
      const result = await integration([{ taskKey: third.task.key }]);
      expect(result.status).toBe("awaiting_verification");
      expect(await readFile(join(result.worktreePath, "src", "task-a.txt"), "utf8")).toBe("third\n");
    });
    it("still refuses a base that is another task's unmerged commit or unrelated history", async () => {
      const other = await attempt("task-b", "attempt-1", base, "other\n");
      const dependent = await attempt("task-a", "attempt-1", other.changes.headCommitHash, "dependent\n");
      await expect(integration([{ taskKey: dependent.task.key }], "integration-cross")).rejects.toThrow(/not yet in integration history/);
      await git(repository, "checkout", "-b", "side", base);
      await writeFile(join(repository, "README.md"), "side\n"); await git(repository, "commit", "-am", "side"); await git(repository, "checkout", "main");
      const side = await git(repository, "rev-parse", "side");
      const unrelated = await attempt("task-c", "attempt-1", side, "unrelated\n");
      await expect(integration([{ taskKey: unrelated.task.key }], "integration-unrelated")).rejects.toThrow(/not yet in integration history/);
    });
  });
});
