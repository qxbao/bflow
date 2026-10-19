# Tool installer and capability inventory

`@bflow/tool-installer` is the P26 leaf implementation of `ToolInstaller`. It depends only on `@bflow/contracts`. It does not change ProviderAdapter, MCP Gateway, provider homes or root build configuration. P30 must compose it through MachineSetup/Runtime; P27 owns MCP negotiation and leases.

## Setup

1. Select exact upstream releases and review their licenses. Record an HTTPS release artifact URL and its SHA-256 in a trusted machine catalog. Never use `latest`, a branch archive, or a value from repository text as an approved pin. GitNexus requires a noncommercial-use review for its selected release.
2. Construct `ManagedToolInstaller({ managedRoot, pins })` with a private absolute XDG data directory (`$XDG_DATA_HOME/bflow/tools`, or the platform equivalent). Keep the catalog and receipts in operator-owned state; do not place executable installs under a task worktree.
3. Call `plan(ToolInstallRequest)`, show the resulting `SetupStep` and required machine approval, then call `apply(SetupApplyRequest)` only after MachineSetup has verified the approval receipt. `reconcile` observes the current installation without reinstalling. A new exact pin plus `apply` updates; a failed staged binary update retains the previous owned directory. Native provider changes may be partly applied when an installer fails, so their receipt is `unknown` and rollback is manual. Unowned destinations and existing config are blocked.
4. Perform the tool-specific verification below. Register a `ToolCapability` only after that verification. `FileToolCapabilityRegistry` persists scoped inventory; remove stale registrations when a tool, worker, index, profile or Gateway service loses readiness.
5. Pass the generated launch/configuration requirements to P27/P30. A CLI-only tool is never registered as an MCP server. No `up` path should invoke this installer; setup plan/apply is explicit.

The built-in npm recipe downloads an exact tarball and verifies its SHA-256 before installing into a staging directory, then checks package identity and version. `allowBuildScripts` is explicit because GitNexus native dependencies may need lifecycle scripts. Npm dependency resolution itself is not a fully pinned transitive lock; a production catalog should retain an audited dependency tree or a verified offline bundle. The RTK recipe extracts only the named `rtk` archive member and verifies `rtk --version` and `rtk gain`. `rtk proxy <command>` is the full-output escape hatch; callers must preserve the proxied command's exit code. No shell interpolation is used by the installer.

Generated config may be written with `writeOwnedToolConfig`, which refuses unowned files, returns a rollback copy for an owned update, and serializes writers. It is for Bflow-owned generated files, not arbitrary edits to `~/.claude`, `~/.codex`, or `~/.gemini`.

For `provider_plugin` pins, pass `OfficialProviderPluginAdapter` as `providerPlugin` to `ManagedToolInstaller`. Its `discoverSkills` callback must inspect the provider's *active* skill inventory. `verifyProvenance` must bind an active Superpowers marketplace snapshot to the reviewed pin; version alone is insufficient. The installer downloads and verifies the approved artifact before invoking a native route, then checks exact installed version and functional readiness. Superpowers uses each provider's plugin CLI. Each provider gets its own installer instance and destination. The machine setup approval must cover the provider-home mutations listed by the upstream command. These native routes can touch shared provider state, so Bflow does not claim those files in `ownedPaths` or remove them automatically on rollback.

## Tool-specific operation

