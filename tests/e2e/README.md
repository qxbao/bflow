# P08 — bflow End-to-End Integration & System Verification

## Overview

This directory contains the P08 End-to-End (E2E) integration test harness and verification suites for the bflow system.

The suite verifies multi-package integration across:
- `@bflow/contracts` (public contract schemas, types, and invariant validators)
- `@bflow/core` (deterministic workflow engine, DAG evaluation, transition logic)
- `@bflow/agent-registry` (`FileAgentRegistry`, monotonic fencing tokens, lease enforcement, role handoffs)
- `@bflow/persistence` (`SqliteRunStore`, WAL mode, OCC concurrency, atomic batch commits)
- `@bflow/artifact-store` (`FilesystemArtifactStore`, SHA-256 verification, private verified snapshots)
- `@bflow/quality-gates` (`CommandQualityGate`, subprocess execution, governance & RBAC evaluation)
- `@bflow/runtime` (`RuntimeService`, `WorkflowOrchestrator`, `TaskDispatcher`, crash recovery & reconciliation)
- `apps/cli` (CLI command parsing, formatting, runtime composition in `bin.ts`, and subprocess execution)

---

## Scenarios Matrix

| Scenario | File | Description | Status |
| :--- | :--- | :--- | :--- |
| **E01** | `scenarios/e01-happy-path.e2e.test.ts` | Complete 4-stage SDLC workflow (`plan` -> `implement` -> `review` -> `qa`), strict TAP parser verification (15 passed tests), real Node.js subprocess unit test suite verified through `CommandQualityGate`, ArtifactStore byte verification with SHA-256 checksums, and durable state re-query across harness restart. | **1 PASS** |
| **E02** | `scenarios/e02-crash-recovery.e2e.test.ts` | Crash & recovery integration: honest running reopen across store instances, running task recovery without duplicate sends, aggregate checkpoint + event tail replay, real subprocess `SIGKILL` recovery at dispatch boundary (`task.dispatch_requested`), receipt boundary (`unknown-after-write` reconciled as `bound`), and binding boundary (`agent.execution_bound`), plus recovery of pending human approvals and pending quality gates (`quality_gate.evaluation_requested`) across restart. *(Physical power loss and kernel panic remain `NOT VERIFIED`)*. | **8 PASS** |
| **E03** | `scenarios/e03-unknown-delivery.e2e.test.ts` | Unknown delivery handling & restart reconciliation: durable `task.dispatch_requested` before transport send, no blind resend on `unknown_delivery`, 0 external writes on drop-before-write, ledger reconciliation binds active execution, safe re-dispatch when confirmed `not_delivered`, and 3 unknown-delivery-across-restart tests (`unknown_delivery` remains blocked, reconciled `bound` with 0 duplicate sends, reconciled `not_delivered` (`retrySafe: true`) safely re-dispatches). | **7 PASS** |
| **E04** | `scenarios/e04-concurrency-leases.e2e.test.ts` | Multi-run isolation, single-slot agent concurrency limit, task queueing, and strictly monotonic fencing tokens across leases. | **2 PASS** |
| **E05** | `scenarios/e05-quality-gates.e2e.test.ts` | Quality gate execution: real Node.js test runner execution via `createRealNodeUnitTestGate`, passing/failing suites, zero-test failure, strict TAP parser fail-closed malformed streams, protocol output smoke, and 5 verified regression probes (PM-01 mandatory gate skip rejection, PM-02 deadline enforcement, PM-03 missing test count evidence rejection, PM-04 foreign run result rejection, PM-05 stale approval revision/generation rejection). | **15 PASS** |
| **E06** | `scenarios/e06-approval-rework.e2e.test.ts` | Human governance approval, bounded rework cycles, generation tracking, rework budget exhaustion (`maxReworks: 1` -> run status `failed`), and type-safe proposal ingestion without casts. | **4 PASS** |
| **E07** | `scenarios/e07-cancellation.e2e.test.ts` | Cancellation invariants: positive Core cancellation workflow with exact schema IDs and verified idempotency, two-phase cancellation keeping task in `"cancelling"` until remote stop is confirmed (`PrematureCancel`), and transport failure handling during cancellation (`PM-11`). | **3 PASS** |
| **E08** | `scenarios/e08-artifact-security.e2e.test.ts` | Artifact security boundary: proposal ingestion, SHA-256 checksum verification, path traversal rejection, on-disk blob tampering detection, and untrusted proposal rejection with strict contract alignment (`trust: "stored"`). *(Raw symlink and special device rejection are verified in P03 `@bflow/artifact-store` tests)*. | **4 PASS** |
| **E09** | `scenarios/e09-cli.e2e.test.ts` | CLI subprocess execution with bounded timeout: `--help` (exit 0), `--version` semver output (`PM-13`), unknown command and argument validation, `bflow init`, malformed config JSON handling, fail-closed `status -j` without config, and end-to-end `init` -> `run` -> `status` -> `cancel` execution using `BFLOW_HERDR_BIN`. | **7 PASS** |
| **E10** | `scenarios/e10-failure-injection.e2e.test.ts` | OCC version/sequence conflicts, pre-validation batch rejection, checkpoint conflict, SQLite corruption detection, on-disk blob tampering detection, forged reference rejection, closed store handle rejection after restart, safe acquisition failure cleanup, receipt collision (`bindAgentExecution` / `recordDeliveryReconciliation`), session replacement / stale execution fencing, fail-closed artifact publication during `completeTaskExecution`, and P02 `buildCompleteFeatureWorkflowExample` verification with real `ArtifactStore`. | **12 PASS** |
| **E11** | `scenarios/e11-group-a-setup.e2e.test.ts` | **Group A (Setup — Real Isolated Host Environment)**: First-time `bflow setup`, second-time idempotency, `bflow setup --check`, `bflow setup --repair`, `bflow doctor` (human + `--json`), PATH & binary discovery (`resolveBinary` + symlink/permission rejection), and OS service registration (`systemd-user` unit rendering, validation, and live `systemctl --user` install/start/stop/remove). Also documents `QA-P34-01` & `QA-P34-02`. | **3 PASS** |
| **E12** | `scenarios/e12-group-b-agent-providers.e2e.test.ts` | **Group B (Agent Providers — Mock/Harness + Real Installed Binaries & Live Herdr)**: Full 9-dimension provider verification across `claude`, `codex`, and `agy`: binary detection, authentication, Herdr pane startup, environment propagation, permission behavior (`restricted`, `workspace_auto`, `unattended_isolated`), trusted workspace, MCP connectivity, skills availability, and Ed25519-attested execution readiness (proving `--version` / Herdr `done` alone is never readiness proof). Also documents `QA-P34-03` through `QA-P34-06`. | **6 PASS** |
| **E13** | `scenarios/e13-group-c-non-chat-agent-behavior.e2e.test.ts` | **Group C (Non-Chat Agent Behavior — Harness + Live Herdr)**: Build failure, missing information, and approval-required tasks across non-chat roles: Developer and Reviewer never ask the user directly, Coordinator receives structured escalations, `ConversationGateway` is the sole user-facing decision point, and blocked agents cannot bypass scope/approval/safety policies. Includes live Herdr 4-pane (`chat`, `coordinator`, `developer`, `reviewer`) escalation & delegation test. | **5 PASS** |
| **E14** | `scenarios/e14-group-d-mcp-sharing.e2e.test.ts` | **Group D (MCP Sharing — Real Multi-Agent HTTP/SSE Gateway + `/proc` Memory Benchmark)**: 6 concurrent agents (`claude` Conversation, `codex` Coordinator, `agy` Reviewer, and 3 `Developer` instances across all 3 providers) sharing 1 MCP backend process (`backendProcessCount = 1`, `activeConnections = 6`), concurrent tool invocation, exclusive resource lease serialization, automatic backend crash/restart recovery (`revision = 2`), cross-project isolation, and real Linux `/proc/<pid>/status` + `smaps_rollup` RSS/PSS memory comparison against 6 isolated backends. | **1 PASS** |
| **E15** | `scenarios/e15-group-e-tool-integrations.e2e.test.ts` | **Group E (Tool Integrations — Real Host Binaries + P29 Unified Commands)**: Verification of RTK (`0.37.0`), Claude-Mem (`12.1.3`), GitNexus (`1.6.12`), Chrome DevTools (`0.21.0` + `BrowserRuntimeManager`), Superpowers (`5.0.7`), all 32 builtin role-specific skills across 8 SDLC roles and 3 providers, and all 9 P29 unified commands (`repo inspect`, `task plan`, `task implement`, `verify`, `git prepare`, `mcp status`, `tool status`, `skills sync`, `agent check`). Also documents `QA-P34-07`. | **4 PASS** |
| **E16** | `scenarios/e16-group-f-lifecycle.e2e.test.ts` | **Group F (Lifecycle — Deterministic Harness + Real Live Herdr `0.8.0` Multi-Pane)**: Complete project lifecycle: `bflow init`, `bflow up` (7 permanent roles across 3 tabs), `bflow attach` (Conversation Agent only), Conversation Agent -> Coordinator -> `AgenticWorkflowRuntime` SDLC task execution (Spec -> Conditional TDD -> Worktree -> Independent Verification -> Git Integration), `bflow down` (persisting `GracefulShutdownReceipt`), and `bflow up` + `SessionRecoveryService` resume without duplicate runs or orphan panes. | **2 PASS** |

