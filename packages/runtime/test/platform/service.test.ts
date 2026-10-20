import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentEnvironment, AgentHealthRequest, AgentHealthResult, AgentLaunchProfile, AgentProviderAdapter, AgentProviderDescriptor,
  ContractError, MCPClientRegistration, MCPServiceObservation, OperationOptions, OperationResult, ScopedOperation, TrustScope
} from "@bflow/contracts";
import { createFakeProviderRunner, type ProviderCommandInvocation, type ProviderCommandRunner } from "@bflow/agent-providers";
import { SkillFileStore, SkillManager, bundleDigest, type BundleFiles } from "@bflow/skills";
import { failWith, ok } from "../../src/platform/errors.js";
import { Ed25519LaunchAttestationSigner } from "../../src/platform/attestation-signer.js";
import { RoleEnvironmentResolver } from "../../src/platform/environment.js";
import { FileLaunchJournal } from "../../src/platform/launch-journal.js";
import { GatewayRegistrationManager } from "../../src/platform/gateway-registrations.js";
import { ProviderReadiness } from "../../src/platform/provider-readiness.js";
import { SkillSessionStore } from "../../src/platform/skills-session.js";
import { DefaultPlatformReadinessService } from "../../src/platform/service.js";
import { createProviderAdapterFactory, createSkillResolver } from "../../src/platform/defaults.js";
import type {
  GatewayControlPort, GatewayRegistrationGrant, PlatformSessionIdentity, ProviderAdapterContext, ProviderAdapterFactory,
  RolePlatformRequirement
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
  services: MCPServiceObservation[] = [];
  failNextRegister: ContractError | undefined;

  async register(registration: MCPClientRegistration, _options?: OperationOptions):
    Promise<OperationResult<GatewayRegistrationGrant>> {
    if (this.failNextRegister) {
      const failure = this.failNextRegister;
      this.failNextRegister = undefined;
      return failWith(failure);
    }
    const bearerToken = randomBytes(24).toString("hex");
    this.registrations.set(registration.registrationId, { registration, bearerToken });
    return ok({ registration, bearerToken });
  }

  async revoke(registrationId: string, _operation: ScopedOperation, _options?: OperationOptions):
    Promise<OperationResult<void>> {
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

function observation(serviceId: string): MCPServiceObservation {
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
    diagnosticCode: "ok"
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
    runner?: ProviderCommandRunner;
    gateway?: boolean;
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
          codex: { executablePath: binaryPath, allowTestFilesystemOwnership: true,
            codexHomeDirectory: join(baseDir, "test-codex-home"),
            codexHookApprovalPath: join(identity.stateDirectory, "codex-hook-approvals.json") }
        }
      }),
      journal,
      now
    });
    const gateway = options.gateway === false
      ? undefined
      : new GatewayRegistrationManager({ control: gatewayControl, endpoint: ENDPOINT, now });
    const service = new DefaultPlatformReadinessService({
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
    const tokenValues = Object.values(gatewayLaunch?.launch.env ?? {});
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
    expect(Object.keys(launched.value.launch.env)).toHaveLength(1);
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
  });
});
