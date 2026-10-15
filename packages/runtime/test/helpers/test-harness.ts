import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  OperationOptions,
  OperationResult,
  QualityGate,
  QualityGateContext,
  QualityGateResult,
  WorkflowDefinition
} from "@bflow/contracts";
import { openSqliteRunStore, type SqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "@bflow/artifact-store";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { DeterministicWorkflowEngine } from "@bflow/core";
import {
  createRuntimeService,
  type ConcreteRuntimeService,
  type RuntimePorts
} from "../../src/service.js";
import { FakeAgentTransport } from "./fake-transport.js";

/**
 * Deterministic fake in-memory QualityGate for integration tests.
 * Defaults to "passed" status, recording contexts and allowing custom evaluation mocks.
 */
export class FakeQualityGate implements QualityGate {
  readonly evaluatedContexts: QualityGateContext[] = [];
  customEvaluateHandler?: (ctx: QualityGateContext) => OperationResult<QualityGateResult>;

  async evaluate(
    context: QualityGateContext,
    _options?: OperationOptions
  ): Promise<OperationResult<QualityGateResult>> {
    this.evaluatedContexts.push(context);
    if (this.customEvaluateHandler) {
      return this.customEvaluateHandler(context);
    }
    const evaluatedAt = new Date().toISOString();
    return {
      ok: true,
      value: {
        gateId: context.definition.id,
        runId: context.runId,
        ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
        evaluationId: `eval-${context.definition.id}-${randomUUID()}`,
        status: "passed",
        findings: [],
        producedArtifacts: [],
        evaluatedAt,
        metadata: {
          checkKind: "command",
          checkStatus: "passed",
          independentOfAgentClaims: true
        }
      }
    };
  }
}

export interface TestHarnessOptions {
  readonly clock?: () => Date;
  readonly qualityGate?: QualityGate;
}

export interface TestHarness {
  readonly tmpDir: string;
  readonly runStore: SqliteRunStore;
  readonly artifactStore: FilesystemArtifactStore;
  readonly agentRegistry: FileAgentRegistry;
  readonly engine: DeterministicWorkflowEngine;
  readonly transport: FakeAgentTransport;
  readonly qualityGate: FakeQualityGate;
  readonly ports: RuntimePorts;
  readonly service: ConcreteRuntimeService;
  cleanup(): Promise<void>;
}

/**
 * Creates a fully isolated, production-grade integration test harness with:
 * - Temporary SQLite database for RunStore
 * - Temporary filesystem directory for ArtifactStore
 * - Temporary JSON state file for FileAgentRegistry (seeded with MVP roles)
 * - DeterministicWorkflowEngine
 * - FakeAgentTransport
 * - FakeQualityGate
 * - ConcreteRuntimeService instance
 */
export async function createTestHarness(options?: TestHarnessOptions): Promise<TestHarness> {
  const clock = options?.clock;
  const tmpDir = await mkdtemp(join(tmpdir(), "bflow-runtime-scenario-"));
  const dbPath = join(tmpDir, "run-store.db");
  const artifactsPath = join(tmpDir, "artifacts");
  const registryPath = join(tmpDir, "registry.json");

  const runStoreRes = openSqliteRunStore({ filename: dbPath });
  if (!runStoreRes.ok) throw new Error(`Failed to open SqliteRunStore: ${runStoreRes.error.message}`);
  const runStore = runStoreRes.value;

  const artifactStoreRes = await openFilesystemArtifactStore({
    root: artifactsPath,
    storeId: "test-scenario-store"
  });
  if (!artifactStoreRes.ok) throw new Error(`Failed to open FilesystemArtifactStore: ${artifactStoreRes.error.message}`);
  const artifactStore = artifactStoreRes.value;

  const agentRegistry = new FileAgentRegistry({
    stateFile: registryPath,
    clock: clock ?? (() => new Date())
  });

  // Seed default agents for all 4 MVP roles
  const roles = ["planner", "developer", "reviewer", "qa"];
  for (const role of roles) {
    await agentRegistry.upsert({
      agentId: `agent-${role}-1`,
      role,
      transport: "herdr",
      enabled: true,
      priority: 10,
      maxConcurrentTasks: 5,
      capabilities: [role, "general"],
      settings: {
        provider: "mock",
        kind: "agent",
        execution: { paneId: `pane-${role}` }
      }
    });
  }

  const engine = new DeterministicWorkflowEngine({
    clock: clock ? () => clock().toISOString() : undefined
  });

  const transport = new FakeAgentTransport();
  const qualityGate = (options?.qualityGate as FakeQualityGate) ?? new FakeQualityGate();

  const ports: RuntimePorts = {
    engine,
    runStore,
    artifactStore,
    agentRegistry,
    transport,
    qualityGate,
    clock
  };

  const service = createRuntimeService(ports);

  return {
    tmpDir,
    runStore,
    artifactStore,
    agentRegistry,
    engine,
    transport,
    qualityGate,
    ports,
    service,
    cleanup: async () => {
      artifactStore.close();
      runStore.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  };
}

/**
 * Standard 11-step SDLC workflow definition builder with configurable parameters.
 */
export function createSdlcWorkflowDefinition(options?: {
  readonly id?: string;
  readonly maxConcurrency?: number;
  readonly requiresApproval?: boolean;
  readonly maxReworks?: number;
  readonly includeQualityGate?: boolean;
}): WorkflowDefinition {
  const includeQualityGate = options?.includeQualityGate ?? true;
  const maxReworks = options?.maxReworks ?? 2;
  const requiresApproval = options?.requiresApproval ?? true;

  return {
    schemaVersion: "1",
    id: options?.id ?? "sdlc-11-step-feature-workflow",
    name: "11-Step SDLC Feature Workflow",
    version: "1.0.0",
    description: "Production MVP SDLC orchestration: Plan -> Dev -> Gate -> Review -> QA -> Approval -> Complete",
    maxConcurrency: options?.maxConcurrency ?? 2,
    failurePolicy: "fail-fast",
    recovery: {
      checkpoint: "task-boundary",
      resumeStrategy: "checkpoint-then-replay",
      staleExecution: "reconcile"
    },
    qualityGates: includeQualityGate
      ? [
          {
            id: "unit-tests-gate",
            name: "Automated Unit Tests Quality Gate",
            description: "Executes automated test suite against implementation artifacts",
            evaluator: "command",
            required: true,
            timeout: { executionTimeoutMs: 30000, onTimeout: "fail" }
          }
        ]
      : [],
    tasks: [
      {
        id: "plan",
        title: "Architecture & Specification Planning",
        role: "planner",
        instruction: "Draft technical architecture and specification document",
        acceptanceCriteria: ["Technical specification complete"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "implement",
        title: "Feature Implementation & Unit Tests",
        role: "developer",
        instruction: "Implement feature code and unit tests",
        acceptanceCriteria: ["Feature implemented", "Unit tests pass"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        rework: {
          maxReworks,
          onExhausted: "require_human"
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: includeQualityGate
          ? [{ gateId: "unit-tests-gate", phase: "after_result", required: true }]
          : []
      },
      {
        id: "review",
        title: "Code Review & Quality Gate Audit",
        role: "reviewer",
        instruction: "Review implementation diff and quality verification evidence",
        acceptanceCriteria: ["Review decision rendered"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        rework: {
          maxReworks,
          onExhausted: "require_human"
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "qa",
        title: "QA & Integration Testing",
        role: "qa",
        instruction: "Execute integration and end-to-end acceptance tests",
        acceptanceCriteria: ["All acceptance tests pass"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval,
        qualityGates: []
      }
    ],
    dependencies: [
      { taskId: "implement", dependsOnTaskId: "plan", condition: "succeeded" },
      { taskId: "review", dependsOnTaskId: "implement", condition: "succeeded" },
      { taskId: "qa", dependsOnTaskId: "review", condition: "succeeded" }
    ]
  };
}

/**
 * Backward-compatible alias for standard SDLC workflow definition builder.
 */
export const createSampleWorkflowDefinition = createSdlcWorkflowDefinition;
