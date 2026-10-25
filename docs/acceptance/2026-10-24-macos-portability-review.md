# Review of the macOS portability delivery

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../implementation-status.md) trước khi vận hành hoặc giao việc mới.

Reviewed baseline: `26974d2f4ed75a60a0c41ea683fe44eefa78875b` plus the original 49-file
delivery, patch SHA-256 `0637c83145143ac4bfc3f01efd4b5fa5afd32a183aaa10b67e94aa4fb79714f6`.
All delivered source hashes were checked before review. Work remains in the isolated
`fix/runtime/macos-portability` worktree. No commits, public-contract changes,
storage migrations, global provider settings or existing user sessions are involved.

## Reproduced findings and corrections

1. **P1 — Unicode filesystem aliases bypass forbidden paths.** On the actual case-insensitive
   APFS volume, `ſecret`/`secret`, `straße`/`STRASSE`/`STRAẞE` and `.bﬂow`/`.bflow` resolve to
   the same name, whereas lowercase-only permission comparison does not equate all of them.
   The red suite reproduced unauthorized creation under a forbidden alias and reading a nested
   control file through a ligature. Deny comparisons now use canonical decomposition plus
   converged full upper/lower mappings. Accent-distinct allowed names remain usable.

2. **P1 — Case aliases evade frozen Red tests.** With broad ownership such as `test`, a write to
   `test/MATH.TEST.TS` reached the same inode as the frozen `test/math.test.ts`, while the raw
   string `tests.includes(path)` classified it as implementation. Both the MCP file tool and
   native edit authorizer allowed it after Red. They now recognize aliases of the configured
   test, and commit policy uses the same classification. Linux path semantics remain literal.

   A conservative deny key is not a permission grant: actual APFS distinguishes `input` and
   dotless-ı `ınput`, even though full upper/lower closure equates them. A separate regression
   reproduced that false grant during review of the first fix. Pre-Red edit permission now
   requires the exact declared test path, or both existing names identifying the same
   single-link regular file using bigint device/inode observations. Missing non-literal test
   aliases do not gain creation authority. File IO still uses the descriptor-pinned C backend;
   these metadata observations do not replace it or add hostile same-UID isolation guarantees.

3. **P2 — Native edit authorization ignored a read-only Developer binding.** MCP writes already
   refused that binding, but native `Write` authorization did not, for ordinary and conflict
   resolver assignments. An explicit read-only check now precedes native edit authorization.

4. **P2 — Deleted helper executable permanently breaks a live host.** The cache retained a path
   after the owned temporary binary was removed. Preparation now checks the cached executable
   and performs a bounded rebuild before any file operation. Concurrent callers share the same
   replacement build. An invoked operation is never automatically replayed on timeout/error.

5. **P2 — Early preparation failures poison the helper cache.** Failure of `mkdtemp` occurred
   outside the old catch/reset block, so even repairing storage left a rejected Promise cached.
   Every failed build is now evicted; private temporary-storage failures and compiler failures
   have separate remedies. A single exit hook tracks only owned directories across rebuilds.

The file backend, bounded UTF-8 and SHA-256 checks, leases/fencing, approval authority,
independent verification and Linux descriptor backend are retained. No native Agy file/shell
tool was enabled. Unicode deny comparisons are deliberately conservative; inode identity is
required whenever non-literal matching would grant test-first edit permission.

## Regression evidence

Actual macOS Darwin 25.6.0 arm64, Node 22.17.1 and pnpm 12.5.1:

| Before source correction | Observed red results | Log |
| --- | --- | --- |
| forbidden Unicode aliases / nested control file | 4 failed, 28 passed | `/tmp/bflow-macos-review-unicode-red.log` |
| frozen-test aliases and pre-Red classification | 3 failed, 32 passed | `/tmp/bflow-macos-review-tdd-alias-red.log` |
| conservative-key collision must not grant permission | 1 failed | `/tmp/bflow-macos-review-positive-grant-red.log` |
| native read-only binding | 2 failed, 36 passed | `/tmp/bflow-macos-review-readonly-red.log` |
| missing helper / failed temporary storage recovery | 2 failed, 5 passed | `/tmp/bflow-macos-review-cache-red.log` |

The APFS alias checks perform real reads/writes with the supplied names. No platform mock is
used as macOS success evidence. The storage-failure test injects `ENOSPC`, then lets the next
attempt create a real private directory and compile with the actual system clang. The helper
replacement test removes the actual executable and checks eight concurrent preparers agree
on one replacement before real read/write succeeds.

The casing closure was additionally compared against all 1,530 nontrivial case-fold mappings
of the installed Python Unicode 15.1.0 database, with no missed pair. This is supplemental
comparison evidence; conservative casing keys alone never authorize non-literal test edits.

Final focused command (build/typecheck first):

