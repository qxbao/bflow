import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { readResolutionFile } from "../agentic/execution-binding.js";
import { digest } from "../agentic/journal.js";
import { HandoverConflictError } from "./sources.js";
import {
  HANDOVER_EXPORTER_VERSION, HandoverDocumentSchema, HandoverManifestSchema, type HandoverDocument, type HandoverManifest,
  type HandoverVerification
} from "./schema.js";

export interface PackageFile { path: string; bytes: Buffer; mediaType: string }
/** Test-only fault injection for the publication protocol; never reachable from the CLI. */
export interface PublishFaults {
  afterFile?: (path: string) => void | Promise<void>; beforeRename?: () => void | Promise<void>; crashBeforeRename?: boolean;
}

const STAGING_MARKER = ".handover-staging-";
const REPLACED_MARKER = ".handover-replaced-";
const LOCK_SUFFIX = ".handover.lock";
const MANIFEST = "manifest.json";
const EVIDENCE_DIRECTORY = "evidence";
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The exporter version is part of the digest, so packages of different formats never compare equal. */
export function contentDigestOf(files: readonly { path: string; sha256: string }[]): string {
  return digest({ exporter: HANDOVER_EXPORTER_VERSION,
    files: [...files].map(file => ({ path: file.path, sha256: file.sha256 })).sort((a, b) => a.path.localeCompare(b.path)) });
}
export function manifestFiles(files: readonly PackageFile[]): HandoverManifest["files"] {
  return files.map(file => ({ path: file.path, sha256: sha256(file.bytes), bytes: file.bytes.length, mediaType: file.mediaType }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    try { await handle.sync(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (!code || !["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EBADF", "EISDIR", "EROFS"].includes(code)) throw error;
    }
  } finally { await handle.close(); }
}
async function writeDurable(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o644);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
const absent = async (path: string) => {
  try { await lstat(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
};

/**
 * Output target checks: a plain name in an existing, non-symlink parent that other users cannot rename entries in. A
 * group/other-writable parent is accepted only with the sticky bit, which stops other users replacing our entries.
 */
async function outputLocation(target: string): Promise<{ absolute: string; parent: string; name: string }> {
  const absolute = resolve(target), parent = dirname(absolute), name = basename(absolute);
  if (!name || name.startsWith(".") || name.includes(STAGING_MARKER) || name.includes(REPLACED_MARKER)) throw new Error("Output directory name is not allowed");
  const parentStat = await lstat(parent).catch(() => undefined);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Output parent directory must be an existing directory");
  if ((parentStat.mode & 0o022) !== 0 && (parentStat.mode & 0o1000) === 0)
    throw new Error("Output parent directory is writable by other users without the sticky bit");
  return { absolute, parent, name };
}

function flockNonblocking(fd: number): Promise<boolean> {
  return new Promise((accept, reject) => {
    const child = spawn("flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Handover lock timeout")); }, 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? accept(true) : code === 1 ? accept(false) : reject(new Error("Handover lock failed")); });
  });
}

/**
 * Serializes every export to one target with a Linux flock on a sibling lock file. A crashed exporter releases the
 * lock with its descriptor. The file is unlinked while held; a waiter that locked an unlinked inode retries.
 */
