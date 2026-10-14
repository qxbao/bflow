import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ArtifactProposal } from "@ai-flow/contracts";
import { TaskDispatcher } from "../../src/dispatcher.js";
import {
  ingestArtifactProposals,
  isHumanApprover,
  SdlcWorkflowOrchestrator
} from "../../src/orchestrator.js";
import {
  createSampleWorkflowDefinition,
  createTestHarness
} from "./fixtures.js";

describe("SdlcWorkflowOrchestrator", { timeout: 30000 }, () => {
  describe("isHumanApprover", () => {
    it("identifies human operators and rejects automated AI agents", () => {
      expect(isHumanApprover("alice_smith")).toBe(true);
      expect(isHumanApprover("lead_architect")).toBe(true);
      expect(isHumanApprover("human_operator")).toBe(true);

      expect(isHumanApprover("")).toBe(false);
      expect(isHumanApprover("agent-developer")).toBe(false);
      expect(isHumanApprover("ai_reviewer")).toBe(false);
      expect(isHumanApprover("bot-qa")).toBe(false);
      expect(isHumanApprover("system")).toBe(false);
      expect(isHumanApprover("planner_bot")).toBe(false);
    });

    it("rejects modern AI LLM names and versions", () => {
      const aiNames = [
        "claude", "claude-3-opus", "claude-3.5-sonnet",
        "chatgpt", "chatgpt-4", "gpt-4", "gpt-4o", "gpt4",
        "copilot", "gemini", "assistant", "deepseek-coder",
        "llama-3", "mistral-large"
      ];
      for (const name of aiNames) {
        expect(isHumanApprover(name)).toBe(false);
      }

      const humanNames = [
        "alice_smith", "lead_architect", "human_operator",
        "alice@company.com", "bob-jones"
      ];
      for (const name of humanNames) {
        expect(isHumanApprover(name)).toBe(true);
      }
    });
  });

  describe("ingestArtifactProposals", () => {
    it("validates size and checksum before storing into ArtifactStore", async () => {
      const harness = await createTestHarness();
      try {
        const content = "export const answer = 42;\n";
        const bytes = Buffer.from(content, "utf8");
        const sha256 = createHash("sha256").update(bytes).digest("hex");

        const proposal: ArtifactProposal = {
          proposalId: "prop-patch-1",
          runId: "run-ingest-1",
          taskId: "implement",
          kind: "patch",
          logicalName: "patch.diff",
          mediaType: "text/plain",
          expectedIntegrity: {
            sizeBytes: bytes.byteLength,
            checksum: { algorithm: "sha256", value: sha256 }
          }
        };

        const result = await ingestArtifactProposals(
          harness.artifactStore,
          [proposal],
          { "prop-patch-1": content }
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value).toHaveLength(1);
        const ref = result.value[0];
        expect(ref.artifactId).toBe("prop-patch-1");
        expect(ref.kind).toBe("patch");
        expect(ref.trust).toBe("stored");

        // Verify resolvable from ArtifactStore
        const resolveRes = await harness.artifactStore.resolve("prop-patch-1");
        expect(resolveRes.ok).toBe(true);
        expect(resolveRes.value?.artifactId).toBe("prop-patch-1");
      } finally {
        await harness.cleanup();
      }
    });

    it("rejects proposal on checksum mismatch", async () => {
      const harness = await createTestHarness();
      try {
        const content = "tampered content";
        const proposal: ArtifactProposal = {
          proposalId: "prop-tampered",
          runId: "run-ingest-1",
          kind: "document",
          logicalName: "doc.txt",
          mediaType: "text/plain",
          expectedIntegrity: {
            sizeBytes: Buffer.byteLength(content),
            checksum: { algorithm: "sha256", value: "0000000000000000000000000000000000000000000000000000000000000000" }
          }
        };

        const result = await ingestArtifactProposals(
          harness.artifactStore,
          [proposal],
          { "prop-tampered": content }
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe("validation");
          expect(result.error.message).toContain("Checksum mismatch");
        }
      } finally {
        await harness.cleanup();
      }
    });
  });

  describe("bounded rework loop", () => {
    it("routes changes_requested back to target task and increments generation", async () => {
      const harness = await createTestHarness();
      try {
        const definition = createSampleWorkflowDefinition();
        const runId = "run-rework-1";
        const requestedAt = new Date().toISOString();

        await harness.engine.validateDefinition(definition);
        const createRes = await harness.engine.createRun({ runId, definition, idempotencyKey: "c", createdAt: requestedAt });
        if (!createRes.ok) throw new Error("createRun failed");

        await harness.runStore.create({ snapshot: createRes.value.snapshot, definition }, "s");
        await harness.runStore.appendEvents({
          runId,
          expectedVersion: 0,
          expectedLastSequence: 0,
          events: createRes.value.emittedEvents,
          idempotencyKey: "e"
        });

        const dispatcher = new TaskDispatcher({
          engine: harness.engine,
          runStore: harness.runStore,
          agentRegistry: harness.agentRegistry,
          transport: harness.transport
        });

        const orchestrator = new SdlcWorkflowOrchestrator(
          {
            engine: harness.engine,
            runStore: harness.runStore,
            artifactStore: harness.artifactStore
          },
          dispatcher
        );

        // Step 1: Execute 'plan'
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

        // Step 2: Execute 'implement'
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        const snapBeforeReview = (await harness.engine.getSnapshot(runId)).value!;
        const implementBefore = snapBeforeReview.tasks.find((t) => t.taskId === "implement")!;
        expect(implementBefore.status).toBe("succeeded");
        expect(implementBefore.generation).toBe(0);

        // Step 3: Execute 'review' which requests changes
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Fix typo in variable name"
        });

        const snapAfterReview = (await harness.engine.getSnapshot(runId)).value!;
        const implementAfter = snapAfterReview.tasks.find((t) => t.taskId === "implement")!;

        // Implement should have transitioned back to ready with generation 1!
        expect(implementAfter.status).toBe("ready");
        expect(implementAfter.generation).toBe(1);
      } finally {
        await harness.cleanup();
      }
    });
  });

  describe("pre-merge human approval pause", { timeout: 30000 }, () => {
    it("pauses in waiting_for_approval and requires human sign-off", async () => {
      const harness = await createTestHarness();
      try {
        const definition = createSampleWorkflowDefinition({ requiresApproval: true });
        const runId = "run-approval-pause-1";
        const requestedAt = new Date().toISOString();

        await harness.engine.validateDefinition(definition);
        const createRes = await harness.engine.createRun({ runId, definition, idempotencyKey: "c", createdAt: requestedAt });
        if (!createRes.ok) throw new Error("createRun failed");

        await harness.runStore.create({ snapshot: createRes.value.snapshot, definition }, "s");
        await harness.runStore.appendEvents({
          runId,
          expectedVersion: 0,
          expectedLastSequence: 0,
          events: createRes.value.emittedEvents,
          idempotencyKey: "e"
        });

        const dispatcher = new TaskDispatcher({
          engine: harness.engine,
          runStore: harness.runStore,
          agentRegistry: harness.agentRegistry,
          transport: harness.transport
        });

        const orchestrator = new SdlcWorkflowOrchestrator(
          {
            engine: harness.engine,
            runStore: harness.runStore,
            artifactStore: harness.artifactStore
          },
          dispatcher
        );

        // Step 1: plan
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

        // Step 2: implement
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // Step 3: review
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", { status: "succeeded", reviewDecision: "approved" });

        // Step 4: qa (requires approval)
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "qa", { status: "succeeded" });

        // Run should now be paused in 'waiting'
        const pausedSnap = (await harness.engine.getSnapshot(runId)).value!;
        expect(pausedSnap.status).toBe("waiting");

        // Verify Handoff Report was generated and saved in ArtifactStore
        const reportRes = await harness.artifactStore.resolve(`report-${runId}-handoff`);
        expect(reportRes.ok).toBe(true);
        expect(reportRes.value?.artifactId).toBe(`report-${runId}-handoff`);

        // Attempt AI self-approval: should be REJECTED!
        const aiApprovalRes = await orchestrator.applyApprovalDecision({
          schemaVersion: 1,
          approvalId: "appr-ai-1",
          runId,
          target: { type: "task", taskId: "qa" },
          revision: 1,
          generation: 0,
          decision: "approved",
          decidedBy: "agent_qa_bot", // AI agent actor!
          decidedAt: new Date().toISOString(),
          feedbackArtifacts: [],
          idempotencyKey: "ai-appr"
        });
        expect(aiApprovalRes.ok).toBe(false);
        if (!aiApprovalRes.ok) {
          expect(aiApprovalRes.error.code).toBe("validation");
          expect(aiApprovalRes.error.message).toContain("Mandatory human approval cannot be satisfied");
        }

        // Human approval: should SUCCEED and bridge waiting -> running -> succeeded!
        const humanApprovalRes = await orchestrator.applyApprovalDecision({
          schemaVersion: 1,
          approvalId: "appr-human-1",
          runId,
          target: { type: "task", taskId: "qa" },
          revision: 1,
          generation: 0,
          decision: "approved",
          decidedBy: "alice_release_manager",
          decidedAt: new Date().toISOString(),
          feedbackArtifacts: [],
          idempotencyKey: "human-appr"
        });
        expect(humanApprovalRes.ok).toBe(true);
        if (humanApprovalRes.ok) {
          expect(humanApprovalRes.value.status).toBe("succeeded");
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("handles reviewer changes_requested with dual rework sequencing and halts on rework exhaustion", async () => {
      const harness = await createTestHarness();
      try {
        const definition = createSampleWorkflowDefinition();
        const runId = "run-rework-test";
        await harness.engine.validateDefinition(definition);
        const createRes = await harness.engine.createRun({
          runId,
          definition,
          idempotencyKey: "c-rework",
          createdAt: new Date().toISOString()
        });
        await harness.runStore.create({ snapshot: createRes.value.snapshot, definition }, "create-idemp");
        await harness.runStore.appendEvents({
          runId,
          expectedVersion: 0,
          expectedLastSequence: 0,
          events: createRes.value.emittedEvents,
          idempotencyKey: "init-events"
        });

        const dispatcher = new TaskDispatcher({
          engine: harness.engine,
          runStore: harness.runStore,
          agentRegistry: harness.agentRegistry,
          transport: harness.transport
        });

        const orchestrator = new SdlcWorkflowOrchestrator(
          {
            engine: harness.engine,
            runStore: harness.runStore,
            artifactStore: harness.artifactStore
          },
          dispatcher
        );

        // 1. plan -> succeeded
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

        // 2. implement (gen 0) -> succeeded
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // 3. review (gen 0) -> changes_requested (Rework 1)
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Fix syntax error"
        });

        // 4. Verify that implement (gen 1) is ready, review (gen 1) is ready, and qa is still pending
        const snapAfterRework1 = (await harness.engine.getSnapshot(runId)).value!;
        const implementState1 = snapAfterRework1.tasks.find((t) => t.taskId === "implement")!;
        const reviewState1 = snapAfterRework1.tasks.find((t) => t.taskId === "review")!;
        const qaState1 = snapAfterRework1.tasks.find((t) => t.taskId === "qa")!;
        expect(implementState1.generation).toBe(1);
        expect(implementState1.status).toBe("ready");
        expect(reviewState1.generation).toBe(1);
        expect(reviewState1.status).toBe("ready");
        expect(qaState1.status).toBe("pending");

        // 5. driveRun schedules and dispatches implement (gen 1), NOT review or qa
        await orchestrator.driveRun(runId);
        expect(harness.transport.sentRequests.at(-1)?.taskId).toBe("implement");
        expect(dispatcher.getActiveExecution(runId, "implement")).toBeDefined();
        expect(dispatcher.getActiveExecution(runId, "review")).toBeUndefined();
        expect(dispatcher.getActiveExecution(runId, "qa")).toBeUndefined();

        // Complete implement (gen 1) -> succeeded
        const implCompleteRes1 = await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
        expect(implCompleteRes1.ok).toBe(true);

        // 6. driveRun now schedules and dispatches review (gen 1), NOT qa
        await orchestrator.driveRun(runId);
        expect(harness.transport.sentRequests.at(-1)?.taskId).toBe("review");
        expect(dispatcher.getActiveExecution(runId, "review")).toBeDefined();
        expect(dispatcher.getActiveExecution(runId, "qa")).toBeUndefined();

        // review (gen 1) requests changes again (Rework 2)
        const reviewCompleteRes1 = await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Fix test coverage"
        });
        expect(reviewCompleteRes1.ok).toBe(true);

        const snapAfterRework2 = (await harness.engine.getSnapshot(runId)).value!;
        const implementState2 = snapAfterRework2.tasks.find((t) => t.taskId === "implement")!;
        expect(implementState2.generation).toBe(2);

        // 7. implement (gen 2) runs and succeeds
        await orchestrator.driveRun(runId);
        expect(harness.transport.sentRequests.at(-1)?.taskId).toBe("implement");
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // 8. review (gen 2) runs and requests changes again -> Rework limit (maxReworks: 2) is EXHAUSTED!
        await orchestrator.driveRun(runId);
        expect(harness.transport.sentRequests.at(-1)?.taskId).toBe("review");
        const completeExhausted = await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Rework limit reached, need human help"
        });
        expect(completeExhausted.ok).toBe(true);

        const snapAfterExhaustion = (await harness.engine.getSnapshot(runId)).value!;
        const reviewExhaustedState = snapAfterExhaustion.tasks.find((t) => t.taskId === "review")!;
        expect(reviewExhaustedState.status).toBe("blocked");

        // 9. driveRun halts cleanly at 'blocked'
        const driveHaltRes = await orchestrator.driveRun(runId);
        expect(driveHaltRes.ok).toBe(true);
        expect(driveHaltRes.value?.status).toBe("blocked");
      } finally {
        await harness.cleanup();
      }
    });
  });
});
