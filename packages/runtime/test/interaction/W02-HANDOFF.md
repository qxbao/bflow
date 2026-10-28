# W02 Runtime foundation — incomplete, Conversation owner handoff

Baseline: `607d101433d3559e6c9474e5023996babc815157`.
Branch: `agent/runtime/w02`; worktree `.worktrees/local-web-w02`.
Source commit: `6da552daf5a92363576eb18f0576d5d8c713cf84`.
The subsequent handoff-only commit records measured verification below.

This is **not completed W02 or M1**. Authenticated no-chat commands remain
disabled. No new endpoint, successful production stub, native hook, legacy CLI
mutation, public schema, root configuration or cross-owner edit was introduced.

## Baseline and ownership

Read actual AGENTS.md, W02 plan, full spec, accepted ADR 0006 / D-WEB-01,
W00 handoff and W01 runtime handoff. Baseline index/worktree were clean.
Inspected HEAD, local/remote refs, worktrees, ancestry and
`git log --left-right --cherry-pick main...origin/main` (empty). W00 branch
`de36c73`, its freeze `2bd99d8`, W01 branch `114de68` and P24 `8dbb056`
are ancestors. `git cherry main HEAD` was empty before implementation:
no competing predecessor patch needed cherry-picking. Survey `7b158c4`
was not used to reset anything. No other worktree, shared file or remote
was modified. No fetch/push/PR/remote merge.

Only owned Runtime paths are added:

- `src/interaction/authority.ts`: in-memory owner-registered Ed25519 trust;
  exact project/host/principal/issuer/key/capability/command/digest/time checks.
  Strict exported WebCommand/WebPrincipal codecs at admission. New host has
  no registered key; registration/revocation are private composition methods,
  not an implemented IPC or role tool. Browser/model cannot register a key.
- `src/interaction/operation-store.ts`: separate private v2 checksummed
  immutable intent/running/uncertain/final records, host-local serialized
  admission and nonce consumption in the same intent publication. Intent is
  file-synced and directory-synced before acceptance. One current in-memory
  owner can claim dispatch once. Identity is project/principal/commandId;
  body conflict is refused and finalized receipts retain identity/nonce.
- `test/interaction/{authority,recovery,native-compatibility}.test.ts`,
  `web-command-fixtures.ts` and this handoff.

These modules are private and deliberately not re-exported as a new Runtime
API. `UserInteractionClient.execute/readOperation` remain explicitly refused
and W01 actions disabled. There is no authority-bearing socket route yet.

## Exact ownership blocker and proposed Conversation seam

`packages/conversation/src/types.ts::MessageProvenanceSchema` only accepts
`herdr_attach | cli | internal | untrusted`. `UserTurnInputSchema` requires
text content and its existing `ConversationGateway.handleUserTurn` goes
through native/text decision paths. No exported Conversation-owned structured
WebCommand intake exists. `HostConversationIntake.userInput` constructs
`herdr_attach` from a real `TrustedConversationTurn`/PaneBinding; reusing it
for web would fabricate physical provenance. In
`packages/runtime/src/agentic/host.ts::onHumanDecision`, the callback requires
`humanHookProvenance`; `HostReceiptJournal.recordHuman/authenticateHuman`
only supports native-v1. These are incompatible with pretending a browser
proof is an authenticated native turn. No such bypass was added.

Conversation owner proposal (names are a proposal, not implemented APIs):

1. Export a dedicated `handleStructuredInteraction(command, principal)` entry
   consuming the frozen exported WebCommand/WebPrincipal schemas, invoked only
   by host-authenticated composition. Add observation-only reconciliation for
   the same commandId. Do not reuse model-supplied `authenticatedUser:true`
   or accept a key bundled with a command. Coordinate exact return type using
   existing WebOperationResult/OperationResult codecs; any new public codec
   needs an integration decision first.
2. Deterministically map request kind/title/objective/criteria/constraints
   into the existing requirement policy and normal persisted delegation/outbox.
   No classifier/model turn, invented approved Specification or Developer
   dispatch. Keep pre-run intakeId and pending questions in Conversation
   storage, expose exact question identity/version through the W01 view.
