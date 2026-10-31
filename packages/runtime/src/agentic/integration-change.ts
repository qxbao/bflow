import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { GitChangeSetSchema, type ArtifactStore, type GitChangeSet } from "@bflow/contracts";
import { runtimeGitDirectoryFlags } from "./patch-paths.js";
import { unwrap } from "./outbox.js";

async function gitRead(cwd: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const dirFlags = await runtimeGitDirectoryFlags(cwd);
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
