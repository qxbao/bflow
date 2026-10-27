import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResultSchema, RoleMessageSchema } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { createSignedBindingReceipt } from "../../src/agentic/receipt-host.js";
import { digest } from "../../src/agentic/journal.js";
import { workflow } from "../../../specification/test/fixtures.js";
import { cleanups, unwrap, fixture } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe.skipIf(process.platform === "win32")("P19 integrated Agentic SDLC", () => {
  it("reconciliation permits resend only after a proven not_delivered result", async () => {
    const f = await fixture(); f.panes.busy.add("conversation");
    f.transport.customSendHandler = () => ({ ok: false, error: { code: "timeout", retryable: true, message: "uncertain" } });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any; const out = state.outbound.find((item: any) => item.status === "unknown_delivery");
    f.transport.customReconcileHandler = request => ({ ok: true, value: { status: "not_delivered", requestId: request.requestId, retrySafe: true, observedAt: new Date().toISOString() } });
    await f.runtime.reconcileDelivery(out.message.message_id); f.transport.customSendHandler = undefined;
    await f.runtime.tick(); expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(2);
    expect((await f.inspect()).tasks[0].outboundIds).toHaveLength(1);
    const sent = f.transport.sentRequests.filter(req => req.role === "developer"); expect(sent[1]).toEqual(sent[0]);
  });
  it("project-required task approval blocks dependent dispatch and supports human rejection", async () => {
    const f = await fixture({ parallel: true }); f.def.tasks[0]!.requiresApproval = true;
    f.def.dependencies = [{ taskId: "other", dependsOnTaskId: "implement", condition: "succeeded" }] as any;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit(); await f.runtime.tick();
    expect((await f.inspect()).approvalKind).toBe("task");
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
    await f.approve("rejected"); await f.runtime.tick();
    expect((await f.inspect()).status).toBe("failed");
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
  });
  describe("parallel task approval recovery", () => {
    let f: Awaited<ReturnType<typeof fixture>>;
    beforeEach(async () => {
      f = await fixture({ parallel: true });
      f.def.tasks.forEach(task => { task.requiresApproval = true; });
      await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
      await f.evidence("implement"); await f.evidence("other"); await f.submit(); await f.submit("other", "second file\n");
      await f.runtime.tick();
    });
    it("preserves each parallel task approval across restart before workflow delivery", async () => {
      expect((await f.inspect()).approval.target).toEqual({ type: "task", taskId: "implement" });
      await f.restart().tick();
      expect((await f.inspect()).approval.target).toEqual({ type: "task", taskId: "implement" });
      await f.approve(); await f.runtime.tick();
      expect((await f.inspect()).status).toBe("awaiting_approval");
      expect((await f.inspect()).approval.target).toEqual({ type: "task", taskId: "other" });
      await f.approve(); await f.runtime.tick();
      expect((await f.inspect()).approvalKind).toBe("delivery");
      await f.approve(); expect((await f.inspect()).status).toBe("completed");
    });
  });
  it("defers an authenticated native binding while paused and verifies it once after resume without task success", async () => {
    const f = await fixture();
    f.ports.preflightRoleCapabilities = async (binding, required) => {
      expect(unwrap(await f.panes.getRoleBinding(binding.role))?.bindingId).toBe(binding.bindingId);
      for (const capability of required) expect(f.ports.roleCapabilities[binding.role]).toContain(capability);
    };
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const source = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.type === "task.assignment");
    const handle = source.handle;
    const receipt = createSignedBindingReceipt({ receiptId: "paused-binding", issuerId: "native-test-host", handle,
      observedAt: new Date().toISOString(), privateKey: f.privateKey,
      correlation: handle.correlation }); // The fixture transport already verified this exact token; never re-correlate it.
    const signed = f.envelope("execution.receipt", receipt, { message_id: "paused-binding-envelope", idempotency_key: "paused-binding-key",
      causation_id: source.message.message_id, sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } });
    const placeholder = RoleMessageSchema.parse({ ...signed, payload: { ...receipt, signature: { algorithm: "ed25519", value: Buffer.alloc(64).toString("base64") } } });
    const binding = f.panes.bindings.find(pane => pane.paneId === handle.target.paneId)!;
    for (let attempt = 0; attempt < 3; attempt++)
      await f.runtime.reportRoleToolFailure(binding, { ...signed, artifact_references: undefined }, "artifact_references: Required");
    const actionId = (await f.inspect()).pendingAction.actionId;
    await f.runtime.recordNativeDeliveryIntent(placeholder, "paused-binding-operation");
    expect(await f.runtime.receiveHerdr(signed)).toMatchObject({ received: true, deferred: true });
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!.bindingVerification).toBeUndefined();
    expect((await f.inspect()).status).toBe("escalated");
    await f.runtime.reportUncertainNativeDelivery(placeholder, "paused-binding-operation", "Stale native ACK observation");
    expect((await f.inspect()).nativeDeliveries).toEqual([]);
    await f.runtime.resumeBlockedRun("run-1", actionId);
    await f.runtime.recoverMissingCoordinatorWakeups(); await f.runtime.recoverMissingCoordinatorWakeups();
    const task = unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!;
    expect(task.status).toBe("running"); expect(task.bindingVerification?.receipt.receiptId).toBe("paused-binding");
    expect((await f.inspect()).tasks[0].result).toBeUndefined();
    expect(f.transport.sentRequests.filter(request => request.role === "developer")).toHaveLength(1);
  });
  it("does not revive human rejection with a parallel verification outcome", async () => {
    const f = await fixture({ parallel: true });
    f.def.tasks[0]!.requiresApproval = true;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other"); await f.submit(); await f.submit("other", "second file\n");
    await f.runtime.tick(); expect((await f.inspect()).status).toBe("awaiting_approval");
    await f.approve("rejected"); await f.restart().tick();
    expect((await f.inspect()).status).toBe("failed");
    expect((await f.inspect()).integrationKey).toBeUndefined();
  });
  it("retains human rejection when a concurrent verifier throws after the decision", async () => {
    const f = await fixture({ parallel: true }); f.def.tasks[0]!.requiresApproval = true;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other"); await f.submit(); await f.submit("other", "second file\n");
    const verify = f.ports.policies.verification.verify.bind(f.ports.policies.verification);
    let entered!: () => void, rejectVerification!: (error: Error) => void;
    const checkingOther = new Promise<void>(resolve => { entered = resolve; });
    const deferred = new Promise<never>((_resolve, reject) => { rejectVerification = reject; });
    vi.spyOn(f.ports.policies.verification, "verify").mockImplementation(async (...args) => {
      if (args[0].taskId === "other") { entered(); return deferred; }
      return verify(...args);
    });
    const ticking = f.runtime.tick(); await checkingOther;
    expect((await f.inspect()).approval.target).toEqual({ type: "task", taskId: "implement" });
    await f.approve("rejected");
    rejectVerification(new Error("Injected concurrent verification storage failure")); await ticking;
    expect((await f.inspect()).status).toBe("failed");
    expect((await f.inspect()).error).toBe("User refused");
    await f.restart().tick();
    expect((await f.inspect()).status).toBe("failed");
    expect((await f.inspect()).error).toBe("User refused");
    expect((await f.inspect()).integrationKey).toBeUndefined();
  });
  it("rejects forged results and conflicting inbox messages before advancing task state", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await expect(f.runtime.receiveHerdr(f.envelope("implementation.submitted", { status: "succeeded" }, { sender: { role: "developer" } }))).rejects.toThrow();
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!.status).toBe("running");
    const message = f.envelope("task.status", { headline: "Working" });
    await f.runtime.receiveHerdr(message);
    await expect(f.runtime.receiveHerdr({ ...message, payload: { headline: "Different task" } })).rejects.toThrow("Conflicting inbound");
  });

  it("not_applicable requires alternative evidence and cannot pass by skipping tests", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick(); await f.submit();
    await f.runtime.tick(); expect((await f.inspect()).tasks[0].spec.strategy.tddDecision.mode).toBe("not_applicable");
    expect((await f.inspect()).tasks[0].cycle).toBeUndefined(); expect(f.calls).toHaveLength(0);
    await f.evidence("implement"); await f.runtime.tick(); expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
  });
  it("starts a dependent task from its dependency's verified head", async () => {
    // Live run bf-b5679f4f2e725cadfef1: task-integration depended on task-unit but started from the run base, so its
    // Developer re-implemented the module and integration had to merge two unrelated versions of the same file.
    const f = await fixture({ parallel: true });
    f.def.dependencies = [{ taskId: "other", dependsOnTaskId: "implement", condition: "succeeded" }] as any;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
    await f.evidence("implement"); await f.submit(); await f.runtime.tick(); await f.runtime.tick();
    const run = await f.inspect();
    const implement = run.tasks.find((task: any) => task.taskId === "implement");
    const other = run.tasks.find((task: any) => task.taskId === "other");
    expect(implement.cycle.status).toBe("passed");
    expect(other.worktrees).toHaveLength(1);
    expect(other.worktrees[0].baseCommitHash).toBe(implement.changeSet.headCommitHash);
    expect(other.worktrees[0].baseCommitHash).not.toBe(run.baseRevision);
    await f.evidence("other"); await f.submit("other", "second file\n"); await f.runtime.tick(); await f.runtime.tick();
    const integrated = await f.inspect();
    expect(integrated.workflowCycle.status).toBe("passed");
    expect(integrated.workflowChange.filesChanged).toHaveLength(2);
  });
  it("parallel branches integrate and are independently verified on the exact merged revision", async () => {
    const f = await fixture({ parallel: true }); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other"); await f.submit(); await f.submit("other", "second file\n");
    await f.runtime.tick(); await f.runtime.tick(); const run = await f.inspect();
    expect(run.workflowCycle.status).toBe("passed"); expect(run.workflowChange.filesChanged).toHaveLength(2);
    expect(run.workflowCycle.history[0].metadata.integrationCommitHash).toBe(run.workflowChange.headCommitHash);
  });
  it("refuses the actual Adapter-style unverified orchestrator handle as task success", async () => {
    const f = await fixture();
    f.transport.customSendHandler = request => {
      const handle = { executionId: randomUUID(), requestId: request.requestId, attemptId: request.attemptId,
        runId: request.runId, taskId: request.taskId, idempotencyKey: request.idempotency.key, target: request.target,
        correlation: { token: request.requestId, provenance: "orchestrator" as const, verified: false }, acceptedAt: new Date().toISOString() };
      return { ok: true, value: { status: "accepted", requestId: request.requestId, attemptId: request.attemptId,
        runId: request.runId, taskId: request.taskId, observedAt: handle.acceptedAt, handle } };
    };
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await expect(f.submit()).rejects.toThrow("verified remote correlation");
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!.status).toBe("running");
    expect((await f.inspect()).tasks[0].cycle).toBeUndefined();
  });
  it("restores transport authentication only for the exact persisted implementation receipt", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    const message = (await f.runtime.inspect() as any).inbox.find((item: any) => item.message.type === "implementation.submitted").message;
    const journal = (f.runtime as any).journal;
    await journal.exclusive(async (state: any, save: any) => {
      state.inbox.find((item: any) => item.message.message_id === message.message_id).status = "received";
      await save();
    });
    const { authenticateNativeHerdrMessage } = await import("../../src/agentic/herdr-ingress.js");
    f.ports.authenticateResult = async (_result: any, _handle: any, input: RoleMessage) => authenticateNativeHerdrMessage(input);
    expect(await authenticateNativeHerdrMessage(message)).toBe(false);
    await f.restart().recoverMissingCoordinatorWakeups();
    expect((await f.runtime.inspect() as any).inbox.find((item: any) => item.message.message_id === message.message_id).status).toBe("applied");
    expect(await authenticateNativeHerdrMessage(message)).toBe(false);
  });

  it("never escalates Runtime-owned workflow verification on a Coordinator Stop or its startup replay", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    const verify = f.ports.policies.verification.verify.bind(f.ports.policies.verification);
    let entered!: () => void, release!: () => void;
    const inWorkflowVerification = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(f.ports.policies.verification, "verify").mockImplementation(async (...args) => {
      if (args[0].taskId === "workflow-verification") { entered(); await gate; }
      return verify(...args);
    });
    const ticking = (async () => { for (let i = 0; i < 4 && !(await f.inspect()).workflowCycle?.status?.match(/passed/); i++) await f.runtime.tick(); })();
    await inWorkflowVerification;
    expect(await f.inspect()).toMatchObject({ status: "verifying", workflowVerificationPending: true });
    const message = f.envelope("delegation.request", (await f.inspect()).delegation, { message_id: "turn-during-verification", idempotency_key: "turn-during-verification" });
    await f.runtime.queueHerdr(message); await f.runtime.flushOutbound();
    const binding = f.panes.bindings.find(p => p.role === "coordinator")!;
    await f.runtime.coordinatorTurnStopped(message, binding);
    await f.runtime.coordinatorTurnStopped(message, binding); // host startup replays every durable Stop receipt
    expect((await f.inspect()).status).toBe("verifying");
    expect((await f.inspect()).pendingAction).toBeUndefined();
    expect((await f.runtime.watchdogSnapshot("session-1"))[0]).toMatchObject({ runtimeWork: true });
    await f.runtime.reportRunStalled("run-1", "run-1@long-check"); // a check suite longer than the stall window is not a stall
    expect((await f.inspect()).status).toBe("verifying");
    release(); await ticking;
    expect((await f.inspect()).workflowCycle.status).toBe("passed");
    await f.runtime.coordinatorTurnStopped(message, binding); // stale replay after the Runtime-owned phase
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.payload.kind === "coordinator_no_response")).toEqual([]);
    expect((await f.inspect()).status).not.toBe("escalated");
  });
  it("retains a verification outcome that finishes while the run is paused and applies it once after resume", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    (f.ports as any).preflightRoleCapabilities = async () => undefined;
    const journal = (f.runtime as any).journal;
    const actionId = `next-${digest(["run-1", "pause-source"])}`;
    const verify = f.ports.policies.verification.verify.bind(f.ports.policies.verification);
    let calls = 0;
    vi.spyOn(f.ports.policies.verification, "verify").mockImplementation(async (...args) => {
      if (args[0].taskId === "implement") {
        calls++;
        // Another role's capability blocker pauses the run while Runtime is still verifying.
        await journal.exclusive(async (state: any, save: any) => {
          const run = state.runs.find((item: any) => item.runId === "run-1");
          run.status = "escalated"; run.error = "Coordinator blocked: capability";
          run.pendingAction = { actionId, kind: "resume_coordinator", owner: "coordinator", reason: "capability", sourceMessageId: "pause-source",
            createdAt: new Date().toISOString(), state: "pending", previousStatus: "verifying", resumeAttempts: 0, recovery: "manual" };
          await save();
        });
      }
      return verify(...args);
    });
    await f.runtime.tick(); await f.runtime.tick();
    const pending = async () => journal.exclusive(async (state: any) => state.pendingVerifications.length);
    expect(await f.inspect()).toMatchObject({ status: "escalated", tasks: [expect.objectContaining({ verificationPending: true })] });
    expect((await f.inspect()).tasks[0].cycle.status).not.toBe("passed");
    expect(await pending()).toBe(1);
    const before = await f.runtime.inspect() as any;
    const original = before.inbox.find((item: any) => item.message.type === "implementation.submitted").message;
    // Redelivery must preserve the result payload; it is received while paused, never applied as new business work.
    const redelivery = { ...original, message_id: "paused-implementation-redelivery", idempotency_key: "paused-implementation-redelivery" };
    expect(await f.runtime.receiveHerdr(redelivery)).toMatchObject({ received: true, deferred: true });
    expect(await f.inspect()).toMatchObject({ status: "escalated", pendingAction: { actionId },
      tasks: [expect.objectContaining({ verificationPending: true, result: before.runs[0].tasks[0].result })] });
    expect((await f.inspect()).tasks[0].cycle.status).not.toBe("passed");
    expect(await pending()).toBe(1);
    await f.runtime.resumeBlockedRun("run-1", actionId);
    await f.runtime.recoverMissingCoordinatorWakeups();
    expect((await f.runtime.inspect() as any).inbox.filter((item: any) => item.message.message_id === redelivery.message_id)
      .map((item: any) => item.status)).toEqual(["applied"]);
    await f.runtime.tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    expect(await pending()).toBe(0);
    expect(calls).toBe(1);
  });
  it("reruns a verification that failed while the run was paused once it is resumed", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    (f.ports as any).preflightRoleCapabilities = async () => undefined;
    const journal = (f.runtime as any).journal, actionId = `next-${digest(["run-1", "pause-source"])}`;
    const verify = f.ports.policies.verification.verify.bind(f.ports.policies.verification);
    let fail = true;
    vi.spyOn(f.ports.policies.verification, "verify").mockImplementation(async (...args) => {
      if (fail && args[0].taskId === "implement") {
        fail = false;
        await journal.exclusive(async (state: any, save: any) => {
          const run = state.runs.find((item: any) => item.runId === "run-1");
          run.status = "escalated";
          run.pendingAction = { actionId, kind: "resume_coordinator", owner: "coordinator", reason: "capability", sourceMessageId: "pause-source",
            createdAt: new Date().toISOString(), state: "pending", previousStatus: "verifying", resumeAttempts: 0, recovery: "manual" };
          await save();
        });
        throw new Error("Injected verifier interruption");
      }
      return verify(...args);
    });
    await f.runtime.tick();
    expect((await f.inspect()).tasks[0].verificationPending).toBe(false);
    await f.runtime.resumeBlockedRun("run-1", actionId);
    await f.runtime.tick(); await f.runtime.tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
  });

  it("recovers a verifier job lost after pending persistence and before invocation", async () => {
    const f = await fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick(); await f.evidence("implement"); await f.submit();
    const journal = (f.runtime as any).journal;
    const exclusive = journal.exclusive.bind(journal);
    let interrupted = false;
    const spy = vi.spyOn(journal, "exclusive").mockImplementation(async (action: any) => {
      const value = await exclusive(action);
      if (!interrupted && Array.isArray(value) && value.some(item => item?.runId === "run-1" && item.plan && item.cycle)) {
        interrupted = true;
        throw new Error("Injected crash before verifier invocation");
      }
      return value;
    });
    await expect(f.runtime.tick()).rejects.toThrow("Injected crash before verifier invocation");
    spy.mockRestore();
    expect((await f.inspect()).tasks[0].verificationPending).toBe(true);
    const priorCalls = f.calls.length;
    await f.restart().tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    expect(f.calls.length).toBeGreaterThan(priorCalls);
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "task.assignment")).toHaveLength(1);
  });

  it("replays a durable verification outcome after SQLite append failure without rerunning checks", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    const append = f.ports.runStore.appendEvents.bind(f.ports.runStore); let failOnce = true;
    const spy = vi.spyOn(f.ports.runStore, "appendEvents").mockImplementation(async request => {
      if (failOnce && request.events.some(event => event.type === "quality_gate.evaluated")) {
        failOnce = false; return { ok: false, error: { code: "corruption", retryable: false, message: "Injected SQLite write failure" } };
      }
      return append(request);
    });
    await f.runtime.tick(); expect((await f.inspect()).status).toBe("escalated");
    const taskChecks = f.calls.filter(ctx => (ctx.input as any).scope === "task").length;
    await f.restart().tick(); spy.mockRestore();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    expect(f.calls.filter(ctx => (ctx.input as any).scope === "task")).toHaveLength(taskChecks);
  });

  it("a verified failed attempt waits for writer reconciliation before bounded retry dispatch", async () => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any;
    const out = state.outbound.find((item: any) => item.message.type === "task.assignment"); const handle = out.handle;
    const failed = AgentResultSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId: "run-1", taskId: "implement",
      executionId: handle.executionId, status: "failed", verification: { status: "verified", evidence: "Trusted failing execution", correlation: handle.correlation },
      artifactProposals: [], retryable: true, error: { code: "temporary_execution_error", message: "Retryable task execution failure", retryable: true },
      startedAt: handle.acceptedAt, completedAt: new Date().toISOString() });
    await f.runtime.receiveHerdr(f.envelope("implementation.submitted", failed, { causation_id: out.message.message_id,
      sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } }));
    f.panes.busy.add("developer"); await f.runtime.tick();
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(1);
    f.panes.busy.delete("developer"); await f.runtime.tick();
    expect(f.transport.sentRequests.filter(req => req.role === "developer")).toHaveLength(2);
  });

  it("accepts signed native binding proof while retaining the raw handle across SQLite/checkpoint recovery", async () => {
    const f = await fixture();
    f.transport.customSendHandler = request => ({ ok: true, value: { status: "accepted", requestId: request.requestId,
      attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, observedAt: new Date().toISOString(),
      handle: { executionId: randomUUID(), requestId: request.requestId, attemptId: request.attemptId, runId: request.runId,
        taskId: request.taskId, idempotencyKey: request.idempotency.key, target: request.target,
        correlation: { token: request.requestId, provenance: "orchestrator", verified: false }, acceptedAt: new Date().toISOString() } } });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any; const out = state.outbound.find((item: any) => item.message.type === "task.assignment");
    const handle = out.handle;
    const receipt = createSignedBindingReceipt({ issuerId: "native-test-host", receiptId: randomUUID(), handle,
      correlation: { token: out.message.message_id, provenance: "transport", verified: true }, observedAt: new Date().toISOString(), privateKey: f.privateKey });
    const message = f.envelope("execution.receipt", receipt, { causation_id: out.message.message_id,
      sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId } });
    await f.runtime.receiveHerdr(message); await f.runtime.receiveHerdr(message);
    let current = unwrap(await f.ports.engine.getSnapshot("run-1"))!;
    expect(current.tasks[0]!.agentExecution!.correlation.verified).toBe(false);
    expect(current.tasks[0]!.bindingVerification!.receipt.correlation.verified).toBe(true);
    const projected = unwrap(await f.ports.runStore.get("run-1"))!.snapshot.tasks[0]!;
    expect(projected.bindingVerification).toEqual(current.tasks[0]!.bindingVerification);
    expect(projected.version).toBe(current.tasks[0]!.version);
    const checkpoint = unwrap(await f.ports.engine.createCheckpoint({ runId: "run-1", expectedVersion: current.version,
      checkpointId: "signed-binding-checkpoint", createdAt: new Date().toISOString() }));
    expect(checkpoint.codec.version).toBe(2);
    expect(unwrap(await f.ports.runStore.saveCheckpoint(checkpoint, current.version))).toBeUndefined();
    const restarted = new DeterministicWorkflowEngine({ definitions: [(await f.inspect()).definition], bindingReceiptKeys: { "native-test-host": f.publicKey } });
    expect(unwrap(await restarted.recover({ runId: "run-1", checkpoint, events: [], expectedVersion: current.version })).snapshot.tasks[0]!.bindingVerification).toBeDefined();
    const untrusted = new DeterministicWorkflowEngine({ definitions: [(await f.inspect()).definition] });
    expect(await untrusted.recover({ runId: "run-1", checkpoint, events: [], expectedVersion: current.version })).toMatchObject({ ok: false });
    await f.evidence("implement"); await f.submit(); await f.runtime.tick();
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
  });

  it.each(["signature", "issuer", "identity", "cancelled"])("refuses %s binding receipts without promoting the handle", async failure => {
    const f = await fixture(); await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const state = await f.runtime.inspect() as any; const out = state.outbound.find((item: any) => item.message.type === "task.assignment");
    const receipt = createSignedBindingReceipt({ issuerId: failure === "issuer" ? "untrusted" : "native-test-host", receiptId: randomUUID(),
      handle: failure === "identity" ? { ...out.handle, executionId: "another-execution" } : out.handle,
      correlation: { token: out.message.message_id, provenance: "transport", verified: true }, observedAt: new Date().toISOString(), privateKey: f.privateKey });
    if (failure === "signature") receipt.signature.value = Buffer.alloc(64, 1).toString("base64");
    if (failure === "cancelled") await f.runtime.cancel("run-1", "Cancel before proof");
    await expect(f.runtime.receiveHerdr(f.envelope("execution.receipt", receipt, { causation_id: out.message.message_id,
      sender: { role: "developer", agent_id: out.handle.target.agentId, pane_id: out.handle.target.paneId } }))).rejects.toThrow();
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks[0]!.bindingVerification).toBeUndefined();
  });
});
