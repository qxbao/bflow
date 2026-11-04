import { expect, it } from "vitest";
import { AgentExecutionHandleSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema } from "@bflow/contracts";
import { selectExtensionCoordinatorDelivery } from "../../src/agentic/extension-coordinator.js";
import { digest } from "../../src/agentic/journal.js";

function fixture() {
  const at = "2026-11-03T02:50:00.000Z";
  const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation-ba", messageId: "message-ba",
    correlationId: "correlation-ba", sessionId: "conversation-ba", runId: "run-ba", requestedBy: "conversation", targetRole: "coordinator",
    title: "Analyze slug", objective: "Document existing behavior", specificationId: "spec-ba", sddLevel: "lightweight",
    acceptanceCriteria: [{ id: "AC-1", category: "functional", description: "Traceable analysis", verificationMethod: "manual_review",
      required: true, status: "pending", evidenceArtifactIds: [] }], inputArtifacts: [], priority: "normal", requestedAt: at, idempotencyKey: "delegate-ba" });
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "coordinator-current", sessionId: "host-ba", role: "coordinator",
    agentId: "coordinator", workspaceId: "w1", tabId: "w1:t2", paneId: "w1:p2", session: { source: "herdr:codex", kind: "id", value: "native-current" },
    provider: "codex", agentKind: "codex", cwd: "/repo", readOnlyWorkspace: true, permanent: true, isolationMode: "dedicated_pane", transportState: "working", boundAt: at });
  const originalMessage = RoleMessageSchema.parse({ schema_version: 2, message_id: delegation.messageId, correlation_id: delegation.correlationId,
    run_id: "run-ba", sender: { role: "conversation" }, recipient: { role: "coordinator", agent_id: binding.agentId, pane_id: binding.paneId },
    type: "delegation.request", payload: delegation, artifact_references: [], idempotency_key: "delegate-ba" });
  const wakeMessage = RoleMessageSchema.parse({ ...originalMessage, message_id: "resume-current", causation_id: "blocker-current",
    sender: { role: "runtime" }, type: "task.status", payload: { kind: "resume_run", actionId: "action-current", automatic: false }, idempotency_key: "resume-current" });
  const delivery = (message: typeof originalMessage, status: string, nativeSession = "native-current") => ({ status, message,
    handle: AgentExecutionHandleSchema.parse({ executionId: `execution-${message.message_id}`, requestId: `request-${message.message_id}`,
      attemptId: `attempt-${message.message_id}`, runId: "run-ba", taskId: `task-${message.message_id}`, idempotencyKey: message.idempotency_key,
      target: { transport: "herdr", agentId: binding.agentId, workspaceId: binding.workspaceId, tabId: binding.tabId, paneId: binding.paneId,
        session: { ...binding.session!, value: nativeSession } }, correlation: { token: message.message_id, provenance: "orchestrator", verified: false }, acceptedAt: at }) });
  const original = delivery(originalMessage, "released", "native-retired"), wake = delivery(wakeMessage, "accepted");
  const run = { runId: "run-ba", delegation, status: "intake", cancelled: false,
    pendingAction: { actionId: "action-current", kind: "resume_coordinator", owner: "coordinator", state: "queued", sourceMessageId: "blocker-current" } };
  return { delegation, binding, original, wake, run, delivery, originalMessage };
}

it("uses the original accepted delegation for the current native Coordinator", () => {
  const f = fixture(), original = f.delivery(f.originalMessage, "accepted");
  expect(selectExtensionCoordinatorDelivery({ ...f, outbound: [original] })).toEqual(f.originalMessage);
});

it("uses an exact accepted Runtime resume after the old delegation/native session was retired", () => {
  const f = fixture();
  expect(selectExtensionCoordinatorDelivery({ ...f, outbound: [f.original, f.wake] })).toEqual(f.wake.message);
});

