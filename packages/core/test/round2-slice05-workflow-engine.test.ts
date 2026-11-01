import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AgentExecutionHandle,
  AgentResult,
  DomainEvent,
  OperationResult,
  WorkflowAdvanceResult,
  WorkflowDefinition
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "../src/index.js";

const t0 = "2026-10-31T00:00:00.000Z";
const t1 = "2026-10-31T00:00:01.000Z";
const t2 = "2026-10-31T00:00:02.000Z";
const t3 = "2026-10-31T00:00:03.000Z";

function unwrap<T>(res: OperationResult<T>): T {
  if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
  return res.value;
}

function makeHandle(state: WorkflowAdvanceResult, taskId: string, suffix = "1"): AgentExecutionHandle {
  const task = state.snapshot.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task?.attemptId) throw new Error(`Task ${taskId} has no attemptId`);
  return {
    executionId: `exec-${taskId}-${suffix}`,
    requestId: `req-${taskId}-${suffix}`,
    attemptId: task.attemptId,
    runId: state.snapshot.runId,
    taskId,
    idempotencyKey: `dispatch/${taskId}/${suffix}`,
    target: { transport: "herdr", agentId: `agent-${taskId}`, paneId: `pane-${taskId}` },
    correlation: { token: `tok-${taskId}-${suffix}`, provenance: "remote", verified: true },
    acceptedAt: t1
  };
}

function makeAgentResult(handle: AgentExecutionHandle, status: AgentResult["status"]): AgentResult {
  return {
    requestId: handle.requestId,
    attemptId: handle.attemptId,
    runId: handle.runId,
    taskId: handle.taskId,
    executionId: handle.executionId,
    status,
    verification: { status: "verified", evidence: "verified-receipt", correlation: handle.correlation },
    artifactProposals: [],
    retryable: false,
    startedAt: t1,
    completedAt: t2,
    ...(status === "failed" ? { error: { code: "fatal_err", message: "failed", retryable: false } } : {})
  } as AgentResult;
}

