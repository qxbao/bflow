import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type {
  AgentReconciliationRequest,
  AgentReconciliationResult,
  AppendEventsRequest,
  OperationResult,
  PaneBinding,
  RoleMessage,
  SessionManifest,
  Specification,
  TaskState
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import {
  classifyDisconnectionMode,
  detectAndReconcileOrphanAgents,
  inspectWorktreeState,
  reconcileDispatchIntent,
  SessionRecoveryService,
  type SessionRecoveryObservation
} from "../../src/session-recovery/index.js";
import { createRuntimeService } from "../../src/service.js";
import type { PanePolicy, TaskWorktree } from "../../src/agentic/ports.js";
import type { JournalState } from "../../src/agentic/journal.js";
import { ProjectContextService } from "../../src/context/project-context-service.js";
import { StructuredLogger } from "../../src/resilience/structured-logger.js";
import { ObservabilityTracker } from "../../src/observability/metrics.js";
import {
  createSampleWorkflowDefinition,
  createTestHarness
} from "../unit/fixtures.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) {
      env[key] = value;
    }
  }
  const { stdout } = await execFileAsync("git", [...args], { cwd, env });
  return stdout;
}

async function setupGitRepoAndWorktree(baseDir: string): Promise<{
  repoPath: string;
  worktreePath: string;
  branchName: string;
  baseCommitHash: string;
  headCommitHash: string;
}> {
  const repoPath = join(baseDir, "main-repo");
  const worktreePath = join(baseDir, "worktree-task-1");
  await mkdir(repoPath, { recursive: true });

  await runGit(repoPath, ["init", "-b", "main"]);
  await runGit(repoPath, ["config", "user.name", "Bflow Reliability Engineer"]);
  await runGit(repoPath, ["config", "user.email", "reliability@bflow.dev"]);
  await runGit(repoPath, ["commit", "--allow-empty", "-m", "chore: initial repository commit"]);

  const baseCommitHash = (await runGit(repoPath, ["rev-parse", "HEAD"])).trim();

  const branchName = "feature/task-worktree-1";
  await runGit(repoPath, ["branch", branchName]);
  await runGit(repoPath, ["worktree", "add", worktreePath, branchName]);

  // Make a commit in the worktree
  await writeFile(join(worktreePath, "feature.ts"), "export const feature = 'v1';\n");
  await runGit(worktreePath, ["add", "feature.ts"]);
  await runGit(worktreePath, ["commit", "-m", "feat: implement initial feature"]);

  const headCommitHash = (await runGit(worktreePath, ["rev-parse", "HEAD"])).trim();

  // Add an uncommitted dirty file
  await writeFile(join(worktreePath, "wip.txt"), "work in progress notes\n");

  return {
    repoPath,
    worktreePath,
    branchName,
    baseCommitHash,
    headCommitHash
  };
}

