import type { DomainEvent, WorkflowRunSnapshot } from "@bflow/contracts";

export interface VerifiedModelUsage {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number | null;
  readonly source: "provider_reported";
  readonly recordedAt: string;
}

/**
 * Extracts and strictly validates provider-reported model usage.
 * STRICT INVARIANT: "Không tự suy đoán số token hoặc chi phí nếu nguồn dữ liệu không có".
 * Never estimates tokens or costs; returns null if data is unverified or malformed.
 */
export function extractVerifiedModelUsage(
  raw: unknown,
  clock?: () => Date
): VerifiedModelUsage | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;

  // Must have explicit provider reported provenance
  const isReported =
    obj["source"] === "provider_reported" ||
    obj["providerReported"] === true ||
    obj["verified"] === true;
  if (!isReported) {
    return null;
  }

  const provider = obj["provider"];
  if (typeof provider !== "string" || provider.trim().length === 0) {
    return null;
  }

  const model = obj["model"];
  if (typeof model !== "string" || model.trim().length === 0) {
    return null;
  }

  const inputTokens = obj["inputTokens"];
  if (typeof inputTokens !== "number" || !Number.isInteger(inputTokens) || inputTokens < 0) {
    return null;
  }

  const outputTokens = obj["outputTokens"];
  if (typeof outputTokens !== "number" || !Number.isInteger(outputTokens) || outputTokens < 0) {
    return null;
  }

  let totalTokens: number;
  const rawTotal = obj["totalTokens"];
  if (typeof rawTotal === "number" && Number.isInteger(rawTotal) && rawTotal >= 0) {
    totalTokens = rawTotal;
  } else {
    totalTokens = inputTokens + outputTokens;
  }

  let costUsd: number | null = null;
  const rawCost = obj["costUsd"];
  if (typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0) {
    costUsd = rawCost;
  }

  const nowClock = clock ?? (() => new Date());
  const recordedAt =
    typeof obj["recordedAt"] === "string" && obj["recordedAt"].length > 0
      ? obj["recordedAt"]
      : nowClock().toISOString();

  return {
    provider: provider.trim(),
    model: model.trim(),
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    source: "provider_reported",
    recordedAt
  };
}

export interface AgentAssignmentMetric {
  readonly assignmentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly role: string;
  readonly agentId: string;
  readonly paneId?: string | undefined;
  readonly leaseId?: string | undefined;
  readonly fencingToken?: string | undefined;
  readonly assignedAt: string;
  readonly releasedAt?: string | undefined;
  readonly status: "assigned" | "bound" | "verified" | "released" | "reconciled" | "failed" | "active";
}

export interface TaskDurationMetric {
  readonly taskId: string;
  readonly attempt: number;
  readonly startedAt?: string | undefined;
  readonly completedAt?: string | undefined;
  readonly durationMs: number;
  readonly status: string;
}

export interface VerificationCycleMetric {
  readonly cycleId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly scope: "task" | "workflow";
  readonly iterations: number;
  readonly maxIterations: number;
  readonly status: string;
  readonly durationMs: number;
  readonly findingsCount: number;
}

export interface TestCheckMetric {
  readonly checkId: string;
  readonly runId: string;
  readonly taskId?: string | undefined;
  readonly command?: string | undefined;
  readonly exitCode?: number | undefined;
  readonly status: "passed" | "failed" | "blocked" | "inconclusive";
  readonly evaluatedAt: string;
}

export interface TestMetrics {
  readonly totalChecks: number;
  readonly passedCount: number;
  readonly failedCount: number;
  readonly blockedCount: number;
  readonly inconclusiveCount: number;
  readonly passRate: number;
  readonly checks: readonly TestCheckMetric[];
}

export interface ContextBundleMetric {
  readonly runId: string;
  readonly taskId: string;
  readonly role: string;
  readonly contextBytes: number;
  readonly includedFileCount: number;
  readonly excludedFileCount: number;
  readonly specVersion?: number | string | undefined;
  readonly contextHash: string;
  readonly recordedAt: string;
}

