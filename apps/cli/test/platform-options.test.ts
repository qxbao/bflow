import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgenticHostPlatformOptionsSchema } from "@bflow/runtime";
import { MCPServiceDefinitionSchema, RepositoryToolPolicySchema } from "@bflow/contracts";
import { digest } from "@bflow/machine-setup";
import { EnvironmentConfigEnvironmentSchema } from "../src/environment-config.js";
import { identifyRepository, readEnvironmentConfig, runCli, type EnvironmentCompositionInput } from "../src/index.js";
import { parseConfigYaml, renderEnvironmentConfigYaml } from "../src/config-format.js";
import { buildHostPlatformOptions, formatPlatformNotReady, resolveCodexTrustPaths, resolveIsolatorStateRoot, resolveRepositoryToolPolicy, resolveToolGrants, type HostPlatformContext } from "../src/platform-options.js";
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
  it("resolves an explicitly scoped memory grant from a ready service before validating retrieved provenance", () => {
    const scope = { kind: "repository" as const, machineId: context.machineId, repositoryId: base.repository.id, workspaceRoot: base.repository.root };
    const policy = RepositoryToolPolicySchema.parse({ schemaVersion: 3, repositoryId: base.repository.id, scope,
      digest: "a".repeat(64), requirements: [{ toolId: "mempalace", kind: "native_remote_mcp", serviceId: "memory",
        operations: ["mempalace_search"], requiredness: "required", roles: ["developer"], triggers: ["prior_context"],
        memoryScope: { wing: "approved-wing", repositoryId: base.repository.id, access: "read_only" } }] });
    const service = MCPServiceDefinitionSchema.parse({ schemaVersion: 3, serviceId: "memory", revision: 1,
      scope: { kind: "machine", machineId: context.machineId },
      tool: { schemaVersion: 3, toolId: "mempalace", kind: "native_remote_mcp", version: "3.11.0",
        operations: ["mempalace_search"], required: true, resource: { sharing: "concurrent", maxConcurrency: 1 } },
      connection: { kind: "native_remote_mcp", endpoint: "https://memory.example.test/mcp", ownership: "external" },
      authentication: { mode: "none" }, healthTimeoutMs: 1000, idleTimeoutMs: 60000, restartLimit: 0 });
    const grants = resolveToolGrants(policy, { ...context, mcpServices: [service], serviceReadiness:
      new Map([["memory", { status: "ready", discoveredTools: ["mempalace_search"] }]]) }, base);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ toolId: "mempalace", operations: ["mempalace_search"],
      memoryScope: { wing: "approved-wing", repositoryId: base.repository.id, access: "read_only" } });
  });
  it("rejects configured custom skill catalog and binding paths with remediation", () => {
    const input = configure(environment => { environment.skills = { catalogDir: "./custom", bindingsPath: "./bindings.json" }; });
    expect(() => resolveRepositoryToolPolicy(input, context.machineId)).toThrow(/catalogDir\/bindingsPath are not supported.*Remove these overrides/i);
  });
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

  it("keeps production role skills while denying tools unless repository policy and inventory authorize them", async () => {
    const options = await buildHostPlatformOptions(base, { context, fileExists: absent, context7Ready: true });
    const developer = options.roles.find(role => role.role === "developer")!;
    expect(developer.skillSelections.map(item => item.skill.skillId)).toContain("using-bflow");
    expect(developer.toolIds).toEqual([]);
    expect(developer.mcpServiceIds).toEqual([]);
    expect(options).not.toHaveProperty("toolGrants");
  });

  it("does not turn a legacy Context7 opt-in or its skill into a tool grant", async () => {
    const input = configure(environment => { environment.context7 = { enabled: true, required: false }; });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent, context7Ready: true });
    const developer = options.roles.find(role => role.role === "developer")!;
    expect(developer.skillSelections.map(item => item.skill.skillId)).not.toContain("use-context7");
    expect(developer.toolIds).toEqual([]);
    expect(developer.mcpServiceIds).toEqual([]);
  });

  it("refuses cross-role legacy tool broadening and reports a deterministic policy migration", async () => {
    const input = configure(environment => { environment.requiredTools = ["rtk"]; });
    await expect(buildHostPlatformOptions(input, { context, fileExists: absent }))
      .rejects.toThrow(/requiredTools.*allowlist.*toolPolicy/i);
  });

  it("rejects a repository policy whose digest does not bind its canonical contents", async () => {
    const input = configure(environment => {
      delete environment.context7;
      const body = { schemaVersion: 3 as const, repositoryId: base.repository.id,
        scope: { kind: "repository" as const, machineId: context.machineId, repositoryId: base.repository.id, workspaceRoot: base.repository.root },
        requirements: [{ toolId: "rtk", kind: "cli_only" as const, operations: ["test"], requiredness: "optional" as const,
          roles: ["developer" as const], triggers: ["routine_command" as const] }] };
      environment.toolPolicy = RepositoryToolPolicySchema.parse({ ...body, digest: "0".repeat(64) });
    });
    await expect(buildHostPlatformOptions(input, { context, fileExists: absent })).rejects.toThrow(/digest.*canonical contents/i);
  });

  it("round-trips a strict repository tool policy through the editable YAML config", async () => {
    const input = configure(environment => {
      const body = { schemaVersion: 3 as const, repositoryId: base.repository.id,
        scope: { kind: "repository" as const, machineId: context.machineId, repositoryId: base.repository.id, workspaceRoot: base.repository.root },
        requirements: [{ toolId: "context7", kind: "native_remote_mcp" as const, serviceId: "context7",
          operations: ["resolve-library-id", "query-docs"], requiredness: "optional" as const,
          roles: ["specifier" as const, "architect" as const], triggers: ["external_documentation" as const] }] };
      environment.toolPolicy = RepositoryToolPolicySchema.parse({ ...body, digest: digest(body) });
    });
    const rendered = renderEnvironmentConfigYaml(input.config);
    const parsed = EnvironmentConfigEnvironmentSchema.parse(parseConfigYaml(rendered).environment);
    expect(parsed.toolPolicy).toEqual(input.config.environment.toolPolicy);
  });

  it("blocks required CLI grants without a verified managed executable identity", async () => {
    const input = configure(environment => {
      delete environment.context7;
      const body = { schemaVersion: 3 as const, repositoryId: base.repository.id,
        scope: { kind: "repository" as const, machineId: context.machineId, repositoryId: base.repository.id, workspaceRoot: base.repository.root },
        requirements: [{ toolId: "rtk", kind: "cli_only" as const, operations: ["test"], requiredness: "required" as const,
          roles: ["developer" as const], triggers: ["routine_command" as const], capabilityIds: ["repo-forged-capability"] }] };
      environment.toolPolicy = RepositoryToolPolicySchema.parse({ ...body, digest: digest(body) });
    });
    await expect(buildHostPlatformOptions(input, { context: { ...context, toolInventory: new Map() }, fileExists: absent }))
      .rejects.toThrow(/Required tool 'rtk'.*no verified machine executable identity/i);
  });

  it("does not copy repository requested capability IDs into a resolved grant", async () => {
    const input = configure(environment => {
      delete environment.context7;
      const body = { schemaVersion: 3 as const, repositoryId: base.repository.id,
        scope: { kind: "repository" as const, machineId: context.machineId, repositoryId: base.repository.id, workspaceRoot: base.repository.root },
        requirements: [{ toolId: "rtk", kind: "cli_only" as const, operations: ["test"], requiredness: "optional" as const,
          roles: ["developer" as const], triggers: ["routine_command" as const], capabilityIds: ["repo-forged-capability"] }] };
      environment.toolPolicy = RepositoryToolPolicySchema.parse({ ...body, digest: digest(body) });
    });
    const inventory = new Map([["rtk", { executablePath: "/machine/tools/rtk", version: "0.42.0", digest: "a".repeat(64) }]]);
    const grants = resolveToolGrants(input.config.environment.toolPolicy, { ...context, toolInventory: inventory }, input);
    expect(grants[0]?.capabilityIds).toBeUndefined();
  });

  it("degrades exclusive browser resources until the Runtime can acquire their lease", async () => {
    const service = MCPServiceDefinitionSchema.parse({ schemaVersion: 3, serviceId: "chrome-session", revision: 1,
      scope: { kind: "machine", machineId: context.machineId },
      tool: { schemaVersion: 3, toolId: "chrome-devtools-mcp", kind: "stdio_mcp", version: "1",
        operations: ["list_pages", "new_page", "navigate_page"], required: true,
        resource: { sharing: "exclusive", resourceKey: "chrome-session" } },
      connection: { kind: "stdio_mcp", executable: "/machine/chrome-mcp", argv: [], environmentBindings: {},
        executableDigest: "b".repeat(64), ownership: "bflow", bridgeRequired: true },
      authentication: { mode: "none" }, healthTimeoutMs: 10_000, idleTimeoutMs: 60_000, restartLimit: 0 });
    const input = configure(environment => {
      delete environment.context7;
      environment.roles.push({ role: "tester", cli: "codex" });
      const body = { schemaVersion: 3 as const, repositoryId: base.repository.id,
        scope: { kind: "repository" as const, machineId: context.machineId, repositoryId: base.repository.id, workspaceRoot: base.repository.root },
        requirements: [{ toolId: "browser", kind: "stdio_mcp" as const, serviceId: service.serviceId, operations: ["list_pages"],
          requiredness: "optional" as const, roles: ["tester" as const], triggers: ["browser_inspection" as const] }] };
      environment.toolPolicy = RepositoryToolPolicySchema.parse({ ...body, digest: digest(body) });
    });
    const statuses: Parameters<NonNullable<import("../src/platform-options.js").HostPlatformDeps["onToolStatus"]>>[0][] = [];
    const options = await buildHostPlatformOptions(input, { context: { ...context, mcpServices: [service],
      serviceReadiness: new Map([[service.serviceId, { status: "ready", discoveredTools: service.tool.operations }]]) }, fileExists: absent,
      onToolStatus: status => statuses.push(status) });
    const tester = options.roles.find(role => role.role === "tester")!;
    expect(tester.toolIds).toEqual([]);
    expect(tester.skillSelections.map(selection => selection.skill.skillId)).not.toContain("browser-inspection");
    expect(options.toolGrants?.find(grant => grant.role === "tester")).toBeUndefined();
    expect(statuses.find(status => status.toolId === "browser")).toMatchObject({ granted: false, ready: false,
      reason: expect.stringContaining("exclusive MCP resources are not yet supported") });
    const requiredInput = configure(environment => {
      delete environment.context7;
      environment.roles.push({ role: "tester", cli: "codex" });
      const body = { schemaVersion: 3 as const, repositoryId: base.repository.id,
        scope: { kind: "repository" as const, machineId: context.machineId, repositoryId: base.repository.id, workspaceRoot: base.repository.root },
        requirements: [{ toolId: "browser", kind: "stdio_mcp" as const, serviceId: service.serviceId, operations: ["list_pages"],
          requiredness: "required" as const, roles: ["tester" as const], triggers: ["browser_inspection" as const] }] };
      environment.toolPolicy = RepositoryToolPolicySchema.parse({ ...body, digest: digest(body) });
    });
    await expect(buildHostPlatformOptions(requiredInput, { context: { ...context, mcpServices: [service],
      serviceReadiness: new Map([[service.serviceId, { status: "ready", discoveredTools: service.tool.operations }]]) }, fileExists: absent }))
      .rejects.toThrow(/Required tool 'browser'.*exclusive MCP resources are not yet supported/i);
  });

  it("grants exclusive gitnexus resources through the Runtime lease path when ready", async () => {
    const service = MCPServiceDefinitionSchema.parse({ schemaVersion: 3, serviceId: "gitnexus-repo", revision: 1,
      scope: { kind: "machine", machineId: context.machineId },
      tool: { schemaVersion: 3, toolId: "gitnexus", kind: "stdio_mcp", version: "1.6.12",
        operations: ["query", "context", "impact"], required: true,
        resource: { sharing: "exclusive", resourceKey: "gitnexus-repo" } },
      connection: { kind: "stdio_mcp", executable: "/machine/gitnexus", argv: ["mcp"], environmentBindings: {},
        executableDigest: "b".repeat(64), ownership: "bflow", bridgeRequired: true },
      authentication: { mode: "none" }, healthTimeoutMs: 10_000, idleTimeoutMs: 60_000, restartLimit: 0 });
    const input = configure(environment => {
      delete environment.context7;
      const body = { schemaVersion: 3 as const, repositoryId: base.repository.id,
        scope: { kind: "repository" as const, machineId: context.machineId, repositoryId: base.repository.id, workspaceRoot: base.repository.root },
        requirements: [{ toolId: "gitnexus", kind: "stdio_mcp" as const, operations: ["query", "context", "impact"],
          requiredness: "optional" as const, roles: ["developer" as const], triggers: ["code_relationships" as const] }] };
      environment.toolPolicy = RepositoryToolPolicySchema.parse({ ...body, digest: digest(body) });
    });
    const statuses: Parameters<NonNullable<import("../src/platform-options.js").HostPlatformDeps["onToolStatus"]>>[0][] = [];
    const options = await buildHostPlatformOptions(input, { context: { ...context, mcpServices: [service],
      serviceReadiness: new Map([[service.serviceId, { status: "ready", discoveredTools: service.tool.operations }]]) }, fileExists: absent,
      onToolStatus: status => statuses.push(status) });
    expect(options.toolGrants?.find(grant => grant.role === "developer" && grant.toolId === "gitnexus"))
      .toMatchObject({ serviceId: "gitnexus-repo", operations: ["query", "context", "impact"], triggers: ["code_relationships"] });
    expect(statuses.find(status => status.toolId === "gitnexus")).toMatchObject({ granted: true, ready: true });
  });

  it("reports installed, allowed, granted and ready as separate policy observations", async () => {
    const input = configure(environment => {
      delete environment.context7;
      const body = { schemaVersion: 3 as const, repositoryId: base.repository.id,
        scope: { kind: "repository" as const, machineId: context.machineId, repositoryId: base.repository.id, workspaceRoot: base.repository.root },
        requirements: [{ toolId: "rtk", kind: "cli_only" as const, operations: ["test"], requiredness: "required" as const,
          roles: ["developer" as const], triggers: ["routine_command" as const] }] };
      environment.toolPolicy = RepositoryToolPolicySchema.parse({ ...body, digest: digest(body) });
    });
    const statuses: Parameters<NonNullable<Parameters<typeof resolveToolGrants>[5]>>[0][] = [];
    const grants = resolveToolGrants(input.config.environment.toolPolicy, { ...context, toolInventory: new Map() }, input,
      undefined, undefined, status => statuses.push(status), false);
    expect(grants).toEqual([]);
    expect(statuses).toEqual([{ role: "developer", toolId: "rtk", requiredness: "required", installed: false,
      allowed: true, granted: false, ready: false, reason: "no verified machine executable identity is available" }]);
  });

  it("applies environment-wide required skills and permissions without creating tool grants", async () => {
    const input = configure(environment => {
      environment.permissions = { mode: "restricted" };
      environment.skills = { requiredSkills: ["inspect-repository"] };
    });
    const options = await buildHostPlatformOptions(input, { context, fileExists: absent });
    for (const role of options.roles) {
      expect(role.permissionMode).toBe("restricted");
      expect(role.mcpServiceIds).toEqual([]);
      expect(role.toolIds).toEqual([]);
      const skillIds = role.skillSelections.map(item => item.skill.skillId);
      expect(skillIds).toContain("using-bflow");
      expect(skillIds.includes("inspect-repository")).toBe(role.role !== "conversation");
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

  it("keeps native Codex hook authority anchored to the real home inside an isolator shell", () => {
    expect(resolveCodexTrustPaths({ environment: { AI_ISOLATOR: "1", AI_ISOLATOR_REAL_HOME: "/home/native" },
      homeDirectory: "/isolator/profiles/codex--personal/home", processHomeDirectory: "/isolator/profiles/codex--personal/home",
      machineStateDirectory: "/temporary/state/bflow" })).toMatchObject({ codexHomeDirectory: "/home/native/.codex",
      codexHookApprovalPath: "/home/native/.local/state/bflow/codex-hook-approvals.json" });
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
  const readyContext = () => ({
    ...context,
    mcpServices: [MCPServiceDefinitionSchema.parse({ schemaVersion: 3, serviceId: "context7", revision: 1,
      scope: { kind: "machine", machineId: context.machineId },
      tool: { schemaVersion: 3, toolId: "context7", kind: "native_remote_mcp", version: "1", operations: ["resolve-library-id", "query-docs"],
        required: true, resource: { sharing: "concurrent", maxConcurrency: 8 } },
      connection: { kind: "native_remote_mcp", endpoint: "https://mcp.context7.com/mcp", ownership: "external" },
      authentication: { mode: "none" }, healthTimeoutMs: 10_000, idleTimeoutMs: 60_000, restartLimit: 0 })],
    serviceReadiness: new Map([["context7", { status: "ready" as const, discoveredTools: ["resolve-library-id", "query-docs"] }]])
  });

  it("is on in a repository created by init, as an optional service", () => {
    expect(base.config.environment?.context7).toEqual({
      enabled: true,
      required: false,
      cache: { enabled: false, ttlSeconds: 3_600, allowAuthenticated: false }
    });
    expect(base.config.environment?.tools).toEqual({
      rtk: { enabled: true, required: false },
      gitnexus: { enabled: true, required: false },
      mempalace: { enabled: true, required: false },
      "chrome-devtools-mcp": { enabled: true, required: false }
    });
  });

  it("grants the catalog ID and exact service operations only to policy roles", async () => {
    const options = await buildHostPlatformOptions(enabled(), { context: readyContext(), fileExists: absent });
    const roles = roleMap(options);
    for (const role of ["specifier", "architect", "planner", "developer", "reviewer", "qa"]) {
      expect(roles[role]?.mcpServiceIds, role).toEqual(["context7"]);
      expect(roles[role]?.toolIds, role).toEqual(["context7"]);
    }
    for (const role of ["conversation", "coordinator"]) {
      expect(roles[role]?.mcpServiceIds, role).toEqual([]);
      expect(roles[role]?.toolIds, role).toEqual([]);
    }
    expect(options.toolGrants?.filter(grant => grant.toolId === "context7").every(grant =>
      grant.serviceId === "context7" && grant.operations.join(",") === "resolve-library-id,query-docs")).toBe(true);
    expect(AgenticHostPlatformOptionsSchema.parse(options)).toEqual(options);
  });

  it("starts without an optional legacy Context7 tool and records its degraded reason", async () => {
    const warnings: string[] = [];
    const options = await buildHostPlatformOptions(enabled({ required: false }), { context, fileExists: absent, context7Ready: false, warn: message => warnings.push(message) });
    expect(options.roles.every(role => role.mcpServiceIds.length === 0 && role.toolIds.length === 0)).toBe(true);
    expect(warnings.some(message => /Context7.*degraded|Optional tool 'context7'.*degraded/i.test(message))).toBe(true);
    const unknown = await buildHostPlatformOptions(enabled(), { context, fileExists: absent, warn: message => warnings.push(message) });
    expect(roleMap(unknown)["developer"]?.mcpServiceIds).toEqual([]);
    expect(warnings.length).toBeGreaterThan(1);
  });

  it("blocks a required legacy Context7 policy when its service is missing", async () => {
    const warnings: string[] = [];
    await expect(buildHostPlatformOptions(enabled({ required: true }), { context, fileExists: absent, context7Ready: false, warn: message => warnings.push(message) }))
      .rejects.toThrow(/Required tool 'context7'.*unavailable/i);
    expect(warnings).toEqual([]);
  });

  it("changes nothing for a repository that has not enabled it", async () => {
    for (const edit of [(environment: EnvironmentCompositionInput["config"]["environment"]) => { delete environment.context7; },
      (environment: EnvironmentCompositionInput["config"]["environment"]) => { environment.context7 = { enabled: false, required: true }; }]) {
      const warnings: string[] = [];
      const options = await buildHostPlatformOptions(configure(edit), { context, fileExists: absent, context7Ready: true, warn: message => warnings.push(message) });
      expect(options.roles.every(role => role.mcpServiceIds.length === 0)).toBe(true);
      expect(warnings.some(message => /skipped because tool .* has no approved grant/i.test(message))).toBe(true);
    }
  });

  it("allows all integrated tools by default when omitted from config, and disables only those explicitly set to enabled: false", async () => {
    const omittedConfig = configure(environment => {
      delete environment.toolPolicy;
      delete environment.tools;
      delete environment.context7;
    });
    const defaultPolicy = resolveRepositoryToolPolicy(omittedConfig, context.machineId);
    expect(defaultPolicy?.requirements.map(item => item.toolId)).toEqual([
      "context7",
      "rtk",
      "gitnexus",
      "mempalace",
      "chrome-devtools-mcp"
    ]);
    expect(defaultPolicy?.requirements.every(item => item.requiredness === "optional")).toBe(true);

    const selectiveDisable = configure(environment => {
      delete environment.toolPolicy;
      environment.context7 = { enabled: false };
      environment.tools = {
        rtk: { enabled: false },
        gitnexus: { enabled: true, required: true },
        mempalace: { enabled: false },
        "chrome-devtools-mcp": { enabled: true, required: false }
      };
    });
    const selectivePolicy = resolveRepositoryToolPolicy(selectiveDisable, context.machineId);
    expect(selectivePolicy?.requirements.map(item => ({ toolId: item.toolId, requiredness: item.requiredness }))).toEqual([
      { toolId: "gitnexus", requiredness: "required" },
      { toolId: "chrome-devtools-mcp", requiredness: "optional" }
    ]);

    const allDisabled = configure(environment => {
      delete environment.toolPolicy;
      environment.context7 = { enabled: false };
      environment.tools = {
        rtk: { enabled: false },
        gitnexus: { enabled: false },
        mempalace: { enabled: false },
        "chrome-devtools-mcp": { enabled: false }
      };
    });
    expect(resolveRepositoryToolPolicy(allDisabled, context.machineId)).toBeUndefined();
  });
});
