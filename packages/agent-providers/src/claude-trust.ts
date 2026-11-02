import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export type ClaudeTrustResult = "already_trusted" | "trusted" | "skipped";

const LOCK_RETRY_LIMIT = 240;
const CAS_RETRY_LIMIT = 6;
const STALE_LOCK_MS = 10_000;
const DEAD_PID_GRACE_MS = 500;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const inProcessTrustQueues = new Map<string, Promise<unknown>>();
const BENIGN_FILE_SYNC_CODES = new Set([
  "EINVAL",
  "ENOSYS",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EROFS",
  "EPERM",
  "EACCES"
]);
const BENIGN_DIR_SYNC_CODES = new Set([...BENIGN_FILE_SYNC_CODES, "EISDIR", "EBADF"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function safeFileSync(handle: { sync: () => Promise<void> }): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!code || !BENIGN_FILE_SYNC_CODES.has(code)) throw error;
  }
}

async function safeDirectorySync(dirPath: string): Promise<void> {
  let handle;
  try {
    handle = await open(dirPath, constants.O_RDONLY);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code && BENIGN_DIR_SYNC_CODES.has(code)) return;
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (!code || !BENIGN_DIR_SYNC_CODES.has(code)) throw error;
  } finally {
    await handle.close();
  }
}

async function tryBreakStaleLock(lockPath: string): Promise<boolean> {
  try {
    const info = await lstat(lockPath);
    if (!info.isFile()) return false;
    const ageMs = Date.now() - info.mtimeMs;
    if (ageMs > STALE_LOCK_MS) {
      await rm(lockPath, { force: true });
      return true;
    }
    if (ageMs > DEAD_PID_GRACE_MS) {
      const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw = "";
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > 4096) return false;
        raw = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
        await rm(lockPath, { force: true });
        return true;
      }
    }
  } catch {
    // Best-effort stale lock inspection only.
  }
  return false;
}

async function withInProcessTrustQueue<T>(key: string, action: () => Promise<T>): Promise<T> {
  const prev = inProcessTrustQueues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(action);
  inProcessTrustQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (inProcessTrustQueues.get(key) === next) {
      inProcessTrustQueues.delete(key);
    }
  }
}

async function withTrustLock<T>(stateFile: string, action: () => Promise<T>): Promise<T | "skipped"> {
  return withInProcessTrustQueue(resolve(stateFile), async () => {
    const lockPath = `${stateFile}.bflow-trust.lock`;
    let acquired = false;
    for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
      try {
        const handle = await open(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        );
        try {
          await handle.writeFile(`${process.pid}\n`, "utf8");
        } finally {
          await handle.close();
        }
        acquired = true;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") return "skipped";
        if (await tryBreakStaleLock(lockPath)) continue;
        await sleep(5 + Math.min(25, attempt * 2) + Math.floor(Math.random() * 7));
      }
    }
    if (!acquired) return "skipped";
    try {
      return await action();
    } finally {
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  });
}

async function readCurrentStateFile(stateFile: string): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly text: string; readonly digest: string; readonly mode: number }
  | { readonly kind: "invalid" }
