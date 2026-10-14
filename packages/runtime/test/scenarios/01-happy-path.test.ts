import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ArtifactProposal,
  DomainEvent,
  WorkflowRunSnapshot
} from "@ai-flow/contracts";
import {
  createSdlcWorkflowDefinition,
  createTestHarness
} from "../helpers/test-harness.js";

describe("Integration Scenario 1: 11-Step SDLC Happy Path (01-happy-path.test.ts)", { timeout: 30000 }, () => {
  it("executes complete 11-step SDLC flow from start to operator pre-merge approval with full proposal ingestion, quality gates, and event stream watch", async () => {
    const harness = await createTestHarness();
    try {
      const { service, transport, qualityGate, artifactStore, runStore } = harness;

      // 1. Initialize RuntimeService
      const initRes = await service.init({
        runtimeId: "happy-path-runtime",
        configuration: { environment: "test-integration" }
      });
      expect(initRes.ok).toBe(true);

      const runId = `run-sdlc-${randomUUID()}`;
      const definition = createSdlcWorkflowDefinition({
        id: "feature-user-auth",
        requiresApproval: true,
        includeQualityGate: true
      });

      // 2. Start Domain Event Stream Watcher in background
      const collectedEvents: DomainEvent[] = [];
      const watchAbort = new AbortController();
      const watchPromise = (async () => {
        try {
          const stream = service.watch(runId, { signal: watchAbort.signal });
          for await (const eventResult of stream) {
            if (eventResult.ok) {
              collectedEvents.push(eventResult.value);
            }
          }
        } catch {
          // Expected on abort
        }
      })();

      // 3. Step 1: Start Workflow Run
      const startRes = await service.startRun(definition, {
        runId,
        input: { ticket: "SDLC-101", title: "OAuth2 Authentication Support" },
        metadata: { priority: "high", author: "team-core" }
      });
      expect(startRes.ok).toBe(true);
      if (!startRes.ok) return;

      const initialSnapshot = startRes.value;
      expect(initialSnapshot.runId).toBe(runId);
      expect(initialSnapshot.workflowId).toBe(definition.id);
      expect(initialSnapshot.status).toBe("running");

      // Verify that 'plan' task was automatically scheduled and dispatched
      const planRequest = transport.getRequestForTask("plan");
      expect(planRequest).toBeDefined();
      expect(planRequest?.role).toBe("planner");
      expect(planRequest?.attempt).toBe(1);
      expect(planRequest?.metadata?.fencingToken).toBeGreaterThan(0);

      // Verify task 'plan' status is 'running' with bound agent execution
      const snapAfterPlanDispatch = (await service.getRun(runId)).value!;
      const planState = snapAfterPlanDispatch.tasks.find((t) => t.taskId === "plan")!;
      expect(planState.status).toBe("running");
      expect(planState.agentExecution).toBeDefined();

      // 4. Step 2: Complete 'plan' task with Architecture & Spec Proposal
      const specContent = "# Architecture Specification: OAuth2 Authentication\n\n1. Abstract\n2. Grant Types\n";
      const specBytes = Buffer.from(specContent, "utf8");
      const specSha256 = createHash("sha256").update(specBytes).digest("hex");
      const specProposalId = `prop-spec-${randomUUID()}`;

      const specProposal: ArtifactProposal = {
        proposalId: specProposalId,
        runId,
        taskId: "plan",
        kind: "document",
        logicalName: "oauth2-spec.md",
        mediaType: "text/markdown",
        expectedIntegrity: {
          sizeBytes: specBytes.byteLength,
          checksum: { algorithm: "sha256", value: specSha256 }
        }
      };

      const completePlanRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        summary: "Architecture specification drafted and validated",
        proposals: [specProposal],
        contentByProposalId: { [specProposalId]: specContent }
      });
      expect(completePlanRes.ok).toBe(true);

      // Verify spec proposal was ingested into ArtifactStore with verified trust
      const resolvedSpec = await artifactStore.resolve(specProposalId);
      expect(resolvedSpec.ok).toBe(true);
      expect(resolvedSpec.value?.artifactId).toBe(specProposalId);
      expect(resolvedSpec.value?.trust).toBe("stored");

      // 5. Steps 3, 4, 5: Schedule and Dispatch 'implement' Task
      const driveImplRes = await service.orchestrator.driveRun(runId);
      expect(driveImplRes.ok).toBe(true);

      const implementRequest = transport.getRequestForTask("implement");
      expect(implementRequest).toBeDefined();
      expect(implementRequest?.role).toBe("developer");
      expect(implementRequest?.metadata?.fencingToken).toBeGreaterThan(0);

      const snapAfterImplDispatch = (await service.getRun(runId)).value!;
      const implementState = snapAfterImplDispatch.tasks.find((t) => t.taskId === "implement")!;
      expect(implementState.status).toBe("running");

      // 6. Step 6: Complete 'implement' Task with Code Patch Proposal & Quality Gate Evaluation
      const patchContent = "diff --git a/auth.ts b/auth.ts\n+export function authenticate() { return true; }\n";
      const patchBytes = Buffer.from(patchContent, "utf8");
      const patchSha256 = createHash("sha256").update(patchBytes).digest("hex");
      const patchProposalId = `prop-patch-${randomUUID()}`;

      const patchProposal: ArtifactProposal = {
        proposalId: patchProposalId,
        runId,
        taskId: "implement",
        kind: "patch",
        logicalName: "oauth2.patch",
        mediaType: "text/x-diff",
        expectedIntegrity: {
          sizeBytes: patchBytes.byteLength,
          checksum: { algorithm: "sha256", value: patchSha256 }
        }
      };

      const completeImplRes = await service.orchestrator.completeTaskExecution(runId, "implement", {
        status: "succeeded",
        summary: "Implemented OAuth2 token validation and user session handler",
        proposals: [patchProposal],
        contentByProposalId: { [patchProposalId]: patchContent }
      });
      expect(completeImplRes.ok).toBe(true);

      // Verify patch proposal was ingested into ArtifactStore
      const resolvedPatch = await artifactStore.resolve(patchProposalId);
      expect(resolvedPatch.ok).toBe(true);
      expect(resolvedPatch.value?.trust).toBe("stored");

      // Verify Automated Quality Gate evaluated ('after_result' phase)
      expect(qualityGate.evaluatedContexts.length).toBeGreaterThanOrEqual(1);
      const gateContext = qualityGate.evaluatedContexts.find(
        (ctx) => ctx.runId === runId && ctx.taskId === "implement"
      );
      expect(gateContext).toBeDefined();
      expect(gateContext?.definition.id).toBe("unit-tests-gate");

      // 7. Steps 7 & 8: Schedule, Dispatch, and Approve 'review' Task
      const driveReviewRes = await service.orchestrator.driveRun(runId);
      expect(driveReviewRes.ok).toBe(true);

      const reviewRequest = transport.getRequestForTask("review");
      expect(reviewRequest).toBeDefined();
      expect(reviewRequest?.role).toBe("reviewer");

      const reviewNotesContent = "# Code Review: Approved\n\nCode quality high; security checks passed.";
      const reviewBytes = Buffer.from(reviewNotesContent, "utf8");
      const reviewSha256 = createHash("sha256").update(reviewBytes).digest("hex");
      const reviewProposalId = `prop-review-${randomUUID()}`;

      const reviewProposal: ArtifactProposal = {
        proposalId: reviewProposalId,
        runId,
        taskId: "review",
        kind: "document",
        logicalName: "review-notes.md",
        mediaType: "text/markdown",
        expectedIntegrity: {
          sizeBytes: reviewBytes.byteLength,
          checksum: { algorithm: "sha256", value: reviewSha256 }
        }
      };

      const completeReviewRes = await service.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        summary: "Review completed; patch approved without changes",
        reviewDecision: "approved",
        reviewReason: "Security and formatting compliance verified",
        proposals: [reviewProposal],
        contentByProposalId: { [reviewProposalId]: reviewNotesContent }
      });
      expect(completeReviewRes.ok).toBe(true);

      // Verify review proposal ingested
      const resolvedReview = await artifactStore.resolve(reviewProposalId);
      expect(resolvedReview.ok).toBe(true);

      // 8. Step 9: Schedule, Dispatch, and Complete 'qa' Task
      const driveQaRes = await service.orchestrator.driveRun(runId);
      expect(driveQaRes.ok).toBe(true);

      const qaRequest = transport.getRequestForTask("qa");
      expect(qaRequest).toBeDefined();
      expect(qaRequest?.role).toBe("qa");

      const qaReportContent = JSON.stringify({ totalTests: 42, passed: 42, failed: 0, durationMs: 1200 });
      const qaBytes = Buffer.from(qaReportContent, "utf8");
      const qaSha256 = createHash("sha256").update(qaBytes).digest("hex");
      const qaProposalId = `prop-qa-${randomUUID()}`;

      const qaProposal: ArtifactProposal = {
        proposalId: qaProposalId,
        runId,
        taskId: "qa",
        kind: "report",
        logicalName: "acceptance-report.json",
        mediaType: "application/json",
        expectedIntegrity: {
          sizeBytes: qaBytes.byteLength,
          checksum: { algorithm: "sha256", value: qaSha256 }
        }
      };

      // Completing 'qa' task (which has requiresApproval: true) transitions run into waiting
      const completeQaRes = await service.orchestrator.completeTaskExecution(runId, "qa", {
        status: "succeeded",
        summary: "All 42 end-to-end acceptance test suites passed",
        proposals: [qaProposal],
        contentByProposalId: { [qaProposalId]: qaReportContent }
      });
      expect(completeQaRes.ok).toBe(true);

      // 9. Step 10: Verify Structured Handoff Report Persisted & Checkpoint Saved
      const handoffReportArtifactId = `report-${runId}-handoff`;
      const handoffReportRes = await artifactStore.resolve(handoffReportArtifactId);
      expect(handoffReportRes.ok).toBe(true);
      expect(handoffReportRes.value?.kind).toBe("report");

      // Verify handoff report stream content
      expect(handoffReportRes.value).not.toBeNull();
      let contentStr = "";
      for await (const chunkRes of artifactStore.get(handoffReportRes.value!)) {
        expect(chunkRes.ok).toBe(true);
        if (chunkRes.ok) {
          contentStr += Buffer.from(chunkRes.value).toString("utf8");
        }
      }
        expect(contentStr).toContain(`# AI Flow SDLC — Structured Handoff Report`);
        expect(contentStr).toContain(`**Run ID**: \`${runId}\``);
        expect(contentStr).toContain(`| plan | succeeded |`);
        expect(contentStr).toContain(`| implement | succeeded |`);
        expect(contentStr).toContain(`| review | succeeded |`);
        expect(contentStr).toContain(`| qa | succeeded |`);
        expect(contentStr).toContain(`Human Sign-off Required`);

      // Verify aggregate checkpoint was saved in RunStore
      const checkpointRes = await runStore.loadLatestCheckpoint(runId);
      expect(checkpointRes.ok).toBe(true);
      expect(checkpointRes.value).not.toBeNull();
      expect(checkpointRes.value?.runId).toBe(runId);

      // 10. Step 11: Pre-Merge Approval Hold (waiting_for_approval)
      const waitingSnapshot = (await service.getRun(runId)).value!;
      expect(waitingSnapshot.status).toBe("waiting");

      // Verify automated / AI self-approval is REJECTED
      const aiApprovalRes = await service.approve(runId, {
        decidedBy: "agent-qa-bot",
        decision: "approved",
        reason: "Auto-approve from bot"
      });
      expect(aiApprovalRes.ok).toBe(false);
      if (!aiApprovalRes.ok) {
        expect(aiApprovalRes.error.code).toBe("validation");
        expect(aiApprovalRes.error.message).toContain("Mandatory human approval cannot be satisfied");
      }

      // Verify human operator approval SUCCEEDS and advances run to 'succeeded'
      const humanApprovalRes = await service.approve(runId, {
        decidedBy: "lead_architect_sarah",
        decision: "approved",
        reason: "Code reviewed, QA suites green, approved for production merge"
      });
      expect(humanApprovalRes.ok).toBe(true);
      if (humanApprovalRes.ok) {
        expect(humanApprovalRes.value.status).toBe("succeeded");
      }

      // Verify final snapshot from service
      const finalSnapshotRes = await service.getRun(runId);
      expect(finalSnapshotRes.ok).toBe(true);
      const finalSnapshot = finalSnapshotRes.value!;
      expect(finalSnapshot.status).toBe("succeeded");
      for (const task of finalSnapshot.tasks) {
        expect(task.status).toBe("succeeded");
        expect(task.generation).toBe(0);
      }

      // 11. Domain Event Stream Verification (watch)
      // Stop watch stream
      watchAbort.abort();
      await watchPromise;

      expect(collectedEvents.length).toBeGreaterThanOrEqual(15);
      const eventTypes = collectedEvents.map((e) => e.type);

      // Verify sequence of key milestone domain events
      expect(eventTypes).toContain("run.created");
      expect(eventTypes).toContain("run.status_changed");
      expect(eventTypes).toContain("task.status_changed");
      expect(eventTypes).toContain("agent.execution_bound");
      expect(eventTypes).toContain("agent.result_recorded");
      expect(eventTypes).toContain("quality_gate.evaluation_requested");
      expect(eventTypes).toContain("quality_gate.evaluated");
      expect(eventTypes).toContain("approval.requested");
      expect(eventTypes).toContain("approval.decided");

      // Verify sequence monotonicity without gaps
      for (let i = 0; i < collectedEvents.length; i++) {
        expect(collectedEvents[i].sequence).toBe(i + 1);
        expect(collectedEvents[i].runId).toBe(runId);
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("strictly validates SHA-256 and byte length during proposal ingestion and rejects corrupted proposals without store corruption", async () => {
    const harness = await createTestHarness();
    try {
      const { service, artifactStore } = harness;
      const runId = `run-tamper-${randomUUID()}`;
      const definition = createSdlcWorkflowDefinition({ id: "tamper-test" });

      await service.startRun(definition, { runId });

      // Proposal with incorrect checksum
      const content = "legitimate code content";
      const bytes = Buffer.from(content, "utf8");
      const badChecksum = "0000000000000000000000000000000000000000000000000000000000000000";
      const badProposal: ArtifactProposal = {
        proposalId: "prop-tampered",
        runId,
        taskId: "plan",
        kind: "document",
        logicalName: "spec.md",
        mediaType: "text/markdown",
        expectedIntegrity: {
          sizeBytes: bytes.byteLength,
          checksum: { algorithm: "sha256", value: badChecksum }
        }
      };

      const failRes = await service.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        proposals: [badProposal],
        contentByProposalId: { "prop-tampered": content }
      });

      expect(failRes.ok).toBe(false);
      if (!failRes.ok) {
        expect(failRes.error.code).toBe("validation");
        expect(failRes.error.message).toContain("Checksum mismatch");
      }

      // Verify ArtifactStore was not corrupted
      const checkRes = await artifactStore.resolve("prop-tampered");
      expect(checkRes.ok).toBe(true);
      expect(checkRes.value).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});
