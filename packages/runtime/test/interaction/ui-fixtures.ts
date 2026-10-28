/** Public synthetic DTO examples; no provider/host/HTTP acceptance is implied. */
import {
  WebProjectSessionSchema,
  type ApprovalRequest,
  type WebRunView,
} from "@bflow/contracts";
import { projectRun, type ReadSources } from "../../src/interaction/views.js";
import { at, pending, run, state, uiStates } from "./fixtures.js";
export function interactionUiFixtures() {
  const examples: Record<string, WebRunView> = {};
  const source = (runs = uiStates()): ReadSources => ({
    state: state(runs),
    sessionId: "conversation-1",
    observedAt: at,
    core: new Map(),
    ready: true,
  });
  for (const r of uiStates())
    examples[r.status] = projectRun(source([r]), r.runId);
  for (const kind of ["design", "delivery", "user_decision"] as const) {
    const r = run(`run-${kind}`, { status: "awaiting_approval" });
    const request: ApprovalRequest = {
      schemaVersion: 2,
      approvalId: `apr-${kind}`,
      runId: r.runId,
      sessionId: "conversation-1",
      target:
        kind === "delivery"
          ? { type: "run" }
          : { type: "specification", specId: "spec-1" },
      revision: 2,
      generation: 1,
      requestedBy: "runtime",
      requestedAt: at,
      reason: `Review ${kind}`,
      evidence: [],
      idempotencyKey: `apr-${kind}`,
    };
    if (kind === "user_decision")
      r.userDecisions = {
        [request.approvalId]: {
          request,
          role: "coordinator",
          agentId: "coordinator",
          paneId: "pane",
          taskId: "task-1",
          status: "pending",
        },
      };
    else {
      r.approval = request;
      r.approvalKind = kind;
    }
    examples[kind] = projectRun(source([r]), r.runId);
  }
  for (const [name, r] of Object.entries({
    blocked_without_action: run("blocked", { status: "escalated" }),
    resume: run("resume", { status: "escalated", pendingAction: pending }),
    exhausted: run("exhausted", {
      status: "escalated",
      pendingAction: { ...pending, manualResumeAttempts: 3 },
    }),
    stale: run("stale", { coreCreated: true }),
  }))
    examples[name] = projectRun(
      { ...source([r]), commandsSupported: true },
      r.runId,
    );
  const parent = run("parent", { status: "escalated", supersededBy: "child" }),
    child = run("child");
  child.delegation.metadata = {
    parentRunId: "parent",
    originRunId: "parent",
    followUp: 2,
  };
  examples.historical_parent = projectRun(source([parent, child]), "parent");
  examples.continuation = projectRun(source([parent, child]), "child");
  const after = run("after-core", { status: "verifying", coreCreated: true });
  const active = source([after]);
  active.core.set(after.runId, {
    runId: after.runId,
    workflowId: "workflow",
    workflowVersion: "1",
    status: "running",
    tasks: [],
    version: 1,
    lastEventSequence: 1,
    createdAt: at,
    updatedAt: at,
  });
  examples.after_core = projectRun(
    { ...active, transport: { states: ["done"], observedAt: at } },
    after.runId,
  );
  return {
    runs: examples,
    pendingSession: WebProjectSessionSchema.parse({
      apiVersion: 1,
      projectId: "project-fixture",
      sessionId: "conversation-1",
      state: "ready",
      conversationStatus: "awaiting_user_clarification",
      pendingIntakes: [
        {
          intakeId: "intake-1",
          correlationId: "intake-1",
          sessionId: "conversation-1",
          title: "Pending request",
          status: "clarifying",
          clarifications: [
            {
              questionId: "question-1",
              question: "Which behavior?",
              options: [],
              expectedVersion: { revisionToken: "fixture-question-v1" },
            },
          ],
          updatedAt: at,
        },
      ],
      blockers: [],
      updatedAt: at,
    }),
    sessions: ["stopped", "starting", "ready", "stopping", "unavailable"].map(
      (state) =>
        WebProjectSessionSchema.parse({
          apiVersion: 1,
          projectId: "project-fixture",
          sessionId: "conversation-1",
          state,
          pendingIntakes: [],
          blockers:
            state === "unavailable"
              ? [
                  {
                    code: "host_unavailable",
                    message: "Start the session explicitly.",
                  },
                ]
              : [],
          updatedAt: at,
        }),
    ),
  };
}
