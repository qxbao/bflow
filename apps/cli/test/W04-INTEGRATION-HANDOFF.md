# W04 — integration completion follow-up

Status: source/local integration implemented. Scoped checks PASS; full regression
was stopped at the project owner’s request, not reported as PASS.

## Authorization and baseline

Original approved integration baseline: `20a38a5ebdfaf8fcc81744d913767f5184cab119`.
Existing W04 branch/worktree resumed at `7c19443f14479f7e160a979f0f1773ef422391ef`,
retaining source `c7d8148e9364700c318ad230119e13e9d354f7e9` and all predecessors.
Integration source commit: `e945dade646ae9f17a2ff775fbbff6c49fabd6d1`. This evidence-only handoff follows.
Branch `agent/cli/w04`, worktree `.worktrees/local-web-w04`, kept for review.

The project owner explicitly replied “Đồng ý” after being told that dependency
wiring, registry/authenticated context and receipt recovery belong to W04 and
being asked to authorize the bounded integration. D-WEB-02 is recorded in
`docs/adr/0007-local-web-composition.md`. This authorizes the minimal cross-owner
and shared codec/lockfile edits below, not a remote push/PR/merge, unrelated task,
live acceptance claim or widening of production permissions.

Rechecked actual AGENTS.md, HEAD/status/index/worktrees, local/remote refs,
ancestry and patch equivalence. Main/origin/main remain the original baseline;
main and W03 worktree are preserved. `git cherry main agent/cli/w04` initially
showed exactly the original two local W04 commits. No reset, shared history
rewrite, remote fetch/push/PR/merge or use of survey hash as a reset target.

## Changes and ownership

- `apps/cli/package.json`, `tsconfig.json`, `pnpm-lock.yaml`: apply the previously
  proposed CLI -> Local Server and CLI -> Web package/reference edges. No root
  build script rewrite; W00 already builds Vite and its Node resolver. The old
  proposal file is historical and must not be applied again.
- `packages/contracts/src/web-host.ts`, contract tests: additive server-only
  construction config and authenticated request-context codecs, plus exported
  existing owner registration/credential shapes. No browser HTTP DTO/schema,
  API version, native receipt, event/checkpoint or RuntimeService amendment.
- `apps/local-server/src/{server,routes,lifecycle-operations,index}.ts`, package
  tests/README: optional owner composition factory receives its stable principal
  and revalidating registered-project resolver. Interaction gets only authenticated
  browser session identity/expiry. Private hostSessionId resolver is distinct
  from public Conversation sessionId. Existing workspace/client injection stays
  compatible; server never imports CLI. Construction validates exported config
  codecs and callable ports, and releases private state on composition failure.
- `apps/cli/src/web-interaction.ts`: server-private Ed25519 signer and existing-host
  issuer/client composition. Eager registration on an existing host precedes
  availableActions projection. Missing host stays unavailable without ensure/
  prepare/activate. Proof binds exact command digest, canonical project, physical
  host, server-authenticated browserSessionId, fresh nonce and expiry bounded by
  both 60 seconds and browser session expiry. Host-enforced local UID principal
  is separate from server ledger/issuer principal. Keys/tokens stay private.
- `packages/runtime/src/{interaction/authority,agentic/host-controller,agentic/host}.ts`
  and the existing authority test: lift unchanged owner request/response codecs
  to contracts; repeated registration of an identical owner key reuses the same
  credential. Registration after restart is still owner IPC. Role/interaction
  credentials cannot register keys or call lifecycle/role methods. No business
  command retry, readiness shortcut or accepted-hook fabrication.
- `apps/cli/src/{web-command,web-workspace-services}.ts`, CLI tests/README:
  production default composition uses the actual server registry/authenticated
  context; remove throwing placeholder defaults and the old integration warning.
  Lifecycle receipt storage is private, server-scoped and uses frozen WebOperation
  envelopes. Reserve before effects, sync the correlated successful result before
  ACK, and observe it after timeout/server restart or host stop without up/down.
  A running/interrupted receipt prevents resend. Corruption/write/ACK uncertainty
  remains uncertain. Existing EnvironmentLifecycle preflight/locks/quiesce/
  checkpoints/writer guards remain the implementation of start/stop.
- ADR0007 and package-local handoffs document approved integration and evidence.
  No UI screen, SSE/artifact/chat feature (W05–W08), provider adapter, legacy
  business command, gate/lease/fence/test-integrity or verification bound changed.

## Recovery and compatibility

Host operation reads select the physical host ID saved before dispatch. They do
not substitute the current Conversation ID or a replacement host. When the
original authenticated reader/receipt is unavailable, retain reconciliation_required;
no resend/ensure is attempted. Historical indexes from an older embedding that
saved a Conversation ID are preserved and may stay uncertain; no prefix stripping
or guessed authority migration. Existing final local receipts remain readable.

Lifecycle receipts recover final operation effects even when the host is absent
or stopped. A crash between an effect and its final receipt remains uncertain;
running/stopped alone is not evidence for this operation. Receipt/result corruption,
identity/kind mismatch and unsafe files fail closed. The Local Server operation
owner index remains authoritative for request fingerprint/principal/tombstones;
CLI receipts are correlated lifecycle evidence, not a second workflow store.
No SQL/event/native/web-host receipt migration or power-loss/network-FS/multi-host/
hostile same-UID guarantee is added.

