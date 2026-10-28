# W01 — agentic interaction read facade

Source commit: `db1d8afa091675c360775b044192f80b150ee47b`.
Additional follow-up-bound test commit: `3df3219067db5a6b4051d754ff587d5e4d0dbe2c`.
Baseline: `de36c7353793c822b82b68aca734fc3683dd1c43`.
Branch: `agent/runtime/w01`; worktree `.worktrees/local-web-w01`.

The baseline contains approved W00 freeze `2bd99d8d227522f1931fbb66462023c47e06b8ad`
and its handoff. P24 `8dbb0561adbb41235d481e9800c2cb72eae81658` is retained.
At selection main was two commits ahead of origin/main (the freeze and handoff),
with a clean index and only the owner's three untracked design/plan inputs.
Ancestry, refs/worktrees and `git log --left-right --cherry-pick origin/main...HEAD`
were inspected; no alternative W01/predecessor patch existed. `git cherry main HEAD`
reports the W01 source commit as new. No reset, branch switch in another worktree,
fetch, push, PR or remote merge. The three owner input files remain untouched.

## Owned paths and exported seam

Only `packages/runtime/**` changes: `src/interaction/{client,views,actions,schemas}.ts`,
`src/{index,agentic/host-controller,agentic/host}.ts`, and `test/interaction/**`.
No contracts, root config, lockfile, shared docs, Conversation or Local Server edits.
No public schema or receipt/checkpoint/journal migration.

```ts
import { openUserInteractionClient, interactionProjectId } from '@bflow/runtime';
const client = await openUserInteractionClient({ repositoryPath, sessionId });
// repositoryPath is canonicalized by the client. W03 registry must use this
// same canonical path identity, rather than supplying an unrelated UUID.
const projectId = interactionProjectId(canonicalRepositoryPath);
await client.readProjectSession(projectId);
await client.listRuns(projectId, { limit: 25 });
await client.readRun(projectId, runId);
await client.listDecisions(projectId);
```

The exact factory type is
`(options: {repositoryPath: string; sessionId: string}) => Promise<UserInteractionClient>`.
`interactionProjectId` = `project-` + first 32 lowercase hex SHA-256 characters of
canonical repository path. No credentials are returned. Existing-host-only controller
query uses root-authenticated private `interaction_query`; role tools do not expose it.
Private request discriminants are `session`, `runs`, `run`, `decisions`; each validates
projectId again inside the host. All responses are parsed with exported W00 schemas.

Unsupported execute/readOperation/events/notices/artifact/chat methods explicitly
refuse; there is no fake successful adapter. Production actions remain disabled with
`structured_commands_unavailable` until W02 provides authenticated command ingress.
The private `commandsSupported` projection option exists for policy tests, not as
browser authority. W02 must re-check request/action version and all policy under its
serialized mutation authority; a displayed action is never an approval or capability.

## Query sources and recovery

Read projection uses existing validated agentic journal snapshots, Conversation
context snapshots, the scoped SessionManifest and active Core `getSnapshot`.
No legacy Runtime composition, ensure/prepare/activate, scheduler tick, reconciliation,
receipt creation, journal lock creation or database creation. Atomic snapshot files
are opened read-only, no-follow/nonblocking and capped at 16 MiB. Queries do not make
SQLite/FS/transport atomic. Independent snapshot races remain observations; W02 must
revalidate exact authority before effects.

Pre-Core runs have `coreStatus:null`; unavailable post-Core projections have an
explicit `core_projection_unavailable` blocker. A host without an activated workspace
is readable but unavailable; it does not open/create a database to reconstruct Core.
Completed activation, an active in-memory manifest and no activation/closing/quiesce
are required for ready. Missing/disconnected host becomes a readable unavailable
project session; run reads return transport_unavailable. Explicit lifecycle startup
belongs to W04. Existing corrupt/foreign sources fail closed with sanitized errors.

