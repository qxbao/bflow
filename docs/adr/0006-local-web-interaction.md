# ADR 0006 — D-WEB-01: local web interaction contracts

Status: **ACCEPTED by project owner qxbao** (2026-10-28); schema freeze
occurs only at the verified W00 integration commit identified in its handoff.
Approval evidence in the execution conversation: qxbao answered **“Duyệt. qxbao”**
to the explicit request to approve this ADR for schemas/skeleton/freeze.
After independent review, qxbao also selected **“Duyệt bổ sung intakeId và
projection trước run”** for the clarification amendment described below.
qxbao subsequently approved the integration-gate findings explicitly:
**“Duyệt freeze, ghi rõ findings baseline”** after reviewing the full unit/E2E
counts, baseline reproductions and isolated rerun results. This accepts the
recorded baseline/test-environment findings for W00 freeze; it does not turn
the failed full runs into PASS or waive any production Runtime gate.
No other person's approval or automated approval receipt is implied.

Inputs: `docs/superpowers/specs/2026-10-28-local-web-design.md` and W00 in
`docs/superpowers/plans/2026-10-28-local-web.md`. Those supplied inputs were
untracked in the original checkout; this change does not adopt or overwrite
them. Their content hashes are recorded in the W00 handoff.

## Motivation, scope and owners

Provide a localhost browser surface for the existing workflow, with typed
forms/buttons as well as optional Conversation chat. Structured actions must
not require a model to interpret an approval, and must retain Conversation
intake authority, independent gates and Runtime recovery. `applied` means an
interaction was applied; it never asserts workflow completion.

Affected owners: contracts/integration (this decision and build graph),
Runtime (query, mutation, receipts, replay), Conversation (intake/admission),
Local Server (HTTP security, registry, lifecycle ledger), CLI (composition),
Web (presentation), Herdr adapter (verified optional chat), acceptance (W09).
This W00 decision authorizes contracts/compatibility fixtures/build skeleton only;
no W01–W08 feature implementation or live acceptance claim.

## Package and build decision

The exact dependency direction is:

```text
apps/web @bflow/web -> @bflow/contracts/web
apps/cli @bflow/cli -> @bflow/local-server -> @bflow/runtime
apps/local-server -> @bflow/contracts/web, @bflow/contracts/web-host
apps/cli -> @bflow/web/assets (Node asset resolver only)
runtime -> existing packages, @bflow/contracts
```

Both new application packages live under `apps/`, never `packages/`. The
existing dependency checker permits application composition and forbids leaf
package composition; no checker exception is needed. Local Server must never
import CLI. CLI injects `LocalWorkspaceServices` with canonical repository
resolution; the server never executes a browser-supplied cwd. W00 adds the
local-server/runtime package dependency/reference, without calling Runtime.
W04 adds CLI dependencies/references, not an import of sibling `dist` code.
Asset paths are data returned by `@bflow/web/assets`; no reverse dependency.

`@bflow/contracts/web` imports Zod and browser-safe contract modules only;
never its barrel, Runtime, Conversation, crypto/fs, Buffer, process or a
Node type. Reuse Identifier, IsoDateTime, ApprovalTarget, ApprovalStatus,
SdlcWorkStatus, TaskStatus, RunStatus, AgentTransportState and verification
enums by their authoritative module exports. New strict HTTP envelopes use
`apiVersion: 1`; existing platform envelopes remain version 3, RoleMessage
and SessionManifest remain version 2. New `web-host` subpath is for the
server/host exchange, not browser UI; exporting a schema grants no authority.
The browser bundle's transitive import graph must be tested, not just grep
`web.ts`. Root barrel re-exports are additive after approval.

Accepted package script strings:

