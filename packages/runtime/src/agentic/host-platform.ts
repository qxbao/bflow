import { RoleCapabilityPreflightError } from "./ports.js";
import { resolveRoleProfile } from "../platform/role-profiles.js";
import { assertProfileSnapshotCurrent } from "./profile-admission.js";
import { sameRoleProfilePin, canonicalReceiptJson, ExecutorLineageSchema, RoleProfilePinSchema, ROLE_PROFILE_FEATURE, type ResolvedRoleProfileSnapshot, type ExecutorLineage, type ResolvedToolGrant } from "@bflow/contracts";
import { readSkillApproval } from "./skill-approval.js";
import type { GatewayToolOperationOptions } from "../platform/browser-resource-transactions.js";
import { DeveloperProcessScopes } from "./developer-process-scope.js";
import type { AgentExecutionHandle, AgentRequest } from "@bflow/contracts";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { chmod, copyFile, mkdir, open, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  AgentProviderIdSchema, AgentRoleSchema,
  type AgentProviderId, type AgentRole, type ContractError, type OperationOptions, type PaneBinding
} from "@bflow/contracts";
import {
  createManagedCodexHookEnvironment, createProviderProcessRunner,
  type LiveReadinessObservation, type ProviderCommandOutcome, type ProviderCommandRunner
} from "@bflow/agent-providers";
import { FileSkillStore, SkillManager } from "@bflow/skills";
import type { SkillManifest } from "@bflow/contracts";
import {
  createPlatformReadinessService, createProviderAdapterFactory, Ed25519LaunchAttestationSigner, GatewayControlClient,
  type GatewayControlPort, type HostLaunchExtras, type PlatformPreflightReport, type PlatformReadinessService,
  type PlatformSessionIdentity, type PlatformStatusSnapshot, type PreparedRoleLaunch, type ProviderAdapterFactoryOptions,
  type ProviderAdapterFactory, type RolePlatformRequirement
} from "../platform/index.js";
import type { JsonValue, MCPToolCallResult, OperationResult, ToolTrigger } from "@bflow/contracts";
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
/** Skill-referenceable commands come from the CLI's command reference via platform options; never a local copy. */
export function skillSupportedCommands(platform: AgenticHostPlatformOptions): string[] {
  return [...(platform.supportedCommands ?? [])];
}

const LIVE_TRANSPORT_STATES = ["starting", "accepted", "idle", "working", "blocked", "done", "unknown", "disconnected", "cancelled"] as const;
const INTERACTIVE_STATES: readonly string[] = ["idle", "working", "done"];
const PENDING_STATES: readonly string[] = ["starting", "accepted"];
const MAX_ACTIVATION_CONCURRENCY = 3;

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
  roleProfile: RoleProfilePinSchema.optional(),
  launchId: z.string().min(1),
  role: AgentRoleSchema,
  provider: AgentProviderIdSchema,
  taskId: z.string().min(1).optional(),
  state: z.enum(["intent", "attested", "activated", "failed", "released", "degraded"]),
  healthValidUntil: z.string().optional(),
  reason: z.literal("gateway_registration_lost").optional()
}).strict();

/** Which path proved a permanent role's startup and its Gateway reachability. `none` until that path has reported. */
export const StartupProofSourceSchema = z.enum(["hook", "mcp_bootstrap", "none"]);
export const StartupProofSchema = z.object({
  role: AgentRoleSchema,
  paneId: z.string().min(1),
  launchId: z.string().min(1).optional(),
  startupSource: StartupProofSourceSchema,
  reachabilitySource: StartupProofSourceSchema
}).strict();
export type StartupProof = z.infer<typeof StartupProofSchema>;

