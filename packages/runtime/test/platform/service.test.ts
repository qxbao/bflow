import { testPython } from "../../../../tests/helpers/python-runtime.js";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEnvironment, AgentHealthRequest, AgentHealthResult, AgentLaunchProfile, AgentProviderAdapter, AgentProviderDescriptor,
  ContractError, MCPClientRegistration, MCPServiceObservation, MCPToolCall, OperationOptions, OperationResult, ResolvedToolGrant,
  ScopedOperation, TrustScope
} from "@bflow/contracts";
import { MCPServiceDefinitionSchema, RepositoryToolPolicySchema } from "@bflow/contracts";
import { createFakeProviderRunner, type ProviderCommandInvocation, type ProviderCommandRunner } from "@bflow/agent-providers";
import { BflowSharedMCPGateway, DefaultMCPServiceManager, GatewaySecretStore, StreamableHttpGatewayServer,
  SubprocessStdioDriverFactory } from "@bflow/mcp-gateway";
import { SkillFileStore, SkillManager, bundleDigest, type BundleFiles } from "@bflow/skills";
import { failWith, ok } from "../../src/platform/errors.js";
import { Ed25519LaunchAttestationSigner } from "../../src/platform/attestation-signer.js";
import { RoleEnvironmentResolver } from "../../src/platform/environment.js";
import { FileLaunchJournal } from "../../src/platform/launch-journal.js";
import { GatewayRegistrationManager } from "../../src/platform/gateway-registrations.js";
import { ProviderReadiness } from "../../src/platform/provider-readiness.js";
import { SkillSessionStore } from "../../src/platform/skills-session.js";
import { DefaultPlatformReadinessService, preparePrivateCodexHome } from "../../src/platform/service.js";
import { createProviderAdapterFactory, createSkillResolver } from "../../src/platform/defaults.js";
import type {
  GatewayControlPort, GatewayRegistrationGrant, PlatformSessionIdentity, ProviderAdapterContext, ProviderAdapterFactory,
  GatewayRegistrationPort, RolePlatformRequirement
} from "../../src/platform/ports.js";

const LIVE_READY = {
  paneId: "pane-developer-t1",
  transportState: "idle" as const,
  interactiveReady: true,
  nativeSession: { source: "claude", kind: "id" as const, value: "native-session-1" }
};
const NATIVE_SESSION = LIVE_READY.nativeSession;
const PANE_ID = "pane-developer-t1";
const ENDPOINT = "http://127.0.0.1:7777/mcp";

/** In-memory Gateway with stateful registrations; fails the next register when asked. */
class FakeGatewayControl implements GatewayControlPort {
  readonly registrations = new Map<string, { registration: MCPClientRegistration; bearerToken: string }>();
  readonly revokeCalls: string[] = [];
  services: MCPServiceObservation[] = [];
  failNextRegister: ContractError | undefined;
  registerCalls = 0;
  inspectCalls = 0;
  onRegister: (() => void) | undefined;

  async register(registration: MCPClientRegistration, _options?: OperationOptions):
    Promise<OperationResult<GatewayRegistrationGrant>> {
    this.registerCalls++;
    if (this.failNextRegister) {
      const failure = this.failNextRegister;
      this.failNextRegister = undefined;
      return failWith(failure);
    }
    const bearerToken = randomBytes(24).toString("hex");
    this.registrations.set(registration.registrationId, { registration, bearerToken });
    this.onRegister?.();
    return ok({ registration, bearerToken });
  }

  async revoke(registrationId: string, _operation: ScopedOperation, _options?: OperationOptions):
    Promise<OperationResult<void>> {
    this.revokeCalls.push(registrationId);
    if (!this.registrations.has(registrationId)) {
      return failWith({ code: "not_found", retryable: false, message: "registration not found" });
    }
    this.registrations.delete(registrationId);
    return ok(undefined);
  }

  async list(scope: TrustScope, _options?: OperationOptions): Promise<OperationResult<readonly MCPClientRegistration[]>> {
    return ok([...this.registrations.values()].map(entry => entry.registration)
      .filter(registration => JSON.stringify(registration.scope) === JSON.stringify(scope)));
  }

  async inspectServices(_operation: ScopedOperation, _options?: OperationOptions):
    Promise<OperationResult<readonly MCPServiceObservation[]>> {
    this.inspectCalls++;
    return ok(this.services);
  }

  tokens(): string[] {
    return [...this.registrations.values()].map(entry => entry.bearerToken);
  }

  /** Simulates a Gateway daemon restart: every registration and its bearer token is gone. */
  restart(): void {
    this.registrations.clear();
  }
}

function observation(serviceId: string, overrides: Partial<MCPServiceObservation> = {}): MCPServiceObservation {
  return {
    schemaVersion: 3,
    serviceId,
    revision: 1,
    instanceId: `${serviceId}-instance`,
    status: "ready",
    protocolVersion: "2025-06-18",
    discoveredTools: ["search", "read"],
    ownership: "bflow",
    activeClientCount: 0,
    observedAt: "2026-10-18T00:00:00.000Z",
    diagnosticCode: "ok",
    ...overrides
  };
}

const skillBody = (name: string) => `---\nname: ${name}\ndescription: Inspect an assigned task before implementation.\n---\n\n${[
  "Supported roles", "Prerequisites", "Trigger conditions", "Required inputs", "Expected outputs", "Procedure",
  "Bflow commands", "Verification requirements", "Error handling", "Escalation rules", "Concrete examples"
].map(h => `## ${h}\n\nUse the accepted task and preserve Runtime authority.`).join("\n\n")}\n`;

const skillFiles = (name: string): BundleFiles => ({
  "SKILL.md": skillBody(name),
  "skill.json": JSON.stringify({
    version: "1.0.0",
    allowedRoles: ["developer"],
    supportedProviders: ["claude", "codex", "agy"],
    requiredCapabilityIds: [],
    requiredToolIds: [],
    dependencies: []
  })
});

const HEALTH_CHECKS = ["binary", "version", "authentication", "environment", "mcp", "launch_arguments",
  "permissions", "skills", "native_binding"].map(check => ({
  check: check as "binary" | "version" | "authentication" | "environment" | "mcp" | "launch_arguments" |
    "permissions" | "skills" | "native_binding",
  status: "passed" as const,
  code: "ok",
  message: "passed"
}));

function contextProviderFactory(
  onContext: (provider: string, context: ProviderAdapterContext) => void,
  onHealth?: (request: AgentHealthRequest) => Promise<void> | void,
  onPrepare?: (environment: AgentEnvironment) => Promise<void> | void
): ProviderAdapterFactory {
  return (provider, context) => {
    onContext(provider, context);
    const adapter: AgentProviderAdapter = {
      descriptor: {} as AgentProviderDescriptor,
      async checkHealth(request): Promise<OperationResult<AgentHealthResult>> {
        await onHealth?.(request);
        const checkedAt = new Date();
        return ok({
          schemaVersion: 3,
          environmentId: request.environment.environmentId,
          provider: request.environment.provider,
          role: request.environment.role,
          configFingerprint: request.environment.configFingerprint,
          stage: request.stage,
          status: "ready",
          checkedAt: checkedAt.toISOString(),
          validUntil: new Date(checkedAt.getTime() + 60_000).toISOString(),
          checks: HEALTH_CHECKS
        });
      },
      async prepareLaunch(environment: AgentEnvironment): Promise<OperationResult<AgentLaunchProfile>> {
        await onPrepare?.(environment);
        return ok({
          schemaVersion: 3,
          launchId: `launch-${environment.environmentId}`,
          environment,
          providerVersion: "1.0.0",
          executable: "/trusted/provider",
          executableDigest: "a".repeat(64),
          argv: [],
          configFiles: [],
          launchFingerprint: "b".repeat(64),
          interaction: environment.role === "conversation" ? "conversation" : "no_direct_user_input",
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        });
      }
    };
    return adapter;
  };
}

async function createIsolatorProfileAt(
  profileRoot: string,
  provider: "claude" | "codex" | "agy",
  name: string,
  metadata = `AI_ISOLATOR_TOOL=${provider}\nAI_ISOLATOR_PROFILE=${name}\nAI_ISOLATOR_CREATED_AT=2026-10-20T00:00:00Z\n`
): Promise<{ profileRoot: string; home: string }> {
  const home = join(profileRoot, "home");
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await chmod(profileRoot, 0o700);
  for (const directory of ["home", "config", "cache", "data", "state", "tmp"]) {
    const path = join(profileRoot, directory);
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  }
  await writeFile(join(profileRoot, "profile.env"), metadata, { mode: 0o600 });
  await chmod(join(profileRoot, "profile.env"), 0o664);
  if (provider === "agy") {
    await mkdir(join(home, ".gemini", "antigravity-cli"), { recursive: true, mode: 0o700 });
    await chmod(join(home, ".gemini"), 0o700);
    await chmod(join(home, ".gemini", "antigravity-cli"), 0o700);
  }
  return { profileRoot, home };
}

async function createIsolatorProfile(
  stateRoot: string,
  provider: "claude" | "codex" | "agy",
  name: string,
  metadata?: string
): Promise<{ profileRoot: string; home: string }> {
  const profileRoot = join(stateRoot, "profiles", `${provider}--${name}`);
  return createIsolatorProfileAt(profileRoot, provider, name, metadata);
}

