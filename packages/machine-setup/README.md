# @bflow/machine-setup

`@bflow/machine-setup` implements the **Machine Setup Backend** (Phase P26 of Bflow Platform v3).
It provides the execution engine and setup service facade for inspecting, planning, approving, applying, and repairing host machine environments across Linux and macOS hosts.

This package is consumed by the future CLI (`apps/cli`, P29) to drive:
- `bflow setup`: Full setup (observe → plan → approve → apply → post-check doctor).
- `bflow setup --check`: Zero-write observation and machine doctor check.
- `bflow setup --dry-run`: Plan generation and human-readable change preview with zero writes.
- `bflow setup --repair`: Plan and repair malformed owned config (`.bashrc`, `mcp.json`), reconcile or retry interrupted/unknown journal steps.
- `bflow setup --yes`: Auto-approve non-elevation steps already present in the plan.

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
