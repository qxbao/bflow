import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Readable, Writable } from "node:stream";
import { probeBehavioralSandbox } from "./sandbox-readiness.js";
const execute = promisify(execFile);
export const NPM_WARM_RESOLVER = "nameserver 1.1.1.1\noptions timeout:2 attempts:2\n";
export type DependencyWarmResult = { status: "ready"; dependencySource: string } | { status: "unsupported"; reason: string };
const unsupported = (reason: string): DependencyWarmResult => ({ status: "unsupported", reason });
function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid npm manifest or lock record");
  return input as Record<string, unknown>;
}
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
function dependencySpecs(input: Record<string, unknown>): void {
  for (const key of ["workspaces", "overrides", "resolutions", "bundleDependencies", "bundledDependencies"]) if (input[key] !== undefined) throw new Error(`npm ${key} cannot be warmed safely`);
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (input[field] === undefined) continue;
    for (const [name, spec] of Object.entries(record(input[field]))) {
      // Only registry ranges/tags. file:, npm: aliases, git, URLs, paths and workspace: are rejected.
      if (!packageName.test(name) || typeof spec !== "string" || !/^[A-Za-z0-9^~>=<*|+._ -]+$/.test(spec) || !spec.trim()) throw new Error("Non-registry npm dependency specification");
    }
  }
}
function integrity(input: unknown): boolean {
  if (typeof input !== "string") return false;
  return input.split(/\s+/).every(pin => {
    const match = /^(sha512|sha384|sha256)-([A-Za-z0-9+/]+={0,2})$/.exec(pin);
    if (!match) return false;
    const data = Buffer.from(match[2]!, "base64"), length = new Map([["sha512", 64], ["sha384", 48], ["sha256", 32]]).get(match[1]!);
    return data.length === length && data.toString("base64") === match[2];
  });
}
function lockedEntry(input: unknown, legacyEntry = false): void {
  const entry = record(input); dependencySpecs(legacyEntry ? { ...entry, dependencies: undefined } : entry);
  if (entry.link !== undefined && entry.link !== false || entry.hasShrinkwrap === true || entry.inBundle === true || typeof entry.version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(entry.version) || !integrity(entry.integrity)) throw new Error("npm lock entry needs a registry version and strong integrity pin");
  if (typeof entry.resolved !== "string") throw new Error("npm lock entry lacks resolved URL");
  const url = new URL(entry.resolved);
  if (url.protocol !== "https:" || url.hostname !== "registry.npmjs.org" || url.port || url.username || url.password || url.search || url.hash || !/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved) || !url.pathname.endsWith(".tgz") || /%(?:2f|5c|00)/i.test(url.pathname)) throw new Error("npm warming requires public registry.npmjs.org HTTPS tarballs");
}
/** Validate every source that npm may resolve, including npm v2's legacy dependency tree. No lifecycle code is run. */
export function validateNpmWarmManifests(manifestInput: unknown, lockInput: unknown): void {
  const manifest = record(manifestInput), lock = record(lockInput); dependencySpecs(manifest);
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) throw new Error("npm warming requires a v2/v3 package-lock.json");
  const packages = record(lock.packages); dependencySpecs(record(packages[""]));
  if (Object.keys(packages).length > 50_000) throw new Error("npm lock package count exceeds bound");
  const pathPattern = /^(?:node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:\/node_modules\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)*$/;
  for (const [path, entry] of Object.entries(packages)) {
    if (path === "") continue;
    if (!pathPattern.test(path)) throw new Error("Unsafe npm lock package path");
    lockedEntry(entry);
  }
  let count = 0;
  const legacy = (input: unknown, depth = 0): void => {
    if (depth > 64) throw new Error("npm legacy dependency depth exceeds bound");
    for (const [name, raw] of Object.entries(record(input))) {
      if (!packageName.test(name) || ++count > 50_000) throw new Error("Unsafe npm legacy dependency record");
      lockedEntry(raw, true); const entry = record(raw);
      if (entry.requires !== undefined) dependencySpecs({ dependencies: entry.requires });
      if (entry.dependencies !== undefined) legacy(entry.dependencies, depth + 1);
    }
  };
  if (lock.dependencies !== undefined) legacy(lock.dependencies);
}

export interface NpmWarmInvocation { executable: string; args: string[]; env: Record<string, string> }
/** Separate unshared network namespace. A capability-probed slirp4netns helper supplies egress only after readiness.
 * The host loopback and DNS proxy are disabled; a Runtime-owned resolver uses fixed public DNS (1.1.1.1).
 * No checkout, host home, credential config or sockets are mounted. Only the owned cache is host-writable.
 * /tmp is anonymous sandbox memory. npm and Node are trusted installed tools, dependencies never execute. */
