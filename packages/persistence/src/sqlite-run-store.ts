import type { DatabaseSync as DatabaseConnection, SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "./sqlite.js";
import {
  AppendEventsRequestSchema, AppendEventsResultSchema, IdempotencyKeySchema, IdentifierSchema,
  PageRequestSchema, RunQuerySchema, StoredRunSchema, decodeWorkflowAggregateCheckpointState,
  decodeWorkflowRunCheckpointState, parseDomainEventWithCompatibility, parseRecoveryCheckpointWithCompatibility,
  validateEventBatch, type AppendEventsRequest, type AppendEventsResult, type DomainEvent,
  type OperationOptions, type OperationResult, type Page, type PageRequest, type RecoveryCheckpoint,
  type RunQuery, type RunStore, type StoredRun
} from "@bflow/contracts";
import { migrate } from "./migrations.js";
import { project } from "./projection.js";
import { Budget, StoreFailure, conflict, cursor, digest, fail, failure, fingerprint, parse, position, storedJson, unwrap } from "./support.js";

export interface SqliteRunStoreOptions {
  readonly filename: string;
  readonly busyTimeoutMs?: number;
  readonly clock?: () => number;
}

/** Open explicitly. No singleton, in-memory fallback, or implicit database directory creation. */
export function openSqliteRunStore(options: SqliteRunStoreOptions): OperationResult<SqliteRunStore> {
  let db: DatabaseConnection | undefined;
  try {
    const busy = options.busyTimeoutMs ?? 5_000;
    if (!options.filename || options.filename === ":memory:" || !Number.isSafeInteger(busy) || busy < 0 || busy > 2_147_483_647) fail("validation", "Invalid file-backed SQLite configuration");
    db = new DatabaseSync(options.filename);
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busy}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
    migrate(db);
    return { ok: true, value: new SqliteRunStore(db, busy, options.clock ?? Date.now) };
  } catch (error) { db?.close(); return failure(error); }
}

/** Opaque PageRequest cursor for a checkpoint tail, exclusive of afterSequence. */
export function eventTailCursor(runId: string, afterSequence: number): string {
  const id = parse(IdentifierSchema, runId);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) fail("validation", "Invalid event tail position");
  return cursor(`events:${id}`, afterSequence);
}

