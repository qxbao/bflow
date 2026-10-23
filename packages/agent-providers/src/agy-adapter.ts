import type {
  AgentEnvironment,
  AgentProviderDescriptor
} from "@bflow/contracts";
import { SafeArgumentSchema } from "@bflow/contracts";
import { isAbsolute } from "node:path";
import { BaseProviderAdapter } from "./base-adapter.js";
import type { ResolvedLaunchMaterial } from "./launch-material.js";
import { compileProviderPermissions } from "./permissions.js";
import type {
  DetectedProviderCapabilities,
  HostHookEvent,
  ProviderAdapterOptions
} from "./types.js";

export class AgyProviderAdapter extends BaseProviderAdapter {
  readonly descriptor: AgentProviderDescriptor = {
    schemaVersion: 3,
    provider: "agy",
    adapterVersion: "0.1.0",
    executableName: "agy",
    capabilities: [
      {
        id: "agy-implementation",
        name: "Antigravity CLI Implementation",
        category: "implementation",
        description: "Software implementation and editing under sandbox boundary.",
        readOnly: false
      },
      {
        id: "agy-review",
        name: "Antigravity CLI Review",
        category: "review",
        description: "Read-only inspection and analysis under plan mode.",
        readOnly: true
      }
    ],
    mcpTransports: ["stdio", "streamable_http"],
    supportsUnattended: false,
    supportsNativeBinding: false
  };

  constructor(options?: ProviderAdapterOptions) {
    super(options);
  }

  protected override getAuthCommand(): readonly string[] {
    return ["models"];
  }

  protected override getProbeCommand(_environment: AgentEnvironment): readonly string[] {
    const probe: string[] = [];
    if (this.options.model) {
      probe.push("--model", this.options.model);
    }
    probe.push("--print", "ping");
    return probe;
  }

  protected override supportsMcpConfigFile(_capabilities: DetectedProviderCapabilities): boolean {
    // Agy discovers mcp_config.json under the process HOME; it has no --mcp-config flag.
    return true;
  }

  protected override renderStreamableHttpMcpServer(endpoint: string, tokenEnvironmentName: string): Record<string, unknown> | undefined {
    const shim = this.options.agyGatewayShimCommand;
    const registration = this.options.mcpRegistrations?.find(item =>
      item.connection.transport === "streamable_http" && item.connection.endpoint === endpoint &&
      this.options.mcpTokenEnvironmentNames?.[item.registrationId] === tokenEnvironmentName);
    if (!shim || !registration || !isAbsolute(shim.command)) return undefined;
    const args = [
      ...shim.args,
      endpoint,
      registration.registrationId,
      tokenEnvironmentName,
      JSON.stringify(registration.serviceIds)
    ];
    if (args.some(argument => !SafeArgumentSchema.safeParse(argument).success)) return undefined;
    const requiredTokens = new Set(Object.values(this.options.mcpTokenEnvironmentNames ?? {}));
    const clearedEnvironment = Object.fromEntries(Object.keys(this.options.isolatorEnvironment ?? {})
      .filter(name => /^[A-Z_][A-Z0-9_]*$/.test(name) && /TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|NODE_OPTIONS|LD_PRELOAD|PYTHONPATH/.test(name) && !requiredTokens.has(name))
      .map(name => [name, ""]));
    return { command: shim.command, args, ...(Object.keys(clearedEnvironment).length ? { env: clearedEnvironment } : {}) };
  }

  protected override resolveHostLaunchMaterial(capabilities: DetectedProviderCapabilities): ResolvedLaunchMaterial {
    if (this.options.hostHooks?.UserPromptSubmit !== undefined) {
      return {
        mcpServers: {},
        hooks: {},
        failure: {
          kind: "unsupported",
          code: "native_hooks_unsupported",
          message: "Agy does not provide a physical UserPromptSubmit event; Conversation Agy cannot establish trusted human input"
        }
      };
    }
    const resolved = super.resolveHostLaunchMaterial(capabilities);
    if (resolved.failure) return resolved;
    const hooks: Partial<Record<HostHookEvent, readonly unknown[]>> = {};
    const flatHandlers = (event: HostHookEvent): unknown[] => (resolved.hooks[event] ?? []).flatMap(value => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
      const group = value as { hooks?: unknown };
      return Array.isArray(group.hooks) ? group.hooks : [];
    });
    const sessionStart = flatHandlers("SessionStart");
    if (sessionStart.length) hooks.SessionStart = sessionStart;
    const stop = flatHandlers("Stop");
    if (stop.length) hooks.Stop = stop;
    const preToolUse = flatHandlers("PreToolUse");
    if (preToolUse.length) hooks.PreToolUse = [{ matcher: ".*", hooks: preToolUse }];
    return { ...resolved, hooks };
  }

  protected override async compileArgv(
    environment: AgentEnvironment,
    configFiles: { promptFile: string; mcpConfigFile: string; settingsFile: string },
    capabilities: DetectedProviderCapabilities
  ): Promise<{ readonly argv: readonly string[]; readonly unsupportedCode?: string; readonly unsupportedMessage?: string }> {
    const permResult = await compileProviderPermissions(
      "agy",
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

    const argv: string[] = [...permResult.flags];

    if (capabilities.supportedFlags.has("--mcp-config")) {
      argv.push("--mcp-config", configFiles.mcpConfigFile);
    }

    if (this.options.model) {
      if (!capabilities.supportedFlags.has("--model")) {
        return {
          argv: [],
          unsupportedCode: "invalid_flag",
          unsupportedMessage: "Antigravity CLI does not support --model flag"
        };
      }
      argv.push("--model", this.options.model);
    }

    return { argv };
  }
}
