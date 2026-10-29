import { describe, expect, it } from "vitest";
import { startupPanesHealthy } from "../src/role-pane-manager.js";

const pane = (role: string, transportState: string, permanent = true) => ({ role, transportState, permanent }) as never;
describe("startup topology health", () => {
  it("does not let a stale Runtime-owned profiled specialist pane keep the topology degraded", () => {
    // Herdr restores a profiled reviewer pane whose provider died with the previous host; Runtime reconciles it after activation.
    expect(startupPanesHealthy([pane("conversation", "idle"), pane("reviewer", "idle"), pane("reviewer", "unknown", false)])).toBe(true);
    expect(startupPanesHealthy([pane("conversation", "idle"), pane("developer", "disconnected", false)])).toBe(true);
  });
  it("still requires every permanent role pane to be healthy", () => {
    expect(startupPanesHealthy([pane("conversation", "idle"), pane("reviewer", "unknown")])).toBe(false);
    expect(startupPanesHealthy([pane("qa", "blocked")])).toBe(false);
    expect(startupPanesHealthy([pane("qa", "working"), pane("planner", "done"), pane("architect", "accepted")])).toBe(true);
  });
});
