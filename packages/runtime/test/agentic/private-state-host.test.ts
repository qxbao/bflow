import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { ensureAgenticHost, openPersistedAgenticHost } from "../../dist/agentic/host-controller.js";
import { resolvePrivateRuntimeStateDirectory } from "../../src/private-state.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });

async function exercise(root: string, emulate: boolean) {
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateHome = fs.mkdtempSync("/tmp/bflow-private-host-state-");
  cleanup.push(() => fs.rmSync(stateHome, { recursive: true, force: true }));
  vi.stubEnv("XDG_STATE_HOME", stateHome);
  if (emulate) {
    const observe = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, ...args: unknown[]) => {
      const stat = Reflect.apply(observe, fs, [fd, ...args]);
      return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(root + "/.bflow/.private-state-probe-")
        ? Object.assign(stat, { mode: 0o100777 }) : stat;
    }) as typeof fs.fstatSync);
  }
  // Keep existing lifecycle receipts/manifest locations: there is no new session
  // identity, automatic transport replay or copied host credential.
  fs.mkdirSync(join(root, ".bflow/state"), { recursive: true });
  fs.writeFileSync(join(root, ".bflow/state/operation.json"), '{"phase":"manager_pending"}');
  const binary = join(stateHome, "herdr.mjs");
  fs.writeFileSync(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({running:false}));\n', { mode: 0o700 });
  const legacyHost = join(root, ".bflow/state/host/private-host");
  fs.mkdirSync(legacyHost, { recursive: true });
  fs.writeFileSync(join(legacyHost, "host.json"), '{"token":"unused-exposed-token"}');
  fs.writeFileSync(join(legacyHost, "boot.lock"), "");
  const state = resolvePrivateRuntimeStateDirectory(root);
  expect(state.startsWith(stateHome + "/")).toBe(true);
  const options = { repositoryPath: root, sessionId: "private-host", herdrBinary: binary };
  const host = await ensureAgenticHost(options);
  cleanup.push(() => host.shutdown().catch(() => undefined));
  const launch = await host.prepare();
  expect(launch.roleLaunch.coordinator!.mcpConfigFile.startsWith(state + "/host/")).toBe(true);
  const path = join(state, "host/private-host/host.json");
  expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  const before = fs.readFileSync(path, "utf8");
  expect(before).not.toContain("unused-exposed-token");
  // A failed pre-relocation startup retained a full config naming the same
  // stable socket. Once the private host starts, that socket is now live.
  const legacyConfiguration = JSON.stringify({ ...JSON.parse(before), directory: legacyHost, token: "unused-exposed-token" });
  fs.writeFileSync(join(legacyHost, "host.json"), legacyConfiguration);
  expect(resolvePrivateRuntimeStateDirectory(root)).toBe(state);
  expect(fs.readFileSync(join(legacyHost, "host.json"), "utf8")).toBe(legacyConfiguration);
  expect((await host.runtime.findRuns({ limit: 10 })).ok).toBe(true);
  expect(fs.existsSync(join(state, "agentic/runs.db"))).toBe(true);
  expect(fs.existsSync(join(root, ".bflow/state/agentic"))).toBe(false);
  await host.close();
  const recovered = await openPersistedAgenticHost(options);
  expect(await recovered.prepare()).toEqual(launch);
  expect(fs.readFileSync(path, "utf8")).toBe(before);
  expect(fs.readFileSync(join(root, ".bflow/state/operation.json"), "utf8")).toBe('{"phase":"manager_pending"}');
  expect((await recovered.quiesce()).ok).toBe(true);
  await recovered.shutdown();
}

describe.skipIf(process.platform !== "linux")("private state host integration", () => {
  it("prepares and reopens the same host with private configs and SQLite off the repository mount", async () => {
    await exercise(fs.mkdtempSync("/tmp/bflow-private-host-"), true);
  });
  it("does not expose partially written host configuration to concurrent location readers", async () => {
    const root = fs.mkdtempSync("/tmp/bflow-atomic-host-");
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const stateHome = join(root, "user-state"); vi.stubEnv("XDG_STATE_HOME", stateHome);
    const external = join(stateHome, "bflow/repositories", createHash("sha256").update(root).digest("hex"), "state");
    fs.mkdirSync(external, { recursive: true, mode: 0o700 });
    expect(resolvePrivateRuntimeStateDirectory(root)).toBe(external);
    const binary = join(root, "herdr.mjs");
    fs.writeFileSync(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({running:false}));\n', { mode: 0o700 });
    let opened!: () => void, resume!: () => void;
    const atWrite = new Promise<void>(resolve => { opened = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const originalOpen = fsPromises.open;
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const file = await originalOpen(...args);
      if (String(args[0]).includes("/host.json")) {
        const write = file.writeFile.bind(file);
        file.writeFile = async (...values) => { opened(); await gate; return write(...values); };
      }
      return file;
    });
    syncBuiltinESMExports();
    const starting = ensureAgenticHost({ repositoryPath: root, sessionId: "atomic-host", herdrBinary: binary });
    try {
      await atWrite;
      expect(() => resolvePrivateRuntimeStateDirectory(root)).not.toThrow();
      expect(fs.existsSync(join(external, "host/atomic-host/host.json"))).toBe(false);
    } finally {
      resume();
      const host = await starting;
      await host.shutdown();
    }
  });
  it.skipIf(!process.env.BFLOW_TEST_NON_POSIX_ROOT)("runs the same lifecycle on an actual mount without private file permissions", async () => {
    await exercise(fs.mkdtempSync(join(process.env.BFLOW_TEST_NON_POSIX_ROOT!, ".bflow-private-host-")), false);
  });
});
