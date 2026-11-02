import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AcquireAgentLeaseRequestSchema, AgentConfigurationSchema, AgentLeaseSchema, AgentRequestSchema, AgentExecutionHandleSchema, AgentBindingReceiptSchema,
  ArtifactReferenceSchema, ArtifactWriteOptionsSchema, IdentifierSchema, PaneBindingSchema,
  ReleaseAgentLeaseRequestSchema, RenewAgentLeaseRequestSchema, RoleMessageSchema, authenticateBindingReceipt, canonicalReceiptJson,
  type AgentBindingReceipt, type AgentExecutionHandle, type AgentRegistry, type AgentRequest, type AgentTransport,
  type ArtifactReference, type ArtifactStore, type JsonValue, type OperationResult, type PaneBinding, type RoleMessage
} from "@bflow/contracts";
import { AgenticJournal, digest, json, record, type JournalState, type Outbound } from "./journal.js";
import { parseSubmissionForRequest, parseReconciliationForRequest } from "./delivery-receipts.js";
import { parseNativeExtensionOutput } from "./extension-output.js";
import { NATIVE_EXTENSION_OUTPUT_BYTES } from "./extension-output.js";
import { redactString } from "../resilience/redaction.js";

const RelativeRead = z.string().min(1).max(4096).refine(path => !path.startsWith("/") && !path.includes("\\") &&
  path.split("/").every(part => part !== ".." && part !== "." && part.length > 0), "Read scope must be relative and normalized");
const IntentSchema = z.object({ family: z.enum(["analysis", "qa"]), runId: IdentifierSchema, taskId: IdentifierSchema,
  attemptId: IdentifierSchema, requestKey: IdentifierSchema, message: RoleMessageSchema, allowedReadPaths: z.array(RelativeRead).max(200),
  outputKind: z.string().min(1).max(128) }).strict();
export type NativeExtensionIntent = z.infer<typeof IntentSchema>;
export interface NativeExtensionOutcome {
  handle: AgentExecutionHandle; receipt: AgentBindingReceipt; receiptEvidence: ArtifactReference;
  sender: RoleMessage["sender"]; evidence: ArtifactReference; output: JsonValue;
}
export type NativeExtensionReconciliation = { status: "not_delivered" } | { status: "unknown" } |
  { status: "bound"; handle: AgentExecutionHandle } |
  { status: "completed"; outcome: NativeExtensionOutcome };
export interface NativeExtensionRolePort {
  prepare(intent: NativeExtensionIntent): Promise<AgentRequest>;
  dispatch(request: AgentRequest): Promise<AgentExecutionHandle>;
  receive(message: RoleMessage): Promise<void>;
  waitResult(requestId: string): Promise<NativeExtensionOutcome>;
  reconcile(requestId: string): Promise<NativeExtensionReconciliation>;
}
export interface NativeExtensionDeliveryOptions {
  repositoryPath: string; journalDirectory: string; sessionId: string;
  registry: AgentRegistry; transport: AgentTransport; artifactStore: ArtifactStore;
  panes: {
    getRoleBinding(selector: string): Promise<OperationResult<PaneBinding | null>>;
    inspectRoleHealth(selector: string): Promise<OperationResult<{ readyForPrompt: boolean; occupantMatches: boolean; paneId: string; agentId: string }>>;
  };
  /** Mandatory current SDK run/task/pack/scope validation; the host supplies this, never an agent. */
  authorize(intent: NativeExtensionIntent, binding: PaneBinding): Promise<void>;
  preflight(binding: PaneBinding, intent: NativeExtensionIntent): Promise<void>;
  authenticateMessage(message: RoleMessage): Promise<boolean>;
  bindingReceiptKeys: Readonly<Record<string, string>>;
  clock?: () => Date;
}

function value<T>(result: OperationResult<T>): T { if (!result.ok) throw new Error(result.error.message); return result.value; }
const same = (left: unknown, right: unknown) => canonicalReceiptJson(left) === canonicalReceiptJson(right);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roles: Readonly<Record<string, readonly string[]>> = {
  "analysis.survey": ["architect", "specifier"], "analysis.elicitation": ["specifier"], "analysis.specification": ["specifier"],
  "analysis.review": ["reviewer"], "qa.design": ["qa", "tester"], "qa.design-review": ["qa", "reviewer"], "qa.adjudication": ["qa", "reviewer"]
};
const capabilityForRole: Partial<Record<PaneBinding["role"], string>> = {
  architect: "architecture", specifier: "specification", reviewer: "review", qa: "testing", tester: "testing"
};

