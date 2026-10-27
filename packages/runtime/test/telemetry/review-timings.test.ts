import { describe, expect, it } from "vitest";
import { buildWorkflowTelemetry, readWorkflowTelemetry, type ReviewTimingObservation } from "../../src/telemetry/report.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 27, 0, 0, seconds)).toISOString();
const timing = (value: Partial<ReviewTimingObservation> & Pick<ReviewTimingObservation, "gateId" | "role" | "startedAt">): ReviewTimingObservation =>
  ({ timeoutMs: 20_000, ...value });
const build = (reviewTimings: ReviewTimingObservation[], extra = {}) => buildWorkflowTelemetry({ runId: "run-1", asOf: at(60),
  source: "agentic", events: [], complete: false, taskIds: [], reviewTimings, ...extra });

describe("host review gate timings in workflow telemetry", () => {
  it("averages only closed intervals and groups details by gate, role and provider", () => {
    const report = build([
      timing({ gateId: "review", role: "reviewer", provider: "codex", startedAt: at(10), completedAt: at(14), outcome: "verdict" }),
      timing({ gateId: "review", role: "reviewer", provider: "codex", startedAt: at(20), completedAt: at(26), outcome: "timeout" }),
      timing({ gateId: "review", role: "reviewer", provider: "codex", startedAt: at(50), completedAt: at(70), outcome: "verdict" }),
      timing({ gateId: "review", role: "reviewer", provider: "claude", startedAt: at(30), nearDeadlineAt: at(31) }),
      timing({ gateId: "qa", role: "qa", startedAt: at(40), completedAt: at(41), outcome: "rejected" }),
      timing({ gateId: "review", role: "reviewer", provider: "codex", startedAt: at(45), completedAt: at(44), outcome: "verdict" }),
      timing({ gateId: "review", role: "reviewer", provider: "codex", startedAt: at(90), completedAt: at(91), outcome: "verdict" })
    ]);
    // Closed: 4 s, 6 s and 1 s. The wait settled after asOf, the reversed interval and the future start are excluded.
    expect(report.gateExecution).toMatchObject({ value: 11_000 / 3, numerator: 11_000, denominator: 3, quality: "partial", unit: "ms",
      source: "host_review_gate_timings" });
    expect(report.gateExecution.limitation).toContain("Native review gates only");
    expect(report.reviewGateDetails).toEqual([
      { gateId: "qa", role: "qa", provider: null, operations: 1, durationMs: 1_000, maxMs: 1_000, timeouts: 0, nearDeadline: 0, open: 0 },
      { gateId: "review", role: "reviewer", provider: "claude", operations: 0, durationMs: 0, maxMs: 0, timeouts: 0, nearDeadline: 1, open: 1 },
      { gateId: "review", role: "reviewer", provider: "codex", operations: 2, durationMs: 10_000, maxMs: 6_000, timeouts: 1, nearDeadline: 0, open: 1 }
    ]);
    expect(report.coverage.diagnostics).toContain("invalid_time_order");
  });
  it("keeps gateExecution unavailable with no closed wait and never reports open waits as a mean", () => {
    const open = build([timing({ gateId: "review", role: "reviewer", provider: "codex", startedAt: at(10), nearDeadlineAt: at(30) })]);
    expect(open.gateExecution).toMatchObject({ value: null, numerator: null, denominator: 0, quality: "unavailable" });
    expect(open.reviewGateDetails).toEqual([{ gateId: "review", role: "reviewer", provider: "codex", operations: 0, durationMs: 0, maxMs: 0,
      timeouts: 0, nearDeadline: 1, open: 1 }]);
    const empty = build([]);
    expect(empty.gateExecution).toMatchObject({ value: null, quality: "unavailable", denominator: 0 });
    expect(empty.reviewGateDetails).toEqual([]);
  });
  it("leaves legacy reports unchanged even when timings are supplied", () => {
    const legacy = build([timing({ gateId: "review", role: "reviewer", startedAt: at(10), completedAt: at(14), outcome: "verdict" })],
      { source: "legacy" });
    expect(legacy.gateExecution).toMatchObject({ value: null, quality: "unavailable", source: "none" });
    expect(legacy.reviewGateDetails).toEqual([]);
  });
  it("keeps review timings when the Core event source is unavailable", async () => {
    const store: any = { get: async () => { throw new Error("SECRET-PROMPT"); } };
    const report = await readWorkflowTelemetry(store, "run-1", { asOf: at(60), source: "agentic", reviewTimings: [
      timing({ gateId: "review", role: "reviewer", provider: "codex", startedAt: at(10), completedAt: at(12), outcome: "verdict" })] });
    expect(report.coverage.diagnostics).toContain("source_unavailable");
    expect(report.gateExecution).toMatchObject({ value: 2_000, denominator: 1 });
    expect(JSON.stringify(report)).not.toContain("SECRET-PROMPT");
  });
});
