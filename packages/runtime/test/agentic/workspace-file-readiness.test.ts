import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.doUnmock("node:child_process"); vi.doUnmock("node:fs/promises"); vi.resetModules(); });
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
async function withMkdtempSpy(rejectFirst: boolean) {
  vi.resetModules();
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const spy = vi.fn();
  if (rejectFirst) spy.mockRejectedValueOnce(Object.assign(new Error("temporary storage is full"), { code: "ENOSPC" }));
  spy.mockImplementation(actual.mkdtemp);
  vi.doMock("node:fs/promises", () => ({ ...actual, mkdtemp: spy }));
  const { assertWorkspaceFileCapability } = await import("../../src/agentic/workspace-file-readiness.js");
  return { spy, assertWorkspaceFileCapability };
}
it.runIf(process.platform === "linux")("probes once for repeated and concurrent callers after success", async () => {
  try {
    const { spy, assertWorkspaceFileCapability } = await withMkdtempSpy(false);
    await Promise.all([assertWorkspaceFileCapability(), assertWorkspaceFileCapability()]);
    await assertWorkspaceFileCapability();
    expect(spy).toHaveBeenCalledOnce();
  } finally { vi.doUnmock("node:fs/promises"); }
});
it.runIf(process.platform === "linux")("does not cache a failed probe so the next call probes again", async () => {
  try {
    const { spy, assertWorkspaceFileCapability } = await withMkdtempSpy(true);
    await expect(assertWorkspaceFileCapability()).rejects.toThrow(/temporary storage is full/);
    await expect(assertWorkspaceFileCapability()).resolves.toBeUndefined();
    await assertWorkspaceFileCapability();
    expect(spy).toHaveBeenCalledTimes(2);
  } finally { vi.doUnmock("node:fs/promises"); }
});
