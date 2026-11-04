import { expect, it } from "vitest";
import { record } from "../../src/agentic/journal.js";
import { directorNativeFlow } from "../helpers/director-native-flow.js";


it("delivers the native completion through the Director Conversation gateway and mirrors it exactly once on replay", async () => {
  const f = await directorNativeFlow(), run = record(await f.start()), runId = String(run.runId);
  await f.endpoint.call(f.token, "start_extension", { runId, kind: "analysis", intake: f.intake, packPin: f.pin });
  await f.host.drive(runId);
  expect(await f.answer((await f.host.pendingApprovals())[0]!, { "D-1": "Ops" })).toMatchObject({ ok: true });
  await f.host.drive(runId);
  expect(await f.answer((await f.host.pendingApprovals())[0]!)).toMatchObject({ ok: true });
  expect(await f.host.drive(runId)).toMatchObject({ status: "completed", extensionStatus: "published" });
  const complete = f.notices.find(message => record(message.payload).kind === "extension_completed")!;
  expect(complete.recipient.role).toBe("conversation");
  const before = await f.endpoint.readMailbox({ audience: "user" });
  expect(before.filter(item => item.messageId === complete.message_id)).toHaveLength(1);
  const context = await f.chat.getContext();
  await f.publish(complete); await f.publish(complete);
  expect(record(await f.chat.getContext()).messages).toEqual(record(context).messages);
  expect((await f.endpoint.readMailbox({ audience: "user" })).filter(item => item.messageId === complete.message_id)).toHaveLength(1);
});
