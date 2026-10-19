import { describe, expect, it } from "vitest";
import {
  BuiltinSetupDoctor,
  MachineDoctorReportSchema,
  type PlatformProfile,
  type SetupComponent,
  type SetupContext,
  type ToolObservation
} from "../src/index.js";

const platform = { os: "linux", machineId: "m-1" } as unknown as PlatformProfile;
const ctx: SetupContext = {
  platform, mode: "check", now: () => new Date("2026-01-02T03:04:05.000Z"),
  runner: { run: async () => { throw new Error("no commands"); } }
};
const tool = (toolId: string, status: ToolObservation["status"], required: boolean): ToolObservation => ({
  toolId, status, resolvedPath: null, realPath: null, version: null, binaryDigest: null,
  pathMissingDir: null, required, diagnostics: []
});
const comp = (id: string, valid: boolean, diagnostics: string[] = []): SetupComponent => ({
  componentId: id, action: "configure", rollback: "none",
  observe: async () => ({ stateDigest: "d", valid, diagnostics }),
  desired: async () => { throw new Error("unused"); },
  apply: async () => { throw new Error("read-only"); }
});

describe("BuiltinSetupDoctor", () => {
  const doctor = new BuiltinSetupDoctor();
  const base = {
    machineId: "m-1",
    observations: [tool("node", "present", true), tool("claude", "present", false)],
    configStatus: "valid" as const,
    components: [comp("path", true), comp("mcp-config", true), comp("services", true), comp("role-skills", true)]
  };

  it("healthy machine yields parsed report with provider login warning", async () => {
    const r = await doctor.run(ctx, base);
    expect(MachineDoctorReportSchema.parse(r)).toEqual(r);
    expect(r.healthy).toBe(true);
    expect(r.checkedAt).toBe("2026-01-02T03:04:05.000Z");
    const login = r.checks.find((c) => c.checkId === "provider-auth-claude")!;
    expect(login.status).toBe("warning");
    expect(login.summary).toContain("login not verified by setup; run `claude` interactively");
    expect(r.checks.find((c) => c.checkId === "tool-node")!.status).toBe("passed");
    expect(r.checks.find((c) => c.checkId === "machine-config")!.status).toBe("passed");
  });

  it("required missing tool fails; optional missing is warning", async () => {
    const r = await doctor.run(ctx, {
      ...base, observations: [tool("node", "missing", true), tool("git", "missing", false)]
    });
    expect(r.healthy).toBe(false);
    expect(r.checks.find((c) => c.checkId === "tool-node")!.status).toBe("failed");
    expect(r.checks.find((c) => c.checkId === "tool-git")!.status).toBe("warning");
  });

  it("a required tool with an owner action is a warning carrying that remediation; a plain missing required tool still fails", async () => {
    const login = "mempalace could not be installed: install Python 3.9 or newer, then rerun setup.";
    const deferred = await doctor.run(ctx, { ...base, observations: [{ ...tool("mempalace", "missing", true), diagnostics: [login], ownerAction: login }] });
    const check = deferred.checks.find((c) => c.checkId === "tool-mempalace")!;
    expect(check.status).toBe("warning");
    expect(check.remediation).toBe(login);
    expect(deferred.healthy).toBe(true);
    const failing = await doctor.run(ctx, { ...base, observations: [tool("mempalace", "missing", true)] });
    expect(failing.checks.find((c) => c.checkId === "tool-mempalace")!.status).toBe("failed");
    expect(failing.healthy).toBe(false);
  });

  it("invalid components and config fail; absent config is a warning; missing skills is skipped", async () => {
    const r = await doctor.run(ctx, {
      ...base, configStatus: "invalid",
      components: [comp("path", false, ["bad block"]), comp("mcp-config", false, ["bad json"]), comp("services", true, ["svc inactive"])]
    });
    const by = (id: string) => r.checks.find((c) => c.checkId === id)!;
    expect(by("machine-config").status).toBe("failed");
    expect(by("path-block").status).toBe("failed");
    expect(by("mcp-config").status).toBe("failed");
    expect(by("mcp-config").remediation).toBeTruthy();
    expect(by("services").status).toBe("warning");
    expect(by("role-skills").status).toBe("skipped");
    expect(r.healthy).toBe(false);
    const a = await doctor.run(ctx, { ...base, configStatus: "absent" });
    expect(a.checks.find((c) => c.checkId === "machine-config")!.status).toBe("warning");
    expect(a.healthy).toBe(true);
  });

  it("component observe throwing is a failed check, not a crash", async () => {
    const boom: SetupComponent = { ...comp("services", true), observe: async () => { throw new Error("x"); } };
    const r = await doctor.run(ctx, { ...base, components: [boom] });
    expect(r.checks.find((c) => c.checkId === "services")!.status).toBe("failed");
  });
});
