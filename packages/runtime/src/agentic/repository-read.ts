import { constants as fsConstants } from "node:fs";
import { lstat, opendir, open, readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { JsonValue } from "@bflow/contracts";

const execFileAsync = promisify(execFile);
const READ_LIMIT = 64 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_DIRECTORY_SCAN = 500;
const MAX_DIRECTORY_CURSOR = 1_000_000;
const MAX_GIT_OUTPUT = 128 * 1024;
const MAX_GIT_TIMEOUT_MS = 2_000;

const relativePath = z.string().min(1).max(2048).refine(path =>
  !path.includes("\0") && !path.includes("\\") && !isAbsolute(path) && path.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".."),
"must be a relative POSIX path without traversal segments");
const listPath = z.string().max(2048).default(".").refine(path => path === "." || relativePath.safeParse(path).success, "must be a relative POSIX directory path");
const boundedLimit = z.number().int().min(1).max(READ_LIMIT).default(16 * 1024);
const listLimit = z.number().int().min(1).max(100).default(50);
const directoryCursor = z.number().int().min(0).max(MAX_DIRECTORY_CURSOR).optional();
const gitLimit = z.number().int().min(1).max(50).default(20);

export const RepositoryReadInputSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("read"), path: relativePath, offset: z.number().int().min(0).max(MAX_FILE_BYTES).default(0), limit: boundedLimit }).strict(),
  z.object({ op: z.literal("list"), path: listPath, limit: listLimit, cursor: directoryCursor }).strict(),
  z.object({ op: z.literal("git"), action: z.enum(["status", "log", "head", "files", "diff"]), limit: gitLimit }).strict()
]);

type ReaderInput = z.infer<typeof RepositoryReadInputSchema>;
const EXCLUDED_SEGMENTS = new Set([
  ".git", ".bflow", ".ssh", ".aws", ".azure", ".gnupg", "node_modules", ".pnpm-store", ".cache", "cache", "coverage", "dist", "build",
  ".next", ".nuxt", ".turbo", ".vite", ".venv", "venv", "vendor", "target", "__pycache__"
]);
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keystore|secret|token|credentials))$/i;

function assertInsideRoot(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("repository path escaped its root");
}

function assertAllowedPath(path: string, allowRoot = false): string {
  if (path === "." && allowRoot) return path;
  const segments = path.split("/");
  if (segments.some(segment => segment.length === 0 || segment === "." || segment === ".." || EXCLUDED_SEGMENTS.has(segment.toLowerCase()) || SECRET_NAME.test(segment))) {
    throw new Error("repository path is not readable");
  }
  return segments.join("/");
}

async function canonicalRoot(repositoryPath: string): Promise<string> {
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0 || repositoryPath.includes("\0")) throw new Error("invalid repository path");
  const canonical = await realpath(repositoryPath);
  const rootStat = await stat(canonical);
  if (!rootStat.isDirectory()) throw new Error("repository root must be a directory");
  return canonical;
}

async function resolveRegularFile(root: string, inputPath: string): Promise<{ absolute: string; size: number }> {
  const safePath = assertAllowedPath(inputPath);
  const segments = safePath.split("/");
  let current = root;
  let canonicalFile = current;
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current, segments[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("symbolic links are not readable");
    const isLast = index === segments.length - 1;
    if (!isLast && !info.isDirectory()) throw new Error("repository path parent is not a directory");
    if (isLast && !info.isFile()) throw new Error("repository path is not a regular file");
    const resolved = await realpath(current);
    assertInsideRoot(root, resolved);
    canonicalFile = resolved;
    if (isLast && info.size > MAX_FILE_BYTES) throw new Error("repository file exceeds the read size limit");
  }
  const info = await stat(current);
  return { absolute: canonicalFile, size: info.size };
}

function decodeUtf8Chunk(bytes: Buffer, requestedOffset: number, maxBytes: number): { content: string; offset: number; bytes: number } {
  let start = 0;
  // A byte offset can land inside a multi-byte code point. Advance to the next leading byte.
  while (requestedOffset > 0 && start < bytes.length && (bytes[start]! & 0xc0) === 0x80 && start < 3) start++;
  if (start === bytes.length && start <= 3) return { content: "", offset: requestedOffset + start, bytes: 0 };
  const candidate = bytes.subarray(start, Math.min(bytes.length, start + maxBytes));
  for (let trim = 0; trim <= 3 && trim <= candidate.length; trim++) {
    try {
      const valid = candidate.subarray(0, candidate.length - trim);
      const content = new TextDecoder("utf-8", { fatal: true }).decode(valid);
      return { content, offset: requestedOffset + start, bytes: valid.length };
    } catch {
      // Only incomplete trailing code points may be trimmed; malformed interior bytes still fail.
    }
  }
  throw new Error("file is not valid UTF-8 text");
}

