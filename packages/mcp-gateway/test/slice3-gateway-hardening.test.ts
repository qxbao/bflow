import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgyStdioHttpGatewayBridge,
  BflowSharedMCPGateway,
  DefaultMCPServiceManager,
  DurableGatewayCallLedger,
  StdioToHttpBridge,
  StreamableHttpGatewayServer
} from "../src/index.js";
import { readSseResponse } from "../src/http-upstream.js";
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

function chunksToStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!);
      } else {
        controller.close();
      }
    }
  });
}

const SESSION_SCOPE = {
  kind: "session" as const,
  machineId: "m1",
  repositoryId: "r1",
  workspaceRoot: "/tmp/ws",
  sessionId: "s1"
};

function makeRemoteService(serviceId: string, endpoint: string, operations: readonly string[]) {
  return {
    schemaVersion: 3 as const,
    serviceId,
    revision: 1,
    scope: { kind: "machine" as const, machineId: "m1" },
    tool: {
      schemaVersion: 3 as const,
      toolId: serviceId,
      kind: "native_remote_mcp" as const,
      version: "hosted",
      operations: [...operations],
      resource: { sharing: "concurrent" as const, maxConcurrency: 8 },
      required: false
    },
    connection: {
      kind: "native_remote_mcp" as const,
      endpoint,
      ownership: "external" as const
    },
    authentication: { mode: "none" as const },
    healthTimeoutMs: 2_000,
    idleTimeoutMs: 60_000,
    restartLimit: 2
  };
}

