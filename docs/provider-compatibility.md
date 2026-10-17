# Bflow Platform v3 — Agent Provider Compatibility & Live Verification Report

**Tested Baseline Commit**: `7133b02` (`main`, post P24–P33 integration)
**Verification Date**: 2026-10-17
**Host OS & Kernel**: Linux `x86_64` (POSIX local filesystem, `systemd --user` active)
**Node.js Runtime**: `v24.10.0`
**Herdr Orchestrator**: `/home/baodq/.local/bin/herdr` (`herdr 0.8.0`, protocol `22`)
**Automated E2E Suite**: [`tests/e2e/scenarios/e12-group-b-agent-providers.e2e.test.ts`](../tests/e2e/scenarios/e12-group-b-agent-providers.e2e.test.ts)

---

## 1. Executive Summary & Evidence Separation

Bflow Platform v3 integrates three coding agent providers (`claude`, `codex`, and `agy`) through [`@bflow/agent-providers`](../packages/agent-providers/src/index.ts) while keeping OS process and terminal pane ownership inside [`@bflow/pane-manager`](../packages/pane-manager/src/index.ts) and Herdr (`protocolVersion: 22`).

In accordance with Bflow QA invariants:
1. **Strict Separation of Mock/Harness vs. Real Provider Tests**:
   - **Mock / Controlled-Executable Harness Tests**: Exercise adapter contract parsing, `checkHealth("preflight")`, `prepareLaunch()`, `compileArgv()`, config/skill file materialization (`0o600`), permission mode mapping (`restricted`, `workspace_auto`, `unattended_isolated`), and Ed25519 `AgentLaunchAttestation` verification using controlled POSIX shell binaries.
   - **Real Provider & Live Herdr Tests**: Execute against the actual installed host binaries (`claude 2.1.301`, `codex 0.162.0`, `agy 1.4.0`) and live isolated Herdr sessions (`herdr 0.8.0`).
2. **Version Check Is Never Readiness Proof**:
   - Passing `<provider> --version` or observing Herdr transport state `idle`/`done` **never** proves that an agent is authenticated, policy-compliant, or ready to execute tasks.
   - Execution readiness (`status: "ready"` at `stage: "activated"`) requires:
     1. Verified executable ownership, permissions, and SHA-256 digest (`resolveAndVerifyExecutable`),
     2. Live non-interactive authentication probe (`getProbeCommand`),
     3. Capability flag verification against `--help` output (`detectCapabilities`),
     4. Prepared launch profile with `0o600` isolated config/MCP/skills files and `no_direct_user_input` interaction policy,
     5. Healthy MCP service observations and matching `SkillManifest` SHA-256 digest, and
     6. Cryptographically verified Ed25519 `AgentLaunchAttestation` bound to `launchId`, `launchFingerprint`, `sessionId`, `paneId`, and `nativeSession`.

---

## 2. Installed Provider Binary Inventory

| Provider ID | Adapter Class | Installed Binary Path | Version Output | Binary Size | SHA-256 Digest |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `claude` | `ClaudeProviderAdapter` | `/home/baodq/.local/bin/claude` | `2.1.301 (Claude Code)` | `235,969,624` bytes (`225.0 MiB`) | `f39bc3c1f577746bf123b26eb097d7f4e93dc4ee3b760cf8e48ba1ec54f62181` |
| `codex` | `CodexProviderAdapter` | `/home/baodq/.nvm/versions/node/v24.10.0/bin/codex` | `codex-cli 0.162.0` | `294,475,384` bytes (`280.8 MiB`) | `4f1837356e11653c06469da78ebcb3c7b4be018695e373a2cf51e29cc5fd608c` |
| `agy` | `AgyProviderAdapter` | `/home/baodq/.local/bin/agy` | `1.4.0` | `134` bytes (wrapper -> `antigravity-cli`) | `4a6ab1ec0bf458360cc9a2a8f7b87dc04c73501c1ba2a5c3ec20bc8ff7a31ec3` |

---

## 3. Cross-Provider Compatibility Matrix (Mock Harness vs. Real Host Binary)

