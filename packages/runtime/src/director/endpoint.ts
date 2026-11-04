import * as path from "node:path";
import {
  DIRECTOR_LIMITS,
  type AgentProviderId,
  AgentRoleSchema,
  IdentifierSchema,
  type DirectorMailboxItem,
  type DirectorPresence,
  type DirectorProgressSnapshot,
  type DirectorRuntimeEvent,
  type DirectorSession,
  type JsonValue,
  type ParkedIssue,
  type ParkedIssueStatus,
  type RoleMessage
} from "@bflow/contracts";
import { redactString } from "../resilience/redaction.js";
import { buildDirectorProgressSnapshot } from "./snapshot.js";
import { DirectorStore, type DirectorMessageInput, type DirectorVersion } from "./store.js";
import { DirectorTools, type DirectorCoordinatorPort, type DirectorIssueGuard, type DirectorIssueObservation, type DirectorParkEpisode, type DirectorRuntimeEventsPort,
  type DirectorTaskParkObservation, type DirectorTaskParkPort, type DirectorWorkPort } from "./tools.js";
import type { DirectorMessage } from "@bflow/contracts";

export interface DirectorFeedPort {
  /** Same contract as ProjectionFeed.read (packages/runtime/src/interaction/events.ts): non-blocking page after cursor. */
  read(cursor?: string): { items: readonly { cursor: string; type: string; resourceIds: readonly string[] }[] };
}
export interface DirectorEndpointOptions {
  readonly directory: string;
  readonly repositoryRoot: string;
  readonly coordinator: DirectorCoordinatorPort;
  readonly work?: DirectorWorkPort;
  readonly coordinatorGuide?: () => Promise<{ source: string; prompt: string; framing?: "director" | "coordinator_v2" }>;
  readonly feed: DirectorFeedPort;
  readonly inspect: () => Promise<unknown>;
  /** Read-only Runtime run document (journal RunRecord shape); enables park-episode checks for issue retries. */
  readonly inspectRun?: (runId: string) => Promise<unknown>;
  readonly maxWaitMs?: number;
  readonly pollMs?: number;
  readonly now?: () => Date;
}

const START_CANDIDATE_TTL_MS = 5 * 60_000;
const START_PROMPT = /^[/$]bflow-start(?:\s|$)/;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{16,256}$/;

function summarize(item: { type: string; resourceIds: readonly string[] }): string {
  const ids = item.resourceIds.slice(0, 5).join(", ");
  return `${item.type}: ${ids}`.slice(0, DIRECTOR_LIMITS.issueTextMax);
}

/**
 * Feed items the host publishes for Director store changes (`chat`, and `invalidate` scoped to `director`). They are Web refresh
 * signals for the Director's own transcript/presence/issues and must not wake director_wait as Runtime events: a director_say
 * or a presence flip would otherwise wake the Director with its own change (self-wake loop).
 */
export function isDirectorRefreshItem(item: { type: string; resourceIds: readonly string[] }): boolean {
  return item.type === "chat" || (item.type === "invalidate" && item.resourceIds.length > 0 && item.resourceIds.every(id => id === DIRECTOR_FEED_RESOURCE));
}
export const DIRECTOR_FEED_RESOURCE = "director";

function parkEpisode(value: unknown): DirectorParkEpisode | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const valid = typeof entry.episode === "number" && Number.isSafeInteger(entry.episode) && entry.episode > 0;
  if (!valid || (entry.source !== "director" && entry.source !== "auto")) return undefined;
  return { episode: entry.episode as number, source: entry.source, ...(typeof entry.episodeKey === "string" && entry.episodeKey.length > 0 ? { episodeKey: entry.episodeKey } : {}) };
}
/** Park observation from a Runtime run document; malformed entries are ignored (never treated as a match). */
export function observeTaskPark(run: unknown, runId: string, taskId: string): DirectorTaskParkObservation | undefined {
  if (typeof run !== "object" || run === null || Array.isArray(run)) return undefined;
  const record = run as Record<string, unknown>;
  if (record.runId !== runId || !Array.isArray(record.tasks)) return undefined;
  const task = record.tasks.find(item => typeof item === "object" && item !== null && (item as Record<string, unknown>).taskId === taskId) as Record<string, unknown> | undefined;
  if (!task) return undefined;
  const current = parkEpisode(task.parked);
  const history = Array.isArray(task.parkHistory) ? task.parkHistory.map(parkEpisode).filter((item): item is DirectorParkEpisode => item !== undefined) : [];
  return { ...(current ? { current } : {}), history };
}

