import { describe, expect, it, vi } from "vitest";
import { PaneBindingSchema, SessionManifestSchema } from "@bflow/contracts";
import { RolePaneManager } from "../src/role-pane-manager.js";
import { InMemorySessionManifestStore } from "../src/manifest-store.js";
async function fixture(authorized?: boolean) {
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "dev-binding", sessionId: "session-1", role: "developer",
    paneGroup: "developer_worktree", agentId: "dev", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2", provider: "herdr", agentKind: "codex",
    cwd: "/repo/task", worktreePath: "/repo/task", isolationMode: "dedicated_pane", readOnlyWorkspace: false, permanent: false,
    transportState: "idle", boundAt: new Date().toISOString(), metadata: { runId: "run-1", taskId: "run-1-task", allocationStatus: "active" } });
  const store = new InMemorySessionManifestStore();
  await store.save(SessionManifestSchema.parse({ schemaVersion: 2, sessionId: "session-1", projectName: "test", workspaceRoot: "/repo",
    herdrWorkspaceId: "w1", herdrTabId: "w1:t1", status: "up", conversationSessionId: "conv-1", activeRunIds: [], panes: [binding, PaneBindingSchema.parse({ ...binding, bindingId: "chat-binding", role: "conversation", paneGroup: "conversation", agentId: "chat", paneId: "chat", cwd: "/repo", worktreePath: undefined, readOnlyWorkspace: true, permanent: true, metadata: {} }), PaneBindingSchema.parse({ ...binding, bindingId: "coord-binding", role: "coordinator", paneGroup: "coordination", agentId: "coordinator", paneId: "coord", cwd: "/repo", worktreePath: undefined, readOnlyWorkspace: true, permanent: true, metadata: {} })],
    attachTarget: { role: "conversation", paneId: "chat" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const run = vi.fn(async () => { throw new Error("Metadata-only retention must not run a Herdr mutation"); });
  const proof = vi.fn(async () => authorized === true);
  const manager = new RolePaneManager({ config: { sessionId: "session-1", projectName: "test", workspaceRoot: "/repo", conversationSessionId: "conv-1" },
    store, runner: { run }, worktreeInspector: { inspect: async () => ({ ok: true, value: { exists: true, isClean: false, dirtyFiles: ["guide.md"] } }) },
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
  it.each([{ closePane: true, removeWorktree: false }, { closePane: false, removeWorktree: true }])("never permits destructive dirty-worktree cleanup through the proof callback: %s", async request => {
    const f = await fixture(true);
    expect(await f.manager.releaseDeveloper({ taskId: "run-1-task", ...request })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.proof).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
  });
});
