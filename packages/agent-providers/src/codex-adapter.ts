import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { codexHookPolicyPath, inspectCodexHooks } from "./codex-hook-trust.js";
import { parseCodexEnabledPlugins } from "./codex-hook-toml.js";
import { managedCodexPluginArgs } from "./codex-plugin-policy.js";
import { codexProbeConfigDependencies } from "./codex-probe-config.js";
import { checkCodexBackendAuthentication } from "./backend-authentication.js";
import { computeFileSha256 } from "./attestation.js";
import type { OperationOptions } from "@bflow/contracts";

/** Observe metadata only: no credential bytes are read or retained. Symlinks/special files and
 * inaccessible/required-missing inputs are ineligible, so the adapter runs its own normal ping. */
async function probeFileSnapshot(paths: readonly string[], required: ReadonlySet<string>, home: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  try {
    for (const path of [...new Set(paths)].sort()) {
      hash.update(path);
      try {
        const observed = await lstat(path, { bigint: true });
        if ((!observed.isFile() && !(path === home && !required.has(path) && observed.isDirectory())) || await realpath(path) !== resolve(path)) return undefined;
        hash.update([observed.dev, observed.ino, observed.mode, observed.uid, observed.gid].join(":"));
        // The provider writes unrelated logs/session state into its home during a normal ping.
        // Directory timestamps are not configuration proof; observed config files below are.
        if (observed.isFile()) {
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const opened = await handle.stat({ bigint: true });
            if (!opened.isFile() || opened.dev !== observed.dev || opened.ino !== observed.ino ||
                opened.size !== observed.size || opened.mtimeNs !== observed.mtimeNs || opened.ctimeNs !== observed.ctimeNs) return undefined;
          } finally { await handle.close(); }
          hash.update([observed.size, observed.mtimeNs, observed.ctimeNs].join(":"));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || required.has(path)) return undefined;
        hash.update("absent");
      }
    }
    return hash.digest("hex");
  } catch { return undefined; }
}

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${tomlValue(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Codex starts stdio MCP servers with a default env allow-list (HOME, PATH, ...). Parent variables outside it
 * reach a server only when named in its `env_vars`; the Bflow role MCP server needs these two (verified against codex-cli 0.162.0).
 */
export const CODEX_MCP_FORWARDED_ENV = ["HERDR_PANE_ID", "BFLOW_LAUNCH_ID"] as const;

/** Adds the forwarded env names to a stdio server (keeps existing `env_vars` first); URL servers are unchanged. */
function withForwardedMcpEnv(server: Record<string, unknown>): Record<string, unknown> {
  if (typeof server["command"] !== "string") return server;
  const existing = Array.isArray(server["env_vars"]) ? server["env_vars"].filter((name): name is string => typeof name === "string") : [];
  return { ...server, env_vars: [...new Set([...existing, ...CODEX_MCP_FORWARDED_ENV])] };
}

/** Environment-bound local bootstrap. The host UserPromptSubmit hook must block it before inference. */
export function codexStartupPrompt(environmentId: string): string {
  return `[bflow startup ${environmentId}] Initialize the local Bflow session; do not send this prompt to the model.`;
}

const MCP_NOT_ISOLATED_CODE = "codex_global_mcp_not_isolated";
/** Bare TOML keys accepted verbatim in a `-c mcp_servers.<name>.enabled=false` dotted path. */
const BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const MCP_TABLE_PATTERN = /^\s*\[\s*mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\s*(?:\.[^\]]*)?\]/gm;
const CODEX_HOOK_DIGEST_METADATA_KEY = "bflowCodexHookSnapshotDigest";
const CODEX_PRELOADED_DOC_DIGEST_METADATA_KEY = "bflowCodexPreloadedDocDigest";

function linkedBackendOverrides(url: string, hasApiKey: boolean): string[] {
  const root = url.replace(/\/+$/, "").replace(/\/backend-api\/codex$/, "").replace(/\/v1$/, "");
  const backendUrl = `${root}/backend-api/codex`;
  return [
    "-c", 'model_provider="codex-lb"',
    "-c", 'model_providers.codex-lb.name="openai"',
    "-c", `model_providers.codex-lb.base_url=${JSON.stringify(backendUrl)}`,
    "-c", 'model_providers.codex-lb.wire_api="responses"',
    "-c", "model_providers.codex-lb.supports_websockets=true",
    "-c", "model_providers.codex-lb.requires_openai_auth=false",
    "-c", 'model_providers.codex-lb.http_headers={"x-openai-actor-authorization"="codex-lb"}',
    ...(hasApiKey ? ["-c", 'model_providers.codex-lb.env_key="CODEX_LB_API_KEY"'] : [])
  ];
}

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
    if (this.options.isolatorEnvironment !== undefined) {
      const environment = { ...this.options.isolatorEnvironment };
      delete environment["CODEX_LB_API_KEY"];
      return {
        ...environment,
        BFLOW_PROVIDER: this.descriptor.provider,
        HOME: environment["HOME"] ?? "",
        PATH: environment["PATH"] ?? "",
        ORCA_AGENT_HOOK_ROOT: "",
        ORCA_AGENT_HOOK_ENDPOINT: "",
        ORCA_PANE_KEY: "",
        ORCA_AGENT_HOOK_PORT: "",
        CODEX_HOME: this.codexHome()
      };
    }

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

  private sharedNativeHookOptions(): { isolatorHomeDirectory?: string; sharedNativeCodexHomeDirectory?: string } {
    const home = this.options.isolatorEnvironment?.["HOME"];
    if (home === undefined) return {};
    return { isolatorHomeDirectory: home,
      ...(this.options.codexHomeDirectory !== undefined ? { sharedNativeCodexHomeDirectory: this.options.codexHomeDirectory } : {}) };
  }

  private trustedHookEnvironment(): Readonly<Record<string, string | undefined>> {
    if (this.options.isolatorEnvironment !== undefined) {
      const selected = this.options.isolatorEnvironment;
      const hookEnvironment = this.options.codexHookEnvironment ?? {};
      const home = selected["HOME"] ?? "";
      return {
        ...hookEnvironment,
        ...selected,
        HOME: home,
        PATH: selected["PATH"] ?? "",
        ORCA_AGENT_HOOK_ROOT: hookEnvironment["ORCA_AGENT_HOOK_ROOT"] ?? selected["ORCA_AGENT_HOOK_ROOT"] ?? "",
        ORCA_AGENT_HOOK_ENDPOINT: hookEnvironment["ORCA_AGENT_HOOK_ENDPOINT"] ?? selected["ORCA_AGENT_HOOK_ENDPOINT"] ?? "",
        ORCA_PANE_KEY: hookEnvironment["ORCA_PANE_KEY"] ?? selected["ORCA_PANE_KEY"] ?? "",
        ORCA_AGENT_HOOK_PORT: hookEnvironment["ORCA_AGENT_HOOK_PORT"] ?? selected["ORCA_AGENT_HOOK_PORT"] ?? "",
        CODEX_HOME: selected["CODEX_HOME"] ?? (home ? join(home, ".codex") : "")
      };
    }

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

  protected override getProviderExecutionEnvironment(): Readonly<Record<string, string>> {
    const environment: Record<string, string> = { ...this.getProviderCommandEnvironment() };
    if (this.options.codexBackendUrl !== undefined) {
      const key = this.options.isolatorEnvironment !== undefined
        ? this.options.isolatorEnvironment["CODEX_LB_API_KEY"]
        : process.env["CODEX_LB_API_KEY"];
      if (key) environment["CODEX_LB_API_KEY"] = key;
    }
    return environment;
  }

  protected override shouldCheckNativeAuthentication(): boolean {
    return this.options.codexBackendUrl === undefined;
  }

  protected override nativeAuthenticationOutcome(executable: string, options?: OperationOptions, _environment?: AgentEnvironment) {
    if (this.options.codexBackendUrl === undefined) return super.nativeAuthenticationOutcome(executable, options, _environment);
    const environment = this.getProviderExecutionEnvironment();
    const apiKey = this.options.isolatorEnvironment !== undefined ? environment["CODEX_LB_API_KEY"] : process.env["CODEX_LB_API_KEY"];
    return checkCodexBackendAuthentication(this.options.codexBackendUrl, apiKey, options);
  }

  protected override getProbeCommand(_environment: AgentEnvironment): readonly string[] {
    const probe = [
      ...(this.options.codexBackendUrl !== undefined
        ? linkedBackendOverrides(this.options.codexBackendUrl, Boolean(
            (this.options.isolatorEnvironment !== undefined
              ? this.options.isolatorEnvironment["CODEX_LB_API_KEY"]
              : process.env["CODEX_LB_API_KEY"])?.trim()
          ))
        : [])
    ];
    // Codex exec's own -c list replaces root overrides, so keep all config overrides before the subcommand.
    if (this.options.effort) probe.push("-c", `model_reasoning_effort=${JSON.stringify(this.options.effort)}`);
    probe.push("exec");
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
    if (this.options.isolatorEnvironment !== undefined) {
      const selected = this.options.isolatorEnvironment;
      return selected["CODEX_HOME"] ?? (selected["HOME"] ? join(selected["HOME"], ".codex") : "");
    }
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
        ...this.commandEnvironmentOptions(),
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

  private async unpinnedEnabledPlugins(home: string): Promise<string[]> {
    try {
      const text = await readFile(join(home, "config.toml"), "utf8");
      const enabled = parseCodexEnabledPlugins(text);
      const allowedSkills = new Set(
        (this.options.skillManifest?.skills ?? []).map((skill) => skill.skillId)
      );
      return enabled.filter((id) => {
        const pluginName = id.split("@")[0] ?? id;
        return !allowedSkills.has(id) && !allowedSkills.has(pluginName);
      });
    } catch {
      return [];
    }
  }

  private async computeCodexPreloadedDocDigest(
    home: string,
    environment: AgentEnvironment,
    probeConfigFiles: readonly string[]
  ): Promise<string> {
    const candidatePaths: string[] = [
      join(home, "AGENTS.md"),
      join(home, "AGENTS.override.md")
    ];
    if (environment.role !== "conversation") {
      const deps = await codexProbeConfigDependencies(probeConfigFiles);
      const fallbackNames = deps?.fallbackNames ?? [];
      const workspaceRoot = resolve(environment.scope.workspaceRoot);
      for (let directory = resolve(environment.cwd); ; directory = dirname(directory)) {
        candidatePaths.push(
          join(directory, "AGENTS.md"),
          join(directory, "AGENTS.override.md"),
          ...fallbackNames.map((name) => join(directory, name))
        );
        if (directory === workspaceRoot || dirname(directory) === directory) break;
      }
      if (deps?.requiredFiles) {
        candidatePaths.push(...deps.requiredFiles);
      }
    }
    const hash = createHash("sha256");
    hash.update(environment.role === "conversation" ? "project_docs:disabled" : "project_docs:enabled");
    for (const path of [...new Set(candidatePaths)].sort()) {
      hash.update(path);
      try {
        const info = await lstat(path);
        if (info.isFile()) {
          hash.update(await computeFileSha256(path));
        } else {
          hash.update("non_file");
        }
      } catch {
        hash.update("absent");
      }
    }
    return hash.digest("hex");
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
    const unpinnedPlugins = await this.unpinnedEnabledPlugins(home);
    const pluginArgs = managedCodexPluginArgs(unpinnedPlugins);
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
      ...this.sharedNativeHookOptions(),
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

    // A trust-all policy deliberately omits the hook inventory; there is no exact dependency
    // observation to share in that mode. Every role still performs the normal trust/drift review.
    const requiredProbeFiles = new Set([join(home, "config.toml"), join(home, "auth.json")]);
    const probeConfigFiles = [join(home, "config.toml")];
    const projectDirectories: string[] = [];
    const probeFiles = [...requiredProbeFiles, home, hookReview.approvalStorePath,
      codexHookPolicyPath(hookReview.approvalStorePath), join(home, "hooks.json"),
      join(home, "AGENTS.md"), join(home, "AGENTS.override.md"),
      ...hookReview.sources.map(source => source.path),
      ...hookReview.hooks.flatMap(hook => hook.dependencies.flatMap(dependency =>
        dependency.resolvedPath === null ? [dependency.requestedPath] : [dependency.requestedPath, dependency.resolvedPath]))];
    // Codex may discover repository configuration and instructions from any cwd ancestor.
    for (let directory = resolve(_environment.cwd); ; directory = dirname(directory)) {
      projectDirectories.push(directory);
      probeConfigFiles.push(join(directory, ".codex", "config.toml"));
      probeFiles.push(join(directory, ".codex", "config.toml"), join(directory, "AGENTS.md"), join(directory, "AGENTS.override.md"));
      if (dirname(directory) === directory) break;
    }

    const preloadedDocDigest = await this.computeCodexPreloadedDocDigest(home, _environment, probeConfigFiles);
    const settingsMetadata = {
      [CODEX_HOOK_DIGEST_METADATA_KEY]: hookReview.digest,
      [CODEX_PRELOADED_DOC_DIGEST_METADATA_KEY]: preloadedDocDigest
    };
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
        if (
          settings[CODEX_PRELOADED_DOC_DIGEST_METADATA_KEY] !== undefined &&
          settings[CODEX_PRELOADED_DOC_DIGEST_METADATA_KEY] !== preloadedDocDigest
        ) {
          throw new Error("Codex preloaded instruction documents changed after the prepared launch profile");
        }
      } catch (error) {
        hookFailure = {
          code: "codex_global_hooks_snapshot_drift",
          message: `Prepared Codex hook snapshot cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
          remediation: "Prepare a new launch and re-run provider activation after the exact hook inventory is approved."
        };
      }
    }
    const executionProbeSnapshot = hookReview.approvalMode === "trust_all" ? undefined : async () => {
      const beforeConfigRead = await probeFileSnapshot(probeFiles, requiredProbeFiles, home);
      if (beforeConfigRead === undefined) return undefined;
      const dependencies = await codexProbeConfigDependencies(probeConfigFiles);
      if (dependencies === undefined) return undefined;
      const allProbeFiles = [...probeFiles, ...dependencies.requiredFiles,
        ...projectDirectories.flatMap(directory => dependencies.fallbackNames.map(name => join(directory, name)))];
      const allRequiredFiles = new Set([...requiredProbeFiles, ...dependencies.requiredFiles]);
      const files = await probeFileSnapshot(allProbeFiles, allRequiredFiles, home);
      if (files === undefined || await probeFileSnapshot(probeFiles, requiredProbeFiles, home) !== beforeConfigRead) return undefined;
      const currentHooks = await inspectCodexHooks({ codexHomeDirectory: home,
        ...this.sharedNativeHookOptions(),
        ...(this.options.codexHookApprovalPath !== undefined ? { approvalStorePath: this.options.codexHookApprovalPath } : {}),
        environment: this.trustedHookEnvironment() });
      if (currentHooks.digest !== hookReview.digest || currentHooks.status !== hookReview.status ||
          currentHooks.approvalMode !== hookReview.approvalMode ||
          await probeFileSnapshot(allProbeFiles, allRequiredFiles, home) !== files) return undefined;
      return createHash("sha256").update(hookReview.digest).update(files).digest("hex");
    };

    return {
      argv,
      ...(executionProbeSnapshot !== undefined ? { executionProbeSnapshot } : {}),
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
        mcpServerNames: Object.keys(this.resolveHostLaunchMaterial(capabilities).mcpServers),
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
      ...(this.options.codexBackendUrl !== undefined
        ? linkedBackendOverrides(this.options.codexBackendUrl, Boolean(
            (this.options.isolatorEnvironment !== undefined
              ? this.options.isolatorEnvironment["CODEX_LB_API_KEY"]
              : process.env["CODEX_LB_API_KEY"])?.trim()
          ))
        : []),
      "-c",
      `model_instructions_file=${JSON.stringify(configFiles.promptFile)}`,
      ...(environment.role === "conversation" ? ["-c", "project_doc_max_bytes=0"] : [])
    ];

    try {
      const mcpContent = await readFile(configFiles.mcpConfigFile, "utf8");
      const mcpParsed = JSON.parse(mcpContent) as { mcpServers?: Record<string, unknown> };
      if (mcpParsed.mcpServers && Object.keys(mcpParsed.mcpServers).length > 0) {
        // `--ask-for-approval never` auto-rejects every MCP call Codex would prompt for ("MCP tool call
        // requires approval, but approval policy is never"), so the trusted host/Gateway servers are
        // pre-approved like Claude's `--allowedTools mcp__<server>__*`; the host still guards each call.
        const approved = Object.fromEntries(Object.entries(mcpParsed.mcpServers).map(([name, server]) =>
          [name, { ...withForwardedMcpEnv(server as Record<string, unknown>), default_tools_approval_mode: "approve" }]));
        argv.push("-c", `mcp_servers=${tomlValue(approved)}`);
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

    // No bootstrap may reach a model when there is no host hook to consume it.
    if (this.options.hostHooks?.UserPromptSubmit !== undefined) argv.push(codexStartupPrompt(environment.environmentId));

    return { argv };
  }
}
