import {
  AdvanceRunCommandSchema,
  ApplyApprovalCommandSchema,
  BindAgentExecutionCommandSchema,
  CancellationRequestSchema,
  ConfirmCancellationStopCommandSchema,
  CreateCheckpointCommandSchema,
  CreateRunCommandSchema,
  CURRENT_DOMAIN_EVENT_SCHEMA_VERSION,
  DomainEventSchema,
  EvaluateQualityGateCommandSchema,
  IdentifierSchema,
  RecordAgentResultCommandSchema,
  RecordCancellationResultCommandSchema,
  RecordDeliveryReconciliationCommandSchema,
  RecordQualityGateResultCommandSchema,
  RecoverRunCommandSchema,
  RecoveryCheckpointSchema,
  RequestApprovalCommandSchema,
  TaskTransitionCommandSchema,
  WorkflowDefinitionSchema,
  WorkflowRunSnapshotSchema,
  WorkflowAggregateCheckpointStateSchema,
  decodeWorkflowAggregateCheckpointState,
  decodeWorkflowRunCheckpointState,
  fingerprintWorkflowCommand,
  parseDomainEventWithCompatibility,
  parseRecoveryCheckpointWithCompatibility,
  validateRunTransition,
  validateEventBatch,
  validateTaskTransition,
  type ApprovalDecision,
  type ApprovalRequest,
  type CancellationRequest,
  type CancellationResult,
  type CancellationStopConfirmation,
  type ContractError,
  type DomainEvent,
  type OperationOptions,
  type OperationResult,
  type RecoveryCheckpoint,
  type QualityGateBinding,
  type TaskState,
  type WorkflowAdvanceResult,
  type WorkflowAggregateCheckpointState,
  type WorkflowDefinition,
  type WorkflowEngine,
  type WorkflowRunSnapshot
} from "@ai-flow/contracts";
import {
  approvalKey,
  buildDependencyIndex,
  dependenciesSatisfied,
  dependencyPermanentlyUnsatisfied,
  requiredGatesSatisfied,
  selectRunnableTasks,
  taskApprovalSatisfied,
  taskBusinessSucceeded,
  type GateOutcome,
  type SchedulingContext
} from "./graph.js";
import { deterministicId, reduceWorkflowEvent } from "./reducer.js";

interface ApprovalRecord {
  readonly request: ApprovalRequest;
  readonly decision?: ApprovalDecision;
}

interface GateRequestRecord {
  readonly evaluationId: string;
  readonly gateId: string;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly generation: number;
  readonly phase: QualityGateBinding["phase"];
}

interface CachedCommand {
  readonly receipt: CommandReceipt;
  readonly result: WorkflowAdvanceResult;
}

type CommandReceipt = Extract<DomainEvent, { type: "command.completed" }>["payload"];
type SuccessfulAttempt = WorkflowAggregateCheckpointState["successfulAttempts"][number];
type RetrySchedule = WorkflowAggregateCheckpointState["retrySchedules"][number];
type AttemptBaseline = WorkflowAggregateCheckpointState["attemptBaselines"][number];

interface CancellationRecord {
  readonly request: CancellationRequest;
  readonly result?: CancellationResult;
  readonly confirmations: readonly CancellationStopConfirmation[];
}

interface WorkflowAggregate {
  readonly definition: WorkflowDefinition;
  snapshot: WorkflowRunSnapshot;
  readonly approvalsById: Map<string, ApprovalRecord>;
  readonly approvalDecisions: Map<string, ApprovalDecision>;
  readonly gateRequests: Map<string, GateRequestRecord>;
  readonly gateOutcomes: GateOutcome[];
  readonly successfulAttempts: Map<string, SuccessfulAttempt>;
  readonly cancellations: Map<string, CancellationRecord>;
  readonly retrySchedules: Map<string, RetrySchedule>;
  readonly attemptBaselines: Map<string, AttemptBaseline>;
  readonly commands: Map<string, CachedCommand>;
  readonly pendingCommandEvents: DomainEvent[];
}

export interface DeterministicWorkflowEngineOptions {
  readonly definitions?: readonly WorkflowDefinition[];
  readonly resolveDefinition?: (workflowId: string, workflowVersion: string) => WorkflowDefinition | undefined;
  readonly now?: () => string;
}

function success<T>(value: T): OperationResult<T> {
  return { ok: true, value };
}

function failure<T>(error: ContractError): OperationResult<T> {
  return { ok: false, error };
}

function validation<T>(message: string): OperationResult<T> {
  return failure({ code: "validation", retryable: false, message });
}

