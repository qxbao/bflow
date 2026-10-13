import { describe, expect, it } from "vitest";
import {
  AgentRequestSchema,
  AgentResultSchema,
  DomainEventSchema,
  WorkflowDefinitionSchema
} from "../src/index.js";

const retry = {
  maxAttempts: 3,
  strategy: "exponential" as const,
  initialDelayMs: 100,
  maxDelayMs: 2_000,
  multiplier: 2,
  jitter: true
};

const timeout = {
  executionTimeoutMs: 60_000,
  heartbeatTimeoutMs: 10_000,
  onTimeout: "retry" as const
};

function workflow(dependencies: Array<{ taskId: string; dependsOnTaskId: string; condition: "succeeded" }>) {
  return {
    schemaVersion: "1" as const,
    id: "delivery",
    name: "Delivery workflow",
    version: "1.0.0",
    tasks: ["plan", "build", "review"].map((id) => ({
      id,
      title: id,
      role: id,
      instruction: `Perform ${id}`,
      acceptanceCriteria: ["completed"],
      retry,
      timeout,
      requiresApproval: false
    })),
    dependencies,
    maxConcurrency: 2,
    failurePolicy: "fail-fast" as const,
    recovery: {
      checkpoint: "task-boundary" as const,
      resumeStrategy: "checkpoint-then-replay" as const,
      staleExecution: "reconcile" as const
    }
  };
}

describe("WorkflowDefinitionSchema", () => {
  it("accepts an acyclic task graph", () => {
    const parsed = WorkflowDefinitionSchema.parse(
      workflow([
        { taskId: "build", dependsOnTaskId: "plan", condition: "succeeded" },
        { taskId: "review", dependsOnTaskId: "build", condition: "succeeded" }
      ])
    );

    expect(parsed.tasks).toHaveLength(3);
  });

  it("rejects missing dependency endpoints", () => {
    const result = WorkflowDefinitionSchema.safeParse(
      workflow([{ taskId: "build", dependsOnTaskId: "missing", condition: "succeeded" }])
    );

    expect(result.success).toBe(false);
  });

  it("rejects cyclic dependencies", () => {
    const result = WorkflowDefinitionSchema.safeParse(
      workflow([
        { taskId: "build", dependsOnTaskId: "review", condition: "succeeded" },
        { taskId: "review", dependsOnTaskId: "build", condition: "succeeded" }
      ])
    );

    expect(result.success).toBe(false);
  });

  it("rejects duplicate task ids", () => {
    const candidate = workflow([]);
    candidate.tasks[2] = { ...candidate.tasks[1]!, title: "duplicate" };

    expect(WorkflowDefinitionSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("agent exchange contracts", () => {
  it("accepts retry, timeout, and idempotency metadata", () => {
    const parsed = AgentRequestSchema.parse({
      requestId: "request-1",
      runId: "run-1",
      taskId: "build",
      role: "implementer",
      instruction: "Implement the selected task",
      inputs: [],
      attempt: 1,
      retry,
      timeout,
      idempotency: {
        key: "run-1/build/1",
        scope: "agent-request",
        fingerprint: "sha256:abc"
      }
    });

    expect(parsed.idempotency.scope).toBe("agent-request");
  });

  it("requires an error for failed agent results", () => {
    const result = AgentResultSchema.safeParse({
      requestId: "request-1",
      executionId: "execution-1",
      status: "failed",
      artifacts: [],
      retryable: true,
      startedAt: "2026-10-13T00:00:00.000Z",
      completedAt: "2026-10-13T00:01:00.000Z"
    });

    expect(result.success).toBe(false);
  });
});

describe("DomainEventSchema", () => {
  it("validates versioned and idempotent event envelopes", () => {
    const event = DomainEventSchema.parse({
      eventId: "event-1",
      runId: "run-1",
      sequence: 0,
      aggregateVersion: 0,
      occurredAt: "2026-10-13T00:00:00.000Z",
      correlationId: "correlation-1",
      idempotencyKey: "run-1/create",
      type: "run.created",
      payload: {
        workflowId: "delivery",
        workflowVersion: "1.0.0"
      }
    });

    expect(event.type).toBe("run.created");
  });
});
