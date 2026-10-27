import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
  AgentRegistry,
  AgentTransport,
  ApprovalDecision,
  ArtifactStore,
  CancellationRequest,
  ContractError,
  OperationOptions,
  OperationResult,
  QualityGate,
  ResumeRunInput,
  RunStore,
  StartRunInput,
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowRunSnapshot
} from "@bflow/contracts";
import { recoverWorkflowRun } from "./recovery.js";
import {
  createRuntimeService,
  type ApproveOptions,
  type CancelRunOptions,
  type ConcreteRuntimeService,
  type RuntimeInitOptions,
  type RuntimePorts,
  type StartRunOptions
} from "./service.js";

interface CloseableRunStore extends RunStore {
  close(): void;
}

interface CloseableArtifactStore extends ArtifactStore {
  close(): void;
}

interface PersistenceModule {
  openSqliteRunStore(options: {
    readonly filename: string;
    readonly busyTimeoutMs?: number;
    readonly clock?: () => number;
  }): OperationResult<CloseableRunStore>;
}

interface ArtifactStoreModule {
  openFilesystemArtifactStore(options: {
    readonly root: string;
    readonly storeId: string;
    readonly busyTimeoutMs?: number;
    readonly clock?: () => number;
  }): Promise<OperationResult<CloseableArtifactStore>>;
}

interface AgentRegistryModule {
  FileAgentRegistry: new (options: {
    readonly stateFile: string;
    readonly clock?: () => Date;
    readonly operationClock?: () => number;
  }) => AgentRegistry;
  MVP_ROLES: readonly ("planner" | "developer" | "reviewer" | "qa")[];
  seedMvpAgentRegistry(
    registry: AgentRegistry,
    overrides?: unknown,
    options?: OperationOptions
  ): Promise<OperationResult<readonly unknown[]>>;
}

interface CoreModule {
  DeterministicWorkflowEngine: new (options?: {
    readonly definitions?: readonly WorkflowDefinition[];
    readonly resolveDefinition?: (
      workflowId: string,
      workflowVersion: string
    ) => WorkflowDefinition | undefined;
    readonly now?: () => string;
  }) => WorkflowEngine;
}

interface HerdrAdapterModule {
  createHerdrAdapter(options?: {
    readonly binary?: string;
    readonly clock?: () => Date;
    readonly defaultTimeoutMs?: number;
  }): AgentTransport;
}

interface QualityGatesModule {
  createDefaultSecurityPolicy(options: {
    readonly allowedRootDirs: readonly string[];
    readonly assignedWorktreePath?: string;
    readonly maxExecutionTimeoutMs?: number;
  }): OperationResult<unknown>;
  createPresetQualityGate(input: {
    readonly gateId?: string;
    readonly checkKind: "typecheck" | "lint" | "unit_test" | "build" | "custom";
    readonly workingDirectory: string;
    readonly securityPolicy: unknown;
    readonly now?: () => string;
  }): OperationResult<QualityGate>;
}

export interface WorkspaceStoragePaths {
  readonly runStorePath: string;
  readonly artifactStoreRoot: string;
  readonly registryStateFile: string;
}

export interface OpenWorkspaceRuntimeOptions {
  readonly cwd: string;
  readonly runtimeId: string;
  readonly storage: WorkspaceStoragePaths;
  readonly defaultWorkflow: WorkflowDefinition;
  readonly herdrBinary?: string | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly operationOptions?: OperationOptions | undefined;
}

export interface WorkspaceRuntimeHandle {
  readonly runtime: ConcreteRuntimeService;
  close(): Promise<void>;
}

