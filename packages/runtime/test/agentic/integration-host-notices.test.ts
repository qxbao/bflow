import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, RoleMessageSchema, type PaneBinding } from "@bflow/contracts";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { digest } from "../../src/agentic/journal.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";
import { cleanups, unwrap, git, fixture } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe("Coordinator no-response host observations", () => {
  async function delivered(intake = false) {
    const f = await fixture({ intake });
    const message = f.envelope("delegation.request", { schemaVersion: 2, delegationId: "delegation-1", messageId: "intake-1", correlationId: "correlation-1",
      sessionId: "session-1", runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: "Plan change", objective: "Plan change",
      sddLevel: "lightweight", specificationId: f.spec.specId, acceptanceCriteria: f.spec.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: new Date().toISOString(), idempotencyKey: "intake-1" },
      { message_id: "intake-1", idempotency_key: "intake-1" });
    await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    return { ...f, message, binding: f.panes.bindings.find(p => p.role === "coordinator")! };
  }
  it("reports a legacy delivery whose journal has neither intake nor native ingress", async () => {
    const f = await delivered();
    await (f.runtime as any).journal.exclusive(async (state: any, save: any) => { state.runs = []; await save(); });
    await f.runtime.coordinatorTurnStopped(f.message, f.binding);
    const state = await f.runtime.inspect() as any;
    expect(state.runs).toEqual([]); expect(state.inbox).toEqual([]);
    const feedback = state.outbound.find((out: any) => out.message.type === "conversation.progress");
    expect(feedback.message).toMatchObject({ correlation_id: "correlation-1", causation_id: "intake-1", run_id: "run-1", recipient: { role: "conversation" },
      payload: { kind: "coordinator_no_response", headline: "Coordinator turn ended without a structured response", blockageReason: expect.stringContaining("no durable ingress") } });
    expect(feedback.message.payload).not.toHaveProperty("verified");
    await f.restart().coordinatorTurnStopped(f.message, f.binding);
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "conversation.progress")).toHaveLength(1);
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.some(message => (message.payload as any).kind === "coordinator_no_response")).toBe(true);
    expect(f.transport.sentRequests.some(call => call.role === "conversation")).toBe(false);
  });
  it("rejects untrusted envelopes and foreign pane/native sessions", async () => {
    const f = await delivered();
    for (const message of [{ ...f.message, payload: { forged: true } }, { ...f.message, message_id: "forged" }])
      await expect(f.runtime.coordinatorTurnStopped(message, f.binding)).rejects.toThrow("exact Runtime outbox");
    for (const binding of [{ ...f.binding, paneId: "other" }, { ...f.binding, session: { ...f.binding.session!, value: "other" } }])
      await expect(f.runtime.coordinatorTurnStopped(f.message, binding)).rejects.toThrow("exact Runtime outbox");
  });
  it("escalates an unanswered intake with an actionable next step after automatic delegation acceptance", async () => {
    const f = await delivered(); await f.runtime.receiveHerdr(f.message);
    await f.runtime.coordinatorTurnStopped(f.message, f.binding);
    expect((await f.runtime.inspect("run-1") as any)).toMatchObject({ status: "escalated", coreCreated: false, pendingAction: { kind: "resume_coordinator", owner: "coordinator" } });
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.kind === "coordinator_no_response")).toHaveLength(1);
  });
  it("does not treat queued progress as a business next action when the Coordinator stops", async () => {
    const f = await delivered(); await f.runtime.receiveHerdr(f.message);
    const reporting = f.runtime.reportProgress("run-1", "Planning the objective");
    await f.runtime.coordinatorTurnStopped(f.message, f.binding); await reporting;
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.kind === "coordinator_no_response")).toHaveLength(1);
  });
});


