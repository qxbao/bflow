import {
  TimeoutPolicySchema,
  type ContractError,
  type OperationResult
} from "@ai-flow/contracts";
import * as fs from "node:fs/promises";
import * as path from "node:path";

function createValidationError(message: string): ContractError {
  return {
    code: "validation",
    retryable: false,
    message
  };
}

export const QUALITY_CHECK_KINDS = [
  "typecheck",
  "lint",
  "unit_test",
  "build",
  "custom"
] as const;
export type QualityCheckKind = (typeof QUALITY_CHECK_KINDS)[number];

export function isQualityCheckKind(value: unknown): value is QualityCheckKind {
  return (
    typeof value === "string" &&
    (QUALITY_CHECK_KINDS as readonly string[]).includes(value)
  );
}

export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AllowedCommandRule {
  readonly executable: string;
  readonly allowedArgPrefixes?: readonly (readonly string[])[];
  readonly allowAnyArgs?: boolean;
  readonly description?: string;
}

export interface QualitySecurityPolicy {
  readonly allowedRootDirs: readonly string[];
  readonly assignedWorktreePath?: string;
  readonly maxExecutionTimeoutMs: number;
  readonly allowedCommands: readonly AllowedCommandRule[];
  readonly allowCustomCommands?: boolean;
  readonly allowedEnvKeys?: readonly string[];
}

export type SecurityViolationCategory =
  | "untrusted_agent_command"
  | "disallowed_command"
  | "shell_injection"
  | "destructive_command"
  | "secret_access"
  | "production_deployment"
  | "directory_escape"
  | "timeout_exceeded";

export interface SecurityViolationFinding {
  readonly category: SecurityViolationCategory;
  readonly rule: string;
  readonly matchedText: string;
  readonly message: string;
}

export interface CommandSecurityReport {
  readonly safe: boolean;
  readonly findings: readonly SecurityViolationFinding[];
}

export const DEFAULT_ALLOWED_COMMANDS: readonly AllowedCommandRule[] = [
  {
    executable: "pnpm",
    allowedArgPrefixes: [
      ["typecheck"],
      ["lint"],
      ["test"],
      ["build"],
      ["check"],
      ["check:deps"],
      ["exec", "tsc"],
      ["exec", "vitest"],
      ["exec", "eslint"]
    ],
    description: "Package manager verification tasks"
  },
  {
    executable: "npm",
    allowedArgPrefixes: [
      ["test"],
      ["run", "typecheck"],
      ["run", "lint"],
      ["run", "test"],
      ["run", "build"]
    ],
    description: "NPM verification script runs"
  },
  {
    executable: "npx",
    allowedArgPrefixes: [
      ["tsc"],
      ["vitest"],
      ["eslint"]
    ],
    description: "NPX verification tool invocations"
  },
  {
    executable: "tsc",
    allowedArgPrefixes: [
      ["--noEmit"],
      ["-b"]
    ],
    description: "TypeScript compiler static verification"
  },
  {
    executable: "vitest",
    allowedArgPrefixes: [
      ["run"]
    ],
    description: "Vitest test suite runner"
  },
  {
    executable: "eslint",
    allowedArgPrefixes: [
      ["."],
      ["src"],
      ["packages"]
    ],
    description: "ESLint static code analyzer"
  },
  {
    executable: "git",
    allowedArgPrefixes: [
      ["status"],
      ["diff"]
    ],
    description: "Git read-only workspace inspection"
  }
];

export const APPLICATION_SECURITY_LIMITATIONS: readonly string[] = [
  "Application-layer policy validation is NOT an OS/kernel sandbox, container, VM, or seccomp/AppArmor/namespace isolation mechanism.",
  "Once an allowlisted binary (such as node, pnpm, vitest, or tsc) starts executing, the child process runs with the same OS user permissions as the host process and can read/write files or spawn subprocesses that the OS user has access to.",
  "Project source files, test files, package.json scripts, or compiler plugins executed by an allowlisted tool could contain arbitrary code that runs within the child process.",
  "fs.realpath directory scope validation checks paths prior to process launch and does not prevent time-of-check to time-of-use (TOCTOU) symlink modifications during execution.",
  "Environment variable scrubbing removes secrets from process.env passed to the child process, but cannot prevent a child process from reading user-accessible files on the local filesystem if OS file permissions allow it.",
  "Timeout enforcement terminates the process via SIGTERM/SIGKILL, but background grandchild processes that detach from the process group without OS cgroup/namespace containment may outlive the parent if not isolated by the host OS."
];

