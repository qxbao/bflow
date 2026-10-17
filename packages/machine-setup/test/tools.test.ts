import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolInstallRequestSchema, type ToolInstaller } from "@bflow/contracts";
import {
  TOOL_CATALOG,
  ToolInstallerRegistry,
  buildInstallRequest,
  compareSemver,
  defaultMachineConfig,
  detectPlatform,
  loadMachineConfig,
  probeTools,
  type CommandResult,
  type CommandRunner,
  type PlatformProfile,
  type ToolInstallDescriptor
} from "../src/index.js";

let root: string;
let home: string;
let binDir: string;
let platform: PlatformProfile;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bflow-tools-"));
  home = path.join(root, "home");
  binDir = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(binDir, { recursive: true });
  platform = detectPlatform({
    platform: "linux",
    arch: "x64",
    env: { SHELL: "/bin/bash", PATH: binDir },
    homeDir: home,
    hostname: "box",
    uid: 1000,
    gid: 1000
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exe(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const f = path.join(dir, name);
  await writeFile(f, `#!/bin/sh\necho ${name}\n`);
  await chmod(f, 0o755);
  return f;
}

function runnerFor(outputs: Record<string, Partial<CommandResult>>): CommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(argv) {
      calls.push([...argv]);
      const o = outputs[path.basename(argv[0] as string)];
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...(o ?? {}) };
    }
  };
}

const REQ = new Set(["node", "pnpm", "git", "herdr"]);
// Isolate from the real machine: only HOME-local and managed dirs are searched.
const KNOWN = (p: PlatformProfile) => [path.join(p.homeDir, ".local", "bin"), p.paths.managedBin];
const byId = (obs: Awaited<ReturnType<typeof probeTools>>, id: string) => obs.find((o) => o.toolId === id)!;

describe("catalog", () => {
  it("covers runtime, provider and auxiliary CLIs without shell installers", () => {
    expect(TOOL_CATALOG.map((t) => t.toolId)).toEqual(["node", "pnpm", "git", "herdr", "claude", "codex", "agy", "rtk", "gitnexus", "chrome-devtools-mcp"]);
    for (const t of TOOL_CATALOG)
      for (const g of Object.values(t.manualGuidance)) expect(g).not.toMatch(/curl|\|\s*(ba)?sh/);
  });
  it("compares strict semver", () => {
    expect(compareSemver("22.13.0", "22.13.0")).toBe(0);
    expect(compareSemver("22.9.0", "22.13.0")).toBe(-1);
    expect(compareSemver("v1", "1.0.0")).toBeNull();
  });
});

