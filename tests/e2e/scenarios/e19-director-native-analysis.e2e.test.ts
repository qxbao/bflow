import { describe, expect, it } from "vitest";
import { ApprovalDecisionSchema } from "@bflow/contracts";
import { record } from "../../../packages/runtime/src/agentic/journal.js";
import { directorNativeFlow } from "../../../packages/runtime/test/helpers/director-native-flow.js";

// Source/local fake-runner evidence: the real admission, Director token, human gateway, native SDK and signed output ingress.

async function started() {
  const f = await directorNativeFlow(), first = record(await f.start()), runId = String(first.runId);
  expect(await f.start()).toEqual(first);
  expect((await f.runtime.inspect() as any).runs).toHaveLength(1);
  await f.endpoint.call(f.token, "start_extension", { runId, kind: "analysis", intake: f.intake, packPin: f.pin });
  return { f, runId };
}

async function finish(f: Awaited<ReturnType<typeof directorNativeFlow>>, runId: string) {
  const business = (await f.host.pendingApprovals())[0]!;
  expect(business.metadata?.approvalScope).toBe("business_decisions");
  expect(await f.answer(business, { "D-1": "Ops" })).toMatchObject({ ok: true });
  await f.pump.tick(); await f.pump.drain();
  const document = (await f.host.pendingApprovals())[0]!;
  expect(document.metadata?.approvalScope).toBe("analysis_document");
  expect(await f.answer(document)).toMatchObject({ ok: true });
  await f.pump.tick(); await f.pump.drain();
  expect(await f.host.inspect(runId)).toMatchObject({ status: "completed", extensionStatus: "published" });
  expect(await f.engine.getSnapshot(runId)).toMatchObject({ ok: true, value: { status: "succeeded" } });
  const completion = f.notices.filter(message => record(message.payload).kind === "extension_completed");
  expect(completion).toHaveLength(1);
  await f.publish(completion[0]!);
  expect((await f.endpoint.readMailbox({ audience: "user" })).filter(item => item.messageId === completion[0]!.message_id)).toHaveLength(1);
  expect(f.native.transport.sentRequests.map(request => request.role)).toEqual(["architect", "specifier", "specifier", "reviewer"]);
  expect(f.parent.transport.sentRequests).toHaveLength(0);
  for (const command of f.issuedCommands) {
    expect(await f.webCommands.readOperation("human-1", command.commandId)).toMatchObject({ ok: true, value: { state: "applied" } });
  }
  const human = await f.webStore.humanDecisions("session-1");
  const events = await f.native.runStore.readEvents(runId, { limit: 100 });
  if (!events.ok) throw new Error(events.error.message);
  const applied = events.value.items.filter(event => event.type === "approval.decided").map(event => ApprovalDecisionSchema.parse(event.payload));
  const byApproval = (a: typeof human[number], b: typeof human[number]) => a.approvalId.localeCompare(b.approvalId);
  expect([...applied].sort(byApproval)).toEqual([...human].sort(byApproval));
  expect(human).toHaveLength(2);
  expect(human.every(decision => decision.metadata === undefined)).toBe(true);
}

describe("E19 Director native BA-only", () => {
  it("starts via Director, waits for authenticated Web decisions and publishes one completion", async () => {
    const { f, runId } = await started();
    await expect(f.endpoint.call(f.token, "approve", { runId })).rejects.toThrow(/Unknown Director tool|unavailable/);
    await f.pump.tick(); await f.pump.drain();
    await finish(f, runId);
  });

  it("cancels during a native execution and releases the in-flight wait", async () => {
    const { f, runId } = await started();
    let arrived!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { arrived = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
    const wait = f.native.native.waitResult;
    f.native.native.waitResult = async id => { arrived(); await waiting; return wait(id); };
    await f.pump.tick(); await entered;
    try {
      f.native.transport.customWaitHandler = handle => ({ ok: true, value: { handle, state: "idle", observedAt: new Date().toISOString(), correlationVerified: true } });
      await f.endpoint.call(f.token, "cancel", { runId, reason: "Owner stopped native analysis" });
      expect(await f.runtime.inspect(runId)).toMatchObject({ cancelled: true });
    } finally { release(); await f.pump.drain(); }
    expect(await f.host.cancel(runId, "Reconcile cancellation")).toMatchObject({ extensionStatus: "cancelled" });
    expect(f.pump.snapshot().activeRunIds).toEqual([]);
    expect(await f.host.pendingApprovals()).toEqual([]);
  });

  it("reopens a persisted native run and continues after the same Web approvals without resending finished tasks", async () => {
    const { f, runId } = await started();
    await f.pump.tick(); await f.pump.drain();
    expect(f.native.transport.sentRequests).toHaveLength(2);
    await f.restart();
    expect(await f.start()).toMatchObject({ runId });
    expect((await f.runtime.inspect() as any).runs).toHaveLength(1);
    await f.pump.tick(); await f.pump.drain();
    expect(f.native.transport.sentRequests).toHaveLength(2);
    await finish(f, runId);
  });
});
