import { describe, expect, it } from "vitest";
import {
  EvaluateQualityGateCommandSchema,
  QualityGateEvaluationRequestedEventSchema,
  TaskTransitionCommandSchema,
  WorkflowDefinitionSchema,
  validateRunTransition,
  validateTaskTransition
} from "../src/index.js";
import { now, workflow } from "./fixtures.js";

describe("workflow definition", () => {
  it("accepts an acyclic graph with bounded concurrency", () => {
    const parsed = WorkflowDefinitionSchema.parse(
      workflow([
        { taskId: "build", dependsOnTaskId: "plan", condition: "succeeded" },
        { taskId: "review", dependsOnTaskId: "build", condition: "succeeded" }
      ])
    );
    expect(parsed.maxConcurrency).toBe(2);
  });

  it.each([
    ["missing dependency", [{ taskId: "build", dependsOnTaskId: "missing", condition: "succeeded" as const }]],
    [
      "cycle",
      [
        { taskId: "build", dependsOnTaskId: "review", condition: "succeeded" as const },
        { taskId: "review", dependsOnTaskId: "build", condition: "succeeded" as const }
      ]
    ],
    [
      "duplicate edge",
      [
        { taskId: "build", dependsOnTaskId: "plan", condition: "succeeded" as const },
        { taskId: "build", dependsOnTaskId: "plan", condition: "succeeded" as const }
      ]
    ]
  ])("rejects %s", (_name, dependencies) => {
    expect(WorkflowDefinitionSchema.safeParse(workflow(dependencies)).success).toBe(false);
  });

  it("rejects a task binding to an undeclared quality gate", () => {
    const candidate = workflow([]);
    candidate.tasks[0]!.qualityGates.push({ gateId: "missing", phase: "after_result", required: true });
    expect(WorkflowDefinitionSchema.safeParse(candidate).success).toBe(false);
  });

  it("binds a declared gate and validates its idempotent evaluation command/event", () => {
    const candidate = workflow([]);
    candidate.qualityGates.push({
      id: "tests",
      name: "Tests",
      evaluator: "vitest",
      required: true,
      timeout: { executionTimeoutMs: 60_000, onTimeout: "fail" }
    });
    candidate.tasks[1]!.qualityGates.push({ gateId: "tests", phase: "after_result", required: true });
    expect(WorkflowDefinitionSchema.safeParse(candidate).success).toBe(true);

    const command = {
      runId: "run-1",
      taskId: "build",
      evaluationId: "evaluation-1",
      gateId: "tests",
      attemptId: "attempt-1",
      expectedVersion: 5,
      idempotencyKey: "gate-evaluation-1",
      occurredAt: now
    };
    expect(EvaluateQualityGateCommandSchema.safeParse(command).success).toBe(true);
    expect(
      QualityGateEvaluationRequestedEventSchema.safeParse({
        schemaVersion: 1,
        eventId: "event-gate-1",
        runId: "run-1",
        taskId: "build",
        sequence: 6,
        aggregateVersion: 6,
        occurredAt: now,
        correlationId: "correlation-1",
        idempotencyKey: "gate-evaluation-1/event",
        type: "quality_gate.evaluation_requested",
        payload: { evaluationId: "evaluation-1", gateId: "tests", attemptId: "attempt-1" }
      }).success
    ).toBe(true);
  });
});

describe("legal transitions", () => {
  it("rejects succeeded to running without explicit rework", () => {
    expect(validateTaskTransition("succeeded", "running", "normal").valid).toBe(false);
    expect(
      TaskTransitionCommandSchema.safeParse({
        runId: "run-1",
        taskId: "build",
        expectedVersion: 4,
        from: "succeeded",
        to: "running",
        intent: "normal",
        generationFrom: 0,
        generationTo: 0,
        idempotencyKey: "invalid-transition",
        occurredAt: now
      }).success
    ).toBe(false);
  });

  it("allows explicit rework only with one generation increment", () => {
    expect(validateTaskTransition("succeeded", "ready", "rework", 1).valid).toBe(true);
    expect(validateTaskTransition("succeeded", "ready", "rework", 0).valid).toBe(false);
    expect(validateTaskTransition("running", "waiting", "normal", 1).valid).toBe(false);
  });

  it("models completion winning a cancellation race", () => {
    expect(validateTaskTransition("cancelling", "succeeded", "normal").valid).toBe(true);
    expect(validateRunTransition("cancelling", "succeeded").valid).toBe(true);
  });
});
