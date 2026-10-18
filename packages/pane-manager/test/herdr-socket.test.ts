import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandInvocation, CommandOutcome, HerdrCommandRunner } from "../src/types.js";
import { createHerdrSocketPort, HERDR_SOCKET_RESPONSE_LIMIT_BYTES } from "../src/herdr-socket.js";

const SESSION = "bflow-socket-test";
const SECRET = "tok-SOCKETSECRET-7777";

interface Harness {
  readonly path: string;
  readonly connections: () => number;
  readonly requests: Record<string, unknown>[];
  close(): Promise<void>;
}

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

/** Real Unix socket server in a temp directory; `respond` decides what each newline-delimited request receives. */
async function startSocketServer(respond: (socket: Socket, request: Record<string, unknown>) => void): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "bflow-sock-"));
  const path = join(dir, "h.sock");
  const sockets = new Set<Socket>();
  const requests: Record<string, unknown>[] = [];
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(request);
      respond(socket, request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  const harness: Harness = {
    path,
    connections: () => connections,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  };
  cleanup.push(() => harness.close());
  return harness;
}

function statusRunner(status: Record<string, unknown> | string, exitCode = 0): HerdrCommandRunner & { readonly calls: CommandInvocation[] } {
  const calls: CommandInvocation[] = [];
  return {
    calls,
    async run(invocation: CommandInvocation): Promise<CommandOutcome> {
      calls.push(invocation);
      if (exitCode !== 0) return { exitCode, stdout: "", stderr: "server status failed" };
      return { exitCode: 0, stdout: typeof status === "string" ? status : JSON.stringify(status), stderr: "" };
    }
  };
}

function statusFor(socket: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { session: SESSION, running: true, socket, ...overrides };
}

const PANE_RESULT = { type: "pane_info", pane: { pane_id: "pane-1" } };

