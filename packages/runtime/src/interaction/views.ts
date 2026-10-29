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
} from "@bflow/contracts";
import {
  digest,
  type JournalState,
  type RunRecord,
} from "../agentic/journal.js";
import { pendingPrototypeApprovals } from "../agentic/prototype-review.js";
import { redactString } from "../resilience/redaction.js";
import { availableActions, terminal } from "./actions.js";
export interface ReadSources {
  state: JournalState;
  sessionId: string;
  observedAt: string;
  core: Map<string, WorkflowRunSnapshot>;
  ready: boolean;
  transport?: { states: AgentTransportState[]; observedAt: string };
  commandsSupported?: boolean;
  pendingClarifications?: import("@bflow/conversation").ConversationContextSnapshot["pendingClarifications"] | undefined;
  redact?: (text: string) => string;
}
const safe = (s: ReadSources, text: string, max = 16000) =>
  (s.redact?.(text) ?? text).slice(0, max) || "[redacted]";
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
  const expired =
    request.expiresAt !== undefined &&
    Date.parse(request.expiresAt) <= Date.parse(s.observedAt);
  return WebDecisionSchema.parse({
    decisionId: request.approvalId,
    runId: r.runId,
    kind,
    status: expired ? "expired" : (request.status ?? "pending"),
    question: safe(s, request.reason),
    options: Array.isArray(request.metadata?.options)
      ? request.metadata.options
          .filter((v): v is string => typeof v === "string")
          .slice(0, 10)
          .map((v) => safe(s, v, 200))
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
    ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
  });
}
export function projectRun(s: ReadSources, runId: string): WebRunView {
  const runs = s.state.runs.filter(
    (r) => r.delegation.sessionId === s.sessionId,
  );
  const r = runs.find((r) => r.runId === runId);
  if (!r) throw new Error("not_found");
  const core = r.coreCreated ? s.core.get(runId) : undefined;
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
      decisions.push(projectDecision(s, r, r.approval, "approval"));
    for (const d of Object.values(r.userDecisions ?? {}))
      if (d.status === "pending")
        decisions.push(projectDecision(s, r, d.request, "user_decision"));
    for (const request of pendingPrototypeApprovals(r.prototype))
      decisions.push(projectDecision(s, r, request, "approval"));
  }
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
  return WebRunViewSchema.parse({
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
    title: safe(s, r.delegation.title, 200),
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
      ...(r.error
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
}
export function paginateRuns(s: ReadSources, input: WebRunQuery) {
  const query = WebRunQuerySchema.parse(input);
  const rows = s.state.runs
    .filter((r) => r.delegation.sessionId === s.sessionId)
    .sort((a, b) => a.runId.localeCompare(b.runId))
    .map((r) => projectRun(s, r.runId))
    .filter(
      (v) =>
        (!query.search ||
          v.title.toLowerCase().includes(query.search.toLowerCase())) &&
        (!query.sdlcStatus || v.sdlcStatus === query.sdlcStatus),
    );
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
} from "@bflow/contracts";
import { ConversationContextSnapshotSchema } from "@bflow/conversation";
import { ProjectionSnapshots } from "./projection-snapshots.js";
import type { HostConfiguration } from "../agentic/host-controller.js";
import { InteractionQuerySchema } from "./schemas.js";
import { interactionProjectId } from "./client.js";
const projectionSnapshots = new ProjectionSnapshots();
async function readSnapshot(path: string): Promise<unknown | undefined>;
async function readSnapshot<T>(path: string, decode: (bytes: Buffer) => T): Promise<T | undefined>;
async function readSnapshot(path: string, decode?: (bytes: Buffer) => unknown): Promise<unknown | undefined> {
  let file;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw new Error("Invalid read source");
    const bytes = await file.readFile();
    if (bytes.byteLength > 16 * 1024 * 1024)
      throw new Error("Read source too large");
    return decode ? decode(bytes) : JSON.parse(bytes.toString("utf8"));
  } finally {
    await file.close();
  }
}
export async function hostInteractionQuery(
  configuration: HostConfiguration,
  input: unknown,
  options: {
    ready: boolean;
    commandsSupported?: boolean;
    readCore?: (runId: string) => Promise<WorkflowRunSnapshot | undefined>;
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
  const journal = await readSnapshot(journalPath, bytes => projectionSnapshots.parse(journalPath, configuration.repositoryPath, bytes));
  const state =
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
  const core = new Map<string, WorkflowRunSnapshot>();
  for (const r of state.runs.filter(
    (r) => r.delegation.sessionId === sessionId && r.coreCreated,
  )) {
    const value = await options.readCore?.(r.runId);
    if (value) {
      const parsed = WorkflowRunSnapshotSchema.parse(value);
      if (parsed.runId !== r.runId) throw new Error("Core scope mismatch");
      core.set(r.runId, parsed);
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
  const redact = (text: string) => {
    for (const value of secrets)
      if (value) text = text.split(value).join("[redacted]");
    return redactString(text).replace(
      /(?:Bearer\s+\S+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*\S+|\/(?:[^\s/]+\/)+[^\s]*)/gi,
      "[redacted]",
    );
  };
  const rawContext = await readSnapshot(join(root, "agentic/conversation", sessionId + ".context.json"));
  const context = rawContext === undefined ? undefined : ConversationContextSnapshotSchema.parse(rawContext);
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
        title: redact(p.draft.title ?? "Yêu cầu cần làm rõ").slice(0, 200),
        status: "clarifying" as const,
        clarifications: p.unresolvedQuestions
          .slice(0, 100)
          .map((question, index) => ({
            questionId:
              "question-" + digest([p.correlationId, index, question]),
            question: redact(question).slice(0, 16000),
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
    .flatMap((r) => projectRun(source, r.runId).decisions);
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
