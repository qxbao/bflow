import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema, type RoleMessage } from "@bflow/contracts";
import { RoleCapabilityPreflightError } from "../../src/agentic/ports.js";
import { routeNativeConversationMessage } from "../../src/agentic/workspace.js";
import { lifecycleFixture } from "../helpers/lifecycle-fixture.js";
import { cleanups, architectRequest, through, drive, kinds, watchdogPass } from "../helpers/lifecycle-fault-matrix-stages.js";

/**
 * Whole-run liveness matrix: drive one run from intake to completed through the real Runtime/Core/Git/storage boundaries and inject a
 * fault at each SDLC step. The property under test is that every recoverable fault leaves the run either progressing, in a valid wait,
 * or in an explicit resumable blocker, and that the run then completes with a bounded number of explicit resumes and no lost result.
 * Local fake transport only: this is not live Herdr or provider evidence.
 */
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe.skipIf(process.platform === "win32")("whole-run lifecycle fault matrix", () => {
  it.each(["task", "workflow"] as const)("watchdog does not escalate a run while %s verification is still running", async scope => {
    const f = await lifecycleFixture(cleanups);
    await through(f, scope === "task" ? "implemented" : "task verified");
    const hold = f.hold(scope);
    const ticking = f.runtime.tick();
    await hold.reached;
    await watchdogPass(f);
    const during = await f.run();
    hold.release(); await ticking;
    expect(during.status, `${scope}: ${during.error}`).not.toBe("escalated");
    await drive(f, scope === "task" ? "task verified" : "workflow verified", 0);
  });

  // F4: a transient ingress failure followed by a successful redelivery must not stop the run.
  it("a transient ingress failure of a specialist result does not block its redelivery", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "intake");
    const request = await architectRequest(f);
    const reply = f.reply("architect", request, "spec.draft", { status: "completed", summary: "Impact analysis" });
    await f.runtime.reportInboundFailure(reply, "Conversation host is not ready");
    await f.runtime.receiveHerdr(reply);
    await f.runtime.flushOutbound();
    expect((await f.state()).inbox.find(item => item.message.message_id === reply.message_id)?.status).toBe("applied");
    expect(await drive(f, "specifying", 0)).toBe(0);
  });
  it("a transient ingress failure of an implementation result does not block its redelivery", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "planned");
    await f.runtime.tick(); await f.evidence();
    await f.runtime.reportInboundFailure(f.envelope("implementation.submitted", {}, { sender: { role: "developer" } }), "journal temporarily locked");
    await f.submit();
    expect(await drive(f, "implemented", 0)).toBe(0);
  });

  // F13: a transient capability proof failure is retried; it must not drop a handoff while the run waits on a human gate.
  it("a transient capability preflight failure on a specialist dispatch recovers without a manual resume", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "intake");
    let failures = 1;
    f.setPreflight(async binding => { if (binding.role === "architect" && failures-- > 0) throw new RoleCapabilityPreflightError("herdr agent get timed out"); });
    const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]));
    for (let pass = 0; pass < 3 && !f.sentTo("architect").length; pass++) { await f.runtime.flushOutbound(); await f.runtime.resumeRecoverableRuns(); }
    expect(f.sentTo("architect").map(message => message.message_id)).toEqual([request.message_id]);
    await f.runtime.receiveHerdr(f.reply("architect", request, "spec.draft", { status: "completed", summary: "Impact analysis" }));
    await f.runtime.flushOutbound();
    expect(await drive(f, "specifying", 0)).toBe(0);
  });
  it("a Coordinator wake that fails preflight during an approval wait is still delivered after the approval", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "workflow verified");
    expect((await f.run()).status).toBe("awaiting_approval");
    let failures = 1;
    f.setPreflight(async binding => { if (binding.role === "coordinator" && failures-- > 0) throw new RoleCapabilityPreflightError("tools/list proof not yet recorded"); });
    const wake = f.envelope("task.status", { kind: "specialist_result_ready", headline: "Late specialist note" }, { sender: { role: "runtime" } });
    await f.runtime.queueHerdr(wake); await f.runtime.flushOutbound();
    await f.approve();
    for (let pass = 0; pass < 3; pass++) { await f.runtime.resumeRecoverableRuns(); await f.runtime.tick(); }
    expect(f.sentTo("coordinator").map(message => message.message_id)).toContain(wake.message_id);
  });

  // F7: every agent prompt allows `inconclusive`; it is a correlated result, so the specialist no longer owes one.
  it("an inconclusive specialist result discharges its obligation", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "intake");
    const request = await architectRequest(f);
    await f.runtime.receiveHerdr(f.reply("architect", request, "task.status", { status: "inconclusive", summary: "Two designs are equally valid" }));
    const [facts] = await f.runtime.watchdogSnapshot("session-1");
    expect(facts!.acceptedRoles ?? []).not.toContain("architect");
  });

  // F14: an ACK observed after the host's deadline means the message was delivered; the run must not be stranded by the uncertainty.
  it("a late acknowledgement after native delivery uncertainty does not strand the run", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "intake");
    const request = await architectRequest(f);
    const reply = f.reply("architect", request, "spec.draft", { status: "completed", summary: "Impact analysis" });
    await f.runtime.reportUncertainNativeDelivery(reply, "op-late-ack", "Native delivery acknowledgement was not observed");
    await f.runtime.receiveHerdr(reply).catch(() => undefined);
    await f.runtime.tick();
    await drive(f, "specifying", 1);
    expect((await f.state()).inbox.find(item => item.message.message_id === reply.message_id)?.status).toBe("applied");
  });

  // F9: the documented recovery for a specialist that stopped without a result is to dispatch the same work again.
  it("re-dispatching the same objective after a specialist stopped without a result delivers a new request", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "intake");
    await architectRequest(f);
    await f.runtime.specialistTurnStopped(f.binding("architect"), "architect");
    await f.runtime.flushOutbound();
    const again = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]));
    await f.runtime.flushOutbound();
    expect(f.sentTo("architect")).toHaveLength(2);
    await f.runtime.receiveHerdr(f.reply("architect", again, "spec.draft", { status: "completed", summary: "Impact analysis" }));
    await f.runtime.flushOutbound();
    await drive(f, "specifying", 1);
  });

  // F15: a terminal structured task.status is an answer; ending the turn afterwards is not "no response".
  it("a specialist that answered with a terminal task.status is not reported as silent when it stops", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "intake");
    const request = await architectRequest(f);
    await f.runtime.receiveHerdr(f.reply("architect", request, "task.status", { status: "completed", summary: "Impact analysis" }));
    await f.runtime.specialistTurnStopped(f.binding("architect"), "architect");
    expect(await kinds(f, "specialist_no_response")).toEqual([]);
  });

  // F5: results already in flight when a run pauses for a blocker are applied after the resume, exactly once.
  it("a specialist result that arrives while the run is paused is applied after resume", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "intake");
    const architect = await architectRequest(f);
    const planner = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "planner", "Draft a plan", ["planning"]));
    await f.runtime.flushOutbound();
    await f.runtime.receiveHerdr(f.reply("architect", architect, "spec.draft", { status: "completed", summary: "Impact analysis" }));
    await f.runtime.observeCoordinatorOutcome(f.envelope("task.status", { status: "blocked", reason: "Need the deployment target from the user" },
      { sender: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" }, recipient: { role: "conversation" } }));
    const paused = await f.run();
    expect(paused).toMatchObject({ status: "escalated", pendingAction: { state: "pending" } });
    const planReply = f.reply("planner", planner, "spec.draft", { status: "completed", summary: "Plan" });
    await f.runtime.receiveHerdr(planReply).catch(() => undefined);
    expect((await f.state()).inbox.find(item => item.message.message_id === planReply.message_id)?.status).not.toBe("rejected");
    await f.runtime.resumeBlockedRun("run-1", paused.pendingAction!.actionId);
    await f.runtime.tick(); await f.runtime.tick();
    const state = await f.state();
    expect(state.inbox.filter(item => item.message.message_id === planReply.message_id).map(item => item.status)).toEqual(["applied"]);
    expect((await f.runtime.watchdogSnapshot("session-1"))[0]!.acceptedRoles ?? []).not.toContain("planner");
    await drive(f, "specifying", 0);
  });

  // F2: Coordinator status addressed to Conversation reaches it even when it carries no live run to journal.
  it("delivers Coordinator status to Conversation after completion and for a run this journal does not know", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "completed");
    const delivered: RoleMessage[] = [];
    const conversation = { receiveHerdr: async (message: RoleMessage) => { delivered.push(message); return { ok: true }; } };
    const coordinator = { role: "coordinator" as const, agent_id: "coordinator", pane_id: "pane-coordinator" };
    const done = f.envelope("task.status", { status: "completed", summary: "Run finished" }, { sender: coordinator, recipient: { role: "conversation" } });
    const general = f.envelope("conversation.progress", { headline: "Earlier run finished" }, { sender: coordinator, recipient: { role: "conversation" },
      run_id: "run-earlier-session", correlation_id: "correlation-earlier-session" });
    await routeNativeConversationMessage(f.runtime, conversation as never, done);
    await routeNativeConversationMessage(f.runtime, conversation as never, general);
    expect(delivered.map(message => message.message_id)).toEqual([done.message_id, general.message_id]);
  });

  // F11: automatic capability resume is bounded per run, even when each resumed turn reports a new blocker.
  it("bounds automatic resumes when the Coordinator keeps reporting a blocker", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "specifying");
    for (let round = 0; round < 6; round++) {
      await f.runtime.observeCoordinatorOutcome(f.envelope("task.status", { status: "blocked", reason: `The repository has no test command (round ${round})` },
        { sender: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" }, recipient: { role: "conversation" } })).catch(() => undefined);
      await f.runtime.resumeRecoverableRuns();
      await f.runtime.flushOutbound();
    }
    expect((await kinds(f, "resume_run")).length).toBeLessThanOrEqual(3);
  });
});