export async function openWorkspaceRuntime(
  options: OpenWorkspaceRuntimeOptions
): Promise<OperationResult<WorkspaceRuntimeHandle>> {
  const cwd = await realpath(options.cwd).catch(() => resolve(options.cwd));
  const clock = options.clock ?? (() => new Date());

  const runStorePath = isAbsolute(options.storage.runStorePath)
    ? options.storage.runStorePath
    : resolve(cwd, options.storage.runStorePath);
  const artifactStoreRoot = isAbsolute(options.storage.artifactStoreRoot)
    ? options.storage.artifactStoreRoot
    : resolve(cwd, options.storage.artifactStoreRoot);
  const registryStateFile = isAbsolute(options.storage.registryStateFile)
    ? options.storage.registryStateFile
    : resolve(cwd, options.storage.registryStateFile);

  try {
    await mkdir(dirname(runStorePath), { recursive: true, mode: 0o700 });
    await mkdir(dirname(registryStateFile), { recursive: true, mode: 0o700 });
  } catch (err) {
    const error: ContractError = {
      code: "corruption",
      retryable: false,
      message: `Failed to initialize storage directories: ${err instanceof Error ? err.message : String(err)}`
    };
    return { ok: false, error };
  }

  let persistenceMod: PersistenceModule;
  let artifactStoreMod: ArtifactStoreModule;
  let agentRegistryMod: AgentRegistryModule;
  let coreMod: CoreModule;
  let herdrAdapterMod: HerdrAdapterModule;
  let qualityGatesMod: QualityGatesModule;

  try {
    [
      persistenceMod,
      artifactStoreMod,
      agentRegistryMod,
      coreMod,
      herdrAdapterMod,
      qualityGatesMod
    ] = await Promise.all([
      import("@bflow/persistence") as Promise<PersistenceModule>,
      import("@bflow/artifact-store") as Promise<ArtifactStoreModule>,
      import("@bflow/agent-registry") as Promise<AgentRegistryModule>,
      import("@bflow/core") as Promise<CoreModule>,
      import("@bflow/herdr-adapter") as Promise<HerdrAdapterModule>,
      import("@bflow/quality-gates") as Promise<QualityGatesModule>
    ]);
  } catch (err) {
    const error: ContractError = {
      code: "transport_unavailable",
      retryable: true,
      message: `Failed to load runtime adapter modules: ${err instanceof Error ? err.message : String(err)}`
    };
    return { ok: false, error };
  }

  let runStore: CloseableRunStore | undefined;
  let artifactStore: CloseableArtifactStore | undefined;

  const closeStores = async (): Promise<void> => {
    const cleanupErrors: unknown[] = [];
    if (artifactStore !== undefined) {
      try {
        artifactStore.close();
      } catch (err) {
        cleanupErrors.push(err);
      }
      artifactStore = undefined;
    }
    if (runStore !== undefined) {
      try {
        runStore.close();
      } catch (err) {
        cleanupErrors.push(err);
      }
      runStore = undefined;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Failed to close workspace runtime stores");
    }
  };

  try {
    const runStoreRes = persistenceMod.openSqliteRunStore({ filename: runStorePath });
    if (!runStoreRes.ok) {
      return runStoreRes;
    }
    runStore = runStoreRes.value;

    const sanitizedStoreId =
      options.runtimeId.replace(/[^A-Za-z0-9._-]/g, "-") || "bflow-artifact-store";
    const artifactStoreRes = await artifactStoreMod.openFilesystemArtifactStore({
      root: artifactStoreRoot,
      storeId: sanitizedStoreId
    });
    if (!artifactStoreRes.ok) {
      await closeStores();
      return artifactStoreRes;
    }
    artifactStore = artifactStoreRes.value;

    const agentRegistry = new agentRegistryMod.FileAgentRegistry({
      stateFile: registryStateFile,
      clock
    });

    let missingRole = false;
    for (const role of agentRegistryMod.MVP_ROLES) {
      const resolved = await agentRegistry.resolve(
        role,
        { runId: "runtime-bootstrap", taskId: "runtime-bootstrap", requiredCapabilities: [] },
        options.operationOptions
      );
      if (!resolved.ok || resolved.value === null) {
        missingRole = true;
      }
    }

    if (missingRole) {
      const seedRes = await agentRegistryMod.seedMvpAgentRegistry(
        agentRegistry,
        undefined,
        options.operationOptions
      );
      if (!seedRes.ok) {
        await closeStores();
        return seedRes;
      }
    }

    const definitionRegistry = new Map<string, WorkflowDefinition>();
    const registerDefinition = (def: WorkflowDefinition): void => {
      definitionRegistry.set(`${def.id}\u0000${def.version}`, def);
    };
    registerDefinition(options.defaultWorkflow);

    const engine = new coreMod.DeterministicWorkflowEngine({
      definitions: [options.defaultWorkflow],
      resolveDefinition: (workflowId: string, workflowVersion: string) =>
        definitionRegistry.get(`${workflowId}\u0000${workflowVersion}`),
      now: () => clock().toISOString()
    });

    const herdrBinary =
      (options.herdrBinary ?? process.env["BFLOW_HERDR_BIN"] ?? process.env["HERDR_BIN"] ?? "herdr").trim() ||
      "herdr";
    const transport = herdrAdapterMod.createHerdrAdapter({
      binary: herdrBinary,
      clock
    });

    const securityPolicyRes = qualityGatesMod.createDefaultSecurityPolicy({
      allowedRootDirs: [cwd]
    });
    if (!securityPolicyRes.ok) {
      await closeStores();
      return securityPolicyRes;
    }

    const qualityGateRes = qualityGatesMod.createPresetQualityGate({
      gateId: "default-typecheck-gate",
      checkKind: "typecheck",
      workingDirectory: cwd,
      securityPolicy: securityPolicyRes.value,
      now: () => clock().toISOString()
    });
    if (!qualityGateRes.ok) {
      await closeStores();
      return qualityGateRes;
    }
    const qualityGate = qualityGateRes.value;

    const ports: RuntimePorts = {
      engine,
      runStore,
      artifactStore,
      agentRegistry,
      transport,
      qualityGate,
      clock,
      runtimeId: options.runtimeId
    };

    const baseService = createRuntimeService(ports);

    const ensureRunRehydrated = async (
      runId: string,
      opOptions?: OperationOptions
    ): Promise<OperationResult<void>> => {
      const engineSnap = await engine.getSnapshot(runId, opOptions);
      if (engineSnap.ok && engineSnap.value !== null) {
        return { ok: true, value: undefined };
      }

      const stored = await runStore!.get(runId, opOptions);
      if (!stored.ok) {
        return stored;
      }
      if (stored.value === null) {
        return { ok: true, value: undefined };
      }

      registerDefinition(stored.value.definition);
      const recRes = await recoverWorkflowRun(runId, ports, opOptions);
      if (!recRes.ok) {
        return recRes;
      }
      return { ok: true, value: undefined };
    };

    const wrappedService: ConcreteRuntimeService = {
      get dispatcher() {
        return baseService.dispatcher;
      },
      get orchestrator() {
        return baseService.orchestrator;
      },
      init(initOptions?: RuntimeInitOptions) {
        return baseService.init(initOptions);
      },
      async start(input: StartRunInput, opOptions?: OperationOptions) {
        if (input && typeof input === "object" && "definition" in input && input.definition) {
          registerDefinition(input.definition);
        }
        return baseService.start(input, opOptions);
      },
      async startRun(definition: WorkflowDefinition, startOptions?: StartRunOptions) {
        registerDefinition(definition);
        return baseService.startRun(definition, startOptions);
      },
      getRun(runId: string, opOptions?: OperationOptions) {
        return baseService.getRun(runId, opOptions);
      },
      getRunStatus(runId: string) {
        return baseService.getRunStatus(runId);
      },
      findRuns(query, opOptions) {
        return baseService.findRuns(query, opOptions);
      },
      watch(runId, watchOptions) {
        return baseService.watch(runId, watchOptions);
      },
      async decide(decision: ApprovalDecision, opOptions?: OperationOptions) {
        if (decision && typeof decision === "object" && typeof decision.runId === "string") {
          const rehydrated = await ensureRunRehydrated(decision.runId, opOptions);
          if (!rehydrated.ok) {
            return rehydrated as OperationResult<WorkflowRunSnapshot>;
          }
        }
        return baseService.decide(decision, opOptions);
      },
      async approve(runId: string, approveOptions?: ApproveOptions) {
        const rehydrated = await ensureRunRehydrated(runId);
        if (!rehydrated.ok) {
          return rehydrated as OperationResult<WorkflowRunSnapshot>;
        }
        return baseService.approve(runId, approveOptions);
      },
      async resume(inputOrRunId: ResumeRunInput | string, opOptions?: OperationOptions) {
        const runId = typeof inputOrRunId === "string" ? inputOrRunId : inputOrRunId?.runId;
        if (typeof runId === "string" && runId.trim().length > 0) {
          const stored = await runStore!.get(runId, opOptions);
          if (stored.ok && stored.value !== null) {
            registerDefinition(stored.value.definition);
          }
        }
        return baseService.resume(inputOrRunId, opOptions);
      },
      async cancel(
        requestOrOptions: CancellationRequest | CancelRunOptions,
        opOptions?: OperationOptions
      ) {
        if (
          requestOrOptions &&
          typeof requestOrOptions === "object" &&
          typeof requestOrOptions.runId === "string"
        ) {
          const rehydrated = await ensureRunRehydrated(requestOrOptions.runId, opOptions);
          if (!rehydrated.ok) {
            return rehydrated as OperationResult<WorkflowRunSnapshot>;
          }
        }
        return baseService.cancel(requestOrOptions, opOptions);
      }
    };

    return {
      ok: true,
      value: {
        runtime: wrappedService,
        close: closeStores
      }
    };
  } catch (err) {
    await closeStores();
    const error: ContractError = {
      code: "corruption",
      retryable: false,
      message: `Failed to compose workspace runtime: ${err instanceof Error ? err.message : String(err)}`
    };
    return { ok: false, error };
  }
}
