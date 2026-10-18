# Bflow CLI environment lifecycle (P12)

Build from the repository root with `pnpm build`, then run
`node apps/cli/dist/bin.js <command>` (or the installed `bflow` executable).
Node >=22.13 and the root's pinned pnpm are required for the existing storage runtime.
Lifecycle locking requires Linux `flock` from util-linux on PATH.


## First-time setup

From a source checkout, run `pnpm build`, then `node apps/cli/dist/bin.js setup`.
Setup previews the machine plan and asks once before applying it in an interactive
terminal. Use `setup --yes` to approve that plan without a prompt. `--check` and
`--dry-run` observe without creating directories, changing shell files or installing
software. A non-interactive invocation without `--yes` reports the missing approval
and exits with status 1.

Machine installation belongs to the current account and works across repositories;
`--dir` selects repository context without putting machine installs inside its
`.bflow` directory. The CLI installs an owned `bflow` launcher and manages its PATH
entry. Existing shell configuration is preserved. An already-open parent shell
cannot receive environment changes from a child process; the output explains how
to load the managed PATH when needed.

Default setup uses the reviewed, exact-version tool catalog for the supported
platform: Herdr, Claude Code, Codex, Agy, RTK, GitNexus, Chrome DevTools MCP,
Superpowers and Claude-Mem.
Explicit machine pins are preserved. Provider login remains the account owner's
interactive action; installing a CLI does not establish authentication. Claude-Mem
uses `--memory-provider auto` by default: preserve an existing compatible subscription
route, otherwise select a verified Claude subscription login or a file-backed Codex
ChatGPT login. This uses that account's quota. `claude`, `codex`, and `host` are explicit
overrides; `host` requires a preexisting local observer. Setup never signs up for a
hosted memory subscription. Upstream
license conditions are shown in the installation diagnostics.

Setup configures the shared MCP Gateway as a current-user service and verifies
upstream MCP negotiation and tool discovery. GitNexus indexing is scoped to the
selected Git repository; outside a repository, installation proceeds and indexing
is deferred until `bflow setup --dir <repository>`. Chrome uses a separate Bflow
profile. Workflow roles connect to the background Gateway through its private
`gateway-control.json` locator in the Gateway state directory. `bflow up` passes that
locator to the host when it exists; setup does not establish those role connections.

The result includes every step receipt and the final machine doctor report.
Applied steps display their receipt status instead of a pending approval label.
Partial application, failed health checks and missing approval return a nonzero
exit status. A dry run with planned changes remains a successful preview.

Codex global hooks have a separate review flow and are not approved by normal
`setup --yes`. Use `bflow setup --codex-hooks --plan` or `--check` to inspect the
current hooks, commands, dependency file digests, and snapshot digest without
writing approval state. `bflow setup --codex-hooks --apply` shows that inventory
and asks for interactive approval. Non-interactive approval must pass both
`--yes` and the exact `--hook-digest <sha256>` printed by the current review.
Approval is tied to the inspected Codex home and hook snapshot; any changed hook
or dependency needs a new review. This grants approval only for the inspected
Codex hooks; it does not widen Bflow permissions or provide an OS sandbox. The
inventory pins direct local scripts and resolved interpreters, not arbitrary
transitive packages or runtime data; unsupported dynamic shell forms remain blocked.
Explicitly enabled plugin hook sources are included when their local installation
can be resolved unambiguously. Setup review and Runtime launches use the same
environment with outer Orca pane selectors cleared only for Bflow child processes.
Startup readiness errors retain the per-role diagnostic report (up to 256 lines /
64,000 characters) after terminal sanitization and credential redaction, and direct
hook failures point to the hook-only plan command.
Credential redaction also covers opaque command-line flags, environment assignments and JSON credential fields,
including quoted values whose closing quote is missing from truncated subprocess output.