Run identity is not replaced by its continuation: historical parent retains its
own runId/status; validated same-session lineage supplies origin/parent/current IDs.
Resume requires a real pending action; terminal/superseded, unresolved delivery,
pending decisions, capability repair and existing three-manual-resume bounds prevent
unsupported enablement. Follow-up bound mirrors existing six-run lineage semantics.
No lease/fence, human authority, independent gate, verification bounds, test-integrity,
unknown_delivery or native-hook behavior is changed.

Actions have command-specific semantic versions, separate from the view token.
Exact approval target/revision/generation/evidence digest are retained. View tokens
cover user/prototype decisions, lineage and Core revision but exclude polling time.
Run pagination is filter/session/projection-bound; stale cursors return existing
ContractError `conflict` with `details.reason: stale_cursor`, so W03 can map to stale
HTTP 409. Clients restart pagination; they must not infer host failure from this result.
Transport states are manifest observations with their original observedAt, never
inferred from business phase or outbox delivery. They do not prove business success.

Public DTOs are built by structural allowlists. Launch material, raw journal,
receipts, private errors, env, artifact URI/metadata and host tokens are not copied.
Free text is bounded/redacted with existing redaction and known private host values.
Run task/decision/action collections are bounded with a projection_truncated blocker.

## Fixtures and test policy

`fixtures/ui-states.json` is browser-safe synthetic JSON, checked against its source
builder by a file snapshot test. It covers all 13 SDLC phases, five session lifecycle
states, pending clarification without a run, design/delivery/user decisions, pre/post
Core, historical parent/continuation, blocked without action, resumable/exhausted and
stale projection. `ui-fixtures.ts`/`fixtures.ts` export builders for downstream tests.
The resume-enabled fixture supplies synthetic future command support; production W01
does not claim it. No UI design or visual compliance is claimed by this backend task.

Applied supplied TddDecision policy: required for isolation/security; recommended
for DTO mapping. Initial build passed and targeted RED found the missing interaction
modules. Security/isolation tests preceded implementation. Independent review found
four P2 defects (activation readiness, decision/lineage revision coverage, 100-action
boundary, stale cursor error classification); all four had RED followed by GREEN.
No fabricated domain TddDecision/approval receipt. The separate follow-up-bound
case adds coverage of existing mapping after review; it did not change production code. Actual platform: Linux, Node
v24.16.0, pnpm 12.5.1; Node 22 was not executed.

Commands and measured results:

- `pnpm install --frozen-lockfile`: PASS, lockfile unchanged.
- `pnpm run build`: PASS, before subprocess tests and again after final source fixes.
- `TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/interaction/views.test.ts packages/runtime/test/interaction/actions.test.ts packages/runtime/test/interaction/host-query.test.ts`:
  PASS, 20 tests / 3 files, including actual host subprocess/private socket query.
- `pnpm typecheck`: PASS, including browser app and Node resolver typechecks.
- `pnpm check:deps`: PASS, 24 packages / 52 edges, acyclic; no import boundary violation.
- `pnpm test:affected --base main`: package scope, GitNexus commit_mismatch fallback,
  201 unit input files, zero E2E; no tests omitted because the index is unavailable.
- `TMPDIR=/tmp VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm test:affected --base main --run`:
  exit 1, NOT PASS: 180 files passed / 1 failed / 3 skipped (184 executed/discovered);
  2776 tests passed / 1 failed / 70 skipped (2847 total), 647.95 seconds.
  All interaction files passed (12 views + 5 actions + 3 host-query tests).
  The 201 selection inputs include non-test helper files; they are not 201 executed suites.

An earlier affected run was interrupted (exit 130) after review fixes changed source;
it is not final verification evidence. The final run uses immutable source content
of the source commit above; the additional test commit supplies the fifth actions test
confirmed in the final affected output. Executable/test content matches `3df3219`;
the handoff-only commit adds this document after verification. No provider environment selector is removed for W01.
The JSON bundle was generated explicitly with the views test `-u`; normal runs compare
it without regenerating it. No dist, logs, DB, actual tokens or generated browser
artifacts are committed.

