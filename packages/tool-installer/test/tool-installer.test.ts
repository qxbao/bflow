import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedToolInstaller, createToolCapability, type ManagedToolPin, type ToolHost } from "../src/installer.js";
import { ClaudeMemProjectReader, FileToolCapabilityRegistry, ToolCapabilityRegistry, ensureGitNexusIndex, observeClaudeMemGrowth, observeClaudeMemWorker,
  planChromeSession, rtkProviderIntegration, runWithRtk, superpowersInstallRoute, verifyMcpStartup, verifyRtk,
  verifySuperpowersSkills, writeOwnedToolConfig } from "../src/integrations.js";

const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bflow-tool-")); roots.push(root);
  const version = "1.2.3";
  const pin: ManagedToolPin = { toolId: "chrome-devtools-mcp", installerId: "bflow-tools", version,
    source: "https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-1.2.3.tgz",
    integrity: hash("archive"), recipe: { kind: "npm", packageName: "chrome-devtools-mcp", executable: "chrome-devtools-mcp", allowBuildScripts: false }, license: "Apache-2.0" };
  const destination = join(root, "managed", "chrome-devtools-mcp");
  const request = { schemaVersion: 3 as const, toolId: pin.toolId, installerId: pin.installerId, version, source: pin.source,
    integrity: pin.integrity, scope: { kind: "repository" as const, machineId: "m", repositoryId: "r", workspaceRoot: root },
    destination, idempotencyKey: "install-chrome" };
  let installExit = 0;
  const calls: string[] = [];
  const host: ToolHost = {
    async download(_source, target) { await writeFile(target, "archive"); },
    async run(executable, args) {
      calls.push(`${executable} ${args.join(" ")}`);
      if (executable === "npm") {
        if (installExit !== 0) return { exitCode: installExit, stdout: "", stderr: "simulated failure" };
        const stage = args[args.indexOf("--prefix") + 1]!;
        await mkdir(join(stage, "node_modules", "chrome-devtools-mcp"), { recursive: true });
        await mkdir(join(stage, "node_modules", ".bin"), { recursive: true });
        await writeFile(join(stage, "node_modules", "chrome-devtools-mcp", "package.json"), JSON.stringify({ name: "chrome-devtools-mcp", version, license: "Apache-2.0" }));
        await writeFile(join(stage, "node_modules", ".bin", "chrome-devtools-mcp"), "binary");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: version, stderr: "" };
    }
  };
  const installer = new ManagedToolInstaller({ managedRoot: join(root, "managed"), pins: [pin], host });
  const stepResult = await installer.plan(request);
  if (!stepResult.ok) throw new Error(stepResult.error.message);
  const applyRequest = { schemaVersion: 3 as const, planId: "p", planDigest: hash("plan"), step: stepResult.value };
  return { root, pin, request, destination, installer, applyRequest, calls, setInstallExit: (code: number) => { installExit = code; } };
}