| Package | Script | Exact command |
| --- | --- | --- |
| @bflow/local-server | build | `tsc -b` |
| @bflow/local-server | typecheck | `tsc -b --pretty false` |
| @bflow/local-server | test | `vitest run --root ../.. apps/local-server/test` |
| @bflow/web | build | `tsc -p tsconfig.app.json --noEmit && tsc -b tsconfig.node.json && vite build` |
| @bflow/web | typecheck | `tsc -p tsconfig.app.json --noEmit && tsc -b tsconfig.node.json --pretty false` |
| @bflow/web | test | `vitest run --config vitest.config.ts` |
| @bflow/web | test:e2e | `playwright test --config playwright.config.ts` |

Frontend uses Bundler module resolution, React JSX and noEmit; Node asset
resolver uses composite NodeNext with `dist/node`, exporting assets from
`dist/client`. Vite produces `dist/client/index.html` and static assets;
resolver computes that path relative to its module. Root tsc references only
the resolver project, not the app project. Root build runs tsc then the web
build; root integration runs web typecheck/test and Playwright explicitly
(the default Vitest include misses `.test.tsx`). A skeleton may have an
empty test inventory but must report it honestly; it cannot ship a backend
adapter returning fabricated success. W00's asset smoke must verify the
real production output and Node resolver, without adding a W06 screen.

Root pin stays pnpm@12.5.1; supported Node is >=22.13. Frontend pins: React/React DOM 19.2.0, React Router 7.9.5, Vite 6.4.1,
plugin-react 4.7.0, Vitest 2.1.9, Playwright 1.56.1, jsdom 26.1.0, Testing
Library React 16.3.0/DOM 10.4.1/user-event 14.6.1, React/DOM types 19.2.2.
Registry engine ranges for Vite (>=22 supported), React (>=0.10), Router
(>=20), Playwright (>=18) include the existing Node >=22.13 baseline; pnpm
installation and build are recorded in the handoff. No root toolchain upgrade.

## Accepted DTO vocabulary and strictness

All objects, nested objects, query objects and union variants are strict.
Unknown versions/fields fail; parsers must not strip identity/revision data.
Below `?` means optional, `[]` an array, `Id` IdentifierSchema, `Time`
IsoDateTimeSchema, `Token` a nonempty opaque string <=2048 characters.
Every top-level HTTP JSON request/response has `apiVersion: 1`, including
commands, operations, pages, errors and chat. Path/query transport values
are parsed before use. No authority fields are accepted from the browser.

