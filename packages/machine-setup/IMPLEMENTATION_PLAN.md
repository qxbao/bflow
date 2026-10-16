# P26 — Machine setup backend (`bflow setup`) implementation plan

Spec (binding authority): the project owner's P26 request (summarised in Global Constraints),
`AGENTS.md` (P24 / V3 invariants), `docs/runtime-architecture-v3.md` §4, §7, §9, and the
frozen contracts `packages/contracts/src/{setup,platform,mcp,skills,commands,errors}.ts`.

## Context

`@bflow/machine-setup` (new package, `packages/machine-setup/**`, owned by P26) is the
backend that a future CLI (`apps/cli`, P29) calls to implement:

- `bflow setup` (plan → approve → apply → doctor), `--check` (read-only observation +
  doctor, zero writes), `--dry-run` (plan + human preview, zero writes), `--repair`
  (plan that also repairs malformed/owned config, reconciles `unknown` steps), `--yes`
  (auto-approve ONLY steps already in the plan; never elevation, never login).

No CLI parser is added (P29 owns `apps/cli/**`). Concrete per-tool `ToolInstaller`
implementations are NOT written here — the package defines a `ToolInstallerRegistry` that
accepts injected implementations of the contract `ToolInstaller` interface.

## Global Constraints

- Owned paths only: `packages/machine-setup/**`. Do not modify `packages/contracts/**`,
  root `package.json`, root `tsconfig.json`, `pnpm-lock.yaml`, `README.md`, `AGENTS.md`,
  `docs/**`, or any other package. (Root wiring is an integration change; report it.)
- Package `@bflow/machine-setup`, ESM, layout identical to `packages/agent-providers`
  (`package.json` with `main ./dist/index.js`, `types ./dist/index.d.ts`, exports `.`;
  `tsconfig.json` extends `../../tsconfig.base.json`, composite, rootDir `src`, outDir
  `dist`, references `../contracts`). Dependencies: `@bflow/contracts: workspace:*`,
  `zod: ^3.24.2` only; everything else from `node:` built-ins.
- Tests live in `packages/machine-setup/test/*.test.ts` (vitest), run with
  `pnpm --filter @bflow/machine-setup test` or
  `pnpm exec tsc -b packages/machine-setup && pnpm exec vitest run packages/machine-setup/test`.
  Tests use temp directories as fake HOME/XDG roots and injected fake `CommandRunner`s; they
  must never touch the real home directory, real shell rc files, real services or network.
- Every value crossing a package boundary is parsed with the exported contract Zod schemas
  (`SetupStepSchema`, `MachineSetupPlanSchema`, `SetupReceiptSchema`,
  `SetupApplyRequestSchema`, `ToolInstallRequestSchema`, `MCPServiceDefinitionSchema`, …).
  Package-local documents (desired machine config, environment manifest, journal, approval
  receipts, doctor report) are strict Zod schemas with `schemaVersion: 3`; an unknown
  version yields a `ContractError` `unsupported_version` (supportedVersions `[3]`), malformed
  v3 yields `validation`. Never default a missing version to 3.
- Results use the contract `OperationResult<T>` / `ContractError` shapes; no thrown errors
  across the public API except programmer errors.
- Commands are executed only through an injected `CommandRunner` with an argv array and
  `shell: false`. Never build shell strings, never pipe a download into a shell, never
  invoke `sudo`/`doas`/`runas`/`pkexec`. A step that needs OS elevation is reported as
  `blocked` with the exact manual command; `--yes` does not change that.
- Setup never logs in to provider CLIs and never accepts trust/update prompts; missing auth
  is a doctor finding with manual instructions.
- Version pins: install steps are only planned for descriptors with an exact pinned version
  (no ranges, no `latest`), `https:` source and SHA-256 integrity. Unpinned/missing tools
  get manual guidance diagnostics, no install step. No fabricated pins/checksums shipped.
- Herdr compatibility is NOT judged from its release label: setup only checks presence and
  records the version string as diagnostics.
