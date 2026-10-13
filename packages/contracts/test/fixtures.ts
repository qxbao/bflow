export const now = "2026-10-13T00:00:00.000Z";
export const later = "2026-10-13T00:01:00.000Z";

export const retry = {
  maxAttempts: 3,
  strategy: "exponential" as const,
  initialDelayMs: 100,
  maxDelayMs: 2_000,
  multiplier: 2,
  jitter: true
};

export const timeout = {
  executionTimeoutMs: 60_000,
  heartbeatTimeoutMs: 10_000,
  onTimeout: "retry" as const
};

export const target = {
  transport: "herdr",
  agentId: "implementer-1",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-1",
  terminalId: "terminal-1",
  session: { source: "agent", kind: "id" as const, value: "session-1" },
  worktreeId: "worktree-1",
  worktreePath: "/worktrees/run-1-build"
};

export const correlation = {
  token: "remote-turn-1",
  provenance: "remote" as const,
  verified: true
};

export const handle = {
  executionId: "execution-1",
  requestId: "request-1",
  attemptId: "attempt-1",
  runId: "run-1",
  taskId: "build",
  idempotencyKey: "run-1/build/1",
  target,
  correlation,
  acceptedAt: now
};

export const artifactReference = {
  trust: "stored" as const,
  artifactId: "artifact-1",
  runId: "run-1",
  taskId: "build",
  kind: "report" as const,
  uri: "artifact://local/artifact-1",
  mediaType: "text/markdown",
  sizeBytes: 4,
  checksum: { algorithm: "sha256" as const, value: "a".repeat(64) },
  createdAt: now
};

export function workflow(
  dependencies: Array<{
    taskId: string;
    dependsOnTaskId: string;
    condition: "succeeded" | "completed";
  }>
) {
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
      requiresApproval: false,
      qualityGates: []
    })),
    dependencies,
    qualityGates: [],
    maxConcurrency: 2,
    failurePolicy: "fail-fast" as const,
    recovery: {
      checkpoint: "task-boundary" as const,
      resumeStrategy: "checkpoint-then-replay" as const,
      staleExecution: "reconcile" as const
    }
  };
}

export function runCreatedEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    eventId: "event-1",
    runId: "run-1",
    sequence: 1,
    aggregateVersion: 1,
    occurredAt: now,
    correlationId: "correlation-1",
    idempotencyKey: "run-1/create",
    type: "run.created" as const,
    payload: { workflowId: "delivery", workflowVersion: "1.0.0" },
    ...overrides
  };
}
