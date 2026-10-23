import {
  AgentBindingReceiptSchema, canonicalReceiptJson, hasAuthenticatedBindings, CreateCheckpointCommandSchema, RecoveryCheckpointSchema, WorkflowAggregateCheckpointStateSchema,
  AgentResultSchema, AgentRoleSchema, AgentTransportCapabilitiesSchema, ApprovalDecisionSchema, ApprovalRequestSchema, ArtifactReferenceSchema,
  CancellationRequestSchema, DelegationRequestSchema, GitChangeSetSchema,
  PaneBindingSchema, QualityGateContextSchema, QualityGateResultSchema, RoleMessageSchema, SessionManifestSchema,
  SpecificationSchema, TestStrategySchema, VerificationCycleSchema, VerificationResultSchema,
  WorkflowDefinitionSchema, type AgentExecutionHandle, type ApprovalDecision, type ApprovalRequest,
  type ArtifactReference, type CancellationRequest, type JsonValue, type RoleMessage, type QualityGate, type QualityGateResult, type Specification,
  type PaneBinding, type TaskDefinition, type AgentRole, type WorkflowDefinition, type DelegationRequest
} from "@bflow/contracts";
import { AgenticJournal, digest, isConversationDelivery, json, record, strings, textField, type JournalState,
  type ConflictResolverAttempt, type Outbound, type RunRecord, type SpecRecord, type TaskRecord, type UserDecisionRecord } from "./journal.js";
import { buildDecisionRequestMessage, buildUserDecisionRequest, USER_DECISION_EXPIRED_KIND, validateUserDecisionAnswer, type UserDecisionToolInput } from "./decision-routing.js";
import { captureIntegratedChange } from "./integration-change.js";
import { CoreSession } from "./core-session.js";
import { redactString } from "../resilience/redaction.js";
import { TaskActivityLog } from "./task-activity-log.js";
import { taskLogAssignmentContextFromSnapshot, taskLogBusinessTaskId, type TaskLogAssignment } from "./task-log-tools.js";
import { join } from "node:path";
import { CONVERSATION_DELIVERY_MAX_ATTEMPTS, DISPATCH_FAILURE_NOTICE_ATTEMPTS, HerdrOutbox, NOT_READY_FAILURE_MS, unwrap } from "./outbox.js";
import { RoleCapabilityPreflightError, type AgenticRuntimePorts, type Integration, type VerificationPlan } from "./ports.js";
import { WorkflowProposalRejected, WorkflowRejectionCodeSchema, reportsToUser, type WorkflowRejection } from "./workflow-rejection.js";
import type { RunFacts } from "./run-watchdog.js";
import { withRecoveredHerdrReceipt } from "./herdr-ingress.js";
import { nativeMessageFingerprint, NativeRejectionSchema } from "./native-delivery-status.js";
import { describeValidationError, INVALID_ROLE_MESSAGE_LIMIT, isMessageContentFailure } from "./role-message-feedback.js";
import { AssessmentSpecificationSchema, assessmentErrorAt } from "./assessment-input.js";
import { NativeDiagnosticFenceAuthoritySchema, NativeDiagnosticFenceSchema } from "./native-diagnostic-fence.js";

/** Existing receipt and diagnostic operations that may drain after scheduling is quiesced. */
export const QUIESCED_RECEIPT_DRAIN_OPERATIONS: readonly string[] = Object.freeze([
  "inspect_native_delivery", "host_status", "assignment_context", "repository_read", "read_pinned_instructions", "read_task_log", "log_task_step",
  "inspect_review", "complete_review", "inspect_alternative_verification", "record_alternative_verification", "record_behavioral_verification", "submit_implementation"
]);

const VERIFICATION_GATE = "p19-independent-task-verification";
const TERMINAL_RUN_STATUSES: readonly string[] = ["completed", "failed", "cancelled", "escalated"];
/** Terminal specialist `task.status` values (every agents/<role>/system-prompt.md); each discharges the correlated handoff's result obligation. */
/** Automatic Developer resolver attempts per P18 conflict before the run escalates to a human. */
export const CONFLICT_RESOLVER_ATTEMPTS = 2;
const CONFLICT_RESOLUTION_KIND = "conflict_resolution";
const CONFLICT_ESCALATION = "Git integration conflict requires an assigned resolver; worktree preserved";
/** Runtime-authored Developer assignment on a preserved P18 integration worktree; it has no Core task. */
export function isConflictResolverAssignment(message: RoleMessage): boolean {
  return message.type === "task.assignment" && message.payload !== null && typeof message.payload === "object" && !Array.isArray(message.payload) &&
    (message.payload as Record<string, unknown>).kind === CONFLICT_RESOLUTION_KIND;
}
/** Read-only specialists the Coordinator may delegate to; each needs its own bound pane, or an explicit capable fallback. */
const SPECIALIST_ROLES: readonly string[] = ["specifier", "architect", "planner", "security", "reviewer", "qa", "tester"];
/** Used only when the requested role has no pane in this session and the fallback pane has every required capability. */
const SPECIALIST_FALLBACKS: Readonly<Record<string, string>> = { security: "reviewer", tester: "qa" };
/** Synchronous refusal of a specialist request that could not be routed to any bound pane; the run itself is not changed. */
export class SpecialistUnavailableError extends Error {
  readonly code = "specialist_unavailable";
  constructor(message: string, readonly requestedRole: string, readonly boundRoles: readonly string[]) { super(message); this.name = "SpecialistUnavailableError"; }
}
const TERMINAL_TASK_STATUS_RESULTS: readonly string[] = ["blocked", "failed", "completed", "succeeded", "inconclusive"];
/** Follow-up runs a human `changes_requested` may create from one original run before the next one escalates normally. */
const MAX_FOLLOW_UP_RUNS = 5;
/** Deterministic key of the next attempt of one specialist request: `key#attempt-2`, `#attempt-3`, ... */
function nextAttemptKey(key: string): string {
  const match = /#attempt-(\d+)$/.exec(key);
  return match ? `${key.slice(0, match.index)}#attempt-${Number(match[1]) + 1}` : `${key}#attempt-2`;
}
/** Automatic-resume budget carried from the run's previous Coordinator action, so successive capability blockers share one bound. */
function inheritedResumeAttempts(run: RunRecord): number {
  return run.pendingAction?.kind === "resume_coordinator" ? run.pendingAction.resumeAttempts ?? 0 : 0;
}
/** Automatic resumes of one blocker lineage before it waits for the user (the journal codec also caps it). */
const AUTO_RESUME_LIMIT = 3;
/** Explicit user resumes ("tiếp tục <run-id>") of one blocker lineage; separate from, and still allowed after, the automatic budget. */
const MANUAL_RESUME_LIMIT = 3;
/** Minimum wait before automatic resume n+1 (n = attempts already spent), from the episode start or the previous resume. */
const AUTO_RESUME_BACKOFF_MS: readonly number[] = [30_000, 60_000, 120_000];
/** Budget and backoff anchor an automatic-resume episode inherits from the Coordinator action it follows, so resume -> stop cannot loop. */
function inheritedAutoResume(run: RunRecord): { resumeAttempts: number; lastResumedAt?: string; manualResumeAttempts?: number } {
  const prior = run.pendingAction?.kind === "resume_coordinator" ? run.pendingAction : undefined;
  return { resumeAttempts: prior?.resumeAttempts ?? 0, ...(prior?.lastResumedAt === undefined ? {} : { lastResumedAt: prior.lastResumedAt }),
    ...inheritedManualResume(run) };
}
/** The explicit-resume count of the lineage, carried into every follow-up action so the user's bound cannot be reset by a recurrence. */
function inheritedManualResume(run: RunRecord): { manualResumeAttempts?: number } {
  const prior = run.pendingAction?.kind === "resume_coordinator" ? run.pendingAction : undefined;
  return prior?.manualResumeAttempts === undefined ? {} : { manualResumeAttempts: prior.manualResumeAttempts };
}
/** What an invalid message answers: its causation (the assignment), else everything uncorrelated from the same sender pane. */
function invalidMessageSource(message: RoleMessage): string {
  return message.causation_id ?? `uncorrelated:${message.sender.pane_id ?? message.sender.agent_id ?? "unknown"}`;
}
/** Earliest time Runtime may automatically resume this action. */
function autoResumeDueAt(action: NonNullable<RunRecord["pendingAction"]>): number {
  const anchor = Math.max(Date.parse(action.createdAt), action.lastResumedAt === undefined ? -Infinity : Date.parse(action.lastResumedAt));
  const attempts = action.resumeAttempts ?? 0;
  return anchor + AUTO_RESUME_BACKOFF_MS[Math.min(attempts, AUTO_RESUME_BACKOFF_MS.length - 1)]!;
}
/** User-visible description of an automatic resume episode, carried on its blocker notice. */
function automaticResumeNotice(action: NonNullable<RunRecord["pendingAction"]>): JsonValue {
  return { attempt: (action.resumeAttempts ?? 0) + 1, limit: AUTO_RESUME_LIMIT, notBefore: new Date(autoResumeDueAt(action)).toISOString() };
}
/** A cycle stopped by an environment/timeout `blocked` or missing-evidence `inconclusive` result; exhausted or failed verdicts stay final. */
function retryableVerificationCycle(cycle: { status: string; history: readonly { status: string }[] }): boolean {
  return cycle.status === "escalated" && ["blocked", "inconclusive"].includes(cycle.history.at(-1)?.status ?? "");
}
/** Escalated only until an explicit resume of its pending action; in-flight results/evidence are retained, not dropped, meanwhile. */
function resumablyPaused(run: RunRecord): boolean {
  // A verification-retry escalation keeps finishing its durable outcomes automatically (see finishVerification); it is not paused.
  return run.status === "escalated" && !run.cancelled && run.pendingAction?.state === "pending" && !run.error?.startsWith(VERIFICATION_RETRY_PREFIX) &&
    ["resume_coordinator", "reconcile_delivery"].includes(run.pendingAction.kind);
}
const FINAL_TASK = "workflow-verification";
/** Prefix of run errors that a Coordinator retry_verification can resume. */
const VERIFICATION_RETRY_PREFIX = "Verification delivery/storage requires reconciliation:";
/** Informational Conversation traffic never carries resume, approval or task-result authority. */
function isConversationContext(message: RoleMessage): boolean {
  return message.sender.role === "conversation" && message.recipient.role === "coordinator" && message.type === "task.status" && record(message.payload).action !== "cancel";
}
function isConversationContextWake(message: RoleMessage): boolean {
  return message.sender.role === "runtime" && message.recipient.role === "coordinator" && message.type === "task.status" && record(message.payload).kind === "conversation_context_ready";
}
const VERIFICATION_ATTEMPT_LIMIT = 3;
const RUN_STEP_FAILURE_PREFIX = "Run step failed:";
/**
 * Stop observations per cancelled execution before it is reported for manual reconciliation. Bounded so an unresponsive pane is
 * never polled forever, and never resent: an interrupt is issued once and only observed afterwards.
 */
export const CANCEL_STOP_OBSERVATION_LIMIT = 5;
// Short: the wait runs inside tick(), which holds the journal lock.
const CANCEL_STOP_OBSERVATION_WAIT_MS = 500;
/** A live execution that cancellation must stop: Developer or specialist work, never a Conversation or Coordinator message. */
function isStoppableExecution(out: Outbound): boolean {
  return !out.reviewReplacement && ["task.assignment", "verification.requested", "delegation.request"].includes(out.message.type) &&
    !["coordinator", "conversation"].includes(out.message.recipient.role);
}
const DELIVERY_FAILURE_OPTIONS = ["Check the recipient role pane in Herdr; delivery retries automatically once it is ready",
  "Restart the role with `bflow up` if its pane is gone", "Cancel this run"];
const UNCERTAIN_DELIVERY_OPTIONS = ["Ask Coordinator to reconcile the uncertain handoff (reconcile_delivery) before any resend", "Cancel this run"];
const INBOUND_FAILURE_OPTIONS = ["Ask Coordinator to inspect the failed handoff and request a schema-valid resend from the sender", "Cancel this run"];
const VERIFICATION_RETRY_OPTIONS = ["Retry verification for this run (Coordinator retry_verification)", "Cancel this run"];
/** Structural blockers that never clear on their own; the user hears about them at once. */
const STRUCTURAL_DELIVERY_BLOCKERS = /^(Recipient pane unavailable|No capable agent in recipient pane|Pinned request or recipient changed|Recipient [\w-]+ not ready since )/;
function conversationRetryDelayMs(attempts: number): number { return Math.min(60_000, 1_000 * 2 ** (attempts - 1)); }
function objectField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}
/** Verification identity of a pending entry (its result is schema-validated when the journal is read). */
function pendingVerificationId(item: { outcome: unknown }): string | undefined {
  const id = objectField(objectField(item.outcome, "result"), "verificationId");
  return typeof id === "string" ? id : undefined;
}
function pendingRunId(item: { job: unknown }): string | undefined { const id = objectField(item.job, "runId"); return typeof id === "string" ? id : undefined; }
function pendingTaskId(item: { job: unknown }): string | undefined { const id = objectField(item.job, "taskId"); return typeof id === "string" ? id : undefined; }
/** A specialist's structured task.status with status "blocked" is a blocker the user must hear about. */
function specialistBlockage(payload: unknown): string | undefined {
  if (!(["blocked", "failed"].includes(String(objectField(payload, "status"))))) return undefined;
  const text = ["reason", "message", "headline", "summary"].map(key => objectField(payload, key)).find((item): item is string => typeof item === "string" && item.trim() !== "");
  return redactString(text ?? `Specialist reported status ${String(objectField(payload, "status"))}`).slice(0, 1800);
}

/**
 * Runtime refused an inbound request for a reason that retrying cannot change (stale or foreign revision, terminal run, superseded
 * approval). Hosts must not resend it, and must not report it as an uncertain delivery: its refusal is already a Conversation notice.
 */
export class AdmissionRejectedError extends Error {
  readonly retryable = false;
  constructor(message: string) { super(message); this.name = "AdmissionRejectedError"; }
}
export function isNonRetryableDeliveryError(error: unknown): boolean { return error instanceof AdmissionRejectedError; }
/** Kinds of delivery problem. One user-facing notice per (message, class); retries and reconciliation reuse it. */
type FailureClass = "transport_uncertain" | "undeliverable" | "inbound_failed";
/** The admitted revision of a requirement. A request without metadata.revision is revision 1. */
function revisionOf(delegation: DelegationRequest): number {
  const value = delegation.metadata?.revision;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : 1;
}
/** A Conversation transcript notice reports the uncertain and dropped paths with the same wording; those are one failure class. */
function inboundFailureClass(reason: string): FailureClass { return /uncertain|acknowledg/i.test(reason) ? "transport_uncertain" : "inbound_failed"; }
/** Only a refusal or an item dropped after bounded retries is final; transient ingress errors stay a notice while redelivery/replay may still apply it. */
function inboundFailureFinal(reason: string): boolean {
  return inboundFailureClass(reason) !== "transport_uncertain" && /AdmissionRejectedError|dropped after \d+ attempts/.test(reason);
}
/** A Conversation → Coordinator delegation that opens or revises a run. Cancellation requests travel the same type and are handled apart. */
function isConversationHandoff(message: RoleMessage): boolean {
  return message.type === "delegation.request" && message.sender.role === "conversation" && message.recipient.role === "coordinator" &&
    objectField(objectField(message.payload, "metadata"), "action") !== "cancel";
}
/** Trusted cancellation is Runtime control, even though the compatibility wire envelope is a delegation. */
function isCancellationHandoff(message: RoleMessage): boolean {
  return message.type === "delegation.request" && message.sender.role === "conversation" && message.recipient.role === "coordinator" &&
    objectField(objectField(message.payload, "metadata"), "action") === "cancel";
}
function supersededReason(run: RunRecord, approvalId: string): string | undefined {
  const item = run.supersededApprovals?.find(entry => entry.approvalId === approvalId);
  return item === undefined ? undefined : `Approval superseded by requirement revision ${item.supersededByRevision}`;
}
function assertNoPendingPaneDecision(run: RunRecord, binding: PaneBinding): void {
  if (Object.values(run.userDecisions ?? {}).some(entry => entry.status === "pending" && entry.role === binding.role &&
      entry.agentId === binding.agentId && entry.paneId === binding.paneId)) throw new Error("Pane is waiting for its pending human decision");
}
type Admission = { kind: "new" } | { kind: "duplicate" } | { kind: "revision"; revision: number } | { kind: "rejected"; reason: string };
const REJECTED_REVISION_OPTIONS = ["Gửi revision mới hợp lệ", "Tạo run mới", "Hủy run"];

