import { createHash, randomUUID } from "node:crypto";
import {
  ApprovalDecisionSchema,
  ArtifactProposalSchema,
  type AgentResult,
  type ApprovalDecision,
  type ApprovalRequest,
  type ArtifactProposal,
  type ArtifactReference,
  type ArtifactStore,
  type Blockage,
  type DomainEvent,
  type OperationOptions,
  type OperationResult,
  type QualityGate,
  type QualityGateContext,
  type QualityGateDefinition,
  type QualityGateResult,
  type RunStore,
  type TaskState,
  type WorkflowDefinition,
  type WorkflowEngine,
  type WorkflowRunSnapshot
} from "@ai-flow/contracts";
import type { TaskDispatcher } from "./dispatcher.js";
import type { RunEventHub } from "./stream.js";

export interface SdlcOrchestratorPorts {
  readonly engine: WorkflowEngine;
  readonly runStore: RunStore;
  readonly artifactStore: ArtifactStore;
  readonly qualityGate?: QualityGate | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly eventHub?: RunEventHub | undefined;
}

const AUTOMATED_PREFIX_REGEX =
  /^(agent|ai|bot|system|auto|llm|planner|developer|reviewer|qa|claude|chatgpt|gpt|copilot|gemini|assistant|deepseek|llama|mistral)([:_.-]|\d|$)/i;

export function isHumanApprover(decidedBy: string): boolean {
  if (!decidedBy || typeof decidedBy !== "string" || decidedBy.trim().length === 0) {
    return false;
  }
  return !AUTOMATED_PREFIX_REGEX.test(decidedBy.trim());
}

export async function ingestArtifactProposals(
  store: ArtifactStore,
  proposals: readonly ArtifactProposal[],
  contentByProposalId: Readonly<Record<string, Uint8Array | string>>,
  options?: {
    readonly idempotencyKeyPrefix?: string | undefined;
    readonly operationOptions?: OperationOptions | undefined;
  }
): Promise<OperationResult<readonly ArtifactReference[]>> {
  const references: ArtifactReference[] = [];

  for (const proposal of proposals) {
    const parseRes = ArtifactProposalSchema.safeParse(proposal);
    if (!parseRes.success) {
      return {
        ok: false,
        error: { code: "validation", retryable: false, message: `Invalid artifact proposal: ${parseRes.error.message}` }
      };
    }

    const rawContent = contentByProposalId[proposal.proposalId];
    if (rawContent === undefined) {
      return {
        ok: false,
        error: { code: "validation", retryable: false, message: `Missing content for artifact proposal '${proposal.proposalId}'` }
      };
    }

    const bytes = typeof rawContent === "string" ? Buffer.from(rawContent, "utf8") : Buffer.from(rawContent);

    if (
      proposal.expectedIntegrity.sizeBytes !== undefined &&
      bytes.byteLength !== proposal.expectedIntegrity.sizeBytes
    ) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Size mismatch for proposal '${proposal.proposalId}': expected ${proposal.expectedIntegrity.sizeBytes}, got ${bytes.byteLength}`
        }
      };
    }

    const algo = proposal.expectedIntegrity.checksum.algorithm;
    const computedHash = createHash(algo).update(bytes).digest("hex");
    if (computedHash.toLowerCase() !== proposal.expectedIntegrity.checksum.value.toLowerCase()) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Checksum mismatch for proposal '${proposal.proposalId}': expected ${proposal.expectedIntegrity.checksum.value}, computed ${computedHash}`
        }
      };
    }

    const idempotencyKey = `${options?.idempotencyKeyPrefix ?? "ingest"}:${proposal.proposalId}`;
    const write = {
      options: {
        artifactId: proposal.proposalId,
        runId: proposal.runId,
        ...(proposal.taskId !== undefined ? { taskId: proposal.taskId } : {}),
        kind: proposal.kind,
        mediaType: proposal.mediaType,
        expectedIntegrity: proposal.expectedIntegrity,
        idempotencyKey,
        ...(proposal.metadata !== undefined ? { metadata: proposal.metadata } : {})
      },
      content: (async function* () {
        yield bytes;
      })()
    };

    const putRes = await store.put(write, options?.operationOptions);
    if (!putRes.ok) {
      return putRes;
    }
    references.push(putRes.value);
  }

  return { ok: true, value: references };
}

export class SdlcWorkflowOrchestrator {
  readonly #ports: SdlcOrchestratorPorts;
  readonly #dispatcher: TaskDispatcher;
  readonly #clock: () => Date;
  readonly #completionAttempts = new Map<string, { executionId: string; requestId: string; completedAt: string; startedAt: string; expectedVersion: number; expectedLastSequence: number }>();

  constructor(ports: SdlcOrchestratorPorts, dispatcher: TaskDispatcher) {
    this.#ports = ports;
    this.#dispatcher = dispatcher;
    this.#clock = ports.clock ?? (() => new Date());
  }

