# Web project lifecycle and configuration

Owner request (2026-10-29): manage init, GitNexus recovery, unregister and config.yml from web; verify using a real browser and clone with inexpensive models. Owner approved forms plus full YAML and additive, backward-compatible public web APIs in this session.

Integration decision WEB-INIT-01: add web v1 configuration read/save and asynchronous initialization endpoints. Affected owners: contracts, CLI composition, local-server and web. Existing HTTP shapes and runtime signatures remain unchanged; new workspace methods are optional. Old services return operation_not_allowed for new endpoints, so no migration is required. Approving owner: project owner, explicit conversation approval on 2026-10-29.

Implementation plan (inline execution):
- [x] Add strict ingress schemas and tests for initialization/configuration, preserving existing API fixtures.
- [x] Compose existing environment init and GitNexus preparation behind registered project identity; durable initialization receipts, no automatic replay; atomic validated configuration saves with revision conflicts and lifecycle locking.
- [x] Add authenticated routes and unregister UI; keep CSRF, project validation and unresolved operation guards.
- [x] Add init/license/progress controls and major configuration groups plus full YAML; errors and restart guidance visible in Vietnamese.
- [x] Run affected checks, browser tests and a real clone/provider probe; fix findings and record actual evidence and limitations.

Acceptance: initialization creates config and registers/indexes the selected repo; refresh repairs missing Gateway registration without overwriting role choices; configuration round-trips unknown untouched values/comments when possible, rejects invalid settings and stale revisions; unregister removes only web registration and refuses unresolved effects; init jobs are observable after a reload, duplicate IDs never resend effects. No changes to machine-wide setup or provider credentials via these controls. Live workflow acceptance is reported separately from synthetic tests.

Verification strategy: regression tests for settings writes, job replay/restart, CSRF and 204 handling; UI interaction tests; production browser checks against a cloned sample Git repo. Use the configured low-cost model after checking local provider availability.

Live-discovered additions: optional reviewed configuration commit in initialization, limited to `.bflow/config.yml` and `.bflow/.gitignore`; it pins both file contents, refuses unrelated staged work and executable clean/process filters, and follows GitIntegrationEngine's no-hook/fsmonitor/signing execution policy. This is repository administration, never an application implementation commit or remote push. Commit before admitting workflow requests so execution plans pin the correct HEAD.

The live probe also reproduced Runtime hiding a pending design approval after Coordinator `report_progress(questions)`. The private fix preserves its waiting phase and restores affected pre-Core design gates at initialization, with no decision creation or message replay. Regression tests cover pending and settled/nonpending/terminal/cancelled approvals. Source changes do not claim broader Conversation clarification persistence is implemented.

A second live finding was that persisted controller reopening validated old
execution sources before connecting, preventing even orderly stop after a config
commit. Recovery now connects to the authenticated live endpoint without granting
execution; source validation stays mandatory for new owner startup. Explicit
startup refreshes only the inactive host's source snapshot, retaining accepted
run-level plans and all their drift guards.

## Verification evidence (2026-10-29, baseline fc242c7 + working diff)

