import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentEnvironmentSchema, SkillManifestSchema } from "@bflow/contracts";
import { createFakeProviderRunner, type ProviderCommandRunner } from "@bflow/agent-providers";
import type { AgentRole, ContractError, MCPClientRegistration, OperationResult } from "@bflow/contracts";
import type { PlatformReadinessService, PreparedRoleLaunch, RolePlatformRequirement } from "../../src/platform/index.js";
import { tokenEnvironmentName } from "../../src/platform/gateway-registrations.js";
import {
  AgenticHostPlatformOptionsSchema,
  PlatformRoleOptionSchema,
  type PlatformRoleOption,
  type AgenticHostPlatformOptions
} from "../../src/platform/host-options.js";
import { ResolvedToolGrantSchema, RepositoryToolPolicySchema } from "@bflow/contracts";
import {
  HostPlatformSession, skillSupportedCommands, HostPlatformStatusSchema, launchMaterial, liveObservation, requirementFor,
  createHostProviderFactoryOptions, createHostProviderAdapterFactory
} from "../../src/agentic/host-platform.js";
import { describeToolActions, validateMemoryActionOutput } from "../../src/agentic/tool-action-policy.js";
import { readPinnedInstructionReply } from "../../src/agentic/host.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

const at = "2026-10-18T00:00:00.000Z";
const token = "bearer-secret-value-0123456789";
const roleOption = (role: AgentRole, provider: "claude" | "codex" | "agy", required = true): PlatformRoleOption => ({
  role, provider, required, permissionMode: "restricted", capabilityIds: [`${role}-cap`], mcpServiceIds: [], toolIds: [],
  skillSelections: []
});
const platform: AgenticHostPlatformOptions = {
  schemaVersion: 3, machineId: "machine-1", repositoryId: "repo-1",
  roles: [roleOption("conversation", "codex"), roleOption("coordinator", "codex"), roleOption("developer", "codex", false)],
  skillsStoreRoot: "/var/lib/bflow/skills-store", approvedBuiltinSkillDigests: []
};

describe("profile selection ingress", () => {
  it("accepts only exported tool policy and grant schemas on the host wire", () => {
    const scope = { kind: "session", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo", sessionId: "session-1" };
    const policy = RepositoryToolPolicySchema.parse({ schemaVersion: 3, repositoryId: "repo-1", scope: { kind: "repository", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo" },
      digest: "a".repeat(64), requirements: [{ toolId: "context7", requiredness: "optional", roles: ["coordinator"], triggers: ["external_documentation"], operations: ["query_docs"], kind: "native_remote_mcp", serviceId: "context7" }] });
    const grant = ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId: "grant-context7", policyDigest: "a".repeat(64), toolId: "context7",
      kind: "native_remote_mcp", requiredness: "optional", role: "coordinator", scope, triggers: ["external_documentation"],
      serviceId: "context7", operations: ["query_docs"] });
    expect(AgenticHostPlatformOptionsSchema.parse({ ...platform, toolPolicy: policy, toolGrants: [grant] })).toMatchObject({ toolPolicy: policy, toolGrants: [grant] });
    expect(AgenticHostPlatformOptionsSchema.safeParse({ ...platform, toolGrants: [{ ...grant, operations: [" "] }] }).success).toBe(false);
  });
  it("publishes only the authenticated role's scoped action descriptors without bearer or executable material", () => {
    const scope = { kind: "session" as const, machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo", sessionId: "session-1" };
    const policy = RepositoryToolPolicySchema.parse({ schemaVersion: 3, repositoryId: "repo-1",
      scope: { kind: "repository", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo" }, digest: "c".repeat(64),
      requirements: [{ toolId: "mempalace", kind: "native_remote_mcp", serviceId: "memory-service", operations: ["mempalace_search"],
        requiredness: "optional", roles: ["coordinator"], triggers: ["prior_context"],
        memoryScope: { wing: "engineering", repositoryId: "repo-1", access: "read_only" } }] });
    const grant = ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId: "memory-grant", policyDigest: policy.digest, toolId: "mempalace",
      kind: "native_remote_mcp", requiredness: "optional", role: "coordinator", scope, triggers: ["prior_context"], serviceId: "memory-service",
      operations: ["mempalace_search"], memoryScope: { wing: "engineering", repositoryId: "repo-1", access: "read_only" } });
    const descriptors = describeToolActions("coordinator", { ...platform, toolPolicy: policy, toolGrants: [grant] }, "session-1", "/repo");
    expect(descriptors).toMatchObject([{ toolId: "mempalace", kind: "native_remote_mcp", requiredness: "optional", triggers: ["prior_context"],
      operations: ["mempalace_search"], serviceId: "memory-service", memoryScope: { wing: "engineering", repositoryId: "repo-1", access: "read_only" },
      scope: { kind: "session", sessionId: "session-1", repositoryId: "repo-1", workspaceRoot: "/repo" }, status: "available" }]);
    expect(describeToolActions("developer", { ...platform, toolPolicy: policy, toolGrants: [grant] }, "session-1", "/repo")).toEqual([]);
    expect(JSON.stringify(descriptors)).not.toContain("bearer");
    expect(JSON.stringify(descriptors)).not.toContain("executablePath");

    const browserPolicy = RepositoryToolPolicySchema.parse({ ...policy, digest: "d".repeat(64), requirements: [{ ...policy.requirements[0]!,
      toolId: "browser", serviceId: "chrome-service", operations: ["list_pages"], triggers: ["browser_inspection"] }] });
    const browserGrant = ResolvedToolGrantSchema.parse({ ...grant, grantId: "browser-grant", toolId: "browser", policyDigest: browserPolicy.digest,
      serviceId: "chrome-service", operations: ["list_pages"], triggers: ["browser_inspection"] });
    expect(describeToolActions("coordinator", { ...platform, toolPolicy: browserPolicy, toolGrants: [browserGrant] }, "session-1", "/repo")[0])
      .toMatchObject({ status: "available" });
  });
  it("routes pre-run planning memory reads through an activated session grant", async () => {
    const calls: unknown[][] = [];
    const grantId = "grant-memory-search";
    const service = fakeService({
      status: () => ({ generation: 1, launches: [{ launchId: "launch-coord", role: "coordinator", provider: "codex", state: "activated" }] }),
      assertFresh: () => ({ ok: true, value: {} as never }),
      verifyGateway: async () => ({ ok: true, value: { checkedAt: at, healthy: true, lost: [], uncertain: false } }),
      invokeTool: async (...args: unknown[]) => {
        calls.push(args);
        const note = { drawer_id: "drawer-stub", text: "Sanitized result", wing: "engineering", room: "decisions",
          source_path: "/approved/notes/fixture.md", filed_at: at };
        return { ok: true, value: { schemaVersion: 3, callId: "call-memory", status: "completed",
          output: [{ type: "text", text: JSON.stringify({ results: [note] }) }], observedAt: at } };
      }
    });
    const { options } = await session(service);
    const scope = { kind: "session" as const, machineId: options.platform.machineId, repositoryId: options.platform.repositoryId,
      workspaceRoot: options.repositoryPath, sessionId: options.sessionId };
    const policy = RepositoryToolPolicySchema.parse({ schemaVersion: 3, repositoryId: options.platform.repositoryId,
      scope: { kind: "repository", machineId: options.platform.machineId, repositoryId: options.platform.repositoryId, workspaceRoot: options.repositoryPath },
      digest: "b".repeat(64), requirements: [{ toolId: "mempalace", kind: "native_remote_mcp", serviceId: "memory-service",
        operations: ["mempalace_search"], requiredness: "optional", roles: ["coordinator"], triggers: ["prior_context"],
        memoryScope: { wing: "engineering", repositoryId: options.platform.repositoryId, access: "read_only" } }] });
    const grant = ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId, policyDigest: policy.digest, toolId: "mempalace",
      kind: "native_remote_mcp", requiredness: "optional", role: "coordinator", scope, triggers: ["prior_context"],
      serviceId: "memory-service", operations: ["mempalace_search"],
      memoryScope: { wing: "engineering", repositoryId: options.platform.repositoryId, access: "read_only" } });
    const host = new HostPlatformSession({ ...options, platform: { ...platform, toolPolicy: policy, toolGrants: [grant] } });
    await host.prepare();

    const result = await host.invokeTool("coordinator", undefined, "mempalace", "memory-service", "mempalace_search", "prior_context",
      { wing: "engineering", query: "prior design decisions" }, "call-memory");

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject([expect.anything(), "coordinator", undefined, "memory-service", "mempalace_search",
      { wing: "engineering", query: "prior design decisions" }, "call-memory", { timeoutMs: 5_000 }]);
    expect(validateMemoryActionOutput(grant, "mempalace_search", result.value.output as never)?.[0]?.provenance)
      .toMatchObject({ wing: "engineering", repositoryId: options.platform.repositoryId, sourceId: "drawer-stub",
        repositoryBinding: "approved_wing_policy" });
  });
  it("binds browser transactions to the trusted resource and forwards completion", async () => {
    const calls: unknown[][] = [], finished: unknown[][] = [];
    const service = fakeService({
      status: () => ({ generation: 1, launches: [{ launchId: "launch-coord", role: "coordinator", provider: "codex", state: "activated" }] }),
      assertFresh: () => ({ ok: true, value: {} as never }),
      verifyGateway: async () => ({ ok: true, value: { checkedAt: at, healthy: true, lost: [], uncertain: false } }),
      invokeTool: async (...args: unknown[]) => { calls.push(args); return { ok: true, value: { schemaVersion: 3,
        callId: "browser-call", status: "completed", output: {}, observedAt: at } }; },
      finishToolTransaction: async (...args: unknown[]) => { finished.push(args); return { ok: true, value: undefined }; }
    });
    const { options } = await session(service);
    const scope = { kind: "session" as const, machineId: options.platform.machineId, repositoryId: options.platform.repositoryId,
      workspaceRoot: options.repositoryPath, sessionId: options.sessionId };
    const policy = RepositoryToolPolicySchema.parse({ schemaVersion: 3, repositoryId: options.platform.repositoryId,
      scope: { kind: "repository", machineId: scope.machineId, repositoryId: scope.repositoryId, workspaceRoot: scope.workspaceRoot }, digest: "b".repeat(64), requirements: [{ toolId: "chrome-devtools-mcp",
        kind: "stdio_mcp", serviceId: "chrome", operations: ["list_pages"], requiredness: "optional", roles: ["coordinator"], triggers: ["browser_inspection"] }] });
    const grant = ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId: "browser-grant", policyDigest: policy.digest,
      toolId: "chrome-devtools-mcp", kind: "stdio_mcp", requiredness: "optional", role: "coordinator", scope,
      triggers: ["browser_inspection"], serviceId: "chrome", operations: ["list_pages"] });
    const host = new HostPlatformSession({ ...options, platform: { ...platform, toolPolicy: policy, toolGrants: [grant], exclusiveMcpResources: { chrome: "machine-profile" } } });
    await host.prepare();
    expect((await host.invokeTool("coordinator", undefined, "chrome-devtools-mcp", "chrome", "list_pages", "browser_inspection", {}, "browser-call")).ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect((await host.invokeTool("coordinator", undefined, "chrome-devtools-mcp", "chrome", "list_pages", "browser_inspection", {}, "browser-call", false,
      undefined, "authenticated-attempt")).ok).toBe(true);
    expect(calls[0]?.at(-1)).toMatchObject({ timeoutMs: 5_000, browserTransaction: { id: "authenticated-attempt", resourceKey: "machine-profile" } });
    expect((await host.finishToolTransaction("coordinator", "authenticated-attempt")).ok).toBe(true);
    expect(finished[0]).toMatchObject([expect.anything(), "coordinator", "authenticated-attempt"]);
  });
  it("registers exact MCP operations while preserving catalog tool IDs", () => {
    const grant = ResolvedToolGrantSchema.parse({ schemaVersion: 3, grantId: "grant-context7", policyDigest: "a".repeat(64), toolId: "context7",
      kind: "native_remote_mcp", requiredness: "optional", role: "coordinator",
      scope: { kind: "session", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo", sessionId: "session-1" },
      triggers: ["external_documentation"], serviceId: "context7", operations: ["query_docs"] });
    const required = requirementFor({ ...roleOption("coordinator", "codex"), toolIds: ["context7"] },
      {}, "/repo", undefined, [grant]);
    expect(required.toolIds).toEqual(["context7"]);
    expect(required.mcpOperations).toEqual(["query_docs"]);
    expect(required.mcpServiceIds).toEqual(["context7"]);
    const legacyWithoutPolicy = requirementFor({ ...roleOption("coordinator", "codex"), mcpServiceIds: ["legacy-service"], toolIds: ["legacy-tool"] }, {}, "/repo");
    expect(legacyWithoutPolicy.mcpServiceIds).toEqual(["legacy-service"]);
    expect(legacyWithoutPolicy.toolGrants).toBeUndefined();
  });
  it("accepts safe profile names and rejects path/control characters", () => {
    expect(PlatformRoleOptionSchema.safeParse({ ...roleOption("coordinator", "codex"), profileName: "lead-1" }).success).toBe(true);
    expect(PlatformRoleOptionSchema.safeParse({ ...roleOption("coordinator", "codex"), profileName: "p".repeat(129) }).success).toBe(true);
    for (const profileName of ["", " ", "../work", "nested/name", "line\nbreak", "name\u0000"]) {
      expect(PlatformRoleOptionSchema.safeParse({ ...roleOption("coordinator", "codex"), profileName }).success).toBe(false);
    }
  });

  it("accepts only an absolute trusted isolator state root", () => {
    expect(AgenticHostPlatformOptionsSchema.safeParse({
      ...platform,
      isolatorStateRoot: "/machine/ai-isolator"
    }).success).toBe(true);
    expect(AgenticHostPlatformOptionsSchema.safeParse({
      ...platform,
      isolatorStateRoot: "relative/ai-isolator"
    }).success).toBe(false);
  });
});

