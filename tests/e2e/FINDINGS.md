# P08 Findings & Upstream Defect Catalog

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

During the design, implementation, and execution of the P08 End-to-End Integration verification suite, the following cross-module defects, security gaps, and architectural limitations in upstream packages were identified, reproduced with deterministic probes, and subsequently remediated and verified GREEN across the integrated codebase.

---

## Summary of Findings & Remediation Status

| ID | Severity | Affected Package | Location | Description | Verification Probe & Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **PM-01** | P1 (High) | `packages/quality-gates` | `src/evaluator.ts` | Mandatory workflow quality gates (`definition.required: true`) cannot be downgraded or bypassed when `spec.required: false, skip: true`; skipping a required gate fails closed with `MANDATORY_GATE_SKIPPED`. | `e05-quality-gates.e2e.test.ts` (Probe PM-01, **REMEDIATED / PASS**) |
| **PM-02** | P1 (High) | `packages/quality-gates` | `src/evaluator.ts` | `CommandQualityGate.evaluate` enforces `OperationOptions` `deadline`, `timeoutMs`, and `signal` before and during subprocess execution, preventing execution when the deadline has already expired. | `e05-quality-gates.e2e.test.ts` (Probe PM-02, **REMEDIATED / PASS**) |
| **PM-03** | P1 (High) | `packages/quality-gates` | `src/evaluator.ts` | When `minPassedTestsCount` is specified without an `outputParser`, `CommandQualityGate` fails closed with `MISSING_EXECUTION_EVIDENCE` rather than passing with 0 parsed tests. | `e05-quality-gates.e2e.test.ts` (Probe PM-03, **REMEDIATED / PASS**) |
| **PM-04** | P1 (High) | `packages/quality-gates` | `src/rbac-approval.ts` | Governance evaluation strictly verifies `gateResult.runId === input.runId`, rejecting foreign run gate results. | `e05-quality-gates.e2e.test.ts` (Probe PM-04, **REMEDIATED / PASS**) |
| **PM-05** | P1 (High) | `packages/quality-gates` | `src/rbac-approval.ts` | Governance evaluation verifies `decision.revision === approvalRequest.revision` and `decision.generation === approvalRequest.generation`, rejecting stale approval decisions from prior rework cycles. | `e05-quality-gates.e2e.test.ts` (Probe PM-05, **REMEDIATED / PASS**) |
| **P06-DispatchIntent** | P1 (High) | `packages/runtime` | `src/dispatcher.ts` | Runtime persists durable `task.dispatch_requested` with exact request identity and target in `RunStore` before invoking `transport.send`. | `e03-unknown-delivery.e2e.test.ts` & `e02-crash-recovery.e2e.test.ts` (**REMEDIATED / PASS**) |
| **P06-PrematureCancel** | P1 (High) | `packages/runtime` | `src/service.ts` | Runtime keeps bound tasks in `"cancelling"` when `transport.cancel` returns `accepted` without confirmed remote stop, transitioning to `"cancelled"` only after stop is confirmed. | `e07-cancellation.e2e.test.ts` (Probe PrematureCancel, **REMEDIATED / PASS**) |
| **PM-08** | Contract Decision | `packages/quality-gates` / `runtime` | Contracts / `orchestrator.ts` | `QualityGateContext` does not carry `evaluationId`; `WorkflowOrchestrator` coordinates and overrides the returned result's `evaluationId` to match `quality_gate.evaluation_requested` before persistence. | `e05-quality-gates.e2e.test.ts` (Observation PM-08, **PASS**) |
| **PM-11** | P1 (High) | `packages/runtime` | `src/service.ts` | Runtime checks `transport.cancel` outcome and propagates transport failure without falsely confirming cancellation stop. | `e07-cancellation.e2e.test.ts` (Probe PM-11, **REMEDIATED / PASS**) |
| **PM-12** | P1 (High) | `apps/cli` | `src/bin.ts` | CLI entrypoint composes `RuntimeService` from `.bflow/config.json` (falling back to fail-closed unconfigured context when no config exists) and executes `init`, `run`, `status`, and `cancel` end-to-end. | `e09-cli.e2e.test.ts` (**REMEDIATED / PASS**) |
| **PM-13** | P3 (Low) | `apps/cli` | `src/parser.ts` / `src/commands.ts` | CLI handles `--version` / `-V` and exits with code 0 and a valid semver string. | `e09-cli.e2e.test.ts` (Probe PM-13, **REMEDIATED / PASS**) |
| **P02-SyntheticRef** | P2 (Medium) | `packages/agent-registry` | `src/feature-example.ts` | `buildCompleteFeatureWorkflowExample` requires a real `ArtifactStore` (failing closed with `validation` when omitted) and ingests all stage proposals into genuine `trust: "stored"` references. | `e10-failure-injection.e2e.test.ts` (**REMEDIATED / PASS**) |