| Verification Dimension | `claude` (`2.1.301`) — Mock Harness | `claude` (`2.1.301`) — Real Binary | `codex` (`0.162.0`) — Mock Harness | `codex` (`0.162.0`) — Real Binary | `agy` (`1.4.0`) — Mock Harness | `agy` (`1.4.0`) — Real Binary |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Binary Detection & Attestation** | **PASS** | **PASS** (`225.0 MiB` <= `256 MiB` cap) | **PASS** | **FAIL (`QA-P34-03`)** (`280.8 MiB` > `256 MiB` cap in `attestation.ts:299`) | **PASS** | **PASS** (`134 B` wrapper verified) |
| **2. Authentication Probe** | **PASS** | **PASS** (`claude -p ping` -> `"pong"`, `7,755 ms`) | **PASS** | **PASS (Raw CLI) / BLOCKED in Adapter (`QA-P34-03`)** (`codex login status` -> `"Logged in using ChatGPT"`) | **PASS** | **PASS (Raw CLI) / FAIL in Adapter (`QA-P34-04`)** (`agy -p "Reply with PONG"` -> `"PONG"`, but adapter passes `--print --model ...` in wrong order) |
| **3. Herdr Pane Startup (`herdr 0.8.0`)** | **PASS** | **PASS** (`w1:p2` started, `session_id` assigned, `idle` -> `working` -> `done`) | **PASS** | **PASS** (`w1:p3` started, `session_id` assigned, `idle` -> `working` -> `done`) | **PASS** | **PASS** (`w1:p4` started, `session_id` assigned, `idle` -> `working` -> `done`) |
| **4. Environment Propagation** | **PASS** (`scrubEnvironment` + `envAllowlist`) | **PASS** (verified in live Herdr pane via `printenv` & `prepareLaunch`) | **PASS** (`scrubEnvironment` + `envAllowlist`) | **PASS** (verified in live Herdr pane via `printenv`) | **PASS** (`scrubEnvironment` + `envAllowlist`) | **PASS** (verified in live Herdr pane via `printenv`) |
| **5. Permission Behavior (`restricted`, `workspace_auto`, `unattended_isolated`)** | **PASS** (`default`, `acceptEdits`, fail-closed without OS sandbox) | **FAIL in `prepareLaunch` (`QA-P34-05`)** (`--append-system-prompt[-file]` regex mismatch) | **PASS** (`untrusted`, `on-request` + `workspace-write`, `never` + `workspace-write`) | **PASS (Raw CLI)** (`codex exec -s read-only "Reply with PONG"` -> `"PONG"`) | **PASS** (fail-closed `restricted`/`unattended_isolated`; `workspace_auto` supported) | **PASS (Raw CLI)** (`agy -m "Gemini 3.1 Flash Lite" -p "Reply with PONG"` -> `"PONG"`) |
| **6. Trusted Workspace** | **PASS** (`--add-dir <workspaceRoot>` + `0o600` settings) | **PASS** (CLI accepts `--add-dir <workspaceRoot>`) | **PASS** (`--cd <workspaceRoot>`) | **PASS** (CLI accepts `-C <workspaceRoot>`) | **PASS** (writes `workspaceTrust` to launch settings) | **FAIL (`QA-P34-06`)** (`agy 1.4.0` prompts interactively unless workspace is in `~/.gemini/antigravity-cli/settings.json` `trustedWorkspaces`) |
| **7. MCP Connectivity** | **PASS** (`--mcp-config <stateDir>/claude-mcp.json` + `--strict-mcp-config`) | **PASS** (verified live with `claude --mcp-config` + `claude-mem` / `gitnexus`) | **PASS** (`codex-config.json` with `mcpServers`) | **PASS** (verified live with `codex mcp list`: `gitnexus` enabled) | **PASS** (`--mcp-config <stateDir>/agy-mcp.json`) | **PASS** (verified live with `~/.gemini/antigravity-cli/mcp/jira-run` & `--mcp-config`) |
| **8. Skills Availability** | **PASS** (`claude-skills.md` + `SkillManifest` digest check) | **PASS** (32 builtin skills rendered; blocked at `compileArgv` by `QA-P34-05`) | **PASS** (`codex-skills.md` + `SkillManifest` digest check) | **PASS** (32 builtin skills rendered; `~/.codex/skills` symlinked to Superpowers) | **PASS** (`agy-skills.md` + `SkillManifest` digest check) | **PASS** (32 builtin skills rendered; builtin `agy` skills active) |
| **9. Execution Readiness (`checkHealth("activated")`)** | **PASS** (requires Ed25519 `AgentLaunchAttestation`, rejects `--version` / Herdr `done` alone) | **BLOCKED (`QA-P34-05`)** (`checkHealth("preflight")` = `ready`, `prepareLaunch` fails on `system_prompt_file`) | **PASS** (requires Ed25519 `AgentLaunchAttestation`, rejects `--version` / Herdr `done` alone) | **BLOCKED (`QA-P34-03`)** (`resolveAndVerifyExecutable` rejects `280.8 MiB` binary) | **PASS** (requires Ed25519 `AgentLaunchAttestation`, rejects `--version` / Herdr `done` alone) | **BLOCKED (`QA-P34-04`)** (`checkHealth("preflight")` probe fails on `--print --model`) |

