import { createHash, randomUUID } from "node:crypto";
import {
  CURRENT_DOMAIN_EVENT_SCHEMA_VERSION,
  DomainEventSchema,
  fingerprintWorkflowCommand,
  type AgentExecutionHandle,
  type AgentLease,
  type AgentRegistry,
  type AgentRequest,
  type AgentSubmissionReceipt,
  type AgentTargetLocator,
  type AgentTransport,
  type DomainEvent,
  type OperationOptions,
  type OperationResult,
  type RunStore,
  type WorkflowDefinition,
  type WorkflowEngine,
  type WorkflowRunSnapshot
} from "@bflow/contracts";
import type { RunEventHub } from "./stream.js";

function hash(parts: readonly string[]): string {
  let value = 14695981039346656037n;
  const mask = (1n << 64n) - 1n;
  for (const character of parts.join("\u0000")) {
    value ^= BigInt(character.charCodeAt(0));
    value = (value * 1099511628211n) & mask;
  }
  return value.toString(36);
}

function deterministicId(kind: string, ...parts: readonly string[]): string {
  const prefix = parts.join("-").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 96);
  return `${kind}-${prefix}-${hash([kind, ...parts])}`.slice(0, 200);
}

export interface TaskDispatcherOptions {
  readonly engine: WorkflowEngine;
  readonly runStore: RunStore;
  readonly agentRegistry: AgentRegistry;
  readonly transport: AgentTransport;
  readonly clock?: (() => Date) | undefined;
  readonly defaultLeaseTtlMs?: number | undefined;
  readonly eventHub?: RunEventHub | undefined;
}

export interface ActiveTaskExecution {
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly attempt: number;
  readonly lease: AgentLease;
  readonly handle?: AgentExecutionHandle | undefined;
  readonly target: AgentTargetLocator;
  readonly startedAt: string;
}

export class TaskDispatcher {
  readonly #engine: WorkflowEngine;
  readonly #runStore: RunStore;
  readonly #registry: AgentRegistry;
  readonly #transport: AgentTransport;
  readonly #clock: () => Date;
  readonly #defaultLeaseTtlMs: number;
  readonly #eventHub?: RunEventHub | undefined;
  readonly #activeExecutions: Map<string, ActiveTaskExecution> = new Map(); // key: `${runId}:${taskId}`

  constructor(options: TaskDispatcherOptions) {
    this.#engine = options.engine;
    this.#runStore = options.runStore;
    this.#registry = options.agentRegistry;
    this.#transport = options.transport;
    this.#clock = options.clock ?? (() => new Date());
    this.#defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? 300_000; // 5 min
    this.#eventHub = options.eventHub;
  }

