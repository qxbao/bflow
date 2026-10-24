# Security test and boundary viewpoints (on-demand reference)

Load this reference during `security-review` to evaluate whether a candidate diff and its security checks falsify real authority, isolation and boundary risks within the approved `TestStrategy`.

## 1. Traceability and test sufficiency at security boundaries

A security check must link `criterion → threat/risk → check/test identity & method → environment/prerequisite → expected evidence`:

- **AC tag != security proof:** A test named `"AC-SEC-1: enforces auth"` that only checks an unauthenticated `401` or a happy-path admin call does not prove role-vs-owner isolation or side-effect denial.
- **Zero-mutation assertion on denial:** Every negative security test must assert both the rejection outcome AND that the target store, file, lease or receipt was not modified or leaked.
- **Respect `TestStrategy` and `TddDecision`:** Do not invent mandatory TDD Red-Green-Refactor gates when `TddDecision.mode` is `recommended` or `not_applicable`, and do not require browser or live provider execution unless a security criterion explicitly depends on it.

## 2. Conditional security viewpoints

Apply only the viewpoints triggered by the candidate diff:

| Viewpoint | When applicable | Security risk to check | Input / Action / Expected observation | Evidence to collect |
| --- | --- | --- | --- | --- |
| **1. Role vs owner/tenant/scope isolation** | Multi-role, multi-repository, multi-session or resource-bound operations | Checking role membership (`developer`, `tester`) while allowing Scope/Owner A to read, mutate or approve Scope/Owner B's resource | Authenticate as valid Role in Scope/Repo/Session A and target a resource, manifest or lease owned by Scope/Repo/Session B; observe denial and unchanged Scope B state | Deterministic test or security receipt proving cross-owner denial and intact target state |
| **2. Boundary values, empty/null & Unicode/traversal ingress** | Path resolution, bundle/artifact loading, schema parsing, CLI arguments or size/count limits | Off-by-one quota/size bypass (`max + 1`), null byte `\0`, empty/whitespace identifiers, Unicode normalization/BOM or `..` / symlink traversal escaping root | Supply `min - 1`, `max + 1`, `""`, whitespace, UTF-8 multibyte/BOM, `../escape`, backslash and symlink fixtures; observe fail-closed rejection before reading or writing bytes | Test log verifying rejection prior to I/O and unchanged outside fixture file bytes/modes |
| **3. Replay, double-submit & stale fencing tokens** | Lease-gated actions, approval receipts, idempotent writes or `unknown_delivery` transport handoffs | Replaying an expired/superseded approval receipt, using a stale fencing token after lease reassignment, or duplicating a mutation on retry | Submit an action with a stale fencing token, expired session scope, duplicate `idempotencyKey` with altered payload or unreconciled `unknown_delivery`; observe rejection and zero side effect | Test receipt confirming stale token/receipt rejection and single-execution invariant |
| **4. Partial failure, timeout & secret containment** | Multi-step setup/install, lock acquisition, subprocess runners or error/diagnostic reporting | Crash or timeout leaving permissive file modes (`0o755` instead of `0o700`/`0o600`), orphan locks, half-published entries or secrets in logs/errors | Trigger mid-flight failure or timeout; observe private modes preserved, unvalidated staging ignored/cleaned, fail-closed lock retention and redacted diagnostics | Storage/security test log verifying file permissions, lock state and sanitized error output |
| **5. Real enforcement entrypoint vs isolated helper** | New/modified commands, Gateway endpoints, Runtime dispatchers or quality gates | Unit test exercises `checkPermission()` in isolation while the real handler entrypoint executes the side effect before calling `checkPermission()` | Invoke the real handler/entrypoint with an unauthorized or out-of-scope request; observe denial before any side effect occurs | Integration test or code-trace receipt at the real entrypoint boundary |

## 3. Unit vs integration/live evidence boundaries

- **What unit tests prove:** Schema rejection rules, path-string validators and pure policy evaluation functions.
- **What requires integration/entrypoint checks:** Actual filesystem `lstat`/`open` (`O_NOFOLLOW`) behavior, directory mode `0o700` / file mode `0o600` enforcement, SQLite/store atomicity and handler ordering before side effects.
- **Prerequisite gaps:** If a criterion requires OS sandbox, browser origin isolation or live provider attestation that is unavailable in the current environment, report `blocked` or `unverified` with the exact missing prerequisite—never claim hostile same-UID or live isolation from unit tests.
