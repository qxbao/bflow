import { describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import type { DomainEvent } from "@ai-flow/contracts";
import {
  AsyncQueue,
  createDomainEventStream,
  DefaultRunEventHub
} from "../../src/stream.js";
import { createSampleWorkflowDefinition, createTestHarness } from "./fixtures.js";

function mockEvent(runId: string, sequence: number, type: "run.status_changed" = "run.status_changed"): DomainEvent {
  return {
    schemaVersion: 1,
    eventId: `evt-${runId}-${sequence}`,
    runId,
    sequence,
    aggregateVersion: sequence,
    occurredAt: new Date().toISOString(),
    correlationId: `corr-${sequence}`,
    idempotencyKey: `idemp-${sequence}`,
    type: "run.status_changed",
    payload: { from: "running", to: "succeeded" }
  };
}

describe("DefaultRunEventHub", { timeout: 30000 }, () => {
  it("delivers published events to subscribers of the specific runId", () => {
    const hub = new DefaultRunEventHub();
    const receivedA: DomainEvent[] = [];
    const receivedB: DomainEvent[] = [];

    hub.subscribe("run-1", (events) => receivedA.push(...events));
    hub.subscribe("run-2", (events) => receivedB.push(...events));

    const event1 = mockEvent("run-1", 1);
    const event2 = mockEvent("run-2", 1);

    hub.publish("run-1", [event1]);
    hub.publish("run-2", [event2]);

    expect(receivedA).toEqual([event1]);
    expect(receivedB).toEqual([event2]);
  });

  it("handles listener exception safely without disrupting other subscribers", () => {
    const hub = new DefaultRunEventHub();
    const received: DomainEvent[] = [];

    hub.subscribe("run-1", () => {
      throw new Error("faulty listener");
    });
    hub.subscribe("run-1", (events) => received.push(...events));

    const event1 = mockEvent("run-1", 1);
    expect(() => hub.publish("run-1", [event1])).not.toThrow();
    expect(received).toEqual([event1]);
  });

  it("unsubscribes listener cleanly", () => {
    const hub = new DefaultRunEventHub();
    const received: DomainEvent[] = [];

    const unsubscribe = hub.subscribe("run-1", (events) => received.push(...events));
    hub.publish("run-1", [mockEvent("run-1", 1)]);
    expect(received).toHaveLength(1);

    unsubscribe();
    hub.publish("run-1", [mockEvent("run-1", 2)]);
    expect(received).toHaveLength(1);
  });
});

describe("AsyncQueue", { timeout: 30000 }, () => {
  it("pushes and pops items in FIFO order", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);

    expect(await queue.pop()).toBe(1);
    expect(await queue.pop()).toBe(2);
    expect(await queue.pop()).toBe(3);
  });

  it("resolves pending pop waiter when item is pushed later", async () => {
    const queue = new AsyncQueue<string>();
    const promise = queue.pop();

    queue.push("hello");
    const result = await promise;
    expect(result).toBe("hello");
  });

  it("enforces maxBufferSize backpressure limit", () => {
    const queue = new AsyncQueue<number>({ maxBufferSize: 2 });
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.push(3)).toBe(false); // buffer overflow
  });

  it("closes cleanly and resolves waiters with undefined", async () => {
    const queue = new AsyncQueue<number>();
    const promise = queue.pop();

    queue.close();
    expect(await promise).toBeUndefined();
    expect(await queue.pop()).toBeUndefined();
    expect(queue.push(42)).toBe(false);
  });

  it("aborts when AbortSignal fires", async () => {
    const controller = new AbortController();
    const queue = new AsyncQueue<number>({ signal: controller.signal });

    const promise = queue.pop();
    controller.abort();

    expect(await promise).toBeUndefined();
  });

  it("cleans up AbortSignal listener when closed before abort", () => {
    const controller = new AbortController();
    const queue = new AsyncQueue<number>({ signal: controller.signal });

    expect(getEventListeners(controller.signal, "abort").length).toBe(1);

    queue.close();

    expect(getEventListeners(controller.signal, "abort").length).toBe(0);
  });

  it("supports force push to bypass maxBufferSize backpressure limit", () => {
    const queue = new AsyncQueue<number>({ maxBufferSize: 2 });
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.push(3)).toBe(false); // backpressure enforced

    // Force push allows terminal/urgent item delivery
    expect(queue.push(3, { force: true })).toBe(true);
    expect(queue.forcePush(4)).toBe(true);
  });
});

