import { randomUUID, createHash } from "node:crypto";
import { expect, it } from "vitest";
import { WebCommandSchema, ApprovalRequestSchema, type ApprovalDecision, type OperationResult, type WebOperationResult } from "@bflow/contracts";
import { webCommandFingerprint } from "@bflow/contracts/web-host";
import { ConversationGateway, HerdrConversationBridge, InMemoryConversationContextStore, MockHerdrAgentTransport } from "../src/index.js";

const at = "2026-10-28T00:00:00.000Z";
function hash(value: unknown): string {
  const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical)}]` : v !== null && typeof v === "object"
    ? `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)}}` : JSON.stringify(v);
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function command() { return WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project", kind: "create_request", title: "Report", requestKind: "feature", objective: "Export report", acceptanceCriteria: [{ description: "Opens", verificationMethod: "e2e_test" }], constraints: ["Offline"] }); }
function principal(c: unknown) { const parsed = WebCommandSchema.parse(c); return { schemaVersion: 1, source: "local_web", issuerId: "server", keyId: "key", principalId: "human", browserSessionId: "browser", projectId: parsed.projectId, hostSessionId: "host", capability: "user_interaction", commandId: parsed.commandId, commandDigest: webCommandFingerprint(parsed), issuedAt: at, expiresAt: "2026-10-28T00:01:00.000Z", nonce: randomUUID(), signature: { algorithm: "ed25519", value: "A".repeat(86) + "==" } }; }
async function setup(authorized = true) {
  const store = new InMemoryConversationContextStore(), transport = new MockHerdrAgentTransport();
  const bridge = new HerdrConversationBridge({ transport, sessionId: "chat", conversationPaneId: "pane", coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "coord" }, now: () => at });
  const decisions: ApprovalDecision[] = [];
  const config = { sessionId: "chat", herdrSessionId: "host", paneId: "pane", bridge, contextStore: store, now: () => at,
    authorizeStructuredInteraction: async () => authorized,
    onStructuredApproval: async (decision: ApprovalDecision): Promise<OperationResult<void>> => { decisions.push(decision); return { ok: true, value: undefined }; },
    onStructuredResume: async (): Promise<OperationResult<WebOperationResult>> => ({ ok: true, value: { kind: "interaction", runId: "run", currentRunId: "run" } }) };
  const gateway = new ConversationGateway(config); await gateway.initializeOrRecoverSession();
  return { gateway, store, transport, bridge, config, decisions };
}
async function pendingApproval(metadata?: Record<string, unknown>) {
  const f = await setup(), create = command();
  const admitted = await f.gateway.handleStructuredInteraction(create, principal(create));
  if (!admitted.ok || admitted.value.kind !== "interaction") throw new Error("Missing admission");
  const request = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "apr-approval", runId: admitted.value.runId,
    sessionId: "chat", target: { type: "run" }, revision: 2, generation: 1, requestedBy: "coordinator", requestedAt: at,
    reason: "Review", evidence: [], status: "pending", idempotencyKey: "approval", ...(metadata ? { metadata } : {}) });
  await f.gateway.reconcilePendingApprovals([{ request, correlationId: f.gateway.getContextSnapshot().runIdToCorrelationId[request.runId] }]);
  const answer = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project", kind: "answer_decision",
    runId: request.runId, decisionId: request.approvalId, expectedVersion: { revisionToken: hash(request), approvalId: request.approvalId,
      target: request.target, revision: 2, generation: 1, evidenceDigest: hash([]) }, outcome: "approved" });
  if (answer.kind !== "answer_decision") throw new Error();
  return { ...f, request, answer };
}
it("admits form once while model is busy without synthesizing a text turn", async () => {
  const f = await setup(), c = command(); await f.gateway.setAgentBusyState(true);
  const result = await f.gateway.handleStructuredInteraction(c, principal(c));
  expect(result).toMatchObject({ ok: true, value: { kind: "interaction" } });
  expect(f.transport.sentRoleMessages).toHaveLength(1);
  expect(f.transport.sentRoleMessages[0]?.payload).toMatchObject({ sddLevel: "full", acceptanceCriteria: [{ verificationMethod: "e2e_test" }], metadata: { constraints: ["Offline"] } });
  expect(f.gateway.getContextSnapshot().messages).toEqual([]);
  expect(await f.gateway.handleStructuredInteraction(c, principal(c))).toEqual(result);
  const restored = new ConversationGateway(f.config); await restored.initializeOrRecoverSession();
  expect(await restored.handleStructuredInteraction(c, principal(c))).toEqual(result);
  expect(f.transport.sentRoleMessages).toHaveLength(1);
});
it("requires host authorization and rejects identity/body conflicts", async () => {
  const f = await setup(false), c = command();
  expect(await f.gateway.handleStructuredInteraction(c, principal(c))).toMatchObject({ ok: false });
  expect(f.transport.sentRoleMessages).toEqual([]);
  const good = await setup(); await good.gateway.handleStructuredInteraction(c, principal(c));
  expect(await good.gateway.handleStructuredInteraction({ ...c, objective: "Changed" }, principal({ ...c, objective: "Changed" }))).toMatchObject({ ok: false, error: { code: "conflict" } });
});
it("never resends an uncertain admission after restart", async () => {
  const f = await setup(), c = command(); f.transport.nextSubmissionStatus = "unknown_delivery";
  expect(await f.gateway.handleStructuredInteraction(c, principal(c))).toMatchObject({ ok: false, error: { code: "unknown_delivery" } });
  const restored = new ConversationGateway(f.config); await restored.initializeOrRecoverSession();
  expect(await restored.handleStructuredInteraction(c, principal(c))).toMatchObject({ ok: false, error: { code: "unknown_delivery" } });
  expect(f.transport.sentRoleMessages).toHaveLength(1);
});
it("compares every exact approval version field and settles one opposing answer", async () => {
  const f = await setup(), c = command(); const created = await f.gateway.handleStructuredInteraction(c, principal(c));
  if (!created.ok || created.value.kind !== "interaction") throw new Error("Admission failed");
  const request = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "approval", runId: created.value.runId, sessionId: "chat", target: { type: "run" }, revision: 2, generation: 1, requestedBy: "coordinator", requestedAt: at, reason: "Review", evidence: [], status: "pending", idempotencyKey: "approval" });
  await f.gateway.reconcilePendingApprovals([{ request, correlationId: f.gateway.getContextSnapshot().runIdToCorrelationId[created.value.runId] }]);
  const answer = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project", kind: "answer_decision", runId: request.runId, decisionId: request.approvalId, expectedVersion: { revisionToken: hash(request), approvalId: request.approvalId, target: request.target, revision: 2, generation: 1, evidenceDigest: hash([]) }, outcome: "approved" });
  if (answer.kind !== "answer_decision") throw new Error();
  const stale = { ...answer, expectedVersion: { ...answer.expectedVersion, generation: 0 } };
  expect(await f.gateway.handleStructuredInteraction(stale, principal(stale))).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(await f.gateway.handleStructuredInteraction(answer, principal(answer))).toMatchObject({ ok: true });
  const opposite = { ...answer, commandId: randomUUID(), outcome: "rejected", reason: "No" };
  expect(await f.gateway.handleStructuredInteraction(opposite, principal(opposite))).toMatchObject({ ok: false });
  expect(f.decisions).toHaveLength(1);
  expect(f.decisions[0]).toMatchObject({ decidedBy: "human", decidedAt: at, idempotencyKey: `web-decision-${answer.commandId}` });
});
it("rejects extra identity fields, wrong scope, missing capability and reasons before effects", async () => {
  const f = await setup(), c = command(), proof = principal(c);
  for (const p of [{ ...proof, authenticatedUser: true }, { ...proof, hostSessionId: "other" }, { ...proof, projectId: "other" }, { ...proof, commandDigest: "b".repeat(64) }])
    expect(await f.gateway.handleStructuredInteraction(c, p)).toMatchObject({ ok: false });
  const unconfigured = new ConversationGateway({ sessionId: "chat", herdrSessionId: "host", paneId: "pane", bridge: f.bridge, contextStore: f.store });
  expect(await unconfigured.handleStructuredInteraction(c, proof)).toMatchObject({ ok: false });
  const a = await pendingApproval();
  for (const outcome of ["rejected", "changes_requested"])
    expect(await a.gateway.handleStructuredInteraction({ ...a.answer, outcome }, principal(a.answer))).toMatchObject({ ok: false });
  expect(f.transport.sentRoleMessages).toEqual([]); expect(a.decisions).toEqual([]);
});
it.each(["revisionToken", "revision", "generation", "evidenceDigest", "target"])("rejects stale exact approval field %s", async field => {
  const f = await pendingApproval();
  const version = { ...f.answer.expectedVersion, [field]: field === "target" ? { type: "specification", specId: "other" } : field === "revision" || field === "generation" ? 99 : "b".repeat(64) };
  const changed = { ...f.answer, expectedVersion: version };
  expect(await f.gateway.handleStructuredInteraction(changed, principal(changed))).toMatchObject({ ok: false });
  expect(f.decisions).toEqual([]);
});
it("validates user decision options and keeps approval metadata minimal", async () => {
  const f = await pendingApproval({ kind: "user_decision", options: ["First", "Second"] });
  for (const selectedOption of [undefined, "Other"]) {
    const changed = { ...f.answer, commandId: randomUUID(), ...(selectedOption ? { selectedOption } : {}) };
    expect(await f.gateway.handleStructuredInteraction(changed, principal(changed))).toMatchObject({ ok: false });
  }
  const selected = { ...f.answer, selectedOption: "Second" };
  expect(await f.gateway.handleStructuredInteraction(selected, principal(selected))).toMatchObject({ ok: true });
  expect(f.decisions[0]?.metadata).toEqual({ selectedOption: "Second" });
});
it("structured winner prevents a concurrent opposite native answer from acquiring authority", async () => {
  const f = await pendingApproval();
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const original = f.config.onStructuredApproval;
  f.config.onStructuredApproval = async decision => { entered(); await blocked; return original(decision); };
  const web = f.gateway.handleStructuredInteraction(f.answer, principal(f.answer)); await started;
  const native = await f.gateway.handleUserTurn({ sessionId: "chat", messageId: "native-opposite", content: "apr-approval: reject because incorrect",
    provenance: { origin: "user", authenticatedUser: true, userId: "native-user", channel: "herdr_attach", paneId: "pane" } });
  expect(native).toMatchObject({ ok: true, value: { queuedBecauseBusy: true } });
  release(); expect(await web).toMatchObject({ ok: true });
  await f.gateway.flushPendingInboundQueue();
  expect(f.gateway.getContextSnapshot().approvalDecisions["apr-approval"]?.decision).toBe("approved");
  expect(f.decisions).toHaveLength(1);
  expect(f.transport.sentRoleMessages.filter(message => message.type === "approval.decision")).toHaveLength(0);
});
it("answers pre-run clarification by exact question/version, preserving explicit draft criteria", async () => {
  const f = await setup();
  const pending = { correlationId: "intake", originalRequestText: "Report", accumulatedDetails: [], unresolvedQuestions: ["Which format?"],
    draft: { title: "Report", objective: "Export", kind: "feature" as const, sddLevel: "lightweight" as const, priority: "normal" as const,
      scopeDefined: false, isLargeTask: false, affectedPaths: [], acceptanceCriteriaDescriptions: [], acceptanceCriteria: [{ description: "Opens", verificationMethod: "e2e_test" as const }], isRequirementChange: false }, createdAt: at, updatedAt: at };
  await f.store.save({ ...f.gateway.getContextSnapshot(), session: { ...f.gateway.getContextSnapshot().session, unresolvedQuestions: ["Which format?"] }, pendingClarifications: { intake: pending } });
  const restored = new ConversationGateway(f.config); await restored.initializeOrRecoverSession();
  const c = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project", kind: "answer_clarification", intakeId: "intake",
    questionId: `question-${hash(["intake", 0, "Which format?"])}`, expectedVersion: { revisionToken: hash(pending) }, answer: "PDF" });
  const stale = { ...c, questionId: "other" };
  expect(await restored.handleStructuredInteraction(stale, principal(stale))).toMatchObject({ ok: false });
  expect(await restored.handleStructuredInteraction(c, principal(c))).toMatchObject({ ok: true, value: { kind: "interaction", runId: "run-intake" } });
  expect(f.transport.sentRoleMessages[0]?.payload).toMatchObject({ objective: "Export\nPDF", acceptanceCriteria: [{ verificationMethod: "e2e_test" }] });
  expect(restored.getContextSnapshot().session.unresolvedQuestions).toEqual([]);
});
it("keeps cancelled/resumed actions in Conversation admission without claiming process stop", async () => {
  const f = await pendingApproval();
  const cancel = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project", kind: "cancel", runId: f.request.runId,
    expectedVersion: { revisionToken: "host-validated-version" }, reason: "No longer needed" });
  expect(await f.gateway.handleStructuredInteraction(cancel, principal(cancel))).toMatchObject({ ok: true, value: { kind: "interaction" } });
  expect(f.transport.sentRoleMessages.at(-1)?.payload).toMatchObject({ messageId: `web-delegation-${cancel.commandId}`, idempotencyKey: `web-cancel-${cancel.commandId}` });
  expect(f.transport.sentRoleMessages.at(-1)?.payload).toMatchObject({ metadata: { action: "cancel", targetRunId: f.request.runId, cancellationRequest: { requestedBy: "conversation" } } });
  const resume = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project", kind: "resume", runId: f.request.runId,
    actionId: "host-action", expectedVersion: { revisionToken: "host-validated-version" } });
  expect(await f.gateway.handleStructuredInteraction(resume, principal(resume))).toMatchObject({ ok: true, value: { runId: "run" } });
});
it("rejects corrupt structured snapshot identity and missing conclusive result", async () => {
  const f = await setup(), c = command(); await f.gateway.handleStructuredInteraction(c, principal(c));
  const snapshot = f.gateway.getContextSnapshot(), entry = snapshot.structuredInteractions![c.commandId]!;
  expect(await f.store.save({ ...snapshot, structuredInteractions: { [randomUUID()]: entry } })).toMatchObject({ ok: false });
  const { result: _result, ...withoutResult } = entry;
  expect(await f.store.save({ ...snapshot, structuredInteractions: { [c.commandId]: withoutResult } })).toMatchObject({ ok: false });
  expect(await f.store.save({ ...snapshot, structuredInteractions: { [c.commandId]: { ...entry, fingerprint: "a".repeat(64) } } })).toMatchObject({ ok: false });
});
it("retains structured receipts when a model busy-state save overlaps admission", async () => {
  const f = await setup(), c = command(), originalSave = f.store.save.bind(f.store);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  let once = true;
  f.store.save = async snapshot => {
    if (once && snapshot.agentBusy) { once = false; entered(); await blocked; }
    return originalSave(snapshot);
  };
  const busy = f.gateway.setAgentBusyState(true); await started;
  const result = await f.gateway.handleStructuredInteraction(c, principal(c));
  release(); await busy;
  expect(await f.gateway.readStructuredInteraction(c.commandId)).toEqual(result);
  expect(Object.values(f.gateway.getContextSnapshot().workflows)).toHaveLength(1);
  expect(await f.gateway.handleStructuredInteraction(c, principal(c))).toEqual(result);
  expect(f.transport.sentRoleMessages).toHaveLength(1);
});
it("closes a native clarification about an approval answered on web", async () => {
  const f = await pendingApproval(), snapshot = f.gateway.getContextSnapshot();
  const clarification = { correlationId: "clarify-approval", originalRequestText: "apr-approval", accumulatedDetails: [], unresolvedQuestions: ["apr-approval: approve or reject?"],
    draft: { title: "Review", objective: "Review", kind: "feature" as const, sddLevel: "full" as const, priority: "normal" as const,
      scopeDefined: false, isLargeTask: false, affectedPaths: [], acceptanceCriteriaDescriptions: [], isRequirementChange: false }, createdAt: at, updatedAt: at };
  await f.store.save({ ...snapshot, pendingClarifications: { "clarify-approval": clarification }, session: { ...snapshot.session, unresolvedQuestions: clarification.unresolvedQuestions } });
  const gateway = new ConversationGateway(f.config); await gateway.initializeOrRecoverSession();
  expect(await gateway.handleStructuredInteraction(f.answer, principal(f.answer))).toMatchObject({ ok: true });
  expect(gateway.getContextSnapshot().pendingClarifications).toEqual({});
  expect(gateway.getContextSnapshot().session.unresolvedQuestions).toEqual([]);
});
it("observes a committed definitive rejection without retrying the bridge", async () => {
  const f = await setup(), c = command();
  f.bridge.handOffToCoordinator = async () => ({ ok: false, error: { code: "validation", retryable: false, message: "Admission refused before enqueue" } });
  const result = await f.gateway.handleStructuredInteraction(c, principal(c));
  expect(result.ok).toBe(false);
  expect(await f.gateway.readStructuredInteraction(c.commandId)).toEqual(result);
  expect(f.transport.sentRoleMessages).toHaveLength(0);
});
it.each(["throw", "unknown_delivery", "timeout", "transport_unavailable", "corruption"] as const)("reserves exact approval after ambiguous callback %s and rejects a new opposing command", async code => {
  const f = await pendingApproval();
  let calls = 0;
  f.config.onStructuredApproval = async () => {
    calls++;
    if (code === "throw") throw new Error("Lost callback acknowledgement");
    return { ok: false, error: code === "unknown_delivery" ? { code, retryable: false, manualInterventionRequired: true, message: "Uncertain" } :
      code === "timeout" ? { code, retryable: true, retrySafety: "observation_only", message: "Uncertain" } :
      code === "corruption" ? { code, retryable: false, message: "Uncertain" } : { code, retryable: true, message: "Uncertain" } };
  };
  expect(await f.gateway.handleStructuredInteraction(f.answer, principal(f.answer))).toMatchObject({ ok: false });
  const restored = new ConversationGateway(f.config); await restored.initializeOrRecoverSession();
  const opposite = { ...f.answer, commandId: randomUUID(), outcome: "rejected", reason: "No" };
  expect(await restored.handleStructuredInteraction(opposite, principal(opposite))).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(calls).toBe(1);
  expect(await restored.readStructuredInteraction(f.answer.commandId)).toBeUndefined();
});
it("does not let an unresolved old-generation approval reserve a newly issued generation", async () => {
  const f = await pendingApproval(); let calls = 0;
  f.config.onStructuredApproval = async () => { if (++calls === 1) throw new Error("Uncertain"); return { ok: true, value: undefined }; };
  await f.gateway.handleStructuredInteraction(f.answer, principal(f.answer));
  const request = ApprovalRequestSchema.parse({ ...f.request, generation: 2 });
  await f.store.save({ ...f.gateway.getContextSnapshot(), pendingApprovals: { [request.approvalId]: request } });
  const restored = new ConversationGateway(f.config); await restored.initializeOrRecoverSession();
  const next = { ...f.answer, commandId: randomUUID(), expectedVersion: { ...f.answer.expectedVersion, revisionToken: hash(request), generation: 2 } };
  expect(await restored.handleStructuredInteraction(next, principal(next))).toMatchObject({ ok: true });
  expect(calls).toBe(2);
});