  private async persistEvents(
    runId: string,
    expectedVersion: number,
    expectedLastSequence: number,
    events: readonly DomainEvent[],
    idempotencyKey: string,
    options?: OperationOptions
  ): Promise<OperationResult<unknown>> {
    if (events.length === 0) return { ok: true, value: undefined };
    const appendRes = await this.#runStore.appendEvents({
      runId,
      expectedVersion,
      expectedLastSequence,
      events: [...events],
      idempotencyKey
    }, options);
    if (appendRes.ok && this.#eventHub) {
      this.#eventHub.publish(runId, events);
    }
    return appendRes;
  }

  private async persistDispatchIntent(
    snapshot: WorkflowRunSnapshot,
    agentRequest: AgentRequest,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowRunSnapshot>> {
    const cpRes = await this.#engine.createCheckpoint(
      {
        runId: snapshot.runId,
        expectedVersion: snapshot.version,
        checkpointId: `cp-dispatch-${agentRequest.requestId}`,
        createdAt: agentRequest.createdAt
      },
      options
    );
    if (!cpRes.ok) {
      return cpRes;
    }

    const commandKey = `dispatch:${snapshot.runId}:${agentRequest.taskId}:${agentRequest.requestId}`;
    const correlationId = deterministicId("correlation", snapshot.runId, commandKey);
    const seq1 = snapshot.lastEventSequence + 1;
    const ver1 = snapshot.version + 1;
    const seq2 = snapshot.lastEventSequence + 2;
    const ver2 = snapshot.version + 2;

    const dispatchEvent: DomainEvent = DomainEventSchema.parse({
      schemaVersion: CURRENT_DOMAIN_EVENT_SCHEMA_VERSION,
      eventId: deterministicId("event", snapshot.runId, String(seq1), "task.dispatch_requested", commandKey),
      runId: snapshot.runId,
      taskId: agentRequest.taskId,
      sequence: seq1,
      aggregateVersion: ver1,
      occurredAt: agentRequest.createdAt,
      correlationId,
      idempotencyKey: deterministicId("idempotency", snapshot.runId, commandKey, "1"),
      type: "task.dispatch_requested",
      payload: {
        requestId: agentRequest.requestId,
        attemptId: agentRequest.attemptId,
        agentId: agentRequest.target.agentId,
        attempt: agentRequest.attempt,
        target: agentRequest.target
      }
    });

    const commandCompletedEvent: DomainEvent = DomainEventSchema.parse({
      schemaVersion: CURRENT_DOMAIN_EVENT_SCHEMA_VERSION,
      eventId: deterministicId("event", snapshot.runId, String(seq2), "command.completed", commandKey),
      runId: snapshot.runId,
      sequence: seq2,
      aggregateVersion: ver2,
      occurredAt: agentRequest.createdAt,
      correlationId,
      idempotencyKey: deterministicId("idempotency", snapshot.runId, commandKey, "2"),
      type: "command.completed",
      payload: {
        schemaVersion: 1,
        commandId: deterministicId("command", snapshot.runId, commandKey),
        idempotencyKey: commandKey,
        operation: "bindAgentExecution",
        fingerprint: fingerprintWorkflowCommand("bindAgentExecution", {
          runId: snapshot.runId,
          taskId: agentRequest.taskId,
          requestId: agentRequest.requestId,
          attemptId: agentRequest.attemptId
        }),
        firstEventSequence: seq1,
        runnableTaskIds: []
      }
    });

    const appendRes = await this.persistEvents(
      snapshot.runId,
      snapshot.version,
      snapshot.lastEventSequence,
      [dispatchEvent, commandCompletedEvent],
      `dispatch-events:${snapshot.runId}:${agentRequest.taskId}:${agentRequest.requestId}`,
      options
    );
    if (!appendRes.ok) {
      return appendRes as OperationResult<WorkflowRunSnapshot>;
    }

    const recoverRes = await this.#engine.recover(
      {
        runId: snapshot.runId,
        checkpoint: cpRes.value,
        events: [dispatchEvent, commandCompletedEvent],
        expectedVersion: ver2
      },
      options
    );
    if (!recoverRes.ok) {
      return recoverRes;
    }

    return { ok: true, value: recoverRes.value.snapshot };
  }

  /**
   * Evaluates the workflow DAG via engine.advance(), persists emitted events to RunStore,
   * and returns the IDs of newly runnable tasks.
   */
  async scheduleReadyTasks(
    runId: string,
    options?: OperationOptions
  ): Promise<OperationResult<readonly string[]>> {
    const currentSnapshotRes = await this.#engine.getSnapshot(runId, options);
    if (!currentSnapshotRes.ok) return currentSnapshotRes;
    let snapshot = currentSnapshotRes.value;

    if (!snapshot) {
      const stored = await this.#runStore.get(runId, options);
      if (!stored.ok) return stored;
      if (!stored.value) {
        return {
          ok: false,
          error: { code: "not_found", retryable: false, message: `Run ${runId} not found` }
        };
      }
      snapshot = stored.value.snapshot;
    }

    const advanceResult = await this.#engine.advance({
      runId,
      expectedVersion: snapshot.version,
      idempotencyKey: `advance:${runId}:${snapshot.version}`,
      occurredAt: this.#clock().toISOString()
    }, options);
    if (!advanceResult.ok) return advanceResult;

    if (advanceResult.value.emittedEvents.length > 0) {
      const appendResult = await this.persistEvents(
        runId,
        snapshot.version,
        snapshot.lastEventSequence,
        advanceResult.value.emittedEvents,
        `advance-events:${runId}:${advanceResult.value.snapshot.version}`,
        options
      );
      if (!appendResult.ok) return appendResult as OperationResult<readonly string[]>;
    }

    return { ok: true, value: advanceResult.value.runnableTaskIds };
  }

  /**
   * Executes the full dispatch pipeline for a single running task:
   * 1. Resolves agent configuration from role.
   * 2. Acquires capacity lease with monotonic fencing token.
   * 3. Verifies lease and fencing token immediately before dispatch.
   * 4. Constructs AgentRequest with idempotency policy and persists task.dispatch_requested.
   * 5. Sends prompt via transport.send().
   * 6. On 'accepted': binds execution via engine.bindAgentExecution() and persists.
   * 7. On 'unknown_delivery': initiates delivery reconciliation.
   */
  async dispatchTask(
    definition: WorkflowDefinition,
    snapshot: WorkflowRunSnapshot,
    taskId: string,
    instruction: string,
    options?: OperationOptions
  ): Promise<OperationResult<AgentExecutionHandle>> {
    const taskDef = definition.tasks.find((t) => t.id === taskId);
    const taskState = snapshot.tasks.find((t) => t.taskId === taskId);
    if (!taskDef || !taskState || !taskState.attemptId) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Task ${taskId} not ready or missing attemptId in run ${snapshot.runId}`
        }
      };
    }

    // 1. Resolve agent configuration
    const agentConfigRes = await this.#registry.resolve(taskDef.role, {
      runId: snapshot.runId,
      taskId,
      requiredCapabilities: []
    }, options);
    if (!agentConfigRes.ok) return agentConfigRes;
    if (!agentConfigRes.value) {
      return {
        ok: false,
        error: {
          code: "not_found",
          retryable: false,
          message: `No agent found for role ${taskDef.role}`
        }
      };
    }
    const agentConfig = agentConfigRes.value;

    // 2. Acquire capacity lease with monotonic fencing token
    const leaseId = deterministicId("lease", snapshot.runId, taskId, taskState.attemptId);
    const leaseRes = await this.#registry.acquireLease({
      leaseId,
      agentId: agentConfig.agentId,
      runId: snapshot.runId,
      taskId,
      attemptId: taskState.attemptId,
      ttlMs: Math.max(taskDef.timeout.executionTimeoutMs ?? this.#defaultLeaseTtlMs, this.#defaultLeaseTtlMs),
      requestedAt: taskState.startedAt ?? this.#clock().toISOString(),
      idempotencyKey: `lease:${snapshot.runId}:${taskId}:${taskState.attemptId}`
    }, options);
    if (!leaseRes.ok) return leaseRes;
    const lease = leaseRes.value;

    try {
      // 3. Verify lease and fencing token immediately before dispatch
      const nowMs = this.#clock().getTime();
      if (nowMs >= Date.parse(lease.expiresAt) || lease.fencingToken <= 0) {
        await this.releaseLease(lease, options);
        return {
          ok: false,
          error: {
            code: "conflict",
            retryable: true,
            message: `Lease expired or invalid fencing token for task ${taskId}`
          }
        };
      }

      const targetLocator: AgentTargetLocator = {
        transport: "herdr",
        agentId: agentConfig.agentId,
        paneId: `pane-${taskDef.role}`
      };

      const requestId = randomUUID();
      const idempotencyKey = `req:${snapshot.runId}:${taskId}:${taskState.attemptId}`;
      const fingerprint = createHash("sha256").update(instruction).digest("hex");

      const agentRequest: AgentRequest = {
        requestId,
        attemptId: taskState.attemptId,
        runId: snapshot.runId,
        taskId,
        role: taskDef.role,
        target: targetLocator,
        instruction,
        inputs: [],
        attempt: taskState.attempt,
        retry: taskDef.retry,
        timeout: taskDef.timeout,
        idempotency: {
          key: idempotencyKey,
          scope: "agent-request",
          fingerprint
        },
        createdAt: this.#clock().toISOString(),
        metadata: { leaseId: lease.leaseId, fencingToken: lease.fencingToken }
      };

      // 4. Persist durable dispatch intent before calling transport.send
      const intentRes = await this.persistDispatchIntent(snapshot, agentRequest, options);
      if (!intentRes.ok) {
        await this.releaseLease(lease, options);
        return intentRes;
      }
      const activeSnapshot = intentRes.value;

      // 5. Send prompt to transport
      const submissionRes = await this.#transport.send(agentRequest, options);
      if (!submissionRes.ok) {
        await this.releaseLease(lease, options);
        return submissionRes;
      }
      const receipt: AgentSubmissionReceipt = submissionRes.value;

      if (receipt.status === "rejected") {
        await this.releaseLease(lease, options);
        return {
          ok: false,
          error: {
            code: "conflict",
            retryable: true,
            message: `Agent rejected prompt: ${receipt.reason}`
          }
        };
      }

      if (receipt.status === "unknown_delivery") {
        const reconRes = await this.#transport.reconcile({
          requestId: agentRequest.requestId,
          attemptId: agentRequest.attemptId,
          runId: agentRequest.runId,
          taskId: agentRequest.taskId,
          idempotencyKey: agentRequest.idempotency.key,
          target: agentRequest.target,
          requestedAt: this.#clock().toISOString()
        }, options);
        if (!reconRes.ok) {
          await this.releaseLease(lease, options);
          return reconRes;
        }
        const reconResult = reconRes.value;

        if (reconResult.status === "bound") {
          const recRes = await this.#engine.recordDeliveryReconciliation({
            runId: agentRequest.runId,
            taskId: agentRequest.taskId,
            expectedVersion: activeSnapshot.version,
            requestId: agentRequest.requestId,
            result: reconResult,
            idempotencyKey: `recon:${snapshot.runId}:${taskId}:${agentRequest.requestId}`,
            occurredAt: this.#clock().toISOString()
          }, options);
          if (!recRes.ok) {
            await this.releaseLease(lease, options);
            return recRes;
          }
          if (recRes.value.emittedEvents.length > 0) {
            const appendReconRes = await this.persistEvents(
              snapshot.runId,
              activeSnapshot.version,
              activeSnapshot.lastEventSequence,
              recRes.value.emittedEvents,
              `recon-events:${snapshot.runId}:${taskId}:${agentRequest.requestId}`,
              options
            );
            if (!appendReconRes.ok) {
              await this.releaseLease(lease, options);
              return appendReconRes as OperationResult<AgentExecutionHandle>;
            }
          }
          this.#activeExecutions.set(`${snapshot.runId}:${taskId}`, {
            runId: snapshot.runId,
            taskId,
            attemptId: taskState.attemptId,
            attempt: taskState.attempt,
            lease,
            handle: reconResult.handle,
            target: targetLocator,
            startedAt: this.#clock().toISOString()
          });
          return { ok: true, value: reconResult.handle };
        } else if (reconResult.status === "not_delivered") {
          // Safe resend: lease is preserved, dispatch intent re-sent safely
          const recRes = await this.#engine.recordDeliveryReconciliation({
            runId: agentRequest.runId,
            taskId: agentRequest.taskId,
            expectedVersion: activeSnapshot.version,
            requestId: agentRequest.requestId,
            result: reconResult,
            idempotencyKey: `recon:${snapshot.runId}:${taskId}:${agentRequest.requestId}`,
            occurredAt: this.#clock().toISOString()
          }, options);
          if (recRes.ok && recRes.value.emittedEvents.length > 0) {
            const appendReconRes = await this.persistEvents(
              snapshot.runId,
              activeSnapshot.version,
              activeSnapshot.lastEventSequence,
              recRes.value.emittedEvents,
              `recon-events:${snapshot.runId}:${taskId}:${agentRequest.requestId}`,
              options
            );
            if (!appendReconRes.ok) {
              await this.releaseLease(lease, options);
              return appendReconRes as OperationResult<AgentExecutionHandle>;
            }
          }
          // Re-send prompt to transport safely
          const retrySubmission = await this.#transport.send(agentRequest, options);
          if (!retrySubmission.ok) {
            await this.releaseLease(lease, options);
            return retrySubmission;
          }
          const retryReceipt = retrySubmission.value;
          if (retryReceipt.status === "accepted") {
            const boundRes = await this.#engine.bindAgentExecution({
              runId: snapshot.runId,
              taskId,
              expectedVersion: recRes.ok ? recRes.value.snapshot.version : activeSnapshot.version,
              attempt: taskState.attempt,
              handle: retryReceipt.handle,
              idempotencyKey: `bind:${snapshot.runId}:${taskId}:${taskState.attemptId}`,
              occurredAt: this.#clock().toISOString()
            }, options);
            if (!boundRes.ok) {
              await this.releaseLease(lease, options);
              return boundRes;
            }
            const appendRetryBoundRes = await this.persistEvents(
              snapshot.runId,
              recRes.ok ? recRes.value.snapshot.version : activeSnapshot.version,
              recRes.ok ? recRes.value.snapshot.lastEventSequence : activeSnapshot.lastEventSequence,
              boundRes.value.emittedEvents,
              `bind-events:${snapshot.runId}:${taskId}:${taskState.attemptId}`,
              options
            );
            if (!appendRetryBoundRes.ok) {
              await this.releaseLease(lease, options);
              return appendRetryBoundRes as OperationResult<AgentExecutionHandle>;
            }
            this.#activeExecutions.set(`${snapshot.runId}:${taskId}`, {
              runId: snapshot.runId,
              taskId,
              attemptId: taskState.attemptId,
              attempt: taskState.attempt,
              lease,
              handle: retryReceipt.handle,
              target: targetLocator,
              startedAt: this.#clock().toISOString()
            });
            return { ok: true, value: retryReceipt.handle };
          }
          await this.releaseLease(lease, options);
          return { ok: false, error: { code: "conflict", retryable: true, message: `Resend returned ${retryReceipt.status}` } };
        } else {
          const recRes = await this.#engine.recordDeliveryReconciliation({
            runId: agentRequest.runId,
            taskId: agentRequest.taskId,
            expectedVersion: activeSnapshot.version,
            requestId: agentRequest.requestId,
            result: reconResult,
            idempotencyKey: `recon:${snapshot.runId}:${taskId}:${agentRequest.requestId}`,
            occurredAt: this.#clock().toISOString()
          }, options);
          if (recRes.ok && recRes.value.emittedEvents.length > 0) {
            const appendReconRes = await this.persistEvents(
              snapshot.runId,
              activeSnapshot.version,
              activeSnapshot.lastEventSequence,
              recRes.value.emittedEvents,
              `recon-events:${snapshot.runId}:${taskId}:${agentRequest.requestId}`,
              options
            );
            if (!appendReconRes.ok) {
              await this.releaseLease(lease, options);
              return appendReconRes as OperationResult<AgentExecutionHandle>;
            }
          }
          await this.releaseLease(lease, options);
          return {
            ok: false,
            error: {
              code: "unknown_delivery",
              retryable: false,
              manualInterventionRequired: true,
              message: "Delivery uncertain; manual intervention required"
            }
          };
        }
      }

      // 6. Accepted: Bind execution in engine and persist agent.execution_bound
      const boundRes = await this.#engine.bindAgentExecution({
        runId: snapshot.runId,
        taskId,
        expectedVersion: activeSnapshot.version,
        attempt: taskState.attempt,
        handle: receipt.handle,
        idempotencyKey: `bind:${snapshot.runId}:${taskId}:${taskState.attemptId}`,
        occurredAt: this.#clock().toISOString()
      }, options);
      if (!boundRes.ok) {
        await this.releaseLease(lease, options);
        return boundRes;
      }

      const appendBoundRes = await this.persistEvents(
        snapshot.runId,
        activeSnapshot.version,
        activeSnapshot.lastEventSequence,
        boundRes.value.emittedEvents,
        `bind-events:${snapshot.runId}:${taskId}:${taskState.attemptId}`,
        options
      );
      if (!appendBoundRes.ok) {
        await this.releaseLease(lease, options);
        return appendBoundRes as OperationResult<AgentExecutionHandle>;
      }

      this.#activeExecutions.set(`${snapshot.runId}:${taskId}`, {
        runId: snapshot.runId,
        taskId,
        attemptId: taskState.attemptId,
        attempt: taskState.attempt,
        lease,
        handle: receipt.handle,
        target: targetLocator,
        startedAt: this.#clock().toISOString()
      });

      return { ok: true, value: receipt.handle };
    } catch (err) {
      await this.releaseLease(lease, options);
      throw err;
    }
  }

  /**
   * Reconciles unknown delivery with the transport:
   * - 'bound': records delivery reconciliation (binds handle).
   * - 'not_delivered': records reconciliation, permitting safe resend.
   * - 'unknown_delivery': transitions task to 'blocked' (manual intervention).
   */
  async reconcileDelivery(
    request: AgentRequest,
    expectedVersion: number,
    options?: OperationOptions
  ): Promise<OperationResult<AgentExecutionHandle | null>> {
    const reconRes = await this.#transport.reconcile({
      requestId: request.requestId,
      attemptId: request.attemptId,
      runId: request.runId,
      taskId: request.taskId,
      idempotencyKey: request.idempotency.key,
      target: request.target,
      requestedAt: this.#clock().toISOString()
    }, options);
    if (!reconRes.ok) return reconRes;

    const result = reconRes.value;
    const recorded = await this.#engine.recordDeliveryReconciliation({
      runId: request.runId,
      taskId: request.taskId,
      expectedVersion,
      requestId: request.requestId,
      result,
      idempotencyKey: `recon:${request.runId}:${request.taskId}:${request.requestId}`,
      occurredAt: this.#clock().toISOString()
    }, options);
    if (!recorded.ok) return recorded;

    const currentStore = await this.#runStore.get(request.runId, options);
    if (!currentStore.ok || !currentStore.value) {
      return {
        ok: false,
        error: { code: "corruption", message: `Run ${request.runId} missing in store`, retryable: false }
      };
    }

    if (recorded.value.emittedEvents.length > 0) {
      const appendRes = await this.persistEvents(
        request.runId,
        currentStore.value.snapshot.version,
        currentStore.value.snapshot.lastEventSequence,
        recorded.value.emittedEvents,
        `recon-events:${request.runId}:${request.taskId}:${request.requestId}`,
        options
      );
      if (!appendRes.ok) return appendRes as OperationResult<AgentExecutionHandle | null>;
    }

    if (result.status === "bound") return { ok: true, value: result.handle };
    return { ok: true, value: null };
  }

  /**
   * Executes the 3-stage cancellation protocol:
   * 1. engine.requestCancellation() -> marks cancelling in aggregate.
   * 2. transport.cancel() -> interrupts agent execution.
   * 3. engine.confirmCancellationStop() -> transitions cancelling to cancelled.
   * Preserves task status if task completion won the race.
   */
  async cancelTask(
    runId: string,
    taskId: string,
    reason?: string | undefined,
    options?: OperationOptions
  ): Promise<OperationResult<void>> {
    const current = await this.#runStore.get(runId, options);
    if (!current.ok || !current.value) {
      return {
        ok: false,
        error: { code: "not_found", message: `Run ${runId} not found`, retryable: false }
      };
    }
    let snapshot = current.value.snapshot;

    const active = this.#activeExecutions.get(`${runId}:${taskId}`);
    const taskState = snapshot.tasks.find((t) => t.taskId === taskId);
    const handle = active?.handle ?? taskState?.agentExecution;
    const executionId = handle?.executionId;
    const cancellationId = randomUUID();

    // Stage 1: Request cancellation in engine
    const reqResult = await this.#engine.requestCancellation({
      schemaVersion: 1,
      cancellationId,
      runId,
      taskId,
      ...(executionId !== undefined ? { executionId } : {}),
      requestedBy: "runtime",
      requestedAt: this.#clock().toISOString(),
      expectedVersion: snapshot.version,
      reason: reason ?? "Task cancellation requested",
      idempotencyKey: `cancel-req:${runId}:${cancellationId}`
    }, options);
    if (!reqResult.ok) return reqResult;

    if (reqResult.value.emittedEvents.length > 0) {
      const appendReq = await this.persistEvents(
        runId,
        snapshot.version,
        snapshot.lastEventSequence,
        reqResult.value.emittedEvents,
        `cancel-req-events:${cancellationId}`,
        options
      );
      if (!appendReq.ok) return appendReq as OperationResult<void>;
      snapshot = reqResult.value.snapshot;
    }

    // Stage 2: Transport cancel if execution was bound
    if (handle) {
      const cancelOutcome = await this.#transport.cancel(handle, {
        schemaVersion: 1,
        cancellationId,
        runId,
        taskId,
        executionId: handle.executionId,
        requestedBy: "runtime",
        requestedAt: this.#clock().toISOString(),
        expectedVersion: snapshot.version,
        idempotencyKey: `cancel-transport:${cancellationId}`
      }, options);

      if (cancelOutcome.ok) {
        const recResult = await this.#engine.recordCancellationResult({
          runId,
          expectedVersion: snapshot.version,
          result: cancelOutcome.value,
          idempotencyKey: `cancel-rec:${cancellationId}`
        }, options);
        if (recResult.ok && recResult.value.emittedEvents.length > 0) {
          const appendRec = await this.persistEvents(
            runId,
            snapshot.version,
            snapshot.lastEventSequence,
            recResult.value.emittedEvents,
            `cancel-rec-events:${cancellationId}`,
            options
          );
          if (appendRec.ok) {
            snapshot = recResult.value.snapshot;
          }
        }
      }
    }

    // Stage 3: Confirm cancellation stop
    const stopResult = await this.#engine.confirmCancellationStop({
      runId,
      expectedVersion: snapshot.version,
      confirmation: {
        schemaVersion: 1,
        cancellationId,
        ...(executionId !== undefined ? { executionId } : {}),
        stoppedAt: this.#clock().toISOString(),
        terminalStatus: "cancelled"
      },
      idempotencyKey: `cancel-stop:${cancellationId}`
    }, options);
    if (!stopResult.ok) return stopResult;

    if (stopResult.value.emittedEvents.length > 0) {
      const appendStop = await this.persistEvents(
        runId,
        snapshot.version,
        snapshot.lastEventSequence,
        stopResult.value.emittedEvents,
        `cancel-stop-events:${cancellationId}`,
        options
      );
      if (!appendStop.ok) return appendStop as OperationResult<void>;
    }

    // Release lease
    if (active?.lease) {
      await this.releaseLease(active.lease, options);
    }
    this.#activeExecutions.delete(`${runId}:${taskId}`);

    return { ok: true, value: undefined };
  }

  /**
   * Releases the capacity lease in AgentRegistry, ensuring no capacity leaks.
   */
  async releaseLease(
    lease: AgentLease,
    options?: OperationOptions
  ): Promise<OperationResult<void>> {
    return this.#registry.releaseLease({
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      expectedVersion: lease.version,
      releasedAt: this.#clock().toISOString(),
      idempotencyKey: `release:${lease.leaseId}:${lease.version}`
    }, options);
  }

  get transport(): AgentTransport {
    return this.#transport;
  }

  getActiveExecution(runId: string, taskId: string): ActiveTaskExecution | undefined {
    return this.#activeExecutions.get(`${runId}:${taskId}`);
  }

  clearActiveExecution(runId: string, taskId: string): void {
    this.#activeExecutions.delete(`${runId}:${taskId}`);
  }
}
