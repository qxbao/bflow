import { describe, expect, it } from "vitest";
import { requiredRolesReady } from "../src/environment.js";

const pane = (role: string, paneId: string, extra: Record<string, unknown> = {}) =>
  ({ role, paneId, permanent: true, transportState: "idle", ...extra }) as never;
const roles = (...names: string[]) => names.map(role => ({ role, cli: "claude", required: true })) as never;

describe("required role readiness", () => {
  it("ignores a Runtime-owned profiled specialist pane left from an earlier generation", () => {
    // A stale non-permanent profiled reviewer pane made the role count 2, so bflow up waited until its timeout.
    const manifest = { status: "up", panes: [pane("conversation", "w1:p1"), pane("reviewer", "w1:p3"),
      pane("reviewer", "w1:p9", { permanent: false, transportState: "unknown" })] } as never;
    expect(requiredRolesReady(manifest, roles("conversation", "reviewer"))).toBe(true);
  });
  it("still refuses duplicate permanent panes, a missing role or an unready pane", () => {
    expect(requiredRolesReady({ status: "up", panes: [pane("reviewer", "a"), pane("reviewer", "b")] } as never, roles("reviewer"))).toBe(false);
    expect(requiredRolesReady({ status: "up", panes: [] } as never, roles("reviewer"))).toBe(false);
    expect(requiredRolesReady({ status: "up", panes: [pane("reviewer", "a", { transportState: "starting" })] } as never, roles("reviewer"))).toBe(false);
    expect(requiredRolesReady({ status: "initializing", panes: [pane("reviewer", "a")] } as never, roles("reviewer"))).toBe(false);
  });
  it("treats a legacy pane without the permanent flag as the role's startup pane", () => {
    expect(requiredRolesReady({ status: "up", panes: [pane("reviewer", "a", { permanent: undefined })] } as never, roles("reviewer"))).toBe(true);
  });
});
