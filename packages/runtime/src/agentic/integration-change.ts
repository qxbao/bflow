import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { GitChangeSetSchema, type ArtifactStore, type GitChangeSet } from "@bflow/contracts";
import { runtimeGitDirectoryFlags } from "./patch-paths.js";
import { unwrap } from "./outbox.js";

async function gitRead(cwd: string, args: string[]): Promise<string> {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"
  };
  const dirFlags = await runtimeGitDirectoryFlags(cwd, { resetSafeDirectory: true });
  return new Promise((accept, reject) => {
    const child = spawn("git", [...dirFlags, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let length = 0, settled = false;
    const abort = (message: string) => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => abort("Integration evidence read timed out"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 64 * 1024 * 1024) { clearTimeout(timer); abort("Integration evidence exceeds limit"); }
      else chunks.push(Buffer.from(chunk));
    });
    child.once("error", error => { clearTimeout(timer); if (settled) return; settled = true; reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const bytes = Buffer.concat(chunks); const text = bytes.toString("utf8");
      if (code !== 0 || !Buffer.from(text).equals(bytes)) reject(new Error("Cannot read UTF-8 integration evidence")); else accept(text);
    });
  });
}

async function gitExec(cwd: string, args: string[], allowedExitCodes: readonly number[] = [0]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null"
  };
  const dirFlags = await runtimeGitDirectoryFlags(cwd, { resetSafeDirectory: true });
  return new Promise((accept, reject) => {
    const child = spawn("git", [
      ...dirFlags,
      "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgSign=false",
      "-c", "merge.autoStash=false",
      "-c", "rerere.enabled=false",
      "-c", "core.fsmonitor=false",
      "-c", "diff.external=",
      "-c", "diff.renames=false",
      "-c", "user.name=Bflow Integration",
      "-c", "user.email=bflow-integration@local",
      ...args
    ], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const outChunks: Buffer[] = [], errChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Integration merge restore timed out"));
    }, 60_000);
    child.stdout.on("data", (chunk: Buffer) => outChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(Buffer.from(chunk)));
    child.once("error", error => { clearTimeout(timer); if (settled) return; settled = true; reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const exitCode = code ?? 1;
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (!allowedExitCodes.includes(exitCode)) reject(new Error((stderr || stdout || `git exited with ${exitCode}`).trim()));
      else accept({ code: exitCode, stdout, stderr });
    });
  });
}

/**
 * Restores the exact P18 conflicted merge state after a non-final resolver attempt commits a merge that P18 rejects
 * (for example, out-of-scope or generated files), so the next bounded resolver attempt receives a live MERGE_HEAD.
 */
