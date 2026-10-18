import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  AgentProviderIdSchema, AgentRoleSchema,
  type AgentProviderId, type AgentRole, type ContractError
} from "@bflow/contracts";
import type { LiveReadinessObservation } from "@bflow/agent-providers";
import { FileSkillStore, SkillManager } from "@bflow/skills";
import {
  createPlatformReadinessService, Ed25519LaunchAttestationSigner, GatewayControlClient,
  type GatewayControlPort, type HostLaunchExtras, type PlatformPreflightReport, type PlatformReadinessService,
  type PlatformSessionIdentity, type PlatformStatusSnapshot, type PreparedRoleLaunch, type RolePlatformRequirement
} from "../platform/index.js";
import {
  BFLOW_LAUNCH_ID_ENV, evaluateToolReachability, GATEWAY_PROBE_DIRECTORY, LAUNCH_REACHABILITY_DIRECTORY, publishLaunchProbe,
  readLaunchReachability, removeLaunchProbe, removeLaunchReachability, RoleToolReachabilitySchema, summarizeToolReachability,
  type ReachabilityExpectation, type ReachabilityVerdict, type RoleToolReachability
} from "./tool-reachability.js";
import {
  AgenticHostPlatformOptionsSchema, HostLaunchMaterialSchema, PlatformPreflightReportSchema,
  type AgenticHostPlatformOptions, type HostLaunchMaterial, type PlatformRoleOption
} from "../platform/host-options.js";

/**
 * Host-side P30 platform composition. Provider readiness is always delegated to the provider adapters
 * through PlatformReadinessService; nothing here checks a provider name to decide readiness.
 */

/** Mirrors the CLI command inventory. Runtime cannot import apps/cli; keep these lists in step. */
export const PLATFORM_SUPPORTED_COMMANDS = [
  "help", "version", "init", "up", "down", "attach", "status", "doctor", "recover", "run", "approve", "resume", "cancel",
  "repo inspect", "task plan", "task implement", "verify", "git prepare", "mcp status", "tool status", "tools status",
  "skills sync", "skills list", "agent check"
] as const;

const LIVE_TRANSPORT_STATES = ["starting", "accepted", "idle", "working", "blocked", "done", "unknown", "disconnected", "cancelled"] as const;
const INTERACTIVE_STATES: readonly string[] = ["idle", "working", "done"];
const PENDING_STATES: readonly string[] = ["starting", "accepted"];

export const HostNativeSessionSchema = z.object({
  source: z.string().min(1),
  kind: z.enum(["id", "path", "opaque"]),
  value: z.string().min(1)
}).strict();

/** Herdr `agent get` facts for one pane, observed by the host and never trusted beyond their shape. */
export interface HostAgentObservation {
  readonly name?: string;
  readonly status: string;
  readonly nativeSession?: z.infer<typeof HostNativeSessionSchema>;
}

const PlatformStatusLaunchSchema = z.object({
  launchId: z.string().min(1),
  role: AgentRoleSchema,
  provider: AgentProviderIdSchema,
  taskId: z.string().min(1).optional(),
  state: z.enum(["intent", "attested", "activated", "failed", "released", "degraded"]),
  healthValidUntil: z.string().optional(),
  reason: z.literal("gateway_registration_lost").optional()
}).strict();

/** `platform_status` RPC result. Carries no launch environment, bearer token or argv. */
export const HostPlatformStatusSchema = z.object({
  report: PlatformPreflightReportSchema.nullable(),
  status: z.object({
    generation: z.number().int().nonnegative().nullable(),
    launches: z.array(PlatformStatusLaunchSchema)
  }).strict(),
  gatewayDiagnostic: z.string().nullable(),
  /** In-process MCP tool reachability per prepared role with Gateway registrations. Carries no tokens. */
  toolReachability: z.array(RoleToolReachabilitySchema).optional()
}).strict();
export type HostPlatformStatus = z.infer<typeof HostPlatformStatusSchema>;

