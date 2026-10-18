import { mkdir } from "node:fs/promises";
import {
  AgentHealthCheckSchema,
  canonicalReceiptJson,
  type AgentEnvironment,
  type AgentHealthCheck,
  type AgentHealthResult,
  type AgentLaunchAttestation,
  type AgentLaunchProfile,
  type AgentProviderId,
  type AgentRole,
  type ContractError,
  type OperationOptions,
  type OperationResult
} from "@bflow/contracts";
import type { LiveReadinessObservation } from "@bflow/agent-providers";
import { sha256Hex } from "./environment.js";
import { fail, failWith, ok } from "./errors.js";
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

export interface DefaultPlatformReadinessServiceDeps {
  readonly environments: RoleEnvironmentResolverPort;
  readonly skills: SkillSessionPort;
  readonly gateway?: GatewayRegistrationPort | undefined;
  readonly providers: ProviderReadinessPort;
  /** Same journal the providers record intents in; receives `released` so restart recovery never sees a dropped launch as pending. */
  readonly journal?: LaunchJournalPort | undefined;
  readonly signer: LaunchAttestationSigner;
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
  readonly profile: AgentLaunchProfile;
  readonly prepared: PreparedRoleLaunch;
  readonly gatewayTouched: boolean;
}

interface LaunchRecord {
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
  /** True once a Gateway register was attempted, so cleanup must revoke even after a failure. */
  readonly gatewayTouched: boolean;
}

interface RoleReady extends RoleAttemptBase {
  readonly ready: true;
  readonly summary: RolePreflightSummary;
  readonly environment: AgentEnvironment;
  readonly context: ProviderAdapterContext;
  readonly preflight: AgentHealthResult;
  readonly skills: ResolvedRoleSkills;
  readonly gateway: RoleGatewayAccess;
}

interface RoleBlocked extends RoleAttemptBase {
  readonly ready: false;
  readonly summary: RolePreflightSummary;
  readonly error: ContractError;
}

type RoleAttempt = RoleReady | RoleBlocked;

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

/**
 * Composes role environment, skills, Gateway registrations and provider readiness into
 * fail-closed launch material. Nothing is launched unless every required role is ready.
 */
