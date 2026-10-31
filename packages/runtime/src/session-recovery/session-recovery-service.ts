import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  AgentReconciliationRequest,
  AgentRegistry,
  AgentTargetLocator,
  AgentTransport,
  AppendEventsRequest,
  ArtifactStore,
  CreateCheckpointCommand,
  OperationOptions,
  OperationResult,
  RecoveryCheckpoint,
  RunStore,
  SessionManifest,
  TaskState,
  WorkflowEngine
} from "@bflow/contracts";
import {
  CreateCheckpointCommandSchema,
  RecoveryCheckpointSchema,
  SessionManifestSchema,
  WorkflowAggregateCheckpointStateSchema
} from "@bflow/contracts";
import { recoverWorkflowRun, type RecoveryPorts } from "../recovery.js";
import type { JournalState, Outbound } from "../agentic/journal.js";
import { digest } from "../agentic/journal.js";
import { runtimeGitDirectoryFlags } from "../agentic/patch-paths.js";
import type { PanePolicy, TaskWorktree } from "../agentic/ports.js";
import type { StructuredLogger } from "../resilience/structured-logger.js";
import type { ObservabilityTracker } from "../observability/metrics.js";
import type {
  ContextDriftReport,
  ProjectContextService,
  RoleTaskContextBundle
} from "../context/project-context-service.js";

const execFileAsync = promisify(execFile);

async function execGit(cwd: string, args: readonly string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) {
      env[key] = value;
    }
  }
  const dirFlags = await runtimeGitDirectoryFlags(cwd);
  const { stdout } = await execFileAsync("git", [...dirFlags, ...args], { cwd, env });
  return stdout;
}

export type DisconnectionMode = "graceful_shutdown" | "crash" | "transient_disconnect";

export interface CheckpointedRunSummary {
  readonly runId: string;
  readonly version: number;
  readonly eventSequence: number;
  readonly checkpointId: string;
}

export interface GracefulShutdownReceipt {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly quiesced: true;
  readonly checkpointedRuns: readonly CheckpointedRunSummary[];
  readonly checkpointedRunIds?: readonly string[] | undefined;
  readonly stoppedAt: string;
}

export interface AgentDiscrepancyRecord {
  readonly kind: "agent_lost" | "agent_replaced" | "orphan_agent";
  readonly role: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly expectedPaneId?: string | undefined;
  readonly actualPaneId?: string | undefined;
  readonly expectedAgentId?: string | undefined;
  readonly actualAgentId?: string | undefined;
  readonly leaseRevoked: boolean;
  readonly reason: string;
}

export interface SessionRecoveryObservation {
  readonly operation?: {
    readonly repositoryId?: string | undefined;
    readonly sessionName?: string | undefined;
    readonly phase?: "server_starting" | "manager_pending" | "ready" | "stopping" | "down" | undefined;
  } | null | undefined;
  readonly savedManifest?: SessionManifest | null | undefined;
  readonly shutdownReceipt?: GracefulShutdownReceipt | null | undefined;
  readonly serverRunning: boolean;
  readonly liveManifest?: SessionManifest | null | undefined;
  readonly roleHealth?: Readonly<Record<string, {
    readonly readyForPrompt?: boolean | undefined;
    readonly occupantMatches?: boolean | undefined;
    readonly paneId?: string | undefined;
    readonly agentId?: string | undefined;
    readonly transportState?: string | undefined;
  }>> | undefined;
  readonly inFlightOutbound?: readonly { readonly messageId: string; readonly runId?: string | undefined; readonly taskId?: string | undefined; readonly status: string }[] | readonly Outbound[] | undefined;
  readonly unflushedPendingCore?: readonly string[] | readonly AppendEventsRequest[] | undefined;
  readonly activeRuns?: readonly {
    readonly runId: string;
    readonly version: number;
    readonly lastEventSequence: number;
    readonly latestCheckpointVersion?: number | null | undefined;
  }[] | undefined;
  readonly uncheckpointedActiveRuns?: readonly string[] | undefined;
}

export interface DisconnectionClassification {
  readonly mode: DisconnectionMode;
  readonly reason: string;
  readonly details: {
    readonly serverRunning: boolean;
    readonly operationPhase?: string | undefined;
    readonly manifestStatus?: string | undefined;
    readonly hasValidShutdownReceipt: boolean;
    readonly stuckSendingOutboundCount: number;
    readonly unflushedPendingCoreCount: number;
    readonly uncheckpointedActiveRunsCount: number;
    readonly lostOrReplacedAgentsCount: number;
  };
}

export interface WorktreeInspectionReport {
  readonly exists: boolean;
  readonly currentBranch: string;
  readonly branchMatches: boolean;
  readonly headCommitHash: string;
  readonly baseCommitHash: string;
  readonly isDescendantOfBase: boolean;
  readonly unmergedCommits: readonly string[];
  readonly dirtyFiles: readonly string[];
  readonly hasUnmergedWork: boolean;
  readonly staleTaskStateDetected?: boolean | undefined;
  readonly preservedHeadCommitHash?: string | undefined;
  readonly unmergedCommitsPreserved?: boolean | undefined;
}

export interface OrphanReconciliationResult {
  readonly releasedPanes: readonly string[];
  readonly releasedDeveloperTaskIds?: readonly string[] | undefined;
  readonly releasedLeases: readonly string[];
  readonly preservedWorktrees: readonly string[];
}

export interface DispatchReconciliationResult {
  readonly taskId: string;
  readonly runId: string;
  readonly promptResendAllowed: boolean;
  readonly status: "reconciled_bound" | "blocked" | "ready_to_resend" | "unknown";
  readonly reason: string;
  readonly manualInterventionRequired?: boolean | undefined;
  readonly unverifiedWorktreeProgress?: boolean | undefined;
  readonly unmergedCommitsPreserved?: boolean | undefined;
  readonly contextDrifted?: boolean | undefined;
}

export interface SessionRecoveryReport {
  readonly classification: DisconnectionClassification;
  readonly flushedBatchesCount: number;
  readonly deduplicatedInboxCount: number;
  readonly deduplicatedOutboundCount: number;
  readonly conflictingDigestsCount: number;
  readonly recoveredRuns: readonly string[];
  readonly reconciledTasks: readonly string[];
  readonly orphanReconciliation: OrphanReconciliationResult;
  readonly agentDiscrepancies: readonly AgentDiscrepancyRecord[];
  readonly worktreeInspections: readonly WorktreeInspectionReport[];
  readonly dispatchReconciliations: readonly DispatchReconciliationResult[];
  readonly contextDriftReports?: readonly ContextDriftReport[] | undefined;
}

