import { describe, expect, it } from "vitest";
import type { TaskDependency } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "../src/index.js";
import { Driver, definition, statusOf, time, unwrap } from "./helpers/parked-fixtures.js";

// B2b Task 12 (R-B2-14) property: over random DAGs, parking a random set of ready tasks lets every task with no
// dependency path to a parked task succeed, holds every task behind one `pending`, leaves the run `blocked`,
// and unparking everything lets the run succeed.

const BASE_SEED = 0x5eed_b2b0;
const RUNS = 300;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  readonly ids: readonly string[];
  readonly dependencies: readonly TaskDependency[];
  readonly parkSet: ReadonlySet<string>;
  readonly maxConcurrency: number;
}

function generate(seed: number): Case {
  const random = mulberry32(seed);
  const size = 3 + Math.floor(random() * 10);
  const ids = Array.from({ length: size }, (_, index) => `t${index}`);
  const dependencies: TaskDependency[] = [];
  for (let to = 1; to < size; to += 1) {
    for (let from = 0; from < to; from += 1) {
      if (random() < 0.3) dependencies.push({ taskId: ids[to]!, dependsOnTaskId: ids[from]!, condition: random() < 0.5 ? "succeeded" : "completed" });
    }
  }
  const parkSet = new Set(ids.filter(() => random() < 0.3));
  if (parkSet.size === 0) parkSet.add(ids[Math.floor(random() * size)]!);
  return { ids, dependencies, parkSet, maxConcurrency: 1 + Math.floor(random() * 3) };
}

/** Tasks with a dependency path (either condition) to some parked task. */
function behindParked(item: Case, parked: ReadonlySet<string>): Set<string> {
  const behind = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const dependency of item.dependencies) {
      if ((parked.has(dependency.dependsOnTaskId) || behind.has(dependency.dependsOnTaskId)) && !behind.has(dependency.taskId)) {
        behind.add(dependency.taskId);
        grew = true;
      }
    }
  }
  return behind;
}

async function drain(driver: Driver, item: Case, park: (driver: Driver) => Promise<void>): Promise<void> {
  for (let guard = 0; guard < 200; guard += 1) {
    if (["succeeded", "failed", "cancelled"].includes(driver.state.snapshot.status)) return;
    await park(driver);
    await driver.advance();
    const running = item.ids.filter((id) => statusOf(driver.state, id) === "running");
    if (running.length === 0) return;
    for (const id of running) await driver.succeed(id);
  }
  throw new Error("drain did not settle");
}

async function check(seed: number): Promise<void> {
  const item = generate(seed);
  const workflow = definition(item.ids, item.dependencies, { maxConcurrency: item.maxConcurrency });
  const engine = new DeterministicWorkflowEngine({ definitions: [workflow] });
  const runId = `run-${seed.toString(16)}`;
  const driver = new Driver(engine, unwrap(await engine.createRun({ runId, definition: workflow, idempotencyKey: `${runId}/create`, createdAt: time })));
  const parked = new Set<string>();

  // A park-set task is made ready administratively once its dependencies hold, then parked while ready,
  // before the scheduler can start it.
  await drain(driver, item, async (current) => {
    for (const id of item.parkSet) {
      if (parked.has(id) || !["pending", "ready"].includes(statusOf(current.state, id))) continue;
      if (statusOf(current.state, id) === "pending") {
        const ready = await current.transition(id, "ready", "normal");
        if (!ready.ok) continue;
        current.state = ready.value;
      }
      await current.move(id, "parked", "park");
      parked.add(id);
    }
  });

  expect(parked.size).toBeGreaterThan(0);
  const behind = behindParked(item, parked);
  for (const id of item.ids) {
    const status = statusOf(driver.state, id);
    if (parked.has(id)) expect(status, id).toBe("parked");
    else if (behind.has(id)) expect(status, id).toBe("pending");
    else expect(status, id).toBe("succeeded");
  }
  expect(driver.state.snapshot.status).toBe("blocked");

  for (const id of parked) await driver.move(id, "ready", "unpark");
  await drain(driver, item, async () => {});
  for (const id of item.ids) expect(statusOf(driver.state, id), id).toBe("succeeded");
  expect(driver.state.snapshot.status).toBe("succeeded");
}

describe("parked property (R-B2-14)", () => {
  it(`holds for ${RUNS} random DAGs of 3-12 tasks`, async () => {
    for (let index = 0; index < RUNS; index += 1) {
      const seed = (BASE_SEED + index) >>> 0;
      try {
        await check(seed);
      } catch (error) {
        throw new Error(`parked property failed for seed 0x${seed.toString(16)} (run ${index}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, 120_000);
});
