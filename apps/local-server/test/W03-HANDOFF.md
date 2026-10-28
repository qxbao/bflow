# W03 — secure localhost HTTP foundation

Source implementation/local HTTP verification delivered; W04 composition and the
integration proposals below remain open. No live Herdr/full SDLC acceptance.

Baseline: `c3456d805efb4b361bf906b3e5a6c05f4c4fb31d`.
Source commit: `f2e18cb6458c243b39a94361d2ce5743e032c14b`.
Handoff-only commit follows that source commit on `agent/local-server/w03`.
Worktree: `.worktrees/local-web-w03` (kept for integration).

Read actual filesystem AGENTS.md, W03 plan/spec, accepted ADR0006/D-WEB-01,
W00 freeze handoff, W01 handoff, integrated Runtime W02 and Conversation W02
handoffs. At selection main=origin/main=baseline, worktree/index clean. Inspected
HEAD, status/index, worktrees, refs, ancestry and patch equivalence. Baseline
retains W00 freeze `2bd99d8`, W01 `114de68`, integrated W02 `3aa2943` and P24.
`git cherry HEAD agent/contracts/w00` and the W01 branch returned no missing
commits; Conversation's six original W02 commits were all patch-equivalent (`-`)
to integrated counterparts. No reset to survey `7b158c4`, fetch, branch switch in
another worktree, push, PR or remote merge. Main remained unchanged/clean.

## Paths, interfaces and boundaries

Only `apps/local-server/**`: README; src/{index,server,security,session,
project-registry,operation-index,lifecycle-operations,routes,errors}.ts;
test/{security,bootstrap,registry,routes,lifecycle-operations}.test.ts plus
HTTP fixture helper and this handoff. Existing W00 asset/import tests retained.
No root/lockfile/contracts/shared docs/CLI/Runtime/Conversation/UI edits.
No dependency changes or generated dist/state/logs/keys committed.

Export `createLocalWebServer({host:'127.0.0.1',port,stateDirectory,
assetsDirectory,workspace,interaction})` returning `{origin,issueBootstrap,close}`;
`LocalWebServerOptions`, `LocalWebServer`, and the registry implementation type.
W00 placeholder composition types are replaced by the actual factory options.
No public HTTP/host schema amendment or native receipt migration.

HTTP boundaries use frozen exported request/query/path/response/error schemas.
Node server calls only injected workspace/interaction ports. No CLI import,
legacy mutation CLI, workflow engine, private-socket endpoint, role MCP credential,
fake physical hook, successful mock fallback or filesystem browser exists.
Unimplemented W05/W08 routes refuse explicitly after auth/schema/scope checks.
W03 does not implement SSE/artifact/chat transport or claim UI design compliance.

Implemented exact Host/Origin and fetch-metadata validation, no CORS; one-time
60-second bootstrap; host-only HttpOnly SameSite=Strict cookie; non-sliding
12-hour memory-only session; GET session restores CSRF; authenticated mutations
require CSRF and recheck session expiry at durable acceptance after waiting.
Restart invalidates cookies and outstanding bootstrap secrets. No request/URL
logging; public errors contain safe messages/correlation IDs, never raw backend
ContractError details. JSON, static assets and session responses are no-store.

Static SPA handling follows API routing. Root landing selects index.html;
unknown APIs stay JSON errors. Decode before path normalization; reject dot
segments, malformed encoding, backslashes, NUL/control characters, and asset
symlink escape. GET bodies and duplicate/unsupported query values are rejected.
Body cap is 256 KiB including chunked transfers.

Registry observes Git via read-only `rev-parse --show-toplevel`, preserving
whitespace in paths and stripping inherited Git selectors. Absolute inputs and
canonical roots reject symlink aliasing. Project identity is W01's `project-`
plus first 32 SHA256 hex characters of the canonical path. Subdirectories resolve
to the same canonical Git root. No init/setup/install/index/trust operation.
Registry is bounded to 100 projects and revalidates identity before backend use.
Unregister requires confirmation, blocks unresolved operations, preserves final
receipt tombstones and never runs down.

