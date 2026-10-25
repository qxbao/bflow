# Bundled `bflow iso` engine

`bin/ai-isolator` bundles the `ai-isolator` v0.4.4 Bash engine from the ai-sdlc
checkout at `speckit/runmethod/ai-sdlc/bin/ai-isolator` (SHA-256
`81d9f3649768d3650c6477df8bafbcc222bccfcf8b53893753ab6ffbf20d8b7d`). It keeps
the original profile layout, environment scrub, Codex LB decisions and overrides,
profile metadata, shell markers, MCP/hook behavior, additive skills, and commands.
The shared state root remains `${AI_ISOLATOR_HOME:-$HOME/.local/share/ai-isolator}`;
existing profiles are used in place without migration. Codex/Claude profiles retain
two-way compatibility with the original CLI. Agy profiles use the same
`agy--<name>` metadata/layout protocol, but original v0.4.4 does not support Agy.

The compiled distribution must retain `apps/cli/isolation/` beside `dist/`, including
the Bash engine and both Python helpers. The release smoke test runs `bflow iso help`
and loads both helpers from the extracted archive; CLI `--help` alone does not check
these runtime assets. These checks do not launch or authenticate a provider.

`lib/mcp_sync.py` is a standalone extraction of the behavior used by the original
`runtime.dispatch.shell.mcp_config.sync_codex_mcp_servers`. It synchronizes only
shared MCP tables, retains profile-local configuration, mirrors Codex hook trust
keys to the profile hook path, validates TOML before replacing, and uses a
same-directory atomic replacement with symlink refusal and bounded retry when
concurrent edits are detected. It has no ai-sdlc package imports.

`lib/profile_sync.py` is the shared provider setup synchronizer used by `bflow
iso` initialization and the CLI setup component. It supports read-only `inspect`
and atomic `apply` for Codex, Claude, and Agy native MCP, instruction skills,
and the `bflow-superpowers` managed plugin registration/assets. Direct use
requires Python 3.11 or newer and absolute `--source-home` / `--state-root`
paths; `--provider` and `--profile` must be supplied together for one profile.
`targets` reports the selected canonical profile HOME directories, while
`ownedPaths` reports files changed by apply. Inspect does not create profiles,
receipts, caches, or directories.

Each selected existing profile is checked against `profile.env` identity and a
private mode-0600 `.bflow-profile-sync.json` receipt. Managed entry edits and
changed owned assets are reported as conflicts instead of being overwritten;
unrelated profile settings, auth, local MCP entries, skills, and plugins remain
profile-local. MCP secret values are synchronized only from the selected native
tool configuration when present, are never included in public reports, and are
represented only by private receipt fingerprints. The helper does not install
provider tools, authenticate, copy provider account state, or change hook
approval policy. Existing Codex hook trust-state remapping is retained, and
native `hooks.json` is shared only when a profile has no local hooks file; an
existing local file is never replaced. This does not execute hooks or approve
new hooks.

For normal `bflow iso` launches, the native source is the trusted original HOME
(or `AI_ISOLATOR_REAL_HOME` for nested invocations), with explicit
`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `AI_ISOLATOR_CODEX_SKILLS_SOURCE`
overrides. When `BFLOW_HOME` is set, native provider sources are confined to
`$BFLOW_HOME/providers/{home,codex,claude}`. Profile storage remains at the
shared `${AI_ISOLATOR_HOME:-$HOME/.local/share/ai-isolator}` location; `BFLOW_HOME`
does not migrate or redirect existing profile identities.

Intentional changes from the source:

- Help/version branding is `bflow iso`; the existing `ai-isolator` state paths
  and shell managed-block marker strings remain stable so both CLIs can manage
  each other's profiles and aliases.
- The source's optional `runtime/provision/shell/portable.sh` import was replaced
  by a small in-script Python selector and Git Bash UTF-8 setup. No unrelated
  runtime module is bundled. Bash, Python 3.11+ (for `tomllib`), and curl or wget
  for Codex LB health probes are required for the corresponding features. The
  selector checks for `tomllib`, then tries every Python executable found on the caller's
  existing PATH. This includes compatible interpreters behind Apple's older system Python;
  paths containing spaces remain single arguments. It adds no global search locations.
  Python 3.11+ is required for profile initialization and startup because native
  capability synchronization is part of profile readiness. If no supported
  Python is available, synchronization fails visibly and the profile is not
  launched. A failed Codex hooks binding also fails synchronization; it cannot
  be reported as native setup parity.
- Agy is additive: `login agy` launches native Agy onboarding under isolated
  HOME, while `run agy` and direct `agy` launch its native UI once. Agy has no
  auth/status subcommand, so status reports `unverified` without running a model
  or auth probe. Provider account/auth files are not copied or linked. Approved
  MCP definitions (including configured MCP secrets), instruction skills and managed
  plugin configuration are still synchronized by the helper described above. Agy uses
  its native `$HOME/.gemini/antigravity-cli` location inside the profile.
- Inherited `CLAUDE_CONFIG_DIR` and Agy-specific config and credential variables
  are cleared for child processes so they cannot redirect a profile to an
  account configuration outside its HOME. A successful profile removal returns
  status 0 even when the profile has no managed shell launcher.
- On Git Bash, native CLI argument path conversion remains provided by MSYS.
  Sharing `hooks.json` needs symlink permission; when unavailable MCP config
  synchronization still works, but hook trust mirroring cannot be established.

The engine does not install provider tools. It manages profile-owned HOME/XDG/TMP
directories, attempts private mode `0700` on those directories, and synchronizes
owned configuration/receipt files through the helpers above. Profile HOME/XDG isolation
scrubs the listed provider credential variables from the child environment; it is not
an OS sandbox or a guarantee against another process with the same UID.

For shell launchers, set `AI_ISOLATOR_SHELL=bash|fish|zsh|csh|ksh` when your
current shell differs from `$SHELL`. The bundled source checks its immediate
parent, so invocation through Node can use the `$SHELL` fallback. The alias
prompt shows the selected RC path before asking to write it.
