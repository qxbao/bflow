# @bflow/machine-setup

`@bflow/machine-setup` implements the **Machine Setup Backend** (Phase P26 of Bflow Platform v3).
It provides the execution engine and setup service facade for inspecting, planning, approving, applying, and repairing host machine environments across Linux and macOS hosts.

This package is consumed by `apps/cli` to drive:
- `bflow setup`: Full setup (observe → plan → approve → apply → post-check doctor).
- `bflow setup --check`: Zero-write observation and machine doctor check.
- `bflow setup --dry-run`: Plan generation and human-readable change preview with zero writes.
- `bflow setup --repair`: Plan and repair malformed owned config (`.bashrc`, `mcp.json`), reconcile or retry interrupted/unknown journal steps.
- `bflow setup --yes`: Auto-approve non-elevation steps already present in the plan.

## Resolved setup inputs and managed command

`MachineSetupService` accepts an optional resolved `platform` and schema-validated `config`.
The platform controls all setup paths, including isolated roots. Invalid existing machine
configuration still blocks apply and requires repair. Approved manifest application persists
the resolved configuration in `<config>/machine.json`, backing up a changed valid file;
check and dry-run remain read-only.

An optional `launcher: { nodeBinary, entrypoint }` installs an owned POSIX `bflow` wrapper in
`managedBin` as part of the approved PATH step. When `~/.local/bin` is already on the current
PATH, setup also puts the wrapper there for immediate use in other directories. Existing
unowned files, symlinks and foreign-UID launchers are preserved. Launcher content and mode
participate in read-back and idempotency checks. Otherwise setup reports which shell file
to reload, or asks the user to open another terminal.

Configured tool pins are required observations. Managed archive and npm executables are
probed under `<data>/tools/<toolId>` and its `node_modules/.bin` directory. The final report
refreshes observations after installation. A tool outside the process PATH is healthy only
when the actual managed shell block covers its directory; the report retains `path_missing`
and a shell-reload warning. Native plugins have no synthetic CLI executable: the caller can
supply `additionalToolObservations(platform, config)` for validated, read-only native probes.
Unsupported required pins remain visible and unhealthy.

Independent component configuration continues after unrelated installer failures. The
manifest retains its predecessor dependencies; failed or unknown predecessors block it.
Doctor still runs and planning failures remain failed health checks.

The saved environment manifest labels its original, approval-covered `tools` inventory as
`toolsSnapshotPhase: "before_setup"`. An additive `afterSetupTools` snapshot contains actual
post-configuration probe results, observation time, explicit `after_setup` phase and its own
validated checksum. It is sampled inside the approved manifest apply after predecessor steps
and before the final doctor. The original planned fields keep their semantic digest coverage;
the supplemental observation is descriptive evidence and does not establish workflow success.
Check and dry-run never refresh it or write the manifest; repeated satisfied setup retains
the prior immutable observation time.

Installation and
native-probe tests use controlled fixtures; the launcher shell tests execute real Bash and
Node in temporary homes. These tests do not establish live provider or full SDLC acceptance.

---

## Architectural Boundaries & Ownership

In accordance with [AGENTS.md](../../AGENTS.md) and [docs/runtime-architecture-v3.md](../../docs/runtime-architecture-v3.md):
- **Owned Scope**: `packages/machine-setup/**` exclusively.
- **No CLI Parser**: P29 (`apps/cli/**`) owns CLI argument parsing and terminal user interface. `@bflow/machine-setup` exports `MachineSetupService` modes.
- **No Concrete Tool Installers**: Individual package manager installers (`npm`, `homebrew`, `verified_archive`, etc.) are owned by P28 / provider implementations. `@bflow/machine-setup` provides `ToolInstallerRegistry` to accept injected contract implementations.
- **Strict Version 3 Schema Boundary**: All exchanged documents (machine config, environment manifest, journal, approvals, doctor report) validate against strict Zod schemas with `schemaVersion: 3`. Unsupported versions return `unsupported_version` errors (`supportedVersions: [3]`).

---

## Mode Semantics

| Mode | Writes Permitted? | Approver Invoked? | Doctor Executed? | Purpose |
|---|---|---|---|---|
| `check` | **Zero writes** (read-only store) | No | Yes (read-only) | Assess current machine health and configuration state. |
| `dry_run` | **Zero writes** (read-only store) | No | Yes | Generate plan and formatted text preview without side effects. |
| `apply` | Writes to state & owned configs | Yes (or `AssumeYesApprover`) | Yes (pre & post) | Apply planned changes idempotently with rollback & backups. |
| `repair` | Writes to state & owned configs | Yes (or `AssumeYesApprover`) | Yes (pre & post) | Backup & restore malformed config, repair broken blocks, retry unknown steps. |

---

## Safety & Security Invariants

1. **No OS Privilege Escalation**:
   - `sudo`, `doas`, `su`, `runas`, `pkexec` are strictly denylisted from `CommandRunner`.
   - Tool descriptors marked `requiresElevation: true` are planned as manual instructions.
   - `--yes` (`AssumeYesApprover`) **never** approves elevation steps.