Evidence level: source + local DTO/policy/security tests + actual host subprocess RPC
using synthetic journal/manifest/Conversation fixtures. No real provider, live Herdr
transport, physical-hook proof, browser workflow or full SDLC acceptance claim.

## Loaded-suite observation

The affected run reports one failure in unchanged
`integration-p19-conflicts-reviews.test.ts`:
`routes Reviewer requests through AgentTransport without locking out inbound processing`
expected a passed cycle and saw escalated (3-second Reviewer wait in the existing
fixture). No assertion/timeout/source was weakened. The exact failed case passed
when isolated on both rebuilt baseline and W01:

```sh
TMPDIR=/tmp VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 pnpm exec vitest run packages/runtime/test/agentic/integration-p19-conflicts-reviews.test.ts -t 'routes Reviewer requests through AgentTransport without locking out inbound processing'
```

Each result: 1 passed / 13 name-filtered skipped; exit 0. Baseline source was
extracted with `git archive de36c7353793c822b82b68aca734fc3683dd1c43` into owned
`/tmp` scratch, followed by frozen install and full build (both exit 0); scratch
was removed. W01 was built before the same targeted command. No other worktree
was changed for this comparison. The case passed on baseline in 5.45 seconds and
on W01 in 6.85 seconds; these isolated passes do not erase the affected failure. Runtime/tools/Conversation and this test/fixture
have no diff from baseline. This suggests a load-sensitive existing review wait,
but the isolated baseline run does not reproduce the loaded failure or establish
its cause. The affected run remains NOT PASS; no complete-suite PASS is claimed.
The observation needs Runtime/integration follow-up rather than an unrelated W01
query patch. W00 records other loaded review/conflict observations separately.

## Unresolved interface limit / integration proposal

Frozen `UserInteractionClient.listDecisions(projectId)` has no cursor/query input,
while `WebPage<WebDecision>` is capped at 100 and exposes nextCursor. A project with
more than 100 projected pending decisions cannot exhaust that endpoint. W01 refuses
that oversized aggregate and directs callers to paginated run views; run-local
truncation is explicitly blocked/marked. Proposed integrator decision: add optional
WebPageQuery to listDecisions and its HTTP query contract, with scoped cursors, or
approve the documented aggregate limit. This requires a new public-interface
integration decision; no frozen schema was changed to make the tests pass.

W02 must wire real command authority, align semantic version/question identities and
retain all existing host receipts/replay/guards; W03 must use the exported project
identity, validate canonical registry scope and map ContractErrors to WebApiError;
W05 owns actual events/artifacts/notices, W08 owns chat. W06 can import the JSON
fixture as test data without bringing Runtime/Node into the browser bundle.


## Checklist / handoff disposition

- [x] Read actual repository instructions, W01/spec, W00 decision and predecessor handoff.
- [x] Inspect baseline/index/worktrees/refs/ancestry/equivalence; isolate work.
- [x] Execute initial failing tests, implement scoped read facade and semantic actions.
- [x] Cover admission/Core separation, isolation, lineage/old links, bounded follow-up,
      terminal/missing-host/stale projection and downstream fixture states.
- [x] Build before actual host subprocess tests; run targeted and affected selection.
- [x] Independent review; reproduce/fix all four review findings with regression evidence.
- [x] Dependency/type/whitespace checks; scoped commits and durable handoff.
- [ ] Affected suite entirely green: one loaded Reviewer failure remains, as measured above.
- [ ] Integrator decision for project-wide decision pagination beyond the frozen 100-item bound.

Keep this branch/worktree for integration. No source fixes, contract migrations or
remote closure are implied by the two open items. The owner-authorized scope is W01
only; the unchanged Reviewer path is reported rather than weakening it or folding an
unrelated execution-engine repair into the query task.
