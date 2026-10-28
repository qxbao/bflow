import { expect, it } from "vitest";
import { projectRun, paginateRuns } from "../../src/interaction/views.js";
import { run, state, at, uiStates } from "./fixtures.js";
const source = (runs = [run()]) => ({
  state: state(runs),
  sessionId: "conversation-1",
  observedAt: at,
  core: new Map(),
  ready: true,
});
it("projects pre-Core runs and separates SDLC/Core/transport; allowlists fields", () => {
  const view = projectRun(source(), "run-1");
  expect(view.coreStatus).toBeNull();
  expect(view.sdlcStatus).toBe("planning");
  expect(view.transportSummary.states).toEqual([]);
  expect(JSON.stringify(view)).not.toMatch(
    /delegation|inputArtifacts|requestedBy/,
  );
});
it("keeps old deep links and follows validated lineage without swapping snapshots", () => {
  const parent = run("parent", { status: "escalated", supersededBy: "child" });
  const child = run("child");
  child.delegation.metadata = {
    parentRunId: "parent",
    originRunId: "parent",
    followUp: 2,
  };
  const view = projectRun(source([parent, child]), "parent");
  expect(view).toMatchObject({
    runId: "parent",
    currentRunId: "child",
    continuedAsRunId: "child",
    originRunId: "parent",
  });
});
it("isolates sessions and refuses cross-session lineage", () => {
  const foreign = run("foreign");
  foreign.delegation.sessionId = "other";
  const s = source([run(), foreign]);
  expect(() => projectRun(s, "foreign")).toThrow();
  expect(paginateRuns(s, {}).items).toHaveLength(1);
});
it("paginates bounded projections; rejects stale or mismatched cursors", () => {
  const s = source(uiStates());
  const page = paginateRuns(s, { limit: 2 });
  expect(page.items).toHaveLength(2);
  expect(
    paginateRuns(s, { limit: 2, cursor: page.nextCursor }).items,
  ).toHaveLength(2);
  s.state.runs[0].status = "failed";
  expect(() => paginateRuns(s, { limit: 2, cursor: page.nextCursor })).toThrow(
    /stale/i,
  );
});
it("exports all SDLC UI fixtures that parse frozen DTOs", () => {
  for (const r of uiStates())
    expect(projectRun(source([r]), r.runId).sdlcStatus).toBe(r.status);
});
it("marks missing Core projection stale rather than fabricating success", () => {
  const s = source([run("run-1", { coreCreated: true })]);
  expect(projectRun(s, "run-1").blockers).toContainEqual(
    expect.objectContaining({ code: "core_projection_unavailable" }),
  );
});
it("pins exact approval target/revision/generation/evidence and never offers a settled approval", () => {
  const r = run("approval", { status: "awaiting_approval" });
  r.approval = {
    schemaVersion: 2,
    approvalId: "apr-1",
    runId: r.runId,
    sessionId: "conversation-1",
    target: { type: "specification", specId: "spec-1" },
    revision: 2,
    generation: 3,
    requestedBy: "runtime",
    requestedAt: at,
    reason: "Review design",
    evidence: [],
    idempotencyKey: "apr-1",
  };
  const v = projectRun(source([r]), r.runId);
  expect(v.decisions[0].expectedVersion).toMatchObject({
    approvalId: "apr-1",
    target: r.approval.target,
    revision: 2,
    generation: 3,
  });
  expect(
    v.availableActions.find((a) => a.kind === "answer_decision"),
  ).toMatchObject({
    enabled: false,
    disabledReason: "structured_commands_unavailable",
  });
  r.decision = {
    schemaVersion: 2,
    approvalId: "apr-1",
    runId: r.runId,
    target: r.approval.target,
    revision: 2,
    generation: 3,
    decision: "approved",
    decidedBy: "owner",
    decidedAt: at,
    feedbackArtifacts: [],
    idempotencyKey: "apr-1",
  };
  expect(projectRun(source([r]), r.runId).decisions).toEqual([]);
});

