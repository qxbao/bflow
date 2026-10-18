import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LaunchdServiceManager,
  SetupStateStore,
  SystemdUserServiceManager,
  isolatedPlatformProfile,
  isolatedServiceNamespace,
  selectServiceManager,
  unregisterAllServices,
  type CommandResult,
  type CommandRunner,
  type PlatformProfile,
  type ServiceDefinition
} from "../src/index.js";

let root: string;
let home: string;
const uid = typeof process.getuid === "function" ? process.getuid() : 501;

function profile(over: Partial<PlatformProfile> = {}): PlatformProfile {
  return {
    os: "linux", arch: "x64", supportStatus: "supported", shell: "bash", shellPath: "/bin/bash",
    uid, gid: null, isRoot: false, elevationAvailable: false, homeDir: home, hostname: "h", machineId: "m-1",
    paths: {
      config: path.join(root, "xdg/bflow"), data: path.join(root, "data/bflow"),
      state: path.join(root, "state/bflow"), managedBin: path.join(home, ".local/bin")
    },
    pathEntries: ["/usr/bin"], ...over
  };
}

/** Fake OS manager: records argv, reports every command as successful unless overridden. */
class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  fail: (argv: readonly string[]) => CommandResult | null = () => null;
  async run(argv: readonly string[]): Promise<CommandResult> {
    this.calls.push([...argv]);
    return this.fail(argv) ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}

const svc: ServiceDefinition = {
  serviceId: "mcp-gateway", program: "/opt/bflow/bin/gw", args: ["--serve"], env: {}, keepAlive: true
};

const storeFor = (p: PlatformProfile) => new SetupStateStore(p.paths, { uid, now: () => new Date() });

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bflow-svc-ns-")));
  home = path.join(root, "home");
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("isolated service namespace", () => {
  it("derives a stable 12-hex namespace per resolved root and differs across roots", () => {
    const a = isolatedServiceNamespace("/tmp/bflow-x");
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(isolatedServiceNamespace("/tmp/bflow-x/")).toBe(a);
    expect(isolatedServiceNamespace("/tmp/bflow-y")).not.toBe(a);
  });

  it("rejects namespaces that cannot be used in unit names", () => {
    const r = new FakeRunner();
    const p = profile();
    expect(() => new SystemdUserServiceManager(p, r, storeFor(p), { namespace: "Bad-Name" })).toThrow(/invalid service namespace/);
    expect(() => new LaunchdServiceManager(profile({ os: "darwin" }), r, storeFor(p), { namespace: "a.b" })).toThrow();
  });
});

