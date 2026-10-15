import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OperationOptions,
  OperationResult,
  QualityGate,
  QualityGateContext,
  QualityGateResult,
  WorkflowDefinition
} from "@ai-flow/contracts";
import { openSqliteRunStore, type SqliteRunStore } from "@ai-flow/persistence";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "@ai-flow/artifact-store";
import { FileAgentRegistry } from "@ai-flow/agent-registry";
import { DeterministicWorkflowEngine } from "@ai-flow/core";
import { createRuntimeService,
  type ConcreteRuntimeService,
  type RuntimePorts
} from "@ai-flow/runtime";
import { FixtureAgentTransport } from "./fixture-transport.js";
import { createStandardMvpWorkflow } from "./fixtures.js";

/**
 * Composite quality gate router that delegates to real quality gate evaluators by gateId.
 */
export class CompositeQualityGate implements QualityGate {
  readonly id = "composite-quality-gate";
  private readonly evaluators = new Map<string, QualityGate>();

  register(gateId: string, evaluator: QualityGate): void {
    this.evaluators.set(gateId, evaluator);
  }

  async evaluate(
    context: QualityGateContext,
    options?: OperationOptions
  ): Promise<OperationResult<QualityGateResult>> {
    const evaluator = this.evaluators.get(context.definition.id);
    if (!evaluator) {
      return {
        ok: false,
        error: {
          code: "not_found",
          retryable: false,
          message: `No evaluator registered for gate '${context.definition.id}'`
        }
      };
    }
    return evaluator.evaluate(context, options);
  }
}

export interface E2eHarnessOptions {
  readonly clock?: (() => Date) | undefined;
  readonly qualityGate?: QualityGate | undefined;
  readonly transport?: FixtureAgentTransport | undefined;
  readonly definitions?: readonly WorkflowDefinition[] | undefined;
}

export interface E2eHarness {
  readonly tmpDir: string;
  readonly dbPath: string;
  readonly artifactsDir: string;
  readonly registryPath: string;
  readonly runStore: SqliteRunStore;
  readonly artifactStore: FilesystemArtifactStore;
  readonly agentRegistry: FileAgentRegistry;
  readonly engine: DeterministicWorkflowEngine;
  readonly transport: FixtureAgentTransport;
  readonly qualityGate: CompositeQualityGate;
  readonly ports: RuntimePorts;
  readonly service: ConcreteRuntimeService;

  /**
   * Simulates a full process restart:
   * Re-opens the exact same SQLite database, artifact storage, and agent registry
   * with new engine and runtime service instances.
   */
  restart(): Promise<{
    service: ConcreteRuntimeService;
    engine: DeterministicWorkflowEngine;
    runStore: SqliteRunStore;
    artifactStore: FilesystemArtifactStore;
  }>;

  cleanup(): Promise<void>;
}

