import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUserDecisionRequest } from "../../src/agentic/decision-routing.js";
import { workflow } from "../../../specification/test/fixtures.js";
import { cleanups, unwrap, fixture } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe.skipIf(process.platform === "win32")("P19 integrated Agentic SDLC", () => {
  it.each(["paused", "active", "unknown-replacement", "qa-expired", "qa-cancel"] as const)("physically authorizes one replacement workflow review while preserving the unanswered original and all evidence (%s)", async mode => {
    const active = mode === "active", unknownReplacement = mode === "unknown-replacement", qaExpired = mode === "qa-expired" || mode === "qa-cancel";
    const f = await fixture({ remoteReview: true, tdd: true }); f.ports.preflightRoleCapabilities = async () => undefined;
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    for (const phase of ["red", "green", "refactor"] as const) await f.evidence("implement", phase);
    await f.submit();
    for (const check of f.ports.taskChecks!) check.timeout.executionTimeoutMs = 30000;
    const taskTick = f.runtime.tick(); taskTick.catch(() => undefined);
    const requests = async () => ((await f.runtime.inspect()) as any).outbound.filter((out: any) => out.message.type === "verification.requested" && out.handle);
    await expect.poll(async () => (await requests()).filter((out: any) => out.message.payload.input?.scope === "task").length, { timeout: 15000 }).toBe(1);
    const taskReview = (await requests()).find((out: any) => out.message.payload.input?.scope === "task");
    const verdict = async (out: any) => f.envelope("review.verdict", unwrap(await f.localReview(out.message.payload)), { sender: { role: out.message.recipient.role, agent_id: out.handle.target.agentId, pane_id: out.handle.target.paneId }, causation_id: out.message.message_id });
    await f.runtime.receiveHerdr(await verdict(taskReview)); await taskTick;
    expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    await (f.runtime as any).journal.exclusive(async (journal: any, save: any) => { journal.runs[0].maxIterations = 1; await save(); });
    (f.ports.workflowChecks!.find(check => check.id === "review")!.timeout as { executionTimeoutMs: number }).executionTimeoutMs = 10000;
    if (qaExpired) f.ports.workflowChecks!.find(check => check.id === "review")!.configuration = {
      ...(f.ports.workflowChecks!.find(check => check.id === "review")!.configuration as object), role: "qa" };
    const workflowTick = f.runtime.tick(); workflowTick.catch(() => undefined);
    await expect.poll(async () => (await requests()).some((out: any) => out.message.payload.input?.scope === "workflow"), { timeout: 15000 }).toBe(true);
    if (!active) await workflowTick;
    await f.runtime.flushOutbound();
    if (qaExpired) await (f.runtime as any).journal.exclusive(async (journal: any, save: any) => {
      const out = journal.outbound.find((out: any) => out.message.type === "verification.requested" && out.message.payload.input?.scope === "workflow");
      out.status = "accepted"; out.lease.acquiredAt = new Date(Date.now() - 120000).toISOString(); out.lease.expiresAt = new Date(Date.now() - 60000).toISOString();
      if (mode !== "qa-cancel") out.leaseRelease = { leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken, expectedVersion: out.lease.version, releasedAt: new Date().toISOString(), idempotencyKey: "expired-release-unconfirmed" }; await save();
    });
    const original = (await requests()).find((out: any) => out.message.payload.input?.scope === "workflow");
    const before = await f.inspect(); expect(before.status).toBe(active ? "verifying" : "escalated"); expect(original.status).toBe(qaExpired ? "accepted" : "released");
    const authority = { operationId: original.message.message_id, sessionId: "session-1", userMessageId: "physical-review-replacement", userId: "human-1" };
    expect(typeof (f.runtime as any).replaceWorkflowReview).toBe("function");
    await expect((f.runtime as any).replaceWorkflowReview(authority)).rejects.toThrow(/physical human/);
    (f.ports as any).authorizeReviewReplacement = async () => true;
    await expect((f.runtime as any).replaceWorkflowReview({ ...authority, sessionId: "other" })).rejects.toThrow(/Cross-session/);
    if (!active && !unknownReplacement && !qaExpired) {
      const journal = (f.runtime as any).journal, baseline = await journal.exclusive(async (value: any) => structuredClone(value));
      const decision = buildUserDecisionRequest({ role: "coordinator", sessionId: "session-1", revision: 1, generation: 0, now: new Date().toISOString(),
        input: { runId: "run-1", taskId: "implement", question: "Pending independent user decision", options: ["Wait", "Cancel"] } });
      const mutations: [string, (value: any) => void, RegExp][] = [
        ["pending approval", value => { value.runs[0].approval = { ...decision, approvalId: "pending-review-approval", target: { type: "run" }, metadata: {} }; }, /human gates/],
        ["pending user decision", value => { value.runs[0].userDecisions = { [decision.approvalId]: { request: decision, role: "coordinator", agentId: "coordinator", paneId: "pane-coordinator", taskId: "implement", status: "pending" } }; }, /human gates/],
        ["unknown delivery", value => { value.outbound.find((out: any) => out.message.type === "task.assignment").status = "unknown_delivery"; }, /Uncertain delivery/],
        ["missing required Refactor", value => { value.runs[0].tasks[0].spec.strategy.metadata.tddEvidence.pop(); }, /evidence|phase|Refactor|refactor|incomplete/i],
        ["writer not released", value => { value.runs[0].tasks[0].writerReleased = false; }, /verified integrated revision/],
        ["verdict already received", value => { value.inbox.push({ message: { ...lateTemplate, message_id: "received-before-permission", idempotency_key: "received-before-permission" }, status: "received" }); }, /received review verdict/]
      ];
      const lateTemplate = await verdict(original);
      for (const [name, mutate, expected] of mutations) {
        try {
          await journal.exclusive(async (value: any, save: any) => { mutate(value); await save(); });
          await expect((f.runtime as any).replaceWorkflowReview(authority), name).rejects.toThrow(expected);
          const observed = await f.runtime.inspect() as any;
          expect(observed.outbound.find((out: any) => out.message.message_id === original.message.message_id).reviewReplacement, name).toBeUndefined();
          expect(observed.outbound.length, name).toBe(baseline.outbound.length);
        } finally { await journal.exclusive(async (value: any, save: any) => { Object.assign(value, structuredClone(baseline)); await save(); }); }
      }
    }
    if (mode === "paused") {
      const journal = (f.runtime as any).journal, exclusive = journal.exclusive.bind(journal); let crashed = false;
      const failure = vi.spyOn(journal, "exclusive").mockImplementation((action: any) => exclusive(async (value: any, save: any) => action(value, async () => {
        await save(); if (!crashed && value.outbound.some((out: any) => out.reviewReplacement)) { crashed = true; throw new Error("Crash after durable review fence"); }
      })));
      await expect((f.runtime as any).replaceWorkflowReview(authority)).rejects.toThrow("Crash after durable review fence");
      failure.mockRestore(); f.restart();
    }
    if (qaExpired) {
      const journal = (f.runtime as any).journal, expired = await journal.exclusive(async (value: any) => structuredClone(value));
      try {
        await journal.exclusive(async (value: any, save: any) => { value.outbound.find((out: any) => out.message.message_id === original.message.message_id).lease.expiresAt = new Date(Date.now() + 300000).toISOString(); await save(); });
        await expect((f.runtime as any).replaceWorkflowReview(authority)).rejects.toThrow(/released or expired/);
      } finally { await journal.exclusive(async (value: any, save: any) => { Object.assign(value, expired); await save(); }); }
    }
    await (f.runtime as any).replaceWorkflowReview(authority); await workflowTick;
    const blocked = await f.inspect(); expect(blocked.status).toBe("escalated");
    const state = await f.runtime.inspect() as any; expect(await (f.runtime as any).journal.exclusive(async (journal: any) => journal.version)).toBe(qaExpired ? 5 : 4);
    const retained = state.outbound.find((out: any) => out.message.message_id === original.message.message_id);
    const { reviewReplacement, ...unchanged } = retained; expect(unchanged).toEqual(original);
    expect(reviewReplacement).toMatchObject({ operationId: original.message.message_id, userMessageId: authority.userMessageId, disposition: "replaced_without_verdict_claim" });
    expect((await f.inspect()).tasks).toEqual(before.tasks); if (!active) expect((await f.inspect()).pendingAction).toEqual(before.pendingAction);
    expect((await f.inspect()).workflowChange).toEqual(before.workflowChange);
    await expect((f.runtime as any).replaceWorkflowReview(authority)).resolves.toMatchObject({ alreadyReplaced: true });
    await expect((f.runtime as any).journal.exclusive(async (journal: any, save: any) => { journal.version = 3; await save(); })).rejects.toThrow(/Invalid workflow review replacement/);
    if (qaExpired) await expect((f.runtime as any).journal.exclusive(async (journal: any, save: any) => { journal.version = 4; await save(); })).rejects.toThrow(/Invalid workflow review replacement/);
    if (mode === "qa-cancel") {
      const renew = vi.spyOn(f.ports.registry, "renewLease");
      await f.runtime.cancel("run-1", "Physical run cancellation after review replacement"); await f.runtime.tick();
      const after = await f.runtime.inspect() as any, record = after.outbound.find((out: any) => out.message.message_id === original.message.message_id);
      const { reviewReplacement: retainedMarker, ...retainedOriginal } = record; expect(retainedOriginal).toEqual(original); expect(retainedMarker).toEqual(reviewReplacement);
      expect(renew).not.toHaveBeenCalled(); expect(f.transport.cancelledHandles).toHaveLength(0);
      expect(after.outbound.some((out: any) => out.message.recipient.role === "conversation" && String(out.message.payload.reason).includes("review"))).toBe(true);
      expect(after.runs[0].cancelled).toBe(true); return;
    }
    // Old authenticated results, including a durable received row replayed after restart, are fenced without inventing an outcome.
    const late = await verdict(original);
    await expect(f.runtime.receiveHerdr(late)).rejects.toThrow(/replaced workflow review/);
    const lateBlocked = f.envelope("task.status", { status: "blocked", summary: "Late old Reviewer blocker" }, { sender: late.sender, causation_id: original.message.message_id });
    await expect(f.runtime.receiveHerdr(lateBlocked)).rejects.toThrow(/replaced workflow review/);
    await expect(f.runtime.receiveHerdr({ ...lateBlocked, message_id: "late-escalation", idempotency_key: "late-escalation", type: "verification.escalation" })).rejects.toThrow(/replaced workflow review/);
    await (f.runtime as any).journal.exclusive(async (journal: any, save: any) => { journal.inbox.push({ message: { ...late, message_id: "late-received", idempotency_key: "late-received" }, status: "received" }); await save(); });
    f.restart(); await f.runtime.recoverMissingCoordinatorWakeups();
    expect(((await f.runtime.inspect()) as any).inbox.find((row: any) => row.message.message_id === "late-received").status).toBe("rejected");
    const binding = f.panes.bindings.find(pane => pane.role === (qaExpired ? "qa" : "reviewer"))!;
    const changed = { ...binding, paneId: "pane-reviewer-replacement", bindingId: "binding-reviewer-replacement", session: { source: "test", kind: "id" as const, value: "replacement-native" } };
    Object.assign(binding, changed);
    await f.runtime.resumeBlockedRun("run-1", blocked.pendingAction.actionId, { conversationUserMessageId: "resume-authorized-review-replacement" });
    if (unknownReplacement) {
      await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
      f.transport.customSendHandler = () => ({ ok: false, error: { code: "timeout", retryable: true, message: "Replacement receipt unknown" } });
    }
    const renewed = f.runtime.tick(); let retryError: unknown; renewed.catch(error => { retryError = String(error); });
    try {
      if (unknownReplacement) {
        await renewed; f.restart(); await f.runtime.flushOutbound(); await f.runtime.flushOutbound();
        const observed = await f.runtime.inspect() as any, record = observed.outbound.find((out: any) => out.message.message_id === reviewReplacement.replacementMessageId);
        expect(record.status).toBe("unknown_delivery"); expect(f.transport.sentRequests.filter(request => JSON.parse(request.instruction).message_id === reviewReplacement.replacementMessageId)).toHaveLength(1);
        await expect(f.runtime.resumeBlockedRun("run-1", (await f.inspect()).pendingAction.actionId, { conversationUserMessageId: "never-resend-unknown" })).rejects.toThrow(/Unknown delivery/);
        expect((await f.inspect()).tasks).toEqual(before.tasks); expect((await f.inspect()).workflowChange).toEqual(before.workflowChange); return;
      }
      try { await expect.poll(async () => (await requests()).some((out: any) => out.message.message_id === reviewReplacement.replacementMessageId), { timeout: 15000 }).toBe(true); }
      catch (error) { const observed = await f.runtime.inspect() as any; throw new Error(JSON.stringify({ retryError, runStatus: observed.runs[0].status, replacement: reviewReplacement.replacementMessageId,
        requests: observed.outbound.filter((out: any) => out.message.type === "verification.requested").map((out: any) => ({ id: out.message.message_id, status: out.status, error: out.error })) })); }
      const fresh = (await requests()).find((out: any) => out.message.message_id === reviewReplacement.replacementMessageId);
      expect(fresh.message.payload).toEqual(original.message.payload); expect(fresh.capabilities).toEqual(original.capabilities);
      expect(fresh.handle.target.paneId).toBe(changed.paneId); expect(fresh.handle.target.session).toEqual(changed.session);
      await f.runtime.flushOutbound();
      await expect((f.runtime as any).replaceWorkflowReview({ ...authority, operationId: fresh.message.message_id, userMessageId: "second-physical-review-replacement" })).rejects.toThrow(/bound exhausted/);
      expect(((await f.runtime.inspect()) as any).outbound.find((out: any) => out.message.message_id === fresh.message.message_id).reviewReplacement).toBeUndefined();
      const freshVerdict = await verdict(fresh); await f.runtime.receiveHerdr(freshVerdict); await renewed;
      expect((await f.inspect()).workflowCycle.status).toBe("passed"); expect((await f.inspect()).approvalKind).toBe("delivery");
      f.restart(); await f.runtime.tick(); await expect(f.runtime.receiveHerdr(freshVerdict)).resolves.toMatchObject({ duplicate: true });
      await f.approve(); expect((await f.inspect()).status).toBe("completed");
      expect((await requests()).filter((out: any) => out.message.message_id === original.message.message_id)).toHaveLength(1);
      expect((await f.inspect()).tasks).toEqual(before.tasks); expect((await f.inspect()).workflowChange).toEqual(before.workflowChange);
      const originalAfter = ((await f.runtime.inspect()) as any).outbound.find((out: any) => out.message.message_id === original.message.message_id);
      const { reviewReplacement: finalMarker, ...unchangedOriginal } = originalAfter; expect(unchangedOriginal).toEqual(original); expect(finalMarker).toEqual(reviewReplacement);
    } finally { await renewed.catch(() => undefined); }
  }, 120000);
});
