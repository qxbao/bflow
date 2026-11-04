import { describe, expect, it, vi } from "vitest";
import { record } from "../../src/agentic/journal.js";
import { directorNativeFlow } from "../helpers/director-native-flow.js";

async function started() {
  const f = await directorNativeFlow(), runId = String(record(await f.start()).runId);
  await f.endpoint.call(f.token, "start_extension", { runId, kind: "analysis", intake: f.intake, packPin: f.pin });
  return { f, runId };
}

describe("Director native recovery", () => {
  it("re-publishes an awaiting approval on the production pump after restart without explicit recover", async () => {
    const { f, runId } = await started();
    vi.spyOn(f.chat, "receiveRuntime").mockRejectedValueOnce(new Error("approval delivery failed"));
    await f.pump.tick(); await f.pump.drain();
    expect(f.pump.snapshot().heldRunIds).toEqual([runId]);
    expect(f.notices).toEqual([]);
    await f.restart();
    await f.pump.tick(); await f.pump.drain();
    expect(f.notices.filter(message => message.type === "approval.request")).toHaveLength(1);
    expect((await f.endpoint.readMailbox({ audience: "user" })).filter(item => item.type === "approval.request")).toHaveLength(1);
    expect(f.native.transport.sentRequests).toHaveLength(2);
  });

  it("resumes a held unknown delivery through the actual Director endpoint without resending it", async () => {
    const { f, runId } = await started(); f.native.loseAck();
    await f.pump.tick(); await f.pump.drain();
    expect(f.pump.snapshot().heldRunIds).toEqual([runId]);
    expect(await f.endpoint.call(f.token, "resume_run", { runId })).toMatchObject({ queued: true, runId });
    await f.pump.tick(); await f.pump.drain();
    expect(f.pump.snapshot().heldRunIds).toEqual([]);
    expect(f.native.transport.sentRequests.filter(request => request.taskId === "survey")).toHaveLength(1);
    expect(f.native.transport.reconciledRequests).toHaveLength(1);
    expect(await f.host.inspect(runId)).toMatchObject({ extensionStatus: "awaiting_business_decision" });
  });

  it("keeps a cancelled unstarted native intake cancelled in Director and Conversation after restart", async () => {
    const f = await directorNativeFlow(), runId = String(record(await f.start()).runId);
    await f.endpoint.call(f.token, "cancel", { runId, reason: "Owner cancelled before native start" });
    for (let i = 0; i < 2; i++) {
      expect(await f.endpoint.call(f.token, "inspect", { runId })).toMatchObject({ status: "cancelled", cancelled: true });
      const context = record(await f.chat.getContext());
      expect(JSON.stringify(context.workflows)).toContain("cancelled");
      expect(f.native.transport.sentRequests).toHaveLength(0);
      if (i === 0) await f.restart();
    }
  });

  it("retries a failed required completion mirror after restart and creates one eventual mailbox entry", async () => {
    const { f, runId } = await started();
    await f.pump.tick(); await f.pump.drain();
    expect(await f.answer((await f.host.pendingApprovals())[0]!, { "D-1": "Ops" })).toMatchObject({ ok: true });
    await f.pump.tick(); await f.pump.drain();
    const mirror = f.endpoint.mirrorUserNotice.bind(f.endpoint);
    vi.spyOn(f.endpoint, "mirrorUserNotice").mockImplementation(async (message, rendered) => {
      if (record(message.payload).kind === "extension_completed") throw new Error("Director mirror unavailable");
      await mirror(message, rendered);
    });
    expect(await f.answer((await f.host.pendingApprovals())[0]!)).toMatchObject({ ok: true });
    await f.pump.tick(); await f.pump.drain();
    expect(f.pump.snapshot().heldRunIds).toEqual([runId]);
    expect((await f.endpoint.readMailbox({ audience: "user" })).some(item => item.type === "conversation.progress")).toBe(false);
    await f.restart(); await f.pump.tick(); await f.pump.drain();
    const completed = f.notices.filter(message => record(message.payload).kind === "extension_completed");
    expect(completed).toHaveLength(1);
    await f.publish(completed[0]!);
    expect((await f.endpoint.readMailbox({ audience: "user" })).filter(item => item.messageId === completed[0]!.message_id)).toHaveLength(1);
    expect(f.native.transport.sentRequests).toHaveLength(4);
  });
});
