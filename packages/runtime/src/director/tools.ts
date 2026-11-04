import { z } from "zod";
import {
  DIRECTOR_LIMITS,
  DirectorWaitResultSchema,
  JsonValueSchema,
  ParkedIssueStatusSchema,
  IdentifierSchema,
  AcceptanceCriterionSchema,
  DelegationRequestSchema,
  SddPolicyLevelSchema,
  WebRequestKindSchema,
  type DirectorMailboxItem,
  type DirectorMessage,
  type DirectorRuntimeEvent,
  type JsonValue,
  type ParkedIssue
} from "@bflow/contracts";
import { COORDINATOR_TOOLS } from "../agentic/tools.js";
import { directorIssueIdForKey, type DirectorStore } from "./store.js";

export interface DirectorCoordinatorPort {
  invoke(name: string, input: unknown): Promise<JsonValue>;
}
export interface DirectorWorkStart {
  /** director:<messageId of the user message>; the host derives every id of the delegation from it. */
  readonly key: string;
  readonly title: string;
  readonly objective: string;
  readonly kind: z.infer<typeof WebRequestKindSchema>;
  readonly acceptanceCriteria: readonly { description: string; verificationMethod: AcceptanceCriterionVerificationMethod }[];
  readonly sddLevel: z.infer<typeof SddPolicyLevelSchema>;
  readonly priority: z.infer<typeof DelegationRequestSchema>["priority"];
  /** Timestamp of the user message that authorized the work, so a replay builds the identical delegation. */
  readonly requestedAt: string;
  /** Native family for this run; the host validates it against the session pack. */
  readonly nativeFamily?: "implementation" | "analysis" | "qa";
}
type AcceptanceCriterionVerificationMethod = z.infer<typeof AcceptanceCriterionSchema>["verificationMethod"];
/** Hands a new run to the same delegation path Conversation uses. Throws with a redacted reason on admission refusal. */
export interface DirectorWorkPort {
  start(input: DirectorWorkStart): Promise<JsonValue>;
}
export interface DirectorRuntimeEventsPort {
  /** Returns at most `limit` events after `cursor` ("" = from now). Waits at most timeoutMs when none are available; resolves early on abort. */
  wait(cursor: string, timeoutMs: number, signal: AbortSignal, limit: number): Promise<{ cursor: string; events: DirectorRuntimeEvent[] }>;
}
/** One park episode of a task as Runtime recorded it (journal TaskPark). */
export interface DirectorParkEpisode {
  readonly episode: number;
  readonly source: "director" | "auto";
  readonly episodeKey?: string;
}
/** Read-only observation of a task's current park and park history. */
export interface DirectorTaskParkObservation {
  readonly current?: DirectorParkEpisode;
  readonly history: readonly DirectorParkEpisode[];
}
/** Returns undefined when the run or task is unknown to Runtime. Never mutates. */
export type DirectorTaskParkPort = (runId: string, taskId: string) => Promise<DirectorTaskParkObservation | undefined>;
/** Issue IDs a park episode can have: `park_task` uses the explicit ID, auto-park and its replay use the hashed key. */
export function parkEpisodeIssueIds(runId: string, taskId: string, park: DirectorParkEpisode): string[] {
  return [`park:${runId}:${taskId}:${park.episode}`, directorIssueIdForKey(`park:${park.episodeKey ?? `${runId}:${taskId}:${park.episode}`}`)];
}
export type DirectorIssueRefusalReason = "not_found" | "forbidden" | "stale_version" | "operation_not_allowed";
/** Refused before any Runtime effect. */
export class DirectorIssueRefusal extends Error {
  constructor(readonly reason: DirectorIssueRefusalReason, message: string) { super(message); this.name = "DirectorIssueRefusal"; }
}
export type DirectorIssueGuard = (issue: ParkedIssue) => void;
export interface DirectorIssueObservation {
  issue(issueId: string): Promise<ParkedIssue | undefined>;
  readonly park: DirectorTaskParkPort | undefined;
}

