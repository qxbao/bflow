# Owner-configured verification runners

Default Claude host supports manual documentation review and configured behavioral
checks. Configure `.bflow/verification.json` before the first `bflow up`. This is
operator authority: Coordinator can select accepted command labels and mapped test
names, but cannot supply executables, argv, output or a successful verdict.
The persisted host pins the configuration digest. Changing the file after host
creation is rejected; preserve state and reconcile/migrate the host explicitly.
Do not delete host journals to bypass a configuration mismatch.

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

No dependency install, build preparation, workspace symlink restoration or network
fetch happens automatically. Dependencies needed by a test must be present in the
explicit toolchain or committed checkout. Workspace links to unmounted packages,
TS projects needing generated `dist`, aggregate coverage, mixed manual/automated
criteria and other reporter versions are not yet supported by this default path.
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
