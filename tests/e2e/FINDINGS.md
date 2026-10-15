# P08 Findings & Upstream Defect Catalog

During the design, implementation, and execution of the P08 End-to-End Integration verification suite, the following cross-module defects, security gaps, and architectural limitations in upstream packages were identified and verified with deterministic reproduction probes.

In accordance with project safety guidelines, tests were not modified to assert defective behavior as valid. Instead, authentic safety invariants are asserted, resulting in reproducible RED failures for upstream remediation.

---

## Summary of Findings

| ID | Severity | Affected Package | Location | Description | Reproduction Probe |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **PM-01** | P1 (High) | `packages/quality-gates` | `src/evaluator.ts:254` | Evaluator marks skipped required quality gates as `status: "passed"`, bypassing mandatory workflow verification when `spec.required: false, skip: true`. | `e05-quality-gates.e2e.test.ts` (Probe PM-01, **RED**) |
| **PM-02** | P1 (High) | `packages/quality-gates` | `src/evaluator.ts:600-660` | `CommandQualityGate.evaluate` ignores `OperationOptions` deadline and `timeoutMs`, executing subprocess and generating artifacts despite expired deadline. | `e05-quality-gates.e2e.test.ts` (Probe PM-02, **RED**) |
| **PM-03** | P1 (High) | `packages/quality-gates` | `src/evaluator.ts:689` | When `outputParser` is omitted, `minPassedTestsCount` is ignored. Running 0 tests evaluates to `status: "passed"`. | `e05-quality-gates.e2e.test.ts` (Probe PM-03, **RED**) |
| **PM-04** | P1 (High) | `packages/quality-gates` | `src/rbac-approval.ts:496-525` | Governance evaluation does not verify that `gateResult.runId` matches `input.runId`. Foreign run results allow delivery progression. | `e05-quality-gates.e2e.test.ts` (Probe PM-04, **RED**) |
| **PM-05** | P1 (High) | `packages/quality-gates` | `src/rbac-approval.ts:636-646` | Governance evaluation accepts stale approval decisions from prior rework cycles (`revision !== decision.revision` / `generation !== decision.generation`). | `e05-quality-gates.e2e.test.ts` (Probe PM-05, **RED**) |
| **P06-DispatchIntent** | P1 (High) | `packages/runtime` | `src/service.ts:290-330` | Runtime does not persist durable `task.dispatch_requested` with request ID, target, and fencing token before transport write, emitting only a generic task status transition to `running`. | `e03-unknown-delivery.e2e.test.ts` (Exact dispatch requested probe, **RED**) |
| **P06-PrematureCancel** | P1 (High) | `packages/runtime` | `src/service.ts:399-408` | Runtime prematurely marks task cancelled when transport only returns `accepted` without confirmed stop from remote agent. | `e07-cancellation.e2e.test.ts` (Probe PrematureCancel, **RED**) |
| **PM-08** | Contract Decision | `packages/quality-gates` / `runtime` | Contracts / `orchestrator.ts:824` | `QualityGateContext` does not provide `evaluationId`. `CommandQualityGate` generates a default ID, and Runtime orchestrator coordinates and overrides it to the requested execution/evaluation ID before persistence. | `e05-quality-gates.e2e.test.ts` (Observation PM-08, **PASS**) |
| **PM-11** | P1 (High) | `packages/runtime` | `src/service.ts:399-408` | Runtime unconditionally confirms cancellation stop even if `transport.cancel` reports failure, emitting false stopped confirmation. | `e07-cancellation.e2e.test.ts` (Probe PM-11, **RED**) |
| **PM-12** | P1 (High) | `apps/cli` | `src/bin.ts:8-23` | CLI entrypoint executable does not compose or inject `RuntimeService` dependencies into `CliContext`. All business commands fail with `transport_unavailable`. | `e09-cli.e2e.test.ts` (Prerequisite Gate, **PASS**) |
| **PM-13** | P3 (Low) | `apps/cli` | `src/commands.ts:390-440` | CLI does not handle standard `--version` flag, treating it as an unknown command and exiting with code 2. | `e09-cli.e2e.test.ts` (Probe PM-13, **RED**) |

---

## Detailed Defect Reports

### 1. PM-01: Quality Gates Required Gate Downgraded on Skip
- **Severity**: P1 (High)
- **Component**: `packages/quality-gates/src/evaluator.ts:254`
- **Impact**: When a workflow definition specifies that a quality gate is mandatory (`definition.required: true`), but an invocation specifies `spec.required: false, skip: true`, the evaluator evaluates `this.spec.required ?? validContext.definition.required ?? true` to `false`. Because `skip: true`, it immediately returns `{ status: "passed", code: "CHECK_SKIPPED" }`, completely bypassing mandatory security or testing gates.
- **Verification Evidence**:
  ```
  FAIL tests/e2e/scenarios/e05-quality-gates.e2e.test.ts > Scenario E05 > PROBE PM-01
  AssertionError: expected 'passed' not to be 'passed'
  ```
