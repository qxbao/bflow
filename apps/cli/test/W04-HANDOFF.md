> Historical partial handoff for c7d8148/7c19443. The project owner subsequently
> approved bounded W04 integration on 2026-10-29. See
> [the integration handoff](W04-INTEGRATION-HANDOFF.md) for current disposition.

# W04 — CLI web command and lifecycle composition

Status: **PARTIAL / BLOCKED on integration-owned seams**. The independent W04
command, owner/reuse control, production asset checks and lifecycle service
implementation are delivered. This is not a complete usable-web or integration
PASS. Default CLI composition explicitly reports missing registry/interaction
wiring, and refuses the corresponding backend actions rather than manufacturing
credentials, paths, physical hooks or successful results.

## Baseline, isolation and commits

Baseline: `20a38a5ebdfaf8fcc81744d913767f5184cab119` (main and origin/main at
selection). Source implementation commit: `c7d8148e9364700c318ad230119e13e9d354f7e9`.
Handoff-only commit follows it on `agent/cli/w04`.
Worktree: `.worktrees/local-web-w04`, retained for integration.

Read filesystem AGENTS.md, W04 plan/spec, W00 freeze handoff/ADR0006 and the W01,
Runtime/Conversation W02 and W03 handoffs. Inspected HEAD, status/index,
worktrees, local/remote refs, ancestry and patch equivalence. Baseline retains
P24 `8dbb056`, W00 `2bd99d8`, W01 `114de68`, integrated W02 `3aa2943` and W03
`f2e18cb`/`a2764ef`. `git cherry HEAD agent/local-server/w03` reports no missing
patches. Existing W03 worktree and clean main checkout were preserved. No reset
to survey `7b158c4`, branch switch in another worktree, fetch, push, PR or merge.

## Owned paths and implementation

Only `apps/cli/**` changed:

- `src/web-command.ts`: dedicated strict web argument parser; foreground web
  owner; default 127.0.0.1:4317; exact port errors; private owner guard/locator;
  verified same-home instance reuse; browser opener with argv and shell:false;
  terminal-only pairing fragment and safe manual fallback; SIGINT/SIGTERM cleanup.
- `src/web-workspace-services.ts`: injected LocalWorkspaceServices, scoped
  canonical project resolution, existing EnvironmentLifecycle up/down/doctor,
  existing read-only execution preview, and conservative operation reconciliation.
- `src/bin.ts`, `src/help.ts`, `src/types.ts`, `src/index.ts`: separate binary
  command path, discoverable help and private composition types. Web never enters
  the legacy business composer/parser. Existing run/approve/resume code unchanged.
  Server and asset package loads are literal, lazy package imports; old library
  consumers do not eagerly load them.
- `test/web-command.test.ts`, `test/web-lifecycle.test.ts`: 22 W04 tests.
- This handoff and `test/W04-INTEGRATION-PROPOSAL.patch`: unapplied manifest and
  tsconfig proposal for the integrator. No root/lockfile/contracts/Runtime/
  Conversation/Local Server/Web source or generated output committed.

Production static assets resolve through `@bflow/web/assets`; data paths never
load sibling dist modules. Check index plus referenced JS/CSS files before
listening, including missing/partial builds, regular files and canonical paths.
Missing build output directs the user to `pnpm run build`.

Local server gets real workspace/interaction ports through dependency injection;
it never imports CLI. New CLI-private `resolveProject` must resolve a registered
project using trusted owner context. The adapter parses WebProject, rechecks
canonical path/Git root/project hash and validates configuration without init,
setup, indexing, license acceptance or repository plugin loading.

Start delegates all locks/preflight/startup receipts/activation to
EnvironmentLifecycle.up, then requires actual existing-host read facade state
`ready`; transport idle alone cannot satisfy readiness. Stop calls
`down(true, undefined, false)`: existing quiesce, checkpoint, writer guards,
locks and shutdown semantics, with no force bypass. Inspect calls doctor(false),
not the billable --deep model diagnostics. Preview uses loadExecutionPreview.
Closing web calls only Local Server/control listener close, never project down,
quiesce, cancellation or host shutdown.