describe("managed tool installer", () => {
  it("installs once, verifies on repeat and preserves a known-good install after update failure", async () => {
    const f = await fixture();
    const first = await f.installer.apply(f.applyRequest);
    if (first.ok && first.value.status !== "applied") throw new Error(first.value.diagnostics.join("; "));
    expect(first.ok && first.value.status).toBe("applied");
    const second = await f.installer.apply(f.applyRequest);
    expect(second.ok && second.value.status).toBe("already_satisfied");
    expect(f.calls.filter(call => call.startsWith("npm "))).toHaveLength(1);
    const marker = await readFile(join(f.destination, ".bflow-tool.json"), "utf8");
    expect(JSON.parse(marker).version).toBe("1.2.3");

    const otherPin = { ...f.pin, installerId: "another-installer" };
    const otherInstaller = new ManagedToolInstaller({ managedRoot: join(f.root, "managed"), pins: [otherPin], host: {
      async download() { throw new Error("must not download another installer's destination"); },
      async run() { return { exitCode: 0, stdout: f.pin.version, stderr: "" }; }
    } });
    const otherPlan = await otherInstaller.plan({ ...f.request, installerId: otherPin.installerId });
    expect(otherPlan.ok).toBe(true);
    if (otherPlan.ok) {
      const otherResult = await otherInstaller.apply({ ...f.applyRequest, step: otherPlan.value });
      expect(otherResult.ok && otherResult.value.status).toBe("blocked");
    }

    const newPin = { ...f.pin, version: "1.2.4", source: "https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-1.2.4.tgz" };
    const newInstaller = new ManagedToolInstaller({ managedRoot: join(f.root, "managed"), pins: [newPin], host: {
      async download(_source, target) { await writeFile(target, "archive"); },
      async run() { return { exitCode: 2, stdout: "", stderr: "failed update" }; }
    } });
    const plan = await newInstaller.plan({ ...f.request, version: newPin.version, source: newPin.source });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const result = await newInstaller.apply({ ...f.applyRequest, step: plan.value });
    expect(result.ok && result.value.status).toBe("failed");
    expect(JSON.parse(await readFile(join(f.destination, ".bflow-tool.json"), "utf8")).version).toBe("1.2.3");
  });

  it("blocks unowned paths, concurrent installs and changed steps", async () => {
    const f = await fixture();
    await mkdir(f.destination, { recursive: true });
    await writeFile(join(f.destination, "settings.json"), "do not overwrite");
    const existing = await f.installer.apply(f.applyRequest);
    expect(existing.ok && existing.value.status).toBe("blocked");
    expect(await readFile(join(f.destination, "settings.json"), "utf8")).toBe("do not overwrite");
    await writeFile(`${f.destination}.lock`, "other process");
    const busy = await f.installer.apply(f.applyRequest);
    expect(busy.ok && busy.value.status).toBe("blocked");
    const changed = await f.installer.apply({ ...f.applyRequest, step: { ...f.applyRequest.step, desiredStateDigest: hash("tamper") } });
    expect(changed.ok).toBe(false);
  });

  it("rejects unpinned, unsafe and unsupported plugin installs", async () => {
    const f = await fixture();
    expect((await f.installer.plan({ ...f.request, version: "latest" })).ok).toBe(false);
    expect((await f.installer.plan({ ...f.request, destination: join(f.root, "other") })).ok).toBe(false);
    const pluginPin: ManagedToolPin = { toolId: "superpowers", installerId: "bflow-tools", version: "1.0.0",
      source: "https://github.com/obra/superpowers/archive/refs/tags/v1.0.0.tar.gz", integrity: hash("plugin"),
      recipe: { kind: "provider_plugin", provider: "codex" }, license: "MIT" };
    const installer = new ManagedToolInstaller({ managedRoot: join(f.root, "managed"), pins: [pluginPin] });
    expect((await installer.plan({ ...f.request, toolId: "superpowers", version: "1.0.0", source: pluginPin.source,
      integrity: pluginPin.integrity })).ok).toBe(false);
    const wrongVersion = await f.installer.apply({ ...f.applyRequest, step: { ...f.applyRequest.step, schemaVersion: 4 as 3 } });
    expect(!wrongVersion.ok && wrongVersion.error.code).toBe("unsupported_version");
  });
});

