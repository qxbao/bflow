import {
  IdentifierSchema,
  decodeWorkflowAggregateCheckpointState,
  parseRecoveryCheckpointWithCompatibility,
  type AgentExecutionHandle,
  type AgentTransport,
  type DomainEvent,
  type OperationOptions,
  type OperationResult,
  type RecoverRunCommand,
  type RunStore,
  type WorkflowEngine,
  type WorkflowRunSnapshot
} from "@bflow/contracts";

export interface WorkflowRecoveryResult {
  readonly snapshot: WorkflowRunSnapshot;
  readonly reconciledTasks: readonly string[];
}

export interface RecoveryPorts {
  readonly engine: WorkflowEngine;
  readonly runStore: RunStore;
  readonly transport: AgentTransport;
  readonly clock?: (() => Date) | undefined;
}

export function eventTailCursor(runId: string, afterSequence: number): string {
  return Buffer.from(
    JSON.stringify({ v: 1, scope: `events:${runId}`, position: afterSequence })
  ).toString("base64url");
}

export async function recoverWorkflowRun(
  runId: string,
  ports: RecoveryPorts,
  options?: OperationOptions
): Promise<OperationResult<WorkflowRecoveryResult>> {
  // 1. Validate runId
  const idRes = IdentifierSchema.safeParse(runId);
  if (!idRes.success) {
    return {
      ok: false,
      error: {
        code: "validation",
        retryable: false,
        message: `Invalid runId: ${runId}`
      }
    };
  }

  // 2. Fetch StoredRun from RunStore
  const storedRunRes = await ports.runStore.get(runId, options);
  if (!storedRunRes.ok) return storedRunRes;
  if (storedRunRes.value === null) {
    return {
      ok: false,
      error: {
        code: "not_found",
        retryable: false,
        message: `Run ${runId} not found`
      }
    };
  }
  const storedRun = storedRunRes.value;

  // 3. Ensure engine has workflow definition registered/validated
  const defResult = await ports.engine.validateDefinition(storedRun.definition);
  if (!defResult.ok) return defResult as OperationResult<WorkflowRecoveryResult>;

  // 4. Load latest checkpoint
  const checkpointRes = await ports.runStore.loadLatestCheckpoint(runId, options);
  if (!checkpointRes.ok) return checkpointRes;
  const checkpoint = checkpointRes.value;

  let recoverCommand: RecoverRunCommand;
  let cachedAllEvents: DomainEvent[] | undefined = undefined;

  if (checkpoint !== null) {
    // Validate checkpoint envelope
    const parsedCp = parseRecoveryCheckpointWithCompatibility(checkpoint);
    if (!parsedCp.ok) return parsedCp as OperationResult<WorkflowRecoveryResult>;

    // Reject non-aggregate codec for tail recovery
    if (checkpoint.codec.name !== "bflow.workflow-aggregate+json" || ![1, 2].includes(checkpoint.codec.version)) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Recovery requires complete event history or a complete aggregate checkpoint (got codec ${checkpoint.codec.name} v${checkpoint.codec.version})`
        }
      };
    }

    // Decode aggregate state
    const decoded = decodeWorkflowAggregateCheckpointState(checkpoint);
    if (!decoded.ok) return decoded as OperationResult<WorkflowRecoveryResult>;

    // Read event tail strictly after checkpoint.eventSequence
    const tailEvents: DomainEvent[] = [];
    let cursor: string | undefined = eventTailCursor(runId, checkpoint.eventSequence);

    while (cursor !== undefined) {
      const pageRes = await ports.runStore.readEvents(runId, { cursor, limit: 100 }, options);
      if (!pageRes.ok) return pageRes;
      tailEvents.push(...pageRes.value.items.filter((e) => e.sequence > checkpoint.eventSequence));
      cursor = pageRes.value.nextCursor;
    }

    recoverCommand = {
      runId,
      checkpoint,
      events: tailEvents,
      expectedVersion: storedRun.snapshot.version
    };
  } else {
    // No checkpoint: Read complete event history from sequence 1
    const allEvents: DomainEvent[] = [];
    let cursor: string | undefined = undefined;

    while (true) {
      const pageRes = await ports.runStore.readEvents(
        runId,
        cursor !== undefined ? { cursor, limit: 100 } : { limit: 100 },
        options
      );
      if (!pageRes.ok) return pageRes;
      allEvents.push(...pageRes.value.items);
      if (pageRes.value.nextCursor === undefined) break;
      cursor = pageRes.value.nextCursor;
    }

    if (allEvents.length === 0 || allEvents[0]?.type !== "run.created" || allEvents[0]?.sequence !== 1) {
      return {
        ok: false,
        error: {
          code: "corruption",
          retryable: false,
          message: "Run history is missing initial run.created event at sequence 1"
        }
      };
    }

    cachedAllEvents = allEvents;
    recoverCommand = {
      runId,
      events: allEvents,
      expectedVersion: storedRun.snapshot.version
    };
  }

  // 5. Invoke engine.recover
  const recoverRes = await ports.engine.recover(recoverCommand, options);
  if (!recoverRes.ok) return recoverRes;
  let currentSnapshot = recoverRes.value.snapshot;

  // 6. Reconcile in-flight bound executions and unbound dispatch intents against AgentTransport
  const reconciledTasks: string[] = [];
  const clock = ports.clock ?? (() => new Date());

  const loadAllRunEvents = async (): Promise<OperationResult<DomainEvent[]>> => {
    if (cachedAllEvents !== undefined) {
      return { ok: true, value: cachedAllEvents };
    }
    const events: DomainEvent[] = [];
    let cursor: string | undefined = undefined;
    while (true) {
      const pageRes = await ports.runStore.readEvents(
        runId,
        cursor !== undefined ? { cursor, limit: 100 } : { limit: 100 },
        options
      );
      if (!pageRes.ok) return pageRes;
      events.push(...pageRes.value.items);
      if (pageRes.value.nextCursor === undefined) break;
      cursor = pageRes.value.nextCursor;
    }
    cachedAllEvents = events;
    return { ok: true, value: events };
  };

  for (const task of currentSnapshot.tasks) {
    if (["running", "cancelling"].includes(task.status) && task.agentExecution !== undefined) {
      const handle: AgentExecutionHandle = task.agentExecution;
      const reconRes = await ports.transport.reconcile(
        {
          requestId: handle.requestId,
          attemptId: handle.attemptId,
          runId,
          taskId: task.taskId,
          idempotencyKey: `recon-restart:${handle.requestId}`,
          target: handle.target,
          requestedAt: clock().toISOString()
        },
        options
      );

      if (reconRes.ok) {
        reconciledTasks.push(task.taskId);
        if (reconRes.value.status === "bound") {
          const recordRes = await ports.engine.recordDeliveryReconciliation({
            runId,
            taskId: task.taskId,
            expectedVersion: currentSnapshot.version,
            requestId: handle.requestId,
            result: reconRes.value,
            idempotencyKey: `recon-rec-restart:${handle.requestId}`,
            occurredAt: clock().toISOString()
          }, options);

          if (recordRes.ok) {
            if (recordRes.value.emittedEvents.length > 0) {
              const appendRes = await ports.runStore.appendEvents({
                runId,
                expectedVersion: currentSnapshot.version,
                expectedLastSequence: currentSnapshot.lastEventSequence,
                events: recordRes.value.emittedEvents,
                idempotencyKey: `recon-events-restart:${handle.requestId}`
              }, options);
              if (!appendRes.ok) return appendRes;
            }
            currentSnapshot = recordRes.value.snapshot;
          }
        }
      }
    } else if (
      ["running", "waiting", "blocked", "cancelling"].includes(task.status) &&
      task.agentExecution === undefined &&
      task.attemptId !== undefined
    ) {
      const eventsRes = await loadAllRunEvents();
      if (!eventsRes.ok) return eventsRes;

      const dispatchEvent = [...eventsRes.value]
        .reverse()
        .find(
          (e) =>
            e.type === "task.dispatch_requested" &&
            (e.taskId === task.taskId || (e.payload as { taskId?: string }).taskId === task.taskId) &&
            e.payload.attemptId === task.attemptId
        );

      if (dispatchEvent && dispatchEvent.type === "task.dispatch_requested") {
        const dispatchPayload = dispatchEvent.payload;
        const reconRes = await ports.transport.reconcile(
          {
            requestId: dispatchPayload.requestId,
            attemptId: dispatchPayload.attemptId,
            runId,
            taskId: task.taskId,
            idempotencyKey: `recon-restart:${dispatchPayload.requestId}`,
            target: dispatchPayload.target,
            requestedAt: clock().toISOString()
          },
          options
        );

        if (reconRes.ok) {
          reconciledTasks.push(task.taskId);
          const recordRes = await ports.engine.recordDeliveryReconciliation(
            {
              runId,
              taskId: task.taskId,
              expectedVersion: currentSnapshot.version,
              requestId: dispatchPayload.requestId,
              result: reconRes.value,
              idempotencyKey: `recon-rec-restart:${dispatchPayload.requestId}:${currentSnapshot.version}`,
              occurredAt: clock().toISOString()
            },
            options
          );

          if (recordRes.ok) {
            if (recordRes.value.emittedEvents.length > 0) {
              const appendRes = await ports.runStore.appendEvents(
                {
                  runId,
                  expectedVersion: currentSnapshot.version,
                  expectedLastSequence: currentSnapshot.lastEventSequence,
                  events: recordRes.value.emittedEvents,
                  idempotencyKey: `recon-events-restart:${dispatchPayload.requestId}:${currentSnapshot.version}`
                },
                options
              );
              if (!appendRes.ok) return appendRes;
            }
            currentSnapshot = recordRes.value.snapshot;
          }

          const refreshedTask = currentSnapshot.tasks.find((t) => t.taskId === task.taskId);
          if (refreshedTask && refreshedTask.status === "blocked") {
            if (
              reconRes.value.status === "bound" ||
              (reconRes.value.status === "not_delivered" && reconRes.value.retrySafe)
            ) {
              const unblockRes = await ports.engine.transitionTask(
                {
                  runId,
                  taskId: task.taskId,
                  expectedVersion: currentSnapshot.version,
                  from: "blocked",
                  to: "running",
                  intent: "normal",
                  generationFrom: refreshedTask.generation,
                  generationTo: refreshedTask.generation,
                  reason:
                    reconRes.value.status === "bound"
                      ? "Reconciled as bound on recovery"
                      : "Reconciled as not_delivered (retrySafe) on recovery",
                  idempotencyKey: `recon-unblock-bound:${dispatchPayload.requestId}:${currentSnapshot.version}`,
                  occurredAt: clock().toISOString()
                },
                options
              );

              if (unblockRes.ok) {
                if (unblockRes.value.emittedEvents.length > 0) {
                  const appendUnblock = await ports.runStore.appendEvents(
                    {
                      runId,
                      expectedVersion: currentSnapshot.version,
                      expectedLastSequence: currentSnapshot.lastEventSequence,
                      events: unblockRes.value.emittedEvents,
                      idempotencyKey: `recon-unblock-events:${dispatchPayload.requestId}:${currentSnapshot.version}`
                    },
                    options
                  );
                  if (!appendUnblock.ok) return appendUnblock;
                }
                currentSnapshot = unblockRes.value.snapshot;
              }
            }
          }
        }
      }
    }
  }

  return {
    ok: true,
    value: {
      snapshot: currentSnapshot,
      reconciledTasks
    }
  };
}
