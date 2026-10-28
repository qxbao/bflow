/**
 * @bflow/runtime - Production-grade workflow runtime service for bflow.
 * Composes WorkflowEngine, RunStore, ArtifactStore, AgentRegistry, AgentTransport,
 * and QualityGate through @bflow/contracts ports.
 */

// Service and Factory
export { diagnoseVerificationSandbox } from "./agentic/sandbox-readiness.js";
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

// P19: durable adaptive Agentic SDLC orchestration through the frozen v2 contracts.
export { AgenticWorkflowRuntime } from "./agentic/runtime.js";
export { loadAgenticPolicies } from "./agentic/ports.js";
export type { AgenticRuntimePorts, AgenticPolicies, AgenticCompositionOptions, PanePolicy } from "./agentic/ports.js";
export { CoordinatorTools, COORDINATOR_TOOLS, COORDINATOR_ROLE_PROFILE } from "./agentic/tools.js";
export { createAgenticConversationHost } from "./agentic/conversation.js";
export type { AgenticConversationHost } from "./agentic/conversation.js";
export { openAgenticWorkspace } from "./agentic/workspace.js";
export { probeConfiguredProviderModels, type ProviderModelDiagnosticsInput } from "./agentic/provider-model-diagnostics.js";
export type { OpenAgenticWorkspaceOptions, AgenticWorkspaceHandle } from "./agentic/workspace.js";

export { createSignedBindingReceipt } from "./agentic/receipt-host.js";
export { startHerdrReceiptIngress, authenticateNativeHerdrMessage } from "./agentic/herdr-ingress.js";

// Reliability: Resilience, Observability, Project Context Service, and Session Recovery
export * from "./resilience/index.js";
export * from "./observability/index.js";
export * from "./context/index.js";
export * from "./session-recovery/index.js";
export {
  parseBehavioralCommands,
  bindRegressionProfile,
  measureRegression
} from "./agentic/behavioral-runner.js";
export { parseMutationChecks } from "./agentic/mutation-check.js";
export type { MutationCheck } from "./agentic/mutation-check.js";
export { parseAppChecks, appCheckDefinitions, appCheckIdentity, parseAppCheckIdentity } from "./agentic/app-check-config.js";
export type { AppCheck, AppCheckSuite, AppCheckUi, AppCheckApi } from "./agentic/app-check-config.js";
export type {
  BehavioralCommand,
  RegressionCommand,
  RegressionMeasurement
} from "./agentic/behavioral-runner.js";
export {
  parseRegressionResult,
  RegressionInfrastructureFailure
} from "./agentic/regression-results.js";
export type {
  RegressionFailure,
  RegressionObservation
} from "./agentic/regression-results.js";

export { effectiveFastPathMode, effectiveRegressionScope, ensureAgenticHost, openPersistedAgenticHost } from "./agentic/host-controller.js";
export type { AgenticHostController, AgenticHostOptions, FastPathMode, RegressionScope, RoleLaunchDescriptor } from "./agentic/host-controller.js";

export {
  createGitNexusImpactIndex,
  unconfiguredImpactIndex,
  parseCypherFilePaths
} from "./agentic/impact-index.js";
export type {
  IndexUnavailableCode,
  ImportersResult,
  ImpactIndex,
  GitNexusImpactIndexOptions
} from "./agentic/impact-index.js";

export { selectRegressionTests } from "./agentic/regression-selection.js";
export type { RegressionSelection } from "./agentic/regression-selection.js";
export { regressionChecks } from "./agentic/task-commands.js";

// P30: platform readiness composition (no concrete provider adapter classes are exported).
export * from "./platform/index.js";
export * from "./analysis/index.js";
export * from "./qa/index.js";

// Private state placement for the host and CLI recovery composition.
export { findPrivateRuntimeStateDirectory, resolvePrivateRuntimeStateDirectory } from "./private-state.js";

// Offline handover packages (HX-01): read-only run snapshot, integrity-checked evidence, staged publication.
export {
  exportHandoverPackage, inspectHandoverRun, verifyHandoverPackage, openHandoverSources, openRepositoryHandoverSources,
  HandoverConflictError, HandoverNotFoundError, HandoverDocumentSchema, HandoverManifestSchema, HandoverInspectionSchema,
  HandoverExportResultSchema, HandoverVerificationSchema
} from "./handover/index.js";
export type {
  HandoverDocument, HandoverManifest, HandoverInspection, HandoverExportResult, HandoverVerification, HandoverSources, HandoverExportOptions
} from "./handover/index.js";
// Read-only telemetry reports; independent of workflow acceptance.
export { buildWorkflowTelemetry, readWorkflowTelemetry, WorkflowTelemetryReportSchema } from "./telemetry/report.js";
export type { WorkflowTelemetryReport } from "./telemetry/report.js";
export { readExistingAgenticTelemetry } from "./agentic/host-controller.js";
export { reconcileExistingAgenticCancellation } from "./agentic/host-controller.js";
export { CancellationReconciliationReportSchema } from "./agentic/cancellation-stop.js";
export type { CancellationReconciliationReport } from "./agentic/cancellation-stop.js";
export * from './planning/index.js';

export * from "./agentic/execution-binding.js";

export * from "./agentic/skill-approval.js";
export { createHostSkillManager, launchMaterial, requirementFor } from "./agentic/host-platform.js";

export { defaultHostChecks } from "./agentic/host-verification.js";
export { hostRoleCapabilities } from "./agentic/host.js";

export { openUserInteractionClient, interactionProjectId } from "./interaction/client.js";
export { registerUserInteractionIssuer } from "./agentic/host-controller.js";
