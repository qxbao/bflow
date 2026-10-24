# Conditional UI and browser risk viewpoints (on-demand reference)

Load this reference during `browser-inspection` when an acceptance criterion requires rendered browser verification and the role holds an approved `browser` tool grant and exclusive resource lease.

## 1. When browser inspection applies vs prerequisite gaps

- **Do not require browser checks for non-UI work:** Backend logic, CLI commands, schema parsers and storage engines are verified via `unit_test` and `integration_test`.
- **What unit/component tests prove vs browser inspection:** In-memory component or HTML-string tests prove template structure in isolation, but cannot detect runtime JavaScript exceptions, broken bundle imports, CSS layout overlap or real server-to-browser wiring.
- **Fail-closed on missing prerequisites:** If an accepted UI criterion requires browser observation but the `browser` tool grant, exclusive lease or target origin is unavailable, report `blocked` with the missing prerequisite. Never relabel static HTML parsing as browser evidence.
- **Traceability chain:** Map each check as `criterion → UI risk & viewpoint → check/action identity → origin & lease prerequisite → expected evidence`. Naming `AC-*` in a test title without observing the rendered state transition does not prove coverage.

## 2. Conditional UI risk viewpoints

Select only the viewpoints triggered by the affected screen or control (mark inapplicable viewpoints `N/A — <reason>`):

| Viewpoint | When applicable | UI / business risk | Input / Action / Expected observation | Evidence to collect |
| --- | --- | --- | --- | --- |
| **1. Control boundaries (EP/BVA)** | Numeric/text inputs, length limits, pagination, sliders or file size limits | Off-by-one (`max` rejected or `max + 1` accepted), silent truncation or broken pagination bounds | Enter `min - 1`, `min`, `max`, `max + 1` values; observe valid submission at `min`/`max` and inline validation error + blocked submit at `min - 1`/`max + 1` | Sanitized screenshot/DOM observation and test log at candidate revision |
| **2. Invalid, empty & Unicode input** | Required fields, formatted inputs (email/date/filter) or free-text/search boxes | Submitting empty/whitespace-only required fields, IME/Unicode rendering corruption (Vietnamese diacritics, emoji) or unhandled script/special characters | Submit `""`, whitespace-only `"   "`, malformed format and accented Unicode/emoji text; observe clear validation message, intact layout and exact text rendering | DOM/screenshot proposal showing validation state and preserved UTF-8 text |
| **3. Role & owner UI isolation** | Role-gated controls, multi-tenant views or user-owned records | Showing/enabling restricted actions to unauthorized roles or exposing User B's record to User A | Inspect screen under restricted role or Owner A session accessing Owner B's view; observe restricted controls hidden/disabled, `403`/redirect enforced and zero cross-owner data rendered | Observation log and artifact proposal confirming access denial and clean session isolation |
| **4. Double-submit & in-flight idempotency** | Submit, save, approve or delete buttons that trigger state mutations | Rapid double-click or retry during slow network dispatches duplicate mutations | Trigger submit while request is in flight; observe button disabled/busy state and verify only a single mutation/record is created | UI state observation paired with backend/network count verification (`count === 1`) |
| **5. Failure/timeout, empty & loading recovery** | Async data views, forms with server validation or flaky/slow upstream endpoints | Blank screen on empty dataset, stuck spinner on timeout/500 error or lost user form input after a failed save | Observe initial empty state and simulated error/timeout response; verify actionable error banner, preserved form draft and recoverable retry state | Screenshot/DOM observation of error/empty state and preserved input values |
| **6. Brownfield UI parity & layout integrity** | Refactoring existing screens, shared components or responsive layouts | Existing fields disappear, default selection changes or controls overflow/overlap on narrow viewports (`375 px`) | Compare rendered fields, default states and navigation against baseline; never use `force: true` to click a covered or off-screen button | Before/after field comparison and viewport observation without forced actions |
| **7. Real served entrypoint & cross-screen flow** | Multi-step wizards, master-detail views or route registration changes | Component renders in isolation while real application URL/router fails to mount or upstream creation does not appear in downstream list | Navigate from the real entry URL through the action (`data-testid` / ARIA role) to the downstream screen and verify persisted record visibility | End-to-end navigation trace and artifact proposal with lease/revision metadata |

## 3. Locator and waiting discipline

1. **Locator priority:** Prefer `[data-testid="..."]` → semantic ARIA role (`getByRole`) → associated label/placeholder. Avoid brittle structural CSS/XPath chains.
2. **Condition-based waiting:** Wait on observable UI conditions (`toBeVisible`, `waitForSelector`, URL transition), never fixed wall-clock sleeps (`setTimeout` / `sleep`).
3. **No forced clicks:** Never bypass actionability checks with `force: true`; if a control is covered or clipped, report the layout defect.
