import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { digest } from "../../src/agentic/journal.js";
import { workflow } from "../../../specification/test/fixtures.js";
import { cleanups, unwrap, git, fixture } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe.skipIf(process.platform === "win32")("P19 integrated Agentic SDLC", () => {
  it("loads a runner added after composition and ignores unselected language profiles when freezing a task plan", async () => {
    const f = await fixture({ tdd: true, dynamicGate: true });
    f.ports.behavioralChecks = () => [{ ...f.ports.taskChecks.find(check => check.id === "regression")!, id: "unselected-polyglot",
      metadata: { bindAcceptedCriteria: true, bindMethodTestNames: true },
      configuration: { kind: "deterministic", method: "integration_test", command: "auto:integration:go", criterionIds: [], testNames: [], role: "quality_gate", levels: ["integration"] } }];
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement", "red"); await f.evidence("implement", "green"); await f.evidence("implement", "refactor");
    f.enableDynamicGate(); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
    const run = await f.inspect(); expect(run.tasks[0].cycle.status).toBe("passed");
    expect(run.tasks[0].verificationPlan.checks.some((check: any) => check.id === "unselected-polyglot")).toBe(false);
    expect(f.calls.some(context => context.definition.id === "regression")).toBe(true);
  });

  it("conversation-only creates no workflow", async () => {
    const f = await fixture();
    const before = await f.runtime.inspect() as any;
    await f.runtime.receiveHerdr(f.envelope("conversation.intake", { content: "hello" }, { run_id: undefined }));
    expect((await f.runtime.inspect() as any).runs).toHaveLength(before.runs.length);
    expect(unwrap(await f.ports.runStore.get("run-1"))).toBeNull();
  });
  it("runs a small workflow without Architect through real policies/Git/storage and delivery approval", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    expect((await f.inspect()).status).toBe("implementing");
    await f.runtime.tick(); await f.evidence("implement"); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
    const run = await f.inspect();
    expect(run.tasks[0].cycle.status).toBe("passed");
    expect(run.workflowCycle?.status).toBe("passed"); expect(run.status).toBe("awaiting_approval");
    await f.approve(); expect((await f.inspect()).status).toBe("completed");
    expect(f.transport.sentRequests.some(request => request.role === "architect")).toBe(false);
    expect(f.calls.some(ctx => (ctx.input as any).scope === "workflow")).toBe(true);
    expect(git(f.repository, "branch", "--show-current")).toBe("main");
  });
  it("complex work requires Design Approval and can be rejected before dispatch", async () => {
    const f = await fixture({ complex: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    expect((await f.inspect()).status).toBe("awaiting_approval");
    await f.runtime.tick(); expect(f.transport.sentRequests.some(request => request.role === "developer")).toBe(false);
    await f.approve("rejected"); expect((await f.inspect()).status).toBe("failed");
  });
  it("dispatches two independent Developers with different leased panes/worktrees", async () => {
    const f = await fixture({ parallel: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const requests = f.transport.sentRequests.filter(req => req.role === "developer");
    expect(requests).toHaveLength(2); expect(new Set(requests.map(req => req.target.worktreePath)).size).toBe(2);
    expect(new Set(requests.map(req => req.target.paneId)).size).toBe(2);
  });
  it("renews the active Developer lease before a mediated action and refuses a stale Registry lease", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any;
    const out = state.outbound.find((item: any) => item.status === "accepted" && item.message.type === "task.assignment");
    expect(out).toBeDefined();
    const binding = f.panes.bindings.find(pane => pane.paneId === out.handle.target.paneId)!;
    const sideEffects: unknown[] = [];
    const accepted = await f.runtime.withAssignedToolAction(binding, async context => { sideEffects.push(context); return context; });
    expect(accepted).toMatchObject({ runId: "run-1", taskId: "implement", transportTaskId: "implement", fencingToken: out.lease.fencingToken });
    expect(sideEffects).toHaveLength(1);

    const lease = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.message_id === out.message.message_id).lease;
    const released = await f.ports.registry.releaseLease({ leaseId: lease.leaseId, fencingToken: lease.fencingToken, expectedVersion: lease.version,
      releasedAt: new Date().toISOString(), idempotencyKey: `stale-tool-action-${lease.leaseId}` });
    expect(released.ok).toBe(true);
    await expect(f.runtime.withAssignedToolAction(binding, async context => { sideEffects.push(context); return context; })).rejects.toThrow();
    expect(sideEffects).toHaveLength(1);
  });
  it("allows an authenticated Coordinator to read planning context before a workflow run exists", async () => {
    const f = await fixture({ intake: false });
    const coordinator = f.panes.bindings.find(pane => pane.role === "coordinator")!;
    let observed: unknown = "not-called";

    const result = await f.runtime.withAssignedToolAction(coordinator, async assignment => { observed = assignment; return "context-ready"; });

    expect(result).toBe("context-ready");
    expect(observed).toBeUndefined();
  });
  it("denies Coordinator tool actions when a historical pane handoff is linked to a live run but no active holder exists", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const coordinator = f.panes.bindings.find(pane => pane.role === "coordinator")!;
    const statePath = join(f.root, "journal/state.json"), state = JSON.parse(await readFile(statePath, "utf8"));
    const linked = state.outbound.find((item: any) => item.message.run_id === "run-1" && item.handle);
    expect(linked, JSON.stringify(state.outbound.map((item: any) => ({ type: item.message?.type, runId: item.message?.run_id,
      role: item.message?.recipient?.role, targetPane: item.handle?.target?.paneId, targetSession: item.handle?.target?.session?.value })))).toBeDefined();
    linked.message.recipient = { role: "coordinator", agent_id: coordinator.agentId, pane_id: coordinator.paneId };
    linked.message.sender = { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" };
    Object.assign(linked.handle.target, { agentId: coordinator.agentId, paneId: coordinator.paneId, session: coordinator.session });
    if (linked.request) Object.assign(linked.request.target, { agentId: coordinator.agentId, paneId: coordinator.paneId, session: coordinator.session });
    linked.status = "released";
    await writeFile(statePath, JSON.stringify(state));
    f.restart(); await f.runtime.initialize();

    let called = false;
    await expect(f.runtime.withAssignedToolAction(coordinator, async () => { called = true; return undefined; }))
      .rejects.toThrow("associated live run");
    expect(called).toBe(false);
  });
  it("required TDD blocks implementation authorization until independent Red and rejects missing Green/Refactor", async () => {
    const f = await fixture({ tdd: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    expect((await f.dossier()).strategy.tddDecision.mode).toBe("required");
    await expect(f.runtime.authorizeImplementation("run-1", "implement")).rejects.toThrow("Red evidence");
    await f.evidence("implement", "red"); expect(await f.runtime.authorizeImplementation("run-1", "implement")).toMatchObject({ authorized: true });
    await f.evidence("implement", "green"); await f.evidence("implement", "refactor");
    await f.submit(); await f.runtime.tick(); expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
  });
  it("Reviewer repair uses a fresh bounded Core attempt and verified Git change", async () => {
    const f = await fixture({ failReview: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit(); await f.runtime.tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("rework_required");
    expect((await f.inspect()).error).toBeUndefined();
    f.setFailReview(false); await f.runtime.tick(); await f.submit("implement", "repaired\n"); await f.runtime.tick();
    expect((await f.inspect()).error).toBeUndefined();
    expect((await f.inspect()).tasks[0].cycle.history.map((r: any) => r.status)).toEqual(["failed", "passed"]);
    expect((await f.inspect()).tasks[0].reworkResolutions[0].verificationOutcome.status).toBe("verified_closed");
  });
  it("rejects a repair Developer as Reviewer even when the original plan predates that identity", async () => {
    const f = await fixture({ failReview: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit(); await f.runtime.tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("rework_required");
    f.setFailReview(false); await f.runtime.tick();
    const state = await f.runtime.inspect() as any;
    const repaired = [...state.outbound].reverse().find((out: any) => out.message.type === "task.assignment");
    f.setReviewerExecutor(repaired.handle.target.agentId);
    await f.submit("implement", "repaired\n"); await f.runtime.tick();
    const run = await f.inspect();
    expect(run.status).toBe("escalated");
    expect(run.tasks[0].cycle.status).toBe("rework_required");
    expect(run.error).toContain("implementer");
  });
  it("escalates at verification limit and never sends another Developer assignment", async () => {
    const f = await fixture({ failReview: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def, 1); await f.runtime.tick();
    await f.evidence("implement"); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
    expect((await f.inspect()).status).toBe("escalated");
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
  });
  it("busy Conversation does not block Developer dispatch; progress survives restart", async () => {
    const f = await fixture(); f.panes.busy.add("conversation"); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    expect(f.transport.sentRequests.some(req => req.role === "conversation")).toBe(false);
    expect(f.transport.sentRequests.some(req => req.role === "developer")).toBe(true);
    expect(f.conversationInbox.length).toBeGreaterThan(0);
    const delivered = f.conversationInbox.length;
    f.panes.busy.delete("conversation"); const restarted = f.restart(); await restarted.tick();
    expect(f.conversationInbox).toHaveLength(delivered);
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
  });
  it("delivers to Conversation outside the journal lock, so a Gateway that re-enters Runtime cannot deadlock", async () => {
    const f = await fixture();
    // A busy Gateway drains a queued user turn whose handoff enqueues back into Runtime during delivery.
    f.reenterOnConversationDelivery(() => f.runtime.inspect());
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([f.runtime.tick(), new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Conversation delivery deadlocked")), 10_000); })])
      .finally(() => clearTimeout(timer));
    expect(f.conversationInbox.length).toBeGreaterThan(0);
    const outbound = ((await f.runtime.inspect()) as any).outbound.filter((out: any) => out.message.recipient.role === "conversation");
    expect(outbound.length).toBeGreaterThan(0);
    expect(outbound.every((out: any) => out.status === "delivered")).toBe(true);
  });
  it("unknown_delivery remains durable across restart and never automatically resends", async () => {
    const f = await fixture(); f.transport.customSendHandler = req => ({ ok: false, error: { code: "timeout", retryable: true, message: "lost ACK" } });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick(); const count = f.transport.sentRequests.length;
    await f.restart().tick(); expect(f.transport.sentRequests).toHaveLength(count);
    expect((await f.runtime.inspect() as any).outbound.some((out: any) => out.status === "unknown_delivery")).toBe(true);
  });
  it("restores an exact trusted Gateway approval after reopen without resending uncertain delivery", async () => {
    const f = await fixture({ humanApproval: true });
    const receiptDirectory = join(f.root, "host-receipts");
    let receipts = new HostReceiptJournal(receiptDirectory, f.repository, "session-1");
    f.ports.authorizeHuman = decision => receipts.authenticateHuman(decision);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const manifest = unwrap(await f.panes.getManifest()), binding = f.panes.bindings.find(pane => pane.role === "conversation")!;
    const contextDirectory = join(f.root, "conversation");
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest, contextDirectory,
      onHumanDecision: decision => receipts.recordHuman(decision, { origin: "UserPromptSubmit", binding, nativeSessionId: binding.session!.value,
        conversationSessionId: "session-1", userId: "human-1", messageId: "physical-user-turn", promptDigest: createHash("sha256").update("approve").digest("hex") }) });
    const approval = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "approval.request").message;
    await chat.receiveHerdr({ ...approval, sender: { role: "coordinator", agent_id: "coordinator" }, recipient: { role: "conversation" } });
    const response = await chat.handleUserTurn({ sessionId: "session-1", messageId: "physical-user-turn", content: "approve",
      provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: binding.paneId, channel: "herdr_attach" } }) as any;
    expect(response.ok).toBe(true); expect(response.value.approvalDecision).toBeDefined();
    const decision = response.value.approvalDecision;
    f.transport.customSendHandler = () => ({ ok: false, error: { code: "timeout", retryable: true, message: "lost ACK" } });
    await f.runtime.flushOutbound();
    const count = f.transport.sentRequests.length;
    const original = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "approval.decision");
    expect(original.status).toBe("unknown_delivery");
    receipts = new HostReceiptJournal(receiptDirectory, f.repository, "session-1");
    f.reopenStorage(); const restarted = f.restart();
    const recovered = await receipts.humanDecisions(); expect(recovered).toEqual([decision]);
    await createAgenticConversationHost({ runtime: restarted, manifest, contextDirectory, recoveredHumanDecisions: recovered });
    await restarted.flushOutbound();
    expect(f.transport.sentRequests).toHaveLength(count);
    const pending = (await restarted.inspect() as any).outbound.filter((out: any) => out.message.type === "approval.decision");
    expect(pending).toHaveLength(1); expect(pending[0]).toEqual(original);
    await expect(restarted.receiveHerdr(f.envelope("approval.decision", { ...decision, revision: decision.revision + 1 }))).rejects.toThrow("mismatched");
    await expect(restarted.receiveHerdr(f.envelope("approval.decision", { ...decision, reason: "model replaced user feedback" }))).rejects.toThrow("not authenticated");
    await restarted.receiveHerdr(original.message);
    expect((await restarted.inspect("run-1") as any).status).toBe("implementing");
  });
  it("replays a committed trusted approval for the same hook message instead of reapplying or routing it to Chat", async () => {
    const f = await fixture({ humanApproval: true });
    const receipts = new HostReceiptJournal(join(f.root, "host-receipts"), f.repository, "session-1");
    f.ports.authorizeHuman = decision => receipts.authenticateHuman(decision);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const manifest = unwrap(await f.panes.getManifest()), binding = f.panes.bindings.find(pane => pane.role === "conversation")!;
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest, contextDirectory: join(f.root, "conversation"),
      onHumanDecision: decision => receipts.recordHuman(decision, { origin: "UserPromptSubmit", binding, nativeSessionId: binding.session!.value,
        conversationSessionId: "session-1", userId: "human-1", messageId: "user-approve", promptDigest: createHash("sha256").update("approve").digest("hex") }) });
    const approval = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "approval.request").message;
    await chat.receiveHerdr({ ...approval, sender: { role: "coordinator", agent_id: "coordinator" }, recipient: { role: "conversation" } });
    const input = { sessionId: "session-1", messageId: "user-approve", content: "approve",
      provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: binding.paneId, channel: "herdr_attach" } };
    const first = await chat.handleTrustedApproval(input) as any;
    expect(first).toMatchObject({ ok: true, value: { recognizedIntent: "approval_response", queuedBecauseBusy: false } });
    const decisions = () => f.runtime.inspect().then((state: any) => state.outbound.filter((out: any) => out.message.type === "approval.decision"));
    const before = await decisions();
    expect(await chat.handleTrustedApproval(input)).toMatchObject({ ok: true, value: { recognizedIntent: "approval_response",
      correlationId: first.value.correlationId, userMessage: { messageId: "user-approve" }, agentReply: first.value.agentReply } });
    expect(await decisions()).toEqual(before);
    await expect(chat.handleTrustedApproval({ ...input, content: "reject" })).rejects.toThrow("conflicts");
  });
  it("recovers a trusted approval when the host dies before outbox and Gateway context writes", async () => {
    const f = await fixture({ humanApproval: true });
    let receipts = new HostReceiptJournal(join(f.root, "host-receipts"), f.repository, "session-1");
    f.ports.authorizeHuman = decision => receipts.authenticateHuman(decision);
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const manifest = unwrap(await f.panes.getManifest()), binding = f.panes.bindings.find(pane => pane.role === "conversation")!;
    const contextDirectory = join(f.root, "conversation");
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest, contextDirectory, onHumanDecision: async decision => {
      await receipts.recordHuman(decision, { origin: "UserPromptSubmit", binding, nativeSessionId: binding.session!.value,
        conversationSessionId: "session-1", userId: "human-1", messageId: "user-before-crash", promptDigest: createHash("sha256").update("approve").digest("hex") });
      throw new Error("Simulated crash after receipt fsync");
    } });
    const approval = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "approval.request").message;
    await chat.receiveHerdr({ ...approval, sender: { role: "coordinator", agent_id: "coordinator" }, recipient: { role: "conversation" } });
    await expect(chat.handleUserTurn({ sessionId: "session-1", messageId: "user-before-crash", content: "approve",
      provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: binding.paneId, channel: "herdr_attach" } })).rejects.toThrow("Simulated crash");
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "approval.decision")).toHaveLength(0);
    receipts = new HostReceiptJournal(join(f.root, "host-receipts"), f.repository, "session-1");
    f.reopenStorage(); const restarted = f.restart();
    const decisions = await receipts.humanDecisions(); expect(decisions).toHaveLength(1);
    await createAgenticConversationHost({ runtime: restarted, manifest, contextDirectory, recoveredHumanDecisions: decisions });
    const module = await import("../../../conversation/dist/index.js");
    const context = unwrap(await new module.FileConversationContextStore(contextDirectory).load("session-1"))!;
    expect(context.approvalDecisions[decisions[0]!.approvalId]).toEqual(decisions[0]);
    expect(context.pendingApprovals[decisions[0]!.approvalId]).toBeUndefined();
    expect(context.session.activeApprovalIds).toHaveLength(0);
    const pending = (await restarted.inspect() as any).outbound.filter((out: any) => out.message.type === "approval.decision");
    expect(pending).toHaveLength(1); expect(pending[0].message.payload).toEqual(decisions[0]);
    await restarted.receiveHerdr(pending[0].message);
    expect((await restarted.inspect("run-1") as any).status).toBe("implementing");
  });
  it("cancellation stops dispatch and preserves uncertain stop/worktree state", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const before = f.transport.sentRequests.filter(req => req.role === "developer").length;
    await f.runtime.cancel("run-1", "User cancelled"); await f.runtime.tick();
    expect((await f.inspect()).cancelled).toBe(true); expect(f.transport.cancelledHandles).toHaveLength(1);
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(before);
    expect((await f.ports.engine.getSnapshot("run-1") as any).value.status).toBe("cancelling");
  });
  it.each(["physical", "agy-physical", "model", "automatic", "unknown", "changed-native", "unknown-notice", "changed-at-dispatch", "approval-at-dispatch", "model-then-physical", "recurrent-physical", "missing-capability"])("continues the same unanswered review only after a physical resume (%s)", async mode => {
    const f = await fixture({ remoteReview: true });
    if (mode === "agy-physical") {
      const binding = f.panes.bindings.find(item => item.role === "reviewer")!;
      binding.provider = "herdr"; binding.agentKind = "agy";
      binding.session = { source: "herdr:antigravity_cli", kind: "id", value: "native-agy-review-resume" };
    }
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    f.ports.preflightRoleCapabilities = async () => undefined;
    const definition = (f.ports as any).taskChecks.find((check: any) => check.id === "review");
    const context = { runId: "run-1", taskId: "implement", attemptId: "review-continuation", artifacts: [], input: { scope: "task" },
      definition: { ...definition, timeout: { ...definition.timeout, executionTimeoutMs: 20000 } } };
    const gate = f.runtime.herdrQualityGate("review");
    const state = async () => await f.runtime.inspect() as any;
    const first = new AbortController(), pending = gate.evaluate(context as any, { signal: first.signal }); pending.catch(() => undefined);
    try { await expect.poll(async () => (await state()).outbound.filter((out: any) => out.message.type === "verification.requested" && out.handle).length, { timeout: 15000 }).toBe(1); }
    finally { first.abort(); await pending.catch(() => undefined); }
    await expect(pending).rejects.toThrow(/aborted/); await f.runtime.flushOutbound();
    const original = (await state()).outbound.find((out: any) => out.message.type === "verification.requested");
    expect(original.status).toBe("released");
    await (f.runtime as any).journal.exclusive(async (journal: any, save: any) => {
      const run = journal.runs[0]; run.status = "escalated";
      run.pendingAction = { actionId: `next-${digest(["run-1", original.message.message_id])}`, kind: "resume_coordinator", owner: "coordinator", reason: "Provider quota recovered", sourceMessageId: original.message.message_id,
        createdAt: new Date().toISOString(), state: "pending", previousStatus: "verifying", recovery: "capability_repair" };
      await save();
    });
    const actionId = `next-${digest(["run-1", original.message.message_id])}`;
    if (mode === "model-then-physical") await f.runtime.resumeBlockedRun("run-1", actionId);
    if (mode === "recurrent-physical") {
      await f.runtime.resumeBlockedRun("run-1", actionId, { conversationUserMessageId: "earlier-physical-turn" });
      await (f.runtime as any).journal.exclusive(async (journal: any, save: any) => {
        journal.runs[0].status = "escalated"; Object.assign(journal.runs[0].pendingAction, { state: "pending", previousStatus: "verifying" }); await save();
      });
      const beforeReplay = (await state()).runs[0].pendingAction.manualResumeAttempts;
      await f.runtime.resumeBlockedRun("run-1", actionId, { conversationUserMessageId: "earlier-physical-turn" });
      expect((await state()).runs[0].pendingAction.manualResumeAttempts).toBe(beforeReplay);
      expect((await state()).runs[0].status).toBe("escalated");
    }
    await f.runtime.resumeBlockedRun("run-1", actionId, mode === "automatic" ? { automatic: true } : mode === "model" ? {} : { conversationUserMessageId: "physical-review-resume" });
    if (mode === "unknown") await (f.runtime as any).journal.exclusive(async (journal: any, save: any) => {
      journal.outbound.find((out: any) => out.message.message_id === original.message.message_id).status = "unknown_delivery"; await save();
    });
    if (mode === "changed-native") f.panes.bindings.find(binding => binding.role === "reviewer")!.session = { source: "test", kind: "id", value: "replacement" };
    if (mode === "missing-capability") f.ports.roleCapabilities.reviewer = ["repository.read"];
    if (["changed-at-dispatch", "approval-at-dispatch"].includes(mode)) f.panes.busy.add("reviewer");
    if (mode === "unknown-notice") { await f.runtime.flushOutbound(); await f.runtime.flushOutbound(); f.transport.customSendHandler = () =>
      ({ ok: false, error: { code: "timeout", retryable: true, message: "Unknown diagnostic delivery" } }); }
    if (mode === "agy-physical") {
      const send = f.transport.send.bind(f.transport);
      f.transport.send = async request => {
        const result = await send(request);
        if (JSON.parse(request.instruction).payload?.kind === "resume_verification_request") f.panes.busy.add("reviewer");
        return result;
      };
    }
    const second = new AbortController(); let resumed = gate.evaluate(context as any, { signal: second.signal }); resumed.catch(() => undefined);
    try {
      await expect.poll(async () => (f.runtime as any).gateWaiters.size, { timeout: 15000 }).toBe(1);
      await f.runtime.flushOutbound();
      let notices = (await state()).outbound.filter((out: any) => out.message.payload?.kind === "resume_verification_request");
      if (["changed-at-dispatch", "approval-at-dispatch"].includes(mode)) {
        expect(notices).toHaveLength(1); expect(notices[0].status).toBe("queued");
        if (mode === "changed-at-dispatch") f.panes.bindings.find(binding => binding.role === "reviewer")!.session = { source: "test", kind: "id", value: "replacement-after-queue" };
        else await (f.runtime as any).journal.exclusive(async (journal: any, save: any) => { journal.runs[0].status = "awaiting_approval"; await save(); });
        f.panes.busy.delete("reviewer"); await f.runtime.flushOutbound();
        notices = (await state()).outbound.filter((out: any) => out.message.payload?.kind === "resume_verification_request");
        expect(notices[0].status).toBe("cancelled"); expect(notices[0].handle).toBeUndefined(); return;
      }
      if (mode === "unknown-notice") {
        expect(notices).toHaveLength(1); expect(notices[0].status).toBe("unknown_delivery");
        second.abort(); await resumed.catch(() => undefined); f.restart();
        const retry = new AbortController(), waiting = f.runtime.herdrQualityGate("review").evaluate(context as any, { signal: retry.signal }); waiting.catch(() => undefined);
        try { await expect.poll(async () => (f.runtime as any).gateWaiters.size, { timeout: 15000 }).toBe(1); await f.runtime.flushOutbound();
          expect(f.transport.sentRequests.filter(request => JSON.parse(request.instruction).payload?.kind === "resume_verification_request")).toHaveLength(1);
          expect((await state()).outbound.filter((out: any) => out.message.payload?.kind === "resume_verification_request")).toHaveLength(1);
        } finally { retry.abort(); await waiting.catch(() => undefined); } return;
      }
      if (!["physical", "agy-physical", "model-then-physical", "recurrent-physical"].includes(mode)) { expect(notices.filter((out: any) => out.handle)).toHaveLength(0); return; }
      expect(notices).toHaveLength(1); expect(notices[0].capabilities).toEqual(original.capabilities);
      expect(notices[0]).toMatchObject({ status: expect.stringMatching(/^(accepted|released)$/), message: { type: "task.status", payload: { sourceMessageId: original.message.message_id } } });
      expect((await state()).outbound.find((out: any) => out.message.message_id === original.message.message_id)).toEqual(original);
      expect(f.transport.sentRequests.filter(request => JSON.parse(request.instruction).type === "verification.requested")).toHaveLength(1);
      if (mode === "agy-physical") {
        const binding = f.panes.bindings.find(item => item.role === "reviewer")!;
        await expect(f.runtime.authorizeAgyProviderTurn(notices[0].request.context, binding)).resolves.toBeUndefined();
        await expect(f.runtime.authorizeAgyProviderTurn({ ...notices[0].request.context,
          payload: { ...notices[0].message.payload, conversationUserMessageId: "fabricated-turn" } }, binding)).rejects.toThrow();
        await (f.runtime as any).journal.exclusive(async (journal: any, save: any) => {
          const run = journal.runs[0], receipt = run.resumeReceipts.find((item: any) => item.actionId === run.pendingAction.actionId);
          journal.outbound.find((item: any) => item.message.message_id === receipt.messageId).message.payload.automatic = true;
          await save();
        });
        await expect(f.runtime.authorizeAgyProviderTurn(notices[0].request.context, binding)).rejects.toThrow();
        await (f.runtime as any).journal.exclusive(async (journal: any, save: any) => {
          const run = journal.runs[0], receipt = run.resumeReceipts.find((item: any) => item.actionId === run.pendingAction.actionId);
          journal.outbound.find((item: any) => item.message.message_id === receipt.messageId).message.payload.automatic = false;
          await save();
        });
      }
      second.abort(); await resumed.catch(() => undefined); f.restart();
      const restarted = new AbortController(); resumed = f.runtime.herdrQualityGate("review").evaluate(context as any, { signal: restarted.signal }); resumed.catch(() => undefined);
      await expect.poll(async () => (f.runtime as any).gateWaiters.size, { timeout: 15000 }).toBe(1); await f.runtime.flushOutbound();
      expect(f.transport.sentRequests.filter(request => JSON.parse(request.instruction).payload?.kind === "resume_verification_request")).toHaveLength(1);
      await f.runtime.receiveHerdr(f.envelope("review.verdict", { gateId: "review", runId: "run-1", taskId: "implement", evaluationId: randomUUID(), status: "passed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString() },
        { sender: { role: "reviewer", agent_id: original.handle.target.agentId, pane_id: original.handle.target.paneId }, causation_id: original.message.message_id }));
      await expect(resumed).resolves.toMatchObject({ ok: true, value: { status: "passed" } });
      if (mode === "agy-physical") await expect(f.runtime.authorizeAgyProviderTurn(notices[0].request.context,
        f.panes.bindings.find(item => item.role === "reviewer")!)).rejects.toThrow();
    } finally { second.abort(); await resumed.catch(() => undefined); }
  }, 60000);
});
