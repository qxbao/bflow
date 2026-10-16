import type {
  AgentExecutionHandle, AgentResult, AgentTransport, ApprovalDecision, ApprovalRequest, ArtifactStore,
  GitChangeSet, JsonValue, OperationOptions, OperationResult, PaneBinding, QualityGate,
  QualityGateDefinition, QualityGateResult, RoleMessage, RunStore, SessionManifest, Specification, TestStrategy,
  VerificationCycle, VerificationResult, WorkflowDefinition, WorkflowEngine
} from "@bflow/contracts";

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
}
export interface PanePolicy {
  getManifest(options?: OperationOptions): Promise<OperationResult<SessionManifest | null>>;
  getRoleBinding(role: string, options?: OperationOptions): Promise<OperationResult<PaneBinding | null>>;
  inspectRoleHealth(role: string, options?: OperationOptions): Promise<OperationResult<{ readyForPrompt: boolean; occupantMatches: boolean; paneId: string; agentId: string }>>;
  allocateDeveloper(request: {
    taskId: string; runId: string; worktreePath: string; branchName: string; agentName: string;
  }, options?: OperationOptions): Promise<OperationResult<PaneBinding>>;
  releaseDeveloper(request: { taskId: string; closePane: boolean; removeWorktree: boolean }, options?: OperationOptions): Promise<OperationResult<unknown>>;
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
  engine: WorkflowEngine; runStore: RunStore; artifactStore: ArtifactStore;
  registry: import("@bflow/contracts").AgentRegistry; transport: AgentTransport;
  panes: PanePolicy; policies: AgenticPolicies;
  /** Trusted host authentication of a Herdr-originated envelope, never an agent-supplied flag. */
  authenticateMessage(message: RoleMessage): Promise<boolean>;
  /** Host validates remote correlation/runner identity. Herdr terminal `done` is insufficient. */
  authenticateResult(result: AgentResult, handle: AgentExecutionHandle, message: RoleMessage): Promise<boolean>;
  authenticateGateResult(result: QualityGateResult, message: RoleMessage): Promise<boolean>;
  authenticateEvidence(result: VerificationResult, message: RoleMessage): Promise<boolean>;
  projectApprovalRequired?(action: string, context: JsonValue): boolean;
  authorizeHuman(decision: ApprovalDecision): Promise<boolean>;
  /** Capabilities configured by the project owner, not inferred from an agent's prompt. */
  roleCapabilities: Readonly<Record<string, readonly string[]>>;
  maxConcurrency?: number;
  /** The concrete host can route P16 alternative-evidence requests to its measurement tools. */
  automaticAlternativeEvidence?: boolean;
  taskChecks: readonly QualityGateDefinition[];
  workflowChecks: readonly QualityGateDefinition[];
  clock?: () => Date;
}
export interface AgenticCompositionOptions {
  artifactStore: ArtifactStore; repositoryPath: string; gates: readonly QualityGate[];
  loadSpecification(specId: string): Promise<Specification>;
  authorizeApprover(decision: ApprovalDecision, humanRequired: boolean): boolean | Promise<boolean>;
  clock?: () => Date;
}
/** Loads the actual reviewed P15–P18 packages; no alternate policy implementations. */
export async function loadAgenticPolicies(options: AgenticCompositionOptions): Promise<AgenticPolicies> {
  const spec = await import(new URL("../../../specification/dist/index.js", import.meta.url).href);
  const tdd = await import(new URL("../../../test-strategy/dist/index.js", import.meta.url).href);
  const verification = await import(new URL("../../../verification/dist/index.js", import.meta.url).href);
  const git = await import(new URL("../../../git-orchestrator/dist/index.js", import.meta.url).href);
  return {
    specification: new spec.SpecificationEngine({ artifactStore: options.artifactStore,
      authorizeApprover: options.authorizeApprover, ...(options.clock ? { clock: options.clock } : {}) }),
    strategy: new tdd.TestStrategyResolver(),
    verification: new verification.VerificationEngine({ artifactStore: options.artifactStore,
      gates: options.gates, loadSpecification: options.loadSpecification,
      ...(options.clock ? { clock: () => options.clock!().toISOString() } : {}) }),
    git: await git.GitIntegrationEngine.open({ repositoryPath: options.repositoryPath, artifactStore: options.artifactStore }),
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
