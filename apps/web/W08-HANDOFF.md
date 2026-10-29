# W08 — optional chat, same Conversation authority

Status: implementation delivered; source/local/browser and scoped live-adapter
evidence below. No single-batch green affected/integration or full SDLC acceptance
is claimed. Every failed file from the measured affected run was subsequently
rerun on the final source and passed without timeout/assertion weakening.

This supersedes the earlier partial handoff committed at 5806a29. The initial
history-only source remains in 7ec4287; the resumed implementation adds the
real transport adapter, trusted echo admission, normalized history, recovery,
composer and authorized HTTP wiring described below. No remote publication.

## Baseline, scope and authorization

Baseline `4d3b18d980ce9989ce06a59bfde0b76e243ef3fa`.
Branch `agent/web/w08`, native managed worktree
`/home/baodq/.local/share/ai-isolator/profiles/codex--personal/home/.codex/worktrees/3414/AI-flow-SDLC`.
Main/origin/main matched the baseline with clean index/tree; all W00/W02/W04/W05/
W06/W07 predecessors were retained by ancestry and patch-equivalence inspection.
The resumed branch starts at the agent's own prior 5806a29, retaining the baseline.
No reset to 7b158c4, fetch, branch switch in another worktree, push, PR or merge.
Other worktrees and the main checkout are preserved.

Read actual AGENTS, plan/spec, DESIGN, W00 and Runtime/Conversation W02, CLI W04
including the integration handoff, Runtime/Server W05 and Web W06/W07 handoffs.
Applied executing-plans, conditional TDD, systematic debugging, verification and
installed ui-ux-pro-max; actual local UX loading/error and React async searches
were used. No external prototype or new visual system; reused W06/W07 shell,
components, tokens, typography, square flat borders and Vietnamese copy.

The user explicitly instructed completing the entire W08 and authorized isolated
Herdr probes despite the installed skill's outside-Herdr restriction. A subsequent
explicit approval, “Duyệt wiring và test Local Server cho W08”, permits the concrete
messages GET/POST route proposal and package-local HTTP tests. It does not authorize
public contract/root/lockfile changes, remote actions or widening permissions.
No public schema was changed. The initial claim that missing capability DTOs were
mandatory contract blockers was withdrawn; existing blocker codes and host-private
records suffice. Source commits and actual final verification follow below.

Owned changes are Runtime interaction/chat{,-delivery,-history}.ts and client;
affected host/controller/Conversation/receipt adapters; host-platform derives
transcript roots from already validated launch material. Web adds a composer to
the existing run-context history panel, package-local unit/browser fixtures and
small shell navigation copy. Authorized Local Server routes use frozen schemas.
Package READMEs and handoffs describe actual scope. No CLI source modification:
W04 already injects the authenticated dedicated web credential used by send/history.
No contracts, shared docs, root config, lockfile, generated dist/screenshots,
private state/logs, databases, credentials or provider configuration are committed.

## Actual isolated Herdr/provider probes

The earlier outside-Herdr refusal was not a compatibility finding. On resumption,
`herdr --session bflow-w08-3414 server` actually failed with Unix socket sun_path
length; a shorter new named session `w08` started successfully. Initial snapshot
had no workspaces/panes and reported live protocol22, server0.9.5. Metadata/help
and `herdr api schema --json` were also inspected. No exact-release allowlist.
Only the newly created session/panes were controlled; no default session used.

Installed providers: Claude Code2.1.312, Codex CLI0.165.0. The inherited Codex
isolator HOME initially made direct providers appear unauthenticated. Investigation
used auth-status commands without exposing credentials. Claude used a private
0700/0600 temporary native auth/config snapshot from the account's existing Claude
auth. Codex used the configured personal isolator profile through its existing LB.
No login was invented and no global permission bypass was enabled. Observation-only
hooks were real native command hooks attached to these probe launches, not Bflow
physical-hook simulations. Native UI reviewed only the exact local observer hook.

Actual Herdr prompts produced native UserPromptSubmit/Stop events and real provider
answers. Claude supplied prompt_id plus transcript UUID/sessionId; Codex supplied
turn_id, final assistant text, and rollout session metadata/ordinal. Normalized
assistant adapters use these stable source identities, not ANSI terminal output.
`agent.prompt --wait --until working` followed immediately by another prompt while
working succeeded for both providers; this demonstrates admission into a busy
provider, not that an ACK identifies a completed turn. Production queues until
observed idle/done and still requires exact hook correlation.

