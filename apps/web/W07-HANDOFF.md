# W07 — local direct-action UX

Source/local integration handoff. No remote action or W09 live acceptance.

## Baseline and ownership

Baseline: `e9b0cf2e91f9f3fc9edbee40cf707d61cc5a4b12` (main and origin/main,
clean working tree/index at selection). Branch `agent/web/w07`, isolated
worktree `.worktrees/local-web-w07`. Implementation commit: `0d0d622625ec2d6a653c93b873eb513d15fed85e`.
The handoff-only commit follows it on this branch.
Filesystem AGENTS.md, W07 task/spec, full DESIGN.md, W00/W02/W06 predecessor
handoffs and installed ui-ux-pro-max SKILL.md were read. Skill queries:
`error summary validation --domain ux`, `destructive confirmation focus --domain ux`.
W06 visual tokens/components are retained; no prototype or external asset needed.

Verified HEAD/index/status, worktrees, local/remote refs, ancestry and patch
equivalence: baseline retains W00 `2bd99d8`, W01 `114de68`, W02 `3aa2943`,
W05 `e5f45fd` and W06 `8c67190`; main/origin had no divergent/equivalent missing
patches. No reset to survey `7b158c4`, fetch, switch in another worktree, shared
history rewrite, merge, push or PR. Other worktrees/uncommitted work preserved.

Only apps/web changes: new requests/clarifications/decisions/run-actions/operations
features, commands adapter, confirmation/status/stale components, package-local
unit/browser fixtures and docs. Owner explicitly allowed minimal W06 wiring in
apps/web; changes to app/runs/review and existing card/footer copy stay minimal.
No public schema/interface, contracts/root config/lockfile/shared docs/DESIGN,
Runtime/Conversation/Local Server source, migration or generated output changes.
The browser fixture launches Node in CLI's declared dependency scope and imports
@bflow/local-server by package specifier; no sibling module path load.

## Behavior and walkthrough

1. Overview: start existing session through the frozen lifecycle HTTP endpoint,
   then fill title/kind/objective, criteria with verification method and constraints.
2. Form admission is observed as an operation/intake, with no completion claim.
   Answer pre-run questions on Overview; run questions on detail use exact IDs/version.
3. Open review and explicitly select “Xem xét gói”. Version/evidence remain pinned;
   approve, reject or request changes. Rejection/changes require a reason.
   Only user_decision supports selectedOption; only approval of a user decision
   requires selection when options exist. Expired/superseded/stale review cannot decide.
4. changes_requested follows the operation's continued/currentRunId and parent
   lineage link. Parent evidence remains readable; historical parent cannot resume.
5. Blocked work exposes only host-offered actions, exact action ID and action-specific
   version. No action is invented from phase. Complete replacement requirements can
   be sent through revise_request while retaining the run context.
6. Cancel requires explicit confirmation/reason. Accepted/running/uncertain remain
   distinct from the authoritative cancelled run. Session stop is separately confirmed.
7. Reload/back/reconnect/re-pair reads the same operation ID. No uncertain POST retry;
   explicit new-intent reset is possible only after rereading applied/failed state.

Metadata contains only IDs/kind/fingerprint/scoping, never body/version/authority/
credentials. Draft requirements are session-storage scoped by project/host/browser
session. Web Locks serialize same project/action across tabs; unsupported browsers
fail closed for mutation. Old browser-session IDs remain observation-only recovery
candidates after HTTP server restart, subject to current server authentication.
Malformed local metadata blocks replacement; missing/failed observations stay uncertain.
No trusted receipt, physical hook or human approval is fabricated. Existing server/
Conversation/Runtime authority, lease/fence, bounds, gates, test integrity and
unknown_delivery are unchanged. Native receipt/replay compatibility is inherited.
No new power-loss/multi-host/network-FS/same-UID guarantee.

## Verification and review

Linux, Node v24.16.0, pnpm12.5.1, actual /usr/bin/google-chrome. Other platforms
and Node22 not executed. Accepted policy is recommended for UI/DTO and required
for replay/security regressions; no synthetic TddDecision receipt created.
Initial request UI test RED showed absent form (an earlier unbuilt-contract failure
was setup-only). Test-first regressions reproduced and fixed: IDs lost on re-pair,
invalid command reserving metadata, absent Web Locks allowing mutation and corrupt
metadata permitting replacement. Initial recovery fixture used an invalid method
name, corrected to exported integration_test; that setup failure is not feature RED.

