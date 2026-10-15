import type {
  ApprovalDecision,
  CancellationRequest,
  ContractError,
  OperationOptions,
  Page,
  ResumeRunInput,
  RunStatus,
  RuntimeService,
  StartRunInput,
  WorkflowDefinition,
  WorkflowRunSnapshot
} from "@ai-flow/contracts";
import type { ConcreteRuntimeService } from "@ai-flow/runtime";

export type CliCommandName = "init" | "run" | "status" | "approve" | "resume" | "cancel" | "help";

export const CLI_EXIT_CODES = {
  SUCCESS: 0,
  RUNTIME_ERROR: 1,
  USAGE_ERROR: 2
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

export interface GlobalCliFlags {
  readonly json: boolean;
  readonly help: boolean;
}

export interface InitCommandArgs extends GlobalCliFlags {
  readonly command: "init";
  readonly dir?: string | undefined;
  readonly configPath?: string | undefined;
  readonly projectName?: string | undefined;
  readonly force: boolean;
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

export type ParsedCliCommand =
  | InitCommandArgs
  | RunCommandArgs
  | StatusCommandArgs
  | ApproveCommandArgs
  | ResumeCommandArgs
  | CancelCommandArgs
  | HelpCommandArgs;

export type ParseCliResult =
  | { readonly ok: true; readonly value: ParsedCliCommand }
  | {
      readonly ok: false;
      readonly error: ContractError;
      readonly command?: CliCommandName | undefined;
      readonly json: boolean;
    };

export interface FlowRepositoryConfig {
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

export interface InitCommandOutput {
  readonly configPath: string;
  readonly config: FlowRepositoryConfig;
  readonly overwritten: boolean;
}

export type CliCommandData =
  | InitCommandOutput
  | WorkflowRunSnapshot
  | Page<WorkflowRunSnapshot>
  | { readonly helpText: string; readonly topic?: string | undefined };

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

export interface CliContext {
  readonly cwd?: string | undefined;
  readonly runtime?: RuntimeService | ConcreteRuntimeService | undefined;
  readonly io?: CliIo | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly confirmOverwrite?: ((configPath: string) => Promise<boolean> | boolean) | undefined;
  readonly operationOptions?: OperationOptions | undefined;
}

export interface CliExecutionResult {
  readonly exitCode: CliExitCode;
  readonly ok: boolean;
  readonly command?: CliCommandName | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly data?: CliCommandData | undefined;
  readonly error?: ContractError | undefined;
}

export type {
  ApprovalDecision,
  CancellationRequest,
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
