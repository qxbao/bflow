import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { RoleProfileCatalogSchema, RoleProfilePinSchema, ExecutorLineageSchema, sameRoleProfilePin, type RoleProfilePin, type ResolvedRoleProfileSnapshot, type ExecutorLineage } from "@bflow/contracts";
import {
  AcquireAgentLeaseRequestSchema, AgentAssignmentSchema, AgentExecutionHandleSchema, AgentLeaseSchema, AgentRequestSchema, AgentRoleSchema,
  AgentResultSchema, AppendEventsRequestSchema, ApprovalDecisionSchema, ApprovalRequestSchema, ArtifactReferenceSchema, PaneBindingSchema,
  DelegationRequestSchema, GitChangeSetSchema, IsoDateTimeSchema, JsonValueSchema, RoleMessageSchema, RenewAgentLeaseRequestSchema, ReleaseAgentLeaseRequestSchema,
  ExecutionPlanExpectationSchema, PlanDiffSchema, SdlcWorkStatusSchema, SpecificationSchema, TestStrategySchema, VerificationCycleSchema,
  VerificationResultSchema, WorkflowDefinitionSchema, type AgentAssignment, type AgentExecutionHandle, type AgentLease,
  type AcquireAgentLeaseRequest, type AgentRequest, type AgentResult, type AppendEventsRequest, type ApprovalDecision,
  type AgentRole, type ApprovalRequest, type DelegationRequest, type GitChangeSet, type JsonValue, type ArtifactReference,
  type RoleMessage, type SdlcWorkStatus, type Specification, type TestStrategy, type PaneBinding,
  type VerificationCycle, type WorkflowDefinition, type RenewAgentLeaseRequest, type ReleaseAgentLeaseRequest
} from "@bflow/contracts";
import type { TaskWorktree, VerificationPlan } from "./ports.js";
import { isUserDecisionRequest, validateUserDecisionAnswer, type UserDecisionAnswer } from "./decision-routing.js";
import { WorkflowRejectionCodeSchema } from "./workflow-rejection.js";
import { NativeDiagnosticFenceSchema, type NativeDiagnosticFence } from "./native-diagnostic-fence.js";
import { ReworkResolutionDossierSchema, type ReworkResolutionDossier } from "./rework-causality.js";
import { CancellationStopProofSchema, NamespaceExitProofSchema, ownsCancelledAllocation, type CancellationStopProof, type NamespaceExitProof } from "./cancellation-stop.js";
import { PrototypeRecordSchema, type PrototypeRecord } from "./prototype-review.js";
import { TaskFailoverSchema, type TaskFailover } from "./provider-failover-state.js";

