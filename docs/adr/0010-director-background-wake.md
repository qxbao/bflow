# ADR 0010 — Background wake for Director providers

**Status:** Integration decision for the 2026-11-05 owner request to apply idle token saving to every Director provider and merge locally into `main`.

## Motivation

Codex can queue a turn into its existing interactive thread. The installed Claude Code 2.1.318 lacks the documented research-preview channel flags, and Agy 1.5.0 has no supported command to inject a prompt into an already open terminal. Starting a second CLI with `--resume` or `--conversation` while the first remains live risks two Directors driving one run. Both CLIs support a persistent stream JSON process fed through stdin, so Bflow can own that process and send a prompt only when a new Bflow event arrives.

## Decision and boundaries

- Keep Codex's interactive terminal and tested queue path.
- Launch one supervised Claude or Agy stream JSON Director per repository. The user talks through Bflow Web; Bflow owns stdin and sends one wake per event. Their process is never a Herdr role or a replacement for Runtime gates.
- Preserve the same Director token, cursor, mailbox, human approvals and recovery rules. The supervisor must not acknowledge a cursor on the model's behalf or infer task success from a CLI `result` event.
- Add `background_started` to the `director_launch` Web operation result `mode` enum. Existing `terminal_opened` and `manual_command` payloads remain valid. Clients that know only those two values must update their exhaustive switches; the Web client in this integration does so. No stored operation migration is needed: old values parse unchanged.
- A source build and fake-provider tests establish implementation behavior, not live Claude/Agy acceptance. If authentication, stream format or provider readiness cannot be verified, report unavailable instead of claiming an active Director.

**Affected owners:** contracts (`packages/contracts/src/web.ts`), CLI launch and supervisor (`apps/cli/**`), Web launch UI (`apps/web/**`), Director guide (`agents/director/**`). The integration owner owns the shared contract/documentation edits. The approving owner request is “Áp dụng cho toàn bộ … Làm nhanh, xong merge vào main” on 2026-11-05, with the follow-up choice “Chạy nền, chat qua Bflow Web” for Agy.
