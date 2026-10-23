import { describe, expect, it, vi } from "vitest";
import { PaneBindingSchema } from "@bflow/contracts";
import type { PanePolicy } from "../../src/agentic/ports.js";
import { withDeveloperLaunches } from "../../src/agentic/workspace.js";

function fixture() {
  const initial = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "binding-dev", sessionId: "session-1",
    role: "developer", agentId: "dev-1", workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p2", terminalId: "term-1",
    provider: "herdr", agentKind: "codex", cwd: "/repo/task", worktreePath: "/repo/task", isolationMode: "dedicated_pane",
    readOnlyWorkspace: false, permanent: false, transportState: "idle", boundAt: "2026-10-23T00:00:00.000Z",
    metadata: { launchId: "launch-dev", nativeSessionPending: true } });
  let current = initial, healthy = true;
  const allocate = vi.fn(async () => ({ ok: true as const, value: initial }));
  const release = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const base: PanePolicy = { getManifest: async () => ({ ok: true, value: null }),
    getRoleBinding: async () => ({ ok: true, value: current }), allocateDeveloper: allocate, releaseDeveloper: release,
    inspectRoleHealth: async () => ({ ok: true, value: { readyForPrompt: healthy, occupantMatches: true,
      paneId: current.paneId, agentId: current.agentId } }) };
  const prepare = vi.fn(async () => ({ provider: "codex", argv: [], env: {}, launchId: "launch-dev", launchFingerprint: "a".repeat(64) }));
  const panes = withDeveloperLaunches(base, { allocate: prepare, release: async () => {},
    // No Gateway registrations: ready here proves nothing about native startup.
    reachability: async () => ({ state: "ready" }) });
  const request = { taskId: "task-1", runId: "run-1", worktreePath: "/repo/task", branchName: "agent/task-1", agentName: "dev-1" };
  return { panes, request, initial, allocate, prepare, release,
    bind() { current = PaneBindingSchema.parse({ ...initial, session: { source: "herdr:codex", kind: "id", value: "native-1" },
      metadata: { ...initial.metadata, nativeSessionPending: false } }); return current; },
    busy() { healthy = false; } };
}

describe("Developer native readiness without Gateway registrations", () => {
  it("keeps the same allocation pending until a persisted native session exists, then returns the current binding", async () => {
    const f = fixture();
    expect(await f.panes.allocateDeveloper(f.request)).toMatchObject({ ok: false, error: { code: "conflict", retryable: true } });
    expect(f.release).not.toHaveBeenCalled();
    const bound = f.bind();
    expect(await f.panes.allocateDeveloper(f.request)).toEqual({ ok: true, value: bound });
    expect(f.allocate).toHaveBeenCalledTimes(1);
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch while the native startup turn is still working", async () => {
    const f = fixture(); f.bind(); f.busy();
    expect(await f.panes.allocateDeveloper(f.request)).toMatchObject({ ok: false, error: { code: "conflict", retryable: true } });
    expect(f.release).not.toHaveBeenCalled();
  });
});
