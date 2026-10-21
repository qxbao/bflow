import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { join, resolve } from "node:path";
import {
  AgentBindingReceiptSchema, ApprovalDecisionSchema, JsonValueSchema, PaneBindingSchema, QualityGateContextSchema,
  QualityGateResultSchema, RoleMessageSchema, VerificationResultSchema,
  type ApprovalDecision, type JsonValue, type PaneBinding, type QualityGateResult, type RoleMessage, type VerificationResult
} from "@bflow/contracts";
import { digest, json, record, strings, textField } from "./journal.js";
import { redactString } from "../resilience/redaction.js";
import { withRecoveredHerdrReceipt } from "./herdr-ingress.js";
import { ApprovalNoticeSchema, UserDecisionNoticeSchema, approvalNoticeFields, isUserFacingNotice, renderConversationNotice, userDecisionNoticeFields } from "./conversation-notice-render.js";

type Kind = "approval-failure" | "runtime-nudge" | "conversation-turn" | "conversation-intent" | "conversation-result" | "conversation-notice" | "notice-surfaced" | "notice-displayed" | "notice-reblock" | "notice-resurfaced" | "notification-failure" | "notice-nudge" | "decision-reblock" | "human" | "gate" | "evidence" | "review" | "alternative" | "native-intent" | "native-ack" | "coordinator-boundary" | "coordinator-start" | "coordinator-stop" | "coordinator-stop-handled" | "specialist-stop" | "specialist-settled";
export interface HumanHookProvenance {
  origin: "UserPromptSubmit"; binding: PaneBinding; nativeSessionId: string;
  conversationSessionId: string; userId: string; messageId: string; promptDigest: string;
}
export const TrustedConversationTurnSchema = z.object({
  binding: PaneBindingSchema, messageId: z.string().min(1), conversationSessionId: z.string().min(1),
  content: z.string().min(1), occurredAt: z.string().datetime(), userId: z.string().min(1), sequence: z.number().int().positive()
}).strict();
export type TrustedConversationTurn = z.infer<typeof TrustedConversationTurnSchema>;
/** Durable, sanitised inbox entry for a RoleMessage applied by Conversation; a notice is delivery evidence, never task success. */
const NOTICE_SUMMARY_LIMIT = 4096;
export const ConversationNoticeSchema = z.object({ messageId: z.string().min(1), type: z.string().min(1), senderRole: z.string().min(1),
  runId: z.string().min(1).optional(), correlationId: z.string().min(1), receivedAt: z.string().datetime(),
  summary: z.string(), truncated: z.boolean(),
  /** Bounded decision fields for user decisions, independent of the summary cap. Absent on receipts written before this field. */
  userDecision: UserDecisionNoticeSchema.optional(),
  /** Bounded structured fields of a non-decision approval (design, task, gate). Absent on receipts written before this field. */
  approval: ApprovalNoticeSchema.optional() }).strict();
export type ConversationNotice = z.infer<typeof ConversationNoticeSchema>;
/** Display state of a user-decision notice, for the Runtime watchdog. `since` is when the current wait began. */
export interface ConversationNoticeState { messageId: string; approvalId?: string; runId?: string; surfaced: boolean; displayed: boolean; resends: number; since: string }
const NoticeSurfacedSchema = z.object({ messageId: z.string().min(1), surfacedAt: z.string().datetime().optional() }).strict();
const NoticeDisplayedSchema = z.object({ messageId: z.string().min(1), displayedAt: z.string().datetime() }).strict();
const NoticeReblockSchema = z.object({ messageId: z.string().min(1), attempt: z.number().int().min(1) }).strict();
const NoticeResurfacedSchema = z.object({ messageId: z.string().min(1), attempt: z.number().int().min(1), resurfacedAt: z.string().datetime() }).strict();
const NotificationFailureSchema = z.object({ messageIds: z.array(z.string().min(1)).min(1).max(100), reason: z.string().min(1).max(2000), failedAt: z.string().datetime() }).strict();
/** A user-facing notice is re-blocked on Stop at most this many times before it is left for the reminder watchdog. */
export const MAX_NOTICE_REBLOCKS = 2;
/** A Conversation Stop is refused at most this many times for one user turn that never reached conversation_decide. */
export const MAX_DECISION_REBLOCKS = 2;
const ApprovalFailureReceiptSchema = z.object({ messageId: z.string().min(1), attempt: z.number().int().positive(),
  error: z.string().min(1).max(2000), note: z.string().min(1).max(2000) }).strict();
const ConversationDecisionReceiptSchema = z.object({ messageId: z.string().min(1), decision: JsonValueSchema,
  result: JsonValueSchema.optional() }).strict();
export interface HostObservation {
  binding: PaneBinding; observation: JsonValue; context?: unknown; runId?: string; taskId?: string;
}
export interface CoordinatorTurnObservation { binding: PaneBinding; message: RoleMessage; sequence: number; nativeResponseBaseline?: string[] }
interface Envelope { version: 1; repository: string; sessionId: string; kind: Kind; id: string; payload: JsonValue; checksum: string }

/** A message that starts a Coordinator model turn the host must watch for a response: a user delegation or a Runtime wake-up. */
export function isCoordinatorTrigger(message: RoleMessage): boolean {
  if (message.sender.role === "conversation") return message.type === "delegation.request";
  if (message.sender.role !== "runtime" || message.type !== "task.status" || typeof message.payload !== "object" || message.payload === null || Array.isArray(message.payload)) return false;
  return WAKE_KINDS.includes(String((message.payload as Record<string, unknown>).kind));
}
/** Runtime wake-ups that the Coordinator must answer through Runtime tools; each one's turn is tracked for a no-response Stop. */
const WAKE_KINDS = ["specialist_result_ready", "specialist_no_response", "delivery_failure", "resume_run", "verification_stuck", "changes_requested"];

/**
 * A durable Conversation notice for a delivery or inbound failure that Runtime could not record itself. It is idempotent by the
 * original message id, so a repeated report never creates a second notice. The reason is redacted before it is stored.
 */