describe("Slice 3 Shared MCP Gateway hardening regressions", () => {
  it("G1: readSseResponse handles chunk-split CRLF, split UTF-8, comments, EOF without trailing blank line, and JSON-RPC batches", async () => {
    const enc = new TextEncoder();

    // 1. Chunk-split \r and \n across Uint8Array boundaries + multi-line data + split 4-byte UTF-8 emoji
    const emojiBytes = Buffer.from("🚀", "utf8");
    const part1 = enc.encode(": keepalive\r");
    const part2 = enc.encode("\nevent: message\r");
    const part3 = enc.encode('\ndata: {"jsonrpc":"2.0",\r');
    const part4 = Buffer.concat([enc.encode('\ndata: "id":42,"result":{"text":"'), emojiBytes.subarray(0, 2)]);
    const part5 = Buffer.concat([emojiBytes.subarray(2), enc.encode('"}}\r')]);
    const part6 = enc.encode("\n\r");
    const part7 = enc.encode("\n");

    const parsed1 = await readSseResponse(
      chunksToStream([part1, part2, part3, part4, part5, part6, part7]),
      42,
      1024 * 1024
    );
    expect(parsed1).toMatchObject({ id: 42, result: { text: "🚀" } });

    // 2. Final SSE event at EOF without trailing \n\n + standalone \r line endings
    const eofStream = chunksToStream([
      enc.encode('event: message\rdata: {"jsonrpc":"2.0","id":"eof-1","result":{"ok":true}}')
    ]);
    const parsed2 = await readSseResponse(eofStream, "eof-1", 1024 * 1024);
    expect(parsed2).toMatchObject({ id: "eof-1", result: { ok: true } });

    // 3. JSON-RPC batch array inside SSE data frame
    const batchStream = chunksToStream([
      enc.encode(
        'data: [{"jsonrpc":"2.0","id":"other","result":{"wrong":true}},{"jsonrpc":"2.0","id":"target-id","result":{"batched":true}}]\n\n'
      )
    ]);
    const parsed3 = await readSseResponse(batchStream, "target-id", 1024 * 1024);
    expect(parsed3).toMatchObject({ id: "target-id", result: { batched: true } });
  });

  it("G1: HttpUpstreamDriverInstance decodes SSE without text/event-stream Content-Type and aliases DeepWiki ask_question <-> ask_wiki_question", async () => {
    const calledUpstreamNames: string[] = [];
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        // Upstream omits Content-Type: text/event-stream (sends text/plain) and misses trailing \n\n
        const sendSseWithoutHeader = (result: unknown) => {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "mcp-session-id": "dw-sess-1" });
          res.end(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}`);
        };
        if (body.method === "initialize") {
          sendSseWithoutHeader({
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "DeepWiki", version: "2.14.3" }
          });
          return;
        }
        if (body.method === "tools/list") {
          // Upstream advertises legacy `ask_question` instead of `ask_wiki_question`
          sendSseWithoutHeader({
            tools: [
              {
                name: "ask_question",
                inputSchema: {
                  type: "object",
                  properties: { repoName: { type: "string" }, question: { type: "string" } },
                  required: ["repoName", "question"]
                }
              },
              {
                name: "read_wiki_structure",
                inputSchema: {
                  type: "object",
                  properties: { repoName: { type: "string" } },
                  required: ["repoName"]
                }
              },
              {
                name: "read_wiki_contents",
                inputSchema: {
                  type: "object",
                  properties: { repoName: { type: "string" } },
                  required: ["repoName"]
                }
              }
            ]
          });
          return;
        }
        if (body.method === "tools/call") {
          calledUpstreamNames.push(body.params.name);
          sendSseWithoutHeader({
            content: [{ type: "text", text: `Answered via ${body.params.name}` }],
            isError: false
          });
          return;
        }
        res.writeHead(400).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    );
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

    const ops = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"];
    const gateway = new BflowSharedMCPGateway({
      policyOverrides: () => ({ readOnlyTools: ops })
    });
    const svc = makeRemoteService("deepwiki", endpoint, ops);
    const ensured = await gateway.serviceManager.ensure(svc, {
      schemaVersion: 3,
      scope: SESSION_SCOPE,
      idempotencyKey: "ens-dw-1"
    });
    expect(ensured).toMatchObject({ ok: true, value: { status: "ready" } });

    await gateway.register({
      schemaVersion: 3,
      registrationId: "reg-dw",
      provider: "claude",
      role: "developer",
      scope: SESSION_SCOPE,
      environmentId: "env-1",
      serviceIds: ["deepwiki"],
      allowedTools: ops,
      connection: {
        transport: "streamable_http",
        endpoint: "http://127.0.0.1:4317/mcp",
        token: "secret://test/reg-dw"
      },
      configDigest: "a".repeat(64),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      idempotencyKey: "reg-dw-k"
    } as never);

    const callRes = await gateway.call({
      schemaVersion: 3,
      callId: "call-dw-1",
      registrationId: "reg-dw",
      serviceId: "deepwiki",
      tool: "ask_wiki_question",
      input: { repoName: "facebook/react", question: "What is Fiber?" },
      idempotencyKey: "idem-dw-1"
    });
    expect(callRes).toMatchObject({
      ok: true,
      value: {
        status: "completed",
        output: [{ type: "text", text: "Answered via ask_question" }]
      }
    });
    expect(calledUpstreamNames).toEqual(["ask_question"]);
  });

  it("G2: AgyStdioHttpGatewayBridge unwraps { content, structuredContent }, StreamableHttpGatewayServer routes multi-service tools/call without serviceId, and Gateway synthesizes validated structuredContent", async () => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (body.method === "notifications/initialized") {
          res.writeHead(202).end();
          return;
        }
        const reply = (result: unknown) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        };
        if (body.method === "initialize") {
          reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
          return;
        }
        if (body.method === "tools/list") {
          const isAlpha = req.url === "/alpha";
          reply({
            tools: isAlpha
              ? [
                  {
                    name: "alpha_lookup",
                    inputSchema: { type: "object", properties: {} }
                  }
                ]
              : [
                  {
                    name: "read_wiki_structure",
                    inputSchema: {
                      type: "object",
                      properties: { repoName: { type: "string" } },
                      required: ["repoName"]
                    },
                    outputSchema: {
                      type: "object",
                      properties: { result: { type: "string" } },
                      required: ["result"]
                    }
                  }
                ]
          });
          return;
        }
        if (body.method === "tools/call") {
          // Upstream omits `structuredContent` despite advertising `outputSchema`, returning valid JSON in text content
          reply({
            content: [{ type: "text", text: JSON.stringify({ result: "Outline for facebook/react" }) }],
            isError: false
          });
          return;
        }
        res.writeHead(400).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    );
    const port = (server.address() as AddressInfo).port;

    const gateway = new BflowSharedMCPGateway({
      policyOverrides: () => ({ readOnlyTools: ["alpha_lookup", "read_wiki_structure"] })
    });
    const httpServer = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
    const gwBase = await httpServer.start();
    cleanups.push(() => httpServer.stop());
    const gwEndpoint = `${gwBase}/mcp`;

    await gateway.serviceManager.ensure(
      makeRemoteService("alpha-svc", `http://127.0.0.1:${port}/alpha`, ["alpha_lookup"]),
      { schemaVersion: 3, scope: SESSION_SCOPE, idempotencyKey: "ens-alpha" }
    );
    await gateway.serviceManager.ensure(
      makeRemoteService("deepwiki", `http://127.0.0.1:${port}/deepwiki`, ["read_wiki_structure"]),
      { schemaVersion: 3, scope: SESSION_SCOPE, idempotencyKey: "ens-dw2" }
    );

    await gateway.register({
      schemaVersion: 3,
      registrationId: "reg-multi",
      provider: "claude",
      role: "developer",
      scope: SESSION_SCOPE,
      environmentId: "env-multi",
      serviceIds: ["alpha-svc", "deepwiki"],
      allowedTools: ["alpha_lookup", "read_wiki_structure"],
      connection: {
        transport: "streamable_http",
        endpoint: gwEndpoint,
        token: "secret://test/reg-multi"
      },
      configDigest: "b".repeat(64),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      idempotencyKey: "reg-multi-k"
    } as never);
    const token = gateway.secretStore.getClientTokenByRegistration("reg-multi")!;

    // 1. Native HTTP client calls `tools/call` WITHOUT `serviceId` when target tool is in `serviceIds[1]` ("deepwiki")
    const httpCallRes = await fetch(gwEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "read_wiki_structure", arguments: { repoName: "facebook/react" } }
      })
    });
    const httpBody = (await httpCallRes.json()) as any;
    expect(httpBody.error).toBeUndefined();
    expect(httpBody.result).toMatchObject({
      status: "completed",
      output: {
        content: [{ type: "text", text: '{"result":"Outline for facebook/react"}' }],
        structuredContent: { result: "Outline for facebook/react" }
      }
    });

    // 2. AgyStdioHttpGatewayBridge unwraps `{ content, structuredContent }` instead of double-stringifying it
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    let outBuf = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outBuf += chunk;
      let nl: number;
      while ((nl = outBuf.indexOf("\n")) !== -1) {
        lines.push(outBuf.slice(0, nl));
        outBuf = outBuf.slice(nl + 1);
      }
    });
    const bridge = new AgyStdioHttpGatewayBridge({
      input,
      output,
      endpoint: gwEndpoint,
      registrationId: "reg-multi",
      serviceIds: ["alpha-svc", "deepwiki"],
      bearerToken: token
    });
    const bridgeRun = bridge.run();
    cleanups.push(async () => {
      input.end();
      await bridgeRun;
    });

    const waitLine = async (count: number) => {
      for (let i = 0; i < 200 && lines.length < count; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(lines.length).toBeGreaterThanOrEqual(count);
    };

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" }
      }) + "\n"
    );
    await waitLine(1);
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    await waitLine(2);
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "read_wiki_structure", arguments: { repoName: "facebook/react" } }
      }) + "\n"
    );
    await waitLine(3);

    const agyToolResult = JSON.parse(lines[2]!);
    expect(agyToolResult).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        isError: false,
        content: [{ type: "text", text: '{"result":"Outline for facebook/react"}' }],
        structuredContent: { result: "Outline for facebook/react" }
      }
    });
  });

  it("G3: shared ensure() isolates aborting caller from co-waiters, HTTP client disconnect aborts in-flight upstream call, StdioToHttpBridge preserves split UTF-8, and DurableGatewayCallLedger reloads incrementally", async () => {
    // 1. DefaultMCPServiceManager shared ensure() isolation
    let createCount = 0;
    let stopCount = 0;
    let upstreamCallAborted = false;
    let notifyUpstreamEntered!: () => void;
    const upstreamEntered = new Promise<void>((r) => {
      notifyUpstreamEntered = r;
    });

    const slowDriverFactory: MCPUpstreamDriverFactory = {
      async createInstance(entry, _pk, startGeneration) {
        createCount++;
        const driver: MCPUpstreamDriverInstance = {
          instanceId: `${entry.definition.serviceId}-inst-${startGeneration}`,
          startGeneration,
          ownership: "bflow",
          isAlive: () => true,
          onCrash: () => () => {},
          async stop() {
            stopCount++;
          },
          async initialize(opts) {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 80);
              opts?.signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  reject(new Error("init aborted"));
                },
                { once: true }
              );
            });
            return {
              ok: true,
              value: {
                protocolVersion: "2025-06-18",
                discoveredTools: ["slow_op"],
                toolDefinitions: [
                  { name: "slow_op", inputSchema: { type: "object", properties: {} } }
                ],
                defaultedInputSchemaTools: []
              }
            };
          },
          async listTools() {
            return { ok: true, value: ["slow_op"] };
          },
          async callTool(input) {
            notifyUpstreamEntered();
            return await new Promise((resolve) => {
              input.signal?.addEventListener(
                "abort",
                () => {
                  upstreamCallAborted = true;
                  resolve({
                    ok: false,
                    error: { code: "cancelled", retryable: false, message: "aborted" }
                  });
                },
                { once: true }
              );
            });
          }
        };
        return { ok: true, value: driver };
      }
    };

    const serviceManager = new DefaultMCPServiceManager({
      driverFactory: slowDriverFactory,
      policyOverrides: () => ({ readOnlyTools: ["slow_op"] })
    });
    const gateway = new BflowSharedMCPGateway({
      serviceManager,
      policyOverrides: () => ({ readOnlyTools: ["slow_op"] })
    });
    const baseSlowSvc = makeRemoteService("slow-svc", "http://127.0.0.1:9999/mcp", ["slow_op"]);
    const slowSvc = {
      ...baseSlowSvc,
      tool: {
        ...baseSlowSvc.tool,
        kind: "stdio_mcp" as const
      },
      connection: {
        kind: "stdio_mcp" as const,
        executable: process.execPath,
        executableDigest: "c".repeat(64),
        argv: [],
        environmentBindings: {},
        ownership: "bflow" as const,
        bridgeRequired: true as const
      }
    };

    const abortA = new AbortController();
    setTimeout(() => abortA.abort(), 15);
    const [ensureA, ensureB] = await Promise.all([
      serviceManager.ensure(
        slowSvc,
        { schemaVersion: 3, scope: SESSION_SCOPE, idempotencyKey: "ens-a" },
        { signal: abortA.signal }
      ),
      serviceManager.ensure(slowSvc, {
        schemaVersion: 3,
        scope: SESSION_SCOPE,
        idempotencyKey: "ens-b"
      })
    ]);
    expect(ensureA.ok).toBe(false);
    expect(ensureB).toMatchObject({ ok: true, value: { status: "ready" } });
    expect(createCount).toBe(1);
    expect(stopCount).toBe(0);

    // 2. HTTP client TCP disconnect mid-tools/call aborts upstream call & /health stays responsive
    const httpServer = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
    const baseUrl = await httpServer.start();
    cleanups.push(() => httpServer.stop());

    await gateway.register({
      schemaVersion: 3,
      registrationId: "reg-slow",
      provider: "claude",
      role: "developer",
      scope: SESSION_SCOPE,
      environmentId: "env-slow",
      serviceIds: ["slow-svc"],
      allowedTools: ["slow_op"],
      connection: {
        transport: "streamable_http",
        endpoint: `${baseUrl}/mcp`,
        token: "secret://test/reg-slow"
      },
      configDigest: "d".repeat(64),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      idempotencyKey: "reg-slow-k"
    } as never);
    const slowToken = gateway.secretStore.getClientTokenByRegistration("reg-slow")!;

    const port = httpServer.getPort();
    const rawBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "disconnect-1",
      method: "tools/call",
      params: { name: "slow_op", arguments: {} }
    });
    const rawSocket = connect(port, "127.0.0.1", () => {
      rawSocket.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${slowToken}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(rawBody)}\r\n\r\n${rawBody}`
      );
    });
    await upstreamEntered;

    // /health responds quickly while slow_op is in-flight
    const healthStart = Date.now();
    const healthRes = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: `Bearer ${slowToken}` }
    });
    expect(healthRes.status).toBe(200);
    expect(Date.now() - healthStart).toBeLessThan(200);

    // Client abruptly drops TCP connection after body was completely read
    rawSocket.destroy();
    for (let i = 0; i < 100 && !upstreamCallAborted; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(upstreamCallAborted).toBe(true);

    // 3. StdioToHttpBridge split multi-byte UTF-8 across stdout chunks + >32-bit timeoutMs
    const childStdin = new PassThrough();
    const childStdout = new PassThrough();
    childStdin.on("data", (buf: Buffer) => {
      const msg = JSON.parse(buf.toString("utf8").trim());
      const replyBytes = Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: "🚀🎉" }] }
        }) + "\n",
        "utf8"
      );
      const splitAt = replyBytes.indexOf(0xf0) + 2; // Split right in the middle of 4-byte 🚀
      childStdout.write(replyBytes.subarray(0, splitAt));
      setTimeout(() => childStdout.write(replyBytes.subarray(splitAt)), 10);
    });
    const stdioBridge = new StdioToHttpBridge({
      instanceId: "stdio-utf8-1",
      startGeneration: 1,
      stdin: childStdin,
      stdout: childStdout
    });
    cleanups.push(() => stdioBridge.stop());
    const stdioCall = await stdioBridge.callTool({
      sessionId: "s1",
      clientId: "c1",
      requestId: "r1",
      callId: "call-1",
      tool: "echo",
      arguments: {},
      timeoutMs: 3_000_000_000
    });
    expect(stdioCall).toMatchObject({
      ok: true,
      value: { isError: false, content: [{ type: "text", text: "🚀🎉" }] }
    });

    // 4. DurableGatewayCallLedger incremental multi-instance coherence
    const dir = await realpath(await mkdtemp(join(tmpdir(), "bflow-ledger-s3-")));
    await chmod(dir, 0o700);
    tempDirs.push(dir);
    const ledgerPath = join(dir, "calls.jsonl");
    const ledgerA = new DurableGatewayCallLedger(ledgerPath);
    const ledgerB = new DurableGatewayCallLedger(ledgerPath);

    expect(
      ledgerA.pinServiceSchema({
        serviceId: "svc-1",
        revision: 1,
        serviceConfigDigest: "1".repeat(64),
        schemaDigest: "2".repeat(64)
      })
    ).toBe(true);
    expect(
      ledgerB.pinServiceSchema({
        serviceId: "svc-1",
        revision: 1,
        serviceConfigDigest: "1".repeat(64),
        schemaDigest: "2".repeat(64)
      })
    ).toBe(true);
    // Drift detection across instances after incremental reload
    expect(
      ledgerB.pinServiceSchema({
        serviceId: "svc-1",
        revision: 1,
        serviceConfigDigest: "1".repeat(64),
        schemaDigest: "9".repeat(64)
      })
    ).toBe(false);
  });
});
