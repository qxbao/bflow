# Verification runners

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

## Runner matrix

All rows below have source and local fixture/parser coverage. No row has successful
real measurement evidence on the implementation host: its real empty Bubblewrap probe
fails with `loopback: Failed RTM_NEWADDR: Operation not permitted`. Tests explicitly
skip measurements after that probe; this is not a passing sandbox campaign. Parser
fixtures for unavailable tools reproduce documented output shapes, not recorded runs.
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
| PHP | PHPUnit JUnit | namespace-qualified class + `.` + method | existing global/local PHPUnit; exact class::method filter |
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

## Optional owner override: `.bflow/verification.json`

Owners may still declare their own behavioral commands in `.bflow/verification.json`
(for example for a runner or reporter that detection does not support, or to pin exact
argv). When that file exists its commands are used exactly as before, and automatic
detection is disabled for that host. This is operator authority: Coordinator can select
accepted command labels and mapped test names, but cannot supply executables, argv,
output or a successful verdict. The persisted host pins the configuration digest.
Changing the file after host creation is rejected; preserve state and reconcile/migrate
the host explicitly. Do not delete host journals to bypass a configuration mismatch.

## Node TAP example

Replace `/absolute/path/to/node` with the installed Node executable. Keep exact
committed test paths and exact observed names; Node's supported protocol is flat
`node:test` TAP, with assertion failures for Red.

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

The accepted strategy must use `owner:test-unit` and map the criterion to the exact
test name. The accepted task ownership must include the test and implementation
paths. Add this configuration only as the project owner; Developer cannot edit
`.bflow` through its tools or commit it as part of a task.

## Vitest 2.1 example

Use the same envelope and command fields, with:

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

This is a fragment to merge into the complete command, not a separate config
schema. Use the actual Vitest JSON `fullName` for every `testNames` entry (including
suite names). Runtime appends its trusted companion reporter because Vitest 2.1's
JSON omits unhandled runtime errors. Missing completion, runtime errors, skipped,
todo, zero tests, malformed counters, unexpected names, timeout and truncated
output all block evidence. Node TAP remains the default when `reporter` is omitted.

## Sandbox and dependency ownership

Linux (including WSL2 only when the real namespace probe passes) uses Bubblewrap found
on PATH, canonicalized and tested in a real empty namespace. `bflow up` probes readiness;
activation records a structured `verification_sandbox_unavailable` Conversation notice
when automated runners exist. Planning exposes that state. Measurement always fails closed
if the boundary is unavailable; no command runs outside it. macOS `sandbox-exec`, native
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
