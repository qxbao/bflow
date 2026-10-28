# W06 — Vietnamese local read UI

Source implementation complete within the available frozen read interfaces.
Known contract/runner limitations below remain open; this is not full live web
workflow acceptance, a green monorepo affected gate, or remote closure.

## Baseline, branch and commits

Baseline: `c2b4586f1f8d5505dd792dd7402f900561ec5deb` (main and origin/main at
selection, clean working tree/index). Branch `agent/web/w06`; worktree
`.worktrees/local-web-w06`, retained.
Source commit: `8c6719084058ad31e3d6931297b06a59299e046d`.
This handoff is a following documentation-only commit.

Read filesystem AGENTS.md, W06 plan, full spec, DESIGN.md, ADR0006/0007,
W00 handoff, Runtime W01 HANDOFF/W05 handoff, Local Server W05 handoff,
CLI W04 historical and integration handoffs, and relevant package manifests.
Resolved/read the actual installed ui-ux-pro-max SKILL.md, then executed its
search script. DESIGN is populated, so no missing-input visual deferral.

Inspected HEAD/status/index/worktrees/local+remote refs, ancestry and patch
equivalence. Baseline retains W00 `2bd99d8`, W01 `114de68`, W04 `cd351c3`,
W05 source `e5f45fd` and its handoff descendants. Main/origin had no divergence;
`git cherry HEAD agent/cli/w04` initially returned no missing patches.
The existing W04 worktree/branch disappeared externally during implementation;
this agent did not remove or change it. Final main/origin still name the baseline.
No reset to the survey SHA, fetch, branch switch in another worktree, merge,
push or PR. Other people's uncommitted work was not adopted or changed.

## Paths / interface changes

Only `apps/web/**` changed: app/router/main, HTTP/SSE adapters, shell/status/
review/evidence/error components, project/run/review/settings features, CSS tokens,
locally served licensed fonts, package README, dedicated tests/browser config.
No manifest/dependency/lockfile/root/contracts/shared docs/DESIGN change.
No public schema, port, receipt, checkpoint, event codec, migration or new
integration decision. Node asset resolver and frozen package scripts unchanged.
Built CLI executable path in browser tests is spawned as data, never imported
from sibling dist. Production browser imports only `@bflow/contracts/web`.
No dist, screenshots, private state, credentials, logs or databases committed.

## Behavior / compatibility / recovery

- Registry lists/registers existing local Git paths; native select switches
  project, URL routes preserve deep links/search/phase/cursor state.
- Overview reads real session readiness, intakes, a recent run page, decisions
  and preview. Run detail separates SDLC phase, Core state and observed terminal
  states; `done`/`unknown` never imply completed. Browser connectivity is separate.
- Historical run keeps its own identity and links to current continuation.
  Decision cards retain revision/status/expiry and read safe evidence. No raw
  JSON/tool names or machine disabled-reason codes are required in main flow.
- Bootstrap secret is erased synchronously before rendering/network work;
  reload recovers session+CSRF via cookie GET, CSRF exists only in memory.
  Frozen response schemas parse HTTP/SSE boundaries, same-origin credentials,
  no-store, expiry/unmount and CSRF headers remain enabled.
- SSE reconnects with bounded backoff and last validated cursor. Reset reloads
  projections; read invalidations coalesce while requests are in flight.
  Snapshot failures retain an explicitly stale view until successful reread;
  offline has a distinct banner. Cleanup closes streams/timers.
- Artifact inline text requires server inline/text/plain and a 1 MiB cap;
  React text nodes render it. Active/binary/large content downloads only.
- Registry registration and read-only inspect are the only POSTs offered.
  Workflow mutations/lifecycle start-stop and chat remain W07/W08. No traditional
  business mutation CLI, fake physical hook, host/Herdr token, lease/fence/gate/
  bounded-verification/test-integrity bypass. No uncertain operation is resent.

Design follows ivory/square/flat/hairline conventions, four actual local font
families, semantic tokens, 18px body/32px detail and responsive display headings,
light-only layout. Applied skill guidance: semantic landmarks, native controls,
visible labels/focus/errors, contextual status announcements, route focus,
44px controls, safe text wrapping, reduced motion. Narrowed an off-topic initial
marketing-pattern search to document workflow product guidance; did not adopt
sales/cloud/accounts/navigation suggestions or override DESIGN colors/fonts.
Contrast calculation on background #fafaf7: ink 16.64, mute 8.73, accent 8.19,
steel 7.57, warning 8.12. Browser screenshots inspected at desktop/tablet widths;
no owner visual approval or full WCAG certification is fabricated.

## TDD / independent review

Applied supplied W00 policy: recommended for DTO/UI, required test-first for
security/isolation behavior; CSS/docs verified by build/browser/design checks.
No synthetic domain TddDecision/approval receipt created. Initial new tests
preceded adapters; the first run also had missing built-contract setup and is
not presented as a meaningful security RED. Later concrete reproductions:

- Wrong-identity but schema-valid run: promise wrongly resolved, then client
  identity guard made the test pass.
