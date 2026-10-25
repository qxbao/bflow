# Risk-based test design viewpoints (on-demand reference)

Use this reference when designing a verification check plan for `tester` or `qa`. Select only the viewpoints that match the accepted criteria and changed surfaces. Mark non-applicable viewpoints `N/A — <reason>` so small changes stay proportional.

## 1. Traceability chain and anti-superficiality rule

Every planned check in `TestStrategy.criterionMappings` and `CheckConfiguration` must trace five elements:

| Chain element | Required content | Invalid shortcut |
| --- | --- | --- |
| `Criterion` | Accepted `AC-*` ID, required status and declared `verificationMethod` | Inventing new mandatory criteria or waiving a required criterion |
| `Risk & viewpoint` | Concrete business or boundary defect that could pass a happy-path check (or `N/A — reason`) | Applying every viewpoint blindly to a trivial change |
| `Check / test identity` | Exact `testNames` entry and method (`unit_test`, `integration_test`, `e2e_test`, `typecheck`, `lint`, `static_analysis`, `manual_review`) | Naming `AC-1` in a test title or comment while only asserting `expect(result).toBeDefined()` |
| `Environment & prerequisite` | Configured runner command, sandbox, `pnpm build` before subprocesses importing `dist/`, fixture state or required tool grant/lease | Assuming browser or live provider access without a verified grant/lease |
| `Expected evidence` | Observable return value, persisted state/side effect, exit code `0` (or nonzero for `required` Red) and `ArtifactStore` proposal/reference at the candidate revision | Treating Herdr `done`, developer self-report or HTTP `200` with empty payload as pass proof |

## 2. Preserving approved `TestStrategy` and `TddDecision`

- `TddDecision.mode === "required"` (`requiresFailingTestFirst: true`): require spec-derived Red failure (`failureKind: "target_behavior"`) on pre-fix code before Green and Refactor on the unchanged test revision.
- `TddDecision.mode === "recommended"`: prioritize high-risk checks for the required verification methods without forcing a mandatory Red-first gate when policy did not require it.
- `TddDecision.mode === "not_applicable"`: plan the mandatory alternative verification named by the strategy (such as `typecheck`, `lint`, `static_analysis`, `manual_review` or characterization tests passing on unchanged production code). Never demand TDD for every task or rewrite accepted criteria.

## 3. Conditional risk viewpoints

Apply a viewpoint only when its trigger condition holds for the assigned task:

### 3.1 Equivalence partitioning (EP) and boundary value analysis (BVA)

- **When to apply:** Criteria or code involving numeric ranges, string/array lengths, quotas, pagination, timeouts, retry counts (`maxIterations`) or ordered thresholds. Mark `N/A` for pure enum/boolean routing without ordered bounds.
- **Risk to check:** Off-by-one comparisons (`<` vs `<=`), silent truncation, integer overflow/underflow or untested invalid equivalence partitions hidden by a single mid-range happy-path value.
- **Input / Action / Expected observation:** Choose one representative per valid and invalid partition plus exact boundaries (`min - 1`, `min`, `max`, `max + 1`, and `0` / negative when numeric). Execute the target validator or operation; observe acceptance with exact output at `min` and `max`, and deterministic rejection with zero state mutation at `min - 1` and `max + 1`.
- **Evidence to collect:** Deterministic test log at the candidate revision recording the exact boundary inputs, exit code and criterion mapping.

### 3.2 Invalid input, Unicode and empty/null data

- **When to apply:** Changes touching ingress schemas (Zod parsers), CLI flags, file paths, search/filter inputs, JSON/YAML serialization or user/agent text handling. Mark `N/A` for internal numeric helpers behind an already-validated contract boundary.
- **Risk to check:** Crash or silent coercion on `null` / `undefined` / `""` / whitespace-only strings, UTF-8 byte-vs-character length bugs, combining diacritics (such as Vietnamese accented text), emoji surrogate pairs, UTF-8 BOM, embedded null bytes or path traversal segments (`..`).
- **Input / Action / Expected observation:** Feed empty, whitespace-only, malformed-type, oversized and multibyte UTF-8 inputs into the ingress boundary. Observe fail-closed rejection before any storage or transport side effect for invalid inputs, and lossless UTF-8 preservation for valid text.
- **Evidence to collect:** Test output or artifact log showing structured ingress rejection, unchanged store/filesystem state and exact UTF-8 round-trip assertions.

### 3.3 Authorization, tenant and ownership isolation

- **When to apply:** Multi-role, multi-tenant, multi-repository or multi-session operations; resource read/write/delete handlers; lease/fencing checks; tool grants or approval gates. Mark `N/A` for pure stateless single-scope calculations.
- **Risk to check:** Verifying only role presence (for example, caller is `developer` or `tester`) while allowing Principal/Repository/Session A to read, mutate, cancel or release a resource belonging to Principal/Repository/Session B.
- **Input / Action / Expected observation:** Execute the operation as an unprivileged role AND as an authenticated role bound to Owner/Scope A targeting a resource owned by Owner/Scope B (or presenting a stale fencing token). Observe explicit denial, unchanged Owner B state and intact active lease/fence.
- **Evidence to collect:** Test or security review receipt demonstrating both authorized owner success and cross-owner/cross-scope denial with post-attempt state verification.