- `pnpm build`, `pnpm typecheck`, `pnpm check:deps`, `git diff --check`: passed.
- Focused CLI/local-server/contracts regression selection: 295 tests passed before live-only Runtime fixes. New settings/API tests: final 22 tests passed (configuration revisions, clone update, same-ID receipts/restart, validation, symlinks, CSRF, administrative Git commit, unrelated index preservation, filter rejection).
- Web UI: 59 tests passed. Browser fixture suite: 9 passed, 1 opt-in live test skipped; real-production-CLI case includes initialization, settings save, reviewed config commit, invalid YAML preservation and unregister.
- Runtime progress/approval/stuck-state/views checks after live fix: 82 tests passed. Runtime interaction/authority/recovery group: 185 tests passed. Host recovery and execution-source binding: 13 tests passed (TMPDIR=/tmp avoids the baseline test's intentionally local socket length limitation).
- Broad affected run widened to package because the isolated GitNexus index did not match HEAD: 1350 passed, 31 failed, 8 skipped. On untouched main, 27 failures reproduced across hooks/Agy/isolator/control fixtures. The other 4 failures (including overload timeouts) passed in focused reruns: 23 tests in the three affected files plus the environment suite within the 295-test selection. This is not an all-green full-suite claim.

## Real browser/provider probe

Evidence directory outside Git:
`/home/baodq/.local/share/ai-isolator/profiles/codex--personal/tmp/bflow-web-projects-live-tlvyo326`.

The first repo is a real Git clone of the repository's sample-shop fixture. Chrome
used production assets, real HTTP/CSRF, existing machine setup/Gateway, Herdr and
Claude roles configured through the form to model alias `haiku`, effort `low`.
Verified: registration, init/config creation, actual GitNexus index and live Gateway
registration, all eight role model saves, invalid YAML preserving disk state,
390px no-overflow layout, config commit, ready host, request admission, generation
and safe viewing of a spec artifact, reviewed design approval, real core run,
explicit user-decision reply, cancellation and orderly session stop/restart.

Live-discovered issues were fixed with regression evidence: init POST/poll race,
missing receipt recovery, approval hidden by progress questions, source drift
blocking orderly stop, and inactive source-snapshot refresh. The first workflow
was cancelled explicitly after changing HEAD from its original plan baseline;
no Developer success or full SDLC completion is inferred from it. Native chat
reports unavailable; direct controls remain usable.

Final additional verification: P30 host source/local suite 34 tests passed; live-owner
recovery/startup source-refresh plus execution-binding 13 tests passed; approval
negative-boundary regressions included in 82 passing runtime tests.

A second real clone `/tmp/bflow-web-final-clone` was registered from the browser,
its cloned config identity updated without losing haiku/low role selections, and
configuration committed as `0319db0` before starting its host. Actual GitNexus
index/registration, activated health and Coordinator admission were verified.
Full workflow completion remains separately observed and must not be inferred
from any of the administrative checks above.

The fresh-clone live run found a supervised Developer launch failure: account
`.zshrc` prepended another Claude binary ahead of the scope shim. A new regression
observed the unsupervised fake provider before the fix and the authenticated
namespace witness after it. Developer process scopes now supply private zsh
startup files; all 10 namespace/PTY/process-scope tests passed. Supervision and
execution-readiness requirements are retained; no global shell/provider settings
were modified.

Canonical provider entry correction: the supervised process previously executed
the resolved versioned path (`.../versions/2.1.312`), preventing Herdr canonical
Claude detection. New process scopes expose a private canonical-name link to the
same digest-pinned target and verify the link before exec. Regression changed
from `entry:2.1.312` to `entry:codex`; all 11 scope tests passed.

The real stop found an orphan startup pane/worktree-group closure limitation. Web
now offers an explicit recovery-stop confirmation, forwarding optional force to
the existing EnvironmentLifecycle down implementation under its quiesce/checkpoint
barriers, with a separate intent from regular stop. No worktree/data removal or
direct process-kill substitute was introduced. Confirmed real recovery stop passed.

Final UI added a separately confirmed recovery-stop intent. Local API/CLI
regressions: 26 passed; web UI: 60 passed. Canonical entry-name supervision
regression: 11 passed. The live probe also exercised the existing plan-drift
gate when the documentation service's readiness (Context7 at the time, since replaced by DeepWiki) changed the resolved skill list across restart.
No plan check was weakened: the un-dispatched run was cancelled through web,
the optional documentation service (formerly Context7, now DeepWiki) was disabled through the form, config committed (`5d425a1`),
and the project restarted before admitting a new test run.

A subsequent live run revealed a Core recovery collision: two generated workflows
reused `wf-bug-001-discount@1.0.0` with different task IDs. The catalogue's latest
definition was incorrectly used for the earlier run's checkpoint, preventing new
scheduling. Core recovery now prefers its run-bound validated definition while
retaining task/checkpoint integrity checks. The regression failed before the fix;
all 40 Core tests passed afterwards. The corrupted live host/state was retained
for evidence; the final fresh probe uses `/tmp/bflow-web-verified`.

The final verified-clone run (`run-web-ab13871c-7d64-41bd-9c51-02b19d2afc49`)
used Claude `haiku`/`low` throughout. Browser-reviewed design approval was followed
by authenticated Developer dispatch with a native/session process-scope witness.
Runtime accepted independent Red, Green and Refactor phase outcomes and task-level
verification passed in iteration 1. Full workflow outcome is recorded below once
settled; these intermediate results do not alone establish completion.

## Final live outcome

At `2026-10-29T09:40:18Z`, the verified clone's run
`run-web-ab13871c-7d64-41bd-9c51-02b19d2afc49` reached business `completed`, Core
`succeeded`, and its task `succeeded`, after browser review and approval of the
exact delivery bundle. Task and workflow verification each passed in iteration 1.
The integrated revision is `79e9805e4997a862d730600566d138900216b758` on the
Runtime-managed integration branch; the probe did not push or merge the clone's
master branch. Independent unit evidence records 6/6 tests; affected regression
records 7/7 (including the repro test). Reviewer/QA accepted the exact integrated
head, and test-integrity reported no findings. All eight role selections remained
Claude `haiku` / effort `low`.

Evidence outside Git: `verified-final.json`, `workflow-completed.png`,
`verified-spec.json`, `verified-workflow.jsonl`, and `delivery/` under the evidence
directory above. The patch was downloaded with the browser's download control
because `text/x-patch` intentionally stays download-only; JSON reports were read
through the UI's inert previews. No application/source patch was applied by the
operator to make the probe pass.

Cleanup: the completed verified probe was stopped through the web recovery-stop
control; operation `c50f4d06-61c5-4073-bffd-daaa712a8e72` is applied. Earlier failed
probe state is preserved. Reopening the old platform host after a crash still
refused adoption with `Required platform role conversation has no prepared launch
in this host process`; no launch proof, decision or checkpoint was fabricated to
clear that refusal. This is a retained fault-recovery limitation, not a failure of
the completed run or a claim of comprehensive live fault acceptance.

The final full fixture-browser rerun under concurrent live load had 7 passed,
2 timeout failures in existing chat/recovery scenarios and 1 opt-in skip; the
extended real CLI/settings browser scenario passed with its longer bounded test
budget. Targeted rerun outcomes are appended below. Earlier clean fixture runs
are recorded above; this report does not claim a uniformly green full suite.

Final recovery rerun after preserving cancellation-confirmation access during a
background refresh: the response-loss/server-restart case and SSE recovery passed;
the two-tab display timing assertion failed in that rerun (it passed earlier).
The business first-effect guard remained in place. The read-only confirmation can
open from a retained snapshot only during background loading; submission remains
disabled until fresh and revalidates the exact action/version. All 61 web unit tests
passed, including the new guard regression. The extended administration browser
case passed again. Whole-suite fixture timing is not represented as uniformly green.

After completion, the verified probe session's checkpointed stop and confirmed
unregister both succeeded through the production web UI. Repo/config/history and
Runtime-managed integration branches were retained. No remote Git operation ran.
