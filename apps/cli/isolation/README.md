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

`lib/mcp_sync.py` is a standalone extraction of the behavior used by the original
`runtime.dispatch.shell.mcp_config.sync_codex_mcp_servers`. It synchronizes only
shared MCP tables, retains profile-local configuration, mirrors Codex hook trust
keys to the profile hook path, validates TOML before replacing, and uses a
same-directory atomic replacement with symlink refusal and bounded retry when
concurrent edits are detected. It has no ai-sdlc package imports.

Intentional changes from the source:

- Help/version branding is `bflow iso`; the existing `ai-isolator` state paths
  and shell managed-block marker strings remain stable so both CLIs can manage
  each other's profiles and aliases.
- The source's optional `runtime/provision/shell/portable.sh` import was replaced
  by a small in-script Python selector and Git Bash UTF-8 setup. No unrelated
  runtime module is bundled. Bash, Python 3.11+ (for `tomllib`), and curl or wget
  for Codex LB health probes are required for the corresponding features. The
  selector checks for `tomllib`, then tries the next available Python executable.
  If shared Codex config exists and no supported Python is available, MCP sync
  prints one warning and skips the sync; Codex profile startup continues.
- Agy is additive: `login agy` launches native Agy onboarding under isolated
  HOME, while `run agy` and direct `agy` launch its native UI once. Agy has no
  auth/status subcommand, so status reports `unverified` without running a model
  or auth probe. No account credentials or config are copied or linked. Agy uses
  its native `$HOME/.gemini/antigravity-cli` location inside the profile.
- Inherited `CLAUDE_CONFIG_DIR` and Agy-specific config and credential variables
  are cleared for child processes so they cannot redirect a profile to an
  account configuration outside its HOME. A successful profile removal returns
  status 0 even when the profile has no managed shell launcher.
- On Git Bash, native CLI argument path conversion remains provided by MSYS.
  Sharing `hooks.json` needs symlink permission; when unavailable MCP config
  synchronization still works, but hook trust mirroring cannot be established.

The engine does not install tools, modify global provider settings, or change
file access permissions. Profile HOME/XDG isolation removes the listed provider
credentials from the child environment; it is not an OS sandbox.

For shell launchers, set `AI_ISOLATOR_SHELL=bash|fish|zsh|csh|ksh` when your
current shell differs from `$SHELL`. The bundled source checks its immediate
parent, so invocation through Node can use the `$SHELL` fallback. The alias
prompt shows the selected RC path before asking to write it.
