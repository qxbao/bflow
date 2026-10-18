import type { EnvironmentDependencies, EnvironmentStatus } from "./environment.js";
import type { EnvironmentDoctorReport, SessionManifest, MachineSetupPlan as SetupPlan, SetupReceipt, ToolInstaller } from "@bflow/contracts";
import type {
  ApprovalDecision,
  CancellationRequest,
  CommandExecutionResult,
  ContractError,
  OperationOptions,
  Page,
  ResumeRunInput,
  RunStatus,
  RuntimeService,
  StartRunInput,
  WorkflowDefinition,
  WorkflowRunSnapshot
} from "@bflow/contracts";
import type { ConcreteRuntimeService } from "@bflow/runtime";
import type { HighLevelEnvelope, HighLevelExitCode } from "./high-level/envelope.js";
import type { HighLevelServices } from "./high-level/services.js";

export type HighLevelCommandName =
  | "repo inspect"
  | "task plan"
  | "task implement"
  | "verify"
  | "git prepare"
  | "mcp status"
  | "tool status"
  | "skills sync"
  | "agent check";

export const CLI_COMMAND_NAMES = [
  "up",
  "down",
  "attach",
  "recover",
  "doctor",
  "init",
  "setup",
  "run",
  "status",
  "approve",
  "resume",
  "cancel",
  "help",
  "version"
] as const;

export type CliCommandName =
  | "up"
  | "down"
  | "attach"
  | "recover"
  | "doctor"
  | "init"
  | "setup"
  | "run"
  | "status"
  | "approve"
  | "resume"
  | "cancel"
  | "help"
  | "version"
  | HighLevelCommandName;

export const CLI_EXIT_CODES = {
  SUCCESS: 0,
  RUNTIME_ERROR: 1,
  USAGE_ERROR: 2
} as const;

/** Legacy commands use 0–2; high-level commands extend this with codes 3–7 (see HIGH_LEVEL_EXIT_CODES). */
export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES] | HighLevelExitCode;

export interface GlobalCliFlags {
  readonly json: boolean;
  readonly help: boolean;
}

export interface InitCommandArgs extends GlobalCliFlags {
  readonly command: "init";
  readonly dir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly projectName?: string | undefined;
  readonly provider?: "claude" | "codex" | "agy" | undefined;
  readonly force: boolean;
}

export interface SetupCommandArgs extends GlobalCliFlags {
  readonly command: "setup";
  readonly mode: "check" | "dry_run" | "apply" | "repair";
  readonly yes: boolean;
  readonly dir?: string | undefined;
  readonly catalogDir?: string | undefined;
  readonly memoryProvider?: "auto" | "claude" | "codex" | "host" | undefined;
}

export interface SetupCommandOutput {
  readonly mode: "check" | "dry_run" | "apply" | "repair";
  readonly machineId: string;
  readonly os: string;
  readonly serviceManagerKind: "systemd-user" | "launchd" | "windows-unverified";
  /** Isolation namespace of OS unit names (isolated setup only); units are named bflow-<namespace>-<service>. */
  readonly serviceUnitNamespace?: string;
  readonly plan: SetupPlan;
  readonly receipt?: SetupReceipt;
  readonly receipts?: readonly SetupReceipt[];
  readonly inventory?: readonly import("./setup-defaults.js").DefaultSetupInventory[];
  readonly outcome?: import("@bflow/machine-setup").SetupOutcome;
  readonly doctor?: import("@bflow/machine-setup").MachineDoctorReport;
  readonly tools: readonly { toolId: string; status: string; version?: string }[];
  readonly skills: {
    readonly catalogLoaded: boolean;
    readonly skillCount: number;
    readonly syncedManifests: number;
    readonly installedSkillCount?: number;
    readonly storeRoot: string;
  };
  readonly diagnostics: readonly string[];
}

export interface SetupIntegrationOptions {
  readonly confirm?: ((preview: string) => Promise<boolean>) | undefined;
  readonly platform?: import("@bflow/machine-setup").PlatformProfile | undefined;
  readonly runner?: import("@bflow/machine-setup").CommandRunner | undefined;
  readonly machineConfig?: import("@bflow/machine-setup").MachineConfig | undefined;
  readonly catalogDir?: string | undefined;
  readonly serviceManager?: import("@bflow/machine-setup").ServiceManager | undefined;
  readonly providers?: import("@bflow/agent-providers").AgentProviderRegistry | undefined;
  readonly toolInstaller?: ToolInstaller | import("@bflow/machine-setup").ToolInstallerRegistry | undefined;
  readonly skillManager?: any;
  readonly machineSetup?: any;
  readonly isolatedRoot?: string | undefined;
}

export interface EnvironmentCommandArgs extends GlobalCliFlags {
  readonly command: "up" | "down" | "attach" | "doctor" | "recover";
  readonly timeoutMs?: number | undefined;
  readonly yes: boolean;
}

