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
| **E11** | `scenarios/e11-group-a-setup.e2e.test.ts` | **Group A (Setup — Isolated Host Environment)**: First-time `bflow setup`, idempotency, `bflow setup --check`, `bflow setup --repair`, truthful `bflow doctor` results when Herdr is absent, PATH & binary discovery, and OS service registration. Optional live Herdr checks require the live-platform opt-in. Also covers `QA-P34-01` & `QA-P34-02`. | Varies by platform and opt-in |
| **E12** | `scenarios/e12-group-b-agent-providers.e2e.test.ts` | **Group B (Agent Providers — Mock/Harness + Optional Live Providers)**: Mock-backed checks cover binary detection, authentication failures, environment propagation, permission behavior, trusted workspace, MCP, skills, and Ed25519-attested readiness. Live provider authentication and real Herdr pane tests require explicit opt-in. `--version` and Herdr `done` alone never establish readiness. | Varies by opt-in |
| **E13** | `scenarios/e13-group-c-non-chat-agent-behavior.e2e.test.ts` | **Group C (Non-Chat Agent Behavior — Harness)**: Build failure, missing information, and approval-required tasks across non-chat roles: Developer and Reviewer never ask the user directly, Coordinator receives structured escalations, `ConversationGateway` is the sole user-facing decision point, and blocked agents cannot bypass scope/approval/safety policies. This scenario uses the conversation/role harness; it does not provide live Herdr evidence. | Harness checks |
| **E14** | `scenarios/e14-group-d-mcp-sharing.e2e.test.ts` | **Group D (MCP Sharing — Real Multi-Agent HTTP/SSE Gateway + `/proc` Memory Benchmark)**: 6 concurrent agents share one MCP backend, exercise concurrent tools, exclusive leases, crash recovery, cross-project isolation, and measure Linux `/proc` RSS/PSS memory. This evidence-bearing test runs on Linux only. | Linux only |
| **E15** | `scenarios/e15-group-e-tool-integrations.e2e.test.ts` | **Group E (Tool Integrations + P29 Unified Commands)**: Deterministic harness checks cover GitNexus status parsing, injected browser-launcher ownership, Superpowers routes, builtin skills, and all 9 unified commands. Real RTK/GitNexus binary checks require live-platform opt-in and fail if the opted-in binary is missing. Default MCP status reports not-ready until a Gateway actually reports health. | Varies by platform and opt-in |
| **E16** | `scenarios/e16-group-f-lifecycle.e2e.test.ts` | **Group F (Lifecycle — Harness + Live Herdr)**: The real Runtime/SQLite/ArtifactStore/Git lifecycle runs on Linux; the live Herdr multi-pane scenario also requires live-platform opt-in. | Linux plus optional live Herdr |

Test totals vary with platform and explicit live-platform opt-in. Skipped live checks are reported as skipped and are not counted as provider, Herdr, or private-tool acceptance evidence.

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
- Passing deterministic and supported-host tests across `e01` through `e16`; Linux-only `/proc` and `flock` checks are skipped on other platforms.

### Optional live platform acceptance

E11's setup/skills lifecycle uses the real setup engine, launcher and content-addressed
skills store in a temporary account home. It supplies an explicit empty machine
configuration/installer registry and a version-only Herdr fixture, while Node, Git and
pnpm run from the host. This checks first apply, `0700` permissions, all 33 skill
bundles, idempotency, read-only checks and repair without downloading tools, changing
provider accounts or starting a Gateway. Live Herdr compatibility and provider
readiness remain separate opt-in checks.

The default suite does not require a developer's provider credentials, Herdr binary, or private RTK/GitNexus installations. To run live provider authentication and the live provider/Herdr checks, opt in explicitly:

```bash
BFLOW_TEST_LIVE_PLATFORM=1 pnpm exec vitest run --config tests/e2e/vitest.config.ts
```

`BFLOW_TEST_LIVE_HERDR=1` enables only the Herdr-specific E11/E12/E16 checks. With either flag, required binaries and authentication must be present; those tests fail on missing tools or failed readiness. E15 accepts `BFLOW_TEST_RTK_BIN` and `BFLOW_TEST_GITNEXUS_BIN` to select installed binaries; when live-platform checks are enabled, a missing binary fails the test. These opt-in checks provide evidence only for the machine and credentials where they ran.

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