export function getSecurityControlLimitationsReport(): {
  readonly layer: "application";
  readonly isCompleteSandbox: false;
  readonly enforcedControls: readonly string[];
  readonly limitations: readonly string[];
} {
  return {
    layer: "application",
    isCompleteSandbox: false,
    enforcedControls: [
      "Command executable allowlisting with argument prefix enforcement",
      "Dangerous command, shell injection, and destructive command blocking",
      "Secret access and network exfiltration pattern blocking",
      "Production deployment and artifact publishing command blocking",
      "Directory scope confinement using path resolution and realpath canonicalization",
      "Timeout budget validation with 32-bit signed integer overflow prevention",
      "Environment variable scrubbing preventing credential leakage to child processes"
    ],
    limitations: APPLICATION_SECURITY_LIMITATIONS
  };
}

export const DANGEROUS_EXEC_ENV_REGEX =
  /^(LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_.*|NODE_OPTIONS|NODE_REPL_EXTERNAL_MODULE|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|IFS|CDPATH|PROMPT_COMMAND|GIT_SSH_COMMAND|GIT_SSH|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_ASKPASS|SSH_ASKPASS|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|NPM_CONFIG_SCRIPT_SHELL|PYTHONSTARTUP|PYTHONPATH|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB)$/i;

export function createDefaultSecurityPolicy(options: {
  readonly allowedRootDirs: readonly string[];
  readonly assignedWorktreePath?: string;
  readonly maxExecutionTimeoutMs?: number;
  readonly allowedCommands?: readonly AllowedCommandRule[];
  readonly allowCustomCommands?: boolean;
  readonly allowedEnvKeys?: readonly string[];
}): OperationResult<QualitySecurityPolicy> {
  if (
    !Array.isArray(options.allowedRootDirs) ||
    options.allowedRootDirs.length === 0
  ) {
    return {
      ok: false,
      error: createValidationError(
        "allowedRootDirs must be a non-empty array of valid directories"
      )
    };
  }

  for (const dir of options.allowedRootDirs) {
    if (
      typeof dir !== "string" ||
      dir.trim().length === 0 ||
      dir.includes("\0") ||
      dir.split(/[\\/]+/).includes("..")
    ) {
      return {
        ok: false,
        error: createValidationError(`Invalid root directory path "${dir}": path traversal or invalid characters`)
      };
    }
  }

  if (options.assignedWorktreePath !== undefined) {
    if (
      typeof options.assignedWorktreePath !== "string" ||
      options.assignedWorktreePath.trim().length === 0 ||
      options.assignedWorktreePath.includes("\0") ||
      options.assignedWorktreePath.split(/[\\/]+/).includes("..")
    ) {
      return {
        ok: false,
        error: createValidationError(
          "assignedWorktreePath cannot contain \"..\" segments or NUL bytes"
        )
      };
    }
  }

  const timeoutMs = options.maxExecutionTimeoutMs ?? 300_000;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 2_147_483_647
  ) {
    return {
      ok: false,
      error: createValidationError(
        "maxExecutionTimeoutMs must be an integer between 100 and 2147483647"
      )
    };
  }

  return {
    ok: true,
    value: {
      allowedRootDirs: [...options.allowedRootDirs],
      ...(options.assignedWorktreePath !== undefined
        ? { assignedWorktreePath: options.assignedWorktreePath }
        : {}),
      maxExecutionTimeoutMs: timeoutMs,
      allowedCommands: options.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS,
      ...(options.allowCustomCommands !== undefined
        ? { allowCustomCommands: options.allowCustomCommands }
        : {}),
      ...(options.allowedEnvKeys !== undefined
        ? { allowedEnvKeys: [...options.allowedEnvKeys] }
        : {})
    }
  };
}

const SHELL_INTERPRETER_SET = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe"
]);

const SCRIPT_EVAL_ENGINES = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "python2",
  "ruby",
  "perl",
  "sh",
  "bash",
  "zsh"
]);

const INLINE_EVAL_FLAGS = new Set(["-c", "-e", "--eval", "--interactive"]);

