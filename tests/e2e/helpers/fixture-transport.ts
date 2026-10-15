import { randomUUID } from "node:crypto";
import type {
  AgentExecutionHandle,
  AgentMessage,
  AgentReadOptions,
  AgentReconciliationRequest,
  AgentReconciliationResult,
  AgentRequest,
  AgentResult,
  AgentSubmissionReceipt,
  AgentTransport,
  AgentTransportCapabilities,
  AgentTransportInitialization,
  AgentTransportObservation,
  AgentWaitOptions,
  CancellationRequest,
  CancellationResult,
  OperationOptions,
  OperationResult
} from "@ai-flow/contracts";

export type FixtureDeliveryMode =
  | "accepted"
  | "unknown-after-write"
  | "unknown-before-write"
  | "unknown_delivery"
  | "error";

export interface FixtureTransportOptions {
  readonly clock?: () => Date;
  readonly defaultDeliveryMode?: FixtureDeliveryMode;
  readonly defaultErrorMessage?: string;
}

export interface ServerExecutionRecord {
  readonly handle: AgentExecutionHandle;
  status: "bound" | "cancelling" | "cancelled" | "terminal";
  cancellationRequested?: boolean;
  stoppedAt?: string;
  result?: AgentResult;
}

/**
 * Deterministic, offline AgentTransport implementation for E2E integration verification.
 *
 * Guarantees:
 * 1. Side effects are strictly counted: sendCallsCount vs externalWriteCount.
 * 2. Distinction between cancellation requested (accepted) vs remote execution stopped (confirmStop).
 * 3. Default reconcile returns unknown_delivery unless explicitly recorded in server ledger.
 * 4. Never synthesizes bound handles or business success out of thin air.
 * 5. Supports simulating transport failure, ambiguous timeouts, and foreign correlation.
 */
export class FixtureAgentTransport implements AgentTransport {
  readonly sentRequests: AgentRequest[] = [];
  readonly cancelledHandles: Array<{ handle: AgentExecutionHandle; request: CancellationRequest }> = [];
  readonly reconciledRequests: AgentReconciliationRequest[] = [];
  readonly waitedHandles: Array<{ handle: AgentExecutionHandle; options?: AgentWaitOptions }> = [];

  readonly serverLedger = new Map<string, ServerExecutionRecord>();

  sendCallsCount = 0;
  externalWriteCount = 0;
  reconcileCallsCount = 0;
  cancelCallsCount = 0;

  private readonly clock: () => Date;
  public defaultDeliveryMode: FixtureDeliveryMode;
  public defaultErrorMessage: string;

  /** Pre-send observation hook (e.g. to verify RunStore dispatch_requested before write) */
  onBeforeSend?: ((request: AgentRequest) => Promise<void> | void) | undefined;

  customSendHandler?: ((req: AgentRequest) => Promise<OperationResult<AgentSubmissionReceipt>> | OperationResult<AgentSubmissionReceipt>) | undefined;
  customReconcileHandler?: ((req: AgentReconciliationRequest) => Promise<OperationResult<AgentReconciliationResult>> | OperationResult<AgentReconciliationResult>) | undefined;
  customCancelHandler?: ((handle: AgentExecutionHandle, req: CancellationRequest) => Promise<OperationResult<CancellationResult>> | OperationResult<CancellationResult>) | undefined;
  customWaitHandler?: ((handle: AgentExecutionHandle, options?: AgentWaitOptions) => Promise<OperationResult<AgentTransportObservation>> | OperationResult<AgentTransportObservation>) | undefined;

  setSimulateUnknownDelivery(enabled: boolean): void {
    this.defaultDeliveryMode = enabled ? "unknown_delivery" : "accepted";
  }

  setDeliveryMode(mode: FixtureDeliveryMode): void {
    this.defaultDeliveryMode = mode;
  }

  setCustomReconcileHandler(handler?: (req: AgentReconciliationRequest) => Promise<OperationResult<AgentReconciliationResult>> | OperationResult<AgentReconciliationResult>): void {
    this.customReconcileHandler = handler;
  }

  /**
   * Explicitly marks an execution as stopped on the remote server ledger.
   * Required to satisfy the distributed cancellation protocol:
   * Cancellation "accepted" only acknowledges the signal was received;
   * execution is only stopped when explicitly confirmed.
   */
  confirmStop(executionId: string): void {
    for (const record of this.serverLedger.values()) {
      if (record.handle.executionId === executionId) {
        record.status = "cancelled";
        record.stoppedAt = this.clock().toISOString();
        return;
      }
    }
  }

  constructor(options?: FixtureTransportOptions) {
    this.clock = options?.clock ?? (() => new Date());
    this.defaultDeliveryMode = options?.defaultDeliveryMode ?? "accepted";
    this.defaultErrorMessage = options?.defaultErrorMessage ?? "Simulated transport error";
  }

  async initialize(
    _initialization: AgentTransportInitialization,
    _options?: OperationOptions
  ): Promise<OperationResult<AgentTransportCapabilities>> {
    return {
      ok: true,
      value: {
        transportName: "fixture-agent-transport",
        protocolVersion: "1.0",
        supportsStreaming: false,
        supportsCancellation: true,
        supportsResume: false,
        supportsSubmissionCorrelation: true
      }
    };
  }