---

## Detailed Remediation Verification

### 1. PM-01: Quality Gates Required Gate Downgraded on Skip — REMEDIATED
- **Component**: `packages/quality-gates/src/evaluator.ts`
- **Resolution**: `CommandQualityGate` enforces `validContext.definition.required || this.spec.required`. When a mandatory gate is skipped (`skip: true`), the evaluator records a `MANDATORY_GATE_SKIPPED` error finding and returns `status: "failed"`.
- **Verification**: `e05-quality-gates.e2e.test.ts` (`PROBE PM-01`, **PASS**).

### 2. PM-02: CommandQualityGate Ignores OperationOptions Deadline / Timeout — REMEDIATED
- **Component**: `packages/quality-gates/src/evaluator.ts`
- **Resolution**: `CommandQualityGate.evaluate` validates `options.deadline`, `options.timeoutMs`, and `options.signal` before spawning any subprocess, returning `{ ok: false, error: { code: "timeout", ... } }` immediately when the deadline has already elapsed.
- **Verification**: `e05-quality-gates.e2e.test.ts` (`PROBE PM-02`, **PASS**).

### 3. PM-03: Quality Gates Missing Execution Evidence Bypass — REMEDIATED
- **Component**: `packages/quality-gates/src/evaluator.ts`
- **Resolution**: When `minPassedTestsCount` is configured without an `outputParser`, `CommandQualityGate` fails closed with `MISSING_EXECUTION_EVIDENCE` (`status: "failed"`).
- **Verification**: `e05-quality-gates.e2e.test.ts` (`PROBE PM-03`, **PASS**).

### 4. PM-04: Governance Evaluation Accepts Foreign Run Results — REMEDIATED
- **Component**: `packages/quality-gates/src/rbac-approval.ts`
- **Resolution**: `evaluateAutomatedVsHumanGovernance` validates that every `QualityGateResult.runId` matches `input.runId`, rejecting foreign run gate results.
- **Verification**: `e05-quality-gates.e2e.test.ts` (`PROBE PM-04`, **PASS**).

### 5. PM-05: Governance Evaluation Accepts Stale Approval Decisions Across Rework Cycles — REMEDIATED
- **Component**: `packages/quality-gates/src/rbac-approval.ts`
- **Resolution**: `evaluateAutomatedVsHumanGovernance` verifies that `decision.approvalId === approvalRequest.approvalId`, `decision.revision === approvalRequest.revision`, and `decision.generation === approvalRequest.generation`.
- **Verification**: `e05-quality-gates.e2e.test.ts` (`PROBE PM-05`, **PASS**).

### 6. P06-DispatchIntent: Durable `task.dispatch_requested` Before Transport Send — REMEDIATED
- **Component**: `packages/runtime/src/dispatcher.ts`, `packages/runtime/src/recovery.ts`
- **Resolution**: `TaskDispatcher` requests and persists `task.dispatch_requested` in `RunStore` before calling `transport.send`, and `recoverWorkflowRun` reconciles interrupted or `unknown_delivery` dispatches across restarts (`unknown_delivery` remains blocked without blind resend; `bound` binds the remote execution with 0 duplicate sends; `not_delivered` (`retrySafe: true`) unblocks and safely re-dispatches).
- **Verification**: `e03-unknown-delivery.e2e.test.ts` (7/7 **PASS**) and `e02-crash-recovery.e2e.test.ts` (8/8 **PASS**).