describe("systemd-user unit naming", () => {
  it("real mode keeps today's unit names exactly", async () => {
    const p = profile();
    const runner = new FakeRunner();
    const m = new SystemdUserServiceManager(p, runner, storeFor(p));
    expect(m.namespace).toBeUndefined();
    expect(m.unitPath("mcp-gateway")).toBe(path.join(root, "xdg/systemd/user/bflow-mcp-gateway.service"));
    await m.install(svc);
    expect(runner.calls).toContainEqual(["systemctl", "--user", "enable", "--now", m.unitPath("mcp-gateway")]);
    await m.inspect("mcp-gateway");
    expect(runner.calls).toContainEqual(["systemctl", "--user", "is-active", "bflow-mcp-gateway.service"]);
  });

  it("isolated mode namespaces every unit name, file and manager command", async () => {
    const isolatedRoot = path.join(root, "isolated");
    const p = isolatedPlatformProfile(profile(), isolatedRoot);
    const ns = isolatedServiceNamespace(isolatedRoot);
    const runner = new FakeRunner();
    const m = new SystemdUserServiceManager(p, runner, storeFor(p), { namespace: ns });
    expect(m.namespace).toBe(ns);
    const unit = path.join(isolatedRoot, "systemd/user", `bflow-${ns}-mcp-gateway.service`);
    expect(m.unitPath("mcp-gateway")).toBe(unit);
    const r = await m.install(svc);
    expect(r.ownedPaths).toEqual([unit]);
    expect(runner.calls).toContainEqual(["systemctl", "--user", "enable", "--now", unit]);
    await m.inspect("mcp-gateway");
    expect(runner.calls).toContainEqual(["systemctl", "--user", "is-active", `bflow-${ns}-mcp-gateway.service`]);
    expect(runner.calls.flat()).not.toContain("bflow-mcp-gateway.service");
  });

  it("isolated listing only reports units of its own namespace", async () => {
    const isolatedRoot = path.join(root, "isolated");
    const p = isolatedPlatformProfile(profile(), isolatedRoot);
    const ns = isolatedServiceNamespace(isolatedRoot);
    const m = new SystemdUserServiceManager(p, new FakeRunner(), storeFor(p), { namespace: ns });
    const dir = path.join(isolatedRoot, "systemd/user");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `bflow-${ns}-mcp-gateway.service`), "# Managed by bflow\n");
    await writeFile(path.join(dir, "bflow-mcp-gateway.service"), "# Managed by bflow\n");
    expect(await m.listInstalled()).toEqual(["mcp-gateway"]);
  });

  it("selectServiceManager forwards the namespace", () => {
    const p = profile();
    const m = selectServiceManager(p, new FakeRunner(), storeFor(p), { namespace: "abc123def456" });
    expect(m.namespace).toBe("abc123def456");
    expect(m.unitPath("gw")).toContain("bflow-abc123def456-gw.service");
    expect(selectServiceManager(p, new FakeRunner(), storeFor(p)).namespace).toBeUndefined();
  });
});

describe("launchd label naming", () => {
  it("real mode keeps dev.bflow.<id>; isolated mode namespaces label and file", async () => {
    const real = profile({ os: "darwin" });
    const lm = new LaunchdServiceManager(real, new FakeRunner(), storeFor(real));
    expect(lm.unitPath("gw")).toBe(path.join(home, "Library/LaunchAgents/dev.bflow.gw.plist"));

    const iso = profile({ os: "darwin" });
    const runner = new FakeRunner();
    const im = new LaunchdServiceManager(iso, runner, storeFor(iso), { namespace: "0123456789ab" });
    expect(im.unitPath("gw")).toBe(path.join(home, "Library/LaunchAgents/dev.bflow.0123456789ab-gw.plist"));
    await im.install({ ...svc, serviceId: "gw" });
    expect(runner.calls).toContainEqual(["launchctl", "bootstrap", `gui/${uid}`, im.unitPath("gw")]);
    expect(await readdir(path.join(home, "Library/LaunchAgents"))).toEqual(["dev.bflow.0123456789ab-gw.plist"]);
  });
});

