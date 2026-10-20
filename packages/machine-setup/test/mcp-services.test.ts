import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MCPServiceDefinition } from "@bflow/contracts";
import {
  LaunchdServiceManager,
  McpConfigComponent,
  ServicesComponent,
  SetupStateStore,
  SkillsComponent,
  SystemdUserServiceManager,
  createSkillsComponent,
  selectServiceManager,
  type CommandResult,
  type CommandRunner,
  type PlatformProfile,
  type ServiceDefinition,
  type SetupContext
} from "../src/index.js";

let root: string;
let home: string;
const NOW = new Date("2026-01-02T03:04:05.678Z");
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
class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  active = true;
  fail: (argv: readonly string[]) => CommandResult | null = () => null;
  async run(argv: readonly string[]): Promise<CommandResult> {
    this.calls.push([...argv]);
    if (argv.includes("is-active") && this.fail(argv) === null)
      return { exitCode: 0, stdout: this.active ? "active\n" : "inactive\n", stderr: "", timedOut: false };
    return this.fail(argv) ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }
}
const runner = new FakeRunner();
const ctxFor = (platform: PlatformProfile, mode: SetupContext["mode"] = "apply"): SetupContext => ({
  platform, mode, now: () => NOW, runner
});
const storeFor = (p: PlatformProfile) => new SetupStateStore(p.paths, { uid, now: () => NOW });

