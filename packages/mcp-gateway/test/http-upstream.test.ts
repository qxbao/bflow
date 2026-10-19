import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_PLATFORM_SCHEMA_VERSION, type MCPServiceDefinition } from "@bflow/contracts";
import {
  GatewayMetricsCollector, GatewaySecretStore, HttpUpstreamDriverInstance, MCPServiceRegistry, parseRetryAfter, readSseResponse,
  type HttpUpstreamOptions, type MCPUpstreamToolCallInput
} from "../src/index.js";

// --- A fake remote MCP server that behaves like the hosted Context7 endpoint observed on 2026-10-19 -------------

type Fault = { status: number; headers?: Record<string, string> } | "reset" | "hang";
interface FakeOptions {
  mode?: "sse" | "json";
  stateful?: boolean;
  token?: string;
  /** Consumed in order by tools/call requests (and tools/list when `faultList` is set). */
  faults?: Fault[];
  faultList?: boolean;
  /** Also applied to initialize. */
  faultInitialize?: boolean;
  /** Tools advertise readOnlyHint/idempotentHint, as Context7 does. */
  annotateReadOnly?: boolean;
  /** Number of `notifications/initialized` requests to answer with HTTP 500 before accepting one. */
  failNotifications?: number;
}
interface Seen { method: string; accept: string; auth: string | undefined; session: string | undefined; protocol: string | undefined; id?: unknown; body: any }

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve(undefined)); }))); });

async function startFake(options: FakeOptions = {}) {
  const seen: Seen[] = [];
  const deleted: string[] = [];
  const sessions = new Set<string>();
  const faults = [...(options.faults ?? [])];
  const send = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => {
    if ((options.mode ?? "sse") === "sse") {
      res.writeHead(status, { "content-type": "text/event-stream", ...headers });
      res.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    } else {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    }
  };
  const tools = ["resolve-library-id", "query-docs"].map(name => ({ name, inputSchema: { type: "object", properties: {} },
    ...(options.annotateReadOnly === false ? {} : { annotations: { readOnlyHint: true, idempotentHint: true } }) }));
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "DELETE") { const id = String(req.headers["mcp-session-id"] ?? ""); deleted.push(id); sessions.delete(id); res.writeHead(200).end(); return; }
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const accept = String(req.headers["accept"] ?? "");
      seen.push({ method: body.method, accept, auth: req.headers["authorization"] as string | undefined,
        session: req.headers["mcp-session-id"] as string | undefined, protocol: req.headers["mcp-protocol-version"] as string | undefined, id: body.id, body });
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
        res.writeHead(406, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Not Acceptable" }, id: null }));
        return;
      }
      if (options.token && req.headers["authorization"] !== `Bearer ${options.token}`) { res.writeHead(401).end(); return; }
      const faultable = body.method === "tools/call" || (options.faultList === true && body.method === "tools/list") || (options.faultInitialize && body.method === "initialize");
      if (faultable && faults.length > 0) {
        const fault = faults.shift()!;
        if (fault === "reset") { req.socket.destroy(); return; }
        if (fault === "hang") return;
        res.writeHead(fault.status, fault.headers ?? {}).end("busy");
        return;
      }
      if (options.stateful && body.method !== "initialize") {
        const session = String(req.headers["mcp-session-id"] ?? "");
        if (!sessions.has(session)) { res.writeHead(404).end(); return; }
      }
      if (body.method === "initialize") {
        const headers: Record<string, string> = {};
        if (options.stateful) { const id = `sess-${sessions.size + 1}-${Math.random().toString(16).slice(2, 8)}`; sessions.add(id); headers["Mcp-Session-Id"] = id; }
        send(res, { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "FakeDocs", version: "1.0.0" } } }, 200, headers);
        return;
      }
      if (body.method === "notifications/initialized") {
        if ((options.failNotifications ?? 0) > 0) { options.failNotifications!--; res.writeHead(500).end(); return; }
        res.writeHead(202).end();
        return;
      }
      if (body.method === "tools/list") { send(res, { jsonrpc: "2.0", id: body.id, result: { tools } }); return; }
      if (body.method === "tools/call") {
        const args = body.params.arguments ?? {};
        if (body.params.name === "query-docs" && args.libraryId === "/bad/id")
          send(res, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: 'Library "/bad/id" not found.' }], isError: true } });
        else send(res, { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `ok:${body.params.name}` }] } });
        return;
      }
      res.writeHead(400).end();
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { endpoint: `http://127.0.0.1:${port}/mcp`, seen, deleted, sessions, faults };
}

