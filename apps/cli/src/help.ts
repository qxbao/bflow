import { HIGH_LEVEL_SUMMARY } from "./high-level/help.js";
import type { CliCommandName } from "./types.js";

const GLOBAL_HELP = `Usage: bflow <command> [options]

Autonomous SDLC workflow orchestration CLI.

Commands:
  init            Initialize bflow repository configuration and default workflow
  config-migrate  Migrate a legacy repository config to .bflow/config.yml
  setup           Plan and apply host environment and platform prerequisites
  up              Start/reconcile the repository environment
  down            Checkpoint and stop the repository environment
  attach          Attach to its Conversation pane
  doctor          Diagnose environment and dependencies
  recover         Recover a legacy lifecycle lock without deleting project state
  run             Start a new workflow run with a requirement
  status          Show environment; a run ID or filters query workflow runs
  approve         Record human approval, rejection, or rework request for a task
  resume          Resume an active or waiting workflow run
  cancel          Cancel an active workflow run or task
  repo inspect    Inspect repository structure, conventions, and files
  task plan       Decompose a specification into an actionable workflow task DAG
  task implement  Execute implementation for a task with conditional TDD
  verify          Execute task or workflow verification against criteria
  git prepare     Reconcile Git branches, prepare integration and worktrees
  mcp status      Inspect status of registered MCP services
  tool status     Inspect status of pinned machine and repo tools
  skills sync     Synchronize or list agent skills across providers
  agent check     Check provider readiness and activated health
  help            Show help for a command

${HIGH_LEVEL_SUMMARY}

Global Options:
  -h, --help     Show help
  -v, --version  Show version
  -j, --json     Output response in JSON envelope format

Agents and scripts should pass --json and use the process exit code; human output is for terminal reading.

Examples:
  bflow init
  bflow setup --check
  bflow run "Add user authentication feature"
  bflow repo inspect
  bflow task plan ./specs/auth.json
  bflow task implement task-1 --run-id run-101
  bflow verify task-1 --run-id run-101
  bflow git prepare --run-id run-101 --task task-a
  bflow mcp status
  bflow tool status
  bflow skills sync
  bflow agent check
  bflow status
  bflow status run-123
  bflow approve qa --decision approved
  bflow resume run-123
  bflow cancel run-123 --reason "Requirements changed"

Run 'bflow help <command>' or 'bflow <command> --help' for command-specific options.`;

const INIT_HELP = `Usage: bflow init [options]

Initialize .bflow/config.yml at the canonical Git repository root. Safe to repeat.

Options:
  --dir <path>          Target directory for initialization (default: current directory)
  --config <path>       Custom configuration file path (default: .bflow/config.yml)
  --name <name>         Project name
  --provider <kind>     Role provider: claude, codex, or agy (default: codex)
  -f, --force, -y, --yes  Explicitly replace existing configuration
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for init command

Examples:
  bflow init
  bflow init --name my-project
  bflow init --provider claude
  bflow init --dir ./subproject --force`;

const CONFIG_MIGRATE_HELP = `Usage: bflow config-migrate [--json]

Safely migrate one legacy .bflow/config.yaml or .bflow/config.json to .bflow/config.yml.
Validates before writing, saves the original as <legacy-path>.bak, and removes the active legacy file after the new config is safely written. Repeating the command reports an unchanged migration; edited targets are preserved.

Options:
  -j, --json  Output response in JSON envelope format
  -h, --help  Show help for config-migrate`;

const SETUP_HELP = `Usage: bflow setup [options]

Plan and apply machine-wide and local setup prerequisites, agent tools, and role skills.
The --codex-hooks option selects a separate hook-only review flow; it never installs tools or services.

Modes:
  --check               Audit prerequisites and diagnose drift without modifying state
  --dry-run, --plan     Generate and preview the setup plan without applying changes
  --apply               Apply planned changes (default mode)
  --repair              Repair invalid machine configuration and restore state
  --codex-hooks         Review Codex global hooks only; combine with --check, --plan, or --apply
  --hook-digest <sha256> Exact reviewed hook snapshot for non-interactive hook approval (requires --yes)

Options:
  -y, --yes             Assume yes for standard setup; hook approval also needs --hook-digest
  --dir <path>          Repository to prepare (machine installation stays user-global)
  --catalog-dir <path>  Custom skills catalog directory
  --memory-provider <id> Claude-Mem observer: auto, claude, codex, host (default: auto)
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for setup command

Examples:
  bflow setup
  bflow setup --check
  bflow setup --dry-run
  bflow setup --codex-hooks --plan
  bflow setup --apply --yes
  bflow setup --repair --yes`;