  async send(
    request: AgentRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<AgentSubmissionReceipt>> {
    this.sendCallsCount++;
    this.sentRequests.push(request);

    if (this.onBeforeSend) {
      await this.onBeforeSend(request);
    }

    if (this.customSendHandler) {
      return this.customSendHandler(request);
    }

    const now = this.clock().toISOString();

    if (this.defaultDeliveryMode === "error") {
      return {
        ok: false,
        error: {
          code: "transport_unavailable",
          retryable: true,
          message: this.defaultErrorMessage
        }
      };
    }

    // Mode: unknown-before-write or default unknown_delivery (drop before external write)
    if (this.defaultDeliveryMode === "unknown-before-write" || this.defaultDeliveryMode === "unknown_delivery") {
      return {
        ok: true,
        value: {
          status: "unknown_delivery",
          requestId: request.requestId,
          attemptId: request.attemptId,
          runId: request.runId,
          taskId: request.taskId,
          idempotencyKey: request.idempotency.key,
          target: request.target,
          observedAt: now,
          reason: "Simulated transport timeout before delivery acknowledgement (no write)",
          resendAllowed: false,
          manualInterventionRequired: true
        }
      };
    }

    const executionId = `exec-${randomUUID()}`;
    const handle: AgentExecutionHandle = {
      executionId,
      requestId: request.requestId,
      attemptId: request.attemptId,
      runId: request.runId,
      taskId: request.taskId,
      idempotencyKey: request.idempotency.key,
      target: request.target,
      correlation: {
        token: request.requestId,
        provenance: "transport",
        verified: true
      },
      acceptedAt: now
    };

    // Mode: unknown-after-write (remote external write occurs, but return network timeout)
    if (this.defaultDeliveryMode === "unknown-after-write") {
      this.externalWriteCount++;
      this.serverLedger.set(request.requestId, {
        handle,
        status: "bound"
      });
      return {
        ok: true,
        value: {
          status: "unknown_delivery",
          requestId: request.requestId,
          attemptId: request.attemptId,
          runId: request.runId,
          taskId: request.taskId,
          idempotencyKey: request.idempotency.key,
          target: request.target,
          observedAt: now,
          reason: "Simulated transport response timeout after external write",
          resendAllowed: false,
          manualInterventionRequired: true
        }
      };
    }

    // Mode: accepted
    this.externalWriteCount++;
    this.serverLedger.set(request.requestId, {
      handle,
      status: "bound"
    });

    return {
      ok: true,
      value: {
        status: "accepted",
        requestId: request.requestId,
        attemptId: request.attemptId,
        runId: request.runId,
        taskId: request.taskId,
        observedAt: now,
        handle
      }
    };
  }

  async reconcile(
    request: AgentReconciliationRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<AgentReconciliationResult>> {
    this.reconcileCallsCount++;
    this.reconciledRequests.push(request);

    if (this.customReconcileHandler) {
      return this.customReconcileHandler(request);
    }

    const now = this.clock().toISOString();
    const existing = this.serverLedger.get(request.requestId);

    if (!existing) {
      // Rule: Do NOT invent execution handles or business success on reconcile!
      return {
        ok: true,
        value: {
          status: "unknown_delivery",
          requestId: request.requestId,
          retrySafe: false,
          observedAt: now,
          reason: "Server ledger has no record for this request",
          manualInterventionRequired: true
        }
      };
    }

    return {
      ok: true,
      value: {
        status: "bound",
        handle: existing.handle
      }
    };
  }

  async cancel(
    handle: AgentExecutionHandle,
    request: CancellationRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<CancellationResult>> {
    this.cancelCallsCount++;
    this.cancelledHandles.push({ handle, request });

    if (this.customCancelHandler) {
      return this.customCancelHandler(handle, request);
    }

    const now = this.clock().toISOString();
    const record = this.serverLedger.get(handle.requestId);
    if (record) {
      // Cancellation receipt records that cancellation was REQUESTED at the transport boundary.
      // It does NOT mean the remote process has stopped!
      // Status remains "cancelling" until explicit confirmStop() or observed terminal boundary.
      record.cancellationRequested = true;
      if (record.status === "bound") {
        record.status = "cancelling";
      }
    }

    return {
      ok: true,
      value: {
        schemaVersion: 1,
        cancellationId: request.cancellationId,
        status: "accepted",
        executionId: handle.executionId,
        observedAt: now
      }
    };
  }

  async wait(
    handle: AgentExecutionHandle,
    options?: AgentWaitOptions
  ): Promise<OperationResult<AgentTransportObservation>> {
    this.waitedHandles.push({ handle, ...(options !== undefined ? { options } : {}) });

    if (this.customWaitHandler) {
      return this.customWaitHandler(handle, options);
    }

    const now = this.clock().toISOString();
    const record = this.serverLedger.get(handle.requestId);

    return {
      ok: true,
      value: {
        handle,
        state: record?.status === "cancelled" ? "cancelled" : "working",
        observedAt: now,
        correlationVerified: true
      }
    };
  }

  async *read(
    _handle: AgentExecutionHandle,
    _options?: AgentReadOptions
  ): AsyncIterable<OperationResult<AgentMessage>> {
    // Empty async generator
  }
}
