# Verification runner

Runtime discovers installed test toolchains without requiring `.bflow/verification.json`.
Accepted `unit_test`, `integration_test` and `e2e_test` criteria retain their method;
an exit code by itself never proves a criterion. Detection, source implementation,
local parser/fixture tests and real sandbox measurements are different evidence levels.

## Adapter architecture and planning

`RunnerAdapter.detect(AdapterContext)` reads a bounded manifest inventory without
following symlinks. It returns Runtime-private `AdapterRunner` values: verified
installed toolchain version, executable, fixed argv binder, optional prepare step,
read-only mounts, offline environment, protected configuration and result parser.
No RoleMessage supplies these execution fields. Only exact test names and committed
test paths come from the accepted strategy/specification and task ownership.

Multiple adapters can match one repository. Labels are `auto:unit:<adapter>`,
`auto:integration:<adapter>` and `auto:e2e:<adapter>`; nested projects append their
readable repository-path slug plus a stable SHA-256 suffix, so paths such as `a/b` and `a-b` cannot collide. Existing root JavaScript `auto:unit` / `auto:integration`
labels remain aliases; `auto:e2e` is added. `planning_reference.testRunners` includes
the exact name rule, version and project. Coordinator selects these labels through
the existing infrastructure commands. Nested Vitest and Node projects use the same reporter protocols and exact-name filters as root projects. Each criterion mapping must bind unambiguously to one selected profile; only that profile receives its names, and Quality Gates retain the same partition. Ambiguous cross-runner mappings require a reviewed task/specification split. A language label does not establish that a
particular test is an integration or E2E test; its accepted criterion remains authoritative.

The same task resolver feeds Developer feedback, independent Red/Green/Refactor and
Quality Gates. Only selected labels become checks. Runtime composes the existing
VerificationEngine with the current detected gates when a plan is frozen; subsequent
runner setup does not require a host restart. Unsupported detection retries; successful
detection refreshes after repository HEAD changes and retains in-process snapshots for existing task revisions. Original task-base blobs are checked even if a newer host revision has been detected. After a host restart, a differing historical profile that cannot be reconstructed remains blocked; durable profile reconstruction is not certified by this change. A task never receives an agent
supplied replacement command or a successful verdict.

## Regression scope (`verification.regressionScope`)

When automatic JS/TS runner detection is active (no `.bflow/verification.json` owner override), `HostVerification` also registers per-profile regression gates (`host-regression-<profile.id>`) controlled by `verification.regressionScope` in `.bflow/config.yml`:

