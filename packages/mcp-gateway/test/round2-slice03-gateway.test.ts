import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgyStdioHttpGatewayBridge,
  BflowSharedMCPGateway,
  DefaultMCPServiceManager,
  DurableGatewayCallLedger,
  GatewaySecretStore,
  MCPServiceRegistry,
  StdioToHttpBridge,
  StreamableHttpGatewayServer
} from "../src/index.js";
import { HttpUpstreamDriverInstance, readSseResponse } from "../src/http-upstream.js";
import type { MCPUpstreamDriverFactory, MCPUpstreamDriverInstance } from "../src/types.js";

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const SESSION_SCOPE = {
  kind: "session" as const,
  machineId: "m1",
  repositoryId: "r1",
  workspaceRoot: "/tmp/ws",
  sessionId: "s1"
};

function makeServiceDef(
  serviceId: string,
  operations: readonly string[],
  sharing:
    | { sharing: "concurrent"; maxConcurrency: number }
    | { sharing: "exclusive"; resourceKey: string } = {
    sharing: "concurrent",
    maxConcurrency: 4
  }
) {
  return {
    schemaVersion: 3 as const,
    serviceId,
    revision: 1,
    scope: SESSION_SCOPE,
    tool: {
      schemaVersion: 3 as const,
      toolId: serviceId,
      kind: "native_remote_mcp" as const,
      version: "1.0.0",
      operations: [...operations],
      resource: sharing,
      required: false
    },
    connection: {
      kind: "native_remote_mcp" as const,
      endpoint: "http://127.0.0.1:9999/mcp",
      ownership: "external" as const
    },
    authentication: { mode: "none" as const },
    healthTimeoutMs: 2_000,
    idleTimeoutMs: 60_000,
    restartLimit: 3
  };
}

function makeRegistration(
  registrationId: string,
  endpoint: string,
  serviceIds: readonly string[],
  allowedTools: readonly string[]
) {
  return {
    schemaVersion: 3 as const,
    registrationId,
    provider: "claude" as const,
    role: "developer" as const,
    scope: SESSION_SCOPE,
    environmentId: `env-${registrationId}`,
    serviceIds: [...serviceIds],
    allowedTools: [...allowedTools],
    connection: {
      transport: "streamable_http" as const,
      endpoint,
      token: `secret://test/${registrationId}`
    },
    configDigest: "a".repeat(64),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    idempotencyKey: `idem-reg-${registrationId}`
  };
}

