import { describe, expect, it, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createE2eHarness, type E2eHarness } from "../helpers/harness.js";
import {
  createArtifactProposal,
  createGatedSingleTaskWorkflow,
  createRealNodeUnitTestGate,
  createStandardMvpWorkflow,
  createStrictTapParser,
  expectOk
} from "../helpers/fixtures.js";
import type {
  AgentExecutionHandle,
  QualityGate,
  TaskState,
  WorkflowDefinition
} from "@ai-flow/contracts";

import { pathToFileURL } from "node:url";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

async function runSigkillSubprocess(config: {
  readonly dbPath: string;
  readonly artifactsDir: string;
  readonly registryPath: string;
  readonly ledgerFile: string;
  readonly runId: string;
  readonly definition: WorkflowDefinition;
  readonly crashAt: "dispatch" | "receipt" | "binding";
}): Promise<{ signal: NodeJS.Signals | null; code: number | null; stderr: string }> {
  const persistenceUrl = pathToFileURL(resolve(REPO_ROOT, "packages/persistence/dist/index.js")).href;
  const artifactStoreUrl = pathToFileURL(resolve(REPO_ROOT, "packages/artifact-store/dist/index.js")).href;
  const agentRegistryUrl = pathToFileURL(resolve(REPO_ROOT, "packages/agent-registry/dist/index.js")).href;
  const coreUrl = pathToFileURL(resolve(REPO_ROOT, "packages/core/dist/index.js")).href;
  const runtimeUrl = pathToFileURL(resolve(REPO_ROOT, "packages/runtime/dist/index.js")).href;

  const workerScript = `
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openSqliteRunStore } from ${JSON.stringify(persistenceUrl)};
import { openFilesystemArtifactStore } from ${JSON.stringify(artifactStoreUrl)};
import { FileAgentRegistry } from ${JSON.stringify(agentRegistryUrl)};
import { DeterministicWorkflowEngine } from ${JSON.stringify(coreUrl)};
import { createRuntimeService } from ${JSON.stringify(runtimeUrl)};

const cfg = JSON.parse(process.argv[1]);
const runStoreRes = openSqliteRunStore({ filename: cfg.dbPath });
if (!runStoreRes.ok) throw new Error(runStoreRes.error.message);
const artifactStoreRes = await openFilesystemArtifactStore({
  root: cfg.artifactsDir,
  storeId: "e2e-artifact-store"
});
if (!artifactStoreRes.ok) throw new Error(artifactStoreRes.error.message);

const agentRegistry = new FileAgentRegistry({ stateFile: cfg.registryPath });
const engine = new DeterministicWorkflowEngine({
  resolveDefinition: (id, version) =>
    id === cfg.definition.id && version === cfg.definition.version ? cfg.definition : undefined
});

const transport = {
  async initialize() {
    return {
      ok: true,
      value: {
        transportName: "sigkill-child-transport",
        protocolVersion: "1.0",
        supportsStreaming: false,
        supportsCancellation: true,
        supportsResume: false,
        supportsSubmissionCorrelation: true
      }
    };
  },
  async send(request) {
    if (cfg.crashAt === "dispatch") {
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    const now = new Date().toISOString();
    const handle = {
      executionId: "exec-sigkill-" + randomUUID(),
      requestId: request.requestId,
      attemptId: request.attemptId,
      runId: request.runId,
      taskId: request.taskId,
      idempotencyKey: request.idempotency.key,
      target: request.target,
      correlation: {
        token: request.requestId,
        provenance: "transport",
        verified: true
      },
      acceptedAt: now
    };
    writeFileSync(cfg.ledgerFile, JSON.stringify(handle), "utf8");
    if (cfg.crashAt === "receipt") {
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    return {
      ok: true,
      value: {
        status: "accepted",
        requestId: request.requestId,
        attemptId: request.attemptId,
        runId: request.runId,
        taskId: request.taskId,
        observedAt: now,
        handle
      }
    };
  },
  async reconcile(request) {
    return {
      ok: true,
      value: {
        status: "unknown_delivery",
        requestId: request.requestId,
        retrySafe: false,
        observedAt: new Date().toISOString(),
        reason: "Child transport default reconcile",
        manualInterventionRequired: true
      }
    };
  },
  async cancel(handle, request) {
    return {
      ok: true,
      value: {
        schemaVersion: 1,
        cancellationId: request.cancellationId,
        status: "accepted",
        executionId: handle.executionId,
        observedAt: new Date().toISOString()
      }
    };
  },
  async wait(handle) {
    return {
      ok: true,
      value: {
        handle,
        state: "working",
        observedAt: new Date().toISOString(),
        correlationVerified: true
      }
    };
  },
  async *read() {}
};

const service = createRuntimeService({
  engine,
  runStore: runStoreRes.value,
  artifactStore: artifactStoreRes.value,
  agentRegistry,
  transport
});

const initRes = await service.init();
if (!initRes.ok) throw new Error(initRes.error.message);

const startRes = await service.start({
  runId: cfg.runId,
  definition: cfg.definition,
  input: { requirement: "SIGKILL boundary test: " + cfg.crashAt },
  idempotencyKey: "start-" + cfg.runId,
  requestedAt: new Date().toISOString()
});
if (!startRes.ok) throw new Error(startRes.error.message);

if (cfg.crashAt === "binding") {
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => {});
}
`;

  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", workerScript, JSON.stringify(config)],
      { cwd: REPO_ROOT, timeout: 15000 },
      (error, _stdout, stderr) => {
        const errObj = error as (Error & { code?: number | null; signal?: NodeJS.Signals | null }) | null;
        resolvePromise({
          signal: errObj?.signal ?? null,
          code: typeof errObj?.code === "number" ? errObj.code : null,
          stderr: stderr ?? ""
        });
      }
    );
  });
}

