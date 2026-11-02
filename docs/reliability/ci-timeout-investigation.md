# Bflow CI Test Timeout Investigation

**Date:** 2026-10-30 (Asia/Bangkok)  
**Revision investigated:** `58ef1fa` (`doc: runtime live test`)  
**Scope:** retained `pnpm test` output, minimal reproduction, worker/resource behavior, fixture cleanup, and active-host interference.

## Executive conclusion

The latest standard `pnpm test` did not reach a terminal result because the root Vitest workload ran with default file parallelism on a heavily loaded workstation. The primary finding is **Class A test-scheduling/resource contention**, not a reproduced Runtime deadlock.

Evidence:

- The affected Host-RPC, Gateway, CLI, and A-Z tests pass when isolated.
- The two known slow lifecycle matrices pass 20/20 in their serial one-worker lane.
- The four affected files pass together with two Vitest workers.
- Root Vitest has 30-second test/hook/teardown budgets but no explicit worker/resource contract. CI shards files, but each shard uses default parallelism.
- The active Bflow host was not mutated or used as a fixture, but was a material same-host contention source: PID `1781403` consumed about 112–114% CPU and 0.68–0.87 GB RSS during observations. Other Herdr, provider, host, MCP, and Claude processes were also alive.

The minimum correction is a dedicated serial slow-test lane using existing Vitest worker controls. Do not raise the global timeout or change Runtime concurrency behavior. CI/root configuration is integration-owned, so this report records the correction rather than changing `.github/workflows/ci.yml` or `vitest.config.ts`.

## 1. Evidence reviewed

Read:

- `docs/reliability/live-runtime-validation.md`
- `docs/reliability/test-runtime-gap.md`
- `docs/reliability/failure-analysis.md`
- `/tmp/bflow-pnpm-test.log` (1,322 lines, 129,553 bytes)
- `vitest.config.ts`, `.github/workflows/ci.yml`
- affected test files and lifecycle fixture helpers

The repository already documented the historical lifecycle contention finding and recommended serial lane. This investigation independently reproduced that pattern and captured the Host-RPC/Gateway/CLI cluster from the retained output.

## 2. Exact failures in retained output

The retained command was `pnpm test`. It built successfully, entered Vitest, then was interrupted after progress stopped. It is **incomplete**, not a pass.

### Host-RPC timeouts

`packages/runtime/test/agentic/conversation-host-rpc.test.ts`: 4 of 9 tests timed out while the file took 160.202 seconds:

1. `serves a source-backed repository survey through the real authenticated assignment_context tool` — 20s;
2. `fences Runtime nudge tools from historical human turns and accepts the next real turn once` — 20s;
3. `records raw Vietnamese input and delegates/resumes exactly once on the existing run` — 20s;
4. `delivers dynamic turnContext and updates through read_updates and recoverableUserTurns through conversation_decide on codex while keeping UserPromptSubmit fixed` — 30s.

Vitest reported only `Test timed out in ...ms`; the isolated rerun had no assertion/protocol failure.

### Gateway failures and health diagnostics

`apps/cli/test/setup-gateway.test.ts`: 2 failures and 1 skip in 31 tests:

- `configures machine services after installation and verifies actual MCP negotiation and tools through the gateway` — assertion: `expected [ Array(1) ] to deeply equal []`;
- `registers multiple repositories concurrently via bflow init, reloads them on Gateway restart, skips deleted repos, and supports bflow init --remove` — 30s timeout.

The log also recorded:

```text
Gateway protocol health failed: Request 'tools/list' timed out after 5000ms
Gateway protocol health failed: Upstream request timed out
```

These are real health-probe diagnostics, not silently treated as success. The isolated Gateway file also emits the warning on intentional unavailable/hanging-upstream tests, while the file as a whole passes.

### CLI JSON contract timeout

`apps/cli/test/high-level/commands.integration.test.ts`:

- `JSON contract > every command emits a CommandExecutionResult-valid envelope` — 60s timeout;
- 44 other tests passed in the retained broad run.

This integration test invokes nine real command paths, not only a schema parser, so it has materially higher process/filesystem cost than its name suggests.

### A-Z assertion failure

`packages/runtime/test/agentic/az-acceptance.test.ts`:

