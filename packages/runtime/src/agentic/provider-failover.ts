import { DeveloperContinuationAllocationSchema, FailoverCandidateSchema, PaneBindingSchema, RoleMessageSchema, ProviderFailureObservationSchema,
  ProviderFailoverPolicySchema } from "@bflow/contracts";
import { digest, json, record, strings, type JournalState, type RunRecord, type TaskRecord } from "./journal.js";
import type { AgenticRuntimePorts } from "./ports.js";
import type { CoreSession } from "./core-session.js";
import { HerdrOutbox, unwrap } from "./outbox.js";
import { TaskFailoverSchema, type TaskFailover } from "./provider-failover-state.js";
import { CancellationStopProofSchema } from "./cancellation-stop.js";
import { HandoverBindingSchema, TaskHandoverStore, handoverRevision, selectHandover } from "./task-handover.js";
import { evaluateFailover } from "../platform/failover-decision.js";
import { assertRunExecutionPlan } from "./execution-binding.js";

type Notify = (run: RunRecord, entry: TaskFailover, reason: string, blocked: boolean) => void;
/** Caller holds the existing AgenticJournal lock. Every side effect follows a durable phase; there is no cross-system transaction. */
export class TaskProviderFailover {
  constructor(private readonly ports: AgenticRuntimePorts, private readonly state: JournalState, private readonly save: () => Promise<void>,
    private readonly core: CoreSession, private readonly outbox: HerdrOutbox, private readonly handovers: TaskHandoverStore,
    private readonly now: () => string, private readonly notify: Notify) {}

  async observe(bindingInput: unknown, failureInput: unknown): Promise<TaskFailover> {
    const binding = PaneBindingSchema.parse(bindingInput), failure = ProviderFailureObservationSchema.parse(failureInput);
    // A continuation allocates a fresh plain Developer. It cannot carry a pinned specialist profile (and a profile cannot
    // switch provider), so a profiled execution is never failed over: that would silently drop its pin and restrictions.
    if (binding.roleProfile) throw new Error("Provider failover is unsupported for a pinned specialist profile execution");
    const config = this.ports.providerFailover;
    if (!config || !failure.evidenceDigest || !await config.authenticate(binding, failure)) throw new Error("Unauthenticated provider failure");
    const admitted = this.state.runs.flatMap(run => run.tasks).flatMap(task => task.failovers ?? []).find(entry => entry.sourceHandle.executionId === failure.executionId);
    if (admitted) {
      if (admitted.failure.evidenceDigest !== failure.evidenceDigest || digest(admitted.sourceBinding) !== digest(binding)) throw new Error("Conflicting provider failure replay");
      return admitted;
    }
    const source = this.state.outbound.find(out => out.status === "accepted" && out.message.type === "task.assignment" &&
      out.handle?.executionId === failure.executionId && out.handle.target.paneId === binding.paneId && out.handle.target.agentId === binding.agentId &&
      digest(out.handle.target.session) === digest(binding.session) && out.handle.target.worktreePath === binding.worktreePath);
    const run = source && this.state.runs.find(run => run.runId === source.message.run_id), task = run?.tasks.find(task => task.taskId === source!.taskId);
    if (!source?.handle || !run || !task || binding.role !== "developer" || task.result || run.cancelled || binding.provider !== failure.provider)
      throw new Error("Provider failure has no current task execution");
    const snapshot = await this.core.snapshot(run.runId), currentTask = snapshot.tasks.find(item => item.taskId === task.taskId);
    if (currentTask?.status !== "running" || currentTask.agentExecution?.executionId !== failure.executionId) throw new Error("Stale provider failure");
    const selection = config.policyFor(binding);
    if (!selection) throw new Error("No approved failover policy for this role/profile");
    const policy = ProviderFailoverPolicySchema.parse(selection.policy);
    const prior = task.failovers?.find(entry => entry.destinationMessageId === source.message.message_id && entry.phase === "dispatched");
    const current = FailoverCandidateSchema.parse(prior?.destination ?? selection.current);
    if (policy.role !== binding.role || current.provider !== binding.provider || current.model !== binding.model ||
        Date.parse(failure.observedAt) < Date.parse(source.handle.acceptedAt) || Date.parse(failure.observedAt) > Date.parse(this.now()))
      throw new Error("Provider failure role, model, time or policy binding mismatch");
    if ((task.failovers?.length ?? 0) >= 17) throw new Error("Provider failure history exhausted");
    const entry = TaskFailoverSchema.parse({ switchId: `switch-${digest([run.runId, task.taskId, failure.executionId])}`,
      sourceMessageId: source.message.message_id, sourceBinding: binding, sourceHandle: source.handle, current,
      policy, policyDigest: digest(policy), failure, createdAt: this.now(), phase: "observed", rejectedCandidates: [], retryCount: 0 });
    (task.failovers ??= []).push(entry);
    this.notify(run, entry, failure.kind, false); await this.save();
    return entry;
  }

