import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createTestHarness,
  createSampleWorkflowDefinition
} from "./fixtures.js";
import { TaskDispatcher } from "../../src/dispatcher.js";
import { SdlcWorkflowOrchestrator, isHumanApprover } from "../../src/orchestrator.js";
import type { WorkflowDefinition, WorkflowRunSnapshot } from "@ai-flow/contracts";

async function setupWorkflowRun(
  harness: any,
  runId: string,
  def: WorkflowDefinition = createSampleWorkflowDefinition()
): Promise<{ orchestrator: SdlcWorkflowOrchestrator; dispatcher: TaskDispatcher; definition: WorkflowDefinition }> {
  await harness.engine.validateDefinition(def);
  const createRes = await harness.engine.createRun({
    runId,
    definition: def,
    idempotencyKey: `create-${runId}`,
    createdAt: new Date().toISOString()
  });
  if (!createRes.ok) throw new Error(`createRun failed: ${createRes.error.message}`);

  await harness.runStore.create({ snapshot: createRes.value.snapshot, definition: def }, `store-${runId}`);
  if (createRes.value.emittedEvents.length > 0) {
    await harness.runStore.appendEvents({
      runId,
      expectedVersion: 0,
      expectedLastSequence: 0,
      events: createRes.value.emittedEvents,
      idempotencyKey: `init-events-${runId}`
    });
  }

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
      artifactStore: harness.artifactStore,
      qualityGate: harness.qualityGate
    },
    dispatcher
  );

  return { orchestrator, dispatcher, definition: def };
}