`A-Z acceptance: the automatic budget is bounded > stops after 3 automatic resumes of a recurring no-next-action stop; an explicit user resume still runs`

failed with:

```text
expected { resumed: 1 } to deeply equal { resumed: +0 }
```

This is an assertion failure, not a timeout. It passes alone and in the controlled four-file group; it is not a confirmed Runtime state-machine regression.

### Other diagnostics

The log contains bounded provider/Gateway readiness retries, including `no compatible observed Herdr native session`, `still unavailable`, and `not yet`. These are fixture/prerequisite observations, not proof that the user's live Herdr session was used by tests.

## 3. Minimal reproductions

All runs were bounded. The active repository host/session was observed read-only; no `down`, `up`, restart, pane close, Herdr stop, worktree deletion, or test traffic was directed at it.

| Run | Result | Wall time | Peak RSS |
|---|---|---:|---:|
| `conversation-host-rpc.test.ts --maxWorkers=1 --minWorkers=1` | 9/9 pass | 56.15s | 366 MB |
| `setup-gateway.test.ts --maxWorkers=1 --minWorkers=1` | 30 pass, 1 skip | 99.33s | 511 MB |
| `commands.integration.test.ts --maxWorkers=1 --minWorkers=1` | 45/45 pass | 43.26s | 682 MB |
| selected A-Z automatic-budget test, one worker | 1/1 pass | 5.19s | 273 MB |
| four affected files, `--maxWorkers=2 --minWorkers=1` | 102 pass, 1 skip | 170.83s | 680 MB |
| lifecycle fault + extended restart matrices, one worker | 20/20 pass | 118.75s | 360 MB |

Four-file command:

```sh
pnpm exec vitest run \
  packages/runtime/test/agentic/conversation-host-rpc.test.ts \
  apps/cli/test/setup-gateway.test.ts \
  apps/cli/test/high-level/commands.integration.test.ts \
  packages/runtime/test/agentic/az-acceptance.test.ts \
  --maxWorkers=2 --minWorkers=1
```

Lifecycle command:

```sh
pnpm exec vitest run \
  packages/runtime/test/agentic/lifecycle-fault-matrix-extended-restart.test.ts \
  packages/runtime/test/agentic/lifecycle-fault-matrix-faults.test.ts \
  --maxWorkers=1 --minWorkers=1 --reporter=basic
```

These runs rule out deterministic failure in the selected cases, but do not prove arbitrary parallel execution is safe.

## 4. Controlled root-suite attempts

1. `BFLOW_HOME=/tmp/bflow-ci-investigation-home pnpm test -- --maxWorkers=2 --minWorkers=1` reached the explicit 900-second investigation bound (`exit 124`) without a terminal Vitest result. Load reached about 33 and 41–46 related test processes were observed.
2. `BFLOW_HOME=/tmp/bflow-ci-investigation-home-serial pnpm test -- --maxWorkers=1 --minWorkers=1` reached a terminal result after 14m12.85s (`exit 1`): 410 files passed, 15 failed, 6 skipped; 6,563 tests passed, 29 failed, 83 skipped. It still ran on the loaded workstation and included 30-second timeouts, Gateway assertions, and `ENOTEMPTY` cleanup failures.

These are not full-suite passes. The exact standard `pnpm test` was not rerun again because the retained run plus bounded attempts already established the scheduling behavior and another broad run would further contend with the live host.

## 5. Fixture, worker, process, and cleanup evidence

`vitest.config.ts` sets `testTimeout`, `hookTimeout`, and `teardownTimeout` to 30 seconds but does not set `maxWorkers`, `minWorkers`, or disable file parallelism. CI's four unit shards still use default worker parallelism.

The Host-RPC fixture creates a temporary Git repository, fixture Herdr executable, real agentic host/MCP subprocesses, authenticated RPC calls, and asynchronous shutdown. The Gateway fixture creates real local Gateway/service processes, HTTP/stdio boundaries, Git repositories, and restart/registration state. The CLI JSON test executes nine command paths and may spawn subprocesses.

When a test reaches its Vitest timeout, asynchronous host/gate work can still be active while `afterEach` removes the root. The bounded serial root run produced `ENOTEMPTY` for P19 and lifecycle directories; the focused lifecycle lane passed cleanly. This classifies `ENOTEMPTY` as secondary fixture cleanup fallout, not a first-cause Runtime deadlock.

