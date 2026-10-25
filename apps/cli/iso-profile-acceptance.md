# Configured iso profiles and setup parity

> **Phạm vi hồ sơ:** báo cáo/kế hoạch tại baseline và môi trường được ghi bên dưới; giữ nguyên kết quả và lệnh gốc. Không dùng các kết luận triển khai cũ làm trạng thái của HEAD. Xem [trạng thái source và bằng chứng hiện tại](../../docs/implementation-status.md) trước khi vận hành hoặc giao việc mới.

## Live startup follow-up — 2026-10-20

The earlier synthetic-only evidence below describes the initial milestone. This
follow-up fixes the real selected-profile startup path and adds live startup evidence:

- Selected Codex directories and instruction-only plugins accept inherited modes
  beneath the validated private profile root. Exact native shared hook sources
  can reuse an existing native operator policy; no profile-wide policy is created.
  Other profile hooks, changed plugin copies, retargeted links and revoked source
  policies remain independently gated.
- Codex reasoning effort overrides now precede `exec`. A local HTTP fixture
  with the installed CLI proved that placing `-c` after `exec` lost the backend
  override and used the fallback endpoint; moving it before `exec` retained LB.
- Corrected two local YAML model spellings from `gpt-6.1.sol` to `gpt-6.1-sol`.
  This repository-local ignored config stays local; no auth data was copied.
- Focused provider suite: **258 passed, 0 failed**. Build, typecheck, dependency
  boundaries and whitespace checks passed. No full-repository rerun was performed.
- Actual `bflow down --force` preserved durable recovery data, then `bflow up`
  exited **0** with `Environment ready` / `up`. A separate status check returned
  `server: running`, seven configured roles, and **no issues**. Conversation,
  Coordinator and Architect run Codex with `personal`; Planner, Specifier,
  Reviewer and QA run Claude. The environment was left running.

This establishes live startup, authenticated readiness and activation for this
local configuration. It does not establish completion of an SDLC workflow or
acceptance across every OS/provider combination. The initial evidence below
retains its original test counts and limitations for that earlier snapshot.


This follow-up adds optional `environment.roles[].profile-name` and provider
defaults under `environment.defaults.<provider>.profile-name`. A role overrides
its provider default. An omitted Developer inherits the resolved Coordinator
provider/profile; an explicit Developer resolves independently. Provider fallback
uses the destination provider's default. No profile selection preserves existing
behavior.

Runtime resolves existing profiles from trusted machine context, validates
metadata, ownership, directories and containment, and binds profile identity to
preflight, launch, dynamic Developers and restart checks. Missing or unsafe
profiles block without using the native account. Probes and launches use the
selected HOME/XDG/provider environment. Linked Codex backend profiles retain
their flags and still require authenticated execution readiness. Role prompts,
approved skills, Gateway grants, hooks and permission gates remain enforced.

Setup has a separately planned `isolator-profiles` step after native assets and
before the environment manifest. Its shared Python helper also runs during
profile initialization, including profiles created after setup. It synchronizes
native MCP definitions, instruction skills and the Bflow managed plugin assets
for Codex, Claude and Agy. Private per-entry ownership receipts protect local
edits; unrelated account/model/permission/local-tool state is retained. Check
and dry-run inspect without writing. Synchronization conflicts are visible
failures rather than silent partial readiness.

All commands share `AI_ISOLATOR_HOME`, otherwise the real user's
`.local/share/ai-isolator`. `BFLOW_HOME` changes native source homes only. Set
`AI_ISOLATOR_HOME=$BFLOW_HOME/ai-isolator` explicitly when profile targets should
also be inside a setup sandbox.

Claude's native empty `CLAUDE_CONFIG_DIR` selects an empty path, losing private
settings/auth. Runtime therefore selects the profile's `.claude` directory
explicitly for both probes and final launch. Setup synchronizes managed MCP
into both the default `HOME/.claude.json` and explicit-directory
`HOME/.claude/.claude.json`, preserving local state separately. Account state is
neither migrated nor copied. OAuth/settings/skills/plugins remain inside the
same profile directory.

