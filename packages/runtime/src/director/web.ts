import { realpath } from "node:fs/promises";
import { z } from "zod";
import {
  DIRECTOR_LIMITS,
  DirectorMessageSchema,
  DirectorProgressSnapshotSchema,
  IdentifierSchema,
  OperationResultSchema,
  ParkedIssueSchema,
  WebChatSendSchema,
  WebCursorSchema,
  WebDirectorTranscriptPageSchema,
  WebDirectorViewSchema,
  WebIssueQueueViewSchema,
  type ContractError,
  type DirectorMessage,
  type DirectorProgressSnapshot,
  type OperationResult,
  type ParkedIssue,
  type WebChatSend,
  type WebCommand,
  type WebDirectorTranscriptPage,
  type WebDirectorView,
  type WebIssueCommand,
  type WebIssueQueueView,
  type WebOperationResult
} from "@bflow/contracts";
import { redactString } from "../resilience/redaction.js";
import { callUserInteractionHost, queryAgenticHostInteraction } from "../agentic/host-controller.js";
import { interactionProjectId } from "../interaction/client.js";
import { DIRECTOR_FEED_RESOURCE, type DirectorEndpoint } from "./endpoint.js";
import { DirectorMessageConflictError } from "./store.js";
import { DirectorIssueRefusal, parkEpisodeIssueIds, type DirectorIssueGuard, type DirectorParkEpisode } from "./tools.js";

/**
 * Director Web bridge (slice C). The host is the single writer of the Director store: every Web read and write goes through
 * these methods inside the host process; Local Server and the CLI Web composition never open the store or its files.
 *
 * Authority split: the Web credential may only append a user/web message and page the transcript (`DIRECTOR_WEB_METHODS`);
 * the owner token reads the Director view and issue queue (`interaction_query` kinds `director` and `director_issues`); issue
 * retry/dismiss are signed WebCommands admitted here, never by Conversation. Chat text never becomes an approval or decision.
 * Reads never acknowledge delivery, never heartbeat and never consume anything.
 */

export const DIRECTOR_WEB_METHODS = {
  interaction_director_send: WebChatSendSchema,
  interaction_director_history: z.object({ projectId: IdentifierSchema, cursor: WebCursorSchema.optional() }).strict()
} as const;
export type DirectorWebMethod = keyof typeof DIRECTOR_WEB_METHODS;
export function isDirectorWebMethod(method: string): method is DirectorWebMethod {
  return Object.prototype.hasOwnProperty.call(DIRECTOR_WEB_METHODS, method);
}
/** Private owner-query kinds (InteractionQuerySchema). */
export const DirectorViewQuerySchema = z.object({ kind: z.literal("director"), projectId: IdentifierSchema }).strict();
export const DirectorIssuesQuerySchema = z.object({ kind: z.literal("director_issues"), projectId: IdentifierSchema, cursor: WebCursorSchema.optional() }).strict();

const PAGE = 100;
/** Director replies, tokens and park reasons are LLM/user text: redact secrets and Director-token shapes before the Web sees them. */
const TOKEN_TEXT = /\b[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{32,256}\b/g;
const REDACTED = "[REDACTED]";

function capUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(bytes.subarray(0, maxBytes)).replace(/�+$/, "");
}
/** Redacted, UTF-8-capped, never blank. */
export function redactDirectorText(value: string, maxBytes: number = DIRECTOR_LIMITS.messageBytes): string {
  const redacted = capUtf8(redactString(value).replace(TOKEN_TEXT, REDACTED), maxBytes);
  return redacted.trim().length > 0 ? redacted : REDACTED;
}
const redactIssueText = (value: string): string => {
  const redacted = redactString(value).replace(TOKEN_TEXT, REDACTED).slice(0, DIRECTOR_LIMITS.issueTextMax);
  return redacted.trim().length > 0 ? redacted : REDACTED;
};

