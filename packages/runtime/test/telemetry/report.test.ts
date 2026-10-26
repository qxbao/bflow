import { createSampleWorkflowDefinition } from "../unit/fixtures.js";
import { describe, expect, it } from "vitest";
import { buildWorkflowTelemetry, readWorkflowTelemetry } from "../../src/telemetry/report.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 27, 0, 0, seconds)).toISOString();
function event(sequence: number, type: string, payload: unknown, taskId?: string, time = sequence) {
  return { schemaVersion: 1, eventId: `e-${sequence}`, runId: "run-1", sequence, aggregateVersion: sequence,
    occurredAt: at(time), correlationId: "c-1", idempotencyKey: `k-${sequence}`, type, payload,
    ...(taskId ? { taskId } : {}) };
}
const created = event(1, "run.created", { workflowId: "flow", workflowVersion: "1" });
const transition = (n: number, task: string, from: string, to: string, generation = 0, intent = "normal") =>
  event(n, "task.status_changed", { from, to, intent, attempt: 1, generationFrom: generation,
    generationTo: generation + (intent === "rework" ? 1 : 0) }, task);
const request = (n: number, id: string, revision = 1) => event(n, "approval.requested", {
  schemaVersion: 2, approvalId: id, runId: "run-1", target: { type: "run" }, revision, generation: 0,
  requestedBy: "owner", requestedAt: at(n), reason: "SECRET-PROMPT", evidence: [], idempotencyKey: id });
const decision = (n: number, id: string, revision = 1) => event(n, "approval.decided", {
  schemaVersion: 2, approvalId: id, runId: "run-1", target: { type: "run" }, revision, generation: 0,
  decidedBy: "owner", decidedAt: at(n), decision: "approved", feedbackArtifacts: [], idempotencyKey: `d-${id}` });
const build = (events: unknown[], extra = {}) => buildWorkflowTelemetry({ runId: "run-1", asOf: at(60), events,
  source: "legacy", complete: true, taskIds: ["task-1"], ...extra });

