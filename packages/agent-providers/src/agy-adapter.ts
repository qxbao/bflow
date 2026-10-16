import type {
  AgentEnvironment,
  AgentProviderDescriptor
} from "@bflow/contracts";
import { BaseProviderAdapter } from "./base-adapter.js";
import { compileProviderPermissions } from "./permissions.js";
import type {
  DetectedProviderCapabilities,
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
    const probe = ["--print"];
    if (this.options.model) {
      probe.push("--model", this.options.model);
    }
    probe.push("ping");
    return probe;
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