export async function withTargetLock<T>(target: string, action: () => Promise<T>): Promise<T> {
  const { parent, name } = await outputLocation(target);
  const path = join(parent, `.${name}${LOCK_SUFFIX}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      if (!await flockNonblocking(handle.fd)) throw new HandoverConflictError("Another handover export to this output directory is in progress");
      const [held, current] = await Promise.all([handle.stat(), lstat(path).catch(() => undefined)]);
      if (!current || current.ino !== held.ino || current.dev !== held.dev) continue;
      try { return await action(); }
      finally { await rm(path, { force: true }); }
    } finally { await handle.close(); }
  }
  throw new HandoverConflictError("Could not acquire the handover output lock");
}

/**
 * Under the target lock no other exporter owns a staging directory of this target, so every one left is from a crash.
 * Moved-aside old packages are removed only once the target exists again.
 */
export async function removeLeftovers(target: string): Promise<void> {
  const { absolute, parent, name } = await outputLocation(target);
  const published = !await absent(absolute);
  for (const entry of await readdir(parent)) {
    if (entry.startsWith(`.${name}${STAGING_MARKER}`) || (published && entry.startsWith(`.${name}${REPLACED_MARKER}`)))
      await rm(join(parent, entry), { recursive: true, force: true });
  }
}

class SimulatedCrash extends Error {}

/**
 * Writes every file into a sibling staging directory, the manifest last, then renames the directory onto the target.
 * Without `replace` the target must be absent; with it, the existing directory is moved aside first and removed only after
 * the new package is in place. Failure removes this staging directory, so the target name only ever denotes a complete package.
 * Callers hold `withTargetLock`.
 */
export async function publishPackage(target: string, files: readonly PackageFile[], manifest: HandoverManifest,
  options: { replace?: boolean } = {}, faults?: PublishFaults): Promise<void> {
  const { absolute, parent, name } = await outputLocation(target);
  const staging = join(parent, `.${name}${STAGING_MARKER}${randomUUID()}`);
  await mkdir(staging, { mode: 0o755 });
  try {
    const directories = [...new Set(files.map(file => dirname(file.path)).filter(path => path !== "."))].sort();
    for (const directory of directories) await mkdir(join(staging, directory), { mode: 0o755 });
    for (const file of files) { await writeDurable(join(staging, file.path), file.bytes); await faults?.afterFile?.(file.path); }
    await writeDurable(join(staging, MANIFEST), Buffer.from(`${JSON.stringify(HandoverManifestSchema.parse(manifest), null, 2)}\n`));
    for (const directory of directories) await syncDirectory(join(staging, directory));
    await syncDirectory(staging);
    if (faults?.crashBeforeRename) throw new SimulatedCrash("simulated crash before publication");
    const identity = await lstat(staging);
    if (options.replace) {
      const existing = await lstat(absolute);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new HandoverConflictError("Output directory to replace is not a directory");
      const aside = join(parent, `.${name}${REPLACED_MARKER}${randomUUID()}`);
      await faults?.beforeRename?.();
      await rename(absolute, aside);
      try { await rename(staging, absolute); }
      catch (error) { await rename(aside, absolute).catch(() => undefined); throw error; }
      await syncDirectory(parent);
      await rm(aside, { recursive: true, force: true });
    } else {
      if (!await absent(absolute)) throw new HandoverConflictError("Output directory appeared during export; nothing was published");
      await faults?.beforeRename?.();
      // rename(2) can still replace an empty directory created in this window; the identity check below confirms the result.
      await rename(staging, absolute);
      await syncDirectory(parent);
    }
    const published = await lstat(absolute);
    if (published.ino !== identity.ino || published.dev !== identity.dev) throw new Error("Published directory identity changed during publication");
  } catch (error) {
    if (!(error instanceof SimulatedCrash)) await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Minimal shape shared by every manifest version; used only to describe or replace an existing directory. */
const ManifestIdentitySchema = z.object({
  format: z.literal("bflow.handover.manifest"), schemaVersion: z.number().int(),
  // Bounded identifiers: these values from an arbitrary existing directory reach conflict messages.
  snapshot: z.object({ runId: z.string().regex(/^[A-Za-z0-9._:@/-]{1,300}$/), snapshotId: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough(),
  exporter: z.object({ version: z.number().int().min(0).max(1_000_000) }).passthrough(),
  files: z.array(z.object({ path: z.string() }).passthrough())
}).passthrough();
export interface ExistingPackage {
  readonly runId: string; readonly snapshotId: string; readonly exporterVersion: number; readonly schemaVersion: number;
  /** True when the directory holds only the manifest and the files it lists. */
  readonly onlyListedFiles: boolean;
}

async function listPackage(directory: string): Promise<string[] | undefined> {
  const entries: string[] = [];
  for (const entry of await readdir(directory).catch(() => undefined) ?? []) {
    const stats = await lstat(join(directory, entry));
    if (entry === EVIDENCE_DIRECTORY && stats.isDirectory() && !stats.isSymbolicLink())
      for (const nested of await readdir(join(directory, entry))) entries.push(`${EVIDENCE_DIRECTORY}/${nested}`);
    else entries.push(entry);
  }
  return entries;
}

export async function readExistingPackage(directory: string): Promise<ExistingPackage | undefined> {
  try {
    const manifest = ManifestIdentitySchema.parse(JSON.parse((await readResolutionFile(join(await realpath(directory), MANIFEST), 1024 * 1024)).toString("utf8")));
    const listed = new Set([MANIFEST, ...manifest.files.map(file => file.path)]);
    const entries = await listPackage(directory) ?? [];
    return { runId: manifest.snapshot.runId, snapshotId: manifest.snapshot.snapshotId, exporterVersion: manifest.exporter.version,
      schemaVersion: manifest.schemaVersion, onlyListedFiles: entries.every(entry => listed.has(entry)) };
  } catch { return undefined; }
}

const packagedEvidence = (document: HandoverDocument) => [
  ...document.evidence, ...(document.specification?.artifact ? [document.specification.artifact] : []),
  ...document.matrix.flatMap(row => row.checks.map(check => check.evidence))
].flatMap(item => item.packaging.status === "packaged" ? [item.packaging] : []);

const LINK_TARGETS: Record<string, RegExp> = { "index.html": /\bhref="([^"]*)"/g, "handover.md": /\]\(([^)\s]*)\)/g };
/** Offline package check: complete manifest, exact file set and hashes, schema, status consistency and package-local links. */
export async function verifyHandoverPackage(directory: string): Promise<HandoverVerification> {
  // Canonical path: the bounded reader rejects symlinked ancestors, which a user-supplied package path may contain.
  const absolute = await realpath(resolve(directory)).catch(() => resolve(directory)), problems: string[] = [];
  let manifest: HandoverManifest | undefined;
  if (basename(absolute).includes(STAGING_MARKER) || basename(absolute).includes(REPLACED_MARKER)) problems.push("Directory is an unpublished staging or replaced directory");
  const existing = await readExistingPackage(absolute);
  if (existing && (existing.schemaVersion !== 1 || existing.exporterVersion !== HANDOVER_EXPORTER_VERSION)) {
    problems.push(`Package was produced by handover exporter version ${existing.exporterVersion} (manifest schema ${existing.schemaVersion}); ` +
      `this bflow reads exporter version ${HANDOVER_EXPORTER_VERSION}`);
    return { valid: false, status: null, runId: existing.runId, snapshotId: null, problems };
  }
  try { manifest = HandoverManifestSchema.parse(JSON.parse((await readResolutionFile(join(absolute, MANIFEST), 1024 * 1024)).toString("utf8"))); }
  catch { problems.push("manifest.json is missing, unreadable or invalid"); }
  if (!manifest) return { valid: false, status: null, runId: null, snapshotId: null, problems };
  const expected = new Set([MANIFEST, ...manifest.files.map(file => file.path)]);
  for (const name of await listPackage(absolute) ?? []) if (!expected.has(name)) problems.push(`Unlisted file ${name}`);
  const contents = new Map<string, Buffer>();
  for (const file of manifest.files) {
    try {
      const bytes = await readResolutionFile(join(absolute, file.path), 64 * 1024 * 1024);
      contents.set(file.path, bytes);
      if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) problems.push(`Hash mismatch for ${file.path}`);
    } catch { problems.push(`Missing or unreadable ${file.path}`); }
  }
  if (contentDigestOf(manifest.files) !== manifest.contentDigest) problems.push("Content digest mismatch");
  const json = contents.get("handover.json");
  if (!json) problems.push("handover.json is not listed");
  else {
    try {
      const document = HandoverDocumentSchema.parse(JSON.parse(json.toString("utf8")));
      if (document.eligibility.status !== manifest.status || document.snapshot.snapshotId !== manifest.snapshot.snapshotId ||
          document.snapshot.runId !== manifest.snapshot.runId || document.run.integratedRevision !== manifest.snapshot.integratedRevision)
        problems.push("handover.json does not match the manifest identity or status");
      // Packaged evidence named by the document and evidence files listed by the manifest must be the same set.
      const declared = new Map(packagedEvidence(document).map(item => [item.path, item]));
      for (const [path, item] of declared) {
        const listed = manifest.files.find(file => file.path === path);
        if (!listed || listed.sha256 !== item.sha256 || listed.bytes !== item.bytes) problems.push(`Packaged evidence ${path} is not listed with its hash`);
      }
      for (const file of manifest.files) if (file.path.startsWith(`${EVIDENCE_DIRECTORY}/`) && !declared.has(file.path)) problems.push(`Evidence file ${file.path} is not referenced by handover.json`);
    } catch { problems.push("handover.json failed schema validation"); }
  }
  for (const [path, bytes] of contents) {
    const links = LINK_TARGETS[path];
    if (!links) continue;
    const text = bytes.toString("utf8");
    if (path === "index.html" && /<script|<[^>]*\s(?:src|on[a-z]+)\s*=/i.test(text)) problems.push("index.html contains active content");
    for (const match of text.matchAll(links)) {
      const link = match[1] ?? "";
      if (!link.startsWith("#") && !expected.has(link)) problems.push(`Link outside the package in ${path}: ${link.slice(0, 120)}`);
    }
  }
  return { valid: problems.length === 0, status: manifest.status, runId: manifest.snapshot.runId, snapshotId: manifest.snapshot.snapshotId, problems };
}

export { STAGING_MARKER };
