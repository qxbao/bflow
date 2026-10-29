# W08 — partial history UI; M2 incomplete

W08 is **PARTIAL**, not accepted or complete. The independent read-only history
panel and capability-unavailable browser path are implemented. No chat transport,
trusted web-message admission, normalized provider transcript adapter, correlated
native echo or delivery reconciliation was implemented. Send stays disabled.
No simulated scenario is described as live, and no W09 acceptance is claimed.

## Baseline, scope and isolation

Baseline: `4d3b18d980ce9989ce06a59bfde0b76e243ef3fa`.
Branch: `agent/web/w08`.
Native managed worktree:
`/home/baodq/.local/share/ai-isolator/profiles/codex--personal/home/.codex/worktrees/3414/AI-flow-SDLC`.
Source commit is recorded below after verification; a handoff-only commit follows.

Read filesystem AGENTS.md, plan W08/global constraints, spec, DESIGN, W00 freeze,
Runtime/Conversation W02, CLI W04 and integration handoff, Runtime/Server W05 and
Web W06/W07 handoffs. Inspected HEAD, index/status, worktrees and local/remote
refs before selection. Main and origin/main matched the baseline; initial tree
and index were clean. Ancestry checks retain W00 `2bd99d8`, W02 `3aa2943`, W04
`e945dad`, W05 `e5f45fd` and W07 `0d0d622`; git cherry against agent/web/w07
reported no missing patches. Main/origin remained unchanged at final inspection.
No reset to survey 7b158c4, fetch, branch switch in someone else's worktree,
shared history rewrite, local merge, push, PR or remote merge.

Only apps/web changes: features/chat/index.tsx and chat.css; test/chat.test.tsx;
e2e/chat.spec.ts; this handoff; two lines in features/runs.tsx to mount the panel
on the existing run/session context. The existing W07 browser host fixture is
reused unchanged through Node stdin in CLI's declared dependency scope.
No Runtime/Conversation/Herdr/Local Server, contracts/root configuration/lockfile,
shared docs, migration or generated output changes.

## Probe result and enablement blocker

Read-only discovery actually executed:

- `command -v herdr`, `herdr --version`: installed binary, Herdr 0.9.5.
- `herdr --help`, `herdr --skill`, session/api/agent/server help.
- `herdr api schema --json`: **bundled** protocol22/schema_version1.
- `test "${HERDR_ENV:-}" = 1`: **exit1**. This process is outside Herdr.

The installed binary's skill (`herdr --skill`) explicitly requires:
"Before issuing any control command, verify that this agent is running inside a
Herdr-managed pane" and "If the check fails, say that you are not running inside
Herdr and stop. Do not inspect or control the focused Herdr session from outside
Herdr." No HERDR_ENV value was fabricated. No active/default session was inspected
or controlled, no isolated live session/provider was launched, no credentials or
private host/Herdr tokens were read or copied. The prerequisite isolated live
probe therefore did **not** run. Its behavioral results remain unknown.

| Provider | Actual W08 capability evidence |
| --- | --- |
| Claude | No live probe; web/native correlation and normalized transcript source unverified; send not enabled |
| Codex | No live probe; web/native correlation and normalized transcript source unverified; send not enabled |
| Agy | Conversation remains unsupported under existing repository policy; specialist binding does not enable it |

Do not interpret installed provider binaries, bundled metadata, transport idle/done
or native-fixture tests below as provider capability or incompatibility evidence.
Continuing live work requires execution in a genuine Herdr-managed context under
the installed skill, or an explicit owner override of that skill restriction for
an isolated named session. Re-run actual protocol/behavior probes, not an exact
release allowlist. Never target or stop someone else's session.

## Behavior and compatibility

The panel requests the frozen session messages GET via ApiClient, authenticating
with the same cookie and parsing WebHttpContracts.messages.response. It renders
plain text, delivery labels, source and optional run links. No ANSI pane content,
HTML renderer, role tools, native hook simulation, generic key injection or
browser control endpoint is introduced. Session mismatches and duplicate stable
IDs reject the page; identical intentional messages with different IDs remain
visible. Requests leaving an old session cannot populate a replacement view.

History reload/pagination and SSE revision invalidation are observations only.
Unavailable history is an error, not an empty transcript. Retained history after
a read failure is labelled stale. Unknown delivery has no retry button. Neither
successful reads nor failed/accepted/queued delivery enables send. No message body,
secret or authority is persisted in browser storage. There is no new admission
or duplicate human input, and no nudge can authorize a decision through this panel.
Existing direct approval/clarification/resume/cancel retain W07 host authority.

The production Runtime still refuses listMessages/sendMessage as before. A future
normalized adapter can supply the frozen history read, but none is fabricated
here. No changed receipt/replay codec, native-v1 migration, lease/fence, independent
gate, test-integrity, unknown_delivery or verification-bound behavior is claimed.
No new power-loss, network-FS, multi-host or hostile-same-UID guarantee.

## Verification and review

Linux, Node24.16.0, pinned pnpm12.5.1, actual /usr/bin/google-chrome.
Accepted W00 policy retained: UI/DTO recommended; trust/replay/security required.
No trusted admission/delivery implementation was started. Six initial history UI
cases were observed failing against an empty component, then passing. An earlier
missing-module collection error is setup-only, not feature RED. Two more UI tests
cover distinct IDs/identical text and conflicting duplicate IDs.

Applied installed ui-ux-pro-max via actual script searches: UX loading/busy
feedback (narrowed after mobile haptics was off-topic), React async error handling.
Used existing DESIGN tokens, square borders, typography, focus and reduced-motion
rules. Browser checks 1440/1280/768 no horizontal overflow; screenshot inspected.
No owner visual approval or comprehensive accessibility certification asserted.

