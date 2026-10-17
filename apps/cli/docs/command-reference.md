# Bflow high-level command reference

Stable, goal-level commands for Agentic SDLC agents and the skills that teach them. An agent
states its goal by choosing one command; the command composes the existing engines instead of
the agent chaining Git, specification, TDD, verification, tool and provider steps by hand.

The machine-readable twin of this page is [`command-reference.json`](command-reference.json).
It is generated from the same specs the parser enforces; a unit test fails when they drift.
Skill authors (SkillManager / P28) should render skills from the JSON and link this page.

| Goal | Command | Reuses |
| --- | --- | --- |
| Understand the repository | `bflow repo inspect` | read-only Git queries |
| Create/check the task graph | `bflow task plan --spec <file>` | Specification Engine (P15) traceability |
| Start work on a task | `bflow task implement <task-id> --run <run-id> --spec <file>` | P15 artifact check, Conditional TDD Resolver (P16), Git Orchestrator (P18), Runtime run state |
| Verify a task | `bflow verify <task-id> --run <run-id> --plan <file>` | Verification Engine (P17), ArtifactStore, injected independent gates |
| Prepare integration | `bflow git prepare <run-id>` | Git Orchestrator (P18) integration |
| MCP health | `bflow mcp status` | Machine setup (P26) `mcp.json`, MCP Gateway port (P27) |
| Tool health | `bflow tool status` | Machine setup (P26) tool catalog/probe |
| Sync skills | `bflow skills sync` | Machine setup (P26) `SkillsComponent` + skill manager port (P28) |
| Provider readiness | `bflow agent check <provider>` | Agent Provider Registry (P25) |

## Invocation contract

Always pass `--json`. Every recognized command writes exactly one JSON document to **stdout**,
for success and failure alike, and exits with the code in that document:

```json
{
  "ok": false,
  "command": "task.implement",
  "exitCode": 4,
  "result": {
    "schemaVersion": 3,
    "commandId": "cmd-…",
    "correlationId": "corr-…",
    "status": "failed",
    "runId": "run-1",
    "output": {
      "schemaVersion": 1,
      "command": "task.implement",
      "outcome": "failed",
      "ids": { "runId": "run-1", "taskId": "ghost" },
      "replayed": false,
      "steps": [{ "id": "load-specification", "status": "succeeded" }, { "id": "resolve-task", "status": "failed", "message": "…" }],
      "data": null
    },
    "artifacts": [],
    "error": { "code": "not_found", "retryable": false, "message": "…", "details": { "reason": "task_not_found" } },
    "observedAt": "2026-10-17T05:00:00.000Z"
  }
}
```

- `result` is a `CommandExecutionResult` from `@bflow/contracts` (validate it with
  `CommandExecutionResultSchema`); the CLI exports `HighLevelEnvelopeSchema` for the whole document.
- `result.status` is the **command** status (`succeeded`, `failed`, `waiting_user`, `unknown`).
  `output.outcome` is the **domain verdict** (`ready`, `not_passed`, …). `succeeded` never means a
  task or run succeeded; only Runtime/Quality Gates decide that.
- `output.steps` lists every step in order with `succeeded | failed | skipped | blocked | reused`,
  so a failure in the middle shows exactly which steps completed.
- IDs: `commandId` is new per invocation; `correlationId` comes from `--correlation-id`,
  then `BFLOW_CORRELATION_ID`, else is generated; `runId`/`taskId`/`idempotencyKey` are in `output.ids`.
- An unknown subcommand (no command can be identified) writes `{ "ok": false, "error": … }` to
  stderr and exits 2. `--help` with `--json` prints `{ "ok": true, "command": "help", "data": { "helpText" } }`.

### Exit codes

| Code | Name | Meaning / agent action |
| --- | --- | --- |
| 0 | SUCCESS | Done; ready; passed |
| 1 | FAILED | Operation failed; read `error` and the failed step |
| 2 | USAGE | Invalid arguments; fix the invocation |
| 3 | NOT_READY | Ran correctly, verdict negative (not ready, not passed, conflict, unapproved spec) |
| 4 | NOT_FOUND | Task, run, file, tool, service or repository not found |
| 5 | PERMISSION_REQUIRED | Risky step needs an explicit flag or approval (`error.details.permission` or `status: waiting_user`) |
| 6 | CONFLICT | Concurrent invocation (`details.reason: busy`) or idempotency key reused for another request; retry later |
| 7 | UNKNOWN_STATE | A previous invocation was interrupted; inspect, then re-run with `--resume` |

### Idempotency, retry and resume

Mutating commands record a receipt under `.bflow/state/cli/commands/` keyed by a deterministic
idempotency key (override with `--idempotency-key`). That directory must be Git-ignored
(`bflow init` installs `.bflow/.gitignore`); otherwise the command fails before writing.

