import { isAbsolute } from "node:path";
import { parse } from "smol-toml";

const MAX_CODEX_CONFIG_BYTES = 256 * 1024;
const EVENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const HOOK_STATE_KEY = /^(.*):([^:]+):([0-9]+):([0-9]+)$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be a TOML table");
  return value as Record<string, unknown>;
}

function validateNativeHookState(value: unknown): void {
  const state = record(value, "hooks.state");
  for (const [key, entry] of Object.entries(state)) {
    const match = HOOK_STATE_KEY.exec(key);
    if (!match || !isAbsolute(match[1]!) || !EVENT_NAME.test(match[2]!))
      throw new Error("hooks.state contains an unknown or unsafe metadata key");
    const metadata = record(entry, "hooks.state entry");
    if (Object.keys(metadata).some(name => name !== "enabled" && name !== "trusted_hash"))
      throw new Error("hooks.state contains unknown metadata");
    if (metadata.enabled !== undefined && typeof metadata.enabled !== "boolean")
      throw new Error("hooks.state enabled metadata must be boolean");
    if (metadata.trusted_hash !== undefined &&
      (typeof metadata.trusted_hash !== "string" || metadata.trusted_hash.length > 256))
      throw new Error("hooks.state trusted_hash metadata is invalid");
  }
}

function validateExecutableEvent(event: string, value: unknown): boolean {
  if (!EVENT_NAME.test(event)) throw new Error("Codex hook event '" + event + "' is not a safe event name");
  if (!Array.isArray(value)) throw new Error("Codex hook event '" + event + "' must be an array of hook groups");
  let hasExecutableHook = false;
  for (const groupValue of value) {
    const group = record(groupValue, "Codex hook event '" + event + "' group");
    if (Object.keys(group).some(key => key !== "hooks" && key !== "matcher"))
      throw new Error("Codex hook event '" + event + "' group contains an unknown control field");
    if (group.matcher !== undefined && typeof group.matcher !== "string" &&
      (group.matcher === null || typeof group.matcher !== "object" || Array.isArray(group.matcher)))
      throw new Error("Codex hook event '" + event + "' matcher has an unsupported shape");
    if (!Array.isArray(group.hooks)) throw new Error("Codex hook event '" + event + "' group has no hook array");
    for (const hookValue of group.hooks) {
      const hook = record(hookValue, "Codex hook event '" + event + "' entry");
      if (Object.keys(hook).some(key => !["type", "command", "timeout", "statusMessage"].includes(key)))
        throw new Error("Codex hook event '" + event + "' entry contains an unknown control field");
      if (hook.type !== "command" || typeof hook.command !== "string" || hook.command.trim().length === 0)
        throw new Error("Codex hook event '" + event + "' contains an unsupported executable hook form");
      if (hook.timeout !== undefined && (typeof hook.timeout !== "number" || !Number.isFinite(hook.timeout) || hook.timeout <= 0))
        throw new Error("Codex hook event '" + event + "' timeout must be a positive number");
      if (hook.statusMessage !== undefined && typeof hook.statusMessage !== "string")
        throw new Error("Codex hook event '" + event + "' statusMessage must be a string");
      hasExecutableHook = true;
    }
  }
  return hasExecutableHook;
}

/**
 * Parses only Codex's executable [hooks] configuration. Hook trust/state metadata is validated and
 * excluded; unrelated config (including credentials and MCP servers) never enters the returned value.
 */
export function parseCodexTomlHooks(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text, "utf8") > MAX_CODEX_CONFIG_BYTES)
    throw new Error("Codex config.toml exceeds the " + MAX_CODEX_CONFIG_BYTES + " byte parsing limit");
  let parsed: unknown;
  try { parsed = parse(text, { unsafeKeyBehaviour: "throw" }); }
  catch { throw new Error("Codex config.toml contains malformed TOML; inspect its syntax locally."); }
  const config = record(parsed, "Codex config.toml");
  if (config.hooks === undefined) return {};
  const hooks = record(config.hooks, "Codex hooks");
  const executable: Record<string, unknown> = {};
  for (const [event, value] of Object.entries(hooks)) {
    if (event === "state") {
      validateNativeHookState(value);
      continue;
    }
    if (validateExecutableEvent(event, value)) executable[event] = value;
  }
  return executable;
}

export const CODEX_CONFIG_HOOK_MAX_BYTES = MAX_CODEX_CONFIG_BYTES;