export interface ContextMetrics {
  readonly totalContextBytes: number;
  readonly maxTaskContextBytes: number;
  readonly bundles: readonly ContextBundleMetric[];
}

export interface RunObservabilityReport {
  readonly runId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly runDurationMs: number;
  readonly taskDurations: readonly TaskDurationMetric[];
  readonly retryCount: number;
  readonly reworkCount: number;
  readonly blockedTimeMs: number;
  readonly agentAssignments: readonly AgentAssignmentMetric[];
  readonly verificationCycles: readonly VerificationCycleMetric[];
  readonly testMetrics: TestMetrics;
  readonly contextMetrics: ContextMetrics;
  readonly modelUsage: readonly VerifiedModelUsage[];
}

export interface ObservabilitySummary {
  readonly totalRuns: number;
  readonly activeRuns: number;
  readonly completedRuns: number;
  readonly failedRuns: number;
  readonly totalDurationMs: number;
  readonly totalBlockedTimeMs: number;
  readonly totalRetries: number;
  readonly totalReworks: number;
  readonly totalAgentAssignments: number;
  readonly testMetrics: TestMetrics;
  readonly totalContextBytes: number;
  readonly totalModelUsage: {
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
    readonly totalTokens: number;
    readonly totalCostUsd: number | null;
  };
}

interface BlockedEpisode {
  readonly episodeId: string;
  readonly runId: string;
  readonly taskId?: string | undefined;
  readonly startedAt: string;
  endedAt?: string | undefined;
  readonly reason?: string | undefined;
}

interface RunMeta {
  readonly runId: string;
  status: string;
  startedAt: string;
  completedAt?: string | undefined;
}

interface TaskAttemptRecord {
  readonly runId: string;
  readonly taskId: string;
  readonly attempt: number;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  status: string;
}

export class ObservabilityTracker {
  private readonly _clock: () => Date;
  private readonly _runs = new Map<string, RunMeta>();
  private readonly _taskAttempts: TaskAttemptRecord[] = [];
  private readonly _blockedEpisodes: BlockedEpisode[] = [];
  private readonly _retries = new Map<string, number>();
  private readonly _reworks = new Map<string, number>();
  private readonly _assignments = new Map<string, AgentAssignmentMetric>();
  private readonly _verificationCycles: VerificationCycleMetric[] = [];
  private readonly _testChecks: TestCheckMetric[] = [];
  private readonly _contextBundles: ContextBundleMetric[] = [];
  private readonly _modelUsageMap = new Map<string, VerifiedModelUsage[]>();
  private readonly _ingestedEventIds = new Set<string>();
  private _episodeCounter = 0;

  constructor(options?: { readonly clock?: (() => Date) | undefined }) {
    this._clock = options?.clock ?? (() => new Date());
  }

  private now(): string {
    return this._clock().toISOString();
  }

  public recordRunStart(runId: string, startedAt?: string): void {
    const existing = this._runs.get(runId);
    if (!existing) {
      this._runs.set(runId, {
        runId,
        status: "created",
        startedAt: startedAt ?? this.now()
      });
    } else if (startedAt !== undefined) {
      existing.startedAt = startedAt;
    }
  }

  public recordRunCompletion(runId: string, status: string, completedAt?: string): void {
    const timestamp = completedAt ?? this.now();
    const run = this._runs.get(runId);
    if (run) {
      run.status = status;
      run.completedAt = timestamp;
    } else {
      this._runs.set(runId, {
        runId,
        status,
        startedAt: timestamp,
        completedAt: timestamp
      });
    }
    // Also close any open blocked episodes for this run at the completion timestamp
    for (const ep of this._blockedEpisodes) {
      if (ep.runId === runId && ep.endedAt === undefined) {
        ep.endedAt = timestamp;
      }
    }
    // Also close any open task attempts for this run at the completion timestamp
    for (const attempt of this._taskAttempts) {
      if (attempt.runId === runId && attempt.completedAt === undefined) {
        attempt.completedAt = timestamp;
      }
    }
  }

