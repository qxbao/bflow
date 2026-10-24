# macOS Runtime portability audit and acceptance

Post-delivery review found and fixed Unicode permission/TDD aliases, native read-only
authorization and helper-cache recovery defects. See the [review report](2026-10-24-macos-portability-review.md)
for the current patch and validation. The live SDLC evidence below records the earlier accepted
fixture; that full provider workflow was not re-run for the subsequent guard/cache fixes.

Baseline: `26974d2f4ed75a60a0c41ea683fe44eefa78875b`, verified descendant of P24
`8dbb056` and `a406b06`; branch `fix/runtime/macos-portability` in
`/Users/hongducc/orca/bflow-macos-portability`. No implementation commits, public
contract changes, schema/storage migrations, lockfile changes or global provider
configuration changes. The original checkout's unrelated uncommitted work is preserved.

Host: real macOS Darwin 25.6.0 arm64, Node 22.17.1, pnpm 12.5.1, Apple Command
Line Tools clang, local APFS. Linux checks use an actual Docker Linux kernel and
Node 22.23.2, not a mocked platform value. `/tmp` log locations below resolve to
`/private/tmp` on macOS. Generated binaries, logs and fixture data are not committed.

## Findings and fixes

| Path | Observed behavior and disposition |
| --- | --- |
| setup/doctor | `flock` is available from Homebrew and descriptor locking was exercised by independent ledger processes/crash recovery tests. Python discovery stopped at the first `python3`; an older interpreter hid a compatible later PATH entry. A red-first regression reproduces this and discovery now probes all existing PATH entries. No hardcoded global directories were added. |
| up/preflight | Provider readiness alone allowed a host incapable of Developer file IO to start. Host preparation now exercises exclusive creation, reading and SHA-256 replacement in its own temporary fixture before role launch. Developer allocation and dispatch repeat the file-capability check. Actual Seatbelt readiness now probes Node as well as `/usr/bin/true`; detected/configured verification without its sandbox blocks preparation. |
| launch/policy | Agy native file and shell tools remain denied. Each allowed read/write/check/commit/verification operation uses an existing structured Runtime tool. No permission mode, global settings, approval, lease, fencing or task-success rule was widened. |
| Gateway/browser process monitoring | Actual macOS regressions reproduced worker RSS always returning zero (procfs missing) and the browser process handle returning a fixed 50 MiB. Both now sample the owned PID using bounded `/bin/ps` with literal arguments/minimal environment. Resource-manager fallback sampling also handles macOS; resource leases/fencing and ownership are unchanged. The old exported Gateway reader name/signature is retained for compatibility. The browser regression launches only an owned Node child; it is not real Chrome acceptance. |
| Developer read/write | Both tools unconditionally rejected non-Linux hosts despite being the permitted Agy path. macOS now uses an owned C helper and directory-relative `openat`; Linux keeps the existing `/proc/self/fd` backend. |
| workspace boundaries | Preserved ownership/forbidden paths, read-only bindings, task identity, Runtime transaction/lease/fence, Red-first/source-edit authorization, frozen Red tests, size and UTF-8 limits, exclusive creation, mode preservation and SHA-256 preconditions. macOS case/Unicode normalization aliases cannot evade forbidden prefixes; case aliases of nested `.git`/`.bflow` are refused. |
| test/build | Actual Node TAP, TypeScript preparation and Vitest measurements plus adversarial Seatbelt tests run on macOS. Shell-script RTK test doubles could not run under a policy allowing only the exact executable; macOS fixtures now compile a native test CLI instead of granting shell execution to make tests pass. |
| commit/integration | Existing structured Git operations use POSIX Git and hooks-disabled scoped commits. Local Runtime integration tests exercise commits/merges/verification; the real model workflow's evidence is reported separately below. |
| recovery/down | Existing flock-based Runtime/checkpoint/fault tests had blanket Linux-only guards even though macOS has the required primitives. The portable suites now run on macOS; no assertions were removed and no skips were added. Named live fixture shutdown/restart preserves the pending approval. |
| test harness | Temporary fixture roots passed through `/tmp` or `/var` symlinks violated canonical-root requirements. Fixtures now canonicalize their newly created roots. Shared-staff macOS groups are not treated as private Linux user groups. Test-only sanitized PATHs explicitly retain their real Python prerequisite; the no-Python regression has a truly Python-free utility PATH. The controlling-TTY test uses a real PTY rather than GNU-only `script` flags. |
| remaining platform limits | Automatic isolated npm warming still requires Linux Bubblewrap/slirp4netns, and native polyglot adapter mounts/reports still require Linux. macOS Node dependencies must be installed before verification. No Windows, NFS, power-loss, multi-host or hostile same-UID guarantee is added. |