function makeDriver(endpoint: string, driverOptions: HttpUpstreamOptions = {}, config: { token?: string; authenticate?: boolean; storeToken?: string; readOnlyTools?: string[] } = {}) {
  const definition: MCPServiceDefinition = {
    schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION, serviceId: "docs-fake", revision: 1, scope: { kind: "machine", machineId: "machine-1" },
    tool: { schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION, toolId: "docs-fake", kind: "native_remote_mcp", version: "1.0.0",
      operations: ["resolve-library-id", "query-docs"], resource: { sharing: "concurrent", maxConcurrency: 16 }, required: true },
    connection: { kind: "native_remote_mcp", endpoint, ownership: "external" },
    authentication: config.authenticate ? { mode: "bearer", credential: "secret://bflow/fake/api-key" } : { mode: "none" },
    healthTimeoutMs: 2000, idleTimeoutMs: 60_000, restartLimit: 2
  };
  // The host declares the tools read-only; the fake server's own annotations are never consulted for replay.
  const registered = new MCPServiceRegistry().registerService(definition, { readOnlyTools: config.readOnlyTools ?? ["resolve-library-id", "query-docs"] });
  if (!registered.ok) throw new Error(registered.error.message);
  const secrets = new GatewaySecretStore();
  if (config.storeToken) secrets.setSecret("secret://bflow/fake/api-key", config.storeToken);
  const metrics = new GatewayMetricsCollector();
  const sleeps: number[] = [];
  const driver = new HttpUpstreamDriverInstance(registered.value, "partition-1", 1, secrets, {
    metrics, sleep: async ms => { sleeps.push(ms); }, random: () => 0.5, ...driverOptions });
  return { driver, metrics, sleeps };
}

let callCounter = 0;
const call = (tool: string, args: Record<string, unknown> = {}, extra: Partial<MCPUpstreamToolCallInput> = {}): MCPUpstreamToolCallInput =>
  ({ sessionId: "s", clientId: "c", requestId: `req-${++callCounter}`, tool, arguments: args as never, ...extra });
const counters = (metrics: GatewayMetricsCollector) => metrics.snapshot().perService["docs-fake"]?.upstreamHttp;

