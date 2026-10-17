import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  opendir,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

const MAX_FILES = 128;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Canonical JSON is also the immutable document representation. No coercion or getters. */
export function canonical(value: unknown): string {
  const active = new Set<object>();
  const visit = (item: unknown): string => {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item))
      return JSON.stringify(item);
    if (typeof item !== "object" || item === null)
      throw new Error("Expected JSON value");
    if (active.has(item)) throw new Error("Cyclic JSON value");
    active.add(item);
    try {
      if (Array.isArray(item)) {
        if (
          Object.getOwnPropertySymbols(item).length ||
          Object.keys(item).length !== item.length
        ) {
          throw new Error("Expected dense JSON array");
        }
        return `[${Array.from({ length: item.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(
            item,
            String(index),
          );
          if (!descriptor || !("value" in descriptor))
            throw new Error("Expected JSON array value");
          return visit(descriptor.value);
        }).join(",")}]`;
      }
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      ) {
        throw new Error("Expected plain JSON object");
      }
      if (Object.getOwnPropertySymbols(item).length)
        throw new Error("Unexpected JSON symbol");
      return `{${Object.getOwnPropertyNames(item)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
          if (!descriptor.enumerable || !("value" in descriptor))
            throw new Error("Expected JSON data property");
          return `${JSON.stringify(key)}:${visit(descriptor.value)}`;
        })
        .join(",")}}`;
    } finally {
      active.delete(item);
    }
  };
  return visit(value);
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function absolute(path: string): void {
  if (!isAbsolute(path) || path.includes("\0") || path.includes("\\"))
    throw new Error("Expected absolute filesystem path");
  if (path.split("/").some((part) => part === "." || part === ".."))
    throw new Error("Unsafe filesystem path");
}

function resourcePath(path: string): string[] {
  const parts = path.split("/");
  if (
    !path ||
    path.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(path) ||
    isAbsolute(path) ||
    parts.some(
      (part) => !part || part === "." || part === ".." || part === ".git",
    )
  ) {
    throw new Error(`Unsafe bundle path: ${path}`);
  }
  return parts;
}

/** Inspect each ancestor, including the root itself, rather than following realpath. */
async function directories(path: string): Promise<void> {
  absolute(path);
  let cursor = parse(path).root;
  for (const part of path.slice(cursor.length).split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = await lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`Unsafe directory: ${cursor}`);
  }
}

async function privateDirectory(path: string): Promise<void> {
  await directories(path);
  const stat = await lstat(path);
  if (process.getuid && stat.uid !== process.getuid())
    throw new Error(`Storage directory has another owner: ${path}`);
  if ((stat.mode & 0o777) !== 0o700)
    throw new Error(`Storage directory must have mode 0700: ${path}`);
}

async function createPrivateDirectory(path: string): Promise<void> {
  await directories(dirname(path));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  await privateDirectory(path);
}

async function readFileBounded(
  path: string,
  limit: number,
  privateFile = false,
): Promise<string> {
  await directories(dirname(path));
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error(`Expected bounded regular file: ${path}`);
    if (
      privateFile &&
      ((stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid()))
    ) {
      throw new Error(`Storage file must be private and owned: ${path}`);
    }
    // Never use readFile: a growing file must not defeat the allocation bound.
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    // Immutable docs are published with link(); removing the temporary link changes ctime
    // without changing bytes. Private content is authenticated by its exact bytes/hash.
    if (
      length > limit ||
      after.size !== stat.size ||
      length !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      (!privateFile && after.ctimeMs !== stat.ctimeMs) ||
      after.mode !== stat.mode ||
      after.uid !== stat.uid
    ) {
      throw new Error(`File changed during bounded read: ${path}`);
    }
    return decoder.decode(buffer.subarray(0, length));
  } finally {
    await handle.close();
  }
}

export type BundleFiles = Record<string, string>;

export function bundleDigest(files: BundleFiles): string {
  validateFiles(files);
  return sha256(
    canonical(
      Object.keys(files)
        .sort()
        .map((path) => ({ path, digest: sha256(files[path]!) })),
    ),
  );
}

