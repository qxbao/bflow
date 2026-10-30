# Bflow Real Runtime Incident Investigation

Investigation revision: `a46ab10` plus the durable runtime evidence recorded on 2026-10-30.

This report uses one actual Bflow run from the repository's configured runtime state. It does not use a test fixture as incident evidence.

## Selected incident

- **Run:** `run-web-322edf6c-f342-4187-968b-82b1aead5723`
- **Repository:** `/mnt/01DCE9A4D6522BD0/Project/AI/AI-flow-SDLC`
- **Repository ID:** `c1695ccd3f2b994f91bd366979199fda4bb91e747d49abcde9829a5650ac2902`
- **Runtime state:** `/home/baodq/.local/state/bflow/repositories/f2ef45faade8b3b62a95bf88161e480238fa965a80c6f928e2920c57fac845f1/state`
- **Task:** `task-deepwiki`
- **Developer pane/session:** `w7:p2`, native Claude session `200a7d38-34f6-4442-92e1-fef6cb46f803`
- **Final Core state:** `cancelled`
- **Evidence sources:** SQLite `state/agentic/runs.db`, `state/agentic/task-activity.jsonl`, host log, host authentication/launch receipts, Herdr observation, and the provider transcript JSONL.

The selected run is suitable because it has a complete Core event sequence, an accepted Developer execution binding, a durable verification request, a concrete `spawn E2BIG` failure, a watchdog notice, and a later confirmed cancellation stop.

## Failure boundary and timeline

| Time (UTC) | Evidence | Interpretation |
| --- | --- | --- |
| `00:22:52.776` | `run.created`, `command.completed` | Run was durably created. |
| `00:26:59.673` | `task-deepwiki pending -> ready -> running`; run `queued -> running` | Core scheduled the task normally. |
| `00:27:53.462` | Task activity: Developer assignment accepted by transport | Herdr accepted the assignment; this was not proof of task completion. |
| `00:27:56.735` | Core `agent.execution_bound` | Runtime durably bound the Developer execution. |
| `00:29:58.846` | Developer requested verification | The Developer had progressed far enough to request the Red phase. |
| `00:30:13.349` | Runtime queued `verification.requested` to QA | Runtime created the verification handoff. |
| `00:30:33.919` | Verification handoff accepted | QA delivery was accepted at the transport boundary. |
| `00:30:38.308` | QA began `record_behavioral_verification` | QA was operating on the Red phase. |
| `00:31:06.131` | Watchdog/Conversation notice: Developer ended its turn without a structured result | First visible no-response symptom for the Developer assignment; the assignment remained accepted. |
| `00:32:41.871` | `verification.result` received | The Red result was eventually received and recorded. |
| `00:32:49.838` | Runtime accepted TDD Red evidence | Red evidence was valid enough to authorize continuation. |
| `00:33:18.091` | Developer assignment accepted again | Runtime continued the task after Red. |
| `00:48:54.238` | Conversation notice: `verification.requested to qa ... transport_unavailable: spawn E2BIG` | **First confirmed root-cause failure:** the QA verification process could not be spawned because the launch envelope exceeded the OS argument/environment limit. |
| `00:48:54` onward | Provider transcript says the `check_work` result was too large to read; Green was requested and remained pending | The Developer could not produce a final structured result because the verification boundary failed. |
| `03:50:57.201` | Watchdog activity baseline | Runtime observed the run idle with no applied result. |
| `03:54:32.497` | Watchdog notice: accepted Developer pane `w7:p2` owed a correlated result after a reminder | Correct secondary diagnosis: no correlated business result existed. |
| `03:54:53.387` | Cancellation requested; task/run entered `cancelling` | Operator chose cancellation after the workflow remained blocked. |
| `03:55:26.886`–`03:55:29.407` | Assignment released, stop confirmed, task/run became `cancelled` | Cancellation recovery worked; this was not the root failure. |

