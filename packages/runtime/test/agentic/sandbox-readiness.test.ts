import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), access: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("node:fs/promises", () => ({ access: mocks.access, realpath: async (path: string) => path }));
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.resetAllMocks(); });
it("probes deny-default Seatbelt execution before reporting Darwin ready", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  mocks.exec.mockImplementation((_binary, _args, _options, callback) => callback(null, "", ""));
  expect(await probeBehavioralSandbox()).toEqual({ status: "ready", executable: "/usr/bin/sandbox-exec", platform: "darwin" });
  expect(mocks.exec).toHaveBeenCalledWith("/usr/bin/sandbox-exec", expect.arrayContaining([expect.stringContaining("(deny default)"), "/usr/bin/true"]), expect.objectContaining({ timeout: 10000 }), expect.any(Function));
});
it("fails closed when an installed Seatbelt launcher cannot enforce the probe", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  mocks.exec.mockImplementation((_binary, _args, _options, callback) => callback(new Error("sandbox-exec: denied")));
  expect(await probeBehavioralSandbox()).toMatchObject({ status: "unsupported", code: "verification_sandbox_unavailable" });
});