| Command | Behavior |
| --- | --- |
| `bflow init [--provider claude\|codex\|agy]` | Creates `.bflow/config.yml` and `.bflow/.gitignore` at the canonical Git root. Default provider is Codex. Repeat init preserves configuration; explicit `--force`/`--yes` replaces it. Does not invoke Herdr. |
| `bflow config-migrate` | Validates one legacy `.bflow/config.yaml` or `.bflow/config.json`, writes `.bflow/config.yml`, saves the original bytes as `<legacy-path>.bak`, then removes the active legacy file. Conflicting sources or targets fail without overwriting. |
| `bflow setup --codex-hooks --plan\|--check\|--apply` | Inspects the selected Codex home and reviews only global hooks. Plan/check are read-only; apply requires an interactive decision or `--yes --hook-digest <sha256>`. Never installs tools or services. |
| `bflow up [--timeout <ms>]` | Checks executables, provider authentication and Herdr protocol; starts a named server, prepares the persistent P19 host with platform readiness (refusing to start panes when a required role is blocked), then calls P13. Waits for every required role and host activation acknowledgement before recording ready. Persists validated bindings and reuses live roles. |
| `bflow attach` | Requires an existing manifest and a running matching session. Calls P13 to focus/validate Conversation, then runs `herdr session attach <name>` with inherited terminal I/O. |
| `bflow down [--yes] [--timeout <ms>]` | Inspects active runs and dirty files. Refuses unsafe shutdown without confirmation. Quiesces Runtime intake/dispatch, recollects runs, requires durable aggregate checkpoints, calls P13 graceful shutdown, then stops only the named session. Deletes no worktree, database, artifact, commit or source file. |
| `bflow status` | Reports configuration, named server, panes/agents and missing executables. Labels persisted observations as potentially stale. Does not open the legacy workflow Runtime. |
| `bflow recover --yes` | After stopping old CLI commands, migrates only an empty legacy lifecycle lock. Preserves state, panes, source and worktrees. |
| `bflow doctor` | Reports Node/Git/pnpm/Herdr/agent dependencies, configuration/identity, permissions, lifecycle lock and P13 doctor findings. Returns exit 1 when checks fail. |

All commands support `--json`. Timeouts are milliseconds, 1–600000. `doctor` returns
a diagnostic report even when unhealthy; the JSON envelope's `ok: true` means the
report was produced, while `data.healthy` and exit code indicate environment health.
`status` similarly returns exit 1 for invalid configuration. `status <run-id>` or
status filters retain the existing workflow-run commands. Existing explicit
`.bflow/config.yaml` and `.bflow/config.json` remain readable for compatibility when
`.bflow/config.yml` is absent. Run `bflow config-migrate` to move one legacy config
to the canonical path. `bflow init` will preserve and reject a legacy file until it
has been migrated.

Configuration uses ordinary YAML 1.2 block style with comments. Agent roles are
at the top; set each role's `cli`, optional `model`, and optional `effort` there.
Omitting `model` uses the provider default. `effort` accepts `minimal`, `low`,
`medium`, `high`, `xhigh`, or `max`, subject to the selected provider's support;
Agy encodes effort in the model name and therefore rejects a separate `effort`.
Defaults cover the existing workflow, SDD approval, conditional TDD, bounded
verification and concurrency. The default composition passes these policies to
the persistent P19 host; P12 does not implement Coordinator or workflow policy
logic. Duplicate keys, multiple documents, non-string mapping keys, explicit tags,
merge keys and cyclic or excessive aliases are rejected. A config copied/moved to
another checkout fails identity validation instead of attaching to the original
repository. A dynamically spawned Developer role without its own role entry
inherits the Coordinator's provider, model and effort.

Session identity is `bf-` plus 20 hexadecimal characters of SHA-256 over the
canonical checkout root and absolute Git directory. Equal repository basenames
therefore remain isolated; linked worktrees have distinct identities. Herdr
commands receive `HERDR_SESSION` explicitly. Inherited `HERDR_SOCKET`, pane,
remote and other caller context is removed. No socket path is constructed or
managed by Bflow. Explicit `HERDR_CONFIG_PATH` is retained.

## CLI Output Presentation, Progress, and Error Handling