describe("Scenario E02 — Crash & Recovery Integration", () => {
  let harness: E2eHarness;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
    }
  });

  it("recovers workflow run state on honest running reopen across harness instance", async () => {
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

  it("recovers from real subprocess SIGKILL at dispatch boundary (task.dispatch_requested persisted before transport write)", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-sigkill-dispatch-${randomUUID()}`;
    const ledgerFile = join(harness.tmpDir, "dispatch-ledger.json");

    // Release parent store locks before spawning child process
    harness.runStore.close();
    harness.artifactStore.close();

    const childRes = await runSigkillSubprocess({
      dbPath: harness.dbPath,
      artifactsDir: harness.artifactsDir,
      registryPath: harness.registryPath,
      ledgerFile,
      runId,
      definition,
      crashAt: "dispatch"
    });
    expect(childRes.signal).toBe("SIGKILL");

    const restarted = await harness.restart();
    const eventsBeforeResume = expectOk(await restarted.runStore.readEvents(runId, { limit: 100 }));
    expect(eventsBeforeResume.items.some((e) => e.type === "task.dispatch_requested" && e.taskId === "plan")).toBe(true);
    expect(eventsBeforeResume.items.some((e) => e.type === "agent.execution_bound")).toBe(false);

    // Reconciliation confirms transport never received the interrupted dispatch
    harness.transport.setCustomReconcileHandler(async (req) => ({
      ok: true,
      value: {
        status: "not_delivered",
        requestId: req.requestId,
        retrySafe: true,
        observedAt: new Date().toISOString()
      }
    }));

    const resumedSnap = expectOk(await restarted.service.resume(runId));
    const planTask = resumedSnap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(planTask?.status).toBe("running");
    expect(planTask?.agentExecution).toBeDefined();
    expect(harness.transport.reconcileCallsCount).toBeGreaterThanOrEqual(1);
    expect(harness.transport.externalWriteCount).toBe(1);

    const eventsAfterResume = expectOk(await restarted.runStore.readEvents(runId, { limit: 100 }));
    expect(
      eventsAfterResume.items.some(
        (e) => e.type === "agent.delivery_reconciled" && e.payload.status === "not_delivered"
      )
    ).toBe(true);
  });

  it("recovers from real subprocess SIGKILL at receipt boundary (after external write, before execution binding)", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-sigkill-receipt-${randomUUID()}`;
    const ledgerFile = join(harness.tmpDir, "receipt-ledger.json");

    harness.runStore.close();
    harness.artifactStore.close();

    const childRes = await runSigkillSubprocess({
      dbPath: harness.dbPath,
      artifactsDir: harness.artifactsDir,
      registryPath: harness.registryPath,
      ledgerFile,
      runId,
      definition,
      crashAt: "receipt"
    });
    expect(childRes.signal).toBe("SIGKILL");

    // Load the handle written by the child transport right before SIGKILL into parent's server ledger
    const persistedHandle = JSON.parse(readFileSync(ledgerFile, "utf8")) as AgentExecutionHandle;
    harness.transport.serverLedger.set(persistedHandle.requestId, {
      handle: persistedHandle,
      status: "bound"
    });

    const restarted = await harness.restart();
    const eventsBeforeResume = expectOk(await restarted.runStore.readEvents(runId, { limit: 100 }));
    expect(eventsBeforeResume.items.some((e) => e.type === "task.dispatch_requested" && e.taskId === "plan")).toBe(true);
    expect(eventsBeforeResume.items.some((e) => e.type === "agent.execution_bound")).toBe(false);

    // Resume reconciles against serverLedger and binds the existing execution without re-sending
    const resumedSnap = expectOk(await restarted.service.resume(runId));
    const planTask = resumedSnap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(planTask?.status).toBe("running");
    expect(planTask?.agentExecution?.executionId).toBe(persistedHandle.executionId);
    expect(harness.transport.sendCallsCount).toBe(0);
    expect(harness.transport.reconcileCallsCount).toBeGreaterThanOrEqual(1);

    const eventsAfterResume = expectOk(await restarted.runStore.readEvents(runId, { limit: 100 }));
    expect(
      eventsAfterResume.items.some(
        (e) => e.type === "agent.delivery_reconciled" && e.payload.status === "bound"
      )
    ).toBe(true);
  });

  it("recovers from real subprocess SIGKILL at binding boundary (after agent.execution_bound persisted)", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-sigkill-binding-${randomUUID()}`;
    const ledgerFile = join(harness.tmpDir, "binding-ledger.json");

    harness.runStore.close();
    harness.artifactStore.close();

    const childRes = await runSigkillSubprocess({
      dbPath: harness.dbPath,
      artifactsDir: harness.artifactsDir,
      registryPath: harness.registryPath,
      ledgerFile,
      runId,
      definition,
      crashAt: "binding"
    });
    expect(childRes.signal).toBe("SIGKILL");

    const persistedHandle = JSON.parse(readFileSync(ledgerFile, "utf8")) as AgentExecutionHandle;
    harness.transport.serverLedger.set(persistedHandle.requestId, {
      handle: persistedHandle,
      status: "bound"
    });

    const restarted = await harness.restart();
    const eventsBeforeResume = expectOk(await restarted.runStore.readEvents(runId, { limit: 100 }));
    expect(eventsBeforeResume.items.some((e) => e.type === "agent.execution_bound" && e.taskId === "plan")).toBe(true);

    const resumedSnap = expectOk(await restarted.service.resume(runId));
    const planTask = resumedSnap.tasks.find((t: TaskState) => t.taskId === "plan");
    expect(planTask?.status).toBe("running");
    expect(planTask?.agentExecution?.executionId).toBe(persistedHandle.executionId);
    expect(harness.transport.sendCallsCount).toBe(0);

    // Complete task execution on the recovered runtime
    const { proposal, rawBytes } = createArtifactProposal({
      runId,
      taskId: "plan",
      kind: "document",
      logicalName: "plan.md",
      content: "Plan completed after SIGKILL at binding boundary"
    });
    const completeSnap = expectOk(
      await restarted.service.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        summary: "Completed after binding boundary SIGKILL",
        proposals: [proposal],
        contentByProposalId: { [proposal.proposalId]: rawBytes }
      })
    );
    expect(completeSnap.tasks.find((t: TaskState) => t.taskId === "plan")?.status).toBe("succeeded");
  });

  it("recovers pending human approval across harness.restart() and resumes workflow upon decision", async () => {
    const definition = createStandardMvpWorkflow();
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-approval-recovery-${randomUUID()}`;

    const gate = createRealNodeUnitTestGate({
      gateId: "qa-gate",
      workingDirectory: harness.tmpDir,
      testCount: 1,
      minPassedTestsCount: 1,
      outputParser: createStrictTapParser({ requirePlan: true, minPassedTestsCount: 1 })
    });
    harness.qualityGate.register("qa-gate", gate);

    expectOk(
      await harness.service.start({
        runId,
        definition,
        input: { requirement: "Approval recovery across restart" },
        idempotencyKey: `start-${runId}`,
        requestedAt: new Date().toISOString()
      })
    );

    // Complete plan and implement, driving workflow between stages
    expectOk(await harness.service.orchestrator.driveRun(runId));
    expectOk(
      await harness.service.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        summary: "Plan done"
      })
    );
    expectOk(await harness.service.orchestrator.driveRun(runId));
    expectOk(
      await harness.service.orchestrator.completeTaskExecution(runId, "implement", {
        status: "succeeded",
        summary: "Implement done"
      })
    );
    expectOk(await harness.service.orchestrator.driveRun(runId));

    // Complete review -> requests approval and pauses run in waiting while holding downstream qa pending
    const reviewWaitSnap = expectOk(
      await harness.service.orchestrator.completeTaskExecution(runId, "review", {
        status: "succeeded",
        summary: "Review ready for approval"
      })
    );
    expect(["waiting", "blocked", "running"]).toContain(reviewWaitSnap.status);
    expect(reviewWaitSnap.tasks.find((t: TaskState) => t.taskId === "review")?.status).toBe("succeeded");
    expect(reviewWaitSnap.tasks.find((t: TaskState) => t.taskId === "qa")?.status).toBe("pending");

    // Restart runtime while approval is pending
    const restarted = await harness.restart();
    const resumedSnap = expectOk(await restarted.service.resume(runId));
    expect(["waiting", "blocked", "running"]).toContain(resumedSnap.status);
    expect(resumedSnap.tasks.find((t: TaskState) => t.taskId === "review")?.status).toBe("succeeded");
    expect(resumedSnap.tasks.find((t: TaskState) => t.taskId === "qa")?.status).toBe("pending");

    // Verify pending approval.requested event is persisted
    const eventsPage = expectOk(await restarted.runStore.readEvents(runId, { limit: 100 }));
    const approvalReqEvent = eventsPage.items.find((e) => e.type === "approval.requested");
    expect(approvalReqEvent).toBeDefined();

    // Apply approval on the restarted runtime
    const approvedSnap = expectOk(
      await restarted.service.approve(runId, {
        decision: "approved",
        decidedBy: "security-reviewer",
        reason: "Approved after restart"
      })
    );

    expect(approvedSnap.tasks.find((t: TaskState) => t.taskId === "review")?.status).toBe("succeeded");
    expect(approvedSnap.tasks.find((t: TaskState) => t.taskId === "qa")?.status).toBe("running");
  });

  it("recovers pending quality gate (quality_gate.evaluation_requested) across harness.restart()", async () => {
    const gateId = "qa-recovery-gate";
    const taskId = "verify-task";
    const definition = createGatedSingleTaskWorkflow({
      id: "wf-pending-gate-recovery",
      taskId,
      gateId,
      required: true
    });
    harness = await createE2eHarness({ definitions: [definition] });
    const runId = `run-gate-recovery-${randomUUID()}`;

    // Initially register a gate that interrupts before producing a result (simulating crash after evaluation_requested)
    const interruptedGate: QualityGate = {
      id: gateId,
      async evaluate() {
        return {
          ok: false,
          error: {
            code: "transport_unavailable",
            retryable: true,
            message: "Process interrupted while quality gate evaluation was in flight"
          }
        };
      }
    };
    harness.qualityGate.register(gateId, interruptedGate);

    expectOk(
      await harness.service.start({
        runId,
        definition,
        input: { requirement: "Pending quality gate recovery" },
        idempotencyKey: `start-${runId}`,
        requestedAt: new Date().toISOString()
      })
    );

    const interruptedSnap = expectOk(
      await harness.service.orchestrator.completeTaskExecution(runId, taskId, {
        status: "succeeded",
        summary: "Task finished, entering quality gate"
      })
    );
    expect(interruptedSnap.tasks.find((t: TaskState) => t.taskId === taskId)?.status).toBe("waiting");

    // Verify quality_gate.evaluation_requested is persisted without quality_gate.evaluated
    const preRestartEvents = expectOk(await harness.runStore.readEvents(runId, { limit: 100 }));
    const reqEvent = preRestartEvents.items.find((e) => e.type === "quality_gate.evaluation_requested");
    expect(reqEvent).toBeDefined();
    expect(preRestartEvents.items.some((e) => e.type === "quality_gate.evaluated")).toBe(false);

    const preRestartSnap = expectOk(await harness.service.getRun(runId));
    expect(preRestartSnap?.tasks.find((t: TaskState) => t.taskId === taskId)?.status).toBe("waiting");

    // Register real passing gate and restart runtime
    const passingGate = createRealNodeUnitTestGate({
      gateId,
      workingDirectory: harness.tmpDir,
      testCount: 2,
      minPassedTestsCount: 2,
      outputParser: createStrictTapParser({ requirePlan: true, minPassedTestsCount: 2 })
    });
    harness.qualityGate.register(gateId, passingGate);

    const restarted = await harness.restart();
    const recoveredSnap = expectOk(await restarted.service.resume(runId));

    expect(recoveredSnap.status).toBe("succeeded");
    expect(recoveredSnap.tasks.find((t: TaskState) => t.taskId === taskId)?.status).toBe("succeeded");

    const postRestartEvents = expectOk(await restarted.runStore.readEvents(runId, { limit: 100 }));
    const evalEvent = postRestartEvents.items.find((e) => e.type === "quality_gate.evaluated");
    expect(evalEvent).toBeDefined();
    if (reqEvent?.type === "quality_gate.evaluation_requested" && evalEvent?.type === "quality_gate.evaluated") {
      expect(evalEvent.payload.evaluationId).toBe(reqEvent.payload.evaluationId);
      expect(evalEvent.payload.status).toBe("passed");
    }
  });
});
