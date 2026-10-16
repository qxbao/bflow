# Phase P25 (`@bflow/agent-providers`) — Argon Code & Security Review

## 1. Review Scope & Workflow

- **Workflow**: Plan (Argon) → Implement (Flash subagent `144eefc9-ce1f-4561-a90e-53220d987e0b`) → Review, Harden & Verify (Argon).
- **Reviewed Baseline**: Commit `8dbb0561adbb41235d481e9800c2cb72eae81658` (`feat(p24): freeze platform v3 runtime architecture and contracts`).
- **Owned Paths**: `packages/agent-providers/**` on branch `agent/agent-providers/p25-adapters`.

---

## 2. Argon Review Findings & Remediations

| ID | Severity | Area | Finding in Initial Flash Implementation | Argon Remediation Applied |
| --- | --- | --- | --- | --- |
| **R25-01** | High | Binary Discovery & Trust (`src/attestation.ts`, `src/base-adapter.ts`) | `BaseProviderAdapter` called `computeFileSha256(executable)` directly on bare executable names (`"claude"`, `"codex"`, `"agy"`) without `PATH` resolution, canonicalization, execute-bit verification, or group/world-writable rejection. | Implemented and wired `resolveAndVerifyExecutable` which resolves bare binaries across `PATH`, resolves `realpath`, verifies regular file (`O_RDONLY \| O_NOFOLLOW \| O_NONBLOCK`), enforces execute bit `(mode & 0o111) !== 0`, rejects group/world-writable binaries `(mode & 0o022) !== 0`, checks owner UID (`0` or `process.getuid()`), and sets `AgentLaunchProfile.executable` to `canonicalPath`. |
| **R25-02** | High | Capability Flag Enforcement (`src/permissions.ts`, `src/*-adapter.ts`) | Permission compilers emitted CLI flags (`--restricted`, `--sandbox`, `--ask-for-approval`, `--mode`, `--add-dir`) without verifying their presence in `capabilities.supportedFlags` parsed from `--help`. | Updated `compileClaudePermissions`, `compileCodexPermissions`, `compileAgyPermissions`, and adapter `compileArgv` to verify every required flag against `capabilities.supportedFlags` and fail with `code: "invalid_flag"` when any required flag is absent. |
| **R25-03** | Medium | Fake Runner Provider Disambiguation (`src/runner.ts`, `src/base-adapter.ts`) | When `executablePath` pointed to a generic mock binary path (e.g. `/tmp/.../mock-binary`), `createFakeProviderRunner` fell back to `"claude"` for `--version` and `--help` invocations. Also default `minimumVersion` was `"1.0.0"` for all providers instead of provider-specific minimums. | Passed `env: { BFLOW_PROVIDER: this.descriptor.provider }` in adapter runner invocations, updated `createFakeProviderRunner` to prioritize `BFLOW_PROVIDER` and subcommands, and set `DEFAULT_MIN_VERSIONS` (`claude: "2.0.0"`, `codex: "0.150.0"`, `agy: "1.0.0"`). |
| **R25-04** | High | Antigravity CLI (`agy`) Flag & Settings Fidelity (`src/agy-adapter.ts`, `src/permissions.ts`, `src/base-adapter.ts`) | `AgyProviderAdapter.compileArgv` unconditionally appended `--mcp-config`, which is not a verified flag in `agy` 1.4.0 `--help`, and `prepareLaunch` did not write `permissions.allow` / `workspaceTrust` into `<role>.settings.json`. | Removed unconditional `--mcp-config` from `AgyProviderAdapter.compileArgv` (only passed if detected in `supportedFlags`), and wrote `permissions.allow`, `permissions.deny`, `workspaceTrust`, `systemPromptFile`, and `mcpConfigFile` into Agy's launch-local `<role>.settings.json`. |
| **R25-05** | Medium | Bypass Detection & Approval/Sandbox Separation (`src/permissions.ts`) | Needed explicit `detectsDangerouslySkipPermissions` reporting and explicit guard against `allowGlobalPermissionBypass`. | Added `detectsDangerouslySkipPermissions` to `CompiledPermissionResult`, rejected `allowGlobalPermissionBypass: true`, and verified Codex's `--ask-for-approval never` is strictly separate from `--sandbox read-only\|workspace-write`. |
| **R25-06** | Medium | MCP & SkillManifest Validation (`src/base-adapter.ts`) | `checkHealth` only checked `serviceIds` presence for MCP and `digest` equality for `SkillManifest`. | Added full `MCPClientRegistrationSchema` and `MCPServiceObservationSchema` validation (checking provider/role/session scope, expiration, transport support, and service `status === "ready"`), plus `SkillManifestSchema` validation and role matching. |
| **R25-07** | Medium | Activated Stage Attestation & Live Observation (`src/base-adapter.ts`, `src/attestation.ts`) | `activated` stage did not check `launchProfile.expiresAt`, `liveObservation.paneId === launchAttestation.paneId`, `liveObservation.nativeSession` consistency, or config file `0o600` mode preservation on disk. | Added checks for `launchProfile.expiresAt`, environment/fingerprint match, config file `0o600` mode and SHA-256 digest preservation, `paneId` match, and `nativeSession` match. |

---

## 3. Security & Contract Invariants Verified

1. **No Auto-Login or Credential Mutation**: Adapters never invoke `login`, `setup-token`, or write credentials on behalf of the user.
2. **No Secret Leakage**: `validateProviderEnvironment`, `buildHerdrAgentStartCommand`, and `scrubDiagnosticText` prevent raw tokens (`sk-*`, `Bearer *`, `AIza*`, `ghp_*`), `secret://` URIs, or emails from appearing in `environmentVariables`, `argv`, or health diagnostics.
3. **Readiness != Process Running**: A running process with `transportState: "starting" | "blocked"` or `interactiveReady: false` fails `activated` readiness (`status: "blocked"`).
4. **Strict Ownership Boundary**: Only files under `packages/agent-providers/**` were created or modified.
