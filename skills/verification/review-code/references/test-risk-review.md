# Risk-based code and test review guide (on-demand reference)

Load this reference during `review-code` when evaluating whether a candidate diff and its tests genuinely detect business and boundary defects within Bflow's approved `TestStrategy` and `Verification` loop.

## 1. Review the tests and evidence chain first

Verify that every required criterion is backed by the full chain `criterion → risk → check/test identity → environment/prerequisite → expected evidence`:

- **Reject AC-tag-only coverage:** A test with `AC-1` in its name or comment that only checks happy-path inputs, asserts `expect(res).toBeTruthy()`, or recomputes expected output with the function under test does not cover the criterion.
- **Reject over-mocked paths:** If a test mocks out the schema parser, authorization check, store adapter or router wiring that the criterion actually depends on, record a finding naming the bypassed boundary.
- **Verify side effects:** When an operation mutates SQLite (`RunStore`), `ArtifactStore`, Git worktrees or transport bindings, tests must assert the persisted state or absence of mutation on error—not return values alone.
- **Reject non-discriminating race evidence:** For race/concurrency/lock/atomic criteria, apply §4 below; a `Promise.all` over synchronous sections or a final-count-only assertion is not race evidence.

## 2. Conditional risk viewpoints for diff review

Check only the viewpoints that apply to the changed code and criteria (do not flag inapplicable viewpoints):

| Viewpoint | When applicable | Risk to inspect in diff & tests | Required input / action / expected observation | Expected evidence |
| --- | --- | --- | --- | --- |
| **1. EP & boundary values (BVA)** | Numeric limits, lengths, quotas, pagination, timeouts, `maxIterations` | `<` vs `<=` off-by-one, missing `min - 1` or `max + 1`, untested invalid partition | Probes at `min - 1`, `min`, `max`, `max + 1` (and `0`/negative) showing exact acceptance at bounds and rejection outside bounds | Deterministic test log at candidate revision covering both sides of each boundary |
| **2. Invalid input, Unicode & empty data** | Parsers, Zod ingress schemas, CLI flags, paths, search/filter or text fields | Crash or silent coercion on `null`/`""`/whitespace, UTF-8 byte-vs-char truncation, diacritics/emoji/BOM, path traversal | Malformed, empty, whitespace-only and multibyte UTF-8 inputs tested at ingress; fail-closed rejection before side effects | Test output showing structured ingress error and untouched persistence/transport state |
| **3. Authorization, tenant & ownership isolation** | Multi-role, multi-repo, multi-session or resource-scoped handlers, leases/fencing | Checking role label only while allowing Principal/Repo/Session A to read or mutate Principal/Repo/Session B's state | Actor A targeting Actor B's resource (or using a stale fencing token) receives explicit denial with zero state change | Test or security receipt proving cross-owner denial and unchanged target state |
| **4. Double-submit, retry & idempotency** | Mutating commands, event/receipt writes, `unknown_delivery` transport recovery | Duplicate side effects, version drift or automatic resend after timeout before reconciliation proves `not_delivered` | Duplicate delivery with same `idempotencyKey` and timeout/retry sequence; single persisted side effect and reconciled state | Test log verifying record/event count `1` and preserved `unknown_delivery` barrier |
| **5. Failure/recovery, timeout & partial failure** | Multi-step persistence/transport, subprocess gates, locks, crash/restart recovery | Orphan lock, half-written state, swallowed error or timeout misclassified as `passed` | Injected mid-step failure, abort, timeout or checkpoint recovery; fail-closed `blocked`/`inconclusive` or clean rollback/recovery | Recovery/failure test receipt showing intact checkpoint, durable intent and no false pass |
| **6. Brownfield before/after parity** | Refactoring, config/schema migration, replacing an adapter or updating an existing command | Status/exit `0` passes while response fields become `null`/`""`, error codes shift or `userSettings`/pins are lost | Representative baseline inputs compared field-by-field for output payload, preserved config keys and side effects | Regression or characterization test log proving field-level equivalence |
| **7. Real entrypoint & component wiring** | New/changed CLI commands, routes, Runtime port wiring, quality gates or cross-component flows | Unit test calls internal helper directly while real CLI/Runtime entrypoint or built `dist/` omits wiring or middleware | Execution through the real entrypoint (after `pnpm build` when `dist/` is imported) exercising ingress-to-storage flow | `integration_test` or `e2e_test` receipt at the candidate revision |
| **8. Concurrency, race & atomicity** | Locks/mutexes, atomic updates, read-check-write across an `await`, lease/fence ordering | Test still passes with the lock removed; `Promise.all` over synchronous sections; no interleaving point inside the critical section | Interleaving point inside the critical section plus negative control (protection removed or pass-through → same named test fails) | Test log naming the interleaving point and the mutation result at the candidate revision |

## 3. Unit vs integration/E2E boundaries and policy alignment

1. **Keep `TestStrategy` and `TddDecision` authoritative:**
   - When `TddDecision.mode` is `required`, verify that Red (`failureKind: "target_behavior"`), Green and Refactor receipts exist and use the same mapped tests.
   - When `TddDecision.mode` is `recommended` or `not_applicable` (such as documentation, configuration or test-only characterization), verify the required alternative or characterization checks without inventing a mandatory Red-first gate.
2. **State what unit tests prove vs what they miss:**
   - `unit_test` proves isolated function/parser behavior under controlled inputs.
   - `unit_test` does **not** prove CLI/Runtime entrypoint registration, cross-package contract compatibility, SQLite/filesystem transactional ordering, `dist/` subprocess execution or real browser DOM rendering.
3. **Browser and live provider discipline:**
   - Never demand browser or live provider checks when the criterion does not require them or the role lacks the grant/lease.
   - If an accepted criterion requires browser UI or live provider verification and the environment/grant is unavailable, report a `blocked` or `inconclusive` prerequisite gap—never accept static HTML string parsing or a fake runner as a substitute.

## 4. Race and concurrency criteria: discriminating evidence

Checklist for any criterion or changed code containing race, concurrency, lock, mutex, mutual exclusion, atomic or ordering wording:

- [ ] **Interleaving point:** the test forces two operations to overlap inside the critical section (an `await`, injected hook/clock/barrier, deferred promise or controllable fake between read and write). Name the point.
- [ ] **Negative control:** with the lock/protection removed or replaced by a pass-through, the same named test fails. Require the observed result, or a planned mutation check with its expected failure when the role cannot run it.
- [ ] **Not sufficient alone:** `Promise.all` over synchronous critical sections, final-count-only assertions, or tests that pass without the protection are `invariant coverage`, not race proof.

Owners can enforce the negative control with an owner-configured `mutationChecks` entry in the repository's owner verification configuration (documented in the Runtime verification-runners guide).

If any box is missing for a required criterion, raise a blocking finding that the criterion's evidence is non-discriminating, naming the test and the missing interleaving point or negative control. Do not invent a mutation result; if the reviewer cannot run the mutation, report a prerequisite gap (`blocked`/`inconclusive`). When rechecking a rework fix for such a finding, rerun the discriminating checks on the revised candidate, as in `fix-review-findings`.
