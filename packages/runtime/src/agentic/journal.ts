import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AgentAssignmentSchema, AgentExecutionHandleSchema, AgentLeaseSchema, AgentRequestSchema, AgentRoleSchema,
  AgentResultSchema, AppendEventsRequestSchema, ApprovalDecisionSchema, ApprovalRequestSchema, ArtifactReferenceSchema,
  DelegationRequestSchema, GitChangeSetSchema, JsonValueSchema, RoleMessageSchema, RenewAgentLeaseRequestSchema, ReleaseAgentLeaseRequestSchema,
  SdlcWorkStatusSchema, SpecificationSchema, TestStrategySchema, VerificationCycleSchema,
  VerificationResultSchema, WorkflowDefinitionSchema, type AgentAssignment, type AgentExecutionHandle, type AgentLease,
  type AgentRequest, type AgentResult, type AppendEventsRequest, type ApprovalDecision,
  type AgentRole, type ApprovalRequest, type DelegationRequest, type GitChangeSet, type JsonValue, type ArtifactReference,
  type RoleMessage, type SdlcWorkStatus, type Specification, type TestStrategy,
  type VerificationCycle, type WorkflowDefinition, type RenewAgentLeaseRequest, type ReleaseAgentLeaseRequest
} from "@bflow/contracts";
import type { TaskWorktree, VerificationPlan } from "./ports.js";
import { isUserDecisionRequest, type UserDecisionAnswer } from "./decision-routing.js";

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
  taskId: string; spec: SpecRecord; worktrees: TaskWorktree[]; outboundIds: string[];
  changeSet?: GitChangeSet; cycle?: VerificationCycle; result?: AgentResult;
  verificationPlan?: VerificationPlan; verificationPending?: boolean; writerReleased?: boolean;
}
export interface RunRecord {
  runId: string; delegation: DelegationRequest; status: SdlcWorkStatus;
  definition?: WorkflowDefinition; workflowSpec?: SpecRecord; tasks: TaskRecord[];
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
  /**
   * Invalid RoleMessages per (sender role, assignment/causation) key. Bounded; `messageIds` dedupes replays of one inbound
   * envelope. Absent in older journals (no invalid messages counted).
   */
  invalidMessages?: { key: string; count: number; messageIds: string[] }[];
  /** Set once the run's single final cancellation notice is queued; absent in journals written before cancellation reconciliation. */
  cancelReconciled?: boolean;
  /** Set when a human `changes_requested` continued this run as a follow-up run; the parent is terminal and never resumed. */
  supersededBy?: string;
  /** Bounded automatic Developer resolver episode for the current P18 merge conflict; absent in journals written before it. */
  conflictResolution?: ConflictResolutionRecord;
}
/** One P18 conflict (identified by its deterministic request message) and the resolver attempts assigned for it. */
export interface ConflictResolutionRecord {
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
export interface UserDecisionRecord {
  request: ApprovalRequest; role: AgentRole; agentId: string; paneId: string; taskId: string;
  status: "pending" | "answered" | "rejected" | "expired" | "cancelled"; answer?: UserDecisionAnswer;
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
  }
}
export interface Outbound {
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
  /** Stop observations made for a cancelled execution; bounded so an unresponsive pane is reported instead of polled forever. */
  cancelObservations?: number;
  phaseFailureEvidence?: ArtifactReference;
  phaseFailure?: { summary: string; repairable: boolean; applied: boolean };
  /** A control notice borrows its task assignment's lease; it never owns capacity. */
  parentAssignmentId?: string;
  /** Private outbox position captured before this Coordinator turn is physically dispatched. */
  coordinatorResponseBaseline?: number;
  leaseRenewal?: RenewAgentLeaseRequest;
  leaseRelease?: ReleaseAgentLeaseRequest;
}
export interface JournalState {
  version: 1; repository: string; runs: RunRecord[]; outbound: Outbound[];
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
function parseState(input: unknown, repository: string): JournalState {
  const root = record(input);
  if (root.version !== 1 || root.repository !== repository) throw new Error("Unsupported or foreign P19 journal");
  for (const key of ["runs", "outbound", "inbox", "pendingCore", "pendingVerifications"]) if (!Array.isArray(root[key])) throw new Error(`Invalid journal ${key}`);
  const state = root as unknown as JournalState;
  for (const run of state.runs) {
    textField(run.runId); run.delegation = DelegationRequestSchema.parse(run.delegation);
    if (run.delegation.runId !== run.runId) throw new Error("Journal run/delegation mismatch");
    run.status = SdlcWorkStatusSchema.parse(run.status);
    if (typeof run.coreCreated !== "boolean" || typeof run.cancelled !== "boolean" || !Number.isInteger(run.maxIterations) || run.maxIterations < 1 || run.maxIterations > 10)
      throw new Error("Invalid run flags/limit");
    if (!Array.isArray(run.tasks)) throw new Error("Invalid task journal");
    if (run.definition) run.definition = WorkflowDefinitionSchema.parse(run.definition);
    if (run.workflowSpec) parseSpec(run.workflowSpec);
    if (run.approval) run.approval = ApprovalRequestSchema.parse(run.approval);
    if (run.userDecisions !== undefined) parseUserDecisions(run.userDecisions, run.runId);
    if (run.delegationHistory !== undefined) run.delegationHistory = run.delegationHistory.map(item => DelegationRequestSchema.parse(item));
    if (run.cancelReconciled !== undefined && typeof run.cancelReconciled !== "boolean") throw new Error("Invalid cancellation reconciliation flag");
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
    if (run.decision) run.decision = ApprovalDecisionSchema.parse(run.decision);
    if (run.approvalKind && !["design", "delivery", "action", "task"].includes(run.approvalKind)) throw new Error("Invalid approval kind");
    for (const task of run.tasks) {
      textField(task.taskId); parseSpec(task.spec); strings(task.outboundIds);
      if (!Array.isArray(task.worktrees)) throw new Error("Invalid worktree history");
      for (const tree of task.worktrees) { textField(tree.key); textField(tree.worktreePath); textField(tree.branchName); textField(tree.baseCommitHash); }
      if (task.changeSet) task.changeSet = GitChangeSetSchema.parse(task.changeSet);
      if (task.cycle) task.cycle = VerificationCycleSchema.parse(task.cycle);
      if (task.result) task.result = AgentResultSchema.parse(task.result);
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
    if (out.request) out.request = AgentRequestSchema.parse(out.request);
    if (out.lease) out.lease = AgentLeaseSchema.parse(out.lease);
    if (out.handle) out.handle = AgentExecutionHandleSchema.parse(out.handle);
    if (out.phaseFailureEvidence) out.phaseFailureEvidence = ArtifactReferenceSchema.parse(out.phaseFailureEvidence);
    if (out.phaseFailure) {
      textField(out.phaseFailure.summary);
      if (typeof out.phaseFailure.repairable !== "boolean" || typeof out.phaseFailure.applied !== "boolean" ||
          out.message.type !== "verification.requested" || record(out.message.payload).kind !== "conditional_evidence")
        throw new Error("Invalid private policy failure outcome");
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
      let state: JournalState;
      try { state = parseState(JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")), this.repository); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        state = { version: 1, repository: this.repository, runs: [], outbound: [], inbox: [], pendingCore: [], pendingVerifications: [] };
      }
      return await action(state, async () => {
        parseState(state, this.repository);
        const path = join(this.directory, `state-${randomUUID()}.tmp`);
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
        try {
          await rename(path, join(this.directory, "state.json"));
          const dir = await open(this.directory, "r");
          try { await dir.sync(); } finally { await dir.close(); }
        } finally { await rm(path, { force: true }); }
      });
    } finally { await lock.close(); }
  }
}
