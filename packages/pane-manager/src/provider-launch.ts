import { getRoleTopologySpec, type RoleSelector } from "./types.js";

export interface RoleMcpServer {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}
export interface ProviderRoleLaunchOptions {
  readonly agentKind: "claude" | "codex";
  readonly role: RoleSelector;
  readonly systemPrompt: string;
  readonly model?: string;
  /** Operator-owned stdio servers, never a command supplied by an agent/repository. */
  readonly mcpServers?: Readonly<Record<string, RoleMcpServer>>;
  /** Already vetted, launch-local native SessionStart command. Does not install global hooks. */
  readonly nativeSessionHookCommand?: string;
}

function toml(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Explicit opt-in policy for locally verified Claude/Codex CLI flags. Other kinds keep their own configuration. */
export function buildProviderRoleLaunch(options: ProviderRoleLaunchOptions): readonly string[] {
  const spec = getRoleTopologySpec(options.role);
  if (!spec) throw new Error(`Unsupported Bflow role: ${options.role}`);
  if (!options.systemPrompt.trim()) throw new Error("Role system prompt is required");
  if (options.agentKind !== "claude" && options.agentKind !== "codex") throw new Error("Provider launch policy supports Claude and Codex only");
  const servers = options.mcpServers ?? {};
  for (const [name, server] of Object.entries(servers)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name) || !server.command || server.command.includes("\0"))
      throw new Error("Invalid operator MCP server configuration");
  }
  const hook = options.nativeSessionHookCommand;
  if (hook?.includes("\0")) throw new Error("Native session hook cannot contain NUL");
  if (options.agentKind === "claude") {
    const settings = hook ? { hooks: { SessionStart: [{ hooks: [{ type: "command", command: hook, timeout: 10 }] }] } } : {};
    const tools = spec.readOnlyWorkspace ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write,Bash";
    return ["--restricted", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands",
      "--permission-mode", "dontAsk", "--tools", tools,
      "--allowedTools", [tools, ...Object.keys(servers).map(name => `mcp__${name}__*`)].join(","),
      "--settings", JSON.stringify(settings), "--mcp-config", JSON.stringify({ mcpServers: servers }),
      "--append-system-prompt", options.systemPrompt,
      ...(options.model ? ["--model", options.model] : [])];
  }
  const args = ["--no-daemon", "--sandbox", spec.readOnlyWorkspace ? "read-only" : "workspace-write",
    "--ask-for-approval", "never", "-c", `developer_instructions=${JSON.stringify(options.systemPrompt)}`,
    "-c", "web_search=\"disabled\"", "-c", `mcp_servers=${toml(servers)}`];
  if (hook) args.push("--enable", "hooks", "--dangerously-bypass-hook-trust", "-c",
    `hooks.SessionStart=${toml([{ hooks: [{ type: "command", command: hook, timeout: 10 }] }])}`);
  if (options.model) args.push("--model", options.model);
  return args;
}