function validateFiles(files: Record<string, string>): string[] {
  if (
    !files ||
    typeof files !== "object" ||
    Array.isArray(files) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(files))
  )
    throw new Error("Expected bundle file map");
  if (Object.getOwnPropertySymbols(files).length)
    throw new Error("Unexpected bundle symbol");
  const paths = Object.getOwnPropertyNames(files).sort();
  if (!paths.length || paths.length > MAX_FILES)
    throw new Error("Bundle file count exceeds bounds");
  let total = 0;
  const names = new Set(paths);
  const directoriesInBundle = new Set<string>();
  for (const path of paths) {
    const parts = resourcePath(path);
    if (parts.length > 33)
      throw new Error("Bundle directory depth exceeds bounds");
    const descriptor = Object.getOwnPropertyDescriptor(files, path)!;
    if (
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string"
    )
      throw new Error("Expected UTF8 file contents");
    const content: string = descriptor.value;
    const bytes = Buffer.from(content, "utf8");
    if (bytes.toString("utf8") !== content)
      throw new Error("Invalid UTF8 file contents");
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || total > MAX_BUNDLE_BYTES)
      throw new Error("Bundle size exceeds bounds");
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join("/");
      if (names.has(directory)) throw new Error("Conflicting bundle paths");
      directoriesInBundle.add(directory);
    }
  }
  if (directoriesInBundle.size + paths.length > 512)
    throw new Error("Bundle entry count exceeds bounds");
  return paths;
}

/** Source bundles include every file; links, special files and .git directories are rejected. */
async function scanBundle(
  root: string,
  privateFiles = false,
): Promise<{ files: BundleFiles; digest: string }> {
  await directories(root);
  const files: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  let entries = 0;
  let total = 0;
  const walk = async (
    directory: string,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    if (depth > 32) throw new Error("Bundle directory depth exceeds bounds");
    if (privateFiles) await privateDirectory(directory);
    else await directories(directory);
    const children = [];
    // Stream entries so a huge directory cannot defeat the count bound before validation.
    for await (const entry of await opendir(directory)) {
      if (++entries > 512) throw new Error("Bundle entry count exceeds bounds");
      children.push(entry);
    }
    for (const entry of children.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      resourcePath(path);
      const fullPath = join(directory, entry.name);
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink())
        throw new Error(`Bundle symlink rejected: ${path}`);
      if (stat.isDirectory()) await walk(fullPath, path, depth + 1);
      else {
        if (!stat.isFile())
          throw new Error(`Bundle special file rejected: ${path}`);
        if (Object.keys(files).length >= MAX_FILES)
          throw new Error("Bundle file count exceeds bounds");
        const content = await readFileBounded(
          fullPath,
          MAX_FILE_BYTES,
          privateFiles,
        );
        total += Buffer.byteLength(content);
        if (total > MAX_BUNDLE_BYTES)
          throw new Error("Bundle size exceeds bounds");
        files[path] = content;
      }
    }
  };
  await walk(root, "", 0);
  validateFiles(files);
  return { files, digest: bundleDigest(files) };
}

export async function readBundle(root: string): Promise<BundleFiles> {
  return (await scanBundle(root)).files;
}

/** Private local-filesystem storage. This is not protection against a hostile same-UID process. */
export class SkillFileStore {
  readonly root: string;

  constructor(root: string) {
    absolute(root);
    this.root = resolve(root);
  }

  private async ready(): Promise<void> {
    // Parents belong to the caller; only create the explicitly owned root.
    await createPrivateDirectory(this.root);
    await createPrivateDirectory(join(this.root, "bundles"));
    await createPrivateDirectory(join(this.root, "docs"));
  }

  private async existing(): Promise<void> {
    await privateDirectory(this.root);
    await privateDirectory(join(this.root, "bundles"));
    await privateDirectory(join(this.root, "docs"));
  }

