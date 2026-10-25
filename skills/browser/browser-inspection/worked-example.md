# browser-inspection worked example

## Scenario 1: Happy-path check passes while boundary, double-submit and owner isolation fail

### Input

- `AC-1` (`e2e_test`, required): Configuration form rejects port values outside `1024..65535`, disables `Save` during submission to prevent duplicate writes, and forbids `viewer` role or another project owner from editing settings.
- `TddDecision.mode`: `required`.
- Prior test only checked that entering `8080` as admin shows a success toast.

### Authorized steps

1. Verify the `browser` tool grant and acquire the exclusive Gateway browser lease/fence for this repository's profile. Load [the UI risk viewpoints reference](references/ui-risk-viewpoints.md).
2. Check **Control boundaries** (`1023`, `1024`, `65535`, `65536`) and **Invalid/empty input** (`""`, `"abc"`), observing that `Save` stays disabled or displays a validation error on `1023`, `65536` and `""` while accepting `1024` and `65535`.
3. Check **Double-submit** (confirm `Save` disables while in flight and emits one request) and **Role/owner isolation** (confirm `viewer` role or non-owner session cannot enable `Save` or mutate the configuration).

### Expected output and evidence

Sanitized screenshot/DOM artifact proposals and reproducible steps mapped to `AC-1` at the candidate revision, followed by releasing the exact browser lease.

---

## Scenario 2: In-memory HTML/component unit test is green, but the real served entrypoint is broken

### Input

- `AC-1` (`e2e_test`, required): Navigating to `/settings` renders the configuration form and submits updates.
- Unit tests render the form component in memory and pass (`exit 0`), but the real served application bundle throws a runtime `TypeError` on mount because the route entrypoint passes an undefined config prop.

### Authorized steps

1. Open the assigned live test origin under the exclusive browser lease (**Real served entrypoint & cross-screen flow**).
2. Observe the blank screen and console/page error at `/settings`, proving why in-memory HTML/component unit tests could not establish `AC-1`.
3. Capture the console error and rendered DOM state as an artifact proposal and report `AC-1` as `failed`.

### Expected output and evidence

A failure finding with the exact runtime error, candidate revision and browser artifact proposal so Runtime can schedule bounded rework.

---

## Scenario 3: Small UI change needing only focused checks

### Input

- `AC-1` (`manual_review`, required): Empty state message on the runs table displays `"No workflow runs found"` when the list is empty (`TddDecision.mode: "not_applicable"`).

### Authorized steps

1. Respect `TddDecision.mode === "not_applicable"` (no mandatory Red-first test).
2. Under the approved browser lease, open the runs view with an empty fixture and verify the empty-state text and layout (**Failure/timeout, empty & loading recovery**). Mark pagination/double-submit viewpoints `N/A — read-only empty state display`.

### Expected output and evidence

A concise observation and screenshot proposal linked to `AC-1` at the candidate revision.

---

## Failure branch

A missing `browser` tool grant, unreachable target origin or busy exclusive browser lease is reported as `blocked` with the exact prerequisite gap, never permission to steal a lease or substitute static HTML parsing. Timeout after a possible click/write is uncertain and must be reconciled before retry or reassignment.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.