**Summary: 16 scenarios (`e01`–`e16`) | 84 total tests | 84 PASS | 0 FAIL**

---

## Running the E2E Suite

> [!NOTE]
> The root repository test runner (`pnpm test` / `pnpm check`) discovers `packages/**/*.test.ts` and `apps/**/*.test.ts`. E2E tests in `tests/e2e/` are invoked explicitly using the commands below. Build workspace packages (`pnpm build`) before running E2E subprocess tests (`e02`, `e09`) because subprocess workers import compiled `dist/` entrypoints.

### 1. Typecheck

Verify that all test suites strictly compile against exported `@bflow/contracts` and public package APIs without diagnostics:

```bash
pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit
```

Expected exit code: `0` (0 diagnostics).

### 2. Execute E2E Suite

Run all 16 scenarios in Vitest:

```bash
pnpm exec vitest run --config tests/e2e/vitest.config.ts
```

Expected output:
- **16 passed test files (84 passing tests, 0 failures)** across `e01` through `e16`.

---

## Test Harness Architecture

The test harness is implemented in `tests/e2e/helpers/`:

1. **`harness.ts`**:
   - Manages temporary directory lifecycles (`mkdtemp` under `tmpdir()`).
   - Implements safe owned-resource acquisition lifecycle with `try/catch/finally` and `AggregateError` preserving primary and cleanup errors.
   - Validates all `OperationResult` returns during setup (`agentRegistry.upsert`, `service.init`).
   - Composes real `SqliteRunStore`, `FilesystemArtifactStore`, `FileAgentRegistry`, `DeterministicWorkflowEngine`, and `RuntimeService`.
   - Provides safe `restart()` that closes old handles, catches re-open failures without leaking, and preserves temporary state directory across instances.
   - Enforces idempotent `cleanup()` that guards against double-cleanup and never touches paths outside the temporary directory.
   - Exposes public test seams (`openRunStore`, `openArtifactStore` factory overrides) for testing resource acquisition failure handling.