describe("Challenger M1.2 Adversarial Stress Suite", { timeout: 30000 }, () => {
  // =========================================================================
  // SUITE 1: Bug 4 - isHumanApprover Anti-AI Governance Adversarial Stress
  // =========================================================================
  describe("Suite 1: Bug 4 - isHumanApprover Anti-AI Governance", () => {
    it("1.1: Rejects all mandatory AI model identities specified in dispatch", () => {
      const requiredAiIdentities = [
        "claude",
        "claude-3-opus",
        "chatgpt",
        "chatgpt-4",
        "gpt-4",
        "gpt-4o",
        "gpt4",
        "copilot",
        "gemini",
        "assistant",
        "deepseek-coder",
        "llama-3",
        "mistral-large"
      ];

      for (const id of requiredAiIdentities) {
        expect(isHumanApprover(id), `Expected '${id}' to be rejected as AI actor`).toBe(false);
      }
    });

    it("1.2: Rejects adversarial variations (case variance, delimiters, prefixes, versions)", () => {
      const adversarialAiIdentities = [
        // Case variations
        "CLAUDE",
        "Claude-3.5-Sonnet",
        "ChatGPT",
        "ChatGPT-4",
        "GPT-4O",
        "Gpt4",
        "DeEpSeEk-CoDeR",
        "LLAMA-3",
        "MISTRAL-LARGE",
        "GEMINI-1.5-PRO",
        // Delimiters
        "claude:opus",
        "chatgpt.4",
        "gpt_4",
        "copilot-github",
        "assistant-01",
        "deepseek.v3",
        "llama_3",
        "mistral:medium",
        // Legacy prefixes combined with AI names
        "ai:claude",
        "agent-chatgpt",
        "bot_copilot",
        "system:gemini",
        "llm.llama",
        "auto-mistral",
        // Raw numbers
        "gpt3",
        "gpt5",
        "claude2",
        "llama2"
      ];

      for (const id of adversarialAiIdentities) {
        expect(isHumanApprover(id), `Expected adversarial identity '${id}' to be rejected`).toBe(false);
      }
    });

    it("1.3: Accepts valid human identities specified in dispatch and standard human names", () => {
      const validHumanIdentities = [
        "alice_smith",
        "lead_architect",
        "user@domain.com",
        "human_operator",
        "human:alice",
        "user:bob_jones",
        "john.doe@enterprise.org",
        "release-manager",
        "devops_lead"
      ];

      for (const id of validHumanIdentities) {
        expect(isHumanApprover(id), `Expected valid human identity '${id}' to pass`).toBe(true);
      }
    });

    it("1.4: Handles edge-case inputs (empty, whitespace, non-string values)", () => {
      expect(isHumanApprover("")).toBe(false);
      expect(isHumanApprover("   ")).toBe(false);
      expect(isHumanApprover("\t\n  ")).toBe(false);
      expect(isHumanApprover(null as any)).toBe(false);
      expect(isHumanApprover(undefined as any)).toBe(false);
      expect(isHumanApprover(12345 as any)).toBe(false);
      expect(isHumanApprover({} as any)).toBe(false);
    });

    it("1.5: End-to-end enforcement in applyApprovalDecision rejects AI actors and accepts humans", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-gov-${randomUUID()}`;
        const { orchestrator } = await setupWorkflowRun(harness, runId);

        // Drive run to approval pause
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "approved"
        });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "qa", { status: "succeeded" });

        // Run is now waiting for pre-merge approval
        const preMergeSnap = (await harness.engine.getSnapshot(runId)).value!;
        expect(preMergeSnap.status).toBe("waiting");

        // Adversarial test: each AI actor attempts to approve
        const aiActors = ["claude-3-opus", "chatgpt-4", "gpt-4o", "copilot", "gemini", "deepseek-coder"];
        for (const aiActor of aiActors) {
          const rejectRes = await orchestrator.applyApprovalDecision({
            schemaVersion: 1,
            approvalId: `appr-${aiActor}`,
            runId,
            target: { type: "task", taskId: "qa" },
            revision: 1,
            generation: 0,
            decision: "approved",
            decidedBy: aiActor,
            decidedAt: new Date().toISOString(),
            feedbackArtifacts: [],
            idempotencyKey: `appr-key-${aiActor}`
          });
          expect(rejectRes.ok, `Expected AI actor '${aiActor}' to be rejected`).toBe(false);
          if (!rejectRes.ok) {
            expect(rejectRes.error.code).toBe("validation");
            expect(rejectRes.error.message).toContain("Mandatory human approval cannot be satisfied");
          }
        }

        // Even with a human name, if metadata.automatedOnly is true, must reject
        const autoOnlyRes = await orchestrator.applyApprovalDecision({
          schemaVersion: 1,
          approvalId: "appr-auto-only",
          runId,
          target: { type: "task", taskId: "qa" },
          revision: 1,
          generation: 0,
          decision: "approved",
          decidedBy: "alice_smith",
          decidedAt: new Date().toISOString(),
          metadata: { automatedOnly: true },
          feedbackArtifacts: [],
          idempotencyKey: "appr-auto-only-key"
        });
        expect(autoOnlyRes.ok).toBe(false);

        // Genuine human approval: alice_smith succeeds
        const humanApprovalRes = await orchestrator.applyApprovalDecision({
          schemaVersion: 1,
          approvalId: "appr-valid-human",
          runId,
          target: { type: "task", taskId: "qa" },
          revision: 1,
          generation: 0,
          decision: "approved",
          decidedBy: "alice_smith",
          decidedAt: new Date().toISOString(),
          feedbackArtifacts: [],
          idempotencyKey: "appr-valid-human-key"
        });
        expect(humanApprovalRes.ok).toBe(true);
        if (humanApprovalRes.ok) {
          expect(humanApprovalRes.value.status).toBe("succeeded");
        }
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 2: Bug 5 - SDLC Rework Review Sequencing Adversarial Stress
  // =========================================================================
  describe("Suite 2: Bug 5 - SDLC Rework Review Sequencing", { timeout: 30000 }, () => {
    it("2.1: Initial changes_requested (Rework 1): implement (gen 1) ready, review (gen 1) ready, qa remains pending", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-rework-seq-${randomUUID()}`;
        const { orchestrator } = await setupWorkflowRun(harness, runId);

        // 1. plan -> succeeded
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

        // 2. implement (gen 0) -> succeeded
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // 3. review (gen 0) -> changes_requested
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Syntax error on line 42"
        });

        // 4. Verify immediate state after changes_requested
        const snapAfterRework1 = (await harness.engine.getSnapshot(runId)).value!;
        const implementState = snapAfterRework1.tasks.find((t) => t.taskId === "implement")!;
        const reviewState = snapAfterRework1.tasks.find((t) => t.taskId === "review")!;
        const qaState = snapAfterRework1.tasks.find((t) => t.taskId === "qa")!;

        expect(implementState.generation).toBe(1);
        expect(implementState.status).toBe("ready");

        expect(reviewState.generation).toBe(1);
        expect(reviewState.status).toBe("ready");

        // QA MUST remain pending
        expect(qaState.status).toBe("pending");
        expect(qaState.generation).toBe(0);

        // 5. driveRun MUST schedule implement (gen 1), NOT review or qa
        await orchestrator.driveRun(runId);
        const lastSent = harness.transport.sentRequests.at(-1);
        expect(lastSent?.taskId).toBe("implement");

        // Re-check QA state: still pending!
        const snapDuringRework = (await harness.engine.getSnapshot(runId)).value!;
        const qaDuringRework = snapDuringRework.tasks.find((t) => t.taskId === "qa")!;
        expect(qaDuringRework.status).toBe("pending");
      } finally {
        await harness.cleanup();
      }
    });

    it("2.2: Second changes_requested (Rework 2): sequences to gen 2, qa never runs prematurely", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-rework-seq2-${randomUUID()}`;
        const { orchestrator } = await setupWorkflowRun(harness, runId);

        // Step 1: plan & implement (gen 0) succeed
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // Step 2: review (gen 0) requests changes -> Rework 1
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Rework attempt 1 needed"
        });

        // Step 3: implement (gen 1) runs and succeeds
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // Step 4: review (gen 1) is now scheduled and runs
        await orchestrator.driveRun(runId);
        const reviewGen1Sent = harness.transport.sentRequests.at(-1);
        expect(reviewGen1Sent?.taskId).toBe("review");

        // QA must STILL be pending
        let snap = (await harness.engine.getSnapshot(runId)).value!;
        expect(snap.tasks.find((t) => t.taskId === "qa")?.status).toBe("pending");

        // Step 5: reviewer requests changes again -> Rework 2 (target gen 1 -> gen 2)
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Rework attempt 2 needed"
        });

        snap = (await harness.engine.getSnapshot(runId)).value!;
        const implementGen2 = snap.tasks.find((t) => t.taskId === "implement")!;
        const reviewGen2 = snap.tasks.find((t) => t.taskId === "review")!;
        const qaGen0 = snap.tasks.find((t) => t.taskId === "qa")!;

        expect(implementGen2.generation).toBe(2);
        expect(implementGen2.status).toBe("ready");
        expect(reviewGen2.generation).toBe(2);
        expect(reviewGen2.status).toBe("ready");
        expect(qaGen0.status).toBe("pending");

        // Step 6: driveRun dispatches implement (gen 2)
        await orchestrator.driveRun(runId);
        expect(harness.transport.sentRequests.at(-1)?.taskId).toBe("implement");
      } finally {
        await harness.cleanup();
      }
    });

    it("2.3: After rework succeeds on gen 2, review approves and qa runs to completion", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-rework-success-${randomUUID()}`;
        const { orchestrator } = await setupWorkflowRun(harness, runId);

        // plan -> implement (0) -> review (0) changes_requested
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Rework 1"
        });

        // implement (1) succeeds -> review (1) changes_requested
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Rework 2"
        });

        // implement (2) succeeds
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // review (2) executes and APPROVES!
        await orchestrator.driveRun(runId);
        expect(harness.transport.sentRequests.at(-1)?.taskId).toBe("review");

        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "approved",
          reviewReason: "All issues fixed in generation 2"
        });

        // Now and ONLY now: qa is runnable!
        await orchestrator.driveRun(runId);
        expect(harness.transport.sentRequests.at(-1)?.taskId).toBe("qa");

        // qa succeeds
        await orchestrator.completeTaskExecution(runId, "qa", { status: "succeeded" });

        // Run is now waiting for pre-merge approval
        const finalSnap = (await harness.engine.getSnapshot(runId)).value!;
        expect(finalSnap.status).toBe("waiting");

        // Verify handoff report was persisted in ArtifactStore
        const report = await harness.artifactStore.resolve(`report-${runId}-handoff`);
        expect(report.ok).toBe(true);
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 3: Bug 5 - Rework Exhaustion and Immediate Blocked Halt
  // =========================================================================
  describe("Suite 3: Bug 5 - Rework Exhaustion and Immediate Blocked Halt", { timeout: 30000 }, () => {
    it("3.1: Halts immediately at 'blocked' when rework limit (maxReworks: 2) is exhausted without spinning", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-rework-exhaust-${randomUUID()}`;
        const { orchestrator } = await setupWorkflowRun(harness, runId);

        // plan -> implement (0) -> review (0) changes_requested (Rework 1 used)
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Changes 1"
        });

        // implement (1) -> review (1) changes_requested (Rework 2 used)
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Changes 2"
        });

        // implement (2) succeeds
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // review (2) executes and requests changes a THIRD time -> EXHAUSTION!
        await orchestrator.driveRun(runId);
        expect(harness.transport.sentRequests.at(-1)?.taskId).toBe("review");

        // Complete review (gen 2) with changes_requested
        const completeRes = await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Rework limit exhausted; still failing after 2 reworks"
        });
        expect(completeRes.ok).toBe(true);

        // Verify task state: review is recorded as 'blocked'
        const postExhaustSnap = (await harness.engine.getSnapshot(runId)).value!;
        const reviewTask = postExhaustSnap.tasks.find((t) => t.taskId === "review")!;
        expect(reviewTask.status).toBe("blocked");
        expect(reviewTask.blockage?.code).toBe("manual_intervention");
        expect(reviewTask.blockage?.message).toContain("Rework limit exhausted");

        // implement generation must NOT exceed maxReworks (2)
        const implementTask = postExhaustSnap.tasks.find((t) => t.taskId === "implement")!;
        expect(implementTask.generation).toBe(2);

        // CRITICAL CHECK: driveRun must halt immediately with snapshot status 'blocked' without spinning
        const startTime = Date.now();
        const driveRes = await orchestrator.driveRun(runId);
        const durationMs = Date.now() - startTime;

        expect(driveRes.ok).toBe(true);
        if (driveRes.ok) {
          expect(driveRes.value.status).toBe("blocked");
        }
        // Must return in < 2000ms (no spinning / infinite loop, relaxed for multi-suite concurrency contention)
        expect(durationMs, "driveRun must return promptly without infinite spinning").toBeLessThan(2000);

        // Verify that driveRun returned the blocked snapshot
        expect(driveRes.value.status).toBe("blocked");

        // Verify task state in persisted run
        const persistedRun = (await harness.runStore.get(runId)).value!;
        const persistedReview = persistedRun.snapshot.tasks.find((t) => t.taskId === "review")!;
        expect(persistedReview.status).toBe("blocked");
        expect(persistedReview.blockage?.code).toBe("manual_intervention");
      } finally {
        await harness.cleanup();
      }
    });

    it("3.2: Immediate exhaustion when maxReworks is 0", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-rework-zero-${randomUUID()}`;
        const def = createSampleWorkflowDefinition();
        // Set maxReworks to 0 on implement
        const implementDef = def.tasks.find((t) => t.id === "implement")!;
        implementDef.rework = { maxReworks: 0, onExhausted: "require_human" };

        const { orchestrator } = await setupWorkflowRun(harness, runId, def);

        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // Reviewer requests changes on gen 0 -> immediately exhausted!
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "No reworks permitted"
        });

        // Must halt at 'blocked'
        const driveRes = await orchestrator.driveRun(runId);
        expect(driveRes.ok).toBe(true);
        if (driveRes.ok) {
          expect(driveRes.value.status).toBe("blocked");
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("3.3: Repeated driveRun calls on blocked run are idempotent and return blocked snapshot", async () => {
      const harness = await createTestHarness();
      try {
        const runId = `run-idempotent-blocked-${randomUUID()}`;
        const def = createSampleWorkflowDefinition();
        const implementDef = def.tasks.find((t) => t.id === "implement")!;
        implementDef.rework = { maxReworks: 0, onExhausted: "require_human" };

        const { orchestrator } = await setupWorkflowRun(harness, runId, def);

        // Drive run to blocked status via rework exhaustion
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
        await orchestrator.driveRun(runId);
        await orchestrator.completeTaskExecution(runId, "review", {
          status: "succeeded",
          reviewDecision: "changes_requested",
          reviewReason: "Rework exhausted"
        });

        const driveRes1 = await orchestrator.driveRun(runId);
        expect(driveRes1.ok).toBe(true);
        if (driveRes1.ok) expect(driveRes1.value.status).toBe("blocked");

        const requestsBefore = harness.transport.sentRequests.length;

        // Call driveRun again: should return immediately with blocked status and no new dispatches
        const driveRes2 = await orchestrator.driveRun(runId);
        expect(driveRes2.ok).toBe(true);
        if (driveRes2.ok) expect(driveRes2.value.status).toBe("blocked");

        const requestsAfter = harness.transport.sentRequests.length;
        expect(requestsAfter, "No new dispatches should occur on blocked run").toBe(requestsBefore);
      } finally {
        await harness.cleanup();
      }
    });
  });
});
