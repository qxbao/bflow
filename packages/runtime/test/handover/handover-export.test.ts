import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { digest } from "../../src/agentic/journal.js";
import {
  exportHandoverPackage, inspectHandoverRun, openHandoverSources, verifyHandoverPackage,
  HandoverConflictError, HandoverNotFoundError, HandoverDocumentSchema, HandoverManifestSchema
} from "../../src/handover/index.js";
import { cleanups, fixture } from "../helpers/agentic-integration-fixture.js";

// Keep native SQLite usable with the workspace's Vite 5 test transformer.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

type Fixture = Awaited<ReturnType<typeof fixture>>;
const clock = () => new Date("2026-10-28T10:00:00.000Z");

async function completed(mutate?: (spec: Fixture["spec"]) => void) {
  const f = await fixture();
  mutate?.(f.spec);
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
  await f.runtime.tick(); await f.evidence("implement"); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
  await f.approve();
  return f;
}
const journalPath = (f: Fixture, name = "journal") => join(f.root, name, "state.json");
const sources = (f: Fixture, journal = journalPath(f)) =>
  openHandoverSources({ repositoryPath: f.repository, journalPath: journal, artifactRoot: join(f.root, "artifacts") });
async function copyJournal(f: Fixture, name: string, mutate: (state: any) => void): Promise<string> {
  const state = JSON.parse(await readFile(journalPath(f), "utf8"));
  mutate(state);
  await mkdir(join(f.root, name), { mode: 0o700 }); await chmod(join(f.root, name), 0o700);
  await writeFile(join(f.root, name, "state.json"), JSON.stringify(state), { mode: 0o600 });
  return join(f.root, name, "state.json");
}
async function contentFiles(directory: string): Promise<Record<string, string>> {
  const names = (await readdir(directory)).filter(name => name !== "manifest.json").sort();
  return Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(join(directory, name), "utf8")] as const)));
}