Instance state is private 0700, locator 0600; startup serialization reuses the
existing lifecycle lock helper. No PID-only takeover. Reuse verifies a fresh
nonce with domain-separated HMAC verify/pair/paired receipts bound to the saved
origin, single-use bounded challenges and authenticated final bootstrap ACK.
Persistent control credential is never sent to an unverified listener. Control
binds ephemeral loopback TCP, avoiding Unix socket path limits for long BFLOW_HOME.
This is a private control surface, separate from browser APIs, and uses exported
WebSessionBootstrapRequestSchema token envelopes. Bootstrap URL is not written
into locator/state/results/JSON output; custom output sinks need explicit
isTerminal:true. Redirected stdout gets only safe origin/remediation.

## Interfaces, compatibility and recovery

No public schema, RuntimeService, host receipt, event/checkpoint, RoleMessage or
SessionManifest change/migration. Frozen LocalWorkspaceServices methods are
implemented unchanged. Only CLI-private composition types and CliExecutionResult's
command label are additive. No host/Herdr token reaches the browser.

W03 owns durable operation reservation and deduplication before forwarding.
The web operationId is validated before lifecycle invocation. Existing lifecycle
receipts do not bind that web operationId: after a lost ACK neither running nor
stopped proves this operation's effect. Reconciliation never calls up/down and
retains unresolved operations as reconciliation_required, including absent/stopped
hosts. Final receipts remain unchanged. No retry switches host sessions or treats
unknown_delivery as permission to resend. Interrupted/stale owner locks fail
closed with operator remediation; no automatic deletion or PID-based takeover.
No new power-loss/network-FS/multi-host/hostile-same-UID guarantee.

## Verification

Platform: Linux, Node v24.16.0, pnpm12.5.1. Node22/macOS/Windows not executed.
Accepted W00 TDD policy retained: required for trust/replay/isolation/security;
recommended DTO mapping; build wiring verified structurally. Initial tests were
RED for missing W04 modules after a successful baseline build. Reuse-auth,
partial-build and custom-logger/TTY bugs each have reproduced RED then GREEN.
No assertion/timeout weakening or new skip to obtain PASS.

Important qualification: W04 assigns package.json/tsconfig/lockfile wiring to
integrator, so these files remain unchanged. For local source validation only,
two ignored symlinks were created in apps/cli/node_modules/@bflow to the existing
local-server and web packages. They are not a declaration, not committed and not
a clean-install proof. The unapplied patch passes git apply --check; integrator
must apply the edges and regenerate the lockfile with pinned pnpm before claiming
clean-install/build/integration acceptance.

Final commands on the source implementation plus unchanged integration proposal:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | exit0; before implementation; no manifest/lockfile change |
| `pnpm run build` | exit0; tsc + frontend typecheck/resolver + real Vite assets; temporary links qualification above |
| `pnpm typecheck` | exit0; same qualification |
| `pnpm exec vitest run apps/cli/test/web-command.test.ts apps/cli/test/web-lifecycle.test.ts` | exit0; 22 passed, 2 files, no failures/skips |
| `pnpm check:deps` | **exit1**: undeclared @bflow/local-server in apps/cli/src/web-command.ts; @bflow/web also needs declaration; proposal only, not waived |
| affected command below | exit0; 1093 passed / 8 skipped (1101 total); 61 files passed / 2 skipped; 168.47s |
| `git apply --check apps/cli/test/W04-INTEGRATION-PROPOSAL.patch` | exit0; proposal applies without modifying files |
| `git diff --check` | exit0 |

```sh
env -u AI_ISOLATOR -u AI_ISOLATOR_PROFILE -u AI_ISOLATOR_REAL_HOME \
  -u AI_ISOLATOR_TOOL -u AI_ISOLATOR_HOME TMPDIR=/tmp \
  VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 \
  VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 \
  pnpm test:affected --base 20a38a5ebdfaf8fcc81744d913767f5184cab119 --run
```