### Color Precedence and Stream Resolution
Bflow CLI formats human terminal output using a dedicated presentation engine without external dependencies. Color capabilities are resolved independently for `stdout` and `stderr`:
1. **Explicit options**: Respected when provided via `CliContext.presentation` or formatter options.
2. **`NO_COLOR`**: In the absence of an explicit option, non-empty `NO_COLOR` disables color output, overriding `FORCE_COLOR`.
3. **`FORCE_COLOR="0"`**: Disables color output.
4. **`FORCE_COLOR` (non-zero)**: Explicit non-zero values enable color output, including across piped streams (`isTTY: false`).
5. **Terminal detection**: Otherwise, colors are enabled if the target stream has `isTTY: true` and `TERM !== "dumb"`.
6. **Structured JSON**: When `--json` or `-j` is passed, output is guaranteed to be plain deterministic JSON with zero ANSI escape codes.
7. **Custom I/O Collectors**: Caller-supplied `io` collectors (e.g. in test suites or programmatic embeds) default to plain, non-interactive output unless explicitly opting in via `context.presentation`.

### Real-Time Observational Progress
- Lifecycle and long-running commands (`up`, `down`, `attach`, `init`, etc.) stream real-time progress steps to human interactive `stderr` only.
- Progress steps use sequential `[1]`, `[2]`, … markers (bold cyan when color is active). Setup plan summaries and both high-level command formatters use the same numbered layout and readable component labels.
- Indented, dim detail logs stream beneath the active step. Setup reports process start/exit/timing and component diagnostics; command arguments and raw provider output are excluded from these process observations.
- Interactive executable output shows an animated loading skeleton while work is pending. Before setup confirmation, it clears the animation and shows an awaiting-input skeleton above the prompt; redraws pause while the user types. Late progress observations are buffered until input finishes (the latest 50, with an omission count when exceeded). Timers and mutable lines are cleared on completion or error, and animations are disabled during Herdr attach.
- Pipes, JSON, help/version and default custom collectors remain static. Embedders can provide `CliIo.progress` for transient lines and `CliIo.stderrRaw` for raw animated chunks when explicitly opting into interactive presentation.
- Progress reporting is strictly informational (emitting in-flight phase transitions only) and never emits premature conclusive success claims (e.g. `Environment ready` or `Environment stopped`). Conclusive success is reported exclusively by command formatters after underlying operations, state persistence, and resource cleanup succeed.
- `FORCE_COLOR` never enables progress streaming; progress strictly requires an interactive `stderr` stream (`isTTY: true && TERM !== "dumb"`).
- Help and version commands never emit progress.