describe("remote MCP upstream driver", () => {
  it("negotiates both content types, answers SSE responses and sends the initialized notification", async () => {
    const fake = await startFake({ mode: "sse" });
    const { driver } = makeDriver(fake.endpoint);
    const initialized = await driver.initialize();
    expect(initialized.ok && initialized.value.discoveredTools).toEqual(["resolve-library-id", "query-docs"]);
    expect(initialized.ok && initialized.value.serverInfo?.name).toBe("FakeDocs");
    const result = await driver.callTool(call("resolve-library-id", { query: "q", libraryName: "react" }));
    expect(result.ok && result.value).toEqual({ isError: false, content: [{ type: "text", text: "ok:resolve-library-id" }] });
    expect(fake.seen.every(item => item.accept.includes("application/json") && item.accept.includes("text/event-stream"))).toBe(true);
    expect(fake.seen.map(item => item.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(fake.seen[2]!.protocol).toBe("2025-06-18");
  });

  it("also accepts plain JSON responses", async () => {
    const fake = await startFake({ mode: "json" });
    const { driver } = makeDriver(fake.endpoint);
    const result = await driver.callTool(call("query-docs", { libraryId: "/org/lib", query: "x" }));
    expect(result.ok && result.value.isError).toBe(false);
  });

  it("returns a tool-level error as isError content without treating the HTTP call as failed", async () => {
    const fake = await startFake();
    const { driver, metrics } = makeDriver(fake.endpoint);
    const result = await driver.callTool(call("query-docs", { libraryId: "/bad/id", query: "x" }));
    expect(result.ok && result.value.isError).toBe(true);
    expect(JSON.stringify(result.ok && result.value.content)).toContain("not found");
    expect(counters(metrics)?.upstream_error).toBe(0);
  });

  it("performs one handshake for many concurrent callers", async () => {
    const fake = await startFake();
    const { driver } = makeDriver(fake.endpoint);
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => driver.callTool(call("resolve-library-id", { query: `q${index}`, libraryName: "x" }))));
    expect(results.every(result => result.ok)).toBe(true);
    expect(fake.seen.filter(item => item.method === "initialize")).toHaveLength(1);
    expect(fake.seen.filter(item => item.method === "tools/call")).toHaveLength(24);
  });

  describe("handshake ordering and cancellation", () => {
    it("lets no request overtake the initialized notification, however many callers arrive together", async () => {
      const fake = await startFake();
      const { driver } = makeDriver(fake.endpoint);
      await Promise.all(Array.from({ length: 12 }, () => driver.callTool(call("resolve-library-id", { query: "q", libraryName: "x" }))));
      const order = fake.seen.map(item => item.method);
      const initialized = order.indexOf("notifications/initialized");
      expect(order.indexOf("initialize")).toBe(0);
      expect(initialized).toBe(1);
      expect(order.slice(0, initialized).includes("tools/call")).toBe(false);
      expect(order.filter(method => method === "initialize")).toHaveLength(1);
    });

    it("repeats the whole handshake for a later caller when the initialized notification failed", async () => {
      const fake = await startFake({ failNotifications: 1 });
      const { driver } = makeDriver(fake.endpoint, { retry: { maxAttempts: 1 } });
      const first = await driver.callTool(call("resolve-library-id", { query: "q", libraryName: "x" }));
      expect(first.ok).toBe(false);
      const second = await driver.callTool(call("resolve-library-id", { query: "q", libraryName: "x" }));
      expect(second.ok).toBe(true);
      expect(fake.seen.filter(item => item.method === "initialize")).toHaveLength(2);
    });

    it("sends nothing for a request whose signal is already aborted", async () => {
      const fake = await startFake();
      const { driver } = makeDriver(fake.endpoint);
      const controller = new AbortController();
      controller.abort(new Error("caller gave up"));
      const result = await driver.callTool(call("query-docs", {}, { signal: controller.signal }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("cancelled");
      expect(fake.seen).toHaveLength(0);
    });

    it("does not let one caller's cancellation fail the others that share the handshake", async () => {
      const fake = await startFake();
      const { driver } = makeDriver(fake.endpoint);
      const controller = new AbortController();
      const cancelled = driver.callTool(call("resolve-library-id", {}, { signal: controller.signal }));
      const healthy = driver.callTool(call("resolve-library-id", {}));
      controller.abort(new Error("cancelled by caller"));
      const [first, second] = await Promise.all([cancelled, healthy]);
      expect(second.ok).toBe(true);
      expect(first.ok === false ? first.error.code : "ok").toMatch(/cancelled|ok/);
    });

    it("reports the Gateway's own call timeout as a timeout, not a cancellation", async () => {
      const fake = await startFake({ faults: ["hang"] });
      const { driver } = makeDriver(fake.endpoint, { retry: { maxAttempts: 1 } });
      await driver.initialize();
      const controller = new AbortController();
      const pending = driver.callTool(call("resolve-library-id", {}, { signal: controller.signal, timeoutMs: 5000 }));
      await new Promise(resolve => setTimeout(resolve, 80));
      controller.abort(new Error("Call timeout"));
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error.code).toBe("timeout"); expect(result.error.details).toMatchObject({ kind: "timeout" }); }
    });
  });

  describe("sessions", () => {
    it("keeps and replays an upstream session id, and ends it on stop", async () => {
      const fake = await startFake({ stateful: true });
      const { driver, metrics } = makeDriver(fake.endpoint);
      await driver.callTool(call("resolve-library-id"));
      const issued = [...fake.sessions][0]!;
      expect(fake.seen.filter(item => item.method !== "initialize").every(item => item.session === issued)).toBe(true);
      expect(counters(metrics)?.session_started).toBe(1);
      await driver.stop();
      expect(fake.deleted).toEqual([issued]);
      expect(driver.isAlive()).toBe(false);
    });

    it("treats a server that issues no session id as stateless", async () => {
      const fake = await startFake({ stateful: false });
      const { driver } = makeDriver(fake.endpoint);
      await driver.callTool(call("resolve-library-id"));
      expect(fake.seen.every(item => item.session === undefined)).toBe(true);
      await driver.stop();
      expect(fake.deleted).toEqual([]);
    });

    it("repeats the handshake once when the server drops the session, then succeeds", async () => {
      const fake = await startFake({ stateful: true });
      const { driver, metrics } = makeDriver(fake.endpoint);
      await driver.callTool(call("resolve-library-id"));
      fake.sessions.clear();
      const result = await driver.callTool(call("resolve-library-id"));
      expect(result.ok).toBe(true);
      expect(fake.seen.filter(item => item.method === "initialize")).toHaveLength(2);
      expect(counters(metrics)?.session_reinitialized).toBe(1);
    });
  });

  describe("rate limits and retries", () => {
    it("retries a read-only call after 429, waits at least Retry-After and counts it", async () => {
      const fake = await startFake({ faults: [{ status: 429, headers: { "retry-after": "2" } }] });
      const { driver, metrics, sleeps } = makeDriver(fake.endpoint);
      const result = await driver.callTool(call("query-docs", { libraryId: "/a/b", query: "x" }));
      expect(result.ok).toBe(true);
      expect(sleeps).toEqual([2000]);
      expect(counters(metrics)).toMatchObject({ rate_limited: 1, retry: 1 });
    });

    it("backs off exponentially for server errors and gives up with a structured error", async () => {
      const fake = await startFake({ faults: [{ status: 503 }, { status: 503 }, { status: 503 }] });
      const { driver, sleeps, metrics } = makeDriver(fake.endpoint, { retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000, jitter: 0 } });
      const result = await driver.callTool(call("query-docs", { libraryId: "/a/b", query: "x" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("transport_unavailable");
      expect(result.error.details).toMatchObject({ kind: "upstream_http", status: 503, attempts: 3 });
      expect(sleeps).toEqual([100, 200]);
      expect(counters(metrics)?.upstream_error).toBe(3);
    });

    it("surfaces rate_limited with retryAfterMs when Retry-After exceeds the wait cap", async () => {
      const fake = await startFake({ faults: [{ status: 429, headers: { "retry-after": "120" } }] });
      const { driver, sleeps } = makeDriver(fake.endpoint, { retry: { maxRetryAfterMs: 5_000 } });
      const result = await driver.callTool(call("query-docs", { libraryId: "/a/b", query: "x" }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.details).toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 120_000 });
      expect(sleeps).toEqual([]);
    });

    it("never replays a call the host has not declared read-only, whatever the server's own annotations say", async () => {
      const fake = await startFake({ annotateReadOnly: true, faults: [{ status: 503 }] });
      const { driver } = makeDriver(fake.endpoint, {}, { readOnlyTools: [] });
      await driver.listTools("s");
      const result = await driver.callTool(call("query-docs", { libraryId: "/a/b", query: "x" }));
      expect(result.ok).toBe(false);
      expect(fake.seen.filter(item => item.method === "tools/call")).toHaveLength(1);
    });

    it("retries a dropped connection for a read-only call", async () => {
      const fake = await startFake({ faults: ["reset"] });
      const { driver, metrics } = makeDriver(fake.endpoint);
      const result = await driver.callTool(call("resolve-library-id", { query: "q", libraryName: "x" }));
      expect(result.ok).toBe(true);
      expect(counters(metrics)).toMatchObject({ network_error: 1, retry: 1 });
    });

    it("parses Retry-After as seconds or an HTTP date", () => {
      expect(parseRetryAfter("7", 0)).toBe(7000);
      expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
      expect(parseRetryAfter("soon", 0)).toBeUndefined();
      expect(parseRetryAfter(null, 0)).toBeUndefined();
    });
  });

  describe("authentication", () => {
    it("sends the bearer token and never places it in an error or metric", async () => {
      const secret = "ctx7sk-super-secret-value";
      const fake = await startFake({ token: secret });
      const wrong = makeDriver(fake.endpoint, {}, { authenticate: true, storeToken: "ctx7sk-wrong" });
      const rejected = await wrong.driver.callTool(call("resolve-library-id"));
      expect(rejected.ok).toBe(false);
      if (rejected.ok) return;
      expect(rejected.error.details).toMatchObject({ kind: "auth_rejected", status: 401 });
      expect(rejected.error.retryable).toBe(false);
      expect(JSON.stringify(rejected.error)).not.toContain("ctx7sk-wrong");
      expect(JSON.stringify(wrong.metrics.snapshot())).not.toContain("ctx7sk-wrong");
      const right = makeDriver(fake.endpoint, {}, { authenticate: true, storeToken: secret });
      expect((await right.driver.callTool(call("resolve-library-id"))).ok).toBe(true);
      expect(fake.seen.some(item => item.auth === `Bearer ${secret}`)).toBe(true);
    });

    it("fails before any request when a configured credential is missing", async () => {
      const fake = await startFake();
      const { driver, metrics } = makeDriver(fake.endpoint, {}, { authenticate: true });
      const result = await driver.callTool(call("resolve-library-id"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.details).toMatchObject({ kind: "auth_missing" });
      expect(fake.seen).toHaveLength(0);
      expect(counters(metrics)?.auth_failure).toBeGreaterThanOrEqual(1);
    });
  });

  describe("timeouts, cancellation and protocol faults", () => {
    it("reports a timeout with the contract timeout code", async () => {
      const fake = await startFake({ faults: ["hang", "hang", "hang"] });
      const { driver, metrics } = makeDriver(fake.endpoint, { retry: { maxAttempts: 1 } });
      const result = await driver.callTool(call("resolve-library-id", {}, { timeoutMs: 150 }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("timeout");
      expect(result.error.details).toMatchObject({ kind: "timeout" });
      expect(counters(metrics)?.timeout).toBe(1);
    });

    it("cancels an in-flight call", async () => {
      const fake = await startFake({ faults: ["hang"] });
      const { driver } = makeDriver(fake.endpoint, { retry: { maxAttempts: 1 } });
      await driver.initialize();
      const input = call("resolve-library-id", {}, { timeoutMs: 5_000 });
      const pending = driver.callTool(input);
      await new Promise(resolve => setTimeout(resolve, 80));
      await driver.cancelRequest(input.requestId);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("cancelled");
    });

    it("rejects a malformed response as corruption instead of retrying it", async () => {
      const server = createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }).end("{not json"); }); });
      servers.push(server);
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const { driver } = makeDriver(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
      const result = await driver.initialize();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("corruption");
    });

    it("reads the matching response from an event stream and ignores other events", async () => {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n'));
        controller.enqueue(encoder.encode('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":'));
        controller.enqueue(encoder.encode('true}}\n\n'));
        controller.close();
      } });
      expect(await readSseResponse(body, 7, 1024)).toMatchObject({ id: 7, result: { ok: true } });
      await expect(readSseResponse(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(2048)); c.close(); } }), 1, 1024)).rejects.toThrow(/size limit/);
    });
  });
});