function conflict<T>(message: string, expected?: number, actual?: number): OperationResult<T> {
  return failure({
    code: "conflict",
    retryable: true,
    message,
    ...(expected === undefined || actual === undefined ? {} : { version: { expected, actual } })
  });
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attemptKey(taskId: string, generation: number, attemptId: string | undefined): string {
  return JSON.stringify([taskId, generation, attemptId]);
}

function cloneAggregate(aggregate: WorkflowAggregate): WorkflowAggregate {
  return {
    definition: aggregate.definition,
    snapshot: structuredClone(aggregate.snapshot),
    approvalsById: new Map(
      [...aggregate.approvalsById].map(([key, value]) => [key, structuredClone(value)] as const)
    ),
    approvalDecisions: new Map(
      [...aggregate.approvalDecisions].map(([key, value]) => [key, structuredClone(value)] as const)
    ),
    gateRequests: new Map(
      [...aggregate.gateRequests].map(([key, value]) => [key, structuredClone(value)] as const)
    ),
    gateOutcomes: structuredClone(aggregate.gateOutcomes),
    successfulAttempts: new Map([...aggregate.successfulAttempts].map(([key, value]) => [key, structuredClone(value)] as const)),
    cancellations: new Map(
      [...aggregate.cancellations].map(([key, value]) => [key, structuredClone(value)] as const)
    ),
    retrySchedules: new Map([...aggregate.retrySchedules].map(([key, value]) => [key, structuredClone(value)] as const)),
    attemptBaselines: new Map([...aggregate.attemptBaselines].map(([key, value]) => [key, structuredClone(value)] as const)),
    commands: new Map(
      [...aggregate.commands].map(([key, value]) => [key, structuredClone(value)] as const)
    ),
    pendingCommandEvents: structuredClone(aggregate.pendingCommandEvents)
  };
}

function schedulingContext(aggregate: WorkflowAggregate): SchedulingContext {
  return { approvals: aggregate.approvalDecisions, gates: aggregate.gateOutcomes };
}

function taskState(aggregate: WorkflowAggregate, taskId: string): TaskState | undefined {
  return aggregate.snapshot.tasks.find((task) => task.taskId === taskId);
}

function taskDefinition(aggregate: WorkflowAggregate, taskId: string) {
  return aggregate.definition.tasks.find((task) => task.id === taskId);
}

function taskHasSuccessfulResult(aggregate: WorkflowAggregate, task: TaskState): boolean {
  return aggregate.successfulAttempts.has(attemptKey(task.taskId, task.generation, task.attemptId));
}

function generationAttempts(aggregate: WorkflowAggregate, task: TaskState): number {
  const baseline = aggregate.attemptBaselines.get(task.taskId);
  return task.attempt - (baseline?.generation === task.generation ? baseline.baseline : 0);
}

function retryDelayMs(
  policy: WorkflowDefinition["tasks"][number]["retry"],
  attemptInGeneration: number,
  identity: { runId: string; taskId: string; generation: number; attempt: number }
): number {
  const scaled = policy.strategy === "fixed" ? policy.initialDelayMs
    : policy.strategy === "linear" ? policy.initialDelayMs * attemptInGeneration
      : policy.initialDelayMs * (policy.multiplier ?? 2) ** (attemptInGeneration - 1);
  const capped = Math.min(policy.maxDelayMs, scaled);
  if (!policy.jitter) return Math.floor(capped);
  const digest = fingerprintWorkflowCommand("advance", identity);
  return Math.floor(capped * (parseInt(digest.slice(0, 8), 16) / 0xffffffff));
}

export class DeterministicWorkflowEngine implements WorkflowEngine {
  readonly #runs = new Map<string, WorkflowAggregate>();
  readonly #definitions = new Map<string, WorkflowDefinition>();
  readonly #resolveDefinition?: DeterministicWorkflowEngineOptions["resolveDefinition"];
  readonly #now: () => string;

  constructor(options: DeterministicWorkflowEngineOptions = {}) {
    this.#resolveDefinition = options.resolveDefinition;
    this.#now = options.now ?? (() => new Date().toISOString());
    for (const candidate of options.definitions ?? []) {
      const parsed = WorkflowDefinitionSchema.safeParse(candidate);
      if (!parsed.success) throw new Error(`Invalid injected workflow definition: ${parsed.error.message}`);
      this.#definitions.set(this.#definitionKey(parsed.data.id, parsed.data.version), parsed.data);
    }
  }

  async validateDefinition(definition: WorkflowDefinition): Promise<OperationResult<void>> {
    const parsed = WorkflowDefinitionSchema.safeParse(definition);
    return parsed.success ? success(undefined) : validation(this.#issues("Invalid workflow definition", parsed.error.issues));
  }

  async createRun(command: Parameters<WorkflowEngine["createRun"]>[0], options?: OperationOptions) {
    const optionError = this.#checkOptions(options);
    if (optionError !== undefined) return failure<WorkflowAdvanceResult>(optionError);
    const parsed = CreateRunCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid create command", parsed.error.issues));
    const data = parsed.data;
    const commandFingerprint = fingerprintWorkflowCommand("createRun", data);
    const existing = this.#runs.get(data.runId);
    if (existing !== undefined) {
      const duplicate = this.#duplicate(existing, data.idempotencyKey, commandFingerprint);
      return duplicate ?? conflict(`Run already exists: ${data.runId}`);
    }

    const definition = data.definition;
    this.#definitions.set(this.#definitionKey(definition.id, definition.version), definition);
    const placeholder = WorkflowRunSnapshotSchema.parse({
      runId: data.runId,
      workflowId: definition.id,
      workflowVersion: definition.version,
      status: "queued",
      ...(data.input === undefined ? {} : { input: data.input }),
      tasks: definition.tasks.map((task) => ({
        taskId: task.id,
        status: "pending",
        attempt: 0,
        generation: 0,
        version: 0
      })),
      createdAt: data.createdAt,
      updatedAt: data.createdAt,
      version: 0,
      lastEventSequence: 0,
      ...(data.metadata === undefined ? {} : { metadata: data.metadata })
    });
    const aggregate: WorkflowAggregate = {
      definition,
      snapshot: placeholder,
      approvalsById: new Map(),
      approvalDecisions: new Map(),
      gateRequests: new Map(),
      gateOutcomes: [],
      successfulAttempts: new Map(),
      cancellations: new Map(),
      retrySchedules: new Map(),
      attemptBaselines: new Map(),
      commands: new Map(),
      pendingCommandEvents: []
    };
    const emitted: DomainEvent[] = [];
    const eventResult = this.#emit(aggregate, emitted, {
      type: "run.created",
      occurredAt: data.createdAt,
      commandKey: data.idempotencyKey,
      payload: {
        workflowId: definition.id,
        workflowVersion: definition.version,
        ...(data.input === undefined ? {} : { input: data.input })
      },
      ...(data.metadata === undefined ? {} : { metadata: data.metadata })
    });
    if (!eventResult.ok) return eventResult;
    const completed = this.#finishCommand(aggregate, emitted, "createRun", data.idempotencyKey,
      commandFingerprint, [], data.createdAt);
    if (!completed.ok) return completed;
    const batchIssues = validateEventBatch({ runId: data.runId, expectedVersion: 0,
      expectedLastSequence: 0, events: emitted });
    if (batchIssues.length > 0) return failure<WorkflowAdvanceResult>({ code: "corruption", retryable: false,
      message: `Generated event batch is invalid: ${batchIssues.map((issue) => issue.message).join("; ")}` });
    const result = this.#result(aggregate, [], emitted);
    this.#runs.set(data.runId, aggregate);
    return success(structuredClone(result));
  }

  async advance(command: Parameters<WorkflowEngine["advance"]>[0], options?: OperationOptions) {
    const parsed = AdvanceRunCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid advance command", parsed.error.issues));
    return this.#mutate(
      "advance",
      parsed.data.runId,
      parsed.data.idempotencyKey,
      parsed.data.expectedVersion,
      parsed.data,
      options,
      (aggregate, emitted) => {
        for (const task of aggregate.snapshot.tasks) {
          if (task.status !== "retrying") continue;
          const schedule = aggregate.retrySchedules.get(task.taskId);
          if (schedule === undefined) return validation(`Task ${task.taskId} has no durable retry schedule`);
          if (Date.parse(parsed.data.occurredAt) >= Date.parse(schedule.eligibleAt)) {
            const ready = this.#transitionTask(aggregate, emitted, task.taskId, "ready", "normal",
              parsed.data.occurredAt, parsed.data.idempotencyKey, "retry eligibility reached");
            if (!ready.ok) return ready;
          }
        }
        const index = buildDependencyIndex(aggregate.definition);
        for (const definition of aggregate.definition.tasks) {
          const task = taskState(aggregate, definition.id);
          if (task?.status !== "pending") continue;
          if (dependenciesSatisfied(aggregate.definition, aggregate.snapshot, task.taskId, schedulingContext(aggregate), index)) {
            const transitioned = this.#transitionTask(aggregate, emitted, task.taskId, "ready", "normal", parsed.data.occurredAt,
              parsed.data.idempotencyKey, "dependencies satisfied");
            if (!transitioned.ok) return transitioned;
          } else if (dependencyPermanentlyUnsatisfied(
            aggregate.definition,
            aggregate.snapshot,
            task.taskId,
            schedulingContext(aggregate),
            index
          )) {
            const transitioned = this.#transitionTask(aggregate, emitted, task.taskId, "cancelled", "normal",
              parsed.data.occurredAt, parsed.data.idempotencyKey, "required dependency did not succeed");
            if (!transitioned.ok) return transitioned;
          }
        }

        if (aggregate.definition.failurePolicy === "fail-fast" && aggregate.snapshot.tasks.some((task) => task.status === "failed")) {
          for (const task of aggregate.snapshot.tasks) {
            if (["pending", "ready", "retrying"].includes(task.status)) {
              const transitioned = this.#transitionTask(aggregate, emitted, task.taskId, "cancelled", "cancel",
                parsed.data.occurredAt, parsed.data.idempotencyKey, "fail-fast policy");
              if (!transitioned.ok) return transitioned;
            }
          }
        }

        const runnable = selectRunnableTasks(aggregate.definition, aggregate.snapshot, schedulingContext(aggregate));
        for (const taskId of runnable) {
          const transitioned = this.#transitionTask(aggregate, emitted, taskId, "running", "normal",
            parsed.data.occurredAt, parsed.data.idempotencyKey, "scheduled within workflow concurrency limit");
          if (!transitioned.ok) return transitioned;
        }
        const recomputed = this.#recomputeRunStatus(aggregate, emitted, parsed.data.occurredAt, parsed.data.idempotencyKey);
        return recomputed.ok ? success(runnable) : recomputed;
      }
    );
  }

  async transitionTask(command: Parameters<WorkflowEngine["transitionTask"]>[0], options?: OperationOptions) {
    const parsed = TaskTransitionCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid task transition command", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("transitionTask", data.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        const current = taskState(aggregate, data.taskId);
        if (current === undefined) return validation(`Unknown task: ${data.taskId}`);
        if (current.status !== data.from || current.generation !== data.generationFrom) {
          return conflict(`Task ${data.taskId} state or generation changed`);
        }
        if (["succeeded", "failed", "cancelled"].includes(aggregate.snapshot.status)) {
          return conflict("A terminal workflow cannot be reopened by a task transition");
        }
        if (data.intent === "retry") {
          return validation("Retry creation requires a verified failed AgentResult and is not an administrative transition");
        }
        if (data.intent === "rework") {
          const policy = taskDefinition(aggregate, data.taskId)?.rework ?? { maxReworks: 0, onExhausted: "fail" };
          if (current.generation >= policy.maxReworks ||
              aggregate.approvalDecisions.get(approvalKey(current.taskId, current.generation))?.decision !== "changes_requested") {
            return validation("Rework requires an approved changes-requested decision within policy");
          }
          if (!dependenciesSatisfied(aggregate.definition, aggregate.snapshot, data.taskId, schedulingContext(aggregate))) {
            return validation("Rework dependencies are no longer satisfied");
          }
        }
        if (data.to === "ready" && data.intent !== "rework" &&
            !dependenciesSatisfied(aggregate.definition, aggregate.snapshot, data.taskId, schedulingContext(aggregate))) {
          return validation(`Dependencies are not satisfied for task ${data.taskId}`);
        }
        if (data.from === "blocked" && data.to === "ready" &&
            (current.attempt > 0 || current.agentExecution !== undefined)) {
          return validation("An attempted task cannot be redispatched by clearing its blockage");
        }
        if (data.to === "running") {
          if (!dependenciesSatisfied(aggregate.definition, aggregate.snapshot, data.taskId, schedulingContext(aggregate)) ||
              !requiredGatesSatisfied(aggregate.definition, current, aggregate.gateOutcomes, ["before_dispatch"]) ||
              data.from === "ready" && !selectRunnableTasks(aggregate.definition, aggregate.snapshot,
                schedulingContext(aggregate)).includes(data.taskId) ||
              data.from !== "ready" && (current.agentExecution === undefined ||
                current.blockage?.code === "quality_gate" && !requiredGatesSatisfied(aggregate.definition, current,
                  aggregate.gateOutcomes, ["after_result", "before_completion"]))) {
            return validation(`Task ${data.taskId} is not runnable within dependency, gate, or concurrency policy`);
          }
        }
        if (data.to === "ready" && data.from === "retrying") {
          const schedule = aggregate.retrySchedules.get(data.taskId);
          if (schedule === undefined || Date.parse(data.occurredAt) < Date.parse(schedule.eligibleAt)) {
            return validation(`Retry is not yet eligible for task ${data.taskId}`);
          }
        }
        if (data.to === "cancelled" && current.agentExecution !== undefined &&
            ["running", "waiting", "blocked", "cancelling"].includes(current.status) &&
            ![...aggregate.cancellations.values()].some((record) => record.request.taskId === current.taskId &&
              record.confirmations.some((confirmation) => confirmation.terminalStatus === "cancelled" &&
                confirmation.executionId === current.agentExecution?.executionId))) {
          return validation("Cancellation of a bound execution requires confirmed stop");
        }
        if (data.to === "succeeded" &&
            (!taskHasSuccessfulResult(aggregate, current) ||
              !requiredGatesSatisfied(aggregate.definition, current, aggregate.gateOutcomes,
                ["after_result", "before_completion"]))) {
          return validation(`Task ${data.taskId} requires a verified successful result and required quality gates`);
        }
        const transitioned = this.#transitionTask(aggregate, emitted, data.taskId, data.to, data.intent,
          data.occurredAt, data.idempotencyKey, data.reason, data.generationTo);
        if (!transitioned.ok) return transitioned;
        const recomputed = this.#recomputeRunStatus(aggregate, emitted, data.occurredAt, data.idempotencyKey);
        return recomputed.ok ? success([]) : recomputed;
      });
  }

  async bindAgentExecution(command: Parameters<WorkflowEngine["bindAgentExecution"]>[0], options?: OperationOptions) {
    const parsed = BindAgentExecutionCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid execution binding command", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("bindAgentExecution", data.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        const task = taskState(aggregate, data.taskId);
        if (task === undefined) return validation(`Unknown task: ${data.taskId}`);
        if (!["running", "waiting", "blocked", "cancelling"].includes(task.status)) {
          return validation(`Task ${data.taskId} cannot bind an execution while ${task.status}`);
        }
        if (task.attempt !== data.attempt || task.attemptId !== data.handle.attemptId) {
          return conflict(`Execution handle does not match current attempt for task ${data.taskId}`);
        }
        if (task.agentExecution !== undefined &&
            JSON.stringify(stableValue(task.agentExecution)) !== JSON.stringify(stableValue(data.handle))) {
          return conflict(`Task ${data.taskId} already has a different execution`);
        }
        if (task.agentExecution !== undefined) return success([]);
        const event = this.#emit(aggregate, emitted, {
          type: "agent.execution_bound", taskId: data.taskId, occurredAt: data.occurredAt,
          commandKey: data.idempotencyKey, payload: { handle: data.handle, attempt: data.attempt }
        });
        return event.ok ? success([]) : event;
      });
  }

  async recordDeliveryReconciliation(
    command: Parameters<WorkflowEngine["recordDeliveryReconciliation"]>[0],
    options?: OperationOptions
  ) {
    const parsed = RecordDeliveryReconciliationCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid reconciliation command", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("recordDeliveryReconciliation", data.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        const task = taskState(aggregate, data.taskId);
        if (task === undefined) return validation(`Unknown task: ${data.taskId}`);
        if (data.result.status === "bound" &&
            (data.result.handle.runId !== data.runId || data.result.handle.taskId !== data.taskId ||
              task.attemptId !== data.result.handle.attemptId)) {
          return conflict(`Reconciled execution ownership or attempt does not match task ${data.taskId}`);
        }
        if (!["running", "waiting", "blocked", "cancelling"].includes(task.status) || task.attemptId === undefined) {
          return conflict("Reconciliation is stale for the current attempt");
        }
        if (data.result.status === "bound") {
          if (task.agentExecution !== undefined) {
            return JSON.stringify(stableValue(task.agentExecution)) === JSON.stringify(stableValue(data.result.handle))
              ? success([]) : conflict("Reconciliation conflicts with the bound execution");
          }
        } else if (task.agentExecution !== undefined) {
          return conflict("Delivery cannot be uncertain or absent after execution binding");
        }
        const recorded = this.#emit(aggregate, emitted, {
          type: "agent.delivery_reconciled", taskId: data.taskId, occurredAt: data.occurredAt,
          commandKey: data.idempotencyKey, payload: data.result
        });
        if (!recorded.ok) return recorded;
        if (data.result.status === "unknown_delivery" && ["running", "waiting"].includes(task.status)) {
          const blocked = this.#transitionTask(aggregate, emitted, data.taskId, "blocked", "normal", data.occurredAt,
            data.idempotencyKey, data.result.reason, undefined, {
              code: "manual_intervention", message: data.result.reason, since: data.occurredAt, retryable: false
            });
          return blocked.ok ? success([]) : blocked;
        }
        return success([]);
      });
  }

  async recordAgentResult(command: Parameters<WorkflowEngine["recordAgentResult"]>[0], options?: OperationOptions) {
    const parsed = RecordAgentResultCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid agent result command", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("recordAgentResult", data.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        let task = taskState(aggregate, data.taskId);
        if (task === undefined) return validation(`Unknown task: ${data.taskId}`);
        if (data.result.runId !== data.runId || data.result.taskId !== data.taskId) {
          return validation("Agent result ownership does not match command");
        }
        if (task.agentExecution === undefined || task.agentExecution.executionId !== data.result.executionId ||
            task.attemptId !== data.result.attemptId || task.agentExecution.requestId !== data.result.requestId) {
          return conflict(`Agent result does not match the bound execution for task ${data.taskId}`);
        }
        if (data.result.verification.status !== "verified" ||
            !data.result.verification.correlation.verified || !task.agentExecution.correlation.verified ||
            data.result.verification.correlation.token !== task.agentExecution.correlation.token ||
            data.result.verification.correlation.provenance !== task.agentExecution.correlation.provenance) {
          return validation("Agent result correlation is not verified for the bound execution");
        }
        if ([...aggregate.commands.values()].some((cached) => cached.result.emittedEvents.some((event) =>
          event.type === "agent.result_recorded" && event.payload.executionId === data.result.executionId &&
          event.payload.attemptId === data.result.attemptId))) {
          return conflict("An agent result was already recorded for this execution attempt");
        }
        if (["succeeded", "failed", "cancelled"].includes(task.status)) {
          return conflict(`Task ${data.taskId} is already terminal`);
        }
        const recorded = this.#emit(aggregate, emitted, {
          type: "agent.result_recorded", taskId: data.taskId, occurredAt: data.occurredAt,
          commandKey: data.idempotencyKey, payload: data.result
        });
        if (!recorded.ok) return recorded;

        if (task.status === "blocked" && data.result.status !== "blocked") {
          const resumed = this.#transitionTask(aggregate, emitted, data.taskId, "running", "normal", data.occurredAt,
            data.idempotencyKey, "verified result resumed blocked execution");
          if (!resumed.ok) return resumed;
          task = taskState(aggregate, data.taskId);
          if (task === undefined) return validation(`Unknown task: ${data.taskId}`);
        }

        if (data.result.status === "succeeded") {
          const needsGates = !requiredGatesSatisfied(aggregate.definition, task, aggregate.gateOutcomes,
            ["after_result", "before_completion"]);
          if (!(needsGates && task.status === "cancelling")) {
            const target = needsGates ? "waiting" : "succeeded";
            const transitioned = this.#transitionTask(aggregate, emitted, data.taskId, target, "normal", data.occurredAt,
              data.idempotencyKey, needsGates ? "awaiting required quality gates" : "verified agent result succeeded");
            if (!transitioned.ok) return transitioned;
          }
        } else if (data.result.status === "blocked") {
          const transitioned = this.#transitionTask(aggregate, emitted, data.taskId, "blocked", "normal", data.occurredAt,
            data.idempotencyKey, data.result.blockage?.message, undefined, data.result.blockage);
          if (!transitioned.ok) return transitioned;
        } else if (data.result.status === "cancelled") {
          if (task.status !== "cancelling") {
            const cancelling = this.#transitionTask(aggregate, emitted, data.taskId, "cancelling", "cancel", data.occurredAt,
              data.idempotencyKey, "verified agent cancellation");
            if (!cancelling.ok) return cancelling;
          }
          const cancelled = this.#transitionTask(aggregate, emitted, data.taskId, "cancelled", "cancel", data.occurredAt,
            data.idempotencyKey, "verified agent cancellation");
          if (!cancelled.ok) return cancelled;
        } else {
          const definition = taskDefinition(aggregate, data.taskId);
          if (data.result.status === "timed_out" && definition?.timeout.onTimeout === "block") {
            const blocked = this.#transitionTask(aggregate, emitted, data.taskId, "blocked", "normal", data.occurredAt,
              data.idempotencyKey, "execution timeout requires intervention", undefined, {
                code: "manual_intervention", message: "Execution timed out", since: data.occurredAt, retryable: false
              });
            if (!blocked.ok) return blocked;
            const recomputed = this.#recomputeRunStatus(aggregate, emitted, data.occurredAt, data.idempotencyKey);
            return recomputed.ok ? success([]) : recomputed;
          }
          const failed = this.#transitionTask(aggregate, emitted, data.taskId, "failed", "normal", data.occurredAt,
            data.idempotencyKey, data.result.error?.message ?? "verified agent result failed");
          if (!failed.ok) return failed;
          const retryAllowed = data.result.retryable && task.status !== "cancelling" && definition !== undefined &&
            generationAttempts(aggregate, task) < definition.retry.maxAttempts &&
            (definition.retry.retryableErrorCodes === undefined ||
              data.result.error !== undefined && definition.retry.retryableErrorCodes.includes(data.result.error.code)) &&
            (data.result.status !== "timed_out" || definition.timeout.onTimeout === "retry");
          if (retryAllowed && definition !== undefined && task.attemptId !== undefined) {
            const retrying = this.#transitionTask(aggregate, emitted, data.taskId, "retrying", "retry", data.occurredAt,
              data.idempotencyKey, "retryable verified result");
            if (!retrying.ok) return retrying;
            const delay = retryDelayMs(definition.retry, generationAttempts(aggregate, task), {
              runId: data.runId, taskId: data.taskId, generation: task.generation, attempt: task.attempt
            });
            const eligibleAt = new Date(Date.parse(data.occurredAt) + delay).toISOString();
            const scheduled = this.#emit(aggregate, emitted, {
              type: "task.retry_scheduled", taskId: data.taskId, occurredAt: data.occurredAt,
              commandKey: data.idempotencyKey,
              payload: { generation: task.generation, attempt: task.attempt, attemptId: task.attemptId, eligibleAt }
            });
            if (!scheduled.ok) return scheduled;
            if (delay === 0) {
              const ready = this.#transitionTask(aggregate, emitted, data.taskId, "ready", "normal", data.occurredAt,
                data.idempotencyKey, "retry eligible immediately");
              if (!ready.ok) return ready;
            }
          }
        }
        const recomputed = this.#recomputeRunStatus(aggregate, emitted, data.occurredAt, data.idempotencyKey);
        return recomputed.ok ? success([]) : recomputed;
      });
  }

  async requestApproval(command: Parameters<WorkflowEngine["requestApproval"]>[0], options?: OperationOptions) {
    const parsed = RequestApprovalCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid approval request command", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("requestApproval", data.request.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        if (aggregate.approvalsById.has(data.request.approvalId)) return conflict(`Approval already exists: ${data.request.approvalId}`);
        if (data.request.target.type === "task") {
          const task = taskState(aggregate, data.request.target.taskId);
          if (task === undefined) return validation(`Unknown approval task: ${data.request.target.taskId}`);
          if (task.generation !== data.request.generation) return conflict("Approval generation is stale");
          if (task.status !== "succeeded") return validation("Task approval can only be requested for a succeeded task");
        }
        if ([...aggregate.approvalsById.values()].some((record) =>
          JSON.stringify(record.request.target) === JSON.stringify(data.request.target) &&
          record.request.revision === data.request.revision &&
          record.request.generation === data.request.generation)) {
          return conflict("Approval target, revision, and generation already have a request");
        }
        const event = this.#emit(aggregate, emitted, {
          type: "approval.requested", occurredAt: data.request.requestedAt, commandKey: data.idempotencyKey,
          payload: data.request,
          ...(data.request.target.type === "task" ? { taskId: data.request.target.taskId } : {})
        });
        if (!event.ok) return event;
        const recomputed = this.#recomputeRunStatus(aggregate, emitted, data.request.requestedAt, data.idempotencyKey);
        return recomputed.ok ? success([]) : recomputed;
      });
  }

  async applyApproval(command: Parameters<WorkflowEngine["applyApproval"]>[0], options?: OperationOptions) {
    const parsed = ApplyApprovalCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid approval decision command", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("applyApproval", data.decision.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        const record = aggregate.approvalsById.get(data.decision.approvalId);
        if (record === undefined) return validation(`Unknown approval: ${data.decision.approvalId}`);
        if (record.decision !== undefined) return conflict(`Approval already decided: ${data.decision.approvalId}`);
        if (JSON.stringify(record.request.target) !== JSON.stringify(data.decision.target) ||
            record.request.revision !== data.decision.revision || record.request.generation !== data.decision.generation) {
          return conflict("Approval decision target, revision, or generation is stale");
        }
        if (data.decision.target.type === "task" &&
            taskState(aggregate, data.decision.target.taskId)?.generation !== data.decision.generation) {
          return conflict("Approval decision belongs to a prior task generation");
        }
        const event = this.#emit(aggregate, emitted, {
          type: "approval.decided", occurredAt: data.decision.decidedAt, commandKey: data.idempotencyKey,
          payload: data.decision,
          ...(data.decision.target.type === "task" ? { taskId: data.decision.target.taskId } : {})
        });
        if (!event.ok) return event;
        if (data.decision.decision === "changes_requested" && data.decision.target.type === "task") {
          const task = taskState(aggregate, data.decision.target.taskId);
          if (task === undefined || task.generation !== data.decision.generation || task.status !== "succeeded") {
            return conflict("Rework decision is stale for the target task");
          }
          const policy = taskDefinition(aggregate, task.taskId)?.rework ?? { maxReworks: 0, onExhausted: "fail" };
          if (task.generation < policy.maxReworks) {
            const reworked = this.#transitionTask(aggregate, emitted, task.taskId, "ready", "rework",
              data.decision.decidedAt, data.idempotencyKey, data.decision.reason, task.generation + 1);
            if (!reworked.ok) return reworked;
          }
        }
        const recomputed = this.#recomputeRunStatus(aggregate, emitted, data.decision.decidedAt, data.idempotencyKey);
        return recomputed.ok ? success([]) : recomputed;
      });
  }

  async requestQualityGateEvaluation(
    command: Parameters<WorkflowEngine["requestQualityGateEvaluation"]>[0],
    options?: OperationOptions
  ) {
    const parsed = EvaluateQualityGateCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid quality gate request", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("requestQualityGateEvaluation", data.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        if (aggregate.gateRequests.has(data.evaluationId)) return conflict(`Evaluation already exists: ${data.evaluationId}`);
        if (!aggregate.definition.qualityGates.some((gate) => gate.id === data.gateId)) {
          return validation(`Unknown quality gate: ${data.gateId}`);
        }
        let phase: QualityGateBinding["phase"] = "before_completion";
        let generation = 0;
        if (data.taskId !== undefined) {
          const task = taskState(aggregate, data.taskId);
          const definition = taskDefinition(aggregate, data.taskId);
          if (task === undefined || definition === undefined) return validation(`Unknown task: ${data.taskId}`);
          if (data.attemptId !== undefined && data.attemptId !== task.attemptId) return conflict("Gate request attempt is stale");
          const candidate = this.#inferGatePhase(aggregate, task, data.gateId);
          if (candidate === undefined || !definition.qualityGates.some((binding) => binding.gateId === data.gateId)) {
            return validation(`Gate ${data.gateId} is not bound to task ${data.taskId}`);
          }
          if (candidate !== "before_dispatch" && (data.attemptId === undefined || task.attemptId === undefined)) {
            return validation("A task-scoped result gate requires the current attemptId");
          }
          if (candidate !== "before_dispatch" && !["running", "waiting", "blocked", "cancelling", "succeeded"].includes(task.status)) {
            return validation("A result gate cannot be requested for an inactive attempt");
          }
          phase = candidate;
          generation = task.generation;
        }
        if ([...aggregate.gateRequests.values()].some((request) =>
          request.taskId === data.taskId && request.gateId === data.gateId && request.phase === phase &&
          request.generation === generation && request.attemptId === data.attemptId)) {
          return conflict("Quality gate phase already has an evaluation request for this attempt");
        }
        const event = this.#emit(aggregate, emitted, {
          type: "quality_gate.evaluation_requested", occurredAt: data.occurredAt, commandKey: data.idempotencyKey,
          ...(data.taskId === undefined ? {} : { taskId: data.taskId }),
          payload: {
            evaluationId: data.evaluationId,
            gateId: data.gateId,
            ...(data.attemptId === undefined ? {} : { attemptId: data.attemptId })
          }
        });
        if (!event.ok) return event;
        aggregate.gateRequests.set(data.evaluationId, {
          evaluationId: data.evaluationId,
          gateId: data.gateId,
          ...(data.taskId === undefined ? {} : { taskId: data.taskId }),
          ...(data.attemptId === undefined ? {} : { attemptId: data.attemptId }),
          generation,
          phase
        });
        return success([]);
      });
  }

  async recordQualityGateResult(
    command: Parameters<WorkflowEngine["recordQualityGateResult"]>[0],
    options?: OperationOptions
  ) {
    const parsed = RecordQualityGateResultCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid quality gate result", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("recordQualityGateResult", data.result.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        const request = aggregate.gateRequests.get(data.result.evaluationId);
        if (request === undefined) return validation(`Unknown quality evaluation: ${data.result.evaluationId}`);
        if (request.gateId !== data.result.gateId || request.taskId !== data.result.taskId) {
          return conflict("Quality gate result does not match its request");
        }
        if (aggregate.gateOutcomes.some((outcome) => outcome.taskId === request.taskId &&
            outcome.gateId === request.gateId && outcome.phase === request.phase &&
            outcome.generation === request.generation && outcome.attemptId === request.attemptId)) {
          return conflict("Quality gate phase already has a result for this attempt");
        }
        const event = this.#emit(aggregate, emitted, {
          type: "quality_gate.evaluated", occurredAt: data.result.evaluatedAt, commandKey: data.idempotencyKey,
          ...(data.result.taskId === undefined ? {} : { taskId: data.result.taskId }), payload: data.result
        });
        if (!event.ok) return event;
        if (request.taskId !== undefined) {
          let task = taskState(aggregate, request.taskId);
          const definition = taskDefinition(aggregate, request.taskId);
          const binding = definition?.qualityGates.find((candidate) =>
            candidate.gateId === request.gateId && candidate.phase === request.phase);
          if (task === undefined || definition === undefined || binding === undefined) {
            return validation("Quality gate task binding disappeared");
          }
          if (task.generation !== request.generation || task.attemptId !== request.attemptId) {
            const recomputed = this.#recomputeRunStatus(aggregate, emitted, data.result.evaluatedAt, data.idempotencyKey);
            return recomputed.ok ? success([]) : recomputed;
          }
          if (binding.required && data.result.status !== "passed" && ["running", "waiting"].includes(task.status)) {
            const blocked = this.#transitionTask(aggregate, emitted, task.taskId, "blocked", "normal", data.result.evaluatedAt,
              data.idempotencyKey, `required quality gate ${request.gateId} ${data.result.status}`, undefined, {
                code: "quality_gate", message: `Quality gate ${request.gateId} ${data.result.status}`,
                since: data.result.evaluatedAt, retryable: data.result.status !== "failed"
              });
            if (!blocked.ok) return blocked;
          } else if (data.result.status === "passed" && taskHasSuccessfulResult(aggregate, task) &&
              requiredGatesSatisfied(aggregate.definition, task, aggregate.gateOutcomes, ["after_result", "before_completion"])) {
            if (task.status === "blocked") {
              const resumed = this.#transitionTask(aggregate, emitted, task.taskId, "running", "normal",
                data.result.evaluatedAt, data.idempotencyKey, "required quality gates recovered");
              if (!resumed.ok) return resumed;
              task = taskState(aggregate, task.taskId) ?? task;
            }
            if (task.status === "waiting" || task.status === "running" || task.status === "cancelling") {
              const completed = this.#transitionTask(aggregate, emitted, task.taskId, "succeeded", "normal",
                data.result.evaluatedAt, data.idempotencyKey, "all required quality gates passed");
              if (!completed.ok) return completed;
            }
          }
        }
        const recomputed = this.#recomputeRunStatus(aggregate, emitted, data.result.evaluatedAt, data.idempotencyKey);
        return recomputed.ok ? success([]) : recomputed;
      });
  }

  async requestCancellation(request: CancellationRequest, options?: OperationOptions) {
    const parsed = CancellationRequestSchema.safeParse(request);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid cancellation request", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("requestCancellation", data.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        if (aggregate.cancellations.has(data.cancellationId)) return conflict(`Cancellation already exists: ${data.cancellationId}`);
        if (data.taskId !== undefined && taskState(aggregate, data.taskId) === undefined) return validation(`Unknown task: ${data.taskId}`);
        if (data.taskId !== undefined) {
          const target = taskState(aggregate, data.taskId)!;
          if (["succeeded", "failed", "cancelled"].includes(target.status)) {
            return conflict("Cannot request cancellation of a terminal task");
          }
          if (data.executionId !== undefined && target.agentExecution?.executionId !== data.executionId) {
            return conflict("Cancellation execution does not belong to the target task");
          }
          if (target.agentExecution !== undefined && data.executionId !== target.agentExecution.executionId) {
            return validation("A bound task cancellation requires its execution identity");
          }
        } else if (data.executionId !== undefined) {
          return validation("A run-wide cancellation request cannot name a single execution");
        }
        const event = this.#emit(aggregate, emitted, {
          type: "cancellation.requested", occurredAt: data.requestedAt, commandKey: data.idempotencyKey,
          ...(data.taskId === undefined ? {} : { taskId: data.taskId }), payload: data
        });
        if (!event.ok) return event;
        const targets = data.taskId === undefined ? aggregate.snapshot.tasks :
          aggregate.snapshot.tasks.filter((task) => task.taskId === data.taskId);
        for (const task of targets) {
          if (["succeeded", "failed", "cancelled"].includes(task.status)) continue;
          const target = task.status === "pending" || task.status === "retrying" ? "cancelled" : "cancelling";
          const transitioned = this.#transitionTask(aggregate, emitted, task.taskId, target, "cancel", data.requestedAt,
            data.idempotencyKey, data.reason ?? "cancellation requested");
          if (!transitioned.ok) return transitioned;
        }
        if (data.taskId === undefined && !["succeeded", "failed", "cancelled", "cancelling"].includes(aggregate.snapshot.status)) {
          const moved = this.#moveRun(aggregate, emitted, "cancelling", data.requestedAt, data.idempotencyKey,
            data.reason ?? "cancellation requested");
          if (!moved.ok) return moved;
        }
        return success([]);
      });
  }

  async recordCancellationResult(
    command: Parameters<WorkflowEngine["recordCancellationResult"]>[0],
    options?: OperationOptions
  ) {
    const parsed = RecordCancellationResultCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid cancellation result", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("recordCancellationResult", data.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        const record = aggregate.cancellations.get(data.result.cancellationId);
        if (record === undefined) return validation(`Unknown cancellation: ${data.result.cancellationId}`);
        if (record.result !== undefined) return conflict("Cancellation result already recorded");
        const request = record.request;
        if (data.result.status === "accepted" &&
            (request.executionId !== undefined && data.result.executionId !== request.executionId ||
              request.taskId !== undefined && data.result.executionId !== undefined &&
                taskState(aggregate, request.taskId)?.agentExecution?.executionId !== data.result.executionId)) {
          return conflict("Cancellation result execution does not match the requested task");
        }
        const event = this.#emit(aggregate, emitted, {
          type: data.result.status === "accepted" ? "cancellation.accepted" : "cancellation.refused",
          occurredAt: data.result.observedAt,
          commandKey: data.idempotencyKey,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
          payload: data.result
        });
        return event.ok ? success([]) : event;
      });
  }

  async confirmCancellationStop(
    command: Parameters<WorkflowEngine["confirmCancellationStop"]>[0],
    options?: OperationOptions
  ) {
    const parsed = ConfirmCancellationStopCommandSchema.safeParse(command);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid cancellation confirmation", parsed.error.issues));
    const data = parsed.data;
    return this.#mutate("confirmCancellationStop", data.runId, data.idempotencyKey, data.expectedVersion, data, options,
      (aggregate, emitted) => {
        const record = aggregate.cancellations.get(data.confirmation.cancellationId);
        if (record === undefined) return validation(`Unknown cancellation: ${data.confirmation.cancellationId}`);
        if (record.confirmations.some((confirmation) =>
          confirmation.executionId === data.confirmation.executionId)) {
          return conflict("Cancellation stop already confirmed for this execution");
        }
        const request = record.request;
        if (request.executionId !== undefined && data.confirmation.executionId !== request.executionId) {
          return conflict("Stop confirmation execution differs from cancellation request");
        }
        if (request.taskId !== undefined) {
          const target = taskState(aggregate, request.taskId);
          if (target === undefined || target.agentExecution !== undefined &&
              target.agentExecution.executionId !== data.confirmation.executionId ||
              data.confirmation.executionId !== undefined &&
                target.agentExecution?.executionId !== data.confirmation.executionId) {
            return conflict("Stop confirmation execution does not belong to the target task");
          }
        } else if (data.confirmation.executionId !== undefined && !aggregate.snapshot.tasks.some((task) =>
          task.agentExecution?.executionId === data.confirmation.executionId)) {
          return conflict("Stop confirmation execution is not bound to this run");
        } else if (data.confirmation.executionId === undefined && aggregate.snapshot.tasks.some((task) =>
          task.status === "cancelling" && task.agentExecution !== undefined)) {
          return conflict("Run-wide stop cannot be confirmed without each bound execution identity");
        }
        const event = this.#emit(aggregate, emitted, {
          type: "cancellation.stop_confirmed", occurredAt: data.confirmation.stoppedAt, commandKey: data.idempotencyKey,
          ...(request.taskId === undefined ? {} : { taskId: request.taskId }), payload: data.confirmation
        });
        if (!event.ok) return event;
        const targets = request.taskId !== undefined
          ? aggregate.snapshot.tasks.filter((task) => task.taskId === request.taskId)
          : data.confirmation.executionId === undefined
            ? aggregate.snapshot.tasks.filter((task) => task.agentExecution === undefined)
            : aggregate.snapshot.tasks.filter((task) =>
              task.agentExecution?.executionId === data.confirmation.executionId);
        for (const task of targets) {
          if (["succeeded", "failed", "cancelled"].includes(task.status)) continue;
          if (data.confirmation.terminalStatus !== "cancelled") continue;
          if (task.status !== "cancelling") {
            const cancelling = this.#transitionTask(aggregate, emitted, task.taskId, "cancelling", "cancel",
              data.confirmation.stoppedAt, data.idempotencyKey, "cancellation stop confirmed");
            if (!cancelling.ok) return cancelling;
          }
          const terminal = this.#transitionTask(aggregate, emitted, task.taskId, data.confirmation.terminalStatus,
            data.confirmation.terminalStatus === "cancelled" ? "cancel" : "normal", data.confirmation.stoppedAt,
            data.idempotencyKey, "cancellation stop confirmed");
          if (!terminal.ok) return terminal;
        }
        const recomputed = this.#recomputeRunStatus(aggregate, emitted, data.confirmation.stoppedAt, data.idempotencyKey);
        if (!recomputed.ok) return recomputed;
        return success([]);
      });
  }

  async recover(
    command: Parameters<WorkflowEngine["recover"]>[0],
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>> {
    const optionError = this.#checkOptions(options);
    if (optionError !== undefined) return failure<WorkflowAdvanceResult>(optionError);
    const raw: unknown = command;
    let recoveryCandidate: unknown = raw;
    if (isRecord(raw)) {
      const rawEvents = raw.events;
      const compatibleEvents: DomainEvent[] = [];
      if (Array.isArray(rawEvents)) {
        for (const rawEvent of rawEvents) {
          const compatible = parseDomainEventWithCompatibility(rawEvent);
          if (!compatible.ok) return failure(compatible.error);
          compatibleEvents.push(compatible.value);
        }
      }
      let compatibleCheckpoint: unknown = raw.checkpoint;
      if (raw.checkpoint !== undefined) {
        const compatible = parseRecoveryCheckpointWithCompatibility(raw.checkpoint);
        if (!compatible.ok) return failure(compatible.error);
        compatibleCheckpoint = compatible.value;
      }
      recoveryCandidate = {
        ...raw,
        ...(Array.isArray(rawEvents) ? { events: compatibleEvents } : {}),
        ...(raw.checkpoint === undefined ? {} : { checkpoint: compatibleCheckpoint })
      };
    }
    const parsed = RecoverRunCommandSchema.safeParse(recoveryCandidate);
    if (!parsed.success) return validation<WorkflowAdvanceResult>(this.#issues("Invalid recovery command", parsed.error.issues));
    const data = parsed.data;
    let snapshot: WorkflowRunSnapshot | undefined;
    let checkpointState: WorkflowAggregateCheckpointState | undefined;
    if (data.checkpoint !== undefined) {
      if (data.checkpoint.codec.name === "ai-flow.workflow-aggregate+json") {
        const decoded = decodeWorkflowAggregateCheckpointState(data.checkpoint);
        if (!decoded.ok) return failure(decoded.error);
        checkpointState = decoded.value;
        snapshot = decoded.value.snapshot;
      } else {
        const decoded = decodeWorkflowRunCheckpointState(data.checkpoint);
        if (!decoded.ok) return failure(decoded.error);
        snapshot = decoded.value;
      }
      if (snapshot.runId !== data.runId || data.checkpoint.runId !== data.runId ||
          snapshot.version !== data.checkpoint.version ||
          snapshot.lastEventSequence !== data.checkpoint.eventSequence) {
        return failure({ code: "corruption", retryable: false, message: "Checkpoint envelope and snapshot position disagree" });
      }
    }
    const fullHistory = data.events[0]?.type === "run.created" && data.events[0].sequence === 1;
    if (!fullHistory && checkpointState === undefined) {
      return validation("Recovery requires complete event history or a complete aggregate checkpoint");
    }
    const firstEvent = fullHistory ? data.events[0] : undefined;
    const workflowId = snapshot?.workflowId ?? (firstEvent?.type === "run.created" ? firstEvent.payload.workflowId : undefined);
    const workflowVersion = snapshot?.workflowVersion ??
      (firstEvent?.type === "run.created" ? firstEvent.payload.workflowVersion : undefined);
    if (workflowId === undefined || workflowVersion === undefined) {
      return validation("Recovery requires a checkpoint or run.created event to identify the workflow definition");
    }
    const definition = this.#definition(workflowId, workflowVersion);
    if (definition === undefined) {
      return validation(`Workflow definition ${workflowId}@${workflowVersion} is unavailable for recovery`);
    }
    if (snapshot !== undefined) {
      const expectedTasks = definition.tasks.map((task) => task.id).sort();
      const actualTasks = snapshot.tasks.map((task) => task.taskId).sort();
      if (JSON.stringify(expectedTasks) !== JSON.stringify(actualTasks)) {
        return failure({ code: "corruption", retryable: false, message: "Checkpoint tasks do not match workflow definition" });
      }
    }
    if (checkpointState !== undefined) {
      const receiptEvents = checkpointState.commands.flatMap((entry) => entry.result.emittedEvents);
      if (receiptEvents[0]?.type !== "run.created" || receiptEvents.at(-1)?.sequence !== snapshot?.lastEventSequence) {
        return failure({ code: "corruption", retryable: false,
          message: "Aggregate checkpoint does not contain complete durable command receipts" });
      }
      const verifier = new DeterministicWorkflowEngine({ definitions: [definition], now: this.#now });
      const checked = await verifier.recover({ runId: data.runId, events: receiptEvents,
        expectedVersion: snapshot!.version });
      if (!checked.ok) return failure({ code: "corruption", retryable: false,
        message: `Aggregate checkpoint receipts cannot be replayed: ${checked.error.message}` });
      const reconstructed = verifier.#runs.get(data.runId);
      if (reconstructed === undefined || JSON.stringify(stableValue(verifier.#checkpointState(reconstructed))) !==
          JSON.stringify(stableValue(checkpointState))) {
        return failure({ code: "corruption", retryable: false,
          message: "Aggregate checkpoint state disagrees with durable command receipts" });
      }
    }
    const aggregate: WorkflowAggregate = {
      definition,
      snapshot: !fullHistory && snapshot !== undefined ? snapshot : WorkflowRunSnapshotSchema.parse({
        runId: data.runId,
        workflowId,
        workflowVersion,
        status: "queued",
        tasks: definition.tasks.map((task) => ({ taskId: task.id, status: "pending", attempt: 0, generation: 0, version: 0 })),
        createdAt: firstEvent?.occurredAt ?? this.#now(),
        updatedAt: firstEvent?.occurredAt ?? this.#now(),
        version: 0,
        lastEventSequence: 0
      }),
      approvalsById: new Map(), approvalDecisions: new Map(), gateRequests: new Map(), gateOutcomes: [],
      successfulAttempts: new Map(), cancellations: new Map(), retrySchedules: new Map(),
      attemptBaselines: new Map(), commands: new Map(), pendingCommandEvents: []
    };
    if (!fullHistory && checkpointState !== undefined) this.#restoreCheckpointState(aggregate, checkpointState);
    let replaySnapshot = fullHistory ? undefined : snapshot;
    const replayEvents = fullHistory ? data.events : data.events.filter((event) => event.sequence > (snapshot?.lastEventSequence ?? 0));
    if (!fullHistory && data.events.some((event) => event.sequence <= (snapshot?.lastEventSequence ?? 0))) {
      return failure({ code: "corruption", retryable: false, message: "Checkpoint tail overlaps or precedes its cursor" });
    }
    const batchIssues = validateEventBatch({ runId: data.runId,
      expectedVersion: fullHistory ? 0 : snapshot?.version ?? 0,
      expectedLastSequence: fullHistory ? 0 : snapshot?.lastEventSequence ?? 0, events: replayEvents });
    if (batchIssues.length > 0) return failure({ code: "corruption", retryable: false,
      message: `Invalid recovery event batch: ${batchIssues.map((issue) => issue.message).join("; ")}` });
    const seenEventIds = new Set<string>();
    const seenKeys = new Set<string>();
    for (const event of replayEvents) {
      if (event.runId !== data.runId) return validation("Recovery event belongs to a different run");
      if (seenEventIds.has(event.eventId) || seenKeys.has(event.idempotencyKey) ||
          [...aggregate.commands.values()].some((cached) => cached.result.emittedEvents.some((prior) =>
            prior.eventId === event.eventId || prior.idempotencyKey === event.idempotencyKey))) {
        return failure({ code: "corruption", retryable: false, message: "Duplicate event identity during recovery" });
      }
      seenEventIds.add(event.eventId);
      seenKeys.add(event.idempotencyKey);
      try {
        const before = replaySnapshot;
        this.#validateReplayTransition(aggregate, event, before);
        replaySnapshot = reduceWorkflowEvent(replaySnapshot, event, definition);
        aggregate.snapshot = replaySnapshot;
        this.#replayAuxiliary(aggregate, event, before);
        if (fullHistory && checkpointState !== undefined && event.sequence === snapshot?.lastEventSequence &&
            JSON.stringify(stableValue(this.#checkpointState(aggregate))) !== JSON.stringify(stableValue(checkpointState))) {
          throw new Error("Checkpoint aggregate differs from complete event history");
        }
        if (fullHistory && checkpointState === undefined && snapshot !== undefined && event.sequence === snapshot.lastEventSequence &&
            JSON.stringify(stableValue(replaySnapshot)) !== JSON.stringify(stableValue(snapshot))) {
          throw new Error("Legacy checkpoint snapshot differs from complete event history");
        }
      } catch (error) {
        return failure({
          code: "corruption", retryable: false,
          message: error instanceof Error ? error.message : "Event replay failed"
        });
      }
    }
    if (replaySnapshot === undefined) return validation("Recovery event stream is empty");
    if (aggregate.pendingCommandEvents.length > 0) {
      return failure({ code: "corruption", retryable: false, message: "Recovery ended with an incomplete command receipt" });
    }
    if (snapshot !== undefined && fullHistory && snapshot.lastEventSequence > replaySnapshot.lastEventSequence) {
      return failure({ code: "corruption", retryable: false, message: "Complete history does not reach checkpoint cursor" });
    }
    if (replaySnapshot.version !== data.expectedVersion) {
      return conflict("Recovered aggregate version does not match expectedVersion", data.expectedVersion, replaySnapshot.version);
    }
    aggregate.snapshot = replaySnapshot;
    const existing = this.#runs.get(data.runId);
    if (existing !== undefined && existing.snapshot.version > replaySnapshot.version) {
      return conflict("Recovery cannot replace a newer in-memory aggregate");
    }
    this.#runs.set(data.runId, aggregate);
    return success(this.#result(aggregate, [], []));
  }

  async createCheckpoint(command: Parameters<WorkflowEngine["createCheckpoint"]>[0], options?: OperationOptions):
    Promise<OperationResult<RecoveryCheckpoint>> {
    const optionError = this.#checkOptions(options);
    if (optionError !== undefined) return failure<RecoveryCheckpoint>(optionError);
    const parsed = CreateCheckpointCommandSchema.safeParse(command);
    if (!parsed.success) return validation<RecoveryCheckpoint>(
      this.#issues("Invalid checkpoint command", parsed.error.issues));
    const aggregate = this.#runs.get(parsed.data.runId);
    if (aggregate === undefined) return failure<RecoveryCheckpoint>({
      code: "not_found", retryable: false, message: "Run not found" });
    if (aggregate.snapshot.version !== parsed.data.expectedVersion) {
      return conflict<RecoveryCheckpoint>(
        "Aggregate version mismatch", parsed.data.expectedVersion, aggregate.snapshot.version);
    }
    if (aggregate.pendingCommandEvents.length > 0) return validation<RecoveryCheckpoint>("Cannot checkpoint an incomplete command");
    const state = this.#checkpointState(aggregate);
    const checkpoint = RecoveryCheckpointSchema.safeParse({
      checkpointSchemaVersion: 1,
      codec: { name: "ai-flow.workflow-aggregate+json", version: 1 },
      checkpointId: parsed.data.checkpointId,
      runId: parsed.data.runId,
      eventSequence: aggregate.snapshot.lastEventSequence,
      version: aggregate.snapshot.version,
      state,
      createdAt: parsed.data.createdAt
    });
    return checkpoint.success ? success(checkpoint.data) :
      validation<RecoveryCheckpoint>(this.#issues("Invalid aggregate checkpoint", checkpoint.error.issues));
  }

  #checkpointState(aggregate: WorkflowAggregate): WorkflowAggregateCheckpointState {
    return WorkflowAggregateCheckpointStateSchema.parse({
      schemaVersion: 1,
      snapshot: aggregate.snapshot,
      approvals: [...aggregate.approvalsById.values()],
      gateRequests: [...aggregate.gateRequests.values()],
      gateOutcomes: aggregate.gateOutcomes,
      successfulAttempts: [...aggregate.successfulAttempts.values()],
      cancellations: [...aggregate.cancellations.values()],
      retrySchedules: [...aggregate.retrySchedules.values()],
      attemptBaselines: [...aggregate.attemptBaselines.values()],
      commands: [...aggregate.commands.values()]
    });
  }

  #restoreCheckpointState(aggregate: WorkflowAggregate, state: WorkflowAggregateCheckpointState): void {
    for (const record of state.approvals) {
      aggregate.approvalsById.set(record.request.approvalId, {
        request: record.request, ...(record.decision === undefined ? {} : { decision: record.decision })
      });
      if (record.decision?.target.type === "task") {
        aggregate.approvalDecisions.set(approvalKey(record.decision.target.taskId, record.decision.generation), record.decision);
      }
    }
    for (const request of state.gateRequests) aggregate.gateRequests.set(request.evaluationId, {
      evaluationId: request.evaluationId, gateId: request.gateId,
      generation: request.generation, phase: request.phase,
      ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
      ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId })
    });
    aggregate.gateOutcomes.push(...state.gateOutcomes.map((outcome) => ({
      gateId: outcome.gateId, generation: outcome.generation, phase: outcome.phase, status: outcome.status,
      ...(outcome.taskId === undefined ? {} : { taskId: outcome.taskId }),
      ...(outcome.attemptId === undefined ? {} : { attemptId: outcome.attemptId })
    })));
    for (const attempt of state.successfulAttempts) {
      aggregate.successfulAttempts.set(attemptKey(attempt.taskId, attempt.generation, attempt.attemptId), attempt);
    }
    for (const record of state.cancellations) aggregate.cancellations.set(record.request.cancellationId, {
      request: record.request, confirmations: record.confirmations,
      ...(record.result === undefined ? {} : { result: record.result })
    });
    for (const schedule of state.retrySchedules) aggregate.retrySchedules.set(schedule.taskId, schedule);
    for (const baseline of state.attemptBaselines) aggregate.attemptBaselines.set(baseline.taskId, baseline);
    for (const cached of state.commands) aggregate.commands.set(cached.receipt.idempotencyKey, cached);
  }

  #validateReplayTransition(
    aggregate: WorkflowAggregate, event: DomainEvent, before: WorkflowRunSnapshot | undefined
  ): void {
    if (event.type === "run.status_changed") {
      if (before === undefined || !validateRunTransition(before.status, event.payload.to).valid) {
        throw new Error("Illegal run transition in event history");
      }
      if (["succeeded", "failed", "cancelled"].includes(event.payload.to) &&
          before.tasks.some((task) => ["pending", "ready", "running", "retrying", "cancelling"].includes(task.status))) {
        throw new Error("Terminal run would contain an active task");
      }
      if (event.payload.to === "succeeded" && !before.tasks.every((task) =>
        taskBusinessSucceeded(aggregate.definition, task, schedulingContext(aggregate)))) {
        throw new Error("Run succeeded without all business conditions satisfied");
      }
      return;
    }
    if (event.type !== "task.status_changed") return;
    const task = before?.tasks.find((candidate) => candidate.taskId === event.taskId);
    if (task === undefined) throw new Error("Task transition has no existing task");
    const transition = validateTaskTransition(event.payload.from, event.payload.to, event.payload.intent,
      event.payload.generationTo - event.payload.generationFrom);
    if (!transition.valid) throw new Error(transition.reason ?? "Illegal task transition in event history");
    if (["succeeded", "failed", "cancelled"].includes(before!.status)) {
      throw new Error("Terminal run contains a later task transition");
    }
    if (event.payload.to === "ready" && event.payload.from === "pending" &&
        !dependenciesSatisfied(aggregate.definition, before!, task.taskId, schedulingContext(aggregate))) {
      throw new Error("Task became ready before dependencies were satisfied");
    }
    if (event.payload.from === "blocked" && event.payload.to === "ready" &&
        (task.attempt > 0 || task.agentExecution !== undefined)) {
      throw new Error("Attempted blocked task was redispatched without retry policy");
    }
    if (event.payload.intent === "rework") {
      const policy = taskDefinition(aggregate, task.taskId)?.rework ?? { maxReworks: 0, onExhausted: "fail" };
      if (task.generation >= policy.maxReworks ||
          aggregate.approvalDecisions.get(approvalKey(task.taskId, task.generation))?.decision !== "changes_requested") {
        throw new Error("Rework event has no valid approval or exceeds policy");
      }
    }
    if (event.payload.intent === "retry") {
      const definition = taskDefinition(aggregate, task.taskId);
      const failedResult = aggregate.pendingCommandEvents.find((prior) =>
        prior.type === "agent.result_recorded" && prior.taskId === task.taskId &&
        (prior.payload.status === "failed" || prior.payload.status === "timed_out") &&
        prior.payload.attemptId === task.attemptId);
      if (definition === undefined || failedResult?.type !== "agent.result_recorded" ||
          !failedResult.payload.retryable || generationAttempts(aggregate, task) >= definition.retry.maxAttempts ||
          definition.retry.retryableErrorCodes !== undefined &&
            !definition.retry.retryableErrorCodes.includes(failedResult.payload.error?.code ?? "") ||
          failedResult.payload.status === "timed_out" && definition.timeout.onTimeout !== "retry") {
        throw new Error("Retry event lacks an eligible failed result under policy");
      }
    }
    if (event.payload.from === "retrying" && event.payload.to === "ready") {
      const schedule = aggregate.retrySchedules.get(task.taskId);
      if (schedule === undefined || Date.parse(event.occurredAt) < Date.parse(schedule.eligibleAt)) {
        throw new Error("Retry became ready before its durable eligibility time");
      }
    }
    if (event.payload.to === "running" && event.payload.from === "ready" &&
        !selectRunnableTasks(aggregate.definition, before!, schedulingContext(aggregate)).includes(task.taskId)) {
      throw new Error("Task ran without readiness or available concurrency");
    }
    if (event.payload.to === "running" && event.payload.from !== "ready" &&
        (task.agentExecution === undefined ||
          !dependenciesSatisfied(aggregate.definition, before!, task.taskId, schedulingContext(aggregate)) ||
          !requiredGatesSatisfied(aggregate.definition, task, aggregate.gateOutcomes, ["before_dispatch"]) ||
          task.blockage?.code === "quality_gate" && !requiredGatesSatisfied(aggregate.definition, task,
            aggregate.gateOutcomes, ["after_result", "before_completion"]))) {
      throw new Error("Existing execution resumed without valid ownership and readiness");
    }
    if (event.payload.to === "succeeded" &&
        (!taskHasSuccessfulResult(aggregate, task) || !requiredGatesSatisfied(aggregate.definition, task,
          aggregate.gateOutcomes, ["after_result", "before_completion"]))) {
      throw new Error("Task succeeded without verified result and gates");
    }
    if (event.payload.to === "cancelled" && task.agentExecution !== undefined &&
        ["running", "waiting", "blocked", "cancelling"].includes(task.status) &&
        !aggregate.pendingCommandEvents.some((prior) =>
          prior.type === "agent.result_recorded" && prior.taskId === task.taskId && prior.payload.status === "cancelled" ||
          prior.type === "cancellation.stop_confirmed" && prior.payload.terminalStatus === "cancelled" &&
            prior.payload.executionId === task.agentExecution?.executionId) &&
        ![...aggregate.cancellations.values()].some((record) =>
          record.confirmations.some((confirmation) => confirmation.terminalStatus === "cancelled" &&
            confirmation.executionId === task.agentExecution?.executionId))) {
      throw new Error("Bound task cancelled without verified stop evidence");
    }
  }

  async getSnapshot(runId: string, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot | null>> {
    const optionError = this.#checkOptions(options);
    if (optionError !== undefined) return failure(optionError);
    const parsed = IdentifierSchema.safeParse(runId);
    if (!parsed.success) return validation("Invalid runId");
    const snapshot = this.#runs.get(parsed.data)?.snapshot;
    return success(snapshot === undefined ? null : structuredClone(snapshot));
  }

  #definitionKey(id: string, version: string): string {
    return `${id}\u0000${version}`;
  }

  #definition(id: string, version: string): WorkflowDefinition | undefined {
    const existing = this.#definitions.get(this.#definitionKey(id, version));
    if (existing !== undefined) return existing;
    const resolved = this.#resolveDefinition?.(id, version);
    if (resolved === undefined) return undefined;
    const parsed = WorkflowDefinitionSchema.safeParse(resolved);
    if (!parsed.success || parsed.data.id !== id || parsed.data.version !== version) return undefined;
    this.#definitions.set(this.#definitionKey(id, version), parsed.data);
    return parsed.data;
  }

  #issues(prefix: string, issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[]): string {
    return `${prefix}: ${issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ")}`;
  }

  #checkOptions(options: OperationOptions | undefined): ContractError | undefined {
    if (options?.signal?.aborted === true) return { code: "cancelled", retryable: false, message: "Operation was aborted" };
    if (options?.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      return { code: "timeout", retryable: true, retrySafety: "not_started", message: "Operation timeout elapsed before start" };
    }
    if (options?.deadline !== undefined) {
      const deadline = Date.parse(options.deadline);
      const now = Date.parse(this.#now());
      if (!Number.isFinite(deadline)) return { code: "validation", retryable: false, message: "Operation deadline is invalid" };
      if (deadline <= now) return { code: "timeout", retryable: true, retrySafety: "not_started", message: "Operation deadline elapsed before start" };
    }
    return undefined;
  }

  #duplicate(aggregate: WorkflowAggregate, key: string, commandFingerprint: string): OperationResult<WorkflowAdvanceResult> | undefined {
    const cached = aggregate.commands.get(key);
    if (cached === undefined) return undefined;
    return cached.receipt.fingerprint === commandFingerprint
      ? success(structuredClone(cached.result))
      : conflict(`Idempotency key collision: ${key}`);
  }

  #mutate(
    operation: CommandReceipt["operation"],
    runId: string,
    idempotencyKey: string,
    expectedVersion: number,
    command: unknown,
    options: OperationOptions | undefined,
    mutation: (aggregate: WorkflowAggregate, emitted: DomainEvent[]) => OperationResult<readonly string[]>
  ): Promise<OperationResult<WorkflowAdvanceResult>> {
    const optionError = this.#checkOptions(options);
    if (optionError !== undefined) return Promise.resolve(failure(optionError));
    const current = this.#runs.get(runId);
    if (current === undefined) return Promise.resolve(failure({ code: "not_found", retryable: false, message: `Run not found: ${runId}` }));
    const commandFingerprint = fingerprintWorkflowCommand(operation, command);
    const duplicate = this.#duplicate(current, idempotencyKey, commandFingerprint);
    if (duplicate !== undefined) return Promise.resolve(duplicate);
    if (current.snapshot.version !== expectedVersion) {
      return Promise.resolve(conflict("Aggregate version mismatch", expectedVersion, current.snapshot.version));
    }
    if (["succeeded", "failed", "cancelled"].includes(current.snapshot.status) &&
        !["recordCancellationResult", "confirmCancellationStop", "recordQualityGateResult"].includes(operation)) {
      return Promise.resolve(conflict("A terminal workflow cannot accept new work"));
    }
    const working = cloneAggregate(current);
    const emitted: DomainEvent[] = [];
    try {
      const mutated = mutation(working, emitted);
      if (!mutated.ok) return Promise.resolve(mutated);
      const fallbackTime = isRecord(command) && typeof command.occurredAt === "string"
        ? command.occurredAt : this.#now();
      const completed = this.#finishCommand(working, emitted, operation, idempotencyKey,
        commandFingerprint, mutated.value, emitted.at(-1)?.occurredAt ?? fallbackTime);
      if (!completed.ok) return Promise.resolve(completed);
      const batchIssues = validateEventBatch({ runId, expectedVersion: current.snapshot.version,
        expectedLastSequence: current.snapshot.lastEventSequence, events: emitted });
      if (batchIssues.length > 0) return Promise.resolve(failure({ code: "corruption", retryable: false,
        message: `Generated event batch is invalid: ${batchIssues.map((issue) => issue.message).join("; ")}` }));
      const result = this.#result(working, mutated.value, emitted);
      this.#runs.set(runId, working);
      return Promise.resolve(success(structuredClone(result)));
    } catch (error) {
      return Promise.resolve(failure({
        code: "corruption", retryable: false,
        message: error instanceof Error ? error.message : "Workflow mutation failed"
      }));
    }
  }

  #result(aggregate: WorkflowAggregate, runnableTaskIds: readonly string[], emittedEvents: readonly DomainEvent[]): WorkflowAdvanceResult {
    return {
      snapshot: structuredClone(aggregate.snapshot),
      runnableTaskIds: [...runnableTaskIds],
      emittedEvents: [...structuredClone(emittedEvents)]
    };
  }

  #finishCommand(
    aggregate: WorkflowAggregate, emitted: DomainEvent[], operation: CommandReceipt["operation"],
    key: string, commandFingerprint: string, runnableTaskIds: readonly string[], occurredAt: string
  ): OperationResult<void> {
    return this.#emit(aggregate, emitted, {
      type: "command.completed", occurredAt, commandKey: key,
      payload: {
        schemaVersion: 1, commandId: deterministicId("command", aggregate.snapshot.runId, key),
        idempotencyKey: key, operation, fingerprint: commandFingerprint,
        firstEventSequence: emitted[0]?.sequence ?? aggregate.snapshot.lastEventSequence + 1,
        runnableTaskIds: [...runnableTaskIds]
      }
    });
  }

  #emit(
    aggregate: WorkflowAggregate,
    emitted: DomainEvent[],
    input: { readonly type: DomainEvent["type"]; readonly occurredAt: string; readonly commandKey: string;
      readonly payload: unknown; readonly taskId?: string; readonly metadata?: WorkflowRunSnapshot["metadata"] }
  ): OperationResult<void> {
    const sequence = aggregate.snapshot.lastEventSequence + 1;
    const aggregateVersion = aggregate.snapshot.version + 1;
    const candidate = {
      schemaVersion: CURRENT_DOMAIN_EVENT_SCHEMA_VERSION,
      eventId: deterministicId("event", aggregate.snapshot.runId, String(sequence), input.type, input.commandKey),
      runId: aggregate.snapshot.runId,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      sequence,
      aggregateVersion,
      occurredAt: input.occurredAt,
      correlationId: deterministicId("correlation", aggregate.snapshot.runId, input.commandKey),
      idempotencyKey: deterministicId("idempotency", aggregate.snapshot.runId, input.commandKey, String(emitted.length + 1)),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      type: input.type,
      payload: input.payload
    };
    const parsed = DomainEventSchema.safeParse(candidate);
    if (!parsed.success) return validation(this.#issues(`Invalid generated ${input.type} event`, parsed.error.issues));
    const before = aggregate.snapshot;
    aggregate.snapshot = reduceWorkflowEvent(aggregate.snapshot.version === 0 && input.type === "run.created" ? undefined : aggregate.snapshot,
      parsed.data, aggregate.definition);
    emitted.push(parsed.data);
    this.#replayAuxiliary(aggregate, parsed.data, before);
    return success(undefined);
  }

  #replayAuxiliary(aggregate: WorkflowAggregate, event: DomainEvent, before: WorkflowRunSnapshot | undefined): void {
    aggregate.pendingCommandEvents.push(event);
    if (event.type === "command.completed") {
      const receipt = event.payload;
      const launched = aggregate.pendingCommandEvents.filter((candidate) =>
        candidate.type === "task.status_changed" && candidate.payload.from === "ready" &&
          candidate.payload.to === "running").map((candidate) => candidate.taskId);
      if (aggregate.commands.has(receipt.idempotencyKey) ||
          receipt.commandId !== deterministicId("command", event.runId, receipt.idempotencyKey) ||
          aggregate.pendingCommandEvents[0]?.sequence !== receipt.firstEventSequence ||
          aggregate.pendingCommandEvents.some((candidate, index) =>
            candidate.correlationId !== deterministicId("correlation", event.runId, receipt.idempotencyKey) ||
            candidate.idempotencyKey !== deterministicId("idempotency", event.runId,
              receipt.idempotencyKey, String(index + 1)) ||
            candidate.eventId !== deterministicId("event", event.runId, String(candidate.sequence),
              candidate.type, receipt.idempotencyKey)) ||
          receipt.operation === "advance" && JSON.stringify(launched) !== JSON.stringify(receipt.runnableTaskIds) ||
          receipt.operation !== "advance" && receipt.runnableTaskIds.length > 0 ||
          (aggregate.pendingCommandEvents[0]?.type === "run.created") !== (receipt.operation === "createRun")) {
        throw new Error("Command receipt identity or event boundary is inconsistent");
      }
      const result = this.#result(aggregate, receipt.runnableTaskIds, aggregate.pendingCommandEvents);
      aggregate.commands.set(receipt.idempotencyKey, { receipt, result });
      aggregate.pendingCommandEvents.length = 0;
      return;
    }
    if (event.type === "task.status_changed") {
      if (event.payload.intent === "rework") {
        aggregate.attemptBaselines.set(event.taskId!, {
          taskId: event.taskId!, generation: event.payload.generationTo, baseline: event.payload.attempt
        });
      }
      if (event.payload.to === "ready" || event.payload.intent === "rework") {
        aggregate.retrySchedules.delete(event.taskId!);
      }
    } else if (event.type === "task.retry_scheduled") {
      const task = taskState(aggregate, event.taskId!);
      const definition = task === undefined ? undefined : taskDefinition(aggregate, task.taskId);
      const failedResult = aggregate.pendingCommandEvents.find((prior) =>
        prior.type === "agent.result_recorded" && prior.taskId === event.taskId &&
        (prior.payload.status === "failed" || prior.payload.status === "timed_out") &&
        prior.payload.attemptId === event.payload.attemptId);
      if (task?.status !== "retrying" || task.attemptId !== event.payload.attemptId ||
          task.attempt !== event.payload.attempt || task.generation !== event.payload.generation ||
          definition === undefined || failedResult?.type !== "agent.result_recorded" ||
          event.payload.eligibleAt !== new Date(Date.parse(failedResult.occurredAt) +
            retryDelayMs(definition.retry, generationAttempts(aggregate, task), {
              runId: event.runId, taskId: task.taskId, generation: task.generation, attempt: task.attempt
            })).toISOString()) {
        throw new Error("Retry schedule does not match current task attempt");
      }
      aggregate.retrySchedules.set(event.taskId!, { taskId: event.taskId!, ...event.payload });
    } else if (event.type === "approval.requested") {
      if (aggregate.approvalsById.has(event.payload.approvalId)) throw new Error("Duplicate approval request");
      const approvalTaskId = event.payload.target.type === "task" ? event.payload.target.taskId : undefined;
      const approvalTask = approvalTaskId === undefined ? undefined :
        before?.tasks.find((candidate) => candidate.taskId === approvalTaskId);
      if (event.payload.runId !== event.runId ||
          before !== undefined && ["succeeded", "failed", "cancelled"].includes(before.status) ||
          approvalTaskId !== undefined &&
            (event.taskId !== approvalTaskId || approvalTask?.status !== "succeeded" ||
              approvalTask.generation !== event.payload.generation)) {
        throw new Error("Approval request is stale or belongs to a terminal run");
      }
      aggregate.approvalsById.set(event.payload.approvalId, { request: event.payload });
    } else if (event.type === "approval.decided") {
      const record = aggregate.approvalsById.get(event.payload.approvalId);
      const approvalTaskId = event.payload.target.type === "task" ? event.payload.target.taskId : undefined;
      if (record === undefined || record.decision !== undefined ||
          record.request.revision !== event.payload.revision || record.request.generation !== event.payload.generation ||
          JSON.stringify(record.request.target) !== JSON.stringify(event.payload.target) ||
          before !== undefined && ["succeeded", "failed", "cancelled"].includes(before.status) ||
          approvalTaskId !== undefined &&
            before?.tasks.find((candidate) => candidate.taskId === approvalTaskId)?.generation !==
              event.payload.generation) {
        throw new Error("Approval decision has no matching undecided request");
      }
      aggregate.approvalsById.set(event.payload.approvalId, { ...record, decision: event.payload });
      if (event.payload.target.type === "task") {
        aggregate.approvalDecisions.set(approvalKey(event.payload.target.taskId, event.payload.generation), event.payload);
      }
    } else if (event.type === "quality_gate.evaluation_requested") {
      if (aggregate.gateRequests.has(event.payload.evaluationId)) throw new Error("Duplicate gate evaluation request");
      const task = before?.tasks.find((candidate) => candidate.taskId === event.taskId);
      const phase = task === undefined ? "before_completion" : this.#inferGatePhase(aggregate, task, event.payload.gateId) ?? "before_completion";
      if (event.taskId !== undefined && (task === undefined ||
          phase !== "before_dispatch" &&
            (event.payload.attemptId === undefined || event.payload.attemptId !== task.attemptId ||
              !["running", "waiting", "blocked", "cancelling", "succeeded"].includes(task.status)) ||
          event.payload.attemptId !== undefined && event.payload.attemptId !== task.attemptId)) {
        throw new Error("Gate evaluation request has no current task attempt");
      }
      aggregate.gateRequests.set(event.payload.evaluationId, {
        evaluationId: event.payload.evaluationId,
        gateId: event.payload.gateId,
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
        ...(event.payload.attemptId === undefined ? {} : { attemptId: event.payload.attemptId }),
        generation: task?.generation ?? 0,
        phase
      });
    } else if (event.type === "quality_gate.evaluated") {
      const request = aggregate.gateRequests.get(event.payload.evaluationId);
      if (request === undefined || request.gateId !== event.payload.gateId || request.taskId !== event.payload.taskId ||
          aggregate.gateOutcomes.some((outcome) =>
        outcome.taskId === request.taskId && outcome.gateId === request.gateId && outcome.phase === request.phase &&
        outcome.generation === request.generation && outcome.attemptId === request.attemptId)) {
        throw new Error("Gate result has no matching open evaluation");
      }
      aggregate.gateOutcomes.push({
        gateId: request.gateId, phase: request.phase, generation: request.generation, status: event.payload.status,
        ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
        ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId })
      });
    } else if (event.type === "agent.result_recorded" && event.payload.status === "succeeded") {
      const task = before?.tasks.find((candidate) => candidate.taskId === event.taskId);
      if (task?.attemptId === undefined) throw new Error("Successful result is missing an attempt identity");
      const record = { taskId: task.taskId, generation: task.generation, attemptId: task.attemptId };
      aggregate.successfulAttempts.set(attemptKey(record.taskId, record.generation, record.attemptId), record);
    } else if (event.type === "cancellation.requested") {
      if (aggregate.cancellations.has(event.payload.cancellationId)) throw new Error("Duplicate cancellation request");
      if (event.payload.runId !== event.runId || event.payload.taskId !== event.taskId ||
          event.payload.taskId !== undefined && event.payload.executionId !== undefined &&
            before?.tasks.find((candidate) => candidate.taskId === event.payload.taskId)?.agentExecution?.executionId !==
              event.payload.executionId) {
        throw new Error("Cancellation request ownership is inconsistent");
      }
      aggregate.cancellations.set(event.payload.cancellationId, { request: event.payload, confirmations: [] });
    } else if (event.type === "cancellation.accepted" || event.type === "cancellation.refused") {
      const record = aggregate.cancellations.get(event.payload.cancellationId);
      if (record === undefined || record.result !== undefined || event.taskId !== record.request.taskId ||
          event.type === "cancellation.accepted" && event.payload.status === "accepted" &&
            record.request.executionId !== undefined && event.payload.executionId !== record.request.executionId) {
        throw new Error("Cancellation result has no matching open request or execution");
      }
      aggregate.cancellations.set(event.payload.cancellationId, { ...record, result: event.payload });
    } else if (event.type === "cancellation.stop_confirmed") {
      const record = aggregate.cancellations.get(event.payload.cancellationId);
      if (record === undefined || record.confirmations.some((confirmation) =>
        confirmation.executionId === event.payload.executionId) || event.taskId !== record.request.taskId ||
          record.request.executionId !== undefined && event.payload.executionId !== record.request.executionId ||
          record.request.taskId !== undefined && event.payload.executionId !== undefined &&
            before?.tasks.find((candidate) => candidate.taskId === record.request.taskId)?.agentExecution?.executionId !==
              event.payload.executionId) {
        throw new Error("Cancellation confirmation has no matching open request or execution");
      }
      aggregate.cancellations.set(event.payload.cancellationId, {
        ...record, confirmations: [...record.confirmations, event.payload]
      });
    }
  }

  #transitionTask(
    aggregate: WorkflowAggregate,
    emitted: DomainEvent[],
    taskId: string,
    to: TaskState["status"],
    intent: "normal" | "retry" | "rework" | "cancel",
    occurredAt: string,
    commandKey: string,
    reason?: string,
    generationTo?: number,
    blockage?: TaskState["blockage"]
  ): OperationResult<void> {
    const task = taskState(aggregate, taskId);
    if (task === undefined) return validation(`Unknown task: ${taskId}`);
    const nextGeneration = generationTo ?? task.generation;
    const checked = validateTaskTransition(task.status, to, intent, nextGeneration - task.generation);
    if (!checked.valid) return validation(checked.reason ?? "Invalid task transition");
    const attempt = task.status === "ready" && to === "running" ? task.attempt + 1 : task.attempt;
    return this.#emit(aggregate, emitted, {
      type: "task.status_changed", taskId, occurredAt, commandKey,
      payload: {
        from: task.status,
        to,
        intent,
        attempt,
        generationFrom: task.generation,
        generationTo: nextGeneration,
        ...(blockage === undefined ? {} : { blockage }),
        ...(reason === undefined ? {} : { reason })
      }
    });
  }

  #moveRun(
    aggregate: WorkflowAggregate,
    emitted: DomainEvent[],
    target: WorkflowRunSnapshot["status"],
    occurredAt: string,
    commandKey: string,
    reason?: string
  ): OperationResult<void> {
    if (aggregate.snapshot.status === target) return success(undefined);
    let current = aggregate.snapshot.status;
    const direct = validateRunTransition(current, target);
    if (!direct.valid) {
      let bridge: WorkflowRunSnapshot["status"] | undefined;
      if (target === "cancelled" && current !== "cancelling") bridge = "cancelling";
      else if (current === "queued" || ((current === "waiting" || current === "blocked") && target === "succeeded")) bridge = "running";
      if (bridge === undefined || !validateRunTransition(current, bridge).valid) return validation(direct.reason ?? "Invalid run transition");
      const bridged = this.#emit(aggregate, emitted, {
        type: "run.status_changed", occurredAt, commandKey,
        payload: { from: current, to: bridge, ...(reason === undefined ? {} : { reason }) }
      });
      if (!bridged.ok) return bridged;
      current = bridge;
    }
    const finalCheck = validateRunTransition(current, target);
    if (!finalCheck.valid) return validation(finalCheck.reason ?? "Invalid run transition");
    return this.#emit(aggregate, emitted, {
      type: "run.status_changed", occurredAt, commandKey,
      payload: { from: current, to: target, ...(reason === undefined ? {} : { reason }) }
    });
  }

  #recomputeRunStatus(
    aggregate: WorkflowAggregate,
    emitted: DomainEvent[],
    occurredAt: string,
    commandKey: string
  ): OperationResult<void> {
    const tasks = aggregate.snapshot.tasks;
    if (["succeeded", "failed", "cancelled"].includes(aggregate.snapshot.status)) return success(undefined);
    let target: WorkflowRunSnapshot["status"];
    if (aggregate.snapshot.status === "cancelling") {
      if (tasks.some((task) => !["succeeded", "failed", "cancelled"].includes(task.status))) return success(undefined);
      target = tasks.every((task) => task.status === "succeeded") ? "succeeded" :
        tasks.every((task) => task.status === "cancelled") ? "cancelled" : "failed";
      return this.#moveRun(aggregate, emitted, target, occurredAt, commandKey);
    }
    const context = schedulingContext(aggregate);
    const rejectedApproval = aggregate.definition.tasks.some((definition) => {
      const task = taskState(aggregate, definition.id);
      return definition.requiresApproval && task !== undefined &&
        aggregate.approvalDecisions.get(approvalKey(task.taskId, task.generation))?.decision === "rejected";
    });
    const allBusinessSucceeded = tasks.every((task) => taskBusinessSucceeded(aggregate.definition, task, context));
    const hasActive = tasks.some((task) => ["pending", "ready", "running", "retrying", "cancelling"].includes(task.status));
    const exhaustedRework = aggregate.definition.tasks.flatMap((definition) => {
      const task = taskState(aggregate, definition.id);
      const policy = definition.rework ?? { maxReworks: 0, onExhausted: "fail" as const };
      return task !== undefined && task.generation >= policy.maxReworks &&
        aggregate.approvalDecisions.get(approvalKey(task.taskId, task.generation))?.decision === "changes_requested"
        ? [policy.onExhausted] : [];
    });
    const hasBlocked = tasks.some((task) => task.status === "blocked") || exhaustedRework.includes("require_human");
    const hasWaiting = tasks.some((task) => task.status === "waiting" ||
      (task.status === "succeeded" && (!taskApprovalSatisfied(aggregate.definition, task, aggregate.approvalDecisions) ||
        !requiredGatesSatisfied(aggregate.definition, task, aggregate.gateOutcomes, ["after_result", "before_completion"]))));
    const hasFailure = tasks.some((task) => task.status === "failed" || task.status === "cancelled") ||
      rejectedApproval || exhaustedRework.includes("fail");
    if (allBusinessSucceeded) target = "succeeded";
    else if (hasActive) target = "running";
    else if (exhaustedRework.includes("require_human")) target = "blocked";
    else if (exhaustedRework.includes("fail")) target = "failed";
    else if (hasBlocked || (hasFailure && aggregate.definition.failurePolicy === "block")) target = "blocked";
    else if (hasWaiting) target = "waiting";
    else if (hasFailure) target = "failed";
    else target = "waiting";
    return this.#moveRun(aggregate, emitted, target, occurredAt, commandKey);
  }

  #inferGatePhase(
    aggregate: WorkflowAggregate,
    task: TaskState,
    gateId: string
  ): QualityGateBinding["phase"] | undefined {
    const bindings = taskDefinition(aggregate, task.taskId)?.qualityGates.filter((binding) => binding.gateId === gateId) ?? [];
    if (task.status === "ready") return bindings.find((binding) => binding.phase === "before_dispatch")?.phase;
    return bindings.find((binding) =>
      binding.phase !== "before_dispatch" && !aggregate.gateOutcomes.some((outcome) =>
        outcome.taskId === task.taskId && outcome.gateId === gateId && outcome.phase === binding.phase &&
        outcome.generation === task.generation && outcome.attemptId === task.attemptId))?.phase;
  }
}