const mcp = (id: string, over: Partial<MCPServiceDefinition> = {}): MCPServiceDefinition => ({
  schemaVersion: 3, serviceId: id, revision: 1, scope: { kind: "machine", machineId: "m-1" },
  tool: { schemaVersion: 3, toolId: id, kind: "native_remote_mcp", version: "1", operations: ["read"],
    resource: { sharing: "concurrent", maxConcurrency: 2 }, required: true },
  connection: { kind: "native_remote_mcp", endpoint: "https://example.com/mcp", ownership: "external" },
  authentication: { mode: "none" }, healthTimeoutMs: 1000, idleTimeoutMs: 1000, restartLimit: 1, ...over
}) as MCPServiceDefinition;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bflow-mcp-")));
  home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  runner.calls = [];
  runner.fail = () => null;
  runner.active = true;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("McpConfigComponent", () => {
  const file = () => path.join(root, "xdg/bflow/mcp.json");
  const make = (services: MCPServiceDefinition[], p = profile()) =>
    new McpConfigComponent({ platform: p, store: storeFor(p), services });

  it("adds entries, private perms, and rerun is byte-identical with no write", async () => {
    const p = profile();
    const c = make([mcp("a"), mcp("b")], p);
    expect((await c.apply(ctxFor(p))).diagnostics).toEqual([]);
    const first = await readFile(file(), "utf8");
    const doc = JSON.parse(first);
    expect(doc.schemaVersion).toBe(3);
    expect(Object.keys(doc.services).sort()).toEqual(["a", "b"]);
    expect(doc.managedIds).toEqual(["a", "b"]);
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    const m1 = (await stat(file())).mtimeMs;
    const obs = await c.observe(ctxFor(p));
    const des = await c.desired(ctxFor(p));
    expect(obs.valid).toBe(true);
    expect(obs.stateDigest).toBe(des.digest);
    await new Promise((r) => setTimeout(r, 20));
    await c.apply(ctxFor(p));
    expect(await readFile(file(), "utf8")).toBe(first);
    expect((await stat(file())).mtimeMs).toBe(m1);
    expect(await readdir(path.join(root, "state/bflow")).catch(() => [])).not.toContain("backups");
  });

  it("preserves foreign entries and external, backs up before changing", async () => {
    const p = profile();
    await make([mcp("a")], p).apply(ctxFor(p));
    const doc = JSON.parse(await readFile(file(), "utf8"));
    doc.services.foreign = mcp("foreign");
    doc.external = { keep: [1, 2], me: true };
    await writeFile(file(), JSON.stringify(doc), { mode: 0o600 });
    await make([mcp("a", { revision: 2 })], p).apply(ctxFor(p));
    const next = JSON.parse(await readFile(file(), "utf8"));
    expect(Object.keys(next.services).sort()).toEqual(["a", "foreign"]);
    expect(next.services.a.revision).toBe(2);
    expect(next.external).toEqual({ keep: [1, 2], me: true });
    expect(next.managedIds).toEqual(["a"]);
    expect(await readdir(path.join(root, "state/bflow/backups"))).not.toHaveLength(0);
  });

  it("invalid JSON is invalid, not touched without repair, repaired with backup", async () => {
    const p = profile();
    await mkdir(path.dirname(file()), { recursive: true });
    await writeFile(file(), "{not json");
    const c = make([mcp("a")], p);
    expect((await c.observe(ctxFor(p))).valid).toBe(false);
    expect((await c.desired(ctxFor(p))).repairNeeded).toBe(true);
    const res = await c.apply(ctxFor(p));
    expect(res.diagnostics.join()).toMatch(/repair/);
    expect(await readFile(file(), "utf8")).toBe("{not json");
    const r = await c.apply(ctxFor(p, "repair"));
    expect(r.diagnostics).toEqual([]);
    expect(Object.keys(JSON.parse(await readFile(file(), "utf8")).services)).toEqual(["a"]);
    const backups = path.join(root, "state/bflow/backups");
    const slots = (await readdir(backups)).filter((n) => n !== "index.jsonl");
    expect(await readFile(path.join(backups, slots[0]!, "mcp.json"), "utf8")).toBe("{not json");
  });

  it("repair keeps still-valid foreign entries", async () => {
    const p = profile();
    await mkdir(path.dirname(file()), { recursive: true });
    await writeFile(file(), JSON.stringify({ schemaVersion: 3, services: { good: mcp("good"), bad: { x: 1 } }, managedIds: [] }));
    await make([mcp("a")], p).apply(ctxFor(p, "repair"));
    expect(Object.keys(JSON.parse(await readFile(file(), "utf8")).services).sort()).toEqual(["a", "good"]);
  });

  it("rejects non-machine scope, other machine, and duplicates without writing", async () => {
    const p = profile();
    for (const svc of [
      [mcp("a", { scope: { kind: "machine", machineId: "m-other" } })],
      [mcp("a", { scope: { kind: "repository", machineId: "m-1", repositoryId: "r", workspaceRoot: "/w" } })],
      [mcp("a"), mcp("a")]
    ]) {
      const c = make(svc, p);
      const o = await c.observe(ctxFor(p));
      expect(o.valid).toBe(false);
      expect(o.diagnostics.length).toBeGreaterThan(0);
      const res = await c.apply(ctxFor(p));
      expect(res.ownedPaths).toEqual([]);
      expect(res.diagnostics.length).toBeGreaterThan(0);
      await expect(stat(file())).rejects.toThrow();
    }
  });

  it("check and dry_run never write", async () => {
    const p = profile();
    await make([mcp("a")], p).apply(ctxFor(p, "check"));
    await make([mcp("a")], p).apply(ctxFor(p, "dry_run"));
    await expect(stat(file())).rejects.toThrow();
  });
});

