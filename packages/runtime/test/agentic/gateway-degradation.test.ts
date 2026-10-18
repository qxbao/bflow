import { describe, expect, it } from "vitest";
import { withDeveloperLaunches, type DeveloperLaunchPort } from "../../src/agentic/workspace.js";
import type { PanePolicy } from "../../src/agentic/ports.js";

/** Base pane policy whose panes are always ready; the wrapper alone decides degradation. */
function basePanes(): PanePolicy {
  const paneOf = (role: string) => role === "coordinator" ? "pane-coord" : role === "dev-1" ? "pane-dev-1" : "pane-dev-2";
  return {
    getManifest: async () => ({ ok: true, value: null }),
    getRoleBinding: async () => ({ ok: true, value: null }),
    inspectRoleHealth: async role => ({ ok: true, value: { readyForPrompt: true, occupantMatches: true, paneId: paneOf(role), agentId: role } }),
    allocateDeveloper: async request => ({ ok: true, value: { paneId: request.taskId === "task-1" ? "pane-dev-1" : "pane-dev-2" } as never }),
    releaseDeveloper: async () => ({ ok: true, value: undefined })
  };
}

function launchPort(degraded: { roles: string[]; launchIds: string[] }): DeveloperLaunchPort {
  return {
    allocate: async ({ taskId }) => ({ provider: "codex", argv: [], env: {}, launchId: `launch-${taskId}`, launchFingerprint: "f".repeat(64) }),
    release: async () => {},
    reachability: async () => ({ state: "ready" }),
    degradation: () => degraded
  };
}

describe("Gateway registration loss gate (F5 wiring)", () => {
  it("holds a degraded permanent role back from new prompts and leaves healthy roles ready", async () => {
    const degraded = { roles: ["coordinator"], launchIds: [] as string[] };
    const panes = withDeveloperLaunches(basePanes(), launchPort(degraded));
    const coordinator = await panes.inspectRoleHealth("coordinator");
    expect(coordinator.ok && coordinator.value.readyForPrompt).toBe(false);
    degraded.roles = [];
    const recovered = await panes.inspectRoleHealth("coordinator");
    expect(recovered.ok && recovered.value.readyForPrompt).toBe(true);
  });

  it("holds only the Developer whose launch was degraded", async () => {
    const degraded = { roles: [] as string[], launchIds: ["launch-task-1"] };
    const panes = withDeveloperLaunches(basePanes(), launchPort(degraded));
    for (const taskId of ["task-1", "task-2"]) {
      const allocated = await panes.allocateDeveloper({ taskId, runId: "run-1", worktreePath: `/w/${taskId}`, branchName: taskId, agentName: `dev-${taskId.slice(-1)}` });
      expect(allocated.ok).toBe(true);
    }
    const first = await panes.inspectRoleHealth("dev-1");
    const second = await panes.inspectRoleHealth("dev-2");
    expect(first.ok && first.value.readyForPrompt).toBe(false);
    expect(second.ok && second.value.readyForPrompt).toBe(true);
    // A released Developer no longer maps to its launch.
    await panes.releaseDeveloper({ taskId: "task-1", closePane: true, removeWorktree: false });
    const afterRelease = await panes.inspectRoleHealth("dev-1");
    expect(afterRelease.ok && afterRelease.value.readyForPrompt).toBe(true);
  });

  it("is a no-op without a degradation source (legacy hosts)", async () => {
    const port = launchPort({ roles: ["coordinator"], launchIds: [] });
    delete (port as { degradation?: unknown }).degradation;
    const panes = withDeveloperLaunches(basePanes(), port);
    const health = await panes.inspectRoleHealth("coordinator");
    expect(health.ok && health.value.readyForPrompt).toBe(true);
  });
});
