import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema, WorkflowPackSchema, type WorkflowPack } from "@bflow/contracts";
import * as runtime from "../src/index.js";
import { createAgenticConversationHost } from "../src/agentic/conversation.js";
import { AppCheckBrowserLeases } from "../src/agentic/app-check-lease.js";
import { cleanups, fixture as implementationFixture, unwrap } from "./helpers/agentic-integration-fixture.js";
import { nativeExtensionFixture } from "./helpers/native-extension.js";

function delegation(runId = "run-native") {
  return DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: `delegate-${runId}`, messageId: `message-${runId}`,
    correlationId: `correlation-${runId}`, sessionId: "session-native", runId, requestedBy: "conversation", targetRole: "coordinator",
    title: "Health analysis", objective: "Specify health without changing the product", specificationId: `spec-${runId}`,
    sddLevel: "lightweight", acceptanceCriteria: [{ id: "AC-1", description: "Traceable health specification",
      category: "functional", verificationMethod: "manual_review", required: true, status: "pending", evidenceArtifactIds: [] }],
    inputArtifacts: [], priority: "normal", requestedAt: new Date().toISOString(), idempotencyKey: `delegate-${runId}` });
}

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(sessionId = "session-native") {
  const a = await nativeExtensionFixture("analysis", sessionId), q = await nativeExtensionFixture("qa", sessionId);
  const { sdk: analysis, engine } = await a.open(), qa = (await q.open()).sdk;
  const notices: unknown[] = [];
  let pack: WorkflowPack | undefined = runtime.buildAnalysisPack({ id: "host-analysis", version: "1" });
  const create = async (extra: Record<string, unknown> = {}) => {
    const factory = Reflect.get(runtime, "createWorkflowExtensionHost");
    expect(factory, "host must freeze exact pack identity before dispatch, then compose the existing SDKs").toBeTypeOf("function");
    return factory({ repositoryPath: a.repo, sessionId, journalDirectory: join(a.root, "routes"),
      analysis, qa, engine, native: a.native, runStore: a.runStore, readPack: async () => pack,
      publishToConversation: async (message: unknown) => { notices.push(message); }, ...extra });
  };
  const intake = { schemaVersion: 1, requestId: "host-ba", sessionId, title: "Health analysis",
    userStatements: [{ id: "U-1", text: "Specify health without changing the product" }],
    deliverables: ["scope", "functional_requirements", "acceptance_criteria", "nfr", "business_flows", "glossary"],
    acceptanceCriteria: [{ id: "AC-1", description: "Traceable health specification", required: true }],
    requiredDecisions: [{ id: "D-1", question: "Who owns health?", blocking: true }], surveyPaths: ["src"], documentRoot: "docs/ba" };
  return { a, analysis, create, notices, intake, get pack() { return pack!; }, setPack: (value: WorkflowPack | undefined) => { pack = value; } };
}

