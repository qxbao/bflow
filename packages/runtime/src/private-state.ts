import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";

const uid = () => process.getuid?.();
function exists(path: string): boolean {
  try { fs.lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function directory(path: string): void {
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(path) !== path)
    throw new Error(`Runtime state directories must not be symlinks or special files and must be canonical: ${path}`);
}
function privateDirectory(path: string): void {
  directory(path);
  const stat = fs.lstatSync(path);
  if ((stat.mode & 0o077) !== 0 || (uid() !== undefined && stat.uid !== uid()))
    throw new Error(`Runtime state directory must be owned by the current user and private (0700): ${path}`);
}
function makeDirectory(path: string): void {
  try { fs.mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  directory(path);
}
function privateAncestors(path: string): void {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    makeDirectory(current);
    const stat = fs.lstatSync(current);
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if ((uid() !== undefined && stat.uid !== uid() && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && !stickyRoot))
      throw new Error(`Unsafe Runtime state ancestor; use a private XDG_STATE_HOME on a POSIX filesystem: ${current}`);
  }
}
function supportsPrivateFiles(metadata: string): boolean {
  const probe = fs.mkdtempSync(join(metadata, ".private-state-probe-"));
  let fd: number | undefined;
  try {
    fs.chmodSync(probe, 0o700);
    fd = fs.openSync(join(probe, "private"), "wx", 0o600);
    fs.fchmodSync(fd, 0o600);
    const stat = fs.fstatSync(fd);
    return (stat.mode & 0o777) === 0o600 && (fs.lstatSync(probe).mode & 0o777) === 0o700 &&
      (uid() === undefined || stat.uid === uid());
  } catch (error) {
    if (["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(probe, { recursive: true, force: true });
  }
}
function preserveLegacyAuthority(local: string): void {
  const refuse = () => { throw new Error(`Private Runtime state cannot move automatically: preserve ${local} and reconcile its existing host/run/platform authority before retrying.`); };
  for (const name of ["agentic", "platform"]) if (exists(join(local, name))) refuse();
  const hosts = join(local, "host");
  if (!exists(hosts)) return;
  directory(hosts);
  for (const session of fs.readdirSync(hosts)) {
    const host = join(hosts, session); directory(host);
    // The old implementation can leave these two files before its privacy check
    // fails. Never copy their exposed token into the new private authority.
    for (const name of fs.readdirSync(host)) {
      const path = join(host, name), stat = fs.lstatSync(path);
      if (!["boot.lock", "host.json"].includes(name) || !stat.isFile() || stat.isSymbolicLink()) refuse();
      if (name === "host.json") {
        if (stat.size > 1024 * 1024) refuse();
        let value: unknown;
        try { value = JSON.parse(fs.readFileSync(path, "utf8")); } catch { refuse(); }
        if (value && typeof value === "object" && "socketPath" in value && typeof value.socketPath === "string" && exists(value.socketPath)) refuse();
      }
    }
  }
}

const LocationSchema = z.object({ schemaVersion: z.literal(1), repositoryPath: z.string().min(1),
  repositoryHash: z.string().regex(/^[a-f0-9]{64}$/), directory: z.string().min(1) }).strict();
const HostBindingSchema = z.object({ repositoryPath: z.string(), directory: z.string(), sessionId: z.string() }).passthrough();
function readObject(path: string, privateFile: boolean): unknown {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024 ||
        (privateFile && ((stat.mode & 0o077) !== 0 || (uid() !== undefined && stat.uid !== uid()))))
      throw new Error(`Invalid Runtime state locator or host configuration: ${path}`);
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}
function readPinnedLocation(locator: string, repository: string, repositoryHash: string, local: string): string {
  const pinned = LocationSchema.parse(readObject(locator, false));
  const external = pinned.directory;
  if (pinned.repositoryPath !== repository || pinned.repositoryHash !== repositoryHash || !isAbsolute(external) ||
      resolve(external) !== external || !external.endsWith(`/bflow/repositories/${repositoryHash}/state`))
    throw new Error(`Foreign Runtime state locator; preserve ${locator} and reconcile before retrying`);
  if (!exists(external)) throw new Error(`Missing pinned Runtime authority; preserve ${locator} and reconcile before retrying`);
  preserveLegacyAuthority(local);
  const application = resolve(external, "../../..");
  privateAncestors(resolve(application, ".."));
  for (const path of [application, join(application, "repositories"), resolve(external, ".."), external]) privateDirectory(path);
  const hosts = join(external, "host");
  if (exists(hosts)) {
    privateDirectory(hosts);
    for (const session of fs.readdirSync(hosts)) {
      const host = join(hosts, session); privateDirectory(host);
      const config = join(host, "host.json");
      if (!exists(config)) continue; // Startup may have stopped before creating credentials.
      const binding = HostBindingSchema.parse(readObject(config, true));
      if (binding.repositoryPath !== repository || binding.directory !== host || binding.sessionId !== session)
        throw new Error(`Foreign pinned host authority; preserve ${config} and reconcile before retrying`);
    }
  }
  return external;
}
function pinLocation(locator: string, repository: string, repositoryHash: string, external: string): void {
  const temporary = `${locator}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, repositoryPath: repository, repositoryHash, directory: external })); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    // Hard-link publication is atomic and exclusive: another process cannot see
    // partial JSON or replace an existing location. Verified with NTFS/FUSE.
    try { fs.linkSync(temporary, locator); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { fs.unlinkSync(temporary); }
  const directory = fs.openSync(resolve(locator, ".."), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/**
 * Private host/provider/runtime stores. Lifecycle receipts and P13 manifests keep
 * their existing repository paths. Never uses a symlink or relaxes a privacy check.
 * The external location is deterministic and remains selected once created.
 */
export function resolvePrivateRuntimeStateDirectory(repositoryPath: string): string {
  const repository = fs.realpathSync(repositoryPath);
  const metadata = join(repository, ".bflow"), local = join(metadata, "state");
  makeDirectory(metadata);
  if (exists(local)) directory(local);
  const repositoryHash = createHash("sha256").update(repository).digest("hex");
  const locator = join(local, "private-runtime-state.json");
  if (exists(locator)) return readPinnedLocation(locator, repository, repositoryHash, local);
  const configured = process.env.XDG_STATE_HOME;
  const stateHome = configured && isAbsolute(configured) ? resolve(configured) : join(homedir(), ".local/state");
  const application = join(stateHome, "bflow"), repositories = join(application, "repositories");
  const externalRepository = join(repositories, repositoryHash);
  const external = join(externalRepository, "state");
  if (!exists(external) && supportsPrivateFiles(metadata)) return local;
  preserveLegacyAuthority(local);
  privateAncestors(stateHome);
  for (const path of [application, repositories, externalRepository, external]) {
    makeDirectory(path); privateDirectory(path);
  }
  makeDirectory(local);
  pinLocation(locator, repository, repositoryHash, external);
  return readPinnedLocation(locator, repository, repositoryHash, local);
}