const RUN_HELP = `Usage: bflow run <requirement> [options]

Start a new workflow run with a requirement.

Arguments:
  <requirement>         Natural language requirement or user story (required)

Options:
  --run-id <id>         Explicit run identifier
  -w, --workflow <path> Path to custom workflow definition JSON file
  --config <path>       Path to configuration file (default: .bflow/config.yml)
  --idempotency-key <key> Idempotency key for run creation
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for run command

Examples:
  bflow run "Implement password reset flow"
  bflow run "Add billing webhook" --run-id run-42
  bflow run "Add caching" --workflow ./custom-workflow.json`;

const STATUS_HELP = `Usage: bflow status [run-id] [options]

Show environment status. A run ID or filters query workflow runs.

Arguments:
  [run-id]              Optional run identifier to inspect a specific run

Options:
  --status <statuses>   Filter runs by status (comma-separated: queued, running, waiting, blocked, succeeded, failed, cancelling, cancelled)
  --workflow-id <id>    Filter runs by workflow definition ID
  --limit <n>           Maximum number of runs to return (1-500)
  --cursor <cursor>     Pagination cursor
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for status command

Examples:
  bflow status
  bflow status run-123
  bflow status --status waiting,blocked
  bflow status --limit 10`;

const APPROVE_HELP = `Usage: bflow approve <task-id> [options]

Record human approval, rejection, or rework request for a task.

Arguments:
  <task-id>             Identifier of the task to approve, reject, or request changes for (required)

Options:
  --run, --run-id <id>  Workflow run identifier (required if multiple active runs exist)
  --by, --decided-by, --actor <actor>
                        Human approver identity (default: "human_operator", must be a human actor)
  --decision <decision> Decision: approved | rejected | changes_requested (default: approved)
  --reason <text>       Explanation for the decision (required for rejected and changes_requested)
  --approval-id <id>    Custom approval decision identifier
  --revision <n>        Task revision number (>= 1)
  --generation <n>      Task rework generation (>= 0)
  --idempotency-key <key> Idempotency key for decision
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for approve command

Examples:
  bflow approve qa
  bflow approve qa --run run-123 --decision approved
  bflow approve review --decision changes_requested --reason "Fix lint issues"
  bflow approve implement --decision rejected --reason "Feature cancelled"`;

const RESUME_HELP = `Usage: bflow resume <run-id> [options]

Resume an active or waiting workflow run.

Arguments:
  <run-id>              Workflow run identifier to resume (required)

Options:
  --idempotency-key <key> Idempotency key for resume operation
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for resume command

Examples:
  bflow resume run-123
  bflow resume run-123 --idempotency-key resume-key-1`;

const CANCEL_HELP = `Usage: bflow cancel <run-id> [options]

Cancel an active workflow run or task.

Arguments:
  <run-id>              Workflow run identifier to cancel (required)

Options:
  --reason <text>       Cancellation reason (default: "Cancelled by operator via CLI")
  --by, --requested-by <actor>
                        Identity of requesting actor (default: "human_operator")
  --task, --task-id <task-id>
                        Target specific task for cancellation
  --expected-version <n> Expected run aggregate version for optimistic concurrency
  --idempotency-key <key> Idempotency key for cancellation
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for cancel command

Examples:
  bflow cancel run-123
  bflow cancel run-123 --reason "Requirements changed"
  bflow cancel run-123 --task implement`;

const REPO_INSPECT_HELP = `Usage: bflow repo inspect [options]

Inspect repository structure, conventions, and files.

Options:
  --dir <path>          Repository root directory to inspect (default: current directory)
  --include-files       Include file tree listing in output
  --max-files <n>       Maximum number of files to inspect (1-10000)
  --correlation-id <id> Correlation identifier for tracing
  --idempotency-key <key> Idempotency key for operation ledger
  --resume              Resume from prior recorded step if available
  --actor <id>          Actor identity triggering inspection
  --role <role>         Agent role context (e.g., coordinator, planner)
  --permission-mode <m> Permission mode: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Session identifier
  --isolation <kind>    Isolation: provider_policy | os_sandbox | container
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for repo inspect command

Examples:
  bflow repo inspect
  bflow repo inspect --dir ./my-project --include-files --max-files 500
  bflow repo inspect --json`;

const TASK_PLAN_HELP = `Usage: bflow task plan [spec-path] [options]

Decompose a specification into an actionable workflow task DAG.

Arguments:
  [spec-path]           Path to specification JSON file (or use --spec)

Options:
  --spec <path>         Path to specification JSON file
  -w, --workflow <path> Optional path to base workflow definition
  --run-id <id>         Optional workflow run identifier
  --correlation-id <id> Correlation identifier for tracing
  --idempotency-key <key> Idempotency key for operation ledger
  --resume              Resume from prior recorded step if available
  --actor <id>          Actor identity triggering planning
  --role <role>         Agent role context (default: planner)
  --permission-mode <m> Permission mode: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Session identifier
  --isolation <kind>    Isolation: provider_policy | os_sandbox | container
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for task plan command

Examples:
  bflow task plan ./specs/auth-spec.json
  bflow task plan --spec ./specs/feature.json --workflow ./workflow.json`;

