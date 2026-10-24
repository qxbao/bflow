export const SUPPORTED_CLI_COMMANDS = [
  "help",
  "version",
  "init",
  "config-migrate",
  "up",
  "down",
  "attach",
  "status",
  "doctor",
  "recover",
  "run",
  "approve",
  "resume",
  "cancel",
  "repo inspect",
  "task plan",
  "task implement",
  "verify",
  "git prepare",
  "mcp status",
  "tool status",
  "tools status",
  "skills sync",
  "skills list",
  "agent check",
  "docs search",
  "docs lookup",
  "docs status"
] as const;

export type SupportedCliCommand = (typeof SUPPORTED_CLI_COMMANDS)[number];

export interface CliCommandReferenceEntry {
  readonly command: string;
  readonly syntax: string;
  readonly purpose: string;
  readonly reusedEngines: readonly string[];
  readonly requiredFlags: readonly string[];
  readonly optionalFlags: readonly string[];
  readonly exitCodes: readonly { readonly code: number; readonly meaning: string }[];
  readonly idempotencyAndRetry: string;
  readonly permissionRequirements: string;
  readonly skills: readonly string[];
}

const COMMON_EXIT_CODES = [
  { code: 0, meaning: "Command succeeded without errors." },
  { code: 1, meaning: "Runtime or execution failure." },
  { code: 2, meaning: "CLI argument or option validation error." }
] as const;

