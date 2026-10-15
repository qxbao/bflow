import { randomUUID } from "node:crypto";
import {
  CancellationRequestSchema,
  IdentifierSchema,
  ResumeRunInputSchema,
  RunQuerySchema,
  StartRunInputSchema,
  type AgentReadOptions,
  type AgentRegistry,
  type AgentTransport,
  type ApprovalDecision,
  type ArtifactReference,
  type ArtifactStore,
  type CancellationRequest,
  type DomainEvent,
  type JsonValue,
  type OperationOptions,
  type OperationResult,
  type Page,
  type QualityGate,
  type ResumeRunInput,
  type RunQuery,
  type RunStore,
  type RuntimeService,
  type StartRunInput,
  type StoredRun,
  type WorkflowDefinition,
  type WorkflowEngine,
  type WorkflowRunSnapshot
} from "@bflow/contracts";
import { TaskDispatcher } from "./dispatcher.js";
import { SdlcWorkflowOrchestrator } from "./orchestrator.js";
import { recoverWorkflowRun } from "./recovery.js";
import { createDomainEventStream, DefaultRunEventHub, type RunEventHub } from "./stream.js";

export interface RuntimePorts {
  readonly engine: WorkflowEngine;
  readonly runStore: RunStore;
  readonly artifactStore: ArtifactStore;
  readonly agentRegistry: AgentRegistry;
  readonly transport: AgentTransport;
  readonly qualityGate?: QualityGate | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly now?: (() => string) | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly runtimeId?: string | undefined;
  readonly eventHub?: RunEventHub | undefined;
}

export interface RuntimeInitOptions {
  readonly runtimeId?: string | undefined;
  readonly configuration?: JsonValue | undefined;
  readonly recoveryMode?: boolean | undefined;
}

export interface StartRunOptions {
  readonly runId?: string | undefined;
  readonly input?: JsonValue | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly metadata?: Record<string, JsonValue> | undefined;
}

