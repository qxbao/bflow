import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { DomainEventSchema, IdentifierSchema, IsoDateTimeSchema, StoredRunSchema, validateEventBatch,
  SdlcWorkStatusSchema, type DomainEvent, type RunStore } from "@bflow/contracts";

const Quality = z.enum(["measured", "estimated", "partial", "unavailable"]);
const Metric = z.object({ value: z.number().finite().nonnegative().nullable(), quality: Quality,
  unit: z.enum(["ms", "count", "ratio", "tokens", "USD"]), numerator: z.number().nonnegative().nullable(),
  denominator: z.number().int().nonnegative(), source: z.string(), limitation: z.string() }).strict();
export const WorkflowTelemetryReportSchema = z.object({
  reportVersion: z.literal(1), runId: IdentifierSchema, asOf: IsoDateTimeSchema,
  source: z.enum(["legacy", "agentic"]), outcome: z.string(),
  outcomeSource: z.enum(["core_events", "host_journal", "unavailable"]),
  hostWorkStatus: SdlcWorkStatusSchema.nullable(),
  sourceCoverage: z.object({ coreEvents: Quality, hostReceipts: Quality }).strict(),
  coverage: z.object({ quality: Quality, events: z.number().int().nonnegative(), highWaterMark: z.number().int().nonnegative(),
    invalidRecords: z.number().int().nonnegative(), diagnostics: z.array(z.string()) }).strict(),
  cohort: z.object({ succeeded: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(), incomplete: z.number().int().nonnegative() }).strict(),
  taskStateTime: z.array(z.object({ taskId: IdentifierSchema, state: z.string(), durationMs: z.number().nonnegative().nullable(),
    intervals: z.number().int().nonnegative(), openLowerBoundMs: z.number().nonnegative().nullable(), quality: Quality }).strict()),
  approvals: z.object({ closed: z.number().int().nonnegative(), open: z.number().int().nonnegative(),
    superseded: z.number().int().nonnegative(), cancelled: z.number().int().nonnegative(), expired: z.number().int().nonnegative(), incompleteAtTerminal: z.number().int().nonnegative(), unpaired: z.number().int().nonnegative() }).strict(),
  gates: z.object({ closed: z.number().int().nonnegative(), open: z.number().int().nonnegative(),
    unpaired: z.number().int().nonnegative(), interrupted: z.number().int().nonnegative(), outcomes: z.object({ passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(), blocked: z.number().int().nonnegative(), error: z.number().int().nonnegative() }).strict() }).strict(),
  phaseRoleIntervals: z.array(z.object({ phase: z.string(), role: z.string(), durationMs: z.number().nonnegative(), operations: z.number().int().nonnegative() }).strict()),
  regressionWideningDetails: z.array(z.object({ tier: z.string(), reason: z.string(), count: z.number().int().nonnegative() }).strict()),
  firstPass: Metric, reworkCycles: Metric, retryAttempts: Metric, approvalWait: Metric, clarificationWait: Metric,
  gateTurnaround: Metric, gateExecution: Metric, phaseRoleTime: Metric, evidenceReuse: Metric,
  regressionWidening: Metric, tokens: Metric, costUsd: Metric
}).strict();
export type WorkflowTelemetryReport = z.infer<typeof WorkflowTelemetryReportSchema>;
type Measurement = z.infer<typeof Metric>;
export interface TelemetryInput {
  runId: string; asOf: string; source: "legacy" | "agentic"; events: readonly unknown[]; complete: boolean;
  taskIds: readonly string[]; highWaterMark?: number; supersededApprovalIds?: readonly string[];
  diagnostics?: readonly string[];
}
const unavailable = (unit: Measurement["unit"], limitation: string): Measurement => ({ value: null, quality: "unavailable", unit,
  numerator: null, denominator: 0, source: "none", limitation });
const terminal = new Set(["succeeded", "failed", "cancelled"]);

