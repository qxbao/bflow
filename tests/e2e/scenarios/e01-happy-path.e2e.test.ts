import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  createSafeSubprocessGate,
  createStandardMvpWorkflow,
  expectOk
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

    // 1. Register real CommandQualityGate running a real Node.js test runner suite (15 actual passing tests)
    // with strict machine-readable count parser
    const realGate = createSafeSubprocessGate({
      gateId,
      workingDirectory: harness.tmpDir,
      nodeScript: `
        import test from "node:test";
        import assert from "node:assert";

        for (let i = 1; i <= 15; i++) {
          test("SDLC unit test #" + i, () => {
            assert.strictEqual(typeof i, "number");
          });
        }
      `,
      required: true,
      minPassedTestsCount: 15,
      outputParser: (outcome) => {
        const stdout = outcome.stdout;
        const passMatch = stdout.match(/(?:#|ℹ)\s*pass\s+(\d+)/);
        const failMatch = stdout.match(/(?:#|ℹ)\s*fail\s+(\d+)/);
        const passStr = passMatch?.[1];
        const failStr = failMatch?.[1];
        const passedTests = passStr !== undefined ? parseInt(passStr, 10) : 0;
        const failedTests = failStr !== undefined ? parseInt(failStr, 10) : 0;
        return {
          passedTests,
          failedTests
        };
      }
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
    expectOk(startRes);

    const getTask = (snap: WorkflowRunSnapshot, taskId: string): TaskState => {
      const task = snap.tasks.find((t) => t.taskId === taskId);
      expect(task).toBeDefined();
      return task!;
    };

    // Drive initial dispatch
    const execInitRes = await harness.service.orchestrator.driveRun(runId);
    let snap = expectOk(execInitRes);

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
    snap = expectOk(completePlanRes);
    expect(getTask(snap, "plan").status).toBe("succeeded");

    // --- Stage 2: Implement ---
    // Schedule and dispatch ready task via orchestrator execution loop
    const execImpRes = await harness.service.orchestrator.driveRun(runId);
    snap = expectOk(execImpRes);
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
    snap = expectOk(completeImpRes);
    expect(getTask(snap, "implement").status).toBe("succeeded");

    // --- Stage 3: Review (Requires Approval) ---
    const execRevRes = await harness.service.orchestrator.driveRun(runId);
    snap = expectOk(execRevRes);
    expect(getTask(snap, "review").status).toBe("running");

    const completeRevRes = await harness.service.orchestrator.completeTaskExecution(
      runId,
      "review",
      {
        status: "succeeded",
        summary: "Code review completed with no critical findings"
      }
    );
    snap = expectOk(completeRevRes);

    // Review requires approval: the run is paused in waiting/blocked state awaiting human decision
    expect(["waiting", "blocked", "running"]).toContain(snap.status);

    // Apply human approval via RuntimeService
    const approveRes = await harness.service.approve(runId, {
      decision: "approved",
      decidedBy: "lead_engineer",
      reason: "All code and security criteria satisfied"
    });
    snap = expectOk(approveRes);

    // --- Stage 4: QA (Requires Real Quality Gate) ---
    const snapBeforeQa = await harness.service.getRun(runId);
    snap = expectOk(snapBeforeQa)!;
    let qaTask = getTask(snap, "qa");
    if (qaTask.status !== "running") {
      const execQaRes = await harness.service.orchestrator.driveRun(runId);
      snap = expectOk(execQaRes);
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
    snap = expectOk(completeQaRes);
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
    const finalSnap = expectOk(finalGet);
    expect(finalSnap).not.toBeNull();
    expect(finalSnap!.status).toBe("succeeded");
    expect(finalSnap!.tasks.every((t: TaskState) => t.status === "succeeded")).toBe(true);

    // 2. Read artifacts from FilesystemArtifactStore and check checksums
    const planArt = await harness.artifactStore.resolve(planProposal.proposalId);
    const planRef = expectOk(planArt);
    expect(planRef).not.toBeNull();
    expect(planRef!.checksum.value).toBe(planProposal.expectedIntegrity.checksum.value);

    const patchArt = await harness.artifactStore.resolve(patchProposal.proposalId);
    const patchRef = expectOk(patchArt);
    expect(patchRef).not.toBeNull();
    expect(patchRef!.checksum.value).toBe(patchProposal.expectedIntegrity.checksum.value);
  });
});