describe("service managers", () => {
  const svc: ServiceDefinition = {
    serviceId: "gw", program: "/opt/bflow/bin/gw", args: ["--port", "9 0"],
    env: { API_TOKEN: "secret://bflow/api-token", MODE: "prod" }, keepAlive: true
  };
  const unit = () => path.join(root, "xdg/systemd/user/bflow-gw.service");
  const plist = () => path.join(home, "Library/LaunchAgents/dev.bflow.gw.plist");

  function systemd() {
    const p = profile();
    return { p, comp: new ServicesComponent({ platform: p, store: storeFor(p), manager: new SystemdUserServiceManager(p, runner, storeFor(p)), services: [svc] }) };
  }
  function launchd() {
    const p = profile({ os: "darwin" });
    return { p, comp: new ServicesComponent({ platform: p, store: storeFor(p), manager: new LaunchdServiceManager(p, runner, storeFor(p)), services: [svc] }) };
  }

  it("systemd renders, installs, runs argv-only commands, never inlines secrets", async () => {
    const { p, comp } = systemd();
    const res = await comp.apply(ctxFor(p));
    expect(res.diagnostics).toEqual([]);
    expect(res.ownedPaths).toEqual([unit()]);
    expect(runner.calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", unit()]
    ]);
    const text = await readFile(unit(), "utf8");
    expect(text).toContain("BFLOW_SECRET_REF_API_TOKEN=secret://bflow/api-token");
    expect(text).toContain("Restart=on-failure");
    expect(text).toContain('ExecStart="/opt/bflow/bin/gw" "--port" "9 0"');
    expect(text).not.toMatch(/sudo/);
  });

  it("systemd rerun: no rewrite, no commands; digests match", async () => {
    const { p, comp } = systemd();
    await comp.apply(ctxFor(p));
    runner.calls = [];
    const m = (await stat(unit())).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    const res = await comp.apply(ctxFor(p));
    expect(res.diagnostics).toEqual([]);
    expect(runner.calls).toEqual([["systemctl", "--user", "is-active", "bflow-gw.service"]]);
    expect((await stat(unit())).mtimeMs).toBe(m);
    const o = await comp.observe(ctxFor(p));
    expect(o.stateDigest).toBe((await comp.desired(ctxFor(p))).digest);
  });

  it("systemd backs up a differing unit before overwrite and reloads only then", async () => {
    const { p, comp } = systemd();
    await mkdir(path.dirname(unit()), { recursive: true });
    await writeFile(unit(), "# old\n");
    await comp.apply(ctxFor(p));
    expect(await readFile(unit(), "utf8")).not.toBe("# old\n");
    const backups = path.join(root, "state/bflow/backups");
    const slots = (await readdir(backups)).filter((n) => n !== "index.jsonl");
    expect(await readFile(path.join(backups, slots[0]!, "bflow-gw.service"), "utf8")).toBe("# old\n");
  });

  it("runner failure yields stderr diagnostics and keeps the unit file", async () => {
    const { p, comp } = systemd();
    runner.fail = (argv) => (argv.includes("enable") ? { exitCode: 1, stdout: "", stderr: "boom failure", timedOut: false } : null);
    const res = await comp.apply(ctxFor(p));
    expect(res.diagnostics.join()).toContain("boom failure");
    expect(res.ownedPaths).toEqual([unit()]);
    await expect(stat(unit())).resolves.toBeTruthy();
  });

  it("failed activation is retried on rerun without rewriting; observe==desired after", async () => {
    const { p, comp } = systemd();
    runner.active = false;
    runner.fail = (argv) => (argv.includes("enable") ? { exitCode: 1, stdout: "", stderr: "nope", timedOut: false } : null);
    expect((await comp.apply(ctxFor(p))).diagnostics.join()).toContain("nope");
    expect((await comp.observe(ctxFor(p))).stateDigest).not.toBe((await comp.desired(ctxFor(p))).digest);
    runner.fail = () => null;
    runner.calls = [];
    const m = (await stat(unit())).mtimeMs;
    expect((await comp.apply(ctxFor(p))).diagnostics).toEqual([]);
    expect(runner.calls.filter((c) => !c.includes("is-active"))).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", unit()]
    ]);
    expect((await stat(unit())).mtimeMs).toBe(m);
    runner.active = true;
    expect((await comp.observe(ctxFor(p))).stateDigest).toBe((await comp.desired(ctxFor(p))).digest);
  });

  it("try-restart only when an existing unit changed", async () => {
    const { p, comp } = systemd();
    await comp.apply(ctxFor(p));
    expect(runner.calls.flat()).not.toContain("try-restart");
    runner.calls = [];
    const p2 = p;
    const changed = new ServicesComponent({ platform: p2, store: storeFor(p2), manager: new SystemdUserServiceManager(p2, runner, storeFor(p2)), services: [{ ...svc, args: ["--x"] }] });
    await changed.apply(ctxFor(p2));
    expect(runner.calls.filter((c) => !c.includes("is-active"))).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", unit()],
      ["systemctl", "--user", "try-restart", "bflow-gw.service"]
    ]);
  });

  it("empty desired set compares equal for services and mcp", async () => {
    const p = profile();
    const sc = new ServicesComponent({ platform: p, store: storeFor(p), manager: new SystemdUserServiceManager(p, runner, storeFor(p)), services: [] });
    expect((await sc.observe(ctxFor(p))).stateDigest).toBe((await sc.desired(ctxFor(p))).digest);
    const mc = new McpConfigComponent({ platform: p, store: storeFor(p), services: [] });
    expect((await mc.observe(ctxFor(p))).stateDigest).toBe((await mc.desired(ctxFor(p))).digest);
  });

  it("check/dry_run never write or mutate; observe may inspect read-only", async () => {
    const { p, comp } = systemd();
    for (const mode of ["check", "dry_run"] as const) await comp.apply(ctxFor(p, mode));
    await comp.observe(ctxFor(p, "check"));
    await expect(stat(unit())).rejects.toThrow();
    expect(runner.calls.filter((c) => !c.includes("is-active"))).toEqual([]);
  });

  it("launchd retries bootstrap while launchd is still tearing down the booted-out job", async () => {
    const { p, comp } = launchd();
    let bootstraps = 0;
    runner.fail = (argv) => argv.includes("bootstrap") && ++bootstraps <= 2
      ? { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error", timedOut: false } : null;
    const res = await comp.apply(ctxFor(p));
    expect(res.diagnostics).toEqual([]);
    expect(runner.calls.filter((c) => c.includes("bootstrap"))).toHaveLength(3);
  });

  it("launchd renders plist, bootout ignored, bootstrap, no secrets inlined", async () => {
    const { p, comp } = launchd();
    runner.fail = (argv) => (argv.includes("bootout") ? { exitCode: 3, stdout: "", stderr: "not loaded", timedOut: false } : null);
    const res = await comp.apply(ctxFor(p));
    expect(res.diagnostics).toEqual([]);
    expect(res.ownedPaths).toEqual([plist()]);
    expect(runner.calls).toEqual([
      ["launchctl", "bootout", `gui/${uid}/dev.bflow.gw`],
      ["launchctl", "bootstrap", `gui/${uid}`, plist()]
    ]);
    const text = await readFile(plist(), "utf8");
    expect(text).toContain("BFLOW_SECRET_REF_API_TOKEN");
    expect(text).toContain("secret://bflow/api-token");
    expect(text).toContain("<key>Label</key>");
    runner.calls = [];
    runner.fail = () => null;
    await comp.apply(ctxFor(p));
    expect(runner.calls).toEqual([["launchctl", "print", `gui/${uid}/dev.bflow.gw`]]);
  });

  it("inspect uses is-active / launchctl print", async () => {
    const s = systemd();
    await s.comp.apply(ctxFor(s.p));
    runner.calls = [];
    runner.fail = () => ({ exitCode: 0, stdout: "active\n", stderr: "", timedOut: false });
    const m = new SystemdUserServiceManager(s.p, runner, storeFor(s.p));
    expect((await m.inspect("gw")).active).toBe(true);
    expect(runner.calls).toEqual([["systemctl", "--user", "is-active", "bflow-gw.service"]]);
    const l = launchd();
    await l.comp.apply(ctxFor(l.p));
    runner.calls = [];
    const lm = new LaunchdServiceManager(l.p, runner, storeFor(l.p));
    expect((await lm.inspect("gw")).active).toBe(true);
    expect(runner.calls).toEqual([["launchctl", "print", `gui/${uid}/dev.bflow.gw`]]);
  });

  it("reports stale units without deleting; repair removes only marked ones", async () => {
    const { p, comp } = systemd();
    await mkdir(path.dirname(unit()), { recursive: true });
    const stale = path.join(path.dirname(unit()), "bflow-old.service");
    const foreign = path.join(path.dirname(unit()), "bflow-user.service");
    await comp.apply(ctxFor(p));
    await writeFile(stale, "# Managed by bflow\n[Service]\n");
    await writeFile(foreign, "[Service]\n");
    const o = await comp.observe(ctxFor(p));
    expect(o.diagnostics.join()).toContain("bflow-old.service");
    expect(o.diagnostics.join()).not.toContain("bflow-user.service");
    await comp.apply(ctxFor(p));
    await expect(stat(stale)).resolves.toBeTruthy();
    await comp.apply(ctxFor(p, "repair"));
    await expect(stat(stale)).rejects.toThrow();
    await expect(stat(foreign)).resolves.toBeTruthy();
  });

  it("selectServiceManager picks per platform; windows never writes", async () => {
    const p = profile();
    expect(selectServiceManager(p, runner, storeFor(p)).kind).toBe("systemd-user");
    expect(selectServiceManager(profile({ os: "darwin" }), runner, storeFor(p)).kind).toBe("launchd");
    const w = profile({ os: "win32", supportStatus: "designed_unverified" });
    const mgr = selectServiceManager(w, runner, storeFor(w));
    expect(mgr.kind).toBe("windows-unverified");
    const comp = new ServicesComponent({ platform: w, store: storeFor(w), manager: mgr, services: [svc] });
    const res = await comp.apply(ctxFor(w));
    expect(res.diagnostics).toContain("windows support not verified");
    expect(res.ownedPaths).toEqual([]);
    expect(runner.calls).toEqual([]);
  });

  it("rejects service env that is not a secret ref but credential-like control chars", async () => {
    const p = profile();
    const bad: ServiceDefinition = { ...svc, args: ["a\nb"] };
    const comp = new ServicesComponent({ platform: p, store: storeFor(p), manager: new SystemdUserServiceManager(p, runner, storeFor(p)), services: [bad] });
    const res = await comp.apply(ctxFor(p));
    expect(res.diagnostics.length).toBeGreaterThan(0);
    await expect(stat(unit())).rejects.toThrow();
  });
});

