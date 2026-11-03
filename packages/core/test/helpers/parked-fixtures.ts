import type {
  AgentExecutionHandle,
  AgentResult,
  CancellationStopConfirmation,
  OperationResult,
  TaskDependency,
  TaskState,
  WorkflowAdvanceResult,
  WorkflowDefinition
} from "@bflow/contracts";
import type { DeterministicWorkflowEngine } from "../../src/index.js";

// Shared fixtures for the B2b `parked` tests. They follow the bind + verified-result pattern of
// workflow-engine.test.ts (`bind`/`recordResult`/`finishTask`): a task only succeeds from a verified,
// correlated AgentResult of its bound execution.

export const time = "2026-11-03T00:00:00.000Z";
export const later = "2026-11-03T00:01:00.000Z";

export function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

export function definition(
  taskIds: readonly string[],
  dependencies: readonly TaskDependency[] = [],
  options: { readonly maxConcurrency?: number; readonly failurePolicy?: WorkflowDefinition["failurePolicy"] } = {}
): WorkflowDefinition {
  return {
    schemaVersion: "1",
    id: "parked-delivery",
    name: "Parked delivery",
    version: "1.0.0",
    tasks: taskIds.map((id) => ({
      id,
      title: id,
      role: "implementer",
      instruction: `Implement ${id}`,
      acceptanceCriteria: ["done"],
      retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
      timeout: { executionTimeoutMs: 10_000, onTimeout: "block" },
      requiresApproval: false,
      qualityGates: []
    })),
    dependencies: [...dependencies],
    qualityGates: [],
    maxConcurrency: options.maxConcurrency ?? 2,
    failurePolicy: options.failurePolicy ?? "continue-independent",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
  };
}

export function taskOf(state: WorkflowAdvanceResult, taskId: string): TaskState {
  const task = state.snapshot.tasks.find((candidate) => candidate.taskId === taskId);
  if (task === undefined) throw new Error(`Missing task ${taskId}`);
  return task;
}

export function statusOf(state: WorkflowAdvanceResult, taskId: string): TaskState["status"] {
  return taskOf(state, taskId).status;
}

/** Drives one run with unique idempotency keys and the current expected version. */
export class Driver {
  #counter = 0;
  constructor(readonly engine: DeterministicWorkflowEngine, public state: WorkflowAdvanceResult, readonly prefix = "k") {}

  key(label: string): string {
    this.#counter += 1;
    return `${this.prefix}-${label}-${this.#counter}`;
  }

  async advance(): Promise<WorkflowAdvanceResult> {
    this.state = unwrap(await this.engine.advance({ runId: this.state.snapshot.runId, expectedVersion: this.state.snapshot.version,
      idempotencyKey: this.key("advance"), occurredAt: later }));
    return this.state;
  }

  async transition(taskId: string, to: TaskState["status"], intent: "normal" | "park" | "unpark" | "cancel" | "retry" | "rework",
    extra: { readonly stopConfirmation?: CancellationStopConfirmation } = {}) {
    const task = taskOf(this.state, taskId);
    return this.engine.transitionTask({ runId: this.state.snapshot.runId, taskId, expectedVersion: this.state.snapshot.version,
      from: task.status, to, intent, generationFrom: task.generation, generationTo: task.generation,
      idempotencyKey: this.key(`${intent}-${taskId}`), occurredAt: later, ...extra });
  }

  async move(taskId: string, to: TaskState["status"], intent: "normal" | "park" | "unpark" | "cancel",
    extra: { readonly stopConfirmation?: CancellationStopConfirmation } = {}): Promise<WorkflowAdvanceResult> {
    this.state = unwrap(await this.transition(taskId, to, intent, extra));
    return this.state;
  }

  handle(taskId: string, suffix = "1"): AgentExecutionHandle {
    const task = taskOf(this.state, taskId);
    if (task.attemptId === undefined) throw new Error(`Task ${taskId} has no attempt`);
    return {
      executionId: `execution-${taskId}-${task.attempt}-${suffix}`,
      requestId: `request-${taskId}-${task.attempt}-${suffix}`,
      attemptId: task.attemptId,
      runId: this.state.snapshot.runId,
      taskId,
      idempotencyKey: `agent/${taskId}/${task.attempt}/${suffix}`,
      target: { transport: "test", agentId: "agent-1", paneId: "pane-1" },
      correlation: { token: `remote-${taskId}-${task.attempt}-${suffix}`, provenance: "remote", verified: true },
      acceptedAt: time
    };
  }

  async bind(taskId: string): Promise<AgentExecutionHandle> {
    const handle = this.handle(taskId);
    this.state = unwrap(await this.engine.bindAgentExecution({ runId: this.state.snapshot.runId, taskId,
      expectedVersion: this.state.snapshot.version, attempt: taskOf(this.state, taskId).attempt, handle,
      idempotencyKey: this.key(`bind-${taskId}`), occurredAt: time }));
    return handle;
  }

  /** Record a verified `blocked` result for the bound execution (task moves to blocked, execution stays bound). */
  async block(taskId: string, handle: AgentExecutionHandle): Promise<WorkflowAdvanceResult> {
    const result: AgentResult = {
      requestId: handle.requestId, attemptId: handle.attemptId, runId: handle.runId, taskId, executionId: handle.executionId,
      status: "blocked", verification: { status: "verified", evidence: "signed-result", correlation: handle.correlation },
      artifactProposals: [], retryable: true, startedAt: time, completedAt: later,
      blockage: { code: "external_dependency", message: "waiting", since: time, retryable: true }
    };
    this.state = unwrap(await this.engine.recordAgentResult({ runId: this.state.snapshot.runId, taskId,
      expectedVersion: this.state.snapshot.version, result, idempotencyKey: this.key(`blocked-${taskId}`), occurredAt: later }));
    return this.state;
  }

  /** Bind the running task's execution and record a verified, non-retryable failed result for it. */
  async fail(taskId: string): Promise<WorkflowAdvanceResult> {
    const handle = await this.bind(taskId);
    const result: AgentResult = {
      requestId: handle.requestId, attemptId: handle.attemptId, runId: handle.runId, taskId, executionId: handle.executionId,
      status: "failed", verification: { status: "verified", evidence: "signed-result", correlation: handle.correlation },
      artifactProposals: [], retryable: false, startedAt: time, completedAt: later,
      error: { code: "agent_error", message: "failed", retryable: false }
    };
    this.state = unwrap(await this.engine.recordAgentResult({ runId: this.state.snapshot.runId, taskId,
      expectedVersion: this.state.snapshot.version, result, idempotencyKey: this.key(`failed-${taskId}`), occurredAt: later }));
    return this.state;
  }

  /** Bind the running task's execution and record a verified successful result for it. */
  async succeed(taskId: string): Promise<WorkflowAdvanceResult> {
    const handle = await this.bind(taskId);
    const result: AgentResult = {
      requestId: handle.requestId, attemptId: handle.attemptId, runId: handle.runId, taskId, executionId: handle.executionId,
      status: "succeeded", verification: { status: "verified", evidence: "signed-result", correlation: handle.correlation },
      artifactProposals: [], retryable: false, startedAt: time, completedAt: later
    };
    this.state = unwrap(await this.engine.recordAgentResult({ runId: this.state.snapshot.runId, taskId,
      expectedVersion: this.state.snapshot.version, result, idempotencyKey: this.key(`result-${taskId}`), occurredAt: later }));
    return this.state;
  }
}
