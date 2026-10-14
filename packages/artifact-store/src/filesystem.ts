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
    const path = this.file(name);
    // Reject special files before opening them; O_NONBLOCK also closes the FIFO replacement window.
    const before = create ? undefined : await lstat(path);
    if (before !== undefined && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) fail("corruption", "Artifact object is not a private regular file");
    const handle = await open(path, create
      ? constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const info = await handle.stat();
      const current = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
        current.dev !== info.dev || current.ino !== info.ino ||
        before !== undefined && (before.dev !== info.dev || before.ino !== info.ino)) fail("corruption", "Artifact file identity changed or is not regular");
      return handle;
    } catch (error) { await handle.close(); throw error; }
  }
  async sync(): Promise<void> {
    await this.check();
    const directory = await open(this.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
