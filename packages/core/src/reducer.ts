import {
  WorkflowRunSnapshotSchema,
  validateExecutionContinuation,
  type DomainEvent,
  type TaskState,
  type WorkflowDefinition,
  type WorkflowRunSnapshot
} from "@bflow/contracts";

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
  if (event.sequence !== 1 || event.aggregateVersion !== 1 ||
      event.payload.workflowId !== definition.id || event.payload.workflowVersion !== definition.version) {
    throw new Error("run.created position or workflow definition does not match");
  }
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
    if (event.payload.from !== snapshot.status) throw new Error("Run status event source does not match current state");
    next = { ...next, status: event.payload.to };
  } else if (event.type === "task.status_changed") {
    const taskId = event.taskId;
    if (taskId === undefined) throw new Error("Task status event is missing taskId");
    next = {
      ...next,
      tasks: updateTask(snapshot, taskId, (task) => {
        if (task.status !== event.payload.from || task.generation !== event.payload.generationFrom) {
          throw new Error("Task status event source or generation does not match current state");
        }
        const expectedAttempt = task.status === "ready" && event.payload.to === "running"
          ? task.attempt + 1 : task.attempt;
        if (event.payload.attempt !== expectedAttempt) throw new Error("Task status event attempt is not contiguous");
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
          const { agentExecution: _agentExecution, bindingVerification: _bindingVerification, attemptId: _attemptId, blockage: _blockage,
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
      tasks: updateTask(snapshot, taskId, (task) => {
        if (!["running", "waiting", "blocked", "cancelling"].includes(task.status) ||
            task.attempt !== event.payload.attempt || task.attemptId !== event.payload.handle.attemptId ||
            event.payload.handle.runId !== snapshot.runId || event.payload.handle.taskId !== taskId ||
            (event.payload.continuation ? !validateExecutionContinuation(task, event.payload.handle, event.payload.continuation, event.occurredAt) : task.agentExecution !== undefined)) {
          throw new Error("Execution binding does not match the current task attempt");
        }
        const { bindingVerification: _priorVerification, ...rest } = task;
        return { ...rest, agentExecution: event.payload.handle, version: task.version + 1 };
      })
    };
  } else if (event.type === "agent.delivery_reconciled" && event.payload.status === "bound") {
    const taskId = event.taskId;
    if (taskId === undefined) throw new Error("Delivery reconciliation event is missing taskId");
    const handle = event.payload.handle;
    next = {
      ...next,
      tasks: updateTask(snapshot, taskId, (task) => {
        if (handle.runId !== snapshot.runId || handle.taskId !== taskId || task.attemptId !== handle.attemptId ||
            task.agentExecution !== undefined) {
          throw new Error("Reconciled execution conflicts with the current binding");
        }
        return { ...task, agentExecution: handle, version: task.version + 1 };
      })
    };
  } else if (event.type === "agent.binding_verified") {
    next = { ...next, tasks: updateTask(snapshot, event.taskId!, task => {
      if (!task.agentExecution || task.bindingVerification || task.attemptId !== event.payload.receipt.handle.attemptId)
        throw new Error("Binding proof does not match the current execution");
      return { ...task, bindingVerification: event.payload, version: task.version + 1 };
    }) };
  } else if (event.type === "agent.result_recorded") {
    const task = snapshot.tasks.find((candidate) => candidate.taskId === event.taskId);
    const bound = task?.agentExecution;
    const result = event.payload;
    const correlation = task?.bindingVerification?.receipt.correlation ?? bound?.correlation;
    if (task === undefined || bound === undefined || task.attemptId !== result.attemptId ||
        bound.executionId !== result.executionId || bound.requestId !== result.requestId ||
        result.runId !== snapshot.runId || result.taskId !== task.taskId ||
        result.verification.status !== "verified" || !result.verification.correlation.verified ||
        !correlation?.verified || result.verification.correlation.token !== correlation.token ||
        result.verification.correlation.provenance !== correlation.provenance) {
      throw new Error("Agent result is not verified for the bound execution");
    }
  }

  return WorkflowRunSnapshotSchema.parse(next);
}