> {
  try {
    const info = await lstat(stateFile);
    if (!info.isFile() || info.size > MAX_STATE_BYTES) return { kind: "invalid" };
    const mode = info.mode & 0o777;
    const handle = await open(stateFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text = "";
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_STATE_BYTES) return { kind: "invalid" };
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    return { kind: "present", text, digest: sha256(text), mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
}

/** Candidate Claude state files (`~/.claude.json`, `~/.claude/.claude.json`, `CLAUDE_CONFIG_DIR/.claude.json`, `ORCA_CLAUDE_CONFIG_DIR/.claude.json`). */
export function resolveClaudeTrustStateFiles(
  env: Readonly<Record<string, string | undefined>>
): readonly string[] {
  const candidates: string[] = [];
  const orcaDir = env["ORCA_CLAUDE_CONFIG_DIR"]?.trim();
  const configDir = env["CLAUDE_CONFIG_DIR"]?.trim();
  const homeDir = env["HOME"]?.trim();
  if (orcaDir) candidates.push(join(resolve(orcaDir), ".claude.json"));
  if (configDir) candidates.push(join(resolve(configDir), ".claude.json"));
  if (homeDir) {
    const canonicalHome = resolve(homeDir);
    candidates.push(join(canonicalHome, ".claude.json"));
    candidates.push(join(canonicalHome, ".claude", ".claude.json"));
  }
  return [...new Set(candidates)];
}

function candidatePathKeys(targetPath: string): readonly string[] {
  const resolved = resolve(targetPath);
  const withoutTrailing = resolved.replace(/\/+$/, "");
  const withTrailing = `${withoutTrailing}/`;
  return [withoutTrailing, withTrailing];
}

async function propagateTrustInSingleFile(
  workspaceRoot: string,
  worktreePath: string,
  stateFile: string
): Promise<ClaudeTrustResult> {
  const rootCanonical = resolve(workspaceRoot);
  const worktreeCanonical = resolve(worktreePath);
  const rootReal = await realpath(workspaceRoot).catch(() => undefined);
  const worktreeReal = await realpath(worktreePath).catch(() => undefined);

  return withTrustLock(stateFile, async (): Promise<ClaudeTrustResult> => {
    for (let casAttempt = 0; casAttempt < CAS_RETRY_LIMIT; casAttempt++) {
      const snapshot = await readCurrentStateFile(stateFile);
      if (snapshot.kind !== "present") return "skipped";

      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = record(JSON.parse(snapshot.text));
      } catch {
        return "skipped";
      }
      if (!parsed) return "skipped";

      const projects = record(parsed["projects"]);
      if (!projects) return "skipped";

      const rootCandidates = [
        ...candidatePathKeys(workspaceRoot),
        ...candidatePathKeys(rootCanonical),
        ...(rootReal !== undefined ? candidatePathKeys(rootReal) : [])
      ];
      const rootTrusted = rootCandidates.some(
        key => record(projects[key])?.["hasTrustDialogAccepted"] === true
      );
      if (!rootTrusted) return "skipped";

      if (candidatePathKeys(worktreeCanonical).some(k => rootCandidates.includes(k))) return "already_trusted";

      const candidateTargets = [
        ...candidatePathKeys(worktreeCanonical),
        ...(worktreeReal !== undefined ? candidatePathKeys(worktreeReal) : [])
      ];

      for (const key of candidateTargets) {
        if (record(projects[key])?.["hasTrustDialogAccepted"] === false) {
          return "skipped";
        }
      }
      if (candidateTargets.some(key => record(projects[key])?.["hasTrustDialogAccepted"] === true)) {
        return "already_trusted";
      }

      const nextProjects: Record<string, unknown> = { ...projects };
      const targetKeys =
        worktreeReal !== undefined && worktreeReal !== worktreeCanonical
          ? [worktreeCanonical, worktreeReal]
          : [worktreeCanonical];
      for (const key of targetKeys) {
        const existingEntry = record(projects[key]);
        nextProjects[key] = {
          ...(existingEntry ?? {}),
          hasTrustDialogAccepted: true
        };
      }
      const nextText = `${JSON.stringify({ ...parsed, projects: nextProjects }, null, 2)}\n`;
      const mode = snapshot.mode || 0o600;
      const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          mode
        );
        try {
          await handle.writeFile(nextText, "utf8");
          await safeFileSync(handle);
        } finally {
          await handle.close();
        }
        await chmod(temporary, mode);

        const latest = await readCurrentStateFile(stateFile);
        if (latest.kind !== "present" || latest.digest !== snapshot.digest) {
          await rm(temporary, { force: true });
          if (latest.kind !== "present") return "skipped";
          continue;
        }

        await rename(temporary, stateFile);
        await safeDirectorySync(dirname(stateFile));
        return "trusted";
      } catch {
        await rm(temporary, { force: true });
        return "skipped";
      }
    }
    return "skipped";
  });
}

/**
 * Propagates Claude Code workspace trust to a dynamic task worktree across active Claude `.claude.json`
 * files (`CLAUDE_CONFIG_DIR`, `ORCA_CLAUDE_CONFIG_DIR`, `~/.claude.json`, `~/.claude/.claude.json`),
 * strictly for files where `workspaceRoot` ALREADY has `hasTrustDialogAccepted: true`.
 */
export async function propagateClaudeWorktreeTrustIfRootTrusted(options: {
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<ClaudeTrustResult> {
  const files = resolveClaudeTrustStateFiles(options.env);
  let outcome: ClaudeTrustResult = "skipped";
  for (const file of files) {
    const res = await propagateTrustInSingleFile(options.workspaceRoot, options.worktreePath, file);
    if (res === "trusted") {
      outcome = "trusted";
    } else if (res === "already_trusted" && outcome === "skipped") {
      outcome = "already_trusted";
    }
  }
  return outcome;
}