3. Share the native/web pending-decision settlement and serialization boundary.
   Recheck full approval target/revision/generation/evidenceDigest/options,
   expiry/supersession and current pending action while holding authority.
   Exactly one opposite decision may win. Preserve follow-up-run lineage,
   cancel/resume guards and current native behavior.
4. Return stable admission/result receipts keyed by commandId, including
   failures and unknown delivery, for host observation-only reconciliation.
   Resume/cancel must not acquire native authority from fabricated turns.

After that owner handoff, Runtime must implement commands.ts and wire the
existing host/intake/Runtime callbacks, dedicated owner-key registration IPC,
authenticated mutation/read-operation ingress, v2 recovery dispatch and
client methods. It must revalidate state under the shared native/web mutation
boundary and retain lease/fence, independent gates, test-integrity and bounds.
Local Server must persist its frozen owner index before forwarding and route
old IDs to the original host session, including after down/up; never forward
them to a replacement host. W04 owner composition registers the server key.
No current function here establishes these missing integrations.

## Compatibility and recovery behavior actually implemented

No HostReceiptJournal-v1 byte/checksum/filename/parser changes. Compatibility
test reads all three W00 native-v1 approval fixtures through actual journal
`authenticateHuman`/`humanDecisions`, with byte equality afterward. This is
fixture replay, not live physical-hook evidence or a complete replay upcaster.

The v2 store checks version/kind/checksum/full fingerprint/context/filename
identity and safe owner-only regular files; rejects symlinks and oversized
records. Missing/foreign principal lookup cannot return another principal's
operation. Repository/session mismatches fail closed. Historical reads use
accepted receipts without requiring today's browser TTL. New submissions,
including replay, still require a live registered proof. Proof/keys are never
returned in the WebOperation DTO.

Current-process accepted intent can begin exactly once, with a running marker
published before any caller could effect admission. Reopening a store after
intent/dispatch/effect-before-ack gives reconciliation_required and cannot
claim dispatch. A final persisted result survives response loss/restart and
replays unchanged; same ID/different body conflicts. Explicit uncertainty is
separate from final resolution and can later close from authoritative evidence.
The primitive never observes/infers a workflow effect itself; its future
trusted caller must validate that evidence before settle. There is no automatic
retry, inferred success, cancellation-stopped claim or native/web winner claim.

Guarantee scope: one exclusive host owner on a local POSIX filesystem, using
its existing host lifecycle lock. In-process callers serialize by directory;
there is no multi-process/multi-host/network-filesystem/power-loss/hostile
same-UID guarantee. Nonce lookup scans retained intents; no throughput claim.

## TDD, verification and review ledger

Supplied accepted policy: required red-green for authority/replay/security;
no fabricated domain TddDecision or human approval receipt.

- Baseline `pnpm install --frozen-lockfile` and `pnpm run build`: PASS.
- Initial targeted authority/recovery run: RED, two suites could not load the
  missing authority implementation. Subsequent behavioral regression tests
  reproduced corrupt dispatch-marker settlement and uncertainty that could
  not later resolve; both failed before their production fixes and passed
  afterward. No tests/assertions/timeouts were weakened.
- `TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/interaction/authority.test.ts packages/runtime/test/interaction/recovery.test.ts`:
  PASS, 24 tests / 2 files. Independent reviewer repeated 24/24 PASS.
- `TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/interaction/native-compatibility.test.ts`:
  PASS, 1 test / 1 file, all three native fixtures.
- Rebuilt `pnpm run build`: PASS before subprocess regression selection.
- `pnpm check:deps`: PASS, 24 packages / 52 edges, unchanged boundaries.
- `pnpm typecheck`: PASS, including frontend and Node resolver typechecks.
- Affected selection: package scope, GitNexus unavailable/commit_mismatch;
  the unavailable index widens to Runtime rather than skipping its tests.
  206 unit input paths (including helpers), zero E2E. Actual executed inventory
  is 188 files, not 206 test suites.

Final verification, Linux / Node v24.16.0 / pnpm 12.5.1 (Node 22 not executed):

```sh
TMPDIR=/tmp VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm test:affected --base main --run
```

