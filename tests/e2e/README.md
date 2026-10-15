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
| **E01** | `scenarios/e01-happy-path.e2e.test.ts` | Complete 4-stage SDLC workflow (`plan` -> `implement` -> `review` -> `qa`), real Node.js subprocess unit test suite (15 passed tests) verified through `CommandQualityGate`, and terminal run success. | **PASS** |
| **E02** | `scenarios/e02-crash-recovery.e2e.test.ts` | Process crash & restart recovery: resumption from SQLite run state, aggregate checkpoint reconstruction, and tail event replay. | **PASS** |
| **E03** | `scenarios/e03-unknown-delivery.e2e.test.ts` | Unknown delivery handling: transport timeout forbids blind resend, ledger reconciliation binds active execution, and safe re-dispatch when confirmed `not_delivered`. | **PASS** |
| **E04** | `scenarios/e04-concurrency-leases.e2e.test.ts` | Multi-run isolation, single-slot agent concurrency limit, task queueing, and strictly monotonic fencing tokens across leases. | **PASS** |
| **E05** | `scenarios/e05-quality-gates.e2e.test.ts` | Quality gate execution: subprocess pass, exit code fail, empty stdout rejection, command timeout enforcement, and upstream safety invariant probes. | **6 PASS / 2 FAIL (RED Probes)** |
| **E06** | `scenarios/e06-approval-rework.e2e.test.ts` | Human governance approval, bounded rework cycles, generation tracking, and blockage on rework exhaustion. | **PASS** |
| **E07** | `scenarios/e07-cancellation.e2e.test.ts` | Run cancellation, execution halting, lease release, late agent result rejection, idempotency, and cancellation safety probe. | **2 PASS / 1 FAIL (RED Probe)** |
| **E08** | `scenarios/e08-artifact-security.e2e.test.ts` | Artifact security boundary: proposal ingestion, SHA-256 checksum verification, path traversal rejection, and fake reference rejection. | **PASS** |
| **E09** | `scenarios/e09-cli.e2e.test.ts` | CLI subprocess smoke testing: `--help`, `--version` regression documentation, argument validation, `init` execution, and `BLOCKED_BY_P07` runtime composition gate. | **PASS** |
| **E10** | `scenarios/e10-failure-injection.e2e.test.ts` | OCC version/sequence conflicts, atomic batch rollback, checkpoint conflict, SQLite corruption detection, on-disk blob tampering detection, and forged reference rejection. | **PASS** |

---

## Running the E2E Suite

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
- **36 passing tests** across all 10 scenario suites.
- **3 failing tests (authentic RED probes)** reproducing upstream defects in P04 and P06:
  1. `e05`: `PROBE PM-03 (P04 DEFECT)` — Missing test count evidence does not fail the gate.
  2. `e05`: `PROBE PM-04 (P04 DEFECT)` — Governance evaluator accepts foreign run gate results.
  3. `e07`: `PROBE PM-11 (P06 DEFECT)` — Runtime confirms stop without verifying transport cancellation.

---

## Test Harness Architecture

The test harness is implemented in `tests/e2e/helpers/`:

1. **`harness.ts`**:
   - Manages temporary directory lifecycles (`mkdtempSync` under `os.tmpdir()`).
   - Composes real `SqliteRunStore`, `FilesystemArtifactStore`, `FileAgentRegistry`, `DeterministicWorkflowEngine`, and `RuntimeService`.
   - Provides `restart()` to simulate process crash and resumption from disk.
   - Enforces robust `cleanup()`: closes open SQLite database and artifact store connections before removing directories to prevent file descriptor leaks or EBUSY/AggregateError issues.

2. **`fixtures.ts`**:
   - Schema-compliant factories for SDLC workflow definitions, artifact proposals, and verified agent results.
   - Real subprocess quality gate helper `createSafeSubprocessGate` executing actual Node.js scripts under strict security policies.
   - Discriminated union narrowing helpers `expectOk<T>` and `expectFailure<T>`.

3. **`fixture-transport.ts`**:
   - Deterministic test-only implementation of `AgentTransport` satisfying contracts.
   - Supports controllable transport delay, timeout, ledger tracking, and cancellation hooks without requiring a live Herdr daemon.
