# Bflow CLI environment lifecycle (P12)

Build from the repository root with `pnpm build`, then run
`node apps/cli/dist/bin.js <command>` (or the installed `bflow` executable).
Node >=22.13 and the root's pinned pnpm are required for the existing storage runtime.
Lifecycle locking requires Linux `flock` from util-linux on PATH.

| Command | Behavior |
| --- | --- |
| `bflow init [--provider claude\|codex]` | Creates `.bflow/config.yaml` and `.bflow/.gitignore` at the canonical Git root. Default provider is Codex. Repeat init preserves configuration; explicit `--force`/`--yes` replaces it. Does not invoke Herdr. |
| `bflow up [--timeout <ms>]` | Checks executables, provider authentication and Herdr protocol; starts a named server, prepares the persistent P19 host and trusted role MCP/hooks, then calls P13. Waits for every required role and host activation acknowledgement before recording ready. Persists validated bindings and reuses live roles. |
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
`.bflow/config.json` remains readable by legacy Runtime commands; environment
commands require the new configuration.

Configuration uses the JSON flow-style subset of YAML 1.2. Edit it as JSON;
indentation-style YAML, custom tags and aliases are not supported. This avoids a
new dependency/lockfile change in the shared P11 baseline. Defaults cover roles,
the existing workflow, SDD approval, conditional TDD, bounded verification and
concurrency. The default composition passes these policies to the persistent P19
host; P12 does not implement Coordinator or workflow policy logic. A config copied/moved to another checkout
fails identity validation instead of attaching to the original repository.

Session identity is `bf-` plus 20 hexadecimal characters of SHA-256 over the
canonical checkout root and absolute Git directory. Equal repository basenames
therefore remain isolated; linked worktrees have distinct identities. Herdr
commands receive `HERDR_SESSION` explicitly. Inherited `HERDR_SOCKET`, pane,
remote and other caller context is removed. No socket path is constructed or
managed by Bflow. Explicit `HERDR_CONFIG_PATH` is retained.

## Default host and physical topology composition

P13 is composed automatically through `PaneManagerLifecycleAdapter`. It adapts
`initializeTopology` / `reconcileTopology` to lifecycle `up`,
`focusConversationPane` to `attach`, and `inspectTopologyHealth` followed by
schema-validated manifest reads to `getManifest` / `doctorSession`.
Before P13 starts roles, the default integration prepares the persistent Runtime
host and obtains trusted role prompts, MCP configuration and provider lifecycle
hooks. P13 exposes Claude/Codex launch helpers; the default host currently requires
verified Claude native hooks (use `init --provider claude`). It fails closed for
other providers unless an operator supplies a verified host. The host
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

## High-level SDLC commands (P29)

Phase P29 adds 9 high-level, skill-friendly commands for autonomous agent execution and human operations.
These commands compose underlying SDLC packages (`@bflow/specification`, `@bflow/test-strategy`,
`@bflow/verification`, `@bflow/git-orchestrator`, `@bflow/mcp-gateway`, `@bflow/skills`, etc.)
through the unified `HighLevelCliFacade` without exposing concrete internal engines directly.

For exhaustive parameter references, schema definitions, and skill bindings, see [COMMAND_REFERENCE.md](./COMMAND_REFERENCE.md).

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

All high-level commands accept standard execution flags:
- `--correlation-id <id>`: Distributed tracing correlation identifier.
- `--idempotency-key <key>`: Deterministic execution key for durable receipt reuse.
- `--resume`: Resumes execution from the first incomplete or uncertain step.
- `--actor <id>`, `--role <role>`: Execution identity and role attribution.
- `--permission-mode <mode>`: Permission mode (`restricted`, `workspace_auto`, `unattended_isolated`).
- `--session-id <id>`: Session identifier (mandatory for `unattended_isolated`).
- `--isolation <kind>`: Isolation level (`provider_policy`, `os_sandbox`, `container`).
- `-j, --json`: Structured JSON envelope output complying with schema version 3.
- `-h, --help`: Displays command usage and available flags.

### Governance and security enforcement

Every high-level command passes through deterministic governance checks before executing side effects:
1. **Protected Branch & Production Guard**: Merges targeting protected branches (`main`, `master`, `prod*`, `release/*`, `hotfix/*`) or production environments strictly reject `--auto-approve`. Explicit human approval (`--approved-by <human_operator>`) is required.
2. **Permission Profile Constraints**: Mutating commands (`task implement`, `git prepare`, `skills sync`) are rejected under `restricted` mode (read-only). `unattended_isolated` mode requires an explicit `--session-id` and OS or container isolation (`--isolation os_sandbox|container`).
3. **Role Boundary Enforcement**: The `conversation` role represents the user interface only. Direct mutation commands (`task implement`, `git prepare`, `verify`) are rejected if invoked with `--role conversation`.

### Concurrency locking, durable ledger, and idempotency

- **Concurrency Locking**: Command execution scopes are guarded by file-based concurrency locks located at `.bflow/state/commands/locks/<hash>.lock` with in-process PID tracking. Simultaneous invocations on the same scope reject with a `conflict` error.
- **Durable Operation Ledger**: Execution progress is recorded step-by-step in `.bflow/state/commands/receipts/<hash>.json`. Repeated invocations with the same idempotency key return the cached receipt (`reusedReceipt: true`) without re-running operations.
- **Uncertain State Protection**: If a mutating step fails or is interrupted, subsequent attempts require `--resume` to reconcile prior state rather than blindly re-running mutations.
- **Step Resumption**: Passing `--resume` detects completed steps from the prior receipt, skips already-succeeded steps, invokes step-level reconciliation handlers if defined, and continues from the first incomplete step.
