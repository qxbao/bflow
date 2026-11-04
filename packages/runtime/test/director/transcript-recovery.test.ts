import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonValue } from "@bflow/contracts";
import { DirectorCursorError, DirectorEndpoint, DirectorMessageConflictError, DirectorStore } from "../../src/director/index.js";
import type { DirectorWorkStart } from "../../src/director/index.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });

async function tempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "director-recovery-"));
  dirs.push(root);
  return root;
}

type Wait = { cursor: string; timedOut: boolean; messages: { seq: number; text: string; channel: string; messageId: string }[]; mailbox?: { messageId: string }[]; issues: { issueId: string }[] };

function endpointAt(directory: string, starts: DirectorWorkStart[] = []) {
  return new DirectorEndpoint({
    directory, repositoryRoot: directory, feed: { read: () => ({ items: [] }) }, inspect: async () => ({ runs: [] }),
    coordinator: { invoke: async () => null },
    work: { start: async input => { starts.push(input); return { runId: "run-director-1", correlationId: "corr-1", status: "queued" } as JsonValue; } },
    maxWaitMs: 1000
  });
}
const wait = async (endpoint: DirectorEndpoint, token: string, cursor?: string) =>
  (await endpoint.call(token, "director_wait", { ...(cursor !== undefined ? { cursor } : {}), timeoutMs: 1 })) as unknown as Wait;
const webMessage = (endpoint: DirectorEndpoint, text: string, messageId: string = crypto.randomUUID()) => endpoint.appendWebMessage({ messageId, text });
const mailboxItem = (messageId: string) => ({ messageId, at: "2026-11-04T00:00:00.000Z", audience: "director" as const, type: "task.result", fromRole: "runtime" as const, summary: `s ${messageId}` });

describe("DirectorStore caller messageId", () => {
  it("returns the stored message for the same ID and payload, and refuses a different payload", async () => {
    const store = new DirectorStore({ directory: path.join(await tempDir(), "s") });
    const id = crypto.randomUUID();
    const first = await store.appendMessage({ messageId: id, author: "user", channel: "web", text: "xin chào" });
    const again = await store.appendMessage({ messageId: id, author: "user", channel: "web", text: "xin chào" });
    expect(again).toEqual(first);
    await expect(store.appendMessage({ messageId: id, author: "user", channel: "web", text: "khác" })).rejects.toBeInstanceOf(DirectorMessageConflictError);
    await expect(store.appendMessage({ messageId: id, author: "director", channel: "cli", text: "xin chào" })).rejects.toBeInstanceOf(DirectorMessageConflictError);
    expect((await store.allMessages()).map(m => m.seq)).toEqual([1]);
    expect((await store.version()).messageSeq).toBe(1);
  });
});

