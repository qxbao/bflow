import { projectPolicyPhaseEnvelope, provenPrelaunchPolicyFailure, PrelaunchRegistryRecoveryError, prelaunchLeaseIdentity } from "./policy-prompt.js";
import { assertRunExecutionPlan, ExecutionPlanDriftError } from "./execution-binding.js";
import { ExecutorLineageSchema, RoleProfilePinSchema, sameRoleProfilePin } from "@bflow/contracts";
import { assertProfileBinding, assertProfileSnapshotCurrent, assertIndependentProfileExecutor, selectRoleProfile } from "./profile-admission.js";
import {
  AcquireAgentLeaseRequestSchema, AgentAssignmentSchema, AgentConfigurationSchema, AgentLeaseSchema, AgentReconciliationResultSchema,
  AgentRequestSchema, AgentSubmissionReceiptSchema, PaneBindingSchema, RoleMessageSchema, RenewAgentLeaseRequestSchema, ReleaseAgentLeaseRequestSchema, VerificationResultSchema, WorkflowRunSnapshotSchema,
  type AgentExecutionHandle, type OperationResult, type RoleMessage, type PaneBinding
} from "@bflow/contracts";
import { RoleCapabilityPreflightError, type AgenticRuntimePorts } from "./ports.js";
import { digest, isConversationDelivery, json, record, type JournalState, type Outbound } from "./journal.js";

/** A recipient observed not ready for this long is reported to Conversation; delivery keeps retrying. */
export const NOT_READY_FAILURE_MS = 5 * 60_000;
/** Consecutive failed Conversation inbox writes before the message is marked failed (never silently retried forever). */
export const CONVERSATION_DELIVERY_MAX_ATTEMPTS = 5;
/** Consecutive dispatch failures before a queued message is surfaced to Conversation (it keeps retrying). */
export const DISPATCH_FAILURE_NOTICE_ATTEMPTS = 5;
/** Backoff between consecutive capability preflight failures of one unsent message; the next failure after these marks it failed. */
export const PREFLIGHT_RETRY_DELAYS_MS: readonly number[] = [0, 2_000, 8_000, 30_000];