Original W04 HMAC owner verification, TTY-only pairing output, strict dedicated
parser, shell:false browser opener, any-cwd production asset resolver/checks and
SIGINT web-only close remain intact. No sibling dist module imports. Build assets
are validated as actual referenced JS/CSS files before listening; missing/partial
builds give pnpm build remediation. No automatic setup/init/index/license acceptance.

## Tests and review

Linux, Node v24.16.0, pnpm12.5.1. Node22/macOS/Windows not executed.
Accepted TDD policy retained. RED evidence: missing construction/context codecs and
compose option; repeated owner registration returning a new token; missing lifecycle
receipts/duplicate uncertain start; reviewer reproductions of physical-vs-Conversation
ID pinning and lazy registration before initial action projection. GREEN targeted
runs follow source fixes; no assertion/timeout weakening or new skip.

Independent whole-branch reviewer found the two Important composition issues.
Both fixed in one scoped pass with regressions. No second independent review of
the fix is claimed. Earlier W04 owner-reuse/TTY findings remain fixed and tested.

| Command | Actual result |
| --- | --- |
| `pnpm install` (pinned pnpm) | exit0; adds only the two workspace importer edges to lockfile |
| Delete only the two old temporary CLI dependency symlinks, then `pnpm install --frozen-lockfile` | exit0; pnpm recreates both links from declared dependencies; no temporary-link workaround remains |
| `pnpm clean` then `pnpm run build` | exit0; clean TS build and actual frontend production assets/resolver |
| `pnpm run build` after review fixes | exit0 |
| `pnpm check:deps` | exit0; 24 packages, 54 internal edges, acyclic |
| `pnpm typecheck` | exit0, includes frontend app and Node resolver |
| Targeted config/compose/server/CLI/authority tests before review | 67 passed, 13 files; plus 2 later HTTP integration tests |
| `pnpm exec vitest run apps/local-server/test/composition.test.ts apps/cli/test/web-interaction.test.ts apps/cli/test/web-server-integration.test.ts apps/cli/test/web-command.test.ts apps/cli/test/web-lifecycle.test.ts packages/runtime/test/interaction/authority.test.ts` | exit0; 44 passed, 6 files, no failed/skipped cases after review fixes |
| `pnpm --filter @bflow/web test` | exit0; 2 passed, 1 file |
| Affected command below | stopped by explicit user request “Skip full suite”, exit143; partial full-unit run recorded one P19 resolver timeout; no final full counts |
| Separate E2E command, if affected stops after unit failure | not run: user explicitly skipped full suite before the unit run completed |
| `git diff --check` | exit0 |

```sh
env -u AI_ISOLATOR -u AI_ISOLATOR_PROFILE -u AI_ISOLATOR_REAL_HOME \
  -u AI_ISOLATOR_TOOL -u AI_ISOLATOR_HOME TMPDIR=/tmp \
  VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 \
  VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 \
  pnpm test:affected --base 20a38a5ebdfaf8fcc81744d913767f5184cab119 --run
```

Selection widens to **full** because pnpm-lock.yaml changed; GitNexus not queried.
Printed selection: 423 unit input paths (includes helpers), 21 E2E input paths;
actual discovered file/test counts are reported above. Browser app tests use their
separate config and are explicitly executed. Environment selectors are removed
only for inherited-isolator fixture compatibility (as recorded in W00); no provider
settings, permissions, test assertions, test timeouts or selection is weakened.

The partial full-unit run recorded one failure:
`packages/runtime/test/agentic/integration-p19-conflicts-reviews.test.ts`,
“escalates the conflict after two resolver attempts end without an accepted
resolution”, 30181ms timeout. W00 handoff records historical loaded-suite timeouts
for the same case, but no fresh baseline comparison or isolated rerun is claimed
here. The full run was terminated with SIGTERM for its own process group only,
exit143, immediately after the user requested “Skip full suite”. No full-unit
PASS, complete counts or E2E PASS is inferred from partial output. No test timeout
or assertion was changed to bypass it. The subsequent “Merge main” instruction
authorizes local integration with this disclosed validation limitation.

After stopping full suite, final scoped validation:
`pnpm exec vitest run apps/cli/test/web-command.test.ts apps/cli/test/web-lifecycle.test.ts apps/cli/test/web-interaction.test.ts apps/cli/test/web-server-integration.test.ts apps/local-server/test packages/contracts/test/web-composition.test.ts packages/runtime/test/interaction/authority.test.ts`: **exit0, 70 passed, 14 files,
zero failures/skips**. `pnpm check:deps` and `pnpm typecheck`: **exit0** again.
Source is unchanged since the previously successful clean build/review fixes.

Local tests use actual HTTP/cookies/CSRF/registry, private filesystem receipts,
Ed25519 signatures, built assets/CLI subprocess and owner IPC to a synthetic-Herdr
host fixture. HTTP timeout recovery exercises the actual CLI receipt adapter and
checks one lifecycle invocation; web close never calls down. The default missing-host
case verifies no project init/setup/host creation. These are source/local tests,
not live provider/Herdr workflow or full SDLC acceptance.

## Next task

W04 implementation/composition gaps listed in the original partial handoff are
closed by this integration; full-unit/E2E regression and live acceptance remain unverified as stated above. The bundled frontend is still
the W00 build skeleton. W06/W07 own real UI/forms; W05 owns events/artifacts and
W08 chat; W09 owns actual browser/live-provider/Herdr/fault workflow acceptance.
Do not advertise a usable end-user workflow UI from this backend task. Existing
P02-RA01/P03-RA01 and predecessor limitations keep their separate owners/status.
No remote publication or generated dist/state/database/key/log/test-output commit.