One independent read-only review found two Important issues. Both reproduced RED
(3 failing cases), then fixed: run clarification had incorrectly required an action
Runtime never emits; ordinary approvals incorrectly forced/forwarded user option
fields. Added production-shape regression and removed the fixture's invented action.
No second independent fix review is claimed. Final commands/results recorded below.

Initially deferred Minor from review (resolved in the follow-up below):
OperationStatus showed a generic definitive-failure label
but does not translate operation.error into a specific remediation. No raw backend
error text is exposed; the user can inspect work state or begin a corrected intent.

## Actual checks

Executable source tested is the implementation commit named below; the final
handoff-only commit changes this document. No permanent suite-count or moving-ref
claim is used as a project guarantee.

| Command | Actual result |
| --- | --- |
| `pnpm install --offline --frozen-lockfile` | exit0; lockfile unchanged |
| `pnpm run build` | exit0; before subprocess/browser checks |
| `pnpm check:deps` | exit0; 24 packages, 54 edges, acyclic |
| `pnpm typecheck` | exit0; root, frontend and Node resolver |
| `pnpm --filter @bflow/web test` | exit0; 39 passed, 10 files, zero failed/skipped |
| `TMPDIR=/tmp VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 pnpm exec vitest run packages/runtime/test/interaction/commands.test.ts packages/conversation/test/structured-interaction.test.ts` | exit0; 47 passed, 2 files, zero failed/skipped; includes actual local Gateway/host command admission/recovery without model text turns |
| `BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web exec playwright test e2e/direct-actions.spec.ts e2e/build.spec.ts` | final sequential run exit0; 2 passed, zero failed/skipped |
| `pnpm test:affected --base e9b0cf2e91f9f3fc9edbee40cf707d61cc5a4b12 --run` | **exit1, NOT PASS**; package apps/web scope, 24 changed paths; GitNexus unavailable commit_mismatch; 13 selected input paths, 0 root-E2E paths; build passes, root Vitest finds no matching .tsx/Playwright tests |
| `git diff --check` / staged whitespace check | exit0 |

Dedicated web scripts execute all selected actual web unit and browser tests.
This is not a successful affected-runner substitution. Root config/dispatcher
remains integrator-owned. No full monorepo suite claimed for package scope.

Browser uses real Local Server, cookies/CSRF, Git registry, production assets,
SSE and durable server operation index with deterministic injected host state.
IPC assertions verify actual commands/effects/operation count outside DOM:
create is unique after double click/lost ACK/reload; intake and run clarification
both execute; two tabs produce one approval; exact revision2/action version is
used; cancel accepted leaves cancelled=false; HTTP server restart/re-pair keeps
original IDs/count; explicit confirmation later updates cancellation; revision3
changes_requested reaches follow-up; session stop/start calls occur once each.
1440/1280/768 browser overflow assertions and screenshots pass; W06 also covers
375px, focus and reduced motion. A screenshot was visually inspected. No owner
visual approval or comprehensive accessibility certification is asserted.

Diagnostic runs are not erased: one browser invocation accidentally followed a
failed typecheck/build and used an old bundle; later two-tab harness initially
navigated before an intake effect committed and closed the other tab before its
async submission could finish. Waits now assert committed host command state,
retain both tabs until observed effect, and use semantic fixture invalidations
instead of periodic fake changes. Another run overlapped affected's Vite rebuild
with browser requests, returning an actual static-page 503. The final two-test
run is sequential after a successful build; both tests pass without retries,
timeout increases, removed assertions or production bypasses. No production fix
or live guarantee is inferred from the harness corrections.

## Rulings, unresolved findings and integration proposals

- Keep source authority unchanged: run clarification uses the frozen question/
  version binding because HostStructuredCommands validates it directly and real
  availableActions never emits answer_clarification. Resume/revise/cancel/decision
  still require offered exact actions. Cost if the host changes that policy:
  update the adapter under the relevant contract decision, not a guessed action.
- Recovery transport/metadata is colocated in owned `src/api/commands.ts` rather
  than a deeply nested store. The initial dependency checker rejected a valid
  in-package ../../api/client path via its unconditional ../.. heuristic. No
  root checker/config change; the final shallower transport adapter passes the
  unchanged gate. Cost: a larger command-adapter module, with unchanged behavior.
- Observation-only metadata from previous browser sessions stays scoped to origin/
  project/session keys and is read with the current authenticated principal after
  re-pairing. Cost: unresolved old IDs remain visible/block their same action slot
  until conclusive reconciliation; no uncertain replacement is enabled.
