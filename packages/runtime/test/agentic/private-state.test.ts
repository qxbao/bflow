import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePrivateRuntimeStateDirectory } from "../../src/private-state.js";

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const action of cleanup.splice(0).reverse()) action(); });
function fixture() {
  const root = fs.mkdtempSync("/tmp/bflow-private-state-");
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const repository = join(root, "repository"), stateHome = join(root, "user-state");
  fs.mkdirSync(repository); fs.mkdirSync(stateHome, { mode: 0o700 });
  vi.stubEnv("XDG_STATE_HOME", stateHome);
  const external = join(stateHome, "bflow", "repositories", createHash("sha256").update(repository).digest("hex"), "state");
  return { root, repository, stateHome, external };
}
function emulateNonPosixMount(repository: string) {
  const observe = fs.fstatSync;
  vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, ...args: unknown[]) => {
    const stat = Reflect.apply(observe, fs, [fd, ...args]);
    const path = fs.readlinkSync(`/proc/self/fd/${fd}`);
    return path.startsWith(repository + "/.bflow/.private-state-probe-") ? Object.assign(stat, { mode: 0o100777 }) : stat;
  }) as typeof fs.fstatSync);
}

describe.skipIf(process.platform !== "linux")("private Runtime state placement", () => {
  it("keeps existing POSIX repository state in place", () => {
    const f = fixture();
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(join(f.repository, ".bflow/state"));
    expect(fs.existsSync(f.external)).toBe(false);
  });
  it("uses a private repository-scoped user directory when chmod cannot enforce 0600", () => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
    expect(fs.statSync(f.external).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(join(f.repository, ".bflow")).some(name => name.startsWith(".private-state-probe-"))).toBe(false);
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
    const other = join(f.root, "other"); fs.mkdirSync(other); emulateNonPosixMount(other);
    expect(resolvePrivateRuntimeStateDirectory(other)).not.toBe(f.external);
  });
  it("falls back when the filesystem explicitly rejects chmod", () => {
    const f = fixture();
    vi.spyOn(fs, "fchmodSync").mockImplementation(() => { throw Object.assign(new Error("chmod unsupported"), { code: "ENOTSUP" }); });
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
  });
  it("keeps using external state after repository permission support changes", () => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
    vi.restoreAllMocks();
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
  });
  it("pins recovery authority across XDG_STATE_HOME changes", () => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
    fs.writeFileSync(join(f.external, "pending-work"), "unknown_delivery");
    const otherHome = join(f.root, "other-user-state");
    vi.stubEnv("XDG_STATE_HOME", otherHome);
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
    expect(fs.existsSync(otherHome)).toBe(false);
  });
  it("refuses to recreate a missing pinned authority", () => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
    fs.rmSync(f.external, { recursive: true });
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow(/preserve.*reconcile|missing.*authority/i);
    expect(fs.existsSync(f.external)).toBe(false);
  });
  it("rejects a corrupt or foreign locator instead of selecting a fresh authority", () => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
    const locator = join(f.repository, ".bflow/state/private-runtime-state.json");
    const original = JSON.parse(fs.readFileSync(locator, "utf8"));
    fs.writeFileSync(locator, JSON.stringify({ ...original, repositoryPath: "/another-repository" }));
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow(/foreign.*locator/i);
    fs.writeFileSync(locator, "{truncated");
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow();
  });
  it("rejects a pinned host config bound to a different repository", () => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
    const host = join(f.external, "host/session-1"); fs.mkdirSync(host, { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(host, "host.json"), JSON.stringify({ repositoryPath: "/another", directory: host, sessionId: "session-1" }), { mode: 0o600 });
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow(/foreign.*authority/i);
  });
  it("publishes one location when processes with different XDG homes race", async () => {
    const f = fixture(), otherHome = join(f.root, "other-user-state");
    fs.mkdirSync(f.external, { recursive: true, mode: 0o700 });
    const otherExternal = f.external.replace(f.stateHome, otherHome);
    fs.mkdirSync(otherExternal, { recursive: true, mode: 0o700 });
    const module = new URL("../../dist/private-state.js", import.meta.url).href;
    const script = `import { resolvePrivateRuntimeStateDirectory as locate } from ${JSON.stringify(module)}; console.log(locate(process.argv[1]));`;
    const results = await Promise.all([f.stateHome, otherHome, f.stateHome, otherHome].map(stateHome =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, f.repository], { env: { ...process.env, XDG_STATE_HOME: stateHome } })));
    const locations = results.map(result => result.stdout.trim());
    expect(new Set(locations).size).toBe(1);
    expect([f.external, otherExternal]).toContain(locations[0]);
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(locations[0]);
  });
  it("preserves an unstarted legacy config without reusing its exposed token", () => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    const legacy = join(f.repository, ".bflow/state/host/session-1");
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(join(legacy, "host.json"), '{"token":"exposed-old-token"}');
    fs.writeFileSync(join(legacy, "boot.lock"), "");
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
    expect(fs.readFileSync(join(legacy, "host.json"), "utf8")).toContain("exposed-old-token");
    expect(fs.existsSync(join(f.external, "host"))).toBe(false);
  });
  it.each(["host/session-1/owner.json", "agentic/journal/state.json", "platform/session-1/platform-launches.json"])("blocks split recovery authority when legacy %s exists", relative => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    const path = join(f.repository, ".bflow/state", relative);
    fs.mkdirSync(join(path, ".."), { recursive: true }); fs.writeFileSync(path, "{}");
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow(/preserve.*reconcile/i);
    expect(fs.readFileSync(path, "utf8")).toBe("{}");
  });
  it("rejects a symlinked repository metadata directory", () => {
    const f = fixture(); fs.symlinkSync(f.stateHome, join(f.repository, ".bflow"));
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow(/symlink|canonical/i);
    expect(fs.readdirSync(f.stateHome)).toEqual([]);
  });
  it("rejects a symlinked lifecycle state directory instead of bypassing it", () => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    fs.mkdirSync(join(f.repository, ".bflow"));
    fs.symlinkSync(f.stateHome, join(f.repository, ".bflow/state"));
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow(/symlink|canonical/i);
  });
  it("preserves a legacy config whose endpoint still exists", () => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    const legacy = join(f.repository, ".bflow/state/host/session-1");
    fs.mkdirSync(legacy, { recursive: true });
    const endpoint = join(f.root, "existing.sock"); fs.writeFileSync(endpoint, "");
    fs.writeFileSync(join(legacy, "host.json"), JSON.stringify({ socketPath: endpoint }));
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow(/preserve.*reconcile/i);
    expect(fs.existsSync(endpoint)).toBe(true);
  });
  it.each(["missing private config", "foreign repository", "foreign directory", "foreign session", "different socket", "reused token"])("preserves the endpoint guard for %s", mismatch => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    expect(resolvePrivateRuntimeStateDirectory(f.repository)).toBe(f.external);
    const socketPath = join(f.root, "existing.sock"); fs.writeFileSync(socketPath, "");
    const privateHost = join(f.external, "host/session-1");
    fs.mkdirSync(privateHost, { recursive: true, mode: 0o700 });
    if (mismatch !== "missing private config") fs.writeFileSync(join(privateHost, "host.json"), JSON.stringify({
      repositoryPath: f.repository, sessionId: "session-1", directory: privateHost,
      socketPath: mismatch === "different socket" ? join(f.root, "other.sock") : socketPath, token: "private-token"
    }), { mode: 0o600 });
    const legacyHost = join(f.repository, ".bflow/state/host/session-1"); fs.mkdirSync(legacyHost, { recursive: true });
    const legacy = JSON.stringify({ repositoryPath: mismatch === "foreign repository" ? "/foreign" : f.repository,
      sessionId: mismatch === "foreign session" ? "other-session" : "session-1",
      directory: mismatch === "foreign directory" ? "/foreign" : legacyHost, socketPath,
      token: mismatch === "reused token" ? "private-token" : "unused-old-token" });
    fs.writeFileSync(join(legacyHost, "host.json"), legacy);
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow(/preserve.*reconcile/i);
    expect(fs.readFileSync(join(legacyHost, "host.json"), "utf8")).toBe(legacy);
  });
  it("rejects symlinked and publicly writable external storage", () => {
    const f = fixture(); emulateNonPosixMount(f.repository);
    fs.symlinkSync(f.repository, join(f.stateHome, "bflow"));
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow(/symlink|canonical/i);
    fs.unlinkSync(join(f.stateHome, "bflow"));
    fs.mkdirSync(join(f.stateHome, "bflow"), { mode: 0o755 });
    expect(() => resolvePrivateRuntimeStateDirectory(f.repository)).toThrow(/private|0700/i);
    expect(fs.statSync(join(f.stateHome, "bflow")).mode & 0o777).toBe(0o755);
  });
});
