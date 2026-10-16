# P16 implementation handoff — 2026-10-16

Historical implementation handoff. Subsequent review fixes and package registration
are recorded in [REVIEW.md](REVIEW.md); the integration proposals below describe
the original pre-integration state.

Conditional TDD Policy Engine is implemented locally on
`agent/test-strategy/p16-conditional-tdd`, in `/tmp/bflow-p16-test-strategy`.
The tested implementation commit is
`02e6ca534ce9cadfbe241523bafc03e330758a7f`.
This report is a subsequent documentation-only commit. No remote merge, push,
P19 integration, or live Herdr verification is claimed.

## Baseline and ownership

- Base: `4e818b4a7c0c9b102bf1e85906a24d57fd6c192c`, the observed clean `main` and
  `origin/main`, containing P11 `106d69d` and accepted extensions `8c27cbf` plus
  integrated P13/P14/P15 predecessors. Local refs, worktrees, ancestry, contract
  diffs and patch equivalence (`git cherry -v origin/main main`, empty) were inspected.
- A dedicated branch/worktree was created; other worktrees and uncommitted work
  were preserved. `main` remained at the same approved baseline at handoff.
- The complete committed diff is under `packages/test-strategy/**`: implementation,
  package configuration, unit tests, prompts, example and package documentation.
- No contracts, Workflow Engine, Runtime, shared documentation, root configuration,
  migrations or lockfile changes are committed. Generated `dist`, dependency links
  and raw test logs remain untracked/ignored or outside the repository.

## Delivered behavior

`TestStrategyResolver.resolve` parses a contract `Specification`, evaluates seven
assessment inputs and emits a contract `TestStrategy`/`TddDecision`. Private,
versioned metadata uses strict Zod schemas. Required verification methods, suggested
levels, spec-to-test mappings, rationale and evidence requirements are explicit.

Deterministic logic, reproducible regressions, APIs, validation, transformations
and state machines typically require TDD when a runnable behavioral test is feasible.
Integration/refactoring/exploration typically recommend it. Pure documentation,
formatting, visual layout, wiring and simple configuration can use alternatives.
Mixed behavioral impacts, behavioral acceptance criteria, actual paths, risk and
project conventions override superficial task labels. Incomplete infrastructure
retains verification obligations and exposes missing command provisioning.

High/critical risk adds review/static analysis and behavioral integration checks.
Security/data migration signals raise effective risk. Domain logic/bug fixes cannot
be marked non-applicable by this engine; unverified override booleans are ignored.
`validateAgainstSpecification` rejects a changed assessment or mismatched policy
against the authoritative input, beyond self-consistency checks.

Evidence APIs parse contract `VerificationResult` records, enforce correlated
Red/Green/refactor ordering and unchanged test identities, reject unrelated or
infrastructure Red failures, and require distinct attempts/stored artifacts.
Alternative modes still need successful objective verification covering required
criteria and methods. Receipt retries are idempotent; conflicting IDs fail. The
caller persists the returned contract value, including preserved phase evidence.

Three prompt templates cover assessment, required TDD and alternative verification.
The documented JSON input is exercised by a unit test; built ESM exports were also
checked with that example.

## Validation evidence