const DESTRUCTIVE_COMMAND_SET = new Set([
  "rm",
  "rmdir",
  "shred",
  "unlink",
  "mkfs",
  "fdisk",
  "dd",
  "wipefs",
  "shutdown",
  "reboot",
  "poweroff",
  "killall",
  "pkill",
  "chmod",
  "chown",
  "truncate"
]);

const NETWORK_EXFILTRATION_SET = new Set([
  "curl",
  "wget",
  "nc",
  "netcat",
  "ncat",
  "scp",
  "sftp",
  "ssh",
  "ftp",
  "telnet",
  "socat"
]);

const DEPLOYMENT_TOOL_SET = new Set([
  "kubectl",
  "helm",
  "terraform",
  "pulumi",
  "ansible-playbook"
]);

const SENSITIVE_KEY_REGEX =
  /(_KEY|_SECRET|_TOKEN|_PASSWORD|_PASS|_CREDENTIAL|_PRIVATE|_AUTH|DATABASE_URL|REDIS_URL|AWS_|GCP_|GOOGLE_|AZURE_|OPENAI_|ANTHROPIC_|GEMINI_|GITHUB_TOKEN|GITLAB_TOKEN|NPM_TOKEN|SLACK_|STRIPE_)/i;

const SHELL_METACHAR_PATTERN = /(;|&{1,2}|\|{1,2}|`|\$\(|\${|>|>>|<|\n|\r|\0)/;

function matchSecretPattern(text: string): string | null {
  if (/(^|[/\\])\.env($|\.[\w.-]+)/i.test(text)) return ".env";
  if (/(^|[/\\])\.ssh($|[/\\])/i.test(text)) return ".ssh";
  if (/\bid_rsa\b/i.test(text)) return "id_rsa";
  if (/\bid_ed25519\b/i.test(text)) return "id_ed25519";
  if (/\.(pem|key)$/i.test(text)) return ".pem/.key";
  if (/(^|[/\\])\.npmrc$/i.test(text)) return ".npmrc";
  if (/(^|[/\\])\.netrc$/i.test(text)) return ".netrc";
  if (/(^|[/\\])\.aws[/\\]credentials/i.test(text)) return ".aws/credentials";
  if (/\/etc\/shadow\b/i.test(text)) return "/etc/shadow";
  if (/\/etc\/passwd\b/i.test(text)) return "/etc/passwd";
  if (/\/proc\/self\/environ\b/i.test(text)) return "/proc/self/environ";
  return null;
}

export function detectDangerousCommandOrSecretAccess(
  command: CommandSpec | string
): CommandSecurityReport {
  const findings: SecurityViolationFinding[] = [];

  let executable: string;
  let args: readonly string[];
  let env: Readonly<Record<string, string>> | undefined;
  let rawLine: string;

  if (typeof command === "string") {
    rawLine = command.trim();
    const tokens = rawLine.length > 0 ? rawLine.split(/\s+/) : [];
    executable = tokens[0] ?? "";
    args = tokens.slice(1);
    env = undefined;
  } else {
    executable = command.executable ?? "";
    args = command.args ?? [];
    env = command.env;
    rawLine = [executable, ...args].join(" ").trim();
  }

  const baseExec = executable
    .toLowerCase()
    .replace(/\\/g, "/")
    .split("/")
    .pop() ?? "";

  // 1. Shell Injection detection
  // Path separators in executable
  if (executable.includes("/") || executable.includes("\\")) {
    findings.push({
      category: "shell_injection",
      rule: "disallow_path_separators_in_executable",
      matchedText: executable,
      message: `Executable "${executable}" contains path separators; only bare command names are allowed.`
    });
  }

  // Shell interpreters
  if (
    SHELL_INTERPRETER_SET.has(baseExec) ||
    SHELL_INTERPRETER_SET.has(executable.toLowerCase()) ||
    executable.toLowerCase() === "/bin/sh" ||
    executable.toLowerCase() === "/bin/bash"
  ) {
    findings.push({
      category: "shell_injection",
      rule: "disallow_shell_interpreter",
      matchedText: executable,
      message: `Direct execution of shell interpreter "${executable}" is forbidden.`
    });
  }

  // Inline eval flags
  if (SCRIPT_EVAL_ENGINES.has(baseExec)) {
    for (const arg of args) {
      if (
        INLINE_EVAL_FLAGS.has(arg) ||
        arg.startsWith("-c=") ||
        arg.startsWith("-e=") ||
        arg.startsWith("--eval=")
      ) {
        findings.push({
          category: "shell_injection",
          rule: "disallow_inline_eval_flag",
          matchedText: `${executable} ${arg}`,
          message: `Inline evaluation flag "${arg}" with scripting engine "${executable}" is forbidden.`
        });
      }
    }
  }

  // Shell metacharacters in executable or args
  const metacharInExec = executable.match(SHELL_METACHAR_PATTERN);
  if (metacharInExec) {
    findings.push({
      category: "shell_injection",
      rule: "disallow_shell_metacharacters",
      matchedText: metacharInExec[0],
      message: `Shell metacharacter "${metacharInExec[0]}" in executable is forbidden.`
    });
  }

  for (const arg of args) {
    const metacharInArg = arg.match(SHELL_METACHAR_PATTERN);
    if (metacharInArg) {
      findings.push({
        category: "shell_injection",
        rule: "disallow_shell_metacharacters",
        matchedText: metacharInArg[0],
        message: `Shell metacharacter "${metacharInArg[0]}" in argument is forbidden.`
      });
    }
  }

  if (typeof command === "string") {
    const metacharInRaw = rawLine.match(SHELL_METACHAR_PATTERN);
    if (metacharInRaw && !metacharInExec && !findings.some(f => f.rule === "disallow_shell_metacharacters")) {
      findings.push({
        category: "shell_injection",
        rule: "disallow_shell_metacharacters",
        matchedText: metacharInRaw[0],
        message: `Shell metacharacter "${metacharInRaw[0]}" detected in raw command string.`
      });
    }
  }

  // Directory or config override flags across args
  for (const arg of args) {
    if (
      arg === "-C" ||
      arg.startsWith("-C=") ||
      (arg.startsWith("-C") && !arg.startsWith("--")) ||
      arg === "--dir" ||
      arg.startsWith("--dir=") ||
      arg === "--prefix" ||
      arg.startsWith("--prefix=") ||
      arg === "--cwd" ||
      arg.startsWith("--cwd=") ||
      arg === "--work-tree" ||
      arg.startsWith("--work-tree=") ||
      arg === "--git-dir" ||
      arg.startsWith("--git-dir=") ||
      arg === "--script-shell" ||
      arg.startsWith("--script-shell=")
    ) {
      findings.push({
        category: "directory_escape",
        rule: "disallow_directory_override_flag",
        matchedText: arg,
        message: `Directory or configuration override flag "${arg}" is forbidden.`
      });
    }
  }

  // Dangerous git flags
  if (baseExec === "git") {
    for (const arg of args) {
      if (
        arg === "-c" ||
        arg.startsWith("-c=") ||
        (arg.startsWith("-c") && !arg.startsWith("--")) ||
        arg === "--config-env" ||
        arg.startsWith("--config-env=") ||
        arg === "--exec-path" ||
        arg.startsWith("--exec-path=") ||
        arg === "--ext-diff" ||
        arg.startsWith("--ext-diff=") ||
        arg === "--upload-pack" ||
        arg.startsWith("--upload-pack=") ||
        arg === "--receive-pack" ||
        arg.startsWith("--receive-pack=")
      ) {
        findings.push({
          category: "shell_injection",
          rule: "disallow_git_dangerous_flag",
          matchedText: arg,
          message: `Dangerous git execution flag "${arg}" is forbidden.`
        });
      }
      if (arg === "--output" || arg.startsWith("--output=")) {
        findings.push({
          category: "destructive_command",
          rule: "disallow_git_output_flag",
          matchedText: arg,
          message: `Git output redirection flag "${arg}" is blocked.`
        });
      }
    }
  }

  // 2. Destructive command detection
  if (DESTRUCTIVE_COMMAND_SET.has(baseExec) || baseExec.startsWith("mkfs")) {
    findings.push({
      category: "destructive_command",
      rule: "disallow_destructive_executable",
      matchedText: executable,
      message: `Destructive executable "${executable}" is blocked.`
    });
  }

  // Destructive git operations (scan ALL tokens in args)
  if (baseExec === "git") {
    const lowerArgs = args.map((a) => a.toLowerCase());
    if (lowerArgs.includes("reset") && args.some((a) => a.toLowerCase().startsWith("--hard"))) {
      findings.push({
        category: "destructive_command",
        rule: "disallow_git_reset_hard",
        matchedText: "git reset --hard",
        message: "Destructive git operation \"git reset --hard\" is blocked."
      });
    }
    if (lowerArgs.includes("clean")) {
      findings.push({
        category: "destructive_command",
        rule: "disallow_git_clean",
        matchedText: "git clean",
        message: "Destructive git operation \"git clean\" is blocked."
      });
    }
    if (lowerArgs.includes("push")) {
      findings.push({
        category: "destructive_command",
        rule: "disallow_git_push",
        matchedText: "git push",
        message: "Destructive git operation \"git push\" is blocked."
      });
    }
    if (
      lowerArgs.includes("branch") &&
      args.some((a) => a === "-D" || a === "-d" || a === "--delete")
    ) {
      findings.push({
        category: "destructive_command",
        rule: "disallow_git_branch_delete",
        matchedText: "git branch -D",
        message: "Destructive git operation \"git branch -D\" is blocked."
      });
    }
    if (
      lowerArgs.includes("checkout") &&
      (args.includes("--") || args.some((a) => a === "-f" || a === "--force"))
    ) {
      findings.push({
        category: "destructive_command",
        rule: "disallow_git_checkout_discard",
        matchedText: "git checkout --",
        message: "Destructive git operation \"git checkout --\" is blocked."
      });
    }
    if (lowerArgs.includes("restore")) {
      findings.push({
        category: "destructive_command",
        rule: "disallow_git_restore",
        matchedText: "git restore",
        message: "Destructive git operation \"git restore\" is blocked."
      });
    }
    if (lowerArgs.includes("switch")) {
      findings.push({
        category: "destructive_command",
        rule: "disallow_git_switch",
        matchedText: "git switch",
        message: "Destructive git operation \"git switch\" is blocked."
      });
    }
  }

  // Database destructive operations
  if (baseExec === "dropdb") {
    findings.push({
      category: "destructive_command",
      rule: "disallow_dropdb",
      matchedText: "dropdb",
      message: "Database drop command \"dropdb\" is blocked."
    });
  }

  const dbDestructivePattern =
    /\b(drop\s+table|drop\s+database|truncate\s+table|prisma\s+migrate\s+reset|db:drop|db:reset)\b/i;
  const dbMatch = rawLine.match(dbDestructivePattern);
  if (dbMatch) {
    findings.push({
      category: "destructive_command",
      rule: "disallow_db_destructive_operation",
      matchedText: dbMatch[0],
      message: `Database destructive operation "${dbMatch[0]}" is blocked.`
    });
  }

  // 3. Secret access & network exfiltration detection
  if (baseExec === "printenv") {
    findings.push({
      category: "secret_access",
      rule: "disallow_printenv",
      matchedText: "printenv",
      message: "Environment inspection tool \"printenv\" is blocked."
    });
  }

  // Secret file references in executable or arguments
  const secretInExec = matchSecretPattern(executable);
  if (secretInExec) {
    findings.push({
      category: "secret_access",
      rule: "disallow_secret_file_reference",
      matchedText: secretInExec,
      message: `Secret or credential file pattern "${secretInExec}" in executable is blocked.`
    });
  }

  for (const arg of args) {
    const secretInArg = matchSecretPattern(arg);
    if (secretInArg) {
      findings.push({
        category: "secret_access",
        rule: "disallow_secret_file_reference",
        matchedText: secretInArg,
        message: `Secret or credential file reference "${secretInArg}" in arguments is blocked.`
      });
    }
  }

  // Network exfiltration tools
  if (NETWORK_EXFILTRATION_SET.has(baseExec)) {
    findings.push({
      category: "secret_access",
      rule: "disallow_network_exfiltration_tool",
      matchedText: executable,
      message: `Network tool "${executable}" capable of exfiltration is blocked.`
    });
  }

  // Environment variables inspection
  if (env) {
    for (const [key, value] of Object.entries(env)) {
      if (key.toUpperCase() === "PATH" || DANGEROUS_EXEC_ENV_REGEX.test(key)) {
        findings.push({
          category: "shell_injection",
          rule: "disallow_dangerous_env_override",
          matchedText: key,
          message: `Command environment attempts to override protected execution variable "${key}"`
        });
      }

      if (SENSITIVE_KEY_REGEX.test(key)) {
        findings.push({
          category: "secret_access",
          rule: "disallow_sensitive_env_keys",
          matchedText: key,
          message: `Environment variable "${key}" contains sensitive secret pattern.`
        });
      }

      if (typeof value === "string") {
        if (value.includes("\0") || SHELL_METACHAR_PATTERN.test(value)) {
          const match = value.match(SHELL_METACHAR_PATTERN);
          const matchedText = match ? match[0] : (value.includes("\0") ? "\\0" : value);
          findings.push({
            category: "shell_injection",
            rule: "disallow_shell_metacharacters",
            matchedText,
            message: `Shell metacharacter "${matchedText}" in environment variable "${key}" is forbidden.`
          });
        }
        const secretInVal = matchSecretPattern(value);
        if (secretInVal) {
          findings.push({
            category: "secret_access",
            rule: "disallow_secret_file_reference",
            matchedText: secretInVal,
            message: `Secret or credential file reference "${secretInVal}" in environment variable "${key}" is blocked.`
          });
        }
      }
    }
  }

  // 4. Production deployment detection
  if (DEPLOYMENT_TOOL_SET.has(baseExec)) {
    findings.push({
      category: "production_deployment",
      rule: "disallow_deployment_tool",
      matchedText: executable,
      message: `Production deployment tool "${executable}" is blocked.`
    });
  }

  if (
    (baseExec === "npm" || baseExec === "pnpm" || baseExec === "yarn") &&
    args.includes("publish")
  ) {
    findings.push({
      category: "production_deployment",
      rule: "disallow_package_publish",
      matchedText: `${executable} publish`,
      message: `Package publishing command "${executable} publish" is blocked.`
    });
  }

  if (baseExec === "git" && args.some((a) => a.toLowerCase() === "push")) {
    findings.push({
      category: "production_deployment",
      rule: "disallow_git_push",
      matchedText: "git push",
      message: "Git push is blocked in quality gate execution."
    });
  }

  if (baseExec === "docker" && args.includes("push")) {
    findings.push({
      category: "production_deployment",
      rule: "disallow_docker_push",
      matchedText: "docker push",
      message: "Docker push is blocked."
    });
  }

  if (
    (baseExec === "flyctl" || baseExec === "fly") &&
    args.includes("deploy")
  ) {
    findings.push({
      category: "production_deployment",
      rule: "disallow_cloud_deploy",
      matchedText: `${executable} deploy`,
      message: "Cloud deployment command is blocked."
    });
  }

  if (
    (baseExec === "vercel" || baseExec === "now") &&
    args.includes("--prod")
  ) {
    findings.push({
      category: "production_deployment",
      rule: "disallow_cloud_deploy",
      matchedText: `${executable} --prod`,
      message: "Production deployment with Vercel is blocked."
    });
  }

  if (
    baseExec === "netlify" &&
    args.includes("deploy") &&
    args.includes("--prod")
  ) {
    findings.push({
      category: "production_deployment",
      rule: "disallow_cloud_deploy",
      matchedText: "netlify deploy --prod",
      message: "Production deployment with Netlify is blocked."
    });
  }

  if (
    (baseExec === "serverless" || baseExec === "sls") &&
    args.includes("deploy")
  ) {
    findings.push({
      category: "production_deployment",
      rule: "disallow_cloud_deploy",
      matchedText: `${executable} deploy`,
      message: "Serverless deploy is blocked."
    });
  }

  if (
    baseExec === "aws" &&
    (args.includes("ecs") || args.includes("lambda"))
  ) {
    findings.push({
      category: "production_deployment",
      rule: "disallow_cloud_deploy",
      matchedText: `aws ${args.find(a => a === "ecs" || a === "lambda")}`,
      message: "AWS ECS/Lambda deployment command is blocked."
    });
  }

  if (
    baseExec === "gcloud" &&
    args.includes("app") &&
    args.includes("deploy")
  ) {
    findings.push({
      category: "production_deployment",
      rule: "disallow_cloud_deploy",
      matchedText: "gcloud app deploy",
      message: "Google Cloud App deploy is blocked."
    });
  }

  // Deduplicate findings by category + rule + matchedText
  const uniqueFindings: SecurityViolationFinding[] = [];
  const seenKeys = new Set<string>();
  for (const finding of findings) {
    const key = `${finding.category}:${finding.rule}:${finding.matchedText}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueFindings.push(finding);
    }
  }

  return {
    safe: uniqueFindings.length === 0,
    findings: uniqueFindings
  };
}

