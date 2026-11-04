import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgenticHost } from "../../dist/agentic/host-controller.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe.skipIf(process.platform === "win32")("host control startup readiness", () => {
  it("does not acknowledge startup before socket permissions, owner receipt and close handler are initialized", async () => {
    const root = await mkdtemp("/tmp/bflow-ready-"); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, "herdr.mjs"), preload = join(root, "slow-socket-permissions.cjs");
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({running:false}));\n', { mode: 0o700 });
    await writeFile(preload, `const fs = require("node:fs/promises");
const original = fs.chmod;
fs.chmod = async (path, ...args) => {
  if (String(path).endsWith(".sock")) await new Promise(resolve => setTimeout(resolve, 750));
  return original(path, ...args);
};
require("node:module").syncBuiltinESMExports();
`);
    const previous = process.env.NODE_OPTIONS;
    let controller: Awaited<ReturnType<typeof ensureAgenticHost>> | undefined;
    const owner = join(root, ".bflow/state/host/ready/owner.json");
    cleanups.push(async () => {
      if (!controller) return;
      await expect.poll(async () => { try { await readFile(owner); return true; } catch { return false; } }, { timeout: 5000 }).toBe(true);
      await controller.shutdown();
    });
    try {
      process.env.NODE_OPTIONS = [previous, "--require", preload].filter(Boolean).join(" ");
      controller = await ensureAgenticHost({ repositoryPath: root, sessionId: "ready", herdrBinary: binary });
      const recorded = JSON.parse(await readFile(owner, "utf8"));
      expect(recorded.pid).toBeGreaterThan(0);
      expect(() => process.kill(recorded.pid, 0)).not.toThrow();
    } finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
  });

  it("rejects an overlong persisted Unix socket before publishing a truncated endpoint or writing host authority", async () => {
    const root = await mkdtemp("/tmp/bflow-long-socket-"); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const directory = join(root, "host"); await mkdir(directory, { mode: 0o700 });
    const path = join(directory, "host.json");
    await writeFile(path, JSON.stringify({ repositoryPath: root, sessionId: "long-path", directory,
      socketPath: join(root, "x".repeat(120), "host.sock"), token: "fixture-owner-token" }), { mode: 0o600 });
    const daemon = fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url));
    const child = spawn(process.execPath, [daemon, "daemon", path], { stdio: ["ignore", "ignore", "pipe"] });
    let error = "";
    const observed = new Promise<void>(resolve => { child.stderr!.on("data", bytes => {
      error += String(bytes); if (/Error:/.test(error)) resolve();
    }); child.once("exit", () => resolve()); });
    try {
      await observed;
      expect(error).toMatch(/Unix socket path is too long/);
      expect(await readdir(directory)).toEqual(["host.json"]);
    } finally { if (child.exitCode === null) { const stopped = new Promise<void>(resolve => child.once("exit", () => resolve())); child.kill("SIGTERM"); await stopped; } }
  });
});
