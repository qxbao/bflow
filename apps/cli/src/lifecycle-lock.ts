import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { FileHandle } from "node:fs/promises";

// A callback awaiting an unresolved promise can otherwise lose its async frame
// to GC. Keep the kernel authority alive until explicit close/process death.
const activeGuards = new Set<FileHandle>();

/** Keep the guard inode permanently. The kernel releases flock on Ctrl+C,
 * SIGKILL and crashes; a diagnostic owner file never decides lock ownership. */
export async function withLifecycleLock<T>(directory: string, operation: () => Promise<T>, repairLegacy = false): Promise<T> {
  let ancestor = resolve(directory);
  while (true) {
    try { if (await realpath(ancestor) !== ancestor) throw new Error("Lifecycle state must not traverse symlinks"); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(join(directory, "lifecycle.guard"), constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  activeGuards.add(file);
  let acquired = false;
  let ownerWritten = false;
  try {
    const guard = await file.stat();
    if (!guard.isFile() || guard.nlink !== 1) throw new Error("Lifecycle guard must be a single regular file");
    acquired = await new Promise<boolean>((accept, reject) => {
      const child = spawn("flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", file.fd] });
      child.once("error", reject); child.once("exit", code => accept(code === 0));
    });
    if (!acquired) throw new Error("Another bflow up/down/recover is still running. Wait for it or interrupt that command; the lock releases when its process exits. Run bflow status for session state.");
    const legacy = join(directory, "lifecycle.lock");
    try {
      const stat = await lstat(legacy);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unexpected legacy lifecycle.lock; preserve it and inspect bflow doctor.");
      if (!repairLegacy) throw new Error("A legacy lifecycle lock remains from an older Bflow. Stop any old up/down command, then run bflow recover --yes. This removes only an empty legacy lock; do not delete .bflow.");
      // Explicit migration only. Never recursively delete unknown lock contents.
      await rmdir(legacy);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const owner = await open(join(directory, "lifecycle-owner.json"), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await owner.stat(); if (!stat.isFile() || stat.nlink !== 1) throw new Error("Lifecycle owner receipt must be a single regular file");
      await owner.truncate(0); await owner.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await owner.sync(); ownerWritten = true;
    } finally { await owner.close(); }
    return await operation();
  } finally {
    if (ownerWritten) await unlink(join(directory, "lifecycle-owner.json")).catch(() => undefined);
    await file.close();
    activeGuards.delete(file);
  }
}

export async function lifecycleLockStatus(directory: string): Promise<string> {
  try { await lstat(join(directory, "lifecycle.lock")); return "Legacy lifecycle lock: stop old commands, then bflow recover --yes; preserve .bflow data."; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let file;
  try { file = await open(join(directory, "lifecycle.guard"), constants.O_RDWR | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "No lifecycle operation lock"; throw error; }
  try {
    const free = await new Promise<boolean>((accept, reject) => {
      const child = spawn("flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", file.fd] });
      child.once("error", reject); child.once("exit", code => accept(code === 0));
    });
    if (free) return "No active lifecycle operation (kernel lock is free)";
    return "Lifecycle operation is active; wait for that command to finish.";
  } finally { await file.close(); }
}
