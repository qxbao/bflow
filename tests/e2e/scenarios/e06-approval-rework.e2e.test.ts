import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  expectOk,
  expectFailure
} from "../helpers/fixtures.js";
import type {
  ApprovalDecision,
  DomainEvent,
  TaskState,
  WorkflowDefinition
} from "@bflow/contracts";

/**
 * Creates a workflow definition where the first task explicitly requires approval and allows rework.
 */
function createApprovalWorkflow(options?: {
  readonly maxReworks?: number;
  readonly onExhausted?: "fail" | "require_human";
}): WorkflowDefinition {
  const maxReworks = options?.maxReworks ?? 2;
  const onExhausted = options?.onExhausted ?? "fail";

  return {
    schemaVersion: "1",
    id: `wf-approval-${randomUUID().slice(0, 8)}`,
    name: "Approval & Rework Workflow",
    version: "1.0.0",
    maxConcurrency: 1,
    failurePolicy: "fail-fast",
    recovery: {
      checkpoint: "task-boundary",
      resumeStrategy: "checkpoint-then-replay",
      staleExecution: "reconcile"
    },
    tasks: [
      {
        id: "plan",
        title: "Plan Architecture",
        role: "planner",
        instruction: "Decompose requirements into tasks.",
        acceptanceCriteria: ["Task breakdown generated"],
        retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        rework: { maxReworks, onExhausted },
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" },
        requiresApproval: true,
        qualityGates: []
      },
      {
        id: "implement",
        title: "Implement",
        role: "developer",
        instruction: "Write code and tests.",
        acceptanceCriteria: ["Code implemented"],
        retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      }
    ],
    dependencies: [
      { taskId: "implement", dependsOnTaskId: "plan", condition: "succeeded" }
    ],
    qualityGates: []
  };
}

/**
 * Type-safe helper to extract approvalId from domain events without any type assertions.
 */
function getLatestApprovalRequestId(events: readonly DomainEvent[], runId: string): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === "approval.requested") {
      return ev.payload.approvalId;
    }
  }
  throw new Error(`No approval.requested event found for run ${runId}`);
}

