# Bflow Platform v3 (Post-P24–P33 Integration) End-to-End QA Report

> **Ghi chú (lịch sử):** Tài liệu này ghi lại bằng chứng đo tại thời điểm đó, trong đó có Claude-Mem. Bflow không còn hỗ trợ Claude-Mem (thay bằng MemPalace cài thủ công); các số liệu và đường dẫn liên quan đến `claude-mem` chỉ còn giá trị lịch sử và không thể tái tạo từ mã hiện tại.

- **Tested Commit**: `7133b02` (`main`)
- **Execution Date**: `2026-10-17`
- **Role**: Principal QA Automation Engineer
- **Host Environment**:
  - OS: Linux `x86_64` (`systemd` user instance available)
  - Node.js: `v24.16.0` / `pnpm 12.5.1`
  - Installed Real Binaries:
    - `herdr`: `/home/baodq/.local/bin/herdr` (`herdr 0.9.5`, protocol `22` / schema `1`)
    - `claude`: `/home/baodq/.local/bin/claude` (`2.1.301 (Claude Code)`)
    - `codex`: `/home/baodq/.local/share/fnm/node-versions/v24.16.0/installation/bin/codex` (`codex-cli 0.162.0`)
    - `agy`: `/usr/bin/agy` (`Antigravity CLI 1.4.0`)
    - `rtk`: `/home/baodq/.cargo/bin/rtk` (`rtk 0.50.0`)
    - `gitnexus`: `/home/baodq/.local/bin/gitnexus` (`1.6.12`)
    - `google-chrome`: `/usr/bin/google-chrome` (`Google Chrome 146.0.7680.80`)
    - `claude-mem`: `/home/baodq/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs` (`12.1.3`, live worker PID `4376` on `127.0.0.1:37777`)

---

## 1. Executive Summary & Evidence Separation

Every test case in this report strictly separates **Mock / Harness Verification** (deterministic contract, adapter, or fake-runner verification) from **Real Provider / Live Host Execution** (actual OS binaries, live Herdr daemon sessions, real MCP stdio/HTTP servers, and real `/proc/<pid>` telemetry).

> **Strict QA Rule Applied**: No test case is marked `PASS (Real)` unless it was executed against the real binary/daemon and succeeded without workarounds. All 8 integration defects uncovered during initial real-host execution (`QA-P34-01` through `QA-P34-08`) have been remediated in their owning packages (`@bflow/cli`, `@bflow/skills`, `@bflow/agent-providers`, `@bflow/tool-installer`) and re-verified against the real installed binaries (`herdr 0.9.5`, `claude 2.1.301`, `codex 0.162.0`, `agy 1.4.0`, `rtk 0.50.0`, `gitnexus 1.6.12`, `claude-mem 12.1.3`).

| Group | Scope | Automated E2E File | Harness / Contract Status | Real Host / Provider Status | Remediation Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Group A** | Setup (`setup`, `setup` 2nd run, `--check`, `--repair`, `doctor`, PATH/binary discovery, OS service registration) | `tests/e2e/scenarios/e11-group-a-setup.e2e.test.ts` | **PASS** | **PASS (`0o700` dir & 1st-run 32 `role-skills` installed)** | `QA-P34-01`, `QA-P34-02` **FIXED & VERIFIED** |
| **Group B** | Agent Providers (`claude`, `codex`, `agy` × 9 dimensions; version check never treated as execution proof) | `tests/e2e/scenarios/e12-group-b-agent-providers.e2e.test.ts` | **PASS** (`27/27`) | **PASS (`27/27` across `claude 2.1.301`, `codex 0.162.0`, `agy 1.4.0` + Herdr `0.9.5`)** | `QA-P34-03`..`QA-P34-06` **FIXED & VERIFIED** |
| **Group C** | Non-Chat Agent Behavior (build error, missing info, approval required, role prompt & handoff policy, no bypass when blocked) | `tests/e2e/scenarios/e13-group-c-non-chat-agent-behavior.e2e.test.ts` | **PASS** | **PASS (Real Prompts/Profiles + Live `claude`/`codex` JSON turns)** | — |
| **Group D** | MCP Sharing (`1 Claude + 1 Codex + 1 Agy + 3 Developer instances` = 6 agents; backend/connection count, invocation, memory, restart, cross-project isolation) | `tests/e2e/scenarios/e14-group-d-mcp-sharing.e2e.test.ts` | **PASS** | **PASS (`83.10%` RSS / `78.74%` PSS saved across 6 agents)** | — |
| **Group E** | Tool Integrations (RTK, Claude-Mem, GitNexus, Chrome DevTools, Superpowers, Role-specific skills, 9 Unified Commands) | `tests/e2e/scenarios/e15-group-e-tool-integrations.e2e.test.ts` | **PASS** | **PASS (Default CLI wiring + Real `gitnexus 1.6.12` status JSON)** | `QA-P34-07`, `QA-P34-08` **FIXED & VERIFIED** |
| **Group F** | Lifecycle (`init`, `up`, `attach`, Conversation Agent SDLC task, `down`, `up` & resume) | `tests/e2e/scenarios/e16-group-f-lifecycle.e2e.test.ts` | **PASS** | **PASS (Real SQLite/ArtifactStore/Git worktrees + Live `herdr 0.9.5` daemon tabs/panes/agents)** | — |

---

## 2. Detailed Test Cases by Group (Expected, Actual, Logs, Status)

### Group A: Setup (`tests/e2e/scenarios/e11-group-a-setup.e2e.test.ts`)

#### Case A1: `bflow setup` (1st run on clean isolated environment)
- **Test Mode**: Real CLI (`runCli(["setup", "--yes", "--json"])`) against a fresh unprepped state root (`setup.isolatedRoot`).
- **Expected**:
  - Creates machine state/config directories with mode `0700`, installs all 32 builtin skills into `skills-store` on the very first run, writes `state.json` and setup receipt with `outcome: "applied"`.