## Durability, compatibility and recovery

Private state: owner-checked 0700 directory, 0600 files, no-follow/nonblocking
bounded regular-file reads, exclusive server.lock, synced temporary-file rename.
Stable principal survives restart. A second owner/unsafe directory fails closed.
Abrupt-exit stale lock recovery remains a CLI/operator action after verifying
actual ownership; no PID-only takeover. No power-loss/network-FS/multi-host or
hostile same-UID guarantee is added.

One atomically replaced private record contains the frozen owner index plus
operation. It pins project/stable principal/UUID, owner/kind/fingerprint and
original hostSessionId/receiptId before forwarding. Fingerprints preserve all
parsed command/evidence fields and exclude server-generated timestamps/proof.
Owner/kind/body mismatch conflicts. Final results are immutable. Operations
serialize per project/ID; only registration/reservation writes share a short
critical section, including a registration recheck against unregister races.

Lifecycle start/stop use the Local Server ledger and injected workspace methods;
lookup works with no host. Lost ACK/restart observes reconcileSessionOperation,
never calls start/stop again. Host operations use execute once, then observation
only. Replacement-host receipts are not accepted as old-session evidence: if
current session differs from the pinned session, retain reconciliation_required.
No mutation is resent because a host is missing or a timeout occurred.

Each injected backend call has a five-second observation deadline; it does not
abort or imply cessation of the underlying operation. Hanging calls do not hold
all API requests; shutdown closes connections and waits for bounded handlers
before releasing state, without down/cancel of any host. Post-acceptance disk
failures return non-retryable reconciliation_required plus the durable operationId.
`applied` is an operation effect; it is never workflow/provider success.
Native receipts, Conversation intake, Runtime approvals/leases/fences/independent
gates/bounds/test-integrity and unknown_delivery semantics are untouched.

## Verification and review

Linux, Node v24.16.0, pinned pnpm12.5.1; Node22 not executed. Required TDD policy
from accepted W00/plan applies to security/replay/isolation; no fabricated domain
TddDecision or human-override receipt. Initial root build succeeded, then all
10 initial W03 tests failed for missing createLocalWebServer. GREEN followed
implementation. Subsequent review regressions were reproduced RED before fixes.

Final commands on source exactly matching `f2e18cb`:

| Command | Actual result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit0; no manifest/lockfile change |
| `pnpm run build` | exit0; root tsc + frontend check/resolver/Vite assets |
| `pnpm --filter @bflow/local-server build` | exit0, including after final source fixes |
| `pnpm check:deps` | exit0, 24 packages/52 internal edges, acyclic |
| `pnpm typecheck` | exit0, including frontend and Node resolver |
| `pnpm exec vitest run apps/local-server/test` | exit0, 24 passed/0 failed/0 skipped, 7 files |
| `pnpm test:affected --base c3456d805efb4b361bf906b3e5a6c05f4c4fb31d --run` | exit0; build then same 24/24 in 7 files; 0 skipped |
| `pnpm --filter @bflow/local-server test` | exit0, 24 passed/0 failed/0 skipped, 7 files |
| `git diff --check` | exit0 |

Affected selection: scope package; GitNexus unavailable (`commit_mismatch`), all
Local Server tests selected, 8 unit input paths (includes helpers.ts), zero E2E.
No tests were skipped because the index was unavailable. No root change/full
scope, so no monorepo full-suite or full E2E acceptance claim. The package script was also executed after adding this handoff: same 24/24
passed, 7 files, zero failures/skips. Source remains exactly `f2e18cb`.

