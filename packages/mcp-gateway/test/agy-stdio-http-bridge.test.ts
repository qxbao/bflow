import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyStdioHttpGatewayBridge } from "../src/agy-stdio-http-bridge.js";

const endpoint = "http://localhost:4317/mcp";
const serviceIds = ["svc-one"];
const protocolVersion = "2025-06-18";
const observedAt = "2026-01-02T03:04:05.000Z";
const opened: Array<{ input: PassThrough; output: PassThrough; run: Promise<void> }> = [];

afterEach(async () => {
  for (const item of opened.splice(0)) {
    item.input.end();
    await item.run;
  }
  vi.restoreAllMocks();
});

function setup(fetchImpl: typeof fetch, maxLineBytes?: number) {
  const input = new PassThrough();
  const output = new PassThrough();
  const bridge = new AgyStdioHttpGatewayBridge({
    input, output, endpoint, registrationId: "agy-test", serviceIds, bearerToken: "secret-token", fetchImpl, maxLineBytes
  });
  const lines: string[] = [];
  let buffered = "";
  output.setEncoding("utf8");
  output.on("data", chunk => {
    buffered += chunk;
    for (;;) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      lines.push(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
    }
  });
  const run = bridge.run();
  opened.push({ input, output, run });
  return { input, output, lines, run };
}

function jsonResponse(id: unknown, result: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers });
}

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++)
    await new Promise(resolve => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
}

