import { readFile, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { z } from "zod";
import type { OperationOptions } from "@bflow/contracts";
import { systemToolHost, type ManagedToolPin, type ProviderPluginAdapter, type ToolHost } from "./installer.js";
import { NativePluginRuntime, type NativeRuntimeOptions } from "./native-runtime.js";

type Provider = "claude" | "codex" | "agy";
type NativePin = ManagedToolPin & { recipe: { kind: "provider_plugin"; provider: Provider } };

const entrySchema = z.object({
  pluginId: z.string().optional(), id: z.string().optional(), name: z.string().optional(),
  version: z.string().optional(), enabled: z.boolean().optional(), installed: z.boolean().optional()
}).passthrough();
const inventorySchema = z.union([z.array(entrySchema), z.object({ installed: z.array(entrySchema) }).passthrough()]);
const packageSchema = z.object({ name: z.literal("claude-mem"), version: z.string(), license: z.string() }).passthrough();

function nativePin(pin: ManagedToolPin): NativePin {
  if (pin.recipe.kind !== "provider_plugin") throw new Error("Native provider plugin recipe required");
  return pin as NativePin;
}

function inventoryCommand(provider: Provider): readonly [string, readonly string[]] {
  return provider === "claude" ? ["claude", ["plugin", "list", "--json"]] :
    provider === "codex" ? ["codex", ["plugin", "list", "--json"]] : ["agy", ["plugin", "list", "--json"]];
}

function pluginIdentity(pin: NativePin): string {
  return pin.toolId === "superpowers" ? pin.recipe.provider === "claude" ?
    "superpowers@claude-plugins-official" : pin.recipe.provider === "codex" ?
      "superpowers@openai-curated-remote" : "superpowers" : "claude-mem@thedotmack";
}

export interface OfficialProviderPluginAdapterOptions {
  readonly host?: ToolHost;
  readonly configuration?: NativeRuntimeOptions;
  /** Must inspect the provider's active skill inventory, not merely source files. */
  readonly discoverSkills?: (provider: Provider) => Promise<readonly string[]>;
  /** Binds the active provider marketplace snapshot to the reviewed source/pin. */
  readonly verifyProvenance?: (pin: ManagedToolPin) => Promise<boolean>;
  /** Must test the configured shared worker and a provider-specific hook or adapter. */
  readonly probeMemory?: (provider: Provider) => Promise<boolean>;
  readonly bflowSkillIds?: readonly string[];
}

/** Uses documented provider CLIs; readiness still requires independent functional probes. */
export class OfficialProviderPluginAdapter implements ProviderPluginAdapter {
  readonly #host: ToolHost;
  readonly #discoverSkills: OfficialProviderPluginAdapterOptions["discoverSkills"];
  readonly #verifyProvenance: OfficialProviderPluginAdapterOptions["verifyProvenance"];
  readonly #probeMemory: OfficialProviderPluginAdapterOptions["probeMemory"];
  readonly #bflowSkillIds: readonly string[];
  readonly #runtime: NativePluginRuntime | undefined;

  constructor(options: OfficialProviderPluginAdapterOptions) {
    this.#host = options.host ?? systemToolHost;
    this.#discoverSkills = options.discoverSkills;
    this.#verifyProvenance = options.verifyProvenance;
    this.#probeMemory = options.probeMemory;
    this.#bflowSkillIds = options.bflowSkillIds ?? [];
    this.#runtime = options.configuration ? new NativePluginRuntime(options.configuration, this.#host) : undefined;
  }

  async #installed(pin: NativePin): Promise<boolean> {
    const [executable, args] = inventoryCommand(pin.recipe.provider);
    const result = await this.#host.run(executable, args, { timeoutMs: 20_000 });
    if (result.exitCode !== 0) return false;
    const parsed = inventorySchema.safeParse(JSON.parse(result.stdout));
    if (!parsed.success) return false;
    const entries = Array.isArray(parsed.data) ? parsed.data : parsed.data.installed;
    const identity = pluginIdentity(pin);
    return entries.some(entry => [entry.pluginId, entry.id, entry.name].includes(identity) &&
      entry.version === pin.version && entry.enabled !== false && entry.installed !== false);
  }

  async verify(raw: ManagedToolPin, destination: string): Promise<{ ready: boolean; diagnostic: string }> {
    if (this.#runtime) return this.#runtime.verify(raw, destination);
    const pin = nativePin(raw);
    try {
      if (pin.toolId === "superpowers") {
        if (!(await this.#installed(pin))) return { ready: false, diagnostic: "Provider plugin inventory lacks the exact enabled version" };
        if (!(await this.#verifyProvenance?.(pin)))
          return { ready: false, diagnostic: "Provider marketplace provenance does not match the approved pin" };
        const skills = await this.#discoverSkills?.(pin.recipe.provider) ?? [];
        if (!skills.includes("using-superpowers") || skills.some(id => this.#bflowSkillIds.includes(`superpowers:${id}`)))
          return { ready: false, diagnostic: "Superpowers skill is unavailable or collides with a Bflow skill" };
        return { ready: true, diagnostic: "Exact provider plugin version and active skill verified" };
      }
      if (pin.toolId !== "claude-mem") return { ready: false, diagnostic: "Unknown native plugin" };
      if (pin.recipe.provider === "claude" && !(await this.#installed(pin)))
        return { ready: false, diagnostic: "Claude Code plugin inventory lacks the exact enabled version" };
      const manifest = packageSchema.parse(JSON.parse(await readFile(join(destination, "node_modules", "claude-mem", "package.json"), "utf8")));
      if (manifest.version !== pin.version || manifest.license !== pin.license)
        return { ready: false, diagnostic: "Claude-Mem package pin or license mismatch" };
      const executable = join(destination, "node_modules", ".bin", "claude-mem");
      if (!(await realpath(executable)).startsWith(`${await realpath(destination)}${sep}`))
        return { ready: false, diagnostic: "Claude-Mem doctor executable escaped the owned install" };
      const doctor = await this.#host.run(executable, ["doctor"], { timeoutMs: 30_000 });
      if (doctor.exitCode !== 0 || !(await this.#probeMemory?.(pin.recipe.provider)))
        return { ready: false, diagnostic: "Claude-Mem doctor, shared worker, or provider adapter failed" };
      return { ready: true, diagnostic: "Claude-Mem plugin, dependencies, shared worker and provider adapter verified" };
    } catch (error) { return { ready: false, diagnostic: `Provider plugin verification failed: ${String(error)}` }; }
  }

  async activate(raw: ManagedToolPin, artifact: string, _action: "install" | "update" | "repair", options?: OperationOptions):
    Promise<{ success: boolean; diagnostic: string }> {
    if (this.#runtime) return this.#runtime.activate(raw, artifact, _action, options);
    const pin = nativePin(raw);
    if (pin.toolId === "claude-mem") {
      const stage = dirname(artifact);
      const installed = await this.#host.run("npm", ["install", "--prefix", stage, "--no-save", "--package-lock=false", artifact],
        { timeoutMs: options?.timeoutMs ?? 180_000, ...(options?.signal ? { signal: options.signal } : {}) });
      if (installed.exitCode !== 0) return { success: false, diagnostic: `Claude-Mem dependency install exited ${installed.exitCode}` };
      const manifest = packageSchema.parse(JSON.parse(await readFile(join(stage, "node_modules", "claude-mem", "package.json"), "utf8")));
      if (manifest.version !== pin.version || manifest.license !== pin.license)
        return { success: false, diagnostic: "Claude-Mem package identity, version or license differs from approved pin" };
      const ide = { claude: "claude-code", codex: "codex-cli", agy: "antigravity" }[pin.recipe.provider];
      const executable = join(stage, "node_modules", ".bin", "claude-mem");
      const result = await this.#host.run(executable, ["install", "--ide", ide, "--provider", "host", "--no-auto-start"],
        { timeoutMs: options?.timeoutMs ?? 300_000, ...(options?.signal ? { signal: options.signal } : {}) });
      return { success: result.exitCode === 0, diagnostic: `Claude-Mem official installer exited ${result.exitCode}` };
    }
    if (pin.toolId !== "superpowers") return { success: false, diagnostic: "Unknown native plugin" };
    const route: readonly [string, readonly string[]] = pin.recipe.provider === "claude" ?
      ["claude", ["plugin", "install", "superpowers@claude-plugins-official"]] : pin.recipe.provider === "codex" ?
        ["codex", ["plugin", "add", "superpowers@openai-curated-remote", "--json"]] :
        ["agy", ["plugin", "install", "https://github.com/obra/superpowers"]];
    const result = await this.#host.run(route[0], route[1],
      { timeoutMs: options?.timeoutMs ?? 180_000, ...(options?.signal ? { signal: options.signal } : {}) });
    return { success: result.exitCode === 0, diagnostic: `Superpowers ${pin.recipe.provider} plugin installer exited ${result.exitCode}` };
  }
}
