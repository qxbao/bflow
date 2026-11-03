import { z } from "zod";
import {
  DIRECTOR_LIMITS,
  DirectorWaitResultSchema,
  JsonValueSchema,
  ParkedIssueStatusSchema,
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
export interface DirectorRuntimeEventsPort {
  /** Returns events after `cursor` ("" = from now). Waits at most timeoutMs when none are available; resolves early on abort. */
  wait(cursor: string, timeoutMs: number, signal: AbortSignal): Promise<{ cursor: string; events: DirectorRuntimeEvent[] }>;
}
export interface DirectorToolsOptions {
  readonly store: DirectorStore;
  readonly coordinator: DirectorCoordinatorPort;
  readonly runtimeEvents?: DirectorRuntimeEventsPort;
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
  { name: "set_issue_status", description: "Mark a queued issue retrying, resolved or dismissed after you acted on it. Arguments: issueId, status." }
];

export const DIRECTOR_TOOLS: readonly { name: string; description: string }[] = [
  ...COORDINATOR_TOOLS.filter(tool => tool.name !== "report_progress"),
  ...DIRECTOR_OWN_TOOLS
];

const COORDINATOR_NAMES: ReadonlySet<string> = new Set(
  COORDINATOR_TOOLS.filter(tool => tool.name !== "report_progress").map(tool => tool.name)
);

const WaitArgs = z.object({ cursor: z.string().optional(), timeoutMs: z.number().finite().positive().optional() }).strict();
const SayArgs = z.object({ text: z.string(), runId: z.string().optional() }).strict();
const NoteArgs = z.object({ text: z.string() }).strict();
const ListArgs = z.object({ status: z.array(ParkedIssueStatusSchema).optional() }).strict();
const InspectArgs = z.object({ issueId: z.string().min(1) }).strict();
const SetStatusArgs = z.object({ issueId: z.string().min(1), status: z.enum(["retrying", "resolved", "dismissed"]) }).strict();

const NOTE_DEDUPE_MS = 10_000;
const HEARTBEAT_SLICE_MS = 60_000;
const CURSOR = /^m(\d+)\.i(\d+)\.r([A-Za-z0-9_-]*)$/;

const json = (value: unknown): JsonValue => JsonValueSchema.parse(value);

export class DirectorTools {
  private readonly store: DirectorStore;
  private readonly coordinator: DirectorCoordinatorPort;
  private readonly runtimeEvents: DirectorRuntimeEventsPort | undefined;
  private readonly maxWaitMs: number;
  private readonly now: () => Date;

  constructor(options: DirectorToolsOptions) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.runtimeEvents = options.runtimeEvents;
    this.maxWaitMs = Math.min(Math.max(options.maxWaitMs ?? DIRECTOR_LIMITS.waitDefaultMs, DIRECTOR_LIMITS.waitMinMs), DIRECTOR_LIMITS.waitMaxMs);
    this.now = options.now ?? (() => new Date());
  }

  async invoke(name: string, input: unknown, token: string): Promise<JsonValue> {
    await this.store.authenticate(token);
    if (name !== "director_wait") await this.store.heartbeat(token, false);
    switch (name) {
      case "director_wait":
        return this.wait(WaitArgs.parse(input ?? {}), token);
      case "director_say": {
        const args = SayArgs.parse(input);
        const message = await this.store.appendMessage({ author: "director", channel: "cli", text: args.text, ...(args.runId !== undefined ? { runId: args.runId } : {}) });
        return json({ seq: message.seq, messageId: message.messageId });
      }
      case "director_note_user_message":
        return this.noteUserMessage(NoteArgs.parse(input));
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
      default:
        if (COORDINATOR_NAMES.has(name)) return json(await this.coordinator.invoke(name, input));
        throw new Error(`Unknown Director tool: ${name}`);
    }
  }

  private async noteUserMessage(args: z.infer<typeof NoteArgs>): Promise<JsonValue> {
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

  private async wait(args: z.infer<typeof WaitArgs>, token: string): Promise<JsonValue> {
    const start = await this.store.version();
    let seq = 0;
    let revision = start.issuesRevision;
    let runtimeCursor = "";
    if (args.cursor !== undefined) {
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
        const remaining = deadline - Date.now();
        if (messages.length > 0 || issues.length > 0 || runtimeEvents.length > 0 || remaining <= 0) {
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
        const since = { messageSeq: version.messageSeq, issuesRevision: version.issuesRevision };
        const storeWake = this.store.waitForChange(since, slice, controller.signal);
        const runtimeWake = this.runtimeEvents?.wait(runtimeCursor, slice, controller.signal);
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
          controller.abort();
        }
        const [, runtimeResult] = await Promise.all([storeWake, runtimeWake]);
        if (runtimeResult) {
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
