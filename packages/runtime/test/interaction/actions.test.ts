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

it("retains the existing follow-up exhaustion bound instead of offering another continuation", () => {
  const exhausted = run("sixth-run");
  exhausted.delegation.metadata = { followUp: 6, originRunId: "original" };
  expect(
    view(exhausted).availableActions.find(
      (action) => action.kind === "revise_request",
    ),
  ).toMatchObject({
    enabled: false,
    disabledReason: "follow_up_budget_exhausted",
  });
  const parent = run("parent", {
    status: "escalated",
    supersededBy: "child",
    pendingAction: pending,
  });
  expect(view(parent).availableActions).toEqual([]);
});

import { RoleMessageSchema } from "@bflow/contracts";
import { availableActions } from "../../src/interaction/actions.js";
it.each([true, false])("offers a distinct owner resume after automatic=%s wake without resetting bounds", automatic => {
  const r = run("r", { status: "implementing", pendingAction: { ...pending, state: "queued" },
    resumeReceipts: [{ actionId: pending.actionId, messageId: "wake-1" }] });
  const journal = state([r]);
  journal.outbound.push({ message: RoleMessageSchema.parse({ schema_version: 2, message_id: "wake-1", correlation_id: "c-r",
    run_id: "r", sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status",
    payload: { kind: "resume_run", actionId: pending.actionId, automatic }, artifact_references: [],
    occurred_at: at, idempotency_key: "wake-1" }), status: "released", selector: "coordinator", taskId: "t", attemptId: "attempt-1", capabilities: [] });
  const resume = () => availableActions(r, journal, [], true, true).find(a => a.kind === "resume")!;
  expect(resume().enabled).toBe(automatic);
  r.pendingAction!.manualResumeAttempts = 3;
  expect(resume()).toMatchObject({ enabled: false, disabledReason: "resume_budget_exhausted" });
});