describe("DefaultPlatformReadinessService", () => {
  let baseDir: string;
  let workspace: string;
  let binaryPath: string;
  let identity: PlatformSessionIdentity;
  let gatewayControl: FakeGatewayControl;
  let skillPin: { skillId: string; version: string; digest: string };
  let skillManager: SkillManager;
  let signer: Ed25519LaunchAttestationSigner;

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-platform-service-")));
    workspace = join(baseDir, "workspace");
    const stateDirectory = join(baseDir, "state");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(workspace, 0o700);
    await chmod(stateDirectory, 0o700);
    binaryPath = join(baseDir, "claude");
    await writeFile(binaryPath, "#!/bin/sh\necho ok\n", { mode: 0o700 });
    await chmod(binaryPath, 0o700);

    identity = {
      machineId: "machine-1",
      repositoryId: "repo-1",
      workspaceRoot: workspace,
      sessionId: "session-1",
      generation: 1,
      stateDirectory
    };
    const files = skillFiles("inspect-task");
    const digest = bundleDigest(files);
    skillManager = new SkillManager({
      store: new SkillFileStore(join(baseDir, "store")),
      supportedCommands: ["status", "help", "doctor"],
      approvedBuiltinDigests: [digest]
    });
    const installed = await skillManager.installBundle(files, { source: "builtin", expectedDigest: digest });
    skillPin = { skillId: installed.skillId, version: installed.version, digest: installed.digest };

    gatewayControl = new FakeGatewayControl();
    gatewayControl.services = [observation("svc-search")];
    signer = Ed25519LaunchAttestationSigner.generate("bflow-test-host");
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  function requirement(overrides: Partial<RolePlatformRequirement> = {}): RolePlatformRequirement {
    return {
      role: "developer",
      provider: "claude",
      required: true,
      permissionMode: "workspace_auto",
      cwd: workspace,
      taskId: "t1",
      capabilityIds: [],
      mcpServiceIds: [],
      toolIds: ["search"],
      skillSelections: [{ skill: skillPin, required: true }],
      ...overrides
    };
  }

  function buildService(options: {
    beforeSideEffect?: () => Promise<void>;
    runner?: ProviderCommandRunner;
    gateway?: boolean;
    gatewayPort?: GatewayRegistrationPort;
    now?: () => Date;
    codexLaunchEnvironment?: Readonly<Record<string, string>>;
    providerFactory?: ProviderAdapterFactory;
  } = {}): { service: DefaultPlatformReadinessService; journal: FileLaunchJournal } {
    const journal = new FileLaunchJournal(join(identity.stateDirectory, "launch-journal.jsonl"));
    const now = options.now ?? (() => new Date());
    const providers = new ProviderReadiness({
      factory: options.providerFactory ?? createProviderAdapterFactory({
        runner: options.runner ?? createFakeProviderRunner({ scenario: "healthy" }),
        now,
        perProvider: {
          claude: { executablePath: binaryPath, allowTestFilesystemOwnership: true },
          agy: { executablePath: binaryPath, allowTestFilesystemOwnership: true },
          codex: { executablePath: binaryPath, allowTestFilesystemOwnership: true,
            codexHomeDirectory: join(baseDir, "test-codex-home"),
            codexHookApprovalPath: join(identity.stateDirectory, "codex-hook-approvals.json") }
        }
      }),
      journal,
      now
    });
    const gateway = options.gatewayPort ?? (options.gateway === false
      ? undefined
      : new GatewayRegistrationManager({ control: gatewayControl, endpoint: ENDPOINT, now }));
    const service = new DefaultPlatformReadinessService({
      ...(options.beforeSideEffect ? { beforeSideEffect: options.beforeSideEffect } : {}),
      environments: new RoleEnvironmentResolver(),
      skills: new SkillSessionStore({ resolver: createSkillResolver(skillManager) }),
      ...(gateway ? { gateway } : {}),
      providers,
      journal,
      signer,
      ...(options.codexLaunchEnvironment !== undefined ? { codexLaunchEnvironment: options.codexLaunchEnvironment } : {}),
      rolePrompt: role => `Role prompt for ${role}.`,
      now
    });
    return { service, journal };
  }

  it("revalidates source inputs after skill preparation before any provider probe", async () => {
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const calls = vi.spyOn(runner, "run");
    let checks = 0;
    const { service } = buildService({ runner, beforeSideEffect: async () => {
      if (++checks === 2) throw new Error("execution_plan_drift");
    } });
    await expect(service.prepareSession(identity, [requirement()])).rejects.toThrow("execution_plan_drift");
    expect(calls).not.toHaveBeenCalled();
  });

  async function createActualScopedGatewayFixture(mode: "valid" | "missing-input-schema" | "unavailable-actual" | "unknown", exclusive = false) {
    const serviceId = "scoped-stdio-search";
    const counterPath = join(baseDir, `scope-calls-${mode}.txt`);
    const workerPath = join(baseDir, `scope-worker-${mode}.cjs`);
    const startCounterPath = join(baseDir, `scope-starts-${mode}.txt`);
    const workerSource = `
const fs = require("node:fs");
const readline = require("node:readline");
const mode = process.argv[2];
const counterPath = process.argv[3];
const startCounterPath = process.argv[4];
fs.appendFileSync(startCounterPath, "x");
const startNumber = fs.readFileSync(startCounterPath, "utf8").length;
const inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const tools = [{ name: "search", ...(mode === "missing-input-schema" ? {} : { inputSchema }) }];
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    const reply = mode === "unavailable-actual" && startNumber > 1
      ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "actual partition unavailable" } }
      : { jsonrpc: "2.0", id: message.id,
        result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "scope-worker", version: "1" } } };
    process.stdout.write(JSON.stringify(reply) + "\\n");
  } else if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } }) + "\\n");
  } else if (message.method === "tools/call") {
    fs.appendFileSync(counterPath, "x");
    if (mode === "unknown") return;
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id,
      result: { content: [{ type: "text", text: "actual-scope-result" }] } }) + "\\n");
  }
});
`;
    await writeFile(workerPath, workerSource, { mode: 0o700 });
    await writeFile(counterPath, "", { mode: 0o600 });
    const serviceDefinition = MCPServiceDefinitionSchema.parse({
      schemaVersion: 3, serviceId, revision: 1,
      scope: { kind: "machine", machineId: identity.machineId },
      tool: { schemaVersion: 3, toolId: "scope-search-tool", kind: "stdio_mcp", version: "1.0.0",
        operations: ["search"], resource: exclusive ? { sharing: "exclusive", resourceKey: "actual-browser-profile" } : { sharing: "concurrent", maxConcurrency: 2 }, required: true },
      connection: { kind: "stdio_mcp", executable: process.execPath,
        argv: [workerPath, mode, counterPath, startCounterPath],
        environmentBindings: {}, executableDigest: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
        ownership: "bflow", bridgeRequired: true },
      authentication: { mode: "none" }, healthTimeoutMs: 10_000, idleTimeoutMs: 60_000, restartLimit: 0
    });
    const secretStore = new GatewaySecretStore();
    const serviceManager = new DefaultMCPServiceManager({
      secretStore,
      driverFactory: new SubprocessStdioDriverFactory({ secretStore, defaultTimeoutMs: 10_000 })
    });
    const grantsByRegistration = new Map<string, readonly ResolvedToolGrant[]>();
    const gateway = new BflowSharedMCPGateway({
      serviceManager,
      secretStore,
      requireResolvedToolGrants: true,
      toolGrantResolver: registration => grantsByRegistration.get(registration.registrationId)
    });
    const registered = gateway.registry.registerService(serviceDefinition);
    if (!registered.ok) throw new Error(registered.error.message);

    const actualScope = { kind: "session" as const, machineId: identity.machineId, repositoryId: identity.repositoryId,
      workspaceRoot: identity.workspaceRoot, sessionId: identity.sessionId };
    const setupScope = { ...actualScope, repositoryId: "setup-repository", sessionId: "setup-gateway" };
    const operation = (scope: TrustScope, idempotencyKey: string) => ({ schemaVersion: 3 as const, scope, idempotencyKey });
    const actualOperation = operation(actualScope, "inspect-actual-scope");
    const setupOperation = operation(setupScope, "warm-setup-scope");
    const warmed = await serviceManager.ensure(serviceDefinition, setupOperation);
    if (!warmed.ok || warmed.value.status !== "ready") throw new Error(`Setup partition failed to warm: ${JSON.stringify(warmed)}`);

    const dataServer = new StreamableHttpGatewayServer({ gateway, host: "127.0.0.1", port: 0 });
    let controlServer: { locator: { token: string }; stop(): Promise<void> } | undefined;
    let runtimeControl: { list(scope: TrustScope): Promise<OperationResult<readonly MCPClientRegistration[]>>;
      inspectServices(operation: ScopedOperation): Promise<OperationResult<readonly MCPServiceObservation[]>>;
      invokeTool(call: MCPToolCall): Promise<OperationResult<import("@bflow/contracts").MCPToolCallResult>> } | undefined;
    let registrationManager: GatewayRegistrationManager | undefined;
    try {
      const endpoint = await dataServer.start();
      const { startGatewayControl } = await import(new URL("../../../../apps/cli/dist/gateway-control.js", import.meta.url).href);
      const stateRoot = join(baseDir, `scope-control-${mode}`);
      controlServer = await startGatewayControl({ gateway, stateRoot, machineId: identity.machineId,
        configDigest: "a".repeat(64), endpoint, workspaceRoot: identity.workspaceRoot,
        services: [serviceDefinition], grantMap: grantsByRegistration });
      const { GatewayControlClient } = await import(new URL("../../dist/platform/gateway-control-client.js", import.meta.url).href);
      const opened = await GatewayControlClient.fromLocator(join(stateRoot, "gateway-control.json"));
      if (!opened.ok) throw new Error(`Runtime could not open the real CLI Gateway control endpoint: ${opened.error.message}`);
      runtimeControl = opened.value;
      registrationManager = new GatewayRegistrationManager({ control: runtimeControl, endpoint });
    } catch (error) {
      await controlServer?.stop();
      await dataServer.stop();
      await serviceManager.stop(serviceId, setupOperation);
      await serviceManager.stop(serviceId, actualOperation);
      throw error;
    }

    return {
      serviceId, serviceDefinition, counterPath, actualScope, setupScope, actualOperation, setupOperation,
      gatewayControlToken: controlServer!.locator.token,
      gateway, serviceManager, runtimeControl: runtimeControl!, registrationManager: registrationManager!,
      grantsByRegistration,
      async cleanup() {
        await registrationManager!.revokeSession(identity).catch(() => undefined);
        await controlServer!.stop();
        await dataServer.stop();
        await serviceManager.stop(serviceId, setupOperation);
        await serviceManager.stop(serviceId, actualOperation);
      }
    };
  }

  function scopeSearchPolicyAndGrant(serviceId: string, scope: TrustScope) {
    const policy = RepositoryToolPolicySchema.parse({ schemaVersion: 3, repositoryId: identity.repositoryId,
      scope: { kind: "repository", machineId: identity.machineId, repositoryId: identity.repositoryId, workspaceRoot: identity.workspaceRoot },
      digest: "e".repeat(64), requirements: [{ toolId: "scope-search-tool", kind: "stdio_mcp", serviceId,
        operations: ["search"], requiredness: "required", roles: ["developer"], triggers: ["code_relationships"] }] });
    const grant: ResolvedToolGrant = { schemaVersion: 3, grantId: "grant-scoped-search", policyDigest: policy.digest,
      toolId: "scope-search-tool", kind: "stdio_mcp", requiredness: "required", role: "developer", scope,
      triggers: ["code_relationships"], serviceId, operations: ["search"] };
    return { policy, grant };
  }

  async function expectBlockedActualGatewayFixture(mode: "missing-input-schema" | "unavailable-actual"): Promise<void> {
    const fixture = await createActualScopedGatewayFixture(mode);
    try {
      const setupBefore = await fixture.runtimeControl.inspectServices(fixture.setupOperation);
      const actualBefore = await fixture.runtimeControl.inspectServices(fixture.actualOperation);
      expect(setupBefore.ok && setupBefore.value[0]?.status).toBe("ready");
      expect(actualBefore.ok && actualBefore.value[0]?.status).not.toBe("ready");
      const { policy, grant } = scopeSearchPolicyAndGrant(fixture.serviceId, fixture.actualScope);
      const providerContexts: ProviderAdapterContext[] = [];
      const { service } = buildService({ gatewayPort: fixture.registrationManager,
        providerFactory: contextProviderFactory((_provider, context) => providerContexts.push(context)) });

      const result = await service.prepareSession(identity, [requirement({ toolPolicy: policy, toolGrants: [grant],
        mcpServiceIds: [fixture.serviceId], mcpOperations: ["search"], toolIds: ["scope-search-tool"] })]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.report.ready).toBe(false);
      expect(result.value.report.roles[0]?.status).toBe("blocked");
      expect(result.value.launches).toEqual([]);
      expect(providerContexts).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(fixture.gatewayControlToken);
      expect(await readFile(fixture.counterPath, "utf8")).toBe("");
      expect(fixture.grantsByRegistration.size).toBe(0);
      const registrations = await fixture.runtimeControl.list(fixture.actualScope);
      expect(registrations.ok && registrations.value).toEqual([]);
      const setupAfter = await fixture.runtimeControl.inspectServices(fixture.setupOperation);
      expect(setupAfter.ok && setupAfter.value[0]?.status).toBe("ready");
    } finally {
      await fixture.cleanup();
    }
  }

  it("registers into the actual role partition after warming only the synthetic setup partition", async () => {
    const fixture = await createActualScopedGatewayFixture("valid");
    try {
      const setupBefore = await fixture.runtimeControl.inspectServices(fixture.setupOperation);
      const actualBefore = await fixture.runtimeControl.inspectServices(fixture.actualOperation);
      expect(setupBefore.ok && setupBefore.value[0]?.status).toBe("ready");
      expect(actualBefore.ok && actualBefore.value[0]?.status).toBe("stopped");
      expect(actualBefore.ok && actualBefore.value[0]?.diagnosticCode).toBe("not_started");
      const setupInstanceBefore = setupBefore.ok ? setupBefore.value[0]?.instanceId : undefined;
      const { policy, grant } = scopeSearchPolicyAndGrant(fixture.serviceId, fixture.actualScope);
      const providerContexts: ProviderAdapterContext[] = [];
      const { service } = buildService({ gatewayPort: fixture.registrationManager,
        providerFactory: contextProviderFactory((_provider, context) => providerContexts.push(context)) });

      const prepared = await service.prepareSession(identity, [requirement({ toolPolicy: policy, toolGrants: [grant],
        mcpServiceIds: [fixture.serviceId], mcpOperations: ["search"], toolIds: ["scope-search-tool"] })]);

      expect(prepared.ok && prepared.value.report.ready).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.value.launches).toHaveLength(1);
      expect(providerContexts.length).toBeGreaterThan(0);
      const privateTokens = Object.values(prepared.value.launches[0]!.gateway.tokenEnvironment);
      for (const context of providerContexts) {
        expect(context.mcpRegistrations).toEqual([]);
        expect(context.mcpObservations).toEqual([]);
        expect(context.mcpTokenEnvironmentNames).toBeUndefined();
        for (const token of privateTokens) expect(JSON.stringify(context)).not.toContain(token);
      }
      expect(Object.keys(prepared.value.launches[0]!.launch.env).some(name => name.startsWith("BFLOW_MCP_TOKEN_"))).toBe(false);

      const setupAfter = await fixture.runtimeControl.inspectServices(fixture.setupOperation);
      const actualAfter = await fixture.runtimeControl.inspectServices(fixture.actualOperation);
      expect(setupAfter.ok && setupAfter.value[0]?.status).toBe("ready");
      expect(actualAfter.ok && actualAfter.value[0]?.status).toBe("ready");
      expect(setupAfter.ok && setupAfter.value[0]?.instanceId).toBe(setupInstanceBefore);
      expect(actualAfter.ok && actualAfter.value[0]?.instanceId).not.toBe(setupInstanceBefore);

      const registration = prepared.value.launches[0]?.gateway.registrations[0];
      expect(registration).toBeDefined();
      if (!registration) return;
      const called = await fixture.runtimeControl.invokeTool({ schemaVersion: 3, callId: "actual-scope-search-call",
        registrationId: registration.registrationId, serviceId: fixture.serviceId, tool: "search",
        input: { query: "partition-check" }, idempotencyKey: "actual-scope-search-call" });
      expect(called.ok && called.value.status).toBe("completed");
      expect(await readFile(fixture.counterPath, "utf8")).toBe("x");
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes browser transactions through the real control endpoint and stdio worker", async () => {
    const fixture = await createActualScopedGatewayFixture("valid", true);
    try {
      const manager = fixture.registrationManager;
      const baseGrant = scopeSearchPolicyAndGrant(fixture.serviceId, fixture.actualScope).grant;
      for (const role of ["tester", "qa"] as const) {
        const result = await manager.ensureForRole(identity, { role, provider: "codex", environmentId: `env-${role}`,
          serviceIds: [fixture.serviceId], allowedTools: ["search"], configDigest: "a".repeat(64),
          toolGrants: [{ ...baseGrant, grantId: `grant-${role}`, role, triggers: ["browser_inspection"] }] });
        expect(result.ok).toBe(true);
      }
      const options = { browserTransaction: { id: "tester-assignment", resourceKey: "actual-browser-profile" } };
      const first = await manager.invokeTool(identity, "tester", undefined, fixture.serviceId, "search", { query: "navigate" }, "browser-first", options);
      expect(first.ok && first.value.status).toBe("completed");
      const second = await manager.invokeTool(identity, "tester", undefined, fixture.serviceId, "search", { query: "inspect" }, "browser-second", options);
      expect(second.ok && second.value.status).toBe("completed");
      const qaOptions = { browserTransaction: { id: "qa-assignment", resourceKey: "actual-browser-profile" } };
      expect((await manager.invokeTool(identity, "qa", undefined, fixture.serviceId, "search", { query: "qa" }, "browser-qa", qaOptions)).ok).toBe(false);
      expect(await readFile(fixture.counterPath, "utf8")).toBe("xx");
      expect((await manager.finishToolTransaction(identity, "tester", options.browserTransaction.id)).ok).toBe(true);
      const qa = await manager.invokeTool(identity, "qa", undefined, fixture.serviceId, "search", { query: "qa" }, "browser-qa", qaOptions);
      expect(qa.ok && qa.value.status).toBe("completed");
      expect(await readFile(fixture.counterPath, "utf8")).toBe("xxx");
      expect((await manager.revokeSession(identity)).ok).toBe(true);
    } finally { await fixture.cleanup(); }
  });

  it("retains timed-out browser mutations across manager restart without replay", async () => {
    const fixture = await createActualScopedGatewayFixture("unknown", true);
    try {
      const baseGrant = scopeSearchPolicyAndGrant(fixture.serviceId, fixture.actualScope).grant;
      const registered = await fixture.registrationManager.ensureForRole(identity, { role: "tester", provider: "codex", environmentId: "env-tester",
        serviceIds: [fixture.serviceId], allowedTools: ["search"], configDigest: "a".repeat(64),
        toolGrants: [{ ...baseGrant, role: "tester", triggers: ["browser_inspection"] }] });
      expect(registered.ok).toBe(true);
      const options = { timeoutMs: 100, browserTransaction: { id: "tester-timeout", resourceKey: "actual-browser-profile" } };
      const result = await fixture.registrationManager.invokeTool(identity, "tester", undefined, fixture.serviceId,
        "search", { query: "mutation" }, "browser-timeout", options);
      expect(result.ok ? result.value.status : result.error.code).toMatch(/unknown/);
      const revoked = await fixture.registrationManager.revokeSession(identity);
      expect(revoked).toMatchObject({ ok: false, error: { code: "unknown_delivery" } });
      const retained = await fixture.runtimeControl.list(fixture.actualScope);
      expect(retained.ok && retained.value).toHaveLength(1);
      // New manager reads the retained registration and browser intent; it must only observe the original call.
      const restarted = new GatewayRegistrationManager({ control: fixture.runtimeControl as GatewayControlPort, endpoint: ENDPOINT });
      expect((await restarted.invokeTool(identity, "tester", undefined, fixture.serviceId,
        "search", { query: "mutation" }, "browser-next", options)).ok).toBe(false);
      const reconciled = await restarted.reconcileToolCall(identity, "tester", undefined, fixture.serviceId,
        "search", { query: "mutation" }, "browser-timeout", options);
      expect(reconciled.ok ? reconciled.value.status : reconciled.error.code).toMatch(/unknown/);
      expect(await readFile(fixture.counterPath, "utf8")).toBe("x");
    } finally { await fixture.cleanup(); }
  });

  it("blocks malformed required stdio schemas without exposing provider launch material", async () => {
    await expectBlockedActualGatewayFixture("missing-input-schema");
  });

  it("blocks an unavailable actual repository partition without exposing provider launch material", async () => {
    await expectBlockedActualGatewayFixture("unavailable-actual");
  });

  function useIsolatorState(stateRoot: string): () => void {
    const previous = {
      state: process.env.AI_ISOLATOR_HOME,
      realHome: process.env.AI_ISOLATOR_REAL_HOME,
      linkedUrl: process.env.AI_ISOLATOR_CODEX_LB_URL,
      lbKey: process.env.CODEX_LB_API_KEY,
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR,
      codexHome: process.env.CODEX_HOME
    };
    process.env.AI_ISOLATOR_HOME = stateRoot;
    process.env.AI_ISOLATOR_REAL_HOME = join(baseDir, "real-home");
    process.env.CLAUDE_CONFIG_DIR = join(baseDir, "account-claude");
    process.env.CODEX_HOME = join(baseDir, "account-codex");
    delete process.env.AI_ISOLATOR_CODEX_LB_URL;
    delete process.env.CODEX_LB_API_KEY;
    return () => {
      if (previous.state === undefined) delete process.env.AI_ISOLATOR_HOME;
      else process.env.AI_ISOLATOR_HOME = previous.state;
      if (previous.realHome === undefined) delete process.env.AI_ISOLATOR_REAL_HOME;
      else process.env.AI_ISOLATOR_REAL_HOME = previous.realHome;
      if (previous.linkedUrl === undefined) delete process.env.AI_ISOLATOR_CODEX_LB_URL;
      else process.env.AI_ISOLATOR_CODEX_LB_URL = previous.linkedUrl;
      if (previous.lbKey === undefined) delete process.env.CODEX_LB_API_KEY;
      else process.env.CODEX_LB_API_KEY = previous.lbKey;
      if (previous.claudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous.claudeConfigDir;
      if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous.codexHome;
    };
  }

  async function expectProfileBlocked(
    provider: "claude" | "codex" | "agy",
    profileName: string,
    runner: ProviderCommandRunner
  ): Promise<void> {
    const { service } = buildService({ runner });
    const result = await service.prepareSession(identity, [requirement({
      provider,
      profileName,
      mcpServiceIds: []
    })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready).toBe(false);
    expect(result.value.report.roles[0]).toMatchObject({
      role: "developer",
      provider,
      status: "blocked",
      message: expect.stringContaining(`bflow iso ${provider} --name ${profileName}`)
    });
    expect(result.value.launches).toEqual([]);
  }

  async function journalKinds(journal: FileLaunchJournal): Promise<string[]> {
    return (await journal.entries()).map(entry => entry.kind);
  }

  it("rechecks a retained launch after health expiry without replacing its profile, tokens or intent", async () => {
    let now = Date.now();
    const { service, journal } = buildService({ now: () => new Date(now) });
    const result = await service.prepareSession(identity, [requirement({ mcpServiceIds: ["svc-search"] })]);
    if (!result.ok || !result.value.report.ready) throw new Error(JSON.stringify(result));
    const original = result.value.launches[0]!;
    const tokens = gatewayControl.tokens();
    const kinds = await journalKinds(journal);
    now += 600_000;
    const resumed = await service.revalidatePreparedLaunch(original.launch.launchId);
    expect(resumed.ok ? "ok" : resumed.error.message).toBe("ok");
    if (!resumed.ok) return;
    expect(resumed.value.launch).toEqual(original.launch);
    expect(resumed.value.profile).toEqual(original.profile);
    expect(Date.parse(resumed.value.preflight.checkedAt)).toBe(now);
    expect(gatewayControl.tokens()).toEqual(tokens);
    expect(await journalKinds(journal)).toEqual(kinds);
  });

  it("registers each resolved service with only its own exact operations", async () => {
    gatewayControl.services = [observation("svc-search"), observation("svc-read")];
    const grant = (grantId: string, toolId: string, serviceId: string, operation: string): ResolvedToolGrant => ({
      schemaVersion: 3, grantId, policyDigest: "a".repeat(64), toolId, kind: "native_remote_mcp", requiredness: "optional",
      role: "developer", scope: { kind: "session", machineId: identity.machineId, repositoryId: identity.repositoryId,
        workspaceRoot: identity.workspaceRoot, sessionId: identity.sessionId },
      triggers: ["prior_context"], serviceId, operations: [operation]
    });
    const searchGrant = grant("grant-search", "code-search", "svc-search", "search");
    const readGrant = grant("grant-read", "memory-read", "svc-read", "read");
    const toolPolicy = { schemaVersion: 3 as const, repositoryId: identity.repositoryId,
      scope: { kind: "repository" as const, machineId: identity.machineId, repositoryId: identity.repositoryId, workspaceRoot: identity.workspaceRoot },
      digest: "a".repeat(64), requirements: [
        { toolId: "code-search", kind: "native_remote_mcp" as const, serviceId: "svc-search", operations: ["search"], requiredness: "optional" as const,
          roles: ["developer" as const], triggers: ["prior_context" as const] },
        { toolId: "memory-read", kind: "native_remote_mcp" as const, serviceId: "svc-read", operations: ["read"], requiredness: "optional" as const,
          roles: ["developer" as const], triggers: ["prior_context" as const] }
      ] };
    const contexts: ProviderAdapterContext[] = [];
    const { service } = buildService({ providerFactory: contextProviderFactory((_provider, context) => contexts.push(context)) });

    const result = await service.prepareSession(identity, [requirement({ toolPolicy, mcpServiceIds: ["svc-search", "svc-read"],
      mcpOperations: ["search", "read"], toolGrants: [searchGrant, readGrant] })]);

    expect(result.ok && result.value.report.ready).toBe(true);
    const registrations = [...gatewayControl.registrations.values()].map(item => item.registration);
    expect(registrations).toHaveLength(2);
    expect(registrations.map(item => ({ serviceIds: item.serviceIds, allowedTools: item.allowedTools })))
      .toEqual(expect.arrayContaining([
        { serviceIds: ["svc-search"], allowedTools: ["search"] },
        { serviceIds: ["svc-read"], allowedTools: ["read"] }
      ]));
    expect(contexts[0]?.mcpRegistrations).toEqual([]);
    expect(contexts[0]?.mcpObservations).toEqual([]);
    expect(contexts[0]?.mcpTokenEnvironmentNames).toBeUndefined();
    expect(result.ok && result.value.launches[0]?.environment.requiredMcpServiceIds).toEqual([]);
    const launchEnv = result.ok ? result.value.launches[0]?.launch.env ?? {} : {};
    for (const token of gatewayControl.tokens()) expect(Object.values(launchEnv)).not.toContain(token);
  });

  it("accepts one verified grant service when the policy omits serviceId and binds Gateway to that service", async () => {
    gatewayControl.services = [observation("svc-search")];
    const toolPolicy = { schemaVersion: 3 as const, repositoryId: identity.repositoryId,
      scope: { kind: "repository" as const, machineId: identity.machineId, repositoryId: identity.repositoryId, workspaceRoot: identity.workspaceRoot },
      digest: "e".repeat(64), requirements: [{ toolId: "code-search", kind: "native_remote_mcp" as const,
        operations: ["search"], requiredness: "required" as const, roles: ["developer" as const], triggers: ["code_relationships" as const] }] };
    const grant: ResolvedToolGrant = { schemaVersion: 3, grantId: "grant-selected-search", policyDigest: toolPolicy.digest,
      toolId: "code-search", kind: "native_remote_mcp", requiredness: "required", role: "developer",
      scope: { kind: "session", machineId: identity.machineId, repositoryId: identity.repositoryId,
        workspaceRoot: identity.workspaceRoot, sessionId: identity.sessionId },
      triggers: ["code_relationships"], serviceId: "svc-search", operations: ["search"] };
    const { service } = buildService();

    const result = await service.prepareSession(identity, [requirement({ toolPolicy, toolGrants: [grant],
      mcpServiceIds: ["svc-search"], mcpOperations: ["search"] })]);

    expect(result.ok && result.value.report.ready).toBe(true);
    expect([...gatewayControl.registrations.values()].map(item => ({
      serviceIds: item.registration.serviceIds, allowedTools: item.registration.allowedTools
    }))).toEqual([{ serviceIds: ["svc-search"], allowedTools: ["search"] }]);
  });

  it("still denies an explicit service mismatch before Gateway registration", async () => {
    const toolPolicy = { schemaVersion: 3 as const, repositoryId: identity.repositoryId,
      scope: { kind: "repository" as const, machineId: identity.machineId, repositoryId: identity.repositoryId, workspaceRoot: identity.workspaceRoot },
      digest: "f".repeat(64), requirements: [{ toolId: "code-search", kind: "native_remote_mcp" as const, serviceId: "svc-search",
        operations: ["search"], requiredness: "required" as const, roles: ["developer" as const], triggers: ["code_relationships" as const] }] };
    const grant: ResolvedToolGrant = { schemaVersion: 3, grantId: "grant-wrong-search", policyDigest: toolPolicy.digest,
      toolId: "code-search", kind: "native_remote_mcp", requiredness: "required", role: "developer",
      scope: { kind: "session", machineId: identity.machineId, repositoryId: identity.repositoryId,
        workspaceRoot: identity.workspaceRoot, sessionId: identity.sessionId },
      triggers: ["code_relationships"], serviceId: "svc-read", operations: ["search"] };
    const { service } = buildService();

    const result = await service.prepareSession(identity, [requirement({ toolPolicy, toolGrants: [grant],
      mcpServiceIds: ["svc-read"], mcpOperations: ["search"] })]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready).toBe(false);
    expect(result.value.report.roles[0]?.status).toBe("blocked");
    expect(gatewayControl.registerCalls).toBe(0);
  });

  it("does not infer a service from ambiguous resolved grants", async () => {
    gatewayControl.services = [observation("svc-search"), observation("svc-read")];
    const toolPolicy = { schemaVersion: 3 as const, repositoryId: identity.repositoryId,
      scope: { kind: "repository" as const, machineId: identity.machineId, repositoryId: identity.repositoryId, workspaceRoot: identity.workspaceRoot },
      digest: "1".repeat(64), requirements: [{ toolId: "code-search", kind: "native_remote_mcp" as const,
        operations: ["search"], requiredness: "required" as const, roles: ["developer" as const], triggers: ["code_relationships" as const] }] };
    const grant = (grantId: string, serviceId: string): ResolvedToolGrant => ({ schemaVersion: 3, grantId,
      policyDigest: toolPolicy.digest, toolId: "code-search", kind: "native_remote_mcp", requiredness: "required",
      role: "developer", scope: { kind: "session", machineId: identity.machineId, repositoryId: identity.repositoryId,
        workspaceRoot: identity.workspaceRoot, sessionId: identity.sessionId },
      triggers: ["code_relationships"], serviceId, operations: ["search"] });
    const { service } = buildService();

    const result = await service.prepareSession(identity, [requirement({ toolPolicy,
      toolGrants: [grant("grant-search", "svc-search"), grant("grant-read", "svc-read")],
      mcpServiceIds: ["svc-search", "svc-read"], mcpOperations: ["search"] })]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready).toBe(false);
    expect(result.value.report.roles[0]?.message).toContain("ambiguous resolved grants");
    expect(gatewayControl.registerCalls).toBe(0);
  });

  it("continues to require an explicit serviceId for memory scope policy", async () => {
    const unscopedMemoryPolicy = { schemaVersion: 3 as const, repositoryId: identity.repositoryId,
      scope: { kind: "repository" as const, machineId: identity.machineId, repositoryId: identity.repositoryId, workspaceRoot: identity.workspaceRoot },
      digest: "2".repeat(64), requirements: [{ toolId: "mempalace", kind: "native_remote_mcp" as const,
        operations: ["mempalace_search"], requiredness: "required" as const, roles: ["developer" as const],
        triggers: ["prior_context" as const], memoryScope: { wing: "engineering", repositoryId: identity.repositoryId, access: "read_only" as const } }] };
    const { service } = buildService();

    const result = await service.prepareSession(identity, [requirement({ toolPolicy: unscopedMemoryPolicy as never,
      toolGrants: [], mcpServiceIds: [] })]);

    expect(RepositoryToolPolicySchema.safeParse(unscopedMemoryPolicy).success).toBe(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready).toBe(false);
    expect(gatewayControl.registerCalls).toBe(0);
  });

  it("blocks a required missing grant before Gateway, skill, provider, or launch side effects", async () => {
    const policy = { schemaVersion: 3 as const, repositoryId: identity.repositoryId,
      scope: { kind: "repository" as const, machineId: identity.machineId, repositoryId: identity.repositoryId, workspaceRoot: identity.workspaceRoot },
      digest: "b".repeat(64), requirements: [{ toolId: "code-search", kind: "stdio_mcp" as const, serviceId: "svc-search",
        operations: ["search"], requiredness: "required" as const, roles: ["developer" as const], triggers: ["code_relationships" as const] }] };
    const { service } = buildService();

    const result = await service.prepareSession(identity, [requirement({ toolPolicy: policy, toolGrants: [], mcpServiceIds: [] })]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready).toBe(false);
    expect(result.value.report.roles[0]).toMatchObject({ status: "blocked", message: expect.stringContaining("Required tool grant") });
    expect(gatewayControl.registrations.size).toBe(0);
    expect(gatewayControl.inspectCalls).toBe(0);
  });

  it("keeps an optional missing grant visible as degraded while allowing the unrelated role to launch", async () => {
    const policy = { schemaVersion: 3 as const, repositoryId: identity.repositoryId,
      scope: { kind: "repository" as const, machineId: identity.machineId, repositoryId: identity.repositoryId, workspaceRoot: identity.workspaceRoot },
      digest: "c".repeat(64), requirements: [{ toolId: "context7", kind: "native_remote_mcp" as const, serviceId: "svc-docs",
        operations: ["query_docs"], requiredness: "optional" as const, roles: ["developer" as const], triggers: ["external_documentation" as const] }] };
    const { service } = buildService();

    const result = await service.prepareSession(identity, [requirement({ toolPolicy: policy, toolGrants: [], mcpServiceIds: [] })]);

    expect(result.ok && result.value.report.ready).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.roles[0]?.checks).toContainEqual(expect.objectContaining({ status: "unknown", code: "optional_tool_grant_missing" }));
    expect(result.value.launches).toHaveLength(1);
    expect(gatewayControl.registrations.size).toBe(0);
  });

  it("keeps an optional unready MCP service out of the provider launch and reports the degraded reason", async () => {
    gatewayControl.services = [observation("svc-docs", { status: "unavailable", diagnosticCode: "missing_process" })];
    const policy = { schemaVersion: 3 as const, repositoryId: identity.repositoryId,
      scope: { kind: "repository" as const, machineId: identity.machineId, repositoryId: identity.repositoryId, workspaceRoot: identity.workspaceRoot },
      digest: "d".repeat(64), requirements: [{ toolId: "context7", kind: "native_remote_mcp" as const, serviceId: "svc-docs",
        operations: ["query_docs"], requiredness: "optional" as const, roles: ["developer" as const], triggers: ["external_documentation" as const] }] };
    const grant: ResolvedToolGrant = { schemaVersion: 3, grantId: "grant-docs", policyDigest: policy.digest,
      toolId: "context7", kind: "native_remote_mcp", requiredness: "optional", role: "developer",
      scope: { kind: "session", machineId: identity.machineId, repositoryId: identity.repositoryId,
        workspaceRoot: identity.workspaceRoot, sessionId: identity.sessionId },
      triggers: ["external_documentation"], serviceId: "svc-docs", operations: ["query_docs"] };
    const { service } = buildService();

    const result = await service.prepareSession(identity, [requirement({ toolPolicy: policy, toolGrants: [grant],
      mcpServiceIds: ["svc-docs"], mcpOperations: ["query_docs"] })]);

    expect(result.ok && result.value.report.ready).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.roles[0]?.checks).toContainEqual(expect.objectContaining({ status: "unknown", code: "optional_gateway_service_unavailable" }));
    expect(result.value.launches[0]?.gateway.registrations).toEqual([]);
    expect(gatewayControl.registerCalls).toBe(1);
    expect(gatewayControl.revokeCalls).toHaveLength(1);
    expect(gatewayControl.registrations.size).toBe(0);
  });

  it("revokes a registered grant when same-scope post-registration readiness is lost", async () => {
    const toolPolicy = { schemaVersion: 3 as const, repositoryId: identity.repositoryId,
      scope: { kind: "repository" as const, machineId: identity.machineId, repositoryId: identity.repositoryId, workspaceRoot: identity.workspaceRoot },
      digest: "3".repeat(64), requirements: [{ toolId: "code-search", kind: "native_remote_mcp" as const, serviceId: "svc-search",
        operations: ["search"], requiredness: "required" as const, roles: ["developer" as const], triggers: ["code_relationships" as const] }] };
    const grant: ResolvedToolGrant = { schemaVersion: 3, grantId: "grant-post-register-search", policyDigest: toolPolicy.digest,
      toolId: "code-search", kind: "native_remote_mcp", requiredness: "required", role: "developer",
      scope: { kind: "session", machineId: identity.machineId, repositoryId: identity.repositoryId,
        workspaceRoot: identity.workspaceRoot, sessionId: identity.sessionId },
      triggers: ["code_relationships"], serviceId: "svc-search", operations: ["search"] };
    const providerContexts: ProviderAdapterContext[] = [];
    let registerCallbackCount = 0;
    gatewayControl.onRegister = () => {
      registerCallbackCount += 1;
      gatewayControl.services = [observation("svc-search", { status: "stopped", diagnosticCode: "not_started", discoveredTools: [] })];
    };
    const { service } = buildService({ providerFactory: contextProviderFactory((_provider, context) => providerContexts.push(context)) });

    const result = await service.prepareSession(identity, [requirement({ toolPolicy, toolGrants: [grant],
      mcpServiceIds: ["svc-search"], mcpOperations: ["search"] })]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(registerCallbackCount).toBe(1);
    expect(result.value.report.ready).toBe(false);
    expect(result.value.launches).toEqual([]);
    expect(providerContexts).toEqual([]);
    expect(gatewayControl.registerCalls).toBe(1);
    expect(gatewayControl.revokeCalls).toHaveLength(1);
    expect(gatewayControl.registrations.size).toBe(0);
  });

  it.each(["expired", "missing-skills", "gateway-lost", "released", "binary-changed", "config-changed"] as const)("refuses %s retained startup material without replacing it", async condition => {
    let now = Date.now();
    const { service, journal } = buildService({ now: () => new Date(now) });
    const result = await service.prepareSession(identity, [requirement({ mcpServiceIds: ["svc-search"] })]);
    if (!result.ok || !result.value.report.ready) throw new Error(JSON.stringify(result));
    const original = result.value.launches[0]!;
    if (condition === "expired") now += 3_600_001;
    if (condition === "missing-skills") await rm(join(identity.stateDirectory, "gen-1/skills/developer-t1.json"));
    if (condition === "gateway-lost") gatewayControl.restart();
    if (condition === "released") await service.releaseLaunch(original.launch.launchId);
    if (condition === "binary-changed") await writeFile(binaryPath, "#!/bin/sh\necho changed\n");
    if (condition === "config-changed") await writeFile(original.profile.configFiles[0]!.path, "changed launch settings");
    const kinds = await journalKinds(journal);
    expect((await service.revalidatePreparedLaunch(original.launch.launchId)).ok).toBe(false);
    expect(await journalKinds(journal)).toEqual(kinds);
  });

  it("refuses a selected profile whose identity changes during a retained startup", async () => {
    const stateRoot = join(baseDir, "isolator-state");
    const selected = await createIsolatorProfile(stateRoot, "claude", "personal");
    const restore = useIsolatorState(stateRoot);
    try {
      const { service, journal } = buildService();
      const result = await service.prepareSession(identity, [requirement({ profileName: "personal" })]);
      if (!result.ok || !result.value.report.ready) throw new Error(JSON.stringify(result));
      const metadata = join(selected.profileRoot, "profile.env");
      await rm(metadata);
      await writeFile(metadata, "AI_ISOLATOR_TOOL=claude\nAI_ISOLATOR_PROFILE=personal\nAI_ISOLATOR_CREATED_AT=2026-10-21T00:00:00Z\n", { mode: 0o600 });
      const resumed = await service.revalidatePreparedLaunch(result.value.launches[0]!.launch.launchId);
      expect(resumed).toMatchObject({ ok: false, error: { message: expect.stringContaining("profile identity changed") } });
      expect(await journalKinds(journal)).toEqual(["intent"]);
    } finally { restore(); }
  });

  it("bounds concurrent provider probes and waits for all verdicts before preparing launches", async () => {
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const run = runner.run.bind(runner);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let active = 0, peak = 0, started = 0;
    vi.spyOn(runner, "run").mockImplementation(async invocation => {
      if (!invocation.args.includes("ping")) return run(invocation);
      started++; active++; peak = Math.max(peak, active);
      await gate;
      active--;
      return run(invocation);
    });
    const { service, journal } = buildService({ runner });
    const pending = service.prepareSession(identity, Array.from({ length: 7 }, (_, index) => requirement({ taskId: `t${index}` })));
    try {
      // Seven real role directories and executable inventories are prepared
      // before probes start. Allow filesystem work under full-suite load;
      // the unreleased gate still proves the exact concurrency limit.
      await expect.poll(() => started, { timeout: 10_000 }).toBe(3);
      expect(await journalKinds(journal)).toEqual([]);
    } finally { release(); }
    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(peak).toBe(3);
    expect(started).toBe(7);
    expect(result.value.launches.map(launch => launch.taskId)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6"]);
  });

  it("blocks a missing selected profile before invoking any provider command", async () => {
    const previousState = process.env.AI_ISOLATOR_HOME;
    const previousRealHome = process.env.AI_ISOLATOR_REAL_HOME;
    process.env.AI_ISOLATOR_HOME = join(baseDir, "missing-isolator-state");
    process.env.AI_ISOLATOR_REAL_HOME = join(baseDir, "real-home");
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const run = vi.spyOn(runner, "run");
    try {
      const { service } = buildService({ runner });
      const result = await service.prepareSession(identity, [requirement({
        profileName: "work",
        provider: "claude",
        mcpServiceIds: []
      })]);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.report.ready).toBe(false);
      expect(result.value.report.roles[0]).toMatchObject({
        role: "developer",
        provider: "claude",
        status: "blocked",
        message: expect.stringContaining("bflow iso claude --name work")
      });
      expect(result.value.launches).toEqual([]);
      expect(run).not.toHaveBeenCalled();
    } finally {
      if (previousState === undefined) delete process.env.AI_ISOLATOR_HOME;
      else process.env.AI_ISOLATOR_HOME = previousState;
      if (previousRealHome === undefined) delete process.env.AI_ISOLATOR_REAL_HOME;
      else process.env.AI_ISOLATOR_REAL_HOME = previousRealHome;
    }
  });

  it.each(["wrong-tool", "malformed-metadata"] as const)("blocks %s metadata before provider execution", async kind => {
    const stateRoot = join(baseDir, "isolator-state");
    const metadata = kind === "wrong-tool"
      ? "AI_ISOLATOR_TOOL=codex\nAI_ISOLATOR_PROFILE=work\nAI_ISOLATOR_CREATED_AT=2026-10-20T00:00:00Z\n"
      : "AI_ISOLATOR_TOOL=claude\nAI_ISOLATOR_PROFILE=work\nINVALID LINE\n";
    await createIsolatorProfile(stateRoot, "claude", "work", metadata);
    const restore = useIsolatorState(stateRoot);
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const run = vi.spyOn(runner, "run");
    try {
      await expectProfileBlocked("claude", "work", runner);
      expect(run).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it.each(["profile root", "home", "cache", "profile.env", "claude config root", "codex config root", "agy config root"] as const)(
    "blocks a symlinked %s before provider execution",
    async kind => {
      const provider = kind === "codex config root" ? "codex" : kind === "agy config root" ? "agy" : "claude";
      const name = "work";
      const stateRoot = join(baseDir, "isolator-state");
      const profileRoot = join(stateRoot, "profiles", `${provider}--${name}`);
      let home = join(profileRoot, "home");
      if (kind === "profile root") {
        const actual = join(stateRoot, "profiles", "actual-profile");
        await mkdir(dirname(profileRoot), { recursive: true, mode: 0o700 });
        await createIsolatorProfileAt(actual, provider, name);
        await symlink(actual, profileRoot);
      } else {
        const { home: createdHome } = await createIsolatorProfile(stateRoot, provider, name);
        home = createdHome;
      }
      if (kind === "home") {
        const externalHome = join(baseDir, "external-home");
        await mkdir(externalHome, { mode: 0o700 });
        await rm(home, { recursive: true });
        await symlink(externalHome, home);
      } else if (kind === "cache") {
        const cache = join(profileRoot, "cache");
        const externalCache = join(baseDir, "external-cache");
        await mkdir(externalCache, { mode: 0o700 });
        await rm(cache, { recursive: true });
        await symlink(externalCache, cache);
      } else if (kind === "profile.env") {
        const metadata = join(profileRoot, "profile.env");
        const externalMetadata = join(baseDir, "external-profile.env");
        await writeFile(externalMetadata, "AI_ISOLATOR_TOOL=claude\nAI_ISOLATOR_PROFILE=work\n");
        await rm(metadata);
        await symlink(externalMetadata, metadata);
      } else if (kind.endsWith("config root")) {
        const configRoot = join(home, kind === "agy config root" ? ".gemini" : `.${provider}`);
        const externalConfig = join(baseDir, "external-config");
        await mkdir(externalConfig, { mode: 0o700 });
        await rm(configRoot, { recursive: true, force: true });
        await symlink(externalConfig, configRoot);
      }

      const restore = useIsolatorState(stateRoot);
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const run = vi.spyOn(runner, "run");
      try {
        await expectProfileBlocked(provider, name, runner);
        expect(run).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    }
  );

  it("rejects a profile root accessible to other users before provider execution", async () => {
    const stateRoot = join(baseDir, "isolator-state");
    const { profileRoot } = await createIsolatorProfile(stateRoot, "claude", "work");
    await chmod(profileRoot, 0o755);
    const restore = useIsolatorState(stateRoot);
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const run = vi.spyOn(runner, "run");
    try {
      const { service } = buildService({ runner });
      const result = await service.prepareSession(identity, [requirement({
        provider: "claude",
        profileName: "work",
        mcpServiceIds: []
      })]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.report.ready).toBe(false);
        expect(result.value.report.roles[0]?.message).toContain(`profile entry is accessible to other users: ${profileRoot}`);
        expect(result.value.launches).toEqual([]);
      }
      expect(run).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("rejects FIFO and oversized profile metadata without blocking or probing providers", async () => {
    const stateRoot = join(baseDir, "isolator-state");
    const { profileRoot } = await createIsolatorProfile(stateRoot, "claude", "work");
    const metadata = join(profileRoot, "profile.env");
    await rm(metadata);
    const fifo = spawnSync("mkfifo", [metadata], { encoding: "utf8" });
    expect(fifo.status, fifo.stderr).toBe(0);

    const restore = useIsolatorState(stateRoot);
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const run = vi.spyOn(runner, "run");
    try {
      await expectProfileBlocked("claude", "work", runner);
      expect(run).not.toHaveBeenCalled();
    } finally {
      restore();
    }

    await rm(metadata);
    await writeFile(metadata, `${"x".repeat(4097)}`, { mode: 0o664 });
    const restoreOversized = useIsolatorState(stateRoot);
    try {
      await expectProfileBlocked("claude", "work", runner);
      expect(run).not.toHaveBeenCalled();
    } finally {
      restoreOversized();
    }
  });

  it("keeps direct/unset Codex profiles direct and ignores automatic LB discovery", async () => {
    const stateRoot = join(baseDir, "isolator-state");
    const { profileRoot } = await createIsolatorProfile(stateRoot, "codex", "work");
    const restore = useIsolatorState(stateRoot);
    process.env.AI_ISOLATOR_CODEX_LB_URL = "http://127.0.0.1:1";
    const fake = createFakeProviderRunner({ scenario: "healthy" });
    const invocations: ProviderCommandInvocation[] = [];
    const runner: ProviderCommandRunner = { run: async invocation => {
      invocations.push(invocation);
      return fake.run(invocation);
    } };
    try {
      const { service } = buildService({ runner });
      const result = await service.prepareSession(identity, [requirement({
        provider: "codex",
        profileName: "work",
        mcpServiceIds: []
      })]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.report.ready).toBe(true);
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every(invocation => invocation.inheritEnvironment === false)).toBe(true);
      expect(invocations.every(invocation => invocation.env?.["HOME"] === join(profileRoot, "home"))).toBe(true);
      expect(invocations.every(invocation => invocation.env?.["CODEX_HOME"] === join(profileRoot, "home", ".codex"))).toBe(true);
      expect(invocations.every(invocation => invocation.env?.["AI_ISOLATOR_CODEX_LB_URL"] === "")).toBe(true);
      expect(invocations.flatMap(invocation => invocation.args).some(argument => argument.includes("codex-lb"))).toBe(false);
      expect(result.value.launches[0]?.launch.env["HOME"]).toBe(join(profileRoot, "home"));
      expect(result.value.launches[0]?.launch.env["ANTHROPIC_API_KEY"]).toBe("");
      expect(result.value.launches[0]?.launch.env["AI_ISOLATOR_CODEX_LB_URL"]).toBe("");
    } finally {
      restore();
    }
  });

  it("binds two same-provider roles to their own profile HOME and path fingerprint", async () => {
    const stateRoot = join(baseDir, "isolator-state");
    const chat = await createIsolatorProfile(stateRoot, "codex", "chat");
    const lead = await createIsolatorProfile(stateRoot, "codex", "lead");
    const restore = useIsolatorState(stateRoot);
    const contexts: ProviderAdapterContext[] = [];
    try {
      const { service } = buildService({
        providerFactory: contextProviderFactory((_provider, context) => contexts.push(context))
      });
      const result = await service.prepareSession(identity, [
        requirement({ role: "conversation", provider: "codex", profileName: "chat", cwd: workspace,
          taskId: undefined, skillSelections: [], mcpServiceIds: [] }),
        requirement({ role: "coordinator", provider: "codex", profileName: "lead", cwd: workspace,
          taskId: undefined, skillSelections: [], mcpServiceIds: [] })
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.report.ready).toBe(true);
      expect(result.value.launches.map(launch => launch.launch.env["HOME"])).toEqual([
        join(chat.profileRoot, "home"),
        join(lead.profileRoot, "home")
      ]);
      const profileContexts = contexts.filter(context => context.isolatorEnvironment !== undefined);
      expect(new Set(profileContexts.map(context => context.isolatorEnvironment?.["HOME"]))).toEqual(new Set([
        join(chat.profileRoot, "home"),
        join(lead.profileRoot, "home")
      ]));
      expect(result.value.launches[0]?.environment.configFingerprint)
        .not.toBe(result.value.launches[1]?.environment.configFingerprint);
    } finally {
      restore();
    }
  });

  it("binds the trusted state root into the role fingerprint for the same profile name", async () => {
    const firstRoot = join(baseDir, "isolator-first");
    const secondRoot = join(baseDir, "isolator-second");
    await createIsolatorProfile(firstRoot, "claude", "work");
    await createIsolatorProfile(secondRoot, "claude", "work");
    const firstIdentity = { ...identity, stateDirectory: join(baseDir, "first-runtime-state") };
    const secondIdentity = { ...identity, stateDirectory: join(baseDir, "second-runtime-state") };
    await mkdir(firstIdentity.stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(secondIdentity.stateDirectory, { recursive: true, mode: 0o700 });
    const providerFactory = contextProviderFactory(() => undefined);
    const restoreFirst = useIsolatorState(firstRoot);
    let firstFingerprint: string | undefined;
    try {
      const { service } = buildService({ providerFactory });
      const first = await service.prepareSession(firstIdentity, [requirement({
        provider: "claude",
        profileName: "work",
        mcpServiceIds: []
      })]);
      expect(first.ok).toBe(true);
      if (first.ok) firstFingerprint = first.value.launches[0]?.environment.configFingerprint;
    } finally {
      restoreFirst();
    }

    const restoreSecond = useIsolatorState(secondRoot);
    try {
      const { service } = buildService({ providerFactory });
      const second = await service.prepareSession(secondIdentity, [requirement({
        provider: "claude",
        profileName: "work",
        mcpServiceIds: []
      })]);
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.value.launches[0]?.environment.configFingerprint).not.toBe(firstFingerprint);
    } finally {
      restoreSecond();
    }
  });

  it("binds a dynamic Developer profile without changing its task-worktree cwd or permissions", async () => {
    const stateRoot = join(baseDir, "isolator-state");
    const { profileRoot } = await createIsolatorProfile(stateRoot, "codex", "work");
    const worktree = join(baseDir, "task-worktree");
    const restore = useIsolatorState(stateRoot);
    const contexts: ProviderAdapterContext[] = [];
    try {
      const { service } = buildService({
        providerFactory: contextProviderFactory((_provider, context) => contexts.push(context))
      });
      const result = await service.prepareDeveloper(identity, requirement({
        provider: "codex",
        profileName: "work",
        cwd: worktree,
        mcpServiceIds: []
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.environment.cwd).toBe(worktree);
      expect(result.value.environment.permissionProfile.writableRoots).toEqual([worktree]);
      expect(result.value.launch.env["HOME"]).toBe(join(profileRoot, "home"));
      expect(contexts.some(context => context.isolatorEnvironment?.["AI_ISOLATOR_PROFILE"] === "work")).toBe(true);
    } finally {
      restore();
    }
  });

  it.each(["removed", "replaced"] as const)("refuses to prepare a profile that was %s after preflight", async change => {
    const stateRoot = join(baseDir, "isolator-state");
    const { profileRoot } = await createIsolatorProfile(stateRoot, "claude", "work");
    const restore = useIsolatorState(stateRoot);
    let prepareCalls = 0;
    const factory = contextProviderFactory((_provider, _context) => undefined, async request => {
      if (request.stage !== "preflight") return;
      await rm(profileRoot, { recursive: true });
      if (change === "replaced") await createIsolatorProfileAt(profileRoot, "claude", "work");
    }, () => { prepareCalls++; });
    try {
      const { service, journal } = buildService({ providerFactory: factory });
      const result = await service.prepareSession(identity, [requirement({
        provider: "claude",
        profileName: "work",
        mcpServiceIds: []
      })]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.report.ready).toBe(false);
      expect(result.value.launches).toEqual([]);
      expect(result.value.report.roles[0]?.message).toContain("bflow iso claude --name work");
      if (change === "replaced")
        expect(result.value.report.roles[0]?.message).toContain("profile identity changed after provider preflight");
      expect(prepareCalls).toBe(0);
      expect(await journalKinds(journal)).toEqual([]);
    } finally {
      restore();
    }
  });

  it("revalidates the selected profile again before activation health", async () => {
    const stateRoot = join(baseDir, "isolator-state");
    const { profileRoot } = await createIsolatorProfile(stateRoot, "claude", "work");
    const restore = useIsolatorState(stateRoot);
    const healthStages: string[] = [];
    try {
      const { service } = buildService({
        providerFactory: contextProviderFactory((_provider, _context) => undefined,
          request => { healthStages.push(request.stage); })
      });
      const prepared = await service.prepareSession(identity, [requirement({
        provider: "claude",
        profileName: "work",
        mcpServiceIds: []
      })]);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const launch = prepared.value.launches[0]!;
      await rm(profileRoot, { recursive: true });

      const activated = await service.verifyActivated({
        launchId: launch.launch.launchId,
        paneId: "pane-developer-profile",
        nativeSession: NATIVE_SESSION
      });
      expect(activated.ok).toBe(false);
      if (!activated.ok) expect(activated.error.message).toContain("bflow iso claude --name work");
      expect(healthStages).toEqual(["preflight"]);
    } finally {
      restore();
    }
  });

  it("keeps Claude native MCP state in the selected HOME rather than redirecting its config directory", async () => {
    const stateRoot = join(baseDir, "isolator-state");
    const { home } = await createIsolatorProfile(stateRoot, "claude", "personal");
    const nativeStatePath = join(home, ".claude.json");
    const nativeState = JSON.stringify({ mcpServers: { "bflow-fixture": { command: "/usr/bin/true" } } });
    await writeFile(nativeStatePath, nativeState, { mode: 0o664 });
    await mkdir(join(home, ".claude"), { mode: 0o700 });
    await writeFile(join(home, ".claude", ".credentials.json"), '{"subscriptionType":"synthetic"}', { mode: 0o600 });
    const restore = useIsolatorState(stateRoot);
    const fake = createFakeProviderRunner({ scenario: "healthy" });
    const invocations: ProviderCommandInvocation[] = [];
    const runner: ProviderCommandRunner = { run: async invocation => {
      invocations.push(invocation);
      return fake.run(invocation);
    } };
    try {
      const { service } = buildService({ runner });
      const result = await service.prepareSession(identity, [requirement({
        provider: "claude",
        profileName: "personal",
        mcpServiceIds: []
      })]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.report.ready).toBe(true);
      expect(invocations.length).toBeGreaterThan(0);
      expect(invocations.every(invocation => invocation.inheritEnvironment === false)).toBe(true);
      expect(invocations.every(invocation => invocation.env?.["HOME"] === home)).toBe(true);
      expect(invocations.every(invocation => invocation.env?.["CLAUDE_CONFIG_DIR"] === join(home, ".claude"))).toBe(true);
      expect(result.value.launches[0]?.launch.env["HOME"]).toBe(home);
      expect(result.value.launches[0]?.launch.env["CLAUDE_CONFIG_DIR"]).toBe(join(home, ".claude"));
      expect(await readFile(nativeStatePath, "utf8")).toBe(nativeState);
    } finally {
      restore();
    }
  });

  it("blocks a linked Codex profile when its configured readiness endpoint is down", async () => {
    const stateRoot = join(baseDir, "isolator-state");
    const { profileRoot } = await createIsolatorProfile(stateRoot, "codex", "work");
    await writeFile(join(profileRoot, "codex-lb.mode"), "linked\n", { mode: 0o664 });
    await writeFile(join(profileRoot, "codex-lb.url"), "http://127.0.0.1:1\n", { mode: 0o664 });
    const restore = useIsolatorState(stateRoot);
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const run = vi.spyOn(runner, "run");
    try {
      await expectProfileBlocked("codex", "work", runner);
      expect(run).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("uses a trusted linked Codex backend key in memory without persisting it", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.url === "/health/ready" ? 200 : 404);
      response.end("ready");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const stateRoot = join(baseDir, "isolator-state");
    const { profileRoot } = await createIsolatorProfile(stateRoot, "codex", "work");
    await writeFile(join(profileRoot, "codex-lb.mode"), "linked\n", { mode: 0o664 });
    await writeFile(join(profileRoot, "codex-lb.url"), `http://127.0.0.1:${address.port}\n`, { mode: 0o664 });
    const restore = useIsolatorState(stateRoot);
    const secret = "synthetic-codex-lb-key";
    process.env.CODEX_LB_API_KEY = secret;
    const contexts: ProviderAdapterContext[] = [];
    try {
      const { service, journal } = buildService({
        providerFactory: contextProviderFactory((_provider, context) => contexts.push(context))
      });
      const result = await service.prepareSession(identity, [requirement({
        provider: "codex",
        profileName: "work",
        mcpServiceIds: []
      })]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.report.ready).toBe(true);
      const context = contexts.find(entry => entry.isolatorEnvironment !== undefined);
      expect(context?.codexBackendUrl).toBe(`http://127.0.0.1:${address.port}/backend-api/codex`);
      expect(context?.isolatorEnvironment?.["CODEX_LB_API_KEY"]).toBe(secret);
      expect(context?.launchEnvironment?.["CODEX_LB_API_KEY"]).toBe(secret);
      const launch = result.value.launches[0]!;
      expect(launch.launch.env["CODEX_LB_API_KEY"]).toBe(secret);
      expect(launch.launch.argv).not.toContain(secret);
      expect(launch.environment.configFingerprint).not.toContain(secret);
      expect(await readFile(join(identity.stateDirectory, "launch-journal.jsonl"), "utf8")).not.toContain(secret);
      expect(await readFile(join(profileRoot, "profile.env"), "utf8")).not.toContain(secret);
      expect(await journal.entries()).toHaveLength(1);
    } finally {
      restore();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("bounds linked-backend readiness by the operation deadline and cancellation signal", async () => {
    let requests = 0;
    const server = createServer(() => { requests++; });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const stateRoot = join(baseDir, "isolator-state");
    const { profileRoot } = await createIsolatorProfile(stateRoot, "codex", "work");
    await writeFile(join(profileRoot, "codex-lb.mode"), "linked\n", { mode: 0o664 });
    await writeFile(join(profileRoot, "codex-lb.url"), `http://127.0.0.1:${address.port}\n`, { mode: 0o664 });
    const restore = useIsolatorState(stateRoot);
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const run = vi.spyOn(runner, "run");
    try {
      const { service } = buildService({ runner });
      const started = Date.now();
      const deadlineResult = await service.prepareSession(identity, [requirement({
        provider: "codex",
        profileName: "work",
        mcpServiceIds: []
      })], { timeoutMs: 5000, deadline: new Date(Date.now() + 150).toISOString() });
      expect(requests).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(deadlineResult.ok && deadlineResult.value.report.ready).toBe(false);
      expect(run).not.toHaveBeenCalled();

      const controller = new AbortController();
      const cancelledService = buildService({ runner }).service;
      const cancelled = cancelledService.prepareSession(identity, [requirement({
        provider: "codex",
        profileName: "work",
        mcpServiceIds: []
      })], { signal: controller.signal, timeoutMs: 5000 });
      await expect.poll(() => requests >= 2).toBe(true);
      controller.abort();
      const cancelledResult = await cancelled;
      expect(cancelledResult).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(run).not.toHaveBeenCalled();
    } finally {
      restore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("accepts the file modes produced by the bundled ai-isolator", async () => {
    const stateRoot = join(baseDir, "engine-state");
    const realHome = join(baseDir, "engine-home");
    await mkdir(realHome, { mode: 0o700 });
    const bin = join(baseDir, "engine-bin");
    await mkdir(bin, { mode: 0o700 });
    // Profile creation checks for a CLI even with --no-login, but must never launch it.
    await writeFile(join(bin, "claude"), "#!/bin/sh\necho 'unexpected Claude launch' >&2\nexit 99\n", { mode: 0o700 });
    const engine = join(import.meta.dirname, "../../../..", "apps", "cli", "isolation", "bin", "ai-isolator");
    const generated = spawnSync("bash", [
      "-c", 'umask 002; exec "$@"', "bflow-iso-test", engine, "claude", "--name", "work", "--no-login"
    ], {
      cwd: baseDir,
      env: {
        HOME: realHome,
        AI_ISOLATOR_PY: testPython,
        PATH: `${bin}:/usr/bin:/bin`,
        AI_ISOLATOR_HOME: stateRoot,
        AI_ISOLATOR_SHELL: "bash"
      },
      encoding: "utf8"
    });
    expect(generated.status, generated.stderr).toBe(0);
    const profileEnv = join(stateRoot, "profiles", "claude--work", "profile.env");
    expect((await stat(profileEnv)).mode & 0o777).toBe(0o664);

    const restore = useIsolatorState(stateRoot);
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    try {
      const { service } = buildService({ runner });
      const result = await service.prepareSession(identity, [requirement({
        provider: "claude",
        profileName: "work",
        mcpServiceIds: []
      })]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.report.ready).toBe(true);
    } finally {
      restore();
    }
  });

  it("accepts owner-owned profile children with original permissive modes under a private profile root", async () => {
    const stateRoot = join(baseDir, "isolator-state");
    const { profileRoot } = await createIsolatorProfile(stateRoot, "codex", "personal");
    for (const directory of ["home", "config", "cache", "data", "state", "tmp"])
      await chmod(join(profileRoot, directory), 0o775);
    expect((await stat(profileRoot)).mode & 0o777).toBe(0o700);

    const restore = useIsolatorState(stateRoot);
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    try {
      const { service } = buildService({ runner });
      const result = await service.prepareSession(identity, [requirement({
        provider: "codex",
        profileName: "personal",
        mcpServiceIds: []
      })]);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.report.ready).toBe(true);
    } finally {
      restore();
    }
  });

  it("forwards cancellation and the remaining deadline to every provider subprocess", async () => {
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const run = vi.spyOn(runner, "run");
    const { service } = buildService({ runner });
    const signal = new AbortController().signal;
    const result = await service.prepareSession(identity, [requirement()], { signal, timeoutMs: 5000, deadline: new Date(Date.now() + 5000).toISOString() });
    expect(result.ok).toBe(true);
    expect(run.mock.calls.length).toBeGreaterThan(4);
    for (const [invocation] of run.mock.calls) {
      expect(invocation.signal).toBe(signal);
      expect(invocation.timeoutMs).toBeGreaterThan(0);
      expect(invocation.timeoutMs).toBeLessThanOrEqual(5000);
    }
  });

  it.each(["cancelled", "expired"])("refuses %s preparation before provider or Gateway work", async kind => {
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const run = vi.spyOn(runner, "run");
    const { service, journal } = buildService({ runner });
    const options = kind === "cancelled" ? { signal: AbortSignal.abort() } : { deadline: new Date(Date.now() - 1000).toISOString() };
    const result = await service.prepareSession(identity, [requirement({ mcpServiceIds: ["svc-search"] })], options);
    expect(result).toMatchObject({ ok: false, error: { code: kind === "cancelled" ? "cancelled" : "timeout" } });
    expect(run).not.toHaveBeenCalled();
    expect(gatewayControl.registrations.size).toBe(0);
    expect(await journalKinds(journal)).toEqual([]);
  });

  it("revokes Gateway access and creates no launch if cancelled during preflight", async () => {
    const controller = new AbortController();
    const runner = createFakeProviderRunner({ scenario: "healthy" });
    const run = runner.run.bind(runner);
    vi.spyOn(runner, "run").mockImplementation(async invocation => {
      const result = await run(invocation);
      controller.abort();
      return result;
    });
    const { service, journal } = buildService({ runner });
    const result = await service.prepareSession(identity, [requirement({ mcpServiceIds: ["svc-search"] })], { signal: controller.signal });
    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(gatewayControl.registrations.size).toBe(0);
    expect(await journalKinds(journal)).toEqual([]);
  });

  it("launches every ready role with argv and token env, journaling intents", async () => {
    const { service, journal } = buildService();
    const result = await service.prepareSession(identity, [
      requirement({ mcpServiceIds: ["svc-search"] }),
      requirement({ taskId: "t2", required: false })
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { report, launches } = result.value;
    expect(report.ready).toBe(true);
    expect(report.generation).toBe(1);
    expect(report.roles.map(role => role.status)).toEqual(["ready", "ready"]);
    expect(launches).toHaveLength(2);

    const [gatewayLaunch] = launches;
    expect(gatewayLaunch?.launch.argv.length).toBeGreaterThan(0);
    expect(gatewayLaunch?.launch.argv).toEqual(gatewayLaunch?.profile.argv);
    const { DISABLE_AUTOUPDATER, ...tokenEnv } = gatewayLaunch?.launch.env ?? {};
    expect(DISABLE_AUTOUPDATER).toBe("1");
    const tokenValues = Object.values(tokenEnv);
    expect(tokenValues).toHaveLength(1);
    expect(tokenValues[0]).toBe(gatewayControl.tokens()[0]);
    expect(gatewayLaunch?.launch.launchId).toBe(gatewayLaunch?.profile.launchId);

    expect(await journalKinds(journal)).toEqual(["intent", "intent"]);
    expect(service.status().generation).toBe(1);
    expect(service.status().launches.map(launch => launch.state)).toEqual(["intent", "intent"]);
  });

  it("pins permanent and dynamic Developer launch HOME selectors to trusted Codex machine context", async () => {
    const home = join(baseDir, "trusted-home");
    const codexHome = join(baseDir, "isolated-codex");
    const { service } = buildService({ gateway: false, codexLaunchEnvironment: { HOME: home, CODEX_HOME: codexHome } });
    const launches = await service.prepareSession(identity, [requirement({ provider: "codex" })]);
    expect(launches.ok).toBe(true);
    if (launches.ok) expect(launches.value.launches[0]?.launch.env).toMatchObject({ HOME: home, CODEX_HOME: codexHome });

    const developer = await service.prepareDeveloper(identity, requirement({ provider: "codex" }));
    expect(developer.ok).toBe(true);
    if (developer.ok) expect(developer.value.launch.env).toMatchObject({ HOME: home, CODEX_HOME: codexHome });
  });

  it("falls back to BFLOW_INSTRUCTION_HOME=native_auth_compatible for ChatGPT OAuth refresh tokens or explicit override without claiming isolation", async () => {
    const sourceProcessHome = join(baseDir, "operator-home");
    const sourceCodexHome = join(sourceProcessHome, ".codex");
    const stateDir = join(baseDir, "codex-oauth-state");
    await mkdir(sourceCodexHome, { recursive: true, mode: 0o700 });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(join(sourceCodexHome, "config.toml"), 'model = "gpt-5.4"\n', { mode: 0o600 });
    await writeFile(join(sourceCodexHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "acc-123", refresh_token: "ref-single-use" }
    }), { mode: 0o600 });
    await writeFile(join(sourceCodexHome, "AGENTS.md"), "# Global AGENTS\n", { mode: 0o600 });

    const oauthResult = await preparePrivateCodexHome(stateDir, sourceCodexHome, sourceProcessHome, {});
    expect(oauthResult.mode).toBe("native_auth_compatible");
    expect(oauthResult.BFLOW_INSTRUCTION_HOME).toBe("native_auth_compatible");
    expect(oauthResult.CODEX_HOME).toBe(sourceCodexHome);
    expect(oauthResult.HOME).toBe(sourceProcessHome);
    expect(oauthResult.diagnostic).toContain("native_auth_compatible");
    expect(oauthResult.diagnostic).toMatch(/not isolated/i);

    const explicitResult = await preparePrivateCodexHome(stateDir, sourceCodexHome, sourceProcessHome, {
      BFLOW_INSTRUCTION_HOME: "native_auth_compatible",
      OPENAI_API_KEY: "sk-test-override"
    });
    expect(explicitResult.mode).toBe("native_auth_compatible");
    expect(explicitResult.BFLOW_INSTRUCTION_HOME).toBe("native_auth_compatible");
    expect(explicitResult.CODEX_HOME).toBe(sourceCodexHome);
    expect(explicitResult.HOME).toBe(sourceProcessHome);
  });

  it("creates a sanitized 0700/0600 private CODEX_HOME when auth is isolatable and strips global instructions, hooks, plugins and mcp_servers", async () => {
    const sourceProcessHome = join(baseDir, "runsystem-operator-home");
    const sourceCodexHome = join(sourceProcessHome, ".codex");
    const stateDir = join(baseDir, "codex-private-state");
    await mkdir(join(sourceCodexHome, "skills", "global-skill"), { recursive: true, mode: 0o700 });
    await mkdir(join(sourceCodexHome, "plugins", "cache"), { recursive: true, mode: 0o700 });
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await writeFile(join(sourceCodexHome, "config.toml"), [
      'model = "gpt-5.4"',
      'review_model = "gpt-5.4-mini"',
      'model_provider = "runsystem"',
      'model_reasoning_effort = "high"',
      "",
      "[model_providers.runsystem]",
      'name = "RunSystem"',
      'base_url = "https://api.example.com/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.runsystem.auth]",
      'command = "/usr/local/bin/codex-token"',
      "",
      '[plugins."bflow-superpowers@bflow-superpowers"]',
      "enabled = true",
      "",
      "[mcp_servers.gitnexus]",
      'command = "/usr/bin/true"',
      "",
      "[hooks]",
      'SessionStart = [{ hooks = [{ type = "command", command = "/usr/bin/true" }] }]',
      ""
    ].join("\n"), { mode: 0o600 });
    // Even if a stale chatgpt auth.json exists alongside runsystem auth, it must NOT be copied.
    await writeFile(join(sourceCodexHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { refresh_token: "must-not-copy" }
    }), { mode: 0o600 });
    await writeFile(join(sourceCodexHome, "AGENTS.md"), "# Global AGENTS\n", { mode: 0o600 });
    await writeFile(join(sourceCodexHome, "AGENTS.override.md"), "# Global Override\n", { mode: 0o600 });
    await writeFile(join(sourceCodexHome, "RTK.md"), "# Global RTK\n", { mode: 0o600 });
    await writeFile(join(sourceCodexHome, "hooks.json"), '{"hooks":{}}\n', { mode: 0o600 });

    const prepared = await preparePrivateCodexHome(stateDir, sourceCodexHome, sourceProcessHome, {});
    expect(prepared.mode).toBe("private");
    expect(prepared.BFLOW_INSTRUCTION_HOME).toBe("private");
    expect(prepared.CODEX_HOME).toBe(join(stateDir, "codex-home"));
    expect(prepared.HOME).toBe(join(stateDir, "codex-process-home"));
    expect((await stat(prepared.CODEX_HOME)).mode & 0o777).toBe(0o700);
    expect((await stat(prepared.HOME)).mode & 0o777).toBe(0o700);

    const sanitizedConfigPath = join(prepared.CODEX_HOME, "config.toml");
    expect((await stat(sanitizedConfigPath)).mode & 0o777).toBe(0o600);
    const sanitizedText = await readFile(sanitizedConfigPath, "utf8");
    expect(sanitizedText).toContain("gpt-5.4");
    expect(sanitizedText).toContain("gpt-5.4-mini");
    expect(sanitizedText).toContain("runsystem");
    expect(sanitizedText).toContain("/usr/local/bin/codex-token");
    expect(sanitizedText).not.toContain("bflow-superpowers");
    expect(sanitizedText).not.toContain("gitnexus");
    expect(sanitizedText).not.toContain("SessionStart");

    // Rotating chatgpt auth.json and global instructions/hooks/skills/plugins must not exist in private CODEX_HOME.
    for (const forbidden of ["auth.json", "AGENTS.md", "AGENTS.override.md", "RTK.md", "hooks.json", "skills", "plugins"]) {
      await expect(stat(join(prepared.CODEX_HOME, forbidden))).rejects.toMatchObject({ code: "ENOENT" });
    }

    // When auth.json is a static API key (auth_mode = "apikey", no refresh_token), it is copied with 0600 mode.
    await writeFile(join(sourceCodexHome, "auth.json"), JSON.stringify({
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk-static-key-value"
    }), { mode: 0o600 });
    const stateDirStatic = join(baseDir, "codex-private-static-state");
    await mkdir(stateDirStatic, { recursive: true, mode: 0o700 });
    const staticPrepared = await preparePrivateCodexHome(stateDirStatic, sourceCodexHome, sourceProcessHome, {});
    expect(staticPrepared.mode).toBe("private");
    const copiedAuthPath = join(staticPrepared.CODEX_HOME, "auth.json");
    expect((await stat(copiedAuthPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(copiedAuthPath, "utf8"))).toEqual({
      auth_mode: "apikey",
      OPENAI_API_KEY: "sk-static-key-value"
    });

    // Verify DefaultPlatformReadinessService wires private CODEX_HOME across preflight and prepareLaunch
    // even when source auth.json is ChatGPT OAuth (so private CODEX_HOME has no auth.json) and codex login status exits 1.
    await writeFile(join(sourceCodexHome, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { refresh_token: "must-not-copy" }
    }), { mode: 0o600 });
    const fakeRunner = createFakeProviderRunner({
      scenario: "healthy",
      customHandler: (invocation) => {
        if (invocation.args.join(" ") === "login status") {
          return { exitCode: 1, stdout: "", stderr: "Not logged in\n", started: true };
        }
        return undefined;
      }
    });
    const { service } = buildService({
      gateway: false,
      runner: fakeRunner,
      codexLaunchEnvironment: { HOME: sourceProcessHome, CODEX_HOME: sourceCodexHome }
    });
    const sessionRes = await service.prepareSession(identity, [
      requirement({ role: "conversation", provider: "codex", taskId: undefined, skillSelections: [], toolIds: [] }),
      requirement({ role: "developer", provider: "codex", taskId: "t1" })
    ]);
    expect(sessionRes.ok).toBe(true);
    if (!sessionRes.ok) return;
    expect(sessionRes.value.report.ready).toBe(true);
    for (const roleSummary of sessionRes.value.report.roles) {
      expect(roleSummary.checks).toContainEqual(
        expect.objectContaining({
          check: "environment",
          status: "passed",
          code: "codex_instruction_home_private"
        })
      );
    }
    for (const launch of sessionRes.value.launches) {
      const expectedCodexHome = join(launch.environment.stateDirectory, "codex-home");
      const expectedProcessHome = join(launch.environment.stateDirectory, "codex-process-home");
      await expect(stat(join(expectedCodexHome, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(launch.launch.env).toMatchObject({
        BFLOW_INSTRUCTION_HOME: "private",
        CODEX_HOME: expectedCodexHome,
        HOME: expectedProcessHome
      });
      expect(launch.preflight.configFingerprint).toBe(launch.profile.environment.configFingerprint);
      expect(launch.profile.configFiles.some(file => file.path === join(expectedCodexHome, "config.toml"))).toBe(true);
    }
    const convLaunch = sessionRes.value.launches.find(launch => launch.role === "conversation")!;
    expect(convLaunch.launch.argv).toContain("project_doc_max_bytes=0");

    // Verify OPENAI_API_KEY env-based isolation forwards OPENAI_API_KEY into probe and launch env.
    const envKeyHome = join(baseDir, "env-key-operator-home");
    const envKeyCodexHome = join(envKeyHome, ".codex");
    await mkdir(envKeyCodexHome, { recursive: true, mode: 0o700 });
    await writeFile(join(envKeyCodexHome, "config.toml"), 'model = "gpt-5.4"\n', { mode: 0o600 });
    const observedProbeEnvs: Array<Readonly<Record<string, string | undefined>>> = [];
    const envKeyRunner = createFakeProviderRunner({
      scenario: "healthy",
      customHandler: (invocation) => {
        if (invocation.args.includes("ping")) {
          observedProbeEnvs.push({ ...(invocation.env ?? {}) });
        }
        if (invocation.args.join(" ") === "login status") {
          return { exitCode: 1, stdout: "", stderr: "Not logged in\n", started: true };
        }
        return undefined;
      }
    });
    const { service: envKeyService } = buildService({
      gateway: false,
      runner: envKeyRunner,
      codexLaunchEnvironment: {
        HOME: envKeyHome,
        CODEX_HOME: envKeyCodexHome,
        OPENAI_API_KEY: "sk-env-isolated-key"
      }
    });
    const envKeySession = await envKeyService.prepareSession(
      { ...identity, generation: 2 },
      [
        requirement({
          role: "developer",
          provider: "codex",
          taskId: "t-env-key"
        })
      ]
    );
    expect(envKeySession.ok).toBe(true);
    if (!envKeySession.ok) return;
    expect(envKeySession.value.report.ready).toBe(true);
    expect(envKeySession.value.launches[0]?.launch.env).toMatchObject({
      BFLOW_INSTRUCTION_HOME: "private",
      OPENAI_API_KEY: "sk-env-isolated-key"
    });
    expect(observedProbeEnvs[0]?.["OPENAI_API_KEY"]).toBe("sk-env-isolated-key");
  });

  it("launches Agy with a session and role private HOME outside untrusted role environment variables", async () => {
    const { service } = buildService({ gateway: false, providerFactory: contextProviderFactory(() => undefined) });
    const result = await service.prepareSession(identity, [requirement({ provider: "agy" })]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready, JSON.stringify(result.value.report.roles)).toBe(true);
    const launch = result.value.launches[0]!;
    const home = join(launch.environment.stateDirectory, "agy-home", launch.role);
    expect(launch.launch.env).toMatchObject({ HOME: home, XDG_CONFIG_HOME: join(home, ".config") });
    expect(launch.environment.environmentVariables).not.toHaveProperty("HOME");
    expect(launch.environment.environmentVariables).not.toHaveProperty("XDG_CONFIG_HOME");
  });

  it("prepares native Agy specialist launch material through the real adapter", async () => {
    const { service } = buildService({ gateway: false });
    const result = await service.prepareSession(identity, [requirement({ provider: "agy" })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready).toBe(true);
    expect(result.value.launches).toHaveLength(1);
    expect(result.value.report.roles[0]?.checks.some(check => check.code === "native_binding_unsupported")).toBe(false);
  });

  it("disables Claude updates for permanent and dynamic role processes", async () => {
    const { service } = buildService({ gateway: false });
    const { taskId: _taskId, ...role } = requirement({ role: "reviewer", skillSelections: [], toolIds: [] });
    const permanent = await service.prepareSession(identity, [role]);
    expect(permanent.ok).toBe(true);
    if (permanent.ok) expect(permanent.value.report.ready).toBe(true);
    if (permanent.ok) expect(permanent.value.launches[0]?.launch.env["DISABLE_AUTOUPDATER"]).toBe("1");
    const developer = await service.prepareDeveloper(identity, requirement());
    expect(developer.ok).toBe(true);
    if (developer.ok) expect(developer.value.launch.env["DISABLE_AUTOUPDATER"]).toBe("1");
  });

  it("passes the configured role model and effort through readiness and into launch argv", async () => {
    const { service } = buildService();
    const result = await service.prepareSession(identity, [requirement({ model: "sonnet", effort: "high" })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const launch = result.value.launches[0];
    expect(launch?.launch.argv).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "high"]));
  });

  it("launches nothing and revokes gateway registrations when a required role is blocked", async () => {
    const { service, journal } = buildService();
    const result = await service.prepareSession(identity, [
      requirement({ mcpServiceIds: ["svc-search"] }),
      requirement({
        taskId: "t2",
        mcpServiceIds: ["svc-search"],
        permissionMode: "unattended_isolated"
      })
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready).toBe(false);
    expect(result.value.launches).toEqual([]);
    expect(result.value.report.roles.map(role => role.status)).toEqual(["ready", "blocked"]);
    expect(result.value.report.roles[1]?.message).toContain("unattended_isolated");
    expect(gatewayControl.registrations.size).toBe(0);
    expect(await journalKinds(journal)).toEqual([]);
    expect(service.status().launches).toEqual([]);
  });

  it("blocks a required role on failed preflight and never calls prepareLaunch", async () => {
    const { service, journal } = buildService({
      runner: createFakeProviderRunner({ scenario: "auth_expired" })
    });
    const result = await service.prepareSession(identity, [requirement()]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready).toBe(false);
    expect(result.value.report.roles[0]?.status).toBe("blocked");
    expect(result.value.report.roles[0]?.checks.some(check => check.status === "failed")).toBe(true);
    expect(result.value.launches).toEqual([]);
    expect(await journalKinds(journal)).toEqual([]);
  });

  it("reports an optional blocked role and still launches the required ones", async () => {
    const { service, journal } = buildService();
    const result = await service.prepareSession(identity, [
      requirement(),
      requirement({ taskId: "t2", required: false, permissionMode: "unattended_isolated" })
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready).toBe(true);
    expect(result.value.report.roles.map(role => role.status)).toEqual(["ready", "blocked"]);
    expect(result.value.report.roles[1]?.required).toBe(false);
    expect(result.value.launches.map(launch => launch.taskId)).toEqual(["t1"]);
    expect(await journalKinds(journal)).toEqual(["intent"]);
  });

  it("blocks a role that needs Gateway services when no Gateway control is configured", async () => {
    const { service, journal } = buildService({ gateway: false });
    const result = await service.prepareSession(identity, [requirement({ mcpServiceIds: ["svc-search"] })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report.ready).toBe(false);
    expect(result.value.report.roles[0]?.status).toBe("blocked");
    expect(result.value.report.roles[0]?.message).toBe("Gateway control endpoint unavailable");
    expect(result.value.launches).toEqual([]);
    expect(await journalKinds(journal)).toEqual([]);
  });

  it("verifies activation with a ready live observation and records the activated state", async () => {
    const { service } = buildService();
    const prepared = await service.prepareSession(identity, [requirement()]);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const launchId = prepared.value.launches[0]?.launch.launchId ?? "";

    const activation = await service.verifyActivated({
      launchId, paneId: PANE_ID, nativeSession: NATIVE_SESSION, observation: LIVE_READY
    });
    expect(activation.ok).toBe(true);
    if (!activation.ok) return;
    expect(activation.value.stage).toBe("activated");
    expect(service.status().launches[0]).toEqual(expect.objectContaining({
      state: "activated",
      healthValidUntil: activation.value.validUntil
    }));
    expect(service.assertFresh(launchId).ok).toBe(true);
  });

  it("fails activation with a not-ready observation and records the failed state", async () => {
    const { service } = buildService();
    const prepared = await service.prepareSession(identity, [requirement()]);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const launchId = prepared.value.launches[0]?.launch.launchId ?? "";

    const activation = await service.verifyActivated({
      launchId,
      paneId: PANE_ID,
      nativeSession: NATIVE_SESSION,
      observation: { ...LIVE_READY, interactiveReady: false }
    });
    expect(activation.ok).toBe(false);
    expect(service.status().launches[0]?.state).toBe("failed");
  });

  it("returns not_found for an unknown launch id", async () => {
    const { service } = buildService();
    const activation = await service.verifyActivated({ launchId: "launch-unknown", paneId: PANE_ID, nativeSession: NATIVE_SESSION });
    expect(activation.ok).toBe(false);
    if (activation.ok) return;
    expect(activation.error.code).toBe("not_found");
    expect(service.assertFresh("launch-unknown").ok).toBe(false);
  });

  it("requires a developer role with a taskId for prepareDeveloper", async () => {
    const { service } = buildService();
    const { taskId: _omitted, ...withoutTask } = requirement();
    const noTask = await service.prepareDeveloper(identity, withoutTask);
    expect(noTask.ok).toBe(false);
    const wrongRole = await service.prepareDeveloper(identity, requirement({ role: "reviewer" }));
    expect(wrongRole.ok).toBe(false);
    expect(gatewayControl.registrations.size).toBe(0);
  });

  it("prepares a single developer launch and returns the error without launching when blocked", async () => {
    const { service, journal } = buildService();
    const launched = await service.prepareDeveloper(identity, requirement({ mcpServiceIds: ["svc-search"] }));
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    expect(launched.value.taskId).toBe("t1");
    expect(Object.keys(launched.value.launch.env)).toHaveLength(2);
    expect(launched.value.launch.env["DISABLE_AUTOUPDATER"]).toBe("1");
    expect(await journalKinds(journal)).toEqual(["intent"]);

    const blocked = await service.prepareDeveloper(identity, requirement({
      taskId: "t3",
      permissionMode: "unattended_isolated"
    }));
    expect(blocked.ok).toBe(false);
    expect(await journalKinds(journal)).toEqual(["intent"]);
  });

  it("releases a launch by revoking its registrations and is idempotent", async () => {
    const { service, journal } = buildService();
    const prepared = await service.prepareSession(identity, [requirement({ mcpServiceIds: ["svc-search"] })]);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const launchId = prepared.value.launches[0]?.launch.launchId ?? "";
    expect(gatewayControl.registrations.size).toBe(1);

    expect((await service.releaseLaunch(launchId)).ok).toBe(true);
    expect(gatewayControl.registrations.size).toBe(0);
    expect(service.status().launches[0]?.state).toBe("released");
    expect(service.assertFresh(launchId).ok).toBe(false);
    expect((await service.releaseLaunch(launchId)).ok).toBe(true);
    expect((await service.releaseLaunch("launch-unknown")).ok).toBe(true);
    // Released exactly once, so restart recovery never treats the intent as pending.
    expect(await journalKinds(journal)).toEqual(["intent", "released"]);
  });

  it("retires a previous daemon's launches and registrations after restart", async () => {
    const before = buildService();
    const prepared = await before.service.prepareSession(identity, [requirement({ mcpServiceIds: ["svc-search"] })]);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    expect(gatewayControl.registrations.size).toBe(1);

    // A new daemon: fresh in-memory service over the same journal, ledger and Gateway.
    const after = buildService();
    const recovered = await after.service.reconcileAfterRestart(identity);
    if (!recovered.ok) throw new Error(JSON.stringify(recovered.error));
    expect(recovered.value.releasedLaunchIds).toEqual([prepared.value.launches[0]?.launch.launchId]);
    expect(gatewayControl.registrations.size).toBe(0);
    expect(await journalKinds(after.journal)).toEqual(["intent", "released"]);
    // Idempotent: nothing left to retire.
    const again = await after.service.reconcileAfterRestart(identity);
    expect(again.ok && again.value.releasedLaunchIds).toEqual([]);
  });

  it("revokes every session registration on shutdown", async () => {
    const { service, journal } = buildService();
    const prepared = await service.prepareSession(identity, [requirement({ mcpServiceIds: ["svc-search"] })]);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    expect(gatewayControl.registrations.size).toBe(1);

    expect((await service.shutdown()).ok).toBe(true);
    expect(gatewayControl.registrations.size).toBe(0);
    expect(await journalKinds(journal)).toEqual(["intent", "released"]);
    expect(service.status().launches.every(launch => launch.state === "released")).toBe(true);
  });

  it("keeps serialized report, status and errors free of bearer token values", async () => {
    const { service } = buildService();
    const prepared = await service.prepareSession(identity, [requirement({ mcpServiceIds: ["svc-search"] })]);
    if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
    const tokens = gatewayControl.tokens();
    expect(tokens).toHaveLength(1);
    expect(JSON.stringify(prepared.value.report)).not.toContain(tokens[0] ?? "");
    expect(JSON.stringify(service.status())).not.toContain(tokens[0] ?? "");
    const denied = await service.prepareDeveloper(identity, requirement({ taskId: "t9", permissionMode: "unattended_isolated" }));
    expect(JSON.stringify(denied)).not.toContain(tokens[0] ?? "");
  });

  describe("Gateway registration verification", () => {
    async function activatedDeveloper(): Promise<{ service: DefaultPlatformReadinessService; launchId: string;
      registrationId: string; journal: FileLaunchJournal }> {
      const { service, journal } = buildService();
      const prepared = await service.prepareSession(identity, [requirement({ mcpServiceIds: ["svc-search"] })]);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const launchId = prepared.value.launches[0]?.launch.launchId ?? "";
      const registrationId = prepared.value.launches[0]?.gateway.registrations[0]?.registrationId ?? "";
      const activation = await service.verifyActivated({
        launchId, paneId: PANE_ID, nativeSession: NATIVE_SESSION, observation: LIVE_READY
      });
      if (!activation.ok) throw new Error(JSON.stringify(activation.error));
      return { service, launchId, registrationId, journal };
    }

    const ledgerFile = (): string => join(identity.stateDirectory, "gen-1", "gateway-registrations.json");

    it("keeps an activated launch fresh while its Gateway registration is present", async () => {
      const { service, launchId } = await activatedDeveloper();

      const verified = await service.verifyGateway();

      expect(verified.ok && verified.value.healthy).toBe(true);
      expect(service.assertFresh(launchId).ok).toBe(true);
      expect(service.status().launches[0]?.state).toBe("activated");
    });

    it("degrades the owning launch after a Gateway restart and fails closed for dispatch", async () => {
      const { service, launchId, registrationId } = await activatedDeveloper();
      const tokens = gatewayControl.tokens();
      expect(tokens).toHaveLength(1);

      gatewayControl.restart();
      const verified = await service.verifyGateway();

      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.value.healthy).toBe(false);
      expect(verified.value.lost).toEqual([{ registrationId, role: "developer", taskId: "t1" }]);
      expect(service.status().launches[0]).toEqual(expect.objectContaining({
        launchId, state: "degraded", reason: "gateway_registration_lost"
      }));

      const fresh = service.assertFresh(launchId);
      expect(fresh.ok).toBe(false);
      if (fresh.ok) return;
      expect(fresh.error.code).toBe("conflict");
      expect(fresh.error.details).toEqual({ code: "gateway_registration_lost" });

      const reactivated = await service.verifyActivated({
        launchId, paneId: PANE_ID, nativeSession: NATIVE_SESSION, observation: LIVE_READY
      });
      expect(reactivated.ok).toBe(false);
      expect(service.status().launches[0]?.state).toBe("degraded");

      const serialized = JSON.stringify([service.status(), verified]) + await readFile(ledgerFile(), "utf8");
      for (const token of tokens) expect(serialized).not.toContain(token);
    });

    it("releases a degraded launch cleanly and idempotently", async () => {
      const { service, launchId, journal } = await activatedDeveloper();
      gatewayControl.restart();
      expect((await service.verifyGateway()).ok).toBe(true);

      expect((await service.releaseLaunch(launchId)).ok).toBe(true);
      expect(service.status().launches[0]?.state).toBe("released");
      expect((await service.releaseLaunch(launchId)).ok).toBe(true);
      expect(gatewayControl.registrations.size).toBe(0);

      const kinds = await journalKinds(journal);
      expect(kinds.filter(kind => kind === "released")).toHaveLength(1);
      expect(kinds[kinds.length - 1]).toBe("released");
    });

    it("renews expired Gateway registrations in-place for mediated launches without degrading the role", async () => {
      let currentNow = new Date("2026-10-25T17:50:00.000Z");
      const { service } = buildService({ now: () => currentNow });
      const actualScope = {
        kind: "session" as const,
        machineId: identity.machineId,
        repositoryId: identity.repositoryId,
        workspaceRoot: identity.workspaceRoot,
        sessionId: identity.sessionId
      };
      const { policy, grant } = scopeSearchPolicyAndGrant("svc-search", actualScope);
      const prepared = await service.prepareSession(identity, [
        requirement({
          toolPolicy: policy,
          toolGrants: [grant],
          mcpServiceIds: ["svc-search"],
          mcpOperations: ["search"],
          toolIds: ["scope-search-tool"]
        })
      ]);
      if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
      const launchId = prepared.value.launches[0]?.launch.launchId ?? "";
      const activation = await service.verifyActivated({
        launchId,
        paneId: PANE_ID,
        nativeSession: NATIVE_SESSION,
        observation: LIVE_READY
      });
      if (!activation.ok) throw new Error(JSON.stringify(activation.error));
      const initialRegisterCalls = gatewayControl.registerCalls;

      // Advance past the 1-hour Gateway registration TTL (DEFAULT_TTL_MS = 3_600_000).
      currentNow = new Date(currentNow.getTime() + 3_600_000 + 1_000);
      const verified = await service.verifyGateway();

      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.value.healthy).toBe(true);
      expect(verified.value.lost).toEqual([]);
      expect(gatewayControl.registerCalls).toBe(initialRegisterCalls + 1);
      expect(service.status().launches[0]).toEqual(expect.objectContaining({
        launchId,
        state: "activated"
      }));
      expect(service.status().launches[0]?.reason).toBeUndefined();
    });
  });
});
