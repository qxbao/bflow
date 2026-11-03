import { z } from "zod";
import {
  DIRECTOR_LIMITS,
  DirectorWaitResultSchema,
  JsonValueSchema,
  ParkedIssueStatusSchema,
  SddPolicyLevelSchema,
  type DirectorMessage,
  type DirectorRuntimeEvent,
  type JsonValue,
  type ParkedIssue
} from "@bflow/contracts";
import { COORDINATOR_TOOLS } from "../agentic/tools.js";
import type { DirectorStore } from "./store.js";

export interface DirectorCoordinatorPort {
  invoke(name: string, input: unknown): Promise<JsonValue>;
}
export interface DirectorWorkStart {
  /** director:<tokenId>:<userMessageSeq>; the host derives every id of the delegation from it. */
  readonly key: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: readonly { description: string; verificationMethod: AcceptanceCriterionVerificationMethod }[];
  readonly sddLevel: "lightweight" | "full";
  readonly priority: "low" | "normal" | "high" | "critical";
  /** Timestamp of the user message that authorized the work, so a replay builds the identical delegation. */
  readonly requestedAt: string;
}
type AcceptanceCriterionVerificationMethod = "unit_test" | "integration_test" | "e2e_test" | "typecheck" | "lint" | "static_analysis" | "manual_review";
/** Hands a new run to the same delegation path Conversation uses. Throws with a redacted reason on admission refusal. */
export interface DirectorWorkPort {
  start(input: DirectorWorkStart): Promise<JsonValue>;
}
export interface DirectorRuntimeEventsPort {
  /** Returns at most `limit` events after `cursor` ("" = from now). Waits at most timeoutMs when none are available; resolves early on abort. */
  wait(cursor: string, timeoutMs: number, signal: AbortSignal, limit: number): Promise<{ cursor: string; events: DirectorRuntimeEvent[] }>;
}
export interface DirectorToolsOptions {
  readonly store: DirectorStore;
  readonly coordinator: DirectorCoordinatorPort;
  readonly runtimeEvents?: DirectorRuntimeEventsPort;
  readonly work?: DirectorWorkPort;
  /** Provider-specific upper bound; clamped to [DIRECTOR_LIMITS.waitMinMs, DIRECTOR_LIMITS.waitMaxMs]. Default DIRECTOR_LIMITS.waitDefaultMs. */
  readonly maxWaitMs?: number;
  readonly now?: () => Date;
}

export const DIRECTOR_OWN_TOOLS: readonly { name: string; description: string }[] = [
  { name: "director_wait", description: "Wait for new user messages (CLI or Web), issue-queue changes or Runtime events. Arguments: cursor (from the previous result; omit on first call), timeoutMs (optional). Returns immediately when something is pending; call it again with the returned cursor." },
  { name: "director_say", description: "Send a message to the user. It is shown in the Web chat and stored in the shared transcript. Arguments: text, runId (optional)." },
  { name: "director_note_user_message", description: "Record a message the user typed in this CLI when no hook recorded it. Arguments: text." },
  { name: "list_issues", description: "List the issue queue. Arguments: status (optional array of open|retrying|resolved|dismissed; default open and retrying)." },
  { name: "inspect_issue", description: "Read one queued issue with its evidence references. Arguments: issueId." },
  { name: "set_issue_status", description: "Mark a queued issue retrying, resolved or dismissed after you acted on it. Arguments: issueId, status." },
  { name: "start_work", description: "Create a new run through the same delegation path Conversation uses. In slice B1 the Coordinator pane receives the delegation and decomposes it; you monitor and steer it with the other tools. Clarify acceptance criteria with the user first. Arguments: title, objective, acceptanceCriteria (array of {description, verificationMethod: unit_test|integration_test|e2e_test|typecheck|lint|static_analysis|manual_review}, at least one), sddLevel (lightweight|full), priority (optional low|normal|high|critical, default normal), userMessageSeq (seq of the user message that asked for this work; it must be a real user message in the transcript). Calling again with the same userMessageSeq returns the same runId and creates no second run. Returns {runId, correlationId, status: queued}." }
];

/** Host-served planning guidance; needs no pane binding. Shared with the Coordinator implementation in the host. */
export const DIRECTOR_HOST_TOOLS: readonly { name: string; description: string }[] = [
  { name: "planning_reference", description: "Read canonical shipped examples and exact metadata/contract definitions before planning or propose_workflow. Arguments: section (specification | test_strategy | workflow | all), view (optional: full | compact | schema_only), includeRunners (optional boolean)." }
];

export const DIRECTOR_TOOLS: readonly { name: string; description: string }[] = [
  ...COORDINATOR_TOOLS.filter(tool => tool.name !== "report_progress"),
  ...DIRECTOR_HOST_TOOLS,
  ...DIRECTOR_OWN_TOOLS
];

const COORDINATOR_NAMES: ReadonlySet<string> = new Set([
  ...COORDINATOR_TOOLS.filter(tool => tool.name !== "report_progress").map(tool => tool.name),
  ...DIRECTOR_HOST_TOOLS.map(tool => tool.name)
]);