describe("Coordinator Stop delivery to Conversation", () => {
  it("presents host blockage to the real Conversation Gateway without completing a workflow", async () => {
    const f = await fixture({ intake: false }), contextDirectory = join(f.root, "stopped-conversation");
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest: unwrap(await f.panes.getManifest()), contextDirectory });
    const turn = await chat.handleUserTurn({ sessionId: "session-1", content: "Triển khai tính năng xác thực JWT HS256 trong packages/auth với thời hạn token 15 phút và unit test", provenance: { origin: "user", authenticatedUser: true } }) as any;
    expect(turn.value.recognizedIntent).toBe("workflow_request");
    await f.runtime.flushOutbound();
    const delegation = JSON.parse(f.transport.sentRequests.find(request => request.role === "coordinator")!.instruction);
    await f.runtime.coordinatorTurnStopped(delegation, f.panes.bindings.find(p => p.role === "coordinator")!);
    await f.runtime.flushOutbound();
    const notice = f.conversationInbox.find(message => (message.payload as any).kind === "coordinator_no_response")!;
    expect((await chat.receiveHerdr(notice) as any).ok).toBe(true);
    const module = await import("../../../conversation/dist/index.js");
    const context = unwrap(await new module.FileConversationContextStore(contextDirectory).load("session-1"))!;
    expect(Object.values(context.workflows)[0]).toMatchObject({ completedVerified: false, blockedReason: expect.stringContaining("no durable ingress") });
    expect(context.session.status).toBe("reporting_progress");
    expect((await f.runtime.inspect() as any).runs).toEqual([expect.objectContaining({ status: "escalated", coreCreated: false })]);
  });
  it("does not let progress from an earlier delegation hide an unanswered later turn", async () => {
    const f = await fixture(); await f.runtime.reportProgress("run-1", "Previous turn progress");
    const message = f.envelope("delegation.request", (await f.inspect()).delegation, { message_id: "later-turn", idempotency_key: "later-turn" });
    await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    await f.runtime.coordinatorTurnStopped(message, f.panes.bindings.find(p => p.role === "coordinator")!);
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.kind === "coordinator_no_response")).toHaveLength(1);
  });
  it("preserves pending user decisions at Stop", async () => {
    const f = await fixture();
    const message = f.envelope("delegation.request", (await f.inspect()).delegation, { message_id: "intake-1", idempotency_key: "intake-1" });
    await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(p => p.role === "coordinator")!;
    await f.runtime.requestUserDecision(binding, "coordinator", { runId: "run-1", taskId: "planning", question: "Which design?", options: ["A", "B"] });
    const before = await f.inspect(); await f.runtime.coordinatorTurnStopped(message, binding);
    expect(await f.inspect()).toEqual(before);
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.kind === "coordinator_no_response")).toEqual([]);
  });
});

describe("Specialist reply wake-up and failure visibility", () => {
  const specialistReply = (f: Awaited<ReturnType<typeof fixture>>, request: any, extra: Record<string, unknown> = {}) =>
    f.envelope("spec.draft", { status: "completed", summary: "Impact analysis" }, { causation_id: request.message_id,
      sender: { role: "architect", agent_id: "architect", pane_id: "pane-architect" }, recipient: { role: "coordinator" }, ...extra });
  async function delegated() {
    const f = await fixture();
    const queued = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]) as any;
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.some(request => request.role === "architect")).toBe(true);
    return { f, queued };
  }
  const sentTo = (f: Awaited<ReturnType<typeof fixture>>, role: string) => f.transport.sentRequests.filter(request => request.role === role).map(request => JSON.parse(request.instruction));

  it("wakes the Coordinator through Herdr once the Architect reply is applied (run no longer stalls in specifying)", async () => {
    const { f, queued } = await delegated();
    expect(sentTo(f, "coordinator")).toEqual([]);
    const reply = specialistReply(f, queued);
    await f.runtime.receiveHerdr(reply);
    expect((await f.inspect()).status).toBe("specifying");
    await f.runtime.flushOutbound();
    const notices = sentTo(f, "coordinator");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "task.status", sender: { role: "runtime" }, recipient: { role: "coordinator" }, causation_id: expect.any(String),
      payload: { kind: "specialist_result_ready", fromRole: "architect", messageType: "spec.draft", result: { summary: "Impact analysis" } } });
    await f.runtime.receiveHerdr(reply); // duplicate ingress never duplicates the wake-up
    await f.runtime.flushOutbound();
    expect(sentTo(f, "coordinator")).toHaveLength(1);
  });

  it("keeps the wake-up queued while the Coordinator is busy instead of dropping it", async () => {
    const { f, queued } = await delegated();
    f.panes.busy.add("coordinator");
    await f.runtime.receiveHerdr(specialistReply(f, queued)); await f.runtime.flushOutbound();
    expect(sentTo(f, "coordinator")).toEqual([]);
    f.panes.busy.delete("coordinator"); await f.runtime.flushOutbound();
    expect(sentTo(f, "coordinator")).toHaveLength(1);
  });

  it("reports a rejected inbound specialist message to Conversation with a concrete reason", async () => {
    const { f, queued } = await delegated();
    const reply = specialistReply(f, queued);
    await f.runtime.reportInboundFailure(reply, "Transport sender binding unavailable");
    await f.runtime.reportInboundFailure(reply, "Transport sender binding unavailable"); // idempotent
    await f.runtime.flushOutbound();
    const notices = f.conversationInbox.filter(message => (message.payload as any).kind === "delivery_failure").map(message => message as any);
    expect(notices).toHaveLength(1);
    expect(notices[0].payload.blockageReason).toContain("Transport sender binding unavailable");
    expect(notices[0].payload.blockageReason).toContain("architect");
    expect(notices[0].run_id).toBe("run-1");
  });

  it("surfaces a stuck outbound delivery (no recipient pane) to Conversation instead of staying silent", async () => {
    const { f } = await delegated();
    f.panes.bindings.splice(f.panes.bindings.findIndex(p => p.role === "planner"), 1);
    const out = f.envelope("task.status", { kind: "probe" }, { sender: { role: "runtime" }, recipient: { role: "planner" } });
    await f.runtime.queueHerdr(out); await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const notices = f.conversationInbox.filter(message => (message.payload as any).kind === "delivery_failure").map(message => message as any);
    expect(notices).toHaveLength(1);
    expect(notices[0].payload.blockageReason).toContain("Recipient pane unavailable");
  });
});