### 7. P06-PrematureCancel & PM-11: Two-Phase Cancellation Stop Confirmation — REMEDIATED
- **Component**: `packages/runtime/src/service.ts`
- **Resolution**: `RuntimeService.cancel` checks the `transport.cancel` result, propagates transport errors without confirming stop, records `cancellation.accepted`, and only calls `confirmCancellationStop` after `transport.wait` (or `already_terminal`) confirms the remote execution has stopped.
- **Verification**: `e07-cancellation.e2e.test.ts` (3/3 **PASS**).

### 8. PM-12 & PM-13: CLI Runtime Composition and `--version` Support — REMEDIATED
- **Component**: `apps/cli/src/bin.ts`, `apps/cli/src/parser.ts`, `apps/cli/src/commands.ts`
- **Resolution**: `apps/cli` supports `--version` / `-V` (exiting 0 with semver output) and composes `RuntimeService` in `bin.ts` when `.bflow/config.json` is present while failing closed when unconfigured.
- **Verification**: `e09-cli.e2e.test.ts` (7/7 **PASS**).

### 9. P02-SyntheticRef: Registry Feature Example Requires Real ArtifactStore — REMEDIATED
- **Component**: `packages/agent-registry/src/feature-example.ts`
- **Resolution**: `buildCompleteFeatureWorkflowExample(store)` requires a real `ArtifactStore`, rejects missing stores with `validation`, and ingests all role artifact proposals through `ArtifactStore.put` to produce authentic `trust: "stored"` references.
- **Verification**: `e10-failure-injection.e2e.test.ts` (`verifies P02 buildCompleteFeatureWorkflowExample...`, **PASS**).

---

## Architectural & Verification Limitations

1. **OS Process Crash / Power Loss Safety Boundaries**:
   - Userland `SIGKILL` subprocess crash and recovery across the dispatch boundary (`task.dispatch_requested` before external write), receipt boundary (after external write, before execution binding), and binding boundary (`agent.execution_bound` persisted), as well as recovery of pending human approvals and pending quality gates (`quality_gate.evaluation_requested`) across `harness.restart()`, are **VERIFIED** in `e02-crash-recovery.e2e.test.ts` and `e03-unknown-delivery.e2e.test.ts`.
   - Sudden OS kernel panics, unbuffered physical power loss before SQLite WAL `fsync`, network filesystem split-brain semantics, and multi-host execution remain **`NOT VERIFIED`** without physical or virtualization fault injection.

2. **Live Herdr Daemon Boundary**:
   - The P08 E2E suite runs deterministically offline using `FixtureAgentTransport` (in E01–E08, E10) and an executable mock-herdr CLI script via `BFLOW_HERDR_BIN` (in E09).
   - Live Herdr daemon connectivity, Socket.IO streaming, and external terminal multiplexer session lifecycle against a running Herdr server remain **`NOT VERIFIED`** in this offline suite.

3. **Artifact Proposal Trust Boundary & E08 Symlink/Special Device Coverage**:
   - Agent proposals and quality gate outputs are strictly `ArtifactProposal` values; trusted `ArtifactReference` instances (`trust: "stored"`) originate only from `ArtifactStore`.
   - E08 verifies path traversal rejection, SHA-256 integrity checks, proposal trust boundaries, and on-disk blob tampering detection. Rejection of raw symlinks and special character/block devices is verified at the storage layer in `@bflow/artifact-store` (P03).

4. **Cross-Port Distributed Atomicity**:
   - E10 verifies OCC version/sequence conflict detection, pre-validation batch rejection, checkpoint immutability/corruption detection, receipt collision (`bindAgentExecution` / `recordDeliveryReconciliation`), session replacement / stale execution fencing, and fail-closed artifact publication before `agent.result_recorded` is committed.
   - Because SQLite (`RunStore`), the local filesystem (`ArtifactStore` / `FileAgentRegistry`), and external transport (`AgentTransport`) are not a single distributed atomic transaction, cross-port atomicity relies on persisted intent events (`task.dispatch_requested`, `quality_gate.evaluation_requested`) and deterministic recovery/reconciliation (`PARTIALLY VERIFIED` for arbitrary mid-I/O fault combinations).