  public recordTaskStart(
    runId: string,
    taskId: string,
    attempt: number,
    startedAt?: string
  ): void {
    this.recordRunStart(runId);
    const timestamp = startedAt ?? this.now();

    // Close any previous attempts of this task that are still open
    for (const prev of this._taskAttempts) {
      if (
        prev.runId === runId &&
        prev.taskId === taskId &&
        prev.attempt < attempt &&
        prev.completedAt === undefined
      ) {
        prev.completedAt = timestamp;
      }
    }

    let record = this._taskAttempts.find(
      (t) => t.runId === runId && t.taskId === taskId && t.attempt === attempt
    );
    if (record) {
      if (!record.startedAt) {
        record.startedAt = timestamp;
      }
      record.status = "running";
    } else {
      record = {
        runId,
        taskId,
        attempt,
        startedAt: timestamp,
        status: "running"
      };
      this._taskAttempts.push(record);
    }
  }

  public recordTaskTransition(
    runId: string,
    taskId: string,
    attempt: number,
    _from: string,
    to: string,
    timestamp?: string,
    _reason?: string
  ): void {
    this.recordRunStart(runId);
    const time = timestamp ?? this.now();

    // Close any previous attempts of this task that are still open
    for (const prev of this._taskAttempts) {
      if (
        prev.runId === runId &&
        prev.taskId === taskId &&
        prev.attempt < attempt &&
        prev.completedAt === undefined
      ) {
        prev.completedAt = time;
      }
    }

    let record = this._taskAttempts.find(
      (t) => t.runId === runId && t.taskId === taskId && t.attempt === attempt
    );
    if (!record) {
      record = {
        runId,
        taskId,
        attempt,
        startedAt: time,
        status: to
      };
      this._taskAttempts.push(record);
    } else {
      record.status = to;
      if (!record.startedAt && to === "running") {
        record.startedAt = time;
      }
    }

    // If toStatus is terminal, or transitioning to "retrying" or "pending", close this attempt's completedAt
    if (
      (to === "succeeded" ||
        (to as string) === "completed" ||
        to === "failed" ||
        to === "cancelled" ||
        to === "retrying" ||
        to === "pending") &&
      record.completedAt === undefined
    ) {
      record.completedAt = time;
    }

    if (to === "succeeded" || (to as string) === "completed" || to === "failed" || to === "cancelled") {
      this.recordBlockedEpisodeEnd(runId, taskId, time);
    }
  }

  public recordTaskCompletion(
    runId: string,
    taskId: string,
    attempt: number,
    status: string,
    completedAt?: string
  ): void {
    const timestamp = completedAt ?? this.now();
    let record = this._taskAttempts.find(
      (t) => t.runId === runId && t.taskId === taskId && t.attempt === attempt
    );
    if (record) {
      record.status = status;
      record.completedAt = timestamp;
    } else {
      this._taskAttempts.push({
        runId,
        taskId,
        attempt,
        startedAt: timestamp,
        completedAt: timestamp,
        status
      });
    }
    // Close any open blocked episodes for this task
    this.recordBlockedEpisodeEnd(runId, taskId, timestamp);
  }

  public recordBlockedEpisodeStart(
    runId: string,
    taskId?: string,
    startedAtOrReason?: string,
    reasonOrStartedAt?: string
  ): string {
    this.recordRunStart(runId);

    let startedAt: string;
    let reason: string | undefined;

    if (startedAtOrReason !== undefined) {
      const parsed = Date.parse(startedAtOrReason);
      if (!isNaN(parsed) && startedAtOrReason.includes("-")) {
        startedAt = startedAtOrReason;
        reason = reasonOrStartedAt;
      } else {
        reason = startedAtOrReason;
        startedAt = reasonOrStartedAt ?? this.now();
      }
    } else {
      startedAt = this.now();
      reason = reasonOrStartedAt;
    }

    // Prevent overlapping open blocked episodes for the same taskId in this run
    if (taskId !== undefined) {
      const existingOpen = this._blockedEpisodes.find(
        (ep) => ep.runId === runId && ep.taskId === taskId && ep.endedAt === undefined
      );
      if (existingOpen) {
        if (
          reason !== undefined &&
          (existingOpen.reason === undefined ||
            existingOpen.reason === "blocked" ||
            existingOpen.reason === "waiting") &&
          reason !== "blocked" &&
          reason !== "waiting"
        ) {
          (existingOpen as { reason?: string }).reason = reason;
        }
        return existingOpen.episodeId;
      }
    }

    this._episodeCounter++;
    const episodeId = `ep-${runId}-${Date.now()}-${this._episodeCounter}`;
    this._blockedEpisodes.push({
      episodeId,
      runId,
      ...(taskId !== undefined ? { taskId } : {}),
      startedAt,
      ...(reason !== undefined ? { reason } : {})
    });
    return episodeId;
  }

