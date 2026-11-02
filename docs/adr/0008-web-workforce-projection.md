# ADR 0008 — D-WEB-03: web workforce projection and Pixi visualization dependency

Status: **ACCEPTED by project owner** (2026-11-02). The owner approved D-WEB-03,
the exact dependency `pixi.js` 8.22.0 for `apps/web`, the limit of pixel-art
styling to the canvas, and that Classic remains the default view. No approver
name or verbatim approval wording is recorded here. Schema freeze occurs only at
the verified integration commit identified in the implementing handoff.

Nothing in this ADR is live-verified. It records a design decision and its
compatibility rules. No Herdr, Chrome, browser, or provider evidence exists for
the Workforce view or the Pixi canvas at the time of writing.

Inputs: the supplied planning sections `section-4.1-data.md` (§4.1 and §4.2) and
`section-3.3-tech.md` (§3.3) under
`.superpowers/sdd/2026-11-02-web-visualization-mode/`. Those inputs are not
tracked in this repository; this ADR copies the contract names and rules it
depends on. It amends the pinned frontend set in
[ADR 0006](0006-local-web-interaction.md) and builds on
[ADR 0007](0007-local-web-composition.md).

## Motivation, scope and owners

Users cannot see which agent holds which work, or what was handed to whom,
without guessing from the run view. `WebRunView` and `WebTransportSummary` are
strict and carry no per-role transport state, so the Web UI cannot show it
(open item UX-16 in `apps/web/UX-HANDOFF-STATUS.md`; `apps/web/README.md` notes
that such a field needs an additive contract decision).

This ADR adds two read-only projections, a Workforce view and a run activity
view, and one optional dependency for the Visualization Mode canvas. The domain
name is `Workforce`, not `Office`: contracts must not contain presentation
concepts, and the Classic view may reuse the same data.

Out of scope: any new command, any write path, any new SSE event kind, and any
change to existing web or native contracts.

Affected owners:

- **Contracts**: additive schemas and HTTP route entries in `packages/contracts/src/web.ts`.
  Public contract change under `AGENTS.md`; this ADR is its integration decision.
- **Runtime**: new projection `packages/runtime/src/interaction/workforce.ts`, and
  the projection fingerprint in `packages/runtime/src/agentic/host.ts`
  (`webProjectionFingerprint`).
- **Local Server**: two read-only GET routes and the client adapter methods.
- **Web**: Visualization Mode in `apps/web`, the `pixi.js` dependency, and the
  degraded tier when the Workforce view is unavailable.
- **E2E fixtures**: the CSP test and the bundle-separation test described below.

The CLI is not changed by this ADR.

## Decision: contracts (additive only)

The following schemas are added to `packages/contracts/src/web.ts`. Existing
schemas are not edited. The shorthand names (`id`, `time`, `token`, `version`,
`uuid`, `nonblank`) map to the existing contract primitives in that module.

```ts
WebAgentWorkSchema = z.object({
  messageId: id, kind: z.enum(["assignment","delegation","verification"]),
  runId: id, taskId: id.optional(), attemptId: id.optional(),
  delivery: z.enum(["queued","sending","accepted","released","unknown_delivery","failed","cancelled"]),
  acceptedAt: time.optional(), turnSeenAt: time.optional(), leaseExpiresAt: time.optional()
}).strict();

WebAgentViewSchema = z.object({
  instanceId: id,                // "agent-" + digest(bindingId); does not expose the pane
  role: AgentRoleSchema, profileId: id.optional(), displayName: nonblank(200),
  group: z.enum(["conversation","coordination","verification","developer_worktree"]).optional(),
  permanent: z.boolean(), provider: nonblank(100), model: nonblank(200).optional(),
  allocation: z.enum(["active","released","stopped_retained"]),
  transport: z.object({ state: AgentTransportStateSchema, observedAt: time }).strict(),
  boundAt: time, work: z.array(WebAgentWorkSchema).max(8)
}).strict();

WebHandoffViewSchema = z.object({
  handoffId: id, ordinal: z.number().int().nonnegative(), runId: id, taskId: id.optional(),
  messageType: nonblank(80), direction: z.enum(["outbound","inbound"]),
  from: z.object({ role: nonblank(32), instanceId: id.optional() }).strict(),
  to: z.object({ role: nonblank(32), instanceId: id.optional() }).strict(),
  state: z.enum(["queued","sending","accepted","delivered","released","applied",
                 "rejected","unknown_delivery","failed","cancelled"]),
  evidence: z.array(WebEvidenceReferenceSchema).max(20)
}).strict();

WebWorkforceViewSchema = z.object({
  apiVersion: version, projectId: id, sessionId: id, revisionToken: token,
  agents: z.array(WebAgentViewSchema).max(100),
  handoffs: z.array(WebHandoffViewSchema).max(100),
  truncated: z.boolean(), observedAt: time
}).strict();

WebActivityEntrySchema = z.object({
  entryId: uuid, occurredAt: time, kind: nonblank(32), role: nonblank(32), action: nonblank(80),
  runId: id, taskId: id.optional(), outcome: nonblank(240).optional()
}).strict();
```

