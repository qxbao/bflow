# review-code worked example

## Scenario 1: Candidate tests are green and carry AC tags, but miss ownership isolation and boundary values

### Input

A candidate diff implements `AC-1` (pagination `limit` must be `1..50`) and `AC-2` (only the owning `sessionId` may release an exclusive resource lease). All unit tests pass (`exit 0`), including `"AC-1: enforces pagination limit"` and `"AC-2: releases resource lease"`.

### Authorized steps

1. Load [the test and risk review reference](references/test-risk-review.md) and inspect the test bodies alongside the implementation diff.
2. Observe that `"AC-1: enforces pagination limit"` only tests `limit = 20` and `limit = 0`, while the implementation uses `limit < 50` instead of `limit <= 50` (failing at `max = 50`).
3. Observe that `"AC-2: releases resource lease"` only tests `session-a` releasing its own lease, while the handler checks `leaseExists(resourceKey)` without verifying `lease.sessionId === caller.sessionId` or the monotonic fencing token.

### Expected output and evidence

Submit two blocking correctness/security findings citing exact source and test locations:
- `AC-1` boundary defect (`max = 50` rejected due to `< 50` off-by-one) and missing `50` / `51` (`max` / `max + 1`) boundary assertions.
- `AC-2` ownership isolation defect allowing `session-b` to release `session-a`'s active lease, requiring a cross-session denial test that verifies the lease and fencing token remain intact.

---

## Scenario 2: Unit tests pass in isolation, but the real entrypoint and `unknown_delivery` barrier are broken

### Input

A retry patch updates transport timeout handling (`AC-1`, `integration_test`). A unit test calls `shouldRetry(state)` directly with a mocked state object and passes, while the real runtime dispatch entrypoint resends immediately after a transport timeout without persisting or reconciling `unknown_delivery`.

### Authorized steps

1. Trace the real dispatch entrypoint rather than trusting the isolated unit helper test.
2. Show that the unit test only proves `shouldRetry()` returns `false` when manually passed `"unknown_delivery"`, whereas the actual timeout catch block in the runtime handler never transitions the binding to `unknown_delivery` before re-invoking transport.
3. Cite the changed handler location and reproduce the duplicate resend across the real entrypoint boundary using a deterministic timeout fixture.

### Expected output and evidence

A high-priority finding explaining what the unit test proved (isolated helper branch) versus what broke at the real entrypoint (missing `unknown_delivery` persistence and reconciliation proof before replay); Runtime assigns bounded rework within `maxIterations`.

---

## Scenario 3: Small change where a few discriminating checks suffice

### Input

A bugfix updates a configuration migration helper to preserve `userSettings` when updating role pins (`AC-1`, `unit_test`, `TddDecision.mode: "required"`). The diff touches one pure function and adds three unit tests covering: (a) preserving nested `userSettings`, (b) preserving untouched role pins, and (c) rejecting malformed `schemaVersion`.

### Authorized steps

1. Check [the test and risk review reference](references/test-risk-review.md): **Brownfield before/after parity** and **Invalid input** apply and are fully covered by the three discriminating assertions and Red/Green/Refactor receipts.
2. Confirm that **Real entrypoint**, **Browser UI**, and **Live provider** viewpoints are `N/A` for this scoped pure helper task. Do not invent extra mandatory integration or browser tests outside the approved `TestStrategy`.

### Expected output and evidence

An evidence-backed review pass confirming that `AC-1` is traced from risk to assertion and Red/Green/Refactor receipts at the candidate revision.

---

## Failure branch

If the candidate diff, test logs or required environment prerequisites are inaccessible, report `blocked` or `inconclusive` to Runtime. Do not infer approval from a clean summary, green happy-path unit tests or Herdr `done` status.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.