export interface HostPlatformLaunchResult {
  readonly report: PlatformPreflightReport;
  readonly launches: ReadonlyMap<AgentRole, PreparedRoleLaunch>;
  /** Reachability the provider process of each permanent role must prove; only roles with Gateway registrations. */
  readonly reachability: ReadonlyMap<AgentRole, ReachabilityExpectation>;
}

/** Structural shape of a Developer launch handed to Pane Manager (`AgentLaunchProfile`). */
export interface DeveloperLaunchMaterial {
  readonly provider: AgentProviderId;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly launchId: string;
  readonly launchFingerprint: string;
}

/** Turns a Herdr agent observation into the adapter's live readiness input. Unknown states fail closed. */
export function liveObservation(paneId: string, observed: HostAgentObservation): LiveReadinessObservation {
  const transportState = (LIVE_TRANSPORT_STATES as readonly string[]).includes(observed.status)
    ? observed.status as LiveReadinessObservation["transportState"]
    : "unknown";
  const nativeSession = observed.nativeSession === undefined ? undefined : HostNativeSessionSchema.parse(observed.nativeSession);
  return {
    paneId,
    ...(observed.name !== undefined ? { agentName: observed.name } : {}),
    transportState,
    interactiveReady: INTERACTIVE_STATES.includes(transportState),
    ...(nativeSession !== undefined ? { nativeSession } : {})
  };
}

/** Builds the readiness requirement for one configured role. Capabilities are the union of platform and host declarations. */
export function requirementFor(
  option: PlatformRoleOption,
  hostCapabilities: Readonly<Record<string, readonly string[]>>,
  cwd: string,
  taskId?: string
): RolePlatformRequirement {
  const declared = hostCapabilities[option.role] ?? [];
  return {
    role: option.role,
    provider: option.provider,
    required: option.required,
    permissionMode: option.permissionMode,
    cwd,
    ...(taskId !== undefined ? { taskId } : {}),
    capabilityIds: [...new Set([...option.capabilityIds, ...declared])],
    mcpServiceIds: [...option.mcpServiceIds],
    toolIds: [...option.toolIds],
    skillSelections: option.skillSelections.map(selection => ({
      skill: selection.skill,
      required: selection.required,
      ...(selection.approvalReceiptId !== undefined ? { approvalReceiptId: selection.approvalReceiptId } : {})
    })),
    ...(option.environmentVariables !== undefined ? { environmentVariables: { ...option.environmentVariables } } : {}),
    ...(option.isolation !== undefined ? { isolation: { kind: option.isolation.kind, proofId: option.isolation.proofId } } : {}),
    ...(option.network !== undefined ? { network: option.network as NonNullable<RolePlatformRequirement["network"]> } : {})
  };
}

/**
 * Launch material for Pane Manager. The only place a bearer-bearing `env` is copied; callers must not persist it.
 * Every launch also carries its non-secret launch id, which lets the provider hook select this launch's probe plan.
 */
export function launchMaterial(prepared: PreparedRoleLaunch): HostLaunchMaterial {
  return HostLaunchMaterialSchema.parse({
    provider: prepared.provider,
    argv: [...prepared.launch.argv],
    env: { ...prepared.launch.env, [BFLOW_LAUNCH_ID_ENV]: prepared.launch.launchId },
    launchId: prepared.launch.launchId,
    launchFingerprint: prepared.launch.launchFingerprint
  });
}

function describeFailure(error: ContractError): string {
  const details = typeof error.details === "object" && error.details !== null && !Array.isArray(error.details) ? error.details : undefined;
  const checks = Array.isArray(details?.["checks"]) ? details["checks"] : [];
  const failing = checks
    .filter((check): check is { check: string; status: string; message: string } =>
      typeof check === "object" && check !== null && (check as { status?: unknown }).status !== "passed")
    .map(check => `${check.check}: ${check.message}`);
  return failing.length > 0 ? `${error.message} (${failing.join("; ")})` : error.message;
}