| Name | Fields besides apiVersion |
| --- | --- |
| WebProject | projectId: Id, displayName: text, canonicalPath: text, registrationState: registered/unavailable |
| WebRunView | runId, sessionId, revisionToken: Token, title, originRunId, parentRunId?, continuedAsRunId?, currentRunId, sdlcStatus, coreStatus: RunStatus/null, transportSummary: WebTransportSummary, tasks: WebTaskView[], blockers: WebBlocker[], decisions: WebDecision[], clarifications: WebClarification[], availableActions: WebAction[], updatedAt: Time |
| WebTransportSummary | states: AgentTransportState[], observedAt: Time; diagnostic projection only |
| WebTaskView | taskId, title, status: TaskStatus; no launch material |
| WebBlocker | code: Id, message: text; no raw diagnostic JSON |
| WebEvidenceReference | artifactId, runId, kind: ArtifactKind, mediaType: text, checksum: ArtifactChecksum, sizeBytes?: nonnegative integer; no storage path/metadata |
| WebApprovalVersion | revisionToken: Token, approvalId, target: ApprovalTarget, revision: positive integer, generation: nonnegative integer, evidenceDigest: lowercase SHA-256 hex |
| WebRevisionVersion | revisionToken: Token |
| WebClarification | questionId, question: text, options: text[], expectedVersion: WebRevisionVersion |
| WebIntakeView | intakeId, sessionId, correlationId, title, status: clarifying/admitted/failed, runId? (required when admitted), clarifications: WebClarification[], updatedAt: Time |
| WebDecision | decisionId, runId, kind: approval/user_decision, status: ApprovalStatus, question: text, options: text[], expectedVersion: WebApprovalVersion, evidence: WebEvidenceReference[], expiresAt?: Time |
| WebAction | actionId, kind: WebCommand kind, enabled: boolean, disabledReason?: text, expectedVersion: WebRevisionVersion/WebApprovalVersion; disabled action requires reason |
| WebPage<T> | items: T[], nextCursor?: Token |
| WebOperation | operationId: UUID, projectId, owner: host_interaction/local_lifecycle, operationKind: WebCommand kind/session_start/session_stop, state: accepted/running/applied/failed/reconciliation_required, result?: WebOperationResult, error?: WebApiError, updatedAt: Time |
| WebEvent | cursor: epoch:sequence string, projectId, type: invalidate/operation/notice/chat/reset, resourceIds: Id[], occurredAt: Time |
| WebChatMessage | messageId: UUID, sessionId, runId?, sender: user/conversation, content: text, createdAt: Time, delivery: accepted/queued/delivered/unknown_delivery/failed, source: web/native |
| WebChatSend | messageId: UUID, projectId, sessionId, runId?, content: text |
| WebSessionSummary | sessionId: Id, expiresAt: Time, csrfToken: Token; browser session only |
| WebProjectSession | projectId, sessionId?: Id, state: stopped/starting/ready/stopping/unavailable, conversationStatus?: ConversationSessionStatus, pendingIntakes: WebIntakeView[], blockers: WebBlocker[], updatedAt: Time |
| WebProjectInspection | projectId, ready: boolean, checks: {id: Id, state: passed/failed/unsupported, message: text}[], observedAt: Time |
| WebProjectPreview | projectId, available: boolean, summary: text, blockers: WebBlocker[], observedAt: Time; safe read projection, never an execution plan approval |
| WebArtifactMetadata | artifactId, runId, mediaType, checksum, sizeBytes: nonnegative integer, disposition: inline/attachment, previewLimitBytes: integer <=1048576 |
| WebNoticeDisplayed | noticeId, displayedAt: Time; observation acknowledgement only |

A historical run view keeps its requested runId and its own snapshot; lineage
fields come from delegation/supersededBy metadata. Missing Core admission is
`coreStatus: null`, never a made-up Core run. Transport and Conversation
statuses do not overwrite SDLC status. W01 must paginate or bound projection
collections, never return secrets/launch descriptors/private paths.

### WebCommand (flat discriminated union)

Every variant includes `apiVersion:1`, `commandId: UUID`, `projectId: Id`,
and `kind`. operationId equals commandId, not a new ID on replay.

| kind | Additional exact fields |
| --- | --- |
| create_request | title, requestKind: feature/bugfix/refactor/spike, objective, acceptanceCriteria: WebDraftCriterion[], constraints: text[] |
| revise_request | runId, expectedVersion: WebRevisionVersion, objective, acceptanceCriteria: WebDraftCriterion[], constraints: text[] |
| answer_clarification | exactly one of runId/intakeId, questionId, expectedVersion: WebRevisionVersion, answer: text |
| answer_decision | runId, decisionId, expectedVersion: WebApprovalVersion, outcome: approved/rejected/changes_requested, reason?: text, selectedOption?: text |
| resume | runId, actionId, expectedVersion: WebRevisionVersion |
| cancel | runId, expectedVersion: WebRevisionVersion, reason: text |

`decisionId === expectedVersion.approvalId`; target, revision, generation and
evidenceDigest are required and compared with authoritative host state.
A token is an additional concurrency binding, not approval authority.
`reason` is mandatory for rejected/changes_requested. selectedOption is
allowed only for a user-decision and must match the current host options.
The host checks questionId/actionId and token in its serialized mutation
boundary. No timestamp-based whole-run optimistic locking substitute.

