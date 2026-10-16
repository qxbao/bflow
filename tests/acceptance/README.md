# Acceptance probes

The acceptance record for the integrated P11–P21 checkout is in
[the QA report](../../docs/acceptance/2026-10-16-p11-p21.md).

Build before running probes because they import the compiled packages:

```sh
pnpm build
TMPDIR=/tmp node tests/acceptance/local-fault-probe.mjs
```

This probe uses real local Git repositories, the production command Quality Gate
and filesystem ArtifactStore. It executes a failing regression test, repairs the
disposable fixture, executes the passing test, stores both reports, preserves an
actual integration conflict, and rejects reads of deliberately missing evidence.
It verifies that the fixture's main branch stays unchanged and has no remote.
It does not attempt publication; missing-remote PR rejection is covered by the
Git Orchestrator package tests. This is a local component probe, with no model,
Herdr transport, Runtime workflow, human approval, or Reviewer verdict.

The command prints its evidence file and retains its private temporary directory,
including the intentionally conflicting worktree and artifact catalog/blobs.
An assertion failure produces exit 1 and a failed evidence record. Inspect these
files before removing that specific disposable directory; do not commit them.

The opt-in installed-Herdr tests run separately:

```sh
BFLOW_TEST_LIVE_HERDR=1 BFLOW_LIVE_HERDR=1 TMPDIR=/tmp \
  pnpm exec vitest run apps/cli/test/environment-live.test.ts \
  packages/runtime/test/agentic/live-herdr.test.ts \
  --maxWorkers=1 --minWorkers=1 --reporter=verbose
```

These create and stop only their own named sessions. The first tests server
isolation without starting model agents. The second uses a custom native actor
and signs a structured plugin message. Its console evidence explicitly records
submission uncertainty, native session presence and the absence of binding/task
success proof. Neither is a live AI SDLC test.

For real model testing, initialize a separate disposable Git checkout, configure
its role CLI/model authentication, use a short private Herdr configuration path,
and record both `bflow status --json` and actual pane output. `idle` can describe
a login screen. An authenticated model reply still does not prove that the P19
host, P14 Conversation Gateway or Coordinator tools have been registered.
The report contains the tested commands, session/pane identifiers, retained logs,
and the unimplemented composition steps that currently block full acceptance.