const WaitArgs = z.object({ cursor: z.string().optional(), timeoutMs: z.number().finite().positive().optional() }).strict();
const SayArgs = z.object({ text: z.string(), runId: z.string().optional() }).strict();
const NoteArgs = z.object({ text: z.string() }).strict();
const ListArgs = z.object({ status: z.array(ParkedIssueStatusSchema).optional() }).strict();
const InspectArgs = z.object({ issueId: z.string().min(1) }).strict();
const SetStatusArgs = z.object({ issueId: z.string().min(1), status: z.enum(["retrying", "resolved", "dismissed"]) }).strict();

const ACCEPTANCE_METHODS = ["unit_test", "integration_test", "e2e_test", "typecheck", "lint", "static_analysis", "manual_review"] as const;
const StartWorkArgs = z.object({
  title: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.object({ description: z.string().trim().min(1), verificationMethod: z.enum(ACCEPTANCE_METHODS) }).strict()).min(1),
  sddLevel: SddPolicyLevelSchema,
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  userMessageSeq: z.number().int().positive()
}).strict();

const NOTE_DEDUPE_MS = 10_000;
const HEARTBEAT_SLICE_MS = 60_000;
const RUNTIME_EVENTS_LIMIT = 200;
const CURSOR = /^m(\d+)\.i(\d+)\.r([A-Za-z0-9_-]*)$/;

const json = (value: unknown): JsonValue => JsonValueSchema.parse(value);

export class DirectorTools {
  private readonly store: DirectorStore;
  private readonly coordinator: DirectorCoordinatorPort;
  private readonly runtimeEvents: DirectorRuntimeEventsPort | undefined;
  private readonly work: DirectorWorkPort | undefined;
  /** Replays of a started key answer from here; the host's own outbox dedupe covers a restart. */
  private readonly started = new Map<string, JsonValue>();
  private readonly maxWaitMs: number;
  private readonly now: () => Date;

