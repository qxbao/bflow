import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeProvidersToolInstaller } from "../src/native-providers-installer.js";
import type { ManagedToolPin, ToolHost } from "../src/installer.js";
import type { NativeProviderIsolation } from "../src/native-runtime.js";

interface Invocation { executable: string; args: readonly string[]; environment?: Readonly<Record<string, string>> }

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** Records every provider command with its explicit environment. Commands are answered deterministically. */
function recordingHost(calls: Invocation[], answer: (executable: string, args: readonly string[]) => { exitCode: number; stdout: string } = () =>
  ({ exitCode: 1, stdout: "" }), download?: (source: string, target: string) => Promise<void>): ToolHost {
  return {
    async download(source, target) { if (download) await download(source, target); else throw Error("no download"); },
    async run(executable, args, options) {
      calls.push({ executable, args, ...(options?.environment ? { environment: options.environment } : {}) });
      const result = answer(executable, args);
      return { ...result, stderr: "" };
    }
  };
}

function isolationFor(root: string): NativeProviderIsolation {
  const providers = join(root, "isolated", "providers");
  return { homeDirectory: join(providers, "home"), claudeConfigDir: join(providers, "claude"), codexHome: join(providers, "codex") };
}

function memoryPin(): ManagedToolPin {
  return { toolId: "claude-mem", installerId: "native-memory", version: "14.0.1",
    source: "https://registry.npmjs.org/claude-mem/-/claude-mem-14.0.1.tgz",
    integrity: createHash("sha256").update("memory-archive").digest("hex"), license: "AGPL-3.0",
    recipe: { kind: "provider_plugin", provider: "claude" } };
}

function request(pin: ManagedToolPin, destination: string, idempotencyKey: string) {
  return { schemaVersion: 3 as const, toolId: pin.toolId, installerId: pin.installerId, version: pin.version, source: pin.source,
    integrity: pin.integrity, destination, scope: { kind: "machine" as const, machineId: "machine" }, idempotencyKey };
}

/** Real tar.gz whose manifest matches the pin, so the Superpowers activation path runs end to end. */
async function superpowersArchive(root: string): Promise<{ archive: string; integrity: string }> {
  const source = join(root, "source", "superpowers-7.0.0");
  await mkdir(join(source, ".claude-plugin"), { recursive: true });
  await mkdir(join(source, "skills", "using-superpowers"), { recursive: true });
  await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "superpowers", version: "7.0.0", license: "MIT" }));
  await writeFile(join(source, "skills", "using-superpowers", "SKILL.md"), "---\nname: using-superpowers\ndescription: test\n---\n# Using\n");
  const archive = join(root, "superpowers.tgz");
  execFileSync("tar", ["-czf", archive, "-C", join(root, "source"), "superpowers-7.0.0"]);
  const integrity = createHash("sha256").update(await readFile(archive)).digest("hex");
  return { archive, integrity };
}

function superpowersPin(integrity: string, provider: "claude" | "codex" | "agy"): ManagedToolPin {
  return { toolId: "superpowers", installerId: "native", version: "7.0.0",
    source: "https://github.com/obra/superpowers/archive/refs/tags/v7.0.0.tar.gz", integrity, license: "MIT",
    recipe: { kind: "provider_plugin", provider } };
}

/** Every recorded command argument, environment value and file path under root must avoid the real home. */
async function assertNoRealHome(calls: Invocation[], realHome: string, root: string): Promise<void> {
  for (const call of calls) {
    expect(call.args.join(" ")).not.toContain(realHome);
    expect(call.executable).not.toContain(realHome);
    for (const value of Object.values(call.environment ?? {})) expect(value).not.toContain(realHome);
  }
  await expect(stat(realHome)).rejects.toMatchObject({ code: "ENOENT" });
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(entries.map(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]));
    return nested.flat();
  };
  for (const file of await walk(root)) {
    if (file.endsWith(".json") || file.endsWith(".toml")) expect(await readFile(file, "utf8")).not.toContain(realHome);
  }
}

