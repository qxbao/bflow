import { canonicalReceiptJson, validateExecutionContinuation, StoredRunSchema, type DomainEvent, type StoredRun, type TaskState } from "@bflow/contracts";
import { fail, parse } from "./support.js";

/** A storage/index projection, not Core replay. Never derives business outcomes or invents attempt IDs. */
export function project(run: StoredRun, events: readonly DomainEvent[]): StoredRun {
  const snapshot = structuredClone(run.snapshot);
  for (const event of events) {
    if (event.type === "run.created") {
      if (event.payload.workflowId !== run.definition.id || event.payload.workflowVersion !== run.definition.version) fail("validation", "Workflow identity mismatch");
      if (event.payload.input !== undefined) snapshot.input = event.payload.input;
    }
    if (event.type === "run.status_changed") {
      if (snapshot.status !== event.payload.from) fail("validation", "Run transition source mismatch");
      snapshot.status = event.payload.to;
    }
    if (event.taskId !== undefined && !snapshot.tasks.some((task) => task.taskId === event.taskId)) fail("validation", "Event targets unknown task");
    const task = snapshot.tasks.find((item) => item.taskId === event.taskId);
    if (task !== undefined && event.type === "task.status_changed") {
      if (task.status !== event.payload.from || task.generation !== event.payload.generationFrom ||
        event.payload.attempt !== task.attempt + (task.status === "ready" && event.payload.to === "running" ? 1 : 0)) {
        fail("validation", "Task transition source, generation or attempt mismatch");
      }
      task.status = event.payload.to;
      task.generation = event.payload.generationTo;
      task.attempt = event.payload.attempt;
      task.version++;
      if (task.status === "ready") {
        clearAttempt(task);
      } else {
        if (task.status === "running" && event.payload.from !== "waiting") task.startedAt = event.occurredAt;
        if (["succeeded", "failed", "cancelled"].includes(task.status)) task.completedAt = event.occurredAt;
        if (task.status !== "blocked") delete task.blockage;
        else if (event.payload.blockage !== undefined) task.blockage = event.payload.blockage;
      }
    }
    if (task !== undefined && event.type === "task.dispatch_requested") {
      task.attemptId = event.payload.attemptId;
    }
    if (task !== undefined && event.type === "agent.execution_bound") {
      if (task.attempt !== event.payload.attempt || (event.payload.continuation ? snapshot.status === "cancelling" ||
          !validateExecutionContinuation(task, event.payload.handle, event.payload.continuation, event.occurredAt) : task.agentExecution !== undefined) ||
        task.attemptId !== undefined && task.attemptId !== event.payload.handle.attemptId) fail("validation", "Execution binding mismatch");
      task.attemptId = event.payload.handle.attemptId;
      task.agentExecution = event.payload.handle;
      delete task.bindingVerification;
      task.version++;
    }
    if (task !== undefined && event.type === "agent.binding_verified") {
      if (!task.agentExecution || task.bindingVerification || task.attemptId !== event.payload.receipt.handle.attemptId ||
          canonicalReceiptJson(task.agentExecution) !== canonicalReceiptJson(event.payload.receipt.handle))
        fail("validation", "Binding proof projection does not match the immutable execution");
      task.bindingVerification = event.payload;
      task.version++;
    }
    if (task !== undefined && event.type === "agent.delivery_reconciled" && event.payload.status === "bound") {
      const handle = event.payload.handle;
      if (handle.runId !== snapshot.runId || handle.taskId !== task.taskId || task.agentExecution !== undefined ||
        task.attemptId !== undefined && task.attemptId !== handle.attemptId) fail("validation", "Reconciled execution binding mismatch");
      task.attemptId = handle.attemptId;
      task.agentExecution = handle;
      task.version++;
    }
    snapshot.version = event.aggregateVersion;
    snapshot.lastEventSequence = event.sequence;
    snapshot.updatedAt = event.occurredAt;
  }
  return parse(StoredRunSchema, { definition: run.definition, snapshot });
}
function clearAttempt(task: TaskState): void {
  delete task.attemptId; delete task.agentExecution; delete task.bindingVerification; delete task.blockage;
  delete task.startedAt; delete task.completedAt;
}