describe("probeTools", () => {
  it("finds RTK archives and npm tools in their managed destinations", async () => {
    const rtk = await exe(path.join(platform.paths.data, "tools", "rtk"), "rtk");
    const gitnexus = await exe(path.join(platform.paths.data, "tools", "gitnexus", "node_modules", ".bin"), "gitnexus");
    const chrome = await exe(path.join(platform.paths.data, "tools", "chrome-devtools-mcp", "node_modules", ".bin"), "chrome-devtools-mcp");
    const observations = await probeTools(platform, runnerFor({
      rtk: { stdout: "rtk 0.33.0" }, gitnexus: { stdout: "1.4.7" }, "chrome-devtools-mcp": { stdout: "0.20.3" }
    }), { required: new Set(["rtk", "gitnexus", "chrome-devtools-mcp"]), knownInstallDirs: KNOWN });
    for (const [id, file] of [["rtk", rtk], ["gitnexus", gitnexus], ["chrome-devtools-mcp", chrome]]) {
      expect(byId(observations, id!)).toMatchObject({ status: "path_missing", resolvedPath: file, required: true });
    }
  });

  it("reports unknown required pins instead of silently omitting them", async () => {
    const observations = await probeTools(platform, runnerFor({}), { required: new Set(["unknown-tool"]), knownInstallDirs: KNOWN });
    expect(byId(observations, "unknown-tool")).toMatchObject({ status: "missing", required: true });
  });

  it("clean machine: nothing found", async () => {
    const runner = runnerFor({});
    const obs = await probeTools(platform, runner, { required: REQ, knownInstallDirs: KNOWN });
    expect(obs.every((o) => o.status === "missing" && o.resolvedPath === null)).toBe(true);
    expect(byId(obs, "node").required).toBe(true);
    expect(byId(obs, "claude").required).toBe(false);
    expect(runner.calls).toHaveLength(0);
  });

  it("partial: node too old, git ok", async () => {
    await exe(binDir, "node");
    await exe(binDir, "git");
    const runner = runnerFor({
      node: { stdout: "v22.9.0\n" },
      git: { stdout: "git version 2.39.5 (Apple Git-154)\n" }
    });
    const obs = await probeTools(platform, runner, { required: REQ, knownInstallDirs: KNOWN });
    expect(byId(obs, "node").status).toBe("version_mismatch");
    expect(byId(obs, "node").version).toBe("22.9.0");
    const git = byId(obs, "git");
    expect(git.status).toBe("present");
    expect(git.version).toBe("2.39.5");
    expect(git.binaryDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(git.realPath).not.toBeNull();
    expect(byId(obs, "pnpm").status).toBe("missing");
  });

  it("existing: everything present and matching", async () => {
    const out: Record<string, Partial<CommandResult>> = {
      node: { stdout: "v22.19.0" },
      pnpm: { stdout: "12.5.1\n" },
      git: { stdout: "git version 2.43.0" },
      herdr: { stdout: "herdr 0.9.1-weird\n" },
      claude: { stdout: "2.1.3 (Claude Code)" },
      codex: { stdout: "codex-cli 0.40.0" },
      agy: { stdout: "agy 1.0.0" }
    };
    for (const n of Object.keys(out)) await exe(binDir, n);
    const obs = await probeTools(platform, runnerFor(out), { required: new Set([...REQ, "claude"]), knownInstallDirs: KNOWN });
    expect(Object.keys(out).every((id) => byId(obs, id).status === "present")).toBe(true);
    expect(byId(obs, "herdr").version).toBe("herdr");
    expect(byId(obs, "claude").required).toBe(true);
    expect(byId(obs, "codex").required).toBe(false);
  });

  it("pnpm must be exactly 12.5.1", async () => {
    await exe(binDir, "pnpm");
    const obs = await probeTools(platform, runnerFor({ pnpm: { stdout: "12.6.0" } }), { required: REQ, knownInstallDirs: KNOWN });
    expect(byId(obs, "pnpm").status).toBe("version_mismatch");
  });

  it("path_missing: claude in ~/.local/bin but not on PATH", async () => {
    const dir = path.join(home, ".local", "bin");
    const f = await exe(dir, "claude");
    const obs = await probeTools(platform, runnerFor({ claude: { stdout: "2.0.1" } }), { required: new Set(), knownInstallDirs: KNOWN });
    const c = byId(obs, "claude");
    expect(c.status).toBe("path_missing");
    expect(path.dirname(c.resolvedPath!)).toBe(dir);
    expect(c.resolvedPath).toBe(f);
    expect(c.version).toBe("2.0.1");
    expect(c.pathMissingDir).toBe(dir);
  });

  it("keeps pathMissingDir when a later check overrides the status", async () => {
    const dir = path.join(home, ".local", "bin");
    await exe(dir, "node");
    await exe(binDir, "git");
    const obs = await probeTools(platform, runnerFor({ node: { stdout: "v20.0.0" }, git: { stdout: "git version 2.40.0" } }), {
      required: REQ,
      knownInstallDirs: KNOWN
    });
    expect(byId(obs, "node").status).toBe("version_mismatch");
    expect(byId(obs, "node").pathMissingDir).toBe(dir);
    expect(byId(obs, "git").pathMissingDir).toBeNull();
  });

  it("unparseable version", async () => {
    await exe(binDir, "node");
    const obs = await probeTools(platform, runnerFor({ node: { stdout: "banana" } }), { required: REQ, knownInstallDirs: KNOWN });
    expect(byId(obs, "node").status).toBe("unparseable_version");
  });

  it("probe timeout and non-zero exit are probe_failed", async () => {
    await exe(binDir, "node");
    await exe(binDir, "git");
    const obs = await probeTools(
      platform,
      runnerFor({ node: { timedOut: true, exitCode: null }, git: { exitCode: 1 } }),
      { required: REQ, knownInstallDirs: KNOWN }
    );
    expect(byId(obs, "node").status).toBe("probe_failed");
    expect(byId(obs, "git").status).toBe("probe_failed");
  });

  it("passes a 10s timeout and argv array", async () => {
    await exe(binDir, "herdr");
    const seen: unknown[] = [];
    const runner: CommandRunner = {
      async run(argv, options) {
        seen.push(argv, options?.timeoutMs);
        return { exitCode: 0, stdout: "1.2.3", stderr: "", timedOut: false };
      }
    };
    await probeTools(platform, runner, { required: REQ, knownInstallDirs: KNOWN });
    expect(seen[1]).toBe(10_000);
    expect(Array.isArray(seen[0])).toBe(true);
  });

  it("ignores non-executable files and directories", async () => {
    await writeFile(path.join(binDir, "node"), "x", { mode: 0o644 });
    await mkdir(path.join(binDir, "git"));
    const obs = await probeTools(platform, runnerFor({}), { required: REQ, knownInstallDirs: KNOWN });
    expect(byId(obs, "node").status).toBe("missing");
    expect(byId(obs, "git").status).toBe("missing");
  });
});

class FakeInstaller implements ToolInstaller {
  constructor(readonly installerId: string) {}
  plan = (async () => ({ ok: false })) as unknown as ToolInstaller["plan"];
  apply = (async () => ({ ok: false })) as unknown as ToolInstaller["apply"];
  reconcile = (async () => ({ ok: false })) as unknown as ToolInstaller["reconcile"];
}

const SHA = "a".repeat(64);
function desc(over: Partial<ToolInstallDescriptor> = {}): ToolInstallDescriptor {
  return {
    schemaVersion: 3,
    toolId: "pnpm",
    installerId: "npm-installer",
    method: "npm",
    version: "12.5.1",
    source: "https://registry.npmjs.org/pnpm/-/pnpm-12.5.1.tgz",
    integrity: SHA,
    platforms: ["linux", "darwin"],
    requiresElevation: false,
    ...over
  };
}

describe("ToolInstallerRegistry", () => {
  it("rejects duplicate installerId with conflict", () => {
    const r = new ToolInstallerRegistry();
    expect(r.register(new FakeInstaller("a")).ok).toBe(true);
    const dup = r.register(new FakeInstaller("a"));
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe("conflict");
  });

  it("resolves by platform preference among registered installers", () => {
    const r = new ToolInstallerRegistry();
    for (const id of ["npm-i", "brew-i", "arc-i"]) r.register(new FakeInstaller(id));
    const ds = [
      desc({ installerId: "arc-i", method: "verified_archive" }),
      desc({ installerId: "npm-i", method: "npm" }),
      desc({ installerId: "brew-i", method: "homebrew" }),
      desc({ installerId: "unregistered", method: "pnpm" })
    ];
    expect(r.resolve("pnpm", "darwin", ds)?.descriptor.method).toBe("homebrew");
    expect(r.resolve("pnpm", "linux", ds)?.descriptor.method).toBe("npm");
    expect(r.resolve("pnpm", "win32", ds)).toBeNull();
    expect(r.resolve("git", "linux", ds)).toBeNull();
  });

  it("never picks a method that is not valid for the platform", () => {
    const r = new ToolInstallerRegistry();
    for (const id of ["npm-i", "win-i", "brew-i"]) r.register(new FakeInstaller(id));
    const win = desc({ installerId: "win-i", method: "winget", platforms: ["linux", "darwin", "win32"] });
    const brew = desc({ installerId: "brew-i", method: "homebrew", platforms: ["linux", "darwin", "win32"] });
    const npm = desc({ installerId: "npm-i", method: "npm", platforms: ["linux", "darwin", "win32"] });
    expect(r.resolve("pnpm", "linux", [win, npm])?.descriptor.method).toBe("npm");
    expect(r.resolve("pnpm", "darwin", [win, npm])?.descriptor.method).toBe("npm");
    expect(r.resolve("pnpm", "win32", [brew, npm])?.descriptor.method).toBe("npm");
    expect(r.resolve("pnpm", "linux", [win])).toBeNull();
    expect(r.resolve("pnpm", "darwin", [win])).toBeNull();
    expect(r.resolve("pnpm", "win32", [brew])).toBeNull();
  });

  it("rejects unpinned and non-https descriptors", () => {
    const r = new ToolInstallerRegistry();
    r.register(new FakeInstaller("npm-installer"));
    expect(r.resolve("pnpm", "linux", [desc({ version: "latest" })])).toBeNull();
    expect(r.resolve("pnpm", "linux", [desc({ version: "^12.5.1" })])).toBeNull();
    expect(r.resolve("pnpm", "linux", [desc({ source: "http://example.com/x.tgz" })])).toBeNull();
    expect(r.resolve("pnpm", "linux", [desc({ integrity: "nope" })])).toBeNull();
    expect(r.resolve("pnpm", "linux", [desc()])).not.toBeNull();
  });

  it("rejects tool ids that escape their managed install directory", () => {
    expect(buildInstallRequest(desc({ toolId: "../escape" }), platform).ok).toBe(false);
    expect(buildInstallRequest(desc({ toolId: "/tmp/escape" }), platform).ok).toBe(false);
  });

  it("builds schema-valid install requests", () => {
    const a = buildInstallRequest(desc(), platform);
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(ToolInstallRequestSchema.safeParse(a.value).success).toBe(true);
      expect(a.value.destination).toBe(path.join(platform.paths.data, "tools", "pnpm"));
      expect(a.value.scope).toEqual({ kind: "machine", machineId: platform.machineId });
      expect(a.value.idempotencyKey).toBe(`install:${platform.machineId}:pnpm:12.5.1:${SHA}`);
    }
    const b = buildInstallRequest(desc({ method: "verified_archive" }), platform);
    if (b.ok) expect(b.value.destination).toBe(path.join(platform.paths.data, "tools", "pnpm"));
    expect(buildInstallRequest(desc({ version: "latest" }), platform).ok).toBe(false);
  });
});

