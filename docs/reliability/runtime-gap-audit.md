# Bflow Runtime Reliability Gap Audit

Audit revision: `a46ab10` (`main`, also `origin/main` at audit time)

Evidence levels used here:

- **Source**: implementation and exported contracts are present.
- **Local test**: behavior was exercised with repository fixtures, real local storage, subprocesses, Git, or deterministic transport.
- **Live boundary**: an installed Herdr/provider/tool/daemon was exercised in an isolated environment.
- **Full SDLC acceptance**: a real request completed through Conversation, real providers, Herdr, verification, approval, and delivery.

The last level is not inferred from the first three.

## Current execution path

The established Runtime path composes the deterministic Core engine, SQLite RunStore, filesystem ArtifactStore, file-backed Agent Registry, Quality Gates, and an `AgentTransport` through `RuntimeService` and `WorkflowOrchestrator`. A task dispatch is durably represented before transport side effects; execution bindings, delivery reconciliation, agent results, quality-gate requests, approvals, and checkpoints are separate durable events. `recoverWorkflowRun` restores an aggregate checkpoint plus event tail, or replays complete event history, then reconciles in-flight executions and unbound dispatch intents ([`packages/runtime/src/recovery.ts`](../../packages/runtime/src/recovery.ts)).

The agentic host path starts at CLI lifecycle commands, prepares platform and role launch material, validates provider readiness and pane bindings, starts the persistent host, and routes Conversation, Coordinator, specialist, Developer, Reviewer, QA, and verification traffic through Runtime/Herdr envelopes. The watchdog derives run facts from the journal and pane observations, excluding human gates, active handoffs, Runtime-owned work, and pending decisions before reporting a stall ([`packages/runtime/src/agentic/run-watchdog.ts`](../../packages/runtime/src/agentic/run-watchdog.ts)).

At the Herdr boundary, `HerdrCliTransport` validates request schemas, inspects the target pane, checks occupant/session continuity, applies one operation budget, invokes the CLI, and converts uncertain post-side-effect outcomes into sticky `unknown_delivery`. Initialization probes the wire schema and protocol rather than trusting a release label ([`packages/herdr-adapter/src/adapter.ts`](../../packages/herdr-adapter/src/adapter.ts)). Pane-manager socket calls resolve the repository session socket, require a matching session, bound response size, correlate response IDs, and fail closed on malformed or uncertain responses ([`packages/pane-manager/src/herdr-socket.ts`](../../packages/pane-manager/src/herdr-socket.ts)).

The practical path is:

```text
Conversation / CLI
  -> Runtime host and durable journal
  -> Coordinator and accepted role assignment
  -> platform/provider/pane preflight
  -> Herdr transport or local verification boundary
  -> persisted receipt or unknown-delivery intent
  -> correlated RoleMessage / AgentResult / verification evidence
  -> Core transition and checkpoint
  -> approval, Git integration, and Conversation status
```

Herdr `idle` or `done`, a startup acknowledgement, a model ping, or an installed binary does not prove a task result.

## What default CI verifies

The checked-in CI workflow has four effective layers:

| CI part | Configuration | Evidence provided | Evidence not provided |
| --- | --- | --- | --- |
| Lint/build | `.github/workflows/ci.yml` lines 21–55 | Frozen install, dependency graph, TypeScript checks, workspace build | Provider login, Herdr daemon, real agent task |
| Unit/integration shards | lines 57–114 | Package tests; real local SQLite/filesystem/registry in many Runtime tests; Bubblewrap preflight | Real Herdr transport or provider behavior |
| E2E shards | lines 116–149 | Explicit E2E scenarios with real local stores, Git, subprocess gates, deterministic transport | Real provider/Herdr execution because live flags are not set |
| Release workflow | `.github/workflows/cd.yml` | Repeats build/test gates, packaging, compiled CLI smoke test | Full SDLC acceptance and real provider workflow |

The root Vitest configuration includes `packages/**/*.test.ts` and `apps/**/*.test.ts`; `tests/e2e/**/*.test.ts` is outside root discovery and is invoked separately by `pnpm test:e2e` ([`vitest.config.ts`](../../vitest.config.ts), [`tests/e2e/vitest.config.ts`](../../tests/e2e/vitest.config.ts)). A green `pnpm test` alone is not the full repository E2E result.

The CI Bubblewrap command proves that the runner can create one empty Linux namespace with the selected Node binary. Runtime sandbox tests exercise more of the local sandbox implementation. This is local host evidence, not proof of provider authentication, permission prompts, or Herdr child-process behavior.

## Coverage matrix

