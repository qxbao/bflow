import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { BoundBehavioralCommand } from "./behavioral-runner.js";

const run = promisify(execFile);

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Seatbelt (`sandbox-exec`) policy. Everything is denied by default; the paths below are the only grants.
 * Unlike the Linux namespace, Seatbelt cannot hide paths: the host filesystem still exists but its contents are
 * unreadable and unwritable. `file-read-metadata` is granted globally only because Node's `realpath` must `lstat`
 * every ancestor of an allowed path. There is no network, IPC or signal grant.
 */
const BASE_PROFILE = `(version 1)
(deny default)
(allow process-fork)
(allow signal (target children))
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")
  (subpath "/usr/lib") (subpath "/System") (subpath "/private/var/db/dyld"))
(allow file-write* (literal "/dev/null"))
(allow file-read* (literal "/private/etc/hosts") (literal "/etc/hosts"))
(allow process-exec (literal (param "EXECUTABLE")))
(allow file-read* (literal (param "EXECUTABLE")))
(allow file-read* file-write* (subpath (param "CHECKOUT")))
(allow file-read* file-write* (subpath (param "SCRATCH")))
`;

/**
 * Executes `/usr/bin/true` and the host's actual Node runtime under the exact base profile used for measurements.
 * A successful system binary alone cannot prove that Node's loader/dependencies are permitted.
 * Readiness must prove the real policy:
 * a hand-written minimal profile aborts dyld on current macOS (it also needs "/" and /dev/null), which made a working
 * sandbox look unavailable.
 */
export async function probeSeatbeltProfile(): Promise<void> {
  const scratch = await realpath(tmpdir());
  const params: [string, string][] = [["EXECUTABLE", "/usr/bin/true"], ["CHECKOUT", scratch], ["SCRATCH", scratch]];
  await run(SANDBOX_EXEC, ["-p", BASE_PROFILE, ...params.flatMap(([key, value]) => ["-D", `${key}=${value}`]), "--", "/usr/bin/true"],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 10_000, maxBuffer: 16384 });
  const node = await realpath(process.execPath);
  params[0] = ["EXECUTABLE", node];
  await run(SANDBOX_EXEC, ["-p", BASE_PROFILE, ...params.flatMap(([key, value]) => ["-D", `${key}=${value}`]), "--", node, "--version"],
    { env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 10_000, maxBuffer: 16384 });
}

/** Scratch directory the sandboxed process may write to (its TMPDIR); a sibling of the checkout, never the checkout. */
export function darwinScratchDirectory(checkout: string): string {
  return join(dirname(checkout), "tmp");
}

/** Dependency trees are cloned (APFS copy-on-write) into the checkout because Seatbelt has no bind mounts; the policy then makes them read-only. */
async function cloneDependencyRoots(command: BoundBehavioralCommand, checkout: string): Promise<string[]> {
  const roots = command.checkoutDependencyRoots, source = command.dependencySource;
  if (roots === undefined || roots.length === 0) return [];
  if (source === undefined || await realpath(source) !== resolve(source))
    throw new Error("Behavioral checkout dependencies require a canonical dependency source and node_modules roots");
  const realCheckout = await realpath(checkout), targets: string[] = [];
  for (const rel of roots) {
    if (basename(rel) !== "node_modules") throw new Error("Checkout dependency roots must be node_modules directories");
    const from = join(source, rel), info = await lstat(from);
    if (!info.isDirectory() || await realpath(from) !== from) throw new Error("Behavioral checkout dependency source must be a real node_modules directory");
    let current = checkout;
    for (const part of rel.split("/")) {
      current = join(current, part);
      try { if (!(await lstat(current)).isDirectory()) throw new Error("Behavioral checkout dependency mountpoint is not a directory"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(current); }
    }
    if (await realpath(current) !== join(realCheckout, rel)) throw new Error("Behavioral checkout dependency mountpoint escapes the checkout");
    // A measurement sandboxes up to twice (prepare, then tests) over one checkout. The tree is read-only inside the
    // sandbox, so a populated mountpoint is the earlier clone; copying over it would fail on read-only files.
    if ((await readdir(current)).length === 0) {
      // -c: clonefile(2) copy-on-write, -R without -L keeps symlinks as links, `from/.` fills the mountpoint.
      await run("/bin/cp", ["-c", "-R", `${from}/.`, `${current}/`], { timeout: 120_000 });
    }
    // Seatbelt matches resolved paths, so the policy must name the real location (/private/var, not /var).
    targets.push(join(realCheckout, rel));
  }
  return targets;
}

export async function sandboxBehaviorDarwin(command: BoundBehavioralCommand, checkout: string, argv: string[], reporter?: string) {
  if (!(await lstat(SANDBOX_EXEC)).isFile()) throw new Error(`Behavioral verification requires ${SANDBOX_EXEC}`);
  const binary = await realpath(command.executable);
  if (!(await lstat(binary)).isFile()) throw new Error("Behavioral executable must resolve to a regular file");
  const realCheckout = await realpath(checkout), scratch = darwinScratchDirectory(realCheckout);
  await mkdir(scratch, { recursive: true, mode: 0o700 });

  const params: [string, string][] = [["EXECUTABLE", binary], ["CHECKOUT", realCheckout], ["SCRATCH", await realpath(scratch)]];
  const rules: string[] = [];
  const readOnly = (path: string) => {
    const name = `RO${params.length}`;
    params.push([name, path]);
    rules.push(`(allow file-read* (subpath (param "${name}")))`);
  };
  for (const path of command.dependencyRoots ?? []) {
    if (basename(path) !== "node_modules" || await realpath(path) !== resolve(path) || !(await lstat(path)).isDirectory())
      throw new Error("Behavioral dependency roots must be canonical node_modules directories");
    readOnly(path);
  }
  for (const target of await cloneDependencyRoots(command, checkout)) {
    const name = `DEP${params.length}`;
    params.push([name, target]);
    // Later rules win: the cloned tree is readable but not writable even though it lives inside the writable checkout.
    rules.push(`(deny file-write* (subpath (param "${name}")))`);
  }
  if (reporter) {
    const name = `REPORTER${params.length}`;
    params.push([name, await realpath(reporter)]);
    rules.push(`(allow file-read* (literal (param "${name}")))`);
  }
  const profile = `${BASE_PROFILE}${rules.join("\n")}\n`;
  const args = ["-p", profile, ...params.flatMap(([key, value]) => ["-D", `${key}=${value}`]), "--", binary, ...argv];
  return { executable: SANDBOX_EXEC, args };
}