`WebDraftCriterion = {description, verificationMethod}` reuses the enum at
`AcceptanceCriterionSchema.shape.verificationMethod`. Draft criteria are
not accepted AcceptanceCriterion records: they have no satisfied/waived
status, evidence or approval. The feature/bugfix/refactor/spike vocabulary
matches `WorkflowRequestKind` in Conversation; that type is currently
Conversation-local, so contracts cannot import it. Export a new
`WebRequestKindSchema` with those four values, and W02 maps it explicitly
inside the Conversation owner. Existing draft fields have no text maximum;
the following are *new transport bounds*, not existing domain guarantees:
trimmed title 1..200, objective/answer/reason 1..16000 characters, criterion
description/constraint 1..2000; 1..100 criteria and 0..100 constraints.
selectedOption is 1..200 characters. HTTP body <=256 KiB; chat <=16 KiB
UTF-8 (byte count using TextEncoder, not string.length). No implicit trim
on accepted command data: reject whitespace-only but retain exact content
so fingerprints and reviewer evidence remain stable. No browser input for
sddLevel/priority/codeChangesAuthorized/authenticatedUser/decidedBy/binding.
Conversation admission determines policy, authorization and clarification;
insufficient input stays clarifying, never invents approved Specification.
Constraints remain explicit request data in the admitted draft/context.

Owner-approved clarification amendment: Conversation can ask questions before
a delegation/run exists. A stable intakeId identifies the persisted admitted
request/draft and its existing correlationId. `WebProjectSession.pendingIntakes`
exposes its questions/version; `answer_clarification` requires exactly one
runId or intakeId. A clarifying command returns `{kind:'intake',intakeId}`;
after admission the intake projection links the actual runId. No made-up Core
or host run, approved Specification, or fake native hook is created. Existing
runs expose their own clarifications in WebRunView. W02 owns the mapping to
Conversation's actual pending clarification storage.

`WebOperationResult` is a strict union by `kind`:
`interaction {runId,currentRunId,continuedAsRunId?}` or
`intake {intakeId}` or `lifecycle {session:WebProjectSession}`. A create result pins the initial
runId; subsequent lineage changes do not rewrite the receipt. applied
requires result; failed requires error; reconciliation_required may have
safe error but no fabricated conclusive result. Owners/kinds are coupled:
local_lifecycle only session_start/session_stop; host_interaction only the
six command kinds. Chat uses its own message IDs/delivery ledger.

## Frozen interface names (exported by W00)

All Promise results below are `OperationResult<T>` using exported response
schemas. ContractError remains unchanged inside the process boundary.
HTTP adapters map it to the safe WebApiError taxonomy below, never forward
arbitrary `ContractError.details` to the browser.

```ts
interface LocalWorkspaceServices {
  inspectProject(projectId: string): Promise<OperationResult<WebProjectInspection>>;
  startSession(projectId: string, operationId: string): Promise<OperationResult<WebProjectSession>>;
  stopSession(projectId: string, operationId: string): Promise<OperationResult<WebProjectSession>>;
  reconcileSessionOperation(operation: WebOperation): Promise<OperationResult<WebOperation>>;
  preview(projectId: string): Promise<OperationResult<WebProjectPreview>>;
}
interface UserInteractionClient {
  readProjectSession(projectId: string): Promise<OperationResult<WebProjectSession>>;
  listRuns(projectId: string, query: WebRunQuery): Promise<OperationResult<WebPage<WebRunView>>>;
  readRun(projectId: string, runId: string): Promise<OperationResult<WebRunView>>;
  listDecisions(projectId: string): Promise<OperationResult<WebPage<WebDecision>>>;
  execute(command: WebCommand): Promise<OperationResult<WebOperation>>;
  readOperation(projectId: string, operationId: string): Promise<OperationResult<WebOperation>>;
  events(projectId: string, cursor?: string): AsyncIterable<WebEvent>;
  acknowledgeNotice(projectId: string, noticeId: string): Promise<OperationResult<WebNoticeDisplayed>>;
  listMessages(projectId: string, sessionId: string, cursor?: string): Promise<OperationResult<WebPage<WebChatMessage>>>;
  sendMessage(input: WebChatSend): Promise<OperationResult<WebChatMessage>>;
  readArtifact(projectId: string, artifactId: string): Promise<OperationResult<WebArtifactRead>>;
}
```

