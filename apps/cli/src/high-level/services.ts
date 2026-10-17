import { resolve } from "node:path";
import type {
  AgentHealthRequest,
  AgentHealthResult,
  ArtifactStore,
  GitChangeSet,
  OperationOptions,
  OperationResult,
  QualityGate,
  RuntimeService,
  Specification,
  TestStrategy,
  VerificationCycle,
  VerificationResult,
  RoleMessage
} from "@bflow/contracts";
import type { IntegrationRecord, IntegrationRequest, TaskRecord, TaskRequest } from "@bflow/git-orchestrator";
import type { CommandRunner, PlatformProfile, SkillsSynchronizer } from "@bflow/machine-setup";
import type { VerificationPlan } from "@bflow/verification";

/**
 * Ports used by high-level commands. Each is a thin facade over an existing engine; the CLI never
 * substitutes its own scheduling, gates, approvals or verification policy for theirs.
 */
export interface GitOrchestratorPort {
  prepareTask(request: TaskRequest): Promise<TaskRecord>;
  getTask(key: string): Promise<TaskRecord>;
  collectTask(key: string): Promise<GitChangeSet>;
  beginIntegration(request: IntegrationRequest): Promise<IntegrationRecord>;
  resumeIntegration(key: string): Promise<IntegrationRecord>;
}

export interface SpecificationPort {
  /** P15 contract + SDD metadata validation. Throws with diagnostics when invalid. */
  parse(input: unknown): Specification;
  /** Reads the stored artifact and checks digest/size/content against the document. */
  verifyArtifact(spec: Specification): Promise<void>;
  buildTraceabilityMatrix(spec: Specification, workflow?: unknown): {
    criterionToTasks: Record<string, readonly string[]>; taskToCriteria: Record<string, readonly string[]>;
    orphanCriterionIds: readonly string[]; unmappedWorkflowTaskIds: readonly string[]; unknownMappedTaskIds: readonly string[]; valid: boolean;
  };
  classify(spec: Specification): { complexity: string; level: string; riskLevel: string; humanApprovalRequired: boolean } | null;
}

export interface StrategyPort {
  resolve(spec: Specification): TestStrategy;
  validateAgainstSpecification(strategy: TestStrategy, spec: Specification): TestStrategy;
}

export interface VerificationPort {
  createPlan(input: unknown): VerificationPlan;
  start(plan: VerificationPlan, cycleId: string): VerificationCycle;
  verify(plan: VerificationPlan, cycle: VerificationCycle, change: GitChangeSet, options?: unknown): Promise<{
    result: VerificationResult; cycle: VerificationCycle; messages: RoleMessage[];
  }>;
}

export interface ProviderPort {
  checkHealth(request: AgentHealthRequest, options?: OperationOptions): Promise<OperationResult<AgentHealthResult>>;
}

export interface MachinePort {
  platform(): Promise<PlatformProfile>;
  runner(): CommandRunner;
}

/** Status of the shared MCP Gateway (P27). `undefined` means no Gateway is configured on this host. */
export interface McpGatewayPort {
  status(options?: OperationOptions): Promise<{
    reachable: boolean; version?: string; backends: { serviceId: string; state: "healthy" | "degraded" | "unavailable" | "unknown"; detail?: string }[];
  }>;
}

export interface HighLevelResources {
  readonly git: GitOrchestratorPort;
  readonly artifactStore: ArtifactStore;
  close(): Promise<void>;
}