The Core event stream contains no task-result or verification-success event between the accepted Developer binding at sequence 7 and cancellation at sequence 10. The durable gap is therefore real: the task remained in-flight for about 3 hours 26 minutes until cancellation.

## Root cause

**Confirmed root cause: a conditional-evidence verification request was too large for the Linux process launch boundary.** The existing transport used the full serialized verification envelope as part of the provider/Herdr launch/request context. Linux rejected the process creation with `spawn E2BIG` before QA could execute the independent verification. No model result or verification result could be produced after that point.

Supporting evidence:

- Conversation state records the exact error: `verification.requested to qa ... transport_unavailable: spawn E2BIG`.
- The Developer transcript contains a Red result and then explicitly reports that the `check_work` output was too large to read before requesting Green.
- Host activity shows Red was accepted and the implementation commit existed, so the failure occurred at the next independent verification boundary.
- Herdr remained healthy, but the original Developer target `w7:p2` was later absent; Herdr’s retained pane output showed only an idle shell in the task worktree. This proves the later no-response observation, not that Herdr caused the original failure.
- Runtime’s Core event stream has no verification-success or Developer-result event after the failed QA delivery.
- The later remediation commits are directly targeted at this boundary: `1d29112` (“reference durable intents for large native deliveries”) and `3c64964` (“bound policy phase prompts and reconcile prelaunch E2BIG”).

The first Developer “ended its turn without a structured result” notice is a secondary symptom during the same long-running task. The later `developer_no_response` notice is also secondary: Runtime had already recorded the real QA delivery failure, and the Developer could not finish the task while Green verification was unavailable.

## Why the workflow stalled

The expected next action after Red was independent Green verification. Runtime attempted that action and recorded a transport failure. Because `spawn E2BIG` was represented as a generic transport-unavailable/unknown-delivery path, the workflow retained the accepted Developer execution and waited for a correlated result. The watchdog eventually detected that the accepted pane was no longer working and had no result, but it could only report the missing result and request operator reconciliation; it could not manufacture verification evidence or safely resend a request whose delivery state was not yet classified.

The cancellation path then behaved correctly:

- Runtime preserved the task in `cancelling` until stop confirmation.
- Herdr/host stop evidence was obtained.
- The task and run were moved to `cancelled`.
- The worktree was retained for inspection.

The workflow was therefore recoverable in the sense that cancellation was safe, but it was not automatically recoverable to a completed workflow on the incident revision.

## Existing test coverage and why it missed this run

| Incident behavior | Existing coverage before the incident | Gap |
| --- | --- | --- |
| Conditional evidence and TDD phase sequencing | `packages/runtime/test/agentic/manual-review-policy.test.ts`, policy-review tests | Tests exercised the policy lifecycle, but the old transport path could still serialize a large request into the launch boundary. |
| Herdr delivery uncertainty and no blind resend | Herdr reliability tests F01/F06/F07; Runtime unknown-delivery tests | These tests model timeout/uncertainty and deterministic reconciliation; they did not reproduce Linux `execve` failure caused by a large verification envelope. |
| Watchdog detects accepted-but-silent holder | `stuck-states.test.ts`, lifecycle fault matrix, watchdog tests | Covered the secondary symptom. It cannot identify an upstream pre-exec `E2BIG` unless that error is preserved and classified at the delivery boundary. |
| Restart and recovery | Runtime scenarios 05–09 and E02/E03 | Recovery coverage existed, but the incident needed a specific pre-launch classification and bounded prompt projection before normal retry/rebind could be safe. |
| Provider/Herdr process behavior | Opt-in live tests | Default CI did not run a real provider with the large conditional-evidence request. |

The simulation fidelity gap was the important one. The deterministic transport accepted the logical request, while the real Linux child-process launch rejected the serialized request before the provider could observe it. The failure depended on payload size, OS process limits, and the actual provider/Herdr launch path.

## Corrective change already present in later source

