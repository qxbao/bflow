import type {
  AgentExecutionHandle,
  AgentMessage,
  AgentReconciliationRequest,
  AgentReconciliationResult,
  AgentRequest,
  AgentSubmissionReceipt,
  AgentTransportCapabilities,
  AgentTransportInitialization,
  AgentTransportObservation,
  AgentTransportState
} from "./agent.js";
import type { ApprovalDecision, ApprovalRequest } from "./approval.js";
import type { ArtifactQuery, ArtifactReference, ArtifactWriteOptions } from "./artifact.js";
import type { Page, PageRequest } from "./common.js";
import type { DomainEvent } from "./events.js";
import type { OperationResult } from "./errors.js";
import type { CancellationRequest, CancellationResult, RecoveryCheckpoint } from "./execution.js";
import type {
  ConversationMessage,
  DelegationRequest,
  PaneBinding,
  SessionManifest
} from "./session.js";
import type {
  AdvanceRunCommand,
  AppendEventsRequest,
  AppendEventsResult,
  ApplyApprovalCommand,
  BindAgentExecutionCommand,
  ConfirmCancellationStopCommand,
  CreateRunCommand,
  EvaluateQualityGateCommand,
  RecordAgentResultCommand,
  RecordCancellationResultCommand,
  RecordDeliveryReconciliationCommand,
  RecordQualityGateResultCommand,
  RecoverRunCommand,
  RequestApprovalCommand,
  RunQuery,
  StoredRun,
  TaskTransitionCommand,
  WorkflowAdvanceResult
} from "./orchestration.js";
import type { QualityGateContext, QualityGateResult } from "./quality.js";
import type { CreateCheckpointCommand } from "./recovery.js";
import type {
  AcquireAgentLeaseRequest,
  AgentConfiguration,
  AgentLease,
  AgentResolutionContext,
  ReleaseAgentLeaseRequest,
  RenewAgentLeaseRequest
} from "./registry.js";
import type { ResumeRunInput, StartRunInput } from "./runtime.js";
import type { WorkflowDefinition, WorkflowRunSnapshot } from "./workflow.js";

export interface OperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly deadline?: string;
}

export interface AgentReadOptions extends OperationOptions {
  readonly afterSequence?: number;
  readonly resumeCursor?: string;
}

export interface AgentWaitOptions extends OperationOptions {
  readonly until?: readonly AgentTransportState[];
}

export interface AgentTransport {
  initialize(
    initialization: AgentTransportInitialization,
    options?: OperationOptions
  ): Promise<OperationResult<AgentTransportCapabilities>>;
  send(request: AgentRequest, options?: OperationOptions): Promise<OperationResult<AgentSubmissionReceipt>>;
  reconcile(
    request: AgentReconciliationRequest,
    options?: OperationOptions
  ): Promise<OperationResult<AgentReconciliationResult>>;
  wait(
    handle: AgentExecutionHandle,
    options?: AgentWaitOptions
  ): Promise<OperationResult<AgentTransportObservation>>;
  read(
    handle: AgentExecutionHandle,
    options?: AgentReadOptions
  ): AsyncIterable<OperationResult<AgentMessage>>;
  cancel(
    handle: AgentExecutionHandle,
    request: CancellationRequest,
    options?: OperationOptions
  ): Promise<OperationResult<CancellationResult>>;
}

