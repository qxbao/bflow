import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgenticHostPlatformOptionsSchema } from "@bflow/runtime";
import { identifyRepository, readEnvironmentConfig, runCli, type EnvironmentCompositionInput } from "../src/index.js";
import { buildHostPlatformOptions, formatPlatformNotReady, type HostPlatformContext } from "../src/platform-options.js";
import { loadMachineSkillCatalog } from "../src/skill-catalog.js";
import { GATEWAY_CONTROL_LOCATOR_FILE } from "../src/gateway-control.js";

let dir: string;
let base: EnvironmentCompositionInput;
let context: HostPlatformContext;
beforeAll(async () => {
  context = { machineId: "m-test-machine", stateDirectory: "/state/bflow", dataDirectory: "/data/bflow",
    skills: await loadMachineSkillCatalog() };
});
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "bflow-platform-options-")));
  execFileSync("git", ["init", "--quiet", dir]);
  expect((await runCli(["init"], { cwd: dir })).ok).toBe(true);
  const repository = await identifyRepository(dir);
  base = { repository, config: await readEnvironmentConfig(repository), env: {} };
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function configure(edit: (environment: EnvironmentCompositionInput["config"]["environment"]) => void): EnvironmentCompositionInput {
  const config = structuredClone(base.config);
  edit(config.environment);
  return { ...base, config };
}
const absent = () => false;

