import type {
  AgentExecutionHandle,
  AgentMessage,
  AgentRequest,
  AgentResult,
  AgentTransportCapabilities,
  AgentTransportInitialization
} from "./agent.js";
import type { ApprovalDecision } from "./approval.js";
import type { ArtifactQuery, ArtifactReference, ArtifactWriteOptions } from "./artifact.js";
import type { Page, PageRequest } from "./common.js";
import type { DomainEvent } from "./events.js";
import type { CancellationRequest, CancellationResult, RecoveryCheckpoint } from "./execution.js";
import type {
  AdvanceRunCommand,
  AppendEventsRequest,
  AppendEventsResult,
  ApplyApprovalCommand,
  CreateRunCommand,
  RecordAgentResultCommand,
  RecoverRunCommand,
  RunQuery,
  StoredRun,
  TaskTransitionCommand,
  WorkflowAdvanceResult
} from "./orchestration.js";
import type { QualityGateContext, QualityGateResult } from "./quality.js";
import type { AgentConfiguration, AgentResolutionContext } from "./registry.js";
import type { ResumeRunInput, StartRunInput } from "./runtime.js";
import type { WorkflowDefinition, WorkflowRunSnapshot } from "./workflow.js";

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export interface AgentReadOptions extends OperationOptions {
  readonly afterSequence?: number;
  readonly resumeCursor?: string;
}

export interface AgentTransport {
  initialize(
    initialization: AgentTransportInitialization,
    options?: OperationOptions
  ): Promise<AgentTransportCapabilities>;
  send(request: AgentRequest, options?: OperationOptions): Promise<AgentExecutionHandle>;
  wait(handle: AgentExecutionHandle, options?: OperationOptions): Promise<AgentResult>;
  read(handle: AgentExecutionHandle, options?: AgentReadOptions): AsyncIterable<AgentMessage>;
  cancel(
    handle: AgentExecutionHandle,
    request: CancellationRequest,
    options?: OperationOptions
  ): Promise<CancellationResult>;
}

export interface WorkflowEngine {
  validateDefinition(definition: WorkflowDefinition): Promise<void>;
  createRun(command: CreateRunCommand, options?: OperationOptions): Promise<WorkflowAdvanceResult>;
  advance(command: AdvanceRunCommand, options?: OperationOptions): Promise<WorkflowAdvanceResult>;
  transitionTask(command: TaskTransitionCommand, options?: OperationOptions): Promise<WorkflowAdvanceResult>;
  recordAgentResult(
    command: RecordAgentResultCommand,
    options?: OperationOptions
  ): Promise<WorkflowAdvanceResult>;
  applyApproval(command: ApplyApprovalCommand, options?: OperationOptions): Promise<WorkflowAdvanceResult>;
  requestCancellation(
    request: CancellationRequest,
    options?: OperationOptions
  ): Promise<WorkflowAdvanceResult>;
  recover(command: RecoverRunCommand, options?: OperationOptions): Promise<WorkflowAdvanceResult>;
  getSnapshot(runId: string, options?: OperationOptions): Promise<WorkflowRunSnapshot | null>;
}

export interface RunStore {
  create(run: StoredRun, idempotencyKey: string, options?: OperationOptions): Promise<StoredRun>;
  get(runId: string, options?: OperationOptions): Promise<StoredRun | null>;
  find(query: RunQuery, options?: OperationOptions): Promise<Page<StoredRun>>;
  appendEvents(request: AppendEventsRequest, options?: OperationOptions): Promise<AppendEventsResult>;
  readEvents(
    runId: string,
    page?: PageRequest,
    options?: OperationOptions
  ): Promise<Page<DomainEvent>>;
  saveCheckpoint(
    checkpoint: RecoveryCheckpoint,
    expectedVersion: number,
    options?: OperationOptions
  ): Promise<void>;
  loadLatestCheckpoint(runId: string, options?: OperationOptions): Promise<RecoveryCheckpoint | null>;
}

export interface ArtifactWrite {
  readonly options: ArtifactWriteOptions;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface ArtifactStore {
  put(write: ArtifactWrite, options?: OperationOptions): Promise<ArtifactReference>;
  get(reference: ArtifactReference, options?: OperationOptions): AsyncIterable<Uint8Array>;
  resolve(artifactId: string, options?: OperationOptions): Promise<ArtifactReference | null>;
  find(query: ArtifactQuery, options?: OperationOptions): Promise<Page<ArtifactReference>>;
  delete(artifactId: string, options?: OperationOptions): Promise<boolean>;
}

export interface AgentRegistry {
  resolve(
    role: string,
    context: AgentResolutionContext,
    options?: OperationOptions
  ): Promise<AgentConfiguration | null>;
  list(role?: string, options?: OperationOptions): Promise<readonly AgentConfiguration[]>;
  upsert(configuration: AgentConfiguration, options?: OperationOptions): Promise<void>;
  remove(agentId: string, options?: OperationOptions): Promise<boolean>;
}

export interface QualityGate {
  readonly id: string;
  evaluate(context: QualityGateContext, options?: OperationOptions): Promise<QualityGateResult>;
}

export interface RuntimeService {
  start(input: StartRunInput, options?: OperationOptions): Promise<WorkflowRunSnapshot>;
  resume(input: ResumeRunInput, options?: OperationOptions): Promise<WorkflowRunSnapshot>;
  cancel(request: CancellationRequest, options?: OperationOptions): Promise<WorkflowRunSnapshot>;
  decide(decision: ApprovalDecision, options?: OperationOptions): Promise<WorkflowRunSnapshot>;
  getRun(runId: string, options?: OperationOptions): Promise<WorkflowRunSnapshot | null>;
  findRuns(query: RunQuery, options?: OperationOptions): Promise<Page<WorkflowRunSnapshot>>;
  watch(runId: string, options?: AgentReadOptions): AsyncIterable<DomainEvent>;
}