export function projectDirectorMessage(message: DirectorMessage): DirectorMessage {
  return DirectorMessageSchema.parse({ ...message, text: redactDirectorText(message.text) });
}
export function projectParkedIssue(issue: ParkedIssue): ParkedIssue {
  return ParkedIssueSchema.parse({ ...issue, summary: redactIssueText(issue.summary),
    ...(issue.suggestedAction !== undefined ? { suggestedAction: redactIssueText(issue.suggestedAction) } : {}) });
}
function projectSnapshot(snapshot: DirectorProgressSnapshot): DirectorProgressSnapshot {
  const title = (value: string) => { const redacted = redactString(value).replace(TOKEN_TEXT, REDACTED).slice(0, 200); return redacted.trim() ? redacted : REDACTED; };
  return DirectorProgressSnapshotSchema.parse({ ...snapshot,
    runs: snapshot.runs.map(run => ({ ...run, title: title(run.title), tasks: run.tasks.map(task => ({ ...task, title: title(task.title) })) })),
    issues: snapshot.issues.map(projectParkedIssue) });
}

/** Transcript page cursors: `a<seq>` newer than seq, `b<seq>` older than seq; none = latest page. */
const TRANSCRIPT_CURSOR = /^([ab])(0|[1-9]\d{0,15})$/;
const ISSUE_CURSOR = /^o(0|[1-9]\d{0,5})$/;

type Reason = "forbidden" | "invalid_request" | "stale_version" | "operation_not_allowed" | "unavailable";
function refusal<T>(reason: Reason, message: string): OperationResult<T> {
  const error: ContractError = reason === "unavailable"
    ? { code: "transport_unavailable", retryable: true, message, details: { reason } }
    : reason === "stale_version"
      ? { code: "conflict", retryable: true, message, details: { reason } }
      : { code: "validation", retryable: false, message, details: { reason } };
  return { ok: false, error };
}
const ok = <T>(value: T): OperationResult<T> => ({ ok: true, value });

export interface DirectorFeedPublisher {
  publish(type: "chat" | "invalidate", resourceIds: string[]): unknown;
}
export interface DirectorWebBridgeOptions {
  readonly endpoint: DirectorEndpoint;
  readonly projectId: string;
  /** Host layout from configuration; a legacy v2 host has no Director chat. */
  readonly layout: () => "director" | "legacy_v2";
  /** interactionHostReady: workspace and activated manifest, not activating/closing/quiesced. */
  readonly ready: () => boolean;
  /** Activated manifest conversationSessionId, undefined before activation. */
  readonly sessionId: () => string | undefined;
  /** Runtime inspect() state; only called while ready. */
  readonly inspect: () => Promise<unknown>;
  /** Session ID owning a run, undefined when the run is unknown; validates the optional runId of a Web message. */
  readonly runSession: (runId: string) => Promise<string | undefined>;
  readonly feed?: DirectorFeedPublisher;
  readonly now?: () => Date;
}

/** Host-side Director Web bridge. All methods return exported DTOs; nothing exposes session, token, directorId or paths. */
export class DirectorWebBridge {
  private readonly options: DirectorWebBridgeOptions;
  private readonly now: () => Date;
  private observed: { messageSeq: number; issuesRevision: number; presence: string; cli: boolean } | undefined;
  private refreshing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(options: DirectorWebBridgeOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
  }

  // --- Web credential methods ---

  /** Dispatches a Web-credential Director method. Unknown methods throw (the host refuses them). */
  async callWeb(method: string, params: unknown): Promise<OperationResult<unknown>> {
    if (method === "interaction_director_send") {
      const parsed = DIRECTOR_WEB_METHODS.interaction_director_send.safeParse(params);
      return parsed.success ? this.send(parsed.data) : refusal("invalid_request", "Invalid Director message.");
    }
    if (method === "interaction_director_history") {
      const parsed = DIRECTOR_WEB_METHODS.interaction_director_history.safeParse(params);
      return parsed.success ? this.history(parsed.data.projectId, parsed.data.cursor) : refusal("invalid_request", "Invalid transcript query.");
    }
    throw new Error("User interaction credentials cannot call owner or role methods");
  }