async function writePrivateAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

const GenerationSchema = z.object({ generation: z.number().int().nonnegative() }).strict();
const LaunchesFileSchema = z.record(z.object({
  launchId: z.string().min(1),
  provider: AgentProviderIdSchema,
  taskId: z.string().min(1).optional()
}).strict());

export interface HostPlatformSessionOptions {
  readonly service: PlatformReadinessService;
  readonly platform: AgenticHostPlatformOptions;
  readonly repositoryPath: string;
  readonly sessionId: string;
  readonly stateDirectory: string;
  /** Private counter file; incremented on every `prepare`. */
  readonly generationFile: string;
  /** Private launch-id index for activation. Never contains launch env, argv or tokens. */
  readonly launchesFile: string;
  /** Directory of launch-keyed, token-free Gateway probe plans (`gateway-probes`). */
  readonly probeDirectory: string;
  /** Directory of launch-keyed reachability records reported by provider hooks (`launch-reachability`). */
  readonly reachabilityDirectory: string;
  readonly hostCapabilities: Readonly<Record<string, readonly string[]>>;
  readonly gatewayDiagnostic?: string | undefined;
}

/** One daemon's platform session: generation counter, launch ids for activation, and the Developer launch port. */
export class HostPlatformSession {
  private identity: PlatformSessionIdentity | undefined;
  private report: PlatformPreflightReport | undefined;
  private readonly launches = new Map<AgentRole, { launchId: string; provider: AgentProviderId }>();
  private readonly developerLaunches = new Map<string, string>();
  /** Active Developer launches by launch id: the reachability the launch must prove, or null without Gateway registrations. */
  private readonly developerGates = new Map<string, ReachabilityExpectation | null>();

  constructor(private readonly options: HostPlatformSessionOptions) {}

  /**
   * Preflights every non-Developer role and launches the ready set only when all required roles are ready.
   * Publishes the launch-keyed probe plan of every launch with Gateway registrations.
   */
  async prepare(): Promise<HostPlatformLaunchResult> {
    await this.releasePermanentLaunches();
    const generation = await this.nextGeneration();
    const identity: PlatformSessionIdentity = {
      machineId: this.options.platform.machineId,
      repositoryId: this.options.platform.repositoryId,
      workspaceRoot: this.options.repositoryPath,
      sessionId: this.options.sessionId,
      generation,
      stateDirectory: this.options.stateDirectory
    };
    this.identity = identity;
    const requirements = this.options.platform.roles
      .filter(option => option.role !== "developer")
      .map(option => requirementFor(option, this.options.hostCapabilities, this.options.repositoryPath));
    const result = await this.options.service.prepareSession(identity, requirements);
    if (!result.ok) throw new Error(`Platform readiness could not be prepared: ${describeFailure(result.error)}`);
    this.report = result.value.report;
    this.launches.clear();
    const reachability = new Map<AgentRole, ReachabilityExpectation>();
    try {
      for (const prepared of result.value.launches) {
        this.launches.set(prepared.role, { launchId: prepared.launch.launchId, provider: prepared.provider });
        const expectation = await publishLaunchProbe(this.options.probeDirectory, prepared);
        if (expectation !== undefined) reachability.set(prepared.role, expectation);
      }
    } catch (error) {
      // A launch whose plan cannot be published must not stay prepared: release everything from this generation.
      for (const prepared of result.value.launches) {
        await this.options.service.releaseLaunch(prepared.launch.launchId).catch(() => undefined);
        await this.removeLaunchArtifacts(prepared.launch.launchId).catch(() => undefined);
      }
      this.launches.clear();
      await this.persistLaunches();
      throw error;
    }
    await this.persistLaunches();
    return {
      report: result.value.report,
      launches: new Map(result.value.launches.map(prepared => [prepared.role, prepared])),
      reachability
    };
  }

