import { afterEach, describe, expect, it, vi } from "vitest";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { RoleMessageSchema } from "@bflow/contracts";
import { CoreSession } from "../../src/agentic/core-session.js";
import { eventTailCursor } from "../../src/recovery.js";
import { lifecycleFixture } from "../helpers/lifecycle-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!result.ok) throw Error(result.error.message); return result.value; };
async function prepared() {
  const f = await lifecycleFixture(cleanups);
  await f.runtime.queueHerdr(f.intakeMessage); await f.runtime.flushOutbound(); await f.runtime.receiveHerdr(f.intakeMessage);
  const analysis = RoleMessageSchema.parse(await f.runtime.requestSpecialist("run-1", "architect", "Analyze impact", ["architecture"]));
  await f.runtime.flushOutbound(); await f.runtime.receiveHerdr(f.reply("architect", analysis, "spec.draft", { status: "completed", summary: "Impact analysis" }));
  await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
  const before = unwrap(await f.ports.engine.getSnapshot("run-1"))!;
  await f.runtime.checkpoint({ runId: "run-1", expectedVersion: before.version, checkpointId: "authoritative-before-dispatch", createdAt: new Date().toISOString() });
  await f.runtime.tick();
  const checkpoint = unwrap(await f.ports.runStore.loadLatestCheckpoint("run-1"))!;
  const state = await (f.runtime as any).journal.exclusive(async (value: any) => structuredClone(value));
  return { f, checkpoint, state };
}
describe.skipIf(process.platform !== "linux")("authoritative Core checkpoint restore", () => {
  it("restores a complete aggregate plus only its event tail and preserves command outcomes", async () => {
    const { f, checkpoint, state } = await prepared();
    const engine = new DeterministicWorkflowEngine(), recover = vi.spyOn(engine, "recover"), reads = vi.spyOn(f.ports.runStore, "readEvents");
    const latest = vi.spyOn(f.ports.runStore, "loadLatestCheckpoint");
    await new CoreSession({ ...f.ports, engine }, state, async () => undefined).restore();
    expect(latest).toHaveBeenCalledWith("run-1");
    expect(reads.mock.calls[0]![1]).toMatchObject({ cursor: eventTailCursor("run-1", checkpoint.eventSequence), limit: 100 });
    const command = recover.mock.calls[0]![0]; expect(command.checkpoint).toEqual(checkpoint);
    expect(command.events.length).toBeGreaterThan(0); expect(command.events.every(event => event.sequence > checkpoint.eventSequence)).toBe(true);
    const restored = unwrap(await engine.getSnapshot("run-1"))!; expect(restored).toEqual(unwrap(await f.ports.engine.getSnapshot("run-1")));
    const expected = unwrap(await f.ports.engine.createCheckpoint({ runId: "run-1", expectedVersion: restored.version, checkpointId: "expected-aggregate", createdAt: new Date().toISOString() }));
    const actual = unwrap(await engine.createCheckpoint({ runId: "run-1", expectedVersion: restored.version, checkpointId: "restored-aggregate", createdAt: new Date().toISOString() }));
    expect(actual.state).toEqual(expected.state);
  }, 90000);
  it.each(["codec", "aggregate", "foreign"])("rejects a %s checkpoint rather than falling back to projection or full history", async kind => {
    const { f, checkpoint, state } = await prepared(); const engine = new DeterministicWorkflowEngine();
    const invalid = structuredClone(checkpoint) as any;
    if (kind === "codec") invalid.codec.version = 999;
    if (kind === "aggregate") invalid.state = { corruptAggregate: true };
    if (kind === "foreign") invalid.runId = "foreign-run";
    vi.spyOn(f.ports.runStore, "loadLatestCheckpoint").mockResolvedValue({ ok: true, value: invalid });
    const reads = vi.spyOn(f.ports.runStore, "readEvents");
    await expect(new CoreSession({ ...f.ports, engine }, state, async () => undefined).restore()).rejects.toThrow();
    expect(reads).not.toHaveBeenCalled();
  }, 90000);
  it("retains complete event recovery when the store has no checkpoint", async () => {
    const { f, state } = await prepared(), engine = new DeterministicWorkflowEngine();
    vi.spyOn(f.ports.runStore, "loadLatestCheckpoint").mockResolvedValue({ ok: true, value: null });
    const reads = vi.spyOn(f.ports.runStore, "readEvents"), recover = vi.spyOn(engine, "recover");
    await new CoreSession({ ...f.ports, engine }, state, async () => undefined).restore();
    expect(reads.mock.calls[0]![1]).toEqual({ limit: 100 }); expect(recover.mock.calls[0]![0].checkpoint).toBeUndefined();
    expect(recover.mock.calls[0]![0].events[0]!.sequence).toBe(1);
    expect(unwrap(await engine.getSnapshot("run-1"))).toEqual(unwrap(await f.ports.engine.getSnapshot("run-1")));
  }, 90000);

});
