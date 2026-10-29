# @bflow/web

W06 implements the local Vietnamese read UI. Serve `dist/client` with the real
Local Server (`bflow web` after a root build). Vite preview alone has no API and
shows a pairing error; there is no production mock mode, proxy or security bypass.
Browser code imports only the browser-safe `@bflow/contracts/web` subpath.
`@bflow/web/assets` remains the separate Node asset resolver.

## Screen and state mapping

| Screen | Components / data | States |
| --- | --- | --- |
| Quản lý dự án | AppShell, native project select, project cards, absolute-path registry form | Loading, empty, unavailable, registration error; registration observes an existing Git root only |
| Tổng quan | Session readiness, pending intakes, recent run page, pending decisions, preview, ephemeral feed timeline | Stopped/starting/ready/stopping/unavailable; browser connectivity independent of session and transport |
| Công việc | Search/phase URL filters, cursor pages, run detail, tasks/blockers, lineage links | Pre-Core null, all engine/task statuses, unknown/done terminal observations, historical continuation, empty/error/stale |
| Cần bạn quyết định | DecisionCard, revision/status/expiry, safe evidence | Pending/expired/superseded etc. as returned; view-only, no approval inferred from phase |
| Cài đặt dự án | Read-only inspect, configuration readiness, separate diagnostics disclosure | Failed/unsupported checks, missing host and remediation; no terminal editor or message scraping |
| Trò chuyện | Run detail panel on the same Conversation session | Claude/Codex adapters; unsupported/unavailable sessions keep direct actions |

Workflow create/revise/clarification/approval/resume/cancel and lifecycle start/stop
controls belong to W07. The registry form and read-only inspect call the frozen
HTTP endpoints, never a traditional mutation CLI or fake host hook.

## Design and accessibility

Read the actual `docs/DESIGN.md` and installed
`.agents/skills/ui-ux-pro-max/SKILL.md`. Ran its `--design-system` query, narrowed
an off-topic marketing pattern with `workflow dashboard --domain product`, plus
React async/error/testing and contextual screen-reader status searches. Applied
semantic landmarks, native keyboard select, route focus, visible labels, inline
errors, 44px controls, progressive disclosure, contextual status, long-token
wrapping and reduced motion. DESIGN overrides palette/font/marketing suggestions.

Tokens: ivory `--z-bg`, ink/mute/accent/steel semantic text colors, 1px hairlines,
square cards/controls, flat surfaces, four font roles, 4/8px spacing, light only.
The prescribed Big Shoulders Display / Inter / IBM Plex Sans / JetBrains Mono
Vietnamese/Latin/Latin-ext variable WOFF2 faces are served locally under
`public/fonts`, with SIL OFL notices. No external fonts/network request or CSP
relaxation. Font source: Google Fonts CSS service and Google Fonts repository
license files. Body 18px (17px on small screens), detail titles 32px, responsive
display titles; a yellow registry CTA uses ink text. No workflow CTA is invented.

Desktop sidebar layout; gutters reduce at 900px, navigation stacks at 720px.
Focus rings are 3px; text colors follow DESIGN's AAA pairs. Screenshot inspection
and browser overflow checks cover 1440/1280/768 and 375px. These are local browser
checks, not comprehensive WCAG certification or owner visual acceptance.

## HTTP, events and recovery

Bootstrap fragment is consumed and erased synchronously before rendering or
requests. Cookie session recovery uses GET `/api/v1/session`; CSRF stays only in
ApiClient memory, mutations include X-Bflow-CSRF, all calls stay same origin with
cookies/no-store, responses parse frozen schemas. Expiry unmounts protected views.
No credentials, private host token, operation authority or app state in storage.

SSE validates schema/project/type/cursor, then invalidates authoritative reads.
Errors close and recreate EventSource with bounded 3–30s backoff and the last
validated cursor; each new instance avoids query/Last-Event-ID conflicts. Cleanup
closes streams/timers. Reset reloads snapshots. Slow reads coalesce invalidations
and publish completed observations rather than discarding every response. Offline
retains a labelled snapshot; failed refresh explicitly labels retained data stale
until a successful read. No uncertain mutation is retried or auto-submitted.

Artifacts only use project/opaque artifact IDs. Inline previews require the
server's inert text/plain + inline response and enforce the 1 MiB byte cap; React
text nodes render content, never HTML/Markdown links/images/scripts. Other content
is download-only. Source services retain trust, checksum and project authorization.

## Known frozen-interface limits / integrator proposals

- W05 provides notice IDs without notice text/read endpoint. Feed receipt never
  acknowledges display. No `displayed` POST is sent by this UI. Integrator needs
  an approved bounded notice-content DTO/endpoint before general notice rendering.
- Run DTO exposes tasks/decisions/evidence but no standalone plan/diff/change-set
  catalog, full historical timeline or pane-output endpoint. Available evidence
  is readable from decisions; missing information is stated rather than invented.
  Timeline is explicitly limited to this page's observed feed and snapshot time.
- W01 decision aggregate cannot paginate beyond the frozen cap; errors link to
  paginated work views. No shared schema amendment is made here.
