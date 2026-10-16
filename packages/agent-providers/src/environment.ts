import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentEnvironment,
  AgentEnvironmentSchema,
  canonicalReceiptJson
} from "@bflow/contracts";

const DANGEROUS_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "PYTHONPATH",
  "PATH",
  "HOME",
  "BHOME"
]);

const SECRET_KEY_PATTERN = /(?:TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|PRIVATE_KEY)/i;
const SECRET_VALUE_PATTERNS = [
  /^sk-[A-Za-z0-9_-]+/,
  /^Bearer\s+/i,
  /^ghp_[A-Za-z0-9]+/,
  /^AIza[A-Za-z0-9_-]+/,
  /^secret:\/\//
];

export async function validateProviderEnvironment(
  environment: AgentEnvironment,
  options?: {
    readonly runId?: string;
    readonly taskId?: string;
    readonly allowTestFilesystemOwnership?: boolean;
  }
): Promise<{ readonly valid: boolean; readonly code?: string; readonly message?: string }> {
  const schemaResult = AgentEnvironmentSchema.safeParse(environment);
  if (!schemaResult.success) {
    return {
      valid: false,
      code: "invalid_schema",
      message: `AgentEnvironment validation failed: ${schemaResult.error.message}`
    };
  }

  // 1. Validate cwd
  const cwd = environment.cwd;
  if (!cwd || cwd.includes("\0") || !isAbsolute(cwd)) {
    return {
      valid: false,
      code: "invalid_cwd",
      message: "Environment cwd must be an absolute path without NUL bytes"
    };
  }

  try {
    const cwdReal = await realpath(cwd);
    if (cwdReal !== resolve(cwd)) {
      return {
        valid: false,
        code: "cwd_symlink",
        message: "Environment cwd cannot be a symlink or resolve outside canonical path"
      };
    }
    const cwdStat = await stat(cwdReal);
    if (!cwdStat.isDirectory()) {
      return {
        valid: false,
        code: "cwd_not_directory",
        message: `Environment cwd '${cwd}' is not a directory`
      };
    }
  } catch (err) {
    return {
      valid: false,
      code: "cwd_missing",
      message: `Environment cwd '${cwd}' does not exist or is inaccessible: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // 2. Validate stateDirectory
  const stateDir = environment.stateDirectory;
  if (!stateDir || stateDir.includes("\0") || !isAbsolute(stateDir)) {
    return {
      valid: false,
      code: "invalid_state_directory",
      message: "Environment stateDirectory must be an absolute path without NUL bytes"
    };
  }

  try {
    const stateReal = await realpath(stateDir);
    if (stateReal !== resolve(stateDir)) {
      return {
        valid: false,
        code: "state_directory_symlink",
        message: "Environment stateDirectory cannot be a symlink"
      };
    }
    const stateStat = await stat(stateReal);
    if (!stateStat.isDirectory()) {
      return {
        valid: false,
        code: "state_directory_not_directory",
        message: `Environment stateDirectory '${stateDir}' is not a directory`
      };
    }

    if ((stateStat.mode & 0o077) !== 0) {
      return {
        valid: false,
        code: "environment_insecure",
        message: `Environment stateDirectory has insecure permissions (${(stateStat.mode & 0o777).toString(8)}); must be 0o700`
      };
    }

    if (!options?.allowTestFilesystemOwnership && typeof process.getuid === "function") {
      if (stateStat.uid !== process.getuid()) {
        return {
          valid: false,
          code: "state_directory_wrong_owner",
          message: `Environment stateDirectory is owned by UID ${stateStat.uid}, expected current UID ${process.getuid()}`
        };
      }
    }
  } catch (err) {
    return {
      valid: false,
      code: "environment_missing",
      message: `Environment stateDirectory '${stateDir}' does not exist or is inaccessible: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  // 3. Validate permission roots
  const homeDir = process.env["HOME"];
  const allRoots = [
    ...environment.permissionProfile.readableRoots,
    ...environment.permissionProfile.writableRoots,
    ...environment.permissionProfile.deniedRoots
  ];

  for (const root of allRoots) {
    if (!root || root.includes("\0") || root.includes("..") || !isAbsolute(root)) {
      return {
        valid: false,
        code: "invalid_root_path",
        message: `Permission root path '${root}' is invalid, contains traversal ('..'), or is not absolute`
      };
    }
    if (root === "/" || (homeDir && (root === homeDir || root === resolve(homeDir)))) {
      return {
        valid: false,
        code: "root_path_too_broad",
        message: `Permission root path '${root}' cannot be root ('/') or entire user home directory`
      };
    }
  }

  const workspaceRoot = environment.scope.workspaceRoot;
  for (const root of environment.permissionProfile.writableRoots) {
    const isUnderCwd = root === cwd || root.startsWith(cwd + "/");
    const isUnderWorkspace = root === workspaceRoot || root.startsWith(workspaceRoot + "/");
    if (!isUnderCwd && !isUnderWorkspace) {
      return {
        valid: false,
        code: "writable_root_outside_workspace",
        message: `Writable root '${root}' is outside workspaceRoot and cwd`
      };
    }
  }

  // 4. Validate environmentVariables for injection & secret leaks
  for (const [key, value] of Object.entries(environment.environmentVariables)) {
    if (DANGEROUS_ENV_KEYS.has(key) || key.startsWith("BFLOW_")) {
      return {
        valid: false,
        code: "environment_injection_attempt",
        message: `Protected or dangerous environment variable key '${key}' cannot be supplied in environmentVariables`
      };
    }

    if (SECRET_KEY_PATTERN.test(key)) {
      return {
        valid: false,
        code: "secret_in_environment_variables",
        message: `Environment variable key '${key}' appears to be a secret. Secrets must be bound via secretBindings only.`
      };
    }

    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        return {
          valid: false,
          code: "secret_value_in_environment_variables",
          message: `Environment variable '${key}' contains a secret token or reference. Secrets must be in secretBindings only.`
        };
      }
    }
  }

  return { valid: true };
}

