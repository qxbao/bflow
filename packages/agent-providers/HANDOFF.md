# Phase P25 (`@bflow/agent-providers`) — Integration Handoff

## 1. Baseline & Branch Identity

- **Phase**: P25 — Provider Adapters (`@bflow/agent-providers`)
- **Base Commit (P24)**: `8dbb0561adbb41235d481e9800c2cb72eae81658` (`feat(p24): freeze platform v3 runtime architecture and contracts`)
- **Branch**: `agent/agent-providers/p25-adapters`
- **Owned Paths Modified**: `packages/agent-providers/**` only.

---

## 2. Implemented Capabilities

1. **Provider Registry (`src/registry.ts`)**:
   - `AgentProviderRegistry` and `createDefaultProviderRegistry` supporting `claude`, `codex`, and `agy`.
   - Ingress validation of `schemaVersion === 3` (`unsupported_version` error on mismatch) and Zod schema validation.
2. **Binary Discovery, Canonicalization & Attestation (`src/attestation.ts`)**:
   - `resolveAndVerifyExecutable` resolves executables via `PATH` or explicit path, verifies regular file, execute bit, `0o022` non-writable bits, owner UID, and SHA-256 digest.
   - `createSignedLaunchAttestation` and `verifyLaunchAttestation` implement Ed25519 signing/verification over `"bflow.agent-launch-attestation.v3\n" + canonicalReceiptJson(body)`.
3. **Authentication & Minimal Readiness Probe (`src/base-adapter.ts`, `src/*-adapter.ts`)**:
   - `claude`: `claude auth status --json` + `claude --print --permission-mode dontAsk [--model <m>] ping`
   - `codex`: `codex login status` + `codex exec [--model <m>] ping`
   - `agy`: `agy models` + `agy --print [--model <m>] ping`
4. **Capability Detection & Permission Modes (`src/permissions.ts`)**:
   - Parses `--version` and `--help` output to detect supported flags and subcommands dynamically.
   - Compiles `restricted`, `workspace_auto`, and `unattended_isolated` modes for `claude`, `codex`, and `agy`.
   - Enforces OS sandbox verification (`/usr/bin/bwrap`) for `unattended_isolated` on `claude`/`codex`, and reports `agy_unattended_unsupported` (`status: "unsupported"`) for `agy`.
5. **Environment Builder & Herdr Command Builder (`src/environment.ts`, `src/herdr-command.ts`)**:
   - `validateProviderEnvironment` and `buildProviderEnvironment` construct isolated session environments (`PATH`, `HOME`, `XDG_*`, `BHOME`, `BFLOW_*`, MCP endpoint maps, workspace/worktree paths, and provider-specific config directories).
   - `buildHerdrAgentStartCommand` generates `herdr agent start <name> --kind <provider> --pane <paneId> [--timeout <ms>] -- <argv...>`.
6. **Fake Provider Runner & Comprehensive Test Suite (`src/runner.ts`, `test/agent-providers.test.ts`)**:
   - 32 tests covering all 3 providers, all 8 failure scenarios (`missing binary`, `outdated version`, `auth expired`, `permission denied`, `invalid flag`, `environment missing`, `incompatible model`, `agent blocked`), Ed25519 startup attestations, and Argon hardening checks.

---

## 3. Proposed Integration Wiring for P30 / Integrator

Per `AGENTS.md`, leaf packages do not edit root `tsconfig.json`, `pnpm-lock.yaml`, or `packages/pane-manager/**`. During the P25–P28 integration gate and P30 wiring:
1. Add `{ "path": "./packages/agent-providers" }` to root `tsconfig.json` `references`.
2. Update `pnpm-lock.yaml` at the integration gate so `@bflow/agent-providers` workspace dependencies are locked.
3. In P30 (`packages/runtime/**`, `packages/pane-manager/**`), replace legacy `buildProviderStartArguments` calls with `AgentProviderRegistry.checkHealth` (`preflight` before launch, `activated` after startup receipt) and `AgentProviderRegistry.prepareLaunch` + `buildHerdrAgentStartCommand`.