describe("unregister (teardown)", () => {
  it("systemd: disables by name, removes the marked unit, reloads the manager", async () => {
    const isolatedRoot = path.join(root, "isolated");
    const p = isolatedPlatformProfile(profile(), isolatedRoot);
    const ns = isolatedServiceNamespace(isolatedRoot);
    const runner = new FakeRunner();
    const m = new SystemdUserServiceManager(p, runner, storeFor(p), { namespace: ns });
    await m.install(svc);
    const unit = m.unitPath("mcp-gateway");
    runner.calls = [];

    const r = await m.unregister("mcp-gateway");
    expect(r.diagnostics).toEqual([]);
    expect(r.ownedPaths).toEqual([unit]);
    expect(runner.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", `bflow-${ns}-mcp-gateway.service`],
      ["systemctl", "--user", "daemon-reload"]
    ]);
    await expect(stat(unit)).rejects.toThrow();
  });

  it("systemd: is idempotent; a second call is a quiet no-op without a file", async () => {
    const isolatedRoot = path.join(root, "isolated");
    const p = isolatedPlatformProfile(profile(), isolatedRoot);
    const runner = new FakeRunner();
    const m = new SystemdUserServiceManager(p, runner, storeFor(p), { namespace: "aaaaaaaaaaaa" });
    await m.install(svc);
    await m.unregister("mcp-gateway");

    // Even when the manager reports the absent unit as a failure, nothing is reported for an absent service.
    runner.fail = () => ({ exitCode: 1, stdout: "", stderr: "Unit does not exist", timedOut: false });
    runner.calls = [];
    const again = await m.unregister("mcp-gateway");
    expect(again).toEqual({ ownedPaths: [], diagnostics: [] });
    expect(runner.calls).toEqual([
      ["systemctl", "--user", "disable", "--now", "bflow-aaaaaaaaaaaa-mcp-gateway.service"],
      ["systemctl", "--user", "daemon-reload"]
    ]);
  });

  it("systemd: reports a failing disable when the unit file existed", async () => {
    const p = profile();
    const runner = new FakeRunner();
    const m = new SystemdUserServiceManager(p, runner, storeFor(p));
    await m.install(svc);
    runner.fail = (argv) => (argv.includes("disable") ? { exitCode: 1, stdout: "", stderr: "bus unavailable", timedOut: false } : null);
    const r = await m.unregister("mcp-gateway");
    expect(r.diagnostics.join()).toContain("bus unavailable");
    expect(r.ownedPaths).toEqual([m.unitPath("mcp-gateway")]);
  });

  it("never removes a unit file that bflow does not mark", async () => {
    const p = profile();
    const runner = new FakeRunner();
    const m = new SystemdUserServiceManager(p, runner, storeFor(p));
    const unit = m.unitPath("mcp-gateway");
    await mkdir(path.dirname(unit), { recursive: true });
    await writeFile(unit, "[Service]\nExecStart=/operator/worker\n");
    const r = await m.unregister("mcp-gateway");
    expect(r.ownedPaths).toEqual([]);
    expect(r.diagnostics.join()).toContain("not marked as bflow-managed");
    expect(runner.calls).toEqual([]);
    await expect(stat(unit)).resolves.toBeTruthy();
  });

  it("launchd: boots out the namespaced label and removes the marked plist", async () => {
    const p = profile({ os: "darwin" });
    const runner = new FakeRunner();
    const m = new LaunchdServiceManager(p, runner, storeFor(p), { namespace: "fedcba987654" });
    await m.install({ ...svc, serviceId: "gw" });
    runner.calls = [];
    const r = await m.unregister("gw");
    expect(r.diagnostics).toEqual([]);
    expect(runner.calls).toEqual([["launchctl", "bootout", `gui/${uid}/dev.bflow.fedcba987654-gw`]]);
    await expect(stat(m.unitPath("gw"))).rejects.toThrow();
    expect((await m.unregister("gw")).ownedPaths).toEqual([]);
  });

  it("unregisterAllServices tears down every namespaced unit and is safe to repeat", async () => {
    const isolatedRoot = path.join(root, "isolated");
    const p = isolatedPlatformProfile(profile(), isolatedRoot);
    const runner = new FakeRunner();
    const m = new SystemdUserServiceManager(p, runner, storeFor(p), { namespace: isolatedServiceNamespace(isolatedRoot) });
    await m.install(svc);
    await m.install({ ...svc, serviceId: "gitnexus-1" });
    const first = await unregisterAllServices(m);
    expect(first.serviceIds.sort()).toEqual(["gitnexus-1", "mcp-gateway"]);
    expect(first.diagnostics).toEqual([]);
    expect(await m.listInstalled()).toEqual([]);
    expect(await unregisterAllServices(m)).toEqual({ serviceIds: [], diagnostics: [] });
  });

  it("isolatedPlatformProfile keeps identity fields and roots every path under the isolated root", () => {
    const base = profile();
    const iso = isolatedPlatformProfile(base, path.join(root, "iso"));
    expect(iso.machineId).toBe(base.machineId);
    expect(iso.paths).toEqual({
      config: path.join(root, "iso/config"), data: path.join(root, "iso/data"),
      state: path.join(root, "iso/state"), managedBin: path.join(root, "iso/data/bin")
    });
    expect(iso.paths.config).not.toBe(base.paths.config);
  });
});