- **`affected` (default for new/migrated repository configs)**: Host computes `git diff --name-status -M -z <base> <head> --` (where `base` is the task worktree's `baseCommitHash` or `run.baseRevision` for workflow verification) and classifies changed files along a monotonic 3-tier safety lattice (`none` → `graph` → `package` → `full`):
  - **Docs-only (`none`)**: Only `.md`, `.mdx`, `.txt`, `.rst`, `LICENSE*`, `CHANGELOG*`, or `docs/**` changed — passes immediately without spawning a test runner (`reason: "docs_only"`).
  - **Import-closure graph (`graph`)**: Changed code files query the isolated GitNexus index (`GITNEXUS_HOME`, `GITNEXUS_SHARED_STORE=off`) via `gitnexus cypher` (`MATCH (f:File)-[:IMPORTS*1..10]->(t:File)`) only when `gitnexus status --json` and the storage lock file prove freshness at `base` (`index.commit === base`, `status === "up-to-date"`, `contentDrift.status === "current"`, empty `incompleteReasons`) both **before and after** the query.
  - **Safe widening (`package` / `full`)**: Sub-package manifest/config or non-code files widen to all tests in that package (`package`); root manifests, lockfiles, tsconfig/vitest/jest configs, scripts, CI workflows, `.bflow/**` or >50 changed code files widen to all repository tests (`full`). If the GitNexus index is unavailable/stale or a changed code file is absent from `File` nodes, that file widens to its owning package (or `full` at repo root) with an explicit `widening` audit entry (`index_unavailable:<code>` / `not_in_graph_index`) rather than failing or skipping tests.
- **`full`**: Runs all candidate test files in the repository on every verification cycle without consulting GitNexus.
- **`mapped_only`**: Disables `host-regression-*` gates (keeps only criterion-mapped checks). Persisted `host.json` files created before this feature default to `mapped_only` on recovery so in-flight runs never change gate topology mid-run.

Regression runs execute whole test files without a `--test-name-pattern` / `-t` filter inside the same Bubblewrap/Seatbelt sandbox (deadline `min(540_000, profile.timeoutMs * 3)` ms) and use a tolerant parser (`packages/runtime/src/agentic/regression-results.ts`) that allows skipped/todo tests in existing suites while capturing all assertion, file-level and unhandled runtime failures. Any test file that fails at `head` and existed at `base` is re-measured at `base` (with `try/finally` restoring the worktree ref): failures already present at `base` become `warning` findings (`pre_existing_failure`) and do not fail the gate, whereas new failures at `head` fail the gate with `error` findings (`regression_failure`). Runner crashes, unparseable output or timeouts block the gate (`regression_infrastructure` / `regression_budget_exceeded`).

## Fast-path review waivers and host-measured gates

When `environment.fastPath.mode` is `"auto"` (default for new/migrated repository configs; persisted `host.json` files without `fastPath` default to `"off"`) and Runtime freezes `run.fastPath.status = "active"` for a single-task `trivial` change ([ADR 0004](adr/0004-fast-path-review-waiver.md)), review waivers rely strictly on independent gates measured by the host (`bflow-host-behavioral-check` / `bflow-host-git-check`), never on agent-supplied output or flags:

- **Task-level waiver (`deterministic_coverage`)**: Applied only when every active required acceptance criterion uses an automated method (`verificationMethod !== "manual_review"`), is completely mapped to host-executed `kind: "deterministic"` checks, `strategy.targetCommands.length > 0`, and `strategy.tddDecision.mode !== "required"`. Documentation-only changes (`manual_review`) have no behavioral runner and therefore keep independent Reviewer/QA checks at task scope; `bugfix`/`feature` and `tddDecision.mode === "required"` are ineligible for fast-path.
- **Workflow-level waiver (`identical_integrated_tree`)**: Applied only when the single task's verification cycle `passed` and the host-verified Git tree of `integration.expectedHead` (`git rev-parse --verify <rev>^{tree}`) equals the task commit's tree hash. Host deterministic checks (`host-git-integrity` and configured regression gates) remain mandatory at workflow scope. If P17 rejects a waiver or the integrated tree differs (`tree_mismatch`), Runtime downgrades one-way (`status: "downgraded"`) to the full Reviewer + QA verification plan.
- **Interaction with `host-test-integrity` under default host checks**: Because the default host check suite includes the mandatory `host-test-integrity` gate (`packages/runtime/src/agentic/host-verification.ts`), which requires independent Reviewer adjudication of test/config weakening candidates, `fastPath` is conservatively downgraded (`test_integrity_requires_independent_review`) when `host-test-integrity` is present. Review waivers apply only under custom host check configurations that omit `host-test-integrity`. Evidence level is source implementation plus local/fake-runner tests, not live Herdr/provider acceptance.

## Runner matrix

All rows below have source and local fixture/parser coverage. The original polyglot
implementation host could not run its empty Bubblewrap probe (`loopback: Failed RTM_NEWADDR:
Operation not permitted`); measurements skipped after that probe were not passes.
Later [macOS measurements](acceptance/2026-10-24-macos-portability.md) cover JS/TS
Seatbelt only, not all native adapters. Other historic Linux measurements are scoped
in the [release report](release-readiness-v3.md). Parser fixtures for unavailable tools
reproduce documented output shapes, not recorded runs.
The Node/Vitest parser-selection regression includes captures from installed tools,
which are parser evidence only. Installed Node, Python, Maven and Java version probes
are separate from test execution evidence.

| Ecosystem | Runner / format | Canonical identity / exact selection | Current limits |
| --- | --- | --- | --- |
| JS/TS | Vitest 1/2/3 JSON + trusted completion reporter | describe titles + title, joined by spaces; anchored name regex and explicit files | major versions outside 1–3 rejected; protocol changes fail closed |
| JS/TS | Jest JSON | fullName; anchored name regex and `--runTestsByPath` | installed runner required |
| JS/TS | Mocha JSON | fullTitle; anchored `--grep`, explicit files | hooks/runtime exceptions reject Red |
| JS/TS | `node --test` TAP | test title; anchored `--test-name-pattern`, explicit files | flat TAP only; Node version filtering behavior is validated by parser |
| Python | pytest JUnit (unittest can run through pytest) | `classname.name`; invert mapped module/class into exact pytest node IDs | existing `.venv`, `venv`, active env, uv in-project env, Poetry/Pipenv matching envs; installed pytest required |
| Go | `go test -json` | import-path + `.` + Test/subtest | one package per command; exact top-level union or one subtest path; no benchmark evidence |
| Rust | cargo / libtest | exact libtest test name | one exact test and explicit lib/integration target per command; libtest captures assertion diagnostics for Red; locked offline dependencies; inline test files freeze their implementation bytes after Red |
| Java/Kotlin | Maven Surefire JUnit | fully qualified class + `.` + method | conventional Surefire reports, exact `-Dtest`; parameterized identities require agent setup |
| Java/Kotlin | Gradle JUnit | fully qualified class + `.` + method | conventional `test` task/report path; installed Gradle; exact `--tests` |
| .NET | `dotnet test` TRX | TRX TestMethod className + `.` + method | one test project per directory; isolated offline restore from installed cache, then exact FQN filter |
| Ruby | RSpec native JSON | example full_description | installed RSpec; exact full-description regex; no external JUnit formatter needed |
| Ruby | Minitest Runtime JUnit helper | Ruby class + `.` + method | installed reporter-capable Minitest; immutable Runtime helper; exact Class#method regex |
| PHP | PHPUnit JUnit | JUnit `classname.name`; PHP namespace separators become dots | existing global/local PHPUnit; exact class::method filter |
| C/C++ | CTest >=3.21 JUnit | testcase name | committed CTest registration and executable material only; generated ignored build directories request agent setup; build/configure automation is not implemented |
| Other | declared Make/Just/Task target with JUnit protocol | `classname.name`; selected names/files passed as JSON argv variables | ordinary arbitrary scripts, tox/nox require a reviewed agent setup task |
| Elixir, Swift, Dart/Flutter | not implemented | — | follow-up adapters; do not downgrade criteria |

Detected JS may run only a recognized `tsc`, `tsc -b` or `tsc --build` prepare step,
including safe relative projects. Other builds receive a detection note. JVM/.NET/Go/
Rust native commands perform their normal offline build in the disposable checkout;
outputs must be git-ignored. No snapshot update or tracked-file modification is accepted.

## Structured results

The shared bounded XML codec accepts JUnit suite trees and .NET TRX. DTDs, custom
entities, external resolution, processing instructions, malformed nesting, duplicate
attributes, illegal characters and oversized/deep trees are rejected. JUnit names use
nonempty `classname + '.' + name`, or just `name` when classname is empty. Each suite's
counters must agree with leaf results. `<error>` is infrastructure; `<failure>` proves
Red only with recognized assertion diagnostics; skipped/disabled mapped tests block.
TRX checks definitions, outcomes and counters, then uses the same assertion rule.

Native JSON/libtest/TAP codecs enforce complete output, unique exact mapped identities,
nonzero test counts and exit consistency. Rust assertion failure exits 101; CTest exits 8;
other adapters normally exit 1. Go has no typed assertion channel: Red conservatively
requires source-located expected/want/assertion comparison diagnostics and rejects
panics/build/runtime errors. This is a narrower supported diagnostic convention, not a
general proof that arbitrary `testing.T.Fatal` text denotes an assertion.

Name-filtered Vitest/Jest may list unselected tests as pending/skipped; those leaves are
excluded only when their names are outside the selected mapping, and never contribute
evidence. A selected skipped/todo test still blocks. Owner-configured commands retain
their existing stricter reporter policy. Zero, truncated, mismatched or infrastructure
results never become passing evidence or a conclusive Red receipt.

## Original revision and conditional TDD

Detection pins committed Git blobs for manifests, lockfiles, runner config, build hooks,
CI config, scripts and test/helper trees. Local definitions must match committed bytes.
At measurement, changed/deleted/new definitions—including root `conftest.py`, Cargo
`build.rs`, Python startup hooks, Makefiles and package scripts—reject evidence.
Gradle `.gradle`/`.gradle.kts` and MSBuild `.props`/`.targets` files are pinned throughout the repository. Literal Gradle `apply from` and MSBuild `Import Project` references are followed to committed repository-local files, including custom suffixes. Dynamic/concatenated or unresolvable references return an agent setup requirement. Missing pin metadata rejects automatic measurements. Selected test paths are handled
separately: Developer may create/change them before independent Red; afterward exact
Red test blobs and all execution definitions are frozen. Runtime compares those blobs
again for Green/Refactor. Test setup changes must go through review and integration,
and become authority only from the base revision of later tasks.

The fallback recognizes a declared `test` target only when its definition mentions all
three Runtime protocol values: `BFLOW_TEST_NAMES` (JSON), `BFLOW_TEST_FILES` (JSON), and
`BFLOW_JUNIT_OUTPUT` (private report path). Runtime passes values as separate argv tokens;
it never evaluates a RoleMessage command. Because recipe engines can re-expand assignments, the generic fallback accepts only literal safe name/path characters; shell/Make syntax in identities requests agent setup rather than entering target expansion. The target must produce fresh structured output
with exactly the selected names. A plain `make test`, shell exit 0, CI success or an old
report is not evidence. Arbitrary target syntax, tox/nox and script-specific reporters
are agent setup work, rather than guessed invocation conventions. This intentionally
narrow fallback prevents claiming universal arbitrary-script support.

## Owner override tùy chọn: `.bflow/verification.json`

Owner vẫn có thể tự khai báo các behavioral command trong `.bflow/verification.json`
(ví dụ cho runner hoặc reporter mà việc phát hiện không hỗ trợ, hoặc để pin argv chính xác).
Khi file đó tồn tại, các command của nó được dùng đúng như trước đây, và việc tự động phát hiện
bị tắt cho host đó. Đây là thẩm quyền của operator: Coordinator có thể chọn các command label
đã chấp nhận và tên test đã ánh xạ, nhưng không thể cung cấp executable, argv, output hay
verdict thành công. Host đã persist pin digest của cấu hình. Thay đổi file sau khi host được
tạo sẽ bị từ chối; hãy giữ state và reconcile/migrate host một cách tường minh. Không xóa
journal của host để vượt qua sự không khớp cấu hình.

## Ví dụ Node TAP

Thay `/absolute/path/to/node` bằng executable Node đã cài. Giữ đúng đường dẫn test đã commit
và đúng tên đã quan sát; protocol Node được hỗ trợ là TAP `node:test` phẳng, với assertion
failure cho pha Red.

```json
{
  "schemaVersion": 1,
  "behavioralCommands": [{
    "id": "unit",
    "command": "owner:test-unit",
    "executable": "/absolute/path/to/node",
    "args": ["--test", "--test-reporter=tap", "test/behavior.test.cjs"],
    "method": "unit_test",
    "levels": ["unit", "regression"],
    "testNames": ["ac-1: Target behavior matches expected output"],
    "testPaths": ["test/behavior.test.cjs"],
    "timeoutMs": 30000,
    "maxOutputBytes": 1048576
  }]
}
```

Strategy đã chấp nhận phải dùng `owner:test-unit` và ánh xạ tiêu chí tới đúng tên test.
Quyền sở hữu task đã chấp nhận phải bao gồm các đường dẫn test và implementation. Chỉ thêm
cấu hình này với tư cách project owner; Developer không thể sửa `.bflow` qua các tool của nó
hay commit nó như một phần của task.

## Ví dụ Vitest 2.1

Dùng cùng envelope và các field command, với:

```json
{
  "reporter": "vitest_json",
  "executable": "/absolute/path/to/node",
  "args": [
    "/absolute/toolchain/node_modules/vitest/vitest.mjs",
    "run", "--globals", "--reporter=json", "--no-cache",
    "--maxWorkers=1", "--minWorkers=1", "test/behavior.test.cjs"
  ],
  "dependencyRoots": ["/absolute/toolchain/node_modules"]
}
```

Đây là đoạn fragment để gộp vào command hoàn chỉnh, không phải schema cấu hình riêng. Dùng
`fullName` JSON thực tế của Vitest cho mọi mục `testNames` (bao gồm tên suite). Runtime thêm
reporter đồng hành tin cậy của nó vì JSON của Vitest 2.1 bỏ sót các runtime error không được xử
lý. Thiếu completion, runtime error, skipped, todo, không có test nào, bộ đếm sai định dạng,
tên không mong đợi, timeout và output bị cắt đều chặn bằng chứng. Node TAP vẫn là mặc định khi
bỏ qua `reporter`.

## Sandbox and dependency ownership

Linux (including WSL2 only when the real namespace probe passes) uses Bubblewrap found
on PATH, canonicalized and tested in a real empty namespace. `bflow up` probes readiness;
activation records a structured `verification_sandbox_unavailable` Conversation notice
when automated runners exist. Planning exposes that state. Measurement always fails closed
if the boundary is unavailable; no command runs outside it. macOS uses the Seatbelt backend described below for legacy JS/owner commands. Native
Windows, Docker and Podman backends are not implemented or certified by this change.
There is no automatic sandbox installation or privilege/sysctl change.

Measurement mounts system `/usr` read-only, the exact disposable revision checkout,
selected binaries and narrowly selected toolchain/dependency roots. It unshares network,
PID, IPC, user and mount namespaces, drops capabilities and inherits no host environment,
home or sockets. HOME/TMPDIR refer to private anonymous tmp space. Toolchains outside
`/usr` use canonical realpaths; whole homes/ancestors, credential directories, special
files and escaping cache symlinks are rejected. Java imports only public launcher/security
files, not Maven settings or Java management passwords. Dependency trees are read-only:
repo-relative node_modules/vendor and selected venv libraries retain their layout;
Cargo registry, GOMODCACHE, Maven repository, Gradle modules cache and NuGet packages
use selected paths. Imported node_modules trees are checked for special files (including pathname sockets) and credential material; pnpm links across the selected repository layout remain supported. No `~/.npmrc`, `.netrc`, `.ssh`, global Gradle init/config, Composer auth
or provider credentials are intentionally imported. This is a local Linux boundary,
not hostile-kernel or hostile-same-UID isolation certification.

Fresh reports come from private output paths or bounded conventional build-report
patterns. Preexisting reports reject invocation. Collection rejects symlinks, special files,
path escapes, duplicate files and oversized output; regular files are opened without
following symlinks. Host Git operations used for measurement disable user/system Git configuration, hooks, fsmonitor, recursive submodules and effective clean/smudge/process filters, including included configuration, worktree scopes and gitdir-conditional includes, so checkout/status cannot launch repository filter commands before the sandbox. A worktree is registered with `--no-checkout`; its effective configuration is inspected again before file materialization. Git attributes/LFS/submodule definitions are pinned too. Tracked integrity and report freshness are checked again between prepare and the test command, preventing a prepare step from changing bytes that tests later restore or pre-seeding a report. After prepare/tests, tracked and nonignored untracked files must
still match the exact revision. Only disposable checkouts are forcibly removed.

## Automatic dependency warming: threat model and limits

If JS detection needs missing dependencies and a safe npm lock is available, Runtime
can create a separate owned cache. Warming requires package-lock v2/v3, registry-only
specifications, HTTPS public registry tarballs and strong integrity pins. Local/git/URL
packages, workspaces, overrides and unsupported lock shapes are rejected. The separate
Bubblewrap sandbox retains its own network namespace. A capability-probed installed `slirp4netns` helper supplies downloads only after an actual readiness handshake; host loopback and the helper DNS proxy are disabled. A Runtime-owned resolver uses public DNS `1.1.1.1`; host resolver configuration is not mounted. Missing helper capabilities return `unsupported`. The guest sees no checkout, host home, socket,
user/global npm config or inherited proxy/auth environment. It runs only trusted npm
`ci --ignore-scripts --no-audit --no-fund`; dependency lifecycle/build scripts never run.
Frozen manifests are mounted read-only. The only writable host path is its owned cache;
private `/tmp` is anonymous. Subsequent measurement mounts dependencies read-only and
again unshares network. Host teardown removes caches created by that Runtime process.
A killed host may leave an orphan cache; no cross-session reuse or replay is inferred.

The installed Node/npm and OS are trusted. A malicious downloader vulnerability or a
compromised allowed registry remains a risk; integrity pins bind bytes, not package safety.
Public egress is not domain-level firewalling: npm validation restricts declared URLs,
but redirects and the trusted downloader's own traffic are not a separate egress guarantee.
Services on host LAN/public addresses are not separately firewalled. Abstract host Unix
sockets remain outside the guest network namespace; no direct host-network fallback exists.

Safe warming for pnpm/yarn workspaces, Python, Go, Rust, JVM, .NET, Ruby and PHP is not
implemented. Their measurements can use already installed dependencies/read-only caches;
missing dependencies remain agent setup work. In particular, Maven/Gradle resolution and
language build hooks must not be run in the network sandbox as a shortcut. No automatic
package lifecycle script or user-global configuration mutation is authorized.

## Repair routing and remaining acceptance

Recognized ecosystems needing a runner/reporter/setup return `runner_setup_required`,
a Coordinator-fixable structured rejection with no user notice. Missing mappings, paths,
labels and method support remain agent-fixable. An unknown ecosystem can still return
`no_test_runner_detected`. User-facing notices contain no manual configuration steps.
Setup tasks retain SDD, conditional TDD, independent review and approval requirements;
this implementation emits the task requirement, it does not invent an approved setup task
or waive a required gate. None of these changes establish live Herdr/provider acceptance.

### Backend macOS (Seatbelt)

Trên macOS, Runtime dùng `/usr/bin/sandbox-exec` với profile `(deny default)`
(`packages/runtime/src/agentic/behavioral-sandbox-darwin.ts`). Vẫn không có fallback không sandbox:
thiếu `sandbox-exec` hoặc launcher báo lỗi (`sandbox-exec: ...`) là lỗi hạ tầng, không bao giờ được tính là
kết quả test. Khác biệt so với Linux:

- Seatbelt không ẩn đường dẫn mà chỉ từ chối nội dung. Host vẫn tồn tại và metadata (`stat`) đọc được vì
  `realpath` của Node cần `lstat` mọi thư mục cha; nội dung home, `.ssh`, `/etc`, state, secret và
  Git metadata đều bị từ chối đọc/ghi. Các cây dependency cũng được kiểm tra credential, special file và symlink thoát trước khi cấp quyền.
- Chỉ có các quyền ghi: checkout và một thư mục `tmp` riêng (cũng là `TMPDIR`/`HOME` của tiến trình).
  File reporter companion, executable Node và các root dependency chỉ đọc.
- Không có bind mount, nên `node_modules` phát hiện tự động được clone vào checkout bằng `cp -c -R`
  (copy-on-write trên APFS), rồi policy chặn ghi lên cây đã clone. `node_modules` phải được git ignore,
  giống mountpoint trên Linux.
- Network, socket của host và signal tới process khác đều bị từ chối. Chỉ cho phép signal tới process con của
  chính nó (Vitest cần để dừng worker) và đọc `/etc/hosts` để phân giải `localhost`; không có `mach-lookup`
  nên không có kênh DNS.
- `sandbox-exec` được Apple đánh dấu deprecated nhưng vẫn hoạt động trên Darwin 25.6.
- Bằng chứng được ghi nhận trên nhánh main trước tích hợp (không đo lại trên máy Linux này): source cộng test đối kháng cục bộ (`behavioral-sandbox-darwin.test.ts`) và đo thật
  `node --test` (TypeScript) lẫn Vitest 2.1.9 trên macOS. Chưa có live acceptance toàn luồng SDLC và chưa
  có đảm bảo chống kernel thù địch.


Polyglot adapter commands requiring toolchain/cache mounts, generated helpers or private report directories currently return unsupported on macOS. Dependency warming is Linux-only. This integration has local Linux test evidence; macOS measurements were not repeated on this host.
