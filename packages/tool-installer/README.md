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

For `provider_plugin` pins, pass `OfficialProviderPluginAdapter` as `providerPlugin` to `ManagedToolInstaller`. Its `discoverSkills` callback must inspect the provider's *active* skill inventory; `probeMemory` must test the configured shared worker and the specific provider integration. `verifyProvenance` must bind an active Superpowers marketplace snapshot to the reviewed pin; version alone is insufficient. The installer downloads and verifies the approved artifact before invoking a native route, then checks exact installed version and functional readiness. Claude-Mem uses its pinned npm installer with `--ide` and `--no-auto-start`; it does not start a worker per Bflow agent. Superpowers uses each provider's plugin CLI. Each provider gets its own installer instance and destination. The machine setup approval must cover the provider-home mutations listed by the upstream command. These native routes can touch shared provider state, so Bflow does not claim those files in `ownedPaths` or remove them automatically on rollback.

## Tool-specific operation

| Tool | Installation and update | Verification and capability | Configuration / rollback |
| --- | --- | --- | --- |
| RTK | Pin the `rtk-ai/rtk` release binary archive; `rtk_archive` recipe. | `rtk --version`, `rtk gain`; `cli_only`. | `rtkProviderIntegration` gives official Claude/Codex/Antigravity init routes; host must check `rtk init --help`, existing hooks and provider release before applying one route. `rtk proxy` retains full output. Remove only Bflow-owned binary/config, or restore retained version. |
| Claude-Mem | The native adapter installs a checksum-verified npm tarball, then runs the pinned CLI's `install --ide claude-code\|codex-cli\|antigravity --provider host --no-auto-start`. A global npm SDK installation does not count as activation. | Checks package identity/version/license, `doctor`, existing worker and provider-specific probe. `observeClaudeMemWorker` requires JSON `status: ok` and the exact configured worker version. `observeClaudeMemGrowth` samples RSS. | Use configured data directory and `.worker.port` or explicit port. Never start a worker per agent. `ClaudeMemProjectReader` exposes only project-filtered batch reads on loopback and rechecks every row; P27 must wrap it with Gateway authorization. Codex and Agy use their official installer adapters, never Claude hook semantics. Native rollback remains manual. |
| GitNexus | Pin official `gitnexus` npm tarball; review the selected package's license. | `gitnexus --version`; `ensureGitNexusIndex` requires versioned `status --json`, then `analyze <repo> --index-only` under one machine writer lock when stale, and checks JSON status again. It refuses malformed/unsupported status instead of inferring freshness from exit code or Git porcelain. MCP `initialize`/`tools/list` must pass `verifyMcpStartup`. | `--index-only` avoids GitNexus writing AGENTS.md or skills into the repository. Gateway should launch pinned `gitnexus mcp` with `GITNEXUS_MCP_ALLOWED_REPOS` and, where suitable, `GITNEXUS_MCP_READ_ONLY=1`. Partition by repo/storage; do not let concurrent writers share a LadybugDB store. Retained previous install is rollback. |
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
| Claude-Mem growth / worker loss | RSS probe and loopback health report growing/blocked; no worker spawn. | Operator sets growth thresholds and P27 adapter enforces project-filtered access. |
| Browser profile lock | `profile_locked`; separate task profile/resource key. | Gateway enforces lease/fencing and page routing; live Chrome launch and per-page isolation must be tested. |

This package's tests use fake command runners and HTTP probes. They do not prove live Herdr, provider hooks, MCP wire compatibility, Chrome launch or commercial GitNexus license eligibility. `FileToolCapabilityRegistry` is local-filesystem only; a crash can leave a lock file that an operator must inspect before removal.

## Commands

From the repository root: `pnpm exec tsc -b packages/tool-installer --pretty false` and `pnpm exec vitest run packages/tool-installer/test`. The root TypeScript project references and lockfile are shared integration-owned files; the integrator must wire this package in a separate reviewed change.

## Official references

- [RTK installation and agent support](https://github.com/rtk-ai/rtk)
- [Claude-Mem installation](https://docs.claude-mem.ai/installation)
- [GitNexus CLI, MCP and repository policy](https://github.com/abhigyanpatwari/GitNexus) and [license](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE)
- [Chrome DevTools MCP configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)
- [Superpowers provider installation](https://github.com/obra/superpowers)