/** Durable single-writer orchestration. No LLM calls, polling artifacts, or synchronous inter-agent waits. */
export class AgenticWorkflowRuntime {
  private readonly journal: AgenticJournal;
  private taskLogAssignmentSnapshot: Record<string, unknown>[] = [];
  readonly activityLog: TaskActivityLog;
  constructor(readonly ports: AgenticRuntimePorts, options: { journalDirectory: string; repositoryPath: string }) {
    this.journal = new AgenticJournal(options.journalDirectory, options.repositoryPath);
    this.activityLog = TaskActivityLog.open(join(options.journalDirectory, "../task-activity.jsonl"));
  }
  private quiesced = false;
  /** Stop new scheduling before lifecycle checkpointing; retain in-flight receipts and worktrees. */
  async quiesce(): Promise<void> {
    this.quiesced = true;
    await this.transaction(async (_state, _save, core) => { await core.flush(); });
  }
  async checkpoint(input: unknown) {
    const command = CreateCheckpointCommandSchema.parse(input);
    return this.transaction(async () => {
      const checkpoint = RecoveryCheckpointSchema.parse(unwrap(await this.ports.engine.createCheckpoint(command)));
      WorkflowAggregateCheckpointStateSchema.parse(checkpoint.state);
      unwrap(await this.ports.runStore.saveCheckpoint(checkpoint, command.expectedVersion));
      return checkpoint;
    });
  }
  private initialization: Promise<void> | undefined;
  async initialize(): Promise<void> {
    this.initialization ??= (async () => {
      AgentTransportCapabilitiesSchema.parse(unwrap(await this.ports.transport.initialize({
        runtimeId: `p19-${digest(this.journal.repository).slice(0, 16)}`, configuration: {}, recoveryMode: true, initializedAt: this.now()
      })));
      SessionManifestSchema.parse(unwrap(await this.ports.panes.getManifest()));
      await this.transaction(async (state, save, core) => {
        // These flags describe coroutines owned by the previous process, not durable verification outcomes.
        // Keep a persisted outcome for finishVerification; otherwise the next tick resumes the frozen plan.
        let changed = false;
        for (const run of state.runs) {
          if (run.cancelled || ["completed", "failed", "cancelled"].includes(run.status)) continue;
          // A diagnostic handoff in older hosts could regress an approved,
          // already-created Core workflow into a preparation-only phase.
          const preparationPhases = ["intake", "clarifying", "specifying", "planning"];
          const resumePreparation = run.status === "escalated" && run.pendingAction?.kind === "resume_coordinator" &&
            preparationPhases.includes(run.pendingAction.previousStatus ?? "");
          if (run.coreCreated && run.definition && run.workflowSpec?.specification.status === "approved" &&
              (preparationPhases.includes(run.status) || resumePreparation)) {
            const snapshot = await core.snapshot(run.runId);
            if (!["failed", "cancelled", "cancelling"].includes(snapshot.status)) {
              const pendingApproval = ["task", "delivery"].includes(run.approvalKind ?? "") &&
                run.approval?.status === "pending" && run.decision?.approvalId !== run.approval.approvalId;
              const phase = pendingApproval ? "awaiting_approval" :
                run.workflowVerificationPending || run.tasks.some(task => task.verificationPending) ? "verifying" : "implementing";
              if (resumePreparation) run.pendingAction!.previousStatus = phase;
              else run.status = phase;
              changed = true;
            }
          }
          // Older hosts escalated a refused allocation without its own resume
          // action (or retained an unrelated, already-resumed planning action).
          const allocationTask = run.coreCreated && run.status === "escalated" ? run.tasks.find(task =>
            run.error?.startsWith(`Developer allocation pending for ${task.taskId}: `)) : undefined;
          if (allocationTask && (!run.pendingAction || run.pendingAction.reason !== run.error!.slice(0, 2000))) {
            this.pauseDeveloperAllocation(run, allocationTask.taskId, run.error!); changed = true;
          }
          for (const task of run.tasks) {
            const outcome = state.pendingVerifications.some(item => pendingRunId(item) === run.runId && pendingTaskId(item) === task.taskId);
            if (task.verificationPending && !outcome) { task.verificationPending = false; changed = true; }
          }
          const workflowOutcome = state.pendingVerifications.some(item => pendingRunId(item) === run.runId && pendingTaskId(item) === FINAL_TASK);
          if (run.workflowVerificationPending && !workflowOutcome) { run.workflowVerificationPending = false; changed = true; }
        }
        if (changed) await save();
      });
      await this.journal.exclusive(async state => { this.refreshTaskLogAssignmentSnapshot(state); });
    })();
    return this.initialization;
  }
  private now(): string { return (this.ports.clock?.() ?? new Date()).toISOString(); }
  /** Lock-free best-effort diagnostic context derived only from the latest committed journal snapshot. */
  taskLogAssignmentContext(binding: PaneBinding): TaskLogAssignment | undefined {
    return taskLogAssignmentContextFromSnapshot(this.taskLogAssignmentSnapshot, binding);
  }
  private refreshTaskLogAssignmentSnapshot(state: JournalState): void {
    this.taskLogAssignmentSnapshot = state.outbound.flatMap(item => item.handle && ["accepted", "released"].includes(item.status)
      ? [{ status: item.status, taskId: taskLogBusinessTaskId(item), attemptId: item.attemptId, message: { run_id: item.message.run_id }, handle: item.handle }]
      : []);
  }
  private async transaction<T>(action: (state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox) => Promise<T>): Promise<T> {
    return this.journal.exclusive(async (state, save) => {
      this.refreshTaskLogAssignmentSnapshot(state);
      let previous = structuredClone(state);
      const logChanges = async () => {
        const oldEvents = new Set(previous.pendingCore.flatMap(batch => batch.events.map(event => event.eventId)));
        for (const batch of state.pendingCore) for (const event of batch.events) if (!oldEvents.has(event.eventId) && event.type !== "command.completed") {
          const payload = typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
          const kind = event.type.startsWith("approval.") ? "approval" : event.type.startsWith("quality_gate.") ? "verification" :
            event.type === "agent.delivery_uncertain" ? "error" : event.type === "agent.delivery_reconciled" ? "recovery" :
              event.type.startsWith("agent.") ? "transport" : event.type.startsWith("task.dispatch") ? "assignment" : "progress";
          const outcome = typeof payload.to === "string" ? payload.to : typeof payload.status === "string" ? payload.status : undefined;
          await this.activityLog.record({ kind, role: "runtime", action: event.type, runId: event.runId,
            ...(event.taskId ? { taskId: event.taskId } : {}), ...(typeof payload.attemptId === "string" ? { attemptId: payload.attemptId } : {}),
            ...(outcome ? { outcome } : {}) });
        }
        const oldRuns = new Map(previous.runs.map(run => [run.runId, run.status]));
        for (const run of state.runs) {
          const before = oldRuns.get(run.runId);
          if (before === undefined) await this.activityLog.record({ kind: "admission", role: "runtime", action: "run_admitted", runId: run.runId, outcome: run.status });
          else if (before !== run.status) await this.activityLog.record({ kind: run.status === "cancelled" ? "cancellation" : run.status === "awaiting_approval" ? "approval" : ["completed", "failed", "escalated"].includes(run.status) ? "result" : "progress",
            role: "runtime", action: "run_status_changed", runId: run.runId, outcome: `${before} -> ${run.status}` });
          const beforeRun = previous.runs.find(item => item.runId === run.runId);
          if (run.error && beforeRun?.error !== run.error)
            await this.activityLog.record({ kind: "error", role: "runtime", action: "run_error_recorded", runId: run.runId, outcome: "A Runtime workflow error was recorded; inspect the authorized run diagnostics." });
          for (const task of run.tasks) {
            const beforeTask = beforeRun?.tasks.find(item => item.taskId === task.taskId);
            if (!beforeTask) await this.activityLog.record({ kind: "specification", role: "runtime", action: "task_specification_accepted",
              runId: run.runId, taskId: task.taskId, outcome: `${task.spec.specification.level}/${task.spec.strategy.tddDecision.mode}` });
            if (!beforeTask || beforeTask.result?.requestId !== task.result?.requestId || beforeTask.result?.status !== task.result?.status) {
              if (task.result) await this.activityLog.record({ kind: task.result.status === "blocked" || task.result.status === "failed" || task.result.status === "timed_out" ? "error" : "transport",
                role: "runtime", action: `agent_result:${task.result.status}`, runId: run.runId, taskId: task.taskId, attemptId: task.result.attemptId,
                outcome: "Authenticated result received; independent acceptance may still be pending" });
            }
            if (beforeTask?.cycle?.status !== task.cycle?.status || beforeTask?.cycle?.history.length !== task.cycle?.history.length)
              await this.activityLog.record({ kind: "verification", role: "runtime", action: "verification_cycle_changed", runId: run.runId, taskId: task.taskId,
                outcome: task.cycle?.status ?? "started" });
            const beforeEvidence = Array.isArray(beforeTask?.spec.strategy.metadata?.tddEvidence) ? beforeTask.spec.strategy.metadata.tddEvidence : [];
            const currentEvidence = Array.isArray(task.spec.strategy.metadata?.tddEvidence) ? task.spec.strategy.metadata.tddEvidence : [];
            const priorEvidenceIds = new Set(beforeEvidence.flatMap(item => typeof item === "object" && item !== null && !Array.isArray(item) && typeof item.verificationId === "string" ? [item.verificationId] : []));
            for (const evidence of currentEvidence) {
              if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) continue;
              const receipt = evidence as Record<string, unknown>, phase = typeof receipt.metadata === "object" && receipt.metadata !== null && !Array.isArray(receipt.metadata)
                ? (receipt.metadata as Record<string, unknown>).conditionalTdd : undefined;
              const phaseName = phase && typeof phase === "object" && !Array.isArray(phase) ? (phase as Record<string, unknown>).phase : undefined;
              if (typeof receipt.verificationId === "string" && !priorEvidenceIds.has(receipt.verificationId) && typeof phaseName === "string")
                await this.activityLog.record({ kind: "tdd", role: "runtime", action: `tdd_evidence_accepted:${phaseName}`, runId: run.runId, taskId: task.taskId });
            }
          }
          if (beforeRun && JSON.stringify(beforeRun.decision) !== JSON.stringify(run.decision) && run.decision)
            await this.activityLog.record({ kind: "approval", role: "runtime", action: "approval_decision_recorded", runId: run.runId, outcome: run.decision.decision });
        }
        const oldOut = new Map(previous.outbound.map(item => [item.message.message_id, item]));
        for (const item of state.outbound) {
          const before = oldOut.get(item.message.message_id);
          if (before?.status === item.status && before?.error === item.error) continue;
          const type = item.message.type;
          await this.activityLog.record({ kind: type === "task.assignment" ? "assignment" : type === "verification.requested" ? "verification" : type === "approval.request" ? "approval" : "planning",
            role: "runtime", action: before ? `${type}:${before.status}->${item.status}` : type,
            ...(item.message.run_id ? { runId: item.message.run_id } : {}), taskId: taskLogBusinessTaskId(item) ?? item.taskId, attemptId: item.attemptId, outcome: item.status });
        }
        const oldInbox = new Set(previous.inbox.map(item => item.message.message_id));
        for (const item of state.inbox) if (!oldInbox.has(item.message.message_id)) await this.activityLog.record({
          kind: item.message.type.includes("approval") ? "approval" : item.message.type.includes("verification") || item.message.type === "review.verdict" ? "verification" : item.message.type === "implementation.submitted" ? "transport" : "progress",
          role: item.message.sender.role, action: item.message.type, ...(item.message.run_id ? { runId: item.message.run_id } : {}), outcome: item.status });
        previous = structuredClone(state);
      };
      const saveAndLog = async () => { await save(); this.refreshTaskLogAssignmentSnapshot(state); await logChanges(); };
      const core = new CoreSession(this.ports, state, saveAndLog);
      await core.restore();
      const outbox = new HerdrOutbox(this.ports, state, saveAndLog);
      await this.recoverPhaseFailures(state, saveAndLog, outbox);
      return action(state, saveAndLog, core, outbox);
    });
  }
  private run(state: JournalState, runId: string): RunRecord {
    const run = state.runs.find(item => item.runId === runId);
    if (!run) throw new Error(`Unknown delegation run ${runId}`);
    return run;
  }
  private live(run: RunRecord): void {
    if (resumablyPaused(run)) throw new Error(`Run ${run.runId} is paused awaiting resume of action ${run.pendingAction!.actionId}; retry this same call after the run resumes`);
    if (run.cancelled || ["completed", "failed", "cancelled", "escalated"].includes(run.status)) throw new Error(`Run is ${run.status}`);
  }
  private emit(state: JournalState, outbox: HerdrOutbox, run: RunRecord, type: RoleMessage["type"], payload: unknown,
    key: string, recipient: RoleMessage["recipient"]["role"] = "conversation", artifacts: ArtifactReference[] = []): Outbound {
    const messageId = `p19-${digest([run.runId, key])}`;
    const existing = state.outbound.find(out => out.message.message_id === messageId);
    if (existing) return existing;
    return outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: messageId,
      correlation_id: run.delegation.correlationId, causation_id: run.delegation.messageId,
      run_id: run.runId, sender: { role: "coordinator" }, recipient: { role: recipient }, type,
      payload: json(payload), artifact_references: artifacts, occurred_at: this.now(), idempotency_key: messageId }));
  }
  private progress(state: JournalState, outbox: HerdrOutbox, run: RunRecord, headline: string): void {
    this.emit(state, outbox, run, "conversation.progress", { sdlcStatus: run.status, headline,
      ...(run.error ? { blockageReason: run.error } : {}),
      ...(run.status === "completed" ? { verified: true, completedVerified: true } : {}) }, `progress:${run.status}:${headline}`,
      "conversation", run.status === "completed" ? run.workflowCycle?.history.at(-1)?.evidenceArtifacts ?? [] : []);
  }
  /**
   * A specialist reply is recorded in the inbox, but the Coordinator yielded its turn after requesting it and nothing else
   * prompts that pane. Runtime therefore queues a Herdr notice (never a file/SQLite mailbox) carrying the reply. It is a wake-up
   * only: it grants no approval and the Coordinator must still go through Runtime tools and gates.
   */
  private wakeCoordinator(state: JournalState, outbox: HerdrOutbox, run: RunRecord, message: RoleMessage): void {
    const messageId = `p19-wake-${digest([run.runId, message.message_id])}`;
    if (state.outbound.some(out => out.message.message_id === messageId)) return;
    outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: messageId, correlation_id: run.delegation.correlationId,
      causation_id: message.message_id, run_id: run.runId, sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status",
      payload: { kind: isConversationContext(message) ? "conversation_context_ready" : "specialist_result_ready", fromRole: message.sender.role, messageType: message.type, sourceMessageId: message.message_id,
        sdlcStatus: run.status, result: message.payload, next: "Call inspect to read the durable inbox, then continue the workflow or report a blocker." },
      artifact_references: message.artifact_references, occurred_at: this.now(), idempotency_key: messageId }), "coordinator");
  }
  /** Reconstruct a lost deterministic wake from an already-applied, correlated result during recovery. */
  async recoverMissingCoordinatorWakeups(): Promise<JsonValue> {
    // `received` is the durable inbox write-ahead before semantic application. The envelope was parsed and authenticated
    // before that write. Reapply all business validators, deferring blocked/terminal runs until an authorized resume.
    const received = await this.transaction(async state => state.inbox.filter(item => item.status === "received" &&
        (isCancellationHandoff(item.message) || state.outbound.some(out => out.reviewReplacement && out.message.message_id === item.message.causation_id) || !state.runs.some(run => run.runId === item.message.run_id && (run.cancelled ||
          TERMINAL_RUN_STATUSES.includes(run.status) && !this.acceptsPausedNativeReply(state, run, item.message) &&
          !(run.status === "escalated" && isConversationContext(item.message))))))
      .map(item => RoleMessageSchema.parse(item.message)));
    let replayed = 0;
    for (const message of received) {
      try {
        await withRecoveredHerdrReceipt(message, async () => {
          if (message.recipient.role === "conversation" && message.sender.role === "coordinator") await this.observeCoordinatorOutcome(message);
          else await this.applyAuthenticatedHerdrMessage(message, true);
        });
        replayed++;
      }
      catch (error) {
        // Rejected and unknown/terminal results remain persisted; surface their concrete failure without any resend.
        await this.reportInboundFailure(message, String(error));
      }
    }
    return this.transaction(async (state, save, _core, outbox) => {
      let recovered = 0;
      for (const item of state.inbox.filter(entry => entry.status === "applied" && entry.message.recipient.role === "coordinator" &&
          entry.message.sender.role !== "coordinator" && entry.message.sender.role !== "conversation")) {
        const message = RoleMessageSchema.parse(item.message);
        if (!message.run_id || !message.causation_id || !["spec.draft", "task.status", "verification.escalation"].includes(message.type)) continue;
        const source = state.outbound.find(out => out.message.message_id === message.causation_id && out.message.run_id === message.run_id &&
          out.message.recipient.role === message.sender.role && out.handle?.target.agentId === message.sender.agent_id &&
          out.handle?.target.paneId === message.sender.pane_id && ["accepted", "released"].includes(out.status));
        if (!source) continue; // Do not infer result ownership from role or Herdr idle/done alone.
        const run = state.runs.find(candidate => candidate.runId === message.run_id);
        if (!run || run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status) || run.status === "awaiting_approval" ||
            Object.values(run.userDecisions ?? {}).some(decision => decision.status === "pending")) continue;
        const wakeId = `p19-wake-${digest([run.runId, message.message_id])}`;
        if (state.outbound.some(out => out.message.message_id === wakeId)) continue;
        const blockage = specialistBlockage(message.payload);
        if (blockage !== undefined) this.reportSpecialistBlocked(state, outbox, run, message, blockage);
        this.wakeCoordinator(state, outbox, run, message);
        recovered++;
      }
      if (this.settleNativeDeliveries(state)) recovered++;
      if (recovered) await save();
      return json({ recovered: recovered + replayed });
    });
  }
  /**
   * Surfaces a delivery failure to the user through Conversation. Idempotent per (message, failure class): every retry, reconciliation
   * and dropped-report of the same message reuses the first notice instead of adding one with a different reason text.
   */
  private surfaceFailure(state: JournalState, outbox: HerdrOutbox, run: RunRecord, messageId: string, failureClass: FailureClass,
    subject: string, reason: string, options: string[] = DELIVERY_FAILURE_OPTIONS): void {
    const text = `${subject}: ${reason}. The run is waiting and will not continue until this is resolved.`;
    this.emit(state, outbox, run, "conversation.progress", { kind: "delivery_failure", runId: run.runId, sdlcStatus: run.status,
      ...(run.pendingAction === undefined ? {} : { owner: run.pendingAction.owner, actionId: run.pendingAction.actionId }),
      headline: `Herdr delivery failed: ${subject}`, reason: text, blockageReason: text, options },
      `delivery-failure:${digest([messageId, failureClass])}`);
  }
  /** A message Runtime refused at admission. Its refusal is the notice, so no delivery-failure report may be added for it. */
  private refused(state: JournalState, messageId: string): boolean {
    return state.inbox.some(item => item.message.message_id === messageId && item.status === "rejected");
  }
  /**
   * Counts one invalid RoleMessage of `role` for one assignment/causation `sourceId` and returns the new count. A replay of the
   * same inbound envelope (`messageId` already counted) is not counted again, so restarts and redeliveries keep the count exact.
   */
  private countInvalidMessage(run: RunRecord, role: string, sourceId: string, messageId?: string): number {
    const key = `${role}:${sourceId}`;
    const ledger = run.invalidMessages ??= [];
    let entry = ledger.find(item => item.key === key);
    if (entry && messageId !== undefined && entry.messageIds.includes(messageId)) return entry.count;
    if (!entry) { entry = { key, count: 0, messageIds: [] }; ledger.push(entry); if (ledger.length > 50) ledger.shift(); }
    entry.count = Math.min(1000, entry.count + 1);
    if (messageId !== undefined) entry.messageIds = [...entry.messageIds, messageId].slice(-10);
    return entry.count;
  }
  /**
   * After INVALID_ROLE_MESSAGE_LIMIT invalid messages for one assignment the run is handed to the Coordinator (reassign, change
   * role or report a blocker) as a bounded `auto_resume` action. A pending human gate is never bypassed: the run then only
   * records the reason. Returns whether the run was escalated.
   */
  private escalateInvalidMessages(run: RunRecord, sourceMessageId: string, reason: string, createdAt = this.now()): boolean {
    if (run.status === "awaiting_approval" || Object.values(run.userDecisions ?? {}).some(item => item.status === "pending")) return false;
    const previousStatus = run.status, inherited = inheritedAutoResume(run);
    run.error = reason.slice(0, 2000); run.status = "escalated";
    run.pendingAction = { actionId: `next-${digest([run.runId, sourceMessageId])}`, kind: "resume_coordinator", owner: "coordinator",
      reason: run.error, sourceMessageId, createdAt, state: "pending", previousStatus, ...inherited, recovery: "auto_resume" };
    return true;
  }
  /**
   * Returns a refused message's validation error to the agent that sent it, through Herdr, so it can fix and resend. A Developer
   * holding an active assignment is reached by a task notice under that assignment's lease; other roles by a Runtime task.status.
   * Conversation is never addressed. Idempotent per (run, key, attempt). Returns whether a notice was queued.
   */
  private returnValidationError(state: JournalState, outbox: HerdrOutbox, run: RunRecord, rejected: RoleMessage, key: string,
    attempt: number, error: string): boolean {
    const role = rejected.sender.role;
    if (role === "conversation" || role === "runtime" || role === "user") return false;
    const id = `invalid-feedback-${digest([run.runId, key, attempt])}`;
    if (state.outbound.some(out => out.message.message_id === id)) return true;
    const payload = json({ kind: "role_message_rejected", status: "rejected", runId: run.runId, rejectedMessageId: rejected.message_id,
      rejectedType: rejected.type, attempt, limit: INVALID_ROLE_MESSAGE_LIMIT, errors: error,
      next: `Runtime refused your ${rejected.type} (${rejected.message_id}): ${error}. Fix these fields and send a schema-valid message again ` +
        `with send_role_message (attempt ${attempt} of ${INVALID_ROLE_MESSAGE_LIMIT}); keep the original correlation_id and causation_id.` });
    const base = { schema_version: 2 as const, message_id: id, correlation_id: run.delegation.correlationId, causation_id: rejected.message_id,
      run_id: run.runId, type: "task.status" as const, payload, artifact_references: [], occurred_at: this.now(), idempotency_key: id };
    const assignment = role === "developer" ? [...state.outbound].reverse().find(out => out.message.type === "task.assignment" &&
      out.message.run_id === run.runId && out.status === "accepted" && out.handle !== undefined &&
      (rejected.sender.pane_id === undefined || out.handle.target.paneId === rejected.sender.pane_id)) : undefined;
    try {
      if (assignment?.handle) outbox.enqueueTaskNotice(RoleMessageSchema.parse({ ...base, sender: { role: "coordinator" },
        recipient: { role: "developer", agent_id: assignment.handle.target.agentId, pane_id: assignment.handle.target.paneId } }), assignment);
      // A Developer whose assignment still holds its writer lease cannot take a second lease; it is reached only by a task notice.
      else if (role === "developer" && state.outbound.some(out => out.message.type === "task.assignment" && out.message.run_id === run.runId &&
          out.status === "accepted")) return false;
      else outbox.enqueue(RoleMessageSchema.parse({ ...base, sender: { role: "runtime" },
        recipient: { role, ...(rejected.sender.agent_id ? { agent_id: rejected.sender.agent_id } : {}), ...(rejected.sender.pane_id ? { pane_id: rejected.sender.pane_id } : {}) } }), role);
      return true;
    } catch { return false; }
  }
  /** Called by the host when an authenticated inbound message could not be applied; the failure must not stay silent. */
  async reportInboundFailure(input: unknown, reason: string): Promise<void> {
    const message = RoleMessageSchema.safeParse(input);
    if (!message.success || !message.data.run_id) return;
    const data = message.data;
    await this.transaction(async (state, save, _core, outbox) => {
      const run = state.runs.find(item => item.runId === data.run_id);
      if (!run || run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status) || this.refused(state, data.message_id)) return;
      const text = redactString(reason);
      // The message's own content failed validation: retrying the same envelope cannot help, but the sender can fix it. Return the
      // readable error to the sender; only the INVALID_ROLE_MESSAGE_LIMIT-th invalid message for one assignment involves the
      // Coordinator (bounded auto_resume). Transport/uncertain failures keep the delivery-failure path below.
      if (isMessageContentFailure(text) && inboundFailureClass(text) !== "transport_uncertain" &&
          !["conversation", "runtime", "user"].includes(data.sender.role)) {
        const sourceId = invalidMessageSource(data), key = `${data.sender.role}:${sourceId}`;
        const attempt = this.countInvalidMessage(run, data.sender.role, sourceId, data.message_id);
        const error = describeValidationError(text);
        // Deterministic content refusal: journal it as rejected so redelivery/replay is answered without re-counting.
        const inbox = state.inbox.find(item => item.message.message_id === data.message_id);
        if (inbox && inbox.status === "received") {
          this.assertNativeMessageConsistent(state, data);
          inbox.status = "rejected"; inbox.reason = `Invalid ${data.type} content: ${error}`.slice(0, 2000);
          this.settleNativeDeliveries(state);
        }
        if (attempt < INVALID_ROLE_MESSAGE_LIMIT) {
          this.returnValidationError(state, outbox, run, data, key, attempt, error);
          await save(); return;
        }
        this.escalateInvalidMessages(run, data.message_id, `${data.type} from ${data.sender.role} was invalid ${attempt} times for ${sourceId}: ${error}`,
          data.occurred_at ?? this.now());
        this.surfaceFailure(state, outbox, run, data.message_id, "inbound_failed",
          `${data.type} from ${data.sender.role} to ${data.recipient.role} (${data.message_id})`, text, INBOUND_FAILURE_OPTIONS);
        await save(); return;
      }
      if (inboundFailureFinal(text) && run.status !== "awaiting_approval" && !Object.values(run.userDecisions ?? {}).some(item => item.status === "pending")) {
        const previousStatus = run.status;
        run.error = `${data.type} ingress failed: ${text}`.slice(0, 2000);
        run.status = "escalated";
        run.pendingAction = { actionId: `next-${digest([run.runId, data.message_id])}`, kind: "resume_coordinator", owner: "coordinator",
          reason: run.error, sourceMessageId: data.message_id, createdAt: data.occurred_at ?? this.now(), state: "pending", previousStatus, resumeAttempts: 0, recovery: "manual" };
      }
      const failureClass = inboundFailureClass(text);
      this.surfaceFailure(state, outbox, run, data.message_id, failureClass,
        `${data.type} from ${data.sender.role} to ${data.recipient.role} (${data.message_id})`, text, failureClass === "transport_uncertain" ? UNCERTAIN_DELIVERY_OPTIONS : INBOUND_FAILURE_OPTIONS);
      await save();
    });
  }
  /**
   * Authenticated host report for a schema-invalid native RoleMessage rejected before transport intent. The host returns the
   * readable validation error to the agent as the synchronous tool error, so it can fix and resend in the same turn; Runtime only
   * counts the attempt per (run, sender role, assignment). The INVALID_ROLE_MESSAGE_LIMIT-th invalid message for one assignment
   * hands the run to the Coordinator as a bounded `auto_resume` action and tells Conversation once. Returns the attempt
   * accounting, or undefined when the pane holds no live assignment.
   */
  async reportRoleToolFailure(bindingInput: unknown, rawMessage: unknown, reasonInput: string):
    Promise<{ attempt: number; limit: number; escalated: boolean } | undefined> {
    const binding = PaneBindingSchema.parse(bindingInput);
    const raw = objectField(rawMessage, "message") ?? rawMessage;
    const claimedRunId = objectField(raw, "run_id");
    const claimedMessageId = objectField(raw, "message_id");
    const claimedCause = objectField(raw, "causation_id"), claimedCorrelation = objectField(raw, "correlation_id");
    return this.transaction(async (state, save, _core, outbox) => {
      const sources = state.outbound.filter(out => out.handle?.target.paneId === binding.paneId && out.handle.target.agentId === binding.agentId &&
        out.handle.target.workspaceId === binding.workspaceId && out.handle.target.tabId === binding.tabId && digest(out.handle.target.session) === digest(binding.session) &&
        out.message.recipient.role === binding.role && ["accepted", "released"].includes(out.status) &&
        (typeof claimedRunId !== "string" || out.message.run_id === claimedRunId) &&
        (typeof claimedCause !== "string" || out.message.message_id === claimedCause) &&
        (typeof claimedCorrelation !== "string" || out.message.correlation_id === claimedCorrelation));
      const source = sources.length === 1 ? sources[0] : undefined; // Never guess which attempt an invalid output belongs to.
      const run = state.runs.find(item => item.runId === (source?.message.run_id ?? claimedRunId));
      if (!run || !source || run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status)) return undefined;
      const messageId = typeof claimedMessageId === "string" && claimedMessageId.length <= 200 ? claimedMessageId : `invalid-role-message-${digest([binding.paneId, source.message.message_id, reasonInput])}`;
      // Every tool call is a distinct attempt (an agent may reuse its message_id when retrying), so no message-id dedupe here.
      const attempt = this.countInvalidMessage(run, binding.role, source.message.message_id);
      if (attempt < INVALID_ROLE_MESSAGE_LIMIT) { await save(); return { attempt, limit: INVALID_ROLE_MESSAGE_LIMIT, escalated: false }; }
      const reason = `Rejected invalid ${binding.role} RoleMessage before transport ${attempt} times for ${source.message.message_id}: ${describeValidationError(reasonInput)}`.slice(0, 2000);
      const escalated = this.escalateInvalidMessages(run, messageId, reason);
      const automatic = escalated && (run.pendingAction?.resumeAttempts ?? 0) < AUTO_RESUME_LIMIT;
      this.emit(state, outbox, run, "conversation.progress", { kind: "workflow_blocked", runId: run.runId,
        sdlcStatus: run.status, owner: "coordinator", ...(run.pendingAction === undefined ? {} : { actionId: run.pendingAction.actionId }),
        headline: automatic ? `${binding.role} sent ${attempt} invalid messages; Runtime hands the assignment back to Coordinator automatically`
          : "Agent result was rejected before delivery", reason, blockageReason: reason,
        ...(automatic ? { automaticResume: automaticResumeNotice(run.pendingAction!) } : {}),
        options: ["Ask Coordinator to send a schema-valid result or explain the blocker", "Cancel run"] },
      `invalid-role-message:${digest([run.runId, messageId, attempt])}`, "conversation");
      await save();
      return { attempt, limit: INVALID_ROLE_MESSAGE_LIMIT, escalated };
    });
  }
  /**
   * Read-only: why Runtime refused an inbound message, or undefined. Hosts consult it before retrying or reporting a delivery, so a
   * refused message is never resent. It takes the journal lock itself, so it must not run inside another Runtime transaction.
   */
  async inboundRejection(messageId: string): Promise<string | undefined> {
    return this.journal.exclusive(async state => state.inbox.find(item => item.message.message_id === messageId && item.status === "rejected")?.reason);
  }
  /** Each stuck outbound handoff is reported once per distinct error; reports about reports are never created. */
  private surfaceOutboundFailures(state: JournalState, outbox: HerdrOutbox): boolean {
    let changed = false;
    for (const out of [...state.outbound]) {
      if (!out.error || !["queued", "unknown_delivery"].includes(out.status) || !out.message.run_id) continue;
      // Capacity/lease backpressure retries by itself. Surfaced: uncertain delivery, structural blockers, a recipient not ready
      // past NOT_READY_FAILURE_MS (recorded in the error), and repeated dispatch failures. Delivery keeps retrying in every case.
      const uncertain = out.status === "unknown_delivery";
      const repeated = (out.deliveryAttempts ?? 0) >= DISPATCH_FAILURE_NOTICE_ATTEMPTS;
      if (!uncertain && !repeated && !STRUCTURAL_DELIVERY_BLOCKERS.test(out.error)) continue;
      if (out.message.type === "conversation.progress" && record(out.message.payload).kind === "delivery_failure") continue;
      const run = state.runs.find(item => item.runId === out.message.run_id);
      if (!run || run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status)) continue;
      const before = state.outbound.length;
      if (uncertain && !run.pendingAction && !isConversationContextWake(out.message)) {
        const reason = `Delivery to ${out.message.recipient.role} is unknown: ${redactString(out.error)}. Reconcile before any resend.`.slice(0, 2000);
        run.error = reason;
        run.pendingAction = { actionId: `next-${digest([run.runId, out.message.message_id])}`, kind: "resume_coordinator", owner: "coordinator",
          reason, sourceMessageId: out.message.message_id, createdAt: this.now(), state: "pending", recovery: "reconcile_delivery" };
      }
      this.surfaceFailure(state, outbox, run, out.message.message_id, uncertain ? "transport_uncertain" : "undeliverable",
        `${out.message.type} to ${out.message.recipient.role} (${out.message.message_id})`, redactString(out.error),
        uncertain ? UNCERTAIN_DELIVERY_OPTIONS : DELIVERY_FAILURE_OPTIONS);
      changed ||= state.outbound.length !== before;
    }
    return changed;
  }
  /** A failed capability proof is terminal for this immutable unsent message and creates one resumable blocker. */
  private surfaceCapabilityPreflightFailures(state: JournalState, outbox: HerdrOutbox): void {
    const allFailures = state.outbound.filter(item => item.status === "failed" && item.error?.includes(RoleCapabilityPreflightError.name));
    for (const failure of allFailures.filter(item => isConversationContextWake(item.message))) {
      const run = state.runs.find(item => item.runId === failure.message.run_id);
      if (run && !run.cancelled && !["completed", "failed", "cancelled"].includes(run.status))
        this.surfaceFailure(state, outbox, run, failure.message.message_id, "undeliverable", "Informational Conversation context", redactString(failure.error ?? "Capability unavailable"));
    }
    const failures = allFailures.filter(item => !isConversationContextWake(item.message));
    const byRun = new Map<string, Outbound[]>();
    for (const out of failures) if (out.message.run_id) byRun.set(out.message.run_id, [...(byRun.get(out.message.run_id) ?? []), out]);
    for (const runFailures of byRun.values()) {
      const out = runFailures[0]!;
      const run = state.runs.find(item => item.runId === out.message.run_id);
      if (!run || run.cancelled || ["completed", "failed", "cancelled"].includes(run.status)) continue;
      const existing = run.pendingAction?.kind === "resume_coordinator" ? run.pendingAction : undefined;
      if (existing?.state === "pending" && runFailures.every(failure => [existing.sourceMessageId, ...(existing.relatedMessageIds ?? [])].includes(failure.message.message_id))) continue;
      if (run.status === "awaiting_approval" || Object.values(run.userDecisions ?? {}).some(item => item.status === "pending")) {
        for (const failure of runFailures) {
          const messageId = `capability-blocked-${digest([run.runId, failure.message.message_id])}`;
          if (!state.outbound.some(item => item.message.message_id === messageId)) outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: messageId, correlation_id: run.delegation.correlationId,
            causation_id: failure.message.message_id, run_id: run.runId, sender: { role: "runtime" }, recipient: { role: "conversation" },
            type: "conversation.progress", payload: { kind: "workflow_blocked", runId: run.runId, sdlcStatus: run.status,
              owner: "coordinator", reason: `Capability preflight blocked ${failure.message.recipient.role}: ${failure.error}`.slice(0, 2000),
              headline: "A role capability is unavailable; the approval gate remains pending", options: ["Resolve the current approval, then recheck capability", "Cancel run"] },
            artifact_references: [], occurred_at: this.now(), idempotency_key: messageId }), "conversation");
        }
        continue;
      }
      const previousStatus = run.status;
      const reason = runFailures.map(failure => redactString(failure.error ?? "Role capability preflight failed")).join("; ").slice(0, 2000);
      run.error = reason;
      run.status = "escalated";
      run.pendingAction = { actionId: `next-${digest([run.runId, out.message.message_id])}`, kind: "resume_coordinator", owner: "coordinator",
        reason, sourceMessageId: out.message.message_id, relatedMessageIds: runFailures.slice(1).map(failure => failure.message.message_id),
        createdAt: existing?.createdAt ?? this.now(), state: "pending", previousStatus: existing?.previousStatus ?? previousStatus,
        resumeAttempts: existing?.resumeAttempts ?? 0, ...inheritedManualResume(run), recovery: "capability_repair" };
      // A recurrence after a resume is a new episode of the same unsent message and is surfaced again.
      const episode = run.pendingAction.resumeAttempts ? [run.pendingAction.resumeAttempts] : [];
      const messageId = `capability-blocked-${digest([run.runId, out.message.message_id, ...episode])}`;
      if (!state.outbound.some(item => item.message.message_id === messageId)) outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: messageId, correlation_id: run.delegation.correlationId,
        causation_id: out.message.message_id, run_id: run.runId, sender: { role: "runtime" }, recipient: { role: "conversation" },
        type: "conversation.progress", payload: { kind: "workflow_blocked", runId: run.runId, sdlcStatus: run.status,
          owner: "coordinator", actionId: run.pendingAction.actionId, reason, blockageReason: reason,
          headline: `Capability preflight blocked ${out.message.recipient.role} before dispatch`,
          options: ["Khôi phục capability rồi tiếp tục cùng run", "Hủy run"] },
        artifact_references: [], occurred_at: this.now(), idempotency_key: messageId }), "conversation");
    }
  }
  /**
   * Trusted local host enqueues a message; work delivery uses Herdr and cancellation is applied by Runtime. A Conversation requirement revision or
   * approval decision is admitted here, before it can reach the Coordinator pane: a refused one is never enqueued.
   */
  async queueHerdr(input: unknown): Promise<JsonValue> {
    if (this.quiesced) throw new Error("Runtime is quiesced");
    const message = RoleMessageSchema.parse(input);
    const result = await this.transaction(async (state, save, core, outbox) => {
      if (isConversationHandoff(message)) {
        const delegation = DelegationRequestSchema.parse(message.payload);
        const pending = this.inFlightDelegations(state, delegation.runId);
        const run = state.runs.find(run => run.runId === delegation.runId);
        let admission = this.admitDelegation(state, delegation, pending);
        // Older hosts could persist a queued revision without binding its content
        // to the run. Reconcile only the latest exact replay through normal
        // admission checks; never invent a signed inbound transport receipt.
        if (admission.kind === "duplicate" && run && revisionOf(delegation) > revisionOf(run.delegation) &&
            !pending.some(item => revisionOf(item) > revisionOf(delegation)))
          admission = this.admitDelegation(state, delegation, []);
        // A duplicate carries already-admitted content, so a later turn re-sending it is still delivered; the outbox dedupes by message id.
        if (admission.kind === "rejected") { this.notifyRejection(state, outbox, message, admission.reason); await save(); throw new AdmissionRejectedError(admission.reason); }
        // The trusted Conversation already authorized this objective. Persist intake before capability/transport
        // checks, without inventing signed ingress or Coordinator acceptance. A first-dispatch failure must be resumable.
        if (admission.kind === "revision") {
          this.resumeForRevision(run!, message.message_id);
          this.admitRevision(state, outbox, run!, delegation);
        }
        if (admission.kind === "new" && !state.runs.some(run => run.runId === delegation.runId)) state.runs.push({
          runId: delegation.runId!, delegation, status: "intake", tasks: [], coreCreated: false, cancelled: false, maxIterations: 3
        });
      }
      if (isCancellationHandoff(message)) await this.cancellationTarget(state, message);
      if (message.type === "approval.decision") {
        const run = state.runs.find(item => item.runId === message.run_id);
        if (run && (run.cancelled || ["completed", "failed", "cancelled"].includes(run.status)))
          throw new AdmissionRejectedError(`Run is ${run.status}; approval is no longer actionable`);
        const reason = run && supersededReason(run, ApprovalDecisionSchema.parse(message.payload).approvalId);
        if (reason !== undefined) throw new AdmissionRejectedError(reason);
      }
      const out = outbox.enqueue(message); await save();
      if (isCancellationHandoff(message)) await this.drainCancellationControls(state, save, core, outbox);
      return json(out.message);
    });
    // Scheduler verification may be awaiting a specialist; cancellation must reject its waiter and report without another tick.
    // A Gateway inbox callback may itself enqueue this control. Do not await that same in-flight delivery recursively.
    if (isCancellationHandoff(message)) void this.deliverConversationInbox().catch(() => undefined);
    return result;
  }
  /**
   * Decides whether a Conversation delegation opens a run, repeats one already known, revises the run's requirement, or is refused.
   * `inFlight` holds the revisions already handed to Runtime but not yet received, so a stale revision cannot slip in behind a newer one.
   */
  private admitDelegation(state: JournalState, delegation: DelegationRequest, inFlight: DelegationRequest[]): Admission {
    const run = state.runs.find(item => item.runId === delegation.runId);
    const known = [...(run ? [run.delegation] : []), ...inFlight];
    if (known.some(item => digest(item) === digest(delegation))) return { kind: "duplicate" };
    if (!known.length) return { kind: "new" };
    if (run?.nativeDeliveries?.length) return { kind: "rejected", reason: "Unknown native delivery must be reconciled before changing this run's requirements" };
    const latest = known.reduce((current, item) => revisionOf(item) >= revisionOf(current) ? item : current);
    const rejected = (reason: string): Admission => ({ kind: "rejected", reason });
    // A run paused for a resumable blocker (often a needed clarification) still accepts the user's revised requirement.
    if (run && (run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status) && !resumablyPaused(run))) return rejected(`Run is ${run.cancelled ? "cancelled" : run.status}; requirement revisions are not accepted`);
    if (latest.sessionId !== delegation.sessionId || latest.correlationId !== delegation.correlationId) return rejected("Requirement change belongs to another correlation or session");
    if (delegation.metadata?.isRequirementChange !== true) return rejected("Run already belongs to another delegation; only a requirement change may revise it");
    const incoming = revisionOf(delegation), current = revisionOf(latest);
    if (incoming === current) return rejected(`Requirement revision ${incoming} is already admitted with different content`);
    if (incoming < current) return rejected(`Stale requirement revision ${incoming} (current ${current})`);
    // Tasks already in Core were planned against the old criteria; re-planning them safely is not supported, so the user starts over.
    if (run?.coreCreated) return rejected("Run already executing tasks; cancel it and start a new run");
    return { kind: "revision", revision: incoming };
  }
  /** Revisions of this run that Runtime still owes Conversation delivery for. Refused and cancelled ones do not count. */
  private inFlightDelegations(state: JournalState, runId: string | undefined): DelegationRequest[] {
    if (runId === undefined) return [];
    const refused = new Set(state.inbox.filter(item => item.status === "rejected").map(item => item.message.message_id));
    return state.outbound.filter(out => out.message.run_id === runId && isConversationHandoff(out.message) && out.status !== "cancelled" &&
      !refused.has(out.message.message_id)).map(out => DelegationRequestSchema.parse(out.message.payload));
  }
  /** One user-facing notice per refused handoff, with the cause and the ways forward. Idempotent by message id. */
  private notifyRejection(state: JournalState, outbox: HerdrOutbox, message: RoleMessage, reason: string): void {
    const id = `p19-${digest([message.run_id, "delegation-rejected", message.message_id])}`;
    if (state.outbound.some(out => out.message.message_id === id)) return;
    outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: message.correlation_id, causation_id: message.message_id,
      run_id: message.run_id, sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "conversation.progress",
      payload: { kind: "delegation_rejected", runId: message.run_id, reason, blockageReason: reason, headline: `Yêu cầu bị từ chối: ${reason}`,
        options: REJECTED_REVISION_OPTIONS }, artifact_references: [], occurred_at: this.now(), idempotency_key: id }));
  }
  /**
   * Admits a requirement revision: the run keeps its earlier delegation in history and plans again from the new criteria. The pending
   * design approval and pending user decisions are superseded; Conversation hears about them once, with their approval ids.
   */
  /**
   * An admitted user revision is the authorized answer to a resumable pause: settle the action like a resume (restore the phase,
   * record a resume receipt) so the Coordinator receives the revised delegation. Nothing uncertain is resent.
   */
  private resumeForRevision(run: RunRecord, messageId: string): void {
    if (!resumablyPaused(run)) return;
    const action = run.pendingAction!;
    run.status = action.previousStatus ?? "specifying";
    if (run.error === action.reason) delete run.error;
    action.state = "queued"; action.resumeAttempts = Math.min(AUTO_RESUME_LIMIT, (action.resumeAttempts ?? 0) + 1); action.lastResumedAt = this.now(); delete action.previousStatus;
    run.resumeReceipts = [...(run.resumeReceipts ?? []).filter(item => item.actionId !== action.actionId), { actionId: action.actionId, messageId }].slice(-50);
  }
  private admitRevision(state: JournalState, outbox: HerdrOutbox, run: RunRecord, delegation: DelegationRequest): void {
    const revision = revisionOf(delegation);
    const superseded: { approvalId: string; supersededByRevision: number }[] = [];
    if (run.approval) superseded.push({ approvalId: run.approval.approvalId, supersededByRevision: revision });
    // Work built from the old criteria that was never sent is withdrawn. Anything already sent stays: Runtime never recalls it.
    for (const out of state.outbound) if (out.status === "queued" && out.message.run_id === run.runId && out.message.type === "delegation.request" &&
        out.message.sender.role === "coordinator" && !["coordinator", "conversation"].includes(out.message.recipient.role)) {
      out.status = "cancelled"; out.error = `Superseded by requirement revision ${revision}`;
    }
    for (const entry of Object.values(run.userDecisions ?? {})) if (entry.status === "pending") {
      entry.status = "cancelled"; superseded.push({ approvalId: entry.request.approvalId, supersededByRevision: revision });
      // The asker is waiting for an answer that can no longer come; it is resumed with the outcome instead of waiting forever.
      this.resumeUserDecisionAsker(state, outbox, run, entry, { kind: "user_decision_answer", approvalId: entry.request.approvalId, outcome: "cancelled",
        reason: `Requirement revision ${revision} superseded this question` });
    }
    if (superseded.length) {
      run.supersededApprovals = [...(run.supersededApprovals ?? []), ...superseded];
      const approvalIds = superseded.map(item => item.approvalId);
      this.emit(state, outbox, run, "conversation.progress", { kind: "approval_superseded", runId: run.runId, approvalIds, supersededByRevision: revision,
        headline: `Phê duyệt đang chờ bị thay thế bởi revision ${revision}: ${approvalIds.join(", ")}` },
      `approval-superseded:${revision}`, "conversation");
    }
    run.delegationHistory = [...(run.delegationHistory ?? []), run.delegation];
    run.delegation = delegation;
    delete run.lastWorkflowRejection;
    delete run.definition; delete run.workflowSpec; delete run.baseRevision; delete run.approval; delete run.approvalKind;
    run.tasks = []; run.status = "intake"; delete run.error;
  }
  /** Validate current session ownership without depending on the pane generation that originally queued the intent. */
  private async cancellationTarget(state: JournalState, messageInput: unknown): Promise<{ run: RunRecord; request: CancellationRequest }> {
    const message = RoleMessageSchema.parse(messageInput), delegation = DelegationRequestSchema.parse(message.payload);
    if (!isCancellationHandoff(message) || delegation.requestedBy !== "conversation" || delegation.targetRole !== "coordinator" ||
        delegation.runId !== message.run_id || delegation.correlationId !== message.correlation_id || delegation.messageId !== message.message_id)
      throw new Error("Cancellation delegation envelope mismatch");
    const manifest = SessionManifestSchema.parse(unwrap(await this.ports.panes.getManifest()));
    const run = this.run(state, textField(delegation.metadata?.targetRunId));
    const request = CancellationRequestSchema.parse(delegation.metadata?.cancellationRequest);
    if (manifest.conversationSessionId !== delegation.sessionId || run.delegation.sessionId !== delegation.sessionId ||
        request.runId !== run.runId || delegation.runId !== run.runId || request.requestedBy !== "conversation") throw new Error("Foreign cancellation");
    return { run, request };
  }
  /**
   * Apply trusted local controls before work-delivery guards. Only safely queued intents are consumed locally;
   * sending/unknown deliveries retain their exact transport reconciliation. This is not a signed Herdr ingress receipt.
   */
  private async drainCancellationControls(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox): Promise<void> {
    // Older journals may already mark cancellation reconciled while still retaining unsent work or approvals.
    for (const run of state.runs.filter(item => item.cancelled)) {
      try { await this.closeCancelledRunDecisions(state, save, outbox, run); }
      catch (error) {
        const reason = `Cancellation lease cleanup requires reconciliation: ${redactString(String(error))}`;
        this.emit(state, outbox, run, "conversation.progress", { sdlcStatus: run.status,
          headline: "Cancellation requires reconciliation", reason, blockageReason: reason }, "cancel-lease-cleanup-failed", "conversation");
        await save();
      }
    }
    for (const out of state.outbound.filter(item => item.status === "queued" && !item.handle && isCancellationHandoff(item.message))) {
      let applying = false;
      try {
        const { run, request } = await this.cancellationTarget(state, out.message);
        applying = true;
        const failedControls = state.outbound.filter(item => item.message.run_id === run.runId && isCancellationHandoff(item.message) &&
          item.status === "failed" && item.error?.startsWith("Cancellation processing failed:"));
        await this.cancelRun(state, save, core, outbox, run, request.reason ?? "User requested cancellation");
        for (const previous of failedControls) previous.status = "delivered"; // same local cleanup finally applied; retain its original error for diagnostics
        if (failedControls.length) this.emit(state, outbox, run, "conversation.progress", { sdlcStatus: run.status,
          headline: "Cancellation cleanup retry completed", reason: "Local cancellation cleanup was retried safely. Existing stop and unknown-delivery blockers still require reconciliation." },
          `cancel-cleanup-recovered:${out.message.message_id}`, "conversation");
        if (out.lease) await outbox.release(out);
        out.status = "delivered"; delete out.error; delete out.nextAttemptAt;
      } catch (error) {
        // Fail one control explicitly; never let a failed local control fall through to a provider prompt.
        out.status = "failed"; out.error = `${applying ? "Cancellation processing failed" : "Cancellation rejected"}: ${redactString(String(error))}`;
        const run = state.runs.find(item => item.runId === out.message.run_id);
        if (run) this.emit(state, outbox, run, "conversation.progress", { sdlcStatus: run.status,
          headline: "Cancellation requires reconciliation", reason: out.error, blockageReason: out.error }, `cancel-failed:${out.message.message_id}`, "conversation");
      }
      await save();
    }
  }
  async flushOutbound(): Promise<void> {
    await this.initialize();
    if (this.quiesced) return;
    await this.transaction(async (state, save, core, outbox) => {
      await this.drainCancellationControls(state, save, core, outbox);
      await outbox.flush((out, handle) => this.bind(state, core, out, handle));
      this.surfaceOutboundFailures(state, outbox);
      this.surfaceCapabilityPreflightFailures(state, outbox);
      await save();
    });
    await this.deliverConversationInbox();
  }
  private conversationDelivery: Promise<void> | undefined;
  /**
   * Applies write-ahead Conversation inbox messages outside the journal lock, because the Gateway may drain a queued
   * user turn that enqueues back into Runtime. The Gateway deduplicates by message_id, so a failure is requeued and retried.
   */
  private deliverConversationInbox(): Promise<void> {
    this.conversationDelivery ??= (async () => {
      try {
        if (this.quiesced) return;
        const pending = await this.journal.exclusive(async state =>
          state.outbound.filter(out => isConversationDelivery(out) && out.status === "sending").map(out => out.message));
        for (const message of pending) {
          let error: string | undefined;
          try { await this.ports.deliverToConversation(message); } catch (failure) { error = redactString(String(failure)); }
          await this.journal.exclusive(async (state, save) => {
            const out = state.outbound.find(item => item.message.message_id === message.message_id);
            if (out?.status !== "sending") return;
            if (error === undefined) { out.status = "delivered"; delete out.error; delete out.deliveryAttempts; delete out.nextAttemptAt; }
            else {
              // Bounded: after the limit the write is terminal and the host reports it (failedConversationDeliveries).
              const attempts = (out.deliveryAttempts ?? 0) + 1;
              out.deliveryAttempts = attempts; out.error = error;
              if (attempts >= CONVERSATION_DELIVERY_MAX_ATTEMPTS) { out.status = "failed"; delete out.nextAttemptAt; }
              else { out.status = "queued"; out.nextAttemptAt = new Date(Date.parse(this.now()) + conversationRetryDelayMs(attempts)).toISOString(); }
            }
            await save();
          });
        }
      } finally { this.conversationDelivery = undefined; }
    })();
    return this.conversationDelivery;
  }
  /**
   * Read-only: Conversation inbox writes that exhausted their bounded retries. The host writes a notice receipt directly for each
   * (Conversation cannot be reached through the failing inbox) and dedupes by message_id.
   */
  async failedConversationDeliveries(): Promise<{ message: RoleMessage; error: string; attempts: number }[]> {
    return this.journal.exclusive(async state => state.outbound.filter(out => out.status === "failed" && isConversationDelivery(out))
      .map(out => ({ message: out.message, error: out.error ?? "Conversation delivery failed", attempts: out.deliveryAttempts ?? 0 })));
  }
  private readonly gateWaiters = new Map<string, { runId: string; accept(result: QualityGateResult): void; reject(error: Error): void }>();
  /** Reviewer/QA checks are delivered through Herdr; awaiting a reply never holds the Runtime journal lock. */
  herdrQualityGate(id: string): QualityGate {
    return { id, evaluate: async (rawContext, options) => {
      const context = QualityGateContextSchema.parse(rawContext);
      const configuration = record(context.definition.configuration);
      const role = textField(configuration.role);
      if (!["reviewer", "qa", "tester"].includes(role)) throw new Error("Herdr checks require an independent verification role");
      let key = `gate-${digest(context)}`;
      let finish!: (result: QualityGateResult) => void;
      let rejectReply!: (error: Error) => void;
      const reply = new Promise<QualityGateResult>((resolve, reject) => { finish = resolve; rejectReply = reject; });
      reply.catch(() => undefined);
      const abort = () => rejectReply(new Error("Verification operation aborted"));
      options?.signal?.addEventListener("abort", abort, { once: true });
      if (options?.signal?.aborted) abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await this.transaction(async (state, save, _core, outbox) => {
          const run = this.run(state, context.runId); this.live(run);
          // An already-applied verdict predates this evaluation and fails the verifier's execution-window check, so a retry asks
          // again under the next deterministic key. A request still awaiting its reply (same key, no verdict) is waited on, not resent.
          const settled = (messageId: string): boolean => {
            const prior = state.outbound.find(item => item.message.message_id === messageId);
            return state.inbox.some(item => item.status === "applied" && item.message.causation_id === messageId &&
              (item.message.type === "review.verdict" || prior?.handle && ["accepted", "released"].includes(prior.status) &&
                item.message.type === "task.status" && objectField(item.message.payload, "status") === "blocked" &&
                item.message.run_id === context.runId && item.message.correlation_id === run.delegation.correlationId &&
                item.message.sender.role === prior.message.recipient.role && item.message.sender.agent_id === prior.handle.target.agentId &&
                item.message.sender.pane_id === prior.handle.target.paneId));
          };
          for (let attempt = 1, traversed = 0; ; ) {
            if (++traversed > state.outbound.length + 1) throw new Error("Review invocation recovery chain is invalid");
            const replaced = state.outbound.find(item => item.message.message_id === key)?.reviewReplacement;
            if (replaced) { if (replaced.contextDigest !== digest(context)) throw new Error("Review replacement context changed"); key = replaced.replacementMessageId; continue; }
            if (!settled(key)) break;
            key = `gate-${digest([context, attempt++])}`;
          }
          this.gateWaiters.set(key, { runId: context.runId, accept: finish, reject: rejectReply });
          const unanswered = state.outbound.find(out => out.message.message_id === key);
          if (unanswered) {
            // Resume a known-delivered read-only request in its SAME native session. The original request/handle and
            // unknown business outcome remain untouched; this separately leased diagnostic grants no gate verdict.
            const receipt = run.resumeReceipts?.find(item => item.actionId === run.pendingAction?.actionId);
            const wake = receipt && state.outbound.find(item => item.message.message_id === receipt.messageId);
            const userTurn = wake && record(wake.message.payload).conversationUserMessageId;
            if (unanswered.status === "released" && unanswered.handle && configuration.kind === "review" &&
                run.pendingAction?.state === "queued" && typeof userTurn === "string" && record(wake!.message.payload).automatic === false &&
                !run.nativeDeliveries?.length && !state.outbound.some(item => item.message.run_id === run.runId && ["sending", "unknown_delivery"].includes(item.status)) &&
                (!run.approval || run.decision?.approvalId === run.approval.approvalId) &&
                !Object.values(run.userDecisions ?? {}).some(item => item.status === "pending")) {
              const binding = unwrap(await this.ports.panes.getRoleBinding(role));
              const target = unanswered.handle.target;
              if (binding && binding.session && binding.paneId === target.paneId && binding.agentId === target.agentId &&
                  binding.workspaceId === target.workspaceId && binding.tabId === target.tabId && digest(binding.session) === digest(target.session)) {
                const noticeId = `review-resume-${digest([key, userTurn])}`;
                if (!state.outbound.some(item => item.message.message_id === noticeId)) {
                  outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: noticeId, correlation_id: run.delegation.correlationId,
                    causation_id: key, run_id: run.runId, sender: { role: "runtime" }, recipient: { role, agent_id: target.agentId, pane_id: target.paneId }, type: "task.status",
                    payload: { kind: "resume_verification_request", sourceMessageId: key, conversationUserMessageId: userTurn,
                      next: `Continue your existing read-only verification request ${key}. Call inspect_review with that original messageId, then complete_review. Preserve its exact revision/specification. This diagnostic is not a new assignment, approval or success claim. Report a correlated blocked task.status if unable to continue.` },
                    artifact_references: [], occurred_at: this.now(), idempotency_key: noticeId }), role, undefined, undefined, unanswered.capabilities);
                  await save();
                }
              }
            }
            return;
          }
          const recoverySource = state.outbound.find(item => item.reviewReplacement?.replacementMessageId === key);
          if (recoverySource) {
            const current = unwrap(await this.ports.panes.getRoleBinding(role)), old = recoverySource.handle!.target;
            if (!current?.session || current.paneId === old.paneId || digest(current.session) === digest(old.session))
              throw new Error("Authorized review replacement requires a distinct verified native session");
          }
          outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: key, correlation_id: run.delegation.correlationId,
            run_id: run.runId, ...(recoverySource ? { causation_id: recoverySource.message.message_id } : {}), sender: { role: "coordinator" }, recipient: { role }, type: "verification.requested",
            payload: context, artifact_references: context.artifacts, occurred_at: this.now(), idempotency_key: key }), role,
            `check-${digest([context.taskId, context.definition.id, context.attemptId])}`, context.attemptId!, role === "reviewer" ? ["review"] : role === "tester" ? ["testing"] : ["verification"]);
          await save();
        });
        await this.flushOutbound();
        const outcome = await Promise.race([reply, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Herdr verification reply timeout; delivery remains reconcilable")), context.definition.timeout.executionTimeoutMs);
        })]);
        return { ok: true, value: outcome };
      } finally { if (timer) clearTimeout(timer); options?.signal?.removeEventListener("abort", abort); this.gateWaiters.delete(key); }
    } };
  }
  async inspect(runId?: string): Promise<JsonValue> {
    return this.journal.exclusive(async state => json(runId ? this.run(state, runId) : {
      runs: state.runs, outbound: state.outbound, inbox: state.inbox
    }));
  }
  /** Read-only receipt view: no Core restore, coroutine recovery or semantic writes as part of diagnostics. */
  async nativeDeliveryInbox(): Promise<JournalState["inbox"]> {
    return this.journal.exclusive(async state => structuredClone(state.inbox));
  }
  /**
   * Read-only: approvals this session's runs are still waiting on (design/task approval and specialist user decisions).
   * Conversation reconciles against it; it never mutates state and is not approval evidence by itself.
   */
  async pendingApprovals(query: { sessionId: string; runId?: string }): Promise<{ request: ApprovalRequest; correlationId: string }[]> {
    return this.transaction(async state => {
      const pending: { request: ApprovalRequest; correlationId: string }[] = [];
      for (const run of state.runs) {
        if (run.delegation.sessionId !== query.sessionId || (query.runId !== undefined && run.runId !== query.runId)) continue;
        if (run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status)) continue;
        if (run.approval && run.status === "awaiting_approval" && (!run.decision || run.decision.approvalId !== run.approval.approvalId))
          pending.push({ request: ApprovalRequestSchema.parse(run.approval), correlationId: run.delegation.correlationId });
        for (const entry of Object.values(run.userDecisions ?? {}))
          if (entry.status === "pending") pending.push({ request: ApprovalRequestSchema.parse(entry.request), correlationId: run.delegation.correlationId });
      }
      return pending;
    });
  }
  /** Facts the host watchdog needs about one run. Derived from durable state only; activity ignores Conversation-bound notices. */
  private runFacts(state: JournalState, run: RunRecord): RunFacts & { pendingDecisionRequests: { request: ApprovalRequest; correlationId: string }[] } {
    const now = Date.parse(this.now());
    const handoffs = state.outbound.filter(out => out.message.run_id === run.runId && out.message.recipient.role !== "conversation");
    const messages = [...state.outbound.map(out => out.message), ...state.inbox.map(item => item.message)]
      .filter(message => message.run_id === run.runId && message.recipient.role !== "conversation");
    const times = [Date.parse(run.delegation.requestedAt), ...messages.map(message => Date.parse(message.occurred_at ?? ""))].filter(Number.isFinite);
    const pendingDecisionRequests = Object.values(run.userDecisions ?? {}).filter(entry => entry.status === "pending")
      .map(entry => ({ request: ApprovalRequestSchema.parse(entry.request), correlationId: run.delegation.correlationId }));
    const holders = handoffs.filter(out => this.outboundOwesResult(state, run, out) ||
      out.message.recipient.role === "coordinator" && out.status === "accepted" && out.handle !== undefined);
    return {
      runId: run.runId, status: run.status, live: !(run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status)),
      lastActivityAt: Math.max(...times), awaitingHuman: run.status === "awaiting_approval" || run.status === "clarifying" && state.outbound.some(out =>
        out.message.run_id === run.runId && out.message.type === "conversation.clarification" && ["queued", "sending", "delivered"].includes(out.status)),
      // Accepted handoffs are not activity by themselves (their pane must be observed working); a queued one stuck on a
      // not-ready or structurally blocked recipient is reported by its own notice, not treated as work in progress.
      activeHandoff: (run.nativeDeliveries?.length ?? 0) > 0 || handoffs.some(out => ["sending", "unknown_delivery"].includes(out.status) ||
        out.status === "queued" && !(out.notReadySince !== undefined && now - Date.parse(out.notReadySince) >= NOT_READY_FAILURE_MS) &&
          !(out.error !== undefined && STRUCTURAL_DELIVERY_BLOCKERS.test(out.error))),
      acceptedRoles: [...new Set(holders.map(out => out.message.recipient.role))],
      acceptedPanes: [...new Map(holders.filter(out => typeof out.handle?.target.paneId === "string").map(out => [
        `${out.message.recipient.role}:${out.handle!.target.paneId}`, { role: out.message.recipient.role, paneId: out.handle!.target.paneId! }])).values()],
      // Deterministic checks/test suites may legitimately run longer than the stall window without any message.
      runtimeWork: run.tasks.some(task => task.verificationPending) || run.workflowVerificationPending === true ||
        state.pendingVerifications.some(item => pendingRunId(item) === run.runId && !item.stuck),
      pendingDecisions: pendingDecisionRequests.map(item => ({ approvalId: item.request.approvalId, requestedAt: item.request.requestedAt })),
      pendingDecisionRequests
    };
  }
  /**
   * Read-only snapshot for the host watchdog. It never decides anything; the watchdog reads it outside the journal lock and
   * then calls the report methods below one at a time.
   */
  async watchdogSnapshot(sessionId: string): Promise<(RunFacts & { pendingDecisionRequests: { request: ApprovalRequest; correlationId: string }[] })[]> {
    return this.transaction(async state => state.runs.filter(run => run.delegation.sessionId === sessionId).map(run => this.runFacts(state, run)));
  }
  /** Cache a typed refusal while the Coordinator can still correct its proposal in the same turn. */
  private recordProposalRejection(state: JournalState, outbox: HerdrOutbox, run: RunRecord, input: WorkflowRejection): boolean {
    if (run.cancelled || run.supersededBy || TERMINAL_RUN_STATUSES.includes(run.status) || run.definition || run.coreCreated ||
        run.nativeDeliveries?.length || state.outbound.some(out => out.message.run_id === run.runId &&
          !isConversationDelivery(out) && ["sending", "unknown_delivery"].includes(out.status)) ||
        Object.values(run.userDecisions ?? {}).some(item => item.status === "pending") ||
        run.approval && (!run.decision || run.decision.approvalId !== run.approval.approvalId)) return false;
    const rejection: WorkflowRejection = {
      code: WorkflowRejectionCodeSchema.parse(input.code), reason: redactString(textField(input.reason)).slice(0, 2000),
      options: strings(input.options).slice(0, 100).map(value => redactString(value).slice(0, 2000)),
      ...(input.methods === undefined ? {} : { methods: strings(input.methods).slice(0, 100).map(value => redactString(value).slice(0, 2000)) }),
      ...(input.criteria === undefined ? {} : { criteria: strings(input.criteria).slice(0, 100).map(value => redactString(value).slice(0, 2000)) })
    };
    const prior = run.lastWorkflowRejection;
    if (run.status === "escalated" && run.pendingAction?.actionId !== prior?.actionId) return false;
    const resumed = prior !== undefined && run.resumeReceipts?.some(receipt => receipt.actionId === prior.actionId);
    const fingerprint = digest([rejection.code, rejection.reason, rejection.options, rejection.methods ?? [], rejection.criteria ?? []]);
    if (prior && !resumed && prior.rejectionFingerprint === fingerprint) return false;
    const episodeNumber = prior ? prior.episodeNumber + (resumed ? 1 : 0) : 1;
    const sourceMessageId = `rejection-r${revisionOf(run.delegation)}-ep${episodeNumber}-${digest([run.runId, revisionOf(run.delegation), episodeNumber])}`;
    const actionId = `next-${digest([run.runId, sourceMessageId])}`;
    const previousStatus = run.status === "escalated" ? run.pendingAction?.previousStatus ?? prior?.previousStatus ?? "planning" : run.status;
    run.lastWorkflowRejection = {
      ...rejection, episodeNumber, sourceMessageId, actionId, rejectedAt: this.now(),
      rejectionFingerprint: fingerprint, previousStatus
    };
    if (reportsToUser(rejection)) this.emit(state, outbox, run, "conversation.progress", {
      kind: "workflow_rejected", runId: run.runId, ...rejection,
      headline: `Workflow bị từ chối: ${rejection.reason}`, actionId
    }, `workflow-rejected:${actionId}:${fingerprint}`, "conversation");
    return true;
  }
  /** A rejected proposal is not an admitted workflow; STOP turns its proof into a durable manual blocker. */
  async recordWorkflowRejected(runId: string, rejection: WorkflowRejection): Promise<void> {
    await this.transaction(async (state, save, _core, outbox) => {
      const run = state.runs.find(item => item.runId === runId);
      if (run && this.recordProposalRejection(state, outbox, run, rejection)) await save();
    });
  }
  async reportWorkflowRejected(runId: string, rejection: WorkflowRejection): Promise<void> {
    return this.recordWorkflowRejected(runId, rejection);
  }
  /** A user-decision notice stayed undisplayed through its resends. Idempotent per approval. */
  async reportWorkflowBlocked(runId: string, approvalId: string, resends: number): Promise<void> {
    await this.transaction(async (state, save, _core, outbox) => {
      const run = state.runs.find(item => item.runId === runId);
      if (!run || run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status)) return;
      const reason = `Conversation chưa hiển thị câu hỏi ${approvalId} sau ${resends} lần gửi lại`;
      this.emit(state, outbox, run, "conversation.progress", { kind: "workflow_blocked", runId, approvalId, reason,
        options: ["Yêu cầu Conversation hiển thị lại câu hỏi đang chờ", "Hủy run này"], headline: `Workflow bị chặn: ${reason}` },
      `workflow-blocked:${approvalId}`, "conversation");
      await save();
    });
  }
  /**
   * A live run has no pending decision, handoff or human gate, and its role panes are not working, with no activity since idleSince.
   * Herdr idle/done only means "not working" here, never task success. Once per episode (episodeKey changes with activity).
   * A holder (an accepted assignment still owing its result) is first reminded once through Herdr; a holder still silent in a
   * later episode, or a stall without any holder, becomes a bounded `auto_resume` Coordinator action.
   */
  async reportRunStalled(runId: string, episodeKey: string): Promise<void> {
    await this.transaction(async (state, save, _core, outbox) => {
      const run = state.runs.find(item => item.runId === runId);
      if (!run) return;
      const facts = this.runFacts(state, run);
      if (!facts.live || facts.awaitingHuman || facts.activeHandoff || facts.runtimeWork || facts.pendingDecisions.length) return;
      const idleSince = new Date(facts.lastActivityAt).toISOString();
      // The holder is the role whose accepted handoff is still open while its pane is not working: it stopped without reporting.
      // Same holders as RunFacts: only obligations still owing a correlated result (an answered assignment is not a holder).
      const holders = state.outbound.filter(out => out.message.run_id === run.runId && out.message.recipient.role !== "conversation" &&
        (this.outboundOwesResult(state, run, out) || out.message.recipient.role === "coordinator" && out.status === "accepted" && out.handle !== undefined));
      const holder = holders.find(out => out.message.recipient.role === "developer") ??
        holders.find(out => out.message.recipient.role !== "coordinator") ?? holders[0];
      // First stall of a holder: remind that exact holder once through Herdr to send its result or report blocked. The reminder
      // is new activity, so the next stall episode starts after it; a holder still silent then is handed to the Coordinator.
      if (holder?.handle && !this.holderReminded(state, run, holder) && this.remindHolder(outbox, run, holder, idleSince)) {
        await save(); return;
      }
      const previousStatus = run.status;
      const sourceMessageId = holder?.message.message_id ?? run.delegation.messageId;
      const obligation = holder ? `${holder.message.recipient.role} pane ${holder.handle!.target.paneId} owes a correlated result for ${holder.message.type} ` +
        `task ${holder.taskId}, attempt ${holder.attemptId}; transport accepted at ${holder.handle!.acceptedAt}, delivery state ${holder.status}; ` +
        `run activity idle since ${idleSince}` : undefined;
      const reasonForAction = holder
        ? `${obligation}, but no correlated result has been applied.`
        : `No run-local work, wait, or next action was recorded after ${idleSince}.`;
      const inherited = inheritedAutoResume(run);
      run.error = reasonForAction.slice(0, 2000);
      run.status = "escalated";
      // Automatic and bounded (B0): the Coordinator is woken to reassign or report the blocker; the user decides only once
      // the automatic budget is spent.
      run.pendingAction = { actionId: `next-${digest([run.runId, sourceMessageId])}`, kind: "resume_coordinator", owner: "coordinator",
        reason: run.error, sourceMessageId, createdAt: this.now(), state: "pending", previousStatus, ...inherited, recovery: "auto_resume" };
      const automatic = (run.pendingAction.resumeAttempts ?? 0) < AUTO_RESUME_LIMIT ? { automaticResume: automaticResumeNotice(run.pendingAction) } : {};
      if (holder?.handle) {
        const role = holder.message.recipient.role;
        const kind = role === "developer" ? "developer_no_response" : role === "coordinator" ? "coordinator_no_response" : "run_stalled";
        const reason = `${obligation}, but is not working and has no applied result, even after a reminder. Herdr idle/done only means not working, never task success. ` +
          "Inspect original delivery and result receipts before considering another attempt.";
        this.emit(state, outbox, run, "conversation.progress", { kind, runId, reason, idleSince, role, paneId: holder.handle.target.paneId,
          taskId: holder.taskId, attemptId: holder.attemptId, acceptedAt: holder.handle.acceptedAt, deliveryStatus: holder.status,
          owner: "coordinator", actionId: run.pendingAction.actionId, ...automatic,
          options: ["Ask Coordinator to inspect original delivery/result receipts and report a safe recovery action", "Cancel this run"],
          headline: `Run may be stuck: ${role} stopped without a result (${runId})` },
        `run-stalled:${episodeKey}`, "conversation");
        await save(); return;
      }
      const reason = `Không có tiến triển từ ${idleSince} và các pane vai trò không ở trạng thái đang làm việc. ` +
        "Trạng thái idle/done của Herdr không chứng minh công việc đã thành công.";
      this.emit(state, outbox, run, "conversation.progress", { kind: "run_stalled", runId, reason, idleSince, owner: "coordinator", actionId: run.pendingAction.actionId,
        ...automatic, options: ["Yêu cầu Coordinator tiếp tục hoặc giải thích trạng thái", "Hủy run"], headline: `Run có thể bị treo: ${runId}` },
      `run-stalled:${episodeKey}`, "conversation");
      await save();
    });
  }
  private holderReminderId(run: RunRecord, holder: Outbound): string { return `stall-reminder-${digest([run.runId, holder.message.message_id])}`; }
  /** One reminder per held assignment; a reminder is never itself reminded. */
  private holderReminded(state: JournalState, run: RunRecord, holder: Outbound): boolean {
    if (objectField(holder.message.payload, "kind") === "result_reminder") return true;
    const id = this.holderReminderId(run, holder);
    return state.outbound.some(out => out.message.message_id === id);
  }
  /**
   * Queues the idempotent Herdr reminder to the exact holder: send the correlated result or report blocked. A Developer whose
   * assignment still holds its writer lease is reached by a task notice under that lease. It asks for a result; it never is one.
   * Returns false when the holder cannot be reached this way (the caller then hands the run to the Coordinator).
   */
  private remindHolder(outbox: HerdrOutbox, run: RunRecord, holder: Outbound, idleSince: string): boolean {
    const id = this.holderReminderId(run, holder), role = holder.message.recipient.role, target = holder.handle!.target;
    const payload = json({ kind: "result_reminder", runId: run.runId, taskId: holder.taskId, sourceMessageId: holder.message.message_id,
      messageType: holder.message.type, idleSince,
      next: `Runtime has no result for ${holder.message.type} ${holder.message.message_id} (task ${holder.taskId}) since ${idleSince}. ` +
        `Send your structured result now with send_role_message (causation_id ${holder.message.message_id}), or report task.status with ` +
        "payload.status \"blocked\" and the reason. An idle or finished turn is not a result." });
    const base = { schema_version: 2 as const, message_id: id, correlation_id: run.delegation.correlationId, causation_id: holder.message.message_id,
      run_id: run.runId, type: "task.status" as const, payload, artifact_references: [], occurred_at: this.now(), idempotency_key: id };
    try {
      if (holder.message.type === "task.assignment" && holder.status === "accepted") {
        if (role !== "developer") return false;
        outbox.enqueueTaskNotice(RoleMessageSchema.parse({ ...base, sender: { role: "coordinator" },
          recipient: { role: "developer", agent_id: target.agentId, pane_id: target.paneId } }), holder);
      } else outbox.enqueue(RoleMessageSchema.parse({ ...base, sender: { role: "runtime" },
        recipient: { role, agent_id: target.agentId, ...(target.paneId ? { pane_id: target.paneId } : {}) } }), role);
      return true;
    } catch { return false; }
  }
  async loadSpecification(specId: string): Promise<Specification> {
    return this.transaction(async state => {
      // A follow-up run reuses its parent's specification ids; the superseded parent's dossier is never the current one.
      for (const run of [...state.runs.filter(item => !item.supersededBy), ...state.runs.filter(item => item.supersededBy)])
        for (const spec of [run.workflowSpec, ...run.tasks.map(task => task.spec)])
        if (spec?.specification.specId === specId) return SpecificationSchema.parse(spec.specification);
      throw new Error("Specification unavailable");
    });
  }

  /** Called only for envelopes received through the Herdr host integration. */
  async receiveHerdr(input: unknown): Promise<JsonValue> {
    const message = RoleMessageSchema.parse(input);
    if (!await this.ports.authenticateMessage(message)) throw new Error("Unauthenticated Herdr envelope");
    if (message.idempotency_key === undefined) return this.refuseInbound(message, "lacks idempotency_key");
    if (!["coordinator", "runtime"].includes(message.recipient.role)) return this.refuseInbound(message, `was addressed to ${message.recipient.role}`);
    return this.applyAuthenticatedHerdrMessage(message, false);
  }
  /**
   * An authenticated envelope refused by its own content (no idempotency_key, wrong recipient). Retrying the same envelope cannot
   * succeed, so it is journaled as rejected once. An agent sender gets the exact refusal back through Herdr to resend a valid
   * message; after INVALID_ROLE_MESSAGE_LIMIT refusals for one assignment (or for a non-agent sender) the run is escalated to the
   * Coordinator and the user hears the exact refusal.
   */
  private async refuseInbound(message: RoleMessage, detail: string): Promise<never> {
    const headline = `Handoff refused: ${message.type} from ${message.sender.role} ${detail}`;
    const reason = `${headline}. No retry of the same envelope can succeed; the sender must resend a schema-valid message.`;
    return this.transaction(async (state, save, _core, outbox) => {
      const old = state.inbox.find(item => item.message.message_id === message.message_id);
      if (old?.status === "rejected") throw new AdmissionRejectedError(old.reason ?? reason);
      if (old) throw new AdmissionRejectedError(reason);
      state.inbox.push({ message, status: "rejected", reason });
      const run = state.runs.find(item => item.runId === message.run_id);
      if (run && !run.cancelled && !TERMINAL_RUN_STATUSES.includes(run.status)) {
        const agentSender = !["conversation", "runtime", "user"].includes(message.sender.role);
        const sourceId = invalidMessageSource(message);
        // An agent's refused message goes back to that agent to fix and resend; only the INVALID_ROLE_MESSAGE_LIMIT-th refusal for
        // one assignment involves the Coordinator, automatically and bounded. The rejected inbox entry dedupes redeliveries.
        const attempt = agentSender ? this.countInvalidMessage(run, message.sender.role, sourceId, message.message_id) : INVALID_ROLE_MESSAGE_LIMIT;
        if (agentSender && attempt < INVALID_ROLE_MESSAGE_LIMIT) {
          this.returnValidationError(state, outbox, run, message, `${message.sender.role}:${sourceId}`, attempt, `${message.type} ${detail}`);
          await save();
          throw new AdmissionRejectedError(reason);
        }
        if (run.status !== "awaiting_approval" && !Object.values(run.userDecisions ?? {}).some(item => item.status === "pending")) {
          if (agentSender) this.escalateInvalidMessages(run, message.message_id, `${reason} (${attempt} refused messages for ${sourceId})`);
          else {
            const previousStatus = run.status;
            run.error = reason; run.status = "escalated";
            run.pendingAction = { actionId: `next-${digest([run.runId, message.message_id])}`, kind: "resume_coordinator", owner: "coordinator",
              reason, sourceMessageId: message.message_id, createdAt: this.now(), state: "pending", previousStatus, recovery: "manual", resumeAttempts: 0 };
          }
        }
        this.emit(state, outbox, run, "conversation.progress", { kind: "workflow_blocked", runId: run.runId, sdlcStatus: run.status, owner: "coordinator",
          ...(run.pendingAction === undefined ? {} : { actionId: run.pendingAction.actionId }), headline, reason, blockageReason: reason,
          options: [`Ask Coordinator to have ${message.sender.role} resend a schema-valid message`, "Cancel run"] },
          `invalid-inbound:${digest([run.runId, message.message_id])}`, "conversation");
      }
      await save();
      throw new AdmissionRejectedError(reason);
    });
  }
  /** Replays only the exact journaled received envelope whose authentication succeeded before its durable write-ahead. */
  private async applyAuthenticatedHerdrMessage(message: RoleMessage, requireReceivedReceipt: boolean): Promise<JsonValue> {
    return this.transaction(async (state, save, core, outbox) => {
      if (!["coordinator", "runtime"].includes(message.recipient.role)) throw new Error("Wrong inbound recipient");
      const old = state.inbox.find(item => item.message.message_id === message.message_id || (message.idempotency_key !== undefined && item.message.idempotency_key === message.idempotency_key));
      if (old && digest(old.message) !== digest(message)) throw new Error("Conflicting inbound idempotency key");
      this.assertNativeMessageConsistent(state, message);
      if (requireReceivedReceipt && (!old || old.status !== "received")) throw new Error("Trusted ingress replay requires the exact durable received receipt");
      if (old?.status === "applied") return json({ duplicate: true });
      // A refused message stays refused: a redelivery is answered with the same reason, never re-admitted against newer state.
      if (old?.status === "rejected") throw new AdmissionRejectedError(old.reason ?? "Inbound message was refused");
      const inbox: JournalState["inbox"][number] = old ?? { message, status: "received" };
      if (!old) { state.inbox.push(inbox); await save(); }
      if (message.type === "conversation.intake" || message.type === "conversation.clarification") {
        // Dialogue-only traffic has no DelegationRequest and must never create a workflow.
        inbox.status = "applied"; await save(); return json({ workflowCreated: false });
      }
      if (message.type === "delegation.request") {
        const delegation = DelegationRequestSchema.parse(message.payload);
        if (message.sender.role !== "conversation" || delegation.requestedBy !== "conversation" || delegation.targetRole !== "coordinator" ||
            delegation.runId !== message.run_id || delegation.correlationId !== message.correlation_id || delegation.messageId !== message.message_id)
          throw new Error("Delegation envelope mismatch");
        const manifest = SessionManifestSchema.parse(unwrap(await this.ports.panes.getManifest()));
        if (manifest.conversationSessionId !== delegation.sessionId) throw new Error("Cross-session delegation");
        if (delegation.metadata?.action === "cancel") {
          const { run: target, request: cancellation } = await this.cancellationTarget(state, message);
          try { await this.cancelRun(state, save, core, outbox, target, cancellation.reason ?? "User requested cancellation"); }
          catch (error) {
            // Preserve the authenticated received receipt and the partial cleanup failure across restart.
            inbox.reason = `Cancellation processing failed: ${redactString(String(error))}`;
            await save(); throw error;
          }
          inbox.status = "applied"; delete inbox.reason; await save(); return json({ cancellationRequested: true });
        }
        const admission = this.admitDelegation(state, delegation, []);
        if (admission.kind === "rejected") {
          inbox.status = "rejected"; inbox.reason = admission.reason;
          this.notifyRejection(state, outbox, message, admission.reason); await save();
          throw new AdmissionRejectedError(admission.reason);
        }
        let run = state.runs.find(item => item.runId === message.run_id);
        if (admission.kind === "revision") { this.resumeForRevision(run!, message.message_id); this.admitRevision(state, outbox, run!, delegation); }
        if (!run) {
          run = { runId: delegation.runId!, delegation, status: "intake", tasks: [], coreCreated: false,
            cancelled: false, maxIterations: 3 };
          state.runs.push(run);
        }
        // Revision 1 keeps the historical message key, so journals written before requirement changes are unaffected.
        const revision = revisionOf(delegation);
        this.emit(state, outbox, run, "delegation.accepted", { delegationId: delegation.delegationId, revision,
          sdlcStatus: "intake", headline: "Coordinator accepted the objective" }, revision > 1 ? `accepted:r${revision}` : "accepted");
      } else {
        const run = this.run(state, message.run_id!);
        if (message.correlation_id !== run.delegation.correlationId) throw new Error("Wrong run correlation");
        if (isConversationContext(message)) {
          if (run.cancelled || ["completed", "failed", "cancelled"].includes(run.status)) throw new Error(`Run is ${run.status}; informational context cannot reopen it`);
          this.wakeCoordinator(state, outbox, run, message);
          inbox.status = "applied"; await save(); return json({ accepted: true, informational: true });
        }
        const replacedReview = state.outbound.find(out => out.message.message_id === message.causation_id && out.reviewReplacement);
        if (replacedReview) {
          inbox.status = "rejected"; inbox.reason = "Result belongs to a replaced workflow review; original outcome remains unclaimed"; await save();
          throw new AdmissionRejectedError(inbox.reason);
        }
        // Signature-verified reception is durable before semantic work. An exact bound execution outcome can
        // acknowledge delivery while a different business action pauses the run; validators apply only after resume.
        if (this.defersPausedNativeOutcome(state, run, message)) {
          this.settleNativeDeliveries(state);
          await save(); return json({ received: true, deferred: true });
        }
        // A known native result may arrive after a schema failure paused its run. Admit only the exact immutable
        // intent and bound specialist reply; keep the pause and human gates. This breaks the ACK/resume deadlock
        // without authorizing new work, task success, or arbitrary late messages during an escalation.
        if (!this.acceptsPausedNativeReply(state, run, message)) this.live(run);
        if (message.type === "approval.decision") {
          if (message.sender.role !== "conversation") throw new Error("Approval must return via Conversation");
          const decision = ApprovalDecisionSchema.parse(message.payload);
          const reason = supersededReason(run, decision.approvalId);
          if (reason !== undefined) { inbox.status = "rejected"; inbox.reason = reason; await save(); throw new AdmissionRejectedError(reason); }
          if (run.userDecisions?.[decision.approvalId] !== undefined) await this.answerUserDecision(state, save, outbox, run, decision);
          else await this.applyDecision(state, save, core, outbox, run, decision);
        } else if (message.type === "execution.receipt") {
          const receipt = AgentBindingReceiptSchema.parse(message.payload);
          const out = state.outbound.find(item => item.message.message_id === message.causation_id);
          if (!out?.handle || out.message.type !== "task.assignment" || out.status !== "accepted" ||
              message.sender.agent_id !== out.handle.target.agentId || message.sender.pane_id !== out.handle.target.paneId ||
              message.sender.role !== out.message.recipient.role || canonicalReceiptJson(out.handle) !== canonicalReceiptJson(receipt.handle))
            throw new Error("Receipt is not correlated to the current Herdr assignment");
          const engine = this.ports.engine;
          if (!hasAuthenticatedBindings(engine)) throw new Error("Core does not support authenticated binding receipts");
          await outbox.renew(out);
          const bytes = Buffer.from(canonicalReceiptJson(receipt));
          const { createHash } = await import("node:crypto");
          const checksum = createHash("sha256").update(bytes).digest("hex");
          const evidence = ArtifactReferenceSchema.parse(unwrap(await this.ports.artifactStore.put({ options: {
            artifactId: `binding-receipt-${checksum}`, runId: receipt.handle.runId, taskId: receipt.handle.taskId,
            kind: "report", mediaType: "application/json", expectedIntegrity: { checksum: { algorithm: "sha256", value: checksum }, sizeBytes: bytes.length },
            idempotencyKey: `binding-receipt:${checksum}`
          }, content: (async function* () { yield bytes; })() })));
          const previous = (await core.snapshot(run.runId)).tasks.find(task => task.taskId === receipt.handle.taskId)?.bindingVerification;
          if (previous && canonicalReceiptJson(previous.receipt) !== canonicalReceiptJson(receipt)) throw new Error("Execution already has another binding proof");
          if (!previous) await core.mutate(run.runId, snapshot => engine.verifyAgentBinding({ runId: run.runId, taskId: receipt.handle.taskId,
            expectedVersion: snapshot.version, verification: { receipt, evidence, verifiedAt: message.occurred_at ?? receipt.observedAt },
            occurredAt: message.occurred_at ?? receipt.observedAt, idempotencyKey: `verify-binding:${receipt.receiptId}` }));
        } else if (message.type === "implementation.submitted") {
          if (!this.resolverReport(state, outbox, run, message)) await this.submit(state, save, core, outbox, run, message);
        } else if (message.type === "verification.result") {
          if (state.outbound.some(item => item.message.message_id === message.causation_id && item.phaseRetirement)) throw new Error("Retired policy phase rejects late evidence");
          const result = VerificationResultSchema.parse(message.payload);
          if (!["tester", "qa"].includes(message.sender.role) || result.runId !== run.runId || result.verificationScope === "workflow")
            throw new Error("Invalid conditional TDD evidence sender/scope");
          const task = run.tasks.find(item => item.taskId === result.taskId);
          if (!task) throw new Error("Evidence task missing");
          const request = state.outbound.find(item => item.message.message_id === message.causation_id &&
            item.message.type === "verification.requested" && record(item.message.payload).kind === "conditional_evidence");
          if (request) {
            if (!request.handle || request.handle.target.agentId !== message.sender.agent_id ||
                request.handle.target.paneId !== message.sender.pane_id || request.message.recipient.role !== message.sender.role ||
                record(request.message.payload).taskId !== result.taskId ||
                record(request.message.payload).phase !== undefined && record(request.message.payload).phase !== record(result.metadata?.conditionalTdd).phase)
              throw new Error("Policy evidence is not correlated to its assigned verifier");
            if (request.status === "accepted") await outbox.renew(request);
            else if (request.status !== "released") throw new Error("Policy evidence delivery is unresolved");
          }
          if (!await this.ports.authenticateEvidence(result, message)) throw new Error("Untrusted independent TDD evidence");
          await this.verifyReferences(result.evidenceArtifacts, run.runId);
          task.spec.strategy = TestStrategySchema.parse(this.ports.policies.recordEvidence(task.spec.strategy, result));
          if (request?.status === "accepted") await outbox.release(request);
          if (request && typeof record(request.message.payload).phase === "string")
            this.phaseNotice(state, outbox, run, task, textField(record(request.message.payload).phase), "passed",
              "Independent policy phase recorded. Continue the accepted TDD sequence; do not modify frozen Red tests.", result.verificationId);
        } else if (message.type === "review.verdict") {
          const result = QualityGateResultSchema.parse(message.payload);
          const outbound = state.outbound.find(out => out.message.message_id === message.causation_id);
          if (!outbound?.handle || outbound.message.type !== "verification.requested" ||
              message.sender.agent_id !== outbound.handle.target.agentId || message.sender.pane_id !== outbound.handle.target.paneId ||
              message.sender.role !== outbound.message.recipient.role || result.runId !== run.runId ||
              result.taskId !== record(outbound.message.payload).taskId || result.gateId !== record(record(outbound.message.payload).definition).id ||
              !await this.ports.authenticateGateResult(result, message))
            throw new Error("Untrusted verification gate reply");
          await outbox.release(outbound);
          inbox.status = "applied"; await save();
          this.gateWaiters.get(message.causation_id!)?.accept(result);
        } else if (message.type === "task.status" && record(message.payload).action === "cancel") {
          if (message.sender.role !== "conversation") throw new Error("Cancellation must return via Conversation");
          await this.cancelRun(state, save, core, outbox, run, textField(record(message.payload).reason));
        } else if (!["spec.draft", "task.status", "review.verdict", "verification.escalation"].includes(message.type)) {
          throw new Error(`Unsupported inbound message ${message.type}`);
        } else if (message.type === "task.status" && message.sender.role === "developer" && this.resolverReport(state, outbox, run, message)) {
          // Handled: a resolver report ends its own attempt; Runtime assigns the next resolver or escalates on the next tick.
        } else {
          const blockage = message.sender.role !== "coordinator" ? specialistBlockage(message.payload) : undefined;
          if (blockage !== undefined) this.reportSpecialistBlocked(state, outbox, run, message, blockage);
          if (message.recipient.role === "coordinator") this.wakeCoordinator(state, outbox, run, message);
        }
      }
      inbox.status = "applied"; await save();
      return json({ accepted: true });
    });
  }

  /** A specialist blocker is visible to the user, not only to the Coordinator. Idempotent per message. */
  private reportSpecialistBlocked(state: JournalState, outbox: HerdrOutbox, run: RunRecord, message: RoleMessage, blockage: string): void {
    // The authenticated report remains in the inbox; the active Runtime verifier owns its outcome and resume budget.
    if (run.workflowVerificationPending || run.tasks.some(task => task.verificationPending)) return;
    if (state.inbox.some(item => item.status === "applied" && item.message.type === "review.verdict" &&
        item.message.run_id === run.runId && item.message.causation_id === message.causation_id &&
        item.message.sender.role === message.sender.role && item.message.sender.agent_id === message.sender.agent_id && item.message.sender.pane_id === message.sender.pane_id))
      return; // A late delivery diagnostic cannot replace the authenticated gate outcome or its resume lineage.
    const reason = `Specialist ${message.sender.role} blocked: ${blockage}`.slice(0, 2000);
    if (!resumablyPaused(run)) {
      run.error = reason;
      run.pendingAction = { actionId: `next-${digest([run.runId, message.message_id])}`, kind: "coordinator_continuation", owner: "coordinator",
        reason, sourceMessageId: message.message_id, createdAt: message.occurred_at ?? this.now(), state: "pending" };
    }
    this.emit(state, outbox, run, "conversation.progress", { kind: "workflow_blocked", runId: run.runId, reason, fromRole: message.sender.role,
      options: ["Ask Coordinator to resolve the blocker (answer it or re-plan the task)", "Cancel this run"],
      headline: `Workflow blocked: ${reason}`, sdlcStatus: run.status }, `specialist-blocked:${message.message_id}`, "conversation");
  }

  private acceptsPausedNativeReply(state: JournalState, run: RunRecord, message: RoleMessage): boolean {
    return resumablyPaused(run) && !run.cancelled && message.recipient.role === "coordinator" &&
      ["spec.draft", "task.status", "verification.escalation"].includes(message.type) &&
      (run.nativeDeliveries?.some(entry => nativeMessageFingerprint(entry.message) === nativeMessageFingerprint(message)) ?? false) &&
      state.outbound.some(out => out.message.message_id === message.causation_id && out.message.run_id === run.runId &&
        out.message.type === "delegation.request" && ["accepted", "released"].includes(out.status) &&
        out.message.recipient.role === message.sender.role && out.handle?.target.agentId === message.sender.agent_id &&
        out.handle?.target.paneId === message.sender.pane_id);
  }

  private defersPausedNativeOutcome(state: JournalState, run: RunRecord, message: RoleMessage): boolean {
    if (!resumablyPaused(run) || run.cancelled || run.supersededBy || !message.idempotency_key ||
        !["execution.receipt", "implementation.submitted", "verification.result", "review.verdict"].includes(message.type)) return false;
    const source = state.outbound.find(out => out.message.message_id === message.causation_id && out.message.run_id === run.runId &&
      ["accepted", "released"].includes(out.status) && out.message.recipient.role === message.sender.role &&
      out.handle?.target.agentId === message.sender.agent_id && out.handle?.target.paneId === message.sender.pane_id);
    if (!source || source.message.type !== (["execution.receipt", "implementation.submitted"].includes(message.type) ? "task.assignment" : "verification.requested")) return false;
    if (message.type === "execution.receipt") AgentBindingReceiptSchema.parse(message.payload);
    else if (message.type === "implementation.submitted") AgentResultSchema.parse(message.payload);
    else if (message.type === "verification.result") VerificationResultSchema.parse(message.payload);
    else QualityGateResultSchema.parse(message.payload);
    return state.inbox.some(item => item.status === "received" && nativeMessageFingerprint(item.message) === nativeMessageFingerprint(message));
  }

  /**
   * Authenticated Coordinator outcomes addressed to Conversation still pass through Runtime first. This is the durable semantic
   * boundary: an agent's message receipt alone cannot update the user transcript while leaving the run unaware of its blocker.
   */
  async observeCoordinatorOutcome(input: unknown, options: { notificationAlreadyRecorded?: boolean } = {}): Promise<void> {
    const parsed = RoleMessageSchema.parse(input);
    if (parsed.sender.role !== "coordinator" || parsed.recipient.role !== "conversation" ||
        !["task.status", "conversation.progress"].includes(parsed.type)) throw new Error("Invalid Coordinator-to-Conversation workflow outcome");
    if (!await this.ports.authenticateMessage(parsed)) throw new Error("Unauthenticated Coordinator workflow outcome");
    // Only a matching live run has semantics to journal; any other status update is still delivered to Conversation unchanged.
    if (!parsed.run_id) return;
    return this.transaction(async (state, save, _core, outbox) => {
      await this.refuseFencedDiagnostic(state, save, parsed);
      const run = state.runs.find(item => item.runId === parsed.run_id);
      if (!run || parsed.correlation_id !== run.delegation.correlationId || run.cancelled || ["completed", "failed", "cancelled"].includes(run.status)) return;
      const existing = state.inbox.find(item => item.message.message_id === parsed.message_id || (parsed.idempotency_key !== undefined && item.message.idempotency_key === parsed.idempotency_key));
      if (existing && digest(existing.message) !== digest(parsed)) throw new Error("Conflicting Coordinator outcome idempotency key");
      if (existing?.status === "applied") return;
      if (!existing) { state.inbox.push({ message: parsed, status: "received" }); await save(); }
      const blockage = specialistBlockage(parsed.payload);
      if (blockage !== undefined) {
        if (run.workflowVerificationPending || run.tasks.some(task => task.verificationPending)) {
          // The Runtime-owned verification result decides this phase. A model's delivery diagnostic cannot pause its live waiter or reset its lineage counters.
          const inbox = state.inbox.find(item => item.message.message_id === parsed.message_id)!; inbox.status = "applied";
          await save(); return;
        }
        if (run.status === "awaiting_approval" || Object.values(run.userDecisions ?? {}).some(item => item.status === "pending")) {
          const inbox = state.inbox.find(item => item.message.message_id === parsed.message_id)!; inbox.status = "applied"; await save(); return;
        }
        if (run.status === "escalated" && run.pendingAction) {
          const inbox = state.inbox.find(item => item.message.message_id === parsed.message_id)!; inbox.status = "applied"; await save(); return;
        }
        const reason = `Coordinator blocked: ${blockage}`;
        run.error = reason;
        // Automatic capability-repair resume needs a recorded preflight failure of this run, not just matching blocker text;
        // its bounded attempt budget carries over from the action this blocker follows, so resume -> blocked cannot loop.
        const capabilityBlocker = /repository|read-only tool|native mutation|exec_command|resource enumeration/i.test(blockage) &&
          state.outbound.some(out => out.message.run_id === run.runId && out.status === "failed" && out.error?.includes(RoleCapabilityPreflightError.name));
        const staticRunnerBlocker = run.lastWorkflowRejection !== undefined ||
          /runner_setup_required|no_test_runner_detected|missing_test_mapping|unsupported_verification|policy_violation|cannot bind existing detected|runner mapping|test-runner binding/i.test(blockage);
        const recoveryKind = capabilityBlocker ? "capability_repair" : staticRunnerBlocker ? "manual" : "auto_resume";
        // Any other Coordinator blocker resumes automatically with backoff on the same inherited budget; a blocker that needs a
        // human answer goes through request_user_decision instead, and a pending decision/approval never auto-resumes (see above).
        run.pendingAction = { actionId: `next-${digest([run.runId, parsed.message_id])}`, kind: "resume_coordinator", owner: "coordinator",
          reason: reason.slice(0, 2000), sourceMessageId: parsed.message_id, createdAt: this.now(),
          state: "pending", previousStatus: run.status, ...inheritedAutoResume(run), recovery: recoveryKind };
        run.status = "escalated";
        if (!options.notificationAlreadyRecorded) {
          const noticeId = `coordinator-blocked-${digest([run.runId, parsed.message_id])}`;
          const automatic = recoveryKind === "auto_resume" && (run.pendingAction.resumeAttempts ?? 0) < AUTO_RESUME_LIMIT;
          outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: noticeId, correlation_id: run.delegation.correlationId,
            causation_id: parsed.message_id, run_id: run.runId, sender: { role: "runtime" }, recipient: { role: "conversation" },
            type: "conversation.progress", payload: { kind: "workflow_blocked", runId: run.runId, sdlcStatus: run.status,
              headline: automatic ? "Workflow bị chặn; Runtime sẽ tự tiếp tục Coordinator sau thời gian chờ" : "Workflow đang chờ khắc phục blocker",
              reason, blockageReason: reason, fromRole: "coordinator", actionId: run.pendingAction.actionId,
              ...(automatic ? { automaticResume: automaticResumeNotice(run.pendingAction) } : {}),
              options: ["Khắc phục capability rồi yêu cầu tiếp tục run", "Hủy run"] },
            artifact_references: [], occurred_at: this.now(), idempotency_key: noticeId }), "conversation");
        }
      }
      const inbox = state.inbox.find(item => item.message.message_id === parsed.message_id)!;
      inbox.status = "applied"; await save();
    });
  }

  /** Resume only a recorded recoverable Coordinator blocker. The stable action identity prevents duplicate wakeups on retry/restart. */
  private async resumeAcceptedRedDeveloper(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox, run: RunRecord, messageId: string): Promise<void> {
    if (run.status !== "implementing" || run.cancelled || run.nativeDeliveries?.length ||
        run.approval !== undefined && run.decision?.approvalId !== run.approval.approvalId || Object.values(run.userDecisions ?? {}).some(item => item.status === "pending") ||
        state.outbound.some(item => item.message.run_id === run.runId && ["sending", "unknown_delivery"].includes(item.status))) return;
        const snapshot = await core.snapshot(run.runId);
        for (const task of run.tasks) {
          const evidence = task.spec.strategy.metadata?.tddEvidence;
          if (task.writerReleased || task.result || !Array.isArray(evidence) || evidence.length !== 1 || task.spec.strategy.tddDecision.mode !== "required") continue;
          const red = VerificationResultSchema.parse(evidence[0]);
          if (record(red.metadata?.conditionalTdd).phase !== "red") continue;
          const current = snapshot.tasks.find(item => item.taskId === task.taskId);
          const parent = state.outbound.find(item => item.message.type === "task.assignment" && item.message.run_id === run.runId &&
            item.taskId === task.taskId && item.status === "accepted" && item.handle?.requestId === current?.agentExecution?.requestId);
          if (current?.status !== "running" || !parent?.lease || Date.parse(parent.lease.expiresAt) <= Date.parse(this.now())) continue;
          this.ports.policies.assertReadyToImplement(task.spec.strategy);
          const outcomeId = `resume:${messageId}:${red.verificationId}`;
          if (state.outbound.some(item => item.message.message_id === `phase-notice-${digest([run.runId, task.taskId, "red", outcomeId])}`)) continue;
          this.phaseNotice(state, outbox, run, task, "red", "passed",
            `Runtime resumed this same assignment after a verified Red receipt (${red.verificationId}). Inspect workspace status and continue the accepted TDD sequence; do not modify frozen tests. No new approval or measurement is granted.`,
            outcomeId);
        }
    await save();
  }
  async resumeBlockedRun(runIdInput: string, actionIdInput: string, options: { automatic?: boolean; conversationUserMessageId?: string } = {}): Promise<JsonValue> {
    const runId = textField(runIdInput), actionId = textField(actionIdInput);
    return this.transaction(async (state, save, _core, outbox) => {
      const run = this.run(state, runId), action = run.pendingAction;
      if (run.nativeDeliveries?.length || state.outbound.some(item => item.message.run_id === runId && ["sending", "unknown_delivery"].includes(item.status) && !isConversationDelivery(item)))
        throw new Error("Unknown delivery must be reconciled before resume");
      if (run.supersededBy) throw new AdmissionRejectedError(`Run ${runId} continued as follow-up run ${run.supersededBy}; resume or inspect ${run.supersededBy}`);
      if (run.cancelled || ["completed", "failed", "cancelled"].includes(run.status)) throw new Error(`Run is ${run.status}; it cannot be resumed`);
      const priorResume = run.resumeReceipts?.find(item => item.actionId === actionId);
      // An automatic wake is not the user's explicit operational request. Keep its immutable delivery,
      // but allow a separately identified manual continuation even while that wake is queued/accepted.
      const priorWake = priorResume && state.outbound.find(item => item.message.message_id === priorResume.messageId);
      const retiredToResume = !options.automatic && options.conversationUserMessageId ? state.outbound.filter(item =>
        item.message.run_id === runId && item.phaseRetirement && !item.phaseRetirement.resumeAuthorizedBy) : [];
      const physicalAfterModel = !options.automatic && options.conversationUserMessageId !== undefined && priorWake !== undefined &&
        record(priorWake.message.payload).conversationUserMessageId === undefined;
      const explicitAfterAutomatic = !options.automatic && action?.actionId === actionId && action.kind === "resume_coordinator" &&
        (priorWake !== undefined && record(priorWake.message.payload).automatic === true || physicalAfterModel || retiredToResume.length > 0);
      const retryUnsent = action?.actionId === actionId && action.state === "pending" &&
        [action.sourceMessageId, ...(action.relatedMessageIds ?? [])].every(id => state.outbound.some(out =>
          out.message.message_id === id && out.status === "failed" && out.error?.includes(RoleCapabilityPreflightError.name)));
      // A receipt answers a repeated call for the episode it settled; the same identity pending again (a recurrence) is a new episode.
      const recurred = run.status === "escalated" && action?.actionId === actionId && action.state === "pending";
      const repeatedPhysicalTurn = options.conversationUserMessageId !== undefined && priorWake !== undefined &&
        record(priorWake.message.payload).conversationUserMessageId === options.conversationUserMessageId;
      if (priorResume && (repeatedPhysicalTurn || !retryUnsent && !recurred && !explicitAfterAutomatic)) {
        if (!options.automatic && options.conversationUserMessageId) await this.resumeAcceptedRedDeveloper(state, save, _core, outbox, run, priorResume.messageId);
        return json({ queued: true, messageId: priorResume.messageId, actionId });
      }
      // A still-unknown native delivery (legacy escalated record) resumes by waking the Coordinator to reconcile; it is never resent.
      if ((!explicitAfterAutomatic && run.status !== "escalated") || !action || action.actionId !== actionId || !["resume_coordinator", "reconcile_delivery"].includes(action.kind)) {
        const prior = state.outbound.find(item => item.message.message_id === `resume-${digest([runId, actionId])}`);
        if (prior) return json({ queued: true, messageId: prior.message.message_id, actionId });
        throw new Error("No matching recoverable blocker to resume");
      }
      // Explicitly restoring a paused approval wait answers no human decision
      // and cannot schedule work. Automatic resumes must still stop at the gate.
      const restoreApprovalWait = !options.automatic && action.previousStatus === "awaiting_approval" &&
        ["task", "delivery"].includes(run.approvalKind ?? "") && run.approval?.status === "pending";
      if (Object.values(run.userDecisions ?? {}).some(item => item.status === "pending") ||
          run.approval !== undefined && (!run.decision || run.decision.approvalId !== run.approval.approvalId) && !restoreApprovalWait)
        throw new Error("A pending approval or user decision must be resolved before resume");
      if (options.automatic && (action.resumeAttempts ?? 0) >= AUTO_RESUME_LIMIT) throw new Error("Bounded resume attempts are exhausted; cancel or request operator intervention");
      // An explicit user resume has its own bound and is still allowed once the automatic budget is spent.
      if (!options.automatic && (action.manualResumeAttempts ?? 0) >= MANUAL_RESUME_LIMIT)
        throw new Error(`Explicit resume budget is exhausted (${MANUAL_RESUME_LIMIT} user resumes of this blocker); cancel the run or request operator intervention`);
      // Re-checked under the journal lock: the classification/backoff may have changed since the automatic pass selected it.
      if (options.automatic && (action.state !== "pending" || !["auto_resume", "capability_repair"].includes(action.recovery ?? "manual") ||
          action.recovery === "auto_resume" && Date.parse(this.now()) < autoResumeDueAt(action)))
        throw new Error("No matching recoverable blocker to resume automatically");
      if (state.outbound.some(item => item.message.run_id === runId && item.status === "unknown_delivery"))
        throw new Error("Unknown delivery must be reconciled before resume");
      const failureIds = [action.sourceMessageId, ...(action.relatedMessageIds ?? [])];
      const failedCapabilityDispatches = failureIds.map(id => state.outbound.find(item => item.message.message_id === id &&
        item.status === "failed" && item.error?.includes(RoleCapabilityPreflightError.name))).filter((item): item is Outbound => item !== undefined);
      if (action.requiredRole !== undefined && !failedCapabilityDispatches.length) {
        // requestSpecialist preflight found the needed role unready before a message could be constructed.
        const binding = unwrap(await this.ports.panes.getRoleBinding(action.requiredRole));
        if (!binding || !this.ports.preflightRoleCapabilities) throw new Error("The required specialist pane/capability is not ready");
        const requirements = action.requiredCapabilities ?? ["repository.read"];
        await this.ports.preflightRoleCapabilities(binding, requirements);
        if (requirements.some(capability => !this.ports.roleCapabilities[action.requiredRole!]?.includes(capability)))
          throw new RoleCapabilityPreflightError(`${action.requiredRole} required capability is unavailable: ${requirements.join(", ")}`);
      } else if (failedCapabilityDispatches.length !== failureIds.length && failedCapabilityDispatches.length > 0) {
        throw new Error("A recorded capability handoff is missing or no longer safely unsent");
      }
      const resumeBindings = failedCapabilityDispatches.length
        ? await Promise.all(failedCapabilityDispatches.map(async item => ({ item, binding: unwrap(await this.ports.panes.getRoleBinding(item.selector)) })))
        : [{ item: undefined, binding: unwrap(await this.ports.panes.getRoleBinding(action.requiredRole ?? "coordinator")) }];
      if (resumeBindings.some(item => !item.binding) || !this.ports.preflightRoleCapabilities)
        throw new Error("The current session has no verified role capability preflight");
      const resumeRequirements = action.requiredCapabilities ?? ["repository.read"];
      for (const entry of resumeBindings) {
        const binding = entry.binding;
        if (!binding) throw new RoleCapabilityPreflightError("The required role pane is not bound in this session");
        const requirements = entry.item?.capabilities ?? resumeRequirements;
        await this.ports.preflightRoleCapabilities(binding, requirements);
        if (requirements.some(capability => !this.ports.roleCapabilities[binding.role]?.includes(capability)))
          throw new RoleCapabilityPreflightError(`${binding.role} required capability is unavailable: ${requirements.join(", ")}`);
      }
      const messageId = `resume-${digest(retiredToResume.length ? [runId, action.actionId, "retired", retiredToResume.map(item => item.message.message_id)] : options.conversationUserMessageId ? [runId, action.actionId, "physical", options.conversationUserMessageId] : explicitAfterAutomatic ? [runId, action.actionId, "explicit"] : [runId, action.actionId])}`;
      if (failedCapabilityDispatches.length) {
        // Preflight failed before a lease or transport operation. Reuse that exact immutable unsent handoff once the target proof passes.
        for (const failedCapabilityDispatch of failedCapabilityDispatches) {
          failedCapabilityDispatch.status = "queued"; delete failedCapabilityDispatch.error; delete failedCapabilityDispatch.deliveryAttempts;
          delete failedCapabilityDispatch.nextAttemptAt;
        }
      } else {
        const existing = state.outbound.find(item => item.message.message_id === messageId);
        if (!existing) outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: messageId,
          correlation_id: run.delegation.correlationId, causation_id: action.sourceMessageId, run_id: runId,
          sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status",
          payload: { kind: "resume_run", actionId: action.actionId, reason: action.reason,
            ...(options.automatic ? { automatic: true, attempt: (action.resumeAttempts ?? 0) + 1, limit: AUTO_RESUME_LIMIT } : { automatic: false,
              ...(options.conversationUserMessageId ? { conversationUserMessageId: textField(options.conversationUserMessageId) } : {}) }),
            diagnosticFences: (run.nativeDiagnosticFences ?? []).map(item => ({ operationId: item.operationId, disposition: item.disposition, delivery: "unknown_delivery", resendAllowed: false })),
            next: options.automatic
              ? "Runtime resumed this run automatically (bounded). Inspect the durable blocker, then record the next workflow action through Runtime; if only a human can decide, use request_user_decision instead of stopping."
              : "This is an explicit operational resume request, distinct from earlier automatic wakes or hold instructions. Inspect the current durable blocker and diagnostic fences, confirm the required capability is now available, then continue this same run through Runtime. It grants no approval, TDD/verification-limit reset, delivery claim or implementation authority." },
          artifact_references: [], occurred_at: this.now(), idempotency_key: messageId }), "coordinator");
      }
      const verificationRetry = run.error?.startsWith(VERIFICATION_RETRY_PREFIX) === true;
      const measurement = state.outbound.find(item => item.message.message_id === action.sourceMessageId && item.phaseFailure?.repairable === false);
      if (measurement) measurement.phaseFailure!.retryAuthorized = true;
      action.state = "queued";
      action.lastResumedAt = this.now();
      if (options.automatic) action.resumeAttempts = (action.resumeAttempts ?? 0) + 1;
      else {
        // The user's resume grants a fresh automatic budget, with backoff counted from now, so the run can recover itself again.
        action.manualResumeAttempts = (action.manualResumeAttempts ?? 0) + 1;
        action.resumeAttempts = 0;
        if (action.kind === "resume_coordinator" && (action.recovery === undefined || action.recovery === "manual")) action.recovery = "auto_resume";
      }
      run.status = action.previousStatus ?? (explicitAfterAutomatic ? run.status : "specifying");
      if (verificationRetry) this.prepareVerificationRetry(state, run); // same as retry_verification
      delete action.previousStatus;
      delete run.error;
      run.resumeReceipts ??= [];
      if (priorResume) priorResume.messageId = messageId;
      else run.resumeReceipts.push({ actionId, messageId });
      if (run.resumeReceipts.length > 50) run.resumeReceipts.shift();
      for (const retired of retiredToResume) retired.phaseRetirement!.resumeAuthorizedBy = textField(options.conversationUserMessageId);
      if (!options.automatic && options.conversationUserMessageId) await this.resumeAcceptedRedDeveloper(state, save, _core, outbox, run, messageId);
      await this.recoverPhaseFailures(state, save, outbox);
      await save();
      return json({ queued: true, messageId, actionId: action.actionId });
    });
  }

  /**
   * Bounded automatic recovery pass, run at host restart and periodically by the host watchdog. Resumes an escalated, uncancelled
   * run whose pending Coordinator action is classified `auto_resume` (after its 30s/60s/120s backoff) or `capability_repair` (once a
   * capability proof passes), while no approval or user decision is pending and no delivery is unknown. A verification
   * delivery/storage escalation re-runs the existing retry_verification path; every other one wakes the Coordinator with the
   * existing idempotent `resume_run` (keyed by actionId). Each resume spends the persisted `resumeAttempts` budget (limit 3):
   * once spent, the action becomes `manual` and Conversation is told once, with how to resume it explicitly. An explicit user
   * resume has its own bound (`manualResumeAttempts`, 3) and grants a fresh automatic budget. Human decisions are never answered here.
   */
  async resumeRecoverableRuns(): Promise<JsonValue> {
    if (this.quiesced) return json({ resumed: 0, reason: "quiesced" });
    const coordinatorReadable = this.ports.roleCapabilities.coordinator?.includes("repository.read") === true;
    const candidates = await this.transaction(async (state, save, _core, outbox) => {
      const now = Date.parse(this.now());
      const recoverable = state.runs.filter(run => run.status === "escalated" && !run.cancelled && !run.supersededBy &&
        run.pendingAction?.kind === "resume_coordinator" && run.pendingAction.state === "pending" &&
        ["auto_resume", "capability_repair"].includes(run.pendingAction.recovery ?? "manual"));
      let changed = false;
      for (const run of recoverable.filter(item => (item.pendingAction!.resumeAttempts ?? 0) >= AUTO_RESUME_LIMIT)) {
        // Budget spent: stop automatic resumes and say so once; an explicit user resume/cancel decides from here.
        const action = run.pendingAction!, actionId = action.actionId, manual = action.manualResumeAttempts ?? 0;
        const manualLeft = Math.max(0, MANUAL_RESUME_LIMIT - manual);
        this.emit(state, outbox, run, "conversation.progress", { kind: "workflow_blocked", runId: run.runId, sdlcStatus: run.status, owner: "coordinator",
          actionId, reason: action.reason, blockageReason: action.reason, manualResumesLeft: manualLeft,
          headline: manualLeft > 0
            ? `Automatic resume stopped after 3 attempts; the same blocker keeps recurring. Type \`tiếp tục ${run.runId}\` to resume it (${manualLeft} of ${MANUAL_RESUME_LIMIT} user resumes left)`
            : `Automatic resume stopped after 3 attempts; the same blocker keeps recurring. All ${MANUAL_RESUME_LIMIT} user resumes are used: fix the cause with an operator or cancel`,
          options: manualLeft > 0
            ? [`Gõ \`tiếp tục ${run.runId}\` để Runtime tiếp tục run (còn ${manualLeft}/${MANUAL_RESUME_LIMIT} lần)`, "Khắc phục nguyên nhân (capability/pane) với operator", "Hủy run"]
            : ["Khắc phục nguyên nhân (capability/pane) với operator; run không tự tiếp tục nữa", "Hủy run"] },
          // Each user-granted automatic budget that runs out again is a new, separately reported exhaustion.
          manual === 0 ? `auto-resume-exhausted:${actionId}` : `auto-resume-exhausted:${actionId}:${manual}`, "conversation");
        action.recovery = "manual";
        changed = true;
      }
      if (changed) await save();
      return recoverable.filter(run => {
        const action = run.pendingAction!;
        if ((action.resumeAttempts ?? 0) >= AUTO_RESUME_LIMIT) return false;
        // Human gates and unknown deliveries are durable waits: never answered, resent or bypassed automatically.
        if (Object.values(run.userDecisions ?? {}).some(item => item.status === "pending") ||
            run.approval !== undefined && (!run.decision || run.decision.approvalId !== run.approval.approvalId)) return false;
        if (run.nativeDeliveries?.length || state.outbound.some(item => item.message.run_id === run.runId &&
            ["sending", "unknown_delivery"].includes(item.status) && !isConversationDelivery(item))) return false;
        return action.recovery !== "auto_resume" || now >= autoResumeDueAt(action);
      }).map(run => ({ runId: run.runId, actionId: run.pendingAction!.actionId,
        verificationRetry: run.error?.startsWith(VERIFICATION_RETRY_PREFIX) === true && run.pendingAction!.recovery === "auto_resume" }));
    });
    let resumed = 0;
    for (const candidate of candidates) {
      try {
        if (candidate.verificationRetry) {
          // Same transition as the Coordinator's retry_verification tool; Runtime then re-runs the verification itself.
          await this.retryVerification(candidate.runId, { automatic: true, actionId: candidate.actionId }); resumed++; continue;
        }
        if (!coordinatorReadable) continue;
        const pane = unwrap(await this.ports.panes.getRoleBinding("coordinator"));
        if (!pane) continue;
        const health = unwrap(await this.ports.panes.inspectRoleHealth("coordinator"));
        if (!health.readyForPrompt || !health.occupantMatches || health.paneId !== pane.paneId) continue;
        await this.resumeBlockedRun(candidate.runId, candidate.actionId, { automatic: true }); resumed++;
      } catch (error) {
        // Unknown delivery, cancellation/approval, stale role binding and capability proof failures remain durable waits.
        // Recovery is best-effort per action: one unresolved run must not abort host activation or block other runs.
        if (error instanceof RoleCapabilityPreflightError || /Unknown delivery|pending approval|matching recoverable blocker|no verified role capability|capability is unavailable|No verification awaiting retry|exhausted|quiesced/i.test(String(error))) continue;
        throw error;
      }
    }
    return json({ resumed });
  }
  /** Private host boundary: provider text is useful only when it is an exact pinned Runtime delivery. */
  private providerDelivery(state: JournalState, message: RoleMessage, binding: PaneBinding): Outbound {
    const outbound = state.outbound.find(out => out.request && ["sending", "unknown_delivery", "accepted", "released"].includes(out.status) &&
      out.request.target.paneId === binding.paneId && out.request.target.agentId === binding.agentId &&
      out.request.target.workspaceId === binding.workspaceId && out.request.target.tabId === binding.tabId &&
      digest(out.request.target.session) === digest(binding.session) && digest(out.request.context) === digest(message));
    if (!outbound || message.recipient.role !== binding.role) throw new Error("Inbound provider prompt is not an exact Runtime outbox delivery");
    return outbound;
  }
  async validateProviderDelivery(input: unknown, bindingInput: unknown): Promise<void> {
    const message = RoleMessageSchema.parse(input), binding = PaneBindingSchema.parse(bindingInput);
    await this.transaction(async state => { this.providerDelivery(state, message, binding); });
  }
  /** Current native Agy admission/tool authority; historical delivery matching alone grants no new action. */
  async authorizeAgyProviderTurn(input: unknown, bindingInput: unknown, operationName?: string): Promise<void> {
    const message = RoleMessageSchema.parse(input), binding = PaneBindingSchema.parse(bindingInput);
    await this.transaction(async (state, _save, core, outbox) => {
      if (this.quiesced && (operationName === undefined || !QUIESCED_RECEIPT_DRAIN_OPERATIONS.includes(operationName)))
        throw new Error("Runtime is quiesced; only existing receipt-drain operations are permitted");
      if (binding.role === "conversation" || binding.agentKind !== "agy" || !binding.session ||
          !["agy", "herdr:antigravity_cli"].includes(binding.session.source)) throw new Error("No current native Agy specialist authority");
      const out = this.providerDelivery(state, message, binding);
      if (!["sending", "unknown_delivery", "accepted"].includes(out.status) || out.cancelRequested || out.leaseRelease)
        throw new Error("Agy delivery is released, cancelled or no longer active");
      const run = this.run(state, textField(message.run_id));
      this.live(run);
      assertNoPendingPaneDecision(run, binding);
      if (binding.role === "coordinator") {
        if (message.type === "delegation.request" && message.sender.role === "conversation") {
          if (digest(DelegationRequestSchema.parse(message.payload)) !== digest(run.delegation)) throw new Error("Agy delegation revision is stale");
        } else if (message.type !== "task.status" || message.sender.role !== "runtime") throw new Error("Agy Coordinator needs a current Runtime trigger");
      } else if (!["task.assignment", "delegation.request", "verification.requested", "task.status"].includes(message.type) ||
          message.sender.role !== "coordinator" && message.sender.role !== "runtime") throw new Error("Agy specialist needs an assigned Runtime delivery");
      const owner = out.parentAssignmentId ? state.outbound.find(item => item.message.message_id === out.parentAssignmentId) : out;
      // Dispatch receipts remain immutable across a bounded, authorized continuation of this same Core execution.
      // Journal validation pins history ownership and increasing fences; Registry renewal below proves the current grant.
      const dispatchLease = owner?.lease && [owner.lease, ...owner.leaseHistory ?? []].find(lease =>
        out.request?.metadata?.leaseId === lease.leaseId && out.request.metadata?.fencingToken === lease.fencingToken);
      if (!owner || !["sending", "unknown_delivery", "accepted"].includes(owner.status) || owner.cancelRequested || owner.leaseRelease || !owner.lease || !out.request ||
          Date.parse(owner.lease.expiresAt) <= Date.parse(this.now()) || !dispatchLease ||
          owner.lease.agentId !== binding.agentId || owner.lease.runId !== run.runId || owner.lease.taskId !== owner.request?.taskId)
        throw new Error("Agy delivery has no current matching lease and fence");
      let continuation = false;
      if (message.type === "task.status") {
        const payload = record(message.payload);
        if (payload.kind === "user_decision_answer" && typeof payload.approvalId === "string") {
          const entry = run.userDecisions?.[payload.approvalId];
          if (entry && ["answered", "rejected", "expired", "cancelled"].includes(entry.status) && entry.role === binding.role &&
              entry.agentId === binding.agentId && entry.paneId === binding.paneId && out.taskId === entry.taskId) {
            const superseded = run.supersededApprovals?.find(item => item.approvalId === entry.request.approvalId);
            const expected = entry.status === "cancelled" ? { kind: "user_decision_answer", approvalId: entry.request.approvalId, outcome: "cancelled",
              reason: `Requirement revision ${superseded?.supersededByRevision} superseded this question` } :
              { kind: "user_decision_answer", approvalId: entry.request.approvalId, outcome: entry.answer?.outcome ?? "expired",
              ...(entry.answer?.selectedOption === undefined ? {} : { selectedOption: entry.answer.selectedOption }),
              ...(entry.answer?.reason === undefined ? {} : { reason: entry.answer.reason }) };
            continuation = (entry.status !== "cancelled" || superseded !== undefined) && digest(payload) === digest(expected) && message.causation_id === `decision-${entry.request.approvalId}` &&
              message.message_id === `user-decision-answer-${digest([run.runId, entry.request.approvalId, entry.status])}`;
          }
        } else if (payload.kind === "role_message_rejected") {
          continuation = payload.status === "rejected" && payload.runId === run.runId && message.causation_id === payload.rejectedMessageId &&
            state.inbox.some(item => item.status === "rejected" && item.message.message_id === payload.rejectedMessageId &&
              item.message.run_id === run.runId && item.message.type === payload.rejectedType && item.message.sender.role === binding.role &&
              item.message.sender.agent_id === binding.agentId && item.message.sender.pane_id === binding.paneId);
        } else if (payload.kind === "resume_verification_request") {
          const source = state.outbound.find(item => item.message.message_id === payload.sourceMessageId);
          const receipt = run.resumeReceipts?.find(item => item.actionId === run.pendingAction?.actionId);
          const wake = receipt && state.outbound.find(item => item.message.message_id === receipt.messageId);
          const target = source?.handle?.target;
          continuation = ["reviewer", "qa", "tester"].includes(binding.role) && run.status === "verifying" &&
            run.pendingAction?.state === "queued" && typeof payload.conversationUserMessageId === "string" &&
            record(wake?.message.payload).automatic === false && record(wake?.message.payload).conversationUserMessageId === payload.conversationUserMessageId &&
            source?.status === "released" && source.message.type === "verification.requested" && source.message.run_id === run.runId &&
            record(record(record(source.message.payload).definition).configuration).kind === "review" && !source.reviewReplacement &&
            target !== undefined && target.agentId === binding.agentId && target.paneId === binding.paneId &&
            target.workspaceId === binding.workspaceId && target.tabId === binding.tabId && digest(target.session) === digest(binding.session) &&
            message.sender.role === "runtime" && message.causation_id === source.message.message_id &&
            message.message_id === `review-resume-${digest([source.message.message_id, payload.conversationUserMessageId])}` &&
            !run.nativeDeliveries?.length && (!run.approval || run.decision?.approvalId === run.approval.approvalId) &&
            !Object.values(run.userDecisions ?? {}).some(entry => entry.status === "pending") &&
            !state.outbound.some(item => item.message.run_id === run.runId && ["sending", "unknown_delivery"].includes(item.status) && item !== out) &&
            this.outboundOwesResult(state, run, source);
        }
      }
      if (binding.role !== "coordinator" && !out.parentAssignmentId &&
          (message.type === "task.status" ? !continuation : out.status === "accepted" && !this.outboundOwesResult(state, run, out)))
        throw new Error("Agy specialist delivery has already been answered or replaced");
      if (owner.message.type === "task.assignment") {
        if (isConflictResolverAssignment(owner.message)) {
          const resolver = this.currentResolver(run, owner);
          if (!resolver || resolver.attempt.status !== "assigned") throw new Error("Agy conflict resolver attempt is no longer current");
        } else {
          const task = run.tasks.find(item => item.taskId === owner.taskId);
          const current = (await core.snapshot(run.runId)).tasks.find(item => item.taskId === owner.taskId);
          if (!task || task.spec.specification.status !== "approved" || task.result || task.writerReleased ||
              current?.status !== "running" || current.attemptId !== owner.attemptId ||
              owner.status === "accepted" && (!owner.handle || digest(current.agentExecution) !== digest(owner.handle)) ||
              current.agentExecution !== undefined && (!owner.handle || digest(current.agentExecution) !== digest(owner.handle))) throw new Error("Agy assignment attempt is no longer current");
        }
      }
      // Registry, rather than the journal's future expiry, proves current fencing authority.
      await outbox.renew(out);
    });
  }
  /** An authenticated Stop is operational evidence only. It never applies ingress, retries delivery or changes business state. */
  async coordinatorTurnStopped(input: unknown, bindingInput: unknown): Promise<void> {
    const message = RoleMessageSchema.parse(input), binding = PaneBindingSchema.parse(bindingInput);
    await this.transaction(async (state, save, _core, outbox) => {
      const delivery = this.providerDelivery(state, message, binding);
      if (binding.role !== "coordinator" || message.type !== "delegation.request" || message.sender.role !== "conversation")
        throw new Error("Coordinator Stop requires an exact Conversation delegation");
      const run = state.runs.find(item => item.runId === message.run_id);
      if (!run) {
        const messageId = `coordinator-no-response-${digest(message.message_id)}`;
        if (state.outbound.some(out => out.message.message_id === messageId)) return;
        outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: messageId,
          correlation_id: message.correlation_id, causation_id: message.message_id, run_id: message.run_id,
          sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "conversation.progress",
          payload: { kind: "coordinator_no_response", owner: "runtime", headline: "Coordinator turn ended without a structured response",
            reason: "The delivered delegation has no durable ingress in Runtime. Inspect host delivery diagnostics before retrying.",
            blockageReason: "The delivered delegation has no durable ingress in Runtime. The request remains unresolved.",
            options: ["Inspect and reconcile the original delegation delivery", "Cancel the pending request"] },
          artifact_references: [], occurred_at: this.now(), idempotency_key: messageId }));
        await save(); return;
      }
      if (run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status) || this.hasSemanticNextAction(state, run)) return;
      if (!state.inbox.some(item => item.message.message_id === message.message_id && item.status === "applied"))
        run.error = "The delivered delegation has no durable ingress in Runtime; authorized intake is retained. Reconcile the delivery or resume the same run.";
      this.recordCoordinatorNoNextAction(state, outbox, run, message, delivery);
      await save();
    });
  }

  /** A business action, not pane activity or a status message, is the evidence that a run can progress. */
  private hasSemanticNextAction(state: JournalState, run: RunRecord): boolean {
    if (run.status === "awaiting_approval" || Object.values(run.userDecisions ?? {}).some(item => item.status === "pending") ||
        run.tasks.some(task => task.verificationPending) || state.pendingVerifications.some(item => pendingRunId(item) === run.runId)) return true;
    if (run.workflowVerificationPending) return true; // Runtime owns workflow-level verification in flight.
    if (run.pendingAction?.kind === "resume_coordinator" && run.pendingAction.state === "pending") return true; // Explicitly actionable, surfaced blocker.
    if (run.pendingAction?.kind === "reconcile_delivery" && run.pendingAction.state === "pending") return true; // Explicit, no-resend reconciliation path.
    const activeHandoff = state.outbound.some(out => out.message.run_id === run.runId && out.message.recipient.role !== "conversation" &&
      out.message.recipient.role !== "coordinator" && ["task.assignment", "delegation.request", "verification.requested"].includes(out.message.type) &&
      ["queued", "sending"].includes(out.status));
    if (activeHandoff) return true;
    if (state.outbound.some(out => this.outboundOwesResult(state, run, out))) return true;
    if (run.pendingAction?.kind === "coordinator_continuation") return false; // A wake exists; only an actual downstream request consumes it.
    // Once Core exists, the Runtime scheduler (dispatch, verification, integration, workflow cycle) and watchdog own liveness.
    if (run.coreCreated && run.tasks.length > 0) return true;
    if (run.status === "clarifying" && state.outbound.some(out => out.message.run_id === run.runId &&
        out.message.type === "conversation.clarification" && ["queued", "sending", "delivered"].includes(out.status))) return true;
    return false;
  }

  /** A matching host Stop and released capacity are required; a warning or resume is never proof of stop. */
  private stoppedWithoutResult(state: JournalState, run: RunRecord, out: Outbound): boolean {
    if (out.status !== "released" || run.nativeDeliveries?.length || !this.outboundOwesResult(state, run, out)) return false;
    if (out.stopObservedAt !== undefined) return true;
    return state.outbound.some(item => item.message.message_id === `p19-wake-${digest([run.runId, `specialist_no_response:${out.message.message_id}`])}` &&
      objectField(item.message.payload, "stoppedExecutionId") === out.handle!.executionId &&
      Date.parse(String(objectField(item.message.payload, "stopObservedAt"))) >= Date.parse(out.handle!.acceptedAt));
  }
  /** A specialist attempt replaced by a newer attempt of the same Coordinator request no longer owes a result. */
  private supersededAttempt(state: JournalState, out: Outbound): boolean {
    const key = objectField(out.message.payload, "idempotencyKey");
    return out.message.type === "delegation.request" && typeof key === "string" && key.startsWith("specialist:") &&
      state.outbound.some(item => item.message.message_id === `p19-${digest([out.message.run_id, nextAttemptKey(key)])}`);
  }
  /** Lease release frees transport capacity; it does not discharge the correlated business result obligation. */
  private outboundOwesResult(state: JournalState, run: RunRecord, out: Outbound): boolean {
    if (this.supersededAttempt(state, out)) return false;
    const resolver = this.currentResolver(run, out);
    if (resolver) return resolver.attempt.status === "assigned" && !!out.handle && ["accepted", "released"].includes(out.status);
    if (out.message.run_id !== run.runId || !out.handle || !["accepted", "released"].includes(out.status) ||
        ["coordinator", "conversation"].includes(out.message.recipient.role) ||
        !["delegation.request", "task.assignment", "verification.requested"].includes(out.message.type) || out.parentAssignmentId) return false;
    return !state.inbox.some(item => item.status === "applied" && item.message.run_id === run.runId &&
      item.message.sender.role === out.message.recipient.role && item.message.sender.agent_id === out.handle!.target.agentId &&
      item.message.sender.pane_id === out.handle!.target.paneId && item.message.causation_id === out.message.message_id &&
      (out.message.type !== "task.assignment" || item.message.type === "implementation.submitted") &&
      ["spec.draft", "task.status", "verification.escalation", "verification.result", "review.verdict", "implementation.submitted"].includes(item.message.type) &&
      (item.message.type !== "task.status" || TERMINAL_TASK_STATUS_RESULTS.includes(String(objectField(item.message.payload, "status")))));
  }

  private recordCoordinatorNoNextAction(state: JournalState, outbox: HerdrOutbox, run: RunRecord, message: RoleMessage, _delivery: Outbound): void {
    if (run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status)) return;
    const prior = run.pendingAction;
    let rejection = run.lastWorkflowRejection;
    if (rejection && run.resumeReceipts?.some(receipt => receipt.actionId === rejection!.actionId && receipt.messageId === message.message_id)) {
      // A new delivered resumed turn stopped without correcting the proposal. Stop replay
      // keeps the pending action; a new turn needs a new wake and the inherited budget.
      const episodeNumber = rejection.episodeNumber + 1;
      const sourceMessageId = `rejection-r${revisionOf(run.delegation)}-ep${episodeNumber}-${digest([run.runId, revisionOf(run.delegation), episodeNumber])}`;
      rejection = { ...rejection, episodeNumber, sourceMessageId,
        actionId: `next-${digest([run.runId, sourceMessageId])}`, rejectedAt: this.now() };
      run.lastWorkflowRejection = rejection;
    }
    const previousStatus = rejection?.previousStatus ?? prior?.previousStatus ?? (run.status === "escalated" ? "planning" : run.status);
    const reason = rejection ? rejection.reason : (prior?.reason ?? run.error ?? `Coordinator turn ended in ${run.status} without recording a durable next action.`);
    const sourceMessageId = rejection ? rejection.sourceMessageId : (prior?.kind === "coordinator_continuation" && prior.state === "pending"
      ? prior.sourceMessageId : message.message_id);
    const actionId = rejection ? rejection.actionId : `next-${digest([run.runId, sourceMessageId])}`;
    run.error = reason;
    run.status = "escalated";
    const recovery = rejection ? "manual" : "auto_resume";
    run.pendingAction = { actionId, kind: "resume_coordinator", owner: "coordinator",
      reason: reason.slice(0, 2000), sourceMessageId, createdAt: prior?.createdAt ?? this.now(), state: "pending", previousStatus,
      resumeAttempts: prior?.resumeAttempts ?? 0, ...(prior?.lastResumedAt === undefined ? {} : { lastResumedAt: prior.lastResumedAt }),
      ...inheritedManualResume(run), recovery };
    const messageId = `coordinator-no-next-action-${digest([run.runId, run.pendingAction.actionId])}`;
    if (state.outbound.some(out => out.message.message_id === messageId)) return;
    const automatic = recovery === "auto_resume" && (run.pendingAction.resumeAttempts ?? 0) < AUTO_RESUME_LIMIT;
    outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: messageId, correlation_id: run.delegation.correlationId,
      causation_id: message.message_id, run_id: message.run_id, sender: { role: "runtime" }, recipient: { role: "conversation" },
      type: "conversation.progress", payload: { kind: "coordinator_no_response", runId: run.runId, owner: "coordinator",
        actionId: run.pendingAction.actionId, reason, blockageReason: reason,
        headline: automatic ? "Coordinator stopped without a workflow next action; Runtime will resume it automatically" : "Coordinator stopped without a workflow next action",
        ...(automatic ? { automaticResume: automaticResumeNotice(run.pendingAction) } : {}),
        options: rejection?.options?.length ? rejection.options : ["Khắc phục blocker rồi yêu cầu Coordinator tiếp tục run", "Hủy run"] },
      artifact_references: [], occurred_at: this.now(), idempotency_key: messageId }));
  }
  /** Coordinator chooses these calls adaptively. No fixed chain of Analyst -> Architect -> Planner. */
  async reportProgress(runId: string, headline: string, questions: string[] = []): Promise<JsonValue> {
    return this.transaction(async (state, save, _core, outbox) => {
      const run = this.run(state, runId); this.live(run);
      // Once Core exists the scheduler owns the run (dispatch retries, verification, integration); a question is still
      // delivered, but "clarifying" would remove the run from scheduling with no recorded action to resume it.
      if (questions.length && !run.coreCreated) run.status = "clarifying";
      if (run.pendingAction?.kind === "coordinator_continuation") delete run.pendingAction;
      this.emit(state, outbox, run, questions.length ? "conversation.clarification" : "conversation.progress",
        { headline: textField(headline), questions: strings(questions), sdlcStatus: run.status }, `coordinator-progress:${digest([headline, questions])}`);
      await save(); return json({ queued: true });
    });
  }
  /** Specialist roles with a pane bound in this session, with the capabilities the owner configured for them. */
  private async boundSpecialistRoles(): Promise<{ role: string; capabilities: string[] }[]> {
    const bound: { role: string; capabilities: string[] }[] = [];
    for (const role of SPECIALIST_ROLES)
      if (unwrap(await this.ports.panes.getRoleBinding(role))?.role === role) bound.push({ role, capabilities: [...(this.ports.roleCapabilities[role] ?? [])] });
    return bound;
  }
  private async specialistUnavailable(role: string, detail: string): Promise<never> {
    const bound = await this.boundSpecialistRoles();
    throw new SpecialistUnavailableError(`${detail}. Nothing was dispatched and the run is unchanged; choose one of the roles with a bound pane: ${
      bound.length ? bound.map(item => `${item.role} [${item.capabilities.join(", ")}]`).join("; ") : "none"}`, role, bound.map(item => item.role));
  }
  async requestSpecialist(runId: string, requestedRole: string, objective: string, requiredCapabilities: string[]): Promise<JsonValue> {
    return this.transaction(async (state, save, _core, outbox) => {
      const run = this.run(state, runId); this.live(run);
      if (run.nativeDeliveries?.length || state.outbound.some(out => out.message.run_id === runId && ["sending", "unknown_delivery"].includes(out.status) && !isConversationDelivery(out)))
        throw new Error("Unknown delivery must be reconciled before requesting another specialist assignment");
      if (!SPECIALIST_ROLES.includes(requestedRole)) return this.specialistUnavailable(requestedRole, `${requestedRole} is not a specialist role`);
      let role = requestedRole, fallbackFrom: string | undefined;
      let pane = unwrap(await this.ports.panes.getRoleBinding(role));
      if (!pane) {
        // A role absent from this session is a synchronous tool refusal, not a run escalation: the Coordinator re-plans in the same turn.
        const fallback = SPECIALIST_FALLBACKS[requestedRole];
        const fallbackPane = fallback ? unwrap(await this.ports.panes.getRoleBinding(fallback)) : null;
        const capable = fallback !== undefined && [...requiredCapabilities, "repository.read"].every(cap => this.ports.roleCapabilities[fallback]?.includes(cap));
        if (!fallback || !fallbackPane || !capable)
          return this.specialistUnavailable(requestedRole, `${requestedRole} has no bound role pane in this session${
            fallback ? ` and its fallback ${fallback} ${fallbackPane ? `lacks required capabilities ${[...requiredCapabilities, "repository.read"].filter(cap => !this.ports.roleCapabilities[fallback]?.includes(cap)).join(", ")}` : "has no bound pane either"}` : ""}`);
        role = fallback; pane = fallbackPane; fallbackFrom = requestedRole;
        objective = `[Fallback: requested role ${requestedRole} has no pane in this session; ${role} performs this ${requestedRole} work.]\n${objective}`;
      }
      const missingCapabilities = [...requiredCapabilities, "repository.read"].filter(cap => !this.ports.roleCapabilities[role]?.includes(cap));
      if (missingCapabilities.length) {
        // A real pane missing a configured capability is a repairable session defect, not a planning choice.
        const parsedRole = AgentRoleSchema.parse(role);
        const sourceMessageId = `capability-preflight-${digest([runId, role, objective, requiredCapabilities])}`;
        const reason = `${role} dispatch preflight failed: missing capabilities ${missingCapabilities.join(", ")}`;
        const previousStatus = run.status;
        run.error = reason.slice(0, 2000); run.status = "escalated";
        run.pendingAction = { actionId: `next-${digest([run.runId, sourceMessageId])}`, kind: "resume_coordinator", owner: "coordinator",
          reason: run.error, sourceMessageId, createdAt: this.now(), state: "pending", previousStatus, resumeAttempts: inheritedResumeAttempts(run), ...inheritedManualResume(run),
          recovery: "capability_repair", requiredRole: parsedRole, requiredCapabilities: [...new Set([...requiredCapabilities, "repository.read"])] };
        const pendingAction = run.pendingAction;
        this.emit(state, outbox, run, "conversation.progress", { kind: "workflow_blocked", runId, sdlcStatus: run.status,
          owner: "coordinator", actionId: pendingAction.actionId, reason: run.error, blockageReason: run.error,
          headline: `Preflight blocked ${role} before any dispatch`, options: ["Restore role capability or pane, then resume this run", "Cancel run"] },
        `capability-preflight:${sourceMessageId}`, "conversation");
        await save(); return json({ blocked: true, actionId: pendingAction.actionId, reason: run.error });
      }
      // Exact dedupe within one attempt; a stopped holder that still owes the result gets a new deterministic attempt instead.
      let key = `specialist:${role}:${digest([objective, requiredCapabilities])}`;
      for (let prior = state.outbound.find(out => out.message.message_id === `p19-${digest([runId, key])}`);
        prior && (this.supersededAttempt(state, prior) || this.stoppedWithoutResult(state, run, prior)); prior = state.outbound.find(out => out.message.message_id === `p19-${digest([runId, key])}`))
        key = nextAttemptKey(key);
      const delegation = DelegationRequestSchema.parse({ ...run.delegation, delegationId: `delegation-${digest([runId, key])}`,
        messageId: `p19-${digest([runId, key])}`, requestedBy: "coordinator", targetRole: role, objective,
        idempotencyKey: key, requestedAt: this.now(),
        ...(fallbackFrom ? { metadata: { ...run.delegation.metadata, specialistFallback: { requestedRole: fallbackFrom, actingRole: role } } } : {}) });
      const out = this.emit(state, outbox, run, "delegation.request", delegation, key, pane.role, run.delegation.inputArtifacts);
      out.capabilities = [...new Set([...strings(requiredCapabilities), "repository.read"])];
      if (!this.ports.roleCapabilities[role]?.includes("repository.read")) {
        out.status = "failed";
        out.error = `${RoleCapabilityPreflightError.name}: ${role} repository.read capability is missing from the active session`;
        await this.surfaceCapabilityPreflightFailures(state, outbox);
        await save();
        return json({ blocked: true, messageId: out.message.message_id, reason: out.error });
      }
      if (run.pendingAction?.kind === "coordinator_continuation") delete run.pendingAction;
      if (!run.coreCreated) run.status = role === "planner" ? "planning" : "specifying";
      await save(); return json(fallbackFrom ? { ...out.message, fallback: { requestedRole: fallbackFrom, actingRole: role } } : out.message);
    });
  }
  async assess(specificationInput: unknown): Promise<JsonValue> {
    const spec = AssessmentSpecificationSchema.parse(specificationInput);
    const assessment = record(spec.metadata?.sdd).assessment;
    let classification: ReturnType<AgenticRuntimePorts["policies"]["classifyChange"]>;
    try { classification = this.ports.policies.classifyChange(assessment, spec.affectedPaths); }
    catch (error) { return assessmentErrorAt(error, ["metadata", "sdd", "assessment"]); }
    const unresolved = strings(record(assessment).unresolvedQuestions);
    // Only roles with a pane bound in this session can receive request_specialist; the rest would be refused.
    const availableRoles = await this.boundSpecialistRoles(), bound = new Set(availableRoles.map(item => item.role));
    const suggested = unresolved.length ? ["specifier"] : classification.complexity === "complex" ? ["architect", "planner"] : [];
    return json({ ...classification, clarificationRequired: unresolved.length > 0,
      suggestedRoles: suggested.filter(role => bound.has(role)),
      availableRoles, roleFallbacks: Object.fromEntries(Object.entries(SPECIALIST_FALLBACKS).filter(([role, fallback]) => !bound.has(role) && bound.has(fallback))),
      availableCapabilities: Object.fromEntries(Object.entries(this.ports.roleCapabilities).filter(([role]) => !SPECIALIST_ROLES.includes(role) || bound.has(role))) });
  }

  async proposeWorkflow(runId: string, specificationInput: unknown, definitionInput: unknown, maxIterations = 3): Promise<JsonValue> {
    if (this.quiesced) throw new Error("Runtime is quiesced");
    const draft = SpecificationSchema.parse(specificationInput);
    const proposed = WorkflowDefinitionSchema.parse(definitionInput);
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) throw new Error("Invalid verification limit");
    return this.transaction(async (state, save, core, outbox) => {
      const run = this.run(state, runId); this.live(run);
      if (run.nativeDeliveries?.length) throw new Error("Unknown native delivery must be reconciled before proposing a workflow");
      if (run.definition) {
        if (digest(run.definition.metadata?.proposalFingerprint) === digest(digest([draft, proposed, maxIterations]))) {
          // An identical retry re-attempts a design step that is still pending (e.g. a failed autonomous approval); it never succeeds silently.
          if (run.status === "awaiting_approval" && run.approvalKind === "design" && run.approval && !run.decision) {
            await this.settleDesignApproval(state, save, core, outbox, run, this.designNeedsHuman(draft, run.definition));
            await save();
          }
          return json(run);
        }
        throw new Error("Workflow already proposed; requirement changes need a newly approved delegation");
      }
      if (draft.runId !== runId || draft.specId !== run.delegation.specificationId || draft.sessionId !== run.delegation.sessionId || draft.status !== "draft")
        throw new Error("Specification does not match delegation");
      // Intake criteria cannot be weakened by a planning shortcut.
      for (const criterion of run.delegation.acceptanceCriteria) {
        const accepted = draft.acceptanceCriteria.find(item => item.id === criterion.id);
        if (!accepted || accepted.description !== criterion.description || accepted.verificationMethod !== criterion.verificationMethod || criterion.required && !accepted.required)
          throw new Error("Planning weakens the delegated acceptance criteria");
      }
      if (proposed.qualityGates.length || proposed.tasks.some(task => task.qualityGates.length))
        throw new Error("Configure independent project gates through taskChecks/workflowChecks, not agent-controlled gate definitions");
      if (proposed.tasks.some(task => task.role !== "developer")) throw new Error("Implementation DAG nodes must be Developer tasks; request read-only specialists through requestSpecialist");
      if (proposed.dependencies.some(dep => dep.condition !== "succeeded")) throw new Error("Dependencies must require verified success");
      const classification = this.ports.policies.classifyChange(record(draft.metadata?.sdd).assessment, draft.affectedPaths);
      if (classification.level !== draft.level) throw new Error("SDD level conflicts with assessed policy");
      const definition = WorkflowDefinitionSchema.parse({ ...proposed,
        maxConcurrency: Math.min(proposed.maxConcurrency, this.ports.maxConcurrency ?? 2), tasks: proposed.tasks.map(task => ({ ...task,
        retry: { ...task.retry, maxAttempts: task.retry.maxAttempts + maxIterations - 1 },
        qualityGates: [...task.qualityGates, { gateId: VERIFICATION_GATE, phase: "before_completion", required: true }]
      })), qualityGates: [...proposed.qualityGates, { id: VERIFICATION_GATE, name: "Independent task verification",
        evaluator: "p19-verification", required: true, timeout: { executionTimeoutMs: 300_000, onTimeout: "block" },
        metadata: { boundedVerificationRetry: true } }],
        metadata: { ...proposed.metadata, proposalFingerprint: digest([draft, proposed, maxIterations]) } });
      // Build every dossier before publishing any implementation intent.
      const workflowSpec = await this.reviewSpec({ ...draft, metadata: { ...draft.metadata,
        conditionalTdd: { ...record(draft.metadata?.conditionalTdd), taskId: FINAL_TASK } } });
      const tasks: TaskRecord[] = [];
      for (const task of definition.tasks) {
        const ownedPaths = strings(record(task.metadata).ownedPaths);
        if (!ownedPaths.length || ownedPaths.some(path => !draft.affectedPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))))
          throw new Error("Task ownership must be within approved literal affectedPaths");
        const criteria = draft.acceptanceCriteria.filter(c => task.acceptanceCriteria.includes(c.id));
        if (!criteria.length) throw new Error("Every task must have mapped acceptance criteria");
        const sdd = record(draft.metadata?.sdd);
        const taskSpec = await this.reviewSpec({ ...draft, specId: `${draft.specId}-${digest(task.id).slice(0, 12)}`,
          acceptanceCriteria: criteria, traceabilityTaskIds: [task.id], metadata: { ...draft.metadata,
            sdd: { ...sdd, traceability: criteria.map(c => ({ criterionId: c.id, taskIds: [task.id] })) },
            conditionalTdd: { ...record(task.metadata?.conditionalTdd ?? draft.metadata?.conditionalTdd), taskId: task.id } } });
        if (this.ports.validateTaskCommands) {
          try { this.ports.validateTaskCommands(taskSpec.specification, taskSpec.strategy, ownedPaths); }
          catch (error) {
            const rejected = error instanceof WorkflowProposalRejected ? error : new WorkflowProposalRejected({
              code: "missing_test_mapping", reason: `Task ${task.id} command validation failed: ${redactString(String(error))}`, options: []
            });
            if (this.recordProposalRejection(state, outbox, run, rejected.rejection)) await save();
            throw rejected;
          }
        }
        // P15 checks the precise per-task matrix against its graph projection.
        tasks.push({ taskId: task.id, spec: taskSpec, worktrees: [], outboundIds: [] });
      }
      delete run.lastWorkflowRejection;
      run.definition = definition; run.workflowSpec = workflowSpec; run.tasks = tasks; run.maxIterations = maxIterations;
      // A follow-up run (human changes requested) starts from the parent's delivered head, preset at its creation.
      run.baseRevision ??= textField((await this.ports.policies.git.inspect()).head);
      // A requirement revision gets its own approval even when it plans the same tasks: the superseded id must never come back.
      // Revision 1 keeps the historical id/key so existing journals and decisions still match.
      const requirement = revisionOf(run.delegation), revisionKey = requirement > 1 ? `:r${requirement}` : "";
      const workflowCriteria = digest(workflowSpec.specification.acceptanceCriteria.map(c => c.id));
      run.approval = ApprovalRequestSchema.parse({ schemaVersion: 2,
        approvalId: requirement > 1 ? `design-${digest([runId, definition, requirement])}` : `design-${digest([runId, definition])}`,
        runId, sessionId: run.delegation.sessionId, target: { type: "run" }, revision: draft.version ?? 1,
        generation: 0, status: "pending", requestedBy: "coordinator", requestedAt: this.now(),
        reason: classification.humanApprovalRequired ? "Human design approval required before implementation" : "Specification acceptance",
        // A task spec covering exactly the workflow's criteria repeats the workflow spec, so only narrower task specs are listed.
        evidence: [workflowSpec.specification.artifactRef!, ...tasks.filter(task => digest(task.spec.specification.acceptanceCriteria.map(c => c.id)) !== workflowCriteria)
          .map(task => task.spec.specification.artifactRef!)],
        idempotencyKey: `design:${runId}${revisionKey}`, metadata: { bundleFingerprint: digest([definition, workflowSpec, tasks]) } });
      run.approvalKind = "design"; run.status = "awaiting_approval";
      await save();
      await this.settleDesignApproval(state, save, core, outbox, run, this.designNeedsHuman(draft, definition));
      await save(); return json(run);
    });
  }
  private designNeedsHuman(draft: Specification, definition: WorkflowDefinition): boolean {
    const classification = this.ports.policies.classifyChange(record(draft.metadata?.sdd).assessment, draft.affectedPaths);
    return classification.humanApprovalRequired || !!this.ports.projectApprovalRequired?.("implementation", json(definition));
  }
  /**
   * Human gate, or autonomous acceptance of the pending design. A failed autonomous step is rolled back to the pending state,
   * recorded on the run and blocked for Conversation; an identical retry of the proposal re-attempts it.
   */
  private async settleDesignApproval(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox,
    run: RunRecord, requiresHuman: boolean): Promise<void> {
    if (requiresHuman) {
      this.emit(state, outbox, run, "approval.request", run.approval, `approval:${run.approval!.approvalId}`, "conversation", run.approval!.evidence);
      return;
    }
    const before = structuredClone(run);
    try {
      await this.acceptDesign(run, ApprovalDecisionSchema.parse({ ...this.decisionFields(run.approval!), decision: "approved",
        decidedBy: "coordinator", decidedAt: this.now(), feedbackArtifacts: [], idempotencyKey: `autonomous:${run.approval!.approvalId}` }));
      await core.create(run);
      delete run.error;
      this.progress(state, outbox, run, "Accepted specification and test policy; implementation is ready");
    } catch (error) {
      const reason = redactString(String(error));
      // Restore the pending design: no half-approved dossier or status may be persisted by the failed attempt.
      for (const key of Object.keys(run)) delete (run as unknown as Record<string, unknown>)[key];
      Object.assign(run, before);
      run.error = `Autonomous design approval failed: ${reason}`;
      this.emit(state, outbox, run, "conversation.progress", { kind: "workflow_blocked", runId: run.runId, approvalId: run.approval?.approvalId,
        reason: run.error, options: ["Ask Coordinator to propose the workflow again (re-attempts the autonomous approval)", "Cancel this run"],
        headline: `Workflow blocked: ${run.error}` }, `design-autonomous-failed:${digest(reason)}`, "conversation");
      await save();
      throw error;
    }
  }
  private async reviewSpec(input: unknown): Promise<SpecRecord> {
    const original = SpecificationSchema.innerType().parse(input);
    const strategy = TestStrategySchema.parse(this.ports.policies.strategy.resolve(original));
    const draft = this.ports.policies.specification.createDraft({ ...original, testStrategy: strategy, tddDecision: strategy.tddDecision });
    const specification = SpecificationSchema.parse(await this.ports.policies.specification.submitForReview(draft));
    const request = ApprovalRequestSchema.parse(await this.ports.policies.specification.requestApproval(specification, {
      approvalId: `spec-approval-${digest([specification.specId, specification.artifactRef])}`, requestedBy: "coordinator"
    }));
    return { specification, request, strategy };
  }
  private decisionFields(request: import("@bflow/contracts").ApprovalRequest) {
    return { schemaVersion: 2, approvalId: request.approvalId, runId: request.runId, sessionId: request.sessionId,
      target: request.target, revision: request.revision, generation: request.generation };
  }
  private async acceptDesign(run: RunRecord, decision: ApprovalDecision): Promise<void> {
    const dossiers = [run.workflowSpec!, ...run.tasks.map(task => task.spec)];
    for (const dossier of dossiers) {
      const bound = ApprovalDecisionSchema.parse({ ...decision, ...this.decisionFields(dossier.request),
        idempotencyKey: `bundle:${decision.idempotencyKey}:${dossier.specification.specId}`,
        metadata: { approvedBundleId: decision.approvalId } });
      dossier.specification = SpecificationSchema.parse(await this.ports.policies.specification.approve(dossier.specification, dossier.request, bound));
      dossier.decision = bound;
    }
    await this.ports.policies.specification.assertImplementationReady(run.workflowSpec!.specification,
      run.workflowSpec!.request, run.workflowSpec!.decision, run.definition);
    for (const task of run.tasks) {
      const projected = { ...run.definition!, tasks: run.definition!.tasks.filter(t => t.id === task.taskId), dependencies: [] };
      await this.ports.policies.specification.assertImplementationReady(task.spec.specification, task.spec.request, task.spec.decision, projected);
    }
    run.decision = decision; run.status = "implementing";
  }
  /** P30 T9b: a specialist or Coordinator asks the user through Runtime -> Herdr -> Conversation; the answer resumes only the asker. */
  async requestUserDecision(bindingInput: PaneBinding, role: AgentRole, input: UserDecisionToolInput): Promise<JsonValue> {
    const binding = PaneBindingSchema.parse(bindingInput);
    if (role === "conversation" || binding.role !== role) throw new Error("User decisions are requested by the bound non-Conversation role");
    return this.transaction(async (state, save, _core, outbox) => {
      if (this.quiesced) throw new Error("Runtime is quiesced");
      const run = this.run(state, input.runId); this.live(run);
      if (role !== "coordinator" && !state.outbound.some(out => out.message.run_id === run.runId && ["accepted", "released"].includes(out.status) &&
          out.handle !== undefined && out.handle.target.paneId === binding.paneId && out.handle.target.agentId === binding.agentId &&
          (out.message.type === "task.assignment" ? out.taskId === input.taskId : out.message.type === "delegation.request")))
        throw new Error("Only the Runtime-bound specialist execution for this run may request a user decision");
      const decisions = run.userDecisions ?? (run.userDecisions = {});
      // Revision counts resolved decisions for the task, so a still-pending identical request keeps its approvalId (idempotent).
      const revision = Object.values(decisions).filter(item => item.taskId === input.taskId && item.status !== "pending").length + 1;
      const request = buildUserDecisionRequest({ input, role, sessionId: run.delegation.sessionId, revision,
        generation: run.approval?.generation ?? 0, now: this.now() });
      const existing = decisions[request.approvalId];
      if (existing) {
        if (existing.status !== "pending" || existing.paneId !== binding.paneId) throw new Error("This user decision request was already resolved or belongs to another pane");
        return json(this.userDecisionReceipt(request.approvalId));
      }
      decisions[request.approvalId] = { request, role, agentId: binding.agentId, paneId: binding.paneId, taskId: input.taskId, status: "pending" };
      outbox.enqueue(buildDecisionRequestMessage({ request, correlationId: run.delegation.correlationId,
        sender: { role: "runtime" }, conversation: { role: "conversation" } }), "conversation");
      this.progress(state, outbox, run, `Waiting for a user decision requested by ${role}`);
      await save();
      return json(this.userDecisionReceipt(request.approvalId));
    });
  }
  private userDecisionReceipt(approvalId: string) {
    return { approvalId, status: "pending", instruction: "End your turn; Runtime resumes you with the answer." };
  }
  private async answerUserDecision(state: JournalState, save: () => Promise<void>, outbox: HerdrOutbox, run: RunRecord, decision: ApprovalDecision): Promise<void> {
    const entry = run.userDecisions?.[decision.approvalId];
    if (!entry || entry.status !== "pending") throw new Error("User decision is not pending");
    if (!await this.ports.authorizeHuman(decision)) throw new Error("Human approval is not authenticated");
    const now = this.now();
    if (entry.request.expiresAt !== undefined && Date.parse(now) >= Date.parse(entry.request.expiresAt)) {
      this.expireUserDecision(state, outbox, run, entry); await save(); return;
    }
    // Throws on any approvalId, revision, generation, target, option or timing mismatch; nothing is mutated before this.
    const answer = validateUserDecisionAnswer(entry.request, decision, now);
    entry.status = answer.outcome === "rejected" ? "rejected" : "answered";
    entry.answer = answer;
    this.resumeUserDecisionAsker(state, outbox, run, entry, { kind: "user_decision_answer", approvalId: entry.request.approvalId, outcome: answer.outcome,
      ...(answer.selectedOption !== undefined ? { selectedOption: answer.selectedOption } : {}),
      ...(answer.reason !== undefined ? { reason: answer.reason } : {}) });
    await save();
  }
  /** Conversation must drop the prompt, otherwise the user keeps answering a question Runtime no longer accepts. */
  private notifyUserDecisionClosed(state: JournalState, outbox: HerdrOutbox, run: RunRecord, entry: UserDecisionRecord): void {
    this.emit(state, outbox, run, "conversation.progress", { kind: USER_DECISION_EXPIRED_KIND, approvalId: entry.request.approvalId,
      requestedByRole: entry.role, taskId: entry.taskId, headline: `User decision expired [${entry.request.approvalId}]` },
    `user-decision-expired:${entry.request.approvalId}`, "conversation");
  }
  private expireUserDecision(state: JournalState, outbox: HerdrOutbox, run: RunRecord, entry: UserDecisionRecord): void {
    entry.status = "expired";
    this.notifyUserDecisionClosed(state, outbox, run, entry);
    this.resumeUserDecisionAsker(state, outbox, run, entry, { kind: "user_decision_answer", approvalId: entry.request.approvalId, outcome: "expired" });
  }
  private expireUserDecisions(state: JournalState, outbox: HerdrOutbox): boolean {
    const now = Date.parse(this.now());
    let changed = false;
    for (const run of state.runs) for (const entry of Object.values(run.userDecisions ?? {})) {
      if (entry.status !== "pending") continue;
      if (run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status)) {
        // A terminal run never resumes its askers, but Conversation still drops the now-unanswerable prompt.
        entry.status = run.cancelled ? "cancelled" : "expired"; changed = true;
        this.notifyUserDecisionClosed(state, outbox, run, entry);
      } else if (entry.request.expiresAt !== undefined && now >= Date.parse(entry.request.expiresAt)) {
        this.expireUserDecision(state, outbox, run, entry); changed = true;
      }
    }
    return changed;
  }
  /** Resumes the asking pane through the normal Herdr outbox (lease, pane health and recipient checks apply). */
  private resumeUserDecisionAsker(state: JournalState, outbox: HerdrOutbox, run: RunRecord, entry: UserDecisionRecord, payload: Record<string, unknown>): void {
    const id = `user-decision-answer-${digest([run.runId, entry.request.approvalId, entry.status])}`;
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: run.delegation.correlationId,
      // A Coordinator asker is resumed by Runtime itself: a role message cannot name the same role as sender and recipient.
      causation_id: `decision-${entry.request.approvalId}`, run_id: run.runId, sender: { role: entry.role === "coordinator" ? "runtime" : "coordinator" },
      recipient: { role: entry.role, agent_id: entry.agentId, pane_id: entry.paneId }, type: "task.status",
      payload: json(payload), artifact_references: [], occurred_at: this.now(), idempotency_key: id });
    const parent = entry.role === "developer" ? [...state.outbound].reverse().find(out => out.message.type === "task.assignment" &&
      out.message.run_id === run.runId && out.taskId === entry.taskId && out.status === "accepted" &&
      out.handle?.target.agentId === entry.agentId && out.handle.target.paneId === entry.paneId) : undefined;
    if (parent) outbox.enqueueTaskNotice(message, parent);
    else outbox.enqueue(message, entry.role, entry.taskId, `attempt-${id}`);
  }
  private async applyDecision(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox,
    run: RunRecord, decision: ApprovalDecision): Promise<void> {
    const request = run.approval;
    if (!request || run.status !== "awaiting_approval" || decision.approvalId !== request.approvalId || decision.runId !== request.runId ||
        decision.sessionId !== request.sessionId || decision.revision !== request.revision || decision.generation !== request.generation ||
        digest(decision.target) !== digest(request.target) || Date.parse(decision.decidedAt) < Date.parse(request.requestedAt) ||
        Date.parse(decision.decidedAt) > Date.parse(this.now()) || request.expiresAt && Date.parse(this.now()) >= Date.parse(request.expiresAt))
      throw new Error("Stale or mismatched approval decision");
    if (!await this.ports.authorizeHuman(decision)) throw new Error("Human approval is not authenticated");
    if (decision.decision === "changes_requested" && (run.approvalKind === "design" || run.approvalKind === "delivery") &&
        this.continueAsFollowUp(state, outbox, run, decision)) { await save(); return; }
    if (decision.decision !== "approved") {
      if (run.approvalKind === "task") await core.mutate(run.runId, snapshot => this.ports.engine.applyApproval({
        decision, expectedVersion: snapshot.version, idempotencyKey: decision.idempotencyKey }));
      run.decision = decision; run.status = decision.decision === "rejected" ? "failed" : "escalated";
      run.error = decision.reason ?? "Approval refused";
      this.progress(state, outbox, run, run.error); await save(); return;
    }
    await this.verifyReferences(request.evidence, run.runId);
    if (run.approvalKind === "design") { await this.acceptDesign(run, decision); await save(); await core.create(run); }
    else if (run.approvalKind === "task") {
      await core.mutate(run.runId, snapshot => this.ports.engine.applyApproval({ decision, expectedVersion: snapshot.version,
        idempotencyKey: decision.idempotencyKey }));
      run.decision = decision; run.status = "implementing";
    } else if (run.approvalKind === "delivery") {
      if (!run.workflowCycle || run.workflowCycle.status !== "passed" || !run.integrationKey ||
          (await this.ports.policies.git.getIntegration(run.integrationKey)).status !== "verified") throw new Error("Delivery lacks verified integration");
      const integrated = await this.ports.policies.git.getIntegration(run.integrationKey);
      const current = await captureIntegratedChange({ artifactStore: this.ports.artifactStore, runId: run.runId, taskId: FINAL_TASK,
        worktreePath: integrated.worktreePath, branchName: integrated.branchName, baseRevision: run.baseRevision!, headCommitHash: integrated.expectedHead });
      if (digest(current.patchArtifact.checksum) !== digest(run.workflowChange!.patchArtifact.checksum)) throw new Error("Integration evidence drifted before delivery");
      run.decision = decision; run.status = "completed";
    } else throw new Error("Action execution is not enabled by this runtime");
    this.progress(state, outbox, run, run.status === "completed" ? "Verified changes approved for delivery" : "Design approved; implementation is ready");
  }
  /**
   * A human `changes_requested` at design or delivery approval continues the work as a deterministic follow-up run of the same
   * correlation (`<origin>-r<n>`), built on the parent's delivered head with the feedback appended to the unchanged criteria. Core
   * cannot re-plan an aggregate that already ran, so the parent becomes terminal and superseded. False once the bound is spent.
   */
  private continueAsFollowUp(state: JournalState, outbox: HerdrOutbox, run: RunRecord, decision: ApprovalDecision): boolean {
    const metadata = run.delegation.metadata ?? {};
    const origin = typeof metadata.originRunId === "string" ? metadata.originRunId : run.runId;
    const followUp = (typeof metadata.followUp === "number" ? metadata.followUp : 1) + 1;
    if (followUp > MAX_FOLLOW_UP_RUNS + 1) return false;
    const childId = `${origin}-r${followUp}`;
    if (state.runs.some(item => item.runId === childId)) throw new Error(`Follow-up run ${childId} already exists`);
    const approvalKind = run.approvalKind!, feedback = redactString(decision.reason ?? "Changes requested").slice(0, 2000);
    const base = approvalKind === "delivery" ? run.workflowChange?.headCommitHash : run.baseRevision;
    if (approvalKind === "delivery" && !base) return false;
    const delegation = DelegationRequestSchema.parse({ ...run.delegation, runId: childId, delegationId: `delegation-${digest([childId])}`,
      messageId: `follow-up-${digest([childId, decision.approvalId])}`, idempotencyKey: `follow-up:${childId}`, requestedAt: this.now(),
      objective: `${run.delegation.objective}

Human feedback on ${approvalKind} approval (${decision.approvalId}): ${feedback}`.slice(0, 8000),
      inputArtifacts: [...run.delegation.inputArtifacts, ...decision.feedbackArtifacts],
      metadata: { ...metadata, originRunId: origin, parentRunId: run.runId, followUp, supersededApprovalId: decision.approvalId, revision: revisionOf(run.delegation) } });
    state.runs.push({ runId: childId, delegation, status: "planning", tasks: [], coreCreated: false, cancelled: false,
      maxIterations: run.maxIterations, ...(base ? { baseRevision: base } : {}) });
    run.decision = decision; run.status = "escalated"; run.error = `Changes requested; continued as ${childId}`;
    run.supersededBy = childId; delete run.pendingAction;
    const child = state.runs.at(-1)!;
    const wakeId = `p19-wake-${digest([childId, "changes_requested", decision.approvalId])}`;
    outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: wakeId, correlation_id: delegation.correlationId, causation_id: decision.approvalId,
      run_id: childId, sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status",
      payload: { kind: "changes_requested", runId: run.runId, followUpRunId: childId, approvalKind, approvalId: decision.approvalId, feedback,
        feedbackArtifacts: json(decision.feedbackArtifacts), sdlcStatus: child.status,
        next: `Re-plan run ${childId} with this feedback through propose_workflow (spec runId ${childId}, same specificationId and acceptance criteria); ` +
          (approvalKind === "delivery" ? "its tasks start from the delivered change." : "the original design was not implemented.") },
      artifact_references: [], occurred_at: this.now(), idempotency_key: wakeId }), "coordinator");
    this.emit(state, outbox, run, "conversation.progress", { kind: "workflow_continued", runId: run.runId, followUpRunId: childId, approvalKind, feedback,
      headline: `Đã ghi nhận yêu cầu chỉnh sửa; workflow tiếp tục với run ${childId}`, sdlcStatus: child.status }, `follow-up:${childId}`, "conversation");
    return true;
  }
  private async verifyReferences(references: ArtifactReference[], runId: string): Promise<void> {
    const { createHash } = await import("node:crypto");
    for (const input of references) {
      const reference = ArtifactReferenceSchema.parse(input);
      if (reference.runId !== runId) throw new Error("Foreign artifact");
      const resolved = unwrap(await this.ports.artifactStore.resolve(reference.artifactId));
      if (!resolved || digest(resolved) !== digest(reference)) throw new Error("Untrusted artifact reference");
      const hash = createHash(reference.checksum.algorithm); let size = 0;
      for await (const chunk of this.ports.artifactStore.get(reference)) { const bytes = Buffer.from(unwrap(chunk)); size += bytes.length; hash.update(bytes); }
      if (hash.digest("hex") !== reference.checksum.value || reference.sizeBytes !== undefined && reference.sizeBytes !== size)
        throw new Error("Artifact integrity mismatch");
    }
  }
  private async bind(state: JournalState, core: CoreSession, out: Outbound, handle: AgentExecutionHandle): Promise<void> {
    if (out.message.type !== "task.assignment" || isConflictResolverAssignment(out.message)) return; // a resolver is not a Core task
    const run = this.run(state, handle.runId);
    if (!run.coreCreated) throw new Error("Assignment lacks Core run");
    const snapshot = await core.snapshot(run.runId);
    const task = snapshot.tasks.find(item => item.taskId === handle.taskId);
    if (!task || task.attemptId !== handle.attemptId) {
      const recorded = run.tasks.find(item => item.taskId === handle.taskId)?.result;
      if (recorded?.requestId === handle.requestId && ["failed", "timed_out"].includes(recorded.status)) return;
      throw new Error("Stale task binding");
    }
    if (task.agentExecution) {
      if (digest(task.agentExecution) !== digest(handle)) throw new Error("Conflicting execution binding");
      return;
    }
    await core.mutate(run.runId, current => this.ports.engine.bindAgentExecution({
      runId: run.runId, taskId: task.taskId, expectedVersion: current.version, attempt: task.attempt,
      handle, occurredAt: this.now(), idempotencyKey: `bind:${handle.requestId}`
    }));
  }
  private async submit(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox,
    run: RunRecord, message: RoleMessage): Promise<void> {
    const result = AgentResultSchema.parse(message.payload);
    const task = run.tasks.find(item => item.taskId === result.taskId);
    const out = state.outbound.find(item => item.message.message_id === message.causation_id);
    if (!task || !out?.handle || out.message.type !== "task.assignment" || out.status !== "accepted" ||
        message.sender.role !== "developer" || message.sender.agent_id !== out.handle.target.agentId ||
        message.sender.pane_id !== out.handle.target.paneId || result.runId !== run.runId ||
        result.executionId !== out.handle.executionId || result.requestId !== out.handle.requestId || result.attemptId !== out.handle.attemptId ||
        !await this.ports.authenticateResult(result, out.handle, message)) throw new Error("Uncorrelated or unauthenticated implementation result");
    const currentTask = (await core.snapshot(run.runId)).tasks.find(item => item.taskId === result.taskId);
    const correlation = currentTask?.bindingVerification?.receipt.correlation ?? out.handle.correlation;
    if (!correlation.verified || result.verification.status !== "verified" || !result.verification.correlation.verified ||
        digest(result.verification.correlation) !== digest(correlation))
      throw new Error("Transport handle lacks verified remote correlation; authenticated receipt integration is required");
    if (task.result?.attemptId === result.attemptId) {
      if (digest(task.result) !== digest(result)) throw new Error("Conflicting implementation receipt");
      const snapshot = await core.snapshot(run.runId);
      if (snapshot.tasks.find(item => item.taskId === result.taskId)?.status !== "running") return;
    }
    if (result.artifactProposals.length) throw new Error("Materialized proposals must be ingested by the trusted host before submission");
    const snapshot = await core.snapshot(run.runId);
    if (snapshot.tasks.find(item => item.taskId === result.taskId)?.attemptId !== result.attemptId) throw new Error("Stale implementation attempt");
    await outbox.renew(out);
    task.result = result;
    await save();
    await core.mutate(run.runId, current => this.ports.engine.recordAgentResult({ runId: run.runId,
      taskId: task.taskId, expectedVersion: current.version, result, occurredAt: this.now(), idempotencyKey: `result:${result.requestId}` }));
    let evidenceComplete = false;
    try { this.ports.policies.assertEvidenceComplete(task.spec.strategy); evidenceComplete = true; } catch { /* Independent evidence is still required. */ }
    if (this.ports.automaticAlternativeEvidence && result.status === "succeeded" && !evidenceComplete && task.spec.strategy.tddDecision.mode !== "required") {
      const requestId = `alternative-${result.requestId}`;
      outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: requestId,
        correlation_id: run.delegation.correlationId, causation_id: message.message_id, run_id: run.runId,
        sender: { role: "coordinator" }, recipient: { role: "qa" }, type: "verification.requested",
        payload: json({ kind: "conditional_evidence", runId: run.runId, taskId: task.taskId,
          instruction: "Inspect the exact committed diff with inspect_alternative_verification, evaluate the accepted criteria independently, then record_alternative_verification. Do not invent evidence.",
          specification: task.spec.specification, strategy: task.spec.strategy }), artifact_references: [],
        occurred_at: this.now(), idempotency_key: requestId }), "qa", `evidence-${task.taskId}`, `evidence-${result.attemptId}`, ["testing"]);
    }
    if (result.status === "blocked") { run.error = result.blockage?.message ?? "Developer is blocked"; this.progress(state, outbox, run, run.error); }
    if (["failed", "timed_out"].includes(result.status)) this.progress(state, outbox, run, result.error?.message ?? "Implementation failed");
    await save();
  }
  private async dispatch(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox, run: RunRecord): Promise<void> {
    const before = await core.snapshot(run.runId);
    if (["succeeded", "failed", "cancelled", "cancelling"].includes(before.status)) return;
    await core.mutate(run.runId, snapshot => this.ports.engine.advance({ runId: run.runId, expectedVersion: snapshot.version,
      occurredAt: this.now(), idempotencyKey: `advance:${run.runId}:${snapshot.version}` }));
    const snapshot = await core.snapshot(run.runId);
    for (const taskState of snapshot.tasks.filter(task => task.status === "running" && !task.agentExecution)) {
      const task = run.tasks.find(item => item.taskId === taskState.taskId)!;
      const definition = run.definition!.tasks.find(item => item.id === task.taskId)!;
      const id = `assignment:${run.runId}:${taskState.attemptId}`;
      if (state.outbound.some(out => out.message.idempotency_key === id)) continue;
      const agentName = `dev-${digest([run.runId, taskState.attemptId]).slice(0, 20)}`;
      const prior = task.changeSet;
      const tree = await this.ports.policies.git.prepareTask({ runId: run.runId, taskId: task.taskId,
        attemptId: taskState.attemptId!, baseRevision: prior?.headCommitHash ?? run.baseRevision!,
        ownedPaths: strings(record(definition.metadata).ownedPaths),
        forbiddenPaths: definition.metadata?.forbiddenPaths ? strings(definition.metadata.forbiddenPaths) : [], developerId: agentName });
      if (!task.worktrees.some(item => item.key === tree.key)) task.worktrees.push(tree);
      await save();
      const allocation = await this.ports.panes.allocateDeveloper({
        taskId: `${run.runId}-${task.taskId}`, runId: run.runId, worktreePath: tree.worktreePath,
        branchName: tree.branchName, agentName
      });
      if (!allocation.ok) {
        run.error = `Developer allocation pending for ${task.taskId}: ${allocation.error.message}`;
        if (allocation.error.code !== "conflict" || !allocation.error.retryable) this.pauseDeveloperAllocation(run, task.taskId, run.error);
        this.progress(state, outbox, run, run.error); await save(); continue;
      }
      const pane = PaneBindingSchema.parse(allocation.value);
      if (pane.worktreePath !== tree.worktreePath || pane.agentId !== agentName) throw new Error("Developer allocation mismatch");
      const requiredCapabilities = definition.metadata?.requiredCapabilities ? strings(definition.metadata.requiredCapabilities) : ["implementation"];
      const messageId = `message-${digest(id)}`;
      const message = RoleMessageSchema.parse({ schema_version: 2, message_id: messageId,
        correlation_id: run.delegation.correlationId, causation_id: run.delegation.messageId, run_id: run.runId,
        sender: { role: "coordinator" }, recipient: { role: "developer", agent_id: pane.agentId, pane_id: pane.paneId },
        type: "task.assignment", payload: { task: definition, specification: task.spec.specification,
          testStrategy: task.spec.strategy, worktree: tree, findings: task.cycle?.history.at(-1)?.findings ?? [],
          implementationAuthorizationRequired: task.spec.strategy.tddDecision.mode === "required",
          instruction: "Use Runtime authorize_implementation after independent Red evidence, then Green and Refactor. Submit only via Herdr. Never infer success from a terminal status." },
        artifact_references: [task.spec.specification.artifactRef!], occurred_at: this.now(), idempotency_key: id });
      outbox.enqueue(message, pane.bindingId, task.taskId, taskState.attemptId!, requiredCapabilities);
      task.outboundIds.push(messageId); delete task.result; task.writerReleased = false;
      await save();
    }
  }
  async authorizeImplementation(runId: string, taskId: string): Promise<JsonValue> {
    return this.transaction(async state => {
      const run = this.run(state, runId); this.live(run);
      const task = run.tasks.find(item => item.taskId === taskId);
      if (!task || task.spec.specification.status !== "approved") throw new Error("No accepted task specification");
      this.ports.policies.assertReadyToImplement(task.spec.strategy);
      return json({ authorized: true, decisionId: task.spec.strategy.tddDecision.decisionId });
    });
  }
  /** Trusted local tool guard. Keep current ownership and lease checks adjacent
   * to file/commit operations; model arguments never supply the authority. */
  async withDeveloperWorkspace<T>(bindingInput: PaneBinding, runId: string, taskId: string,
    use: (task: TaskRecord, definition: TaskDefinition) => Promise<T>): Promise<T> {
    const binding = PaneBindingSchema.parse(bindingInput);
    return this.transaction(async (state, _save, core, outbox) => {
      if (this.quiesced || binding.role !== "developer") throw new Error("Developer writes are quiesced or unauthorized");
      const run = this.run(state, runId); this.live(run);
      assertNoPendingPaneDecision(run, binding);
      const task = run.tasks.find(item => item.taskId === taskId), definition = run.definition?.tasks.find(item => item.id === taskId);
      const current = (await core.snapshot(runId)).tasks.find(item => item.taskId === taskId);
      const out = state.outbound.find(item => item.handle?.requestId === current?.agentExecution?.requestId);
      if (!task || !definition || task.spec.specification.status !== "approved" || current?.status !== "running" ||
          !out?.handle || out.status !== "accepted" || out.handle.target.agentId !== binding.agentId || out.handle.target.paneId !== binding.paneId ||
          out.handle.target.worktreePath !== binding.worktreePath || digest(out.handle.target.session) !== digest(binding.session) ||
          task.worktrees.at(-1)?.worktreePath !== binding.worktreePath)
        throw new Error("No current Developer assignment owns this task workspace");
      await outbox.renew(out);
      return use(task, definition);
    });
  }
  /** A Developer requests a policy measurement, never a direct specialist dispatch. */
  async requestPhaseVerification(binding: PaneBinding, runId: string, taskId: string, phase: string, sourceRevision: string): Promise<JsonValue> {
    binding = PaneBindingSchema.parse(binding);
    if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw new Error("Verification needs a committed source revision");
    return this.transaction(async (state, save, core, outbox) => {
      if (this.quiesced || binding.role !== "developer") throw new Error("Verification intake is quiesced or unauthorized");
      const run = this.run(state, runId); this.live(run);
      const task = run.tasks.find(item => item.taskId === taskId), current = (await core.snapshot(runId)).tasks.find(item => item.taskId === taskId);
      const assignment = state.outbound.find(item => item.handle?.requestId === current?.agentExecution?.requestId);
      if (!task || current?.status !== "running" || assignment?.status !== "accepted" || assignment.handle?.target.agentId !== binding.agentId ||
          assignment.handle.target.paneId !== binding.paneId || assignment.handle.target.worktreePath !== binding.worktreePath ||
          digest(assignment.handle.target.session) !== digest(binding.session))
        throw new Error("Verification request does not own the current Developer assignment");
      if (!task.spec.strategy.targetCommands.length) throw new Error("This task uses independent manual evidence after submission, not automated phase requests");
      const phaseRequests = state.outbound.filter(item => item.message.run_id === runId && item.message.type === "verification.requested" &&
        record(item.message.payload).kind === "conditional_evidence" && record(item.message.payload).taskId === taskId &&
        record(item.message.payload).implementationAttemptId === current.attemptId && record(item.message.payload).phase === phase);
      const retired = phaseRequests.filter(item => item.phaseRetirement);
      const lastPhase = phaseRequests.at(-1);
      if (lastPhase?.phaseRetirement && !lastPhase.phaseRetirement.resumeAuthorizedBy) throw new Error("Retired phase requires authenticated Conversation resume");
      if (lastPhase?.phaseRetirement && record(lastPhase.message.payload).sourceRevision !== sourceRevision) throw new Error("Retired phase continuation must retain its exact revision");
      await outbox.renew(assignment);
      const rawReceipts = task.spec.strategy.metadata?.tddEvidence ?? [];
      if (!Array.isArray(rawReceipts)) throw new Error("Corrupt policy measurement history");
      const receipts = rawReceipts.map(item => VerificationResultSchema.parse(item));
      const recorded = receipts.find(item => record(item.metadata?.conditionalTdd).phase === phase);
      if (recorded) return json({ alreadyRecorded: true, verificationId: recorded.verificationId });
      const expected = task.spec.strategy.tddDecision.mode === "required" ? ["red", "green", "refactor"][receipts.length] : "verification";
      if (phase !== expected) throw new Error(`Policy requires ${expected ?? "no additional"} measurement, not ${phase}`);
      const previous = state.outbound.find(item => item.message.type === "verification.requested" && item.message.run_id === runId &&
        record(item.message.payload).kind === "conditional_evidence" && record(item.message.payload).taskId === taskId &&
        record(item.message.payload).phase === phase && record(item.message.payload).implementationAttemptId === current.attemptId &&
        !item.phaseRetirement && !item.error?.startsWith("policy_phase_failed:"));
      if (previous) {
        if (record(previous.message.payload).sourceRevision !== sourceRevision) throw new Error("Prior phase measurement is unresolved on another revision; reconcile it before retrying");
        return json({ queued: true, messageId: previous.message.message_id, deliveryStatus: previous.status });
      }
      const failedHere = state.outbound.filter(item => item.message.run_id === runId && item.error?.startsWith("policy_phase_failed:") &&
          record(item.message.payload).taskId === taskId && record(item.message.payload).phase === phase &&
          record(item.message.payload).implementationAttemptId === current.attemptId && record(item.message.payload).sourceRevision === sourceRevision);
      if (failedHere.some(item => item.phaseFailure?.retryAuthorized !== true))
        throw new Error("This revision already failed the phase; commit a repair before requesting another measurement");
      // A resumed infrastructure failure re-measures the same revision under a new request identity.
      const id = `phase-${digest(retired.length ? [runId, taskId, current.attemptId, phase, sourceRevision, failedHere.length, "retired", retired.length] : failedHere.length ? [runId, taskId, current.attemptId, phase, sourceRevision, failedHere.length] : [runId, taskId, current.attemptId, phase, sourceRevision])}`;
      outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: run.delegation.correlationId,
        causation_id: assignment.message.message_id, run_id: runId, sender: { role: "coordinator" }, recipient: { role: "qa" },
        type: "verification.requested", artifact_references: [], occurred_at: this.now(), idempotency_key: id,
        payload: json({ kind: "conditional_evidence", phase, runId, taskId, sourceRevision, implementationAttemptId: current.attemptId,
          specification: task.spec.specification, strategy: task.spec.strategy,
          instruction: "Run record_behavioral_verification for this exact phase and revision using the owner-configured independent runner. Never supply measured output yourself." })
      }), "qa", `phase-${taskId}-${phase}`, `phase-${current.attemptId}-${phase}`, ["testing"]);
      await save(); return json({ queued: true, messageId: id });
    });
  }
  private phaseNotice(state: JournalState, outbox: HerdrOutbox, run: RunRecord, task: TaskRecord,
    phase: string, status: string, summary: string, outcomeId: string): void {
    const parent = [...state.outbound].reverse().find(item => item.message.type === "task.assignment" &&
      item.message.run_id === run.runId && item.taskId === task.taskId && item.status === "accepted" && item.handle);
    if (!parent?.handle) throw new Error("Policy phase has no active Developer assignment for its outcome");
    const id = `phase-notice-${digest([run.runId, task.taskId, phase, outcomeId])}`;
    outbox.enqueueTaskNotice(RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: run.delegation.correlationId,
      causation_id: parent.message.message_id, run_id: run.runId, sender: { role: "coordinator" },
      recipient: { role: "developer", agent_id: parent.handle.target.agentId, pane_id: parent.handle.target.paneId }, type: "task.status",
      payload: json({ kind: "policy_phase_outcome", runId: run.runId, taskId: task.taskId, phase, status, summary, outcomeId }),
      artifact_references: [], occurred_at: this.now(), idempotency_key: id }), parent);
  }
  private phaseFailureReply(run: RunRecord, request: Outbound, replay = false): JsonValue {
    const payload = record(request.message.payload), failure = request.phaseFailure!;
    return json({ status: run.status, maxIterations: run.maxIterations, ...(replay ? { alreadyRecorded: true } : {}),
      phaseRecorded: false, implementationAuthorized: false,
      outcome: { requestId: request.message.message_id, taskId: payload.taskId, phase: payload.phase,
        sourceRevision: payload.sourceRevision, summary: failure.summary, repairable: failure.repairable,
        evidenceArtifacts: request.phaseFailureEvidence ? [request.phaseFailureEvidence] : [] },
      next: failure.repairable
        ? "Runtime stored the rejected phase outcome and controls bounded Developer repair. This is not missing execution output, valid Red or implementation authorization. Do not report a new missing-evidence blocker; reconcile this exact request if needed."
        : "Runtime stored an infrastructure blocker, not accepted policy evidence. Reconcile this exact outcome before an explicit resume; never resend uncertain work." });
  }
  /** Actual host measurements can fail without becoming successful P16 evidence.
   * Preserve the request outcome, bound repairs, and resume only its owning task. */
  async recordPhaseFailure(bindingInput: PaneBinding, requestId: string, summary: string, repairable: boolean, evidence?: ArtifactReference): Promise<JsonValue> {
    const binding = PaneBindingSchema.parse(bindingInput);
    return this.transaction(async (state, save, _core, outbox) => {
      const request = state.outbound.find(item => item.message.message_id === requestId);
      if (!request?.handle || request.phaseRetirement || request.message.type !== "verification.requested" || !["accepted", "released"].includes(request.status) ||
          request.handle.target.paneId !== binding.paneId || request.handle.target.agentId !== binding.agentId ||
          digest(request.handle.target.session) !== digest(binding.session) || record(request.message.payload).kind !== "conditional_evidence")
        throw new Error("Phase failure does not belong to this independent verifier");
      const run = this.run(state, request.message.run_id!);
      if (request.phaseFailure) {
        if (request.phaseFailure.summary !== summary || request.phaseFailure.repairable !== repairable || digest(request.phaseFailureEvidence) !== digest(evidence))
          throw new Error("Conflicting immutable policy failure outcome");
        return this.phaseFailureReply(run, request, true);
      }
      this.live(run);
      if (request.status !== "accepted") throw new Error("Verifier released without a saved phase failure; reconcile its original request");
      if (evidence) { await this.verifyReferences([evidence], run.runId); request.phaseFailureEvidence = ArtifactReferenceSchema.parse(evidence); }
      await outbox.renew(request);
      request.phaseFailure = { summary: textField(summary), repairable, applied: false };
      request.error = `policy_phase_failed:${summary}`;
      await save(); // preserve the measured outcome before releasing its lease
      await this.recoverPhaseFailures(state, save, outbox);
      return this.phaseFailureReply(run, request);
    });
  }
  private pauseDeveloperAllocation(run: RunRecord, taskId: string, reason: string): void {
    const sourceMessageId = `developer-allocation-${digest([run.runId, taskId, reason])}`;
    const prior = run.pendingAction?.sourceMessageId === sourceMessageId ? run.pendingAction : undefined;
    run.status = "escalated";
    run.pendingAction = { actionId: `next-${digest([run.runId, sourceMessageId])}`, kind: "resume_coordinator", owner: "coordinator",
      reason: reason.slice(0, 2000), sourceMessageId, createdAt: prior?.createdAt ?? this.now(), state: "pending", previousStatus: "implementing",
      ...inheritedAutoResume(run),
      recovery: "manual" };
  }
  private async recoverPhaseFailures(state: JournalState, save: () => Promise<void>, outbox: HerdrOutbox): Promise<void> {
    for (const request of state.outbound.filter(item => item.phaseFailure && !item.phaseFailure.applied)) {
      const { summary, repairable } = request.phaseFailure!;
      const run = this.run(state, request.message.run_id!), payload = record(request.message.payload);
      const task = run.tasks.find(item => item.taskId === payload.taskId);
      if (!task) throw new Error("Policy failure task is missing");
      await outbox.release(request);
      const failures = state.outbound.filter(item => item.message.run_id === run.runId && item.error?.startsWith("policy_phase_failed:") &&
        record(item.message.payload).taskId === task.taskId && record(item.message.payload).phase === payload.phase &&
        record(item.message.payload).implementationAttemptId === payload.implementationAttemptId).length;
      if (run.cancelled || ["completed", "failed", "cancelled", "escalated"].includes(run.status)) {
        // Retain the receipt while preserving a newer terminal decision.
      } else if (!repairable || failures >= run.maxIterations) {
        const previousStatus = run.status;
        run.status = "escalated"; run.error = !repairable ? `Policy measurement blocked: ${summary}` : `Policy phase repair limit exhausted: ${summary}`;
        // An infrastructure failure (runner, sandbox, build) is not a code defect: once fixed, an explicit resume re-measures the
        // same revision. An exhausted repair limit stays a human stop, so the bound is never widened.
        if (!repairable) run.pendingAction = { actionId: `next-${digest([run.runId, request.message.message_id])}`, kind: "resume_coordinator",
          owner: "coordinator", reason: run.error.slice(0, 2000), sourceMessageId: request.message.message_id, createdAt: this.now(), state: "pending",
          previousStatus, ...inheritedManualResume(run), recovery: "manual" };
        this.progress(state, outbox, run, run.error);
      } else this.phaseNotice(state, outbox, run, task, textField(payload.phase), "failed", summary, request.message.message_id);
      request.phaseFailure!.applied = true;
      await save();
    }
    // Older resumes authorized the retry but woke only Coordinator, which cannot invoke
    // Developer-only phase tools. Recover the missing handoff from that durable authority.
    if (this.quiesced) return;
    for (const request of state.outbound.filter(item => item.phaseFailure?.applied &&
      item.phaseFailure.repairable === false && item.phaseFailure.retryAuthorized === true)) {
      const run = this.run(state, request.message.run_id!), payload = record(request.message.payload);
      if (run.cancelled || run.status !== "implementing" || run.nativeDeliveries?.length ||
          run.approval !== undefined && run.decision?.approvalId !== run.approval.approvalId ||
          state.outbound.some(item => item.message.run_id === run.runId && ["sending", "unknown_delivery"].includes(item.status)) ||
          Object.values(run.userDecisions ?? {}).some(item => item.status === "pending")) continue;
      const task = run.tasks.find(item => item.taskId === payload.taskId);
      if (!task || task.writerReleased) continue;
      const rawReceipts = task.spec.strategy.metadata?.tddEvidence ?? [];
      if (!Array.isArray(rawReceipts)) throw new Error("Corrupt policy measurement history");
      const receipts = rawReceipts.map(item => VerificationResultSchema.parse(item));
      const phase = textField(payload.phase);
      const expected = task.spec.strategy.tddDecision.mode === "required" ? ["red", "green", "refactor"][receipts.length] : receipts.length === 0 ? "verification" : undefined;
      if (phase !== expected) continue;
      const parent = state.outbound.find(item => item.message.run_id === run.runId && item.message.type === "task.assignment" &&
        item.taskId === task.taskId && item.status === "accepted" && item.handle?.attemptId === payload.implementationAttemptId);
      if (!parent?.handle) continue;
      const id = `phase-notice-${digest([run.runId, task.taskId, phase, request.message.message_id])}`;
      const notice = state.outbound.find(item => item.message.message_id === id);
      if (notice && (notice.status === "sending" || notice.status === "unknown_delivery")) continue;
      const reviveUnsent = notice?.status === "cancelled" && !notice.request && !notice.handle && notice.error?.includes("parent lease is expired");
      if (notice && !reviveUnsent && !parent.leaseReacquisition && parent.lease && Date.parse(parent.lease.expiresAt) > Date.parse(this.now())) continue;
      if (state.outbound.some(item => item.message.run_id === run.runId &&
          item.message.type === "verification.requested" && record(item.message.payload).taskId === task.taskId &&
          record(item.message.payload).phase === phase && !item.phaseFailure && !item.phaseRetirement && item.status !== "cancelled")) continue;
      try { await outbox.recoverTaskLease(parent, request); }
      catch (error) {
        parent.error = `Task lease continuation blocked: ${String(error)}`;
        await save(); continue;
      }
      if (notice) {
        if (reviveUnsent) {
          notice.status = "queued"; delete notice.error; await save();
        }
        continue; // Keep the original control message and any submission handle; never re-send an uncertain notice.
      }
      this.phaseNotice(state, outbox, run, task, phase, "retry",
        `Explicit resume authorized a new independent measurement of ${phase} at ${textField(payload.sourceRevision)}. ` +
        "Call request_verification for this phase again; this notice grants no Red evidence or implementation authority.", request.message.message_id);
      await save();
    }
    await this.recoverPolicyPhaseRetirements(state, save, outbox);
  }
  private verificationPlan(state: JournalState, run: RunRecord, task?: TaskRecord): VerificationPlan {
    if (task?.verificationPlan) return task.verificationPlan;
    const dossier = task?.spec ?? run.workflowSpec!;
    const plan = this.ports.policies.createVerificationPlan({ runId: run.runId, taskId: task?.taskId ?? FINAL_TASK,
      scope: task ? "task" : "workflow", specification: dossier.specification, strategy: dossier.strategy,
      checks: ([...(task ? this.ports.taskChecks : this.ports.workflowChecks), ...(this.ports.behavioralChecks?.(dossier.specification, dossier.strategy, task?.worktrees.at(-1)?.baseCommitHash ?? run.baseRevision) ?? [])]).flatMap(check => {
        if (check.metadata?.bindAcceptedCriteria !== true) return [check];
        const config = record(check.configuration);
        // A method-bound check (automatic runner) takes its names from the accepted mappings of that method, and does not apply without them.
        const methodBound = check.metadata?.bindMethodTestNames === true;
        if (methodBound && !dossier.strategy.targetCommands.includes(String(config.command))) return [];
        const names = methodBound && check.metadata?.boundRunnerIdentities !== true ? dossier.strategy.criterionMappings.filter(mapping => dossier.specification.acceptanceCriteria.some(criterion =>
          criterion.id === mapping.criterionId && criterion.required !== false && criterion.status !== "waived" && criterion.verificationMethod === config.method))
          .flatMap(mapping => mapping.testNames) : config.testNames;
        const criteria = dossier.specification.acceptanceCriteria.filter(criterion => criterion.required !== false && criterion.status !== "waived" &&
          (config.kind === "review" || criterion.verificationMethod === config.method && dossier.strategy.criterionMappings.some(mapping =>
            mapping.criterionId === criterion.id && mapping.testNames.length && mapping.testNames.every(name => Array.isArray(names) && names.includes(name)))));
        if (methodBound && criteria.length === 0) return [];
        return [{ ...check, configuration: json({ ...config, criterionIds: criteria.map(criterion => criterion.id),
          testNames: config.kind === "review" ? dossier.strategy.criterionMappings.filter(mapping => criteria.some(criterion => criterion.id === mapping.criterionId)).flatMap(mapping => mapping.testNames) : names }) }];
      }),
      implementerIds: run.tasks.flatMap(item => item.outboundIds).map(id => state.outbound.find(out => out.message.message_id === id)?.handle?.target.agentId).filter((id): id is string => !!id),
      maxIterations: run.maxIterations });
    if (task) task.verificationPlan = plan;
    return plan;
  }
  /** A bounded scheduler step; performs independent verification outside the journal lock. */
  async tick(): Promise<JsonValue> {
    await this.initialize();
    if (this.quiesced) return this.inspect();
    await this.transaction(async (state, save, core, outbox) => { await this.drainCancellationControls(state, save, core, outbox); });
    await this.recoverMissingCoordinatorWakeups();
    await this.transaction(async (state, save, _core, outbox) => { if (this.expireUserDecisions(state, outbox)) await save(); });
    const pending = await this.transaction(async state => structuredClone(state.pendingVerifications));
    for (const item of pending) {
      if (item.stuck) continue; // waits for an explicit retry_verification
      try { await this.finishVerification(this.parseJob(item.job), this.parseOutcome(item.outcome)); }
      catch (error) { await this.recordVerificationFailure(item, error); }
    }
    const jobs = await this.transaction(async (state, save, core, outbox) => {
      const jobs: VerificationJob[] = [];
        for (const run of state.runs) {
          if (this.quiesced) break;
          if (run.nativeDeliveries?.length) continue;
          if (run.cancelled || ["completed", "failed", "cancelled", "escalated", "awaiting_approval", "intake", "clarifying", "specifying", "planning"].includes(run.status)) continue;
          // One run's failure is recorded on that run; the other runs and the outbox flush below still proceed.
          try {
            if (!run.coreCreated) await core.create(run);
            let awaitingWriterStop = false;
            for (const task of run.tasks.filter(item => item.result && ["failed", "timed_out"].includes(item.result.status))) {
              const prior = state.outbound.find(out => out.handle?.requestId === task.result!.requestId);
              if (prior?.status === "accepted") {
                const health = unwrap(await this.ports.panes.inspectRoleHealth(prior.selector));
                if (!health.readyForPrompt || !health.occupantMatches) { awaitingWriterStop = true; continue; }
                unwrap(await this.ports.panes.releaseDeveloper({ taskId: `${run.runId}-${task.taskId}`, closePane: false, removeWorktree: false }));
                await outbox.release(prior);
              }
            }
            if (!awaitingWriterStop) await this.dispatch(state, save, core, outbox, run);
            for (const task of run.tasks) {
              if (!task.result || task.result.status !== "succeeded" || task.verificationPending) continue;
              const current = (await core.snapshot(run.runId)).tasks.find(item => item.taskId === task.taskId)!;
              if (current.status !== "waiting") continue;
              const out = state.outbound.find(item => item.handle?.requestId === task.result!.requestId)!;
              const health = unwrap(await this.ports.panes.inspectRoleHealth(out.selector));
              if (!health.readyForPrompt || !health.occupantMatches) continue; // writer still active
              try { this.ports.policies.assertEvidenceComplete(task.spec.strategy); }
              catch (error) {
                run.error = `Independent policy evidence required for ${task.taskId}: ${String(error)}`;
                this.progress(state, outbox, run, run.error); continue;
              }
              delete run.error;
              if (!task.writerReleased) {
                unwrap(await this.ports.panes.releaseDeveloper({ taskId: `${run.runId}-${task.taskId}`, closePane: false, removeWorktree: false }));
                task.writerReleased = true; await save();
              }
              const change = GitChangeSetSchema.parse(await this.ports.policies.git.collectTask(task.worktrees.at(-1)!.key));
              if (change.runId !== run.runId || change.taskId !== task.taskId || change.attemptId !== current.attemptId) throw new Error("Git task submission mismatch");
              task.changeSet = change;
              const plan = this.verificationPlan(state, run, task);
              task.cycle ??= VerificationCycleSchema.parse(this.ports.policies.verification.start(plan, `cycle-${digest([run.runId, task.taskId])}`));
              task.verificationPending = true; run.status = "verifying";
              jobs.push({ runId: run.runId, taskId: task.taskId, plan, cycle: task.cycle, change,
                options: task.cycle.history.length ? { repair: { taskId: task.taskId, role: "developer", changeSetId: change.changeSetId,
                  summary: "Developer repaired the independent verification findings" } } : {} });
              await save();
            }
            const snapshot = await core.snapshot(run.runId);
            if (snapshot.status === "blocked" && snapshot.tasks.some(task => ["failed", "blocked"].includes(task.status))) {
              run.status = "escalated"; run.error = "Task blocked or implementation retry policy exhausted";
              this.progress(state, outbox, run, run.error);
            }
            if (snapshot.status === "failed") { run.status = "failed"; this.progress(state, outbox, run, "Implementation retry policy exhausted"); }
            if (snapshot.tasks.every(task => task.status === "succeeded") && run.tasks.every(task => task.cycle?.status === "passed")) {
              await this.integrate(state, save, outbox, run);
              if (run.status === "verifying" && run.workflowChange && !run.workflowVerificationPending) {
                const plan = this.verificationPlan(state, run);
                run.workflowCycle ??= VerificationCycleSchema.parse(this.ports.policies.verification.start(plan, `cycle-${digest([run.runId, FINAL_TASK])}`));
                run.workflowVerificationPending = true;
                jobs.push({ runId: run.runId, taskId: FINAL_TASK, plan, cycle: run.workflowCycle, change: run.workflowChange,
                  options: { integration: { headCommitHash: run.workflowChange.headCommitHash, integratedTaskIds: run.tasks.map(task => task.taskId) } } });
              }
            }
            await core.checkpoint(run.runId);
            if (run.error?.startsWith(RUN_STEP_FAILURE_PREFIX)) delete run.error;
          } catch (error) { this.recordRunStepFailure(state, outbox, run, error); }
        }
        if (!this.quiesced) {
          // Before the flush, so a run's final cancellation notice is delivered in this same tick.
          await this.reconcileCancellations(state, save, core, outbox);
          await outbox.flush((out, handle) => this.bind(state, core, out, handle));
          this.surfaceOutboundFailures(state, outbox); this.surfaceCapabilityPreflightFailures(state, outbox);
        }
        await save(); return jobs;
    });
    await this.deliverConversationInbox();
    for (const job of jobs) {
      // No Runtime lock is held: QA/Reviewer may reply through Herdr while verification awaits them.
      try {
        const outcome = await this.ports.policies.verification.verify(job.plan, job.cycle, job.change, job.options);
        await this.finishVerification(job, outcome);
      } catch (error) {
        await this.transaction(async (state, save, _core, outbox) => {
          const run = this.run(state, job.runId);
          if (!run.cancelled && !["failed", "completed", "cancelled", "escalated"].includes(run.status))
            this.escalateForRetry(state, outbox, run, job.taskId, `${VERIFICATION_RETRY_PREFIX} ${redactString(String(error))}`);
          else if (resumablyPaused(run)) { // No outcome exists: release the flag so the frozen plan reruns after resume.
            if (job.taskId === FINAL_TASK) run.workflowVerificationPending = false;
            else { const task = run.tasks.find(item => item.taskId === job.taskId); if (task) task.verificationPending = false; }
          }
          await save();
        });
      }
    }
    return this.inspect();
  }
  /** Escalation whose only automatic recovery is an explicit, idempotent retry: the user gets concrete options. */
  private escalateForRetry(state: JournalState, outbox: HerdrOutbox, run: RunRecord, taskId: string, reason: string): void {
    const previousStatus = run.status === "escalated" ? "verifying" : run.status;
    run.status = "escalated"; run.error = reason;
    // Resumable: an authorized resume (Conversation "tiếp tục" / Coordinator resume_run) performs the bounded verification retry.
    if (!(run.pendingAction?.state === "pending" && run.pendingAction.kind === "resume_coordinator")) {
      const sourceMessageId = `verification-retry-${digest([run.runId, taskId, reason])}`;
      // Automatic, bounded: Runtime re-runs retry_verification itself after backoff, sharing the inherited budget.
      run.pendingAction = { actionId: `next-${digest([run.runId, sourceMessageId])}`, kind: "resume_coordinator", owner: "coordinator",
        reason: reason.slice(0, 2000), sourceMessageId, createdAt: this.now(), state: "pending", previousStatus,
        ...inheritedAutoResume(run), recovery: "auto_resume" };
    }
    const action = run.pendingAction!;
    const automatic = action.recovery === "auto_resume" && (action.resumeAttempts ?? 0) < AUTO_RESUME_LIMIT;
    this.emit(state, outbox, run, "conversation.progress", { kind: "verification_stuck", runId: run.runId, taskId, reason,
      actionId: action.actionId, options: VERIFICATION_RETRY_OPTIONS, sdlcStatus: run.status,
      headline: automatic ? `Verification needs attention: ${taskId}; Runtime retries it automatically` : `Verification needs attention: ${taskId}`,
      ...(automatic ? { automaticResume: automaticResumeNotice(action) } : {}) },
      `verification-stuck:${digest([run.runId, taskId, reason])}`, "conversation");
    const wakeId = `p19-wake-${digest([run.runId, "verification-stuck", taskId, reason])}`;
    if (!state.outbound.some(out => out.message.message_id === wakeId)) outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: wakeId,
      correlation_id: run.delegation.correlationId, causation_id: run.pendingAction!.sourceMessageId, run_id: run.runId, sender: { role: "runtime" },
      recipient: { role: "coordinator" }, type: "task.status", payload: { kind: "verification_stuck", runId: run.runId, taskId, reason,
        actionId: run.pendingAction!.actionId, sdlcStatus: run.status,
        next: automatic
          ? "Independent verification could not finish (environment/timeout/evidence). Runtime retries it automatically with backoff (bounded); report it to the user and do not call retry_verification yourself."
          : "Independent verification could not finish (environment/timeout/evidence). Report it with the retry/cancel options; the user's resume (or retry_verification once the user chose it) re-runs it." },
      artifact_references: [], occurred_at: this.now(), idempotency_key: wakeId }), "coordinator");
  }
  /** Bounded retries for a durable verification outcome that cannot be finished. Other entries and runs are unaffected. */
  private async recordVerificationFailure(item: JournalState["pendingVerifications"][number], error: unknown): Promise<void> {
    const id = pendingVerificationId(item);
    if (id === undefined) return;
    await this.transaction(async (state, save, _core, outbox) => {
      const entry = state.pendingVerifications.find(candidate => pendingVerificationId(candidate) === id);
      if (!entry) return; // finished or cleared meanwhile
      const reason = redactString(String(error));
      entry.attempts = (entry.attempts ?? 0) + 1; entry.lastError = reason;
      if (entry.attempts >= VERIFICATION_ATTEMPT_LIMIT) {
        const runId = pendingRunId(entry), taskId = pendingTaskId(entry) ?? "unknown-task";
        const run = state.runs.find(candidate => candidate.runId === runId);
        // Same liveness rule as finishVerification: an escalated run still resumes its verification outcomes.
        if (run && !run.cancelled && !["completed", "failed", "cancelled"].includes(run.status)) {
          entry.stuck = true;
          this.escalateForRetry(state, outbox, run, taskId, `${VERIFICATION_RETRY_PREFIX} ${reason} (failed ${entry.attempts} times)`);
        } else state.pendingVerifications = state.pendingVerifications.filter(candidate => candidate !== entry); // no live run to resume
      }
      await save();
    });
  }
  /**
   * Explicit retry for a run escalated by a verification delivery/storage failure. Durable outcomes are finished as they are;
   * a verification that never produced an outcome is re-run. Idempotent gate messages keep this from resending requests.
   */
  async retryVerification(runId: string, options: { automatic?: boolean; actionId?: string } = {}): Promise<JsonValue> {
    return this.transaction(async (state, save, _core, outbox) => {
      if (this.quiesced) throw new Error("Runtime is quiesced");
      const run = this.run(state, runId);
      if (run.nativeDeliveries?.length || state.outbound.some(item => item.message.run_id === runId &&
          ["sending", "unknown_delivery"].includes(item.status) && !isConversationDelivery(item)))
        throw new Error("Unknown delivery must be reconciled before verification retry");
      if (run.cancelled || run.status !== "escalated" || !run.error?.startsWith(VERIFICATION_RETRY_PREFIX))
        throw new Error("No verification awaiting retry for this run");
      const action = run.pendingAction;
      if (options.automatic) {
        // Re-checked under the lock: only the selected, still-automatic, due action is retried, and never past a human gate.
        if (action?.kind !== "resume_coordinator" || action.state !== "pending" || action.actionId !== options.actionId ||
            action.recovery !== "auto_resume" || Date.parse(this.now()) < autoResumeDueAt(action)) throw new Error("No verification awaiting retry for this run");
        if (Object.values(run.userDecisions ?? {}).some(item => item.status === "pending") ||
            run.approval !== undefined && (!run.decision || run.decision.approvalId !== run.approval.approvalId))
          throw new Error("A pending approval or user decision must be resolved before resume");
      }
      if (action?.kind === "resume_coordinator" && action.state === "pending") {
        if ((action.resumeAttempts ?? 0) >= 3) throw new Error("Bounded verification retries are exhausted; cancel or request operator intervention");
        action.state = "queued"; action.resumeAttempts = (action.resumeAttempts ?? 0) + 1; action.lastResumedAt = this.now(); delete action.previousStatus;
      }
      const retained = this.prepareVerificationRetry(state, run);
      this.progress(state, outbox, run, options.automatic ? "Verification retried automatically" : "Verification retry requested");
      await save();
      return json({ retried: true, runId, resumedOutcomes: retained });
    });
  }
  /**
   * Shared by retry_verification and an authorized resume. Durable outcomes are finished as they are; orphan flags are released;
   * a cycle that stopped on an environment/timeout `blocked` or `inconclusive` result restarts as a fresh deterministic cycle.
   */
  private prepareVerificationRetry(state: JournalState, run: RunRecord): number {
    const retained = state.pendingVerifications.filter(item => pendingRunId(item) === run.runId);
    for (const item of retained) if (item.stuck) { item.stuck = false; item.attempts = 0; delete item.lastError; }
    for (const task of run.tasks) {
      if (task.verificationPending && !retained.some(item => pendingTaskId(item) === task.taskId)) task.verificationPending = false;
      if (task.cycle && retryableVerificationCycle(task.cycle)) task.cycle = VerificationCycleSchema.parse(this.ports.policies.verification.start(
        this.verificationPlan(state, run, task), `cycle-${digest([run.runId, task.taskId, task.cycle.cycleId])}`));
    }
    if (run.workflowVerificationPending && !retained.some(item => pendingTaskId(item) === FINAL_TASK)) run.workflowVerificationPending = false;
    if (run.workflowCycle && retryableVerificationCycle(run.workflowCycle)) run.workflowCycle = VerificationCycleSchema.parse(this.ports.policies.verification.start(
      this.verificationPlan(state, run), `cycle-${digest([run.runId, FINAL_TASK, run.workflowCycle.cycleId])}`));
    run.status = "verifying"; delete run.error;
    return retained.length;
  }
  /** One run's scheduling step failed. Recorded on that run once per distinct error; it is retried on the next step. */
  private recordRunStepFailure(state: JournalState, outbox: HerdrOutbox, run: RunRecord, error: unknown): void {
    const reason = redactString(String(error));
    run.error = `${RUN_STEP_FAILURE_PREFIX} ${reason}`;
    this.emit(state, outbox, run, "conversation.progress", { kind: "workflow_blocked", runId: run.runId, reason: run.error,
      options: ["No action needed: Runtime retries this run on the next scheduling step", "Cancel this run"],
      headline: `Workflow step failed: ${reason}`, sdlcStatus: run.status }, `run-step-failed:${digest([run.runId, reason])}`, "conversation");
  }
  private parseJob(input: unknown): VerificationJob {
    const value = record(input); const plan = record(value.plan);
    const { planId, specFingerprint, ...configuration } = plan;
    const parsedPlan = this.ports.policies.createVerificationPlan(configuration);
    if (planId !== parsedPlan.planId || specFingerprint !== parsedPlan.specFingerprint) throw new Error("Corrupt verification job plan");
    return { runId: textField(value.runId), taskId: textField(value.taskId), plan: parsedPlan,
      cycle: VerificationCycleSchema.parse(value.cycle), change: GitChangeSetSchema.parse(value.change), options: value.options };
  }
  private parseOutcome(input: unknown) {
    const value = record(input);
    return { result: VerificationResultSchema.parse(value.result), cycle: VerificationCycleSchema.parse(value.cycle), messages: [] };
  }
  private async finishVerification(job: VerificationJob, outcome: { result: unknown; cycle: unknown; messages: RoleMessage[] }): Promise<void> {
    const result = VerificationResultSchema.parse(outcome.result);
    const cycle = VerificationCycleSchema.parse(outcome.cycle);
    if (result.runId !== job.runId || result.taskId !== job.taskId || cycle.runId !== job.runId || cycle.taskId !== job.taskId ||
        cycle.cycleId !== job.cycle.cycleId || result.changeSet?.changeSetId !== job.change.changeSetId) throw new Error("Verification outcome mismatch");
    await this.transaction(async (state, save, core, outbox) => {
      const run = this.run(state, job.runId);
      const pendingId = result.verificationId;
      const clearPending = () => { state.pendingVerifications = state.pendingVerifications.filter(item => record(record(item.outcome).result).verificationId !== pendingId); };
      if (resumablyPaused(run)) { // Keep the durable outcome; tick applies it once the run is resumed.
        if (!state.pendingVerifications.some(item => record(record(item.outcome).result).verificationId === pendingId)) {
          state.pendingVerifications.push({ job: json(job), outcome: json(outcome) }); await save();
        }
        return;
      }
      if (run.cancelled || ["failed", "completed", "cancelled"].includes(run.status) ||
          run.status === "escalated" && !run.error?.startsWith(VERIFICATION_RETRY_PREFIX)) {
        clearPending(); await save(); return; // late evidence cannot revive a terminal decision
      }
      // A frozen P17 plan predates identities allocated for later repairs.
      // Enforce independence against every actual implementation assignment as well.
      const implementerIds = new Set(state.outbound.filter(out => out.message.run_id === run.runId &&
        out.message.type === "task.assignment").map(out => out.handle?.target.agentId).filter(Boolean));
      if (result.qualityGateResults.some(gate => {
        const observation = gate.metadata?.verification;
        return observation !== null && typeof observation === "object" && !Array.isArray(observation) &&
          typeof observation.executorId === "string" && implementerIds.has(observation.executorId);
      })) throw new Error("Verification evidence executor is a workflow implementer");
      const existingPending = state.pendingVerifications.find(item => record(record(item.outcome).result).verificationId === pendingId);
      if (!existingPending) { state.pendingVerifications.push({ job: json(job), outcome: json(outcome) }); await save(); }
      // Other parallel checks may finish while a human is deciding this task.
      // Retain their durable outcomes without replacing the active approval or phase.
      if (run.status === "awaiting_approval" && run.approvalKind === "task" &&
          (run.approval?.target.type !== "task" || run.approval.target.taskId !== job.taskId)) {
        await save(); return;
      }
      const task = run.tasks.find(item => item.taskId === job.taskId);
      const currentCycle = task?.cycle ?? run.workflowCycle;
      // A superseded job (e.g. a coroutine of a lost process, or a cycle replaced by a retry) finishing late is stale, not a new failure.
      if (digest(currentCycle) !== digest(job.cycle) && digest(currentCycle) !== digest(cycle)) { clearPending(); await save(); return; }
      await this.verifyReferences(result.evidenceArtifacts, run.runId);
      // An environment/timeout block is no verdict: Core keeps its gate open so the bounded retry can evaluate the same attempt again.
      const retryable = retryableVerificationCycle(cycle);
      if (task) {
        const evaluationId = `evaluation-${result.verificationId}`;
        if (!retryable && !await core.hasEvent(run.runId, "quality_gate.evaluation_requested", evaluationId)) await core.mutate(run.runId, snapshot => this.ports.engine.requestQualityGateEvaluation({ runId: run.runId, taskId: task.taskId,
          evaluationId, gateId: VERIFICATION_GATE, attemptId: task.result!.attemptId, expectedVersion: snapshot.version,
          occurredAt: this.now(), idempotencyKey: `gate-request:${result.verificationId}` }));
        const gate = QualityGateResultSchema.parse({ gateId: VERIFICATION_GATE, runId: run.runId, taskId: task.taskId,
          evaluationId, status: result.status === "passed" ? "passed" : result.status === "failed" && cycle.status === "rework_required" ? "failed" : "blocked",
          findings: result.findings, producedArtifacts: [], evaluatedAt: result.completedAt,
          metadata: { independentVerification: true, verificationId: result.verificationId, evidence: json(result.evidenceArtifacts) } });
        if (!retryable && !await core.hasEvent(run.runId, "quality_gate.evaluated", evaluationId)) await core.mutate(run.runId, snapshot => this.ports.engine.recordQualityGateResult({ expectedVersion: snapshot.version,
          result: gate, idempotencyKey: `gate-result:${result.verificationId}` }));
        task.cycle = cycle; task.verificationPending = false;
        const out = state.outbound.find(item => item.handle?.requestId === task.result!.requestId);
        if (out) await outbox.release(out);
        if (cycle.status === "rework_required") {
          run.status = "implementing"; task.writerReleased = false;
          this.progress(state, outbox, run, `Verification requested scoped repairs for ${task.taskId}`);
        } else if (cycle.status === "passed") {
          run.status = "implementing";
          if (run.definition!.tasks.find(definition => definition.id === task.taskId)!.requiresApproval) {
            const currentTask = (await core.snapshot(run.runId)).tasks.find(item => item.taskId === task.taskId)!;
            run.approvalKind = "task"; run.status = "awaiting_approval";
            run.approval = run.approval?.approvalId === `task-approval-${result.verificationId}` ? run.approval : ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: `task-approval-${result.verificationId}`,
              runId: run.runId, sessionId: run.delegation.sessionId, status: "pending", target: { type: "task", taskId: task.taskId },
              revision: 1, generation: currentTask.generation, requestedBy: "coordinator", requestedAt: this.now(),
              reason: "Project policy requires task acceptance", evidence: result.evidenceArtifacts,
              idempotencyKey: `task-approval:${result.verificationId}` });
            if (!await core.hasEvent(run.runId, "approval.requested", run.approval.approvalId)) await core.mutate(run.runId, snapshot => this.ports.engine.requestApproval({ request: run.approval!,
              expectedVersion: snapshot.version, idempotencyKey: run.approval!.idempotencyKey }));
            this.emit(state, outbox, run, "approval.request", run.approval, run.approval.idempotencyKey, "conversation", result.evidenceArtifacts);
          }
        }
        else if (retryable) this.escalateForRetry(state, outbox, run, task.taskId, `${VERIFICATION_RETRY_PREFIX} ${cycle.escalation?.reason ?? "Verification blocked"}`);
        else { run.status = "escalated"; run.error = cycle.escalation?.reason ?? "Verification blocked"; }
      } else {
        run.workflowCycle = cycle; run.workflowVerificationPending = false;
        const currentIntegration = await this.ports.policies.git.getIntegration(run.integrationKey!);
        const integration = currentIntegration.status === "verified" ? currentIntegration : await this.ports.policies.git.recordVerification(run.integrationKey!, result);
        if (cycle.status === "passed" && integration.status === "verified") {
          run.status = "awaiting_approval"; run.approvalKind = "delivery";
          run.approval = ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: `delivery-${digest([run.runId, result.verificationId])}`,
            runId: run.runId, sessionId: run.delegation.sessionId, status: "pending", target: { type: "run" }, revision: 1, generation: 0,
            requestedBy: "coordinator", requestedAt: this.now(), reason: "Approve delivery of independently verified integrated changes",
            evidence: result.evidenceArtifacts, idempotencyKey: `delivery:${run.runId}:${result.verificationId}` });
          this.emit(state, outbox, run, "approval.request", run.approval, run.approval.idempotencyKey, "conversation", result.evidenceArtifacts);
        } else if (retryable) {
          this.escalateForRetry(state, outbox, run, FINAL_TASK, `${VERIFICATION_RETRY_PREFIX} ${cycle.escalation?.reason ?? "Workflow verification blocked"}`);
        } else {
          // Integrated revisions are immutable. Workflow repair requires a new approved task graph.
          run.status = "escalated"; run.error = cycle.escalation?.reason ?? "Integrated workflow verification failed; plan scoped repairs";
        }
      }
      // A replayed durable outcome that moved the run on settles the verification-retry action it was escalated with.
      if (run.status !== "escalated" && run.pendingAction?.state === "pending" && run.pendingAction.sourceMessageId.startsWith("verification-retry-")) {
        delete run.pendingAction; if (run.error?.startsWith(VERIFICATION_RETRY_PREFIX)) delete run.error;
      }
      this.emit(state, outbox, run, "verification.result", result, result.verificationId, "conversation", result.evidenceArtifacts);
      if (run.status === "escalated") this.progress(state, outbox, run, run.error!);
      clearPending(); await save(); await core.checkpoint(run.runId);
    });
  }
  private async integrate(state: JournalState, save: () => Promise<void>, outbox: HerdrOutbox, run: RunRecord): Promise<void> {
    let integration: Integration;
    if (run.integrationKey) integration = await this.ports.policies.git.getIntegration(run.integrationKey);
    else {
      integration = await this.ports.policies.git.beginIntegration({ runId: run.runId, integrationId: `integration-${digest(run.runId)}`,
        baseRevision: run.baseRevision!, tasks: run.tasks.map(task => ({ taskKey: task.worktrees.at(-1)!.key,
          dependsOn: run.definition!.dependencies.filter(dep => dep.taskId === task.taskId).map(dep => run.tasks.find(t => t.taskId === dep.dependsOnTaskId)!.worktrees.at(-1)!.key) })) });
      run.integrationKey = textField(integration.key); await save();
    }
    for (const message of integration.requests) {
      const parsed = RoleMessageSchema.parse(message);
      // P18 requests travel through Herdr to Coordinator, with the original durable identity.
      outbox.enqueue(parsed);
    }
    if (!await this.settleConflictResolvers(state, save, outbox, run)) return; // a previous resolver pane is still active
    if (integration.status === "conflict") { await this.assignConflictResolver(state, save, outbox, run, integration); return; }
    if (integration.status !== "awaiting_verification" || run.workflowChange) return;
    run.workflowChange = await captureIntegratedChange({ artifactStore: this.ports.artifactStore, runId: run.runId,
      taskId: FINAL_TASK, worktreePath: integration.worktreePath, branchName: integration.branchName,
      baseRevision: run.baseRevision!, headCommitHash: integration.expectedHead });
    run.status = "verifying"; await save();
  }
  private escalateConflict(state: JournalState, outbox: HerdrOutbox, run: RunRecord, detail?: string): void {
    run.status = "escalated";
    run.error = `${CONFLICT_ESCALATION}${detail ? ` (${detail})` : ""}`.slice(0, 2000);
    this.progress(state, outbox, run, run.error);
  }
  /**
   * P18 stopped on a merge conflict and preserved the integration worktree. Runtime assigns a Developer resolver on that same
   * worktree through the ordinary Developer allocation, lease/fence and Herdr dispatch, at most CONFLICT_RESOLVER_ATTEMPTS times per
   * conflict. Runtime never resolves a conflict itself (no ours/theirs); only a committed resolution accepted by P18 moves on.
   */
  private async assignConflictResolver(state: JournalState, save: () => Promise<void>, outbox: HerdrOutbox, run: RunRecord, integration: Integration): Promise<void> {
    const request = [...integration.requests].reverse().map(item => RoleMessageSchema.parse(item))
      .find(item => item.type === "task.status" && objectField(item.payload, "reason") === "merge_conflict");
    if (!request) { this.escalateConflict(state, outbox, run, "P18 reported no conflict detail"); return; }
    const detail = record(request.payload);
    let resolution = run.conflictResolution;
    if (!resolution || resolution.conflictId !== request.message_id) {
      resolution = run.conflictResolution = { conflictId: request.message_id, integrationKey: integration.key, taskKey: textField(detail.taskKey),
        conflictPaths: strings(detail.conflictPaths), worktreePath: integration.worktreePath, branchName: integration.branchName,
        ...(typeof detail.incomingCommitHash === "string" ? { incomingCommitHash: detail.incomingCommitHash } : {}), attempts: [] };
      await save();
    }
    if (resolution.attempts.some(attempt => attempt.status === "assigned")) return; // the current resolver owns the worktree
    if (resolution.attempts.length >= CONFLICT_RESOLVER_ATTEMPTS) {
      this.escalateConflict(state, outbox, run, `automatic Developer resolver failed ${resolution.attempts.length} attempts: ${resolution.attempts.at(-1)?.reason ?? "no accepted resolution"}`);
      return;
    }
    const number = resolution.attempts.length + 1;
    const taskId = `conflict-${digest([run.runId, resolution.conflictId]).slice(0, 16)}`, attemptId = `${taskId}-attempt-${number}`;
    const agentName = `dev-${digest([run.runId, attemptId]).slice(0, 20)}`;
    const allocation = await this.ports.panes.allocateDeveloper({ taskId: `${run.runId}-${taskId}`, runId: run.runId,
      worktreePath: resolution.worktreePath, branchName: resolution.branchName, agentName });
    if (!allocation.ok) {
      if (allocation.error.code === "conflict" && allocation.error.retryable) { // capacity: retried on a later tick
        run.error = `Conflict resolver allocation pending: ${allocation.error.message}`;
        this.progress(state, outbox, run, run.error); await save(); return;
      }
      this.escalateConflict(state, outbox, run, `resolver allocation failed: ${allocation.error.message}`); await save(); return;
    }
    const pane = PaneBindingSchema.parse(allocation.value);
    if (pane.worktreePath !== resolution.worktreePath || pane.agentId !== agentName) throw new Error("Conflict resolver allocation mismatch");
    const paths = resolution.conflictPaths.join(", ") || "(see git status)";
    const messageId = `conflict-resolver-${digest([run.runId, resolution.conflictId, number])}`;
    outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: messageId, correlation_id: run.delegation.correlationId,
      causation_id: request.message_id, run_id: run.runId, sender: { role: "coordinator" },
      recipient: { role: "developer", agent_id: pane.agentId, pane_id: pane.paneId }, type: "task.assignment",
      payload: json({ kind: CONFLICT_RESOLUTION_KIND, runId: run.runId, taskId, attempt: number, maxAttempts: CONFLICT_RESOLVER_ATTEMPTS,
        objective: `Resolve the Git merge conflict in ${paths} on the preserved integration worktree ${resolution.worktreePath} (branch ${resolution.branchName}).`,
        conflictPaths: resolution.conflictPaths, taskKey: resolution.taskKey, incomingCommitHash: resolution.incomingCommitHash ?? null,
        worktree: { worktreePath: resolution.worktreePath, branchName: resolution.branchName },
        previousFailures: resolution.attempts.map(attempt => attempt.reason ?? "no accepted resolution"),
        specification: run.workflowSpec?.specification ?? run.tasks[0]?.spec.specification ?? null,
        instruction: "Edit only the conflicted files so both sides' intent is preserved and no conflict markers remain, then use the host commit tool " +
          "to conclude the merge. Runtime submits that commit to P18 accept_conflict_resolution and runs workflow verification. Never discard a side " +
          "wholesale or reset the merge. If you cannot resolve it, send task.status with status \"failed\" and the reason." }),
      artifact_references: [], occurred_at: this.now(), idempotency_key: messageId }), pane.bindingId, taskId, attemptId, ["implementation"]);
    resolution.attempts.push({ messageId, taskId, attemptId, agentName, status: "assigned" });
    run.status = "implementing";
    run.error = `Resolving Git integration conflict in ${paths}: Developer resolver attempt ${number}/${CONFLICT_RESOLVER_ATTEMPTS} assigned; worktree preserved`;
    this.progress(state, outbox, run, run.error);
    await save();
  }
  /** Releases the pane and lease of each ended resolver attempt once its pane is observed idle; false while one is still active. */
  private async settleConflictResolvers(state: JournalState, save: () => Promise<void>, outbox: HerdrOutbox, run: RunRecord): Promise<boolean> {
    for (const attempt of run.conflictResolution?.attempts ?? []) {
      if (attempt.status === "assigned" || attempt.settled) continue;
      const out = state.outbound.find(item => item.message.message_id === attempt.messageId);
      if (out?.status === "accepted") {
        const health = unwrap(await this.ports.panes.inspectRoleHealth(out.selector));
        if (!health.readyForPrompt || !health.occupantMatches) return false; // the resolver may still be writing
        await outbox.release(out);
      } else if (out?.status === "queued") { out.status = "cancelled"; }
      else if (out && ["sending", "unknown_delivery"].includes(out.status)) return false; // reconcile first; never resend
      unwrap(await this.ports.panes.releaseDeveloper({ taskId: `${run.runId}-${attempt.taskId}`, closePane: false, removeWorktree: false }));
      attempt.settled = true; await save();
    }
    return true;
  }
  private currentResolver(run: RunRecord, out: Outbound | undefined) {
    const attempt = out && run.conflictResolution?.attempts.find(item => item.messageId === out.message.message_id);
    return attempt && run.conflictResolution ? { resolution: run.conflictResolution, attempt } : undefined;
  }
  private failConflictResolver(state: JournalState, outbox: HerdrOutbox, run: RunRecord, attempt: ConflictResolverAttempt, reason: string): void {
    if (attempt.status !== "assigned") return;
    attempt.status = "failed"; attempt.reason = redactString(reason).slice(0, 1000);
    const exhausted = (run.conflictResolution?.attempts.length ?? 0) >= CONFLICT_RESOLVER_ATTEMPTS;
    this.progress(state, outbox, run, `Conflict resolver attempt ${attempt.attemptId} ended without an accepted resolution: ${attempt.reason}${
      exhausted ? "; escalating" : "; assigning another resolver"}`);
  }
  /** A resolver's own correlated report. A failure ends its attempt; it is never success evidence by itself. */
  private resolverReport(state: JournalState, outbox: HerdrOutbox, run: RunRecord, message: RoleMessage): boolean {
    const out = state.outbound.find(item => item.message.message_id === message.causation_id);
    const current = this.currentResolver(run, out);
    if (!current || !out) return false;
    if (!out.handle || message.sender.role !== "developer" || message.sender.agent_id !== out.handle.target.agentId ||
        message.sender.pane_id !== out.handle.target.paneId) throw new Error("Resolver report is not correlated to its assignment");
    const status = String(objectField(message.payload, "status"));
    if (message.type === "implementation.submitted") {
      const result = AgentResultSchema.parse(message.payload);
      if (result.status !== "succeeded" || current.attempt.status === "assigned")
        this.failConflictResolver(state, outbox, run, current.attempt, result.error?.message ?? result.blockage?.message ??
          (result.status === "succeeded" ? "Submitted without a committed resolution accepted by P18" : `Resolver reported ${result.status}`));
    } else if (["blocked", "failed", "cancelled", "inconclusive"].includes(status)) {
      this.failConflictResolver(state, outbox, run, current.attempt, specialistBlockage({ ...record(message.payload), status: "failed" }) ?? `Resolver reported ${status}`);
    }
    return true;
  }
  /** Trusted local tool guard for a conflict resolver: the current lease, pane, session and preserved worktree own the edit. */
  async withConflictResolverWorkspace<T>(bindingInput: PaneBinding, runId: string, taskId: string,
    use: (resolution: { conflictPaths: string[]; branchName: string; worktreePath: string; taskKey: string; incomingCommitHash?: string;
      attempt: number; maxAttempts: number; previousFailures: string[] }) => Promise<T>): Promise<T> {
    const binding = PaneBindingSchema.parse(bindingInput);
    return this.transaction(async (state, _save, _core, outbox) => {
      const { resolution, attempt } = await this.ownedResolver(state, outbox, binding, runId, taskId);
      return use({ conflictPaths: [...resolution.conflictPaths], branchName: resolution.branchName, worktreePath: resolution.worktreePath, taskKey: resolution.taskKey,
        ...(resolution.incomingCommitHash ? { incomingCommitHash: resolution.incomingCommitHash } : {}),
        attempt: resolution.attempts.indexOf(attempt) + 1, maxAttempts: CONFLICT_RESOLVER_ATTEMPTS,
        previousFailures: resolution.attempts.filter(item => item.status === "failed").map(item => item.reason ?? "no accepted resolution") });
    });
  }
  private async ownedResolver(state: JournalState, outbox: HerdrOutbox, binding: PaneBinding, runId: string, taskId: string) {
    if (this.quiesced || binding.role !== "developer") throw new Error("Developer writes are quiesced or unauthorized");
    const run = this.run(state, runId); this.live(run);
    assertNoPendingPaneDecision(run, binding);
    const resolution = run.conflictResolution, attempt = resolution?.attempts.find(item => item.taskId === taskId && item.status === "assigned");
    const out = attempt && state.outbound.find(item => item.message.message_id === attempt.messageId);
    if (!resolution || !attempt || !out?.handle || out.status !== "accepted" || out.handle.target.agentId !== binding.agentId ||
        out.handle.target.paneId !== binding.paneId || out.handle.target.worktreePath !== binding.worktreePath ||
        binding.worktreePath !== resolution.worktreePath || digest(out.handle.target.session) !== digest(binding.session))
      throw new Error("No current conflict resolver assignment owns this integration worktree");
    await outbox.renew(out); // current lease and fencing token, immediately before the write
    return { run, resolution, attempt, out };
  }
  /**
   * The resolver's commit goes through the host commit tool; Runtime then asks P18 to accept that exact commit (the same
   * validation as accept_conflict_resolution). A rejected resolution ends the attempt; the next one or an escalation follows.
   */
  async commitConflictResolution(bindingInput: PaneBinding, runId: string, taskId: string,
    commit: (resolution: { conflictPaths: string[]; branchName: string; worktreePath: string }) => Promise<string | undefined>): Promise<JsonValue> {
    const binding = PaneBindingSchema.parse(bindingInput);
    return this.transaction(async (state, save, _core, outbox) => {
      const { run, resolution, attempt } = await this.ownedResolver(state, outbox, binding, runId, taskId);
      const head = await commit({ conflictPaths: [...resolution.conflictPaths], branchName: resolution.branchName, worktreePath: resolution.worktreePath });
      if (!head) return json({ committed: false });
      attempt.commitHash = head; await save();
      try {
        const integration = await this.ports.policies.git.acceptConflictResolution(resolution.integrationKey, { taskKey: resolution.taskKey, resolutionCommitHash: head });
        attempt.status = "accepted"; run.status = "implementing"; delete run.error;
        this.progress(state, outbox, run, "Committed conflict resolution accepted; workflow verification required");
        await save(); return json({ committed: true, accepted: true, head, integrationStatus: integration.status });
      } catch (error) {
        this.failConflictResolver(state, outbox, run, attempt, `P18 rejected the resolution commit: ${String(error)}`);
        await save(); return json({ committed: true, accepted: false, head, reason: attempt.reason ?? String(error) });
      }
    });
  }
  async reconcileDelivery(messageId: string): Promise<JsonValue> {
    return this.transaction(async (state, save, core, outbox) => {
      await outbox.reconcile(messageId, (out, handle) => this.bind(state, core, out, handle));
      const out = state.outbound.find(item => item.message.message_id === messageId);
      const run = state.runs.find(item => item.runId === out?.message.run_id);
      if (out && out.status !== "unknown_delivery" && out.status !== "sending" && run?.pendingAction?.recovery === "reconcile_delivery" &&
          run.pendingAction.sourceMessageId === messageId) {
        if (run.error === run.pendingAction.reason) delete run.error;
        delete run.pendingAction;
      }
      await save(); return json({ reconciled: true });
    });
  }
  async acceptConflictResolution(runId: string, taskKey: string, resolutionCommitHash: string): Promise<JsonValue> {
    return this.transaction(async (state, save, _core, outbox) => {
      const run = this.run(state, runId);
      const resolving = run.conflictResolution?.attempts.find(attempt => attempt.status === "assigned");
      if (run.cancelled || !run.integrationKey || !(run.status === "escalated" && run.error?.startsWith("Git integration conflict") ||
          resolving && !TERMINAL_RUN_STATUSES.includes(run.status))) throw new Error("No pending conflict");
      const integration = await this.ports.policies.git.acceptConflictResolution(run.integrationKey, { taskKey, resolutionCommitHash });
      if (resolving) { resolving.status = "accepted"; resolving.commitHash = resolutionCommitHash; }
      run.status = "implementing"; delete run.error;
      this.progress(state, outbox, run, "Committed conflict resolution accepted; workflow verification required");
      await save(); return json(integration);
    });
  }
  async cancel(runId: string, reason: string): Promise<JsonValue> {
    return this.transaction(async (state, save, core, outbox) => {
      await this.cancelRun(state, save, core, outbox, this.run(state, runId), reason);
      return json(this.run(state, runId));
    });
  }
  /** Cancellation invalidates every unsent work/wake/approval; uncertain deliveries keep their reconciliation receipts. */
  private async closeCancelledRunDecisions(state: JournalState, save: () => Promise<void>, outbox: HerdrOutbox, run: RunRecord): Promise<void> {
    if (!run.cancelled) return;
    for (const entry of Object.values(run.userDecisions ?? {})) if (entry.status === "pending") {
      entry.status = "cancelled";
      this.notifyUserDecisionClosed(state, outbox, run, entry);
    }
    if (run.approval && (!run.decision || run.decision.approvalId !== run.approval.approvalId))
      run.approval = ApprovalRequestSchema.parse({ ...run.approval, status: "cancelled" });
    let failure: unknown;
    for (const out of state.outbound.filter(item => item.message.run_id === run.runId && !item.phaseRetirement &&
        (item.status === "queued" || item.status === "cancelled" && item.lease !== undefined && !item.parentAssignmentId) &&
        !isCancellationHandoff(item.message) && (item.message.recipient.role !== "conversation" || item.message.type === "approval.request"))) {
      out.status = "cancelled"; out.error = "Run cancelled; unsent work or approval is no longer actionable";
      await save();
      // Safely queued work never reached the provider. Release its own durable lease, while a task notice retains its parent's lease.
      if (out.lease && !out.parentAssignmentId) {
        try { await outbox.release(out); }
        catch (error) {
          out.error = `Cancellation lease release unresolved: ${redactString(String(error))}`;
          await save(); failure ??= error;
        }
      }
    }
    if (failure !== undefined) throw failure;
  }
  private async cancelRun(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox,
    run: RunRecord, reason: string): Promise<void> {
    // Completed and failed runs remain authoritative terminal outcomes; cancellation is a safe no-op.
    if (!run.cancelled && ["completed", "failed"].includes(run.status)) return;
    if (!run.cancelled) { run.cancelled = true; run.status = "cancelled"; run.error = textField(reason); await save(); }
    for (const waiter of this.gateWaiters.values()) if (waiter.runId === run.runId) waiter.reject(new Error("Run cancellation requested"));
    await this.closeCancelledRunDecisions(state, save, outbox, run);
    // A repeated success adds no final notice. A distinct request may retry previously failed idempotent local cleanup.
    if (run.cancelReconciled && !state.outbound.some(item => item.message.run_id === run.runId && isCancellationHandoff(item.message) &&
        item.status === "failed" && item.error?.startsWith("Cancellation processing failed:")) &&
        !state.inbox.some(item => item.message.run_id === run.runId && item.status === "received" && isCancellationHandoff(item.message))) { await save(); return; }
    this.progress(state, outbox, run, "Run cancelled; stop confirmation and worktree reconciliation are in progress");
    await save();
    if (run.coreCreated) {
      const snapshot = await core.snapshot(run.runId);
      if (!["succeeded", "failed", "cancelled", "cancelling"].includes(snapshot.status)) {
        const request = CancellationRequestSchema.parse({ schemaVersion: 1, cancellationId: `cancel-${digest(run.runId)}`,
          runId: run.runId, requestedBy: "conversation", requestedAt: this.now(), expectedVersion: snapshot.version,
          reason, idempotencyKey: `cancel:${run.runId}` });
        await core.mutate(run.runId, () => this.ports.engine.requestCancellation(request));
      }
    }
    for (const out of state.outbound.filter(item => item.message.run_id === run.runId && isStoppableExecution(item))) {
      if (out.status === "queued") { out.status = "cancelled"; continue; }
      if (out.status === "sending") out.status = "unknown_delivery";
      if (out.status === "accepted" && out.handle) await this.requestStop(core, outbox, save, run, out, reason);
    }
    if (run.integrationKey) await this.ports.policies.git.cancelIntegration(run.integrationKey);
    for (const task of run.tasks) for (const tree of task.worktrees) await this.ports.policies.git.cancelTask(tree.key);
    await save();
  }
  /**
   * Interrupts one accepted execution, at most once: a repeated interrupt could be delivered again to the provider CLI. An accepted
   * interrupt is not confirmation of stop, so the lease, worktree and Core cancelling state wait for stopObserved.
   */
  private async requestStop(core: CoreSession, outbox: HerdrOutbox, save: () => Promise<void>, run: RunRecord, out: Outbound,
    reason: string): Promise<void> {
    if (!out.handle || out.cancelRequested || out.reviewReplacement) return;
    try { await outbox.renew(out); } catch (error) { out.error = `Cancellation lease unresolved: ${String(error)}`; await save(); return; }
    out.cancelRequested = true; await save();
    const version = run.coreCreated ? (await core.snapshot(run.runId)).version : 0;
    const request = CancellationRequestSchema.parse({ schemaVersion: 1, cancellationId: `cancel-${digest(out.message.message_id)}`,
      runId: run.runId, taskId: out.taskId, requestedBy: "runtime", requestedAt: this.now(), expectedVersion: version,
      reason, idempotencyKey: `cancel:${out.message.message_id}` });
    const response = await this.ports.transport.cancel(out.handle, request);
    out.error = response.ok ? "Interrupt requested; stop unconfirmed" : response.error.message;
  }
  /**
   * Herdr `done` is turn completion and a timeout or error is no evidence either, so only an observed `idle` or `cancelled` from
   * the bound execution proves the stop. Herdr's own cancel acknowledgement reports stopConfirmed:false and is never used here.
   */
  private async stopObserved(out: Outbound): Promise<boolean> {
    const handle = out.handle!;
    const observed = await this.ports.transport.wait(handle, { until: ["idle", "cancelled"], timeoutMs: CANCEL_STOP_OBSERVATION_WAIT_MS });
    return observed.ok && ["idle", "cancelled"].includes(observed.value.state) && observed.value.correlationVerified &&
      observed.value.handle.executionId === handle.executionId;
  }
  /**
   * Reconciles every cancelled run that has not yet reported its final outcome. Each pass observes; it never resends and never
   * assumes a stop. Stop-unconfirmed executions are bounded by CANCEL_STOP_OBSERVATION_LIMIT, after which they are reported for
   * manual reconciliation. Core is completed only when every execution is proven stopped, and worktrees are removed only then.
   */
  private async reconcileCancellations(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox): Promise<void> {
    for (const run of state.runs.filter(item => item.cancelled && !item.cancelReconciled)) {
      const executions = state.outbound.filter(out => out.message.run_id === run.runId && isStoppableExecution(out));
      let waiting = false;
      for (const out of executions.filter(item => item.status === "accepted" && item.handle)) {
        const attempts = out.cancelObservations ?? 0;
        try {
          if (!out.cancelRequested) await this.requestStop(core, outbox, save, run, out, run.error ?? "Run cancelled");
          else if (attempts < CANCEL_STOP_OBSERVATION_LIMIT && await this.stopObserved(out)) { await outbox.release(out); continue; }
          // Interrupts and lease renewals count as attempts too, so a pane that never accepts a stop still reaches the bound.
          if (attempts < CANCEL_STOP_OBSERVATION_LIMIT && out.status === "accepted") out.cancelObservations = attempts + 1;
        } catch (error) {
          out.error = `Cancellation observation failed: ${String(error)}`;
          if (attempts < CANCEL_STOP_OBSERVATION_LIMIT) out.cancelObservations = attempts + 1;
        }
        await save();
        if ((out.cancelObservations ?? 0) < CANCEL_STOP_OBSERVATION_LIMIT && out.status === "accepted") waiting = true;
      }
      if (waiting) continue;
      try { await this.finishCancellation(state, save, core, outbox, run, executions); }
      catch (error) {
        const reason = `Cancellation reconciliation failed: ${redactString(String(error))}`;
        this.emit(state, outbox, run, "conversation.progress", { sdlcStatus: run.status,
          headline: "Cancellation requires reconciliation", reason, blockageReason: reason }, "cancel-reconciliation-failed", "conversation");
        await save(); // Keep the unresolved run eligible for observation; later runs must still reconcile.
      }
    }
  }
  /** Final, idempotent report for one cancelled run. Core and worktree cleanup happen only when no execution remains unconfirmed. */
  private async finishCancellation(state: JournalState, save: () => Promise<void>, core: CoreSession, outbox: HerdrOutbox,
    run: RunRecord, executions: Outbound[]): Promise<void> {
    const unresolved: string[] = (run.nativeDeliveries ?? []).map(item => `Native delivery ${item.operationId} is uncertain (${item.message.message_id}); no mutation was resent`);
    for (const retired of state.outbound.filter(item => item.message.run_id === run.runId && item.phaseRetirement))
      unresolved.push(`Retired verifier phase ${retired.message.message_id}: measurement/remote outcome remains unclaimed; late results are fenced`);
    for (const replaced of state.outbound.filter(item => item.message.run_id === run.runId && item.reviewReplacement))
      unresolved.push(`Replaced workflow review ${replaced.message.message_id}: original remote outcome remains unclaimed; no stop/release is asserted and late results are fenced`);
    for (const out of state.outbound.filter(item => item.message.run_id === run.runId && isCancellationHandoff(item.message) && item.status === "failed" && item.error?.startsWith("Cancellation processing failed:")))
      unresolved.push(out.error ?? `Cancellation control ${out.message.message_id} failed`);
    for (const item of state.inbox.filter(entry => entry.message.run_id === run.runId && entry.status === "received" && isCancellationHandoff(entry.message)))
      unresolved.push(item.reason ?? `Authenticated cancellation ${item.message.message_id} is received but cleanup is not applied`);
    for (const out of state.outbound.filter(item => item.message.run_id === run.runId && item.status === "cancelled" && item.lease && !item.parentAssignmentId && !item.phaseRetirement))
      unresolved.push(out.error ?? `Unsent ${out.message.message_id} still owns lease ${out.lease!.leaseId}`);
    for (const out of state.outbound.filter(item => item.message.run_id === run.runId && item.message.recipient.role !== "conversation" &&
        !isStoppableExecution(item) && ["sending", "unknown_delivery"].includes(item.status)))
      unresolved.push(`${out.message.recipient.role} delivery is uncertain (${out.message.message_id}); no mutation was resent`);
    for (const out of executions) {
      if (out.status === "accepted" && out.handle) unresolved.push(`${out.message.recipient.role} execution ${out.handle.executionId} for ${out.taskId} is not confirmed stopped after ${CANCEL_STOP_OBSERVATION_LIMIT} observations; lease ${out.lease?.leaseId ?? "none"} is retained`);
      else if (["sending", "unknown_delivery"].includes(out.status)) unresolved.push(`${out.message.recipient.role} delivery for ${out.taskId} is uncertain (${out.message.message_id})`);
    }
    const released = executions.filter(out => out.cancelRequested && out.status === "released" && out.lease).length;
    if (run.coreCreated && unresolved.length === 0) {
      try { await this.confirmCoreStops(run, core, executions); }
      catch (error) { unresolved.push(`Core could not record the stop: ${String(error)}`); }
    }
    // Worktrees are never removed here: GitPolicy exposes no cleanup, and cancelled work is kept for inspection. They are reported by path.
    const retained = run.tasks.flatMap(task => task.worktrees).map(tree => tree.worktreePath);
    if (run.integrationKey) retained.push((await this.ports.policies.git.getIntegration(run.integrationKey)).worktreePath);
    const coreCancelling = run.coreCreated && (await core.snapshot(run.runId)).status === "cancelling";
    const worktreeText = `0 worktree(s) removed, ${retained.length} retained${retained.length ? `: ${retained.join(", ")}` : ""}`;
    const headline = unresolved.length
      ? `Run cancelled: manual reconciliation required; ${unresolved.length} item(s) not confirmed stopped`
      : `Run cancelled: fully stopped, ${released} lease(s) released, ${worktreeText}`;
    const reason = unresolved.length
      ? [...unresolved, ...(coreCancelling ? ["Core run stays cancelling until these are reconciled"] : []), `Worktrees: ${worktreeText}`,
        "Options: inspect the role pane in Herdr and stop the process manually, then cancel again only to re-report; leases expire at their TTL",
        "Options: keep the retained worktrees for inspection or remove them yourself after confirming they hold no needed work"].join("; ")
      : worktreeText;
    this.emit(state, outbox, run, "conversation.progress", { sdlcStatus: run.status, headline, reason,
      ...(unresolved.length ? { blockageReason: reason } : {}) }, "cancel-reconciled", "conversation");
    run.cancelReconciled = true;
    await save();
  }
  /** Completes Core cancellation through the engine: bound executions first, then unbound tasks, which the engine only accepts last. */
  private async confirmCoreStops(run: RunRecord, core: CoreSession, executions: Outbound[]): Promise<void> {
    const cancellationId = `cancel-${digest(run.runId)}`;
    const stoppedAt = this.now();
    const confirm = (executionId: string | undefined) => core.mutate(run.runId, current => this.ports.engine.confirmCancellationStop({
      runId: run.runId, expectedVersion: current.version, idempotencyKey: `cancel-stop:${run.runId}:${executionId ?? "unbound"}`,
      confirmation: { schemaVersion: 1, cancellationId, ...(executionId !== undefined ? { executionId } : {}), stoppedAt, terminalStatus: "cancelled" }
    }));
    const snapshot = await core.snapshot(run.runId);
    if (snapshot.status !== "cancelling") return;
    for (const task of snapshot.tasks.filter(item => item.status === "cancelling" && item.agentExecution !== undefined)) {
      const executionId = task.agentExecution!.executionId;
      if (!executions.some(out => out.cancelRequested && out.status === "released" && out.handle?.executionId === executionId)) throw new Error(`Execution ${executionId} has no stop evidence`);
      await confirm(executionId);
    }
    if ((await core.snapshot(run.runId)).tasks.some(item => item.status === "cancelling" && item.agentExecution === undefined)) await confirm(undefined);
  }
  /**
   * Host-reported Stop of a specialist turn. A role that still owes an answer (an accepted assignment, delegation, or verification request with no
   * applied message from it since) makes Conversation see `developer_no_response` / `specialist_no_response` and wakes the
   * Coordinator once per assignment. Herdr Stop is operational evidence only, never task success.
   */
  async specialistTurnStopped(bindingInput: unknown, roleInput: unknown, observedAt = new Date().toISOString(), sourceMessageId?: string): Promise<void> {
    const binding = PaneBindingSchema.parse(bindingInput), role = textField(roleInput);
    if (binding.role !== role || role === "conversation" || role === "coordinator") throw new Error("Specialist Stop requires a non-Conversation specialist binding");
    await this.transaction(async (state, save, _core, outbox) => {
      const source = sourceMessageId === undefined ? undefined : state.outbound.find(item => item.message.message_id === textField(sourceMessageId));
      if (sourceMessageId !== undefined && (!source || source.message.recipient.role !== role || !source.handle ||
          source.handle.target.paneId !== binding.paneId || source.handle.target.agentId !== binding.agentId ||
          digest(source.handle.target.session) !== digest(binding.session) || source.handle.target.workspaceId !== binding.workspaceId ||
          source.handle.target.tabId !== binding.tabId || !["accepted", "released"].includes(source.status) ||
          !Number.isFinite(Date.parse(observedAt)) || Date.parse(source.handle.acceptedAt) > Date.parse(observedAt))) return;
      // Continuation notices are delivered on the existing assignment execution. Attribute their Stop to that parent assignment.
      const expectedSourceMessageId = source?.parentAssignmentId ?? source?.message.message_id;
      let changed = false;
      for (const out of [...state.outbound]) {
        if (expectedSourceMessageId !== undefined && out.message.message_id !== expectedSourceMessageId) continue;
        if (out.message.recipient.role !== role || out.handle?.target.paneId !== binding.paneId || out.handle.target.agentId !== binding.agentId ||
            digest(out.handle.target.session) !== digest(binding.session) || out.handle.target.workspaceId !== binding.workspaceId ||
            out.handle.target.tabId !== binding.tabId || Date.parse(out.handle.acceptedAt) > Date.parse(observedAt) ||
            !Number.isFinite(Date.parse(observedAt)) || !["accepted", "released"].includes(out.status)) continue;
        if (!["task.assignment", "delegation.request", "verification.requested"].includes(out.message.type) || !out.message.run_id) continue;
        const run = state.runs.find(item => item.runId === out.message.run_id);
        // Retain physical Stop independently of delivery reconciliation; host may settle this Stop receipt now.
        // A later retry still requires released capacity, no uncertain deliveries, and an unanswered assignment.
        if (run && !run.cancelled && (!TERMINAL_RUN_STATUSES.includes(run.status) || resumablyPaused(run)) &&
            out.message.type === "delegation.request" && this.outboundOwesResult(state, run, out) &&
            !Object.values(run.userDecisions ?? {}).some(item => item.role === role && item.status === "pending") && out.stopObservedAt === undefined) {
          out.stopObservedAt = observedAt; changed = true;
        }
        if (!run || run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status) || run.status === "awaiting_approval") continue;
        // Waiting on a user decision it asked for through Runtime is a legitimate idle turn, not a missing answer.
        if (Object.values(run.userDecisions ?? {}).some(item => item.role === role && item.status === "pending")) continue;
        if (!this.outboundOwesResult(state, run, out) || run.nativeDeliveries?.length) continue;
        const kind = role === "developer" ? "developer_no_response" : "specialist_no_response";
        const reason = `${role} ended its turn for ${out.message.type} (${out.message.message_id}) without a structured result`;
        this.emit(state, outbox, run, "conversation.progress", { kind, runId: run.runId, reason, headline: `${role} không trả kết quả: ${out.message.type}`,
          options: ["Yêu cầu Coordinator giao lại việc hoặc giải thích trạng thái", "Hủy run"], blockageReason: reason },
        `${kind}:${out.message.message_id}`, "conversation", []);
        const wakeId = `p19-wake-${digest([run.runId, `${kind}:${out.message.message_id}`])}`;
        if (!state.outbound.some(item => item.message.message_id === wakeId)) {
          outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: wakeId, correlation_id: run.delegation.correlationId,
            causation_id: out.message.message_id, run_id: run.runId, sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status",
            payload: { kind: "specialist_no_response", fromRole: role, sourceMessageId: out.message.message_id, sdlcStatus: run.status, reason,
              stoppedExecutionId: out.handle.executionId, stopObservedAt: observedAt,
              next: "The specialist ended without a result. Reassign the work through Runtime, or report a blocker; do not treat its idle pane as success." },
            artifact_references: [], occurred_at: this.now(), idempotency_key: wakeId }), "coordinator");
        }
        changed = true;
      }
      if (changed) await save();
    });
  }
  /**
   * Stop of a turn that was woken by a Runtime notice (the wake-up is a Runtime task.status to the Coordinator) or a delegation.
   * Emits `coordinator_no_response` with the reason and numbered options when the Coordinator produced no structured response.
   * Also the unrecoverable-item path: the host calls it when the pane/native session can no longer be matched.
   */
  async coordinatorStopWithoutResponse(input: unknown, bindingInput: unknown, reason?: string): Promise<void> {
    const message = RoleMessageSchema.parse(input), binding = PaneBindingSchema.parse(bindingInput);
    await this.transaction(async (state, save, _core, outbox) => {
      const delivery = this.providerDelivery(state, message, binding);
      if (binding.role !== "coordinator" || message.recipient.role !== "coordinator") throw new Error("Coordinator Stop requires a Coordinator delivery");
      if (isConversationContextWake(message)) return; // An informational turn owes no business next action.
      const run = state.runs.find(item => item.runId === message.run_id);
      if (!run || run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status) || this.hasSemanticNextAction(state, run)) return;
      if (reason) run.error = redactString(reason).slice(0, 2000);
      this.recordCoordinatorNoNextAction(state, outbox, run, message, delivery);
      await save();
    });
  }
  /** A late native ACK (or Runtime's own application) settles an uncertain native delivery: clear its action, never resend. */
  async reconcileNativeDelivery(messageId: string): Promise<boolean> {
    return this.transaction(async (state, save) => { const changed = this.settleNativeDeliveries(state, textField(messageId)); if (changed) await save(); return changed; });
  }
  private settleNativeDeliveries(state: JournalState, acknowledgedId?: string): boolean {
    let changed = false;
    for (const run of state.runs) {
      const previous = run.nativeDeliveries ?? [];
      const pending = previous.filter(entry => entry.message.message_id !== acknowledgedId && !this.durablySettledNative(state, entry.message));
      if (pending.length !== previous.length) { run.nativeDeliveries = pending; changed = true; }
      const action = run.pendingAction;
      if (!action || action.kind !== "reconcile_delivery" || action.state !== "pending" || run.cancelled) continue;
      const intent = previous.find(entry => entry.message.message_id === action.sourceMessageId);
      const received = intent ? this.durablySettledNative(state, intent.message) : state.inbox.some(item =>
        item.message.message_id === action.sourceMessageId && item.message.run_id === run.runId &&
        item.message.correlation_id === run.delegation.correlationId && item.message.idempotency_key !== undefined && ["received", "applied", "rejected"].includes(item.status));
      if (action.sourceMessageId !== acknowledgedId && !received) continue;
      // Legacy journals escalated native uncertainty; restore the phase it interrupted.
      if (run.status === "escalated" && action.previousStatus) run.status = action.previousStatus;
      if (run.error === action.reason) delete run.error;
      delete run.pendingAction; changed = true;
    }
    return changed;
  }
  private durablySettledNative(state: JournalState, message: RoleMessage): boolean {
    // A durable authenticated refusal proves this exact envelope reached Runtime; it does not discharge its assignment.
    return message.idempotency_key !== undefined && state.inbox.some(item => ["received", "applied", "rejected"].includes(item.status) &&
      nativeMessageFingerprint(item.message) === nativeMessageFingerprint(message));
  }
  private assertNativeMessageConsistent(state: JournalState, message: RoleMessage): void {
    const matches = (other: RoleMessage) => other.message_id === message.message_id ||
      message.idempotency_key !== undefined && other.idempotency_key === message.idempotency_key;
    const known = [...state.inbox.map(item => item.message),
      ...state.runs.flatMap(run => [...(run.nativeDeliveries ?? []), ...(run.nativeDiagnosticFences ?? [])].map(entry => entry.message))];
    if (known.some(other => matches(other) && nativeMessageFingerprint(other) !== nativeMessageFingerprint(message)))
      throw new Error("Conflicting native delivery message");
  }
  private retainNativeIntent(state: JournalState, message: RoleMessage, operationId: string): RunRecord | undefined {
    this.assertNativeMessageConsistent(state, message);
    if (this.fencedDiagnostic(state, message)) return undefined;
    const run = state.runs.find(item => item.runId === message.run_id);
    if (!run || message.correlation_id !== run.delegation.correlationId || this.refused(state, message.message_id)) return undefined;
    const pending = run.nativeDeliveries ?? (run.nativeDeliveries = []);
    const prior = pending.find(entry => entry.operationId === operationId || entry.message.message_id === message.message_id);
    if (prior && (prior.operationId !== operationId || digest(prior.message) !== digest(message))) throw new Error("Conflicting native delivery intent");
    if (!prior && !this.durablySettledNative(state, message))
      pending.push({ operationId: textField(operationId), message });
    return run;
  }
  private fencedDiagnostic(state: JournalState, message: RoleMessage) {
    return state.runs.flatMap(run => run.nativeDiagnosticFences ?? []).find(fence => fence.message.message_id === message.message_id ||
      message.idempotency_key !== undefined && fence.message.idempotency_key === message.idempotency_key);
  }
  private async refuseFencedDiagnostic(state: JournalState, save: () => Promise<void>, message: RoleMessage): Promise<void> {
    this.assertNativeMessageConsistent(state, message);
    if (!this.fencedDiagnostic(state, message)) return;
    const reason = "Native diagnostic was fenced by an authenticated human without a delivery claim; late admission is forbidden";
    const existing = state.inbox.find(item => item.message.message_id === message.message_id);
    if (!existing) { state.inbox.push({ message, status: "rejected", reason }); await save(); }
    throw new AdmissionRejectedError(reason);
  }
  /** Trusted physical Conversation command only. Cancels a stale diagnostic, never settles its transport as delivered/not-delivered. */
  async fenceNativeDiagnostic(input: unknown): Promise<JsonValue> {
    const authority = NativeDiagnosticFenceAuthoritySchema.parse(input);
    if (!await this.ports.authorizeNativeDiagnosticFence?.(authority)) throw new Error("Diagnostic fence requires authenticated physical human authority");
    return this.transaction(async (state, save) => {
      const priorRuns = state.runs.filter(run => run.nativeDiagnosticFences?.some(item => item.operationId === authority.operationId));
      if (priorRuns.length > 1) throw new Error("Ambiguous diagnostic fence operation");
      const priorRun = priorRuns[0];
      if (priorRun) {
        if (priorRun.delegation.sessionId !== authority.sessionId) throw new Error("Cross-session diagnostic fence");
        return json({ runId: priorRun.runId, operationId: authority.operationId, alreadyFenced: true,
          disposition: "fenced_without_delivery_claim", delivery: "unknown_delivery", resendAllowed: false });
      }
      const candidates = state.runs.filter(item => item.nativeDeliveries?.some(entry => entry.operationId === authority.operationId));
      if (candidates.length !== 1) throw new Error("No unique unresolved native operation with this ID");
      const run = candidates[0]!;
      if (run.delegation.sessionId !== authority.sessionId) throw new Error("Cross-session diagnostic fence");
      if (run.cancelled || ["completed", "failed", "cancelled"].includes(run.status) ||
          run.approval !== undefined && run.decision?.approvalId !== run.approval.approvalId ||
          Object.values(run.userDecisions ?? {}).some(item => item.status === "pending")) throw new Error("A pending human gate must be resolved before diagnostic fencing");
      const intent = run.nativeDeliveries!.find(entry => entry.operationId === authority.operationId)!;
      const fence = NativeDiagnosticFenceSchema.parse({ ...authority, message: intent.message, decidedAt: this.now(), disposition: "fenced_without_delivery_claim" });
      if (state.inbox.some(item => item.message.message_id === fence.message.message_id ||
          fence.message.idempotency_key !== undefined && item.message.idempotency_key === fence.message.idempotency_key))
        throw new Error("Admitted native messages require receipt reconciliation, not fencing");
      const currentValue = unwrap(await this.ports.panes.getRoleBinding("coordinator"));
      if (!currentValue) throw new Error("Current Coordinator session is unavailable");
      const current = PaneBindingSchema.parse(currentValue), health = unwrap(await this.ports.panes.inspectRoleHealth("coordinator"));
      if (!current.session || current.role !== "coordinator" || current.agentId !== fence.message.sender.agent_id ||
          current.paneId === fence.message.sender.pane_id || !health.occupantMatches || health.paneId !== current.paneId || health.agentId !== current.agentId)
        throw new Error("Only a diagnostic from a retired Coordinator pane can be fenced");
      run.nativeDiagnosticFences = [...run.nativeDiagnosticFences ?? [], fence];
      if (state.version < 2) state.version = 2; // Old binaries must reject the journal rather than ignore a durable late-arrival fence.
      run.nativeDeliveries = run.nativeDeliveries!.filter(item => item !== intent);
      await save();
      return json({ runId: run.runId, operationId: authority.operationId, disposition: fence.disposition,
        delivery: "unknown_delivery", resendAllowed: false, lateAdmissionDenied: true });
    });
  }
  /** Human authorization for one fresh independent workflow Reviewer; no verdict, stop or delivery claim about the original. */
  async replaceWorkflowReview(input: unknown): Promise<JsonValue> {
    const authority = NativeDiagnosticFenceAuthoritySchema.parse(input);
    if (!await this.ports.authorizeReviewReplacement?.(authority)) throw new Error("Review replacement requires authenticated physical human authority");
    return this.transaction(async (state, save, core) => {
      const original = state.outbound.find(item => item.message.message_id === authority.operationId);
      if (!original?.handle || original.message.type !== "verification.requested") throw new Error("No exact delivered workflow review to replace");
      const run = this.run(state, original.message.run_id!);
      if (run.delegation.sessionId !== authority.sessionId) throw new Error("Cross-session workflow review replacement");
      if (original.reviewReplacement) {
        this.gateWaiters.get(original.message.message_id)?.reject(new Error("Workflow review replaced by physical human authority; no original verdict claimed"));
        return json({ alreadyReplaced: true, ...original.reviewReplacement });
      }
      const context = QualityGateContextSchema.parse(original.message.payload), details = record(context.input), config = record(context.definition.configuration);
      if (context.taskId !== FINAL_TASK || details.scope !== "workflow" || config.kind !== "review" || !["reviewer", "qa"].includes(String(config.role)) || original.message.recipient.role !== config.role ||
          !["accepted", "released"].includes(original.status) || !original.request || digest(original.request.context) !== digest(original.message) ||
          original.leaseRenewal || original.leaseReacquisition || original.status === "accepted" && (!original.lease || Date.parse(original.lease.expiresAt) > Date.parse(this.now())) ||
          original.status === "released" && original.leaseRelease)
        throw new Error("Only a released or expired known-delivered workflow review request is replaceable");
      const paused = run.status === "escalated" && run.error?.startsWith(VERIFICATION_RETRY_PREFIX) && !run.workflowVerificationPending &&
        run.pendingAction?.kind === "resume_coordinator" && run.pendingAction.state === "pending" && run.pendingAction.previousStatus === "verifying";
      const waiting = run.status === "verifying" && run.workflowVerificationPending && this.gateWaiters.has(original.message.message_id);
      if (run.cancelled || (!paused && !waiting) || run.approval && run.decision?.approvalId !== run.approval.approvalId || Object.values(run.userDecisions ?? {}).some(item => item.status === "pending"))
        throw new Error("Workflow review replacement waits for its exact verification waiter/blocker and all human gates");
      if (run.nativeDeliveries?.length || state.outbound.some(item => item.message.run_id === run.runId && ["sending", "unknown_delivery"].includes(item.status)) ||
          state.pendingVerifications.some(item => record(item.job).runId === run.runId)) throw new Error("Uncertain delivery or pending verification must be reconciled first");
      if (state.inbox.some(item => item.message.causation_id === original.message.message_id && item.message.type === "review.verdict" && item.status !== "rejected"))
        throw new Error("A received review verdict must be reconciled before replacement");
      if (!run.workflowChange || details.sourceRevision !== run.workflowChange.headCommitHash || !/^[a-f0-9]{40}$/.test(String(details.sourceRevision)) ||
          !run.workflowSpec || details.specFingerprint !== digest(run.workflowSpec.specification) || run.tasks.some(task => !task.writerReleased || !task.result || task.cycle?.status !== "passed"))
        throw new Error("Workflow review replacement must retain the exact verified integrated revision and specification");
      for (const task of run.tasks) this.ports.policies.assertEvidenceComplete(task.spec.strategy);
      const snapshot = await core.snapshot(run.runId);
      if (!snapshot.tasks.length || snapshot.tasks.some(task => task.status !== "succeeded")) throw new Error("Implementation tasks are not independently completed");
      if (state.outbound.filter(item => item.message.run_id === run.runId && item.reviewReplacement).length >= run.maxIterations)
        throw new Error("Workflow review replacement bound exhausted");
      const contextDigest = digest(context), replacementMessageId = `review-replacement-${digest([run.runId, authority.operationId, authority.userMessageId, contextDigest])}`;
      original.reviewReplacement = { ...authority, decidedAt: this.now(), contextDigest, replacementMessageId, disposition: "replaced_without_verdict_claim" };
      const markerVersion = config.role === "qa" || original.status === "accepted" ? 5 : 4;
      if (state.version < markerVersion) state.version = markerVersion;
      await save(); // Durable late-result fence before any new invocation; old binaries must reject it.
      // Cease this local wait only. This neither stops the provider nor supplies an old verdict; ordinary bounded verification records the environment block.
      this.gateWaiters.get(original.message.message_id)?.reject(new Error("Workflow review replaced by physical human authority; no original verdict claimed"));
      return json({ runId: run.runId, ...original.reviewReplacement, originalDelivery: "known_delivered", originalOutcome: "unknown", resendAllowed: false });
    });
  }
  /** Physical human retirement, never a statement that an old measurement did or did not execute. */
  async retirePolicyPhase(input: unknown): Promise<JsonValue> {
    const authority = NativeDiagnosticFenceAuthoritySchema.parse(input);
    if (!await this.ports.authorizePolicyPhaseRetirement?.(authority)) throw new Error("Policy phase retirement requires authenticated physical human authority");
    return this.transaction(async (state, save, core, outbox) => {
      const request = state.outbound.find(item => item.message.message_id === authority.operationId);
      if (!request?.handle || request.message.type !== "verification.requested" || record(request.message.payload).kind !== "conditional_evidence")
        throw new Error("No exact policy-phase execution to retire");
      const run = this.run(state, request.message.run_id!), payload = record(request.message.payload);
      if (run.delegation.sessionId !== authority.sessionId) throw new Error("Cross-session policy retirement");
      if (request.phaseRetirement) {
        await this.recoverPolicyPhaseRetirements(state, save, outbox);
        return json({ alreadyRetired: true, operationId: authority.operationId, disposition: request.phaseRetirement.disposition });
      }
      if (run.cancelled || ["completed", "failed", "cancelled"].includes(run.status) || !["accepted", "released"].includes(request.status) || request.phaseFailure ||
          run.nativeDeliveries?.length || state.outbound.some(item => item.message.run_id === run.runId && ["sending", "unknown_delivery"].includes(item.status)) ||
          run.approval !== undefined && run.decision?.approvalId !== run.approval.approvalId || Object.values(run.userDecisions ?? {}).some(item => item.status === "pending"))
        throw new Error("Pending governance or uncertain delivery prevents phase retirement");
      const current = (await core.snapshot(run.runId)).tasks.find(item => item.taskId === payload.taskId);
      if (current?.status !== "running" || current.attemptId !== payload.implementationAttemptId) throw new Error("Policy phase belongs to another implementation attempt");
      const task = run.tasks.find(item => item.taskId === payload.taskId)!;
      const receipts = task.spec.strategy.metadata?.tddEvidence ?? [];
      if (!Array.isArray(receipts) || receipts.some(item => record(VerificationResultSchema.parse(item).metadata?.conditionalTdd).phase === payload.phase) ||
          state.inbox.some(item => item.message.type === "verification.result" && item.message.causation_id === request.message.message_id) ||
          !this.ports.hasPolicyPhaseReceipt || await this.ports.hasPolicyPhaseReceipt(request.message)) throw new Error("Existing host evidence must be reconciled before retirement");
      const target = request.handle.target, replacement = unwrap(await this.ports.panes.getRoleBinding(request.selector));
      const health = unwrap(await this.ports.panes.inspectRoleHealth(request.selector));
      if (!target.session || !replacement?.session || replacement.agentId !== target.agentId || replacement.paneId === target.paneId || digest(replacement.session) === digest(target.session) ||
          !health.occupantMatches || health.paneId !== replacement.paneId || health.agentId !== replacement.agentId ||
          !request.lease || request.leaseRelease || request.leaseRenewal || request.leaseReacquisition || Date.parse(request.lease.expiresAt) > Date.parse(this.now())) throw new Error("Retirement requires a retired verifier binding and expired capacity; expiry alone proves no process outcome");
      const blocked = state.inbox.find(item => item.status === "applied" && item.message.causation_id === request.message.message_id &&
        item.message.run_id === run.runId && item.message.correlation_id === request.message.correlation_id && item.message.type === "task.status" &&
        item.message.sender.role === request.message.recipient.role && item.message.sender.agent_id === target.agentId && item.message.sender.pane_id === target.paneId &&
        specialistBlockage(item.message.payload) !== undefined);
      if (!blocked) throw new Error("No exact authenticated verifier blocker to retire");
      const retirements = state.outbound.filter(item => item.message.run_id === run.runId && item.phaseRetirement &&
        record(item.message.payload).taskId === payload.taskId && record(item.message.payload).implementationAttemptId === payload.implementationAttemptId && record(item.message.payload).phase === payload.phase);
      if (retirements.length >= run.maxIterations) throw new Error("Policy phase retirement bound exhausted");
      request.phaseRetirement = { ...authority, blockedReplyId: blocked.message.message_id, decidedAt: this.now(), disposition: "retired_without_measurement_claim" };
      if (state.version < 3) state.version = 3;
      await save(); // Durable late-result fence before capacity release or any continuation.
      await this.recoverPolicyPhaseRetirements(state, save, outbox);
      return json({ operationId: authority.operationId, disposition: request.phaseRetirement.disposition, lateAdmissionDenied: true,
        originalRequestPreserved: true, resendAllowed: false, next: "Resume this same run through Conversation; no measurement, approval or implementation authority is granted." });
    });
  }
  private async recoverPolicyPhaseRetirements(state: JournalState, save: () => Promise<void>, outbox: HerdrOutbox): Promise<void> {
    for (const request of state.outbound.filter(item => item.phaseRetirement)) {
      // Registry has no release operation for expired leases. Keep its grant and make no release receipt claim.
      if (request.status !== "cancelled") { request.status = "cancelled"; request.error = "Policy phase retired without a measurement or remote-stop claim; prior lease expired"; await save(); }
      const run = this.run(state, request.message.run_id!), payload = record(request.message.payload);
      if (this.quiesced || !request.phaseRetirement!.resumeAuthorizedBy || run.cancelled || run.status !== "implementing" || run.nativeDeliveries?.length ||
          run.approval !== undefined && run.decision?.approvalId !== run.approval.approvalId || Object.values(run.userDecisions ?? {}).some(item => item.status === "pending") ||
          state.outbound.some(item => item.message.run_id === run.runId && ["sending", "unknown_delivery"].includes(item.status))) continue;
      const task = run.tasks.find(item => item.taskId === payload.taskId);
      if (!task || task.writerReleased || task.result || state.outbound.some(item => item !== request && item.message.run_id === run.runId && item.message.type === "verification.requested" &&
          record(item.message.payload).taskId === payload.taskId && record(item.message.payload).phase === payload.phase && !item.phaseFailure && !item.phaseRetirement && item.status !== "cancelled")) continue;
      const raw = task.spec.strategy.metadata?.tddEvidence ?? [];
      if (!Array.isArray(raw)) throw new Error("Corrupt measurement history");
      const expected = task.spec.strategy.tddDecision.mode === "required" ? ["red", "green", "refactor"][raw.length] : raw.length === 0 ? "verification" : undefined;
      if (payload.phase !== expected) continue;
      const parent = state.outbound.find(item => item.message.run_id === run.runId && item.message.type === "task.assignment" && item.taskId === task.taskId && item.status === "accepted" && item.handle?.attemptId === payload.implementationAttemptId);
      if (!parent) continue;
      const id = `phase-notice-${digest([run.runId, task.taskId, payload.phase, request.message.message_id])}`;
      const prior = state.outbound.find(item => item.message.message_id === id);
      if (prior && ["sending", "unknown_delivery"].includes(prior.status)) continue;
      const revive = prior?.status === "cancelled" && !prior.request && !prior.handle && prior.error?.includes("parent lease is expired");
      if (prior && !revive && !parent.leaseReacquisition && parent.lease && Date.parse(parent.lease.expiresAt) > Date.parse(this.now())) continue;
      try { await outbox.recoverTaskLease(parent, request); }
      catch (error) { parent.error = `Task lease continuation blocked: ${String(error)}`; await save(); continue; }
      if (prior) { if (revive) { prior.status = "queued"; delete prior.error; await save(); } continue; }
      this.phaseNotice(state, outbox, run, task, textField(payload.phase), "retry", `The prior verifier request was retired by a physical human decision without claiming any measurement outcome. Request the same phase at ${textField(payload.sourceRevision)} again. This grants no Red evidence or implementation authority.`, request.message.message_id);
      await save();
    }
  }
  async nativeDiagnosticFenceStatus(operationId: string): Promise<JsonValue> {
    return this.journal.exclusive(async state => json(state.runs.flatMap(run => run.nativeDiagnosticFences ?? [])
      .find(item => item.operationId === textField(operationId)) ?? null));
  }
  /** Trusted host write-ahead before native invocation. No transport or business success is inferred. */
  async recordNativeDeliveryIntent(input: unknown, operationId: string): Promise<void> {
    const message = RoleMessageSchema.parse(input);
    await this.transaction(async (state, save) => { if (this.retainNativeIntent(state, message, operationId)) await save(); });
  }
  /** Trusted private ingress evidence only. Settles an inadmissible envelope, never an assignment or human gate. */
  async recordNativeDeliveryRejection(input: unknown): Promise<void> {
    const refusal = NativeRejectionSchema.parse(input);
    await this.transaction(async (state, save) => {
      const run = state.runs.find(item => item.runId === refusal.message.run_id && item.delegation.correlationId === refusal.message.correlation_id);
      if (!run?.nativeDeliveries) return;
      const prior = run.nativeDeliveries.find(entry => entry.message.message_id === refusal.message.message_id);
      if (!prior) return;
      if (nativeMessageFingerprint(prior.message) !== nativeMessageFingerprint(refusal.message)) throw new Error("Native refusal ownership mismatch");
      if (state.inbox.some(item => item.message.message_id === refusal.message.message_id)) throw new Error("Native refusal conflicts with admitted message");
      run.nativeDeliveries = run.nativeDeliveries.filter(entry => entry !== prior);
      await save();
    });
  }
  /**
   * A native delivery whose acknowledgement was not observed. Conversation and the Coordinator see `delivery_failure` with the
   * operation id. The message is never resent here; reconciliation decides what happened.
   */
  async reportUncertainNativeDelivery(input: unknown, operationId: string, reason: string): Promise<void> {
    const message = RoleMessageSchema.parse(input);
    if (!message.run_id) return;
    await this.transaction(async (state, save, _core, outbox) => {
      this.assertNativeMessageConsistent(state, message);
      if (this.durablySettledNative(state, message)) {
        if (this.settleNativeDeliveries(state)) await save();
        return;
      }
      const run = this.retainNativeIntent(state, message, operationId);
      if (!run) return;
      // Preserve uncertainty even while a schema blocker/human gate pauses the run. Business status cannot erase a transport intent.
      if (run.cancelled || TERMINAL_RUN_STATUSES.includes(run.status) && !resumablyPaused(run)) { await save(); return; }
      const subject = `native delivery ${operationId} (${message.type} to ${message.recipient.role}, ${message.message_id})`;
      // Not an escalation: a native ACK can arrive after the host deadline while the message is applied normally. The durable
      // action records the no-resend reconciliation (cleared by the late ACK/application) without making the run terminal.
      const alreadyApplied = state.inbox.some(item => item.message.message_id === message.message_id && item.status === "applied");
      if (!run.pendingAction && !alreadyApplied && run.status !== "awaiting_approval" && !Object.values(run.userDecisions ?? {}).some(item => item.status === "pending")) {
        const blockage = `Unknown delivery for ${message.type} to ${message.recipient.role} (${operationId}); reconcile the original operation before any resend.`;
        run.pendingAction = { actionId: `next-${digest([run.runId, message.message_id])}`, kind: "reconcile_delivery", owner: "coordinator",
          reason: blockage, sourceMessageId: message.message_id, createdAt: this.now(), state: "pending", previousStatus: run.status, recovery: "reconcile_delivery" };
      }
      this.surfaceFailure(state, outbox, run, message.message_id, "transport_uncertain", subject, redactString(reason));
      if (message.recipient.role !== "coordinator" && message.sender.role !== "coordinator") {
        const wakeId = `p19-wake-${digest([run.runId, "delivery-failure", operationId])}`;
        if (!state.outbound.some(out => out.message.message_id === wakeId)) {
          outbox.enqueue(RoleMessageSchema.parse({ schema_version: 2, message_id: wakeId, correlation_id: run.delegation.correlationId,
            causation_id: message.message_id, run_id: run.runId, sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status",
            payload: { kind: "delivery_failure", operationId, sdlcStatus: run.status, reason: redactString(reason),
              next: "A delivery is unconfirmed and is not resent. Inspect the run state before assuming the recipient acted." },
            artifact_references: [], occurred_at: this.now(), idempotency_key: wakeId }), "coordinator");
        }
      }
      await save();
    });
  }
}
interface VerificationJob {
  runId: string; taskId: string; plan: VerificationPlan; cycle: import("@bflow/contracts").VerificationCycle;
  change: import("@bflow/contracts").GitChangeSet; options: unknown;
}
