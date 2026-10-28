# W05 — projection feed, trusted artifacts and exact notice display

Source/local implementation, sequential Runtime then Local Server. No live
provider/Herdr or full SDLC acceptance. General notice-content retrieval is a
frozen-interface gap described below; W06 must not auto-acknowledge feed IDs.

## Baseline and commits

Approved integration descendant: `6cbf25409f204684db3139ffde8b8302f81fb5c4`.
At selection main and origin/main both named that commit, index/worktree clean.
Worktree `.worktrees/local-web-w05`, branch `agent/runtime/w05`.
Actual filesystem AGENTS.md, W05 plan/spec, W00 freeze/ADR0006, ADR0007,
W01 HANDOFF.md, integrated Runtime W02, W03 and both W04 handoffs were read.
No graphify-out graph existed; source and package manifests were inspected.

Checked HEAD/status/index, worktrees, local/remote refs, ancestry and patch
equivalence. Baseline retains W00 `2bd99d8`, W01 `114de68`, integrated W02
`7402d0b`, W03 `a2764ef` and W04 `cd351c3`; `git cherry HEAD` against both
remaining W03/W04 branches returned no missing patches. Main/origin/main were
rechecked unchanged after implementation. No reset to survey `7b158c4`, fetch,
branch switch in another worktree, push, PR or remote/local integration merge.
Existing W03/W04 worktrees and all other work were preserved.

Sequential source commits:

- `6ac7e92`: Runtime feed, catalog/stream adapter, acknowledgement and host wiring.
- `0481789`: Runtime unread-stream cancellation regression fix.
- `e5f45fd362f1a9d29b3382dde29d82228c95efc2`: Local Server SSE/artifact/notice routes,
  cancellation and bounded-memory fixes, HTTP/regression tests.
- Package README/handoff evidence follows in documentation-only commits.

Only `packages/runtime/**` and `apps/local-server/**` changed. Runtime owns
interaction/{events,artifacts,notices,client}, minimal host/controller IPC wiring
and an exact read-only notice display observation in HostReceiptJournal. Local
Server owns {sse,artifact-response,routes,server}; server.ts adds an instance
epoch only. Tests and READMEs stay within these two owners. No root, contracts,
Conversation, CLI, UI, shared docs, config, lockfile or dependency change.
No dist, state, keys, logs, screenshots or temporary databases committed.

## Interfaces and authority

Frozen UserInteractionClient.events/readArtifact/acknowledgeNotice now work.
Other public schemas/DTOs and RuntimeService/RoleMessage/event/checkpoint/receipt
formats are unchanged. New request framing is private owner-authenticated IPC;
public query/path/event/metadata/chunk/result schemas validate its boundaries.
No SQL migration, receipt upcaster or physical-hook fabrication.

Feed is an ephemeral bounded ring (1000) in the existing host. Generic periodic
`invalidate` means reload projections, not a fabricated domain event, operation
completion or workflow success. `notice` carries exact pending notice IDs only.
The response page is bounded to 100. Missing/foreign/evicted/future/restarted
cursor yields reset at the current sequence. Parsing never converts large unsafe
sequence numbers into authority. Ring reads/replay never tick the scheduler,
dispatch work, mutate domain state or mark notices surfaced/displayed.

Local Server prefixes the host epoch with its own random instance epoch. Thus a
surviving host still resets after web-server restart. HTTP query cursor and
Last-Event-ID must agree. Browser queue is at most 100, overflow disconnects,
heartbeat is 15 seconds, session expiry closes the stream. Disconnect removes
listeners/timers and returns the source iterator; a stalled iterator cannot
hold server shutdown hostage. Healthy per-read cancellation subscriptions are
removed immediately instead of retaining one promise reaction per delivered event.
Reconnect reads/reloads snapshots; no uncertain mutation is automatically resent.

Artifacts resolve only by opaque ID from the active host's trusted ArtifactStore
catalog. Run ownership is checked against this host's scoped Conversation run
projection. Wrong project/run, unsafe IDs, missing/tombstoned blobs fail closed;
ArtifactStore validates symlinks/special files, size and hash and snapshots the
entire blob before first bytes. No raw browser path or external URI fetch.
The existing store deadline/abort mechanism is used, with 64 MiB transfer quota,
30-second lifetime, chunks <=64 KiB and preview <=1 MiB. Private IPC is a validated
metadata result line followed by raw bytes, backpressured and closed on cancellation.
Both ends enforce byte/hash bounds; errors after headers abort the HTTP framing.
HTTP deliberately omits Content-Length so a nominal final chunk followed by a
checksum error cannot be presented as a cleanly completed response.

Plain text/JSON/Markdown preview is served as inert text/plain; there is no HTML
renderer or active Markdown link/image interpretation. HTML/SVG/other types and
oversized previews are octet-stream attachments. nosniff/no-store/sandbox CSP
apply. W06 must continue using text nodes or an independently safe renderer.

Notice acknowledgement is a separate explicit authenticated POST, with exact ID,
Origin/cookie/CSRF checks and the dedicated web credential. It serializes with
native/user mutations and reuses the existing idempotent notice-displayed receipt,
returning the original timestamp after retry/restart. Feed/network delivery never
calls it or marks a notice surfaced. Acknowledgement neither records human approval
nor answers a decision/resumes/cancels work. Native display hooks, pending decision
identity, watchdog, leases/fences, independent gates, verification bounds,
test-integrity and unknown_delivery semantics remain unchanged.

## TDD, review and validation

