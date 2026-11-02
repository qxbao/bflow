# E2BIG Mitigation Integration and Recovery Validation

Validation date: 2026-10-30

## Revision comparison

The audit worktree is at `01996a4`, a documentation descendant of `a46ab10`.

The actual persistent Bflow host state is for repository `/mnt/01DCE9A4D6522BD0/Project/AI/AI-flow-SDLC`, session `bf-c1695ccd3f2b994f91bd`, and records:

```text
executionResolution.plan.repository.revision = a46ab103428aa52e13d353c13eaf5286a92d30b4
platform generation = 59
```

That is the investigated incident revision. The host state therefore does not prove that the later remediation commits were active when the incident occurred. The current source checkout includes the same mitigation implementation in its tree, and the build output contains the bounded policy projection and pre-launch recovery code. No active Bflow host process was present during this validation, so the report does not claim that a currently running process has hot-reloaded the rebuilt artifacts. A host restart/reopen using the current checkout is required before declaring the live host upgraded.

The named commits are available in the local Git object database and their changes are present in the current source tree through the repository’s later history topology:

- `1d29112` — durable references for large native deliveries.
- `3c64964` — bounded policy prompts and exact pre-launch `E2BIG` classification.
- `106502f` — recovery across host reopen and bound journal reads.
- `5503cba` — pin bounded policy presentations before provider dispatch.
- `0594f92` — recover pre-launch phases from the locked journal.

No cherry-pick was performed. Applying these commits again would duplicate or revert later refinements. The current source was inspected directly and is patch-equivalent for the relevant mitigation path.

## Mitigation verified in source

The current Runtime path has these protections:

1. `projectPolicyPhaseEnvelope` compacts oversized conditional-evidence verification envelopes to a bounded transport presentation while leaving the full evidence in the durable Runtime/artifact path.
2. The outbox pins the bounded wire envelope before creating the transport request. It preserves request/message identity and rejects a changed pinned context.
3. Native Herdr delivery uses a digest-bound reference for large messages instead of embedding the full envelope in the plugin context environment. The native plugin resolves only a validated private host intent and verifies the message digest before signing.
4. `provenPrelaunchPolicyFailure` requires all of the following before classifying recovery-safe non-execution: Linux, exact `spawn E2BIG`, `unknown_delivery`, no execution handle, exact request/message identity, an oversized original request, and no correlated received reply.
5. `HerdrOutbox.reconcile` releases the original lease using the saved fencing token and optimistic version, records the original request in `prelaunchFailure`, removes the stale lease/request, and queues a fresh dispatch requiring a new Registry fence.
6. Host reopen scans the locked journal for proven pre-launch failures and invokes the same reconciliation path. Registry recovery errors are held for explicit recovery rather than silently discarded.
7. Ordinary verification requests, unrelated large messages, and non-conditional evidence envelopes bypass the policy projection and retain their original semantics.

The source does not widen permissions, approve prompts, manufacture a handle, or treat `E2BIG` as remote delivery.

## Focused regression results

Build:

```text
pnpm run build
PASS
```

Focused Runtime tests:

```text
pnpm exec vitest run \
  packages/runtime/test/agentic/policy-prompt.test.ts \
  packages/runtime/test/agentic/manual-review-policy.test.ts \
  packages/runtime/test/agentic/native-intent-selection.test.ts \
  --maxWorkers=1 --minWorkers=1 --reporter=basic
```

Result:

```text
Test Files: 3 passed
Tests: 44 passed
```

The tests cover:

- bounded conditional-evidence projection;
- preservation of criteria, request identity, context and evidence references;
- unchanged handling for unrelated message types and primitive payloads;
- exact pre-launch classification and rejection of altered status, handle, request, platform, or received reply;
- durable pre-launch proof across journal serialization;
- release with the original Registry version/fence;
- fresh monotonic fencing after recovery;
- Registry failure retention and retry;
- recovery from the locked journal without using a diagnostic projection;
- native intent reference size, digest binding, session scoping, and signed full-envelope reconstruction;
- the simulated Herdr `spawn E2BIG` boundary and successful bounded replacement.