  /** Requires an activated, ready verdict for every required role before startup is accepted. */
  async verifyActivation(
    panes: readonly { readonly role: AgentRole; readonly paneId: string }[],
    observe: (paneId: string) => Promise<HostAgentObservation>
  ): Promise<void> {
    for (const option of this.options.platform.roles) {
      if (!option.required || option.role === "developer") continue;
      const pane = panes.find(candidate => candidate.role === option.role);
      if (!pane) throw new Error(`Required platform role ${option.role} has no pane in the SessionManifest`);
      const launch = this.launches.get(option.role);
      if (launch === undefined) {
        throw new Error(`Required platform role ${option.role} has no prepared launch in this host process; run bflow up again`);
      }
      const observed = await observe(pane.paneId);
      const observation = liveObservation(pane.paneId, observed);
      if (observation.nativeSession === undefined) {
        if (PENDING_STATES.includes(observation.transportState)) {
          throw new Error(`[bflow:native-startup-pending] ${option.role} pane ${pane.paneId} has no native session yet`);
        }
        throw new Error(`Required platform role ${option.role} has no native session (transport ${observation.transportState})`);
      }
      const result = await this.options.service.verifyActivated({
        launchId: launch.launchId,
        paneId: pane.paneId,
        nativeSession: observation.nativeSession,
        observation
      });
      if (!result.ok) {
        if (PENDING_STATES.includes(observation.transportState)) {
          throw new Error(`[bflow:native-startup-pending] ${option.role} pane ${pane.paneId} is ${observation.transportState}; ${describeFailure(result.error)}`);
        }
        throw new Error(`Required platform role ${option.role} is not activated-ready: ${describeFailure(result.error)}`);
      }
    }
  }

  /**
   * Dynamic Developer launch for one task worktree. Blocked launches throw; no pane is created on failure.
   * Publishes the launch's own probe plan (keyed by launch id, so concurrent Developers never share a file).
   */
  async allocateDeveloper(taskId: string, worktreePath: string): Promise<DeveloperLaunchMaterial> {
    if (this.identity === undefined) throw new Error("Platform has no prepared generation; run bflow up again");
    const template = this.options.platform.roles.find(option => option.role === "developer");
    if (template === undefined) throw new Error("Platform configuration has no developer template for dynamic Developer launches");
    // Re-allocation for the same task (e.g. after restart) must not orphan the previous launch and its Gateway registration.
    await this.releaseDeveloper(taskId);
    const result = await this.options.service.prepareDeveloper(this.identity,
      requirementFor(template, this.options.hostCapabilities, worktreePath, taskId));
    if (!result.ok) throw new Error(`Developer ${taskId} launch is blocked: ${describeFailure(result.error)}`);
    const launchId = result.value.launch.launchId;
    let expectation: ReachabilityExpectation | undefined;
    try {
      expectation = await publishLaunchProbe(this.options.probeDirectory, result.value);
    } catch (error) {
      // Nothing may run with a registration whose probe plan the provider cannot read. Best-effort release, then report.
      await this.options.service.releaseLaunch(launchId).catch(() => undefined);
      throw error;
    }
    this.developerLaunches.set(taskId, launchId);
    this.developerGates.set(launchId, expectation ?? null);
    return launchMaterial(result.value);
  }

  /**
   * Reachability verdict for one active Developer launch, bound to the pane allocated for it. Pane Manager never sees
   * this: the Runtime-side Developer gate calls it after the pane exists.
   */
  async developerReachability(launchId: string, paneId: string): Promise<ReachabilityVerdict> {
    if (!this.developerGates.has(launchId)) throw new Error(`Developer launch ${launchId} is not active`);
    const expectation = this.developerGates.get(launchId);
    if (expectation === null || expectation === undefined) return { state: "ready" };
    const stored = await readLaunchReachability(this.options.reachabilityDirectory, launchId);
    if (stored !== undefined && stored.paneId !== paneId) {
      return { state: "pending", reason: "the published tool reachability record belongs to another pane" };
    }
    return evaluateToolReachability(expectation, stored?.reported);
  }