  /** Appends a Web user message. Infrastructure not ready → unavailable (not written); Director absent → queued for the next session. */
  async send(input: WebChatSend): Promise<OperationResult<DirectorMessage>> {
    if (this.options.layout() !== "director") return refusal("operation_not_allowed", "Director chat unavailable in a legacy session.");
    if (!this.options.ready()) return refusal("unavailable", "Host chưa sẵn sàng; tin chưa được ghi.");
    if (input.projectId !== this.options.projectId) return refusal("forbidden", "Foreign Director chat project.");
    const sessionId = this.options.sessionId();
    if (sessionId === undefined || input.sessionId !== sessionId) return refusal("forbidden", "Foreign or stale Director chat session.");
    if (input.runId !== undefined && await this.options.runSession(input.runId).catch(() => undefined) !== sessionId)
      return refusal("forbidden", "Foreign Director chat run.");
    try {
      const message = await this.options.endpoint.appendWebMessage({ messageId: input.messageId, text: input.content, runId: input.runId });
      void this.refresh().catch(() => undefined);
      return ok(projectDirectorMessage(message));
    } catch (error) {
      if (error instanceof DirectorMessageConflictError) return refusal("stale_version", "This message ID already holds a different message.");
      throw error;
    }
  }

  /** Transcript page (both channels, both authors), redacted. Read-only: no ack, heartbeat or consumption. */
  async history(projectId: string, cursor?: string): Promise<OperationResult<WebDirectorTranscriptPage>> {
    if (projectId !== this.options.projectId) return refusal("forbidden", "Foreign Director transcript project.");
    if (this.options.layout() !== "director") return refusal("operation_not_allowed", "Director transcript unavailable in a legacy session.");
    const match = cursor === undefined ? undefined : TRANSCRIPT_CURSOR.exec(cursor);
    if (cursor !== undefined && !match) return refusal("invalid_request", "Invalid transcript cursor.");
    const messages = await this.options.endpoint.transcript();
    let items: DirectorMessage[];
    let nextCursor: string | undefined;
    if (!match) {
      items = messages.slice(-PAGE);
      nextCursor = `a${items.length > 0 ? items[items.length - 1]!.seq : 0}`;
    } else if (match[1] === "a") {
      const after = Number(match[2]);
      items = messages.filter(message => message.seq > after).slice(0, PAGE);
      nextCursor = `a${items.length > 0 ? items[items.length - 1]!.seq : after}`;
    } else {
      const before = Number(match[2]);
      const older = messages.filter(message => message.seq < before);
      items = older.slice(-PAGE);
      nextCursor = older.length > items.length && items.length > 0 ? `b${items[0]!.seq}` : undefined;
    }
    return ok(WebDirectorTranscriptPageSchema.parse({ apiVersion: 1, items: items.map(projectDirectorMessage), ...(nextCursor ? { nextCursor } : {}) }));
  }

  // --- owner queries ---

  async view(projectId: string): Promise<OperationResult<WebDirectorView>> {
    if (projectId !== this.options.projectId) return refusal("forbidden", "Foreign Director project.");
    const director = this.options.layout() === "director";
    const ready = this.options.ready();
    const sessionId = ready ? this.options.sessionId() : undefined;
    const state = ready ? await this.options.inspect().catch(() => ({ runs: [] })) : { runs: [] };
    const [snapshot, version, presence] = await Promise.all([this.options.endpoint.progressFrom(state), this.options.endpoint.version(), this.options.endpoint.presenceDetail()]);
    return ok(WebDirectorViewSchema.parse({
      apiVersion: 1,
      projectId,
      layout: !director ? "legacy_v2" : ready && sessionId !== undefined ? "director" : "not_started",
      ...(sessionId !== undefined ? { sessionId } : {}),
      snapshot: projectSnapshot(snapshot),
      ...(presence.waitingSince !== undefined ? { waitingSince: presence.waitingSince } : {}),
      transcriptSeq: version.messageSeq,
      cliCaptureMayBeIncomplete: this.options.endpoint.cliCaptureMayBeIncomplete(),
      observedAt: this.now().toISOString()
    }));
  }