async function readText(root: string, path: string, offset: number, limit: number): Promise<JsonValue> {
  const target = await resolveRegularFile(root, path);
  // O_NONBLOCK prevents a path replacement with a FIFO from hanging this process; O_NOFOLLOW
  // closes the final-component symlink race on platforms that provide it.
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
  const handle = await open(target.absolute, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw new Error("repository path is not a bounded regular file");
    const requested = Math.min(limit + 3, Math.max(0, opened.size - offset));
    const buffer = Buffer.alloc(requested);
    const { bytesRead } = requested === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, requested, offset);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new Error("binary files are not readable");
    const decoded = decodeUtf8Chunk(bytes, offset, limit);
    return { op: "read", path, offset: decoded.offset, requestedOffset: offset, bytes: decoded.bytes, content: decoded.content, truncated: decoded.offset + decoded.bytes < opened.size };
  } finally {
    await handle.close();
  }
}

async function listDirectory(root: string, inputPath: string, limit: number, cursor: number | undefined): Promise<JsonValue> {
  const path = assertAllowedPath(inputPath, true);
  let directory = root;
  if (path !== ".") {
    const segments = path.split("/");
    for (const segment of segments) {
      directory = resolve(directory, segment);
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("repository directory is not readable");
      const resolved = await realpath(directory);
      assertInsideRoot(root, resolved);
    }
  }
  const entries: Array<{ name: string; type: "file" | "directory" }> = [];
  let scanned = 0;
  let rawIndex = 0;
  let more = false;
  const startAt = cursor ?? 0;
  const dir = await opendir(directory);
  try {
    for await (const entry of dir) {
      const entryIndex = rawIndex++;
      if (entryIndex < startAt) continue;
      scanned++;
      if (scanned > MAX_DIRECTORY_SCAN) { more = true; rawIndex--; break; }
      if (EXCLUDED_SEGMENTS.has(entry.name.toLowerCase()) || SECRET_NAME.test(entry.name) || entry.isSymbolicLink()) continue;
      if (entry.isFile() || entry.isDirectory()) {
        if (entries.length < limit) entries.push({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" });
        else { more = true; rawIndex--; break; }
      }
    }
  } finally {
    await dir.close().catch(() => undefined);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const nextCursor = more ? rawIndex : undefined;
  return { op: "list", path, entries, truncated: more, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    SYSTEMROOT: process.env.SYSTEMROOT,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_NO_REPLACE_OBJECTS: "1"
  };
  return env;
}

async function runGit(root: string, args: string[], maxBuffer = MAX_GIT_OUTPUT): Promise<string> {
  const config = [
    "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.pager=cat",
    "-c", "color.ui=false", "-c", "diff.external=", "-c", "diff.trustExitCode=false", "-c", "core.hooksPath=/dev/null"
  ];
  const result = await execFileAsync("git", [...config, ...args], {
    cwd: root, env: safeGitEnvironment(), encoding: "utf8", timeout: MAX_GIT_TIMEOUT_MS,
    maxBuffer, windowsHide: true
  });
  return result.stdout;
}

async function readMetadataFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("invalid Git worktree metadata file");
  return readFile(path, "utf8");
}

async function validateGitMetadata(root: string): Promise<void> {
  const dotGit = resolve(root, ".git");
  const entry = await lstat(dotGit).catch(() => undefined);
  if (!entry || entry.isSymbolicLink()) throw new Error("Git metadata must be a directory or a validated worktree gitfile");
  let linked = false;
  let expectedGitDir: string;
  if (entry.isDirectory()) {
    expectedGitDir = await realpath(dotGit);
  } else if (entry.isFile()) {
    const contents = await readMetadataFile(dotGit);
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(contents);
    if (!match) throw new Error("invalid Git worktree gitfile");
    expectedGitDir = await realpath(resolve(root, match[1]!));
    linked = true;
  } else {
    throw new Error("invalid Git metadata entry");
  }

  const actualGitDir = await realpath((await runGit(root, ["rev-parse", "--absolute-git-dir"])).trim());
  if (actualGitDir !== expectedGitDir || !(await stat(actualGitDir)).isDirectory()) throw new Error("Git gitdir does not match canonical metadata");
  const actualCommonDir = await realpath(resolve(root, (await runGit(root, ["rev-parse", "--git-common-dir"])).trim()));
  if (!(await stat(actualCommonDir)).isDirectory()) throw new Error("Git common directory is invalid");
  if (linked) {
    const commonValue = (await readMetadataFile(resolve(actualGitDir, "commondir"))).trim();
    const declaredCommonDir = await realpath(resolve(actualGitDir, commonValue));
    if (declaredCommonDir !== actualCommonDir) throw new Error("Git worktree common-dir metadata does not match");
    const backPointer = (await readMetadataFile(resolve(actualGitDir, "gitdir"))).trim();
    const declaredGitFile = await realpath(resolve(actualGitDir, backPointer));
    if (declaredGitFile !== await realpath(dotGit)) throw new Error("Git worktree gitdir back-pointer does not match");
  } else if (actualCommonDir !== expectedGitDir) {
    throw new Error("Git common directory does not match repository metadata");
  }
  const actualWorktree = await realpath((await runGit(root, ["rev-parse", "--show-toplevel"])).trim());
  if (actualWorktree !== root) throw new Error("Git worktree does not match repository root");
}

async function assertNoConfiguredFilters(root: string): Promise<void> {
  // Git may run a configured clean/process filter while computing status or diff, even
  // when the requested output contains only names. Until filters can be disabled
  // portably for every attribute driver, fail closed before any working-tree comparison.
  const keys = await runGit(root, ["config", "--includes", "--name-only", "--list"]);
  if (keys.split(/\r?\n/).some(key => /^filter\..+\.(?:clean|smudge|process)$/i.test(key))) {
    throw new Error("Git reads are unsupported while repository filters are configured");
  }
}

function privateGitPath(path: string): boolean {
  return path.split(/[\\/]/).some(segment => EXCLUDED_SEGMENTS.has(segment.toLowerCase()) || SECRET_NAME.test(segment));
}

async function gitRead(root: string, action: "status" | "log" | "head" | "files" | "diff", limit: number): Promise<JsonValue> {
  await validateGitMetadata(root);
  if (action === "status" || action === "diff") await assertNoConfiguredFilters(root);
  let output: string;
  switch (action) {
    case "status": {
      const raw = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], MAX_GIT_OUTPUT);
      const paths: string[] = [];
      const records = raw.split("\0").filter(Boolean);
      for (let index = 0; index < records.length; index++) {
        const record = records[index]!;
        const path = record.slice(3);
        const renamedFrom = record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C" ? records[++index] : undefined;
        if (!privateGitPath(path) && (!renamedFrom || !privateGitPath(renamedFrom))) {
          paths.push(`${record.slice(0, 2)} ${JSON.stringify(path)}${renamedFrom ? ` <- ${JSON.stringify(renamedFrom)}` : ""}`);
        }
      }
      output = paths.slice(0, limit).join("\n");
      break;
    }
    case "log":
      output = await runGit(root, ["log", `-${limit}`, "--format=%h %s", "--no-show-signature", "--no-decorate"]);
      break;
    case "head":
      output = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
      break;
    case "files": {
      const raw = await runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], MAX_GIT_OUTPUT);
      output = raw.split("\0").filter(path => path && !privateGitPath(path)).slice(0, limit).map(path => JSON.stringify(path)).join("\n");
      break;
    }
    case "diff":
      // Names and change states only: never expose file contents, external diff drivers,
      // textconv output, or sensitive path names.
      {
        const raw = await runGit(root, ["diff", "--name-status", "-z", "--no-ext-diff", "--no-textconv", "--"]);
        const fields = raw.split("\0").filter(Boolean);
        const rows: string[] = [];
        for (let index = 0; index < fields.length;) {
          const status = fields[index++]!;
          const firstPath = fields[index++] ?? "";
          let secondPath: string | undefined;
          if (/^[RC]/.test(status)) secondPath = fields[index++];
          if (!privateGitPath(firstPath) && (!secondPath || !privateGitPath(secondPath))) {
            rows.push(`${status} ${JSON.stringify(firstPath)}${secondPath ? ` -> ${JSON.stringify(secondPath)}` : ""}`);
          }
        }
        output = rows.slice(0, limit).join("\n");
      }
      break;
  }
  return { op: "git", action, output: output.slice(0, MAX_GIT_OUTPUT).trimEnd() };
}

/** A bounded, read-only view of repository text, directory names, and fixed Git summaries. */
export async function repositoryRead(repositoryPath: string, input: unknown): Promise<JsonValue> {
  const parsed: ReaderInput = RepositoryReadInputSchema.parse(input);
  const root = await canonicalRoot(repositoryPath);
  switch (parsed.op) {
    case "read": return readText(root, parsed.path, parsed.offset, parsed.limit);
    case "list": return listDirectory(root, parsed.path, parsed.limit, parsed.cursor);
    case "git": return gitRead(root, parsed.action, parsed.limit);
  }
}
