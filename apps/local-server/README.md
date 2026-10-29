# @bflow/local-server

W03 implements the secure loopback HTTP foundation. Create a listener explicitly
with `createLocalWebServer({host:'127.0.0.1', port:4317, stateDirectory,
assetsDirectory, workspace, interaction})`. Port 0 selects an ephemeral port for
HTTP tests; all authentication/security checks remain enabled. The returned
handle exposes `origin`, `issueBootstrap()` and `close()`. Pass bootstrap secrets
in a browser URL **fragment**, exchange through the bootstrap endpoint, then
remove the fragment. This package does not open a browser or log URLs/requests.
Importing it creates no listener and starts no host.

Serve production assets and APIs on the returned origin. Exact Host/Origin,
fetch metadata, host-only HttpOnly SameSite=Strict cookie and mutation CSRF
checks apply. Bootstrap expires after 60 seconds; sessions expire after 12 hours
without sliding renewal and are lost on server restart. GET `/api/v1/session`
restores the CSRF token for reload/new tabs. Queued mutations recheck session expiry at acceptance. No tokens belong in localStorage.
No CORS, arbitrary filesystem endpoint, private IPC endpoint or role credential
is exposed. Static paths are decoded before traversal checks; symlinks cannot
escape the asset root. Unknown APIs always return schema-valid JSON errors.

Project registration only observes Git through `rev-parse`; it canonicalizes the
Git root, rejects symlinked input and derives the W01 path identity. It never
initializes, installs, indexes or starts the repository. Registry is bounded to
100 projects. Backend calls revalidate canonical identity. Unregister requires
confirmation, blocks unresolved operations, keeps finalized operation tombstones
and never stops a host.

Only the injected `LocalWorkspaceServices` and `UserInteractionClient` perform
workspace/host operations. The package imports neither CLI nor a workflow engine;
there is no mock fallback. W04 owns CLI lifecycle/key registration/signer wiring.
W05 implements authenticated SSE/artifact/notices. W08 routes chat history/send
through the injected UserInteractionClient after auth/CSRF/schema/project/session
checks; delivery/admission/reconciliation remain host-owned. Unsupported adapters
return explicit errors, and no traditional mutation CLI is invoked.
No Herdr/provider or full SDLC acceptance is claimed.

Private state uses user-owned 0700 directories/0600 files and an exclusive owner
lock. A second owner fails closed; stale lock recovery after an abrupt process
exit needs operator/CLI verification, never PID-only takeover. Registry, stable
principal and immutable operation owner/kind/fingerprint survive restart. Host
records pin the original hostSessionId/receiptId. Lifecycle receipts stay readable
without a host. Backend calls have a five-second observation deadline; timeout
does not cancel the underlying effect. Only registry/reservation writes use the
shared critical section; operations serialize per project/ID. Shutdown waits for
bounded handlers before releasing private state, without stopping any host.
Persisted intents are observed/reconciled, never automatically
resent after lost ACK. `applied` is an operation effect, not workflow success.
This is single-process local POSIX filesystem behavior; no power-loss, multi-host
or hostile same-UID guarantee is added.

W04 adds production owner composition via `createLocalWebServer({...config,
compose: ({principalId, resolveProject}) => ({workspace, interaction,
hostSessionId, readHistoricalOperation})})`. The resolver revalidates registered
canonical Git roots; `interaction(projectId, context)` receives only server-issued
principal/browserSessionId/expiry after authentication. `hostSessionId` resolves
the physical host identity, independently of the public Conversation session ID.
Historical reads use that original pinned host; an unavailable original stays
reconciliation_required and never redirects to another host. Legacy explicit
workspace/client injection remains supported. Construction config and browser
context use server-only contracts/web-host codecs (D-WEB-02); HTTP DTOs unchanged.
The CLI owns lifecycle receipts and issuer/key registration; this server imports
no CLI or provider modules. The web application supplies its separately built
production assets. Chat provider readiness and normalized history belong to Runtime;
HTTP success is never workflow success.

W05 SSE accepts a query cursor or `Last-Event-ID` (both must agree). Its public
cursor combines this server's epoch and the host projection epoch plus sequence.
Server/host restart, unknown scope or evicted history yields `reset`; clients must
reload authoritative views. This feed is not a durable domain-event journal.
The host ring holds at most 1000 entries; each browser queue holds at most 100.
Slow clients disconnect and reconnect from their last complete event; heartbeats
are sent every 15 seconds, sessions expire without renewal, and closing a browser
or Local Server only releases streams. Healthy streams remove cancellation
listeners after each read. A finite custom source can lose its final queued
events on completion; the production Runtime source is continuous.

Artifact responses use trusted host metadata/stream only, with a 64 MiB/30-second
transfer quota, 64 KiB chunks and 1 MiB preview bound. Plain text/JSON/Markdown
previews use `text/plain`; links/images never execute or fetch. HTML/SVG and larger
previews download as octet-stream attachments. Every response uses `nosniff`,
`no-store` and sandbox CSP. Integrity failures abort the stream; partial bytes do
not establish complete evidence. No browser-provided filesystem path or URI fetch.

`POST /projects/:id/notices/:noticeId/displayed` requires cookie, exact Origin and
CSRF, and acknowledges that exact notice only. GET/SSE/network delivery never
marks it read or grants decision authority. UI must POST only after rendering its
content; the current frozen DTO lacks general notice-content retrieval (integration
proposal in [W05 handoff](test/W05-HANDOFF.md)). No fake physical hook or legacy
mutation CLI is used.

From repository root, build before subprocess/asset tests:

```sh
pnpm run build
pnpm --filter @bflow/local-server typecheck
pnpm --filter @bflow/local-server test
pnpm test:affected --base <baseline> --run
```

Tests use real HTTP on ephemeral loopback ports, actual Git repositories and
private filesystem state, with injected host/lifecycle fixtures. They establish
HTTP security and ledger behavior, not live provider/Herdr workflow readiness.

## Additive repository settings API

The authenticated v1 API also exposes GET/PUT `projects/:id/configuration`,
POST `projects/:id/initializations` and GET
`projects/:id/initializations/:operationId`. Config PUT returns a strict
`OperationResult` so field validation failures remain readable without weakening
generic error redaction. CLI composition supplies optional settings ports; older
backend injections report `operation_not_allowed`. Init POST reserves a durable
owner receipt and returns 202 promptly; reading never replays its effect. Confirmed
unregister consults the owner's pending-init guard as well as the existing operation
index. All routes retain authentication, exact Origin, CSRF, schema and canonical
registered-project checks. Config paths and command arguments are never browser
inputs. Machine-wide setup/install/login is outside these repository endpoints.

Initialization optionally includes an explicitly confirmed configuration-only Git
commit, pinned to the last reviewed configuration/ignore-rules revision. This uses
the same durable initialization receipt; retries observe the original operation,
and a later indexing failure does not erase proof of a completed commit.

Stop requests may add optional `force:true` with `confirmed:true`; the local
operation fingerprint includes that choice. Legacy stop methods remain compatible,
and a reused operation ID with a changed force value conflicts. The CLI forwards
it to the existing checkpointed force-stop implementation, never a direct kill.