No speculative change was added during this investigation because the repository already contains a narrowly scoped correction in later branch history:

1. **Bound the transport presentation.** `projectPolicyPhaseEnvelope` compacts the conditional-evidence policy dossier to a bounded representation before the request is sent, while retaining the original envelope and evidence in the journal/artifact path.
2. **Preserve request identity and context.** `projectPolicyPhaseRequest` verifies the request/context digest and only projects the presentation for the conditional-evidence request class.
3. **Classify exact pre-launch failure.** `provenPrelaunchPolicyFailure` requires Linux, exact `spawn E2BIG`, no handle, the exact request/message identity, an oversized original instruction, and no received correlated reply.
4. **Reconcile from the locked journal.** `HerdrOutbox.reconcile` releases the original lease with its exact write-ahead arguments, records the original request in `prelaunchFailure`, removes the impossible stale request/lease, and queues a fresh dispatch requiring a new monotonic Registry fence. It never invents an execution handle and never treats the failed spawn as a remote delivery.
5. **Recover after restart.** Runtime scans the locked journal for proven pre-launch failures and retries reconciliation through the same bounded path, holding on Registry recovery errors rather than discarding evidence.

The associated regression coverage is in `packages/runtime/test/agentic/policy-prompt.test.ts` and `packages/runtime/test/agentic/manual-review-policy.test.ts`. The tests cover bounded projection, exact pre-launch classification, no-handle/no-reply requirements, write-ahead lease release, fresh fencing, journal persistence, and a simulated Herdr `spawn E2BIG` boundary.

The source commits are:

- `1d29112` — reference durable intents for large native deliveries.
- `3c64964` — bound policy prompts and reconcile pre-launch `E2BIG`.
- Later recovery refinements include `0594f92` and subsequent Runtime commits that recover pre-launch phases from the locked journal.

These commits are not part of the audit branch’s `a46ab10` base. The incident is therefore evidence that the deployed/active revision did not contain the mitigation, even though the repository later developed it.

## Minimal reproduction

The smallest reproduction does not require a paid model or a full SDLC:

1. Build an `AgentRequest` for a `verification.requested` conditional-evidence message whose serialized instruction exceeds 131,072 bytes.
2. Use the existing Herdr adapter fake runner that returns `{ failure: "spawn", started: false, cause: "spawn E2BIG" }` for the prompt command.
3. Assert that the original request produces `unknown_delivery` with no execution handle.
4. Run the current bounded projection before transport and assert the serialized instruction is below the 60,000-byte presentation bound.
5. Reopen the outbox/journal with the exact pre-launch error and call reconciliation.
6. Assert the outcome is a queued fresh dispatch with the original request retained in `prelaunchFailure`, the old lease released using its original version/fence, and a new lease required before send.

Stopping condition: one exact pre-launch `E2BIG` classification and one successful bounded rebind; do not call a provider model or run a complete workflow.

## Root-cause confidence

**High.** The incident has a concrete OS error, a precise Runtime transition, a provider transcript showing the preceding large verification context, a missing subsequent business result, and a later source fix that addresses exactly this failure boundary. The evidence does not establish that Herdr itself was defective; Herdr was the transport boundary through which the oversized launch request failed.

## Remaining limitations

- The selected run was later cancelled, so it does not provide a natural post-fix completion comparison.
- The current `main` checkout in this investigation is still at `a46ab10`; the mitigation commits are present in later branch history and need integration/verification on the actual deployment branch before claiming production prevention.
- The later source tests use deterministic runners for the size boundary. A periodic real Herdr/native-provider smoke should still validate the assembled launch environment and prompt size on the deployed revision.
- Repeated `Task notice parent lease is expired or mismatched` messages and one `Journal lock timeout` are real secondary host symptoms in the same state, but they are not needed to explain this selected workflow’s root blocker. They should be investigated separately after the `E2BIG` mitigation is deployed.