- **Remediation Recommendation**: The workflow definition requirement MUST take precedence over local spec overrides. If `validContext.definition.required === true`, skipping must either be disallowed or result in `status: "failed"` with a `MANDATORY_GATE_SKIPPED` finding.

---

### 2. PM-02: CommandQualityGate Ignores OperationOptions Deadline / Timeout
- **Severity**: P1 (High)
- **Component**: `packages/quality-gates/src/evaluator.ts:600-660`
- **Impact**: Subprocess execution ignores caller deadlines. If a caller passes `options.deadline` (already expired) or `options.timeoutMs`, `CommandQualityGate.evaluate` spawns child processes anyway, writes output artifacts/sentinels to disk, and consumes CPU time despite cancellation/deadline expiry.
- **Verification Evidence**:
  ```
  FAIL tests/e2e/scenarios/e05-quality-gates.e2e.test.ts > Scenario E05 > PROBE PM-02
  AssertionError: expected true to be false
  - false
  + true
  ```
- **Remediation Recommendation**: At the entry of `CommandQualityGate.evaluate`, check `options?.deadline` against current time (and check `options?.signal?.aborted`). If the deadline is passed, immediately return `{ ok: false, error: { code: "timeout", message: "Quality gate execution deadline expired", retryable: false } }` (or `{ code: "validation", ... }` for invalid deadline/timeout values) without spawning any subprocess.

---

### 3. PM-03: Quality Gates Missing Execution Evidence Bypass
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

### 4. PM-04: Governance Evaluation Accepts Foreign Run Results
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

### 5. PM-05: Governance Evaluation Accepts Stale Approval Decisions Across Rework Cycles
- **Severity**: P1 (High)
- **Component**: `packages/quality-gates/src/rbac-approval.ts:636-646`
- **Impact**: Stale approval decisions from prior rework iterations are accepted for new rework revisions. An approval granted for revision 1 (generation 0) allows delivery on revision 2 (generation 1) without re-approval.
- **Root Cause**: `evaluateAutomatedVsHumanGovernance` verifies that `decision.approvalId === approvalRequest.approvalId`, but fails to assert `decision.revision === approvalRequest.revision` and `decision.generation === approvalRequest.generation`.
- **Verification Evidence**:
  ```
  FAIL tests/e2e/scenarios/e05-quality-gates.e2e.test.ts > Scenario E05 > PROBE PM-05
  AssertionError: expected true to be false
  - false
  + true
  ```
- **Remediation Recommendation**: In `rbac-approval.ts`, strictly assert that `decision.approvalId === approvalRequest.approvalId` AND `decision.revision === approvalRequest.revision` and `decision.generation === approvalRequest.generation`. If mismatched, treat the approval decision as invalid/stale (`canProceedToDelivery: false`).

---

### 6. P06-DispatchIntent: Runtime Emits Generic Running Transition Without Durable `task.dispatch_requested`
- **Severity**: P1 (High)
- **Component**: `packages/runtime/src/service.ts:290-330`
- **Impact**: Architectural durability violation. In the event of an unknown delivery or pre-transport crash, the runtime cannot prove dispatch intent with request ID, target agent ID, and fencing token because it only emits a generic `task.status_changed` event to `running` instead of persisting `task.dispatch_requested`.
- **Verification Evidence**:
  ```
  FAIL tests/e2e/scenarios/e03-unknown-delivery.e2e.test.ts > Scenario E03 > handles unknown delivery before write
  AssertionError: expected undefined to be defined
  ```
- **Remediation Recommendation**: Runtime must emit and persist `task.dispatch_requested` with exact dispatch payload (including requestId, target, idempotency key) in the RunStore event stream BEFORE executing the transport send.

---

### 6. P06-DispatchIntent: Runtime Emits Generic Running Transition Without Durable `task.dispatch_requested`
- **Severity**: P1 (High)
- **Component**: `packages/runtime/src/service.ts:290-330`
- **Impact**: Architectural durability violation. In the event of an unknown delivery or pre-transport crash, the runtime cannot prove dispatch intent with request ID, target agent ID, and fencing token because it only emits a generic `task.status_changed` event to `running` instead of persisting `task.dispatch_requested`.
- **Verification Evidence**:
  ```
  FAIL tests/e2e/scenarios/e03-unknown-delivery.e2e.test.ts > Scenario E03 > handles unknown delivery timeout
  AssertionError: expected undefined to be defined
  ```
- **Remediation Recommendation**: Runtime must emit and persist `task.dispatch_requested` with exact dispatch payload (including requestId, target, idempotency key) in the RunStore event stream BEFORE executing the transport send.

---

