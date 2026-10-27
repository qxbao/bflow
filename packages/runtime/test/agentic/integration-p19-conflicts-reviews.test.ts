import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentRequest } from "@bflow/contracts";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { workflow } from "../../../specification/test/fixtures.js";
import { cleanups, unwrap, git, fixture } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe.skipIf(process.platform === "win32")("P19 integrated Agentic SDLC", () => {
  async function conflictingIntegration() {
    const f = await fixture({ parallel: true, conflict: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.evidence("other");
    await f.submit("implement", "first branch\n"); await f.submit("other", "second branch\n");
    await f.runtime.tick(); await f.runtime.tick();
    const resolvers = async () => (await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "task.assignment" && out.message.payload.kind === "conflict_resolution");
    const reportFailure = async (assignment: any, reason: string) => f.runtime.receiveHerdr(f.envelope("task.status", { status: "failed", reason }, {
      causation_id: assignment.message.message_id, sender: { role: "developer", agent_id: assignment.handle.target.agentId, pane_id: assignment.handle.target.paneId } }));
    return { f, resolvers, reportFailure };
  }
  // B7: this case used to expect `escalated` right after the conflict. Runtime now assigns a bounded Developer resolver first.
  it("preserves an actual conflicting integration worktree and assigns a Developer resolver through Herdr", async () => {
    const { f, resolvers } = await conflictingIntegration();
    const run = await f.inspect(); expect(run.status).toBe("implementing");
    const integration = await f.ports.policies.git.getIntegration(run.integrationKey);
    expect(integration.status).toBe("conflict");
    expect(run.workflowCycle).toBeUndefined();
    expect((await f.runtime.inspect() as any).outbound.some((out: any) => out.message.type === "task.status" && out.message.payload.reason === "merge_conflict")).toBe(true);
    const [assignment] = await resolvers();
    expect(assignment.status).toBe("accepted"); expect(assignment.lease.fencingToken).toBeDefined();
    expect(assignment.message.payload.conflictPaths).toEqual(["guide.md"]);
    expect(assignment.message.payload.objective).toContain("guide.md");
    expect(assignment.handle.target.worktreePath).toBe(integration.worktreePath);
    expect(git(integration.worktreePath, "diff", "--name-only", "--diff-filter=U")).toBe("guide.md"); // never auto-resolved
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))!.tasks.map(task => task.taskId)).toEqual(["implement", "other"]); // not a Core task
  });
  it("continues the workflow after the assigned resolver commits a scoped resolution", async () => {
    const { f, resolvers } = await conflictingIntegration();
    const [assignment] = await resolvers();
    const resolver = f.panes.bindings.find(binding => binding.paneId === assignment.handle.target.paneId)!;
    const worktree = resolver.worktreePath!, head = () => git(worktree, "rev-parse", "HEAD");
    const development = new HostDevelopment(() => f.runtime, []);
    await expect(development.commit(resolver, { expectedHead: head(), message: "Resolve" })).rejects.toThrow("Conflict markers remain");
    await expect(development.authorizeFileEdit(resolver, { tool_name: "Write", tool_input: { file_path: join(worktree, "other.md") } })).rejects.toThrow("not one of the conflicted files");
    await development.authorizeFileEdit(resolver, { tool_name: "Write", tool_input: { file_path: join(worktree, "guide.md") } });
    await writeFile(join(worktree, "guide.md"), "first branch\nsecond branch\n");
    const committed = await development.commit(resolver, { expectedHead: head(), message: "Resolve guide.md merge conflict" }) as any;
    expect(committed).toMatchObject({ committed: true, accepted: true, head: head() });
    expect(git(worktree, "show", "-s", "--format=%P", "HEAD").split(" ")).toHaveLength(2);
    for (let i = 0; i < 4 && (await f.inspect()).status !== "awaiting_approval"; i++) await f.runtime.tick();
    const run = await f.inspect();
    expect(run.status).toBe("awaiting_approval"); expect(run.approvalKind).toBe("delivery");
    expect(run.workflowCycle.status).toBe("passed");
    expect((await f.ports.policies.git.getIntegration(run.integrationKey)).status).toBe("verified");
    expect(run.conflictResolution.attempts).toMatchObject([{ status: "accepted", settled: true, commitHash: committed.head }]);
    expect((await resolvers()).map((out: any) => out.status)).toEqual(["released"]);
  });
  it("escalates the conflict after two resolver attempts end without an accepted resolution", async () => {
    const { f, resolvers, reportFailure } = await conflictingIntegration();
    const [first] = await resolvers();
    await reportFailure(first, "Both sides rewrite the same sentence");
    expect((await f.inspect()).status).toBe("implementing");
    await f.runtime.tick();
    const [, second] = await resolvers();
    expect(second.status).toBe("accepted"); expect(second.message.message_id).not.toBe(first.message.message_id);
    expect(second.message.payload.previousFailures).toEqual(["Both sides rewrite the same sentence"]);
    expect((await resolvers())[0].status).toBe("released");
    await reportFailure(second, "Still ambiguous");
    await f.runtime.tick(); await f.runtime.tick();
    const run = await f.inspect();
    expect(run.status).toBe("escalated");
    expect(run.error).toMatch(/^Git integration conflict requires an assigned resolver; worktree preserved \(automatic Developer resolver failed 2 attempts: Still ambiguous\)/);
    expect(await resolvers()).toHaveLength(2);
    expect((await f.ports.policies.git.getIntegration(run.integrationKey)).status).toBe("conflict");
  });
  // B4: a role without a pane is a synchronous tool refusal, not a run escalation.
  it("routes a security request to the capable Reviewer pane as an explicit fallback", async () => {
    const f = await fixture();
    const message = await f.runtime.requestSpecialist("run-1", "security", "Threat-model the token handling", ["review"]) as any;
    expect(message.recipient.role).toBe("reviewer");
    expect(message.fallback).toEqual({ requestedRole: "security", actingRole: "reviewer" });
    expect(message.payload.targetRole).toBe("reviewer");
    expect(message.payload.objective).toMatch(/^\[Fallback: requested role security has no pane/);
    expect(message.payload.metadata.specialistFallback).toEqual({ requestedRole: "security", actingRole: "reviewer" });
    const run = await f.inspect(); expect(run.status).toBe("specifying"); expect(run.pendingAction).toBeUndefined();
    await f.runtime.flushOutbound();
    expect(f.transport.sentRequests.some(request => request.role === "reviewer")).toBe(true);
    const assessed = await f.runtime.assess(f.spec) as any;
    expect(assessed.availableRoles.map((item: any) => item.role)).not.toContain("security");
    expect(assessed.roleFallbacks).toEqual({ security: "reviewer" });
  });
  it("refuses a specialist role without a usable pane synchronously and leaves the run unchanged", async () => {
    const f = await fixture();
    f.panes.bindings = f.panes.bindings.filter(binding => binding.role !== "tester");
    const tools = new CoordinatorTools(f.runtime);
    const before = await f.inspect();
    await expect(tools.invoke("request_specialist", { runId: "run-1", role: "oracle", objective: "Predict", requiredCapabilities: [] }, { role: "coordinator" }))
      .rejects.toThrow(/oracle is not a specialist role.*reviewer \[review, repository\.read\]/);
    await expect(tools.invoke("request_specialist", { runId: "run-1", role: "security", objective: "Audit", requiredCapabilities: ["security"] }, { role: "coordinator" }))
      .rejects.toThrow(/security has no bound role pane in this session and its fallback reviewer lacks required capabilities security.*choose one of the roles with a bound pane/);
    const after = await f.inspect();
    expect(after.status).toBe(before.status); expect(after.status).not.toBe("escalated");
    expect(after.pendingAction).toBeUndefined(); expect(after.error).toBeUndefined();
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "delegation.request" && out.message.sender.role === "coordinator")).toHaveLength(0);
    // tester has no pane here: the capable QA pane takes the request instead.
    const message = await tools.invoke("request_specialist", { runId: "run-1", role: "tester", objective: "Exercise the flow", requiredCapabilities: ["verification"] }, { role: "coordinator" }) as any;
    expect(message.recipient.role).toBe("qa"); expect(message.fallback.requestedRole).toBe("tester");
  });
  it("P14 dialogue and busy inbound queue are composed with a durable outbound Herdr handoff", async () => {
    const f = await fixture({ intake: false });
    const chat = await createAgenticConversationHost({ runtime: f.runtime, manifest: unwrap(await f.panes.getManifest()), contextDirectory: join(f.root, "conversation") });
    expect((await chat.handleUserTurn({ sessionId: "session-1", content: "Hello!", provenance: { origin: "user", authenticatedUser: true } }) as any).ok).toBe(true);
    expect((await f.runtime.inspect() as any).runs).toHaveLength(0);
    expect((await f.runtime.inspect() as any).outbound).toHaveLength(0);
    const response = await chat.handleUserTurn({ sessionId: "session-1", content: "Triển khai tính năng xác thực JWT HS256 trong packages/auth với thời hạn token 15 phút và unit test", provenance: { origin: "user", authenticatedUser: true } }) as any;
    expect(response.ok).toBe(true); expect(response.value.recognizedIntent).toBe("workflow_request");
    expect(f.transport.sentRequests).toHaveLength(0); // persisted enqueue is not a remote acknowledgement
    await f.runtime.flushOutbound();
    const handoff = JSON.parse(f.transport.sentRequests.find(request => request.role === "coordinator")!.instruction);
    await f.runtime.receiveHerdr(handoff);
    expect((await f.runtime.inspect() as any).runs).toHaveLength(1);
    await chat.setBusy(true);
    const progress = f.envelope("conversation.progress", { sdlcStatus: "planning", headline: "Plan ready" }, {
      sender: { role: "coordinator" }, recipient: { role: "conversation" }, run_id: handoff.run_id, correlation_id: handoff.correlation_id });
    const received = await chat.receiveHerdr(progress) as any;
    expect(received.ok).toBe(true); expect(received.value.queuedBecauseBusy).toBe(true);
    await chat.setBusy(false);
  });
  it("routes Reviewer requests through AgentTransport without locking out inbound processing", async () => {
    const f = await fixture({ remoteReview: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    // Observe the transport event instead of racing real Git/fsync work against
    // a 2.5-second polling budget. Runtime inspection then queues behind receipt
    // persistence and must return while the background tick awaits the verdict.
    let delivered!: (request: AgentRequest) => void;
    const delivery = new Promise<AgentRequest>(resolve => { delivered = resolve; });
    const send = f.transport.send.bind(f.transport);
    vi.spyOn(f.transport, "send").mockImplementation(async (request, options) => {
      const receipt = await send(request, options);
      if (JSON.parse(request.instruction).type === "verification.requested") delivered(request);
      return receipt;
    });
    const tools = new CoordinatorTools(f.runtime);
    expect(await tools.invoke("tick", {}, { role: "coordinator" })).toMatchObject({ scheduled: true });
    const ticking = tools.drain();
    ticking.catch(() => undefined);
    try {
      const request = await Promise.race([delivery, ticking.then(() => {
        throw new Error("Runtime tick completed before delivering the Reviewer request");
      })]);
      const state = await f.runtime.inspect() as any;
      expect(state.outbound.some((out: any) => out.request?.requestId === request.requestId && out.status === "accepted")).toBe(true);
      expect(await tools.invoke("tick_status", {}, { role: "coordinator" })).toMatchObject({ running: true });
      const message = JSON.parse(request.instruction);
      const result = unwrap(await f.localReview(message.payload));
      await f.runtime.receiveHerdr(f.envelope("review.verdict", result, { sender: { role: "reviewer", agent_id: request.target.agentId, pane_id: request.target.paneId }, causation_id: message.message_id }));
      await ticking; expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    } catch (error) { await ticking; throw error; }
  });
  it("renews an accepted review's lease while the verifier awaits a reply longer than one lease period", async () => {
    const f = await fixture({ remoteReview: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    let delivered!: (request: AgentRequest) => void;
    const delivery = new Promise<AgentRequest>(resolve => { delivered = resolve; });
    const send = f.transport.send.bind(f.transport);
    vi.spyOn(f.transport, "send").mockImplementation(async (request, options) => {
      const receipt = await send(request, options);
      if (JSON.parse(request.instruction).type === "verification.requested") delivered(request);
      return receipt;
    });
    const tools = new CoordinatorTools(f.runtime);
    await tools.invoke("tick", {}, { role: "coordinator" });
    const ticking = tools.drain(); ticking.catch(() => undefined);
    try {
      const request = await Promise.race([delivery, ticking.then(() => { throw new Error("Runtime tick completed before delivering the Reviewer request"); })]);
      f.panes.busy.add("reviewer"); // the Reviewer is still working on the accepted request
      const message = JSON.parse(request.instruction);
      const lease = async () => ((await f.runtime.inspect()) as any).outbound.find((out: any) => out.message.message_id === message.message_id).lease;
      await expect.poll(async () => (await lease())?.version, { timeout: 15000 }).toBeDefined();
      const before = await lease();
      // Simulate the lease approaching expiry mid-review; tick() is blocked on this gate, so only the wait timer can renew it.
      await (f.runtime as any).journal.exclusive(async (journal: any, save: any) => {
        journal.outbound.find((out: any) => out.message.message_id === message.message_id).lease.expiresAt = new Date(Date.now() + 60_000).toISOString(); await save();
      });
      await expect.poll(async () => (await lease()).version, { timeout: 15000 }).toBeGreaterThan(before.version);
      expect(Date.parse((await lease()).expiresAt)).toBeGreaterThan(Date.now() + 240_000);
      f.panes.busy.delete("reviewer");
      const result = unwrap(await f.localReview(message.payload));
      await f.runtime.receiveHerdr(f.envelope("review.verdict", result, { sender: { role: "reviewer", agent_id: request.target.agentId, pane_id: request.target.paneId }, causation_id: message.message_id }));
      await ticking; expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    } catch (error) { await ticking.catch(() => undefined); throw error; }
  }, 60000);
  it("records one closed host review timing with the Reviewer provider after a verdict", async () => {
    const f = await fixture({ remoteReview: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await f.evidence("implement"); await f.submit();
    let delivered!: (request: AgentRequest) => void;
    const delivery = new Promise<AgentRequest>(resolve => { delivered = resolve; });
    const send = f.transport.send.bind(f.transport);
    vi.spyOn(f.transport, "send").mockImplementation(async (request, options) => {
      const receipt = await send(request, options);
      if (JSON.parse(request.instruction).type === "verification.requested") delivered(request);
      return receipt;
    });
    const tools = new CoordinatorTools(f.runtime);
    await tools.invoke("tick", {}, { role: "coordinator" });
    const ticking = tools.drain(); ticking.catch(() => undefined);
    try {
      const request = await Promise.race([delivery, ticking.then(() => {
        throw new Error("Runtime tick completed before delivering the Reviewer request");
      })]);
      const message = JSON.parse(request.instruction);
      const result = unwrap(await f.localReview(message.payload));
      await f.runtime.receiveHerdr(f.envelope("review.verdict", result, { sender: { role: "reviewer", agent_id: request.target.agentId, pane_id: request.target.paneId }, causation_id: message.message_id }));
      await ticking; expect((await f.inspect()).tasks[0].cycle.status).toBe("passed");
    } catch (error) { await ticking.catch(() => undefined); throw error; }
    const timings = ((await f.runtime.inspect("run-1")) as any).reviewTimings.filter((item: any) => item.gateId === "review");
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ gateId: "review", role: "reviewer", provider: "test", outcome: "verdict", timeoutMs: 3000 });
    expect(typeof timings[0].completedAt).toBe("string");
    expect(Date.parse(timings[0].completedAt)).toBeGreaterThanOrEqual(Date.parse(timings[0].startedAt));
  });
  it("emits one near-deadline note for a review wait that has used 80% of its budget, however many timer ticks follow", async () => {
    const f = await fixture({ remoteReview: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const definition = (f.ports as any).taskChecks.find((check: any) => check.id === "review");
    const context = { runId: "run-1", taskId: "implement", attemptId: "near-deadline-review", artifacts: [], input: { scope: "task" },
      definition: { ...definition, timeout: { ...definition.timeout, executionTimeoutMs: 20_000 } } };
    const control = new AbortController(), waiting = f.runtime.herdrQualityGate("review").evaluate(context as any, { signal: control.signal });
    waiting.catch(() => undefined);
    const timings = async () => ((await f.runtime.inspect("run-1")) as any).reviewTimings ?? [];
    const notes = async () => ((await f.runtime.inspect()) as any).outbound.filter((out: any) => out.message.type === "conversation.progress" &&
      String(out.message.payload.headline).includes("80%"));
    try {
      await expect.poll(async () => (await timings()).length, { timeout: 10_000 }).toBe(1);
      // Age the open wait to 85% of its 20 s budget; only the existing 1 s wait timer can notice it.
      await (f.runtime as any).journal.exclusive(async (state: any, save: any) => {
        state.runs.find((run: any) => run.runId === "run-1").reviewTimings[0].startedAt = new Date(Date.now() - 17_000).toISOString();
        await save();
      });
      await expect.poll(async () => (await notes()).length, { timeout: 8_000 }).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 3_000));
      expect(await notes()).toHaveLength(1);
      expect((await notes())[0].message.payload.headline).toContain("used 80% of its 20 s budget (provider test).");
      const [open] = await timings();
      expect(typeof open.nearDeadlineAt).toBe("string");
      expect(open.completedAt).toBeUndefined();
    } finally { control.abort(); await waiting.catch(() => undefined); }
    const [settled] = await timings();
    expect(settled).toMatchObject({ outcome: "aborted" });
    expect(typeof settled.completedAt).toBe("string");
  }, 30000);
  it("dispatches an already queued review when readiness returns while the verifier is awaiting its reply", async () => {
    const f = await fixture({ remoteReview: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    f.panes.busy.add("reviewer");
    const definition = (f.ports as any).taskChecks.find((check: any) => check.id === "review");
    const context = { runId: "run-1", taskId: "implement", attemptId: "ready-review", artifacts: [], input: { scope: "task" },
      definition: { ...definition, timeout: { ...definition.timeout, executionTimeoutMs: 20_000 } } };
    const control = new AbortController(), waiting = f.runtime.herdrQualityGate("review").evaluate(context as any, { signal: control.signal });
    waiting.catch(() => undefined);
    const requests = async () => ((await f.runtime.inspect()) as any).outbound.filter((out: any) => out.message.type === "verification.requested");
    try {
      await expect.poll(async () => (await requests())[0]?.status, { timeout: 10_000 }).toBe("queued");
      await expect.poll(async () => typeof (await requests())[0]?.notReadySince, { timeout: 10_000 }).toBe("string");
      f.panes.busy.delete("reviewer");
      // No second scheduler tick or operator resume: the gate wait must keep the existing outbox live.
      await expect.poll(async () => (await requests())[0]?.status, { timeout: 4_000 }).toBe("accepted");
      expect(await requests()).toHaveLength(1);
      const [request] = await requests();
      await f.runtime.receiveHerdr(f.envelope("review.verdict", { gateId: "review", runId: "run-1", taskId: "implement", evaluationId: randomUUID(),
        status: "passed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString() },
        { sender: { role: "reviewer", agent_id: request.handle.target.agentId, pane_id: request.handle.target.paneId }, causation_id: request.message.message_id }));
      await expect(waiting).resolves.toMatchObject({ ok: true, value: { status: "passed" } });
    } finally { control.abort(); await waiting.catch(() => undefined); }
  });

  it("re-requests a Reviewer check after a late verdict instead of reusing evidence that predates the retry", async () => {
    const f = await fixture({ remoteReview: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const definition = (f.ports as any).taskChecks.find((check: any) => check.id === "review");
    const context = { runId: "run-1", taskId: "implement", attemptId: "attempt-review-retry", artifacts: [], input: { scope: "task" },
      definition: { ...definition, timeout: { ...definition.timeout, executionTimeoutMs: 20_000 } } };
    const gate = f.runtime.herdrQualityGate("review");
    const requests = async () => ((await f.runtime.inspect()) as any).outbound.filter((out: any) => out.message.type === "verification.requested");
    const verdict = (request: any) => f.envelope("review.verdict", { gateId: "review", runId: "run-1", taskId: "implement", evaluationId: randomUUID(),
      status: "passed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString() },
      { sender: { role: "reviewer", agent_id: request.handle.target.agentId, pane_id: request.handle.target.paneId }, causation_id: request.message.message_id });
    // First evaluation gives up (timeout/abort) while the Reviewer is still working; its verdict lands afterwards.
    const first = new AbortController();
    const abandoned = gate.evaluate(context as any, { signal: first.signal });
    await expect.poll(async () => (await requests()).filter((out: any) => out.handle).length, { timeout: 10_000 }).toBe(1);
    first.abort(); await expect(abandoned).rejects.toThrow(/aborted/);
    const [late] = await requests();
    await f.runtime.receiveHerdr(verdict(late));
    // The retry cannot reuse that verdict (it predates the new execution window), so it asks again under a new deterministic key.
    const retried = gate.evaluate(context as any);
    await expect.poll(async () => (await requests()).filter((out: any) => out.handle).length, { timeout: 10_000 }).toBe(2);
    const fresh = (await requests()).find((out: any) => out.message.message_id !== late.message.message_id);
    await f.runtime.receiveHerdr(verdict(fresh));
    await expect(retried).resolves.toMatchObject({ ok: true, value: { gateId: "review", status: "passed" } });
  });
  it.each([false, true])("creates a fresh gate request after an authenticated blocked reply (capacity released=%s)", async released => {
    const f = await fixture({ remoteReview: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    const definition = (f.ports as any).taskChecks.find((check: any) => check.id === "review");
    const context = { runId: "run-1", taskId: "implement", attemptId: "blocked-gate-retry", artifacts: [], input: { scope: "task" }, definition: { ...definition, timeout: { ...definition.timeout, executionTimeoutMs: 20000 } } };
    const gate = f.runtime.herdrQualityGate("review");
    const requests = async () => ((await f.runtime.inspect()) as any).outbound.filter((out: any) => out.message.type === "verification.requested");
    const first = new AbortController(), abandoned = gate.evaluate(context as any, { signal: first.signal }); abandoned.catch(() => undefined);
    await expect.poll(async () => (await requests()).filter((out: any) => out.handle).length, { timeout: 10000 }).toBe(1);
    first.abort(); await expect(abandoned).rejects.toThrow(/aborted/);
    const [prior] = await requests();
    await f.runtime.receiveHerdr(f.envelope("task.status", { status: "blocked", summary: "Host capability unavailable" }, { sender: { role: "reviewer", agent_id: prior.handle.target.agentId, pane_id: prior.handle.target.paneId }, causation_id: prior.message.message_id }));
    if (released) await f.runtime.flushOutbound();
    expect((await requests())[0].status).toBe(released ? "released" : "accepted");
    const second = new AbortController(), retried = gate.evaluate(context as any, { signal: second.signal }); retried.catch(() => undefined);
    try {
      await expect.poll(async () => (await requests()).filter((out: any) => out.handle).length, { timeout: 10000 }).toBe(2);
      const fresh = (await requests()).find((out: any) => out.message.message_id !== prior.message.message_id);
      await f.runtime.receiveHerdr(f.envelope("review.verdict", { gateId: "review", runId: "run-1", taskId: "implement", evaluationId: randomUUID(), status: "passed", findings: [], producedArtifacts: [], evaluatedAt: new Date().toISOString() }, { sender: { role: "reviewer", agent_id: fresh.handle.target.agentId, pane_id: fresh.handle.target.paneId }, causation_id: fresh.message.message_id }));
      await expect(retried).resolves.toMatchObject({ ok: true, value: { status: "passed" } });
      expect((await requests())[0].message).toEqual(prior.message);
    } finally { second.abort(); await retried.catch(() => undefined); }
  }, 60000);
});
