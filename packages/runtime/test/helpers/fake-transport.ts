import { randomUUID } from "node:crypto";
import type {
  AgentExecutionHandle,
  AgentMessage,
  AgentReadOptions,
  AgentReconciliationRequest,
  AgentReconciliationResult,
  AgentRequest,
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
} from "@bflow/contracts";

/**
 * Deterministic fake in-memory implementation of AgentTransport for integration testing.
 * Records all dispatched requests, cancellation handles, and reconciliation calls.
 * Provides custom hook intercepts for simulating transport errors, timeouts, or ambiguous delivery.
 */
export class FakeAgentTransport implements AgentTransport {
  sentRequests: AgentRequest[] = [];
  cancelledHandles: AgentExecutionHandle[] = [];
  reconciledRequests: AgentReconciliationRequest[] = [];

  customSendHandler?: (req: AgentRequest) => OperationResult<AgentSubmissionReceipt>;
  customReconcileHandler?: (req: AgentReconciliationRequest) => OperationResult<AgentReconciliationResult>;
  customCancelHandler?: (handle: AgentExecutionHandle, req: CancellationRequest) => OperationResult<CancellationResult>;
  customWaitHandler?: (handle: AgentExecutionHandle, options?: AgentWaitOptions) => OperationResult<AgentTransportObservation>;

  async initialize(
    _initialization: AgentTransportInitialization,
    _options?: OperationOptions
  ): Promise<OperationResult<AgentTransportCapabilities>> {
    return {
      ok: true,
      value: {
        transportName: "fake-agent-transport",
        protocolVersion: "1.0",
        supportsStreaming: true,
        supportsCancellation: true,
        supportsResume: true,
        supportsSubmissionCorrelation: true
      }
    };
  }

  async send(
    request: AgentRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<AgentSubmissionReceipt>> {
    this.sentRequests.push(request);
    if (this.customSendHandler) {
      return this.customSendHandler(request);
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
      acceptedAt: new Date().toISOString()
    };
    return {
      ok: true,
      value: {
        status: "accepted",
        requestId: request.requestId,
        attemptId: request.attemptId,
        runId: request.runId,
        taskId: request.taskId,
        observedAt: new Date().toISOString(),
        handle
      }
    };
  }

  async reconcile(
    request: AgentReconciliationRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<AgentReconciliationResult>> {
    this.reconciledRequests.push(request);
    if (this.customReconcileHandler) {
      return this.customReconcileHandler(request);
    }
    const executionId = `exec-recon-${randomUUID()}`;
    const handle: AgentExecutionHandle = {
      executionId,
      requestId: request.requestId,
      attemptId: request.attemptId,
      runId: request.runId,
      taskId: request.taskId,
      idempotencyKey: request.idempotencyKey,
      target: request.target,
      correlation: {
        token: request.requestId,
        provenance: "transport",
        verified: true
      },
      acceptedAt: new Date().toISOString()
    };
    return {
      ok: true,
      value: {
        status: "bound",
        handle
      }
    };
  }

  async cancel(
    handle: AgentExecutionHandle,
    request: CancellationRequest,
    _options?: OperationOptions
  ): Promise<OperationResult<CancellationResult>> {
    this.cancelledHandles.push(handle);
    if (this.customCancelHandler) {
      return this.customCancelHandler(handle, request);
    }
    return {
      ok: true,
      value: {
        status: "accepted",
        cancellationId: request.cancellationId,
        executionId: handle.executionId,
        observedAt: new Date().toISOString()
      }
    };
  }

  async wait(
    handle: AgentExecutionHandle,
    options?: AgentWaitOptions
  ): Promise<OperationResult<AgentTransportObservation>> {
    if (this.customWaitHandler) {
      return this.customWaitHandler(handle, options);
    }
    return {
      ok: true,
      value: {
        handle,
        state: "done",
        observedAt: new Date().toISOString(),
        correlationVerified: true
      }
    };
  }

  async *read(
    _handle: AgentExecutionHandle,
    _options?: AgentReadOptions
  ): AsyncIterable<OperationResult<AgentMessage>> {}

  getRequestForTask(taskId: string, attempt?: number): AgentRequest | undefined {
    return this.sentRequests.find(
      (r) => r.taskId === taskId && (attempt === undefined || r.attempt === attempt)
    );
  }

  reset(): void {
    this.sentRequests = [];
    this.cancelledHandles = [];
    this.reconciledRequests = [];
    this.customSendHandler = undefined;
    this.customReconcileHandler = undefined;
    this.customCancelHandler = undefined;
    this.customWaitHandler = undefined;
  }
}