| Boundary | Existing test evidence | Default CI | Real dependency | Failure/recovery coverage | Assessment |
| --- | --- | --- | --- | --- | --- |
| Core transitions and DAG | Core tests, Runtime scenarios 01–08, E01/E04/E06 | Yes | Core/local stores | Retry, rework, blocked, cancellation, concurrency | Strong local coverage |
| SQLite events/checkpoints | Persistence tests, scenarios 06–07, E02/E10 | Yes | Real `node:sqlite` | Corruption, conflict, checkpoint/tail replay | Strong local coverage; no power-loss proof |
| Artifact integrity | Artifact tests, E01/E05/E08/E10 | Yes | Real local filesystem | Hash mismatch, tampering, path/special-file controls | Strong local coverage; no hostile/network filesystem proof |
| Registry leases/fencing | Registry tests, E04/E08 | Yes | Real local filesystem | Capacity conflict, stale execution, lease cleanup | Strong local coverage; no multi-host guarantee |
| Runtime dispatch intent | E02/E03, scenario 05, dispatcher stress tests | Yes | Deterministic transport in most tests | Unknown-before/after-write and reconcile outcomes | Strong simulated boundary |
| Herdr CLI protocol | Herdr adapter reliability tests | Yes | Fake command runner | Timeout, malformed output, session mismatch, sticky uncertainty | Strong simulation; live transport opt-in |
| Herdr Unix socket | Pane-manager socket tests | Yes | Fake runner/socket fixture | Session mismatch, malformed response, timeout | Protocol coverage; daemon lifecycle opt-in |
| Pane/provider lifecycle | Pane-manager tests, E11/E12/E16 harness tests | Harness paths | Fake providers by default | Startup and stale allocation cases | Simulation fidelity gap |
| Real providers | Provider tests and E12 harness; optional live E12/provider-live tests | No live credentials | Optional live provider | Auth/readiness/launch only when opted in | No default CI evidence |
| Conversation/role routing | Runtime agentic tests and E13 harness | Yes | Simulated role messages | Invalid ingress, bounded resume, decision waits | Strong local coverage; no real model behavior |
| Verification sandbox | Sandbox tests, CI preflight, app-check fixtures | Linux preflight | Real local OS boundary in selected tests | Missing sandbox, runner timeout, app/Chrome lease errors | Local host evidence only |
| Gateway/MCP/tool leases | MCP tests, E14/E15 harness/live-tool opt-in | Local/harness paths | Local HTTP/SSE fixture; optional tools | Lease expiry, unknown call, crash recovery | Strong local coverage; no full provider workflow |
| Git worktrees/integration | Git tests, E15/E16 harness | Applicable tests | Real local Git | Conflicts, clean checks, lifecycle restart | Strong local coverage; no real coding-agent mutation |
| Full user-to-delivery SDLC | E16 harness; no complete real provider run | No | Not real end-to-end | Open acceptance scope | Not established |

## Implemented reliability mechanisms

| Mechanism | Status | Evidence |
| --- | --- | --- |
| Deadlines and timeout classification | Implemented/tested | Herdr F05/F06 and quality-gate deadline tests |
| Sticky uncertain delivery | Implemented/tested | Adapter F01/F07 and E03; no blind resend |
| Durable dispatch intent | Implemented/tested | E02/E03 assert intent before external write |
| Checkpoint/event-tail restart | Implemented/tested | Scenario 06, E02, `recoverWorkflowRun` |
| Bound/unbound delivery reconciliation | Implemented/tested | Scenario 05, E02/E03 |
| Session/occupant continuity | Implemented/tested | Herdr F04 and pane-manager/provider tests |
| Two-phase cancellation | Implemented/tested | E07 and fixture `confirmStop` |
| Bounded retry/rework/resume | Implemented/tested | Scenarios 02–05 and lifecycle matrix |
| Stall/watchdog detection | Implemented/tested | `run-watchdog.ts` and watchdog tests |
| Human decision routing | Implemented/tested | Decision/Conversation tests and E13 |
| Provider/sandbox readiness | Implemented/tested; live opt-in | E11/E12/E16 guards, provider tests, Bubblewrap preflight |
| Runtime telemetry | Implemented/read-only | `bflow status <run-id> --telemetry`; no local production series |

## Main gaps

1. **Default CI does not exercise real Herdr or providers.** Live checks are guarded by `BFLOW_TEST_LIVE_PLATFORM`, `BFLOW_TEST_LIVE_HERDR`, `BFLOW_LIVE_HERDR`, or `BFLOW_LIVE_CLAUDE`. This leaves provider startup, prompt delivery, session continuity, permission UX, and model-result correlation outside default CI.

2. **The real Herdr adapter cannot prove prompt-specific delivery from a generic pane observation.** If no matching local receipt exists and Herdr exposes no prompt-specific receipt, `reconcile()` returns `unknown_delivery`. This is correctly fail-closed, but may leave a real run blocked until an authenticated or operator-backed path resolves it. No production run record was available to show frequency.

3. **The largest local fault matrix is sensitive to concurrent test load.** The default 30-second root test timeout applies to lifecycle tests that take roughly 10–16 seconds when serialized. Running four heavy slices concurrently caused six timeout failures and cleanup `ENOTEMPTY` fallout; running the same cases one file at a time with one worker passed all 20 tests. This is a validation reliability gap, not evidence of a Runtime production stall.

4. **Historical/live execution evidence is not present.** No run ledger, SQLite runtime database, retained Herdr transcript, provider receipt bundle, or CI job log was available locally. The public GitHub Actions HTML page was reachable, but its job log contents were not exposed. Full-run root-cause claims remain unconfirmed.

5. **Full platform-v3 and full SDLC live acceptance remain open by project documentation.** [`docs/implementation-status.md`](../implementation-status.md) separates source/local tests, live probes, and full SDLC acceptance and records that dedicated P31 trees and complete live multi-provider SDLC evidence are not present.

## Audit conclusion

Local Runtime reliability mechanisms are broad and mostly exercised with real local state. The dominant evidence gap is the external boundary: real provider process behavior and Herdr lifecycle/receipt behavior are not part of default CI, and deterministic transports cannot establish that they behave identically. The audit found one reproducible test-infrastructure reliability issue and no evidence-supported production code defect to fix without historical run data.
