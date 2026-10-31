import { z } from "zod";
import { ArtifactReferenceSchema, QualityGateDefinitionSchema, type QualityGateContext } from "@bflow/contracts";
import { verificationGit } from "./behavioral-runner.js";
import { parseNameStatus } from "./regression-changes.js";
import { analyzeTestIntegrity, TestIntegrityReportSchema, type TestIntegrityReport } from "./test-integrity.js";
import { record, textField } from "./journal.js";

const integrityGit = (cwd: string, args: string[]) => verificationGit(cwd, ["--no-replace-objects", ...args]);

export const TEST_INTEGRITY_CHECK = QualityGateDefinitionSchema.parse({
  id: "host-test-integrity", name: "Committed test integrity against base revision", evaluator: "host-test-integrity", required: true,
  timeout: { executionTimeoutMs: 60_000, onTimeout: "block" },
  metadata: { requiresIndependentReview: true },
  configuration: { kind: "deterministic", method: "static_analysis", command: "host:test-integrity", criterionIds: [], testNames: [], role: "quality_gate", levels: [] }
});
export const TestIntegrityObservationSchema = z.object({
  report: TestIntegrityReportSchema, evidence: ArtifactReferenceSchema
}).strict();
export type TestIntegrityObservation = z.infer<typeof TestIntegrityObservationSchema>;
export const TestIntegrityVerdictSchema = z.object({
  findingId: z.string().min(1), verdict: z.enum(["equivalent", "confirmed_violation"]), reason: z.string().trim().min(10).max(4000),
  evidence: z.array(z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/),
    path: z.string().min(1).max(4096).refine(path => !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && path.split("/").every(part => part && part !== "." && part !== "..")),
    line: z.number().int().positive(), excerpt: z.string().trim().min(1).max(4096) }).strict()).min(1).max(8)
}).strict();
export const TestIntegrityGrantSchema = z.object({
  findingId: z.string().min(1), approvalId: z.string().min(1), reason: z.string().trim().min(1), decidedBy: z.string().min(1)
}).strict();
export type TestIntegrityGrant = z.infer<typeof TestIntegrityGrantSchema>;
/** Read immutable blobs, not the task's filesystem. Git filters, external diff and candidate configuration are never executed. */
export async function measureTestIntegrity(cwd: string, baseRevision: string, candidateRevision: string): Promise<TestIntegrityReport> {
  if (![baseRevision, candidateRevision].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error("Test integrity requires pinned Git revisions");
  const started = Date.now();
  const changed = parseNameStatus(await integrityGit(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames", baseRevision, candidateRevision, "--"]));
  // Include deleted fixtures/configs as inputs too; only AST test declarations count as removed tests.
  const relevant = changed.filter(item => [item.path, item.previousPath ?? ""].some(path =>
    /(^|\/)(?:test|tests|__tests__|spec|fixtures?|__fixtures__|e2e|playwright|cypress)\/|\.(?:test|spec|e2e)\.|(^|\/)test_[^/]+\.|_test\.|(?:Test|Tests|Spec)\.[^/]+$|(^|\/)(?:package\.json|(?:vitest|jest|playwright|vite|nyc|\.nycrc|pytest|tox|setup|pyproject|Cargo|pom|build\.gradle)[^/]*|\.mocharc[^/]*)$/i.test(path) &&
    (/\.(?:[cm]?[jt]sx?|py|go|rs|rb|java|kt|cs|php|swift|cpp|cc|cxx|dart|exs|json|ya?ml|toml|ini|cfg|xml)$/i.test(path) || /\.(?:test|spec|e2e)\.|(^|\/)(?:\.nycrc|\.mocharc)$/.test(path))));
  if (relevant.length > 256) throw new Error("Test integrity changed-file limit exceeded (256); split the candidate for review");
  let totalBytes = 0;
  const blob = async (revision: string, path: string): Promise<string> => {
    if (Date.now() - started > 45_000) throw new Error("Test integrity capture deadline exceeded");
    const literal = (await integrityGit(cwd, ["ls-tree", "-z", revision, "--", path])).split("\0").find(item => item.slice(item.indexOf("\t") + 1) === path);
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t/.exec(literal ?? "");
    if (!match) throw new Error(`Test integrity needs a regular committed blob: ${revision}:${path}`);
    const size = Number((await integrityGit(cwd, ["cat-file", "-s", match[2]!])).trim());
    if (!Number.isSafeInteger(size) || size < 0 || size > 1_048_576 || totalBytes + size > 8_388_608) throw new Error("Test integrity blob/aggregate size limit exceeded");
    totalBytes += size;
    const result = await integrityGit(cwd, ["cat-file", "blob", match[2]!]);
    if (result.includes("\0")) throw new Error(`Test integrity cannot parse binary test/config: ${path}`);
    return result;
  };
  const files = [];
  for (const change of relevant) {
    if (change.status === "T") throw new Error(`Test integrity cannot analyze a file type change: ${change.path}`);
    files.push({ path: change.path,
      ...(change.previousPath ? { previousPath: change.previousPath } : {}),
      ...(change.status !== "A" ? { base: await blob(baseRevision, change.previousPath ?? change.path) } : {}),
      ...(change.status !== "D" ? { candidate: await blob(candidateRevision, change.path) } : {}) });
  }
  return TestIntegrityReportSchema.parse(analyzeTestIntegrity({ baseRevision, candidateRevision, files }));
}
export function testIntegrityAuthorityInput(context: QualityGateContext) {
  const input = record(context.input);
  return { runId: context.runId, taskId: textField(context.taskId), attemptId: textField(context.attemptId),
    baseRevision: textField(input.baseRevision), candidateRevision: textField(input.sourceRevision), specFingerprint: textField(input.specFingerprint), scope: textField(input.scope) };
}
/** Source anchors substantiate Reviewer reasoning without trusting caller-invented ArtifactReferences. */
export async function validateTestIntegrityEvidence(cwd: string, report: TestIntegrityReport, verdicts: z.infer<typeof TestIntegrityVerdictSchema>[]) {
  const sources = new Map<string, string[]>();
  let bytes = 0;
  for (const verdict of verdicts) for (const anchor of verdict.evidence) {
    if (anchor.revision !== report.baseRevision && anchor.revision !== report.candidateRevision) throw new Error("Test-integrity evidence revision differs from observed base/candidate");
    const key = JSON.stringify([anchor.revision, anchor.path]);
    let lines = sources.get(key);
    if (!lines) {
      if (sources.size >= 64) throw new Error("Test-integrity evidence file limit exceeded");
      const entry = (await integrityGit(cwd, ["ls-tree", "-z", anchor.revision, "--", anchor.path])).split("\0").find(item => item.slice(item.indexOf("\t") + 1) === anchor.path);
      const match = /^(100644|100755) blob ([a-f0-9]{40})\t/.exec(entry ?? "");
      if (!match) throw new Error("Test-integrity evidence requires an existing regular Git blob");
      const size = Number((await integrityGit(cwd, ["cat-file", "-s", match[2]!])).trim());
      if (!Number.isSafeInteger(size) || size < 0 || size > 1_048_576 || bytes + size > 8_388_608) throw new Error("Test-integrity evidence blob bounds exceeded");
      bytes += size;
      lines = (await integrityGit(cwd, ["cat-file", "blob", match[2]!])).split(/\r?\n/);
      sources.set(key, lines);
    }
    const excerptLines = anchor.excerpt.split(/\r?\n/);
    const matchesCommitted = excerptLines.every(
      (expectedLine, offset) =>
        anchor.line - 1 + offset < lines.length &&
        lines[anchor.line - 1 + offset]?.trim() === expectedLine.trim()
    );
    if (!matchesCommitted) throw new Error("Test-integrity evidence excerpt does not match the exact committed line");
  }
}
/** Every suspicion is explicitly adjudicated; a syntactic fact is never silently upgraded to a semantic violation. */
export function adjudicateTestIntegrity(report: TestIntegrityReport, rawVerdicts: unknown, rawGrants: unknown) {
  const verdicts = z.array(TestIntegrityVerdictSchema).parse(rawVerdicts ?? []);
  const grants = z.array(TestIntegrityGrantSchema).parse(rawGrants);
  if (new Set(verdicts.map(item => item.findingId)).size !== verdicts.length) throw new Error("Duplicate test-integrity verdict ID");
  const ids = report.findings.map(item => item.id).sort();
  if (JSON.stringify(verdicts.map(item => item.findingId).sort()) !== JSON.stringify(ids)) throw new Error("Test-integrity verdicts must cover exactly every observed finding ID");
  for (const verdict of verdicts) {
    const finding = report.findings.find(item => item.id === verdict.findingId)!;
    if (finding.classification === "proven_violation" && verdict.verdict === "equivalent") throw new Error("Proven test-integrity violation requires owner exception, not equivalent verdict");
  }
  const unresolved = verdicts.filter(item => item.verdict === "confirmed_violation" && !grants.some(grant => grant.findingId === item.findingId));
  return { verdicts, grants: grants.filter(grant => ids.includes(grant.findingId)), unresolved };
}