export function validateCommandAgainstPolicy(
  command: CommandSpec,
  policy: QualitySecurityPolicy,
  options?: {
    readonly checkKind?: QualityCheckKind;
    readonly source?: "policy" | "agent_output";
  }
): OperationResult<CommandSpec> {
  if (options?.source === "agent_output") {
    return {
      ok: false,
      error: createValidationError(
        "Arbitrary commands from AI agent output are forbidden without explicit static policy approval [untrusted_agent_command]"
      )
    };
  }

  if (
    !command ||
    typeof command.executable !== "string" ||
    command.executable.trim().length === 0 ||
    command.executable.includes("/") ||
    command.executable.includes("\\") ||
    command.executable.includes("\0")
  ) {
    return {
      ok: false,
      error: createValidationError(
        `Invalid command executable "${command?.executable}": must be a bare command name without path separators or NUL bytes`
      )
    };
  }

  if (!Array.isArray(command.args)) {
    return {
      ok: false,
      error: createValidationError("Command args must be an array of strings")
    };
  }

  for (const arg of command.args) {
    if (typeof arg !== "string" || arg.includes("\0")) {
      return {
        ok: false,
        error: createValidationError("Command args cannot contain non-strings or NUL bytes")
      };
    }
    if (arg.split(/[\\/]+/).includes("..") || /%2e%2e/i.test(arg)) {
      return {
        ok: false,
        error: createValidationError(
          `Command argument "${arg}" contains disallowed '..' path traversal`
        )
      };
    }
  }

  const report = detectDangerousCommandOrSecretAccess(command);
  if (!report.safe) {
    const messages = report.findings
      .map(f => `[${f.category}] ${f.message}`)
      .join("; ");
    return {
      ok: false,
      error: createValidationError(`Command security violation: ${messages}`)
    };
  }

  if (options?.checkKind === "custom" && policy.allowCustomCommands === false) {
    return {
      ok: false,
      error: createValidationError("Custom commands are disabled by security policy")
    };
  }

  const matchingRules = policy.allowedCommands.filter(
    rule => rule.executable === command.executable
  );

  if (matchingRules.length === 0) {
    return {
      ok: false,
      error: createValidationError(
        `Disallowed command executable "${command.executable}"`
      )
    };
  }

  const ruleSatisfied = matchingRules.some(rule => {
    if (rule.allowAnyArgs === true) {
      return true;
    }
    if (rule.allowedArgPrefixes && rule.allowedArgPrefixes.length > 0) {
      return rule.allowedArgPrefixes.some(
        prefix =>
          prefix.length <= command.args.length &&
          prefix.every((token, idx) => command.args[idx] === token)
      );
    }
    return false;
  });

  if (!ruleSatisfied) {
    return {
      ok: false,
      error: createValidationError(
        `Command arguments for "${command.executable}" are not in the allowlist`
      )
    };
  }

  return { ok: true, value: command };
}

