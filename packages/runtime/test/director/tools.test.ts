import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DirectorRuntimeEvent, JsonValue } from "@bflow/contracts";
import { DIRECTOR_OWN_TOOLS, DIRECTOR_TOOLS, DirectorAuthError, DirectorStore, DirectorTools } from "../../src/director/index.js";
import type { DirectorRuntimeEventsPort } from "../../src/director/index.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
});

interface Harness {
  store: DirectorStore;
  tools: DirectorTools;
  token: string;
  calls: { name: string; input: unknown }[];
  setNow(date: Date): void;
}

async function harness(options: { maxWaitMs?: number; runtimeEvents?: DirectorRuntimeEventsPort } = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "director-tools-"));
  dirs.push(root);
  let fixed: Date | undefined;
  const now = () => fixed ?? new Date();
  const store = new DirectorStore({ directory: path.join(root, "state"), now });
  const { token } = await store.register({ provider: "claude", repositoryRoot: "/repo" });
  const calls: { name: string; input: unknown }[] = [];
  const tools = new DirectorTools({
    store,
    coordinator: { invoke: async (name, input) => { calls.push({ name, input }); return { ok: true, name } as JsonValue; } },
    ...(options.runtimeEvents ? { runtimeEvents: options.runtimeEvents } : {}),
    maxWaitMs: options.maxWaitMs ?? 1000,
    now
  });
  return { store, tools, token, calls, setNow: date => { fixed = date; } };
}

type WaitResult = { cursor: string; timedOut: boolean; messages: { text: string; author: string }[]; issues: { status: string; issueId: string }[]; runtimeEvents: DirectorRuntimeEvent[] };
const wait = async (h: Harness, input: unknown = {}) => (await h.tools.invoke("director_wait", input, h.token)) as unknown as WaitResult;
const user = (h: Harness, text: string) => h.store.appendMessage({ author: "user", channel: "web", text });

