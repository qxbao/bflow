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
W05 owns authenticated SSE/artifact/notices; W08 owns chat. Those future routes
currently reject explicitly after authentication, validation and project scope.
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
no CLI or provider modules. W06 UI, W05 events/artifacts and W08 chat remain their
separate tasks. The bundled W00 page is still an asset/build skeleton.

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