const BLOCKED_SYSTEM_DIRS = [
  "/etc",
  "/root",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/run",
  "/var/run",
  "/bin",
  "/sbin",
  "/usr",
  "/lib",
  "/lib64",
  "/opt"
];

export async function validateDirectoryScope(
  targetDir: string,
  policy: QualitySecurityPolicy
): Promise<OperationResult<string>> {
  if (
    typeof targetDir !== "string" ||
    targetDir.trim().length === 0 ||
    targetDir.includes("\0") ||
    targetDir.split(/[\\/]+/).includes("..")
  ) {
    return {
      ok: false,
      error: createValidationError(
        `Invalid target directory path "${targetDir}": path traversal or invalid characters`
      )
    };
  }

  if (
    !Array.isArray(policy.allowedRootDirs) ||
    policy.allowedRootDirs.length === 0
  ) {
    return {
      ok: false,
      error: createValidationError("Security policy allowedRootDirs cannot be empty")
    };
  }

  const resolvedTarget = path.resolve(targetDir);

  for (const blocked of BLOCKED_SYSTEM_DIRS) {
    if (
      resolvedTarget === blocked ||
      resolvedTarget.startsWith(blocked + path.sep)
    ) {
      return {
        ok: false,
        error: createValidationError(
          `Directory scope access to system path "${resolvedTarget}" is blocked`
        )
      };
    }
  }

  let realTarget: string;
  try {
    realTarget = await fs.realpath(resolvedTarget);
    const stat = await fs.stat(realTarget);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: createValidationError(`Target path "${targetDir}" is not a directory`)
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: createValidationError(
        `Target directory "${targetDir}" could not be resolved or does not exist`
      )
    };
  }

  for (const blocked of BLOCKED_SYSTEM_DIRS) {
    if (
      realTarget === blocked ||
      realTarget.startsWith(blocked + path.sep)
    ) {
      return {
        ok: false,
        error: createValidationError(
          `Directory scope access to system path "${realTarget}" is blocked`
        )
      };
    }
  }

  let insideAllowedRoot = false;
  for (const root of policy.allowedRootDirs) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(path.resolve(root));
    } catch {
      continue;
    }
    const isInside =
      realRoot === path.sep
        ? realTarget.startsWith(path.sep)
        : realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
    if (isInside) {
      insideAllowedRoot = true;
      break;
    }
  }

  if (!insideAllowedRoot) {
    return {
      ok: false,
      error: createValidationError(`Directory "${realTarget}" is outside allowed roots`)
    };
  }

  if (policy.assignedWorktreePath !== undefined) {
    let realWorktree: string;
    try {
      realWorktree = await fs.realpath(path.resolve(policy.assignedWorktreePath));
    } catch {
      return {
        ok: false,
        error: createValidationError(
          `Assigned worktree "${policy.assignedWorktreePath}" could not be resolved or does not exist`
        )
      };
    }
    const isInsideWorktree =
      realWorktree === path.sep
        ? realTarget.startsWith(path.sep)
        : realTarget === realWorktree || realTarget.startsWith(realWorktree + path.sep);
    if (!isInsideWorktree) {
      return {
        ok: false,
        error: createValidationError(
          `Directory "${realTarget}" is outside assigned worktree "${realWorktree}"`
        )
      };
    }
  }

  return { ok: true, value: realTarget };
}