  /** Every issue (all statuses, oldest first), redacted; offset cursor `o<n>`. */
  async issues(projectId: string, cursor?: string): Promise<OperationResult<WebIssueQueueView>> {
    if (projectId !== this.options.projectId) return refusal("forbidden", "Foreign Director project.");
    const match = cursor === undefined ? undefined : ISSUE_CURSOR.exec(cursor);
    if (cursor !== undefined && !match) return refusal("invalid_request", "Invalid issue cursor.");
    const offset = match ? Number(match[1]) : 0;
    const all = await this.options.endpoint.listIssues();
    const items = all.slice(offset, offset + PAGE);
    const next = offset + items.length < all.length ? `o${offset + items.length}` : undefined;
    return ok(WebIssueQueueViewSchema.parse({ apiVersion: 1, items: items.map(projectParkedIssue), ...(next ? { nextCursor: next } : {}) }));
  }

  /** Owner `interaction_query` kinds handled by the bridge; undefined for every other kind. */
  async query(params: unknown): Promise<OperationResult<unknown> | undefined> {
    const kind = typeof params === "object" && params !== null ? (params as Record<string, unknown>).kind : undefined;
    if (kind === "director") {
      const input = DirectorViewQuerySchema.safeParse(params);
      return input.success ? this.view(input.data.projectId) : refusal("invalid_request", "Invalid Director query.");
    }
    if (kind === "director_issues") {
      const input = DirectorIssuesQuerySchema.safeParse(params);
      return input.success ? this.issues(input.data.projectId, input.data.cursor) : refusal("invalid_request", "Invalid issue query.");
    }
    return undefined;
  }

  // --- issue commands (signed WebCommand, durable receipt in HostStructuredCommands) ---

  private guard(command: WebIssueCommand): DirectorIssueGuard {
    return issue => {
      if (issue.runId !== command.runId) throw new DirectorIssueRefusal("forbidden", "Issue does not belong to this run");
      if (Date.parse(issue.updatedAt) !== Date.parse(command.expectedUpdatedAt)) throw new DirectorIssueRefusal("stale_version", "Issue changed since it was displayed");
      if (command.kind === "issue_retry" && issue.status !== "open") throw new DirectorIssueRefusal("operation_not_allowed", "Only an open issue can be retried");
      if (command.kind === "issue_dismiss" && issue.status !== "open" && issue.status !== "retrying") throw new DirectorIssueRefusal("operation_not_allowed", "Issue is already closed");
    };
  }
  private static target(command: WebIssueCommand): "retrying" | "dismissed" { return command.kind === "issue_retry" ? "retrying" : "dismissed"; }

  /** Pre-receipt and pre-effect validation: layout, readiness, project, run/issue identity, expectedUpdatedAt and current park episode. */
  async validateIssueCommand(command: WebIssueCommand): Promise<"forbidden" | "stale_version" | "operation_not_allowed" | "unavailable" | undefined> {
    if (this.options.layout() !== "director") return "operation_not_allowed";
    if (!this.options.ready()) return "unavailable";
    if (command.projectId !== this.options.projectId) return "forbidden";
    if (await this.options.runSession(command.runId).catch(() => undefined) === undefined) return "forbidden";
    try {
      await this.options.endpoint.checkIssueStatus(command.issueId, DirectorWebBridge.target(command), this.guard(command));
      return undefined;
    } catch (error) {
      if (error instanceof DirectorIssueRefusal) return error.reason === "not_found" ? "forbidden" : error.reason;
      throw error;
    }
  }

  /**
   * The effect. A refusal found before the effect is definitive; an error after it is classified by observing the issue and
   * Runtime park state in the issue serial step. Unknown outcomes throw so the receipt stays reconciliation_required; nothing is resent.
   */
  async admitIssueCommand(command: WebIssueCommand): Promise<OperationResult<WebOperationResult>> {
    const target = DirectorWebBridge.target(command);
    try {
      const issue = await this.options.endpoint.setIssueStatus(command.issueId, target, this.guard(command));
      void this.refresh().catch(() => undefined);
      return ok({ kind: "issue", issueId: issue.issueId, status: issue.status });
    } catch (error) {
      if (error instanceof DirectorIssueRefusal) return refusal(error.reason === "not_found" ? "forbidden" : error.reason, "Issue command refused before any effect.");
      const observed = await this.reconcileIssueCommand(command);
      if (observed !== undefined) return observed;
      throw error;
    }
  }