it("refuses a stale action, foreign native session, uncertain delivery or cancelled run", () => {
  const f = fixture(), input = { ...f, outbound: [f.original, f.wake] };
  expect(() => selectExtensionCoordinatorDelivery({ ...input, run: { ...f.run, pendingAction: { ...f.run.pendingAction, actionId: "different-action" } } })).toThrow();
  expect(() => selectExtensionCoordinatorDelivery({ ...input, outbound: [f.original, f.delivery(f.wake.message, "accepted", "native-foreign")] })).toThrow();
  expect(() => selectExtensionCoordinatorDelivery({ ...input, outbound: [f.original, { ...f.wake, status: "unknown_delivery" }] })).toThrow();
  expect(() => selectExtensionCoordinatorDelivery({ ...input, run: { ...f.run, cancelled: true } })).toThrow();
});

it("refuses a resume without its original immutable Conversation delegation", () => {
  const f = fixture();
  expect(() => selectExtensionCoordinatorDelivery({ ...f, outbound: [f.wake] })).toThrow();
  expect(() => selectExtensionCoordinatorDelivery({ ...f, outbound: [f.original, f.wake], delegation: { ...f.delegation, objective: "different request" } })).toThrow();
});

it.each(["original", "resume"])("refuses %s delivery while a native operation remains unreconciled", kind => {
  const f = fixture();
  const outbound = kind === "original" ? [f.delivery(f.originalMessage, "accepted")] : [f.original, f.wake];
  const run = { ...f.run, nativeDeliveries: [{ operationId: "operation-unknown", message: f.wake.message }] };
  expect(() => selectExtensionCoordinatorDelivery({ ...f, outbound, run })).toThrow("Uncertain extension delivery must reconcile before starting");
  expect(selectExtensionCoordinatorDelivery({ ...f, outbound, run: { ...run, nativeDeliveries: [] } })).toEqual(
    kind === "original" ? f.originalMessage : f.wake.message);
});

it("accepts the exact Runtime idle wake for an authenticated user after a clarification released the delegation", () => {
  const f = fixture(), userMessageId = "user-resume-ba";
  const messageId = `resume-idle-${digest([f.run.runId, userMessageId])}`;
  const message = RoleMessageSchema.parse({ ...f.wake.message, message_id: messageId, causation_id: undefined,
    idempotency_key: messageId, payload: { kind: "user_resume_requested", runId: f.run.runId,
      actionId: `idle-${digest(f.run.runId)}`, conversationUserMessageId: userMessageId, sdlcStatus: "clarifying" } });
  const run = { ...f.run, status: "clarifying", pendingAction: undefined }, wake = f.delivery(message, "accepted");
  const input = { ...f, run, outbound: [f.original, wake] };
  expect(selectExtensionCoordinatorDelivery(input)).toEqual(message);
  const changed = (payload: object) => ({ ...input, outbound: [f.original, f.delivery(RoleMessageSchema.parse({ ...message,
    payload: { ...message.payload as object, ...payload } }), "accepted")] });
  expect(() => selectExtensionCoordinatorDelivery(changed({ conversationUserMessageId: "another-user-turn" }))).toThrow();
  expect(() => selectExtensionCoordinatorDelivery(changed({ conversationUserMessageId: "" }))).toThrow();
  expect(() => selectExtensionCoordinatorDelivery(changed({ actionId: "different-action" }))).toThrow();
  expect(() => selectExtensionCoordinatorDelivery(changed({ runId: "another-run" }))).toThrow();
  expect(() => selectExtensionCoordinatorDelivery({ ...input, run: f.run })).toThrow();
  expect(() => selectExtensionCoordinatorDelivery({ ...input, run: { ...run, approval: { approvalId: "pending-human-gate" } } })).toThrow();
  expect(() => selectExtensionCoordinatorDelivery({ ...input, run: { ...run, nativeDeliveries: [{ operationId: "uncertain", message }] } })).toThrow();
});
