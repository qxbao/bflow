import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ContractError, MCPClientRegistration, MCPServiceObservation, OperationOptions,
  OperationResult, ScopedOperation, TrustScope
} from "@bflow/contracts";
import { createFakeProviderRunner, type ProviderCommandRunner } from "@bflow/agent-providers";
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
  GatewayControlPort, GatewayRegistrationGrant, PlatformSessionIdentity, RolePlatformRequirement
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
  } = {}): { service: DefaultPlatformReadinessService; journal: FileLaunchJournal } {
    const journal = new FileLaunchJournal(join(identity.stateDirectory, "launch-journal.jsonl"));
    const now = options.now ?? (() => new Date());
    const providers = new ProviderReadiness({
      factory: createProviderAdapterFactory({
        runner: options.runner ?? createFakeProviderRunner({ scenario: "healthy" }),
        now,
        perProvider: { claude: { executablePath: binaryPath, allowTestFilesystemOwnership: true } }
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
      rolePrompt: role => `Role prompt for ${role}.`,
      now
    });
    return { service, journal };
  }

  async function journalKinds(journal: FileLaunchJournal): Promise<string[]> {
    return (await journal.entries()).map(entry => entry.kind);
  }

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
