import { describe, expect, it } from "vitest";
import { buildProviderRoleLaunch } from "../src/provider-launch.js";

describe("explicit provider role launch policy", () => {
  const server = { bflow: { command: "/trusted/node", args: ["/trusted/role-host.mjs", "--role", "conversation"] } };
  it("confines Claude read-only roles to read tools and per-launch trusted MCP/settings", () => {
    const args = buildProviderRoleLaunch({ agentKind: "claude", role: "conversation", systemPrompt: "Conversation only.",
      mcpServers: server, nativeSessionHookCommand: "/trusted/session-hook" });
    expect(args).toContain("--restricted");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("mcp__bflow__*");
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!)).toEqual({ mcpServers: server });
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toMatchObject({ hooks: { SessionStart: [{ hooks: [{ command: "/trusted/session-hook" }] }] } });
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
  it("selects Codex read-only or workspace-write sandbox with no interactive approval bypass", () => {
    for (const [role, sandbox] of [["coordinator", "read-only"], ["developer", "workspace-write"]] as const) {
      const args = buildProviderRoleLaunch({ agentKind: "codex", role, systemPrompt: "Bounded role.", mcpServers: server,
        nativeSessionHookCommand: "/trusted/session-hook" });
      expect(args[args.indexOf("--sandbox") + 1]).toBe(sandbox);
      expect(args[args.indexOf("--ask-for-approval") + 1]).toBe("never");
      expect(args).toContain("--no-daemon");
      expect(args).toContain('developer_instructions="Bounded role."');
      expect(args.find(a => a.startsWith("hooks.SessionStart="))).toContain('/trusted/session-hook');
      expect(args.find(a => a.startsWith("mcp_servers="))).toContain('/trusted/role-host.mjs');
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    }
  });
  it("gives Claude Developer write tools only when requested as Developer", () => {
    const args = buildProviderRoleLaunch({ agentKind: "claude", role: "developer", systemPrompt: "Implement scoped work." });
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Edit,Write,Bash");
  });
  it("rejects unsupported provider policy rather than silently configuring another provider", () => {
    expect(() => buildProviderRoleLaunch({ agentKind: "other" as "codex", role: "reviewer", systemPrompt: "Review" })).toThrow();
    expect(() => buildProviderRoleLaunch({ agentKind: "claude", role: "reviewer", systemPrompt: "" })).toThrow();
  });
});