- **Actual (Post-Fix `QA-P34-01` & `QA-P34-02`)**:
  1. `apps/cli/src/setup-integration.ts` creates and `chmod`s `platform.paths.state`, `platform.paths.config`, `platform.paths.data`, `managedToolsDir`, and `storeRoot` (`skills-store`) with mode `0o700` (`QA-P34-01` fixed).
  2. `SkillsSetupSynchronizer.desired(ctx)` (`packages/skills/src/setup.ts`) sets `repairNeeded: false` during `apply` mode when `skills-store` is clean/uninitialized (reserving `repairNeeded: true` for corrupted stores or `check`/`dry_run` inspection), so `bflow setup --yes --json` installs all 32 builtin skills on the first run (`QA-P34-02` fixed).
- **Logs**:
  ```json
  {
    "ok": true,
    "mode": "apply",
    "skills": { "installedCount": 32, "repairNeeded": false },
    "receipt": {
      "outcome": "applied",
      "appliedActions": ["role-skills", "mcp-config", "os-service"]
    }
  }
  ```
- **Status**: `PASS (Real CLI + Clean Isolated State Root, QA-P34-01 & QA-P34-02 Verified Fixed)`

#### Case A2: `bflow setup --repair`
- **Test Mode**: Real CLI (`runCli(["setup", "--repair", "--yes", "--json"])`) + Real `SkillFileStore` (32 builtin skill bundles) + corrupted `state.json` recovery.
- **Expected**:
  - Repairs missing/corrupted `role-skills` and `state.json`, installing all 32 builtin skills and recording `receipt.outcome === "repaired"`.
- **Actual**:
  - `bflow setup --repair --yes --json` succeeded (`exitCode: 0`), installed all 32 skills (`skills.installedCount: 32`, `skills.repairNeeded: false`), and recovered after intentional `state.json` corruption (`{corrupted-json`).
- **Logs**:
  ```json
  {
    "mode": "repair",
    "receipt": {
      "outcome": "repaired",
      "appliedActions": ["role-skills", "mcp-config", "os-service"]
    }
  }
  ```
- **Status**: `PASS (Real CLI + Isolated State Root)`

#### Case A3: `bflow setup` (2nd run idempotency)
- **Test Mode**: Real CLI (`runCli(["setup", "--yes", "--json"])`) immediately after synchronized state.
- **Expected**:
  - Second run is idempotent (`exitCode: 0`, `skills.installedCount: 32`, `skills.repairNeeded: false`, no duplicate mutations).
- **Actual**:
  - Completed with `exitCode: 0`, `mode: "apply"`, `skills.installedCount: 32`, `skills.repairNeeded: false`.
- **Logs**:
  ```json
  {
    "mode": "apply",
    "skills": { "installedCount": 32, "repairNeeded": false },
    "receipt": { "outcome": "noop", "appliedActions": [] }
  }
  ```
- **Status**: `PASS (Real CLI + Isolated State Root)`

#### Case A4: `bflow setup --check`
- **Test Mode**: Real CLI (`runCli(["setup", "--check", "--json"])`) on converged vs corrupted state.
- **Expected**:
  - Read-only verification (`mode: "check"`): exits `0` when converged (`installedCount: 32`, `repairNeeded: false`) and exits `1` when `state.json` is corrupted.
- **Actual**:
  - Converged check returned `ok: true, exitCode: 0`; corrupted `state.json` check returned `ok: false, exitCode: 1` without mutating disk state.
- **Logs**:
  ```json
  {
    "mode": "check",
    "skills": { "installedCount": 32, "repairNeeded": false }
  }
  ```
- **Status**: `PASS (Real CLI + Isolated State Root)`

#### Case A5: `bflow doctor`
- **Test Mode**:
  1. **Harness**: `runDoctorDiagnostics` with injected healthy overrides across all 6 diagnostic groups (`environment`, `herdr`, `providers`, `mcp`, `tools`, `skills`).
  2. **Real Host**: `runDoctorDiagnostics({ cwd: repoDir })` probing real `herdr 0.9.5`, `claude 2.1.301`, `codex 0.162.0`, `agy 1.4.0`, `git`, `node`, `pnpm`, `rtk`, `gitnexus`.
- **Expected**:
  - Emits structured checks across all 6 groups (`environment`, `herdr`, `providers`, `mcp`, `tools`, `skills`); fails closed (`healthy: false`) when any required session check (`herdr:server` when session is down) fails.
- **Actual (Post-Fix `QA-P34-03`..`QA-P34-06`)**:
  - **Harness**: `healthy: true`, `14/14` checks `pass`.
  - **Real Host**: All 6 diagnostic groups (`environment`, `herdr`, `providers`, `mcp`, `tools`, `skills`) execute against real host binaries; when no project Herdr daemon is running, `herdr:server` reports `fail` and `healthy: false` as designed.
- **Logs**:
  ```json
  {
    "healthy": true,
    "groups": ["environment", "herdr", "providers", "mcp", "tools", "skills"]
  }
  ```
- **Status**: `PASS (Harness & Real Host Diagnostics)`

#### Case A6: PATH and Binary Discovery
- **Test Mode**: Real `detectPlatform()` + `probeTools()` against host `PATH` and empty `PATH: ""`.
- **Expected**:
  - Discovers real `git`, `node`, `pnpm`, `herdr`, `rtk`, `gitnexus`, `claude`, `codex`, `agy` with SHA-256 binary digests and parsed versions; fails closed (`status: "missing"`) when `PATH` is empty.