export interface DirectorToolsOptions {
  readonly store: DirectorStore;
  readonly coordinator: DirectorCoordinatorPort;
  readonly runtimeEvents?: DirectorRuntimeEventsPort;
  readonly work?: DirectorWorkPort;
  /** Host-provided Coordinator planning guide (the host reads it from pane-manager; this module does not import it). */
  readonly coordinatorGuide?: () => Promise<{ source: string; prompt: string; framing?: "director" | "coordinator_v2" }>;
  /** Provider-specific upper bound; clamped to [DIRECTOR_LIMITS.waitMinMs, DIRECTOR_LIMITS.waitMaxMs]. Default DIRECTOR_LIMITS.waitDefaultMs. */
  readonly maxWaitMs?: number;
  /** Runtime park observation; without it retry falls back to a plain unpark call. */
  readonly taskPark?: DirectorTaskParkPort;
  readonly now?: () => Date;
}

export const DIRECTOR_OWN_TOOLS: readonly { name: string; description: string }[] = [
  { name: "director_wait", description: "Wait for new user messages (CLI or Web), issue-queue changes, Runtime events or mailbox items (specialist results, Runtime notices). Arguments: cursor (from the previous result; omit on first call), timeoutMs (optional). Returns immediately when something is pending; call it again with the returned cursor." },
  { name: "director_say", description: "Send a message to the user. It is shown in the Web chat and stored in the shared transcript. Arguments: text, runId (optional)." },
  { name: "director_note_user_message", description: "Record a message the user typed in this CLI when no hook recorded it. Arguments: text." },
  { name: "list_issues", description: "List the issue queue. Arguments: status (optional array of open|retrying|resolved|dismissed; default open and retrying)." },
  { name: "inspect_issue", description: "Read one queued issue with its evidence references. Arguments: issueId." },
  { name: "set_issue_status", description: "Mark a queued issue retrying, resolved or dismissed after you acted on it. Arguments: issueId, status." },
  { name: "park_task", description: "Treo một task thuộc run Director sau khi Runtime xác nhận dừng execution, giữ worktree và đưa vào hàng đợi lỗi. Arguments: runId, taskId, reason." },
  { name: "unpark_task", description: "Mở lại task đã treo và lên lịch thử mới qua Runtime. Arguments: runId, taskId." },
  { name: "read_mailbox", description: "Read the Director mailbox page by page. Arguments: afterSeq (optional, default 0), audience (optional director|user, default director), limit (optional, at most 200). Items are summaries; use inspect tools for detail." },
  { name: "read_coordinator_guide", description: "Read the Coordinator planning guide that the Director follows when decomposing work. Arguments: none." },
  { name: "start_work", description: "Create a new run through the same delegation path Conversation uses. For implementation runs in a Director session, decompose the work yourself: after start_work call planning_reference and read_coordinator_guide, then assess, propose_workflow and request_specialist; specialist results arrive in director_wait mailbox items. For analysis-only work, pass nativeFamily: analysis, read inspect(runId) then call start_extension with the pinned intake; no Developer DAG. Clarify acceptance criteria with the user first. Arguments: title, objective, acceptanceCriteria (array of {description, verificationMethod: unit_test|integration_test|e2e_test|typecheck|lint|static_analysis|manual_review}, at least one), sddLevel (lightweight|full), kind (optional feature|bugfix|refactor|spike, default feature), priority (optional low|normal|high|critical, default normal), nativeFamily (optional implementation|analysis|qa; defaults to implementation; analysis requires the pinned analysis pack, QA unavailable pending contract review), userMessageSeq (seq of the user message that asked for this work; it must be a real user message in the transcript). Calling again for the same user message, even from a new Director session, returns the same runId and creates no second run. Returns {runId, correlationId, status: queued}." }
];