- Required runtime minimums: Node `>=22.13.0`; pnpm exactly `12.5.1` (root
  `packageManager`); Git `>=2.30.0`; Herdr present (any version string). Provider CLIs
  `claude`, `codex`, `agy` are detected; they are required only when listed in the desired
  machine config `providers`.
- Paths: XDG with defaults when unset — config `$XDG_CONFIG_HOME/bflow` (default
  `~/.config/bflow`), data `$XDG_DATA_HOME/bflow` (`~/.local/share/bflow`), state
  `$XDG_STATE_HOME/bflow` (`~/.local/state/bflow`), on Linux and macOS alike. Bflow-owned
  dirs are created `0700`, files `0600`; a bflow-owned dir that is a symlink or owned by
  another uid is rejected (`validation`). Writes are atomic (temp file in same dir, fsync,
  rename). Every modification of an existing file is preceded by a backup under
  `$XDG_STATE_HOME/bflow/backups/`.
- Idempotency: rerunning setup must not duplicate MCP entries, PATH entries/blocks,
  plugins/skills, OS service definitions, and must not rewrite bytes outside bflow-owned
  regions/files. A rerun on a satisfied machine produces only `already_satisfied` receipts
  and performs zero file writes other than the journal/receipt/manifest under the bflow
  state dir.
- Secrets: no secret value is ever written to plan, manifest, receipts, journal, logs or
  config; secrets are only `secret://` references (`SecretReferenceSchema`).
- Platforms: Linux and macOS supported; Windows (`win32`) is modelled in interfaces and
  reported as `designed_unverified` — check/dry-run work, mutating steps are `blocked` with
  diagnostic `windows support not verified`.
- Do not add no-op/always-success implementations to satisfy tests; fakes live only in tests.

## Shared interfaces (defined in Task 1, consumed by later tasks)

```ts
// src/types.ts
export type SupportStatus = "supported" | "designed_unverified" | "unsupported";
export interface PlatformProfile {
  os: "linux" | "darwin" | "win32" | "other"; arch: string; supportStatus: SupportStatus;
  shell: "bash" | "zsh" | "fish" | "sh" | "pwsh" | "cmd" | "unknown"; shellPath: string | null;
  uid: number | null; gid: number | null; isRoot: boolean; elevationAvailable: boolean;
  homeDir: string; hostname: string; machineId: string;
  paths: { config: string; data: string; state: string; managedBin: string };
  pathEntries: string[];
}
export interface HostEnvironment {             // injectable; default reads node:os/process
  platform: NodeJS.Platform; arch: string; env: Record<string, string | undefined>;
  homeDir: string; hostname: string; uid: number | null; gid: number | null;
}
export interface CommandResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; }
export interface CommandRunner {
  run(argv: readonly string[], options?: { timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal }): Promise<CommandResult>;
}
export interface ComponentObservation { stateDigest: string | null; valid: boolean; diagnostics: string[]; }
export interface ComponentDesiredState {
  digest: string; summary: string; targets: string[]; machineWide: boolean;
  repairNeeded: boolean;                      // owned config malformed; only applied in repair mode
}
export interface SetupContext {
  platform: PlatformProfile; runner: CommandRunner; mode: "check" | "dry_run" | "apply" | "repair";
  now(): Date; signal?: AbortSignal;
}
export interface SetupComponent {
  readonly componentId: string;
  readonly action: "configure" | "register_mcp" | "resolve_skills" | "verify";
  readonly rollback: "restore_owned_config" | "remove_owned_install" | "manual" | "none";
  observe(ctx: SetupContext): Promise<ComponentObservation>;
  desired(ctx: SetupContext): Promise<ComponentDesiredState>;
  apply(ctx: SetupContext): Promise<{ ownedPaths: string[]; diagnostics: string[] }>;
}
```
`machineId` = `m-` + first 24 hex chars of sha256(`hostname\0uid\0homeDir`).
`digest(value)` = sha256 hex of canonical JSON (object keys sorted recursively, no whitespace).

## Task 1: Package scaffold, canonical digest, platform detection, command runner

