import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MCPClientRegistrationSchema,
  MCPResourceLeaseSchema,
  type AgentEnvironment,
  type AgentHealthRequest,
  type AgentHealthResult,
  type AgentLaunchProfile,
  type AgentProviderAdapter,
  type AgentProviderDescriptor,
  type MCPClientRegistration,
  type MCPResourceLease,
  type MCPServiceObservation,
  type MCPToolCall,
  type MCPToolCallResult,
  type OperationOptions,
  type OperationResult,
  type ScopedOperation,
  type TrustScope
} from "@bflow/contracts";
import { createFakeProviderRunner } from "@bflow/agent-providers";
import { SkillFileStore, SkillManager, bundleDigest, type BundleFiles } from "@bflow/skills";
import { profile as specialistProfile } from "./role-profile-fixture.js";
import { BrowserResourceTransactions } from "../../src/platform/browser-resource-transactions.js";
import { createProviderAdapterFactory, createSkillResolver } from "../../src/platform/defaults.js";
import { RoleEnvironmentResolver } from "../../src/platform/environment.js";
import { failWith, ok } from "../../src/platform/errors.js";
import { GatewayRegistrationManager } from "../../src/platform/gateway-registrations.js";
import { FileLaunchJournal } from "../../src/platform/launch-journal.js";
import { Ed25519LaunchAttestationSigner } from "../../src/platform/attestation-signer.js";
import type {
  GatewayControlPort,
  GatewayRegistrationGrant,
  PlatformSessionIdentity,
  ProviderAdapterFactory,
  RolePlatformRequirement
} from "../../src/platform/ports.js";
import { ProviderReadiness } from "../../src/platform/provider-readiness.js";
import { persistRoleProfileSnapshot } from "../../src/platform/role-profiles.js";
import { DefaultPlatformReadinessService } from "../../src/platform/service.js";
import { SkillSessionStore } from "../../src/platform/skills-session.js";
import { FileToolUsageLedger } from "../../src/platform/tool-usage-ledger.js";

const ENDPOINT = "http://127.0.0.1:7777/mcp";
const originalOpen = fsPromises.open;
const originalEnvPath = process.env["PATH"];

class FakeGatewayControl implements GatewayControlPort {
  readonly registrations = new Map<string, { registration: MCPClientRegistration; bearerToken: string }>();
  readonly revokeCalls: string[] = [];
  services: MCPServiceObservation[] = [
    {
      schemaVersion: 3,
      serviceId: "svc-search",
      revision: 1,
      instanceId: "svc-search-1",
      status: "ready",
      protocolVersion: "2025-06-18",
      discoveredTools: ["search", "read"],
      ownership: "bflow",
      activeClientCount: 0,
      observedAt: "2026-10-31T00:00:00.000Z",
      diagnosticCode: "ok"
    }
  ];

  async register(
    registration: MCPClientRegistration,
    _options?: OperationOptions
  ): Promise<OperationResult<GatewayRegistrationGrant>> {
    const bearerToken = randomBytes(24).toString("hex");
    this.registrations.set(registration.registrationId, { registration, bearerToken });
    return ok({ registration, bearerToken });
  }

  async revoke(
    registrationId: string,
    _operation: ScopedOperation,
    _options?: OperationOptions
  ): Promise<OperationResult<void>> {
    this.revokeCalls.push(registrationId);
    this.registrations.delete(registrationId);
    return ok(undefined);
  }

  async list(scope: TrustScope): Promise<OperationResult<readonly MCPClientRegistration[]>> {
    return ok(
      [...this.registrations.values()]
        .map(entry => entry.registration)
        .filter(registration => JSON.stringify(registration.scope) === JSON.stringify(scope))
    );
  }

  async inspectServices(): Promise<OperationResult<readonly MCPServiceObservation[]>> {
    return ok(this.services);
  }
}