- **Completed receipt**: the same request replays the stored result (`replayed: true`, first
  step `idempotent-replay`) and repeats no side effect. `task implement` still re-observes state.
- **Same key, different request**: exit 6, `details.reason: idempotency_key_reuse`.
- **Concurrent invocation of the same key**: one runs; the others exit 6 with `reason: busy`.
- **Failed receipt**: re-running executes again; engines reconcile their own partial state.
- **Interrupted receipt** (process died mid-command): `read_only`/`retry_safe` commands run again.
  `resume_required` commands exit 7 with `error.code: unknown_delivery` and the last step; they
  never repeat the side effect blindly. `--resume` reconciles through the engine's idempotent path
  (P18 identical-request reconciliation, skills re-observation before writing).

Control flags (`--json`, `--yes`, `--resume`, `--force`, `--allow-machine-scope`) are not part of
the request digest, so granting a permission on retry reuses the same key.

### Permission and safety rules

- No command dispatches an agent, sends a Herdr message, approves a gate, merges into a
  protected/main branch, pushes, opens a pull request or deploys. Runtime messages the engines
  produce are returned in `data.pendingMessages` for Runtime to deliver.
- Risky steps stop before execution and exit 5 until the operator grants them:
  `git prepare --yes`, `task plan --force` (replace a different plan),
  `skills sync --allow-machine-scope` (machine-wide targets).
- Read-only commands (`repo inspect`, `mcp status`, `tool status`, `agent check`) never install,
  start, stop or log in to anything. `agent check` only creates its empty state directory.

## Commands

### `bflow repo inspect`

Read-only: repository root/ID, branch, HEAD, upstream, dirty entries, in-progress merge/rebase,
worktrees (with Bflow-managed flag), remotes, project markers, package manager, scripts,
workspace packages, context files (`AGENTS.md`, `CLAUDE.md`, …) and `.bflow` plans.
Outcome `inspected`; exit 4 outside a Git repository.

### `bflow task plan --spec <file> [--workflow <file> | --write [--out <file>] [--force]]`

- With `--workflow`: checks the workflow against the specification's P15 traceability
  (`orphanCriterionIds`, `unmappedWorkflowTaskIds`, `unknownMappedTaskIds`). Outcome `checked`;
  exit 3 when traceability is invalid.
- Otherwise derives a task graph: one `developer` task per traced task ID, criteria by ID,
  **no inferred dependencies** (the Coordinator declares ordering). Outcome `preview`; with
  `--write` persists `.bflow/plans/<spec-id>.workflow.json` (outcome `planned`). Identical content
  is a no-op; different content needs `--force` (exit 5 otherwise).
- Invalid specification: exit 1 (`reason: invalid_specification`); missing file: exit 4.

### `bflow task implement <task-id> --run <run-id> --spec <file>`

Options: `--workflow <file>`, `--base <rev>` (HEAD), `--attempt <id>` (attempt-1),
`--developer <id>` (developer-1), `--owned-path <path>`… (default: spec `affectedPaths`; globs
must be replaced by literal paths), `--forbidden-path <path>`…, `--artifact-root <dir>`,
`--artifact-store-id <id>`, `--resume`.

Steps: `load-specification` → `check-approval` (approved + stored artifact, else exit 3) →
`check-run-binding` → `resolve-task` (exit 4 when not traced) → `resolve-tdd-policy` →
`build-context` → `open-resources` → `verify-specification-artifact` (digest/size/content of the
stored artifact) → `prepare-worktree` (P18 task worktree + branch) → `prepare-assignment` →
`observe-execution`.

`data.assignment` is a `developer_assignment_request` with `status: awaiting_runtime_dispatch`:
worktree, branch, base commit, spec ID/version/digest, TDD (`mode`, `requiresFailingTestFirst`,
target commands, test levels), the task's acceptance criteria and owned/forbidden paths. The
leased `AgentAssignment` (lease + fencing token) is issued only by Runtime through the
Coordinator. When `tdd.requiresFailingTestFirst` is true the Developer must follow
Red-Green-Refactor. `observe-execution` reports the Git task record and Runtime task status;
Herdr `done` is never treated as success. Re-run the same command to refresh the observation.

### `bflow verify <task-id> --run <run-id> --plan <file>`

`--plan` is the P17 `createVerificationPlan` input (run, task, scope, approved specification,
strategy, checks, implementer IDs, `maxIterations`). Options: `--change-set <file>` (a
`GitChangeSet`; default collects the worktree prepared by `task implement`), `--repair <file>`
(repair record for a rework iteration), `--integration <file>` (`{ headCommitHash,
integratedTaskIds }` for workflow scope, e.g. from `git prepare`), `--artifact-root`,
`--artifact-store-id`.