describe("Round 2 Slice 03 — MCP Gateway Adversarial Hardening", () => {
  it("R2-G1: StreamableHttpGatewayServer isolates inFlightRequests per client, aborts tools/list on client disconnect, and closes GET /mcp SSE streams on session disconnect", async () => {
    let callAStarted!: () => void;
    let callBStarted!: () => void;
    let releaseCallA!: () => void;
    const aEntered = new Promise<void>((r) => {
      callAStarted = r;
    });
    const bEntered = new Promise<void>((r) => {
      callBStarted = r;
    });
    const aGate = new Promise<void>((r) => {
      releaseCallA = r;
    });
    let listClientSignalAborted = false;
    let listEnsureEntered!: () => void;
    const listEntered = new Promise<void>((r) => {
      listEnsureEntered = r;
    });

    const driverFactory: MCPUpstreamDriverFactory = {
      async createInstance(entry, _pk, startGeneration) {
        const svcId = entry.definition.serviceId;
        const driver: MCPUpstreamDriverInstance = {
          instanceId: `${svcId}-inst-${startGeneration}`,
          startGeneration,
          ownership: "bflow",
          isAlive: () => true,
          onCrash: () => () => {},
          async stop() {},
          async initialize() {
            if (svcId === "slow-list-svc") {
              listEnsureEntered();
              // Even if driver.initialize ignores opts.signal/timeoutMs, DefaultMCPServiceManager's healthTimeoutMs bounds it!
              return await new Promise<never>(() => {});
            }
            return {
              ok: true,
              value: {
                protocolVersion: "2025-06-18",
                discoveredTools: ["shared_read"],
                toolDefinitions: [
                  { name: "shared_read", inputSchema: { type: "object", properties: {} } }
                ],
                defaultedInputSchemaTools: []
              }
            };
          },
          async listTools() {
            return { ok: true, value: ["shared_read"] };
          },
          async callTool(input) {
            if (input.clientId === "reg-a") {
              callAStarted();
              return await new Promise((resolve) => {
                input.signal?.addEventListener(
                  "abort",
                  () =>
                    resolve({
                      ok: false,
                      error: { code: "cancelled", retryable: false, message: "A aborted" }
                    }),
                  { once: true }
                );
                void aGate.then(() =>
                  resolve({
                    ok: true,
                    value: { isError: false, content: [{ type: "text", text: "A-ok" }] }
                  })
                );
              });
            }
            callBStarted();
            return await new Promise((resolve) => {
              input.signal?.addEventListener(
                "abort",
                () =>
                  resolve({
                    ok: false,
                    error: { code: "cancelled", retryable: false, message: "B aborted" }
                  }),
                { once: true }
              );
            });
          }
        };
        return { ok: true, value: driver };
      }
    };

    const registry = new MCPServiceRegistry();
    const fastDef = makeServiceDef("fast-svc", ["shared_read"]);
    const slowListDef = { ...makeServiceDef("slow-list-svc", ["slow_tool"]), healthTimeoutMs: 250 };
    registry.registerService(fastDef, { readOnlyTools: ["shared_read"] });
    registry.registerService(slowListDef, { readOnlyTools: ["slow_tool"] });

    const serviceManager = new DefaultMCPServiceManager({
      registry,
      driverFactory
    });
    const gateway = new BflowSharedMCPGateway({ registry, serviceManager });
    const origListTools = gateway.listToolsForClient.bind(gateway);
    gateway.listToolsForClient = async (regId, sessId, opts) => {
      opts?.signal?.addEventListener(
        "abort",
        () => {
          listClientSignalAborted = true;
        },
        { once: true }
      );
      return origListTools(regId, sessId, opts);
    };
    const server = new StreamableHttpGatewayServer({ gateway });
    const baseUrl = await server.start();
    cleanups.push(async () => {
      await server.stop();
    });
    const mcpUrl = `${baseUrl}/mcp`;

    await serviceManager.ensure(fastDef, {
      schemaVersion: 3,
      scope: SESSION_SCOPE,
      idempotencyKey: "ens-fast"
    });

    await gateway.register(makeRegistration("reg-a", mcpUrl, ["fast-svc"], ["shared_read"]) as never);
    await gateway.register(makeRegistration("reg-b", mcpUrl, ["fast-svc"], ["shared_read"]) as never);
    await gateway.register(
      makeRegistration("reg-list", mcpUrl, ["slow-list-svc"], ["slow_tool"]) as never
    );

    const tokenA = gateway.secretStore.getClientTokenByRegistration("reg-a")!;
    const tokenB = gateway.secretStore.getClientTokenByRegistration("reg-b")!;
    const tokenList = gateway.secretStore.getClientTokenByRegistration("reg-list")!;

    // 1. Both clients send JSON-RPC id: 1 concurrently; Client B cancels requestId: 1 -> Client A MUST NOT be cancelled!
    const callAPromise = fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "shared_read", arguments: {} }
      })
    });
    await aEntered;

    const callBPromise = fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "shared_read", arguments: {} }
      })
    });
    await bEntered;

    await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 1 }
      })
    });

    const respB = (await (await callBPromise).json()) as any;
    expect(respB.error).toBeDefined();

    releaseCallA();
    const respA = (await (await callAPromise).json()) as any;
    expect(respA.error).toBeUndefined();
    expect(respA.result).toMatchObject({ status: "completed" });

    // 2. Client disconnect during POST /mcp `tools/list` aborts upstream ensure signal promptly
    const listAbort = new AbortController();
    const listFetch = fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenList}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
      signal: listAbort.signal
    }).catch(() => undefined);
    await listEntered;
    listAbort.abort();
    await listFetch;
    for (let i = 0; i < 40 && !listClientSignalAborted; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(listClientSignalAborted).toBe(true);

    // 3. GET /mcp SSE stream closes promptly when DELETE /mcp disconnects the session
    const initRes = await fetch(mcpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "initialize" })
    });
    const sessionId = initRes.headers.get("mcp-session-id")!;
    expect(sessionId).toBeTruthy();

    const sseRes = await fetch(mcpUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Mcp-Session-Id": sessionId
      }
    });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);

    await fetch(mcpUrl, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${tokenA}`,
        "Mcp-Session-Id": sessionId
      }
    });

    const closedRace = await Promise.race([
      (async () => {
        for (;;) {
          const next = await reader.read();
          if (next.done) return "closed";
        }
      })(),
      new Promise<string>((r) => setTimeout(() => r("hung"), 400))
    ]);
    expect(closedRace).toBe("closed");
  });

  it("R2-G2: HttpUpstreamDriverInstance & AgyStdioHttpGatewayBridge enforce timeout/abort on hung response body streams after HTTP 200 headers and guard >32-bit timeouts", async () => {
    // 1. readSseResponse directly aborts a stalled ReadableStream when signal aborts
    const neverEndingStream = () =>
      new ReadableStream<Uint8Array>({
        pull() {
          return new Promise<void>(() => {
            // stalled body after headers
          });
        }
      });

    const sseAbort = new AbortController();
    setTimeout(() => sseAbort.abort(new Error("Timed out")), 30);
    await expect(readSseResponse(neverEndingStream(), 1, 1024 * 1024, sseAbort.signal)).rejects.toThrow();

    // 2. HttpUpstreamDriverInstance times out when HTTP 200 JSON/SSE body stream hangs after headers arrive
    const registry = new MCPServiceRegistry();
    const def = makeServiceDef("hung-remote", ["lookup"]);
    const entryRes = registry.registerService(def, { readOnlyTools: ["lookup"] });
    expect(entryRes.ok).toBe(true);
    if (!entryRes.ok) return;

    let reqNo = 0;
    const driver = new HttpUpstreamDriverInstance(entryRes.value, "pk-1", 1, new GatewaySecretStore(), {
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5, jitter: 0 },
      fetchImpl: (async (_url, init) => {
        reqNo++;
        const parsed = JSON.parse(String(init?.body ?? "{}"));
        if (parsed.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              result: { protocolVersion: "2025-06-18", capabilities: {} }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (parsed.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        // Return HTTP 200 headers immediately, but body stream never yields bytes (ignoring init.signal)
        return new Response(neverEndingStream(), {
          status: 200,
          headers: { "Content-Type": reqNo % 2 === 0 ? "text/event-stream" : "application/json" }
        });
      }) as typeof fetch
    });

    const t0 = Date.now();
    const toolRes = await driver.callTool({
      sessionId: "s1",
      clientId: "reg-1",
      requestId: "req-hung-1",
      callId: "call-hung-1",
      tool: "lookup",
      arguments: {},
      timeoutMs: 70
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(800);
    expect(toolRes).toMatchObject({
      ok: false,
      error: { code: "timeout" }
    });

    // 3. AgyStdioHttpGatewayBridge tolerates >32-bit timeoutMs without RangeError AND aborts stalled body stream on short timeoutMs
    const inputLarge = new PassThrough();
    const outputLarge = new PassThrough();
    const largeOutLines: string[] = [];
    outputLarge.setEncoding("utf8");
    outputLarge.on("data", (c: string) => {
      for (const l of c.split("\n").filter(Boolean)) largeOutLines.push(l);
    });
    const largeBridge = new AgyStdioHttpGatewayBridge({
      input: inputLarge,
      output: outputLarge,
      endpoint: "http://127.0.0.1:9999/mcp",
      registrationId: "reg-agy",
      serviceIds: ["svc-1"],
      bearerToken: "tok",
      timeoutMs: 3_000_000_000,
      fetchImpl: (async (_u, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
          }),
          { status: 200, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess-1" } }
        );
      }) as typeof fetch
    });
    const largeRun = largeBridge.run();
    inputLarge.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n"
    );
    for (let i = 0; i < 40 && largeOutLines.length < 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    inputLarge.end();
    await largeRun;
    expect(JSON.parse(largeOutLines[0]!)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18" }
    });

    // Short timeout on stalled body stream in AgyStdioHttpGatewayBridge
    const inputHung = new PassThrough();
    const outputHung = new PassThrough();
    const hungLines: string[] = [];
    outputHung.setEncoding("utf8");
    outputHung.on("data", (c: string) => {
      for (const l of c.split("\n").filter(Boolean)) hungLines.push(l);
    });
    const hungBridge = new AgyStdioHttpGatewayBridge({
      input: inputHung,
      output: outputHung,
      endpoint: "http://127.0.0.1:9999/mcp",
      registrationId: "reg-agy",
      serviceIds: ["svc-1"],
      bearerToken: "tok",
      timeoutMs: 60,
      fetchImpl: (async (_u, init) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
            }),
            { status: 200, headers: { "Content-Type": "application/json", "Mcp-Session-Id": "sess-h" } }
          );
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        if (body.method === "tools/list") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  {
                    name: "op1",
                    serviceId: "svc-1",
                    inputSchema: { type: "object", properties: {} }
                  }
                ]
              }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(neverEndingStream(), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }) as typeof fetch
    });
    const hungRun = hungBridge.run();
    inputHung.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n"
    );
    for (let i = 0; i < 40 && hungLines.length < 1; i++) await new Promise((r) => setTimeout(r, 5));
    inputHung.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    inputHung.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    for (let i = 0; i < 40 && hungLines.length < 2; i++) await new Promise((r) => setTimeout(r, 5));

    const tHung = Date.now();
    inputHung.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "op1", arguments: {} }
      }) + "\n"
    );
    for (let i = 0; i < 80 && hungLines.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(Date.now() - tHung).toBeLessThan(800);
    expect(hungLines.length).toBe(3);
    expect(JSON.parse(hungLines[2]!)).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: { isError: true }
    });
    inputHung.end();
    await hungRun;
  });

  it("R2-G3: StdioToHttpBridge tolerates non-JSON stdout banner lines, guards async stdin/stderr EPIPE errors, unblocks backpressured writes on crash, and flushes trailing JSON before EOF", async () => {
    // 1. Non-JSON startup banner lines on stdout + async stdin/stderr error safety + trailing JSON without final newline on EOF
    const stdin1 = new PassThrough();
    const stdout1 = new PassThrough();
    const stderr1 = new PassThrough();

    const bridge1 = new StdioToHttpBridge({
      instanceId: "stdio-1",
      startGeneration: 1,
      ownership: "bflow",
      stdin: stdin1,
      stdout: stdout1,
      stderr: stderr1
    });

    stdin1.setEncoding("utf8");
    let step = 0;
    stdin1.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const msg = JSON.parse(line);
        if (msg.id !== undefined) {
          step++;
          if (step === 1) {
            // Emit non-JSON banner lines BEFORE valid JSON-RPC response
            stdout1.write("[dotenv@16.4.5] injecting env (3) from .env\n");
            stdout1.write("WARN: MCP index warmup took 12ms\n");
            stdout1.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { content: [{ type: "text", text: "first-ok" }] }
              }) + "\n"
            );
          } else {
            // Write final JSON-RPC response WITHOUT trailing newline and end stdout immediately
            stdout1.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { content: [{ type: "text", text: "eof-flushed-ok" }] }
              })
            );
          }
        }
      }
    });

    const res1 = await bridge1.callTool({
      sessionId: "s1",
      clientId: "c1",
      requestId: "r1",
      callId: "call-1",
      tool: "ping_tool",
      arguments: {}
    });
    expect(bridge1.isAlive()).toBe(true);
    expect(res1).toMatchObject({
      ok: true,
      value: { isError: false, content: [{ type: "text", text: "first-ok" }] }
    });

    const res2 = await bridge1.callTool({
      sessionId: "s1",
      clientId: "c1",
      requestId: "r2",
      callId: "call-2",
      tool: "ping_tool",
      arguments: {}
    });
    expect(res2).toMatchObject({
      ok: true,
      value: { isError: false, content: [{ type: "text", text: "eof-flushed-ok" }] }
    });

    // Emitting async EPIPE / error on stdin and stderr must NOT throw uncaught exception
    expect(() => stdin1.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).not.toThrow();
    expect(() => stderr1.emit("error", new Error("stderr broken"))).not.toThrow();

    // 2. Backpressured stdin write (`write()` returns false, callback never invoked) unblocks immediately when bridge crashes
    const stalledStdin = new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, _cb) {
        // Simulate full OS pipe buffer whose child dies before draining
      }
    });
    const stdout2 = new PassThrough();
    const bridge2 = new StdioToHttpBridge({
      instanceId: "stdio-bp",
      startGeneration: 1,
      ownership: "bflow",
      stdin: stalledStdin,
      stdout: stdout2
    });

    const hungCall = bridge2.callTool({
      sessionId: "s1",
      clientId: "c1",
      requestId: "r-bp",
      callId: "call-bp",
      tool: "heavy_tool",
      arguments: { payload: "x".repeat(128) }
    });
    await new Promise((r) => setTimeout(r, 20));
    bridge2.triggerCrash("child_sigkill");

    const bpOutcome = await Promise.race([
      hungCall,
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 400))
    ]);
    expect(bpOutcome).not.toBe("hung");
    expect(bpOutcome).toMatchObject({
      ok: false,
      error: { code: "transport_unavailable" }
    });
  });

  it("R2-G4: DurableGatewayCallLedger recovers from crash-truncated trailing JSONL line without losing prior intents while rejecting corrupt newline-terminated lines", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "r2-s03-ledger-")));
    tempDirs.push(root);
    await chmod(root, 0o700);
    const ledgerPath = join(root, "calls.jsonl");

    const call1 = {
      schemaVersion: 3 as const,
      callId: "call-durable-1",
      registrationId: "reg-1",
      serviceId: "svc-1",
      tool: "mutate_op",
      input: { key: "v1" },
      idempotencyKey: "idem-d1"
    };
    const ledger1 = new DurableGatewayCallLedger(ledgerPath);
    ledger1.recordIntent(call1);

    // Simulate power loss / SIGKILL mid-write: append a torn JSON fragment WITHOUT trailing '\n'
    const validContent = await readFile(ledgerPath, "utf8");
    expect(validContent.endsWith("\n")).toBe(true);
    await writeFile(
      ledgerPath,
      validContent + '{"ledgerVersion":2,"phase":"intent","call":{"callId":"torn-call',
      { mode: 0o600 }
    );

    // Restarting ledger MUST recover call-durable-1, repair the torn tail, and cleanly append call-durable-2
    const recoveredLedger = new DurableGatewayCallLedger(ledgerPath);
    expect(recoveredLedger.get("call-durable-1")?.result.status).toBe("unknown");
    expect(recoveredLedger.get("torn-call")).toBeUndefined();

    const call2 = {
      ...call1,
      callId: "call-durable-2",
      idempotencyKey: "idem-d2"
    };
    recoveredLedger.recordIntent(call2);
    expect(recoveredLedger.get("call-durable-2")?.result.status).toBe("unknown");

    const repairedContent = await readFile(ledgerPath, "utf8");
    expect(repairedContent.endsWith("\n")).toBe(true);
    expect(repairedContent.split("\n").filter(Boolean)).toHaveLength(2);

    // A corrupt newline-terminated line MUST still fail closed!
    const corruptPath = join(root, "corrupt.jsonl");
    await writeFile(corruptPath, '{"not":"valid_ledger_line"}\n', { mode: 0o600 });
    expect(() => new DurableGatewayCallLedger(corruptPath)).toThrow(/invalid|corrupt/i);
  });

  it("R2-G5: BflowSharedMCPGateway never clears uncertain mutating quarantine from a restarted driver instance, and revoke() aborts in-flight calls to prevent concurrency-slot deadlock", async () => {
    // 1. Post-restart reconcileCall invariant: restarted driver instance 2 returning `not_delivered` MUST NOT clear `unknown` or quarantine from instance 1!
    let crashHook: ((reason: string) => void) | undefined;
    let generationCount = 0;

    const restartFactory: MCPUpstreamDriverFactory = {
      async createInstance(entry, _pk, startGeneration) {
        generationCount++;
        const gen = generationCount;
        let alive = true;
        const driver: MCPUpstreamDriverInstance = {
          instanceId: `${entry.definition.serviceId}-gen-${gen}-s${startGeneration}`,
          startGeneration,
          ownership: "bflow",
          isAlive: () => alive,
          onCrash(cb) {
            crashHook = cb;
            return () => {};
          },
          async stop() {
            alive = false;
          },
          async initialize() {
            return {
              ok: true,
              value: {
                protocolVersion: "2025-06-18",
                discoveredTools: ["browser_click", "browser_status"],
                toolDefinitions: [
                  { name: "browser_click", inputSchema: { type: "object", properties: {} } },
                  { name: "browser_status", inputSchema: { type: "object", properties: {} } }
                ],
                defaultedInputSchemaTools: []
              }
            };
          },
          async listTools() {
            return { ok: true, value: ["browser_click", "browser_status"] };
          },
          async callTool(input) {
            if (gen === 1 && input.tool === "browser_click") {
              // Crash mid-call on generation 1!
              alive = false;
              crashHook?.("segfault_after_click");
              return {
                ok: false,
                error: { code: "transport_unavailable", retryable: true, message: "crashed" }
              };
            }
            return {
              ok: true,
              value: { isError: false, content: [{ type: "text", text: "status-ok" }] }
            };
          },
          async reconcileRequest() {
            // Fresh generation 2 instance has empty in-memory ledger -> reports not_delivered!
            return { status: "not_delivered" };
          }
        };
        return { ok: true, value: driver };
      }
    };

    const registry = new MCPServiceRegistry();
    const browserDef = {
      schemaVersion: 3 as const,
      serviceId: "browser-svc",
      revision: 1,
      scope: SESSION_SCOPE,
      tool: {
        schemaVersion: 3 as const,
        toolId: "browser-svc",
        kind: "stdio_mcp" as const,
        version: "1.0.0",
        operations: ["browser_click", "browser_status"],
        resource: { sharing: "exclusive" as const, resourceKey: "chrome-profile" },
        required: false
      },
      connection: {
        kind: "stdio_mcp" as const,
        executable: "node",
        argv: ["test-worker.js"],
        environmentBindings: {},
        executableDigest: "0".repeat(64),
        ownership: "bflow" as const,
        bridgeRequired: true
      },
      authentication: { mode: "none" as const },
      healthTimeoutMs: 2_000,
      idleTimeoutMs: 60_000,
      restartLimit: 3
    };
    registry.registerService(browserDef, {
      browserAffecting: true,
      concurrencyModel: "exclusive_lease",
      readOnlyTools: ["browser_status"]
    });
    const serviceManager = new DefaultMCPServiceManager({
      registry,
      driverFactory: restartFactory
    });
    const gateway = new BflowSharedMCPGateway({ registry, serviceManager });
    cleanups.push(async () => {
      await serviceManager.shutdownAll();
    });

    await gateway.register(
      makeRegistration(
        "reg-dev1",
        "http://127.0.0.1:9999/mcp",
        ["browser-svc"],
        ["browser_click", "browser_status"]
      ) as never
    );

    const leaseRes = await gateway.acquireResource({
      schemaVersion: 3,
      registrationId: "reg-dev1",
      serviceId: "browser-svc",
      resourceKey: "chrome-profile",
      scope: SESSION_SCOPE,
      ttlMs: 60_000,
      idempotencyKey: "lease-k1"
    });
    expect(leaseRes.ok).toBe(true);
    if (!leaseRes.ok) throw new Error("expected lease");

    const mutCall = {
      schemaVersion: 3 as const,
      callId: "call-click-1",
      registrationId: "reg-dev1",
      serviceId: "browser-svc",
      tool: "browser_click",
      input: {},
      resourceLease: leaseRes.value,
      idempotencyKey: "idem-click-1"
    };
    const firstCallRes = await gateway.call(mutCall);
    expect(firstCallRes).toMatchObject({
      ok: true,
      value: { status: "unknown" }
    });

    // Restart service onto generation 2 (e.g. via listToolsForClient)
    await gateway.listToolsForClient("reg-dev1");
    expect(generationCount).toBe(2);

    // Reconciling call-click-1 MUST NOT accept generation 2's `not_delivered`!
    const recRes = await gateway.reconcileCall(mutCall);
    expect(recRes).toMatchObject({
      ok: true,
      value: { status: "unknown" }
    });

    // Exclusive resource MUST remain quarantined (cannot be newly acquired without resolving uncertainty)
    await gateway.register(
      makeRegistration(
        "reg-dev2",
        "http://127.0.0.1:9999/mcp",
        ["browser-svc"],
        ["browser_click", "browser_status"]
      ) as never
    );
    const quarantinedAcquire = await gateway.acquireResource({
      schemaVersion: 3,
      registrationId: "reg-dev2",
      serviceId: "browser-svc",
      resourceKey: "chrome-profile",
      scope: SESSION_SCOPE,
      ttlMs: 60_000,
      idempotencyKey: "lease-k2"
    });
    expect(quarantinedAcquire).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        details: { diagnosticCode: "resource_quarantined" }
      }
    });

    // 2. revoke() aborts hung in-flight call on a serialized (maxConcurrency=1) service so next role does not deadlock
    let reg1HungEntered!: () => void;
    const reg1Entered = new Promise<void>((r) => {
      reg1HungEntered = r;
    });

    const serialFactory: MCPUpstreamDriverFactory = {
      async createInstance(entry, _pk, startGeneration) {
        const driver: MCPUpstreamDriverInstance = {
          instanceId: `${entry.definition.serviceId}-serial-${startGeneration}`,
          startGeneration,
          ownership: "bflow",
          isAlive: () => true,
          onCrash: () => () => {},
          async stop() {},
          async initialize() {
            return {
              ok: true,
              value: {
                protocolVersion: "2025-06-18",
                discoveredTools: ["gitnexus_query"],
                toolDefinitions: [
                  { name: "gitnexus_query", inputSchema: { type: "object", properties: {} } }
                ],
                defaultedInputSchemaTools: []
              }
            };
          },
          async listTools() {
            return { ok: true, value: ["gitnexus_query"] };
          },
          async callTool(input) {
            if (input.clientId === "reg-hung") {
              reg1HungEntered();
              return await new Promise((resolve) => {
                input.signal?.addEventListener(
                  "abort",
                  () =>
                    resolve({
                      ok: false,
                      error: { code: "cancelled", retryable: false, message: "revoked" }
                    }),
                  { once: true }
                );
              });
            }
            return {
              ok: true,
              value: { isError: false, content: [{ type: "text", text: "gitnexus-ok" }] }
            };
          }
        };
        return { ok: true, value: driver };
      }
    };

    const serialReg = new MCPServiceRegistry();
    const serialDef = makeServiceDef("gitnexus-svc", ["gitnexus_query"], {
      sharing: "concurrent",
      maxConcurrency: 1
    });
    serialReg.registerService(serialDef, {
      concurrencyModel: "serialized",
      readOnlyTools: ["gitnexus_query"],
      callTimeoutMs: 60_000
    });
    const serialSm = new DefaultMCPServiceManager({
      registry: serialReg,
      driverFactory: serialFactory
    });
    const serialGw = new BflowSharedMCPGateway({ registry: serialReg, serviceManager: serialSm });

    await serialGw.register(
      makeRegistration(
        "reg-hung",
        "http://127.0.0.1:9999/mcp",
        ["gitnexus-svc"],
        ["gitnexus_query"]
      ) as never
    );
    await serialGw.register(
      makeRegistration(
        "reg-healthy",
        "http://127.0.0.1:9999/mcp",
        ["gitnexus-svc"],
        ["gitnexus_query"]
      ) as never
    );

    const hungCallPromise = serialGw.call({
      schemaVersion: 3,
      callId: "call-hung-gn",
      registrationId: "reg-hung",
      serviceId: "gitnexus-svc",
      tool: "gitnexus_query",
      input: {},
      idempotencyKey: "idem-hung-gn"
    });
    await reg1Entered;

    const healthyCallPromise = serialGw.call(
      {
        schemaVersion: 3,
        callId: "call-healthy-gn",
        registrationId: "reg-healthy",
        serviceId: "gitnexus-svc",
        tool: "gitnexus_query",
        input: {},
        idempotencyKey: "idem-healthy-gn"
      },
      { timeoutMs: 1_500 }
    );

    // Revoking reg-hung MUST immediately abort its hung call and unblock reg-healthy!
    const revokeRes = await serialGw.revoke("reg-hung", {
      schemaVersion: 3,
      scope: SESSION_SCOPE,
      idempotencyKey: "rev-hung-1"
    });
    expect(revokeRes.ok).toBe(true);

    const [hungRes, healthyRes] = await Promise.all([hungCallPromise, healthyCallPromise]);
    expect(hungRes.ok).toBe(false);
    expect(healthyRes).toMatchObject({
      ok: true,
      value: { status: "completed" }
    });
  });
});