export interface ApproveOptions {
  readonly approvalId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly decision?: ("approved" | "rejected" | "changes_requested") | undefined;
  readonly decidedBy?: string | undefined;
  readonly reason?: string | undefined;
  readonly feedbackArtifacts?: ArtifactReference[] | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface CancelRunOptions {
  readonly runId: string;
  readonly reason?: string | undefined;
  readonly requestedBy?: string | undefined;
  readonly taskId?: string | undefined;
}

export interface ConcreteRuntimeService extends RuntimeService {
  readonly dispatcher: TaskDispatcher;
  readonly orchestrator: SdlcWorkflowOrchestrator;
  init(options?: RuntimeInitOptions): Promise<OperationResult<void>>;
  startRun(definition: WorkflowDefinition, options?: StartRunOptions): Promise<OperationResult<WorkflowRunSnapshot>>;
  getRunStatus(runId: string): Promise<OperationResult<WorkflowRunSnapshot | null>>;
  approve(runId: string, options?: ApproveOptions): Promise<OperationResult<WorkflowRunSnapshot>>;
  resume(inputOrRunId: ResumeRunInput | string, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot>>;
  cancel(requestOrOptions: CancellationRequest | CancelRunOptions, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot>>;
}

export class RuntimeServiceImpl implements ConcreteRuntimeService {
  private readonly ports: RuntimePorts;
  private readonly eventHub: RunEventHub;
  private readonly now: () => string;
  readonly dispatcher: TaskDispatcher;
  readonly orchestrator: SdlcWorkflowOrchestrator;
  private initialized = false;

  constructor(ports: RuntimePorts) {
    this.ports = ports;
    this.eventHub = ports.eventHub ?? new DefaultRunEventHub();
    this.now = ports.now ?? (ports.clock ? () => ports.clock!().toISOString() : () => new Date().toISOString());
    this.dispatcher = new TaskDispatcher({
      engine: ports.engine,
      runStore: ports.runStore,
      agentRegistry: ports.agentRegistry,
      transport: ports.transport,
      clock: ports.clock,
      eventHub: this.eventHub
    });
    this.orchestrator = new SdlcWorkflowOrchestrator(
      {
        engine: ports.engine,
        runStore: ports.runStore,
        artifactStore: ports.artifactStore,
        qualityGate: ports.qualityGate,
        clock: ports.clock,
        eventHub: this.eventHub
      },
      this.dispatcher
    );
  }

  async init(options?: RuntimeInitOptions): Promise<OperationResult<void>> {
    if (this.initialized) return { ok: true, value: undefined };
    if (this.ports.transport.initialize) {
      const initResult = await this.ports.transport.initialize({
        runtimeId: options?.runtimeId ?? this.ports.runtimeId ?? "runtime-default",
        configuration: options?.configuration ?? {},
        recoveryMode: options?.recoveryMode ?? false,
        initializedAt: this.now()
      });
      if (!initResult.ok) return initResult;
    }
    this.initialized = true;
    return { ok: true, value: undefined };
  }

  async start(input: StartRunInput, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot>> {
    const parsed = StartRunInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "validation", retryable: false, message: parsed.error.message }
      };
    }
    const data = parsed.data;

    // Validate workflow definition
    const defResult = await this.ports.engine.validateDefinition(data.definition);
    if (!defResult.ok) return defResult as OperationResult<WorkflowRunSnapshot>;

    // Check duplicate run
    const existing = await this.ports.runStore.get(data.runId, options);
    if (!existing.ok) return existing as OperationResult<WorkflowRunSnapshot>;
    if (existing.value !== null) {
      return {
        ok: false,
        error: { code: "conflict", retryable: true, message: `Run already exists: ${data.runId}` }
      };
    }

    // Persist initial StoredRun in RunStore
    const initialSnapshot: WorkflowRunSnapshot = {
      runId: data.runId,
      workflowId: data.definition.id,
      workflowVersion: data.definition.version,
      status: "queued",
      ...(data.input !== undefined ? { input: data.input } : {}),
      tasks: data.definition.tasks.map((task) => ({
        taskId: task.id,
        status: "pending",
        attempt: 0,
        generation: 0,
        version: 0
      })),
      createdAt: data.requestedAt,
      updatedAt: data.requestedAt,
      version: 0,
      lastEventSequence: 0,
      ...(data.metadata !== undefined ? { metadata: data.metadata } : {})
    };

    const storedRun: StoredRun = { snapshot: initialSnapshot, definition: data.definition };
    const createStoreResult = await this.ports.runStore.create(storedRun, data.idempotencyKey, options);
    if (!createStoreResult.ok) return createStoreResult as OperationResult<WorkflowRunSnapshot>;

    // Create run in Engine
    const createCmd = {
      runId: data.runId,
      definition: data.definition,
      input: data.input,
      idempotencyKey: data.idempotencyKey,
      createdAt: data.requestedAt,
      metadata: data.metadata
    };
    const engineCreateResult = await this.ports.engine.createRun(createCmd, options);
    if (!engineCreateResult.ok) return engineCreateResult;

    // Append emitted events to RunStore and publish to EventHub
    if (engineCreateResult.value.emittedEvents.length > 0) {
      const appendResult = await this.ports.runStore.appendEvents({
        runId: data.runId,
        expectedVersion: 0,
        expectedLastSequence: 0,
        idempotencyKey: `${data.idempotencyKey}:create-events`,
        events: engineCreateResult.value.emittedEvents
      }, options);
      if (!appendResult.ok) return appendResult as OperationResult<WorkflowRunSnapshot>;
      this.eventHub.publish(data.runId, engineCreateResult.value.emittedEvents);
    }

    // Execute workflow driving loop
    return this.orchestrator.driveRun(data.runId, options);
  }

  async startRun(definition: WorkflowDefinition, options?: StartRunOptions): Promise<OperationResult<WorkflowRunSnapshot>> {
    const runId = options?.runId ?? `run-${randomUUID()}`;
    const idempotencyKey = options?.idempotencyKey ?? `start-${randomUUID()}`;
    const requestedAt = this.now();

    const input: StartRunInput = {
      runId,
      definition,
      ...(options?.input !== undefined ? { input: options.input } : {}),
      requestedAt,
      idempotencyKey,
      ...(options?.metadata !== undefined ? { metadata: options.metadata } : {})
    };

    return this.start(input);
  }

  async getRun(runId: string, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot | null>> {
    const parsed = IdentifierSchema.safeParse(runId);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "validation", retryable: false, message: `Invalid runId: ${runId}` }
      };
    }

    let snapshot: WorkflowRunSnapshot | null = null;
    const engineSnap = await this.ports.engine.getSnapshot(runId, options);
    if (engineSnap.ok && engineSnap.value !== null) {
      snapshot = engineSnap.value;
    } else {
      const stored = await this.ports.runStore.get(runId, options);
      if (!stored.ok) return stored as OperationResult<WorkflowRunSnapshot | null>;
      if (stored.value === null) return { ok: true, value: null };
      snapshot = stored.value.snapshot;
    }