export interface RunCommandArgs extends GlobalCliFlags {
  readonly command: "run";
  readonly requirement: string;
  readonly runId?: string | undefined;
  readonly workflowPath?: string | undefined;
  readonly configPath?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface StatusCommandArgs extends GlobalCliFlags {
  readonly command: "status";
  readonly runId?: string | undefined;
  readonly statusFilter?: readonly RunStatus[] | undefined;
  readonly workflowId?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface ApproveCommandArgs extends GlobalCliFlags {
  readonly command: "approve";
  readonly taskId: string;
  readonly runId?: string | undefined;
  readonly decidedBy?: string | undefined;
  readonly decision: "approved" | "rejected" | "changes_requested";
  readonly reason?: string | undefined;
  readonly approvalId?: string | undefined;
  readonly revision?: number | undefined;
  readonly generation?: number | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface ResumeCommandArgs extends GlobalCliFlags {
  readonly command: "resume";
  readonly runId: string;
  readonly idempotencyKey?: string | undefined;
}

export interface CancelCommandArgs extends GlobalCliFlags {
  readonly command: "cancel";
  readonly runId: string;
  readonly reason?: string | undefined;
  readonly requestedBy?: string | undefined;
  readonly taskId?: string | undefined;
  readonly expectedVersion?: number | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface HelpCommandArgs extends GlobalCliFlags {
  readonly command: "help";
  readonly topic?: CliCommandName | undefined;
}

export interface VersionCommandArgs extends GlobalCliFlags {
  readonly command: "version";
}

export interface HighLevelCommonFlags extends GlobalCliFlags {
  readonly correlationId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly resume: boolean;
  readonly actor?: string | undefined;
  readonly role?: string | undefined;
  readonly permissionMode?: "restricted" | "workspace_auto" | "unattended_isolated" | undefined;
  readonly sessionId?: string | undefined;
  readonly isolation?: "provider_policy" | "os_sandbox" | "container" | undefined;
}

export interface RepoInspectCommandArgs extends HighLevelCommonFlags {
  readonly command: "repo inspect";
  readonly dir?: string | undefined;
  readonly includeFiles: boolean;
  readonly maxFiles?: number | undefined;
}

export interface TaskPlanCommandArgs extends HighLevelCommonFlags {
  readonly command: "task plan";
  readonly specPath: string;
  readonly workflowPath?: string | undefined;
  readonly runId?: string | undefined;
}

export interface TaskImplementCommandArgs extends HighLevelCommonFlags {
  readonly command: "task implement";
  readonly taskId: string;
  readonly runId: string;
  readonly specPath?: string | undefined;
  readonly workflowPath?: string | undefined;
  readonly attemptId?: string | undefined;
  readonly baseRevision?: string | undefined;
  readonly ownedPaths: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly developerId?: string | undefined;
  readonly requireRedEvidence: boolean;
  readonly targetBranch?: string | undefined;
  readonly environmentName?: string | undefined;
  readonly autoApprove: boolean;
  readonly approvedBy?: string | undefined;
}

export interface VerifyCommandArgs extends HighLevelCommonFlags {
  readonly command: "verify";
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly scope: "task" | "workflow";
  readonly specPath?: string | undefined;
  readonly planPath?: string | undefined;
  readonly changeSetPath?: string | undefined;
  readonly cyclePath?: string | undefined;
  readonly maxIterations?: number | undefined;
}

export interface GitPrepareTaskDependencyInput {
  readonly taskKey: string;
  readonly dependsOn: readonly string[];
}

export interface GitPrepareCommandArgs extends HighLevelCommonFlags {
  readonly command: "git prepare";
  readonly runId: string;
  readonly integrationId?: string | undefined;
  readonly baseRevision?: string | undefined;
  readonly tasks: readonly GitPrepareTaskDependencyInput[];
  readonly targetBranch?: string | undefined;
  readonly environmentName?: string | undefined;
  readonly autoApprove: boolean;
  readonly approvedBy?: string | undefined;
}

export interface McpStatusCommandArgs extends HighLevelCommonFlags {
  readonly command: "mcp status";
  readonly serviceIds: readonly string[];
}

export interface ToolStatusCommandArgs extends HighLevelCommonFlags {
  readonly command: "tool status";
  readonly toolIds: readonly string[];
}

export interface SkillsSyncCommandArgs extends HighLevelCommonFlags {
  readonly command: "skills sync";
  readonly mode: "sync" | "list";
  readonly provider?: "claude" | "codex" | "agy" | undefined;
  readonly manifestId?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly catalogDir?: string | undefined;
  readonly storeDir?: string | undefined;
}

export interface AgentCheckCommandArgs extends HighLevelCommonFlags {
  readonly command: "agent check";
  readonly provider?: "claude" | "codex" | "agy" | undefined;
  readonly stage: "preflight" | "activated";
  readonly environmentId?: string | undefined;
}

export type HighLevelParsedCliCommand =
  | RepoInspectCommandArgs
  | TaskPlanCommandArgs
  | TaskImplementCommandArgs
  | VerifyCommandArgs
  | GitPrepareCommandArgs
  | McpStatusCommandArgs
  | ToolStatusCommandArgs
  | SkillsSyncCommandArgs
  | AgentCheckCommandArgs;

export type CoreParsedCliCommand =
  | EnvironmentCommandArgs
  | InitCommandArgs
  | SetupCommandArgs
  | RunCommandArgs
  | StatusCommandArgs
  | ApproveCommandArgs
  | ResumeCommandArgs
  | CancelCommandArgs
  | HelpCommandArgs
  | VersionCommandArgs;

export type ParsedCliCommand =
  | CoreParsedCliCommand
  | HighLevelParsedCliCommand;

export type ParseCliResult =
  | { readonly ok: true; readonly value: ParsedCliCommand }
  | {
      readonly ok: false;
      readonly error: ContractError;
      readonly command?: CliCommandName | undefined;
      readonly json: boolean;
    };

export interface BflowRepositoryConfig {
  readonly schemaVersion: "1";
  readonly projectName: string;
  readonly runtimeId: string;
  readonly createdAt: string;
  readonly storage: {
    readonly runStorePath: string;
    readonly artifactStoreRoot: string;
    readonly registryStateFile: string;
  };
  readonly defaultWorkflow: WorkflowDefinition;
}

export type FlowRepositoryConfig = BflowRepositoryConfig;

export interface InitCommandOutput {
  readonly configPath: string;
  readonly config: BflowRepositoryConfig;
  readonly overwritten: boolean;
}

export interface HighLevelStepRecord {
  readonly stepId: string;
  readonly name: string;
  readonly status: "succeeded" | "failed" | "skipped" | "unknown";
  readonly mutating: boolean;
  readonly startedAt: string;
  readonly completedAt?: string | undefined;
  readonly output?: unknown;
  readonly error?: ContractError | undefined;
}

export interface HighLevelCommandOutput {
  readonly schemaVersion: 3;
  readonly command: HighLevelCommandName;
  readonly commandId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly runId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly status: "accepted" | "waiting_user" | "succeeded" | "failed" | "unknown";
  readonly reusedReceipt: boolean;
  readonly resumedFromStep?: string | undefined;
  readonly steps: readonly HighLevelStepRecord[];
  readonly executionResult: CommandExecutionResult;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface HighLevelFacadeServices {
  readonly [key: string]: unknown;
}

export type CliCommandData =
  | EnvironmentStatus
  | EnvironmentDoctorReport
  | SessionManifest
  | InitCommandOutput
  | SetupCommandOutput
  | WorkflowRunSnapshot
  | Page<WorkflowRunSnapshot>
  | { readonly helpText: string; readonly topic?: string | undefined }
  | { readonly version: string }
  | HighLevelCommandOutput;

export interface CliJsonSuccessEnvelope<T = CliCommandData> {
  readonly ok: true;
  readonly command: CliCommandName;
  readonly data: T;
}

export interface CliJsonErrorEnvelope {
  readonly ok: false;
  readonly command?: CliCommandName | undefined;
  readonly error: ContractError;
}

export type CliJsonEnvelope<T = CliCommandData> = CliJsonSuccessEnvelope<T> | CliJsonErrorEnvelope;

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface PresentationOptions {
  readonly stdoutColor?: boolean | undefined;
  readonly stderrColor?: boolean | undefined;
  readonly interactive?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly isDefaultIo?: boolean | undefined;
}

export interface CliContext {
  readonly environment?: EnvironmentDependencies | undefined;
  readonly cwd?: string | undefined;
  readonly runtime?: RuntimeService | ConcreteRuntimeService | undefined;
  readonly io?: CliIo | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly confirmOverwrite?: ((configPath: string) => Promise<boolean> | boolean) | undefined;
  readonly operationOptions?: OperationOptions | undefined;
  readonly highLevel?: HighLevelFacadeServices | undefined;
  /** Engine facades for high-level commands; defaults compose the reviewed packages. */
  readonly highLevelServices?: HighLevelServices | undefined;
  readonly setup?: SetupIntegrationOptions | undefined;
  readonly presentation?: PresentationOptions | undefined;
}

export interface CliExecutionResult {
  readonly exitCode: CliExitCode;
  readonly ok: boolean;
  readonly command?: CliCommandName | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly data?: CliCommandData | undefined;
  readonly error?: ContractError | undefined;
  /** Validated JSON envelope of a high-level command. */
  readonly highLevel?: HighLevelEnvelope | undefined;
}

export type {
  ApprovalDecision,
  CancellationRequest,
  CommandExecutionResult,
  ContractError,
  OperationOptions,
  Page,
  ResumeRunInput,
  RunStatus,
  RuntimeService,
  StartRunInput,
  WorkflowDefinition,
  WorkflowRunSnapshot
};
export type { ConcreteRuntimeService as RuntimeServicePort };
