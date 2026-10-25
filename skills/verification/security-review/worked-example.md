# security-review worked example

## Scenario 1: Green security test that misses cross-owner isolation and boundary traversal

### Input

A repository skill loader change (`AC-1`: reject out-of-bundle paths and oversize files up to `256 KiB`; `AC-2`: authenticate repository skill approvals for the exact `sessionId` and `digest`). Candidate tests pass (`exit 0`) with `"AC-1: rejects invalid path"` (testing only `"/etc/passwd"`) and `"AC-2: authorizes repository skill"` (testing a valid receipt for `session-1`).

### Authorized steps

1. Load [the security test viewpoints reference](references/security-test-viewpoints.md) and audit the test coverage against the threat surface.
2. For `AC-1` (**Boundary values & Unicode/traversal ingress**), check relative traversal (`../outside`), URL-encoded traversal (`%2e%2e/outside`), symlinked bundle resources, and the exact size boundary (`256 * 1024` bytes accepted vs `256 * 1024 + 1` bytes rejected before reading unbounded bytes).
3. For `AC-2` (**Role vs owner/scope isolation** and **Replay/stale receipt**), test presenting `session-1`'s valid approval receipt inside `session-2` or against a modified bundle digest, verifying rejection and confirming no manifest is linked.

### Expected output and evidence

The security review report records the missing boundary (`max + 1` byte limit and relative/encoded traversal) and cross-session receipt replay checks, citing exact test and source locations without reading private host files or claiming hostile same-UID isolation.

---

## Scenario 2: Unit-tested policy helper is green while the real entrypoint skips enforcement

### Input

A unit test proves `validateWorktreeScope(changedPaths, affectedPaths)` rejects out-of-scope file modifications (`exit 0`), but the verification entrypoint ingests gate output proposals before checking whether changed files stay within `specification.affectedPaths`.

### Authorized steps

1. Trace the real verification entrypoint (**Real enforcement entrypoint vs isolated helper**).
2. Show that unit-testing `validateWorktreeScope()` in isolation does not prove the entrypoint blocks out-of-scope patches prior to accepting criteria.
3. Require an entrypoint integration check that submits a `GitChangeSet` touching an unauthorized path and verifies that verification returns `escalated` with an `out_of_scope` finding.

### Expected output and evidence

A blocking security/correctness finding distinguishing isolated helper unit proof from real entrypoint enforcement, paired with the entrypoint integration fixture.

---

## Scenario 3: Narrow validation fix needing only targeted checks

### Input

A small fix rejects control characters (`\x00-\x1f`) in document names inside local storage (`AC-1`, `unit_test`, `TddDecision.mode: "required"`).

### Authorized steps

1. Apply only **Boundary & invalid/control-character input** (`2.2`): verify rejection of `""`, `"a\0b"`, `"a/b"`, `".."` and acceptance of valid document names at the storage boundary.
2. Mark multi-tenant/browser/live provider viewpoints `N/A — local document-name validator with no network or UI surface`. Preserve the approved `TestStrategy` without adding unrequested harnesses.

### Expected output and evidence

Concise verification evidence confirming fail-closed rejection and zero file creation on invalid names.

---

## Failure branch

Unavailable isolation or inaccessible security fixtures produce `blocked`/unverified evidence. Do not downgrade a mandatory finding to obtain a pass.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.