    const hasBlockedTask = snapshot.tasks.some((t) => t.status === "blocked");
    const hasActiveTask = snapshot.tasks.some((t) => ["running", "ready", "retrying"].includes(t.status));
    if (snapshot.status === "running" && hasBlockedTask && !hasActiveTask) {
      return { ok: true, value: { ...snapshot, status: "blocked" } };
    }
    return { ok: true, value: snapshot };
  }

  async getRunStatus(runId: string): Promise<OperationResult<WorkflowRunSnapshot | null>> {
    return this.getRun(runId);
  }

  async findRuns(query: RunQuery, options?: OperationOptions): Promise<OperationResult<Page<WorkflowRunSnapshot>>> {
    const parsed = RunQuerySchema.safeParse(query);
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: "validation", retryable: false, message: parsed.error.message }
      };
    }

    const storeResult = await this.ports.runStore.find(parsed.data, options);
    if (!storeResult.ok) return storeResult as OperationResult<Page<WorkflowRunSnapshot>>;

    const snapshots = storeResult.value.items.map((stored) => stored.snapshot);
    return {
      ok: true,
      value: {
        items: snapshots,
        ...(storeResult.value.nextCursor !== undefined ? { nextCursor: storeResult.value.nextCursor } : {})
      }
    };
  }

  watch(runId: string, options?: AgentReadOptions): AsyncIterable<OperationResult<DomainEvent>> {
    return createDomainEventStream(this.ports, this.eventHub, runId, options);
  }

  private async ensureRunRecovered(runId: string, options?: OperationOptions): Promise<OperationResult<void>> {
    const parsed = IdentifierSchema.safeParse(runId);
    if (!parsed.success) {
      return { ok: true, value: undefined };
    }
    const engineSnap = await this.ports.engine.getSnapshot(runId, options);
    if (engineSnap.ok && engineSnap.value !== null) {
      return { ok: true, value: undefined };
    }
    const stored = await this.ports.runStore.get(runId, options);
    if (!stored.ok) return stored as OperationResult<void>;
    if (stored.value === null) {
      return { ok: true, value: undefined };
    }
    const recoverResult = await recoverWorkflowRun(runId, this.ports, options);
    if (!recoverResult.ok) return recoverResult as OperationResult<void>;
    return { ok: true, value: undefined };
  }

  async decide(decision: ApprovalDecision, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot>> {
    if (decision && typeof decision === "object" && typeof decision.runId === "string") {
      const recRes = await this.ensureRunRecovered(decision.runId, options);
      if (!recRes.ok) return recRes as OperationResult<WorkflowRunSnapshot>;
    }
    return this.orchestrator.applyApprovalDecision(decision, options);
  }

  async approve(runId: string, options?: ApproveOptions): Promise<OperationResult<WorkflowRunSnapshot>> {
    const approvalId = options?.approvalId ?? `appr-${randomUUID()}`;
    const idempotencyKey = options?.idempotencyKey ?? `appr-idempotency-${randomUUID()}`;
    const decidedAt = this.now();

    const decision: ApprovalDecision = {
      schemaVersion: 1,
      approvalId,
      runId,
      target: options?.taskId ? { type: "task", taskId: options.taskId } : { type: "run" },
      revision: 1,
      generation: 0,
      decision: options?.decision ?? "approved",
      decidedBy: options?.decidedBy ?? "human_operator",
      decidedAt,
      ...(options?.reason ? { reason: options.reason } : {}),
      feedbackArtifacts: options?.feedbackArtifacts ?? [],
      idempotencyKey
    };

    return this.decide(decision);
  }

  async cancel(
    requestOrOptions: CancellationRequest | CancelRunOptions,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowRunSnapshot>> {
    if (
      requestOrOptions &&
      typeof requestOrOptions === "object" &&
      "runId" in requestOrOptions &&
      typeof requestOrOptions.runId === "string"
    ) {
      const recRes = await this.ensureRunRecovered(requestOrOptions.runId, options);
      if (!recRes.ok) return recRes as OperationResult<WorkflowRunSnapshot>;
    }

    let cancelRequest: CancellationRequest;

    if ("runId" in requestOrOptions && !("cancellationId" in requestOrOptions)) {
      const snapRes = await this.getRun(requestOrOptions.runId, options);
      if (!snapRes.ok || !snapRes.value) {
        return {
          ok: false,
          error: { code: "not_found", retryable: false, message: `Run ${requestOrOptions.runId} not found` }
        };
      }
      const snapshot = snapRes.value;
      const cancellationId = randomUUID();

      cancelRequest = {
        schemaVersion: 1,
        cancellationId,
        runId: requestOrOptions.runId,
        ...(requestOrOptions.taskId ? { taskId: requestOrOptions.taskId } : {}),
        requestedBy: requestOrOptions.requestedBy ?? "runtime",
        requestedAt: this.now(),
        expectedVersion: snapshot.version,
        reason: requestOrOptions.reason ?? "Run cancelled by operator",
        idempotencyKey: `cancel-${cancellationId}`
      };
    } else {
      const parsed = CancellationRequestSchema.safeParse(requestOrOptions);
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: "validation", retryable: false, message: parsed.error.message }
        };
      }
      cancelRequest = parsed.data;
    }

    if (cancelRequest.taskId) {
      const cancelRes = await this.dispatcher.cancelTask(cancelRequest.runId, cancelRequest.taskId, cancelRequest.reason, options);
      if (!cancelRes.ok) return cancelRes as OperationResult<WorkflowRunSnapshot>;
      const freshSnap = await this.getRun(cancelRequest.runId, options);
      if (!freshSnap.ok || !freshSnap.value) {
        return { ok: false, error: { code: "corruption", retryable: false, message: "Could not retrieve snapshot" } };
      }
      return { ok: true, value: freshSnap.value };
    }

    // Run-level cancellation
    const currentSnapRes = await this.getRun(cancelRequest.runId, options);
    if (!currentSnapRes.ok || !currentSnapRes.value) {
      return { ok: false, error: { code: "not_found", retryable: false, message: `Run ${cancelRequest.runId} not found` } };
    }
    const currentSnap = currentSnapRes.value;

    const reqCancelRes = await this.ports.engine.requestCancellation(cancelRequest, options);
    if (!reqCancelRes.ok) return reqCancelRes;

    if (reqCancelRes.value.emittedEvents.length > 0) {
      await this.ports.runStore.appendEvents({
        runId: cancelRequest.runId,
        expectedVersion: currentSnap.version,
        expectedLastSequence: currentSnap.lastEventSequence,
        events: reqCancelRes.value.emittedEvents,
        idempotencyKey: `cancel-events-${cancelRequest.cancellationId}`
      }, options);
      this.eventHub.publish(cancelRequest.runId, reqCancelRes.value.emittedEvents);
    }

    let currentSnapshot = reqCancelRes.value.snapshot;

    // Confirm cancellation stop for each bound execution first
    const boundTasks = currentSnapshot.tasks.filter(
      (task) => task.status === "cancelling" && task.agentExecution !== undefined
    );

    let cancellationResultRecorded = false;

    for (const boundTask of boundTasks) {
      const handle = boundTask.agentExecution!;
      // 1. Send transport cancel
      const cancelOutcome = await this.ports.transport.cancel(handle, cancelRequest, options);
      if (!cancelOutcome.ok) {
        return cancelOutcome;
      }

      if (!cancellationResultRecorded) {
        const cancelResRecord = await this.ports.engine.recordCancellationResult(
          {
            runId: cancelRequest.runId,
            expectedVersion: currentSnapshot.version,
            result: {
              ...cancelOutcome.value,
              schemaVersion: cancelOutcome.value.schemaVersion ?? 1
            },
            idempotencyKey: `cancel-result-${cancelRequest.cancellationId}:${boundTask.taskId}:${handle.executionId}`
          },
          options
        );
        if (cancelResRecord.ok && cancelResRecord.value.emittedEvents.length > 0) {
          const appendRecordRes = await this.ports.runStore.appendEvents(
            {
              runId: cancelRequest.runId,
              expectedVersion: currentSnapshot.version,
              expectedLastSequence: currentSnapshot.lastEventSequence,
              events: cancelResRecord.value.emittedEvents,
              idempotencyKey: `cancel-result-events-${cancelRequest.cancellationId}:${boundTask.taskId}:${handle.executionId}`
            },
            options
          );
          if (!appendRecordRes.ok) {
            return appendRecordRes as OperationResult<WorkflowRunSnapshot>;
          }
          this.eventHub.publish(cancelRequest.runId, cancelResRecord.value.emittedEvents);
          currentSnapshot = cancelResRecord.value.snapshot;
        }
        cancellationResultRecorded = true;
      }

      // Check whether remote stop is confirmed before transitioning task to cancelled
      let stopConfirmed = false;
      if (cancelOutcome.value.status === "already_terminal") {
        stopConfirmed = true;
      } else if (cancelOutcome.value.status === "accepted") {
        const waitRes = await this.ports.transport.wait(handle, {
          ...options,
          timeoutMs: 0
        });
        if (
          waitRes.ok &&
          (waitRes.value.state === "cancelled" || waitRes.value.state === "done")
        ) {
          stopConfirmed = true;
        }
      }

      if (!stopConfirmed) {
        continue;
      }

      // 2. Release lease if active
      const active = this.dispatcher.getActiveExecution(cancelRequest.runId, boundTask.taskId);
      if (active) {
        await this.dispatcher.releaseLease(active.lease, options);
      }

      // 3. Confirm cancellation stop for this specific execution
      const stopRes = await this.ports.engine.confirmCancellationStop(
        {
          runId: cancelRequest.runId,
          expectedVersion: currentSnapshot.version,
          confirmation: {
            schemaVersion: 1,
            cancellationId: cancelRequest.cancellationId,
            executionId: handle.executionId,
            stoppedAt: this.now(),
            terminalStatus: "cancelled"
          },
          idempotencyKey: `confirm-stop-${cancelRequest.cancellationId}:${boundTask.taskId}:${handle.executionId}`
        },
        options
      );
      if (!stopRes.ok) return stopRes;

      if (stopRes.value.emittedEvents.length > 0) {
        await this.ports.runStore.appendEvents(
          {
            runId: cancelRequest.runId,
            expectedVersion: currentSnapshot.version,
            expectedLastSequence: currentSnapshot.lastEventSequence,
            events: stopRes.value.emittedEvents,
            idempotencyKey: `confirm-stop-events-${cancelRequest.cancellationId}:${boundTask.taskId}:${handle.executionId}`
          },
          options
        );
        this.eventHub.publish(cancelRequest.runId, stopRes.value.emittedEvents);
        currentSnapshot = stopRes.value.snapshot;
      }
    }

    // Now confirm cancellation stop for any unbound tasks only when no bound tasks remain in 'cancelling'
    const hasBoundCancelling = currentSnapshot.tasks.some(
      (task) => task.status === "cancelling" && task.agentExecution !== undefined
    );
    const hasUnboundCancelling = currentSnapshot.tasks.some(
      (task) => task.status === "cancelling" && task.agentExecution === undefined
    );
    if (!hasBoundCancelling && (hasUnboundCancelling || currentSnapshot.status === "cancelling")) {
      const confirmUnboundRes = await this.ports.engine.confirmCancellationStop(
        {
          runId: cancelRequest.runId,
          expectedVersion: currentSnapshot.version,
          confirmation: {
            schemaVersion: 1,
            cancellationId: cancelRequest.cancellationId,
            stoppedAt: this.now(),
            terminalStatus: "cancelled"
          },
          idempotencyKey: `confirm-stop-${cancelRequest.cancellationId}:unbound`
        },
        options
      );
      if (!confirmUnboundRes.ok) return confirmUnboundRes;

      if (confirmUnboundRes.value.emittedEvents.length > 0) {
        await this.ports.runStore.appendEvents(
          {
            runId: cancelRequest.runId,
            expectedVersion: currentSnapshot.version,
            expectedLastSequence: currentSnapshot.lastEventSequence,
            events: confirmUnboundRes.value.emittedEvents,
            idempotencyKey: `confirm-stop-events-${cancelRequest.cancellationId}:unbound`
          },
          options
        );
        this.eventHub.publish(cancelRequest.runId, confirmUnboundRes.value.emittedEvents);
        currentSnapshot = confirmUnboundRes.value.snapshot;
      }
    }

    return { ok: true, value: currentSnapshot };
  }

  async resume(
    inputOrRunId: ResumeRunInput | string,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowRunSnapshot>> {
    let input: ResumeRunInput;

    if (typeof inputOrRunId === "string") {
      input = {
        runId: inputOrRunId,
        requestedAt: this.now(),
        idempotencyKey: `resume-${randomUUID()}`
      };
    } else {
      const parsed = ResumeRunInputSchema.safeParse(inputOrRunId);
      if (!parsed.success) {
        return {
          ok: false,
          error: { code: "validation", retryable: false, message: parsed.error.message }
        };
      }
      input = parsed.data;
    }

    // Check if run is in engine memory; if not, recover
    const engineSnap = await this.ports.engine.getSnapshot(input.runId, options);
    if (!engineSnap.ok || engineSnap.value === null) {
      const recoverResult = await recoverWorkflowRun(input.runId, this.ports, options);
      if (!recoverResult.ok) return recoverResult as OperationResult<WorkflowRunSnapshot>;
    }

    return this.orchestrator.driveRun(input.runId, options);
  }
}

export function createRuntimeService(ports: RuntimePorts): ConcreteRuntimeService {
  return new RuntimeServiceImpl(ports);
}