`WebRunQuery = {cursor?,limit?,search?,sdlcStatus?}` (strict); page default 25,
max 100; search <=200 characters. Other page cursors are opaque and scoped.
`WebArtifactRead = {metadata:WebArtifactMetadata, chunks:AsyncIterable<Uint8Array>}`
is a TypeScript adapter interface, not JSON; metadata alone has an exported
Zod schema. Export a `WebArtifactChunkSchema` for each Uint8Array boundary.
The HTTP consumer calls iterator.return on abort/disconnect and enforces
metadata size/quotas, preview <=1 MiB and bounded chunk <=64 KiB. No Node
Readable/Buffer import in contracts. Event errors terminate the iterator;
SSE reconnect/reset fetches authoritative snapshots. Unsupported capability
returns unavailable/unsupported, not an empty successful production stub.

## Exact HTTP mapping

All routes have prefix `/api/v1`. Table bodies include apiVersion even when
short notation omits it; absent body means **no body**, not `{}`. Unknown
query/header cursor conflicts are 400. Success JSON is a DTO, not an
OperationResult wrapper; failures are WebApiError. All JSON is no-store.

| Method/path | Body/query | Success |
| --- | --- | --- |
| POST /session/bootstrap | {apiVersion:1,secret:Token} | 200 WebSessionSummary + host-only HttpOnly SameSite=Strict cookie |
| GET /session | no body/query | 200 WebSessionSummary, cookie + same-origin read protection |
| GET /projects | no body/query | 200 WebPage<WebProject> (bounded registry, no pagination in v1) |
| POST /projects | {apiVersion:1,path:text} absolute local Git path | 201 WebProject; same canonical repo 200 same WebProject |
| DELETE /projects/:id | {apiVersion:1,confirmed:true} | 204 no body; unregister only, no down; conflict while tracked operation unresolved |
| GET /projects/:id/session | no body/query | 200 WebProjectSession |
| POST /projects/:id/session/start | {apiVersion:1,operationId:UUID} | 202 WebOperation owner local_lifecycle |
| POST /projects/:id/session/stop | {apiVersion:1,operationId:UUID,confirmed:true} | 202 WebOperation owner local_lifecycle |
| POST /projects/:id/session/inspect | {apiVersion:1} | 200 WebProjectInspection; doctor observation only |
| GET /projects/:id/preview | no body/query | 200 WebProjectPreview; no prepare/activate |
| GET /projects/:id/runs | WebRunQuery encoded as query, no body | 200 WebPage<WebRunView> |
| GET /projects/:id/runs/:runId | no body/query | 200 WebRunView |
| GET /projects/:id/decisions | no body/query | 200 WebPage<WebDecision>; bounded current inbox |
| POST /projects/:id/commands | WebCommand; projectId must match path | 202 WebOperation owner host_interaction |
| GET /projects/:id/operations/:operationId | no body/query | 200 WebOperation; dispatch read by durable owner index |
| GET /projects/:id/artifacts/:artifactId | no body/query | 200 bytes + safe content type/disposition; no arbitrary path/URI |
| GET /projects/:id/events | cursor?:Token query OR Last-Event-ID, not both | 200 text/event-stream WebEvent data; reset on lost epoch/range |
| POST /projects/:id/notices/:noticeId/displayed | {apiVersion:1} | 200 WebNoticeDisplayed; no user turn/approval |
| GET /projects/:id/sessions/:sessionId/messages | cursor?:Token | 200 WebPage<WebChatMessage> |
| POST /projects/:id/sessions/:sessionId/messages | WebChatSend matching path project/session | 202 WebChatMessage; delivery is not task success |

Synchronous command replay also returns 202 with the *same* operation even
when final. No new effect. A valid async input must have a durable acceptance
receipt before 202. No 202 after an unpersisted best-effort enqueue.

