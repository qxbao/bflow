# W02 — trusted structured interaction, integrated owner handoff

This supersedes the foundation-only handoff at `9d563b9`. Conversation intake
was W02 work, not a missing predecessor; resumed execution finishes it through
its own owner/worktree. W02 source and local integration are implemented and
the final affected gate is PASS. This does not close W09 live acceptance.

## Baseline, ownership and commits

Original approved integration baseline: `607d101433d3559e6c9474e5023996babc815157`.
Continuation starts from foundation handoff `9d563b90f3ade8f213bc7a09edd2eb96ee109c97`.
Runtime branch/worktree: `agent/runtime/w02`, `.worktrees/local-web-w02`.
Conversation owner: `agent/conversation/w02`, `.worktrees/local-web-conversation-w02`.

Actual AGENTS.md, W02 plan/spec, accepted ADR0006 D-WEB-01 and W00/W01
handoffs were read. HEAD/index/status/worktrees/local and remote refs,
ancestry and patch equivalence were checked. Baseline retains W00 freeze
`2bd99d8`, W01 `114de68` and P24 `8dbb056`. Survey `7b158c4` was not used
to reset anything. Main started clean at the baseline and stayed untouched
during implementation. No uncommitted work in another worktree was changed.

Runtime source commits:

- `6da552daf5a92363576eb18f0576d5d8c713cf84`: authority/store foundation.
- `3748f2db76be0c80d9e7dd1eab4bf3388d01d076`: host/client/Conversation wiring,
  exact action validation and the first review fixes.
- `3aa2943cc5c0cfb99671962f84e98a20f72267e1`: observation of actual committed
  effects across outbox/Conversation result and Runtime effect/inbox gaps.

Conversation original commits → integrated patch-equivalent commits:

| Owner commit | Integrated commit | Change |
| --- | --- | --- |
| `d685a53` | `930cbca` | deterministic intake, durable private ledger, arbitration |
| `3ecdd2b` | `b2d424a` | cancellation boundary and clarification cleanup |
| `9e9b02b` | `34d3de9` | committed rejection observation |
| `1b2326e` | `30b7c9b` | owner handoff |
| `3829f96` | `6817570` | uncertain target reservation and error classification |
| `439e38d` | `33c986b` | review-fix evidence |

`git cherry HEAD agent/conversation/w02` marks all six as equivalent, not
missing. Local integration follows W02 step7. Production/test source is fixed
at `3aa2943`; only package documentation follows. The user subsequently
authorized main integration and remote push once verified, with affected
tests instead of a monorepo full suite. The final execution response reports
the verified remote head after push; local gate evidence alone is not remote closure.

Paths: only `packages/runtime/**` and owner-authored `packages/conversation/**`.
Runtime adds `src/interaction/{authority,operation-store,commands}.ts`, changes
its client/schemas/views, agentic host/controller/Conversation/runtime wiring,
index exports, README and package-local tests/handoff. Conversation adds its
structured Gateway entry and private optional snapshot ledger with local tests.
No contracts, root config, lockfile, shared README/AGENTS/docs, Local Server,
CLI or Web source change. No public schema amendment.

## Integrated interfaces and admission

Frozen `UserInteractionClient.execute/readOperation` now work with explicitly
trusted composition. Default client remains read-only and never starts a host.
`registerUserInteractionIssuer(options, registration)` uses existing owner-only
private IPC to register an Ed25519 key and host-local principal; returned
credential can only execute/read user interactions, not role or lifecycle calls.
Factory optional `interaction: {credential, sign(command)}` supplies the signer.
Proof includes full parsed command digest, scope, issuer/key/principal/browser
session, nonce and <=60-second lifetime. Live scope/signature/time is checked,
including again immediately before durable acceptance after receipt scanning.
Host restart requires registration again; no request-supplied trust root.

Conversation owner implements `handleStructuredInteraction(command, principal)`
and observation-only `readStructuredInteraction(commandId)`. Runtime composition
enables it through dedicated host callbacks and async-local accepted authority;
a parsed proof or model's authenticatedUser flag alone cannot admit anything.
Create/revise preserve explicit draft criteria/methods/constraints and use normal
delegation/outbox/Coordinator admission. No approved Specification is invented.
Both pre-run intakeId and existing-run questions use exact question/version
bindings; run-scoped projection reads the authoritative Conversation context.

Decision validation retains exact target/revision/generation/evidence/options,
expiry/supersession/terminal refusal and required reasons. Native and web share
host user serialization and Gateway settlement/reservations. Unresolved intent
reserves the same approval binding even against a NEW command ID; a new approval
generation remains usable. Web human milestones use v2 receipts and host-issued
identity/time, never UserPromptSubmit/PreInvocation or a fabricated PaneBinding.

Resume crosses Conversation's callback into existing `resumeBlockedRun` with
`webCommand`, rechecking the version under its journal transaction. Its outbox
uses `webCommandId`, never a made-up conversationUserMessageId. Existing lease,
capability, approval, manual/automatic budgets and Red continuation checks remain.
Cancel uses the existing Conversation cancellation request/Runtime controls;
request accepted is distinct from a confirmed process stop.

## Persistence and recovery

Host intent/nonce is durable before dispatch/ack; records are owner-private,
bounded, checksummed, context/filename validated and atomically published with
file/directory sync. Same project/principal/command ID/body replays the original
operation. Changed body conflicts. No TTL-based pruning permits ID reuse.
Temporary receipt cleanup on write/sync failure has a reproduced regression fix.