export async function createE2eHarness(options?: E2eHarnessOptions): Promise<E2eHarness> {
  const clock = options?.clock ?? (() => new Date());
  const tmpDir = await mkdtemp(join(tmpdir(), "ai-flow-p08-e2e-"));
  const dbPath = join(tmpDir, "run-store.db");
  const artifactsDir = join(tmpDir, "artifacts");
  const registryPath = join(tmpDir, "registry.json");

  // 1. Real SqliteRunStore
  const runStoreRes = openSqliteRunStore({ filename: dbPath });
  if (!runStoreRes.ok) throw new Error(`SqliteRunStore open failed: ${runStoreRes.error.message}`);
  let currentRunStore = runStoreRes.value;

  // 2. Real FilesystemArtifactStore
  const artifactStoreRes = await openFilesystemArtifactStore({
    root: artifactsDir,
    storeId: "e2e-artifact-store"
  });
  if (!artifactStoreRes.ok) throw new Error(`FilesystemArtifactStore open failed: ${artifactStoreRes.error.message}`);
  let currentArtifactStore = artifactStoreRes.value;

  // 3. Real FileAgentRegistry
  let currentRegistry = new FileAgentRegistry({
    stateFile: registryPath,
    clock
  });

  // Seed default agents for MVP roles
  const roles = ["planner", "developer", "reviewer", "qa"];
  for (const role of roles) {
    await currentRegistry.upsert({
      agentId: `agent-${role}-1`,
      role,
      transport: "herdr",
      enabled: true,
      priority: 1,
      maxConcurrentTasks: 2,
      capabilities: ["code", "review", "test"],
      settings: {
        provider: "mock",
        kind: "cli",
        readOnlyWorkspace: false,
        allowTaskDelegation: false
      }
    });
  }

  // Workflow definition registry for engine rehydration across restarts
  const definitionRegistry = new Map<string, WorkflowDefinition>();
  const standardMvp = createStandardMvpWorkflow();
  definitionRegistry.set(`${standardMvp.id}\u0000${standardMvp.version}`, standardMvp);
  for (const def of options?.definitions ?? []) {
    definitionRegistry.set(`${def.id}\u0000${def.version}`, def);
  }
  const resolveDefinition = (id: string, version: string) => {
    return definitionRegistry.get(`${id}\u0000${version}`);
  };

  // 4. Real DeterministicWorkflowEngine
  let currentEngine = new DeterministicWorkflowEngine({
    resolveDefinition,
    now: () => clock().toISOString()
  });

  // 5. Test-controlled FixtureAgentTransport
  const transport = options?.transport ?? new FixtureAgentTransport({ clock });

  // 6. QualityGate router
  const compositeGate = new CompositeQualityGate();
  if (options?.qualityGate) {
    compositeGate.register("default", options.qualityGate);
  }

  // 7. Compose RuntimePorts
  let currentPorts: RuntimePorts = {
    engine: currentEngine,
    runStore: currentRunStore,
    artifactStore: currentArtifactStore,
    agentRegistry: currentRegistry,
    transport,
    qualityGate: compositeGate,
    clock
  };

  let currentService = createRuntimeService(currentPorts);
  await currentService.init();

  return {
    tmpDir,
    dbPath,
    artifactsDir,
    registryPath,
    get runStore() { return currentRunStore; },
    get artifactStore() { return currentArtifactStore; },
    get agentRegistry() { return currentRegistry; },
    get engine() { return currentEngine; },
    transport,
    qualityGate: compositeGate,
    get ports() { return currentPorts; },
    get service() { return currentService; },

    async restart() {
      // Close old store connections before re-opening to prevent file locking and state leaks
      currentRunStore.close();
      currentArtifactStore.close();

      // Create new instances from the same persistent state on disk
      const newRunStoreRes = openSqliteRunStore({ filename: dbPath });
      if (!newRunStoreRes.ok) throw new Error(`Restart: SqliteRunStore open failed: ${newRunStoreRes.error.message}`);
      currentRunStore = newRunStoreRes.value;

      const newArtifactStoreRes = await openFilesystemArtifactStore({
        root: artifactsDir,
        storeId: "e2e-artifact-store"
      });
      if (!newArtifactStoreRes.ok) throw new Error(`Restart: FilesystemArtifactStore open failed: ${newArtifactStoreRes.error.message}`);
      currentArtifactStore = newArtifactStoreRes.value;

      currentRegistry = new FileAgentRegistry({
        stateFile: registryPath,
        clock
      });

      currentEngine = new DeterministicWorkflowEngine({
        resolveDefinition,
        now: () => clock().toISOString()
      });

      currentPorts = {
        engine: currentEngine,
        runStore: currentRunStore,
        artifactStore: currentArtifactStore,
        agentRegistry: currentRegistry,
        transport,
        qualityGate: compositeGate,
        clock
      };

      currentService = createRuntimeService(currentPorts);
      await currentService.init({ recoveryMode: true });

      return {
        service: currentService,
        engine: currentEngine,
        runStore: currentRunStore,
        artifactStore: currentArtifactStore
      };
    },

    async cleanup() {
      const errors: unknown[] = [];
      try {
        currentRunStore.close();
      } catch (err) {
        errors.push(err);
      }
      try {
        currentArtifactStore.close();
      } catch (err) {
        errors.push(err);
      }
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch (err) {
        errors.push(err);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Harness cleanup failed");
      }
    }
  };
}
