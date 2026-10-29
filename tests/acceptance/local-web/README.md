# Local Web acceptance (W09)

Acceptance and fault probes for `bflow web`. They do not replace package tests and they
never turn fixture behavior into live evidence. Keep the four evidence levels separate:

| Level | Where | What it proves |
| --- | --- | --- |
| Unit/fake | package tests (`apps/local-server/test`, `apps/web/test`, `packages/runtime/test/interaction`) | Module rules with fixtures |
| Local integration (HTTP) | this directory | The built CLI composition + Local Server over real loopback TCP, isolated `BFLOW_HOME`, real Git repository, no Runtime host |
| Browser integration | `apps/web/e2e/{security,recovery}.spec.ts` (+ W06–W08 specs) | Real Chrome against the actual Local Server; a deterministic `UserInteractionClient` replaces the host |
| Live transport / full SDLC | `apps/web/e2e/workflow.spec.ts` (opt-in) | Real `bflow web`, agentic host, Herdr and providers on a disposable repository |

## Commands

Build first: the tests spawn `apps/cli/dist/bin.js` and serve `apps/web/dist/client`.

```sh
pnpm run build
pnpm exec vitest run --config tests/acceptance/local-web/vitest.config.ts
BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web exec playwright test e2e/security.spec.ts e2e/recovery.spec.ts
```

`script(1)` is required: `bflow web` prints its pairing URL only to an interactive terminal.
Each test uses a private temporary `BFLOW_HOME` and repository and removes them afterwards.
Ctrl-C is emulated by signalling the CLI process inside the pty, not the `script` wrapper.

The live workflow is skipped (`not_run`) unless the operator prepares a disposable,
initialized repository with authenticated providers:

```sh
BFLOW_W09_LIVE=1 BFLOW_W09_REPO=/abs/disposable/repo BFLOW_W09_EVIDENCE=/abs/evidence/dir \
BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome \
  pnpm --filter @bflow/web exec playwright test e2e/workflow.spec.ts
```

It registers the repository, starts the session through the web lifecycle, creates the
request with the form, answers clarifications and approves pending decisions with buttons,
and requires the Runtime run view to reach `sdlcStatus: completed` and `coreStatus: completed`.
HTTP 202/`applied` operations are recorded but never count as task success. The evidence
log is written outside the repository; inspect it before removing the disposable directory.
Do not commit evidence, screenshots, state or logs.

## Coverage map

- AC01: pairing, one-time bootstrap, owner reuse, port refusal, non-TTY redaction, Ctrl-C closes only the web owner.
- AC02/AC03: read-only registration, de-duplication, no init/install/index, honest not-ready host.
- AC08: lifecycle operation observed by ID across a Local Server restart; browser lost ACK, restart mid-operation, two-tab conflict, SSE eviction reset.
- AC09: DNS rebinding Host, cross-site/null Origin, CSRF, traversal, unknown fields, oversized bodies, hostile loopback page, inert artifacts.
- AC12: traditional `run/approve/resume/cancel` help does not advertise the web/host API.
