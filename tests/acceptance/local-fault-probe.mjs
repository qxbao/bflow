// Real local Git, subprocess gates and ArtifactStore. No Herdr or model is used.
// Build first. All mutations are confined to a new disposable directory.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactProposalSchema, QualityGateContextSchema } from "../../packages/contracts/dist/index.js";
import { openFilesystemArtifactStore } from "../../packages/artifact-store/dist/index.js";
import { createQualityGate } from "../../packages/quality-gates/dist/index.js";
import { GitIntegrationEngine } from "../../packages/git-orchestrator/dist/index.js";

const root = await mkdtemp(join(process.platform === "linux" ? "/tmp" : tmpdir(), "bfqa-faults-"));
const repository = join(root, "repository");
await mkdir(repository);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
Object.assign(env, { GIT_AUTHOR_NAME: "Bflow QA", GIT_AUTHOR_EMAIL: "qa@example.test",
  GIT_COMMITTER_NAME: "Bflow QA", GIT_COMMITTER_EMAIL: "qa@example.test" });
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
  { cwd, env, encoding: "utf8" }).trim();
const unwrap = result => { if (!result.ok) throw new Error(result.error.message); return result.value; };
const evidence = { schemaVersion: 1, mode: "real-local-components", herdr: false, model: false, root,
  runId: "qa-local-faults", observations: [] };
const artifactRoot = join(root, "artifacts");
const store = unwrap(await openFilesystemArtifactStore({ root: artifactRoot, storeId: "qa-local" }));
let missingStore;
try {
  git(repository, "init", "-b", "main");
  await writeFile(join(repository, "package.json"), '{"private":true,"type":"module"}\n');
  await writeFile(join(repository, "sum.js"), "export const sum = (a, b) => a - b;\n");
  await writeFile(join(repository, "sum.test.js"),
    "import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport {sum} from './sum.js';\ntest('regression: sum adds operands', () => assert.equal(sum(2, 3), 5));\n");
  git(repository, "add", "."); git(repository, "commit", "-m", "test: reproduce sum regression");
  const base = git(repository, "rev-parse", "HEAD");
  evidence.baseCommit = base;
  const engine = await GitIntegrationEngine.open({ repositoryPath: repository, artifactStore: store });
  const task = await engine.prepareTask({ runId: evidence.runId, taskId: "repair-sum", attemptId: "attempt-1",
    developerId: "qa-human-fixture", baseRevision: base, ownedPaths: ["sum.js"] });
  async function check(phase) {
    const id = `qa-${phase}`;
    const gate = createQualityGate({ spec: { gateId: id, checkKind: "unit_test",
      command: { executable: "node", args: ["--test", "sum.test.js"] }, workingDirectory: task.worktreePath, timeoutMs: 5000 },
      securityPolicy: { allowedRootDirs: [root], maxExecutionTimeoutMs: 5000,
        allowedCommands: [{ executable: "node", allowedArgPrefixes: [["--test", "sum.test.js"]] }] } });
    const result = unwrap(await gate.evaluateDetailed(QualityGateContextSchema.parse({ runId: evidence.runId,
      taskId: "repair-sum", definition: { id, name: id, evaluator: "command", required: true,
        timeout: { executionTimeoutMs: 5000, onTimeout: "fail" } }, artifacts: [] })));
    assert.ok(result.evidence);
    const proposal = ArtifactProposalSchema.parse(result.evidence.artifactProposal);
    const bytes = Buffer.from(result.evidence.serializedReport);
    const reference = unwrap(await store.put({ options: { artifactId: randomUUID(), runId: proposal.runId,
      taskId: proposal.taskId, kind: proposal.kind, mediaType: proposal.mediaType,
      expectedIntegrity: proposal.expectedIntegrity, idempotencyKey: randomUUID() },
      content: (async function* () { yield bytes; })() }));
    await writeFile(join(root, `${phase}.json`), result.evidence.serializedReport);
    evidence.observations.push({ case: "D07", phase, status: result.status, exitCode: result.exitCode,
      artifact: reference, commit: git(task.worktreePath, "rev-parse", "HEAD") });
    return result;
  }
  assert.equal((await check("red")).status, "failed");
  await writeFile(join(task.worktreePath, "sum.js"), "export const sum = (a, b) => a + b;\n");
  git(task.worktreePath, "add", "sum.js"); git(task.worktreePath, "commit", "-m", "fix: add operands in QA fixture");
  assert.equal((await check("green")).status, "passed");
  const firstPatch = await engine.collectTask(task.key);
  const other = await engine.prepareTask({ runId: evidence.runId, taskId: "conflicting-sum", attemptId: "attempt-1",
    developerId: "qa-human-fixture-2", baseRevision: base, ownedPaths: ["sum.js"] });
  await writeFile(join(other.worktreePath, "sum.js"), "export const sum = (a, b) => a * b;\n");
  git(other.worktreePath, "add", "sum.js"); git(other.worktreePath, "commit", "-m", "test: introduce independent conflicting change");
  const secondPatch = await engine.collectTask(other.key);
  const integrated = await engine.beginIntegration({ runId: evidence.runId, integrationId: "qa-conflict",
    baseRevision: base, tasks: [{ taskKey: task.key, dependsOn: [] }, { taskKey: other.key, dependsOn: [] }] });
  assert.equal(integrated.status, "conflict");
  assert.match(git(integrated.worktreePath, "status", "--porcelain=v1"), /UU sum.js/);
  evidence.observations.push({ case: "D05", status: integrated.status, worktreePath: integrated.worktreePath,
    integrationKey: integrated.key, requests: integrated.requests, patches: [firstPatch, secondPatch] });
  const missingRoot = join(root, "missing-artifact-store");
  missingStore = unwrap(await openFilesystemArtifactStore({ root: missingRoot, storeId: "qa-missing" }));
  const bytes = Buffer.from("deliberately removed evidence\n");
  const reference = unwrap(await missingStore.put({ options: { artifactId: "missing-evidence", runId: evidence.runId,
    kind: "test-result", mediaType: "text/plain", expectedIntegrity: { checksum: { algorithm: "sha256",
      value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length }, idempotencyKey: "missing-evidence" },
    content: (async function* () { yield bytes; })() }));
  const blobs = (await readdir(missingRoot)).filter(name => name.startsWith("blob-"));
  assert.equal(blobs.length, 1);
  await unlink(join(missingRoot, blobs[0]));
  const reads = [];
  for await (const result of missingStore.get(reference)) reads.push(result);
  assert.equal(reads.length, 1); assert.equal(reads[0].ok, false);
  evidence.observations.push({ case: "D06", artifact: reference, readResult: reads[0], bytesDelivered: 0 });
  assert.equal(git(repository, "remote", "-v"), "");
  assert.equal(git(repository, "rev-parse", "HEAD"), base);
  assert.equal(git(repository, "branch", "--show-current"), "main");
  assert.equal(git(repository, "status", "--porcelain=v1"), "");
  evidence.observations.push({ case: "D09", remoteConfigured: false, protectedBranchUnchanged: true,
    publicationAttempted: false, note: "Missing-remote PR rejection is separately covered by the package suite." });
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  missingStore?.close(); store.close();
  await writeFile(join(root, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify({ status: evidence.status, evidenceFile: join(root, "evidence.json"),
    retainedDisposableDirectory: root, model: false, herdr: false }));
}
