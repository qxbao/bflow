import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { VerificationResultSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "./test-artifact-store.js";
import { GitIntegrationEngine } from "../src/index.js";
const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd })).stdout.trim();
}
// Every test below exercises GitIntegrationEngine's Linux flock journal.
let temporary: string, repository: string, artifacts: string, base: string;
let store: FilesystemArtifactStore, engine: GitIntegrationEngine;
beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "bflow-p18-hardening-"));
  repository = join(temporary, "repo"); artifacts = join(temporary, "artifacts");
  await mkdir(join(repository, "src"), { recursive: true });
  await git(repository, "init", "-b", "main"); await git(repository, "config", "user.name", "Bflow tests");
  await git(repository, "config", "user.email", "hardening@example.invalid");
  await writeFile(join(repository, "src", "initial.txt"), "initial\n");
  await writeFile(join(repository, "README.md"), "original\n");
  await writeFile(join(repository, ".gitignore"), "cache/\n");
  await git(repository, "add", "."); await git(repository, "commit", "-m", "initial"); base = await git(repository, "rev-parse", "HEAD");
  const opened = await openFilesystemArtifactStore({ root: artifacts, storeId: "hardening" });
  if (!opened.ok) throw Error(opened.error.message); store = opened.value;
  engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store });
});
afterEach(async () => { store?.close(); await rm(temporary, { recursive: true, force: true }); });
async function task() {
  return engine.prepareTask({ runId: "run", taskId: "task", attemptId: "attempt", developerId: "developer", ownedPaths: ["src"], baseRevision: base });
}
async function submitted() {
  const record = await task(); await writeFile(join(record.worktreePath, "src", "implementation.txt"), "implementation\n");
  await git(record.worktreePath, "add", "."); await git(record.worktreePath, "commit", "-m", "implementation");
  return { task: record, changeSet: await engine.collectTask(record.key) };
}
it.skipIf(process.platform !== "linux")("checks every task commit so reverting an out-of-scope edit does not conceal it", async () => {
  const record = await task();
  await writeFile(join(record.worktreePath, "README.md"), "unauthorized\n"); await git(record.worktreePath, "add", "."); await git(record.worktreePath, "commit", "-m", "unauthorized");
  await writeFile(join(record.worktreePath, "README.md"), "original\n");
  await writeFile(join(record.worktreePath, "src", "okay.txt"), "allowed\n"); await git(record.worktreePath, "add", "."); await git(record.worktreePath, "commit", "-m", "revert unauthorized path");
  await expect(engine.collectTask(record.key)).rejects.toThrow(/own/i);
});
it.skipIf(process.platform !== "linux")("preserves ignored data during cleanup and recovers an already unlocked worktree", async () => {
  const record = await task(); await engine.cancelTask(record.key);
  await mkdir(join(record.worktreePath, "cache")); await writeFile(join(record.worktreePath, "cache", "keep.txt"), "keep\n");
  await expect(engine.cleanupTask(record.key)).rejects.toThrow(/ignored/i);
  expect(await readFile(join(record.worktreePath, "cache", "keep.txt"), "utf8")).toBe("keep\n");
  await rm(join(record.worktreePath, "cache"), { recursive: true });
  await git(repository, "worktree", "unlock", record.worktreePath); // interrupted cleanup after unlocking
  expect((await engine.cleanupTask(record.key)).status).toBe("cleaned");
  expect((await engine.cleanupTask(record.key)).status).toBe("cleaned");
  expect(await git(repository, "rev-parse", record.branchName)).toBe(base);
});
it.skipIf(process.platform !== "linux")("rejects a committed task changed after its patch snapshot was submitted", async () => {
  const { task: record } = await submitted();
  await writeFile(join(record.worktreePath, "src", "later.txt"), "later\n"); await git(record.worktreePath, "add", "."); await git(record.worktreePath, "commit", "-m", "later");
  await expect(engine.beginIntegration({ runId: "run", integrationId: "integration", baseRevision: base, tasks: [{ taskKey: record.key }] })).rejects.toThrow(/changed|stale/i);
  expect(await git(repository, "branch", "--list", "integration/*")).toBe("");
});
it.skipIf(process.platform !== "linux")("requires readable evidence bytes even if the ArtifactStore catalog still resolves them", async () => {
  const { task: record, changeSet } = await submitted();
  const integration = await engine.beginIntegration({ runId: "run", integrationId: "integration", baseRevision: base, tasks: [{ taskKey: record.key }] });
  const blob = (await readdir(artifacts)).find(path => path.startsWith("blob-")); expect(blob).toBeTruthy();
  await writeFile(join(artifacts, blob!), "corrupt\n");
  const resolved = await store.resolve(changeSet.patchArtifact.artifactId); expect(resolved.ok).toBe(true);
  const verification = VerificationResultSchema.parse({ schemaVersion: 2, verificationId: "verify", runId: "run", taskId: "integration", attemptId: "attempt", cycleNumber: 1,
    status: "passed", verificationScope: "workflow", independentExecution: true,
    evaluatedCriteria: [{ criterionId: "criterion", passed: true, evidenceArtifactId: changeSet.patchArtifact.artifactId, summary: "passed" }], qualityGateResults: [],
    evidenceArtifacts: [changeSet.patchArtifact], findings: [], verifiedBy: "qa", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    metadata: { integrationCommitHash: integration.expectedHead } });
  await expect(engine.recordVerification(integration.key, verification)).rejects.toThrow(/artifact|evidence/i);
  expect((await engine.getIntegration(integration.key)).status).toBe("awaiting_verification");
});
it.skipIf(process.platform !== "linux")("does not interpret cleanup of a cancelled integration as successful verification", async () => {
  const { task: record } = await submitted();
  const integration = await engine.beginIntegration({ runId: "run", integrationId: "integration", baseRevision: base, tasks: [{ taskKey: record.key }] });
  await engine.cancelIntegration(integration.key); await engine.cleanupIntegration(integration.key);
  await expect(engine.cleanupTask(record.key)).rejects.toThrow(/release|verification|verified/i);
  await engine.cancelTask(record.key); expect((await engine.cleanupTask(record.key)).status).toBe("cleaned");
});
it.skipIf(process.platform !== "linux")("checks ownership when recovering a merge committed before its receipt was persisted", async () => {
  const { task: record, changeSet } = await submitted();
  const integration = await engine.beginIntegration({ runId: "run", integrationId: "integration", baseRevision: base, tasks: [{ taskKey: record.key }] });
  // Craft the precise crash fixture: valid merge parents, but unauthorized resolver edit.
  await writeFile(join(integration.worktreePath, "README.md"), "unauthorized resolution\n");
  await git(integration.worktreePath, "add", "."); await git(integration.worktreePath, "commit", "--amend", "--no-edit");
  const stateFile = join(engine.stateDirectory, "state.json");
  const journal = JSON.parse(await readFile(stateFile, "utf8"));
  const entry = journal.integrations[integration.key];
  entry.status = "merging"; entry.merged = []; entry.currentTask = record.key; entry.beforeMerge = base; entry.expectedHead = base; entry.requests = [];
  await writeFile(stateFile, JSON.stringify(journal));
  const reopened = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store });
  await expect(reopened.resumeIntegration(integration.key)).rejects.toThrow(/own/i);
  expect(await git(integration.worktreePath, "show", "-s", "--format=%P", "HEAD")).toBe(`${base} ${changeSet.headCommitHash}`);
  expect(await readFile(join(integration.worktreePath, "README.md"), "utf8")).toBe("unauthorized resolution\n");
  expect(await git(repository, "rev-parse", "main")).toBe(base);
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  it.skipIf(process.platform !== "linux")(`preserves tracked local edits hidden by ${flag} during cleanup`, async () => {
    const record = await task();
    await git(record.worktreePath, "update-index", flag, "src/initial.txt");
    await writeFile(join(record.worktreePath, "src", "initial.txt"), "hidden uncommitted work\n");
    expect(await git(record.worktreePath, "status", "--porcelain")).toBe("");
    await engine.cancelTask(record.key);
    await expect(engine.cleanupTask(record.key)).rejects.toThrow(/index|hidden|unchanged|skip-worktree/i);
    expect(await readFile(join(record.worktreePath, "src", "initial.txt"), "utf8")).toBe("hidden uncommitted work\n");
    expect((await engine.getTask(record.key)).status).toBe("cancelled");
  });

  it.skipIf(process.platform !== "linux")(`refuses a clean submission which hides edits through ${flag}`, async () => {
    const { task: record } = await submitted();
    await git(record.worktreePath, "update-index", flag, "src/initial.txt");
    await writeFile(join(record.worktreePath, "src", "initial.txt"), "unsubmitted local change\n");
    expect(await git(record.worktreePath, "status", "--porcelain")).toBe("");
    await expect(engine.collectTask(record.key)).rejects.toThrow(/index|hidden|unchanged|skip-worktree/i);
    expect(await readFile(join(record.worktreePath, "src", "initial.txt"), "utf8")).toBe("unsubmitted local change\n");
  });
}

it.skipIf(process.platform !== "linux")("rejects inherited object keys as unknown task and integration identities", async () => {
  for (const key of ["__proto__", "constructor", "toString"]) {
    await expect(engine.getTask(key)).rejects.toThrow(/unknown task/i);
    await expect(engine.getIntegration(key)).rejects.toThrow(/unknown integration/i);
    await expect(engine.cancelTask(key)).rejects.toThrow(/unknown task/i);
    await expect(engine.cancelIntegration(key)).rejects.toThrow(/unknown integration/i);
  }
});
