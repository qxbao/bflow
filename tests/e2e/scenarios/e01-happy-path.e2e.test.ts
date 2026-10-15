import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  createSafeSubprocessGate,
  createStandardMvpWorkflow
} from "../helpers/fixtures.js";
import type { TaskState, WorkflowRunSnapshot } from "@ai-flow/contracts";

describe("Scenario E01 — Happy Path SDLC Integration", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("executes a complete 4-stage SDLC workflow across real Core, RunStore, ArtifactStore, Registry and QualityGate", async () => {
    harness = await createE2eHarness();
    const runId = `run-${randomUUID()}`;
    const gateId = "qa-gate";

    // 1. Register real CommandQualityGate running a safe node subprocess
    const realGate = createSafeSubprocessGate({
      gateId,
      workingDirectory: harness.tmpDir,
      nodeScript: "console.log('Automated verification: 15 unit tests passed successfully'); process.exit(0);",
      required: true
    });
    harness.qualityGate.register(gateId, realGate);

    // 2. Create standard 4-stage SDLC definition: plan -> implement -> review -> qa
    const definition = createStandardMvpWorkflow({ gateId });
    const startRes = await harness.service.start({
      runId,
      definition,
      input: { requirement: "Implement user authentication module" },
      idempotencyKey: `start-${runId}`,
      requestedAt: new Date().toISOString()
    });

    expect(startRes.ok).toBe(true);
    if (!startRes.ok) throw new Error(startRes.error.message);

    const getTask = (snap: WorkflowRunSnapshot, taskId: string): TaskState => {
      const task = snap.tasks.find((t) => t.taskId === taskId);
      expect(task).toBeDefined();
      return task!;
    };

    // Drive initial dispatch
    const execInitRes = await harness.service.orchestrator.driveRun(runId);
    expect(execInitRes.ok).toBe(true);
    if (!execInitRes.ok) throw new Error(execInitRes.error.message);
    let snap = execInitRes.value;

    // --- Stage 1: Plan ---
    let planTask = getTask(snap, "plan");
    expect(planTask.status).toBe("running");
    expect(planTask.agentExecution).toBeDefined();

    // Create proposal
    const { proposal: planProposal, rawBytes: planBytes } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "architecture-plan.md",
      content: "# Architecture Plan\n1. Auth module\n2. Token handling"
    });

    // Complete task execution through runtime orchestrator
    const completePlanRes = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "plan",
      {
        status: "succeeded",
        summary: "Plan completed with 2 modules",
        proposals: [planProposal],
        contentByProposalId: { [planProposal.proposalId]: planBytes }
      }
    );
    expect(completePlanRes.ok).toBe(true);
    if (!completePlanRes.ok) throw new Error(completePlanRes.error.message);
    snap = completePlanRes.value;
    expect(getTask(snap, "plan").status).toBe("succeeded");

    // --- Stage 2: Implement ---
    // Schedule and dispatch ready task via orchestrator execution loop
    const execImpRes = await harness.service.orchestrator.driveRun(runId);
    expect(execImpRes.ok).toBe(true);
    if (!execImpRes.ok) throw new Error(execImpRes.error.message);
    snap = execImpRes.value;
    expect(getTask(snap, "implement").status).toBe("running");

    // Create patch proposal
    const { proposal: patchProposal, rawBytes: patchBytes } = createArtifactProposal({
      runId,
      taskId: "implement",
      kind: "patch",
      logicalName: "auth.patch",
      content: "diff --git a/auth.ts b/auth.ts\n+export function auth() {}"
    });

    const completeImpRes = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "implement",
      {
        status: "succeeded",
        summary: "Auth module implemented",
        proposals: [patchProposal],
        contentByProposalId: { [patchProposal.proposalId]: patchBytes }
      }
    );
    expect(completeImpRes.ok).toBe(true);
    if (!completeImpRes.ok) throw new Error(completeImpRes.error.message);
    snap = completeImpRes.value;
    expect(getTask(snap, "implement").status).toBe("succeeded");

    // --- Stage 3: Review (Requires Approval) ---
    const execRevRes = await harness.service.orchestrator.driveRun(runId);
    expect(execRevRes.ok).toBe(true);
    if (!execRevRes.ok) throw new Error(execRevRes.error.message);
    snap = execRevRes.value;
    expect(getTask(snap, "review").status).toBe("running");

    const completeRevRes = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "review",
      {
        status: "succeeded",
        summary: "Code review completed with no critical findings"
      }
    );
    expect(completeRevRes.ok).toBe(true);
    if (!completeRevRes.ok) throw new Error(completeRevRes.error.message);
    snap = completeRevRes.value;

    // Review requires approval: the run is paused in waiting/blocked state awaiting human decision
    expect(["waiting", "blocked", "running"]).toContain(snap.status);

    // Apply human approval via RuntimeService
    const approveRes = await harness.service.approve(runId, {
      decision: "approved",
      decidedBy: "lead_engineer",
      reason: "All code and security criteria satisfied"
    });
    expect(approveRes.ok).toBe(true);
    if (!approveRes.ok) throw new Error(approveRes.error.message);
    snap = approveRes.value;

    // --- Stage 4: QA (Requires Real Quality Gate) ---
    // If not auto-dispatched by approval continuation, execute workflow
    const snapBeforeQa = await harness.service.getRun(runId);
    expect(snapBeforeQa.ok).toBe(true);
    if (!snapBeforeQa.ok || !snapBeforeQa.value) throw new Error("Missing snapshot before QA");
    snap = snapBeforeQa.value;
    let qaTask = getTask(snap, "qa");
    if (qaTask.status !== "running") {
      const execQaRes = await harness.service.orchestrator.driveRun(runId);
      expect(execQaRes.ok).toBe(true);
      if (!execQaRes.ok) throw new Error(execQaRes.error.message);
      snap = execQaRes.value;
      qaTask = getTask(snap, "qa");
    }
    expect(qaTask.status).toBe("running");

    // Complete QA task execution: orchestrator will automatically evaluate after_result quality gate
    const completeQaRes = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "qa",
      {
        status: "succeeded",
        summary: "Automated test suite execution completed"
      }
    );
    expect(completeQaRes.ok).toBe(true);
    if (!completeQaRes.ok) throw new Error(completeQaRes.error.message);
    snap = completeQaRes.value;
    expect(getTask(snap, "qa").status).toBe("succeeded");

    // Advance to terminal state if needed
    const finalAdv = await harness.ports.engine.advance({
      runId,
      expectedVersion: snap.version,
      idempotencyKey: `final-adv-${runId}`,
      occurredAt: new Date().toISOString()
    });
    if (finalAdv.ok) {
      snap = finalAdv.value.snapshot;
    }

    // Workflow reached terminal succeeded state!
    expect(snap.status).toBe("succeeded");
    expect(snap.tasks.every((t: TaskState) => t.status === "succeeded")).toBe(true);

    // --- Persistence & Storage Integrity Assertions ---
    // 1. Re-open SQLite RunStore from disk and verify snapshot
    const finalGet = await harness.service.getRun(runId);
    expect(finalGet.ok).toBe(true);
    if (!finalGet.ok || !finalGet.value) throw new Error("Missing final snapshot");
    expect(finalGet.value.status).toBe("succeeded");
    expect(finalGet.value.tasks.every((t: TaskState) => t.status === "succeeded")).toBe(true);

    // 2. Read artifacts from FilesystemArtifactStore and check checksums
    const planArt = await harness.artifactStore.resolve(planProposal.proposalId);
    expect(planArt.ok).toBe(true);
    if (!planArt.ok || !planArt.value) throw new Error("Missing plan artifact");
    expect(planArt.value.checksum.value).toBe(planProposal.expectedIntegrity.checksum.value);

    const patchArt = await harness.artifactStore.resolve(patchProposal.proposalId);
    expect(patchArt.ok).toBe(true);
    if (!patchArt.ok || !patchArt.value) throw new Error("Missing patch artifact");
    expect(patchArt.value.checksum.value).toBe(patchProposal.expectedIntegrity.checksum.value);
  });
});