Linux, Node v24.16.0, pinned pnpm12.5.1; Node22/macOS/Windows not executed.
Accepted TddDecision policy: required RED→GREEN for security/isolation/replay;
no fabricated domain TddDecision/approval receipt. Tests preceded implementation.
Runtime initial RED: three missing modules. Local Server RED: missing SSE module
and five artifact endpoints still returning 422. Build precedes subprocess tests.

One independent read-only whole-branch reviewer checked scope/authority/recovery.
Important findings all fixed with reproducing tests, no second review claimed:

1. An unstarted artifact generator's return skipped its finally, leaking IPC.
   RED: unread-stream peer never disconnected; GREEN: explicit close wrapper.
2. Awaiting stalled artifact iterator.return could hold HTTP shutdown.
   RED: browser disconnect returned "stuck"; GREEN: cancel pending read and
   observe cleanup without awaiting an uncooperative source.
3. Per-event Promise.race against a pending close promise retained all reactions.
   RED: actual built SSE adapter retained 51,499,832 extra heap bytes after
   80,000 delivered events and GC, above the 16 MiB guard. GREEN: same subprocess
   test passes using removable per-read listeners. Artifact adapter uses the
   same cancellation discipline. Queue/listener and source-return checks pass.

Final: minor (deferred): finite custom SSE source completion can stop before its
last queued events drain. Production Runtime sources are continuous; no live
notice is lost from authoritative state. Cost: a future finite-source adapter
must drain before end (or require snapshot reload). No Important finding waived.

Commands/results on fixed executable source `e5f45fd`:

- `pnpm install --frozen-lockfile`: exit0; lockfile unchanged.
- `pnpm run build`: exit0, including tsc and real frontend production bundle.
- `pnpm check:deps`: exit0, 24 packages / 54 edges, acyclic.
- `pnpm typecheck`: exit0, frontend and Node resolver included.
- Runtime-stage targeted interaction + notice-watchdog + conversation-notice-hooks:
  exit0, 13 files / 132 passed. This precedes the unread-stream regression fix;
  final affected selection includes those native suites on the final source.
- `TMPDIR=/tmp VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 pnpm exec vitest run apps/local-server/test packages/runtime/test/interaction`:
  exit0, 21 files / 128 passed, zero failures/skips, on final fixed source.
- Targeted artifact disconnect regression: exit0, 11 passed / two files after
  both tests were observed failing. All final-source test cases are also in
  the affected selection below.
- `git diff --check`: exit0; final status/ownership checked before handoff commit.

Final affected gate: **PASS, exit0**, 207 files passed / 3 skipped (210),
**3009 tests passed / 78 skipped (3087)**, 1469.86 seconds. Existing conditional
skips retain their scope and do not establish live/platform acceptance. No failed
case was filtered out. See also the Local Server W05 handoff. Exact command:

```sh
env -u AI_ISOLATOR -u AI_ISOLATOR_PROFILE -u AI_ISOLATOR_REAL_HOME \
  -u AI_ISOLATOR_TOOL -u AI_ISOLATOR_HOME TMPDIR=/tmp \
  VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 \
  VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 \
  pnpm test:affected --base 6cbf25409f204684db3139ffde8b8302f81fb5c4 --run
```

Printed selection: package fallback (`commit_mismatch`), Runtime + Local Server,
231 unit input paths including helpers, zero E2E. Index unavailability skips no
tests. Source HEAD is e5f45fd; only package documentation changes during/after
this run. Inherited isolator selectors are removed for existing native fixture
compatibility as recorded by W00/W03, not to relax permissions/assertions/timeouts.
No monorepo full suite or separate live/browser workflow acceptance is inferred.

Real HTTP fixture observations: status200, Content-Type text/event-stream;
charset=utf-8, Cache-Control no-store, X-Accel-Buffering no. Frame contains
`id: <server-epoch>_<host-epoch>:<sequence>`, matching JSON cursor and event type.
Last-Event-ID is forwarded without server prefix only for this instance; restart
starts with reset. Actual disconnect counters rise once per returned iterator;
slow-client maxQueued<=100 and listeners are removed. Cookies/epochs/credentials
are not copied into handoff. These are real HTTP/socket/subprocess tests with
synthetic host/provider fixtures, not real Herdr transport/provider acceptance.

## Unresolved interface proposal and next tasks

Exact mismatch: frozen WebEventSchema has only cursor/projectId/type/resourceIds/
occurredAt; UserInteractionClient and WebHttpContracts expose no readNotice or
notice-content DTO. Native read_updates is a role-only tool, not a browser API.
Therefore W06 cannot render arbitrary general notice content merely from an SSE
notice ID, and must never POST displayed on network receipt. Existing run/decision
views can still be refreshed and displayed normally. No shared schema was changed.

Integrator proposal (requires a new decision/owner approval after W00): additive
bounded WebNoticeView + project-scoped read endpoint/client method with exact ID,
redacted user-facing text and safe references; no private raw log/credential copy.
Keep displayed POST exact/idempotent and UI-owned only after actual render. Do not
expose role read_updates or reuse it as an approval/native user turn. This is a
W06 general-notice integration gap, not permission to broaden W05 contracts.

W06 consumes inert artifacts/SSE, resets snapshots after reset and acknowledges
only visibly rendered exact notices. W07 still submits exact frozen commands and
observes operation IDs after lost ACK; feed invalidation is not acceptance. W08
owns optional chat; W09 owns actual browser/live-provider/Herdr/fault workflow
acceptance. Source/local tests do not close P02-RA01/P03-RA01 or guarantee hostile
same-UID, multi-host/network-filesystem/power-loss behavior. No remote closure.
