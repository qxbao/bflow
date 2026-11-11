import { describe, expect, it } from "vitest";
import { BLOCKERS, TaskBlocker, blockerOf, isResumable } from "../../src/agentic/blockers.js";

describe("task blocker taxonomy", () => {
  it("gives every registered blocker an owner and a next action", () => {
    for (const entry of Object.values(BLOCKERS)) {
      expect(["developer", "director", "user", "environment", "runtime"]).toContain(entry.fixableBy);
      expect(entry.nextAction.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps code, repair owner, action and details on an Error", () => {
    const blocker = new TaskBlocker("declared_test_missing", "Missing committed test", { paths: ["test/missing.test.ts"] });
    expect(blocker).toBeInstanceOf(Error);
    expect(blocker.message).toBe("Missing committed test");
    expect(blocker).toMatchObject({
      code: "declared_test_missing",
      fixableBy: "director",
      details: { paths: ["test/missing.test.ts"] }
    });
    expect(blocker.nextAction).toBe(BLOCKERS.declared_test_missing.nextAction);
    expect(blockerOf(blocker)).toBe(blocker);
    expect(blockerOf(new Error("ordinary failure"))).toBeUndefined();
  });

  it("allows same-plan resume only for environment or runtime repair", () => {
    for (const fixableBy of ["environment", "runtime"] as const) expect(isResumable({ fixableBy })).toBe(true);
    for (const fixableBy of ["developer", "director", "user"] as const) expect(isResumable({ fixableBy })).toBe(false);
  });
});
