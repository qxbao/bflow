import { describe, expect, it } from "vitest";
import {
  AgentRequestSchema,
  AgentReconciliationResultSchema,
  AgentResultSchema,
  AgentExecutionBoundEventSchema,
  AgentSubmissionReceiptSchema,
  AgentTargetLocatorSchema,
  AgentTransportObservationSchema,
  RecordAgentResultCommandSchema,
  SubmissionCorrelationSchema
} from "../src/index.js";
import { correlation, handle, later, now, retry, target, timeout } from "./fixtures.js";

describe("agent transport boundary", () => {
  it("requires a durable target locator", () => {
    expect(AgentTargetLocatorSchema.safeParse({ transport: "herdr", agentId: "agent-1" }).success).toBe(false);
    expect(AgentTargetLocatorSchema.safeParse(target).success).toBe(true);
  });

  it("rejects falsely verified orchestrator correlation", () => {
    expect(
      SubmissionCorrelationSchema.safeParse({
        token: "local-token",
        provenance: "orchestrator",
        verified: true
      }).success
    ).toBe(false);
  });

  it("represents unknown prompt delivery and forbids resend before reconciliation", () => {
    const receipt = AgentSubmissionReceiptSchema.parse({
      status: "unknown_delivery",
      requestId: "request-1",
      attemptId: "attempt-1",
      runId: "run-1",
      taskId: "build",
      idempotencyKey: "run-1/build/1",
      target,
      observedAt: now,
      reason: "connection closed after write",
      resendAllowed: false,
      manualInterventionRequired: true
    });
    expect(receipt.status).toBe("unknown_delivery");
    expect(receipt.resendAllowed).toBe(false);
    expect(
      AgentReconciliationResultSchema.parse({
        status: "unknown_delivery",
        requestId: "request-1",
        retrySafe: false,
        observedAt: later,
        reason: "transport has no prompt correlation",
        manualInterventionRequired: true
      })
    ).toMatchObject({ retrySafe: false, manualInterventionRequired: true });
  });

  it("keeps Herdr done as transport state rather than task success", () => {
    const observation = AgentTransportObservationSchema.parse({
      handle,
      state: "done",
      observedAt: later,
      stateChangeSequence: 7,
      targetRevision: 12,
      correlationVerified: false
    });
    expect(observation.state).toBe("done");
    expect("status" in observation).toBe(false);
  });

  it("persists a versioned execution binding with run/task/attempt identity", () => {
    const event = AgentExecutionBoundEventSchema.parse({
      schemaVersion: 1,
      eventId: "event-bind-1",
      runId: "run-1",
      taskId: "build",
      sequence: 3,
      aggregateVersion: 3,
      occurredAt: now,
      correlationId: "request-1",
      idempotencyKey: "bind-execution-1",
      type: "agent.execution_bound",
      payload: { handle, attempt: 1 }
    });
    expect(event.payload.handle.target.paneId).toBe("pane-1");
  });

  it("requires attempt identity, target, time, and agent-request idempotency scope", () => {
    const request = AgentRequestSchema.parse({
      requestId: "request-1",
      attemptId: "attempt-1",
      runId: "run-1",
      taskId: "build",
      role: "implementer",
      target,
      instruction: "Implement the task",
      inputs: [],
      attempt: 1,
      retry,
      timeout,
      idempotency: { key: "run-1/build/1", scope: "agent-request", fingerprint: "sha256:abc" },
      createdAt: now
    });
    expect(request.attemptId).toBe("attempt-1");
  });
});

describe("verified task outcome", () => {
  const unverifiedResult = {
    requestId: "request-1",
    attemptId: "attempt-1",
    runId: "run-1",
    taskId: "build",
    executionId: "execution-1",
    status: "unverified" as const,
    verification: {
      status: "unverified" as const,
      reason: "Herdr 0.9.1 has no turn correlation",
      manualInterventionRequired: true
    },
    artifactProposals: [],
    retryable: false,
    startedAt: now,
    completedAt: later
  };

  it("allows an unverified observation but not recording it as a task result", () => {
    expect(AgentResultSchema.safeParse(unverifiedResult).success).toBe(true);
    expect(
      RecordAgentResultCommandSchema.safeParse({
        runId: "run-1",
        taskId: "build",
        expectedVersion: 3,
        result: unverifiedResult,
        idempotencyKey: "record-result-1",
        occurredAt: later
      }).success
    ).toBe(false);
  });

  it("rejects a successful result without verified correlation", () => {
    expect(AgentResultSchema.safeParse({ ...unverifiedResult, status: "succeeded" }).success).toBe(false);
  });

  it("rejects reversed result timestamps", () => {
    expect(
      AgentResultSchema.safeParse({
        ...unverifiedResult,
        status: "succeeded",
        verification: { status: "verified", evidence: "structured agent response", correlation },
        startedAt: later,
        completedAt: now
      }).success
    ).toBe(false);
  });

  it("requires failed errors and consistent retryability", () => {
    const verifiedFailure = {
      ...unverifiedResult,
      status: "failed" as const,
      verification: { status: "verified" as const, evidence: "structured agent response", correlation },
      retryable: true
    };
    expect(AgentResultSchema.safeParse(verifiedFailure).success).toBe(false);
    expect(
      AgentResultSchema.safeParse({
        ...verifiedFailure,
        error: { code: "build_failed", message: "build failed", retryable: false }
      }).success
    ).toBe(false);
    expect(
      AgentResultSchema.safeParse({
        ...verifiedFailure,
        error: { code: "build_failed", message: "build failed", retryable: true }
      }).success
    ).toBe(true);
  });
});
