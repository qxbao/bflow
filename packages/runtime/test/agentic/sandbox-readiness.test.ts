import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), access: vi.fn(), readFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("node:fs/promises", () => ({ access: mocks.access, readFile: mocks.readFile, realpath: async (path: string) => path }));
import { diagnoseVerificationSandbox, probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => { Object.defineProperty(process, "platform", platform); vi.resetAllMocks(); vi.unstubAllEnvs(); });
it("probes deny-default Seatbelt execution before reporting Darwin ready", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  mocks.exec.mockImplementation((_binary, _args, _options, callback) => callback(null, "", ""));
  expect(await probeBehavioralSandbox()).toEqual({ status: "ready", executable: "/usr/bin/sandbox-exec", platform: "darwin" });
  expect(mocks.exec).toHaveBeenCalledWith("/usr/bin/sandbox-exec", expect.arrayContaining([expect.stringContaining("(deny default)"), "/usr/bin/true"]), expect.objectContaining({ timeout: 10000 }), expect.any(Function));
  expect(mocks.exec).toHaveBeenCalledWith("/usr/bin/sandbox-exec", expect.arrayContaining([process.execPath, "--version"]), expect.objectContaining({ timeout: 10000 }), expect.any(Function));
});
it("refuses readiness when true runs but the actual Node runtime cannot execute under Seatbelt", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  mocks.exec.mockImplementation((_binary, args, _options, callback) => args.includes("--version")
    ? callback(new Error("dyld: required library denied")) : callback(null, "", ""));
  expect(await probeBehavioralSandbox()).toMatchObject({ status: "unsupported", code: "verification_sandbox_unavailable" });
});
it("fails closed when an installed Seatbelt launcher cannot enforce the probe", async () => {
  Object.defineProperty(process, "platform", { value: "darwin" });
  mocks.exec.mockImplementation((_binary, _args, _options, callback) => callback(new Error("sandbox-exec: denied")));
  expect(await probeBehavioralSandbox()).toMatchObject({ status: "unsupported", code: "verification_sandbox_unavailable" });
});

function linux() {
  Object.defineProperty(process, "platform", { value: "linux" });
  vi.stubEnv("PATH", "/usr/bin:/usr/bin");
}
it("explains AppArmor namespace denial without weakening the namespace probe", async () => {
  linux();
  mocks.readFile.mockResolvedValue("1\n");
  mocks.exec.mockImplementation((_binary, _args, _options, callback) =>
    callback(Object.assign(new Error("failed"), { stderr: "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted\n" })));
  const result = await probeBehavioralSandbox();
  expect(result).toMatchObject({ status: "unsupported", reason: expect.stringContaining("AppArmor") });
  if (result.status !== "unsupported") throw new Error("Expected unavailable sandbox");
  expect(result.reason).toContain("RTM_NEWADDR");
  expect(mocks.exec).toHaveBeenCalledTimes(1);
  expect(mocks.exec.mock.calls[0]![1]).toEqual(expect.arrayContaining(["--unshare-all", "--cap-drop", "ALL"]));
});
it("distinguishes missing Bubblewrap from an installed launcher denied by the host", async () => {
  linux();
  mocks.access.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
  expect(await diagnoseVerificationSandbox()).toMatchObject({
    checkId: "runtime-verification-sandbox", status: "failed",
    message: expect.stringContaining("not found"), remediation: expect.stringContaining("bubblewrap")
  });
  expect(mocks.exec).not.toHaveBeenCalled();
});
it("reports a real Linux probe as ready, with no configuration or installation side effects", async () => {
  linux();
  mocks.exec.mockImplementation((_binary, _args, _options, callback) => callback(null, "", ""));
  expect(await diagnoseVerificationSandbox()).toMatchObject({ checkId: "runtime-verification-sandbox", status: "passed" });
  expect(mocks.exec).toHaveBeenCalledTimes(1);
  expect(mocks.readFile).not.toHaveBeenCalled();
});
it("retains bounded launch diagnostics when AppArmor policy cannot be read", async () => {
  linux();
  mocks.readFile.mockRejectedValue(new Error("not readable"));
  mocks.exec.mockImplementation((_binary, _args, _options, callback) =>
    callback(Object.assign(new Error("failed"), { stderr: "bwrap: namespace denied\n" + "x".repeat(20000) })));
  const result = await diagnoseVerificationSandbox();
  expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("namespace denied") });
  expect(result.message.length).toBeLessThan(600);
});
it("never executes a repository-controlled Bubblewrap", async () => {
  linux();
  vi.stubEnv("PATH", "/repo/bin:relative");
  expect(await diagnoseVerificationSandbox("/repo")).toMatchObject({ status: "failed" });
  expect(mocks.exec).not.toHaveBeenCalled();
});
it("keeps the first launcher's diagnosis and names a launcher the bundled AppArmor profile does not cover", async () => {
  linux();
  vi.stubEnv("PATH", "/usr/local/bin:/usr/bin");
  mocks.readFile.mockResolvedValue("1\n");
  mocks.exec.mockImplementation((binary, _args, _options, callback) => callback(Object.assign(new Error("failed"),
    { stderr: binary === "/usr/local/bin/bwrap" ? "bwrap: setting up uid map: Permission denied\n" : "bwrap: unrelated failure\n" })));
  const result = await diagnoseVerificationSandbox();
  expect(mocks.exec).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("/usr/local/bin/bwrap") });
  expect(result.message).not.toContain("unrelated failure");
  expect(result.remediation).toContain("attaches to /usr/bin/bwrap only");
});
it("points a denied system Bubblewrap at the bundled profile by absolute path", async () => {
  linux();
  mocks.readFile.mockResolvedValue("1\n");
  mocks.exec.mockImplementation((_binary, _args, _options, callback) =>
    callback(Object.assign(new Error("failed"), { stderr: "bwrap: setting up uid map: Permission denied\n" })));
  const result = await diagnoseVerificationSandbox();
  expect(result.remediation).toMatch(/^Have an administrator review and install \/.*support\/bflow-bwrap\.apparmor/);
});