  private hold(run: RunRecord, entry: TaskFailover, reason: string, blocked = false) {
    entry.reason = reason;
    if (blocked) { entry.phase = "blocked"; run.status = "escalated"; }
    run.error = `Provider continuation: ${reason}`;
    this.notify(run, entry, reason, blocked);
  }
  private async safe(run: RunRecord, entry: TaskFailover): Promise<boolean> {
    if (run.cancelled) { entry.phase = "cancelled"; await this.save(); return false; }
    if (run.approval && run.decision?.approvalId !== run.approval.approvalId || Object.values(run.userDecisions ?? {}).some(item => item.status === "pending")) {
      this.hold(run, entry, "pending_human_gate"); return false;
    }
    if (run.nativeDeliveries?.length || this.state.outbound.some(out => out.message.run_id === run.runId &&
        ["sending", "unknown_delivery"].includes(out.status) && out.message.recipient.role !== "conversation")) {
      this.hold(run, entry, "unreconciled_delivery"); return false;
    }
    try { await assertRunExecutionPlan(run, this.ports.readExecutionResolution); }
    catch { this.hold(run, entry, "policy_or_execution_resolution_changed", true); return false; }
    try { await this.ports.providerFailover!.assertMutationSafe(entry.sourceBinding, run.runId, entry.sourceHandle.taskId); }
    catch { this.hold(run, entry, "unreconciled_mutation"); return false; }
    return true;
  }

