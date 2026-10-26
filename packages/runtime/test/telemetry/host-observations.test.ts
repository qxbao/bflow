import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { buildWorkflowTelemetry } from "../../src/telemetry/report.js";
import { enrichHostTelemetry } from "../../src/telemetry/host-observations.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const asOf = "2026-10-27T00:01:00Z";
it("counts host regression selection receipts once after reopen and omits sensitive widening paths", async () => {
  const root = await mkdtemp("/tmp/bflow-telemetry-"); roots.push(root);
  const journal = new HostReceiptJournal(`${root}/receipts`, root, "session");
  const gate = { evaluationId: "eval-1", gateId: "host-regression-v", runId: "run-1", status: "passed" as const,
    findings: [], producedArtifacts: [], evaluatedAt: "2026-10-27T00:00:20Z", metadata: {
      verification: { executorId: "bflow-host-regression-check", independentExecution: true },
      regression: { widening: [{ path: "SECRET-PATH", tier: "full", reason: "root_config:SECRET-PATH" }], selectedTestPaths: ["SECRET-PATH"] } } };
  await journal.recordGate(gate); await journal.recordGate(gate);
  await journal.recordGate({ ...gate, evaluationId: "eval-2", metadata: { ...gate.metadata, regression: { widening: [], selectedTestPaths: [] } } });
  const report = buildWorkflowTelemetry({ runId: "run-1", asOf, source: "agentic", events: [], taskIds: [], complete: false });
  const observations = await journal.telemetryObservations("run-1", asOf);
  const enriched = enrichHostTelemetry(report, observations);
  expect(enriched.regressionWidening).toMatchObject({ value: 0.5, numerator: 1, denominator: 2, quality: "partial" });
  expect(enriched.regressionWideningDetails).toEqual([{ reason: "root_config", tier: "full", count: 1 }]);
  expect(JSON.stringify(enriched)).not.toContain("SECRET-PATH");
  expect(await new HostReceiptJournal(`${root}/receipts`, root, "session").telemetryObservations("run-1", asOf)).toEqual(observations);
});
it("does not count arbitrary metadata as host measurement and does not turn absent selection into zero", async () => {
  const root = await mkdtemp("/tmp/bflow-telemetry-"); roots.push(root);
  const journal = new HostReceiptJournal(`${root}/receipts`, root, "session");
  await journal.recordGate({ evaluationId: "eval-1", gateId: "other", runId: "run-1", status: "passed", findings: [],
    producedArtifacts: [], evaluatedAt: "2026-10-27T00:00:20Z", metadata: { regression: { widening: [] } } });
  const report = buildWorkflowTelemetry({ runId: "run-1", asOf, source: "agentic", events: [], taskIds: [], complete: false });
  expect(enrichHostTelemetry(report, await journal.telemetryObservations("run-1", asOf)).regressionWidening.value).toBeNull();
});
it("measures only host-generated phase timestamps with an authenticated role binding", async () => {
  const root = await mkdtemp("/tmp/bflow-telemetry-"); roots.push(root);
  const journal = new HostReceiptJournal(`${root}/receipts`, root, "session");
  const binding = { schemaVersion: 2 as const, bindingId: "binding", sessionId: "session", role: "tester" as const,
    agentId: "tester", paneId: "pane", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude",
    cwd: root, isolationMode: "dedicated_pane" as const, readOnlyWorkspace: true, permanent: true, transportState: "idle" as const,
    boundAt: "2026-10-27T00:00:00Z", session: { source: "herdr:claude", kind: "id" as const, value: "native" } };
  const artifact = { trust: "stored" as const, artifactId: "artifact-1", runId: "run-1", taskId: "task-1", kind: "test-result" as const,
    uri: "artifact://store/artifact-1", mediaType: "application/json", checksum: { algorithm: "sha256" as const, value: "a".repeat(64) },
    createdAt: "2026-10-27T00:00:20Z" };
  const result = { schemaVersion: 2 as const, verificationId: "verify-1", runId: "run-1", taskId: "task-1", cycleNumber: 1,
    attemptId: "attempt", status: "passed" as const, independentExecution: true as const,
    evaluatedCriteria: [{ criterionId: "criterion", passed: true, evidenceArtifactId: artifact.artifactId, summary: "SECRET-PROMPT" }],
    qualityGateResults: [], evidenceArtifacts: [artifact], findings: [], verifiedBy: "tester" as const,
    startedAt: "2026-10-27T00:00:10Z", completedAt: "2026-10-27T00:00:20Z",
    metadata: { conditionalTdd: { phase: "green" }, hostBehavioralMeasurements: [], hostVerifierBinding: binding } };
  await journal.recordEvidence(result);
  await journal.recordEvidence({ ...result, verificationId: "agent-claim", metadata: {} });
  const report = buildWorkflowTelemetry({ runId: "run-1", asOf, source: "agentic", events: [], taskIds: [], complete: false });
  const enriched = enrichHostTelemetry(report, await journal.telemetryObservations("run-1", asOf));
  expect(enriched.phaseRoleTime).toMatchObject({ value: 10000, denominator: 1, quality: "partial" });
  expect(enriched.phaseRoleIntervals).toEqual([{ phase: "green", role: "tester", durationMs: 10000, operations: 1 }]);
  expect(JSON.stringify(enriched)).not.toContain("SECRET-PROMPT");
});
it("keeps Core coverage distinct and downgrades overall coverage if host receipts are inaccessible", () => {
  const report = buildWorkflowTelemetry({ runId: "run-1", asOf, source: "agentic", taskIds: [], complete: true,
    events: [{ schemaVersion: 1, eventId: "created", runId: "run-1", sequence: 1, aggregateVersion: 1,
      occurredAt: "2026-10-27T00:00:00Z", correlationId: "c", idempotencyKey: "k", type: "run.created",
      payload: { workflowId: "flow", workflowVersion: "1" } }] });
  const enriched = enrichHostTelemetry(report, { complete: false, regression: [], phases: [] });
  expect(enriched.coverage.quality).toBe("partial");
  expect(enriched.sourceCoverage).toMatchObject({ coreEvents: "measured", hostReceipts: "partial" });
});
