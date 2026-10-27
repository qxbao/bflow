import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { GitChangedFileSchema, type GitChangedFile } from "@bflow/contracts";
import { repositoryLock } from "./lock-context.js";
import { GitOrchestrationError } from "./model.js";

export class GitError extends Error {
  constructor(
    message: string,
    public readonly code: number | null,
    public readonly stdout: string,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "GitError";
  }
}

const configuration = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgSign=false",
  "-c", "merge.autoStash=false",
  "-c", "rerere.enabled=false",
  "-c", "core.fsmonitor=false",
  "-c", "diff.external=",
  "-c", "diff.renames=false"
];

/** Execute literal Git arguments. Output remains untrimmed for patches and NUL records. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Inherited Git overrides must never redirect one task into another repository/index.
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  return new Promise((accept, reject) => {
    const lockDescriptor = repositoryLock.getStore();
    const child = spawn("git", [...configuration, ...args], {
      cwd, env, windowsHide: true,
      stdio: lockDescriptor === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", lockDescriptor]
    });
    const outputChunks: Buffer[] = [], diagnosticChunks: Buffer[] = [];
    let outputSize = 0, diagnosticSize = 0, stopped = false;
    const stop = () => { stopped = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, 60_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      outputSize += chunk.length;
      if (outputSize > 64 * 1024 * 1024) stop();
      else outputChunks.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      diagnosticSize += chunk.length;
      if (diagnosticSize > 64 * 1024 * 1024) stop();
      else diagnosticChunks.push(chunk);
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(diagnosticChunks).toString("utf8");
      let stdout: string;
      try { stdout = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(outputChunks)); }
      catch { reject(new GitError("Git returned non-UTF-8 output", null, "", stderr)); return; }
      if (code !== 0 || signal || stopped) {
        reject(new GitError(`Git ${args[0] ?? "command"} failed: ${stderr.trim() || (stopped ? "timeout/output limit" : signal ?? code)}`,
          stopped || signal ? null : code, stdout, stderr));
      } else accept(stdout);
    });
  });
}

/** For Git predicates, only exit 1 means false; execution failures remain errors. */
export async function succeeds(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return false;
    throw error;
  }
}