export function npmWarmInvocation(cacheRoot: string, sandboxExecutable: string, nodeBinary: string, npmRoot: string): NpmWarmInvocation {
  for (const path of [cacheRoot, sandboxExecutable, nodeBinary, npmRoot]) if (!isAbsolute(path) || path.includes("\0") || resolve(path) !== path) throw new Error("Npm warming paths must be canonical absolute paths");
  const home = resolve(homedir());
  if (basename(npmRoot) !== "npm" || npmRoot === home || home.startsWith(npmRoot + "/") || /(^|\/)(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.config)(?:\/|$)/.test(npmRoot)) throw new Error("Npm toolchain mount must be a narrow installed npm distribution");
  return {
    executable: sandboxExecutable,
    args: ["--unshare-all", "--info-fd", "3", "--block-fd", "4", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home",
      "--ro-bind", join(cacheRoot, "resolv.conf"), "/etc/resolv.conf", "--ro-bind", "/etc/ssl/certs", "/etc/ssl/certs",
      "--ro-bind", nodeBinary, "/runtime/bin/node", "--ro-bind", npmRoot, "/runtime/npm",
      "--bind", cacheRoot, "/cache", "--ro-bind", join(cacheRoot, "package.json"), "/cache/package.json", "--ro-bind", join(cacheRoot, "package-lock.json"), "/cache/package-lock.json",
      "--chdir", "/cache", "--", "/runtime/bin/node", "/runtime/npm/bin/npm-cli.js",
      "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--no-progress", "--registry=https://registry.npmjs.org", "--cache=/cache/npm-cache"],
    env: { PATH: "/runtime/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/tmp/home", TMPDIR: "/tmp",
      NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_GLOBALCONFIG: "/dev/null", NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_LOGLEVEL: "error" }
  };
}
async function readManifest(root: string, name: string): Promise<string> {
  const path = join(root, name);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4_194_304 || await realpath(path) !== path) throw new Error("npm manifests must be bounded regular non-symlink files");
    const bytes = await handle.readFile();
    if (bytes.length > 4_194_304) throw new Error("npm manifest grew beyond its bound");
    return bytes.toString("utf8");
  } finally { await handle.close(); }
}
async function findNpm(): Promise<{ node: string; npmRoot: string }> {
  const node = await realpath(process.execPath);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const cli = await realpath(join(directory, "npm")); await access(cli, constants.X_OK);
      const npmRoot = dirname(dirname(cli));
      if (basename(npmRoot) !== "npm" || npmRoot === resolve(homedir()) || cli !== join(npmRoot, "bin", "npm-cli.js") || record(JSON.parse(await readFile(join(npmRoot, "package.json"), "utf8"))).name !== "npm" || await realpath(npmRoot) !== npmRoot) continue;
      const version = await execute(node, [cli, "--version"], { cwd: "/", env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_GLOBALCONFIG: "/dev/null" }, timeout: 5000, maxBuffer: 4096 });
      if (/^(?:[7-9]|[1-9]\d+)\.\d+\.\d+\s*$/.test(version.stdout)) return { node, npmRoot };
    } catch { /* Keep searching narrow installed npm locations. */ }
  }
  throw new Error("No supported installed npm CLI is available for isolated dependency warming");
}
/** Safe warming is intentionally restricted to public, fully integrity-pinned npm v2/v3 locks.
 * Other ecosystems can execute resolution/download hooks or require mutable build code; they remain unsupported. */