- **Frozen read mismatch:** WebRunView exposes no original objective/acceptanceCriteria/
  constraints. W07 cannot prepopulate authoritative original requirements when
  revising. It explicitly offers full replacement with retained run context and
  warns that original criteria must be re-entered. Proposed integrator decision:
  bounded read-only current RequirementDraft projection/version, with compatibility
  plan, before claiming automatic criterion preservation/prepopulation. No schema
  extension or reconstructed authoritative draft was fabricated. This UX limitation
  remains open; the no-chat replacement command itself is implemented/tested.
- **Affected executor:** scripts/affected-tests.mjs feeds apps/web .test.tsx and
  Playwright specs to root Vitest whose include only accepts .test.ts. Proposed
  integrator fix: dispatch package web Vitest/Playwright scripts after build,
  preserving all other selected tests and truthful file/count reporting. No root
  change made. The inherited W06 runner gap remains a non-green handoff gate.
- **Resolved follow-up:** safe translated operation.error/remediation in OperationStatus
  is now implemented; see the follow-up checks below. No review finding remains deferred.

W07 checklist steps1–4 have source and local unit coverage; step5's dedicated
unit/browser/backend scenario passes while shared affected execution remains
explicitly NOT PASS; step6 source commit/walkthrough/handoff delivered locally.
No provider/Herdr is launched: evidence is source, local backend tests and actual
localhost HTTP/browser integration with host fixtures. W09 live/fault/full SDLC
acceptance, native-v1 compatibility acceptance and provider/platform guarantees
remain with their owners. Original W06 read-interface gaps, P02-RA01/P03-RA01 and
older systemd/native-fixture findings are not closed by this work.

W08 can reuse Commands/Operations, request/decision components and currentRunId
links; chat must keep the same real authority and supported-provider constraints.
W09/integrator must retain the runner and original-draft findings above and test
live Runtime/provider/Herdr separately. Keep the worktree/branch for integration.
No push, PR, local merge or remote merge performed.


## Owner-requested follow-up — resolve operation failure guidance

Based on handoff `79fad4f530a0c8cd5cbe1285bf58b703f559b82a`, in the same isolated
`agent/web/w07` worktree. Only OperationStatus, its package-local recovery tests, browser fixture
synchronization and this handoff change. No schema/authority/storage/transport change.

OperationStatus translates every frozen WebApiError code into a local Vietnamese
reason and next step: correct request fields, reread a stale review, re-pair an
expired browser session, check project/session readiness or resolve a conflicting
operation. It never renders backend message/details or arbitrary exception text.
For missing observations or reconciliation_required, recovery advice always says
to observe the original operation and forbids resending/new intent until conclusive;
input-correction guidance cannot accidentally authorize an uncertain retry.

Four regressions failed before implementation and pass afterward: workflow-input
correction, stale-review reread, uncertain-state advice and expired-session lookup.
They also check that synthetic private backend text is absent from the DOM.
The initially deferred Minor above is resolved; the affected-runner and original-
requirement-draft findings remain unchanged.

Follow-up measured checks:

- `pnpm --filter @bflow/web test`: exit0, 43 passed / 10 files, no failed/skipped.
- `pnpm check:deps`: exit0, existing 24 packages / 54 edges.
- `pnpm typecheck`: exit0, root and web.
- `pnpm test:affected --base 79fad4f530a0c8cd5cbe1285bf58b703f559b82a --run`:
  package apps/web fallback, GitNexus commit_mismatch; build passes; exit1 at
  unchanged root Vitest executor (no .tsx/Playwright tests discovered).
- Dedicated browser command and final whitespace/status result are recorded below.

Evidence remains local component and browser integration; no live Herdr/SDLC claim.

The follow-up browser run exposed a fixture race after server restart: it navigated
off the bootstrap page before authentication completed, leaving the next page
without its session cookie. The test now waits for the authenticated registered-
project link before navigating. Operation ID/count assertions and timeout budgets
are unchanged; no authentication or production check was bypassed.

Final follow-up browser command:
`BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web exec playwright test e2e/direct-actions.spec.ts e2e/build.spec.ts`
→ exit0, 2 passed, no failed/skipped after successful `pnpm --filter @bflow/web build`.
`git diff --check` and staged whitespace checks pass. Only the four owned web
files listed above changed; the local follow-up commit follows the W07 handoff.
No push, PR or merge. The unaffected two integration findings remain open.
