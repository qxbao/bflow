import type { GatewayToolOperationOptions } from "./browser-resource-transactions.js";
import type {
  AgentEnvironment, AgentHealthCheck, AgentHealthResult, AgentLaunchAttestation, AgentLaunchProfile,
  AgentProviderAdapter, AgentProviderId, AgentRole, MCPClientRegistration, MCPServiceObservation,
  MCPToolCallResult, RepositoryToolPolicy, ResolvedToolGrant,
  OperationOptions, OperationResult, PermissionProfile, ScopedOperation, SkillManifest, SkillPin, TrustScope,
  ResolvedRoleProfileSnapshot, RoleProfilePin
} from "@bflow/contracts";
import type { HostHookEvent, HostMcpServer, LiveReadinessObservation } from "@bflow/agent-providers";
import type { RenderedSkills, ResolveSkillsRequest } from "@bflow/skills";

/**
 * P30 package-local composition ports. Values crossing a package boundary keep the
 * frozen v3 contract shapes; these interfaces only fix how Runtime composes them.
 */

/** One repository session launch generation. Generation increments when `up` relaunches roles. */
export interface PlatformSessionIdentity {
  readonly machineId: string;
  readonly repositoryId: string;
  /** Canonical realpath of the repository checkout. */
  readonly workspaceRoot: string;
  readonly sessionId: string;
  /** Positive integer. */
  readonly generation: number;
  /** Private (0700) host-owned directory, normally `<repo>/.bflow/state/platform/<sessionId>`. */
  readonly stateDirectory: string;
}

export interface RoleSkillSelection {
  readonly skill: SkillPin;
  readonly required: boolean;
  readonly approvalReceiptId?: string;
}

/** Owner-configured requirement for one role launch; never inferred from an agent prompt. */
export interface RolePlatformRequirement {
  readonly role: AgentRole;
  readonly roleProfile?: ResolvedRoleProfileSnapshot;
  /** Assignment/attempt identity isolates native context on every fresh profiled launch. */
  readonly assignmentId?: string;
  readonly writablePaths?: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly provider: AgentProviderId;
  readonly profileName?: string;
  readonly required: boolean;
  readonly model?: string;
  readonly effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Exact workflow-pack locks, distinct from the base role's model/effort defaults. */
  readonly preferenceConstraints?: {
    readonly model?: string | undefined;
    readonly effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  };
  readonly permissionMode: PermissionProfile["mode"];
  /** Workspace root for permanent roles, exact task worktree for a Developer. */
  readonly cwd: string;
  /** Dynamic Developer launches are keyed by task. */
  readonly taskId?: string;
  /** Host-only identity of a continuation launch; task/governance identity remains unchanged. */
  readonly executionKey?: string;
  readonly capabilityIds: readonly string[];
  readonly mcpServiceIds: readonly string[];
  /** Exact MCP operation names. Kept distinct from toolIds, which are catalog inventory IDs. */
  readonly mcpOperations?: readonly string[];
  /** Resolved per-role grants; Runtime groups these by service before Gateway registration. */
  readonly toolGrants?: readonly ResolvedToolGrant[];
  /** Explicit repository policy snapshot used to fail required missing grants before Gateway or provider side effects. */
  readonly toolPolicy?: RepositoryToolPolicy;
  readonly toolIds: readonly string[];
  readonly skillSelections: readonly RoleSkillSelection[];
  readonly dependencySkillApprovals?: readonly import("@bflow/contracts").SkillDependencyApproval[];
  readonly environmentVariables?: Readonly<Record<string, string>>;
  /** Present only with verified full-process isolation evidence; required for `unattended_isolated`. */
  readonly isolation?: { readonly kind: "os_sandbox" | "container"; readonly proofId: string };
  readonly network?: PermissionProfile["network"];
}

// ---------------------------------------------------------------- skills (T2)