export async function warmNpmDependencies(root: string): Promise<DependencyWarmResult> {
  let cache: string | undefined;
  try {
    if (await realpath(root) !== resolve(root)) return unsupported("Dependency warming requires a canonical repository root");
    const [manifestText, lockText] = await Promise.all([readManifest(root, "package.json"), readManifest(root, "package-lock.json")]);
    validateNpmWarmManifests(JSON.parse(manifestText), JSON.parse(lockText));
    const readiness = await probeBehavioralSandbox();
    if (readiness.status !== "ready") return unsupported(readiness.reason);
    const network = await probeNpmWarmNetwork();
    if (network.status !== "ready") return unsupported(network.reason);
    const tools = await findNpm();
    cache = await realpath(await mkdtemp(join(tmpdir(), "bflow-npm-warm-")));
    await Promise.all([writeFile(join(cache, "package.json"), manifestText, { mode: 0o600 }), writeFile(join(cache, "package-lock.json"), lockText, { mode: 0o600 }), writeFile(join(cache, "resolv.conf"), NPM_WARM_RESOLVER, { mode: 0o600 })]);
    const invocation = npmWarmInvocation(cache, readiness.executable, tools.node, tools.npmRoot);
    await runNpmWarmSandbox(invocation, network.executable, cache);
    if (await readFile(join(cache, "package.json"), "utf8") !== manifestText || await readFile(join(cache, "package-lock.json"), "utf8") !== lockText) throw new Error("Dependency warming changed frozen manifests");
    await mkdir(join(cache, "node_modules"), { recursive: true });
    if (!(await lstat(join(cache, "node_modules"))).isDirectory() || await realpath(join(cache, "node_modules")) !== join(cache, "node_modules")) throw new Error("Unsafe warmed dependency tree");
    const dependencySource = cache; cache = undefined;
    return { status: "ready", dependencySource };
  } catch {
    // Do not expose npm output: URLs/package metadata can carry credential-like text supplied by a repository.
    return unsupported("Automatic npm dependency warming is unavailable for this repository or isolated host");
  } finally { if (cache) await rm(cache, { recursive: true, force: true }).catch(() => undefined); }
}

const helperEnvironment = () => ({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", HOME: "/nonexistent" });
export type WarmNetworkReadiness = { status: "ready"; executable: string } | { status: "unsupported"; reason: string };
/** Probe installed behavior/capabilities rather than assuming a release label guarantees the required flags.
 * Official CLI: https://github.com/rootless-containers/slirp4netns/blob/master/slirp4netns.1.md
 * --disable-dns is mandatory: the default DNS proxy can expose host loopback despite --disable-host-loopback. */
export async function probeNpmWarmNetwork(): Promise<WarmNetworkReadiness> {
  if (process.platform !== "linux") return { status: "unsupported", reason: "Isolated dependency networking is only supported on Linux" };
  for (const directory of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const executable = await realpath(join(directory, "slirp4netns")); await access(executable, constants.X_OK);
      if (!(await lstat(executable)).isFile()) continue;
      const [version, help] = await Promise.all([
        execute(executable, ["--version"], { cwd: "/", env: helperEnvironment(), timeout: 5000, maxBuffer: 16384 }),
        execute(executable, ["--help"], { cwd: "/", env: helperEnvironment(), timeout: 5000, maxBuffer: 16384 })
      ]);
      if (!/^slirp4netns version \d+\.\d+\.\d+/m.test(version.stdout)) continue;
      const flags = ["--configure", "--disable-host-loopback", "--disable-dns", "--ready-fd", "--exit-fd", "--userns-path"];
      if (flags.every(flag => help.stdout.includes(flag))) return { status: "ready", executable };
    } catch { /* Missing, failed or incompatible helpers never trigger a host-network fallback. */ }
  }
  return { status: "unsupported", reason: "No verified slirp4netns helper with host-loopback and DNS-proxy isolation is available" };
}
export function slirpWarmInvocation(executable: string, childPid: number): NpmWarmInvocation {
  if (!isAbsolute(executable) || executable.includes("\0") || !Number.isSafeInteger(childPid) || childPid < 2) throw new Error("Invalid warming network helper identity");
  return { executable, args: ["--configure", "--disable-host-loopback", "--disable-dns", "--ready-fd=3", "--exit-fd=4", `--userns-path=/proc/${childPid}/ns/user`, String(childPid), "tap0"], env: helperEnvironment() };
}
/** Bounded documented --info-fd payload. Namespace identifiers are diagnostics; only the real child PID is used. */
export function parseWarmChildPid(input: string): number {
  if (Buffer.byteLength(input) > 4096) throw new Error("Oversized warming namespace handshake");
  const childPid = record(JSON.parse(input))["child-pid"];
  if (!Number.isSafeInteger(childPid) || Number(childPid) < 2) throw new Error("Malformed warming namespace handshake");
  return Number(childPid);
}
function fdStream(child: ChildProcess, fd: number): Readable & Writable {
  const stream = child.stdio[fd];
  if (!stream || !("on" in stream) || !("write" in stream)) throw new Error("Missing warming supervision pipe");
  return stream as Readable & Writable;
}
function stopProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
  try { child.kill("SIGKILL"); } catch { /* Already exited. */ }
}
/** Supervise both process trees. bwrap stays blocked until the helper's actual byte '1' readiness signal.
 * --unshare-all keeps host abstract Unix sockets outside the guest network namespace. No host resolver is mounted.
 * This is public egress, not a registry domain firewall or protection from services on host LAN/public addresses. */