describe.skipIf(process.platform === "win32")("handover export", () => {
  it("exports an eligible package for a completed run bound to its integrated revision without mutating Runtime state", async () => {
    const f = await completed();
    const run = await f.inspect();
    const revision = run.workflowChange.headCommitHash as string;
    const before = await readFile(journalPath(f));
    const beforeListing = await readdir(join(f.root, "journal"));
    const source = sources(f);
    try {
      const inspected = await inspectHandoverRun(source, "run-1");
      expect(inspected).toMatchObject({ runId: "run-1", integratedRevision: revision, status: "eligible" });
      expect(inspected.snapshotId).toMatch(/^[a-f0-9]{64}$/);
      const out = join(f.root, "handover");
      const result = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock });
      expect(result).toMatchObject({ outcome: "published", status: "eligible", snapshotId: inspected.snapshotId, integratedRevision: revision });
      expect((await readdir(out)).sort()).toEqual(["handover.json", "handover.md", "index.html", "manifest.json"]);
      const document = HandoverDocumentSchema.parse(JSON.parse(await readFile(join(out, "handover.json"), "utf8")));
      expect(document.eligibility).toEqual({ status: "eligible", reasons: [] });
      const row = document.matrix.find(item => item.criterionId === "ac-1")!;
      expect(row).toMatchObject({ verdict: "passed", taskIds: ["implement"], integratedRevision: revision });
      expect(row.checks.some(check => check.scope === "workflow" && check.revision === revision && check.revisionBinding === "bound" && check.passed)).toBe(true);
      expect(row.checks.every(check => check.evidence.integrity === "verified" && check.evidence.packaging.status === "not_packaged")).toBe(true);
      expect(document.approvals.find(item => item.kind === "delivery")).toMatchObject({ decision: "approved", validity: "valid" });
      expect(document.tasks).toEqual([expect.objectContaining({ taskId: "implement", outcome: "passed", integration: "integrated" })]);
      expect(document.instructions.rollback).toMatchObject({ status: "missing", expectedSource: "specification.rollbackPlan" });
      const manifest = HandoverManifestSchema.parse(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")));
      expect(manifest).toMatchObject({ status: "eligible", exportedAt: "2026-10-28T10:00:00.000Z",
        snapshot: { runId: "run-1", snapshotId: inspected.snapshotId, integratedRevision: revision } });
      expect(manifest.files.map(file => file.path).sort()).toEqual(["handover.json", "handover.md", "index.html"]);
      expect(manifest.sources.some(item => item.kind === "journal_run" && item.digest === inspected.snapshotId)).toBe(true);
      expect(manifest.sources).toContainEqual({ kind: "journal_file", locator: "runtime-journal:state.json",
        digest: `sha256:${createHash("sha256").update(before).digest("hex")}` });
      expect(document.evidence.every(item => item.packaging.status === "not_packaged" && item.packaging.reason === "not_requested")).toBe(true);
      expect(manifest.sources.some(item => item.kind === "artifact" && item.locator.startsWith("artifact://p19/"))).toBe(true);
      expect(await verifyHandoverPackage(out)).toMatchObject({ valid: true, status: "eligible", problems: [] });
    } finally { source.close(); }
    expect(await readFile(journalPath(f))).toEqual(before);
    expect(await readdir(join(f.root, "journal"))).toEqual(beforeListing);
    expect((await f.inspect()).status).toBe("completed");
  }, 60_000);

  it("refuses a mismatched revision or stale snapshot without creating output", async () => {
    const f = await completed();
    const source = sources(f);
    try {
      const out = join(f.root, "handover");
      await expect(exportHandoverPackage(source, { runId: "run-1", revision: "0".repeat(40), outputDirectory: out, clock }))
        .rejects.toBeInstanceOf(HandoverConflictError);
      await expect(exportHandoverPackage(source, { runId: "run-1", snapshot: "a".repeat(64), outputDirectory: out, clock }))
        .rejects.toBeInstanceOf(HandoverConflictError);
      await expect(exportHandoverPackage(source, { runId: "missing", snapshot: "a".repeat(64), outputDirectory: out, clock }))
        .rejects.toBeInstanceOf(HandoverNotFoundError);
      await expect(exportHandoverPackage(source, { runId: "run-1", outputDirectory: out, clock })).rejects.toThrow(/revision or snapshot/);
      await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(f.root)).some(name => name.includes("handover-staging"))).toBe(false);
    } finally { source.close(); }
  }, 60_000);

  it("exports an incomplete run only as a labelled draft bound to its snapshot", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const source = sources(f);
    try {
      const inspected = await inspectHandoverRun(source, "run-1");
      expect(inspected).toMatchObject({ status: "draft", integratedRevision: null });
      await expect(exportHandoverPackage(source, { runId: "run-1", revision: "1".repeat(40), outputDirectory: join(f.root, "x"), clock }))
        .rejects.toBeInstanceOf(HandoverConflictError);
      const out = join(f.root, "draft");
      const result = await exportHandoverPackage(source, { runId: "run-1", snapshot: inspected.snapshotId, outputDirectory: out, clock });
      expect(result).toMatchObject({ outcome: "published", status: "draft" });
      const document = HandoverDocumentSchema.parse(JSON.parse(await readFile(join(out, "handover.json"), "utf8")));
      expect(document.eligibility.status).toBe("draft");
      expect(document.eligibility.reasons.map(item => item.code)).toContain("run_not_completed");
      expect(document.matrix[0]!.verdict).toBe("not_verified");
      expect(document.unverified.some(item => item.criterionId === "ac-1")).toBe(true);
      expect(await readFile(join(out, "index.html"), "utf8")).toContain("BẢN NHÁP");
      expect(await readFile(join(out, "handover.md"), "utf8")).toContain("BẢN NHÁP");
      expect(await verifyHandoverPackage(out)).toMatchObject({ valid: true, status: "draft" });
    } finally { source.close(); }
  }, 60_000);

  it("never counts a corrupted evidence artifact as passing evidence", async () => {
    const f = await completed();
    const run = await f.inspect();
    const evidenceId = run.workflowCycle.history.at(-1).evaluatedCriteria[0].evidenceArtifactId as string;
    const db = new DatabaseSync(join(f.root, "artifacts", "catalog.sqlite"), { readOnly: true });
    const { blob } = db.prepare("SELECT blob FROM artifacts WHERE artifact_id=?").get(evidenceId) as { blob: string };
    db.close();
    const blobPath = join(f.root, "artifacts", blob);
    const bytes = await readFile(blobPath); bytes[0] = bytes[0]! ^ 0xff;
    await chmod(blobPath, 0o600); await writeFile(blobPath, bytes);
    const source = sources(f);
    try {
      const out = join(f.root, "handover");
      const result = await exportHandoverPackage(source, { runId: "run-1", revision: run.workflowChange.headCommitHash, outputDirectory: out, clock });
      expect(result.status).toBe("partial");
      const document = HandoverDocumentSchema.parse(JSON.parse(await readFile(join(out, "handover.json"), "utf8")));
      expect(document.evidence.find(item => item.artifactId === evidenceId)?.integrity).toBe("corrupt");
      const row = document.matrix.find(item => item.criterionId === "ac-1")!;
      expect(row.verdict).toBe("inconclusive");
      expect(document.eligibility.reasons.map(item => item.code)).toEqual(expect.arrayContaining(["evidence_integrity_failed", "required_criterion_not_passed"]));
      expect(await verifyHandoverPackage(out)).toMatchObject({ valid: true, status: "partial" });
    } finally { source.close(); }
  }, 60_000);

  it("reports a delivery approval that is not bound to the final verification as stale", async () => {
    const f = await completed();
    const run = await f.inspect();
    const stale = `delivery-${digest(["run-1", "verify-older"])}`;
    const path = await copyJournal(f, "journal-stale", state => {
      const record = state.runs[0];
      record.approval = { ...record.approval, approvalId: stale, idempotencyKey: "delivery:run-1:verify-older" };
      record.decision = { ...record.decision, approvalId: stale };
    });
    const superseded = await copyJournal(f, "journal-superseded", state => {
      state.runs[0].supersededApprovals = [{ approvalId: state.runs[0].approval.approvalId, supersededByRevision: 2 }];
    });
    for (const journal of [path, superseded]) {
      const source = sources(f, journal);
      try {
        const out = join(f.root, `handover-${journal.includes("stale") ? "stale" : "superseded"}`);
        const result = await exportHandoverPackage(source, { runId: "run-1", revision: run.workflowChange.headCommitHash, outputDirectory: out, clock });
        expect(result.status).toBe("partial");
        const document = HandoverDocumentSchema.parse(JSON.parse(await readFile(join(out, "handover.json"), "utf8")));
        const delivery = document.approvals.find(item => item.kind === "delivery")!;
        expect(delivery.validity).toBe(journal === path ? "stale" : "superseded");
        expect(document.eligibility.reasons.map(item => item.code)).toContain("delivery_approval_invalid");
      } finally { source.close(); }
    }
  }, 60_000);

  it("reports a waiting delivery gate as pending, not stale, while the previous gate's decision is still recorded", async () => {
    const f = await completed();
    const journal = await copyJournal(f, "journal-waiting", state => {
      const record = state.runs[0];
      record.status = "awaiting_approval"; record.decision = record.workflowSpec.decision;
    });
    const source = sources(f, journal);
    try {
      const inspected = await inspectHandoverRun(source, "run-1");
      expect(inspected.status).toBe("draft");
      const out = join(f.root, "waiting");
      await exportHandoverPackage(source, { runId: "run-1", snapshot: inspected.snapshotId, outputDirectory: out, clock });
      const document = HandoverDocumentSchema.parse(JSON.parse(await readFile(join(out, "handover.json"), "utf8")));
      expect(document.approvals.find(item => item.kind === "delivery")).toMatchObject({ decision: "pending", validity: "pending" });
      expect(document.matrix.find(row => row.criterionId === "ac-1")!.verdict).toBe("passed");
      expect(document.eligibility.reasons.map(item => item.code)).toEqual(expect.arrayContaining(["run_not_completed", "delivery_approval_pending"]));
    } finally { source.close(); }
  }, 60_000);

  it("produces identical content for repeated exports of one snapshot and reuses an identical package", async () => {
    const f = await completed();
    const revision = (await f.inspect()).workflowChange.headCommitHash;
    const source = sources(f);
    try {
      const first = join(f.root, "first"), second = join(f.root, "second");
      const a = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: first, clock });
      const b = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: second, clock: () => new Date("2026-10-29T00:00:00.000Z") });
      expect(await contentFiles(second)).toEqual(await contentFiles(first));
      expect(b.contentDigest).toBe(a.contentDigest);
      const [ma, mb] = await Promise.all([first, second].map(async dir => JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))));
      expect({ ...mb, exportedAt: undefined }).toEqual({ ...ma, exportedAt: undefined });
      expect(mb.exportedAt).not.toBe(ma.exportedAt);
      const manifestBefore = await readFile(join(first, "manifest.json"));
      expect(await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: first, clock: () => new Date() }))
        .toMatchObject({ outcome: "reused", contentDigest: a.contentDigest });
      expect(await readFile(join(first, "manifest.json"))).toEqual(manifestBefore);
      await writeFile(join(second, "handover.md"), "tampered\n");
      await expect(exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: second, clock })).rejects.toBeInstanceOf(HandoverConflictError);
      expect(await verifyHandoverPackage(second)).toMatchObject({ valid: false });
    } finally { source.close(); }
  }, 60_000);

  it("never publishes an interrupted package and rejects a crashed staging directory", async () => {
    const f = await completed();
    const revision = (await f.inspect()).workflowChange.headCommitHash;
    const source = sources(f);
    try {
      const out = join(f.root, "handover");
      await expect(exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock,
        faults: { afterFile: name => { if (name === "handover.md") throw new Error("disk full"); } } })).rejects.toThrow("disk full");
      await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(f.root)).filter(name => name.includes("handover-staging"))).toEqual([]);
      await expect(exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock,
        faults: { crashBeforeRename: true } })).rejects.toThrow(/simulated crash/);
      await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
      const [staging] = (await readdir(f.root)).filter(name => name.includes("handover-staging"));
      expect(staging).toBeDefined();
      expect(await verifyHandoverPackage(join(f.root, staging!))).toMatchObject({ valid: false });
      const recovered = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock });
      expect(recovered.outcome).toBe("published");
      // The next export to the same target removes the crashed staging directory under the target lock.
      expect((await readdir(f.root)).filter(name => name.includes("handover-staging") || name.includes("handover.lock"))).toEqual([]);
      expect(await verifyHandoverPackage(out)).toMatchObject({ valid: true, status: "eligible" });
    } finally { source.close(); }
  }, 60_000);

  it("escapes report content, redacts secrets and keeps every link inside the package", async () => {
    const f = await completed(spec => {
      spec.title = "<script>alert('x')</script> [click](https://evil.example) Bearer sk-live-SECRET123";
      spec.summary = "Outcome <img src=x onerror=alert(1)> | pipe `code` api_key=SECRETVALUE42";
    });
    const revision = (await f.inspect()).workflowChange.headCommitHash;
    const source = sources(f);
    try {
      const out = join(f.root, "handover");
      await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock });
      const html = await readFile(join(out, "index.html"), "utf8"), markdown = await readFile(join(out, "handover.md"), "utf8");
      const json = await readFile(join(out, "handover.json"), "utf8");
      expect(html).not.toMatch(/<script|<img|<[^>]*\son[a-z]+=|javascript:/i);
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("Content-Security-Policy");
      expect(markdown).not.toMatch(/<script|<img|\]\(https?:/i);
      for (const text of [html, markdown, json]) {
        expect(text).not.toContain("sk-live-SECRET123");
        expect(text).not.toContain("SECRETVALUE42");
        expect(text).not.toContain(f.root);
      }
      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map(match => match[1]!);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) expect(href.startsWith("#") || (await readdir(out)).includes(href), href).toBe(true);
      expect(html).toContain("artifact://p19/");
      expect(html).toContain("không đóng gói");
      expect(await verifyHandoverPackage(out)).toMatchObject({ valid: true, problems: [] });
    } finally { source.close(); }
  }, 60_000);

  it("packages allow-listed evidence only on request, redacted, hashed and linked inside the package", async () => {
    const f = await completed(spec => { spec.summary = "Spec summary api_key=SECRETVALUE42"; });
    const revision = (await f.inspect()).workflowChange.headCommitHash;
    const source = sources(f);
    try {
      const out = join(f.root, "with-evidence"), again = join(f.root, "with-evidence-again"), plain = join(f.root, "plain");
      const result = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock, includeEvidence: true });
      expect(result).toMatchObject({ outcome: "published", status: "eligible" });
      const document = HandoverDocumentSchema.parse(JSON.parse(await readFile(join(out, "handover.json"), "utf8")));
      const packagedTexts = await Promise.all(document.evidence.map(async item => item.packaging.status === "packaged"
        ? await readFile(join(out, item.packaging.path), "utf8") : ""));
      // The accepted specification artifact carries the summary; packaged evidence of every allowed kind is redacted.
      const task = document.evidence[packagedTexts.findIndex(text => text.includes("Spec summary"))]!;
      expect(task).toMatchObject({ kind: "document", integrity: "verified" });
      expect(task.packaging).toMatchObject({ status: "packaged", redacted: true });
      if (task.packaging.status !== "packaged") throw new Error("not packaged");
      expect(task.packaging.path).toMatch(/^evidence\/[a-f0-9]{64}\.txt$/);
      for (const kind of ["patch", "test-result", "report"]) expect(document.evidence.some(item => item.packaging.status === "packaged" && item.kind === kind)).toBe(true);
      expect(document.evidence.filter(item => item.kind === "log").length).toBeGreaterThan(0);
      for (const text of packagedTexts) { expect(text).not.toContain(f.root); expect(text).not.toContain("SECRETVALUE42"); }
      const packaged = await readFile(join(out, task.packaging.path), "utf8");
      expect(packaged).toContain("[REDACTED]");
      expect(createHash("sha256").update(packaged).digest("hex")).toBe(task.packaging.sha256);
      for (const item of document.evidence) {
        if (["log", "agent-output"].includes(item.kind)) expect(item.packaging).toMatchObject({ status: "not_packaged", reason: "kind_not_allowed" });
        if (item.packaging.status === "packaged") expect(item.integrity).toBe("verified");
      }
      const manifest = HandoverManifestSchema.parse(JSON.parse(await readFile(join(out, "manifest.json"), "utf8")));
      expect(manifest.files).toContainEqual(expect.objectContaining({ path: task.packaging.path, sha256: task.packaging.sha256, mediaType: "text/plain; charset=utf-8" }));
      expect(await readFile(join(out, "index.html"), "utf8")).toContain(`href="${task.packaging.path}"`);
      expect(await readFile(join(out, "handover.md"), "utf8")).toContain(`](${task.packaging.path})`);
      expect(await verifyHandoverPackage(out)).toMatchObject({ valid: true, status: "eligible", problems: [] });

      const repeated = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: again, clock, includeEvidence: true });
      expect(repeated.contentDigest).toBe(result.contentDigest);
      const without = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: plain, clock });
      expect(without.contentDigest).not.toBe(result.contentDigest);
      expect((await readdir(plain)).includes("evidence")).toBe(false);

      await writeFile(join(again, task.packaging.path), "tampered\n");
      expect((await verifyHandoverPackage(again)).problems).toContain(`Hash mismatch for ${task.packaging.path}`);
      await writeFile(join(out, "evidence", "extra.txt"), "x");
      expect((await verifyHandoverPackage(out)).problems).toContain("Unlisted file evidence/extra.txt");
    } finally { source.close(); }
  }, 60_000);

  it("serializes exports to one target, tolerates an empty directory created before rename and leaves no lock behind", async () => {
    const f = await completed();
    const revision = (await f.inspect()).workflowChange.headCommitHash;
    const source = sources(f);
    try {
      const out = join(f.root, "locked");
      let concurrent: Promise<unknown> | undefined;
      const first = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock, faults: {
        afterFile: name => { if (name === "handover.json") concurrent = exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock }).catch(error => error); },
        beforeRename: async () => { await concurrent; }
      } });
      expect(first.outcome).toBe("published");
      const error = await concurrent;
      expect(error).toBeInstanceOf(HandoverConflictError);
      expect(String((error as Error).message)).toMatch(/in progress/);

      const raced = join(f.root, "raced");
      const published = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: raced, clock,
        faults: { beforeRename: async () => { await mkdir(raced); } } });
      expect(published.outcome).toBe("published");
      expect(await verifyHandoverPackage(raced)).toMatchObject({ valid: true, status: "eligible" });
      expect((await readdir(f.root)).filter(name => name.includes(".handover"))).toEqual([]);
    } finally { source.close(); }
  }, 60_000);

  it("replaces an older package of the same run only on request and never an unrelated directory", async () => {
    const f = await completed();
    const run = await f.inspect(), revision = run.workflowChange.headCommitHash;
    const draftJournal = await copyJournal(f, "journal-draft", state => { state.runs[0].status = "awaiting_approval"; delete state.runs[0].decision; });
    const out = join(f.root, "pkg");
    const draftSource = sources(f, draftJournal);
    try {
      const snapshot = (await inspectHandoverRun(draftSource, "run-1")).snapshotId;
      expect(await exportHandoverPackage(draftSource, { runId: "run-1", snapshot, outputDirectory: out, clock })).toMatchObject({ status: "draft" });
    } finally { draftSource.close(); }
    const source = sources(f);
    try {
      await expect(exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock })).rejects.toThrow(/another snapshot.*--replace/);
      const replaced = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock, replace: true });
      expect(replaced).toMatchObject({ outcome: "replaced", status: "eligible" });
      expect(await verifyHandoverPackage(out)).toMatchObject({ valid: true, status: "eligible" });
      expect((await readdir(f.root)).filter(name => name.includes(".handover"))).toEqual([]);
      expect(await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock, replace: true })).toMatchObject({ outcome: "reused" });

      const unrelated = join(f.root, "unrelated");
      await mkdir(unrelated); await writeFile(join(unrelated, "notes.txt"), "keep");
      await expect(exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: unrelated, clock, replace: true }))
        .rejects.toBeInstanceOf(HandoverConflictError);
      expect(await readFile(join(unrelated, "notes.txt"), "utf8")).toBe("keep");

      const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
      manifest.snapshot.runId = "run-2";
      await writeFile(join(out, "manifest.json"), JSON.stringify(manifest));
      await expect(exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock, replace: true })).rejects.toThrow(/same run/);
    } finally { source.close(); }
  }, 60_000);

  it("names an unsupported exporter version instead of reporting a generic conflict", async () => {
    const f = await completed();
    const revision = (await f.inspect()).workflowChange.headCommitHash;
    const source = sources(f);
    try {
      const out = join(f.root, "pkg");
      await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock });
      const manifest = JSON.parse(await readFile(join(out, "manifest.json"), "utf8"));
      manifest.exporter.version = 2;
      await writeFile(join(out, "manifest.json"), JSON.stringify(manifest));
      const verified = await verifyHandoverPackage(out);
      expect(verified.valid).toBe(false);
      expect(verified.problems.join("\n")).toMatch(/exporter version 2.*version 1/);
      await expect(exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock })).rejects.toThrow(/exporter version 2.*--replace/);
      expect(await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: out, clock, replace: true })).toMatchObject({ outcome: "replaced" });
    } finally { source.close(); }
  }, 60_000);

  it("refuses shared-writable artifact stores and output parents", async () => {
    const f = await completed();
    const revision = (await f.inspect()).workflowChange.headCommitHash;
    const artifacts = join(f.root, "artifacts"), mode = (await stat(artifacts)).mode & 0o7777;
    await chmod(artifacts, 0o770);
    let source = sources(f);
    try {
      const document = await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: join(f.root, "shared-store"), clock });
      expect(document.status).toBe("partial");
      expect(document.reasons.map(item => item.code)).toContain("evidence_integrity_failed");
    } finally { source.close(); await chmod(artifacts, mode); }
    source = sources(f);
    try {
      const shared = join(f.root, "shared"), sticky = join(f.root, "sticky");
      await mkdir(shared); await chmod(shared, 0o777);
      await expect(exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: join(shared, "pkg"), clock })).rejects.toThrow(/writable by other users/);
      expect(await readdir(shared)).toEqual([]);
      await mkdir(sticky); await chmod(sticky, 0o1777);
      expect(await exportHandoverPackage(source, { runId: "run-1", revision, outputDirectory: join(sticky, "pkg"), clock })).toMatchObject({ outcome: "published" });
      await rm(shared, { recursive: true });
    } finally { source.close(); }
  }, 60_000);
});
