# W09 — Local Web acceptance, faults and release handoff

Status: **milestone M3 INCOMPLETE.** Local HTTP and browser-integration acceptance pass;
the live no-chat workflow was attempted and is **blocked** by a machine prerequisite plus
two production findings. Live resume/chat and full SDLC rows are **not_run**. No gate was
lowered to make anything pass. No push, PR or merge.

## Baseline, branch, ownership

- Baseline `0120ba7920ec25c8aec4865273cacc10cf08cb6c` (main = origin/main, clean). Contains
  W00–W08 by ancestry (W07 `4d3b18d`, W08 source `fa4153c`, W08 handoff `0120ba7`).
  7b158c4 was not used as a reset target. Other worktrees (W08 isolator worktree) untouched.
- Branch `agent/acceptance/w09`, worktree `../AI-flow-SDLC-w09`.
- Commits: `ad30d5c` tests; this handoff commit follows.
- Paths (all new, W09-owned): `tests/acceptance/local-web/**`,
  `apps/web/e2e/{workflow,security,recovery}.spec.ts`, helpers
  `apps/web/e2e/{acceptance-fixture.ts,acceptance-host.mjs}` (same stdin-fixture pattern as W07).
- No production source, contracts, public schema, root config, lockfile, README or `docs/**`
  change. Integrator doc updates are proposals below.

## Gate commands (Linux, Node 24.16.0, pnpm 12.5.1, /usr/bin/google-chrome)

| Command | Result |
| --- | --- |
| `pnpm install --offline --frozen-lockfile`, `pnpm run build` | exit 0 |
| `pnpm check:deps` | exit 0 (24 packages, 54 edges) |
| `pnpm typecheck`, `pnpm --filter @bflow/web typecheck` | exit 0 |
| `pnpm --filter @bflow/web test` | exit 0, 52 passed / 11 files |
| `pnpm test` (full, includes web unit) | **exit 1**: 384 files passed / 9 failed / 6 skipped; 6382 tests passed / 21 failed / 84 skipped, 850.7 s. Ran while W09 acceptance processes were also running (load). |
| Sequential rerun of the 9 failed files (`--maxWorkers=1`) | exit 1: 199 passed / 1 failed. Remaining failure: `host.test.ts` "blocks prepare without launch material…" — known machine-specific (real `codex` on PATH makes the provider ready; fails on pristine main too). Other 20 were load timeouts/escalations; all passed sequentially. Not a clean full-suite PASS. |
| `pnpm exec vitest run --config tests/acceptance/local-web/vitest.config.ts` | exit 0, 10 passed / 2 files |
| `BFLOW_WEB_TEST_BROWSER=/usr/bin/google-chrome pnpm --filter @bflow/web test:e2e` | exit 0, 9 passed / 1 skipped (live workflow, not_run without env) |
| `pnpm test:e2e` (root e01–e16) | not_run in W09 (no production change; integrator gate) |
| `git diff --check` | exit 0 |

GitNexus MCP was unavailable (connection refused); `test:affected` was not used. Only test
files changed, so the full suite above is the regression evidence.

## Evidence matrix by AC

Levels: U = unit/fake (predecessor tasks), H = local HTTP integration (real `bflow web` binary,
isolated `BFLOW_HOME`, real Git), B = browser integration (real Chrome + actual Local Server,
deterministic host client), L = live Herdr/provider, F = full SDLC.

| AC | U | H | B | L | F | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| AC01 | pass | pass | pass (W06) | **blocked** | not_run | Pairing, one-time bootstrap, reuse, port refusal, non-TTY redaction, Ctrl-C frees port/locator. Live: Ctrl-C during pending start closed the web after ~13–50 s; host never started (F04). SIGHUP leaves an unrecoverable locator (F02). |
| AC02 | pass | pass | pass (W06) | partial | — | Read-only registration, dedupe, no init/index. Readiness misleading: doctor/inspect "healthy" while start fails (F05); uninitialized repo gets generic 400 (F01). |
| AC03 | pass | pass (no host) | pass (W06/W07) | **blocked** | not_run | Honest not-ready session, runs 503 without host. |
| AC04 | pass | pass (no-host command not applied) | pass (W07) | **blocked** | not_run | Live form never reached a ready host. |
| AC05 | pass | — | pass | **blocked** | not_run | Two tabs approve vs reject: exactly one effect, opposite outcome never POSTed. UX gap F03. |
| AC06 | pass | — | pass (W07) | **blocked**/not_run | not_run | Live web start stayed `running` past the 300 s startup deadline; HTTP read `reconciliation_required`; no resend (correct), no actionable error (F04). Live resume not_run. |
| AC07 | pass (W08) | — | pass (W08) | not_run | not_run | W08 scoped adapter smokes only; no live host chat in W09. |
| AC08 | pass | pass | pass | — | — | Lost ACK after commit (route.fetch then abort), Local Server restart mid-cancel, browser close (no lifecycle/workflow effect), lifecycle operation ID across restart, SSE eviction → `reset` → snapshot reload with zero mutations. |
| AC09 | pass (W03/W05) | pass | pass | — | — | DNS-rebinding Host incl. real browser via `--host-resolver-rules` (403, no UI), `localhost`/other-port Host, null/foreign Origin, `same-site`/`cross-site` metadata, CSRF missing/forged, unknown fields, foreign project scope, encoded traversal, 413; hostile page on another loopback port gets no data/SSE/mutation; HTML/SVG artifacts are `attachment`+`octet-stream`+`sandbox` CSP, Markdown shown as text; no dialogs. Secret absent from URL/storage/`document.cookie`/bundle/receipts; cookie HttpOnly, SameSite=Strict, host-only, 12 h. |
| AC10 | pass (W06–W08) | — | partial | — | — | W06/W07 width checks 1440/1280/768 + focus outline re-run green. No new manual screen-reader pass in W09. Visual reference: `docs/DESIGN.md` at `607d101` (sha256 prefix `f74dbf874f28fb7a`); no visual change in W09, visual acceptance not re-certified. |
| AC11 | — | — | — | **blocked** | not_run | See live attempt. |
| AC12 | pass (W00/W04) | pass | — | — | — | `run/approve/resume/cancel --help` do not advertise web/host API; `web --json` refused. Root e09 not rerun. |

