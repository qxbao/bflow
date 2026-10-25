# test-planning worked example

## Scenario 1: Green tests that miss ownership isolation and boundary values

### Input

- `AC-1` (`unit_test`, required): Batch size must be an integer between `1` and `100` inclusive.
- `AC-2` (`integration_test`, required): A role session may cancel only runs belonging to its own `repositoryId`.
- `TddDecision.mode`: `required`.
- Existing developer tests pass (`exit 0`) with names `"AC-1: validates batch size"` (testing only `50` and `-5`) and `"AC-2: cancels run"` (testing `repo-a` cancelling its own `run-1`).

### Analysis and authorized steps

1. Inspect [the conditional risk viewpoints reference](references/risk-viewpoints.md). Having `AC-1` and `AC-2` in test titles does not prove coverage because the tests omit the upper boundary and cross-repository isolation.
2. Apply **EP/BVA** (`3.1`) and **Invalid/empty input** (`3.2`) to `AC-1`: plan boundary checks for `0` (`min - 1`), `1` (`min`), `100` (`max`), `101` (`max + 1`), `NaN` and `"100"` (uncoerced string). This catches `< 100` vs `<= 100` off-by-one bugs.
3. Apply **Authorization, tenant and ownership isolation** (`3.3`) and **Double-submit / idempotency** (`3.4`) to `AC-2`: plan an integration check where a session bound to `repo-a` attempts to cancel `run-2` owned by `repo-b`, asserting rejection and verifying in `RunStore` that `run-2` remains active with its optimistic version unchanged. Mark Browser/UI viewpoints `N/A — backend run control with no UI criterion`.

### Expected output and evidence

| Criterion | Risk & viewpoint | Check / test identity & method | Environment & prerequisite | Expected evidence |
| --- | --- | --- | --- | --- |
| `AC-1` | Off-by-one at `100`/`101` and non-integer coercion (EP/BVA + Invalid input) | `AC-1: accepts 1 and 100 and rejects 0, 101, NaN and string` (`unit_test`) | Configured unit test runner at candidate revision | Test result artifact showing `1` and `100` accepted; `0`, `101`, `NaN` rejected |
| `AC-2` | Cross-repository run cancellation by another authenticated session (Ownership isolation) | `AC-2: denies cross-repository cancel and preserves target run state` (`integration_test`) | Local SQLite `RunStore` fixture; `pnpm build` completed | Integration test artifact showing forbidden error and unchanged `repo-b` run state |

---

## Scenario 2: Unit tests green in isolation while the real entrypoint is broken

### Input

- `AC-1` (`integration_test`, required): The CLI `status` handler must reject malformed run identifiers before querying persistence and return a structured error.
- `TddDecision.mode`: `recommended`.
- Unit tests call the internal helper `parseRunId()` directly and pass (`exit 0`), but the CLI command dispatcher in `apps/cli` calls `runStore.getRun()` directly with the raw argument without invoking `parseRunId()`.

### Analysis and authorized steps

1. Identify the **unit vs integration boundary**: unit tests prove `parseRunId()` rejects invalid strings when called directly, but they do not prove the real CLI entrypoint wires `parseRunId()` before persistence or that built `dist/` modules resolve cleanly.
2. Apply **Real entrypoint and cross-component wiring** (`3.7`) and **Invalid/Unicode/empty input** (`3.2`): plan an `integration_test` that runs `pnpm build` first and invokes the actual CLI dispatcher / built entrypoint with `""`, `"../escape"` and whitespace-only identifiers.
3. Verify both observations: non-zero exit code / structured error output AND zero queries or mutations recorded against the persistence port.

### Expected output and evidence

The plan records why the green unit test is insufficient for `AC-1` (`verificationMethod: "integration_test"`) and binds an entrypoint integration check at the built candidate revision as required evidence.

---

## Scenario 3: Small change needing only a few discriminating checks

### Input

- `AC-1` (`unit_test`, required): Pure helper `covers(prefix, path)` must match exact path or `/` child segments without matching sibling prefixes (`covers("src/app", "src/apple/index")` must be `false`).
- `TddDecision.mode`: `required`; `requiredTestLevels`: `["unit"]`.

### Analysis and authorized steps

1. Keep the plan proportional to the change. Apply only **EP/BVA** (`3.1`) and **Brownfield parity** (`3.6`) on path segment boundaries: exact match (`covers("src/app", "src/app") === true`), valid child (`covers("src/app/", "src/app/main") === true`), sibling prefix collision (`covers("src/app", "src/apple/main") === false`), and trailing-slash normalization.
2. Record `N/A — pure synchronous path helper with no auth, persistence, transport or UI surface` for Authorization (`3.3`), Double-submit (`3.4`), Failure/recovery (`3.5`) and Browser inspection.
3. Preserve `TddDecision.mode === "required"` by running the 4 discriminating unit assertions in the Red → Green → Refactor sequence without adding unnecessary integration or browser harnesses.

### Expected output and evidence

A compact 1-criterion matrix mapping `AC-1` to the 4 segment-boundary unit assertions and their Red/Green/Refactor verification receipts.

---

## Failure branch

If a criterion requires browser UI observation or a live provider environment that is not granted or reachable, record the criterion as `blocked` with the exact missing prerequisite (such as `browser` tool grant/lease or live target origin) and continue planning permitted independent checks. Never invent an unsupported test command or substitute static HTML parsing for required browser execution.

Every non-Conversation role routes missing requirements, permission requests and human decisions through Runtime → Herdr → Conversation. Keep native direct questions/elicitation disabled. Conversation is the sole user interface and cannot mutate source or dispatch specialists. Silence and unattended mode are not approval.
