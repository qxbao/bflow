import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentLaunchProfile,
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
import { inspectCodexHooks } from "./codex-hook-trust.js";
import { managedCodexPluginArgs } from "./codex-plugin-policy.js";

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${tomlValue(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Reserved, environment-bound startup turn; ordinary user prompts must still reach Conversation. */
export function codexStartupPrompt(environmentId: string): string {
  return `[bflow startup ${environmentId}] Reply only pong. Do not use tools or start a workflow.`;
}

const MCP_NOT_ISOLATED_CODE = "codex_global_mcp_not_isolated";
/** Bare TOML keys accepted verbatim in a `-c mcp_servers.<name>.enabled=false` dotted path. */
const BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MCP_TABLE_PATTERN = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*(?:\.[^\]]*)?\]/gm;
const CODEX_HOOK_DIGEST_METADATA_KEY = "bflowCodexHookSnapshotDigest";

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

  protected override getProviderCommandEnvironment(): Readonly<Record<string, string>> {
    const selected = this.trustedHookEnvironment();
    return {
      BFLOW_PROVIDER: this.descriptor.provider,
      HOME: selected["HOME"] ?? "",
      PATH: selected["PATH"] ?? "",
      ORCA_AGENT_HOOK_ROOT: selected["ORCA_AGENT_HOOK_ROOT"] ?? "",
      ORCA_AGENT_HOOK_ENDPOINT: selected["ORCA_AGENT_HOOK_ENDPOINT"] ?? "",
      ORCA_PANE_KEY: selected["ORCA_PANE_KEY"] ?? "",
      ORCA_AGENT_HOOK_PORT: selected["ORCA_AGENT_HOOK_PORT"] ?? "",
      ...(this.options.codexHomeDirectory ? { CODEX_HOME: this.options.codexHomeDirectory } : selected["CODEX_HOME"] !== undefined ? { CODEX_HOME: selected["CODEX_HOME"] } : {})
    };
  }

  private trustedHookEnvironment(): Readonly<Record<string, string | undefined>> {
    if (this.options.codexHookEnvironment === undefined) return process.env;
    return {
      ...this.options.codexHookEnvironment,
      HOME: this.options.codexHookEnvironment["HOME"] ?? "",
      PATH: this.options.codexHookEnvironment["PATH"] ?? process.env["PATH"] ?? "",
      ORCA_AGENT_HOOK_ROOT: this.options.codexHookEnvironment["ORCA_AGENT_HOOK_ROOT"] ?? "",
      ORCA_AGENT_HOOK_ENDPOINT: this.options.codexHookEnvironment["ORCA_AGENT_HOOK_ENDPOINT"] ?? "",
      ...(this.options.codexHomeDirectory ? { CODEX_HOME: this.options.codexHomeDirectory } : {})
    };
  }

  protected override getProbeCommand(_environment: AgentEnvironment): readonly string[] {
    const probe = ["exec"];
    if (this.options.model) {
      probe.push("--model", this.options.model);
    }
    if (this.options.effort) probe.push("-c", `model_reasoning_effort=${JSON.stringify(this.options.effort)}`);
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
    const environment = this.trustedHookEnvironment();
    return this.options.codexHomeDirectory || environment["CODEX_HOME"] || join(environment["HOME"] ?? homedir(), ".codex");
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
  private async enumerateGlobalMcpServers(home: string, pluginArgs: readonly string[]): Promise<{ readonly names: string[]; readonly error?: string }> {
    let listFailure: string;
    try {
      const outcome = await this.runner.run({
        executable: this.getExecutablePath(),
        args: [...pluginArgs, "mcp", "list", "--json"],
        env: this.getProviderCommandEnvironment(),
        timeoutMs: 45_000
      });
      if (outcome.exitCode === 0 && outcome.failure === undefined) {
        const parsed: unknown = JSON.parse(outcome.stdout);
        if (
          Array.isArray(parsed) &&
          parsed.every((entry) => typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string")
        ) {
          // Only servers defined as `[mcp_servers.<name>]` tables in config.toml can be disabled with a dotted
          // override. Plugin-provided servers (e.g. an `mcp-search` server installed by a provider plugin) have no
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
   * require exact snapshot approval or an explicit operator all-hook policy. Neither mode disables Bflow hooks.
   */
  protected override async resolveInheritedIsolation(
    _environment: AgentEnvironment,
    _capabilities: DetectedProviderCapabilities,
    bflowMcpServerNames: readonly string[],
    launchProfile?: AgentLaunchProfile
  ): Promise<InheritedIsolation> {
    const home = this.codexHome();
    const pluginArgs = managedCodexPluginArgs();
    const globalServers = await this.enumerateGlobalMcpServers(home, pluginArgs);

    let mcpFailure: InheritedIsolationFailure | undefined;
    const argv: string[] = [...pluginArgs];
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
        argv.push(...globalServers.names.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]));
      }
    }

    const hookReview = await inspectCodexHooks({
      codexHomeDirectory: home,
      ...(this.options.codexHookApprovalPath !== undefined ? { approvalStorePath: this.options.codexHookApprovalPath } : {}),
      environment: this.trustedHookEnvironment()
    });
    let hookFailure: InheritedIsolationFailure | undefined;
    if (hookReview.status === "unsupported") {
      hookFailure = {
        code: "codex_global_hooks_unsupported",
        message: `Global Codex hook configuration cannot be safely reviewed: ${hookReview.unsupportedReasons.join("; ")}`,
        remediation: "Use supported literal hook commands and inspect the reported dependencies. Dynamic sourced endpoint scripts remain blocked in snapshot mode. Or explicitly choose `bflow setup --codex-hooks --apply --trust-all --yes`."
      };
    } else if (hookReview.status === "approval_required") {
      hookFailure = {
        code: "codex_global_hooks_approval_required",
        message: `Global Codex hooks require exact snapshot approval (digest ${hookReview.digest}).`,
        remediation: "Run `bflow setup --codex-hooks --plan`, inspect the hook sources, then apply with the reviewed digest, or explicitly choose `bflow setup --codex-hooks --apply --trust-all --yes`."
      };
    }

    const settingsMetadata = { [CODEX_HOOK_DIGEST_METADATA_KEY]: hookReview.digest };
    if (launchProfile !== undefined && hookFailure === undefined) {
      const settingsPath = join(_environment.stateDirectory, `${_environment.role}.settings.json`);
      try {
        if (!launchProfile.configFiles.some(file => file.path === settingsPath)) throw new Error("launch profile does not bind the private provider settings snapshot");
        const handle = await open(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let content: string;
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 256 * 1024)
            throw new Error("private provider settings file is not a safe regular 0600 file");
          content = await handle.readFile("utf8");
        } finally { await handle.close(); }
        const settings = JSON.parse(content) as Record<string, unknown>;
        if (settings[CODEX_HOOK_DIGEST_METADATA_KEY] !== hookReview.digest)
          throw new Error("Codex hook snapshot changed after the prepared launch profile");
      } catch (error) {
        hookFailure = {
          code: "codex_global_hooks_snapshot_drift",
          message: `Prepared Codex hook snapshot cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
          remediation: "Prepare a new launch and re-run provider activation after the exact hook inventory is approved."
        };
      }
    }

    return {
      argv,
      ...(mcpFailure !== undefined ? { mcpFailure } : {}),
      ...(hookFailure !== undefined ? { hookFailure } : {}),
      settingsMetadata
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

    if (this.options.effort) {
      if (!capabilities.supportedFlags.has("--config")) {
        return {
          argv: [],
          unsupportedCode: "invalid_flag",
          unsupportedMessage: "Codex CLI does not support --config for reasoning effort"
        };
      }
      argv.push("-c", `model_reasoning_effort=${JSON.stringify(this.options.effort)}`);
    }

    argv.push(codexStartupPrompt(environment.environmentId));

    return { argv };
  }
}
