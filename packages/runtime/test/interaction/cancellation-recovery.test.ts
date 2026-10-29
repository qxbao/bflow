import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebCommandSchema, RoleMessageSchema, type JsonValue } from "@bflow/contracts";
import { fixture, now } from "./web-command-fixtures.js";
import { WebInteractionAuthority } from "../../src/interaction/authority.js";
import { WebOperationStore } from "../../src/interaction/operation-store.js";
import { recoverUnqueuedWebCancellations } from "../../src/interaction/cancellation-recovery.js";
const isoNow = new Date(now).toISOString();
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function setup(kind = "cancel", dispatched = true, repository = "/repo") {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), "web-cancel-recovery-")); dirs.push(directory);
  const authority = new WebInteractionAuthority("project-1", "host-1", () => now); authority.registerOwnerKey(f.registration);
  const command = kind === "cancel" ? WebCommandSchema.parse({ apiVersion: 1, projectId: "project-1", commandId: f.command.commandId,
    kind: "cancel", runId: "run-1", expectedVersion: { revisionToken: "a".repeat(64) }, reason: "Stop" }) : f.command;
  const options = { directory, repository, sessionId: "host-1", projectId: "project-1" };
  const store = new WebOperationStore(options);
  await store.accept(command, f.proof(command), authority);
  if (dispatched) await store.begin("local-user-1", command.commandId);
  const state = { repository: "/repo", runs: [{ runId: "run-1", status: "implementing", cancelled: false, nativeDeliveries: [] }], outbound: [], inbox: [], pendingCore: [] };
  return { command, state, store: new WebOperationStore(options), original: store };
}
it("settles only a restarted cancellation proven absent from the retained queue, without replay", async () => {
  const f = await setup();
  expect(await recoverUnqueuedWebCancellations(f.original, f.state, isoNow)).toEqual([]); // Still active in this process.
  expect(await recoverUnqueuedWebCancellations(f.store, f.state, isoNow)).toEqual([f.command.commandId]);
  expect(await f.store.read("local-user-1", f.command.commandId)).toMatchObject({ state: "failed", error: { code: "operation_not_allowed" } });
  expect(f.state.outbound).toEqual([]);
  expect(await recoverUnqueuedWebCancellations(f.store, f.state, isoNow)).toEqual([]);
});
it.each(["queued", "unknown_delivery", "released"])("retains %s cancellation uncertainty even when no outcome is recorded", async status => {
  const f = await setup();
  const message = RoleMessageSchema.parse({ schema_version: 2, message_id: `web-delegation-${f.command.commandId}`, correlation_id: "c",
    run_id: "run-1", sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {},
    artifact_references: [], occurred_at: isoNow, idempotency_key: `web-cancel-${f.command.commandId}` });
  const state: JsonValue = { ...f.state, outbound: [{ message, status }] };
  expect(await recoverUnqueuedWebCancellations(f.store, state, isoNow)).toEqual([]);
  expect(await f.store.read("local-user-1", f.command.commandId)).toMatchObject({ state: "reconciliation_required" });
});
it.each(["foreign", "unknown_native", "core_pending", "cancelled"])("refuses negative proof with %s state", async kind => {
  const f = await setup(); const state: JsonValue = { ...f.state,
    ...(kind === "foreign" ? { repository: "/other" } : {}),
    ...(kind === "core_pending" ? { pendingCore: [{}] } : {}),
    runs: [{ ...f.state.runs[0]!, ...(kind === "unknown_native" ? { nativeDeliveries: [{}] } : {}), ...(kind === "cancelled" ? { cancelled: true } : {}) }] };
  expect(await recoverUnqueuedWebCancellations(f.store, state, isoNow)).toEqual([]);
});
it("never settles other interrupted mutations from absence of a queue message", async () => {
  const f = await setup("create"); expect(await recoverUnqueuedWebCancellations(f.store, f.state, isoNow)).toEqual([]);
});

it("retains accepted-only intent without manufacturing a dispatch receipt", async () => {
  const f = await setup("cancel", false);
  expect(await f.store.hasDispatchIntent("local-user-1", f.command.commandId)).toBe(false);
  expect(await recoverUnqueuedWebCancellations(f.store, f.state, isoNow)).toEqual([]);
  expect(await f.store.hasDispatchIntent("local-user-1", f.command.commandId)).toBe(false);
});

import { fixture as runtimeFixture, cleanups } from "../helpers/agentic-integration-fixture.js";
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
it("uses the full Runtime journal at owner recovery instead of the compact inspect projection", async () => {
  const runtime = await runtimeFixture();
  const f = await setup("cancel", true, runtime.repository);
  expect(await recoverUnqueuedWebCancellations(f.store, await runtime.runtime.inspect(), isoNow)).toEqual([]);
  expect(await runtime.runtime.recoverUnqueuedWebCancellations(f.store)).toEqual([f.command.commandId]);
  expect(await runtime.runtime.inspect("run-1")).toMatchObject({ cancelled: false });
});
