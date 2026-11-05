# Codex Director Event Wake Implementation Plan

> **For agentic workers:** Execute this plan inline with `executing-plans`. Track each task with tests before source changes.

**Goal:** End Codex Director model turns while idle and resume the same interactive thread only when Bflow has new work.

**Architecture:** The provider-local `director_suspend` MCP tool starts one detached watcher for the current Codex thread without putting the Director token in a shell command. The watcher repeats the existing long-poll using the *same* initialized cursor, so it never acknowledges a newly observed durable message; on the first event it queues one wake message with `codex queue --resume`. The Director consumes the event with `director_wait` and suspends again after its work is done. A per-session lock serializes marker transitions and queue admission against manual user prompts. If queue delivery is uncertain, the watcher records `wake_failed` and never resends automatically.

**Tech Stack:** TypeScript, Node child processes and filesystem, existing Director host tool and `@bflow/contracts` schemas, Vitest.

**Spec:** User request in this conversation; Director boundaries in `docs/adr/0009-director-agent.md` and `agents/director/system-prompt.md`.

## Global Constraints

- Scope the automatic wake path to Codex; retain current `director_wait` behavior for Claude and Agy.
- Keep the Director in its interactive terminal and resume its exact `CODEX_THREAD_ID`.
- Keep the Director token out of the new suspend shell path, watcher argv/files/logs and queued prompts. The existing general shell fallback retains its documented token limitation. No new public contract or Runtime state transition.
- Never advance the Director cursor on the watcher's behalf; only the model may acknowledge observed messages.
- Preserve human approval authority and all existing Runtime gates.
- Do not claim live Codex provider acceptance from local tests.

## Review Focus

- A durable message or mailbox item arriving between suspension and watcher startup must wake the thread.
- Repeated empty waits must not queue a model turn or advance the cursor.
- A manual terminal prompt or a newer suspension must invalidate an older watcher; marker writes and queue admission must serialize across processes.
- A Runtime-only event arriving before watcher startup must remain visible from the initialized Runtime feed cursor.
- A queued wake prompt must not enter the Bflow user transcript.
- Token rotation, host outage and uncertain `codex queue` delivery must not cause a busy retry loop, duplicate queue or credential leak.

---

### Task 1: Watcher core

**Files:** Create `apps/cli/src/director-wake.ts`; create `apps/cli/test/director-wake.test.ts`.

**Interfaces:** `armCodexDirectorWatch(input)` writes a generation marker and spawns `director watch`; `runCodexDirectorWatch(input)` repeatedly calls the existing `director_wait` with the same cursor, then runs `codex queue --thread <id> --message <wake> --resume` once. `cancelCodexDirectorWatch(root, sessionName)` invalidates the marker; `withCodexDirectorWatchLock` serializes transitions.

- [x] Write tests for empty waits, immediate event, duplicate/replaced watcher, token-safe queue argv/env, uncertain queue delivery and invalid state.
- [x] Run the tests and observe failures caused by missing behavior.
- [x] Implement private validated marker storage and one-shot watch loop.
- [x] Run the focused tests and typecheck.

### Task 2: CLI lifecycle and interactive Codex launch

**Files:** Modify `apps/cli/src/director-commands.ts`, `apps/cli/src/director-terminal.ts`, `packages/runtime/src/director/mcp.ts`; modify `apps/cli/test/director-commands.test.ts`, `apps/cli/test/director-open.test.ts`, `packages/runtime/test/director/mcp.test.ts`.

**Interfaces:** `director start --json` returns `threadId` from the current Codex environment. The provider-local `director_suspend` MCP tool accepts `{token, cursor, threadId}`, authenticates and starts a watcher. Internal `bflow director watch <generation>` runs it. Codex launch uses the shared daemon so `codex queue --resume` can reach the interactive thread; the prompt hook invalidates a watcher for a real manual prompt and ignores generated wakes.

- [x] Add failing CLI lifecycle, hook and launch tests.
- [x] Implement the two commands, hook handling and launch argument change.
- [x] Run focused tests and typecheck.

### Task 3: Director behavior and end-to-end fake-provider evidence

**Files:** Modify `apps/cli/src/director-skill.ts`, `agents/director/system-prompt.md`; modify `apps/cli/test/director-skill.test.ts`; add a fake `codex queue` integration test in `apps/cli/test/director-wake.test.ts`.

**Interfaces:** After the Codex Director has handled all pending items and initialized the Runtime cursor with `director_wait`, it calls the `director_suspend` MCP tool and ends its turn. A wake prompt calls `director_wait` with that cursor, handles returned items, then suspends again. Claude/Agy continue their current loop.

- [x] Add failing prompt and fake-provider tests covering wake and cursor handoff.
- [x] Update generated skill and Director guide, bump skill version.
- [x] Run focused tests, dependency check, typecheck and affected suite; review the branch diff for token/cursor leaks.

## Acceptance

An idle Codex Director makes zero model calls during repeated watcher timeouts. A new Web message or specialist mailbox item queues one turn to the same Codex thread, whose `director_wait` still returns the durable item. Runtime projection events are wake hints; the Director inspects active runs if the feed event is no longer replayable. Manual terminal input cancels the stale watcher. Local tests prove these behaviors; live provider behavior remains a separate acceptance level.

## Review fixes

- The new suspend path is an MCP call; its token is sent as a tool argument and never interpolated into a shell command.
- Marker writes and queue admission run under a short per-session filesystem lock. A queue call is started after admission while the lock is held; uncertain delivery is recorded without resending.
- Suspend requires a nonempty Runtime feed cursor from a prior `director_wait`. Runtime-only wake hints direct the Director to inspect active runs because projection summaries do not carry `runId`.
