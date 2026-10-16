import { describe, expect, it } from "vitest";
import { isShellReadyForAgent, parsePaneProcessInfoResult } from "../src/runner.js";
import type { HerdrPaneInfo } from "../src/types.js";
const pane: HerdrPaneInfo = { paneId: "p1", workspaceId: "w1", tabId: "t1", terminalId: "term1", agent: null, agentStatus: "idle", focused: false, revision: 1 };
const response = (process_info: unknown) => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ id: "1", result: { type: "pane_process_info", process_info } }) });
describe("native shell observation readiness", () => {
  it("accepts schema-valid pending metadata without treating it as an empty ready foreground", () => {
    const pending = parsePaneProcessInfoResult(response({ pane_id: "p1" }));
    expect(pending.foregroundSnapshotPending).toBe(true); expect(isShellReadyForAgent(pane, pending).ready).toBe(false);
    const ready = parsePaneProcessInfoResult(response({ pane_id: "p1", shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [] }));
    expect(isShellReadyForAgent(pane, ready).ready).toBe(true);
    expect(isShellReadyForAgent(pane, { ...ready, paneId: "other-pane" }).ready).toBe(false);
  });
  it("still rejects malformed foreground data and a genuinely busy shell", () => {
    expect(() => parsePaneProcessInfoResult(response({ pane_id: "p1", foreground_processes: "bad" }))).toThrow("Invalid foreground");
    const busy = parsePaneProcessInfoResult(response({ pane_id: "p1", shell_pid: 10, foreground_process_group_id: 11, foreground_processes: [{pid:11,name:"editor"}] }));
    expect(isShellReadyForAgent(pane, busy).ready).toBe(false);
  });
});