describe("skills", () => {
  it("component omitted with diagnostic when no synchronizer", () => {
    const r = createSkillsComponent(undefined);
    expect(r.component).toBeNull();
    expect(r.diagnostics).toEqual(["skills synchronizer not configured"]);
  });
  it("invalid synchronizer output never throws", async () => {
    const bad = { observe: async () => ({ x: 1 }), desired: async () => ({ y: 2 }), sync: async () => ({ z: 3 }) } as never;
    const comp = new SkillsComponent(bad);
    const p = profile();
    expect((await comp.observe(ctxFor(p))).valid).toBe(false);
    const d = await comp.desired(ctxFor(p));
    expect(d.repairNeeded).toBe(false);
    expect(d.summary).toContain("invalid");
    expect((await comp.apply(ctxFor(p))).diagnostics.length).toBeGreaterThan(0);
  });
  it("adapter delegates to the synchronizer and never mutates in check", async () => {
    let synced = 0;
    const comp = new SkillsComponent({
      observe: async () => ({ stateDigest: "a", valid: true, diagnostics: [] }),
      desired: async () => ({ digest: "b", summary: "s", targets: ["/x"], machineWide: false, repairNeeded: false }),
      sync: async () => { synced++; return { ownedPaths: ["/x"], diagnostics: [] }; }
    });
    const p = profile();
    expect(comp.componentId).toBe("role-skills");
    expect(comp.action).toBe("resolve_skills");
    expect((await comp.observe(ctxFor(p))).stateDigest).toBe("a");
    await comp.apply(ctxFor(p, "check"));
    expect(synced).toBe(0);
    expect(await comp.apply(ctxFor(p))).toEqual({ ownedPaths: ["/x"], diagnostics: [] });
    expect(synced).toBe(1);
  });
});