## Native helper and threat boundary

The helper source is `packages/runtime/src/agentic/workspace-file-darwin-source.ts`.
It travels with the TypeScript distribution, uses no downloaded package or ABI addon,
and is compiled once per host process by `/usr/bin/clang` into a fresh mode-0700
temporary directory. The compiler/helper receive a minimal environment and literal
arguments, never shell commands. CommonCrypto SHA-256 is supplied by macOS libSystem.
Compiler failures fail readiness with the build diagnostic and an installation/rebuild
remedy. Successful helper directories are removed on normal exit; interrupted ones are
never reused or adopted as executable proof.

The absolute canonical workspace root and each relative directory component are opened
with directory descriptors and `O_NOFOLLOW`. No file IO uses a reassembled absolute
pathname. `F_GETPATH` checks pinned directory locations, and the leaf uses `fstatat`,
`openat(O_NOFOLLOW|O_NONBLOCK)`, `fstat`, regular-file/single-link validation, bounded
reads and mutation-time identity/precondition checks. New files use `O_EXCL`. Native
UTF-8 checks preserve BOM and reject malformed, surrogate and overlong encodings.
The Runtime still holds its task transaction throughout the complete helper operation.

Deterministic adversarial tests withhold stdin after the helper opens the leaf, then
move the pinned parent outside the workspace and install a symlink, or replace the leaf.
The operation refuses the change and does not write either external/replacement content.
These are actual macOS syscalls. Descriptor pinning does not claim isolation from a
hostile process sharing the UID, nor atomic compare-and-swap writes against arbitrary
uncooperative host mutations. In-place writes retain the existing non-crash-atomic
semantics. Build/test subprocesses remain in their independent sandbox.

API provenance: Apple's [open(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html)
documents `O_NOFOLLOW`; [fcntl(2)](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html)
documents `F_GETPATH`. The implementation uses the installed macOS SDK's `openat`
and CommonCrypto headers. It does not depend on recent `O_RESOLVE_BENEATH`/`O_UNIQUE`
flags whose minimum OS availability is not established here.

## Verification evidence

Tested HEAD remains `26974d2f4ed75a60a0c41ea683fe44eefa78875b` plus the scoped patch.
The exact changed-file hashes and preservation evidence are in `/tmp/bflow-macos-delivery.json`;
the reviewable patch is `/tmp/bflow-macos-portability.patch`. Source was applied to the original
checkout without rebuilding its `dist`, preserving existing running sessions. Validation/builds
use the isolated worktree. Its source files match delivery byte-for-byte; the original Runtime
README additionally retains the other agent's existing appendix. No user index changes occurred.