describe("isolated native provider setup", () => {
  it("resolves Claude-Mem provider login only under the isolated provider homes", async () => {
    const root = await tempRoot("bflow-native-iso-memory-");
    const realHome = join(root, "real-home");
    const isolation = isolationFor(root);
    const calls: Invocation[] = [];
    const pin = memoryPin();
    const installer = new NativeProvidersToolInstaller({ managedRoot: join(root, "isolated", "data", "tools"), pin,
      providers: ["claude"], host: recordingHost(calls),
      configuration: { homeDirectory: isolation.homeDirectory, isolation,
        memory: { dataDir: join(root, "isolated", "data", "claude-mem"), projectRoot: root, project: root } } });
    const planned = await installer.plan(request(pin, join(root, "isolated", "data", "tools", "claude-mem"), "iso-memory"));
    expect(planned.ok).toBe(false);
    const claudeCalls = calls.filter(call => call.executable === "claude");
    expect(claudeCalls.length).toBeGreaterThan(0);
    for (const call of claudeCalls) {
      expect(call.environment?.HOME).toBe(isolation.homeDirectory);
      expect(call.environment?.CLAUDE_CONFIG_DIR).toBe(isolation.claudeConfigDir);
    }
    await assertNoRealHome(calls, realHome, root);
  });

  it("keeps real (non-isolated) provider commands on the caller environment without forcing isolated homes", async () => {
    const root = await tempRoot("bflow-native-real-memory-");
    const calls: Invocation[] = [];
    const pin = memoryPin();
    const installer = new NativeProvidersToolInstaller({ managedRoot: join(root, "tools"), pin, providers: ["claude"],
      host: recordingHost(calls), configuration: { homeDirectory: join(root, "home"),
        memory: { dataDir: join(root, "memory"), projectRoot: root, project: root } } });
    await installer.plan(request(pin, join(root, "tools", "claude-mem"), "real-memory"));
    const claudeCalls = calls.filter(call => call.executable === "claude");
    expect(claudeCalls.length).toBeGreaterThan(0);
    for (const call of claudeCalls) {
      expect(call.environment?.HOME).toBeUndefined();
      expect(call.environment?.CLAUDE_CONFIG_DIR).toBeUndefined();
    }
  });

  it("defers providers without an isolation variable: agy is never activated and is reported as an owner action", async () => {
    const root = await tempRoot("bflow-native-iso-agy-");
    const realHome = join(root, "real-home");
    const isolation = isolationFor(root);
    const calls: Invocation[] = [];
    const { archive, integrity } = await superpowersArchive(root);
    const pin = superpowersPin(integrity, "agy");
    const destination = join(root, "isolated", "data", "tools", "superpowers");
    const installer = new NativeProvidersToolInstaller({ managedRoot: join(root, "isolated", "data", "tools"), pin,
      providers: ["agy"], host: recordingHost(calls, () => ({ exitCode: 0, stdout: "[]" }), (_s, target) => copyFile(archive, target)),
      configuration: { homeDirectory: isolation.homeDirectory, isolation } });
    const planned = await installer.plan(request(pin, destination, "iso-agy"));
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const inspected = await installer.inspect(planned.value.toolInstall!);
    // Deferral is an explicit owner action, not a failure of the isolated setup; nothing is executed for agy.
    expect(inspected.ok && inspected.value.status).toBe("already_satisfied");
    expect(inspected.ok && inspected.value.diagnostics.join(" ")).toContain("manual action required for agy: native plugin activation is deferred");
    const applied = await installer.apply({ schemaVersion: 3, planId: "plan", planDigest: "a".repeat(64), step: planned.value,
      approvalReceiptId: "approved" });
    expect(applied.ok && applied.value.status).toBe("already_satisfied");
    expect(applied.ok && applied.value.diagnostics.join(" ")).toContain("manual action required for agy");
    expect(calls).toEqual([]);
    await assertNoRealHome(calls, realHome, root);
  });

  it("activates Superpowers for Claude only with CLAUDE_CONFIG_DIR and HOME under the isolated root", async () => {
    const root = await tempRoot("bflow-native-iso-superpowers-");
    const realHome = join(root, "real-home");
    const isolation = isolationFor(root);
    const { archive, integrity } = await superpowersArchive(root);
    const calls: Invocation[] = [];
    const pin = superpowersPin(integrity, "claude");
    const managed = join(root, "isolated", "data", "tools");
    const installer = new NativeProvidersToolInstaller({ managedRoot: managed, pin, providers: ["claude"],
      host: recordingHost(calls, () => ({ exitCode: 0, stdout: "[]" }), (_s, target) => copyFile(archive, target)),
      configuration: { homeDirectory: isolation.homeDirectory, isolation } });
    const destination = join(managed, "superpowers");
    const planned = await installer.plan(request(pin, destination, "iso-superpowers"));
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    await installer.apply({ schemaVersion: 3, planId: "plan", planDigest: "a".repeat(64), step: planned.value,
      approvalReceiptId: "approved" });
    const claudeCalls = calls.filter(call => call.executable === "claude");
    expect(claudeCalls.some(call => call.args[0] === "plugin" && call.args[1] === "install")).toBe(true);
    for (const call of claudeCalls) {
      expect(call.environment?.HOME).toBe(isolation.homeDirectory);
      expect(call.environment?.CLAUDE_CONFIG_DIR).toBe(isolation.claudeConfigDir);
    }
    await assertNoRealHome(calls, realHome, root);
  });
});
