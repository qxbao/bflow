/** Retired or unpinned Bflow/Codex integrations disabled in Bflow-managed Codex processes. */
export const DISABLED_CODEX_PLUGINS = [
  "claude-mem@claude-mem-local",
  "claude-mem@thedotmack",
  "bflow-superpowers@bflow-superpowers"
] as const;

const RETIRED_PLUGIN_IDS = new Set<string>(DISABLED_CODEX_PLUGINS);

/** Shared by the effective hook inventory and the actual managed Codex invocations. */
export function managedCodexDisabledPlugins(
  enabledPlugins: readonly string[],
  extraDisabledPluginIds: readonly string[] = []
): string[] {
  const disabled = new Set<string>([...RETIRED_PLUGIN_IDS, ...extraDisabledPluginIds]);
  return enabledPlugins.filter(id => disabled.has(id));
}

export function managedCodexPluginArgs(extraPluginIds: readonly string[] = []): string[] {
  // Codex's -c parser splits dotted paths literally: quoting the ID creates a different key.
  // Always send all default overrides so a concurrent config edit cannot enable an unreviewed hook or skill pack.
  const ids = new Set<string>([...RETIRED_PLUGIN_IDS, ...extraPluginIds]);
  return [...ids].flatMap(id => ["-c", `plugins.${id}.enabled=false`]);
}
