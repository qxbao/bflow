import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { probeBehavioralSandbox } from "./sandbox-readiness.js";
import type { RunnerMount } from "./runner-adapter.js";
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
  // A dependency-free checkout (no node_modules roots) has nothing to mount.
  if (roots?.length === 0) return [];
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
  const readiness = await probeBehavioralSandbox();
  if (readiness.status !== "ready") throw new Error(readiness.code + ": " + readiness.reason);
  const executable = readiness.executable;
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", "/etc/hosts", "/etc/hosts",
    "--dir", "/tmp/bflow-home", "--bind", checkout, checkout, "--chdir", command.adapter && command.adapter.projectDirectory !== "." ? join(checkout, command.adapter.projectDirectory) : checkout];
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
  for (const mount of command.adapter?.mounts ?? []) {
    await validateRunnerMount(mount, checkout);
    const target = command.dependencySource && mount.target.startsWith(command.dependencySource + "/") ? join(checkout, mount.target.slice(command.dependencySource.length + 1)) : mount.target;
    if (target.startsWith(checkout + "/")) {
      let current = checkout;
      for (const part of target.slice(checkout.length + 1).split("/")) {
        current = join(current, part);
        try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Toolchain mountpoint traverses a checkout symlink"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    args.push("--ro-bind", mount.source, target);
  }
  if (command.reportDirectory) {
    args.push("--bind", command.reportDirectory, command.reportDirectory);
    for (const helper of command.adapter?.helpers ?? []) args.push("--ro-bind", join(command.reportDirectory, helper.name), join(command.reportDirectory, helper.name));
  }
  if (reporter) {
    args.push("--ro-bind", reporter, reporter);
    try { if ((await lstat(reporter + ".map")).isFile()) args.push("--ro-bind", reporter + ".map", reporter + ".map"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const sandboxExecutable = command.adapter && command.dependencySource && command.executable.startsWith(command.dependencySource + "/") ? join(checkout, command.executable.slice(command.dependencySource.length + 1)) : command.executable;
  if (sandboxExecutable !== command.executable) args.push("--ro-bind", binary, sandboxExecutable);
  args.push("--", sandboxExecutable, ...argv);
  return { executable, args };
}

/** A mount is a narrowly selected canonical toolchain/cache, never a home, secret tree or namespace override. */
export async function validateRunnerMount(mount: RunnerMount, checkout: string): Promise<void> {
  const secret = /(^|\/)(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.config|\.npmrc|\.netrc|settings\.xml|credentials(?:\.toml)?)(?:\/|$)/;
  const home = await realpath(homedir());
  if (![mount.source, mount.target].every(path => isAbsolute(path) && !path.includes("\0") && !path.split("/").some(part => part === "." || part === "..")) ||
      ["/", "/usr", "/etc", "/proc", "/dev", "/run", "/tmp", "/home", home].includes(mount.source) || home.startsWith(mount.source + "/") ||
      secret.test(mount.source) || secret.test(mount.target) || mount.target === checkout || checkout.startsWith(mount.target + "/") ||
      ["/", "/usr", "/bin", "/lib", "/lib64", "/etc", "/proc", "/dev", "/run", "/tmp"].includes(mount.target) ||
      await realpath(mount.source) !== resolve(mount.source)) throw new Error("Unsafe toolchain/cache mount");
  const info = await lstat(mount.source);
  if (!info.isFile() && !info.isDirectory()) throw new Error("Toolchain/cache mount must be a regular file or directory");
  if (info.isDirectory()) {
    const pending = [mount.source]; let count = 0;
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++count > 100000) throw new Error("Toolchain/cache inspection exceeds bounds");
        const path = join(directory, entry.name);
        if (secret.test(path) || /^(?:auth\.json|token|tokens|passwords|id_rsa|id_ed25519)$/.test(entry.name)) throw new Error("Credential material in toolchain/cache mount");
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isSymbolicLink()) {
          const real = await realpath(path).catch(() => "");
          if (real && !real.startsWith(mount.source + "/") && !real.startsWith("/usr/")) throw new Error("Toolchain/cache symlink escapes selected tree");
        } else if (!entry.isFile()) throw new Error("Special file in toolchain/cache mount");
        if (entry.isFile() && entry.name === "config" && path.includes("/.git/")) {
          const text = await readFile(path, "utf8");
          if (/[a-z]+:\/\/[^/\s]+@|credential|extraheader/i.test(text)) throw new Error("Credentials in dependency cache configuration");
        }
      }
    }
  }
}