describe("current native Agy turn authority", () => {
  it.each(["cancelled run", "revoked lease", "pending human decision"] as const)("fences actual workspace file IO after %s", async condition => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const out = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.type === "task.assignment" && item.status === "accepted");
    const binding = f.panes.bindings.find(item => item.paneId === out.handle.target.paneId)!;
    const development = new HostDevelopment(() => f.runtime, []);
    const before = await development.readWorkspaceFile(binding, { runId: "run-1", taskId: "implement", path: "guide.md" }) as any;
    expect(before.content).toBe("initial\n");
    await development.writeWorkspaceFile(binding, { runId: "run-1", taskId: "implement", path: "guide.md", content: "updated\n", expectedSha256: before.sha256 });
    const after = await development.readWorkspaceFile(binding, { path: "guide.md" }) as any;
    expect(after.content).toBe("updated\n");
    if (condition === "cancelled run") await f.runtime.cancel("run-1", "Guarded file IO regression");
    else if (condition === "pending human decision")
      await f.runtime.requestUserDecision(binding, "developer", { runId: "run-1", taskId: "implement", question: "Which scope?", options: ["A", "B"] });
    else {
      const current = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.message_id === out.message.message_id);
      unwrap(await f.ports.registry.releaseLease({ leaseId: current.lease.leaseId, fencingToken: current.lease.fencingToken,
        expectedVersion: current.lease.version, releasedAt: new Date().toISOString(), idempotencyKey: "revoke-file-io" }));
    }
    await expect(development.writeWorkspaceFile(binding, { path: "guide.md", content: "stale write\n", expectedSha256: after.sha256 })).rejects.toThrow();
    await expect(development.readWorkspaceFile(binding, { path: "guide.md" })).rejects.toThrow();
    expect(await readFile(join(binding.worktreePath!, "guide.md"), "utf8")).toBe("updated\n");
  });

  it("admits only the exact superseded-question cancellation for a native Agy specialist", async () => {
    const f = await fixture(), binding = f.panes.bindings.find(p => p.role === "architect")!;
    binding.provider = "herdr"; binding.agentKind = "agy";
    binding.session = { source: "herdr:antigravity_cli", kind: "id", value: "native-agy-revision" };
    await f.runtime.requestSpecialist("run-1", "architect", "Analyze", ["architecture"]); await f.runtime.flushOutbound();
    await f.runtime.requestUserDecision(binding, "architect", { runId: "run-1", taskId: "planning", question: "Choose scope", options: ["A", "B"] });
    const before = await f.inspect();
    const revised = { ...before.delegation, delegationId: "delegation-2", messageId: "intake-2", idempotencyKey: "intake-2",
      metadata: { isRequirementChange: true, revision: 2 } };
    await f.runtime.queueHerdr(f.envelope("delegation.request", revised, { message_id: "intake-2", idempotency_key: "intake-2" }));
    await f.runtime.flushOutbound();
    const resumed = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.payload.kind === "user_decision_answer");
    expect(resumed.status).toBe("accepted");
    expect(resumed.message.payload).toMatchObject({ outcome: "cancelled", reason: "Requirement revision 2 superseded this question" });
    await expect(f.runtime.authorizeAgyProviderTurn(resumed.request.context, binding)).resolves.toBeUndefined();
    await expect(f.runtime.authorizeAgyProviderTurn({ ...resumed.request.context,
      payload: { ...resumed.message.payload, outcome: "approved" } }, binding)).rejects.toThrow();
  });

  it.each(["architect", "developer"] as const)("retains a pending human wait and authorizes only its real answer for Agy %s", async role => {
    const f = await fixture();
    let binding: PaneBinding;
    if (role === "developer") {
      const allocate = f.panes.allocateDeveloper.bind(f.panes);
      f.panes.allocateDeveloper = async request => {
        const result = await allocate(request);
        if (result.ok) { result.value.agentKind = "agy"; result.value.provider = "herdr";
          result.value.session = { source: "herdr:antigravity_cli", kind: "id", value: "native-agy-decider" }; }
        return result;
      };
      await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
      binding = f.panes.bindings.find(item => item.role === "developer")!;
    } else {
      binding = f.panes.bindings.find(item => item.role === "architect")!;
      binding.agentKind = "agy"; binding.provider = "herdr";
      binding.session = { source: "herdr:antigravity_cli", kind: "id", value: "native-agy-decider" };
      await f.runtime.requestSpecialist("run-1", "architect", "Analyze", ["architecture"]); await f.runtime.flushOutbound();
    }
    const initial = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.recipient.role === role && out.status === "accepted");
    expect(initial).toBeDefined();
    const taskId = role === "developer" ? "implement" : "planning";
    const requested = await f.runtime.requestUserDecision(binding, role, { runId: "run-1", taskId, question: "Select scope", options: ["A", "B"] }) as any;
    const entry = (await f.inspect()).userDecisions[requested.approvalId];
    const request = entry.request;
    const answer = ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: request.approvalId, runId: "run-1", sessionId: request.sessionId,
      target: request.target, revision: request.revision, generation: request.generation, decision: "approved", decidedBy: "human-1",
      decidedAt: new Date().toISOString(), feedbackArtifacts: [], idempotencyKey: "native-answer", metadata: { selectedOption: "A" } });
    await f.runtime.receiveHerdr(f.envelope("approval.decision", answer)); await f.runtime.flushOutbound();
    const state = await f.runtime.inspect() as any;
    const resumed = state.outbound.find((out: any) => out.message.payload.kind === "user_decision_answer");
    expect(resumed.status).toBe("accepted");
    expect(resumed.message.payload).toMatchObject({ approvalId: request.approvalId, outcome: "approved", selectedOption: "A" });
    if (role === "developer") {
      expect(resumed.parentAssignmentId).toBe(initial.message.message_id);
      expect(resumed.lease.leaseId).toBe(initial.lease.leaseId);
      expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!.agentExecution).toEqual(initial.handle);
    }
    await expect(f.runtime.authorizeAgyProviderTurn(resumed.request.context, binding)).resolves.toBeUndefined();
    await expect(f.runtime.authorizeAgyProviderTurn({ ...resumed.request.context, payload: { ...resumed.message.payload, approvalId: "foreign" } }, binding)).rejects.toThrow();
    await f.runtime.cancel("run-1", "native decision test complete");
    await expect(f.runtime.authorizeAgyProviderTurn(resumed.request.context, binding)).rejects.toThrow();
  });

  async function assigned() {
    const f = await fixture();
    const binding = f.panes.bindings.find(p => p.role === "architect")!;
    binding.provider = "herdr"; binding.agentKind = "agy";
    binding.session = { source: "herdr:antigravity_cli", kind: "id", value: "native-agy-architect" };
    await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]);
    await f.runtime.flushOutbound();
    const out = (await f.runtime.inspect() as any).outbound.find((item: any) => item.message.recipient.role === "architect" && item.status === "accepted");
    expect(out).toBeDefined();
    return { f, binding, out, message: RoleMessageSchema.parse(out.request.context) };
  }
  it("permits explicit receipt-drain operations under current quiesced Agy authority", async () => {
    const { f, binding, message } = await assigned();
    await f.runtime.quiesce();
    for (const operation of ["inspect_native_delivery", "host_status", "assignment_context", "repository_read", "read_pinned_instructions",
      "read_task_log", "log_task_step", "inspect_review", "complete_review", "inspect_alternative_verification",
      "record_alternative_verification", "record_behavioral_verification", "submit_implementation"])
      await expect(f.runtime.authorizeAgyProviderTurn(message, binding, operation)).resolves.toBeUndefined();
    await expect(f.runtime.authorizeAgyProviderTurn({ ...message, correlation_id: "foreign" }, binding, "repository_read")).rejects.toThrow();
  });
  it("refuses admission, new work and unknown operations while Agy is quiesced", async () => {
    const { f, binding, message } = await assigned();
    await f.runtime.quiesce();
    await expect(f.runtime.authorizeAgyProviderTurn(message, binding)).rejects.toThrow();
    for (const operation of ["assess", "request_specialist", "request_user_decision", "send_role_message", "run_task_command", "write_file", "unknown_operation", ""])
      await expect(f.runtime.authorizeAgyProviderTurn(message, binding, operation)).rejects.toThrow();
  });
  it.each(["pending decision", "cancelled run", "revoked lease"] as const)("retains %s checks for quiesced Agy receipt draining", async condition => {
    const { f, binding, message, out } = await assigned();
    if (condition === "pending decision")
      await f.runtime.requestUserDecision(binding, "architect", { runId: "run-1", taskId: "planning", question: "Choose", options: ["A", "B"] });
    else if (condition === "cancelled run") await f.runtime.cancel("run-1", "Stop before draining");
    else unwrap(await f.ports.registry.releaseLease({ leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken,
      expectedVersion: out.lease.version, releasedAt: new Date().toISOString(), idempotencyKey: "revoke-quiesced-drain" }));
    await f.runtime.quiesce();
    await expect(f.runtime.authorizeAgyProviderTurn(message, binding, "complete_review")).rejects.toThrow();
  });
  it("fences native tools while that exact Agy pane is waiting for a human decision", async () => {
    const { f, binding, message } = await assigned();
    await f.runtime.requestUserDecision(binding, "architect", { runId: "run-1", taskId: "planning", question: "Choose", options: ["A", "B"] });
    await expect(f.runtime.authorizeAgyProviderTurn(message, binding)).rejects.toThrow(/pending|wait/i);
  });
  it("authorizes quiesced receipt draining for a real wrapped Developer assignment and rejects stale Core execution", async () => {
    const f = await fixture();
    const allocate = f.panes.allocateDeveloper.bind(f.panes);
    f.panes.allocateDeveloper = async request => {
      const result = await allocate(request);
      if (result.ok) { result.value.provider = "herdr"; result.value.agentKind = "agy";
        result.value.session = { source: "herdr:antigravity_cli", kind: "id", value: "native-agy-developer" }; }
      return result;
    };
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any;
    const out = state.outbound.find((item: any) => item.message.type === "task.assignment" && item.status === "accepted");
    expect(out).toBeDefined();
    const binding = f.panes.bindings.find(item => item.paneId === out.handle.target.paneId)!;
    const message = RoleMessageSchema.parse(out.request.context);
    expect(digest(message)).not.toBe(digest(out.message));
    await expect(f.runtime.authorizeAgyProviderTurn(message, binding)).resolves.toBeUndefined();
    await f.runtime.quiesce();
    await expect(f.runtime.authorizeAgyProviderTurn(message, binding, "submit_implementation")).resolves.toBeUndefined();
    const snapshot = unwrap(await f.ports.engine.getSnapshot("run-1"))!;
    unwrap(await f.ports.engine.requestCancellation({ schemaVersion: 1, cancellationId: "cancel-core-native", runId: "run-1",
      expectedVersion: snapshot.version, reason: "stale Core authority", requestedBy: "test", requestedAt: new Date().toISOString(), idempotencyKey: "cancel-core-native" }));
    await expect(f.runtime.authorizeAgyProviderTurn(message, binding, "submit_implementation")).rejects.toThrow();
  });
  it("retains Agy authority for a delivered retry notice after an authorized higher-fence lease continuation", async () => {
    const f = await fixture({ tdd: true });
    let clockOffset = 0;
    const clock = () => new Date(Date.now() + clockOffset);
    f.ports.clock = clock;
    f.ports.registry = new FileAgentRegistry({ stateFile: join(f.root, "registry.json"), clock });
    f.ports.preflightRoleCapabilities = async () => undefined;
    f.ports.roleCapabilities.qa = ["verification", "testing", "repository.read"];
    const allocate = f.panes.allocateDeveloper.bind(f.panes);
    f.panes.allocateDeveloper = async request => {
      const result = await allocate(request);
      if (result.ok) { result.value.provider = "herdr"; result.value.agentKind = "agy";
        result.value.session = { source: "herdr:antigravity_cli", kind: "id", value: "native-agy-lease-continuation" }; }
      return result;
    };
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any;
    const original = state.outbound.find((out: any) => out.message.type === "task.assignment");
    const binding = f.panes.bindings.find(item => item.paneId === original.handle.target.paneId)!;
    const revision = git(binding.worktreePath!, "rev-parse", "HEAD");
    const queued = await f.runtime.requestPhaseVerification(binding, "run-1", "implement", "red", revision) as any;
    await f.runtime.flushOutbound();
    const qa = f.panes.bindings.find(item => item.role === "qa")!;
    await f.runtime.recordPhaseFailure(qa, queued.messageId, "Independent runner unavailable", false);
    const paused = await f.inspect();
    await expect(f.runtime.authorizeAgyProviderTurn(original.request.context, binding, "request_verification")).rejects.toThrow(/paused|escalated/);
    await f.runtime.resumeBlockedRun("run-1", paused.pendingAction.actionId, { conversationUserMessageId: "physical-lease-resume" });
    await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
    const resumed = await f.runtime.inspect() as any;
    const notice = resumed.outbound.find((out: any) => out.parentAssignmentId === original.message.message_id && out.message.payload.status === "retry");
    expect(notice.status).toBe("accepted");
    await expect(f.runtime.authorizeAgyProviderTurn(notice.request.context, binding, "request_verification")).resolves.toBeUndefined();
    // Provider throttling outlives the original lease; recovery retains this exact delivered notice.
    clockOffset += 301_000;
    await f.runtime.recoverMissingCoordinatorWakeups();
    const recovered = await f.runtime.inspect() as any;
    const parent = recovered.outbound.find((out: any) => out.message.message_id === original.message.message_id);
    const retained = recovered.outbound.find((out: any) => out.message.message_id === notice.message.message_id);
    expect(parent.leaseHistory).toHaveLength(1);
    expect(parent.lease.fencingToken).toBeGreaterThan(notice.request.metadata.fencingToken);
    expect(parent.request).toEqual(original.request); expect(parent.assignment).toEqual(original.assignment); expect(parent.handle).toEqual(original.handle);
    expect(retained.request).toEqual(notice.request); expect(retained.handle).toEqual(notice.handle);
    expect(recovered.outbound.filter((out: any) => out.parentAssignmentId === parent.message.message_id)).toHaveLength(1);
    await expect(f.runtime.authorizeAgyProviderTurn(retained.request.context, binding, "request_verification")).resolves.toBeUndefined();
    await expect(f.runtime.authorizeAgyProviderTurn(parent.request.context, binding, "assignment_context")).resolves.toBeUndefined();
    // A valid historical dispatch never overrides revocation of the current Registry grant.
    const current = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.message_id === parent.message.message_id);
    unwrap(await f.ports.registry.releaseLease({ leaseId: current.lease.leaseId, fencingToken: current.lease.fencingToken,
      expectedVersion: current.lease.version, releasedAt: clock().toISOString(), idempotencyKey: "revoke-continued-agy" }));
    await expect(f.runtime.authorizeAgyProviderTurn(retained.request.context, binding, "request_verification")).rejects.toThrow();
    await expect(f.runtime.authorizeAgyProviderTurn(parent.request.context, binding, "assignment_context")).rejects.toThrow();
  });
  it("authorizes the exact current specialist delivery using current Registry authority", async () => {
    const { f, binding, message } = await assigned();
    await expect(f.runtime.authorizeAgyProviderTurn(message, binding)).resolves.toBeUndefined();
    await expect(f.runtime.authorizeAgyProviderTurn({ ...message, correlation_id: "wrong" }, binding)).rejects.toThrow();
  });
  it("refuses new Agy admission and tool authorization after its exact delivery was answered", async () => {
    const { f, binding, message, out } = await assigned();
    await f.runtime.receiveHerdr(f.envelope("spec.draft", { status: "completed", summary: "Analysis done" }, { causation_id: out.message.message_id,
      sender: { role: "architect", agent_id: binding.agentId, pane_id: binding.paneId }, recipient: { role: "coordinator" } }));
    await expect(f.runtime.validateProviderDelivery(message, binding)).resolves.toBeUndefined();
    await expect(f.runtime.authorizeAgyProviderTurn(message, binding)).rejects.toThrow();
  });
  it("refuses an exact old Agy envelope after its run is cancelled", async () => {
    const { f, binding, message } = await assigned();
    await f.runtime.authorizeAgyProviderTurn(message, binding);
    await f.runtime.cancel("run-1", "native authority regression");
    await expect(f.runtime.authorizeAgyProviderTurn(message, binding)).rejects.toThrow();
  });
  it("refuses a Registry-revoked lease even while the stored expiry is still in the future", async () => {
    const { f, binding, message, out } = await assigned();
    expect(Date.parse(out.lease.expiresAt)).toBeGreaterThan(Date.now());
    unwrap(await f.ports.registry.releaseLease({ leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken,
      expectedVersion: out.lease.version, releasedAt: new Date().toISOString(), idempotencyKey: "revoke-native-authority" }));
    await expect(f.runtime.authorizeAgyProviderTurn(message, binding)).rejects.toThrow();
  });
});