| Command / scope | Exit | Passed / failed / skipped | Log |
| --- | --- | --- | --- |
| `pnpm check:deps` | 0 | dependency boundaries verified | `/tmp/bflow-macos-delivery-deps.log` |
| `pnpm typecheck` | 0 | source builds/typechecks | `/tmp/bflow-macos-delivery-typecheck.log` |
| `pnpm test` (final source) | 1 | 4679 / 1 / 390 | `/tmp/bflow-macos-delivery-full-tests.log` |
| enabled Runtime integration, host RPC, checkpoint and two fault-matrix suites | 0 | 180 / 0 / 0 | `/tmp/bflow-macos-enabled-integration.log` |
| workspace file access and native directory/leaf race suites | 0 | 32 / 0 / 0 | `/tmp/bflow-macos-files-final.log` |
| sandbox readiness, actual Seatbelt adversarial boundaries, missing compiler | 0 | 11 / 0 / 0 | `/tmp/bflow-macos-readiness-final.log` |
| Gateway/resource/browser RSS selected suites | 0 | 59 / 0 / 0 | `/tmp/bflow-macos-memory-green.log` |
| actual Linux dependency/typecheck + nine affected suites | 0 | 103 / 0 / 6 | `/tmp/bflow-macos-linux-delivery.log` |
| same-inode concurrent-update native helper probe | 0 | PASS, native mutation correctly refused | `/tmp/bflow-macos-native-precondition.json` |
| `git diff --check` (worktree and delivery) | 0 | no whitespace errors | checked at handoff |
| `git status --short` | 0 | intentional uncommitted patch, preserved other work | `/tmp/bflow-macos-worktree-status.txt`, `/tmp/bflow-macos-delivered-status.txt` |

The single full-suite failure is the existing real-repository runner-discovery test. Its
security rule correctly refuses execution definitions differing from committed HEAD, including
uncommitted tests. An independent baseline worktree reproduces the exact failure after changing
one test file, then passes after restoring it: `/tmp/bflow-macos-baseline-dirtyguard.log` and
`/tmp/bflow-macos-baseline-cleanrunner.log`. No assertion was deleted, skip added or provenance
rule weakened to hide it. The final suite executes 123 previously skipped cases on macOS.

Linux uses the existing local image `bflow-toolchain-audit-local:review` under Docker
Linux 6.10.14-linuxkit aarch64, Node 22.23.2 and pnpm 12.5.1. A read-only archive of the
final sources is unpacked inside an ephemeral `--rm` container; it installs the frozen
lockfile, checks dependencies, typechecks and tests actual Linux procfs access. The six
skips are explicitly macOS-only cases. This is Linux component evidence, not a Linux
provider/Herdr SDLC campaign.

Baseline `pnpm test`: exit 1; 4,456 passed, 84 failed, 513 skipped, 265 files;
`/tmp/bflow-macos-baseline-tests.log`. Workspace regression before source edits:
exit 1, 7 failed/19 passed; `/tmp/bflow-macos-workspace-red.log`.

Additional red-first regressions: Python later on PATH
(`/tmp/bflow-macos-python-path-red.log`), and a usable system Seatbelt binary with
an unusable actual Node runtime (`/tmp/bflow-macos-sandbox-readiness-red.log`).
Actual macOS process-memory regressions: 2 failed/6 passed before source changes,
then 59/59 selected Gateway/resource/browser tests passed after the fix;
`/tmp/bflow-macos-memory-red.log`, `/tmp/bflow-macos-memory-green.log`.

Initial full validation after fixes: exit 1; 4,542 passed, 5 failed, 513 skipped;
`/tmp/bflow-macos-full-tests-1.log`. Four Context7 fixture failures were subsequently
fixed by canonicalizing their owned temporary root (12/12 Context7 tests pass).
The remaining test expects runner discovery in the live checkout while security
correctly refuses its uncommitted execution definitions; the test is not weakened.

## Live macOS fixture

Only the disposable repo `/private/tmp/bfm-4oal26` and its named session
`bf-9a7a209d996f3d0965d5` are used. Provider: Agy 1.4.7,
`gemini-3.8-flash-high`; Herdr 0.9.1 with actual protocol 22/native sessions.
The fixture installs its pinned TypeScript dependency before startup and disables
unneeded optional external tools in its own repository config. Its fixture-only
Git commits do not change the Bflow implementation repository.

Initial provider access exceeded the bounded model-listing deadline; the actual
read-only `agy models` command subsequently completed. A second `up` succeeded:
seven signed activated roles, `status` issues empty. Conversation admitted the
real request, delivered `delegation.request` through Runtime/Herdr, and Coordinator
proposed an accepted lightweight specification with required independent TDD.

