# Bflow iso implementation and acceptance plan

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

**Goal:** Bring ai-sdlc's ai-isolator 0.4.4 into `bflow iso`, reuse Codex/Claude profiles in both directions, and add Agy profiles.

**Architecture:** Bundle the Bash engine and a standalone Python MCP helper inside this CLI package. Dispatch before the workflow parser, passing provider arguments literally. Existing state stays at `${AI_ISOLATOR_HOME:-$HOME/.local/share/ai-isolator}`; no profile migration or external checkout is needed.

## Acceptance criteria

- Codex/Claude profile directories, auth, metadata, LB decisions, skills and managed shell markers remain usable by both commands.
- `iso codex|claude|agy`, `run`, `login`, `status`, `sync-skills`, `remove`, help and version are available as applicable. LB and skills operations remain Codex-specific.
- Agy profiles use `agy--NAME` and isolated HOME/XDG. Native Agy onboarding handles login; status explicitly reports that authentication is unverified because the inspected Agy CLI has no auth-status command. Original ai-isolator 0.4.4 does not launch Agy.
- Caller directory, literal provider arguments, terminal access and provider exit status survive dispatch. Interrupts stop ordinary child processes without signaling the user's shell.
- Inherited provider credentials/config overrides are removed. This is HOME/XDG isolation and retains the user's filesystem permissions.
- Tests use temporary profiles, fake providers and fake LB probes. Real-provider authentication or full SDLC success is outside this acceptance.
- Changes stay inside `apps/cli/**`; contracts, root configuration and lockfile stay unchanged.

## Delegation and review

All implementation workers use Luna, in separate worktrees from baseline `a4e62b82d36ebe4e7fdc28c2b9923c67bfe22e6c`.

1. Bundle engine and dependency helper; verify standalone behavior and MCP preservation.
2. Integrate dispatch, help and package documentation; verify arguments, errors and terminal behavior.
3. Pin the unmodified original executable as a test reference; verify profile reuse in both directions, generated LB metadata and shell launcher execution.
4. Add Agy support using inspected native CLI behavior; verify isolated environment and explicit status limitations.
5. Parent reviews combined changes, returns concrete findings to Luna, then reruns acceptance.

Review findings to close include controlling-terminal loss, signal forwarding, Python interpreter selection, successful unlinked-profile removal returning a failure status, and inherited provider config overrides.

## Verification

Build before subprocess tests. Run `pnpm check:deps`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @bflow/cli test`, and the focused `iso-*.test.ts` files, then inspect `git diff --check` and `git status --short`.

The development session itself runs inside an ai-isolator profile. Use a temporary HOME/XDG environment for clean test verification; inherited state paths otherwise make unrelated existing hook/Gateway tests fail. Record exact commands, outcomes, tested HEAD and remaining limits in the session's acceptance report. Do not change real profiles or shell RC files to make tests pass.