Selection: package scope (CLI), GitNexus unavailable/commit_mismatch; widens
rather than skipping. 66 unit input paths including helpers, zero E2E. Existing
opt-in live/platform skips keep their original meanings. Environment selectors
are removed only from fixture execution, matching recorded W00 guidance; no
provider config/permissions changed. An earlier development affected run caught
the two newly added RED regressions (partial assets and stale-port impersonation):
1089 passed / 2 failed / 8 skipped; that run is not presented as a passing gate.
Final fixed-source results are the separate command above.

Tests cover actual loopback HTTP, W03 server integration, real
built JS/CSS fetches and built CLI subprocess/SIGINT from a cwd with spaces and
isolated BFLOW_HOME, plus injected lifecycle/health fixtures. No live project
host was launched by W04. The subprocess demonstrates no project state creation,
not full live host-survival acceptance. Independent reviewer reproduced reuse
impersonation and custom-IO disclosure; both fixed with regression evidence.
Reviewer confirmed HMAC fix independently (3 focused tests); final TTY fix is
verified by author regression. No final second independent TTY execution claimed.

## Exact blockers/proposals for integrator

1. **Dependency/build ownership:** apply the supplied package.json/tsconfig patch;
   update root pnpm-lock.yaml importer; run frozen install/check:deps/build/affected
   from a clean checkout. W00 root build already runs Vite and resolver; no extra
   root build rewrite is needed. Keep only CLI -> Local Server/Web package edges;
   never Local Server -> CLI or sibling dist module imports.
2. **Registered project context:** createLocalWebServer constructs ProjectRegistry
   internally and returns only `{origin,issueBootstrap,close}`. Injected workspace
   methods receive only projectId. CLI cannot safely resolve projects registered
   later in the browser through this interface. Approve an owner-only registry
   resolver/service factory seam; then supply WebCommandOptions.resolveProject.
   Reading W03's private projects.json format is deliberately not a workaround.
3. **Authenticated browser context:** factory `interaction(projectId)` has no
   authenticated browserSessionId/stable principal/issuer context. W02 requires
   registerUserInteractionIssuer + scoped signer for execute. Approve a server-only
   context-aware client factory, bind HTTP session/CSRF before signing and keep
   issuer credential/key private. Then supply authenticated interaction. No signer
   or fake physical hook is implemented from browser/model-supplied identity.
4. **Historical and lifecycle evidence:** W03 pins old hostSessionId/receiptId,
   but frozen readOperation does not return proof of the originating host session.
   Lifecycle receipts also lack the web operationId. Approve owner-only pinned
   readers and correlation receipts before settling old host operations or
   uncertain lifecycle effects. Until then retain reconciliation_required and
   never resend; no public contract is silently amended.
5. **Options ingress codec:** W00 lacks an exported server-only construction
   options codec (already reported by W03). Integrator must decide/approve the
   schema boundary and wire it through CLI/server; local factory validation is
   not claimed as closure of this compliance gap.

Checklist: W04 Steps1/3/4 command/owner/assets local portions done; Step2 lifecycle
adapter and conservative recovery done, correlated receipt settlement blocked;
Step5 default trusted registry/signer and clean package wiring blocked; Step6 CLI
regression executed, check:deps/integration closure blocked. No W05–W09 feature
is implemented. W06 should not assume usable host-backed actions from this branch.
After integration seams close, rerun authenticated HTTP lifecycle/commands and
clean-install checks, then W09 owns real browser/provider/Herdr/fault acceptance.

Evidence level: source + local fixtures/HTTP/crypto/filesystem/subprocess/regression
tests only. No live Herdr/provider, physical-hook or full SDLC acceptance claim.
P02-RA01/P03-RA01 and other predecessor findings retain their owners/status.
