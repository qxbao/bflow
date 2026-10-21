import { stat } from "node:fs/promises";
import type {
  AgentRole,
  PermissionProfile
} from "@bflow/contracts";
import type { DetectedProviderCapabilities } from "./types.js";

/** Roles that investigate read-only and may run the git reads below (mirrors the Runtime host guard). */
const INVESTIGATION_ROLES: ReadonlySet<string> = new Set(["planner", "specifier", "architect", "reviewer", "qa"]);
const READ_ONLY_GIT_PATTERNS = ["log", "show", "diff", "status", "branch"].map(command => `Bash(git ${command}:*)`);

export interface CompiledPermissionResult {
  readonly supported: boolean;
  readonly code: string;
  readonly message: string;
  readonly remediation?: string;
  readonly flags: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly detectsDangerouslySkipPermissions: boolean;
  readonly settingsPermissionsAllow?: readonly string[];
  readonly settingsPermissionsDeny?: readonly string[];
  readonly workspaceTrusted?: boolean;
}

export interface PermissionCompilerOptions {
  readonly cwd: string;
  readonly mcpServerNames?: readonly string[];
  readonly osSandboxPath?: string;
  /**
   * True only when the launch installs the Bflow host PreToolUse hook. Claude then gets `Bash` for every role except
   * Conversation: the hook's deny takes precedence over allow rules, so the host's tokenized allowlist is the single gate.
   */
  readonly hostToolGuard?: boolean;
}

/** Permission options derived from resolved host launch material (MCP server names and the PreToolUse guard hook). */
export function hostLaunchPermissionOptions(material: {
  readonly mcpServers: Readonly<Record<string, unknown>>;
  readonly hooks: Readonly<Partial<Record<string, unknown>>>;
}): Pick<PermissionCompilerOptions, "mcpServerNames" | "hostToolGuard"> {
  return { mcpServerNames: Object.keys(material.mcpServers), hostToolGuard: material.hooks["PreToolUse"] !== undefined };
}

const PROTECTED_PATHS = [
  "./.bflow/**",
  "./.git/**",
  "~/.claude/**",
  "~/.codex/**",
  "~/.gemini/**",
  "~/.ssh/**",
  "~/.aws/**",
  "~/.config/**"
] as const;

export async function verifyUnattendedIsolation(
  profile: PermissionProfile,
  capabilities: DetectedProviderCapabilities,
  provider: "claude" | "codex" | "agy",
  options?: PermissionCompilerOptions
): Promise<{ readonly supported: boolean; readonly code: string; readonly message: string; readonly remediation?: string }> {
  if (provider === "agy") {
    return {
      supported: false,
      code: "agy_unattended_unsupported",
      message: "Agy unattended isolation and native session binding are not yet certified",
      remediation: "Use Claude or Codex for unattended execution or run in workspace_auto mode."
    };
  }

  if (!capabilities.supportsUnattendedMode) {
    return {
      supported: false,
      code: "unattended_isolation_unsupported",
      message: `Provider '${provider}' does not support unattended mode`,
      remediation: "Configure a provider with verified unattended capabilities."
    };
  }

  if (profile.isolation === "os_sandbox") {
    const sandboxPath = options?.osSandboxPath ?? "/usr/bin/bwrap";
    try {
      const sandboxStat = await stat(sandboxPath);
      if (!sandboxStat.isFile() || (sandboxStat.mode & 0o111) === 0) {
        return {
          supported: false,
          code: "unattended_isolation_unsupported",
          message: `OS sandbox executable at '${sandboxPath}' is not an executable file`,
          remediation: "Install bubblewrap ('bwrap') or configure container isolation."
        };
      }
    } catch (err) {
      return {
        supported: false,
        code: "unattended_isolation_unsupported",
        message: `OS sandbox executable at '${sandboxPath}' does not exist: ${err instanceof Error ? err.message : String(err)}`,
        remediation: "Install bubblewrap ('bwrap') or configure container isolation."
      };
    }
  }

  return {
    supported: true,
    code: "isolation_verified",
    message: "Unattended isolation verified"
  };
}

