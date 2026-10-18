import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentEnvironment,
  AgentProviderDescriptor
} from "@bflow/contracts";
import {
  BaseProviderAdapter,
  type InheritedIsolation,
  type InheritedIsolationFailure
} from "./base-adapter.js";
import { compileProviderPermissions } from "./permissions.js";
import type {
  DetectedProviderCapabilities,
  ProviderAdapterOptions
} from "./types.js";

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${tomlValue(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const MCP_NOT_ISOLATED_CODE = "codex_global_mcp_not_isolated";
const HOOKS_NOT_ISOLATED_CODE = "codex_global_hooks_not_isolated";
/** Bare TOML keys accepted verbatim in a `-c mcp_servers.<name>.enabled=false` dotted path. */
const BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MCP_TABLE_PATTERN = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*(?:\.[^\]]*)?\]/gm;
const HOOKS_TABLE_PATTERN = /^\s*\[\[?\s*hooks\b/m;
const HOOKS_KEY_PATTERN = /^\s*hooks\s*=/m;

/** Table names of `[mcp_servers.<name>]` entries in a Codex config.toml (fallback when `codex mcp list` fails). */
export function parseCodexConfigMcpServerNames(toml: string): string[] {
  const names = new Set<string>();
  for (const match of toml.matchAll(MCP_TABLE_PATTERN)) {
    const name = match[1] ?? match[2];
    if (name) names.add(name);
  }
  return [...names];
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function containsHookEntry(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.values(value).some(containsHookEntry);
  return false;
}

/** Global hook sources in the Codex home. Unreadable or malformed sources count as present (fail closed). */
async function inspectGlobalHookSources(home: string): Promise<string[]> {
  const sources: string[] = [];
  const hooksPath = join(home, "hooks.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(hooksPath, "utf8"));
    if (containsHookEntry(parsed)) sources.push(hooksPath);
  } catch (err) {
    if (!isNotFound(err)) sources.push(hooksPath);
  }

  const configPath = join(home, "config.toml");
  try {
    const text = await readFile(configPath, "utf8");
    if (HOOKS_TABLE_PATTERN.test(text) || HOOKS_KEY_PATTERN.test(text)) sources.push(configPath);
  } catch (err) {
    if (!isNotFound(err)) sources.push(configPath);
  }
  return sources;
}

export class CodexProviderAdapter extends BaseProviderAdapter {
  readonly descriptor: AgentProviderDescriptor = {
    schemaVersion: 3,
    provider: "codex",
    adapterVersion: "0.1.0",
    executableName: "codex",
    capabilities: [
      {
        id: "codex-implementation",
        name: "Codex CLI Implementation",
        category: "implementation",
        description: "Automated software implementation under workspace-write sandbox.",
        readOnly: false
      },
      {
        id: "codex-review",
        name: "Codex CLI Review",
        category: "review",
        description: "Read-only inspection and analysis under read-only sandbox.",
        readOnly: true
      },
      {
        id: "codex-testing",
        name: "Codex CLI Testing",
        category: "testing",
        description: "Automated test execution under sandbox.",
        readOnly: false
      }
    ],
    mcpTransports: ["stdio", "streamable_http"],
    supportsUnattended: true,
    supportsNativeBinding: true
  };

  constructor(options?: ProviderAdapterOptions) {
    super(options);
  }

  protected override getAuthCommand(): readonly string[] {
    return ["login", "status"];
  }

  protected override getProbeCommand(_environment: AgentEnvironment): readonly string[] {
    const probe = ["exec"];
    if (this.options.model) {
      probe.push("--model", this.options.model);
    }
    probe.push("ping");
    return probe;
  }

  protected override renderStreamableHttpMcpServer(
    endpoint: string,
    tokenEnvironmentName: string
  ): Record<string, unknown> {
    // Codex reads the bearer token from the named environment variable; the config holds only the name.
    return { url: endpoint, bearer_token_env_var: tokenEnvironmentName };
  }

  private codexHome(): string {
    return this.options.codexHomeDirectory || process.env["CODEX_HOME"] || join(homedir(), ".codex");
  }

  /** `[mcp_servers.<name>]` table names of the user's Codex config.toml (missing file = none). */
  private async configTableNames(home: string): Promise<{ readonly names: string[]; readonly error?: string }> {
    try {
      return { names: parseCodexConfigMcpServerNames(await readFile(join(home, "config.toml"), "utf8")) };
    } catch (err) {
      if (isNotFound(err)) return { names: [] };
      return { names: [], error: `config.toml unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Lists the global MCP servers Codex would load (`codex mcp list --json`, read-only; falls back to the
   * `[mcp_servers.<name>]` tables of config.toml when the list cannot be read).
   */
  private async enumerateGlobalMcpServers(home: string): Promise<{ readonly names: string[]; readonly error?: string }> {
    let listFailure: string;
    try {
      const outcome = await this.runner.run({
        executable: this.getExecutablePath(),
        args: ["mcp", "list", "--json"],
        env: { BFLOW_PROVIDER: this.descriptor.provider },
        timeoutMs: 45_000
      });
      if (outcome.exitCode === 0 && outcome.failure === undefined) {
        const parsed: unknown = JSON.parse(outcome.stdout);
        if (
          Array.isArray(parsed) &&
          parsed.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string")
        ) {
          // Only servers defined as `[mcp_servers.<name>]` tables in config.toml can be disabled with a dotted
          // override. Plugin-provided servers (e.g. Claude-Mem's `mcp-search`, installed by approved setup) have no
          // table: `mcp_servers.<name>.enabled=false` for them aborts Codex config loading ("invalid transport"),
          // as observed live on codex-cli 0.162.0. They are left to the plugin and not overridden here.
          const listed = [...new Set(parsed.map((entry) => (entry as { name: string }).name))];
          const tables = await this.configTableNames(home);
          if (tables.error !== undefined) return { names: [], error: tables.error };
          return { names: listed.filter((name) => tables.names.includes(name)) };
        }
        listFailure = "codex mcp list --json returned an unexpected shape";
      } else {
        listFailure = `codex mcp list --json exited with ${outcome.exitCode ?? outcome.failure ?? "no status"}`;
      }
    } catch (err) {
      listFailure = `codex mcp list --json failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    try {
      const text = await readFile(join(home, "config.toml"), "utf8");
      return { names: parseCodexConfigMcpServerNames(text) };
    } catch (err) {
      if (isNotFound(err)) return { names: [] };
      return {
        names: [],
        error: `${listFailure}; config.toml fallback unreadable: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  /**
   * Per-invocation isolation: every global MCP server not used by the Bflow launch is disabled with
   * `-c mcp_servers.<name>.enabled=false` (verified against codex-cli 0.162.0: the override is honored by
   * `codex mcp list --json`, merges with the Bflow `mcp_servers=` table only when placed after it, and an
   * unknown name aborts config loading, so only names enumerated from the config are passed). Global hooks
   * have no verified per-invocation bypass that keeps Bflow hooks, so their presence fails closed.
   */
  protected override async resolveInheritedIsolation(
    _environment: AgentEnvironment,
    _capabilities: DetectedProviderCapabilities,
    bflowMcpServerNames: readonly string[]
  ): Promise<InheritedIsolation> {
    const home = this.codexHome();
    const globalServers = await this.enumerateGlobalMcpServers(home);

    let mcpFailure: InheritedIsolationFailure | undefined;
    let argv: string[] = [];
    if (globalServers.error !== undefined) {
      mcpFailure = {
        code: MCP_NOT_ISOLATED_CODE,
        message: `Cannot enumerate the global Codex MCP servers to isolate: ${globalServers.error}`,
        remediation:
          "Make `codex mcp list --json` succeed for this Codex installation. Bflow does not modify ~/.codex."
      };
    } else {
      const collisions = globalServers.names.filter((name) => bflowMcpServerNames.includes(name));
      const unsafe = globalServers.names.filter((name) => !BARE_KEY_PATTERN.test(name));
      if (collisions.length > 0) {
        mcpFailure = {
          code: MCP_NOT_ISOLATED_CODE,
          message: `Global Codex MCP server(s) share a name with Bflow launch servers and would merge into them: ${collisions.join(", ")}`,
          remediation: "Rename the Bflow MCP registration or remove the global Codex MCP server with the same name."
        };
      } else if (unsafe.length > 0) {
        mcpFailure = {
          code: MCP_NOT_ISOLATED_CODE,
          message: `Global Codex MCP server name(s) cannot be disabled per invocation: ${unsafe.join(", ")}`,
          remediation: "Rename the global Codex MCP server to use only letters, digits, '_' and '-'."
        };
      } else {
        argv = globalServers.names.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
      }
    }

    const hookSources = await inspectGlobalHookSources(home);
    const hookFailure: InheritedIsolationFailure | undefined =
      hookSources.length > 0
        ? {
            code: HOOKS_NOT_ISOLATED_CODE,
            message: `Global Codex hooks would run inside the Bflow role (${hookSources.join(", ")}); no per-invocation bypass keeps Bflow hooks`,
            remediation:
              "Move personal Codex hooks into a Codex profile that Bflow does not use, or remove them from the global Codex configuration. Bflow does not modify these files."
          }
        : undefined;

    return {
      argv,
      ...(mcpFailure !== undefined ? { mcpFailure } : {}),
      ...(hookFailure !== undefined ? { hookFailure } : {})
    };
  }

  protected override async compileArgv(
    environment: AgentEnvironment,
    configFiles: { promptFile: string; mcpConfigFile: string; settingsFile: string },
    capabilities: DetectedProviderCapabilities,
    inherited: InheritedIsolation
  ): Promise<{ readonly argv: readonly string[]; readonly unsupportedCode?: string; readonly unsupportedMessage?: string }> {
    const permResult = await compileProviderPermissions(
      "codex",
      environment.permissionProfile,
      environment.role,
      capabilities,
      {
        cwd: environment.cwd,
        mcpServerNames: (this.options.mcpRegistrations ?? []).map((r) => r.registrationId),
        ...(this.options.osSandboxPath !== undefined ? { osSandboxPath: this.options.osSandboxPath } : {})
      }
    );

    if (!permResult.supported) {
      return {
        argv: [],
        unsupportedCode: permResult.code,
        unsupportedMessage: permResult.message
      };
    }

    const argv: string[] = [
      ...permResult.flags,
      "-c",
      `model_instructions_file=${JSON.stringify(configFiles.promptFile)}`
    ];

    try {
      const mcpContent = await readFile(configFiles.mcpConfigFile, "utf8");
      const mcpParsed = JSON.parse(mcpContent) as { mcpServers?: Record<string, unknown> };
      if (mcpParsed.mcpServers && Object.keys(mcpParsed.mcpServers).length > 0) {
        argv.push("-c", `mcp_servers=${tomlValue(mcpParsed.mcpServers)}`);
      }
    } catch {
      // Ignore reading error if missing
    }

    // Disables must follow the Bflow mcp_servers= table override (verified: an earlier override is reset by it).
    argv.push(...inherited.argv);

    try {
      const settingsContent = await readFile(configFiles.settingsFile, "utf8");
      const settingsParsed = JSON.parse(settingsContent) as { hooks?: Record<string, unknown> };
      if (settingsParsed.hooks && Object.keys(settingsParsed.hooks).length > 0) {
        if (
          !capabilities.supportedFlags.has("--enable") ||
          !capabilities.supportedFlags.has("--dangerously-bypass-hook-trust")
        ) {
          return {
            argv: [],
            unsupportedCode: "invalid_flag",
            unsupportedMessage: "Codex CLI does not support required hook flags (--enable, --dangerously-bypass-hook-trust)"
          };
        }
        argv.push(
          "--enable",
          "hooks",
          "--dangerously-bypass-hook-trust",
          "-c",
          `hooks=${tomlValue(settingsParsed.hooks)}`
        );
      }
    } catch {
      // Ignore reading error if missing
    }

    if (this.options.model) {
      if (!capabilities.supportedFlags.has("--model")) {
        return {
          argv: [],
          unsupportedCode: "invalid_flag",
          unsupportedMessage: "Codex CLI does not support --model flag"
        };
      }
      argv.push("--model", this.options.model);
    }

    return { argv };
  }
}