Create `package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts` (interfaces above),
`src/canonical.ts` (`canonicalJson`, `digest`), `src/errors.ts` (helpers building
`ContractError` values: `validationError`, `unsupportedVersion`, `conflictError`,
`timeoutError`, `notFound`, `corruption`), `src/platform.ts`
(`defaultHostEnvironment()`, `detectPlatform(host): PlatformProfile`, `resolveXdgPaths`),
`src/runner.ts` (`NodeCommandRunner` using `child_process.execFile` with `shell:false`,
`windowsHide`, bounded `maxBuffer` 1 MiB, timeout → kill + `timedOut:true`, rejects empty
argv / NUL bytes / argv[0] in a denylist `sudo, doas, su, runas, pkexec`; plus `findExecutable(name,
pathEntries, platform)` doing PATH lookup with `X_OK` check and Windows `PATHEXT`).

Shell detection: `$SHELL` basename on POSIX (`bash|zsh|fish|sh|dash→sh`), on win32 `pwsh` if
`PSModulePath` set and `ComSpec` absent-or-not-preferred else `cmd`; otherwise `unknown`.
`isRoot` = uid 0. `elevationAvailable` = `sudo` found on PATH (informational; never run).
`supportStatus`: linux/darwin `supported`, win32 `designed_unverified`, else `unsupported`.
`managedBin` = `<data>/bin`. Relative XDG values are ignored (XDG spec) → default.

Tests (`test/platform.test.ts`): linux/darwin/win32 host fixtures; XDG set/unset/relative;
machineId stability; shell detection table; runner: echo via `process.execPath -e`, timeout
kill, denylisted argv0 rejected, NUL rejected; canonical digest key-order independence.

## Task 2: State store — private dirs, atomic writes, backups, lock, journal, receipts, approvals

`src/state-store.ts`: `class SetupStateStore(paths, { uid, now })` with
`ensurePrivateDir(path)` (mkdir 0700 recursive; lstat: reject symlink, reject uid mismatch
when uid known, chmod to 0700 if looser), `writeFileAtomic(path, data, mode=0o600)`,
`backupFile(path) → backupPath | null` (copies existing file to
`<state>/backups/<ISO-timestamp-with-dashes>-<sha8 of content>/<basename>` and appends a line to
`<state>/backups/index.jsonl` `{original, backup, sha256, createdAt}`; never overwrites a backup),
`acquireLock() → OperationResult<Lock>` (`<state>/setup.lock` created with `wx`, content
`{pid, hostname, startedAt}`; existing lock with dead pid on same hostname is stale → replaced;
live → `conflict` error; `Lock.release()` removes only if content still ours),
journal (`<state>/setup/journal.json`, strict schema v3:
`{schemaVersion, planId, planDigest, revision, steps: Record<stepId, {status: "started"|"finished", startedAt, idempotencyKey}>}`),
receipts (`<state>/setup/receipts.jsonl`, each line parsed with `SetupReceiptSchema`; corrupt
line → `corruption` error naming the line number; `latestReceipt(idempotencyKey)`),
approval receipts (`<state>/setup/approvals/<receiptId>.json`, strict schema v3:
`{schemaVersion, receiptId, planId, planDigest, machineId, stepIds, approvedBy: "operator"|"assume_yes", approvedAt}`),
change log (`<state>/setup/changes.jsonl`: `{at, planId, stepId, kind, target, machineWide}`).
`check`/`dry_run` code paths never construct writes: expose `readOnly` flag making every
mutating method return a `validation` error "read-only mode".

Tests (`test/state-store.test.ts`): perms 0700/0600; symlinked state dir rejected; atomic
write leaves no temp files; backup created before change and unique; lock contention live vs
stale pid; journal/receipt round-trip; corrupt receipt line → corruption; unknown
schemaVersion → unsupported_version; readOnly rejects writes.

## Task 3: Tool catalog, probing, installer registry, desired machine config