## Direct Linux process-launch boundary

A bounded direct probe used Node’s real child-process launch without changing system limits or invoking a model:

```text
Oversized inherited environment value: 180 KiB
Result: spawnSync error E2BIG; child did not start

Bounded digest reference environment value: small JSON reference
Result: exit 0; exact reference received by child
```

This confirms the OS boundary involved in the incident and demonstrates why a digest/reference or bounded presentation prevents the launch failure. It does not replace the Runtime tests or prove a full provider workflow.

## Real Herdr boundary result

The existing native Herdr smoke was run with:

```sh
BFLOW_TEST_LIVE_HERDR=1 BFLOW_LIVE_HERDR=1 TMPDIR=/tmp \
  pnpm exec vitest run packages/runtime/test/agentic/live-herdr.test.ts \
  --maxWorkers=1 --minWorkers=1 --reporter=basic
```

Result: 1/1 passed.

Observed evidence:

```json
{
  "evidence": "herdr-native-plugin-message",
  "protocol": "22",
  "submissionStatus": "unknown_delivery",
  "authenticatedMessageReceived": true,
  "bindingVerified": false,
  "taskStatus": "running",
  "modelProviderUsed": false
}
```

This validates the real Herdr plugin/socket/signature boundary and preserves the project’s evidence rule: authenticated native receipt is not task success or execution binding. The smoke does not exercise a paid provider or a full SDLC.

## Prevention and recovery status

| Requirement | Evidence | Result |
| --- | --- | --- |
| Large conditional-evidence request is bounded | `policy-prompt.test.ts`, `manual-review-policy.test.ts`, build output | Prevented before transport launch |
| Original evidence and request identity preserved | projection/context/digest assertions | Preserved |
| Pre-launch E2BIG distinguished from post-launch uncertainty | exact classifier requires no handle and no correlated reply | Fail-closed classification |
| No execution handle fabricated | classifier and outbox reconciliation tests | Preserved |
| Original lease released with fence/version | outbox recovery tests | Verified |
| Fresh dispatch requires fresh fence | FileAgentRegistry regression test | Verified |
| Restart does not strand the task permanently | locked-journal recovery test and host reopen path | Verified in local tests; live host restart not run |
| Ambiguous non-E2BIG error remains fail-closed | altered error/handle/status tests | Preserved |
| Normal verification requests still work | manual-review lifecycle and native Herdr smoke | Verified within focused scope |
| Current deployed host is running the mitigation | host resolution remains pinned to `a46ab103…`; no active process to inspect | Not yet proven |

The exact E2BIG failure is mitigated in the current source and build, but the original active host session must be restarted/reopened from this source revision before the deployment claim is closed.

## Separate remaining symptoms

The incident host log also contains repeated:

```text
Task notice parent lease is expired or mismatched
```

from scheduler, delivery-reconcile, watchdog, and stop paths, plus a `Journal lock timeout`. These are separate findings. The E2BIG evidence already explains the selected workflow blocker; the lease/log symptoms were not used as its root cause. They should receive a separate investigation after the host is restarted on the mitigation revision, because stale host state or an independent lease-lifecycle issue could otherwise obscure validation.

## Final status

- **Source mitigation:** present.
- **Focused prevention/recovery tests:** 44/44 passed.
- **Build:** passed.
- **Direct Linux E2BIG boundary:** reproduced with oversized environment; bounded reference launched successfully.
- **Real Herdr native smoke:** 1/1 passed, no model/provider.
- **Current persistent host revision:** `a46ab103…`, the incident revision.
- **Target deployment mitigation status:** not closed until the host is restarted/reopened with the current built source and its execution resolution is re-pinned to that revision.
- **Product code changes in this validation:** none.