  /** Diagnostic reachability for every active Developer launch that has Gateway registrations. Carries no tokens. */
  async developerToolReachability(): Promise<RoleToolReachability[]> {
    const summaries: RoleToolReachability[] = [];
    for (const [launchId, expectation] of this.developerGates) {
      if (expectation === null) continue;
      const stored = await readLaunchReachability(this.options.reachabilityDirectory, launchId);
      summaries.push(summarizeToolReachability("developer", expectation, stored?.reported));
    }
    return summaries;
  }

  async releaseDeveloper(taskId: string): Promise<void> {
    const launchId = this.developerLaunches.get(taskId);
    if (launchId === undefined) return;
    const released = await this.options.service.releaseLaunch(launchId);
    if (!released.ok) throw new Error(`Developer ${taskId} launch release failed: ${describeFailure(released.error)}`);
    await this.removeLaunchArtifacts(launchId);
    this.developerLaunches.delete(taskId);
    this.developerGates.delete(launchId);
  }

  /** Revokes this session's Gateway registrations. Shared services are never stopped here. */
  async shutdown(): Promise<void> {
    const result = await this.options.service.shutdown();
    if (!result.ok) throw new Error(`Platform shutdown failed: ${describeFailure(result.error)}`);
    for (const launch of this.launches.values()) await this.removeLaunchArtifacts(launch.launchId);
    for (const launchId of this.developerLaunches.values()) await this.removeLaunchArtifacts(launchId);
    this.launches.clear();
    this.developerLaunches.clear();
    this.developerGates.clear();
    await this.persistLaunches();
  }

  status(): HostPlatformStatus {
    const snapshot: PlatformStatusSnapshot = this.options.service.status();
    return {
      report: this.report === undefined ? null : PlatformPreflightReportSchema.parse(this.report),
      status: {
        generation: snapshot.generation,
        launches: snapshot.launches.map(launch => ({
          launchId: launch.launchId,
          role: launch.role,
          provider: launch.provider,
          ...(launch.taskId !== undefined ? { taskId: launch.taskId } : {}),
          state: launch.state,
          ...(launch.healthValidUntil !== undefined ? { healthValidUntil: launch.healthValidUntil } : {})
        }))
      },
      gatewayDiagnostic: this.options.gatewayDiagnostic ?? null
    };
  }

  private async releasePermanentLaunches(): Promise<void> {
    for (const launch of this.launches.values()) {
      const released = await this.options.service.releaseLaunch(launch.launchId);
      if (!released.ok) throw new Error(`Previous platform launch could not be released: ${describeFailure(released.error)}`);
      await this.removeLaunchArtifacts(launch.launchId);
    }
    this.launches.clear();
  }

  /** Removes a released launch's probe plan and any reachability record. Revocation has already happened. */
  private async removeLaunchArtifacts(launchId: string): Promise<void> {
    await removeLaunchProbe(this.options.probeDirectory, launchId);
    await removeLaunchReachability(this.options.reachabilityDirectory, launchId);
  }

