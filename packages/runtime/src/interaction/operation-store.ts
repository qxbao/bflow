import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApprovalDecisionSchema, WebCommandSchema, WebOperationSchema, IdentifierSchema, type ApprovalDecision, type WebOperation } from "@bflow/contracts";
import { canonicalWebJson, WebInteractionReceiptSchema, webCommandFingerprint,
  type WebInteractionReceipt } from "@bflow/contracts/web-host";
import type { WebInteractionAuthority } from "./authority.js";

const checksum = (value: unknown) => createHash("sha256").update(canonicalWebJson(value)).digest("hex");
const pending = new Map<string, Promise<unknown>>();
const MAX_BYTES = 1024 * 1024;

/** Private host storage, separate from HostReceiptJournal v1. Requires the
 * existing exclusive host owner/lock; no multi-process/multi-host guarantee.
 * No automatic pruning: finalized records retain nonce and command tombstones.
 * Host mutation ingress delegates effects to Conversation's structured port.
 */
export class WebOperationStore {
  private readonly directory: string;
  private readonly active = new Set<string>();
  constructor(private readonly options: { directory: string; repository: string; sessionId: string; projectId: string }) {
    this.directory = resolve(options.directory);
    IdentifierSchema.parse(options.sessionId); IdentifierSchema.parse(options.projectId);
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = (pending.get(this.directory) ?? Promise.resolve()).catch(() => undefined).then(work);
    pending.set(this.directory, result);
    void result.finally(() => { if (pending.get(this.directory) === result) pending.delete(this.directory); }).catch(() => undefined);
    return result;
  }
  private id(principalId: string, commandId: string): string {
    IdentifierSchema.parse(principalId);
    // Storage key validation; exchanged operations still use the exported schema.
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(commandId)) throw new Error("Invalid operation ID");
    return checksum([this.options.projectId, principalId, commandId]);
  }
  private async prepare(create: boolean): Promise<boolean> {
    let stat;
    try { stat = await lstat(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return false;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      stat = await lstat(this.directory);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error("Unsafe web operation directory");
    return true;
  }
  private async readJson(name: string): Promise<unknown | undefined> {
    let file;
    try { file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES)
        throw new Error("Unsafe web operation record");
      // Size is checked again after reading to detect concurrent growth.
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const read = await file.read(bytes, size, bytes.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > MAX_BYTES) throw new Error("Oversized web operation record");
      return JSON.parse(bytes.subarray(0, size).toString("utf8"));
    } finally { await file.close(); }
  }
  private parse(input: unknown): WebInteractionReceipt {
    const receipt = WebInteractionReceiptSchema.parse(input);
    if (receipt.repository !== this.options.repository || receipt.sessionId !== this.options.sessionId ||
      receipt.payload.command.projectId !== this.options.projectId) throw new Error("Foreign web operation receipt");
    return receipt;
  }
  private envelope(intent: WebInteractionReceipt, operation: WebOperation): WebInteractionReceipt {
    const { checksum: _old, ...old } = intent;
    const body = { ...old, payload: { ...intent.payload, operation } };
    return this.parse({ ...body, checksum: checksum(body) });
  }
  /** Immutable atomic publication; a durable directory sync precedes acknowledgement. */
  private async publish(name: string, receipt: WebInteractionReceipt): Promise<boolean> {
    const temp = join(this.directory, `pending-${randomUUID()}.tmp`);
    const file = await open(temp, "wx", 0o600);
    try {
      try { await file.writeFile(canonicalWebJson(receipt)); await file.sync(); }
      finally { await file.close(); }
      try { await link(temp, join(this.directory, name)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = this.parse(await this.readJson(name));
        if (canonicalWebJson(previous) !== canonicalWebJson(receipt)) throw new Error("Web operation publication conflict");
        return false;
      }
      const directory = await open(this.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return true;
    } finally { await rm(temp, { force: true }); }
  }
  private async intent(id: string): Promise<WebInteractionReceipt | undefined> {
    const input = await this.readJson(`${id}.intent.json`);
    if (input === undefined) return undefined;
    const receipt = this.parse(input);
    if (this.id(receipt.payload.principal.principalId, receipt.id) !== id || receipt.payload.operation.state !== "accepted")
      throw new Error("Web intent identity/state mismatch");
    return receipt;
  }
  private async operation(id: string, intent: WebInteractionReceipt): Promise<WebOperation> {
    for (const suffix of ["settled", "uncertain", "running"] as const) {
      const input = await this.readJson(`${id}.${suffix}.json`);
      if (input === undefined) continue;
      const receipt = this.parse(input);
      const expected = this.envelope(intent, receipt.payload.operation);
      if (canonicalWebJson(receipt) !== canonicalWebJson(expected) ||
        (suffix === "settled" ? !["applied", "failed"].includes(receipt.payload.operation.state) :
          receipt.payload.operation.state !== (suffix === "running" ? "running" : "reconciliation_required")))
        throw new Error("Web operation transition mismatch");
      if (suffix !== "running") return receipt.payload.operation;
      return this.active.has(id) ? receipt.payload.operation : this.uncertain(intent);
    }
    return this.active.has(id) ? intent.payload.operation : this.uncertain(intent);
  }
  private uncertain(intent: WebInteractionReceipt): WebOperation {
    return WebOperationSchema.parse({ ...intent.payload.operation, state: "reconciliation_required" });
  }
  accept(commandInput: unknown, principalInput: unknown, authority: WebInteractionAuthority): Promise<WebOperation> {
    return this.exclusive(async () => {
      const command = WebCommandSchema.parse(commandInput), principal = authority.verify(command, principalInput);
      if (command.projectId !== this.options.projectId || principal.hostSessionId !== this.options.sessionId)
        throw new Error("Web operation scope mismatch");
      await this.prepare(true);
      const id = this.id(principal.principalId, command.commandId), previous = await this.intent(id);
      if (previous) {
        if (previous.payload.fingerprint !== webCommandFingerprint(command)) throw new Error("Web command fingerprint conflict");
        return this.operation(id, previous);
      }
      // Host-local serialized scan consumes nonce and intent in one publication.
      // No separately written nonce file can strand or roll back acceptance.
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.intent\.json$/.test(name)) continue;
        const saved = await this.intent(name.slice(0, 64));
        const old = saved!.payload.principal;
        if (old.issuerId === principal.issuerId && old.keyId === principal.keyId && old.nonce === principal.nonce)
          throw new Error("Web proof nonce already consumed");
      }
      // Scanning retained receipts can consume a proof's remaining lifetime.
      // Check again at the exact durable-acceptance boundary.
      authority.verify(command, principal);
      const operation = WebOperationSchema.parse({ apiVersion: 1, operationId: command.commandId, projectId: command.projectId,
        owner: "host_interaction", operationKind: command.kind, state: "accepted", updatedAt: new Date().toISOString() });
      const body = { version: 2, repository: this.options.repository, sessionId: this.options.sessionId, kind: "web-interaction",
        id: command.commandId, payload: { principal, command, fingerprint: webCommandFingerprint(command), operation } };
      await this.publish(`${id}.intent.json`, this.parse({ ...body, checksum: checksum(body) }));
      this.active.add(id);
      return operation;
    });
  }
  read(principalId: string, commandId: string): Promise<WebOperation | undefined> {
    return this.exclusive(async () => {
      if (!await this.prepare(false)) return undefined;
      const id = this.id(principalId, commandId), intent = await this.intent(id);
      return intent ? this.operation(id, intent) : undefined;
    });
  }
  /** Private observation port. Stored accepted authority survives browser TTL. */
  records(): Promise<WebInteractionReceipt[]> {
    return this.exclusive(async () => {
      if (!await this.prepare(false)) return [];
      const records: WebInteractionReceipt[] = [];
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.intent\.json$/.test(name)) continue;
        const receipt = await this.intent(name.slice(0, 64));
        if (receipt) records.push(receipt);
      }
      return records;
    });
  }
  private decision(intent: WebInteractionReceipt, sessionId: string): ApprovalDecision {
    const command = intent.payload.command;
    if (command.kind !== "answer_decision") throw new Error("Not a human decision intent");
    return ApprovalDecisionSchema.parse({ schemaVersion: 2, approvalId: command.decisionId, runId: command.runId, sessionId,
      target: command.expectedVersion.target, revision: command.expectedVersion.revision, generation: command.expectedVersion.generation,
      decision: command.outcome, decidedBy: intent.payload.principal.principalId, decidedAt: intent.payload.operation.updatedAt,
      reason: command.reason ?? "User approved", feedbackArtifacts: [], idempotencyKey: `web-decision-${command.commandId}`,
      ...(command.selectedOption === undefined ? {} : { metadata: { selectedOption: command.selectedOption } }) });
  }
  /** A distinct v2 human milestone, never a native-v1 human receipt. */
  recordHumanDecision(principalId: string, commandId: string, input: unknown, sessionId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.prepare(false);
      const id = this.id(principalId, commandId), intent = await this.intent(id);
      if (!intent || canonicalWebJson(this.decision(intent, sessionId)) !== canonicalWebJson(ApprovalDecisionSchema.parse(input)))
        throw new Error("Human decision does not match accepted web intent");
      const running = this.parse(await this.readJson(`${id}.running.json`));
      if (running.payload.operation.state !== "running" || canonicalWebJson(running) !== canonicalWebJson(this.envelope(intent, running.payload.operation)))
        throw new Error("Human decision lacks dispatch intent");
      await this.publish(`${id}.human.json`, running);
    });
  }
  async humanDecisions(sessionId: string): Promise<ApprovalDecision[]> {
    const records = await this.records(), decisions: ApprovalDecision[] = [];
    for (const intent of records) {
      if (intent.payload.command.kind !== "answer_decision") continue;
      const id = this.id(intent.payload.principal.principalId, intent.id);
      const raw = await this.readJson(`${id}.human.json`);
      if (raw === undefined) continue;
      const marker = this.parse(raw);
      if (marker.payload.operation.state !== "running" || canonicalWebJson(marker) !== canonicalWebJson(this.envelope(intent, marker.payload.operation)))
        throw new Error("Invalid web human receipt");
      decisions.push(this.decision(intent, sessionId));
    }
    return decisions;
  }
  async authenticateHuman(input: unknown, sessionId: string): Promise<boolean> {
    const decision = ApprovalDecisionSchema.parse(input);
    return (await this.humanDecisions(sessionId)).some(saved => canonicalWebJson(saved) === canonicalWebJson(decision));
  }
  /** Claim immediately before Conversation admission. Never claim recovered work.
   * An interrupted running marker is unknown delivery, not retry permission. */
  begin(principalId: string, commandId: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!await this.prepare(false)) return false;
      const id = this.id(principalId, commandId), intent = await this.intent(id);
      if (!intent || !this.active.has(id) || (await this.operation(id, intent)).state !== "accepted") return false;
      const operation = WebOperationSchema.parse({ ...intent.payload.operation, state: "running", updatedAt: new Date().toISOString() });
      return this.publish(`${id}.running.json`, this.envelope(intent, operation));
    });
  }
  /** Read-only proof of the immutable dispatch boundary; does not create it. */
  hasDispatchIntent(principalId: string, commandId: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!await this.prepare(false)) return false;
      const id = this.id(principalId, commandId), intent = await this.intent(id);
      if (!intent) return false;
      const raw = await this.readJson(`${id}.running.json`);
      if (raw === undefined) return false;
      const running = this.parse(raw);
      if (running.payload.operation.state !== "running" || canonicalWebJson(running) !== canonicalWebJson(this.envelope(intent, running.payload.operation)))
        throw new Error("Invalid web dispatch receipt");
      return true;
    });
  }
  /** Only after the caller observes an authoritative committed effect. Unlike
   * begin(), this grants no dispatch claim and never marks work active. */
  reconcileDispatch(principalId: string, commandId: string): Promise<void> {
    return this.exclusive(async () => {
      if (!await this.prepare(false)) throw new Error("Missing web intent");
      const id = this.id(principalId, commandId), intent = await this.intent(id);
      if (!intent) throw new Error("Missing web intent");
      const raw = await this.readJson(`${id}.running.json`);
      if (raw !== undefined) {
        const running = this.parse(raw);
        if (running.payload.operation.state !== "running" || canonicalWebJson(running) !== canonicalWebJson(this.envelope(intent, running.payload.operation)))
          throw new Error("Invalid web dispatch receipt");
        return;
      }
      const operation = WebOperationSchema.parse({ ...intent.payload.operation, state: "running" });
      await this.publish(`${id}.running.json`, this.envelope(intent, operation));
    });
  }
  /** Caller must supply a conclusive Conversation/Runtime receipt, or explicitly
   * uncertain state. This store does not infer success from transport or a view. */
  settle(principalId: string, commandId: string, input: unknown): Promise<void> {
    return this.exclusive(async () => {
      if (!await this.prepare(false)) throw new Error("Missing web intent");
      const id = this.id(principalId, commandId), intent = await this.intent(id), operation = WebOperationSchema.parse(input);
      if (!intent || operation.operationId !== commandId || operation.projectId !== this.options.projectId ||
        operation.operationKind !== intent.payload.command.kind || operation.owner !== "host_interaction" ||
        !["applied", "failed", "reconciliation_required"].includes(operation.state)) throw new Error("Web settlement identity/state mismatch");
      // No result may exist without dispatch intent. Observation-only reconciliation
      // will require an owner adapter before recovering an accepted-only intent.
      const running = this.parse(await this.readJson(`${id}.running.json`));
      if (running.payload.operation.state !== "running" ||
        canonicalWebJson(running) !== canonicalWebJson(this.envelope(intent, running.payload.operation)))
        throw new Error("Invalid web dispatch intent");
      const current = await this.operation(id, intent);
      if (["applied", "failed"].includes(current.state) && canonicalWebJson(current) !== canonicalWebJson(operation))
        throw new Error("Web terminal operation conflict");
      await this.publish(`${id}.${operation.state === "reconciliation_required" ? "uncertain" : "settled"}.json`, this.envelope(intent, operation));
      this.active.delete(id);
    });
  }
}
