import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleMessageSchema } from "@bflow/contracts";
import { digest } from "../../src/agentic/journal.js";
import { lifecycleFixture } from "../helpers/lifecycle-fixture.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!result.ok) throw Error(result.error.message); return result.value; };
describe.skipIf(process.platform !== "linux")("legacy delivery reconciliation hold", () => {
  it("does not advance or checkpoint a run waiting for delivery reconciliation, while cancellation remains actionable", async () => {
    const f = await lifecycleFixture(cleanups);
    await f.runtime.queueHerdr(f.intakeMessage); await f.runtime.flushOutbound(); await f.runtime.receiveHerdr(f.intakeMessage);
    const request = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]));
    await f.runtime.flushOutbound(); await f.runtime.receiveHerdr(f.reply("architect", request, "spec.draft", { status: "completed", summary: "Impact analysis" }));
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def); await f.runtime.tick();
    await (f.runtime as any).journal.exclusive(async (state: any, save: () => Promise<void>) => {
      state.runs[0].pendingAction = { actionId: `next-${digest(["run-1", "legacy-uncertain-request"])}`, kind: "resume_coordinator", owner: "coordinator", reason: "Delivery outcome requires reconciliation", sourceMessageId: "legacy-uncertain-request", createdAt: new Date().toISOString(), state: "pending", recovery: "reconcile_delivery" };
      await save();
    });
    const before = unwrap(await f.ports.engine.getSnapshot("run-1"));
    const advance = vi.spyOn(f.ports.engine, "advance"), checkpoint = vi.spyOn(f.ports.runStore, "saveCheckpoint");
    await f.runtime.tick(); await f.runtime.tick();
    expect(advance).not.toHaveBeenCalled(); expect(checkpoint).not.toHaveBeenCalled();
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))).toEqual(before);
    expect((await f.run()).pendingAction).toMatchObject({ actionId: `next-${digest(["run-1", "legacy-uncertain-request"])}`, state: "pending", recovery: "reconcile_delivery" });
    await f.runtime.cancel("run-1", "Operator cancellation remains supported during a delivery hold");
    expect((await f.run()).cancelled).toBe(true);
    expect(unwrap(await f.ports.engine.getSnapshot("run-1"))) .toMatchObject({ status: expect.stringMatching(/cancelling|cancelled/) });
  }, 90000);
});