export function deliveryFailureNotice(message: RoleMessage, reason: string, headline: string): RoleMessage {
  const id = `delivery-failure-${digest(message.message_id)}`, text = redactString(reason);
  const payload = { kind: "delivery_failure", headline, reason: text, blockageReason: `${message.type} from ${message.sender.role} (${message.message_id}): ${text}. The run is waiting and will not continue until this is resolved.`,
    summary: `${message.type} from ${message.sender.role} to ${message.recipient.role} (${message.message_id})`,
    options: ["Kiểm tra trạng thái run và yêu cầu Coordinator gửi lại việc", "Hủy run"] };
  return RoleMessageSchema.parse({ schema_version: 2, message_id: id, correlation_id: message.correlation_id, causation_id: message.message_id,
    ...(message.run_id === undefined ? {} : { run_id: message.run_id }), sender: { role: "runtime" }, recipient: { role: "conversation" },
    // A run-less message cannot carry a run-bound progress type; a clarification is exempt from run_id and renders the same blocked notice.
    type: message.run_id === undefined ? "conversation.clarification" : "conversation.progress", payload, artifact_references: [],
    occurred_at: new Date().toISOString(), idempotency_key: id });
}

/** Private host authority, separate from model-accessible artifacts and Conversation context.
 * Immutable records are linked only after file fsync; the directory is fsynced before ACK.
 * This trusts private local filesystem ownership, not hostile same-user mutation.
 */