import { interactionUiFixtures } from "./ui-fixtures.js";
it("publishes synthetic session, approval, continuation, exhaustion and stale fixtures for downstream UI", () => {
  const fixtures = interactionUiFixtures();
  expect(fixtures.sessions).toHaveLength(5);
  expect(fixtures.runs.delivery.decisions[0].kind).toBe("approval");
  expect(
    fixtures.runs.exhausted.availableActions.find((a) => a.kind === "resume")
      ?.disabledReason,
  ).toBe("resume_budget_exhausted");
});
it("does not conflate completed transport with business success after Core creation", () => {
  const r = run("r", { status: "verifying", coreCreated: true });
  const s = source([r]);
  s.core.set("r", {
    runId: "r",
    workflowId: "w",
    workflowVersion: "1",
    status: "running",
    tasks: [],
    createdAt: at,
    updatedAt: at,
    version: 1,
    lastEventSequence: 1,
  });
  expect(
    projectRun({ ...s, transport: { states: ["done"], observedAt: at } }, "r"),
  ).toMatchObject({
    sdlcStatus: "verifying",
    coreStatus: "running",
    transportSummary: { states: ["done"] },
  });
});
it("changes run and pagination versions when user decisions or descendant lineage change", () => {
  const r = run("r"),
    s = source([r]);
  const before = projectRun(s, "r").revisionToken;
  const request = {
    schemaVersion: 2 as const,
    approvalId: "apr-user",
    runId: "r",
    target: { type: "run" as const },
    revision: 1,
    generation: 0,
    requestedBy: "runtime",
    requestedAt: at,
    reason: "Choose",
    evidence: [],
    idempotencyKey: "apr-user",
  };
  r.userDecisions = {
    "apr-user": {
      request,
      role: "coordinator",
      agentId: "coordinator",
      paneId: "pane",
      taskId: "task",
      status: "pending",
    },
  };
  expect(projectRun(s, "r").revisionToken).not.toBe(before);
  const parent = run("parent", { status: "escalated", supersededBy: "child" }),
    child = run("child");
  child.delegation.metadata = { parentRunId: "parent", originRunId: "parent" };
  const lineage = source([parent, child]),
    old = projectRun(lineage, "parent").revisionToken;
  const grandchild = run("grandchild");
  grandchild.delegation.metadata = {
    parentRunId: "child",
    originRunId: "parent",
  };
  lineage.state.runs.push(grandchild);
  child.supersededBy = "grandchild";
  child.status = "escalated";
  expect(projectRun(lineage, "parent").revisionToken).not.toBe(old);
});
it("bounds actions while preserving readable decision DTOs at the collection boundary", () => {
  const r = run("r", { status: "awaiting_approval" });
  r.userDecisions = {};
  for (let i = 0; i < 100; i++) {
    const approvalId = `apr-${i}`;
    r.userDecisions[approvalId] = {
      request: {
        schemaVersion: 2,
        approvalId,
        runId: "r",
        target: { type: "run" },
        revision: 1,
        generation: 0,
        requestedBy: "runtime",
        requestedAt: at,
        reason: "Choose",
        evidence: [],
        idempotencyKey: approvalId,
      },
      role: "coordinator",
      agentId: "coordinator",
      paneId: "pane",
      taskId: "task",
      status: "pending",
    };
  }
  const view = projectRun(source([r]), "r");
  expect(view.decisions).toHaveLength(100);
  expect(view.availableActions.length).toBeLessThanOrEqual(100);
  expect(view.blockers).toContainEqual(
    expect.objectContaining({ code: "projection_truncated" }),
  );
});

it("keeps a browser-safe JSON fixture bundle for W03/W06", async () => {
  await expect(
    JSON.stringify(interactionUiFixtures(), null, 2) + "\n",
  ).toMatchFileSnapshot("./fixtures/ui-states.json");
});
