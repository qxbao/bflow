import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema } from "@bflow/contracts";
import { lifecycleFixture, type LifecycleFixture } from "../helpers/lifecycle-fixture.js";

/**
 * F17: an environment/timeout `blocked` (or `inconclusive`) verification outcome must leave a resumable action and a Coordinator wake,
 * and be retried through the bounded retry path. Local fake transport and fake gates over real Core/Git/SQLite/artifact store.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

async function implemented(f: LifecycleFixture) {
  await f.runtime.queueHerdr(f.intakeMessage); await f.runtime.flushOutbound(); await f.runtime.receiveHerdr(f.intakeMessage);
  const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]));
  await f.runtime.flushOutbound();
  await f.runtime.receiveHerdr(f.reply("architect", request, "spec.draft", { status: "completed", summary: "Impact analysis" }));
  await f.runtime.flushOutbound();
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
  await f.runtime.tick(); await f.evidence(); await f.submit();
}
/** The gate does not answer within its 3 s execution timeout: the verifier records an environment `blocked` outcome. */
async function timeOutTaskVerification(f: LifecycleFixture) {
  const hold = f.hold("task");
  await f.runtime.tick();
  await hold.reached; hold.release(); // the late answer arrives after the verifier has already given up
}

describe.skipIf(process.platform !== "linux")("blocked verification retry", () => {
  it("a timed-out task verification is resumable, wakes the Coordinator, and completes after one authorized resume", async () => {
    const f = await lifecycleFixture(cleanups);
    await implemented(f);
    await timeOutTaskVerification(f);
    const blocked = await f.run();
    expect(blocked).toMatchObject({ status: "escalated", error: expect.stringContaining("Verification environment blocked"),
      pendingAction: { kind: "resume_coordinator", state: "pending", previousStatus: "verifying" } });
    await f.runtime.flushOutbound();
    expect(f.sentTo("coordinator").some(message => (message.payload as { kind?: string }).kind === "verification_stuck")).toBe(true);
    await f.runtime.resumeBlockedRun("run-1", blocked.pendingAction!.actionId); // Conversation "tiếp tục" / Coordinator resume_run
    expect(await f.run()).toMatchObject({ status: "verifying", tasks: [expect.objectContaining({ cycle: expect.objectContaining({ status: "in_progress" }) })] });
    await f.runtime.tick(); // task verification on a fresh cycle
    expect((await f.run()).tasks[0]!.cycle?.status).toBe("passed");
    await f.runtime.tick(); // workflow verification
    await f.approve();
    expect((await f.run()).status).toBe("completed");
  }, 60_000);

  it("retry_verification performs the same retry and is bounded across repeated blocked outcomes", async () => {
    const f = await lifecycleFixture(cleanups);
    await implemented(f);
    for (let attempt = 0; attempt < 3; attempt++) {
      await timeOutTaskVerification(f);
      expect(await f.run()).toMatchObject({ status: "escalated", pendingAction: { state: "pending", resumeAttempts: attempt } });
      await expect(f.runtime.retryVerification("run-1")).resolves.toMatchObject({ retried: true });
    }
    await timeOutTaskVerification(f);
    const exhausted = await f.run();
    expect(exhausted).toMatchObject({ status: "escalated", pendingAction: { state: "pending", resumeAttempts: 3 } });
    await expect(f.runtime.retryVerification("run-1")).rejects.toThrow(/exhausted/);
    // An explicit user resume has its own budget: it is still allowed and grants a fresh automatic budget.
    await expect(f.runtime.resumeBlockedRun("run-1", exhausted.pendingAction!.actionId)).resolves.toMatchObject({ queued: true });
    expect(await f.run()).toMatchObject({ status: "verifying", pendingAction: { state: "queued", resumeAttempts: 0, manualResumeAttempts: 1 } });
  }, 120_000);

  it("a real failed verdict is not treated as a retryable environment block", async () => {
    const f = await lifecycleFixture(cleanups);
    await implemented(f);
    f.setFailingRole("tester");
    await f.runtime.tick();
    const current = await f.run();
    expect(current.tasks[0]!.cycle?.status).toBe("rework_required"); // bounded rework, then a final human escalation at the bound
    expect(current.status).toBe("implementing");
    expect(current.pendingAction?.reason ?? "").not.toMatch(/Verification delivery\/storage/);
    await expect(f.runtime.retryVerification("run-1")).rejects.toThrow(/No verification awaiting retry/);
  }, 60_000);
});
