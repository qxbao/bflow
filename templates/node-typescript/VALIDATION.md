# DX validation evidence — 2026-10-16

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

Follow-up fixes and validation against the newer main baseline are recorded in
[REVIEW.md](REVIEW.md). The evidence below describes the original implementation
pass and remains scoped to its stated tested HEAD.

Tested source HEAD: `48e1c5ecd438bd9300abbc6372f56a5ef5007ac0`
(`Merge P19 coordinator and authenticated Herdr receipts`), with this documentation,
template and standalone example diff in worktree `/tmp/bflow-dx-docs`, branch
`agent/dx/portable-config-guides`. Local `main` and `origin/main` both resolved to
that baseline at selection; ancestry/patch-equivalence inspection found no local
unapplied main patch. Existing worktrees and the main checkout were preserved.
This report is local evidence, not integration, remote closure or release approval.

Platform: Linux/local filesystem, Node `v24.16.0`, pnpm `12.5.1`, Herdr `0.9.5`
(release label diagnostic only). Example TypeScript dependency is pinned to
`5.9.3` in its own lockfile. No runtime/CLI/contract implementation, root config or
root lockfile was changed. No schema migration/upcaster was added. Only the example
lockfile is newly tracked; dist/node_modules/databases/artifacts/logs are untracked
generated output and excluded from the commit.

## Commands and results

From the Bflow worktree root unless specified otherwise:

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Existing root lockfile unchanged |
| `pnpm build` | 0 | Built actual packages/CLI before examples and subprocess tests |
| `pnpm check:deps` | 0 | Acyclic graph; leaf dependency boundaries verified |
| `pnpm typecheck` | 0 | Workspace TypeScript build/typecheck |
| `TMPDIR=/tmp pnpm test` | 0 | 52 files passed, 2 files skipped; 1209 tests passed, 2 skipped, 0 failed |
| `node templates/node-typescript/verify.mjs` | 0 | Four workflow loaders, P15/P16 validation, eight topology roles, message ingress and disposable-repo CLI probes |
| `herdr --version`, `herdr --help` | 0 each | Installed binary/advertised CLI inspected, no guessed install/transport command |
| `BFLOW_LIVE_HERDR=1 TMPDIR=/tmp pnpm exec vitest run packages/runtime/test/agentic/live-herdr.test.ts --maxWorkers=1 --minWorkers=1` | 0 | 1 file / 1 test passed, 0 failed/skipped; real isolated named session/plugin/native process, no model/provider |
| `git diff --check` | 0 | No whitespace errors |
| `git status --short` | 0 | Ownership inspection before commit; paths limited to README/docs/templates/examples |

Additional static checks: Node syntax checks of `apply.mjs` and `verify.mjs`
exited 0; a local-path Markdown scan checked 139 relative links in 37 files with
no missing target. A credential-pattern scan of docs/templates/example sources
found no private-key blocks or token-like secret literals.

The opt-in native transport test is skipped by the ordinary full suite and was run
separately with its explicit opt-in. Source was unchanged after that suite; later
edits added/refined documentation and example assets, verified separately below.
No implementation package changed, so no separate owner-specific implementation
test suite was required beyond the full suite and the actual transport smoke.

## Portable templates

`verify.mjs` imports the **built actual** CLI loaders and exported contract/policy
schemas. Every workflow is a Developer-only DAG with criterion ID traceability,
literal owned paths and task human approval. Every spec is a draft, not a fabricated
approved specification. Results:

| Asset pair | SDD result | TDD result | Check |
| --- | --- | --- | --- |
| feature | standard/full | required | PASS |
| bugfix | standard/lightweight | required | PASS |
| refactor | standard/lightweight | recommended | PASS |
| docs | trivial/lightweight | not_applicable | PASS |

The same script verifies all eight role configuration keys against actual P13
topology/agent kinds, validates RoleMessage v2 and rejects an invalid version.
It invokes the real CLI entry point against two temporary Git repositories with
the same basename, confirms distinct identities/session names, confirms repeated
plain init preserves bytes even from a subdirectory, applies a seed while retaining
runtime/storage/identity, rejects copied identity and indentation-style YAML, and
rejects template mutation when lifecycle state already exists. Negative probes are
assertions inside the script; the overall command exits 0 only when they hold.

The disposable `init --force` probe confirms overwrite despite help text claiming
preservation. Documentation describes the actual behavior; the CLI was not fixed
within this task. No public contract decision was needed or requested.

## Standalone Node.js/TypeScript repository

