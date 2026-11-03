import { describe, expect, it, vi } from "vitest";
import { PaneBindingSchema, SessionManifestSchema } from "@bflow/contracts";
import { RolePaneManager } from "../src/role-pane-manager.js";
import { InMemorySessionManifestStore } from "../src/manifest-store.js";
async function fixture(authorized?: boolean | "throws", clean = false) {
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "dev-binding", sessionId: "session-1", role: "developer",
    paneGroup: "developer_worktree", agentId: "dev", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2", provider: "herdr", agentKind: "codex",
    cwd: "/repo/task", worktreePath: "/repo/task", isolationMode: "dedicated_pane", readOnlyWorkspace: false, permanent: false,
    transportState: "idle", boundAt: new Date().toISOString(), metadata: { runId: "run-1", taskId: "run-1-task", allocationStatus: "active" } });
  const store = new InMemorySessionManifestStore();
  await store.save(SessionManifestSchema.parse({ schemaVersion: 2, sessionId: "session-1", projectName: "test", workspaceRoot: "/repo",
    herdrWorkspaceId: "w1", herdrTabId: "w1:t1", status: "up", conversationSessionId: "conv-1", activeRunIds: [], panes: [binding, PaneBindingSchema.parse({ ...binding, bindingId: "chat-binding", role: "conversation", paneGroup: "conversation", agentId: "chat", paneId: "chat", cwd: "/repo", worktreePath: undefined, readOnlyWorkspace: true, permanent: true, metadata: {} }), PaneBindingSchema.parse({ ...binding, bindingId: "coord-binding", role: "coordinator", paneGroup: "coordination", agentId: "coordinator", paneId: "coord", cwd: "/repo", worktreePath: undefined, readOnlyWorkspace: true, permanent: true, metadata: {} })],
    attachTarget: { role: "conversation", paneId: "chat" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const run = vi.fn(async () => { throw new Error("Metadata-only retention must not run a Herdr mutation"); });
  const proof = vi.fn(async () => { if (authorized === "throws") throw new Error("scope record mode 0644"); return authorized === true; });
  const manager = new RolePaneManager({ config: { sessionId: "session-1", projectName: "test", workspaceRoot: "/repo", conversationSessionId: "conv-1" },
    store, runner: { run }, worktreeInspector: { inspect: async () => ({ ok: true, value: { exists: true, isClean: clean, dirtyFiles: clean ? [] : ["guide.md"] } }) },
    ...(authorized === undefined ? {} : { authorizeStoppedRetainedRelease: proof }) });
  return { manager, store, run, proof, binding };
}
describe("stopped retained Developer allocations", () => {
  it.each([undefined, false])("retains the existing dirty-worktree guard without an authenticated host proof: %s", async authorized => {
    const f = await fixture(authorized);
    expect(await f.manager.releaseDeveloper({ taskId: "run-1-task", closePane: false, removeWorktree: false })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const saved = await f.store.load("session-1");
    expect(saved.ok && saved.value?.panes[0]?.metadata?.allocationStatus).toBe("active");
    expect(f.run).not.toHaveBeenCalled();
  });
  it("releases only write authority, retaining dirty work and its pane after the host proves the exact process scope stopped", async () => {
    const f = await fixture(true);
    expect((await f.manager.releaseDeveloper({ taskId: "run-1-task", closePane: false, removeWorktree: false })).ok).toBe(true);
    expect(f.proof).toHaveBeenCalledWith(f.binding);
    const saved = await f.store.load("session-1");
    expect(saved.ok && saved.value?.panes[0]).toMatchObject({ readOnlyWorkspace: true, worktreePath: "/repo/task", metadata: { allocationStatus: "released" } });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("never consults the host proof for a clean worktree, so a scope integrity error cannot fail an ordinary release", async () => {
    const f = await fixture("throws", true);
    expect((await f.manager.releaseDeveloper({ taskId: "run-1-task", closePane: false, removeWorktree: false })).ok).toBe(true);
    expect(f.proof).not.toHaveBeenCalled();
    const saved = await f.store.load("session-1");
    expect(saved.ok && saved.value?.panes[0]).toMatchObject({ readOnlyWorkspace: false, metadata: { allocationStatus: "released" } });
  });
  it.each([{ closePane: true, removeWorktree: false }, { closePane: false, removeWorktree: true }])("never permits destructive dirty-worktree cleanup through the proof callback: %s", async request => {
    const f = await fixture(true);
    expect(await f.manager.releaseDeveloper({ taskId: "run-1-task", ...request })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.proof).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
});
describe("closing a cancelled Developer pane", () => {
  const closable = async (pane: { present?: boolean; closeFails?: boolean } = {}) => {
    const f = await fixture();
    const calls: string[][] = [];
    const ok = { exitCode: 0, stdout: JSON.stringify({ id: "1", result: { type: "ok" } }), stderr: "" };
    const missing = { exitCode: 1, stdout: "", stderr: JSON.stringify({ id: "1", error: { code: "pane_not_found", message: "pane not found" } }) };
    const manager = new RolePaneManager({ config: { sessionId: "session-1", projectName: "test", workspaceRoot: "/repo", conversationSessionId: "conv-1" }, store: f.store,
      runner: { run: async (invocation: { args: readonly string[] }) => {
        calls.push([...invocation.args]);
        if (invocation.args.includes("close")) return pane.closeFails ? { exitCode: 1, stdout: "", stderr: "busy" } : ok;
        return pane.present ? { exitCode: 0, stdout: JSON.stringify({ id: "1", result: { type: "pane_info", pane: { pane_id: "w1:p2" } } }), stderr: "" } : missing;
      } } as never,
      worktreeInspector: { inspect: async () => { throw new Error("Closing a cancelled pane must not inspect the worktree"); } } });
    return { ...f, manager, calls };
  };
  it("closes the exact pane with a dirty worktree, proves it is gone and drops the binding", async () => {
    const f = await closable();
    expect((await f.manager.closeCancelledDeveloper({ taskId: "run-1-task", paneId: "w1:p2" })).ok).toBe(true);
    expect(f.calls.map(args => args.join(" "))).toEqual(expect.arrayContaining([expect.stringContaining("pane close w1:p2"), expect.stringContaining("pane get w1:p2")]));
    const saved = await f.store.load("session-1");
    expect(saved.ok && saved.value?.panes.some(pane => pane.paneId === "w1:p2")).toBe(false);
  });
  it("fails and keeps the binding when the pane is still present after close", async () => {
    const f = await closable({ present: true });
    expect((await f.manager.closeCancelledDeveloper({ taskId: "run-1-task", paneId: "w1:p2" })).ok).toBe(false);
    const saved = await f.store.load("session-1");
    expect(saved.ok && saved.value?.panes.some(pane => pane.paneId === "w1:p2")).toBe(true);
  });
  it("is idempotent when a crashed retry finds the pane already gone", async () => {
    const f = await closable({ closeFails: true });
    expect((await f.manager.closeCancelledDeveloper({ taskId: "run-1-task", paneId: "w1:p2" })).ok).toBe(true);
    expect((await f.manager.closeCancelledDeveloper({ taskId: "run-1-task", paneId: "w1:p2" })).ok).toBe(true);
  });
  it("refuses a pane that now belongs to another task, without running Herdr", async () => {
    const f = await closable();
    expect(await f.manager.closeCancelledDeveloper({ taskId: "run-2-task", paneId: "w1:p2" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.calls).toEqual([]);
  });
});
