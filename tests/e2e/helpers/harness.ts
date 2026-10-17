import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
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
} from "@bflow/runtime";
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
  /** Test-only seam: custom factory to simulate RunStore acquisition failure */
  readonly openRunStore?: typeof openSqliteRunStore | undefined;
  /** Test-only seam: custom factory to simulate ArtifactStore acquisition failure */
  readonly openArtifactStore?: typeof openFilesystemArtifactStore | undefined;
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
   * Simulates graceful rehydration / restart by closing old store connections
   * and opening fresh instances from the same persistent on-disk state.
   * NOTE: This models process instance shutdown and reopening, NOT an ungraceful
   * OS process crash / SIGKILL / power loss.
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
  const runStoreFactory = options?.openRunStore ?? openSqliteRunStore;
  const artifactStoreFactory = options?.openArtifactStore ?? openFilesystemArtifactStore;

  let tmpDir: string | undefined;
  let tmpParent: string | undefined;
  let currentRunStore: SqliteRunStore | undefined;
  let currentArtifactStore: FilesystemArtifactStore | undefined;

  async function releaseAcquiredResources(): Promise<unknown[]> {
    const cleanupErrors: unknown[] = [];
    if (currentArtifactStore) {
      try {
        currentArtifactStore.close();
      } catch (err) {
        cleanupErrors.push(err);
      }
      currentArtifactStore = undefined;
    }
    if (currentRunStore) {
      try {
        currentRunStore.close();
      } catch (err) {
        cleanupErrors.push(err);
      }
      currentRunStore = undefined;
    }
    if (tmpDir) {
      try {
        if (!tmpParent) throw new Error("Cannot verify the captured temporary parent for the E2E harness directory");
        const fromPrefix = relative(tmpParent, tmpDir);
        if (fromPrefix !== "" && fromPrefix !== ".." && !fromPrefix.startsWith(`..${sep}`) && !isAbsolute(fromPrefix)) {
          await rm(tmpDir, { recursive: true, force: true });
          tmpDir = undefined;
        } else {
          throw new Error(`Refusing to remove E2E harness directory outside its captured temporary parent: ${tmpDir}`);
        }
      } catch (err) {
        cleanupErrors.push(err);
      }
    }
    return cleanupErrors;
  }

  try {
    tmpParent = await realpath(tmpdir());
    tmpDir = await realpath(await mkdtemp(join(tmpParent, "bflow-p08-e2e-")));
    const dbPath = join(tmpDir, "run-store.db");
    const artifactsDir = join(tmpDir, "artifacts");
    const registryPath = join(tmpDir, "registry.json");

    // 1. SqliteRunStore acquisition
    const runStoreRes = runStoreFactory({ filename: dbPath });
    if (!runStoreRes.ok) {
      throw new Error(`SqliteRunStore open failed: ${runStoreRes.error.message}`);
    }
    currentRunStore = runStoreRes.value;

    // 2. FilesystemArtifactStore acquisition
    const artifactStoreRes = await artifactStoreFactory({
      root: artifactsDir,
      storeId: "e2e-artifact-store"
    });
    if (!artifactStoreRes.ok) {
      throw new Error(`FilesystemArtifactStore open failed: ${artifactStoreRes.error.message}`);
    }
    currentArtifactStore = artifactStoreRes.value;

    // 3. Real FileAgentRegistry
    let currentRegistry = new FileAgentRegistry({
      stateFile: registryPath,
      clock
    });

    // Seed default agents for MVP roles, strictly validating each OperationResult
    const roles = ["planner", "developer", "reviewer", "qa"];
    for (const role of roles) {
      const upsertRes = await currentRegistry.upsert({
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
      if (!upsertRes.ok) {
        throw new Error(`Failed to seed agent '${role}': ${upsertRes.error.message}`);
      }
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
    const initRes = await currentService.init();
    if (!initRes.ok) {
      throw new Error(`RuntimeService init failed: ${initRes.error.message}`);
    }

    let cleanedUp = false;

    return {
      tmpDir,
      dbPath,
      artifactsDir,
      registryPath,
      get runStore() {
        if (!currentRunStore) throw new Error("Harness RunStore has been closed");
        return currentRunStore;
      },
      get artifactStore() {
        if (!currentArtifactStore) throw new Error("Harness ArtifactStore has been closed");
        return currentArtifactStore;
      },
      get agentRegistry() { return currentRegistry; },
      get engine() { return currentEngine; },
      transport,
      qualityGate: compositeGate,
      get ports() { return currentPorts; },
      get service() { return currentService; },

      async restart() {
        // Close old store instances first to release file locks
        const oldRunStore = currentRunStore;
        const oldArtifactStore = currentArtifactStore;
        currentRunStore = undefined;
        currentArtifactStore = undefined;

        try {
          oldRunStore?.close();
        } finally {
          oldArtifactStore?.close();
        }

        let nextRunStore: SqliteRunStore | undefined;
        let nextArtifactStore: FilesystemArtifactStore | undefined;

        try {
          // Open new store handles from existing persistent on-disk files
          const newRunStoreRes = runStoreFactory({ filename: dbPath });
          if (!newRunStoreRes.ok) {
            throw new Error(`Restart: SqliteRunStore open failed: ${newRunStoreRes.error.message}`);
          }
          nextRunStore = newRunStoreRes.value;

          const newArtifactStoreRes = await artifactStoreFactory({
            root: artifactsDir,
            storeId: "e2e-artifact-store"
          });
          if (!newArtifactStoreRes.ok) {
            throw new Error(`Restart: FilesystemArtifactStore open failed: ${newArtifactStoreRes.error.message}`);
          }
          nextArtifactStore = newArtifactStoreRes.value;

          currentRegistry = new FileAgentRegistry({
            stateFile: registryPath,
            clock
          });

          currentEngine = new DeterministicWorkflowEngine({
            resolveDefinition,
            now: () => clock().toISOString()
          });

          currentRunStore = nextRunStore;
          currentArtifactStore = nextArtifactStore;

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
          const restartInitRes = await currentService.init({ recoveryMode: true });
          if (!restartInitRes.ok) {
            throw new Error(`Restart: Runtime service init failed: ${restartInitRes.error.message}`);
          }

          return {
            service: currentService,
            engine: currentEngine,
            runStore: currentRunStore,
            artifactStore: currentArtifactStore
          };
        } catch (restartErr) {
          // Clean up newly acquired handles if restart failed
          const cleanupErrors: unknown[] = [];
          if (nextArtifactStore) {
            try { nextArtifactStore.close(); } catch (err) { cleanupErrors.push(err); }
          }
          if (nextRunStore) {
            try { nextRunStore.close(); } catch (err) { cleanupErrors.push(err); }
          }
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              [restartErr, ...cleanupErrors],
              `Harness restart failed with secondary cleanup errors: ${restartErr instanceof Error ? restartErr.message : String(restartErr)}`
            );
          }
          throw restartErr;
        }
      },

      async cleanup() {
        if (cleanedUp) return;
        cleanedUp = true;
        const cleanupErrors = await releaseAcquiredResources();
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "Harness cleanup encountered errors");
        }
      }
    };
  } catch (primaryError) {
    const cleanupErrors = await releaseAcquiredResources();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        `Failed to initialize E2E harness and encountered errors during cleanup: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`
      );
    }
    throw primaryError;
  }
}