export async function restoreRejectedConflictMerge(options: {
  worktreePath: string;
  branchName: string;
  rejectedHead: string;
  incomingCommitHash?: string;
}): Promise<void> {
  const { worktreePath: path, branchName, rejectedHead, incomingCommitHash } = options;
  if (!/^[a-f0-9]{40}$/.test(rejectedHead) || (incomingCommitHash !== undefined && !/^[a-f0-9]{40}$/.test(incomingCommitHash)))
    throw new Error("Rejected merge restore requires pinned commit hashes");
  if ((await gitRead(path, ["rev-parse", "HEAD"])).trim() !== rejectedHead)
    throw new Error("Integration HEAD no longer matches rejected merge commit");
  if ((await gitRead(path, ["symbolic-ref", "-q", "--short", "HEAD"])).trim() !== branchName)
    throw new Error("Integration worktree is no longer on the expected integration branch");
  const parents = (await gitRead(path, ["show", "-s", "--format=%P", rejectedHead])).trim().split(/\s+/).filter(Boolean);
  const [beforeMerge, mergedIncoming] = parents;
  if (parents.length !== 2 || !beforeMerge || !mergedIncoming || !/^[a-f0-9]{40}$/.test(beforeMerge) || !/^[a-f0-9]{40}$/.test(mergedIncoming))
    throw new Error("Rejected commit is not a two-parent integration merge");
  if (incomingCommitHash !== undefined && mergedIncoming !== incomingCommitHash)
    throw new Error("Rejected merge second parent does not match incoming task commit");
  await gitExec(path, ["reset", "--hard", beforeMerge]);
  await gitExec(path, ["clean", "-fd"]);
  await gitExec(path, ["merge", "--no-ff", "--no-edit", "--no-stat", "--", mergedIncoming], [0, 1]);
  const restoredMergeHead = (await gitExec(path, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], [0, 1])).stdout.trim();
  if (restoredMergeHead !== mergedIncoming)
    throw new Error("Could not restore conflicted MERGE_HEAD after rejected resolution");
}
/** Read the actual integrated diff, which may contain merge commits and conflict resolution. */
export async function captureIntegratedChange(options: {
  artifactStore: ArtifactStore; runId: string; taskId: string; worktreePath: string;
  branchName: string; baseRevision: string; headCommitHash: string;
}): Promise<GitChangeSet> {
  const { baseRevision: base, headCommitHash: head, worktreePath: path } = options;
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(head)) throw new Error("Integration evidence needs pinned revisions");
  if ((await gitRead(path, ["rev-parse", "HEAD"])).trim() !== head || await gitRead(path, ["status", "--porcelain=v1", "-z"]))
    throw new Error("Integrated revision changed or worktree is dirty");
  if ((await gitRead(path, ["ls-files", "-v", "-z"])).split("\0").some(entry => /^[a-zS] /.test(entry)))
    throw new Error("Unsupported index flags in integrated worktree");
  const statuses = (await gitRead(path, ["diff", "--name-status", "--no-renames", "-z", base, head, "--"])).split("\0");
  const types = new Map<string, "added" | "deleted" | "modified">();
  for (let i = 0; i + 1 < statuses.length; i += 2) types.set(statuses[i + 1]!, statuses[i] === "A" ? "added" : statuses[i] === "D" ? "deleted" : "modified");
  const files = (await gitRead(path, ["diff", "--numstat", "--no-renames", "-z", base, head, "--"])).split("\0").filter(Boolean).map(line => {
    const first = line.indexOf("\t"); const second = line.indexOf("\t", first + 1);
    if (first < 0 || second < 0) throw new Error("Invalid integration numstat");
    const file = line.slice(second + 1);
    return { path: file, changeType: types.get(file)!, additions: line.slice(0, first) === "-" ? 0 : Number(line.slice(0, first)),
      deletions: line.slice(first + 1, second) === "-" ? 0 : Number(line.slice(first + 1, second)) };
  });
  const bytes = Buffer.from(await gitRead(path, ["diff", "--binary", "--no-ext-diff", "--no-textconv", base, head, "--"]));
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const patchArtifact = unwrap(await options.artifactStore.put({ options: {
    artifactId: `integrated-patch-${checksum}`, runId: options.runId, taskId: options.taskId, kind: "patch", mediaType: "text/x-patch",
    expectedIntegrity: { checksum: { algorithm: "sha256", value: checksum }, sizeBytes: bytes.length }, idempotencyKey: `integrated:${options.runId}:${head}`
  }, content: (async function* () { yield bytes; })() }));
  if ((await gitRead(path, ["rev-parse", "HEAD"])).trim() !== head || await gitRead(path, ["status", "--porcelain=v1", "-z"]))
    throw new Error("Integrated revision changed while capturing evidence");
  return GitChangeSetSchema.parse({ schemaVersion: 2, changeSetId: `integrated-${checksum}`, runId: options.runId, taskId: options.taskId,
    attemptId: `integrated-${head}`, worktreePath: path, branchName: options.branchName,
    baseCommitHash: base, headCommitHash: head, dirtyWorkingTree: false, filesChanged: files, patchArtifact,
    createdAt: new Date().toISOString(), metadata: { integrationCommitHash: head } });
}