const TASK_IMPLEMENT_HELP = `Usage: bflow task implement <task-id> [options]

Execute implementation for a task with conditional TDD.

Arguments:
  <task-id>             Identifier of the task to implement (required)

Options:
  --run-id, --run <id>  Workflow run identifier (required)
  --spec <path>         Path to specification JSON file
  -w, --workflow <path> Path to workflow definition JSON file
  --attempt-id <id>     Attempt identifier for rework cycles
  --base-revision <sha> Base Git revision for implementation
  --owned-path <path>   Path owned by this task (repeatable or comma-separated)
  --forbidden-path <p>  Path forbidden to be modified (repeatable or comma-separated)
  --developer-id <id>   Assigned developer agent identifier
  --require-red-evidence Enforce failing test before implementation (TDD Red phase)
  --target-branch <b>   Target Git branch for integration
  --environment <env>   Environment name for execution
  --auto-approve        Automatically approve pre-execution review if permitted
  --approved-by <actor> Identity of approving actor
  --correlation-id <id> Correlation identifier for tracing
  --idempotency-key <k> Idempotency key for operation ledger
  --resume              Resume from prior recorded step if available
  --actor <id>          Actor identity triggering implementation
  --role <role>         Agent role context (default: developer)
  --permission-mode <m> Permission mode: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Session identifier
  --isolation <kind>    Isolation: provider_policy | os_sandbox | container
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for task implement command

Examples:
  bflow task implement task-1 --run-id run-101
  bflow task implement task-2 --run-id run-101 --owned-path src/auth --require-red-evidence`;

const VERIFY_HELP = `Usage: bflow verify [task-id] [options]

Execute task or workflow verification against criteria.

Arguments:
  [task-id]             Task identifier to verify (for task scope)

Options:
  --run-id, --run <id>  Workflow run identifier
  --task-id, --task <id> Task identifier to verify
  --scope <scope>       Verification scope: task | workflow (default: task)
  --spec <path>         Path to specification JSON file
  --plan <path>         Path to plan JSON file
  --change-set <path>   Path to Git change set JSON file
  --cycle <path>        Path to verification cycle JSON file
  --max-iterations <n>  Maximum verification iterations (1-10, default: 3)
  --correlation-id <id> Correlation identifier for tracing
  --idempotency-key <k> Idempotency key for operation ledger
  --resume              Resume from prior recorded step if available
  --actor <id>          Actor identity triggering verification
  --role <role>         Agent role context (default: tester)
  --permission-mode <m> Permission mode: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Session identifier
  --isolation <kind>    Isolation: provider_policy | os_sandbox | container
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for verify command

Examples:
  bflow verify task-1 --run-id run-101
  bflow verify --scope workflow --run-id run-101`;

const GIT_PREPARE_HELP = `Usage: bflow git prepare [options]

Reconcile Git branches, prepare integration and worktrees.

Options:
  --run-id, --run <id>  Workflow run identifier (required)
  --integration-id <id> Integration identifier
  --base-revision <sha> Base Git revision for integration
  --task <key[:deps]>   Task key and dependencies (e.g., task-b:task-a, repeatable)
  --target-branch <b>   Target Git branch
  --environment <env>   Environment name for execution
  --auto-approve        Automatically approve integration if permitted
  --approved-by <actor> Identity of approving actor
  --correlation-id <id> Correlation identifier for tracing
  --idempotency-key <k> Idempotency key for operation ledger
  --resume              Resume from prior recorded step if available
  --actor <id>          Actor identity triggering git prepare
  --role <role>         Agent role context (default: coordinator)
  --permission-mode <m> Permission mode: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Session identifier
  --isolation <kind>    Isolation: provider_policy | os_sandbox | container
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for git prepare command

Examples:
  bflow git prepare --run-id run-101 --task task-a --task task-b:task-a
  bflow git prepare --run-id run-101 --target-branch main --auto-approve`;

const MCP_STATUS_HELP = `Usage: bflow mcp status [options]

Inspect status of registered MCP services.

Options:
  --service <id>        Filter by MCP service identifier (repeatable or comma-separated)
  --correlation-id <id> Correlation identifier for tracing
  --idempotency-key <k> Idempotency key for operation ledger
  --resume              Resume from prior recorded step if available
  --actor <id>          Actor identity
  --role <role>         Agent role context
  --permission-mode <m> Permission mode: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Session identifier
  --isolation <kind>    Isolation: provider_policy | os_sandbox | container
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for mcp status command

Examples:
  bflow mcp status
  bflow mcp status --service gitnexus,rtk`;

