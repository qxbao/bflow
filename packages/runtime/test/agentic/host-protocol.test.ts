import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { callHost } from "../../src/agentic/host-protocol.js";

const resources: { server: Server; directory: string }[] = [];
afterEach(async () => {
  for (const { server, directory } of resources.splice(0)) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
async function response(size: number) {
  const directory = await mkdtemp(join(tmpdir(), "bflow-host-rpc-")), path = join(directory, "socket");
  const server = createServer(socket => {
    socket.on("error", () => {});
    socket.once("data", () => socket.end(JSON.stringify({ ok: true, value: "x".repeat(size) }) + "\n"));
  });
  resources.push({ server, directory });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return path;
}
it("receives a persisted checkpoint larger than the ordinary control response limit", async () => {
  const path = await response(5 * 1024 * 1024);
  expect((await callHost(path, "token", "checkpoint", {}, 5000) as string).length).toBe(5 * 1024 * 1024);
});
it("keeps the ordinary control response bound", async () => {
  const path = await response(4 * 1024 * 1024);
  await expect(callHost(path, "token", "host_status", {}, 5000)).rejects.toThrow("Host response exceeds limit");
});
it("still rejects an oversized checkpoint response", async () => {
  const path = await response(16 * 1024 * 1024);
  await expect(callHost(path, "token", "checkpoint", {}, 5000)).rejects.toThrow("Host response exceeds limit");
});
