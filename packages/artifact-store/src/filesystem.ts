import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fail } from "./support.js";

/** Root is configured by the operator, never taken from an artifact URI. */
export class SafeRoot {
  private constructor(readonly path: string, private readonly dev: number, private readonly ino: number) {}
  static async create(path: string): Promise<SafeRoot> {
    const absolute = resolve(path);
    // Validate the existing ancestor before recursive mkdir, so even initialization cannot follow a symlink escape.
    let ancestor = absolute;
    while (true) {
      try {
        const info = await lstat(ancestor);
        if (!info.isDirectory() || info.isSymbolicLink() || await realpath(ancestor) !== ancestor) fail("validation", "Artifact root ancestor is not canonical");
        break;
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
        ancestor = dirname(ancestor);
      }
    }
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || await realpath(absolute) !== absolute) fail("validation", "Artifact root must be canonical and not writable by other users");
    return new SafeRoot(absolute, info.dev, info.ino);
  }
  async check(): Promise<void> {
    const info = await lstat(this.path);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0 || info.dev !== this.dev || info.ino !== this.ino ||
      await realpath(this.path) !== this.path) fail("corruption", "Artifact root identity changed");
    for (const name of ["catalog.sqlite", "catalog.sqlite-wal", "catalog.sqlite-shm", "catalog.sqlite-journal"]) {
      try {
        const file = await lstat(this.file(name));
        if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) fail("corruption", "Unsafe artifact catalog path");
      } catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
    }
  }
  file(name: string): string {
    if (!/^(?:catalog\.sqlite(?:-(?:wal|shm|journal))?|(?:stage|blob|read)-[a-f0-9-]{36})$/.test(name)) fail("corruption", "Unsafe internal artifact path");
    return join(this.path, name);
  }
  async open(name: string, create = false): Promise<FileHandle> {
    await this.check();
    const handle = await open(this.file(name), create ? constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW : constants.O_RDONLY | constants.O_NOFOLLOW, 0o600);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) { await handle.close(); fail("corruption", "Artifact object is not a private regular file"); }
    return handle;
  }
  async sync(): Promise<void> {
    await this.check();
    const directory = await open(this.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