describe("createHerdrSocketPort", () => {
  it("resolves the socket through status server --json and sends one newline-delimited request", async () => {
    const server = await startSocketServer((socket, request) => {
      socket.end(`${JSON.stringify({ id: request["id"], result: PANE_RESULT })}\n`);
    });
    const runner = statusRunner(statusFor(server.path));
    const port = createHerdrSocketPort({ runner, sessionId: SESSION });

    const result = await port.request("pane.split", { target_pane_id: "pane-0", direction: "right", env: { BFLOW_MCP_TOKEN_X: SECRET } });

    expect(result).toEqual({ ok: true, value: PANE_RESULT });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.args).toEqual(["status", "server", "--json"]);
    expect(runner.calls[0]!.env).toBeUndefined();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: "pane.split", params: { target_pane_id: "pane-0", direction: "right", env: { BFLOW_MCP_TOKEN_X: SECRET } } });
    expect(typeof server.requests[0]!["id"]).toBe("string");
  });

  it("rejects a socket owned by a foreign session without contacting it", async () => {
    const server = await startSocketServer((socket, request) => socket.end(`${JSON.stringify({ id: request["id"], result: PANE_RESULT })}\n`));
    const port = createHerdrSocketPort({ runner: statusRunner(statusFor(server.path, { session: "someone-else" })), sessionId: SESSION });

    const result = await port.request("tab.create", { workspace_id: "ws-1", env: { K: SECRET } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(server.connections()).toBe(0);
  });

  it("reports a transport failure when the named session is not running", async () => {
    const server = await startSocketServer((socket, request) => socket.end(`${JSON.stringify({ id: request["id"], result: PANE_RESULT })}\n`));
    const port = createHerdrSocketPort({ runner: statusRunner(statusFor(server.path, { running: false })), sessionId: SESSION });

    const result = await port.request("pane.split", { target_pane_id: "pane-0", direction: "right" });

    expect(result).toMatchObject({ ok: false, error: { code: "transport_unavailable", retryable: true } });
    expect(server.connections()).toBe(0);
  });

  it("rejects malformed or relative socket paths and malformed status output", async () => {
    const relative = createHerdrSocketPort({ runner: statusRunner(statusFor("relative/h.sock")), sessionId: SESSION });
    expect(await relative.request("pane.split", {})).toMatchObject({ ok: false, error: { code: "corruption" } });

    const malformed = createHerdrSocketPort({ runner: statusRunner("{not json"), sessionId: SESSION });
    expect(await malformed.request("pane.split", {})).toMatchObject({ ok: false, error: { code: "corruption" } });

    const failed = createHerdrSocketPort({ runner: statusRunner("", 1), sessionId: SESSION });
    expect(await failed.request("pane.split", {})).toMatchObject({ ok: false, error: { code: "transport_unavailable" } });
  });

  it("maps remote errors by code only and never echoes Herdr's message or request params", async () => {
    const server = await startSocketServer((socket, request) => {
      socket.end(`${JSON.stringify({ id: request["id"], error: { code: "pane_not_found", message: `pane has ${SECRET}` } })}\n`);
    });
    const port = createHerdrSocketPort({ runner: statusRunner(statusFor(server.path)), sessionId: SESSION });

    const notFound = await port.request("pane.split", { target_pane_id: "gone", env: { BFLOW_MCP_TOKEN_X: SECRET } });
    expect(notFound).toEqual({ ok: false, error: { code: "not_found", retryable: false, message: "Herdr pane.split target was not found (pane_not_found)" } });
    expect(JSON.stringify(notFound)).not.toContain(SECRET);

    const other = createHerdrSocketPort({ runner: statusRunner(statusFor(server.path)), sessionId: SESSION });
    const rejected = await other.request("tab.create", { env: { BFLOW_MCP_TOKEN_X: SECRET } });
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain(SECRET);
    expect(JSON.stringify(rejected)).not.toContain("pane has");
  });

  it("rejects a response larger than the limit and keeps the message free of response content", async () => {
    const limit = 4096;
    const server = await startSocketServer((socket) => {
      socket.write("x".repeat(limit + 1024));
    });
    const port = createHerdrSocketPort({ runner: statusRunner(statusFor(server.path)), sessionId: SESSION, responseLimitBytes: limit });

    const result = await port.request("pane.split", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("corruption");
    expect(result.error.message).toContain(String(limit));
    expect(result.error.message).not.toContain("xxxx");
  });

  it("enforces the default 1 MiB response limit", async () => {
    expect(HERDR_SOCKET_RESPONSE_LIMIT_BYTES).toBe(1024 * 1024);
    const server = await startSocketServer((socket) => {
      socket.write(Buffer.alloc(HERDR_SOCKET_RESPONSE_LIMIT_BYTES + 1, 0x61));
    });
    const port = createHerdrSocketPort({ runner: statusRunner(statusFor(server.path)), sessionId: SESSION });

    expect(await port.request("pane.split", {})).toMatchObject({ ok: false, error: { code: "corruption" } });
  });

  it("times out a silent socket as a transport failure that must be reconciled", async () => {
    const server = await startSocketServer(() => undefined);
    const port = createHerdrSocketPort({ runner: statusRunner(statusFor(server.path)), sessionId: SESSION, defaultTimeoutMs: 150 });

    const started = Date.now();
    const result = await port.request("pane.split", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("transport_unavailable");
    expect(result.error.message).toContain("reconcile");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects a response that does not correlate with its request id, or is not JSON", async () => {
    const wrongId = await startSocketServer((socket) => socket.end(`${JSON.stringify({ id: "other", result: PANE_RESULT })}\n`));
    expect(await createHerdrSocketPort({ runner: statusRunner(statusFor(wrongId.path)), sessionId: SESSION }).request("pane.split", {}))
      .toMatchObject({ ok: false, error: { code: "corruption" } });

    const garbage = await startSocketServer((socket) => socket.end("<html>not herdr</html>\n"));
    const result = await createHerdrSocketPort({ runner: statusRunner(statusFor(garbage.path)), sessionId: SESSION }).request("pane.split", {});
    expect(result).toMatchObject({ ok: false, error: { code: "corruption" } });
    expect(JSON.stringify(result)).not.toContain("not herdr");
  });

  it("honours an abort signal before and during the request", async () => {
    const server = await startSocketServer(() => undefined);
    const port = createHerdrSocketPort({ runner: statusRunner(statusFor(server.path)), sessionId: SESSION });

    const aborted = new AbortController();
    aborted.abort();
    expect(await port.request("pane.split", {}, { signal: aborted.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });

    const late = new AbortController();
    const pending = port.request("pane.split", {}, { signal: late.signal, timeoutMs: 5000 });
    setTimeout(() => late.abort(), 50);
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
});
