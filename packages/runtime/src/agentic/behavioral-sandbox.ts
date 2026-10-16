import { lstat, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { BehavioralCommand } from "./behavioral-runner.js";

/** Linux runner boundary: an empty filesystem namespace with system tools,
 * committed checkout, and explicitly selected read-only dependencies. No host
 * home, credentials, sockets, Git metadata, network or writable repository. */
export async function sandboxBehavior(command: BehavioralCommand, checkout: string, argv: string[], reporter?: string) {
  if (process.platform !== "linux") throw new Error("Behavioral verification requires the verified Linux Bubblewrap sandbox");
  const executable = "/usr/bin/bwrap";
  if (!(await lstat(executable)).isFile()) throw new Error("Behavioral verification requires /usr/bin/bwrap");
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", "/etc/hosts", "/etc/hosts",
    "--bind", checkout, checkout, "--chdir", checkout];
  const binary = await realpath(command.executable);
  if (!(await lstat(binary)).isFile()) throw new Error("Behavioral executable must resolve to a regular file");
  args.push("--ro-bind", binary, command.executable);
  for (const path of command.dependencyRoots ?? []) {
    // Only dependency trees can be imported; mounting a project or a home would
    // expose host state and turn this into an ineffective read-only wrapper.
    if (basename(path) !== "node_modules" || await realpath(path) !== resolve(path) || !(await lstat(path)).isDirectory())
      throw new Error("Behavioral dependency roots must be canonical node_modules directories");
    args.push("--ro-bind", path, path);
  }
  if (reporter) {
    args.push("--ro-bind", reporter, reporter);
    try { if ((await lstat(reporter + ".map")).isFile()) args.push("--ro-bind", reporter + ".map", reporter + ".map"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  args.push("--", command.executable, ...argv);
  return { executable, args };
}