Copied only example sources/config/lockfile into a fresh repository outside the
Bflow workspace. The final disposable checkout was
`/tmp/bflow-dx-example-i7qdbgpy/calculator`; no dependency symlink from Bflow or
prebuilt example dist was copied. Git init/fixture commit used invocation-local
identity, without modifying global Git config.

| Command in standalone repository | Exit | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 0 | Standalone lock resolves pinned TypeScript |
| `pnpm typecheck` | 0 | Source typecheck passes |
| `pnpm build` | 0 | Emits math module and declaration |
| `pnpm test` | 0 | 4 passed, 0 failed/skipped |
| `node --input-type=module -e 'import { sum } from "./dist/math.js"; console.log(sum(2, 3))'` | 0 | Prints `5` |
| `node "$BFLOW_HOME/apps/cli/dist/bin.js" init --name calculator --json` | 0 | Creates config at the independent repository root |
| `node "$BFLOW_HOME/templates/node-typescript/apply.mjs" . bugfix` | 0 | Preserves generated identity; applies portable-bugfix seed and policies |
| `node "$BFLOW_HOME/apps/cli/dist/bin.js" status --json` | 0 | Configuration valid; no successful live topology claimed |
| `node "$BFLOW_HOME/apps/cli/dist/bin.js" doctor --json` | 0 | Healthy diagnostic report with missing-manifest/shutdown-integration warnings |
| `node "$BFLOW_HOME/apps/cli/dist/bin.js" attach --json` before up | 1, expected | Rejects absent manifest; no session created |
| `node "$BFLOW_HOME/apps/cli/dist/bin.js" down --json` before up | 1, expected | Rejects absent manifest; no session stopped |

An initial diagnostic run in inherited long XDG paths returned exit 1 with Herdr's
`local socket name length exceeds capacity of sun_path of sockaddr_un`. The final
run used a private short temporary parent under `/tmp`, `XDG_RUNTIME_DIR` set to
that parent, `XDG_CONFIG_HOME`/`XDG_DATA_HOME` under it, matching
`HERDR_CONFIG_PATH`, and `TMPDIR=/tmp`. All commands for that disposable session
used the same environment. This is an environment workaround, not an implementation
fix or permission to change routing directories for a live session.

The example was also installed inside its source directory with
`pnpm install --ignore-workspace`; typecheck/test succeeded there. Plain
`pnpm install` inside that directory selects the parent workspace and does not
install the example, which is why the guide instructs copying outside the workspace
or explicitly ignoring it.

## Bugfix exercise: observable Red → Green → rerun

In the disposable copy only, added a Node test named
`bugfix-1: Adding MAX_SAFE_INTEGER and 1 raises RangeError.` asserting
`assert.throws(() => sum(Number.MAX_SAFE_INTEGER, 1), RangeError)`.

1. `pnpm test`: exit **1**, four baseline tests pass and the new regression test
   fails with the missing expected RangeError. This is a target-behavior failure.
2. Updated only the disposable `sum` implementation to compute the result and
   throw `RangeError` when `Number.isSafeInteger(result)` is false. Test unchanged.
3. `pnpm test`: exit **0**, five tests pass; rerun after confirming no further
   cleanup needed: exit **0**, five tests pass. No test revision/name was changed.

These are manual local example checks, not P16/P17 authenticated evidence receipts.
No draft was marked approved, and no ArtifactReference or physical measurement
provenance was fabricated. The committed example retains the intentional overflow
defect for the exercise. Feature/refactor/docs policy assets were schema/resolver
validated; no claim is made that an AI implemented/reviewed those requests.

## Limits and handoff

The real Herdr smoke establishes protocol initialization and signed structured
RoleMessage delivery through the plugin. Its custom native actor does not provide
the official agent session binding needed to claim a successful authenticated
implementation assignment. It does not test live model code generation, independent
model review, user conversation delivery, or SDLC E2E acceptance.

Permanent-role `bflow up` and interactive attach to an AI provider were not run in
this documentation task. Default live-session down remains guarded; automatic
P19 host boot/shutdown and environment-to-P19 policy wiring remain planned. Host
authentication, measurement isolation, project approvals and provider tools remain
explicit integration work. Linux/local-filesystem assumptions and open P2 follow-ups
P02-RA01/P03-RA01 are unchanged.

Ownership diff: `README.md`, `docs/guide/**`, `templates/node-typescript/**`,
`examples/README.md`, `examples/portable-node/**`. Shared-documentation changes are
within the project owner's explicit documentation/template/example instruction.
No push, remote PR/merge, protected branch operation or deployment was performed.
