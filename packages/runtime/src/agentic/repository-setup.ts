import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { redactString } from "../resilience/redaction.js";
import { repositorySnapshotPath } from "./execution-binding.js";

const execute = promisify(execFile);
const OUTPUT_LIMIT = 4000;
const NPM_TIMEOUT_MS = 300_000, GIT_TIMEOUT_MS = 30_000;

/** Registry names and version ranges only: paths, URLs, git: and npm: aliases can run or fetch unreviewed code. */
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9^~>=<*.+_-]+)?$/;
/** No newline (a second entry), negation or catch-all that would hide the repository from Git. */
const IGNORE_PATTERN = /^(?!!)(?![*/]+$)[^\r\n#]{1,200}$/;
const RepositoryPath = z.string().min(1).max(512);
export const RepositorySetupInputSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("git_status") }).strict(),
  z.object({ operation: z.literal("git_log"), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  z.object({ operation: z.literal("npm_init") }).strict(),
  z.object({ operation: z.literal("npm_install_dev"), packages: z.array(z.string().regex(NPM_PACKAGE)).min(1).max(20) }).strict(),
  z.object({ operation: z.literal("gitignore_add"), patterns: z.array(z.string().regex(IGNORE_PATTERN)).min(1).max(50) }).strict(),
  z.object({ operation: z.literal("create_directories"), paths: z.array(RepositoryPath).min(1).max(50) }).strict(),
  z.object({ operation: z.literal("git_add"), paths: z.array(RepositoryPath).min(1).max(200) }).strict(),
  z.object({ operation: z.literal("git_commit"), message: z.string().trim().min(1).max(500) }).strict()
]);
export type RepositorySetupInput = z.infer<typeof RepositorySetupInputSchema>;
const READ_OPERATIONS: ReadonlySet<RepositorySetupInput["operation"]> = new Set(["git_status", "git_log"]);
export const isRepositorySetupMutation = (input: RepositorySetupInput): boolean => !READ_OPERATIONS.has(input.operation);

/** Literal repository-relative paths; control directories and credential files are never setup scope. */
function setupPath(path: string): string {
  const normalized = path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || segments.some(part => ["", ".", "..", ".git"].includes(part)) || !repositorySnapshotPath(normalized))
    throw new Error(`Repository setup path '${path}' is not permitted`);
  return normalized;
}
function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_") && name !== "GIT_OPTIONAL_LOCKS") delete env[name];
  return env;
}
const tail = (text: string): string => redactString(text.trim()).slice(-OUTPUT_LIMIT);
async function git(root: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  // Repository hooks and signing helpers are repository-controlled programs, so this tool never runs them.
  const { stdout } = await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args],
    { cwd: root, env: { ...environment(), ...extraEnv }, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Rejects a symlinked file so a setup write can never leave the repository. */
async function assertNotSymlink(path: string): Promise<void> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Repository setup refuses symlink ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function addIgnorePatterns(root: string, patterns: readonly string[]): Promise<string[]> {
  const path = join(root, ".gitignore");
  await assertNotSymlink(path);
  const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
  const present = new Set(current.split(/\r?\n/).map(line => line.trim()));
  const added = [...new Set(patterns)].filter(pattern => !present.has(pattern));
  if (added.length) await writeFile(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${added.join("\n")}\n`, { mode: 0o644 });
  return added;
}
async function createDirectory(root: string, path: string): Promise<void> {
  let current = root;
  for (const part of setupPath(path).split("/")) {
    current = join(current, part);
    await assertNotSymlink(current);
    await mkdir(current, { mode: 0o755 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    if (!(await lstat(current)).isDirectory()) throw new Error(`Repository setup path '${path}' is not a directory`);
  }
  const keep = join(current, ".gitkeep");
  await assertNotSymlink(keep);
  if (!await exists(keep)) await writeFile(keep, "", { flag: "wx", mode: 0o644 });
}
async function headOf(root: string): Promise<string | undefined> {
  return git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(value => value.trim(), () => undefined);
}
/** Fallback only: a repository's own Git identity always wins. */
async function commitIdentity(root: string): Promise<NodeJS.ProcessEnv> {
  const configured = await git(root, ["config", "user.email"]).then(value => value.trim(), () => "");
  return configured ? {} : { GIT_AUTHOR_NAME: "Bflow Coordinator", GIT_AUTHOR_EMAIL: "bflow@localhost", GIT_COMMITTER_NAME: "Bflow Coordinator", GIT_COMMITTER_EMAIL: "bflow@localhost" };
}

/**
 * Runs one allowlisted setup operation in the repository root. There is no command string: every operation builds its own argv
 * without a shell. npm lifecycle scripts are disabled, so installing a package runs no package code.
 */
export async function runRepositorySetup(repositoryPath: string, input: RepositorySetupInput, runId: string): Promise<Record<string, unknown>> {
  const root = await realpath(repositoryPath);
  switch (input.operation) {
    case "git_status": return { operation: input.operation, output: tail(await git(root, ["status", "--porcelain=v1", "--branch"])) };
    case "git_log": {
      if (await headOf(root) === undefined) return { operation: input.operation, output: "" };
      return { operation: input.operation, output: tail(await git(root, ["log", `--max-count=${input.limit}`, "--format=%H %s"])) };
    }
    case "npm_init": {
      if (await exists(join(root, "package.json"))) return { operation: input.operation, skipped: "package.json already exists" };
      const { stdout } = await execute("npm", ["init", "-y"], { cwd: root, env: environment(), encoding: "utf8", timeout: NPM_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024 });
      return { operation: input.operation, output: tail(stdout) };
    }
    case "npm_install_dev": {
      // Ignored first: a listed node_modules overflows the bounded repository snapshot and would itself read as drift.
      const ignored = await addIgnorePatterns(root, ["node_modules/"]);
      const { stdout } = await execute("npm", ["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", "--", ...input.packages],
        { cwd: root, env: environment(), encoding: "utf8", timeout: NPM_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      return { operation: input.operation, packages: input.packages, ignored, output: tail(stdout) };
    }
    case "gitignore_add": return { operation: input.operation, added: await addIgnorePatterns(root, input.patterns) };
    case "create_directories": {
      for (const path of input.paths) await createDirectory(root, path);
      return { operation: input.operation, paths: input.paths.map(setupPath) };
    }
    case "git_add": {
      const paths = input.paths.map(setupPath);
      await git(root, ["add", "--", ...paths], { GIT_LITERAL_PATHSPECS: "1" });
      return { operation: input.operation, paths };
    }
    case "git_commit": {
      const staged = (await git(root, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
      if (!staged.length) throw new Error("Nothing is staged; call git_add first");
      const refused = staged.find(path => !repositorySnapshotPath(path));
      if (refused) throw new Error(`Repository setup refuses to commit protected path '${refused}'`);
      await git(root, ["commit", "--no-verify", "-m", input.message, "-m", `Bflow-Run: ${runId}`], await commitIdentity(root));
      return { operation: input.operation, head: await headOf(root), files: staged };
    }
  }
}