export class HostReceiptJournal {
  readonly directory: string;
  readonly repository: string;
  constructor(directory: string, repository: string, readonly sessionId: string) {
    this.directory = resolve(directory); this.repository = resolve(repository); textField(sessionId);
  }
  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new Error("Unsafe host receipt directory");
  }
  private filename(kind: Kind, id: string): string { return `${kind}-${digest(textField(id))}.json`; }
  private parsePayload(kind: Kind, input: unknown): JsonValue {
    if (kind === "conversation-turn") {
      const turn = TrustedConversationTurnSchema.parse(input);
      if (turn.binding.role !== "conversation" || turn.binding.sessionId !== this.sessionId || !turn.binding.session)
        throw new Error("Conversation turn has mismatched trusted hook provenance");
      return json(turn);
    }
    if (kind === "approval-failure") return json(ApprovalFailureReceiptSchema.parse(input));
    if (kind === "runtime-nudge") {
      return json(z.object({ bindingDigest: z.string().regex(/^[0-9a-f]{64}$/), sequence: z.number().int().nonnegative() }).strict().parse(input));
    }
    if (kind === "conversation-intent" || kind === "conversation-result") {
      const receipt = ConversationDecisionReceiptSchema.parse(input);
      if ((kind === "conversation-result") !== (receipt.result !== undefined)) throw new Error("Invalid Conversation decision receipt");
      return json(receipt);
    }
    if (kind === "coordinator-boundary") {
      const raw = record(input), binding = PaneBindingSchema.parse(raw.binding);
      if (binding.sessionId !== this.sessionId || binding.role !== "coordinator" || !binding.session || !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 1)
        throw new Error("Invalid Coordinator turn boundary");
      return json({ binding, sequence: raw.sequence });
    }
    if (kind === "specialist-stop") {
      const raw = record(input), binding = PaneBindingSchema.parse(raw.binding);
      if (binding.sessionId !== this.sessionId || binding.role === "coordinator" || binding.role === "conversation" || !binding.session || typeof raw.observedAt !== "string")
        throw new Error("Invalid specialist turn stop");
      return json({ binding, observedAt: raw.observedAt });
    }
    if (kind === "specialist-settled") {
      const raw = record(input);
      if (typeof raw.stopId !== "string" || !raw.stopId) throw new Error("Invalid specialist stop acknowledgement");
      return json({ stopId: raw.stopId });
    }
    if (kind.startsWith("coordinator-")) {
      const raw = record(input), binding = PaneBindingSchema.parse(raw.binding), message = RoleMessageSchema.parse(raw.message);
      if (binding.sessionId !== this.sessionId || binding.role !== "coordinator" || !binding.session ||
          message.recipient.role !== "coordinator" || !isCoordinatorTrigger(message) ||
          !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 1) throw new Error("Invalid Coordinator turn observation");
      const baseline = raw.nativeResponseBaseline;
      if (baseline !== undefined && (!Array.isArray(baseline) || baseline.some(id => typeof id !== "string" || !id))) throw new Error("Invalid native response baseline");
      return json({ binding, message, sequence: raw.sequence, ...(baseline === undefined ? {} : { nativeResponseBaseline: baseline }) });
    }
    if (kind === "conversation-notice") return json(ConversationNoticeSchema.parse(input));
    if (kind === "notice-surfaced") return json(NoticeSurfacedSchema.parse(input));
    if (kind === "notice-displayed") return json(NoticeDisplayedSchema.parse(input));
    if (kind === "notice-reblock") return json(NoticeReblockSchema.parse(input));
    if (kind === "notice-resurfaced") return json(NoticeResurfacedSchema.parse(input));
    if (kind === "notification-failure") return json(NotificationFailureSchema.parse(input));
    if (kind === "decision-reblock") return json(z.object({ messageId: z.string().min(1), attempt: z.number().int().min(1).max(MAX_DECISION_REBLOCKS), reblockedAt: z.string().datetime() }).strict().parse(input));
    if (kind === "notice-nudge") return json(z.object({ messageId: z.string().min(1), attempt: z.number().int().min(1).max(3), attemptedAt: z.string().datetime() }).strict().parse(input));
    if (kind === "native-intent" || kind === "native-ack") return json(RoleMessageSchema.parse(input));
    if (kind === "gate") return json(QualityGateResultSchema.parse(input));
    if (kind === "evidence") return json(VerificationResultSchema.parse(input));
    if (kind === "human") {
      const value = record(input), decision = ApprovalDecisionSchema.parse(value.decision), raw = record(value.provenance);
      const binding = PaneBindingSchema.parse(raw.binding);
      const provenance: HumanHookProvenance = { origin: "UserPromptSubmit", binding,
        nativeSessionId: textField(raw.nativeSessionId), conversationSessionId: textField(raw.conversationSessionId),
        userId: textField(raw.userId), messageId: textField(raw.messageId), promptDigest: textField(raw.promptDigest) };
      if (raw.origin !== "UserPromptSubmit" || binding.role !== "conversation" || binding.sessionId !== this.sessionId ||
          !binding.session || binding.session.value !== provenance.nativeSessionId || decision.sessionId !== provenance.conversationSessionId ||
          decision.decidedBy !== provenance.userId || !/^[a-f0-9]{64}$/.test(provenance.promptDigest))
        throw new Error("Human receipt has mismatched trusted hook provenance");
      return json({ decision, provenance });
    }
    const value = record(input), binding = PaneBindingSchema.parse(value.binding);
    if (binding.sessionId !== this.sessionId) throw new Error("Foreign observation binding");
    const observation = JsonValueSchema.parse(value.observation);
    if (kind === "review") return json({ binding, observation, context: QualityGateContextSchema.parse(value.context) });
    return json({ binding, observation, runId: textField(value.runId), taskId: textField(value.taskId) });
  }
  private validate(raw: unknown, kind: Kind, id: string): Envelope {
    const value = record(raw);
    if (value.version !== 1 || value.repository !== this.repository || value.sessionId !== this.sessionId || value.kind !== kind || value.id !== id)
      throw new Error("Unsupported or foreign host receipt");
    const payload = this.parsePayload(kind, value.payload);
    const envelope = { version: 1 as const, repository: this.repository, sessionId: this.sessionId, kind, id, payload };
    if (value.checksum !== digest(envelope)) throw new Error("Host receipt integrity mismatch");
    if (kind === "approval-failure" && digest([record(payload).messageId, record(payload).attempt]) !== id ||
        kind === "runtime-nudge" && digest([record(payload).bindingDigest, record(payload).sequence]) !== id ||
        kind.startsWith("conversation-") && record(payload).messageId !== id ||
        kind === "human" && ApprovalDecisionSchema.parse(record(payload).decision).approvalId !== id ||
        kind === "gate" && QualityGateResultSchema.parse(payload).evaluationId !== id ||
        kind === "evidence" && VerificationResultSchema.parse(payload).verificationId !== id ||
        (kind === "notice-surfaced" || kind === "notice-displayed" || kind === "notice-resurfaced") && record(payload).messageId !== id.split("#")[0] ||
        kind === "native-ack" && RoleMessageSchema.parse(payload).message_id !== id)
      throw new Error("Host receipt identity mismatch");
    return { ...envelope, checksum: textField(value.checksum) };
  }
  private async read(kind: Kind, id: string): Promise<JsonValue | undefined> {
    await this.prepare();
    let file;
    try { file = await open(join(this.directory, this.filename(kind, id)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size > 16 * 1024 * 1024)
        throw new Error("Unsafe host receipt file");
      return this.validate(JSON.parse(await file.readFile("utf8")), kind, id).payload;
    } finally { await file.close(); }
  }
  private async write(kind: Kind, id: string, input: unknown): Promise<boolean> {
    const payload = this.parsePayload(kind, input);
    const value = { version: 1 as const, repository: this.repository, sessionId: this.sessionId, kind, id, payload };
    const envelope = this.validate({ ...value, checksum: digest(value) }, kind, id);
    await this.prepare();
    const path = join(this.directory, `pending-${randomUUID()}.tmp`), file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(envelope)); await file.sync(); } finally { await file.close(); }
    let created = true;
    try {
      try { await link(path, join(this.directory, this.filename(kind, id))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        created = false;
        if (digest(await this.read(kind, id)) !== digest(payload)) throw new Error("Conflicting immutable host receipt");
      }
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return created;
    } finally { await rm(path, { force: true }); }
  }
  private turnId(binding: PaneBinding, message: RoleMessage): string {
    return digest([binding.paneId, binding.session, message.message_id]);
  }
  private bindingIdentity(binding: PaneBinding): string { return digest({ ...binding, transportState: undefined }); }
  private async receiptIds(kind: Kind): Promise<string[]> {
    await this.prepare(); const ids: string[] = [];
    // Kinds can share a prefix, e.g. coordinator-stop and coordinator-stop-handled.
    const pattern = new RegExp(`^${kind}-[a-f0-9]{64}\\.json$`);
    for (const name of await readdir(this.directory)) {
      if (!pattern.test(name)) continue;
      const file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let id: string;
      try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Unsafe host receipt file");
        id = textField(record(JSON.parse(await file.readFile("utf8"))).id); } finally { await file.close(); }
      if (name !== this.filename(kind, id)) throw new Error("Host receipt filename identity mismatch");
      await this.read(kind, id); ids.push(id);
    }
    return ids;
  }
  private async coordinatorStarts(): Promise<CoordinatorTurnObservation[]> {
    const values: CoordinatorTurnObservation[] = [];
    for (const id of await this.receiptIds("coordinator-start")) {
      const raw = record(await this.read("coordinator-start", id));
      const value: CoordinatorTurnObservation = { binding: PaneBindingSchema.parse(raw.binding), message: RoleMessageSchema.parse(raw.message), sequence: Number(raw.sequence),
        ...(raw.nativeResponseBaseline === undefined ? {} : { nativeResponseBaseline: strings(raw.nativeResponseBaseline) }) };
      if (this.turnId(value.binding, value.message) !== id) throw new Error("Coordinator turn receipt identity mismatch");
      values.push(value);
    }
    return values;
  }
  private async coordinatorBoundaries(): Promise<{ binding: PaneBinding; sequence: number }[]> {
    const values: { binding: PaneBinding; sequence: number }[] = [];
    for (const id of await this.receiptIds("coordinator-boundary")) {
      const raw = record(await this.read("coordinator-boundary", id));
      values.push({ binding: PaneBindingSchema.parse(raw.binding), sequence: Number(raw.sequence) });
    }
    return values;
  }
  async recordCoordinatorBoundary(binding: PaneBinding): Promise<void> {
    const sequences = [...await this.coordinatorStarts(), ...await this.coordinatorBoundaries()].map(item => item.sequence);
    await this.write("coordinator-boundary", randomUUID(), { binding, sequence: Math.max(0, ...sequences) + 1 });
  }
  async startCoordinatorTurn(binding: PaneBinding, message: RoleMessage): Promise<void> {
    const id = this.turnId(binding, message), previous = await this.read("coordinator-start", id);
    if (previous) {
      const raw = record(previous);
      if (this.bindingIdentity(PaneBindingSchema.parse(raw.binding)) !== this.bindingIdentity(binding) || digest(raw.message) !== digest(message)) throw new Error("Conflicting Coordinator turn");
      return;
    }
    const starts = await this.coordinatorStarts();
    const nativeResponseBaseline: string[] = [];
    for (const id of await this.receiptIds("native-intent")) nativeResponseBaseline.push(RoleMessageSchema.parse(await this.read("native-intent", id)).message_id);
    await this.write("coordinator-start", id, { binding, message, sequence: Math.max(0, ...[...starts, ...await this.coordinatorBoundaries()].map(item => item.sequence)) + 1, nativeResponseBaseline });
  }
  async stopCoordinatorTurn(binding: PaneBinding): Promise<boolean> {
    const starts = (await this.coordinatorStarts()).filter(item => this.bindingIdentity(item.binding) === this.bindingIdentity(binding)).sort((a, b) => b.sequence - a.sequence);
    const current = starts[0]; if (!current) return false;
    if ((await this.coordinatorBoundaries()).some(item => this.bindingIdentity(item.binding) === this.bindingIdentity(binding) && item.sequence >= current.sequence)) return false;
    if (starts[1]?.sequence === current.sequence) throw new Error("Ambiguous Coordinator turn identity");
    await this.write("coordinator-stop", this.turnId(binding, current.message), current); return true;
  }
  async pendingCoordinatorStops(): Promise<CoordinatorTurnObservation[]> {
    const pending: CoordinatorTurnObservation[] = [];
    for (const item of await this.coordinatorStarts()) {
      const id = this.turnId(item.binding, item.message);
      if (await this.read("coordinator-stop", id) !== undefined && await this.read("coordinator-stop-handled", id) === undefined) pending.push(item);
    }
    return pending;
  }
  async hasCoordinatorResponse(item: CoordinatorTurnObservation): Promise<boolean> {
    for (const id of await this.receiptIds("native-intent")) {
      const message = RoleMessageSchema.parse(await this.read("native-intent", id));
      if (!(item.nativeResponseBaseline ?? []).includes(message.message_id) && message.run_id === item.message.run_id &&
          message.correlation_id === item.message.correlation_id && message.sender.role === "coordinator" &&
          message.type !== "delegation.accepted" &&
          !(message.type === "conversation.progress" && typeof message.payload === "object" && message.payload !== null && !Array.isArray(message.payload) && message.payload.kind === "coordinator_no_response")) return true;
    }
    return false;
  }
  async completeCoordinatorStop(item: CoordinatorTurnObservation): Promise<void> {
    const id = this.turnId(item.binding, item.message);
    if (digest(await this.read("coordinator-stop", id)) !== digest(item)) throw new Error("Missing exact Coordinator stop observation");
    await this.write("coordinator-stop-handled", id, item);
  }
  /** Durable record of every non-Conversation provider turn that stopped; Runtime decides whether it left work unanswered. */
  async recordSpecialistStop(binding: PaneBinding): Promise<string> {
    const id = randomUUID();
    await this.write("specialist-stop", id, { binding, observedAt: new Date().toISOString() });
    return id;
  }
  async pendingSpecialistStops(): Promise<{ stopId: string; binding: PaneBinding; observedAt: string }[]> {
    const pending: { stopId: string; binding: PaneBinding; observedAt: string }[] = [];
    for (const id of await this.receiptIds("specialist-stop")) {
      if (await this.read("specialist-settled", id) !== undefined) continue;
      const raw = record(await this.read("specialist-stop", id));
      pending.push({ stopId: id, binding: PaneBindingSchema.parse(raw.binding), observedAt: textField(raw.observedAt) });
    }
    return pending;
  }
  async completeSpecialistStop(stopId: string): Promise<void> {
    await this.write("specialist-settled", stopId, { stopId });
  }
  /** Native deliveries whose acknowledgement was not observed. Each one is never resent; it needs reconciliation. */
  async unacknowledgedNativeDeliveries(): Promise<{ operationId: string; message: RoleMessage }[]> {
    const uncertain: { operationId: string; message: RoleMessage }[] = [];
    for (const operationId of await this.receiptIds("native-intent")) {
      const delivery = await this.nativeDelivery(operationId);
      if (delivery?.status === "unknown_delivery") uncertain.push({ operationId, message: delivery.message });
    }
    return uncertain;
  }
  /** Replay private transport facts before Runtime startup recovery; never resend any envelope or apply business outcomes. */
  async recoverNativeDeliveries(runtime: {
    recordNativeDeliveryIntent(message: RoleMessage, operationId: string): Promise<void>;
    reconcileNativeDelivery(messageId: string): Promise<boolean>;
  }): Promise<void> {
    for (const operationId of await this.receiptIds("native-intent")) {
      const delivery = await this.nativeDelivery(operationId);
      if (!delivery) continue;
      if (delivery.status === "unknown_delivery") await runtime.recordNativeDeliveryIntent(delivery.message, operationId);
      // Re-read after the Runtime write: a signed ACK may have arrived concurrently. nativeDelivery checks exact
      // immutable intent/ACK ownership, permitting only the native host's binding-receipt signature replacement.
      if ((await this.nativeDelivery(operationId))?.status === "acknowledged")
        await runtime.reconcileNativeDelivery(delivery.message.message_id);
    }
  }
  /** Authenticated direct Coordinator-to-Conversation workflow outcomes, including those from before Runtime journaling was added. */
  async acknowledgedCoordinatorConversationOutcomes(): Promise<RoleMessage[]> {
    const values: RoleMessage[] = [];
    for (const id of await this.receiptIds("native-ack")) {
      const message = RoleMessageSchema.parse(await this.read("native-ack", id));
      if (message.sender.role === "coordinator" && message.recipient.role === "conversation" && message.run_id &&
          ["task.status", "conversation.progress"].includes(message.type)) values.push(message);
    }
    return values.sort((a, b) => (a.occurred_at ?? "").localeCompare(b.occurred_at ?? "") || a.message_id.localeCompare(b.message_id));
  }
  /** Only owned, checksum-validated native ACK receipts may restore their original authentication scope. */
  async replayAcknowledgedCoordinatorOutcomes(apply: (message: RoleMessage) => Promise<void>): Promise<void> {
    for (const message of await this.acknowledgedCoordinatorConversationOutcomes())
      await withRecoveredHerdrReceipt(message, () => apply(message));
  }
  /** Every durable Coordinator stop, including already handled receipts, for semantic next-action reconciliation after restart. */
  async coordinatorStopObservations(): Promise<CoordinatorTurnObservation[]> {
    const values: CoordinatorTurnObservation[] = [];
    for (const id of await this.receiptIds("coordinator-stop")) {
      const raw = record(await this.read("coordinator-stop", id));
      const item: CoordinatorTurnObservation = { binding: PaneBindingSchema.parse(raw.binding), message: RoleMessageSchema.parse(raw.message),
        sequence: Number(raw.sequence), ...(Array.isArray(raw.nativeResponseBaseline) ? { nativeResponseBaseline: strings(raw.nativeResponseBaseline) } : {}) };
      if (!Number.isSafeInteger(item.sequence) || item.sequence < 1) throw new Error("Invalid Coordinator stop observation sequence");
      if (item.binding.sessionId === this.sessionId) values.push(item);
    }
    return values.sort((a, b) => a.sequence - b.sequence);
  }
  async recordHuman(decision: ApprovalDecision, provenance: HumanHookProvenance): Promise<void> {
    const parsed = ApprovalDecisionSchema.parse(decision); await this.write("human", parsed.approvalId, { decision: parsed, provenance });
  }
  async authenticateHuman(input: ApprovalDecision): Promise<boolean> {
    const decision = ApprovalDecisionSchema.parse(input), receipt = await this.read("human", decision.approvalId);
    return receipt !== undefined && digest(record(receipt).decision) === digest(decision);
  }
  async humanDecisions(): Promise<ApprovalDecision[]> {
    await this.prepare(); const decisions: ApprovalDecision[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^human-[a-f0-9]{64}\.json$/.test(name)) continue;
      // Obtain the ID without trusting the file; read() checks permissions, scope and checksum.
      const file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let id: string;
      try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Unsafe host receipt file");
        id = textField(record(JSON.parse(await file.readFile("utf8"))).id); } finally { await file.close(); }
      if (name !== this.filename("human", id)) throw new Error("Host receipt filename identity mismatch");
      const receipt = await this.read("human", id); if (!receipt) throw new Error("Host receipt disappeared");
      decisions.push(ApprovalDecisionSchema.parse(record(receipt).decision));
    }
    return decisions;
  }
  async conversationTurns(): Promise<TrustedConversationTurn[]> {
    const turns: TrustedConversationTurn[] = [];
    for (const id of await this.receiptIds("conversation-turn")) turns.push(TrustedConversationTurnSchema.parse(await this.read("conversation-turn", id)));
    return turns.sort((a, b) => a.sequence - b.sequence);
  }
  private conversationBindingIdentity(binding: PaneBinding): string {
    return digest({ ...binding, transportState: undefined, lastHeartbeatAt: undefined });
  }
  private async conversationNudgeBoundary(principal: PaneBinding) {
    const binding = PaneBindingSchema.parse(principal);
    if (binding.role !== "conversation" || binding.sessionId !== this.sessionId || !binding.session)
      throw new Error("Only authenticated Conversation has Runtime nudge boundaries");
    const identity = this.conversationBindingIdentity(binding);
    const turn = (await this.conversationTurns()).filter(value => this.conversationBindingIdentity(value.binding) === identity).at(-1);
    const sequence = turn?.sequence ?? 0;
    return { bindingDigest: identity, sequence, id: digest([identity, sequence]) };
  }
  /** A private host receipt fences the previous human turn until a new physical user turn arrives; no approval or decision is created. */
  async recordConversationRuntimeNudge(binding: PaneBinding): Promise<void> {
    const boundary = await this.conversationNudgeBoundary(binding);
    await this.write("runtime-nudge", boundary.id, { bindingDigest: boundary.bindingDigest, sequence: boundary.sequence });
  }
  async isConversationRuntimeNudge(binding: PaneBinding): Promise<boolean> {
    const boundary = await this.conversationNudgeBoundary(binding);
    return await this.read("runtime-nudge", boundary.id) !== undefined;
  }
  async wasConversationTurnNudged(input: TrustedConversationTurn): Promise<boolean> {
    const turn = TrustedConversationTurnSchema.parse(input);
    if (turn.binding.sessionId !== this.sessionId) throw new Error("Foreign Conversation turn");
    return await this.read("runtime-nudge", digest([this.conversationBindingIdentity(turn.binding), turn.sequence])) !== undefined;
  }
  private async approvalFailures(messageId: string) {
    const failures: z.infer<typeof ApprovalFailureReceiptSchema>[] = [];
    for (const id of await this.receiptIds("approval-failure")) {
      const failure = ApprovalFailureReceiptSchema.parse(await this.read("approval-failure", id));
      if (failure.messageId === messageId) failures.push(failure);
    }
    return failures.sort((a, b) => a.attempt - b.attempt);
  }
  /** A failed physical approval hook is reportable context, never an approval or an ordinary model decision. */
  async recordApprovalFailure(messageId: string, failure: { error: string; note: string }): Promise<void> {
    if (!(await this.conversationTurns()).some(turn => turn.messageId === messageId)) throw new Error("Unknown trusted approval turn");
    const attempt = ((await this.approvalFailures(messageId)).at(-1)?.attempt ?? 0) + 1;
    await this.write("approval-failure", digest([messageId, attempt]), { messageId, attempt, ...failure });
  }
  async conversationApprovalFailure(messageId: string): Promise<{ messageId: string; error: string; note: string } | undefined> {
    const failure = (await this.approvalFailures(messageId)).at(-1);
    return failure === undefined ? undefined : { messageId: failure.messageId, error: failure.error, note: failure.note };
  }
  async assertConversationUserTurn(binding: PaneBinding): Promise<void> {
    if (await this.isConversationRuntimeNudge(binding))
      throw new Error("Runtime nudge requires no Conversation decision or resume. Report the supplied notices; do not ask the user to repeat.");
  }
  /** An operational resume is a real user request, not an approval or a model-supplied provenance flag. */
  async authorizeConversationResume(binding: PaneBinding, messageId: string | undefined, runId: string): Promise<void> {
    await this.assertConversationUserTurn(binding);
    const turn = (await this.conversationTurns()).at(-1);
    if (binding.role !== "conversation" || !turn || messageId !== undefined && turn.messageId !== messageId ||
        this.conversationBindingIdentity(turn.binding) !== this.conversationBindingIdentity(binding))
      throw new Error("Resume requires the current authenticated Conversation user message");
    const request = parseConversationResumeRequest(turn.content);
    if (!request || request.runId !== undefined && request.runId !== runId)
      throw new Error("An explicit resume request is required: reply 'tiếp tục' or 'resume <run-id>' in Conversation");
  }
  /** Reserve the next bounded Stop refusal for an undecided user turn; false once the budget is spent (it survives restart). */
  async reserveDecisionReblock(messageId: string): Promise<number | undefined> {
    for (let attempt = 1; attempt <= MAX_DECISION_REBLOCKS; attempt++) {
      const id = `${textField(messageId)}:${attempt}`;
      if (await this.read("decision-reblock", id) !== undefined) continue;
      return await this.write("decision-reblock", id, { messageId, attempt, reblockedAt: new Date().toISOString() }) ? attempt : undefined;
    }
    return undefined;
  }
  async recordConversationTurn(turn: TrustedConversationTurn): Promise<void> { await this.write("conversation-turn", turn.messageId, turn); }
  async conversationDecision(messageId: string): Promise<{ decision: JsonValue; result?: JsonValue } | undefined> {
    const value = await this.read("conversation-result", messageId) ?? await this.read("conversation-intent", messageId);
    if (value === undefined) return undefined;
    const receipt = ConversationDecisionReceiptSchema.parse(value);
    return { decision: receipt.decision, ...(receipt.result === undefined ? {} : { result: receipt.result }) };
  }
  async recordConversationIntent(messageId: string, decision: JsonValue): Promise<void> {
    await this.write("conversation-intent", messageId, { messageId, decision });
  }
  async recordConversationResult(messageId: string, decision: JsonValue, result: JsonValue): Promise<void> {
    const intent = await this.read("conversation-intent", messageId);
    if (intent === undefined || digest(record(intent).decision) !== digest(decision)) throw new Error("Conversation result lacks matching intent");
    await this.write("conversation-result", messageId, { messageId, decision, result });
  }
  /** Idempotent by message ID: a replayed acknowledgement never creates a second notice. */
  async appendConversationNotice(message: RoleMessage): Promise<boolean> {
    const parsed = RoleMessageSchema.parse(message);
    if (await this.read("conversation-notice", parsed.message_id) !== undefined) return false;
    const text = JSON.stringify(parsed.payload) ?? "null", truncated = text.length > NOTICE_SUMMARY_LIMIT;
    const userDecision = parsed.type === "approval.request" ? userDecisionNoticeFields(parsed.payload) : undefined;
    const approval = parsed.type === "approval.request" && userDecision === undefined ? approvalNoticeFields(parsed.payload) : undefined;
    return this.write("conversation-notice", parsed.message_id, { messageId: parsed.message_id, type: parsed.type, senderRole: parsed.sender.role,
      ...(parsed.run_id === undefined ? {} : { runId: parsed.run_id }), correlationId: parsed.correlation_id, receivedAt: new Date().toISOString(),
      ...(userDecision === undefined ? {} : { userDecision }), ...(approval === undefined ? {} : { approval }),
      summary: truncated ? text.slice(0, NOTICE_SUMMARY_LIMIT) : text, truncated });
  }
  /** Reserve before the Herdr side effect. A lost acknowledgement consumes the attempt; restart never resets this budget. */
  async reserveConversationNudge(messageIds: readonly string[]): Promise<boolean> {
    let reserved = false;
    const ids = [...new Set(messageIds)].slice(0, 100);
    for (const messageId of ids) {
      if (await this.read("conversation-notice", messageId) === undefined) throw new Error("Unknown Conversation notice");
      for (let attempt = 1; attempt <= 3; attempt++) {
        const id = `${messageId}:${attempt}`;
        if (await this.read("notice-nudge", id) !== undefined) continue;
        reserved = await this.write("notice-nudge", id, { messageId, attempt, attemptedAt: new Date().toISOString() }) || reserved;
        break;
      }
    }
    if (!reserved && ids.length) {
      const id = `nudge-exhausted:${digest([...ids].sort())}`;
      if (await this.read("notification-failure", id) === undefined) await this.write("notification-failure", id, {
        messageIds: ids, failedAt: new Date().toISOString(),
        reason: "Automatic Conversation wake attempts are exhausted. Open Conversation and submit a status request to read the pending notice; resume or cancel the original run there."
      });
    }
    return reserved;
  }
  /** Durable retry breadcrumb for a failed OS notification or safe Conversation nudge. */
  async recordConversationDeliveryFailure(messageIds: readonly string[], reason: string): Promise<void> {
    const ids = [...new Set(messageIds.map(value => textField(value)))].slice(0, 100);
    for (const id of ids) if (await this.read("conversation-notice", id) === undefined) throw new Error("Unknown Conversation notice");
    // One receipt per (notices, failure class): a repeating failure (e.g. unsupported OS notification) must not grow the store.
    const text = redactString(reason).slice(0, 2000);
    const key = `${ids.sort().join(",")}:${digest(text.replace(/\d+/g, "#"))}`;
    if (await this.read("notification-failure", key) !== undefined) return;
    await this.write("notification-failure", key, { messageIds: ids, reason: text, failedAt: new Date().toISOString() });
  }
  async conversationDeliveryFailures(): Promise<{ messageIds: string[]; reason: string; failedAt: string }[]> {
    const failures: { messageIds: string[]; reason: string; failedAt: string }[] = [];
    for (const id of await this.receiptIds("notification-failure")) failures.push(NotificationFailureSchema.parse(await this.read("notification-failure", id)));
    return failures.sort((a, b) => a.failedAt.localeCompare(b.failedAt));
  }
  /** Notices not yet shown to the model, oldest first. A surfaced marker is a separate immutable receipt. */
  async unsurfacedConversationNotices(): Promise<ConversationNotice[]> {
    const notices: ConversationNotice[] = [];
    for (const id of await this.receiptIds("conversation-notice")) {
      if (await this.read("notice-surfaced", this.epochKey(id, await this.noticeEpoch(id))) !== undefined) continue;
      notices.push(ConversationNoticeSchema.parse(await this.read("conversation-notice", id)));
    }
    return notices.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.messageId.localeCompare(b.messageId));
  }
  /** Idempotent: a second call for the same notice keeps the first surfacing time. */
  async markConversationNoticesSurfaced(messageIds: readonly string[]): Promise<void> {
    for (const id of new Set(messageIds.map(value => textField(value)))) {
      if (await this.read("conversation-notice", id) === undefined) throw new Error("Unknown Conversation notice");
      const key = this.epochKey(id, await this.noticeEpoch(id));
      if (await this.read("notice-surfaced", key) === undefined) await this.write("notice-surfaced", key, { messageId: id, surfacedAt: new Date().toISOString() });
    }
  }
  /**
   * User-facing notices (user decisions, blocks) that were surfaced but not yet shown to the user, oldest first.
   * `reblocks` counts how many Stop hooks already re-blocked for display.
   */
  async undisplayedUserFacingNotices(): Promise<(ConversationNotice & { surfacedAt: string; reblocks: number })[]> {
    const values: (ConversationNotice & { surfacedAt: string; reblocks: number })[] = [];
    for (const id of await this.receiptIds("conversation-notice")) {
      const surfaced = await this.read("notice-surfaced", this.epochKey(id, await this.noticeEpoch(id)));
      if (surfaced === undefined || await this.read("notice-displayed", id) !== undefined) continue;
      const notice = ConversationNoticeSchema.parse(await this.read("conversation-notice", id));
      if (!isUserFacingNotice(renderConversationNotice(notice))) continue;
      const surfacedAt = NoticeSurfacedSchema.parse(surfaced).surfacedAt ?? notice.receivedAt;
      values.push({ ...notice, surfacedAt, reblocks: await this.noticeReblockCount(id) });
    }
    return values.sort((a, b) => a.surfacedAt.localeCompare(b.surfacedAt) || a.messageId.localeCompare(b.messageId));
  }
  /** Epoch 0 is the original surfacing; each resurfacing starts a new epoch whose surfaced marker carries a `#n` suffix. */
  private epochKey(messageId: string, epoch: number): string { return epoch === 0 ? messageId : `${messageId}#${epoch}`; }
  /** Number of resurfacings already recorded for a notice, which is its current epoch. */
  private async noticeEpoch(messageId: string): Promise<number> {
    let count = 0;
    while (await this.read("notice-resurfaced", `${messageId}#${count + 1}`) !== undefined) count++;
    return count;
  }
  /**
   * Makes a notice that is surfaced but not displayed (or not surfaced yet) eligible for surfacing again, as a new epoch.
   * Returns the new attempt number, or undefined when the notice is unknown or already displayed.
   */
  async resurfaceConversationNotice(messageId: string, now: Date = new Date()): Promise<number | undefined> {
    const id = textField(messageId);
    if (await this.read("conversation-notice", id) === undefined || await this.read("notice-displayed", id) !== undefined) return undefined;
    const attempt = await this.noticeEpoch(id) + 1;
    await this.write("notice-resurfaced", `${id}#${attempt}`, { messageId: id, attempt, resurfacedAt: now.toISOString() });
    return attempt;
  }
  /** Display state of every user-decision notice, oldest wait first. Read-only. */
  async conversationNoticeStates(): Promise<ConversationNoticeState[]> {
    const states: ConversationNoticeState[] = [];
    for (const id of await this.receiptIds("conversation-notice")) {
      const notice = ConversationNoticeSchema.parse(await this.read("conversation-notice", id));
      const rendered = renderConversationNotice(notice);
      if (rendered.kind !== "user_decision") continue;
      const resends = await this.noticeEpoch(id), key = this.epochKey(id, resends);
      const surfaced = await this.read("notice-surfaced", key), displayed = await this.read("notice-displayed", id) !== undefined;
      const resurfacedAt = resends === 0 ? undefined : NoticeResurfacedSchema.parse(await this.read("notice-resurfaced", key)).resurfacedAt;
      const surfacedAt = surfaced === undefined ? undefined : NoticeSurfacedSchema.parse(surfaced).surfacedAt ?? notice.receivedAt;
      states.push({ messageId: id, ...(rendered.approvalId === undefined ? {} : { approvalId: rendered.approvalId }),
        ...(notice.runId === undefined ? {} : { runId: notice.runId }), surfaced: surfacedAt !== undefined, displayed, resends,
        since: surfacedAt ?? resurfacedAt ?? notice.receivedAt });
    }
    return states.sort((a, b) => a.since.localeCompare(b.since) || a.messageId.localeCompare(b.messageId));
  }
  private async noticeReblockCount(messageId: string): Promise<number> {
    let count = 0;
    while (count < MAX_NOTICE_REBLOCKS + 1 && await this.read("notice-reblock", `${messageId}#${count + 1}`) !== undefined) count++;
    return count;
  }
  /** Records one more Stop re-block for a notice; returns the new attempt count. */
  async recordNoticeReblock(messageId: string): Promise<number> {
    const id = textField(messageId), attempt = await this.noticeReblockCount(id) + 1;
    await this.write("notice-reblock", `${id}#${attempt}`, { messageId: id, attempt });
    return attempt;
  }
  /**
   * Marks surfaced, user-facing notices as displayed. Ids that are unknown, unsurfaced or not user-facing are ignored;
   * the returned list holds only the ids newly marked.
   */
  async markConversationNoticesDisplayed(messageIds: readonly string[]): Promise<string[]> {
    const marked: string[] = [];
    for (const id of new Set(messageIds.map(value => textField(value)))) {
      if (await this.read("notice-displayed", id) !== undefined) continue;
      const notice = await this.read("conversation-notice", id);
      if (notice === undefined || await this.read("notice-surfaced", this.epochKey(id, await this.noticeEpoch(id))) === undefined) continue;
      if (!isUserFacingNotice(renderConversationNotice(ConversationNoticeSchema.parse(notice)))) continue;
      await this.write("notice-displayed", id, { messageId: id, displayedAt: new Date().toISOString() });
      marked.push(id);
    }
    return marked;
  }
  async recordGate(result: QualityGateResult): Promise<void> { const parsed = QualityGateResultSchema.parse(result); await this.write("gate", parsed.evaluationId, parsed); }
  async authenticateGate(input: QualityGateResult): Promise<boolean> { const result = QualityGateResultSchema.parse(input); return digest(await this.read("gate", result.evaluationId)) === digest(result); }
  async recordEvidence(result: VerificationResult): Promise<void> { const parsed = VerificationResultSchema.parse(result); await this.write("evidence", parsed.verificationId, parsed); }
  async getEvidence(id: string): Promise<VerificationResult | undefined> { const value = await this.read("evidence", id); return value === undefined ? undefined : VerificationResultSchema.parse(value); }
  async getGate(id: string): Promise<QualityGateResult | undefined> { const value = await this.read("gate", id); return value === undefined ? undefined : QualityGateResultSchema.parse(value); }
  async recordNativeIntent(operationId: string, message: RoleMessage): Promise<boolean> { return this.write("native-intent", operationId, message); }
  async recordNativeAcknowledgement(message: RoleMessage): Promise<void> { const parsed = RoleMessageSchema.parse(message); await this.write("native-ack", parsed.message_id, parsed); }
  async nativeDelivery(operationId: string): Promise<{ message: RoleMessage; status: "unknown_delivery" | "acknowledged" } | undefined> {
    const value = await this.read("native-intent", operationId); if (value === undefined) return undefined;
    const message = RoleMessageSchema.parse(value), acknowledgement = await this.read("native-ack", message.message_id);
    // The native plugin replaces only the placeholder binding-receipt signature after
    // checking the physical occupant. The signed ingress envelope is otherwise exact.
    const comparable = (value: RoleMessage) => value.type === "execution.receipt"
      ? { ...value, payload: { ...AgentBindingReceiptSchema.parse(value.payload), signature: undefined } } : value;
    if (acknowledgement !== undefined && digest(comparable(RoleMessageSchema.parse(acknowledgement))) !== digest(comparable(message)))
      throw new Error("Native acknowledgement conflicts with delivery intent");
    return { message, status: acknowledgement === undefined ? "unknown_delivery" : "acknowledged" };
  }
  async authenticateEvidence(input: VerificationResult): Promise<boolean> { const result = VerificationResultSchema.parse(input); return digest(await this.read("evidence", result.verificationId)) === digest(result); }
  async putObservation(kind: "review" | "alternative", id: string, value: HostObservation): Promise<void> { await this.write(kind, id, value); }
  async getObservation(kind: "review" | "alternative", id: string): Promise<HostObservation | undefined> {
    const value = await this.read(kind, id); if (value === undefined) return undefined;
    const raw = record(value);
    return { binding: PaneBindingSchema.parse(raw.binding), observation: JsonValueSchema.parse(raw.observation),
      ...(raw.context ? { context: QualityGateContextSchema.parse(raw.context) } : {}),
      ...(raw.runId ? { runId: textField(raw.runId) } : {}), ...(raw.taskId ? { taskId: textField(raw.taskId) } : {}) };
  }
}

/** Fixed polite words allowed around the resume keyword; any other word (a negation or another instruction) refuses the request. */
const RESUME_PREFIX = "(?:(?:ok(?:e|ay)?|được|hãy|vui lòng|please)[\\s,]+){0,2}";
const RESUME_SUFFIX_WORDS = "đi|nhé|nha|giúp mình|giúp em|giúp tôi|please|pls";
const RESUME_REQUEST = new RegExp(`^${RESUME_PREFIX}(?:tiếp tục|resume|continue)` +
  `(?:\\s+(?:run\\s+)?(?!(?:${RESUME_SUFFIX_WORDS})(?:[\\s,.!]|$))([A-Za-z0-9][A-Za-z0-9._:-]*))?` +
  `(?:[\\s,]+(?:${RESUME_SUFFIX_WORDS})){0,2}\\s*[.!]?$`, "iu");
/** An explicit user request to resume, optionally naming the exact run: "tiếp tục", "ok tiếp tục nhé", "Continue run-1 please". */
export function parseConversationResumeRequest(content: string): { runId?: string } | undefined {
  const match = RESUME_REQUEST.exec(content.trim());
  return match ? (match[1] === undefined ? {} : { runId: match[1] }) : undefined;
}
