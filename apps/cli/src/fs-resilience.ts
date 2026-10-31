import { randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink } from "node:fs/promises";
import { hostname } from "node:os";

const FSYNC_TOLERATED_CODES: ReadonlySet<string> = new Set([
  "EINVAL",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EPERM",
  "EACCES",
  "EBADF",
  "EISDIR",
  "EROFS"
]);

/**
 * Flushes a FileHandle to storage when supported by the underlying filesystem.
 * FUSE/NTFS (`fuseblk`), overlayfs, and WSL DrvFs mounts reject `fsync` with
 * `EINVAL`/`ENOTSUP`/`EPERM` even after bytes are written; genuine I/O failures
 * (`EIO`, `ENOSPC`, etc.) still fail closed.
 */
export async function fsyncTolerant(handle: { sync(): Promise<void> }): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (typeof code === "string" && FSYNC_TOLERATED_CODES.has(code)) return;
    throw error;
  }
}

export async function isRecycledNonNodePid(pid: number): Promise<boolean> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
    if (!raw) return false;
    const argv0 = (raw.split("\0")[0] ?? "").toLowerCase();
    if (!argv0) return false;
    return !argv0.includes("node") && !argv0.includes("bflow") && !argv0.includes("vitest");
  } catch {
    return false;
  }
}

export async function isDeadOrRecycledNodePid(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    return false;
  }
  return isRecycledNonNodePid(pid);
}

export const STALE_INCOMPLETE_LOCK_MS = 10_000;

/**
 * Reclaims a file-based lock only when:
 * 1. It contains a JSON record whose `pid` is dead (`ESRCH`) or recycled on Linux to a non-Node/non-Bflow process
 *    (and, if `host` is recorded, matches the local `hostname()`), OR
 * 2. It is a 0-byte or unparseable crash remnant whose `mtimeMs` is older than `incompleteGraceMs` (default 10s).
 *
 * Uses atomic rename-aside before unlink so concurrent waiters cannot delete a newly-acquired lock.
 */
export async function reclaimStaleLockFile(
  lockPath: string,
  options: { readonly incompleteGraceMs?: number; readonly checkHost?: boolean } = {}
): Promise<boolean> {
  const graceMs = options.incompleteGraceMs ?? STALE_INCOMPLETE_LOCK_MS;
  let rawText: string;
  try {
    rawText = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }

  let reclaimable = false;
  let parsedRecord: Record<string, unknown> | null = null;
  if (rawText.trim().length > 0) {
    try {
      const candidate: unknown = JSON.parse(rawText);
      if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsedRecord = candidate as Record<string, unknown>;
      }
    } catch {
      parsedRecord = null;
    }
  }

  if (parsedRecord !== null && typeof parsedRecord.pid === "number") {
    const sameHost =
      options.checkHost === false ||
      typeof parsedRecord.host !== "string" ||
      parsedRecord.host === hostname();
    if (sameHost && (await isDeadOrRecycledNodePid(parsedRecord.pid))) {
      reclaimable = true;
    }
  } else {
    try {
      const info = await stat(lockPath);
      if (Date.now() - info.mtimeMs >= graceMs) {
        reclaimable = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    }
  }

  if (!reclaimable) return false;
  const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
    await unlink(stalePath).catch(() => undefined);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}
