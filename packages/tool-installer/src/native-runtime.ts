import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { OperationOptions } from "@bflow/contracts";
import type { ManagedToolPin, ToolHost } from "./installer.js";
import { atomicJson, existingPrivateDirectory, extractPinnedArchive, privateDirectory, readRegular, sha256, treeDigest, withFileLock } from "./files.js";

export type NativeProvider = "claude" | "codex" | "agy";
/** Isolated provider configuration supplied explicitly by the composition root. Only providers with a
 * documented configuration-directory variable can be isolated; every other provider is refused (fail closed). */
export interface NativeProviderIsolation {
  /** HOME for every provider child process, so CLIs that resolve `~` stay inside the isolated root. */
  readonly homeDirectory: string;
  /** CLAUDE_CONFIG_DIR for Claude Code child processes and plugin/cache reads. */
  readonly claudeConfigDir?: string;
  /** CODEX_HOME for Codex child processes and auth/plugin reads. */
  readonly codexHome?: string;
}
export interface NativeRuntimeOptions {
  managedRoot: string;
  homeDirectory?: string;
  /** When present, provider child processes and provider config reads are confined to these directories. */
  isolation?: NativeProviderIsolation;
  executables?: Partial<Record<NativeProvider, string>>;
  bflowSkillIds?: readonly string[];
}

/** Whether a provider's native configuration can be confined. Real (non-isolated) mode supports every provider. */
export function isolationSupports(isolation: NativeProviderIsolation | undefined, provider: NativeProvider): boolean {
  if (!isolation) return true;
  if (provider === "claude") return isolation.claudeConfigDir !== undefined;
  if (provider === "codex") return isolation.codexHome !== undefined;
  return false;
}

