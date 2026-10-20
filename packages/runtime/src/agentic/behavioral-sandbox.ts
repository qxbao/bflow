import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { BoundBehavioralCommand } from "./behavioral-runner.js";

/** Repository-relative POSIX path without absolute, backslash, colon, empty, "." or ".." segments. */
export function assertSafeRelativePath(path: string, name: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.includes(":") || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error(`Unsafe ${name}: ${path}`);
}
/** A checkout dependency root names a dependency tree (`node_modules`) at the same relative path inside the checkout. */
export function assertCheckoutDependencyRoot(path: string): void {
  assertSafeRelativePath(path, "checkout dependency root");
  if (basename(path) !== "node_modules") throw new Error("Checkout dependency roots must be node_modules directories");
}
/** Creates each mountpoint without following committed symlinks in the checkout, then returns [source, target] read-only binds. */
async function checkoutDependencyMounts(command: BoundBehavioralCommand, checkout: string): Promise<[string, string][]> {
  const roots = command.checkoutDependencyRoots, source = command.dependencySource;
  if (roots === undefined && source === undefined) return [];
  if (!roots?.length || source === undefined || !isAbsolute(source) || await realpath(source) !== resolve(source))
    throw new Error("Behavioral checkout dependencies require a canonical dependency source and node_modules roots");
  const realCheckout = await realpath(checkout), mounts: [string, string][] = [];
  for (const rel of roots) {
    assertCheckoutDependencyRoot(rel);
    const from = join(source, rel), info = await lstat(from);
    if (!info.isDirectory() || await realpath(from) !== from) throw new Error("Behavioral checkout dependency source must be a real node_modules directory");
    let current = checkout;
    for (const part of rel.split("/")) {
      current = join(current, part);
      try { if (!(await lstat(current)).isDirectory()) throw new Error("Behavioral checkout dependency mountpoint is not a directory"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(current); }
    }
    if (await realpath(current) !== join(realCheckout, rel)) throw new Error("Behavioral checkout dependency mountpoint escapes the checkout");
    mounts.push([from, join(checkout, rel)]);
  }
  return mounts;
}

/** Linux runner boundary: an empty filesystem namespace with system tools,
 * committed checkout, and explicitly selected read-only dependencies. No host
 * home, credentials, sockets, Git metadata, network or writable repository.
 * `argv` selects the invocation (tests, or a profile's prepare step); the same executable runs both. */
export async function sandboxBehavior(command: BoundBehavioralCommand, checkout: string, argv: string[], reporter?: string) {
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
  // Runtime-detected dependencies keep their repository-relative layout (pnpm relative symlinks resolve inside the checkout).
  for (const [from, to] of await checkoutDependencyMounts(command, checkout)) args.push("--ro-bind", from, to);
  if (reporter) {
    args.push("--ro-bind", reporter, reporter);
    try { if ((await lstat(reporter + ".map")).isFile()) args.push("--ro-bind", reporter + ".map", reporter + ".map"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  args.push("--", command.executable, ...argv);
  return { executable, args };
}