describe("Runtime Stop and uncertain delivery notices", () => {
  it("does not let a delayed Stop for an answered source settle a newer assignment on the same pane", async () => {
    const f = await fixture();
    const first = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]) as any;
    await f.runtime.flushOutbound();
    await f.runtime.receiveHerdr(f.envelope("spec.draft", { status: "completed", summary: "First analysis" }, { causation_id: first.message_id,
      sender: { role: "architect", agent_id: "architect", pane_id: "pane-architect" }, recipient: { role: "coordinator" } }));
    const second = await f.runtime.requestSpecialist("run-1", "architect", "Analyze a later change", ["architecture"]) as any;
    await f.runtime.flushOutbound();
    const architect = f.panes.bindings.find(p => p.role === "architect")!;

    await f.runtime.specialistTurnStopped(architect, "architect", new Date().toISOString(), first.message_id);
    await f.runtime.flushOutbound();

    expect(second.message_id).not.toBe(first.message_id);
    expect(f.conversationInbox.filter(message => (message.payload as any).kind === "specialist_no_response")).toEqual([]);
  });

  it("reports an unanswered verification request when its exact specialist turn stops", async () => {
    const f = await fixture();
    const request = f.envelope("verification.requested", { runId: "run-1", taskId: "review-task", definition: { id: "review-gate" } },
      { sender: { role: "coordinator" }, recipient: { role: "reviewer" } });
    await f.runtime.queueHerdr(request); await f.runtime.flushOutbound();
    const reviewer = f.panes.bindings.find(p => p.role === "reviewer")!;

    await f.runtime.specialistTurnStopped(reviewer, "reviewer", new Date().toISOString(), request.message_id);
    await f.runtime.flushOutbound();

    expect(f.conversationInbox.filter(message => (message.payload as any).kind === "specialist_no_response")).toHaveLength(1);
  });

  it("specialistTurnStopped tells Conversation and wakes the Coordinator once while the assignment is unanswered", async () => {
    const f = await fixture();
    await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]);
    await f.runtime.flushOutbound();
    const architect = f.panes.bindings.find(p => p.role === "architect")!;
    await f.runtime.specialistTurnStopped(architect, "architect");
    await f.runtime.specialistTurnStopped(architect, "architect");
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.filter(message => (message.payload as any).kind === "specialist_no_response")).toHaveLength(1);
    const wakes = f.transport.sentRequests.filter(request => request.role === "coordinator").map(request => JSON.parse(request.instruction));
    expect(wakes.filter(wake => wake.payload?.kind === "specialist_no_response")).toEqual([expect.objectContaining({
      type: "task.status", sender: { role: "runtime" }, payload: expect.objectContaining({ fromRole: "architect", reason: expect.stringContaining("architect") }) })]);
  });
  it("does not report a specialist that already answered its assignment", async () => {
    const f = await fixture();
    const queued = await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]) as any;
    await f.runtime.flushOutbound();
    await f.runtime.receiveHerdr(f.envelope("spec.draft", { status: "completed", summary: "Impact analysis" }, { causation_id: queued.message_id,
      sender: { role: "architect", agent_id: "architect", pane_id: "pane-architect" }, recipient: { role: "coordinator" } }));
    await f.runtime.specialistTurnStopped(f.panes.bindings.find(p => p.role === "architect")!, "architect");
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.filter(message => (message.payload as any).kind === "specialist_no_response")).toEqual([]);
  });
  it("does not report a specialist that stopped while waiting on a user decision it requested", async () => {
    const f = await fixture();
    await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]);
    await f.runtime.flushOutbound();
    const architect = f.panes.bindings.find(p => p.role === "architect")!;
    await f.runtime.requestUserDecision(architect, "architect", { runId: "run-1", taskId: "planning", question: "Which design?", options: ["A", "B"] });
    await f.runtime.specialistTurnStopped(architect, "architect");
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.filter(message => (message.payload as any).kind === "specialist_no_response")).toEqual([]);
  });
  it("coordinatorStopWithoutResponse carries the reason and numbered options to Conversation", async () => {
    const f = await fixture();
    const message = f.envelope("delegation.request", { schemaVersion: 2, delegationId: "delegation-1", messageId: "intake-1", correlationId: "correlation-1",
      sessionId: "session-1", runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: "Plan change", objective: "Plan change",
      sddLevel: "lightweight", specificationId: f.spec.specId, acceptanceCriteria: f.spec.acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: new Date().toISOString(), idempotencyKey: "intake-2",
      metadata: { isRequirementChange: true, revision: 2 } }, { message_id: "intake-2", idempotency_key: "intake-2" });
    await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(p => p.role === "coordinator")!;
    await f.runtime.coordinatorStopWithoutResponse(message, binding, "Coordinator pane could not be matched: occupant changed");
    await f.runtime.flushOutbound();
    expect(f.conversationInbox.find(item => (item.payload as any).kind === "coordinator_no_response")?.payload).toMatchObject({
      reason: "Coordinator pane could not be matched: occupant changed", blockageReason: "Coordinator pane could not be matched: occupant changed",
      options: ["Khắc phục blocker rồi yêu cầu Coordinator tiếp tục run", "Hủy run"] });
  });
  it("reportUncertainNativeDelivery surfaces a delivery_failure with the operation id once, and never resends", async () => {
    const f = await fixture();
    await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]);
    await f.runtime.flushOutbound();
    const request = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "delegation.request").message;
    const sentBefore = f.transport.sentRequests.length;
    await f.runtime.reportUncertainNativeDelivery(request, "op-42", "Native delivery acknowledgement is uncertain");
    await f.runtime.reportUncertainNativeDelivery(request, "op-42", "Native delivery acknowledgement is uncertain");
    await f.runtime.flushOutbound();
    const failures = f.conversationInbox.filter(item => (item.payload as any).kind === "delivery_failure");
    expect(failures).toHaveLength(1);
    expect((failures[0]!.payload as any).blockageReason).toContain("op-42");
    expect(f.transport.sentRequests.slice(sentBefore).filter(request => request.role === "architect")).toEqual([]);
  });
});

