# Bflow Test-to-Runtime Gap Analysis

Audit revision: `a46ab10`

## Gap mapping

| Confirmed or source-supported condition | Existing test | Missing real-world condition | Class | Recommended correction |
| --- | --- | --- | --- | --- |
| Concurrent heavy Runtime suites exceed the 30-second budget and leave cleanup noise | Lifecycle fault/restart matrix files | Test scheduling and host contention are not represented in the suite contract | A: missing test-execution control | Run the slow lifecycle matrix in a serial one-worker lane. Keep the normal budget for ordinary tests; do not raise all timeouts globally. |
| Herdr prompt acknowledgement is lost or times out after a possible side effect | Herdr F01/F06/F07; E02/E03 fixture transport | Real Herdr CLI/daemon, process restart, pane/session continuity, and prompt-specific receipt semantics | B: simulation fidelity | Reuse `packages/runtime/test/agentic/live-herdr.test.ts` with one native actor and classify Herdr/provider behavior separately from Runtime. |
| Real provider permission prompt or workspace trust is not propagated | E12 mock/provider tests; optional live E12 and `provider-live.test.ts` | Authenticated provider process, first-use trust, permission UI, private profile/home, and Herdr environment | B | Run one disposable provider startup/readiness probe per provider when credentials already exist. |
| A real run remains uncertain after adapter restart because prompt receipt state is process-local | Runtime restart and E02/E03 prove deterministic recovery | Durable correlation between external Herdr submission and Runtime after adapter/host restart | C candidate; unconfirmed | First collect a real receipt bundle. If the boundary cannot reconcile, improve the existing receipt/reconciliation path rather than adding another detector. |
| A live pane is idle while provider waits for login/trust or hidden prompt | Pane readiness and opt-in live provider tests | Provider semantic readiness and actual response | B | Require existing readiness/attestation and one minimal fixed response. Do not treat idle/done as success. |
| A valid human approval wait is reported as a stall | Watchdog tests and lifecycle matrix | Real Conversation display/acknowledgement delivery and user timing | No confirmed gap; evidence gap | Use existing watchdog facts and Conversation receipts in a retained run bundle. Do not change thresholds without incident evidence. |
| Restart at every SDLC stage loses work | Extended restart matrix, E02, integration recovery | Real process/host restart while Herdr/provider processes continue or disappear | B | Use existing live boundary tooling with a synthetic actor first. Full provider restart acceptance remains open. |
| Tool/Gateway operation executes while response is lost | Gateway ledger/resource tests, E14/E15 | Real installed tool/provider MCP call with process crash or response uncertainty | B/C candidate | Select one exclusive operation, use existing ledger reconciliation, and record intent/unknown/reconcile outcomes. |

## Why current tests did not prevent the local failure

The local contention finding is outside the behavior asserted by the lifecycle tests. Those tests verify Runtime progression, recovery, and cleanup under their fixture assumptions. Root Vitest configuration gives them a 30-second per-test budget, but no separate resource budget or execution lane for real Git/SQLite/artifact lifecycle matrices. `test:fast` excludes slow matrices for developer feedback, while CI invokes the full root suite with default worker behavior. A test can therefore be behaviorally correct in isolation and unreliable as a concurrent CI workload.

The discriminating experiment was:

```text
Concurrent focused run:
  lifecycle fault/restart slices ran alongside other heavy Runtime/E2E slices
  result: 6 timeout failures, 3 ENOTEMPTY cleanup errors

Serial:
  pnpm exec vitest run packages/runtime/test/agentic/lifecycle-fault-matrix-extended-restart.test.ts --maxWorkers=1 --minWorkers=1
  result: 7 passed

  pnpm exec vitest run packages/runtime/test/agentic/lifecycle-fault-matrix-faults.test.ts --maxWorkers=1 --minWorkers=1
  result: 13 passed
```

This is a Class A test-execution gap. It does not justify changing Runtime transitions or adding broad retries.

## Coverage by evidence level

### Simulated E2E

The Runtime E2E fixture composes real Core, SQLite RunStore, filesystem ArtifactStore, file-backed Agent Registry, and RuntimeService, but uses `FixtureAgentTransport`. It controls accepted, unknown-before-write, unknown-after-write, unknown delivery, and error outcomes and counts external writes. It does not model Herdr CLI/daemon, pane lifecycle, provider session, or permission UI ([`tests/e2e/helpers/harness.ts`](../../tests/e2e/helpers/harness.ts), [`tests/e2e/helpers/fixture-transport.ts`](../../tests/e2e/helpers/fixture-transport.ts)).

### Real local integration

Tests use real SQLite, artifact blobs, Git repositories/worktrees, subprocess quality gates, HTTP/SSE MCP fixtures, Linux `/proc` measurements, and selected Bubblewrap/Seatbelt boundaries. This establishes local implementation and persistence behavior, not external provider or Herdr behavior.

### Real Herdr/provider

Opt-in tests exist. `BFLOW_LIVE_HERDR=1` runs a native receipt smoke using a custom non-model actor. `BFLOW_TEST_LIVE_HERDR=1` enables Herdr-specific E11/E12/E16 checks. `BFLOW_TEST_LIVE_PLATFORM=1` enables live provider/tool checks, and `BFLOW_LIVE_CLAUDE=1` enables the isolated Claude launch test. None are set in default CI. The native smoke records that an authenticated message is not binding or task-success proof.

### Full workflow acceptance

No default CI job completes a full Conversation-to-delivery workflow with a real provider and real Herdr. Project status keeps this acceptance scope open. Local E16 is harness coverage with controlled role agents and transport.

## Minimal live validation design

1. **Hypothesis:** a prompt can be externally accepted or written while Bflow-side acknowledgement is unavailable, and reconciliation may remain `unknown_delivery` after process reopen.
2. **Why tests are insufficient:** deterministic ledger/fake Herdr runners do not observe a real daemon and pane/session lifecycle at this boundary.
3. **Scope:** reuse `packages/runtime/test/agentic/live-herdr.test.ts`, its native actor, isolated session, and signed receipt ingress. No model, provider authentication, feature generation, or full SDLC.
4. **Timeout:** one 60-second test budget, one attempt, no automatic retry.
5. **Expected observation:** record `send` status, fresh-adapter `reconcile` result, pane/session identity, duplicate-send count, and Runtime state.
6. **Stop:** stop after one conclusive receipt/reconcile outcome or one classified environment failure.

Run only when Herdr is already installed and the operator has authorized the isolated test environment. Preserve no-blind-resend and no-automatic-permission-approval rules.
