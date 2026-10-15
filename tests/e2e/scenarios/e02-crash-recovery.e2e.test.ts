import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  createStandardMvpWorkflow
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
    expect(startRes.ok).toBe(true);

    // Simulate process crash and restart with fresh runtime instance
    const restarted = await harness.restart();

    // Query run through recovered RuntimeService
    const recoveredGet = await restarted.service.getRun(runId);
    expect(recoveredGet.ok).toBe(true);
    expect(recoveredGet.value).toBeDefined();
    expect(recoveredGet.value?.runId).toBe(runId);
    expect(recoveredGet.value?.status).toBe("running");

    // Recovered runtime resumes and drives the workflow
    const driveRes = await restarted.service.resume(runId);
    expect(driveRes.error).toBeUndefined();
    expect(driveRes.ok).toBe(true);
    const snap = driveRes.value;
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
    expect(initDrive.ok).toBe(true);
    const preCrashSnap = initDrive.value;
    const preCrashPlan = preCrashSnap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(preCrashPlan?.status).toBe("running");
    expect(preCrashPlan?.agentExecution).toBeDefined();
    const preCrashExecutionId = preCrashPlan!.agentExecution!.executionId;

    const preCrashSends = harness.transport.sendCallsCount;

    // Simulate sudden process crash: process restarts
    const restarted = await harness.restart();

    // Post-restart: read run snapshot
    const postCrashGet = await restarted.service.getRun(runId);
    expect(postCrashGet.ok).toBe(true);
    const postCrashSnap = postCrashGet.value!;
    const postCrashPlan = postCrashSnap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(postCrashPlan?.status).toBe("running");

    // Execution handle and attempt identity must be preserved across restart
    expect(postCrashPlan?.agentExecution?.executionId).toBe(preCrashExecutionId);

    // Rehydrate engine state via service.resume
    const resumeRes = await restarted.service.resume(runId);
    expect(resumeRes.ok).toBe(true);

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
    expect(completeRes.ok).toBe(true);
    expect(completeRes.value.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("succeeded");

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

    // Save checkpoint at current state
    const currentSnap = (await harness.service.getRun(runId)).value!;
    const saveRes = await harness.service.orchestrator.createAndSaveCheckpoint(runId, currentSnap.version);
    expect(saveRes.ok).toBe(true);

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
    expect(completeRes.ok).toBe(true);
    const preRestartVersion = completeRes.value.version;

    // Crash and restart
    const restarted = await harness.restart();

    // Verify durable stored snapshot immediately after crash recovery
    const storedSnap = await restarted.service.getRun(runId);
    expect(storedSnap.ok).toBe(true);
    expect(storedSnap.value?.version).toBe(preRestartVersion);
    expect(storedSnap.value?.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("succeeded");

    // Recover run into engine and resume driving next dependent tasks
    const recoverRes = await restarted.service.resume(runId);
    expect(recoverRes.ok).toBe(true);
    expect(recoverRes.value.version).toBeGreaterThanOrEqual(preRestartVersion);
    expect(recoverRes.value.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("succeeded");
    expect(recoverRes.value.tasks.find((t: TaskState) => t.taskId === "implement")?.status).toBe("running");
  });
});