describe("Round 2 Slice 5 core workflow engine & DAG hardening", () => {
  it("terminates ready tasks cleanly when a required before_dispatch quality gate fails instead of wedging the run in running forever, and replays deterministically", async () => {
    const def: WorkflowDefinition = {
      schemaVersion: "1",
      id: "pre-gate-fail",
      name: "Pre-gate Failure",
      version: "1.0.0",
      tasks: [
        {
          id: "A",
          title: "Task A",
          role: "developer",
          instruction: "Do A",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 5_000, onTimeout: "fail" },
          requiresApproval: false,
          qualityGates: [{ gateId: "pre-check", phase: "before_dispatch", required: true }]
        },
        {
          id: "B",
          title: "Task B",
          role: "developer",
          instruction: "Do B",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 5_000, onTimeout: "fail" },
          requiresApproval: false,
          qualityGates: []
        }
      ],
      dependencies: [{ taskId: "B", dependsOnTaskId: "A", condition: "succeeded" }],
      qualityGates: [
        {
          id: "pre-check",
          name: "Pre-dispatch Check",
          evaluator: "preflight",
          required: true,
          timeout: { executionTimeoutMs: 1_000, onTimeout: "fail" }
        }
      ],
      maxConcurrency: 2,
      failurePolicy: "continue-independent",
      recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
    };

    const engine = new DeterministicWorkflowEngine({ definitions: [def] });
    const history: DomainEvent[] = [];

    let state = unwrap(await engine.createRun({ runId: "run-pre", definition: def, idempotencyKey: "create", createdAt: t0 }));
    history.push(...state.emittedEvents);

    state = unwrap(await engine.advance({ runId: "run-pre", expectedVersion: state.snapshot.version, idempotencyKey: "adv-1", occurredAt: t1 }));
    history.push(...state.emittedEvents);
    expect(state.snapshot.tasks.find((t) => t.taskId === "A")?.status).toBe("ready");

    state = unwrap(
      await engine.requestQualityGateEvaluation({
        runId: "run-pre",
        taskId: "A",
        gateId: "pre-check",
        evaluationId: "eval-pre-1",
        expectedVersion: state.snapshot.version,
        idempotencyKey: "req-pre",
        occurredAt: t1
      })
    );
    history.push(...state.emittedEvents);

    state = unwrap(
      await engine.recordQualityGateResult({
        expectedVersion: state.snapshot.version,
        idempotencyKey: "res-pre",
        result: {
          runId: "run-pre",
          taskId: "A",
          gateId: "pre-check",
          evaluationId: "eval-pre-1",
          status: "failed",
          findings: [{ code: "preflight_failed", severity: "error", message: "blocked before dispatch" }],
          producedArtifacts: [],
          evaluatedAt: t2
        }
      })
    );
    history.push(...state.emittedEvents);
    expect(state.snapshot.tasks.find((t) => t.taskId === "A")?.status).toBe("cancelled");

    const checkpoint = unwrap(
      await engine.createCheckpoint({
        runId: "run-pre",
        expectedVersion: state.snapshot.version,
        checkpointId: "cp-pre",
        createdAt: t2
      })
    );

    state = unwrap(await engine.advance({ runId: "run-pre", expectedVersion: state.snapshot.version, idempotencyKey: "adv-2", occurredAt: t3 }));
    history.push(...state.emittedEvents);
    expect(state.snapshot.tasks.find((t) => t.taskId === "B")?.status).toBe("cancelled");
    expect(state.snapshot.status).toBe("failed");

    // Verify full replay and checkpoint+tail equivalence
    const fullReplay = new DeterministicWorkflowEngine({ definitions: [def] });
    const tailReplay = new DeterministicWorkflowEngine({ definitions: [def] });
    const fullRecovered = unwrap(await fullReplay.recover({ runId: "run-pre", events: history, expectedVersion: state.snapshot.version }));
    const tailRecovered = unwrap(
      await tailReplay.recover({
        runId: "run-pre",
        checkpoint,
        events: history.filter((e) => e.sequence > checkpoint.eventSequence),
        expectedVersion: state.snapshot.version
      })
    );
    expect(fullRecovered.snapshot).toEqual(state.snapshot);
    expect(tailRecovered.snapshot).toEqual(state.snapshot);
  });

  it("preserves before_dispatch gate satisfaction across blocked -> running resumption and full/checkpoint event replay", async () => {
    const def: WorkflowDefinition = {
      schemaVersion: "1",
      id: "pre-and-post-gate",
      name: "Pre and Post Gate",
      version: "1.0.0",
      tasks: [
        {
          id: "A",
          title: "Task A",
          role: "developer",
          instruction: "Do A",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 5_000, onTimeout: "fail" },
          requiresApproval: false,
          qualityGates: [
            { gateId: "pre-check", phase: "before_dispatch", required: true },
            { gateId: "post-check", phase: "after_result", required: true }
          ]
        }
      ],
      dependencies: [],
      qualityGates: [
        { id: "pre-check", name: "Pre", evaluator: "pre", required: true, timeout: { executionTimeoutMs: 1_000, onTimeout: "fail" } },
        { id: "post-check", name: "Post", evaluator: "post", required: true, timeout: { executionTimeoutMs: 1_000, onTimeout: "fail" } }
      ],
      maxConcurrency: 1,
      failurePolicy: "continue-independent",
      recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
    };

    const engine = new DeterministicWorkflowEngine({ definitions: [def] });
    const history: DomainEvent[] = [];

    let state = unwrap(await engine.createRun({ runId: "run-resume", definition: def, idempotencyKey: "create", createdAt: t0 }));
    history.push(...state.emittedEvents);

    state = unwrap(await engine.advance({ runId: "run-resume", expectedVersion: state.snapshot.version, idempotencyKey: "adv-ready", occurredAt: t1 }));
    history.push(...state.emittedEvents);

    state = unwrap(
      await engine.requestQualityGateEvaluation({
        runId: "run-resume",
        taskId: "A",
        gateId: "pre-check",
        evaluationId: "eval-pre",
        expectedVersion: state.snapshot.version,
        idempotencyKey: "req-pre",
        occurredAt: t1
      })
    );
    history.push(...state.emittedEvents);

    state = unwrap(
      await engine.recordQualityGateResult({
        expectedVersion: state.snapshot.version,
        idempotencyKey: "res-pre",
        result: {
          runId: "run-resume",
          taskId: "A",
          gateId: "pre-check",
          evaluationId: "eval-pre",
          status: "passed",
          findings: [],
          producedArtifacts: [],
          evaluatedAt: t1
        }
      })
    );
    history.push(...state.emittedEvents);

    state = unwrap(await engine.advance({ runId: "run-resume", expectedVersion: state.snapshot.version, idempotencyKey: "adv-run", occurredAt: t1 }));
    history.push(...state.emittedEvents);
    expect(state.snapshot.tasks[0]?.status).toBe("running");

    const h = makeHandle(state, "A");
    state = unwrap(
      await engine.bindAgentExecution({
        runId: "run-resume",
        taskId: "A",
        attempt: 1,
        handle: h,
        expectedVersion: state.snapshot.version,
        idempotencyKey: "bind-A",
        occurredAt: t1
      })
    );
    history.push(...state.emittedEvents);

    // Agent reports external blockage while post-check is still pending, then resumes blocked -> running
    state = unwrap(
      await engine.recordAgentResult({
        runId: "run-resume",
        taskId: "A",
        expectedVersion: state.snapshot.version,
        idempotencyKey: "res-blocked",
        occurredAt: t2,
        result: {
          ...makeAgentResult(h, "blocked"),
          retryable: true,
          blockage: { code: "external_dependency", message: "waiting on service", since: t2, retryable: true }
        }
      })
    );
    history.push(...state.emittedEvents);
    expect(state.snapshot.tasks[0]?.status).toBe("blocked");

    state = unwrap(
      await engine.transitionTask({
        runId: "run-resume",
        taskId: "A",
        from: "blocked",
        to: "running",
        intent: "normal",
        generationFrom: 0,
        generationTo: 0,
        expectedVersion: state.snapshot.version,
        idempotencyKey: "unblock-A",
        occurredAt: t3
      })
    );
    history.push(...state.emittedEvents);
    expect(state.snapshot.tasks[0]?.status).toBe("running");

    const replayEngine = new DeterministicWorkflowEngine({ definitions: [def] });
    const recovered = unwrap(await replayEngine.recover({ runId: "run-resume", events: history, expectedVersion: state.snapshot.version }));
    expect(recovered.snapshot).toEqual(state.snapshot);
  });

  it("cancels an already-ready dependent task when its prerequisite approval is superseded/reworked and permanently fails, and enforces fail-fast on approval rejection", async () => {
    // 1. Multi-branch DAG where B becomes ready after A gen-0 approval, while X occupies maxConcurrency=1, then A rev-2 rejects
    const diamondDef: WorkflowDefinition = {
      schemaVersion: "1",
      id: "ready-dep-invalidation",
      name: "Ready Dependent Invalidation",
      version: "1.0.0",
      tasks: [
        {
          id: "A",
          title: "A",
          role: "developer",
          instruction: "Do A",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          rework: { maxReworks: 0, onExhausted: "fail" },
          timeout: { executionTimeoutMs: 5_000, onTimeout: "fail" },
          requiresApproval: true,
          qualityGates: []
        },
        {
          id: "X",
          title: "X",
          role: "developer",
          instruction: "Do X",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 5_000, onTimeout: "fail" },
          requiresApproval: false,
          qualityGates: []
        },
        {
          id: "B",
          title: "B",
          role: "developer",
          instruction: "Do B",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 5_000, onTimeout: "fail" },
          requiresApproval: false,
          qualityGates: []
        }
      ],
      dependencies: [{ taskId: "B", dependsOnTaskId: "A", condition: "succeeded" }],
      qualityGates: [],
      maxConcurrency: 1,
      failurePolicy: "continue-independent",
      recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
    };

    const engine = new DeterministicWorkflowEngine({ definitions: [diamondDef] });
    let state = unwrap(await engine.createRun({ runId: "run-diamond", definition: diamondDef, idempotencyKey: "c", createdAt: t0 }));
    state = unwrap(await engine.advance({ runId: "run-diamond", expectedVersion: state.snapshot.version, idempotencyKey: "adv-1", occurredAt: t1 }));
    // A runs first (maxConcurrency=1), X is ready, B is pending
    const hA = makeHandle(state, "A");
    state = unwrap(await engine.bindAgentExecution({ runId: "run-diamond", taskId: "A", attempt: 1, handle: hA, expectedVersion: state.snapshot.version, idempotencyKey: "bind-A", occurredAt: t1 }));
    state = unwrap(await engine.recordAgentResult({ runId: "run-diamond", taskId: "A", expectedVersion: state.snapshot.version, result: makeAgentResult(hA, "succeeded"), idempotencyKey: "res-A", occurredAt: t1 }));

    // Approve A at revision 1
    state = unwrap(
      await engine.requestApproval({
        expectedVersion: state.snapshot.version,
        idempotencyKey: "req-app-1",
        request: {
          schemaVersion: 1,
          approvalId: "app-1",
          runId: "run-diamond",
          target: { type: "task", taskId: "A" },
          revision: 1,
          generation: 0,
          requestedBy: "runtime",
          requestedAt: t1,
          reason: "review",
          evidence: [],
          idempotencyKey: "app-req-1"
        }
      })
    );
    state = unwrap(
      await engine.applyApproval({
        expectedVersion: state.snapshot.version,
        idempotencyKey: "dec-app-1",
        decision: {
          schemaVersion: 1,
          approvalId: "app-1",
          runId: "run-diamond",
          target: { type: "task", taskId: "A" },
          revision: 1,
          generation: 0,
          decision: "approved",
          decidedBy: "human",
          decidedAt: t1,
          feedbackArtifacts: [],
          idempotencyKey: "app-dec-1"
        }
      })
    );

    // Advance launches X (occupying maxConcurrency=1) and promotes B pending -> ready!
    state = unwrap(await engine.advance({ runId: "run-diamond", expectedVersion: state.snapshot.version, idempotencyKey: "adv-2", occurredAt: t2 }));
    expect(state.snapshot.tasks.find((t) => t.taskId === "X")?.status).toBe("running");
    expect(state.snapshot.tasks.find((t) => t.taskId === "B")?.status).toBe("ready");

    // Superseding revision-2 approval rejects A while X is running and B is already ready
    state = unwrap(
      await engine.requestApproval({
        expectedVersion: state.snapshot.version,
        idempotencyKey: "req-app-2",
        request: {
          schemaVersion: 1,
          approvalId: "app-2",
          runId: "run-diamond",
          target: { type: "task", taskId: "A" },
          revision: 2,
          generation: 0,
          requestedBy: "runtime",
          requestedAt: t2,
          reason: "security regression spotted",
          evidence: [],
          idempotencyKey: "app-req-2"
        }
      })
    );
    state = unwrap(
      await engine.applyApproval({
        expectedVersion: state.snapshot.version,
        idempotencyKey: "dec-app-2",
        decision: {
          schemaVersion: 1,
          approvalId: "app-2",
          runId: "run-diamond",
          target: { type: "task", taskId: "A" },
          revision: 2,
          generation: 0,
          decision: "rejected",
          reason: "security regression spotted",
          decidedBy: "human",
          decidedAt: t2,
          feedbackArtifacts: [],
          idempotencyKey: "app-dec-2"
        }
      })
    );

    // X finishes cleanly; advance must cancel ready B and transition run to failed (never wedged in running!)
    const hX = makeHandle(state, "X");
    state = unwrap(await engine.bindAgentExecution({ runId: "run-diamond", taskId: "X", attempt: 1, handle: hX, expectedVersion: state.snapshot.version, idempotencyKey: "bind-X", occurredAt: t2 }));
    state = unwrap(await engine.recordAgentResult({ runId: "run-diamond", taskId: "X", expectedVersion: state.snapshot.version, result: makeAgentResult(hX, "succeeded"), idempotencyKey: "res-X", occurredAt: t2 }));
    state = unwrap(await engine.advance({ runId: "run-diamond", expectedVersion: state.snapshot.version, idempotencyKey: "adv-3", occurredAt: t3 }));

    expect(state.snapshot.tasks.find((t) => t.taskId === "B")?.status).toBe("cancelled");
    expect(state.snapshot.status).toBe("failed");

    // 2. Under failurePolicy: "fail-fast", rejected approval on A must cancel queued ready sibling X instead of launching X
    const failFastDef: WorkflowDefinition = { ...diamondDef, id: "fail-fast-approval", dependencies: [], tasks: diamondDef.tasks.slice(0, 2), failurePolicy: "fail-fast" };
    const ffEngine = new DeterministicWorkflowEngine({ definitions: [failFastDef] });
    let ff = unwrap(await ffEngine.createRun({ runId: "run-ff", definition: failFastDef, idempotencyKey: "c", createdAt: t0 }));
    ff = unwrap(await ffEngine.advance({ runId: "run-ff", expectedVersion: ff.snapshot.version, idempotencyKey: "adv-1", occurredAt: t1 }));
    const ffHandleA = makeHandle(ff, "A");
    ff = unwrap(await ffEngine.bindAgentExecution({ runId: "run-ff", taskId: "A", attempt: 1, handle: ffHandleA, expectedVersion: ff.snapshot.version, idempotencyKey: "bind-A", occurredAt: t1 }));
    ff = unwrap(await ffEngine.recordAgentResult({ runId: "run-ff", taskId: "A", expectedVersion: ff.snapshot.version, result: makeAgentResult(ffHandleA, "succeeded"), idempotencyKey: "res-A", occurredAt: t1 }));
    ff = unwrap(
      await ffEngine.requestApproval({
        expectedVersion: ff.snapshot.version,
        idempotencyKey: "req-ff",
        request: {
          schemaVersion: 1,
          approvalId: "app-ff",
          runId: "run-ff",
          target: { type: "task", taskId: "A" },
          revision: 1,
          generation: 0,
          requestedBy: "runtime",
          requestedAt: t2,
          reason: "review",
          evidence: [],
          idempotencyKey: "app-req-ff"
        }
      })
    );
    ff = unwrap(
      await ffEngine.applyApproval({
        expectedVersion: ff.snapshot.version,
        idempotencyKey: "dec-ff",
        decision: {
          schemaVersion: 1,
          approvalId: "app-ff",
          runId: "run-ff",
          target: { type: "task", taskId: "A" },
          revision: 1,
          generation: 0,
          decision: "rejected",
          reason: "security regression spotted",
          decidedBy: "human",
          decidedAt: t2,
          feedbackArtifacts: [],
          idempotencyKey: "app-dec-ff"
        }
      })
    );
    ff = unwrap(await ffEngine.advance({ runId: "run-ff", expectedVersion: ff.snapshot.version, idempotencyKey: "adv-2", occurredAt: t3 }));
    expect(ff.runnableTaskIds).toEqual([]);
    expect(ff.snapshot.tasks.find((t) => t.taskId === "X")?.status).toBe("cancelled");
    expect(ff.snapshot.status).toBe("failed");
  });

  it("promotes boundedVerificationRetry quality-gate retries with delay === 0 immediately from retrying to ready and replays identically", async () => {
    const def: WorkflowDefinition = {
      schemaVersion: "1",
      id: "bounded-verification-retry-zero-delay",
      name: "Bounded Verification Retry Zero Delay",
      version: "1.0.0",
      tasks: [
        {
          id: "A",
          title: "Task A",
          role: "developer",
          instruction: "Do A",
          acceptanceCriteria: ["ac-1"],
          retry: { maxAttempts: 2, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 5_000, onTimeout: "fail" },
          requiresApproval: false,
          qualityGates: [{ gateId: "p19-independent-task-verification", phase: "before_completion", required: true }]
        }
      ],
      dependencies: [],
      qualityGates: [
        {
          id: "p19-independent-task-verification",
          name: "Independent task verification",
          evaluator: "p19-verification",
          required: true,
          timeout: { executionTimeoutMs: 30_000, onTimeout: "block" },
          metadata: { boundedVerificationRetry: true }
        }
      ],
      maxConcurrency: 1,
      failurePolicy: "fail-fast",
      recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" }
    };

    const engine = new DeterministicWorkflowEngine({ definitions: [def] });
    const history: DomainEvent[] = [];
    let state = unwrap(await engine.createRun({ runId: "run-bvr", definition: def, idempotencyKey: "c", createdAt: t0 }));
    history.push(...state.emittedEvents);
    state = unwrap(await engine.advance({ runId: "run-bvr", expectedVersion: state.snapshot.version, idempotencyKey: "adv-1", occurredAt: t1 }));
    history.push(...state.emittedEvents);
    const h1 = makeHandle(state, "A", "1");
    state = unwrap(await engine.bindAgentExecution({ runId: "run-bvr", taskId: "A", attempt: 1, handle: h1, expectedVersion: state.snapshot.version, idempotencyKey: "bind-1", occurredAt: t1 }));
    history.push(...state.emittedEvents);
    state = unwrap(await engine.recordAgentResult({ runId: "run-bvr", taskId: "A", expectedVersion: state.snapshot.version, result: makeAgentResult(h1, "succeeded"), idempotencyKey: "res-1", occurredAt: t2 }));
    history.push(...state.emittedEvents);
    state = unwrap(await engine.requestQualityGateEvaluation({
      runId: "run-bvr",
      taskId: "A",
      attemptId: h1.attemptId,
      gateId: "p19-independent-task-verification",
      evaluationId: "eval-bvr-1",
      expectedVersion: state.snapshot.version,
      idempotencyKey: "req-bvr-1",
      occurredAt: t2
    }));
    history.push(...state.emittedEvents);
    state = unwrap(await engine.recordQualityGateResult({
      expectedVersion: state.snapshot.version,
      idempotencyKey: "gate-res-bvr-1",
      result: {
        runId: "run-bvr",
        taskId: "A",
        gateId: "p19-independent-task-verification",
        evaluationId: "eval-bvr-1",
        status: "failed",
        findings: [{ code: "rework_needed", severity: "error", message: "fix edge case" }],
        producedArtifacts: [],
        evaluatedAt: t2,
        metadata: { independentVerification: true }
      }
    }));
    history.push(...state.emittedEvents);
    expect(state.snapshot.tasks[0]?.status).toBe("ready");

    state = unwrap(await engine.advance({ runId: "run-bvr", expectedVersion: state.snapshot.version, idempotencyKey: "adv-2", occurredAt: t2 }));
    history.push(...state.emittedEvents);
    expect(state.snapshot.tasks[0]?.status).toBe("running");
    expect(state.snapshot.tasks[0]?.attempt).toBe(2);

    const replay = new DeterministicWorkflowEngine({ definitions: [def] });
    const recovered = unwrap(await replay.recover({ runId: "run-bvr", events: history, expectedVersion: state.snapshot.version }));
    expect(recovered.snapshot).toEqual(state.snapshot);
  });

  it("verifies zero intra-package ESM circular runtime imports across all 6 Slice 5 packages", () => {
    const packagesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const slice5Packages = [
      "core",
      "specification",
      "test-strategy",
      "persistence",
      "artifact-store",
      "agent-registry"
    ];

    function collectTsFiles(dir: string): string[] {
      const files: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) files.push(...collectTsFiles(full));
        else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(full);
      }
      return files;
    }

    // Match runtime relative value imports/re-exports (excluding `import type` and `export type`)
    const importRegex = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^"'\n]*?\s+from\s+)?["'](\.[^"']+)["']/g;
    const cycles: string[] = [];

    for (const pkg of slice5Packages) {
      const srcDir = join(packagesRoot, pkg, "src");
      const files = collectTsFiles(srcDir);
      const fileSet = new Set(files);
      const edges = new Map<string, string[]>();

      for (const file of files) {
        const content = readFileSync(file, "utf8");
        const targets: string[] = [];
        for (const match of content.matchAll(importRegex)) {
          const spec = match[1]!;
          const resolvedTs = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
          if (fileSet.has(resolvedTs)) targets.push(resolvedTs);
        }
        edges.set(file, targets);
      }

      const state = new Map<string, "visiting" | "done">();
      const stack: string[] = [];

      const dfs = (node: string) => {
        state.set(node, "visiting");
        stack.push(node);
        for (const next of edges.get(node) ?? []) {
          const nextState = state.get(next);
          if (nextState === "visiting") {
            const idx = stack.indexOf(next);
            cycles.push(`${pkg}: ${[...stack.slice(idx), next].map((p) => p.slice(srcDir.length + 1)).join(" -> ")}`);
          } else if (nextState === undefined) {
            dfs(next);
          }
        }
        stack.pop();
        state.set(node, "done");
      };

      for (const file of files) {
        if (!state.has(file)) dfs(file);
      }
    }

    expect(cycles).toEqual([]);
  });
});