### Actionable Error Format
Human error output follows a bounded, actionable format:
```text
Error [<code>]: <concise bounded explanation>
Details: <safe scalar details: stage, role, provider, paneId, sessionId, workspaceRoot, taskId, runId>
Next: <specific actionable next step>
```
- **Sanitization & Redaction**: All human dynamic fields are stripped of ANSI escapes, C0 control characters (including carriage return `\r`), and C1 control sequences (`\u0080`–`\u009F`). Dynamic text is bounded against runaway terminal/subprocess dumps, and automatically redacted for sensitive tokens (`ghp_*`, `gho_*`, `ghu_*`, `ghs_*`, `ghr_*`, `sk-*`, `sk-ant-*`, Bearer tokens, JWTs, generic PKCS#8 / algorithm PEM private keys, passwords, and API keys).
- **Handled JSON Intact**: Machine-readable JSON envelopes (`--json`) preserve exact unredacted error details and data structures for tooling integration.
- **Single-Envelope Ownership**: Unexpected runtime errors and lifecycle close failures are validated against `ContractErrorSchema` and emitted in a single authoritative envelope, preventing conflicting output.

### Status and Shutdown Truthfulness
- `formatDownOutput` strictly enforces that an environment status only permits claiming `[OK] Environment stopped` when the Herdr server process is confirmed stopped (`server: "stopped"`). A running server with missing or `down` manifest is never reported as stopped. For session manifests, `status: "down"` is required.

### Interactive Attach Limitations
`bflow attach` focuses the Conversation pane and invokes Herdr's interactive terminal attach (`herdr session attach <name>`).
- **Limitation**: While `attach --json` returns an error envelope on non-interactive failure, an interactive attach session inherits Herdr's interactive TUI standard I/O streams and cannot provide a purely headless, pipe-safe JSON stream while attached.
- Upon session exit, the human CLI truthfully reports `[OK] Returned from Conversation attach.`.

## Default host and physical topology composition

P13 is composed automatically through `PaneManagerLifecycleAdapter`. It adapts
`initializeTopology` / `reconcileTopology` to lifecycle `up`,
`focusConversationPane` to `attach`, and `inspectTopologyHealth` followed by
schema-validated manifest reads to `getManifest` / `doctorSession`.
Before P13 starts roles, the default integration prepares the persistent Runtime
host and obtains trusted role prompts, MCP configuration and provider lifecycle
hooks. Readiness is not keyed to a provider name: the host's provider preflight
reports `ready`, `blocked` or `unsupported` per role with the adapter's reason, and
`up` returns that report before any pane is created when a required role is not
ready. Roles prepared with a v3 launch profile start with their provider's launch
arguments; hosts without one fall back to the legacy Claude/Codex prompt injection.
`bflow up` sends the machine-scoped platform options (machine, repository, role
providers, permission modes, skill pins, the builtin skill store and the Gateway
locator when present) to the host, and it never reads or prints launch environment
values. The host
survives CLI process exit and owns scheduling, authenticated message ingress, run
queries and shutdown checkpoints. `doctor` and environment `status` inspect
topology without starting a daemon. `up` checks `codex login status` or Claude's
structured `auth status`; it does not print provider account diagnostics or infer
authentication from an idle pane. First-use provider trust prompts can still block
startup and require operator action in that named session.

P13 receives an argv runner that explicitly selects this repository's named
session. No global process environment is changed. Role CLI names must be supported
Herdr agent kinds on PATH; custom executable paths and dynamic Developer roles
cannot be configured as permanent roles.

The adapter uses `FileSessionManifestStore` under `.bflow/state/panes/` rather
than P13's default in-memory store. It validates repository identity on both reads
and writes. P13 owns all workspace/tab/pane creation, agent startup and recovery
logic. CLI never fabricates physical IDs. Both CLI and P13 are built through the
CLI's TypeScript project reference; no manual composition module is needed for
`up`, `attach`, `status` or `doctor`.

Shutdown uses the host's real intake/dispatch barrier, authoritative `findRuns`
and `getRun` queries and persisted aggregate checkpoints. P13's `shutdownTopology`
closes recorded panes only after those barriers succeed, then CLI stops only the
repository's named Herdr session and explicitly stops the host. No no-op barrier
or synthetic checkpoint is used. The local lifecycle seam uses the existing
`CreateCheckpointCommand` and `RecoveryCheckpoint` contracts.

Embedders pass `CliContext.environment.integration` or `openIntegration(input)`.
To override the default P13 composition in the executable, the operator can set `BFLOW_ENVIRONMENT_MODULE` to an absolute
ESM module exporting:

```ts
export async function openBflowEnvironment({ repository, config, env }) {
  // Compose real P13 and Runtime implementations here.
  return {
    manager, // SessionLifecycleManager, configured for repository.sessionName/root
    runtime, // Pick<RuntimeService, "findRuns" | "getRun">; authoritative repository run queries
    quiesce, // (OperationOptions) => OperationResult<void>
    checkpoint, // (CreateCheckpointCommand, OperationOptions) => OperationResult<RecoveryCheckpoint>
    activate, // optional; acknowledge host startup after the role manifest is up
    shutdownHost, // optional; stop host after checkpoints/panes/session are preserved
    close // optional; closes composition handles, never stops the live session
  };
}
```

`quiesce` must stop intake/dispatch and drain in-flight state writes for **all**
repository runs. `checkpoint` must persist the authoritative aggregate, including
approval, cancellation and recovery state, before returning its receipt. Returning
an unpersisted snapshot is not sufficient. Schema/identity/version/sequence
checks run at ingress. The factory is selected only through the operator's
environment, never through repository configuration.

The physical adapter's doctor report describes only topology; a healthy pane does
not prove an SDLC run passed. A custom integration missing authoritative Runtime
shutdown operations remains guarded, including with `--yes`. Provider hooks,
role tools and workflow evidence require separate live verification. No full SDLC
end-to-end claim follows from lifecycle checks.

## Recovery and verification

Runtime state is under `.bflow/state/`, with atomically replaced `session.json`
and `operation.json`. P13's authoritative manifest is
`.bflow/state/panes/<session>.manifest.json`; the CLI's `session.json` is its last
validated observation. An active session's manifest is refreshed through P13
health inspection before status/readiness decisions. A persistent kernel `flock`
on `lifecycle.guard` serializes up/down/recover and releases on Ctrl+C, SIGKILL or
crash. Never delete this guard inode. A legacy empty `lifecycle.lock` directory
requires explicit `bflow recover --yes` after stopping old CLI commands; unrelated
contents are never recursively removed. Unresolved role/server
startup or shutdown delivery is retained. A pending startup can resume through
P13 only when its validated physical topology receipt exists; missing receipts
continue to forbid resend. A partial first startup can be shut down using that
same receipt, with the normal Runtime barriers. A blocked role remains available for
inspection and is recorded as degraded. No automatic forced kill is used during
shutdown timeout. These guarantees target local filesystems and cooperative
same-user processes; power-loss recovery and multi-host operation are unverified.

The headless server's detached log relay writes a private mode-0600 log. It
buffers complete lines across chunks before redaction, suppresses multiline PEM
private keys and discards oversized log lines. These local logs are diagnostics,
not trusted task-success evidence.

From the repository root:

```sh
pnpm build
pnpm --filter @bflow/cli test
BFLOW_TEST_LIVE_HERDR=1 pnpm exec vitest run apps/cli/test/environment-live.test.ts
pnpm check:deps
pnpm typecheck
pnpm test
git diff --check
git status --short
```

Fake-runner tests cover equal repository names, canonical/symlink identity,
repeat init/up, attach-before-up, blocked/missing roles, launch failure, timeout
delivery ambiguity, lock contention, foreign manifests/attach targets,
confirmation/checkpoint/graceful shutdown, and selective stop. Additional tests
exercise the actual P13 class and file store through a stateful fake Herdr process
runner: seven-role topology, persistence across CLI invocations, duplicate prevention,
live health changes, Conversation focus, foreign manifests, scoped session env,
blocked startup, unresolved-delivery diagnostics, cancellation, and missing Runtime shutdown APIs. The opt-in live
test creates two isolated named headless sessions with a short temporary XDG
configuration root, verifies protocol 22, stops one while the other stays running,
and stops both before deleting test data. It never starts agents or opens TUI.

Herdr 0.9.0 was observed to support `HERDR_SESSION`, `herdr server`,
`status server --json`, protocol 22/schema 1, and `session stop <name> --json`.
Long XDG/profile paths can exceed Linux Unix-socket path limits. Bflow surfaces
the Herdr error; operators can select a shorter `XDG_CONFIG_HOME` consistently
for their environment. Bflow does not guess or redirect socket paths.

Before the first Agentic `up`, owners can add `.bflow/verification.json` for
Node TAP or Vitest 2.1 behavioral checks. The host pins this authority; Coordinator
cannot choose arbitrary shell commands. Automated checks require Linux Bubblewrap
and explicitly available dependencies. See [configuration and limits](../../docs/verification-runners.md).

Chat/Coordinator load their complete installed original prompts before the first
turn. Claude uses a launch-local prompt file; Codex file launches use native
`model_instructions_file`. Missing or unsafe assets fail clearly. Existing panes
are preserved until an explicit checked restart; no silent conversation reset.
Native startup waits for authenticated SessionStart receipts within the command
deadline. A blocked provider reports the role, provider, exact pane/session and
manual remediation without returning raw terminal output or accepting dialogs.

## High-level Agentic SDLC commands (P29)

`bflow repo inspect`, `task plan`, `task implement`, `verify`, `git prepare`, `mcp status`,
`tool status`, `skills sync` and `agent check` give agents one goal-level command each. They
reuse the Specification Engine, Conditional TDD Resolver, Verification Engine, Git Orchestrator,
machine setup tool/MCP/skills components and the Agent Provider Registry through ports in
`src/high-level/services.ts` and `HighLevelCliFacade`; the CLI adds parsing, ingress validation,
idempotency receipts, permission stops and the structured envelope, never scheduling, gates or approvals.

Every command supports `--help` and `--json`. With `--json` the result is one
`CommandExecutionResult`-based envelope on stdout and the process exit code matches it
(0 success, 1 failed, 2 usage, 3 not ready, 4 not found, 5 permission required, 6 conflict,
7 unknown state). Mutating commands keep receipts in `.bflow/state/cli/` and `.bflow/state/commands/`
(must be Git-ignored), replay completed requests, serialize concurrent invocations and refuse to
repeat an interrupted non-idempotent step until `--resume`.

Agents and scripts should pass `--json`, parse the single envelope, and use the process exit
code as the authoritative command result. Human output summarizes the command, its ordered
steps, relevant domain findings and any next action; it does not print the complete result data.
Color is resolved per output stream, and progress appears only on interactive human stderr. A
successful command can still report a negative domain outcome such as `not_passed` or
`not_ready`; those outcomes retain their documented exit codes.

See [docs/command-reference.md](docs/command-reference.md), the generated
[docs/command-reference.json](docs/command-reference.json) (checked by a unit test), and
[COMMAND_REFERENCE.md](./COMMAND_REFERENCE.md) for the full contract and skill bindings,
including current limitations (Linux `flock` for the P18 engine; MCP Gateway and verification
gate runners still require real injected or composed ports). The default CLI Skills synchronizer
uses the real skill manager and store with the pinned builtin catalog, while explicitly supplied
service ports remain in effect. `bflow mcp status` reports `not_ready` without a Gateway health
observation; a configured MCP file alone does not establish backend health.

### High-level command summary

| Command | Purpose | Reused SDLC engines | Key flags |
| --- | --- | --- | --- |
| `bflow repo inspect` | Inspects workspace structure, conventions, and Git status for agent intake. | `ProjectContextService`, Git inspection | `--dir <path>`, `--include-files`, `--max-files <n>` |
| `bflow task plan` | Decomposes a specification into a validated task DAG with acceptance criteria. | `SpecificationEngine`, Planner Agent | `--spec <path>`, `-w, --workflow <path>`, `--run-id <id>` |
| `bflow task implement` | Implements a task in an isolated Git worktree under conditional TDD rules. | `DeveloperAgent`, `TestStrategyResolver`, `GitOrchestrator` | `<task-id>`, `--run-id <id>`, `--require-red-evidence` |
| `bflow verify` | Executes task-level or workflow-level verification against acceptance criteria. | `VerificationEngine`, `QualityGates` | `[task-id]`, `--scope <task\|workflow>`, `--spec <path>` |
| `bflow git prepare` | Prepares dependency-ordered branch integration and validates worktrees. | `GitOrchestrator` | `--run-id <id>`, `--target-branch <branch>`, `--auto-approve` |
| `bflow mcp status` | Probes registered MCP tools and bridge connectivity. | `McpGateway` | `--service <id>` |
| `bflow tool status` | Checks availability, version, and health of pinned tools (e.g. RTK). | `ToolInstaller`, `ToolCatalog` | `--tool <id>` (alias: `bflow tools status`) |
| `bflow skills sync` | Synchronizes approved skills from catalog to agent provider storage. | `SkillManager`, `SkillStore` | `--list`, `--provider <claude\|codex\|agy>` |
| `bflow agent check` | Validates provider readiness and activated health against contracts. | `AgentProviderRegistry` | `--provider <claude\|codex\|agy>`, `--stage <preflight\|activated>` |

```bash
pnpm --filter @bflow/cli build
pnpm exec vitest run apps/cli/test/high-level
```
