import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveMemoryProvider } from "../src/memory-provider.js";
import type { ToolHost } from "../src/installer.js";

it("auto selects an authenticated Claude subscription without inference or changing settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-memory-route-"));
  try {
    const calls: string[][] = [];
    const host: ToolHost = { async download() { throw Error("no download"); }, async run(executable, args) {
      calls.push([executable, ...args]); return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }), stderr: "" }; } };
    const selected = await resolveMemoryProvider({ homeDirectory: root, dataDir: join(root, "memory"), provider: "auto", host });
    expect(selected.provider).toBe("claude"); expect(calls).toEqual([["claude", "auth", "status", "--json"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("preserves a saved Codex route only with file-backed ChatGPT auth and never accepts an API key", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-memory-codex-"));
  try {
    const dataDir = join(root, "memory"), codexHome = join(root, ".codex"); await mkdir(dataDir); await mkdir(codexHome);
    const settings = JSON.stringify({ CLAUDE_MEM_PROVIDER: "codex", CLAUDE_MEM_CODEX_MODEL: "existing-model" });
    await writeFile(join(dataDir, "settings.json"), settings);
    const host: ToolHost = { async download() { throw Error("no download"); }, async run(executable, args) {
      expect(executable).toBe("codex"); expect(args).toEqual(["login", "status"]); return { exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" }; } };
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture", refresh_token: "fixture", id_token: "fixture" } }));
    const selected = await resolveMemoryProvider({ homeDirectory: root, dataDir, provider: "auto", host, environment: { CODEX_HOME: codexHome } });
    expect(selected.provider).toBe("codex"); expect(await readFile(join(dataDir, "settings.json"), "utf8")).toBe(settings);
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "fixture" }));
    await expect(resolveMemoryProvider({ homeDirectory: root, dataDir, provider: "auto", host, environment: { CODEX_HOME: codexHome } })).rejects.toThrow("codex login");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("does not replace an existing custom memory provider or fall back to host on a fresh unauthenticated machine", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-memory-missing-"));
  try {
    const dataDir = join(root, "memory"); await mkdir(dataDir);
    const host: ToolHost = { async download() { throw Error("no download"); }, async run() { return { exitCode: 1, stdout: "", stderr: "not logged in" }; } };
    const options = { homeDirectory: root, dataDir, provider: "auto" as const, host, environment: { CODEX_HOME: join(root, ".codex") } };
    await expect(resolveMemoryProvider(options)).rejects.toThrow("claude auth login");
    await writeFile(join(dataDir, "settings.json"), JSON.stringify({ CLAUDE_MEM_PROVIDER: "openrouter" }));
    await expect(resolveMemoryProvider(options)).rejects.toThrow("preserved");
    expect((await resolveMemoryProvider({ ...options, provider: "host" })).provider).toBe("host");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("binds auto-selected subscription route to the approved native plan and rejects account-route drift", async () => {
  const { NativeProvidersToolInstaller } = await import("../src/native-providers-installer.js");
  const { defaultNativeToolPins } = await import("../src/default-catalog.js");
  const root = await mkdtemp(join(tmpdir(), "bflow-memory-plan-"));
  try {
    await mkdir(join(root, ".codex")); await writeFile(join(root, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture", refresh_token: "fixture", id_token: "fixture" } }));
    let claudeLoggedIn = true, downloads = 0, claudeProbes = 0, flipAfter = Number.POSITIVE_INFINITY;
    const host: ToolHost = { async download() { downloads++; }, async run(_exe, args) {
      return args[0] === "auth" ? { exitCode: 0, stdout: JSON.stringify({ loggedIn: claudeLoggedIn && ++claudeProbes <= flipAfter, authMethod: "claude.ai" }), stderr: "" }
        : { exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" };
    } };
    const pin = defaultNativeToolPins().find(pin => pin.toolId === "claude-mem")!;
    const installer = new NativeProvidersToolInstaller({ managedRoot: join(root, "tools"), pin, providers: ["claude"], host,
      configuration: { homeDirectory: root, memory: { provider: "auto", dataDir: join(root, "memory"), projectRoot: root, project: root } } });
    const request = { schemaVersion: 3 as const, toolId: pin.toolId, installerId: pin.installerId, source: pin.source,
      version: pin.version, integrity: pin.integrity, destination: join(root, "tools", pin.toolId), scope: { kind: "machine" as const, machineId: "fixture" }, idempotencyKey: "memory-route" };
    const before = await installer.plan(request); expect(before.ok).toBe(true); if (!before.ok) return;
    claudeLoggedIn = false;
    const after = await installer.plan(request); expect(after.ok).toBe(true); if (!after.ok) return;
    expect(after.value.desiredStateDigest).not.toBe(before.value.desiredStateDigest);
    const applied = await installer.apply({ schemaVersion: 3, planId: "plan", planDigest: "a".repeat(64), step: before.value, approvalReceiptId: "approved" });
    expect(applied.ok).toBe(false); expect(downloads).toBe(0);
    // Account selection changing between validation and child planning must also stop before side effects.
    claudeLoggedIn = true; claudeProbes = 0; flipAfter = 1;
    const raced = await installer.apply({ schemaVersion: 3, planId: "plan", planDigest: "a".repeat(64), step: before.value, approvalReceiptId: "approved" });
    expect(raced.ok).toBe(false); expect(downloads).toBe(0);
    // A previous host activation must remain uncertain after the user chooses auto.
    claudeLoggedIn = true; claudeProbes = 0; flipAfter = Number.POSITIVE_INFINITY;
    await mkdir(join(root, "tools", "claude-mem"), { recursive: true });
    await writeFile(join(root, "tools", "claude-mem", "claude.native-pending.json"), JSON.stringify({ schemaVersion: 3,
      desiredStateDigest: "b".repeat(64), stage: join(root, "tools", "claude-mem", "claude.staging-previous-host"),
      toolId: "claude-mem", installerId: `${pin.installerId}-claude` }));
    const retained = await installer.inspect(request); expect(retained.ok && retained.value.status).toBe("unknown");
    const current = await installer.plan(request); expect(current.ok).toBe(true); if (!current.ok) return;
    const replay = await installer.apply({ schemaVersion: 3, planId: "new-plan", planDigest: "a".repeat(64), step: current.value, approvalReceiptId: "approved-auto" });
    expect(replay.ok && replay.value.status).toBe("unknown"); expect(downloads).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(["claude", "codex"] as const)("passes the selected %s route and subscription environment to the native installer without generating", async provider => {
  const { NativePluginRuntime } = await import("../src/native-runtime.js");
  const { defaultNativeToolPins } = await import("../src/default-catalog.js");
  const root = await mkdtemp(join(tmpdir(), "bflow-memory-args-"));
  try {
    await mkdir(join(root, ".codex")); await writeFile(join(root, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture", refresh_token: "fixture", id_token: "fixture" } }));
    const pin = defaultNativeToolPins().find(pin => pin.toolId === "claude-mem")!;
    const artifact = join(root, "artifact.tgz"); await writeFile(artifact, "fixture");
    const { sha256 } = await import("../src/files.js"); pin.integrity = sha256("fixture");
    let installed = false;
    const host: ToolHost = { async download() { throw Error("unused"); }, async run(executable, args, options) {
      if (args[0] === "auth") return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }), stderr: "" };
      if (args[0] === "login") return { exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      if (executable === "npm") {
        const stage = args[args.indexOf("--prefix") + 1]!; await mkdir(join(stage, "node_modules", "claude-mem"), { recursive: true });
        await writeFile(join(stage, "node_modules", "claude-mem", "package.json"), JSON.stringify({ name: "claude-mem", version: pin.version, license: pin.license }));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      expect(args).toEqual(["install", "--ide", "codex-cli", "--provider", provider, "--no-auto-start"]);
      expect(options?.environment?.CLAUDE_MEM_PROVIDER).toBe(provider);
      if (provider === "claude") { expect(options?.environment?.CLAUDE_MEM_CLAUDE_AUTH_METHOD).toBe("subscription"); expect(options?.environment?.ANTHROPIC_API_KEY).toBe(""); }
      if (provider === "codex") expect(options?.environment?.OPENAI_API_KEY).toBe("");
      installed = true; return { exitCode: 1, stdout: "", stderr: "fixture stops after installation arguments; no generation" };
    } };
    const runtime = new NativePluginRuntime({ managedRoot: join(root, "native"), homeDirectory: root,
      memory: { provider, dataDir: join(root, "memory"), projectRoot: root, project: root, startIfMissing: false } }, host);
    const result = await runtime.activate(pin, artifact, "install");
    expect(installed).toBe(true); expect(result.success).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