  /** Observation only: proves applied or not-applied from the issue and Runtime park state; never calls unpark. */
  async reconcileIssueCommand(command: WebCommand): Promise<OperationResult<WebOperationResult> | undefined> {
    if (command.kind !== "issue_retry" && command.kind !== "issue_dismiss") return undefined;
    const target = DirectorWebBridge.target(command);
    const outcome = await this.options.endpoint.observeIssues(async observe => {
      const issue = await observe.issue(command.issueId);
      if (!issue || issue.runId !== command.runId) return { kind: "failed" as const };
      if (issue.status === target) return { kind: "applied" as const, issue };
      if (target === "dismissed" || issue.status !== "open") return { kind: "failed" as const };
      // Retry with the status still open: the effect is the unpark. Runtime state decides; nothing is resent here.
      if (issue.taskKey === undefined || !observe.park) return { kind: "failed" as const };
      const park = await observe.park(issue.runId, issue.taskKey);
      if (!park) return { kind: "unknown" as const };
      const matches = (entry: DirectorParkEpisode) => parkEpisodeIssueIds(issue.runId, issue.taskKey!, entry).includes(issue.issueId);
      // Still parked (this episode or a newer one): the unpark did not happen in this serial-ordered host.
      if (park.current !== undefined) return { kind: "failed" as const };
      return park.history.some(matches) ? { kind: "unparked" as const } : { kind: "unknown" as const };
    });
    if (outcome.kind === "applied") return ok({ kind: "issue", issueId: outcome.issue.issueId, status: outcome.issue.status });
    if (outcome.kind === "unparked") {
      // Runtime already reopened this episode; only the local status record is missing. setIssueStatus observes and does not unpark.
      const issue = await this.options.endpoint.setIssueStatus(command.issueId, "retrying");
      return ok({ kind: "issue", issueId: issue.issueId, status: issue.status });
    }
    if (outcome.kind === "failed") return refusal("operation_not_allowed", "Issue command was not applied.");
    return undefined;
  }

  // --- feed refresh (independent of browser polling) ---

  /**
   * Publishes Web refresh signals for Director changes: `chat` with new message IDs, `invalidate` scoped to `director` for issue,
   * presence or CLI-capture changes. Presence is computed with the clock at read time, so a stale heartbeat becomes `absent` on
   * the next poll. Heartbeat timestamps are not part of the fingerprint.
   */
  refresh(): Promise<void> {
    const work = this.refreshing.catch(() => undefined).then(async () => {
      const feed = this.options.feed;
      const [version, presence] = await Promise.all([this.options.endpoint.version(), this.options.endpoint.presenceDetail()]);
      const next = { messageSeq: version.messageSeq, issuesRevision: version.issuesRevision, presence: presence.presence, cli: this.options.endpoint.cliCaptureMayBeIncomplete() };
      const previous = this.observed;
      this.observed = next;
      if (!previous || !feed) return;
      if (next.messageSeq > previous.messageSeq) {
        const fresh = (await this.options.endpoint.transcript()).filter(message => message.seq > previous.messageSeq).map(message => message.messageId);
        for (let offset = 0; offset < fresh.length; offset += 100) feed.publish("chat", fresh.slice(offset, offset + 100));
      }
      if (next.messageSeq < previous.messageSeq || next.issuesRevision !== previous.issuesRevision || next.presence !== previous.presence || next.cli !== previous.cli)
        feed.publish("invalidate", [DIRECTOR_FEED_RESOURCE]);
    });
    this.refreshing = work;
    return work;
  }

