# D-WEB-02 — complete W04 trusted composition

Status: accepted by the project owner in the current implementation conversation
on 2026-10-29. Approval: “Đồng ý”, after the owner asked which original plan task
owns the integration. This is approval for the bounded W04 integration below,
not acceptance of untested product behavior or remote publication.

## Motivation and scope

W04 source c7d8148 on baseline 20a38a5 cannot be clean-installed: CLI dependency
edges are missing; W03 hides its canonical registry and authenticated browser
session from the injected CLI composition. Existing lifecycle receipts do not
bind a web operation ID. The owner authorizes completing these W04 integration
items, including CLI package references/lockfile, Local Server composition,
lifecycle receipts and an additive server-only construction codec.

Affected owners: CLI/integration, Local Server, Runtime and contracts. No W05–W09
feature or remote merge/push/PR is authorized. Continue in agent/cli/w04.

## Decision

- Add server-only serializable Local Server configuration and authenticated
  request-context schemas to contracts/web-host. Export the existing owner-key
  registration/credential shapes there as codecs, retaining their wire fields. Browser HTTP DTOs, API version1,
  native receipts, RuntimeService and workflow event/checkpoint codecs unchanged.
- Add an owner-side Local Server composition factory with access only to its
  stable ledger principal and revalidating registered-project resolver. Pass
  authenticated browser context from BrowserSessions, after cookie/Origin/CSRF
  validation, to interaction factories. No browser/model supplied provenance.
  Existing injected workspace/client options remain supported for embeddings.
- CLI composes EnvironmentLifecycle and read-only execution preview, an Ed25519
  issuer registered through existing owner IPC, and the existing scoped
  UserInteractionClient. Host principal remains the host-enforced local UID;
  stable server principal scopes its ledger/issuer and is not substituted for it.
  Signing binds the exact command digest, project, host and authenticated browser
  session with a fresh nonce and proof expiry bounded by the browser session.
- Registration of the same owner key is idempotent within a host lifetime;
  registration after host restart is explicit owner IPC. It never resends a
  workflow command. Queries do not ensure/start/prepare/activate a missing host.
- Operation recovery selects the original pinned physical host session. Its ID
  is resolved by an owner-only composition seam, independently from the public
  Conversation session ID. Older uncertain indexes that recorded Conversation
  IDs are not guessed/upcast into a different authority context. If its authenticated
  operation read is unavailable, retain reconciliation_required. A current host's
  plausible same-ID result is not substituted for another session's receipt.
- Persist CLI lifecycle receipts using frozen WebOperation envelopes in private
  server-scoped storage: reserve before up/down and store the correlated result
  before acknowledgement. Reconcile observes these receipts without up/down,
  installation or initialization, including after stop/host loss. Interrupted
  effects without a conclusive receipt remain uncertain and are never resent.
- Apply CLI package/reference edges, regenerate pnpm-lock.yaml with pinned pnpm.
  Use package imports and the exported Node asset resolver. Local Server never
  imports CLI. Closing the web owner only closes web/control resources.

## Compatibility and migration

All new codecs are additive and server-only; browser-safe web dependency closure
stays unchanged. Existing callers using workspace/interaction injection retain
behavior; new composition is opt-in for the production CLI. New lifecycle receipt
files are additive; old unresolved operations without these receipts stay
uncertain. No existing stored event, approval, native/web host receipt or SQL
schema is rewritten. Existing lifecycle/Runtime safety gates remain authoritative.

## Acceptance and evidence

Required TDD for trust/replay/isolation and receipt recovery. Build before
subprocess tests; dependency/type/affected checks and independent review. Root
manifest/lockfile changes widen the affected selection to full; report failures
and environment/platform skips without weakening them. No live Herdr/full SDLC
claim from synthetic fixtures. The W04 handoff records exact tested source,
commands, results and remaining limitations.
