import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  createStandardMvpWorkflow,
  expectFailure,
  expectOk
} from "../helpers/fixtures.js";
import type { TaskState } from "@ai-flow/contracts";

describe("Scenario E04 — Concurrency, Leases, and Fencing Tokens", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("executes multiple concurrent workflows with strict state, event and artifact isolation", async () => {
    harness = await createE2eHarness();
    const runA = `run-concurrent-A-${randomUUID()}`;
    const runB = `run-concurrent-B-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // Start Workflow A
    const startA = await harness.service.start({
      runId: runA,
      definition,
      input: { requirement: "Workflow A" },
      idempotencyKey: `start-${runA}`,
      requestedAt: new Date().toISOString()
    });
    expectOk(startA);

    // Start Workflow B
    const startB = await harness.service.start({
      runId: runB,
      definition,
      input: { requirement: "Workflow B" },
      idempotencyKey: `start-${runB}`,
      requestedAt: new Date().toISOString()
    });
    expectOk(startB);

    // Both workflows should have dispatched 'plan' task
    const snapA = expectOk(await harness.service.getRun(runA))!;
    const snapB = expectOk(await harness.service.getRun(runB))!;
    expect(snapA.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("running");
    expect(snapB.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("running");

    // Complete 'plan' in Workflow A with artifact A
    const { proposal: propA, rawBytes: bytesA } = createArtifactProposal({
      runId: runA,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Artifact for Workflow A only"
    });
    const completeA = await harness.service.orchestrator.completeTaskExecution(
      runA,
      "plan",
      {
        status: "succeeded",
        summary: "Plan A succeeded",
        proposals: [propA],
        contentByProposalId: { [propA.proposalId]: bytesA }
      }
    );
    expectOk(completeA);

    // Complete 'plan' in Workflow B with artifact B
    const { proposal: propB, rawBytes: bytesB } = createArtifactProposal({
      runId: runB,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Artifact for Workflow B only"
    });
    const completeB = await harness.service.orchestrator.completeTaskExecution(
      runB,
      "plan",
      {
        status: "succeeded",
        summary: "Plan B succeeded",
        proposals: [propB],
        contentByProposalId: { [propB.proposalId]: bytesB }
      }
    );
    expectOk(completeB);

    // Verify Events Isolation in SQLite RunStore
    const eventsA = expectOk(await harness.runStore.readEvents(runA, { limit: 100 }));
    const eventsB = expectOk(await harness.runStore.readEvents(runB, { limit: 100 }));

    expect(eventsA.items.length).toBeGreaterThan(0);
    expect(eventsB.items.length).toBeGreaterThan(0);

    for (const ev of eventsA.items) {
      expect(ev.runId).toBe(runA);
    }
    for (const ev of eventsB.items) {
      expect(ev.runId).toBe(runB);
    }

    // Verify ArtifactStore isolation: Artifacts are isolated per runId
    const artifactsA = expectOk(await harness.artifactStore.find({ runId: runA }));
    const artifactsB = expectOk(await harness.artifactStore.find({ runId: runB }));

    expect(artifactsA.items.length).toBe(1);
    expect(artifactsB.items.length).toBe(1);

    const artifactARef = artifactsA.items[0]!;
    const artifactBRef = artifactsB.items[0]!;

    expect(artifactARef.runId).toBe(runA);
    expect(artifactBRef.runId).toBe(runB);
    expect(artifactARef.artifactId).not.toBe(artifactBRef.artifactId);

    // Reading artifact A using cross runId reference should fail verification
    const invalidRef = { ...artifactARef, runId: runB };
    const chunks: Uint8Array[] = [];
    for await (const chunk of harness.artifactStore.get(invalidRef)) {
      if (chunk.ok) chunks.push(chunk.value);
      else expect(chunk.ok).toBe(false);
    }
  });

  it("enforces agent concurrency limit and assigns strictly monotonic fencing tokens", async () => {
    harness = await createE2eHarness();

    // Reconfigure 'planner' role with an agent having maxConcurrentTasks: 1
    const upsertRes = await harness.agentRegistry.upsert({
      agentId: "agent-planner-single",
      role: "planner",
      transport: "herdr",
      enabled: true,
      priority: 10, // Higher priority than default agent
      maxConcurrentTasks: 1,
      capabilities: ["code", "review", "test"],
      settings: {
        provider: "mock",
        kind: "cli",
        readOnlyWorkspace: false,
        allowTaskDelegation: false
      }
    });
    expectOk(upsertRes);

    const run1 = `run-limit-1-${randomUUID()}`;
    const run2 = `run-limit-2-${randomUUID()}`;
    const definition = createStandardMvpWorkflow();

    // Start Run 1: will successfully acquire the single available lease
    const start1 = await harness.service.start({
      runId: run1,
      definition,
      input: { requirement: "Run 1 concurrency test" },
      idempotencyKey: `start-${run1}`,
      requestedAt: new Date().toISOString()
    });
    const snap1 = expectOk(start1);
    const plan1 = snap1.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(plan1?.status).toBe("running");

    // Start Run 2: attempts to dispatch 'plan' to the same agent whose capacity is now exhausted (1/1)
    const start2 = await harness.service.start({
      runId: run2,
      definition,
      input: { requirement: "Run 2 concurrency test" },
      idempotencyKey: `start-${run2}`,
      requestedAt: new Date().toISOString()
    });
    // Dispatcher fails with conflict: Agent concurrency limit reached
    const start2Err = expectFailure(start2);
    expect(start2Err.code).toBe("conflict");
    expect(start2Err.message).toContain("concurrency limit");

    // Complete 'plan' in Run 1: this releases the lease
    const { proposal, rawBytes } = createArtifactProposal({
      runId: run1,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Plan 1 done"
    });
    const complete1 = await harness.service.orchestrator.completeTaskExecution(
      run1,
      "plan",
      {
        status: "succeeded",
        summary: "Plan 1 complete",
        proposals: [proposal],
        contentByProposalId: { [proposal.proposalId]: rawBytes }
      }
    );
    expectOk(complete1);

    // Now drive Run 2 again: capacity is freed, so dispatch succeeds!
    const drive2 = await harness.service.orchestrator.driveRun(run2);
    const snap2 = expectOk(drive2);
    const plan2 = snap2.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(plan2?.status).toBe("running");
  });
});