describe("buildHostPlatformOptions", () => {
  it.each([
    ["all Claude", "claude"], ["all Codex", "codex"], ["all Agy", "agy"]
  ] as const)("produces valid v3 options for an %s configuration", async (_label, provider) => {
    const input = configure(environment => { environment.roles = environment.roles.map(role => ({ ...role, cli: provider })); });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    expect(AgenticHostPlatformOptionsSchema.parse(options)).toEqual(options);
    expect(options.roles.every(role => role.provider === provider)).toBe(true);
    expect(options.machineId).toBe("m-test-machine");
    expect(options.repositoryId).toBe(input.repository.id);
    expect(options.skillsStoreRoot).toBe("/data/bflow/skills-store");
    expect(options.approvedBuiltinSkillDigests.length).toBeGreaterThan(0);
  });

  it("produces valid options for a mixed configuration and keeps each role's provider", async () => {
    const input = configure(environment => {
      environment.roles = environment.roles.map(role => ({ ...role, cli: role.role === "conversation" ? "claude" : role.role === "coordinator" ? "codex" : "agy" }));
    });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    const providers = Object.fromEntries(options.roles.map(role => [role.role, role.provider]));
    expect(providers).toMatchObject({ conversation: "claude", coordinator: "codex", planner: "agy" });
  });

  it("rejects an unknown provider by name without applying any readiness rule", async () => {
    const input = configure(environment => { environment.roles[0] = { ...environment.roles[0]!, cli: "gemini" }; });
    await expect(buildHostPlatformOptions(input, { context, fileExists: absent })).rejects.toThrow("unsupported provider 'gemini'");
  });

  it("resolves role skills to exact pins and rejects a missing pin by name", async () => {
    const pinned = configure(environment => {
      environment.roles = environment.roles.map(role => role.role === "coordinator" ? { ...role, skills: ["inspect-repository"] } : role);
    });
    const options = await buildHostPlatformOptions(pinned, { context, fileExists: absent });
    const coordinator = options.roles.find(role => role.role === "coordinator")!;
    expect(coordinator.skillSelections).toEqual([{ skill: expect.objectContaining({ skillId: "inspect-repository", version: expect.any(String), digest: expect.stringMatching(/^[a-f0-9]{64}$/) }), required: true }]);

    const missing = configure(environment => {
      environment.roles = environment.roles.map(role => role.role === "coordinator" ? { ...role, skills: ["no-such-skill"] } : role);
    });
    await expect(buildHostPlatformOptions(missing, { context, fileExists: absent })).rejects.toThrow("no-such-skill");
  });

  it("applies environment-wide required skills to every role the skill allows and carries MCP services, tools and permissions", async () => {
    const input = configure(environment => {
      environment.requiredMcpServices = ["gitnexus"];
      environment.requiredTools = ["rtk"];
      environment.permissions = { mode: "restricted" };
      environment.skills = { requiredSkills: ["inspect-repository"] };
    });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    for (const role of options.roles) {
      expect(role.permissionMode).toBe("restricted");
      expect(role.mcpServiceIds).toEqual(["gitnexus"]);
      expect(role.toolIds).toEqual(["rtk"]);
      // The Conversation role is not an allowed role for this skill, so the environment-wide pin does not apply to it.
      expect(role.skillSelections.map(item => item.skill.skillId)).toEqual(role.role === "conversation" ? [] : ["inspect-repository"]);
    }
  });

  it("includes the Gateway locator only when the file exists in the machine state directory", async () => {
    const expected = join("/state/bflow", GATEWAY_CONTROL_LOCATOR_FILE);
    const present = await buildHostPlatformOptions(base, { context, fileExists: path => path === expected });
    expect(present.gatewayLocatorPath).toBe(expected);
    const absentLocator = await buildHostPlatformOptions(base, { context, fileExists: absent });
    expect(absentLocator).not.toHaveProperty("gatewayLocatorPath");
  });

  it("adds a Developer template using the Coordinator's provider when none is configured", async () => {
    const input = configure(environment => { environment.roles = environment.roles.map(role => ({ ...role, cli: role.role === "coordinator" ? "agy" : "claude" })); });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    const developer = options.roles.find(role => role.role === "developer");
    expect(developer).toMatchObject({ provider: "agy", required: false });
    expect(options.roles.filter(role => role.role === "developer")).toHaveLength(1);
  });

  it("carries role model and effort settings and inherits them for an implicit Developer template", async () => {
    const input = configure(environment => {
      environment.roles = environment.roles.map(role => role.role === "coordinator"
        ? Object.assign(role, { model: "codex-main", effort: "xhigh" })
        : role);
    });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    expect(options.roles.find(role => role.role === "coordinator")).toMatchObject({ model: "codex-main", effort: "xhigh" });
    expect(options.roles.find(role => role.role === "developer")).toMatchObject({ provider: "codex", model: "codex-main", effort: "xhigh", required: false });
  });

  it("uses an explicitly configured Developer model and effort instead of the Coordinator defaults", async () => {
    const input = configure(environment => {
      environment.roles = environment.roles.map(role => role.role === "coordinator"
        ? Object.assign(role, { model: "coordinator-model", effort: "high" })
          : role);
      environment.roles.push({ role: "developer", cli: "claude", required: true, model: "developer-model", effort: "xhigh" } as never);
    });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    expect(options.roles.find(role => role.role === "developer")).toMatchObject({ model: "developer-model", effort: "xhigh" });
  });

  it("requires a coordinator role", async () => {
    const input = configure(environment => { environment.roles = environment.roles.filter(role => role.role !== "coordinator"); });
    await expect(buildHostPlatformOptions(input, { context, fileExists: absent })).rejects.toThrow();
  });
});

describe("formatPlatformNotReady", () => {
  it("lists only non-ready roles with provider, status and failing checks", () => {
    const text = formatPlatformNotReady({ ready: false, generation: 2, checkedAt: new Date().toISOString(), roles: [
      { role: "reviewer", provider: "agy", required: true, status: "unsupported", checks: [{ check: "launch_arguments", status: "failed", code: "agy_prompt_injection", message: "Prompt injection is not verified for agy" }] },
      { role: "qa", provider: "codex", required: true, status: "ready", checks: [{ check: "binary", status: "passed", code: "ok", message: "found" }] }
    ] });
    expect(text).toContain("reviewer [agy]: unsupported");
    expect(text).toContain("agy_prompt_injection");
    expect(text).not.toContain("qa [codex]");
  });
});