export class DefaultPlatformReadinessService implements PlatformReadinessService {
  private readonly launches = new Map<string, LaunchRecord>();
  private readonly identities = new Map<string, PlatformSessionIdentity>();
  private generation: number | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: DefaultPlatformReadinessServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async prepareSession(
    identity: PlatformSessionIdentity,
    requirements: readonly RolePlatformRequirement[],
    options?: OperationOptions
  ): Promise<OperationResult<{ report: PlatformPreflightReport; launches: readonly PreparedRoleLaunch[] }>> {
    this.track(identity);
    const attempts: RoleAttempt[] = [];
    for (const requirement of requirements) {
      attempts.push(await this.preflightRole(identity, requirement, options));
    }

    const summaries = attempts.map(attempt => attempt.summary);
    const launched = new Map<number, PreparedRoleLaunch>();
    const requiredBlocked = attempts.some(attempt => !attempt.ready && attempt.requirement.required);
    let requiredLaunchFailed = false;

    if (!requiredBlocked) {
      for (const [index, attempt] of attempts.entries()) {
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
    const ready = !requiredBlocked && !requiredLaunchFailed;
    if (!ready) {
      for (const prepared of launched.values()) await this.dropLaunch(prepared.launch.launchId, true);
      launched.clear();
    }

    for (const [index, attempt] of attempts.entries()) {
      if (!attempt.gatewayTouched || launched.has(index)) continue;
      const revoked = await this.revokeRoleGateway(attempt.identity, attempt.requirement, options);
      if (!revoked.ok) {
        summaries[index] = withMessage(summaries[index] ?? attempt.summary,
          `Gateway cleanup failed: ${revoked.error.message}`);
      }
    }

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
      const verified = await gateway.verifyRegistrations(identity, options);
      if (!verified.ok) {
        uncertain = true;
        failure ??= verified.error;
        continue;
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
    const environmentId = this.deps.environments.environmentId(identity, requirement);
    let gatewayTouched = false;
    const blocked = (error: ContractError): RoleBlocked => ({
      ready: false,
      identity,
      requirement,
      gatewayTouched,
      error,
      summary: summaryOf(requirement, statusOf(error), checksOf(error), error.message)
    });

    const skills = await this.deps.skills.resolveForRole(identity, requirement, environmentId);
    if (!skills.ok) return blocked(skills.error);

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
      const granted = await this.deps.gateway.ensureForRole(identity, {
        role: requirement.role,
        provider: requirement.provider,
        ...(requirement.taskId !== undefined ? { taskId: requirement.taskId } : {}),
        environmentId,
        serviceIds: [...requirement.mcpServiceIds],
        allowedTools: [...requirement.toolIds],
        configDigest: sha256Hex(canonicalReceiptJson(requirement))
      }, options);
      if (!granted.ok) return blocked(granted.error);
      gateway = granted.value;
    }

    const environment = this.deps.environments.resolve(identity, requirement, {
      skillManifestDigest: skills.value.manifest.digest
    });
    if (!environment.ok) return blocked(environment.error);

    // The role state directory must exist before preflight; it is private and holds no launch side effect yet.
    try {
      await mkdir(environment.value.stateDirectory, { recursive: true, mode: 0o700 });
    } catch (error) {
      return blocked({
        code: "validation",
        retryable: false,
        message: `role state directory could not be created: ${error instanceof Error ? error.message : String(error)}`
      });
    }

    const rolePrompt = this.deps.rolePrompt?.(requirement.role);
    const hookCommand = this.deps.nativeSessionHookCommand?.(requirement.role, requirement.taskId);
    const extras = this.deps.hostLaunch?.(requirement.role, requirement.taskId);
    const tokenNames = Object.fromEntries(gateway.registrations.map(registration =>
      [registration.registrationId, tokenEnvironmentName(registration.registrationId)]));
    const context: ProviderAdapterContext = {
      ...(rolePrompt !== undefined ? { rolePrompt } : {}),
      mcpRegistrations: gateway.registrations,
      mcpObservations: gateway.observations,
      skillManifest: skills.value.manifest,
      renderedSkillsContent: skills.value.rendered.instructionText,
      ...(hookCommand !== undefined ? { nativeSessionHookCommand: hookCommand } : {}),
      trustedIssuerKeys: { [this.deps.signer.issuerId]: this.deps.signer.publicKeyPem },
      ...(extras?.mcpServers !== undefined ? { hostMcpServers: extras.mcpServers } : {}),
      ...(extras?.hooks !== undefined ? { hostHooks: extras.hooks } : {}),
      ...(gateway.registrations.length > 0 ? { mcpTokenEnvironmentNames: tokenNames } : {})
    };

    const preflight = await this.deps.providers.preflight(environment.value, context, options);
    if (!preflight.ok) return blocked(preflight.error);

    return {
      ready: true,
      identity,
      requirement,
      gatewayTouched,
      environment: environment.value,
      context,
      preflight: preflight.value,
      skills: skills.value,
      gateway,
      summary: summaryOf(requirement, "ready", preflight.value.checks)
    };
  }

  /** Records the launch intent (journaled by readiness) and retains material for later activation. */
  private async launchRole(attempt: RoleReady, options?: OperationOptions): Promise<OperationResult<PreparedRoleLaunch>> {
    const { identity, requirement } = attempt;
    const profile = await this.deps.providers.prepareLaunch(attempt.environment, attempt.context, identity.generation, options);
    if (!profile.ok) return failWith(profile.error);

    const prepared: PreparedRoleLaunch = {
      role: requirement.role,
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
        env: { ...attempt.gateway.tokenEnvironment },
        launchId: profile.value.launchId,
        launchFingerprint: profile.value.launchFingerprint
      }
    };
    const record: LaunchRecord = {
      launchId: profile.value.launchId,
      role: requirement.role,
      provider: requirement.provider,
      ...(requirement.taskId !== undefined ? { taskId: requirement.taskId } : {}),
      state: "intent",
      material: {
        identity,
        requirement,
        environment: attempt.environment,
        context: attempt.context,
        profile: profile.value,
        prepared,
        gatewayTouched: attempt.gatewayTouched
      }
    };
    this.launches.set(record.launchId, record);
    return ok(prepared);
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
