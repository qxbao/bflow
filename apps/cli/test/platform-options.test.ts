import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgenticHostPlatformOptionsSchema } from "@bflow/runtime";
import { identifyRepository, readEnvironmentConfig, runCli, type EnvironmentCompositionInput } from "../src/index.js";
import { buildHostPlatformOptions, formatPlatformNotReady, resolveCodexTrustPaths, resolveIsolatorStateRoot, type HostPlatformContext } from "../src/platform-options.js";
import { loadMachineSkillCatalog } from "../src/skill-catalog.js";
import { GATEWAY_CONTROL_LOCATOR_FILE } from "../src/gateway-control.js";

let dir: string;
let base: EnvironmentCompositionInput;
let context: HostPlatformContext;
beforeAll(async () => {
  context = { machineId: "m-test-machine", stateDirectory: "/state/bflow", dataDirectory: "/data/bflow",
    codexHomeDirectory: "/home/test/.codex", codexProcessHomeDirectory: "/home/test",
    codexHookApprovalPath: "/state/bflow/codex-hook-approvals.json",
    isolatorStateRoot: "/home/test/.local/share/ai-isolator",
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
  it("derives the isolator root only from trusted machine environment", () => {
    expect(resolveIsolatorStateRoot({ AI_ISOLATOR_HOME: "/machine/isolator" }, "/home/native")).toBe("/machine/isolator");
    expect(resolveIsolatorStateRoot({ AI_ISOLATOR_REAL_HOME: "/home/real" }, "/home/isolated-profile"))
      .toBe("/home/real/.local/share/ai-isolator");
    expect(resolveIsolatorStateRoot({}, "/home/native")).toBe("/home/native/.local/share/ai-isolator");
  });

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

  it("uses a role profile override before the selected provider default", async () => {
    const input = configure(environment => {
      Object.assign(environment, { defaults: {
        codex: { "profile-name": "work" },
        claude: { "profile-name": "personal" },
        agy: { "profile-name": "work" }
      } });
      environment.roles = environment.roles.map(role => role.role === "coordinator"
        ? Object.assign({ ...role, model: "gpt-model", effort: "high" as const }, { "profile-name": "lead" })
        : role);
    });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    expect(options.roles.find(role => role.role === "coordinator")).toMatchObject({
      provider: "codex", profileName: "lead", model: "gpt-model", effort: "high"
    });
    expect(options.roles.find(role => role.role === "conversation")).toMatchObject({ provider: "codex", profileName: "work" });
  });

  it("binds selected profiles to the trusted isolator root while omitting it without a selection", async () => {
    const input = configure(environment => {
      Object.assign(environment, { defaults: { codex: { "profile-name": "work" } } });
    });
    const first = await buildHostPlatformOptions(input, {
      context: { ...context, isolatorStateRoot: "/machine/isolator-one" }, fileExists: absent
    });
    const second = await buildHostPlatformOptions(input, {
      context: { ...context, isolatorStateRoot: "/machine/isolator-two" }, fileExists: absent
    });
    expect(first).toMatchObject({ isolatorStateRoot: "/machine/isolator-one" });
    expect(second).toMatchObject({ isolatorStateRoot: "/machine/isolator-two" });

    const noProfile = await buildHostPlatformOptions(base, { context, fileExists: absent });
    expect(noProfile).not.toHaveProperty("isolatorStateRoot");
  });

  it("selects provider defaults independently and preserves profile inheritance for the dynamic Developer", async () => {
    const input = configure(environment => {
      environment.roles = environment.roles.filter(role => role.role !== "developer");
      Object.assign(environment, { defaults: {
        codex: { "profile-name": "work" },
        claude: { "profile-name": "personal" },
        agy: { "profile-name": "agy-work" }
      } });
      environment.roles = environment.roles.map(role => role.role === "coordinator"
        ? Object.assign({ ...role, cli: "codex", model: "coord-model", effort: "xhigh" as const }, { "profile-name": "lead" })
        : { ...role, cli: "claude" });
    });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    expect(options.roles.find(role => role.role === "coordinator")).toMatchObject({ provider: "codex", profileName: "lead" });
    expect(options.roles.find(role => role.role === "conversation")).toMatchObject({ provider: "claude", profileName: "personal" });
    expect(options.roles.find(role => role.role === "developer")).toMatchObject({
      provider: "codex", profileName: "lead", model: "coord-model", effort: "xhigh", required: false
    });
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

  it("carries the trusted Codex home and hook approval store path from machine context", async () => {
    const trustedContext = Object.assign({}, context, {
      codexHomeDirectory: "/isolated/providers/codex",
      codexProcessHomeDirectory: "/isolated/providers/home",
      codexHookApprovalPath: "/isolated/state/codex-hook-approvals.json"
    });
    const options = await buildHostPlatformOptions(base, { context: trustedContext, fileExists: absent });
    expect(options).toMatchObject({
      codexHomeDirectory: "/isolated/providers/codex",
      codexHookApprovalPath: "/isolated/state/codex-hook-approvals.json"
    });
  });

  it("keeps Codex hook state under BFLOW_HOME and otherwise follows CODEX_HOME", () => {
    expect(resolveCodexTrustPaths({ environment: { BFLOW_HOME: "/isolated", CODEX_HOME: "/actual/.codex" },
      homeDirectory: "/actual", processHomeDirectory: "/isolated/providers/home", machineStateDirectory: "/isolated/state" })).toEqual({
      codexHomeDirectory: "/isolated/providers/codex",
      codexProcessHomeDirectory: "/isolated/providers/home",
      codexHookApprovalPath: "/isolated/state/codex-hook-approvals.json"
    });
    expect(resolveCodexTrustPaths({ environment: { CODEX_HOME: "/custom/codex" },
      homeDirectory: "/actual", processHomeDirectory: "/actual", machineStateDirectory: "/state/bflow" })).toEqual({
      codexHomeDirectory: "/custom/codex",
      codexProcessHomeDirectory: "/actual",
      codexHookApprovalPath: "/state/bflow/codex-hook-approvals.json"
    });
  });

  it("adds a Developer template using the Coordinator's provider when none is configured", async () => {
    const input = configure(environment => { environment.roles = environment.roles.filter(role => role.role !== "developer").map(role => ({ ...role, cli: role.role === "coordinator" ? "agy" : "claude" })); });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    const developer = options.roles.find(role => role.role === "developer");
    expect(developer).toMatchObject({ provider: "agy", required: false });
    expect(options.roles.filter(role => role.role === "developer")).toHaveLength(1);
  });

  it("carries role model and effort settings and inherits them for an implicit Developer template", async () => {
    const input = configure(environment => {
      environment.roles = environment.roles.filter(role => role.role !== "developer");
      environment.roles = environment.roles.map(role => role.role === "coordinator"
        ? { ...role, model: "codex-main", effort: "xhigh" as const }
        : role);
    });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    expect(options.roles.find(role => role.role === "coordinator")).toMatchObject({ model: "codex-main", effort: "xhigh" });
    expect(options.roles.find(role => role.role === "developer")).toMatchObject({ provider: "codex", model: "codex-main", effort: "xhigh", required: false });
  });

  it("uses an explicitly configured Developer model and effort instead of the Coordinator defaults", async () => {
    const input = configure(environment => {
      environment.roles = environment.roles.map(role => role.role === "coordinator"
        ? { ...role, model: "coordinator-model", effort: "high" as const }
          : role);
      environment.roles = environment.roles.map(role => role.role === "developer"
        ? { ...role, cli: "claude", model: "developer-model", effort: "xhigh" as const }
        : role);
    });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    expect(options.roles.filter(role => role.role === "developer")).toHaveLength(1);
    expect(options.roles.find(role => role.role === "developer")).toMatchObject({ provider: "claude", model: "developer-model", effort: "xhigh", required: false });
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

describe("Context7 role grants", () => {
  const roleMap = (options: Awaited<ReturnType<typeof buildHostPlatformOptions>>) => Object.fromEntries(options.roles.map(role => [role.role, role]));
  const enabled = (extra: Record<string, unknown> = {}) => configure(environment => { environment.context7 = { enabled: true, ...extra }; });

  it("is on in a repository created by init, as an optional service", () => {
    expect(base.config.environment.context7).toEqual({ enabled: true, required: false });
  });

  it("grants the service and its two tools only to the roles whose approved skill allows documentation lookup", async () => {
    const options = await buildHostPlatformOptions(enabled(), { context, fileExists: absent, context7Ready: true });
    const roles = roleMap(options);
    for (const role of ["specifier", "architect", "planner", "developer", "reviewer", "qa"]) {
      expect(roles[role]?.mcpServiceIds, role).toEqual(["context7"]);
      expect(roles[role]?.toolIds, role).toEqual(["resolve-library-id", "query-docs"]);
    }
    for (const role of ["conversation", "coordinator"]) {
      expect(roles[role]?.mcpServiceIds, role).toEqual([]);
      expect(roles[role]?.toolIds, role).toEqual([]);
    }
    expect(AgenticHostPlatformOptionsSchema.parse(options)).toEqual(options);
  });

  it("adds to the repository's own MCP services and tools without duplicating them", async () => {
    const input = configure(environment => {
      environment.context7 = { enabled: true };
      environment.requiredMcpServices = ["gitnexus", "context7"];
      environment.requiredTools = ["query", "query-docs"];
    });
    const developer = roleMap(await buildHostPlatformOptions(input, { context, fileExists: absent, context7Ready: true }))["developer"]!;
    expect(developer.mcpServiceIds).toEqual(["gitnexus", "context7"]);
    expect(developer.toolIds).toEqual(["query", "query-docs", "resolve-library-id"]);
  });

  it("starts roles without it, and warns once, when it is optional and the Gateway does not report it ready", async () => {
    const warnings: string[] = [];
    const options = await buildHostPlatformOptions(enabled({ required: false }), { context, fileExists: absent, context7Ready: false, warn: message => warnings.push(message) });
    expect(options.roles.every(role => role.mcpServiceIds.length === 0 && role.toolIds.length === 0)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/degraded/);
    const unknown = await buildHostPlatformOptions(enabled(), { context, fileExists: absent, warn: message => warnings.push(message) });
    expect(roleMap(unknown)["developer"]?.mcpServiceIds).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  it("still requests it for every allowed role when required, so a missing service blocks startup instead of degrading", async () => {
    const warnings: string[] = [];
    const options = await buildHostPlatformOptions(enabled({ required: true }), { context, fileExists: absent, context7Ready: false, warn: message => warnings.push(message) });
    expect(roleMap(options)["developer"]?.mcpServiceIds).toEqual(["context7"]);
    expect(warnings).toEqual([]);
  });

  it("changes nothing for a repository that has not enabled it", async () => {
    for (const edit of [(environment: EnvironmentCompositionInput["config"]["environment"]) => { delete environment.context7; },
      (environment: EnvironmentCompositionInput["config"]["environment"]) => { environment.context7 = { enabled: false, required: true }; }]) {
      const warnings: string[] = [];
      const options = await buildHostPlatformOptions(configure(edit), { context, fileExists: absent, context7Ready: true, warn: message => warnings.push(message) });
      expect(options.roles.every(role => role.mcpServiceIds.length === 0)).toBe(true);
      expect(warnings).toEqual([]);
    }
  });
});