| Tool | Installation and update | Verification and capability | Configuration / rollback |
| --- | --- | --- | --- |
| RTK | Pin the `rtk-ai/rtk` release binary archive; `rtk_archive` recipe. | `rtk --version`, `rtk gain`; `cli_only`. | `rtkProviderIntegration` gives official Claude/Codex/Antigravity init routes; host must check `rtk init --help`, existing hooks and provider release before applying one route. `rtk proxy` retains full output. Remove only Bflow-owned binary/config, or restore retained version. |
| MemPalace | Installed by `bflow setup --apply` from the reviewed PyPI wheel (`python_wheel` recipe): SHA-256 verified, installed into a Bflow-owned virtualenv with relocatable `bin/mempalace` and `bin/mempalace-mcp` wrappers, identity/version/license verified before publish. Needs `uv` or `python3` >= 3.9 on PATH. | Wheel digest is pinned; Python dependencies are resolved by uv/pip and are not a fully locked offline bundle. Version output is not evidence of task success. | The palace lives outside the repository (`~/.mempalace`); Bflow neither mines, repairs nor rewrites it. |
| GitNexus | Pin official `gitnexus` npm tarball; review the selected package's license. | `gitnexus --version`; `ensureGitNexusIndex` first observes versioned `status --json`, allowing a current index to pass while Gateway holds its reader lock. A stale index requires the storage and machine writer locks, a second status observation, `analyze <repo> --index-only` if still stale, and verified post-index status. It refuses malformed/unsupported status instead of inferring freshness from exit code or Git porcelain. MCP `initialize`/`tools/list` must pass `verifyMcpStartup`. | `--index-only` avoids GitNexus writing AGENTS.md or skills into the repository. Gateway should launch pinned `gitnexus mcp` with `GITNEXUS_MCP_ALLOWED_REPOS` and, where suitable, `GITNEXUS_MCP_READ_ONLY=1`. Partition by repo/storage; do not let concurrent writers share a LadybugDB store. Retained previous install is rollback. |
| Chrome DevTools MCP | Pin official `chrome-devtools-mcp` npm tarball. | Check server version and Chrome executable version, then Gateway MCP startup/tool discovery. `planChromeSession` rejects Chrome `SingletonLock`. | Use `--userDataDir` under Bflow managed root and `--executablePath` for the verified browser. One profile per repository/task, with Gateway exclusive resource lease per page call. The server launches Chrome on first browser-tool use. Never connect to the personal Chrome profile. |
| Superpowers | Install independently through `claude plugin install`, `codex plugin add`, and `agy plugin install`. `superpowersInstallRoute` records each route. | Require exact enabled plugin version, verified marketplace provenance, and `using-superpowers` in active skill discovery. | Namespace external skills separately from Bflow skills. Bflow's `TddDecision` controls TDD; the external skill's default cannot widen policy or skip gates. Provider marketplace installation may not reproduce the downloaded archive byte-for-byte. Native rollback remains manual. |

## Compatibility and acceptance matrix

| Scenario | Package result | Required integration or live evidence |
| --- | --- | --- |
| First install / second install | Staged install with integrity and functional probe / `already_satisfied`. | Exact approved pin, trusted approval and receipt persistence via MachineSetup. |
| Existing config / update failure | Unowned config blocked; owned config gets rollback copy. Existing executable retained when new staged install fails. | Operator reviews rollback before deleting prior version. |
| Plugin unavailable or probe fails | Planning requires a configured native adapter; activation without independent functional verification returns `unknown`. | Provider-specific official install, version-specific hook/skill test and marketplace provenance check. |
| MCP startup failure | `verifyMcpStartup` returns blocked and no capability. | P27 Gateway performs real protocol negotiation, authorization, tool discovery and restart limits. |
| Duplicate GitNexus writer | Exclusive machine writer lock returns `busy`. | Shared storage topology and cross-host locking are not supported. |
| Browser profile lock | `profile_locked`; separate task profile/resource key. | Gateway enforces lease/fencing and page routing; live Chrome launch and per-page isolation must be tested. |

This package's tests use fake command runners and HTTP probes. They do not prove live Herdr, provider hooks, MCP wire compatibility, Chrome launch or commercial GitNexus license eligibility. `FileToolCapabilityRegistry` is local-filesystem only; a crash can leave a lock file that an operator must inspect before removal.