### 3.4 Double-submit, retry and idempotency

- **When to apply:** State-mutating commands, event/receipt ingestion, task dispatch, approval recording, transport timeout recovery (`unknown_delivery`) or UI submit actions. Mark `N/A` for side-effect-free read queries.
- **Risk to check:** Duplicate records or events, double transport dispatch before `unknown_delivery` is reconciled as `not_delivered`, or corrupted optimistic version counters on repeated delivery.
- **Input / Action / Expected observation:** Deliver the same command or mutation twice with the same `idempotencyKey` (and test conflicting payload under the same key, or timeout producing `unknown_delivery`). Observe idempotent replay returning the original receipt, explicit conflict rejection on mismatched payload, and zero duplicate side effects or automatic resends before reconciliation.
- **Evidence to collect:** Test log or store inspection proving single persisted effect (`count === 1`), preserved version/fencing token and durable `unknown_delivery` state.

### 3.5 Failure/recovery, timeout and partial failure

- **When to apply:** Multi-step SQLite/filesystem/transport operations, subprocess quality gates, lock acquisition or crash/restart recovery flows. Mark `N/A` for pure in-memory synchronous functions.
- **Risk to check:** Mid-flight crash, abort or timeout leaving orphan locks, partial unvalidated state, missing execution bindings, or a runner timeout misreported as task pass/stop.
- **Input / Action / Expected observation:** Trigger a deterministic mid-step failure, abort signal, runner timeout or restart recovery from checkpoint/event log. Observe fail-closed classification (`blocked` or `inconclusive` on timeout/missing runner), intact prior state or tombstoned partial output, and exact state reconstruction on recovery.
- **Evidence to collect:** Failure/recovery test log and verification audit receipt confirming preserved durable intent, checkpoint integrity and absence of false pass results.

### 3.6 Brownfield before/after behavioral parity

- **When to apply:** Refactoring, config/schema migration, adapter replacement or modifying existing commands/contracts in a brownfield module. Mark `N/A` for net-new isolated capabilities with no legacy callers.
- **Risk to check:** Exit code `0` or HTTP `200` passes while existing payload fields become `null` / `""`, error codes change, or preserved configuration keys (such as `userSettings` or unrelated role pins) are silently dropped.
- **Input / Action / Expected observation:** Run representative baseline inputs and legacy configuration fixtures through the modified code path. Compare full output fields, side effects and error shapes field-by-field against the baseline contract.
- **Evidence to collect:** Regression or characterization test log verifying field-level parity and preserved existing settings at the candidate revision.

### 3.7 Real entrypoint and cross-component wiring

- **When to apply:** Changes that register CLI subcommands, HTTP/IPC routes, Runtime port compositions, quality gate runners or cross-module/cross-screen workflows. Mark `N/A` when a change is strictly inside an already-wired leaf function whose signature and callers do not change.
- **Risk to check:** Unit tests pass by calling an internal helper or mounting a test-only router/mock, while the real CLI binary, Runtime host composition or built `dist/` package omits the route, skips ingress validation or fails on import.
- **Input / Action / Expected observation:** Run `pnpm build` when workers/subprocesses import `dist/`, then invoke the real entrypoint (CLI command runner, composed service or served application origin) across the connected components. Observe end-to-end ingress validation, side effect and output.
- **Evidence to collect:** `integration_test` or `e2e_test` log exercising the real entrypoint at the candidate revision.

## 4. Unit test vs integration/E2E boundaries and prerequisite gaps

| Level | What it proves | What it still leaves unproven |
| --- | --- | --- |
| `unit_test` | Isolated domain rules, EP/BVA math, parser/schema rejection and state transitions with controlled fakes | Real CLI/HTTP/Runtime entrypoint wiring, cross-package contract compatibility, SQLite/filesystem lock semantics, built `dist/` imports and browser DOM runtime |
| `integration_test` | Real module composition, SQLite/ArtifactStore persistence, Git worktree/subprocess boundaries and CLI/API entrypoint wiring | Live external provider behavior or real browser layout/JS rendering when UI criteria exist |
| `e2e_test` / `browser-inspection` | Full workflow or real rendered UI journey against an active origin with exclusive resource lease | Hostile same-UID OS isolation or unconfigured external environments |

**Browser and live provider rule:**
- Do not require browser inspection or live provider/Herdr runs when the task has no UI or live-provider acceptance criterion.
- Do not invoke browser or live tools when the role lacks the approved tool grant, exclusive lease/fence or target origin permission.
- When an accepted criterion requires browser observation or live provider proof and that prerequisite is unavailable, record an explicit prerequisite gap (`blocked` or `inconclusive`) in the plan/report and escalate via Runtime → Herdr → Conversation. Never relabel unit tests or static HTML string checks as browser/live E2E evidence.
