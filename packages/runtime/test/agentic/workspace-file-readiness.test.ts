import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.doUnmock("node:child_process"); vi.resetModules(); });
it.runIf(process.platform === "darwin")("fails readiness with a concrete remedy when the native helper cannot be built", async () => {
  vi.resetModules();
  const compiler = vi.fn((_command, _args, _options, callback) => callback(Object.assign(new Error("compiler missing"), { code: "ENOENT" })));
  vi.doMock("node:child_process", () => ({ execFile: compiler }));
  const { assertWorkspaceFileCapability } = await import("../../src/agentic/workspace-file-readiness.js");
  await expect(assertWorkspaceFileCapability()).rejects.toThrow(/Runtime workspace file capability unavailable:.*xcode-select --install/);
  expect(compiler).toHaveBeenCalledOnce();
  expect(compiler.mock.calls[0]![0]).toBe("/usr/bin/clang");
});
it.runIf(process.platform === "darwin")("recovers after temporary-directory creation fails and the storage condition is repaired", async () => {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const temporary = vi.fn().mockRejectedValueOnce(Object.assign(new Error("temporary storage is full"), { code: "ENOSPC" }))
    .mockImplementation(actual.mkdtemp);
  vi.doMock("node:fs/promises", () => ({ ...actual, mkdtemp: temporary }));
  try {
    const { prepareDarwinWorkspaceHelper } = await import("../../src/agentic/workspace-file-darwin.js");
    await expect(prepareDarwinWorkspaceHelper()).rejects.toThrow();
    await expect(prepareDarwinWorkspaceHelper()).resolves.toMatch(/\/workspace$/);
    expect(temporary).toHaveBeenCalledTimes(2);
  } finally { vi.doUnmock("node:fs/promises"); }
});