/** Message-only WAL in a separate namespace. SDKs retain Core/workflow ownership; no synthetic run or execution is created. */
class NativeExtensionDelivery implements NativeExtensionRolePort {
  private readonly journal: AgenticJournal;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(private readonly options: NativeExtensionDeliveryOptions) {
    this.journal = new AgenticJournal(options.journalDirectory, options.repositoryPath);
  }
  private now() { return (this.options.clock?.() ?? new Date()).toISOString(); }
  private intent(out: Outbound): NativeExtensionIntent { return IntentSchema.parse(record(out.message.payload).intent); }
  private out(state: JournalState, requestId: string): Outbound {
    const out = state.outbound.find(item => item.request?.requestId === requestId);
    if (!out?.request) throw new Error("Unknown native extension request"); return out;
  }
  private async binding(intent: NativeExtensionIntent, ready: boolean): Promise<PaneBinding> {
    const raw = value(await this.options.panes.getRoleBinding(intent.message.recipient.role));
    if (!raw) throw new Error("Native role pane is unavailable");
    const binding = PaneBindingSchema.parse(raw);
    if (binding.sessionId !== this.options.sessionId || binding.role !== intent.message.recipient.role || !binding.session ||
        !binding.readOnlyWorkspace || binding.role === "developer") throw new Error("Native extension requires its read-only session binding");
    if (binding.roleProfile) throw new Error("Native extension profile launch needs explicit profile authority; not yet supported");
    await this.options.authorize(intent, binding);
    if (ready) {
      await this.options.preflight(binding, intent);
      const health = value(await this.options.panes.inspectRoleHealth(binding.bindingId));
      if (!health.readyForPrompt || !health.occupantMatches || health.paneId !== binding.paneId || health.agentId !== binding.agentId)
        throw new Error("Native role is not ready for dispatch");
    }
    return binding;
  }
  private target(binding: PaneBinding): AgentExecutionHandle["target"] {
    return { transport: "herdr", agentId: binding.agentId, workspaceId: binding.workspaceId, tabId: binding.tabId, paneId: binding.paneId,
      ...(binding.terminalId ? { terminalId: binding.terminalId } : {}), session: binding.session,
      ...(binding.worktreePath ? { worktreePath: binding.worktreePath } : {}) };
  }
  private async registration(binding: PaneBinding, capabilities: string[]): Promise<void> {
    const entries = value(await this.options.registry.list(binding.role)).map(item => AgentConfigurationSchema.parse(item));
    const actual = entries.find(item => item.agentId === binding.agentId);
    if (!actual?.enabled || actual.role !== binding.role || actual.transport !== "herdr" ||
        capabilities.some(capability => !actual.capabilities.includes(capability))) throw new Error("Native role registration/capabilities are not current");
  }
  async prepare(input: NativeExtensionIntent): Promise<AgentRequest> {
    const intent = IntentSchema.parse(input), key = `${intent.family}.${intent.taskId}`;
    if (intent.outputKind !== key || !roles[key]?.includes(intent.message.recipient.role) || intent.message.run_id !== intent.runId ||
        intent.message.sender.role !== "coordinator" || intent.message.type !== "delegation.request" || !intent.message.idempotency_key)
      throw new Error("Invalid native extension assignment scope");
    const binding = await this.binding(intent, true);
    return this.journal.exclusive(async (state, save) => {
      const prior = state.outbound.find(item => record(item.message.payload).kind === "extension.assignment" &&
        record(record(item.message.payload).intent).requestKey === intent.requestKey);
      if (prior) {
        if (!same(this.intent(prior), intent)) throw new Error("Conflicting native extension request key");
        if (prior.request) return AgentRequestSchema.parse(prior.request);
        if (prior.status !== "queued" || prior.selector !== binding.bindingId ||
            prior.message.recipient.agent_id !== binding.agentId || prior.message.recipient.pane_id !== binding.paneId)
          throw new Error("Interrupted native preparation no longer matches its bound recipient");
      }
      if (state.outbound.some(item => item !== prior && item.handle?.target.paneId === binding.paneId && ["sending", "unknown_delivery", "accepted"].includes(item.status)))
        throw new Error("Native role already owns an unsettled extension execution");
      const wire = prior?.message ?? RoleMessageSchema.parse({ ...intent.message, recipient: { ...intent.message.recipient,
        agent_id: binding.agentId, pane_id: binding.paneId }, payload: { kind: "extension.assignment", intent: json(intent) } });
      const roleCapability = capabilityForRole[binding.role];
      const out: Outbound = prior ?? { message: wire, selector: binding.bindingId, taskId: intent.taskId, attemptId: intent.attemptId,
        status: "queued", capabilities: ["repository.read", ...(roleCapability ? [roleCapability] : [])] };
      if (!prior) {
        state.outbound.push(out); await save();
        const resolved = value(await this.options.registry.resolve(binding.role, { runId: intent.runId, taskId: intent.taskId,
          preferredAgentId: binding.agentId, requiredCapabilities: out.capabilities }));
        if (!resolved || resolved.agentId !== binding.agentId) throw new Error("No capable native role in the selected pane");
      }
      await this.registration(binding, out.capabilities);
      const requestedAt = out.message.occurred_at ?? this.now();
      // Stable acquisition arguments are retained before the Registry side effect.
      out.message = RoleMessageSchema.parse({ ...out.message, occurred_at: requestedAt }); await save();
      if (!out.lease) {
        out.lease = AgentLeaseSchema.parse(value(await this.options.registry.acquireLease(AcquireAgentLeaseRequestSchema.parse({
          leaseId: `ext-lease-${digest(intent.requestKey)}`, agentId: binding.agentId, runId: intent.runId, taskId: intent.taskId,
          attemptId: intent.attemptId, ttlMs: 300_000, requestedAt, idempotencyKey: `ext-acquire:${intent.requestKey}` }))));
        await save();
      }
      if (out.lease.agentId !== binding.agentId || out.lease.runId !== intent.runId || out.lease.taskId !== intent.taskId ||
          out.lease.attemptId !== intent.attemptId) throw new Error("Native acquisition receipt belongs to another execution");
      out.request = AgentRequestSchema.parse({ requestId: `ext-request-${digest(intent.requestKey)}`, runId: intent.runId,
        taskId: intent.taskId, attemptId: intent.attemptId, role: binding.role, target: this.target(binding), workingDirectory: binding.cwd,
        instruction: canonicalReceiptJson(out.message), context: json(out.message), inputs: out.message.artifact_references, attempt: 1,
        retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
        timeout: { executionTimeoutMs: 300_000, onTimeout: "block" }, idempotency: { key: intent.message.idempotency_key,
          scope: "agent-request", fingerprint: digest(out.message) }, createdAt: requestedAt,
        metadata: { leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken, extensionFamily: intent.family } });
      await save(); return out.request;
    });
  }
  private async renew(out: Outbound, save: () => Promise<void>, persistAfter = true): Promise<void> {
    if (!out.lease || out.leaseRelease) throw new Error("Native execution has no renewable lease");
    const recovered = out.leaseRenewal !== undefined;
    out.leaseRenewal ??= RenewAgentLeaseRequestSchema.parse({ leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken,
      expectedVersion: out.lease.version, ttlMs: 300_000, requestedAt: this.now(),
      idempotencyKey: `ext-renew:${out.message.message_id}:${out.lease.version}` });
    await save();
    out.lease = AgentLeaseSchema.parse(value(await this.options.registry.renewLease(out.leaseRenewal)));
    delete out.leaseRenewal;
    // Before send, the write-ahead renewal remains sufficient recovery state. Avoid an awaited file write after the final fence check.
    if (persistAfter || recovered) await save();
    if (Date.parse(out.lease.expiresAt) <= Date.parse(this.now())) throw new Error("Expired native execution lease");
    if (recovered) await this.renew(out, save, persistAfter);
  }
  async dispatch(input: AgentRequest): Promise<AgentExecutionHandle> {
    const request = AgentRequestSchema.parse(input);
    return this.journal.exclusive(async (state, save) => {
      const out = this.out(state, request.requestId), intent = this.intent(out);
      if (!same(out.request, request)) throw new Error("Prepared native request changed");
      if (out.handle && ["accepted", "released"].includes(out.status)) return AgentExecutionHandleSchema.parse(out.handle);
      if (["sending", "unknown_delivery"].includes(out.status)) throw new Error("Unknown native delivery requires reconciliation, never automatic resend");
      const binding = await this.binding(intent, true);
      if (!same(request.target, this.target(binding))) throw new Error("Native binding changed since preparation");
      await this.registration(binding, out.capabilities);
      await this.renew(out, save);
      if (out.lease!.agentId !== binding.agentId || request.metadata?.leaseId !== out.lease!.leaseId ||
          request.metadata?.fencingToken !== out.lease!.fencingToken) throw new Error("Native request lease/fence changed");
      out.status = "sending"; await save();
      try {
        await this.options.authorize(intent, binding);
        await this.registration(binding, out.capabilities);
        await this.renew(out, save, false);
      } catch (error) {
        // No transport invocation has happened on this branch. Do not manufacture an unknown remote execution.
        out.status = "queued"; out.error = redactString(String(error)); await save(); throw error;
      }
      try {
        const receipt = parseSubmissionForRequest(request, value(await this.options.transport.send(request, { timeoutMs: 30_000 })));
        if (receipt.status === "accepted") {
          out.handle = receipt.handle; out.status = "accepted"; delete out.error; await save(); return receipt.handle;
        }
        out.status = receipt.status === "rejected" ? "queued" : "unknown_delivery"; out.error = receipt.reason; await save();
      } catch (error) { out.status = "unknown_delivery"; out.error = redactString(String(error)); await save(); }
      throw new Error("Native delivery is unknown or rejected; reconcile its persisted request before retry");
    });
  }
  private projection(state: JournalState, requestId: string, kind: string): RoleMessage | undefined {
    return state.inbox.find(item => item.status === "applied" && item.message.sender.role === "runtime" &&
      record(item.message.payload).kind === kind && record(item.message.payload).requestId === requestId)?.message;
  }
  private async put(out: Outbound, id: string, data: unknown): Promise<ArtifactReference> {
    const bytes = Buffer.from(canonicalReceiptJson(data)), checksum = sha(bytes);
    const ref = ArtifactReferenceSchema.parse(value(await this.options.artifactStore.put({ options: ArtifactWriteOptionsSchema.parse({
      artifactId: `native-${id}-${checksum}`, runId: out.request!.runId, taskId: out.taskId, kind: "report", mediaType: "application/json",
      expectedIntegrity: { checksum: { algorithm: "sha256", value: checksum }, sizeBytes: bytes.length }, idempotencyKey: `native:${id}:${checksum}` }),
      content: (async function* () { yield bytes; })() })));
    if (ref.checksum.value !== checksum || ref.sizeBytes !== bytes.length || ref.runId !== out.request!.runId || ref.taskId !== out.taskId)
      throw new Error("ArtifactStore returned an unrelated native evidence reference");
    return ref;
  }
  private recordProjection(state: JournalState, out: Outbound, source: RoleMessage, kind: string, data: unknown, refs: ArtifactReference[]): void {
    const id = `native-record-${digest([source.message_id, kind])}`;
    state.inbox.push({ status: "applied", message: RoleMessageSchema.parse({ schema_version: 2, message_id: id,
      correlation_id: out.message.correlation_id, causation_id: source.message_id, run_id: out.request!.runId,
      sender: { role: "runtime" }, recipient: { role: "coordinator" }, type: "task.status",
      payload: { kind, requestId: out.request!.requestId, data: json(data) }, artifact_references: refs,
      occurred_at: this.now(), idempotency_key: id }) });
  }
  private async release(out: Outbound, save: () => Promise<void>) {
    if (out.status === "released") return;
    if (!out.lease) throw new Error("Native output lost its lease record");
    if (out.leaseRenewal) await this.renew(out, save);
    out.leaseRelease ??= ReleaseAgentLeaseRequestSchema.parse({ leaseId: out.lease.leaseId, fencingToken: out.lease.fencingToken,
      expectedVersion: out.lease.version, releasedAt: this.now(), idempotencyKey: `ext-release:${out.request!.requestId}` });
    await save(); value(await this.options.registry.releaseLease(out.leaseRelease)); delete out.leaseRelease;
    out.status = "released"; await save();
  }
  private async stored(refInput: ArtifactReference, expected: unknown): Promise<void> {
    const ref = ArtifactReferenceSchema.parse(refInput), size = ref.sizeBytes;
    if (size === undefined || size > NATIVE_EXTENSION_OUTPUT_BYTES || ref.checksum.algorithm !== "sha256") throw new Error("Native evidence size/integrity bound is invalid");
    const chunks: Buffer[] = []; let total = 0;
    for await (const part of this.options.artifactStore.get(ref)) {
      if (!part.ok) throw new Error("Native evidence integrity/read failed");
      const bytes = Buffer.from(part.value); total += bytes.length;
      if (total > size) throw new Error("Native evidence exceeds its stored size");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (total !== size || sha(bytes) !== ref.checksum.value || !same(JSON.parse(bytes.toString("utf8")), expected))
      throw new Error("Native evidence no longer matches the recorded output");
  }
  async receive(input: RoleMessage): Promise<void> {
    const message = RoleMessageSchema.parse(input);
    if (!await this.options.authenticateMessage(message)) throw new Error("Unauthenticated native extension message");
    const requestId = await this.journal.exclusive(async (state, save) => {
      const prior = state.inbox.find(item => item.message.message_id === message.message_id || item.message.idempotency_key === message.idempotency_key);
      if (prior) {
        if (!same(prior.message, message)) throw new Error("Conflicting native result idempotency key");
        if (prior.status === "applied") return undefined;
      }
      const out = state.outbound.find(item => item.message.message_id === message.causation_id);
      if (!out?.request || !out.handle || out.status !== "accepted") throw new Error("Native binding is not settled for this result");
      const intent = this.intent(out), binding = await this.binding(intent, false);
      if (message.correlation_id !== out.message.correlation_id || message.run_id !== out.request.runId ||
          message.sender.role !== binding.role || message.sender.agent_id !== out.handle.target.agentId ||
          message.sender.pane_id !== out.handle.target.paneId || !same(this.target(binding), out.handle.target) ||
          message.artifact_references.length || !message.idempotency_key) throw new Error("Native sender/binding/result scope mismatch");
      const inbox = prior ?? { message, status: "received" as const };
      if (!prior) { state.inbox.push(inbox); await save(); }
      if (message.type === "execution.receipt") {
        const receipt = AgentBindingReceiptSchema.parse(message.payload), key = this.options.bindingReceiptKeys[receipt.issuerId];
        if (!key || !authenticateBindingReceipt(receipt, key) || !same(receipt.handle, out.handle) ||
            receipt.correlation.token !== out.message.message_id) throw new Error("Native binding signature/ownership is invalid");
        if (this.projection(state, out.request.requestId, "extension.binding.recorded")) throw new Error("Native binding already has another receipt");
        const ref = await this.put(out, "binding", receipt);
        this.recordProjection(state, out, message, "extension.binding.recorded", receipt, [ref]);
      } else if (message.type === "spec.draft") {
        const body = record(message.payload);
        if (body.kind !== "extension.result" || body.requestId !== out.request.requestId) throw new Error("Native output belongs to another request");
        if (!this.projection(state, out.request.requestId, "extension.binding.recorded")) throw new Error("Native output requires an authenticated binding receipt");
        const output = parseNativeExtensionOutput(intent, body.output);
        const ref = await this.put(out, "output", output);
        this.recordProjection(state, out, message, "extension.output.recorded", { output, sender: message.sender }, [ref]);
      } else throw new Error("Unexpected native extension result type");
      const applied = state.inbox.find(item => item.message.message_id === message.message_id)!;
      applied.status = "applied"; await save();
      if (message.type === "spec.draft") await this.release(out, save);
      return out.request.requestId;
    });
    if (requestId) for (const listener of this.listeners.get(requestId) ?? []) listener();
  }
  private async outcome(requestId: string): Promise<NativeExtensionOutcome | undefined> {
    return this.journal.exclusive(async (state, save) => {
      const out = this.out(state, requestId), bound = this.projection(state, requestId, "extension.binding.recorded"),
        result = this.projection(state, requestId, "extension.output.recorded");
      if (!bound || !result || !out.handle) return undefined;
      const receipt = AgentBindingReceiptSchema.parse(record(bound.payload).data), key = this.options.bindingReceiptKeys[receipt.issuerId];
      if (!key || !authenticateBindingReceipt(receipt, key) || !same(receipt.handle, out.handle)) throw new Error("Stored native binding is not authentic");
      const data = record(record(result.payload).data);
      const output = parseNativeExtensionOutput(this.intent(out), data.output);
      const source = state.inbox.find(item => item.status === "applied" && item.message.message_id === result.causation_id)?.message;
      if (!source || !same(source.sender, data.sender)) throw new Error("Native output projection lost its actual sender");
      const sourceBody = record(source.payload);
      if (sourceBody.kind !== "extension.result" || sourceBody.requestId !== requestId ||
          !same(parseNativeExtensionOutput(this.intent(out), sourceBody.output), output)) throw new Error("Native output projection differs from its actual message");
      const receiptEvidence = ArtifactReferenceSchema.parse(bound.artifact_references[0]), evidence = ArtifactReferenceSchema.parse(result.artifact_references[0]);
      if (receiptEvidence.runId !== out.request!.runId || evidence.runId !== out.request!.runId ||
          receiptEvidence.taskId !== out.taskId || evidence.taskId !== out.taskId) throw new Error("Native evidence belongs to another task");
      await this.stored(receiptEvidence, receipt); await this.stored(evidence, output);
      await this.release(out, save);
      return { handle: AgentExecutionHandleSchema.parse(out.handle), receipt, receiptEvidence, evidence, output, sender: RoleMessageSchema.parse(source).sender };
    });
  }
  async waitResult(requestId: string): Promise<NativeExtensionOutcome> {
    const present = await this.outcome(requestId); if (present) return present;
    return new Promise((resolve, reject) => {
      let stopped = false;
      const finish = (error?: unknown, result?: NativeExtensionOutcome) => {
        if (stopped) return; stopped = true; clearInterval(timer); this.listeners.get(requestId)?.delete(check);
        if (error) reject(error); else resolve(result!);
      };
      const check = () => { void this.outcome(requestId).then(result => { if (result) finish(undefined, result); }, finish); };
      const timer = setInterval(() => {
        void this.journal.exclusive(async (state, save) => {
          const out = this.out(state, requestId);
          if (Date.parse(this.now()) >= Date.parse(out.request!.createdAt) + out.request!.timeout.executionTimeoutMs)
            throw new Error("Native role output is still unresolved; reconcile before continuation");
          if (out.status === "accepted") await this.renew(out, save);
        }).catch(finish);
      }, 30_000);
      const listeners = this.listeners.get(requestId) ?? new Set<() => void>(); listeners.add(check); this.listeners.set(requestId, listeners);
      check(); // Close the race between the first read and listener registration; no artifact/file communication polling.
    });
  }
  async reconcile(requestId: string): Promise<NativeExtensionReconciliation> {
    const result = await this.outcome(requestId); if (result) return { status: "completed", outcome: result };
    return this.journal.exclusive(async (state, save) => {
      const out = this.out(state, requestId), request = out.request!;
      if (out.handle && out.status === "accepted") return { status: "bound", handle: AgentExecutionHandleSchema.parse(out.handle) };
      if (!["sending", "unknown_delivery"].includes(out.status)) throw new Error("No uncertain native delivery to reconcile");
      const resolved = parseReconciliationForRequest(request, value(await this.options.transport.reconcile({ requestId: request.requestId,
        attemptId: request.attemptId, runId: request.runId, taskId: request.taskId, idempotencyKey: request.idempotency.key,
        target: request.target, requestedAt: this.now() })));
      if (resolved.status === "not_delivered") { out.status = "queued"; await save(); return { status: "not_delivered" }; }
      if (resolved.status === "bound") { out.handle = resolved.handle; out.status = "accepted"; await save(); return { status: "bound", handle: resolved.handle }; }
      else { out.status = "unknown_delivery"; await save(); }
      return { status: "unknown" };
    });
  }
}

/** Produces an abstract port; the host retains concrete adapter and business-policy ownership. */
export function createNativeExtensionRolePort(options: NativeExtensionDeliveryOptions): NativeExtensionRolePort {
  return new NativeExtensionDelivery(options);
}
