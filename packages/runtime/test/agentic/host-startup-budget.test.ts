import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgenticHost } from "../../dist/agentic/host-controller.js";
import { callHost } from "../../src/agentic/host-protocol.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function fakeHost(delayMs = 0) {
  // Short Unix socket paths also work on macOS.
  const root = await realpath(await mkdtemp("/tmp/bflow-budget-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, ".bflow/state/host/budget");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const socketPath = join(root, "host.sock");
  const requests: { method: string; params: { deadline?: string } }[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", chunk => {
      input += String(chunk);
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!);
      requests.push(request);
      if (request.method !== "prepare") { socket.end('{"ok":true,"value":null}\n'); return; }
      const timer = setTimeout(() => {
        timers.delete(timer);
        socket.end('{"ok":true,"value":{"roleLaunch":{}}}\n');
      }, delayMs);
      timers.add(timer);
    });
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(socketPath, accept); });
  cleanup.push(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(accept => server.close(() => accept()));
  });
  await writeFile(join(directory, "host.json"), JSON.stringify({ repositoryPath: root, sessionId: "budget", directory,
    socketPath, token: "test-control-token" }), { mode: 0o600 });
  return { root, socketPath, requests, controller: await ensureAgenticHost({ repositoryPath: root, sessionId: "budget" }) };
}

describe.skipIf(process.platform === "win32")("host startup operation budget", () => {
  it("accepts a preparation taking longer than the old 30-second RPC limit within the lifecycle budget", async () => {
    const f = await fakeHost(31_000);
    const deadline = new Date(Date.now() + 65_000).toISOString();
    expect(await f.controller.prepare({ timeoutMs: 65_000, deadline })).toEqual({ roleLaunch: {} });
    expect(f.requests.filter(request => request.method === "prepare")).toEqual([{ token: "test-control-token", method: "prepare", params: { deadline } }]);
  }, 45_000);

  it("cancels an in-flight preparation without resending it", async () => {
    const f = await fakeHost(1000);
    const controller = new AbortController();
    const pending = f.controller.prepare({ timeoutMs: 65_000, signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow("operator cancelled");
    await expect.poll(() => f.requests.filter(request => request.method === "prepare").length).toBe(1);
    controller.abort(new Error("operator cancelled"));
    await rejected;
    expect(f.requests.filter(request => request.method === "prepare")).toHaveLength(1);
  });

  it("does not connect when a request was already cancelled", async () => {
    await expect(callHost("/nonexistent/bflow.sock", "token", "prepare", {}, 65_000,
      AbortSignal.abort(new Error("already cancelled")))).rejects.toThrow("already cancelled");
  });

  it("reports the method and elapsed budget when the host does not acknowledge", async () => {
    const f = await fakeHost(1000);
    await expect(f.controller.prepare({ timeoutMs: 30 })).rejects.toThrow("prepare acknowledgement timed out after 30ms; reconcile before retry");
    expect(f.requests.filter(request => request.method === "prepare")).toHaveLength(1);
  });

  it("shuts down the real host daemon without unlinking its already-removed Unix socket", async () => {
    const root = await realpath(await mkdtemp("/tmp/bflow-shutdown-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, "herdr.mjs");
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({running:false}));\n', { mode: 0o700 });
    const controller = await ensureAgenticHost({ repositoryPath: root, sessionId: "shutdown", herdrBinary: binary });
    const directory = join(root, ".bflow/state/host/shutdown");
    const owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"));
    const config = JSON.parse(await readFile(join(directory, "host.json"), "utf8"));
    cleanup.push(async () => { try { process.kill(owner.pid, "SIGTERM"); } catch { /* already stopped */ } });
    await expect(callHost(config.socketPath, config.token, "prepare", { deadline: new Date(Date.now() - 1).toISOString() }))
      .rejects.toThrow("preparation deadline has expired");
    expect(await controller.prepare({ timeoutMs: 1000 })).toHaveProperty("roleLaunch");
    expect((await controller.quiesce()).ok).toBe(true);
    await expect(controller.prepare({ timeoutMs: 1000 })).rejects.toThrow("Host is shutting down");
    await controller.shutdown();
    await expect.poll(async () => {
      try { process.kill(owner.pid, 0); return false; } catch { return true; }
    }).toBe(true);
    expect(await readFile(join(directory, "host.log"), "utf8")).not.toContain("ENOENT");
  });
});
