import { describe, expect, it } from "vitest";
import { AgentAssignmentSchema, AgentExecutionHandleSchema, AgentLeaseSchema, PaneBindingSchema, RoleMessageSchema } from "@bflow/contracts";
import { selectAgyAdmission } from "../../src/agentic/agy-assignment-admission.js";
import { digest } from "../../src/agentic/journal.js";

const at = "2026-10-23T00:00:00.000Z";
function binding() {
  return PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "agy-binding", sessionId: "session-1", role: "developer", agentId: "agy-agent",
    paneId: "pane-1", workspaceId: "workspace-1", tabId: "tab-1", provider: "agy", agentKind: "agy", cwd: "/workspace",
    isolationMode: "dedicated_pane", readOnlyWorkspace: false, permanent: true, transportState: "working", boundAt: at,
    session: { source: "herdr:agy", kind: "id", value: "native-1" } });
}
function delivery() {
  const pane = binding();
  const lease = AgentLeaseSchema.parse({ leaseId: "lease-1", agentId: pane.agentId, runId: "run-1", taskId: "task-1", attemptId: "attempt-1",
    fencingToken: 7, version: 1, acquiredAt: at, expiresAt: "2026-10-24T00:00:00.000Z" });
  const assignment = AgentAssignmentSchema.parse({ schemaVersion: 2, assignmentId: "assignment-1", runId: "run-1", taskId: "task-1",
    delegationId: "delegation-1", role: "developer", agentId: pane.agentId, paneId: pane.paneId, leaseId: lease.leaseId, fencingToken: lease.fencingToken,
    requiredCapabilities: ["implementation"], assignedBy: "coordinator", assignedAt: at, status: "assigned", worktreePath: "/workspace",
    idempotencyKey: "assignment-key" });
  const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "assignment-message", correlation_id: "correlation-1",
    causation_id: "delegation-message", run_id: "run-1", sender: { role: "coordinator" },
    recipient: { role: "developer", agent_id: pane.agentId, pane_id: pane.paneId }, type: "task.assignment",
    payload: { assignment, context: { objective: "exact pinned assignment" } }, artifact_references: [], occurred_at: at, idempotency_key: "assignment-key" });
  const target = { transport: "herdr", agentId: pane.agentId, workspaceId: pane.workspaceId, tabId: pane.tabId, paneId: pane.paneId, session: pane.session };
  const handle = AgentExecutionHandleSchema.parse({ executionId: "execution-1", requestId: "request-1", attemptId: "attempt-1", runId: "run-1",
    taskId: "task-1", idempotencyKey: "assignment-key", target, correlation: { token: "corr-token", provenance: "transport", verified: true }, acceptedAt: at });
  const state = { outbound: [{ status: "accepted", message, request: { target }, handle, assignment, lease, taskId: "task-1" }],
    runs: [{ runId: "run-1", status: "implementing", cancelled: false }] };
  return { pane, message, state, lease, assignment };
}
function select(f: ReturnType<typeof delivery>, changes: Partial<Parameters<typeof selectAgyAdmission>[0]> = {}) {
  return selectAgyAdmission({ role: "developer", binding: f.pane, launchId: "launch-1", expectedLaunchId: "launch-1",
    messageId: f.message.message_id, envelopeDigest: digest(f.message), state: f.state, now: Date.parse(at), ...changes });
}

describe("Agy private assignment admission", () => {
  it("returns the exact accepted envelope only after pane, session, launch, digest, assignment and lease agree", () => {
    const f = delivery();
    expect(select(f)).toEqual(f.message);
  });
  it.each([
    ["wrong envelope digest", (f: ReturnType<typeof delivery>) => ({ envelopeDigest: "0".repeat(64) })],
    ["stale launch", () => ({ launchId: "old-launch" })],
    ["foreign pane", (f: ReturnType<typeof delivery>) => ({ binding: { ...f.pane, paneId: "foreign-pane" } })],
    ["released delivery", (f: ReturnType<typeof delivery>) => ({ state: { ...f.state, outbound: [{ ...f.state.outbound[0], status: "released" }] } })],
    ["expired lease", (f: ReturnType<typeof delivery>) => ({ state: { ...f.state, outbound: [{ ...f.state.outbound[0], lease: { ...f.lease, expiresAt: at } }] } })],
    ["cancelled run", (f: ReturnType<typeof delivery>) => ({ state: { ...f.state, runs: [{ runId: "run-1", status: "cancelled", cancelled: true }] } })]
  ] as const)("rejects %s", (_name, change) => {
    const f = delivery();
    expect(() => select(f, change(f))).toThrow();
  });
});