Platform: Linux/local filesystem, Node `v24.16.0`, pinned pnpm `12.5.1`.
All final checks below ran against implementation HEAD `02e6ca5`.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm check:deps` | 0 | Acyclic: 13 packages, 19 internal edges |
| `pnpm typecheck` | 0 | Existing root project references pass |
| `pnpm --filter @bflow/test-strategy typecheck` | 0 | P16 explicitly typechecked, including contract project reference |
| `pnpm --filter @bflow/test-strategy test` | 0 | Build then 2 files, 74 passed / 0 failed / 0 skipped |
| `TMPDIR=/tmp pnpm test` | 0 | Root build then 42 files, 947 passed / 0 failed / 0 skipped |
| Built ESM import/example check, command below | 0 | Resolution and authoritative-spec validation pass |
| `git diff --check` | 0 | No whitespace errors |
| `git status --short` after restoring generated lockfile importer | 0 | Clean after implementation commit; only this report pending before its commit |

Built export smoke command (from repository root):

```bash
node --input-type=module -e 'import { readFileSync } from "node:fs"; import { TestStrategyResolver } from "./packages/test-strategy/dist/index.js"; const spec = JSON.parse(readFileSync("packages/test-strategy/examples/domain-logic.spec.json", "utf8")); const resolver = new TestStrategyResolver(); const strategy = resolver.resolve(spec); resolver.validateAgainstSpecification(strategy, spec); if (strategy.tddDecision.mode !== "required") throw new Error("Unexpected policy"); console.log("Built ESM export and contract example: PASS");'
```

The first unmodified `pnpm test` run exited 1: 939 passed, 1 failed, 0 skipped
(940 tests at that revision). ArtifactStore's Unix-socket fixture could not bind
its socket because the inherited profile TMPDIR produced an overlong AF_UNIX path
(`listen EINVAL`). Re-running with `TMPDIR=/tmp` passed all tests, including that
fixture. No ArtifactStore source or test was changed. The final 947-test count
includes additional P16 tests added after that initial run.

P16 tests cover task classes, mixed-label evasion, criterion/path contradictions,
missing rationale/context, all-optional criteria, partial/absent infrastructure,
high/critical risk, security/migration impact, project conventions, policy
downgrades, authoritative assessment binding, phase ordering, method/criterion
coverage, changed tests, incorrect run/task/spec/decision, stale/untrusted artifacts,
nonzero Red and zero Green exits, receipt collisions, persisted-history validation,
and successful visual/schema/smoke/formatting and high-risk multi-method evidence.

### Implementation Red/Green/refactor trail

These are implementation-session test observations, not live task evidence or
ArtifactStore trust claims. Raw reports are outside Git; generated logs are not
committed.

| Stage | Command and result |
| --- | --- |
| Red | `pnpm exec vitest run packages/test-strategy/test --reporter=json --outputFile=/tmp/bflow-p16-red.json` — exit 1, 47 failed / 4 passed / 0 skipped. Resolver/evidence behavior intentionally absent; failures reported `Policy resolution is not implemented`. Invalid-ingress checks already passed. |
| Green | `pnpm exec vitest run packages/test-strategy/test --reporter=json --outputFile=/tmp/bflow-p16-green.json` — exit 0, 51 passed / 0 failed / 0 skipped after implementing target policy and evidence behavior. |
| Refactor/hardening | Separated required method levels from optional suggestions, removed redundant phase state, added authoritative-spec binding and adversarial evidence coverage. Final package rerun: 74 passed; full monorepo rerun: 947 passed. |

Raw report SHA-256 checksums at handoff:

- Red: `bee5de2b8c870e33834d2b0d0d3d0cf6c741ccdf8f71dde8c81e084640ac352f`.
- Green: `33201aa28820f4d724d5c8ba0f95bccb7b94e55db58945f1ece170babb456ba4`.

## Integration proposals and remaining scope

The integrator should register the package in shared build/install configuration:

1. Add `{ "path": "./packages/test-strategy" }` to root `tsconfig.json` references.
2. Regenerate the lockfile to include this importer, using existing resolved dependencies:

   ```yaml
   packages/test-strategy:
     dependencies:
       '@bflow/contracts':
         specifier: workspace:*
         version: link:../contracts
       zod:
         specifier: ^3.24.2
         version: 3.25.76
   ```

3. Update shared package status documentation to describe P16 as implemented after
   integration, with Runtime enforcement still pending P19.
4. P19 consumes the metadata assessment, resolves policy, validates it against the
   authoritative accepted spec, persists evidence and invokes policy checks through
   Runtime. P17 independently verifies actual logs, revisions and acceptance.

pnpm 12 automatically generated the nine-line importer during local command runs;
it was restored before commits. Root typecheck/build therefore do not yet include
P16 by reference: the explicit package build/typecheck commands above provide P16
coverage. Clean frozen-lockfile installation on integration requires proposal 2;
this feature commit alone does not claim that shared registration is complete.

No shared contract amendment or migration is requested. Assessment and evidence
details use existing contract metadata extension points. Full-SDD contract inputs
already require a valid strategy/decision; initial policy can be resolved on a
lightweight planning spec and then composed through P15 without weakening contracts.

The engine validates declared evidence structure, bindings and sequence. It does
not execute tests, read/verify artifact bytes, authenticate reference provenance,
inspect Git history, grant human overrides or perform independent acceptance.
Those remain existing ArtifactStore/P17/P19 responsibilities. Synthetic unit
fixtures do not establish live Herdr E2E or durability/security guarantees.
P02-RA01 and P03-RA01 remain untouched with their original owners.
