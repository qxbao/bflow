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
  it("routes pre-run planning memory reads through an activated session grant", async () => {
    const calls: unknown[][] = [];
    const grantId = "grant-memory-search";
    const service = fakeService({
      status: () => ({ generation: 1, launches: [{ launchId: "launch-coord", role: "coordinator", provider: "codex", state: "activated" }] }),
      assertFresh: () => ({ ok: true, value: {} as never }),
      verifyGateway: async () => ({ ok: true, value: { checkedAt: at, healthy: true, lost: [], uncertain: false } }),
      invokeTool: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: true, value: { schemaVersion: 3, callId: "call-memory", status: "completed", output: { results: [] }, observedAt: at } };
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
    let launches: PreparedRoleLaunch[] = [{ ...prepared("conversation", "codex", "launch-conv"), gateway: { registrations: [registration], observations: [], tokenEnvironment: {} } } as unknown as PreparedRoleLaunch];
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
