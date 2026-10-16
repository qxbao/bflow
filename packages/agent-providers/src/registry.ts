import {
  type AgentEnvironment,
  AgentEnvironmentSchema,
  type AgentHealthRequest,
  AgentHealthRequestSchema,
  type AgentHealthResult,
  type AgentLaunchProfile,
  type AgentProviderAdapter,
  type AgentProviderDescriptor,
  type AgentProviderId,
  type OperationOptions,
  type OperationResult
} from "@bflow/contracts";
import { AgyProviderAdapter } from "./agy-adapter.js";
import { ClaudeProviderAdapter } from "./claude-adapter.js";
import { CodexProviderAdapter } from "./codex-adapter.js";
import type { ProviderAdapterOptions } from "./types.js";

export class AgentProviderRegistry {
  private readonly adapters = new Map<AgentProviderId, AgentProviderAdapter>();

  register(adapter: AgentProviderAdapter): void {
    this.adapters.set(adapter.descriptor.provider, adapter);
  }

  get(provider: AgentProviderId): AgentProviderAdapter | undefined {
    return this.adapters.get(provider);
  }

  has(provider: AgentProviderId): boolean {
    return this.adapters.has(provider);
  }

  listDescriptors(): readonly AgentProviderDescriptor[] {
    return Array.from(this.adapters.values()).map((a) => a.descriptor);
  }

  async checkHealth(
    request: AgentHealthRequest,
    options?: OperationOptions
  ): Promise<OperationResult<AgentHealthResult>> {
    const rawVersion = (request as unknown as { schemaVersion?: unknown }).schemaVersion;
    if (rawVersion !== 3) {
      return {
        ok: false,
        error: {
          code: "unsupported_version",
          retryable: false,
          supportedVersions: [3],
          receivedVersion: typeof rawVersion === "number" ? rawVersion : 0,
          message: `Unsupported schema version: ${String(rawVersion)}`
        }
      };
    }

    const parsedRequest = AgentHealthRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Health request failed schema validation: ${parsedRequest.error.message}`
        }
      };
    }

    const providerId = parsedRequest.data.environment.provider;
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      return {
        ok: false,
        error: {
          code: "not_found",
          retryable: false,
          message: `Provider '${providerId}' is not registered`
        }
      };
    }

    return adapter.checkHealth(parsedRequest.data, options);
  }

  async prepareLaunch(
    environment: AgentEnvironment,
    options?: OperationOptions
  ): Promise<OperationResult<AgentLaunchProfile>> {
    const rawVersion = (environment as unknown as { schemaVersion?: unknown }).schemaVersion;
    if (rawVersion !== 3) {
      return {
        ok: false,
        error: {
          code: "unsupported_version",
          retryable: false,
          supportedVersions: [3],
          receivedVersion: typeof rawVersion === "number" ? rawVersion : 0,
          message: `Unsupported schema version: ${String(rawVersion)}`
        }
      };
    }

    const parsedEnv = AgentEnvironmentSchema.safeParse(environment);
    if (!parsedEnv.success) {
      return {
        ok: false,
        error: {
          code: "validation",
          retryable: false,
          message: `Environment failed schema validation: ${parsedEnv.error.message}`
        }
      };
    }

    const providerId = parsedEnv.data.provider;
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      return {
        ok: false,
        error: {
          code: "not_found",
          retryable: false,
          message: `Provider '${providerId}' is not registered`
        }
      };
    }

    return adapter.prepareLaunch(parsedEnv.data, options);
  }
}

export function createDefaultProviderRegistry(options?: {
  readonly claude?: ProviderAdapterOptions;
  readonly codex?: ProviderAdapterOptions;
  readonly agy?: ProviderAdapterOptions;
}): AgentProviderRegistry {
  const registry = new AgentProviderRegistry();
  registry.register(new ClaudeProviderAdapter(options?.claude));
  registry.register(new CodexProviderAdapter(options?.codex));
  registry.register(new AgyProviderAdapter(options?.agy));
  return registry;
}