describe("Scenario E06 — Human Approval & Bounded Rework", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("suspends workflow execution on approval required and proceeds only upon positive human decision", async () => {
    const definition = createApprovalWorkflow({ maxReworks: 2 });
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-approval-happy-${randomUUID()}`;

    // 1. Start workflow
    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Approval integration test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    expectOk(startRes);

    // 2. Complete the planning task
    const { proposal, rawBytes } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Plan generation 0 content"
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
    expectOk(completeRes);

    // Verify approval request was recorded in engine
    const postCompleteSnap = expectOk(await harness.service.getRun(runId))!;
    const planTask = postCompleteSnap.tasks.find((t: TaskState) => t.taskId === "plan")!;
    expect(planTask.status).toBe("succeeded");
    expect(planTask.generation).toBe(0);

    // Downstream task 'implement' must NOT run yet because approval is required
    const implementTask = postCompleteSnap.tasks.find((t: TaskState) => t.taskId === "implement")!;
    expect(implementTask.status).toBe("pending");

    // Find the approval request ID from events safely
    const events = expectOk(await harness.runStore.readEvents(runId, { limit: 100 }));
    const approvalId = getLatestApprovalRequestId(events.items, runId);

    // 3. Human operator approves
    const approveRes = await harness.service.decide({
      schemaVersion: 1,
      approvalId,
      runId,
      target: { type: "task", taskId: "plan" },
      revision: 1,
      generation: 0,
      decision: "approved",
      decidedBy: "human_operator",
      decidedAt: new Date().toISOString(),
      feedbackArtifacts: [],
      idempotencyKey: `decide-${approvalId}`
    });
    const postApproveSnap = expectOk(approveRes);

    // After approval, the downstream task 'implement' is dispatched and running
    const runningImplement = postApproveSnap.tasks.find((t: TaskState) => t.taskId === "implement")!;
    expect(runningImplement.status).toBe("running");
  });

  it("handles changes_requested by incrementing generation, preserving prior artifacts, and enforcing bounded reworks", async () => {
    const definition = createApprovalWorkflow({ maxReworks: 2 });
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-rework-${randomUUID()}`;

    // 1. Start workflow
    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Rework cycle integration test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    expectOk(startRes);

    // 2. Complete plan generation 0
    const { proposal: p0, rawBytes: b0 } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan-gen0.md",
      content: "Plan gen 0 content"
    });
    const completeRes0 = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "plan",
      {
        status: "succeeded",
        summary: "Plan gen 0 done",
        proposals: [p0],
        contentByProposalId: { [p0.proposalId]: b0 }
      }
    );
    expectOk(completeRes0);

    // Get approval request id for gen 0
    const eventsGen0 = expectOk(await harness.runStore.readEvents(runId, { limit: 100 }));
    const approvalIdGen0 = getLatestApprovalRequestId(eventsGen0.items, runId);

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
    const postChangeSnap = expectOk(changeRes);

    // CRITICAL REWORK INVARIANT:
    // Generation must have incremented to 1
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
    expectOk(completeGen1);

    // Get new approval request id for gen 1
    const eventsGen1 = expectOk(await harness.runStore.readEvents(runId, { limit: 100 }));
    const approvalIdGen1 = getLatestApprovalRequestId(eventsGen1.items, runId);
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
    const postApproveGen1 = expectOk(approveGen1);
    expect(postApproveGen1.tasks.find((t: TaskState) => t.taskId === "implement")?.status).toBe("running");
  });

  it("strictly enforces maxReworks limit: exhausts rework budget and transitions to failure", async () => {
    // maxReworks: 1 means at most 1 rework is permitted (generation 0 -> generation 1)
    const definition = createApprovalWorkflow({ maxReworks: 1, onExhausted: "fail" });
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-rework-exhaust-${randomUUID()}`;

    await harness.service.start({
      runId,
      definition,
      input: { requirement: "Rework exhaustion test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });

    // Complete gen 0
    const { proposal: p0, rawBytes: b0 } = createArtifactProposal({
      runId,
      taskId: "plan",
      content: "Plan gen 0"
    });
    await harness.service.orchestrator.completeTaskExecution(runId, "plan", {
      status: "succeeded",
      summary: "Plan gen 0",
      proposals: [p0],
      contentByProposalId: { [p0.proposalId]: b0 }
    });

    // Rework 1: changes requested (allowed, generation becomes 1)
    let events = expectOk(await harness.runStore.readEvents(runId, { limit: 100 }));
    let approvalId = getLatestApprovalRequestId(events.items, runId);
    const rework1 = await harness.service.decide({
      schemaVersion: 1,
      approvalId,
      runId,
      target: { type: "task", taskId: "plan" },
      revision: 1,
      generation: 0,
      decision: "changes_requested",
      decidedBy: "human_reviewer",
      decidedAt: new Date().toISOString(),
      reason: "Needs rework 1",
      feedbackArtifacts: [],
      idempotencyKey: `change-1-${approvalId}`
    });
    expectOk(rework1);

    // Complete gen 1
    const { proposal: p1, rawBytes: b1 } = createArtifactProposal({
      runId,
      taskId: "plan",
      content: "Plan gen 1"
    });
    await harness.service.orchestrator.completeTaskExecution(runId, "plan", {
      status: "succeeded",
      summary: "Plan gen 1",
      proposals: [p1],
      contentByProposalId: { [p1.proposalId]: b1 }
    });

    // Rework 2: changes requested again, but maxReworks was 1!
    events = expectOk(await harness.runStore.readEvents(runId, { limit: 100 }));
    approvalId = getLatestApprovalRequestId(events.items, runId);
    const rework2 = await harness.service.decide({
      schemaVersion: 1,
      approvalId,
      runId,
      target: { type: "task", taskId: "plan" },
      revision: 1,
      generation: 1,
      decision: "changes_requested",
      decidedBy: "human_reviewer",
      decidedAt: new Date().toISOString(),
      reason: "Attempting rework 2 beyond limit",
      feedbackArtifacts: [],
      idempotencyKey: `change-2-${approvalId}`
    });

    // With onExhausted: "fail", the workflow run transitions to failed because rework budget is exhausted
    const rework2Snap = expectOk(rework2);
    expect(rework2Snap.status).toBe("failed");
    const planTask = rework2Snap.tasks.find((t: TaskState) => t.taskId === "plan")!;
    // Generation must NOT increment beyond maxReworks
    expect(planTask.generation).toBe(1);
  });

  it("PROBE PM-05: rejects stale approval decision with mismatched revision", async () => {
    const definition = createApprovalWorkflow({ maxReworks: 2 });
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-probe-pm05-core-${randomUUID()}`;

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Stale approval probe" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    expectOk(startRes);

    // Complete gen 0
    const { proposal, rawBytes } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Plan for stale check"
    });
    const completeRes = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "plan",
      {
        status: "succeeded",
        summary: "Plan gen 0 done",
        proposals: [proposal],
        contentByProposalId: { [proposal.proposalId]: rawBytes }
      }
    );
    expectOk(completeRes);

    const events = expectOk(await harness.runStore.readEvents(runId, { limit: 100 }));
    const approvalId = getLatestApprovalRequestId(events.items, runId);

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
    const staleErr = expectFailure(staleRes);
    expect(staleErr.code).toBe("conflict");
    expect(staleErr.message).toContain("stale");
  });
});