Run: `run-318fbc60809f0bf56fd24a92a08bcf003536fdbd325aaf0088a9100d9f7deea2`.
It reached the actual `Specification acceptance` human gate before Developer dispatch.
The pending revision-1 design is
`design-63be3ca90d61b57359219b5e1866b758fe077ed701c208a2e9ad6682084c88e0`,
bundle fingerprint `e790eafb57b7cc15c8137372ee095f7d154786b107721f9600a75a97584e9e8b`.
It limits changes to `src/math.ts` and `test/math.test.mjs` and requires overflow
to throw `RangeError` while preserving existing behavior. The reviewable design
is `/tmp/bflow-macos-live-design.json`. The user explicitly approved that exact design
in this session. The decision was relayed as the exact approval ID through the physical
Conversation hook and authenticated by Runtime as `local-user-501`, at
`2026-10-24T13:17:19.484Z`; no direct approval-store mutation occurred.

Actual Agy Developer `dev-7cfff7f0e55621a7de5c` (`w2:p2`, native session
`8bd881de-3737-438a-a486-018d56c771b9`) successfully read/wrote through the scoped MCP
workspace tools and committed its changes. Independent QA measured Red at
`89611ecd944a84f02c1d5b76e1f878c61b9b6567` (exit 1, target-behavior failure) and Green
and Refactor at `036e413a985736083c6da3871fcbb7f163d48ca0` (exit 0). The frozen test blob
`b3880de4aac261d33ea82d023fc6e6e97f90422d` is identical in all three phases. These
measurements run `/usr/bin/sandbox-exec`, include TypeScript preparation and select the
criterion-mapped regression (1 test, no skips). The four original tests remain in the file
unchanged. A full unfiltered fixture test run is recorded separately at final acceptance.

The Developer submitted its implementation and Runtime recorded the correlated
AgentResult. Task-level verification and Reviewer/QA passed, then Git Integration produced
`4ef7e4a0161772c8b1494a6ddd2877303ab530fe` on the fixture integration branch. Independent
workflow-level verification passed at that exact revision.

The user separately approved the final delivery gate
`delivery-c0b8b76924f5a47e3181b25557e22776689e536273a7aafa06c614ca1a3c8211`. That decision
was relayed through the native Conversation hook too. The authoritative Runtime journal
now reports **SDLC `completed`**, and the schema-parsed host query reports **Core
`succeeded`** with its task `succeeded`; workflow cycle `passed`. This is real macOS
provider/Herdr acceptance of this specific Node/TypeScript fixture, not an inference from
transport idle/done. `/tmp/bflow-macos-live-final-state.json` captures the final state.

The additional unfiltered production-sandbox measurement at the integrated revision
passed all **5 tests**, exit 0, no skips: `/tmp/bflow-macos-all-tests.json`. All **26**
referenced immutable artifacts were re-read using ArtifactStore.get and independently
checked for size/digest: `/tmp/bflow-macos-live-artifact-integrity.json`. The native helper
also passed an actual `/Users/hongducc/orca` volume probe, covering the production
repository path family in addition to canonical temporary directories:
`/tmp/bflow-macos-users-root-probe.json`.

Detailed revision-bound evidence is `/tmp/bflow-macos-live-evidence.json`. Only the
fixture initialization/task/integration commits exist; no Bflow implementation commit,
remote push, PR, deployment, or main-branch integration in the Bflow repository occurred.
Logs: `/tmp/bflow-macos-live-up-2.json`, `/tmp/bflow-macos-live-status-startup.json`,
`/tmp/bflow-macos-live-progress.json`, and the fixture's Runtime task-activity log.

Final cleanup: the fixture CLI `down --yes --timeout 90000 --json` returned exit 0,
manifest status `down`; a subsequent named Herdr status query reports `running: false`.
Only this fixture session was stopped. State, approvals, artifacts and the two clean
fixture worktrees are retained as evidence; no task/run in the original repository was
stopped or resumed. A prior stop/start also retained the exact pending design approval
and its fingerprint before the user decided it. Logs: `/tmp/bflow-macos-live-final-down.json`,
`/tmp/bflow-macos-live-status-stopped.json`, `/tmp/bflow-macos-live-herdr-stopped.json`.