Manual `chat-live-smoke.mjs` was run for both providers against the real isolated
Herdr panes and genuine observer hooks. It executed production HostChat and normalized
transcript code, verified exact submit/Stop identity and final text, replayed the
same echo and counted one admission callback total. The admission callback in this
probe is an instrumented port, not a live full Runtime/SDLC workflow. Separate
local tests exercise the actual HostConversationIntake and host RPC with fixtures.
Keep these evidence levels distinct. Agy Conversation remains unsupported; native
specialist binding is not used to enable it. Other providers and platforms are not
claimed. Probe commands use no fake HERDR_ENV, native hook packet or startup proof.

## Transport, authority and recovery

Before dispatch, host-private 0700/0600 storage reserves exact messageId/body/
principal/run/Conversation session/native session/pane, random nonce, monotonic
queue sequence and original pending-approval context. Atomic rename plus file and
directory fsync precede transport. The Herdr wire is a reserved marker containing
messageId and nonce followed by original content; it is not a second user ledger.

Queued messages dispatch FIFO only to their original currently validated native
occupant. A busy draft remains queued. Delivery has intent-before-effect and
accepted/unknown/delivered observations. Lost ACK never authorizes another prompt.
Old unsent drafts after native replacement become internally not_delivered with
public failed status. Old uncertain dispatches remain unknown; they are never
resent or relabelled, and do not block a new native session's distinct intent.

Only a genuine role-authenticated Conversation UserPromptSubmit with exact wire,
pane and native session can correlate the pending record. Text/time alone cannot.
The echo receipt is saved before trusted intake. Admission carries the original
messageId/content/run/session and explicit private local_web source; it never
creates HumanHookProvenance or marks web input herdr_attach. Conversation receives
one durable turn and uses its existing parse/decision/admission paths. Repeated
hooks reuse that turn/result. A crash after intake persistence can settle from the
exact trusted turn receipt without another admission. A real observed echo can
resume its interrupted idempotent intake; this replays recorded evidence, never a
fabricated provider hook. Raw role envelopes and the reserved Runtime nudge cannot
become web human input. No unknown delivery is automatically replayed.

Chat's existing natural-language approval path gets a separate private web-chat
receipt, only while admitting the exact correlated web turn. Original approval
IDs/target/revision/generation/evidence context must still match current pending
context. A direct button response or a newer approval generation invalidates the
old chat authority. Runtime's independent decision gates still decide the result;
recorded authority is not success. Direct structured actions never wait for chat
model interpretation. Leases/fencing, verification bounds, test integrity, cancellation
and unknown-delivery policies remain in their existing owners and implementations.

Role credentials cannot call web send/history; the owner-created dedicated web
credential supplies host-local principal authority. HTTP validates cookie/CSRF/
Origin/Host, frozen bodies and path/body project/session identity, parses port
results and rejects foreign responses. Private host/Herdr tokens never reach the
browser. The CLI composition is reused; no traditional mutation CLI is called.

Normalized history reads approved launch transcript roots, verifies Conversation
role and native-session registration, validates provider-native rows and excludes
reasoning/tool/system content. Assistant messages are stored as immutable private
receipts before Stop completes and on reads, preserving history across replacement.
A specialist's registry entry cannot become Conversation history. Native human
turns retain existing trusted receipts; web turns come from the chat journal, so
there is no duplicate web/native turn. No terminal snapshot supplies chat history.

Browser text is inert React text. Composer uses exact current run/session, body
schema and 16KiB UTF-8 cap, same cookie/CSRF and Web Locks. It persists only messageId
recovery metadata before POST, never text/tokens. Reload/new tabs and lost ACK
observe the same ID by paginated history. Missing history never proves not_delivered;
no retry button or automatic POST retry exists. Draft remains disabled while that
ID is unresolved. Successful history alone does not enable send: fresh ready session
and absence of chat_adapter_unavailable blocker are required; host rechecks again.
Provider/transcript unavailability leaves direct forms/buttons available.

## Compatibility and limits