/** Structural port over `@bflow/skills` SkillManager. */
export interface SkillResolverPort {
  resolve(request: ResolveSkillsRequest): Promise<{ manifest: SkillManifest; diagnostics: string[] }>;
  /** Resolve, persist the immutable `manifest-<digest>` document `recover` reads, then link. */
  sync(request: ResolveSkillsRequest): Promise<{ manifest: SkillManifest; rendered: RenderedSkills; diagnostics: string[] }>;
  verify(manifest: SkillManifest): Promise<SkillManifest>;
  link(manifest: SkillManifest): Promise<RenderedSkills>;
  recover(digest: string): Promise<SkillManifest>;
}

export interface ResolvedRoleSkills {
  readonly manifest: SkillManifest;
  readonly rendered: RenderedSkills;
  readonly diagnostics: readonly string[];
}

export interface SkillSessionPort {
  /** Resolve → verify → link, then persist for this exact generation before returning. */
  resolveForRole(identity: PlatformSessionIdentity, requirement: RolePlatformRequirement,
    environmentId: string): Promise<OperationResult<ResolvedRoleSkills>>;
  /** Recover a persisted manifest by exact digest; drift is `conflict`, never a silent re-resolve. */
  load(identity: PlatformSessionIdentity, role: AgentRole, taskId?: string, executionKey?: string, roleProfile?: RoleProfilePin, assignmentId?: string): Promise<OperationResult<ResolvedRoleSkills | null>>;
}

// ----------------------------------------------------------- environment (T2)

export interface RoleEnvironmentResolverPort {
  /** Deterministic for (session, generation, role, taskId). */
  environmentId(identity: PlatformSessionIdentity, requirement: RolePlatformRequirement): string;
  resolve(identity: PlatformSessionIdentity, requirement: RolePlatformRequirement,
    resolved: { readonly skillManifestDigest: string }): OperationResult<AgentEnvironment>;
}

// --------------------------------------------------------------- gateway (T3)

export interface GatewayRegistrationGrant {
  readonly registration: MCPClientRegistration;
  /** Bearer value for the provider process. In-memory only: never persisted, logged or put in argv. */
  readonly bearerToken: string;
}

