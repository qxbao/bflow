import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { x as extractTar } from "tar";

export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Refuse links/special files before reading configuration or executable source. */
export async function readRegular(path: string, limit = 2_000_000): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > limit) throw new Error(`Not a bounded regular file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev || current.size > limit)
      throw new Error("File changed while opening");
    const value = await handle.readFile("utf8");
    if (Buffer.byteLength(value) > limit) throw new Error("File exceeded read limit");
    return value;
  } finally { await handle.close(); }
}

export async function noLinksBelow(root: string, path: string): Promise<void> {
  const suffix = relative(root, path);
  if (!suffix || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error("Path escaped its managed root");
  let cursor = root;
  for (const part of suffix.split(sep)) {
    cursor = join(cursor, part);
    try { const info = await lstat(cursor); if (info.isSymbolicLink() || (!info.isDirectory() && cursor !== path)) throw new Error("Path traverses a link or non-directory"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Managed directory must be absolute");
  await mkdir(path, { recursive: true, mode: 0o700 });
  return existingPrivateDirectory(path);
}

/** Observe an existing managed directory without creating or repairing it. */
export async function existingPrivateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Managed directory must be absolute");
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Managed directory must not be a link");
  return realpath(path);
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

/** Canonical content inventory. Links, special files and unbounded bundles are rejected. */
export async function treeDigest(root: string): Promise<string> {
  const inventory: Array<[string, string]> = [];
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === ".git" || name === "node_modules") continue;
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > 100_000_000 || inventory.length >= 10_000) throw new Error("Bundle exceeds inventory limit");
        inventory.push([relative(root, path).split(sep).join("/"), await fileDigest(path)]);
      } else throw new Error("Bundle contains a link or special file");
    }
  };
  await existingPrivateDirectory(root);
  await walk(root);
  return sha256(JSON.stringify(inventory));
}

/** Extract into an empty private staging directory; never accept archive links or traversal. */
export async function extractPinnedArchive(artifact: string, target: string): Promise<string> {
  await mkdir(target, { mode: 0o700 });
  let count = 0, bytes = 0;
  await extractTar({ file: artifact, cwd: target, strict: true, preservePaths: false,
    filter(path, entry) {
      const parts = path.replace(/\/$/, "").split("/");
      if (isAbsolute(path) || path.includes("\\") || parts.some(part => !part || part === "." || part === "..") ||
        !("type" in entry) || !["File", "Directory"].includes(entry.type)) throw new Error("Unsafe archive entry");
      count++; bytes += entry.size ?? 0;
      if (count > 10_000 || bytes > 100_000_000 || (entry.size ?? 0) > 10_000_000) throw new Error("Archive exceeds extraction limit");
      return true;
    }
  });
  const entries = await readdir(target);
  if (entries.length !== 1) throw new Error("Expected one upstream archive root");
  const root = join(target, entries[0]!);
  if (!(await lstat(root)).isDirectory()) throw new Error("Archive root is not a directory");
  return root;
}

export async function withFileLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await privateDirectory(dirname(path));
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })); return await action(); }
  finally { await handle.close(); await rm(path, { force: true }); }
}
