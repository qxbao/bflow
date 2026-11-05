# All Provider Director Event Wake Implementation Plan

**Goal:** Stop idle model turns for Codex, Claude Code and Agy while preserving one Director per repository and every Runtime gate.

**Baseline:** `agent/cli/codex-director-event-wake` at `3f3959cf` supplies the Codex watcher and MCP suspend path.

## Provider design

- **Codex:** retain the tested `codex queue --resume` path.
- **Claude Code:** on the installed 2.1.318 CLI, channel flags are absent. Run one Bflow-supervised `claude -p --input-format stream-json --output-format stream-json` process, with one input message per event, using the documented persistent streaming mode. Avoid `--resume` on a running session and private inbox wire frames. Show user interaction through Bflow Web.
- **Agy:** run one Bflow-supervised `agy --input-format stream-json --output-format stream-json` process per repository, started from the existing Agy launch flow. Feed initial Director instructions, then wait for host events outside the model and write one NDJSON `user` event to its stdin per wake. Show transcript and approvals through Bflow Web. Do not start a second Agy client for a live conversation or infer success from the process alone.

## Shared invariants

- The background waiter repeats the Director's original cursor; only a model turn acknowledges a returned cursor.
- The Runtime feed cursor must be initialized before suspension.
- No watcher sends the Director token in an argv, event body or log; provider-local MCP/driver receives it through a private channel.
- Duplicate, uncertain or failed wake delivery never causes automatic resend without reconciliation.
- Manual user input and session replacement cancel stale watchers. Human approvals remain with the user.
- A provider without a verified wake capability continues the current `director_wait` loop and reports the reason.

## Tasks

1. Provider-neutral stream JSON supervisor: one process, queue and lifecycle; tests with fake binaries for two turns, no idle model calls, crash/restart and duplicate launch.
2. Claude/Agy adapters: exact args and message/event codecs per installed CLI; tests for both providers and no token leak.
3. Integrate provider selection into generated skill/guide/CLI and Web launch, update version and docs. Add the compatible `background_started` Web launch mode with a documented contract decision, while preserving old modes.
4. Verify dependency graph, typecheck, focused tests, affected tests and built CLI smoke. Record live evidence separately from source/local tests.
5. Review the combined diff, fix material findings, merge locally into `main`, then verify the merged result. Preserve the unrelated untracked plan in `main`.
