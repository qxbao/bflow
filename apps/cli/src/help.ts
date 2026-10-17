import { HIGH_LEVEL_SUMMARY } from "./high-level/help.js";
import type { CliCommandName } from "./types.js";

const GLOBAL_HELP = `Usage: bflow <command> [options]

Autonomous SDLC workflow orchestration CLI.

Commands:
  init       Initialize bflow repository configuration and default workflow
  up         Start/reconcile the repository environment
  down       Checkpoint and stop the repository environment
  attach     Attach to its Conversation pane
  doctor     Diagnose environment and dependencies
  recover    Recover a legacy lifecycle lock without deleting project state
  run        Start a new workflow run with a requirement
  status     Show environment; a run ID or filters query workflow runs
  approve    Record human approval, rejection, or rework request for a task
  resume     Resume an active or waiting workflow run
  cancel     Cancel an active workflow run or task
  help       Show help for a command

${HIGH_LEVEL_SUMMARY}

Global Options:
  -h, --help     Show help
  -v, --version  Show version
  -j, --json     Output response in JSON envelope format

Examples:
  bflow init
  bflow run "Add user authentication feature"
  bflow status
  bflow status run-123
  bflow approve qa --decision approved
  bflow resume run-123
  bflow cancel run-123 --reason "Requirements changed"

Run 'bflow help <command>' or 'bflow <command> --help' for command-specific options.`;

const INIT_HELP = `Usage: bflow init [options]

Initialize .bflow/config.yaml at the canonical Git repository root. Safe to repeat.

Options:
  --dir <path>          Target directory for initialization (default: current directory)
  --config <path>       Custom configuration file path (default: .bflow/config.yaml)
  --name <name>         Project name
  --provider <kind>     Role provider: claude or codex (default: codex)
  -f, --force, -y, --yes  Explicitly replace existing configuration
  -j, --json            Output response in JSON envelope format
  -h, --help            Show help for init command

Examples:
  bflow init
  bflow init --name my-project
  bflow init --provider claude
  bflow init --dir ./subproject --force`;

const RUN_HELP = `Usage: bflow run <requirement> [options]

Start a new workflow run with a requirement.

Arguments:
  <requirement>         Natural language requirement or user story (required)

Options:
  --run-id <id>         Explicit run identifier
  -w, --workflow <path> Path to custom workflow definition JSON file
  --config <path>       Path to configuration file (default: .bflow/config.yaml)
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

const HELP_MAP: Record<CliCommandName, string> = {
  up: "Usage: bflow up [--timeout <milliseconds>] [--json]\nStart/reconcile this repository's headless named session and wait for required roles.",
  down: "Usage: bflow down [--yes] [--timeout <milliseconds>] [--json]\nCheckpoint active work and gracefully stop only this repository session. --yes confirms unsafe work; it never bypasses checkpoints.",
  attach: "Usage: bflow attach [--json]\nFocus Conversation and attach to an existing repository session. Run up first.",
  recover: "Usage: bflow recover --yes [--json]\nStop old Bflow commands first. Migrates only an empty legacy lock; preserves project state, agents and worktrees. Then run bflow up or bflow down --yes.",
  doctor: "Usage: bflow doctor [--json]\nCheck configuration, dependencies, named session and P13 integration.",
  init: INIT_HELP,
  run: RUN_HELP,
  status: STATUS_HELP,
  approve: APPROVE_HELP,
  resume: RESUME_HELP,
  cancel: CANCEL_HELP,
  help: GLOBAL_HELP,
  version: GLOBAL_HELP
};

export function getHelpText(topic?: CliCommandName): string {
  if (!topic || topic === "help") {
    return GLOBAL_HELP;
  }
  return HELP_MAP[topic] ?? GLOBAL_HELP;
}
