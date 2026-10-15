import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  createStandardMvpWorkflow,
  expectOk
} from "../helpers/fixtures.js";
import type { TaskState } from "@ai-flow/contracts";

describe("Scenario E02 — Crash & Recovery Integration", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("recovers workflow run state after process restart before task dispatch", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Crash recovery test before dispatch" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });
    expectOk(startRes);

    // Simulate process crash and restart with fresh runtime instance
    const restarted = await harness.restart();

    // Query run through recovered RuntimeService
    const recoveredGet = await restarted.service.getRun(runId);
    const recoveredSnap = expectOk(recoveredGet);
    expect(recoveredSnap).not.toBeNull();
    expect(recoveredSnap?.runId).toBe(runId);
    expect(recoveredSnap?.status).toBe("running");

    // Recovered runtime resumes and drives the workflow
    const driveRes = await restarted.service.resume(runId);
    const snap = expectOk(driveRes);
    const planTask = snap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(planTask?.status).toBe("running");
  });

  it("recovers running task across restart without duplicate execution side-effects", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    await harness.service.start({
      runId,
      definition,
      input: { requirement: "Crash recovery during running task" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });

    const initDrive = await harness.service.orchestrator.driveRun(runId);
    const preCrashSnap = expectOk(initDrive);
    const preCrashPlan = preCrashSnap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(preCrashPlan?.status).toBe("running");
    expect(preCrashPlan?.agentExecution).toBeDefined();
    const preCrashExecutionId = preCrashPlan!.agentExecution!.executionId;

    const preCrashSends = harness.transport.sendCallsCount;

    // Simulate sudden process crash: process restarts
    const restarted = await harness.restart();

    // Post-restart: read run snapshot
    const postCrashGet = await restarted.service.getRun(runId);
    const postCrashSnap = expectOk(postCrashGet);
    expect(postCrashSnap).not.toBeNull();
    const postCrashPlan = postCrashSnap!.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(postCrashPlan?.status).toBe("running");

    // Execution handle and attempt identity must be preserved across restart
    expect(postCrashPlan?.agentExecution?.executionId).toBe(preCrashExecutionId);

    // Rehydrate engine state via service.resume
    const resumeRes = await restarted.service.resume(runId);
    expectOk(resumeRes);

    // Complete task execution through the new runtime instance
    const { proposal, rawBytes } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Plan after crash recovery"
    });

    const completeRes = await restarted.service.orchestrator.completeTaskExecution(
      runId,
      "plan",
      {
        status: "succeeded",
        summary: "Plan successfully completed after restart",
        proposals: [proposal],
        contentByProposalId: { [proposal.proposalId]: rawBytes }
      }
    );
    const completeSnap = expectOk(completeRes);
    expect(completeSnap.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("succeeded");

    // Transport prompt submission calls count must not have duplicated for the same task attempt
    expect(harness.transport.sendCallsCount).toBe(preCrashSends);
  });

  it("reconstructs exact snapshot state from checkpoint and event tail replay", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    await harness.service.start({
      runId,
      definition,
      input: { requirement: "Checkpoint tail recovery test" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });

    await harness.service.orchestrator.driveRun(runId);

    // Save checkpoint at current state using public engine and runStore APIs
    const currentSnapRes = await harness.service.getRun(runId);
    const currentSnap = expectOk(currentSnapRes)!;

    const checkpointRes = await harness.engine.createCheckpoint({
      runId,
      expectedVersion: currentSnap.version,
      checkpointId: `chk-${randomUUID()}`,
      createdAt: new Date().toISOString()
    });
    const checkpoint = expectOk(checkpointRes);

    const saveRes = await harness.runStore.saveCheckpoint(
      checkpoint,
      currentSnap.version
    );
    expectOk(saveRes);

    // Now complete the plan task, advancing version and appending new events after the checkpoint
    const { proposal, rawBytes } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Tail event plan"
    });

    const completeRes = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "plan",
      {
        status: "succeeded",
        summary: "Plan completed post-checkpoint",
        proposals: [proposal],
        contentByProposalId: { [proposal.proposalId]: rawBytes }
      }
    );
    const completeSnap = expectOk(completeRes);
    const preRestartVersion = completeSnap.version;

    // Crash and restart
    const restarted = await harness.restart();

    // Verify durable stored snapshot immediately after crash recovery
    const storedSnapRes = await restarted.service.getRun(runId);
    const storedSnap = expectOk(storedSnapRes);
    expect(storedSnap).not.toBeNull();
    expect(storedSnap?.version).toBe(preRestartVersion);
    expect(storedSnap?.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("succeeded");

    // Recover run into engine and resume driving next dependent tasks
    const recoverRes = await restarted.service.resume(runId);
    const recoverSnap = expectOk(recoverRes);
    expect(recoverSnap.version).toBeGreaterThanOrEqual(preRestartVersion);
    expect(recoverSnap.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("succeeded");
    expect(recoverSnap.tasks.find((t: TaskState) => t.taskId === "implement")?.status).toBe("running");
  });
});
