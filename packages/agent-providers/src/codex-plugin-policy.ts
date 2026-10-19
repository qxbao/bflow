/** Retired Bflow integrations; never disable similarly named third-party plugins. */
const RETIRED_PLUGIN_IDS = new Set(["claude-mem@claude-mem-local", "claude-mem@thedotmack"]);

/** Shared by the effective hook inventory and the actual managed Codex invocations. */
export function managedCodexDisabledPlugins(enabledPlugins: readonly string[]): string[] {
  return enabledPlugins.filter(id => RETIRED_PLUGIN_IDS.has(id));
}

export function managedCodexPluginArgs(): string[] {
  // Codex's -c parser splits dotted paths literally: quoting the ID creates a different key.
  // Always send both overrides so a concurrent config edit cannot enable an unreviewed hook.
  return [...RETIRED_PLUGIN_IDS].flatMap(id => ["-c", `plugins.${id}.enabled=false`]);
}
