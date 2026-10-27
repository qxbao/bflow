import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { VerificationResultSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "./test-artifact-store.js";
import { GitIntegrationEngine } from "../src/index.js";

// One engine operation reuses a single repository inspection for its binding, clean-state and HEAD checks.
// These cases prove that inspection never outlives its operation: every later call observes edits made in between.
const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run("git", args, { cwd })).stdout.trim();
let temporary: string, repository: string, base: string, store: FilesystemArtifactStore, engine: GitIntegrationEngine;

beforeEach(async () => {
  temporary = await realpath(await mkdtemp(join(tmpdir(), "bflow-fresh-inspection-")));
  repository = join(temporary, "repository");
  await mkdir(join(repository, "src"), { recursive: true });
  await git(repository, "init", "-q", "-b", "main");
  await git(repository, "config", "user.name", "Bflow Test");
  await git(repository, "config", "user.email", "bflow@example.invalid");
  await writeFile(join(repository, "src", "shared.txt"), "original\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-q", "-m", "initial");
  base = await git(repository, "rev-parse", "HEAD");
  const opened = await openFilesystemArtifactStore({ root: join(temporary, "artifacts"), storeId: "fresh-inspection" });
  if (!opened.ok) throw new Error(opened.error.message);
  store = opened.value;
  engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store });
});
afterEach(async () => {
  store?.close();
  await rm(temporary, { recursive: true, force: true });
});

async function commit(cwd: string, file: string, contents: string) {
  await writeFile(join(cwd, "src", file), contents);
  await git(cwd, "add", "-A");
  await git(cwd, "commit", "-q", "-m", `edit ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

it("observes task edits made between operations instead of an earlier inspection", async () => {
  const task = await engine.prepareTask({ runId: "run-1", taskId: "task-a", attemptId: "attempt-1", baseRevision: base, ownedPaths: ["src"], developerId: "developer-a" });
  const first = await commit(task.worktreePath, "a.txt", "one\n");
  expect((await engine.collectTask(task.key)).headCommitHash).toBe(first);

  await writeFile(join(task.worktreePath, "src", "a.txt"), "uncommitted\n");
  await expect(engine.collectTask(task.key)).rejects.toThrow("uncommitted changes");

  const second = await commit(task.worktreePath, "a.txt", "two\n");
  expect(second).not.toBe(first);
  expect((await engine.collectTask(task.key)).headCommitHash).toBe(second);

  await git(task.worktreePath, "checkout", "-q", "-b", "elsewhere");
  await expect(engine.collectTask(task.key)).rejects.toThrow("binding changed");
});

it("refuses workflow verification for an integration HEAD that moved after the verification request", async () => {
  const task = await engine.prepareTask({ runId: "run-1", taskId: "task-a", attemptId: "attempt-1", baseRevision: base, ownedPaths: ["src"], developerId: "developer-a" });
  await commit(task.worktreePath, "a.txt", "one\n");
  const changes = await engine.collectTask(task.key);
  const integration = await engine.beginIntegration({ runId: "run-1", integrationId: "integration-1", baseRevision: base, tasks: [{ taskKey: task.key }] });
  expect(integration.status).toBe("awaiting_verification");
  const requested = await git(integration.worktreePath, "rev-parse", "HEAD");
  const verification = (head: string) => VerificationResultSchema.parse({
    schemaVersion: 2, verificationId: "verify-1", runId: "run-1", taskId: "integration", attemptId: "attempt-1", cycleNumber: 1,
    status: "passed", verificationScope: "workflow", independentExecution: true,
    evaluatedCriteria: [{ criterionId: "criterion-1", passed: true, evidenceArtifactId: changes.patchArtifact.artifactId, summary: "Verified" }],
    qualityGateResults: [], evidenceArtifacts: [changes.patchArtifact], findings: [], verifiedBy: "reviewer",
    startedAt: "2026-10-27T00:00:00.000Z", completedAt: "2026-10-27T00:00:01.000Z", metadata: { integrationCommitHash: head }
  });

  const moved = await commit(integration.worktreePath, "late.txt", "late\n");
  await expect(engine.recordVerification(integration.key, verification(requested))).rejects.toThrow("exact integrationCommitHash");
  await expect(engine.recordVerification(integration.key, verification(moved))).rejects.toThrow("exact integrationCommitHash");

  await git(integration.worktreePath, "reset", "-q", "--hard", requested);
  expect((await engine.recordVerification(integration.key, verification(requested))).status).toBe("verified");
});
