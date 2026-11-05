# All Provider Director Event Wake Implementation Plan

**Goal:** Stop idle model turns for Codex, Claude Code and Agy while preserving one Director per repository and every Runtime gate.

**Baseline:** `agent/cli/codex-director-event-wake` at `3f3959cf` supplies the Codex watcher and MCP suspend path.

## Provider design

- **Codex:** retain the tested `codex queue --resume` path.
- **Claude Code:** extend the existing project MCP server with the documented `claude/channel` capability. On `director_suspend`, the provider-local server long-polls the host and sends one `notifications/claude/channel` wake to the same interactive session. Launch with the documented development-channel flag only where the installed Claude version supports it; if channel registration is denied, the Director keeps its normal wait loop and reports that it cannot sleep. Do not use private inbox wire frames or `--resume` on a running session.
- **Agy:** run one Bflow-supervised `agy --input-format stream-json --output-format stream-json` process per repository, started from the existing Agy launch flow. Feed initial Director instructions, then wait for host events outside the model and write one NDJSON `user` event to its stdin per wake. Show transcript and approvals through Bflow Web. Do not start a second Agy client for a live conversation or infer success from the process alone.

## Shared invariants

- The background waiter repeats the Director's original cursor; only a model turn acknowledges a returned cursor.
- The Runtime feed cursor must be initialized before suspension.
- No watcher sends the Director token in an argv, event body or log; provider-local MCP/driver receives it through a private channel.
- Duplicate, uncertain or failed wake delivery never causes automatic resend without reconciliation.
- Manual user input and session replacement cancel stale watchers. Human approvals remain with the user.
- A provider without a verified wake capability continues the current `director_wait` loop and reports the reason.

## Tasks

1. Claude channel adapter: capability, event notification and launch wiring; tests for empty waits, one wake, denial and no token leak.
2. Agy supervisor: one stream JSON process, queue and lifecycle; tests with a fake Agy binary for two turns, no idle model calls, crash/restart and duplicate launch.
3. Integrate provider selection into generated skill/guide/CLI and Web launch, update version and docs.
4. Verify dependency graph, typecheck, focused tests, affected tests and built CLI smoke. Record live evidence separately from source/local tests.
5. Review the combined diff, fix material findings, merge locally into `main`, then verify the merged result. Preserve the unrelated untracked plan in `main`.
