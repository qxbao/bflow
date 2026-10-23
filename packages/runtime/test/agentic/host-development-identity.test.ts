import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaneBinding } from "@bflow/contracts";
import { HostDevelopment } from "../../src/agentic/host-development.js";

const at = "2031-01-01T00:00:00.000Z";
const assignment = (runId: string, agentId: string, worktreePath: string) => ({
  status: "accepted", taskId: "task",
  message: { schema_version: 2, message_id: `assignment-${runId}`, correlation_id: "correlation", run_id: runId, sender: { role: "coordinator" },
    recipient: { role: "developer", agent_id: agentId, pane_id: "w2:p2" }, type: "task.assignment", payload: {}, artifact_references: [],
    occurred_at: at, idempotency_key: `assignment-${runId}` },
  handle: { executionId: `execution-${runId}`, requestId: `request-${runId}`, attemptId: `attempt-${runId}`, runId, taskId: "task",
    idempotencyKey: `assignment-${runId}`, target: { transport: "herdr", agentId, workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p2", worktreePath },
    correlation: { token: `request-${runId}`, provenance: "orchestrator", verified: false }, acceptedAt: at }
});

describe("HostDevelopment assignment identity", () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it("ignores a cancelled run's unconfirmed assignment that names the same reused Herdr pane", async () => {
    root = await mkdtemp(join(tmpdir(), "bflow-dev-identity-"));
    const binding = { schemaVersion: 2, bindingId: "binding-developer-w2:p2", sessionId: "session-1", role: "developer", paneGroup: "developer_worktree",
      agentId: "dev-current", workspaceId: "w2", tabId: "w2:t1", paneId: "w2:p2", provider: "herdr", agentKind: "claude", cwd: root, worktreePath: root,
      isolationMode: "dedicated_pane", readOnlyWorkspace: false, permanent: false, transportState: "idle", boundAt: at } as PaneBinding;
    const used: string[] = [];
    const runtime = {
      inspect: async () => ({ outbound: [assignment("run-cancelled", "dev-stale", join(root!, "old")), assignment("run-current", "dev-current", root!)] }),
      withDeveloperWorkspace: async (_binding: unknown, runId: string) => { used.push(runId); }
    };
    const development = new HostDevelopment(() => runtime as never, []);
    await development.authorizeFileEdit(binding, { tool_name: "Write", tool_input: { file_path: "test/math.test.mjs" } });
    expect(used).toEqual(["run-current"]);
  });
});