export interface WorkflowEngine {
  validateDefinition(definition: WorkflowDefinition): Promise<OperationResult<void>>;
  createRun(command: CreateRunCommand, options?: OperationOptions): Promise<OperationResult<WorkflowAdvanceResult>>;
  advance(command: AdvanceRunCommand, options?: OperationOptions): Promise<OperationResult<WorkflowAdvanceResult>>;
  transitionTask(
    command: TaskTransitionCommand,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  bindAgentExecution(
    command: BindAgentExecutionCommand,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  recordDeliveryReconciliation(
    command: RecordDeliveryReconciliationCommand,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  recordAgentResult(
    command: RecordAgentResultCommand,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  requestApproval(
    command: RequestApprovalCommand,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  applyApproval(
    command: ApplyApprovalCommand,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  requestQualityGateEvaluation(
    command: EvaluateQualityGateCommand,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  recordQualityGateResult(
    command: RecordQualityGateResultCommand,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  requestCancellation(
    request: CancellationRequest,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  recordCancellationResult(
    command: RecordCancellationResultCommand,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  confirmCancellationStop(
    command: ConfirmCancellationStopCommand,
    options?: OperationOptions
  ): Promise<OperationResult<WorkflowAdvanceResult>>;
  recover(command: RecoverRunCommand, options?: OperationOptions): Promise<OperationResult<WorkflowAdvanceResult>>;
  createCheckpoint(command: CreateCheckpointCommand, options?: OperationOptions): Promise<OperationResult<RecoveryCheckpoint>>;
  getSnapshot(runId: string, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot | null>>;
}

export interface RunStore {
  create(run: StoredRun, idempotencyKey: string, options?: OperationOptions): Promise<OperationResult<StoredRun>>;
  get(runId: string, options?: OperationOptions): Promise<OperationResult<StoredRun | null>>;
  find(query: RunQuery, options?: OperationOptions): Promise<OperationResult<Page<StoredRun>>>;
  appendEvents(
    request: AppendEventsRequest,
    options?: OperationOptions
  ): Promise<OperationResult<AppendEventsResult>>;
  readEvents(
    runId: string,
    page?: PageRequest,
    options?: OperationOptions
  ): Promise<OperationResult<Page<DomainEvent>>>;
  saveCheckpoint(
    checkpoint: RecoveryCheckpoint,
    expectedVersion: number,
    options?: OperationOptions
  ): Promise<OperationResult<void>>;
  loadLatestCheckpoint(
    runId: string,
    options?: OperationOptions
  ): Promise<OperationResult<RecoveryCheckpoint | null>>;
}

export interface ArtifactWrite {
  readonly options: ArtifactWriteOptions;
  readonly content: AsyncIterable<Uint8Array>;
}

export interface ArtifactStore {
  put(write: ArtifactWrite, options?: OperationOptions): Promise<OperationResult<ArtifactReference>>;
  get(reference: ArtifactReference, options?: OperationOptions): AsyncIterable<OperationResult<Uint8Array>>;
  resolve(artifactId: string, options?: OperationOptions): Promise<OperationResult<ArtifactReference | null>>;
  find(query: ArtifactQuery, options?: OperationOptions): Promise<OperationResult<Page<ArtifactReference>>>;
  delete(artifactId: string, options?: OperationOptions): Promise<OperationResult<boolean>>;
}

export interface AgentRegistry {
  resolve(
    role: string,
    context: AgentResolutionContext,
    options?: OperationOptions
  ): Promise<OperationResult<AgentConfiguration | null>>;
  acquireLease(
    request: AcquireAgentLeaseRequest,
    options?: OperationOptions
  ): Promise<OperationResult<AgentLease>>;
  renewLease(
    request: RenewAgentLeaseRequest,
    options?: OperationOptions
  ): Promise<OperationResult<AgentLease>>;
  releaseLease(
    request: ReleaseAgentLeaseRequest,
    options?: OperationOptions
  ): Promise<OperationResult<void>>;
  list(role?: string, options?: OperationOptions): Promise<OperationResult<readonly AgentConfiguration[]>>;
  upsert(configuration: AgentConfiguration, options?: OperationOptions): Promise<OperationResult<void>>;
  remove(agentId: string, options?: OperationOptions): Promise<OperationResult<boolean>>;
}

export interface QualityGate {
  readonly id: string;
  evaluate(context: QualityGateContext, options?: OperationOptions): Promise<OperationResult<QualityGateResult>>;
}

export interface RuntimeService {
  start(input: StartRunInput, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot>>;
  resume(input: ResumeRunInput, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot>>;
  cancel(request: CancellationRequest, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot>>;
  decide(decision: ApprovalDecision, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot>>;
  getRun(runId: string, options?: OperationOptions): Promise<OperationResult<WorkflowRunSnapshot | null>>;
  findRuns(query: RunQuery, options?: OperationOptions): Promise<OperationResult<Page<WorkflowRunSnapshot>>>;
  watch(runId: string, options?: AgentReadOptions): AsyncIterable<OperationResult<DomainEvent>>;
}

export interface SessionLifecycleManager {
  init(manifest: SessionManifest, options?: OperationOptions): Promise<OperationResult<SessionManifest>>;
  up(sessionId: string, options?: OperationOptions): Promise<OperationResult<SessionManifest>>;
  down(sessionId: string, options?: OperationOptions): Promise<OperationResult<SessionManifest>>;
  attach(sessionId: string, options?: OperationOptions): Promise<OperationResult<PaneBinding>>;
  getManifest(sessionId: string, options?: OperationOptions): Promise<OperationResult<SessionManifest | null>>;
}

export interface ConversationCoordinatorPort {
  handOffToCoordinator(request: DelegationRequest, options?: OperationOptions): Promise<OperationResult<void>>;
  reportProgressToConversation(message: ConversationMessage, options?: OperationOptions): Promise<OperationResult<void>>;
  promptApproval(request: ApprovalRequest, options?: OperationOptions): Promise<OperationResult<void>>;
  receiveApprovalDecision(decision: ApprovalDecision, options?: OperationOptions): Promise<OperationResult<void>>;
}
