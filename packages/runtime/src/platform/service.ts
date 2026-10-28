import type { GatewayToolOperationOptions } from "./browser-resource-transactions.js";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AgentHealthCheckSchema, RepositoryToolPolicySchema, ResolvedToolGrantSchema, ROLE_PROFILE_FEATURE,
  canonicalReceiptJson,
  type AgentEnvironment,
  type AgentHealthCheck,
  type AgentHealthResult,
  type AgentLaunchAttestation,
  type AgentLaunchProfile,
  type AgentProviderId,
  type AgentRole,
  type ContractError,
  type MCPClientRegistration,
  type MCPServiceObservation,
  type OperationOptions,
  type OperationResult,
  type RoleProfilePin
} from "@bflow/contracts";
import { computeFileSha256, defaultRolePrompt, providerSessionEnvironment, resolveAndVerifyExecutable, type LiveReadinessObservation } from "@bflow/agent-providers";
import { appendRoleProfileInstructions, assertRoleProfilePin, loadRoleProfileSnapshot, persistRoleProfileSnapshot, resolveRoleProfile } from "./role-profiles.js";
import {
  preparePrivateCodexHome,
  type CodexInstructionHomeMode,
  type PreparedCodexHome
} from "./codex-home.js";
import { sha256Hex } from "./environment.js";
import { fail, failWith, ok } from "./errors.js";
import { IsolatorProfileResolver, type ResolvedIsolatorProfile } from "./isolator-profile.js";
import type {
  GatewayRegistrationPort,
  GatewayRegistrationVerification,
  HostLaunchExtras,
  LaunchAttestationSigner,
  LaunchJournalPort,
  LostGatewayRegistration,
  PlatformPreflightReport,
  PlatformReadinessService,
  PlatformSessionIdentity,
  PlatformStatusSnapshot,
  PreparedRoleLaunch,
  ProviderAdapterContext,
  ProviderReadinessPort,
  ResolvedRoleSkills,
  RoleEnvironmentResolverPort,
  RoleGatewayAccess,
  RolePlatformRequirement,
  RolePreflightSummary,
  SkillSessionPort
} from "./ports.js";
import { tokenEnvironmentName } from "./gateway-registrations.js";

export {
  preparePrivateCodexHome,
  type CodexInstructionHomeMode,
  type PreparedCodexHome
};

export interface DefaultPlatformReadinessServiceDeps {
  /** Host-owned input revalidation before preparation mutations and provider launch material. */
  readonly beforeSideEffect?: () => Promise<void>;
  readonly environments: RoleEnvironmentResolverPort;
  readonly skills: SkillSessionPort;
  readonly gateway?: GatewayRegistrationPort | undefined;
  readonly providers: ProviderReadinessPort;
  /** Same journal the providers record intents in; receives `released` so restart recovery never sees a dropped launch as pending. */
  readonly journal?: LaunchJournalPort | undefined;
  readonly signer: LaunchAttestationSigner;
  readonly codexLaunchEnvironment?: Readonly<Record<string, string>> | undefined;
  readonly isolatorStateRoot?: string | undefined;
  readonly rolePrompt?: ((role: AgentRole) => string | undefined) | undefined;
  readonly nativeSessionHookCommand?: ((role: AgentRole, taskId?: string) => string | undefined) | undefined;
  /** Trusted host MCP servers and hooks for a role launch (provider-neutral; adapters render them). */
  readonly hostLaunch?: ((role: AgentRole, taskId?: string) => HostLaunchExtras | undefined) | undefined;
  readonly now?: (() => Date) | undefined;
}

type LaunchState = PlatformStatusSnapshot["launches"][number]["state"];

/** Launch material is held only while the launch is live; it is dropped on release or shutdown. */
interface LaunchMaterial {
  readonly identity: PlatformSessionIdentity;
  readonly requirement: RolePlatformRequirement;
  readonly environment: AgentEnvironment;
  readonly context: ProviderAdapterContext;
  readonly isolatorProfile?: ResolvedIsolatorProfile;
  readonly profile: AgentLaunchProfile;
  readonly prepared: PreparedRoleLaunch;
  readonly gatewayTouched: boolean;
}

interface LaunchRecord {
  readonly roleProfile?: RoleProfilePin;
  readonly launchId: string;
  readonly role: AgentRole;
  readonly provider: AgentProviderId;
  readonly taskId?: string;
  state: LaunchState;
  healthValidUntil?: string;
  reason?: "gateway_registration_lost";
  material?: LaunchMaterial;
}

const GATEWAY_LOST_CODE = "gateway_registration_lost";

interface RoleAttemptBase {
  readonly identity: PlatformSessionIdentity;
  readonly requirement: RolePlatformRequirement;
  readonly isolatorProfile?: ResolvedIsolatorProfile;
  /** True once a Gateway register was attempted, so cleanup must revoke even after a failure. */
  readonly gatewayTouched: boolean;
}

interface RoleReady extends RoleAttemptBase {
  readonly ready: true;
  readonly summary: RolePreflightSummary;
  readonly environment: AgentEnvironment;
  readonly context: ProviderAdapterContext;
  readonly isolatorProfile?: ResolvedIsolatorProfile;
  readonly preflight: AgentHealthResult;
  readonly skills: ResolvedRoleSkills;
  readonly gateway: RoleGatewayAccess;
  readonly toolChecks: readonly AgentHealthCheck[];
}

interface RoleBlocked extends RoleAttemptBase {
  readonly ready: false;
  readonly summary: RolePreflightSummary;
  readonly error: ContractError;
}

type RoleAttempt = RoleReady | RoleBlocked;
type RoleEnvironmentReady = Omit<RoleReady, "preflight" | "summary">;