export async function compileProviderPermissions(
  provider: "claude" | "codex" | "agy",
  profile: PermissionProfile,
  role: AgentRole,
  capabilities: DetectedProviderCapabilities,
  options: PermissionCompilerOptions
): Promise<CompiledPermissionResult> {
  if (profile.allowGlobalPermissionBypass) {
    return {
      supported: false,
      code: "global_permission_bypass_forbidden",
      message: "Global permission bypass (--dangerously-skip-permissions / danger-full-access) is forbidden",
      remediation: "Set allowGlobalPermissionBypass to false and use restricted, workspace_auto, or unattended_isolated.",
      flags: [],
      detectsDangerouslySkipPermissions: capabilities.supportsDangerouslySkipPermissions
    };
  }

  if (profile.mode === "unattended_isolated") {
    const isolationCheck = await verifyUnattendedIsolation(profile, capabilities, provider, options);
    if (!isolationCheck.supported) {
      return {
        supported: false,
        code: isolationCheck.code,
        message: isolationCheck.message,
        ...(isolationCheck.remediation !== undefined ? { remediation: isolationCheck.remediation } : {}),
        flags: [],
        detectsDangerouslySkipPermissions: capabilities.supportsDangerouslySkipPermissions
      };
    }
  }

  if (provider === "claude") {
    return compileClaudePermissions(profile, role, capabilities, options);
  }
  if (provider === "codex") {
    return compileCodexPermissions(profile, role, capabilities, options);
  }
  return compileAgyPermissions(profile, role, capabilities, options);
}

function compileClaudePermissions(
  profile: PermissionProfile,
  role: AgentRole,
  capabilities: DetectedProviderCapabilities,
  options: PermissionCompilerOptions
): CompiledPermissionResult {
  const requiredFlags = [
    "--strict-mcp-config",
    "--setting-sources",
    "--disable-slash-commands",
    "--permission-mode",
    "--tools",
    "--allowedTools",
    "--disallowedTools"
  ];

  const extraRoots = new Set<string>();
  for (const root of [...profile.readableRoots, ...profile.writableRoots]) {
    if (root !== options.cwd && !extraRoots.has(root)) {
      extraRoots.add(root);
    }
  }
  if (extraRoots.size > 0) {
    requiredFlags.push("--add-dir");
  }

  const missingFlags = requiredFlags.filter((flag) => !capabilities.supportedFlags.has(flag));
  if (missingFlags.length > 0) {
    return {
      supported: false,
      code: "invalid_flag",
      message: `Claude CLI does not support required security flags: ${missingFlags.join(", ")}`,
      remediation: "Upgrade Claude Code to a compatible release (>= 2.0.0) supporting all required flags.",
      flags: [],
      detectsDangerouslySkipPermissions: capabilities.supportsDangerouslySkipPermissions
    };
  }

  const flags: string[] = [
    ...(capabilities.supportedFlags.has("--restricted") ? ["--restricted"] : []),
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--permission-mode",
    "dontAsk"
  ];

  let tools: string;
  if (role === "conversation" || role === "coordinator") {
    tools = "";
  } else if (profile.filesystem === "read_only" || profile.mode === "restricted") {
    tools = "Read,Glob,Grep";
  } else {
    tools = "Read,Glob,Grep,Edit,Write";
  }
  // With the host PreToolUse guard, every role except Conversation gets Bash: dontAsk would refuse an unlisted call, so
  // `Bash` is allowed and the hook (whose deny overrides allow rules) enforces the host's read-only/build allowlist.
  // Without that hook, only investigation roles keep the narrow git read patterns as the sole gate.
  const shellPatterns = role === "conversation" ? []
    : options.hostToolGuard === true ? ["Bash"]
    : tools && INVESTIGATION_ROLES.has(role) ? READ_ONLY_GIT_PATTERNS : [];
  flags.push("--tools", shellPatterns.length ? [tools, "Bash"].filter(Boolean).join(",") : tools);
  const mcpPatterns = (options.mcpServerNames ?? []).map((name) => `mcp__${name}__*`);
  const allowedTools = [tools, ...shellPatterns, ...mcpPatterns].filter(Boolean);
  flags.push("--allowedTools", allowedTools.join(","));

  const disallowedList: string[] = [];
  for (const tool of ["Read", "Edit"]) {
    for (const pattern of PROTECTED_PATHS) {
      disallowedList.push(`${tool}(${pattern})`);
    }
    for (const deniedRoot of profile.deniedRoots) {
      disallowedList.push(`${tool}(${deniedRoot}/**)`);
    }
  }

  if (role !== "conversation") {
    disallowedList.push("AskUserQuestion");
  }

  flags.push("--disallowedTools", disallowedList.join(","));

  for (const root of extraRoots) {
    flags.push("--add-dir", root);
  }

  return {
    supported: true,
    code: "permissions_ok",
    message: "Claude permission flags compiled successfully",
    flags,
    allowedTools,
    disallowedTools: disallowedList,
    detectsDangerouslySkipPermissions: capabilities.supportsDangerouslySkipPermissions,
    workspaceTrusted: true
  };
}