/** Control plane of the shared Gateway daemon. The concrete endpoint is integrated separately. */
export interface GatewayControlPort {
  register(registration: MCPClientRegistration, options?: OperationOptions, grants?: readonly ResolvedToolGrant[]): Promise<OperationResult<GatewayRegistrationGrant>>;
  revoke(registrationId: string, operation: ScopedOperation, options?: OperationOptions): Promise<OperationResult<void>>;
  /** Registrations visible to exactly this session scope; used to reconcile uncertain registers. */
  list(scope: TrustScope, options?: OperationOptions): Promise<OperationResult<readonly MCPClientRegistration[]>>;
  inspectServices(operation: ScopedOperation, options?: OperationOptions): Promise<OperationResult<readonly MCPServiceObservation[]>>;
  acquireResource?(request: import("@bflow/contracts").MCPResourceRequest, options?: OperationOptions): Promise<OperationResult<import("@bflow/contracts").MCPResourceLease>>;
  renewResource?(request: import("@bflow/contracts").MCPResourceRenewRequest, options?: OperationOptions): Promise<OperationResult<import("@bflow/contracts").MCPResourceLease>>;
  releaseResource?(lease: import("@bflow/contracts").MCPResourceLease, operation: ScopedOperation, options?: OperationOptions): Promise<OperationResult<void>>;
  invokeTool(call: import("@bflow/contracts").MCPToolCall, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>>;
  reconcileToolCall(call: import("@bflow/contracts").MCPToolCall, options?: OperationOptions): Promise<OperationResult<MCPToolCallResult>>;
}

export interface RoleGatewayAccess {
  readonly registrations: readonly MCPClientRegistration[];
  readonly observations: readonly MCPServiceObservation[];
  /** Environment variable name → bearer token. In-memory only. */
  readonly tokenEnvironment: Readonly<Record<string, string>>;
}

export interface GatewayRoleRequest {
  readonly role: AgentRole;
  readonly provider: AgentProviderId;
  readonly taskId?: string;
  readonly environmentId: string;
  readonly serviceIds: readonly string[];
  readonly allowedTools: readonly string[];
  /** Exact authority attached to this single-service registration. */
  readonly toolGrants?: readonly ResolvedToolGrant[];
  readonly configDigest: string;
}

/** A ledger registration Runtime holds but the Gateway no longer serves (or serves expired). */
export interface LostGatewayRegistration {
  readonly registrationId: string;
  readonly role: AgentRole;
  readonly taskId?: string;
}

export interface GatewayRegistrationVerification {
  readonly checkedAt: string;
  /** True only when nothing is lost and the Gateway answered. */
  readonly healthy: boolean;
  readonly lost: readonly LostGatewayRegistration[];
  /** The Gateway could not be asked; nothing was changed. */
  readonly uncertain: boolean;
}

export interface GatewayRegistrationPort {
  ensureForRole(identity: PlatformSessionIdentity, request: GatewayRoleRequest,
    options?: OperationOptions): Promise<OperationResult<RoleGatewayAccess>>;
  /** Compares the ledger's current-generation registrations with the Gateway; marks missing or expired ones `lost`. */
  verifyRegistrations(identity: PlatformSessionIdentity,
    options?: OperationOptions): Promise<OperationResult<GatewayRegistrationVerification>>;
  revokeRole(identity: PlatformSessionIdentity, role: AgentRole, taskId?: string,
    options?: OperationOptions): Promise<OperationResult<void>>;
  revokeSession(identity: PlatformSessionIdentity, options?: OperationOptions): Promise<OperationResult<void>>;
  invokeTool(identity: PlatformSessionIdentity, role: AgentRole, taskId: string | undefined, serviceId: string,
    operation: string, input: import("@bflow/contracts").JsonValue, callId: string, options?: GatewayToolOperationOptions): Promise<OperationResult<MCPToolCallResult>>;
  finishToolTransaction?(identity: PlatformSessionIdentity, role: AgentRole, transactionId: string): Promise<OperationResult<void>>;
  reconcileToolCall(identity: PlatformSessionIdentity, role: AgentRole, taskId: string | undefined, serviceId: string,
    operation: string, input: import("@bflow/contracts").JsonValue, callId: string, options?: GatewayToolOperationOptions): Promise<OperationResult<MCPToolCallResult>>;
}

// -------------------------------------------------------------- provider (T4)

export interface ProviderAdapterContext {
  /** Trusted machine process environment selectors, never sourced from repository role config. */
  readonly launchEnvironment?: Readonly<Record<string, string>>;
  /** Trusted ai-isolator profile environment, resolved by Runtime from machine state. */
  readonly isolatorEnvironment?: Readonly<Record<string, string>>;
  /** Validated linked Codex backend URL, absent for direct/unset profiles. */
  readonly codexBackendUrl?: string;
  readonly rolePrompt?: string;
  readonly model?: string;
  readonly effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  readonly mcpRegistrations: readonly MCPClientRegistration[];
  readonly mcpObservations: readonly MCPServiceObservation[];
  readonly skillManifest: SkillManifest;
  readonly renderedSkillsContent: string;
  readonly nativeSessionHookCommand?: string;
  readonly trustedIssuerKeys: Readonly<Record<string, string>>;
  readonly liveObservation?: LiveReadinessObservation;
  /** Trusted host stdio MCP servers (e.g. `bflow`) and native hooks the launched process must load. */
  readonly hostMcpServers?: Readonly<Record<string, HostMcpServer>>;
  readonly hostHooks?: Readonly<Partial<Record<HostHookEvent, string>>>;
  /** registrationId → env var name holding that Gateway registration's bearer token. */
  readonly mcpTokenEnvironmentNames?: Readonly<Record<string, string>>;
}

/** Host-owned launch material per role, independent of provider. */
export interface HostLaunchExtras {
  readonly mcpServers?: Readonly<Record<string, HostMcpServer>>;
  readonly hooks?: Readonly<Partial<Record<HostHookEvent, string>>>;
}

/** Builds a provider adapter bound to one role launch context (adapter options are constructor-scoped). */
export type ProviderAdapterFactory = (provider: AgentProviderId, context: ProviderAdapterContext, options?: OperationOptions) => AgentProviderAdapter;

export interface LaunchAttestationInput {
  readonly receiptId: string;
  readonly launchId: string;
  readonly launchFingerprint: string;
  readonly sessionId: string;
  readonly paneId: string;
  readonly nativeSession: AgentLaunchAttestation["nativeSession"];
  readonly observedAt: string;
}

/** Host-held Ed25519 issuer. The private key never leaves the signer. */
export interface LaunchAttestationSigner {
  readonly issuerId: string;
  readonly publicKeyPem: string;
  sign(input: LaunchAttestationInput): AgentLaunchAttestation;
}

export interface ActivationRequest {
  readonly profile: AgentLaunchProfile;
  readonly context: ProviderAdapterContext;
  readonly paneId: string;
  readonly nativeSession: AgentLaunchAttestation["nativeSession"];
  readonly signer: LaunchAttestationSigner;
}

export interface ProviderReadinessPort {
  /** Stage `preflight`; anything but `ready` is returned as a failed OperationResult (fail-closed). */
  preflight(environment: AgentEnvironment, context: ProviderAdapterContext,
    options?: OperationOptions): Promise<OperationResult<AgentHealthResult>>;
  /** Records the launch intent in the journal before returning the profile. */
  prepareLaunch(environment: AgentEnvironment, context: ProviderAdapterContext, generation: number,
    options?: OperationOptions): Promise<OperationResult<AgentLaunchProfile>>;
  /** Signs the startup attestation and requires stage `activated` readiness. */
  verifyActivated(request: ActivationRequest, options?: OperationOptions): Promise<OperationResult<AgentHealthResult>>;
  /** Cached health for exact (environmentId, configFingerprint) and unexpired TTL, else failure. */
  assertFresh(environmentId: string, configFingerprint: string, now?: Date): OperationResult<AgentHealthResult>;
}

export type LaunchJournalEntry =
  | { readonly kind: "intent"; readonly launchId: string; readonly role: AgentRole; readonly provider: AgentProviderId;
      readonly taskId?: string; readonly environmentId: string; readonly configFingerprint: string;
      readonly roleProfile?: RoleProfilePin;
      readonly launchFingerprint: string; readonly generation: number; readonly recordedAt: string }
  | { readonly kind: "attested"; readonly launchId: string; readonly paneId: string; readonly receiptId: string; readonly recordedAt: string }
  | { readonly kind: "activated"; readonly launchId: string; readonly status: AgentHealthResult["status"];
      readonly validUntil: string; readonly recordedAt: string }
  | { readonly kind: "failed"; readonly launchId: string; readonly code: string; readonly message: string; readonly recordedAt: string }
  | { readonly kind: "released"; readonly launchId: string; readonly recordedAt: string };

export interface LaunchJournalPort {
  append(entry: LaunchJournalEntry): Promise<void>;
  /** Replays durable entries in write order; malformed lines are corruption, never skipped. */
  entries(): Promise<readonly LaunchJournalEntry[]>;
}

// --------------------------------------------------------------- service (T6)

export interface PreparedRoleLaunch {
  readonly role: AgentRole;
  readonly roleProfile?: RoleProfilePin;
  readonly provider: AgentProviderId;
  readonly required: boolean;
  readonly taskId?: string;
  readonly environment: AgentEnvironment;
  readonly profile: AgentLaunchProfile;
  readonly preflight: AgentHealthResult;
  readonly skills: ResolvedRoleSkills;
  readonly gateway: RoleGatewayAccess;
  /** Launch material for Pane Manager. `env` may hold bearer tokens: never serialize it. */
  readonly launch: {
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly launchId: string;
    readonly launchFingerprint: string;
    readonly roleProfile?: RoleProfilePin;
    readonly features?: readonly string[];
    readonly promptSource?: string;
  };
}

export interface RolePreflightSummary {
  readonly role: AgentRole;
  readonly roleProfile?: RoleProfilePin;
  readonly provider: AgentProviderId;
  readonly required: boolean;
  readonly taskId?: string;
  readonly status: "ready" | "blocked" | "unsupported" | "error";
  readonly checks: readonly AgentHealthCheck[];
  readonly message?: string;
}

export interface PlatformPreflightReport {
  /** True only when every required role is `ready`. */
  readonly ready: boolean;
  readonly generation: number;
  readonly roles: readonly RolePreflightSummary[];
  readonly checkedAt: string;
}

export interface PlatformStatusSnapshot {
  readonly generation: number | null;
  readonly launches: readonly {
    readonly launchId: string; readonly role: AgentRole; readonly provider: AgentProviderId; readonly taskId?: string;
    readonly roleProfile?: RoleProfilePin;
    /** `degraded`: a Gateway registration this launch relies on was lost; relaunch the role. */
    readonly state: "intent" | "attested" | "activated" | "failed" | "released" | "degraded";
    readonly healthValidUntil?: string;
    readonly reason?: "gateway_registration_lost";
  }[];
}

export interface PlatformReadinessService {
  /** All-or-nothing: any required role failing preflight yields no launch material (no pane side effects). */
  prepareSession(identity: PlatformSessionIdentity, requirements: readonly RolePlatformRequirement[],
    options?: OperationOptions): Promise<OperationResult<{ report: PlatformPreflightReport; launches: readonly PreparedRoleLaunch[] }>>;
  /** Recheck retained same-daemon material without minting a launch, token or generation. */
  revalidatePreparedLaunch?(launchId: string, options?: OperationOptions): Promise<OperationResult<PreparedRoleLaunch>>;
  verifyActivated(input: { readonly launchId: string; readonly paneId: string;
    readonly nativeSession: AgentLaunchAttestation["nativeSession"]; readonly observation?: LiveReadinessObservation },
    options?: OperationOptions): Promise<OperationResult<AgentHealthResult>>;
  assertFresh(launchId: string, now?: Date): OperationResult<AgentHealthResult>;
  prepareDeveloper(identity: PlatformSessionIdentity, requirement: RolePlatformRequirement,
    options?: OperationOptions): Promise<OperationResult<PreparedRoleLaunch>>;
  preflightDeveloper?(identity: PlatformSessionIdentity, requirement: RolePlatformRequirement,
    options?: OperationOptions): Promise<OperationResult<AgentHealthResult>>;
  releaseLaunch(launchId: string, options?: OperationOptions): Promise<OperationResult<void>>;
  /** Verifies every seen session's Gateway registrations; lost ones degrade their launches (`assertFresh` then fails). */
  /** Revoke this session's registrations and release journal intents left by a previous host daemon. */
  reconcileAfterRestart(identity: PlatformSessionIdentity,
    options?: OperationOptions): Promise<OperationResult<{ readonly releasedLaunchIds: readonly string[] }>>;
  verifyGateway(options?: OperationOptions): Promise<OperationResult<GatewayRegistrationVerification>>;
  invokeTool(identity: PlatformSessionIdentity, role: AgentRole, taskId: string | undefined, serviceId: string,
    operation: string, input: import("@bflow/contracts").JsonValue, callId: string, options?: GatewayToolOperationOptions): Promise<OperationResult<MCPToolCallResult>>;
  finishToolTransaction?(identity: PlatformSessionIdentity, role: AgentRole, transactionId: string): Promise<OperationResult<void>>;
  reconcileToolCall(identity: PlatformSessionIdentity, role: AgentRole, taskId: string | undefined, serviceId: string,
    operation: string, input: import("@bflow/contracts").JsonValue, callId: string, options?: GatewayToolOperationOptions): Promise<OperationResult<MCPToolCallResult>>;
  /** Revokes this session's Gateway registrations; never stops shared/external services. */
  shutdown(options?: OperationOptions): Promise<OperationResult<void>>;
  status(): PlatformStatusSnapshot;
}
