import type { HighLevelCommandName } from "./envelope.js";

const COMMON = `Common options:
  -j, --json                 Print the JSON envelope for agents and scripts; use the process exit code for outcome
  --correlation-id <id>      Correlation ID propagated into the result (default: generated)
  --idempotency-key <key>    Override the deterministic idempotency key of mutating commands
  -h, --help                 Show this help

Exit codes: 0 success/ready/passed, 1 failed, 2 invalid arguments, 3 not ready or not passed,
4 not found, 5 permission or approval required, 6 conflict/busy, 7 unknown state (reconcile the receipt before retrying).`;

const HELP: Record<HighLevelCommandName, string> = {
  "repo.inspect": `Usage: bflow repo inspect [options]

Inspect the Git repository, worktrees, project structure and bflow context. Read-only.`,
  "task.preview": "Usage: bflow task preview [--run <id>] [--json] [--compare <file>]\nRead-only execution preview; does not grant readiness or approval.",
  "task.plan": `Usage: bflow task plan --spec <file> [--workflow <file> | --write [--out <file>] [--force]] [options]

Create or check a specification's task graph and acceptance-criterion coverage.
With --workflow, checks that workflow against the specification. Otherwise derives a task graph
(one Developer task per traced task ID, no inferred dependencies) and previews it; --write
persists it to .bflow/plans/<spec-id>.workflow.json. Replacing different content needs --force.

Options:
  --spec <file>       Specification JSON (required)
  --workflow <file>   Existing workflow definition to check
  --write             Persist the derived task graph
  --out <file>        Output path inside the repository
  --force             Replace an existing plan with different content`,
  "task.implement": `Usage: bflow task implement <task-id> --run <run-id> --spec <file> [options]

Prepare a task for implementation: validate the approved specification and its stored artifact,
resolve the task and its acceptance criteria, resolve the conditional TDD policy, create the
task worktree, prepare the Developer assignment request and observe execution state.
Dispatch stays with Runtime/Coordinator (lease + fencing token); this command never starts an agent.

Options:
  --run <run-id>              Run identifier (required; must match the specification)
  --spec <file>               Approved specification JSON (required)
  --workflow <file>           Workflow definition that must contain the task
  --base <revision>           Base revision (default: HEAD)
  --attempt <id>              Attempt identifier (default: attempt-1)
  --developer <id>            Developer identifier (default: developer-1)
  --owned-path <path>         Literal owned path (repeatable; default: specification affectedPaths)
  --forbidden-path <path>     Literal forbidden path (repeatable)
  --artifact-root <dir>       ArtifactStore root (default: .bflow/state/cli/artifacts)
  --artifact-store-id <id>    ArtifactStore ID (default: bflow-cli)
  --resume                    Reconcile an interrupted invocation`,
  "verify": `Usage: bflow verify <task-id> --run <run-id> --plan <file> [options]

Run the checks of a VerificationPlan through the Verification Engine with the configured
independent gates, collect evidence into the ArtifactStore and return the VerificationResult.
Without a runner for a check the result is 'blocked', never 'passed'.

Options:
  --run <run-id>              Run identifier (required)
  --plan <file>               VerificationPlan input JSON (required; runId/taskId must match)
  --change-set <file>         GitChangeSet JSON (default: collect the prepared task worktree)
  --repair <file>             Repair record for a rework iteration
  --integration <file>        {headCommitHash, integratedTaskIds} for workflow scope
  --artifact-root <dir>       ArtifactStore root
  --artifact-store-id <id>    ArtifactStore ID`,
  "git.prepare": `Usage: bflow git prepare <run-id> [options]

Check task commits and worktrees, then (with --yes) collect submissions, create the dedicated
integration branch, merge in dependency order, detect conflicts and request workflow-level
verification. Never merges into main/protected branches, pushes or opens a pull request.

Options:
  --task <task-id>            Task to integrate (repeatable; default: all prepared tasks of the run)
  --workflow <file>           Workflow whose dependencies order the merges
  --integration-id <id>       Integration identifier (default: integration-1)
  --base <revision>           Base revision (default: HEAD)
  --yes                       Permit collecting submissions and creating the integration branch
  --resume                    Reconcile an interrupted invocation`,
  "mcp.status": `Usage: bflow mcp status [--service <id>]... [options]

Report the shared MCP Gateway and each configured backend. Read-only; never starts or stops a worker.`,
  "tool.status": `Usage: bflow tool status [--tool <id>]... [options]

Probe each catalog tool (node, pnpm, git, herdr, claude, codex, agy): path, version, digest and
remediation. Read-only; never installs anything (use bflow setup).`,
  "skills.sync": `Usage: bflow skills sync [--provider claude|codex|agy]... [options]

Synchronize approved, pinned role skills for providers through the skill manager. Idempotent:
an in-sync host performs no write.

Options:
  --provider <id>             Provider to sync (repeatable; default: all)
  --dry-run                   Show the desired state without writing
  --allow-machine-scope       Permit machine-wide skill targets
  --resume                    Reconcile an interrupted invocation`,
  "skills.scan": `Usage: bflow skills scan --source <path>... [--role <role>]... [--provider <id>]... [options]

Read-only inventory of the exact selected sources: SKILL.md bundles (directory or SKILL.md),
CLAUDE.md, AGENTS.md, GEMINI.md and Cursor rules (.cursorrules, *.mdc or a .cursor/rules directory).
Reports origin, kind, content digest, resources, dependency/tool/MCP/hook references, warnings and
duplicate groups, plus a proposed role mapping. Nothing outside the selected paths is read.

Options:
  --source <path>     Selected source (repeatable; required)
  --role <role>       Override the proposed roles (repeatable)
  --provider <id>     Providers to support (repeatable; default: claude, codex, agy)
  --version <v>       Version for the proposed bundles (default: 1.0.0)
  --name <skill-id>   Skill ID when exactly one source is selected`,
  "skills.import": `Usage: bflow skills import --source <path>... [options]

Convert selected sources into instruction-only Bflow bundles staged under
.bflow/skills/imports/<skill>/<version>/ (bundle/, verbatim original/, report.json). Secrets,
symlinks, traversal, oversized files and forged provenance block the import; executable hooks and
tool/MCP references are reported, never installed or run. Staged bundles are not usable until approved.

Options: the skills scan options, plus
  --depends-on <skill-id>   Exact pin of a builtin or approved custom skill (repeatable)
  --dry-run                 Convert and validate without writing`,
  "skills.approve": `Usage: bflow skills approve <skill-id> --digest <sha256> [--version <v>] [--expires-in-days <n>] [--approve]

Validate the exact reviewed bundle digest, its dependency pins, roles/providers and this
repository session scope. Without --approve it only prints the grant. With --approve it writes a
machine approval receipt (state/skill-approvals.json), promotes the bundle into the custom catalog
and binds the exact pin in .bflow/config.yml. Then run 'bflow skills sync --allow-machine-scope'.`,
  "skills.disable": `Usage: bflow skills disable <skill-id> [--dry-run]

Unbind a custom skill from future role manifests. Pin, catalog bytes and approval stay, so running
sessions remain recoverable. Running roles keep loaded instructions until relaunched.`,
  "skills.revoke": `Usage: bflow skills revoke <skill-id> [--version <v>] [--dry-run]

Delete this repository session's approval receipts for the skill and unbind it. Future manifests and
Runtime recovery of manifests that contain it are refused; running roles are reported for relaunch.`,
  "skills.status": `Usage: bflow skills status

Read-only: custom catalog pins, approval validity per configured role/provider, machine install
state, pending staged imports and persisted session manifests that need reconciliation.`,
  "agent.check": `Usage: bflow agent check <claude|codex|agy> [options]

Preflight health and readiness of a provider through its adapter: binary, version,
authentication, environment, MCP, launch arguments, permissions and skills. Never launches it.

Options:
  --role <role>               Role to check (default: developer)
  --mode <mode>               restricted (default) or workspace_auto
  --session <id>              Session ID used for the check scope`
};

export function getHighLevelHelp(command: HighLevelCommandName): string {
  return `${HELP[command]}\n\n${COMMON}`;
}

export const HIGH_LEVEL_SUMMARY = `Agentic SDLC commands:
  repo inspect          Inspect repository, Git, structure and context
  task preview          Read-only execution plan preview with provenance and drift
  task plan             Create or check the task graph of a specification
  task implement <id>   Prepare worktree, spec, TDD policy and assignment for a task
  verify <task-id>      Run VerificationPlan checks and return structured evidence
  git prepare <run-id>  Prepare the integration branch and request workflow verification
  mcp status            Check the MCP Gateway and backends
  tool status           Check each tool
  skills sync           Synchronize role skills for providers
  skills scan           Inventory selected IDE skills/rules (read-only)
  skills import         Stage converted custom skill bundles for review
  skills approve <id>   Approve an exact custom skill digest
  skills disable <id>   Unbind a custom skill from future manifests
  skills revoke <id>    Delete custom skill approvals and report sessions
  skills status         Custom skill pins, approvals and reconciliation
  agent check <prov>    Check provider health and readiness`;