The separate v2 human marker binds the exact accepted decision before its outbox
effect. Historical authority does not depend on today's browser TTL; new submit
still needs live proof. Native-v1 envelope, filenames, checksums and provenance
are unchanged. All three W00 native fixtures replay through real journal APIs
with byte equality. Additive private Conversation snapshot state retains old
native snapshots; older strict readers reject structured ledger fields, so
downgrade with retained web state is unsupported. No SQL/domain-event migration.

Recovery observes committed Conversation results, exact original Runtime outbox
messages, applied inbox receipts or the exact Runtime-persisted decision effect.
The latter covers follow-up commit before inbox.applied. Original outbox identity
also survives later delegation revision and covers cancellation committed before
Conversation's final result write. No recovery path re-admits uncertain commands.
Unknown delivery remains in Runtime; observing local admission never claims
remote delivery or workflow success. Definitive refusals can settle failed.

Ruling: approval operations stay running until actual Runtime effect/lineage
evidence, rather than predicting a child from the accepted click. Cost: callers
must observe the same operation while normal transport proceeds.

Ruling: foreign project/principal lookup returns no record; wrong repository or
session in a found receipt is rejected. Cost: no foreign-record diagnostics are
exposed by lookup. Scope remains one exclusive host/local POSIX filesystem;
no multi-host/network-FS/power-loss/hostile same-UID guarantee is added.

## Verification and independent review

Platform: Linux, Node v24.16.0, pinned pnpm 12.5.1; Node22 was not executed.
Accepted TddDecision policy: required red-green for authority/replay/security;
no fabricated domain TddDecision/approval receipt. Build precedes subprocess
verification. No assertion/timeout/selection was weakened.

Final checks on source `3aa2943`:

- `pnpm run build`: PASS.
- `pnpm check:deps`: PASS, 24 packages / 52 edges, acyclic.
- `pnpm typecheck`: PASS, including frontend and Node resolver.
- `TMPDIR=/tmp VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 pnpm exec vitest run packages/runtime/test/interaction packages/conversation/test/structured-interaction.test.ts`:
  PASS **106/106**, 9 files. Includes actual host subprocess auth, actual local
  Runtime+Conversation/outbox fixtures, native-first/web-first, cancel race,
  exact stale/expired/options/reasons, run clarification and committed-effect
  crash windows. It does not simulate a native hook in production.
- Earlier native regression selection passed 150/150 in 13 files, before final
  observation fixes; final affected run also selects those native suites.
- Conversation owner's final affected package run: PASS 280/280, 11 files,
  including 24 structured cases; see its package-local W02 handoff.

Independent whole-W02 review found three Important groups, all reproduced RED
and fixed GREEN: unresolved cross-command approval reservation plus ambiguous
error classification; definitive decision rejection recovery; missing run-scoped
clarification projection. The author then added true commit-before-result crash
regressions for cancellation and follow-up decisions and a terminal/rejected
operation observation check. No remaining review finding is waived.

Historical foundation affected run had 2815 passed / 2 failed / 69 skipped;
the unchanged automatic-resume assertion and resolver timeout both passed in
isolated diagnostic runs. This is historical evidence, not the final gate.
The first resumed affected run (4 workers) was stopped with exit143 after
another required recovery window was found; it is not counted as PASS. Final
fixed-source affected gate is recorded below. User requested affected only;
no monorepo full suite is run for this completion.

## Final affected/integration gate

Command: `TMPDIR=/tmp VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 pnpm test:affected --base main --run`.
Selection: package fallback for unavailable/commit_mismatch GitNexus index,
Runtime + Conversation, 220 unit input paths including helpers, zero E2E;
unavailable index never skips tests. **PASS, exit0**: 198 files passed / 3 skipped
(201 total), **3133 tests passed / 70 skipped** (3203 total), 1011.65 seconds.
The opt-in/platform skips retain their existing scope and do not establish live
provider or unsupported-platform acceptance. No failed case was filtered out.
This complete final run includes the existing native Conversation/RPC,
cancellation, approval, verification and recovery suites on fixed source.

No unresolved W02 blocking finding remains after review fixes and this gate.
The earlier two loaded-suite observations were not reproduced in this final
two-worker run; no unrelated production repair or timeout change is claimed.
The foundation's deferred temporary-file cleanup issue is now fixed with
sync-failure RED→GREEN coverage. P02-RA01/P03-RA01 and W09 live acceptance
retain their separate owners/status and are not closed by W02.

## Downstream integration notes and evidence level

W03/W04 must keep issuer key/credential/private socket details in trusted server
composition and bind HTTP browser sessions/CSRF before signing. Its durable owner
index must pin original hostSessionId/principal/operation kind/fingerprint before
forwarding; never switch an old ID to a new host after down/up. A missing host
does not authorize re-execution. `readOperation` here is host_interaction only;
Local Server owns lifecycle operations.

W07 can use exact availableActions and retain the same command ID while pending
or uncertain. Create/clarification stays in Conversation, approvals need no chat
or model turn, and changes_requested returns the actual follow-up lineage after
effect. Cancel applied is not stopped, HTTP202 is not workflow completion.
W05/W08 events/artifacts/notices/chat remain separate, explicitly unsupported
client methods until their owning tasks implement them.

Evidence: source + local crypto/filesystem/private-socket tests and actual local
Runtime/Conversation integration with synthetic Herdr/provider fixtures. No
browser/HTTP workflow, live Herdr/provider, real physical hook or full SDLC
acceptance is claimed. W09 owns live acceptance. No credentials, generated dist,
logs, DB, test artifacts or real approvals are committed.
