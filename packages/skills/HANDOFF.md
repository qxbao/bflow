# P28 Skills Framework handoff — 2026-10-17

Implementation source: **03701f0d37bcc34360306feb363b7e0af9905841** on
`agent/skills/p28-framework`, worktree `/tmp/bflow-p28-skills`.
Baseline: `a39374d0f06144a25e01691feeb696a1defed211`, verified descendant of approved
P24 `8dbb056`. `main`/`origin/main` matched at inspection; P24 had no unmatched patches
in `git cherry main agent/architecture/p24-runtime-v3`. No remote publication or merge.

## Delivered and reviewed

32 complete canonical skills, 32 local worked examples, 49 selections for all 10 contract
roles. Every requested shared skill and binding is present. Standard name/description
frontmatter and adjacent strict metadata remain provider/model neutral. One resolved
manifest exposes only selected names/descriptions/pinned paths; instructions load on demand.

SkillManager implements list, validate, install, sync, link, verify, update, and immutable
manifest recovery. Includes exact dependency pins, stable ordering, full content inventory
digests, role/provider/tool/capability checks, authenticated approval callback, private
atomic storage, exclusive writer lock, read-only setup planning and configuration-preserving
repository desired data. See README for runnable package API example and limitations.

Independent review found and regression tests now cover: caller-owned mutable install
bytes; missing/remote angle-bracket resource references; option-first/unknown nested
commands; optional dependency pin conflicts; and catalog writes during dry-run. Content
verification is explicitly separate from live provider/tool health, which P25/P30 must
probe independently. No skill grants permissions or bypasses Bflow policy/human authority.

## Validation evidence

Linux, Node `v24.16.0`, pnpm `12.5.1`; isolated worktree dependencies installed from
existing workspace lock/cache. `TMPDIR=/tmp` avoids the existing Unix-socket fixture's
path-length problem. Final package source tree corresponds to implementation commit above.

| Command from worktree root | Exit | Actual result |
| --- | --- | --- |
| `pnpm --filter @bflow/skills typecheck` | 0 | package project and contracts compile |
| `TMPDIR=/tmp pnpm --filter @bflow/skills test` | 0 | 6 files, 35 passed, 0 failed/skipped; final run 12.53s |
| `pnpm check:deps` | 0 | 20 packages / 27 edges; boundaries and acyclic graph verified |
| `pnpm typecheck` | 0 | existing root project references compile; package checked separately |
| `TMPDIR=/tmp pnpm test` | 1 | 92 files passed, 2 failed, 3 skipped; 1791 tests passed, 2 failed, 4 skipped; 304.20s |
| `git diff --check` and baseline ownership diff check | 0 | no whitespace errors |

The full run started against the P28 working tree before the implementation commit and
finished after it. Final P28 hardening was additionally covered by the package command
above. This is local source/rendering evidence, not remote closure or live activation.

Full-suite failures outside P28 ownership:

- `packages/machine-setup/test/executor.test.ts:310`: timed abort expected `unknown`,
  observed `blocked` in the concurrent full run. The baseline owner helper also reproduced
  the timing failure; an isolated baseline rerun passed, so do not claim it deterministic.
- `packages/tool-installer/test/services-and-config.test.ts:92`: existing RTK apply rejects
  the operator's `.codex/hooks.json` as not a bounded regular file. Reproduced on unchanged
  baseline `a39374d`. No operator hook/config was edited to make the test pass.

The three opt-in live test files were skipped. No model call, native skill discovery,
provider readiness, live Herdr task success or full SDLC acceptance is claimed. An initial
run with a root node_modules symlink was discarded after pnpm's unsafe-task-path guard;
final evidence uses independent real node_modules. No generated dependencies, outputs or
logs are committed.

## Integration decisions and ownership

Changed paths are exclusively `packages/skills/**` and `skills/**`. No public contract,
root config, lockfile, shared documentation, migration or generated output change is
included. Installation generated a local lockfile importer for testing; it was restored
before handoff. Root TypeScript references do not yet include the new package.

Integrator should add the package importer/reference; P26 injects SkillsSetupSynchronizer;
P29 uses repositoryConfig for its init-owned skills config and exposes command UX; P30
persists the exact session manifest and composes rendered instructions through P25.
Detailed port usage is in README. CLI `skills`/`setup` and automatic init activation remain
unwired on this baseline; this handoff does not represent command acceptance.

No contract amendment is requested. Tool requirement IDs (`gitnexus`, `rtk`, `mempalace`,
`browser`) need mapping to actual approved/probed inventory. The host must supply trusted
builtin digest pins and authenticate source/dependency/scope/role/provider/expiry approvals.
Original role prompts remain mandatory. Storage is local POSIX, with no power-loss,
network-filesystem, multi-host or hostile same-UID guarantee. Crash locks require explicit
operator reconciliation; no uncertain mutation is retried automatically. Existing P02-RA01,
P03-RA01 and release acceptance gaps remain unchanged with their original owners.