function createSampleManifest(sessionId: string, workspaceRoot: string): SessionManifest {
  const convPane: PaneBinding = {
    schemaVersion: 2,
    bindingId: "bind-conv-1",
    sessionId,
    role: "conversation",
    agentId: "agent-conv-1",
    workspaceId: "ws-1",
    tabId: "tab-1",
    paneId: "pane-conv-1",
    provider: "herdr",
    agentKind: "cli",
    cwd: workspaceRoot,
    isolationMode: "dedicated_pane",
    readOnlyWorkspace: true,
    transportState: "idle",
    boundAt: new Date().toISOString()
  };

  const coordPane: PaneBinding = {
    schemaVersion: 2,
    bindingId: "bind-coord-1",
    sessionId,
    role: "coordinator",
    agentId: "agent-coord-1",
    workspaceId: "ws-1",
    tabId: "tab-1",
    paneId: "pane-coord-1",
    provider: "herdr",
    agentKind: "cli",
    cwd: workspaceRoot,
    isolationMode: "dedicated_pane",
    readOnlyWorkspace: true,
    transportState: "idle",
    boundAt: new Date().toISOString()
  };

  return {
    schemaVersion: 2,
    sessionId,
    projectName: "sample-project",
    workspaceRoot,
    herdrWorkspaceId: "ws-1",
    herdrTabId: "tab-1",
    status: "up",
    conversationSessionId: "conv-sess-1",
    activeRunIds: [],
    panes: [convPane, coordPane],
    attachTarget: {
      role: "conversation",
      paneId: "pane-conv-1"
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function createFakePanePolicy(
  initialManifest: SessionManifest | null,
  roleHealth?: Record<string, { readyForPrompt?: boolean; occupantMatches?: boolean; paneId?: string; agentId?: string; transportState?: string }>
): PanePolicy & { manifest: SessionManifest | null; releasedDeveloperRequests: { taskId: string; closePane: boolean; removeWorktree: boolean }[] } {
  let currentManifest = initialManifest;
  const releasedDeveloperRequests: { taskId: string; closePane: boolean; removeWorktree: boolean }[] = [];

  return {
    get manifest() {
      return currentManifest;
    },
    releasedDeveloperRequests,
    getManifest: async () => ({ ok: true, value: currentManifest }),
    getRoleBinding: async (role: string) => {
      const pane = currentManifest?.panes.find((p) => p.role === role) ?? null;
      return { ok: true, value: pane };
    },
    inspectRoleHealth: async (role: string) => {
      if (roleHealth && roleHealth[role]) {
        const h = roleHealth[role]!;
        return {
          ok: true,
          value: {
            readyForPrompt: h.readyForPrompt ?? true,
            occupantMatches: h.occupantMatches ?? true,
            paneId: h.paneId ?? `pane-${role}`,
            agentId: h.agentId ?? `agent-${role}`
          }
        };
      }
      const pane = currentManifest?.panes.find((p) => p.role === role);
      return {
        ok: true,
        value: {
          readyForPrompt: pane ? ["idle", "done"].includes(pane.transportState) : false,
          occupantMatches: true,
          paneId: pane?.paneId ?? `pane-${role}`,
          agentId: pane?.agentId ?? `agent-${role}`
        }
      };
    },
    allocateDeveloper: async (req) => {
      const binding: PaneBinding = {
        schemaVersion: 2,
        bindingId: `bind-${req.taskId}`,
        sessionId: currentManifest?.sessionId ?? "default-session",
        role: "developer",
        agentId: `agent-dev-${req.taskId}`,
        workspaceId: "ws-1",
        tabId: "tab-1",
        paneId: `pane-dev-${req.taskId}`,
        provider: "herdr",
        agentKind: "cli",
        cwd: req.worktreePath,
        worktreePath: req.worktreePath,
        isolationMode: "dedicated_pane",
        readOnlyWorkspace: false,
        transportState: "idle",
        boundAt: new Date().toISOString(),
        metadata: { taskId: req.taskId, runId: req.runId }
      };
      if (currentManifest) {
        currentManifest = {
          ...currentManifest,
          panes: [...currentManifest.panes, binding]
        };
      }
      return { ok: true, value: binding };
    },
    releaseDeveloper: async (req) => {
      releasedDeveloperRequests.push(req);
      if (currentManifest) {
        currentManifest = {
          ...currentManifest,
          panes: currentManifest.panes.filter(
            (p) =>
              p.metadata?.["taskId"] !== req.taskId &&
              p.paneId !== req.taskId &&
              p.paneId !== `pane-dev-${req.taskId}`
          )
        };
      }
      return { ok: true, value: undefined };
    }
  };
}

describe("Scenario 9: Session Recovery & Distributed Reconciliation Reliability", { timeout: 45000 }, () => {
  // 9.1 Restart khi task đang chạy (Graceful bflow down -> bflow up & Crash restart)
  it("9.1: distinguishes graceful shutdown, crash, and transient disconnect; recovers unfinished workflows from SQLite checkpoint + event tail", async () => {
    const harness = await createTestHarness();
    try {
      const sessionId = "sess-recon-test-1";

      // Test 1.1: Classification of graceful_shutdown
      const gracefulObservation: SessionRecoveryObservation = {
        operation: { phase: "down", repositoryId: "repo-1", sessionName: sessionId },
        savedManifest: {
          ...createSampleManifest(sessionId, harness.tmpDir),
          status: "down",
          stoppedAt: new Date().toISOString()
        },
        shutdownReceipt: {
          schemaVersion: 1,
          sessionId,
          quiesced: true,
          checkpointedRuns: [{ runId: "run-1", version: 10, eventSequence: 20, checkpointId: "cp-1" }],
          checkpointedRunIds: ["run-1"],
          stoppedAt: new Date().toISOString()
        },
        serverRunning: false,
        inFlightOutbound: [],
        unflushedPendingCore: [],
        activeRuns: []
      };
      const gracefulClass = classifyDisconnectionMode(gracefulObservation);
      expect(gracefulClass.mode).toBe("graceful_shutdown");
      expect(gracefulClass.details.hasValidShutdownReceipt).toBe(true);

      // Test 1.2: Classification of crash (server stopped while manifest was up)
      const crashObservation: SessionRecoveryObservation = {
        operation: { phase: "ready", repositoryId: "repo-1", sessionName: sessionId },
        savedManifest: {
          ...createSampleManifest(sessionId, harness.tmpDir),
          status: "up"
        },
        serverRunning: false,
        activeRuns: [{ runId: "run-1", version: 2, lastEventSequence: 4, latestCheckpointVersion: 1 }]
      };
      const crashClass = classifyDisconnectionMode(crashObservation);
      expect(crashClass.mode).toBe("crash");
      expect(crashClass.details.serverRunning).toBe(false);

      // Test 1.3: Classification of transient_disconnect (server running, healthy occupants)
      const transientObservation: SessionRecoveryObservation = {
        serverRunning: true,
        savedManifest: createSampleManifest(sessionId, harness.tmpDir),
        roleHealth: {
          conversation: { occupantMatches: true, transportState: "idle", paneId: "pane-conv-1", agentId: "agent-conv-1" },
          coordinator: { occupantMatches: true, transportState: "idle", paneId: "pane-coord-1", agentId: "agent-coord-1" }
        },
        inFlightOutbound: [],
        unflushedPendingCore: []
      };
      const transientClass = classifyDisconnectionMode(transientObservation);
      expect(transientClass.mode).toBe("transient_disconnect");

      // Test 1.4: Real workflow restart recovery across engines
      const definition = createSampleWorkflowDefinition({ requiresApproval: true });
      const runId = `run-recovery-${randomUUID()}`;

      // Instance 1: start workflow and complete "plan"
      const service1 = createRuntimeService(harness.ports);
      await service1.startRun(definition, { runId });

      await service1.orchestrator.completeTaskExecution(runId, "plan", {
        status: "succeeded",
        summary: "Architecture and spec planned"
      });

      const snapAfterPlan = (await harness.engine.getSnapshot(runId)).value!;
      expect(snapAfterPlan.tasks.find((t) => t.taskId === "plan")?.status).toBe("succeeded");

      // Save aggregate checkpoint
      const cpRes = await harness.engine.createCheckpoint({
        runId,
        expectedVersion: snapAfterPlan.version,
        checkpointId: `cp-${runId}-1`,
        createdAt: new Date().toISOString()
      });
      expect(cpRes.ok).toBe(true);
      await harness.runStore.saveCheckpoint(cpRes.value, snapAfterPlan.version);

      // Advance so "implement" is scheduled & dispatched (in-flight execution)
      await service1.orchestrator.driveRun(runId);
      const snapAfterDispatch = (await harness.engine.getSnapshot(runId)).value!;
      const implementTask = snapAfterDispatch.tasks.find((t) => t.taskId === "implement")!;
      expect(implementTask.status).toBe("running");
      const boundHandle = implementTask.agentExecution!;
      expect(boundHandle).toBeDefined();

      // Crash & fresh DeterministicWorkflowEngine (with NO preloaded definitions)
      const freshEngine = new DeterministicWorkflowEngine();

      // Transport double reconciles handle as bound
      harness.transport.customReconcileHandler = (req: AgentReconciliationRequest): OperationResult<AgentReconciliationResult> => ({
        ok: true,
        value: { status: "bound", handle: boundHandle }
      });

      const recoveryService = new SessionRecoveryService({
        engine: freshEngine,
        runStore: harness.runStore,
        transport: harness.transport,
        sessionId,
        repositoryRoot: harness.tmpDir
      });

      // Recover session
      const recoveryResult = await recoveryService.recoverSession();
      expect(recoveryResult.ok).toBe(true);
      expect(recoveryResult.value.recoveredRuns).toContain(runId);
      expect(recoveryResult.value.reconciledTasks).toContain("implement");

      // Verify reconstructed snapshot in freshEngine
      const recoveredSnap = (await freshEngine.getSnapshot(runId)).value!;
      expect(recoveredSnap.tasks.find((t) => t.taskId === "plan")?.status).toBe("succeeded");
      const recoveredImplement = recoveredSnap.tasks.find((t) => t.taskId === "implement")!;
      expect(recoveredImplement.status).toBe("running");
      expect(recoveredImplement.agentExecution?.executionId).toBe(boundHandle.executionId);
    } finally {
      await harness.cleanup();
    }
  });

  // 9.2 Server Herdr chết (Herdr server death)
  it("9.2: classifies Herdr server death as crash; reconciles SQLite state with Herdr upon restart and detects lost panes", async () => {
    const harness = await createTestHarness();
    try {
      const sessionId = "sess-herdr-death-2";
      const definition = createSampleWorkflowDefinition();
      const runId = `run-herdr-death-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      await service.startRun(definition, { runId });

      // Plan succeeds and implement is running
      await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
      await service.orchestrator.driveRun(runId);

      const fakePanes = createFakePanePolicy(null); // Server died -> panes null

      const recoveryService = new SessionRecoveryService({
        engine: harness.engine,
        runStore: harness.runStore,
        transport: harness.transport,
        panes: fakePanes,
        sessionId,
        repositoryRoot: harness.tmpDir
      });

      // 1. Observe state: server is dead -> mode MUST be crash
      const observation = await recoveryService.observeSessionState();
      expect(observation.serverRunning).toBe(false);
      const classification = recoveryService.classifyDisconnectionMode(observation);
      expect(classification.mode).toBe("crash");

      // 2. recoverSession detects that agent was lost
      const recResult = await recoveryService.recoverSession();
      expect(recResult.ok).toBe(true);

      const agentLostDiscrepancy = recResult.value.agentDiscrepancies.find(
        (d) => d.kind === "agent_lost" && d.taskId === "implement"
      );
      expect(agentLostDiscrepancy).toBeDefined();

      // Task is safely in blocked, NOT false success
      const snap = (await harness.engine.getSnapshot(runId)).value!;
      const implementTask = snap.tasks.find((t) => t.taskId === "implement")!;
      expect(implementTask.status).toBe("blocked");
    } finally {
      await harness.cleanup();
    }
  });

  // 9.3 Agent bị thay thế (Agent replaced) & Orphan agent detection
  it("9.3: detects replaced agents, revokes stale leases, and detects/releases orphan developer panes without deleting worktrees", async () => {
    const harness = await createTestHarness();
    try {
      const sessionId = "sess-agent-replaced-3";
      const gitSetup = await setupGitRepoAndWorktree(harness.tmpDir);

      const definition = createSampleWorkflowDefinition();
      const runId = `run-agent-replaced-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      await service.startRun(definition, { runId });

      await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });
      await service.orchestrator.driveRun(runId);

      // Acquire a real lease on FileAgentRegistry
      const leaseId = `lease-dev-${randomUUID()}`;
      const leaseRes = await harness.agentRegistry.acquireLease({
        leaseId,
        agentId: "agent-developer-1",
        runId,
        taskId: "implement",
        attemptId: "att-1",
        ttlMs: 60000,
        requestedAt: new Date().toISOString(),
        idempotencyKey: `acquire-${leaseId}`
      });
      expect(leaseRes.ok).toBe(true);

      const baseManifest = createSampleManifest(sessionId, harness.tmpDir);

      // Live coordinator occupant was replaced
      // Developer pane occupant has DIFFERENT agentId
      const devPane: PaneBinding = {
        schemaVersion: 2,
        bindingId: "bind-dev-1",
        sessionId,
        role: "developer",
        agentId: "agent-developer-2", // Replaced agent! Expected agent-developer-1
        workspaceId: "ws-1",
        tabId: "tab-1",
        paneId: "pane-developer",
        provider: "herdr",
        agentKind: "cli",
        cwd: gitSetup.worktreePath,
        worktreePath: gitSetup.worktreePath,
        isolationMode: "dedicated_pane",
        readOnlyWorkspace: false,
        transportState: "idle",
        boundAt: new Date().toISOString(),
        metadata: { taskId: "implement", runId }
      };

      // Orphan dynamic developer pane
      const orphanPane: PaneBinding = {
        schemaVersion: 2,
        bindingId: "bind-dev-orphan",
        sessionId,
        role: "developer",
        agentId: "agent-dev-old",
        workspaceId: "ws-1",
        tabId: "tab-1",
        paneId: "pane-dev-orphan",
        provider: "herdr",
        agentKind: "cli",
        cwd: gitSetup.worktreePath,
        worktreePath: gitSetup.worktreePath,
        isolationMode: "dedicated_pane",
        readOnlyWorkspace: false,
        transportState: "idle",
        boundAt: new Date().toISOString(),
        metadata: { taskId: "task-orphan", runId: "run-terminal-1" }
      };

      baseManifest.panes.push(devPane, orphanPane);

      const fakePanes = createFakePanePolicy(baseManifest, {
        developer: {
          occupantMatches: false,
          paneId: "pane-developer",
          agentId: "agent-developer-2",
          transportState: "idle"
        }
      });

      const recoveryService = new SessionRecoveryService({
        engine: harness.engine,
        runStore: harness.runStore,
        transport: harness.transport,
        agentRegistry: harness.agentRegistry,
        panes: fakePanes,
        sessionId,
        repositoryRoot: harness.tmpDir,
        activeLeases: [
          {
            leaseId,
            agentId: "agent-developer-1",
            runId,
            taskId: "implement",
            attemptId: "att-1",
            fencingToken: leaseRes.value.fencingToken,
            version: leaseRes.value.version
          }
        ]
      });

      const recResult = await recoveryService.recoverSession();
      expect(recResult.ok).toBe(true);

      const report = recResult.value;
      // 1. Agent discrepancies include agent_replaced and orphan_agent
      expect(report.agentDiscrepancies.some((d) => d.kind === "agent_replaced" && d.taskId === "implement")).toBe(true);
      expect(report.agentDiscrepancies.some((d) => d.kind === "orphan_agent" && d.taskId === "task-orphan")).toBe(true);

      // 2. Lease was revoked
      expect(report.orphanReconciliation.releasedLeases).toContain(leaseId);

      // 3. Released developer task ids contains task-orphan
      expect(report.orphanReconciliation.releasedDeveloperTaskIds).toContain("task-orphan");

      // 4. Re-acquiring lease on FileAgentRegistry succeeds
      const reAcquire = await harness.agentRegistry.acquireLease({
        leaseId: `lease-new-${randomUUID()}`,
        agentId: "agent-developer-1",
        runId: "run-new-2",
        taskId: "implement",
        attemptId: "att-1",
        ttlMs: 60000,
        requestedAt: new Date().toISOString(),
        idempotencyKey: `reacquire-${randomUUID()}`
      });
      expect(reAcquire.ok).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  // 9.4 Prompt đã gửi nhưng phản hồi bị mất (Prompt sent, response lost)
  it("9.4: prevents blind prompt resend on unknown delivery or worktree progress; allows resend only on not_delivered with clean worktree", async () => {
    const harness = await createTestHarness();
    try {
      const gitSetup = await setupGitRepoAndWorktree(harness.tmpDir);

      const taskWorktree: TaskWorktree = {
        key: "wt-task-1",
        worktreePath: gitSetup.worktreePath,
        branchName: gitSetup.branchName,
        baseCommitHash: gitSetup.baseCommitHash
      };

      const taskState: TaskState = {
        taskId: "implement",
        status: "running",
        attempt: 1,
        generation: 0,
        attemptId: "att-1",
        version: 1
      };

      // Case 4a: Transport reconcile returns unknown_delivery -> promptResendAllowed must be FALSE
      harness.transport.customReconcileHandler = (): OperationResult<AgentReconciliationResult> => ({
        ok: true,
        value: { status: "unknown_delivery" }
      });

      const resUnknown = await reconcileDispatchIntent({
        runId: "run-1",
        taskId: "implement",
        taskState,
        worktree: undefined,
        engine: harness.engine,
        runStore: harness.runStore,
        transport: harness.transport
      });

      expect(resUnknown.promptResendAllowed).toBe(false);
      expect(resUnknown.status).toBe("blocked");
      expect(resUnknown.manualInterventionRequired).toBe(true);

      // Case 4b: Transport reports not_delivered, BUT worktree already has unmerged commits/dirty edits!
      harness.transport.customReconcileHandler = (): OperationResult<AgentReconciliationResult> => ({
        ok: true,
        value: { status: "not_delivered", retrySafe: true }
      });

      const resWithWorktreeEdits = await reconcileDispatchIntent({
        runId: "run-1",
        taskId: "implement",
        taskState,
        worktree: taskWorktree,
        engine: harness.engine,
        runStore: harness.runStore,
        transport: harness.transport
      });

      expect(resWithWorktreeEdits.promptResendAllowed).toBe(false);
      expect(resWithWorktreeEdits.status).toBe("blocked");
      expect(resWithWorktreeEdits.unverifiedWorktreeProgress).toBe(true);
      expect(resWithWorktreeEdits.unmergedCommitsPreserved).toBe(true);

      // Case 4c: Clean worktree AND transport confirms not_delivered with retrySafe: true
      const cleanDir = join(harness.tmpDir, "clean-worktree");
      await mkdir(cleanDir, { recursive: true });
      await runGit(cleanDir, ["init", "-b", "task/clean"]);
      await runGit(cleanDir, ["config", "user.name", "Tester"]);
      await runGit(cleanDir, ["config", "user.email", "tester@bflow.dev"]);
      await runGit(cleanDir, ["commit", "--allow-empty", "-m", "init"]);
      const cleanHead = (await runGit(cleanDir, ["rev-parse", "HEAD"])).trim();

      const cleanTaskWorktree: TaskWorktree = {
        key: "wt-clean",
        worktreePath: cleanDir,
        branchName: "task/clean",
        baseCommitHash: cleanHead
      };

      const resClean = await reconcileDispatchIntent({
        runId: "run-1",
        taskId: "implement",
        taskState,
        worktree: cleanTaskWorktree,
        engine: harness.engine,
        runStore: harness.runStore,
        transport: harness.transport
      });

      expect(resClean.promptResendAllowed).toBe(true);
      expect(resClean.status).toBe("ready_to_resend");
    } finally {
      await harness.cleanup();
    }
  });

  // 9.5 Worktree tồn tại nhưng task state bị lỗi thời (Worktree exists with commits while task state is stale)
  it("9.5: detects stale task state vs existing worktree; preserves head commit and does NOT auto-mark task as succeeded", async () => {
    const harness = await createTestHarness();
    try {
      const gitSetup = await setupGitRepoAndWorktree(harness.tmpDir);

      const report = await inspectWorktreeState(
        gitSetup.worktreePath,
        gitSetup.branchName,
        gitSetup.baseCommitHash
      );

      expect(report.exists).toBe(true);
      expect(report.branchMatches).toBe(true);
      expect(report.isDescendantOfBase).toBe(true);
      expect(report.unmergedCommits).toContain(gitSetup.headCommitHash);
      expect(report.dirtyFiles.length).toBeGreaterThan(0);
      expect(report.hasUnmergedWork).toBe(true);

      // Stale task state detected & unmerged commits preserved
      expect(report.staleTaskStateDetected).toBe(true);
      expect(report.preservedHeadCommitHash).toBe(gitSetup.headCommitHash);
      expect(report.unmergedCommitsPreserved).toBe(true);

      const taskState: TaskState = {
        taskId: "implement",
        status: "running",
        attempt: 1,
        generation: 0,
        version: 1
      };

      const taskWorktree: TaskWorktree = {
        key: "wt-task-1",
        worktreePath: gitSetup.worktreePath,
        branchName: gitSetup.branchName,
        baseCommitHash: gitSetup.baseCommitHash
      };

      const dispatchRecon = await reconcileDispatchIntent({
        runId: "run-1",
        taskId: "implement",
        taskState,
        worktree: taskWorktree,
        engine: harness.engine,
        runStore: harness.runStore,
        transport: harness.transport
      });

      expect(dispatchRecon.status).not.toBe("succeeded");
      expect(dispatchRecon.status).toBe("blocked");
      expect(dispatchRecon.unverifiedWorktreeProgress).toBe(true);
      expect(dispatchRecon.unmergedCommitsPreserved).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  // 9.6 Dữ liệu trạng thái trùng (Duplicate state data)
  it("9.6: handles duplicate pendingCore batches, duplicate inbox/outbound entries, and duplicate recovery idempotently", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = `run-dup-${randomUUID()}`;

      const service = createRuntimeService(harness.ports);
      await service.startRun(definition, { runId });

      const snap1 = (await harness.engine.getSnapshot(runId)).value!;

      const recoveryService = new SessionRecoveryService({
        engine: harness.engine,
        runStore: harness.runStore,
        transport: harness.transport,
        sessionId: "sess-dup-6",
        repositoryRoot: harness.tmpDir
      });

      // 6.1 Duplicate pendingCore event batches:
      const fakeBatch: AppendEventsRequest = {
        runId,
        expectedVersion: snap1.version,
        expectedLastSequence: snap1.lastEventSequence,
        events: [],
        idempotencyKey: "dup-batch-1"
      };

      const flushRes = await recoveryService.flushPendingCoreIdempotently([fakeBatch, fakeBatch]);
      expect(flushRes.ok).toBe(true);

      // 6.2 Deduplicate Journal State (duplicate inbox & outbound messages)
      const duplicateMsg: RoleMessage = {
        schema_version: 2,
        message_id: "msg-dup-123",
        correlation_id: "corr-123",
        run_id: runId,
        sender: { role: "conversation" },
        recipient: { role: "coordinator" },
        type: "delegation.request",
        payload: { title: "Implement feature" },
        artifact_references: []
      };

      const anotherMsg: RoleMessage = {
        schema_version: 2,
        message_id: "msg-another-456",
        correlation_id: "corr-456",
        run_id: runId,
        sender: { role: "conversation" },
        recipient: { role: "coordinator" },
        type: "delegation.request",
        payload: { title: "Another feature" },
        artifact_references: []
      };

      const conflictingMsg: RoleMessage = {
        ...duplicateMsg,
        payload: { title: "Conflict payload!" }
      };

      const journalState: JournalState = {
        version: 1,
        repository: harness.tmpDir,
        runs: [],
        outbound: [
          {
            message: duplicateMsg,
            status: "queued",
            selector: "dev",
            taskId: "implement",
            attemptId: "att-1",
            capabilities: ["dev"]
          },
          {
            message: duplicateMsg, // Exact duplicate
            status: "queued",
            selector: "dev",
            taskId: "implement",
            attemptId: "att-1",
            capabilities: ["dev"]
          }
        ],
        inbox: [
          { message: duplicateMsg, status: "received" },
          { message: duplicateMsg, status: "applied" },
          { message: conflictingMsg, status: "received" },
          { message: anotherMsg, status: "received" }
        ],
        pendingCore: [],
        pendingVerifications: []
      };

      const dedupResult = recoveryService.deduplicateJournalState(journalState);
      expect(dedupResult.deduplicatedInboxCount).toBe(1);
      expect(dedupResult.deduplicatedOutboundCount).toBe(1);
      expect(dedupResult.conflictingDigestsCount).toBe(1);
      expect(journalState.inbox.length).toBe(2);
      expect(journalState.outbound.length).toBe(1);

      // 6.3 Multiple recovery calls are idempotent
      const rec1 = await recoveryService.recoverSession();
      expect(rec1.ok).toBe(true);
      const rec2 = await recoveryService.recoverSession();
      expect(rec2.ok).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  // 9.7 Context bị thay đổi (Context changed before/during recovery)
  it("9.7: detects context and specification drift during recovery before tasks resume", async () => {
    const harness = await createTestHarness();
    try {
      const sessionId = "sess-drift-7";

      // Setup task-owned source file
      await writeFile(join(harness.tmpDir, "calculator.ts"), "export function add(a: number, b: number) { return a + b; }\n");

      const contextService = new ProjectContextService(harness.tmpDir);

      const spec: Specification = {
        schemaVersion: 2,
        specId: "spec-calc-1",
        sessionId,
        level: "lightweight",
        title: "Calculator Spec",
        summary: "Provide arithmetic calculator",
        problemStatement: "Need calculator functionality",
        scope: { inScope: ["calculator.ts"], outOfScope: [] },
        acceptanceCriteria: [
          {
            id: "crit-1",
            description: "addition works",
            category: "functional",
            verificationMethod: "unit_test",
            required: true,
            status: "pending",
            evidenceArtifactIds: []
          }
        ],
        affectedPaths: ["calculator.ts"],
        status: "draft",
        createdBy: "architect",
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await contextService.versionManager.registerSpecification(spec);

      const bundle = await contextService.prepareRoleTaskContext({
        role: "developer",
        taskId: "implement",
        title: "Implement calculator",
        description: "Implement calculator functions",
        runId: "run-drift-7",
        specId: "spec-calc-1",
        targetFiles: ["calculator.ts"],
        ownedPaths: ["calculator.ts"],
        affectedPaths: ["calculator.ts"]
      });

      // Now while session is down:
      // 1. Modify the source file
      await writeFile(join(harness.tmpDir, "calculator.ts"), "export function add(a: number, b: number) { return a + b + 1; /* modified */ }\n");

      // 2. Upgrade the specification to v2
      await contextService.versionManager.registerSpecification({
        ...spec,
        version: 2,
        title: "Calculator Spec v2"
      });

      const logger = new StructuredLogger({ minLevel: "debug" });
      const observability = new ObservabilityTracker();

      const recoveryService = new SessionRecoveryService({
        engine: harness.engine,
        runStore: harness.runStore,
        transport: harness.transport,
        contextService,
        preparedContextBundles: [bundle],
        logger,
        observability,
        sessionId,
        repositoryRoot: harness.tmpDir
      });

      const recResult = await recoveryService.recoverSession();
      expect(recResult.ok).toBe(true);

      const report = recResult.value;
      expect(report.contextDriftReports).toBeDefined();
      expect(report.contextDriftReports!.length).toBe(1);

      const driftReport = report.contextDriftReports![0]!;
      expect(driftReport.drifted).toBe(true);
      expect(driftReport.modifiedFiles).toContain("calculator.ts");
      expect(driftReport.specVersionDrifted).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  // 9.8 Recovery không được làm mất commit chưa hợp nhất (Unmerged commits preserved across recovery & orphan cleanup)
  it("9.8: verifies that unmerged commits and dirty files in task worktrees remain 100% intact after crash recovery and orphan cleanup", async () => {
    const harness = await createTestHarness();
    try {
      const gitSetup = await setupGitRepoAndWorktree(harness.tmpDir);

      // Make a second commit in the worktree
      await writeFile(join(gitSetup.worktreePath, "second-change.ts"), "export const second = true;\n");
      await runGit(gitSetup.worktreePath, ["add", "second-change.ts"]);
      await runGit(gitSetup.worktreePath, ["commit", "-m", "feat: second unmerged commit"]);

      const latestHead = (await runGit(gitSetup.worktreePath, ["rev-parse", "HEAD"])).trim();

      // Add another dirty uncommitted modification
      await writeFile(join(gitSetup.worktreePath, "dirty-edits.ts"), "// unstaged edits\n");

      // Verify Git state before recovery
      const preList = await runGit(gitSetup.worktreePath, ["rev-list", `${gitSetup.baseCommitHash}..HEAD`]);
      const preCommits = preList.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      expect(preCommits.length).toBe(2);
      expect(preCommits).toContain(latestHead);

      const preStatus = await runGit(gitSetup.worktreePath, ["status", "--porcelain"]);
      expect(preStatus).toContain("dirty-edits.ts");
      expect(preStatus).toContain("wip.txt");

      // Execute orphan reconciliation and worktree inspection
      const report = await inspectWorktreeState(
        gitSetup.worktreePath,
        gitSetup.branchName,
        gitSetup.baseCommitHash
      );

      expect(report.hasUnmergedWork).toBe(true);
      expect(report.unmergedCommits.length).toBe(2);
      expect(report.unmergedCommitsPreserved).toBe(true);

      const fakePanes = createFakePanePolicy(null);
      await detectAndReconcileOrphanAgents({
        panes: fakePanes,
        activeTasks: new Set<string>()
      });

      // Verify Git state AFTER recovery & orphan reconciliation: 100% INTACT!
      const postList = await runGit(gitSetup.worktreePath, ["rev-list", `${gitSetup.baseCommitHash}..HEAD`]);
      const postCommits = postList.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      expect(postCommits).toEqual(preCommits);

      const postStatus = await runGit(gitSetup.worktreePath, ["status", "--porcelain"]);
      expect(postStatus).toBe(preStatus);

      // Git head hash did not change
      const postHead = (await runGit(gitSetup.worktreePath, ["rev-parse", "HEAD"])).trim();
      expect(postHead).toBe(latestHead);
    } finally {
      await harness.cleanup();
    }
  });
});
