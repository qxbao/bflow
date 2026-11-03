import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import {
  DIRECTOR_LIMITS,
  DIRECTOR_SCHEMA_VERSION,
  DirectorMailboxItemSchema,
  DirectorMessageSchema,
  DirectorSessionSchema,
  ParkedIssueSchema,
  type AgentProviderId,
  type DirectorChannel,
  type DirectorMailboxItem,
  type DirectorMessage,
  type DirectorPresence,
  type DirectorSession,
  type ParkedIssue,
  type ParkedIssueKind,
  type ParkedIssueStatus
} from "@bflow/contracts";

export class DirectorAuthError extends Error {}

export interface DirectorStoreOptions {
  readonly directory: string;
  readonly now?: () => Date;
}
export interface DirectorVersion {
  readonly messageSeq: number;
  readonly issuesRevision: number;
  readonly mailboxSeq: number;
}
export type MailboxAppendInput = Omit<DirectorMailboxItem, "schemaVersion" | "seq">;
export interface IssueInput {
  readonly issueId?: string;
  readonly runId: string;
  readonly taskKey?: string;
  readonly kind: ParkedIssueKind;
  readonly summary: string;
  readonly attempts?: number;
  readonly evidence?: readonly string[];
  readonly suggestedAction?: string;
}

const TokenFileSchema = z.object({ tokenId: z.string().min(1), secretSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const IssuesFileSchema = z.object({ revision: z.number().int().min(0), issues: z.array(ParkedIssueSchema) }).strict();
type IssuesFile = z.infer<typeof IssuesFileSchema>;
const StartedWorkFileSchema = z.object({ works: z.record(z.object({ runId: z.string().min(1), correlationId: z.string().min(1) }).strict()) }).strict();
export interface StartedWork { readonly runId: string; readonly correlationId: string }

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const isEnoent = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** File-backed Director state: session/token, shared transcript, issue queue. */
export class DirectorStore {
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly events = new EventEmitter();
  private ready: Promise<void> | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: DirectorStoreOptions) {
    this.directory = options.directory;
    this.now = options.now ?? (() => new Date());
    this.events.setMaxListeners(0);
  }

  async register(input: { provider: AgentProviderId; repositoryRoot: string }): Promise<{ session: DirectorSession; token: string }> {
    return this.serial(async () => {
      const tokenId = randomUUID();
      const secret = randomBytes(32).toString("hex");
      const at = this.iso();
      const session = DirectorSessionSchema.parse({
        schemaVersion: DIRECTOR_SCHEMA_VERSION,
        directorId: randomUUID(),
        provider: input.provider,
        repositoryRoot: input.repositoryRoot,
        tokenId,
        startedAt: at,
        heartbeatAt: at,
        waitingSince: null
      });
      await this.writeJson("token.json", { tokenId, secretSha256: sha256(secret).toString("hex") });
      await this.writeJson("session.json", session);
      return { session, token: `${tokenId}.${secret}` };
    });
  }

  async authenticate(token: string): Promise<DirectorSession> {
    const reject = () => new DirectorAuthError("Director token rejected");
    const dot = typeof token === "string" ? token.indexOf(".") : -1;
    if (dot <= 0 || dot === token.length - 1) throw reject();
    const tokenId = token.slice(0, dot);
    const secret = token.slice(dot + 1);
    const session = await this.readSession();
    const stored = await this.readTokenFile();
    if (!session || !stored || session.tokenId !== tokenId || stored.tokenId !== tokenId) throw reject();
    const expected = Buffer.from(stored.secretSha256, "hex");
    const actual = sha256(secret);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw reject();
    return session;
  }

  async heartbeat(token: string, waiting: boolean): Promise<DirectorSession> {
    return this.serial(async () => {
      const current = await this.authenticate(token);
      const at = this.iso();
      const next = DirectorSessionSchema.parse({
        ...current,
        heartbeatAt: at,
        waitingSince: waiting ? (current.waitingSince ?? at) : null
      });
      await this.writeJson("session.json", next);
      return next;
    });
  }

  async presence(): Promise<{ presence: DirectorPresence; session: DirectorSession | null }> {
    const session = await this.readSession();
    if (!session) return { presence: "absent", session: null };
    if (this.now().getTime() - Date.parse(session.heartbeatAt) > DIRECTOR_LIMITS.heartbeatStaleMs) {
      return { presence: "absent", session };
    }
    return { presence: session.waitingSince !== null ? "waiting" : "active", session };
  }

  async revoke(): Promise<void> {
    await this.serial(async () => {
      await this.ensureDirectory();
      for (const name of ["session.json", "token.json"]) {
        try {
          await fs.rm(path.join(this.directory, name));
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
      }
      this.events.emit("revoked");
    });
  }

  /** Run already created for a user message (by its stable messageId); survives Director re-registration and host restarts. */
  async startedWork(messageId: string): Promise<StartedWork | undefined> {
    return this.serial(async () => (await this.readStartedWork()).works[messageId]);
  }

  async recordStartedWork(messageId: string, work: StartedWork): Promise<void> {
    await this.serial(async () => {
      const file = await this.readStartedWork();
      if (file.works[messageId]) return;
      await this.writeJson("started-work.json", { works: { ...file.works, [messageId]: work } });
    });
  }

  private async readStartedWork(): Promise<z.infer<typeof StartedWorkFileSchema>> {
    const raw = await this.readJson("started-work.json");
    return raw === undefined ? { works: {} } : StartedWorkFileSchema.parse(raw);
  }

  async appendMessage(input: { author: "user" | "director"; channel: DirectorChannel; text: string; runId?: string }): Promise<DirectorMessage> {
    return this.serial(async () => {
      await this.ensureDirectory();
      const { messages, validLength } = await this.loadTranscript();
      const message = DirectorMessageSchema.parse({
        schemaVersion: DIRECTOR_SCHEMA_VERSION,
        seq: (messages.length > 0 ? messages[messages.length - 1]!.seq : 0) + 1,
        messageId: randomUUID(),
        author: input.author,
        channel: input.channel,
        text: input.text,
        at: this.iso(),
        ...(input.runId !== undefined ? { runId: input.runId } : {})
      });
      const handle = await fs.open(path.join(this.directory, "transcript.jsonl"), "a", 0o600);
      try {
        // Drop a dangling partial tail so the new line starts on a clean boundary.
        const size = (await handle.stat()).size;
        if (size > validLength) await handle.truncate(validLength);
        await handle.appendFile(`${JSON.stringify(message)}\n`, "utf8");
        await handle.sync().catch(() => undefined);
      } finally {
        await handle.close();
      }
      await fs.chmod(path.join(this.directory, "transcript.jsonl"), 0o600);
      this.events.emit("change");
      return message;
    });
  }

  async readMessages(query: { afterSeq: number; limit?: number }): Promise<DirectorMessage[]> {
    await this.ensureDirectory();
    const limit = Math.min(Math.max(query.limit ?? DIRECTOR_LIMITS.transcriptPage, 0), DIRECTOR_LIMITS.transcriptPage);
    const { messages } = await this.loadTranscript();
    return messages.filter(message => message.seq > query.afterSeq).slice(0, limit);
  }

  /** Append-only mailbox. Deduped by audience+messageId; a duplicate returns the stored item without advancing seq. */
  async appendMailbox(input: MailboxAppendInput): Promise<{ item: DirectorMailboxItem; duplicate: boolean }> {
    return this.serial(async () => {
      await this.ensureDirectory();
      const { items, validLength } = await this.loadMailbox();
      const existing = items.find(item => item.audience === input.audience && item.messageId === input.messageId);
      if (existing) return { item: existing, duplicate: true };
      const item = DirectorMailboxItemSchema.parse({
        ...input,
        schemaVersion: DIRECTOR_SCHEMA_VERSION,
        seq: (items.length > 0 ? items[items.length - 1]!.seq : 0) + 1
      });
      const file = path.join(this.directory, "mailbox.jsonl");
      if (items.length + 1 > DIRECTOR_LIMITS.mailboxMax) {
        // Compact through an atomic rename; the newest items keep their original seq, so seq stays monotonic.
        const kept = [...items, item].slice(-DIRECTOR_LIMITS.mailboxMax);
        const tmp = `${file}.${randomUUID()}.tmp`;
        await fs.writeFile(tmp, kept.map(entry => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
        await fs.rename(tmp, file);
      } else {
        const handle = await fs.open(file, "a", 0o600);
        try {
          const size = (await handle.stat()).size;
          if (size > validLength) await handle.truncate(validLength);
          await handle.appendFile(`${JSON.stringify(item)}\n`, "utf8");
          await handle.sync().catch(() => undefined);
        } finally {
          await handle.close();
        }
        await fs.chmod(file, 0o600);
      }
      this.events.emit("change");
      return { item, duplicate: false };
    });
  }

  async readMailbox(query: { afterSeq: number; limit?: number; audience?: "director" | "user" }): Promise<DirectorMailboxItem[]> {
    await this.ensureDirectory();
    const limit = Math.min(Math.max(query.limit ?? DIRECTOR_LIMITS.mailboxPage, 0), DIRECTOR_LIMITS.mailboxPage);
    const { items } = await this.loadMailbox();
    return items.filter(item => item.seq > query.afterSeq && (query.audience === undefined || item.audience === query.audience)).slice(0, limit);
  }

  async mailboxItem(messageId: string): Promise<DirectorMailboxItem | undefined> {
    await this.ensureDirectory();
    return (await this.loadMailbox()).items.find(item => item.messageId === messageId);
  }

  async upsertIssue(input: IssueInput): Promise<ParkedIssue> {
    return this.serial(async () => {
      const file = await this.readIssues();
      const at = this.iso();
      const existing = input.issueId !== undefined ? file.issues.find(issue => issue.issueId === input.issueId) : undefined;
      let saved: ParkedIssue;
      let issues: ParkedIssue[];
      if (existing) {
        saved = ParkedIssueSchema.parse({
          ...existing,
          runId: input.runId,
          kind: input.kind,
          summary: input.summary,
          attempts: input.attempts ?? existing.attempts,
          evidence: [...(input.evidence ?? existing.evidence)],
          taskKey: input.taskKey,
          suggestedAction: input.suggestedAction,
          updatedAt: at
        });
        issues = file.issues.map(issue => (issue.issueId === saved.issueId ? saved : issue));
      } else {
        saved = ParkedIssueSchema.parse({
          schemaVersion: DIRECTOR_SCHEMA_VERSION,
          issueId: input.issueId ?? randomUUID(),
          runId: input.runId,
          ...(input.taskKey !== undefined ? { taskKey: input.taskKey } : {}),
          kind: input.kind,
          status: "open",
          summary: input.summary,
          attempts: input.attempts ?? 0,
          evidence: [...(input.evidence ?? [])],
          ...(input.suggestedAction !== undefined ? { suggestedAction: input.suggestedAction } : {}),
          createdAt: at,
          updatedAt: at
        });
        issues = [...file.issues, saved];
        if (issues.length > DIRECTOR_LIMITS.issuesMax) {
          const closed = issues
            .filter(issue => issue.status === "resolved" || issue.status === "dismissed")
            .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
          const drop = new Set<string>();
          for (const candidate of closed) {
            if (issues.length - drop.size <= DIRECTOR_LIMITS.issuesMax) break;
            drop.add(candidate.issueId);
          }
          if (issues.length - drop.size > DIRECTOR_LIMITS.issuesMax) throw new Error("Director issue queue is full");
          issues = issues.filter(issue => !drop.has(issue.issueId));
        }
      }
      await this.writeJson("issues.json", { revision: file.revision + 1, issues });
      this.events.emit("change");
      return saved;
    });
  }

  async setIssueStatus(issueId: string, status: ParkedIssueStatus): Promise<ParkedIssue> {
    return this.serial(async () => {
      const file = await this.readIssues();
      const existing = file.issues.find(issue => issue.issueId === issueId);
      if (!existing) throw new Error(`Unknown director issue ${issueId}`);
      const saved = ParkedIssueSchema.parse({ ...existing, status, updatedAt: this.iso() });
      await this.writeJson("issues.json", {
        revision: file.revision + 1,
        issues: file.issues.map(issue => (issue.issueId === issueId ? saved : issue))
      });
      this.events.emit("change");
      return saved;
    });
  }

  async listIssues(query?: { status?: readonly ParkedIssueStatus[] }): Promise<ParkedIssue[]> {
    const file = await this.readIssues();
    const statuses = query?.status;
    return file.issues
      .filter(issue => !statuses || statuses.includes(issue.status))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0));
  }

  async version(): Promise<DirectorVersion> {
    await this.ensureDirectory();
    const { messages } = await this.loadTranscript();
    const file = await this.readIssues();
    const { items } = await this.loadMailbox();
    return {
      messageSeq: messages.length > 0 ? messages[messages.length - 1]!.seq : 0,
      issuesRevision: file.revision,
      mailboxSeq: items.length > 0 ? items[items.length - 1]!.seq : 0
    };
  }

  /**
   * Resolves true when the version differs from `since` (immediately, or on a change while waiting),
   * false on timeout or abort. Change notification is in-process only: writes made by another
   * process are not observed until the timeout elapses and the caller re-checks `version()`.
   */
  async waitForChange(since: DirectorVersion, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    let cleanup = (): void => undefined;
    const woken = new Promise<boolean>(resolve => {
      const onChange = (): void => {
        void this.version().then(
          current => {
            if (current.messageSeq !== since.messageSeq || current.issuesRevision !== since.issuesRevision || current.mailboxSeq !== since.mailboxSeq) resolve(true);
          },
          () => undefined
        );
      };
      const onAbort = (): void => resolve(false);
      const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      this.events.on("change", onChange);
      this.events.on("revoked", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      cleanup = () => {
        clearTimeout(timer);
        this.events.off("change", onChange);
        this.events.off("revoked", onAbort);
        signal?.removeEventListener("abort", onAbort);
      };
    });
    try {
      const current = await this.version();
      if (current.messageSeq !== since.messageSeq || current.issuesRevision !== since.issuesRevision || current.mailboxSeq !== since.mailboxSeq) return true;
      return await woken;
    } finally {
      cleanup();
    }
  }

  // --- internals ---

  private iso(): string {
    return this.now().toISOString();
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private ensureDirectory(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const stat = await fs.lstat(this.directory);
        const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
        if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)) {
          throw new Error("Unsafe director state directory");
        }
      })();
      this.ready.catch(() => {
        this.ready = undefined;
      });
    }
    return this.ready;
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await this.ensureDirectory();
    const target = path.join(this.directory, name);
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.rename(tmp, target);
  }

  private async readJson(name: string): Promise<unknown | undefined> {
    await this.ensureDirectory();
    try {
      return JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8"));
    } catch (error) {
      if (isEnoent(error)) return undefined;
      throw error;
    }
  }

  private async readSession(): Promise<DirectorSession | null> {
    const raw = await this.readJson("session.json");
    return raw === undefined ? null : DirectorSessionSchema.parse(raw);
  }

  private async readTokenFile(): Promise<z.infer<typeof TokenFileSchema> | null> {
    const raw = await this.readJson("token.json");
    return raw === undefined ? null : TokenFileSchema.parse(raw);
  }

  private async readIssues(): Promise<IssuesFile> {
    const raw = await this.readJson("issues.json");
    return raw === undefined ? { revision: 0, issues: [] } : IssuesFileSchema.parse(raw);
  }

  private async loadTranscript(): Promise<{ messages: DirectorMessage[]; validLength: number }> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(path.join(this.directory, "transcript.jsonl"));
    } catch (error) {
      if (isEnoent(error)) return { messages: [], validLength: 0 };
      throw error;
    }
    const lastNewline = buffer.lastIndexOf(0x0a);
    const complete = lastNewline + 1; // bytes up to and including the final newline
    const lines = buffer.subarray(0, complete).toString("utf8").split("\n");
    lines.pop(); // empty tail after final newline
    const messages: DirectorMessage[] = [];
    let validLength = complete;
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      try {
        messages.push(DirectorMessageSchema.parse(JSON.parse(line)));
      } catch {
        if (index === lines.length - 1) {
          validLength = offset; // corrupt final line: ignore and overwrite on next append
          break;
        }
        throw new Error(`Corrupt director transcript at line ${index + 1}`);
      }
      offset += lineBytes;
    }
    return { messages, validLength };
  }

  private async loadMailbox(): Promise<{ items: DirectorMailboxItem[]; validLength: number }> {
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(path.join(this.directory, "mailbox.jsonl"));
    } catch (error) {
      if (isEnoent(error)) return { items: [], validLength: 0 };
      throw error;
    }
    const complete = buffer.lastIndexOf(0x0a) + 1;
    const lines = buffer.subarray(0, complete).toString("utf8").split("\n");
    lines.pop();
    const items: DirectorMailboxItem[] = [];
    let validLength = complete;
    let offset = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      try {
        items.push(DirectorMailboxItemSchema.parse(JSON.parse(line)));
      } catch {
        if (index === lines.length - 1) {
          validLength = offset;
          break;
        }
        throw new Error(`Corrupt director mailbox at line ${index + 1}`);
      }
      offset += Buffer.byteLength(line, "utf8") + 1;
    }
    return { items, validLength };
  }
}
