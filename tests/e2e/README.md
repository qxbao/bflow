# P08 — AI Flow SDLC End-to-End Integration & System Verification

## Overview

This directory contains the P08 End-to-End (E2E) integration test harness and verification suites for the AI Flow SDLC system.

The suite verifies multi-package integration across:
- `@ai-flow/contracts` (public contract schemas, types, and invariant validators)
- `@ai-flow/core` (deterministic workflow engine, DAG evaluation, transition logic)
- `@ai-flow/agent-registry` (`FileAgentRegistry`, monotonic fencing tokens, lease enforcement)
- `@ai-flow/persistence` (`SqliteRunStore`, WAL mode, OCC concurrency, atomic batch commits)
- `@ai-flow/artifact-store` (`FilesystemArtifactStore`, SHA-256 verification, private verified snapshots)
- `@ai-flow/quality-gates` (`CommandQualityGate`, subprocess execution, evidence recording)
- `@ai-flow/runtime` (`RuntimeService`, `WorkflowOrchestrator`, `TaskDispatcher`)
- `apps/cli` (CLI command parsing, formatting, and subprocess execution)

---

## Scenarios Matrix

| Scenario | File | Description | Status |
| :--- | :--- | :--- | :--- |
| **E01** | `scenarios/e01-happy-path.e2e.test.ts` | Complete 4-stage SDLC workflow (`plan` -> `implement` -> `review` -> `qa`), strict TAP parser verification (15 passed tests), real Node.js subprocess unit test suite verified through `CommandQualityGate`, ArtifactStore byte verification with SHA-256 checksums, and durable state re-query across harness restart. | **1 PASS** |
| **E02** | `scenarios/e02-crash-recovery.e2e.test.ts` | Closed/reopened store instances simulation: resumption from SQLite run state, aggregate checkpoint reconstruction, and tail event replay on honest running reopen. *(Pre-dispatch crash boundary and OS power loss remain `NOT VERIFIED`)*. | **3 PASS** |
| **E03** | `scenarios/e03-unknown-delivery.e2e.test.ts` | Unknown delivery handling: exactly 1 send attempt without blind resend, 0 external writes on drop-before-write, ledger reconciliation binds active execution, and safe re-dispatch when confirmed `not_delivered`. *(Marked `PARTIAL`: crash/restart unknown boundary remains `NOT VERIFIED`; 1 RED probe on missing durable `task.dispatch_requested`)*. | **2 PASS / 1 FAIL (RED Probe)** |
| **E04** | `scenarios/e04-concurrency-leases.e2e.test.ts` | Multi-run isolation, single-slot agent concurrency limit, task queueing, and strictly monotonic fencing tokens across leases. | **2 PASS** |
| **E05** | `scenarios/e05-quality-gates.e2e.test.ts` | Quality gate execution: real Node.js test runner execution via `createRealNodeUnitTestGate`, passing/failing suites, zero-test failure, strict TAP parser fail-closed malformed streams, protocol output smoke, and 5 authentic RED defect probes (PM-01, PM-02, PM-03, PM-04, PM-05). | **10 PASS / 5 FAIL (RED Probes)** |
| **E06** | `scenarios/e06-approval-rework.e2e.test.ts` | Human governance approval, bounded rework cycles, generation tracking, rework budget exhaustion (`maxReworks: 1` -> run status `failed`), and type-safe proposal ingestion without casts. | **4 PASS** |
| **E07** | `scenarios/e07-cancellation.e2e.test.ts` | Cancellation invariants: positive Core cancellation workflow with exact schema IDs and verified idempotency, plus 2 authentic RED probes: Premature cancellation on accepted-without-stop, and PM-11 (transport failure confirmation). | **1 PASS / 2 FAIL (RED Probes)** |
| **E08** | `scenarios/e08-artifact-security.e2e.test.ts` | Artifact security boundary: proposal ingestion, SHA-256 checksum verification, path traversal rejection, on-disk blob tampering detection, and untrusted proposal rejection with strict contract alignment (`trust: "stored"`). *(Raw symlink and special device rejection are verified in P03 `@ai-flow/artifact-store` tests outside P08)*. | **4 PASS** |
| **E09** | `scenarios/e09-cli.e2e.test.ts` | CLI subprocess execution with bounded 10s timeout and SIGKILL: `--help` (exit 0), malformed config JSON handling, `BLOCKED_BY_P07` runtime composition gate, argument validation, and PROBE PM-13 (`--version` exit 0 + semver, RED). | **6 PASS / 1 FAIL (RED Probe)** |
| **E10** | `scenarios/e10-failure-injection.e2e.test.ts` | OCC version/sequence conflicts, atomic batch rollback (pre-validation rejection), checkpoint conflict, SQLite corruption detection, on-disk blob tampering detection, forged reference rejection, old store query rejection after restart, and safe acquisition failure handling via test seam. *(Note: batch pre-validation rejection does NOT prove mid-transaction rollback inside SQLite engine execution)*. | **8 PASS** |

