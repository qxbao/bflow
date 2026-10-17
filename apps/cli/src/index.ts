export {
  CLI_EXIT_CODES,
  type ApproveCommandArgs,
  type CancelCommandArgs,
  type CliCommandData,
  type CliCommandName,
  type CliContext,
  type CliExecutionResult,
  type CliExitCode,
  type CliIo,
  type CliJsonEnvelope,
  type CliJsonErrorEnvelope,
  type CliJsonSuccessEnvelope,
  type BflowRepositoryConfig,
  type FlowRepositoryConfig,
  type GlobalCliFlags,
  type HelpCommandArgs,
  type InitCommandArgs,
  type InitCommandOutput,
  type ParseCliResult,
  type ParsedCliCommand,
  type ResumeCommandArgs,
  type RunCommandArgs,
  type StatusCommandArgs,
  type VersionCommandArgs,
  type ApprovalDecision,
  type CancellationRequest,
  type ContractError,
  type OperationOptions,
  type Page,
  type ResumeRunInput,
  type RunStatus,
  type RuntimeService,
  type StartRunInput,
  type WorkflowDefinition,
  type WorkflowRunSnapshot,
  type RuntimeServicePort,
  type HighLevelCommandName,
  type HighLevelCommonFlags,
  type RepoInspectCommandArgs,
  type TaskPlanCommandArgs,
  type TaskImplementCommandArgs,
  type VerifyCommandArgs,
  type GitPrepareCommandArgs,
  type GitPrepareTaskDependencyInput,
  type McpStatusCommandArgs,
  type ToolStatusCommandArgs,
  type SkillsSyncCommandArgs,
  type AgentCheckCommandArgs,
  type HighLevelParsedCliCommand,
  type HighLevelStepRecord,
  type HighLevelCommandOutput,
  type HighLevelFacadeServices,
  type CommandExecutionResult
} from "./types.js";

export { parseCliArgs } from "./parser.js";
export { getHelpText } from "./help.js";
export {
  DEFAULT_CONFIG_RELATIVE_PATH,
  createDefaultWorkflowDefinition,
  createDefaultRepositoryConfig,
  resolveConfigPath,
  loadRepositoryConfig,
  loadWorkflowDefinitionFromFile,
  initRepositoryConfig
} from "./config.js";
export { formatCommandSuccess, formatCommandError } from "./formatters.js";
export { CLI_VERSION, executeCommand, runCli } from "./commands.js";
export {
  composeCliRuntime,
  type ComposeCliRuntimeOptions,
  type ComposedCliRuntime
} from "./runtime.js";
export { main } from "./bin.js";

export { EnvironmentLifecycle, EnvironmentError } from "./environment.js";
export type { EnvironmentIntegration, EnvironmentDependencies, EnvironmentCompositionInput, EnvironmentStatus } from "./environment.js";
export { identifyRepository } from "./repository.js";
export type { RepositoryIdentity } from "./repository.js";
export { readEnvironmentConfig, defaultEnvironmentConfig, ENVIRONMENT_CONFIG_PATH } from "./environment-config.js";
export type { EnvironmentConfig } from "./environment-config.js";
export { environmentProcessRunner, namedSessionEnvironment } from "./environment-process.js";
export type { EnvironmentProcessRunner, EnvironmentProcessRequest, EnvironmentProcessResult } from "./environment-process.js";
export { PaneManagerLifecycleAdapter, createNamedPaneRunner, openPaneManagerEnvironment } from "./pane-manager-integration.js";
export type { LifecycleHost, LifecycleHostFactory, HostRoleLaunch } from "./agentic-host.js";

export {
  SUPPORTED_CLI_COMMANDS,
  type SupportedCliCommand,
  CLI_COMMAND_REFERENCE,
  type CliCommandReferenceEntry,
  renderCommandReferenceMarkdown
} from "./command-reference.js";

export interface CliCommandFlagReference {
  readonly flag: string;
  readonly description?: string;
  readonly required?: boolean;
}

export {
  CommandOperationLedger,
  computeRequestFingerprint,
  withCommandLock,
  enforceCommandGovernance,
  runTrackedSteps,
  PROTECTED_BRANCH_REGEX,
  PRODUCTION_ENV_REGEX,
  type StoredCommandReceipt,
  type IdempotencyAction,
  type TrackedStepDef,
  type TrackedStepDef as TrackedStepDefinition,
  type RunTrackedStepsOptions,
  type RunTrackedStepsResult,
  type CommandGovernanceInput,
  type CommandGovernanceInput as GovernanceCheckInput
} from "./operation-ledger.js";

export {
  HighLevelCliFacade,
  makeExecutionResult,
  type HighLevelFacadePorts
} from "./high-level-facade.js";

export {
  isHighLevelCommand,
  executeHighLevelCommand,
  type HighLevelExecutionResult
} from "./high-level-commands.js";

export {
  HIGH_LEVEL_COMMAND_SPECS,
  getHighLevelHelp,
  isHighLevelInvocation,
  runHighLevelCli
} from "./high-level/index.js";
export type { HighLevelRunOptions, HighLevelRunResult } from "./high-level/index.js";
export {
  CommandOutcomeSchema,
  CommandStepSchema,
  HIGH_LEVEL_COMMANDS,
  HIGH_LEVEL_EXIT_CODES,
  HighLevelEnvelopeSchema,
  HighLevelOutputSchema
} from "./high-level/envelope.js";
export type { CommandOutcome, CommandStep, HighLevelEnvelope, HighLevelExitCode, HighLevelOutput } from "./high-level/envelope.js";
export { CommandJournal, JournalRecordSchema, requestDigest } from "./high-level/journal.js";
export {
  bindSpecificationArtifacts,
  createDefaultHighLevelServices,
  DEFAULT_ARTIFACT_ROOT,
  DEFAULT_ARTIFACT_STORE_ID
} from "./high-level/services.js";
export type {
  GitOrchestratorPort,
  HighLevelResources,
  HighLevelServices,
  MachinePort,
  McpGatewayPort,
  ProviderPort,
  SpecificationPort,
  StrategyPort,
  VerificationPort
} from "./high-level/services.js";
export { deriveTaskGraph } from "./high-level/commands/task-plan.js";
export { describeHighLevelCommands } from "./high-level/reference.js";