// Runs on every platform (real Git in a realpath'd temporary repository): the resolver's Developer tools.
describe("Conflict resolver Developer tools", () => {
  it("gives the resolver its context through assignment_context/workspace_status and refuses Core-task tools clearly", async () => {
    const f = await fixture({ parallel: true, conflict: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other");
    await f.submit("implement", "first branch\n"); await f.submit("other", "second branch\n");
    await f.runtime.tick(); await f.runtime.tick();
    const assignment = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "task.assignment" && out.message.payload.kind === "conflict_resolution");
    expect(assignment.status).toBe("accepted");
    const resolver = f.panes.bindings.find(binding => binding.paneId === assignment.handle.target.paneId)!;
    const worktree = resolver.worktreePath!, head = git(worktree, "rev-parse", "HEAD");
    const development = new HostDevelopment(() => f.runtime, []);
    const context = await development.conflictResolutionContext(resolver) as any; // host assignment_context payload
    expect(context).toMatchObject({ kind: "conflict_resolution", runId: "run-1", taskId: assignment.taskId, worktreePath: worktree,
      conflictPaths: ["guide.md"], unmergedPaths: ["guide.md"], base: head, head, mergeInProgress: true, attempt: 1, maxAttempts: 2 });
    expect(context.incomingCommitHash).toMatch(/^[a-f0-9]{40}$/);
    expect(context.rules.join(" ")).toMatch(/conflictPaths.*ours or theirs.*commit_changes/s);
    expect(await development.status(resolver, {})).toEqual(context); // workspace_status
    expect(await development.check(resolver, {})).toMatchObject({ applicable: false, independentAcceptanceEvidence: false });
    for (const tool of ["request_verification", "authorize_implementation", "submit_implementation"])
      await expect(development.refuseForResolver(resolver, tool)).rejects.toThrow(`${tool} is not used for a conflict resolution assignment; edit only the conflicted files, commit the resolution with commit_changes, then end your turn`);
    // An ordinary Core-task Developer pane is not affected by the resolver guard.
    const coreDeveloper = f.panes.bindings.find(binding => binding.role === "developer" && binding.paneId !== resolver.paneId)!;
    await expect(development.refuseForResolver(coreDeveloper, "request_verification")).resolves.toBeUndefined();
    expect(await development.conflictResolutionContext(coreDeveloper)).toBeUndefined();
    await f.runtime.requestUserDecision(resolver, "developer", { runId: "run-1", taskId: assignment.taskId,
      question: "Which conflict resolution should be used?", options: ["A", "B"] });
    await expect(development.authorizeFileEdit(resolver, { tool_name: "Write", tool_input: { file_path: "guide.md" } })).rejects.toThrow(/pending human decision/);
    await expect(development.writeWorkspaceFile(resolver, { path: "guide.md", content: "unapproved\n", expectedSha256: null })).rejects.toThrow(/pending human decision/);
  });
});