  private async nextGeneration(): Promise<number> {
    let current = 0;
    try {
      current = GenerationSchema.parse(JSON.parse(await readFile(this.options.generationFile, "utf8"))).generation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = current + 1;
    await writePrivateAtomic(this.options.generationFile, JSON.stringify({ generation: next }));
    return next;
  }

  private async persistLaunches(): Promise<void> {
    const content: Record<string, { launchId: string; provider: AgentProviderId }> = {};
    for (const [role, launch] of this.launches) content[role] = { launchId: launch.launchId, provider: launch.provider };
    await writePrivateAtomic(this.options.launchesFile, JSON.stringify(LaunchesFileSchema.parse(content)));
  }
}

export interface CreateHostPlatformSessionOptions {
  readonly platform: AgenticHostPlatformOptions;
  readonly repositoryPath: string;
  readonly sessionId: string;
  /** Host state directory, holding the generation counter and launch index. */
  readonly directory: string;
  readonly issuerId: string;
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
  readonly hostCapabilities: Readonly<Record<string, readonly string[]>>;
  readonly rolePrompt: (role: AgentRole) => string | undefined;
  /** Host-owned MCP entries and native hooks for one role (`hostLaunch` of the composition). */
  readonly hostLaunch: (role: AgentRole) => HostLaunchExtras | undefined;
  readonly nativeSessionHookCommand: (role: AgentRole) => string | undefined;
}

/** Opens the real composition: skills store, Gateway control (if located), host-held signer and provider adapters. */
export async function createHostPlatformSession(options: CreateHostPlatformSessionOptions): Promise<HostPlatformSession> {
  const platform = AgenticHostPlatformOptionsSchema.parse(options.platform);
  const skillManager = new SkillManager({
    store: new FileSkillStore(platform.skillsStoreRoot),
    supportedCommands: [...PLATFORM_SUPPORTED_COMMANDS],
    approvedBuiltinDigests: [...platform.approvedBuiltinSkillDigests]
  });

  let gatewayControl: GatewayControlPort | undefined;
  let gatewayEndpoint: string | undefined;
  let gatewayDiagnostic: string | undefined;
  if (platform.gatewayLocatorPath !== undefined) {
    const client = await GatewayControlClient.fromLocator(platform.gatewayLocatorPath);
    if (client.ok) {
      try {
        const locator = z.object({ endpoint: z.string().min(1) }).passthrough().parse(JSON.parse(await readFile(platform.gatewayLocatorPath, "utf8")));
        gatewayControl = client.value;
        gatewayEndpoint = locator.endpoint;
      } catch {
        gatewayDiagnostic = "Gateway control locator endpoint is unreadable";
      }
    } else {
      gatewayDiagnostic = client.error.message;
    }
  }

  const stateDirectory = join(options.repositoryPath, ".bflow/state/platform", options.sessionId);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const service = createPlatformReadinessService({
    stateDirectory,
    skillManager,
    ...(gatewayControl !== undefined ? { gatewayControl } : {}),
    ...(gatewayEndpoint !== undefined ? { gatewayEndpoint } : {}),
    signer: new Ed25519LaunchAttestationSigner({ issuerId: options.issuerId, privateKeyPem: options.privateKeyPem, publicKeyPem: options.publicKeyPem }),
    rolePrompt: options.rolePrompt,
    nativeSessionHookCommand: role => options.nativeSessionHookCommand(role),
    hostLaunch: role => options.hostLaunch(role)
  });
  return new HostPlatformSession({
    service,
    platform,
    repositoryPath: options.repositoryPath,
    sessionId: options.sessionId,
    stateDirectory,
    generationFile: join(options.directory, "platform-generation.json"),
    launchesFile: join(options.directory, "platform-launches.json"),
    probeDirectory: join(options.directory, GATEWAY_PROBE_DIRECTORY),
    reachabilityDirectory: join(options.directory, LAUNCH_REACHABILITY_DIRECTORY),
    hostCapabilities: options.hostCapabilities,
    ...(gatewayDiagnostic !== undefined ? { gatewayDiagnostic } : {})
  });
}

/** Writes `host.json` with a new platform block, keeping socket, token and directory. Caller holds the boot lock. */
export async function rewritePersistedPlatform(path: string, platform: AgenticHostPlatformOptions | undefined): Promise<void> {
  const current = z.record(z.unknown()).parse(JSON.parse(await readFile(path, "utf8")));
  await writePrivateAtomic(path, JSON.stringify({ ...current, platform }));
}