Frozen HTTP apiVersion1, WebChatSend/WebChatMessage/UserInteractionClient and public
Runtime/RoleMessage/SessionManifest/event/checkpoint schemas remain unchanged.
Native receipts without the new optional private web source/run fields parse as
before. New private chat delivery and assistant receipt prefixes have no public
migration; older hosts do not implement chat or understand new web-turn fields.
No automatic downcast or rollback compatibility for newly written chat turns is
claimed. Preserve new receipts when upgrading/recovering; do not delete uncertain
records to unblock a resend. Old native/structured receipt paths are retained.

Normalized transcript reads are bounded at16MiB; final text over the frozen16KiB
message cap is omitted. Current adapter returns bounded recent source rows and
journals normalized messages it observes; it is not an unrestricted historical
provider export. Missing roots, malformed/foreign transcripts and unsupported
providers fail closed. A crash before any authentic echo/turn receipt remains
unknown, requiring external reconciliation; neither terminal idle nor identical
text can settle it. Same-UID hostile processes, network FS, power loss and multi-host
are outside verified guarantees. Existing P02-RA01/P03-RA01 remain open.

## TDD and independent review

Accepted W00 policy retained: required for trust/replay/isolation/security;
recommended for UI/DTO, alternative build/browser checks for CSS/docs. Tests
observed fail before the corresponding fixes include stale approval context,
FIFO under a fixed millisecond, stale unsent replacement starvation, lost ACK,
post-intake crash observation, raw role/nudge rejection and HTTP route absence.
Missing-module/function setup failures are not presented as conclusive behavioral
security RED. No synthetic TddDecision/approval receipt or skipped failing test.

One independent fresh review found four Important issues: timestamp/UUID queue
order, stale queued-session starvation, specialist transcript provenance and lost
assistant history after replacement. All were addressed in one scoped fix pass
with regressions. Follow-on author checks also separated chat-pump failures from
Runtime ticks and reconciled the post-intake receipt/ACK gap. No second independent
review of the fixes or approval of judgment quality is claimed.

The existing provider-hooks and conversation-notice-hooks tests now assert the additional conversation_chat_history
call and its exact pane/session before the original pending-decision/notice calls.
Assertions, timeout budgets and Agy behavior are retained. An intermediate overly
broad test replacement incorrectly changed the Agy expectation; it was restored.
Browser diagnostic failures under concurrent loaded runs are recorded below,
not hidden by retries, timeout increases or assertion removal.

## Final source and verification

Platform: Linux, Node24.16.0, pinned pnpm12.5.1, actual /usr/bin/google-chrome.
Other operating systems/Node22 were not executed. Final executable source is `fa4153c2a635438ddb577a500bb8fd3d03d342c1`.
Commits: `7ec4287` initial history UI, `5806a29` historical partial handoff;
`44efada22dc0008547abe422a5319b694c5b0d18` resumed implementation;
`d054f56` exact native-notice call expectations;
`fa4153c` validated normalized-transcript capability check. This documentation-only
handoff follows. Build/dependency/typecheck/whitespace checks pass on final source.
No tracked changes remain in the original main checkout. The W07 branch ref was
removed externally during the session; pinned W07/baseline ancestry remains verified.
This agent did not remove that ref or worktree.

Measured commands already completed on the final implementation or its explicitly
noted predecessor (no source/test assertion weakening or timeout changes):

- `pnpm install --offline --frozen-lockfile`: exit0, lockfile unchanged.
- `pnpm run build`: exit0, root tsc plus Vite; rebuilt before subprocess tests,
  including after the Codex bootstrap transcript-registration fix.
- `pnpm check:deps`: exit0,24 packages/54 edges, acyclic.
- `pnpm typecheck`: exit0, root and frontend/resolver.
- `pnpm --filter @bflow/web test`: exit0,52 passed/11 files,0 failed/skipped.
- Initial targeted Runtime interaction + Local Server + conversation-host-rpc/
  intake/idle-wake: exit0,188 passed/29 files,0 failed/skipped, before final review
  fixes. Final-source targeted hooks/chat/native regressions follow below.