**Summary: 50 total tests | 41 PASS | 9 FAIL (Authentic Upstream RED Probes)**

---

## Running the E2E Suite

> [!NOTE]
> The root repository test runner (`pnpm test` / `pnpm check`) discovers only `packages/**/*.test.ts` and `apps/**/*.test.ts`; it does **NOT** discover E2E tests in `tests/e2e/`. E2E tests must be invoked explicitly using dedicated commands as shown below. A CI integration change request has been submitted to add a dedicated `test:e2e` script to root configuration.

### 1. Typecheck

Verify that all test suites strictly compile against exported `@ai-flow/contracts` and public package APIs without diagnostics:

```bash
pnpm exec tsc -p tests/e2e/tsconfig.json --noEmit
```

Expected exit code: `0` (0 diagnostics).

### 2. Execute E2E Suite

Run all 10 scenarios in Vitest:

```bash
pnpm exec vitest run --config tests/e2e/vitest.config.ts
```

Expected output:
- **41 passing tests** across the scenario suites.
- **9 failing tests (authentic RED defect probes)** reproducing upstream defects in P04, P06, and P07:
  1. `e03`: `P06-DispatchIntent` — Runtime emits generic running transition without persisting durable `task.dispatch_requested` with request identity and fencing token.
  2. `e05`: `PROBE PM-01 (P04 DEFECT)` — Required quality gate downgraded to passed when `spec.required: false, skip: true`.
  3. `e05`: `PROBE PM-02 (P04 DEFECT)` — `CommandQualityGate` ignores `OperationOptions` deadline/timeoutMs before execution.
  4. `e05`: `PROBE PM-03 (P04 DEFECT)` — Missing test count evidence does not fail the gate when `outputParser` is omitted.
  5. `e05`: `PROBE PM-04 (P04 DEFECT)` — Governance evaluation accepts foreign run gate results.
  6. `e05`: `PROBE PM-05 (P04 DEFECT)` — Governance evaluation accepts stale approval decisions across rework cycles.
  7. `e07`: `PROBE (P06 DEFECT)` — Runtime prematurely marks task cancelled when transport only returns `accepted` without confirmed stop.
  8. `e07`: `PROBE PM-11 (P06 DEFECT)` — Runtime unconditionally confirms cancellation stop even if `transport.cancel` fails.
  9. `e09`: `PROBE PM-13 (P07 DEFECT)` — CLI `--version` exits with code 2 instead of returning semver string.

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
   - Real subprocess quality gate helper `createSafeSubprocessGate` executing actual Node.js scripts under strict security policies.
   - Strongly typed `readArtifactBytes` returning `Promise<OperationResult<Buffer>>` without unsafe `as` casts.
   - Discriminated union narrowing helpers `expectOk<T>` and `expectFailure<T>`.

3. **`fixture-transport.ts`**:
   - Deterministic test-only implementation of `AgentTransport` satisfying contracts.
   - Supports controllable transport delay, timeout, ledger tracking, delivery modes (`accepted`, `rejected`, `unknown-before-write`, `unknown-after-write`, `error`), and pre-send observation hook `onBeforeSend`.
   - Cancellation tracking distinguishes cancellation request (`status: "cancelling"`) from explicit remote process termination (`confirmStop(executionId)`).
   - Separates in-memory transport attempts (`sendCallsCount`) from external write events (`externalWriteCount`).