---

## 4. Detailed Per-Provider Verification Cases (Expected, Actual, Logs, Status)

### 4.1 Claude Code (`claude 2.1.301`)

| Case ID | Dimension | Test Mode | Expected | Actual | Logs / Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **B-CLAUDE-01** | Binary Detection | Real Binary | `ClaudeProviderAdapter` resolves `/home/baodq/.local/bin/claude`, verifies regular file, owner-only write permissions, size <= `256 MiB`, and computes SHA-256 digest. | Resolved `/home/baodq/.local/bin/claude` (`235,969,624` bytes), version `2.1.301`, SHA-256 `f39bc3c1f577746bf123b26eb097d7f4e93dc4ee3b760cf8e48ba1ec54f62181`. | `binary.status = "verified"`, `binary.version = "2.1.301"` | **PASS** |
| **B-CLAUDE-02** | Authentication | Real Binary | `checkHealth("preflight")` executes `claude --print --output-format text --permission-mode default ping` with scrubbed environment and confirms live authenticated response. | Returned `status: "ready"`, `auth.status: "authenticated"`, `summary: "claude preflight ready"`. | `stdout: "pong"`, `durationMs: 7755` | **PASS** |
| **B-CLAUDE-03** | Herdr Pane Startup | Real Live Herdr (`0.8.0`) | `herdr -s bflow-qa-p34-group-b agent start claude --role developer --cwd <workspace>` spawns a dedicated pane, binds a `session_id`, and supports `send` / `wait` / `read`. | Pane `w1:p2` (`agent: claude`, `role: developer`) started with `session_id: f113bd5d-6963-4119-bf82-98c023a0cd19` and transitioned `starting -> idle -> working -> done`. | `pane_id: "w1:p2"`, `state: "done"`, `output: "PONG_CLAUDE_HERDR"` | **PASS** |
| **B-CLAUDE-04** | Environment Propagation | Real Binary + Harness | Strips `BFLOW_INTERNAL_*`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `NODE_OPTIONS`, `LD_PRELOAD` while preserving `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`, `HOME`, `PATH`, and `envAllowlist` variables. | Confirmed in both `prepareLaunch` (`CUSTOM_ROLE_VAR="propagated-ok"`, `OPENAI_API_KEY=undefined`, `BFLOW_INTERNAL_SECRET=undefined`) and live Herdr pane (`BFLOW_TEST_ENV=propagated_ok`). | `e12-group-b-agent-providers.e2e.test.ts` (`1.2`) & live Herdr pane `w1:p2` | **PASS** |
| **B-CLAUDE-05** | Permission Behavior | Harness + Real Binary | `restricted` -> `--permission-mode default`; `workspace_auto` -> `--permission-mode acceptEdits`; `unattended_isolated` -> rejected (`permission_mode_unsupported`) unless `isolation.verified && isolation.networkPolicy === "isolated"` (`--permission-mode bypassPermissions`). | Harness passes all 3 modes (`1.1`). On real `claude 2.1.301`, `prepareLaunch` fails in `compileArgv()` because `claude --help` formats `--append-system-prompt[-file]` with brackets (`QA-P34-05`). | `error.code = "capability_unsupported"`, `message = "Claude binary does not support required launch capabilities: system_prompt_file"` | **FAIL (`QA-P34-05`)** |
| **B-CLAUDE-06** | Trusted Workspace | Harness + Real Binary | Passes `--add-dir <workspaceRoot>` and writes `0o600` `claude-settings.json` with `workspaceTrust: <workspaceRoot>`. Rejects relative paths and forbidden roots (`/`, `/etc`, `/usr`, `/var`, `/bin`, `/sbin`, `$HOME`). | Verified in `prepareLaunch` (`1.2`) and live `claude -p --add-dir <workspaceRoot> "Reply with PONG"`. | `argv` contains `--add-dir <workspaceRoot>`; `claude-settings.json` mode `0o600` | **PASS** |
| **B-CLAUDE-07** | MCP Connectivity | Harness + Real Binary | Writes `0o600` `claude-mcp.json` with `mcpServers` pointing to Bflow MCP Gateway (`http://127.0.0.1:<port>/mcp`) and passes `--mcp-config <path> --strict-mcp-config`. Fails closed when required MCP service is degraded/unhealthy. | Verified in `e12` (`1.2`, `1.3`) and against live `claude 2.1.301` (`claude-mem` + `gitnexus` MCP servers). | `claude-mcp.json` mode `0o600`; `mcp_unhealthy` diagnostic when service `status !== "ready"` | **PASS** |
| **B-CLAUDE-08** | Skills Availability | Harness + Real Binary | Writes `0o600` `claude-skills.md`, passes `--append-system-prompt-file <path>`, and validates `SkillManifest.digest === environment.skillManifestDigest`. | Verified in `e12` (`1.2`, `1.3`). On real `claude 2.1.301`, blocked at `compileArgv()` by `QA-P34-05` (`--append-system-prompt[-file]` help regex). | `claude-skills.md` mode `0o600` (`sha256` verified) | **FAIL (`QA-P34-05`)** |
| **B-CLAUDE-09** | Execution Readiness | Harness + Real Binary | `checkHealth("activated")` requires valid `launchProfile`, live Herdr `interactiveReady: true`, and Ed25519 `AgentLaunchAttestation`. Rejects `--version` / Herdr `done` without attestation (`attestation_invalid`). | Harness passes `checkHealth("activated")` with valid Ed25519 attestation (`1.2`) and rejects unattested Herdr `done` (`1.3`). Real binary blocked at `prepareLaunch` by `QA-P34-05`. | `checkHealth("preflight")` = `ready`; `prepareLaunch` = `capability_unsupported` (`QA-P34-05`) | **FAIL (`QA-P34-05`)** |

