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

type Kind = "conversation-turn" | "conversation-intent" | "conversation-result" | "conversation-notice" | "notice-surfaced" | "human" | "gate" | "evidence" | "review" | "alternative" | "native-intent" | "native-ack" | "coordinator-boundary" | "coordinator-start" | "coordinator-stop" | "coordinator-stop-handled";
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
  summary: z.string(), truncated: z.boolean() }).strict();
export type ConversationNotice = z.infer<typeof ConversationNoticeSchema>;
const NoticeSurfacedSchema = z.object({ messageId: z.string().min(1) }).strict();
const ConversationDecisionReceiptSchema = z.object({ messageId: z.string().min(1), decision: JsonValueSchema,
  result: JsonValueSchema.optional() }).strict();
export interface HostObservation {
  binding: PaneBinding; observation: JsonValue; context?: unknown; runId?: string; taskId?: string;
}
export interface CoordinatorTurnObservation { binding: PaneBinding; message: RoleMessage; sequence: number; nativeResponseBaseline?: string[] }
interface Envelope { version: 1; repository: string; sessionId: string; kind: Kind; id: string; payload: JsonValue; checksum: string }

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
    if (kind.startsWith("coordinator-")) {
      const raw = record(input), binding = PaneBindingSchema.parse(raw.binding), message = RoleMessageSchema.parse(raw.message);
      if (binding.sessionId !== this.sessionId || binding.role !== "coordinator" || !binding.session ||
          message.recipient.role !== "coordinator" || message.sender.role !== "conversation" || message.type !== "delegation.request" ||
          !Number.isSafeInteger(raw.sequence) || Number(raw.sequence) < 1) throw new Error("Invalid Coordinator turn observation");
      const baseline = raw.nativeResponseBaseline;
      if (baseline !== undefined && (!Array.isArray(baseline) || baseline.some(id => typeof id !== "string" || !id))) throw new Error("Invalid native response baseline");
      return json({ binding, message, sequence: raw.sequence, ...(baseline === undefined ? {} : { nativeResponseBaseline: baseline }) });
    }
    if (kind === "conversation-notice") return json(ConversationNoticeSchema.parse(input));
    if (kind === "notice-surfaced") return json(NoticeSurfacedSchema.parse(input));
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
    if (kind.startsWith("conversation-") && record(payload).messageId !== id ||
        kind === "human" && ApprovalDecisionSchema.parse(record(payload).decision).approvalId !== id ||
        kind === "gate" && QualityGateResultSchema.parse(payload).evaluationId !== id ||
        kind === "evidence" && VerificationResultSchema.parse(payload).verificationId !== id ||
        kind === "notice-surfaced" && record(payload).messageId !== id ||
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
    for (const name of await readdir(this.directory)) {
      if (!name.startsWith(`${kind}-`) || !name.endsWith(".json")) continue;
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
    return this.write("conversation-notice", parsed.message_id, { messageId: parsed.message_id, type: parsed.type, senderRole: parsed.sender.role,
      ...(parsed.run_id === undefined ? {} : { runId: parsed.run_id }), correlationId: parsed.correlation_id, receivedAt: new Date().toISOString(),
      summary: truncated ? text.slice(0, NOTICE_SUMMARY_LIMIT) : text, truncated });
  }
  /** Notices not yet shown to the model, oldest first. A surfaced marker is a separate immutable receipt. */
  async unsurfacedConversationNotices(): Promise<ConversationNotice[]> {
    const notices: ConversationNotice[] = [];
    for (const id of await this.receiptIds("conversation-notice")) {
      if (await this.read("notice-surfaced", id) !== undefined) continue;
      notices.push(ConversationNoticeSchema.parse(await this.read("conversation-notice", id)));
    }
    return notices.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.messageId.localeCompare(b.messageId));
  }
  async markConversationNoticesSurfaced(messageIds: readonly string[]): Promise<void> {
    for (const id of new Set(messageIds.map(value => textField(value)))) {
      if (await this.read("conversation-notice", id) === undefined) throw new Error("Unknown Conversation notice");
      await this.write("notice-surfaced", id, { messageId: id });
    }
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