- Affected selector finds this package, but its execution invokes the root Vitest
  config, whose include omits `.test.tsx`. It also classifies Playwright `.spec.ts`
  as unit input. Integrator should dispatch `@bflow/web test` and `test:e2e` under
  their dedicated configs; no root/script edit is authorized in this task.

## Verification

From repository root, using pinned pnpm/Node >=22.13:

- `pnpm run build` before subprocess/browser tests (builds the CLI/Local Server).
- `pnpm --filter @bflow/web build` / `typecheck`.
- `pnpm --filter @bflow/web test` uses the dedicated jsdom/TSX config.
- `BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web test:e2e`
  selects an existing browser; unset to use Playwright-managed Chromium.
- `pnpm test:affected --base <baseline>` prints selection. See runner gap above.

Browser smoke launches the built CLI under a test PTY (`script`), isolated
BFLOW_HOME and temporary real Git repository; pairs through real cookie/CSRF
HTTP, registers a path, observes missing host/SSE retry, reloads a deep link,
checks responsive overflow, font loading, focus and reduced motion. It never
starts a provider/Herdr host. Synthetic fixture data exists only under `test/`.
Screenshots/results stay ignored under `dist/test-results`; no tokens/logs/state
or generated output is committed. Exact measured results are in `W06-HANDOFF.md`.

## W07 direct actions

The overview now offers a structured request form, intake clarification and
explicit session start/stop. Run detail offers exact-question clarification,
full requirement replacement, exact-action resume and confirmed cancel. Review
pins the version, generation, target and evidence digest; stale or expired
packages require an explicit reread. User decisions can select an option;
ordinary approval metadata never becomes a selected option. All workflow commands
use the frozen HTTP API and Conversation-owned ingress, without sending terminal
text or a Conversation model turn. Runtime still grants authority independently.

The forms reuse W06 tokens/components and DESIGN's light, square, hairline
conventions. The installed UI skill's focused error-summary/validation and
confirmation/focus guidance is applied. Inline confirmation moves focus to its
heading and offers a return button; validation has field-linked errors and a
focused summary. Textareas use the existing semantic tokens.

Recovery records in origin-local storage contain only project/browser-session
scope, action slot, operation ID, kind and SHA-256 body fingerprint. They retain
no command body, credentials, action version or approval authority. Same-project
records from earlier browser sessions are observed after server re-pairing;
current server authentication still authorizes every read. Request drafts live
in session storage under project/host/browser-session keys. Drafts may contain
user-entered requirements: avoid entering secrets. No server credentials or
CSRF token are persisted. Web Locks serialize tabs and recheck the durable ID
inside the lock; browsers without Web Locks cannot mutate.

Reload/back/resubmit only reads an existing operation. Timeout, invalid response,
404, offline and reconciliation-required never authorize an automatic new POST.
A definitive refusal permits correction; a conclusive applied/failed operation
can be cleared only with the explicit “Bắt đầu thao tác mới” control, which
rereads it first. HTTP 202 and operation applied are distinct from workflow
completion. Cancellation acceptance remains unconfirmed until the run snapshot
reports cancellation. Follow-up links keep historical evidence on the parent.

Frozen-interface limitations: WebRunView has no original requirement draft, so
revise explains that it replaces the complete objective/criteria/constraints;
it cannot prepopulate authoritative original criteria. Session DTO has no
availableActions list: create/start/stop reread readiness and defer authority to
server/host; run mutations use availableActions. Clarification is the existing
question/version capability validated directly by HostStructuredCommands; Runtime
does not emit an answer_clarification action. No missing public field is invented.

Run after the root build:

```sh
pnpm --filter @bflow/web test
BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web exec playwright test e2e/direct-actions.spec.ts
```

The browser scenario serves the production bundle through the actual Local
Server with real HTTP cookies/CSRF, a temporary Git root and deterministic
injected host fixtures. It checks host command/effect counts via test-process IPC,
including two tabs, lost response, restart/re-pair, stale review, intake/run
clarification, follow-up navigation, resume/cancel and session lifecycle. There
is no production mock mode or additional test HTTP endpoint. Separate existing
Runtime/Conversation integration tests exercise structured admission without a
model. These checks do not establish live Herdr/provider/full SDLC acceptance.

See W07-HANDOFF.md for measured results and integration-owned runner proposal.

## W08 optional chat

Run detail includes normalized session history and a bounded text composer. It uses
the same authenticated HTTP origin and run/session as direct actions. The host
rechecks readiness and native binding; successful history alone grants no authority.
Claude/Codex adapters use correlated real native hooks and provider transcript IDs.
Agy Conversation remains unsupported. Native registration or transcript capability
missing means chat stays unavailable while direct forms/buttons remain usable.

A message ID is reserved before POST. Lost ACK/reload/multiple tabs observe that
original ID; the browser never automatically resends. Local storage holds only
recovery IDs, not message content or credentials. Queued/unknown/delivered are
transport states, never workflow success. Approval buttons retain exact versions
and independent Runtime gates. See [W08 handoff](W08-HANDOFF.md) for measured
source, browser-fixture and isolated live-adapter evidence and their limits.