  public recordBlockedEpisodeEnd(
    runId: string,
    taskIdOrEpisodeId?: string,
    endedAt?: string
  ): void {
    const timestamp = endedAt ?? this.now();
    if (!taskIdOrEpisodeId) {
      for (const ep of this._blockedEpisodes) {
        if (ep.runId === runId && ep.endedAt === undefined) {
          ep.endedAt = timestamp;
        }
      }
      return;
    }

    // First try matching episodeId
    const byEpisodeId = this._blockedEpisodes.find(
      (ep) => ep.runId === runId && ep.episodeId === taskIdOrEpisodeId && ep.endedAt === undefined
    );
    if (byEpisodeId) {
      byEpisodeId.endedAt = timestamp;
      return;
    }

    // Second try matching taskId
    for (const ep of this._blockedEpisodes) {
      if (ep.runId === runId && ep.taskId === taskIdOrEpisodeId && ep.endedAt === undefined) {
        ep.endedAt = timestamp;
      }
    }
  }

  public recordRetry(runId: string, taskId?: string): void {
    this.recordRunStart(runId);
    const runKey = `run:${runId}`;
    this._retries.set(runKey, (this._retries.get(runKey) ?? 0) + 1);

    if (taskId) {
      const taskKey = `task:${runId}:${taskId}`;
      this._retries.set(taskKey, (this._retries.get(taskKey) ?? 0) + 1);
    }
  }

  public recordRework(runId: string, taskId?: string): void {
    this.recordRunStart(runId);
    const runKey = `run:${runId}`;
    this._reworks.set(runKey, (this._reworks.get(runKey) ?? 0) + 1);

    if (taskId) {
      const taskKey = `task:${runId}:${taskId}`;
      this._reworks.set(taskKey, (this._reworks.get(taskKey) ?? 0) + 1);
    }
  }

  public recordAgentAssignment(assignment: AgentAssignmentMetric): void {
    this.recordRunStart(assignment.runId);
    this._assignments.set(assignment.assignmentId, assignment);
  }

  public updateAgentAssignment(
    assignmentId: string,
    updates: Partial<AgentAssignmentMetric>
  ): void {
    const existing = this._assignments.get(assignmentId);
    if (existing) {
      this._assignments.set(assignmentId, {
        ...existing,
        ...updates
      });
    }
  }

  public recordVerificationCycle(metric: VerificationCycleMetric): void {
    this.recordRunStart(metric.runId);
    this._verificationCycles.push(metric);
  }

  public recordTestCheck(check: TestCheckMetric): void {
    this.recordRunStart(check.runId);
    this._testChecks.push(check);
  }

  public recordContextBundle(bundle: ContextBundleMetric): void {
    this.recordRunStart(bundle.runId);
    this._contextBundles.push(bundle);
  }

  public recordModelUsage(runId: string, usage: VerifiedModelUsage): void {
    this.recordRunStart(runId);
    const list = this._modelUsageMap.get(runId) ?? [];
    list.push(usage);
    this._modelUsageMap.set(runId, list);
  }