describe("createDomainEventStream", { timeout: 30000 }, () => {
  it("yields validation error on invalid runId", async () => {
    const harness = await createTestHarness();
    try {
      const hub = new DefaultRunEventHub();
      const stream = createDomainEventStream(harness.ports, hub, "");
      const items = [];
      for await (const item of stream) {
        items.push(item);
      }
      expect(items).toHaveLength(1);
      expect(items[0].ok).toBe(false);
      if (!items[0].ok) {
        expect(items[0].error.code).toBe("validation");
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("yields cancelled error if signal aborted before start", async () => {
    const harness = await createTestHarness();
    try {
      const hub = new DefaultRunEventHub();
      const controller = new AbortController();
      controller.abort();

      const stream = createDomainEventStream(harness.ports, hub, "run-1", { signal: controller.signal });
      const items = [];
      for await (const item of stream) {
        items.push(item);
      }
      expect(items).toHaveLength(1);
      expect(items[0].ok).toBe(false);
      if (!items[0].ok) {
        expect(items[0].error.code).toBe("cancelled");
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("yields historical events and then live events with monotonic deduplication", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-stream-test";
      const requestedAt = new Date().toISOString();

      await harness.engine.validateDefinition(definition);
      const createRes = await harness.engine.createRun({
        runId,
        definition,
        idempotencyKey: "c-1",
        createdAt: requestedAt
      });
      if (!createRes.ok) throw new Error("createRun failed");

      const initialSnapshot = {
        ...createRes.value.snapshot,
        version: 0,
        lastEventSequence: 0
      };
      await harness.runStore.create({ snapshot: initialSnapshot, definition }, "create-idemp");

      // Append 2 historical events from createRun
      const appendRes = await harness.runStore.appendEvents({
        runId,
        expectedVersion: 0,
        expectedLastSequence: 0,
        events: createRes.value.emittedEvents,
        idempotencyKey: "append-hist"
      });
      if (!appendRes.ok) throw new Error(appendRes.error.message);

      const hub = new DefaultRunEventHub();
      const stream = createDomainEventStream(harness.ports, hub, runId);

      const yielded: DomainEvent[] = [];
      const iterator = stream[Symbol.asyncIterator]();

      const item1 = await iterator.next();
      expect(item1.done).toBe(false);
      expect(item1.value.ok).toBe(true);
      if (item1.value.ok) yielded.push(item1.value.value);

      const item2 = await iterator.next();
      expect(item2.done).toBe(false);
      expect(item2.value.ok).toBe(true);
      if (item2.value.ok) yielded.push(item2.value.value);

      expect(yielded.map((e) => e.sequence)).toEqual([1, 2]);

      // Publish live terminal event to hub
      const liveTerminal = mockEvent(runId, 3, "run.status_changed");
      setTimeout(() => {
        hub.publish(runId, [liveTerminal]);
      }, 50);

      const item3 = await iterator.next();
      expect(item3.done).toBe(false);
      expect(item3.value.ok).toBe(true);
      if (item3.value.ok) {
        expect(item3.value.value.sequence).toBe(3);
        expect(item3.value.value.type).toBe("run.status_changed");
      }

      const item4 = await iterator.next();
      expect(item4.done).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("yields validation error when event buffer overflows and halts further enqueuing", async () => {
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-overflow-test";
      await harness.engine.validateDefinition(definition);
      const createRes = await harness.engine.createRun({
        runId,
        definition,
        idempotencyKey: "c-overflow",
        createdAt: new Date().toISOString()
      });
      await harness.runStore.create(
        { snapshot: { ...createRes.value.snapshot, version: 0, lastEventSequence: 0 }, definition },
        "create-idemp"
      );

      const hub = new DefaultRunEventHub();
      const stream = createDomainEventStream(harness.ports, hub, runId, { maxBufferSize: 2 });

      const mockNonTerminal = (seq: number): DomainEvent => ({
        schemaVersion: 1,
        eventId: `evt-${runId}-${seq}`,
        runId,
        sequence: seq,
        aggregateVersion: seq,
        occurredAt: new Date().toISOString(),
        correlationId: `corr-${seq}`,
        idempotencyKey: `idemp-${seq}`,
        type: "task.status_changed",
        payload: {
          taskId: "plan",
          from: "ready",
          to: "running",
          attemptId: "att-1"
        }
      } as unknown as DomainEvent);

      // Publish 4 non-terminal events to a stream configured with maxBufferSize: 2
      const ev1 = mockNonTerminal(1);
      const ev2 = mockNonTerminal(2);
      const ev3 = mockNonTerminal(3);
      const ev4 = mockNonTerminal(4);

      setTimeout(() => {
        hub.publish(runId, [ev1, ev2, ev3, ev4]);
      }, 50);

      const results = [];
      for await (const item of stream) {
        results.push(item);
      }

      // Expected: event 1, event 2, event 3, and the buffer overflow error
      expect(results).toHaveLength(4);
      expect(results[0].ok).toBe(true);
      expect(results[1].ok).toBe(true);
      expect(results[2].ok).toBe(true);
      expect(results[3].ok).toBe(false);
      if (!results[3].ok) {
        expect(results[3].error.code).toBe("validation");
        expect(results[3].error.message).toContain("Event buffer overflow for runId: run-overflow-test");
      }
    } finally {
      await harness.cleanup();
    }
  });
});