/** `platform_status` RPC result. Carries no launch environment, bearer token or argv. */
export const HostPlatformStatusSchema = z.object({
  report: PlatformPreflightReportSchema.nullable(),
  status: z.object({
    generation: z.number().int().nonnegative().nullable(),
    launches: z.array(PlatformStatusLaunchSchema)
  }).strict(),
  gatewayDiagnostic: z.string().nullable(),
  /** Launches retired because the host daemon restarted (their material was in the previous daemon's memory). */
  restartRecovery: z.object({ recoveredAt: z.string(), releasedLaunchIds: z.array(z.string().min(1)) }).strict().optional(),
  /** Last Gateway registration reconciliation (F5); lost registrations degrade their launches until relaunch. */
  gateway: z.object({
    checkedAt: z.string(),
    healthy: z.boolean(),
    uncertain: z.boolean(),
    lost: z.array(z.object({ registrationId: z.string().min(1), role: z.string().min(1), taskId: z.string().min(1).optional() }).strict()),
    error: z.string().optional()
  }).strict().nullable().optional(),
  /** In-process MCP tool reachability per prepared role with Gateway registrations. Carries no tokens. */
  toolReachability: z.array(RoleToolReachabilitySchema).optional(),
  /** Per permanent non-Developer role: which proof path (SessionStart hook or MCP bootstrap) established startup. */
  startupProof: z.array(StartupProofSchema).optional(),
  /** Why the latest Developer launch ran without launch-bound process supervision (legacy stop semantics apply). */
  developerProcessSupervisionUnavailable: z.string().optional()
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
  readonly roleProfile?: import("@bflow/contracts").RoleProfilePin | undefined;
  readonly features?: readonly string[] | undefined;
  readonly promptSource?: string | undefined;
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
  taskId?: string,
  toolGrants: AgenticHostPlatformOptions["toolGrants"] = undefined,
  toolPolicy: AgenticHostPlatformOptions["toolPolicy"] = undefined
): RolePlatformRequirement {
  const declared = hostCapabilities[option.role] ?? [];
  const roleGrants = (toolGrants ?? []).filter(grant => grant.role === option.role);
  return {
    role: option.role,
    provider: option.provider,
    ...(option.profileName !== undefined ? { profileName: option.profileName } : {}),
    required: option.required,
    ...(option.model !== undefined ? { model: option.model } : {}),
    ...(option.effort !== undefined ? { effort: option.effort } : {}),
    ...(option.preferenceConstraints !== undefined ? { preferenceConstraints: option.preferenceConstraints } : {}),
    permissionMode: option.permissionMode,
    cwd,
    ...(taskId !== undefined ? { taskId } : {}),
    capabilityIds: [...new Set([...option.capabilityIds, ...declared])],
    mcpServiceIds: toolGrants === undefined
      ? [...option.mcpServiceIds]
      : [...new Set(roleGrants.filter(grant => grant.kind !== "cli_only").map(grant => grant.serviceId!))],
    ...(toolGrants !== undefined ? { mcpOperations: [...new Set(roleGrants.filter(grant => grant.kind !== "cli_only").flatMap(grant => grant.operations))] } : {}),
    ...(toolGrants !== undefined ? { toolGrants: roleGrants } : {}),
    ...(toolPolicy !== undefined ? { toolPolicy } : {}),
    toolIds: [...option.toolIds],
    ...(option.dependencySkillApprovals ? { dependencySkillApprovals: [...option.dependencySkillApprovals] } : {}),
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
    env: { ...prepared.launch.env, [BFLOW_LAUNCH_ID_ENV]: prepared.launch.launchId, BFLOW_ENVIRONMENT_ID: prepared.environment.environmentId },
    launchId: prepared.launch.launchId,
    launchFingerprint: prepared.launch.launchFingerprint
    , ...(prepared.environment.roleProfile ? { roleProfile: prepared.environment.roleProfile, features: [ROLE_PROFILE_FEATURE],
      ...(prepared.launch.promptSource ? { promptSource: prepared.launch.promptSource } : {}) } : {})
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
  readonly processScopes?: DeveloperProcessScopes;
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

interface PinnedRoleInstructions {
  launchId: string;
  manifest: SkillManifest;
  instructionText: string;
  references: readonly { name: string; description: string; entrypoint: string; digest: string }[];
}

/** Verify current pinned skill authority even for implementation-only capability requests. No readiness/model probes. */
export async function verifyDispatchPinnedSkills(
  session: (Pick<HostPlatformSession, 'readPinnedInstructions' | 'launchIdOf'> & Partial<Pick<HostPlatformSession, 'bindingLaunchId'>>) | undefined,
  platform: Pick<AgenticHostPlatformOptions, 'roles'> | undefined,
  binding: PaneBinding
): Promise<void> {
  const selections = platform?.roles.find(option => option.role === binding.role)?.skillSelections ?? [];
  if (!selections.length && !binding.roleProfile) return;
  try {
    if (!session) throw Error('Platform skill verifier is unavailable');
    const metadataLaunch = binding.metadata?.launchId;
    const launchId = binding.roleProfile ? session.bindingLaunchId?.(binding) : binding.role === 'developer' ? metadataLaunch : session.launchIdOf(binding.role);
    if (typeof launchId !== 'string' || !launchId || typeof metadataLaunch === 'string' && metadataLaunch !== launchId)
      throw Error('Current skill launch identity is unavailable');
    // This calls SkillManager.verify, including each dependency binding's current scoped receipt and expiry.
    const pinned = await session.readPinnedInstructions(binding.role, undefined, 0, 1, launchId);
    if (!pinned || pinned.launchId !== launchId || !pinned.manifestDigest || selections.length > 0 && !pinned.instructionText.trim())
      throw Error('Current pinned skill manifest is unavailable');
  } catch {
    throw new RoleCapabilityPreflightError('Current pinned skill approval or integrity is unavailable for dispatch');
  }
}

/** One daemon's platform session: generation counter, launch ids for activation, and the Developer launch port. */
export class HostPlatformSession {
  private readonly profiledLaunches = new Map<string, PreparedRoleLaunch>();
  private readonly profileToolRequirements = new Map<string, { generation: number; requirement: RolePlatformRequirement }>();
  /** Host-mediated tools share the exact allocation and narrowed grants prepared for this native context. */
  toolActionScope(binding: PaneBinding): { launchId: string | undefined; taskId: string | undefined; grants: readonly ResolvedToolGrant[] } {
    const launchId = this.bindingLaunchId(binding);
    if (!binding.roleProfile) {
      const taskId = binding.role === "developer" ? [...this.developerLaunches].find(([, id]) => id === launchId)?.[0] : undefined;
      return { launchId, taskId, grants: (this.options.platform.toolGrants ?? []).filter(grant => grant.role === binding.role) };
    }
    const allocation = launchId ? this.profileToolRequirements.get(launchId) : undefined;
    const prepared = allocation?.requirement;
    if (allocation?.generation !== this.identity?.generation || !prepared?.roleProfile || !prepared.taskId || this.developerLaunches.get(prepared.taskId) !== launchId)
      throw new Error("Pinned profile tool allocation is unavailable");
    assertProfileSnapshotCurrent(prepared.roleProfile, this.options.platform.roleProfiles);
    const template = this.options.platform.roles.find(option => option.role === binding.role);
    if (!template) throw new Error("Pinned profile tool template is unavailable");
    const current = resolveRoleProfile(prepared.roleProfile, requirementFor(template, this.options.hostCapabilities, prepared.cwd,
      prepared.taskId, this.options.platform.toolGrants, this.options.platform.toolPolicy));
    if (canonicalReceiptJson(current.toolGrants ?? []) !== canonicalReceiptJson(prepared.toolGrants ?? []) ||
        current.toolPolicy?.digest !== prepared.toolPolicy?.digest)
      throw new Error("Pinned profile tool grants changed; reconcile the launch before further tool actions");
    return { launchId, taskId: prepared.taskId, grants: structuredClone(prepared.toolGrants ?? []) };
  }
  private readonly executorRoots = new Map<string, ExecutorLineage>();
  bindingLaunchId(binding: PaneBinding): string | undefined {
    if (!binding.roleProfile) return binding.role === "developer" ? typeof binding.metadata?.launchId === "string" ? binding.metadata.launchId : undefined : this.launchIdOf(binding.role);
    const launchId = binding.metadata?.launchId;
    const launch = typeof launchId === "string" ? this.profiledLaunches.get(launchId) : undefined;
    if (!launch || launch.role !== binding.role || !sameRoleProfilePin(launch.environment.roleProfile, binding.roleProfile)) throw new Error("Pinned profile launch identity is unavailable");
    return launchId as string;
  }
  preflightProfile(snapshot: ResolvedRoleProfileSnapshot, role: AgentRole, requiredCapabilities: readonly string[]): void {
    assertProfileSnapshotCurrent(snapshot, this.options.platform.roleProfiles);
    const template = this.options.platform.roles.find(option => option.role === role);
    if (!template) throw new Error("Profile base role has no configured platform template");
    const effective = resolveRoleProfile(snapshot, requirementFor(template, this.options.hostCapabilities, this.options.repositoryPath, undefined,
      this.options.platform.toolGrants, this.options.platform.toolPolicy));
    if (requiredCapabilities.some(capability => !effective.capabilityIds.includes(capability))) throw new Error("Profile capability scope cannot satisfy the assignment");
  }
  async attestProfileExecutor(binding: PaneBinding, purpose: ExecutorLineage["purpose"], assignmentId: string): Promise<ExecutorLineage> {
    const launchId = this.bindingLaunchId(binding), launch = launchId ? this.profiledLaunches.get(launchId) : undefined;
    if (!launch || !binding.session || !binding.roleProfile) throw new Error("Profile lineage requires its live host-prepared native context");
    const health = await this.options.service.verifyActivated({ launchId: launchId!, paneId: binding.paneId, nativeSession: binding.session,
      observation: { paneId: binding.paneId, agentName: binding.agentId, transportState: binding.transportState, interactiveReady: true, nativeSession: binding.session } });
    if (!health.ok) throw new Error("Profile native context has no authenticated activated readiness");
    const nativeKey = JSON.stringify(binding.session);
    let lineage = this.executorRoots.get(nativeKey);
    if (lineage && lineage.launchId !== launchId) throw new Error("Profile fresh launch reused a prior native executor context; reconciliation required");
    lineage ??= ExecutorLineageSchema.parse({ schemaVersion: 3, executorId: `executor-${launchId}`, launchId, nativeSessionId: binding.session.value,
      bindingId: binding.bindingId, freshContext: true, purpose, assignmentIds: [] });
    lineage = ExecutorLineageSchema.parse({ ...lineage, assignmentIds: [...new Set([...lineage.assignmentIds, assignmentId])] });
    this.executorRoots.set(nativeKey, lineage);
    return lineage;
  }
  private identity: PlatformSessionIdentity | undefined;
  private report: PlatformPreflightReport | undefined;
  private preparedStartup: HostPlatformLaunchResult | undefined;
  private readonly launches = new Map<AgentRole, { launchId: string; provider: AgentProviderId }>();
  /** Native Agy homes are keyed by launch id and exposed only while the matching launch is active. */
  private readonly nativeAgyHomes = new Map<string, { role: AgentRole; provider: AgentProviderId; home: string }>();
  private readonly roleInstructions = new Map<AgentRole, PinnedRoleInstructions>();
  private readonly developerInstructions = new Map<string, PinnedRoleInstructions>();
  private readonly developerLaunches = new Map<string, string>();
  /** Active Developer launches by launch id: the reachability the launch must prove, or null without Gateway registrations. */
  private readonly developerGates = new Map<string, ReachabilityExpectation | null>();
  private gatewayCheck: NonNullable<HostPlatformStatus["gateway"]> | undefined;
  private restartRecovery: { readonly recoveredAt: string; readonly releasedLaunchIds: readonly string[] } | undefined;

  constructor(private readonly options: HostPlatformSessionOptions, private readonly skillManager?: SkillManager,
    private readonly skillStore?: FileSkillStore) {}

  get currentGeneration(): number | undefined { return this.identity?.generation; }

  /**
   * Preflights every non-Developer role and launches the ready set only when all required roles are ready.
   * Publishes the launch-keyed probe plan of every launch with Gateway registrations.
   */
  async prepare(options?: OperationOptions): Promise<HostPlatformLaunchResult> {
    this.preparedStartup = undefined;
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
    .map(option => requirementFor(option, this.options.hostCapabilities, this.options.repositoryPath, undefined,
      this.options.platform.toolGrants, this.options.platform.toolPolicy));
    const result = await this.options.service.prepareSession(identity, requirements, options);
    if (!result.ok) throw new Error(`Platform readiness could not be prepared: ${describeFailure(result.error)}`);
    this.report = result.value.report;
    this.launches.clear();
    this.roleInstructions.clear();
    const reachability = new Map<AgentRole, ReachabilityExpectation>();
    try {
      for (const prepared of result.value.launches) {
        this.launches.set(prepared.role, { launchId: prepared.launch.launchId, provider: prepared.provider });
        this.rememberNativeAgyHome(prepared);
        if (prepared.skills?.manifest && prepared.skills?.rendered) this.roleInstructions.set(prepared.role, { launchId: prepared.launch.launchId,
          manifest: prepared.skills.manifest, instructionText: prepared.skills.rendered.instructionText,
          references: prepared.skills.rendered.references.map(reference => ({ ...reference })) });
        const expectation = await publishLaunchProbe(this.options.probeDirectory, prepared);
        if (expectation !== undefined) reachability.set(prepared.role, expectation);
      }
    } catch (error) {
      // A launch whose plan cannot be published must not stay prepared: release everything from this generation.
      for (const prepared of result.value.launches) {
        await this.options.service.releaseLaunch(prepared.launch.launchId).catch(() => undefined);
        await this.removeLaunchArtifacts(prepared.launch.launchId).catch(() => undefined);
        this.nativeAgyHomes.delete(prepared.launch.launchId);
      }
      this.launches.clear();
      await this.persistLaunches();
      throw error;
    }
    await this.persistLaunches();
    const prepared: HostPlatformLaunchResult = {
      report: result.value.report,
      launches: new Map(result.value.launches.map(prepared => [prepared.role, prepared])),
      reachability
    };
    if (prepared.report.ready) this.preparedStartup = prepared;
    return prepared;
  }

  /** Resume only this daemon's successful pending preparation; never reconstruct secrets after restart. */
  async resumePreparation(options?: OperationOptions): Promise<HostPlatformLaunchResult | undefined> {
    if (!this.preparedStartup) return undefined;
    if (!this.options.service.revalidatePreparedLaunch)
      throw new Error("Prepared startup cannot be revalidated; stop and reconcile before retrying");
    const launches = new Map<AgentRole, PreparedRoleLaunch>();
    for (const [role, prepared] of this.preparedStartup.launches) {
      const result = await this.options.service.revalidatePreparedLaunch(prepared.launch.launchId, options);
      if (!result.ok) throw new Error(`Prepared startup could not be resumed: ${describeFailure(result.error)}. Run bflow down --yes before a fresh startup.`);
      launches.set(role, result.value);
    }
    const report = { ...this.preparedStartup.report, checkedAt: new Date().toISOString(),
      roles: this.preparedStartup.report.roles.map(role => ({ ...role,
        ...(launches.has(role.role) ? { checks: launches.get(role.role)!.preflight.checks } : {}) })) };
    this.report = report;
    this.preparedStartup = { ...this.preparedStartup, report, launches };
    return this.preparedStartup;
  }

  /** Exact pinned, provider-neutral skills for the current prepared launch; callers receive no storage paths or mutable bundle handles. */
  async readPinnedInstructions(role: AgentRole, skillId?: string, offset = 0, limit = 8 * 1024, expectedLaunchId?: string): Promise<{ launchId: string; manifestDigest: string; instructionText: string;
    references: readonly { name: string; description: string; entrypoint: string; digest: string }[];
    skill?: { skillId: string; version: string; digest: string; offset: number; bytes: number; content: string; truncated: boolean; nextOffset?: number } } | undefined> {
    const value = role === "developer" || expectedLaunchId !== undefined && this.profiledLaunches.has(expectedLaunchId)
      ? expectedLaunchId === undefined ? undefined : this.developerInstructions.get(expectedLaunchId)
      : this.roleInstructions.get(role);
    const active = role === "developer" || expectedLaunchId !== undefined && this.profiledLaunches.has(expectedLaunchId)
      ? expectedLaunchId !== undefined && [...this.developerLaunches.values()].includes(expectedLaunchId)
      : value?.launchId === this.launches.get(role)?.launchId;
    if (!value || !active || (expectedLaunchId !== undefined && value.launchId !== expectedLaunchId) || !this.skillManager || !this.skillStore) return undefined;
    const manifest = await this.skillManager.verify(value.manifest);
    const common = { launchId: value.launchId, manifestDigest: manifest.digest, instructionText: value.instructionText,
      references: structuredClone(value.references) };
    if (skillId === undefined) return common;
    if (!Number.isInteger(offset) || offset < 0 || offset > 1024 * 1024 || !Number.isInteger(limit) || limit < 1 || limit > 16 * 1024)
      throw new Error("Pinned skill read offset/limit is invalid");
    const definition = manifest.skills.find(item => item.skillId === skillId);
    if (!definition) throw new Error("Skill is not selected by this role's verified manifest");
    const files = await this.skillStore.getBundle(definition.digest), content = files["SKILL.md"];
    if (typeof content !== "string") throw new Error(`Pinned skill ${definition.skillId} has no SKILL.md`);
    // Offsets and limits are UTF-8 bytes. A page starts and ends on character boundaries, so every page is valid text and
    // concatenating pages from nextOffset reproduces the file exactly. A start offset inside a character moves forward.
    const bytes = Buffer.from(content, "utf8");
    const isContinuation = (index: number) => (bytes[index]! & 0xc0) === 0x80;
    let start = Math.min(offset, bytes.byteLength);
    while (start < bytes.byteLength && isContinuation(start)) start++;
    let end = Math.min(start + limit, bytes.byteLength);
    while (end < bytes.byteLength && end > start && isContinuation(end)) end--;
    // A limit smaller than one character still makes progress by returning that whole character.
    if (end === start && start < bytes.byteLength) { end = start + 1; while (end < bytes.byteLength && isContinuation(end)) end++; }
    const truncated = end < bytes.byteLength;
    return { ...common, skill: { skillId, version: definition.version, digest: definition.digest, offset: start,
      bytes: end - start, content: bytes.subarray(start, end).toString("utf8"), truncated,
      ...(truncated ? { nextOffset: end } : {}) } };
  }

  /** Requires an activated, ready verdict for every required role before startup is accepted. */
  async verifyActivation(
    panes: readonly { readonly role: AgentRole; readonly paneId: string }[],
    observe: (paneId: string) => Promise<HostAgentObservation>
  ): Promise<void> {
    // Snapshot every required binding before probes. Missing launch material must not
    // leave a partially checked set of roles running while startup is rejected.
    const checks = this.options.platform.roles.filter(option => option.required && option.role !== "developer").map(option => {
      const pane = panes.find(candidate => candidate.role === option.role);
      if (!pane) throw new Error(`Required platform role ${option.role} has no pane in the SessionManifest`);
      const launch = this.launches.get(option.role);
      if (launch === undefined) {
        throw new Error(`Required platform role ${option.role} has no prepared launch in this host process; run bflow up again`);
      }
      return { option, pane, launch };
    });

    let next = 0;
    const failures = new Map<number, unknown>();
    await Promise.all(Array.from({ length: Math.min(MAX_ACTIVATION_CONCURRENCY, checks.length) }, async () => {
      while (failures.size === 0 && next < checks.length) {
        const index = next++;
        try { await this.verifyRoleActivation(checks[index]!.pane, observe); }
        catch (error) { failures.set(index, error); }
      }
    }));
    // Never race cleanup with an in-flight health probe or journal append. Report
    // failures in configured role order, regardless of their completion order.
    for (let index = 0; index < checks.length; index++) {
      if (failures.has(index)) throw failures.get(index);
    }
  }

  /** Preparatory health only; never activates the workspace or substitutes for the complete manifest barrier. */
  async verifyRoleActivation(
    pane: { readonly role: AgentRole; readonly paneId: string },
    observe: (paneId: string) => Promise<HostAgentObservation>,
    options?: OperationOptions
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const option = this.options.platform.roles.find(candidate => candidate.role === pane.role && candidate.required && candidate.role !== "developer");
    if (!option || !this.report?.ready) throw new Error("Role activation requires a ready required-role preflight");
    const launch = this.launches.get(pane.role);
    if (!launch) throw new Error(`Required platform role ${pane.role} has no prepared launch in this host process; run bflow up again`);
    const observation = liveObservation(pane.paneId, await observe(pane.paneId));
    if (observation.nativeSession === undefined) {
      if (PENDING_STATES.includes(observation.transportState))
        throw new Error(`[bflow:native-startup-pending] ${pane.role} pane ${pane.paneId} has no native session yet`);
      throw new Error(`Required platform role ${pane.role} has no native session (transport ${observation.transportState})`);
    }
    const native = observation.nativeSession;
    options?.signal?.throwIfAborted();
    const result = await this.options.service.verifyActivated({ launchId: launch.launchId, paneId: pane.paneId,
      nativeSession: native, observation }, options);
    if (!result.ok) {
      if (PENDING_STATES.includes(observation.transportState))
        throw new Error(`[bflow:native-startup-pending] ${pane.role} pane ${pane.paneId} is ${observation.transportState}; ${describeFailure(result.error)}`);
      throw new Error(`Required platform role ${pane.role} is not activated-ready: ${describeFailure(result.error)}`);
    }
  }

  /** Launch id of the prepared permanent role launch of this generation; undefined when none is prepared. */
  launchIdOf(role: AgentRole): string | undefined {
    return this.launches.get(role)?.launchId;
  }

  hasActiveDeveloperLaunch(launchId: string | undefined): boolean {
    return typeof launchId === "string" && ([...this.developerLaunches.values()].includes(launchId) || this.profiledLaunches.has(launchId));
  }

  /** Native transcript access is bound to a live Agy launch and its exact prepared config home. */
  nativeAgyLaunch(role: AgentRole, launchId: string): { home: string; launchId: string } | undefined {
    const binding = this.nativeAgyHomes.get(launchId);
    if (!binding || binding.role !== role || binding.provider !== "agy") return undefined;
    const active = role === "developer" || this.profiledLaunches.has(launchId)
      ? [...this.developerLaunches.values()].includes(launchId)
      : this.launches.get(role)?.launchId === launchId && this.launches.get(role)?.provider === "agy";
    return active ? { home: binding.home, launchId } : undefined;
  }

  /**
   * Dynamic Developer launch for one task worktree. Blocked launches throw; no pane is created on failure.
   * Publishes the launch's own probe plan (keyed by launch id, so concurrent Developers never share a file).
   */
  async allocateDeveloper(taskId: string, worktreePath: string, runId?: string, roleProfile?: ResolvedRoleProfileSnapshot): Promise<DeveloperLaunchMaterial> {
    if (this.identity === undefined) throw new Error("Platform has no prepared generation; run bflow up again");
    const processScopes = await this.availableProcessScopes();
    if (processScopes && !runId) throw new Error("A supervised Developer launch requires its exact run identity");
    const template = this.options.platform.roles.find(option => option.role === "developer");
    if (template === undefined) throw new Error("Platform configuration has no developer template for dynamic Developer launches");
    // Re-allocation for the same task (e.g. after restart) must not orphan the previous launch and its Gateway registration.
    await this.releaseDeveloper(taskId);
    const baseRequirement = requirementFor(template, this.options.hostCapabilities, worktreePath, taskId, this.options.platform.toolGrants, this.options.platform.toolPolicy);
    const requirement = roleProfile ? resolveRoleProfile(roleProfile, baseRequirement) : baseRequirement;
    const generation = this.identity.generation;
    const result = await this.options.service.prepareDeveloper(this.identity, requirement);
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
    let material = launchMaterial(result.value);
    if (processScopes) {
      try { material = await processScopes.prepare({ runId: runId!, taskId, material, executable: result.value.profile.executable,
        executableDigest: result.value.profile.executableDigest, configFiles: result.value.profile.configFiles }); }
      catch (error) {
        await this.options.service.releaseLaunch(launchId);
        await removeLaunchProbe(this.options.probeDirectory, launchId);
        throw error;
      }
    }
    this.developerLaunches.set(taskId, launchId);
    if (roleProfile) {
      this.profiledLaunches.set(launchId, result.value);
      this.profileToolRequirements.set(launchId, { generation, requirement: structuredClone(requirement) });
    }
    this.developerGates.set(launchId, expectation ?? null);
    if (result.value.skills?.manifest && result.value.skills?.rendered) this.developerInstructions.set(launchId, {
      launchId, manifest: result.value.skills.manifest, instructionText: result.value.skills.rendered.instructionText,
      references: result.value.skills.rendered.references.map(reference => ({ ...reference })) });
    this.rememberNativeAgyHome(result.value);
    return material;
  }
  async allocateProfileSpecialist(request: { taskId: string; runId: string; role: import("@bflow/contracts").SpecialistRole; roleProfile: ResolvedRoleProfileSnapshot }): Promise<DeveloperLaunchMaterial> {
    if (!this.identity || request.role === "developer") throw new Error("Profiled specialist launch requires a prepared specialist generation");
    this.preflightProfile(request.roleProfile, request.role, ["repository.read"]);
    const template = this.options.platform.roles.find(option => option.role === request.role)!;
    const requirement = resolveRoleProfile(request.roleProfile, requirementFor(template, this.options.hostCapabilities, this.options.repositoryPath,
      request.taskId, this.options.platform.toolGrants, this.options.platform.toolPolicy));
    const generation = this.identity.generation;
    const result = await this.options.service.prepareSession(this.identity, [requirement]);
    if (!result.ok || !result.value.report.ready || result.value.launches.length !== 1) throw new Error("Profiled specialist launch readiness is blocked");
    const prepared = result.value.launches[0]!;
    try {
      const expectation = await publishLaunchProbe(this.options.probeDirectory, prepared);
      this.profiledLaunches.set(prepared.launch.launchId, prepared);
      this.profileToolRequirements.set(prepared.launch.launchId, { generation, requirement: structuredClone(requirement) });
      this.developerLaunches.set(request.taskId, prepared.launch.launchId);
      this.developerGates.set(prepared.launch.launchId, expectation ?? null);
      this.rememberNativeAgyHome(prepared);
      this.developerInstructions.set(prepared.launch.launchId, { launchId: prepared.launch.launchId, manifest: prepared.skills.manifest,
        instructionText: prepared.skills.rendered.instructionText, references: prepared.skills.rendered.references.map(reference => ({ ...reference })) });
      return launchMaterial(prepared);
    } catch (error) { await this.options.service.releaseLaunch(prepared.launch.launchId); throw error; }
  }
  /**
   * The supervision backend when this host can run it. A host without it (no Bubblewrap user namespaces, AppArmor
   * restriction, no Python pidfd) launches Developers unsupervised exactly as before: their bindings carry no process
   * scope, dispatch is not gated on one, and cancellation keeps the transport-interrupt path. Never a silent proof.
   */
  /** Reason the last Developer launch ran without process supervision; undefined when supervised or never attempted. */
  private processSupervisionUnavailable: string | undefined;
  private async availableProcessScopes(): Promise<DeveloperProcessScopes | undefined> {
    const scopes = this.options.processScopes;
    if (!scopes) return undefined;
    try { await scopes.assertReady(); this.processSupervisionUnavailable = undefined; return scopes; }
    catch (error) { this.processSupervisionUnavailable = String(error); return undefined; }
  }
  async assertDeveloperProcessReady(binding: PaneBinding): Promise<void> { await this.options.processScopes?.assertBindingReady(binding); }
  async pinDeveloperDispatch(request: AgentRequest, binding: PaneBinding): Promise<void> { await this.options.processScopes?.pinDispatch(request, binding); }
  async bindDeveloperExecution(handle: AgentExecutionHandle, binding: PaneBinding): Promise<void> { await this.options.processScopes?.bindExecution(handle, binding); }
  async stopDeveloperExecution(handle: AgentExecutionHandle, binding: PaneBinding) { return this.options.processScopes?.stop(handle, binding); }
  async stopUnboundDeveloper(binding: PaneBinding) { return this.options.processScopes?.stopUnbound(binding); }
  async authorizeStoppedRetainedRelease(binding: PaneBinding): Promise<boolean> { return await this.options.processScopes?.hasStoppedProof(binding) ?? false; }

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
    await this.options.processScopes?.sealLaunch(taskId, launchId);
    const released = await this.options.service.releaseLaunch(launchId);
    if (!released.ok) throw new Error(`Developer ${taskId} launch release failed: ${describeFailure(released.error)}`);
    await this.removeLaunchArtifacts(launchId);
    this.developerLaunches.delete(taskId);
    this.profiledLaunches.delete(launchId);
    this.profileToolRequirements.delete(launchId);
    this.developerGates.delete(launchId);
    this.developerInstructions.delete(launchId);
    this.nativeAgyHomes.delete(launchId);
  }

  /** Revokes this session's Gateway registrations. Shared services are never stopped here. */
  async shutdown(): Promise<void> {
    this.preparedStartup = undefined;
    const result = await this.options.service.shutdown();
    if (!result.ok) throw new Error(`Platform shutdown failed: ${describeFailure(result.error)}`);
    for (const launch of this.launches.values()) await this.removeLaunchArtifacts(launch.launchId);
    for (const launchId of this.developerLaunches.values()) await this.removeLaunchArtifacts(launchId);
    this.launches.clear();
    this.developerLaunches.clear();
    this.profiledLaunches.clear();
    this.profileToolRequirements.clear();
    this.developerGates.clear();
    this.developerInstructions.clear();
    this.nativeAgyHomes.clear();
    await this.persistLaunches();
  }

  /**
   * Reconciles Gateway registrations with the Gateway control (F5). A lost registration degrades its launch:
   * running providers keep a revoked token, so only a relaunch (`bflow up`) recovers. Uncertain checks change nothing.
   */
  async verifyGateway(): Promise<NonNullable<HostPlatformStatus["gateway"]>> {
    const result = await this.options.service.verifyGateway();
    const checkedAt = new Date().toISOString();
    this.gatewayCheck = result.ok
      ? { checkedAt: result.value.checkedAt, healthy: result.value.healthy, uncertain: result.value.uncertain,
          lost: result.value.lost.map(item => ({ registrationId: item.registrationId, role: item.role, ...(item.taskId !== undefined ? { taskId: item.taskId } : {}) })) }
      : { checkedAt, healthy: false, uncertain: true, lost: [], error: describeFailure(result.error) };
    return this.gatewayCheck;
  }

  async invokeTool(role: AgentRole, taskId: string | undefined, toolId: string, serviceId: string, operation: string,
    trigger: ToolTrigger, input: JsonValue, callId: string, reconcile = false, options?: OperationOptions, transactionId?: string, binding?: PaneBinding): Promise<OperationResult<MCPToolCallResult>> {
    const identity = this.identity, policy = this.options.platform.toolPolicy;
    let scope: ReturnType<HostPlatformSession["toolActionScope"]> | undefined;
    try {
      if (binding) {
        if (binding.role !== role) throw new Error("Tool binding governance role mismatch");
        scope = this.toolActionScope(binding);
        if (scope.taskId !== taskId) throw new Error("Tool binding allocation mismatch");
      }
    } catch (error) { return { ok: false, error: { code: "validation", retryable: false, message: String(error) } }; }
    const grants = scope?.grants ?? this.options.platform.toolGrants;
    if (!identity || !policy || !grants) return { ok: false, error: { code: "validation", retryable: false, message: "Tool actions require an active explicit repository policy and resolved grants" } };
    const requirement = policy.requirements.find(item => item.toolId === toolId && item.roles.includes(role) && item.kind !== "cli_only" &&
      (item.serviceId === undefined || item.serviceId === serviceId) && item.operations.includes(operation) && item.triggers.includes(trigger));
    const grant = grants.find(item => item.role === role && item.toolId === toolId && item.kind !== "cli_only" &&
      item.policyDigest === policy.digest && item.serviceId === serviceId && item.operations.includes(operation) &&
      item.scope.kind === "session" && item.scope.machineId === identity.machineId && item.scope.sessionId === identity.sessionId && item.scope.repositoryId === identity.repositoryId &&
      item.scope.workspaceRoot === identity.workspaceRoot);
    if (!requirement || !grant || !this.options.platform.roles.some(item => item.role === role))
      return { ok: false, error: { code: "validation", retryable: false, message: "Tool action is outside the explicit repository policy or active session grant" } };
    if (grant.requiredness !== requirement.requiredness || grant.kind !== requirement.kind ||
        grant.operations.some(item => !requirement.operations.includes(item)) || grant.triggers.some(item => !requirement.triggers.includes(item)) ||
        grant.memoryScope?.wing !== requirement.memoryScope?.wing || grant.memoryScope?.repositoryId !== requirement.memoryScope?.repositoryId ||
        grant.memoryScope?.access !== requirement.memoryScope?.access || !grant.triggers.includes(trigger))
      return { ok: false, error: { code: "validation", retryable: false, message: "Resolved tool grant exceeds repository policy" } };
    const launchId = scope?.launchId ?? (taskId !== undefined ? this.developerLaunches.get(taskId) : this.launches.get(role)?.launchId);
    if (!binding && launchId && this.profiledLaunches.has(launchId))
      return { ok: false, error: { code: "validation", retryable: false, message: "Profile tool action requires its authenticated native binding" } };
    if (launchId === undefined) return { ok: false, error: { code: "conflict", retryable: true, message: "Tool action has no active role launch" } };
    const launch = this.options.service.status().launches.find(item => item.launchId === launchId);
    if (!launch || launch.state !== "activated")
      return { ok: false, error: { code: "conflict", retryable: true, message: "Tool action needs the matching activated role launch" } };
    const health = this.options.service.assertFresh(launchId);
    if (!health.ok) return health;
    const resourceKey = this.options.platform.exclusiveMcpResources?.[serviceId];
    if (trigger === "browser_inspection" && (!transactionId || !resourceKey))
      return { ok: false, error: { code: "validation", retryable: false, message: "Browser action needs an authenticated assignment and trusted machine resource key" } };
    const boundedOptions: GatewayToolOperationOptions = {
      ...(trigger === "browser_inspection" ? { browserTransaction: { id: transactionId!, resourceKey: resourceKey! } } : {}),
      timeoutMs: Math.min(options?.timeoutMs ?? 5_000, 5_000),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.deadline ? { deadline: options.deadline } : {})
    };
    const gateway = await this.options.service.verifyGateway(boundedOptions);
    if (!gateway.ok) return gateway;
    if (!gateway.value.healthy || gateway.value.uncertain)
      return { ok: false, error: { code: "conflict", retryable: true, message: "Tool action Gateway registrations are lost or uncertain" } };
    // Gateway inspection awaited external work; recheck the same pinned allocation/grants immediately before its tool side effect.
    if (binding?.roleProfile) {
      try {
        const current = this.toolActionScope(binding);
        if (current.launchId !== launchId || current.taskId !== taskId) throw new Error("Profile tool allocation changed during Gateway inspection");
      } catch (error) { return { ok: false, error: { code: "validation", retryable: false, message: String(error) } }; }
    }
    if (reconcile) return this.options.service.reconcileToolCall(identity, role, taskId, serviceId, operation, input, callId, boundedOptions);
    return this.options.service.invokeTool(identity, role, taskId, serviceId, operation, input, callId, boundedOptions);
  }

  async finishToolTransaction(role: AgentRole, transactionId: string): Promise<OperationResult<void>> {
    if (!this.identity || !this.options.service.finishToolTransaction)
      return { ok: false, error: { code: "validation", retryable: false, message: "Browser transaction cleanup requires an active resource lease service" } };
    return this.options.service.finishToolTransaction(this.identity, role, transactionId);
  }

  async reconcileToolCall(role: AgentRole, taskId: string | undefined, serviceId: string, operation: string,
    input: JsonValue, callId: string): Promise<OperationResult<MCPToolCallResult>> {
    const identity = this.identity;
    if (!identity) return { ok: false, error: { code: "validation", retryable: false, message: "No active platform generation" } };
    return this.options.service.reconcileToolCall(identity, role, taskId, serviceId, operation, input, callId);
  }

  /**
   * Called once when a daemon starts. A previous daemon's launches cannot be re-proven (their profiles and tokens were
   * in memory), so they are retired: Gateway registrations revoked, open intents journaled released, probe plans and
   * reachability records removed. Activation then requires a fresh `bflow up`, which says so explicitly.
   */
  async recoverPreviousDaemon(): Promise<void> {
    let previous: z.infer<typeof LaunchesFileSchema> = {};
    try { previous = LaunchesFileSchema.parse(JSON.parse(await readFile(this.options.launchesFile, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let generation = 0;
    try { generation = GenerationSchema.parse(JSON.parse(await readFile(this.options.generationFile, "utf8"))).generation; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (generation === 0) return; // never prepared: nothing to retire
    const identity: PlatformSessionIdentity = {
      machineId: this.options.platform.machineId, repositoryId: this.options.platform.repositoryId,
      workspaceRoot: this.options.repositoryPath, sessionId: this.options.sessionId, generation,
      stateDirectory: this.options.stateDirectory
    };
    const result = await this.options.service.reconcileAfterRestart(identity);
    if (!result.ok) throw new Error(`Previous host daemon's platform launches could not be retired: ${describeFailure(result.error)}`);
    const launchIds = new Set([...Object.values(previous).map(launch => launch.launchId), ...result.value.releasedLaunchIds]);
    for (const launchId of launchIds) await this.removeLaunchArtifacts(launchId);
    if (Object.keys(previous).length) await writePrivateAtomic(this.options.launchesFile, JSON.stringify({}));
    this.restartRecovery = { recoveredAt: new Date().toISOString(), releasedLaunchIds: [...launchIds] };
  }

  /** Launches that must not receive new prompts: permanent roles by name, Developers by launch id. */
  degradation(): { readonly roles: readonly string[]; readonly launchIds: readonly string[] } {
    const degraded = this.options.service.status().launches.filter(launch => launch.state === "degraded");
    return {
      roles: degraded.filter(launch => launch.taskId === undefined).map(launch => launch.role),
      launchIds: degraded.filter(launch => launch.taskId !== undefined).map(launch => launch.launchId)
    };
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
      gatewayDiagnostic: this.options.gatewayDiagnostic ?? null,
      ...(this.gatewayCheck !== undefined ? { gateway: this.gatewayCheck } : {}),
      ...(this.restartRecovery !== undefined
        ? { restartRecovery: { recoveredAt: this.restartRecovery.recoveredAt, releasedLaunchIds: [...this.restartRecovery.releasedLaunchIds] } } : {}),
      ...(this.processSupervisionUnavailable !== undefined ? { developerProcessSupervisionUnavailable: this.processSupervisionUnavailable } : {})
    };
  }

  private async releasePermanentLaunches(): Promise<void> {
    for (const launch of this.launches.values()) {
      const released = await this.options.service.releaseLaunch(launch.launchId);
      if (!released.ok) throw new Error(`Previous platform launch could not be released: ${describeFailure(released.error)}`);
      await this.removeLaunchArtifacts(launch.launchId);
      this.nativeAgyHomes.delete(launch.launchId);
    }
    this.launches.clear();
  }

  /** Removes a released launch's probe plan and any reachability record. Revocation has already happened. */
  private async removeLaunchArtifacts(launchId: string): Promise<void> {
    await removeLaunchProbe(this.options.probeDirectory, launchId);
    await removeLaunchReachability(this.options.reachabilityDirectory, launchId);
  }

  private rememberNativeAgyHome(prepared: PreparedRoleLaunch): void {
    if (prepared.provider !== "agy") return;
    const expectedSuffix = join(".gemini", "config", "mcp_config.json");
    const matches = prepared.profile.configFiles.filter(file => file.path.endsWith(`/${expectedSuffix}`));
    if (matches.length !== 1) return;
    const configPath = matches[0]!.path;
    if (!configPath.startsWith("/") || resolve(configPath) !== configPath) return;
    const home = dirname(dirname(dirname(configPath)));
    if (home === "/" || join(home, expectedSuffix) !== configPath) return;
    this.nativeAgyHomes.set(prepared.launch.launchId, { role: prepared.role, provider: prepared.provider, home });
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
  readonly beforeSideEffect?: () => Promise<void>;
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

/** Machine trust settings are provider defaults, so permanent and dynamic Developer Codex instances share them. */
export function createHostProviderFactoryOptions(platform: AgenticHostPlatformOptions,
  hookEnvironment: Readonly<Record<string, string | undefined>> = process.env) {
  const codexHookEnvironment = createManagedCodexHookEnvironment({ ...hookEnvironment,
    PATH: hookEnvironment.PATH ?? process.env.PATH }, platform.codexProcessHomeDirectory ?? hookEnvironment.HOME ?? process.env.HOME ?? homedir());
  return {
    codexLaunchEnvironment: {
      ...codexHookEnvironment,
      ...(platform.codexHomeDirectory !== undefined ? { CODEX_HOME: platform.codexHomeDirectory } : {})
    },
    perProvider: {
      codex: {
        ...(platform.codexHomeDirectory !== undefined ? { codexHomeDirectory: platform.codexHomeDirectory } : {}),
        ...(platform.codexHookApprovalPath !== undefined ? { codexHookApprovalPath: platform.codexHookApprovalPath } : {}),
        codexHookEnvironment
      }
    }
  };
}

function createCoalescedAgyRunner(baseRunner: ProviderCommandRunner): ProviderCommandRunner {
  const inFlight = new Map<string, Promise<ProviderCommandOutcome>>();
  const cached = new Map<string, { readonly expiresAt: number; readonly outcome: ProviderCommandOutcome }>();
  return {
    async run(invocation) {
      const arg0 = invocation.args[0];
      const isReadOnlyProbe =
        invocation.args.length === 1 && (arg0 === "--version" || arg0 === "--help" || arg0 === "models");
      if (!isReadOnlyProbe) {
        return baseRunner.run(invocation);
      }
      const rawHome = invocation.env?.["HOME"] ?? "";
      const agyHomeParent = dirname(rawHome);
      const roleCategoryDir = dirname(dirname(agyHomeParent));
      const homeScope =
        basename(agyHomeParent) === "agy-home"
          ? (basename(roleCategoryDir) === "roles" || basename(roleCategoryDir) === "developers"
              ? dirname(roleCategoryDir)
              : agyHomeParent)
          : rawHome;
      const cacheKey = JSON.stringify([
        invocation.executable,
        invocation.args,
        homeScope,
        invocation.env?.["AI_ISOLATOR_REAL_HOME"] ?? ""
      ]);
      const now = Date.now();
      const hit = cached.get(cacheKey);
      if (hit !== undefined && hit.expiresAt > now) {
        return hit.outcome;
      }
      const existing = inFlight.get(cacheKey);
      if (existing !== undefined) {
        return existing;
      }
      const task = (async () => {
        let effectiveInvocation = invocation;
        if (arg0 === "models" && basename(agyHomeParent) === "agy-home") {
          const probeHome = join(homeScope, ".auth-probe");
          const probeCacheDir = join(probeHome, ".gemini", "antigravity-cli", "cache");
          const probeConfigDir = join(probeHome, ".config");
          try {
            await mkdir(probeCacheDir, { recursive: true, mode: 0o700 });
            await mkdir(probeConfigDir, { recursive: true, mode: 0o700 });
            const sourceOnboarding = join(rawHome, ".gemini", "antigravity-cli", "cache", "onboarding.json");
            const targetOnboarding = join(probeCacheDir, "onboarding.json");
            await copyFile(sourceOnboarding, targetOnboarding).catch(() => {});
            await chmod(targetOnboarding, 0o600).catch(() => {});
            const sourceKeychains = join(rawHome, "Library", "Keychains");
            const linkTarget = await readlink(sourceKeychains).catch(() => undefined);
            if (linkTarget !== undefined) {
              const probeLibrary = join(probeHome, "Library");
              await mkdir(probeLibrary, { recursive: true, mode: 0o700 });
              const probeKeychains = join(probeLibrary, "Keychains");
              await rm(probeKeychains, { force: true }).catch(() => {});
              await symlink(linkTarget, probeKeychains, "dir").catch(() => {});
            }
            effectiveInvocation = {
              ...invocation,
              env: {
                ...invocation.env,
                HOME: probeHome,
                XDG_CONFIG_HOME: probeConfigDir
              }
            };
          } catch {
            effectiveInvocation = invocation;
          }
        }
        const outcome = await baseRunner.run(effectiveInvocation);
        if (outcome.exitCode === 0 && outcome.started && outcome.failure === undefined) {
          cached.set(cacheKey, { expiresAt: Date.now() + 120_000, outcome });
        }
        return outcome;
      })().finally(() => {
        inFlight.delete(cacheKey);
      });
      inFlight.set(cacheKey, task);
      return task;
    }
  };
}

/** Applies trusted platform paths last so role and repository data cannot redirect Codex hook approvals. */
export function createHostProviderAdapterFactory(
  platform: AgenticHostPlatformOptions,
  options: ProviderAdapterFactoryOptions = {},
  hookEnvironment: Readonly<Record<string, string | undefined>> = process.env
): ProviderAdapterFactory {
  const trustedCodexOptions = createHostProviderFactoryOptions(platform, hookEnvironment).perProvider.codex;
  const agyRunner = createCoalescedAgyRunner(
    options.perProvider?.agy?.runner ?? options.runner ?? createProviderProcessRunner()
  );
  return createProviderAdapterFactory({
    ...options,
    perProvider: {
      ...options.perProvider,
      claude: { ...options.perProvider?.claude, executionProbe: "disabled" },
      agy: { ...options.perProvider?.agy, runner: agyRunner, executionProbe: "disabled" },
      codex: { ...options.perProvider?.codex, ...trustedCodexOptions, executionProbe: "disabled" }
    }
  });
}

/** Opens the real composition: skills store, Gateway control (if located), host-held signer and provider adapters. */
export async function createHostPlatformSession(options: CreateHostPlatformSessionOptions): Promise<HostPlatformSession> {
  const platform = AgenticHostPlatformOptionsSchema.parse(options.platform);
  const skillManager = new SkillManager({
    store: new FileSkillStore(platform.skillsStoreRoot),
    supportedCommands: skillSupportedCommands(platform),
    approvedBuiltinDigests: [...platform.approvedBuiltinSkillDigests],
    authorize: async request => platform.skillApprovalPath !== undefined && request.scope.kind === "session" &&
      request.scope.repositoryId === platform.repositoryId && request.scope.sessionId === options.sessionId &&
      readSkillApproval(platform.skillApprovalPath, { approvalReceiptId: request.approvalReceiptId,
        skillId: request.definition.skillId, version: request.definition.version, digest: request.definition.digest,
        dependencies: request.definition.dependencies, role: request.role, provider: request.provider,
        repositoryId: platform.repositoryId, sessionId: options.sessionId })
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

  const stateDirectory = resolve(options.directory, "../../platform", options.sessionId);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const service = createPlatformReadinessService({
    stateDirectory,
    ...(options.beforeSideEffect ? { beforeSideEffect: options.beforeSideEffect } : {}),
    skillManager,
    ...(gatewayControl !== undefined ? { gatewayControl } : {}),
    ...(gatewayEndpoint !== undefined ? { gatewayEndpoint } : {}),
    signer: new Ed25519LaunchAttestationSigner({ issuerId: options.issuerId, privateKeyPem: options.privateKeyPem, publicKeyPem: options.publicKeyPem }),
    ...(platform.isolatorStateRoot !== undefined ? { isolatorStateRoot: platform.isolatorStateRoot } : {}),
    providerFactory: createHostProviderAdapterFactory(platform, {}, process.env),
    ...createHostProviderFactoryOptions(platform, process.env),
    rolePrompt: options.rolePrompt,
    nativeSessionHookCommand: role => options.nativeSessionHookCommand(role),
    hostLaunch: role => options.hostLaunch(role)
  });
  const session = new HostPlatformSession({
    ...(process.platform === "linux" ? { processScopes: new DeveloperProcessScopes({ directory: join(options.directory, "developer-process-scopes") }) } : {}),
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
  }, skillManager, new FileSkillStore(platform.skillsStoreRoot));
  await session.recoverPreviousDaemon();
  return session;
}

/** Writes `host.json` with updated startup authority while keeping socket, token and directory. Caller holds the boot lock. */
export async function rewritePersistedPlatform(
  path: string,
  platform: AgenticHostPlatformOptions | undefined,
  extras?: { readonly policy?: unknown; readonly impactIndex?: unknown }
): Promise<void> {
  const current = z.record(z.unknown()).parse(JSON.parse(await readFile(path, "utf8")));
  await writePrivateAtomic(
    path,
    JSON.stringify({
      ...current,
      platform,
      ...(extras && "policy" in extras ? { policy: extras.policy } : {}),
      ...(extras && "impactIndex" in extras ? { impactIndex: extras.impactIndex } : {})
    })
  );
}