Luna workers implement and fix provider, Runtime, CLI and synchronization
changes in isolated worktrees. The parent reviews source, returns concrete
findings, and accepts the combined result using fresh checks. Public contracts,
root build configuration, lockfile and shared architecture documents are
unchanged. No schema migrations are introduced.

## Verification

Source under the root check: integration `b5f33ea` (feature commits plus current main
`ea407aa`). The final Runtime candidate was checked byte/patch-equivalent to
Luna commit `e406d54`; committing it during the check changed no source bytes.

- Native sync Luna `4e1dfee`: 41 focused isolation/compatibility tests passed.
- Runtime Luna `e406d54`: platform suite 115 passed; typecheck passed. Its broader
  Runtime run had 847 passed, 2 skipped and one timeout while checks overlapped;
  the exact case passed separately. This is recorded separately from the final
  combined root check.
- Parent setup integration uses the actual Python helper after an earlier
  approved fixture step creates MCP/skills/plugin source assets. It verifies
  stable targets, convergence, private receipt containment, read-only modes and
  unchanged profile account/preferences. Passed.
- Parent final focused setup/sync/engine/compatibility run: 38 passed, 0 failed.
- Parent native Codex/Claude/Agy probes all exit 0 using local-only temporary
  plugin fixtures: actual inventories see the managed plugin; Claude sees MCP
  under the explicit Runtime config directory; Agy disable state propagates;
  Codex hooks binding survives. Synthetic account/model fixtures are unchanged.
- Parent review caught nested-session source selectors. Regression first failed
  (1 failed, 17 passed), then passed (18/18) after filtering only generated
  profile selectors. Custom native overrides and BFLOW_HOME are preserved.
- Final help smoke uncovered literal backticks executing shell substitutions in
  the usage heredoc. Luna `8ee8efb` (integrated as `5998eae`) escaped those
  examples; its sentinel regression failed before and passed after the fix.
  Parent repeated built CLI help: exit 0 and empty stderr. This later help-only
  change is verified separately from the root run.
- Main checkout `pnpm build`, `pnpm check:deps`, Bash syntax, Python AST parse
  and `git diff --check` pass.

The check runs with two Vitest workers under temporary HOME/XDG and TMPDIR=/tmp;
known inherited isolator selectors are cleared. Real accounts and configured
shell launchers are untouched. The package-local native fixture probes use only
synthetic credentials and local commands; no model request is issued.

Final combined `pnpm check`: **exit 0**, comprising `pnpm check:deps`,
`pnpm typecheck` and `pnpm test` (build plus full Vitest run). **203 files
passed, 4 skipped; 3,714 tests passed, 12 skipped, 0 failed**. Duration 575.19s.
The Linux run used Node 24.16.0, pinned pnpm 12.5.1 and two Vitest forks.
Log retained locally at `/tmp/bflow-iso-profile-final-check.log`.

The later help-only sentinel verification also exits 0: 1 passed, 12 deliberately
filtered. Its built-main smoke exits 0 with empty stderr. Final main typecheck,
dependency check, build, all-file whitespace review and status review pass.
No generated output is included.

The implementation is applied as uncommitted feature changes in the main
checkout at `ea407aa`; the final production bytes match integration `5998eae`.
No main history reset, push, PR or remote merge was performed. Existing main
changes were merged into the isolated integration checkout before final checks.
Only CLI, provider, Runtime and narrow machine-setup planner files change;
generated dist, local state and worker logs are excluded.

## Evidence limits

Tests use temporary homes, synthetic credentials, local plugin fixtures and
fake runners. Actual native CLI inventory/configuration probes establish local
plugin/MCP discovery, not authenticated model execution. No real profile,
account credential, shell RC, remote push or PR is changed. No live Herdr role
workflow or full SDLC acceptance is claimed. HOME/XDG separation is not an OS
sandbox. Original ai-isolator 0.4.4 shares Codex/Claude profiles; Agy is additive
in Bflow and has no verified native authentication-status command.
