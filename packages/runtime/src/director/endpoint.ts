import * as path from "node:path";
import {
  DIRECTOR_LIMITS,
  type AgentProviderId,
  type DirectorProgressSnapshot,
  type DirectorRuntimeEvent,
  type DirectorSession,
  type JsonValue,
  type ParkedIssue,
  type ParkedIssueStatus
} from "@bflow/contracts";
import { buildDirectorProgressSnapshot } from "./snapshot.js";
import { DirectorStore } from "./store.js";
import { DirectorTools, type DirectorCoordinatorPort, type DirectorRuntimeEventsPort, type DirectorWorkPort } from "./tools.js";

export interface DirectorFeedPort {
  /** Same contract as ProjectionFeed.read (packages/runtime/src/interaction/events.ts): non-blocking page after cursor. */
  read(cursor?: string): { items: readonly { cursor: string; type: string; resourceIds: readonly string[] }[] };
}
export interface DirectorEndpointOptions {
  readonly directory: string;
  readonly repositoryRoot: string;
  readonly coordinator: DirectorCoordinatorPort;
  readonly work?: DirectorWorkPort;
  readonly feed: DirectorFeedPort;
  readonly inspect: () => Promise<unknown>;
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
          const events: DirectorRuntimeEvent[] = items.map(item => ({ type: `projection.${item.type}`, summary: summarize(item) }));
          return { cursor: items[items.length - 1]!.cursor, events };
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

  constructor(options: DirectorEndpointOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.store = new DirectorStore({ directory: path.resolve(options.directory), now: this.now });
    this.tools = new DirectorTools({
      store: this.store,
      coordinator: options.coordinator,
      ...(options.work ? { work: options.work } : {}),
      runtimeEvents: feedEvents(options.feed, options.pollMs ?? 1000),
      ...(options.maxWaitMs !== undefined ? { maxWaitMs: options.maxWaitMs } : {}),
      now: this.now
    });
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

  listIssues(status?: readonly ParkedIssueStatus[]): Promise<ParkedIssue[]> {
    return this.store.listIssues(status ? { status } : undefined);
  }

  async inspectIssue(issueId: string): Promise<ParkedIssue> {
    const issue = (await this.store.listIssues()).find(candidate => candidate.issueId === issueId);
    if (!issue) throw new Error(`Unknown director issue ${issueId}`);
    return issue;
  }

  setIssueStatus(issueId: string, status: "retrying" | "resolved" | "dismissed"): Promise<ParkedIssue> {
    return this.store.setIssueStatus(issueId, status);
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
