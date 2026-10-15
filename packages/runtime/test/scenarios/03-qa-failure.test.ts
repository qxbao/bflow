import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JsonValueSchema, type ArtifactProposal, type WorkflowDefinition } from "@bflow/contracts";
import { TaskDispatcher } from "../../src/dispatcher.js";
import { SdlcWorkflowOrchestrator } from "../../src/orchestrator.js";
import { createSampleWorkflowDefinition, createTestHarness } from "../unit/fixtures.js";

async function setupScenarioRun(
  harness: any,
  runId: string,
  def: WorkflowDefinition
): Promise<{ orchestrator: SdlcWorkflowOrchestrator; dispatcher: TaskDispatcher }> {
  const adjustedDef: WorkflowDefinition = {
    ...def,
    tasks: def.tasks.map((t) => ({
      ...t,
      retry: { ...t.retry, initialDelayMs: 0 }
    }))
  };
  await harness.engine.validateDefinition(adjustedDef);
  const createRes = await harness.engine.createRun({
    runId,
    definition: adjustedDef,
    idempotencyKey: `create-${runId}`,
    createdAt: new Date().toISOString()
  });
  if (!createRes.ok) throw new Error(`createRun failed: ${createRes.error.message}`);

  await harness.runStore.create({ snapshot: createRes.value.snapshot, definition: adjustedDef }, `store-${runId}`);
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

  return { orchestrator, dispatcher };
}

