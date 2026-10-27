import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { EnvironmentDoctorCheckSchema, type EnvironmentDoctorCheck } from "@bflow/contracts";
const execute = promisify(execFile);
export type SandboxReadiness = { status: "ready"; executable: string; platform: "linux" | "darwin" } | { status: "unsupported"; code: "verification_sandbox_unavailable"; reason: string };
/** PATH discovery plus a real empty namespace probe. An installed binary is not proof of isolation availability. */
export async function probeBehavioralSandbox(repositoryRoot = process.cwd()): Promise<SandboxReadiness> {
  return (await probeSandbox(repositoryRoot)).readiness;
}

/** `usernsDenied` names the first launcher refused by the AppArmor user namespace restriction, for doctor remediation only. */
async function probeSandbox(repositoryRoot: string): Promise<{ readiness: SandboxReadiness; usernsDenied?: string }> {
  if (process.platform === "darwin") {
    try {
      const executable = "/usr/bin/sandbox-exec";
      await access(executable, constants.X_OK);
      // Probe actual deny-default execution of the real measurement profile, not only an installed deprecated launcher.
      await (await import("./behavioral-sandbox-darwin.js")).probeSeatbeltProfile();
      return { readiness: { status: "ready", executable, platform: "darwin" } };
    } catch { return { readiness: { status: "unsupported", code: "verification_sandbox_unavailable", reason: "Seatbelt cannot execute the required system/Node probe under the verification policy. Verify /usr/bin/sandbox-exec and use a standalone Node distribution whose runtime dependencies fit that policy" } }; }
  }
  if (process.platform !== "linux") return { readiness: { status: "unsupported", code: "verification_sandbox_unavailable", reason: `Behavioral sandbox is not verified on ${process.platform}` } };
  const seen = new Set<string>();
  let failure: { reason: string; usernsDenied?: string } | undefined;
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    let executable: string;
    try {
      executable = await realpath(join(directory, "bwrap"));
      if (executable === repositoryRoot || executable.startsWith(repositoryRoot + "/")) continue;
      if (seen.has(executable)) continue;
      seen.add(executable);
      await access(executable, constants.X_OK);
    } catch { continue; }
    try {
      await execute(executable, ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--", "/usr/bin/true"], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 10_000, maxBuffer: 16384 });
      return { readiness: { status: "ready", executable, platform: "linux" } };
    } catch (error) {
      // Keep the first launcher's diagnosis; later PATH entries only get a chance to succeed.
      if (failure) continue;
      // execFile's message repeats argv; retain only bounded stderr or a launcher classification.
      const stderr = error !== null && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      const detail = stripVTControlCharacters(stderr).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim().slice(0, 240)
        || (error !== null && typeof error === "object" && "killed" in error && error.killed ? "namespace probe timed out" : "namespace probe could not execute");
      const restricted = /permission denied|operation not permitted/i.test(detail)
        && (await readFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").catch(() => "")).trim() === "1";
      failure = restricted
        ? { reason: `AppArmor user namespace restriction is enabled; check the userns profile for Bubblewrap ${executable}. ${detail}`, usernsDenied: executable }
        : { reason: `Bubblewrap ${executable} cannot create the verification sandbox: ${detail}` };
      // Try the next distinct PATH binary. Never weaken namespace flags.
    }
  }
  return { readiness: { status: "unsupported", code: "verification_sandbox_unavailable", reason: failure?.reason ?? "Bubblewrap executable not found outside the repository on PATH; install the distribution bubblewrap package" },
    ...(failure?.usernsDenied ? { usernsDenied: failure.usernsDenied } : {}) };
}

const runtimeReadme = fileURLToPath(new URL("../../README.md", import.meta.url));
const bwrapProfile = fileURLToPath(new URL("../../support/bflow-bwrap.apparmor", import.meta.url));

/**
 * Read-only doctor check using the same probe as Runtime startup. Startup blocks on it only when owner commands or detected
 * runners exist; doctor reports it unconditionally because runner detection may warm dependencies, which doctor must not do.
 */
export async function diagnoseVerificationSandbox(repositoryRoot = process.cwd()): Promise<EnvironmentDoctorCheck> {
  const { readiness: result, usernsDenied } = await probeSandbox(repositoryRoot);
  return EnvironmentDoctorCheckSchema.parse({
    checkId: "runtime-verification-sandbox", name: "Independent verification sandbox",
    status: result.status === "ready" ? "passed" : "failed",
    message: result.status === "ready" ? `${result.platform === "linux" ? "Bubblewrap" : "Seatbelt"} verification sandbox execution probe passed`
      : `${result.reason} (bflow up blocks when verification runners are detected or configured)`,
    ...(result.status === "unsupported" ? { remediation: usernsDenied === "/usr/bin/bwrap"
      ? `Have an administrator review and install ${bwrapProfile} (see ${runtimeReadme}), then run bflow doctor. Keep the system-wide restriction enabled.`
      : usernsDenied
        ? `The reviewed AppArmor profile ${bwrapProfile} attaches to /usr/bin/bwrap only, but the probed launcher is ${usernsDenied}. Install the distribution bubblewrap package or have an administrator adapt the profile path (see ${runtimeReadme}).`
        : process.platform === "linux"
          ? "Install the distribution bubblewrap package if missing; check host user/network namespace policy if installed, then run bflow doctor. No unsandboxed fallback is supported."
          : `Check the host sandbox and runtime requirements in ${runtimeReadme}, then run bflow doctor.` } : {})
  });
}