Tests use real ephemeral loopback HTTP, real cookies/headers, actual Git
repositories and private filesystem state. Host/lifecycle ports use synthetic
injected fixtures. Cases include hostile/null Origin, Host, CSRF, forged/expired/
restarted sessions, bootstrap expiry/reuse, unauthorized SSE, oversized chunked
body, canonical/symlink/private-state/path rejection, static traversal, malformed
APIs, cross-project commands/operation lookups, duplicate concurrent start,
stop after host loss, restart/lost ACK, retained tombstones, replacement-session
receipt spoof, post-effect write failure, hung ACK and queued-session expiry.
No production security bypass, timeout/assertion weakening or mock fallback.

Independent reviewer reproduced two Important bugs over actual HTTP: root URL
404 and global serialization hanging recovery/shutdown. Both fixed with
RED→GREEN tests. Author regressions also fixed whitespace path aliasing, GET
body acceptance, post-effect persistence errors, replacement-session receipt
confusion and queued expiry. Double-question-mark query truncation was regraded
Important because it violated strict ingress, then fixed RED→GREEN. The full
package and affected selection passed after these changes. No second reviewer
pass is claimed.

Deferred minor: W05/W08 unsupported routes resolve the injected client before
returning 422. An absent/throwing resolver can instead produce 503. They still
cannot grant authority, stream data or return fake success. W05/W08 should return
unsupported before resolving an unused backend. The review's temporary missing
handoff-link observation is resolved by this document.

## Exact integration proposals / unresolved seams

1. **Missing frozen options codec.** W03 asks to parse server options with an
   exported schema, but W00 exports none in contracts/web or web-host. The local
   factory validates required fields, loopback host/port, absolute directories,
   unknown options and callable injected ports. Integrator should add an approved
   server-only configuration codec (serializable values plus validated injected
   port handles) and wire it into factory/CLI. W03 does not change contracts to
   manufacture compliance. This is still an ingress-schema compliance gap at
   CLI construction, not an HTTP schema bypass.
2. **Signer/registry context.** Frozen `interaction:(projectId)=>Promise<Client>`
   cannot receive the authenticated HTTP browserSessionId, while W02's signer
   needs WebPrincipal browserSessionId, stable principal and registered issuer.
   CLI also needs a trusted read-only dynamic canonical registry resolver after
   browser registration. Proposed integration-owned compatible seam: explicit
   owner-side request context and read-only registered-project resolution,
   carrying validated server-issued identity only. Do not read private browser
   fields as provenance or pass credentials to the browser. No signing/key/CLI
   composition or insecure default is fabricated here.
3. **Historical receipt evidence.** Local index pins hostSessionId/receiptId,
   but frozen `readOperation(projectId,operationId)` returns no originating-session
   evidence and the resolver only selects by project. W03 fails closed on a
   replacement session. W02/W04 should provide an owner-only original-session
   reader or independently verify the pinned journal context; only an approved
   integration decision may alter public contracts. Until then an unresolved old
   host operation remains reconciliation_required rather than being resent or
   falsely settled. Final local receipts remain readable across restart.

Rulings and costs: retain local options validation pending exported codec (W04
must close construction-schema compliance); retain frozen injection and fail
closed on unavailable historical proof (W04 must finish authenticated signer/
registry/history composition); frame real DELETE fixture bodies explicitly
(no production protection changed); bound observation without cancelling effects
(callers must reconcile the same ID); regrade query truncation as strict-ingress
failure (now tested/fixed). No other approval or schema decision was invented.

W04 consumes the server factory, injects actual lifecycle/Runtime clients, uses
127.0.0.1:4317 by default and opens origin with bootstrap fragment; no production
mock fallback. It owns CLI locator/reuse/browser opening and issuer registration.
W05 implements events/artifacts/notices on the authenticated boundary; W08 adds
verified chat. W09 owns real browser workflow/provider/Herdr/fault acceptance.
These independent source/local checks do not certify those tasks or resolve
P02-RA01/P03-RA01. Branch remains local for integrator review.