```sh
pnpm check:deps
pnpm typecheck
pnpm exec vitest run packages/runtime/test/agentic/host-development-files.test.ts \
  packages/runtime/test/agentic/workspace-file-darwin.test.ts \
  packages/runtime/test/agentic/workspace-file-readiness.test.ts \
  packages/runtime/test/agentic/provider-hooks.test.ts \
  --maxWorkers=2 --minWorkers=1
```

| Final check | Exit | Passed / failed / skipped | Log |
| --- | --- | --- | --- |
| `pnpm check:deps` | 0 | dependency boundaries verified | `/tmp/bflow-macos-review-final-deps.log` |
| `pnpm typecheck` | 0 | source build/typecheck succeeds | `/tmp/bflow-macos-review-final-typecheck.log` |
| focused command above, actual macOS | 0 | **94 / 0 / 0** | `/tmp/bflow-macos-review-focused.log` |
| `pnpm test`, actual macOS | 1 | **4691 / 1 / 390** | `/tmp/bflow-macos-review-full.log` |
| actual Linux dependency/typecheck and affected tests | 0 | **82 / 0 / 15** | `/tmp/bflow-macos-review-linux.log` |
| `git diff --check`, worktree and delivered checkout | 0 | no whitespace errors | checked before handoff |
| `git status --short` | 0 | scoped changes plus preserved existing work | `/tmp/bflow-macos-review-worktree-status.txt`, `/tmp/bflow-macos-review-delivered-status.txt` |

Integration revalidation on the newer committed baseline `d6966eab2dc469f1b81fbfaf7890a21416302123`:
the original checkout received its existing blocker-notice work as a concurrent commit during
review. Its exact content was verified and retained. A separate worktree
`/Users/hongducc/orca/bflow-macos-review`, branch `fix/runtime/macos-review`, was created
from that descendant and received all 50 portability/review files, with the committed
Runtime README appendix preserved. Its source matches the delivered checkout byte-for-byte.

On that combined baseline, `pnpm check:deps` and `pnpm typecheck` both exit 0; `pnpm test`
exits 1 with **4707 passed, 1 failed, 390 skipped (5098 total)**. The sole failure
is the same uncommitted-runner-definition guard, with no new failure. Logs:
`/tmp/bflow-macos-review-integrated-deps.log`,
`/tmp/bflow-macos-review-integrated-typecheck.log`,
`/tmp/bflow-macos-review-integrated-full.log`. This is the final integration-tested HEAD,
plus the uncommitted scoped patch. No commit was created by this review.

The same single full-suite failure persists: `detects the real repository runner` refuses
uncommitted execution definitions in the repository it inspects. It was reproduced on the
baseline during the original delivery and is not a review regression. Neither its assertions
nor the production provenance check were weakened. The full suite includes real macOS Git,
SQLite, checkpoint, integration and fault recovery tests; their transport fixtures remain
distinct from actual provider evidence.

Linux runs in a fresh `--rm` Docker container from `bflow-toolchain-audit-local:review`,
Linux 6.10.14-linuxkit aarch64 / Node 22.23.2. It unpacks a read-only source archive, installs
the frozen pnpm lockfile, runs dependency and type checks, then the three file/readiness suites,
provider hooks and sandbox readiness with `--maxWorkers=2 --minWorkers=1`. Its 15 skips are
macOS-only cases. Original `dist` is not rebuilt, to preserve running user sessions.

## Scope and evidence limits

Review production changes are limited to `packages/runtime/src/agentic/host-development.ts`
and `workspace-file-darwin.ts`; the three existing file/readiness test files gain regressions.
The Runtime README and dated acceptance documents explain the corrections. No generated
binaries, database files, fixture state or logs are committed.

The eight review-delta files (the full portability delivery now contains 50 distinct files) are:

```text
packages/runtime/src/agentic/host-development.ts
packages/runtime/src/agentic/workspace-file-darwin.ts
packages/runtime/test/agentic/host-development-files.test.ts
packages/runtime/test/agentic/workspace-file-darwin.test.ts
packages/runtime/test/agentic/workspace-file-readiness.test.ts
packages/runtime/README.md
docs/acceptance/2026-10-24-macos-portability.md
docs/acceptance/2026-10-24-macos-portability-review.md
```

The review manifest is `/tmp/bflow-macos-review-delivery.json`; it records exact hashes,
the preserved prior delivery and the separate review patch. The existing other-agent Runtime
README appendix and all unrelated checkout changes are preserved byte-for-byte. The tested
HEAD remains `26974d2f4ed75a60a0c41ea683fe44eefa78875b` plus the scoped patch, without commits.

The earlier real Agy/Herdr Node/TypeScript workflow remains archived as completed/succeeded,
with its explicit human approvals and stopped owned session. The review does not reuse those
decisions for a new run, modify the completed run or claim a new full live-provider campaign.
Current guard/cache fixes are measured with real macOS file operations, native compilation,
fault injection and repository tests. NFS, power loss, hostile same-UID isolation, universal
polyglot support and Linux provider SDLC remain outside the verified evidence.
