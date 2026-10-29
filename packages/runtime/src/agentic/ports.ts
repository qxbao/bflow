import type {
  AgentExecutionHandle, AgentRequest, AgentResult, AgentTransport, ApprovalDecision, ApprovalRequest, ArtifactStore,
  AgentRole, GitChangeSet, JsonValue, OperationOptions, OperationResult, PaneBinding, QualityGate,
  QualityGateDefinition, QualityGateResult, RoleMessage, RunStore, SessionManifest, Specification, TestStrategy,
  VerificationCycle, VerificationResult, WorkflowDefinition, WorkflowEngine
} from "@bflow/contracts";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Package-local composition interfaces. Wire values always use frozen contracts. */
export interface SpecificationPolicy {
  createDraft(input: unknown): Specification;
  submitForReview(input: unknown): Promise<Specification>;
  requestApproval(input: unknown, options: unknown): Promise<ApprovalRequest>;
  approve(input: unknown, request: unknown, decision: unknown): Promise<Specification>;
  assertImplementationReady(input: unknown, request: unknown, decision: unknown, workflow: unknown): Promise<void>;
}
export interface StrategyPolicy {
  resolve(input: unknown): TestStrategy;
  validateAgainstSpecification(strategy: unknown, spec: unknown): TestStrategy;
}
export interface VerificationPlan {
  runId: string; taskId: string; scope: "task" | "workflow"; specification: Specification;
  strategy: TestStrategy; checks: QualityGateDefinition[]; implementerIds: string[];
  maxIterations: number; planId: string; specFingerprint: string;
  reviewWaiver?: unknown;
}
export interface VerificationPolicy {
  start(plan: VerificationPlan, cycleId: string): VerificationCycle;
  verify(plan: VerificationPlan, cycle: unknown, change: unknown, options?: unknown): Promise<{
    result: VerificationResult; cycle: VerificationCycle; messages: RoleMessage[];
  }>;
}
export interface TaskWorktree {
  key: string; worktreePath: string; branchName: string; baseCommitHash: string;
}
export interface Integration {
  key: string; worktreePath: string; branchName: string; expectedHead: string;
  status: string; requests: RoleMessage[]; merged: string[];
}
export interface GitPolicy {
  inspect(): Promise<{ head: string }>;
  prepareTask(request: {
    runId: string; taskId: string; attemptId: string; baseRevision: string;
    ownedPaths: string[]; forbiddenPaths: string[]; developerId: string;
    /** Verified dependency heads; with two or more, Git merges them into the task base (baseRevision is then the run base). */
    dependencyHeads?: string[];
  }): Promise<TaskWorktree>;
  collectTask(key: string): Promise<GitChangeSet>;
  beginIntegration(request: {
    runId: string; integrationId: string; baseRevision: string;
    tasks: { taskKey: string; dependsOn: string[] }[];
  }): Promise<Integration>;
  getIntegration(key: string): Promise<Integration>;
  resumeIntegration(key: string): Promise<Integration>;
  acceptConflictResolution(key: string, input: { taskKey: string; resolutionCommitHash: string }): Promise<Integration>;
  recordVerification(key: string, result: unknown): Promise<Integration>;
  cancelTask(key: string): Promise<unknown>;
  cancelIntegration(key: string): Promise<unknown>;
  treeOf?(revision: string): Promise<string>;
}
export interface PanePolicy {
  getManifest(options?: OperationOptions): Promise<OperationResult<SessionManifest | null>>;
  getRoleBinding(role: string, options?: OperationOptions): Promise<OperationResult<PaneBinding | null>>;
  inspectRoleHealth(role: string, options?: OperationOptions): Promise<OperationResult<{ readyForPrompt: boolean; occupantMatches: boolean; paneExists?: boolean; paneId: string; agentId: string }>>;
  allocateDeveloper(request: {
    taskId: string; runId: string; worktreePath: string; branchName: string; agentName: string;
    roleProfile?: import("@bflow/contracts").ResolvedRoleProfileSnapshot;
    failoverCandidate?: import("@bflow/contracts").FailoverCandidate;
    continuationId?: string;
    continuation?: import("@bflow/contracts").DeveloperContinuationAllocation;
  }, options?: OperationOptions): Promise<OperationResult<PaneBinding>>;
  allocateSpecialist?(request: { taskId: string; runId: string; role: import("@bflow/contracts").SpecialistRole;
    roleProfile: import("@bflow/contracts").ResolvedRoleProfileSnapshot; agentName?: string }, options?: OperationOptions): Promise<OperationResult<PaneBinding>>;
  releaseSpecialist?(request: { taskId?: string; agentId?: string; paneId?: string }, options?: OperationOptions): Promise<OperationResult<unknown>>;
  releaseDeveloper(request: { taskId: string; closePane: boolean; removeWorktree: boolean }, options?: OperationOptions): Promise<OperationResult<unknown>>;
  /** Cancelled, proven-stopped allocation: retain the pane/worktree for idempotent manifest cleanup. */
  releaseCancelledDeveloper?: (request: { taskId: string; closePane: boolean; removeWorktree: boolean }, options?: OperationOptions) => Promise<OperationResult<unknown>>;
}
export interface AgenticPolicies {
  specification: SpecificationPolicy;
  strategy: StrategyPolicy;
  verification: VerificationPolicy;
  git: GitPolicy;
  classifyChange(input: unknown, affectedPaths?: readonly string[]): {
    complexity: "trivial" | "standard" | "complex"; level: "lightweight" | "full";
    humanApprovalRequired: boolean; riskLevel: "low" | "medium" | "high" | "critical";
  };
  createVerificationPlan(input: unknown): VerificationPlan;
  recordEvidence(strategy: unknown, result: unknown): TestStrategy;
  assertReadyToImplement(strategy: unknown): void;
  assertEvidenceComplete(strategy: unknown): void;
}
export interface AgenticRuntimePorts {
  roleProfiles?: readonly import("@bflow/contracts").ResolvedRoleProfileSnapshot[];
  roleProfileDefaults?: Readonly<Partial<Record<AgentRole, import("@bflow/contracts").RoleProfilePin>>>;
  preflightRoleProfile?(snapshot: import("@bflow/contracts").ResolvedRoleProfileSnapshot, role: AgentRole, requiredCapabilities: readonly string[]): Promise<void>;
  attestExecutorLineage?(binding: PaneBinding, purpose: import("@bflow/contracts").ExecutorLineage["purpose"], assignmentId: string): Promise<import("@bflow/contracts").ExecutorLineage>;
  providerFailover?: {
    policyFor(binding: PaneBinding): { policy: import("@bflow/contracts").ProviderFailoverPolicy; current: import("@bflow/contracts").FailoverCandidate } | undefined;
    authenticate(binding: PaneBinding, failure: import("@bflow/contracts").ProviderFailureObservation): Promise<boolean>;
    assertMutationSafe(binding: PaneBinding, runId: string, taskId: string): Promise<void>;
    preflight(candidate: import("@bflow/contracts").FailoverCandidate, binding: PaneBinding): Promise<void>;
  };
  /** Host-owned current readonly resolution; absent is an explicit legacy host without historical drift protection. */
  readExecutionResolution?: import("./execution-binding.js").ExecutionResolutionReader;
  /** Physical Conversation hook only; not an agent tool or an approval inferred by a model. */
  authorizeReviewReplacement?: (authority: import("./native-diagnostic-fence.js").NativeDiagnosticFenceAuthority) => Promise<boolean>;
  authorizePolicyPhaseRetirement?: (authority: import("./native-diagnostic-fence.js").NativeDiagnosticFenceAuthority) => Promise<boolean>;
  hasPolicyPhaseReceipt?: (request: RoleMessage) => Promise<boolean>;
  authorizeNativeDiagnosticFence?(input: import("./native-diagnostic-fence.js").NativeDiagnosticFenceAuthority): Promise<boolean>;
  engine: WorkflowEngine; runStore: RunStore; artifactStore: ArtifactStore;
  registry: import("@bflow/contracts").AgentRegistry; transport: AgentTransport;
  panes: PanePolicy; policies: AgenticPolicies;
  pinDeveloperDispatch?: (request: AgentRequest, binding: PaneBinding) => Promise<void>;
  bindDeveloperExecutionScope?: (handle: AgentExecutionHandle, binding: PaneBinding) => Promise<void>;
  stopDeveloperExecutionScope?: (handle: AgentExecutionHandle, binding: PaneBinding) => Promise<import("./cancellation-stop.js").CancellationStopProof | undefined>;
  stopUnboundDeveloperScope?: (binding: PaneBinding) => Promise<import("./cancellation-stop.js").NamespaceExitProof | undefined>;
  /** Trusted host authentication of a Herdr-originated envelope, never an agent-supplied flag. */
  authenticateMessage(message: RoleMessage): Promise<boolean>;
  /**
   * Applies a Conversation-bound outbox RoleMessage to the Conversation Gateway, never by typing into the user's input box.
   * Must be idempotent per message_id: the outbox retries a failed or interrupted delivery.
   */
  deliverToConversation(message: RoleMessage): Promise<void>;
  /** Host validates remote correlation/runner identity. Herdr terminal `done` is insufficient. */
  authenticateResult(result: AgentResult, handle: AgentExecutionHandle, message: RoleMessage): Promise<boolean>;
  authenticateGateResult(result: QualityGateResult, message: RoleMessage): Promise<boolean>;
  authenticateEvidence(result: VerificationResult, message: RoleMessage): Promise<boolean>;
  projectApprovalRequired?(action: string, context: JsonValue): boolean;
  authorizeHuman(decision: ApprovalDecision): Promise<boolean>;
  /** Capabilities configured by the project owner, not inferred from an agent's prompt. */
  roleCapabilities: Readonly<Record<string, readonly string[]>>;
  /** Verifies requested capabilities against the current authenticated pane/session before any lease or transport side effect. */
  preflightRoleCapabilities?(binding: PaneBinding, required: readonly string[]): Promise<void>;
  /** Readonly current skill integrity/scope/expiry check; repeated across awaited dispatch boundaries without probes. */
  revalidateRoleSkills?(binding: PaneBinding): Promise<void>;
  maxConcurrency?: number;
  /** The concrete host can route P16 alternative-evidence requests to its measurement tools. */
  automaticAlternativeEvidence?: boolean;
  behavioralChecks?: (specification: Specification, strategy: TestStrategy, originalRevision?: string) => readonly QualityGateDefinition[];
  validateTaskCommands?: (specification: Specification, strategy: TestStrategy, ownedPaths: readonly string[]) => void;
  taskChecks: readonly QualityGateDefinition[];
  workflowChecks: readonly QualityGateDefinition[];
  fastPathMode?: "auto" | "off";
  clock?: () => Date;
}
export class RoleCapabilityPreflightError extends Error {
  readonly code = "role_capability_preflight";
  constructor(message: string) { super(message); this.name = "RoleCapabilityPreflightError"; }
}
export interface AgenticCompositionOptions {
  artifactStore: ArtifactStore; repositoryPath: string; gates: readonly QualityGate[];
  loadSpecification(specId: string): Promise<Specification>;
  authorizeApprover(decision: ApprovalDecision, humanRequired: boolean): boolean | Promise<boolean>;
  dynamicGates?: () => readonly QualityGate[];
  clock?: () => Date;
}
/** Loads the actual reviewed P15–P18 packages; no alternate policy implementations. */
export async function loadAgenticPolicies(options: AgenticCompositionOptions): Promise<AgenticPolicies> {
  const spec = await import("@bflow/specification");
  const tdd = await import("@bflow/test-strategy");
  const verification = await import("@bflow/verification");
  // Untyped as before the package-specifier import: local port types do not match the package declarations yet.
  const git: any = await import("@bflow/git-orchestrator");
  const engines = new Map<string, VerificationPolicy>();
  const activePlans = new Set<string>();
  const engineFor = (plan: VerificationPlan): VerificationPolicy => {
    let engine = engines.get(plan.planId);
    if (!engine) {
      const gates = [...options.gates, ...(options.dynamicGates?.() ?? [])];
      engine = new verification.VerificationEngine({ artifactStore: options.artifactStore,
        gates, loadSpecification: options.loadSpecification,
        ...(options.clock ? { clock: () => options.clock!().toISOString() } : {}) }) as VerificationPolicy;
      engines.set(plan.planId, engine);
    }
    return engine;
  };
  return {
    specification: new spec.SpecificationEngine({ artifactStore: options.artifactStore,
      authorizeApprover: options.authorizeApprover, ...(options.clock ? { clock: options.clock } : {}) }),
    strategy: new tdd.TestStrategyResolver(),
    verification: {
      start: (plan, cycleId) => engineFor(plan).start(plan, cycleId),
      verify: async (plan, cycle, change, input) => {
        if (activePlans.has(plan.planId)) throw new Error("Verification plan already has an active independent execution");
        activePlans.add(plan.planId);
        try { return await engineFor(plan).verify(plan, cycle, change, input); }
        finally { activePlans.delete(plan.planId); engines.delete(plan.planId); }
      }
    },
    // Developer agents edit these worktrees, and agent CLIs refuse writes under `.git`. `.bflow/state/` is ignored by the
    // init `.bflow/.gitignore`, and staying inside the checkout keeps the provider's folder trust for the repository.
    git: await (async () => {
      const gitEngine = await git.GitIntegrationEngine.open({ repositoryPath: options.repositoryPath, artifactStore: options.artifactStore,
        worktreeRoot: resolve(options.repositoryPath, ".bflow", "state", "worktrees") });
      gitEngine.treeOf = async (revision: string): Promise<string> => {
        if (typeof revision !== "string" || !/^[a-fA-F0-9]{7,40}$/.test(revision)) {
          throw new Error(`Invalid Git revision for tree lookup: ${String(revision)}`);
        }
        const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${revision}^{tree}`], {
          cwd: options.repositoryPath,
          encoding: "utf8"
        });
        const tree = stdout.trim();
        if (!/^[a-f0-9]{40}$/i.test(tree)) {
          throw new Error(`Invalid Git tree hash for revision ${revision}`);
        }
        return tree;
      };
      return gitEngine;
    })(),
    classifyChange: spec.classifyChange, createVerificationPlan: verification.createVerificationPlan,
    recordEvidence: tdd.recordEvidence, assertReadyToImplement: tdd.assertReadyToImplement,
    assertEvidenceComplete: tdd.assertEvidenceComplete
  };
}
export type WorkflowProposal = {
  definition: WorkflowDefinition;
  specification: Specification;
};
export type ToolInput = JsonValue;