RTK configuration tests use a disposable provider home and fake tool process, so they do
not read the operator's hook configuration. They still exercise the production checks
that reject symlinked global hooks and duplicate global/repository RTK registrations
before invoking the tool. This test isolation does not change production path policy.

## Commands

From the repository root: `pnpm exec tsc -b packages/tool-installer --pretty false` and `pnpm exec vitest run packages/tool-installer/test`. The root TypeScript project references and lockfile are shared integration-owned files; the integrator must wire this package in a separate reviewed change.

## Official references

- [RTK installation and agent support](https://github.com/rtk-ai/rtk)
- [MemPalace on PyPI](https://pypi.org/project/mempalace/)
- [GitNexus CLI, MCP and repository policy](https://github.com/abhigyanpatwari/GitNexus) and [license](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE)
- [Chrome DevTools MCP configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)
- [Superpowers provider installation](https://github.com/obra/superpowers)

## Reviewed default setup catalog

`defaultToolCatalog(os, arch)` selects fixed upstream artifacts without network access.
The CLI's `createDefaultSetupConfiguration` registers those pins and preserves explicit
operator descriptors. Linux x64 includes RTK, Herdr, Agy, Claude Code, Codex, GitNexus and
Chrome DevTools MCP; Linux ARM64 and macOS x64/ARM64 include all except Agy. Other
platforms return manual requirements. Installation stays under the approved machine
`data/tools/<toolId>` directory; provider authentication remains interactive.

The catalog records actual SHA-256 values computed from downloaded artifacts and checked
against upstream GitHub/Herdr checksums, npm SHA-512 SRI, or Agy manifest SHA-512. Npm's
transitive dependencies are not a fully pinned offline bundle. GitNexus requires Node
`^22.18.0 || >=24.11.0` and its noncommercial license review; native dependency build scripts
are explicit. Claude's upstream npm installer also requires its postinstall script. The
selected RTK release includes the BUSL-1.1 engine license alongside its MIT CLI license.

Agy uses the native archive linked by the [official installer](https://antigravity.google/docs/cli/install/).
Herdr uses the raw release binary from the [official release manifest](https://herdr.dev/latest.json).
The installer adds no shell initialization, provider permissions, hooks or credentials.
Superpowers uses `NativeProvidersToolInstaller`, composing an approved
provider-specific installation for every selected provider. The existing native runtime
verifies active-cache provenance and Bflow policy overlays. The approved bundle's native metadata is
saved before provider mutations so a timed-out command can be reconciled against the provider's
enabled inventory and exact active cache. Metadata alone never establishes installation. Reconciliation
also checks the retained installation when an older interrupted staging directory lacks its metadata;
it accepts only an independently verified desired pin and never creates missing receipts. These
observations leave the pending intent and staged files unchanged. Unknown native delivery remains retained
and is never automatically replayed, with one exception: when the provider's own plugin inventory is
readable and proves nothing of the plugin is registered, the next apply archives the interrupted
intent (`<destination>.native-pending.json.reviewed-<id>`), drops its staging directory and installs
again. An unreadable inventory or a registered plugin keeps the step `unknown`. Agy plugin validation
runs without `--strict` because upstream Superpowers ships warnings that strict mode rejects; real
manifest errors still fail. Native provider config changes require the machine
setup approval. Isolated setup passes `NativeRuntimeOptions.isolation` (HOME plus
`CLAUDE_CONFIG_DIR` for Claude and `CODEX_HOME` for Codex) to every provider child process, and
reads provider config only from those directories. Agy has no documented isolation variable, so
isolated setup defers its native activation and reports the step as `blocked` (fail closed).
Real setup passes no isolation and keeps the caller environment unchanged. `additionalToolObservations` supplies functional native readiness to the
machine setup doctor without pretending that plugin files are standalone executables. MCP launch requirements are returned separately for Runtime/Gateway scope,
Chrome profile isolation and verified index setup; installing a server does not register
or start it. Binary version checks do not establish live SDLC readiness.
