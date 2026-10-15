import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  createStandardMvpWorkflow
} from "../helpers/fixtures.js";
import type {
  ApprovalDecision,
  TaskState,
  WorkflowDefinition
} from "@ai-flow/contracts";

function createApprovalWorkflow(options?: { maxReworks?: number }): WorkflowDefinition {
  const base = createStandardMvpWorkflow();
  const planTask = base.tasks.find((t) => t.id === "plan")!;
  const updatedPlan = {
    ...planTask,
    requiresApproval: true,
    rework: {
      maxReworks: options?.maxReworks ?? 1,
      onExhausted: "fail" as const
    }
  };

  return {
    ...base,
    id: `sdlc-approval-flow-${randomUUID()}`,
    tasks: base.tasks.map((t) => (t.id === "plan" ? updatedPlan : t))
  };
}

describe("Scenario E06 — Human Approval & Bounded Rework", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("completes task, requests human approval, and advances on valid human approval", async () => {
    const definition = createApprovalWorkflow({ maxReworks: 1 });
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-approval-happy-${randomUUID()}`;

    // 1. Start run
    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Human approval happy path" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    expect(startRes.ok).toBe(true);

    // 2. Complete plan task execution
    const { proposal, rawBytes } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Plan v1 awaiting approval"
    });

    const completeRes = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "plan",
      {
        status: "succeeded",
        summary: "Plan generation 0 complete",
        proposals: [proposal],
        contentByProposalId: { [proposal.proposalId]: rawBytes }
      }
    );
    expect(completeRes.ok).toBe(true);

    // Verify approval request was recorded in engine
    const postCompleteSnap = (await harness.service.getRun(runId)).value!;
    const planTask = postCompleteSnap.tasks.find((t: TaskState) => t.taskId === "plan")!;
    expect(planTask.status).toBe("succeeded");
    expect(planTask.generation).toBe(0);

    // Downstream task 'implement' must NOT run yet because approval is required
    const implementTask = postCompleteSnap.tasks.find((t: TaskState) => t.taskId === "implement")!;
    expect(implementTask.status).toBe("pending");

    // Find the approval request ID from events
    const events = (await harness.runStore.readEvents(runId, { limit: 100 })).value!;
    const apprReqEvent = events.items.find((e) => e.type === "approval.requested");
    expect(apprReqEvent).toBeDefined();
    const approvalId = (apprReqEvent?.payload as any).approvalId;

    // 3. Human operator approves
    const approveRes = await harness.service.decide({
      schemaVersion: 1,
      approvalId,
      runId,
      target: { type: "task", taskId: "plan" },
      revision: 1,
      generation: 0,
      decision: "approved",
      decidedBy: "human_lead_architect",
      decidedAt: new Date().toISOString(),
      feedbackArtifacts: [],
      idempotencyKey: `decide-${approvalId}`
    });
    expect(approveRes.ok).toBe(true);

    // 4. Now that approval is satisfied, downstream 'implement' task is dispatched and running
    const postApproveSnap = approveRes.value;
    const postApproveImplement = postApproveSnap.tasks.find((t: TaskState) => t.taskId === "implement")!;
    expect(postApproveImplement.status).toBe("running");
  });

  it("handles changes_requested: increments task generation and re-dispatches for rework", async () => {
    const definition = createApprovalWorkflow({ maxReworks: 2 });
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-rework-loop-${randomUUID()}`;

    // 1. Start run
    await harness.service.start({
      runId,
      definition,
      input: { requirement: "Rework generation test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });

    // 2. Complete plan generation 0
    const { proposal: p0, rawBytes: b0 } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan-gen0.md",
      content: "Plan gen 0 content"
    });
    await harness.service.orchestrator.completeTaskExecution(
      runId,
      "plan",
      {
        status: "succeeded",
        summary: "Plan gen 0 done",
        proposals: [p0],
        contentByProposalId: { [p0.proposalId]: b0 }
      }
    );

    // Get approval request id for gen 0
    const eventsGen0 = (await harness.runStore.readEvents(runId, { limit: 100 })).value!;
    const reqGen0 = eventsGen0.items.find((e) => e.type === "approval.requested");
    const approvalIdGen0 = (reqGen0?.payload as any).approvalId;

    // 3. Human reviewer requests changes
    const changeRes = await harness.service.decide({
      schemaVersion: 1,
      approvalId: approvalIdGen0,
      runId,
      target: { type: "task", taskId: "plan" },
      revision: 1,
      generation: 0,
      decision: "changes_requested",
      decidedBy: "human_reviewer",
      decidedAt: new Date().toISOString(),
      reason: "Architecture design is missing database schema details",
      feedbackArtifacts: [],
      idempotencyKey: `change-${approvalIdGen0}`
    });
    expect(changeRes.ok).toBe(true);

    // CRITICAL REWORK INVARIANT:
    // Generation must have incremented to 1
    const postChangeSnap = changeRes.value;
    const reworkedPlan = postChangeSnap.tasks.find((t: TaskState) => t.taskId === "plan")!;
    expect(reworkedPlan.generation).toBe(1);
    // Task is re-dispatched and running under generation 1
    expect(reworkedPlan.status).toBe("running");

    // 4. Complete plan generation 1
    const { proposal: p1, rawBytes: b1 } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan-gen1.md",
      content: "Plan gen 1 with detailed database schema"
    });
    const completeGen1 = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "plan",
      {
        status: "succeeded",
        summary: "Plan gen 1 completed with requested changes",
        proposals: [p1],
        contentByProposalId: { [p1.proposalId]: b1 }
      }
    );
    expect(completeGen1.ok).toBe(true);

    // Get new approval request id for gen 1
    const eventsGen1 = (await harness.runStore.readEvents(runId, { limit: 100 })).value!;
    const reqGen1 = eventsGen1.items.filter((e) => e.type === "approval.requested").at(-1);
    const approvalIdGen1 = (reqGen1?.payload as any).approvalId;
    expect(approvalIdGen1).not.toBe(approvalIdGen0);

    // 5. Approver approves generation 1
    const approveGen1 = await harness.service.decide({
      schemaVersion: 1,
      approvalId: approvalIdGen1,
      runId,
      target: { type: "task", taskId: "plan" },
      revision: 1,
      generation: 1,
      decision: "approved",
      decidedBy: "human_reviewer",
      decidedAt: new Date().toISOString(),
      feedbackArtifacts: [],
      idempotencyKey: `approve-${approvalIdGen1}`
    });
    expect(approveGen1.ok).toBe(true);
    expect(approveGen1.value.tasks.find((t: TaskState) => t.taskId === "implement")?.status).toBe("running");
  });

  it("PROBE PM-05: rejects stale approval decision with mismatched revision or generation", async () => {
    const definition = createApprovalWorkflow({ maxReworks: 2 });
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-probe-pm05-${randomUUID()}`;

    await harness.service.start({
      runId,
      definition,
      input: { requirement: "Stale approval probe" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });

    // Complete gen 0
    const { proposal, rawBytes } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Plan for stale check"
    });
    await harness.service.orchestrator.completeTaskExecution(
      runId,
      "plan",
      {
        status: "succeeded",
        summary: "Plan gen 0 done",
        proposals: [proposal],
        contentByProposalId: { [proposal.proposalId]: rawBytes }
      }
    );

    const events = (await harness.runStore.readEvents(runId, { limit: 100 })).value!;
    const req = events.items.find((e) => e.type === "approval.requested");
    const approvalId = (req?.payload as any).approvalId;

    // Attempt decision with wrong revision (revision 99 instead of 1)
    const staleRevisionDecision: ApprovalDecision = {
      schemaVersion: 1,
      approvalId,
      runId,
      target: { type: "task", taskId: "plan" },
      revision: 99, // STALE REVISION!
      generation: 0,
      decision: "approved",
      decidedBy: "human_operator",
      decidedAt: new Date().toISOString(),
      feedbackArtifacts: [],
      idempotencyKey: `decide-stale-rev-${approvalId}`
    };

    const staleRes = await harness.service.decide(staleRevisionDecision);
    // Core engine must strictly reject stale revision
    expect(staleRes.ok).toBe(false);
    expect(staleRes.error?.code).toBe("conflict");
    expect(staleRes.error?.message).toContain("stale");
  });
});
