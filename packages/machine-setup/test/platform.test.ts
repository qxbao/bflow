import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NodeCommandRunner,
  canonicalJson,
  detectPlatform,
  digest,
  findExecutable,
  resolveXdgPaths,
  timeoutError,
  unsupportedVersion,
  type HostEnvironment
} from "../src/index.js";
import { ContractErrorSchema } from "@bflow/contracts";

function host(over: Partial<HostEnvironment> = {}): HostEnvironment {
  return {
    platform: "linux",
    arch: "x64",
    env: { SHELL: "/bin/bash", PATH: "/usr/bin:/bin" },
    homeDir: "/home/u",
    hostname: "box",
    uid: 1000,
    gid: 1000,
    ...over
  };
}

describe("platform", () => {
  it("supports linux and darwin, flags win32 and other", () => {
    expect(detectPlatform(host()).supportStatus).toBe("supported");
    expect(detectPlatform(host({ platform: "darwin", homeDir: "/Users/u" })).supportStatus).toBe("supported");
    const w = detectPlatform(host({ platform: "win32", homeDir: "C:\\Users\\u", uid: null, gid: null, env: {} }));
    expect(w.supportStatus).toBe("designed_unverified");
    expect(w.isRoot).toBe(false);
    expect(detectPlatform(host({ platform: "freebsd" })).supportStatus).toBe("unsupported");
  });

  it("resolves XDG defaults, overrides and ignores relative values", () => {
    expect(resolveXdgPaths(host())).toEqual({
      config: "/home/u/.config/bflow",
      data: "/home/u/.local/share/bflow",
      state: "/home/u/.local/state/bflow",
      managedBin: "/home/u/.local/share/bflow/bin"
    });
    const set = resolveXdgPaths(host({ env: { XDG_CONFIG_HOME: "/c", XDG_DATA_HOME: "/d", XDG_STATE_HOME: "/s" } }));
    expect(set).toEqual({ config: "/c/bflow", data: "/d/bflow", state: "/s/bflow", managedBin: "/d/bflow/bin" });
    const rel = resolveXdgPaths(host({ env: { XDG_CONFIG_HOME: "rel", XDG_DATA_HOME: "", XDG_STATE_HOME: "./x" } }));
    expect(rel.config).toBe("/home/u/.config/bflow");
    expect(rel.data).toBe("/home/u/.local/share/bflow");
    expect(rel.state).toBe("/home/u/.local/state/bflow");
  });

  it("machineId is stable and input-sensitive", () => {
    const a = detectPlatform(host()).machineId;
    expect(a).toMatch(/^m-[0-9a-f]{24}$/);
    expect(detectPlatform(host()).machineId).toBe(a);
    expect(detectPlatform(host({ hostname: "other" })).machineId).not.toBe(a);
    expect(detectPlatform(host({ uid: 0 })).machineId).not.toBe(a);
    expect(detectPlatform(host({ homeDir: "/home/v" })).machineId).not.toBe(a);
  });

  it("detects root", () => {
    expect(detectPlatform(host({ uid: 0 })).isRoot).toBe(true);
  });

  it.each([
    ["/bin/bash", "bash"],
    ["/usr/bin/zsh", "zsh"],
    ["/usr/bin/fish", "fish"],
    ["/bin/sh", "sh"],
    ["/bin/dash", "sh"],
    ["/bin/tcsh", "unknown"],
    [undefined, "unknown"]
  ])("shell %s -> %s", (shell, expected) => {
    expect(detectPlatform(host({ env: { SHELL: shell } })).shell).toBe(expected);
  });

  it("detects windows shells", () => {
    const w = (env: Record<string, string>) => detectPlatform(host({ platform: "win32", env })).shell;
    expect(w({ PSModulePath: "x" })).toBe("pwsh");
    expect(w({ PSModulePath: "x", ComSpec: "C:\\cmd.exe" })).toBe("pwsh");
    expect(w({ ComSpec: "C:\\cmd.exe" })).toBe("cmd");
    expect(w({})).toBe("unknown");
  });

  it("splits PATH entries", () => {
    expect(detectPlatform(host()).pathEntries).toEqual(["/usr/bin", "/bin"]);
  });
});

describe("canonical", () => {
  it("is key-order independent and compact", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,{"x":2,"y":1}]},"b":1}'
    );
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }));
    expect(digest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("errors", () => {
  it("build valid ContractErrors", () => {
    expect(ContractErrorSchema.safeParse(unsupportedVersion("v", 2)).success).toBe(true);
    expect(ContractErrorSchema.safeParse(timeoutError("t")).success).toBe(true);
  });
});

describe("runner", () => {
  const runner = new NodeCommandRunner();
  it("runs a command", async () => {
    const r = await runner.run([process.execPath, "-e", "process.stdout.write('hi');process.exit(3)"]);
    expect(r).toEqual({ exitCode: 3, stdout: "hi", stderr: "", timedOut: false });
  });
  it("kills on timeout", async () => {
    const r = await runner.run([process.execPath, "-e", "setTimeout(()=>{},60000)"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
  });
  it("rejects denylisted, empty and NUL argv", async () => {
    await expect(runner.run(["sudo", "ls"])).rejects.toThrow();
    await expect(runner.run(["/usr/bin/sudo", "ls"])).rejects.toThrow();
    await expect(runner.run([])).rejects.toThrow();
    await expect(runner.run([""])).rejects.toThrow();
    await expect(runner.run([process.execPath, "a\0b"])).rejects.toThrow();
  });
  it("findExecutable honours X_OK and PATHEXT", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ms-"));
    try {
      const exe = path.join(dir, "tool");
      await writeFile(exe, "#!/bin/sh\n");
      await chmod(exe, 0o644);
      expect(await findExecutable("tool", [dir], "linux")).toBeNull();
      await chmod(exe, 0o755);
      expect(await findExecutable("tool", [dir], "linux")).toBe(exe);
      expect(await findExecutable("nope", [dir], "linux")).toBeNull();
      const cmd = path.join(dir, "wtool.CMD");
      await writeFile(cmd, "x", { mode: 0o755 });
      expect(await findExecutable("wtool", [dir], "win32", ".EXE;.CMD")).toBe(cmd);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