export interface ActiveLeaseRecord {
  readonly leaseId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly fencingToken?: number | undefined;
  readonly version?: number | undefined;
}

export interface SessionRecoveryPorts {
  readonly engine: WorkflowEngine;
  readonly runStore: RunStore;
  readonly transport: AgentTransport;
  readonly agentRegistry?: AgentRegistry | undefined;
  readonly artifactStore?: ArtifactStore | undefined;
  readonly panes?: PanePolicy | undefined;
  readonly journal?: {
    readonly exclusive: <T>(action: (state: JournalState, save: () => Promise<void>) => Promise<T>) => Promise<T>;
    readonly readState?: () => Promise<JournalState>;
  } | undefined;
  readonly repositoryRoot?: string | undefined;
  readonly stateDirectory?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly logger?: StructuredLogger | undefined;
  readonly observability?: ObservabilityTracker | undefined;
  readonly contextService?: ProjectContextService | undefined;
  readonly preparedContextBundles?: readonly RoleTaskContextBundle[] | undefined;
  readonly activeLeases?: readonly ActiveLeaseRecord[] | undefined;
}

/**
 * Classifies disconnection mode into graceful_shutdown, transient_disconnect, or crash.
 */
export function classifyDisconnectionMode(
  observation: SessionRecoveryObservation
): DisconnectionClassification {
  const serverRunning = observation.serverRunning;
  const operationPhase = observation.operation?.phase;
  const manifestStatus = observation.savedManifest?.status;
  const shutdownReceipt = observation.shutdownReceipt;

  const inFlightOutbound = observation.inFlightOutbound ?? [];
  const stuckSendingOutbound = inFlightOutbound.filter((o) => {
    const s = typeof o === "object" && o !== null && "status" in o ? o.status : "";
    return s === "sending" || s === "unknown_delivery";
  });
  const unflushedPendingCore = observation.unflushedPendingCore ?? [];

  const uncheckpointedActiveRuns =
    observation.uncheckpointedActiveRuns !== undefined
      ? [...observation.uncheckpointedActiveRuns]
      : observation.activeRuns?.filter(
          (r) =>
            r.latestCheckpointVersion === undefined ||
            r.latestCheckpointVersion === null ||
            r.latestCheckpointVersion < r.version
        ).map((r) => r.runId) ?? [];

  let lostOrReplacedAgentsCount = 0;
  if (observation.roleHealth) {
    for (const health of Object.values(observation.roleHealth)) {
      if (
        health.occupantMatches === false ||
        health.transportState === "disconnected" ||
        health.transportState === "unknown"
      ) {
        lostOrReplacedAgentsCount++;
      }
    }
  }

  // A shutdownReceipt is ONLY valid for isGraceful if:
  // - shutdownReceipt.quiesced === true
  // - !serverRunning (or operationPhase === "down" and manifestStatus === "down")
  // - savedManifest?.stoppedAt === undefined || shutdownReceipt.stoppedAt >= savedManifest.stoppedAt
  // - uncheckpointedActiveRuns.length === 0 and every active run is accounted for in shutdownReceipt.checkpointedRuns at current version
  // - inFlightOutbound.length === 0 and unflushedPendingCore.length === 0 and lostOrReplacedAgentsCount === 0
  let isShutdownReceiptValid = false;
  if (shutdownReceipt && shutdownReceipt.quiesced === true) {
    const timeValid =
      observation.savedManifest?.stoppedAt === undefined ||
      Date.parse(shutdownReceipt.stoppedAt) >= Date.parse(observation.savedManifest.stoppedAt) - 1000;

    const activeRunsAccountedFor = (observation.activeRuns ?? []).every((activeRun) =>
      shutdownReceipt.checkpointedRuns.some(
        (cp) => cp.runId === activeRun.runId && cp.version >= activeRun.version
      )
    );

    if (
      timeValid &&
      activeRunsAccountedFor &&
      uncheckpointedActiveRuns.length === 0 &&
      stuckSendingOutbound.length === 0 &&
      unflushedPendingCore.length === 0 &&
      lostOrReplacedAgentsCount === 0 &&
      (!serverRunning || (operationPhase === "down" && manifestStatus === "down"))
    ) {
      isShutdownReceiptValid = true;
    }
  }

  // 1. Graceful shutdown
  const isGraceful =
    isShutdownReceiptValid ||
    (operationPhase === "down" &&
      manifestStatus === "down" &&
      Boolean(observation.savedManifest?.stoppedAt) &&
      stuckSendingOutbound.length === 0 &&
      unflushedPendingCore.length === 0 &&
      uncheckpointedActiveRuns.length === 0 &&
      lostOrReplacedAgentsCount === 0);

  if (isGraceful) {
    return {
      mode: "graceful_shutdown",
      reason: "Graceful shutdown verified: clean down state, valid manifest stoppedAt, no in-flight requests, and all runs checkpointed.",
      details: {
        serverRunning,
        ...(operationPhase !== undefined ? { operationPhase } : {}),
        ...(manifestStatus !== undefined ? { manifestStatus } : {}),
        hasValidShutdownReceipt: isShutdownReceiptValid,
        stuckSendingOutboundCount: stuckSendingOutbound.length,
        unflushedPendingCoreCount: unflushedPendingCore.length,
        uncheckpointedActiveRunsCount: uncheckpointedActiveRuns.length,
        lostOrReplacedAgentsCount
      }
    };
  }

  // 2. Transient disconnect:
  // ONLY applies when serverRunning === true, manifestStatus is "up" or "degraded",
  // operationPhase is NOT "down" / "stopping", stuckSendingOutbound.length === 0,
  // unflushedPendingCore.length === 0, and lostOrReplacedAgentsCount === 0.
  const isTransient =
    serverRunning &&
    (manifestStatus === "up" || manifestStatus === "degraded" || manifestStatus === undefined) &&
    operationPhase !== "down" &&
    operationPhase !== "stopping" &&
    stuckSendingOutbound.length === 0 &&
    unflushedPendingCore.length === 0 &&
    lostOrReplacedAgentsCount === 0;

  if (isTransient) {
    return {
      mode: "transient_disconnect",
      reason: "Transient disconnect verified: Herdr server is running, manifest is active, live pane occupants match all bindings, and no stuck transport requests detected.",
      details: {
        serverRunning,
        ...(operationPhase !== undefined ? { operationPhase } : {}),
        ...(manifestStatus !== undefined ? { manifestStatus } : {}),
        hasValidShutdownReceipt: isShutdownReceiptValid,
        stuckSendingOutboundCount: stuckSendingOutbound.length,
        unflushedPendingCoreCount: unflushedPendingCore.length,
        uncheckpointedActiveRunsCount: uncheckpointedActiveRuns.length,
        lostOrReplacedAgentsCount
      }
    };
  }

  // 3. Crash
  const crashReasons: string[] = [];
  if (!serverRunning) {
    crashReasons.push("Herdr server stopped unexpectedly while session was active");
  }
  if (stuckSendingOutbound.length > 0) {
    crashReasons.push(`${stuckSendingOutbound.length} outbound message(s) stuck in 'sending' state`);
  }
  if (unflushedPendingCore.length > 0) {
    crashReasons.push(`${unflushedPendingCore.length} pendingCore batch(es) left unflushed`);
  }
  if (lostOrReplacedAgentsCount > 0) {
    crashReasons.push(`${lostOrReplacedAgentsCount} bound agent pane(s) died, disconnected, or occupant was replaced`);
  }
  if (uncheckpointedActiveRuns.length > 0) {
    crashReasons.push(`${uncheckpointedActiveRuns.length} active run(s) had uncheckpointed version increments`);
  }
  if (manifestStatus === "down" || operationPhase === "down") {
    crashReasons.push("Session was marked down but has uncheckpointed runs, lost agents, or pending state");
  }
  if (crashReasons.length === 0) {
    crashReasons.push("Session state interrupted abnormally without graceful shutdown barrier");
  }

  return {
    mode: "crash",
    reason: `Crash detected: ${crashReasons.join("; ")}`,
    details: {
      serverRunning,
      ...(operationPhase !== undefined ? { operationPhase } : {}),
      ...(manifestStatus !== undefined ? { manifestStatus } : {}),
      hasValidShutdownReceipt: isShutdownReceiptValid,
      stuckSendingOutboundCount: stuckSendingOutbound.length,
      unflushedPendingCoreCount: unflushedPendingCore.length,
      uncheckpointedActiveRunsCount: uncheckpointedActiveRuns.length,
      lostOrReplacedAgentsCount
    }
  };
}