  /**
   * Main workflow coordination loop:
   * Evaluates DAG readiness, executes runnable tasks, ingests proposals,
   * runs quality gates, handles reviewer rework (maxReworks: 2),
   * pauses at pre-merge human approval, and checkpoints state.
   */
  async driveRun(
    runId: string,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowRunSnapshot>> {
    const storedRunRes = await this.#ports.runStore.get(runId, options);
    if (!storedRunRes.ok) return storedRunRes as OperationResult<WorkflowRunSnapshot>;
    if (!storedRunRes.value) {
      return { ok: false, error: { code: "not_found", retryable: false, message: `Run ${runId} not found` } };
    }
    const definition = storedRunRes.value.definition;
    const skippedTaskIdsInDrive = new Set<string>();

    // Execution loop
    while (!options?.signal?.aborted) {
      const snapRes = await this.#ports.engine.getSnapshot(runId, options);
      if (!snapRes.ok) return snapRes as OperationResult<WorkflowRunSnapshot>;
      let snapshot = snapRes.value;
      if (!snapshot) {
        return { ok: false, error: { code: "not_found", retryable: false, message: `Run ${runId} not found` } };
      }

      // Check if run reached terminal state
      if (["succeeded", "failed", "cancelled"].includes(snapshot.status)) {
        await this.createAndSaveCheckpoint(runId, snapshot.version, options);
        return { ok: true, value: snapshot };
      }

      // Recover any open quality gate evaluations or tasks waiting on after_result gates
      if (
        this.#ports.qualityGate &&
        snapshot.tasks.some(
          (t) => t.status === "waiting" || (t.status === "running" && t.agentExecution === undefined)
        )
      ) {
        const gateRecRes = await this.recoverPendingQualityGates(runId, definition, snapshot, options);
        if (!gateRecRes.ok) return gateRecRes as OperationResult<WorkflowRunSnapshot>;
        snapshot = gateRecRes.value;
      }

      if (["succeeded", "failed", "cancelled"].includes(snapshot.status)) {
        await this.createAndSaveCheckpoint(runId, snapshot.version, options);
        return { ok: true, value: snapshot };
      }

      if (snapshot.status === "waiting" || snapshot.status === "blocked") {
        await this.createAndSaveCheckpoint(runId, snapshot.version, options);
        return { ok: true, value: snapshot };
      }

      // Schedule ready tasks
      const scheduleRes = await this.#dispatcher.scheduleReadyTasks(runId, options);
      if (!scheduleRes.ok) return scheduleRes as OperationResult<WorkflowRunSnapshot>;
      const runnableTaskIds = [...scheduleRes.value];

      const postScheduleSnapRes = await this.#ports.engine.getSnapshot(runId, options);
      if (postScheduleSnapRes.ok && postScheduleSnapRes.value) {
        for (const t of postScheduleSnapRes.value.tasks) {
          if (
            t.status === "running" &&
            t.agentExecution === undefined &&
            !this.#dispatcher.getActiveExecution(runId, t.taskId) &&
            !runnableTaskIds.includes(t.taskId) &&
            !skippedTaskIdsInDrive.has(t.taskId)
          ) {
            runnableTaskIds.push(t.taskId);
          }
        }
      }

      if (runnableTaskIds.length === 0) {
        // No new runnable tasks right now
        const refreshedSnapRes = await this.#ports.engine.getSnapshot(runId, options);
        if (!refreshedSnapRes.ok) return refreshedSnapRes as OperationResult<WorkflowRunSnapshot>;
        const current = refreshedSnapRes.value!;

        if (current.status === "waiting" || current.status === "blocked" ||
            ["succeeded", "failed", "cancelled"].includes(current.status)) {
          await this.createAndSaveCheckpoint(runId, current.version, options);
          return { ok: true, value: current };
        }

        // Check if any tasks are in progress
        const inFlight = current.tasks.some((t) => ["running", "cancelling"].includes(t.status));
        if (!inFlight) {
          // If no in-flight tasks and all tasks succeeded, verify if pre-merge approval or completion is reached
          const allSucceeded = current.tasks.every((t) => t.status === "succeeded");
          if (allSucceeded) {
            // Generate handoff report if needed
            await this.generateAndPersistHandoffReport(runId, options);
            await this.createAndSaveCheckpoint(runId, current.version, options);
            return { ok: true, value: current };
          }

          // Bug 5 Halt Check: If any task is blocked or rework limit is exhausted, halt at 'blocked'
          const hasBlockedTask = current.tasks.some((t) => t.status === "blocked");
          const hasExhaustedRework = definition.tasks.some((tDef) => {
            const tState = current.tasks.find((t) => t.taskId === tDef.id);
            if (!tState || !tDef.rework) return false;
            return tState.generation >= tDef.rework.maxReworks;
          });

          if (hasBlockedTask || hasExhaustedRework) {
            const blockedSnapshot: WorkflowRunSnapshot = {
              ...current,
              status: "blocked"
            };
            await this.createAndSaveCheckpoint(runId, current.version, options);
            return { ok: true, value: blockedSnapshot };
          }

          return { ok: true, value: current };
        }
        break;
      }

      // Execute each runnable task
      for (const taskId of runnableTaskIds) {
        if (options?.signal?.aborted) break;

        const currentSnapshotRes = await this.#ports.engine.getSnapshot(runId, options);
        if (!currentSnapshotRes.ok || !currentSnapshotRes.value) break;
        let currentSnapshot = currentSnapshotRes.value;
        const taskState = currentSnapshot.tasks.find((t) => t.taskId === taskId);
        const taskDef = definition.tasks.find((t) => t.id === taskId);
        if (!taskState || !taskDef) continue;

        // 1. Evaluate 'before_dispatch' quality gates
        if (taskDef.qualityGates && taskDef.qualityGates.length > 0 && this.#ports.qualityGate) {
          const beforeGates = taskDef.qualityGates.filter((g) => g.phase === "before_dispatch");
          let gateFailed = false;
          for (const gateBinding of beforeGates) {
            const gateDef = definition.qualityGates.find((g) => g.id === gateBinding.gateId);
            const gateRes = await this.evaluateQualityGate(runId, currentSnapshot, taskState, gateBinding.gateId, gateDef, options);
            if (!gateRes.ok || gateRes.value.status !== "passed") {
              gateFailed = true;
              break;
            }
            const refreshedAfterGate = await this.#ports.engine.getSnapshot(runId, options);
            if (refreshedAfterGate.ok && refreshedAfterGate.value) {
              currentSnapshot = refreshedAfterGate.value;
            }
          }
          if (gateFailed) {
            skippedTaskIdsInDrive.add(taskId);
            continue;
          }
        }

        // 2. Dispatch task via TaskDispatcher
        const instruction = taskDef.instruction || `Execute task ${taskId} as role ${taskDef.role}`;
        const dispatchRes = await this.#dispatcher.dispatchTask(
          definition,
          currentSnapshot,
          taskId,
          instruction,
          options
        );
        if (!dispatchRes.ok) {
          // Check if dispatch failure transitioned the task or run to a blocked state
          const refreshedSnap = await this.#ports.engine.getSnapshot(runId, options);
          if (refreshedSnap.ok && refreshedSnap.value) {
            const currentSnap = refreshedSnap.value;
            if (
              currentSnap.status === "blocked" ||
              currentSnap.status === "waiting" ||
              ["succeeded", "failed", "cancelled"].includes(currentSnap.status)
            ) {
              await this.createAndSaveCheckpoint(runId, currentSnap.version, options);
              return { ok: true, value: currentSnap };
            }
          }
          // Propagate dispatch error immediately to prevent spinning or silent zombie runs
          return dispatchRes as OperationResult<WorkflowRunSnapshot>;
        }
      }
    }

    const finalSnapRes = await this.#ports.engine.getSnapshot(runId, options);
    if (!finalSnapRes.ok || !finalSnapRes.value) {
      return { ok: false, error: { code: "corruption", retryable: false, message: "Could not retrieve snapshot" } };
    }
    return { ok: true, value: finalSnapRes.value };
  }

