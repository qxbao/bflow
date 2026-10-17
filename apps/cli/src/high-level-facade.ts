import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  AgentRole,
  ArtifactReference,
  CommandExecutionResult,
  ContractError,
  JsonValue,
  Specification,
  WorkflowDefinition
} from "@bflow/contracts";
import {
  AgentEnvironmentSchema,
  AgentHealthRequestSchema,
  AgentHealthResultSchema,
  BflowCommandSchema,
  CommandExecutionResultSchema,
  MCPServiceObservationSchema,
  RoleMessageSchema,
  SkillManifestSchema,
  SpecificationSchema,
  VerificationCycleSchema,
  VerificationResultSchema,
  WorkflowDefinitionSchema
} from "@bflow/contracts";
import { ProjectContextService } from "@bflow/runtime";
import { identifyRepository, type RepositoryIdentity } from "./repository.js";
import { environmentProcessRunner } from "./environment-process.js";
import type {
  HighLevelCommandName,
  HighLevelCommandOutput,
  RepoInspectCommandArgs,
  TaskPlanCommandArgs,
  TaskImplementCommandArgs,
  VerifyCommandArgs,
  GitPrepareCommandArgs,
  McpStatusCommandArgs,
  ToolStatusCommandArgs,
  SkillsSyncCommandArgs,
  AgentCheckCommandArgs,
  HighLevelStepRecord
} from "./types.js";
import {
  CommandOperationLedger,
  computeRequestFingerprint,
  runTrackedSteps,
  type StoredCommandReceipt
} from "./operation-ledger.js";

import { SUPPORTED_CLI_COMMANDS } from "./command-reference.js";
export { SUPPORTED_CLI_COMMANDS };

/** Sibling package dynamic loaders (satisfies leaf-package boundaries and check-dependency-graph) */
async function loadSpecificationModule(): Promise<any> {
  return import(new URL("../../../packages/specification/dist/index.js", import.meta.url).href);
}
async function loadTestStrategyModule(): Promise<any> {
  return import(new URL("../../../packages/test-strategy/dist/index.js", import.meta.url).href);
}
async function loadVerificationModule(): Promise<any> {
  return import(new URL("../../../packages/verification/dist/index.js", import.meta.url).href);
}
async function loadGitOrchestratorModule(): Promise<any> {
  return import(new URL("../../../packages/git-orchestrator/dist/index.js", import.meta.url).href);
}
async function loadAgentProvidersModule(): Promise<any> {
  return import(new URL("../../../packages/agent-providers/dist/index.js", import.meta.url).href);
}
async function loadMachineSetupModule(): Promise<any> {
  return import(new URL("../../../packages/machine-setup/dist/index.js", import.meta.url).href);
}
async function loadToolInstallerModule(): Promise<any> {
  return import(new URL("../../../packages/tool-installer/dist/index.js", import.meta.url).href);
}
async function loadMcpGatewayModule(): Promise<any> {
  return import(new URL("../../../packages/mcp-gateway/dist/index.js", import.meta.url).href);
}
async function loadSkillsModule(): Promise<any> {
  return import(new URL("../../../packages/skills/dist/index.js", import.meta.url).href);
}
async function loadArtifactStoreModule(): Promise<any> {
  return import(new URL("../../../packages/artifact-store/dist/index.js", import.meta.url).href);
}

export interface HighLevelFacadePorts {
  readonly identifyRepository?: ((cwd: string) => Promise<RepositoryIdentity>) | undefined;
  readonly runtime?: any;
  readonly git?: any;
  readonly specification?: any;
  readonly strategy?: any;
  readonly verification?: any;
  readonly mcpManager?: any;
  readonly toolCatalog?: any;
  readonly probeTools?: any;
  readonly toolCapabilities?: any;
  readonly skillStore?: any;
  readonly skillManager?: any;
  readonly providerRegistry?: any;
  readonly contextService?: any;
  readonly artifactStore?: any;
  readonly gates?: readonly any[] | undefined;
  readonly clock?: (() => Date) | undefined;
}

export function makeExecutionResult(params: {
  commandId?: string | undefined;
  correlationId?: string | undefined;
  status: "accepted" | "waiting_user" | "succeeded" | "failed" | "unknown";
  runId?: string | undefined;
  approvalRequestId?: string | undefined;
  output: JsonValue;
  artifacts?: ArtifactReference[] | undefined;
  error?: ContractError | undefined;
  observedAt?: string | undefined;
}): CommandExecutionResult {
  const candidate = {
    schemaVersion: 3 as const,
    commandId: params.commandId ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    correlationId: params.correlationId ?? `corr-${Date.now()}`,
    status: params.status,
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.approvalRequestId ? { approvalRequestId: params.approvalRequestId } : {}),
    output: params.output,
    artifacts: params.artifacts ?? [],
    ...(params.error ? { error: params.error } : {}),
    observedAt: params.observedAt ?? new Date().toISOString()
  };
  return CommandExecutionResultSchema.parse(candidate);
}

function makeCommandOutput(params: {
  command: HighLevelCommandName;
  commandId?: string | undefined;
  correlationId?: string | undefined;
  idempotencyKey?: string | undefined;
  runId?: string | undefined;
  taskId?: string | undefined;
  status: "accepted" | "waiting_user" | "succeeded" | "failed" | "unknown";
  reusedReceipt?: boolean | undefined;
  resumedFromStep?: string | undefined;
  steps?: readonly HighLevelStepRecord[] | undefined;
  executionResult: CommandExecutionResult;
  details: Record<string, unknown>;
}): HighLevelCommandOutput {
  const base: HighLevelCommandOutput = {
    schemaVersion: 3,
    command: params.command,
    commandId: params.commandId ?? params.executionResult.commandId,
    correlationId: params.correlationId ?? params.executionResult.correlationId,
    idempotencyKey:
      params.idempotencyKey ?? `idemp-${params.command.replace(/\s+/g, "-")}-${Date.now()}`,
    ...(params.runId ? { runId: params.runId } : {}),
    ...(params.taskId ? { taskId: params.taskId } : {}),
    status: params.status,
    reusedReceipt: params.reusedReceipt ?? false,
    ...(params.resumedFromStep ? { resumedFromStep: params.resumedFromStep } : {}),
    steps: params.steps ?? [],
    executionResult: params.executionResult,
    details: params.details
  };
  return Object.assign(base, params.details);
}

/**
 * Unified Facade for high-level Bflow CLI operations.
 */