`src/tools.ts`: catalog `TOOL_CATALOG` entries `{toolId, kind: "runtime"|"provider_cli",
executables: {posix: string[], win32: string[]}, versionArgs, versionPattern, requirement:
{type:"min", version} | {type:"exact", version} | {type:"present"}, defaultRequired,
knownInstallDirs(platform) , manualGuidance: Record<os, string>}` for `node, pnpm, git, herdr,
claude, codex, agy` using the Global Constraints values. `manualGuidance` names official
channels (nodejs.org / Homebrew / distro package manager, `corepack`/npm for pnpm, git-scm /
Homebrew / distro, Herdr release page, provider official docs) and never a `curl | sh` line.
`probeTools(platform, runner, { required })` → `ToolObservation[]`
`{toolId, status: "present"|"missing"|"version_mismatch"|"path_missing"|"unparseable_version"|"probe_failed",
resolvedPath, realPath, version, binaryDigest, required, diagnostics}`: PATH lookup via
`findExecutable`; if absent from PATH but present in `knownInstallDirs` (e.g. `~/.local/bin`,
`~/.npm-global/bin`, `<pnpm home>`, `/opt/homebrew/bin`, `/usr/local/bin`, `<managedBin>`) →
`path_missing` with that dir; version via runner with 10 s timeout; binaryDigest = streamed
sha256 of realPath.

`src/installer-registry.ts`: `ToolInstallDescriptor` strict schema v3 `{toolId, installerId,
method: "npm"|"pnpm"|"homebrew"|"winget"|"verified_archive", version (exact semver, no
range/latest), source (https URL), integrity (sha256), platforms: ("linux"|"darwin"|"win32")[],
requiresElevation: boolean}`; `ToolInstallerRegistry` with `register(installer: ToolInstaller)`
(duplicate installerId → conflict), `resolve(toolId, platform, descriptors)` → first descriptor
for platform whose installer is registered, preference order darwin: homebrew, npm, pnpm,
verified_archive; linux: npm, pnpm, verified_archive, homebrew; win32: winget, npm, pnpm,
verified_archive; `buildInstallRequest(descriptor, platform)` → `ToolInstallRequestSchema`-valid
request (`scope {kind:"machine", machineId}`, destination `<managedBin>` for verified_archive
else method id, idempotencyKey `install:<machineId>:<toolId>:<version>:<integrity>`).

`src/machine-config.ts`: desired machine config at `<config>/machine.json`, strict schema v3:
`{schemaVersion, providers: AgentProviderId[], toolPins: ToolInstallDescriptor[], mcpServices:
MCPServiceDefinition[], services: ServiceDefinition[], skills: {catalogRef: string|null},
secrets: Record<string, SecretReference>}` where `ServiceDefinition` = `{serviceId (identifier
[a-z0-9-]), program: absolute path, args: string[], env: Record<string, SecretReference|plain
non-secret string>, keepAlive: boolean}`. `loadMachineConfig(path)` → `{status: "absent"|"valid"|
"invalid"|"unsupported_version", config?, error?}`; absent → defaults (empty lists,
providers `[]`). Any string value that looks like a credential (`/(sk-|ghp_|xox[bp]-|AKIA)[A-Za-z0-9]/`
or keys named `token|secret|password|apiKey` with non-`secret://` value) → invalid.
`defaultMachineConfig()`.

Tests (`test/tools.test.ts`): clean machine (nothing found); partial (node old, git ok);
existing (all present & matching); PATH missing (claude in `~/.local/bin` not on PATH);
unparseable version; probe timeout → probe_failed; herdr any version accepted; registry
dup/resolve preference/unpinned descriptor rejected/http source rejected; config absent/valid/
invalid JSON/secret literal rejected/unknown version.

## Task 4: PATH manager

