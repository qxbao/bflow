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

  it("noteHookPrompt: absent -> not recorded; active -> recorded once within dedupe window", async () => {
    const { endpoint } = await make();
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "hi" })).toEqual({ recorded: false });
    await endpoint.register({ provider: "claude" });
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "hi" })).toEqual({ recorded: true });
    expect(await endpoint.noteHookPrompt({ provider: "claude", prompt: "hi" })).toEqual({ recorded: false });
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