describe("loadMachineConfig", () => {
  const file = () => path.join(root, "cfg", "machine.json");
  async function write(content: unknown): Promise<string> {
    await mkdir(path.dirname(file()), { recursive: true });
    await writeFile(file(), typeof content === "string" ? content : JSON.stringify(content));
    return file();
  }
  const base = () => ({ ...defaultMachineConfig() });
  const svcDef = (env: Record<string, string>) => ({
    serviceId: "s",
    program: "/bin/s",
    args: [] as string[],
    env,
    keepAlive: false
  });

  it("absent returns defaults and creates nothing", async () => {
    const r = await loadMachineConfig(path.join(root, "nope", "machine.json"));
    expect(r.status).toBe("absent");
    expect(r.config).toEqual(defaultMachineConfig());
    expect(r.config?.providers).toEqual([]);
    expect(await readdir(root)).not.toContain("nope");
  });

  it("valid config with service and secret refs", async () => {
    const cfg = {
      ...base(),
      providers: ["claude"],
      toolPins: [desc()],
      services: [{ ...svcDef({ API_TOKEN: "secret://svc/token", MODE: "prod" }), serviceId: "worker-1", keepAlive: true }],
      secrets: { gh: "secret://github/pat" }
    };
    const r = await loadMachineConfig(await write(cfg));
    expect(r.status).toBe("valid");
    expect(r.config?.providers).toEqual(["claude"]);
  });

  it("valid with an MCP service definition", async () => {
    const svc = {
      schemaVersion: 3,
      serviceId: "docs",
      revision: 1,
      scope: { kind: "machine", machineId: "m-1" },
      tool: {
        schemaVersion: 3,
        toolId: "docs",
        kind: "native_remote_mcp",
        version: "1.0.0",
        operations: ["search"],
        resource: { sharing: "concurrent", maxConcurrency: 2 },
        required: false
      },
      connection: { kind: "native_remote_mcp", endpoint: "https://mcp.example.com/mcp", ownership: "external" },
      authentication: { mode: "none" },
      healthTimeoutMs: 1000,
      idleTimeoutMs: 60000,
      restartLimit: 1
    };
    const r = await loadMachineConfig(await write({ ...base(), mcpServices: [svc] }));
    expect(r.status).toBe("valid");
    const bad = await loadMachineConfig(await write({ ...base(), mcpServices: [{ ...svc, revision: 0 }] }));
    expect(bad.status).toBe("invalid");
  });

  it("invalid JSON / schema", async () => {
    const r = await loadMachineConfig(await write("{not json"));
    expect(r.status).toBe("invalid");
    expect(r.error?.code).toBe("validation");
    expect((await loadMachineConfig(await write({ ...base(), extra: 1 }))).status).toBe("invalid");
    expect((await loadMachineConfig(await write({ providers: [] }))).status).toBe("invalid");
    expect((await loadMachineConfig(await write({ ...base(), providers: ["gpt"] }))).status).toBe("invalid");
  });

  it("rejects credential literals", async () => {
    const lits = [
      { ...base(), services: [svcDef({ X: "sk-abcdef123" })] },
      { ...base(), services: [svcDef({ GH: "ghp_abc123" })] },
      { ...base(), services: [svcDef({ PASSWORD: "hunter2" })] },
      { ...base(), secrets: { k: "AKIAABCDEFG" } }
    ];
    for (const l of lits) {
      const r = await loadMachineConfig(await write(l));
      expect(r.status).toBe("invalid");
      expect(r.error?.code).toBe("validation");
    }
  });

  it("credential check does not flag token-internal prefixes", async () => {
    const ok = { ...base(), services: [{ ...svcDef({}), serviceId: "task-runner", program: "/opt/disk-agent" }] };
    expect((await loadMachineConfig(await write(ok))).status).toBe("valid");
    for (const v of ["sk-abc123", "--key=ghp_abc"]) {
      const bad = { ...base(), services: [{ ...svcDef({}), args: [v] }] };
      expect((await loadMachineConfig(await write(bad))).status).toBe("invalid");
    }
  });

  it("unknown version yields unsupported_version", async () => {
    const r = await loadMachineConfig(await write({ ...base(), schemaVersion: 4 }));
    expect(r.status).toBe("unsupported_version");
    expect(r.error).toMatchObject({ code: "unsupported_version", supportedVersions: [3], receivedVersion: 4 });
    const missing = await loadMachineConfig(await write({ providers: [] }));
    expect(missing.status).toBe("invalid");
  });
});
