import { describe, expect, it, afterEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  createSafeSubprocessGate,
  createStandardMvpWorkflow,
  createStrictTapParser,
  expectOk,
  readArtifactBytes
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

    // 1. Register real CommandQualityGate running a real Node.js test suite producing valid TAP output
    // Parsed using strict, fail-closed TAP parser enforcing plan (1..15) and minPassedTestsCount (15)
    const realGate = createSafeSubprocessGate({
      gateId,
      workingDirectory: harness.tmpDir,
      scriptBody: `
        console.log("TAP version 13");
        console.log("1..15");
        for (let i = 1; i <= 15; i++) {
          console.log("ok " + i + " - SDLC unit test #" + i);
        }
        console.log("# tests 15");
        console.log("# pass 15");
        console.log("# fail 0");
        process.exit(0);
      `,
      required: true,
      minPassedTestsCount: 15,
      outputParser: createStrictTapParser({ requirePlan: true, minPassedTestsCount: 15 })
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

    // Create plan artifact proposal
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
    const execImpRes = await harness.service.orchestrator.driveRun(runId);
    snap = expectOk(execImpRes);
    expect(getTask(snap, "implement").status).toBe("running");

    // Create implementation patch proposal
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

    // Complete QA task execution: orchestrator evaluates after_result quality gate
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
    // 1. Read artifacts from FilesystemArtifactStore and check checksums + read actual bytes
    const planArt = await harness.artifactStore.resolve(planProposal.proposalId);
    const planRef = expectOk(planArt);
    expect(planRef).not.toBeNull();
    expect(planRef!.checksum.value).toBe(planProposal.expectedIntegrity.checksum.value);

    // Read actual bytes from store stream and verify exact content hash and size
    const planBytesRead = expectOk(await readArtifactBytes(harness.artifactStore, planRef!));
    expect(createHash("sha256").update(planBytesRead).digest("hex")).toBe(planProposal.expectedIntegrity.checksum.value);
    expect(planBytesRead.byteLength).toBe(planProposal.expectedIntegrity.sizeBytes);

    const patchArt = await harness.artifactStore.resolve(patchProposal.proposalId);
    const patchRef = expectOk(patchArt);
    expect(patchRef).not.toBeNull();
    expect(patchRef!.checksum.value).toBe(patchProposal.expectedIntegrity.checksum.value);

    const patchBytesRead = expectOk(await readArtifactBytes(harness.artifactStore, patchRef!));
    expect(createHash("sha256").update(patchBytesRead).digest("hex")).toBe(patchProposal.expectedIntegrity.checksum.value);
    expect(patchBytesRead.byteLength).toBe(patchProposal.expectedIntegrity.sizeBytes);

    // 2. Re-open / restart harness from disk and verify durable state across restart
    const restarted = await harness.restart();
    const durableGet = await restarted.service.getRun(runId);
    const durableSnap = expectOk(durableGet);
    expect(durableSnap).not.toBeNull();
    expect(durableSnap!.status).toBe("succeeded");
    expect(durableSnap!.tasks.every((t: TaskState) => t.status === "succeeded")).toBe(true);

    const durablePlanArt = await restarted.artifactStore.resolve(planProposal.proposalId);
    const durablePlanRef = expectOk(durablePlanArt);
    expect(durablePlanRef).not.toBeNull();
    expect(durablePlanRef!.checksum.value).toBe(planProposal.expectedIntegrity.checksum.value);
  });
});
