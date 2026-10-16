import { readFile } from "node:fs/promises";
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

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${tomlValue(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

  protected override async compileArgv(
    environment: AgentEnvironment,
    configFiles: { promptFile: string; mcpConfigFile: string; settingsFile: string },
    capabilities: DetectedProviderCapabilities
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
