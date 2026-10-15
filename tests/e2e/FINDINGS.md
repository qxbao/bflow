# P08 Findings & Upstream Defect Catalog

During the design, implementation, and execution of the P08 End-to-End Integration verification suite, the following cross-module defects, security gaps, and architectural limitations in upstream packages were identified and verified with deterministic reproduction probes.

In accordance with project safety guidelines, tests were not modified to assert defective behavior as valid. Instead, authentic safety invariants are asserted, resulting in reproducible RED failures for upstream remediation.

---

## Summary of Findings

| ID | Severity | Affected Package | Location | Description | Reproduction Probe |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **PM-01** | P1 (High) | `packages/quality-gates` | `src/evaluator.ts:254` | Evaluator marks skipped required quality gates as `status: "passed"`, bypassing mandatory workflow verification. | `e05-quality-gates.e2e.test.ts` (Probe PM-01) |
| **PM-03** | P1 (High) | `packages/quality-gates` | `src/evaluator.ts:689` | When `outputParser` is omitted, `minPassedTestsCount` is ignored. Running 0 tests evaluates to `status: "passed"`. | `e05-quality-gates.e2e.test.ts` (Probe PM-03, **RED**) |
| **PM-04** | P1 (High) | `packages/quality-gates` | `src/rbac-approval.ts:496-525` | Governance evaluation does not verify that `gateResult.runId` matches `input.runId`. Foreign run results allow delivery progression. | `e05-quality-gates.e2e.test.ts` (Probe PM-04, **RED**) |
| **PM-08** | P2 (Medium) | `packages/quality-gates` | `src/evaluator.ts:646` | `CommandQualityGate` mints an arbitrary uncoordinated `evaluationId` rather than preserving the engine-coordinated ID from context. | `e05-quality-gates.e2e.test.ts` (Probe PM-08) |
| **PM-11** | P1 (High) | `packages/runtime` | `src/service.ts:399-408` | Runtime unconditionally confirms cancellation stop even if `transport.cancel` reports failure, emitting false stopped confirmation. | `e07-cancellation.e2e.test.ts` (Probe PM-11, **RED**) |
| **PM-12** | P1 (High) | `apps/cli` | `src/bin.ts:8-23` | CLI entrypoint executable does not compose or inject `RuntimeService` dependencies into `CliContext`. All business commands fail with `transport_unavailable`. | `e09-cli.e2e.test.ts` (Prerequisite Gate) |
| **PM-13** | P3 (Low) | `apps/cli` | `src/commands.ts:390-440` | CLI does not handle standard `--version` flag, treating it as an unknown command and exiting with code 2. | `e09-cli.e2e.test.ts` (Flag Validation) |

---

## Detailed Defect Reports

### 1. PM-03: Quality Gates Missing Execution Evidence Bypass
- **Severity**: P1 (High)
- **Component**: `packages/quality-gates/src/evaluator.ts:689`
- **Impact**: A quality gate configured to require at least `N` passed unit tests (e.g. 100 tests) will pass with 0 tests executed if the evaluator spec does not specify a custom `outputParser`.
- **Root Cause**: The minimum test count assertion is nested inside `if (this.spec.outputParser)`. When `outputParser` is undefined, the parser check is skipped entirely, allowing a command with 0 tests executed to pass as long as its exit code is 0.
- **Verification Evidence**:
  ```
  FAIL tests/e2e/scenarios/e05-quality-gates.e2e.test.ts > Scenario E05 > PROBE PM-03
  AssertionError: expected 'passed' to be 'failed'
  ```
- **Remediation Recommendation**: In `evaluator.ts`, check `this.spec.outputExpectation?.minPassedTestsCount` unconditionally; if no parser is provided, record `MISSING_EXECUTION_EVIDENCE` when test count assertions are mandated.

---

