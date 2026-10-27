import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoleMessageSchema, type RoleMessage } from "@bflow/contracts";
import { evaluateWatchdog } from "../../src/agentic/run-watchdog.js";
import { lifecycleFixture, type LifecycleFixture } from "../helpers/lifecycle-fixture.js";

/**
 * Extended whole-run matrix: restarts, cancellation, rework, human changes, requirement revisions, redelivery and Conversation outages
 * at every SDLC step. Local fake transport only; not live Herdr/provider evidence.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

interface Stage { name: string; run(f: LifecycleFixture): Promise<void> }
const stages: Stage[] = [
  { name: "intake", run: async f => { await f.runtime.queueHerdr(f.intakeMessage); await f.runtime.flushOutbound(); await f.runtime.receiveHerdr(f.intakeMessage); } },
  { name: "specifying", run: async f => {
    const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]));
    await f.runtime.flushOutbound();
    await f.runtime.receiveHerdr(f.reply("architect", request, "spec.draft", { status: "completed", summary: "Impact analysis" }));
    await f.runtime.flushOutbound();
  } },
  { name: "planned", run: async f => { await f.runtime.proposeWorkflow("run-1", f.spec, f.def); } },
  { name: "implemented", run: async f => { await f.runtime.tick(); await f.evidence(); await f.submit(); } },
  { name: "task verified", run: async f => { await f.runtime.tick(); } },
  { name: "workflow verified", run: async f => { await f.runtime.tick(); } },
  { name: "completed", run: async f => { await f.approve(); } }
];
const names = stages.slice(0, -1).map(stage => stage.name);
const index = (name: string) => stages.findIndex(stage => stage.name === name);
async function through(f: LifecycleFixture, last: string) { for (const stage of stages.slice(0, index(last) + 1)) await stage.run(f); }
async function drive(f: LifecycleFixture, after: string, maxResumes: number): Promise<number> {
  let resumes = 0;
  for (const stage of stages.slice(index(after) + 1)) {
    const current = await f.run();
    if (current.status === "escalated") {
      expect(current.pendingAction, `before ${stage.name}: escalated without a resumable action (${current.error})`).toBeDefined();
      expect(++resumes, `before ${stage.name}: more explicit resumes than allowed (${current.error})`).toBeLessThanOrEqual(maxResumes);
      await f.runtime.resumeBlockedRun("run-1", current.pendingAction!.actionId);
      await f.runtime.flushOutbound();
    }
    await stage.run(f);
  }
  const final = await f.run();
  expect(final.status, `final error: ${final.error}`).toBe("completed");
  return resumes;
}
/** A live run must be progressing, validly waiting, or carry an explicit resumable action; never a silent terminal escalation. */
async function expectActionable(f: LifecycleFixture, label: string) {
  const current = await f.run();
  if (current.status === "escalated") expect(current.pendingAction, `${label}: escalated without a resumable action (${current.error})`).toBeDefined();
  expect(["failed"].includes(current.status) && !current.error, `${label}: failed without a reason`).toBe(false);
}

