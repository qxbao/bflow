export {
  CLI_COMMAND_NAMES,
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
  type ConfigMigrateCommandArgs,
  type InitCommandOutput,
  type SetupCommandArgs,
  type SetupCommandOutput,
  type SetupIntegrationOptions,
  type CoreParsedCliCommand,
  type ParseCliResult,
  type ParsedCliCommand,
  type PresentationOptions,
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
export { parseConfigYaml, stringifyConfigYaml, renderEnvironmentConfigYaml } from "./config-format.js";
export { migrateRepositoryConfig, type ConfigMigrationOutput } from "./config-migration.js";
export { executeCodexHookSetup, formatCodexHookReview, formatCodexHookSetupOutput, codexHookSetupSucceeded,
  type CodexHookSetupOutcome, type CodexHookSetupOutput } from "./codex-hook-setup.js";
export { getHelpText } from "./help.js";
export {
  DEFAULT_CONFIG_RELATIVE_PATH,
  createDefaultWorkflowDefinition,
  createDefaultRepositoryConfig,
  resolveConfigPath,
  resolveReadableConfigPath,
  loadRepositoryConfig,
  loadWorkflowDefinitionFromFile,
  initRepositoryConfig
} from "./config.js";
export {
  formatCommandSuccess,
  formatCommandError,
  formatDownOutput,
  formatEnvironmentStatus,
  formatUpOutput
} from "./formatters.js";
export { CLI_VERSION, executeCommand, resolvePresentation, runCli } from "./commands.js";
export {
  composeCliRuntime,
  type ComposeCliRuntimeOptions,
  type ComposedCliRuntime
} from "./runtime.js";
export { main } from "./bin.js";
export {
  ProfileSetupComponent,
  ProfileSyncReportSchema,
  resolveProfileSetupOptions,
  type ProfileSetupOptions,
  type ProfileSyncReport
} from "./profile-setup.js";

export { EnvironmentLifecycle, EnvironmentError } from "./environment.js";
export type {
  EnvironmentIntegration,
  EnvironmentDependencies,
  EnvironmentCompositionInput,
  EnvironmentStatus,
  ProviderProbeOverride,
  McpLifecycleState
} from "./environment.js";
export {
  runDoctorDiagnostics,
  loadToolInstallerModule,
  loadSkillsModule,
  loadMcpGatewayModule,
  type DoctorCheckStatus,
  type DoctorGroupName,
  type DoctorDetailedCheck,
  type DoctorGroupedMetadata,
  type DoctorDiagnosticsOptions
} from "./doctor-integration.js";
export { identifyRepository } from "./repository.js";
export type { RepositoryIdentity } from "./repository.js";
export {
  readEnvironmentConfig,
  defaultEnvironmentConfig,
  ENVIRONMENT_CONFIG_PATH,
  EnvironmentProviderSchema,
  DEFAULT_PROVIDER_BY_CLI,
  EnvironmentRoleConfigSchema,
  EnvironmentConfigEnvironmentSchema,
  EnvironmentConfigSchema
} from "./environment-config.js";
export type { EnvironmentConfig, EnvironmentProvider, EnvironmentRoleConfig } from "./environment-config.js";
export {
  executeSetupCommand,
  issueSetupApproval,
  SpawnCommandRunner,
  DefaultProviderAdapterRegistry
} from "./setup-integration.js";
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