### 2. PM-04: Governance Evaluation Accepts Foreign Run Results
- **Severity**: P1 (High)
- **Component**: `packages/quality-gates/src/rbac-approval.ts:496-525`
- **Impact**: Cross-run isolation failure. A malicious or erroneously passed gate result belonging to run `run-A` can be submitted to approve delivery progression on run `run-B`.
- **Root Cause**: `evaluateAutomatedVsHumanGovernance` iterates over `input.automatedGateResults` and checks `g.status === "passed"`, but never asserts `g.runId === input.runId`.
- **Verification Evidence**:
  ```
  FAIL tests/e2e/scenarios/e05-quality-gates.e2e.test.ts > Scenario E05 > PROBE PM-04
  AssertionError: expected true to be false
  - false
  + true
  ```
- **Remediation Recommendation**: In `rbac-approval.ts`, reject any gate result where `result.runId !== input.runId` and return `{ ok: false, error: { code: "validation", message: "Quality gate result runId does not match governance request runId" } }` or mark `allAutomatedGatesPassed: false`.

---

### 3. PM-11: Premature Cancellation Stop Confirmation Without Transport Verification
- **Severity**: P1 (High)
- **Component**: `packages/runtime/src/service.ts:399-408`
- **Impact**: Emits false 'stopped' confirmation to clients. When an operator requests cancellation of a long-running execution, runtime attempts transport cancel, ignores any transport failure, and immediately transitions the task state to terminal `"cancelled"` in the engine aggregate. The remote agent may continue executing and consuming resources while the system falsely marks it stopped.
- **Root Cause**: In `service.ts`:
  ```ts
  // 1. Send transport cancel
  await this.ports.transport.cancel(handle, cancelRequest, options);

  // 2. Release lease if active
  ...
  // 3. Confirm cancellation stop for this specific execution
  const stopRes = await this.ports.engine.confirmCancellationStop(...);
  ```
  The return value of `this.ports.transport.cancel` is not checked.
- **Verification Evidence**:
  ```
  FAIL tests/e2e/scenarios/e07-cancellation.e2e.test.ts > Scenario E07 > PROBE PM-11
  AssertionError: expected 'cancelled' not to be 'cancelled'
  ```
- **Remediation Recommendation**: Inspect the result of `transport.cancel`. If `transport.cancel` fails or returns `ok: false`, the runtime must NOT confirm cancellation stop; the task should remain in `"cancelling"` state pending reconciliation or report a non-terminal cancellation status.

---

### 4. PM-12: Missing CLI Runtime Composition (`BLOCKED_BY_P07`)
- **Severity**: P1 (High) / Prerequisite Blocker
- **Component**: `apps/cli/src/bin.ts:8-23`
- **Impact**: End-to-end execution of workflows via the CLI binary (`apps/cli/dist/bin.js run <requirement>`) is non-operational.
- **Root Cause**: `main()` runs `runCli(args, { ...context })` without constructing or wiring a `RuntimeService` instance (which requires `SqliteRunStore`, `FilesystemArtifactStore`, `FileAgentRegistry`, `WorkflowEngine`, and transport adapters).
- **Verification Evidence**:
  ```json
  {
    "ok": false,
    "command": "run",
    "error": {
      "code": "transport_unavailable",
      "retryable": true,
      "message": "RuntimeService is not configured. Provide a RuntimeService instance in CliContext."
    }
  }
  ```
- **Remediation Recommendation**: Implement an application composition root in `apps/cli` (or a dedicated factory) that reads `.ai-flow/config.json`, initializes the storage and runtime ports, and supplies `context.runtime` to `runCli`.

---

## Conclusion

The core backend subsystems (Deterministic Core Engine, SQLite Persistence, Filesystem Artifact Store, File Agent Registry, and Runtime Dispatcher) demonstrate rock-solid stability, correct OCC concurrency, atomic rollback, and strict SHA-256 integrity under all adversarial tests.

However, full end-to-end certification must be classified as **`BLOCKED_BY_PREREQUISITE`** until the owning agents remediate:
1. P04 Quality Gate invariants (PM-03, PM-04).
2. P06 Cancellation transport verification (PM-11).
3. P07 CLI runtime container composition (PM-12).
