import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentExecutionHandle,
  AgentReconciliationRequest,
  AgentReconciliationResult,
  AgentRequest,
  AgentSubmissionReceipt,
  AgentTransport,
  AgentTransportCapabilities,
  AgentTransportInitialization,
  CancellationRequest,
  CancellationResult,
  OperationOptions,
  OperationResult,
  WorkflowDefinition
} from "@bflow/contracts";
import { openSqliteRunStore, type SqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "@bflow/artifact-store";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { DeterministicWorkflowEngine } from "@bflow/core";
import type { RuntimePorts } from "../../src/index.js";

export class FakeAgentTransport implements AgentTransport {
  sentRequests: AgentRequest[] = [];
  cancelledHandles: AgentExecutionHandle[] = [];
  customSendHandler?: (req: AgentRequest) => OperationResult<AgentSubmissionReceipt>;
  customReconcileHandler?: (req: AgentReconciliationRequest) => OperationResult<AgentReconciliationResult>;
  customCancelHandler?: (handle: AgentExecutionHandle, req: CancellationRequest) => OperationResult<CancellationResult>;
  customWaitHandler?: (handle: AgentExecutionHandle, options?: any) => OperationResult<any>;

  async wait(handle: AgentExecutionHandle, options?: any): Promise<OperationResult<any>> {
    if (this.customWaitHandler) return this.customWaitHandler(handle, options);
    return { ok: true, value: { handle, state: "done", observedAt: new Date().toISOString(), correlationVerified: true } };
  }
  async *read(_handle: AgentExecutionHandle, _options?: any): AsyncIterable<OperationResult<any>> {}

  async initialize(
    _initialization: AgentTransportInitialization,
    _options?: OperationOptions
  ): Promise<OperationResult<AgentTransportCapabilities>> {
    return {
      ok: true,
      value: {
        transportName: "fake-transport",
        protocolVersion: "1.0",
        supportsStreaming: true,
        supportsCancellation: true,
        supportsReconciliation: true
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
}

export interface TestHarness {
  readonly tmpDir: string;
  readonly runStore: SqliteRunStore;
  readonly artifactStore: FilesystemArtifactStore;
  readonly agentRegistry: FileAgentRegistry;
  readonly engine: DeterministicWorkflowEngine;
  readonly transport: FakeAgentTransport;
  readonly ports: RuntimePorts;
  cleanup(): Promise<void>;
}

export async function createTestHarness(clock?: () => Date): Promise<TestHarness> {
  const tmpDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-runtime-test-")));
  const dbPath = join(tmpDir, "run-store.db");
  const artifactsPath = join(tmpDir, "artifacts");
  const registryPath = join(tmpDir, "registry.json");

  const runStoreRes = openSqliteRunStore({ filename: dbPath });
  if (!runStoreRes.ok) throw new Error(`Failed to open SqliteRunStore: ${runStoreRes.error.message}`);
  const runStore = runStoreRes.value;

  const artifactStoreRes = await openFilesystemArtifactStore({
    root: artifactsPath,
    storeId: "test-store"
  });
  if (!artifactStoreRes.ok) throw new Error(`Failed to open FilesystemArtifactStore: ${artifactStoreRes.error.message}`);
  const artifactStore = artifactStoreRes.value;

  const agentRegistry = new FileAgentRegistry({
    stateFile: registryPath,
    clock: clock ?? (() => new Date())
  });

  // Seed default agents for MVP roles
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

  const ports: RuntimePorts = {
    engine,
    runStore,
    artifactStore,
    agentRegistry,
    transport,
    clock
  };

  return {
    tmpDir,
    runStore,
    artifactStore,
    agentRegistry,
    engine,
    transport,
    ports,
    cleanup: async () => {
      artifactStore.close();
      runStore.close();
      await rm(tmpDir, { recursive: true, force: true });
    }
  };
}

export function createSampleWorkflowDefinition(options?: {
  readonly maxConcurrency?: number;
  readonly requiresApproval?: boolean;
}): WorkflowDefinition {
  return {
    schemaVersion: "1",
    id: "sample-feature-workflow",
    name: "Sample Feature SDLC Workflow",
    version: "1.0.0",
    description: "Standard feature development SDLC workflow",
    maxConcurrency: options?.maxConcurrency ?? 2,
    failurePolicy: "fail-fast",
    recovery: {
      checkpoint: "task-boundary",
      resumeStrategy: "checkpoint-then-replay",
      staleExecution: "reconcile"
    },
    qualityGates: [],
    tasks: [
      {
        id: "plan",
        title: "Planning Phase",
        role: "planner",
        instruction: "Draft technical specification",
        acceptanceCriteria: ["Specification complete"],
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
        title: "Implementation Phase",
        role: "developer",
        instruction: "Implement feature code and unit tests",
        acceptanceCriteria: ["Code implemented", "Unit tests pass"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        rework: {
          maxReworks: 2,
          onExhausted: "require_human"
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "review",
        title: "Review Phase",
        role: "reviewer",
        instruction: "Review implementation changes and test reports",
        acceptanceCriteria: ["Review completed with decision"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        rework: {
          maxReworks: 2,
          onExhausted: "require_human"
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: false,
        qualityGates: []
      },
      {
        id: "qa",
        title: "QA Phase",
        role: "qa",
        instruction: "Run end-to-end and acceptance tests",
        acceptanceCriteria: ["All acceptance tests pass"],
        retry: {
          maxAttempts: 2,
          strategy: "fixed",
          initialDelayMs: 100,
          maxDelayMs: 1000,
          jitter: false
        },
        timeout: { executionTimeoutMs: 60000, onTimeout: "fail" },
        requiresApproval: options?.requiresApproval ?? true,
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
