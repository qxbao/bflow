import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);
export type SandboxReadiness = { status: "ready"; executable: string; platform: "linux" | "darwin" } | { status: "unsupported"; code: "verification_sandbox_unavailable"; reason: string };
/** PATH discovery plus a real empty namespace probe. An installed binary is not proof of isolation availability. */
export async function probeBehavioralSandbox(repositoryRoot = process.cwd()): Promise<SandboxReadiness> {
  if (process.platform === "darwin") {
    try {
      const executable = "/usr/bin/sandbox-exec";
      await access(executable, constants.X_OK);
      // Probe actual deny-default execution, not only an installed deprecated launcher.
      await execute(executable, ["-p", '(version 1)(deny default)(allow process-exec (literal "/usr/bin/true"))(allow file-read* (literal "/usr/bin/true") (subpath "/usr/lib") (subpath "/System") (subpath "/private/var/db/dyld"))(allow file-read-metadata)(allow sysctl-read)', "--", "/usr/bin/true"], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 10_000, maxBuffer: 16384 });
      return { status: "ready", executable, platform: "darwin" };
    } catch { return { status: "unsupported", code: "verification_sandbox_unavailable", reason: "No usable Seatbelt sandbox; isolated verification is unavailable on this host" }; }
  }
  if (process.platform !== "linux") return { status: "unsupported", code: "verification_sandbox_unavailable", reason: `Behavioral sandbox is not verified on ${process.platform}` };
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const executable = await realpath(join(directory, "bwrap"));
      if (executable === repositoryRoot || executable.startsWith(repositoryRoot + "/")) continue;
      await access(executable, constants.X_OK);
      await execute(executable, ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--", "/usr/bin/true"], { env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 10_000, maxBuffer: 16384 });
      return { status: "ready", executable, platform: "linux" };
    } catch { /* Try next PATH binary. Never weaken namespace flags. */ }
  }
  return { status: "unsupported", code: "verification_sandbox_unavailable", reason: "No usable Bubblewrap sandbox; isolated verification is unavailable on this host" };
}
