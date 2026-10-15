/**
 * @bflow/runtime - Production-grade workflow runtime service for bflow.
 * Composes WorkflowEngine, RunStore, ArtifactStore, AgentRegistry, AgentTransport,
 * and QualityGate through @bflow/contracts ports.
 */

// Service and Factory
export { createRuntimeService, RuntimeServiceImpl } from "./service.js";
export type {
  RuntimePorts,
  ConcreteRuntimeService,
  RuntimeInitOptions,
  StartRunOptions,
  ApproveOptions,
  CancelRunOptions
} from "./service.js";

// Task Dispatcher
export { TaskDispatcher } from "./dispatcher.js";
export type { TaskDispatcherOptions, ActiveTaskExecution } from "./dispatcher.js";

// SDLC Workflow Orchestrator
export {
  SdlcWorkflowOrchestrator,
  isHumanApprover,
  ingestArtifactProposals
} from "./orchestrator.js";
export type { SdlcOrchestratorPorts } from "./orchestrator.js";

// Recovery
export { recoverWorkflowRun, eventTailCursor } from "./recovery.js";
export type { WorkflowRecoveryResult, RecoveryPorts } from "./recovery.js";

// Event Stream and PubSub
export { createDomainEventStream, DefaultRunEventHub, AsyncQueue } from "./stream.js";
export type { RunEventHub, DomainEventStreamOptions } from "./stream.js";

// Workspace Composition
export { openWorkspaceRuntime } from "./workspace.js";
export type {
  WorkspaceStoragePaths,
  OpenWorkspaceRuntimeOptions,
  WorkspaceRuntimeHandle
} from "./workspace.js";

// Public Contract Types Re-exports
export type {
  AgentConfiguration,
  AgentExecutionHandle,
  AgentLease,
  AgentRegistry,
  AgentRequest,
  AgentResult,
  AgentSubmissionReceipt,
  AgentTransport,
  AgentTransportObservation,
  ApprovalDecision,
  ApprovalRequest,
  ArtifactProposal,
  ArtifactReference,
  ArtifactStore,
  CancellationRequest,
  CancellationResult,
  CancellationStopConfirmation,
  ContractError,
  DomainEvent,
  OperationOptions,
  AgentReadOptions,
  OperationResult,
  Page,
  QualityGate,
  QualityGateContext,
  QualityGateResult,
  RecoveryCheckpoint,
  ResumeRunInput,
  RunQuery,
  RunStore,
  RuntimeService,
  StartRunInput,
  StoredRun,
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowRunSnapshot
} from "@bflow/contracts";
