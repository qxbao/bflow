import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { environmentProcessRunner, type EnvironmentProcessRunner } from "./environment-process.js";
import { gitSafeDirectoryFlags, sanitizedGitEnv } from "./git-safe-directory.js";

/** The entry `bflow init` adds; the marker line above it records that Bflow, not the user, owns it. */
export const BFLOW_EXCLUDE_ENTRY = ".bflow/";
export const BFLOW_EXCLUDE_MARKER = "# Added by bflow init: local Bflow configuration and state";
const EQUIVALENT_ENTRIES: ReadonlySet<string> = new Set([".bflow", ".bflow/", "/.bflow", "/.bflow/"]);

export interface GitExcludeReport {
  /** `<git-common-dir>/info/exclude`, resolved through `git rev-parse --git-path` so worktrees and submodules share it. */
  readonly path: string;
  /** `bflow`: the marked entry is present; `user`: an equivalent entry exists that Bflow did not add; `absent`: neither. */
  readonly status: "bflow" | "user" | "absent";
  readonly changed: boolean;
}

export async function resolveGitExcludePath(root: string, runner: EnvironmentProcessRunner = environmentProcessRunner): Promise<string> {
  const result = await runner.run({ executable: "git", args: [...gitSafeDirectoryFlags(root), "rev-parse", "--git-path", "info/exclude"],
    cwd: root, env: sanitizedGitEnv(), timeoutMs: 5000 });
  const path = result.stdout.trim();
  if (result.exitCode !== 0 || !path) throw new Error(`Cannot resolve the Git exclude file for '${root}'.`);
  return isAbsolute(path) ? path : resolve(root, path);
}

async function readLines(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return content === "" ? [] : content.replace(/\r?\n$/, "").split(/\r?\n/);
}

function classify(lines: readonly string[]): GitExcludeReport["status"] {
  if (lines.some((line, index) => line.trim() === BFLOW_EXCLUDE_ENTRY && lines[index - 1]?.trim() === BFLOW_EXCLUDE_MARKER)) return "bflow";
  return lines.some(line => EQUIVALENT_ENTRIES.has(line.trim())) ? "user" : "absent";
}

async function writeLines(path: string, lines: readonly string[]): Promise<void> {
  // Replace through a sibling temporary file so a failed write never truncates the user's exclude rules.
  const temporary = `${path}.bflow-${process.pid}.tmp`;
  await writeFile(temporary, lines.length ? `${lines.join("\n")}\n` : "", { mode: 0o644 });
  await rename(temporary, path);
}

export async function inspectGitExclude(root: string, runner?: EnvironmentProcessRunner): Promise<GitExcludeReport> {
  const path = await resolveGitExcludePath(root, runner);
  return { path, status: classify(await readLines(path)), changed: false };
}

/** Idempotent: an existing `.bflow`/`.bflow/` rule, marked or not, is never duplicated. */
export async function ensureGitExclude(root: string, runner?: EnvironmentProcessRunner): Promise<GitExcludeReport> {
  const path = await resolveGitExcludePath(root, runner);
  const lines = await readLines(path);
  const status = classify(lines);
  if (status !== "absent") return { path, status, changed: false };
  await mkdir(dirname(path), { recursive: true });
  await writeLines(path, [...lines, BFLOW_EXCLUDE_MARKER, BFLOW_EXCLUDE_ENTRY]);
  return { path, status: "bflow", changed: true };
}

/** Removes only the marked entry Bflow added; a user's own `.bflow` rule is left untouched. */
export async function removeGitExclude(root: string, runner?: EnvironmentProcessRunner): Promise<GitExcludeReport> {
  const path = await resolveGitExcludePath(root, runner);
  const lines = await readLines(path);
  const kept = lines.filter((line, index) =>
    !(line.trim() === BFLOW_EXCLUDE_MARKER && lines[index + 1]?.trim() === BFLOW_EXCLUDE_ENTRY) &&
    !(line.trim() === BFLOW_EXCLUDE_ENTRY && lines[index - 1]?.trim() === BFLOW_EXCLUDE_MARKER));
  if (kept.length === lines.length) return { path, status: classify(lines), changed: false };
  await writeLines(path, kept);
  return { path, status: classify(kept), changed: true };
}