`src/path-manager.ts`: `PathComponent implements SetupComponent` (componentId `path`,
action `configure`, rollback `restore_owned_config`). Inputs: platform, desired dirs =
`[managedBin, ...dirs of path_missing tools]` deduplicated, order preserved, filtered to dirs
not already in `platform.pathEntries`... (always keep managedBin in block). Targets by shell:
zsh → `${ZDOTDIR:-~}/.zshrc`; bash → `~/.bashrc` on linux, `~/.bash_profile` on darwin;
sh/unknown → `~/.profile`; fish → `<XDG_CONFIG_HOME|~/.config>/fish/conf.d/bflow.fish`
(whole file owned); pwsh/cmd/win32 → `WindowsPathEditor` interface only, `apply` returns
unsupported diagnostic. Managed block between exact lines `# >>> bflow managed PATH >>>` and
`# <<< bflow managed PATH <<<`; POSIX body per dir:
`case ":$PATH:" in *":'<dir>':"*) ;; *) PATH='<dir>':"$PATH" ;; esac` then `export PATH`
(fish: `contains -- '<dir>' $PATH; or set -gx PATH '<dir>' $PATH`). Dirs containing `'`,
newline, NUL, or not absolute → validation error. observe: parse file; exactly one
well-formed block → digest of block body; none → null; >1 block or unterminated → `valid:false`,
`repairNeeded` in desired. apply: backup, replace existing block in place (or append with
one leading newline), keep all other bytes identical, atomic write preserving original file
mode; in non-repair mode with invalid blocks → returns diagnostic and does not write (executor
marks blocked). Repair: remove every bflow block / dangling marker, write one block.

Tests (`test/path-manager.test.ts`): no rc file → created with block; existing rc with user
content preserved byte-for-byte; rerun → no write (mtime/bytes unchanged) and digest equal;
duplicate blocks → invalid, repair dedupes; unterminated block repair; fish owned file; dir
with quote rejected; win32 unsupported; backup created before modifying existing file.

## Task 5: MCP registry, ServiceManager, skills synchronizer port, doctor

`src/mcp-registry.ts`: `McpConfigComponent implements SetupComponent` (componentId
`mcp-config`, action `register_mcp`) maintaining `<config>/mcp.json` strict schema v3
`{schemaVersion, services: Record<serviceId, MCPServiceDefinition>, external: unknown
(preserved verbatim if present)}`. Desired = config.mcpServices keyed by `serviceId` (field name
per `MCPServiceDefinitionSchema`; duplicates in input → validation). Apply merges: owned
entries replaced by id, entries not from bflow desired set but present are preserved (entries
carry no ownership marker inside the contract object, so track owned ids in sibling
`managedIds: string[]`); rerun → identical bytes, no write. Invalid JSON/schema → `valid:false`;
repair: backup then rewrite from desired + any still-valid entries. Never touches provider
(Claude/Codex/Agy) user settings files.

`src/service-manager.ts`: `ServiceManager` interface `{ kind: "systemd-user"|"launchd"|
"windows-unverified"; unitPath(serviceId); render(def): string; inspect(serviceId) →
{installed, digest, active}; install(def) → ownedPaths; }` with `SystemdUserServiceManager`
(`<XDG_CONFIG_HOME>/systemd/user/bflow-<id>.service`, then runner `systemctl --user
daemon-reload` and `systemctl --user enable --now bflow-<id>.service`) and
`LaunchdServiceManager` (`~/Library/LaunchAgents/dev.bflow.<id>.plist`, runner `launchctl
bootout gui/<uid>/dev.bflow.<id>` ignored-if-absent then `launchctl bootstrap gui/<uid> <plist>`),
both user-scope only, rendered deterministically with env values that are secret references
NOT inlined (rendered as `BFLOW_SECRET_REF_<NAME>=secret://…`). `ServicesComponent implements
SetupComponent` (componentId `services`, action `configure`): one unit per service id,
identical content → no rewrite, no reload; stale bflow-prefixed units not in desired set are
reported (not deleted) unless repair. `selectServiceManager(platform)`.

`src/skills.ts`: `SkillsSynchronizer` port `{ observe(ctx) → ComponentObservation; desired(ctx)
→ ComponentDesiredState; sync(ctx) → {ownedPaths, diagnostics} }` (implemented by P28) and
`SkillsComponent` adapter (componentId `role-skills`, action `resolve_skills`); when no
synchronizer injected → component omitted from plan with diagnostic `skills synchronizer not
configured` (never fake success).

`src/doctor.ts`: `MachineDoctorReport` strict schema v3 `{schemaVersion, machineId, healthy,
checkedAt, checks: {checkId, status: "passed"|"warning"|"failed"|"skipped", summary,
remediation?}[]}`; `SetupDoctor` port `{ run(ctx, input) → MachineDoctorReport }` and
`BuiltinSetupDoctor` (read-only): tool checks from observations (required missing → failed),
PATH block valid, mcp.json valid, services inspect, machine config valid, provider auth hint
as `warning` "login not verified by setup; run `<cli>` interactively". healthy = no failed.

