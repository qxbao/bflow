import { describe, expect, it } from "vitest";
import { launchPreparationFailure } from "../../src/agentic/workspace.js";

describe("Developer launch preparation failures", () => {
  it("treats a system fault as retryable infrastructure and keeps its errno and syscall", () => {
    const fault = Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR", syscall: "read" });
    expect(launchPreparationFailure(fault)).toEqual({
      code: "transport_unavailable", retryable: true, message: "Error: EISDIR: illegal operation on a directory, read",
      details: { stage: "prepare_launch", errno: "EISDIR", syscall: "read" }
    });
  });

  it("keeps deliberate refusals fail-closed and non-retryable", () => {
    expect(launchPreparationFailure(new Error("Platform has no prepared generation; run bflow up again")))
      .toMatchObject({ code: "validation", retryable: false });
    expect(launchPreparationFailure("plain failure")).toMatchObject({ code: "validation", retryable: false });
    // A code that is not a system errno (for example a library error code) is not an infrastructure fault.
    expect(launchPreparationFailure(Object.assign(new Error("bad input"), { code: "invalid_argument" })))
      .toMatchObject({ code: "validation", retryable: false });
  });
});
