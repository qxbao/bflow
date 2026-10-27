import { afterEach, describe, expect, it } from "vitest";
import { lifecycleFixture } from "../helpers/lifecycle-fixture.js";
import { cleanups, names, through, drive } from "../helpers/lifecycle-fault-matrix-extended-stages.js";


/**
 * Extended whole-run matrix: restarts, cancellation, rework, human changes, requirement revisions, redelivery and Conversation outages
 * at every SDLC step. Local fake transport only; not live Herdr/provider evidence.
 */
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

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
});