HTTP additions (`WebHttpContracts`):

| Method/path | Body/query | Success |
| --- | --- | --- |
| GET `/api/v1/projects/:id/workforce` | no body/query | 200 `WebWorkforceViewSchema` |
| GET `/api/v1/projects/:id/runs/:runId/activity` | `cursor?` query | 200 `WebPageSchema(WebActivityEntrySchema)` |

Optional client methods added to `UserInteractionClient`:

```ts
readWorkforce?(projectId): Promise<OperationResult<WebWorkforceView>>;
readRunActivity?(projectId, runId, cursor?): Promise<OperationResult<WebPage<WebActivityEntry>>>;
```

Both methods are optional, following the existing optional configuration ports
in `LocalWorkspaceServices`.

Rules carried by the schemas:

- `transport` is a diagnostic projection. It never overwrites `WebRunView`
  SDLC status, and `delivery` is not task success.
- `allocation` values are fixed in Task V5.1, not in this ADR. The full table is
  deferred to that task.
- `messageType` is taken from the enum, never from model-written text.
- `WebAgentWorkSchema.acceptedAt`, `turnSeenAt` and `leaseExpiresAt` are
  observation timestamps from the host snapshot. Clients compare them with
  `observedAt`, not with the browser clock.
- No new SSE kind is added. The existing `invalidate` event is sufficient.
  Adding a kind would require editing the strict `WebEventSchema`.

## Decision: Runtime projection (`packages/runtime/src/interaction/workforce.ts`)

| Field | Source | Rule |
| --- | --- | --- |
| `agents[]` | `manifest.panes` | Keyed by `bindingId`. Panes released for more than one hour are not listed. |
| `allocation` | `metadata.allocationStatus`, `transportState` | Full value table fixed in Task V5.1. |
| `displayName` | `roleProfiles` snapshot, otherwise the role name | Passed through `redact`. |
| `work[]` | `state.outbound` where `handle.target.agentId === binding.agentId`, kinds `task.assignment`, `delegation.request`, `verification.requested`, not yet closed | Drop `parentAssignmentId` so work is not counted twice. |
| `turnSeenAt` | `out.turnObservedWorkingAt` | Observed once. |
| `leaseExpiresAt` | `out.lease.expiresAt` | Compared with the snapshot `observedAt`. |
| `handoffs` outbound | `state.outbound`, last 60 entries of the session | `ordinal` is the array index. |
| `handoffs` inbound | `state.inbox`, last 40 entries | No required `occurred_at`, so `ordinal` is kept separately per `direction`. |
| `evidence` | `message.artifact_references` | Read through `readScopedArtifact`, as today. |

A `RoleMessage` payload never leaves the host.

Fingerprint: `webProjectionFingerprint` (`packages/runtime/src/agentic/host.ts`,
around lines 486–493) must include `readWebQuery({kind:"workforce"})`. Without
it, a change in work assignment does not produce an `invalidate` event. Every
time field that changes between snapshots must sit under `observedAt`, so the
existing `stable()` normalization removes it from the fingerprint.

