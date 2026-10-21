import type {
  AgentEnvironment,
  AgentProviderDescriptor
} from "@bflow/contracts";
import { BaseProviderAdapter } from "./base-adapter.js";
import { compileProviderPermissions, hostLaunchPermissionOptions } from "./permissions.js";
import type {
  DetectedProviderCapabilities,
  ProviderAdapterOptions
} from "./types.js";

export class ClaudeProviderAdapter extends BaseProviderAdapter {
  readonly descriptor: AgentProviderDescriptor = {
    schemaVersion: 3,
    provider: "claude",
    adapterVersion: "0.1.0",
    executableName: "claude",
    capabilities: [
      {
        id: "claude-implementation",
        name: "Claude Code Implementation",
        category: "implementation",
        description: "Full software implementation, testing, and file editing under workspace permissions.",
        readOnly: false
      },
      {
        id: "claude-review",
        name: "Claude Code Review",
        category: "review",
        description: "Read-only code and artifact review under restricted permissions.",
        readOnly: true
      },
      {
        id: "claude-conversation",
        name: "Claude Code Conversation",
        category: "conversation",
        description: "Interactive conversation and clarification gateway.",
        readOnly: true
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
    return ["auth", "status", "--json"];
  }

  protected override getProbeCommand(_environment: AgentEnvironment): readonly string[] {
    const probe = ["--print", "--permission-mode", "dontAsk"];
    if (this.options.model) {
      probe.push("--model", this.options.model);
    }
    if (this.options.effort) probe.push("--effort", this.options.effort);
    probe.push("ping");
    return probe;
  }

  protected override renderStreamableHttpMcpServer(
    endpoint: string,
    tokenEnvironmentName: string
  ): Record<string, unknown> {
    // Claude expands ${VAR} in MCP config headers at launch; the config file holds only the variable name.
    return {
      type: "http",
      url: endpoint,
      headers: { Authorization: `Bearer \${${tokenEnvironmentName}}` }
    };
  }

  protected override async compileArgv(
    environment: AgentEnvironment,
    configFiles: { promptFile: string; mcpConfigFile: string; settingsFile: string },
    capabilities: DetectedProviderCapabilities
  ): Promise<{ readonly argv: readonly string[]; readonly unsupportedCode?: string; readonly unsupportedMessage?: string }> {
    const permResult = await compileProviderPermissions(
      "claude",
      environment.permissionProfile,
      environment.role,
      capabilities,
      {
        cwd: environment.cwd,
        ...hostLaunchPermissionOptions(this.resolveHostLaunchMaterial(capabilities)),
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

    const requiredLaunchFlags = [
      "--settings",
      "--mcp-config",
      "--append-system-prompt-file",
      ...(this.options.model ? ["--model"] : []),
      ...(this.options.effort ? ["--effort"] : [])
    ];
    const missingLaunchFlags = requiredLaunchFlags.filter(
      (flag) => !capabilities.supportedFlags.has(flag)
    );
    if (missingLaunchFlags.length > 0) {
      return {
        argv: [],
        unsupportedCode: "invalid_flag",
        unsupportedMessage: `Claude CLI is missing required launch flags: ${missingLaunchFlags.join(", ")}`
      };
    }

    const argv: string[] = [
      ...permResult.flags,
      "--settings",
      configFiles.settingsFile,
      "--mcp-config",
      configFiles.mcpConfigFile,
      "--append-system-prompt-file",
      configFiles.promptFile
    ];

    if (this.options.model) {
      argv.push("--model", this.options.model);
    }
    if (this.options.effort) argv.push("--effort", this.options.effort);

    return { argv };
  }
}
