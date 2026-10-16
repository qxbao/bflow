export {
  SessionRecoveryService,
  classifyDisconnectionMode,
  inspectWorktreeState,
  reconcileDispatchIntent,
  detectAndReconcileOrphanAgents,
  type DisconnectionMode,
  type CheckpointedRunSummary,
  type GracefulShutdownReceipt,
  type AgentDiscrepancyRecord,
  type ActiveLeaseRecord,
  type SessionRecoveryObservation,
  type DisconnectionClassification,
  type WorktreeInspectionReport,
  type OrphanReconciliationResult,
  type DispatchReconciliationResult,
  type SessionRecoveryReport,
  type SessionRecoveryPorts
} from "./session-recovery-service.js";