- Final chat + provider-hooks command:
  `TMPDIR=/tmp VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 pnpm exec vitest run packages/runtime/test/agentic/provider-hooks.test.ts packages/runtime/test/interaction/chat.test.ts packages/runtime/test/interaction/chat-recovery.test.ts packages/runtime/test/interaction/chat-history.test.ts packages/runtime/test/interaction/chat-native-coexistence.test.ts`:
  exit0,72 passed/5 files,0 failed/skipped. Includes all50 provider hook tests and22
  new chat tests; the two intentional old Stop expectations and Codex root regression
  are fixed without hiding Agy assertions.
- Targeted chat + host-rpc/intake/idle-wake + HTTP chat: exit0,67 passed/8 files,
  0 failed/skipped before the final bootstrap-only registration change; those unchanged
  native suites are included again in the final affected selection.
- `BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web exec playwright test e2e/chat-send.spec.ts e2e/chat.spec.ts e2e/direct-actions.spec.ts e2e/build.spec.ts`:
  final sequential run exit0,4 passed,0 failed/skipped,30.3s. Real Chrome/HTTP/SSE/
  cookie/CSRF/registry/production assets, with deterministic host/transport fixtures.
  Coverage includes lost chat ACK, queued draft, two tabs, reload, durable journal
  reopen, unknown preservation/no resend, exact echo settlement and direct approval
  while chat is queued. Separate live adapter probes are not conflated with this.
- `W08_PROVIDER=claude W08_SESSION=w08 W08_PANE=w1:p4 W08_HOOK_FILE=<private observer file> node packages/runtime/test/interaction/chat-live-smoke.mjs` and the same with
  `W08_PROVIDER=codex W08_PANE=w1:p2`: both exit0, real isolated transport/native
  hooks/normalized transcript, one admission callback and zero extra admissions
  for a duplicate echo. The final bootstrap field-forwarding fix has its own built
  hook subprocess regression; this probe does not launch a full Bflow host workflow.
- `git diff --check` and staged whitespace check: exit0.

Diagnostics retained: the first affected attempt detected the two new Stop-call
expectation failures; it was terminated once known obsolete, with no complete
suite count or PASS inferred. A separate intermediate Agy expectation was restored
after an overly broad test edit. Two browser cases failed in a concurrent run
(history alert not observed within5s; W07 cancel form not observed before90s).
A subsequent sequential run passed all four without production change, assertion
removal, retries or timeout changes. This establishes the final measured run,
not proof that all loaded-run flakiness is resolved. Initial unavailable-provider
welcome/auth screens were diagnostics, not successful chat evidence.

The final affected command uses the same baseline, complete package selection
and normal tests; inherited isolator selectors are removed only for established
native-fixture compatibility (W00/W03/W05 precedent), not to bypass permissions.
The first attempt used2 workers; the final attempt uses4 with the same timeout
budgets and test files. Root dispatcher still does not execute web .tsx/Playwright
inputs; dedicated web commands above cover them. No root dispatcher was edited.

## Checklist and integration notes

W08 Steps1–3 have real-provider probe evidence and implemented transport/correlation/
normalized adapters. Step4 has local required security/replay/FIFO/duplicate/native
coexistence/new-session/nudge/approval-race tests plus existing native regression
coverage. Step5 builds before actual host/subprocess tests. Step6 supplies composer,
history/delivery/reconnect/observation-only recovery and links to direct decisions on
the same session/run. Step7 has browser integration and isolated Claude/Codex adapter
smokes. No Agy Conversation or full live SDLC/fault acceptance is asserted.

Integrator should retain all receipt/journal files, use the approved descendant and
run the dedicated web test scripts alongside root selected tests. No manifest/root/
contract amendment is needed for this implementation. Current repository config
still selects Agy Conversation; this task does not rewrite the owner's provider
configuration. Such a session stays unsupported; configure a supported provider
through the existing owner-approved lifecycle before a real W08 host launch.

W09 still owns complete live browser-to-host-to-SDLC workflow/fault acceptance;
its absence does not upgrade fixture/local or scoped live-adapter evidence.
Existing W06/W07 notice/read-draft/affected-dispatch limitations, old baseline
loaded-suite findings and P02/P03 follow-ups retain their separate status/owners.
No new rollback/power-loss/network-FS/multi-host/hostile-same-UID guarantee.

