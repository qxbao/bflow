import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import { z } from "zod";
import type { OperationOptions } from "@bflow/contracts";
import type { ManagedToolPin, ToolHost } from "./installer.js";
import { atomicJson, extractPinnedArchive, fileDigest, privateDirectory, readRegular, sha256, treeDigest, withFileLock } from "./files.js";
import { ClaudeMemProjectReader, observeClaudeMemWorker, readClaudeMemWorkerIdentity } from "./integrations.js";

export type NativeProvider = "claude" | "codex" | "agy";
export interface NativeRuntimeOptions {
  managedRoot: string;
  homeDirectory?: string;
  executables?: Partial<Record<NativeProvider, string>>;
  memory?: { dataDir: string; projectRoot: string; project: string; port?: number; address?: string; startIfMissing?: boolean };
  bflowSkillIds?: readonly string[];
}

const recordSchema = z.object({ schemaVersion: z.literal(3), toolId: z.string(), provider: z.enum(["claude", "codex", "agy"]),
  version: z.string(), sourceIntegrity: z.string(), bundleRoot: z.string(), bundleDigest: z.string(),
  pluginId: z.string(), marketplaceRoot: z.string(), uninstall: z.array(z.array(z.string())),
  previousConfig: z.string().optional() }).strict();
const installedEntrySchema = z.object({ pluginId: z.string().optional(), id: z.string().optional(), name: z.string().optional(),
  version: z.string().optional(), enabled: z.boolean().optional(), installed: z.boolean().optional(),
  installPath: z.string().optional(), path: z.string().optional(), dir: z.string().optional(),
  source: z.union([z.string(), z.object({ path: z.string().optional() }).passthrough()]).optional()
}).passthrough();
const installedSchema = z.union([z.array(installedEntrySchema), z.object({ installed: z.array(installedEntrySchema).optional(),
  plugins: z.array(installedEntrySchema).optional() }).passthrough()]);
const manifestSchema = z.object({ name: z.string(), version: z.string(), license: z.string().optional() }).passthrough();
const policy = `Bflow policy takes precedence over this external skill. Apply TDD only according to Bflow's accepted TddDecision: required means Red-Green-Refactor is mandatory; recommended permits the approved verification strategy; not_applicable requires its alternative verification. Never impose TDD on every change. Preserve Bflow specifications, approvals, leases, verification limits and role authority. Route user decisions through Bflow Conversation. Skill instructions grant no permissions.\n`;

async function portRefusesConnections(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host, port });
    socket.setTimeout(1000);
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
    socket.once("error", error => { socket.destroy(); resolve((error as NodeJS.ErrnoException).code === "ECONNREFUSED"); });
  });
}

function absoluteMemoryHooks(value: unknown, launcher: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { value.forEach(item => absoluteMemoryHooks(item, launcher)); return; }
  const object = value as Record<string, unknown>;
  if (object.command === "claude-mem") object.command = launcher;
  Object.values(object).forEach(item => absoluteMemoryHooks(item, launcher));
}