  constructor(options: DirectorToolsOptions) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.runtimeEvents = options.runtimeEvents;
    this.work = options.work;
    this.maxWaitMs = Math.min(Math.max(options.maxWaitMs ?? DIRECTOR_LIMITS.waitDefaultMs, DIRECTOR_LIMITS.waitMinMs), DIRECTOR_LIMITS.waitMaxMs);
    this.now = options.now ?? (() => new Date());
  }

  async invoke(name: string, input: unknown, token: string, signal?: AbortSignal): Promise<JsonValue> {
    const session = await this.store.authenticate(token);
    if (name !== "director_wait") await this.store.heartbeat(token, false);
    switch (name) {
      case "director_wait":
        return this.wait(WaitArgs.parse(input ?? {}), token, signal);
      case "director_say": {
        const args = SayArgs.parse(input);
        const message = await this.store.appendMessage({ author: "director", channel: "cli", text: args.text, ...(args.runId !== undefined ? { runId: args.runId } : {}) });
        return json({ seq: message.seq, messageId: message.messageId });
      }
      case "director_note_user_message":
        return this.noteUserMessage(NoteArgs.parse(input).text);
      case "list_issues": {
        const args = ListArgs.parse(input ?? {});
        return json(await this.store.listIssues({ status: args.status ?? ["open", "retrying"] }));
      }
      case "inspect_issue": {
        const args = InspectArgs.parse(input);
        const issue = (await this.store.listIssues()).find(candidate => candidate.issueId === args.issueId);
        if (!issue) throw new Error(`Unknown director issue ${args.issueId}`);
        return json(issue);
      }
      case "set_issue_status": {
        const args = SetStatusArgs.parse(input);
        return json(await this.store.setIssueStatus(args.issueId, args.status));
      }
      case "start_work":
        return this.startWork(StartWorkArgs.parse(input), session.tokenId);
      default:
        if (COORDINATOR_NAMES.has(name)) return json(await this.coordinator.invoke(name, input));
        throw new Error(`Unknown Director tool: ${name}`);
    }
  }

  private async startWork(args: z.infer<typeof StartWorkArgs>, tokenId: string): Promise<JsonValue> {
    if (!this.work) throw new Error("start_work is unavailable: the host has no delegation path");
    const evidence = (await this.store.readMessages({ afterSeq: args.userMessageSeq - 1, limit: 1 }))[0];
    if (!evidence || evidence.seq !== args.userMessageSeq) throw new Error(`userMessageSeq ${args.userMessageSeq} does not exist in the Director transcript`);
    if (evidence.author !== "user") throw new Error(`userMessageSeq ${args.userMessageSeq} is not a user message; start_work needs the user's own message as evidence of intent`);
    const key = `director:${tokenId}:${args.userMessageSeq}`;
    const known = this.started.get(key);
    if (known !== undefined) return known;
    const result = json(await this.work.start({
      key,
      title: args.title,
      objective: args.objective,
      acceptanceCriteria: args.acceptanceCriteria,
      sddLevel: args.sddLevel,
      priority: args.priority,
      requestedAt: evidence.at
    }));
    this.started.set(key, result);
    return result;
  }

  /** Records a user message typed in the CLI (channel cli) unless the same text was recorded within 10 s. Caller authenticates. */
  async noteUserMessage(text: string): Promise<{ recorded: boolean; duplicate?: true; seq?: number }> {
    const args = { text };
    const messages = await this.store.readMessages({ afterSeq: 0 });
    // readMessages is paged; walk to the tail so the last user message is the true last one.
    let tail = messages;
    while (tail.length >= DIRECTOR_LIMITS.transcriptPage) {
      const next = await this.store.readMessages({ afterSeq: tail[tail.length - 1]!.seq });
      if (next.length === 0) break;
      tail = next;
    }
    const lastUser = [...tail].reverse().find(message => message.author === "user") ??
      [...messages].reverse().find(message => message.author === "user");
    if (
      lastUser && lastUser.channel === "cli" && lastUser.text.trim() === args.text.trim() &&
      Math.abs(this.now().getTime() - Date.parse(lastUser.at)) <= NOTE_DEDUPE_MS
    ) {
      return { recorded: false, duplicate: true };
    }
    const message = await this.store.appendMessage({ author: "user", channel: "cli", text: args.text });
    return { recorded: true, seq: message.seq };
  }

  private async wait(args: z.infer<typeof WaitArgs>, token: string, signal?: AbortSignal): Promise<JsonValue> {
    const start = await this.store.version();
    // An empty cursor (the first wait after `director start`) means "from now"; an omitted cursor reads the whole transcript.
    let seq = args.cursor === "" ? start.messageSeq : 0;
    let revision = start.issuesRevision;
    let runtimeCursor = "";
    if (args.cursor !== undefined && args.cursor !== "") {
      const match = CURSOR.exec(args.cursor);
      if (!match) throw new Error("Invalid director cursor");
      seq = Number(match[1]);
      revision = Number(match[2]);
      runtimeCursor = Buffer.from(match[3]!, "base64url").toString("utf8");
    }
    const requested = args.timeoutMs ?? this.maxWaitMs;
    const timeoutMs = Math.min(Math.max(requested, DIRECTOR_LIMITS.waitMinMs), this.maxWaitMs);
    const deadline = Date.now() + timeoutMs;
    const runtimeEvents: DirectorRuntimeEvent[] = [];

    await this.store.heartbeat(token, true);
    try {
      for (;;) {
        // Collect always re-reads the store; wake events carry no payload.
        const version = await this.store.version();
        const fresh = await this.store.readMessages({ afterSeq: seq });
        for (const message of fresh) seq = Math.max(seq, message.seq);
        const messages: DirectorMessage[] = fresh.filter(message => message.author === "user");
        let issues: ParkedIssue[] = [];
        if (version.issuesRevision !== revision) {
          issues = await this.store.listIssues({ status: ["open", "retrying"] });
          revision = version.issuesRevision;
        }
        // A full page without a user message means more transcript is already waiting: read on without blocking.
        if (fresh.length >= DIRECTOR_LIMITS.transcriptPage && messages.length === 0 && issues.length === 0 && runtimeEvents.length === 0) continue;
        const remaining = deadline - Date.now();
        if (messages.length > 0 || issues.length > 0 || runtimeEvents.length > 0 || remaining <= 0 || signal?.aborted) {
          const timedOut = messages.length === 0 && issues.length === 0 && runtimeEvents.length === 0;
          return json(DirectorWaitResultSchema.parse({
            cursor: `m${seq}.i${revision}.r${Buffer.from(runtimeCursor, "utf8").toString("base64url")}`,
            timedOut,
            messages,
            issues,
            runtimeEvents
          }));
        }

        const slice = Math.min(remaining, HEARTBEAT_SLICE_MS);
        const controller = new AbortController();
        const onClientAbort = (): void => controller.abort();
        signal?.addEventListener("abort", onClientAbort, { once: true });
        const since = { messageSeq: version.messageSeq, issuesRevision: version.issuesRevision };
        const storeWake = this.store.waitForChange(since, slice, controller.signal);
        const runtimeWake = this.runtimeEvents?.wait(runtimeCursor, slice, controller.signal, RUNTIME_EVENTS_LIMIT);
        try {
          if (runtimeWake) {
            await Promise.race([
              storeWake,
              runtimeWake.then(result => (result.events.length > 0 ? true : storeWake))
            ]);
          } else {
            await storeWake;
          }
        } finally {
          signal?.removeEventListener("abort", onClientAbort);
          controller.abort();
        }
        const [, runtimeResult] = await Promise.all([storeWake, runtimeWake]);
        if (runtimeResult) {
          if (runtimeResult.events.length > RUNTIME_EVENTS_LIMIT) {
            throw new Error(`Runtime events port returned more than ${RUNTIME_EVENTS_LIMIT} events`);
          }
          runtimeCursor = runtimeResult.cursor;
          runtimeEvents.push(...runtimeResult.events);
        }
        await this.store.heartbeat(token, true);
      }
    } finally {
      await this.store.heartbeat(token, false);
    }
  }
}
