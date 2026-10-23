import { isAbsolute } from "node:path";
import { SafeArgumentSchema } from "@bflow/contracts";
import type { HostHookEvent, ProviderAdapterOptions } from "./types.js";

export const HOST_HOOK_EVENTS: readonly HostHookEvent[] = ["SessionStart", "UserPromptSubmit", "Stop", "PreToolUse", "PreInvocation"];

const HOST_SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const TOKEN_ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const HOST_HOOK_TIMEOUT_SECONDS = 30;
const LEGACY_SESSION_HOOK_TIMEOUT_SECONDS = 10;

/** Renders one streamable_http MCP server entry in the provider's own config shape, or undefined when unsupported. */
export type StreamableHttpServerRenderer = (endpoint: string, tokenEnvironmentName: string) => Record<string, unknown> | undefined;

export interface LaunchMaterialFailure {
  /** `invalid` = malformed input (validation); `unsupported` = provider cannot honor the requested material. */
  readonly kind: "invalid" | "unsupported";
  /** Health check code, also used as the launch_arguments failure code. */
  readonly code: string;
  readonly message: string;
}

export interface ResolvedLaunchMaterial {
  /** Entries for the `mcpServers` map of the written MCP config file. Contains no secret values. */
  readonly mcpServers: Readonly<Record<string, Record<string, unknown>>>;
  /** Settings `hooks` object; empty when no hook is requested or the provider has no native hooks. */
  readonly hooks: Readonly<Partial<Record<HostHookEvent, readonly unknown[]>>>;
  readonly failure?: LaunchMaterialFailure;
}

export interface LaunchMaterialInput {
  readonly options: ProviderAdapterOptions;
  readonly supportsNativeHooks: boolean;
  readonly supportsMcpConfigFile: boolean;
  readonly supportedHostHookEvents?: readonly HostHookEvent[];
  readonly renderStreamableHttpServer: StreamableHttpServerRenderer;
}

function invalid(code: string, message: string): ResolvedLaunchMaterial {
  return { mcpServers: {}, hooks: {}, failure: { kind: "invalid", code, message } };
}

function unsupported(code: string, message: string): ResolvedLaunchMaterial {
  return { mcpServers: {}, hooks: {}, failure: { kind: "unsupported", code, message } };
}

/**
 * Single source of truth for the MCP servers and native hooks written into a launch. prepareLaunch
 * writes exactly this material and activated/preflight health validates the same inputs, so the two
 * cannot drift. Token values are never read here: only environment variable names are rendered.
 */
export function resolveLaunchMaterial(input: LaunchMaterialInput): ResolvedLaunchMaterial {
  const { options, supportsNativeHooks } = input;
  const hostServers = options.hostMcpServers ?? {};
  const registrations = options.mcpRegistrations ?? [];
  const mcpServers: Record<string, Record<string, unknown>> = {};

  for (const [name, server] of Object.entries(hostServers)) {
    if (!HOST_SERVER_NAME_PATTERN.test(name)) {
      return invalid("launch_arguments_invalid", `Host MCP server name '${name}' must match ${HOST_SERVER_NAME_PATTERN.source}`);
    }
    if (!isAbsolute(server.command)) {
      return invalid("launch_arguments_invalid", `Host MCP server '${name}' command must be an absolute path`);
    }
    for (const [index, arg] of server.args.entries()) {
      if (!SafeArgumentSchema.safeParse(arg).success) {
        return invalid("launch_arguments_invalid", `Host MCP server '${name}' argument ${index} is not a safe argument`);
      }
    }
    mcpServers[name] = { command: server.command, args: [...server.args] };
  }

  for (const registration of registrations) {
    const id = registration.registrationId;
    if (Object.prototype.hasOwnProperty.call(hostServers, id)) {
      return invalid("launch_arguments_invalid", `MCP registration '${id}' collides with a Bflow host MCP server of the same name`);
    }
    if (registration.connection.transport === "stdio") {
      mcpServers[id] = { command: registration.connection.executable, args: registration.connection.argv };
      continue;
    }
    const tokenEnvironmentName = options.mcpTokenEnvironmentNames?.[id];
    if (tokenEnvironmentName === undefined) {
      return invalid(
        "mcp_token_environment_missing",
        `streamable_http MCP registration '${id}' has no token environment variable mapping`
      );
    }
    if (!TOKEN_ENVIRONMENT_NAME_PATTERN.test(tokenEnvironmentName)) {
      return invalid(
        "mcp_token_environment_missing",
        `Token environment variable name for MCP registration '${id}' must match ${TOKEN_ENVIRONMENT_NAME_PATTERN.source}`
      );
    }
    const rendered = input.renderStreamableHttpServer(registration.connection.endpoint, tokenEnvironmentName);
    if (rendered === undefined) {
      return unsupported(
        "mcp_transport_unsupported",
        `Provider cannot render streamable_http MCP registration '${id}' with an environment-referenced bearer token`
      );
    }
    mcpServers[id] = rendered;
  }

  if (Object.keys(mcpServers).length > 0 && !input.supportsMcpConfigFile) {
    return unsupported(
      "invalid_flag",
      "Provider CLI does not support --mcp-config, so Bflow MCP servers cannot be delivered to the launched process"
    );
  }

  const hooks: Partial<Record<HostHookEvent, readonly unknown[]>> = {};
  const supportedEvents = new Set(input.supportedHostHookEvents ?? HOST_HOOK_EVENTS.filter(event => event !== "PreInvocation"));
  const unsupportedRequested = HOST_HOOK_EVENTS.filter(event => options.hostHooks?.[event] !== undefined && !supportedEvents.has(event));
  if (unsupportedRequested.length > 0) return unsupported("native_hooks_unsupported", `Provider does not support native hooks required for ${unsupportedRequested.join(", ")}`);
  const requestedHostHooks = HOST_HOOK_EVENTS.filter((event) => options.hostHooks?.[event] !== undefined);
  if (requestedHostHooks.length > 0 && !supportsNativeHooks) {
    return unsupported(
      "native_hooks_unsupported",
      `Provider does not support native hooks required for ${requestedHostHooks.join(", ")}`
    );
  }
  for (const event of requestedHostHooks) {
    const command = options.hostHooks?.[event] ?? "";
    if (command.trim().length === 0) {
      return invalid("launch_arguments_invalid", `Host hook command for ${event} must not be empty`);
    }
    hooks[event] = [{ hooks: [{ type: "command", command, timeout: HOST_HOOK_TIMEOUT_SECONDS }] }];
  }

  const legacyCommand = options.nativeSessionHookCommand;
  if (hooks.SessionStart === undefined && legacyCommand && supportsNativeHooks) {
    hooks.SessionStart = [{ hooks: [{ type: "command", command: legacyCommand, timeout: LEGACY_SESSION_HOOK_TIMEOUT_SECONDS }] }];
  }

  return { mcpServers, hooks };
}
