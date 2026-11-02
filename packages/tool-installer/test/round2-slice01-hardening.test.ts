import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open)
  };
});

import { atomicJson, withFileLock } from "../src/files.js";
import { ManagedToolInstaller, systemToolHost, type ManagedToolPin, type ToolHost } from "../src/installer.js";
import { ensureGitNexusIndex } from "../src/integrations.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

let root: string;
let syncErrorCode: string | null = null;

beforeEach(async () => {
  syncErrorCode = null;
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  root = await actual.realpath(await actual.mkdtemp(join(tmpdir(), "bflow-r2s1-ti-")));

  vi.mocked(fsPromises.open).mockImplementation((async (pathLike, flags, mode) => {
    const handle = await actual.open(pathLike, flags, mode);
    if (syncErrorCode !== null) {
      const code = syncErrorCode;
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === "sync") {
            return async () => {
              throw Object.assign(new Error(`${code}: fsync not supported on FUSE/NTFS`), { code });
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
  vi.restoreAllMocks();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  await actual.rm(root, { recursive: true, force: true });
});

describe("Round 2 Slice 1 — tool-installer FUSE/NTFS fsync, Dead-PID Locks, Git Dubious Ownership & Zero ESM Cycles", () => {
  it.each(["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EROFS"])(
    "tolerates FUSE/NTFS FileHandle.sync() %s in atomicJson and ManagedToolInstaller pending native intent",
    async (code) => {
      syncErrorCode = code;
      const targetJson = join(root, `atomic-${code}.json`);
      await expect(atomicJson(targetJson, { ok: true, code })).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(targetJson, "utf8"))).toEqual({ ok: true, code });

      const managedRoot = join(root, `managed-${code}`);
      await mkdir(managedRoot, { recursive: true, mode: 0o700 });
      const artifactBytes = "fake-plugin-archive";
      const pin: ManagedToolPin = {
        toolId: "superpowers",
        installerId: "bflow-tools-codex",
        version: "5.0.7",
        source: "https://github.com/obra/superpowers/archive/refs/tags/v5.0.7.tar.gz",
        integrity: sha(artifactBytes),
        recipe: { kind: "provider_plugin", provider: "codex" },
        license: "MIT"
      };
      const host: ToolHost = {
        async download(_url, dest) {
          await writeFile(dest, artifactBytes, { mode: 0o600 });
        },
        async run() {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      };
      let activated = false;
      const installer = new ManagedToolInstaller({
        managedRoot,
        pins: [pin],
        host,
        providerPlugin: {
          activate: async () => {
            activated = true;
            return { success: true, diagnostic: "activated" };
          },
          verify: async () => ({
            ready: activated,
            diagnostic: activated ? "verified" : "absent"
          }),
          registered: async () => activated
        }
      });
      const request = {
        schemaVersion: 3 as const,
        toolId: "superpowers",
        installerId: "bflow-tools-codex",
        version: "5.0.7",
        source: pin.source,
        integrity: pin.integrity,
        destination: join(managedRoot, "superpowers"),
        scope: { kind: "machine" as const, machineId: "m-1" },
        idempotencyKey: `install-sp-${code}`
      };
      const planned = await installer.plan(request);
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;

      const applied = await installer.apply({
        schemaVersion: 3,
        planId: "plan-1",
        planDigest: sha("plan-1"),
        step: planned.value,
        approvalReceiptId: "approval-1"
      });
      expect(applied.ok).toBe(true);
      if (applied.ok) {
        expect(applied.value.status).toBe("applied");
      }
    }
  );

  it("reclaims dead-PID crash locks in withFileLock while failing closed on live PIDs and foreign lock markers", async () => {
    const lockPath = join(root, "locks", "service.lock");
    await mkdir(join(root, "locks"), { recursive: true, mode: 0o700 });

    // Foreign non-JSON marker must NOT be reclaimed
    await writeFile(lockPath, "other process", { mode: 0o600 });
    await expect(withFileLock(lockPath, async () => "bad")).rejects.toThrow();
    expect(await readFile(lockPath, "utf8")).toBe("other process");

    // Live PID lock must NOT be reclaimed
    const livePayload = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
    await writeFile(lockPath, livePayload, { mode: 0o600 });
    await expect(withFileLock(lockPath, async () => "bad")).rejects.toThrow();
    expect(await readFile(lockPath, "utf8")).toBe(livePayload);

    // Dead PID lock from a crashed process MUST be reclaimed cleanly
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_646, acquiredAt: "2026-01-01T00:00:00.000Z" }),
      { mode: 0o600 }
    );
    const result = await withFileLock(lockPath, async () => {
      const held = JSON.parse(await readFile(lockPath, "utf8"));
      expect(held.pid).toBe(process.pid);
      return "recovered";
    });
    expect(result).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("ensureGitNexusIndex succeeds under isolated HOME + Git dubious ownership and NTFS +x fileMode without global safe.directory", async () => {
    const repoDir = join(root, "ntfs-repo");
    const stateRoot = join(root, "nexus-state");
    const emptyHome = join(root, "empty-home");
    const shimBin = join(root, "shim-bin");
    await mkdir(repoDir, { recursive: true });
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await mkdir(emptyHome, { recursive: true, mode: 0o700 });
    await mkdir(shimBin, { recursive: true });

    execFileSync("git", ["init", "--quiet", repoDir]);
    execFileSync("git", ["-C", repoDir, "config", "user.email", "test@bflow.local"]);
    execFileSync("git", ["-C", repoDir, "config", "user.name", "Bflow Test"]);
    await writeFile(join(repoDir, "index.ts"), "export const x = 1;\n");
    execFileSync("git", ["-C", repoDir, "add", "index.ts"]);
    execFileSync("git", ["-C", repoDir, "commit", "--quiet", "-m", "init"]);

    // Simulate NTFS/FUSE sticky +x mode bits on .git/HEAD and tracked files
    await chmod(join(repoDir, ".git", "HEAD"), 0o777);
    await chmod(join(repoDir, "index.ts"), 0o777);

    // Real git wrapper forcing upstream Git's dubious-ownership check under isolated empty HOME
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const gitShim = join(shimBin, "git");
    await writeFile(
      gitShim,
      `#!/bin/sh\nHOME='${emptyHome}' GIT_CONFIG_NOSYSTEM=1 GIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec '${realGit}' "$@"\n`,
      { mode: 0o755 }
    );

    // Fake gitnexus CLI that ALSO invokes `git rev-parse HEAD` as a subprocess to prove GIT_CONFIG_* safe.directory is propagated to gitnexus!
    const fakeNexus = join(shimBin, "gitnexus");
    const canonicalRepo = await realpath(repoDir);
    await writeFile(
      fakeNexus,
      [
        "#!/bin/sh",
        `"${gitShim}" rev-parse HEAD >/dev/null || exit 128`,
        'if [ "$1" = "status" ]; then',
        `  printf '{"schemaVersion":1,"repository":"%s","status":"up-to-date"}\\n' "${canonicalRepo}"`,
        "  exit 0",
        "fi",
        "exit 0",
        ""
      ].join("\n"),
      { mode: 0o755 }
    );

    const prevPath = process.env.PATH;
    process.env.PATH = `${shimBin}:${prevPath ?? ""}`;
    try {
      const obs = await ensureGitNexusIndex({
        repositoryRoot: repoDir,
        stateRoot,
        executable: fakeNexus,
        host: systemToolHost
      });
      expect(obs.status).toBe("fresh");

      // Fingerprint must match clean HEAD + empty porcelain (core.fileMode=false prevents false dirty mode diff!)
      const headSha = execFileSync(realGit, ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      expect(obs.fingerprint).toBe(sha(`${headSha}\n`));
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("contains zero intra-package circular ESM value-import cycles in packages/tool-installer/src", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(path.resolve(full));
      }
    };
    walk(srcDir);

    const graph = new Map<string, string[]>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const deps: string[] = [];
      const stmtRe = /^\s*(?:import|export)\s+([^;]+?)\s+from\s+["'](\.[^"']+)["']/gm;
      let match: RegExpExecArray | null;
      while ((match = stmtRe.exec(text)) !== null) {
        const clause = match[1]!.trim();
        if (/^type\b/.test(clause)) continue;
        if (clause.startsWith("{") && clause.endsWith("}")) {
          const specs = clause
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          if (specs.length > 0 && specs.every((s) => /^type\b/.test(s))) continue;
        }
        const resolved = path.resolve(path.dirname(file), match[2]!.replace(/\.js$/, ".ts"));
        if (existsSync(resolved)) deps.push(resolved);
      }
      graph.set(file, deps);
    }

    const visited = new Set<string>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const idx = new Map<string, number>();
    const low = new Map<string, number>();
    let counter = 0;
    const cycles: string[][] = [];

    const dfs = (v: string) => {
      idx.set(v, counter);
      low.set(v, counter);
      counter += 1;
      visited.add(v);
      stack.push(v);
      onStack.add(v);
      for (const w of graph.get(v) ?? []) {
        if (!visited.has(w)) {
          dfs(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        }
      }
      if (low.get(v) === idx.get(v)) {
        const comp: string[] = [];
        while (true) {
          const x = stack.pop()!;
          onStack.delete(x);
          comp.push(path.relative(srcDir, x));
          if (x === v) break;
        }
        if (comp.length > 1) cycles.push(comp);
      }
    };

    for (const file of graph.keys()) {
      if (!visited.has(file)) dfs(file);
    }
    expect(cycles).toEqual([]);
  });
});
