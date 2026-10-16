# P17 validation evidence

Implementation tested: `691a845911ff8e4e17ef520d7314a6a95bab1b5c`.
Baseline: `d8c6d18120c7a01a4bf8aad13f14660d20e0cdf6`.
Branch: `agent/verification/p17-loop-engine`.
Worktree: `/tmp/bflow-p17-verification`.
Platform: Linux, Node `v24.16.0`, pnpm `12.5.1`.
Date: 2026-10-16.

| Command | Exit | Result |
| --- | --- | --- |
| `pnpm check:deps` | 0 | Acyclic dependency graph; 14 workspace packages, 20 edges |
| `pnpm typecheck` | 0 | Existing root project references |
| `pnpm --filter @bflow/verification typecheck` | 0 | P17 source and contracts reference |
| `pnpm --filter @bflow/verification test` | 0 | 3 files, 49 passed, 0 failed, 0 skipped |
| `pnpm exec tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --skipLibCheck packages/verification/test/*.ts` | 0 | Strict typecheck of test helpers, cases and fixtures |
| `TMPDIR=/tmp pnpm test` | 0 | 45 files, 1003 passed, 0 failed, 0 skipped |
| `git diff --check` | 0 | No whitespace errors |
| `git diff --cached --check` | 0 | No staged whitespace errors before implementation commit |
| `git status --short` | 0 | Final worktree clean after this evidence commit |

The first unqualified `pnpm test` run returned exit 1: 977 passed and 1 failed
(out of 978 tests at that intermediate revision). ArtifactStore's existing
`A02: Unix socket is rejected before any open/connection` fixture could not create
a socket beneath the long profile TMPDIR (`listen EINVAL`). The short local POSIX
path `TMPDIR=/tmp` resolved that environmental failure. Final validation above
includes all subsequent P17 tests. Build precedes package and full tests.

Workspace dependency installation used the baseline's existing pinned lockfile
versions. pnpm's automatic task preparation temporarily added the new package's
lockfile importer locally; that generated importer was removed after the checks.
It is not committed. Root TypeScript references remain unchanged; therefore the
explicit P17 typecheck/build commands are necessary evidence beyond root typecheck.
No root lockfile, configuration or shared contract changes are included. The
integration owner must apply the wiring described in [INTEGRATION.md](INTEGRATION.md)
before a frozen clean install can discover the new package importer.

The owned diff contains only `packages/verification/**` and
`agents/verifier/prompt.md`. There are no migrations, dependency upgrades, committed
build outputs, databases, coverage directories or agent logs. JSON examples are
requested source fixtures captured using the byte-storing fake ArtifactStore and
fake tool runner; schema tests validate all six examples.

Coverage includes the eight requested scenarios, real nonzero exit precedence
over a passing gate/review, stale attempt/revision and executor rejection, scope
and specification drift, malformed/missing/corrupted evidence, proposal ingestion,
coverage threshold enforcement, bounded timeouts, receipt/history tampering,
configured loop limits, changed versus unaffected check reuse including renames,
and post-integration workflow verification. Review discovered and closed the
manual-review/static-check masquerading-as-integration coverage bypass.

This is source implementation and local test evidence. It is not P19 Runtime
integration, live Herdr verification, live Git integration or remote closure.
The trusted host must provide actual isolated checks, approved command capabilities,
executor identity and Git state. Runtime must enforce latest-cycle optimistic
versions, Core rework limits, leases, cancellation/recovery and message delivery.
The engine cannot authenticate processes or distinguish replay of an older authentic
cycle snapshot from the latest cycle by itself. No contract amendment is requested.
P02-RA01 and P03-RA01 remain outside this package's ownership and are unchanged.