/** Host-served planning guidance; needs no pane binding. Shared with the Coordinator implementation in the host. */
export const DIRECTOR_HOST_TOOLS: readonly { name: string; description: string }[] = [
  { name: "resume_run", description: "Resume an existing run after addressing its blocker. Arguments: runId, actionId (optional; uses the recorded action for implementation). For a started native analysis run, the host wakes its extension pump and reconciles existing delivery; no Developer DAG or retry-budget reset. An unstarted native intake needs start_extension." },
  { name: "start_extension", description: "Start an admitted native analysis run using its exact runId, kind, intake object and packPin {id,version,digest}. Read inspect(runId) for the frozen family/pin and intake schema. Runtime owns dispatch and Web human approval; the Director supplies intake and never creates a Developer DAG for native work. QA native is unavailable pending its contract decision." },
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
const MailboxArgs = z.object({
  afterSeq: z.number().int().min(0).optional(),
  audience: z.enum(["director", "user"]).optional(),
  limit: z.number().int().min(1).max(DIRECTOR_LIMITS.mailboxPage).optional()
}).strict();
const GuideArgs = z.object({}).strict();
const COORDINATOR_GUIDE_PREFIX = "Hướng dẫn lập kế hoạch của Coordinator (Director dùng thay). Bỏ qua các phần nói về pane, Herdr và Conversation.";
const COORDINATOR_GUIDE_MAX_BYTES = 64 * 1024;
const SetStatusArgs = z.object({ issueId: z.string().min(1), status: z.enum(["retrying", "resolved", "dismissed"]) }).strict();
const UnparkArgs = z.object({ runId: IdentifierSchema, taskId: IdentifierSchema }).strict();
const ParkArgs = UnparkArgs.extend({ reason: z.string().trim().min(1).max(2000) }).strict();

const VerificationMethodSchema = AcceptanceCriterionSchema.innerType().shape.verificationMethod;
const PrioritySchema = DelegationRequestSchema.innerType().shape.priority;
const StartWorkArgs = z.object({
  title: z.string().trim().min(1),
  objective: z.string().trim().min(1),
  acceptanceCriteria: z.array(z.object({ description: z.string().trim().min(1), verificationMethod: VerificationMethodSchema }).strict()).min(1),
  sddLevel: SddPolicyLevelSchema,
  kind: WebRequestKindSchema.default("feature"),
  priority: PrioritySchema.default("normal"),
  nativeFamily: z.enum(["implementation", "analysis", "qa"]).optional(),
  userMessageSeq: z.number().int().positive()
}).strict();

const NOTE_DEDUPE_MS = 10_000;
const HEARTBEAT_SLICE_MS = 60_000;
const RUNTIME_EVENTS_LIMIT = 200;
const CURSOR = /^m(\d+)\.i(\d+)(?:\.b(\d+))?\.r([A-Za-z0-9_-]*)$/;

const json = (value: unknown): JsonValue => JsonValueSchema.parse(value);

export class DirectorTools {
  private readonly store: DirectorStore;
  private readonly coordinator: DirectorCoordinatorPort;
  private readonly runtimeEvents: DirectorRuntimeEventsPort | undefined;
  private readonly work: DirectorWorkPort | undefined;
  private readonly coordinatorGuide: DirectorToolsOptions["coordinatorGuide"];
  /** Concurrent calls for one message share a single handoff. */
  private readonly inFlight = new Map<string, Promise<JsonValue>>();
  private readonly maxWaitMs: number;
  private readonly now: () => Date;
  private readonly taskPark: DirectorTaskParkPort | undefined;
  /** Issue status changes (Director tool, owner CLI, Web command) run one at a time per host. */
  private issueChain: Promise<unknown> = Promise.resolve();

  constructor(options: DirectorToolsOptions) {
    this.store = options.store;
    this.coordinator = options.coordinator;
    this.runtimeEvents = options.runtimeEvents;
    this.work = options.work;
    this.coordinatorGuide = options.coordinatorGuide;
    this.maxWaitMs = Math.min(Math.max(options.maxWaitMs ?? DIRECTOR_LIMITS.waitDefaultMs, DIRECTOR_LIMITS.waitMinMs), DIRECTOR_LIMITS.waitMaxMs);
    this.now = options.now ?? (() => new Date());
    this.taskPark = options.taskPark;
  }

  async invoke(name: string, input: unknown, token: string, signal?: AbortSignal): Promise<JsonValue> {
    await this.store.authenticate(token);
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
        return json(await this.setIssueStatus(args.issueId, args.status));
      }
      case "park_task": {
        const args = ParkArgs.parse(input);
        const result = json(await this.coordinator.invoke("park_task", args));
        const parked = z.object({ parked: z.boolean(), episode: z.number().int().positive().optional() }).passthrough().parse(result);
        if (parked.parked) {
          if (parked.episode === undefined) throw new Error("Runtime thiếu số lần treo task; chưa thể ghi issue");
          await this.store.upsertIssue({ issueId: `park:${args.runId}:${args.taskId}:${parked.episode}`,
            runId: args.runId, taskKey: args.taskId, kind: "other", summary: args.reason,
            suggestedAction: "Thử lại từ hàng đợi lỗi (set_issue_status retrying); Runtime tự mở lại task" });
        }
        return result;
      }
      case "unpark_task": {
        const args = UnparkArgs.parse(input);
        return json(await this.coordinator.invoke("unpark_task", args));
      }
      case "read_mailbox": {
        const args = MailboxArgs.parse(input ?? {});
        return json(await this.store.readMailbox({
          afterSeq: args.afterSeq ?? 0,
          audience: args.audience ?? "director",
          ...(args.limit !== undefined ? { limit: args.limit } : {})
        }));
      }
      case "read_coordinator_guide":
        GuideArgs.parse(input ?? {});
        return this.readCoordinatorGuide();
      case "start_work":
        return this.startWork(StartWorkArgs.parse(input));
      default:
        if (COORDINATOR_NAMES.has(name)) return json(await this.coordinator.invoke(name, input));
        throw new Error(`Unknown Director tool: ${name}`);
    }
  }

  /**
   * Used by authenticated Director tools, the admitted CLI queue command and Web issue commands. Dismissal grants no Runtime
   * authority. Idempotent: a repeated status is returned unchanged, and a retry never unparks twice nor resets the issue to
   * open. With a park observation port the issue must belong to the task's current park episode before unpark; an episode
   * that Runtime already reopened only gets its status recorded (observed, not resent). `guard` runs before any effect.
   */
  async setIssueStatus(issueId: string, status: "retrying" | "resolved" | "dismissed", guard?: DirectorIssueGuard,
    options: { recordOnly?: boolean } = {}): Promise<ParkedIssue> {
    const args = SetStatusArgs.parse({ issueId, status });
    return this.issueSerial(async () => {
      const issue = (await this.store.listIssues()).find(item => item.issueId === args.issueId);
      if (!issue) throw new DirectorIssueRefusal("not_found", `Unknown director issue ${args.issueId}`);
      guard?.(issue);
      if (issue.status === args.status) return issue;
      if (args.status === "retrying" && issue.taskKey !== undefined) {
        const observed = this.taskPark ? await this.taskPark(issue.runId, issue.taskKey) : undefined;
        const matches = (park: DirectorParkEpisode) => parkEpisodeIssueIds(issue.runId, issue.taskKey!, park).includes(issue.issueId);
        // Record-only (reconciliation): only an episode Runtime already reopened is recorded. An unobservable or still/again
        // parked task fails closed: no status write and never an unpark.
        if (options.recordOnly && (observed === undefined || observed.current !== undefined || !observed.history.some(matches)))
          throw new DirectorIssueRefusal("stale_version", "Không xác nhận được task đã được mở lại; chỉ quan sát, không mở lại");
        let unpark = observed === undefined;
        if (observed !== undefined) {
          if (observed.current !== undefined) {
            if (!matches(observed.current)) throw new DirectorIssueRefusal("stale_version", "Issue không thuộc lần treo hiện tại của task; không mở lại");
            unpark = true;
          } else if (!observed.history.some(matches)) {
            throw new DirectorIssueRefusal("stale_version", "Task không còn treo ở lần ghi trong issue; không mở lại");
          }
        }
        if (unpark) {
          const result = z.object({ unparked: z.boolean() }).passthrough().parse(
            await this.coordinator.invoke("unpark_task", { runId: issue.runId, taskId: issue.taskKey }));
          if (!result.unparked) throw new Error("Runtime chưa mở lại được task");
        }
      }
      return this.store.setIssueStatus(issue.issueId, args.status);
    });
  }

  /** Read-only check of a status change against current issue and park state, under the same serial step as changes. */
  async checkIssueStatus(issueId: string, status: "retrying" | "resolved" | "dismissed", guard?: DirectorIssueGuard): Promise<ParkedIssue> {
    const args = SetStatusArgs.parse({ issueId, status });
    return this.issueSerial(async () => {
      const issue = (await this.store.listIssues()).find(item => item.issueId === args.issueId);
      if (!issue) throw new DirectorIssueRefusal("not_found", `Unknown director issue ${args.issueId}`);
      guard?.(issue);
      if (args.status === "retrying" && issue.status !== "retrying" && issue.taskKey !== undefined && this.taskPark) {
        const observed = await this.taskPark(issue.runId, issue.taskKey);
        const matches = (park: DirectorParkEpisode) => parkEpisodeIssueIds(issue.runId, issue.taskKey!, park).includes(issue.issueId);
        if (!observed || (observed.current !== undefined ? !matches(observed.current) : !observed.history.some(matches)))
          throw new DirectorIssueRefusal("stale_version", "Issue không thuộc lần treo hiện tại của task");
      }
      return issue;
    });
  }

  /** Runs `work` in the issue serial step: an observation made inside it cannot interleave with a status change. */
  observeIssues<T>(work: (observe: DirectorIssueObservation) => Promise<T>): Promise<T> {
    return this.issueSerial(() => work({
      issue: async issueId => (await this.store.listIssues()).find(item => item.issueId === issueId),
      park: this.taskPark
    }));
  }

  private issueSerial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.issueChain.then(task, task);
    this.issueChain = run.catch(() => undefined);
    return run;
  }

  private async readCoordinatorGuide(): Promise<JsonValue> {
    if (!this.coordinatorGuide) throw new Error("read_coordinator_guide is unavailable: the host has no Coordinator guide");
    const guide = await this.coordinatorGuide();
    // The Director's own guide is returned as written; only the legacy Coordinator guide needs the "skip pane/Herdr" prefix.
    let prompt = guide.framing === "director" ? guide.prompt : `${COORDINATOR_GUIDE_PREFIX}\n\n${guide.prompt}`;
    if (Buffer.byteLength(prompt, "utf8") > COORDINATOR_GUIDE_MAX_BYTES) {
      // Cut on bytes, then drop a trailing partial UTF-8 sequence.
      prompt = Buffer.from(prompt, "utf8").subarray(0, COORDINATOR_GUIDE_MAX_BYTES).toString("utf8").replace(/\uFFFD+$/, "");
    }
    return json({ source: guide.source, prompt });
  }

  private async startWork(args: z.infer<typeof StartWorkArgs>): Promise<JsonValue> {
    if (!this.work) throw new Error("start_work is unavailable: the host has no delegation path");
    const evidence = (await this.store.readMessages({ afterSeq: args.userMessageSeq - 1, limit: 1 }))[0];
    if (!evidence || evidence.seq !== args.userMessageSeq) throw new Error(`userMessageSeq ${args.userMessageSeq} does not exist in the Director transcript`);
    if (evidence.author !== "user") throw new Error(`userMessageSeq ${args.userMessageSeq} is not a user message; start_work needs the user's own message as evidence of intent`);
    const work = this.work;
    const key = `director:${evidence.messageId}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const run = (async (): Promise<JsonValue> => {
      const known = await this.store.startedWork(evidence.messageId);
      if (known) return json({ runId: known.runId, correlationId: known.correlationId, status: "queued" });
      const result = json(await work.start({
        key,
        title: args.title,
        objective: args.objective,
        kind: args.kind,
        acceptanceCriteria: args.acceptanceCriteria,
        sddLevel: args.sddLevel,
        priority: args.priority,
        requestedAt: evidence.at,
        ...(args.nativeFamily ? { nativeFamily: args.nativeFamily } : {})
      }));
      if (typeof result === "object" && result !== null && !Array.isArray(result) && typeof result.runId === "string" && typeof result.correlationId === "string") {
        await this.store.recordStartedWork(evidence.messageId, { runId: result.runId, correlationId: result.correlationId });
      }
      return result;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  /**
   * First cursor of a Director session: starts at the durable ack (bootstrapped once from the legacy anchor), so user and
   * mailbox messages that arrived while no Director was present are delivered. `i0` returns the open issues on the first wait.
   */
  async startCursor(): Promise<string> {
    const ack = await this.store.bootstrapAck();
    return `m${ack.messageSeq}.i0.b${ack.mailboxSeq}.r`;
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
      return { recorded: false, duplicate: true, seq: lastUser.seq };
    }
    const message = await this.store.appendMessage({ author: "user", channel: "cli", text: args.text });
    return { recorded: true, seq: message.seq };
  }

  private async wait(args: z.infer<typeof WaitArgs>, token: string, signal?: AbortSignal): Promise<JsonValue> {
    // An empty cursor (the first wait after `director start`) is the ack-based start cursor; an omitted cursor reads everything.
    const cursor = args.cursor === "" ? await this.startCursor() : args.cursor;
    const start = await this.store.version();
    let seq = 0;
    let revision = start.issuesRevision;
    // Omitted cursor reads the whole mailbox; a B1 cursor (no .b) does not replay history.
    let mailboxSeq = cursor === undefined ? 0 : start.mailboxSeq;
    let runtimeCursor = "";
    if (cursor !== undefined) {
      const match = CURSOR.exec(cursor);
      if (!match) throw new Error("Invalid director cursor");
      seq = Number(match[1]);
      revision = Number(match[2]);
      if (match[3] !== undefined) mailboxSeq = Number(match[3]);
      runtimeCursor = Buffer.from(match[4]!, "base64url").toString("utf8");
      // R-ACK: a cursor the Director passes back proves it received the result that carried it. Recorded before waiting;
      // a position beyond stored data is refused (DirectorCursorError) and nothing is acknowledged.
      if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(revision) || (match[3] !== undefined && !Number.isSafeInteger(mailboxSeq))) throw new Error("Invalid director cursor");
      await this.store.recordAck({ messageSeq: seq, ...(match[3] !== undefined ? { mailboxSeq } : {}) });
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
        const mailbox: DirectorMailboxItem[] = await this.store.readMailbox({ afterSeq: mailboxSeq, audience: "director" });
        for (const item of mailbox) mailboxSeq = Math.max(mailboxSeq, item.seq);
        let issues: ParkedIssue[] = [];
        if (version.issuesRevision !== revision) {
          issues = await this.store.listIssues({ status: ["open", "retrying"] });
          revision = version.issuesRevision;
        }
        // A full page without a user message means more transcript is already waiting: read on without blocking.
        if (fresh.length >= DIRECTOR_LIMITS.transcriptPage && messages.length === 0 && issues.length === 0 && runtimeEvents.length === 0 && mailbox.length === 0) continue;
        const remaining = deadline - Date.now();
        if (messages.length > 0 || issues.length > 0 || runtimeEvents.length > 0 || mailbox.length > 0 || remaining <= 0 || signal?.aborted) {
          const timedOut = messages.length === 0 && issues.length === 0 && runtimeEvents.length === 0 && mailbox.length === 0;
          return json(DirectorWaitResultSchema.parse({
            cursor: `m${seq}.i${revision}.b${mailboxSeq}.r${Buffer.from(runtimeCursor, "utf8").toString("base64url")}`,
            timedOut,
            messages,
            issues,
            runtimeEvents,
            mailbox
          }));
        }

        const slice = Math.min(remaining, HEARTBEAT_SLICE_MS);
        const controller = new AbortController();
        const onClientAbort = (): void => controller.abort();
        signal?.addEventListener("abort", onClientAbort, { once: true });
        const since = { messageSeq: version.messageSeq, issuesRevision: version.issuesRevision, mailboxSeq: version.mailboxSeq };
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
