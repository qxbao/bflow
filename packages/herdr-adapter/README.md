# Herdr CLI transport

`createHerdrAdapter({ runner?, binary?, clock?, defaultTimeoutMs? })` implements the current `AgentTransport` port. `HerdrCliTransport.startAgent({ name, kind, paneId, ... })` is an additional startup operation; the pane must already exist. The adapter verifies Herdr CLI 0.9.1 / private protocol 22 / schema 1 during `initialize`. It uses argv-based `spawn` with `shell: false`; a fake `HerdrCommandRunner` can be injected for tests.

Targets must carry a pane ID. The adapter verifies pane, workspace, tab, terminal, agent name and any available `agent_session` before transport operations. A changed occupant is a conflict. Herdr cannot atomically compare an occupant and submit a prompt, so a replacement between preflight and submission can still receive input; a post-submission mismatch is reported as unknown delivery rather than bound to the old execution.

`send` uses `agent prompt` without `--wait`. Success acknowledges terminal writes only. The resulting correlation has `provenance: "orchestrator"` and `verified: false`; it cannot prove a task outcome. Timeout, `agent_prompt_stalled`, lost connection and malformed acknowledgement are `unknown_delivery` with resend forbidden. `reconcile` returns a locally cached acknowledged binding, `not_delivered` for a proven pre-send rejection, or `unknown_delivery`; Herdr 0.9.1 exposes no prompt-specific receipt that can prove non-delivery after an ambiguous submission. Runtime must durably record dispatch intent and receipts and must not blindly resend after restart.

Herdr CLI accepts prompt text as a process argument, so it can be visible to other privileged local processes while the CLI runs. Do not place secrets in `instruction`; the adapter never logs it.

`wait` reports lifecycle state, never business success. `read` returns one bounded terminal snapshot, not a resumable stream or verified result. `cancel` sends `ctrl+c` only to a checked target and returns an accepted *request*, never confirmation that the agent stopped. Cancellation and submission deduplication caches are instance-local; the Runtime owns durable cross-restart command state.

Run tests with `pnpm exec vitest run packages/herdr-adapter/test/herdr-adapter.test.ts` from the repository root. Live agent/session control is intentionally not part of these unit tests.