The main fixture branch remains at its initialization revision; the verified result is
on the explicitly named integration branch, with the actual integration commit above.
No remote is configured and no publication was attempted. This acceptance covers this
Node/TypeScript fixture on the measured Mac; it does not prove cross-provider conformance,
real Chrome acceptance, polyglot mounts, automatic macOS dependency warming, or Linux live
SDLC. The final delivery decision and completed state are preserved in the fixture journal.

Reproduction commands for the native supplemental probes and all-tests audit are
`node /tmp/bflow-macos-native-precondition.mjs`,
`node /tmp/bflow-macos-all-tests.mjs` (requires the pre-delivery verified fixture state), and
`node /tmp/bflow-macos-verify-artifacts.mjs`. They are retained beside their JSON evidence.
The implemented source tests are part of `pnpm test`; the focused Runtime run was:

```sh
pnpm exec vitest run packages/runtime/test/agentic/integration.test.ts \
  packages/runtime/test/agentic/core-checkpoint-restore.test.ts \
  packages/runtime/test/agentic/lifecycle-fault-matrix.test.ts \
  packages/runtime/test/agentic/lifecycle-fault-matrix-extended.test.ts \
  packages/runtime/test/agentic/conversation-host-rpc.test.ts \
  --maxWorkers=2 --minWorkers=1
```

## Changed files

The following 49 files belong to this patch; the other checkout changes are preserved
and excluded from its manifest. Generated binaries/dist/logs are not included.

```text
README.md
apps/cli/isolation/README.md
apps/cli/isolation/bin/ai-isolator
apps/cli/test/gateway-control.test.ts
apps/cli/test/iso-agy.test.ts
apps/cli/test/iso-compat.test.ts
apps/cli/test/iso-dispatch.test.ts
apps/cli/test/iso-engine.test.ts
apps/cli/test/iso-platform-sync.test.ts
apps/cli/test/profile-setup.integration.test.ts
apps/cli/test/setup-context7.test.ts
docs/acceptance/2026-10-24-macos-portability.md
docs/guide/installation.md
packages/agent-providers/test/agent-providers.test.ts
packages/mcp-gateway/README.md
packages/mcp-gateway/src/metrics.ts
packages/mcp-gateway/test/durable-ledger.test.ts
packages/mcp-gateway/test/mcp-gateway.test.ts
packages/mcp-gateway/test/process-memory.test.ts
packages/mcp-services/README.md
packages/mcp-services/src/browser-runtime.ts
packages/mcp-services/src/process-memory.ts
packages/mcp-services/src/resource-manager.ts
packages/mcp-services/test/browser-memory.test.ts
packages/pane-manager/test/native-agy-prompt.test.ts
packages/pane-manager/test/role-pane-manager.test.ts
packages/runtime/README.md
packages/runtime/src/agentic/behavioral-sandbox-darwin.ts
packages/runtime/src/agentic/host-development.ts
packages/runtime/src/agentic/host.ts
packages/runtime/src/agentic/sandbox-readiness.ts
packages/runtime/src/agentic/workspace-file-darwin-source.ts
packages/runtime/src/agentic/workspace-file-darwin.ts
packages/runtime/src/agentic/workspace-file-readiness.ts
packages/runtime/test/agentic/agy-native-transcript.test.ts
packages/runtime/test/agentic/behavioral-runner.test.ts
packages/runtime/test/agentic/conversation-host-rpc.test.ts
packages/runtime/test/agentic/core-checkpoint-restore.test.ts
packages/runtime/test/agentic/host-development-files.test.ts
packages/runtime/test/agentic/integration.test.ts
packages/runtime/test/agentic/lifecycle-fault-matrix-extended.test.ts
packages/runtime/test/agentic/lifecycle-fault-matrix.test.ts
packages/runtime/test/agentic/provider-hooks.test.ts
packages/runtime/test/agentic/rtk-fixture.ts
packages/runtime/test/agentic/sandbox-readiness.test.ts
packages/runtime/test/agentic/workspace-file-darwin.test.ts
packages/runtime/test/agentic/workspace-file-readiness.test.ts
packages/runtime/test/platform/service.test.ts
tests/helpers/python-runtime.ts
```