export interface HighLevelServices {
  readonly specification: SpecificationPort;
  readonly strategy: StrategyPort;
  readonly machine: MachinePort;
  readonly providers: ProviderPort;
  /** Opens repository-scoped mutable resources only for commands that need them. */
  openResources(repositoryRoot: string, options?: { artifactRoot?: string | undefined; storeId?: string | undefined }): Promise<HighLevelResources>;
  /** Builds the verification engine around the injected independent gates. */
  verification(input: { artifactStore: ArtifactStore; gates: readonly QualityGate[]; loadSpecification(specId: string): Promise<Specification> }): VerificationPort;
  /** Legacy RuntimeService used for read-only execution state; undefined when not initialized. */
  openRuntime?(repositoryRoot: string): Promise<{ runtime: RuntimeService; close(): Promise<void> } | undefined>;
  readonly gates?: readonly QualityGate[] | undefined;
  /** P28 skill manager adapter for the selected providers; absent until integrated. */
  readonly skills?: ((providers: readonly string[]) => SkillsSynchronizer) | undefined;
  readonly mcpGateway?: McpGatewayPort | undefined;
}

export const DEFAULT_ARTIFACT_ROOT = ".bflow/state/cli/artifacts";
export const DEFAULT_ARTIFACT_STORE_ID = "bflow-cli";

function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Composes the reviewed P15–P18, P25 and P26 implementations. */
export async function createDefaultHighLevelServices(): Promise<HighLevelServices> {
  const specification = await import("@bflow/specification");
  const strategy = await import("@bflow/test-strategy");
  const verification = await import("@bflow/verification");
  const providers = await import("@bflow/agent-providers");
  const setup = await import("@bflow/machine-setup");
  const registry = providers.createDefaultProviderRegistry();
  const resolver = new strategy.TestStrategyResolver();
  return {
    specification: {
      parse: input => specification.parseSpecification(input),
      async verifyArtifact(spec) {
        throw new Error(`Specification '${spec.specId}' artifact cannot be verified without an ArtifactStore`);
      },
      buildTraceabilityMatrix: (spec, workflow) => specification.buildTraceabilityMatrix(spec, workflow as never),
      classify(spec) {
        const sdd = spec.metadata?.sdd as { assessment?: unknown } | undefined;
        if (sdd?.assessment === undefined) return null;
        return specification.classifyChange(sdd.assessment as never, spec.affectedPaths);
      }
    },
    strategy: {
      resolve: spec => resolver.resolve(spec),
      validateAgainstSpecification: (value, spec) => resolver.validateAgainstSpecification(value, spec)
    },
    machine: {
      platform: () => setup.detectPlatformWithProbe(setup.defaultHostEnvironment()),
      runner: () => new setup.NodeCommandRunner()
    },
    providers: registry,
    async openResources(repositoryRoot, options) {
      const artifacts = await import("@bflow/artifact-store");
      const git = await import("@bflow/git-orchestrator");
      const store = unwrap(await artifacts.openFilesystemArtifactStore({
        root: resolve(repositoryRoot, options?.artifactRoot ?? DEFAULT_ARTIFACT_ROOT),
        storeId: options?.storeId ?? DEFAULT_ARTIFACT_STORE_ID
      }));
      try {
        const engine = await git.GitIntegrationEngine.open({ repositoryPath: repositoryRoot, artifactStore: store });
        return { git: engine, artifactStore: store, async close() { store.close(); } };
      } catch (error) {
        store.close();
        throw error;
      }
    },
    verification(input) {
      const engine = new verification.VerificationEngine({
        artifactStore: input.artifactStore, gates: input.gates, loadSpecification: input.loadSpecification
      });
      return {
        createPlan: value => verification.createVerificationPlan(value),
        start: (plan, cycleId) => engine.start(plan, cycleId),
        verify: (plan, cycle, change, options) => engine.verify(plan, cycle, change, options as never)
      };
    }
  };
}

/** Specification port bound to a trusted ArtifactStore; the CLI never authorizes approvals. */
export async function bindSpecificationArtifacts(port: SpecificationPort, store: ArtifactStore): Promise<SpecificationPort> {
  const specification = await import("@bflow/specification");
  const engine = new specification.SpecificationEngine({ artifactStore: store, authorizeApprover: () => false });
  return { ...port, verifyArtifact: async spec => { await engine.verifyArtifact(spec); } };
}