describe("tool integrations", () => {
  it("requires functional evidence before publishing a capability", () => {
    const registry = new ToolCapabilityRegistry();
    const capability = createToolCapability("rtk", "1.2.3", "r");
    expect(() => registry.register(capability, { verified: false, version: "1.2.3", scopeKey: "r" })).toThrow();
    registry.register(capability, { verified: true, version: "1.2.3", scopeKey: "r" });
    expect(registry.get("r", "rtk")?.kind).toBe("cli_only");
    expect(registry.get("another", "rtk")).toBeNull();
    registry.register(capability, { verified: true, version: "1.2.3", scopeKey: "r:other" });
    expect(registry.list("r")).toHaveLength(1);
  });

  it("persists scoped capability registrations across registry instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-capabilities-")); roots.push(root);
    const file = join(root, "capabilities.json");
    const registry = new FileToolCapabilityRegistry(file);
    await registry.register(createToolCapability("rtk", "1.2.3", "repo-a"), { verified: true, version: "1.2.3", scopeKey: "repo-a" });
    expect((await new FileToolCapabilityRegistry(file).list("repo-a"))[0]?.toolId).toBe("rtk");
    expect(await new FileToolCapabilityRegistry(file).list("repo-b")).toHaveLength(0);
    await registry.revoke("repo-a", "rtk");
    expect(await registry.list("repo-a")).toHaveLength(0);
  });

  it("adopts one configured Claude-Mem worker through loopback health only", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-memory-")); roots.push(root);
    await writeFile(join(root, ".worker.port"), "37777");
    const ready = await observeClaudeMemWorker({ dataDir: root, projectRoot: root, version: "9.0.0",
      fetcher: async (url) => { expect(String(url)).toBe("http://127.0.0.1:37777/api/health"); return new Response('{"status":"ok","version":"9.0.0"}'); } });
    expect(ready.status).toBe("ready");
    const wrongVersion = await observeClaudeMemWorker({ dataDir: root, projectRoot: root, version: "9.0.0",
      fetcher: async () => new Response('{"status":"ok","version":"8.0.0"}') });
    expect(wrongVersion.status).toBe("blocked");
    const unrelatedService = await observeClaudeMemWorker({ dataDir: root, projectRoot: root, version: "9.0.0",
      fetcher: async () => new Response("hello") });
    expect(unrelatedService.status).toBe("blocked");
    const failed = await observeClaudeMemWorker({ dataDir: root, projectRoot: root, version: "9.0.0", fetcher: async () => { throw new Error("offline"); } });
    expect(failed.capability).toBeNull();
  });

  it("limits Claude-Mem reads to the configured project", async () => {
    const reader = new ClaudeMemProjectReader("http://127.0.0.1:37777", "repo-a", async (_url, init) => {
      expect(JSON.parse(String(init?.body)).project).toBe("repo-a");
      return new Response(JSON.stringify([{ id: 5, project: "repo-a", title: "safe" }]));
    });
    expect((await reader.getObservations([5]))[0]?.id).toBe(5);
    const leaking = new ClaudeMemProjectReader("http://127.0.0.1:37777", "repo-a", async () => new Response(JSON.stringify([{ id: 5, project: "repo-b" }])));
    await expect(leaking.getObservations([5])).rejects.toThrow("Cross-project");
    expect(() => new ClaudeMemProjectReader("http://example.com", "repo-a")).toThrow();
  });

  it("serializes GitNexus writers and tracks repository fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-index-")); roots.push(root);
    const stateRoot = join(root, "state"); await mkdir(stateRoot);
    const calls: string[] = [];
    let indexed = false;
    let forcedStale = false;
    const host: ToolHost = { async download() {}, async run(executable, args) {
      calls.push(`${executable} ${args[0]}`);
      if (args[0] === "rev-parse") return { exitCode: 0, stdout: "abc\n", stderr: "" };
      if (args[0] === "status" && executable === "git") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "analyze") { indexed = true; forcedStale = false; return { exitCode: 0, stdout: "analyzed", stderr: "" }; }
      return { exitCode: 0, stdout: JSON.stringify(indexed ? { schemaVersion: 1, repository: root, status: forcedStale ? "stale" : "up-to-date" } :
        { schemaVersion: 1, repository: root, error: "not-indexed" }), stderr: "" };
    } };
    await writeFile(join(stateRoot, "gitnexus-writer.lock"), "busy");
    expect((await ensureGitNexusIndex({ repositoryRoot: root, stateRoot, executable: "gitnexus", host })).status).toBe("busy");
    await rm(join(stateRoot, "gitnexus-writer.lock"));
    expect((await ensureGitNexusIndex({ repositoryRoot: root, stateRoot, executable: "gitnexus", host })).status).toBe("indexed");
    expect((await ensureGitNexusIndex({ repositoryRoot: root, stateRoot, executable: "gitnexus", host })).status).toBe("fresh");
    expect(calls.filter(call => call === "gitnexus analyze")).toHaveLength(1);
    forcedStale = true; // Same HEAD/porcelain fingerprint, but source bytes changed.
    expect((await ensureGitNexusIndex({ repositoryRoot: root, stateRoot, executable: "gitnexus", host })).status).toBe("indexed");
    expect(calls.filter(call => call === "gitnexus analyze")).toHaveLength(2);
    const malformed: ToolHost = { async download() {}, async run(executable, args) {
      if (executable === "git") return { exitCode: 0, stdout: args[0] === "rev-parse" ? "abc\n" : "", stderr: "" };
      return { exitCode: 0, stdout: "Index up to date", stderr: "" };
    } };
    expect((await ensureGitNexusIndex({ repositoryRoot: root, stateRoot, executable: "gitnexus", host: malformed })).status).toBe("failed");
  });

  it("uses task-owned Chrome profiles and blocks a locked profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-browser-")); roots.push(root);
    const host: ToolHost = { async download() {}, async run() { return { exitCode: 0, stdout: "Google Chrome 150", stderr: "" }; } };
    const input = { managedRoot: root, repositoryId: "repo", taskId: "task", browserExecutable: "chrome", serverExecutable: "chrome-devtools-mcp", host };
    const ready = await planChromeSession(input);
    expect(ready.status).toBe("ready");
    expect(ready.argv).toContain(ready.profileDir);
    await writeFile(join(ready.profileDir, "SingletonLock"), "locked");
    expect((await planChromeSession(input)).status).toBe("profile_locked");
    const other = await planChromeSession({ ...input, taskId: "other" });
    expect(other.resourceKey).not.toBe(ready.resourceKey);
    const linkedRoot = join(root, "linked");
    await symlink(root, linkedRoot);
    await expect(planChromeSession({ ...input, managedRoot: linkedRoot })).rejects.toThrow("real directory");
  });

  it("keeps Superpowers installations separate per provider", () => {
    expect(superpowersInstallRoute("claude").command).toContain("claude-plugins-official");
    expect(superpowersInstallRoute("codex").command).toContain("/plugins");
    expect(superpowersInstallRoute("agy").command).toContain("agy plugin install");
    expect(verifySuperpowersSkills(["using-superpowers"], []).ready).toBe(true);
    expect(verifySuperpowersSkills([], []).ready).toBe(false);
    expect(verifySuperpowersSkills(["using-superpowers"], ["superpowers:using-superpowers"]).ready).toBe(false);
  });

  it("preserves existing config and records a rollback copy for owned updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-config-")); roots.push(root);
    const path = join(root, "settings.json");
    await writeFile(path, "user config");
    expect((await writeOwnedToolConfig(path, "bflow config", null)).status).toBe("blocked");
    await rm(path);
    const first = await writeOwnedToolConfig(path, "bflow config", null);
    expect(first.status).toBe("applied");
    expect((await writeOwnedToolConfig(path, "bflow config", first.digest)).status).toBe("already_satisfied");
    const update = await writeOwnedToolConfig(path, "updated", first.digest);
    expect(update.status).toBe("applied");
    expect(await readFile(update.rollbackPath!, "utf8")).toBe("bflow config");
    expect((await writeOwnedToolConfig(path, "new", first.digest)).status).toBe("blocked");
    expect((await writeOwnedToolConfig(path, "new", null)).status).toBe("blocked");
    const orphan = join(root, "orphan.json");
    await writeFile(`${orphan}.bflow-owner`, hash("missing"));
    expect((await writeOwnedToolConfig(orphan, "new", null)).status).toBe("blocked");
  });

  it("blocks failed MCP startup and identifies memory growth", async () => {
    const failed = await verifyMcpStartup({ toolId: "gitnexus", version: "1.0.0", repositoryId: "r",
      negotiate: async () => { throw new Error("crash"); } });
    expect(failed.status).toBe("blocked");
    expect(failed.capability).toBeNull();
    const root = await mkdtemp(join(tmpdir(), "bflow-memory-growth-")); roots.push(root);
    await writeFile(join(root, ".worker.pid"), "123");
    let rss = 100;
    const host: ToolHost = { async download() {}, async run() { return { exitCode: 0, stdout: String(rss += 100), stderr: "" }; } };
    const growth = await observeClaudeMemGrowth({ dataDir: root, host, intervalMs: 0, maxGrowthBytes: 50_000 });
    expect(growth.status).toBe("growing");
  });

  it("checks RTK gain and preserves the proxied command exit code", async () => {
    const calls: string[] = [];
    const host: ToolHost = { async download() {}, async run(_executable, args) {
      calls.push(args.join(" "));
      if (args[0] === "--version") return { exitCode: 0, stdout: "rtk 0.30.0", stderr: "" };
      if (args[0] === "gain") return { exitCode: 0, stdout: "No commands tracked yet", stderr: "" };
      return { exitCode: 7, stdout: "full output", stderr: "command failed" };
    } };
    expect(await verifyRtk("rtk", "0.30.0", host)).toBe(true);
    expect((await runWithRtk("rtk", ["git", "status"], true, host)).exitCode).toBe(7);
    expect(calls).toContain("proxy git status");
    expect((await rtkProviderIntegration("codex", "rtk", host)).supported).toBe(false);
    const supporting: ToolHost = { async download() {}, async run() { return { exitCode: 0, stdout: "--codex --agent antigravity -g", stderr: "" }; } };
    expect((await rtkProviderIntegration("codex", "rtk", supporting)).supported).toBe(true);
  });
});
