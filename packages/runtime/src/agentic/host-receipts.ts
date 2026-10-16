import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import {
  ApprovalDecisionSchema, JsonValueSchema, PaneBindingSchema, QualityGateContextSchema,
  QualityGateResultSchema, VerificationResultSchema,
  type ApprovalDecision, type JsonValue, type PaneBinding, type QualityGateResult, type VerificationResult
} from "@bflow/contracts";
import { digest, json, record, textField } from "./journal.js";

type Kind = "human" | "gate" | "evidence" | "review" | "alternative";
export interface HumanHookProvenance {
  origin: "UserPromptSubmit"; binding: PaneBinding; nativeSessionId: string;
  conversationSessionId: string; userId: string; messageId: string; promptDigest: string;
}
export interface HostObservation {
  binding: PaneBinding; observation: JsonValue; context?: unknown; runId?: string; taskId?: string;
}
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
    if (kind === "human" && ApprovalDecisionSchema.parse(record(payload).decision).approvalId !== id ||
        kind === "gate" && QualityGateResultSchema.parse(payload).evaluationId !== id ||
        kind === "evidence" && VerificationResultSchema.parse(payload).verificationId !== id)
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
  private async write(kind: Kind, id: string, input: unknown): Promise<void> {
    const payload = this.parsePayload(kind, input);
    const value = { version: 1 as const, repository: this.repository, sessionId: this.sessionId, kind, id, payload };
    const envelope = this.validate({ ...value, checksum: digest(value) }, kind, id);
    await this.prepare();
    const path = join(this.directory, `pending-${randomUUID()}.tmp`), file = await open(path, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(envelope)); await file.sync(); } finally { await file.close(); }
    try {
      try { await link(path, join(this.directory, this.filename(kind, id))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (digest(await this.read(kind, id)) !== digest(payload)) throw new Error("Conflicting immutable host receipt");
      }
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(path, { force: true }); }
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
  async recordGate(result: QualityGateResult): Promise<void> { const parsed = QualityGateResultSchema.parse(result); await this.write("gate", parsed.evaluationId, parsed); }
  async authenticateGate(input: QualityGateResult): Promise<boolean> { const result = QualityGateResultSchema.parse(input); return digest(await this.read("gate", result.evaluationId)) === digest(result); }
  async recordEvidence(result: VerificationResult): Promise<void> { const parsed = VerificationResultSchema.parse(result); await this.write("evidence", parsed.verificationId, parsed); }
  async getEvidence(id: string): Promise<VerificationResult | undefined> { const value = await this.read("evidence", id); return value === undefined ? undefined : VerificationResultSchema.parse(value); }
  async getGate(id: string): Promise<QualityGateResult | undefined> { const value = await this.read("gate", id); return value === undefined ? undefined : QualityGateResultSchema.parse(value); }
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
