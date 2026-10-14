import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSdlcWorkflowDefinition,
  createTestHarness
} from "../helpers/test-harness.js";

describe("Integration Scenario 2: Reviewer Rework & Bounded Rework Cycles (02-reviewer-rework.test.ts)", { timeout: 30000 }, () => {
  it("Test Case 2A: Single Rework Cycle — Reviewer requests changes on gen 0, implement gen 1 succeeds, review re-evaluates gen 1 and approves, QA passes, approval hold reached", async () => {
    const harness = await createTestHarness();
    try {
      const { service, transport } = harness;
      const runId = `run-rework-2a-${randomUUID()}`;
      const definition = createSdlcWorkflowDefinition({
        id: "workflow-rework-2a",
        maxReworks: 2,
        requiresApproval: true
      });

      // Start run
      const startRes = await service.startRun(definition, { runId });
      expect(startRes.ok).toBe(true);

      // 1. Step 1: plan succeeds (gen 0)
      const completePlan = await service.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        summary: "Architecture plan ready"
      });
      expect(completePlan.ok).toBe(true);

      // 2. Step 2: implement (gen 0) succeeds
      await service.orchestrator.driveRun(runId);
      expect(transport.getRequestForTask("implement", 1)?.taskId).toBe("implement");

      const completeImpl0 = await service.orchestrator.completeTaskExecution(runId, "implement", {
        status: "succeeded",
        summary: "Initial implementation completed"
      });
      expect(completeImpl0.ok).toBe(true);

      const snapBeforeReview = (await service.getRun(runId)).value!;
      const implBefore = snapBeforeReview.tasks.find((t) => t.taskId === "implement")!;
      expect(implBefore.status).toBe("succeeded");
      expect(implBefore.generation).toBe(0);

      // 3. Step 3: review (gen 0) returns changes_requested (Rework Cycle 1)
      await service.orchestrator.driveRun(runId);
      expect(transport.getRequestForTask("review", 1)?.taskId).toBe("review");

      const review1Res = await service.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        reviewDecision: "changes_requested",
        reviewReason: "Sanitize SQL queries to prevent injection attacks"
      });
      expect(review1Res.ok).toBe(true);

      // State Verification:
      // - implement task transitioned back to ready with generation 1
      // - review task transitioned back to ready with generation 1
      // - qa task remains pending and was NOT scheduled
      const snapAfterRework1 = (await service.getRun(runId)).value!;
      const implState1 = snapAfterRework1.tasks.find((t) => t.taskId === "implement")!;
      const reviewState1 = snapAfterRework1.tasks.find((t) => t.taskId === "review")!;
      const qaState1 = snapAfterRework1.tasks.find((t) => t.taskId === "qa")!;

      expect(implState1.status).toBe("ready");
      expect(implState1.generation).toBe(1);
      expect(reviewState1.status).toBe("ready");
      expect(reviewState1.generation).toBe(1);
      expect(qaState1.status).toBe("pending");
      expect(qaState1.generation).toBe(0);

      // 4. Drive Run: Dispatches implement (gen 1) to Developer
      await service.orchestrator.driveRun(runId);

      const activeExec = service.dispatcher.getActiveExecution(runId, "implement");
      expect(activeExec).toBeDefined();
      expect(service.dispatcher.getActiveExecution(runId, "review")).toBeUndefined();
      expect(service.dispatcher.getActiveExecution(runId, "qa")).toBeUndefined();

      // Developer completes rework for gen 1
      const completeImpl1 = await service.orchestrator.completeTaskExecution(runId, "implement", {
        status: "succeeded",
        summary: "Sanitized all SQL queries with parameterized bindings"
      });
      expect(completeImpl1.ok).toBe(true);

      const snapAfterImpl1 = (await service.getRun(runId)).value!;
      const implFinished1 = snapAfterImpl1.tasks.find((t) => t.taskId === "implement")!;
      expect(implFinished1.status).toBe("succeeded");
      expect(implFinished1.generation).toBe(1);

      // 5. Drive Run: Dispatches review (gen 1) to Reviewer for Re-Evaluation
      await service.orchestrator.driveRun(runId);
      expect(service.dispatcher.getActiveExecution(runId, "review")).toBeDefined();
      expect(service.dispatcher.getActiveExecution(runId, "qa")).toBeUndefined();

      // Reviewer approves gen 1
      const completeReview1 = await service.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        reviewDecision: "approved",
        reviewReason: "Parameterized queries verified; security criteria met"
      });
      expect(completeReview1.ok).toBe(true);

      const snapAfterReviewApprove = (await service.getRun(runId)).value!;
      const reviewFinished1 = snapAfterReviewApprove.tasks.find((t) => t.taskId === "review")!;
      expect(reviewFinished1.status).toBe("succeeded");
      expect(reviewFinished1.generation).toBe(1);

      // 6. Drive Run: Now and ONLY now is qa scheduled and dispatched!
      await service.orchestrator.driveRun(runId);
      expect(service.dispatcher.getActiveExecution(runId, "qa")).toBeDefined();

      const completeQa = await service.orchestrator.completeTaskExecution(runId, "qa", {
        status: "succeeded",
        summary: "All acceptance tests passing with zero regressions"
      });
      expect(completeQa.ok).toBe(true);

      // 7. Verify pre-merge approval hold reached
      const holdSnapshot = (await service.getRun(runId)).value!;
      expect(holdSnapshot.status).toBe("waiting");

      // Verify handoff report records generation 1 for implement & review
      const handoffReportRes = await harness.artifactStore.resolve(`report-${runId}-handoff`);
      expect(handoffReportRes.ok).toBe(true);

      // 8. Operator approves -> run terminates with status 'succeeded'
      const approveRes = await service.approve(runId, {
        decidedBy: "operator_alex",
        decision: "approved",
        reason: "Rework verified and signed off"
      });
      expect(approveRes.ok).toBe(true);
      expect(approveRes.value.status).toBe("succeeded");

      const finalSnap = (await service.getRun(runId)).value!;
      expect(finalSnap.status).toBe("succeeded");
      expect(finalSnap.tasks.find((t) => t.taskId === "implement")?.generation).toBe(1);
      expect(finalSnap.tasks.find((t) => t.taskId === "review")?.generation).toBe(1);
      expect(finalSnap.tasks.find((t) => t.taskId === "qa")?.generation).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("Test Case 2B: Multi-Cycle Rework — Dual changes_requested cycles (gen 1 & gen 2), re-evaluated and succeeds on generation 2", async () => {
    const harness = await createTestHarness();
    try {
      const { service, transport } = harness;
      const runId = `run-rework-2b-${randomUUID()}`;
      const definition = createSdlcWorkflowDefinition({
        id: "workflow-rework-2b",
        maxReworks: 2,
        requiresApproval: true
      });

      await service.startRun(definition, { runId });

      // Plan succeeds
      await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

      // Implement gen 0 succeeds
      await service.orchestrator.driveRun(runId);
      await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

      // Review gen 0 -> changes_requested (Rework Cycle 1)
      await service.orchestrator.driveRun(runId);
      const rework1Res = await service.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        reviewDecision: "changes_requested",
        reviewReason: "Rework 1: Handle null pointer in token validation"
      });
      expect(rework1Res.ok).toBe(true);

      const snapGen1 = (await service.getRun(runId)).value!;
      expect(snapGen1.tasks.find((t) => t.taskId === "implement")?.generation).toBe(1);
      expect(snapGen1.tasks.find((t) => t.taskId === "review")?.generation).toBe(1);

      // Implement gen 1 succeeds
      await service.orchestrator.driveRun(runId);
      await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

      // Review gen 1 -> changes_requested (Rework Cycle 2)
      await service.orchestrator.driveRun(runId);
      const rework2Res = await service.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        reviewDecision: "changes_requested",
        reviewReason: "Rework 2: Add missing test cases for edge-case tokens"
      });
      expect(rework2Res.ok).toBe(true);

      const snapGen2 = (await service.getRun(runId)).value!;
      expect(snapGen2.tasks.find((t) => t.taskId === "implement")?.generation).toBe(2);
      expect(snapGen2.tasks.find((t) => t.taskId === "review")?.generation).toBe(2);
      expect(snapGen2.tasks.find((t) => t.taskId === "qa")?.status).toBe("pending");

      // Implement gen 2 succeeds
      await service.orchestrator.driveRun(runId);
      await service.orchestrator.completeTaskExecution(runId, "implement", {
        status: "succeeded",
        summary: "Implemented comprehensive test coverage for all edge cases"
      });

      // Review gen 2 re-evaluates and APPROVES!
      await service.orchestrator.driveRun(runId);
      const reviewApprove2 = await service.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        reviewDecision: "approved",
        reviewReason: "All edge-case tests verified; approved on generation 2"
      });
      expect(reviewApprove2.ok).toBe(true);

      // QA executes and succeeds
      await service.orchestrator.driveRun(runId);
      expect(service.dispatcher.getActiveExecution(runId, "qa")).toBeDefined();
      await service.orchestrator.completeTaskExecution(runId, "qa", { status: "succeeded" });

      // Pre-merge approval reached
      const holdSnap = (await service.getRun(runId)).value!;
      expect(holdSnap.status).toBe("waiting");

      // Operator signs off
      const signOff = await service.approve(runId, {
        decidedBy: "rachel_qa_lead",
        decision: "approved",
        reason: "Dual rework cycle passed all gates"
      });
      expect(signOff.ok).toBe(true);
      expect(signOff.value.status).toBe("succeeded");

      const finalSnap = (await service.getRun(runId)).value!;
      expect(finalSnap.status).toBe("succeeded");
      expect(finalSnap.tasks.find((t) => t.taskId === "implement")?.generation).toBe(2);
      expect(finalSnap.tasks.find((t) => t.taskId === "review")?.generation).toBe(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("Test Case 2C: Rework Limit Exhaustion (maxReworks: 2) — Review returns changes_requested on gen 2, review is marked blocked (manual_intervention), driveRun halts immediately, run cannot advance without operator action", async () => {
    const harness = await createTestHarness();
    try {
      const { service, transport } = harness;
      const runId = `run-rework-exhaust-${randomUUID()}`;
      const definition = createSdlcWorkflowDefinition({
        id: "workflow-rework-exhaust",
        maxReworks: 2,
        requiresApproval: true
      });

      await service.startRun(definition, { runId });

      // Plan succeeds
      await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

      // Cycle 0: implement (0) succeeds -> review (0) changes_requested -> gen 1
      await service.orchestrator.driveRun(runId);
      await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
      await service.orchestrator.driveRun(runId);
      await service.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        reviewDecision: "changes_requested",
        reviewReason: "Rework 1: Fix interface signature"
      });

      // Cycle 1: implement (1) succeeds -> review (1) changes_requested -> gen 2
      await service.orchestrator.driveRun(runId);
      await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
      await service.orchestrator.driveRun(runId);
      await service.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        reviewDecision: "changes_requested",
        reviewReason: "Rework 2: Fix remaining type error"
      });

      // Implement (2) succeeds
      await service.orchestrator.driveRun(runId);
      await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

      // Cycle 2: Reviewer (gen 2) encounters failing criteria again -> Rework limit (maxReworks: 2) is EXHAUSTED!
      await service.orchestrator.driveRun(runId);
      expect(transport.getRequestForTask("review")?.taskId).toBe("review");

      const completeExhausted = await service.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        reviewDecision: "changes_requested",
        reviewReason: "Fundamental design flaw; 2 rework iterations exhausted"
      });
      expect(completeExhausted.ok).toBe(true);

      // Verify that 'review' task is marked 'blocked' with blockage code 'manual_intervention'
      const snapAfterExhaustion = (await service.getRun(runId)).value!;
      const reviewExhausted = snapAfterExhaustion.tasks.find((t) => t.taskId === "review")!;
      expect(reviewExhausted.status).toBe("blocked");
      expect(reviewExhausted.blockage).toBeDefined();
      expect(reviewExhausted.blockage?.code).toBe("manual_intervention");
      expect(reviewExhausted.blockage?.retryable).toBe(false);

      // Verify qa was never scheduled and remains pending
      const qaState = snapAfterExhaustion.tasks.find((t) => t.taskId === "qa")!;
      expect(qaState.status).toBe("pending");

      // Verify driveRun immediately halts and returns 'blocked' run snapshot
      const driveHaltRes = await service.orchestrator.driveRun(runId);
      expect(driveHaltRes.ok).toBe(true);
      expect(driveHaltRes.value?.status).toBe("blocked");

      // Subsequent driveRun calls also return immediately at 'blocked'
      const driveAgainRes = await service.orchestrator.driveRun(runId);
      expect(driveAgainRes.ok).toBe(true);
      expect(driveAgainRes.value?.status).toBe("blocked");

      // Verify no active executions remain in dispatcher (all leases released)
      expect(service.dispatcher.getActiveExecution(runId, "review")).toBeUndefined();
      expect(service.dispatcher.getActiveExecution(runId, "implement")).toBeUndefined();
      expect(service.dispatcher.getActiveExecution(runId, "qa")).toBeUndefined();

      // Verify run cannot advance without operator action
      const statusRes = await service.getRunStatus(runId);
      expect(statusRes.ok).toBe(true);
      expect(statusRes.value?.status).toBe("blocked");
    } finally {
      await harness.cleanup();
    }
  });
});