describe("DirectorTools", () => {
  it("lists tools without report_progress and without duplicates", () => {
    const names = DIRECTOR_TOOLS.map(t => t.name);
    expect(names).not.toContain("report_progress");
    expect(names).toContain("propose_workflow");
    for (const own of DIRECTOR_OWN_TOOLS) expect(names).toContain(own.name);
    expect(DIRECTOR_OWN_TOOLS).toHaveLength(6);
    expect(new Set(names).size).toBe(names.length);
  });

  it("rejects a bad token without calling the coordinator", async () => {
    const h = await harness();
    await expect(h.tools.invoke("propose_workflow", {}, "bad.token")).rejects.toBeInstanceOf(DirectorAuthError);
    expect(h.calls).toEqual([]);
  });

  it("passes coordinator tools through and rejects report_progress", async () => {
    const h = await harness();
    const input = { a: 1 };
    expect(await h.tools.invoke("propose_workflow", input, h.token)).toEqual({ ok: true, name: "propose_workflow" });
    expect(h.calls).toEqual([{ name: "propose_workflow", input }]);
    await expect(h.tools.invoke("report_progress", {}, h.token)).rejects.toThrow("Unknown Director tool");
    await expect(h.tools.invoke("nope", {}, h.token)).rejects.toThrow("Unknown Director tool: nope");
  });

  it("returns user messages once and then times out", async () => {
    const h = await harness();
    await user(h, "one");
    await h.store.appendMessage({ author: "director", channel: "cli", text: "mid" });
    await user(h, "two");
    const first = await wait(h);
    expect(first.timedOut).toBe(false);
    expect(first.messages.map(m => m.text)).toEqual(["one", "two"]);
    expect(first.cursor).toMatch(/^m3\.i0\.r$/);
    const second = await wait(h, { cursor: first.cursor, timeoutMs: 1000 });
    expect(second).toMatchObject({ timedOut: true, messages: [], issues: [], runtimeEvents: [] });
  });

  it("is woken by a user message and reports waiting presence", async () => {
    const h = await harness({ maxWaitMs: 5000 });
    const pending = wait(h, { timeoutMs: 5000 });
    await new Promise(r => setTimeout(r, 100));
    expect((await h.store.presence()).presence).toBe("waiting");
    await h.store.appendMessage({ author: "director", channel: "cli", text: "ignored" });
    await new Promise(r => setTimeout(r, 50));
    await user(h, "wake");
    const result = await pending;
    expect(result.timedOut).toBe(false);
    expect(result.messages.map(m => m.text)).toEqual(["wake"]);
    expect((await h.store.presence()).presence).toBe("active");
  });

  it("returns open issues only when the revision changes", async () => {
    const h = await harness();
    await h.store.upsertIssue({ runId: "run-1", kind: "other", summary: "stuck" });
    const first = await wait(h, { cursor: "m0.i0.r" });
    expect(first.issues.map(i => i.status)).toEqual(["open"]);
    const again = await wait(h, { cursor: first.cursor, timeoutMs: 1000 });
    expect(again.issues).toEqual([]);
    expect(again.timedOut).toBe(true);
  });

  it("includes runtime events and encodes the runtime cursor", async () => {
    const event: DirectorRuntimeEvent = { type: "run-updated", runId: "run-1", summary: "progress" };
    const seen: string[] = [];
    const port: DirectorRuntimeEventsPort = {
      wait: async (cursor) => { seen.push(cursor); return { cursor: "rt-1", events: [event] }; }
    };
    const h = await harness({ runtimeEvents: port });
    const result = await wait(h);
    expect(result.runtimeEvents).toEqual([event]);
    expect(result.cursor).toBe(`m0.i0.r${Buffer.from("rt-1").toString("base64url")}`);
    await wait(h, { cursor: result.cursor });
    expect(seen).toEqual(["", "rt-1"]);
  });

  it("reads full transcript pages without blocking until a user message is found", async () => {
    const h = await harness({ maxWaitMs: 5000 });
    for (let i = 0; i < 250; i += 1) await h.store.appendMessage({ author: "director", channel: "cli", text: `d${i}` });
    await user(h, "late");
    const started = Date.now();
    const result = await wait(h, { timeoutMs: 5000 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.messages.map(m => m.text)).toEqual(["late"]);
    expect(result.timedOut).toBe(false);
  });

  it("fails when the runtime events port exceeds the limit", async () => {
    const event: DirectorRuntimeEvent = { type: "run-updated", runId: "run-1", summary: "progress" };
    let received = 0;
    const port: DirectorRuntimeEventsPort = {
      wait: async (_c, _t, _s, limit) => { received = limit; return { cursor: "x", events: Array.from({ length: limit + 1 }, () => event) }; }
    };
    const h = await harness({ runtimeEvents: port });
    await expect(wait(h)).rejects.toThrow("Runtime events port returned more than 200 events");
    expect(received).toBe(200);
  });

  it("rejects an invalid cursor and clamps timeoutMs to maxWaitMs", async () => {
    const h = await harness({ maxWaitMs: 1000 });
    await expect(wait(h, { cursor: "garbage" })).rejects.toThrow("Invalid director cursor");
    const started = Date.now();
    const result = await wait(h, { timeoutMs: 999999 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThanOrEqual(1500);
  });

  it("deduplicates note_user_message within 10 s", async () => {
    const h = await harness();
    h.setNow(new Date("2026-11-03T00:00:00.000Z"));
    expect(await h.tools.invoke("director_note_user_message", { text: "hello" }, h.token)).toEqual({ recorded: true, seq: 1 });
    h.setNow(new Date("2026-11-03T00:00:05.000Z"));
    expect(await h.tools.invoke("director_note_user_message", { text: " hello " }, h.token)).toEqual({ recorded: false, duplicate: true });
    h.setNow(new Date("2026-11-03T00:00:11.000Z"));
    expect(await h.tools.invoke("director_note_user_message", { text: "hello" }, h.token)).toEqual({ recorded: true, seq: 2 });
  });

  it("rejects open as a set_issue_status target and manages issues", async () => {
    const h = await harness();
    const issue = await h.store.upsertIssue({ runId: "run-1", kind: "other", summary: "stuck" });
    await expect(h.tools.invoke("set_issue_status", { issueId: issue.issueId, status: "open" }, h.token)).rejects.toThrow();
    expect(await h.tools.invoke("set_issue_status", { issueId: issue.issueId, status: "resolved" }, h.token)).toMatchObject({ status: "resolved" });
    expect(await h.tools.invoke("list_issues", {}, h.token)).toEqual([]);
    expect(await h.tools.invoke("inspect_issue", { issueId: issue.issueId }, h.token)).toMatchObject({ issueId: issue.issueId });
    await expect(h.tools.invoke("inspect_issue", { issueId: "zzz" }, h.token)).rejects.toThrow("Unknown director issue zzz");
    expect(await h.tools.invoke("director_say", { text: "hi" }, h.token)).toMatchObject({ seq: 1 });
  });
});