---

### 4.2 OpenAI Codex (`codex 0.162.0`)

| Case ID | Dimension | Test Mode | Expected | Actual | Logs / Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **B-CODEX-01** | Binary Detection | Real Binary | `CodexProviderAdapter` resolves `/home/baodq/.nvm/versions/node/v24.10.0/bin/codex` (`codex-cli 0.162.0`) and verifies binary attestation. | `resolveAndVerifyExecutable` in `packages/agent-providers/src/attestation.ts:299` rejects the binary because its size (`294,475,384` bytes = `280.8 MiB`) exceeds the hardcoded `256 * 1024 * 1024` (`268,435,456` bytes) limit (`QA-P34-03`). | `diagnosticCode: "binary_missing"`, `reason: "Executable exceeds maximum allowed size: /home/baodq/.nvm/versions/node/v24.10.0/bin/codex"` | **FAIL (`QA-P34-03`)** |
| **B-CODEX-02** | Authentication | Real Binary + Harness | `codex login status` confirms authentication; `codex exec -s read-only "Reply with PONG"` executes an authenticated turn. | Raw CLI `codex login status` outputs `"Logged in using ChatGPT"` (`exitCode: 0`) and `codex exec -s read-only "Reply with PONG"` outputs `"PONG"` (`exitCode: 0`). Adapter `checkHealth("preflight")` fails before running probe due to `QA-P34-03`. | `codex login status` -> `"Logged in using ChatGPT"`; `codex exec` -> `"PONG"` (`2,740 ms`) | **FAIL in Adapter (`QA-P34-03`) / PASS Raw CLI** |
| **B-CODEX-03** | Herdr Pane Startup | Real Live Herdr (`0.8.0`) | `herdr -s bflow-qa-p34-group-b agent start codex --role reviewer --cwd <workspace>` starts a dedicated pane and executes a prompt turn. | Pane `w1:p3` (`agent: codex`, `role: reviewer`) started with `session_id: 0199f2c7-e4c1-73a1-9614-149129f6196b` and returned `"PONG_CODEX_HERDR"`. | `pane_id: "w1:p3"`, `state: "done"`, `output: "PONG_CODEX_HERDR"` | **PASS** |
| **B-CODEX-04** | Environment Propagation | Real Binary + Harness | Scrubs `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `BFLOW_INTERNAL_*` while preserving `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_HOME`, `HOME`, `PATH`, and `envAllowlist`. | Verified in `e12` (`1.2`) and live Herdr pane `w1:p3` (`BFLOW_TEST_ENV=propagated_ok`). | `CUSTOM_ROLE_VAR="propagated-ok"`, foreign provider keys stripped | **PASS** |
| **B-CODEX-05** | Permission Behavior | Harness + Real Binary | `restricted` -> `-a untrusted --sandbox read-only`; `workspace_auto` -> `-a on-request --sandbox workspace-write`; `unattended_isolated` -> `-a never --sandbox workspace-write` (only when `isolation.verified && isolation.networkPolicy === "isolated"`). | Verified in `e12` (`1.1`) and against real `codex 0.162.0` (`-a` and `--sandbox` flags confirmed in `codex --help`). | `codex --help` includes `-a, --ask-for-approval` and `-s, --sandbox` | **PASS** |
| **B-CODEX-06** | Trusted Workspace | Harness + Real Binary | Passes `--cd <workspaceRoot>` (`-C`) and rejects relative or system root paths. | Verified in `e12` (`1.2`) and `codex exec -C <workspaceRoot>`. | `argv` includes `--cd <workspaceRoot>` | **PASS** |
| **B-CODEX-07** | MCP Connectivity | Harness + Real Binary | Materializes `0o600` `codex-config.json` with `mcpServers` and verifies live `codex mcp list`. | Verified in `e12` (`1.2`) and live `codex mcp list` (`gitnexus` stdio server `enabled`). | `codex mcp list` -> `gitnexus npx -y gitnexus@latest mcp enabled` | **PASS** |
| **B-CODEX-08** | Skills Availability | Harness + Real Binary | Materializes `0o600` `codex-skills.md` + `codex-system-prompt.md` and verifies `SkillManifest.digest`. | Verified in `e12` (`1.2`, `1.3`) and host `~/.codex/skills/superpowers`. | `codex-skills.md` mode `0o600`; digest verified | **PASS** |
| **B-CODEX-09** | Execution Readiness | Harness + Real Binary | `checkHealth("activated")` requires valid Ed25519 `AgentLaunchAttestation` and rejects `--version` / Herdr `done` alone. | Harness passes (`1.2`, `1.3`). Real binary blocked at step 1 by `256 MiB` binary size cap (`QA-P34-03`). | `e12-group-b-agent-providers.e2e.test.ts` (`2.2`) | **FAIL (`QA-P34-03`)** |

---

### 4.3 Google Antigravity (`agy 1.4.0`)

| Case ID | Dimension | Test Mode | Expected | Actual | Logs / Evidence | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **B-AGY-01** | Binary Detection | Real Binary | `AgyProviderAdapter` resolves `/home/baodq/.local/bin/agy`, verifies file permissions and SHA-256 digest, and parses version `1.4.0`. | Resolved `/home/baodq/.local/bin/agy` (`134` bytes), version `1.4.0`, SHA-256 `4a6ab1ec0bf458360cc9a2a8f7b87dc04c73501c1ba2a5c3ec20bc8ff7a31ec3`. | `binary.status = "verified"`, `binary.version = "1.4.0"` | **PASS** |
| **B-AGY-02** | Authentication | Real Binary | `AgyProviderAdapter.getProbeCommand` executes non-interactive auth probe and confirms authentication. | Raw CLI `agy --model "Gemini 3.1 Flash Lite" --print "Reply with PONG"` succeeds (`"PONG"`, `7,412 ms`) when workspace is trusted. However, `AgyProviderAdapter.getProbeCommand` (`agy-adapter.ts:47–54`) passes `["--print", "--model", model, "ping"]`. Because `-p, --print <prompt>` consumes the next token as its `<prompt>`, `agy 1.4.0` treats `"--model"` as the prompt and `"Gemini 4 Argon (High)"` as a subcommand/positional arg, or times out (`15,000 ms`) when using default `"Gemini 4 Argon (High)"` (`QA-P34-04`). | `status: "unhealthy"`, `diagnosticCode: "auth_missing"`, `probe stderr: "Command timed out after 15000ms"` / `unknown command` | **FAIL (`QA-P34-04`)** |
| **B-AGY-03** | Herdr Pane Startup | Real Live Herdr (`0.8.0`) | `herdr -s bflow-qa-p34-group-b agent start agy --role architect --cwd <workspace>` starts a dedicated pane and executes a prompt turn. | Pane `w1:p4` (`agent: agy`, `role: architect`) started with `session_id: 2fb16230-3d85-4c0f-9a14-6fbef38f7c4a` and returned `"PONG_AGY_HERDR"`. | `pane_id: "w1:p4"`, `state: "done"`, `output: "PONG_AGY_HERDR"` | **PASS** |
| **B-AGY-04** | Environment Propagation | Real Binary + Harness | Scrubs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `BFLOW_INTERNAL_*` while preserving `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `AGY_CONFIG_DIR`, `HOME`, `PATH`, and `envAllowlist`. | Verified in `e12` (`1.2`) and live Herdr pane `w1:p4` (`BFLOW_TEST_ENV=propagated_ok`). | `CUSTOM_ROLE_VAR="propagated-ok"`, foreign provider keys stripped | **PASS** |
| **B-AGY-05** | Permission Behavior | Harness + Real Binary | `restricted` -> rejected (`permission_mode_unsupported`, Agy CLI has no read-only enforcement flag); `workspace_auto` -> supported (`--workspace <dir>`); `unattended_isolated` -> rejected (`permission_mode_unsupported`, Agy CLI has no unattended bypass flag). | Both harness (`1.1`) and real binary (`2.3`) enforce fail-closed rejection for `restricted` and `unattended_isolated` without privilege escalation. | `restrictedLaunch.ok === false`, `unattendedLaunch.ok === false` (`permission_mode_unsupported`) | **PASS** |
| **B-AGY-06** | Trusted Workspace | Real Binary | `prepareLaunch` configures workspace trust so `agy` runs non-interactively in `environment.workspaceRoot` without blocking on an interactive trust prompt. | `prepareLaunch` (`base-adapter.ts:1291–1300`) writes `{"workspaceTrust": "<workspaceRoot>"}` into `<stateDir>/agy-settings.json`, which is never passed on `agy` argv. Real `agy 1.4.0` reads `"trustedWorkspaces": [...]` from `$HOME/.gemini/antigravity-cli/settings.json`; if `<workspaceRoot>` is not listed there, `agy --print` hangs waiting for interactive `"Do you trust the files in this folder?"` (`QA-P34-06`). | `agy-settings.json` not referenced in `profile.argv`; `agy 1.4.0` checks `~/.gemini/antigravity-cli/settings.json` | **FAIL (`QA-P34-06`)** |
| **B-AGY-07** | MCP Connectivity | Harness + Real Binary | Writes `0o600` `agy-mcp.json` and passes `--mcp-config <path>`. | Verified in `e12` (`1.2`, `2.3`) and confirmed in `agy --help` (`--mcp-config <pathOrJson>`). | `profile.argv` contains `--mcp-config <stateDir>/agy-mcp.json` | **PASS** |
| **B-AGY-08** | Skills Availability | Harness + Real Binary | Writes `0o600` `agy-skills.md` + `agy-system-prompt.md` and passes `--append-system-prompt-file <path>`. | Verified in `e12` (`1.2`, `2.3`); `prepareLaunch` succeeds on real `agy 1.4.0` (`--append-system-prompt-file` is listed explicitly in `agy --help`). | `launchRes.ok === true`, `agy-skills.md` mode `0o600` | **PASS** |
| **B-AGY-09** | Execution Readiness | Harness + Real Binary | `checkHealth("activated")` requires valid Ed25519 `AgentLaunchAttestation` and healthy preflight probe. | Harness passes (`1.2`, `1.3`). Real binary `prepareLaunch` succeeds (`launchRes.ok === true`), but `checkHealth` fails at probe execution due to `QA-P34-04`. | `launchRes.ok = true`; `preflight.status = "unhealthy"` (`QA-P34-04`) | **FAIL (`QA-P34-04`)** |