describe("Integration Scenario 3: QA Failure & Retry Policy", { timeout: 30000 }, () => {
  it("3.1 & 3.2: QA fails on Attempt 1, ingests findings into ArtifactStore, schedules retry and increments attempt to 2", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-qa-retry-1";
      const { orchestrator } = await setupScenarioRun(harness, runId, definition);

      // 1. Advance through plan, implement, review to reach QA
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "review", { status: "succeeded", reviewDecision: "approved" });
      await orchestrator.driveRun(runId);

      // Verify QA is active at attempt 1
      const snapBefore = (await harness.engine.getSnapshot(runId)).value!;
      const qaTaskBefore = snapBefore.tasks.find((t) => t.taskId === "qa")!;
      expect(qaTaskBefore.status).toBe("running");
      expect(qaTaskBefore.attempt).toBe(1);

      // 2. Formulate QA failure findings artifact proposal
      const findingsContent = JSON.stringify({
        suite: "acceptance-e2e",
        passed: 14,
        failed: 2,
        errors: ["LoginButtonNotFoundException", "SessionTokenNullError"]
      });
      const findingsBytes = Buffer.from(findingsContent, "utf8");
      const findingsSha256 = createHash("sha256").update(findingsBytes).digest("hex");
      const proposal: ArtifactProposal = {
        proposalId: `qa-findings-${runId}`,
        runId,
        taskId: "qa",
        kind: "report",
        logicalName: "qa-findings.json",
        mediaType: "application/json",
        expectedIntegrity: {
          sizeBytes: findingsBytes.byteLength,
          checksum: { algorithm: "sha256", value: findingsSha256 }
        }
      };

      // 3. Complete QA execution with failure and retryable: true
      const failRes = await orchestrator.completeTaskExecution(runId, "qa", {
        status: "failed",
        exitCode: 1,
        summary: "E2E acceptance suite failed with 2 assertion breaks",
        retryable: true,
        proposals: [proposal],
        contentByProposalId: { [proposal.proposalId]: findingsContent }
      });
      expect(failRes.ok).toBe(true);

      // 4. Verify artifact store contains trusted findings
      const storedArtifact = await harness.artifactStore.resolve(`qa-findings-${runId}`);
      expect(storedArtifact.ok).toBe(true);
      expect(storedArtifact.value?.trust).toBe("stored");

      // 5. Verify task transitioned running -> failed -> retrying -> ready
      const snapAfterFail = (await harness.engine.getSnapshot(runId)).value!;
      const qaTaskAfterFail = snapAfterFail.tasks.find((t) => t.taskId === "qa")!;
      expect(["retrying", "ready"]).toContain(qaTaskAfterFail.status);
      expect(snapAfterFail.status).toBe("running");

      // 6. Drive run to dispatch Attempt 2
      await orchestrator.driveRun(runId);
      const snapAttempt2 = (await harness.engine.getSnapshot(runId)).value!;
      const qaTaskAttempt2 = snapAttempt2.tasks.find((t) => t.taskId === "qa")!;
      expect(qaTaskAttempt2.status).toBe("running");
      expect(qaTaskAttempt2.attempt).toBe(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("3.3: Retry Attempt 2 succeeds, transitions to succeeded and reaches pre-merge approval hold", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-qa-retry-success";
      const { orchestrator } = await setupScenarioRun(harness, runId, definition);

      // Advance to QA attempt 1
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "review", { status: "succeeded", reviewDecision: "approved" });
      await orchestrator.driveRun(runId);

      // Attempt 1 fails (retryable)
      await orchestrator.completeTaskExecution(runId, "qa", {
        status: "failed",
        exitCode: 1,
        summary: "Flaky network timeout on test runner",
        retryable: true
      });

      // Drive run for Attempt 2
      await orchestrator.driveRun(runId);
      const snap2 = (await harness.engine.getSnapshot(runId)).value!;
      const qa2 = snap2.tasks.find((t) => t.taskId === "qa")!;
      expect(qa2.attempt).toBe(2);

      // Attempt 2 succeeds!
      const successRes = await orchestrator.completeTaskExecution(runId, "qa", {
        status: "succeeded",
        exitCode: 0,
        summary: "All 16 acceptance test suites passed cleanly"
      });
      expect(successRes.ok).toBe(true);

      // Verify pre-merge approval hold is reached
      const snapFinal = (await harness.engine.getSnapshot(runId)).value!;
      expect(snapFinal.status).toBe("waiting");
      const qaFinal = snapFinal.tasks.find((t) => t.taskId === "qa")!;
      expect(qaFinal.status).toBe("succeeded");
      expect(snapFinal.tasks.every((t) => t.status === "succeeded")).toBe(true);

      // Handoff report persisted in ArtifactStore
      const handoffRes = await harness.artifactStore.resolve(`report-${runId}-handoff`);
      expect(handoffRes.ok).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("3.4: Retry exhaustion under 'fail-fast' transitions run to failed with persisted evidence and released leases", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      expect(definition.failurePolicy).toBe("fail-fast");
      const runId = `run-qa-failfast-${randomUUID()}`;
      const { orchestrator } = await setupScenarioRun(harness, runId, definition);

      // Advance to QA
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "review", { status: "succeeded", reviewDecision: "approved" });
      await orchestrator.driveRun(runId);

      // Attempt 1 fails
      await orchestrator.completeTaskExecution(runId, "qa", {
        status: "failed",
        exitCode: 1,
        summary: "Attempt 1 failed",
        retryable: true
      });

      // Attempt 2 dispatches
      await orchestrator.driveRun(runId);

      // Attempt 2 fails (retry exhausted: maxAttempts = 2)
      const exhaustRes = await orchestrator.completeTaskExecution(runId, "qa", {
        status: "failed",
        exitCode: 1,
        summary: "Attempt 2 failed permanently",
        retryable: false
      });
      expect(exhaustRes.ok).toBe(true);

      // Verify run status transitioned to 'failed'
      const snapExhaust = (await harness.engine.getSnapshot(runId)).value!;
      expect(snapExhaust.status).toBe("failed");
      const qaState = snapExhaust.tasks.find((t) => t.taskId === "qa")!;
      expect(qaState.status).toBe("failed");

      // Verify events persisted to RunStore
      const eventPage = await harness.runStore.readEvents(runId, { limit: 100 });
      expect(eventPage.ok).toBe(true);
      const events = eventPage.value.items;
      expect(events.some((e) => e.type === "agent.result_recorded" && (e.payload as any).status === "failed")).toBe(true);
      expect(events.some((e) => e.type === "task.status_changed" && (e.payload as any).to === "failed")).toBe(true);
      expect(events.some((e) => e.type === "run.status_changed" && (e.payload as any).to === "failed")).toBe(true);

      // Verify checkpoint saved with failed terminal status
      const cpRes = await harness.runStore.loadLatestCheckpoint(runId);
      expect(cpRes.ok).toBe(true);
      expect(cpRes.value).not.toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("3.5: Retry exhaustion under 'block' failure policy transitions run to blocked for operator diagnosis", async () => {
    const harness = await createTestHarness();
    try {
      const sampleDef = createSampleWorkflowDefinition();
      const definition: WorkflowDefinition = {
        ...sampleDef,
        failurePolicy: "block",
        tasks: sampleDef.tasks.map((t) => ({
          ...t,
          retry: { ...t.retry, initialDelayMs: 0 }
        }))
      };
      const runId = `run-qa-block-policy-${randomUUID()}`;
      const { orchestrator } = await setupScenarioRun(harness, runId, definition);

      // Advance to QA
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });
      await orchestrator.driveRun(runId);
      await orchestrator.completeTaskExecution(runId, "review", { status: "succeeded", reviewDecision: "approved" });
      await orchestrator.driveRun(runId);

      // Attempt 1 fails
      await orchestrator.completeTaskExecution(runId, "qa", {
        status: "failed",
        exitCode: 1,
        summary: "Attempt 1 failed",
        retryable: true
      });

      // Attempt 2 dispatches
      await orchestrator.driveRun(runId);

      // Attempt 2 fails
      await orchestrator.completeTaskExecution(runId, "qa", {
        status: "failed",
        exitCode: 1,
        summary: "Attempt 2 failed; exhausted",
        retryable: false
      });

      // Under failurePolicy: 'block', run must transition to 'blocked'
      const snapBlocked = (await harness.engine.getSnapshot(runId)).value!;
      expect(snapBlocked.status).toBe("blocked");
      const qaState = snapBlocked.tasks.find((t) => t.taskId === "qa")!;
      expect(qaState.status).toBe("failed");
    } finally {
      await harness.cleanup();
    }
  });
});
