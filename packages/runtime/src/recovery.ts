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
} from "@ai-flow/contracts";

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

  if (checkpoint !== null) {
    // Validate checkpoint envelope
    const parsedCp = parseRecoveryCheckpointWithCompatibility(checkpoint);
    if (!parsedCp.ok) return parsedCp as OperationResult<WorkflowRecoveryResult>;

    // Reject non-aggregate codec for tail recovery
    if (checkpoint.codec.name !== "ai-flow.workflow-aggregate+json" || checkpoint.codec.version !== 1) {
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

  // 6. Reconcile in-flight bound executions against AgentTransport
  const reconciledTasks: string[] = [];
  const clock = ports.clock ?? (() => new Date());

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

          if (recordRes.ok && recordRes.value.emittedEvents.length > 0) {
            await ports.runStore.appendEvents({
              runId,
              expectedVersion: currentSnapshot.version,
              expectedLastSequence: currentSnapshot.lastEventSequence,
              events: recordRes.value.emittedEvents,
              idempotencyKey: `recon-events-restart:${handle.requestId}`
            }, options);
            currentSnapshot = recordRes.value.snapshot;
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