export function buildProviderEnvironment(
  environment: AgentEnvironment,
  options?: {
    readonly mcpEndpoints?: Readonly<Record<string, string>>;
    readonly mcpConfigPath?: string;
    readonly runId?: string;
    readonly taskId?: string;
    readonly basePath?: string;
    readonly homeDir?: string;
  }
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: options?.basePath ?? process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: options?.homeDir ?? join(environment.stateDirectory, "home"),
    XDG_CONFIG_HOME: join(environment.stateDirectory, "xdg-config"),
    XDG_DATA_HOME: join(environment.stateDirectory, "xdg-data"),
    XDG_STATE_HOME: join(environment.stateDirectory, "xdg-state"),
    BHOME: join(environment.stateDirectory, "bflow-home"),
    BFLOW_SESSION_ID: environment.scope.sessionId,
    BFLOW_REPOSITORY_ID: environment.scope.repositoryId,
    BFLOW_MACHINE_ID: environment.scope.machineId,
    BFLOW_ENVIRONMENT_ID: environment.environmentId,
    BFLOW_PROVIDER: environment.provider,
    BFLOW_ROLE: environment.role,
    BFLOW_PERMISSION_MODE: environment.permissionProfile.mode,
    BFLOW_WORKSPACE_ROOT: environment.scope.workspaceRoot,
    BFLOW_WORKTREE_PATH: environment.cwd,
    BFLOW_STATE_DIR: environment.stateDirectory,
    BFLOW_CONFIG_FINGERPRINT: environment.configFingerprint,
    BFLOW_SKILL_MANIFEST_DIGEST: environment.skillManifestDigest,
    BFLOW_MCP_ENDPOINTS_JSON: canonicalReceiptJson(options?.mcpEndpoints ?? {})
  };

  if (options?.mcpConfigPath) {
    env["BFLOW_MCP_CONFIG_PATH"] = options.mcpConfigPath;
  }
  if (options?.runId) {
    env["BFLOW_RUN_ID"] = options.runId;
  }
  if (options?.taskId) {
    env["BFLOW_TASK_ID"] = options.taskId;
  }

  if (environment.provider === "claude") {
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
    env["CLAUDE_CONFIG_DIR"] = join(environment.stateDirectory, "claude-config");
  } else if (environment.provider === "codex") {
    env["CODEX_HOME"] = join(environment.stateDirectory, "codex-home");
  } else if (environment.provider === "agy") {
    env["AGY_CONFIG_DIR"] = join(environment.stateDirectory, "agy-config");
  }

  for (const [key, value] of Object.entries(environment.environmentVariables)) {
    if (!DANGEROUS_ENV_KEYS.has(key) && !key.startsWith("BFLOW_")) {
      env[key] = value;
    }
  }

  return env;
}