- Review Important 1: SSE reset plus failed GET left old snapshot unlabelled;
  stale-label regression RED, then explicit retained-snapshot freshness GREEN.
- Review Important 2: a pending read invalidated twice discarded its result;
  deferred-read regression RED, then coalesced single-flight reads GREEN.
- Review Important 3: closed SSE never reopened; retry/cursor/unmount regression
  RED, then bounded recreation GREEN. Actual browser also observes >=2 real
  /events HTTP requests after the missing-host response.
- Review Important 4: valid waiting/queued/retrying states became unknown;
  schema-enum label coverage RED, then complete labels GREEN.

One independent whole-diff read-only review; all four Important findings fixed
in one pass with reproducing tests. No second independent fix review claimed.
Minor observations (font loading, inspect retry, inbox heading hierarchy) were
resolved in the delivered source. No deferred review finding or waived Important.

## Actual validation

Platform: Linux, Node v24.16.0, pnpm12.5.1; Node22/macOS/Windows not executed.
Final executable source matches `8c6719084058ad31e3d6931297b06a59299e046d`.
Only font-license line endings/trailing spaces were normalized after the final
browser/unit runs; executable code/assets/tests unchanged. Handoff follows.

| Command | Actual result |
| --- | --- |
| `pnpm install --offline --frozen-lockfile` | exit0; lockfile unchanged |
| `pnpm run build` | exit0; root tsc + frontend production assets; before CLI/browser subprocess tests |
| `pnpm --filter @bflow/web build` | exit0 |
| `pnpm typecheck` | exit0; root + frontend/resolver |
| `pnpm --filter @bflow/web typecheck` | exit0 |
| `pnpm check:deps` | exit0; 24 packages, 54 internal edges, acyclic |
| `pnpm --filter @bflow/web test` | exit0; 6 files, 21 passed, zero failures/skips |
| `BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web test:e2e` | exit0; 1 actual browser smoke passed, zero failures/skips |
| `pnpm test:affected --base c2b4586f1f8d5505dd792dd7402f900561ec5deb` | exit0; package apps/web fallback, GitNexus commit_mismatch, 8 selected input paths (includes helper and Playwright spec), zero root-E2E input paths |
| Same `test:affected ... --run` | **exit1, NOT PASS**; build passes, root Vitest finds zero matching files because its include excludes .test.tsx; it also cannot run the Playwright spec. No failing assertion filtered or weakened |
| `git diff --cached --check` | exit0 after normalizing whitespace in downloaded license notices |

The affected selection's entire intended web unit/browser coverage was executed
through the dedicated scripts above. Root config/dispatcher ownership prevents
fixing the selection executor here. No monorepo full test suite claimed or needed
by package scope; this is not a silent successful affected-gate substitution.

Browser smoke uses actual built CLI/Local Server with an isolated BFLOW_HOME,
real temporary Git repository, actual cookie/CSRF HTTP registration and missing
host state, real SSE retries, deep-link reload, 1440/1280/768/375 no horizontal
overflow, keyboard focus, reduced motion and actual local font loading. No provider
or Herdr host launched. Component fixtures are synthetic test-only data, never a
production fallback. Evidence: source + local component + actual localhost HTTP/
browser smoke, not live provider/Herdr/full SDLC acceptance.

## Unresolved findings / exact proposals / next task

1. **Notice content:** WebEventSchema only carries IDs; WebHttpContracts and
   UserInteractionClient expose no bounded notice read DTO/method. W06 cannot
   render arbitrary notice content or acknowledge actual display. No displayed
   POST on receipt. Integrator needs an approved additive safe notice read
   interface; preserve exact display/approval separation.
2. **Additional read surfaces:** WebRunView has no standalone plan/diff/change-set
   catalog, full timeline or pane-output data. Existing decision evidence works;
   the UI states absent history/diagnostics instead of inventing them. Additional
   surfaces require owner-provided read contracts, not sibling Runtime access.
3. **Decision aggregate:** inherited W01 frozen listDecisions lacks pagination
   input beyond its cap. UI offers per-work views on aggregate failure; integrator
   retains responsibility for the explicit bounded/paginated interface decision.
4. **Affected executor:** scripts/affected-tests.mjs invokes root Vitest even for
   apps/web .tsx/Playwright inputs. Proposed integration-owned fix: dispatch the
   web package's fixed Vitest and Playwright scripts with build first, preserving
   all other selected tests. No root/config edit in this task.

W07 can use the adapters/components but must add exact-version frozen commands,
operation observation and uncertain-delivery UX without inferring authority from
phase or stale data. W08 adds verified chat, W09 owns live browser/provider/Herdr/
fault acceptance. Predecessor P02-RA01/P03-RA01, systemd/native-fixture and loaded
full-suite findings remain with their owners; not resolved by this UI.

Checklist: W06 steps1–3 implemented; step4 dedicated scripts/browser pass, shared
affected executor remains an explicit integration gap; step5 layouts/focus/tokens/
reduced motion verified locally, source commit and scoped handoff delivered.
Keep branch/worktree for integration. No push, PR or local/remote merge.