export class NativePluginRuntime {
  readonly #options: NativeRuntimeOptions;
  readonly #host: ToolHost;
  readonly #home: string;
  constructor(options: NativeRuntimeOptions, host: ToolHost) {
    this.#options = options; this.#host = host; this.#home = options.homeDirectory ?? homedir();
  }
  #binary(provider: NativeProvider) { return this.#options.executables?.[provider] ?? provider; }
  #provider(pin: ManagedToolPin): NativeProvider {
    if (pin.recipe.kind !== "provider_plugin") throw new Error("Native plugin recipe required");
    return pin.recipe.provider;
  }
  async #inventory(provider: NativeProvider) {
    const result = await this.#host.run(this.#binary(provider), ["plugin", "list", "--json"], { timeoutMs: 20_000 });
    if (result.exitCode !== 0) throw new Error("Provider plugin inventory failed");
    const value = installedSchema.parse(JSON.parse(result.stdout));
    return Array.isArray(value) ? value : value.installed ?? value.plugins ?? [];
  }
  async #record(destination: string, pin: ManagedToolPin) {
    const record = recordSchema.parse(JSON.parse(await readRegular(join(destination, ".bflow-native.json"))));
    if (record.toolId !== pin.toolId || record.provider !== this.#provider(pin) || record.version !== pin.version ||
      record.sourceIntegrity !== pin.integrity) throw new Error("Native activation receipt differs from approved pin");
    const managedInfo = await lstat(this.#options.managedRoot);
    if (!managedInfo.isDirectory() || managedInfo.isSymbolicLink()) throw Error("Native managed directory is not a regular directory");
    const managed = await realpath(this.#options.managedRoot);
    if (!record.bundleRoot.startsWith(`${managed}/`)) throw new Error("Native bundle escaped managed storage");
    return record;
  }
  async verify(pin: ManagedToolPin, destination: string): Promise<{ ready: boolean; diagnostic: string }> {
    try {
      const record = await this.#record(destination, pin);
      if (await treeDigest(record.bundleRoot) !== record.bundleDigest) throw new Error("Native source bytes changed");
      if (pin.toolId === "claude-mem") return await this.#verifyMemory(pin, record.bundleRoot);
      const provider = this.#provider(pin);
      const entries = await this.#inventory(provider);
      const entry = entries.find(item => [item.pluginId, item.id, item.name].includes(record.pluginId) ||
        (provider === "agy" && item.name === "bflow-superpowers"));
      if (!entry || entry.enabled !== true || entry.installed === false) throw new Error("Bflow plugin is not enabled in provider inventory");
      const configRoot = join(this.#home, provider === "claude" ? ".claude" : provider === "codex" ? ".codex" : ".gemini");
      const candidates = [entry.installPath, entry.path, entry.dir,
        typeof entry.source === "object" ? entry.source.path : undefined,
        join(configRoot, "plugins", "cache", "bflow-superpowers", "bflow-superpowers", pin.version),
        join(configRoot, "plugins", "cache", "bflow-superpowers", "bflow-superpowers", "local"),
        join(configRoot, "config", "plugins", "bflow-superpowers")].filter((path): path is string => !!path);
      let verified = false;
      for (const path of candidates) {
        try { if (await treeDigest(path) === record.bundleDigest) { verified = true; break; } } catch { /* inspect another native cache location */ }
      }
      if (!verified) throw new Error("Active provider cache does not match the pinned Bflow plugin bundle");
      const skills = await readdir(join(record.bundleRoot, "skills"));
      if (!skills.includes("using-superpowers")) throw new Error("using-superpowers is unavailable");
      for (const skill of skills) {
        if (this.#options.bflowSkillIds?.includes(`bflow-superpowers:${skill}`)) throw new Error("Bflow skill namespace collision");
        const content = await readRegular(join(record.bundleRoot, "skills", skill, "SKILL.md"));
        if (!content.includes(policy.trim())) throw new Error("Bflow conditional TDD policy is missing");
      }
      return { ready: true, diagnostic: "Provider enables the pinned plugin; every skill and Bflow policy is verified in its active cache" };
    } catch (error) { return { ready: false, diagnostic: `Native plugin verification failed: ${String(error)}` }; }
  }

  async #superpowersBundle(pin: ManagedToolPin, artifact: string): Promise<{ root: string; marketplace: string }> {
    const provider = this.#provider(pin);
    const managed = await privateDirectory(this.#options.managedRoot);
    const generation = join(managed, `superpowers-${pin.integrity}-${provider}-${sha256(policy).slice(0, 12)}`);
    const plugin = join(generation, "plugin");
    try {
      await lstat(generation);
      const saved = z.object({ sourceIntegrity: z.literal(pin.integrity), derivedDigest: z.string() }).strict()
        .parse(JSON.parse(await readRegular(join(generation, ".bflow-bundle.json"))));
      if (await treeDigest(plugin) !== saved.derivedDigest) throw new Error("Cached native bundle is corrupt; inspect it before repair");
      return { root: plugin, marketplace: generation };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const stage = `${generation}.staging-${randomUUID()}`;
    await mkdir(stage, { mode: 0o700 });
    try {
      const upstream = await extractPinnedArchive(artifact, join(stage, "upstream"));
      const manifest = manifestSchema.parse(JSON.parse(await readRegular(join(upstream, ".claude-plugin", "plugin.json"))));
      if (manifest.name !== "superpowers" || manifest.version !== pin.version || manifest.license !== pin.license)
        throw new Error("Superpowers archive identity, version or license mismatch");
      await cp(upstream, join(stage, "plugin"), { recursive: true, errorOnExist: true });
      await rm(join(stage, "upstream"), { recursive: true });
      // Bflow loads these as namespaced instructions. Upstream automatic executable hooks are not installed.
      await rm(join(stage, "plugin", "hooks"), { recursive: true, force: true });
      await rm(join(stage, "plugin", ".claude-plugin", "marketplace.json"), { force: true });
      await rm(join(stage, "plugin", ".agents", "plugins", "marketplace.json"), { force: true });
      const skills = await readdir(join(stage, "plugin", "skills"));
      for (const skill of skills) {
        const path = join(stage, "plugin", "skills", skill, "SKILL.md");
        const text = await readRegular(path);
        const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
        if (!frontmatter) throw new Error("External skill lacks frontmatter");
        await writeFile(path, frontmatter[0] + "\n" + policy + "\n" + text.slice(frontmatter[0].length), { mode: 0o600 });
      }
      const baseManifest = { name: "bflow-superpowers", version: pin.version, license: pin.license,
        description: "Pinned Superpowers skills governed by Bflow policy" };
      for (const directory of [".claude-plugin", ".codex-plugin", ".antigravity-plugin"]) {
        await mkdir(join(stage, "plugin", directory), { recursive: true, mode: 0o700 });
        await atomicJson(join(stage, "plugin", directory, "plugin.json"), directory === ".codex-plugin" ?
          { ...baseManifest, skills: "./skills/", hooks: {} } : baseManifest);
      }
      await mkdir(join(stage, ".claude-plugin"), { mode: 0o700 });
      await atomicJson(join(stage, ".claude-plugin", "marketplace.json"), { name: "bflow-superpowers", owner: { name: "Bflow" },
        plugins: [{ name: "bflow-superpowers", version: pin.version, source: "./plugin" }] });
      await mkdir(join(stage, ".agents", "plugins"), { recursive: true, mode: 0o700 });
      await atomicJson(join(stage, ".agents", "plugins", "marketplace.json"), { name: "bflow-superpowers",
        plugins: [{ name: "bflow-superpowers", source: { source: "local", path: "./plugin" } }] });
      await atomicJson(join(stage, ".bflow-bundle.json"), { sourceIntegrity: pin.integrity,
        derivedDigest: await treeDigest(join(stage, "plugin")) });
      await rename(stage, generation);
      return { root: plugin, marketplace: generation };
    } finally { await rm(stage, { recursive: true, force: true }); }
  }

  async activate(pin: ManagedToolPin, artifact: string, action: "install" | "update" | "repair", options?: OperationOptions) {
    const provider = this.#provider(pin);
    const managed = await privateDirectory(this.#options.managedRoot);
    return withFileLock(join(managed, `${pin.toolId}-${provider}.lock`), async () => {
      if (pin.toolId === "claude-mem") return this.#activateMemory(pin, artifact, options);
      if (pin.toolId !== "superpowers") throw new Error("Unknown native plugin");
      const bundle = await this.#superpowersBundle(pin, artifact);
      const executable = this.#binary(provider);
      const selector = provider === "agy" ? "bflow-superpowers" : "bflow-superpowers@bflow-superpowers";
      const inventory = await this.#inventory(provider);
      const existing = inventory.find(item => [item.pluginId, item.id, item.name].includes(selector));
      if (existing && action !== "install") {
        const removed = await this.#host.run(executable, ["plugin", provider === "codex" ? "remove" : "uninstall", selector], { timeoutMs: 30_000 });
        if (removed.exitCode !== 0) throw new Error("Could not remove the previous Bflow-owned plugin registration");
      }
      if (provider !== "agy") {
        // Only this Bflow namespace is replaced; personal marketplaces are outside this receipt.
        await this.#host.run(executable, ["plugin", "marketplace", "remove", "bflow-superpowers"], { timeoutMs: 30_000 });
        const registered = await this.#host.run(executable, ["plugin", "marketplace", "add", bundle.marketplace], { timeoutMs: 30_000 });
        if (registered.exitCode !== 0) throw new Error("Native local marketplace registration failed");
      } else {
        const validation = await this.#host.run(executable, ["plugin", "validate", bundle.root, "--strict", "--json"], { timeoutMs: 30_000 });
        if (validation.exitCode !== 0) throw new Error("Agy rejected the local plugin manifest");
      }
      const argv = provider === "codex" ? ["plugin", "add", selector, "--json"] :
        provider === "claude" ? ["plugin", "install", selector] : ["plugin", "install", bundle.root];
      const result = await this.#host.run(executable, argv, { timeoutMs: options?.timeoutMs ?? 90_000,
        ...(options?.signal ? { signal: options.signal } : {}) });
      if (result.exitCode !== 0) return { success: false, diagnostic: "Native plugin installation failed; reconcile its receipt before retrying" };
      await atomicJson(join(dirname(artifact), ".bflow-native.json"), { schemaVersion: 3, toolId: pin.toolId, provider,
        version: pin.version, sourceIntegrity: pin.integrity, bundleRoot: bundle.root, bundleDigest: await treeDigest(bundle.root),
        pluginId: selector, marketplaceRoot: bundle.marketplace,
        uninstall: [[executable, "plugin", provider === "codex" ? "remove" : "uninstall", selector],
          ...(provider === "agy" ? [] : [[executable, "plugin", "marketplace", "remove", "bflow-superpowers"]])] });
      return { success: true, diagnostic: "Installed the pinned local plugin through the provider's native mechanism" };
    });
  }

  #memory() {
    const dataDir = this.#options.memory?.dataDir ?? join(this.#home, ".claude-mem");
    const projectRoot = this.#options.memory?.projectRoot ?? process.cwd();
    return { dataDir, projectRoot, project: this.#options.memory?.project ?? projectRoot,
      ...this.#options.memory };
  }
  async #activateMemory(pin: ManagedToolPin, artifact: string, options?: OperationOptions) {
    const managed = await privateDirectory(this.#options.managedRoot);
    const generation = join(managed, `claude-mem-${pin.integrity}`);
    const memory = this.#memory();
    const environment = { CI: "1", CLAUDE_MEM_DATA_DIR: memory.dataDir, CLAUDE_MEM_WORKER_HOST: memory.address ?? "127.0.0.1",
      ...(memory.port ? { CLAUDE_MEM_WORKER_PORT: String(memory.port) } : {}) };
    try { await lstat(generation); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(generation, { mode: 0o700 });
      try {
        const installed = await this.#host.run("npm", ["install", "--prefix", generation, "--no-save", "--package-lock=false", artifact],
          { timeoutMs: options?.timeoutMs ?? 180_000, environment });
        if (installed.exitCode !== 0) throw new Error("Pinned Claude-Mem package dependencies failed to install");
        const manifest = manifestSchema.parse(JSON.parse(await readRegular(join(generation, "node_modules", "claude-mem", "package.json"))));
        if (manifest.name !== "claude-mem" || manifest.version !== pin.version || manifest.license !== pin.license)
          throw new Error("Claude-Mem identity/version/license mismatch");
        await cp(artifact, join(generation, "approved.tgz"));
      } catch (failure) { await rm(generation, { recursive: true, force: true }); throw failure; }
    }
    if (await fileDigest(join(generation, "approved.tgz")) !== pin.integrity) throw new Error("Stored Claude-Mem artifact changed");
    const executable = join(generation, "node_modules", ".bin", "claude-mem");
    const provider = this.#provider(pin);
    const ide = { claude: "claude-code", codex: "codex-cli", agy: "antigravity" }[provider];
    const result = await this.#host.run(executable, ["install", "--ide", ide, "--provider", "host", "--no-auto-start"],
      { timeoutMs: options?.timeoutMs ?? 300_000, environment, ...(options?.signal ? { signal: options.signal } : {}) });
    await writeFile(join(dirname(artifact), "native-installer.log"), result.stdout + result.stderr, { mode: 0o600 });
    if (result.exitCode !== 0) return { success: false, diagnostic: /No OpenAI-compatible host observer is listening/.test(result.stderr)
      ? "Claude-Mem host observer is unavailable on loopback ports 37777/37778. Start the existing OpenAI-compatible observer (or set CLAUDE_MEM_HOST_OBSERVER_PORT), inspect native-installer.log and explicitly review the retained native intent before retrying. No subscription or credentials were created."
      : `Official Claude-Mem installer exited ${result.exitCode}; full output retained in native-installer.log` };
    if (provider === "claude") {
      const pluginRoot = join(this.#home, ".claude", "plugins", "cache", "thedotmack", "claude-mem", pin.version);
      const hooks = JSON.parse(await readRegular(join(generation, "node_modules", "claude-mem", "plugin", "hooks", "hooks.json")));
      const launcher = join(this.#home, ".local", "bin", "claude-mem");
      absoluteMemoryHooks(hooks, launcher);
      const hooksPath = join(pluginRoot, "hooks", "hooks.json");
      const backup = join(managed, `claude-mem-hooks-before-${pin.integrity}.json`);
      try { await writeFile(backup, await readRegular(hooksPath), { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await atomicJson(hooksPath, hooks);
    }
    let worker = await observeClaudeMemWorker({ ...memory, version: pin.version });
    const pidExists = (await readClaudeMemWorkerIdentity(memory.dataDir)) !== null;
    const settings = z.record(z.unknown()).parse(JSON.parse(await readRegular(join(memory.dataDir, "settings.json"))));
    const port = memory.port ?? Number(settings.CLAUDE_MEM_WORKER_PORT ?? 37700 + ((process.getuid?.() ?? 0) % 100));
    if (worker.status !== "ready" && !pidExists && memory.startIfMissing !== false &&
      await portRefusesConnections(memory.address ?? "127.0.0.1", port)) {
      await withFileLock(join(managed, "claude-mem-worker.lock"), async () => {
        worker = await observeClaudeMemWorker({ ...memory, version: pin.version });
        if (worker.status !== "ready") await this.#host.run(executable, ["start"], { timeoutMs: 60_000, environment });
      });
    }
    await atomicJson(join(dirname(artifact), ".bflow-native.json"), { schemaVersion: 3, toolId: pin.toolId, provider,
      version: pin.version, sourceIntegrity: pin.integrity, bundleRoot: generation, bundleDigest: await treeDigest(generation),
      pluginId: provider === "codex" ? "claude-mem@claude-mem-local" : "claude-mem@thedotmack", marketplaceRoot: generation,
      uninstall: [] });
    return { success: true, diagnostic: "Official host installer finished; worker is adopted and verified separately" };
  }
  async #verifyMemory(pin: ManagedToolPin, generation: string) {
    const memory = this.#memory();
    const environment = { CLAUDE_MEM_DATA_DIR: memory.dataDir, PATH: [join(this.#home, ".local", "bin"), process.env.PATH ?? ""].join(delimiter),
      ...(memory.port ? { CLAUDE_MEM_WORKER_PORT: String(memory.port) } : {}) };
    const executable = join(generation, "node_modules", ".bin", "claude-mem");
    const doctor = await this.#host.run(executable, ["doctor"], { timeoutMs: 30_000, environment });
    if (doctor.exitCode !== 0) throw new Error("Claude-Mem dependency doctor failed");
    const worker = await observeClaudeMemWorker({ ...memory, version: pin.version });
    if (worker.status !== "ready" || !worker.endpoint) throw new Error(worker.diagnostic);
    await new ClaudeMemProjectReader(worker.endpoint, memory.project).recent(1);
    const provider = this.#provider(pin);
    if (provider === "claude" || provider === "codex") {
      const id = provider === "claude" ? "claude-mem@thedotmack" : "claude-mem@claude-mem-local";
      if (!(await this.#inventory(provider)).some(entry => [entry.pluginId, entry.id].includes(id) && entry.enabled === true))
        throw new Error("Claude-Mem host plugin is not active");
    } else {
      const hooks = z.record(z.unknown()).parse(JSON.parse(await readRegular(join(this.#home, ".gemini", "config", "hooks.json"))));
      const events = z.object({ PreInvocation: z.array(z.unknown()).min(1), PostToolUse: z.array(z.unknown()).min(1) })
        .passthrough().parse(hooks["claude-mem"]);
      if (!events) throw new Error("Agy native memory adapter is missing");
    }
    // Exercise the specific platform formatter against the adopted worker without starting an agent.
    const pluginRoot = join(this.#home, ".claude", "plugins", "cache", "thedotmack", "claude-mem", pin.version);
    const runner = join(pluginRoot, "scripts", "bun-runner.js");
    const service = join(pluginRoot, "scripts", "worker-service.cjs");
    await readRegular(runner);
    const sourceRoot = join(generation, "node_modules", "claude-mem", "plugin");
    for (const file of ["scripts/bun-runner.js", "scripts/worker-service.cjs"])
      if (await fileDigest(join(pluginRoot, file)) !== await fileDigest(join(sourceRoot, file))) throw new Error("Active memory adapter source differs from the approved package");
    if (provider === "claude") {
      const expected = JSON.parse(await readRegular(join(sourceRoot, "hooks", "hooks.json")));
      absoluteMemoryHooks(expected, join(this.#home, ".local", "bin", "claude-mem"));
      const active = JSON.parse(await readRegular(join(pluginRoot, "hooks", "hooks.json")));
      if (JSON.stringify(active) !== JSON.stringify(expected)) throw new Error("Active Claude memory hooks differ from the configured pinned hooks");
    }
    const input = provider === "agy" ? { conversationId: `bflow-probe-${randomUUID()}`, workspacePaths: [memory.projectRoot], invocationNum: 1 } :
      { session_id: `bflow-probe-${randomUUID()}`, cwd: memory.projectRoot, hook_event_name: "SessionStart", source: "startup" };
    let command = process.execPath;
    let args = [runner, service, "hook", provider === "claude" ? "claude-code" : "codex", "context"];
    if (provider === "agy") {
      const config = z.object({ "claude-mem": z.object({ PreInvocation: z.array(z.object({ command: z.string() }).passthrough()).min(1) }).passthrough() })
        .passthrough().parse(JSON.parse(await readRegular(join(this.#home, ".gemini", "config", "hooks.json"))));
      const parts = config["claude-mem"].PreInvocation[0]!.command.split(" ");
      if (parts.length !== 5 || !isAbsolute(parts[0]!) || !isAbsolute(parts[1]!) || parts.slice(2).join(" ") !== "hook antigravity-cli context" ||
        await fileDigest(parts[1]!) !== await fileDigest(join(sourceRoot, "scripts", "worker-service.cjs"))) throw new Error("Agy memory hook command does not match the pinned adapter");
      command = parts[0]!; args = parts.slice(1);
    }
    const probe = await this.#host.run(command, args, { timeoutMs: 30_000, input: JSON.stringify(input), environment });
    if (probe.exitCode !== 0) throw new Error("Platform memory context adapter failed");
    const output = JSON.parse(probe.stdout);
    if (provider === "agy") z.object({ injectSteps: z.array(z.object({ ephemeralMessage: z.string().min(1) })).min(1) }).passthrough().parse(output);
    else z.object({ hookSpecificOutput: z.object({ hookEventName: z.literal("SessionStart"), additionalContext: z.string() }).passthrough() })
      .passthrough().parse(output);
    return { ready: true, diagnostic: "Official dependencies, shared worker, project-filtered HTTP reads and provider-specific context adapter verified" };
  }
}

export async function nativeRollbackMetadata(destination: string) {
  return recordSchema.parse(JSON.parse(await readRegular(join(destination, ".bflow-native.json"))));
}