---

## 5. Summary of Real Provider Integration Defects (`QA-P34-03` – `QA-P34-06`)

1. **`QA-P34-03` — `CodexProviderAdapter` Rejects Standalone `codex 0.162.0` Binary Exceeding `256 MiB` Cap**
   - **Location**: [`packages/agent-providers/src/attestation.ts:299`](../packages/agent-providers/src/attestation.ts#L299)
   - **Root Cause**: `if (stat.size <= 0 || stat.size > 256 * 1024 * 1024)` rejects `/home/baodq/.nvm/versions/node/v24.10.0/bin/codex` (`294,475,384` bytes = `280.8 MiB`).
   - **Remediation**: Increase the maximum executable size threshold in `resolveAndVerifyExecutable` to `512 * 1024 * 1024` (`512 MiB`).

2. **`QA-P34-04` — `AgyProviderAdapter.getProbeCommand` Places `--model` After `--print <prompt>` and Uses Slow Default Model**
   - **Location**: [`packages/agent-providers/src/agy-adapter.ts:47–54`](../packages/agent-providers/src/agy-adapter.ts#L47-L54)
   - **Root Cause**: `agy` defines `-p, --print <prompt>` as taking a required option argument. Passing `["--print", "--model", model, "ping"]` causes `agy` to consume `"--model"` as the prompt string. Additionally, when `--model` is placed before `--print`, the default `"Gemini 4 Argon (High)"` model takes `>15,000 ms` on cold start, exceeding the `15,000 ms` probe timeout, whereas `"Gemini 3.1 Flash Lite"` completes in `~7.4s`.
   - **Remediation**: Place `--model` before `--print` (`["--model", model, "--print", "ping"]`) and use a fast default probe model (`"Gemini 3.1 Flash Lite"`) or configurable probe timeout.

3. **`QA-P34-05` — `ClaudeProviderAdapter.detectCapabilities` Regex Misses Bracketed `--append-system-prompt[-file]` in `claude 2.1.301 --help`**
   - **Location**: [`packages/agent-providers/src/claude-adapter.ts:88–103`](../packages/agent-providers/src/claude-adapter.ts#L88-L103) and [`packages/agent-providers/src/base-adapter.ts:126`](../packages/agent-providers/src/base-adapter.ts#L126)
   - **Root Cause**: `claude 2.1.301 --help` prints `--append-system-prompt[-file] <promptOrPath>` on a single combined line instead of spelling out `--append-system-prompt-file`. `hasHelpFlag(helpText, "--append-system-prompt-file")` returns `false`, causing `prepareLaunch()` -> `compileArgv()` to fail with `capability_unsupported: system_prompt_file` even after `checkHealth("preflight")` returns `status: "ready"`.
   - **Remediation**: Update `ClaudeProviderAdapter.detectCapabilities` to match `/--append-system-prompt(?:-file|\[-file\])/` and validate `requiredLaunchCapabilities` during `checkHealth("preflight")`.

4. **`QA-P34-06` — `AgyProviderAdapter` Workspace Trust Materialization Does Not Populate `trustedWorkspaces` for `agy 1.4.0`**
   - **Location**: [`packages/agent-providers/src/base-adapter.ts:1291–1300`](../packages/agent-providers/src/base-adapter.ts#L1291-L1300)
   - **Root Cause**: `prepareLaunch` writes `{"workspaceTrust": "<workspaceRoot>"}` to `<stateDir>/agy-settings.json`, which is not consumed by `agy`. `agy 1.4.0` checks `"trustedWorkspaces"` in `$HOME/.gemini/antigravity-cli/settings.json` (or `AGY_CONFIG_DIR`) and blocks on an interactive prompt if the workspace is absent.
   - **Remediation**: Materialize an isolated `AGY_CONFIG_DIR` / `settings.json` containing `"trustedWorkspaces": [environment.workspaceRoot]` or verify workspace trust presence during `checkHealth("preflight")`.