Exit 1, **NOT PASS**: 183 files passed / 2 failed / 3 skipped (188 total);
2815 tests passed / 2 failed / 69 skipped (2886 total), 961.11 seconds.
Tested executable/test source is exactly the source commit above, before its
commit; subsequent edits only add this handoff. All 25 new tests pass in this
affected run. Existing conversation-host-rpc (9), conversation-intake (28),
host-receipts (19), cancellation-control (3), integration-recovery (17),
integration-p19-approval-verification (23), and W01 interaction suites pass.

Failures, with unchanged source/fixtures/timeouts:

1. `agentic/az-acceptance.test.ts`: “stops after 3 automatic resumes of a
   recurring no-next-action stop with one Conversation notice; an explicit
   user resume still runs”, line 522, got `{resumed:1}` instead of `{resumed:0}`.
2. `agentic/integration-p19-conflicts-reviews.test.ts`: “escalates the conflict
   after two resolver attempts end without an accepted resolution”, 30-second
   timeout (30097 ms observed).

Diagnostic rerun after the affected suite finished:

```sh
TMPDIR=/tmp VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 pnpm exec vitest run packages/runtime/test/agentic/az-acceptance.test.ts packages/runtime/test/agentic/integration-p19-conflicts-reviews.test.ts -t 'stops after 3 automatic resumes|escalates the conflict after two resolver attempts'
```

Exit 0: 2 passed / 25 name-filtered skipped, 2 files passed, 21.03 seconds.
Both isolated successes do **not** erase the affected failures or prove their
cause. No baseline loaded-suite reproduction is claimed; the unchanged tests
need Runtime/integrator follow-up. No unrelated engine/timing patch, increased
timeout, removed assertion or reduced selection was applied. The root full
suite was not run because owned-path affected selection was sufficient scope.
No credentials, generated dist, DB, real approvals, test logs or artifacts
were committed. No live workflow acceptance was attempted.

Ruling: execute independent Runtime authority/storage only until Conversation
owner provides structured entry — mandated ownership plus D-WEB-01 prohibits
emulating it with native hooks/private Runtime mutations. Cost: W02 remains
incomplete; W07 direct-action integration cannot use this foundation alone.

Ruling: a foreign project lookup returns no record, while a receipt found in
the original hashed slot with wrong repository/session is rejected — matching
project-scoped identity. Cost: callers cannot diagnose a foreign record from
that lookup. The initial new test incorrectly expected every foreign lookup
to throw; it was corrected to distinguish absence from corrupt context.

Independent fresh-context review: no Critical/Important defect in the isolated
foundation. Minor deferred: `publish` closes a failed write/sync handle but
can leave a `pending-*.tmp` before its later cleanup block; repeated disk I/O
failures may accumulate orphans. Not an authority/replay bypass. No fault-I/O
test or fix is claimed. Requires a later scoped cleanup fix.

## Checklist disposition / evidence boundaries

- [x] Instructions/predecessors/baseline/isolation; owned paths only.
- [x] Private proof validation and durable intent/nonce/at-most-one dispatch
  primitives, same-key conflict/replay, conservative restart behavior.
- [x] New authority/recovery tests and actual old-journal fixture replay.
- [x] Build, targeted tests, independent foundation review.
- [x] Complete affected selection executed and actual failures preserved.
- [ ] Affected suite entirely green: two observations above remain unresolved.
- [ ] Conversation deterministic intake, criteria mapping, clarification.
- [ ] Native/web opposite decisions, rejected/stale/expired/superseded live
  host validation, option validation, exact resume/cancel action semantics.
- [ ] Owner-authenticated registration IPC, host ingress/client wiring,
  native/web receipt authentication/recovery dispatch and downgrade guard.
- [ ] Real effect windows at human receipt/outbox acceptance/effect commit;
  current crash tests reopen real files around the primitive dispatch marker,
  not an actual workflow. No model/native/Herdr effects were fabricated.
- [ ] Full W02 acceptance and integration typecheck after Conversation handoff.

Evidence level: source + local cryptographic/filesystem/fixture tests only.
No working form/button backend, browser integration, live Herdr/provider,
physical hook, real workflow or full SDLC acceptance is claimed. Next tasks
must keep direct actions unavailable until the unchecked W02 rows close.