  /**
   * Completes a task execution: ingests proposals, records AgentResult,
   * runs after_result quality gates, processes reviewer rework or pre-merge approval.
   */
  async completeTaskExecution(
    runId: string,
    taskId: string,
    result: {
      status: "succeeded" | "failed" | "blocked";
      retryable?: boolean | undefined;
      blockage?: Blockage | undefined;
      error?: {
        code: string;
        message: string;
        retryable?: boolean | undefined;
      } | undefined;
      summary?: string | undefined;
      exitCode?: number | undefined;
      proposals?: readonly ArtifactProposal[] | undefined;
      contentByProposalId?: Readonly<Record<string, Uint8Array | string>> | undefined;
      reviewDecision?: ("approved" | "changes_requested") | undefined;
      reviewReason?: string | undefined;
    },
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowRunSnapshot>> {
    const snapRes = await this.#ports.engine.getSnapshot(runId, options);
    if (!snapRes.ok || !snapRes.value) {
      return { ok: false, error: { code: "not_found", retryable: false, message: `Run ${runId} not found` } };
    }
    let snapshot = snapRes.value;
    const taskState = snapshot.tasks.find((t) => t.taskId === taskId);
    if (!taskState || !taskState.attemptId) {
      return { ok: false, error: { code: "validation", retryable: false, message: `Task ${taskId} not active` } };
    }

    const storedRunRes = await this.#ports.runStore.get(runId, options);
    const definition = storedRunRes.ok && storedRunRes.value ? storedRunRes.value.definition : undefined;
    const taskDef = definition?.tasks.find((t) => t.id === taskId);

    // 1. Ingest untrusted artifact proposals into ArtifactStore
    let storedArtifacts: ArtifactReference[] = [];
    if (result.proposals && result.proposals.length > 0 && result.contentByProposalId) {
      const ingestRes = await ingestArtifactProposals(
        this.#ports.artifactStore,
        result.proposals,
        result.contentByProposalId,
        { idempotencyKeyPrefix: `run-${runId}:task-${taskId}`, operationOptions: options }
      );
      if (!ingestRes.ok) return ingestRes as OperationResult<WorkflowRunSnapshot>;
      storedArtifacts = [...ingestRes.value];
    }

    // 2. Formulate and record verified AgentResult
    const active = this.#dispatcher.getActiveExecution(runId, taskId);
    const handle = active?.handle ?? taskState.agentExecution;
    const attemptKey = `${runId}:${taskId}:${taskState.attemptId}`;
    let cachedAttempt = this.#completionAttempts.get(attemptKey);
    if (!cachedAttempt) {
      const completedAt = this.#clock().toISOString();
      const startedAt = active?.startedAt ?? taskState.startedAt ?? completedAt;
      cachedAttempt = {
        executionId: handle?.executionId ?? randomUUID(),
        requestId: handle?.requestId ?? randomUUID(),
        completedAt,
        startedAt,
        expectedVersion: snapshot.version,
        expectedLastSequence: snapshot.lastEventSequence
      };
      this.#completionAttempts.set(attemptKey, cachedAttempt);
    }
    const executionId = handle?.executionId ?? cachedAttempt.executionId;
    const requestId = handle?.requestId ?? cachedAttempt.requestId;
    const completedAt = cachedAttempt.completedAt;
    const startedAt = cachedAttempt.startedAt;

    const dep = definition?.dependencies.find((d) => d.taskId === taskId);
    const targetTaskId = dep ? dep.dependsOnTaskId : taskId;
    const targetState = snapshot.tasks.find((t) => t.taskId === targetTaskId);
    const targetGeneration = targetState?.generation ?? 0;
    const targetDef = definition?.tasks.find((t) => t.id === targetTaskId);
    const reworkPolicy = targetDef?.rework ?? { maxReworks: 0, onExhausted: "fail" as const };
    const isReworkExhausted = Boolean(
      result.reviewDecision === "changes_requested" &&
      targetGeneration >= reworkPolicy.maxReworks
    );

    const effectiveStatus = isReworkExhausted ? "blocked" : result.status;
    const effectiveBlockage = isReworkExhausted
      ? {
          code: "manual_intervention" as const,
          message: result.reviewReason ?? "Rework limit exhausted; human intervention required",
          since: completedAt,
          retryable: false
        }
      : result.blockage;

    const agentResult: AgentResult = {
      requestId,
      attemptId: taskState.attemptId,
      runId,
      taskId,
      executionId,
      status: effectiveStatus,
      verification: {
        status: "verified",
        evidence: `Verified execution ${executionId}`,
        correlation: {
          token: handle?.correlation?.token ?? requestId,
          provenance: handle?.correlation?.provenance ?? "transport",
          verified: true
        }
      },
      artifactProposals: result.proposals ? [...result.proposals] : [],
      retryable: result.retryable ?? false,
      startedAt,
      completedAt,
      output: {
        exitCode: result.exitCode ?? (effectiveStatus === "succeeded" ? 0 : 1),
        summary: result.summary ?? `Task ${taskId} completed with status ${effectiveStatus}`,
        artifactIds: storedArtifacts.map((a) => a.artifactId)
      },
      ...(effectiveBlockage ? { blockage: effectiveBlockage } : {}),
      ...(effectiveStatus === "failed"
        ? {
            error: {
              code: result.error?.code ?? "execution_error",
              message: result.error?.message ?? result.summary ?? `Task ${taskId} failed`,
              retryable: result.retryable ?? false
            }
          }
        : {})
    };

    try {
      const recordResultRes = await this.#ports.engine.recordAgentResult({
        runId,
        taskId,
        expectedVersion: cachedAttempt.expectedVersion,
        result: agentResult,
        idempotencyKey: `result:${runId}:${taskId}:${taskState.attemptId}`,
        occurredAt: completedAt
      }, options);
      if (!recordResultRes.ok) return recordResultRes;

      const persistRes = await this.persistEvents(
        runId,
        cachedAttempt.expectedVersion,
        cachedAttempt.expectedLastSequence,
        recordResultRes.value.emittedEvents,
        `result-events:${taskState.attemptId}`,
        options
      );
      if (!persistRes.ok) return persistRes as OperationResult<WorkflowRunSnapshot>;

      snapshot = recordResultRes.value.snapshot;
      this.#completionAttempts.delete(attemptKey);
    } finally {
      if (active) {
        try {
          await this.#dispatcher.releaseLease(active.lease, options);
        } finally {
          this.#dispatcher.clearActiveExecution(runId, taskId);
        }
      }
    }

