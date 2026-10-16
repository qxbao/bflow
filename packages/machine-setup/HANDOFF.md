# Phase P26 (`@bflow/machine-setup`) — Integration Handoff

## 1. Baseline & Branch Identity

- **Phase**: P26 — Machine Setup Backend (`@bflow/machine-setup`)
- **Baseline Commit**: `15bb288` (contains P24 `8dbb056` freeze + P25 `15bb288`)
- **Current Head Commit**: `5daea2b` + Task 8 completion
- **Branch**: `agent/machine-setup/p26-setup-backend`
- **Owned Paths Modified**: `packages/machine-setup/**` only. Root configuration, contracts, and other packages remain untouched.

---

## 2. Implemented Capabilities & Modules

1. **Platform Profile & Safe Command Runner (`src/platform.ts`, `src/runner.ts`)**:
   - `detectPlatform(host)`: Resolves OS, architecture, shell (`bash`, `zsh`, `fish`, `sh`, `pwsh`, `cmd`), XDG paths (`$XDG_CONFIG_HOME/bflow`, `$XDG_DATA_HOME/bflow`, `$XDG_STATE_HOME/bflow`), and derives stable `machineId` (`m-` + sha256).
   - `NodeCommandRunner`: Executes commands with `shell: false`, bounded output buffer (1 MiB), process-tree termination on timeout, and denylists escalation binaries (`sudo`, `doas`, `su`, `runas`, `pkexec`).
   - `findExecutable`: Searches directories on PATH and known install directories with executable bit (`X_OK`) verification and Windows `PATHEXT` handling.

2. **Setup State Store & Security Controls (`src/state-store.ts`)**:
   - `SetupStateStore`: Manages private directories (`0700` mode, rejects symlinks and foreign UIDs) and writes files atomically (`0600` mode, sync before rename).
   - Lock acquisition (`acquireLock`): Atomic lockfile with PID and hostname check; detects and replaces stale locks from dead processes.
   - Automatic Backups: Automatically archives any existing file before modification to `<state>/backups/<timestamp>-<sha8>/<basename>` with append-only index tracking.
   - Strict Version 3 Codecs: Implements versioned storage for journal (`setup/journal.json`), receipts (`setup/receipts.jsonl`), approvals (`setup/approvals/<id>.json`), and change log (`setup/changes.jsonl`). Unknown schema versions return `unsupported_version` errors.

3. **Tool Catalog, Probing & Installer Registry (`src/tools.ts`, `src/installer-registry.ts`, `src/machine-config.ts`)**:
   - Tool catalog for `node` (>=22.13.0), `pnpm` (exact 12.5.1), `git` (>=2.30.0), `herdr` (presence check), and provider CLIs (`claude`, `codex`, `agy`).
   - `probeTools`: Discovers tool status (`present`, `missing`, `version_mismatch`, `path_missing`), version parsing, and streams real-path binary SHA-256 digests.
   - `ToolInstallerRegistry`: Resolves tool descriptors by platform preference; accepts injected `ToolInstaller` implementations.
   - `MachineConfigSchema` (strict v3): Validates `<config>/machine.json` and rejects raw credential literals.

4. **PATH Manager (`src/path-manager.ts`)**:
   - `PathComponent`: Configures user shell rc files (`.bashrc`, `.bash_profile`, `.zshrc`, `.profile`, fish conf.d) using managed marker blocks (`# >>> bflow managed PATH >>>`).
   - Idempotent and safe: Preserves existing user content verbatim, deduplicates directory entries, and repairs malformed or duplicate blocks.

5. **MCP Config Registry & OS Service Managers (`src/mcp-registry.ts`, `src/service-manager.ts`)**:
   - `McpConfigComponent`: Manages `<config>/mcp.json` (strict v3), preserving unmanaged foreign entries while keeping bflow service entries synchronized.
   - `SystemdUserServiceManager` & `LaunchdServiceManager`: Deterministically renders and installs user-level service units without OS privilege escalation; binds secrets via `secret://` references.

6. **Doctor, Plan Builder & Approvals (`src/doctor.ts`, `src/plan.ts`, `src/approval.ts`)**:
   - `BuiltinSetupDoctor`: Read-only evaluator producing `MachineDoctorReport` (strict v3) across tool status, path block, config, and services.
   - `buildSetupPlan`: Generates topologically sorted plans (`MachineSetupPlanSchema`), change previews, and detects already-satisfied components.
   - `SetupApprover` & `AssumeYesApprover`: Manages operator approval receipts. Explicitly enforces that `--yes` **never** approves steps requiring elevation (`requiresElevation: true`).

7. **Plan Executor & Facade Service (`src/executor.ts`, `src/manifest.ts`, `src/setup-service.ts`)**:
   - `executePlan`: Orchestrates plan execution under state store lock; records pre-apply journal state; handles safe retries and interruption reconciliation.
   - `EnvironmentManifestComponent`: Generates `<state>/environment.json` (strict v3) and updates on non-volatile configuration changes.
   - `MachineSetupService`: Unified facade providing `check` (zero writes), `dry_run` (zero writes), `apply` (plan, approve, execute, verify), and `repair` (automatic backup, config restoration, block repair, unknown step retry) modes.

8. **End-to-End Scenario Suite (`test/scenarios.test.ts`)**:
   - 11 comprehensive integration scenarios verifying clean machine simulation, partial install, existing install, missing PATH directory, failed install rollback, interrupted step resume & reconciliation, repair mode, idempotent reruns, invalid config handling, elevation security, and secret isolation.

---

## 3. Validation Results

Executed in worktree `/Users/quanganh/AI Learning/bflow-p26-setup`:

1. **Dependency Graph & Package Boundaries**:
   ```bash
   pnpm check:deps
   # Output: Workspace dependency graph is acyclic (17 packages, 24 internal edges).
   # Leaf package dependency boundaries and non-escaping relative import rules verified.
   # Exit code: 0
   ```

2. **TypeScript Compilation**:
   ```bash
   pnpm exec tsc -b packages/machine-setup
   pnpm typecheck
   # Exit code: 0 (clean compilation)
   ```

3. **Package Test Suite**:
   ```bash
   pnpm exec vitest run packages/machine-setup/test
   # Output:
   # Test Files  11 passed (11)
   # Tests       155 passed | 1 skipped (156)  [1 skipped: optional fish test on host without fish]
   # Duration    5.18s
   # Exit code: 0
   ```

---

## 4. Integration Requests for Integrator / P27 / P28 / P29 / P30

1. **Root Build Configuration (`tsconfig.json`)**:
   - Add `{ "path": "./packages/machine-setup" }` to root `tsconfig.json` `references`.
2. **Lockfile Synchronization (`pnpm-lock.yaml`)**:
   - Update monorepo lockfile at the integration gate so workspace dependency `@bflow/machine-setup` is tracked.
3. **P28 (Skills & Tool Installers)**:
   - Provide concrete `ToolInstaller` implementations to register with `ToolInstallerRegistry`.
   - Provide `SkillsSynchronizer` to inject into `createSkillsComponent`.
4. **P27 (MCP Gateway)**:
   - Point local MCP daemon loader to read `<config>/mcp.json` produced by `McpConfigComponent`.
5. **P29 (CLI)**:
   - Wire `bflow setup` commands (`--check`, `--dry-run`, `--repair`, `--yes`) to invoke `MachineSetupService.run()`.
6. **P30 (Runtime Host)**:
   - Integrate `MachineDoctorReport` and `EnvironmentManifest` into host readiness preflights.