Tests (`test/mcp-services.test.ts`, `test/doctor.test.ts`): MCP add/rerun no duplicate/preserve
foreign entries/invalid JSON repair with backup; systemd and launchd render+install via fake
runner (argv asserted, no sudo), rerun no reinstall, secret not inlined; skills component
absent without synchronizer; doctor statuses.

## Task 6: Plan builder, preview, approvals

`src/plan.ts`: `buildSetupPlan(input: {platform, observations, config, components:
SetupComponent[], registry, mode, previousRevision, now}) → OperationResult<{plan:
MachineSetupPlan, preview: SetupPreview, diagnostics}>`. Step order (topological):
install_tool steps (one per tool with status missing/version_mismatch that has a pinned
resolvable descriptor; produced by `installer.plan(request)` and validated: componentId ===
toolId, scope equal, action install_tool, requiresApproval true — mismatch → validation), then
`path`, `role-skills`, `mcp-config`, `services`, `environment-manifest` (configure; depends on
all previous), `doctor` (verify; depends on manifest; requiresApproval false). Components whose
observe digest equals desired digest and are valid are still included only for `verify`?
No: satisfied components are omitted from the plan (reported `satisfied` in preview);
`repairNeeded` components are included only in repair mode (else preview marks
`needs_repair`). All steps: level/scope machine, `requiresApproval` true except verify,
stepId `<action>:<componentId>`, `desiredStateDigest` from desired, `expectedStateDigest`
from observe (null if absent), idempotencyKey `setup:<machineId>:<stepId>:<desiredDigest>`.
planDigest = digest(plan without `planDigest`); planId `plan-<planDigest[0..16]>`; revision
`previousRevision + 1`. Parse final plan with `MachineSetupPlanSchema`. Windows: plan built;
preview flags mutating steps `unsupported_platform`.

`SetupPreview`: `{steps: {stepId, action, componentId, summary, targets, machineWide,
requiresApproval, requiresElevation, commandPreview?: string[]}[], satisfied: string[],
manual: {toolId, guidance}[], needsRepair: string[], machineWideChanges: string[]}` plus
`renderPreview(preview): string` (plain text, deterministic).