export async function resolveCommit(cwd: string, ref: string): Promise<string> {
  const commit = (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
  // The frozen GitChangeSet contract supports SHA-1 repositories only.
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Unsupported Git object format: expected SHA-1 commit");
  return commit;
}

/**
 * Run several rev-parse queries in one Git process. Output is one line per query, so a path
 * containing a newline cannot be split unambiguously; then query each one separately.
 */
async function revParseLines(cwd: string, combined: readonly string[], separate: readonly (readonly string[])[]): Promise<string[]> {
  const lines = (await git(cwd, ["rev-parse", ...combined])).split("\n");
  if (lines.length === separate.length + 1 && lines.pop() === "") return lines;
  const values: string[] = [];
  for (const args of separate) values.push((await git(cwd, ["rev-parse", ...args])).replace(/\n$/, ""));
  return values;
}

/** Worktree root and common Git directory (the repository identity), without reading HEAD or status. */
export async function repositoryPaths(cwd: string): Promise<{ root: string; commonDir: string }> {
  const [topLevel, common] = await revParseLines(cwd, ["--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    [["--show-toplevel"], ["--path-format=absolute", "--git-common-dir"]]) as [string, string];
  const root = await realpath(topLevel);
  return { root, commonDir: await realpath(isAbsolute(common) ? common : resolve(root, common)) };
}

export type RepositoryInspection = Awaited<ReturnType<typeof inspectRepository>>;

export async function inspectRepository(cwd: string): Promise<{
  root: string;
  commonDir: string;
  branch: string | null;
  head: string;
  dirty: boolean;
  status: string;
}> {
  const { root, commonDir } = await repositoryPaths(cwd);
  let branch: string | null;
  try {
    branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  } catch (error) {
    if (!(error instanceof GitError) || error.code !== 1) throw error;
    branch = null;
  }
  const head = await resolveCommit(root, "HEAD");
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  return { root, commonDir, branch, head, dirty: status.length > 0, status };
}

export async function assertClean(cwd: string): Promise<void> {
  await assertInspectedClean(await inspectRepository(cwd));
}

/**
 * Clean-state checks for an inspection taken by the same operation, with no Git mutation since. Never pass an inspection
 * across a mutation or a later operation: it would hide changes made in between.
 */
export async function assertInspectedClean(repository: RepositoryInspection): Promise<void> {
  if (repository.dirty) throw new Error("Git working tree has uncommitted changes");
  // Porcelain and Git worktree remove both trust these index flags and can silently
  // ignore modified tracked bytes. Do not clear flags or discard the hidden edits.
  const indexEntries = (await git(repository.root, ["ls-files", "-v", "-z"])).split("\0");
  if (indexEntries.some(entry => /^[a-zS] /.test(entry))) {
    throw new GitOrchestrationError("unsupported_index_flags",
      "Git index contains assume-unchanged or skip-worktree flags; inspect hidden changes and clear those flags explicitly before proceeding");
  }
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"];
  const markerPaths = await revParseLines(repository.root, markers.flatMap(marker => ["--git-path", marker]),
    markers.map(marker => ["--git-path", marker]));
  for (const [index, marker] of markers.entries()) {
    const markerPath = markerPaths[index]!;
    try {
      await lstat(resolve(repository.root, markerPath));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Git operation is still in progress (${marker})`);
  }
}

export async function changedFiles(cwd: string, base: string, head: string): Promise<GitChangedFile[]> {
  const baseCommit = await resolveCommit(cwd, base);
  const headCommit = await resolveCommit(cwd, head);
  // Disable rename detection so both the deleted and added paths undergo scope checks.
  const common = ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", baseCommit, headCommit];
  const names = (await git(cwd, [...common, "--name-status", "-z", "--"])).split("\0");
  const statistics = (await git(cwd, [...common, "--numstat", "-z", "--"])).split("\0");
  if (names.pop() !== "" || statistics.pop() !== "") throw new Error("Invalid Git diff record termination");
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const entry of statistics) {
    const first = entry.indexOf("\t");
    const second = entry.indexOf("\t", first + 1);
    if (first < 1 || second < 0) throw new Error("Invalid Git numstat record");
    const path = entry.slice(second + 1);
    const parseCount = (value: string): number => {
      if (value === "-") return 0; // Binary blobs have no line-count representation.
      if (!/^\d+$/.test(value)) throw new Error("Invalid Git line count");
      const count = Number(value);
      if (!Number.isSafeInteger(count)) throw new Error("Git line count exceeds safe integer range");
      return count;
    };
    if (counts.has(path)) throw new Error("Duplicate Git numstat path");
    counts.set(path, { additions: parseCount(entry.slice(0, first)), deletions: parseCount(entry.slice(first + 1, second)) });
  }
  if (names.length % 2 !== 0) throw new Error("Invalid Git name-status records");
  const result: GitChangedFile[] = [];
  for (let index = 0; index < names.length; index += 2) {
    const status = names[index];
    const path = names[index + 1];
    if (path === undefined || status === undefined) throw new Error("Missing Git changed path");
    const count = counts.get(path);
    if (!count) throw new Error("Missing Git numstat path");
    const changeType = status === "A" || status.startsWith("C") ? "added" : status === "D" ? "deleted" : status === "M" || status === "T" ? "modified" : null;
    if (!changeType) throw new Error(`Unsupported Git change status: ${status}`);
    result.push(GitChangedFileSchema.parse({ path, changeType, ...count }));
    counts.delete(path);
  }
  if (counts.size) throw new Error("Unexpected Git numstat paths");
  return result;
}

export async function patch(cwd: string, base: string, head: string): Promise<string> {
  const baseCommit = await resolveCommit(cwd, base);
  const headCommit = await resolveCommit(cwd, head);
  return git(cwd, ["diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", baseCommit, headCommit, "--"]);
}
