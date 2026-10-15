import { describe, expect, it } from "vitest";
import {
  CommandReceiptSchema,
  RecoveryCheckpointSchema,
  ReworkPolicySchema,
  WorkflowAggregateCheckpointStateSchema,
  WorkflowDefinitionSchema,
  decodeWorkflowAggregateCheckpointState,
  fingerprintWorkflowCommand,
  parseRecoveryCheckpointWithCompatibility
} from "../src/index.js";
import { now, workflow } from "./fixtures.js";

const snapshot = {
  runId: "run-1", workflowId: "delivery", workflowVersion: "1.0.0", status: "queued",
  tasks: ["plan", "build", "review"].map((taskId) => ({
    taskId, status: "pending", attempt: 0, generation: 0, version: 0
  })),
  createdAt: now, updatedAt: now, version: 2, lastEventSequence: 2
};
const aggregate = {
  schemaVersion: 1, snapshot, approvals: [], gateRequests: [], gateOutcomes: [],
  successfulAttempts: [], cancellations: [], retrySchedules: [], attemptBaselines: [], commands: []
};
const checkpoint = {
  checkpointSchemaVersion: 1, codec: { name: "bflow.workflow-aggregate+json", version: 1 },
  checkpointId: "checkpoint-1", runId: "run-1", eventSequence: 2, version: 2,
  state: aggregate, createdAt: now
};

describe("P01 remediation contracts", () => {
  it("validates rework boundaries and accepts legacy definitions without silently granting rework", () => {
    expect(ReworkPolicySchema.parse({ maxReworks: 0, onExhausted: "fail" }).maxReworks).toBe(0);
    expect(ReworkPolicySchema.parse({ maxReworks: 2, onExhausted: "require_human" }).maxReworks).toBe(2);
    for (const maxReworks of [-1, 1.5]) {
      expect(ReworkPolicySchema.safeParse({ maxReworks, onExhausted: "fail" }).success).toBe(false);
    }
    expect(ReworkPolicySchema.safeParse({ maxReworks: 1, onExhausted: "ignore" }).success).toBe(false);
    expect(WorkflowDefinitionSchema.parse(workflow([])).tasks[0]?.rework).toBeUndefined();
  });

  it("hashes canonical commands without storing their payload in receipts", () => {
    const first = fingerprintWorkflowCommand("advance", { runId: "run-1", expectedVersion: 1 });
    const reordered = fingerprintWorkflowCommand("advance", { expectedVersion: 1, runId: "run-1" });
    const changed = fingerprintWorkflowCommand("advance", { runId: "run-1", expectedVersion: 2 });
    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
    const receipt = { schemaVersion: 1, commandId: "command-1", idempotencyKey: "key-1",
      operation: "advance", fingerprint: first, firstEventSequence: 2, runnableTaskIds: ["build"] };
    expect(CommandReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(CommandReceiptSchema.safeParse({ ...receipt, fingerprint: "raw secret" }).success).toBe(false);
    expect(CommandReceiptSchema.safeParse({ ...receipt, schemaVersion: 9 }).success).toBe(false);
    expect(CommandReceiptSchema.safeParse({ ...receipt, idempotencyKey: "" }).success).toBe(false);
  });

  it("decodes complete aggregate checkpoints and rejects missing or inconsistent state", () => {
    const parsed = RecoveryCheckpointSchema.parse(checkpoint);
    expect(decodeWorkflowAggregateCheckpointState(parsed)).toMatchObject({ ok: true });
    const missing = RecoveryCheckpointSchema.parse({ ...checkpoint, state: { schemaVersion: 1 } });
    expect(decodeWorkflowAggregateCheckpointState(missing)).toMatchObject({ ok: false, error: { code: "corruption" } });
    const duplicate = { ...aggregate, snapshot: { ...snapshot, tasks: [...snapshot.tasks, snapshot.tasks[0]] } };
    expect(WorkflowAggregateCheckpointStateSchema.safeParse(duplicate).success).toBe(false);
    expect(parseRecoveryCheckpointWithCompatibility({ ...checkpoint, checkpointSchemaVersion: 9 }))
      .toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    expect(decodeWorkflowAggregateCheckpointState(RecoveryCheckpointSchema.parse({
      ...checkpoint, codec: { name: "bflow.workflow-run-snapshot+json", version: 1 }
    }))).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("stores distinct per-execution stop confirmations for run-wide cancellation", () => {
    const request = { schemaVersion: 1, cancellationId: "cancel-run", runId: "run-1",
      requestedBy: "user", requestedAt: now, expectedVersion: 2, idempotencyKey: "cancel-key" };
    const confirmation = (executionId: string) => ({ schemaVersion: 1, cancellationId: "cancel-run",
      executionId, stoppedAt: now, terminalStatus: "cancelled" });
    const state = { ...aggregate, cancellations: [{ request,
      confirmations: [confirmation("ex-A"), confirmation("ex-B")] }] };
    expect(WorkflowAggregateCheckpointStateSchema.safeParse(state).success).toBe(true);
    expect(WorkflowAggregateCheckpointStateSchema.safeParse({ ...state,
      cancellations: [{ request, confirmations: [confirmation("ex-A"), confirmation("ex-A")] }] }).success).toBe(false);
    expect(WorkflowAggregateCheckpointStateSchema.safeParse({ ...state,
      cancellations: [{ request, confirmation: confirmation("ex-A") }] }).success).toBe(false);
  });
});
