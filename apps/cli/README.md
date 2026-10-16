# Bflow CLI environment lifecycle (P12)

Build from the repository root with `pnpm build`, then run
`node apps/cli/dist/bin.js <command>` (or the installed `bflow` executable).
Node >=22.13 and the root's pinned pnpm are required for the existing storage runtime.

| Command | Behavior |
| --- | --- |
| `bflow init` | Resolves the canonical Git checkout root; creates `.bflow/config.yaml` and `.bflow/.gitignore`. Safe to repeat, including with legacy `--force`/`--yes`: existing configuration is preserved. Does not invoke Herdr. |
| `bflow up [--timeout <ms>]` | Checks executables and Herdr protocol; starts a headless named server, calls the default P13 manager and waits for **every configured required role** to be idle/done. Persists validated pane/agent bindings. Reuses live roles. |
| `bflow attach` | Requires an existing manifest and a running matching session. Calls P13 to focus/validate Conversation, then runs `herdr session attach <name>` with inherited terminal I/O. |
| `bflow down [--yes] [--timeout <ms>]` | Inspects active runs and dirty files. Refuses unsafe shutdown without confirmation. Quiesces Runtime intake/dispatch, recollects runs, requires durable aggregate checkpoints, calls P13 graceful shutdown, then stops only the named session. Deletes no worktree, database, artifact, commit or source file. |
| `bflow status` | Reports configuration, named server, panes/agents and missing executables. Labels persisted observations as potentially stale. Does not open the legacy workflow Runtime. |
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
concurrency. P19 must enforce the policies through Runtime; P12 does not implement
Coordinator or workflow policy logic. A config copied/moved to another checkout
fails identity validation instead of attaching to the original repository.

Session identity is `bf-` plus 20 hexadecimal characters of SHA-256 over the
canonical checkout root and absolute Git directory. Equal repository basenames
therefore remain isolated; linked worktrees have distinct identities. Herdr
commands receive `HERDR_SESSION` explicitly. Inherited `HERDR_SOCKET`, pane,
remote and other caller context is removed. No socket path is constructed or
managed by Bflow. Explicit `HERDR_CONFIG_PATH` is retained.

## Composition boundary and current integration limits

P13 is composed automatically through `PaneManagerLifecycleAdapter`. It adapts
`initializeTopology` / `reconcileTopology` to lifecycle `up`,
`focusConversationPane` to `attach`, and `inspectTopologyHealth` followed by
schema-validated manifest reads to `getManifest` / `doctorSession`.
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

The baseline `RuntimeService` has no public quiesce/checkpoint API. P12 exposes a
local composition seam using the existing `CreateCheckpointCommand` and
`RecoveryCheckpoint` contracts, without modifying those contracts or Runtime.
Before graceful shutdown is enabled, P19 integration must provide these real operations. P13 currently has no graceful shutdown entry point either; the default adapter returns an explicit error for lifecycle `down`.

Embedders pass `CliContext.environment.integration` or `openIntegration(input)`.
To override the default P13 composition in the executable, the operator can set `BFLOW_ENVIRONMENT_MODULE` to an absolute
ESM module exporting:

```ts
export async function openBflowEnvironment({ repository, config, env }) {
  // Compose real P13 and Runtime implementations here.
  return {
    manager, // SessionLifecycleManager, configured for repository.sessionName/root
    runtime, // RuntimeService, repository-scoped authoritative run queries
    quiesce, // (OperationOptions) => OperationResult<void>
    checkpoint, // (CreateCheckpointCommand, OperationOptions) => OperationResult<RecoveryCheckpoint>
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

The default composition starts and observes real P13 roles. `doctor` reports a
warning that Runtime shutdown coordination is still unavailable. `down` refuses
stopping when that safety integration is missing, including with `--yes`.
It does not construct a success-only barrier or fabricate an aggregate checkpoint.
A custom provider can supply the full lifecycle plus Runtime operations shown
above. Live agent startup depends on the installed CLI being authenticated and
ready; P13 blocked/startup failures remain errors. No full SDLC end-to-end claim
is made.

## Recovery and verification

Runtime state is under `.bflow/state/`, with atomically replaced `session.json`
and `operation.json`. P13's authoritative manifest is
`.bflow/state/panes/<session>.manifest.json`; the CLI's `session.json` is its last
validated observation. An active session's manifest is refreshed through P13
health inspection before status/readiness decisions. A repository operation lock serializes up/down. Concurrent
operations are refused. After an interrupted CLI leaves `lifecycle.lock`, verify
the owning process has exited before removing that lock. Unresolved role/server
startup or shutdown delivery is retained and automatic resend is refused until
the manager/server can reconcile it. A blocked role remains available for
inspection and is recorded as degraded. No automatic forced kill is used during
shutdown timeout. These guarantees target local filesystems and cooperative
same-user processes; power-loss recovery and multi-host operation are unverified.

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