function compileCodexPermissions(
  profile: PermissionProfile,
  _role: AgentRole,
  capabilities: DetectedProviderCapabilities,
  options: PermissionCompilerOptions
): CompiledPermissionResult {
  const requiredFlags = ["--no-daemon", "--sandbox", "--ask-for-approval"];

  const extraRoots = new Set<string>();
  for (const root of profile.writableRoots) {
    if (root !== options.cwd && !extraRoots.has(root)) {
      extraRoots.add(root);
    }
  }
  if (extraRoots.size > 0) {
    requiredFlags.push("--add-dir");
  }

  const missingFlags = requiredFlags.filter((flag) => !capabilities.supportedFlags.has(flag));
  if (missingFlags.length > 0) {
    return {
      supported: false,
      code: "invalid_flag",
      message: `Codex CLI does not support required security flags: ${missingFlags.join(", ")}`,
      remediation: "Upgrade Codex CLI to a compatible release (>= 0.150.0) supporting --sandbox and --ask-for-approval.",
      flags: [],
      detectsDangerouslySkipPermissions: false
    };
  }

  // Strictly separate approval policy from sandbox mode:
  // Disabling interactive prompts (--ask-for-approval never) NEVER disables the filesystem sandbox (--sandbox).
  const sandboxMode =
    profile.filesystem === "read_only" || profile.mode === "restricted"
      ? "read-only"
      : "workspace-write";
  const approvalPolicy = "never";

  const flags: string[] = [
    "--no-daemon",
    "--sandbox",
    sandboxMode,
    "--ask-for-approval",
    approvalPolicy
  ];

  if (profile.network.mode === "deny") {
    flags.push("-c", 'web_search="disabled"');
  }

  for (const root of extraRoots) {
    flags.push("--add-dir", root);
  }

  return {
    supported: true,
    code: "permissions_ok",
    message: "Codex permission flags compiled with distinct approval policy and sandbox mode",
    flags,
    detectsDangerouslySkipPermissions: false,
    workspaceTrusted: true
  };
}

function compileAgyPermissions(
  profile: PermissionProfile,
  role: AgentRole,
  capabilities: DetectedProviderCapabilities,
  options: PermissionCompilerOptions
): CompiledPermissionResult {
  const requiredFlags = ["--sandbox", "--mode", "--disable-slash-commands"];

  const extraRoots = new Set<string>();
  for (const root of [...profile.readableRoots, ...profile.writableRoots]) {
    if (root !== options.cwd && !extraRoots.has(root)) {
      extraRoots.add(root);
    }
  }
  if (extraRoots.size > 0) {
    requiredFlags.push("--add-dir");
  }

  const missingFlags = requiredFlags.filter((flag) => !capabilities.supportedFlags.has(flag));
  if (missingFlags.length > 0) {
    return {
      supported: false,
      code: "invalid_flag",
      message: `Antigravity CLI does not support required security flags: ${missingFlags.join(", ")}`,
      remediation: "Upgrade Antigravity CLI to a compatible release (>= 1.0.0) supporting --sandbox and --mode.",
      flags: [],
      detectsDangerouslySkipPermissions: capabilities.supportsDangerouslySkipPermissions
    };
  }

  const mode =
    profile.filesystem === "read_only" || profile.mode === "restricted"
      ? "plan"
      : "accept-edits";

  const flags: string[] = [
    "--sandbox",
    "--mode",
    mode,
    "--disable-slash-commands"
  ];

  for (const root of extraRoots) {
    flags.push("--add-dir", root);
  }

  const allowList: string[] = [];
  for (const root of profile.readableRoots) {
    allowList.push(`Read(${root}/**)`);
  }
  if (mode === "accept-edits") {
    for (const root of profile.writableRoots) {
      allowList.push(`Edit(${root}/**)`);
      allowList.push(`Write(${root}/**)`);
    }
  }
  for (const serverName of options.mcpServerNames ?? []) {
    allowList.push(`mcp__${serverName}__*`);
  }

  const denyList: string[] = [];
  for (const pattern of PROTECTED_PATHS) {
    denyList.push(`Read(${pattern})`);
    denyList.push(`Edit(${pattern})`);
  }
  for (const deniedRoot of profile.deniedRoots) {
    denyList.push(`Read(${deniedRoot}/**)`);
    denyList.push(`Edit(${deniedRoot}/**)`);
  }
  if (role !== "conversation") {
    denyList.push("AskUserQuestion");
  }

  return {
    supported: true,
    code: "permissions_ok",
    message: "Agy permission flags and permissions.allow policy compiled successfully",
    flags,
    detectsDangerouslySkipPermissions: capabilities.supportsDangerouslySkipPermissions,
    settingsPermissionsAllow: allowList,
    settingsPermissionsDeny: denyList,
    workspaceTrusted: true
  };
}