  public ingestDomainEvents(
    runId: string,
    events: readonly DomainEvent[],
    snapshot?: WorkflowRunSnapshot
  ): void {
    const sortedEvents = [...events]
      .filter((e) => e.runId === runId)
      .sort((a, b) => a.sequence - b.sequence);

    const createdEvent = sortedEvents.find((e) => e.type === "run.created");
    const initialStart = createdEvent?.occurredAt ?? snapshot?.createdAt;
    this.recordRunStart(runId, initialStart);

    for (const event of sortedEvents) {
      if (this._ingestedEventIds.has(event.eventId)) {
        continue;
      }
      this._ingestedEventIds.add(event.eventId);
      const occurredAt = event.occurredAt;

      switch (event.type) {
        case "run.created": {
          this.recordRunStart(runId, occurredAt);
          break;
        }

        case "run.status_changed": {
          const to = event.payload.to;
          if (to === "succeeded" || (to as string) === "completed" || to === "failed" || to === "cancelled") {
            this.recordRunCompletion(runId, to, occurredAt);
          } else {
            const run = this._runs.get(runId);
            if (run) {
              run.status = to;
            }
          }
          break;
        }

        case "task.status_changed": {
          const { from, to, attempt, reason } = event.payload;
          const taskId = event.taskId;
          if (taskId) {
            if (to === "blocked" || to === "waiting") {
              this.recordBlockedEpisodeStart(runId, taskId, occurredAt, reason ?? to);
            }
            if (from === "blocked" || from === "waiting") {
              this.recordBlockedEpisodeEnd(runId, taskId, occurredAt);
            }
            this.recordTaskTransition(runId, taskId, attempt, from, to, occurredAt, reason);
          }
          break;
        }

        case "task.retry_scheduled": {
          if (event.taskId) {
            this.recordRetry(runId, event.taskId);
          }
          break;
        }

        case "task.rework_requested" as unknown as "task.retry_scheduled": {
          if (event.taskId) {
            this.recordRework(runId, event.taskId);
          }
          break;
        }

        case "approval.requested": {
          this.recordBlockedEpisodeStart(runId, event.taskId, occurredAt, "awaiting_approval");
          break;
        }

        case "approval.decided": {
          this.recordBlockedEpisodeEnd(runId, event.taskId, occurredAt);
          break;
        }

        case "agent.delivery_uncertain": {
          this.recordBlockedEpisodeStart(runId, event.taskId, occurredAt, "unknown_delivery");
          break;
        }

        case "agent.delivery_reconciled": {
          this.recordBlockedEpisodeEnd(runId, event.taskId, occurredAt);
          break;
        }

        case "task.dispatch_requested": {
          const { requestId, attemptId, agentId, target } = event.payload;
          const taskId = event.taskId ?? "unknown-task";
          const paneId = target.paneId ?? target.terminalId;
          this.recordAgentAssignment({
            assignmentId: requestId,
            runId,
            taskId,
            attemptId,
            role: "agent",
            agentId,
            ...(paneId !== undefined ? { paneId } : {}),
            assignedAt: occurredAt,
            status: "assigned"
          });
          break;
        }

        case "agent.execution_bound": {
          const { handle } = event.payload;
          const paneId = handle.target.paneId ?? handle.target.terminalId;
          this.updateAgentAssignment(handle.requestId, {
            status: "bound",
            ...(paneId !== undefined ? { paneId } : {}),
            ...(handle.correlation.token !== undefined ? { fencingToken: handle.correlation.token } : {})
          });
          break;
        }

        case "agent.binding_verified": {
          const { receipt } = event.payload;
          this.updateAgentAssignment(receipt.handle.requestId, {
            status: "verified"
          });
          break;
        }

        case "agent.result_recorded": {
          const payload = event.payload;
          const assignments = [...this._assignments.values()].reverse();
          const assignment = assignments.find(
            (a) =>
              a.runId === runId &&
              (a.assignmentId === payload.requestId ||
                a.assignmentId === payload.executionId ||
                (a.taskId === event.taskId &&
                  (a.status === "active" ||
                    a.status === "bound" ||
                    a.status === "verified" ||
                    a.status === "assigned")))
          );
          if (assignment) {
            this.updateAgentAssignment(assignment.assignmentId, {
              status: "released",
              releasedAt: occurredAt
            });
          }
          break;
        }

        case "quality_gate.evaluated": {
          const qg = event.payload;
          const status =
            qg.status === "passed"
              ? "passed"
              : qg.status === "failed"
                ? "failed"
                : "blocked";
          this.recordTestCheck({
            checkId: qg.gateId,
            runId,
            ...(qg.taskId !== undefined ? { taskId: qg.taskId } : {}),
            status,
            evaluatedAt: qg.evaluatedAt
          });
          break;
        }

        default:
          break;
      }
    }

    if (snapshot && snapshot.runId === runId) {
      const run = this._runs.get(runId);
      if (run) {
        if (!run.startedAt && snapshot.createdAt) {
          run.startedAt = snapshot.createdAt;
        }
        if (
          (snapshot.status === "succeeded" ||
            (snapshot.status as string) === "completed" ||
            snapshot.status === "failed" ||
            snapshot.status === "cancelled") &&
          !run.completedAt
        ) {
          run.status = snapshot.status;
          run.completedAt = snapshot.updatedAt;
        }
      }

      for (const t of snapshot.tasks) {
        if (t.startedAt) {
          let record = this._taskAttempts.find(
            (ta) => ta.runId === runId && ta.taskId === t.taskId && ta.attempt === t.attempt
          );
          if (!record) {
            record = {
              runId,
              taskId: t.taskId,
              attempt: t.attempt,
              startedAt: t.startedAt,
              status: t.status
            };
            this._taskAttempts.push(record);
          }
          if (t.completedAt && !record.completedAt) {
            record.completedAt = t.completedAt;
            record.status = t.status;
          }
        }
      }
    }
  }

