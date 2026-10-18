import type { AgentLaunchProfile } from "./types.js";
import { AGENT_LAUNCH_PROVIDERS } from "./types.js";

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_PATTERNS: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9_])sk-[A-Za-z0-9_-]{8,}/,
  /Bearer\s+\S+/i,
  /(?:^|[^A-Za-z0-9_])ghp_[A-Za-z0-9_]{8,}/,
  /(?:^|[^A-Za-z0-9_])AIza[0-9A-Za-z_-]{8,}/,
  /secret:\/\//i
];
const CONTROL_PATTERN = /[\0\r\n]/;
const MAX_ARGV_ITEMS = 256;
const MAX_ARG_BYTES = 8192;

export interface LaunchProfileProblem {
  readonly message: string;
}

/**
 * Validates a provider launch profile before any Herdr side effect. Returns a
 * problem description, or undefined when the profile is acceptable.
 * Env values are never echoed in messages.
 */
export function checkLaunchProfile(launch: AgentLaunchProfile, agentKind: string): LaunchProfileProblem | undefined {
  if (!launch || typeof launch !== "object") return { message: "Launch profile must be an object" };
  if (!(AGENT_LAUNCH_PROVIDERS as readonly string[]).includes(launch.provider)) {
    return { message: `Unsupported launch provider '${String(launch.provider)}'` };
  }
  if (launch.provider !== agentKind) {
    return { message: `Launch provider '${launch.provider}' does not match configured agent kind '${agentKind}'` };
  }
  if (typeof launch.launchId !== "string" || launch.launchId.length === 0 || CONTROL_PATTERN.test(launch.launchId)) {
    return { message: "Launch profile launchId must be a non-empty string without control characters" };
  }
  if (typeof launch.launchFingerprint !== "string" || launch.launchFingerprint.length === 0 || CONTROL_PATTERN.test(launch.launchFingerprint)) {
    return { message: "Launch profile launchFingerprint must be a non-empty string without control characters" };
  }
  if (!Array.isArray(launch.argv) || launch.argv.length > MAX_ARGV_ITEMS) {
    return { message: `Launch profile argv must be an array of at most ${MAX_ARGV_ITEMS} items` };
  }
  for (const [index, item] of launch.argv.entries()) {
    if (typeof item !== "string") return { message: `Launch argv item ${index} must be a string` };
    if (Buffer.byteLength(item, "utf8") > MAX_ARG_BYTES) return { message: `Launch argv item ${index} is too large` };
    if (CONTROL_PATTERN.test(item)) return { message: `Launch argv item ${index} contains NUL or newline characters` };
    if (SECRET_PATTERNS.some((pattern) => pattern.test(item))) {
      return { message: `Launch argv item ${index} looks like a secret; pass secrets through launch env instead` };
    }
  }
  if (launch.env === null || typeof launch.env !== "object" || Array.isArray(launch.env)) {
    return { message: "Launch profile env must be an object of string values" };
  }
  for (const [key, value] of Object.entries(launch.env)) {
    if (!ENV_KEY_PATTERN.test(key)) return { message: `Launch env key '${key}' is invalid` };
    if (typeof value !== "string" || CONTROL_PATTERN.test(value)) {
      return { message: `Launch env value for '${key}' must be a string without NUL or newline` };
    }
  }
  return undefined;
}
