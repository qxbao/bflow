import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "smol-toml";

export type CodexTrustResult = "already_trusted" | "trusted" | "skipped";

const LOCK_RETRY_LIMIT = 240;
const CAS_RETRY_LIMIT = 6;
const STALE_LOCK_MS = 10_000;
const DEAD_PID_GRACE_MS = 500;
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

function tomlBasicString(value: string): string {
  return JSON.stringify(value).replace(/\x7f/g, "\\u007f");
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function withTrustLock<T>(configFile: string, action: () => Promise<T>): Promise<T | "skipped"> {
  return withInProcessTrustQueue(resolve(configFile), async () => {
    const lockPath = `${configFile}.bflow-trust.lock`;
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

async function readCurrentConfig(configFile: string): Promise<
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly text: string; readonly digest: string; readonly mode: number }
  | { readonly kind: "invalid" }
> {
  try {
    const info = await lstat(configFile);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return { kind: "invalid" };
    const mode = info.mode & 0o777;
    const handle = await open(configFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let text = "";
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > 4 * 1024 * 1024) return { kind: "invalid" };
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

function candidatePathKeys(targetPath: string): readonly string[] {
  const resolved = resolve(targetPath);
  const withoutTrailing = resolved.replace(/\/+$/, "");
  const withTrailing = `${withoutTrailing}/`;
  return [withoutTrailing, withTrailing];
}

/**
 * Records the "Trust this folder?" answer Codex would otherwise ask for in each headless pane.
 * Callers must hold an explicit repository opt-in (`environment.permissions.trustedWorkspace: true`).
 * The user's file is never rewritten: only a `[projects."<root>"] trust_level = "trusted"` table is
 * appended, the result is re-parsed before an atomic replace, and an existing decision (including
 * "untrusted"), an unreadable/unparsable file or a missing Codex home is left alone.
 */
export async function ensureCodexWorkspaceTrust(workspaceRoot: string, configFile: string): Promise<CodexTrustResult> {
  try {
    const home = await lstat(dirname(configFile));
    if (!home.isDirectory()) return "skipped";
  } catch {
    return "skipped";
  }

  return withTrustLock(configFile, async (): Promise<CodexTrustResult> => {
    for (let casAttempt = 0; casAttempt < CAS_RETRY_LIMIT; casAttempt++) {
      const snapshot = await readCurrentConfig(configFile);
      if (snapshot.kind === "invalid") return "skipped";
      const text = snapshot.kind === "present" ? snapshot.text : "";
      const mode = snapshot.kind === "present" ? snapshot.mode : 0o600;

      let parsed: Record<string, unknown>;
      try {
        parsed = parse(text) as Record<string, unknown>;
      } catch {
        return "skipped";
      }
      const projects = parsed["projects"];
      if (projects !== undefined && record(projects) === undefined) return "skipped";
      const existingKey = candidatePathKeys(workspaceRoot).find(k => record(projects)?.[k] !== undefined);
      if (existingKey !== undefined) {
        const current = record(projects)?.[existingKey];
        return record(current)?.["trust_level"] === "trusted" ? "already_trusted" : "skipped";
      }

      // Escape DEL (U+007F) in addition to JSON escapes so any valid POSIX path forms a legal TOML 1.0 basic string.
      const normalizedRoot = resolve(workspaceRoot);
      const next = `${text}${text.length && !text.endsWith("\n") ? "\n" : ""}${text.length ? "\n" : ""}[projects.${tomlBasicString(normalizedRoot)}]\ntrust_level = "trusted"\n`;
      try {
        const check = record(record(parse(next) as Record<string, unknown>)?.["projects"])?.[normalizedRoot];
        if (record(check)?.["trust_level"] !== "trusted") return "skipped";
      } catch {
        return "skipped";
      }

      const temporary = `${configFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          mode
        );
        try {
          await handle.writeFile(next, "utf8");
          await safeFileSync(handle);
        } finally {
          await handle.close();
        }
        await chmod(temporary, mode);

        // Full content-digest check (never byte-size alone, which misses equal-length sibling worktree updates).
        const latest = await readCurrentConfig(configFile);
        const unchanged =
          (snapshot.kind === "missing" && latest.kind === "missing") ||
          (snapshot.kind === "present" && latest.kind === "present" && latest.digest === snapshot.digest);
        if (!unchanged) {
          await rm(temporary, { force: true });
          if (latest.kind === "invalid") return "skipped";
          continue;
        }

        await rename(temporary, configFile);
        await safeDirectorySync(dirname(configFile));
        return "trusted";
      } catch {
        await rm(temporary, { force: true });
        return "skipped";
      }
    }
    return "skipped";
  });
}

export async function isCodexWorkspaceTrusted(workspaceRoot: string, configFile: string): Promise<boolean> {
  const snapshot = await readCurrentConfig(configFile);
  if (snapshot.kind !== "present") return false;
  try {
    const parsed = parse(snapshot.text) as Record<string, unknown>;
    const projects = record(parsed["projects"]);
    if (!projects) return false;
    const candidates = [
      ...candidatePathKeys(workspaceRoot),
      ...candidatePathKeys(resolve(workspaceRoot))
    ];
    const canonical = await realpath(workspaceRoot).catch(() => undefined);
    if (canonical !== undefined) candidates.push(...candidatePathKeys(canonical));
    return candidates.some(key => record(projects[key])?.["trust_level"] === "trusted");
  } catch {
    return false;
  }
}

async function hasExplicitNonTrustedCodexEntry(paths: readonly string[], configFile: string): Promise<boolean> {
  const snapshot = await readCurrentConfig(configFile);
  if (snapshot.kind !== "present") return false;
  try {
    const parsed = parse(snapshot.text) as Record<string, unknown>;
    const projects = record(parsed["projects"]);
    if (!projects) return false;
    return paths.some(path => {
      const entry = projects[path];
      return entry !== undefined && record(entry)?.["trust_level"] !== "trusted";
    });
  } catch {
    return true;
  }
}

/**
 * Propagates repository workspace trust to a dynamic task worktree in `native_auth_compatible` or
 * `ai-isolator` Codex homes, strictly when `workspaceRoot` was already trusted in that exact `config.toml`.
 * Never grants trust when the repository root itself is untrusted or absent.
 */
export async function propagateCodexWorktreeTrustIfRootTrusted(options: {
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  readonly configFile: string;
}): Promise<CodexTrustResult> {
  const root = resolve(options.workspaceRoot);
  const worktree = resolve(options.worktreePath);
  if (candidatePathKeys(worktree).some(k => candidatePathKeys(root).includes(k))) {
    return (await isCodexWorkspaceTrusted(options.workspaceRoot, options.configFile))
      ? "already_trusted"
      : "skipped";
  }
  if (!(await isCodexWorkspaceTrusted(options.workspaceRoot, options.configFile))) {
    return "skipped";
  }
  const canonicalWorktree = await realpath(worktree).catch(() => undefined);
  const candidatePaths =
    canonicalWorktree !== undefined && canonicalWorktree !== worktree
      ? [worktree, canonicalWorktree]
      : [worktree];
  if (await hasExplicitNonTrustedCodexEntry(candidatePaths, options.configFile)) {
    return "skipped";
  }
  const primary = await ensureCodexWorkspaceTrust(worktree, options.configFile);
  if (primary === "skipped") {
    return "skipped";
  }
  if (canonicalWorktree !== undefined && canonicalWorktree !== worktree) {
    const secondary = await ensureCodexWorkspaceTrust(canonicalWorktree, options.configFile);
    if (secondary === "skipped") return "skipped";
    if (primary === "trusted" || secondary === "trusted") return "trusted";
  }
  return primary;
}
