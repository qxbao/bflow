import {
  WebRunViewSchema,
  WebRunQuerySchema,
  WebDecisionSchema,
  WebPageSchema,
  WorkflowRunSnapshotSchema,
  type WebRunView,
  type WebDecision,
  type WebRunQuery,
  type WorkflowRunSnapshot,
  type ApprovalRequest,
  type AgentTransportState,
  type SessionManifest,
} from "@bflow/contracts";
import {
  digest,
  type JournalState,
  type RunRecord,
} from "../agentic/journal.js";
import { pendingPrototypeApprovals } from "../agentic/prototype-review.js";
import { redactString } from "../resilience/redaction.js";
import { availableActions, terminal } from "./actions.js";
import { projectExtensionRoutes } from "../agentic/extension-projection.js";
export interface ReadSources {
  state: JournalState;
  sessionId: string;
  observedAt: string;
  core: Map<string, WorkflowRunSnapshot>;
  ready: boolean;
  transport?: { states: AgentTransportState[]; observedAt: string };
  commandsSupported?: boolean;
  pendingClarifications?: import("@bflow/conversation").ConversationContextSnapshot["pendingClarifications"] | undefined;
  /** Workforce only: the Session Manifest and project scope. Never feeds a run revisionToken or ReadSources.transport. */
  manifest?: SessionManifest | undefined;
  projectId?: string | undefined;
  redact?: (text: string) => string;
  redactOption?: (text: string) => string;
}
function sliceUtf16Safe(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

const safe = (s: ReadSources, text: string, max = 16000) =>
  sliceUtf16Safe(s.redact?.(text) ?? text, max) || "[redacted]";
const safeOption = (s: ReadSources, text: string, max = 200) =>
  sliceUtf16Safe((s.redactOption ?? s.redact)?.(text) ?? text, max) || "[redacted]";
function cleanDelegationTitle(delegation: { title: string; objective?: string }): string {
  if (!/<\/?pasted_content\b/i.test(delegation.title) && !/\[bflow-web:/i.test(delegation.title)) {
    return delegation.title;
  }
  const strip = (text: string) =>
    text
      .replace(/<\/?pasted_content\b[^>]*>/gi, "")
      .replace(/^\s*\[bflow-web:[^\s\]\r\n]*\]?\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  const cleanedTitle = strip(delegation.title);
  if (cleanedTitle) return cleanedTitle;
  const cleanedObjective = delegation.objective ? strip(delegation.objective).slice(0, 80).trim() : "";
  return cleanedObjective || delegation.title;
}
export function projectDecision(
  s: ReadSources,
  r: RunRecord,
  request: ApprovalRequest,
  kind: WebDecision["kind"],
): WebDecision {
  const evidence = request.evidence.slice(0, 100).map((e) => ({
    artifactId: e.artifactId,
    runId: r.runId,
    kind: e.kind,
    mediaType: e.mediaType,
    checksum: e.checksum,
    ...(e.sizeBytes === undefined ? {} : { sizeBytes: e.sizeBytes }),
  }));
  return WebDecisionSchema.parse({
    decisionId: request.approvalId,
    runId: r.runId,
    kind,
    status: request.status ?? "pending",
    question: safe(s, request.reason),
    options: Array.isArray(request.metadata?.options)
      ? request.metadata.options
          .filter((v): v is string => typeof v === "string")
          .slice(0, 10)
          .map((v) => safeOption(s, v, 200))
      : [],
    expectedVersion: {
      revisionToken: digest(request),
      approvalId: request.approvalId,
      target: request.target,
      revision: request.revision,
      generation: request.generation,
      evidenceDigest: digest(request.evidence),
    },
    evidence,
  });
}
function pendingActionBlocker(action: NonNullable<RunRecord["pendingAction"]>): string {
  if (action.kind === "reconcile_delivery" || action.recovery === "reconcile_delivery") return "delivery_reconciliation_required";
  if (action.kind === "coordinator_continuation") return "coordinator_continuation_pending";
  if (action.recovery === "auto_resume") return "auto_resume_scheduled";
  if (action.recovery === "capability_repair") return "capability_repair_pending";
  return "manual_resume_required";
}
const runViewCache = new WeakMap<JournalState, Map<string, WebRunView>>();
export function projectRun(s: ReadSources, runId: string): WebRunView {
  const runs = s.state.runs.filter(
    (r) => r.delegation.sessionId === s.sessionId,
  );
  const r = runs.find((r) => r.runId === runId);
  if (!r) throw new Error("not_found");
  const core = r.coreCreated ? s.core.get(runId) : undefined;
  let cacheBucket: Map<string, WebRunView> | undefined;
  let cacheKey: string | undefined;
  if (Object.isFrozen(s.state)) {
    cacheBucket = runViewCache.get(s.state);
    if (!cacheBucket) {
      cacheBucket = new Map();
      runViewCache.set(s.state, cacheBucket);
    }
    cacheKey = JSON.stringify([
      runId,
      s.sessionId,
      s.ready,
      Boolean(s.commandsSupported),
      s.transport ?? s.observedAt,
      core ?? null,
      s.pendingClarifications?.[r.delegation.correlationId] ?? null,
      Boolean(s.redact),
      Boolean(s.redactOption),
    ]);
    const cached = cacheBucket.get(cacheKey);
    if (cached) return cached;
  }
  const stale =
    r.coreCreated &&
    (!core || s.state.pendingCore.some((p) => p.runId === r.runId));
  const decisions: WebDecision[] = [];
  if (!terminal(r)) {
    if (
      r.approval &&
      r.status === "awaiting_approval" &&
      r.decision?.approvalId !== r.approval.approvalId
    )
      decisions.push(projectDecision(s, r, r.approval, r.approval.metadata?.kind === "user_decision" ? "user_decision" : "approval"));
    for (const d of Object.values(r.userDecisions ?? {}))
      if (d.status === "pending")
        decisions.push(projectDecision(s, r, d.request, "user_decision"));
    for (const request of pendingPrototypeApprovals(r.prototype))
      decisions.push(projectDecision(s, r, request, "approval"));
  }
  // A decided approval stays readable; only its pending form is actionable (actions and admission require "pending").
  const decided = r.approval && r.decision?.approvalId === r.approval.approvalId ? r.decision.decision : undefined;
  if (decided)
    decisions.push({ ...projectDecision(s, r, r.approval!, "approval"), status: decided });
  let current = r;
  const visited = new Set([r.runId]);
  while (current.supersededBy) {
    const next = runs.find(
      (n) =>
        n.runId === current.supersededBy &&
        n.delegation.metadata?.parentRunId === current.runId,
    );
    if (!next || visited.has(next.runId)) break;
    visited.add(next.runId);
    current = next;
  }
  const parent = r.delegation.metadata?.parentRunId,
    origin = r.delegation.metadata?.originRunId;
  const updatedAt = [
    r.pendingAction?.createdAt,
    r.decision?.decidedAt,
    r.delegation.requestedAt,
    core?.updatedAt,
  ]
    .filter((v): v is string => !!v)
    .sort()
    .at(-1)!;
  const actions = availableActions(
    r,
    s.state,
    decisions,
    s.ready,
    s.commandsSupported,
    stale,
  );
  const truncated =
    actions.length > 100 ||
    decisions.length > 100 ||
    (core?.tasks.length ?? 0) > 1000;
  const view = WebRunViewSchema.parse({
    apiVersion: 1,
    runId: r.runId,
    sessionId: s.sessionId,
    revisionToken: digest([
      r.delegation,
      r.status,
      r.pendingAction,
      r.approval,
      r.decision,
      r.supersededBy,
      core?.version,
      r.userDecisions,
      r.prototype,
      current.runId,
      r.cancelled,
      stale,
      s.ready,
      s.commandsSupported,
      s.transport?.states,
    ]),
    title: safe(s, cleanDelegationTitle(r.delegation), 200),
    originRunId:
      typeof origin === "string" && runs.some((n) => n.runId === origin)
        ? origin
        : r.runId,
    ...(typeof parent === "string" && runs.some((n) => n.runId === parent)
      ? { parentRunId: parent }
      : {}),
    ...(r.supersededBy && visited.has(r.supersededBy)
      ? { continuedAsRunId: r.supersededBy }
      : {}),
    currentRunId: current.runId,
    sdlcStatus: r.status,
    coreStatus: core?.status ?? null,
    transportSummary: s.transport ?? { states: [], observedAt: s.observedAt },
    tasks: (core?.tasks ?? []).slice(0, 1000).map((t) => ({
      taskId: t.taskId,
      title: safe(
        s,
        r.definition?.tasks.find((d) => d.id === t.taskId)?.title ?? t.taskId,
        200,
      ),
      status: t.status,
    })),
    blockers: [
      ...(truncated
        ? [
            {
              code: "projection_truncated",
              message:
                "This projection reached a collection limit; narrow the selection before acting.",
            },
          ]
        : []),
      ...(r.executionPlanDrift
        ? [
            {
              code: "execution_plan_drift",
              message: "Source changed before dispatch; nothing was sent for this plan.",
            },
          ]
        : []),
      // Codes only: the raw action reason is private Runtime state and never leaves the host.
      ...(r.pendingAction && !terminal(r)
        ? [
            {
              code: pendingActionBlocker(r.pendingAction),
              message: "Runtime is waiting on a recorded recovery action.",
            },
          ]
        : r.error
          ? [
              {
                code: "runtime_blocked",
                message:
                  "Runtime requires attention; inspect the current action or decision.",
              },
            ]
          : []),
      ...(stale
        ? [
            {
              code: "core_projection_unavailable",
              message: "Core projection unavailable; reconcile before acting.",
            },
          ]
        : []),
    ],
    decisions: decisions.slice(0, 100),
    clarifications: (s.pendingClarifications?.[r.delegation.correlationId]?.unresolvedQuestions ?? []).slice(0, 100).map((question, index) => ({
      questionId: "question-" + digest([r.delegation.correlationId, index, question]), question: safe(s, question), options: [],
      expectedVersion: { revisionToken: digest(s.pendingClarifications![r.delegation.correlationId]) },
    })),
    availableActions: actions.slice(0, 100),
    updatedAt,
  });
  if (cacheBucket && cacheKey) cacheBucket.set(cacheKey, view);
  return view;
}
export function paginateRuns(s: ReadSources, input: WebRunQuery) {
  const query = WebRunQuerySchema.parse(input);
  const rows = s.state.runs
    .filter((r) => r.delegation.sessionId === s.sessionId)
    .map((r) => projectRun(s, r.runId))
    .filter(
      (v) =>
        (!query.search ||
          v.title.toLowerCase().includes(query.search.toLowerCase())) &&
        (!query.sdlcStatus || v.sdlcStatus === query.sdlcStatus),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.runId.localeCompare(b.runId));
  const scope = digest([
    s.sessionId,
    query.search,
    query.sdlcStatus,
    rows.map((r) => [r.runId, r.revisionToken]),
  ]);
  let offset = 0;
  if (query.cursor) {
    const match = /^([a-f0-9]{64}):([0-9]+)$/.exec(query.cursor);
    if (!match || match[1] !== scope) throw new Error("stale cursor");
    offset = Number(match[2]);
    if (!Number.isSafeInteger(offset) || offset > rows.length)
      throw new Error("invalid cursor");
  }
  const end = offset + query.limit;
  return WebPageSchema(WebRunViewSchema).parse({
    apiVersion: 1,
    items: rows.slice(offset, end),
    ...(end < rows.length ? { nextCursor: `${scope}:${end}` } : {}),
  });
}

/** Read atomic persisted snapshots without creating locks, stores, sessions or receipts. */
import { open, constants } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  SessionManifestSchema,
  WebProjectSessionResultSchema,
  WebRunPageResultSchema,
  WebRunViewResultSchema,
  WebDecisionPageResultSchema,
  WebWorkforceViewSchema,
  WebActivityEntrySchema,
  WebWorkforceExcerptsSchema,
  WebAgentTranscriptSchema,
  OperationResultSchema,
} from "@bflow/contracts";
import { ConversationContextSnapshotSchema } from "@bflow/conversation";
import { ProjectionSnapshots } from "./projection-snapshots.js";
import type { HostConfiguration } from "../agentic/host-controller.js";
import { InteractionQuerySchema } from "./schemas.js";
import { interactionProjectId } from "./client.js";
import { projectWorkforce } from "./workforce.js";
import { readRunActivityPage } from "./activity.js";
import { readAgentTranscript, readWorkforceExcerpts } from "./transcript.js";
const projectionSnapshots = new ProjectionSnapshots();
const WebWorkforceResultSchema = OperationResultSchema(WebWorkforceViewSchema);
const WebExcerptsResultSchema = OperationResultSchema(WebWorkforceExcerptsSchema);
const WebTranscriptResultSchema = OperationResultSchema(WebAgentTranscriptSchema);
const WebActivityResultSchema = OperationResultSchema(WebPageSchema(WebActivityEntrySchema));
const inflightSnapshotBytes = new Map<string, Promise<Buffer | undefined>>();
const snapshotStatCache = new Map<string, {
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  bytes: Buffer;
  parsedByRepo: Map<string, ReturnType<ProjectionSnapshots["parse"]>>;
  parsedContext?: ReturnType<typeof ConversationContextSnapshotSchema.parse>;
}>();
async function readSnapshotBytes(path: string, maxBytes: number): Promise<Buffer | undefined> {
  const key = `${path}:${maxBytes}`;
  const existing = inflightSnapshotBytes.get(key);
  if (existing) return existing;
  const work = (async () => {
    let file;
    try {
      file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        snapshotStatCache.delete(path);
        return undefined;
      }
      throw e;
    }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes)
        throw new Error("Invalid read source");
      const cached = snapshotStatCache.get(path);
      if (
        cached &&
        stat.size > 65536 &&
        cached.ino === stat.ino &&
        cached.size === stat.size &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.ctimeMs === stat.ctimeMs
      ) {
        return cached.bytes;
      }
      const bytes = await file.readFile();
      if (bytes.byteLength > maxBytes)
        throw new Error("Read source too large");
      if (stat.size > 65536) {
        snapshotStatCache.set(path, {
          ino: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          bytes,
          parsedByRepo: new Map(),
        });
      } else {
        snapshotStatCache.delete(path);
      }
      return bytes;
    } finally {
      await file.close();
    }
  })();
  inflightSnapshotBytes.set(key, work);
  try {
    return await work;
  } finally {
    if (inflightSnapshotBytes.get(key) === work) inflightSnapshotBytes.delete(key);
  }
}
async function readJournalSnapshot(path: string, repository: string, maxBytes: number) {
  const bytes = await readSnapshotBytes(path, maxBytes);
  if (bytes === undefined) return undefined;
  const cached = snapshotStatCache.get(path);
  if (cached && cached.bytes === bytes) {
    const existing = cached.parsedByRepo.get(repository);
    if (existing !== undefined) return existing;
    const parsed = projectionSnapshots.parse(path, repository, bytes);
    cached.parsedByRepo.set(repository, parsed);
    return parsed;
  }
  return projectionSnapshots.parse(path, repository, bytes);
}
async function readConversationContextSnapshot(path: string) {
  const bytes = await readSnapshotBytes(path, 16 * 1024 * 1024);
  if (bytes === undefined) return undefined;
  const cached = snapshotStatCache.get(path);
  if (cached && cached.bytes === bytes) {
    if (cached.parsedContext !== undefined) return cached.parsedContext;
    const parsed = ConversationContextSnapshotSchema.parse(JSON.parse(bytes.toString("utf8")));
    cached.parsedContext = parsed;
    return parsed;
  }
  return ConversationContextSnapshotSchema.parse(JSON.parse(bytes.toString("utf8")));
}
async function readSnapshot(path: string): Promise<unknown | undefined>;
async function readSnapshot<T>(path: string, decode: (bytes: Buffer) => T, maxBytes?: number): Promise<T | undefined>;
async function readSnapshot(path: string, decode?: (bytes: Buffer) => unknown, maxBytes = 16 * 1024 * 1024): Promise<unknown | undefined> {
  const bytes = await readSnapshotBytes(path, maxBytes);
  if (bytes === undefined) return undefined;
  return decode ? decode(bytes) : JSON.parse(bytes.toString("utf8"));
}
export async function hostInteractionQuery(
  configuration: HostConfiguration,
  input: unknown,
  options: {
    ready: boolean;
    onDiagnostic?: (code: string) => void;
    commandsSupported?: boolean;
    readCore?: (runId: string) => Promise<WorkflowRunSnapshot | undefined>;
    /** Terminal snapshot of one pane for the excerpt and transcript queries; without it those answer operation_not_allowed. */
    readPane?: (paneId: string, lines: number) => Promise<string>;
  },
) {
  const query = InteractionQuerySchema.parse(input),
    projectId = interactionProjectId(configuration.repositoryPath);
  if (query.projectId !== projectId)
    return {
      ok: false as const,
      error: {
        code: "validation" as const,
        retryable: false as const,
        message: "Project scope mismatch.",
      },
    };
  // Director reads are served only by the host's DirectorWebBridge (single store owner), never from files here.
  if (query.kind === "director" || query.kind === "director_issues")
    return { ok: false as const, error: { code: "validation" as const, retryable: false as const, message: "Director views are served by the host bridge." } };
  const observedAt = new Date().toISOString();
  const root = resolve(configuration.directory, "../..");
  const rawManifest = await readSnapshot(
    join(
      configuration.manifestDirectory ??
        join(configuration.repositoryPath, ".bflow/state/panes"),
      configuration.sessionId + ".manifest.json",
    ),
  );
  const manifest =
    rawManifest === undefined
      ? undefined
      : SessionManifestSchema.parse(rawManifest);
  if (
    manifest &&
    (manifest.sessionId !== configuration.sessionId ||
      manifest.workspaceRoot !== configuration.repositoryPath)
  )
    throw new Error("Session scope mismatch");
  const sessionId = manifest?.conversationSessionId;
  if (!sessionId) {
    if (query.kind === "session")
      return WebProjectSessionResultSchema.parse({
        ok: true,
        value: {
          apiVersion: 1,
          projectId,
          sessionId: configuration.sessionId,
          state: "unavailable",
          pendingIntakes: [],
          blockers: [
            {
              code: "session_unavailable",
              message: "No active Conversation session.",
            },
          ],
          updatedAt: observedAt,
        },
      });
    return {
      ok: false as const,
      error: {
        code: "transport_unavailable" as const,
        retryable: true as const,
        message: "Conversation session unavailable.",
      },
    };
  }
  const journalPath = join(root, "agentic/journal/state.json");
  const journal = await readJournalSnapshot(journalPath, configuration.repositoryPath, 64 * 1024 * 1024);
  let state =
    journal === undefined
      ? {
          version: 1 as const,
          repository: configuration.repositoryPath,
          runs: [],
          outbound: [],
          inbox: [],
          pendingCore: [],
          pendingVerifications: [],
        }
      : journal;
  const packFamily = configuration.platform?.workflowPack?.defaults["workflow.id"];
  const nativeRuns = state.runs.some(run => run.delegation.sessionId === sessionId &&
    (["analysis", "qa"].includes(String(run.delegation.metadata?.nativeFamily)) ||
      run.delegation.requestedBy === "conversation" && ["bflow.analysis-only", "bflow.qa-only"].includes(String(packFamily))));
  if (nativeRuns) {
    const extensionPath = join(root, "agentic/extensions", digest(configuration.sessionId), "routes/state.json");
    const diagnostic = options.onDiagnostic ?? ((code: string) => console.warn(code));
    try {
      const extensionRoutes = await readJournalSnapshot(extensionPath, configuration.repositoryPath, 64 * 1024 * 1024);
      if (extensionRoutes) state = projectExtensionRoutes(state, extensionRoutes, sessionId, diagnostic);
    } catch { diagnostic("extension_routes_unavailable"); }
  }
  const core = new Map<string, WorkflowRunSnapshot>();
  // Only run/runs/decisions projections need Core snapshots; skipping Core reads for session/workforce/activity/transcript keeps polling cheap.
  if (query.kind === "run" || query.kind === "runs" || query.kind === "decisions") {
    for (const r of state.runs.filter(
      (r) => r.delegation.sessionId === sessionId && r.coreCreated && (query.kind !== "run" || r.runId === query.runId),
    )) {
      const value = await options.readCore?.(r.runId);
      if (value) {
        const parsed = WorkflowRunSnapshotSchema.parse(value);
        if (parsed.runId !== r.runId) throw new Error("Core scope mismatch");
        core.set(r.runId, parsed);
      }
    }
  }
  // Conservative textual redaction supplements structural allowlisting. Private raw errors never leave the host.
  const secrets = [
    configuration.token,
    configuration.directory,
    root,
    configuration.repositoryPath,
    configuration.socketPath,
  ];
  const redactSecrets = (text: string) => {
    for (const value of secrets)
      if (value) text = text.split(value).join("[redacted]");
    return redactString(text).replace(
      /(?:Bearer\s+\S+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S+)/gi,
      "[redacted]",
    );
  };
  const redact = (text: string) =>
    redactSecrets(text).replace(
      /\/(?:[^\s/]+\/)+[^\s]*/gi,
      "[redacted]",
    );
  if (query.kind === "workforce")
    return WebWorkforceResultSchema.parse({
      ok: true,
      value: projectWorkforce({ state, sessionId, observedAt, core: new Map(), ready: options.ready, manifest, projectId,
        redact, redactOption: redactSecrets }),
    });
  if (query.kind === "workforce_excerpts" || query.kind === "agent_transcript") {
    const readPane = options.readPane;
    if (!readPane || !manifest)
      return { ok: false as const, error: { code: "unsupported_version" as const, retryable: false as const, supportedVersions: [1], receivedVersion: 0,
        message: "Terminal transcripts are not supported by this host." } };
    const sources = { manifest, state, sessionId, projectId, observedAt, redact, readPane };
    return query.kind === "workforce_excerpts"
      ? WebExcerptsResultSchema.parse(await readWorkforceExcerpts(sources))
      : WebTranscriptResultSchema.parse(await readAgentTranscript(sources, query.instanceId));
  }
  if (query.kind === "activity") {
    if (!state.runs.some(r => r.runId === query.runId && r.delegation.sessionId === sessionId))
      return { ok: false as const, error: { code: "not_found" as const, retryable: false as const, message: "Run not found in this session." } };
    return WebActivityResultSchema.parse({
      ok: true, value: await readRunActivityPage(join(root, "agentic/task-activity.jsonl"), query.runId, query.cursor, redact),
    });
  }
  const context = await readConversationContextSnapshot(join(root, "agentic/conversation", sessionId + ".context.json"));
  if (context && (context.session.sessionId !== sessionId || context.session.herdrSessionId !== configuration.sessionId))
    throw new Error("Conversation scope mismatch");
  const source: ReadSources = {
    state,
    sessionId,
    observedAt,
    core,
    ready: options.ready,
    commandsSupported: options.commandsSupported ?? false,
    pendingClarifications: context?.pendingClarifications,
    redact,
    redactOption: redactSecrets,
    transport: {
      states: [...new Set(manifest.panes.map((p) => p.transportState))].slice(
        0,
        100,
      ),
      observedAt: manifest.updatedAt,
    },
  };
  if (query.kind === "session") {
    const pendingIntakes = Object.values(context?.pendingClarifications ?? {})
      .filter(p => !state.runs.some(run => run.delegation.sessionId === sessionId && run.delegation.correlationId === p.correlationId))
      .slice(0, 100)
      .map((p) => ({
        intakeId: p.correlationId,
        sessionId,
        correlationId: p.correlationId,
        title: sliceUtf16Safe(redact(p.draft.title ?? "Yêu cầu cần làm rõ"), 200),
        status: "clarifying" as const,
        clarifications: p.unresolvedQuestions
          .slice(0, 100)
          .map((question, index) => ({
            questionId:
              "question-" + digest([p.correlationId, index, question]),
            question: sliceUtf16Safe(redact(question), 16000),
            options: [],
            expectedVersion: { revisionToken: digest(p) },
          })),
        updatedAt: p.updatedAt,
      }));
    return WebProjectSessionResultSchema.parse({
      ok: true,
      value: {
        apiVersion: 1,
        projectId,
        sessionId,
        state: options.ready ? "ready" : "unavailable",
        ...(context ? { conversationStatus: context.session.status } : {}),
        pendingIntakes,
        blockers: options.ready
          ? []
          : [
              {
                code: "host_inactive",
                message: "Activate the session explicitly before acting.",
              },
            ],
        updatedAt: context?.session.updatedAt ?? observedAt,
      },
    });
  }
  if (query.kind === "runs") {
    try {
      return WebRunPageResultSchema.parse({
        ok: true,
        value: paginateRuns(source, query.query),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "stale cursor")
        return WebRunPageResultSchema.parse({
          ok: false,
          error: {
            code: "conflict",
            retryable: true,
            message: "Run collection changed; restart pagination.",
            details: { reason: "stale_cursor" },
          },
        });
      if (error instanceof Error && error.message === "invalid cursor")
        return WebRunPageResultSchema.parse({
          ok: false,
          error: {
            code: "validation",
            retryable: false,
            message: "Invalid pagination cursor.",
          },
        });
      throw error;
    }
  }
  if (query.kind === "run") {
    if (
      !state.runs.some(
        (r) => r.runId === query.runId && r.delegation.sessionId === sessionId,
      )
    )
      return {
        ok: false as const,
        error: {
          code: "not_found" as const,
          retryable: false as const,
          message: "Run not found in this session.",
        },
      };
    return WebRunViewResultSchema.parse({
      ok: true,
      value: projectRun(source, query.runId),
    });
  }
  const decisions = state.runs
    .filter((r) => r.delegation.sessionId === sessionId)
    .flatMap((r) => projectRun(source, r.runId).decisions)
    // The review inbox stays a to-do list; settled approvals are read from their run.
    .filter((d) => !["approved", "rejected", "changes_requested"].includes(d.status));
  if (decisions.length > 100)
    return {
      ok: false as const,
      error: {
        code: "validation" as const,
        retryable: false as const,
        message:
          "Decision collection exceeds read limit; use paginated run views.",
      },
    };
  return WebDecisionPageResultSchema.parse({
    ok: true,
    value: { apiVersion: 1, items: decisions },
  });
}
