import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonValue } from "@bflow/contracts";
import { DirectorAuthError, DirectorEndpoint, DirectorStore } from "../../src/director/index.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }))); });

class FakeFeed {
  private seq = 0;
  private ring: { cursor: string; type: string; resourceIds: string[] }[] = [];
  publish(type: string, resourceIds: string[]): void { this.ring.push({ cursor: `e:${++this.seq}`, type, resourceIds }); }
  read(cursor?: string) {
    const after = cursor ? Number(cursor.split(":")[1]) : -1;
    return { items: this.ring.filter(i => Number(i.cursor.split(":")[1]) > after) };
  }
}

async function make() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "director-endpoint-"));
  dirs.push(root);
  const feed = new FakeFeed();
  const calls: { name: string; input: unknown }[] = [];
  const endpoint = new DirectorEndpoint({
    directory: path.join(root, "director"),
    repositoryRoot: "/repo",
    coordinator: { invoke: async (name, input) => { calls.push({ name, input }); return { forwarded: name } as JsonValue; } },
    feed,
    inspect: async () => ({ runs: [] }),
    maxWaitMs: 1500,
    pollMs: 20
  });
  return { endpoint, feed, calls, directory: path.join(root, "director") };
}

describe("DirectorEndpoint", () => {
  it("registers and routes director_say into the transcript", async () => {
    const { endpoint, directory } = await make();
    const { token } = await endpoint.register({ provider: "claude" });
    await endpoint.call(token, "director_say", { text: "xin chào" });
    const messages = await new DirectorStore({ directory }).readMessages({ afterSeq: 0 });
    expect(messages.map(m => [m.author, m.text])).toEqual([["director", "xin chào"]]);
    const wait = (await endpoint.call(token, "director_wait", { timeoutMs: 1000 })) as unknown as { messages: unknown[]; timedOut: boolean };
    expect(wait.timedOut).toBe(true);
    const progress = await endpoint.progress();
    expect(progress.director.presence).toBe("active");
  });

  it("returns feed events published mid-wait and ignores old ones for cursor ''", async () => {
    const { endpoint, feed } = await make();
    feed.publish("old_event", ["x"]);
    const { token } = await endpoint.register({ provider: "codex" });
    const first = (await endpoint.call(token, "director_wait", { timeoutMs: 1000 })) as unknown as { cursor: string; runtimeEvents: unknown[]; timedOut: boolean };
    expect(first.runtimeEvents).toEqual([]);
    expect(first.timedOut).toBe(true);
    setTimeout(() => feed.publish("workforce_changed", ["a", "b", "c", "d", "e", "f"]), 100);
    const second = (await endpoint.call(token, "director_wait", { cursor: first.cursor, timeoutMs: 1500 })) as unknown as { runtimeEvents: { type: string; summary: string }[] };
    expect(second.runtimeEvents).toEqual([{ type: "projection.workforce_changed", summary: "workforce_changed: a, b, c, d, e" }]);
  });

  it("noteHookPrompt: never records without a session bound by the start prompt", async () => {
    const { endpoint, directory } = await make();
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "hi", sessionId: "s1" })).toEqual({ recorded: false });
    await endpoint.register({ provider: "claude" });
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "hi", sessionId: "s1" })).toEqual({ recorded: false });
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "hi" })).toEqual({ recorded: false });
    const store = new DirectorStore({ directory });
    expect(await store.readMessages({ afterSeq: 0 })).toEqual([]);
  });

  it("binds the session announced by /bflow-start and records only that session", async () => {
    const { endpoint, directory } = await make();
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "  /bflow-start  ", sessionId: "s1" })).toEqual({ recorded: false });
    await endpoint.register({ provider: "claude" });
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "hi", sessionId: "s1" })).toEqual({ recorded: true });
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "hi", sessionId: "s1" })).toEqual({ recorded: false });
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "other session", sessionId: "s2" })).toEqual({ recorded: false });
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "no session" })).toEqual({ recorded: false });
    expect(await endpoint.noteHookPrompt({ provider: "codex", prompt: "wrong provider", sessionId: "s1" })).toEqual({ recorded: false });
    const texts = (await new DirectorStore({ directory }).readMessages({ afterSeq: 0 })).map(m => m.text);
    expect(texts).toEqual(["hi"]);
  });

  it("accepts the $bflow-start and bare skill name forms", async () => {
    const { endpoint } = await make();
    await endpoint.noteHookPrompt({ provider: "codex", prompt: "$bflow-start", sessionId: "c1" });
    await endpoint.register({ provider: "codex" });
    expect(await endpoint.noteHookPrompt({ provider: "codex", prompt: "go", sessionId: "c1" })).toEqual({ recorded: true });
    await endpoint.noteHookPrompt({ provider: "codex", prompt: "bflow-start", sessionId: "c2" });
    await endpoint.register({ provider: "codex" });
    expect(await endpoint.noteHookPrompt({ provider: "codex", prompt: "go again", sessionId: "c2" })).toEqual({ recorded: true });
  });

  it("does not bind an expired or provider-mismatched start candidate", async () => {
    let now = new Date("2026-11-03T00:00:00Z");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "director-endpoint-ttl-"));
    dirs.push(root);
    const endpoint = new DirectorEndpoint({
      directory: path.join(root, "director"), repositoryRoot: "/repo", feed: new FakeFeed(), inspect: async () => ({}),
      coordinator: { invoke: async () => null }, now: () => now
    });
    await endpoint.noteHookPrompt({ provider: "claude", prompt: "/bflow-start", sessionId: "s1" });
    now = new Date(now.getTime() + 5 * 60_000 + 1);
    await endpoint.register({ provider: "claude" });
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "hi", sessionId: "s1" })).toEqual({ recorded: false });
    await endpoint.noteHookPrompt({ provider: "codex", prompt: "/bflow-start", sessionId: "s9" });
    await endpoint.register({ provider: "claude" });
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "hi", sessionId: "s9" })).toEqual({ recorded: false });
  });

  it("start output cursor and an empty cursor both work for the first director_wait", async () => {
    const { endpoint } = await make();
    const start = await endpoint.register({ provider: "claude" });
    expect(start.cursor).toMatch(/^m\d+\.i\d+\.b\d+\.r$/);
    const viaStartCursor = (await endpoint.call(start.token, "director_wait", { cursor: start.cursor, timeoutMs: 1 })) as { timedOut: boolean };
    expect(viaStartCursor.timedOut).toBe(true);
    const first = (await endpoint.call(start.token, "director_wait", { cursor: "", timeoutMs: 1 })) as { cursor: string; timedOut: boolean };
    expect(first.timedOut).toBe(true);
    expect(first.cursor).not.toBe("");
    const second = (await endpoint.call(start.token, "director_wait", { cursor: first.cursor, timeoutMs: 1 })) as { timedOut: boolean };
    expect(second.timedOut).toBe(true);
  });

  it("an aborted director_wait returns early and presence leaves waiting", async () => {
    const { endpoint } = await make();
    const { token } = await endpoint.register({ provider: "claude" });
    const controller = new AbortController();
    const started = Date.now();
    const pending = endpoint.call(token, "director_wait", { timeoutMs: 1500 }, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = (await pending) as { timedOut: boolean };
    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.timedOut).toBe(true);
    expect((await endpoint.progress()).director.presence).not.toBe("waiting");
  });

  it("distinguishes Director tokens from 64-char hex", async () => {
    const { endpoint } = await make();
    const { token } = await endpoint.register({ provider: "claude" });
    expect(DirectorEndpoint.isDirectorToken(token)).toBe(true);
    expect(DirectorEndpoint.isDirectorToken("a".repeat(64))).toBe(false);
  });

  it("forwards coordinator tools with the exact arguments", async () => {
    const { endpoint, calls } = await make();
    const { token } = await endpoint.register({ provider: "claude" });
    const out = await endpoint.call(token, "propose_workflow", { a: 1 });
    expect(out).toEqual({ forwarded: "propose_workflow" });
    expect(calls).toEqual([{ name: "propose_workflow", input: { a: 1 } }]);
  });

  it("rejects bad tokens without leaking them", async () => {
    const { endpoint, calls } = await make();
    await endpoint.register({ provider: "claude" });
    const bad = "badtokenid.abcdefghijklmnopqrstuvwxyz0123";
    const error = await endpoint.call(bad, "director_say", { text: "x" }).catch(e => e);
    expect(error).toBeInstanceOf(DirectorAuthError);
    expect(String((error as Error).message)).not.toContain(bad);
    expect(String((error as Error).message)).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(calls).toEqual([]);
  });
});