/** Environment for provider child processes. Real mode returns undefined so the caller's environment is unchanged. */
export function isolatedProviderEnvironment(isolation: NativeProviderIsolation | undefined, provider?: NativeProvider):
  Record<string, string> | undefined {
  if (!isolation) return undefined;
  if (provider !== undefined && !isolationSupports(isolation, provider))
    throw new Error(`${provider} native configuration cannot be isolated; owner action is required`);
  const environment: Record<string, string> = { HOME: isolation.homeDirectory };
  if (isolation.claudeConfigDir !== undefined && (provider === undefined || provider === "claude"))
    environment.CLAUDE_CONFIG_DIR = isolation.claudeConfigDir;
  if (isolation.codexHome !== undefined && (provider === undefined || provider === "codex"))
    environment.CODEX_HOME = isolation.codexHome;
  return environment;
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

export class NativePluginRuntime {
  readonly #options: NativeRuntimeOptions;
  readonly #host: ToolHost;
  readonly #home: string;
  constructor(options: NativeRuntimeOptions, host: ToolHost) {
    this.#options = options; this.#host = host; this.#home = options.isolation?.homeDirectory ?? options.homeDirectory ?? homedir();
  }
  #binary(provider: NativeProvider) { return this.#options.executables?.[provider] ?? provider; }
  /** Real mode adds nothing; isolated mode confines the child to its provider's isolated configuration. */
  #scope(provider?: NativeProvider): { environment?: Readonly<Record<string, string>> } {
    const environment = isolatedProviderEnvironment(this.#options.isolation, provider);
    return environment ? { environment } : {};
  }
  #configRoot(provider: NativeProvider): string {
    const isolation = this.#options.isolation;
    if (!isolation) return join(this.#home, provider === "claude" ? ".claude" : provider === "codex" ? ".codex" : ".gemini");
    if (!isolationSupports(isolation, provider)) throw new Error(`${provider} configuration is not isolated`);
    return provider === "claude" ? isolation.claudeConfigDir ?? "" : isolation.codexHome ?? "";
  }
  #provider(pin: ManagedToolPin): NativeProvider {
    if (pin.recipe.kind !== "provider_plugin") throw new Error("Native plugin recipe required");
    return pin.recipe.provider;
  }
  async #inventory(provider: NativeProvider) {
    // An isolated provider home that does not exist yet has nothing installed (Codex refuses a missing CODEX_HOME).
    if (this.#options.isolation && isolationSupports(this.#options.isolation, provider) && !existsSync(this.#configRoot(provider))) return [];
    const result = await this.#host.run(this.#binary(provider), ["plugin", "list", "--json"], { timeoutMs: 20_000, ...this.#scope(provider) });
    if (result.exitCode !== 0) throw new Error("Provider plugin inventory failed");
    const value = installedSchema.parse(JSON.parse(result.stdout));
    return Array.isArray(value) ? value : value.installed ?? value.plugins ?? [];
  }
  async #record(destination: string, pin: ManagedToolPin) {
    const record = recordSchema.parse(JSON.parse(await readRegular(join(destination, ".bflow-native.json"))));
    if (record.toolId !== pin.toolId || record.provider !== this.#provider(pin) || record.version !== pin.version ||
      record.sourceIntegrity !== pin.integrity) throw new Error("Native activation receipt differs from approved pin");
    const managed = await existingPrivateDirectory(this.#options.managedRoot);
    if (!record.bundleRoot.startsWith(`${managed}/`)) throw new Error("Native bundle escaped managed storage");
    return record;
  }
  async verify(pin: ManagedToolPin, destination: string): Promise<{ ready: boolean; diagnostic: string }> {
    try {
      const record = await this.#record(destination, pin);
      if (await treeDigest(record.bundleRoot) !== record.bundleDigest) throw new Error("Native source bytes changed");
      const provider = this.#provider(pin);
      const entries = await this.#inventory(provider);
      const entry = entries.find(item => [item.pluginId, item.id, item.name].includes(record.pluginId) ||
        (provider === "agy" && item.name === "bflow-superpowers"));
      if (!entry || entry.enabled !== true || entry.installed === false) throw new Error("Bflow plugin is not enabled in provider inventory");
      const configRoot = this.#configRoot(provider);
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
      if (pin.toolId !== "superpowers") throw new Error("Unknown native plugin");
      const bundle = await this.#superpowersBundle(pin, artifact);
      const executable = this.#binary(provider);
      const selector = provider === "agy" ? "bflow-superpowers" : "bflow-superpowers@bflow-superpowers";
      const inventory = await this.#inventory(provider);
      const existing = inventory.find(item => [item.pluginId, item.id, item.name].includes(selector));
      if (existing && action !== "install") {
        const removed = await this.#host.run(executable, ["plugin", provider === "codex" ? "remove" : "uninstall", selector], { timeoutMs: 30_000, ...this.#scope(provider) });
        if (removed.exitCode !== 0) throw new Error("Could not remove the previous Bflow-owned plugin registration");
      }
      if (provider !== "agy") {
        // Only this Bflow namespace is replaced; personal marketplaces are outside this receipt.
        await this.#host.run(executable, ["plugin", "marketplace", "remove", "bflow-superpowers"], { timeoutMs: 30_000, ...this.#scope(provider) });
        const registered = await this.#host.run(executable, ["plugin", "marketplace", "add", bundle.marketplace], { timeoutMs: 30_000, ...this.#scope(provider) });
        if (registered.exitCode !== 0) throw new Error("Native local marketplace registration failed");
      } else {
        const validation = await this.#host.run(executable, ["plugin", "validate", bundle.root, "--strict", "--json"], { timeoutMs: 30_000, ...this.#scope(provider) });
        if (validation.exitCode !== 0) throw new Error("Agy rejected the local plugin manifest");
      }
      const argv = provider === "codex" ? ["plugin", "add", selector, "--json"] :
        provider === "claude" ? ["plugin", "install", selector] : ["plugin", "install", bundle.root];
      const result = await this.#host.run(executable, argv, { timeoutMs: options?.timeoutMs ?? 90_000,
        ...(options?.signal ? { signal: options.signal } : {}), ...this.#scope(provider) });
      if (result.exitCode !== 0) return { success: false, diagnostic: "Native plugin installation failed; reconcile its receipt before retrying" };
      await atomicJson(join(dirname(artifact), ".bflow-native.json"), { schemaVersion: 3, toolId: pin.toolId, provider,
        version: pin.version, sourceIntegrity: pin.integrity, bundleRoot: bundle.root, bundleDigest: await treeDigest(bundle.root),
        pluginId: selector, marketplaceRoot: bundle.marketplace,
        uninstall: [[executable, "plugin", provider === "codex" ? "remove" : "uninstall", selector],
          ...(provider === "agy" ? [] : [[executable, "plugin", "marketplace", "remove", "bflow-superpowers"]])] });
      return { success: true, diagnostic: "Installed the pinned local plugin through the provider's native mechanism" };
    });
  }

}

export async function nativeRollbackMetadata(destination: string) {
  return recordSchema.parse(JSON.parse(await readRegular(join(destination, ".bflow-native.json"))));
}