export async function runNpmWarmSandbox(invocation: NpmWarmInvocation, helperExecutable: string, cwd: string, timeoutMs = 120_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000 || invocation.args.includes("--share-net") || !invocation.args.includes("--unshare-all")) throw new Error("Unsafe warming supervision policy");
  let fail!: (reason: Error) => void;
  const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
  // An observed rejection never becomes unhandled while the next bootstrap stage is being attached.
  void failure.catch(() => undefined);
  const timer = setTimeout(() => fail(new Error("Dependency warming deadline exceeded")), timeoutMs);
  let sandbox: ChildProcess | undefined, helper: ChildProcess | undefined;
  const children: { child: ChildProcess; closed: Promise<void> }[] = [];
  let outputBytes = 0;
  const start = (plan: NpmWarmInvocation): ChildProcess => {
    const child = spawn(plan.executable, plan.args, { cwd, env: plan.env, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    const closed = new Promise<void>(resolveClosed => { child.once("close", () => resolveClosed()); });
    children.push({ child, closed });
    child.once("error", () => fail(new Error("Dependency warming process could not start")));
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 1_048_576) fail(new Error("Dependency warming output limit exceeded"));
    });
    // FD4 is parent-controlled and never accepts input. Handle EPIPE as a bootstrap failure.
    fdStream(child, 4).on("error", () => fail(new Error("Dependency warming control pipe failed")));
    return child;
  };
  const readHandshake = (child: ChildProcess, fd: number, limit: number): Promise<Buffer> => {
    return new Promise((resolveRead, rejectRead) => {
      const stream = fdStream(child, fd), chunks: Buffer[] = []; let length = 0;
      stream.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > limit) { rejectRead(new Error("Dependency warming handshake exceeds bound")); stream.destroy(); }
        else chunks.push(Buffer.from(chunk));
      });
      stream.once("error", () => rejectRead(new Error("Dependency warming handshake failed")));
      stream.once("end", () => resolveRead(Buffer.concat(chunks)));
    });
  };
  try {
    sandbox = start(invocation);
    const sandboxDone = new Promise<void>((resolveDone, rejectDone) => {
      sandbox!.once("close", (code, signal) => code === 0 && signal === null ? resolveDone() : rejectDone(new Error("Isolated npm dependency warming failed")));
    });
    // Early exit, including a false zero-exit bootstrap, must not unblock an incomplete handshake.
    void sandboxDone.catch(() => undefined);
    const prematureExit = sandboxDone.then(() => { throw new Error("Warming sandbox exited before bootstrap completed"); });
    void prematureExit.catch(() => undefined);
    const info = await Promise.race([readHandshake(sandbox, 3, 4096), prematureExit, failure]);
    const childPid = parseWarmChildPid(info.toString("utf8"));
    // Namespace creation can precede uid-map initialization. Do not ask slirp to enter an unmapped user namespace.
    const mapDeadline = Date.now() + Math.min(5000, timeoutMs);
    while (!(await readFile(`/proc/${childPid}/uid_map`, "utf8")).trim()) {
      if (Date.now() >= mapDeadline) throw new Error("Warming user namespace did not become ready");
      await Promise.race([new Promise(resolveWait => setTimeout(resolveWait, 10)), prematureExit, failure]);
    }
    helper = start(slirpWarmInvocation(helperExecutable, childPid));
    const helperExit = new Promise<never>((_resolve, reject) => { helper!.once("close", () => reject(new Error("Warming network helper exited before npm completed"))); });
    void helperExit.catch(() => undefined);
    const ready = await Promise.race([readHandshake(helper, 3, 1), helperExit, prematureExit, failure]);
    if (ready.toString("ascii") !== "1") throw new Error("Warming network helper did not attest readiness");
    fdStream(sandbox, 4).end("1");
    await Promise.race([sandboxDone, helperExit, failure]);
  } finally {
    clearTimeout(timer);
    // Terminate bwrap first: --die-with-parent and the PID namespace kill its guest process tree.
    if (sandbox) stopProcessTree(sandbox);
    if (helper) stopProcessTree(helper);
    for (const { child } of children) { try { fdStream(child, 4).destroy(); } catch { /* No pipe after failed spawn. */ } }
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(children.map(child => child.closed)), new Promise(resolveCleanup => { cleanupTimer = setTimeout(resolveCleanup, 3000); })]);
    if (cleanupTimer) clearTimeout(cleanupTimer);
  }
}