export const CLI_COMMAND_REFERENCE: readonly CliCommandReferenceEntry[] = [
  {
    command: "config-migrate",
    syntax: "bflow config-migrate [--json]",
    purpose: "Validate and migrate one legacy repository config to the canonical YAML file, retaining a byte-for-byte backup.",
    reusedEngines: ["RepositoryIdentity", "RepositoryConfigCodec"],
    requiredFlags: [],
    optionalFlags: ["-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Idempotent when the canonical target matches its migration backup. Conflicting or edited configs are left untouched.",
    permissionRequirements: "Requires local filesystem access to the repository .bflow directory.",
    skills: ["using-bflow"]
  },
  {
    command: "help",
    syntax: "bflow help [command] [options]",
    purpose: "Show global CLI usage or detailed help for a specific command.",
    reusedEngines: ["HelpFormatter"],
    requiredFlags: [],
    optionalFlags: ["-j, --json"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Read-only, purely deterministic. Safe to call repeatedly without state mutation.",
    permissionRequirements: "None. Available to all actors in all environments.",
    skills: ["using-bflow"]
  },
  {
    command: "version",
    syntax: "bflow version [options] / bflow --version / bflow -v",
    purpose: "Display the current version and build information for the bflow CLI.",
    reusedEngines: ["PackageMetadata"],
    requiredFlags: [],
    optionalFlags: ["-j, --json"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Read-only. Safe to call repeatedly without state mutation.",
    permissionRequirements: "None. Available to all actors.",
    skills: ["using-bflow"]
  },
  {
    command: "init",
    syntax: "bflow init [options]",
    purpose: "Initialize bflow repository configuration and default workflow definition at the repository root.",
    reusedEngines: ["RepositoryConfigService", "DefaultWorkflowDefinition"],
    requiredFlags: [],
    optionalFlags: ["--dir <path>", "--config <path>", "--name <name>", "--provider <claude|codex|agy>", "-f, --force", "-y, --yes", "-u, --update", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Idempotent. Re-running without --force or --update verifies existing configuration without modifying it.",
    permissionRequirements: "Requires filesystem write access to the repository directory.",
    skills: ["using-bflow"]
  },
  {
    command: "setup",
    syntax: "bflow setup [options] | bflow setup --codex-hooks (--check|--plan|--apply)",
    purpose: "Review and approve Codex global hooks explicitly; choose exact snapshot approval or explicit all-hook policy; never runs normal tool/service setup.",
    reusedEngines: ["CodexHookInventory", "CodexHookApprovalStore"],
    requiredFlags: [],
    optionalFlags: ["--check", "--dry-run, --plan", "--apply", "--yes", "--codex-hooks", "--hook-digest <sha256>", "--trust-all", "--revoke-trust-all", "--dir <path>", "--catalog-dir <path>", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Inspection is read-only. Snapshot approval binds the reviewed digest. Explicit --trust-all trusts current/future hooks for the selected Codex home until --revoke-trust-all.",
    permissionRequirements: "Approval store is private and user-owned. Only the explicit Codex hook apply path can write hook approval state.",
    skills: ["using-bflow"]
  },
  {
    command: "up",
    syntax: "bflow up [options]",
    purpose: "Start or reconcile the repository headless named session and wait for required role panes.",
    reusedEngines: ["PaneManager", "EnvironmentDependencies", "HerdrSessionAdapter"],
    requiredFlags: [],
    optionalFlags: ["--timeout <ms>", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Idempotent. Reconnects to an existing healthy session or reconciles missing panes.",
    permissionRequirements: "Requires local process execution privileges and Herdr runtime access.",
    skills: ["using-bflow"]
  },
  {
    command: "down",
    syntax: "bflow down [options]",
    purpose: "Checkpoint active workflow runs and stop this repository's named session; --force bypasses stuck pane cleanup after the Runtime barrier.",
    reusedEngines: ["PaneManager", "RuntimeService", "LifecycleLock"],
    requiredFlags: [],
    optionalFlags: ["-y, --yes", "--force", "--timeout <ms>", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Idempotent. Stops only the owned named session; --force includes confirmation but still requires checkpoints and a fresh stopped-server observation. A lost stop acknowledgement is reconciled without automatic resend.",
    permissionRequirements: "Requires repository lifecycle lock ownership.",
    skills: ["using-bflow"]
  },
  {
    command: "attach",
    syntax: "bflow attach [options]",
    purpose: "Attach interactive terminal to the Conversation pane of the active session.",
    reusedEngines: ["PaneManager", "HerdrSessionAdapter"],
    requiredFlags: [],
    optionalFlags: ["-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Interactive connection. Can be re-attached whenever session is running.",
    permissionRequirements: "Requires interactive TTY terminal and active repository session.",
    skills: ["using-bflow"]
  },
  {
    command: "status",
    syntax: "bflow status [run-id] [options]",
    purpose: "Query environment status or inspect specific workflow run states and history.",
    reusedEngines: ["EnvironmentService", "RuntimeService"],
    requiredFlags: [],
    optionalFlags: ["--status <filter>", "--workflow-id <id>", "--limit <n>", "--cursor <c>", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Read-only query. Safe to execute at any time.",
    permissionRequirements: "None. Open status inspection.",
    skills: ["using-bflow"]
  },
  {
    command: "doctor",
    syntax: "bflow doctor [options]",
    purpose: "Diagnose environment health, configuration integrity, Herdr integration, and tool dependencies.",
    reusedEngines: ["EnvironmentDoctor", "ToolDependencyInspector", "PaneManager"],
    requiredFlags: [],
    optionalFlags: ["--deep (execute configured models; may consume usage)", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Read-only diagnostics. Safe to run repeatedly.",
    permissionRequirements: "Read access to repository configuration and system tools.",
    skills: ["using-bflow"]
  },
  {
    command: "recover",
    syntax: "bflow recover --yes [options]",
    purpose: "Recover from stale lifecycle locks without modifying or deleting project state.",
    reusedEngines: ["LifecycleLockRecovery", "SessionManifestStore"],
    requiredFlags: ["-y, --yes"],
    optionalFlags: ["-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Idempotent. Reclaims orphaned lock files after verifying process death.",
    permissionRequirements: "Requires explicit operator confirmation (--yes) and repository lock write access.",
    skills: ["using-bflow"]
  },
  {
    command: "run",
    syntax: "bflow run <requirement> [options]",
    purpose: "Start a new autonomous SDLC workflow run for a specified user requirement.",
    reusedEngines: ["RuntimeService", "WorkflowEngine", "CoordinatorAgent"],
    requiredFlags: ["<requirement>"],
    optionalFlags: ["--run-id <id>", "-w, --workflow <path>", "--config <path>", "--idempotency-key <key>", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Idempotent when supplied with --idempotency-key; returns existing run record if key matches.",
    permissionRequirements: "Operator privilege. Initiates background autonomous agent orchestration.",
    skills: ["using-bflow"]
  },
  {
    command: "approve",
    syntax: "bflow approve <task-id> [options]",
    purpose: "Record a human approval, rejection, or changes_requested decision for a waiting task gate.",
    reusedEngines: ["RuntimeService", "QualityGates", "HumanDecisionGate"],
    requiredFlags: ["<task-id>"],
    optionalFlags: ["--run, --run-id <id>", "--by, --actor <actor>", "--decision <decision>", "--reason <text>", "--approval-id <id>", "--revision <n>", "--generation <n>", "--idempotency-key <key>", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Idempotent under idempotency key. Superseded decisions are rejected with conflict error.",
    permissionRequirements: "Human operator only. Actor must qualify as human approver.",
    skills: ["using-bflow"]
  },
  {
    command: "resume",
    syntax: "bflow resume <run-id> [options]",
    purpose: "Resume an active or waiting workflow run that paused on approval or crash.",
    reusedEngines: ["RuntimeService", "WorkflowEngine"],
    requiredFlags: ["<run-id>"],
    optionalFlags: ["--idempotency-key <key>", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Idempotent. Safe to retry if transient error occurs during resumption.",
    permissionRequirements: "Operator privilege.",
    skills: ["using-bflow"]
  },
  {
    command: "cancel",
    syntax: "bflow cancel <run-id> [options]",
    purpose: "Cancel an active workflow run or specific task within a run.",
    reusedEngines: ["RuntimeService", "WorkflowEngine"],
    requiredFlags: ["<run-id>"],
    optionalFlags: ["--reason <text>", "--by, --requested-by <actor>", "--task, --task-id <id>", "--expected-version <n>", "--idempotency-key <key>", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Idempotent. Cancelling an already cancelled run succeeds cleanly.",
    permissionRequirements: "Operator privilege.",
    skills: ["using-bflow"]
  },
  {
    command: "repo inspect",
    syntax: "bflow repo inspect [options]",
    purpose: "Inspect repository structure, conventions, configuration, and file tree for agent intake.",
    reusedEngines: ["RepositoryInspectionEngine", "OperationLedger"],
    requiredFlags: [],
    optionalFlags: [
      "--dir <path>",
      "--include-files",
      "--max-files <n>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Read-only inspection recorded in OperationLedger. Supports --resume from prior step.",
    permissionRequirements: "Requires read access to target repository.",
    skills: ["inspect-repository", "using-bflow"]
  },
  {
    command: "task plan",
    syntax: "bflow task plan [spec-path] [options]",
    purpose: "Decompose a specification document into an actionable workflow task DAG with acceptance criteria.",
    reusedEngines: ["SpecificationEngine", "PlannerAgent", "OperationLedger"],
    requiredFlags: ["--spec <path> (or positional [spec-path])"],
    optionalFlags: [
      "-w, --workflow <path>",
      "--run-id <id>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Reuses cached plan receipt when matching idempotency key is supplied.",
    permissionRequirements: "Planner role or operator. Read access to specification.",
    skills: ["plan-tasks", "using-bflow"]
  },
  {
    command: "task implement",
    syntax: "bflow task implement <task-id> [options]",
    purpose: "Execute implementation for a task in an isolated worktree with conditional TDD enforcement.",
    reusedEngines: ["DeveloperAgent", "TestStrategyResolver", "GitOrchestrator", "OperationLedger"],
    requiredFlags: ["<task-id>", "--run-id <id>"],
    optionalFlags: [
      "--spec <path>",
      "-w, --workflow <path>",
      "--attempt-id <id>",
      "--base-revision <sha>",
      "--owned-path <path>",
      "--forbidden-path <path>",
      "--developer-id <id>",
      "--require-red-evidence",
      "--target-branch <branch>",
      "--environment <env>",
      "--auto-approve",
      "--approved-by <actor>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Supports resuming across bounded rework iterations via attemptId and OperationLedger steps.",
    permissionRequirements: "Developer agent execution in designated worktree. Bounded path modification permissions.",
    skills: ["implement-task", "conditional-tdd", "using-bflow"]
  },
  {
    command: "verify",
    syntax: "bflow verify [task-id] [options]",
    purpose: "Execute task-level or workflow-level verification against specification acceptance criteria.",
    reusedEngines: ["VerificationEngine", "QualityGates", "OperationLedger"],
    requiredFlags: [],
    optionalFlags: [
      "--run-id <id>",
      "--task-id <id>",
      "--scope <task|workflow>",
      "--spec <path>",
      "--plan <path>",
      "--change-set <path>",
      "--cycle <path>",
      "--max-iterations <n>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Produces verifiable VerificationResult receipts. Max rework cycles bounded (default: 3).",
    permissionRequirements: "Verifier/Tester role. Read-only checks with test execution sandbox.",
    skills: ["run-verification", "conditional-tdd", "using-bflow"]
  },
  {
    command: "git prepare",
    syntax: "bflow git prepare [options]",
    purpose: "Reconcile Git branches, prepare dependency-ordered integration, and validate worktrees.",
    reusedEngines: ["GitOrchestrator", "OperationLedger"],
    requiredFlags: ["--run-id <id>"],
    optionalFlags: [
      "--integration-id <id>",
      "--base-revision <sha>",
      "--task <taskKey[:deps]>",
      "--target-branch <branch>",
      "--environment <env>",
      "--auto-approve",
      "--approved-by <actor>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Atomic branch preparation and merge dry-run. Idempotent under integration receipt.",
    permissionRequirements: "Git repository branch management permissions.",
    skills: ["implement-task", "using-bflow"]
  },
  {
    command: "docs",
    syntax: "bflow docs search <library> [options] | bflow docs lookup [<library>] --query <text> [options] | bflow docs status [options]",
    purpose: "Look up current, version-specific library documentation through the shared Gateway's Context7 service; status reports whether it is reachable, authenticated and usable.",
    reusedEngines: ["DocsClient", "McpGateway"],
    requiredFlags: ["--query <text> (lookup)"],
    optionalFlags: ["--library-id <id>", "--version <version>", "--language <name>", "--no-cache", "--role <role>", "--timeout <ms>", "-j, --json", "-h, --help"],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Read-only and safe to repeat. Transient failures (network, timeout, rate limit) are retried by the Gateway only for read-only calls; results may be served from an optional local cache.",
    permissionRequirements: "Needs a Gateway registration that grants the context7 service. Inside an agent pane the agent's own registration is used; an operator outside a pane acts under the role given by --role. Queries are sent to the hosted Context7 service.",
    skills: ["use-context7", "using-bflow"]
  },
  {
    command: "mcp status",
    syntax: "bflow mcp status [options]",
    purpose: "Inspect status and health of registered Model Context Protocol (MCP) services and bridges.",
    reusedEngines: ["McpGateway", "OperationLedger"],
    requiredFlags: [],
    optionalFlags: [
      "--service <id>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Read-only probe. Safe to execute periodically without side effects.",
    permissionRequirements: "MCP gateway inspection privilege.",
    skills: ["use-gitnexus", "use-mempalace", "browser-inspection", "using-bflow"]
  },
  {
    command: "tool status",
    syntax: "bflow tool status [options] / bflow tools status [options]",
    purpose: "Inspect availability, version, and health of pinned machine and repo tools (e.g. RTK).",
    reusedEngines: ["ToolInstaller", "OperationLedger"],
    requiredFlags: [],
    optionalFlags: [
      "--tool <id>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Read-only status probe. Safe to execute repeatedly.",
    permissionRequirements: "Tool registry read access.",
    skills: ["use-rtk", "using-bflow"]
  },
  {
    command: "tools status",
    syntax: "bflow tools status [options]",
    purpose: "Alias for 'bflow tool status'. Inspect availability and health of pinned tools.",
    reusedEngines: ["ToolInstaller", "OperationLedger"],
    requiredFlags: [],
    optionalFlags: [
      "--tool <id>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Read-only status probe.",
    permissionRequirements: "Tool registry read access.",
    skills: ["use-rtk", "using-bflow"]
  },
  {
    command: "skills sync",
    syntax: "bflow skills sync [options]",
    purpose: "Synchronize approved skills from catalog to agent provider storage environments.",
    reusedEngines: ["SkillManager", "OperationLedger"],
    requiredFlags: [],
    optionalFlags: [
      "--list",
      "--provider <claude|codex|agy>",
      "--manifest-id <id>",
      "--environment-id <id>",
      "--catalog-dir <path>",
      "--store-dir <path>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Idempotent sync based on skill manifest digests. Reused receipts avoid redundant disk writes.",
    permissionRequirements: "Skill directory write access.",
    skills: ["using-bflow"]
  },
  {
    command: "skills list",
    syntax: "bflow skills list [options]",
    purpose: "List available skills from the catalog without synchronizing them.",
    reusedEngines: ["SkillManager", "OperationLedger"],
    requiredFlags: [],
    optionalFlags: [
      "--provider <claude|codex|agy>",
      "--manifest-id <id>",
      "--environment-id <id>",
      "--catalog-dir <path>",
      "--store-dir <path>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Read-only listing. Safe to call anytime.",
    permissionRequirements: "None.",
    skills: ["using-bflow"]
  },
  {
    command: "agent check",
    syntax: "bflow agent check [provider] [options]",
    purpose: "Check provider readiness and activated health against platform contracts.",
    reusedEngines: ["AgentProviderRegistry", "OperationLedger"],
    requiredFlags: [],
    optionalFlags: [
      "--provider <claude|codex|agy>",
      "--stage <preflight|activated>",
      "--environment-id <id>",
      "--correlation-id <id>",
      "--idempotency-key <key>",
      "--resume",
      "--actor <id>",
      "--role <role>",
      "--permission-mode <mode>",
      "--session-id <id>",
      "--isolation <kind>",
      "-j, --json",
      "-h, --help"
    ],
    exitCodes: COMMON_EXIT_CODES,
    idempotencyAndRetry: "Health probe. Safe to execute periodically without state mutation.",
    permissionRequirements: "Provider probe execution privilege.",
    skills: ["using-bflow"]
  }
];

export function renderCommandReferenceMarkdown(): string {
  const lines: string[] = [
    "# Bflow CLI Command Reference",
    "",
    "Autonomous SDLC workflow orchestration command reference for agents, skills, and human operators.",
    "",
    "## Supported Commands Overview",
    "",
    "All commands listed below comply with `@bflow/skills` `SupportedCommandsSchema` and provide predictable exit codes, structured JSON output (`--json`), and idempotent operation ledger tracking.",
    "",
    "| Command | Syntax | Purpose | Reused Engines | Skills |",
    "| --- | --- | --- | --- | --- |"
  ];

  for (const entry of CLI_COMMAND_REFERENCE) {
    const engines = entry.reusedEngines.join(", ");
    const skills = entry.skills.join(", ");
    lines.push(`| \`${entry.command}\` | \`${entry.syntax}\` | ${entry.purpose} | ${engines} | ${skills} |`);
  }

  lines.push("");
  lines.push("## Detailed Command Specifications");
  lines.push("");

  for (const entry of CLI_COMMAND_REFERENCE) {
    lines.push(`### \`bflow ${entry.command}\``);
    lines.push("");
    lines.push(`- **Syntax**: \`${entry.syntax}\``);
    lines.push(`- **Purpose**: ${entry.purpose}`);
    lines.push(`- **Reused Engines**: ${entry.reusedEngines.map((e) => `\`${e}\``).join(", ")}`);
    lines.push(`- **Required Flags**: ${entry.requiredFlags.length > 0 ? entry.requiredFlags.map((f) => `\`${f}\``).join(", ") : "None"}`);
    lines.push(`- **Optional Flags**: ${entry.optionalFlags.map((f) => `\`${f}\``).join(", ")}`);
    lines.push(`- **Idempotency & Retry**: ${entry.idempotencyAndRetry}`);
    lines.push(`- **Permission Requirements**: ${entry.permissionRequirements}`);
    lines.push(`- **Associated Skills**: ${entry.skills.map((s) => `\`${s}\``).join(", ")}`);
    lines.push("- **Exit Codes**:");
    for (const ec of entry.exitCodes) {
      lines.push(`  - \`${ec.code}\`: ${ec.meaning}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