- **Actual**:
  - Real `probeTools` resolved `/usr/bin/git` (`2.43.0`), `/home/baodq/.local/bin/herdr` (`0.9.5`), `/home/baodq/.cargo/bin/rtk` (`0.50.0`), `/home/baodq/.local/bin/gitnexus` (`1.6.12`), `/home/baodq/.local/bin/claude` (`2.1.301`), `/home/baodq/.local/share/fnm/.../codex` (`0.162.0`), `/usr/bin/agy` (`1.4.0`). With `PATH: ""`, all required tools reported `status: "missing"`.
- **Logs**:
  ```json
  [
    { "toolId": "git", "status": "present", "version": "2.43.0" },
    { "toolId": "herdr", "status": "present", "version": "0.9.5" },
    { "toolId": "rtk", "status": "present", "version": "0.50.0" },
    { "toolId": "gitnexus", "status": "present", "version": "1.6.12" }
  ]
  ```
- **Status**: `PASS (Real Host Binaries)`

#### Case A7: OS Service Registration (`systemd-user`)
- **Test Mode**: Real `OsServiceManager` (`@bflow/mcp-services`) + real `systemd-analyze verify` on generated unit file (`bflow-mcp-gateway.service`).
- **Expected**:
  - Generates deterministic `systemd-user` unit file with `ExecStart`, `Restart=on-failure`, `Environment="BFLOW_GATEWAY_MANAGED=1"`, writes `.bflow-owner` SHA-256 ownership marker, and passes `systemd-analyze verify` syntax validation.
- **Actual**:
  - `registerService` wrote `/tmp/.../.config/systemd/user/bflow-mcp-gateway.service` and `.bflow-owner`; `systemd-analyze verify` confirmed valid unit syntax; `unregisterService` cleanly removed owned unit file while refusing to delete unowned files.
- **Logs**:
  ```ini
  [Unit]
  Description=Bflow Shared MCP Gateway (bflow-mcp-gateway)
  [Service]
  Type=simple
  ExecStart="/home/baodq/.local/share/fnm/node-versions/v24.16.0/installation/bin/node" "--version"
  Restart=on-failure
  Environment="BFLOW_GATEWAY_MANAGED=1"
  ```
- **Status**: `PASS (Real systemd-user Unit Generation & Verification)`

---

### Group B: Agent Providers (`tests/e2e/scenarios/e12-group-b-agent-providers.e2e.test.ts` & `docs/provider-compatibility.md`)

All 9 required dimensions were tested for `claude`, `codex`, and `agy` across both **Mock Provider Binaries** and **Real Installed Provider CLIs + Live Herdr `0.9.5`**. Full per-provider logs and root-cause analyses are documented in [`docs/provider-compatibility.md`](./provider-compatibility.md).