    // 3. Evaluate 'after_result' quality gates
    if (taskDef?.qualityGates && this.#ports.qualityGate && definition) {
      const afterGates = taskDef.qualityGates.filter((g) => g.phase === "after_result");
      for (const gateBinding of afterGates) {
        const gateDef = definition.qualityGates.find((g) => g.id === gateBinding.gateId);
        const gateRes = await this.evaluateQualityGate(runId, snapshot, taskState, gateBinding.gateId, gateDef, options);
        if (gateRes.ok) {
          const freshSnap = await this.#ports.engine.getSnapshot(runId, options);
          if (freshSnap.ok && freshSnap.value) snapshot = freshSnap.value;
        }
      }
    }

    // 4. Handle Reviewer Decision & Bounded Rework
    if (result.reviewDecision && definition) {
      const approvalId = `review-appr-${taskId}-${randomUUID()}`;

      // Request approval first in engine aggregate
      const reqRes = await this.#ports.engine.requestApproval({
        expectedVersion: snapshot.version,
        idempotencyKey: `req-approval:${approvalId}`,
        request: {
          schemaVersion: 1,
          approvalId,
          runId,
          target: { type: "task", taskId: targetTaskId },
          revision: 1,
          generation: targetGeneration,
          requestedBy: "reviewer",
          requestedAt: this.#clock().toISOString(),
          reason: result.reviewReason ?? "Review approval requested",
          evidence: storedArtifacts,
          idempotencyKey: `req-appr-key:${approvalId}`
        }
      }, options);

      if (reqRes.ok) {
        await this.persistEvents(
          runId,
          snapshot.version,
          snapshot.lastEventSequence,
          reqRes.value.emittedEvents,
          `req-appr-events:${approvalId}`,
          options
        );
        snapshot = reqRes.value.snapshot;
      }

      const approvalDecision: ApprovalDecision = {
        schemaVersion: 1,
        approvalId,
        runId,
        target: { type: "task", taskId: targetTaskId },
        revision: 1,
        generation: targetGeneration,
        decision: result.reviewDecision,
        decidedBy: "reviewer",
        decidedAt: this.#clock().toISOString(),
        ...(result.reviewReason
          ? { reason: result.reviewReason }
          : result.reviewDecision === "changes_requested"
            ? { reason: "Changes requested by reviewer" }
            : {}),
        feedbackArtifacts: storedArtifacts,
        idempotencyKey: `review-decision:${runId}:${taskId}:${taskState.attemptId}`
      };

      const applyRes = await this.#ports.engine.applyApproval({
        expectedVersion: snapshot.version,
        idempotencyKey: `apply-review:${approvalDecision.approvalId}`,
        decision: approvalDecision
      }, options);

      if (applyRes.ok) {
        await this.persistEvents(
          runId,
          snapshot.version,
          snapshot.lastEventSequence,
          applyRes.value.emittedEvents,
          `apply-review-events:${approvalDecision.approvalId}`,
          options
        );
        snapshot = applyRes.value.snapshot;
      }

      // If rework was requested and target was reworked, also rework reviewer task so it re-evaluates the reworked code
      if (result.reviewDecision === "changes_requested" && !isReworkExhausted) {
        const reviewTaskDef = definition.tasks.find((t) => t.id === taskId);
        const reviewReworkPolicy = reviewTaskDef?.rework;
        if (reviewReworkPolicy && taskState.generation < reviewReworkPolicy.maxReworks) {
          const selfApprovalId = `review-self-${taskId}-${randomUUID()}`;
          const selfReqRes = await this.#ports.engine.requestApproval({
            expectedVersion: snapshot.version,
            idempotencyKey: `req-approval:${selfApprovalId}`,
            request: {
              schemaVersion: 1,
              approvalId: selfApprovalId,
              runId,
              target: { type: "task", taskId },
              revision: 1,
              generation: taskState.generation,
              requestedBy: "reviewer",
              requestedAt: this.#clock().toISOString(),
              reason: "Re-evaluating task after rework",
              evidence: storedArtifacts,
              idempotencyKey: `req-appr-key:${selfApprovalId}`
            }
          }, options);

          if (selfReqRes.ok) {
            await this.persistEvents(
              runId,
              snapshot.version,
              snapshot.lastEventSequence,
              selfReqRes.value.emittedEvents,
              `req-appr-events:${selfApprovalId}`,
              options
            );
            snapshot = selfReqRes.value.snapshot;

            const selfApplyRes = await this.#ports.engine.applyApproval({
              expectedVersion: snapshot.version,
              idempotencyKey: `apply-review:${selfApprovalId}`,
              decision: {
                schemaVersion: 1,
                approvalId: selfApprovalId,
                runId,
                target: { type: "task", taskId },
                revision: 1,
                generation: taskState.generation,
                decision: "changes_requested",
                decidedBy: "reviewer",
                decidedAt: this.#clock().toISOString(),
                reason: "Re-evaluating task after rework",
                feedbackArtifacts: storedArtifacts,
                idempotencyKey: `review-self-decision:${runId}:${taskId}:${taskState.attemptId}`
              }
            }, options);

            if (selfApplyRes.ok) {
              await this.persistEvents(
                runId,
                snapshot.version,
                snapshot.lastEventSequence,
                selfApplyRes.value.emittedEvents,
                `apply-review-events:${selfApprovalId}`,
                options
              );
              snapshot = selfApplyRes.value.snapshot;
            }
          }
        }
      }
    }

    // 5. Check if task requires approval (or final pre-merge step)
    if (taskDef?.requiresApproval && snapshot.status !== "failed" && snapshot.status !== "cancelled") {
      const approvalReqId = `approval-req-${taskId}-${randomUUID()}`;
      const apprReq: ApprovalRequest = {
        schemaVersion: 1,
        approvalId: approvalReqId,
        runId,
        target: { type: "task", taskId },
        revision: 1,
        generation: taskState.generation,
        requestedBy: "runtime",
        requestedAt: this.#clock().toISOString(),
        reason: `Pre-merge human approval required for task ${taskId}`,
        evidence: storedArtifacts,
        idempotencyKey: `req-appr:${approvalReqId}`
      };

      const requestApprovalRes = await this.#ports.engine.requestApproval({
        expectedVersion: snapshot.version,
        idempotencyKey: `cmd-req-appr:${approvalReqId}`,
        request: apprReq
      }, options);

      if (requestApprovalRes.ok) {
        await this.persistEvents(
          runId,
          snapshot.version,
          snapshot.lastEventSequence,
          requestApprovalRes.value.emittedEvents,
          `req-appr-events:${approvalReqId}`,
          options
        );
        snapshot = requestApprovalRes.value.snapshot;
      }

      // Generate structured handoff report before pausing
      await this.generateAndPersistHandoffReport(runId, options);
      await this.createAndSaveCheckpoint(runId, snapshot.version, options);
    }

    if (["succeeded", "failed", "cancelled"].includes(snapshot.status)) {
      await this.createAndSaveCheckpoint(runId, snapshot.version, options);
    }

    return { ok: true, value: snapshot };
  }

  /**
   * Applies human approval decision and triggers run continuation.
   * Strictly enforces human governance (rejects automated/AI actors).
   */
  async applyApprovalDecision(
    decision: ApprovalDecision,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowRunSnapshot>> {
    const parseRes = ApprovalDecisionSchema.safeParse(decision);
    if (!parseRes.success) {
      return {
        ok: false,
        error: { code: "validation", retryable: false, message: `Invalid approval decision: ${parseRes.error.message}` }
      };
    }

    // Mandatory human governance verification
    if (!isHumanApprover(decision.decidedBy) || decision.metadata?.automatedOnly === true) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Mandatory human approval cannot be satisfied by an automated or AI actor ('${decision.decidedBy}')`
        }
      };
    }

    const snapRes = await this.#ports.engine.getSnapshot(decision.runId, options);
    if (!snapRes.ok || !snapRes.value) {
      return { ok: false, error: { code: "not_found", retryable: false, message: `Run ${decision.runId} not found` } };
    }
    const snapshot = snapRes.value;

    let effectiveDecision = decision;
    let applyRes = await this.#ports.engine.applyApproval({
      expectedVersion: snapshot.version,
      idempotencyKey: decision.idempotencyKey,
      decision: effectiveDecision
    }, options);

    if (!applyRes.ok && typeof applyRes.error?.message === "string" && applyRes.error.message.includes("Unknown approval")) {
      const allEvents: DomainEvent[] = [];
      let cursor: string | undefined = undefined;
      while (true) {
        const pageRes = await this.#ports.runStore.readEvents(decision.runId, { cursor, limit: 100 }, options);
        if (!pageRes.ok) break;
        allEvents.push(...pageRes.value.items);
        cursor = pageRes.value.nextCursor;
        if (!cursor || pageRes.value.items.length === 0) break;
      }

      const decidedApprovalIds = new Set(
        allEvents.filter((e) => e.type === "approval.decided").map((e) => (e.payload as any).approvalId)
      );

      const reqEvent = [...allEvents].reverse().find(
        (e) => e.type === "approval.requested" &&
               !decidedApprovalIds.has((e.payload as any).approvalId) &&
               (decision.target.type === "run" || JSON.stringify((e.payload as any).target) === JSON.stringify(decision.target))
      );
      if (reqEvent) {
        const actualApproval = reqEvent.payload as any;
        effectiveDecision = {
          ...decision,
          approvalId: actualApproval.approvalId,
          target: actualApproval.target,
          revision: actualApproval.revision ?? 1,
          generation: actualApproval.generation ?? 0
        };
        applyRes = await this.#ports.engine.applyApproval({
          expectedVersion: snapshot.version,
          idempotencyKey: decision.idempotencyKey,
          decision: effectiveDecision
        }, options);
      }
    }

    if (!applyRes.ok) return applyRes;

    await this.persistEvents(
      decision.runId,
      snapshot.version,
      snapshot.lastEventSequence,
      applyRes.value.emittedEvents,
      `human-approval-events:${effectiveDecision.approvalId}`,
      options
    );

    // Save aggregate checkpoint
    await this.createAndSaveCheckpoint(decision.runId, applyRes.value.snapshot.version, options);

    // Resume execution loop if approved
    if (decision.decision === "approved" || decision.decision === "changes_requested") {
      return this.driveRun(decision.runId, options);
    }

    return { ok: true, value: applyRes.value.snapshot };
  }

  /**
   * Completes any open quality_gate.evaluation_requested events or remaining after_result
   * quality gates after a crash/restart before the run pauses or schedules downstream tasks.
   */
  private async recoverPendingQualityGates(
    runId: string,
    definition: WorkflowDefinition,
    snapshot: WorkflowRunSnapshot,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowRunSnapshot>> {
    if (!this.#ports.qualityGate) {
      return { ok: true, value: snapshot };
    }

    let currentSnapshot = snapshot;
    const initiallyWaitingTaskIds = new Set(
      currentSnapshot.tasks.filter((t) => t.status === "waiting").map((t) => t.taskId)
    );

    const allEvents: DomainEvent[] = [];
    let cursor: string | undefined = undefined;
    while (true) {
      const pageRes = await this.#ports.runStore.readEvents(
        runId,
        cursor !== undefined ? { cursor, limit: 100 } : { limit: 100 },
        options
      );
      if (!pageRes.ok) {
        return { ok: true, value: currentSnapshot };
      }
      allEvents.push(...pageRes.value.items);
      if (pageRes.value.nextCursor === undefined || pageRes.value.items.length === 0) break;
      cursor = pageRes.value.nextCursor;
    }

    const evaluatedIds = new Set<string>();
    const passedGateKeys = new Set<string>();
    const evalIdToAttemptId = new Map<string, string | undefined>();

    for (const e of allEvents) {
      if (e.type === "quality_gate.evaluation_requested") {
        evalIdToAttemptId.set(e.payload.evaluationId, e.payload.attemptId);
      }
    }

    for (const e of allEvents) {
      if (e.type === "quality_gate.evaluated") {
        evaluatedIds.add(e.payload.evaluationId);
        if (e.payload.status === "passed") {
          const tId = e.payload.taskId ?? e.taskId ?? "";
          const aId = evalIdToAttemptId.get(e.payload.evaluationId) ?? "";
          passedGateKeys.add(`${tId}:${aId}:${e.payload.gateId}`);
        }
      }
    }

    // 1. Complete any open quality_gate.evaluation_requested events without a matching quality_gate.evaluated
    for (const reqEvent of allEvents) {
      if (reqEvent.type !== "quality_gate.evaluation_requested") continue;
      const evaluationId = reqEvent.payload.evaluationId;
      if (evaluatedIds.has(evaluationId)) continue;

      const gateId = reqEvent.payload.gateId;
      const taskId = reqEvent.taskId;
      const attemptId = reqEvent.payload.attemptId;
      const gateDef = definition.qualityGates.find((g) => g.id === gateId);

      const effectiveDefinition: QualityGateDefinition = gateDef ?? {
        id: gateId,
        name: gateId,
        evaluator: "command",
        required: true,
        timeout: { executionTimeoutMs: 30000, onTimeout: "fail" }
      };

      const gateContext: QualityGateContext = {
        runId,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(attemptId !== undefined ? { attemptId } : {}),
        definition: effectiveDefinition,
        artifacts: []
      };

      const evalRes = await this.#ports.qualityGate.evaluate(gateContext, options);
      if (!evalRes.ok) return evalRes as OperationResult<WorkflowRunSnapshot>;

      const freshSnap = await this.#ports.engine.getSnapshot(runId, options);
      if (freshSnap.ok && freshSnap.value) {
        currentSnapshot = freshSnap.value;
      }

      const effectiveResult: QualityGateResult = {
        ...evalRes.value,
        evaluationId
      };

      const recordRes = await this.#ports.engine.recordQualityGateResult(
        {
          expectedVersion: currentSnapshot.version,
          idempotencyKey: `gate-rec-recovery:${evaluationId}`,
          result: effectiveResult
        },
        options
      );
      if (!recordRes.ok) return recordRes as OperationResult<WorkflowRunSnapshot>;

      const persistRes = await this.persistEvents(
        runId,
        currentSnapshot.version,
        currentSnapshot.lastEventSequence,
        recordRes.value.emittedEvents,
        `gate-rec-recovery-events:${evaluationId}`,
        options
      );
      if (!persistRes.ok) return persistRes as OperationResult<WorkflowRunSnapshot>;

      currentSnapshot = recordRes.value.snapshot;
      evaluatedIds.add(evaluationId);
      if (effectiveResult.status === "passed") {
        passedGateKeys.add(`${taskId ?? ""}:${attemptId ?? ""}:${gateId}`);
      }
    }

    // 2. Evaluate any remaining after_result / before_completion gates for tasks still in 'waiting'
    for (const task of currentSnapshot.tasks) {
      if (task.status !== "waiting") continue;
      const taskDef = definition.tasks.find((t) => t.id === task.taskId);
      if (!taskDef?.qualityGates) continue;

      const postGates = taskDef.qualityGates.filter(
        (g) => g.phase === "after_result" || g.phase === "before_completion"
      );
      for (const gateBinding of postGates) {
        const key = `${task.taskId}:${task.attemptId ?? ""}:${gateBinding.gateId}`;
        if (passedGateKeys.has(key)) continue;

        const gateDef = definition.qualityGates.find((g) => g.id === gateBinding.gateId);
        const latestTask = currentSnapshot.tasks.find((t) => t.taskId === task.taskId) ?? task;
        const gateRes = await this.evaluateQualityGate(
          runId,
          currentSnapshot,
          latestTask,
          gateBinding.gateId,
          gateDef,
          options
        );
        if (!gateRes.ok) return gateRes as OperationResult<WorkflowRunSnapshot>;

        const freshSnap = await this.#ports.engine.getSnapshot(runId, options);
        if (freshSnap.ok && freshSnap.value) {
          currentSnapshot = freshSnap.value;
        }
        if (gateRes.value.status === "passed") {
          passedGateKeys.add(key);
        } else {
          break;
        }
      }
    }

    // 3. For any task that was waiting on gates and transitioned to 'succeeded', request approval if required
    for (const taskId of initiallyWaitingTaskIds) {
      const refreshedTask = currentSnapshot.tasks.find((t) => t.taskId === taskId);
      const taskDef = definition.tasks.find((t) => t.id === taskId);
      if (
        refreshedTask?.status === "succeeded" &&
        taskDef?.requiresApproval &&
        currentSnapshot.status !== "failed" &&
        currentSnapshot.status !== "cancelled"
      ) {
        const hasExistingApprovalReq = allEvents.some(
          (e) =>
            e.type === "approval.requested" &&
            e.payload.target.type === "task" &&
            e.payload.target.taskId === taskId &&
            e.payload.generation === refreshedTask.generation
        );
        if (!hasExistingApprovalReq) {
          const approvalReqId = `approval-req-${taskId}-${randomUUID()}`;
          const apprReq: ApprovalRequest = {
            schemaVersion: 1,
            approvalId: approvalReqId,
            runId,
            target: { type: "task", taskId },
            revision: 1,
            generation: refreshedTask.generation,
            requestedBy: "runtime",
            requestedAt: this.#clock().toISOString(),
            reason: `Pre-merge human approval required for task ${taskId}`,
            evidence: [],
            idempotencyKey: `req-appr:${approvalReqId}`
          };

          const requestApprovalRes = await this.#ports.engine.requestApproval(
            {
              expectedVersion: currentSnapshot.version,
              idempotencyKey: `cmd-req-appr:${approvalReqId}`,
              request: apprReq
            },
            options
          );

          if (requestApprovalRes.ok) {
            await this.persistEvents(
              runId,
              currentSnapshot.version,
              currentSnapshot.lastEventSequence,
              requestApprovalRes.value.emittedEvents,
              `req-appr-events:${approvalReqId}`,
              options
            );
            currentSnapshot = requestApprovalRes.value.snapshot;
          }

          await this.generateAndPersistHandoffReport(runId, options);
          await this.createAndSaveCheckpoint(runId, currentSnapshot.version, options);
        }
      }
    }

    return { ok: true, value: currentSnapshot };
  }

  /**
   * Executes an automated Quality Gate and records the result in the engine.
   */
  private async evaluateQualityGate(
    runId: string,
    snapshot: WorkflowRunSnapshot,
    task: TaskState,
    gateId: string,
    gateDef: QualityGateDefinition | undefined,
    options?: OperationOptions
  ): Promise<OperationResult<QualityGateResult>> {
    if (!this.#ports.qualityGate) {
      return {
        ok: false,
        error: { code: "validation", retryable: false, message: "No QualityGate evaluator configured" }
      };
    }

    const evaluationId = `eval-${gateId}-${randomUUID()}`;
    const reqRes = await this.#ports.engine.requestQualityGateEvaluation({
      runId,
      taskId: task.taskId,
      gateId,
      evaluationId,
      ...(task.attemptId !== undefined ? { attemptId: task.attemptId } : {}),
      expectedVersion: snapshot.version,
      idempotencyKey: `gate-req:${evaluationId}`,
      occurredAt: this.#clock().toISOString()
    }, options);
    if (!reqRes.ok) {
      if (reqRes.error.code === "conflict") {
        const eventsPage = await this.#ports.runStore.readEvents(runId, { limit: 100 }, options);
        if (eventsPage.ok) {
          const matchingReqIds = new Set(
            eventsPage.value.items
              .filter(
                (e) =>
                  e.type === "quality_gate.evaluation_requested" &&
                  e.taskId === task.taskId &&
                  e.payload.gateId === gateId &&
                  e.payload.attemptId === task.attemptId
              )
              .map((e) => (e.type === "quality_gate.evaluation_requested" ? e.payload.evaluationId : ""))
          );
          const existingEval = [...eventsPage.value.items]
            .reverse()
            .find(
              (e) =>
                e.type === "quality_gate.evaluated" &&
                matchingReqIds.has(e.payload.evaluationId)
            );
          if (existingEval && existingEval.type === "quality_gate.evaluated") {
            return { ok: true, value: existingEval.payload };
          }
        }
      }
      return reqRes as OperationResult<QualityGateResult>;
    }

    await this.persistEvents(
      runId,
      snapshot.version,
      snapshot.lastEventSequence,
      reqRes.value.emittedEvents,
      `gate-req-events:${evaluationId}`,
      options
    );

    const effectiveDefinition: QualityGateDefinition = gateDef ?? {
      id: gateId,
      name: gateId,
      evaluator: "command",
      required: true,
      timeout: { executionTimeoutMs: 30000, onTimeout: "fail" }
    };

    const gateContext: QualityGateContext = {
      runId,
      taskId: task.taskId,
      ...(task.attemptId !== undefined ? { attemptId: task.attemptId } : {}),
      definition: effectiveDefinition,
      artifacts: []
    };

    const evalRes = await this.#ports.qualityGate.evaluate(gateContext, options);
    if (!evalRes.ok) return evalRes;
    const gateResult = evalRes.value;

    const freshSnap = await this.#ports.engine.getSnapshot(runId, options);
    const expectedVersion = freshSnap.ok && freshSnap.value ? freshSnap.value.version : snapshot.version + 1;
    const expectedLastSequence = freshSnap.ok && freshSnap.value ? freshSnap.value.lastEventSequence : snapshot.lastEventSequence + 1;

    const effectiveResult: QualityGateResult = {
      ...gateResult,
      evaluationId
    };

    const recordRes = await this.#ports.engine.recordQualityGateResult({
      expectedVersion,
      idempotencyKey: `gate-rec:${evaluationId}`,
      result: effectiveResult
    }, options);
    if (!recordRes.ok) return recordRes as OperationResult<QualityGateResult>;

    await this.persistEvents(
      runId,
      expectedVersion,
      expectedLastSequence,
      recordRes.value.emittedEvents,
      `gate-rec-events:${evaluationId}`,
      options
    );

    return { ok: true, value: effectiveResult };
  }

  /**
   * Generates a structured handoff report and persists it in ArtifactStore.
   */
  async generateAndPersistHandoffReport(
    runId: string,
    options?: OperationOptions
  ): Promise<OperationResult<ArtifactReference>> {
    const snapRes = await this.#ports.engine.getSnapshot(runId, options);
    if (!snapRes.ok || !snapRes.value) {
      return { ok: false, error: { code: "not_found", retryable: false, message: `Run ${runId} not found` } };
    }
    const snapshot = snapRes.value;

    const taskRows = snapshot.tasks.map((t) =>
      `| ${t.taskId} | ${t.status} | ${t.attempt} | ${t.generation} | ${t.version} |`
    ).join("\n");

    const markdownContent = `# AI Flow SDLC — Structured Handoff Report

- **Run ID**: \`${runId}\`
- **Workflow ID**: \`${snapshot.workflowId}\` (v${snapshot.workflowVersion})
- **Run Status**: \`${snapshot.status}\`
- **Created At**: ${snapshot.createdAt}
- **Updated At**: ${snapshot.updatedAt}
- **Version**: ${snapshot.version}
- **Total Events**: ${snapshot.lastEventSequence}

## Task Status Summary

| Task ID | Status | Attempt | Generation | State Version |
|---|---|---|---|---|
${taskRows}

## Pre-Merge Governance

- **Human Sign-off Required**: Yes (Mandatory human approval required before merge/deploy).
- **Automated AI Merging**: Disabled.
`;

    const bytes = Buffer.from(markdownContent, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifactId = `report-${runId}-handoff`;

    const write = {
      options: {
        artifactId,
        runId,
        kind: "report" as const,
        mediaType: "text/markdown",
        expectedIntegrity: {
          sizeBytes: bytes.byteLength,
          checksum: { algorithm: "sha256" as const, value: sha256 }
        },
        idempotencyKey: `handoff-report:${runId}`
      },
      content: (async function* () {
        yield bytes;
      })()
    };

    return this.#ports.artifactStore.put(write, options);
  }

  /**
   * Helper to persist events to SQLite RunStore and publish to EventHub.
   */
  private async persistEvents(
    runId: string,
    expectedVersion: number,
    expectedLastSequence: number,
    events: readonly DomainEvent[],
    idempotencyKey: string,
    options?: OperationOptions
  ): Promise<OperationResult<void>> {
    if (events.length === 0) return { ok: true, value: undefined };

    const appendRes = await this.#ports.runStore.appendEvents({
      runId,
      expectedVersion,
      expectedLastSequence,
      events: [...events],
      idempotencyKey
    }, options);
    if (!appendRes.ok) return appendRes as OperationResult<void>;

    if (this.#ports.eventHub) {
      this.#ports.eventHub.publish(runId, events);
    }

    return { ok: true, value: undefined };
  }

  /**
   * Helper to create and save aggregate checkpoint.
   */
  private async createAndSaveCheckpoint(
    runId: string,
    expectedVersion: number,
    options?: OperationOptions
  ): Promise<OperationResult<void>> {
    const checkpointId = `cp-${runId}-v${expectedVersion}`;
    const cpRes = await this.#ports.engine.createCheckpoint({
      runId,
      expectedVersion,
      checkpointId,
      createdAt: this.#clock().toISOString()
    }, options);
    if (!cpRes.ok) return cpRes as OperationResult<void>;

    return this.#ports.runStore.saveCheckpoint(cpRes.value, expectedVersion, options);
  }
}
