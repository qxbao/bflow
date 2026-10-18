import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRole, ContractError, MCPClientRegistration, OperationResult } from "@bflow/contracts";
import type { PlatformReadinessService, PreparedRoleLaunch, RolePlatformRequirement } from "../../src/platform/index.js";
import { tokenEnvironmentName } from "../../src/platform/gateway-registrations.js";
import type { PlatformRoleOption, AgenticHostPlatformOptions } from "../../src/platform/host-options.js";
import {
  HostPlatformSession, PLATFORM_SUPPORTED_COMMANDS, HostPlatformStatusSchema, launchMaterial, liveObservation, requirementFor
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
function prepared(role: AgentRole, provider: "claude" | "codex" | "agy", launchId: string): PreparedRoleLaunch {
  return {
    role, provider, required: true, environment: {} as PreparedRoleLaunch["environment"], profile: {} as PreparedRoleLaunch["profile"],
    preflight: {} as PreparedRoleLaunch["preflight"], skills: {} as PreparedRoleLaunch["skills"], gateway: { registrations: [], observations: [], tokenEnvironment: {} },
    launch: { argv: ["--kind-independent", `--provider=${provider}`], env: { BFLOW_MCP_TOKEN_CHAT: token }, launchId, launchFingerprint: "a".repeat(64) }
  } as unknown as PreparedRoleLaunch;
}
function failure(code: ContractError["code"], message: string, details?: Record<string, unknown>): OperationResult<never> {
  return { ok: false, error: { code, retryable: false, message, ...(details ? { details } : {}) } as ContractError };
}
interface FakeService extends PlatformReadinessService { calls: string[]; requirements: RolePlatformRequirement[][]; }
function fakeService(overrides: Partial<PlatformReadinessService> = {}): FakeService {
  const calls: string[] = [], requirements: RolePlatformRequirement[][] = [];
  const service = {
    calls, requirements,
    prepareSession: async (_identity: unknown, reqs: RolePlatformRequirement[]) => {
      calls.push("prepareSession"); requirements.push(reqs);
      return { ok: true, value: { report: { ready: true, generation: 1, roles: [], checkedAt: at }, launches: [prepared("conversation", "codex", "launch-conv"), prepared("coordinator", "codex", "launch-coord")] } };
    },
    verifyActivated: async () => { calls.push("verifyActivated"); return { ok: true, value: {} as never }; },
    assertFresh: () => failure("not_found", "unused"),
    prepareDeveloper: async () => { calls.push("prepareDeveloper"); return { ok: true, value: prepared("developer", "codex", "launch-dev") }; },
    releaseLaunch: async (launchId: string) => { calls.push(`release:${launchId}`); return { ok: true, value: undefined }; },
    shutdown: async () => { calls.push("shutdown"); return { ok: true, value: undefined }; },
    status: () => ({ generation: 1, launches: [{ launchId: "launch-conv", role: "conversation", provider: "codex", state: "intent" }] }),
    ...overrides
  } as unknown as FakeService;
  return service;
}
async function session(service: PlatformReadinessService, extra: Partial<{ generationFile: string; launchesFile: string; gatewayDiagnostic: string }> = {}) {
  const root = await mkdtemp(join(tmpdir(), "bflow-host-platform-"));
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
  it("prepares an all-Codex configuration into provider-neutral launch material with a ready report", async () => {
    const service = fakeService();
    const { host, root } = await session(service);
    const result = await host.prepare();
    expect(result.report.ready).toBe(true);
    expect(service.requirements[0]!.map(requirement => requirement.role)).toEqual(["conversation", "coordinator"]);
    expect(service.requirements[0]!.every(requirement => requirement.provider === "codex" && requirement.cwd === root)).toBe(true);
    const material = launchMaterial(result.launches.get("conversation")!);
    expect(material).toEqual({ provider: "codex", argv: ["--kind-independent", "--provider=codex"],
      env: { BFLOW_MCP_TOKEN_CHAT: token, BFLOW_LAUNCH_ID: "launch-conv" }, launchId: "launch-conv", launchFingerprint: "a".repeat(64) });
    expect(JSON.parse(await readFile(join(root, "platform-generation.json"), "utf8"))).toEqual({ generation: 1 });
    expect((await host.prepare()).report.ready).toBe(true);
    expect(JSON.parse(await readFile(join(root, "platform-generation.json"), "utf8"))).toEqual({ generation: 2 });
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
    expect(PLATFORM_SUPPORTED_COMMANDS).toContain("skills sync");
  });
});