describe("workflow extension host routing", () => {
  it("leaves an admitted but unstarted resume with Coordinator, then wakes the started native workflow", async () => {
    const f = await fixture(), host = await f.create(), Pump = Reflect.get(runtime, "WorkflowExtensionPump");
    await host.admit(delegation());
    const failures: unknown[] = [], pump = new Pump(host, async (_id: string, error: unknown) => { failures.push(error); });
    expect(await pump.wakeStarted("run-native")).toBe(false);
    await pump.tick(); await pump.drain();
    expect((await host.inspect("run-native")).coreCreated).toBe(false);
    expect(f.a.transport.sentRequests).toHaveLength(0);
    await host.start({ kind: "analysis", runId: "run-native", intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } });
    expect(await pump.wakeStarted("run-native")).toBe(true);
    await pump.tick(); await pump.drain();
    expect(failures).toEqual([]);
    expect((await host.inspect("run-native")).extensionStatus).toBe("awaiting_business_decision");
  });

  it("refuses shutdown with unresolved native delivery without freezing explicit reconciliation", async () => {
    const f = await fixture(), host = await f.create(); await host.admit(delegation());
    await host.start({ kind: "analysis", runId: "run-native", intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } });
    f.a.loseAck(); await expect(host.drive("run-native")).rejects.toThrow(/unknown|reconcile/);
    await expect(host.quiesce()).rejects.toThrow(/unsettled|reconcil|native/i);
    expect((await host.drive("run-native")).extensionStatus).toBe("awaiting_business_decision");
  });

  it("projects actual cancellation, closes its human gates and refuses late decisions after reopening the host", async () => {
    const f = await fixture(), host = await f.create();
    await host.admit(delegation()); await host.start({ kind: "analysis", runId: "run-native", intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } });
    await host.drive("run-native"); const question = (await host.pendingApprovals())[0]!;
    const result = await host.cancel("run-native", "Owner stopped analysis");
    expect(result).toMatchObject({ status: "cancelled", cancelled: true, extensionStatus: "cancelled" });
    expect(await host.pendingApprovals()).toEqual([]);
    const reopened = await f.create();
    expect(await reopened.inspect("run-native")).toMatchObject({ status: "cancelled", cancelled: true });
    await expect(reopened.decide(ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: question.approvalId,
      runId: question.runId, sessionId: question.sessionId, target: question.target, revision: question.revision,
      generation: question.generation, decision: "approved", decidedBy: "owner", decidedAt: new Date().toISOString(),
      reason: "D-1: Ops", feedbackArtifacts: [], idempotencyKey: "late-cancel-answer", metadata: question.metadata }))).rejects.toThrow(/cancel|approval/i);
  });

  it("refuses quiesce while a native job is active and keeps the scheduler resumable after refusal", async () => {
    const f = await fixture(), host = await f.create(), Pump = Reflect.get(runtime, "WorkflowExtensionPump");
    await host.admit(delegation()); await host.start({ kind: "analysis", runId: "run-native", intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } });
    let arrived!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { arrived = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    const receive = f.a.native.waitResult;
    f.a.native.waitResult = async id => { arrived(); await wait; return receive(id); };
    const failures: unknown[] = [], pump = new Pump(host, async (_id: string, error: unknown) => { failures.push(error); });
    try {
      await pump.tick(); await entered;
      await expect(pump.quiesce()).rejects.toThrow(/active|drain|native/i);
      expect(pump.snapshot()).toMatchObject({ quiesced: false, activeRunIds: ["run-native"] });
    } finally { release(); await pump.drain(); }
    expect(failures).toEqual([]); expect((await host.inspect("run-native")).extensionStatus).toBe("awaiting_business_decision");
    await pump.quiesce(); expect(pump.snapshot().quiesced).toBe(true);
  });
  it("drives one native job per run without blocking the host scheduler or re-dispatching at a human gate", async () => {
    const f = await fixture(), host = await f.create(), Pump = Reflect.get(runtime, "WorkflowExtensionPump");
    expect(Pump).toBeTypeOf("function");
    await host.admit(delegation()); await host.start({ kind: "analysis", runId: "run-native", intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } });
    const failures: unknown[] = [], pump = new Pump(host, async (_runId: string, error: unknown) => { failures.push(error); });
    await Promise.all([pump.tick(), pump.tick()]);
    expect(pump.snapshot().activeRunIds).toEqual(["run-native"]);
    await pump.drain(); await pump.tick(); await pump.drain();
    expect((await host.inspect("run-native")).extensionStatus).toBe("awaiting_business_decision");
    expect(f.a.transport.sentRequests).toHaveLength(2); expect(failures).toEqual([]);
    await pump.quiesce(); await pump.tick();
    expect(pump.snapshot().quiesced).toBe(true);
  });

  it("holds an unresolved native job after its first failure until an explicit wake reconciles it", async () => {
    const f = await fixture(), host = await f.create(), Pump = Reflect.get(runtime, "WorkflowExtensionPump");
    expect(Pump).toBeTypeOf("function");
    await host.admit(delegation()); await host.start({ kind: "analysis", runId: "run-native", intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } });
    f.a.loseAck(); const failures: unknown[] = [], pump = new Pump(host, async (_runId: string, error: unknown) => { failures.push(error); });
    await pump.tick(); await pump.drain(); await pump.tick(); await pump.drain();
    expect(pump.snapshot().heldRunIds).toEqual(["run-native"]);
    expect((await host.inspect("run-native")).extensionStatus).toBe("blocked");
    expect(f.a.transport.sentRequests).toHaveLength(1); expect(failures).toHaveLength(1);
    pump.wake("run-native"); await pump.tick(); await pump.drain();
    expect(pump.snapshot().heldRunIds).toEqual([]);
    expect((await host.inspect("run-native")).extensionStatus).toBe("awaiting_business_decision");
    expect(f.a.transport.sentRequests).toHaveLength(2);
    expect(f.a.transport.reconciledRequests).toHaveLength(1);
  });
  it("composes both native SDKs from the host's existing Core and stores without allocating a Developer", async () => {
    const f = await fixture(), { engine } = await f.a.open();
    const factory = Reflect.get(runtime, "openWorkflowExtensionRuntimes");
    expect(factory).toBeTypeOf("function");
    const composed = await factory({ repositoryPath: f.a.repo, sessionId: "session-native", directory: join(f.a.root, "composed"),
      engine, runStore: f.a.runStore, artifactStore: f.a.artifactStore, native: f.a.native,
      authorizeHuman: () => true, now: () => new Date().toISOString(), readPack: async () => f.pack,
      publishToConversation: async () => {}, qa: { tools: {}, grants: [], leases: new AppCheckBrowserLeases(join(f.a.root, "qa-leases")) } });
    await composed.host.admit(delegation());
    await composed.host.start({ kind: "analysis", runId: "run-native", intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } });
    await composed.host.drive("run-native");
    expect(composed.analysis.status("run-native").executionMode).toBe("native");
    expect(f.a.transport.sentRequests.map(item => item.role)).toEqual(["architect", "specifier"]);
    expect((await f.a.runStore.get("run-native")).ok).toBe(true);
  });
  it("freezes a real Conversation delegation before Coordinator handoff and projects extension approvals through the existing Gateway", async () => {
    const f = await fixture("session-1"), implementation = await implementationFixture({ intake: false }), extension = await f.create();
    const chat = await createAgenticConversationHost({ runtime: implementation.runtime, manifest: unwrap(await implementation.panes.getManifest()),
      contextDirectory: join(f.a.root, "conversation"), extensions: extension });
    const result = await chat.handleUserTurn({ sessionId: "session-1", messageId: "real-user-analysis", content: "Lập tài liệu phân tích sức khỏe hệ thống",
      provenance: { origin: "user", authenticatedUser: true }, conversationDecision: { intent: "workflow_request", requirementDraft: {
        title: "Health analysis", objective: "Specify health without changing the product", kind: "spike", sddLevel: "lightweight", priority: "normal",
        scopeDefined: true, isLargeTask: false, affectedPaths: ["src"], acceptanceCriteriaDescriptions: ["Traceable health specification"], isRequirementChange: false } } }) as any;
    expect(result.ok).toBe(true);
    const request = result.value.delegationRequest;
    expect(await extension.owns(request.runId)).toBe(true);
    const state = await implementation.runtime.inspect() as any;
    expect(state.outbound.filter((item: any) => item.message.type === "delegation.request")).toHaveLength(1);
    expect(state.outbound[0].message.recipient.role).toBe("coordinator");
    await extension.start({ kind: "analysis", runId: request.runId, intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } });
    const view = await extension.drive(request.runId);
    await chat.reconcileApprovals();
    expect((await chat.getContext() as any).pendingApprovals[view.approval.approvalId]).toEqual(view.approval);
    implementation.ports.workflowExtensionOwns = (runId: string) => extension.owns(runId);
    implementation.ports.workflowExtensionStarted = async (runId: string) => await extension.owns(runId) && (await extension.inspect(runId)).coreCreated === true;
    expect(await implementation.runtime.watchdogSnapshot("session-1")).toEqual([]);
    await expect(implementation.runtime.proposeWorkflow(request.runId, implementation.spec, implementation.def)).rejects.toThrow(/extension/i);
    expect(implementation.transport.sentRequests.some(item => item.role === "developer")).toBe(false);
    implementation.ports.cancelWorkflowExtension = (runId, reason) => extension.cancel(runId, reason);
    implementation.ports.inspectWorkflowExtension = runId => extension.inspect(runId);
    const cancellation = { sessionId: "session-1", messageId: "real-user-cancel-analysis", content: "Hủy probe phân tích này",
      provenance: { origin: "user", authenticatedUser: true }, conversationDecision: { intent: "cancellation_request",
        cancellationInput: { runId: request.runId, reason: "Owner stopped the native run" } } };
    const cancelled = await chat.handleUserTurn(cancellation) as any;
    expect(cancelled.ok).toBe(true);
    expect(cancelled.value.agentReply.metadata.cancellationBatch.items).toEqual([expect.objectContaining({ runId: request.runId, status: "queued" })]);
    expect(await extension.inspect(request.runId)).toMatchObject({ extensionStatus: "cancelled", cancelled: true });
    expect((await extension.inspect(request.runId)).delegation).toEqual(request);
    expect(await implementation.runtime.reconcileCancellation(request.runId)).toMatchObject({ fullyStopped: true });
    expect(await extension.pendingApprovals()).toEqual([]);
    await chat.handleUserTurn(cancellation);
    const after = await implementation.runtime.inspect() as any;
    expect(after.outbound.filter((item: any) => item.message.payload.metadata?.action === "cancel")).toHaveLength(1);
    expect(after.runs).toHaveLength(1);
  });
  it("freezes exact family/pin at trusted intake and refuses configuration drift, ambiguous identity and conflicting replay", async () => {
    const f = await fixture(), host = await f.create(), request = delegation();
    expect(await host.admit(request)).toBe("analysis");
    expect(await host.owns(request.runId)).toBe(true);
    expect(await host.admit(request)).toBe("analysis");
    await expect(host.admit({ ...request, objective: "Rewrite product" })).rejects.toThrow(/conflict/i);
    f.setPack(undefined);
    expect(await (await f.create()).admit(request)).toBe("analysis");
    await expect(host.start({ kind: "analysis", runId: request.runId, intake: f.intake, packPin: f.pack })).rejects.toThrow(/pack|pin|drift/i);
    const bad = runtime.buildAnalysisPack({ id: "bad", version: "1" }); bad.defaults["workflow.id"] = "bflow.unknown";
    const { digest: _digest, ...body } = bad;
    f.setPack(WorkflowPackSchema.parse({ ...body, digest: runtime.workflowPackDigest(bad) }));
    expect(await host.admit(delegation("other"))).toBe("implementation");
    await expect(host.start({ kind: "unknown", runId: "other", intake: {}, packPin: {} })).rejects.toThrow();
  });

  it("starts only an admitted matching family, publishes the authoritative scoped approval and inspects without provider activity", async () => {
    const f = await fixture(), host = await f.create(), pin = { id: f.pack.id, version: f.pack.version, digest: f.pack.digest };
    await expect(host.start({ kind: "analysis", runId: "run-native", intake: f.intake, packPin: pin })).rejects.toThrow(/admi|delegat/i);
    await host.admit(delegation());
    await expect(host.start({ kind: "qa", runId: "run-native", intake: {}, packPin: pin })).rejects.toThrow(/family|kind/i);
    await host.start({ kind: "analysis", runId: "run-native", intake: f.intake, packPin: pin });
    const state = await host.drive("run-native");
    expect(state.extensionStatus).toBe("awaiting_business_decision");
    const sent = f.a.transport.sentRequests.length;
    const view = await (await f.create()).inspect("run-native");
    expect(view).toMatchObject({ runId: "run-native", kind: "analysis", status: "awaiting_approval", extensionStatus: "awaiting_business_decision",
      approval: { metadata: { approvalScope: "business_decisions" } } });
    expect(f.notices).toContainEqual(expect.objectContaining({ type: "approval.request", payload: view.approval }));
    expect(f.a.transport.sentRequests).toHaveLength(sent);
    await host.quiesce();
    await expect(host.drive("run-native")).rejects.toThrow(/quiesc/i);
  });

  it("preserves implementation routing when no extension pack is selected, even after configuration changes", async () => {
    const f = await fixture(); f.setPack(undefined); const host = await f.create(), request = delegation();
    expect(await host.admit(request)).toBe("implementation");
    f.setPack(runtime.buildAnalysisPack({ id: "later", version: "2" }));
    expect(await (await f.create()).admit(request)).toBe("implementation");
    expect(await host.owns("run-native")).toBe(false);
    expect(f.a.transport.sentRequests).toHaveLength(0);
    expect(await host.admit({ ...request, objective: "A later requirement revision" })).toBe("implementation");
  });

  it("preserves existing custom implementation pack identities without selecting an extension", async () => {
    const f = await fixture(), pack = structuredClone(f.pack);
    pack.defaults["workflow.id"] = "custom-delivery";
    pack.lockedFields = pack.lockedFields.filter(field => field !== "workflow.id");
    pack.digest = runtime.workflowPackDigest(pack); f.setPack(pack);
    const host = await f.create();
    expect(await host.admit(delegation())).toBe("implementation");
    expect(await host.owns("run-native")).toBe(false);
  });

  it("keeps pre-existing implementation runs on their original path when a new extension pack is configured", async () => {
    const f = await fixture("session-1"), implementation = await implementationFixture();
    const host = await f.create({ isLegacyImplementationRun: async (runId: string) => {
      try { await implementation.runtime.inspect(runId); return true; } catch { return false; }
    } });
    const original = await implementation.runtime.inspect("run-1") as any;
    expect(await host.admit(original.delegation)).toBe("implementation");
    expect(await host.owns("run-1")).toBe(false);
    expect(f.a.transport.sentRequests).toHaveLength(0);
  });

  it("authorizes only the native task attempt and read scope selected by the admitted SDK run", async () => {
    const f = await fixture(), host = await f.create(); await host.admit(delegation());
    await host.start({ kind: "analysis", runId: "run-native", intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } });
    // Retain the genuine in-flight task after transport acceptance, before output is processed.
    const wait = f.a.native.waitResult; f.a.native.waitResult = async () => { throw new Error("paused before native result"); };
    await expect(host.drive("run-native")).rejects.toThrow("paused before native result");
    f.a.native.waitResult = wait;
    const snapshot = await f.a.native.snapshot(), out = snapshot.outbound[0]!;
    const intent = (out.message.payload as any).intent;
    const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "binding-architect", sessionId: "session-native", role: "architect",
      agentId: out.handle!.target.agentId, paneId: out.handle!.target.paneId, workspaceId: "w", tabId: "w:t", provider: "codex", agentKind: "codex",
      cwd: f.a.repo, readOnlyWorkspace: true, permanent: true, isolationMode: "dedicated_pane", transportState: "working",
      boundAt: new Date().toISOString(), session: out.handle!.target.session });
    expect(host.authorizeNative).toBeTypeOf("function");
    await expect(host.authorizeNative(intent, binding)).resolves.toBeUndefined();
    await expect(host.authorizeNative({ ...intent, attemptId: "wrong-attempt" }, binding)).rejects.toThrow(/attempt|scope/i);
    await expect(host.authorizeNative({ ...intent, allowedReadPaths: ["secrets"] }, binding)).rejects.toThrow(/read|scope/i);
    const message = RoleMessageSchema.parse({ ...intent.message, payload: { ...intent.message.payload, permissions: { read: ["src"], write: "all", commands: "none" } } });
    await expect(host.authorizeNative({ ...intent, message }, binding)).rejects.toThrow(/permission|scope/i);
  });

  it("does not overwrite a concurrent conflicting admission from another host instance", async () => {
    const f = await fixture(), left = await f.create(), right = await f.create(), input = delegation();
    const results = await Promise.allSettled([left.admit(input), right.admit({ ...input, objective: "Another objective" })]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(item => item.status === "rejected")).toHaveLength(1);
  });

  it("never adopts unrelated SDK history that predates the frozen host intake", async () => {
    const f = await fixture(); await f.a.start(f.analysis);
    const host = await f.create(); await host.admit(delegation());
    await expect(host.start({ kind: "analysis", runId: "run-native", intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } })).rejects.toThrow(/history|intake|owned/i);
  });

  it("queues the original human receipt durably, applies it once on drive, and never blocks the Conversation hook on a native role", async () => {
    const f = await fixture(), host = await f.create(); await host.admit(delegation());
    await host.start({ kind: "analysis", runId: "run-native", intake: f.intake,
      packPin: { id: f.pack.id, version: f.pack.version, digest: f.pack.digest } });
    const view = await host.drive("run-native"), request = view.approval;
    const decision = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId, runId: request.runId,
      sessionId: request.sessionId, target: request.target, revision: request.revision, generation: request.generation,
      decision: "rejected", decidedBy: "user:owner", decidedAt: new Date().toISOString(), reason: "Revise business questions",
      feedbackArtifacts: [], metadata: { ...request.metadata, originalHook: "physical-test-receipt" }, idempotencyKey: "original-hook-decision" });
    await host.decide(decision);
    expect((await host.inspect("run-native")).extensionStatus).toBe("awaiting_business_decision");
    const recovered = await f.create(); await recovered.drive("run-native");
    expect((await recovered.inspect("run-native")).extensionStatus).toBe("needs_revision");
    await recovered.decide(decision);
    const events = await f.a.runStore.readEvents("run-native", { limit: 100 });
    if (!events.ok) throw new Error(events.error.message);
    expect(events.value.items.filter(event => event.type === "approval.decided").map(event => event.payload)).toEqual([decision]);
    expect(f.a.transport.sentRequests).toHaveLength(2);
  });
});