  /** Exclusive local catalog writer. A crash leaves a fail-closed lock for operator reconciliation. */
  async withCatalogLock<T>(action: () => Promise<T>): Promise<T> {
    await this.ready();
    const path = join(this.root, "catalog.lock");
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(String(process.pid), "utf8");
      await handle.sync();
      return await action();
    } finally {
      await handle.close();
      await rm(path);
    }
  }

  async put(
    files: Record<string, string>,
  ): Promise<{ digest: string; path: string }> {
    const paths = validateFiles(files);
    // Take an owned snapshot before awaiting anything.
    const snapshot: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const path of paths) snapshot[path] = files[path]!;
    const digest = bundleDigest(snapshot);
    await this.ready();
    const path = join(this.root, "bundles", digest);
    try {
      await lstat(path);
      await this.get(digest);
      return { digest, path };
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const staging = join(this.root, "bundles", `.tmp-${randomUUID()}`);
    await createPrivateDirectory(staging);
    try {
      for (const name of paths) {
        const parts = resourcePath(name);
        let parent = staging;
        for (const part of parts.slice(0, -1)) {
          parent = join(parent, part);
          await createPrivateDirectory(parent);
        }
        const handle = await open(
          join(staging, name),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(snapshot[name]!, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await privateDirectory(join(this.root, "bundles"));
      try {
        await rename(staging, path);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            ["EEXIST", "ENOTEMPTY"].includes(String(error.code))
          )
        )
          throw error;
      }
      await this.get(digest);
      return { digest, path };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async get(
    digest: string,
  ): Promise<{ files: Record<string, string>; digest: string }> {
    if (!DIGEST.test(digest)) throw new Error("Invalid bundle digest");
    await this.existing();
    const path = join(this.root, "bundles", digest);
    await privateDirectory(path);
    const result = await scanBundle(path, true);
    if (result.digest !== digest)
      throw new Error(`Corrupted bundle: ${digest}`);
    return result;
  }

  async list(): Promise<string[]> {
    try {
      await this.existing();
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
    const entries = await readdir(join(this.root, "bundles"));
    const digests: string[] = [];
    for (const name of entries.sort()) {
      if (name.startsWith(".tmp-")) continue;
      if (!DIGEST.test(name))
        throw new Error(`Unexpected storage entry: ${name}`);
      await this.get(name);
      digests.push(name);
    }
    return digests;
  }

  private documentPath(name: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name))
      throw new Error("Invalid document name");
    return join(this.root, "docs", `${name}.json`);
  }

  async publish(name: string, value: unknown): Promise<string> {
    const path = this.documentPath(name);
    const content = canonical(value);
    if (Buffer.byteLength(content) > MAX_BUNDLE_BYTES)
      throw new Error("Document size exceeds bounds");
    await this.ready();
    const temp = join(this.root, "docs", `.tmp-${randomUUID()}`);
    const handle = await open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await privateDirectory(join(this.root, "docs"));
      // Hard-link publication is exclusive and atomic; rename would overwrite another writer.
      try {
        await link(temp, path);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
        )
          throw error;
      }
      if ((await readFileBounded(path, MAX_BUNDLE_BYTES, true)) !== content)
        throw new Error(`Immutable document conflict: ${name}`);
      return path;
    } finally {
      await rm(temp, { force: true });
    }
  }

  async read(name: string): Promise<unknown | null> {
    const path = this.documentPath(name);
    try {
      await this.existing();
      const content = await readFileBounded(path, MAX_BUNDLE_BYTES, true);
      const value: unknown = JSON.parse(content);
      if (canonical(value) !== content)
        throw new Error(`Corrupted document: ${name}`);
      return value;
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async putBundle(files: BundleFiles): Promise<string> {
    return (await this.put(files)).digest;
  }

  async getBundle(digest: string): Promise<BundleFiles> {
    return (await this.get(digest)).files;
  }

  async readDocument(name: string): Promise<unknown | null> {
    return this.read(name);
  }

  async writeImmutableDocument(name: string, value: unknown): Promise<void> {
    await this.publish(name, value);
  }
}

export { SkillFileStore as FileSkillStore };