An independent read-only final review found no Important UI issue and independently
ran all eight chat tests successfully. It corrected an overstatement in the initial
assessment: missing public capability/retry DTO fields are not established contract
blockers. They are interface considerations, not permission to change schemas.

Commands and final measured results are appended below. All logs/screenshots,
bundled schema output and generated builds remain uncommitted. Package scope does
not prove full monorepo, live provider, transport or SDLC acceptance.

## Interface investigation for integrator and remaining checklist

These are **proposals/investigation**, not proven schema blockers or amendments:

- Existing W02 openUserInteractionClient `interaction.sign(command: WebCommand)`
  and WebInteractionReceiptSchema validate only structured WebCommand. A WebChatSend
  must not be cast to WebCommand or recorded as a fake native hook. Investigate a
  private scoped chat signing/admission receipt using exported schemas and existing
  issuer authority before proposing public changes. Same messageId/body must bind
  one host record before transport and one native echo with session/digest/dispatch
  identity, rejecting identical-text/time-only correlation.
- WebProjectSession has no provider/chat field. Existing inspection checks might
  suffice for capability reporting; lack of a dedicated public field alone does
  not block implementation. Derive capabilities from real probe evidence.
- WebChatMessage.delivery has no not_delivered value. Keep conclusive proof in
  durable internal delivery records if possible; the UI can leave retry unavailable.
  Do not infer resend permission from failed, timeout or unknown delivery.
- Choose a stable normalized transcript/native adapter only after real probe. Keep
  physical pane output diagnostic-only. Preserve final-turn IDs/provenance/order.
- Root affected executor still sends .tsx/Playwright selections to root Vitest.
  Integrator owns its dispatcher; retain web-specific execution and fix dispatcher
  separately rather than changing root configuration in this task.

W08 step1 incomplete (metadata only, live environment gate); steps2–3 incomplete;
step4 only independent history UI cases and unchanged native regression suites;
step5 build/native regressions executed; step6 history/delivery/unavailable UI only,
composer/send/recovery integration incomplete; step7 unavailable-browser path only,
no isolated live smoke for any provider. **M2 remains incomplete.**

Next W08 work must probe idle/busy delivery, real hook invocation and normalized
assistant messages, then implement correlation/restart/lost-ACK reconciliation and
trusted intake with required test-first security cases. Cover duplicate web/native
hooks, new native sessions, out-of-order events, multiple tabs, busy drafts, nudge
boundaries and a direct button decision while a real chat turn waits. Existing
native regression tests are not those new web/native acceptance cases. W09 remains
separate; inherited W06/W07 read-interface/affected findings and P02/P03 limitations
are not closed here.

## Final measured command results

Executable source tested before commit equals source commit
`7ec4287c3f08dc5f92aec9be8b6eebf3bba33e66` (the commit adds no extra source change).
The last copy-only change replaces technical adapter wording with plain Vietnamese;
web unit/build/chat-browser checks reran afterward. The earlier three-browser run
covers the same executable behavior before that copy change. This handoff-only
commit follows the source commit; neither suite has unreported skips/failures.

| Command | Actual result |
| --- | --- |
| `pnpm install --offline --frozen-lockfile` | exit0; no lockfile change |
| `pnpm run build` | exit0, root tsc and production Vite bundle; built before subprocess/browser tests |
| `pnpm check:deps` | exit0; 24 packages, 54 edges, acyclic |
| `pnpm typecheck` | exit0; root and frontend/resolver, final source |
| `pnpm --filter @bflow/web test` | exit0; 51 passed, 11 files, 0 failed/skipped |
| `TMPDIR=/tmp VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 pnpm exec vitest run packages/runtime/test/agentic/conversation-host-rpc.test.ts packages/runtime/test/agentic/conversation-intake.test.ts packages/runtime/test/agentic/conversation-idle-wake.test.ts` | exit0; 44 passed, 3 files, 0 failed/skipped; actual host IPC with synthetic Herdr/native fixtures, no real provider |
| `BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web exec playwright test e2e/chat.spec.ts e2e/direct-actions.spec.ts e2e/build.spec.ts` | exit0; 3 passed, 0 failed/skipped |
| `BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web exec playwright test e2e/chat.spec.ts` | exit0; 1 passed, 0 failed/skipped after final copy change/build |
| `pnpm test:affected --base 4d3b18d980ce9989ce06a59bfde0b76e243ef3fa` | exit0 selection; package apps/web, commit_mismatch fallback, 15 unit input paths including helper/Playwright specs, 0 root-E2E inputs |
| `pnpm test:affected --base 4d3b18d980ce9989ce06a59bfde0b76e243ef3fa --run` | **exit1, NOT PASS**; final source; build succeeds, root Vitest finds no matching .tsx/Playwright tests; 0 tests executed by that executor |
| `git diff --check` / `git diff --cached --check` | exit0 |

The separate web Vitest and Playwright commands run the intended selected tests;
they do not turn the failed affected gate green. No root dispatcher/config change,
full-suite PASS, live Herdr/provider probe or full SDLC acceptance is claimed.
Browser uses real Chrome, built assets, authenticated Local Server HTTP/SSE and
W07's injected deterministic host fixture. In the new scenario chat remains
unavailable across reload/history refresh while clarification -> direct approval
-> resumable work succeeds; no POST to messages occurs. This is not a live chat
or web/native coexistence acceptance scenario.

Evidence level: source + local component/native-fixture/HTTP/browser integration.
No pending independent UI review finding; full W08 transport/recovery/provider
work remains as enumerated above. Keep the worktree/branch for the next W08 owner
and integration review; no external publication or merge performed.