describe.skipIf(process.platform === "win32")("whole-run lifecycle fault matrix (extended)", () => {
  it.each(names)("a Runtime restart after %s resumes the same run to completion without manual help", async last => {
    const f = await lifecycleFixture(cleanups);
    await through(f, last);
    const restarted = await f.restartProcess(); await restarted.resumeRecoverableRuns();
    expect(await drive(f, last, 0)).toBe(0);
    expect(f.sentTo("developer").length).toBeLessThanOrEqual(1);
  });

  it("a process lost while task verification was running re-verifies after restart and completes", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "implemented");
    const hold = f.hold("task");
    const ticking = f.runtime.tick();
    // The simulated dead process still has a live coroutine and gate timeout in this test process.
    // Drain it before the fixture closes its stores/removes artifacts, including on assertion failure.
    void ticking.catch(() => undefined); // teardown awaits and surfaces any rejection
    cleanups.push(async () => { hold.release(); await ticking; });
    await hold.reached;
    await f.restartProcess();
    expect(await drive(f, "implemented", 0)).toBe(0);
  });

  it.each(names)("cancellation after %s stops the run without further dispatch or escalation", async last => {
    const f = await lifecycleFixture(cleanups);
    await through(f, last);
    await f.runtime.cancel("run-1", "User cancelled");
    const sent = f.transport.sentRequests.length;
    await f.runtime.tick(); await f.runtime.tick(); await f.runtime.resumeRecoverableRuns(); await f.coordinatorStop().catch(() => undefined);
    expect((await f.run()).status).toBe("cancelled");
    expect(f.transport.sentRequests.slice(sent).filter(request => ["developer", "architect", "coordinator"].includes(request.role))).toEqual([]);
  });

  it("reviewer rework with a Coordinator Stop in between still completes", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "planned");
    f.setFailingRole("reviewer");
    await f.runtime.tick(); await f.evidence(); await f.submit(); await f.runtime.tick();
    expect((await f.run()).tasks[0]!.cycle?.status).toBe("rework_required");
    await f.coordinatorStop();
    await expectActionable(f, "after rework Stop");
    expect((await f.run()).status).not.toBe("escalated");
    f.setFailingRole(undefined);
    await f.runtime.tick(); await f.submit("implement", "repaired\n");
    for (let pass = 0; pass < 3 && (await f.run()).status !== "awaiting_approval"; pass++) await f.runtime.tick();
    const repaired = await f.run();
    expect(repaired.status, `repaired task must integrate: ${repaired.error}`).toBe("awaiting_approval");
    expect(repaired.tasks[0]!.reworkResolutions?.[0]?.verificationOutcome.status).toBe("verified_closed");
    expect(repaired.tasks[0]!.reworkResolutions?.[0]?.verificationOutcome.findingVerdicts.length).toBeGreaterThan(0);
    await f.approve();
    expect((await f.run()).status).toBe("completed");
  });

  // N2: "changes requested" at delivery approval returns the work to the Coordinator as a follow-up run of the same correlation,
  // built on the delivered integration head, with the human feedback; it is planned, implemented, verified and approved again.
  describe("delivery feedback on a verified parent", () => {
    let f: LifecycleFixture;
    beforeEach(async () => {
      // This scenario exercises a second complete workflow. Build the real verified parent as fixture setup,
      // with the existing hook deadline, rather than consuming the follow-up action's entire test deadline.
      f = await lifecycleFixture(cleanups);
      await through(f, "workflow verified");
    });
    it("a human 'changes requested' at delivery approval continues as a follow-up run built on the delivered work", async () => {
      const delivered = (await f.run()).workflowChange!.headCommitHash;
      await f.approve("changes_requested");
      await f.runtime.flushOutbound();
      const parent = await f.run();
      expect(parent.status).not.toBe("awaiting_approval");
      expect(parent.status).not.toBe("failed");
      const wake = f.sentTo("coordinator").find(message => (message.payload as { kind?: string }).kind === "changes_requested");
      expect(wake, "Coordinator must be woken with the human feedback").toBeDefined();
      const payload = wake!.payload as { followUpRunId: string; feedback: string; runId: string };
      expect(payload).toMatchObject({ runId: "run-1", followUpRunId: "run-1-r2", feedback: expect.stringContaining("User asked for changes") });
      const child = await f.run(payload.followUpRunId);
      expect(child).toMatchObject({ status: "planning", coreCreated: false, baseRevision: delivered });
      expect(child.delegation).toMatchObject({ correlationId: "correlation-1", sessionId: "session-1", runId: "run-1-r2" });
      // A Coordinator Stop on the wake before re-planning is a resumable pause, never a dead run.
      await f.coordinatorStop();
      const stopped = await f.run("run-1-r2");
      if (stopped.status === "escalated") {
        expect(stopped.pendingAction).toBeDefined();
        await f.runtime.resumeBlockedRun("run-1-r2", stopped.pendingAction!.actionId); await f.runtime.flushOutbound();
      }
      await f.runtime.proposeWorkflow("run-1-r2", { ...f.spec, runId: "run-1-r2" }, f.def);
      expect((await f.run("run-1-r2")).status).toBe("implementing");
      await f.runtime.tick(); await f.evidence("implement", "run-1-r2");
      const worktree = (await f.state()).outbound.filter(out => out.message.run_id === "run-1-r2" && out.message.type === "task.assignment").at(-1)!.handle!.target.worktreePath!;
      expect(await readFile(join(worktree, "guide.md"), "utf8"), "follow-up starts from the delivered change").toBe("updated\n");
      await f.submit("implement", "updated\nwith feedback\n", "run-1-r2");
      for (let pass = 0; pass < 3 && (await f.run("run-1-r2")).status !== "awaiting_approval"; pass++) await f.runtime.tick();
      const reworked = await f.run("run-1-r2");
      expect(reworked.status, `follow-up must reach delivery approval: ${reworked.error}`).toBe("awaiting_approval");
      await f.approve("approved", "run-1-r2");
      expect((await f.run("run-1-r2")).status).toBe("completed");
      expect(f.sentTo("developer").filter(message => message.run_id === "run-1-r2")).toHaveLength(1);
      // The superseded parent never dispatches again and never pauses the follow-up.
      await f.runtime.tick(); await f.runtime.resumeRecoverableRuns();
      expect(f.sentTo("developer").filter(message => message.run_id === "run-1")).toHaveLength(1);
    });
  });

  it("a requirement revision is admitted while the run is paused for a resumable blocker", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "specifying");
    await f.coordinatorStop(); // Coordinator ended without acting on the specialist result: resumable pause
    expect((await f.run())).toMatchObject({ status: "escalated", pendingAction: { state: "pending" } });
    const revised = { ...(await f.run()).delegation, messageId: "intake-2", idempotencyKey: "intake-2", objective: "Clarified objective",
      metadata: { isRequirementChange: true, revision: 2 } };
    await expect(f.runtime.queueHerdr(f.envelope("delegation.request", revised, { message_id: "intake-2", idempotency_key: "intake-2" }))).resolves.toBeDefined();
  });

  it("a Developer that keeps working past the stall threshold is not escalated", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "planned");
    await f.runtime.tick();
    const developer = f.panes.bindings.find(pane => pane.role === "developer")!;
    const runs = await f.runtime.watchdogSnapshot("session-1");
    const panes = f.panes.bindings.filter(pane => pane.role !== "conversation").map(pane => ({ role: pane.role, paneId: pane.paneId,
      status: pane.paneId === developer.paneId ? "working" : "idle" }));
    for (const action of evaluateWatchdog({ now: Date.now() + 15 * 60_000, runs, notices: [], panes }))
      if (action.kind === "stalled") await f.runtime.reportRunStalled(action.runId, action.episodeKey);
    expect((await f.run()).status).toBe("implementing");
  });

  it("at-least-once redelivery of every agent result is idempotent through completion", async () => {
    const f = await lifecycleFixture(cleanups);
    const original = f.runtime.receiveHerdr.bind(f.runtime);
    const seen: RoleMessage[] = [];
    (f.runtime as unknown as { receiveHerdr(input: unknown): Promise<unknown> }).receiveHerdr = async input => {
      const result = await original(input); seen.push(RoleMessageSchema.parse(input));
      await original(input); return result;
    };
    await through(f, "completed");
    expect((await f.run()).status).toBe("completed");
    expect(f.sentTo("developer")).toHaveLength(1);
    expect(f.sentTo("architect")).toHaveLength(1);
    const wakes = (await f.state()).outbound.filter(out => out.message.recipient.role === "coordinator" && out.message.sender.role === "runtime");
    expect(new Set(wakes.map(out => out.message.message_id)).size).toBe(wakes.length);
    expect(seen.length).toBeGreaterThan(3);
  });

  it("a temporary Conversation outage does not stop the workflow and its notices are delivered afterwards", async () => {
    const f = await lifecycleFixture(cleanups);
    const deliver = f.ports.deliverToConversation.bind(f.ports);
    let down = true;
    f.ports.deliverToConversation = async message => { if (down) throw new Error("Conversation host is not ready"); return deliver(message); };
    await through(f, "workflow verified");
    expect((await f.run()).status).toBe("awaiting_approval");
    down = false;
    for (let pass = 0; pass < 3; pass++) await f.runtime.tick();
    expect(f.conversationInbox.some(message => message.type === "approval.request")).toBe(true);
    await f.approve();
    expect((await f.run()).status).toBe("completed");
  });
});