## Decision: Pixi visualization dependency (amends ADR 0006)

ADR 0006 lists the pinned frontend set. This ADR adds one entry to it:

| Package | Pin | Scope |
| --- | --- | --- |
| `pixi.js` | exact `8.22.0` in `apps/web/package.json` | Core package only (MIT). The integrator updates the lockfile. |

Not added: `@pixi/tilemap` (the fixed small map can be flattened with
`cacheAsTexture`) and `easystarjs` (pathfinding on a small grid is under 100
lines of plain code).

Isometric pixel art is a 2D sprite problem. Depth is draw order, so no 3D
camera, lighting or mesh is needed. The choice of PixiJS over Three.js is
recorded in `section-3.3-tech.md` §3.3.

Mandatory settings and conditions:

1. **`import 'pixi.js/unsafe-eval'`** must be imported before any Pixi use. The
   name is misleading: this module replaces runtime code generation with a
   polyfill. It does not require CSP `unsafe-eval`. The design reports a spike
   with zero violations; that spike is not live-verified.
2. **`Assets.init({preferences:{preferWorkers:false}})`** must run before any
   asset is loaded.

Further conditions:

- `preference: 'webgl'`. WebGPU is not used in v1.
- The Playwright test `csp-office` fails on any `securitypolicyviolation`. This
  guards against regressions when Pixi is upgraded.
- The Pixi code is loaded only with `import()` when Visualization Mode is
  entered. A bundle test must prove that the Classic chunk does not contain Pixi.
- Pixel-art styling is confined to the canvas. Surrounding UI keeps the regular
  design system.
- Classic remains the default view.

## Compatibility

- **Optional methods.** Clients that lack `readWorkforce` or `readRunActivity`
  treat the feature as unsupported. The web client calls the methods only when
  they exist.
- **Old backends.** The design expects an old backend to answer
  `operation_not_allowed`. In `packages/contracts/src/web.ts` that code is HTTP
  422, and `apps/local-server/src/errors.ts` already maps `unsupported_version`
  to it. An old backend without the route at all may answer `not_found` (404)
  instead. The implementation must verify what an old backend actually returns
  for the two new routes before it treats a response as "unsupported". Other
  errors are not treated as unsupported.
- **Unchanged.** `WebRunView`, `WebEvent`, `WebCommand`, operation receipts, the
  native and web host journals, and the event and checkpoint codecs are not
  changed. No migration, no SQL change and no stored-data rewrite.
- **No new permission.** Both routes are read-only and use the same cookie,
  Origin and session checks as the existing GET routes. No browser-supplied
  authority is accepted.
- **Degradation.** If the Workforce view is unavailable, the Web UI falls back
  to the degraded tier, with no Workforce view. Classic remains available.

## Rollback

- Remove the two GET routes, the two optional client methods and the
  `webProjectionFingerprint` addition. The Web UI then uses the degraded tier.
- The additive schemas may be left in place as unused exports, or removed in the
  same change. No persisted data refers to them.
- Remove `pixi.js` from `apps/web/package.json`. The integrator regenerates the
  lockfile. Classic is unaffected because the Pixi chunk is loaded lazily.
- No data needs to be reverted: the feature stores nothing.

## Activity log (v1): diagnostic and possibly incomplete

`WebActivityEntry` is a diagnostic, bounded, paginated projection. It is not an
audit trail. Entries can be missing or can roll off as the bounded windows move,
and an `outcome` is free text, not evidence. The UI must label the activity log
as diagnostic and possibly incomplete. It must not use it for approval, delivery
or completion decisions.

## Acceptance and evidence

- This ADR does not create a `TddDecision`. Each implementation task sets its
  own, under the existing SDD and TDD policy.
- The `csp-office` Playwright test and the Classic bundle-separation test are
  required gates for the Pixi change. Neither has been run.
- Bounds in the schemas (`max(100)`, `max(8)`, `max(20)`, the 60- and 40-entry
  windows) are enforced by tests in the implementing tasks. They are not claimed
  as verified here.
