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

function nativePin(pin: ManagedToolPin): NativePin {
  if (pin.recipe.kind !== "provider_plugin") throw new Error("Native provider plugin recipe required");
  return pin as NativePin;
}

function inventoryCommand(provider: Provider): readonly [string, readonly string[]] {
  return provider === "claude" ? ["claude", ["plugin", "list", "--json"]] :
    provider === "codex" ? ["codex", ["plugin", "list", "--json"]] : ["agy", ["plugin", "list", "--json"]];
}

function pluginIdentity(pin: NativePin): string {
  return pin.recipe.provider === "claude" ? "superpowers@claude-plugins-official" :
    pin.recipe.provider === "codex" ? "superpowers@openai-curated-remote" : "superpowers";
}

export interface OfficialProviderPluginAdapterOptions {
  readonly host?: ToolHost;
  readonly configuration?: NativeRuntimeOptions;
  /** Must inspect the provider's active skill inventory, not merely source files. */
  readonly discoverSkills?: (provider: Provider) => Promise<readonly string[]>;
  /** Binds the active provider marketplace snapshot to the reviewed source/pin. */
  readonly verifyProvenance?: (pin: ManagedToolPin) => Promise<boolean>;
  readonly bflowSkillIds?: readonly string[];
}

/** Uses documented provider CLIs; readiness still requires independent functional probes. */
export class OfficialProviderPluginAdapter implements ProviderPluginAdapter {
  readonly #host: ToolHost;
  readonly #discoverSkills: OfficialProviderPluginAdapterOptions["discoverSkills"];
  readonly #verifyProvenance: OfficialProviderPluginAdapterOptions["verifyProvenance"];
  readonly #bflowSkillIds: readonly string[];
  readonly #runtime: NativePluginRuntime | undefined;

  constructor(options: OfficialProviderPluginAdapterOptions) {
    this.#host = options.host ?? systemToolHost;
    this.#discoverSkills = options.discoverSkills;
    this.#verifyProvenance = options.verifyProvenance;
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
      return { ready: false, diagnostic: "Unknown native plugin" };
    } catch (error) { return { ready: false, diagnostic: `Provider plugin verification failed: ${String(error)}` }; }
  }

  /** Proves absence only when the provider's own inventory was read; otherwise null (unknown). */
  async registered(raw: ManagedToolPin): Promise<boolean | null> {
    return this.#runtime ? this.#runtime.registered(raw) : null;
  }

  async activate(raw: ManagedToolPin, artifact: string, _action: "install" | "update" | "repair", options?: OperationOptions):
    Promise<{ success: boolean; diagnostic: string }> {
    if (this.#runtime) return this.#runtime.activate(raw, artifact, _action, options);
    const pin = nativePin(raw);
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