describe("Agy stdio HTTP Gateway bridge", () => {
  it("does not replace and leak its owned Gateway session on a second initialize", async () => {
    let initialized = 0;
    const deleted: string[] = [];
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        deleted.push(new Headers(init.headers).get("Mcp-Session-Id")!);
        return new Response(null, { status: 204 });
      }
      const request = JSON.parse(String(init?.body));
      initialized++;
      return jsonResponse(request.id, { protocolVersion }, { "Mcp-Session-Id": `owned-${initialized}` });
    }) as typeof fetch;
    const client = setup(fetchImpl);
    client.input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } }) + "\n");
    await waitFor(() => client.lines.length === 1);
    client.input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion } }) + "\n");
    await waitFor(() => client.lines.length === 2);
    client.input.end();
    await client.run;
    expect(initialized).toBe(1);
    expect(JSON.parse(client.lines[1]!)).toMatchObject({ id: 2, error: expect.any(Object) });
    expect(deleted).toEqual(["owned-1"]);
  });

  it("aborts preparatory HTTP work on stdin EOF before draining the owned session", async () => {
    let observedSignal: AbortSignal | undefined;
    let deleted = false;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      observedSignal = init?.signal ?? undefined;
      const request = JSON.parse(String(init?.body));
      await new Promise(resolve => setTimeout(resolve, 50));
      return jsonResponse(request.id, { protocolVersion }, { "Mcp-Session-Id": "owned-before-eof" });
    }) as typeof fetch;
    const client = setup(fetchImpl);
    client.input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } }) + "\n");
    await waitFor(() => observedSignal !== undefined);
    client.input.end();
    await client.run;
    expect(observedSignal?.aborted).toBe(true);
    expect(deleted).toBe(true);
  });

  it("releases its session when output closes while a response is backpressured", async () => {
    const input = new PassThrough();
    const output = new PassThrough({ highWaterMark: 1 });
    let deleted = false;
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      const request = JSON.parse(String(init?.body));
      return jsonResponse(request.id, { protocolVersion }, { "Mcp-Session-Id": "blocked-output-session" });
    }) as typeof fetch;
    const bridge = new AgyStdioHttpGatewayBridge({ input, output, endpoint, registrationId: "agy-test", serviceIds,
      bearerToken: "dummy-only", fetchImpl, timeoutMs: 20 });
    const run = bridge.run();
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } }) + "\n");
    await new Promise(resolve => setTimeout(resolve, 10));
    output.destroy();
    input.end();
    await run;
    expect(deleted).toBe(true);
  });
  it("performs initialize, initialized, discovery, and a correlated tool call", async () => {
    const received: Array<{ request: Record<string, any>; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, any>;
      const headers = new Headers(init?.headers);
      received.push({ request, headers });
      if (request.method === "initialize")
        return jsonResponse(request.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "gateway", version: "1" } }, { "Mcp-Session-Id": "session-1" });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return jsonResponse(request.id, { tools: [{ name: "echo", serviceId: "svc-one", inputSchema: { type: "object" } }] });
      if (request.method === "tools/call") return jsonResponse(request.id, {
        schemaVersion: 3, callId: request.params.callId, status: "completed",
        output: [{ type: "text", text: "hello" }], observedAt
      });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`unexpected ${request.method}`);
    }) as typeof fetch;
    const client = setup(fetchImpl);

    client.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "agy", version: "1" } } })}\n`);
    await waitFor(() => client.lines.some(line => JSON.parse(line).id === 1));
    expect(JSON.parse(client.lines.find(line => JSON.parse(line).id === 1)!)).toMatchObject({ result: { protocolVersion } });
    client.input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    client.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    await waitFor(() => client.lines.some(line => JSON.parse(line).id === 2));
    expect(JSON.parse(client.lines.find(line => JSON.parse(line).id === 2)!)).toMatchObject({ result: { tools: [{ name: "echo" }] } });
    client.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "call-1", method: "tools/call", params: { name: "echo", arguments: { value: "hello" } } })}\n`);
    await waitFor(() => client.lines.some(line => JSON.parse(line).id === "call-1"));
    expect(JSON.parse(client.lines.find(line => JSON.parse(line).id === "call-1")!)).toMatchObject({
      result: { isError: false, content: [{ type: "text", text: "hello" }] }
    });
    expect(received[2].headers.get("Mcp-Protocol-Version")).toBe(protocolVersion);
    expect(received[3].request.params.serviceId).toBe("svc-one");
    expect(received[3].request.params.callId).toMatch(/^agy-/);
    expect(received[3].headers.get("Authorization")).toBe("Bearer secret-token");
  });

  it("rejects plaintext remote endpoints and query-bearing endpoints before fetch", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    expect(() => new AgyStdioHttpGatewayBridge({
      input, output, endpoint: "http://remote.example/mcp", registrationId: "agy-test", serviceIds, bearerToken: "secret"
    })).toThrow("endpoint is invalid");
    expect(() => new AgyStdioHttpGatewayBridge({
      input, output, endpoint: "https://gateway.example/mcp?token=leak", registrationId: "agy-test", serviceIds, bearerToken: "secret"
    })).toThrow("endpoint is invalid");
  });

  it("rejects wrong upstream JSON-RPC ids and mismatched tool call ids", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, any>;
      if (request.method === "initialize") return jsonResponse(request.id, { protocolVersion });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return jsonResponse(request.id, { tools: [{ name: "echo", serviceId: "svc-one" }] });
      if (request.method === "tools/call") {
        calls++;
        const result = { schemaVersion: 3, callId: "other-call", status: "completed", output: [], observedAt };
        return new Response(JSON.stringify({ jsonrpc: "1.0", id: "wrong-id", result }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = setup(fetchImpl);
    client.input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } })}\n`);
    await waitFor(() => client.lines.length === 1);
    client.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await waitFor(() => client.lines.some(line => JSON.parse(line).id === 2));
    client.input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo"}}\n');
    await waitFor(() => client.lines.some(line => JSON.parse(line).id === 3));
    expect(calls).toBe(1);
    expect(JSON.parse(client.lines.find(line => JSON.parse(line).id === 3)!)).toMatchObject({ result: { isError: true } });
  });

  it("preserves failed Gateway status as MCP isError with the Gateway content array", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, any>;
      if (request.method === "initialize") return jsonResponse(request.id, { protocolVersion });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return jsonResponse(request.id, { tools: [{ name: "echo", serviceId: "svc-one" }] });
      if (request.method === "tools/call") return jsonResponse(request.id, {
        schemaVersion: 3, callId: request.params.callId, status: "failed",
        output: [{ type: "text", text: "failure" }], observedAt
      });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = setup(fetchImpl);
    client.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    await waitFor(() => client.lines.length === 1);
    client.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await waitFor(() => client.lines.some(line => JSON.parse(line).id === 2));
    client.input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo"}}\n');
    await waitFor(() => client.lines.some(line => JSON.parse(line).id === 3));
    expect(JSON.parse(client.lines.find(line => JSON.parse(line).id === 3)!)).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: "failure" }] }
    });
  });

  it("keeps numeric and string request ids distinct and refuses duplicate active ids", async () => {
    let resolveFirst!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { resolveFirst = resolve; });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, any>;
      if (request.method === "initialize") return jsonResponse(request.id, { protocolVersion });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return jsonResponse(request.id, { tools: [{ name: "echo", serviceId: "svc-one" }] });
      if (request.method === "tools/call") return pending;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = setup(fetchImpl);
    client.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    await waitFor(() => client.lines.length === 1);
    client.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await waitFor(() => client.lines.some(line => JSON.parse(line).id === 2));
    client.input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo"}}\n{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"echo"}}\n{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo"}}\n');
    await waitFor(() => fetchImpl.mock.calls.filter(call => JSON.parse(String(call[1]?.body)).method === "tools/call").length === 2);
    expect(client.lines.some(line => JSON.parse(line).error?.message === "Request id is already active")).toBe(true);
    resolveFirst(jsonResponse("unused", {}));
    client.input.end();
    await client.run;
    const callRequests = fetchImpl.mock.calls.map(call => JSON.parse(String(call[1]?.body))).filter(request => request.method === "tools/call");
    expect(callRequests).toHaveLength(2);
    expect(callRequests[0].id).not.toBe(callRequests[1].id);
  });

  it("bounds incomplete stdin framing and drains/releases a session at EOF", async () => {
    let deleted = false;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
      const request = JSON.parse(String(init?.body)) as Record<string, any>;
      return jsonResponse(request.id, { protocolVersion }, { "Mcp-Session-Id": "owned-session" });
    }) as typeof fetch;
    const client = setup(fetchImpl, 32);
    client.input.write("x".repeat(100));
    client.input.end();
    await client.run;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(deleted).toBe(false);

    const sessionClient = setup(fetchImpl);
    sessionClient.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    await waitFor(() => sessionClient.lines.length === 1);
    sessionClient.input.end();
    await sessionClient.run;
    expect(deleted).toBe(true);
  });

  it("does not publish duplicate or out-of-scope discoveries", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as Record<string, any>;
      if (request.method === "initialize") return jsonResponse(request.id, { protocolVersion });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return jsonResponse(request.id, { tools: [
        { name: "echo", serviceId: "svc-one" }, { name: "echo", serviceId: "svc-one" }
      ] });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = setup(fetchImpl);
    client.input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');
    await waitFor(() => client.lines.length === 1);
    client.input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await waitFor(() => client.lines.some(line => JSON.parse(line).id === 2));
    expect(JSON.parse(client.lines.find(line => JSON.parse(line).id === 2)!)).toMatchObject({ error: { message: "Gateway returned ambiguous tool names" } });
    client.input.write('{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo"}}\n');
    await waitFor(() => client.lines.some(line => JSON.parse(line).id === 3));
    expect(JSON.parse(client.lines.find(line => JSON.parse(line).id === 3)!)).toMatchObject({ error: { code: -32602 } });
  });
});
