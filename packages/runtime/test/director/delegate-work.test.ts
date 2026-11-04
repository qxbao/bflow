import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema, SessionManifestSchema } from "@bflow/contracts";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

function pane(role: "conversation" | "coordinator") {
  return PaneBindingSchema.parse({ schemaVersion: 2, bindingId: `${role}-binding`, sessionId: "herdr-session", role, agentId: role,
    paneId: `${role}-pane`, workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude", cwd: "/tmp",
    readOnlyWorkspace: true, permanent: true, session: { source: "herdr:claude", kind: "id", value: `native-${role}` },
    isolationMode: "dedicated_pane", transportState: "idle", boundAt: "2026-10-19T00:00:00.000Z" });
}

async function host(queue: (message: unknown) => Promise<unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "director-delegate-")); dirs.push(dir);
  const manifest = SessionManifestSchema.parse({ schemaVersion: 2, sessionId: "herdr-session", conversationSessionId: "chat-session",
    workspaceRoot: dir, projectName: "director-delegate", herdrWorkspaceId: "workspace", herdrTabId: "tab", status: "up",
    activeRunIds: [], attachTarget: { role: "conversation", paneId: "conversation-pane" }, panes: [pane("conversation"), pane("coordinator")],
    createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" });
  const runtime = { queueHerdr: queue, inspect: async () => ({ runs: [], outbound: [] }), pendingApprovals: async () => [], ports: { transport: {} } } as unknown as AgenticWorkflowRuntime;
  return createAgenticConversationHost({ runtime, manifest, contextDirectory: dir });
}

const input = { key: "director:msg-3", kind: "feature" as const, title: "T", objective: "O", acceptanceCriteria: [{ description: "Endpoint trả 200", verificationMethod: "integration_test" }],
  sddLevel: "lightweight" as const, priority: "normal" as const, requestedAt: "2026-11-03T00:00:00.000Z" };

describe("delegateDirectorWork", () => {
  it("queues a conversation-to-coordinator delegation marked origin director with deterministic ids", async () => {
    const queued: unknown[] = [];
    const h = await host(async message => { queued.push(message); return {}; });
    const first = await h.delegateDirectorWork(input);
    const second = await h.delegateDirectorWork(input);
    expect(first).toEqual(second);
    expect(first.ok && first.value.runId).toBe(`run-${first.ok && first.value.correlationId}`);
    expect(queued).toHaveLength(2);
    const [a, b] = queued.map(item => RoleMessageSchema.parse(item));
    expect(a!.message_id).toBe(b!.message_id);
    expect(a!.idempotency_key).toBe(b!.idempotency_key);
    expect(a).toMatchObject({ type: "delegation.request", sender: { role: "conversation" }, recipient: { role: "coordinator" } });
    const delegation = DelegationRequestSchema.parse(a!.payload);
    expect(delegation).toMatchObject({ requestedBy: "conversation", targetRole: "coordinator", sessionId: "chat-session", metadata: { origin: "director" } });
    expect(delegation.runId).toBe(first.ok ? first.value.runId : "");
  });

  it("returns the admission refusal reason", async () => {
    const h = await host(async () => { const e = new Error("Run is not admissible"); e.name = "AdmissionRejectedError"; throw e; });
    const result = await h.delegateDirectorWork(input);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toContain("Run is not admissible");
  });
});
