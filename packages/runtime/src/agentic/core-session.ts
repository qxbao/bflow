import {
  AppendEventsRequestSchema, DomainEventSchema, StoredRunSchema, WorkflowAdvanceResultSchema,
  parseRecoveryCheckpointWithCompatibility, decodeWorkflowAggregateCheckpointState,
  WorkflowRunSnapshotSchema, type OperationResult, type WorkflowAdvanceResult, type WorkflowRunSnapshot
} from "@bflow/contracts";
import type { AgenticRuntimePorts } from "./ports.js";
import { type JournalState, type RunRecord } from "./journal.js";
import { unwrap } from "./outbox.js";
import { eventTailCursor } from "../recovery.js";

/** Core event batches are journaled before SQLite writes. Recovery replays authoritative events. */
export class CoreSession {
  constructor(private readonly ports: AgenticRuntimePorts, private readonly state: JournalState,
    private readonly save: () => Promise<void>) {}
  async flush(): Promise<void> {
    while (this.state.pendingCore.length) {
      unwrap(await this.ports.runStore.appendEvents(AppendEventsRequestSchema.parse(this.state.pendingCore[0])));
      this.state.pendingCore.shift(); await this.save();
    }
  }
  async snapshot(runId: string): Promise<WorkflowRunSnapshot> {
    const value = unwrap(await this.ports.engine.getSnapshot(runId));
    if (!value) throw new Error("Core run missing");
    return WorkflowRunSnapshotSchema.parse(value);
  }
  async mutate(runId: string, action: (snapshot: WorkflowRunSnapshot) => Promise<OperationResult<WorkflowAdvanceResult>>): Promise<WorkflowRunSnapshot> {
    const before = await this.snapshot(runId);
    const result = WorkflowAdvanceResultSchema.parse(unwrap(await action(before)));
    await this.persist(result, before.version, before.lastEventSequence);
    return result.snapshot;
  }
  private async persist(result: WorkflowAdvanceResult, expectedVersion: number, expectedLastSequence: number): Promise<void> {
    if (result.emittedEvents.length) {
      this.state.pendingCore.push(AppendEventsRequestSchema.parse({ runId: result.snapshot.runId,
        expectedVersion, expectedLastSequence, events: result.emittedEvents,
        idempotencyKey: `p19-events:${result.snapshot.runId}:${result.emittedEvents[0]!.eventId}` }));
      await this.save(); await this.flush();
    }
  }
  async create(run: RunRecord): Promise<void> {
    if (!run.definition) throw new Error("Missing workflow definition");
    const at = run.delegation.requestedAt;
    const result = WorkflowAdvanceResultSchema.parse(unwrap(await this.ports.engine.createRun({
      runId: run.runId, definition: run.definition, createdAt: at, idempotencyKey: `p19-create:${run.runId}`
    })));
    const initial = StoredRunSchema.parse({ definition: run.definition, snapshot: {
      runId: run.runId, workflowId: run.definition.id, workflowVersion: run.definition.version,
      status: "queued", tasks: run.definition.tasks.map(task => ({ taskId: task.id, status: "pending", attempt: 0, generation: 0, version: 0 })),
      createdAt: at, updatedAt: at, version: 0, lastEventSequence: 0
    } });
    const stored = unwrap(await this.ports.runStore.get(run.runId));
    if (!stored) unwrap(await this.ports.runStore.create(initial, `p19-store:${run.runId}`));
    await this.persist(result, 0, 0);
    run.coreCreated = true; await this.save();
  }
  async restore(): Promise<void> {
    await this.flush();
    for (const run of this.state.runs.filter(item => item.coreCreated)) {
      if (!run.definition) throw new Error("Missing persisted definition");
      // Register the actual persisted definition in a newly constructed deterministic engine.
      if (!unwrap(await this.ports.engine.getSnapshot(run.runId))) unwrap(await this.ports.engine.createRun({
        runId: run.runId, definition: run.definition, createdAt: run.delegation.requestedAt,
        idempotencyKey: `p19-create:${run.runId}`
      }));
      const stored = unwrap(await this.ports.runStore.get(run.runId));
      if (!stored) throw new Error("Missing authoritative run store record");
      const rawCheckpoint = unwrap(await this.ports.runStore.loadLatestCheckpoint(run.runId));
      const checkpoint = rawCheckpoint === null ? undefined : unwrap(parseRecoveryCheckpointWithCompatibility(rawCheckpoint));
      if (checkpoint) {
        if (checkpoint.runId !== run.runId || checkpoint.version > stored.snapshot.version || checkpoint.eventSequence > stored.snapshot.lastEventSequence)
          throw new Error("Checkpoint does not belong to the authoritative run history");
        if (checkpoint.codec.name !== "bflow.workflow-aggregate+json" || ![1, 2].includes(checkpoint.codec.version))
          throw new Error("Core recovery requires a complete aggregate checkpoint");
        // The decoder preserves approvals, fencing, cancellation/retry and command outcomes; a query projection is never a substitute.
        unwrap(decodeWorkflowAggregateCheckpointState(checkpoint));
      }
      const events = [];
      let cursor: string | undefined = checkpoint ? eventTailCursor(run.runId, checkpoint.eventSequence) : undefined;
      do {
        const page = unwrap(await this.ports.runStore.readEvents(run.runId, { limit: 100, ...(cursor ? { cursor } : {}) }));
        events.push(...page.items.map(event => DomainEventSchema.parse(event))); cursor = page.nextCursor;
      } while (cursor);
      unwrap(await this.ports.engine.recover({ runId: run.runId, ...(checkpoint ? { checkpoint } : {}), events, expectedVersion: stored.snapshot.version }));
    }
  }
  async hasEvent(runId: string, type: string, id: string): Promise<boolean> {
    let cursor: string | undefined;
    do {
      const page = unwrap(await this.ports.runStore.readEvents(runId, { limit: 100, ...(cursor ? { cursor } : {}) }));
      if (page.items.some(event => {
        if (event.type !== type) return false;
        const payload = event.payload as Record<string, unknown>;
        return payload.evaluationId === id || payload.approvalId === id;
      })) return true;
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  }
  async checkpoint(runId: string): Promise<void> {
    const snapshot = await this.snapshot(runId);
    const checkpoint = unwrap(await this.ports.engine.createCheckpoint({ runId, expectedVersion: snapshot.version,
      checkpointId: `p19-checkpoint:${runId}:${snapshot.version}`, createdAt: snapshot.updatedAt }));
    unwrap(await this.ports.runStore.saveCheckpoint(checkpoint, snapshot.version));
  }
}
