import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { StdioToHttpBridge } from "../src/index.js";

function createTestBridge(defaultTimeoutMs = 10_000) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const bridge = new StdioToHttpBridge({
    instanceId: "inst-flow04",
    startGeneration: 1,
    stdin,
    stdout,
    defaultTimeoutMs
  });
  return { bridge, stdin, stdout };
}

describe("Flow-04 StdioToHttpBridge initialize & listToolDefinitions signal/deadline/budget hardening", () => {
  it("cancels initialize immediately when AbortSignal aborts during handshake or during tools/list", async () => {
    // 1. Abort while waiting for `initialize` response
    const first = createTestBridge(30_000);
    const abortHandshake = new AbortController();
    const pendingHandshake = first.bridge.initialize({ signal: abortHandshake.signal });
    setTimeout(() => abortHandshake.abort(), 20);
    const res1 = await pendingHandshake;
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.error.code).toBe("cancelled");
    }

    // 2. Complete `initialize`, then abort while waiting for `tools/list`
    const second = createTestBridge(30_000);
    const abortToolsList = new AbortController();
    second.stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const msg = JSON.parse(line) as { id?: string; method?: string };
        if (msg.method === "initialize" && msg.id) {
          second.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: "2024-11-05", capabilities: {} }
            })}\n`
          );
        } else if (msg.method === "tools/list") {
          setTimeout(() => abortToolsList.abort(), 15);
        }
      }
    });
    const res2 = await second.bridge.initialize({ signal: abortToolsList.signal });
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.error.code).toBe("cancelled");
    }
  });

  it("shares a single remaining timeout budget across initialize and tools/list instead of double-spending timeoutMs", async () => {
    const { bridge, stdin, stdout } = createTestBridge(30_000);
    stdin.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n").filter(Boolean)) {
        const msg = JSON.parse(line) as { id?: string; method?: string };
        if (msg.method === "initialize" && msg.id) {
          // Consume ~85ms of the 130ms total budget
          setTimeout(() => {
            stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { protocolVersion: "2024-11-05", capabilities: {} }
              })}\n`
            );
          }, 85);
        } else if (msg.method === "tools/list" && msg.id) {
          // Reply after 95ms (would succeed if tools/list got a fresh 130ms budget, must time out under shared 130ms budget!)
          setTimeout(() => {
            stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] }
              })}\n`
            );
          }, 95);
        }
      }
    });

    const startedAt = Date.now();
    const res = await bridge.initialize({ timeoutMs: 130 });
    const elapsedMs = Date.now() - startedAt;

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("timeout");
    }
    expect(elapsedMs).toBeLessThan(230);
  });

  it("fails closed with not_started before writing to stdin when deadline is already expired or timeoutMs <= 0", async () => {
    const { bridge, stdin } = createTestBridge(30_000);
    let bytesWritten = 0;
    stdin.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.byteLength;
    });

    const expiredDeadline = new Date(Date.now() - 500).toISOString();
    const initExpired = await bridge.initialize({ deadline: expiredDeadline });
    expect(initExpired).toMatchObject({
      ok: false,
      error: { code: "timeout", retrySafety: "not_started" }
    });

    const listZero = await bridge.listToolDefinitions("sess-1", { timeoutMs: 0 });
    expect(listZero).toMatchObject({
      ok: false,
      error: { code: "timeout", retrySafety: "not_started" }
    });

    const listInvalid = await bridge.listToolDefinitions("sess-1", { deadline: "not-a-date" });
    expect(listInvalid).toMatchObject({
      ok: false,
      error: { code: "validation" }
    });

    expect(bytesWritten).toBe(0);
  });
});
