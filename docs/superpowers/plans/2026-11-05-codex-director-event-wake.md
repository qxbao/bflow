# Codex Director Event Wake Implementation Plan

> **For agentic workers:** Execute this plan inline with `executing-plans`. Track each task with tests before source changes.

**Goal:** End Codex Director model turns while idle and resume the same interactive thread only when Bflow has new work.

**Architecture:** `director suspend` starts one detached, provider-local watcher for the current Codex thread. The watcher repeats the existing long-poll using the *same* cursor, so it never acknowledges a newly observed durable message; on the first event it queues one wake message with `codex queue --resume`. The Director consumes the event with `director_wait` and suspends again after its work is done. A generation marker makes replaced watchers and manual user turns stop without queueing stale wakes. If queue delivery is uncertain, the watcher records `wake_failed` and never resends automatically.

**Tech Stack:** TypeScript, Node child processes and filesystem, existing Director host tool and `@bflow/contracts` schemas, Vitest.

**Spec:** User request in this conversation; Director boundaries in `docs/adr/0009-director-agent.md` and `agents/director/system-prompt.md`.

## Global Constraints

- Scope the automatic wake path to Codex; retain current `director_wait` behavior for Claude and Agy.
- Keep the Director in its interactive terminal and resume its exact `CODEX_THREAD_ID`.
- Keep the Director token out of argv, files, logs and queued prompts. No new public contract or Runtime state transition.
- Never advance the Director cursor on the watcher's behalf; only the model may acknowledge observed messages.
- Preserve human approval authority and all existing Runtime gates.
- Do not claim live Codex provider acceptance from local tests.

## Review Focus

- A durable message or mailbox item arriving between suspension and watcher startup must wake the thread.
- Repeated empty waits must not queue a model turn or advance the cursor.
- A manual terminal prompt or a newer suspension must invalidate an older watcher.
- A queued wake prompt must not enter the Bflow user transcript.
- Token rotation, host outage and uncertain `codex queue` delivery must not cause a busy retry loop, duplicate queue or credential leak.

---

### Task 1: Watcher core

**Files:** Create `apps/cli/src/director-wake.ts`; create `apps/cli/test/director-wake.test.ts`.

**Interfaces:** `suspendCodexDirector(input)` writes a generation marker and spawns `director watch`; `watchCodexDirector(input)` repeatedly calls the existing `director_wait` with the same cursor, then runs `codex queue --thread <id> --message <wake> --resume` once. `invalidateCodexDirectorWatch(root, sessionName)` invalidates the marker; `isCodexDirectorWakePrompt` recognizes only the current generation.

- [x] Write tests for empty waits, immediate event, duplicate/replaced watcher, token-safe queue argv/env, uncertain queue delivery and invalid state.
- [x] Run the tests and observe failures caused by missing behavior.
- [x] Implement private validated marker storage and one-shot watch loop.
- [x] Run the focused tests and typecheck.

### Task 2: CLI lifecycle and interactive Codex launch

**Files:** Modify `apps/cli/src/director-commands.ts`, `apps/cli/src/director-terminal.ts`; modify `apps/cli/test/director-commands.test.ts`, `apps/cli/test/director-open.test.ts`.

**Interfaces:** `bflow director suspend <cursor>` authenticates via `BFLOW_DIRECTOR_TOKEN`, takes `CODEX_THREAD_ID` from the current environment and starts a watcher. Internal `bflow director watch <generation>` runs the detached watcher. Codex launch uses the shared daemon so `codex queue --resume` can reach the interactive thread; the prompt hook invalidates a watcher for a real manual prompt and ignores the generated wake prompt.

- [x] Add failing CLI lifecycle, hook and launch tests.
- [x] Implement the two commands, hook handling and launch argument change.
- [x] Run focused tests and typecheck.

### Task 3: Director behavior and end-to-end fake-provider evidence

**Files:** Modify `apps/cli/src/director-skill.ts`, `agents/director/system-prompt.md`; modify `apps/cli/test/director-skill.test.ts`; add a fake `codex queue` integration test in `apps/cli/test/director-wake.test.ts`.

**Interfaces:** After the Codex Director has handled all pending items, it calls `bflow director suspend <latest cursor>` and ends its turn. A wake prompt calls `director_wait` with that cursor, handles the returned items, then suspends again. Claude/Agy continue their current loop.

- [x] Add failing prompt and fake-provider tests covering wake and cursor handoff.
- [x] Update generated skill and Director guide, bump skill version.
- [x] Run focused tests, dependency check, typecheck and affected suite; review the branch diff for token/cursor leaks.

## Acceptance

An idle Codex Director makes zero model calls during repeated watcher timeouts. A new Web message or specialist mailbox item queues one turn to the same Codex thread, whose `director_wait` still returns the durable item. Runtime projection events are wake hints; the Director inspects the named run if the feed event is no longer replayable. Manual terminal input cancels the stale watcher. Local tests prove these behaviors; live provider behavior remains a separate acceptance level.
