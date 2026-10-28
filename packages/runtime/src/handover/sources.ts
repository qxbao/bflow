import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import type { ArtifactReference, ArtifactStore } from "@bflow/contracts";
import { findPrivateRuntimeStateDirectory } from "../private-state.js";
import { publicExecutionRun } from "../agentic/execution-binding.js";
import { digest, parseAgenticJournalState, type RunRecord } from "../agentic/journal.js";
import type { EvidenceIntegrity } from "./schema.js";

const JOURNAL_LIMIT = 32 * 1024 * 1024;
export const ARTIFACT_READ_LIMIT = 4 * 1024 * 1024;

export class HandoverNotFoundError extends Error { readonly code = "not_found"; }
export class HandoverConflictError extends Error { readonly code = "conflict"; }

/** One read of the journal file; every value of an export comes from this snapshot. */
export interface HandoverSnapshot {
  readonly runId: string; readonly snapshotId: string; readonly journalVersion: number; readonly repository: string; readonly run: RunRecord;
  /** sha256 of the exact journal bytes read; recorded in the manifest so the package can be matched to a journal copy. */
  readonly journalSha256: string;
}
export interface ArtifactObservation { readonly integrity: EvidenceIntegrity; readonly bytes?: Buffer | undefined }
export interface HandoverSources {
  readSnapshot(runId: string): Promise<HandoverSnapshot>;
  /** Integrity-checked read; bytes are returned only for verified references within `maxBytes`. */
  readArtifact(reference: ArtifactReference, maxBytes?: number): Promise<ArtifactObservation>;
  close(): void;
}

export function snapshotIdentity(journalVersion: number, repository: string, run: RunRecord): string {
  return digest({ format: "bflow.handover.snapshot/1", journalVersion, repository, run: publicExecutionRun(run) });
}

const uid = () => process.getuid?.();
const ownedPrivate = (stats: { uid: number; mode: number }, forbidden: number) => (stats.mode & forbidden) === 0 && (uid() === undefined || stats.uid === uid());

/**
 * Bounded read of a private file. Owner and mode are checked on the opened descriptor (not on a prior path lookup), the
 * file is opened without following symlinks below non-symlink ancestors, and a change during the read is rejected.
 */
async function readPrivateFile(path: string, limit: number): Promise<Buffer> {
  let ancestor = parse(path).root;
  for (const part of dirname(path).slice(ancestor.length).split("/").filter(Boolean)) {
    ancestor = join(ancestor, part);
    const stats = await lstat(ancestor);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("unsafe");
  }
  if (!ownedPrivate(await lstat(dirname(path)), 0o077)) throw new Error("unsafe");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || !ownedPrivate(before, 0o077) || before.size > limit) throw new Error("unsafe");
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) { const { bytesRead } = await file.read(bytes, count, bytes.length - count, null); if (!bytesRead) break; count += bytesRead; }
    const after = await file.stat();
    if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("changed");
    return bytes.subarray(0, count);
  } finally { await file.close(); }
}

/** A store that another user could write to cannot back integrity claims; its evidence is reported as unavailable. */
async function privateStore(root: string): Promise<boolean> {
  try {
    const [directory, catalog] = await Promise.all([lstat(root), lstat(join(root, "catalog.sqlite"))]);
    return directory.isDirectory() && !directory.isSymbolicLink() && ownedPrivate(directory, 0o022) && catalog.isFile() && ownedPrivate(catalog, 0o022);
  } catch { return false; }
}

/**
 * Read-only sources: the journal is read lock-free with the owner/mode checks used by accepted preview, and the
 * ArtifactStore is opened only when its catalog already exists (opening a missing root would create it).
 */
export function openHandoverSources(options: { repositoryPath: string; journalPath: string; artifactRoot: string }): HandoverSources {
  let store: Promise<(ArtifactStore & { close(): void }) | undefined> | undefined;
  const openStore = (storeId: string) => store ??= (async () => {
    if (!await privateStore(resolve(options.artifactRoot))) return undefined;
    const module = await import("@bflow/artifact-store");
    const opened = await module.openFilesystemArtifactStore({ root: resolve(options.artifactRoot), storeId });
    return opened.ok ? opened.value as unknown as ArtifactStore & { close(): void } : undefined;
  })();
  let storeId: string | undefined;
  return {
    async readSnapshot(runId) {
      const repository = await realpath(options.repositoryPath);
      let bytes: Buffer;
      try { bytes = await readPrivateFile(resolve(options.journalPath), JOURNAL_LIMIT); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HandoverNotFoundError("No Runtime journal exists for this repository");
        throw new Error("Runtime journal is unavailable or not private to this user");
      }
      let state;
      try { state = parseAgenticJournalState(JSON.parse(bytes.toString("utf8")), repository); }
      catch { throw new Error("Runtime journal failed schema or repository identity validation"); }
      const run = state.runs.find(candidate => candidate.runId === runId);
      if (!run) throw new HandoverNotFoundError(`Run ${runId} does not exist in the Runtime journal`);
      return { runId, journalVersion: state.version, repository, run, snapshotId: snapshotIdentity(state.version, repository, run),
        journalSha256: createHash("sha256").update(bytes).digest("hex") };
    },
    async readArtifact(reference, maxBytes = 0) {
      const authority = /^artifact:\/\/([^/]+)\//.exec(reference.uri)?.[1];
      if (!authority || (storeId !== undefined && authority !== storeId)) return { integrity: "identity_mismatch" };
      storeId = authority;
      const opened = await openStore(authority);
      if (!opened) return { integrity: "unavailable" };
      const chunks: Buffer[] = []; let size = 0;
      try {
        for await (const chunk of opened.get(reference)) {
          if (!chunk.ok) {
            const code = chunk.error.code as string;
            return { integrity: code === "not_found" ? "missing" : code === "corruption" ? "corrupt" : ["validation", "conflict"].includes(code) ? "identity_mismatch" : "unavailable" };
          }
          size += chunk.value.byteLength;
          if (size <= maxBytes) chunks.push(Buffer.from(chunk.value));
        }
      } catch { return { integrity: "unavailable" }; }
      return { integrity: "verified", ...(size <= maxBytes ? { bytes: Buffer.concat(chunks) } : {}) };
    },
    close() { void store?.then(value => value?.close()).catch(() => undefined); }
  };
}

/** Sources of the repository's private Runtime state. Finds existing state only; never creates or pins directories. */
export async function openRepositoryHandoverSources(repositoryPath: string): Promise<HandoverSources> {
  const repository = await realpath(repositoryPath);
  const directory = findPrivateRuntimeStateDirectory(repository);
  if (!directory) throw new HandoverNotFoundError("This repository has no Bflow Runtime state");
  return openHandoverSources({ repositoryPath: repository, journalPath: join(directory, "agentic", "journal", "state.json"),
    artifactRoot: join(directory, "agentic", "artifacts") });
}
