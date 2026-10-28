import { resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { buildHandover, type HandoverBuild } from "./build.js";
import { renderHtml, renderMarkdown } from "./render.js";
import {
  contentDigestOf, manifestFiles, publishPackage, readExistingPackage, removeLeftovers, verifyHandoverPackage, withTargetLock,
  type ExistingPackage, type PackageFile, type PublishFaults
} from "./publish.js";
import { HandoverConflictError, type HandoverSources } from "./sources.js";
import {
  HANDOVER_EXPORTER_VERSION, HandoverExportResultSchema, HandoverFormatSchema, HandoverInspectionSchema, HandoverManifestSchema,
  type HandoverExportResult, type HandoverFormat, type HandoverInspection, type HandoverManifest
} from "./schema.js";

export * from "./schema.js";
export { HandoverConflictError, HandoverNotFoundError, openHandoverSources, openRepositoryHandoverSources, type HandoverSources } from "./sources.js";
export { verifyHandoverPackage } from "./publish.js";

export interface HandoverExportOptions {
  runId: string; revision?: string | undefined; snapshot?: string | undefined; outputDirectory: string;
  formats?: readonly HandoverFormat[] | undefined; clock?: (() => Date) | undefined; faults?: PublishFaults | undefined;
  /** Copy allow-listed, verified, text evidence (redacted) into `evidence/`. Default: references only. */
  includeEvidence?: boolean | undefined;
  /** Replace an existing handover package of the same run; an unrelated directory is never replaced. */
  replace?: boolean | undefined;
}

async function snapshotBuild(sources: HandoverSources, runId: string, includeEvidence = false): Promise<HandoverBuild & { journalSha256: string }> {
  const snapshot = await sources.readSnapshot(runId);
  return { ...await buildHandover(snapshot, sources, { includeEvidence }), journalSha256: snapshot.journalSha256 };
}

function existingConflict(existing: ExistingPackage | undefined, runId: string, snapshotId: string): HandoverConflictError {
  if (!existing) return new HandoverConflictError("Output directory already exists and is not a handover package");
  if (existing.exporterVersion !== HANDOVER_EXPORTER_VERSION || existing.schemaVersion !== 1)
    return new HandoverConflictError(`Output directory holds a package from handover exporter version ${existing.exporterVersion}; ` +
      `this bflow writes version ${HANDOVER_EXPORTER_VERSION}. Use --replace to replace it`);
  if (existing.runId !== runId) return new HandoverConflictError(`Output directory holds a handover package of run ${existing.runId}`);
  if (existing.snapshotId !== snapshotId)
    return new HandoverConflictError(`Output directory holds a package of another snapshot (${existing.snapshotId}) of this run. Use --replace to replace it`);
  return new HandoverConflictError("Output directory holds a modified or incomplete package of this snapshot. Use --replace to replace it");
}

/** Read-only: one journal snapshot plus integrity-checked artifact reads. Writes nothing. */
export async function inspectHandoverRun(sources: HandoverSources, runId: string): Promise<HandoverInspection> {
  const { document } = await snapshotBuild(sources, runId);
  return HandoverInspectionSchema.parse({ runId, snapshotId: document.snapshot.snapshotId, runStatus: document.run.status,
    integratedRevision: document.run.integratedRevision, status: document.eligibility.status, reasons: document.eligibility.reasons });
}

/**
 * Exports the package of one run snapshot. The requested revision/snapshot must match before anything is written; content
 * files are deterministic for one snapshot and integrity observation, and only the manifest carries the export time.
 */
export async function exportHandoverPackage(sources: HandoverSources, options: HandoverExportOptions): Promise<HandoverExportResult> {
  if (!options.revision && !options.snapshot) throw new Error("Export requires a revision or snapshot identity");
  if (options.revision !== undefined && !/^[a-f0-9]{40}$/.test(options.revision)) throw new Error("Revision must be a full 40-character commit hash");
  if (options.snapshot !== undefined && !/^[a-f0-9]{64}$/.test(options.snapshot)) throw new Error("Snapshot must be a 64-character SHA-256 identity");
  const formats = [...new Set((options.formats ?? ["html", "md"]).map(format => HandoverFormatSchema.parse(format)))].sort();
  if (!formats.length) throw new Error("At least one report format is required");
  const { document, attachments, journalSha256 } = await snapshotBuild(sources, options.runId, options.includeEvidence === true);
  if (options.snapshot && options.snapshot !== document.snapshot.snapshotId)
    throw new HandoverConflictError(`Snapshot ${options.snapshot} is stale; the run's current snapshot is ${document.snapshot.snapshotId}`);
  if (options.revision && options.revision !== document.run.integratedRevision)
    throw new HandoverConflictError(document.run.integratedRevision
      ? `Revision ${options.revision} is not the run's integrated revision ${document.run.integratedRevision}`
      : `Run ${options.runId} has no integrated revision; export it by --snapshot as a draft`);

  const files: PackageFile[] = [
    { path: "handover.json", bytes: Buffer.from(`${JSON.stringify(document, null, 2)}\n`), mediaType: "application/json" },
    ...(formats.includes("md") ? [{ path: "handover.md" as const, bytes: Buffer.from(renderMarkdown(document, formats)), mediaType: "text/markdown; charset=utf-8" }] : []),
    ...(formats.includes("html") ? [{ path: "index.html" as const, bytes: Buffer.from(renderHtml(document, formats)), mediaType: "text/html; charset=utf-8" }] : []),
    ...attachments.map(item => ({ path: item.path, bytes: item.bytes, mediaType: "text/plain; charset=utf-8" }))
  ];
  const listed = manifestFiles(files), contentDigest = contentDigestOf(listed);
  const result = (outcome: "published" | "reused" | "replaced") => HandoverExportResultSchema.parse({ outcome, status: document.eligibility.status,
    runId: options.runId, snapshotId: document.snapshot.snapshotId, integratedRevision: document.run.integratedRevision, contentDigest,
    files: [...listed.map(file => file.path), "manifest.json"], reasons: document.eligibility.reasons });

  const target = resolve(options.outputDirectory);
  const manifest: HandoverManifest = HandoverManifestSchema.parse({ schemaVersion: 1, format: "bflow.handover.manifest", status: document.eligibility.status,
    snapshot: { runId: options.runId, snapshotId: document.snapshot.snapshotId, integratedRevision: document.run.integratedRevision },
    contentDigest, files: listed,
    sources: [{ kind: "journal_run", locator: `runtime-journal:run/${options.runId}`, digest: document.snapshot.snapshotId },
      { kind: "journal_file", locator: "runtime-journal:state.json", digest: `sha256:${journalSha256}` },
      ...document.evidence.map(item => ({ kind: "artifact" as const, locator: item.uri, digest: `${item.checksum.algorithm}:${item.checksum.value}` }))],
    exporter: { name: "bflow-handover", version: HANDOVER_EXPORTER_VERSION }, exportedAt: (options.clock?.() ?? new Date()).toISOString() });
  return withTargetLock(target, async () => {
    await removeLeftovers(target);
    const present = await realpath(target).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    if (!present) { await publishPackage(target, files, manifest, {}, options.faults); return result("published"); }
    const verified = await verifyHandoverPackage(target);
    const current = verified.valid ? await readManifest(target) : undefined;
    if (current?.contentDigest === contentDigest && current.snapshot.snapshotId === document.snapshot.snapshotId) return result("reused");
    const existing = await readExistingPackage(target);
    if (!options.replace) throw existingConflict(existing, options.runId, document.snapshot.snapshotId);
    if (!existing?.onlyListedFiles || existing.runId !== options.runId)
      throw new HandoverConflictError("--replace only replaces a handover package of the same run that holds no other files");
    await publishPackage(target, files, manifest, { replace: true }, options.faults);
    await removeLeftovers(target);
    return result("replaced");
  });
}

async function readManifest(directory: string): Promise<HandoverManifest | undefined> {
  try { return HandoverManifestSchema.parse(JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"))); }
  catch { return undefined; }
}