const TOOL_STATUS_HELP = `Usage: bflow tool status [options]

Inspect status of pinned machine and repo tools.

Options:
  --tool <id>           Filter by tool identifier (repeatable or comma-separated)
  --correlation-id <id> Correlation identifier for tracing
  --idempotency-key <k> Idempotency key for operation ledger
  --resume              Resume from prior recorded step if available
  --actor <id>          Actor identity
  --role <role>         Agent role context
  --permission-mode <m> Permission mode: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Session identifier
  --isolation <kind>    Isolation: provider_policy | os_sandbox | container
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for tool status command

Examples:
  bflow tool status
  bflow tools status --tool rtk`;

const SKILLS_SYNC_HELP = `Usage: bflow skills sync [options]
   or: bflow skills list [options]

Synchronize or list agent skills across providers.

Options:
  --list                List available skills without synchronizing
  --provider <kind>     Target provider: claude | codex | agy
  --manifest-id <id>    Filter by skill manifest identifier
  --environment-id <id> Filter by environment identifier
  --catalog-dir <path>  Custom skill catalog directory
  --store-dir <path>    Custom skill storage directory
  --correlation-id <id> Correlation identifier for tracing
  --idempotency-key <k> Idempotency key for operation ledger
  --resume              Resume from prior recorded step if available
  --actor <id>          Actor identity
  --role <role>         Agent role context
  --permission-mode <m> Permission mode: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Session identifier
  --isolation <kind>    Isolation: provider_policy | os_sandbox | container
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for skills sync command

Examples:
  bflow skills sync
  bflow skills list
  bflow skills sync --provider claude --list`;

const AGENT_CHECK_HELP = `Usage: bflow agent check [provider] [options]

Check provider readiness and activated health.

Arguments:
  [provider]            Target agent provider: claude | codex | agy (or use --provider)

Options:
  --provider <kind>     Target agent provider: claude | codex | agy
  --stage <stage>       Health check stage: preflight | activated (default: preflight)
  --environment-id <id> Environment identifier
  --correlation-id <id> Correlation identifier for tracing
  --idempotency-key <k> Idempotency key for operation ledger
  --resume              Resume from prior recorded step if available
  --actor <id>          Actor identity
  --role <role>         Agent role context
  --permission-mode <m> Permission mode: restricted | workspace_auto | unattended_isolated
  --session-id <id>     Session identifier
  --isolation <kind>    Isolation: provider_policy | os_sandbox | container
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for agent check command

Examples:
  bflow agent check
  bflow agent check claude
  bflow agent check --provider codex --stage activated`;

const HELP_MAP: Record<CliCommandName, string> = {
  up: "Usage: bflow up [--timeout <milliseconds>] [--json]\nStart/reconcile this repository's headless named session and wait for required roles.",
  down: "Usage: bflow down [--yes] [--timeout <milliseconds>] [--json]\nCheckpoint active work and gracefully stop only this repository session. --yes confirms unsafe work; it never bypasses checkpoints.",
  attach: "Usage: bflow attach [--json]\nFocus Conversation and attach to an existing repository session. Run up first.",
  recover: "Usage: bflow recover --yes [--json]\nStop old Bflow commands first. Migrates only an empty legacy lock; preserves project state, agents and worktrees. Then run bflow up or bflow down --yes.",
  doctor: "Usage: bflow doctor [--json]\nCheck configuration, dependencies, named session and P13 integration.",
  init: INIT_HELP,
  "config-migrate": CONFIG_MIGRATE_HELP,
  setup: SETUP_HELP,
  run: RUN_HELP,
  status: STATUS_HELP,
  approve: APPROVE_HELP,
  resume: RESUME_HELP,
  cancel: CANCEL_HELP,
  help: GLOBAL_HELP,
  version: GLOBAL_HELP,
  "repo inspect": REPO_INSPECT_HELP,
  "task plan": TASK_PLAN_HELP,
  "task implement": TASK_IMPLEMENT_HELP,
  verify: VERIFY_HELP,
  "git prepare": GIT_PREPARE_HELP,
  "mcp status": MCP_STATUS_HELP,
  "tool status": TOOL_STATUS_HELP,
  "skills sync": SKILLS_SYNC_HELP,
  "agent check": AGENT_CHECK_HELP
};

export function getHelpText(topic?: CliCommandName): string {
  if (!topic || topic === "help") {
    return GLOBAL_HELP;
  }
  return HELP_MAP[topic] ?? GLOBAL_HELP;
}
