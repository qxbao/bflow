# Bflow iso acceptance — 2026-10-20

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

This records the original standalone isolation milestone. The subsequent
configured-profile and setup synchronization acceptance is in
[iso-profile-acceptance.md](iso-profile-acceptance.md), which supersedes its
feature scope and final combined verification below.

Baseline/tested HEAD: `a4e62b82d36ebe4e7fdc28c2b9923c67bfe22e6c`, plus the CLI changes in the current working tree. Main HEAD was not advanced. Production ownership diff is confined to `apps/cli/**`; no public contracts, migrations, root build configuration or lockfile changes.

## Implementation and review

Luna implementation commits, from isolated worktrees at the same baseline:

- Engine: `967ffd2dc0177d568fb6e59354b79ee646dcb271`.
- Agy, interpreter/config isolation and removal fixes: `d6b08e4867eefda0be7828a3fe856857ac8ebc96`.
- CLI dispatch: `514db22aa1864dc288d5999cb54f4eb06c6c3a02`, `f31d007448c5477c4f234133a233645f2e7eadfe`.
- Signal cleanup and help: `0085b613b64c906cd0db9822475e203eca21c488`.
- Bounded fixture readiness/diagnostics: `df0f669cdad6791494049a6edee7952189edc572`.
- Independent compatibility fixture/tests: `6b463a1412e382c6c4bcf6aa063143ec3d45c5df`, `ca86c10a9118c5a3d86f8c22c13b9b787417f65c`.

Parent reviewed the integrated source and returned concrete findings to Luna. Independent final source review passed with no further confirmed findings. Fixed findings included loss of controlling TTY, incomplete SIGTERM/SIGINT child cleanup, split UTF-8 output, incompatible Python selection, and nonzero exit after successful unlinked-profile removal. The test fixture startup race was reproduced under concurrent host load and corrected with bounded readiness plus early-exit diagnostics.

## Compatibility evidence

The pinned original ai-isolator 0.4.4 fixture is byte-identical to the referenced checkout, SHA-256 `81d9f3649768d3650c6477df8bafbcc222bccfcf8b53893753ab6ffbf20d8b7d`.

Parent also ran the actual original checkout executable against built bflow, beyond the pinned fixture: all four Codex/Claude creation-consumption combinations passed in temporary homes. Checks covered login, run, status, remove, unchanged auth/config/profile metadata, literal arguments including shell metacharacters and empty arguments, cwd, secret scrub, provider exit 37 and real MCP helper synchronization in both directions. The original's unlinked removal returns 1 despite deletion; bflow intentionally fixes this to 0.

The installed `bflow` launcher invokes the updated built CLI. `bflow iso --help` passed. The installed Agy binary passed `bflow iso run agy --name native-help -- --help` under temporary profile state. This confirms argument/process launch compatibility only; no provider authentication or model request was run.

## Verification evidence

The session runs inside an existing isolated profile. Tests were executed with a temporary private HOME and XDG directories, `TMPDIR=/tmp`, inherited `AI_ISOLATOR*`/`CODEX_HOME` removed, and bounded Vitest workers. This leaves real profile files and shell RCs untouched and prevents inherited state-directory permissions from affecting unrelated tests. No root test configuration was changed.

| Command | Result |
| --- | --- |
| `pnpm check:deps` | Exit 0; dependency boundaries and acyclic graph passed. |
| `pnpm typecheck` | Exit 0. |
| `bash -n apps/cli/isolation/bin/ai-isolator` | Exit 0. |
| Python AST parse of `isolation/lib/mcp_sync.py` | Exit 0. |
| `pnpm --filter @bflow/cli test` (earlier integrated snapshot) | Exit 0; 835 passed, 8 skipped; 41 files passed, 2 skipped. |
| Final four `iso-*.test.ts` files (one worker) | Exit 0; 32 passed, 0 failed, 0 skipped; 4 files passed. |
| `pnpm test` with two workers | Exit 1; 3526 passed, 12 skipped, 2 Runtime test timeouts; 188 files passed, 4 skipped, 1 failed. |
| Isolated rerun of exactly the two Runtime timeout cases, unchanged 30s limits | Exit 0; 2 passed, 53 deliberately filtered/skipped. Cases took 21.17s and 29.37s. |
| `git diff --check`, including new files | Exit 0. |
| `git status --short` | Only the intended `apps/cli/**` changes. |

The unmodified baseline's inherited-environment full suite exited 1 with 66 failed, 3430 passed and 12 skipped. The exact hook/Gateway files that failed from inherited state paths subsequently passed 56/56 under a clean temporary environment. An oversubscribed integration run was terminated by the parent (exit 143); it is not counted as a completed full-suite result.

## Limits

- Two-way compatibility with original v0.4.4 covers Codex and Claude. Agy is additive in bflow; that original version does not launch Agy profiles.
- Agy login opens its native onboarding UI. Authentication status remains `unverified`; no unsupported auth command or model probe is invented.
- HOME/XDG isolation retains the user's filesystem permissions and is not an OS sandbox.
- Windows/Git Bash process-tree cleanup and native-provider authentication remain unverified. POSIX process/PTY tests ran on Linux.
- When the current shell differs from `$SHELL`, use `AI_ISOLATOR_SHELL` to select the intended RC. Node wrapping can trigger the original detector's `$SHELL` fallback; the alias prompt displays the RC before approval.
- No live Herdr transport, role workflow, provider model task or full SDLC acceptance is claimed.

The full suite is **not reported as green**: its exit was 1. Both failures were timeouts in unchanged Runtime code and tests; their isolated rerun passed without source or timeout changes. The feature acceptance is PASS for the 32 focused cases, cross-CLI checks, and Linux source/process behavior, with the limits above.

The full-suite command used `VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1`; focused/rerun commands used those limits at 1. Environment isolation was applied by the session helper `.bflow/iso-review/run-isolated.py` (temporary HOME/XDG, cleared inherited isolator paths). Exact final focused command:

```sh
pnpm exec vitest run apps/cli/test/iso-engine.test.ts apps/cli/test/iso-agy.test.ts apps/cli/test/iso-dispatch.test.ts apps/cli/test/iso-compat.test.ts
```

Exact Runtime rerun command:

```sh
pnpm exec vitest run packages/runtime/test/agentic/integration.test.ts -t 'preserves an actual conflicting integration worktree and escalates through Herdr|preserves each parallel task approval across restart before workflow delivery'
```

No generated output is committed. The reviewed implementation is applied to the current checkout; local implementation branches/worktrees remain available. No remote push, PR or merge was performed.
