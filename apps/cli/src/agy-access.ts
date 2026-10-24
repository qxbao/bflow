import { copyFile, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { EnvironmentProcessRequest, EnvironmentProcessRunner } from "./environment-process.js";
import { humanLine } from "./presentation.js";

export const AGY_LOGIN_REMEDIATION = "Run 'agy' interactively and complete its login flow, then verify with 'agy models' and 'bflow doctor'.";
const AGY_ACCESS_REMEDIATION = "Run 'agy models' in this repository to inspect provider access, then rerun 'bflow doctor'.";
const AGY_BLOCK_REMEDIATION = "Resolve the provider policy/workspace block and verify with 'bflow agent check agy' or 'bflow doctor'.";
const FailureSchema = z.object({
  blocked: z.boolean().optional(), status: z.string().optional(), reason: z.string().optional(),
  loggedIn: z.boolean().optional(), authenticated: z.boolean().optional()
}).passthrough();

interface AgyAccessResult {
  readonly status: "available" | "blocked" | "unauthenticated" | "unavailable";
  readonly message: string;
  readonly remediation: string;
}

async function createIsolatedAgyProbeHome(baseEnv: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (baseEnv["AI_ISOLATOR_PROFILE"] !== undefined) return undefined;
  const nativeHome = baseEnv["HOME"] ?? process.env["HOME"];
  const probeHome = await mkdtemp(join(tmpdir(), "bflow-agy-access-"));
  const cacheDir = join(probeHome, ".gemini", "antigravity-cli", "cache");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  if (nativeHome) {
    const sourceOnboarding = join(nativeHome, ".gemini", "antigravity-cli", "cache", "onboarding.json");
    try {
      const info = await lstat(sourceOnboarding);
      if (info.isFile() && !info.isSymbolicLink()) {
        await copyFile(sourceOnboarding, join(cacheDir, "onboarding.json"));
      }
    } catch { /* Onboarding adoption is best-effort for probe isolation. */ }
    const sourceKeychains = join(nativeHome, "Library", "Keychains");
    try {
      const info = await lstat(sourceKeychains);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await mkdir(join(probeHome, "Library"), { recursive: true, mode: 0o700 });
        await symlink(sourceKeychains, join(probeHome, "Library", "Keychains"), "dir");
      }
    } catch { /* Keychains symlink is macOS-specific. */ }
  }
  return probeHome;
}

/** Agy has no auth/status subcommand. Its read-only model listing checks access; Runtime still probes actual execution. */
export async function probeAgyAccess(runner: EnvironmentProcessRunner,
  request: Omit<EnvironmentProcessRequest, "executable" | "args" | "mode">): Promise<AgyAccessResult> {
  const baseEnv = request.env ?? process.env;
  let isolatedHome: string | undefined;
  let result;
  try {
    isolatedHome = await createIsolatedAgyProbeHome(baseEnv).catch(() => undefined);
    const env = isolatedHome !== undefined ? { ...baseEnv, HOME: isolatedHome } : request.env;
    result = await runner.run({ ...request, ...(env !== undefined ? { env } : {}), executable: "agy", args: ["models"] });
  } catch (error) {
    return { status: "unavailable", message: `Agy access check failed: ${humanLine(error instanceof Error ? error.message : String(error), 160)}`,
      remediation: AGY_ACCESS_REMEDIATION };
  } finally {
    if (isolatedHome !== undefined) await rm(isolatedHome, { recursive: true, force: true }).catch(() => undefined);
  }
  let failure: z.infer<typeof FailureSchema> | undefined;
  try {
    const parsed = FailureSchema.safeParse(JSON.parse(result.stdout));
    if (parsed.success) failure = parsed.data;
  } catch { /* Native successful output is a tab-separated model list. */ }
  const output = `${result.stdout}\n${result.stderr}`;
  const hasModels = result.stdout.split(/\r?\n/).some(line => /^[A-Za-z0-9][A-Za-z0-9._:/-]*\t+\S/.test(line));
  const detail = humanLine(failure?.reason ?? (result.stderr.trim() || result.stdout), 160);
  // Model names/descriptions are data; explicit stderr failures remain authoritative even with a partial list.
  const failureText = hasModels ? result.stderr : output;
  if (failure?.blocked === true || failure?.status === "blocked" || /\bblocked\b/i.test(failureText)) {
    return { status: "blocked", message: `Agent provider 'agy' is blocked${detail ? `: ${detail}` : ""}.`, remediation: AGY_BLOCK_REMEDIATION };
  }
  if (failure?.loggedIn === false || failure?.authenticated === false ||
    /\b(?:unauthenticated|unauthori[sz]ed|not (?:logged|signed) in|(?:login|authentication) required|please (?:log|sign) in|(?:credentials?|token) (?:expired|invalid))\b/i.test(failureText)) {
    return { status: "unauthenticated", message: "Agent provider 'agy' is not authenticated.", remediation: AGY_LOGIN_REMEDIATION };
  }
  if (result.exitCode !== 0 || !hasModels) {
    return { status: "unavailable", message: `Agy access check failed${detail ? `: ${detail}` : ": no model list returned"}.`,
      remediation: AGY_ACCESS_REMEDIATION };
  }
  return { status: "available", message: "Provider 'agy' model access verified; Runtime still verifies execution readiness.", remediation: "" };
}