describe("Codex hook trust propagation", () => {
  it("uses one explicit managed environment for inspection and launch without the outer Orca endpoint", () => {
    const input = { HOME: "/operator", PATH: "/trusted/bin:/usr/bin:/bin", ORCA_AGENT_HOOK_ROOT: "/outer", ORCA_AGENT_HOOK_ENDPOINT: "/outer/secret.env", ORCA_PANE_KEY: "outer-pane", ORCA_AGENT_HOOK_PORT: "4567" };
    const result = createHostProviderFactoryOptions({ ...platform, codexHomeDirectory: "/operator/.codex" }, input);
    expect(result.perProvider.codex.codexHookEnvironment).toMatchObject({ PATH: input.PATH, ORCA_AGENT_HOOK_ENDPOINT: "", ORCA_AGENT_HOOK_ROOT: "", ORCA_PANE_KEY: "", ORCA_AGENT_HOOK_PORT: "" });
    expect(result.codexLaunchEnvironment).toMatchObject(result.perProvider.codex.codexHookEnvironment);
    expect(input.ORCA_AGENT_HOOK_ENDPOINT).toBe("/outer/secret.env");
  });
  it("uses the same trusted home and approval store for permanent and dynamic Developer Codex adapters", () => {
    const permanent = { ...platform, codexHomeDirectory: "/machine/codex", codexHookApprovalPath: "/machine/state/codex-hook-approvals.json" };
    const withDeveloperTemplate = { ...permanent, roles: [...permanent.roles, roleOption("developer", "codex", false)] };
    const expected = { perProvider: { codex: {
      codexHomeDirectory: "/machine/codex", codexHookApprovalPath: "/machine/state/codex-hook-approvals.json",
      codexHookEnvironment: { HOME: "/machine/codex" }
    } }, codexLaunchEnvironment: { CODEX_HOME: "/machine/codex", HOME: "/machine/codex" } };
    expect(createHostProviderFactoryOptions(permanent, { HOME: "/machine/codex" })).toMatchObject(expected);
    expect(createHostProviderFactoryOptions(withDeveloperTemplate, { HOME: "/machine/codex" })).toMatchObject(expected);
  });

  it("builds the provider factory with trusted Codex paths for permanent and dynamic role requests", () => {
    const trustedPlatform = { ...platform, codexHomeDirectory: "/machine/codex",
      codexHookApprovalPath: "/machine/state/codex-hook-approvals.json" };
    const factory = createHostProviderAdapterFactory(trustedPlatform);
    expect(factory).toBeTypeOf("function");
    expect(factory("codex", {
      mcpRegistrations: [], mcpObservations: [], skillManifest: {} as never,
      renderedSkillsContent: "", trustedIssuerKeys: {}
    })).toMatchObject({ descriptor: { provider: "codex" } });
    expect(factory("codex", {
      mcpRegistrations: [], mcpObservations: [], skillManifest: {} as never,
      renderedSkillsContent: "", trustedIssuerKeys: {}
    })).toMatchObject({ descriptor: { provider: "codex" } });
  });

  it("checks authentication for each role without model execution during startup", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-coalescer-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home"), state = join(root, "state"), binary = join(root, "codex");
    await mkdir(home, { mode: 0o700 }); await mkdir(state, { mode: 0o700 });
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(join(home, "config.toml"), 'model = "gpt-6-luna"\n', { mode: 0o600 });
    await writeFile(join(home, "auth.json"), '{"account":"synthetic"}\n', { mode: 0o600 });
    let probes = 0, authentications = 0;
    const fake = createFakeProviderRunner();
    const runner: ProviderCommandRunner = { run: async invocation => {
      if (invocation.args.includes("ping")) { probes++; await new Promise(resolve => setTimeout(resolve, 100)); }
      if (invocation.args.join(" ") === "login status") authentications++;
      return fake.run(invocation);
    } };
    const factory = createHostProviderAdapterFactory({ ...platform, codexHomeDirectory: home,
      codexHookApprovalPath: join(root, "approvals.json") }, { runner, perProvider: { codex: { executablePath: binary } } },
      { HOME: root, PATH: process.env.PATH });
    const health = (role: "conversation" | "reviewer") => {
      const scope = { kind: "session", machineId: "machine", repositoryId: "repo", workspaceRoot: root, sessionId: "session" };
      const environment = AgentEnvironmentSchema.parse({ schemaVersion: 3, environmentId: `env-${role}`, provider: "codex", role, scope,
        cwd: root, stateDirectory: state, configFingerprint: "a".repeat(64),
        permissionProfile: { schemaVersion: 3, profileId: "permission", mode: "workspace_auto", scope, filesystem: "workspace_write",
          readableRoots: [root], writableRoots: [root], deniedRoots: [], isolation: "provider_policy", network: { mode: "deny", allowedHosts: [] },
          allowedTools: [], deniedAction: "request_via_conversation", allowGlobalPermissionBypass: false },
        environmentVariables: {}, secretBindings: {}, requiredCapabilityIds: [], requiredMcpServiceIds: [], skillManifestDigest: "0".repeat(64) });
      return factory("codex", { mcpRegistrations: [], mcpObservations: [], skillManifest: SkillManifestSchema.parse({ schemaVersion: 3, manifestId: `skills-${role}`,
        environmentId: environment.environmentId, scope, role, provider: "codex", digest: environment.skillManifestDigest, skills: [], bindings: [] }), renderedSkillsContent: "", trustedIssuerKeys: {},
        model: "gpt-6-luna", effort: "low" }).checkHealth({ schemaVersion: 3, environment, stage: "preflight", requestedAt: new Date().toISOString() });
    };
    const results = await Promise.all([health("conversation"), health("reviewer")]);
    expect(results.map(result => result.ok && result.value.status), JSON.stringify(results)).toEqual(["ready", "ready"]);
    expect(authentications).toBe(2);
    expect(probes).toBe(0);
    const final = await health("conversation");
    expect(final.ok && final.value.status).toBe("ready");
    expect(authentications).toBe(3);
    expect(probes).toBe(0);
  });

  it("coalesces Agy capability and models probes across roles in a shared auth-probe home", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-agy-coalescer-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home"), state = join(root, "state"), binary = join(root, "agy");
    await mkdir(join(home, ".gemini", "antigravity-cli", "cache"), { recursive: true, mode: 0o700 });
    await mkdir(state, { mode: 0o700 });
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(join(home, ".gemini", "antigravity-cli", "cache", "onboarding.json"), '{"onboardingComplete":true}\n', { mode: 0o600 });
    let modelsCalls = 0, versionCalls = 0, helpCalls = 0;
    const modelHomes: string[] = [];
    const fake = createFakeProviderRunner();
    const runner: ProviderCommandRunner = { run: async invocation => {
      if (invocation.args[0] === "--version") versionCalls++;
      if (invocation.args[0] === "--help") helpCalls++;
      if (invocation.args[0] === "models") {
        modelsCalls++;
        if (invocation.env?.["HOME"]) modelHomes.push(invocation.env["HOME"]);
        await new Promise(resolve => setTimeout(resolve, 25));
        // The native catalog must list the configured model; preflight rejects ids Agy would silently replace.
        return { exitCode: 0, started: true, stdout: "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n", stderr: "" };
      }
      return fake.run(invocation);
    } };
    const factory = createHostProviderAdapterFactory(platform, { runner, perProvider: { agy: { executablePath: binary } } }, { HOME: home, PATH: process.env.PATH });
    const checkRole = (role: "conversation" | "coordinator" | "planner") => {
      const scope = { kind: "session" as const, machineId: "machine", repositoryId: "repo", workspaceRoot: root, sessionId: "session" };
      const environment = AgentEnvironmentSchema.parse({ schemaVersion: 3, environmentId: `env-${role}`, provider: "agy", role, scope,
        cwd: root, stateDirectory: state, configFingerprint: "a".repeat(64),
        permissionProfile: { schemaVersion: 3, profileId: "permission", mode: "workspace_auto", scope, filesystem: "workspace_write",
          readableRoots: [root], writableRoots: [root], deniedRoots: [], isolation: "provider_policy", network: { mode: "deny", allowedHosts: [] },
          allowedTools: [], deniedAction: "request_via_conversation", allowGlobalPermissionBypass: false },
        environmentVariables: {}, secretBindings: {}, requiredCapabilityIds: [], requiredMcpServiceIds: [], skillManifestDigest: "0".repeat(64) });
      return factory("agy", { mcpRegistrations: [], mcpObservations: [], skillManifest: SkillManifestSchema.parse({ schemaVersion: 3, manifestId: `skills-${role}`,
        environmentId: environment.environmentId, scope, role, provider: "agy", digest: environment.skillManifestDigest, skills: [], bindings: [] }), renderedSkillsContent: "", trustedIssuerKeys: {},
        model: "gemini-3.8-flash-medium", isolatorEnvironment: { AI_ISOLATOR_REAL_HOME: home } }).checkHealth({ schemaVersion: 3, environment, stage: "preflight", requestedAt: new Date().toISOString() });
    };
    const outcomes = await Promise.all([checkRole("conversation"), checkRole("coordinator"), checkRole("planner")]);
    expect(outcomes.map(item => item.ok && item.value.status), JSON.stringify(outcomes)).toEqual(["ready", "ready", "ready"]);
    expect(modelsCalls).toBe(1);
    expect(versionCalls).toBe(1);
    expect(helpCalls).toBe(1);
    expect(modelHomes).toEqual([join(state, "agy-home", ".auth-probe")]);
  });

  it("keeps the operator HOME when only a Codex config home is selected", () => {
    const configured = { ...platform, codexHomeDirectory: "/machine/codex" };
    const options = createHostProviderFactoryOptions(configured, { HOME: "/operator/home" });
    expect(options.perProvider.codex.codexHookEnvironment.HOME).toBe("/operator/home");
    expect(options.codexLaunchEnvironment?.HOME).toBe("/operator/home");
  });

  it("keeps isolated Codex HOME and CODEX_HOME aligned with the inspected hook profile", () => {
    const isolated = { ...platform, codexHomeDirectory: "/isolated/providers/codex",
      codexProcessHomeDirectory: "/isolated/providers/home", codexHookApprovalPath: "/isolated/state/codex-hook-approvals.json" };
    expect(createHostProviderFactoryOptions(isolated)).toMatchObject({
      codexLaunchEnvironment: {
        CODEX_HOME: "/isolated/providers/codex",
        HOME: "/isolated/providers/home"
      },
      perProvider: { codex: { codexHomeDirectory: "/isolated/providers/codex",
        codexHookApprovalPath: "/isolated/state/codex-hook-approvals.json" } }
    });
  });
});
function prepared(role: AgentRole, provider: "claude" | "codex" | "agy", launchId: string): PreparedRoleLaunch {
  return {
    role, provider, required: true, environment: { environmentId: `env-${role}`, configFingerprint: "b".repeat(64) } as PreparedRoleLaunch["environment"],
    profile: { expiresAt: new Date(Date.now() + 60_000).toISOString(), configFiles: [] } as unknown as PreparedRoleLaunch["profile"],
    preflight: {} as PreparedRoleLaunch["preflight"], skills: {} as PreparedRoleLaunch["skills"], gateway: { registrations: [], observations: [], tokenEnvironment: {} },
    launch: { argv: ["--kind-independent", `--provider=${provider}`], env: { BFLOW_MCP_TOKEN_CHAT: token }, launchId, launchFingerprint: "a".repeat(64) }
  } as unknown as PreparedRoleLaunch;
}
function preparedAgy(role: AgentRole, launchId: string, home: string, provider: "claude" | "codex" | "agy" = "agy"): PreparedRoleLaunch {
  return { ...prepared(role, provider, launchId), profile: { configFiles: [
    { path: join(home, ".gemini", "config", "mcp_config.json"), digest: "c".repeat(64) }
  ] } as unknown as PreparedRoleLaunch["profile"] };
}
function failure(code: ContractError["code"], message: string, details?: Record<string, unknown>): OperationResult<never> {
  return { ok: false, error: { code, retryable: false, message, ...(details ? { details } : {}) } as ContractError };
}
interface FakeService extends PlatformReadinessService { calls: string[]; requirements: RolePlatformRequirement[][]; developerRequirements: RolePlatformRequirement[]; }
function fakeService(overrides: Partial<PlatformReadinessService> = {}): FakeService {
  const calls: string[] = [], requirements: RolePlatformRequirement[][] = [], developerRequirements: RolePlatformRequirement[] = [];
  const service = {
    calls, requirements, developerRequirements,
    prepareSession: async (_identity: unknown, reqs: RolePlatformRequirement[]) => {
      calls.push("prepareSession"); requirements.push(reqs);
      return { ok: true, value: { report: { ready: true, generation: 1, roles: [], checkedAt: at }, launches: [prepared("conversation", "codex", "launch-conv"), prepared("coordinator", "codex", "launch-coord")] } };
    },
    verifyActivated: async () => { calls.push("verifyActivated"); return { ok: true, value: {} as never }; },
    assertFresh: () => failure("not_found", "unused"),
    prepareDeveloper: async (_identity: unknown, requirement: RolePlatformRequirement) => {
      calls.push("prepareDeveloper"); developerRequirements.push(requirement);
      return { ok: true, value: prepared("developer", "codex", "launch-dev") };
    },
    releaseLaunch: async (launchId: string) => { calls.push(`release:${launchId}`); return { ok: true, value: undefined }; },
    shutdown: async () => { calls.push("shutdown"); return { ok: true, value: undefined }; },
    status: () => ({ generation: 1, launches: [{ launchId: "launch-conv", role: "conversation", provider: "codex", state: "intent" }] }),
    ...overrides
  } as unknown as FakeService;
  return service;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const permanentRoles: AgentRole[] = ["conversation", "coordinator", "planner", "architect", "specifier", "reviewer", "qa"];
type ActivatedHealth = Awaited<ReturnType<PlatformReadinessService["verifyActivated"]>>;
const readyHealth: ActivatedHealth = { ok: true, value: {} as never };
const flushActivation = () => new Promise<void>(resolve => setImmediate(resolve));

async function activationSession(roles = permanentRoles.map(role => roleOption(role, "codex")), omittedLaunches: readonly AgentRole[] = []) {
  const gates = new Map(roles.map(role => [`launch-${role.role}`, deferred<ActivatedHealth>()]));
  const inputs: Parameters<PlatformReadinessService["verifyActivated"]>[0][] = [];
  const preparedLaunches = roles.filter(role => role.role !== "developer" && !omittedLaunches.includes(role.role))
    .map(role => prepared(role.role, role.provider, `launch-${role.role}`));
  const service = fakeService({
    prepareSession: async () => ({ ok: true, value: {
      report: { ready: true, generation: 1, roles: [], checkedAt: at },
      launches: preparedLaunches
    } }),
    verifyActivated: async input => { inputs.push(input); return gates.get(input.launchId)!.promise; }
  });
  const { options } = await session(service);
  const host = new HostPlatformSession({ ...options, platform: { ...platform, roles } });
  await host.prepare();
  const panes = roles.map(role => ({ role: role.role, paneId: `pane-${role.role}` }));
  const observed: string[] = [];
  const observe = async (paneId: string) => {
    observed.push(paneId);
    return { status: "idle", nativeSession: { source: "herdr:codex", kind: "id" as const, value: `native-${paneId}` } };
  };
  const drain = () => { for (const gate of gates.values()) gate.resolve(readyHealth); };
  return { host, inputs, gates, panes, observed, observe, drain, options, preparedLaunches };
}

async function session(service: PlatformReadinessService, extra: Partial<{ generationFile: string; launchesFile: string; gatewayDiagnostic: string }> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-platform-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const options = {
    service, platform, repositoryPath: root, sessionId: "s1", stateDirectory: join(root, "state"),
    generationFile: join(root, "platform-generation.json"), launchesFile: join(root, "platform-launches.json"),
    probeDirectory: join(root, "probes"), reachabilityDirectory: join(root, "reachability"),
    hostCapabilities: { conversation: ["conversation"], coordinator: ["coordination"], developer: ["implementation"] },
    ...extra
  };
  return { root, host: new HostPlatformSession(options), options };
}

describe("P30 host platform composition", () => {
  it("returns only the active Agy launch home bound to its exact role and launch id", async () => {
    const permanentHome = "/private/agy/permanent";
    const developerHome = "/private/agy/developer";
    const service = fakeService({
      prepareSession: async () => ({ ok: true, value: {
        report: { ready: true, generation: 1, roles: [], checkedAt: at },
        launches: [preparedAgy("conversation", "agy-conversation", permanentHome), preparedAgy("coordinator", "agy-coordinator", "/private/agy/coord")]
      } }),
      prepareDeveloper: async () => ({ ok: true, value: preparedAgy("developer", "agy-developer", developerHome) })
    });
    const { host } = await session(service);
    await host.prepare();

    expect(host.nativeAgyLaunch("conversation", "agy-conversation")).toEqual({ home: permanentHome, launchId: "agy-conversation" });
    expect(host.nativeAgyLaunch("conversation", "stale-launch")).toBeUndefined();
    expect(host.nativeAgyLaunch("coordinator", "agy-conversation")).toBeUndefined();
    expect(host.nativeAgyLaunch("developer", "agy-developer")).toBeUndefined();

    await host.allocateDeveloper("task-1", "/worktrees/task-1");
    expect(host.nativeAgyLaunch("developer", "agy-developer")).toEqual({ home: developerHome, launchId: "agy-developer" });
    expect(host.nativeAgyLaunch("conversation", "agy-developer")).toBeUndefined();
    await host.releaseDeveloper("task-1");
    expect(host.nativeAgyLaunch("developer", "agy-developer")).toBeUndefined();
  });

  it("does not expose non-Agy homes and clears Agy homes on shutdown", async () => {
    const agyHome = "/private/agy/coordinator";
    const service = fakeService({
      prepareSession: async () => ({ ok: true, value: {
        report: { ready: true, generation: 1, roles: [], checkedAt: at },
        launches: [preparedAgy("conversation", "codex-conversation", "/private/codex/conversation", "codex"),
          preparedAgy("coordinator", "agy-coordinator", agyHome)]
      } })
    });
    const { host } = await session(service);
    await host.prepare();
    expect(host.nativeAgyLaunch("conversation", "codex-conversation")).toBeUndefined();
    expect(host.nativeAgyLaunch("coordinator", "agy-coordinator")).toEqual({ home: agyHome, launchId: "agy-coordinator" });
    await host.shutdown();
    expect(host.nativeAgyLaunch("coordinator", "agy-coordinator")).toBeUndefined();
  });

  it("drops stale permanent launch bindings when the generation is prepared again", async () => {
    let generation = 0;
    const service = fakeService({ prepareSession: async () => {
      generation++;
      const launchId = `agy-conversation-${generation}`;
      const home = `/private/agy/generation-${generation}`;
      return { ok: true, value: { report: { ready: true, generation, roles: [], checkedAt: at }, launches: [preparedAgy("conversation", launchId, home)] } };
    } });
    const { host } = await session(service);
    await host.prepare();
    expect(host.nativeAgyLaunch("conversation", "agy-conversation-1")).toEqual({ home: "/private/agy/generation-1", launchId: "agy-conversation-1" });
    await host.prepare();
    expect(host.nativeAgyLaunch("conversation", "agy-conversation-1")).toBeUndefined();
    expect(host.nativeAgyLaunch("conversation", "agy-conversation-2")).toEqual({ home: "/private/agy/generation-2", launchId: "agy-conversation-2" });
  });

  it("resumes a pending generation with revalidated env-bearing launches and no new dispatch material", async () => {
    const rechecked: string[] = [];
    const service = fakeService({ revalidatePreparedLaunch: async launchId => {
      rechecked.push(launchId);
      return { ok: true, value: prepared(launchId === "launch-conv" ? "conversation" : "coordinator", "codex", launchId) };
    } });
    const { host, options } = await session(service);
    const original = await host.prepare();
    const resumed = await host.resumePreparation();
    expect([...resumed!.launches.values()].map(value => value.launch)).toEqual([...original.launches.values()].map(value => value.launch));
    expect(rechecked.sort()).toEqual(["launch-conv", "launch-coord"]);
    expect(service.calls).toEqual(["prepareSession"]);
    expect(JSON.parse(await readFile(options.generationFile, "utf8")).generation).toBe(1);
    expect(await new HostPlatformSession(options).resumePreparation()).toBeUndefined();
  });

  it("refuses a retained generation when revalidation fails instead of silently rotating it", async () => {
    const service = fakeService({ revalidatePreparedLaunch: async () => failure("conflict", "profile changed") });
    const { host } = await session(service);
    await host.prepare();
    await expect(host.resumePreparation()).rejects.toThrow("profile changed");
    expect(host.launchIdOf("conversation")).toBe("launch-conv");
    expect(service.calls).toEqual(["prepareSession"]);
  });

  it("checks a completed role early but requires fresh health and attestation at the full manifest barrier", async () => {
    const fixture = await activationSession();
    const pane = fixture.panes[0]!;
    fixture.drain();
    await fixture.host.verifyRoleActivation(pane, fixture.observe);
    expect(fixture.inputs.map(input => input.launchId)).toEqual(["launch-conversation"]);
    await expect(fixture.host.verifyActivation([pane], fixture.observe)).rejects.toThrow("coordinator has no pane");
    await fixture.host.verifyActivation(fixture.panes, fixture.observe);
    expect(fixture.inputs.filter(input => input.launchId === "launch-conversation")).toHaveLength(2);
    expect(fixture.observed.filter(id => id === pane.paneId)).toHaveLength(2);
  });

  it("never substitutes cached activated health for the final fresh health check", async () => {
    const fixture = await activationSession();
    const pane = fixture.panes[0]!;
    const proof = { environmentId: "env-conversation", configFingerprint: "b".repeat(64), provider: "codex", role: "conversation", stage: "activated", status: "ready", validUntil: new Date(Date.now() + 60_000).toISOString(),
      launchAttestation: { sessionId: "s1", launchId: "launch-conversation", launchFingerprint: "a".repeat(64), paneId: pane.paneId,
        nativeSession: { source: "herdr:codex", kind: "id", value: `native-${pane.paneId}` } } };
    fixture.options.service.assertFresh = () => ({ ok: true, value: proof } as never);
    fixture.gates.get("launch-conversation")!.resolve({ ok: true, value: proof } as never);
    await fixture.host.verifyRoleActivation(pane, fixture.observe);
    fixture.options.service.verifyActivated = async input => {
      fixture.inputs.push(input);
      return failure("conflict", "permission changed since progressive check");
    };
    await expect(fixture.host.verifyActivation(fixture.panes, fixture.observe)).rejects.toThrow("permission changed since progressive check");
    expect(fixture.inputs.filter(input => input.launchId === "launch-conversation")).toHaveLength(2);
  });

  it("overlaps at most three activation checks, refills free slots and waits for every required role", async () => {
    const fixture = await activationSession();
    let settled = false;
    const outcome = fixture.host.verifyActivation(fixture.panes, fixture.observe).finally(() => { settled = true; });
    try {
      await flushActivation();
      expect(fixture.inputs.map(input => input.launchId)).toEqual(["launch-conversation", "launch-coordinator", "launch-planner"]);
      expect(fixture.observed).toHaveLength(3);
      // A later check frees a slot even while the first two are still pending.
      for (const [done, next] of [["planner", "architect"], ["architect", "specifier"], ["specifier", "reviewer"], ["reviewer", "qa"]]) {
        fixture.gates.get(`launch-${done}`)!.resolve(readyHealth);
        await flushActivation();
        expect(fixture.inputs.at(-1)?.launchId).toBe(`launch-${next}`);
      }
      fixture.gates.get("launch-conversation")!.resolve(readyHealth);
      fixture.gates.get("launch-coordinator")!.resolve(readyHealth);
      await flushActivation();
      expect(settled).toBe(false);
      fixture.gates.get("launch-qa")!.resolve(readyHealth);
      await outcome;
      expect(fixture.inputs).toHaveLength(7);
      for (const input of fixture.inputs) {
        const role = input.launchId.slice("launch-".length);
        expect(input).toMatchObject({ paneId: `pane-${role}`, nativeSession: { value: `native-pane-${role}` },
          observation: { paneId: `pane-${role}`, transportState: "idle", nativeSession: { value: `native-pane-${role}` } } });
      }
    } finally { fixture.drain(); await outcome; }
  });

  it.each(["health", "throw", "undefined"] as const)("drains in-flight checks and stops queued roles after a %s failure", async kind => {
    const fixture = await activationSession();
    let settled = false;
    const outcome = fixture.host.verifyActivation(fixture.panes, fixture.observe).then(
      () => { settled = true; return { ok: true as const }; },
      error => { settled = true; return { ok: false as const, error }; }
    );
    try {
      await flushActivation();
      expect(fixture.inputs).toHaveLength(3);
      const failed = fixture.gates.get("launch-coordinator")!;
      if (kind === "health") failed.resolve(failure("validation", "blocked-coordinator"));
      else failed.reject(kind === "throw" ? new Error("blocked-coordinator") : undefined);
      await flushActivation();
      expect(settled).toBe(false);
      expect(fixture.inputs).toHaveLength(3);
      fixture.drain();
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        if (kind === "undefined") expect(result.error).toBeUndefined();
        else expect(String(result.error)).toContain("blocked-coordinator");
      }
      expect(fixture.inputs).toHaveLength(3);
    } finally { fixture.drain(); await outcome; }
  });

  it("reports the first configured role failure after out-of-order failures have drained", async () => {
    const fixture = await activationSession();
    const outcome = fixture.host.verifyActivation(fixture.panes, fixture.observe).catch(error => error);
    try {
      await flushActivation();
      fixture.gates.get("launch-planner")!.resolve(failure("validation", "planner-failure"));
      await flushActivation();
      fixture.gates.get("launch-conversation")!.resolve(failure("validation", "conversation-failure"));
      fixture.drain();
      expect(String(await outcome)).toContain("conversation-failure");
      expect(fixture.inputs).toHaveLength(3);
    } finally { fixture.drain(); await outcome; }
  });

  it("bounds pane observations and drains them when one observation rejects", async () => {
    const fixture = await activationSession();
    const observations = new Map(fixture.panes.map(pane => [pane.paneId, deferred<Awaited<ReturnType<typeof fixture.observe>>>()]));
    const started: string[] = [];
    let settled = false;
    const outcome = fixture.host.verifyActivation(fixture.panes, paneId => {
      started.push(paneId); return observations.get(paneId)!.promise;
    }).then(() => { settled = true; }, error => { settled = true; return error; });
    try {
      await flushActivation();
      expect(started).toHaveLength(3);
      observations.get("pane-coordinator")!.reject(new Error("observation unavailable"));
      await flushActivation();
      expect(settled).toBe(false);
      for (const [paneId, gate] of observations) gate.resolve(await fixture.observe(paneId));
      fixture.drain();
      expect(String(await outcome)).toContain("observation unavailable");
      expect(started).toHaveLength(3);
    } finally {
      for (const [paneId, gate] of observations) gate.resolve(await fixture.observe(paneId));
      fixture.drain(); await outcome;
    }
  });

  it.each(["pane", "launch"] as const)("validates every required %s reference before starting any activation probe", async missing => {
    const fixture = await activationSession(undefined, missing === "launch" ? ["qa"] : []);
    fixture.drain();
    await expect(fixture.host.verifyActivation(missing === "pane" ? fixture.panes.slice(0, -1) : fixture.panes, fixture.observe))
      .rejects.toThrow(missing === "pane" ? "qa has no pane" : "qa has no prepared launch");
    expect(fixture.observed).toEqual([]);
    expect(fixture.inputs).toEqual([]);
  });

  it("excludes optional roles and the Developer template from activation", async () => {
    const fixture = await activationSession([roleOption("conversation", "codex"), roleOption("coordinator", "codex", false), roleOption("developer", "codex")]);
    fixture.drain();
    await fixture.host.verifyActivation(fixture.panes.slice(0, 1), fixture.observe);
    expect(fixture.inputs.map(input => input.launchId)).toEqual(["launch-conversation"]);
  });

  it("accepts an empty set of required permanent roles without observing or checking optional roles", async () => {
    const fixture = await activationSession([roleOption("conversation", "codex", false), roleOption("developer", "codex")]);
    await fixture.host.verifyActivation([], fixture.observe);
    expect(fixture.observed).toEqual([]);
    expect(fixture.inputs).toEqual([]);
  });

  it("prepares an all-Codex configuration into provider-neutral launch material with a ready report", async () => {
    const service = fakeService();
    const { host, root } = await session(service);
    const result = await host.prepare();
    expect(result.report.ready).toBe(true);
    expect(service.requirements[0]!.map(requirement => requirement.role)).toEqual(["conversation", "coordinator"]);
    expect(service.requirements[0]!.every(requirement => requirement.provider === "codex" && requirement.cwd === root)).toBe(true);
    const material = launchMaterial(result.launches.get("conversation")!);
    expect(material).toEqual({ provider: "codex", argv: ["--kind-independent", "--provider=codex"],
      env: { BFLOW_MCP_TOKEN_CHAT: token, BFLOW_LAUNCH_ID: "launch-conv", BFLOW_ENVIRONMENT_ID: "env-conversation" }, launchId: "launch-conv", launchFingerprint: "a".repeat(64) });
    expect(JSON.parse(await readFile(join(root, "platform-generation.json"), "utf8"))).toEqual({ generation: 1 });
    expect((await host.prepare()).report.ready).toBe(true);
    expect(JSON.parse(await readFile(join(root, "platform-generation.json"), "utf8"))).toEqual({ generation: 2 });
  });

  it("uses only the resolved Developer profile option and never infers one for an explicit role", async () => {
    const service = fakeService();
    const { host, root, options } = await session(service);
    const roles = [
      roleOption("conversation", "codex"),
      { ...roleOption("coordinator", "codex"), profileName: "lead" },
      roleOption("developer", "codex", false)
    ];
    const explicitHost = new HostPlatformSession({ ...options, service, platform: { ...platform, roles } });
    await explicitHost.prepare();
    await explicitHost.allocateDeveloper("explicit-dev", join(root, "explicit-worktree"));
    expect(service.developerRequirements.at(-1)?.profileName).toBeUndefined();

    const crossProviderHost = new HostPlatformSession({
      ...options,
      service,
      platform: { ...platform, roles: [...roles.slice(0, 2), { ...roles[2]!, provider: "claude" }] }
    });
    await crossProviderHost.prepare();
    await crossProviderHost.allocateDeveloper("cross-provider-dev", join(root, "cross-provider-worktree"));
    expect(service.developerRequirements.at(-1)?.profileName).toBeUndefined();

    const synthesizedHost = new HostPlatformSession({
      ...options,
      service,
      platform: { ...platform, roles: [...roles.slice(0, 2), { ...roles[2]!, profileName: "work" }] }
    });
    await synthesizedHost.prepare();
    await synthesizedHost.allocateDeveloper("synthesized-dev", join(root, "synthesized-worktree"));
    expect(service.developerRequirements.at(-1)?.profileName).toBe("work");
  });

  it("returns a not-ready report with no launch material when a required role is blocked", async () => {
    const service = fakeService({
      prepareSession: async () => ({ ok: true, value: { report: { ready: false, generation: 1, roles: [{ role: "conversation", provider: "codex", required: true, status: "blocked", checks: [] }], checkedAt: at }, launches: [] } }) as never
    });
    const { host } = await session(service);
    const result = await host.prepare();
    expect(result.report.ready).toBe(false);
    expect(result.launches.size).toBe(0);
  });

  it("never writes launch env, argv or bearer tokens to the private launch index", async () => {
    const { host, root } = await session(fakeService());
    await host.prepare();
    const index = await readFile(join(root, "platform-launches.json"), "utf8");
    expect(JSON.parse(index)).toEqual({ conversation: { launchId: "launch-conv", provider: "codex" }, coordinator: { launchId: "launch-coord", provider: "codex" } });
    expect(index).not.toContain(token);
    expect(index).not.toContain("env");
    expect((await readdir(root)).sort()).toEqual(["platform-generation.json", "platform-launches.json"]);
  });

  it("publishes a launch-keyed, token-free probe plan for a permanent role with registrations and removes it with its generation", async () => {
    const registration = {
      schemaVersion: 3, registrationId: "reg-conv0001", provider: "codex", role: "conversation", scope: { kind: "session" }, environmentId: "env-1",
      serviceIds: ["svc-1"], allowedTools: ["query"], connection: { transport: "streamable_http", endpoint: "http://127.0.0.1:7777/mcp", token: "secret://runtime/reg-conv0001" },
      configDigest: "a".repeat(64), expiresAt: at, idempotencyKey: "key-conv"
    } as unknown as MCPClientRegistration;
    const directLaunch = prepared("conversation", "codex", "launch-conv");
    const tokenEnvironment = { [tokenEnvironmentName(registration.registrationId)]: token };
    let launches: PreparedRoleLaunch[] = [{ ...directLaunch,
      gateway: { registrations: [registration], observations: [], tokenEnvironment },
      launch: { ...directLaunch.launch, env: tokenEnvironment }
    }];
    const service = fakeService({
      prepareSession: async () => ({ ok: true, value: { report: { ready: true, generation: 1, roles: [], checkedAt: at }, launches } }) as never
    });
    const { host, root } = await session(service);
    const result = await host.prepare();
    expect(result.reachability.get("conversation")).toEqual({ launchId: "launch-conv",
      entries: [{ registrationId: "reg-conv0001", envName: tokenEnvironmentName("reg-conv0001"), allowedTools: ["query"] }] });
    expect(result.reachability.has("coordinator" as AgentRole)).toBe(false);

    const planPath = join(root, "probes", "launch-conv.json");
    const plan = await readFile(planPath, "utf8");
    expect(plan).not.toContain(token);
    expect(JSON.parse(plan)).toMatchObject({ schemaVersion: 3, launchId: "launch-conv", endpoint: "http://127.0.0.1:7777/mcp" });
    expect((await stat(planPath)).mode & 0o777).toBe(0o600);

    // The next generation keeps the registration behind Runtime's broker, so the
    // provider receives no token and must not inherit the direct-access probe.
    launches = [{ ...launches[0]!, launch: { ...directLaunch.launch, env: {} } }];
    expect((await host.prepare()).reachability.size).toBe(0);
    await expect(stat(planPath)).rejects.toMatchObject({ code: "ENOENT" });

    launches = [];
    await host.prepare();
    await expect(stat(planPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("releases the previous generation's permanent launches before issuing a new set", async () => {
    const service = fakeService();
    const { host } = await session(service);
    await host.prepare();
    service.calls.length = 0;
    await host.prepare();
    expect(service.calls.slice(0, 2)).toEqual(["release:launch-conv", "release:launch-coord"]);
  });

  it("fails activation for a required role that is not activated-ready and reports the failing checks", async () => {
    const check = { check: "provider_authenticated", status: "failed", code: "auth_missing", message: "codex login is missing" };
    const service = fakeService({
      verifyActivated: async () => failure("validation", "activated readiness is blocked", { checks: [check] }) as never
    });
    const { host } = await session(service);
    await host.prepare();
    const panes = [{ role: "conversation" as const, paneId: "p1" }, { role: "coordinator" as const, paneId: "p2" }];
    const observe = async () => ({ name: "agent", status: "idle", nativeSession: { source: "herdr:codex", kind: "id" as const, value: "native-1" } });
    await expect(host.verifyActivation(panes, observe)).rejects.toThrow("activated-ready: activated readiness is blocked (provider_authenticated: codex login is missing)");
  });

  it("treats a still-starting transport as pending rather than failed", async () => {
    const service = fakeService({ verifyActivated: async () => failure("validation", "not yet ready") as never });
    const { host } = await session(service);
    await host.prepare();
    const panes = [{ role: "conversation" as const, paneId: "p1" }, { role: "coordinator" as const, paneId: "p2" }];
    const starting = async () => ({ status: "starting", nativeSession: { source: "herdr:codex", kind: "id" as const, value: "n" } });
    await expect(host.verifyActivation(panes, starting)).rejects.toThrow("[bflow:native-startup-pending]");
  });

  it("requires every required platform role to have a pane and a prepared launch before activation", async () => {
    const { host } = await session(fakeService());
    await host.prepare();
    const observe = async () => ({ status: "idle", nativeSession: { source: "herdr:codex", kind: "id" as const, value: "n" } });
    await expect(host.verifyActivation([{ role: "conversation", paneId: "p1" }], observe)).rejects.toThrow("Required platform role coordinator has no pane");
    await expect(host.verifyActivation([{ role: "conversation", paneId: "p1" }, { role: "coordinator", paneId: "p2" }], observe))
      .resolves.toBeUndefined();
    await new HostPlatformSession({ ...(await session(fakeService())).options, service: fakeService() }).verifyActivation(
      [{ role: "conversation", paneId: "p1" }, { role: "coordinator", paneId: "p2" }], observe)
      .then(() => { throw new Error("expected refusal"); }, error => expect(String(error)).toContain("has no prepared launch in this host process"));
  });

  it("launches a Developer only through prepareDeveloper and releases it by task", async () => {
    const service = fakeService();
    const { host } = await session(service);
    await host.prepare();
    const launch = await host.allocateDeveloper("task-1", "/worktrees/task-1");
    expect(launch.launchId).toBe("launch-dev");
    expect(service.calls).toContain("prepareDeveloper");
    await host.releaseDeveloper("task-1");
    expect(service.calls.at(-1)).toBe("release:launch-dev");
    await host.releaseDeveloper("task-1");
    expect(service.calls.filter(call => call === "release:launch-dev")).toHaveLength(1);
  });

  it("keeps concurrent Developer pinned instructions bound to their exact active launch", async () => {
    const service = fakeService({ prepareDeveloper: async (_identity, requirement) => {
      const id = requirement.taskId!;
      const value = prepared("developer", "codex", `launch-${id}`);
      const manifest = SkillManifestSchema.parse({ schemaVersion: 3, manifestId: `skills-${id}`, environmentId: `env-${id}`,
        scope: { kind: "session", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo", sessionId: "s1" },
        role: "developer", provider: "codex", digest: "0".repeat(64), skills: [], bindings: [] });
      return { ok: true, value: { ...value, skills: { manifest,
        rendered: { instructionText: `Instructions for ${id}`, references: [] }, diagnostics: [] } } };
    } });
    const { options } = await session(service);
    const manager = { verify: async (manifest: unknown) => SkillManifestSchema.parse(manifest) };
    const host = new HostPlatformSession(options, manager as never, {} as never);
    await host.prepare();
    await host.allocateDeveloper("first", "/worktrees/first");
    await host.allocateDeveloper("second", "/worktrees/second");
    expect(await host.readPinnedInstructions("developer", undefined, 0, 8192, "launch-first"))
      .toMatchObject({ launchId: "launch-first", instructionText: "Instructions for first" });
    expect(await host.readPinnedInstructions("developer", undefined, 0, 8192, "launch-second"))
      .toMatchObject({ launchId: "launch-second", instructionText: "Instructions for second" });
    expect(await host.readPinnedInstructions("developer")).toBeUndefined();
    expect(await host.readPinnedInstructions("developer", undefined, 0, 8192, "launch-foreign")).toBeUndefined();
    await expect(host.readPinnedInstructions("developer", "foreign-skill", 0, 8192, "launch-first")).rejects.toThrow("not selected");
    await host.releaseDeveloper("first");
    expect(await host.readPinnedInstructions("developer", undefined, 0, 8192, "launch-first")).toBeUndefined();
    expect(await host.readPinnedInstructions("developer", undefined, 0, 8192, "launch-second"))
      .toMatchObject({ instructionText: "Instructions for second" });
    await host.shutdown();
    expect(await host.readPinnedInstructions("developer", undefined, 0, 8192, "launch-second")).toBeUndefined();
  });

  it("pages verified SKILL.md by UTF-8 bytes without splitting characters and reassembles it exactly", async () => {
    const skillText = `# Kỹ năng\n${"Tiếng Việt — ký tự đa byte 🚀 ".repeat(300)}`;
    const service = fakeService({ prepareDeveloper: async (_identity, requirement) => {
      const id = requirement.taskId!;
      const value = prepared("developer", "codex", `launch-${id}`);
      const manifest = { manifestId: `skills-${id}`, digest: "0".repeat(64), role: "developer", provider: "codex",
        skills: [{ skillId: "vi-skill", version: "1.0.0", digest: "1".repeat(64) }] };
      return { ok: true, value: { ...value, skills: { manifest, rendered: { instructionText: "Instructions", references: [] }, diagnostics: [] } } };
    } });
    const { options } = await session(service);
    const host = new HostPlatformSession(options, { verify: async (manifest: unknown) => manifest } as never,
      { getBundle: async () => ({ "SKILL.md": skillText }) } as never);
    await host.prepare();
    await host.allocateDeveloper("task", "/worktrees/task");
    const read = (offset: number, limit: number) => host.readPinnedInstructions("developer", "vi-skill", offset, limit, "launch-task");
    expect(Buffer.byteLength(skillText)).toBeGreaterThan(skillText.length);
    // Offset 4 falls inside the three-byte character "ỹ" (bytes 3-5); the page starts at the next character boundary.
    expect(await read(4, 97)).toMatchObject({ skill: { offset: 6, content: expect.stringMatching(/^ năng/) } });
    // A limit smaller than one character still returns that whole character and makes progress.
    expect(await read(3, 1)).toMatchObject({ skill: { offset: 3, bytes: 3, content: "ỹ", nextOffset: 6 } });
    const parts: string[] = [];
    for (let offset = 0, more = true; more; ) {
      const skill = (await read(offset, 97))!.skill!;
      expect(skill.bytes).toBe(Buffer.byteLength(skill.content));
      expect(skill.offset).toBe(offset);
      parts.push(skill.content);
      more = skill.truncated;
      if (more) expect(skill.nextOffset).toBe(skill.offset + skill.bytes);
      else expect(skill.nextOffset).toBeUndefined();
      offset = skill.nextOffset ?? offset;
    }
    expect(parts.join("")).toBe(skillText);
    expect(await read(Buffer.byteLength(skillText), 8192)).toMatchObject({ skill: { bytes: 0, content: "", truncated: false } });
  });

  it("carries the configured Developer model and effort through dynamic task allocation", async () => {
    const service = fakeService();
    const { options } = await session(service);
    const configuredOptions = {
      ...options,
      platform: { ...platform, roles: platform.roles.map(role => role.role === "developer"
        ? { ...role, model: "developer-model", effort: "high" as const }
        : role) }
    };
    const host = new HostPlatformSession(configuredOptions);
    await host.prepare();
    await host.allocateDeveloper("task-model", "/worktrees/task-model");
    expect(service.developerRequirements[0]).toMatchObject({ model: "developer-model", effort: "high", taskId: "task-model" });
  });

  it("records Gateway registration loss and reports degraded launches by role and Developer launch", async () => {
    const service = fakeService({
      verifyGateway: async () => ({ ok: true, value: { checkedAt: at, healthy: false, uncertain: false,
        lost: [{ registrationId: "reg-1", role: "coordinator" }] } }),
      status: () => ({ generation: 1, launches: [
        { launchId: "launch-coord", role: "coordinator", provider: "codex", state: "degraded", reason: "gateway_registration_lost" },
        { launchId: "launch-dev", role: "developer", provider: "codex", taskId: "task-1", state: "degraded", reason: "gateway_registration_lost" },
        { launchId: "launch-conv", role: "conversation", provider: "codex", state: "activated" }] })
    });
    const { host } = await session(service);
    const check = await host.verifyGateway();
    expect(check).toMatchObject({ healthy: false, uncertain: false, lost: [{ registrationId: "reg-1", role: "coordinator" }] });
    expect(host.degradation()).toEqual({ roles: ["coordinator"], launchIds: ["launch-dev"] });
    expect(host.status().gateway).toMatchObject({ healthy: false });
  });

  it("treats a failed Gateway check as uncertain without degrading anything", async () => {
    const service = fakeService({ verifyGateway: async () => failure("transport_unavailable", "control down") as never });
    const { host } = await session(service);
    expect(await host.verifyGateway()).toMatchObject({ healthy: false, uncertain: true, lost: [] });
    expect(host.degradation()).toEqual({ roles: [], launchIds: [] });
  });

  it("retires a previous daemon's launches on startup and reports it", async () => {
    const retired: string[] = [];
    const service = fakeService({ reconcileAfterRestart: async () => { retired.push("reconcile");
      return { ok: true, value: { releasedLaunchIds: ["launch-old-dev"] } }; } });
    const first = await session(service);
    await first.host.prepare();
    // A new daemon over the same files.
    const second = new HostPlatformSession(first.options);
    await second.recoverPreviousDaemon();
    expect(retired).toEqual(["reconcile"]);
    expect(JSON.parse(await readFile(first.options.launchesFile, "utf8"))).toEqual({});
    expect(second.status().restartRecovery?.releasedLaunchIds.sort()).toEqual(["launch-conv", "launch-coord", "launch-old-dev"]);
  });

  it("does nothing on startup when the platform was never prepared", async () => {
    const retired: string[] = [];
    const service = fakeService({ reconcileAfterRestart: async () => { retired.push("reconcile"); return { ok: true, value: { releasedLaunchIds: [] } }; } });
    const { host } = await session(service);
    await host.recoverPreviousDaemon();
    expect(retired).toEqual([]);
    expect(host.status().restartRecovery).toBeUndefined();
  });

  it("releases the previous launch when the same task is allocated again", async () => {
    const service = fakeService();
    const { host } = await session(service);
    await host.prepare();
    await host.allocateDeveloper("task-1", "/worktrees/task-1");
    await host.allocateDeveloper("task-1", "/worktrees/task-1");
    const order = service.calls.filter(call => call === "prepareDeveloper" || call === "release:launch-dev");
    expect(order).toEqual(["prepareDeveloper", "release:launch-dev", "prepareDeveloper"]);
  });

  it("blocks a Developer allocation when readiness refuses it, without any launch", async () => {
    const service = fakeService({ prepareDeveloper: async () => failure("transport_unavailable", "codex not ready") as never });
    const { host } = await session(service);
    await host.prepare();
    await expect(host.allocateDeveloper("task-2", "/worktrees/task-2")).rejects.toThrow("Developer task-2 launch is blocked");
  });

  it("reports shutdown failures instead of swallowing them", async () => {
    const service = fakeService({ shutdown: async () => failure("transport_unavailable", "gateway unreachable") as never });
    const { host } = await session(service);
    await expect(host.shutdown()).rejects.toThrow("Platform shutdown failed: gateway unreachable");
  });

  it("exposes status without tokens and validates it against the wire schema", async () => {
    const { host } = await session(fakeService(), { gatewayDiagnostic: "Gateway control locator is absent; start the Gateway" });
    expect(host.status()).toEqual({ report: null, status: { generation: 1, launches: [{ launchId: "launch-conv", role: "conversation", provider: "codex", state: "intent" }] },
      gatewayDiagnostic: "Gateway control locator is absent; start the Gateway" });
    await host.prepare();
    const status = HostPlatformStatusSchema.parse(host.status());
    expect(JSON.stringify(status)).not.toContain(token);
  });

  it("builds Gateway-scoped requirements from the union of platform and host capabilities without undefined keys", () => {
    const requirement = requirementFor({ ...roleOption("coordinator", "codex"), skillSelections: [{ skill: { skillId: "s", version: "1.0.0", digest: "a".repeat(64) }, required: true }] },
      { coordinator: ["planning", "coordinator-cap"] }, "/repo");
    expect(requirement.capabilityIds).toEqual(["coordinator-cap", "planning"]);
    expect(requirement.skillSelections[0]).toEqual({ skill: { skillId: "s", version: "1.0.0", digest: "a".repeat(64) }, required: true });
    expect("approvalReceiptId" in requirement.skillSelections[0]!).toBe(false);
    expect("taskId" in requirement).toBe(false);
  });

  it("maps Herdr observations to readiness inputs and fails closed on unknown states", () => {
    expect(liveObservation("p1", { status: "idle", name: "coordinator", nativeSession: { source: "herdr:codex", kind: "id", value: "n" } }))
      .toEqual({ paneId: "p1", agentName: "coordinator", transportState: "idle", interactiveReady: true, nativeSession: { source: "herdr:codex", kind: "id", value: "n" } });
    expect(liveObservation("p1", { status: "starting" }).interactiveReady).toBe(false);
    expect(liveObservation("p1", { status: "exotic" }).transportState).toBe("unknown");
    expect(skillSupportedCommands({ ...platform, supportedCommands: ["skills sync"] })).toEqual(["skills sync"]);
    expect(skillSupportedCommands(platform)).toEqual([]);
  });
});

describe("read_pinned_instructions reply", () => {
  const pinned = (content: string, limit: number, offset = 0) => {
    const bytes = Buffer.from(content, "utf8");
    const end = Math.min(offset + limit, bytes.byteLength);
    return { manifestDigest: "d".repeat(64), instructionText: "I".repeat(5000), references: [{ name: "ref", description: "R".repeat(300), entrypoint: "x", digest: "e".repeat(64) }],
      skill: { skillId: "big", version: "1.0.0", digest: "f".repeat(64), offset, bytes: end - offset, content: bytes.subarray(offset, end).toString("utf8"),
        truncated: end < bytes.byteLength, ...(end < bytes.byteLength ? { nextOffset: end } : {}) } };
  };
  it("omits role instructions and the reference list from skill pages", async () => {
    const reply = await readPinnedInstructionReply({ role: "developer", skillId: "big", offset: 0, requestedLimit: 1024, isAgy: false,
      fallbackInstructions: "fallback", hasPlatform: true, read: async limit => pinned("a".repeat(4000), limit) });
    expect(Object.keys(reply).sort()).toEqual(["policy", "role", "skill", "skillManifestDigest", "source"]);
    expect(reply).toMatchObject({ role: "developer", skill: { bytes: 1024, truncated: true, nextOffset: 1024 } });
    const noSkill = await readPinnedInstructionReply({ role: "developer", offset: 0, requestedLimit: 8192, isAgy: false,
      fallbackInstructions: "fallback", hasPlatform: true, read: async limit => pinned("a".repeat(4000), limit) });
    expect(noSkill).toMatchObject({ instructions: "I".repeat(5000), skills: [expect.objectContaining({ name: "ref" })] });
  });
  it("keeps Agy skill replies inline and pages as large as the budget allows", async () => {
    const content = "Kỹ năng — ".repeat(2000);
    const reply = await readPinnedInstructionReply({ role: "reviewer", skillId: "big", offset: 0, requestedLimit: 16384, isAgy: true,
      fallbackInstructions: "fallback", hasPlatform: true, read: async limit => pinned(content, limit) });
    const size = Buffer.byteLength(JSON.stringify(reply));
    expect(size).toBeLessThanOrEqual(8500);
    expect(Buffer.byteLength((reply.skill as { content: string }).content)).toBeGreaterThan(4096);
    expect(reply).toMatchObject({ skill: { truncated: true, nextOffset: (reply.skill as { bytes: number }).bytes } });
  });
  it("rejects skills outside the verified manifest and missing launch context", async () => {
    await expect(readPinnedInstructionReply({ role: "developer", skillId: "foreign", offset: 0, requestedLimit: 1024, isAgy: false,
      fallbackInstructions: "", hasPlatform: false, read: async () => undefined })).rejects.toThrow("not selected");
    await expect(readPinnedInstructionReply({ role: "developer", offset: 0, requestedLimit: 1024, isAgy: false,
      fallbackInstructions: "", hasPlatform: true, read: async () => undefined })).rejects.toThrow("no verified pinned instruction context");
  });
});
