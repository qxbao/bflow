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

/** Agy has no auth/status subcommand. Its read-only model listing checks access; Runtime still probes actual execution. */
export async function probeAgyAccess(runner: EnvironmentProcessRunner,
  request: Omit<EnvironmentProcessRequest, "executable" | "args" | "mode">): Promise<AgyAccessResult> {
  let result;
  try { result = await runner.run({ ...request, executable: "agy", args: ["models"] }); }
  catch (error) {
    return { status: "unavailable", message: `Agy access check failed: ${humanLine(error instanceof Error ? error.message : String(error), 160)}`,
      remediation: AGY_ACCESS_REMEDIATION };
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
