# NFR guidance handoff

## Baseline and scope

- Tested HEAD: `e358a9199fe3f53105cfcb60c52d2f674a7172dc` plus the uncommitted diff in this worktree.
- Branch: `agent/skills/measurable-nfr`.
- Worktree: `.claude/worktrees/nfr-guidance` under the original repository.
- Initial main/index were clean; HEAD equalled local `origin/main` and retained P24 `8dbb056` by ancestry. No remote fetch was needed or performed. Other existing worktrees were left intact.
- Later uncommitted test-design changes appeared in the original main checkout; they were not copied, overwritten or included in this change.
- Ownership diff: only `skills/**` and `packages/skills/**`. No contract, execution prompt, engine, gate, TddDecision, root configuration, lockfile or shared documentation changes. No migrations. Build/install output remains ignored; no generated output is included in the patch. Initially no commit, push, PR or merge was performed. The user subsequently authorized a local merge into main; see integration note below.

## Audit and actual role path

Read repository instructions, README, root/package manifests, P24 platform architecture documents, the three requested skill bundles, Specification criteria/schema/prompts, exported SDLC contracts, catalog/renderer code, CLI catalog wiring and Runtime platform launch context. The two external NFR skills were read for ideas only; their numeric mandates, private protocol and gates were not imported.

The strict AcceptanceCriterion already supports category non_functional/security/performance, description, verificationMethod, required, status and evidenceArtifactIds. Measurement details fit ordinary description/Specification prose; no new machine-readable NFR model or metadata protocol is needed. Existing draft/versioning, failure non-weakening and verification semantics are preserved. No cross-owner execution-prompt patch is necessary for this instruction scope.

Actual path: CLI `apps/cli/src/skill-catalog.ts` loads the canonical catalog and `skills/roles/bindings.json`; role selections resolve exact version/digest pins. Specifier is bound to requirements-analysis and specification-driven-development. Tester/QA are bound to test-planning. SkillManager installs immutable bundles and renders their real entrypoint references. Runtime `packages/runtime/src/platform/service.ts` passes rendered instruction text and manifest alongside the original role prompt to the provider adapter through platform defaults. Each modified entrypoint points to its bundled resource. The catalog test reads published resources via the rendered Specifier entrypoint on all three providers, checking canonical bytes/digest.

Allowed roles are not default bindings: Architect/Coordinator/Planner being allowed to use specification-driven-development does not prove they receive it by default. This patch does not change role bindings. No live provider adherence is claimed.

## Changes and examples

- requirements-analysis: short NFR clarification brief; procedure link and recovery ambiguity example.
- specification-driven-development: four schema-valid JSON criteria, linked from the entrypoint and worked example.
- test-planning: carry accepted NFR oracle/conditions into the existing check matrix, distinguish readiness/results/independent confirmation, retain Conditional TDD.
- Tests: parse the actual published JSON blocks with AcceptanceCriterionSchema and a draft SpecificationSchema; reject invented fields and unsupported satisfaction without evidence. Existing catalog/reference/authority checks remain in force; no sentence-by-sentence Markdown tests.

Before → after (all illustrative proposals, not approved requirements):

| Before | After |
| --- | --- |
| Search is fast | Proposed p95 <= 250 ms over 10 minutes after 60-second warm-up, 20 concurrent clients, 100000 records, fixed query mix and specified host; raw samples, error oracle and aggregation retained. |
| Endpoint is secure | Tenant A GET/PATCH of B's document denied with agreed generic 403, no protected fields/existence disclosure or mutation; allowed control and every matrix case checked. |
| Storage is stable | SIGKILL after acknowledged update at a proven fixture barrier; restart same directory, compare every record/ID with expected snapshot; no power-loss claim. |
| Uploads are fast at production scale | Threshold, scale and environment unknown; pending clarification through Runtime → Herdr → Conversation, empty evidence IDs, no pass determination. |

Each draft stays pending even when measurable. Target source/rationale and unconfirmed authority are explicit. Missing tool/runner is distinct from missing measurement evidence; independent verification is distinct from running the measurement. No default SLA, installation, monitoring platform, benchmark suite or new approval gate is introduced.

## Catalog compatibility

Modified bundles advance from 1.0.0 to 1.0.1. Canonical loader computes full-inventory SHA-256 digests; no checked-in manual digest list exists for these bundles. Existing setup/install approval must authorize exact new pins, and immutable live generations remain unchanged.