  async continue(): Promise<void> {
    let firstError: unknown;
    for (const run of this.state.runs) for (const task of run.tasks) for (const entry of task.failovers ?? []) {
      if (["dispatched", "cancelled"].includes(entry.phase)) continue;
      if (run.cancelled) { entry.phase = "cancelled"; await this.save(); continue; }
      if (entry.phase === "blocked" || !this.ports.providerFailover) continue;
      try {
        await this.step(run, task, entry);
        await this.save();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
  private async step(run: RunRecord, task: TaskRecord, entry: TaskFailover): Promise<void> {
    if (!await this.safe(run, entry)) return;
    if (digest(entry.policy) !== entry.policyDigest) throw new Error("Failover policy corruption");
    const source = this.state.outbound.find(out => out.message.message_id === entry.sourceMessageId)!;
    const current = (await this.core.snapshot(run.runId)).tasks.find(item => item.taskId === task.taskId);
    if (!source?.handle || current?.attemptId !== source.attemptId || current.status !== "running" || task.result) {
      this.hold(run, entry, "task_or_attempt_changed", true); return;
    }
    if (![entry.sourceHandle.executionId, this.state.outbound.find(out => out.message.message_id === entry.destinationMessageId)?.handle?.executionId].includes(current.agentExecution?.executionId)) {
      this.hold(run, entry, "execution_binding_changed", true); return;
    }
    const spent = (task.failovers ?? []).filter(item => item.spentAt && item !== entry);
    const switches = spent.filter(item => item.failure.kind !== "transient_rate_limit"), retrying = entry.failure.kind === "transient_rate_limit";
    entry.retryCount = spent.filter(item => item.failure.kind === "transient_rate_limit").length;
    const facts = { role: entry.sourceBinding.role, executionId: entry.sourceHandle.executionId, cancelled: false,
      delivery: "reconciled", mutation: "reconciled", oldExecution: entry.stopProof ? "stopped" : "running", lease: "current" };
    if (retrying) {
      const decision = evaluateFailover({ now: this.now(), failure: entry.failure, current: entry.current, policy: entry.policy,
        switchHistory: [], retryCount: entry.retryCount, task: facts, readiness: [] });
      if (decision.kind === "blocked") { this.hold(run, entry, decision.reason, true); return; }
      if (decision.kind !== "retry_after" || Date.parse(decision.until) > Date.parse(this.now())) { this.hold(run, entry, "transient_rate_limit_backoff"); return; }
    } else if (!["quota_exhausted", "provider_unavailable"].includes(entry.failure.kind)) {
      this.hold(run, entry, "failure_not_eligible", true); return;
    }
    if (!entry.spentAt && !retrying && switches.length >= entry.policy.maxSwitches) { this.hold(run, entry, "switch_budget_exhausted", true); return; }
    if (!entry.spentAt && spent.some(item => Date.parse(this.now()) < Date.parse(item.spentAt!) + entry.policy.cooldownMs)) {
      this.hold(run, entry, "cooldown"); return;
    }
    if (entry.phase === "observed" || entry.phase === "stopping") {
      if (entry.stopAttempts >= 3) { this.hold(run, entry, "old_execution_stop_budget_exhausted", true); return; }
      try { await this.outbox.renew(source); }
      catch { this.hold(run, entry, "lease_not_current", true); return; }
      entry.phase = "stopping"; entry.stopAttempts++; await this.save();
      let proof;
      try { proof = await this.ports.stopDeveloperExecutionScope?.(entry.sourceHandle, entry.sourceBinding); }
      catch { this.hold(run, entry, "old_execution_stop_requires_reconciliation", entry.stopAttempts >= 3); return; }
      if (!proof) { this.hold(run, entry, "old_execution_not_stopped"); return; }
      const stopped = CancellationStopProofSchema.parse(proof);
      if (digest(stopped.handle) !== digest(entry.sourceHandle) || Date.parse(stopped.observedAt) < Date.parse(entry.sourceHandle.acceptedAt) || Date.parse(stopped.observedAt) > Date.parse(this.now()))
        throw new Error("Foreign provider stop proof");
      entry.stopProof = stopped; entry.phase = "stopped"; await this.save();
    }
    if (!await this.safe(run, entry)) return;
    if (entry.phase === "stopped") {
      const bound = unwrap(await this.ports.panes.getRoleBinding(source.selector));
      if (bound && (bound.agentId !== entry.sourceBinding.agentId || bound.paneId !== entry.sourceBinding.paneId || digest(bound.session) !== digest(entry.sourceBinding.session))) {
        this.hold(run, entry, "source_binding_changed", true); return;
      }
      entry.revision = await handoverRevision(entry.sourceBinding.worktreePath!);
      const binding = HandoverBindingSchema.safeParse(record(source.message.payload).handoverBinding);
      const loaded = await this.handovers.read(run.runId, task.taskId);
      const selected = binding.success ? selectHandover(loaded, { ...binding.data, revision: entry.revision }, [binding.data]) : undefined;
      entry.handoverStatus = selected?.status === "selected" ? "selected" : loaded.status === "absent" ? "absent" : "withheld";
      await this.save();
      // The original Registry grant and pane are retired before any replacement is allocated. Replays use their existing receipts.
      await this.outbox.release(source);
      const release = this.ports.panes.releaseCancelledDeveloper ?? this.ports.panes.releaseDeveloper;
      unwrap(await release.call(this.ports.panes, { taskId: `${run.runId}-${task.taskId}`, closePane: false, removeWorktree: false }));
      entry.phase = "retired"; await this.save();
    }
    if (entry.phase === "retired") {
      for (const candidate of retrying ? [entry.current] : entry.policy.candidates) {
        if (entry.rejectedCandidates.some(item => digest(item) === digest(candidate)) || !retrying &&
            (digest(candidate) === digest(entry.current) || spent.some(item => digest(item.destination) === digest(candidate) || digest(item.current) === digest(candidate)))) continue;
        try { await this.ports.providerFailover!.preflight(candidate, entry.sourceBinding); }
        catch { entry.rejectedCandidates.push(candidate); await this.save(); continue; }
        if (!await this.safe(run, entry)) return;
        const decision = evaluateFailover({ now: this.now(), failure: entry.failure, current: entry.current, policy: entry.policy,
          switchHistory: switches.map(item => ({ candidate: item.destination!, switchedAt: item.spentAt! })), retryCount: entry.retryCount,
          attemptedCandidates: spent.flatMap(item => [item.current, item.destination!]),
          task: { role: entry.sourceBinding.role, executionId: entry.sourceHandle.executionId, cancelled: false, delivery: "reconciled", mutation: "reconciled", oldExecution: "stopped", lease: "current" },
          readiness: [{ candidate, ready: true, capabilities: true, tools: true, permission: true, rolePolicy: true, independent: true }] });
        if (decision.kind !== "eligible_fallback" && !(retrying && decision.kind === "retry_after" && Date.parse(decision.until) <= Date.parse(this.now()))) continue;
        entry.destination = candidate; entry.spentAt = this.now(); entry.phase = "allocating";
        entry.ordinal = (task.failovers ?? []).filter(item => item !== entry && item.phase === "dispatched" && item.sourceHandle.attemptId === source.attemptId).length + 1;
        entry.destinationMessageId = `continuation-${digest(entry.switchId)}`;
        await this.save();
        const allocation = await this.ports.panes.allocateDeveloper({ taskId: `${run.runId}-${task.taskId}`, runId: run.runId,
          worktreePath: entry.sourceBinding.worktreePath!, branchName: task.worktrees.at(-1)!.branchName,
          agentName: `dev-${digest(entry.switchId).slice(0, 20)}`, failoverCandidate: candidate, continuationId: entry.switchId,
          continuation: DeveloperContinuationAllocationSchema.parse({ schemaVersion: 3, sourceBindingId: entry.sourceBinding.bindingId, allocationTaskId: `${run.runId}-${task.taskId}`, runId: run.runId,
            worktreePath: entry.sourceBinding.worktreePath!, revision: entry.revision!,
            ownedPaths: strings(record(run.definition!.tasks.find(item => item.id === task.taskId)!.metadata).ownedPaths),
            forbiddenPaths: strings(record(run.definition!.tasks.find(item => item.id === task.taskId)!.metadata).forbiddenPaths ?? []) }) });
        if (!allocation.ok) { this.hold(run, entry, "replacement_launch_requires_reconciliation", true); return; }
        entry.destinationBinding = PaneBindingSchema.parse(allocation.value); entry.phase = "allocated"; await this.save(); break;
      }
      if (entry.phase === "retired") { this.hold(run, entry, "no_eligible_candidate", true); return; }
    }
    if (entry.phase === "allocating") {
      // Never repeat a launch after a crash. Adopt only the exact allocation whose durable manifest proves it exists.
      const found = unwrap(await this.ports.panes.getRoleBinding(`dev-${digest(entry.switchId).slice(0, 20)}`));
      if (!found) { this.hold(run, entry, "replacement_launch_requires_reconciliation", true); return; }
      entry.destinationBinding = PaneBindingSchema.parse(found); entry.phase = "allocated"; await this.save();
    }
    if (entry.phase === "allocated") {
      if (!await this.safe(run, entry)) return;
      const pane = entry.destinationBinding!, candidate = entry.destination!;
      if (pane.provider !== candidate.provider || pane.model !== candidate.model || pane.agentId === entry.sourceBinding.agentId ||
          pane.paneId === entry.sourceBinding.paneId || pane.worktreePath !== entry.sourceBinding.worktreePath ||
          digest(pane.session) === digest(entry.sourceBinding.session) || await handoverRevision(pane.worktreePath!) !== entry.revision) {
        this.hold(run, entry, "replacement_binding_or_revision_mismatch", true); return;
      }
      const payload = record(source.message.payload), oldHandover = HandoverBindingSchema.safeParse(payload.handoverBinding);
      const message = RoleMessageSchema.parse({ ...source.message, message_id: entry.destinationMessageId, causation_id: source.message.message_id,
        recipient: { role: "developer", agent_id: pane.agentId, pane_id: pane.paneId }, occurred_at: this.now(), idempotency_key: entry.destinationMessageId,
        payload: json({ ...payload, ...(oldHandover.success ? { handoverBinding: { ...oldHandover.data, assignmentId: entry.destinationMessageId, revision: entry.revision } } : {}),
          providerContinuation: { switchId: entry.switchId, sourceExecutionId: source.handle!.executionId, handoverStatus: entry.handoverStatus,
            instruction: "Continue the unchanged accepted task in this preserved worktree. Read current assignment context and host-selected handover; absent/withheld handover means use existing context, never invent history. All approvals, TDD evidence, verification and ownership rules remain authoritative." } }) });
      this.outbox.enqueue(message, pane.bindingId, task.taskId, source.attemptId, source.capabilities);
      if (!task.outboundIds.includes(message.message_id)) task.outboundIds.push(message.message_id);
      delete entry.reason; delete run.error; await this.save();
      // Outbox owns intent/lease/binding/unknown-delivery recovery. The old Core execution is replaced only by its accepted new handle.
    }
  }
}
