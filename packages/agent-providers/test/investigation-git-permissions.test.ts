import { describe, expect, it } from "vitest";
import { CURRENT_PLATFORM_SCHEMA_VERSION, type AgentRole, type PermissionProfile } from "@bflow/contracts";
import { compileProviderPermissions, hostLaunchPermissionOptions } from "../src/permissions.js";
import type { DetectedProviderCapabilities } from "../src/types.js";

const cwd = "/work/repo";
const profile: PermissionProfile = {
  schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION, profileId: "perm-claude-restricted", mode: "restricted",
  scope: { kind: "session", machineId: "mach-1", repositoryId: "repo-1", workspaceRoot: cwd, sessionId: "sess-1" },
  filesystem: "read_only", readableRoots: [cwd], writableRoots: [], deniedRoots: [], isolation: "provider_policy",
  network: { mode: "deny", allowedHosts: [] }, allowedTools: ["Read"], deniedAction: "request_via_conversation",
  allowGlobalPermissionBypass: false
};
const capabilities = {
  version: "2.1.0", rawVersionOutput: "2.1.0 (Claude Code)",
  supportedFlags: new Set(["--restricted", "--strict-mcp-config", "--setting-sources", "--disable-slash-commands", "--permission-mode",
    "--tools", "--allowedTools", "--disallowedTools", "--add-dir"]),
  supportedSubcommands: new Set<string>(), supportsMcpStdio: true, supportsMcpHttp: true, supportsSkills: true, supportsWorkspaceTrust: true,
  supportsDangerouslySkipPermissions: true, supportsSandboxFlag: false, supportsApprovalPolicyFlag: false, supportsAddDirFlag: true,
  supportsNativeHooks: true, supportsUnattendedMode: false
} as DetectedProviderCapabilities;
const flag = (flags: readonly string[], name: string) => flags[flags.indexOf(name) + 1]!;

describe("Claude permissions for read-only investigation roles", () => {
  it("adds Bash limited to git read patterns for an investigation role", async () => {
    const result = await compileProviderPermissions("claude", profile, "reviewer", capabilities, { cwd, mcpServerNames: ["bflow"] });
    expect(result.supported).toBe(true);
    expect(flag(result.flags, "--tools")).toBe("Read,Glob,Grep,Bash");
    const allowed = flag(result.flags, "--allowedTools").split(",");
    expect(allowed.filter(tool => tool.startsWith("Bash"))).toEqual(["log", "show", "diff", "status", "branch"].map(command => `Bash(git ${command}:*)`));
    expect(allowed).not.toContain("Bash");
  });
  it.each<AgentRole>(["coordinator", "planner", "specifier", "architect", "developer", "reviewer", "qa", "tester"])(
    "gives %s Bash through the host PreToolUse guard", async role => {
    const result = await compileProviderPermissions("claude", profile, role, capabilities, { cwd, mcpServerNames: ["bflow"], hostToolGuard: true });
    expect(flag(result.flags, "--tools").split(",")).toContain("Bash");
    const allowed = flag(result.flags, "--allowedTools").split(",");
    expect(allowed).toContain("Bash");
    expect(allowed.filter(tool => tool.startsWith("Bash("))).toEqual([]);
    expect(result.allowedTools).toContain("Bash");
    expect(flag(result.flags, "--permission-mode")).toBe("dontAsk");
  });
  it("never gives Conversation Bash, even with the host guard", async () => {
    const result = await compileProviderPermissions("claude", profile, "conversation", capabilities, { cwd, mcpServerNames: ["bflow"], hostToolGuard: true });
    expect(flag(result.flags, "--tools")).toBe("");
    expect(flag(result.flags, "--allowedTools")).not.toContain("Bash");
  });
  it("derives the guard from launch material that installs PreToolUse", () => {
    expect(hostLaunchPermissionOptions({ mcpServers: { bflow: {} }, hooks: { PreToolUse: [{}] } })).toEqual({ mcpServerNames: ["bflow"], hostToolGuard: true });
    expect(hostLaunchPermissionOptions({ mcpServers: {}, hooks: { SessionStart: [{}] } })).toEqual({ mcpServerNames: [], hostToolGuard: false });
  });
  it.each<AgentRole>(["tester", "developer", "conversation", "coordinator"])("gives %s no Bash without the host guard", async role => {
    const result = await compileProviderPermissions("claude", profile, role, capabilities, { cwd });
    expect(flag(result.flags, "--tools")).not.toContain("Bash");
    expect(flag(result.flags, "--allowedTools")).not.toContain("Bash");
  });
});
