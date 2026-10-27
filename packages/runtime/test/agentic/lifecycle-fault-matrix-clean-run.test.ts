import { afterEach, describe, expect, it } from "vitest";
import { lifecycleFixture } from "../helpers/lifecycle-fixture.js";
import { cleanups, stages, index, through, drive } from "../helpers/lifecycle-fault-matrix-stages.js";

/**
 * Whole-run liveness matrix: drive one run from intake to completed through the real Runtime/Core/Git/storage boundaries and inject a
 * fault at each SDLC step. The property under test is that every recoverable fault leaves the run either progressing, in a valid wait,
 * or in an explicit resumable blocker, and that the run then completes with a bounded number of explicit resumes and no lost result.
 * Local fake transport only: this is not live Herdr or provider evidence.
 */
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

describe.skipIf(process.platform === "win32")("whole-run lifecycle fault matrix", () => {
  it("completes a clean run from intake through specialist, implementation, verification and approval", async () => {
    const f = await lifecycleFixture(cleanups);
    await through(f, "specifying"); expect((await f.run()).status).toBe("specifying");
    await stages[index("planned")]!.run(f); expect((await f.run()).status).toBe("implementing");
    await drive(f, "planned", 0);
    expect(f.sentTo("architect")).toHaveLength(1);
    expect(f.sentTo("developer")).toHaveLength(1);
  });

  // F3: once Core exists, Runtime owns dispatch, verification and integration. A Coordinator Stop there (including a replay of an
  // old handled Stop after restart) must never turn Runtime-owned progress into an escalation.
  it.each(["intake", "specifying", "planned", "implemented", "task verified", "workflow verified"])(
    "a Coordinator Stop after %s never strands the run", async last => {
      const f = await lifecycleFixture(cleanups);
      await through(f, last);
      await f.coordinatorStop();
      await f.coordinatorStop(f.intakeMessage);
      const current = await f.run();
      if (index(last) >= index("planned")) expect(current.status, `${last}: ${current.error}`).not.toBe("escalated");
      await drive(f, last, 1);
    });

  // F6: a verification job running longer than the stall threshold is Runtime-owned work, not a dead run.
});