2. **`fixtures.ts`**:
   - Schema-compliant factories for SDLC workflow definitions, artifact proposals, and verified agent results.
   - Reusable `createStrictTapParser({ requirePlan, minPassedTestsCount })`: fail-closed TAP parser validating plan, ok/not ok lines, directive skips, and summary counts.
   - Real subprocess quality gate helpers `createSafeSubprocessGate` and `createRealNodeUnitTestGate` executing actual Node.js scripts and `node:test` suites under strict security policies.
   - Strongly typed `readArtifactBytes` returning `Promise<OperationResult<Buffer>>` without unsafe `as` casts.
   - Discriminated union narrowing helpers `expectOk<T>` and `expectFailure<T>`.

3. **`fixture-transport.ts`**:
   - Deterministic test-only implementation of `AgentTransport` satisfying contracts.
   - Supports controllable transport delay, timeout, ledger tracking, delivery modes (`accepted`, `unknown-before-write`, `unknown-after-write`, `unknown_delivery`, `error`), and pre-send observation hook `onBeforeSend`.
   - Cancellation tracking distinguishes cancellation request (`status: "cancelling"`) from explicit remote process termination (`confirmStop(executionId)`).
   - Separates in-memory transport attempts (`sendCallsCount`) from external write events (`externalWriteCount`).