/** Ephemeral read model only. No agent text, input, output, reason or finding is copied. */
export function buildWorkflowTelemetry(input: TelemetryInput): WorkflowTelemetryReport {
  const runId = IdentifierSchema.parse(input.runId), asOf = IsoDateTimeSchema.parse(input.asOf), now = Date.parse(asOf);
  const diagnostics = new Set(input.diagnostics ?? []);
  let invalidRecords = 0, conflict = false;
  const byId = new Map<string, DomainEvent>(), bySequence = new Map<number, DomainEvent>();
  for (const raw of input.events) {
    const parsed = DomainEventSchema.safeParse(raw);
    if (!parsed.success || parsed.data.runId !== runId) { invalidRecords++; diagnostics.add("invalid_event"); continue; }
    const e = parsed.data;
    if (input.highWaterMark !== undefined && e.sequence > input.highWaterMark) continue;
    const priorId = byId.get(e.eventId), priorSequence = bySequence.get(e.sequence);
    if ((priorId && !isDeepStrictEqual(priorId, e)) || (priorSequence && !isDeepStrictEqual(priorSequence, e))) {
      conflict = true; diagnostics.add("conflicting_identity");
    }
    byId.set(e.eventId, e); bySequence.set(e.sequence, e);
  }
  // A conflicting identity makes the source untrustworthy; never choose an arrival-order winner.
  let events = conflict ? [] : [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  const batchIssues = validateEventBatch({ runId, expectedVersion: 0, expectedLastSequence: 0, events });
  if (batchIssues.length) diagnostics.add("invalid_event_batch");
  // Ordinary missing sequences are incomplete observation. Conflicting command identities
  // or impossible version/sequence relationships invalidate the whole source scope.
  if (batchIssues.some(issue => issue.field === "idempotencyKey" || issue.field === "eventId" || issue.field === "runId") ||
      events.some(event => event.aggregateVersion !== event.sequence)) events = [];
  const highWaterMark = input.highWaterMark ?? events.at(-1)?.sequence ?? 0;
  if (events.length && (events[0]?.sequence !== 1 || events.some((e, i) => i > 0 && e.sequence !== events[i - 1]!.sequence + 1) ||
      events.at(-1)?.sequence !== highWaterMark)) diagnostics.add("sequence_gap");
  if (!events.some(e => e.type === "run.created" && e.sequence === 1)) diagnostics.add("missing_run_start");
  if (!input.complete) diagnostics.add("incomplete_source");
  let previousTime = -Infinity;
  for (const e of events) {
    const time = Date.parse(e.occurredAt);
    if (time < previousTime || time > now) diagnostics.add("invalid_time_order");
    previousTime = time;
  }
  const taskIds = [...new Set(input.taskIds.map(id => IdentifierSchema.parse(id)))].sort();
  const tasks = new Map(taskIds.map(id => [id, { state: "pending", generation: 0, attempts: 0,
    at: events.find(e => e.type === "run.created")?.occurredAt, reworks: new Set<number>(), retries: new Set<string>() }]));
  const rows = new Map<string, WorkflowTelemetryReport["taskStateTime"][number]>();
  const row = (taskId: string, state: string) => {
    const key = JSON.stringify([taskId, state]);
    if (!rows.has(key)) rows.set(key, { taskId, state, durationMs: null, intervals: 0, openLowerBoundMs: null, quality: "measured" });
    return rows.get(key)!;
  };
  const requests = new Map<string, Extract<DomainEvent, { type: "approval.requested" }>>();
  const gateRequests = new Map<string, Extract<DomainEvent, { type: "quality_gate.evaluation_requested" }>>();
  const settledApprovals = new Set<string>(), settledGates = new Set<string>();
  const superseded = new Set(input.supersededApprovalIds ?? []);
  const approvals = { closed: 0, open: 0, superseded: 0, cancelled: 0, expired: 0, incompleteAtTerminal: 0, unpaired: 0 };
  const gates = { closed: 0, open: 0, unpaired: 0, interrupted: 0, outcomes: { passed: 0, failed: 0, blocked: 0, error: 0 } };
  let approvalMs = 0, gateMs = 0, outcome = "incomplete";
  const span = (start: string, end: string): number | undefined => {
    const a = Date.parse(start), b = Date.parse(end);
    if (b < a || b > now) { diagnostics.add("invalid_time_order"); return undefined; }
    return b - a;
  };
  for (const e of events) {
    if (e.type === "run.created") outcome = "queued";
    if (e.type === "run.status_changed") outcome = e.payload.to;
    if (e.type === "task.status_changed") {
      const task = tasks.get(e.taskId!);
      if (!task) { diagnostics.add("unknown_task"); continue; }
      if (task.state !== e.payload.from || task.generation !== e.payload.generationFrom) diagnostics.add("task_history_gap");
      const r = row(e.taskId!, e.payload.from);
      const duration = task.at === undefined ? undefined : span(task.at, e.occurredAt);
      if (duration !== undefined && task.state === e.payload.from) { r.durationMs = (r.durationMs ?? 0) + duration; r.intervals++; }
      else r.quality = "partial";
      if (e.payload.intent === "rework") task.reworks.add(e.payload.generationTo);
      if (e.payload.intent === "retry") task.retries.add(`${e.payload.generationTo}:${e.payload.attempt}`);
      task.attempts = Math.max(task.attempts, e.payload.attempt);
      task.state = e.payload.to; task.at = e.occurredAt; task.generation = e.payload.generationTo;
    }
    if (e.type === "approval.requested") {
      const old = requests.get(e.payload.approvalId);
      if (old && !isDeepStrictEqual(old.payload, e.payload)) diagnostics.add("conflicting_approval");
      else requests.set(e.payload.approvalId, e);
    }
    if (e.type === "approval.decided" && !settledApprovals.has(e.payload.approvalId)) {
      const request = requests.get(e.payload.approvalId);
      if (!request || superseded.has(e.payload.approvalId) || request.payload.revision !== e.payload.revision ||
          request.payload.generation !== e.payload.generation || !isDeepStrictEqual(request.payload.target, e.payload.target)) {
        approvals.unpaired++; continue;
      }
      const duration = span(request.occurredAt, e.occurredAt);
      if (duration !== undefined) { approvalMs += duration; approvals.closed++; settledApprovals.add(e.payload.approvalId); }
    }
    if (e.type === "quality_gate.evaluation_requested") {
      const old = gateRequests.get(e.payload.evaluationId);
      if (old && (!isDeepStrictEqual(old.payload, e.payload) || old.taskId !== e.taskId)) diagnostics.add("conflicting_evaluation");
      else if (!old) gateRequests.set(e.payload.evaluationId, e);
    }
    if (e.type === "quality_gate.evaluated" && !settledGates.has(e.payload.evaluationId)) {
      const request = gateRequests.get(e.payload.evaluationId);
      if (!request || request.payload.gateId !== e.payload.gateId || request.taskId !== e.payload.taskId) { gates.unpaired++; continue; }
      const duration = span(request.occurredAt, e.occurredAt);
      if (duration !== undefined) { gateMs += duration; gates.closed++; gates.outcomes[e.payload.status]++; settledGates.add(e.payload.evaluationId); }
    }
  }
  for (const [id, task] of tasks) if (!terminal.has(task.state)) {
    const r = row(id, task.state);
    r.openLowerBoundMs = task.at === undefined ? null : span(task.at, asOf) ?? null; r.quality = "partial";
  }
  for (const [id, request] of requests) {
    if (superseded.has(id)) approvals.superseded++;
    else if (!settledApprovals.has(id)) {
      if (request.payload.expiresAt && Date.parse(request.payload.expiresAt) <= now) approvals.expired++;
      else if (outcome === "cancelled") approvals.cancelled++;
      else if (terminal.has(outcome)) approvals.incompleteAtTerminal++;
      else approvals.open++;
    }
  }
  for (const id of superseded) if (!requests.has(id)) diagnostics.add("superseded_request_missing");
  if (terminal.has(outcome)) gates.interrupted = gateRequests.size - settledGates.size;
  else gates.open = gateRequests.size - settledGates.size;
  const good = diagnostics.size === 0;
  const quality = events.length === 0 ? "unavailable" : good ? "measured" : "partial";
  const measure = (value: number | null, unit: Measurement["unit"], numerator: number | null, denominator: number,
    limitation: string, partial = false): Measurement => ({ value, unit, numerator, denominator,
      quality: value === null ? (quality === "partial" ? "partial" : "unavailable") : good && !partial ? "measured" : "partial",
      source: "core_events", limitation });
  const cohort = { succeeded: 0, failed: 0, cancelled: 0, incomplete: 0 };
  let first = 0, reworks = 0, retries = 0;
  for (const task of tasks.values()) {
    if (task.state === "succeeded" || task.state === "failed" || task.state === "cancelled") cohort[task.state]++;
    else cohort.incomplete++;
    if (task.state === "succeeded" && task.generation === 0 && task.attempts <= 1 && task.reworks.size === 0 && task.retries.size === 0) first++;
    reworks += task.reworks.size; retries += task.retries.size;
  }
  return WorkflowTelemetryReportSchema.parse({ reportVersion: 1, runId, asOf, source: input.source, outcome, outcomeSource: events.length ? "core_events" : "unavailable", hostWorkStatus: null,
    sourceCoverage: { coreEvents: quality, hostReceipts: "unavailable" },
    coverage: { quality, events: events.length, highWaterMark, invalidRecords, diagnostics: [...diagnostics].sort() }, cohort,
    taskStateTime: [...rows.values()].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.state.localeCompare(b.state))
      .map(r => ({ ...r, openLowerBoundMs: good && !terminal.has(outcome) ? r.openLowerBoundMs : null, quality: good ? r.quality : "partial" })), approvals, gates,
    phaseRoleIntervals: [], regressionWideningDetails: [],
    firstPass: measure(good && cohort.succeeded > 0 ? first / cohort.succeeded : null, "ratio", good ? first : null,
      good ? cohort.succeeded : 0, "Success-conditional; failed/cancelled/incomplete tasks excluded. Complete history required."),
    reworkCycles: measure(events.length && (good || reworks > 0) ? reworks : null, "count", events.length && (good || reworks > 0) ? reworks : null, tasks.size, "Distinct task generation advances; retries excluded."),
    retryAttempts: measure(events.length && (good || retries > 0) ? retries : null, "count", events.length && (good || retries > 0) ? retries : null, tasks.size, "Distinct retry transitions; separate from rework."),
    approvalWait: measure(approvals.closed ? approvalMs / approvals.closed : null, "ms", approvals.closed ? approvalMs : null,
      approvals.closed, "Mean of closed event-observed waits; untimed supersessions, cancellations, elapsed expiry deadlines and open waits excluded. Expired denotes deadline elapsed, not a human decision.", approvals.open + approvals.superseded + approvals.cancelled + approvals.expired + approvals.incompleteAtTerminal + approvals.unpaired > 0),
    gateTurnaround: measure(gates.closed ? gateMs / gates.closed : null, "ms", gates.closed ? gateMs : null, gates.closed,
      "Core request/result timestamp delta only; evaluatedAt can predate execution completion. Neither execution time nor persistence latency is proven.", true),
    gateExecution: unavailable("ms", "No per-evaluation host start/end execution pair."),
    phaseRoleTime: unavailable("ms", "Core task state is not SDLC phase or authenticated role execution time."),
    clarificationWait: unavailable("ms", "No complete correlated host clarification interval source."),
    evidenceReuse: unavailable("ratio", "Delivery ACK and artifact presence do not prove independent reuse consumers."),
    regressionWidening: unavailable("ratio", "Requires authenticated host regression selection receipts."),
    tokens: unavailable("tokens", "No authenticated provider token-usage source; absence is not zero."),
    costUsd: unavailable("USD", "No authenticated usage and versioned pricing source; absence is not zero.") });
}