| Skill | Version | Bundle digest |
| --- | --- | --- |
| requirements-analysis | 1.0.1 | 10cb75f0519d26197cc0d559af9e7fcc407011cbebbd709486ae94c24689a60c |
| specification-driven-development | 1.0.1 | fcdb43223cf43e6463b7a894258fb6ca2ae0b246c8b64082da56fa350189b3db |
| test-planning | 1.0.1 | 1eb9f145da8b5159cd02daf911becdf0a46fc4a904608f9e813ba37b8c1dee20 |

The referenced prior test-design instructions were absent from this committed baseline and local origin/duc tree. Newly observed main-checkout tests mention a future references/risk-viewpoints.md, but its content was unavailable for comparison. NFR guidance therefore delegates test selection to the existing test-planning/TestStrategy flow and reuses a selected test-design reference when available. Integration should reconcile the test-planning procedure and version: if another 1.0.1 has already been published, use a fresh version and computed digest for the combined bundle; never replace immutable 1.0.1 bytes. This is a compatibility note, not permission to merge the other work.

## Validation

Environment: Node 24.16.0; pnpm 12.5.1 (manifest pin).
Worktree dependency setup: offline frozen-lockfile install, exit 0, no lockfile change. An initial node_modules symlink attempt was rejected by pnpm and replaced with a real worktree install.

The initial schema-example test failed because the new reference did not exist (37 pass, 1 fail). During authoring, the wrapper fixture also exposed its missing required problemStatement; that fixture was corrected. Final checks below refer to the corrected diff.

| Command | Exit | Result |
| --- | --- | --- |
| pnpm --filter @bflow/skills typecheck | 0 | PASS |
| pnpm --filter @bflow/skills test | 0 | 7 files, 38 passed, 0 failed, 0 skipped |
| pnpm check:deps | 0 | Acyclic, 22 packages / 40 internal edges; leaf boundaries pass |
| pnpm typecheck | 0 | PASS |
| pnpm exec vitest run packages/skills/test --maxWorkers=1 --minWorkers=1 | 1 | 6 files passed / 1 failed; 37 passed, 1 failed, 0 skipped; catalog matrix timed out at unchanged 60s |
| pnpm test | 130 | Interrupted with SIGINT after about 20 minutes; 272 completed files reported 4831 pass / 104 fail / 78 skip; integration file unfinished, not a final full-suite count |
| git diff --check | 0 | PASS |
| git status --short | 0 | Owned source/docs/tests only; see patch inventory |

Full logs are outside the repository in /tmp/bflow-nfr-*.log. These checks establish local instruction/schema/catalog compatibility; no NFR measurement or live Herdr/provider acceptance was performed.

The single-worker rerun did not reproduce the initial clean targeted result: it timed
out in the existing all-role/all-provider catalog matrix. At that time another
independent pnpm test was running on the same machine and load average was about 31.
Resource contention is a plausible contributor, not a proven root cause. No timeout,
production implementation or gate was changed to turn failures into passes.

## Local integration authorization

The user subsequently requested merging into local main. The NFR diff is committed
on its isolated branch, then merged locally while preserving the original checkout
changes. No remote write is authorized or performed. The test-design reference
became available in the original checkout during this task and was read before
integration: references/risk-viewpoints.md owns risk viewpoints/check selection; NFR
guidance supplies oracle/measurement conditions and does not duplicate that method.

## Post-merge result

Local main fast-forwarded to NFR commit `861acf6fb0e78162c46e63a3bc25084b3db3cb97`.
Autostash restored the pre-existing test-design work; its one procedure conflict was
resolved by retaining all risk-viewpoint steps and appending NFR measurement planning.
Other pre-existing tracked files and all untracked files were byte-compared against
the pre-merge snapshot and preserved. Those changes remain uncommitted/unstaged.
The safety autostash `6ec5b05` and /tmp/bflow-nfr-premerge snapshot are retained.

On this main working-tree combination, pnpm --filter @bflow/skills test exited 0:
7 files, 39 passed, 0 failed, 0 skipped. The previously uncommitted test-design work
already changed the catalog matrix timeout from 60s to 120s; that change was preserved,
not introduced by this NFR task. The matrix took about 109s in this run. This does not
retroactively turn the earlier timeouts into passes.

Post-merge pnpm check:deps, pnpm typecheck, git diff --check and git status --short
all exited 0. No unmerged entries remain. Full pnpm test was not rerun after the local
merge; the earlier interrupted full-suite run remains incomplete/failed evidence.
The digest table above describes the isolated NFR commit; the uncommitted combined
test-planning bundle has a different computed digest and needs review as one bundle
before any catalog publication. No live NFR measurement or provider acceptance occurred.
