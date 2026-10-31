import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "smol-toml";

export type CodexTrustResult = "already_trusted" | "trusted" | "skipped";

const LOCK_RETRY_LIMIT = 80;
const CAS_RETRY_LIMIT = 6;
const STALE_LOCK_MS = 10_000;
const DEAD_PID_GRACE_MS = 500;

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
      const handle = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw = "";
      try { raw = await handle.readFile("utf8"); } finally { await handle.close(); }
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

async function withTrustLock<T>(configFile: string, action: () => Promise<T>): Promise<T | "skipped"> {
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
      await sleep(5 + Math.min(25, attempt * 2));
    }
  }
  if (!acquired) return "skipped";
  try {
    return await action();
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
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
    const handle = await open(configFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text = "";
    try { text = await handle.readFile("utf8"); } finally { await handle.close(); }
    return { kind: "present", text, digest: sha256(text), mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
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
      const current = record(projects)?.[workspaceRoot];
      if (current !== undefined) {
        return record(current)?.["trust_level"] === "trusted" ? "already_trusted" : "skipped";
      }

      // JSON string escaping is a valid TOML basic string for a path key.
      const next = `${text}${text.length && !text.endsWith("\n") ? "\n" : ""}${text.length ? "\n" : ""}[projects.${JSON.stringify(workspaceRoot)}]\ntrust_level = "trusted"\n`;
      try {
        const check = record(record(parse(next) as Record<string, unknown>)?.["projects"])?.[workspaceRoot];
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
          await handle.sync();
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
        return "trusted";
      } catch {
        await rm(temporary, { force: true });
        return "skipped";
      }
    }
    return "skipped";
  });
}