  public getRunReport(runId: string): RunObservabilityReport | null {
    const run = this._runs.get(runId);
    if (!run) {
      return null;
    }

    const nowIso = this.now();
    const nowMs = Date.parse(nowIso);
    const startMs = Date.parse(run.startedAt);
    const endMs = run.completedAt !== undefined ? Date.parse(run.completedAt) : nowMs;
    const runDurationMs = Math.max(0, endMs - startMs);

    // Task durations
    const taskDurations: TaskDurationMetric[] = this._taskAttempts
      .filter((t) => t.runId === runId)
      .map((t) => {
        let duration = 0;
        if (t.startedAt !== undefined) {
          const tStart = Date.parse(t.startedAt);
          const tEnd = t.completedAt !== undefined ? Date.parse(t.completedAt) : nowMs;
          duration = Math.max(0, tEnd - tStart);
        }
        return {
          taskId: t.taskId,
          attempt: t.attempt,
          ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
          ...(t.completedAt !== undefined ? { completedAt: t.completedAt } : {}),
          durationMs: duration,
          status: t.status
        };
      });

    // Blocked time
    let blockedTimeMs = 0;
    for (const ep of this._blockedEpisodes) {
      if (ep.runId === runId) {
        const epStart = Date.parse(ep.startedAt);
        const epEnd = ep.endedAt !== undefined ? Date.parse(ep.endedAt) : nowMs;
        blockedTimeMs += Math.max(0, epEnd - epStart);
      }
    }

    // Retries and Reworks
    const retryCount = this._retries.get(`run:${runId}`) ?? 0;
    const reworkCount = this._reworks.get(`run:${runId}`) ?? 0;

    // Agent Assignments
    const agentAssignments = [...this._assignments.values()].filter((a) => a.runId === runId);

    // Verification Cycles
    const verificationCycles = this._verificationCycles.filter((v) => v.runId === runId);

    // Test Checks
    const checks = this._testChecks.filter((c) => c.runId === runId);
    const passedCount = checks.filter((c) => c.status === "passed").length;
    const failedCount = checks.filter((c) => c.status === "failed").length;
    const blockedCount = checks.filter((c) => c.status === "blocked").length;
    const inconclusiveCount = checks.filter((c) => c.status === "inconclusive").length;
    const totalChecks = checks.length;
    const passRate = totalChecks > 0 ? passedCount / totalChecks : 0;

    const testMetrics: TestMetrics = {
      totalChecks,
      passedCount,
      failedCount,
      blockedCount,
      inconclusiveCount,
      passRate,
      checks
    };

    // Context Bundles
    const bundles = this._contextBundles.filter((b) => b.runId === runId);
    const totalContextBytes = bundles.reduce((acc, b) => acc + b.contextBytes, 0);
    const maxTaskContextBytes = bundles.reduce((max, b) => Math.max(max, b.contextBytes), 0);

    const contextMetrics: ContextMetrics = {
      totalContextBytes,
      maxTaskContextBytes,
      bundles
    };

    // Model Usage
    const modelUsage = this._modelUsageMap.get(runId) ?? [];

    return {
      runId,
      status: run.status,
      startedAt: run.startedAt,
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      runDurationMs,
      taskDurations,
      retryCount,
      reworkCount,
      blockedTimeMs,
      agentAssignments,
      verificationCycles,
      testMetrics,
      contextMetrics,
      modelUsage
    };
  }

