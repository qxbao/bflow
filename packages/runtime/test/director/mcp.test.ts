import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runDirectorMcp } from "../../src/director/mcp.js";

function harness(call: (name: string, token: string, args: Record<string, unknown>) => Promise<unknown>) {
  const input = new PassThrough(), output = new PassThrough();
  const replies: any[] = [], waiters: Array<() => void> = [];
  output.setEncoding("utf8");
  let buffer = "";
  output.on("data", (chunk: string) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) { replies.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1); waiters.splice(0).forEach(w => w()); }
  });
  const done = runDirectorMcp({ call: call as never, input, output });
  const send = (message: unknown) => input.write(JSON.stringify(message) + "\n");
  const reply = async (id: number) => {
    for (;;) { const found = replies.find(r => r.id === id); if (found) return found; await new Promise<void>(r => waiters.push(r)); }
  };
  const raw = (text: string) => input.write(text + "\n");
  return { send, raw, reply, replies, end: async () => { input.end(); await done; } };
}

describe("director MCP", () => {
  it("initializes and lists tools", async () => {
    const h = harness(async () => ({}));
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect((await h.reply(1)).result.protocolVersion).toBe("2024-11-05");
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = (await h.reply(2)).result.tools.map((t: any) => t.name);
    expect(names).toContain("director_wait"); expect(names).toContain("propose_workflow"); expect(names).not.toContain("report_progress");
    h.send({ jsonrpc: "2.0", id: 3, method: "nope" });
    expect((await h.reply(3)).error.code).toBe(-32601);
    await h.end();
  });
  it("forwards name, token and remaining args; rejects missing token and unknown tool", async () => {
    const seen: unknown[] = [];
    const h = harness(async (n, t, a) => { seen.push([n, t, a]); return { ok: 1 }; });
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "director_say", arguments: { token: "a.b", text: "hi" } } });
    expect(JSON.parse((await h.reply(1)).result.content[0].text)).toEqual({ ok: 1 });
    expect(seen).toEqual([["director_say", "a.b", { text: "hi" }]]);
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "director_say", arguments: {} } });
    expect((await h.reply(2)).result).toMatchObject({ isError: true });
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bogus", arguments: { token: "a.b" } } });
    expect((await h.reply(3)).result.isError).toBe(true);
    await h.end();
  });
  it("runs calls concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const h = harness(async name => { if (name === "director_wait") await gate; return { name }; });
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "director_wait", arguments: { token: "t.s" } } });
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "director_say", arguments: { token: "t.s" } } });
    await h.reply(2);
    expect(h.replies.find(r => r.id === 1)).toBeUndefined();
    release(); await h.reply(1);
    expect(h.replies.map(r => r.id)).toEqual([2, 1]);
    await h.end();
  });
  it("redacts the token from errors", async () => {
    const h = harness(async (_n, token) => { throw new Error(`denied for ${token}`); });
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "director_say", arguments: { token: "abc123.secretvalue" } } });
    const r = await h.reply(1);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).not.toContain("secretvalue");
    await h.end();
  });
  it("answers unparseable and oversized lines with JSON-RPC errors and keeps serving", async () => {
    const h = harness(async () => ({}));
    h.raw("{not json");
    const until = async (count: number) => { while (h.replies.length < count) await new Promise(r => setTimeout(r, 5)); };
    await until(1);
    expect(h.replies[0]).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    h.raw(`{"jsonrpc":"2.0","id":77,"method":"tools/call","params":{"pad":"${"x".repeat(4 * 1024 * 1024 + 10)}"}}`);
    await until(2);
    expect(h.replies[1]).toEqual({ jsonrpc: "2.0", id: 77, error: { code: -32600, message: "Request too large" } });
    h.raw(`{"method":"x","params":{"pad":"${"x".repeat(4 * 1024 * 1024 + 10)}"},"id":9}`);
    await until(3);
    expect(h.replies[2].id).toBeNull();
    h.send({ jsonrpc: "2.0", id: 5, method: "ping" });
    expect((await h.reply(5)).result).toEqual({});
    await h.end();
  });
});