describe("workflow telemetry projection", () => {
  it("measures closed task intervals and produces the same report after duplicate, reordered replay/restart", () => {
    const events = [created, transition(2, "task-1", "pending", "ready"),
      transition(3, "task-1", "ready", "running"), transition(4, "task-1", "running", "succeeded")];
    const report = build(events);
    expect(report.taskStateTime.find(x => x.state === "running")?.durationMs).toBe(1000);
    expect(report.firstPass).toMatchObject({ value: 1, numerator: 1, denominator: 1, quality: "measured" });
    expect(build([...events.slice().reverse(), ...JSON.parse(JSON.stringify(events))])).toEqual(report);
  });
  it("counts distinct rework generations and excludes failed/cancelled/open tasks from success-conditional first pass", () => {
    const report = build([created, transition(2, "task-1", "pending", "ready"),
      transition(3, "task-1", "ready", "running"), transition(4, "task-1", "running", "succeeded"),
      transition(5, "task-1", "succeeded", "ready", 0, "rework"),
      transition(6, "task-1", "ready", "running", 1), transition(7, "task-1", "running", "succeeded", 1),
      transition(8, "task-1", "succeeded", "ready", 1, "rework"), transition(9, "task-1", "ready", "running", 2),
      transition(10, "task-1", "running", "succeeded", 2),
      transition(11, "failed-task", "pending", "ready"), transition(12, "failed-task", "ready", "running"),
      transition(13, "failed-task", "running", "failed"), transition(14, "cancelled-task", "pending", "cancelled")],
    { taskIds: ["task-1", "failed-task", "cancelled-task", "open-task"] });
    expect(report.reworkCycles).toMatchObject({ value: 2, quality: "measured" });
    expect(report.firstPass).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
    expect(report.cohort).toMatchObject({ succeeded: 1, failed: 1, cancelled: 1, incomplete: 1 });
  });
  it("does not close superseded or mismatched-revision approval waits using late decisions", () => {
    const report = build([created, request(2, "old"), request(3, "new", 2), decision(4, "old"),
      decision(5, "new", 1), decision(6, "new", 2)], { supersededApprovalIds: ["old"] });
    expect(report.approvalWait).toMatchObject({ value: 3000, denominator: 1, quality: "partial" });
    expect(report.approvals).toMatchObject({ superseded: 1, closed: 1, open: 0 });
    expect(JSON.stringify(report)).not.toContain("SECRET-PROMPT");
  });
  it("measures gate turnaround once without claiming execution time or tokens", () => {
    const start = event(2, "quality_gate.evaluation_requested", { evaluationId: "eval", gateId: "gate" });
    const end = event(3, "quality_gate.evaluated", { evaluationId: "eval", gateId: "gate", runId: "run-1",
      status: "failed", findings: [], producedArtifacts: [], evaluatedAt: at(3) });
    const report = build([created, start, end, end]);
    expect(report.gateTurnaround).toMatchObject({ value: 1000, denominator: 1, quality: "partial" });
    expect(report.gateExecution).toMatchObject({ value: null, quality: "unavailable" });
    expect(report.tokens).toMatchObject({ value: null, quality: "unavailable" });
    expect(report.costUsd).toMatchObject({ value: null, quality: "unavailable" });
  });
  it("marks missing timestamps, sequence gaps, reversed time and conflicting identities partial without zeros", () => {
    const invalid = { ...transition(2, "task-1", "pending", "ready"), occurredAt: undefined };
    const report = build([created, invalid, transition(3, "task-1", "ready", "running"),
      { ...transition(4, "task-1", "running", "succeeded"), occurredAt: at(0) }]);
    expect(report.coverage.quality).toBe("partial");
    expect(report.firstPass.value).toBeNull();
    expect(report.taskStateTime.find(x => x.state === "running")?.durationMs ?? null).toBeNull();
    const conflict = build([created, transition(2, "task-1", "pending", "ready"),
      { ...transition(2, "task-1", "pending", "ready"), occurredAt: at(9) }]);
    expect(conflict.firstPass.value).toBeNull();
    expect(conflict.coverage.diagnostics).toContain("conflicting_identity");
  });
  it("counts open time separately from closed means and never infers missing reuse or clarification", () => {
    const report = build([created, transition(2, "task-1", "pending", "ready"),
      transition(3, "task-1", "ready", "running")]);
    expect(report.taskStateTime.find(x => x.state === "running")).toMatchObject({ durationMs: null, openLowerBoundMs: 57000 });
    expect(report.evidenceReuse.value).toBeNull();
    expect(report.clarificationWait.value).toBeNull();
    expect(build([created]).firstPass).toMatchObject({ value: null, denominator: 0 });
  });
  it("separates retry from rework and prevents a retried success from improving first-pass", () => {
    const report = build([created, transition(2, "task-1", "pending", "ready"), transition(3, "task-1", "ready", "running"),
      transition(4, "task-1", "running", "failed"), transition(5, "task-1", "failed", "retrying", 0, "retry"),
      transition(6, "task-1", "retrying", "ready"), transition(7, "task-1", "ready", "running"),
      transition(8, "task-1", "running", "succeeded")]);
    expect(report.retryAttempts.value).toBe(1);
    expect(report.reworkCycles.value).toBe(0);
    expect(report.firstPass).toMatchObject({ value: 0, denominator: 1 });
  });
  it("uses event observation times rather than payload timestamp claims for approval waits", () => {
    const start = request(2, "approval"), end = decision(3, "approval");
    start.payload.requestedAt = at(0);
    end.payload.decidedAt = at(50);
    expect(build([created, start, end]).approvalWait.value).toBe(1000);
  });
  it("rejects aggregate-version/idempotency batch inconsistencies using the shared validator", () => {
    const bad = { ...transition(2, "task-1", "pending", "ready"), aggregateVersion: 99 };
    const report = build([created, bad, transition(3, "task-1", "ready", "running"), transition(4, "task-1", "running", "succeeded")]);
    expect(report.coverage.diagnostics).toContain("invalid_event_batch");
    expect(report.firstPass.value).toBeNull();
  });
  it("never manufactures zero rework/retry counts from a source with gaps or missing approval requests", () => {
    const report = build([created, transition(3, "task-1", "ready", "running")], { supersededApprovalIds: ["missing"] });
    expect(report.reworkCycles.value).toBeNull();
    expect(report.retryAttempts.value).toBeNull();
    expect(report.coverage.diagnostics).toContain("superseded_request_missing");
  });
  it("quarantines conflicting command identities instead of inflating rework or durations", () => {
    const events = [created, transition(2, "task-1", "pending", "ready"), transition(3, "task-1", "ready", "running"),
      transition(4, "task-1", "running", "succeeded"), transition(5, "task-1", "succeeded", "ready", 0, "rework"),
      transition(6, "task-1", "ready", "running", 1), transition(7, "task-1", "running", "succeeded", 1),
      { ...transition(8, "task-1", "succeeded", "ready", 1, "rework"), idempotencyKey: "k-5" }];
    const report = build(events);
    expect(report.reworkCycles.value).toBeNull();
    expect(report.taskStateTime.every(row => row.durationMs === null)).toBe(true);
    expect(report.coverage.diagnostics).toContain("invalid_event_batch");
  });
  it("separates pending cancelled and deadline-expired approvals without inventing closed wait durations", () => {
    const pending = request(2, "approval"), expired = request(3, "expired");
    expired.payload.expiresAt = at(10);
    const report = build([created, pending, expired, event(4, "run.status_changed", { from: "queued", to: "cancelled" })]);
    expect(report.approvals).toMatchObject({ cancelled: 1, expired: 1, open: 0, closed: 0 });
    expect(report.approvalWait.value).toBeNull();
    expect(report.approvalWait.denominator).toBe(0);
  });
  it("reads a bounded paginated prefix and reports source failures without leaking their contents", async () => {
    const definition = createSampleWorkflowDefinition();
    const snapshot = { runId: "run-1", workflowId: definition.id, workflowVersion: definition.version,
      createdAt: at(1), updatedAt: at(2), version: 2, tasks: [], lastEventSequence: 2, status: "running" };
    const store: any = { get: async () => ({ ok: true, value: { snapshot, definition } }),
      readEvents: async (_: string, page: any) => ({ ok: true, value: page.cursor
        ? { items: [transition(2, "task-1", "pending", "ready"), transition(3, "task-1", "ready", "running")],  }
        : { items: [created], nextCursor: "page2" } }) };
    const report = await readWorkflowTelemetry(store, "run-1", { asOf: at(60) });
    expect(report.coverage.highWaterMark).toBe(2);
    expect(report.coverage.events).toBe(2);
    store.readEvents = async () => { throw new Error("SECRET-PROMPT"); };
    const failed = await readWorkflowTelemetry(store, "run-1", { asOf: at(60) });
    expect(failed.coverage.quality).toBe("unavailable");
    expect(JSON.stringify(failed)).not.toContain("SECRET-PROMPT");
  });
});