`WebApiError = {apiVersion:1,code,message,retryable,operationId?,correlationId,
details?:{field?:text,resourceId?:Id}}`. Details are allowlisted/redacted;
no arbitrary JSON, filesystem paths, stack, proof or credentials. Export
`WebApiErrorSchema` and `WebApiErrorStatus` mapping with exactly these codes:

| HTTP | code | retryable |
| --- | --- | --- |
| 400 | invalid_request | false |
| 401 | session_required | false |
| 403 | forbidden | false |
| 404 | not_found | false |
| 409 | stale_version / operation_conflict | false |
| 413 | payload_too_large | false |
| 422 | operation_not_allowed | false |
| 503 | unavailable | true |
| 503 | reconciliation_required | false |

retryable unavailable permits retrying an observation, not resending a
mutation whose delivery is uncertain. A 503 after a durable intent includes
operationId and callers read it. Domain failure after acceptance is observed
in WebOperation (GET remains 200), not retroactively an HTTP failure.

## Authentication, WebPrincipal proof and Conversation authority

Bind 127.0.0.1:4317 by default. Exact Host including selected port and exact
Origin for bootstrap/mutations, cookie/same-origin protection for reads and
SSE; deny null/cross-site, no wildcard CORS. Bootstrap secret is single-use,
TTL 60 seconds, in URL fragment only. Session TTL 12 hours, no sliding
extension; server restart invalidates sessions. GET /session recovers CSRF
for another tab/reload, not via consumed bootstrap. CSRF stays in memory.
Nothing private in browser storage, event data, errors, locator URL or logs.

Proposed `WebPrincipal` in `contracts/web-host` is a *host-verifiable proof*,
not a boolean provenance field: `{schemaVersion:1,source:'local_web',issuerId,
keyId,principalId,browserSessionId,projectId,hostSessionId,capability:
'user_interaction',commandId,commandDigest,issuedAt,expiresAt,nonce,signature}`.
All fields except signature are covered by Ed25519 signature over canonical
UTF-8 JSON (sorted ASCII object keys, ordered arrays, no undefined/NaN).
Digest covers parsed full command, including apiVersion/project/commandId
and exact expectedVersion. Proof life <=60 seconds; reject future issuance
beyond 5 seconds, expired/wrong host session/key/scope/capability/digest.
Nonce is consumed with durable acceptance, replay tied to that command.

CLI owner composition registers the Local Server public key with the host
using owner-only private IPC, canonical project identity and dedicated
capability registration. Role-tool credentials cannot register keys or call
interaction ingress; browser session credentials cannot call role tools or
coordinator/specialist APIs. Local Server holds its signing key in private
user-owned state; it never sends a private host/Herdr token to the browser.
Host restart requires re-registration through the owner path, not accepting
a key supplied in a request. Issuer/key rotation does not change the stable
local principal or erase operation history. HTTP sessions are ephemeral;
operation identity is scoped to stable local principal + project + UUID.
This is local-user isolation, not protection from a hostile same-UID process.

W02 must add a Conversation-owned structured-intake entry which validates
and admits WebCommand through the same requirement/decision/cancel/resume
policy as native turns. Runtime authenticates proof before that entry; a
role cannot mint it with `authenticatedUser:true`. Structured intake needs
no Conversation-model turn, but requires activated host/Coordinator readiness.
Host mutation serialization rechecks pending target/version, lease/fence,
independent verdicts, approval, test-integrity and bounds before effect.
There is no synthetic `UserPromptSubmit`/`PreInvocation`, PaneBinding or fake
physical turn for web. Model-generated text and notice-display/nudge cannot
become a trusted user turn. Chat W08 is separate from structured commands.

## Host operation replay, receipt codec and compatibility

