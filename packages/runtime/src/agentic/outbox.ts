import {
  AgentAssignmentSchema, AgentConfigurationSchema, AgentLeaseSchema, AgentReconciliationResultSchema,
  AgentRequestSchema, AgentSubmissionReceiptSchema, PaneBindingSchema, RoleMessageSchema,
  type AgentExecutionHandle, type OperationResult, type RoleMessage
} from "@bflow/contracts";
import type { AgenticRuntimePorts } from "./ports.js";
import { digest, json, type JournalState, type Outbound } from "./journal.js";

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
    const out: Outbound = { message: parsed, status: "queued", selector, taskId, attemptId, capabilities };
    this.state.outbound.push(out);
    return out;
  }
  async renew(out: Outbound): Promise<void> {
    if (!out.lease) throw new Error("Assignment has no current lease");
    out.lease = AgentLeaseSchema.parse(unwrap(await this.ports.registry.renewLease({ leaseId: out.lease.leaseId,
      fencingToken: out.lease.fencingToken, expectedVersion: out.lease.version, ttlMs: 300_000,
      requestedAt: this.now(), idempotencyKey: `renew:${out.message.message_id}:${out.lease.version}` })));
    if (Date.parse(out.lease.expiresAt) <= Date.parse(this.now())) throw new Error("Expired assignment lease");
    await this.save();
  }
  async release(out: Outbound): Promise<void> {
    if (out.status === "released") return;
    if (out.lease) unwrap(await this.ports.registry.releaseLease({
      leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken, expectedVersion: out.lease.version,
      releasedAt: this.now(), idempotencyKey: `release:${out.lease.leaseId}:${out.lease.version}`
    }));
    out.status = "released";
    await this.save();
  }
  async flush(onBound: (out: Outbound, handle: AgentExecutionHandle) => Promise<void>): Promise<void> {
    // One bounded pass. No waits for turns or reciprocal ACKs while holding a mailbox/runtime lock.
    for (const out of this.state.outbound) {
      if (out.status === "sending") { out.status = "unknown_delivery"; await this.save(); }
      if (out.status === "accepted" && out.handle) {
        await onBound(out, out.handle);
        if (out.message.type === "task.assignment") {
          const run = this.state.runs.find(item => item.runId === out.message.run_id);
          if (run && !run.cancelled && !["completed", "failed", "escalated"].includes(run.status)) {
            try { await this.renew(out); } catch (error) { out.error = String(error); await this.save(); }
          }
          continue;
        }
        const health = await this.ports.panes.inspectRoleHealth(out.selector);
        if (health.ok && health.value.readyForPrompt && health.value.occupantMatches && health.value.paneId === out.handle.target.paneId)
          await this.release(out); // transport capacity only; never task-success evidence
        continue;
      }
      if (out.status !== "queued") continue;
      const run = this.state.runs.find(item => item.runId === out.message.run_id);
      if (run && (run.cancelled || ["completed", "failed", "escalated"].includes(run.status)) &&
          (out.message.type === "task.assignment" || out.message.type === "delegation.request" && out.message.sender.role === "coordinator")) {
        if (out.lease) await this.release(out);
        out.status = "cancelled"; await this.save(); continue;
      }
      const bindingValue = unwrap(await this.ports.panes.getRoleBinding(out.selector));
      if (!bindingValue) { out.error = "Recipient pane unavailable"; continue; }
      const pane = PaneBindingSchema.parse(bindingValue);
      const health = unwrap(await this.ports.panes.inspectRoleHealth(out.selector));
      if (!health.readyForPrompt || !health.occupantMatches || health.paneId !== pane.paneId || health.agentId !== pane.agentId) continue;
      const capabilities = [...(this.ports.roleCapabilities[pane.role] ?? [])];
      const config = AgentConfigurationSchema.parse({ agentId: pane.agentId, role: pane.role, transport: "herdr", enabled: true,
        priority: 0, maxConcurrentTasks: 1, capabilities, settings: {} });
      unwrap(await this.ports.registry.upsert(config));
      const resolved = unwrap(await this.ports.registry.resolve(pane.role, { runId: out.message.run_id!,
        taskId: out.taskId, preferredAgentId: pane.agentId, requiredCapabilities: out.capabilities }));
      if (!resolved || resolved.agentId !== pane.agentId) { out.error = "No capable agent in recipient pane"; continue; }
      if (!out.lease) {
        const acquired = await this.ports.registry.acquireLease({
          leaseId: `lease-${digest(out.message.message_id)}`, agentId: pane.agentId, runId: out.message.run_id!,
          taskId: out.taskId, attemptId: out.attemptId, ttlMs: 300_000, requestedAt: this.now(),
          idempotencyKey: `acquire:${out.message.message_id}`
        });
        if (!acquired.ok) { out.error = acquired.error.message; continue; }
        out.lease = AgentLeaseSchema.parse(acquired.value);
        await this.save();
      }
      // Registry is authoritative: renewal detects stale/released fencing tokens and optimistic versions.
      await this.renew(out);
      if (out.lease.agentId !== pane.agentId || Date.parse(out.lease.expiresAt) <= Date.parse(this.now())) throw new Error("Stale dispatch lease");
      const target = { transport: "herdr", agentId: pane.agentId, paneId: pane.paneId, workspaceId: pane.workspaceId,
        tabId: pane.tabId, ...(pane.terminalId ? { terminalId: pane.terminalId } : {}),
        ...(pane.session ? { session: pane.session } : {}), ...(pane.worktreePath ? { worktreePath: pane.worktreePath } : {}) };
      let wire = out.message;
      if (wire.type === "task.assignment") {
        const run = this.state.runs.find(r => r.runId === wire.run_id);
        if (!run) throw new Error("Assignment without delegation");
        out.assignment = AgentAssignmentSchema.parse({ schemaVersion: 2, assignmentId: `assignment-${digest(wire.message_id)}`,
          runId: run.runId, taskId: out.taskId, delegationId: run.delegation.delegationId, role: pane.role,
          agentId: pane.agentId, paneId: pane.paneId, leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken,
          requiredCapabilities: out.capabilities, assignedBy: "coordinator", assignedAt: out.message.occurred_at ?? this.now(),
          status: "assigned", ...(pane.worktreePath ? { worktreePath: pane.worktreePath } : {}), idempotencyKey: wire.idempotency_key });
        wire = RoleMessageSchema.parse({ ...wire, recipient: { role: pane.role, agent_id: pane.agentId, pane_id: pane.paneId },
          payload: { assignment: out.assignment, context: wire.payload } });
      }
      if (out.request && (digest(out.request.target) !== digest(target) || digest(out.request.context) !== digest(json(wire)))) {
        out.error = "Pinned request or recipient changed; explicit reconciliation required"; await this.save(); continue;
      }
      out.request ??= AgentRequestSchema.parse({ requestId: `request-${digest(wire.message_id)}`, attemptId: out.attemptId,
        runId: wire.run_id, taskId: out.taskId, role: pane.role, target, instruction: JSON.stringify(wire),
        workingDirectory: pane.cwd, inputs: wire.artifact_references, context: json(wire), attempt: 1,
        retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 300_000, onTimeout: "block" },
        idempotency: { key: wire.idempotency_key, scope: "agent-request", fingerprint: digest(wire) },
        createdAt: this.now(), metadata: { leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken } });
      out.status = "sending";
      await this.save(); // write-ahead intent; a crash/lost acknowledgement forbids resend
      try {
        const value = unwrap(await this.ports.transport.send(out.request));
        const receipt = AgentSubmissionReceiptSchema.parse(value);
        if (receipt.requestId !== out.request.requestId || receipt.attemptId !== out.attemptId || receipt.runId !== out.request.runId || receipt.taskId !== out.taskId)
          throw new Error("Transport receipt ownership mismatch");
        if (receipt.status === "accepted") {
          if (digest(receipt.handle.target) !== digest(out.request.target) || receipt.handle.idempotencyKey !== out.request.idempotency.key)
            throw new Error("Transport binding mismatch");
          out.handle = receipt.handle; out.status = "accepted"; delete out.error;
          await this.save();
          await onBound(out, receipt.handle);
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
    await this.save();
  }
  async reconcile(messageId: string, onBound: (out: Outbound, handle: AgentExecutionHandle) => Promise<void>): Promise<void> {
    const out = this.state.outbound.find(item => item.message.message_id === messageId);
    if (!out?.request || !["sending", "unknown_delivery"].includes(out.status)) throw new Error("No uncertain handoff to reconcile");
    const req = out.request;
    const result = AgentReconciliationResultSchema.parse(unwrap(await this.ports.transport.reconcile({
      requestId: req.requestId, attemptId: req.attemptId, runId: req.runId, taskId: req.taskId,
      idempotencyKey: req.idempotency.key, target: req.target, requestedAt: this.now()
    })));
    if (result.status === "bound") {
      if (result.handle.requestId !== req.requestId || result.handle.attemptId !== req.attemptId || result.handle.runId !== req.runId ||
          result.handle.taskId !== req.taskId || result.handle.idempotencyKey !== req.idempotency.key || digest(result.handle.target) !== digest(req.target))
        throw new Error("Reconciled handle ownership mismatch");
      out.handle = result.handle; out.status = "accepted"; await this.save(); await onBound(out, result.handle);
    } else if (result.status === "not_delivered") {
      if (result.requestId !== req.requestId) throw new Error("Reconciliation request mismatch");
      out.status = "queued"; await this.save();
    } else { out.status = "unknown_delivery"; await this.save(); }
  }
}