Probe cleanup: stopped only the newly created named w08 session, removed private
observer/auth scratch, and removed only exact recognized test-owned profile trust
sections. Unrecognized or concurrently changed profile settings were preserved;
no persistent executable observer hook was installed. Keep the implementation
worktree/branch for integration review. No push, PR, local merge or remote merge.


## Completed affected result and final failure reconciliation

Full printed selection: package fallback for Runtime + Local Server + Web,
GitNexus unavailable (`commit_mismatch`),254 unit input paths including helpers
and web TSX/Playwright inputs,0 root-E2E inputs. This is not a full monorepo suite.
Exact completed command:

```sh
env -u AI_ISOLATOR -u AI_ISOLATOR_PROFILE -u AI_ISOLATOR_REAL_HOME \
  -u AI_ISOLATOR_TOOL -u AI_ISOLATOR_HOME TMPDIR=/tmp \
  VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 \
  VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 \
  pnpm test:affected --base 4d3b18d980ce9989ce06a59bfde0b76e243ef3fa --run
```

**Actual exit1, NOT PASS:**208 files passed/4 failed/3 skipped (215);
3024 tests passed/10 failed/79 skipped (3113),1056.34s. Existing conditional skips
retain their original evidence scope. No root-E2E/full workflow PASS is inferred.

The run started against the implementation tree at the earlier branch HEAD;
subsequent test-first fixes happened while it was running. It therefore includes
an intermediate missing-helper capability RED and old Stop expectations. It is
not presented as a clean final-source aggregate run. Its ten failures were:

- Seven exact call-list/index assertions in conversation-notice-hooks, which now
  include the real conversation_chat_history observation before the same original
  pending-decision/notice behavior. All semantic assertions remain.
- One capability regression raised while registeredChatAvailable was not yet
  implemented. The final host now validates the current normalized transcript
  before advertising capability; malformed/foreign/oversized/missing sources and
  unsupported adapters keep send unavailable. Its test passed after the fix.
- The unchanged P19 case “escalates the conflict after two resolver attempts end
  without an accepted resolution” and lifecycle case “reviewer rework with a
  Coordinator Stop in between still completes” timed out at their original30s
  budgets. No production fix, test timeout increase or assertion change to those
  two files was made.

P19 comparison: the same single selected case also timed out at30s in the original
main checkout at baseline `4d3b18d980ce9989ce06a59bfde0b76e243ef3fa` using its
existing built artifacts, with the same single-worker test command during the
loaded run. Baseline tracked files/index remained clean. This is a scoped baseline
comparison, not a new clean-build/full-suite baseline certification. An earlier
single-case run on W08 also timed out while the large suite was active. No claim
that the loaded-suite timeout's root cause was fixed is made.

After the affected run ended, this exact command reran **all four failed files**
on final source, without filters, skips, retries, weakened assertions or increased
timeout budgets:

```sh
TMPDIR=/tmp VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm exec vitest run \
  packages/runtime/test/agentic/conversation-notice-hooks.test.ts \
  packages/runtime/test/agentic/integration-p19-conflicts-reviews.test.ts \
  packages/runtime/test/agentic/lifecycle-fault-matrix-extended-interventions.test.ts \
  packages/runtime/test/interaction/chat-history.test.ts
```

**Exit0:54 passed/4 files,0 failed/skipped,110.97s.** Both30s cases pass in this
sequential final run. This clears every observed failure in scoped final checks;
it does not rewrite the earlier affected aggregate as PASS. Loaded-run reliability
remains a disclosed integration observation. The root web-dispatcher gap remains
with the integrator; dedicated web component/browser scripts were actually run.

Final chat-only command `pnpm exec vitest run packages/runtime/test/interaction/chat*.test.ts`:
exit0,23 passed/4 files,0 failed/skipped after the capability fix. The last fresh
`pnpm check:deps`, `pnpm typecheck`, build and whitespace checks also exit0. No
executable source changed after these final checks; only this handoff changes.

No remaining known W08 implementation/review fix is deferred. Integration should
retain the disclosed aggregate result, optional-provider/read-history limits and
W09 live workflow boundary. Shared README/implementation-status updates and root
affected-web dispatcher changes remain integrator proposals, not hidden changes
in this branch. No push, PR, local merge or remote merge.