At observation time:

- 12 logical CPUs were available;
- RAM was 15.7 GB, with availability varying roughly 2.5–5.1 GB; swap was already in use;
- root disk availability was roughly 1.8–2.3 GB (about 99% used);
- active host PID `1781403` used about 112–114% CPU and 0.68–0.87 GB RSS;
- multiple Herdr servers, providers, isolated host daemons, MCP children, and Claude processes were already running;
- the active host held SQLite WAL/SHM and journal-lock descriptors, but tests used temporary roots and did not point at those files.

One old fixture host remained in `/tmp/bflow-chat-rpc-u1la16` (PID `3336763`, started 2026-10-29). It was not killed because ownership was not established. The live host and its Herdr role processes were intentionally left untouched.

## 6. Root-cause classification

| Condition | Classification | Evidence |
|---|---|---|
| Conversation host-RPC timeouts | Test timeout from scheduling/resource contention | 4 failures broad; 9/9 alone; four-file group passes |
| Gateway `tools/list` timeout | Fixture/upstream health timeout | Explicit 5s diagnostic; isolated file passes and intentionally tests this path |
| Gateway repository registration timeout | Test timeout under broad IO/process pressure | Isolated file passes |
| Gateway actual-negotiation assertion | Load-sensitive broad-run assertion | Isolated file passes; expectation was not weakened |
| CLI JSON contract timeout | Test timeout | Isolated file passes; real nine-command sequence |
| A-Z `{resumed: 1}` assertion | Broad-run failure not reproduced | Selected test and four-file group pass |
| `ENOTEMPTY` | Fixture cleanup failure secondary to timed-out async work | Appears with timed-out P19/lifecycle work; serial matrices pass |
| Codex approval-state errors in one attempt | Investigation setup error | `TMPDIR` was set to a newly created private-state-incompatible path; not counted as product failure |
| No original terminal result | Operator interruption | Retained report says broad run was interrupted |

Not established: Runtime deadlock, Core transition defect, Gateway implementation defect, live Herdr transport failure, or a precise CPU/disk threshold. Active-host interference was involved as same-machine resource contention, but no causal interaction with its durable state was demonstrated.

## 7. Minimal correction

Apply in integration-owned CI configuration:

1. Keep ordinary package tests on the normal worker configuration.
2. Add a dedicated serial slow lane for the two lifecycle matrices using the command above.
3. Give that lane a job-level budget of at least three minutes on a clean CI runner; observed serialized wall time was 118.75 seconds.
4. Keep the 30-second per-test budget. Do **not** increase it globally.
5. If the Host-RPC/Gateway/CLI cluster remains in a broad lane, give it a bounded worker count or schedule it apart from the lifecycle lane. Preserve all assertions and health diagnostics.
6. On failure, record runner CPU, memory, disk, process count, and fixture cleanup status.

This is scheduling/resource ownership, not a product retry, assertion relaxation, or Runtime concurrency redesign. It reuses existing Vitest controls and CI sharding.

## 8. Validation and remaining uncertainty

| Validation | Result |
|---|---|
| Retained exact `pnpm test` | **Incomplete/interrupted** |
| Focused Host-RPC, Gateway, CLI, A-Z tests | **Pass in isolation** |
| Four affected files, two workers | **Pass: 102 executed, 1 skipped** |
| Lifecycle matrices, one worker | **Pass: 20/20** |
| Controlled root, two workers | **Incomplete at explicit 900s bound** |
| Controlled root, one worker | **Terminal fail: 410 pass / 15 fail; not a full pass** |
| Standard `pnpm test` after investigation | **Not rerun to completion** |

Run the clean CI lane on a runner without an active Bflow host and with sufficient disk before deciding whether any broad-run assertion has an independent cause. Investigate the A-Z assertion only if it reproduces in isolation or on that clean runner. Keep active-host lease/watchdog/journal anomalies in deployment reports; they require operator-authorized reconciliation.

## 9. Change status

- Production code changes: **none**.
- CI/Vitest configuration changes: **none**.
- Deliverable: this document.
- Commit hash for code changes: **N/A**. Observations were made against `58ef1fa`.