describe("DirectorEndpoint mailbox", () => {
  const message = (over: Record<string, unknown> = {}) => ({
    message_id: "msg-1", correlation_id: "corr-1", run_id: "run-1", sender: { role: "developer" }, recipient: { role: "coordinator" },
    type: "task.result", payload: { kind: "result", taskId: "t1", summary: "xong sk-abcdefghijklmnopqrstuvwxyz0123456789 Bearer abcdefghijklmnopqrstuvwxyz123456" },
    artifact_references: [], schema_version: 2, ...over
  }) as never;

  it("deliverRuntimeMessage is idempotent, summarized and redacted", async () => {
    const { endpoint } = await make();
    await endpoint.deliverRuntimeMessage(message());
    await endpoint.deliverRuntimeMessage(message());
    const items = await endpoint.readMailbox({});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ audience: "director", fromRole: "developer", kind: "result", taskId: "t1", runId: "run-1", type: "task.result" });
    expect(items[0]!.summary.startsWith("task.result/result từ developer: xong")).toBe(true);
    expect(items[0]!.summary).not.toMatch(/sk-abcdefghijklmnopqrstuvwxyz0123456789/);
    expect(JSON.stringify(items[0])).not.toContain("payload");
  });

  it("maps user/conversation senders to runtime and mirrors user notices", async () => {
    const { endpoint } = await make();
    await endpoint.deliverRuntimeMessage(message({ message_id: "m2", sender: { role: "conversation" }, payload: { status: "approved" } }));
    await endpoint.mirrorUserNotice(message({ message_id: "m2" }), { text: "Thông báo", code: "#3" });
    await endpoint.mirrorUserNotice(message({ message_id: "m2" }), { text: "Thông báo", code: "#3" });
    expect((await endpoint.readMailbox({ audience: "director" }))[0]).toMatchObject({ fromRole: "runtime" });
    const user = await endpoint.readMailbox({ audience: "user" });
    expect(user).toHaveLength(1);
    expect(user[0]).toMatchObject({ text: "Thông báo", code: "#3" });
  });
});