Returns `data.verification` (`VerificationResult`), `data.cycle` (bounded cycle status and
iteration) and `data.pendingMessages`. Evidence references are in `result.artifacts`. Exit 0
only for `passed`; `failed`, `inconclusive`, `blocked` and `escalated` exit 3. A check without a
configured independent runner yields `blocked`, never `passed`. The same change replays its
receipt; a new change or repair runs a new iteration until `maxIterations`, then escalates.

### `bflow git prepare <run-id>`

Options: `--task <task-id>`… (default: all prepared tasks of the run), `--workflow <file>`
(dependency order), `--integration-id <id>` (integration-1), `--base <rev>` (HEAD), `--yes`,
`--resume`, `--artifact-root`, `--artifact-store-id`.

Without `--yes`: read-only check of each task worktree (active, clean, commits ahead of base);
exit 5 with `status: waiting_user` and the integration preview. Uncommitted/empty worktrees exit 3
(`reason: worktree_not_ready`). With `--yes` (after every Developer released write access):
collects submissions, creates the dedicated `integration/bflow/<run>/<id>` branch, merges in
dependency order and returns `data.integration` plus `data.workflowVerification` (required,
request IDs, and the `integration` input for `bflow verify`). A merge conflict exits 3 with
outcome `conflict_detected` and the conflicting paths; resolution stays with the Coordinator.

### `bflow mcp status [--service <id>]…`

Reads `$XDG_CONFIG_HOME/bflow/mcp.json`, checks pinned stdio executables (presence + digest)
and asks the shared MCP Gateway for backend health. Exit 0 only when the Gateway is reachable
and every selected backend is healthy; no Gateway configured, invalid config or unhealthy
backends exit 3; unknown `--service` exits 4.

### `bflow tool status [--tool <id>]…`

Probes `node`, `pnpm`, `git`, `herdr`, `claude`, `codex`, `agy`: status (`present`, `missing`,
`version_mismatch`, `path_missing`, …), version vs requirement, path, binary digest and manual
remediation. Required tools are the catalog defaults, or every `--tool` given. Exit 3 lists
`data.blocking`; unknown tool exits 4. Installation is `bflow setup`, never this command.

### `bflow skills sync [--provider claude|codex|agy]… [--dry-run] [--allow-machine-scope] [--resume]`

Observes installed skills, resolves the pinned desired state and writes only when they differ
(`already_synced` otherwise). `--dry-run` previews. Machine-wide targets need
`--allow-machine-scope` (exit 5). After writing, a post-check must observe the desired digest or
the command fails (`reason: sync_not_converged`). Without an integrated skill manager it fails
with `reason: skills_synchronizer_not_configured` (exit 1).

### `bflow agent check <claude|codex|agy> [--role <role>] [--mode restricted|workspace_auto] [--session <id>]`

Builds a session-scoped `AgentEnvironment` (default `restricted`, read-only, network denied) and
runs the provider adapter's preflight: binary, version, authentication, environment, MCP,
launch arguments, permissions, skills. Exit 0 only for `ready`; `blocked`/`unsupported` exit 3
with each check's code and remediation. Preflight is not activated readiness: `bflow up` still
requires an authenticated launch attestation from the running pane.

## Typical agent flow

```sh
bflow repo inspect --json
bflow tool status --json && bflow agent check claude --json
bflow task plan --spec spec.json --write --json
bflow task implement implement --run run-1 --spec spec.json --json   # then Runtime dispatches the Developer
bflow verify implement --run run-1 --plan verify-plan.json --json     # 3 → read findings, rework
bflow git prepare run-1 --json                                         # 5 → human/Coordinator grants --yes
bflow git prepare run-1 --yes --json                                   # → workflow verification request
```

## Current limitations

- Dispatch, leases, Herdr delivery and approvals remain Runtime/Coordinator work; these commands
  return requests and pending messages instead. Wiring them into the P30 Runtime facade is
  integration work.
- `task implement` observes the legacy RuntimeService run store when `.bflow/config.yaml` exists;
  P19 agentic run state is not yet exposed through a Runtime facade.
- The P18 Git engine needs Linux `flock`; on other hosts `task implement`, `verify` (without
  `--change-set`) and `git prepare` fail at the `open-resources` step (exit 1, e.g. `spawn flock ENOENT`)
  before any side effect; the failed receipt does not block a later retry.
- No MCP Gateway (P27) or skill manager (P28) implementation is composed by default, so
  `mcp status` reports not ready and `skills sync` reports not configured until they are integrated.
- `verify` has no default independent gate runners; hosts inject them (`HighLevelServices.gates`).