describe("Durable Director ack (R-ACK)", () => {
  it("bootstraps the ack once from the last Director message and never slides it with later director_say", async () => {
    const directory = await tempDir();
    const store = new DirectorStore({ directory });
    await store.appendMessage({ author: "user", channel: "cli", text: "legacy user" });
    await store.appendMessage({ author: "director", channel: "cli", text: "legacy reply" });
    await store.appendMessage({ author: "user", channel: "cli", text: "after the reply" });
    expect(await store.readAck()).toBeUndefined();
    // First Web message bootstraps from last-Director seq 2 before appending (seq 4).
    await store.appendMessage({ messageId: crypto.randomUUID(), author: "user", channel: "web", text: "web while absent" });
    expect(await store.readAck()).toEqual({ messageSeq: 2, mailboxSeq: 0 });
    await store.appendMessage({ author: "director", channel: "cli", text: "a later director_say" });
    expect(await store.bootstrapAck()).toEqual({ messageSeq: 2, mailboxSeq: 0 });
    const stat = await fs.stat(path.join(directory, "ack.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("bootstraps the mailbox ack at 0, so director mailbox items stored before the first register are delivered", async () => {
    const directory = await tempDir();
    const endpoint = endpointAt(directory);
    const store = new DirectorStore({ directory });
    await store.appendMailbox(mailboxItem("before-any-director"));
    await store.appendMailbox({ ...mailboxItem("user-copy"), audience: "user" });
    const session = await endpoint.register({ provider: "claude" });
    expect(await store.readAck()).toEqual({ messageSeq: 0, mailboxSeq: 0 });
    expect(session.cursor).toBe("m0.i0.b0.r");
    const first = await wait(endpoint, session.token, session.cursor);
    expect(first.mailbox?.map(m => m.messageId)).toEqual(["before-any-director"]);
    // Only the next explicit wait acknowledges what the previous result carried.
    await wait(endpoint, session.token, first.cursor);
    expect(await store.readAck()).toEqual({ messageSeq: 0, mailboxSeq: 1 });
  });

  it("bootstraps from a first Web send with mailbox 0", async () => {
    const directory = await tempDir();
    const store = new DirectorStore({ directory });
    await store.appendMailbox(mailboxItem("pending"));
    await store.appendMessage({ messageId: crypto.randomUUID(), author: "user", channel: "web", text: "web first" });
    expect(await store.readAck()).toEqual({ messageSeq: 0, mailboxSeq: 0 });
    const endpoint = endpointAt(directory);
    const session = await endpoint.register({ provider: "claude" });
    const got = await wait(endpoint, session.token, session.cursor);
    expect(got.messages.map(m => m.text)).toEqual(["web first"]);
    expect(got.mailbox?.map(m => m.messageId)).toEqual(["pending"]);
  });

  it("records only monotonic, existing positions and survives revoke and a new store instance", async () => {
    const directory = await tempDir();
    const store = new DirectorStore({ directory });
    await store.appendMessage({ author: "user", channel: "web", text: "one", messageId: crypto.randomUUID() });
    await store.appendMessage({ author: "user", channel: "web", text: "two", messageId: crypto.randomUUID() });
    await store.appendMailbox(mailboxItem("mb1"));
    expect(await store.recordAck({ messageSeq: 2, mailboxSeq: 1 })).toEqual({ messageSeq: 2, mailboxSeq: 1 });
    expect(await store.recordAck({ messageSeq: 1, mailboxSeq: 0 })).toEqual({ messageSeq: 2, mailboxSeq: 1 });
    await expect(store.recordAck({ messageSeq: 3 })).rejects.toBeInstanceOf(DirectorCursorError);
    await expect(store.recordAck({ messageSeq: 2, mailboxSeq: 9 })).rejects.toBeInstanceOf(DirectorCursorError);
    await store.revoke();
    expect(await new DirectorStore({ directory }).readAck()).toEqual({ messageSeq: 2, mailboxSeq: 1 });
  });
});

describe("Director registration after absence (queued-before-register / restart)", () => {
  it("delivers Web messages and director mailbox items stored while absent to the next session", async () => {
    const directory = await tempDir();
    const first = endpointAt(directory);
    const session1 = await first.register({ provider: "claude" });
    const w1 = await wait(first, session1.token, session1.cursor);
    expect(w1.timedOut).toBe(true);
    await first.revoke();
    // Director absent: the Web message and a specialist result are queued.
    await webMessage(first, "làm giúp X khi bạn quay lại");
    await first.deliverRuntimeMessage({ schema_version: 2, message_id: "result-1", correlation_id: "c", run_id: "run-1",
      sender: { role: "developer" }, recipient: { role: "coordinator" }, type: "task.result", artifact_references: [], payload: { status: "done" },
      occurred_at: "2026-11-04T00:00:00.000Z", idempotency_key: "result-1" } as never);
    // Host restart: a new endpoint (and store instance) over the same directory.
    const restarted = endpointAt(directory);
    const session2 = await restarted.register({ provider: "codex" });
    const w2 = await wait(restarted, session2.token, session2.cursor);
    expect(w2.messages.map(m => [m.text, m.channel])).toEqual([["làm giúp X khi bạn quay lại", "web"]]);
    expect(w2.mailbox?.map(m => m.messageId)).toEqual(["result-1"]);
  });

  it("re-delivers a message whose result was not followed by the next wait, but not after the cursor acknowledged it", async () => {
    const directory = await tempDir();
    const endpoint = endpointAt(directory);
    const s1 = await endpoint.register({ provider: "claude" });
    await wait(endpoint, s1.token, s1.cursor);
    await webMessage(endpoint, "tin A");
    const got = await wait(endpoint, s1.token, s1.cursor);
    expect(got.messages.map(m => m.text)).toEqual(["tin A"]);
    // Director dies before calling wait(got.cursor): at-least-once re-delivery.
    const s2 = await endpoint.register({ provider: "claude" });
    const replay = await wait(endpoint, s2.token, s2.cursor);
    expect(replay.messages.map(m => m.text)).toEqual(["tin A"]);
    // The next wait with the returned cursor proves receipt; a later session does not see it again.
    await wait(endpoint, s2.token, replay.cursor);
    const s3 = await endpoint.register({ provider: "claude" });
    expect((await wait(endpoint, s3.token, s3.cursor)).messages).toEqual([]);
  });

  it("refuses a future cursor without acknowledging it", async () => {
    const directory = await tempDir();
    const endpoint = endpointAt(directory);
    const s1 = await endpoint.register({ provider: "claude" });
    await webMessage(endpoint, "chưa đọc");
    await expect(wait(endpoint, s1.token, "m999.i0.b0.r")).rejects.toThrow("Invalid director cursor");
    await expect(wait(endpoint, s1.token, "m0.i0.b50.r")).rejects.toThrow("Invalid director cursor");
    const s2 = await endpoint.register({ provider: "claude" });
    expect((await wait(endpoint, s2.token, s2.cursor)).messages.map(m => m.text)).toEqual(["chưa đọc"]);
  });

  it("re-delivery plus start_work for the same user message keeps one run", async () => {
    const directory = await tempDir();
    const starts: DirectorWorkStart[] = [];
    const endpoint = endpointAt(directory, starts);
    const s1 = await endpoint.register({ provider: "claude" });
    const message = await webMessage(endpoint, "làm tính năng Y");
    const args = { title: "Y", objective: "Làm Y", acceptanceCriteria: [{ description: "Y chạy", verificationMethod: "unit_test" }], sddLevel: "lightweight", userMessageSeq: message.seq };
    const run1 = await endpoint.call(s1.token, "start_work", args);
    const s2 = await endpoint.register({ provider: "claude" });
    const replay = await wait(endpoint, s2.token, s2.cursor);
    expect(replay.messages.map(m => m.messageId)).toEqual([message.messageId]);
    expect(await endpoint.call(s2.token, "start_work", args)).toEqual(run1);
    expect(starts).toHaveLength(1);
  });

  it("transcript reads never acknowledge delivery", async () => {
    const directory = await tempDir();
    const endpoint = endpointAt(directory);
    await endpoint.register({ provider: "claude" });
    await webMessage(endpoint, "chỉ đọc");
    const before = await fs.readFile(path.join(directory, "ack.json"), "utf8");
    await endpoint.transcript();
    await endpoint.readMailbox({ audience: "director" });
    await endpoint.presenceDetail();
    expect(await fs.readFile(path.join(directory, "ack.json"), "utf8")).toBe(before);
    const s = await endpoint.register({ provider: "claude" });
    expect((await wait(endpoint, s.token, s.cursor)).messages.map(m => m.text)).toEqual(["chỉ đọc"]);
  });
});
