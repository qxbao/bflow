import { describe, expect, it } from "vitest";
import {
  AgentLeaseSchema,
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  ArtifactProposalSchema,
  ArtifactReferenceSchema,
  CancellationRequestSchema,
  CancellationResultSchema,
  CancellationStopConfirmationSchema,
  ContractErrorSchema,
  RetryPolicySchema,
  RenewAgentLeaseRequestSchema
} from "../src/index.js";
import { artifactReference, later, now } from "./fixtures.js";

describe("approval lifecycle", () => {
  it("rejects a targetless approval request", () => {
    expect(
      ApprovalRequestSchema.safeParse({
        schemaVersion: 1,
        approvalId: "approval-1",
        runId: "run-1",
        revision: 1,
        generation: 0,
        requestedBy: "workflow-engine",
        requestedAt: now,
        reason: "review required",
        evidence: [],
        idempotencyKey: "approval-request-1"
      }).success
    ).toBe(false);
  });

  it("requires generation, revision, target and idempotency on decisions", () => {
    const decision = ApprovalDecisionSchema.parse({
      schemaVersion: 1,
      approvalId: "approval-1",
      runId: "run-1",
      target: { type: "task", taskId: "build" },
      revision: 2,
      generation: 1,
      decision: "changes_requested",
      decidedBy: "reviewer",
      decidedAt: later,
      reason: "add failure tests",
      feedbackArtifacts: [artifactReference],
      idempotencyKey: "approval-decision-2"
    });
    expect(decision.target.type).toBe("task");
  });
});

describe("artifact trust boundary", () => {
  it.each(["../secret", "nested/file", "nested\\file", ".", ".."]) (
    "rejects unsafe artifact identifier %s",
    (artifactId) => {
      expect(ArtifactReferenceSchema.safeParse({ ...artifactReference, artifactId }).success).toBe(false);
    }
  );

  it("rejects non-artifact URI schemes and malformed checksums", () => {
    expect(
      ArtifactReferenceSchema.safeParse({
        ...artifactReference,
        uri: "file:///tmp/artifact-1",
        checksum: { algorithm: "sha256", value: "abc" }
      }).success
    ).toBe(false);
  });

  it("rejects traversal-like or mismatched artifact URI segments", () => {
    expect(ArtifactReferenceSchema.safeParse({ ...artifactReference, uri: "artifact://../artifact-1" }).success).toBe(
      false
    );
    expect(
      ArtifactReferenceSchema.safeParse({ ...artifactReference, uri: "artifact://local/different-artifact" }).success
    ).toBe(false);
  });

  it("keeps an untrusted proposal distinct from a stored reference", () => {
    const proposal = ArtifactProposalSchema.parse({
      proposalId: "proposal-1",
      runId: "run-1",
      taskId: "build",
      kind: "report",
      logicalName: "result.md",
      mediaType: "text/markdown",
      expectedIntegrity: { checksum: artifactReference.checksum, sizeBytes: 4 }
    });
    expect("uri" in proposal).toBe(false);
    expect("trust" in proposal).toBe(false);
  });
});

describe("agent leases", () => {
  it("requires an increasing expiry and positive fencing token", () => {
    const lease = {
      leaseId: "lease-1",
      agentId: "agent-1",
      runId: "run-1",
      taskId: "build",
      attemptId: "attempt-1",
      fencingToken: 1,
      version: 0,
      acquiredAt: now,
      expiresAt: later
    };
    expect(AgentLeaseSchema.safeParse(lease).success).toBe(true);
    expect(AgentLeaseSchema.safeParse({ ...lease, fencingToken: 0 }).success).toBe(false);
    expect(AgentLeaseSchema.safeParse({ ...lease, expiresAt: now }).success).toBe(false);
  });

  it("requires lease version, fence and idempotency for renewal", () => {
    expect(
      RenewAgentLeaseRequestSchema.safeParse({
        leaseId: "lease-1",
        fencingToken: 3,
        expectedVersion: 2,
        ttlMs: 30_000,
        requestedAt: now,
        idempotencyKey: "renew-lease-1-v2"
      }).success
    ).toBe(true);
  });
});

describe("cancellation lifecycle and typed failures", () => {
  it("separates request, acceptance and confirmed stop", () => {
    expect(
      CancellationRequestSchema.safeParse({
        schemaVersion: 1,
        cancellationId: "cancel-1",
        runId: "run-1",
        taskId: "build",
        executionId: "execution-1",
        requestedBy: "operator",
        requestedAt: now,
        expectedVersion: 4,
        idempotencyKey: "cancel-run-1-build"
      }).success
    ).toBe(true);
    expect(
      CancellationResultSchema.safeParse({
        schemaVersion: 1,
        cancellationId: "cancel-1",
        status: "accepted",
        executionId: "execution-1",
        observedAt: now
      }).success
    ).toBe(true);
    expect(
      CancellationStopConfirmationSchema.safeParse({
        schemaVersion: 1,
        cancellationId: "cancel-1",
        executionId: "execution-1",
        stoppedAt: later,
        terminalStatus: "cancelled"
      }).success
    ).toBe(true);
  });

  it("enforces retryability semantics for unknown delivery", () => {
    expect(
      ContractErrorSchema.safeParse({
        code: "unknown_delivery",
        retryable: true,
        manualInterventionRequired: true,
        message: "delivery cannot be proven"
      }).success
    ).toBe(false);
    expect(
      ContractErrorSchema.safeParse({
        code: "unknown_delivery",
        retryable: false,
        manualInterventionRequired: true,
        message: "delivery cannot be proven"
      }).success
    ).toBe(true);
  });

  it("does not allow a retryable timeout without explicit retry safety", () => {
    expect(
      ContractErrorSchema.safeParse({ code: "timeout", retryable: true, message: "wait expired" }).success
    ).toBe(false);
    expect(
      ContractErrorSchema.safeParse({
        code: "timeout",
        retryable: true,
        retrySafety: "observation_only",
        message: "wait expired"
      }).success
    ).toBe(true);
  });
});

describe("retry policy refinements", () => {
  it.each([
    ["exponential without multiplier", { maxAttempts: 2, strategy: "exponential", initialDelayMs: 1, maxDelayMs: 2, jitter: false }],
    [
      "fixed with exponential multiplier",
      { maxAttempts: 2, strategy: "fixed", initialDelayMs: 1, maxDelayMs: 2, multiplier: 2, jitter: false }
    ],
    ["delay inversion", { maxAttempts: 2, strategy: "linear", initialDelayMs: 5, maxDelayMs: 2, jitter: false }]
  ])("rejects %s", (_name, policy) => {
    expect(RetryPolicySchema.safeParse(policy).success).toBe(false);
  });
});