export function validateTimeoutBudget(
  timeoutMs: number,
  policy?: QualitySecurityPolicy
): OperationResult<number> {
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 2_147_483_647
  ) {
    return {
      ok: false,
      error: createValidationError(
        `Timeout ${timeoutMs}ms must be an integer between 100 and 2147483647`
      )
    };
  }

  const parseResult = TimeoutPolicySchema.safeParse({
    executionTimeoutMs: timeoutMs,
    onTimeout: "fail"
  });
  if (!parseResult.success) {
    return {
      ok: false,
      error: createValidationError(
        `Timeout validation failed: ${parseResult.error.message}`
      )
    };
  }

  if (policy !== undefined) {
    if (
      typeof policy.maxExecutionTimeoutMs !== "number" ||
      !Number.isInteger(policy.maxExecutionTimeoutMs) ||
      policy.maxExecutionTimeoutMs < 100 ||
      policy.maxExecutionTimeoutMs > 2_147_483_647
    ) {
      return {
        ok: false,
        error: createValidationError(
          `Policy maxExecutionTimeoutMs is invalid: ${policy.maxExecutionTimeoutMs}`
        )
      };
    }

    if (timeoutMs > policy.maxExecutionTimeoutMs) {
      return {
        ok: false,
        error: createValidationError(
          `Requested timeout ${timeoutMs}ms exceeds policy maxExecutionTimeoutMs ${policy.maxExecutionTimeoutMs}ms`
        )
      };
    }
  }

  return { ok: true, value: timeoutMs };
}

const BASE_ALLOWED_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "NODE_ENV",
  "CI",
  "FORCE_COLOR",
  "NO_COLOR"
];

export function sanitizeExecutionEnvironment(
  env: NodeJS.ProcessEnv,
  allowedEnvKeys?: readonly string[]
): Record<string, string> {
  const allowedSet = new Set([
    ...BASE_ALLOWED_ENV_KEYS,
    ...(allowedEnvKeys ?? [])
  ]);

  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (
      allowedSet.has(key) &&
      !DANGEROUS_EXEC_ENV_REGEX.test(key) &&
      !SENSITIVE_KEY_REGEX.test(key) &&
      typeof value === "string"
    ) {
      sanitized[key] = value;
    }
  }

  sanitized.CI = typeof env.CI === "string" ? env.CI : "true";
  sanitized.NODE_ENV = typeof env.NODE_ENV === "string" ? env.NODE_ENV : "test";

  return sanitized;
}