| # | Dimension | `claude` (`2.1.301`) | `codex` (`0.162.0`) | `agy` (`1.4.0`) | Summary of Real Execution & Logs |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **B1** | Binary detection | **PASS (Mock & Real)** | **PASS (Mock & Real, `QA-P34-03` Fixed)** | **PASS (Mock & Real)** | Real `claude` (`2.1.301`), `codex` (`0.162.0`, `280.8 MiB` <= `512 MiB` cap), and `agy` (`1.4.0`) pass SHA-256 + executable attestation. |
| **B2** | Authentication | **PASS (Mock & Real)** | **PASS (Mock & Real)** | **PASS (Mock & Real, `QA-P34-04` Fixed)** | Real `claude auth status`, `codex login status`, and `agy models` + `--model <m> --print ping` pass live authentication and non-interactive probe execution. |
| **B3** | Herdr pane startup | **PASS (Mock & Live Herdr `0.9.5`)** | **PASS (Mock & Live Herdr `0.9.5`)** | **PASS (Mock & Live Herdr `0.9.5`)** | Live `herdr --session <sess> server` + `pane run` + `pane report-agent` spawned real pane processes for all 3 providers in an isolated Herdr `0.9.5` session. |
| **B4** | Environment propagation | **PASS (Mock & Real)** | **PASS (Mock & Real)** | **PASS (Mock & Real)** | `BFLOW_SESSION_ID`, `BFLOW_CORRELATION_ID`, `BFLOW_MCP_GATEWAY_URL`, and `BFLOW_ROLE` propagated into child panes while `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and `GEMINI_API_KEY` were stripped when `secretBindings: {}`. |
| **B5** | Permission behavior (`restricted`, `workspace_auto`, `unattended_isolated`) | **PASS (Mock & Real, `QA-P34-05` Fixed)** | **PASS (Mock & Real)** | **PASS (Mock & Real)** | `unattended_isolated` fails closed when `verifiedOsSandbox !== true`. Real `claude 2.1.301` compiles `--permission-mode dontAsk --tools Read,Glob,Grep` (`restricted`) and `--append-system-prompt-file` (`QA-P34-05` fixed). Real `codex 0.162.0` and `agy 1.4.0` pass permission compilation. |
| **B6** | Trusted workspace | **PASS (Mock & Real)** | **PASS (Mock & Real)** | **PASS (Mock & Real, `QA-P34-06` Fixed)** | Real `claude`, `codex`, and `agy` execute non-interactive turns in fresh temp git repos; `prepareAgySessionHome` materializes session-isolated `<stateDir>/agy-home/.gemini/antigravity-cli/settings.json` with `trustedWorkspaces` without mutating user `$HOME` (`QA-P34-06` fixed). |
| **B7** | MCP connectivity | **PASS (Mock & Real)** | **PASS (Mock & Real)** | **PASS (Mock & Real)** | All 3 providers connect to live `HttpGatewayServer` + `StdioBridge` and pass adapter MCP health validation. |
| **B8** | Skills availability | **PASS (Mock & Real)** | **PASS (Mock & Real)** | **PASS (Mock & Real)** | All 32 catalog skills synced with SHA-256 digest verification and rendered into provider prompt/skill files. |
| **B9** | Execution readiness (version check != readiness) | **PASS (Mock & Real)** | **PASS (Mock & Real)** | **PASS (Mock & Real)** | Verified that `--version` alone never satisfies `checkHealth(stage: "activated")`; live `checkHealth(stage: "preflight")` returns `status: "ready"` and `prepareLaunch()` returns `ok: true` across all 3 real provider CLIs. |

---

### Group C: Non-Chat Agent Behavior (`tests/e2e/scenarios/e13-group-c-non-chat-agent-behavior.e2e.test.ts`)

#### Case C1: Canonical Role Profiles & Prompt Policy (`agents/*/role-profile.json` & `system-prompt.md`)
- **Test Mode**: Real repository files (`agents/{chat,coordinator,analyst,architect,planner,developer,reviewer,verifier}`) + `validateAutonomousRolePrompt` + `readBuiltinRolePrompt`.
- **Expected**:
  - Only `chat` (`role: "conversation"`) has `userFacing: true`. All 7 non-chat roles (`coordinator`, `specifier`, `architect`, `planner`, `developer`, `reviewer`, `qa`) have `userFacing: false` and embed `NON_USER_FACING_AUTONOMOUS_POLICY`.
- **Actual**:
  - All 8 role profiles and system prompts passed schema and autonomous policy validation (`ok: true`). Builtin prompts for `developer` and `reviewer` contain the exact `NON_USER_FACING_AUTONOMOUS_POLICY` block.
- **Logs**:
  ```json
  {
    "conversation": { "userFacing": true, "hasMandatoryNonChatBlock": false },
    "developer": { "userFacing": false, "hasMandatoryNonChatBlock": true },
    "reviewer": { "userFacing": false, "hasMandatoryNonChatBlock": true }
  }
  ```
- **Status**: `PASS (Real Repository Assets)`

#### Case C2: Build Error Escalation & Prohibition of Direct User Questions (`Developer` & `Reviewer`)
- **Test Mode**: Behavioral policy engine (`evaluateBehavioralScenario`, `validateAutonomousStructuredResult`, `validateHerdrRoleHandoff`) + **Real Live Provider Execution** (`claude 2.1.301` and `codex 0.162.0` executing with `NON_USER_FACING_AUTONOMOUS_POLICY`).
- **Expected**:
  - When encountering a build error (`TS2305`), `developer` and `reviewer` never ask the user directly in their pane, never address `recipient.role === "user"` or `"conversation"`, and emit structured JSON `{ status: "blocked", next_role: "coordinator" }`.
- **Actual**:
  - `validateHerdrRoleHandoff` rejected all direct specialist $\to$ `conversation` and specialist $\to$ `user` envelopes (`ok: false`).
  - `validateAutonomousStructuredResult` rejected any `developer` or `reviewer` result containing user-directed questions (`ok: false`).
  - **Live `claude 2.1.301` (`claude -p --output-format json`)** and **Live `codex 0.162.0` (`codex exec`)** both returned valid autonomous JSON payloads (`status: "blocked"`, `next_role: "coordinator"`, zero conversational questions) that passed `validateAutonomousStructuredResult("developer", parsed)` and `evaluateBehavioralScenario({ scenario: "build_error", ... })`.
- **Logs**:
  ```json
  {
    "provider": "claude-2.1.301",
    "status": "blocked",
    "summary": "Build failed due to missing contract export and unapproved production migration.",
    "evidence": ["error TS2305: Module '@bflow/contracts' has no exported member 'MissingType'"],
    "artifacts": [],
    "blockers": ["Requires production database DROP TABLE migration approval"],
    "requested_action": "Escalate to Coordinator for contract alignment and human approval",
    "next_role": "coordinator"
  }
  ```
- **Status**: `PASS (Harness + Real Live Claude 2.1.301 & Codex 0.162.0 Execution)`

#### Case C3: Missing Information & Approval Required Routing via `Coordinator` $\to$ `ConversationGateway`
- **Test Mode**: `evaluateBehavioralScenario` + `ConversationGateway` + `HerdrConversationBridge`.
- **Expected**:
  - Non-critical missing information continues with a documented reversible assumption (`actionTaken: "continue_with_assumption"`).
  - Approval-required tasks escalate from `developer` $\to$ `coordinator` (`status: "blocked"`, `next_role: "coordinator"`), and `Coordinator` forwards `conversation.clarification` and `approval.request` to `ConversationGateway` (which transitions session status to `"awaiting_user_approval"` and rejects spoofed non-user approval turns).
- **Actual**:
  - `ambiguous_safe_assumption` recorded `assumptions: ["Default limit = 50 items per page"]` and completed without asking user.
  - `approval_required` escalated to `coordinator`; `gateway.handleCoordinatorRoleMessage(clarReqMsg)` emitted `userNotification.intent === "clarification_question"`; `gateway.handleCoordinatorRoleMessage(appReqMsg)` transitioned session status to `"awaiting_user_approval"`; spoofed agent turn (`origin: "agent"`, `authenticatedUser: false`) was rejected (`spoofedTurn.ok === false`).
- **Logs**:
  ```json
  {
    "clarificationIntent": "clarification_question",
    "sessionStatusAfterApprovalRequest": "awaiting_user_approval",
    "spoofedAgentApprovalRejected": true
  }
  ```
- **Status**: `PASS (Harness)`

#### Case C4: No Policy Bypass When Blocked (Scope Escape, Dangerous Commands, Prompt Injection)
- **Test Mode**: `isPathWithinOwnedPaths`, `detectDangerousInstructions`, `evaluateBehavioralScenario`.
- **Expected**:
  - Blocked agent cannot modify files outside `ownedPaths` (`packages/contracts/src/index.ts` rejected when `ownedPaths: ["packages/core/**"]`), cannot execute destructive git/filesystem commands (`git push --force`, `rm -rf .bflow`), and escalates prompt-injection attempts (`malicious_repository_content`) with `status: "blocked"`.
- **Actual**:
  - Scope escape rejected (`false`), dangerous instructions flagged (`safe: false`, findings $> 0$), and `malicious_repository_content` escalated to `coordinator` with zero artifacts produced.
- **Logs**:
  ```json
  {
    "pathInScope": true,
    "contractPathInCoreScope": false,
    "dangerousCheckSafe": false,
    "maliciousScenarioAction": "escalate_blocked"
  }
  ```
- **Status**: `PASS (Harness)`

---

### Group D: MCP Sharing (`tests/e2e/scenarios/e14-group-d-mcp-sharing.e2e.test.ts` & `docs/mcp-memory-benchmark.md`)

Full Linux `/proc/<pid>/status` (`VmRSS`) and `/proc/<pid>/smaps_rollup` (`Pss`) measurements are documented in [`docs/mcp-memory-benchmark.md`](./mcp-memory-benchmark.md).

#### Case D1: 6 Concurrent Agent Registrations (`1 Claude + 1 Codex + 1 Agy + 3 Developer Instances`) Sharing 1 MCP Backend
- **Test Mode**: Real `McpGateway` + Real `HttpGatewayServer` + 3 Real `StdioBridge` instances + Real Node.js stdio MCP backend child process.
- **Expected**:
  - All 6 agent sessions (`agent-claude-coord`, `agent-codex-rev`, `agent-agy-qa`, `agent-claude-dev-1`, `agent-codex-dev-2`, `agent-agy-dev-3`) discover `shared_index_lookup` and `shared_symbol_graph`, invoke tools concurrently, and share **exactly 1** backend OS process (`backendCount === 1`, `activeConnections === 6`).
- **Actual**:
  - All 6 agents discovered and invoked the shared tools concurrently across HTTP and `StdioBridge` transports. `gateway.getHealth()` reported `activeConnections: 6`, `backends[0].state: "healthy"`, `activeSessions: 6`, and **1 single backend PID**.
- **Logs**:
  ```json
  {
    "activeConnections": 6,
    "backendPidCount": 1,
    "backendState": "healthy",
    "activeSessions": 6,
    "toolCallsSucceeded": 6
  }
  ```
- **Status**: `PASS (Real Multi-Process MCP Gateway & Bridges)`

#### Case D2: Service Restart & Transparent Recovery
- **Test Mode**: Real child process kill (`process.kill(firstBackendPid, "SIGKILL")`) + `gateway.restartBackend(serviceId)` + subsequent tool calls from all 6 agent sessions.
- **Expected**:
  - After backend crash/restart, a new backend OS PID is spawned (`secondBackendPid !== firstBackendPid`), `restartCount` increments to `1`, and all 6 existing agent registrations continue invoking tools without re-registering.
- **Actual**:
  - Backend restarted cleanly with a new OS PID, `restartCount === 1`, and post-restart `callTool` succeeded with `callCount === 1` on the fresh worker.
- **Logs**:
  ```json
  {
    "firstBackendPid": 148912,
    "secondBackendPid": 148945,
    "restartCount": 1,
    "postRestartToolCallOk": true
  }
  ```
- **Status**: `PASS (Real Process Crash & Recovery)`

#### Case D3: Cross-Project Isolation (`repo-alpha` vs `repo-beta`)
- **Test Mode**: Real `McpGateway` scope enforcement between `repo-alpha` and `repo-beta`.
- **Expected**:
  - An agent registered in `repo-beta` cannot list or invoke repository-scoped MCP services belonging to `repo-alpha`, and cannot hijack a `repo-alpha` registration ID under a `repo-beta` scope.
- **Actual**:
  - `listTools` for `repo-beta` returned `[]` for `repo-alpha` services; cross-project `callTool` returned `ok: false, error.code: "permission_denied"`.
- **Logs**:
  ```json
  {
    "repoBetaToolsFromAlphaService": [],
    "crossProjectCallOk": false,
    "errorCode": "permission_denied"
  }
  ```
- **Status**: `PASS (Real Gateway Scope Isolation)`

#### Case D4: Real Linux Memory Benchmark (Shared Gateway vs Per-Agent Isolated Backends for $N = 6$ Agents)
- **Test Mode**: Real Linux `/proc/<pid>/status` (`VmRSS`) and `/proc/<pid>/smaps_rollup` (`Pss`) across `shared-code-index`, real `claude-mem 12.1.3` (`worker-service.cjs --mcp`), and real `gitnexus 1.6.12` (`gitnexus mcp`).
- **Expected**:
  - Shared MCP Gateway architecture uses significantly less memory than spawning 6 per-agent isolated backends.
- **Actual**:
  - **Lightweight `shared-code-index` ($N=6$)**: Shared = `128,892 kB` RSS (`17,746 kB` PSS) vs Isolated = `251,384 kB` RSS (`37,794 kB` PSS) $\to$ **saves `122,492 kB` (`48.73%`) RSS / `20,048 kB` (`53.05%`) PSS**.
  - **Combined Real Stack (`claude-mem 12.1.3` + `gitnexus 1.6.12`, $N=6$)**: Shared = `195,436 kB` (`190.86 MiB`) RSS / `125,317 kB` (`122.38 MiB`) PSS vs Isolated = `1,156,396 kB` (`1,129.29 MiB`) RSS / `589,334 kB` (`575.52 MiB`) PSS $\to$ **saves `960,960 kB` (`938.44 MiB` / `83.10%`) RSS and `464,017 kB` (`453.14 MiB` / `78.74%`) PSS**.
- **Logs**: See full per-PID tables in [`docs/mcp-memory-benchmark.md`](./docs/mcp-memory-benchmark.md).
- **Status**: `PASS (Real Linux /proc Telemetry)`

---

### Group E: Tool Integrations (`tests/e2e/scenarios/e15-group-e-tool-integrations.e2e.test.ts`)

| # | Integration | Test Mode | Expected | Actual & Logs | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **E1** | **RTK (`0.50.0`)** | Real `/home/baodq/.cargo/bin/rtk` binary | `verifyRtk` passes; `runWithRtk(..., false)` filters output while `runWithRtk(..., true)` (`rtk proxy`) preserves raw output; `rtkProviderIntegration` probes `claude`/`codex`/`agy`; `applyRtkConfiguration` writes owned config & blocks unowned file overwrite; `rollbackRtkConfiguration` restores state. | `verifyRtk("rtk", "0.50.0") === true`; `claude`/`codex`/`agy` routes `supported: true`; owned config applied (`status: "applied"`), unowned overwrite blocked (`status: "blocked"`), rollback restored (`status: "rolled_back"`). | **PASS (Real Binary)** |
| **E2** | **Claude-Mem (`12.1.3`)** | Real loopback HTTP server + Real live host worker (`127.0.0.1:37777`, PID `4376`) + Real `worker-service.cjs --mcp` stdio probe | `observeClaudeMemWorker` verifies loopback health and blocks non-loopback `192.168.1.10`; `ClaudeMemProjectReader` returns only matching `project` rows and throws `"Cross-project memory response rejected"` on leaked rows; stdio MCP exposes `search`, `timeline`, `get_observation`. | Loopback health `status: "ready"`; non-loopback `status: "blocked"`; `ClaudeMemProjectReader` rejected cross-project row from `repo-beta`; live host worker PID `4376` verified healthy (`version: "12.1.3"`); real `worker-service.cjs --mcp` negotiated protocol `2024-11-05` with tools `["search", "timeline", "get_observation", "save_memory"]`. | **PASS (Real Worker & Stdio MCP)** |
| **E3** | **GitNexus (`1.6.12`)** | Harness `ToolHost` + Real `/home/baodq/.local/bin/gitnexus` (`1.6.12`) | `ensureGitNexusIndex` indexes repo; `createGitNexusService` builds `stdio_mcp` definition; `probeStdioMcp` discovers `query`, `impact`, `context`. | **Harness & Real `gitnexus 1.6.12` (`QA-P34-08` Fixed)**: `parseGitNexusStatus` strips warning/header lines before `{` and `gitNexusFreshnessSchema` accepts `status: z.enum(["up-to-date", "registered", "stale"])`, so `ensureGitNexusIndex` returns `status: "indexed"` (`indexOk: true`) on real `gitnexus 1.6.12`. Real `createGitNexusService` and `probeStdioMcp` (`gitnexus mcp`) discovered `["query", "impact", "context", "detect_changes", "rename", "cypher", "list_repos"]`. | **PASS (Real Binary & Stdio MCP, `QA-P34-08` Fixed)** |
| **E4** | **Chrome DevTools (`146.0.7680.80`)** | Real `/usr/bin/google-chrome` binary + `planChromeSession` + `DedicatedBrowserRuntime` | `planChromeSession` creates `0700` per-task profile `<root>/chrome/<repoId>/<taskId>`, blocks when `SingletonLock` exists (`profile_locked`), and `DedicatedBrowserRuntime` blocks cross-task page navigation (`page_ownership_conflict`). | Real `/usr/bin/google-chrome --version` probed; profile created at `.../chrome/repo-alpha/task-ui-1`; `SingletonLock` blocked with `status: "profile_locked"`; cross-task `navigatePage` rejected with `code: "conflict"`, `diagnosticCode: "page_ownership_conflict"`. | **PASS (Real Chrome Binary + Runtime)** |
| **E5** | **Superpowers & Role-Specific Skills** | Real `skills/` catalog (32 skills) + `SkillManager` + `RoleSkillBindingsSchema` | `superpowersInstallRoute` returns provider commands; `verifySuperpowersSkills` enforces `using-superpowers` entry skill; all 32 builtin skills sync across 10 roles $\times$ 3 providers with non-chat decision routing; missing required tool fails closed (`Missing skill tool:`). | All 32 skills installed and verified (`10 roles x 3 providers = 30 sync manifests`); `conversation` role received user-facing decision prompt while all 9 non-chat roles received `"Route every question or approval through Runtime → Herdr → Conversation; disable native direct questions/elicitation."`; missing tool threw `Missing skill tool:`. | **PASS (Real Skill Catalog)** |
| **E6** | **Unified Commands (9 P29 Commands)** | Real `runHighLevelCli` across `repo inspect`, `task plan`, `task implement`, `verify`, `git prepare`, `mcp status`, `tool status`, `skills sync`, `agent check` | All 9 commands execute with deterministic envelopes and journaled steps, including default `runHighLevelCli` invocation without injected test overrides. | All 9 commands executed and verified (`inspected`, `planned`, `prepared`, `not_passed` $\to$ `passed`, `approval_required` $\to$ `integration_prepared`, `ready`/`not_ready`, `synced`). With `withDefaultPlatformPorts` in `apps/cli/src/high-level/index.ts` (`QA-P34-07` fixed) and `skills-sync.ts:84` (`QA-P34-02` fixed), default `bflow skills sync` returns `outcome: "synced"` (`installedCount: 32`), default `bflow mcp status` reads machine-setup MCP config (`outcome: "ready"`), and `bflow agent check claude` returns `outcome: "ready"` (`QA-P34-05` fixed). | **PASS (Real Unified Commands, `QA-P34-02/05/07` Fixed)** |

---

### Group F: Lifecycle (`tests/e2e/scenarios/e16-group-f-lifecycle.e2e.test.ts`)

#### Case F1: `bflow init` (1st run & 2nd run idempotency)
- **Test Mode**: Real CLI (`runCli(["init", "--json"], { cwd: repoDir })`).
- **Expected**:
  - Creates `.bflow/config.yaml` and `.bflow/.gitignore` (protecting `state/`, `logs/`, `secrets/`, `*.db`), and is idempotent on 2nd run (`overwritten: false`).
- **Actual**:
  - `initFirst.ok === true`, `initSecond.ok === true`, `.bflow/config.yaml` and `.bflow/.gitignore` created and preserved on second run.
- **Logs**:
  ```json
  { "configPath": ".../.bflow/config.yaml", "overwritten": false }
  ```
- **Status**: `PASS (Real CLI)`

#### Case F2: `bflow up` & `bflow attach` (Harness + Live Herdr `0.9.5` Daemon)
- **Test Mode**:
  1. **Harness**: `EnvironmentLifecycle.up()` and `EnvironmentLifecycle.attach()` with `openPaneManagerEnvironment` + stateful Herdr `0.9.5` protocol-22 runner.
  2. **Live Herdr `0.9.5` Daemon**: Real `herdr --session <session> server` daemon lifecycle in an isolated `XDG_RUNTIME_DIR` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME` environment.
- **Expected**:
  - `bflow up` boots the project-scoped Herdr session, creates the 3 tabs (`Conversation`, `Coordination`, `Verification`), binds the 7 permanent role panes (`conversation`, `coordinator`, `specifier`, `architect`, `planner`, `reviewer`, `qa`), and writes `.bflow/state/session.json`.
  - `bflow attach` focuses **only** the `conversation` pane (`role: "conversation"`, `tabLabel: "Conversation"`).
- **Actual**:
  - **Harness**: `up` succeeded (`status: "up"`, 3 tabs, 7 permanent role panes, idempotent on 2nd `up`); `attach` focused the `conversation` pane.
  - **Live Herdr `0.9.5` Daemon**:
    - Live `herdr --session <sess> server` started cleanly, `status server --json` reported `{ "running": true, "protocol": 22 }`, `workspace create` + `tab rename Conversation` + `tab create Coordination|Verification` created all 3 Bflow tabs, `pane run` + `pane report-agent` bound the `conversation` agent in the root pane (`agent get` verified `agent: "claude", agent_status: "idle"`), `session stop` stopped the daemon cleanly, and restarting the daemon succeeded.
- **Logs**:
  ```json
  {
    "session": "bflow-e2e-f-...",
    "running": true,
    "tabs": ["Conversation", "Coordination", "Verification"],
    "conversationAgent": { "agent": "claude", "agent_status": "idle" }
  }
  ```
- **Status**: `PASS (Harness + Live Herdr 0.9.5 Daemon)`

#### Case F3: Conversation Agent Executes Full SDLC Task (`Clarification` $\to$ `DelegationRequest` $\to$ `Specification` $\to$ `TddDecision` $\to$ `Developer Worktree` $\to$ `Verification` $\to$ `Human Approval`)
- **Test Mode**: Real `ConversationGateway` + Real `CoordinatorService` + Real `RuntimeService` + Real `SqliteRunStore` (`node:sqlite`) + Real `FilesystemArtifactStore` + Real `GitOrchestrator` (creating real Git worktrees & commits on disk).
- **Expected**:
  - User submits ambiguous request $\to$ Conversation Agent asks clarification $\to$ User clarifies $\to$ Conversation Agent emits `DelegationRequest` to Coordinator $\to$ Specifier & Planner run $\to$ Developer spawns in an isolated Git worktree (`.bflow/worktrees/...`), commits `guide.md` update, and passes scope check $\to$ Reviewer & QA gates verify against `Specification` $\to$ Coordinator pauses at `release_approval` gate and sends `approval.request` to Conversation Agent $\to$ User approves via Conversation Agent $\to$ GitOrchestrator merges task branch into integration branch and cleans up worktree.
- **Actual**:
  - Executed end-to-end against real SQLite, real ArtifactStore, and real Git worktrees:
    - Ambiguous turn transitioned session to `awaiting_user_clarification`.
    - Clarified turn produced `DelegationRequest` (`corr-sdlc-f-1`) and transitioned session to `delegated_to_coordinator`.
    - `plan`, `implement`, and `verify` tasks succeeded (`runSnapshot.status === "waiting_approval"` on task `release`).
    - Real Git worktree created, `guide.md` modified and committed, diff and scope verified (`changedFiles: ["guide.md"]`).
- **Logs**:
  ```json
  {
    "runId": "run-sdlc-1",
    "statusBeforeApproval": "awaiting_approval",
    "statusAfterApproval": "completed",
    "coreRunStatus": "succeeded",
    "worktreeChangedFiles": ["guide.md"]
  }
  ```
- **Status**: `PASS (Real SQLite + Real ArtifactStore + Real Git Worktrees + Runtime/Coordinator/Conversation)`

#### Case F4: `bflow down` (Active Run Guard + Checkpoint) & `bflow up` + `bflow resume`
- **Test Mode**: Real `EnvironmentLifecycle.down()` + Real `SqliteRunStore` close/reopen + `DeterministicWorkflowEngine.recover()` + `AgenticWorkflowRuntime` resume + user approval.
- **Expected**:
  - `bflow down` without `--yes` refuses to stop while `run-resume-2` is active (`Unsafe shutdown: 1 active runs`).
  - `bflow down --yes` writes an aggregate checkpoint (`bflow.workflow-aggregate+json`) to SQLite before stopping the Herdr session.
  - After closing and reopening `SqliteRunStore` and running `bflow up`, `DeterministicWorkflowEngine.recover()` restores `run-resume-2` from SQLite without duplicate developer dispatches, and user approval completes `run-resume-2` (`status: "completed"`, `snapshot.status: "succeeded"`) and merges `other.md` into the integration branch.
- **Actual**:
  - `down(false)` failed closed with `"Unsafe shutdown: 1 active runs. Inspect state and rerun bflow down --yes to confirm. Nothing was stopped."`.
  - `down(true)` persisted aggregate checkpoint (`bflow.workflow-aggregate+json`) and stopped the session (`status: "down"`).
  - Second `bflow up` reconciled the session (`status: "up"`), `recover()` restored `run-resume-2` from SQLite without duplicate developer dispatches (`devDispatchesAfterResumeTick === devDispatchesBeforeDown`), user approval completed `run-resume-2` (`status: "completed"`, `snapshot.status: "succeeded"`), and `GitOrchestrator` merged `other.md`.
- **Logs**:
  ```json
  {
    "downWithoutYesBlocked": true,
    "checkpointsPersistedOnDown": 1,
    "recoveredRunStatus": "running",
    "finalRunStatus": "completed",
    "coreSnapshotStatus": "succeeded"
  }
  ```
- **Status**: `PASS (Real SQLite Persistence + Real Git Merge/Cleanup + Harness Herdr Transport)`

---

## 3. Summary of Defects Uncovered & Remediated (`QA-P34-01` – `QA-P34-08`)

| Defect ID | Severity | Owning Package / File | Root Cause & Verified Fix | Status |
| :--- | :--- | :--- | :--- | :--- |
| **`QA-P34-01`** | **High (P1)** | `apps/cli/src/setup-integration.ts` | `mkdir(storeRoot, { recursive: true })` omitted `{ mode: 0o700 }`. **Fix**: Added `{ recursive: true, mode: 0o700 }` and explicit `chmod(..., 0o700)` for `state`, `config`, `data`, `managedToolsDir`, and `skills-store`. | **FIXED & VERIFIED (`e11`)** |
| **`QA-P34-02`** | **Medium (P2)** | `packages/skills/src/setup.ts` & `apps/cli/src/high-level/commands/skills-sync.ts` | `SkillsSetupSynchronizer.desired()` set `repairNeeded: true` when `skills-store` was empty (`0 !== 32`), causing `bflow setup` (`apply` mode) to skip `role-skills`. **Fix**: Scoped `repairNeeded` in `apply` mode to corrupted stores only (`observed.diagnostics.some(...)`) and updated `skills-sync.ts` post-apply check to `!after.valid || after.stateDigest !== desired.digest`. | **FIXED & VERIFIED (`e11`, `e15`)** |
| **`QA-P34-03`** | **High (P1)** | `packages/agent-providers/src/attestation.ts:299` | `256 MiB` executable size cap rejected standalone `codex 0.162.0` (`280.8 MiB`). **Fix**: Increased maximum verified binary size to `512 * 1024 * 1024` (`512 MiB`). | **FIXED & VERIFIED (`e12`)** |
| **`QA-P34-04`** | **High (P1)** | `packages/agent-providers/src/agy-adapter.ts:47–54` | `AgyProviderAdapter.getProbeCommand` placed `--model` after `--print` (`["--print", "--model", model, "ping"]`). **Fix**: Placed `--model <model>` before `--print ping` and increased probe timeout to `45_000ms`. | **FIXED & VERIFIED (`e12`)** |
| **`QA-P34-05`** | **High (P1)** | `packages/agent-providers/src/base-adapter.ts` & `permissions.ts` | `claude 2.1.301 --help` formats `--append-system-prompt[-file]` with brackets and uses `--permission-mode` instead of `--restricted`. **Fix**: Added bracketed flag expansion `/--([A-Za-z0-9_-]+)\[([A-Za-z0-9_-]+)\]/g` in `detectCapabilities()` and accepted `--permission-mode` in `compileClaudePermissions`. | **FIXED & VERIFIED (`e12`, `e15`)** |
| **`QA-P34-06`** | **Medium (P2)** | `packages/agent-providers/src/base-adapter.ts` | `agy 1.4.0` requires `trustedWorkspaces` in `$HOME/.gemini/antigravity-cli/settings.json`. **Fix**: Added `prepareAgySessionHome(environment)` to materialize a session-isolated `<stateDir>/agy-home/.gemini/antigravity-cli/settings.json` with `trustedWorkspaces` without mutating user `$HOME`. | **FIXED & VERIFIED (`e12`)** |
| **`QA-P34-07`** | **Medium (P2)** | `apps/cli/src/high-level/index.ts` | `runHighLevelCli` did not wire default `skills` or `mcpGateway` ports when `options.services` was omitted. **Fix**: Added `withDefaultPlatformPorts()` wiring `SkillsSetupSynchronizer` + `SkillFileStore` and `McpConfigFileSchema` reader by default. | **FIXED & VERIFIED (`e15`)** |
| **`QA-P34-08`** | **Medium (P2)** | `packages/tool-installer/src/integrations.ts` | `gitnexus 1.6.12 status --json` prints warning lines before `{` and emits `"status": "registered"` after `gitnexus analyze`. **Fix**: Stripped pre-JSON lines in `parseGitNexusStatus` and added `"registered"` to `gitNexusFreshnessSchema` and `ensureGitNexusIndex`. | **FIXED & VERIFIED (`e15`)** |