const NO_GATEWAY_ACCESS: RoleGatewayAccess = { registrations: [], observations: [], tokenEnvironment: {} };
const DECLARED_STATUSES: readonly RolePreflightSummary["status"][] = ["blocked", "unsupported", "error"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Maps a failure to a role status: an explicit `details.status` wins, otherwise corruption is an error and the rest blocks. */
function statusOf(error: ContractError): RolePreflightSummary["status"] {
  const declared = isRecord(error.details) ? error.details["status"] : undefined;
  if (typeof declared === "string" && DECLARED_STATUSES.includes(declared as RolePreflightSummary["status"])) {
    return declared as RolePreflightSummary["status"];
  }
  return error.code === "corruption" || error.code === "unsupported_version" ? "error" : "blocked";
}

function checksOf(error: ContractError): readonly AgentHealthCheck[] {
  const details = isRecord(error.details) ? error.details : undefined;
  const parsed = AgentHealthCheckSchema.array().safeParse(details?.["checks"]);
  return parsed.success ? parsed.data : [];
}

function summaryOf(
  requirement: RolePlatformRequirement,
  status: RolePreflightSummary["status"],
  checks: readonly AgentHealthCheck[],
  message?: string
): RolePreflightSummary {
  return {
    role: requirement.role,
    ...(requirement.roleProfile ? { roleProfile: requirement.roleProfile.pin } : {}),
    provider: requirement.provider,
    required: requirement.required,
    status,
    checks,
    ...(requirement.taskId !== undefined ? { taskId: requirement.taskId } : {}),
    ...(message !== undefined ? { message } : {})
  };
}

function degradedFailure(): OperationResult<never> {
  return fail("conflict", "launch Gateway registration was lost; relaunch the role", { code: GATEWAY_LOST_CODE });
}

function withMessage(summary: RolePreflightSummary, extra: string): RolePreflightSummary {
  return { ...summary, message: summary.message ? `${summary.message}; ${extra}` : extra };
}

function toolCheck(status: AgentHealthCheck["status"], code: string, message: string, check: AgentHealthCheck["check"] = "mcp"): AgentHealthCheck {
  return AgentHealthCheckSchema.parse({ check, status, code, message,
    ...(status !== "passed" ? { remediation: "Review repository tool policy and verified machine inventory, then run bflow up again." } : {}) });
}

async function checkToolPolicy(identity: PlatformSessionIdentity, requirement: RolePlatformRequirement): Promise<{
  readonly checks: readonly AgentHealthCheck[]; readonly error?: ContractError;
}> {
  const rawGrants = requirement.toolGrants ?? [];
  let policy: ReturnType<typeof RepositoryToolPolicySchema.parse> | undefined;
  try { policy = requirement.toolPolicy === undefined ? undefined : RepositoryToolPolicySchema.parse(requirement.toolPolicy); }
  catch { return { checks: [], error: { code: "validation", retryable: false, message: "Repository tool policy is malformed", details: { status: "blocked" } } }; }
  const grants = rawGrants.map(raw => ResolvedToolGrantSchema.safeParse(raw));
  if (grants.some(item => !item.success))
    return { checks: [], error: { code: "validation", retryable: false, message: "Resolved tool grant is malformed", details: { status: "blocked" } } };
  const resolved = grants.flatMap(item => item.success ? [item.data] : []);
  if (!policy && resolved.length)
    return { checks: [], error: { code: "validation", retryable: false, message: "Resolved tool grants require an explicit repository policy", details: { status: "blocked" } } };
  if (!policy) return { checks: [] };
  if (policy.scope.kind !== "repository" || policy.repositoryId !== identity.repositoryId || policy.scope.machineId !== identity.machineId ||
      policy.scope.workspaceRoot !== identity.workspaceRoot)
    return { checks: [], error: { code: "validation", retryable: false, message: "Repository tool policy does not match the active workspace", details: { status: "blocked" } } };
  const requirements = policy.requirements.filter(item => item.roles.includes(requirement.role));
  const checks: AgentHealthCheck[] = [];
  const denied = (message: string, code = "tool_grant_policy_mismatch", check: AgentHealthCheck["check"] = "mcp") => ({ checks, error: {
    code: "validation" as const, retryable: false as const, message,
    details: { status: "blocked" as const, checks: [{ check, status: "failed" as const, code, message }] }
  } });
  for (const grant of resolved) if (!requirements.some(item => item.toolId === grant.toolId && item.kind === grant.kind))
    return denied(`Tool grant ${grant.toolId} has no matching requirement for ${requirement.role}`);

  for (const expected of requirements) {
    const candidates = resolved.filter(item => item.toolId === expected.toolId && item.role === requirement.role && item.kind === expected.kind);
    if (candidates.length > 1) return denied(`Tool ${expected.toolId} has ambiguous resolved grants for ${requirement.role}`, "tool_grant_ambiguous");
    const grant = candidates[0];
    if (!grant) {
      if (expected.requiredness === "required") return denied(`Required tool grant ${expected.toolId} is unavailable for ${requirement.role}`,
        "required_tool_grant_missing", expected.kind === "cli_only" ? "binary" : "mcp");
      checks.push(toolCheck("unknown", "optional_tool_grant_missing", `Optional tool ${expected.toolId} is not granted for ${requirement.role}`,
        expected.kind === "cli_only" ? "binary" : "mcp"));
      continue;
    }
    const scopeMatches = grant.policyDigest === policy.digest && grant.requiredness === expected.requiredness &&
      grant.scope.kind === "session" && grant.scope.sessionId === identity.sessionId && grant.scope.machineId === identity.machineId &&
      grant.scope.repositoryId === identity.repositoryId && grant.scope.workspaceRoot === identity.workspaceRoot;
    const operationsWithinPolicy = grant.operations.every(operation => expected.operations.includes(operation));
    const operationsComplete = expected.requiredness === "optional" || expected.operations.every(operation => grant.operations.includes(operation));
    const serviceMatches = expected.kind === "cli_only"
      ? expected.serviceId === undefined && grant.serviceId === undefined
      : expected.serviceId === undefined ? grant.serviceId !== undefined : grant.serviceId === expected.serviceId;
    const exactAuthority = operationsWithinPolicy && operationsComplete &&
      grant.triggers.every(trigger => expected.triggers.includes(trigger)) &&
      (grant.capabilityIds ?? []).every(capability => expected.capabilityIds?.includes(capability)) &&
      (grant.cliCommandProfiles ?? []).every(profile => expected.cliCommandProfiles?.includes(profile)) &&
      serviceMatches &&
      grant.memoryScope?.wing === expected.memoryScope?.wing && grant.memoryScope?.repositoryId === expected.memoryScope?.repositoryId &&
      grant.memoryScope?.access === expected.memoryScope?.access;
    if (!scopeMatches || !exactAuthority) return denied(`Tool grant ${expected.toolId} does not match its policy/session scope`);
    if (expected.requiredness === "optional" && (expected.operations.some(operation => !grant.operations.includes(operation)) ||
        expected.triggers.some(trigger => !grant.triggers.includes(trigger)) ||
        (expected.cliCommandProfiles ?? []).some(profile => !grant.cliCommandProfiles?.includes(profile))))
      checks.push(toolCheck("unknown", "optional_tool_authority_limited", `Optional tool ${expected.toolId} has a narrower verified operation/profile grant`));
    if (grant.kind === "cli_only" && grant.cliIdentity) {
      try {
        const executable = await resolveAndVerifyExecutable(grant.cliIdentity.executablePath);
        if (executable.canonicalPath !== grant.cliIdentity.executablePath || executable.digest !== grant.cliIdentity.digest)
          throw new Error("executable identity drifted");
      } catch {
        if (expected.requiredness === "required") return denied(`Required CLI tool ${grant.toolId} executable is unavailable or changed`, "required_cli_identity_unavailable", "binary");
        checks.push(toolCheck("unknown", "optional_cli_identity_unavailable", `Optional CLI tool ${grant.toolId} executable is unavailable or changed`, "binary"));
      }
    }
  }
  return { checks };
}

function profileErrorForRole(requirement: RolePlatformRequirement, error: ContractError): ContractError {
  const profileName = requirement.profileName;
  const validName = profileName !== undefined && /^[A-Za-z0-9._-]+$/.test(profileName);
  const selectedName = validName ? profileName : "<invalid>";
  const remediation = validName
    ? `Run 'bflow iso ${requirement.provider} --name ${profileName}'.`
    : "Select a valid ai-isolator profile name.";
  return {
    ...error,
    message: `Role ${requirement.role}, provider ${requirement.provider}, profile ${selectedName}: ${error.message}. ${remediation}`,
    details: { ...(isRecord(error.details) ? error.details : {}), status: "blocked" }
  };
}

/**
 * Composes role environment, skills, Gateway registrations and provider readiness into
 * fail-closed launch material. Nothing is launched unless every required role is ready.
 */
export class DefaultPlatformReadinessService implements PlatformReadinessService {
  private readonly launches = new Map<string, LaunchRecord>();
  private readonly identities = new Map<string, PlatformSessionIdentity>();
  private generation: number | null = null;
  private readonly now: () => Date;
  private readonly isolatorProfiles: IsolatorProfileResolver;

  constructor(private readonly deps: DefaultPlatformReadinessServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.isolatorProfiles = new IsolatorProfileResolver({
      ...(deps.isolatorStateRoot !== undefined ? { stateRoot: deps.isolatorStateRoot } : {})
    });
  }

  private async revalidateProfile(
    requirement: RolePlatformRequirement,
    expected: ResolvedIsolatorProfile | undefined,
    options?: OperationOptions
  ): Promise<OperationResult<void>> {
    if (expected === undefined) return ok(undefined);
    const current = await this.isolatorProfiles.resolve(requirement.provider, requirement.profileName!, options);
    if (!current.ok) return failWith(profileErrorForRole(requirement, current.error));
    if (canonicalReceiptJson(current.value.identity) !== canonicalReceiptJson(expected.identity)) {
      return failWith(profileErrorForRole(requirement, {
        code: "conflict",
        retryable: true,
        message: "profile identity changed after provider preflight"
      }));
    }
    return ok(undefined);
  }

  async prepareSession(
    identity: PlatformSessionIdentity,
    requirements: readonly RolePlatformRequirement[],
    options?: OperationOptions
  ): Promise<OperationResult<{ report: PlatformPreflightReport; launches: readonly PreparedRoleLaunch[] }>> {
    this.track(identity);
    const interrupted = (): ContractError | undefined => options?.signal?.aborted
      ? { code: "cancelled", retryable: false, message: "Platform preparation interrupted; no roles may launch" }
      : options?.deadline !== undefined && Date.parse(options.deadline) <= this.now().getTime()
        ? { code: "timeout", retryable: true, retrySafety: "observation_only", message: "Platform preparation deadline expired; no roles may launch" } : undefined;
    // State/skill/Gateway preparation remains ordered; only independent provider
    // observations overlap. Launch intents still wait for every preflight verdict.
    const environments: (RoleEnvironmentReady | RoleBlocked)[] = [];
    for (const requirement of requirements) {
      const error = interrupted();
      if (error) break;
      environments.push(await this.prepareRoleEnvironment(identity, requirement, options));
    }
    const attempts: RoleAttempt[] = new Array(environments.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(3, environments.length) }, async () => {
      while (next < environments.length) {
        const index = next++;
        const environment = environments[index]!;
        if (!environment.ready) { attempts[index] = environment; continue; }
        const interruption = interrupted();
        if (interruption) { attempts[index] = this.blockedRole(environment, interruption); continue; }
        try { attempts[index] = await this.checkPreparedRole(environment, options); }
        catch { attempts[index] = this.blockedRole(environment, {
          code: "validation", retryable: false, message: "Provider preflight failed before returning a health verdict"
        }); }
      }
    }));

    const summaries = attempts.map(attempt => attempt.summary);
    const launched = new Map<number, PreparedRoleLaunch>();
    const requiredBlocked = attempts.length !== requirements.length || attempts.some(attempt => !attempt.ready && attempt.requirement.required);
    let requiredLaunchFailed = false;

    if (!requiredBlocked) {
      for (const [index, attempt] of attempts.entries()) {
        if (interrupted()) { requiredLaunchFailed = true; break; }
        if (!attempt.ready) continue;
        const prepared = await this.launchRole(attempt, options);
        if (prepared.ok) {
          launched.set(index, prepared.value);
          continue;
        }
        summaries[index] = summaryOf(attempt.requirement, "blocked", attempt.summary.checks, prepared.error.message);
        if (attempt.requirement.required) requiredLaunchFailed = true;
      }
    }

    // All-or-nothing: any required failure discards every launch made in this call.
    const ready = !requiredBlocked && !requiredLaunchFailed && interrupted() === undefined;
    if (!ready) {
      for (const prepared of launched.values()) await this.dropLaunch(prepared.launch.launchId, true);
      launched.clear();
    }

    for (const [index, attempt] of attempts.entries()) {
      if (!attempt.gatewayTouched || launched.has(index)) continue;
      // Cleanup has its own bounded calls; an expired preparation must not suppress revocation.
      const revoked = await this.revokeRoleGateway(attempt.identity, attempt.requirement);
      if (!revoked.ok) {
        summaries[index] = withMessage(summaries[index] ?? attempt.summary,
          `Gateway cleanup failed: ${revoked.error.message}`);
      }
    }

    const interruption = interrupted();
    if (interruption) return failWith(interruption);
    return ok({
      report: {
        ready,
        generation: identity.generation,
        roles: summaries,
        checkedAt: this.now().toISOString()
      },
      launches: ready ? [...launched.values()] : []
    });
  }

  async revalidatePreparedLaunch(launchId: string, options?: OperationOptions): Promise<OperationResult<PreparedRoleLaunch>> {
    await this.deps.beforeSideEffect?.();
    if (options?.signal?.aborted) return fail("cancelled", "Prepared launch revalidation interrupted");
    if (options?.deadline !== undefined && Date.parse(options.deadline) <= this.now().getTime())
      return failWith({ code: "timeout", retryable: true, retrySafety: "observation_only", message: "Prepared launch revalidation deadline expired" });
    const record = this.launches.get(launchId), material = record?.material;
    if (!record || !material || ["failed", "released", "degraded"].includes(record.state))
      return fail("conflict", "Prepared launch is missing, failed or released; stop and reconcile startup");
    if (Date.parse(material.profile.expiresAt) <= this.now().getTime())
      return fail("conflict", "Prepared launch profile expired; stop and reconcile startup");
    try {
      const executable = await resolveAndVerifyExecutable(material.profile.executable);
      if (executable.canonicalPath !== material.profile.executable || executable.digest !== material.profile.executableDigest)
        return fail("conflict", "Prepared launch executable changed");
      for (const file of material.profile.configFiles) {
        const info = await lstat(file.path);
        if ((info.mode & 0o077) !== 0 || await computeFileSha256(file.path) !== file.digest)
          return fail("conflict", "Prepared launch configuration changed or has unsafe permissions");
      }
    } catch (error) {
      return fail("conflict", `Prepared launch files cannot be revalidated: ${error instanceof Error ? error.message : String(error)}`);
    }
    const profile = await this.revalidateProfile(material.requirement, material.isolatorProfile, options);
    if (!profile.ok) return profile;
    const snapshot = await this.validateRoleProfileMaterial(material);
    if (!snapshot.ok) return snapshot;
    const skills = await this.deps.skills.load(material.identity, material.requirement.role, material.requirement.taskId, material.requirement.roleProfile?.pin, material.requirement.assignmentId);
    if (!skills.ok) return skills;
    if (!skills.value || canonicalReceiptJson(skills.value.manifest) !== canonicalReceiptJson(material.context.skillManifest))
      return fail("conflict", "Prepared launch pinned skills changed or are missing");
    const gateway = await this.verifyGateway(options);
    if (!gateway.ok) return gateway;
    if (!gateway.value.healthy || gateway.value.uncertain)
      return fail("conflict", "Prepared launch Gateway registration is lost or uncertain");
    const health = await this.deps.providers.preflight(material.environment, material.context, options);
    if (!health.ok) return health;
    return ok({ ...material.prepared, preflight: health.value });
  }

  async verifyActivated(
    input: {
      readonly launchId: string;
      readonly paneId: string;
      readonly nativeSession: AgentLaunchAttestation["nativeSession"];
      readonly observation?: LiveReadinessObservation;
    },
    options?: OperationOptions
  ): Promise<OperationResult<AgentHealthResult>> {
    const record = this.launches.get(input.launchId);
    if (!record) return fail("not_found", "launch is not known to this readiness service");
    if (record.state === "degraded") return degradedFailure();
    const material = record.material;
    if (!material) return fail("conflict", "launch was released");
    await this.deps.beforeSideEffect?.();
    const snapshot = await this.validateRoleProfileMaterial(material);
    if (!snapshot.ok) return snapshot;
    const profileCheck = await this.revalidateProfile(material.requirement, material.isolatorProfile, options);
    if (!profileCheck.ok) {
      record.state = "failed";
      return profileCheck;
    }

    const result = await this.deps.providers.verifyActivated({
      profile: material.profile,
      context: {
        ...material.context,
        ...(input.observation ? { liveObservation: input.observation } : {})
      },
      paneId: input.paneId,
      nativeSession: input.nativeSession,
      signer: this.deps.signer
    }, options);
    if (!result.ok) {
      record.state = "failed";
      return result;
    }
    record.state = "activated";
    record.healthValidUntil = result.value.validUntil;
    return result;
  }

  assertFresh(launchId: string, now?: Date): OperationResult<AgentHealthResult> {
    const record = this.launches.get(launchId);
    if (!record) return fail("not_found", "launch is not known to this readiness service");
    if (record.state === "degraded") return degradedFailure();
    const material = record.material;
    if (!material) return fail("conflict", "launch was released");
    return this.deps.providers.assertFresh(material.environment.environmentId,
      material.environment.configFingerprint, now ?? this.now());
  }

  async prepareDeveloper(
    identity: PlatformSessionIdentity,
    requirement: RolePlatformRequirement,
    options?: OperationOptions
  ): Promise<OperationResult<PreparedRoleLaunch>> {
    if (requirement.role !== "developer") return fail("validation", "prepareDeveloper requires the developer role");
    if (requirement.taskId === undefined || requirement.taskId.length === 0) {
      return fail("validation", "developer launch requires a taskId");
    }
    this.track(identity);

    const attempt = await this.preflightRole(identity, requirement, options);
    if (!attempt.ready) {
      if (attempt.gatewayTouched) await this.revokeRoleGateway(identity, requirement, options);
      return failWith(attempt.error);
    }
    const launched = await this.launchRole(attempt, options);
    if (!launched.ok) {
      if (attempt.gatewayTouched) await this.revokeRoleGateway(identity, requirement, options);
      return launched;
    }
    return ok(launched.value);
  }

  async releaseLaunch(launchId: string, options?: OperationOptions): Promise<OperationResult<void>> {
    const record = this.launches.get(launchId);
    if (!record || !record.material) return ok(undefined);
    const material = record.material;
    if (material.gatewayTouched) {
      const revoked = await this.revokeRoleGateway(material.identity, material.requirement, options);
      if (!revoked.ok) return revoked;
    }
    try { await this.dropLaunch(launchId); }
    catch (error) { return fail("corruption", `launch release could not be journaled: ${error instanceof Error ? error.message : String(error)}`); }
    return ok(undefined);
  }

  /**
   * Verifies the Gateway registrations of every session seen by this service. A lost registration degrades the
   * launch that owns it (same session, role and task). Degraded launches keep their material so release still revokes.
   */
  async verifyGateway(options?: OperationOptions): Promise<OperationResult<GatewayRegistrationVerification>> {
    const checkedAt = this.now().toISOString();
    const gateway = this.deps.gateway;
    if (!gateway) return ok({ checkedAt, healthy: true, lost: [], uncertain: false });

    const lost: LostGatewayRegistration[] = [];
    let uncertain = false;
    let failure: ContractError | undefined;
    for (const identity of this.identities.values()) {
      let verified = await gateway.verifyRegistrations(identity, options);
      if (!verified.ok) {
        uncertain = true;
        failure ??= verified.error;
        continue;
      }
      if (!verified.value.uncertain && verified.value.lost.length > 0) {
        let refreshed = false;
        for (const record of this.launches.values()) {
          if (record.material?.identity.stateDirectory !== identity.stateDirectory) continue;
          if (!verified.value.lost.some(item => item.role === record.role && item.taskId === record.taskId)) continue;
          if (await this.refreshMediatedLaunchGateway(record, options)) refreshed = true;
        }
        if (refreshed) {
          verified = await gateway.verifyRegistrations(identity, options);
          if (!verified.ok) {
            uncertain = true;
            failure ??= verified.error;
            continue;
          }
        }
      }
      uncertain ||= verified.value.uncertain;
      for (const registration of verified.value.lost) {
        lost.push(registration);
        this.degradeOwners(identity, registration);
      }
    }
    if (failure) return failWith(failure);
    return ok({ checkedAt, healthy: lost.length === 0 && !uncertain, lost, uncertain });
  }

  async invokeTool(identity: PlatformSessionIdentity, role: AgentRole, taskId: string | undefined, serviceId: string,
    operation: string, input: import("@bflow/contracts").JsonValue, callId: string, options?: GatewayToolOperationOptions) {
    if (!this.deps.gateway) return fail("transport_unavailable", "Gateway control endpoint unavailable");
    const current = this.identities.get(identity.stateDirectory);
    if (!current || current.sessionId !== identity.sessionId || current.generation !== identity.generation || current.repositoryId !== identity.repositoryId)
      return fail("validation", "Gateway action session is not active in this host");
    return this.deps.gateway.invokeTool(identity, role, taskId, serviceId, operation, input, callId, options);
  }

  async finishToolTransaction(identity: PlatformSessionIdentity, role: AgentRole, transactionId: string) {
    if (!this.deps.gateway?.finishToolTransaction) return fail("validation", "Gateway resource transactions are unavailable");
    return this.deps.gateway.finishToolTransaction(identity, role, transactionId);
  }

  async reconcileToolCall(identity: PlatformSessionIdentity, role: AgentRole, taskId: string | undefined, serviceId: string,
    operation: string, input: import("@bflow/contracts").JsonValue, callId: string, options?: GatewayToolOperationOptions) {
    if (!this.deps.gateway) return fail("transport_unavailable", "Gateway control endpoint unavailable");
    const current = this.identities.get(identity.stateDirectory);
    if (!current || current.sessionId !== identity.sessionId || current.generation !== identity.generation || current.repositoryId !== identity.repositoryId)
      return fail("validation", "Gateway action session is not active in this host");
    return this.deps.gateway.reconcileToolCall(identity, role, taskId, serviceId, operation, input, callId, options);
  }

  /**
   * After a host daemon restart nothing from the previous daemon is in memory: revoke every Gateway registration of
   * this session (all generations) and journal `released` for every launch intent left open, so neither a registration
   * nor a pending intent outlives its daemon. Shared services are never stopped.
   */
  async reconcileAfterRestart(identity: PlatformSessionIdentity,
    options?: OperationOptions): Promise<OperationResult<{ readonly releasedLaunchIds: readonly string[] }>> {
    if (this.deps.gateway) {
      const revoked = await this.deps.gateway.revokeSession(identity, options);
      if (!revoked.ok) return failWith(revoked.error);
    }
    const releasedLaunchIds: string[] = [];
    if (this.deps.journal) {
      let entries;
      try { entries = await this.deps.journal.entries(); }
      catch (error) { return fail("corruption", `launch journal could not be read: ${error instanceof Error ? error.message : String(error)}`); }
      const open = new Set<string>();
      for (const entry of entries) {
        if (entry.kind === "intent") open.add(entry.launchId);
        else if (entry.kind === "released") open.delete(entry.launchId);
      }
      for (const launchId of open) {
        if (this.launches.get(launchId)?.material !== undefined) continue; // live in this daemon
        try {
          await this.deps.journal.append({ kind: "released", launchId, recordedAt: (this.deps.now?.() ?? new Date()).toISOString() });
        } catch (error) {
          return fail("corruption", `stale launch ${launchId} could not be journaled released: ${error instanceof Error ? error.message : String(error)}`);
        }
        releasedLaunchIds.push(launchId);
      }
    }
    return ok({ releasedLaunchIds });
  }

  async shutdown(options?: OperationOptions): Promise<OperationResult<void>> {
    const gateway = this.deps.gateway;
    const failures: ContractError[] = [];
    for (const identity of this.identities.values()) {
      if (gateway) {
        const revoked = await gateway.revokeSession(identity, options);
        if (!revoked.ok) {
          failures.push(revoked.error);
          continue;
        }
      }
      for (const record of this.launches.values()) {
        if (record.material?.identity.stateDirectory === identity.stateDirectory) await this.dropLaunch(record.launchId, true);
      }
    }
    if (failures.length === 0) return ok(undefined);
    const [first] = failures;
    if (first === undefined) return ok(undefined);
    return failWith({
      ...first,
      message: `session revocation failed for ${failures.length} session(s): ${failures.map(error => error.message).join("; ")}`
    });
  }

  status(): PlatformStatusSnapshot {
    return {
      generation: this.generation,
      launches: [...this.launches.values()].map(record => ({
        launchId: record.launchId,
        role: record.role,
        ...(record.roleProfile ? { roleProfile: record.roleProfile } : {}),
        provider: record.provider,
        state: record.state,
        ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
        ...(record.healthValidUntil !== undefined ? { healthValidUntil: record.healthValidUntil } : {}),
        ...(record.reason !== undefined ? { reason: record.reason } : {})
      }))
    };
  }

  /** Marks the live launch(es) that own a lost registration as degraded; released launches are not touched. */
  private degradeOwners(identity: PlatformSessionIdentity, lost: LostGatewayRegistration): void {
    for (const record of this.launches.values()) {
      if (record.material === undefined || record.state === "released") continue;
      if (record.material.identity.stateDirectory !== identity.stateDirectory) continue;
      if (record.role !== lost.role || record.taskId !== lost.taskId) continue;
      record.state = "degraded";
      record.reason = GATEWAY_LOST_CODE;
    }
  }

  /**
   * Mediated launches (`requirement.toolGrants !== undefined`) never pass Gateway bearer tokens into the provider
   * process environment; all tool calls are brokered by the Runtime host. When a mediated registration expires,
   * the host can renew its Gateway registration in-place without relaunching the role pane.
   */
  private async refreshMediatedLaunchGateway(record: LaunchRecord, options?: OperationOptions): Promise<boolean> {
    const gateway = this.deps.gateway;
    const material = record.material;
    if (!gateway || !material || record.state === "released" || record.state === "failed") return false;
    const { identity, requirement, environment } = material;
    const grants = requirement.toolGrants;
    if (grants === undefined || requirement.mcpServiceIds.length === 0) return false;
    const groups = new Map<string, typeof grants[number][]>();
    for (const grant of grants.filter(item => item.kind !== "cli_only")) {
      if (grant.serviceId === undefined || !requirement.mcpServiceIds.includes(grant.serviceId)) return false;
      const bucket = groups.get(grant.serviceId) ?? [];
      bucket.push(grant);
      groups.set(grant.serviceId, bucket);
    }
    if (groups.size === 0) return false;
    const configDigest = sha256Hex(canonicalReceiptJson(requirement));
    for (const [serviceId, serviceGrants] of groups) {
      const operations = [...new Set(serviceGrants.flatMap(grant => grant.operations))].sort();
      const granted = await gateway.ensureForRole(identity, {
        role: requirement.role,
        provider: requirement.provider,
        ...(requirement.taskId !== undefined ? { taskId: requirement.taskId } : {}),
        environmentId: environment.environmentId,
        serviceIds: [serviceId],
        allowedTools: operations,
        toolGrants: serviceGrants,
        configDigest
      }, options);
      if (!granted.ok) return false;
    }
    if (record.state === "degraded" && record.reason === GATEWAY_LOST_CODE) {
      record.state = record.healthValidUntil !== undefined ? "activated" : "intent";
      delete record.reason;
    }
    return true;
  }

  private track(identity: PlatformSessionIdentity): void {
    this.identities.set(identity.stateDirectory, identity);
    this.generation = identity.generation;
  }

  /** Runs environment, skills, Gateway, environment resolution and preflight for one role. No launch side effects. */
  private async preflightRole(
    identity: PlatformSessionIdentity,
    requirement: RolePlatformRequirement,
    options?: OperationOptions
  ): Promise<RoleAttempt> {
    const prepared = await this.prepareRoleEnvironment(identity, requirement, options);
    return prepared.ready ? this.checkPreparedRole(prepared, options) : prepared;
  }

  private async prepareRoleEnvironment(
    identity: PlatformSessionIdentity,
    requirement: RolePlatformRequirement,
    options?: OperationOptions
  ): Promise<RoleEnvironmentReady | RoleBlocked> {
    let gatewayTouched = false;
    const blocked = (error: ContractError): RoleBlocked => ({
      ready: false,
      identity,
      requirement,
      gatewayTouched,
      error,
      summary: summaryOf(requirement, statusOf(error), checksOf(error), error.message)
    });

    try { if (requirement.roleProfile) requirement = resolveRoleProfile(requirement.roleProfile, structuredClone(requirement)); }
    catch { return blocked({ code: "validation", retryable: false, message: "Role profile policy is incompatible or unsupported", details: { status: "unsupported" } }); }
    const environmentId = this.deps.environments.environmentId(identity, requirement);
    if (requirement.roleProfile) {
      await this.deps.beforeSideEffect?.();
      try { await persistRoleProfileSnapshot(identity, requirement.roleProfile); }
      catch { return blocked({ code: "conflict", retryable: true, message: "Role profile snapshot conflicts or is corrupted" }); }
    }

    const toolPolicy = await checkToolPolicy(identity, requirement);
    if (toolPolicy.error) return blocked(toolPolicy.error);
    const toolChecks = [...toolPolicy.checks];

    let isolatorProfile: ResolvedIsolatorProfile | undefined;
    if (requirement.profileName !== undefined) {
      const resolvedProfile = await this.isolatorProfiles.resolve(requirement.provider, requirement.profileName, options);
      if (!resolvedProfile.ok) return blocked(profileErrorForRole(requirement, resolvedProfile.error));
      isolatorProfile = resolvedProfile.value;
    }

    await this.deps.beforeSideEffect?.();
    const skills = await this.deps.skills.resolveForRole(identity, requirement, environmentId);
    if (!skills.ok) return blocked(skills.error);

    await this.deps.beforeSideEffect?.();
    let gateway: RoleGatewayAccess = NO_GATEWAY_ACCESS;
    if (requirement.mcpServiceIds.length > 0) {
      if (!this.deps.gateway) {
        return blocked({
          code: "transport_unavailable",
          retryable: true,
          message: "Gateway control endpoint unavailable",
          details: { status: "blocked" }
        });
      }
      gatewayTouched = true;
      const configDigest = sha256Hex(canonicalReceiptJson(requirement));
      const grants = requirement.toolGrants;
      if (grants !== undefined) {
        const groups = new Map<string, typeof grants[number][]>();
        for (const grant of grants.filter(item => item.kind !== "cli_only")) {
          if (grant.role !== requirement.role || grant.scope.kind !== "session" ||
              grant.scope.sessionId !== identity.sessionId || grant.scope.repositoryId !== identity.repositoryId ||
              grant.scope.workspaceRoot !== identity.workspaceRoot || grant.serviceId === undefined ||
              !requirement.mcpServiceIds.includes(grant.serviceId))
            return blocked({ code: "validation", retryable: false, message: "Resolved tool grant does not match the active role/session/service" });
          const bucket = groups.get(grant.serviceId) ?? [];
          bucket.push(grant); groups.set(grant.serviceId, bucket);
        }
        if ([...groups.keys()].sort().join("\0") !== [...new Set(requirement.mcpServiceIds)].sort().join("\0"))
          return blocked({ code: "validation", retryable: false, message: "Every required Gateway service must have an exact resolved tool grant" });
        const registrations: MCPClientRegistration[] = [];
        const observations: MCPServiceObservation[] = [];
        const tokenEnvironment: Record<string, string> = {};
        for (const [serviceId, serviceGrants] of groups) {
          const operations = [...new Set(serviceGrants.flatMap(grant => grant.operations))].sort();
          const granted = await this.deps.gateway.ensureForRole(identity, {
            role: requirement.role,
            provider: requirement.provider,
            ...(requirement.taskId !== undefined ? { taskId: requirement.taskId } : {}),
            environmentId,
            serviceIds: [serviceId],
            allowedTools: operations,
            toolGrants: serviceGrants,
            configDigest
          }, options);
          if (!granted.ok) {
            const uncertain = granted.error.code === "timeout" || granted.error.code === "unknown_delivery" || granted.error.code === "cancelled" ||
              ("retrySafety" in granted.error && granted.error.retrySafety === "observation_only");
            const cleanupUnconfirmed = isRecord(granted.error.details) &&
              granted.error.details["diagnosticCode"] === "gateway_readiness_cleanup_failed";
            if (!uncertain && !cleanupUnconfirmed && serviceGrants.every(grant => grant.requiredness === "optional")) {
              toolChecks.push(toolCheck("unknown", "optional_gateway_service_unavailable", `Optional Gateway service ${serviceId} is unavailable: ${granted.error.message}`));
              continue;
            }
            return blocked(granted.error);
          }
          registrations.push(...granted.value.registrations);
          observations.push(...granted.value.observations);
          Object.assign(tokenEnvironment, granted.value.tokenEnvironment);
        }
        gateway = { registrations, observations, tokenEnvironment };
      } else {
        // Legacy host config has no resolved grants. Preserve its existing readiness behavior; no mediated
        // action broker accepts it because Runtime action ingress requires an explicit resolved grant.
        // A multi-service legacy registration would cross-product every operation across every service, so it fails closed.
        if (requirement.mcpServiceIds.length > 1)
          return blocked({ code: "validation", retryable: false, message: "Multiple Gateway services require exact resolved per-service grants" });
        const granted = await this.deps.gateway.ensureForRole(identity, {
          role: requirement.role,
          provider: requirement.provider,
          ...(requirement.taskId !== undefined ? { taskId: requirement.taskId } : {}),
          environmentId,
          serviceIds: [...requirement.mcpServiceIds],
          allowedTools: [...(requirement.mcpOperations ?? requirement.toolIds)],
          configDigest
        }, options);
        if (!granted.ok) return blocked(granted.error);
        gateway = granted.value;
      }
    }

    const readyServiceIds = [...new Set(gateway.registrations.flatMap(registration => registration.serviceIds))];
    const mediated = requirement.toolGrants !== undefined;
    const effectiveRequirement = requirement.toolGrants === undefined ? requirement : {
      ...requirement,
      // Mediated tools are reachable only through Runtime's broker. Provider-side MCP
      // visibility would let the process bypass grant checks and the usage ledger.
      mcpServiceIds: mediated ? [] : requirement.mcpServiceIds.filter(serviceId => readyServiceIds.includes(serviceId)),
      mcpOperations: requirement.toolGrants.filter(grant => grant.kind !== "cli_only" && readyServiceIds.includes(grant.serviceId!)).flatMap(grant => grant.operations)
    };
    const baseEnvironmentRequirement = isolatorProfile === undefined
      ? effectiveRequirement
      : { ...effectiveRequirement, isolatorProfileIdentity: isolatorProfile.identity };
    const preliminaryEnvironment = this.deps.environments.resolve(identity, baseEnvironmentRequirement, {
      skillManifestDigest: skills.value.manifest.digest
    });
    if (!preliminaryEnvironment.ok) return blocked(preliminaryEnvironment.error);

    // The role state directory must exist before preflight; it is private and holds no launch side effect yet.
    try {
      await mkdir(preliminaryEnvironment.value.stateDirectory, { recursive: true, mode: 0o700 });
    } catch (error) {
      return blocked({
        code: "validation",
        retryable: false,
        message: `role state directory could not be created: ${error instanceof Error ? error.message : String(error)}`
      });
    }

    const codexLaunchEnvironment = requirement.provider === "codex" && this.deps.codexLaunchEnvironment !== undefined
      ? this.deps.codexLaunchEnvironment
      : undefined;
    let preparedCodexHome: PreparedCodexHome | undefined;
    if (requirement.provider === "codex" && isolatorProfile === undefined) {
      const hasExplicitSourceHome =
        codexLaunchEnvironment?.["HOME"] !== undefined ||
        codexLaunchEnvironment?.["CODEX_HOME"] !== undefined ||
        requirement.environmentVariables?.["HOME"] !== undefined ||
        requirement.environmentVariables?.["CODEX_HOME"] !== undefined ||
        process.env["CODEX_HOME"] !== undefined;
      const sourceProcessHome = hasExplicitSourceHome
        ? codexLaunchEnvironment?.["HOME"] ??
          requirement.environmentVariables?.["HOME"] ??
          process.env["HOME"] ??
          homedir()
        : join(identity.stateDirectory, "default-codex-process-home");
      const sourceCodexHome = hasExplicitSourceHome
        ? codexLaunchEnvironment?.["CODEX_HOME"] ??
          requirement.environmentVariables?.["CODEX_HOME"] ??
          process.env["CODEX_HOME"] ??
          join(sourceProcessHome, ".codex")
        : join(identity.stateDirectory, "default-codex-home");
      try {
        preparedCodexHome = await preparePrivateCodexHome(
          preliminaryEnvironment.value.stateDirectory,
          sourceCodexHome,
          sourceProcessHome,
          {
            ...(process.env["BFLOW_INSTRUCTION_HOME"] !== undefined
              ? { BFLOW_INSTRUCTION_HOME: process.env["BFLOW_INSTRUCTION_HOME"] }
              : {}),
            ...(codexLaunchEnvironment ?? {}),
            ...(requirement.environmentVariables ?? {})
          }
        );
      } catch (error) {
        return blocked({
          code: "validation",
          retryable: false,
          message: `private Codex home could not be prepared: ${error instanceof Error ? error.message : String(error)}`
        });
      }
      toolChecks.push(
        toolCheck(
          "passed",
          preparedCodexHome.mode === "private"
            ? "codex_instruction_home_private"
            : "codex_instruction_home_native_auth_compatible",
          preparedCodexHome.diagnostic,
          "environment"
        )
      );
    }

    const environmentRequirement = preparedCodexHome === undefined
      ? baseEnvironmentRequirement
      : {
          ...baseEnvironmentRequirement,
          codexInstructionHomeIdentity: {
            mode: preparedCodexHome.mode,
            codexHome: preparedCodexHome.CODEX_HOME,
            home: preparedCodexHome.HOME,
            configDigest: preparedCodexHome.configDigest ?? null
          }
        };
    const environment = preparedCodexHome === undefined
      ? preliminaryEnvironment
      : this.deps.environments.resolve(identity, environmentRequirement, {
          skillManifestDigest: skills.value.manifest.digest
        });
    if (!environment.ok) return blocked(environment.error);

    const originalPrompt = this.deps.rolePrompt?.(requirement.role);
    const rolePrompt = requirement.roleProfile
      ? appendRoleProfileInstructions(originalPrompt ?? defaultRolePrompt(requirement.role), requirement.roleProfile)
      : originalPrompt;
    const hookCommand = this.deps.nativeSessionHookCommand?.(requirement.role, requirement.taskId);
    const extras = this.deps.hostLaunch?.(requirement.role, requirement.taskId);
    const tokenNames = Object.fromEntries(gateway.registrations.map(registration =>
      [registration.registrationId, tokenEnvironmentName(registration.registrationId)]));
    const profileLaunchEnvironment = isolatorProfile === undefined
      ? undefined
      : { ...isolatorProfile.environment };
    const launchEnvironmentValues: Record<string, string> = {
      ...(codexLaunchEnvironment ?? {}),
      ...(preparedCodexHome !== undefined
        ? {
            ...preparedCodexHome.authEnvironment,
            BFLOW_INSTRUCTION_HOME: preparedCodexHome.BFLOW_INSTRUCTION_HOME,
            ...(preparedCodexHome.mode === "private" ||
            codexLaunchEnvironment !== undefined ||
            requirement.environmentVariables?.["HOME"] !== undefined ||
            requirement.environmentVariables?.["CODEX_HOME"] !== undefined ||
            process.env["CODEX_HOME"] !== undefined
              ? {
                  CODEX_HOME: preparedCodexHome.CODEX_HOME,
                  HOME: preparedCodexHome.HOME
                }
              : {})
          }
        : {}),
      ...(profileLaunchEnvironment ?? {})
    };
    if (requirement.provider === "agy") {
      const privateHome = join(environment.value.stateDirectory, "agy-home", requirement.role);
      launchEnvironmentValues["HOME"] = privateHome;
      launchEnvironmentValues["XDG_CONFIG_HOME"] = join(privateHome, ".config");
      launchEnvironmentValues["XDG_DATA_HOME"] = join(privateHome, ".local", "share");
      launchEnvironmentValues["XDG_STATE_HOME"] = join(privateHome, ".local", "state");
      launchEnvironmentValues["XDG_CACHE_HOME"] = join(privateHome, ".cache");
      launchEnvironmentValues["PATH"] = `${join(privateHome, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`;
    }
    const launchEnvironment = Object.keys(launchEnvironmentValues).length > 0 ? launchEnvironmentValues : undefined;
    const context: ProviderAdapterContext = {
      ...(rolePrompt !== undefined ? { rolePrompt } : {}),
      ...(requirement.model !== undefined ? { model: requirement.model } : {}),
      ...(requirement.effort !== undefined ? { effort: requirement.effort } : {}),
      ...(launchEnvironment !== undefined ? { launchEnvironment: { ...launchEnvironment } } : {}),
      ...(isolatorProfile !== undefined ? { isolatorEnvironment: { ...isolatorProfile.environment } } : {}),
      ...(isolatorProfile?.backendUrl !== undefined ? { codexBackendUrl: isolatorProfile.backendUrl } : {}),
      mcpRegistrations: mediated ? [] : gateway.registrations,
      mcpObservations: mediated ? [] : gateway.observations,
      skillManifest: skills.value.manifest,
      renderedSkillsContent: skills.value.rendered.instructionText,
      ...(hookCommand !== undefined ? { nativeSessionHookCommand: hookCommand } : {}),
      trustedIssuerKeys: { [this.deps.signer.issuerId]: this.deps.signer.publicKeyPem },
      ...(extras?.mcpServers !== undefined ? { hostMcpServers: extras.mcpServers } : {}),
      ...(extras?.hooks !== undefined ? { hostHooks: extras.hooks } : {}),
      ...(!mediated && gateway.registrations.length > 0 ? { mcpTokenEnvironmentNames: tokenNames } : {})
    };

    return {
      ready: true,
      identity,
      requirement,
      gatewayTouched,
      environment: environment.value,
      context,
      ...(isolatorProfile !== undefined ? { isolatorProfile } : {}),
      skills: skills.value,
      gateway,
      toolChecks
    };
  }

  private blockedRole(prepared: RoleEnvironmentReady, error: ContractError): RoleBlocked {
    return { identity: prepared.identity, requirement: prepared.requirement, gatewayTouched: prepared.gatewayTouched,
      ready: false, error, summary: summaryOf(prepared.requirement, statusOf(error), [...prepared.toolChecks, ...checksOf(error)], error.message) };
  }

  private async checkPreparedRole(prepared: RoleEnvironmentReady, options?: OperationOptions): Promise<RoleAttempt> {
    await this.deps.beforeSideEffect?.();
    const preflight = await this.deps.providers.preflight(prepared.environment, prepared.context, options);
    return preflight.ok ? { ...prepared, preflight: preflight.value,
      summary: summaryOf(prepared.requirement, "ready", [...preflight.value.checks, ...prepared.toolChecks]) } : this.blockedRole(prepared, preflight.error);
  }

  /** Records the launch intent (journaled by readiness) and retains material for later activation. */
  private async launchRole(attempt: RoleReady, options?: OperationOptions): Promise<OperationResult<PreparedRoleLaunch>> {
    const { identity, requirement } = attempt;
    const profileCheck = await this.revalidateProfile(requirement, attempt.isolatorProfile, options);
    if (!profileCheck.ok) return profileCheck;
    await this.deps.beforeSideEffect?.();
    if (requirement.roleProfile) {
      try {
        const stored = await loadRoleProfileSnapshot(identity, requirement.roleProfile.pin);
        if (canonicalReceiptJson(stored) !== canonicalReceiptJson(requirement.roleProfile)) throw new Error("snapshot drift");
        assertRoleProfilePin(requirement.roleProfile.pin, attempt.environment.roleProfile);
      } catch { return fail("conflict", "Role profile snapshot missing, corrupted or mismatched before launch"); }
    }
    const profile = await this.deps.providers.prepareLaunch(attempt.environment, attempt.context, identity.generation, options);
    if (!profile.ok) return failWith(profile.error);

    const prepared: PreparedRoleLaunch = {
      role: requirement.role,
      ...(requirement.roleProfile ? { roleProfile: requirement.roleProfile.pin } : {}),
      provider: requirement.provider,
      required: requirement.required,
      ...(requirement.taskId !== undefined ? { taskId: requirement.taskId } : {}),
      environment: attempt.environment,
      profile: profile.value,
      preflight: attempt.preflight,
      skills: attempt.skills,
      gateway: attempt.gateway,
      launch: {
        argv: profile.value.argv,
        env: { ...(attempt.context.launchEnvironment ?? {}),
          ...(attempt.requirement.toolGrants === undefined ? attempt.gateway.tokenEnvironment : {}),
          ...providerSessionEnvironment(requirement.provider) },
        launchId: profile.value.launchId,
        launchFingerprint: profile.value.launchFingerprint,
        ...(requirement.roleProfile ? { roleProfile: requirement.roleProfile.pin, features: [ROLE_PROFILE_FEATURE],
          promptSource: join(attempt.environment.stateDirectory, `${requirement.role}.system-prompt.txt`) } : {})
      }
    };
    const record: LaunchRecord = {
      launchId: profile.value.launchId,
      role: requirement.role,
      ...(requirement.roleProfile ? { roleProfile: requirement.roleProfile.pin } : {}),
      provider: requirement.provider,
      ...(requirement.taskId !== undefined ? { taskId: requirement.taskId } : {}),
      state: "intent",
      material: {
        identity,
        requirement,
        environment: attempt.environment,
        context: attempt.context,
        ...(attempt.isolatorProfile !== undefined ? { isolatorProfile: attempt.isolatorProfile } : {}),
        profile: profile.value,
        prepared,
        gatewayTouched: attempt.gatewayTouched
      }
    };
    this.launches.set(record.launchId, record);
    return ok(prepared);
  }

  private async validateRoleProfileMaterial(material: LaunchMaterial): Promise<OperationResult<void>> {
    const snapshot = material.requirement.roleProfile;
    try {
      assertRoleProfilePin(snapshot?.pin, material.environment.roleProfile);
      assertRoleProfilePin(snapshot?.pin, material.profile.environment.roleProfile);
      assertRoleProfilePin(snapshot?.pin, material.prepared.launch.roleProfile);
      if (snapshot) {
        resolveRoleProfile(snapshot, material.requirement);
        const stored = await loadRoleProfileSnapshot(material.identity, snapshot.pin);
        if (canonicalReceiptJson(stored) !== canonicalReceiptJson(snapshot)) throw new Error("snapshot mismatch");
      }
      return ok(undefined);
    } catch { return fail("conflict", "Role profile snapshot missing, corrupted or mismatched"); }
  }

  private async revokeRoleGateway(
    identity: PlatformSessionIdentity,
    requirement: RolePlatformRequirement,
    options?: OperationOptions
  ): Promise<OperationResult<void>> {
    if (!this.deps.gateway) return ok(undefined);
    return this.deps.gateway.revokeRole(identity, requirement.role, requirement.taskId, options);
  }

  /** Marks the launch released and drops its launch material (including bearer tokens). */
  private async dropLaunch(launchId: string, bestEffort = false): Promise<void> {
    const record = this.launches.get(launchId);
    if (!record || record.state === "released") return;
    record.state = "released";
    delete record.material;
    try {
      await this.deps.journal?.append({ kind: "released", launchId, recordedAt: (this.deps.now?.() ?? new Date()).toISOString() });
    } catch (error) {
      // Bulk cleanup keeps going; recovery must still reconcile an unreleased intent before reuse.
      if (!bestEffort) throw error;
    }
  }
}