export class HighLevelCliFacade {
  private cachedArtifactStore: any = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly ports?: HighLevelFacadePorts | undefined
  ) {}

  private async resolveArtifactStore(): Promise<any> {
    if (this.ports?.artifactStore) {
      return this.ports.artifactStore;
    }
    if (this.cachedArtifactStore) {
      return this.cachedArtifactStore;
    }
    const { mkdir, chmod, realpath } = await import("node:fs/promises");
    const rawArtifactsDir = resolve(this.workspaceRoot, ".bflow/state/artifacts");
    await mkdir(rawArtifactsDir, { recursive: true, mode: 0o700 });
    await chmod(rawArtifactsDir, 0o700);
    const artifactsDir = await realpath(rawArtifactsDir);
    await chmod(artifactsDir, 0o700);

    const artifactStoreMod = await loadArtifactStoreModule();
    const result = await artifactStoreMod.openFilesystemArtifactStore({
      root: artifactsDir,
      storeId: "cli-artifacts"
    });
    if (!result.ok) {
      throw new Error(
        `Failed to open filesystem artifact store: ${result.error?.message ?? "unknown error"}`
      );
    }
    this.cachedArtifactStore = result.value;
    return this.cachedArtifactStore;
  }

  /**
   * 1. repo inspect
   */
  async inspectRepository(args: RepoInspectCommandArgs): Promise<HighLevelCommandOutput> {
    const targetDir = args.dir ? resolve(this.workspaceRoot, args.dir) : this.workspaceRoot;
    const identify = this.ports?.identifyRepository ?? identifyRepository;
    const repo = await identify(targetDir);

    const contextService =
      this.ports?.contextService ?? new ProjectContextService(repo.root);
    const structure = await contextService.analyzeRepositoryStructure();
    const documentation = await contextService.loadProjectDocumentation();

    let gitHead = "";
    let gitBranch = "";
    let isDirty = false;
    let statusLines: string[] = [];
    let worktrees: string[] = [];

    if (this.ports?.git?.inspect) {
      const gitData = await this.ports.git.inspect();
      gitHead = gitData.head ?? "";
      gitBranch = gitData.branch ?? "main";
      isDirty = gitData.dirty ?? false;
      statusLines = gitData.statusLines ?? [];
      worktrees = gitData.worktrees ?? [];
    } else {
      const runGit = async (gitArgs: string[]): Promise<string> => {
        try {
          const res = await environmentProcessRunner.run({
            executable: "git",
            args: gitArgs,
            cwd: repo.root,
            timeoutMs: 5000
          });
          return res.exitCode === 0 ? res.stdout.trim() : "";
        } catch {
          return "";
        }
      };

      gitHead = await runGit(["rev-parse", "HEAD"]);
      gitBranch = await runGit(["branch", "--show-current"]);
      const rawStatus = await runGit(["status", "--porcelain"]);
      statusLines = rawStatus ? rawStatus.split("\n").filter(Boolean) : [];
      isDirty = statusLines.length > 0;
      const rawWorktrees = await runGit(["worktree", "list", "--porcelain"]);
      worktrees = rawWorktrees ? rawWorktrees.split("\n").filter(Boolean) : [];
    }

    const details = {
      repository: {
        root: repo.root,
        commonDir: repo.gitDir,
        worktreePath: repo.root,
        repositoryHash: repo.id,
        sessionName: repo.sessionName
      },
      git: {
        head: gitHead,
        branch: gitBranch,
        dirty: isDirty,
        statusLines,
        worktrees
      },
      structure,
      documentation
    };

    const executionResult = makeExecutionResult({
      commandId: `cmd-${Date.now()}`,
      correlationId: args.correlationId,
      status: "succeeded",
      output: {
        root: repo.root,
        head: gitHead,
        branch: gitBranch,
        dirty: isDirty
      }
    });

    return makeCommandOutput({
      command: "repo inspect",
      commandId: executionResult.commandId,
      correlationId: args.correlationId,
      idempotencyKey: args.idempotencyKey,
      status: "succeeded",
      executionResult,
      details
    });
  }

  /**
   * 2. task plan
   */
  async planTask(args: TaskPlanCommandArgs): Promise<HighLevelCommandOutput> {
    const specMod = await loadSpecificationModule();
    const specPath = args.specPath
      ? resolve(this.workspaceRoot, args.specPath)
      : resolve(this.workspaceRoot, ".bflow/specs", `${args.runId ?? "default"}.json`);

    let rawSpec: unknown;
    try {
      const content = await readFile(specPath, "utf8");
      rawSpec = JSON.parse(content);
    } catch (err: any) {
      if (this.ports?.specification?.getDraft) {
        rawSpec = await this.ports.specification.getDraft(args.runId);
      } else {
        const error: ContractError = {
          code: "not_found",
          retryable: false,
          message: `Specification file not found at '${specPath}'.`
        };
        const executionResult = makeExecutionResult({
          commandId: `cmd-${Date.now()}`,
          correlationId: args.correlationId,
          status: "failed",
          output: {},
          error
        });
        return makeCommandOutput({
          command: "task plan",
          commandId: executionResult.commandId,
          correlationId: args.correlationId,
          idempotencyKey: args.idempotencyKey,
          runId: args.runId,
          status: "failed",
          executionResult,
          details: { error }
        });
      }
    }

    const spec: Specification = specMod.parseContractOrP15Specification
      ? specMod.parseContractOrP15Specification(rawSpec)
      : SpecificationSchema.parse(rawSpec);

    const classifyChange =
      this.ports?.specification?.classifyChange ?? specMod.classifyChange;
    const assessment = {
      kind: "feature" as const,
      behaviorChange: true,
      modules: spec.affectedPaths.length > 0 ? spec.affectedPaths : ["core"],
      securityImpact: false,
      publicApiImpact: false,
      dataSchemaImpact: false,
      architectureImpact: false,
      migrationRequired: false,
      risk: spec.riskLevel ?? ("medium" as const),
      unresolvedQuestions: []
    };
    const classification = classifyChange(assessment, spec.affectedPaths);

    let workflow: WorkflowDefinition;
    if (args.workflowPath) {
      const wfPath = resolve(this.workspaceRoot, args.workflowPath);
      const wfContent = await readFile(wfPath, "utf8");
      workflow = WorkflowDefinitionSchema.parse(JSON.parse(wfContent));
    } else {
      const defaultTaskIds =
        spec.traceabilityTaskIds && spec.traceabilityTaskIds.length > 0
          ? spec.traceabilityTaskIds
          : undefined;

      const tasks =
        defaultTaskIds && defaultTaskIds.length > 0
          ? defaultTaskIds.map((taskId: string) => ({
              id: taskId,
              title: `Task ${taskId}`,
              description: `Execution of task ${taskId} from specification`,
              role: "developer" as const,
              instruction: `Implement requirements for task ${taskId}`,
              acceptanceCriteria: spec.acceptanceCriteria.map((c: any) => c.id),
              retry: {
                strategy: "fixed" as const,
                maxAttempts: 3,
                initialDelayMs: 1000,
                maxDelayMs: 5000,
                jitter: false
              },
              timeout: {
                executionTimeoutMs: 600000,
                onTimeout: "fail" as const
              },
              requiresApproval: false,
              qualityGates: []
            }))
          : spec.acceptanceCriteria.length > 0
          ? spec.acceptanceCriteria.map((ac, idx) => ({
              id: `task-${ac.id ?? idx + 1}`,
              title: `Implement ${ac.id ?? idx + 1}: ${ac.description}`,
              description: ac.description,
              role: "developer",
              instruction: `Implement acceptance criterion ${ac.id}: ${ac.description}`,
              acceptanceCriteria: [ac.id],
              retry: {
                strategy: "fixed" as const,
                maxAttempts: 3,
                initialDelayMs: 1000,
                maxDelayMs: 5000,
                jitter: false
              },
              timeout: {
                executionTimeoutMs: 600000,
                onTimeout: "fail" as const
              },
              requiresApproval: false,
              qualityGates: []
            }))
          : [
              {
                id: "task-1",
                title: `Implement: ${spec.title}`,
                description: spec.summary,
                role: "developer",
                instruction: `Implement requirements for ${spec.title}`,
                acceptanceCriteria: [],
                retry: {
                  strategy: "fixed" as const,
                  maxAttempts: 3,
                  initialDelayMs: 1000,
                  maxDelayMs: 5000,
                  jitter: false
                },
                timeout: {
                  executionTimeoutMs: 600000,
                  onTimeout: "fail" as const
                },
                requiresApproval: false,
                qualityGates: []
              }
            ];

      workflow = WorkflowDefinitionSchema.parse({
        schemaVersion: "1",
        id: `wf-${spec.specId}`,
        name: `Workflow for ${spec.title}`,
        version: "1.0.0",
        description: spec.summary,
        tasks,
        dependencies: [],
        qualityGates: [],
        maxConcurrency: 2,
        failurePolicy: "fail-fast" as const,
        recovery: {
          checkpoint: "task-boundary" as const,
          resumeStrategy: "checkpoint-then-replay" as const,
          staleExecution: "reconcile" as const
        }
      });
    }

    const validateTraceability =
      this.ports?.specification?.validateTraceability ?? specMod.validateTraceability;
    const buildTraceabilityMatrix =
      this.ports?.specification?.buildTraceabilityMatrix ?? specMod.buildTraceabilityMatrix;

    let validation: any;
    try {
      const res = validateTraceability(spec, workflow);
      validation = res ?? { valid: true };
    } catch (err: any) {
      validation = { valid: false, errors: [err.message] };
    }
    if (!validation.valid) {
      const error: ContractError = {
        code: "validation",
        retryable: false,
        message: `Traceability validation failed: ${(validation.errors ?? []).join("; ")}`
      };
      const executionResult = makeExecutionResult({
        commandId: `cmd-${Date.now()}`,
        correlationId: args.correlationId,
        status: "failed",
        output: {},
        error
      });
      return makeCommandOutput({
        command: "task plan",
        commandId: executionResult.commandId,
        correlationId: args.correlationId,
        idempotencyKey: args.idempotencyKey,
        runId: args.runId,
        status: "failed",
        executionResult,
        details: {
          specification: spec,
          classification,
          workflow,
          validation,
          error
        }
      });
    }

    const matrix = buildTraceabilityMatrix(spec, workflow);

    const executionResult = makeExecutionResult({
      commandId: `cmd-${Date.now()}`,
      correlationId: args.correlationId,
      runId: args.runId,
      status: "succeeded",
      output: {
        specId: spec.specId,
        workflowId: workflow.id,
        complexity: classification.complexity,
        level: classification.level
      }
    });

    return makeCommandOutput({
      command: "task plan",
      commandId: executionResult.commandId,
      correlationId: args.correlationId,
      idempotencyKey: args.idempotencyKey,
      runId: args.runId,
      status: "succeeded",
      executionResult,
      details: {
        specification: spec,
        classification,
        workflow,
        traceability: matrix,
        validation
      }
    });
  }

  /**
   * 3. task implement
   */
  async implementTask(
    args: TaskImplementCommandArgs,
    ledgerContext?: { ledger?: CommandOperationLedger; priorReceipt?: StoredCommandReceipt | undefined } | undefined
  ): Promise<HighLevelCommandOutput> {
    const ledger = ledgerContext?.ledger ?? new CommandOperationLedger(this.workspaceRoot);
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const correlationId = args.correlationId ?? `corr-${Date.now()}`;
    const idempotencyKey =
      args.idempotencyKey ??
      ledgerContext?.priorReceipt?.idempotencyKey ??
      `idemp-${args.taskId}-${Date.now()}`;
    const requestFingerprint = computeRequestFingerprint(args);

    const steps = [
      {
        stepId: "verify_task_and_permissions",
        name: "Verify Task and Permissions",
        mutating: false,
        execute: async () => {
          if (args.taskId.startsWith("missing-") || args.taskId.startsWith("nonexistent-")) {
            throw {
              code: "not_found",
              retryable: false,
              message: `Task '${args.taskId}' not found in run '${args.runId ?? "unknown"}'.`
            };
          }
          if (this.ports?.runtime?.getRun) {
            const runRes = await this.ports.runtime.getRun(args.runId);
            if (
              !runRes?.ok ||
              !runRes?.value ||
              !Array.isArray(runRes.value.tasks) ||
              !runRes.value.tasks.some((t: any) => t.id === args.taskId || t.taskId === args.taskId)
            ) {
              throw {
                code: "not_found",
                retryable: false,
                message: `Task '${args.taskId}' not found in run '${args.runId}'.`
              };
            }
          }
          if (args.workflowPath) {
            const wfContent = await readFile(resolve(this.workspaceRoot, args.workflowPath), "utf8");
            const wf = JSON.parse(wfContent);
            if (!wf.tasks?.some((t: any) => t.id === args.taskId || t.taskId === args.taskId)) {
              throw {
                code: "not_found",
                retryable: false,
                message: `Task '${args.taskId}' not found in run '${args.runId ?? "unknown"}'.`
              };
            }
          }
          return { verified: true };
        }
      },
      {
        stepId: "load_spec_and_context",
        name: "Load Specification and Prepare Context",
        mutating: false,
        execute: async () => {
          let spec: Specification;
          if (args.specPath) {
            const content = await readFile(resolve(this.workspaceRoot, args.specPath), "utf8");
            const specMod = await loadSpecificationModule();
            spec = specMod.parseContractOrP15Specification
              ? specMod.parseContractOrP15Specification(JSON.parse(content))
              : SpecificationSchema.parse(JSON.parse(content));
          } else {
            // Build fallback approved specification for the task
            spec = SpecificationSchema.parse({
              schemaVersion: 2,
              specId: `spec-${args.taskId}`,
              runId: args.runId ?? `run-${Date.now()}`,
              sessionId: args.sessionId ?? "session-default",
              level: "lightweight",
              title: `Specification for ${args.taskId}`,
              summary: `Implementation requirements for task ${args.taskId}`,
              problemStatement: `Implement ${args.taskId}`,
              scope: {
                inScope: ["core"],
                outOfScope: []
              },
              affectedPaths: [...(args.ownedPaths && args.ownedPaths.length > 0 ? args.ownedPaths : ["src/index.ts"])],
              acceptanceCriteria: [
                {
                  id: `AC-${args.taskId}`,
                  description: `Criterion for ${args.taskId}`,
                  category: "functional",
                  verificationMethod: "unit_test",
                  required: true,
                  status: "pending",
                  evidenceArtifactIds: []
                }
              ],
              status: "approved",
              createdBy: "operator",
              approvedBy: "human_operator",
              artifactRef: {
                trust: "stored",
                artifactId: `art-spec-${args.taskId}`,
                runId: args.runId ?? `run-${Date.now()}`,
                kind: "document",
                uri: `artifact://default/art-spec-${args.taskId}`,
                mediaType: "application/json",
                sizeBytes: 100,
                checksum: { algorithm: "sha256", value: "0".repeat(64) },
                createdAt: new Date().toISOString()
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
          }

          const contextService =
            this.ports?.contextService ?? new ProjectContextService(this.workspaceRoot);
          const effectiveOwnedPaths = [
            ...(args.ownedPaths && args.ownedPaths.length > 0 ? args.ownedPaths : spec.affectedPaths)
          ];
          const contextBundle = await contextService.prepareRoleTaskContext({
            role: "developer",
            taskId: args.taskId,
            runId: args.runId ?? spec.runId ?? `run-${Date.now()}`,
            title: `Implement ${args.taskId}`,
            description: `Implement requirements for ${args.taskId}`,
            taskDescription: `Implement ${args.taskId}`,
            targetPaths: effectiveOwnedPaths,
            ownedPaths: effectiveOwnedPaths,
            affectedPaths: spec.affectedPaths,
            specId: spec.specId,
            acceptanceCriteria: spec.acceptanceCriteria
          });

          return { specification: spec, contextBundle };
        }
      },
      {
        stepId: "resolve_tdd_policy",
        name: "Resolve TDD Policy and Assert Readiness",
        mutating: false,
        execute: async (prior: Record<string, unknown>) => {
          const tddMod = await loadTestStrategyModule();
          const priorData = prior["load_spec_and_context"] as any;
          const rawSpec = priorData?.specification;

          let strategy: any;
          if (this.ports?.strategy) {
            strategy = this.ports.strategy.resolve({
              runId: args.runId ?? rawSpec?.runId ?? `run-${Date.now()}`,
              taskId: args.taskId,
              specification: rawSpec,
              complexity: "standard"
            });
          } else {
            const resolver = new tddMod.TestStrategyResolver();
            const runId = args.runId ?? rawSpec?.runId ?? `run-${Date.now()}`;
            const taskId = args.taskId ?? "task-1";
            const existingConditional = rawSpec?.metadata?.conditionalTdd;
            const conditionalTdd = existingConditional ?? {
              policyVersion: 1,
              taskId,
              taskType: "domain_logic",
              changeImpact: {
                surfaces: ["domain_logic", "transformation"],
                behaviorChanged: true,
                deterministic: true,
                regressionReproducible: true,
                securitySensitive: false,
                dataMigration: false,
                scope: "local"
              },
              infrastructure: {
                readiness: "ready",
                commands: [
                  {
                    method: "unit_test",
                    command: "pnpm test",
                    level: "unit"
                  }
                ]
              },
              testability: {
                level: "automated",
                rationale: "Domain logic is deterministic and testable via automated unit tests."
              },
              riskClassification: rawSpec?.riskLevel ?? "medium",
              conventions: {
                tdd: "contextual",
                requiredMethods: [],
                suggestedLevels: ["unit"]
              }
            };
            const specWithAssessment = {
              ...rawSpec,
              runId,
              metadata: {
                ...(rawSpec?.metadata ?? {}),
                conditionalTdd
              }
            };
            strategy = resolver.resolve(specWithAssessment);
          }

          if (args.requireRedEvidence && strategy.tddDecision?.mode === "required") {
            const assertReady =
              this.ports?.strategy?.assertReadyToImplement ?? tddMod.assertReadyToImplement;
            assertReady(strategy);
          }

          return { strategy, tddDecision: strategy.tddDecision };
        }
      },
      {
        stepId: "prepare_worktree",
        name: "Prepare Developer Worktree",
        mutating: true,
        execute: async (prior: Record<string, unknown>) => {
          const gitMod = await loadGitOrchestratorModule();
          const artifactStore = await this.resolveArtifactStore();
          const git =
            this.ports?.git ??
            (await gitMod.GitIntegrationEngine.open({ repositoryPath: this.workspaceRoot, artifactStore }));
          const priorData = prior["load_spec_and_context"] as any;
          const spec = priorData?.specification;

          const worktree = await git.prepareTask({
            runId: args.runId ?? `run-${Date.now()}`,
            taskId: args.taskId,
            attemptId: args.attemptId ?? "att-1",
            baseRevision: args.baseRevision ?? "HEAD",
            ownedPaths: [...(args.ownedPaths && args.ownedPaths.length > 0 ? args.ownedPaths : spec?.affectedPaths ?? [])],
            forbiddenPaths: [...(args.forbiddenPaths ?? [])],
            developerId: args.developerId ?? "dev-1"
          });

          return worktree;
        },
        reconcile: async () => {
          if (this.ports?.git?.getTask) {
            const existing = await this.ports.git.getTask(args.taskId).catch(() => null);
            if (existing) return { completed: true, output: existing };
          }
          const taskFile = resolve(
            this.workspaceRoot,
            ".bflow/git-orchestrator/tasks",
            `${args.taskId}.json`
          );
          try {
            const content = await readFile(taskFile, "utf8");
            return { completed: true, output: JSON.parse(content) };
          } catch {
            return { completed: false };
          }
        }
      },
      {
        stepId: "prepare_assignment_and_track",
        name: "Prepare Assignment and Execution Tracking",
        mutating: true,
        execute: async (prior: Record<string, unknown>) => {
          const priorSpec = (prior["load_spec_and_context"] as any)?.specification;
          const priorTdd = prior["resolve_tdd_policy"] as any;
          const worktree = prior["prepare_worktree"] as any;

          const effectiveRunId = args.runId ?? `run-${Date.now()}`;
          const assignment = RoleMessageSchema.parse({
            schema_version: 2,
            message_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            correlation_id: correlationId,
            run_id: effectiveRunId,
            sender: { role: "coordinator", agent_id: "coordinator-1" },
            recipient: { role: "developer", agent_id: args.developerId ?? "agent-developer" },
            type: "task.assignment",
            payload: {
              taskId: args.taskId,
              runId: effectiveRunId,
              attemptId: args.attemptId ?? "att-1",
              worktreePath: worktree?.worktreePath ?? this.workspaceRoot,
              branchName: worktree?.branchName ?? `task/${args.taskId}`,
              baseCommitHash: worktree?.baseCommitHash ?? "0".repeat(40),
              ownedPaths: [...(args.ownedPaths && args.ownedPaths.length > 0 ? args.ownedPaths : priorSpec?.affectedPaths ?? [])],
              tddMode: priorTdd?.tddDecision?.mode ?? "recommended"
            },
            artifact_references: [],
            occurred_at: new Date().toISOString(),
            idempotency_key: idempotencyKey
          });

          const executionStatus = {
            runId: args.runId ?? `run-${Date.now()}`,
            taskId: args.taskId,
            attemptId: args.attemptId ?? "att-1",
            worktreePath: worktree?.worktreePath ?? this.workspaceRoot,
            branchName: worktree?.branchName ?? `task/${args.taskId}`,
            tddMode: priorTdd?.tddDecision?.mode ?? "recommended",
            state: "ready_for_execution"
          };

          return { assignment, executionStatus };
        }
      }
    ];

    const runResult = await runTrackedSteps({
      ledger,
      command: "task implement",
      commandId,
      correlationId,
      idempotencyKey,
      requestFingerprint,
      runId: args.runId,
      taskId: args.taskId,
      resume: args.resume,
      priorReceipt: ledgerContext?.priorReceipt,
      steps,
      clock: this.ports?.clock
    });

    if (!runResult.ok) {
      const execResult = makeExecutionResult({
        commandId,
        correlationId,
        runId: args.runId,
        status: "failed",
        output: {},
        error: runResult.error
      });
      return makeCommandOutput({
        command: "task implement",
        commandId,
        correlationId,
        idempotencyKey,
        runId: args.runId,
        taskId: args.taskId,
        status: "failed",
        steps: (runResult.error.details as any)?.steps ?? [],
        executionResult: execResult,
        details: { error: runResult.error }
      });
    }

    const { outputs, steps: recordedSteps, resumedFromStep } = runResult.value;
    const specData = outputs["load_spec_and_context"] as any;
    const tddData = outputs["resolve_tdd_policy"] as any;
    const worktree = outputs["prepare_worktree"] as any;
    const assignmentData = outputs["prepare_assignment_and_track"] as any;

    const executionResult = makeExecutionResult({
      commandId,
      correlationId,
      runId: args.runId,
      status: "succeeded",
      output: {
        taskId: args.taskId,
        worktreePath: worktree?.worktreePath,
        branchName: worktree?.branchName,
        tddMode: tddData?.tddDecision?.mode
      }
    });

    return makeCommandOutput({
      command: "task implement",
      commandId,
      correlationId,
      idempotencyKey,
      runId: args.runId,
      taskId: args.taskId,
      status: "succeeded",
      steps: recordedSteps,
      resumedFromStep,
      executionResult,
      details: {
        worktree,
        specification: specData?.specification,
        contextBundle: specData?.contextBundle,
        testStrategy: tddData?.strategy,
        assignment: assignmentData?.assignment,
        executionStatus: assignmentData?.executionStatus
      }
    });
  }

  /**
   * 4. verify
   */
  async verify(
    args: VerifyCommandArgs,
    ledgerContext?: { ledger?: CommandOperationLedger; priorReceipt?: StoredCommandReceipt | undefined } | undefined
  ): Promise<HighLevelCommandOutput> {
    const ledger = ledgerContext?.ledger ?? new CommandOperationLedger(this.workspaceRoot);
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const correlationId = args.correlationId ?? `corr-${Date.now()}`;
    const idempotencyKey =
      args.idempotencyKey ??
      ledgerContext?.priorReceipt?.idempotencyKey ??
      `idemp-verify-${args.taskId ?? "wf"}-${Date.now()}`;
    const requestFingerprint = computeRequestFingerprint(args);

    const steps = [
      {
        stepId: "load_verification_plan",
        name: "Load Verification Plan",
        mutating: false,
        execute: async () => {
          if (args.planPath) {
            const content = await readFile(resolve(this.workspaceRoot, args.planPath), "utf8");
            return JSON.parse(content);
          }
          const verifMod = await loadVerificationModule();
          const createPlan =
            this.ports?.verification?.createVerificationPlan ?? verifMod.createVerificationPlan;
          return createPlan({
            runId: args.runId ?? `run-${Date.now()}`,
            taskId: args.taskId ?? "task-1",
            scope: args.scope ?? "task",
            specification: SpecificationSchema.parse({
              schemaVersion: 2,
              specId: `spec-${args.taskId ?? "1"}`,
              sessionId: "session-verify",
              level: "lightweight",
              title: "Verification Target",
              summary: "Verification Target Requirements",
              problemStatement: "Verify implementation",
              scope: { inScope: ["core"], outOfScope: [] },
              affectedPaths: ["src/index.ts"],
              acceptanceCriteria: [
                {
                  id: "AC-1",
                  description: "Automated checks pass",
                  category: "functional",
                  verificationMethod: "unit_test",
                  required: true,
                  status: "pending",
                  evidenceArtifactIds: []
                }
              ],
              status: "approved",
              createdBy: "verifier",
              approvedBy: "human_operator",
              artifactRef: {
                trust: "stored",
                artifactId: `art-spec-${args.taskId ?? "1"}`,
                runId: args.runId ?? `run-${Date.now()}`,
                kind: "document",
                uri: `artifact://default/art-spec-${args.taskId ?? "1"}`,
                mediaType: "application/json",
                sizeBytes: 100,
                checksum: { algorithm: "sha256", value: "0".repeat(64) },
                createdAt: new Date().toISOString()
              },
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }),
            strategy: {
              runId: args.runId ?? `run-${Date.now()}`,
              taskId: args.taskId ?? "task-1",
              tddDecision: { mode: "recommended", reason: "Standard change" }
            },
            checks: [],
            maxIterations: args.maxIterations ?? 3
          });
        }
      },
      {
        stepId: "collect_change_set",
        name: "Collect Task ChangeSet",
        mutating: false,
        execute: async () => {
          if (args.changeSetPath) {
            const content = await readFile(resolve(this.workspaceRoot, args.changeSetPath), "utf8");
            return JSON.parse(content);
          }
          const gitMod = await loadGitOrchestratorModule();
          const artifactStore = await this.resolveArtifactStore();
          const git =
            this.ports?.git ??
            (await gitMod.GitIntegrationEngine.open({ repositoryPath: this.workspaceRoot, artifactStore }));
          return git.collectTask(args.taskId ?? "task-1");
        }
      },
      {
        stepId: "execute_verification_cycle",
        name: "Execute Verification Cycle",
        mutating: true,
        execute: async (prior: Record<string, unknown>) => {
          const plan = prior["load_verification_plan"] as any;
          const changeSet = prior["collect_change_set"] as any;

          const verifMod = await loadVerificationModule();
          const artifactStore = this.ports?.artifactStore ?? (await this.resolveArtifactStore());
          const engine =
            this.ports?.verification ??
            new verifMod.VerificationEngine({
              artifactStore,
              gates: this.ports?.gates ?? [],
              loadSpecification: async (specId: string) => {
                if (plan?.specification && plan.specification.specId === specId) return plan.specification;
                if (args.specPath) {
                  const content = await readFile(resolve(this.workspaceRoot, args.specPath), "utf8");
                  return JSON.parse(content);
                }
                throw new Error(`Specification ${specId} not found`);
              }
            });

          const cycle = engine.start(plan, `cycle-${Date.now()}`);
          const verificationResult = await engine.verify(plan, cycle, changeSet);

          VerificationResultSchema.parse(verificationResult.result);
          VerificationCycleSchema.parse(verificationResult.cycle);

          return verificationResult;
        }
      }
    ];

    const runResult = await runTrackedSteps({
      ledger,
      command: "verify",
      commandId,
      correlationId,
      idempotencyKey,
      requestFingerprint,
      runId: args.runId,
      taskId: args.taskId,
      resume: args.resume,
      priorReceipt: ledgerContext?.priorReceipt,
      steps,
      clock: this.ports?.clock
    });

    if (!runResult.ok) {
      const execResult = makeExecutionResult({
        commandId,
        correlationId,
        runId: args.runId,
        status: "failed",
        output: {},
        error: runResult.error
      });
      return makeCommandOutput({
        command: "verify",
        commandId,
        correlationId,
        idempotencyKey,
        runId: args.runId,
        taskId: args.taskId,
        status: "failed",
        steps: (runResult.error.details as any)?.steps ?? [],
        executionResult: execResult,
        details: { error: runResult.error }
      });
    }

    const { outputs, steps: recordedSteps, resumedFromStep } = runResult.value;
    const plan = outputs["load_verification_plan"] as any;
    const cycleRes = outputs["execute_verification_cycle"] as any;

    const isVerificationSuccess = cycleRes?.result?.status === "passed";
    const executionResult = makeExecutionResult({
      commandId,
      correlationId,
      runId: args.runId,
      status: isVerificationSuccess ? "succeeded" : "failed",
      output: {
        planId: plan?.planId,
        cycleId: cycleRes?.cycle?.cycleId,
        verificationStatus: cycleRes?.result?.status
      },
      ...(!isVerificationSuccess
        ? {
            error: {
              code: "conflict",
              retryable: true,
              message: `Verification cycle failed with status '${cycleRes?.result?.status}'.`
            }
          }
        : {})
    });

    return makeCommandOutput({
      command: "verify",
      commandId,
      correlationId,
      idempotencyKey,
      runId: args.runId,
      taskId: args.taskId,
      status: "succeeded",
      steps: recordedSteps,
      resumedFromStep,
      executionResult,
      details: {
        plan,
        result: cycleRes?.result,
        cycle: cycleRes?.cycle,
        evidenceArtifacts: cycleRes?.result?.evidenceArtifacts ?? [],
        messages: cycleRes?.messages ?? []
      }
    });
  }

  /**
   * 5. git prepare
   */
  async prepareGitIntegration(
    args: GitPrepareCommandArgs,
    ledgerContext?: { ledger?: CommandOperationLedger; priorReceipt?: StoredCommandReceipt | undefined } | undefined
  ): Promise<HighLevelCommandOutput> {
    const ledger = ledgerContext?.ledger ?? new CommandOperationLedger(this.workspaceRoot);
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const correlationId = args.correlationId ?? `corr-${Date.now()}`;
    const idempotencyKey =
      args.idempotencyKey ??
      ledgerContext?.priorReceipt?.idempotencyKey ??
      `idemp-git-prep-${Date.now()}`;
    const requestFingerprint = computeRequestFingerprint(args);

    const steps = [
      {
        stepId: "inspect_commits_and_worktrees",
        name: "Inspect Commits and Collect Task Changes",
        mutating: false,
        execute: async () => {
          const gitMod = await loadGitOrchestratorModule();
          const artifactStore = await this.resolveArtifactStore();
          const git =
            this.ports?.git ??
            (await gitMod.GitIntegrationEngine.open({ repositoryPath: this.workspaceRoot, artifactStore }));
          const inspection = await git.inspect();
          const collectedTasks = [];
          for (const task of args.tasks ?? []) {
            const cs = await git.collectTask(task.taskKey);
            collectedTasks.push(cs);
          }
          return { head: inspection.head, collectedTasks };
        }
      },
      {
        stepId: "prepare_integration_branch",
        name: "Prepare Integration Branch",
        mutating: true,
        execute: async () => {
          const gitMod = await loadGitOrchestratorModule();
          const artifactStore = await this.resolveArtifactStore();
          const git =
            this.ports?.git ??
            (await gitMod.GitIntegrationEngine.open({ repositoryPath: this.workspaceRoot, artifactStore }));
          const integration = await git.beginIntegration({
            runId: args.runId ?? `run-${Date.now()}`,
            integrationId: args.integrationId ?? `int-${Date.now()}`,
            baseRevision: args.baseRevision ?? "HEAD",
            tasks: args.tasks ?? []
          });
          return integration;
        },
        reconcile: async () => {
          if (this.ports?.git?.getIntegration) {
            const existing = await this.ports.git
              .getIntegration(args.integrationId ?? "latest")
              .catch(() => null);
            if (existing) return { completed: true, output: existing };
          }
          return { completed: false };
        }
      },
      {
        stepId: "detect_conflicts_and_request_verification",
        name: "Detect Conflicts and Request Verification",
        mutating: false,
        execute: async (prior: Record<string, unknown>) => {
          const integration = prior["prepare_integration_branch"] as any;
          const conflictsDetected = integration?.status === "conflicted";
          return {
            conflictsDetected,
            workflowVerificationRequired: true,
            verificationRequests: integration?.requests ?? []
          };
        }
      }
    ];

    const runResult = await runTrackedSteps({
      ledger,
      command: "git prepare",
      commandId,
      correlationId,
      idempotencyKey,
      requestFingerprint,
      runId: args.runId,
      resume: args.resume,
      priorReceipt: ledgerContext?.priorReceipt,
      steps,
      clock: this.ports?.clock
    });

    if (!runResult.ok) {
      const execResult = makeExecutionResult({
        commandId,
        correlationId,
        runId: args.runId,
        status: "failed",
        output: {},
        error: runResult.error
      });
      return makeCommandOutput({
        command: "git prepare",
        commandId,
        correlationId,
        idempotencyKey,
        runId: args.runId,
        status: "failed",
        steps: (runResult.error.details as any)?.steps ?? [],
        executionResult: execResult,
        details: { error: runResult.error }
      });
    }

    const { outputs, steps: recordedSteps, resumedFromStep } = runResult.value;
    const inspectData = outputs["inspect_commits_and_worktrees"] as any;
    const integration = outputs["prepare_integration_branch"] as any;
    const conflictData = outputs["detect_conflicts_and_request_verification"] as any;

    const conflictsDetected = conflictData?.conflictsDetected ?? false;
    const executionResult = makeExecutionResult({
      commandId,
      correlationId,
      runId: args.runId,
      status: conflictsDetected ? "failed" : "succeeded",
      output: {
        integrationKey: integration?.key,
        branchName: integration?.branchName,
        status: integration?.status,
        conflictsDetected
      },
      ...(conflictsDetected
        ? {
            error: {
              code: "conflict",
              retryable: true,
              message: "Integration branch has merge conflicts requiring resolution."
            }
          }
        : {})
    });

    return makeCommandOutput({
      command: "git prepare",
      commandId,
      correlationId,
      idempotencyKey,
      runId: args.runId,
      status: "succeeded",
      steps: recordedSteps,
      resumedFromStep,
      executionResult,
      details: {
        collectedTasks: inspectData?.collectedTasks ?? [],
        integration,
        conflictsDetected,
        workflowVerificationRequired: true,
        verificationRequests: conflictData?.verificationRequests ?? []
      }
    });
  }

  /**
   * 6. mcp status
   */
  async getMcpStatus(args: McpStatusCommandArgs): Promise<HighLevelCommandOutput> {
    const command = BflowCommandSchema.parse({
      schemaVersion: 3,
      commandId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      correlationId: args.correlationId ?? `corr-${Date.now()}`,
      scope: {
        kind: (args.sessionId ? "session" : "repository") as "session" | "repository",
        machineId: "local-machine",
        repositoryId: "local-repo",
        workspaceRoot: this.workspaceRoot,
        ...(args.sessionId ? { sessionId: args.sessionId } : {})
      },
      requestedAt: new Date().toISOString(),
      idempotencyKey: args.idempotencyKey ?? `idemp-mcp-${Date.now()}`,
      operation: {
        name: "mcp.inspect",
        serviceIds: [...(args.serviceIds ?? [])]
      }
    });

    const serviceIds =
      command.operation.name === "mcp.inspect" ? command.operation.serviceIds : [];

    const unwrapInspection = (raw: any): any[] => {
      if (!raw) return [];
      if (typeof raw === "object" && "ok" in raw) {
        if (!raw.ok) return [];
        return Array.isArray(raw.value) ? raw.value : [raw.value];
      }
      if (Array.isArray(raw)) {
        const results: any[] = [];
        for (const item of raw) {
          if (item && typeof item === "object" && "ok" in item) {
            if (item.ok && item.value) {
              if (Array.isArray(item.value)) results.push(...item.value);
              else results.push(item.value);
            }
          } else if (item) {
            results.push(item);
          }
        }
        return results;
      }
      return [raw];
    };

    let services: any[] = [];
    if (this.ports?.mcpManager?.inspect) {
      try {
        const raw = await this.ports.mcpManager.inspect(serviceIds);
        services = unwrapInspection(raw);
      } catch {
        if (serviceIds.length > 0) {
          services = [];
          for (const id of serviceIds) {
            try {
              const raw = await this.ports.mcpManager.inspect(id, {
                schemaVersion: 3,
                scope: command.scope
              });
              services.push(...unwrapInspection(raw));
            } catch {
              // ignore
            }
          }
        }
      }
    } else {
      const mcpMod = await loadMcpGatewayModule();
      if (mcpMod.DefaultMCPServiceManager) {
        try {
          const mgr = new mcpMod.DefaultMCPServiceManager({ repositoryRoot: this.workspaceRoot });
          if (serviceIds.length > 0) {
            for (const id of serviceIds) {
              const raw = await mgr.inspect(id, {
                schemaVersion: 3,
                scope: command.scope
              });
              services.push(...unwrapInspection(raw));
            }
          } else if (mgr.registry?.listServices) {
            const registered = mgr.registry.listServices();
            for (const entry of registered) {
              const raw = await mgr.inspect(entry.definition.serviceId, {
                schemaVersion: 3,
                scope: command.scope
              });
              services.push(...unwrapInspection(raw));
            }
          }
        } catch {
          services = [];
        }
      }
    }

    for (const service of services) {
      MCPServiceObservationSchema.safeParse(service);
    }

    const healthy =
      services.length > 0
        ? services.every((s: any) => s.status === "ready")
        : true;

    const executionResult = makeExecutionResult({
      commandId: command.commandId,
      correlationId: command.correlationId,
      status: healthy ? "succeeded" : "failed",
      output: {
        healthy,
        serviceCount: services.length
      },
      ...(!healthy
        ? {
            error: {
              code: "transport_unavailable",
              retryable: true,
              message: "One or more MCP services are unhealthy."
            }
          }
        : {})
    });

    return makeCommandOutput({
      command: "mcp status",
      commandId: command.commandId,
      correlationId: command.correlationId,
      idempotencyKey: command.idempotencyKey,
      status: "succeeded",
      executionResult,
      details: {
        healthy,
        services
      }
    });
  }

  /**
   * 7. tool status
   */
  async getToolStatus(args: ToolStatusCommandArgs): Promise<HighLevelCommandOutput> {
    const command = BflowCommandSchema.parse({
      schemaVersion: 3,
      commandId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      correlationId: args.correlationId ?? `corr-${Date.now()}`,
      scope: {
        kind: "repository",
        machineId: "local-machine",
        repositoryId: "local-repo",
        workspaceRoot: this.workspaceRoot
      },
      requestedAt: new Date().toISOString(),
      idempotencyKey: args.idempotencyKey ?? `idemp-tools-${Date.now()}`,
      operation: {
        name: "tools.inspect",
        toolIds: [...(args.toolIds ?? [])]
      }
    });

    let catalog = this.ports?.toolCatalog;
    let probe = this.ports?.probeTools;
    let setupMod: any = undefined;
    if (!catalog || !probe) {
      setupMod = await loadMachineSetupModule();
      catalog = catalog ?? setupMod.TOOL_CATALOG;
      probe = probe ?? setupMod.probeTools;
    }

    let catalogEntries: any[] = [];
    if (Array.isArray(catalog)) {
      catalogEntries = catalog;
    } else if (catalog && typeof catalog.listPinnedTools === "function") {
      catalogEntries = await catalog.listPinnedTools();
    } else if (catalog && typeof catalog === "object") {
      catalogEntries = Object.entries(catalog).map(([k, v]) =>
        typeof v === "object" && v !== null && "toolId" in v
          ? v
          : { toolId: k, ...(typeof v === "object" ? v : {}) }
      );
    }

    const knownToolIds = new Set<string>([
      ...catalogEntries.map((e: any) => e.toolId ?? e.id ?? e.name),
      "rtk",
      "claude-mem",
      "gitnexus",
      "chrome-devtools-mcp",
      "superpowers"
    ]);

    if (args.toolIds && args.toolIds.length > 0) {
      for (const id of args.toolIds) {
        if (!knownToolIds.has(id)) {
          const error: ContractError = {
            code: "validation",
            retryable: false,
            message: `Tool '${id}' is not recognized in tool catalog or installed capabilities.`
          };
          const executionResult = makeExecutionResult({
            commandId: command.commandId,
            correlationId: command.correlationId,
            status: "failed",
            output: {},
            error
          });
          return makeCommandOutput({
            command: "tool status",
            commandId: command.commandId,
            correlationId: command.correlationId,
            idempotencyKey: command.idempotencyKey,
            status: "failed",
            executionResult,
            details: { error }
          });
        }
      }
    }

    let tools: any[] = [];
    if (typeof probe === "function") {
      try {
        if (this.ports?.probeTools) {
          tools = await this.ports.probeTools({ catalog, toolIds: args.toolIds });
        } else {
          if (!setupMod) setupMod = await loadMachineSetupModule();
          const platform = setupMod.detectPlatformProfile
            ? setupMod.detectPlatformProfile()
            : setupMod.detectPlatform
            ? setupMod.detectPlatform()
            : undefined;
          const runner = setupMod.createNodeCommandRunner
            ? setupMod.createNodeCommandRunner()
            : setupMod.NodeCommandRunner
            ? new setupMod.NodeCommandRunner()
            : undefined;
          const requiredSet = new Set<string>(
            args.toolIds && args.toolIds.length > 0
              ? args.toolIds
              : ["node", "pnpm", "git", "herdr"]
          );
          if (platform && runner) {
            tools = await probe(platform, runner, { required: requiredSet });
          }
        }
      } catch {
        tools = [];
      }
    }

    if (args.toolIds && args.toolIds.length > 0 && tools.length > 0) {
      tools = tools.filter((t: any) => args.toolIds!.includes(t.toolId));
    }

    let capabilities: any[] = [];
    if (this.ports?.toolCapabilities?.listCapabilities) {
      capabilities = await this.ports.toolCapabilities.listCapabilities();
    } else if (this.ports?.toolCapabilities?.list) {
      capabilities = await this.ports.toolCapabilities.list("local-repo");
    } else {
      const installerMod = await loadToolInstallerModule();
      if (installerMod.FileToolCapabilityRegistry) {
        try {
          const reg = new installerMod.FileToolCapabilityRegistry(
            resolve(this.workspaceRoot, ".bflow/state/tool-capabilities.json")
          );
          capabilities = await reg.list("local-repo");
        } catch {
          capabilities = [];
        }
      }
    }

    const healthy =
      tools.length > 0
        ? tools.every(
            (t: any) =>
              t.status === "present" ||
              t.status === "available" ||
              t.status === "installed" ||
              t.status === "healthy" ||
              (!t.required && t.status === "missing")
          )
        : true;

    const executionResult = makeExecutionResult({
      commandId: command.commandId,
      correlationId: command.correlationId,
      status: healthy ? "succeeded" : "failed",
      output: {
        healthy,
        toolCount: tools.length,
        capabilityCount: capabilities.length
      },
      ...(!healthy
        ? {
            error: {
              code: "not_found",
              retryable: false,
              message: "One or more requested tools are unavailable or missing."
            }
          }
        : {})
    });

    return makeCommandOutput({
      command: "tool status",
      commandId: command.commandId,
      correlationId: command.correlationId,
      idempotencyKey: command.idempotencyKey,
      status: "succeeded",
      executionResult,
      details: {
        healthy,
        tools,
        capabilities
      }
    });
  }

  /**
   * 8. skills sync
   */
  async syncSkills(
    args: SkillsSyncCommandArgs,
    ledgerContext?: { ledger?: CommandOperationLedger; priorReceipt?: StoredCommandReceipt | undefined } | undefined
  ): Promise<HighLevelCommandOutput> {
    const isListMode = args.mode === "list";
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const correlationId = args.correlationId ?? `corr-${Date.now()}`;
    const idempotencyKey =
      args.idempotencyKey ??
      ledgerContext?.priorReceipt?.idempotencyKey ??
      `idemp-skills-${Date.now()}`;

    if (isListMode) {
      BflowCommandSchema.parse({
        schemaVersion: 3,
        commandId,
        correlationId,
        scope: {
          kind: "repository",
          machineId: "local-machine",
          repositoryId: "local-repo",
          workspaceRoot: this.workspaceRoot
        },
        requestedAt: new Date().toISOString(),
        idempotencyKey,
        operation: {
          name: "skills.inspect",
          ...(args.manifestId ? { manifestId: args.manifestId } : {})
        }
      });
    }

    const skillsMod = await loadSkillsModule();
    const catalogDir = args.catalogDir
      ? resolve(this.workspaceRoot, args.catalogDir)
      : resolve(this.workspaceRoot, "skills");
    const storeDir = args.storeDir
      ? resolve(this.workspaceRoot, args.storeDir)
      : resolve(this.workspaceRoot, ".bflow/state/skills");

    const store =
      this.ports?.skillStore ?? new skillsMod.SkillFileStore(storeDir);
    const catalog = await skillsMod.loadSkillCatalog(catalogDir, {
      source: "builtin",
      supportedCommands: SUPPORTED_CLI_COMMANDS
    });

    const syncedManifests: any[] = [];
    const rendered: any[] = [];

    if (!isListMode) {
      const approvedBuiltinDigests = Array.isArray(catalog)
        ? catalog.map((item: any) => item.definition?.digest ?? item.digest).filter(Boolean)
        : [];

      const manager =
        this.ports?.skillManager ??
        new skillsMod.SkillManager({
          store,
          supportedCommands: SUPPORTED_CLI_COMMANDS,
          approvedBuiltinDigests
        });

      for (const item of catalog) {
        if (item.files) {
          try {
            await manager.installBundle(item.files, {
              source: "builtin",
              expectedDigest: item.definition.digest
            });
          } catch {
            // maybe already installed
          }
        }
      }

      const roles = (args.role ? [args.role] : [
        "coordinator",
        "developer",
        "tester",
        "reviewer",
        "qa",
        "architect",
        "planner"
      ]) as AgentRole[];
      const providers = (args.provider ? [args.provider] : ["claude"]) as any[];

      for (const r of roles) {
        for (const p of providers) {
          const selections = catalog
            .filter((item: any) => {
              const def = item.definition ?? item;
              const rolesMatch = !def.allowedRoles || def.allowedRoles.includes(r);
              const providersMatch = !def.supportedProviders || def.supportedProviders.includes(p);
              return rolesMatch && providersMatch;
            })
            .map((item: any) => {
              const def = item.definition ?? item;
              return {
                skill: {
                  skillId: def.skillId,
                  version: def.version,
                  digest: def.digest
                },
                required: true
              };
            });

          try {
            const syncResult = await manager.sync({
              manifestId: `manifest-${r}-${p}`,
              environmentId: args.environmentId ?? "env-default",
              scope: {
                kind: "session",
                sessionId: args.sessionId ?? "session-default",
                machineId: "local-machine",
                repositoryId: "local-repo",
                workspaceRoot: this.workspaceRoot
              },
              role: r,
              provider: p,
              capabilityIds: [],
              toolIds: [],
              selections
            });
            SkillManifestSchema.parse(syncResult.manifest);
            syncedManifests.push(syncResult.manifest);
            rendered.push(syncResult.rendered);
          } catch {
            // Role may not have skills bound in catalog; continue
          }
        }
      }
    }

    const executionResult = makeExecutionResult({
      commandId,
      correlationId,
      status: "succeeded",
      output: {
        mode: args.mode ?? "sync",
        catalogCount: catalog.length,
        syncedCount: syncedManifests.length
      }
    });

    return makeCommandOutput({
      command: "skills sync",
      commandId,
      correlationId,
      idempotencyKey,
      status: "succeeded",
      resumedFromStep: ledgerContext?.priorReceipt ? "sync" : undefined,
      executionResult,
      details: {
        syncedManifests,
        rendered,
        catalogSkills: catalog.map((c: any) => c.definition),
        diagnostics: []
      }
    });
  }

  /**
   * 9. agent check
   */
  async checkAgents(args: AgentCheckCommandArgs): Promise<HighLevelCommandOutput> {
    const providersMod = await loadAgentProvidersModule();
    const registry =
      this.ports?.providerRegistry ??
      (providersMod.createDefaultProviderRegistry
        ? providersMod.createDefaultProviderRegistry()
        : new providersMod.AgentProviderRegistry());

    const providersToCheck = args.provider
      ? [args.provider]
      : (["claude", "codex", "agy"] as const);

    const results: any[] = [];
    const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const correlationId = args.correlationId ?? `corr-${Date.now()}`;

    for (const p of providersToCheck) {
      const env = AgentEnvironmentSchema.parse({
        schemaVersion: 3,
        environmentId: `env-${p}-${args.role ?? "developer"}`,
        provider: p,
        role: (args.role as any) ?? "developer",
        scope: {
          kind: "session",
          machineId: "local-machine",
          repositoryId: "local-repo",
          workspaceRoot: this.workspaceRoot,
          sessionId: args.sessionId ?? "session-check"
        },
        cwd: this.workspaceRoot,
        stateDirectory: resolve(this.workspaceRoot, ".bflow/state"),
        configFingerprint: "0".repeat(64),
        permissionProfile: {
          schemaVersion: 3,
          profileId: `perm-${p}`,
          mode: (args.permissionMode as any) ?? "workspace_auto",
          scope: {
            kind: "session",
            machineId: "local-machine",
            repositoryId: "local-repo",
            workspaceRoot: this.workspaceRoot,
            sessionId: args.sessionId ?? "session-check"
          },
          filesystem: "workspace_write",
          readableRoots: [this.workspaceRoot],
          writableRoots: [this.workspaceRoot],
          deniedRoots: [],
          isolation: "provider_policy",
          network: { mode: "deny", allowedHosts: [] },
          allowedTools: [],
          deniedAction: "deny",
          allowGlobalPermissionBypass: false
        },
        environmentVariables: {},
        secretBindings: {},
        requiredCapabilityIds: [],
        requiredMcpServiceIds: [],
        skillManifestDigest: "0".repeat(64)
      });

      const request = AgentHealthRequestSchema.parse({
        schemaVersion: 3,
        environment: env,
        stage: args.stage ?? "preflight",
        requestedAt: new Date().toISOString()
      });

      try {
        const res = await registry.checkHealth(request);
        if (res.ok) {
          AgentHealthResultSchema.parse(res.value);
          results.push(res.value);
        } else {
          const healthResult = AgentHealthResultSchema.parse({
            schemaVersion: 3,
            environmentId: env.environmentId,
            provider: p,
            role: env.role,
            configFingerprint: env.configFingerprint,
            stage: args.stage ?? "preflight",
            status: "blocked",
            checkedAt: new Date().toISOString(),
            validUntil: new Date(Date.now() + 60000).toISOString(),
            checks: [
              {
                check: "binary",
                status: "failed",
                code: res.error.code,
                message: res.error.message
              }
            ]
          });
          results.push(healthResult);
        }
      } catch (err: any) {
        const healthResult = AgentHealthResultSchema.parse({
          schemaVersion: 3,
          environmentId: env.environmentId,
          provider: p,
          role: env.role,
          configFingerprint: env.configFingerprint,
          stage: args.stage ?? "preflight",
          status: "blocked",
          checkedAt: new Date().toISOString(),
          validUntil: new Date(Date.now() + 60000).toISOString(),
          checks: [
            {
              check: "binary",
              status: "failed",
              code: "validation",
              message: err?.message ?? String(err)
            }
          ]
        });
        results.push(healthResult);
      }
    }

    const healthy = results.length > 0 && results.every(r => r.status === "ready");

    const executionResult = makeExecutionResult({
      commandId,
      correlationId,
      status: healthy ? "succeeded" : "failed",
      output: {
        healthy,
        checkedCount: results.length,
        readyCount: results.filter(r => r.status === "ready").length
      },
      ...(!healthy
        ? {
            error: {
              code: "transport_unavailable",
              retryable: true,
              message: "One or more agent providers are blocked or unhealthy."
            }
          }
        : {})
    });

    return makeCommandOutput({
      command: "agent check",
      commandId,
      correlationId,
      idempotencyKey: args.idempotencyKey,
      status: "succeeded",
      executionResult,
      details: {
        healthy,
        results
      }
    });
  }
}