  /** Starts the host publisher: store changes publish promptly, and a timer catches presence going stale. Idempotent. */
  start(intervalMs = 1000): void {
    if (this.timer) return;
    void this.refresh().catch(() => undefined);
    this.unsubscribe = this.options.endpoint.subscribe(() => { void this.refresh().catch(() => undefined); });
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}

// --- client side: LocalDirectorServices adapter over an existing host (no store access) ---

const DirectorViewResultSchema = OperationResultSchema(WebDirectorViewSchema);
const DirectorTranscriptResultSchema = OperationResultSchema(WebDirectorTranscriptPageSchema);
const DirectorIssuesResultSchema = OperationResultSchema(WebIssueQueueViewSchema);
const DirectorMessageResultSchema = OperationResultSchema(DirectorMessageSchema);

/** Optional Director port for Local Server composition. Issue retry/dismiss use the existing signed `execute` path. */
export interface LocalDirectorServices {
  readDirector(projectId: string): Promise<OperationResult<WebDirectorView>>;
  listDirectorMessages(projectId: string, cursor?: string): Promise<OperationResult<WebDirectorTranscriptPage>>;
  sendDirectorMessage(input: WebChatSend): Promise<OperationResult<DirectorMessage>>;
  listDirectorIssues(projectId: string, cursor?: string): Promise<OperationResult<WebIssueQueueView>>;
}

const hostUnavailable = <T>(): OperationResult<T> => ({ ok: false, error: { code: "transport_unavailable", retryable: true,
  message: "Agentic host is unavailable; start the session explicitly.", details: { reason: "unavailable" } } });
const scopeRefused = <T>(): OperationResult<T> => ({ ok: false, error: { code: "validation", retryable: false,
  message: "Director method or scope is not supported.", details: { reason: "operation_not_allowed" } } });
/** No connection was made: the host endpoint does not exist or refused the connection, so nothing was written. */
function notConnected(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTDIR") return true;
  return error instanceof Error && (error.message === "Host unavailable" || error.message === "Foreign host configuration");
}

/** Connects to an already running host only; never starts, prepares or writes local Director state. */
export async function openLocalDirectorServices(options: {
  repositoryPath: string;
  sessionId: string;
  /** Owner-registered user-interaction credential; absent → message methods are refused. */
  interaction?: { credential: string };
}): Promise<LocalDirectorServices> {
  const repositoryPath = await realpath(options.repositoryPath);
  const sessionId = IdentifierSchema.parse(options.sessionId);
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.includes("..")) throw new Error("Unsafe host session ID");
  const projectId = interactionProjectId(repositoryPath);
  const host = { repositoryPath, sessionId };
  return {
    async readDirector(id) {
      if (id !== projectId) return scopeRefused();
      try { return DirectorViewResultSchema.parse(await queryAgenticHostInteraction(host, { kind: "director", projectId: id })); }
      catch { return hostUnavailable(); }
    },
    async listDirectorIssues(id, cursor) {
      if (id !== projectId) return scopeRefused();
      try { return DirectorIssuesResultSchema.parse(await queryAgenticHostInteraction(host, { kind: "director_issues", projectId: id, ...(cursor !== undefined ? { cursor } : {}) })); }
      catch { return hostUnavailable(); }
    },
    async listDirectorMessages(id, cursor) {
      if (!options.interaction || id !== projectId) return scopeRefused();
      try {
        return DirectorTranscriptResultSchema.parse(await callUserInteractionHost(host, options.interaction.credential, "interaction_director_history",
          { projectId: id, ...(cursor !== undefined ? { cursor } : {}) }));
      } catch { return hostUnavailable(); }
    },
    async sendDirectorMessage(raw) {
      if (!options.interaction) return scopeRefused();
      let input: WebChatSend;
      try { input = WebChatSendSchema.parse(raw); } catch { return scopeRefused(); }
      if (input.projectId !== projectId) return scopeRefused();
      try {
        return DirectorMessageResultSchema.parse(await callUserInteractionHost(host, options.interaction.credential, "interaction_director_send", input));
      } catch (error) {
        if (notConnected(error)) return { ok: false, error: { code: "transport_unavailable", retryable: true,
          message: "Host chưa chạy; tin chưa được gửi.", details: { reason: "unavailable", messageId: input.messageId } } };
        // Append is idempotent per messageId: after observing the transcript, resending the same ID and content is safe.
        return { ok: false, error: { code: "unknown_delivery", retryable: false, manualInterventionRequired: true,
          message: "Director message acknowledgement unavailable; read the transcript for this message ID before resending the same ID and content.",
          details: { messageId: input.messageId, reason: "reconciliation_required" } } };
      }
    }
  };
}
