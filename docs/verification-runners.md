# Verification runners

## Automatic detection (default, no configuration)

Acceptance criteria with `verificationMethod` `unit_test` or `integration_test` are
measured with no user configuration. When `.bflow/verification.json` is absent,
Runtime inspects the repository itself (`packages/runtime/src/agentic/runner-detection.ts`)
and exposes two labels to the Coordinator through `planning_reference.testRunners`:

| Label | Method | Levels |
| --- | --- | --- |
| `auto:unit` | `unit_test` | `unit`, `regression` |
| `auto:integration` | `integration_test` | `integration`, `regression` |

Detection runs no package scripts, no shell and no install. It accepts:

- **vitest 2.x** declared in `package.json` and installed at the repository root
  (`node_modules/vitest/vitest.mjs`, a real directory, not a symlink). Measured with
  the JSON reporter plus Runtime's companion reporter.
- **`node --test`** when the `test` script contains `node --test`. Measured as flat
  TAP. No dependencies are needed.
- An optional **`tsc` build** (`tsc`, `tsc -b` or `tsc --build`, optionally with
  safe relative project paths) from the `build` script, run as a sandboxed prepare step
  before the tests. It may only create git-ignored output. Other build scripts are
  skipped and reported in the detection notes.
- Nested `node_modules` directories found by a walk that does not follow symlinks.
  Each one is mounted read-only at the same relative path inside the measurement
  checkout.

Limits: only vitest 2.x and `node --test` are supported. Other versions (for example
vitest 3) report `unsupported` with the version found. A missing `node_modules` or a
symlinked root `node_modules` is also unsupported. Measurements require Linux and
`bwrap` (see below), and there is no network access and no dependency installation.
If detection is `unsupported`, Runtime retries it on the next `propose_workflow` (and
when the Coordinator reads `planning_reference`), so installing dependencies or adding
the runner does not require a host restart. The Coordinator is then told
(`no_test_runner_detected`) to add a setup task; the user is shown that notice.

Per task, Runtime binds the detected profile to identities taken from the accepted
specification: test names from the `criterionMappings` of the active automated criteria
with that method, and test files from `affectedPaths` that are test files and, for a
Developer, owned by the task. Test files must be committed in the checkout at the
measured revision. vitest reports `fullName` (describe titles plus the test title joined
by one space). node --test reports the test title only.

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

## Execution and safety scope

Behavioral verification currently requires Linux, `/usr/bin/bwrap`, and permission
to create user/mount/PID/network namespaces. There is no unsandboxed fallback.
Each measurement uses a new detached Git checkout at the exact committed revision,
a clean environment and an empty filesystem namespace. System `/usr`, the Node
executable, `/etc/hosts`, the checkout and explicitly configured read-only
`node_modules` roots are mounted. Host homes, state, sockets and network are absent.
Dependency roots must be canonical directories named `node_modules`; symlinks that
point outside mounted trees remain unavailable. This is a local Linux boundary,
not a multi-tenant or hostile-kernel guarantee.

No dependency install, workspace symlink restoration or network fetch happens
automatically. Dependencies needed by a test must already be installed in the
repository's `node_modules` (or be part of the committed checkout). The only build step
is the detected `tsc` prepare step described above. Workspace links to unmounted
packages, `dist` output produced by other build scripts, aggregate coverage, mixed
manual/automated criteria and other reporter versions are not supported by the default
path; use the owner override for those.
The repository's normal `pnpm test` suite is run separately; it is not claimed to
run wholesale in this small configured fixture runner.

Commands have individual timeouts at most 300 seconds; the total configured budget
(including checkout overhead) must fit the host deadline. Output is bounded at
4 MiB per command. Execution that changes or generates checkout files is rejected;
use `--no-cache` and avoid snapshot updates or coverage output. Only disposable
measurement checkouts are forcibly removed; Developer worktrees are preserved.

## Conditional TDD

For required TDD, Developer can initially edit/commit only configured test files.
It requests independent Red and yields. QA executes the runner; Runtime records a
trusted receipt and resumes the same Developer using the existing task lease.
After Red, those exact test blobs are frozen. Green and Refactor measure committed
implementation revisions with the same tests. `check_work` supplies Developer
feedback and never supplies independent acceptance evidence.

Real assertion failures produce preserved diagnostics and bounded repair notices;
repeating a failed revision does not enqueue another job. Infrastructure failures
escalate. Exhausting the phase or verification limit also escalates. Native delivery
uncertainty is reconciled separately and never interpreted as a test failure to
justify resending work. Required human/design/delivery approval remains in force.