`src/approval.ts`: `SetupApprover` port `{ approve(plan, preview) → Promise<{approved:true,
receipt} | {approved:false, reason}> }`; `AssumeYesApprover` (records approvedBy
`assume_yes`, stepIds = exactly the plan's approval-requiring steps, excluding
`requiresElevation` installs, which stay unapproved); `InteractiveApprover(confirm:
(text)=>Promise<boolean>)`; `NonInteractiveApprover` (always declines: "approval required;
rerun with --yes or interactively"). Receipts persisted via state store; `verifyApproval(store,
plan, step, receiptId)` checks planId, planDigest, machineId and stepId membership.

Tests (`test/plan.test.ts`): clean machine plan shape & order & schema validity; satisfied
machine → only `doctor` step; digest stable across runs and changes when desired changes;
unpinned tool → manual entry, no step; elevation descriptor → requiresElevation, not
auto-approved by --yes; installer.plan returning mismatched step rejected; approval receipt
for other plan digest rejected; preview rendering snapshot-free assertions.

## Task 7: Executor and MachineSetupService facade (modes)

`src/executor.ts`: `executePlan(plan, deps: {store, components, registry, approvalReceiptId,
ctx, stepTimeoutMs = 600000})` → `SetupReceipt[]`. Validates plan (schema + recomputed digest
→ `validation` on mismatch), acquires lock, writes journal (planId/digest/revision). Per step in
order: dependency not `applied|already_satisfied` → `blocked`; platform not `supported` and
action ≠ verify → `blocked` "windows support not verified"; approval verified for steps
requiring it (else `blocked`); re-observe: observed == desired → `already_satisfied` (no apply);
observed ≠ expected (drift since plan) → `blocked` "state changed since plan; re-plan";
journal `started` (persisted before side effect); install_tool → `installer.apply(
SetupApplyRequest)` (parsed with `SetupReceiptSchema`; its receipt is re-verified via
`installer.reconcile` read-back) — component steps → `component.apply` then re-observe; any
timeout/abort/throw after `started` → `unknown`; success only if read-back digest == desired,
else `failed`; journal `finished`; append receipt and change-log lines (`machineWide` targets).
Resume: a journal step `started` without receipt for the same idempotencyKey → reconcile first
(installer.reconcile / component.observe): observed == desired → `applied` (diagnostic
"reconciled after interruption"); observed == expected → safe retry; otherwise `unknown` and
not retried unless mode `repair`. Lock always released (finally).

`src/manifest.ts`: `EnvironmentManifest` strict schema v3 `{schemaVersion, machineId,
generatedAt, platform: {os, arch, shell, supportStatus}, paths, tools: {toolId, status,
version, resolvedPath, binaryDigest}[], pathBlock: {target, dirs}|null, mcpServiceIds,
serviceIds, skillsDigest|null, lastPlan: {planId, planDigest, revision}|null}` written to
`<state>/environment.json` by the `environment-manifest` component (contains no env values or
secrets).

`src/setup-service.ts`: `MachineSetupService` constructed with `{host?, runner?, registry?,
skills?, doctor?, serviceManager?, approver, components?}`; `run({mode: "check"|"dry_run"|
"apply"|"repair", assumeYes?: boolean, signal?})` → `SetupRunReport {mode, platform,
observations, configStatus, plan|null, preview|null, receipts, doctor, machineWideChanges,
outcome: "healthy"|"changes_pending"|"applied"|"partially_applied"|"failed"|"blocked"|
"approval_declined"|"unsupported_platform"}`. check: observe + doctor, store readOnly, zero
writes. dry_run: + plan/preview, zero writes. apply: invalid machine config → `blocked`
("run setup --repair"), plan → approver (`assumeYes` → AssumeYesApprover) → execute → doctor.
repair: invalid/unsupported machine config → backup + rewrite default; plan in repair mode;
unknown journal steps eligible for retry. `outcome` derived from receipts + doctor.

Tests (`test/executor.test.ts`): apply happy path with fake installer; dependency failure
blocks dependents; approval missing → blocked; drift → blocked; timeout → unknown then
reconcile on rerun; interrupted (journal started, no receipt) resume; lock held → conflict;
check/dry-run produce zero writes (recursive snapshot of temp HOME before/after).

## Task 8: Scenario suite, README, handoff

`test/scenarios.test.ts` — end-to-end through `MachineSetupService` with temp HOME/XDG and a
fake world (fake `CommandRunner` + fake `ToolInstaller` that materialises executables in a
temp bin dir): (1) clean machine simulation, (2) partial installation, (3) existing
installation (all satisfied → only doctor, zero config writes), (4) PATH missing (tool in
`~/.local/bin` → PATH block, rerun no duplicate), (5) failed installation (installer fails →
`failed`, dependents blocked, outcome failed, backups intact), (6) interrupted setup (abort
mid-step → `unknown`; rerun reconciles), (7) repair (malformed PATH block + invalid mcp.json +
unknown step fixed by `repair`), (8) idempotent rerun (second apply: all `already_satisfied`,
rc/mcp/unit bytes identical, single block, single MCP entry, single unit), (9) invalid global
configuration (apply blocked, check reports failed, repair backs up & restores), plus
`--yes` does not approve elevation steps and no secret string from env appears in any file
under temp HOME.

Docs: `packages/machine-setup/README.md` (purpose, mode semantics, file layout, ownership
boundaries, safety rules, Windows status, ports to be provided by P28/P27/P29/P30, integration
wiring needed: root `tsconfig.json` reference + lockfile importer, limitations / NOT VERIFIED
items: no live installers, no real systemd/launchd run, no Windows, no concurrent multi-process
stress beyond lock tests), `packages/machine-setup/HANDOFF.md` (tested commit, commands, counts,
assumptions, integration requests). Run full validation commands from AGENTS.md and record
results in HANDOFF.md.