const skillBody = (name: string) =>
  `---\nname: ${name}\ndescription: Inspect an assigned task before implementation.\n---\n\n${[
    "Supported roles",
    "Prerequisites",
    "Trigger conditions",
    "Required inputs",
    "Expected outputs",
    "Procedure",
    "Bflow commands",
    "Verification requirements",
    "Error handling",
    "Escalation rules",
    "Concrete examples"
  ]
    .map(h => `## ${h}\n\nUse the accepted task and preserve Runtime authority.`)
    .join("\n\n")}\n`;

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

const HEALTH_CHECKS = [
  "binary",
  "version",
  "authentication",
  "environment",
  "mcp",
  "launch_arguments",
  "permissions",
  "skills",
  "native_binding"
].map(check => ({
  check: check as
    | "binary"
    | "version"
    | "authentication"
    | "environment"
    | "mcp"
    | "launch_arguments"
    | "permissions"
    | "skills"
    | "native_binding",
  status: "passed" as const,
  code: "ok",
  message: "passed"
}));

describe("Slice 2 platform readiness hardening", () => {
  let baseDir: string;
  let workspace: string;
  let stateDirectory: string;
  let identity: PlatformSessionIdentity;
  let gatewayControl: FakeGatewayControl;
  let skillManager: SkillManager;
  let skillPin: { skillId: string; version: string; digest: string };
  let signer: Ed25519LaunchAttestationSigner;

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-slice2-platform-")));
    workspace = join(baseDir, "workspace");
    stateDirectory = join(baseDir, "state");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(workspace, 0o700);
    await chmod(stateDirectory, 0o700);

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
      store: new SkillFileStore(join(baseDir, "skills-store")),
      supportedCommands: ["status", "help", "doctor"],
      approvedBuiltinDigests: [digest]
    });
    const installed = await skillManager.installBundle(files, { source: "builtin", expectedDigest: digest });
    skillPin = { skillId: installed.skillId, version: installed.version, digest: installed.digest };
    gatewayControl = new FakeGatewayControl();
    signer = Ed25519LaunchAttestationSigner.generate("bflow-slice2-host");
  });

  afterEach(async () => {
    if (fsPromises.open !== originalOpen) {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
    }
    if (originalEnvPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalEnvPath;
    await rm(baseDir, { recursive: true, force: true });
  });

  function requirement(overrides: Partial<RolePlatformRequirement> = {}): RolePlatformRequirement {
    return {
      role: "developer",
      provider: "claude",
      required: true,
      permissionMode: "workspace_auto",
      cwd: workspace,
      taskId: "t-slice2",
      capabilityIds: [],
      mcpServiceIds: [],
      toolIds: ["search"],
      skillSelections: [{ skill: skillPin, required: true }],
      ...overrides
    };
  }

  it("sanitizes launch.env.PATH when an earlier PATH entry contains directories named claude/codex/agy (preventing EISDIR on Developer allocation)", async () => {
    // Exact reproduction of /home/baodq/.local/share/bflow/tools/superpowers/{claude,codex,agy}
    const superpowersToolsDir = join(baseDir, "tools", "superpowers");
    for (const providerName of ["claude", "codex", "agy"]) {
      await mkdir(join(superpowersToolsDir, providerName), { recursive: true, mode: 0o755 });
    }

    const realBinDir = join(baseDir, "real-bin");
    await mkdir(realBinDir, { recursive: true, mode: 0o755 });
    const realClaudePath = join(realBinDir, "claude");
    await writeFile(realClaudePath, "#!/bin/sh\necho claude-ok\n", { mode: 0o755 });
    await chmod(realClaudePath, 0o755);

    process.env["PATH"] = [superpowersToolsDir, realBinDir, "/usr/bin", "/bin"].join(delimiter);

    const journal = new FileLaunchJournal(join(stateDirectory, "launch-journal.jsonl"));
    const providers = new ProviderReadiness({
      factory: createProviderAdapterFactory({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        perProvider: {
          claude: { allowTestFilesystemOwnership: true }
        }
      }),
      journal
    });
    const service = new DefaultPlatformReadinessService({
      environments: new RoleEnvironmentResolver(),
      skills: new SkillSessionStore({ resolver: createSkillResolver(skillManager) }),
      gateway: new GatewayRegistrationManager({ control: gatewayControl, endpoint: ENDPOINT }),
      providers,
      journal,
      signer,
      rolePrompt: role => `Role prompt for ${role}.`
    });

    const prepared = await service.prepareDeveloper(identity, requirement({ provider: "claude" }));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    // Exact PATH walk performed by DeveloperProcessScopes.prepare (developer-process-scope.ts:83-92):
    const originalPath = prepared.value.launch.env["PATH"] ?? process.env["PATH"] ?? "/usr/bin:/bin";
    let target: string | undefined;
    for (const dir of originalPath.split(delimiter)) {
      try {
        const candidate = await realpath(join(dir, "claude"));
        await access(candidate, constants.X_OK);
        target = candidate;
        break;
      } catch {
        // continue
      }
    }
    expect(target).toBe(await realpath(realClaudePath));
    const targetDigest = createHash("sha256").update(await readFile(target!)).digest("hex");
    expect(targetDigest).toBe(prepared.value.profile.executableDigest);
  });

  it("revokes touched Gateway registrations and returns structured failures when provider preflight or prepareLaunch throws unexpectedly", async () => {
    let throwIn: "preflight" | "prepareLaunch" = "preflight";
    const throwingFactory: ProviderAdapterFactory = () => {
      const adapter: AgentProviderAdapter = {
        descriptor: {} as AgentProviderDescriptor,
        async checkHealth(request: AgentHealthRequest): Promise<OperationResult<AgentHealthResult>> {
          if (throwIn === "preflight") throw new Error("unexpected adapter preflight crash");
          const now = new Date();
          return ok({
            schemaVersion: 3,
            environmentId: request.environment.environmentId,
            provider: request.environment.provider,
            role: request.environment.role,
            configFingerprint: request.environment.configFingerprint,
            stage: request.stage,
            status: "ready",
            checkedAt: now.toISOString(),
            validUntil: new Date(now.getTime() + 60_000).toISOString(),
            checks: HEALTH_CHECKS
          });
        },
        async prepareLaunch(_environment: AgentEnvironment): Promise<OperationResult<AgentLaunchProfile>> {
          if (throwIn === "prepareLaunch") throw new Error("unexpected adapter prepareLaunch crash");
          return failWith({ code: "validation", retryable: false, message: "unreachable" });
        }
      };
      return adapter;
    };

    const journal = new FileLaunchJournal(join(stateDirectory, "launch-journal.jsonl"));
    const service = new DefaultPlatformReadinessService({
      environments: new RoleEnvironmentResolver(),
      skills: new SkillSessionStore({ resolver: createSkillResolver(skillManager) }),
      gateway: new GatewayRegistrationManager({ control: gatewayControl, endpoint: ENDPOINT }),
      providers: new ProviderReadiness({ factory: throwingFactory, journal }),
      journal,
      signer,
      rolePrompt: role => `Role prompt for ${role}.`
    });

    const preflightCrash = await service.prepareDeveloper(
      identity,
      requirement({ taskId: "t-crash-1", mcpServiceIds: ["svc-search"] })
    );
    expect(preflightCrash.ok).toBe(false);
    expect(gatewayControl.registrations.size).toBe(0);
    expect(gatewayControl.revokeCalls).toHaveLength(1);

    const preflightOnlyCrash = await service.preflightDeveloper(
      identity,
      requirement({ taskId: "t-crash-2", mcpServiceIds: ["svc-search"] })
    );
    expect(preflightOnlyCrash.ok).toBe(false);
    expect(gatewayControl.registrations.size).toBe(0);
    expect(gatewayControl.revokeCalls).toHaveLength(2);

    throwIn = "prepareLaunch";
    const launchCrash = await service.prepareDeveloper(
      identity,
      requirement({ taskId: "t-crash-3", mcpServiceIds: ["svc-search"] })
    );
    expect(launchCrash.ok).toBe(false);
    expect(gatewayControl.registrations.size).toBe(0);
    expect(gatewayControl.revokeCalls).toHaveLength(3);
  });

  it("tolerates FUSE/NTFS directory fsync EINVAL across SkillSessionStore, FileLaunchJournal, BrowserResourceTransactions, RoleProfiles, and FileToolUsageLedger", async () => {
    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      const info = await handle.stat();
      if (info.isDirectory()) {
        handle.sync = async () => {
          throw Object.assign(new Error("EINVAL: invalid argument, fsync"), { code: "EINVAL" });
        };
      }
      return handle;
    }) as typeof originalOpen;
    syncBuiltinESMExports();

    // 1. SkillSessionStore
    const skillStore = new SkillSessionStore({ resolver: createSkillResolver(skillManager) });
    const resolvedSkills = await skillStore.resolveForRole(identity, requirement({ taskId: "t-fuse" }), "env-fuse");
    expect(resolvedSkills.ok).toBe(true);

    // 2. FileLaunchJournal
    const journal = new FileLaunchJournal(join(stateDirectory, "fuse-journal", "launch-journal.jsonl"));
    await journal.append({
      kind: "intent",
      launchId: "launch-fuse-1",
      environmentId: "env-fuse",
      role: "developer",
      provider: "claude",
      generation: 1,
      launchFingerprint: "a".repeat(64),
      configFingerprint: "b".repeat(64),
      recordedAt: new Date().toISOString()
    });
    expect(await journal.entries()).toHaveLength(1);

    // 3. persistRoleProfileSnapshot
    const snapshot = specialistProfile();
    const snapshotFile = await persistRoleProfileSnapshot(identity, snapshot);
    expect(snapshotFile).toContain(snapshot.pin.digest);

    // 4. FileToolUsageLedger
    const usageLedger = new FileToolUsageLedger(join(stateDirectory, "fuse-ledger", "tool-usage.json"));
    await usageLedger.begin({
      schemaVersion: 3,
      runId: "run-fuse",
      taskId: "t-fuse",
      role: "developer",
      sessionId: identity.sessionId,
      generation: 1,
      invocationId: "inv-fuse-1",
      toolId: "search",
      serviceId: "svc-search",
      operation: "search",
      status: "started",
      observedAt: new Date().toISOString()
    });
    expect(await usageLedger.list()).toHaveLength(1);

    // 5. BrowserResourceTransactions
    const now = new Date("2026-10-31T10:00:00.000Z");
    let activeLease: MCPResourceLease | undefined;
    const browserControl = {
      async acquireResource(req) {
        activeLease = MCPResourceLeaseSchema.parse({
          schemaVersion: 3,
          leaseId: "lease-fuse-1",
          registrationId: req.registrationId,
          serviceId: req.serviceId,
          resourceKey: req.resourceKey,
          fencingToken: 1,
          acquiredAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + req.ttlMs).toISOString()
        });
        return ok(activeLease);
      },
      async renewResource(req) {
        return ok(req.lease);
      },
      async releaseResource() {
        activeLease = undefined;
        return ok(undefined);
      },
      async invokeTool(call: MCPToolCall): Promise<OperationResult<MCPToolCallResult>> {
        return ok({ schemaVersion: 3, callId: call.callId, status: "completed", output: {}, observedAt: now.toISOString() });
      },
      async reconcileToolCall(call: MCPToolCall): Promise<OperationResult<MCPToolCallResult>> {
        return ok({ schemaVersion: 3, callId: call.callId, status: "completed", output: {}, observedAt: now.toISOString() });
      }
    } as GatewayControlPort;
    const browserTx = new BrowserResourceTransactions(browserControl, () => now);
    const reg = MCPClientRegistrationSchema.parse({
      schemaVersion: 3,
      registrationId: "reg-fuse-1",
      role: "tester",
      provider: "codex",
      environmentId: "env-tester",
      scope: {
        kind: "session",
        machineId: identity.machineId,
        repositoryId: identity.repositoryId,
        workspaceRoot: identity.workspaceRoot,
        sessionId: identity.sessionId
      },
      serviceIds: ["chrome-service"],
      allowedTools: ["navigate_page"],
      configDigest: "c".repeat(64),
      expiresAt: "2026-10-31T12:00:00.000Z",
      idempotencyKey: "reg-fuse-1",
      connection: { transport: "streamable_http", endpoint: ENDPOINT, token: "secret://bflow/test" }
    });
    const txRes = await browserTx.invoke(
      identity,
      reg,
      {
        schemaVersion: 3,
        callId: "call-fuse-1",
        idempotencyKey: "call-fuse-1",
        registrationId: "reg-fuse-1",
        serviceId: "chrome-service",
        tool: "navigate_page",
        input: { url: "https://example.test" }
      },
      { id: "tx-fuse-1", resourceKey: "chrome-profile" },
      false
    );
    expect(txRes.ok).toBe(true);
  });
});
