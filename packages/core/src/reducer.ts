import {
  WorkflowRunSnapshotSchema,
  type DomainEvent,
  type TaskState,
  type WorkflowDefinition,
  type WorkflowRunSnapshot
} from "@ai-flow/contracts";

function hash(parts: readonly string[]): string {
  let value = 14695981039346656037n;
  const mask = (1n << 64n) - 1n;
  for (const character of parts.join("\u0000")) {
    value ^= BigInt(character.charCodeAt(0));
    value = (value * 1099511628211n) & mask;
  }
  return value.toString(36);
}

export function deterministicId(kind: string, ...parts: readonly string[]): string {
  const prefix = parts.join("-").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 96);
  return `${kind}-${prefix}-${hash([kind, ...parts])}`.slice(0, 200);
}

export function deterministicAttemptId(runId: string, taskId: string, generation: number, attempt: number): string {
  return deterministicId("attempt", runId, taskId, String(generation), String(attempt));
}

function initialSnapshot(definition: WorkflowDefinition, event: DomainEvent): WorkflowRunSnapshot {
  if (event.type !== "run.created") throw new Error("The first workflow event must be run.created");
  return WorkflowRunSnapshotSchema.parse({
    runId: event.runId,
    workflowId: event.payload.workflowId,
    workflowVersion: event.payload.workflowVersion,
    status: "queued",
    ...(event.payload.input === undefined ? {} : { input: event.payload.input }),
    tasks: definition.tasks.map((task) => ({
      taskId: task.id,
      status: "pending",
      attempt: 0,
      generation: 0,
      version: 0
    })),
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
    version: event.aggregateVersion,
    lastEventSequence: event.sequence,
    ...(event.metadata === undefined ? {} : { metadata: event.metadata })
  });
}

function updateTask(
  snapshot: WorkflowRunSnapshot,
  taskId: string,
  update: (task: TaskState) => TaskState
): TaskState[] {
  let found = false;
  const tasks = snapshot.tasks.map((task) => {
    if (task.taskId !== taskId) return task;
    found = true;
    return update(task);
  });
  if (!found) throw new Error(`Event references unknown task: ${taskId}`);
  return tasks;
}

export function reduceWorkflowEvent(
  snapshot: WorkflowRunSnapshot | undefined,
  event: DomainEvent,
  definition: WorkflowDefinition
): WorkflowRunSnapshot {
  if (snapshot === undefined) return initialSnapshot(definition, event);
  if (event.runId !== snapshot.runId) throw new Error("Event runId does not match snapshot");
  if (event.sequence !== snapshot.lastEventSequence + 1 || event.aggregateVersion !== snapshot.version + 1) {
    throw new Error("Event sequence and aggregate version must be contiguous");
  }

  let next: WorkflowRunSnapshot = {
    ...snapshot,
    updatedAt: event.occurredAt,
    version: event.aggregateVersion,
    lastEventSequence: event.sequence
  };

  if (event.type === "run.status_changed") {
    next = { ...next, status: event.payload.to };
  } else if (event.type === "task.status_changed") {
    const taskId = event.taskId;
    if (taskId === undefined) throw new Error("Task status event is missing taskId");
    next = {
      ...next,
      tasks: updateTask(snapshot, taskId, (task) => {
        const enteringRun = event.payload.to === "running" && event.payload.from !== "waiting";
        const enteringReady = event.payload.to === "ready";
        const terminal = ["succeeded", "failed", "cancelled"].includes(event.payload.to);
        const base: TaskState = {
          ...task,
          status: event.payload.to,
          attempt: event.payload.attempt,
          generation: event.payload.generationTo,
          version: task.version + 1
        };
        if (enteringRun) {
          return {
            ...base,
            attemptId: deterministicAttemptId(snapshot.runId, taskId, event.payload.generationTo, event.payload.attempt),
            startedAt: event.occurredAt
          };
        }
        if (enteringReady) {
          const { agentExecution: _agentExecution, attemptId: _attemptId, blockage: _blockage,
            startedAt: _startedAt, completedAt: _completedAt, ...ready } = base;
          return ready;
        }
        if (terminal) return { ...base, completedAt: event.occurredAt };
        if (event.payload.to === "blocked" && event.payload.blockage !== undefined) {
          return { ...base, blockage: event.payload.blockage };
        }
        if (event.payload.to !== "blocked") {
          const { blockage: _blockage, ...unblocked } = base;
          return unblocked;
        }
        return base;
      })
    };
  } else if (event.type === "agent.execution_bound") {
    const taskId = event.taskId;
    if (taskId === undefined) throw new Error("Execution binding event is missing taskId");
    next = {
      ...next,
      tasks: updateTask(snapshot, taskId, (task) => ({
        ...task,
        attempt: event.payload.attempt,
        attemptId: event.payload.handle.attemptId,
        agentExecution: event.payload.handle,
        version: task.version + 1
      }))
    };
  } else if (event.type === "agent.delivery_reconciled" && event.payload.status === "bound") {
    const taskId = event.taskId;
    if (taskId === undefined) throw new Error("Delivery reconciliation event is missing taskId");
    const handle = event.payload.handle;
    next = {
      ...next,
      tasks: updateTask(snapshot, taskId, (task) => ({
        ...task,
        attemptId: handle.attemptId,
        agentExecution: handle,
        version: task.version + 1
      }))
    };
  }

  return WorkflowRunSnapshotSchema.parse(next);
}