export function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
export class HerdrOutbox {
  constructor(private readonly ports: AgenticRuntimePorts, private readonly state: JournalState,
    private readonly save: () => Promise<void>) {}
  private now(): string { return (this.ports.clock?.() ?? new Date()).toISOString(); }
  enqueue(message: RoleMessage, selector: string = message.recipient.role, taskId = `message-${message.message_id}`,
    attemptId = `attempt-${message.message_id}`, capabilities: string[] = []): Outbound {
    const parsed = RoleMessageSchema.parse(message);
    if (!parsed.idempotency_key) throw new Error("Every handoff requires idempotency_key");
    const existing = this.state.outbound.find(out => out.message.message_id === parsed.message_id || out.message.idempotency_key === parsed.idempotency_key);
    if (existing) {
      if (digest(existing.message) !== digest(parsed)) throw new Error("Conflicting handoff idempotency key");
      return existing;
    }
    // Every coordination/investigation/verifier handoff depends on the host-owned bounded repository interface.
    // The lease resolver checks this requirement against the live role registration immediately before dispatch.
    const repositoryReaders = new Set(["coordinator", "specifier", "architect", "planner", "reviewer", "qa", "tester", "security"]);
    const required = repositoryReaders.has(parsed.recipient.role) ? [...new Set([...capabilities, "repository.read"])] : capabilities;
    const out: Outbound = { message: parsed, status: "queued", selector, taskId, attemptId, capabilities: required };
    this.state.outbound.push(out);
    return out;
  }
  private noticeParent(out: Outbound): Outbound {
    const parent = this.state.outbound.find(item => item.message.message_id === out.parentAssignmentId);
    if (!parent || parent.parentAssignmentId || parent.message.type !== "task.assignment" || parent.status !== "accepted" ||
        parent.cancelRequested || parent.leaseRelease || !parent.assignment || !parent.handle || !parent.request || !parent.lease)
      throw new Error("Task notice requires an active parent assignment");
    if (parent.lease.agentId !== parent.handle.target.agentId || parent.lease.runId !== parent.message.run_id ||
        parent.lease.taskId !== parent.taskId || parent.lease.attemptId !== parent.attemptId ||
        parent.assignment.leaseId !== (parent.leaseHistory?.[0] ?? parent.lease).leaseId ||
        parent.assignment.fencingToken !== (parent.leaseHistory?.[0] ?? parent.lease).fencingToken ||
        Date.parse(parent.lease.expiresAt) <= Date.parse(this.now())) throw new Error("Task notice parent lease is expired or mismatched");
    const run = this.state.runs.find(item => item.runId === parent.message.run_id);
    const task = run?.tasks.find(item => item.taskId === parent.taskId);
    if (!run || run.cancelled || ["completed", "failed", "cancelled", "escalated"].includes(run.status) || !task || task.writerReleased || task.result ||
        out.message.run_id !== parent.message.run_id || out.taskId !== parent.taskId || out.attemptId !== parent.attemptId)
      throw new Error("Task notice parent execution is stopped or terminal");
    return parent;
  }
  enqueueTaskNotice(message: RoleMessage, parentAssignment: Outbound): Outbound {
    if (!this.state.outbound.includes(parentAssignment)) throw new Error("Task notice parent is outside this journal");
    const parsed = RoleMessageSchema.parse(message);
    const candidate: Outbound = { message: parsed, status: "queued", selector: parentAssignment.selector,
      taskId: parentAssignment.taskId, attemptId: parentAssignment.attemptId, capabilities: [], parentAssignmentId: parentAssignment.message.message_id };
    const parent = this.noticeParent(candidate);
    if (parsed.type !== "task.status" || parsed.sender.role !== "coordinator" || parsed.recipient.role !== "developer" ||
        parsed.recipient.agent_id && parsed.recipient.agent_id !== parent.handle!.target.agentId ||
        parsed.recipient.pane_id && parsed.recipient.pane_id !== parent.handle!.target.paneId)
      throw new Error("Task notice must address the assigned Developer");
    const existing = this.state.outbound.find(item => item.message.message_id === parsed.message_id || item.message.idempotency_key === parsed.idempotency_key);
    if (existing && existing.parentAssignmentId !== candidate.parentAssignmentId) throw new Error("Conflicting task notice parent");
    const out = this.enqueue(parsed, candidate.selector, candidate.taskId, candidate.attemptId);
    if (parent.roleProfile) out.roleProfile = parent.roleProfile;
    out.parentAssignmentId = parent.message.message_id; out.lease = parent.lease!;
    return out;
  }
  private target(pane: PaneBinding) {
    return { transport: "herdr", agentId: pane.agentId, paneId: pane.paneId, workspaceId: pane.workspaceId,
      tabId: pane.tabId, ...(pane.terminalId ? { terminalId: pane.terminalId } : {}),
      ...(pane.session ? { session: pane.session } : {}), ...(pane.worktreePath ? { worktreePath: pane.worktreePath } : {}) };
  }
  private async validateNotice(out: Outbound, pane: PaneBinding): Promise<void> {
    const parent = this.noticeParent(out);
    if (digest(this.target(pane)) !== digest(parent.handle!.target) || pane.cwd !== parent.request!.workingDirectory)
      throw new Error("Task notice recipient session or worktree changed");
    const value = unwrap(await this.ports.engine.getSnapshot(parent.message.run_id!));
    const snapshot = value && WorkflowRunSnapshotSchema.parse(value), task = snapshot?.tasks.find(item => item.taskId === parent.taskId);
    if (!snapshot || ["succeeded", "failed", "cancelled", "cancelling"].includes(snapshot.status) || !task || task.status !== "running" ||
        task.attemptId !== parent.attemptId || !task.agentExecution || digest(task.agentExecution) !== digest(parent.handle))
      throw new Error("Task notice parent Core execution is stopped or terminal");
  }
  async renew(out: Outbound): Promise<void> {
    const owner = out.parentAssignmentId ? this.noticeParent(out) : out;
    if (owner.reviewReplacement) throw new Error("Replaced workflow review cannot renew its original lease");
    if (owner.leaseReacquisition) await this.reconcileLeaseAcquisition(owner);
    if (owner.leaseRelease) throw new Error("Assignment lease release is pending");
    if (!owner.lease) throw new Error("Assignment has no current lease");
    const recovering = owner.leaseRenewal !== undefined;
    owner.leaseRenewal ??= RenewAgentLeaseRequestSchema.parse({ leaseId: owner.lease.leaseId,
      fencingToken: owner.lease.fencingToken, expectedVersion: owner.lease.version, ttlMs: 300_000,
      requestedAt: this.now(), idempotencyKey: `renew:${owner.message.message_id}:${owner.lease.leaseId}:${owner.lease.version}` });
    await this.save(); // Retain exact renewal arguments if Registry commits before journal persistence.
    const lease = AgentLeaseSchema.parse(unwrap(await this.ports.registry.renewLease(owner.leaseRenewal)));
    if (Date.parse(lease.expiresAt) <= Date.parse(this.now())) throw new Error("Expired assignment lease");
    owner.lease = lease; delete owner.leaseRenewal;
    for (const child of this.state.outbound) if (child.parentAssignmentId === owner.message.message_id) child.lease = lease;
    await this.save();
    // A recovered idempotency receipt is historical: verify the current Registry
    // authority with a fresh version before it can authorize another side effect.
    if (recovering) await this.renew(owner);
  }
  private async reconcileLeaseAcquisition(owner: Outbound): Promise<void> {
    if (!owner.leaseReacquisition) return;
    if (!this.state.outbound.includes(owner) || owner.parentAssignmentId || owner.message.type !== "task.assignment" ||
        owner.status !== "accepted" || !owner.lease || !owner.handle?.target.session || (owner.leaseHistory?.length ?? 0) >= 3)
      throw new Error("Invalid pending task lease continuation");
    owner.leaseReacquisition = AcquireAgentLeaseRequestSchema.parse(owner.leaseReacquisition);
    const request = owner.leaseReacquisition;
    if (request.agentId !== owner.lease.agentId || request.runId !== owner.lease.runId || request.taskId !== owner.lease.taskId ||
        request.attemptId !== owner.lease.attemptId || request.leaseId === owner.lease.leaseId)
      throw new Error("Pending task lease continuation ownership mismatch");
    await assertRunExecutionPlan(this.state.runs.find(run => run.runId === owner.message.run_id), this.ports.readExecutionResolution);
    const acquired = AgentLeaseSchema.parse(unwrap(await this.ports.registry.acquireLease(owner.leaseReacquisition)));
    if (acquired.leaseId !== owner.leaseReacquisition.leaseId || acquired.agentId !== owner.lease.agentId ||
        acquired.runId !== owner.lease.runId || acquired.taskId !== owner.taskId || acquired.attemptId !== owner.attemptId ||
        acquired.fencingToken <= owner.lease.fencingToken) throw new Error("Registry task lease continuation ownership/fence mismatch");
    owner.leaseHistory = [...owner.leaseHistory ?? [], owner.lease];
    owner.lease = acquired; delete owner.leaseReacquisition;
    for (const child of this.state.outbound) if (child.parentAssignmentId === owner.message.message_id) child.lease = acquired;
    await this.save();
  }
  /** A durable explicit phase resume may continue the exact live execution under a new Registry fence, at most three times. */
  async recoverTaskLease(owner: Outbound, authorization: Outbound): Promise<void> {
    const run = this.state.runs.find(item => item.runId === owner.message.run_id);
    const task = run?.tasks.find(item => item.taskId === owner.taskId);
    const payload = record(authorization.message.payload);
    if (!this.state.outbound.includes(owner) || !this.state.outbound.includes(authorization) || owner.parentAssignmentId ||
        owner.message.type !== "task.assignment" || owner.status !== "accepted" || !owner.lease || !owner.assignment ||
        !owner.handle?.target.session || owner.cancelRequested || owner.leaseRelease || !task || task.writerReleased || task.result ||
        !run || run.cancelled || run.status !== "implementing" || authorization.message.run_id !== run.runId ||
        authorization.message.type !== "verification.requested" || payload.kind !== "conditional_evidence" ||
        payload.taskId !== owner.taskId || payload.implementationAttemptId !== owner.attemptId ||
        !(authorization.phaseRetirement?.resumeAuthorizedBy || authorization.phaseFailure?.repairable === false && authorization.phaseFailure.applied && authorization.phaseFailure.retryAuthorized === true) || run.nativeDeliveries?.length ||
        run.approval !== undefined && run.decision?.approvalId !== run.approval.approvalId ||
        Object.values(run.userDecisions ?? {}).some(item => item.status === "pending") ||
        this.state.outbound.some(item => item.message.run_id === run.runId && ["sending", "unknown_delivery"].includes(item.status)))
      throw new Error("Task lease continuation requires explicit resume authority for a current execution");
    const rawReceipts = task.spec.strategy.metadata?.tddEvidence ?? [];
    if (!Array.isArray(rawReceipts)) throw new Error("Corrupt policy measurement history");
    const receipts = rawReceipts.map(item => VerificationResultSchema.parse(item));
    const expected = task.spec.strategy.tddDecision.mode === "required" ? ["red", "green", "refactor"][receipts.length] : receipts.length === 0 ? "verification" : undefined;
    if (payload.phase !== expected) throw new Error("Task lease resume authority belongs to an earlier policy phase");
    const raw = unwrap(await this.ports.panes.getRoleBinding(owner.selector));
    if (!raw) throw new Error("Task lease recipient disappeared");
    const pane = PaneBindingSchema.parse(raw), health = unwrap(await this.ports.panes.inspectRoleHealth(owner.selector));
    if (digest(this.target(pane)) !== digest(owner.handle.target) || pane.cwd !== owner.request?.workingDirectory ||
        !health.occupantMatches || !health.readyForPrompt || health.paneId !== pane.paneId || health.agentId !== pane.agentId)
      throw new Error("Task lease recipient/native session or worktree changed");
    const snapshot = WorkflowRunSnapshotSchema.parse(unwrap(await this.ports.engine.getSnapshot(run.runId)));
    const current = snapshot.tasks.find(item => item.taskId === owner.taskId);
    if (!current || current.status !== "running" || current.attemptId !== owner.attemptId ||
        digest(current.agentExecution) !== digest(owner.handle) || ["succeeded", "failed", "cancelled", "cancelling"].includes(snapshot.status))
      throw new Error("Task lease continuation does not own the current Core execution");
    await this.ports.preflightRoleCapabilities?.(pane, owner.capabilities);
    if (owner.leaseRenewal) {
      const reconciled = await this.ports.registry.renewLease(owner.leaseRenewal);
      if (!reconciled.ok && !(reconciled.error.code === "conflict" && reconciled.error.message === "Lease expired or released"))
        unwrap(reconciled);
      if (reconciled.ok) {
        const lease = AgentLeaseSchema.parse(reconciled.value);
        if (lease.leaseId !== owner.lease.leaseId || lease.fencingToken !== owner.lease.fencingToken ||
            lease.agentId !== owner.lease.agentId || lease.runId !== owner.lease.runId || lease.taskId !== owner.lease.taskId ||
            lease.attemptId !== owner.lease.attemptId) throw new Error("Registry renewal ownership mismatch during task continuation");
        owner.lease = lease;
      }
      delete owner.leaseRenewal;
      for (const child of this.state.outbound) if (child.parentAssignmentId === owner.message.message_id) child.lease = owner.lease;
      await this.save();
    }
    if (!owner.leaseReacquisition && Date.parse(owner.lease.expiresAt) > Date.parse(this.now())) { await this.renew(owner); return; }
    if ((owner.leaseHistory?.length ?? 0) >= 3) throw new Error("Task lease continuation limit exhausted");
    owner.leaseReacquisition ??= AcquireAgentLeaseRequestSchema.parse({
      leaseId: `lease-${digest([owner.message.message_id, owner.lease.leaseId, owner.lease.fencingToken])}`,
      agentId: owner.lease.agentId, runId: run.runId, taskId: owner.taskId, attemptId: owner.attemptId,
      ttlMs: 300_000, requestedAt: this.now(), idempotencyKey: `continue:${owner.message.message_id}:${owner.lease.leaseId}`
    });
    await this.save();
    await this.reconcileLeaseAcquisition(owner);
    const acquired = owner.lease;
    if (Date.parse(acquired.expiresAt) <= Date.parse(this.now())) throw new Error("Recovered task lease continuation expired; reconcile before use");
    await this.renew(owner);
  }
  async release(out: Outbound): Promise<"released" | "expired" | undefined> {
    if (out.phaseRetirement || out.reviewReplacement) return; // Historical expired grant, never claim a Registry release or remote stop.
    if (out.status === "released") return;
    if (out.leaseReacquisition) await this.reconcileLeaseAcquisition(out);
    let disposition: "released" | "expired" | undefined;
    if (out.lease && !out.parentAssignmentId) {
      // A conflict on an already expired lease means this execution no longer holds it; any other failure stays visible.
      const expired = Date.parse(out.lease.expiresAt) <= Date.parse(this.now());
      if (out.leaseRenewal) {
        const reconciled = await this.ports.registry.renewLease(out.leaseRenewal);
        if (!reconciled.ok && !(reconciled.error.code === "conflict" && expired)) unwrap(reconciled);
        if (reconciled.ok) {
          out.lease = AgentLeaseSchema.parse(reconciled.value);
          for (const child of this.state.outbound) if (child.parentAssignmentId === out.message.message_id) child.lease = out.lease;
        }
        delete out.leaseRenewal;
        await this.save();
      }
      out.leaseRelease ??= ReleaseAgentLeaseRequestSchema.parse({
        leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken, expectedVersion: out.lease.version,
        releasedAt: this.now(), idempotencyKey: `release:${out.lease.leaseId}:${out.lease.version}`
      });
      await this.save();
      const released = await this.ports.registry.releaseLease(out.leaseRelease);
      // A retried write-ahead release replays its idempotency receipt (ok). For a proven-stopped execution only the Registry's
      // own inactive-lease conflict is settled; a fence/version mismatch means another holder and stays visible regardless of TTL.
      const ttlExpired = Date.parse(out.lease.expiresAt) <= Date.parse(this.now());
      const inactive = !released.ok && released.error.code === "conflict" && (out.cancellationStopProof
        ? released.error.message === "Lease expired or already released" : ttlExpired);
      if (!released.ok && !inactive) unwrap(released);
      // Inactive before its TTL means the grant was already released, not expired.
      disposition = released.ok || !ttlExpired ? "released" : "expired";
      if (out.cancellationStopProof) out.cancellationLeaseDisposition = disposition;
      delete out.leaseRelease;
    }
    if (!out.phaseFailure && !out.error?.startsWith("policy_phase_failed:")) delete out.error;
    // Lease release is transport capacity only. A profiled specialist's native context is
    // retained until Runtime has applied its correlated result and drained native deliveries.
    out.status = "released";
    await this.save();
    return disposition;
  }
  /**
   * One bounded pass over the outbox. Each outbound is isolated: a failure is recorded on that message (error, attempt
   * count) and the pass continues, so one stuck recipient never blocks later messages. No waits for turns or reciprocal ACKs.
   */
  async flush(onBound: (out: Outbound, handle: AgentExecutionHandle) => Promise<void>): Promise<void> {
    for (const out of this.state.outbound) {
      try { await this.step(out, onBound); }
      catch (error) {
        out.error = String(error);
        out.deliveryAttempts = (out.deliveryAttempts ?? 0) + 1;
        if (error instanceof RoleCapabilityPreflightError) {
          // A preflight probe can fail transiently (pane query, git timeout, skill I/O): retry the unsent intent with backoff,
          // and only then fail it into the durable resumable blocker. No lease or transport side effect happened yet.
          const delay = PREFLIGHT_RETRY_DELAYS_MS[out.deliveryAttempts - 1];
          if (delay === undefined) { out.status = "failed"; delete out.nextAttemptAt; }
          else out.nextAttemptAt = new Date(Date.parse(this.now()) + delay).toISOString();
        }
        await this.save();
      }
    }
    await this.save();
  }
  /** A recipient that is not ready keeps its message queued; after NOT_READY_FAILURE_MS the wait is recorded as an error. */
  private markNotReady(out: Outbound): void {
    const now = Date.parse(this.now());
    out.notReadySince ??= new Date(now).toISOString();
    if (now - Date.parse(out.notReadySince) >= NOT_READY_FAILURE_MS)
      out.error = `Recipient ${out.message.recipient.role} not ready since ${out.notReadySince}`;
  }
  private markReady(out: Outbound): void {
    if (out.notReadySince === undefined) return;
    delete out.notReadySince;
    if (out.error?.includes(" not ready since ")) delete out.error;
  }
  private async step(out: Outbound, onBound: (out: Outbound, handle: AgentExecutionHandle) => Promise<void>): Promise<void> {
    const failoverRun = this.state.runs.find(run => run.runId === out.message.run_id);
    const held = failoverRun?.tasks.flatMap(task => task.failovers ?? []).find(entry => !["dispatched", "cancelled"].includes(entry.phase));
    if (held && out.message.recipient.role !== "conversation" && ["queued", "accepted"].includes(out.status) &&
        !(held.phase === "allocated" && held.destinationMessageId === out.message.message_id)) {
      out.error = "Provider continuation holds new work until reconciliation and binding settlement"; return;
    }
    if (out.phaseRetirement || out.reviewReplacement) return; // Physical tombstone: neither resend, renew nor manufacture an expired-lease release.
    if (out.leaseRelease) { await this.release(out); return; }
    // A Conversation inbox write-ahead stays "sending": Runtime applies it after this locked pass.
    if (out.status === "sending" && !isConversationDelivery(out)) { out.status = "unknown_delivery"; await this.save(); }
    if (out.status === "accepted" && out.handle) {
      const cancelledRun = this.state.runs.find(run => run.runId === out.message.run_id)?.cancelled;
      if (cancelledRun && ["task.assignment", "delegation.request", "verification.requested"].includes(out.message.type) &&
          !["conversation", "coordinator"].includes(out.message.recipient.role))
        return; // Cancellation reconciliation owns stop proof and lease release for this exact execution; pane readiness is insufficient.
      if (!out.parentAssignmentId) await onBound(out, out.handle);
      if (out.message.type === "task.assignment") {
        const run = this.state.runs.find(item => item.runId === out.message.run_id);
        const task = run?.tasks.find(item => item.taskId === out.taskId);
        if (task?.writerReleased) {
          await this.release(out);
          return;
        }
        if (run && !run.cancelled && !["completed", "failed", "escalated"].includes(run.status) &&
            (out.leaseRenewal !== undefined || !out.lease || Date.parse(out.lease.expiresAt) - Date.parse(this.now()) <= 240_000)) {
          try { await this.renew(out); } catch (error) { out.error = String(error); await this.save(); }
        }
        return;
      }
      const health = await this.ports.panes.inspectRoleHealth(out.selector);
      if (health.ok && health.value.readyForPrompt && health.value.occupantMatches && health.value.paneId === out.handle.target.paneId)
        await this.release(out); // transport capacity only; never task-success evidence
      else if (health.ok && health.value.occupantMatches && health.value.paneId === out.handle.target.paneId && !out.parentAssignmentId &&
          (out.leaseRenewal !== undefined || !out.lease || Date.parse(out.lease.expiresAt) - Date.parse(this.now()) <= 240_000))
        await this.renew(out); // a bounded host measurement may outlive one lease period
      return;
    }
    if (out.status !== "queued") return;
    if (out.nextAttemptAt !== undefined && Date.parse(out.nextAttemptAt) > Date.parse(this.now())) return; // backoff after a failed write/preflight
    // Never call the Gateway here: it may drain a queued user turn that enqueues back into this locked journal.
    if (isConversationDelivery(out)) {
      out.status = "sending"; await this.save(); return;
    }
    const policyRun = this.state.runs.find(item => item.runId === out.message.run_id);
    if (out.parentAssignmentId && record(out.message.payload).kind === "policy_phase_outcome" && policyRun &&
        (policyRun.status !== "implementing" || policyRun.cancelled || policyRun.nativeDeliveries?.length ||
          policyRun.approval !== undefined && policyRun.decision?.approvalId !== policyRun.approval.approvalId ||
          Object.values(policyRun.userDecisions ?? {}).some(item => item.status === "pending") ||
          this.state.outbound.some(item => item !== out && item.message.run_id === policyRun.runId && ["sending", "unknown_delivery"].includes(item.status)))) {
      out.error = "Policy continuation waits for active implementing state and all human/delivery gates";
      await this.save(); return;
    }
    if (out.error === "Policy continuation waits for active implementing state and all human/delivery gates") delete out.error;
    if (out.parentAssignmentId) {
      try { this.noticeParent(out); } catch (error) { out.status = "cancelled"; out.error = String(error); await this.save(); return; }
    }
    const run = this.state.runs.find(item => item.runId === out.message.run_id);
    if (run?.nativeDeliveries?.length && ["delegation.request", "task.assignment", "verification.requested"].includes(out.message.type)) {
      out.error = "Unknown native delivery must be reconciled before another work dispatch";
      await this.save(); return;
    }
    if (out.error === "Unknown native delivery must be reconciled before another work dispatch") delete out.error;
    if (run && (run.cancelled || ["completed", "failed", "escalated"].includes(run.status)) &&
        (out.message.type === "task.assignment" || out.message.type === "delegation.request" && out.message.sender.role === "coordinator")) {
      if (out.lease) await this.release(out);
      out.status = "cancelled"; await this.save(); return;
    }
    const bindingValue = unwrap(await this.ports.panes.getRoleBinding(out.selector));
    if (!bindingValue) { out.error = "Recipient pane unavailable"; return; }
    const pane = PaneBindingSchema.parse(bindingValue);
    const profileRun = this.state.runs.find(run => run.runId === out.message.run_id);
    const payloadPin = out.message.type === "task.assignment" ? profileRun?.definition?.tasks.find(task => task.id === out.taskId)?.roleProfile ??
      (profileRun?.conflictResolution?.attempts.some(attempt => attempt.messageId === out.message.message_id) ? profileRun.conflictResolution.roleProfile : undefined)
      : out.message.type === "delegation.request" ? record(out.message.payload).roleProfile : out.roleProfile;
    if (!sameRoleProfilePin(payloadPin === undefined ? undefined : RoleProfilePinSchema.parse(payloadPin), out.roleProfile)) throw new Error("Durable dispatch profile pin was removed or changed");
    const pinnedProfile = selectRoleProfile(profileRun?.roleProfiles, pane.role, out.roleProfile, out.capabilities);
    assertProfileBinding(pinnedProfile, pane);
    // A platform launch's empty Gateway grant is not native readiness. Do not create an
    // immutable submission target until its real provider session has been persisted.
    if (pane.metadata?.launchId !== undefined && !pane.session) { this.markNotReady(out); return; }
    const health = unwrap(await this.ports.panes.inspectRoleHealth(out.selector));
    if (!health.readyForPrompt || !health.occupantMatches || health.paneId !== pane.paneId || health.agentId !== pane.agentId) {
      if (health.occupantMatches && health.paneId === pane.paneId && health.agentId === pane.agentId &&
          this.state.outbound.some(item => item !== out && !item.phaseRetirement && !item.reviewReplacement &&
            item.status === "accepted" && item.handle?.target.paneId === pane.paneId && item.handle?.target.agentId === pane.agentId)) {
        this.markReady(out); return;
      }
      this.markNotReady(out); return;
    }
    this.markReady(out);
    const reviewSource = this.state.outbound.find(item => item.reviewReplacement?.replacementMessageId === out.message.message_id);
    if (reviewSource) {
      const original = reviewSource.handle?.target;
      const blockers: string[] = [];
      if (!run || run.cancelled || run.status !== "verifying") blockers.push("run_not_verifying");
      if (run?.nativeDeliveries?.length || this.state.outbound.some(item => item.message.run_id === run?.runId &&
          (item.status === "unknown_delivery" || item.status === "sending" && !isConversationDelivery(item)))) blockers.push("unreconciled_delivery");
      if (run?.approval && run.decision?.approvalId !== run.approval.approvalId || Object.values(run?.userDecisions ?? {}).some(item => item.status === "pending")) blockers.push("pending_human_gate");
      if (!original?.session || !pane.session || pane.role !== reviewSource.message.recipient.role || !["reviewer", "qa"].includes(pane.role) || !pane.readOnlyWorkspace || pane.paneId === original.paneId || digest(pane.session) === digest(original.session)) blockers.push("replacement_native_identity");
      if (out.message.type !== "verification.requested" || digest(out.message.payload) !== reviewSource.reviewReplacement!.contextDigest) blockers.push("context_changed");
      if (digest(out.capabilities) !== digest(reviewSource.capabilities)) blockers.push("capabilities_changed");
      if (blockers.length) {
        out.error = `Authorized workflow review replacement waits: ${blockers.join(", ")}`; await this.save(); return;
      }
      if (out.error?.startsWith("Authorized workflow review replacement waits")) delete out.error;
    }
    // A continuation is separately leased, and can only wake the exact native session holding the unchanged review.
    if (record(out.message.payload).kind === "resume_verification_request") {
      const source = this.state.outbound.find(item => item.message.message_id === record(out.message.payload).sourceMessageId);
      const target = source?.handle?.target;
      const replied = this.state.inbox.some(item => item.status === "applied" && item.message.causation_id === source?.message.message_id &&
        ["review.verdict", "task.status"].includes(item.message.type) && (item.message.type !== "task.status" || record(item.message.payload).status === "blocked"));
      if (!run || run.cancelled || run.status !== "verifying" || source?.status !== "released" || source.message.type !== "verification.requested" ||
          source.message.run_id !== run.runId || record(record(source.message.payload).definition).configuration === undefined ||
          record(record(record(source.message.payload).definition).configuration).kind !== "review" || !target || !pane.session ||
          target.agentId !== pane.agentId || target.paneId !== pane.paneId || target.workspaceId !== pane.workspaceId || target.tabId !== pane.tabId || digest(target.session) !== digest(pane.session) ||
          run.nativeDeliveries?.length || replied || run.approval && run.decision?.approvalId !== run.approval.approvalId ||
          Object.values(run.userDecisions ?? {}).some(item => item.status === "pending") ||
          this.state.outbound.some(item => item.message.run_id === run.runId && ["sending", "unknown_delivery"].includes(item.status))) {
        out.status = "cancelled"; out.error = "Review continuation no longer matches an active known-delivered request"; await this.save(); return;
      }
    }
    if (record(out.message.payload).kind === "result_reminder") {
      const source = this.state.outbound.find(item => item.message.message_id === record(out.message.payload).sourceMessageId);
      const target = source?.handle?.target;
      if (target?.session && pane.session && digest(target.session) !== digest(pane.session)) {
        out.status = "cancelled"; out.error = "Result reminder recipient native session changed after restart"; await this.save(); return;
      }
    }
    // Fail closed before Registry lease acquisition, dispatch intent, or transport side effects.
    const planRun = this.state.runs.find(run => run.runId === out.message.run_id);
    const guardWorkDispatch = async () => {
      const continuation = planRun?.tasks.flatMap(task => task.failovers ?? []).find(entry => entry.destinationMessageId === out.message.message_id);
      if (continuation) {
        if (planRun!.cancelled || continuation.phase !== "allocated" || !continuation.stopProof || !this.ports.providerFailover ||
            planRun!.nativeDeliveries?.length || planRun!.approval && planRun!.decision?.approvalId !== planRun!.approval.approvalId ||
            Object.values(planRun!.userDecisions ?? {}).some(item => item.status === "pending") ||
            this.state.outbound.some(item => item !== out && item.message.run_id === planRun!.runId && !isConversationDelivery(item) && ["sending", "unknown_delivery"].includes(item.status)))
          throw new Error("Provider continuation dispatch is held by lifecycle or delivery state");
        await this.ports.providerFailover.assertMutationSafe(continuation.sourceBinding, planRun!.runId, out.taskId);
      }
      if (["task.assignment", "delegation.request", "verification.requested"].includes(out.message.type)) {
        await assertRunExecutionPlan(planRun, this.ports.readExecutionResolution);
        await this.ports.revalidateRoleSkills?.(pane);
        if (pinnedProfile) {
          assertProfileSnapshotCurrent(pinnedProfile, this.ports.roleProfiles);
          if (!this.ports.preflightRoleProfile) throw new Error("Profile dispatch preflight is unsupported");
          await this.ports.preflightRoleProfile(pinnedProfile, pane.role, out.capabilities);
          assertProfileBinding(pinnedProfile, PaneBindingSchema.parse(unwrap(await this.ports.panes.getRoleBinding(out.selector))));
          await assertRunExecutionPlan(planRun, this.ports.readExecutionResolution);
          assertProfileSnapshotCurrent(pinnedProfile, this.ports.roleProfiles);
        }
      }
    };
    await guardWorkDispatch();
    if (["reviewer", "qa", "tester"].includes(pane.role)) {
      const implementationTargets = this.state.outbound.filter(item => item.message.run_id === out.message.run_id && item.message.type === "task.assignment" && item.handle)
        .map(item => ({ ...item.handle!.target, executorLineage: item.executorLineage }));
      assertIndependentProfileExecutor(pane, implementationTargets);
    }
    if (pinnedProfile) {
      if (!this.ports.attestExecutorLineage) throw new Error("Profiled launch requires authenticated executor lineage");
      const lineage = ExecutorLineageSchema.parse(await this.ports.attestExecutorLineage(pane,
        out.message.type === "task.assignment" ? "implementation" : ["reviewer", "qa", "tester"].includes(pane.role) ? "verification" : "specialist", out.message.message_id));
      if (!pane.session || lineage.bindingId !== pane.bindingId || lineage.nativeSessionId !== pane.session.value || !lineage.assignmentIds.includes(out.message.message_id))
        throw new Error("Profile executor lineage does not match the authenticated pane/native session");
      if (out.executorLineage && out.executorLineage.executorId !== lineage.executorId) throw new Error("Pinned executor lineage changed");
      if (lineage.purpose === "verification") assertIndependentProfileExecutor({ ...pane, executorLineage: lineage }, this.state.outbound.filter(item =>
        item.message.run_id === out.message.run_id && item.message.type === "task.assignment" && item.handle).map(item => ({ ...item.handle!.target, executorLineage: item.executorLineage })));
      out.executorLineage = lineage; await this.save();
    }
    await this.ports.preflightRoleCapabilities?.(pane, out.capabilities);
    await guardWorkDispatch();
    if (out.parentAssignmentId) {
      try { await this.validateNotice(out, pane); }
      catch (error) { out.status = "cancelled"; out.error = String(error); await this.save(); return; }
    }
    if (!out.parentAssignmentId) {
      const capabilities = [...(this.ports.roleCapabilities[pane.role] ?? [])];
      const config = AgentConfigurationSchema.parse({ agentId: pane.agentId, role: pane.role, transport: "herdr", enabled: true,
        priority: 0, maxConcurrentTasks: 1, capabilities, settings: {} });
      unwrap(await this.ports.registry.upsert(config));
      const resolved = unwrap(await this.ports.registry.resolve(pane.role, { runId: out.message.run_id!,
        taskId: out.taskId, preferredAgentId: pane.agentId, requiredCapabilities: out.capabilities }));
      if (!resolved || resolved.agentId !== pane.agentId) { out.error = "No capable agent in recipient pane"; return; }
      if (!out.lease) {
        await guardWorkDispatch();
        const identity = prelaunchLeaseIdentity(out);
        const acquired = await this.ports.registry.acquireLease({
          leaseId: identity.leaseId, agentId: pane.agentId, runId: out.message.run_id!,
          taskId: out.taskId, attemptId: out.attemptId, ttlMs: 300_000, requestedAt: this.now(),
          idempotencyKey: identity.idempotencyKey
        });
        if (!acquired.ok) { out.error = acquired.error.message; return; }
        out.lease = AgentLeaseSchema.parse(acquired.value);
        if (out.prelaunchFailure?.lease && out.lease.fencingToken <= out.prelaunchFailure.lease.fencingToken) throw new Error("Recovered dispatch requires a fresh Registry fence");
        await this.save();
      }
    }
    // Registry is authoritative: renewal detects stale/released fencing tokens and optimistic versions.
    try { await this.renew(out); } catch (error) {
      if (!out.parentAssignmentId) throw error;
      out.error = String(error); await this.save(); return;
    }
    if (!out.lease) throw new Error("Dispatch has no lease");
    if (out.lease.agentId !== pane.agentId || Date.parse(out.lease.expiresAt) <= Date.parse(this.now())) throw new Error("Stale dispatch lease");
    const target = this.target(pane);
    let wire = out.message;
    if (wire.type === "task.assignment") {
      const run = this.state.runs.find(r => r.runId === wire.run_id);
      if (!run) throw new Error("Assignment without delegation");
      out.assignment = AgentAssignmentSchema.parse({ schemaVersion: 2, assignmentId: `assignment-${digest(wire.message_id)}`,
        ...(pinnedProfile ? { roleProfile: pinnedProfile.pin } : {}),
        runId: run.runId, taskId: out.taskId, delegationId: run.delegation.delegationId, role: pane.role,
        agentId: pane.agentId, paneId: pane.paneId, leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken,
        requiredCapabilities: out.capabilities, assignedBy: "coordinator", assignedAt: out.message.occurred_at ?? this.now(),
        status: "assigned", ...(pane.worktreePath ? { worktreePath: pane.worktreePath } : {}), idempotencyKey: wire.idempotency_key });
      wire = RoleMessageSchema.parse({ ...wire, recipient: { role: pane.role, agent_id: pane.agentId, pane_id: pane.paneId },
        payload: { assignment: out.assignment, context: wire.payload } });
    }
    try { wire = projectPolicyPhaseEnvelope(wire); }
    catch (error) { out.status = "queued"; out.error = `Prompt presentation blocked before transport: ${String(error)}`; await this.save(); return; }
    if (out.request && (digest(out.request.target) !== digest(target) || digest(out.request.context) !== digest(json(wire)))) {
      out.error = "Pinned request or recipient changed; explicit reconciliation required"; await this.save(); return;
    }
    out.request ??= AgentRequestSchema.parse({ requestId: `request-${digest(wire.message_id)}`, attemptId: out.attemptId,
      runId: wire.run_id, taskId: out.taskId, role: pane.role, target, instruction: JSON.stringify(wire),
      workingDirectory: pane.cwd, inputs: wire.artifact_references, context: json(wire), attempt: 1,
      retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
      timeout: { executionTimeoutMs: 300_000, onTimeout: "block" },
      idempotency: { key: wire.idempotency_key, scope: "agent-request", fingerprint: digest(wire) },
      createdAt: this.now(), metadata: { leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken } });
    if (wire.type === "delegation.request" && wire.recipient.role === "coordinator")
      out.coordinatorResponseBaseline ??= this.state.outbound.length;
    await guardWorkDispatch();
    if (pane.role === "developer" && !out.parentAssignmentId) await this.ports.pinDeveloperDispatch?.(out.request, pane);
    out.status = "sending";
    await this.save(); // write-ahead intent; a crash/lost acknowledgement forbids resend
    if (out.parentAssignmentId) {
      try {
        const current = unwrap(await this.ports.panes.getRoleBinding(out.selector));
        if (!current) throw new Error("Task notice recipient disappeared");
        const currentPane = PaneBindingSchema.parse(current), currentHealth = unwrap(await this.ports.panes.inspectRoleHealth(out.selector));
        if (!currentHealth.readyForPrompt || !currentHealth.occupantMatches || currentHealth.paneId !== currentPane.paneId || currentHealth.agentId !== currentPane.agentId)
          throw new Error("Task notice recipient is no longer ready");
        await this.validateNotice(out, currentPane); await this.renew(out);
      } catch (error) { out.status = "queued"; out.error = String(error); await this.save(); return; }
    }
    if (pane.role === "developer" && !out.parentAssignmentId && this.ports.pinDeveloperDispatch) {
      // Scope bootstrap verification can await the OS. Revalidate the current lease/fence after it and the durable dispatch intent.
      try { await this.renew(out); }
      catch (error) { out.status = "queued"; out.error = `Developer dispatch lease is no longer current: ${String(error)}`; await this.save(); return; }
    }
    try { await guardWorkDispatch(); }
    catch (error) { if (error instanceof ExecutionPlanDriftError || error instanceof RoleCapabilityPreflightError) { out.status = "queued"; await this.save(); } throw error; }
    try {
      const value = unwrap(await this.ports.transport.send(out.request));
      const receipt = AgentSubmissionReceiptSchema.parse(value);
      if (receipt.requestId !== out.request.requestId || receipt.attemptId !== out.attemptId || receipt.runId !== out.request.runId || receipt.taskId !== out.taskId)
        throw new Error("Transport receipt ownership mismatch");
      if (receipt.status === "accepted") {
        if (digest(receipt.handle.target) !== digest(out.request.target) || receipt.handle.idempotencyKey !== out.request.idempotency.key)
          throw new Error("Transport binding mismatch");
        out.handle = receipt.handle; out.status = "accepted"; delete out.error; delete out.deliveryAttempts; delete out.nextAttemptAt;
        await this.save();
        if (!out.parentAssignmentId) await onBound(out, receipt.handle);
      } else if (receipt.status === "unknown_delivery") {
        out.status = "unknown_delivery"; out.error = receipt.reason; await this.save();
      } else {
        // A proven rejection permits a later delivery, while other panes remain independently drainable.
        out.status = "queued"; out.error = receipt.reason; await this.save();
      }
    } catch (error) {
      out.status = "unknown_delivery"; out.error = String(error); await this.save();
    }
  }
  async reconcile(messageId: string, onBound: (out: Outbound, handle: AgentExecutionHandle) => Promise<void>): Promise<void> {
    const out = this.state.outbound.find(item => item.message.message_id === messageId);
    if (!out?.request || !["sending", "unknown_delivery"].includes(out.status)) throw new Error("No uncertain handoff to reconcile");
    if (provenPrelaunchPolicyFailure(out, this.state.inbox)) {
      // Retain exact release arguments before touching Registry, while the original prelaunch proof remains replayable.
      if (out.lease) {
        out.leaseRelease ??= ReleaseAgentLeaseRequestSchema.parse({leaseId:out.lease.leaseId,fencingToken:out.lease.fencingToken,
          expectedVersion:out.lease.version,releasedAt:this.now(),idempotencyKey:`prelaunch-release:${out.request.requestId}:${out.lease.version}`});
        await this.save();
        const released = await this.ports.registry.releaseLease(out.leaseRelease);
        if (!released.ok && !(released.error.code === "conflict" && Date.parse(out.lease.expiresAt) <= Date.parse(this.now()))) throw new PrelaunchRegistryRecoveryError(`${released.error.code}: ${released.error.message}`);
      }
      out.prelaunchFailure = { request: out.request, reconciledAt: this.now(),
        ...(out.executorLineage ? {executorLineage:out.executorLineage} : {}), ...(out.lease ? {lease:out.lease} : {}) };
      delete out.lease; delete out.leaseRelease; delete out.leaseRenewal; delete out.executorLineage;
      delete out.request; // No invocation exists: normal dispatch must pin the current recipient after host recovery.
      out.status = "queued"; out.error = "Reconciled exact oversized Node prelaunch E2BIG; no invocation started";
      await this.save(); return;
    }
    const req = out.request;
    const result = AgentReconciliationResultSchema.parse(unwrap(await this.ports.transport.reconcile({
      requestId: req.requestId, attemptId: req.attemptId, runId: req.runId, taskId: req.taskId,
      idempotencyKey: req.idempotency.key, target: req.target, requestedAt: this.now()
    })));
    if (result.status === "bound") {
      if (result.handle.requestId !== req.requestId || result.handle.attemptId !== req.attemptId || result.handle.runId !== req.runId ||
          result.handle.taskId !== req.taskId || result.handle.idempotencyKey !== req.idempotency.key || digest(result.handle.target) !== digest(req.target))
        throw new Error("Reconciled handle ownership mismatch");
      out.handle = result.handle; out.status = "accepted"; await this.save(); if (!out.parentAssignmentId) await onBound(out, result.handle);
    } else if (result.status === "not_delivered") {
      if (result.requestId !== req.requestId) throw new Error("Reconciliation request mismatch");
      out.status = "queued"; await this.save();
    } else { out.status = "unknown_delivery"; await this.save(); }
  }
}