export function json(value: unknown): JsonValue { return JsonValueSchema.parse(JSON.parse(JSON.stringify(value))); }
export function digest(value: unknown): string {
  const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical)}]` : v !== null && typeof v === "object"
    ? `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)}}`
    : JSON.stringify(v) ?? "null";
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function textField(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected nonempty string");
  return value;
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Expected a string array");
  return value.map(textField);
}
export interface SpecRecord {
  specification: Specification; request: ApprovalRequest; decision?: ApprovalDecision; strategy: TestStrategy;
}
export interface TaskRecord {
  failovers?: TaskFailover[];
  taskId: string; spec: SpecRecord; worktrees: TaskWorktree[]; outboundIds: string[];
  changeSet?: GitChangeSet; cycle?: VerificationCycle; result?: AgentResult;
  verificationPlan?: VerificationPlan; verificationPending?: boolean; writerReleased?: boolean;
  /** Validated root-cause rework dossiers submitted per rework attempt; absent in legacy journals/checkpoints. */
  reworkResolutions?: ReworkResolutionDossier[];
  /** Attempt whose dependency-base merge conflicted; it starts from the run base so final integration resolves the overlap. */
  dependencyBaseFallback?: string;
}
export interface IngressDiagnostic {
  messageId: string; type: string; senderRole: string; recipientRole: string; reason: string; at: string;
  /** `continued`: the accepted, leased delivery stood and the run kept going; `escalated`: the run paused; `reported`: notice only. */
  disposition: "continued" | "escalated" | "reported";
}
export interface RunRecord {
  roleProfiles?: ResolvedRoleProfileSnapshot[];
  roleProfileDefaults?: Partial<Record<import("@bflow/contracts").AgentRole, RoleProfilePin>>;
  runId: string; delegation: DelegationRequest; status: SdlcWorkStatus;
  definition?: WorkflowDefinition; workflowSpec?: SpecRecord; tasks: TaskRecord[];
  executionPlan?: import("@bflow/contracts").ExecutionPlanExpectation;
  executionPlanDrift?: import("@bflow/contracts").PlanDiff;
  /** Private watch evidence retained across daemon restart; never copied into public plans. */
  executionSourceDigests?: Record<string, string>;
  baseRevision?: string; approval?: ApprovalRequest; decision?: ApprovalDecision;
  approvalKind?: "design" | "delivery" | "action" | "task";
  integrationKey?: string; workflowCycle?: VerificationCycle; workflowChange?: GitChangeSet;
  workflowVerificationPending?: boolean; coreCreated: boolean; cancelled: boolean; error?: string; maxIterations: number;
  /** Specialist/Coordinator user decisions keyed by approvalId; separate from the single design/task `approval` slot. */
  userDecisions?: Record<string, UserDecisionRecord>;
  /** Earlier admitted revisions of the requirement, oldest first. Absent in journals written before requirement changes. */
  delegationHistory?: DelegationRequest[];
  /** Approvals a later requirement revision made obsolete; their decisions are refused with the revision that superseded them. */
  supersededApprovals?: { approvalId: string; supersededByRevision: number }[];
  /** Durable semantic next action for a live run; optional for version-1 journals written before workflow liveness tracking. */
  pendingAction?: {
    actionId: string; kind: "coordinator_continuation" | "resume_coordinator" | "reconcile_delivery"; owner: "coordinator";
    reason: string; sourceMessageId: string; createdAt: string; state: "pending" | "queued"; previousStatus?: SdlcWorkStatus; resumeAttempts?: number;
    relatedMessageIds?: string[];
    /**
     * `auto_resume`: Runtime resumes this blocker itself with backoff, sharing the bounded `resumeAttempts` budget; once spent it
     * becomes `manual`. `capability_repair` resumes only after a positive capability proof. Absent/`manual`: waits for a human.
     */
    recovery?: "auto_resume" | "capability_repair" | "manual" | "reconcile_delivery";
    /** Last time this episode (or the action it inherited its budget from) was resumed; the automatic-resume backoff anchor. */
    lastResumedAt?: string;
    /** Explicit user resumes of this blocker lineage (bounded separately from `resumeAttempts`); absent in older journals means 0. */
    manualResumeAttempts?: number;
    requiredRole?: AgentRole; requiredCapabilities?: string[];
  };
  /** Durable idempotency ledger for recoverable resumes, retained even after the blocker is cleared. */
  resumeReceipts?: { actionId: string; messageId: string }[];
  /** Private native-host intents not yet acknowledged/applied. Independent of the current business blocker or human gate. */
  nativeDeliveries?: { operationId: string; message: RoleMessage }[];
  /** Authenticated human cancellation of a stale diagnostic; its original delivery stays unknown and can never be replayed. */
  nativeDiagnosticFences?: NativeDiagnosticFence[];
  /**
   * Invalid RoleMessages per (sender role, assignment/causation) key. Bounded; `messageIds` dedupes replays of one inbound
   * envelope. Absent in older journals (no invalid messages counted).
   */
  invalidMessages?: { key: string; count: number; messageIds: string[] }[];
  /** Refused provider ingress, newest last and bounded: identities and the redacted reason only, never the payload. */
  ingressDiagnostics?: IngressDiagnostic[];
  /** Set once the run's single final cancellation notice is queued; absent in journals written before cancellation reconciliation. */
  cancelReconciled?: boolean;
  cancelledAllocations?: { binding: PaneBinding; proof: NamespaceExitProof; released?: boolean | undefined }[];
  /** Set when a human `changes_requested` continued this run as a follow-up run; the parent is terminal and never resumed. */
  supersededBy?: string;
  /** Bounded automatic Developer resolver episode for the current P18 merge conflict; absent in journals written before it. */
  conflictResolution?: ConflictResolutionRecord;
  /** Structured rejection proof of the last rejected workflow proposal; cleared when a valid proposal is admitted. */
  lastWorkflowRejection?: ProposalRejectionRecord;
  /** Host-evaluated fast-path eligibility and one-way downgrade state; absent in legacy journals. */
  fastPath?: FastPathRecord;
  /** Cached workflow-level verification plan for the current integration cycle. */
  workflowVerificationPlan?: VerificationPlan;
  /** Host-measured native review gate waits, newest last (at most 200). Absent in journals written before review telemetry. */
  reviewTimings?: ReviewTiming[];
  /** Optional prototype review branch before the formal design; absent for runs that do not use a prototype. */
  prototype?: PrototypeRecord;
}
/** Host wall time of one native review gate wait: from the verification request to its settlement. Never a Reviewer claim. */
export interface ReviewTiming {
  key: string; gateId: string; role: string; taskId?: string | undefined; agentId?: string | undefined; provider?: string | undefined;
  startedAt: string; completedAt?: string | undefined; timeoutMs: number;
  outcome?: "verdict" | "rejected" | "timeout" | "aborted" | undefined; nearDeadlineAt?: string | undefined;
}
const ReviewTimingSchema = z.object({
  key: z.string().min(1), gateId: z.string().min(1), role: z.string().min(1), taskId: z.string().min(1).optional(),
  agentId: z.string().min(1).optional(), provider: z.string().min(1).optional(), startedAt: IsoDateTimeSchema,
  completedAt: IsoDateTimeSchema.optional(), timeoutMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outcome: z.enum(["verdict", "rejected", "timeout", "aborted"]).optional(), nearDeadlineAt: IsoDateTimeSchema.optional()
}).strict();
const rejectionText = z.string().min(1).max(2000);
const FastPathDowngradeSchema = z.object({
  reason: rejectionText,
  at: IsoDateTimeSchema,
  scope: z.enum(["task", "workflow"])
}).strict();
const FastPathRecordSchema = z.object({
  status: z.enum(["active", "inactive", "downgraded"]),
  decidedAt: IsoDateTimeSchema,
  blockers: z.array(rejectionText).max(50),
  reasons: z.array(rejectionText).max(50),
  classificationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  downgrade: FastPathDowngradeSchema.optional()
}).strict();
export type FastPathRecord = z.infer<typeof FastPathRecordSchema>;
const ProposalRejectionSchema = z.object({
  code: WorkflowRejectionCodeSchema, reason: rejectionText,
  episodeNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sourceMessageId: rejectionText, actionId: rejectionText, rejectedAt: IsoDateTimeSchema,
  rejectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  previousStatus: SdlcWorkStatusSchema.refine(status => !["escalated", "completed", "failed", "cancelled"].includes(status)).optional(),
  options: z.array(rejectionText).max(100).optional(), methods: z.array(rejectionText).max(100).optional(),
  criteria: z.array(rejectionText).max(100).optional()
}).strict();
export type ProposalRejectionRecord = z.infer<typeof ProposalRejectionSchema>;
/** One P18 conflict (identified by its deterministic request message) and the resolver attempts assigned for it. */
export interface ConflictResolutionRecord {
  roleProfile?: RoleProfilePin;
  conflictId: string; integrationKey: string; taskKey: string; conflictPaths: string[];
  worktreePath: string; branchName: string; incomingCommitHash?: string;
  attempts: ConflictResolverAttempt[];
}
export interface ConflictResolverAttempt {
  messageId: string; taskId: string; attemptId: string; agentName: string;
  /** assigned: the Developer owns the preserved worktree; accepted: P18 accepted its commit; failed: the attempt ended without acceptance. */
  status: "assigned" | "accepted" | "failed"; reason?: string; commitHash?: string;
  /** The Developer pane and lease were released after the pane was observed idle. */
  settled?: boolean;
}
function parseConflictResolution(value: unknown): void {
  const item = record(value);
  if (item.roleProfile !== undefined) RoleProfilePinSchema.parse(item.roleProfile);
  for (const key of ["conflictId", "integrationKey", "taskKey", "worktreePath", "branchName"]) textField(item[key]);
  strings(item.conflictPaths);
  if (item.incomingCommitHash !== undefined) textField(item.incomingCommitHash);
  if (!Array.isArray(item.attempts) || item.attempts.length > 2) throw new Error("Invalid conflict resolver attempts");
  for (const attempt of item.attempts.map(record)) {
    for (const key of ["messageId", "taskId", "attemptId", "agentName"]) textField(attempt[key]);
    if (!["assigned", "accepted", "failed"].includes(String(attempt.status))) throw new Error("Invalid conflict resolver attempt status");
    if (attempt.reason !== undefined) textField(attempt.reason);
    if (attempt.commitHash !== undefined && !/^[a-f0-9]{40}$/.test(String(attempt.commitHash))) throw new Error("Invalid conflict resolution commit");
    if (attempt.settled !== undefined && typeof attempt.settled !== "boolean") throw new Error("Invalid conflict resolver settlement");
  }
}
/** Runtime-private evidence binding; only the dedicated host request method authors this marker. */
export const TestIntegrityExceptionBindingSchema = z.object({
  runId: z.string().min(1), taskId: z.string().min(1), attemptId: z.string().min(1),
  baseRevision: z.string().regex(/^[a-f0-9]{40}$/), candidateRevision: z.string().regex(/^[a-f0-9]{40}$/),
  specFingerprint: z.string().regex(/^[a-f0-9]{64}$/), scope: z.enum(["task", "workflow"]),
  findingId: z.string().min(1).max(200), reviewMessageId: z.string().min(1), evidence: ArtifactReferenceSchema
}).strict();
export interface UserDecisionRecord {
  request: ApprovalRequest; role: AgentRole; agentId: string; paneId: string; taskId: string;
  status: "pending" | "answered" | "rejected" | "expired" | "cancelled"; answer?: UserDecisionAnswer; decision?: ApprovalDecision;
}
function parseUserDecisions(value: unknown, runId: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid user decision journal");
  for (const [approvalId, entry] of Object.entries(value as Record<string, unknown>)) {
    const item = record(entry);
    const request = ApprovalRequestSchema.parse(item.request);
    if (request.approvalId !== approvalId || request.runId !== runId || !isUserDecisionRequest(request)) throw new Error("Invalid user decision request");
    AgentRoleSchema.parse(item.role); textField(item.agentId); textField(item.paneId); textField(item.taskId);
    // "cancelled" is additive (run cancellation); older journals never contain it, so existing states parse unchanged.
    const status = String(item.status);
    if (!["pending", "answered", "rejected", "expired", "cancelled"].includes(status)) throw new Error("Invalid user decision status");
    const mustBeUnanswered = status === "pending" || status === "cancelled";
    const mustBeAnswered = status === "answered" || status === "rejected";
    if ((mustBeUnanswered && item.answer !== undefined) || (mustBeAnswered && item.answer === undefined)) throw new Error("Invalid user decision answer state");
    if (item.answer !== undefined) {
      const answer = record(item.answer); textField(answer.outcome);
      if (answer.selectedOption !== undefined) textField(answer.selectedOption);
    }
    if (item.decision !== undefined) {
      const decision = ApprovalDecisionSchema.parse(item.decision);
      if (!mustBeAnswered || digest(validateUserDecisionAnswer(request, decision, decision.decidedAt)) !== digest(item.answer))
        throw new Error("Invalid authenticated user decision receipt");
    }
    if (request.metadata?.testIntegrityException !== undefined) {
      const binding = TestIntegrityExceptionBindingSchema.parse(request.metadata.testIntegrityException);
      if (binding.runId !== runId || binding.taskId !== item.taskId || item.role !== "reviewer" ||
          (mustBeAnswered && item.decision === undefined)) throw new Error("Invalid test-integrity exception journal binding");
    }
  }
}
export interface Outbound {
  roleProfile?: RoleProfilePin;
  profileAllocationTaskId?: string;
  profileAllocationReleased?: boolean;
  executorLineage?: ExecutorLineage;
  /** "failed" is terminal for Conversation-bound inbox writes only (after bounded Gateway retries); it is never dispatched to Herdr. */
  message: RoleMessage; status: "queued" | "sending" | "unknown_delivery" | "accepted" | "released" | "cancelled" | "delivered" | "failed";
  /** First time the recipient was observed not ready for a prompt; cleared once it is ready. Durable for the not-ready escalation. */
  notReadySince?: string;
  /** Consecutive failed delivery attempts (Gateway writes or dispatch exceptions). Reset on success. */
  deliveryAttempts?: number;
  /** Earliest time a failed Conversation inbox write may be retried (backoff). */
  nextAttemptAt?: string;
  /** Conversation-bound notices are delivered through the trusted inbox: terminal, with no dispatch handle, lease or request. */
  selector: string; taskId: string; attemptId: string; capabilities: string[];
  assignment?: AgentAssignment; lease?: AgentLease; request?: AgentRequest; handle?: AgentExecutionHandle;
  error?: string; cancelRequested?: boolean;
  /** Host-observed terminal turn for this exact pinned specialist execution; never task success. */
  stopObservedAt?: string;
  /** Stop observations made for a cancelled execution; bounded so an unresponsive pane is reported instead of polled forever. */
  cancelObservations?: number;
  /** Private v6 write-ahead proof; never inferred from legacy cancellation flags. */
  cancellationStopProof?: CancellationStopProof;
  cancellationLeaseDisposition?: "released" | "expired";
  phaseRetirement?: { operationId: string; sessionId: string; userMessageId: string; userId: string;
    blockedReplyId: string; decidedAt: string; resumeAuthorizedBy?: string | undefined; disposition: "retired_without_measurement_claim" };
  /** Physical permission to cease waiting on one workflow review. The original request/outcome stays intact. */
  reviewReplacement?: { operationId: string; sessionId: string; userMessageId: string; userId: string; decidedAt: string;
    contextDigest: string; replacementMessageId: string; disposition: "replaced_without_verdict_claim" };
  phaseFailureEvidence?: ArtifactReference;
  /** `retryAuthorized`: an explicit resume allows re-measuring the same revision after a non-repairable (infrastructure) failure. */
  phaseFailure?: { summary: string; repairable: boolean; applied: boolean; retryAuthorized?: boolean };
  /** A control notice borrows its task assignment's lease; it never owns capacity. */
  parentAssignmentId?: string;
  /** Private outbox position captured before this Coordinator turn is physically dispatched. */
  coordinatorResponseBaseline?: number;
  leaseRenewal?: RenewAgentLeaseRequest;
  /** Prior Registry leases of this same immutable execution; never rewrites its original assignment/request/handle. */
  leaseHistory?: AgentLease[];
  /** Write-ahead Registry request for an explicitly authorized, continuity-checked lease continuation. */
  leaseReacquisition?: AcquireAgentLeaseRequest;
  leaseRelease?: ReleaseAgentLeaseRequest;
}
export interface JournalState {
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7; repository: string; runs: RunRecord[]; outbound: Outbound[];
  /** "rejected" is terminal and carries Runtime's reason: the message was refused by admission and must never be retried. */
  inbox: { message: RoleMessage; status: "received" | "applied" | "rejected"; reason?: string }[];
  pendingCore: AppendEventsRequest[];
  /** attempts/lastError/stuck: bounded retry bookkeeping for a durable verification outcome that cannot be finished yet. */
  pendingVerifications: { job: JsonValue; outcome: JsonValue; attempts?: number; lastError?: string; stuck?: boolean }[];
}
/** Conversation-bound messages use the trusted inbox: no lease, no transport, no dispatch request, never typed into the input box. */
export function isConversationDelivery(out: Outbound): boolean {
  return !out.parentAssignmentId && out.message.recipient.role === "conversation";
}
/** Private storage codec; exported schemas validate every persisted boundary value. */
export function parseAgenticJournalState(input: unknown, repository: string): JournalState {
  const root = record(input);
  if (typeof root.version !== "number" || ![1, 2, 3, 4, 5, 6, 7].includes(root.version) || root.repository !== repository) throw new Error("Unsupported or foreign P19 journal");
  for (const key of ["runs", "outbound", "inbox", "pendingCore", "pendingVerifications"]) if (!Array.isArray(root[key])) throw new Error(`Invalid journal ${key}`);
  const state = root as unknown as JournalState;
  for (const run of state.runs) {
    textField(run.runId); run.delegation = DelegationRequestSchema.parse(run.delegation);
    if (run.delegation.runId !== run.runId) throw new Error("Journal run/delegation mismatch");
    run.status = SdlcWorkStatusSchema.parse(run.status);
    if (run.lastWorkflowRejection !== undefined) {
      const proof = ProposalRejectionSchema.parse(run.lastWorkflowRejection);
      const revisionValue = run.delegation.metadata?.revision;
      const revision = typeof revisionValue === "number" && Number.isSafeInteger(revisionValue) ? revisionValue : 1;
      const source = `rejection-r${revision}-ep${proof.episodeNumber}-${digest([run.runId, revision, proof.episodeNumber])}`;
      if (proof.sourceMessageId !== source || proof.actionId !== `next-${digest([run.runId, source])}` ||
          proof.rejectionFingerprint !== digest([proof.code, proof.reason, proof.options ?? [], proof.methods ?? [], proof.criteria ?? []]))
        throw new Error("Invalid workflow proposal rejection identity");
      run.lastWorkflowRejection = proof;
    }
    if (typeof run.coreCreated !== "boolean" || typeof run.cancelled !== "boolean" || !Number.isInteger(run.maxIterations) || run.maxIterations < 1 || run.maxIterations > 10)
      throw new Error("Invalid run flags/limit");
    if (!Array.isArray(run.tasks)) throw new Error("Invalid task journal");
    if (run.definition) run.definition = WorkflowDefinitionSchema.parse(run.definition);
    if (run.roleProfiles !== undefined) run.roleProfiles = RoleProfileCatalogSchema.parse(run.roleProfiles);
    if (run.roleProfileDefaults !== undefined) {
      run.roleProfileDefaults = z.record(AgentRoleSchema, RoleProfilePinSchema).parse(run.roleProfileDefaults);
      for (const [role, pin] of Object.entries(run.roleProfileDefaults))
        if (!run.roleProfiles?.some(profile => sameRoleProfilePin(profile.pin, pin) && profile.definition.baseRole === role))
          throw new Error("Profile default has no pinned recovery snapshot");
    }
    if (state.version < 7 && (run.roleProfiles?.length || Object.keys(run.roleProfileDefaults ?? {}).length))
      throw new Error("Profile authority requires private journal v7");
    for (const task of run.definition?.tasks ?? []) if (task.roleProfile && !run.roleProfiles?.some(profile => sameRoleProfilePin(profile.pin, task.roleProfile) && profile.definition.baseRole === task.role))
      throw new Error("Profiled task has no pinned recovery snapshot");
    if (run.executionPlan !== undefined) run.executionPlan = ExecutionPlanExpectationSchema.parse(run.executionPlan);
    if (run.executionSourceDigests !== undefined) run.executionSourceDigests = z.record(z.string().regex(/^[a-f0-9]{64}$/)).parse(run.executionSourceDigests);
    if (run.executionPlanDrift !== undefined) run.executionPlanDrift = PlanDiffSchema.parse(run.executionPlanDrift);
    if (run.workflowSpec) parseSpec(run.workflowSpec);
    if (run.approval) run.approval = ApprovalRequestSchema.parse(run.approval);
    if (run.userDecisions !== undefined) parseUserDecisions(run.userDecisions, run.runId);
    if (run.nativeDeliveries !== undefined) {
      if (!Array.isArray(run.nativeDeliveries)) throw new Error("Invalid native delivery journal");
      const operations = new Set<string>(), messages = new Set<string>();
      for (const entry of run.nativeDeliveries) {
        textField(entry.operationId); entry.message = RoleMessageSchema.parse(entry.message);
        if (entry.message.run_id !== run.runId || entry.message.correlation_id !== run.delegation.correlationId ||
            operations.has(entry.operationId) || messages.has(entry.message.message_id)) throw new Error("Invalid native delivery ownership");
        operations.add(entry.operationId); messages.add(entry.message.message_id);
      }
    }
    if (run.nativeDiagnosticFences !== undefined) {
      if (state.version < 2) throw new Error("Diagnostic fences require private journal v2; never reinterpret them as v1");
      if (!Array.isArray(run.nativeDiagnosticFences)) throw new Error("Invalid diagnostic fences");
      run.nativeDiagnosticFences = run.nativeDiagnosticFences.map(item => NativeDiagnosticFenceSchema.parse(item));
      const ids = new Set<string>();
      for (const fence of run.nativeDiagnosticFences) {
        if (ids.has(fence.operationId) || fence.message.run_id !== run.runId || fence.message.correlation_id !== run.delegation.correlationId ||
            fence.sessionId !== run.delegation.sessionId || run.nativeDeliveries?.some(item => item.operationId === fence.operationId || item.message.message_id === fence.message.message_id))
          throw new Error("Diagnostic fence ownership or pending-delivery conflict");
        ids.add(fence.operationId);
      }
    }
    if (run.delegationHistory !== undefined) run.delegationHistory = run.delegationHistory.map(item => DelegationRequestSchema.parse(item));
    if (run.cancelReconciled !== undefined && typeof run.cancelReconciled !== "boolean") throw new Error("Invalid cancellation reconciliation flag");
    if (run.cancelledAllocations !== undefined) {
      const records = z.array(z.object({ binding: PaneBindingSchema, proof: NamespaceExitProofSchema, released: z.boolean().optional() }).strict()).parse(run.cancelledAllocations);
      if (state.version < 6 || !run.cancelled || records.some(item => !ownsCancelledAllocation(run.runId, item.binding)))
        throw new Error("Invalid cancelled allocation proof");
      run.cancelledAllocations = records;
    }
    if (run.supersededBy !== undefined && (textField(run.supersededBy) === run.runId || run.status !== "escalated" || run.pendingAction))
      throw new Error("Invalid follow-up supersession");
    if (run.pendingAction !== undefined) {
      const action = record(run.pendingAction);
      const allowed = new Set(["actionId", "kind", "owner", "reason", "sourceMessageId", "createdAt", "state", "previousStatus", "resumeAttempts", "relatedMessageIds", "recovery", "lastResumedAt", "manualResumeAttempts", "requiredRole", "requiredCapabilities"]);
      if (Object.keys(action).some(key => !allowed.has(key))) throw new Error("Invalid durable workflow next action fields");
      textField(action.actionId); textField(action.reason); textField(action.sourceMessageId); textField(action.createdAt);
      if (String(action.reason).length > 2000 || !Number.isFinite(Date.parse(String(action.createdAt))) ||
          action.actionId !== `next-${digest([run.runId, action.sourceMessageId])}`) throw new Error("Invalid durable workflow next action identity");
      if (!(["coordinator_continuation", "resume_coordinator", "reconcile_delivery"].includes(String(action.kind)) && action.owner === "coordinator" &&
          ["pending", "queued"].includes(String(action.state)))) throw new Error("Invalid durable workflow next action");
      if (action.previousStatus !== undefined) {
        const status = SdlcWorkStatusSchema.parse(action.previousStatus);
        if (["completed", "failed", "cancelled", "escalated"].includes(status)) throw new Error("Invalid resume phase in durable workflow next action");
      }
      if (action.resumeAttempts !== undefined && (!Number.isInteger(action.resumeAttempts) || Number(action.resumeAttempts) < 0 || Number(action.resumeAttempts) > 3))
        throw new Error("Invalid durable workflow resume limit");
      if (action.relatedMessageIds !== undefined && (!Array.isArray(action.relatedMessageIds) || action.relatedMessageIds.length > 100 ||
          action.relatedMessageIds.some(id => typeof id !== "string" || !id))) throw new Error("Invalid related capability failure identities");
      if (action.recovery !== undefined && !["auto_resume", "capability_repair", "manual", "reconcile_delivery"].includes(String(action.recovery)))
        throw new Error("Invalid workflow recovery classification");
      if (action.lastResumedAt !== undefined && !Number.isFinite(Date.parse(textField(action.lastResumedAt))))
        throw new Error("Invalid durable workflow resume time");
      if (action.manualResumeAttempts !== undefined && (!Number.isInteger(action.manualResumeAttempts) || Number(action.manualResumeAttempts) < 0 ||
          Number(action.manualResumeAttempts) > 3)) throw new Error("Invalid durable workflow user resume limit");
      if (action.requiredRole !== undefined) AgentRoleSchema.parse(action.requiredRole);
      if (action.requiredCapabilities !== undefined) strings(action.requiredCapabilities);
    }
    if (run.resumeReceipts !== undefined) {
      if (!Array.isArray(run.resumeReceipts) || run.resumeReceipts.length > 50) throw new Error("Invalid resume receipt ledger");
      for (const receipt of run.resumeReceipts) { textField(receipt.actionId); textField(receipt.messageId); }
      if (new Set(run.resumeReceipts.map(item => item.actionId)).size !== run.resumeReceipts.length) throw new Error("Duplicate resume receipt identity");
    }
    if (run.invalidMessages !== undefined) {
      if (!Array.isArray(run.invalidMessages) || run.invalidMessages.length > 50) throw new Error("Invalid message failure ledger");
      for (const entry of run.invalidMessages) {
        textField(entry.key);
        if (!Number.isSafeInteger(entry.count) || entry.count < 1 || entry.count > 1000) throw new Error("Invalid message failure count");
        if (!Array.isArray(entry.messageIds) || entry.messageIds.length > 10) throw new Error("Invalid message failure identities");
        strings(entry.messageIds);
      }
      if (new Set(run.invalidMessages.map(item => item.key)).size !== run.invalidMessages.length) throw new Error("Duplicate message failure key");
    }
    if (run.supersededApprovals !== undefined) for (const item of run.supersededApprovals) {
      textField(item.approvalId); if (!Number.isSafeInteger(item.supersededByRevision) || item.supersededByRevision < 2) throw new Error("Invalid superseded approval");
    }
    if (run.conflictResolution !== undefined) parseConflictResolution(run.conflictResolution);
    if (run.fastPath !== undefined) run.fastPath = FastPathRecordSchema.parse(run.fastPath);
    if (run.reviewTimings !== undefined) run.reviewTimings = z.array(ReviewTimingSchema).max(200).parse(run.reviewTimings);
    if (run.prototype !== undefined) {
      run.prototype = PrototypeRecordSchema.parse(run.prototype);
      if (run.prototype.approvals.some(entry => entry.request.runId !== run.runId)) throw new Error("Prototype approval belongs to another run");
    }
    if (run.decision) run.decision = ApprovalDecisionSchema.parse(run.decision);
    if (run.approvalKind && !["design", "delivery", "action", "task"].includes(run.approvalKind)) throw new Error("Invalid approval kind");
    for (const task of run.tasks) {
      if (task.failovers !== undefined) {
        z.array(TaskFailoverSchema).max(17).parse(task.failovers);
        if (new Set(task.failovers.map(entry => entry.switchId)).size !== task.failovers.length || task.failovers.some(entry =>
            entry.sourceHandle.runId !== run.runId || entry.sourceHandle.taskId !== task.taskId || entry.policyDigest !== digest(entry.policy)))
          throw new Error("Invalid task failover ownership or policy digest");
      }
      textField(task.taskId); parseSpec(task.spec); strings(task.outboundIds);
      if (!Array.isArray(task.worktrees)) throw new Error("Invalid worktree history");
      for (const tree of task.worktrees) { textField(tree.key); textField(tree.worktreePath); textField(tree.branchName); textField(tree.baseCommitHash); }
      if (task.changeSet) task.changeSet = GitChangeSetSchema.parse(task.changeSet);
      if (task.cycle) task.cycle = VerificationCycleSchema.parse(task.cycle);
      if (task.result) task.result = AgentResultSchema.parse(task.result);
      if (task.reworkResolutions !== undefined) {
        if (!Array.isArray(task.reworkResolutions)) throw new Error("Invalid rework resolution history");
        task.reworkResolutions = task.reworkResolutions.map(item => {
          const dossier = ReworkResolutionDossierSchema.parse(item);
          if (dossier.runId !== run.runId || dossier.taskId !== task.taskId) throw new Error("Rework resolution dossier run/task mismatch");
          return dossier;
        });
      }
    }
    if (run.workflowCycle) run.workflowCycle = VerificationCycleSchema.parse(run.workflowCycle);
    if (run.workflowChange) run.workflowChange = GitChangeSetSchema.parse(run.workflowChange);
  }
  for (const out of state.outbound) {
    out.message = RoleMessageSchema.parse(out.message); textField(out.selector); textField(out.taskId); textField(out.attemptId); strings(out.capabilities);
    if (!["queued", "sending", "unknown_delivery", "accepted", "released", "cancelled", "delivered", "failed"].includes(out.status)) throw new Error("Invalid outbound status");
    if (out.notReadySince !== undefined) { textField(out.notReadySince); if (!Number.isFinite(Date.parse(out.notReadySince))) throw new Error("Invalid not-ready timestamp"); }
    if (out.nextAttemptAt !== undefined) { textField(out.nextAttemptAt); if (!Number.isFinite(Date.parse(out.nextAttemptAt))) throw new Error("Invalid retry timestamp"); }
    if (out.deliveryAttempts !== undefined && (!Number.isSafeInteger(out.deliveryAttempts) || out.deliveryAttempts < 0)) throw new Error("Invalid delivery attempts");
    if (out.cancelObservations !== undefined && (!Number.isSafeInteger(out.cancelObservations) || out.cancelObservations < 0)) throw new Error("Invalid cancellation observations");
    if (out.coordinatorResponseBaseline !== undefined && (!Number.isSafeInteger(out.coordinatorResponseBaseline) || out.coordinatorResponseBaseline < 0 || out.coordinatorResponseBaseline > state.outbound.length))
      throw new Error("Invalid Coordinator response baseline");
    if (out.assignment) out.assignment = AgentAssignmentSchema.parse(out.assignment);
    if (out.roleProfile !== undefined) out.roleProfile = RoleProfilePinSchema.parse(out.roleProfile);
    if (out.profileAllocationTaskId !== undefined) textField(out.profileAllocationTaskId);
    if (out.profileAllocationReleased !== undefined && (out.profileAllocationReleased !== true || !out.profileAllocationTaskId || !out.roleProfile))
      throw new Error("Invalid profile allocation cleanup receipt");
    if (out.executorLineage !== undefined) out.executorLineage = ExecutorLineageSchema.parse(out.executorLineage);
    if (state.version < 7 && (out.roleProfile || out.executorLineage || out.profileAllocationTaskId))
      throw new Error("Profile authority requires private journal v7");
    if (out.request) out.request = AgentRequestSchema.parse(out.request);
    if (out.lease) out.lease = AgentLeaseSchema.parse(out.lease);
    if (out.handle) out.handle = AgentExecutionHandleSchema.parse(out.handle);
    const profileRun = state.runs.find(run => run.runId === out.message.run_id);
    const expectedPin = out.message.type === "task.assignment" ? profileRun?.definition?.tasks.find(task => task.id === out.taskId)?.roleProfile ??
      (profileRun?.conflictResolution?.attempts.some(attempt => attempt.messageId === out.message.message_id) ? profileRun.conflictResolution.roleProfile : undefined) :
      out.message.type === "delegation.request" ? record(out.message.payload).roleProfile : out.roleProfile;
    if (!sameRoleProfilePin(expectedPin === undefined ? undefined : RoleProfilePinSchema.parse(expectedPin), out.roleProfile) ||
        out.assignment && !sameRoleProfilePin(out.assignment.roleProfile, out.roleProfile))
      throw new Error("Durable profile assignment pin mismatch");
    if (out.roleProfile && !profileRun?.roleProfiles?.some(profile => sameRoleProfilePin(profile.pin, out.roleProfile) && profile.definition.baseRole === out.message.recipient.role))
      throw new Error("Profiled outbound has no pinned recovery snapshot");
    if (out.roleProfile && out.handle && (!out.executorLineage || out.executorLineage.nativeSessionId !== out.handle.target.session?.value ||
        !out.executorLineage.assignmentIds.includes(out.message.message_id))) throw new Error("Profiled execution has no matching authenticated executor lineage");
    if (out.cancellationStopProof !== undefined) {
      out.cancellationStopProof = CancellationStopProofSchema.parse(out.cancellationStopProof);
      if (state.version < 6 || !out.cancelRequested || !out.handle || digest(out.cancellationStopProof.handle) !== digest(out.handle) ||
          Date.parse(out.cancellationStopProof.observedAt) < Date.parse(out.handle.acceptedAt) ||
          !state.runs.some(run => run.runId === out.handle!.runId && run.cancelled)) throw new Error("Invalid cancellation stop proof");
    }
    if (out.cancellationLeaseDisposition !== undefined && (state.version < 6 || !out.cancellationStopProof ||
        !["released", "expired"].includes(out.cancellationLeaseDisposition))) throw new Error("Invalid cancellation lease disposition");
    if (out.stopObservedAt !== undefined) {
      IsoDateTimeSchema.parse(out.stopObservedAt);
      if (!out.handle || out.message.type !== "delegation.request" || Date.parse(out.stopObservedAt) < Date.parse(out.handle.acceptedAt))
        throw new Error("Invalid specialist Stop observation");
    }
    if (out.phaseRetirement) {
      const retirement = z.object({ operationId: z.string().min(1), sessionId: z.string().min(1), userMessageId: z.string().min(1), userId: z.string().min(1),
        blockedReplyId: z.string().min(1), decidedAt: IsoDateTimeSchema, resumeAuthorizedBy: z.string().min(1).optional(), disposition: z.literal("retired_without_measurement_claim") }).strict().parse(out.phaseRetirement);
      if (state.version < 3 || retirement.operationId !== out.message.message_id || out.phaseFailure ||
          out.message.type !== "verification.requested" || record(out.message.payload).kind !== "conditional_evidence" || !out.handle)
        throw new Error("Invalid retired policy phase");
      out.phaseRetirement = retirement;
    }
    if (out.reviewReplacement) {
      const replacement = z.object({ operationId: z.string().min(1), sessionId: z.string().min(1), userMessageId: z.string().min(1), userId: z.string().min(1),
        decidedAt: IsoDateTimeSchema, contextDigest: z.string().regex(/^[a-f0-9]{64}$/), replacementMessageId: z.string().min(1),
        disposition: z.literal("replaced_without_verdict_claim") }).strict().parse(out.reviewReplacement);
      const context = record(out.message.payload), configuration = record(record(context.definition).configuration);
      if (state.version < 4 || replacement.operationId !== out.message.message_id || out.message.type !== "verification.requested" || !out.handle ||
          (!["accepted", "released"].includes(out.status)) || context.taskId !== "workflow-verification" || record(context.input).scope !== "workflow" || configuration.kind !== "review" || !["reviewer", "qa"].includes(String(configuration.role)) || ((configuration.role === "qa" || out.status === "accepted") && state.version < 5) ||
          out.status === "accepted" && (!out.lease || Date.parse(out.lease.expiresAt) > Date.parse(replacement.decidedAt)) ||
          replacement.contextDigest !== digest(out.message.payload) || replacement.replacementMessageId !== `review-replacement-${digest([out.message.run_id, replacement.operationId, replacement.userMessageId, replacement.contextDigest])}` ||
          !state.runs.some(run => run.runId === out.message.run_id && run.delegation.sessionId === replacement.sessionId)) throw new Error("Invalid workflow review replacement");
      out.reviewReplacement = replacement;
    }
    if (out.phaseFailureEvidence) out.phaseFailureEvidence = ArtifactReferenceSchema.parse(out.phaseFailureEvidence);
    if (out.phaseFailure) {
      textField(out.phaseFailure.summary);
      if (typeof out.phaseFailure.repairable !== "boolean" || typeof out.phaseFailure.applied !== "boolean" ||
          out.phaseFailure.retryAuthorized !== undefined && (out.phaseFailure.retryAuthorized !== true || out.phaseFailure.repairable) ||
          out.message.type !== "verification.requested" || record(out.message.payload).kind !== "conditional_evidence")
        throw new Error("Invalid private policy failure outcome");
    }
    if (out.leaseHistory) {
      if (!Array.isArray(out.leaseHistory) || !out.leaseHistory.length || out.leaseHistory.length > 3 ||
          out.parentAssignmentId || !out.lease || !out.assignment || !out.handle?.target.session || out.message.type !== "task.assignment")
        throw new Error("Invalid task lease continuation history");
      out.leaseHistory = out.leaseHistory.map(item => AgentLeaseSchema.parse(item));
      const chain = [...out.leaseHistory, out.lease];
      if (out.assignment.leaseId !== chain[0]!.leaseId || out.assignment.fencingToken !== chain[0]!.fencingToken ||
          chain.some((item, index) => item.agentId !== out.lease!.agentId || item.runId !== out.lease!.runId ||
            item.taskId !== out.lease!.taskId || item.attemptId !== out.lease!.attemptId || index > 0 &&
            (item.fencingToken <= chain[index - 1]!.fencingToken || item.leaseId === chain[index - 1]!.leaseId)))
        throw new Error("Task lease continuation changed ownership or fence order");
    }
    if (out.leaseReacquisition) {
      out.leaseReacquisition = AcquireAgentLeaseRequestSchema.parse(out.leaseReacquisition);
      const request = out.leaseReacquisition;
      if (out.parentAssignmentId || out.message.type !== "task.assignment" || out.status !== "accepted" || !out.handle?.target.session ||
          !out.lease || out.leaseRenewal || out.leaseRelease || request.leaseId === out.lease.leaseId ||
          request.agentId !== out.lease.agentId || request.runId !== out.lease.runId || request.taskId !== out.lease.taskId ||
          request.attemptId !== out.lease.attemptId || (out.leaseHistory?.length ?? 0) >= 3)
        throw new Error("Invalid pending task lease continuation");
    }
    if (out.leaseRenewal) {
      out.leaseRenewal = RenewAgentLeaseRequestSchema.parse(out.leaseRenewal);
      if (out.parentAssignmentId || !out.lease || out.leaseRenewal.leaseId !== out.lease.leaseId ||
          out.leaseRenewal.fencingToken !== out.lease.fencingToken || out.leaseRenewal.expectedVersion !== out.lease.version)
        throw new Error("Invalid pending outbound lease renewal");
    }
    if (out.leaseRelease) {
      out.leaseRelease = ReleaseAgentLeaseRequestSchema.parse(out.leaseRelease);
      if (out.parentAssignmentId || out.leaseRenewal || out.status === "released" || !out.lease ||
          out.leaseRelease.leaseId !== out.lease.leaseId || out.leaseRelease.fencingToken !== out.lease.fencingToken ||
          out.leaseRelease.expectedVersion !== out.lease.version) throw new Error("Invalid pending outbound lease release");
    }
    // An inbox delivery's write-ahead intent is the message itself; it never has a transport request.
    if (["sending", "unknown_delivery", "accepted"].includes(out.status) && !out.request && !(isConversationDelivery(out) && out.status !== "accepted"))
      throw new Error("Missing outbound dispatch intent");
    if (out.status === "accepted" && (!out.handle || !out.lease)) throw new Error("Missing outbound binding/lease");
  }
  for (const out of state.outbound) if (out.parentAssignmentId !== undefined) {
    textField(out.parentAssignmentId);
    const parents = state.outbound.filter(parent => parent.message.message_id === out.parentAssignmentId);
    const parent = parents[0];
    if (parents.length !== 1 || !parent || parent === out || parent.parentAssignmentId || parent.message.type !== "task.assignment" ||
        !parent.assignment || !parent.request || !parent.handle || !parent.lease || out.assignment ||
        out.message.type !== "task.status" || out.message.sender.role !== "coordinator" || out.message.recipient.role !== "developer" ||
        out.message.run_id !== parent.message.run_id || out.taskId !== parent.taskId || out.attemptId !== parent.attemptId || out.selector !== parent.selector ||
        out.message.recipient.agent_id && out.message.recipient.agent_id !== parent.handle.target.agentId ||
        out.message.recipient.pane_id && out.message.recipient.pane_id !== parent.handle.target.paneId ||
        out.lease && digest(out.lease) !== digest(parent.lease) ||
        out.request && digest(out.request.target) !== digest(parent.handle.target)) throw new Error("Invalid task notice parent assignment");
  }
  for (const item of state.inbox) {
    item.message = RoleMessageSchema.parse(item.message);
    if (!["received", "applied", "rejected"].includes(item.status)) throw new Error("Invalid inbox status");
    if (item.reason !== undefined) textField(item.reason);
  }
  for (const out of state.outbound.filter(item => item.phaseRetirement)) {
    const run = state.runs.find(item => item.runId === out.message.run_id), retirement = out.phaseRetirement!, target = out.handle!.target;
    const reply = state.inbox.find(item => item.status === "applied" && item.message.message_id === retirement.blockedReplyId)?.message;
    if (!run || retirement.sessionId !== run.delegation.sessionId || !reply || reply.type !== "task.status" ||
        reply.causation_id !== out.message.message_id || reply.run_id !== run.runId || reply.correlation_id !== out.message.correlation_id ||
        reply.sender.role !== out.message.recipient.role || reply.sender.agent_id !== target.agentId || reply.sender.pane_id !== target.paneId || record(reply.payload).status !== "blocked")
      throw new Error("Retired policy phase ownership or blocker mismatch");
  }
  for (const pending of state.pendingVerifications) {
    const job = record(pending.job); const outcome = record(pending.outcome);
    textField(job.runId); textField(job.taskId); record(job.plan);
    VerificationCycleSchema.parse(job.cycle); GitChangeSetSchema.parse(job.change);
    VerificationResultSchema.parse(outcome.result); VerificationCycleSchema.parse(outcome.cycle);
    if (pending.attempts !== undefined && (!Number.isSafeInteger(pending.attempts) || pending.attempts < 0)) throw new Error("Invalid verification attempts");
    if (pending.lastError !== undefined) textField(pending.lastError);
    if (pending.stuck !== undefined && typeof pending.stuck !== "boolean") throw new Error("Invalid verification stuck flag");
  }
  state.pendingCore = state.pendingCore.map(value => AppendEventsRequestSchema.parse(value));
  return state;
}
function parseSpec(value: SpecRecord): void {
  value.specification = SpecificationSchema.parse(value.specification);
  value.request = ApprovalRequestSchema.parse(value.request);
  value.strategy = TestStrategySchema.parse(value.strategy);
  if (value.decision) value.decision = ApprovalDecisionSchema.parse(value.decision);
}
/** Linux flock + fsync/rename. A crashed process releases its lock; stale PID files are never stolen. */
export class AgenticJournal {
  readonly directory: string;
  private validatedSnapshot?: { bytes: Buffer; value: JournalState };
  constructor(directory: string, readonly repository: string) { this.directory = resolve(directory); }
  private static readonly queues = new Map<string, Promise<unknown>>();
  async exclusive<T>(action: (state: JournalState, save: () => Promise<void>) => Promise<T>): Promise<T> {
    const previous = AgenticJournal.queues.get(this.directory) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.locked(action));
    AgenticJournal.queues.set(this.directory, next);
    try { return await next; }
    finally { if (AgenticJournal.queues.get(this.directory) === next) AgenticJournal.queues.delete(this.directory); }
  }
  private async locked<T>(action: (state: JournalState, save: () => Promise<void>) => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = await open(join(this.directory, "lock"), "a+", 0o600);
    try {
      await new Promise<void>((accept, reject) => {
        const child = spawn("flock", ["--nonblock", "3"], { stdio: ["ignore", "ignore", "ignore", lock.fd] });
        const timer = setTimeout(() => { child.kill(); reject(new Error("Journal lock timeout")); }, 5000);
        child.once("error", e => { clearTimeout(timer); reject(e); });
        child.once("close", code => { clearTimeout(timer); code === 0 ? accept() : reject(new Error("Agentic runtime busy")); });
      });
      let state: JournalState, baseline: JournalState | undefined, durableBytes: Buffer | undefined;
      const statePath = join(this.directory, "state.json");
      try {
        const bytes = await readFile(statePath);
        if (this.validatedSnapshot?.bytes.equals(bytes)) state = structuredClone(this.validatedSnapshot.value);
        else {
          state = parseAgenticJournalState(JSON.parse(bytes.toString("utf8")), this.repository);
          this.validatedSnapshot = { bytes: Buffer.from(bytes), value: structuredClone(state) };
        }
        baseline = this.validatedSnapshot.value; durableBytes = bytes;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        delete this.validatedSnapshot;
        state = { version: 1, repository: this.repository, runs: [], outbound: [], inbox: [], pendingCore: [], pendingVerifications: [] };
      }
      return await action(state, async () => {
        if (state.runs.some(run => run.roleProfiles?.length || Object.keys(run.roleProfileDefaults ?? {}).length) ||
            state.outbound.some(out => out.roleProfile || out.executorLineage || out.profileAllocationTaskId)) state.version = 7;
        // Equality covers invalid values that JSON.stringify would omit. Re-read under flock before acknowledging unchanged durable bytes.
        if (baseline && durableBytes && isDeepStrictEqual(state, baseline)) {
          try { if ((await readFile(statePath)).equals(durableBytes)) return; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        parseAgenticJournalState(state, this.repository);
        const serialized = JSON.stringify(state), normalized = parseAgenticJournalState(JSON.parse(serialized), this.repository);
        const path = join(this.directory, `state-${randomUUID()}.tmp`);
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
        try {
          await rename(path, statePath);
          const dir = await open(this.directory, "r");
          try { await dir.sync(); } finally { await dir.close(); }
        } finally { await rm(path, { force: true }); }
        this.validatedSnapshot = { bytes: Buffer.from(serialized, "utf8"), value: normalized };
        baseline = normalized; durableBytes = this.validatedSnapshot.bytes;
      });
    } finally { await lock.close(); }
  }
}
