import { expect, it } from "vitest";
import { projectRun } from "../../src/interaction/views.js";
import { run, state, pending, at } from "./fixtures.js";
function view(r = run(), ready = true) {
  return projectRun(
    {
      state: state([r]),
      sessionId: "conversation-1",
      observedAt: at,
      core: new Map(),
      ready,
      commandsSupported: true,
    },
    r.runId,
  );
}
it("never guesses resume from blocked phase without pending action", () => {
  expect(
    view(run("r", { status: "escalated" })).availableActions.some(
      (a) => a.kind === "resume",
    ),
  ).toBe(false);
});
it("binds resume to exact action, insensitive to observation time", () => {
  const r = run("r", { status: "escalated", pendingAction: pending });
  const a = view(r).availableActions.find((a) => a.kind === "resume")!;
  expect(a.enabled).toBe(true);
  expect(a.actionId).toBe("resume-1");
  expect(
    view(r).availableActions.find((b) => b.kind === "resume")!.expectedVersion,
  ).toEqual(a.expectedVersion);
});
it("terminal, exhausted, uncertain delivery and unsupported authority cannot enable resume", () => {
  for (const r of [
    run("r", { status: "completed", pendingAction: pending }),
    run("r", {
      status: "escalated",
      pendingAction: { ...pending, manualResumeAttempts: 3 },
    }),
    run("r", {
      status: "escalated",
      pendingAction: pending,
      nativeDeliveries: [{ operationId: "private", message: {} as never }],
    }),
  ])
    expect(
      view(r)
        .availableActions.filter((a) => a.kind === "resume")
        .every((a) => !a.enabled),
    ).toBe(true);
  expect(
    view(
      run("r", { status: "escalated", pendingAction: pending }),
      false,
    ).availableActions.every((a) => !a.enabled),
  ).toBe(true);
});

import { interactionHostReady } from "../../src/interaction/actions.js";
it("requires completed activation and an active manifest before reporting ready", () => {
  const active = {
    workspace: true,
    manifest: true,
    activating: false,
    closing: false,
    quiesced: false,
  };
  expect(interactionHostReady(active)).toBe(true);
  for (const patch of [
    { manifest: false },
    { activating: true },
    { closing: true },
    { quiesced: true },
    { workspace: false },
  ])
    expect(interactionHostReady({ ...active, ...patch })).toBe(false);
});
