import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    lstat: vi.fn(actual.lstat)
  };
});

import {
  MachineSetupService,
  NonInteractiveApprover,
  PathComponent,
  SetupStateStore,
  ToolInstallerRegistry,
  defaultMachineConfig,
  digest,
  type CommandRunner,
  type HostEnvironment,
  type PlatformProfile
} from "../src/index.js";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const uid = typeof process.getuid === "function" ? process.getuid() : null;
const gid = typeof process.getgid === "function" ? process.getgid() : null;

let root: string;
let home: string;
let syncErrorCode: string | null = null;
const spawnedChildren: ChildProcess[] = [];

beforeEach(async () => {
  syncErrorCode = null;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  root = await actual.realpath(await actual.mkdtemp(path.join(os.tmpdir(), "bflow-r2s1-ms-")));
  home = path.join(root, "home");
  await actual.mkdir(home, { recursive: true });

  vi.mocked(fsPromises.lstat).mockImplementation(actual.lstat);
  vi.mocked(fsPromises.open).mockImplementation((async (pathLike, flags, mode) => {
    const handle = await actual.open(pathLike, flags, mode);
    if (syncErrorCode !== null) {
      const code = syncErrorCode;
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === "sync") {
            return async () => {
              throw Object.assign(new Error(`${code}: fsync unsupported on FUSE/NTFS`), { code });
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
    return handle;
  }) as typeof fsPromises.open);
});

afterEach(async () => {
  for (const child of spawnedChildren.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await actual.rm(root, { recursive: true, force: true });
});

function makePaths(base = root) {
  return {
    config: path.join(base, "config"),
    data: path.join(base, "data"),
    state: path.join(base, "state"),
    managedBin: path.join(home, ".local", "bin")
  };
}

describe("Round 2 Slice 1 — SetupStateStore FUSE/NTFS fsync, Stale Lock Recovery & NTFS Launcher Mode", () => {
  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM", "EACCES", "EBADF", "EISDIR", "EROFS"])(
    "tolerates FUSE/NTFS FileHandle.sync() %s across writeFileAtomic, appendReceipt, appendChange, and acquireLock",
    async (code) => {
      syncErrorCode = code;
      const paths = makePaths(path.join(root, `sync-${code}`));
      const store = new SetupStateStore(paths, { uid, now: () => NOW });

      const lockRes = await store.acquireLock();
      expect(lockRes.ok).toBe(true);
      if (lockRes.ok) await lockRes.value.release();

      const atomicRes = await store.writeFileAtomic(path.join(paths.config, "machine.json"), '{"ok":true}\n');
      expect(atomicRes.ok).toBe(true);
      expect(await readFile(path.join(paths.config, "machine.json"), "utf8")).toBe('{"ok":true}\n');

      const d = digest("step");
      const receiptRes = await store.appendReceipt({
        schemaVersion: 3,
        receiptId: "r-fuse",
        planId: "p-fuse",
        planDigest: d,
        stepId: "s-fuse",
        scope: { kind: "machine", machineId: "m-1" },
        status: "applied",
        desiredStateDigest: d,
        observedStateDigest: d,
        ownedPaths: [path.join(paths.config, "machine.json")],
        observedAt: NOW.toISOString(),
        diagnostics: [],
        idempotencyKey: "k-fuse"
      });
      expect(receiptRes.ok).toBe(true);

      const changeRes = await store.appendChange({
        at: NOW.toISOString(),
        planId: "p-fuse",
        stepId: "s-fuse",
        kind: "write_file",
        target: path.join(paths.config, "machine.json"),
        machineWide: false
      });
      expect(changeRes.ok).toBe(true);
    }
  );

  it("still fails closed on genuine I/O failures (EIO) during FileHandle.sync()", async () => {
    syncErrorCode = "EIO";
    const paths = makePaths(path.join(root, "sync-eio"));
    const store = new SetupStateStore(paths, { uid, now: () => NOW });

    const atomicRes = await store.writeFileAtomic(path.join(paths.config, "machine.json"), '{"ok":true}\n');
    expect(atomicRes.ok).toBe(false);
  });

  it("recovers aged 0-byte/corrupt crash setup.lock files while preserving fresh in-flight 0-byte locks", async () => {
    const paths = makePaths();
    const store = new SetupStateStore(paths, { uid, now: () => NOW });
    const prep = await store.ensurePrivateDir(paths.state);
    expect(prep.ok).toBe(true);
    const lockFile = path.join(paths.state, "setup.lock");

    // Fresh 0-byte lock (<1s old, another process mid-write) MUST NOT be stolen
    await writeFile(lockFile, "", { mode: 0o600 });
    const freshConflict = await store.acquireLock();
    expect(freshConflict.ok).toBe(false);
    if (!freshConflict.ok) expect(freshConflict.error.code).toBe("conflict");

    // Aged 0-byte or truncated lock (>15s old, crashed before writing JSON) MUST be reclaimed
    const past = new Date(Date.now() - 20_000);
    await utimes(lockFile, past, past);
    const reclaimed = await store.acquireLock();
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) {
      expect(JSON.parse(await readFile(lockFile, "utf8")).pid).toBe(process.pid);
      await reclaimed.value.release();
    }
  });

  it.skipIf(process.platform !== "linux")(
    "reclaims setup.lock when the recorded PID wrapped around to an unrelated non-Node OS process",
    async () => {
      const sleeper = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" });
      spawnedChildren.push(sleeper);
      expect(sleeper.pid).toBeDefined();

      const paths = makePaths();
      const store = new SetupStateStore(paths, { uid, now: () => NOW });
      await store.ensurePrivateDir(paths.state);
      const lockFile = path.join(paths.state, "setup.lock");
      await writeFile(
        lockFile,
        JSON.stringify({ pid: sleeper.pid, hostname: os.hostname(), startedAt: "2026-01-01T00:00:00.000Z" }),
        { mode: 0o600 }
      );

      const reclaimed = await store.acquireLock();
      expect(reclaimed.ok).toBe(true);
      if (reclaimed.ok) {
        expect(JSON.parse(await readFile(lockFile, "utf8")).pid).toBe(process.pid);
        await reclaimed.value.release();
      }
    }
  );

  it("satisfies PathComponent post-apply read-back when managedBin resides on NTFS/FUSE (sticky 0777 mode) while still repairing 0644 on POSIX", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const ntfsBin = path.join(home, "ntfs-bin");
    await actual.mkdir(ntfsBin, { recursive: true, mode: 0o777 });

    // Simulate NTFS/FUSE fmask=000,dmask=000: every file and directory under ntfsBin reports 0777 regardless of chmod
    vi.mocked(fsPromises.lstat).mockImplementation((async (targetPath, opts) => {
      const st = await actual.lstat(targetPath, opts as never);
      const resolved = path.resolve(String(targetPath));
      if (resolved === ntfsBin || resolved.startsWith(`${ntfsBin}${path.sep}`)) {
        return Object.create(Object.getPrototypeOf(st), {
          ...Object.getOwnPropertyDescriptors(st),
          mode: { value: (st.mode & ~0o777) | 0o777, enumerable: true }
        });
      }
      return st;
    }) as typeof fsPromises.lstat);

    const realBin = path.join(root, "real-bin");
    await actual.mkdir(realBin, { recursive: true });
    for (const name of ["node", "pnpm", "git", "herdr", "claude", "codex", "agy", "rtk", "gitnexus", "mempalace"]) {
      const exe = path.join(realBin, name);
      await actual.writeFile(exe, "#!/bin/sh\nexit 0\n");
      await actual.chmod(exe, 0o755);
    }
    const entrypoint = path.join(root, "cli.mjs");
    await actual.writeFile(entrypoint, "console.log('ok');\n");

    const platform: PlatformProfile = {
      os: "linux",
      arch: "x64",
      supportStatus: "supported",
      shell: "bash",
      shellPath: "/bin/bash",
      uid,
      gid,
      isRoot: false,
      elevationAvailable: false,
      homeDir: home,
      hostname: "ntfs-box",
      machineId: "m-ntfs",
      paths: {
        config: path.join(root, "cfg"),
        data: path.join(root, "data"),
        state: path.join(root, "state"),
        managedBin: ntfsBin
      },
      pathEntries: [realBin]
    };

    const store = new SetupStateStore(platform.paths, { uid, now: () => NOW });
    const comp = new PathComponent({
      platform,
      store,
      observations: [],
      env: {},
      launcher: { nodeBinary: process.execPath, entrypoint }
    });
    const ctx = {
      platform,
      mode: "apply" as const,
      now: () => NOW,
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) }
    };

    const applied = await comp.apply(ctx);
    expect(applied.diagnostics).toEqual([]);
    const obs = await comp.observe(ctx);
    const des = await comp.desired(ctx);
    expect(obs.valid).toBe(true);
    expect(obs.stateDigest).toBe(des.digest);

    // Full MachineSetupService executor read-back must succeed without "read-back state does not match"
    const versions: Record<string, string> = {
      node: "v22.13.0",
      pnpm: "12.5.1",
      git: "git version 2.43.0",
      herdr: "herdr 0.9.5",
      claude: "2.1.104 (Claude Code)",
      codex: "codex-cli 0.120.0",
      agy: "1.4.2",
      rtk: "rtk 0.33.0",
      gitnexus: "1.6.12",
      mempalace: "mempalace 3.3.0"
    };
    const runner: CommandRunner = {
      async run(argv) {
        const base = path.basename(argv[0]!);
        return { exitCode: 0, stdout: `${versions[base] ?? "1.0.0"}\n`, stderr: "", timedOut: false };
      }
    };
    const host: HostEnvironment = {
      platform: "linux",
      arch: "x64",
      homeDir: home,
      hostname: "ntfs-box",
      uid,
      gid,
      env: {
        PATH: realBin,
        SHELL: "/bin/bash",
        HOME: home,
        XDG_CONFIG_HOME: path.dirname(platform.paths.config),
        XDG_DATA_HOME: path.dirname(platform.paths.data),
        XDG_STATE_HOME: path.dirname(platform.paths.state)
      }
    };
    await actual.mkdir(path.join(home, ".config", "bflow"), { recursive: true, mode: 0o700 });
    await actual.writeFile(
      path.join(home, ".config", "bflow", "machine.json"),
      JSON.stringify({ ...defaultMachineConfig(), toolPins: [], mcpServiceIds: [] }),
      { mode: 0o600 }
    );
    const svc = new MachineSetupService({
      host,
      runner,
      registry: new ToolInstallerRegistry(),
      approver: new NonInteractiveApprover(),
      now: () => NOW,
      launcher: { nodeBinary: process.execPath, entrypoint }
    });
    // Temporarily mirror sticky 0777 onto ~/.local/bin as well
    const defaultManagedBin = path.join(home, ".local", "bin");
    await actual.mkdir(defaultManagedBin, { recursive: true });
    vi.mocked(fsPromises.lstat).mockImplementation((async (targetPath, opts) => {
      const st = await actual.lstat(targetPath, opts as never);
      const resolved = path.resolve(String(targetPath));
      if (
        resolved === ntfsBin ||
        resolved.startsWith(`${ntfsBin}${path.sep}`) ||
        resolved === defaultManagedBin ||
        resolved.startsWith(`${defaultManagedBin}${path.sep}`)
      ) {
        return Object.create(Object.getPrototypeOf(st), {
          ...Object.getOwnPropertyDescriptors(st),
          mode: { value: (st.mode & ~0o777) | 0o777, enumerable: true }
        });
      }
      return st;
    }) as typeof fsPromises.lstat);

    const report = await svc.run({ mode: "apply", assumeYes: true });
    expect(report.outcome).toBe("applied");

    // Restore real POSIX lstat on a fresh POSIX bin dir and verify 0644 launcher is STILL detected as drifted
    vi.mocked(fsPromises.lstat).mockImplementation(actual.lstat);
    const posixBin = path.join(home, "posix-bin");
    await actual.mkdir(posixBin, { recursive: true, mode: 0o700 });
    const posixPlatform: PlatformProfile = {
      ...platform,
      paths: { ...platform.paths, managedBin: posixBin }
    };
    const posixComp = new PathComponent({
      platform: posixPlatform,
      store: new SetupStateStore(posixPlatform.paths, { uid, now: () => NOW }),
      observations: [],
      env: {},
      launcher: { nodeBinary: process.execPath, entrypoint }
    });
    const posixCtx = { ...ctx, mode: "apply" as const, platform: posixPlatform };
    expect((await posixComp.apply(posixCtx)).diagnostics).toEqual([]);
    await chmod(path.join(posixBin, "bflow"), 0o644);
    expect((await posixComp.observe(posixCtx)).stateDigest).not.toBe((await posixComp.desired(posixCtx)).digest);
    expect((await lstat(path.join(posixBin, "bflow"))).mode & 0o777).toBe(0o644);
  });
});