Local Server first persists an owner index keyed by project + stable local
principal + commandId, including immutable owner, operationKind and canonical
command fingerprint. Host-owned index records also pin the originating
hostSessionId and opaque receiptId (commandId) in that session's journal;
lookup is project/principal scoped across later host sessions. Historical
receipt reads validate against the original session context and project,
never relabel an old receipt as belonging to the current session. New-session
submit first checks that index: an old ID returns the original operation or
reconciliation_required if its original evidence is unavailable, never
resends to the new host. Local lifecycle indices have no hostSessionId.
The exported WebOperationIndexRecordSchema validates these bindings. Only then may it forward. Restart/read dispatches by
that owner, never by whether the host happens to be running. Lifecycle start/
stop belongs to Local Server's durable ledger even before/after host life;
reconcileSessionOperation observes existing manifests/receipts/locks and
cannot resend an uncertain mutation. Host readOperation never serves a
local_lifecycle record. An ownership/kind/body mismatch returns conflict.

Host atomically admits intent under its serialized operation boundary and
persists receipt before side effects/ack. Same identity + same fingerprint
returns existing operation/result, even with a newly authenticated proof;
same identity + changed body is 409. Fingerprint excludes server-generated
proof, acceptance/update timestamps, not command fields or target evidence.
Missing acknowledgement, stopped host, or transport timeout is not proof of
non-delivery. After restart reconcile intent against authoritative effect
receipts/lineage/gates: prove applied/failed, or reconciliation_required.
Never auto-resend unknown_delivery. One approval target/revision/generation
is settled once across native and web; contrary later input is stale/conflict.

Keep legacy HostReceiptJournal envelope **version 1** and `human`,
`conversation-turn`, native-intent/native-ack payload/checksum/filename
algorithms unchanged. Existing human provenance is UserPromptSubmit or
PreInvocation with real validated binding/anchor; web never enters that
parser. Proposed exported `WebInteractionReceiptSchema` is a distinct
version-2 envelope: `{version:2,repository,sessionId,kind:'web-interaction',id,
payload:{principal,command,fingerprint,operation},checksum}`. id is scoped
command identity; repository/session must match host context. Reader first
dispatches exact version/kind, then validates checksum and cross-field
identity/digest. Unknown versions/kinds fail closed.

New receipt storage is separate from native-v1 records. Upcaster is a
read-only tagged view: `{source:'native',receiptVersion:1,payload}` or
`{source:'local_web',receiptVersion:2,payload}`; it does not rewrite v1 bytes,
re-sign native evidence or infer web provenance. Recovery of an already
accepted web intent verifies durable checksum/identity and stored proof at
acceptance time, not current browser-session TTL; expired sessions cannot
submit new commands. Old binaries do not understand v2; while web intents
are pending, downgrade is unsupported and must report it rather than drop
records. No SQL/domain-event migration or public native signature change.
The W00 codec validates version, checksum, full command fingerprint and
identity consistency. It does not authenticate the Ed25519 signature,
registered issuer, live expiry or nonce; W02 must implement those checks
before trusting a parsed proof. The tagged replay view is a type only;
actual native/web journal dispatch and replay remain W02 implementation.
W00 approval-following fixtures must verify codecs and browser-safe schemas;
W02 implements actual host reads/replay under runtime ownership.

## Retention and migration fixtures

Private registry/owner index/lifecycle ledger/signing keys: user-owned
0700 directories, 0600 files, no secrets in artifacts or commits. Keep
operation records and fingerprints while the corresponding host/run/receipt
exists; no automatic expiry allowing reuse of a commandId. Explicit project
unregister is blocked by unresolved operations; finalized records remain
private tombstones so re-registration cannot replay old effects. Browser
sessions/bootstrap secrets are not archived. Chat is bounded/paginated and
retained with the Conversation session; SSE ring is ephemeral (1000/project,
100 queued/client, heartbeat 15s, reset on epoch loss). Unregister never
cancels/down/removes a host repository. Disk/quota failure fails closed
before acceptance. No promise of power-loss/multi-host durability is added.

