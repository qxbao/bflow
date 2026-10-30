# Stateful Runtime Exploration Results

Date: 2026-10-30  
Evidence level: local deterministic fault injection against real Runtime components; no provider model, live Herdr session, or active Bflow host state.

## Reproduction

Build the workspace packages once:

```bash
pnpm --filter @bflow/runtime... build
```

Run the three bounded campaigns and write the JSON evidence outside the repository:

```bash
BFLOW_RUN_STATEFUL=1 \
BFLOW_EXPLORATION_OUTPUT=/tmp/bflow-stateful-exploration/report.json \
pnpm exec vitest run packages/runtime/test/reliability/stateful-runtime-explorer.test.ts \
  -t 'initial bounded' --reporter=dot --testTimeout=180000 --hookTimeout=180000
```

The campaign entrypoint is opt-in (`BFLOW_RUN_STATEFUL=1`) so ordinary Runtime tests do not spend approximately 80–90 seconds on 300 isolated SQLite/filesystem sequences.

## Scope and mechanism

`packages/runtime/test/reliability/stateful-runtime-explorer.ts` provides:

- A seeded xorshift PRNG and reproducible `ExplorationTrace` values.
- Valid-operation generation bounded to 24 transitions and at most three selected faults per sequence.
- A forward-only deterministic clock and isolated temporary `SQLite RunStore`, filesystem `ArtifactStore`, `FileAgentRegistry`, `DeterministicWorkflowEngine`, and Runtime `TaskDispatcher`.
- Fault-controlled transport responses for accepted, unknown-delivery, bound, and safe-not-delivered reconciliation outcomes.
- Restart/reopen through production `recoverWorkflowRun` with a fresh production engine.
- Real Registry lease renewal/expiry timing and stale correlated-result rejection through Core.
- Watchdog lifecycle gating through `shouldRunWatchdog` and stall classification through `evaluateWatchdog`.
- Per-step state signatures and observations.
- Delta-debugging minimization that replays candidate traces against fresh Runtime components.

No AI model or provider token is called by the explorer. All generated state is temporary and isolated.

## Final campaign run

Final JSON evidence: `/tmp/bflow-stateful-exploration/report-final.json`  
Final campaign wall-clock duration: 81.33 seconds  
Provider/model tokens: **0**  
Sequences: **300** total (**100 per campaign**)  
Transitions: **7,200** total (**2,400 per campaign**)  
Distinct state signatures: **1,944** total  
Distinct adjacent transition combinations: **192** total  
Invariant violations: **0**  
Minimized counterexamples: **0**  
Confirmed production defects: **0**  
Production fixes: **0**  
Regression fixtures: **0** (no confirmed failure existed to preserve)

| Campaign | Seed | Sequences | Transitions | State signatures | Transition combinations | Activated fault types | Violations | Duration |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Delivery / acknowledgment / restart | `54033` (`0xd311`) | 100 | 2,400 | 781 | 30 | 4 | 0 | 21.45s |
| Lease / fencing / handoff authority | `125534` (`0x1ea5e`) | 100 | 2,400 | 687 | 90 | 5 | 0 | 28.10s |
| Lifecycle / watchdog / recovery | `51966` (`0xcafe`) | 100 | 2,400 | 476 | 72 | 4 | 0 | 26.55s |

Activated fault types are counted only when the generated operation reached the corresponding controlled boundary. Selected fault labels are retained in traces; they are not treated as evidence merely because a random sequence named them.

## Invariants exercised

The exploration checks these runtime-invariant families after transitions:

- **S1 / S5 / L2:** durable dispatch intent, uncertain delivery, restart reconciliation, and no resend unless the configured reconciliation outcome is `not_delivered`.
- **S2:** Registry lease expiry/renewal behavior and the use of the real registry clock/fencing state.
- **S3 / S7:** Core rejects a foreign/stale correlated result and does not infer success from transport state.
- **L1:** unexpected runtime errors become recorded violations rather than being silently ignored.
- **L8:** watchdog actions are not attributed to a later delivery event; uncertain delivery is a valid actionable wait, not a stall.
- **L5:** watchdog execution is gated while workspace activation has no SessionManifest.

The existing targeted task-notice suite separately covers borrowed parent lease authority, queued child notices, lease renewal propagation, continuation fences, cancellation, and unknown delivery. Those tests were run alongside this explorer; the explorer does not claim to generate every task-notice-specific history.

## Trace minimization and discarded harness finding

The minimizer is covered by a deterministic unit test and removes unnecessary operations and faults while preserving a supplied replay predicate. Final review also added boundary-accounting regressions: unused fault labels are not counted, delayed acknowledgement reaches the real unknown-to-bound path, pane loss requires replacement plus watchdog observation, and duplicate-result injection performs two Core ingress attempts. During initial execution, the explorer checker produced a false L8 counterexample:

```text
create_task → restart → watchdog → dispatch (ack_lost)
```

Root cause: the checker carried a watchdog action from an earlier operation into a later delivery check. This was a test-harness accounting defect, not a Runtime defect. The checker was corrected to evaluate L8 only on the watchdog transition that created the action, then the same final 300-sequence campaign completed with zero violations and zero minimized counterexamples.

Because the false finding did not replay as a production invariant violation after the checker correction, no regression fixture or production fix was added.

## Verification results

Commands run in the isolated worktree:

```text
pnpm --filter @bflow/runtime typecheck
→ TypeScript: No errors found

pnpm exec vitest run \
  packages/runtime/test/reliability/stateful-runtime-explorer.test.ts \
  packages/runtime/test/scenarios/05-timeout-reconciliation.test.ts \
  packages/runtime/test/scenarios/06-restart-recovery.test.ts \
  packages/runtime/test/agentic/host-watchdog-lifecycle.test.ts \
  packages/runtime/test/agentic/notice-watchdog.test.ts \
  --reporter=dot
→ 5 files passed; 38 tests passed; 1 opt-in campaign test skipped
```

The final opt-in campaign command passed: one test passed, six ordinary explorer tests skipped by the `-t` selector, with the report written to `/tmp/bflow-stateful-exploration/report-final.json`.

## Remaining limitations

- This is bounded local evidence, not universal safety or liveness proof.
- The explorer uses deterministic external-boundary substitutes; it does not establish live Herdr/provider behavior, authentication, trust prompts, model behavior, or sandbox enforcement.
- The explorer does not mutate active Bflow state and does not run a full user-to-provider SDLC.
- File-backed Registry and local SQLite/filesystem tests do not prove power-loss atomicity, network-filesystem behavior, hostile same-UID isolation, or multi-host guarantees.
- Lease campaign handoff coverage exercises real Registry/Dispatcher authority and stale-result rejection; task-notice-specific histories remain covered by existing `packages/runtime/test/agentic/task-notices.test.ts` rather than this generated explorer.
- Conditional liveness checks assume scheduler fairness and treat explicit unknown-delivery and human-wait states as actionable waits, not unconditional completion guarantees.

## Commit hashes

- Exploration baseline before this change: `120d7dc0dac6c83f6ce0ac9e943c69452bf920b4`.
- Initial explorer implementation commit: `936dac346054f0b90002a32ad0c6e7a18cc1c0da`.
- Final review source corrections: `8a99d28645a155f769be7d356da73f41d09ab5e9`.
- Final report pin commit: `dec6546` (this commit).