### 7. P06-PrematureCancel: Runtime Prematurely Confirms Task Cancellation on Transport 'accepted' Without Confirmed Stop
- **Severity**: P1 (High)
- **Component**: `packages/runtime/src/service.ts:399-408`
- **Impact**: When transport cancellation is requested and the transport responds with `{ status: "accepted" }`, the remote agent has only acknowledged the request, not confirmed that the remote subprocess has halted. Runtime immediately transitions the task state to `"cancelled"`, freeing capacity while the remote agent may still be executing and writing output.
- **Verification Evidence**:
  ```
  FAIL tests/e2e/scenarios/e07-cancellation.e2e.test.ts > Scenario E07 > PROBE PrematureCancel
  AssertionError: expected 'cancelled' not to be 'cancelled'
  ```
- **Remediation Recommendation**: The task must remain in `"cancelling"` until explicit confirmation (`cancellation.stop_confirmed` with terminal boundary observation) is received.

---

### 8. PM-08: Evaluator Evaluation ID Generation & Runtime Orchestrator Coordination (CONTRACT/INTEGRATION DECISION)
- **Classification**: CONTRACT / INTEGRATION DECISION
- **Component**: `@ai-flow/contracts`, `packages/quality-gates/src/evaluator.ts`, `packages/runtime/src/orchestrator.ts:824`
- **Explanation**: `QualityGateContext` defined in `@ai-flow/contracts` does not provide an `evaluationId` field. `CommandQualityGate.evaluate()` generates a default evaluation ID if not provided in the evaluator spec. In actual runtime operation, `WorkflowOrchestrator` explicitly coordinates and overrides the returned result's `evaluationId` to match the orchestrator's requested gate execution/evaluation ID before persisting the record in `RunStore`. This preserves correlation across the workflow lifecycle without requiring an immediate contract modification to `QualityGateContext`.
- **Verification Evidence**: `e05-quality-gates.e2e.test.ts` (Observation PM-08, **PASS**).

---

### 9. PM-11: Premature Cancellation Stop Confirmation Without Transport Verification
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

### 10. PM-12: Missing CLI Runtime Composition (`BLOCKED_BY_P07`)
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

### 11. PM-13: CLI Missing `--version` Flag Support
- **Severity**: P3 (Low)
- **Component**: `apps/cli/src/commands.ts:390-440`
- **Impact**: Standard command-line convention `ai-flow --version` fails with exit code 2.
- **Root Cause**: CLI parser treats `--version` as an unrecognized command instead of handling it at the root dispatcher.
- **Verification Evidence**:
  ```
  FAIL tests/e2e/scenarios/e09-cli.e2e.test.ts > Scenario E09 > PROBE PM-13
  AssertionError: expected 2 to be +0
  - 0
  + 2
  ```
- **Remediation Recommendation**: Add `--version` / `-v` handling in `parseArgs` or command dispatcher to print the package version from `package.json` and exit with code 0.

---

## Architectural & Verification Limitations

1. **OS Process Crash / Power Loss Safety Boundaries**:
   - The E2E test harness verifies durable state recovery across closed/reopened store instances (`SqliteRunStore`, `FilesystemArtifactStore`).
   - Narrowly stated: A SIGKILL-based process restart test harness is technically possible in userland without specialized power-loss hardware rigs, but is NOT implemented in this test suite.
   - Sudden OS kernel panics, unbuffered power loss before SQLite WAL fsync, and network filesystem split-brain semantics remain **`NOT VERIFIED`** without physical or virtualization fault injection.

2. **Artifact Proposal Trust Boundary**:
   - Agent proposals and quality gate outputs are strictly `ArtifactProposal` values.
   - Trusted `ArtifactReference` instances can ONLY originate from `ArtifactStore.put` or `ArtifactStore.ingestProposal`.
   - Any synthetic reference fabricated outside `ArtifactStore` must be treated as untrusted and rejected at ingress boundaries.

3. **P02 Registry Extension Synthetic Stored References (`NOT VERIFIED`)**:
   - `packages/agent-registry/src/feature-example.ts:103` constructs synthetic stored artifact references (`trust: "stored"`) without `ArtifactStore` publication when no store is provided.
   - This E2E suite does NOT consume these synthetic references as genuine production evidence, and verifies that only references ingested through `ArtifactStore` are trusted. Full production validation of the Registry feature example without synthetic references remains **`NOT VERIFIED`** by this suite.

4. **E08 Symlink and Special Device Boundary**:
   - Rejection of symlinks and special character/block devices is strictly verified at storage level in `@ai-flow/artifact-store` (P03).
   - In this P08 E2E suite, E08 focuses on path traversal, checksum verification, proposal trust boundaries, and blob tampering. Rejection of raw symlinks and special devices outside the current E08 harness is delegated to the authoritative P03 package test suite.

5. **E10 Transactional Atomicity Limitations**:
   - In E10, the invalid batch rejection test verifies pre-validation rejection before committing events. This proves input validation safety, but does NOT prove mid-transaction rollback inside SQLite engine execution.
   - Missing receipt collision, artifact failure publication during partial commit, and unknown-after-write crash recovery across process boundaries are partially covered but are not exhaustive proofs of distributed transaction atomicity. Full end-to-end atomic rollback across multi-port transactions remains **`PARTIALLY VERIFIED`**.