  public getSummary(): ObservabilitySummary {
    const totalRuns = this._runs.size;
    let activeRuns = 0;
    let completedRuns = 0;
    let failedRuns = 0;
    let totalDurationMs = 0;

    const nowMs = Date.parse(this.now());

    for (const run of this._runs.values()) {
      if (run.status === "completed" || run.status === "succeeded") {
        completedRuns++;
      } else if (run.status === "failed" || run.status === "cancelled") {
        failedRuns++;
      } else {
        activeRuns++;
      }

      const s = Date.parse(run.startedAt);
      const e = run.completedAt !== undefined ? Date.parse(run.completedAt) : nowMs;
      totalDurationMs += Math.max(0, e - s);
    }

    let totalBlockedTimeMs = 0;
    for (const ep of this._blockedEpisodes) {
      const s = Date.parse(ep.startedAt);
      const e = ep.endedAt !== undefined ? Date.parse(ep.endedAt) : nowMs;
      totalBlockedTimeMs += Math.max(0, e - s);
    }

    let totalRetries = 0;
    let totalReworks = 0;
    for (const [key, count] of this._retries.entries()) {
      if (key.startsWith("run:")) {
        totalRetries += count;
      }
    }
    for (const [key, count] of this._reworks.entries()) {
      if (key.startsWith("run:")) {
        totalReworks += count;
      }
    }

    const totalAgentAssignments = this._assignments.size;

    const passedCount = this._testChecks.filter((c) => c.status === "passed").length;
    const failedCount = this._testChecks.filter((c) => c.status === "failed").length;
    const blockedCount = this._testChecks.filter((c) => c.status === "blocked").length;
    const inconclusiveCount = this._testChecks.filter((c) => c.status === "inconclusive").length;
    const totalChecks = this._testChecks.length;
    const passRate = totalChecks > 0 ? passedCount / totalChecks : 0;

    const testMetrics: TestMetrics = {
      totalChecks,
      passedCount,
      failedCount,
      blockedCount,
      inconclusiveCount,
      passRate,
      checks: [...this._testChecks]
    };

    const totalContextBytes = this._contextBundles.reduce((acc, b) => acc + b.contextBytes, 0);

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalCostUsd: number | null = null;
    let hasCost = false;

    for (const usages of this._modelUsageMap.values()) {
      for (const u of usages) {
        totalInputTokens += u.inputTokens;
        totalOutputTokens += u.outputTokens;
        totalTokens += u.totalTokens;
        if (u.costUsd !== null) {
          totalCostUsd = (totalCostUsd ?? 0) + u.costUsd;
          hasCost = true;
        }
      }
    }

    if (!hasCost) {
      totalCostUsd = null;
    }

    return {
      totalRuns,
      activeRuns,
      completedRuns,
      failedRuns,
      totalDurationMs,
      totalBlockedTimeMs,
      totalRetries,
      totalReworks,
      totalAgentAssignments,
      testMetrics,
      totalContextBytes,
      totalModelUsage: {
        totalInputTokens,
        totalOutputTokens,
        totalTokens,
        totalCostUsd
      }
    };
  }
}