Step 6 extra: production build from a checkout path with spaces (temporary worktree, removed)
produced the identical bundle hash (`index-BZXqppGH.js`); `bflow web` started from cwd `/`,
served index/bundle 200, bootstrap secret not present in served assets, SIGINT stopped cleanly.

## Live attempt (no-chat workflow)

Disposable repo in session scratchpad (`sumdemo`, `bflow init --no-gitnexus`, all 8 roles
Codex, `workspace_auto`), real machine setup (`BFLOW_HOME` default), Herdr 0.9.5. `bflow doctor`:
healthy, Codex auth passed. Opt-in `workflow.spec.ts` paired, registered, clicked
"Khởi động phiên". The start operation stayed `running` for 13+ minutes; no Herdr server or
host process was created (host state files last written 12:08:48). Direct `bflow up` on the
same repo then failed in seconds with preflight `validation`:
`codex: Missing exact skill pin: review-code` (reviewer) and `test-planning` (qa).
`bflow setup --check` also fails: "An operator-defined mcp-gateway service already exists".
Fixing requires a machine-scope `bflow setup` apply, which this task is not authorized to do.
No create/clarify/approve/execute/delivery happened; no AgentResult, gate or diff exists.
Evidence (logs, copied lifecycle receipts) kept in the session scratchpad only; the web
state directory created by these runs under `~/.local/state/bflow/web` was removed after copying.

## Findings for production owners

- **W09-F04 (CLI/W04 lifecycle composition, High):** web `session_start` does not surface an
  up preflight failure that the CLI reports in seconds; the receipt stayed `running` beyond the
  300 s `startupTimeoutMs`, HTTP reports `reconciliation_required` without remediation, and
  Ctrl-C of the web owner waits ~13–50 s for the pending effect. Repro: initialized repo whose
  `bflow up` fails preflight → `POST /session/start` → poll operation. Expected: `failed` with the
  same remediation as CLI, bounded by the startup deadline; Ctrl-C closes the listener promptly.
- **W09-F05 (CLI doctor / P28 skills / machine-setup, High):** `bflow doctor` and web inspect report
  ready (skills 4/4) while startup preflight rejects missing exact skill pins. Readiness must
  check the same pins as `up`.
- **W09-F02 (CLI/W04, Medium):** SIGHUP (closing the terminal) or a crash leaves `instance.json`;
  the next `bflow web` refuses ("không takeover theo PID") and there is no supported recovery
  command. Reproduced with an isolated `BFLOW_HOME`. Consider handling SIGHUP and a verified
  stale-owner recovery (control port unreachable + owner lock free), without PID takeover.
- **W09-F03 (Web/W07, Medium UX):** two tabs in one browser context share the decision operation
  record; the tab whose "Từ chối" was never sent shows "Quyết định gói — Đã áp dụng thao tác"
  (the other tab's approval) with no outcome and no "your decision was not applied" message.
  Authority is correct (one effect). Show the applied outcome and explain the suppressed intent.
- **W09-F01 (CLI/W04, Low):** inspect on an uninitialized repo returns a generic 400
  `invalid_request`; the `bflow init` remediation is lost at the HTTP error mapping.

Test-harness lessons (not product bugs): Node's default keep-alive agent reuses sockets the
server closed (use `agent:false`); WHATWG `URL` normalizes `%2e%2e` before sending; signalling
the `script` process group kills the CLI mid-close — signal the CLI process inside the pty.

## Compatibility / recovery

No schema, receipt, journal or migration change. The deterministic acceptance host models
first-decision-wins and operation receipts; it does not prove Runtime semantics (Runtime tests
own those). Uncertain lifecycle receipts from the live attempt were never resent.

## Integrator proposals (not applied)

- Root script, e.g. `"test:acceptance:web": "pnpm run build && vitest run --config tests/acceptance/local-web/vitest.config.ts"`; keep out of default `pnpm test` (spawns processes, needs `script`).
- `docs/implementation-status.md` / `README.md` / `docs/guide/local-web.md`: record Local Web as source + local HTTP + browser integration; live workflow blocked; list F01–F05; do not claim live/full SDLC.
- Re-run W09 live after the owner approves `bflow setup` (skill pins, gateway service reconcile) and F04 is fixed:
  `BFLOW_W09_LIVE=1 BFLOW_W09_REPO=… BFLOW_W09_EVIDENCE=… pnpm --filter @bflow/web exec playwright test e2e/workflow.spec.ts`.
  Then add live resume (controlled recoverable block) and live chat-in-same-run rows.