/**
 * Inspects a Git worktree to verify branch, commits, and clean/dirty status.
 * Never runs destructive Git commands.
 */
export async function inspectWorktreeState(
  worktreePath: string,
  expectedBranch: string,
  baseCommitHash: string,
  _repositoryRoot?: string
): Promise<WorktreeInspectionReport> {
  try {
    await access(worktreePath, constants.R_OK | constants.W_OK);
  } catch {
    return {
      exists: false,
      currentBranch: "",
      branchMatches: false,
      headCommitHash: "",
      baseCommitHash,
      isDescendantOfBase: false,
      unmergedCommits: [],
      dirtyFiles: [],
      hasUnmergedWork: false
    };
  }

  let isInsideWorkTree = false;
  try {
    const res = await execGit(worktreePath, ["rev-parse", "--is-inside-work-tree"]);
    isInsideWorkTree = res.trim() === "true";
  } catch {
    isInsideWorkTree = false;
  }

  if (!isInsideWorkTree) {
    return {
      exists: false,
      currentBranch: "",
      branchMatches: false,
      headCommitHash: "",
      baseCommitHash,
      isDescendantOfBase: false,
      unmergedCommits: [],
      dirtyFiles: [],
      hasUnmergedWork: false
    };
  }

  let currentBranch = "";
  try {
    currentBranch = (await execGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  } catch {
    currentBranch = "";
  }
  const branchMatches = expectedBranch.length > 0 ? currentBranch === expectedBranch : true;

  let headCommitHash = "";
  try {
    headCommitHash = (await execGit(worktreePath, ["rev-parse", "HEAD"])).trim();
  } catch {
    headCommitHash = "";
  }

  let isDescendantOfBase = false;
  if (baseCommitHash.length > 0 && headCommitHash.length > 0) {
    try {
      await execGit(worktreePath, ["merge-base", "--is-ancestor", baseCommitHash, headCommitHash]);
      isDescendantOfBase = true;
    } catch {
      isDescendantOfBase = false;
    }
  }

  let unmergedCommits: string[] = [];
  if (baseCommitHash.length > 0 && headCommitHash.length > 0 && isDescendantOfBase) {
    try {
      const out = await execGit(worktreePath, ["rev-list", "--reverse", `${baseCommitHash}..${headCommitHash}`]);
      unmergedCommits = out.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    } catch {
      unmergedCommits = [];
    }
  }

  let dirtyFiles: string[] = [];
  try {
    const statusOut = await execGit(worktreePath, ["status", "--porcelain=v1", "--untracked-files=normal"]);
    dirtyFiles = statusOut.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  } catch {
    dirtyFiles = [];
  }

  const hasUnmergedWork = unmergedCommits.length > 0 || dirtyFiles.length > 0;
  const staleTaskStateDetected = hasUnmergedWork ? true : undefined;
  const preservedHeadCommitHash = hasUnmergedWork ? headCommitHash : undefined;
  const unmergedCommitsPreserved = hasUnmergedWork ? true : undefined;

  return {
    exists: true,
    currentBranch,
    branchMatches,
    headCommitHash,
    baseCommitHash,
    isDescendantOfBase,
    unmergedCommits,
    dirtyFiles,
    hasUnmergedWork,
    ...(staleTaskStateDetected !== undefined ? { staleTaskStateDetected } : {}),
    ...(preservedHeadCommitHash !== undefined ? { preservedHeadCommitHash } : {}),
    ...(unmergedCommitsPreserved !== undefined ? { unmergedCommitsPreserved } : {})
  };
}

/**
 * Strictly prevents blind prompt resend and verifies worktree progress.
 */
export async function reconcileDispatchIntent(
  params: {
    runId: string;
    taskId: string;
    taskState: TaskState;
    outbound?: Outbound | undefined;
    worktree?: TaskWorktree | undefined;
    engine: WorkflowEngine;
    runStore: RunStore;
    transport: AgentTransport;
    clock?: (() => Date) | undefined;
  },
  options?: OperationOptions
): Promise<DispatchReconciliationResult> {
  const clock = params.clock ?? (() => new Date());

  // 1. Inspect task worktree if available
  if (params.worktree && params.worktree.worktreePath) {
    const inspection = await inspectWorktreeState(
      params.worktree.worktreePath,
      params.worktree.branchName,
      params.worktree.baseCommitHash
    );

    if (inspection.hasUnmergedWork) {
      return {
        taskId: params.taskId,
        runId: params.runId,
        promptResendAllowed: false,
        status: "blocked",
        reason: "Agent made worktree modifications or commits before response was received; blind prompt resend prevented.",
        manualInterventionRequired: true,
        unverifiedWorktreeProgress: true,
        unmergedCommitsPreserved: true
      };
    }
  }

  // 2. Query transport reconciliation
  const requestId =
    params.taskState.agentExecution?.requestId ??
    params.outbound?.request?.requestId ??
    `req-${params.taskId}`;
  const attemptId =
    params.taskState.attemptId ??
    params.outbound?.attemptId ??
    "attempt-1";
  const target: AgentTargetLocator =
    params.taskState.agentExecution?.target ??
    params.outbound?.request?.target ??
    {
      transport: "herdr",
      agentId: `agent-${params.taskId}`,
      paneId: `pane-${params.taskId}`
    };

  const reconRequest: AgentReconciliationRequest = {
    requestId,
    attemptId,
    runId: params.runId,
    taskId: params.taskId,
    idempotencyKey: `recon-dispatch:${requestId}`,
    target,
    requestedAt: clock().toISOString()
  };

  const reconRes = await params.transport.reconcile(reconRequest, options);
  if (!reconRes.ok) {
    return {
      taskId: params.taskId,
      runId: params.runId,
      promptResendAllowed: false,
      status: "blocked",
      reason: `Transport reconciliation failed: ${reconRes.error.message}`,
      manualInterventionRequired: true
    };
  }

  const recon = reconRes.value;

  if (recon.status === "bound") {
    return {
      taskId: params.taskId,
      runId: params.runId,
      promptResendAllowed: false,
      status: "reconciled_bound",
      reason: "Execution handle reconciled as bound on transport; duplicate resend prevented."
    };
  }

  if (recon.status === "unknown_delivery") {
    return {
      taskId: params.taskId,
      runId: params.runId,
      promptResendAllowed: false,
      status: "blocked",
      reason: "Transport reported unknown delivery; manual intervention required to verify remote state.",
      manualInterventionRequired: true
    };
  }

  if (recon.status === "not_delivered") {
    if (recon.retrySafe) {
      return {
        taskId: params.taskId,
        runId: params.runId,
        promptResendAllowed: true,
        status: "ready_to_resend",
        reason: "Transport confirmed request was not delivered and retry is safe; clean worktree verified."
      };
    }
    return {
      taskId: params.taskId,
      runId: params.runId,
      promptResendAllowed: false,
      status: "blocked",
      reason: "Transport reported not_delivered but retrySafe is false.",
      manualInterventionRequired: true
    };
  }

  return {
    taskId: params.taskId,
    runId: params.runId,
    promptResendAllowed: false,
    status: "unknown",
    reason: "Unrecognized reconciliation status",
    manualInterventionRequired: true
  };
}

/**
 * Finds orphan developer panes and leases, releasing them safely without deleting worktrees.
 */
export async function detectAndReconcileOrphanAgents(
  params: {
    panes?: PanePolicy | undefined;
    agentRegistry?: AgentRegistry | undefined;
    activeTasks: ReadonlySet<string>;
    terminalRuns?: ReadonlySet<string> | undefined;
    activeLeases?: readonly ActiveLeaseRecord[] | undefined;
    clock?: (() => Date) | undefined;
  },
  options?: OperationOptions
): Promise<OperationResult<OrphanReconciliationResult & { agentDiscrepancies: readonly AgentDiscrepancyRecord[] }>> {
  const clock = params.clock ?? (() => new Date());
  const releasedPanes: string[] = [];
  const releasedDeveloperTaskIds: string[] = [];
  const releasedLeases: string[] = [];
  const preservedWorktrees: string[] = [];
  const agentDiscrepancies: AgentDiscrepancyRecord[] = [];

  if (params.panes) {
    const manifestRes = await params.panes.getManifest(options);
    if (manifestRes.ok && manifestRes.value) {
      const manifest = manifestRes.value;
      const developerPanes = manifest.panes.filter(
        (p) => p.role === "developer" && p.permanent !== true
      );

      for (const pane of developerPanes) {
        const associatedTaskId = (pane.metadata?.["taskId"] as string | undefined) ?? pane.paneId;
        const associatedRunId = pane.metadata?.["runId"] as string | undefined;

        const isTerminalRun = associatedRunId !== undefined && (params.terminalRuns?.has(associatedRunId) ?? false);
        const isOrphan = isTerminalRun || !params.activeTasks.has(associatedTaskId);

        if (isOrphan) {
          if (pane.worktreePath) {
            const inspection = await inspectWorktreeState(pane.worktreePath, "", "");
            if (inspection.hasUnmergedWork) {
              preservedWorktrees.push(pane.worktreePath);
            }
          }

          await params.panes.releaseDeveloper(
            {
              taskId: associatedTaskId,
              closePane: true,
              removeWorktree: false
            },
            options
          );
          releasedPanes.push(pane.paneId);
          releasedDeveloperTaskIds.push(associatedTaskId);

          agentDiscrepancies.push({
            kind: "orphan_agent",
            role: "developer",
            ...(associatedRunId !== undefined ? { runId: associatedRunId } : {}),
            taskId: associatedTaskId,
            expectedPaneId: pane.paneId,
            leaseRevoked: false,
            reason: "Orphan dynamic developer pane has no active task or belongs to a terminal run"
          });
        }
      }
    }
  }

  // Release orphan leases
  if (params.agentRegistry && params.activeLeases) {
    for (const lease of params.activeLeases) {
      const isTerminalRun = params.terminalRuns?.has(lease.runId) ?? false;
      const isTaskActive = params.activeTasks.has(lease.taskId) || params.activeTasks.has(`${lease.runId}:${lease.taskId}`);
      if (isTerminalRun || !isTaskActive) {
        const releaseRes = await params.agentRegistry.releaseLease(
          {
            leaseId: lease.leaseId,
            fencingToken: lease.fencingToken ?? 1,
            expectedVersion: lease.version ?? 0,
            releasedAt: clock().toISOString(),
            idempotencyKey: `orphan-release-lease:${lease.leaseId}`
          },
          options
        ).catch(() => ({ ok: false, error: { message: "release failed" } }));

        if (releaseRes.ok) {
          releasedLeases.push(lease.leaseId);
        }
      }
    }
  }

  return {
    ok: true,
    value: {
      releasedPanes,
      releasedDeveloperTaskIds,
      releasedLeases,
      preservedWorktrees,
      agentDiscrepancies
    }
  };
}

export class SessionRecoveryService {
  private readonly ports: SessionRecoveryPorts;
  private readonly clock: () => Date;
  private readonly sessionId: string;
  private readonly repositoryRoot: string;
  private readonly stateDirectory?: string | undefined;
  private isQuiesced = false;
  private readonly checkpointedRuns: CheckpointedRunSummary[] = [];
  private readonly registeredLeases: ActiveLeaseRecord[] = [];

  constructor(ports: SessionRecoveryPorts) {
    this.ports = ports;
    this.clock = ports.clock ?? (() => new Date());
    this.sessionId = ports.sessionId ?? "default-session";
    this.repositoryRoot = ports.repositoryRoot ?? process.cwd();
    this.stateDirectory = ports.stateDirectory;
  }

  get quiesced(): boolean {
    return this.isQuiesced;
  }

  registerActiveLease(lease: ActiveLeaseRecord): void {
    this.registeredLeases.push(lease);
  }

  classifyDisconnectionMode(observation: SessionRecoveryObservation): DisconnectionClassification {
    return classifyDisconnectionMode(observation);
  }

  async inspectWorktreeState(
    worktreePath: string,
    expectedBranch: string,
    baseCommitHash: string,
    repositoryRoot?: string
  ): Promise<WorktreeInspectionReport> {
    return inspectWorktreeState(worktreePath, expectedBranch, baseCommitHash, repositoryRoot ?? this.repositoryRoot);
  }

  async observeSessionState(options?: OperationOptions): Promise<SessionRecoveryObservation> {
    const stateDir = this.stateDirectory ?? resolve(this.repositoryRoot, ".bflow/state");

    let operation: SessionRecoveryObservation["operation"] = null;
    try {
      const raw = await readFile(join(stateDir, "operation.json"), "utf8");
      operation = JSON.parse(raw);
    } catch {
      operation = null;
    }

    let savedManifest: SessionManifest | null = null;
    try {
      const raw = await readFile(join(stateDir, "session.json"), "utf8");
      savedManifest = SessionManifestSchema.parse(JSON.parse(raw));
    } catch {
      savedManifest = null;
    }

    let shutdownReceipt: GracefulShutdownReceipt | null = null;
    try {
      const raw = await readFile(join(stateDir, "shutdown-receipt.json"), "utf8");
      shutdownReceipt = JSON.parse(raw);
    } catch {
      shutdownReceipt = null;
    }

    let liveManifest: SessionManifest | null = null;
    let serverRunning = false;
    if (this.ports.panes) {
      const manifestRes = await this.ports.panes.getManifest(options);
      if (manifestRes.ok && manifestRes.value !== null) {
        liveManifest = manifestRes.value;
        serverRunning = true;
      }
    }

    // Read journal state if available
    let journalState: JournalState | null = null;
    if (this.ports.journal) {
      if (typeof (this.ports.journal as { readState?: () => Promise<JournalState> }).readState === "function") {
        journalState = await (this.ports.journal as { readState: () => Promise<JournalState> }).readState();
      } else if (typeof this.ports.journal.exclusive === "function") {
        journalState = await this.ports.journal.exclusive(async (state) => state);
      }
    }

    const inFlightOutbound = journalState?.outbound
      .filter((o) => o.status === "sending" || o.status === "unknown_delivery")
      .map((o) => ({
        messageId: o.message.message_id,
        runId: o.message.run_id ?? o.request?.runId,
        taskId: o.taskId,
        status: o.status
      })) ?? [];

    const unflushedPendingCore = journalState?.pendingCore.map((p) => p.runId) ?? [];

    // Active runs and latest checkpoints from RunStore
    const activeRuns: {
      runId: string;
      version: number;
      lastEventSequence: number;
      latestCheckpointVersion?: number | null | undefined;
    }[] = [];
    const uncheckpointedActiveRuns: string[] = [];

    const storeRunsRes = await this.ports.runStore.find(
      { status: ["queued", "running", "waiting", "blocked", "cancelling"], limit: 500 },
      options
    );

    if (storeRunsRes.ok) {
      for (const stored of storeRunsRes.value.items) {
        const cpRes = await this.ports.runStore.loadLatestCheckpoint(stored.snapshot.runId, options);
        const cpVersion = cpRes.ok && cpRes.value !== null ? cpRes.value.version : null;
        activeRuns.push({
          runId: stored.snapshot.runId,
          version: stored.snapshot.version,
          lastEventSequence: stored.snapshot.lastEventSequence,
          latestCheckpointVersion: cpVersion
        });

        const inShutdownReceipt = shutdownReceipt?.checkpointedRuns?.some(
          (c) => c.runId === stored.snapshot.runId && c.version >= stored.snapshot.version
        );
        if (cpVersion === null || cpVersion < stored.snapshot.version || !inShutdownReceipt) {
          uncheckpointedActiveRuns.push(stored.snapshot.runId);
        }
      }
    }

    // Role health
    const roleHealth: Record<string, {
      readyForPrompt?: boolean | undefined;
      occupantMatches?: boolean | undefined;
      paneId?: string | undefined;
      agentId?: string | undefined;
      transportState?: string | undefined;
    }> = {};

    if (serverRunning && this.ports.panes) {
      const rolesToCheck = new Set<string>();
      if (savedManifest) {
        for (const p of savedManifest.panes) rolesToCheck.add(p.role);
      }
      if (liveManifest) {
        for (const p of liveManifest.panes) rolesToCheck.add(p.role);
      }
      for (const role of rolesToCheck) {
        const inspectRes = await this.ports.panes.inspectRoleHealth(role, options);
        if (inspectRes.ok) {
          const h = inspectRes.value;
          const expectedPane = savedManifest?.panes.find((p) => p.role === role);
          const livePane = liveManifest?.panes.find((p) => p.role === role);

          let occupantMatches = h.occupantMatches;
          let transportState = livePane?.transportState ?? (h.readyForPrompt ? "idle" : "working");

          if (expectedPane && livePane) {
            if (livePane.paneId !== expectedPane.paneId || livePane.agentId !== expectedPane.agentId) {
              occupantMatches = false;
            }
          } else if (expectedPane && !livePane) {
            occupantMatches = false;
            transportState = "disconnected";
          }

          roleHealth[role] = {
            readyForPrompt: h.readyForPrompt,
            occupantMatches,
            paneId: h.paneId,
            agentId: h.agentId,
            transportState
          };
        }
      }
    }

    return {
      operation,
      savedManifest,
      shutdownReceipt,
      serverRunning,
      liveManifest,
      roleHealth,
      inFlightOutbound,
      unflushedPendingCore,
      activeRuns,
      uncheckpointedActiveRuns
    };
  }

  createEnvironmentIntegrationCallbacks(): {
    quiesce: (options?: OperationOptions) => Promise<OperationResult<void>>;
    checkpoint: (command: CreateCheckpointCommand, options?: OperationOptions) => Promise<OperationResult<RecoveryCheckpoint>>;
  } {
    return {
      quiesce: async (options?: OperationOptions): Promise<OperationResult<void>> => {
        this.isQuiesced = true;
        if (this.ports.journal) {
          await this.ports.journal.exclusive(async (state, save) => {
            if (state.pendingCore.length > 0) {
              await this.flushPendingCoreIdempotently(state.pendingCore, options);
              state.pendingCore = [];
              await save();
            }
          });
        }
        return { ok: true, value: undefined };
      },
      checkpoint: async (command: CreateCheckpointCommand, options?: OperationOptions): Promise<OperationResult<RecoveryCheckpoint>> => {
        const parsedCmd = CreateCheckpointCommandSchema.safeParse(command);
        if (!parsedCmd.success) {
          return {
            ok: false,
            error: { code: "validation", retryable: false, message: parsedCmd.error.message }
          };
        }

        const engineCpRes = await this.ports.engine.createCheckpoint(parsedCmd.data, options);
        if (!engineCpRes.ok) return engineCpRes;

        const checkpoint = engineCpRes.value;
        const validCp = RecoveryCheckpointSchema.safeParse(checkpoint);
        if (!validCp.success) {
          return {
            ok: false,
            error: { code: "corruption", retryable: false, message: validCp.error.message }
          };
        }

        const validAgg = WorkflowAggregateCheckpointStateSchema.safeParse(checkpoint.state);
        if (!validAgg.success) {
          return {
            ok: false,
            error: { code: "validation", retryable: false, message: validAgg.error.message }
          };
        }

        const saveRes = await this.ports.runStore.saveCheckpoint(checkpoint, parsedCmd.data.expectedVersion, options);
        if (!saveRes.ok) return saveRes as OperationResult<RecoveryCheckpoint>;

        this.checkpointedRuns.push({
          runId: checkpoint.runId,
          version: checkpoint.version,
          eventSequence: checkpoint.eventSequence,
          checkpointId: checkpoint.checkpointId
        });

        return { ok: true, value: checkpoint };
      }
    };
  }

  async quiesceAndCheckpoint(options?: OperationOptions): Promise<OperationResult<GracefulShutdownReceipt>> {
    // Clear checkpointedRuns at start so repeated calls don't accumulate stale entries
    this.checkpointedRuns.length = 0;

    const callbacks = this.createEnvironmentIntegrationCallbacks();

    const quiesceRes = await callbacks.quiesce(options);
    if (!quiesceRes.ok) return quiesceRes as OperationResult<GracefulShutdownReceipt>;

    const findRes = await this.ports.runStore.find(
      { status: ["queued", "running", "waiting", "blocked", "cancelling"], limit: 500 },
      options
    );
    if (!findRes.ok) return findRes as OperationResult<GracefulShutdownReceipt>;

    for (const stored of findRes.value.items) {
      const command: CreateCheckpointCommand = {
        runId: stored.snapshot.runId,
        expectedVersion: stored.snapshot.version,
        checkpointId: `shutdown-${randomUUID()}`,
        createdAt: this.clock().toISOString()
      };
      const cpRes = await callbacks.checkpoint(command, options);
      if (!cpRes.ok) return cpRes as OperationResult<GracefulShutdownReceipt>;
    }

    const stoppedAt = this.clock().toISOString();
    const receipt: GracefulShutdownReceipt = {
      schemaVersion: 1,
      sessionId: this.sessionId,
      quiesced: true,
      checkpointedRuns: [...this.checkpointedRuns],
      checkpointedRunIds: this.checkpointedRuns.map((r) => r.runId),
      stoppedAt
    };

    const stateDir = this.stateDirectory ?? resolve(this.repositoryRoot, ".bflow/state");
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const target = join(stateDir, "shutdown-receipt.json");
    const temp = join(stateDir, `shutdown-receipt.${randomUUID()}.tmp`);
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(receipt, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temp, target);
    } finally {
      await rm(temp, { force: true });
    }

    return { ok: true, value: receipt };
  }

  async flushPendingCoreIdempotently(
    pendingBatches: readonly AppendEventsRequest[],
    options?: OperationOptions
  ): Promise<OperationResult<number>> {
    let flushedCount = 0;
    for (const batch of pendingBatches) {
      const runRes = await this.ports.runStore.get(batch.runId, options);
      if (!runRes.ok) return runRes as OperationResult<number>;
      if (runRes.value === null) continue;

      const currentSnap = runRes.value.snapshot;
      if (currentSnap.lastEventSequence >= batch.expectedLastSequence + batch.events.length) {
        flushedCount++;
        continue;
      }

      if (
        currentSnap.lastEventSequence === batch.expectedLastSequence &&
        currentSnap.version === batch.expectedVersion
      ) {
        const appendRes = await this.ports.runStore.appendEvents(batch, options);
        if (!appendRes.ok && appendRes.error.code !== "conflict") {
          return appendRes as OperationResult<number>;
        }
        flushedCount++;
      }
    }
    return { ok: true, value: flushedCount };
  }

  deduplicateJournalState(state: JournalState): {
    deduplicatedInboxCount: number;
    deduplicatedOutboundCount: number;
    conflictingDigestsCount: number;
  } {
    let deduplicatedInboxCount = 0;
    let deduplicatedOutboundCount = 0;
    let conflictingDigestsCount = 0;

    const seenInbox = new Map<string, { item: typeof state.inbox[number]; digest: string }>();
    for (const item of state.inbox) {
      const id = item.message.message_id;
      const d = digest(item.message);
      const existing = seenInbox.get(id);
      if (existing) {
        if (existing.digest === d) {
          deduplicatedInboxCount++;
          if (item.status === "applied" && existing.item.status !== "applied") {
            existing.item = item;
          }
        } else {
          conflictingDigestsCount++;
        }
      } else {
        seenInbox.set(id, { item, digest: d });
      }
    }
    state.inbox = Array.from(seenInbox.values()).map((e) => e.item);

    const seenOutbound = new Map<string, { out: Outbound; digest: string }>();
    for (const out of state.outbound) {
      const key = out.message.message_id || out.request?.idempotency.key || out.attemptId;
      const d = digest(out.message);
      const existing = seenOutbound.get(key);
      if (existing) {
        if (existing.digest === d) {
          deduplicatedOutboundCount++;
        } else {
          conflictingDigestsCount++;
        }
      } else {
        seenOutbound.set(key, { out, digest: d });
      }
    }
    state.outbound = Array.from(seenOutbound.values()).map((e) => e.out);

    return {
      deduplicatedInboxCount,
      deduplicatedOutboundCount,
      conflictingDigestsCount
    };
  }

  async detectAndReconcileOrphanAgents(
    activeTasks?: ReadonlySet<string>,
    terminalRuns?: ReadonlySet<string>,
    options?: OperationOptions
  ): Promise<OperationResult<OrphanReconciliationResult & { agentDiscrepancies: readonly AgentDiscrepancyRecord[] }>> {
    const tasks = activeTasks ?? new Set<string>();
    const allLeases = [...(this.ports.activeLeases ?? []), ...this.registeredLeases];

    return detectAndReconcileOrphanAgents(
      {
        panes: this.ports.panes,
        agentRegistry: this.ports.agentRegistry,
        activeTasks: tasks,
        terminalRuns,
        activeLeases: allLeases,
        clock: this.clock
      },
      options
    );
  }

  async reconcileDispatchIntent(
    params: {
      runId: string;
      taskId: string;
      taskState: TaskState;
      outbound?: Outbound | undefined;
      worktree?: TaskWorktree | undefined;
    },
    options?: OperationOptions
  ): Promise<DispatchReconciliationResult> {
    return reconcileDispatchIntent(
      {
        ...params,
        engine: this.ports.engine,
        runStore: this.ports.runStore,
        transport: this.ports.transport,
        clock: this.clock
      },
      options
    );
  }

  async recoverSession(options?: OperationOptions): Promise<OperationResult<SessionRecoveryReport>> {
    this.ports.logger?.log("info", "session.recovery.started", "Session recovery started", { sessionId: this.sessionId });

    // 1. Observe state and classify disconnection mode
    const observation = await this.observeSessionState(options);
    const classification = this.classifyDisconnectionMode(observation);

    this.ports.logger?.log(
      "info",
      "session.recovery.disconnection_classified",
      `Disconnection mode classified as ${classification.mode}`,
      { mode: classification.mode, reason: classification.reason }
    );

    let flushedBatchesCount = 0;
    let deduplicatedInboxCount = 0;
    let deduplicatedOutboundCount = 0;
    let conflictingDigestsCount = 0;

    let journalWorktrees: TaskWorktree[] = [];

    // 2. Flush pendingCore & deduplicate Journal
    if (this.ports.journal) {
      await this.ports.journal.exclusive(async (state, save) => {
        if (state.pendingCore.length > 0) {
          const flushRes = await this.flushPendingCoreIdempotently(state.pendingCore, options);
          if (flushRes.ok) {
            flushedBatchesCount = flushRes.value;
          }
          state.pendingCore = [];
        }
        const dedupRes = this.deduplicateJournalState(state);
        deduplicatedInboxCount = dedupRes.deduplicatedInboxCount;
        deduplicatedOutboundCount = dedupRes.deduplicatedOutboundCount;
        conflictingDigestsCount = dedupRes.conflictingDigestsCount;

        for (const run of state.runs) {
          for (const t of run.tasks) {
            if (Array.isArray(t.worktrees)) {
              journalWorktrees.push(...t.worktrees);
            }
          }
        }
        await save();
      });
    }

    // 3. Context Drift Detection
    const contextDriftReports: ContextDriftReport[] = [];
    const driftedTasks = new Set<string>();
    if (this.ports.contextService && this.ports.preparedContextBundles) {
      for (const bundle of this.ports.preparedContextBundles) {
        const drift = await this.ports.contextService.detectContextDrift(bundle);
        contextDriftReports.push(drift);
        if (drift.drifted && bundle.taskId) {
          driftedTasks.add(bundle.taskId);
        }
      }
    }

    // 4. Recover incomplete workflows from SQLite RunStore
    const recoveredRuns: string[] = [];
    const reconciledTasks: string[] = [];
    const activeTasks = new Set<string>();
    const terminalRuns = new Set<string>();
    const recoveredSnapshots: TaskState[] = [];
    const allAgentDiscrepancies: AgentDiscrepancyRecord[] = [];
    const releasedLeasesList: string[] = [];

    const incompleteRunsRes = await this.ports.runStore.find(
      { status: ["queued", "running", "waiting", "blocked", "cancelling"], limit: 500 },
      options
    );

    if (!incompleteRunsRes.ok) return incompleteRunsRes as OperationResult<SessionRecoveryReport>;

    const recoveryPorts: RecoveryPorts = {
      engine: this.ports.engine,
      runStore: this.ports.runStore,
      transport: this.ports.transport,
      clock: this.clock
    };

    for (const stored of incompleteRunsRes.value.items) {
      const runId = stored.snapshot.runId;

      // Pre-seed definition into engine before recovery
      const engineSnap = await this.ports.engine.getSnapshot(runId, options);
      if (!engineSnap.ok || engineSnap.value === null) {
        await this.ports.engine.createRun(
          {
            runId: `def-holder-${stored.definition.id}-${stored.definition.version}`,
            definition: stored.definition,
            idempotencyKey: `def-holder-${stored.definition.id}-${stored.definition.version}`,
            createdAt: this.clock().toISOString()
          },
          options
        ).catch(() => undefined);
      }

      const recRes = await recoverWorkflowRun(runId, recoveryPorts, options);
      if (recRes.ok) {
        recoveredRuns.push(runId);
        reconciledTasks.push(...recRes.value.reconciledTasks);

        // Feed domain events to ObservabilityTracker if present
        if (this.ports.observability) {
          const eventsRes = await this.ports.runStore.readEvents(runId, { limit: 1000 }, options);
          if (eventsRes.ok) {
            this.ports.observability.ingestDomainEvents(runId, eventsRes.value.items, recRes.value.snapshot);
          }
        }

        for (const task of recRes.value.snapshot.tasks) {
          recoveredSnapshots.push(task);
          if (["queued", "running", "waiting", "blocked", "cancelling"].includes(task.status)) {
            activeTasks.add(task.taskId);
            activeTasks.add(`${runId}:${task.taskId}`);
          }
        }
      }
    }

    // Collect terminal runs
    const terminalRunsRes = await this.ports.runStore.find(
      { status: ["succeeded", "failed", "cancelled"], limit: 500 },
      options
    );
    if (terminalRunsRes.ok) {
      for (const run of terminalRunsRes.value.items) {
        terminalRuns.add(run.snapshot.runId);
      }
    }

    // 5. Inspect Worktrees
    const worktreeInspections: WorktreeInspectionReport[] = [];
    const worktreesByTaskId = new Map<string, TaskWorktree>();

    for (const wt of journalWorktrees) {
      worktreesByTaskId.set(wt.key, wt);
      const rep = await this.inspectWorktreeState(wt.worktreePath, wt.branchName, wt.baseCommitHash);
      worktreeInspections.push(rep);
    }

    const panesToCheck = [...(observation.liveManifest?.panes ?? []), ...(observation.savedManifest?.panes ?? [])];
    for (const p of panesToCheck) {
      if (p.worktreePath) {
        const branch = (p.metadata?.["branch"] as string | undefined) ?? "";
        const taskId = (p.metadata?.["taskId"] as string | undefined) ?? p.paneId;
        worktreesByTaskId.set(taskId, {
          key: taskId,
          worktreePath: p.worktreePath,
          branchName: branch,
          baseCommitHash: ""
        });
        const rep = await this.inspectWorktreeState(p.worktreePath, branch, "");
        worktreeInspections.push(rep);
      }
    }

    // 6. Detect Lost/Replaced Agents, Release Stale Leases & Reconcile Dispatches
    const dispatchReconciliations: DispatchReconciliationResult[] = [];
    const allKnownLeases = [...(this.ports.activeLeases ?? []), ...this.registeredLeases];

    for (const stored of incompleteRunsRes.value.items) {
      const runId = stored.snapshot.runId;
      for (const task of stored.snapshot.tasks) {
        const wt = worktreesByTaskId.get(task.taskId);
        let taskHasUnmergedWork = false;

        if (wt && wt.worktreePath) {
          const wtInspection = await this.inspectWorktreeState(wt.worktreePath, wt.branchName, wt.baseCommitHash);
          taskHasUnmergedWork = wtInspection.hasUnmergedWork;
        }

        // Check if agent is lost or replaced
        if (task.agentExecution) {
          const handle = task.agentExecution;
          const role = (handle.target as { role?: string }).role ?? "developer";

          let isAgentLost = false;
          let isAgentReplaced = false;
          let actualPaneId: string | undefined;
          let actualAgentId: string | undefined;

          if (!observation.serverRunning) {
            isAgentLost = true;
          } else if (this.ports.panes) {
            const healthRes = await this.ports.panes.inspectRoleHealth(role, options);
            if (!healthRes.ok) {
              isAgentLost = true;
            } else {
              const h = healthRes.value;
              actualPaneId = h.paneId;
              actualAgentId = h.agentId;

              if (h.paneId !== handle.target.paneId || h.agentId !== handle.target.agentId || h.occupantMatches === false) {
                isAgentReplaced = true;
              } else if (h.readyForPrompt === false && observation.liveManifest?.panes.some((p) => p.paneId === h.paneId && p.transportState === "disconnected")) {
                isAgentLost = true;
              }
            }
          }

          if (isAgentLost || isAgentReplaced) {
            let leaseRevoked = false;
            if (this.ports.agentRegistry) {
              const matchingLeases = allKnownLeases.filter((l) => l.runId === runId && l.taskId === task.taskId);
              for (const l of matchingLeases) {
                const relRes = await this.ports.agentRegistry.releaseLease(
                  {
                    leaseId: l.leaseId,
                    fencingToken: l.fencingToken ?? 1,
                    expectedVersion: l.version ?? 0,
                    releasedAt: this.clock().toISOString(),
                    idempotencyKey: `recon-revoke-lease:${l.leaseId}`
                  },
                  options
                ).catch(() => ({ ok: false, error: { message: "release failed" } }));

                if (relRes.ok) {
                  leaseRevoked = true;
                  releasedLeasesList.push(l.leaseId);
                }
              }
            }

            allAgentDiscrepancies.push({
              kind: isAgentLost ? "agent_lost" : "agent_replaced",
              role,
              runId,
              taskId: task.taskId,
              expectedPaneId: handle.target.paneId,
              actualPaneId,
              expectedAgentId: handle.target.agentId,
              actualAgentId,
              leaseRevoked,
              reason: isAgentLost ? "Agent process / pane died or Herdr server stopped" : "Occupant in pane changed or agent replaced"
            });
          }
        }

        // Reconcile dispatch intent
        const isPendingOrSending =
          task.status === "running" ||
          task.status === "waiting" ||
          task.status === "blocked" ||
          taskHasUnmergedWork;

        if (isPendingOrSending) {
          const dispatchOutcome = await this.reconcileDispatchIntent(
            {
              runId,
              taskId: task.taskId,
              taskState: task,
              worktree: wt
            },
            options
          );

          const contextDrifted = driftedTasks.has(task.taskId) ? true : undefined;
          const finalOutcome: DispatchReconciliationResult = {
            ...dispatchOutcome,
            ...(contextDrifted !== undefined ? { contextDrifted } : {})
          };

          dispatchReconciliations.push(finalOutcome);

          // If task has unmerged work or prompt resend is prohibited, keep/transition task to blocked
          if (
            (taskHasUnmergedWork || finalOutcome.promptResendAllowed === false || allAgentDiscrepancies.some((d) => d.taskId === task.taskId)) &&
            (task.status === "running" || task.status === "waiting" || task.status === "ready" || task.status === "pending")
          ) {
            await this.ports.engine.transitionTask(
              {
                runId,
                taskId: task.taskId,
                expectedVersion: stored.snapshot.version,
                from: task.status,
                to: "blocked",
                intent: "normal",
                generationFrom: task.generation,
                generationTo: task.generation,
                reason: "Session recovery: unverified worktree modifications or lost/replaced agent",
                occurredAt: this.clock().toISOString(),
                idempotencyKey: `block-recovery:${runId}:${task.taskId}`
              },
              options
            ).catch(() => undefined);
          }
        }
      }
    }

    // 7. Orphan Agent Detection & Cleanup
    const orphanReconciliationRes = await this.detectAndReconcileOrphanAgents(activeTasks, terminalRuns, options);
    const orphanReconciliation = orphanReconciliationRes.ok
      ? orphanReconciliationRes.value
      : { releasedPanes: [], releasedDeveloperTaskIds: [], releasedLeases: [], preservedWorktrees: [], agentDiscrepancies: [] };

    if (orphanReconciliationRes.ok) {
      allAgentDiscrepancies.push(...orphanReconciliationRes.value.agentDiscrepancies);
      releasedLeasesList.push(...orphanReconciliationRes.value.releasedLeases);
    }

    const mergedOrphanReport: OrphanReconciliationResult = {
      releasedPanes: orphanReconciliation.releasedPanes,
      releasedDeveloperTaskIds: orphanReconciliation.releasedDeveloperTaskIds,
      releasedLeases: Array.from(new Set(releasedLeasesList)),
      preservedWorktrees: orphanReconciliation.preservedWorktrees
    };

    this.ports.logger?.log("info", "session.recovery.completed", "Session recovery completed", {
      recoveredRunsCount: recoveredRuns.length,
      reconciledTasksCount: reconciledTasks.length,
      discrepanciesCount: allAgentDiscrepancies.length
    });

    return {
      ok: true,
      value: {
        classification,
        flushedBatchesCount,
        deduplicatedInboxCount,
        deduplicatedOutboundCount,
        conflictingDigestsCount,
        recoveredRuns,
        reconciledTasks,
        orphanReconciliation: mergedOrphanReport,
        agentDiscrepancies: allAgentDiscrepancies,
        worktreeInspections,
        dispatchReconciliations,
        ...(contextDriftReports.length > 0 ? { contextDriftReports } : {})
      }
    };
  }
}