/** Runtime events port over a ProjectionFeed-like feed. Polls; never blocks beyond timeoutMs and always clears its timer. */
function feedEvents(feed: DirectorFeedPort, pollMs: number): DirectorRuntimeEventsPort {
  return {
    async wait(cursor, timeoutMs, signal, limit) {
      if (cursor === "") {
        const items = feed.read(undefined).items;
        const last = items[items.length - 1];
        return { cursor: last ? last.cursor : "", events: [] };
      }
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (signal.aborted) return { cursor, events: [] };
        const items = feed.read(cursor).items.slice(0, Math.max(0, limit));
        if (items.length > 0) {
          cursor = items[items.length - 1]!.cursor;
          const events: DirectorRuntimeEvent[] = items.filter(item => !isDirectorRefreshItem(item))
            .map(item => ({ type: `projection.${item.type}`, summary: summarize(item) }));
          if (events.length > 0) return { cursor, events };
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { cursor, events: [] };
        await new Promise<void>(resolve => {
          const onAbort = (): void => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, Math.min(pollMs, remaining));
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    }
  };
}

/** Host-independent Director composition: one store, the tool surface, and the read-side helpers the host and CLI need. */
export class DirectorEndpoint {
  private readonly store: DirectorStore;
  private readonly tools: DirectorTools;
  private readonly options: DirectorEndpointOptions;
  private readonly now: () => Date;
  /** In-memory only: a restarted host forgets the binding and the Director must run `director start` again. */
  private candidate: { provider: AgentProviderId; sessionId: string; at: number } | undefined;
  private bound: { provider: AgentProviderId; sessionId: string } | undefined;
  private readonly taskPark: DirectorTaskParkPort | undefined;

  constructor(options: DirectorEndpointOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.store = new DirectorStore({ directory: path.resolve(options.directory), now: this.now });
    const inspectRun = options.inspectRun;
    this.taskPark = inspectRun ? async (runId, taskId) => observeTaskPark(await inspectRun(runId), runId, taskId) : undefined;
    this.tools = new DirectorTools({
      store: this.store,
      coordinator: options.coordinator,
      ...(options.work ? { work: options.work } : {}),
      ...(options.coordinatorGuide ? { coordinatorGuide: options.coordinatorGuide } : {}),
      runtimeEvents: feedEvents(options.feed, options.pollMs ?? 1000),
      ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
      ...(this.taskPark ? { taskPark: this.taskPark } : {}),
      now: this.now
    });
  }

  /** Runtime outbox delivery for the logical Coordinator (R-B2-5). Idempotent per message_id; stores a redacted summary only. */
  async deliverRuntimeMessage(message: RoleMessage): Promise<void> {
    await this.store.appendMailbox(this.mailboxInput(message, "director"));
  }

  /** Copy of a human-facing Conversation notice for the user audience (R-B2-6). */
  async mirrorUserNotice(message: RoleMessage, rendered: { text: string; code?: string }): Promise<void> {
    const text = redactString(rendered.text).slice(0, 4000);
    const code = rendered.code !== undefined && /^#[1-9]\d*$/.test(rendered.code) ? rendered.code : undefined;
    await this.store.appendMailbox({
      ...this.mailboxInput(message, "user"),
      ...(text.trim().length > 0 ? { text } : {}),
      ...(code !== undefined ? { code } : {})
    });
  }

  readMailbox(query: { afterSeq?: number | undefined; audience?: "director" | "user" | undefined; limit?: number | undefined }): Promise<DirectorMailboxItem[]> {
    return this.store.readMailbox({
      afterSeq: query.afterSeq ?? 0,
      ...(query.audience !== undefined ? { audience: query.audience } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {})
    });
  }

  private mailboxInput(message: RoleMessage, audience: "director" | "user"): Omit<DirectorMailboxItem, "schemaVersion" | "seq" | "text" | "code"> {
    const payload = typeof message.payload === "object" && message.payload !== null && !Array.isArray(message.payload) ? message.payload : {};
    const senderRole = message.sender.role;
    const parsedRole = AgentRoleSchema.safeParse(senderRole);
    const fromRole = senderRole === "runtime" || senderRole === "user" || senderRole === "conversation" || !parsedRole.success ? "runtime" : parsedRole.data;
    const kind = typeof payload.kind === "string" && IdentifierSchema.safeParse(payload.kind).success ? payload.kind.trim() : undefined;
    const taskIdRaw = payload.taskId;
    const taskId = typeof taskIdRaw === "string" && IdentifierSchema.safeParse(taskIdRaw).success ? taskIdRaw.trim() : undefined;
    const detail = ["headline", "summary", "reason", "status"].map(key => payload[key]).find((value): value is string => typeof value === "string" && value.trim().length > 0);
    const raw = `${message.type}${kind ? `/${kind}` : ""} từ ${fromRole}${detail ? `: ${detail}` : ""}`;
    const summary = redactString(raw).replace(/\s+/g, " ").trim().slice(0, DIRECTOR_LIMITS.issueTextMax) || message.type;
    return {
      messageId: message.message_id,
      at: this.now().toISOString(),
      audience,
      ...(message.run_id !== undefined ? { runId: message.run_id } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      type: message.type,
      ...(kind !== undefined ? { kind } : {}),
      fromRole,
      summary
    };
  }

  /** Director presence (`active`, `waiting`, `absent`); gates automatic resume of Director runs (R-B2-12). */
  async presence(): Promise<DirectorPresence> {
    return (await this.store.presence()).presence;
  }

  static isDirectorToken(token: string): boolean {
    return TOKEN_SHAPE.test(token);
  }

  async register(input: { provider: AgentProviderId }): Promise<{ token: string; session: DirectorSession; cursor: string }> {
    const result = await this.store.register({ provider: input.provider, repositoryRoot: this.options.repositoryRoot });
    const candidate = this.candidate;
    this.candidate = undefined;
    this.bound = candidate && candidate.provider === input.provider && this.now().getTime() - candidate.at <= START_CANDIDATE_TTL_MS
      ? { provider: candidate.provider, sessionId: candidate.sessionId }
      : undefined;
    return { ...result, cursor: await this.tools.startCursor() };
  }

  revoke(): Promise<void> {
    return this.store.revoke();
  }

  call(token: string, name: string, args: unknown, signal?: AbortSignal): Promise<JsonValue> {
    return this.tools.invoke(name, args, token, signal);
  }

  async noteHookPrompt(input: { provider: AgentProviderId; prompt: string; sessionId?: string | undefined }): Promise<{ recorded: boolean }> {
    const prompt = input.prompt.trim();
    if (START_PROMPT.test(prompt) || prompt === "bflow-start") {
      // The start prompt only identifies the Director's provider session; it is never part of the transcript.
      if (input.sessionId) this.candidate = { provider: input.provider, sessionId: input.sessionId, at: this.now().getTime() };
      return { recorded: false };
    }
    if ((await this.store.presence()).presence === "absent") return { recorded: false };
    if (!this.bound || !input.sessionId || this.bound.provider !== input.provider || this.bound.sessionId !== input.sessionId) return { recorded: false };
    const result = await this.tools.noteUserMessage(input.prompt);
    return { recorded: result.recorded };
  }

  upsertIssue(input: import("./store.js").IssueInput): Promise<ParkedIssue> { return this.store.upsertIssue(input); }

  listIssues(status?: readonly ParkedIssueStatus[]): Promise<ParkedIssue[]> {
    return this.store.listIssues(status ? { status } : undefined);
  }

  async inspectIssue(issueId: string): Promise<ParkedIssue> {
    const issue = (await this.store.listIssues()).find(candidate => candidate.issueId === issueId);
    if (!issue) throw new Error(`Unknown director issue ${issueId}`);
    return issue;
  }

  setIssueStatus(issueId: string, status: "retrying" | "resolved" | "dismissed", guard?: DirectorIssueGuard,
    options?: { recordOnly?: boolean }): Promise<ParkedIssue> {
    return this.tools.setIssueStatus(issueId, status, guard, options);
  }

  /** Read-only validation of a status change (same serial step and park-episode rule as setIssueStatus). */
  checkIssueStatus(issueId: string, status: "retrying" | "resolved" | "dismissed", guard?: DirectorIssueGuard): Promise<ParkedIssue> {
    return this.tools.checkIssueStatus(issueId, status, guard);
  }

  /** Observation inside the issue serial step (reconciliation of an uncertain issue command). */
  observeIssues<T>(work: (observe: DirectorIssueObservation) => Promise<T>): Promise<T> {
    return this.tools.observeIssues(work);
  }

  /**
   * The only Web write: a user message on the web channel with the browser's stable messageId. Idempotent per messageId
   * (DirectorMessageConflictError on a different payload). The host is the single writer; callers check readiness first.
   */
  appendWebMessage(input: { messageId: string; text: string; runId?: string | undefined }): Promise<DirectorMessage> {
    const message: DirectorMessageInput = { messageId: input.messageId, author: "user", channel: "web", text: input.text,
      ...(input.runId !== undefined ? { runId: input.runId } : {}) };
    return this.store.appendMessage(message);
  }

  /** Whole transcript, read-only (never acknowledges delivery, never heartbeats). */
  transcript(): Promise<DirectorMessage[]> { return this.store.allMessages(); }

  version(): Promise<DirectorVersion> { return this.store.version(); }

  /** Presence with waitingSince, computed with the endpoint clock at read time; no session/token/path leaves this method. */
  async presenceDetail(): Promise<{ presence: DirectorPresence; provider?: AgentProviderId; heartbeatAt?: string; waitingSince?: string; registered: boolean }> {
    const { presence, session } = await this.store.presence();
    return {
      presence,
      registered: session !== null,
      ...(session ? { provider: session.provider, heartbeatAt: session.heartbeatAt } : {}),
      ...(session && presence === "waiting" && session.waitingSince !== null ? { waitingSince: session.waitingSince } : {})
    };
  }

  /**
   * Conservative: true unless this host process verified the Director's provider session through the start hook. The binding
   * is in-memory only, so a host restart (or a start without hook) reports possibly-missing CLI messages.
   */
  cliCaptureMayBeIncomplete(): boolean { return this.bound === undefined; }

  /** In-process store change notification for the host feed publisher. */
  subscribe(listener: () => void): () => void { return this.store.subscribe(listener); }

  /** Progress snapshot over an explicit Runtime state (the Web view passes an empty state while the host is not ready). */
  async progressFrom(state: unknown): Promise<DirectorProgressSnapshot> {
    const { presence, session } = await this.store.presence();
    return buildDirectorProgressSnapshot({ state, presence, session, issues: await this.store.listIssues({ status: ["open", "retrying"] }), now: this.now() });
  }

  async progress(): Promise<DirectorProgressSnapshot> {
    const { presence, session } = await this.store.presence();
    return buildDirectorProgressSnapshot({
      state: await this.options.inspect(),
      presence,
      session,
      issues: await this.store.listIssues({ status: ["open", "retrying"] }),
      now: this.now()
    });
  }
}