/** Bounded snapshot prefix; never follows a growing tail or publishes raw source errors. */
export async function readWorkflowTelemetry(store: Pick<RunStore, "get" | "readEvents">, runId: string,
  options: { asOf?: string; source?: "legacy" | "agentic"; supersededApprovalIds?: readonly string[] } = {}): Promise<WorkflowTelemetryReport> {
  const base = { runId, asOf: options.asOf ?? new Date().toISOString(), source: options.source ?? "legacy",
    supersededApprovalIds: options.supersededApprovalIds ?? [], events: [] as unknown[], taskIds: [] as string[], complete: false };
  try {
    const result = await store.get(runId);
    if (!result.ok) throw new Error("source_unavailable");
    if (result.value === null) return buildWorkflowTelemetry({ ...base, diagnostics: ["run_not_in_core_store"] });
    const stored = StoredRunSchema.parse(result.value);
    if (stored.snapshot.runId !== runId) throw new Error("foreign_run");
    base.taskIds = stored.definition.tasks.map(t => t.id);
    const highWaterMark = stored.snapshot.lastEventSequence;
    let cursor: string | undefined, ended = false;
    const cursors = new Set<string>();
    const pageSchema = z.object({ items: z.array(z.unknown()).max(500), nextCursor: z.string().min(1).optional() }).strict();
    for (let n = 0; n < 200; n++) {
      const page = await store.readEvents(runId, { limit: 500, ...(cursor ? { cursor } : {}) });
      if (!page.ok) throw new Error("source_unavailable");
      const value = pageSchema.parse(page.value);
      base.events.push(...value.items);
      // Stop at the captured prefix, even if concurrent writes leave another page.
      const reachedHead = value.items.some(item => { const e = DomainEventSchema.safeParse(item); return e.success && e.data.runId === runId && e.data.sequence >= highWaterMark; });
      if (reachedHead || !value.nextCursor) { ended = true; break; }
      if (cursors.has(value.nextCursor)) break;
      cursor = value.nextCursor; cursors.add(cursor);
    }
    return buildWorkflowTelemetry({ ...base, highWaterMark, complete: ended });
  } catch {
    return buildWorkflowTelemetry({ ...base, events: [], diagnostics: ["source_unavailable"] });
  }
}
