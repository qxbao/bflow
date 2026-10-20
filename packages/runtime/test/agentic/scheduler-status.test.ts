import { describe, expect, it } from "vitest";
import { schedulerStatusReport } from "../../src/agentic/scheduler-status.js";

const healthy = { timerAlive: true, quiesced: false, workspaceOpen: true, tickInFlight: false };
describe("host_status scheduler report", () => {
  it("reports an active scheduler between ticks, where the legacy in-flight flag reads false", () => {
    const report = schedulerStatusReport({ ...healthy, lastTickAt: "2026-10-20T07:00:00.000Z" });
    expect(report.schedulerRunning).toBe(false);
    expect(report.schedulerActive).toBe(true);
    expect(report.schedulerLastTickAt).toBe("2026-10-20T07:00:00.000Z");
    expect(report.schedulerError).toBeNull();
  });
  it("reports the in-flight tick through the legacy field while keeping the timer active", () => {
    const report = schedulerStatusReport({ ...healthy, tickInFlight: true });
    expect(report.schedulerRunning).toBe(true);
    expect(report.schedulerActive).toBe(true);
    expect(report.schedulerLastTickAt).toBeNull();
  });
  it("is inactive while quiesced, without a workspace, or after the timer was stopped", () => {
    expect(schedulerStatusReport({ ...healthy, quiesced: true }).schedulerActive).toBe(false);
    expect(schedulerStatusReport({ ...healthy, workspaceOpen: false }).schedulerActive).toBe(false);
    expect(schedulerStatusReport({ ...healthy, timerAlive: false }).schedulerActive).toBe(false);
  });
  it("surfaces the last scheduler error without hiding it", () => {
    expect(schedulerStatusReport({ ...healthy, error: "Runtime tick failed" }).schedulerError).toBe("Runtime tick failed");
  });
});