export class SqliteRunStore implements RunStore {
  private closed = false;
  constructor(private readonly db: DatabaseConnection, private readonly busy: number, private readonly clock: () => number) {}
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }

  private execute<T>(options: OperationOptions | undefined, work: (budget: Budget) => T): OperationResult<T> {
    try {
      if (this.closed) fail("validation", "Store is closed");
      const budget = new Budget(options, this.clock);
      return { ok: true, value: work(budget) };
    } catch (error) { return failure(error); }
  }
  private transaction<T>(budget: Budget, work: () => T): T {
    budget.check();
    this.db.exec(`PRAGMA busy_timeout=${budget.remaining(this.busy)}`);
    try { this.db.exec("BEGIN IMMEDIATE"); }
    catch (error) { budget.check(); throw error; }
    try {
      budget.check();
      const result = work();
      budget.check();
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private read<T>(options: OperationOptions | undefined, work: () => T): OperationResult<T> {
    return this.execute(options, (budget) => {
      // All rows making up a public response come from one consistent SQLite read snapshot.
      this.db.exec("BEGIN DEFERRED");
      try { const result = work(); budget.check(); this.db.exec("COMMIT"); return result; }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
    });
  }
  private run(runId: string): StoredRun | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id=?").get(runId);
    if (row === undefined) return null;
    const run = parse(StoredRunSchema, storedJson(row.payload, row.digest), true);
    if (run.snapshot.runId !== runId || run.snapshot.version !== row.version || run.snapshot.lastEventSequence !== row.last_sequence ||
      run.snapshot.status !== row.status || run.snapshot.workflowId !== row.workflow_id || Date.parse(run.snapshot.createdAt) !== row.created_at ||
      run.definition.id !== run.snapshot.workflowId || run.definition.version !== run.snapshot.workflowVersion ||
      new Set(run.snapshot.tasks.map((task) => task.taskId)).size !== run.snapshot.tasks.length ||
      run.snapshot.tasks.length !== run.definition.tasks.length ||
      run.definition.tasks.some((task) => !run.snapshot.tasks.some((state) => state.taskId === task.id))) fail("corruption", "Run index or task ownership does not match payload");
    return run;
  }
  private receipt(operation: string, scope: string, key: string, hash: string): unknown | undefined {
    const row = this.db.prepare("SELECT * FROM receipts WHERE operation=? AND scope=? AND idempotency_key=?").get(operation, scope, key);
    if (row === undefined) return undefined;
    if (row.fingerprint !== hash) conflict("Idempotency key has a different payload");
    return storedJson(row.payload, row.digest);
  }
  private saveReceipt(operation: string, scope: string, key: string, hash: string, value: unknown): void {
    const payload = JSON.stringify(value);
    this.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?)").run(operation, scope, key, hash, payload, digest(payload));
  }
  async create(input: StoredRun, key: string, options?: OperationOptions): Promise<OperationResult<StoredRun>> {
    return this.execute(options, (budget) => {
      const run = parse(StoredRunSchema, input);
      if (!Number.isSafeInteger(run.snapshot.version) || !Number.isSafeInteger(run.snapshot.lastEventSequence)) fail("validation", "Run position exceeds safe integer range");
      const idempotencyKey = parse(IdempotencyKeySchema, key);
      const tasks = run.snapshot.tasks.map((task) => task.taskId);
      if (run.snapshot.workflowId !== run.definition.id || run.snapshot.workflowVersion !== run.definition.version ||
        new Set(tasks).size !== tasks.length || tasks.length !== run.definition.tasks.length ||
        run.definition.tasks.some((task) => !tasks.includes(task.id))) fail("validation", "Stored run and workflow definition mismatch");
      return this.transaction(budget, () => {
        const hash = fingerprint(run);
        const old = this.receipt("create", "global", idempotencyKey, hash);
        if (old !== undefined) return parse(StoredRunSchema, old, true);
        const payload = JSON.stringify(run);
        this.db.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?)").run(run.snapshot.runId, run.snapshot.workflowId,
          run.snapshot.status, Date.parse(run.snapshot.createdAt), run.snapshot.version, run.snapshot.lastEventSequence,
          run.snapshot.lastEventSequence, run.snapshot.version, payload, digest(payload));
        this.saveReceipt("create", "global", idempotencyKey, hash, run);
        return run;
      });
    });
  }
  async get(runId: string, options?: OperationOptions): Promise<OperationResult<StoredRun | null>> {
    return this.read(options, () => this.run(parse(IdentifierSchema, runId)));
  }
  async find(input: RunQuery, options?: OperationOptions): Promise<OperationResult<Page<StoredRun>>> {
    return this.read(options, () => {
      const query = parse(RunQuerySchema, input);
      const { cursor: requestCursor, limit = 100, ...filters } = query;
      const scope = `runs:${fingerprint(filters)}`;
      const after = position(requestCursor, scope);
      if (after !== undefined && typeof after !== "string") fail("validation", "Invalid run cursor");
      const clauses = ["run_id > ?"];
      const values: SQLInputValue[] = [after ?? ""];
      if (query.workflowId !== undefined) { clauses.push("workflow_id=?"); values.push(query.workflowId); }
      if (query.status !== undefined) {
        if (!query.status.length) return { items: [] };
        clauses.push(`status IN (${query.status.map(() => "?").join(",")})`); values.push(...query.status);
      }
      if (query.createdAfter !== undefined) { clauses.push("created_at > ?"); values.push(Date.parse(query.createdAfter)); }
      if (query.createdBefore !== undefined) { clauses.push("created_at < ?"); values.push(Date.parse(query.createdBefore)); }
      const rows = this.db.prepare(`SELECT run_id FROM runs WHERE ${clauses.join(" AND ")} ORDER BY run_id LIMIT ?`).all(...values, limit + 1);
      const items = rows.slice(0, limit).map((row) => {
        if (typeof row.run_id !== "string") fail("corruption", "Invalid stored run identifier");
        return this.run(row.run_id) ?? fail("corruption", "Run vanished during query");
      });
      const last = items.at(-1);
      return { items, ...(rows.length > limit && last !== undefined ? { nextCursor: cursor(scope, last.snapshot.runId) } : {}) };
    });
  }
  async appendEvents(input: AppendEventsRequest, options?: OperationOptions): Promise<OperationResult<AppendEventsResult>> {
    return this.execute(options, (budget) => {
      // Compatibility precedes the exported batch validator, even for legacy envelope input.
      const events = Array.isArray(input?.events) ? input.events.map((event) => unwrap(parseDomainEventWithCompatibility(event))) : [];
      const request = parse(AppendEventsRequestSchema, { ...input, events });
      if (!Number.isSafeInteger(request.expectedVersion) || !Number.isSafeInteger(request.expectedLastSequence) ||
        request.events.some((event) => !Number.isSafeInteger(event.sequence) || !Number.isSafeInteger(event.aggregateVersion))) fail("validation", "Event position exceeds safe integer range");
      if (validateEventBatch(request).length) fail("validation", "Invalid event batch");
      return this.transaction(budget, () => {
        const hash = fingerprint(request);
        const previous = this.receipt("append", request.runId, request.idempotencyKey, hash);
        if (previous !== undefined) {
          const result = parse(AppendEventsResultSchema, previous, true);
          return { ...result, duplicate: true, duplicateEventIds: request.events.map((event) => event.eventId) };
        }
        const run = this.run(request.runId) ?? fail("not_found", "Run does not exist");
        if (run.snapshot.version !== request.expectedVersion) conflict("Aggregate version mismatch", request.expectedVersion, run.snapshot.version);
        if (run.snapshot.lastEventSequence !== request.expectedLastSequence) conflict("Event sequence mismatch");
        const projected = project(run, request.events);
        const insert = this.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?)");
        for (const event of request.events) {
          budget.check();
          const payload = JSON.stringify(event);
          insert.run(event.eventId, event.runId, event.sequence, event.aggregateVersion, event.idempotencyKey, payload, digest(payload));
          if (event.type === "command.completed") this.db.prepare("INSERT INTO command_receipts VALUES(?,?,?,?,?)").run(
            event.runId, event.payload.idempotencyKey, event.payload.commandId, event.payload.fingerprint, event.eventId);
        }
        const payload = JSON.stringify(projected);
        this.db.prepare("UPDATE runs SET status=?,version=?,last_sequence=?,payload=?,digest=? WHERE run_id=?").run(
          projected.snapshot.status, projected.snapshot.version, projected.snapshot.lastEventSequence, payload, digest(payload), request.runId);
        const result = parse(AppendEventsResultSchema, { version: projected.snapshot.version,
          lastSequence: projected.snapshot.lastEventSequence, duplicate: false, duplicateEventIds: [] });
        this.saveReceipt("append", request.runId, request.idempotencyKey, hash, result);
        return result;
      });
    });
  }
  async readEvents(runId: string, input: PageRequest = {}, options?: OperationOptions): Promise<OperationResult<Page<DomainEvent>>> {
    return this.read(options, () => {
      const id = parse(IdentifierSchema, runId);
      const page = parse(PageRequestSchema, input);
      if (this.run(id) === null) fail("not_found", "Run does not exist");
      const scope = `events:${id}`;
      const after = position(page.cursor, scope) ?? 0;
      if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0) fail("validation", "Invalid event cursor");
      const limit = page.limit ?? 100;
      const rows = this.db.prepare("SELECT * FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?").all(id, after, limit + 1);
      const baseline = this.db.prepare("SELECT base_sequence,base_version,last_sequence FROM runs WHERE run_id=?").get(id);
      if (typeof baseline?.base_sequence !== "number" || typeof baseline.base_version !== "number" || typeof baseline.last_sequence !== "number") fail("corruption", "Invalid event baseline");
      const baseSequence = baseline.base_sequence;
      const baseVersion = baseline.base_version;
      let expectedSequence = Math.max(after, baseSequence) + 1;
      const items = rows.slice(0, limit).map((row) => {
        const result = parseDomainEventWithCompatibility(storedJson(row.payload, row.digest));
        if (!result.ok) throw new StoreFailure(result.error.code === "validation" ? { ...result.error, code: "corruption" } : result.error);
        const event = result.value;
        if (event.runId !== id || event.eventId !== row.event_id || event.sequence !== row.sequence || event.aggregateVersion !== row.version ||
          event.idempotencyKey !== row.idempotency_key || event.sequence !== expectedSequence++ ||
          event.aggregateVersion !== baseVersion + event.sequence - baseSequence) fail("corruption", "Event index or contiguous position does not match payload");
        return event;
      });
      if (rows.length <= limit && expectedSequence <= baseline.last_sequence) fail("corruption", "Event history is missing committed events");
      const last = items.at(-1);
      return { items, ...(rows.length > limit && last !== undefined ? { nextCursor: eventTailCursor(id, last.sequence) } : {}) };
    });
  }
  private checkpoint(input: unknown, stored = false): RecoveryCheckpoint {
    if (typeof input === "object" && input !== null && "codec" in input && typeof input.codec === "object" && input.codec !== null &&
      "version" in input.codec && typeof input.codec.version === "number" && Number.isSafeInteger(input.codec.version) && input.codec.version >= 0 && input.codec.version !== 1) {
      throw new StoreFailure({ code: "unsupported_version", retryable: false, supportedVersions: [1],
        receivedVersion: input.codec.version, message: "Unsupported checkpoint codec version" });
    }
    const parsed = parseRecoveryCheckpointWithCompatibility(input);
    if (!parsed.ok) throw new StoreFailure(stored && parsed.error.code === "validation" ? { ...parsed.error, code: "corruption" } : parsed.error);
    const checkpoint = parsed.value;
    const state = checkpoint.codec.name === "bflow.workflow-aggregate+json"
      ? unwrap(decodeWorkflowAggregateCheckpointState(checkpoint)).snapshot : unwrap(decodeWorkflowRunCheckpointState(checkpoint));
    if (state.runId !== checkpoint.runId || state.version !== checkpoint.version || state.lastEventSequence !== checkpoint.eventSequence) fail("corruption", "Checkpoint envelope and state positions disagree");
    return checkpoint;
  }
  async saveCheckpoint(input: RecoveryCheckpoint, expectedVersion: number, options?: OperationOptions): Promise<OperationResult<void>> {
    return this.execute(options, (budget) => {
      const checkpoint = this.checkpoint(input);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail("validation", "Invalid expectedVersion");
      return this.transaction(budget, () => {
        const run = this.run(checkpoint.runId) ?? fail("not_found", "Run does not exist");
        if (run.snapshot.version !== expectedVersion) conflict("Checkpoint expectedVersion mismatch", expectedVersion, run.snapshot.version);
        if (checkpoint.version !== expectedVersion || checkpoint.eventSequence !== run.snapshot.lastEventSequence) fail("validation", "Checkpoint is not at the current aggregate position");
        const decoded = checkpoint.codec.name === "bflow.workflow-aggregate+json"
          ? unwrap(decodeWorkflowAggregateCheckpointState(checkpoint)).snapshot : unwrap(decodeWorkflowRunCheckpointState(checkpoint));
        if (decoded.workflowId !== run.definition.id || decoded.workflowVersion !== run.definition.version ||
          decoded.tasks.length !== run.definition.tasks.length || new Set(decoded.tasks.map((task) => task.taskId)).size !== decoded.tasks.length ||
          run.definition.tasks.some((task) => !decoded.tasks.some((state) => state.taskId === task.id))) fail("corruption", "Checkpoint workflow definition or task ownership mismatch");
        const existing = this.db.prepare("SELECT payload,digest FROM checkpoints WHERE checkpoint_id=?").get(checkpoint.checkpointId);
        if (existing !== undefined) {
          if (fingerprint(storedJson(existing.payload, existing.digest)) !== fingerprint(checkpoint)) conflict("Checkpoint identity already has different content");
          return;
        }
        const payload = JSON.stringify(checkpoint);
        this.db.prepare("INSERT INTO checkpoints VALUES(?,?,?,?,?,?)").run(checkpoint.checkpointId, checkpoint.runId,
          checkpoint.version, checkpoint.eventSequence, payload, digest(payload));
      });
    });
  }
  async loadLatestCheckpoint(runId: string, options?: OperationOptions): Promise<OperationResult<RecoveryCheckpoint | null>> {
    return this.read(options, () => {
      const id = parse(IdentifierSchema, runId);
      if (this.run(id) === null) return null;
      const row = this.db.prepare("SELECT * FROM checkpoints WHERE run_id=? ORDER BY version DESC,event_sequence DESC,checkpoint_id DESC LIMIT 1").get(id);
      if (row === undefined) return null;
      const checkpoint = this.checkpoint(storedJson(row.payload, row.digest), true);
      if (checkpoint.runId !== id || checkpoint.version !== row.version || checkpoint.eventSequence !== row.event_sequence ||
        checkpoint.checkpointId !== row.checkpoint_id) fail("corruption", "Checkpoint index mismatch");
      const run = this.run(id) ?? fail("corruption", "Checkpoint run disappeared");
      if (checkpoint.version > run.snapshot.version || checkpoint.eventSequence > run.snapshot.lastEventSequence) fail("corruption", "Checkpoint is ahead of committed history");
      const decoded = checkpoint.codec.name === "bflow.workflow-aggregate+json"
        ? unwrap(decodeWorkflowAggregateCheckpointState(checkpoint)).snapshot : unwrap(decodeWorkflowRunCheckpointState(checkpoint));
      if (decoded.workflowId !== run.definition.id || decoded.workflowVersion !== run.definition.version ||
        decoded.tasks.length !== run.definition.tasks.length || new Set(decoded.tasks.map((task) => task.taskId)).size !== decoded.tasks.length ||
        run.definition.tasks.some((task) => !decoded.tasks.some((state) => state.taskId === task.id))) fail("corruption", "Stored checkpoint workflow or task ownership mismatch");
      return checkpoint;
    });
  }
}