2. **Private File Permissions & Atomic Writes**:
   - Bflow state directories are created `0700`, files `0600`.
   - Symlinked or foreign-UID state directories are rejected immediately (`validation`).
   - Writes are atomic (temp file created in same directory, fsync, atomic rename).
3. **Automatic Backups**:
   - Every file modification is preceded by an immutable backup under `$XDG_STATE_HOME/bflow/backups/<timestamp>-<hash>/<basename>`.
   - An append-only index records `{original, backup, sha256, createdAt}`.
4. **Secret Isolation**:
   - Raw secrets are forbidden from plan, manifest, receipts, journal, logs, or unit files.
   - Secrets are handled exclusively via `secret://` references (`SecretReferenceSchema`).
5. **Idempotency**:
   - Rerunning setup on a satisfied host produces only `already_satisfied` receipts and zero writes outside the setup state store.
   - Shell rc files contain a single well-marked managed PATH block.

---

## File Layout

```
packages/machine-setup/
├── src/
│   ├── index.ts               # Public exports
│   ├── types.ts               # PlatformProfile, SetupComponent, SetupContext
│   ├── canonical.ts           # Canonical JSON serialization & SHA-256 digest
│   ├── errors.ts              # ContractError construction helpers
│   ├── platform.ts            # Host detection, XDG paths, shell detection
│   ├── runner.ts              # NodeCommandRunner & findExecutable
│   ├── state-store.ts         # SetupStateStore (locks, journal, receipts, backups)
│   ├── tools.ts               # Tool catalog (node, pnpm, git, herdr, CLIs) & probeTools
│   ├── installer-registry.ts  # ToolInstallerRegistry & ToolInstallDescriptor
│   ├── machine-config.ts      # MachineConfigSchema (v3) & default loader
│   ├── path-manager.ts        # PathComponent (managed shell rc blocks)
│   ├── mcp-registry.ts        # McpConfigComponent (mcp.json v3 management)
│   ├── service-manager.ts     # SystemdUserServiceManager & LaunchdServiceManager
│   ├── skills.ts              # SkillsSynchronizer port & SkillsComponent adapter
│   ├── doctor.ts              # BuiltinSetupDoctor & MachineDoctorReport (v3)
│   ├── plan.ts                # Plan builder, topological sorter, preview renderer
│   ├── approval.ts            # SetupApprover, AssumeYesApprover, verifyApproval
│   ├── manifest.ts            # EnvironmentManifestComponent & manifest schema (v3)
│   ├── executor.ts            # executePlan engine (lock, journal, reconcile, rollback)
│   └── setup-service.ts       # MachineSetupService facade
└── test/
    ├── platform.test.ts       # Platform & runner tests
    ├── runner-fixes.test.ts   # Process tree kill & executable detection
    ├── state-store.test.ts    # Store, backup, lock & journal tests
    ├── tools.test.ts          # Tool probing & installer registry tests
    ├── path-manager.test.ts   # PATH block & rc manipulation tests
    ├── mcp-services.test.ts   # MCP registry & OS service manager tests
    ├── doctor.test.ts         # Builtin doctor checks
    ├── plan.test.ts           # Plan builder & preview tests
    ├── executor.test.ts       # Execution engine & interruption resume tests
    ├── setup-service.test.ts  # MachineSetupService mode tests
    └── scenarios.test.ts      # 11 end-to-end integration scenarios
```

---

## Platform Support & Windows Status

- **Linux (`linux`)**: Fully supported (systemd user units, `.bashrc`, `.profile`, fish config).
- **macOS (`darwin`)**: Fully supported (`launchd` user launch agents, `.zshrc`, `.bash_profile`, `.profile`, fish config).
- **Windows (`win32`)**: Models interfaces and platform profile as `designed_unverified`. `check` and `dry_run` modes evaluate safely. All mutating steps are reported as `blocked` with diagnostic `windows support not verified`.

---

## Ports & External Integrations

- **P27 (`@bflow/mcp-gateway`)**: Consumes `<config>/mcp.json` managed by `McpConfigComponent` for local tool proxying.
- **P28 (`@bflow/skills` / `@bflow/tool-installer`)**: Provides concrete `ToolInstaller` implementations registered into `ToolInstallerRegistry`, and `SkillsSynchronizer` injected into `createSkillsComponent`.
- **P29 (`apps/cli`)**: Wraps `MachineSetupService` into `bflow setup` subcommands and renders `SetupPreview` text.
- **P30 (`packages/runtime`)**: Connects runtime startup health checks to `MachineDoctorReport` and `EnvironmentManifest`.

---

## Integration Wiring Required

At the integration synchronization gate:
1. **Root `tsconfig.json`**: Add `{ "path": "./packages/machine-setup" }` to `references`.
2. **`pnpm-lock.yaml`**: Update lockfile to lock `@bflow/machine-setup` dependencies.

---

## Limitations & Verification State

- **Injected Installers**: Package tested with contract-compliant fake installers; live network package downloads require P28 installer integration.
- **OS Services**: Unit files and launchd plists verified via mock `CommandRunner`; live OS service spawning requires integration environment.
- **Concurrency**: State store locking verified with live vs stale PID contention; distributed filesystem locks are not supported or claimed.
- **Windows**: Unverified on POSIX test hosts.