Fixture bundle in `packages/contracts/test/fixtures/local-web` contains synthetic design,
delivery and specialist user-decision ApprovalRequests/ApprovalDecisions,
native-v1 envelope examples, proposed structured commands and negative
vectors. These are public test data, not real hooks, human approvals or
signed web proofs. The executable compatibility test only parses existing
exported schemas; it cannot certify HostReceiptJournal replay. W02 must
reuse the native envelope vectors in Runtime's actual journal replay tests
(including real checksum/identity validation) without a cross-owner patch.

## TddDecision and acceptance gate

W00 plan's policy: required for trust/replay/isolation/security contract
behavior (missing schema RED, implement additive schemas, GREEN); recommended
for DTO mapping; not_applicable for docs/build scaffold with alternative
verification: package graph, tsc references, browser bundle/asset smoke and
package scripts. This records the supplied policy; no fabricated domain
TddDecision acceptance or humanOverrideApproved receipt is created.

W00 approval/checklist:

- [x] Inspect real instructions, spec/task, baseline/ref/worktree state.
- [x] Publish concrete decision, exact DTO/interface/HTTP proposal and fixtures.
- [x] Project owner qxbao explicitly approves D-WEB-01 and intake amendment (above).

Implementation verification (actual results and final SHA in handoff):

- [x] RED tests for web roundtrip, unknown version/extra fields, exact stale
  approval binding, native compatibility and transitive browser imports.
- [x] Add public schemas/exports, test codecs, minimal package entries/configs.
- [x] Verify exact tool versions/engines; install via pinned pnpm and lock.
- [x] Build root plus frontend/resolver; verify assets/no Node or server secret.
- [x] Run check:deps, typecheck, affected tests and full integration suite;
  web build/typecheck/test/test:e2e explicitly, recording actual inventory.
- [x] Freeze accepted interfaces and publish integration SHA for W01/W03.

Only the final verified W00 commit in the handoff is a schema-freeze baseline.
Intermediate work and a passing contract test alone do not open W01/W03.
W01–W08 must not silently alter these exported schemas after freeze.

## Implementation details that preserve compatibility

ConversationSessionStatusSchema moved to browser-safe conversation-status.ts;
session.ts re-exports the same schema/type and uses the same enum values.
This avoids importing Node-bearing role profiles in web projections. No native
contract semantics change. Browser tests walk the transitive source closure.
`WebHttpContracts` exports the exact route/body/query/response/status table;
stream response schemas describe SSE data/artifact metadata, not JSON-wrapped
artifact bytes. `WebRunHttpQuerySchema` parses decimal URL limits, while the
client query accepts numeric limits. Project registry is bounded to 100;
unpaginated decision overflow must return unavailable, never silently hide
pending decisions. Paginated messages/runs use opaque cursors.

Root `build` builds tsc plus web frontend; `typecheck` includes web; `test`
runs default unit tests and dedicated web tests; `test:web:e2e` builds then
runs the separate Playwright config. CLI dependency/reference wiring remains
W04; no legacy mutation API is called by this skeleton.

Final review fixes before freeze: `UserInteractionClient.readProjectSession`
is the read-only port for GET project session/pendingIntakes (part of the
owner-approved intake projection amendment). It must never activate a host.
Malformed nested commands make receipt safeParse return failure, not throw.
Browser closure checks include an actual directory with spaces.

## W00 integration gate disposition (owner-approved findings)

Build/typecheck/dependency checks and 27 W00 unit tests plus one actual Chrome
asset smoke pass. Full unit run: 6050 passed, 9 failed, 81 skipped; full E2E:
83 passed, 1 failed, 7 skipped. The full runs are not labelled PASS. The six
CLI failures reproduce on rebuilt baseline 7b158c4 with inherited isolator
selectors. Three P19 failures were timing/load observations; those cases pass
on baseline and all nine failed unit cases pass on W00 when run in isolation
with fixture environment selectors removed. The E11 systemd-user readiness
failure also reproduces on rebuilt baseline. Exact commands/results and
follow-up ownership are in the W00 handoff. qxbao accepted these findings for
freeze (approval quoted above). No other owner's production/tests were edited.
