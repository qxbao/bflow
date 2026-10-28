import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  AgentEnvironmentSchema,
  canonicalReceiptJson,
  type AgentEnvironment,
  type OperationResult,
  type PermissionProfile,
  type TrustScope
} from "@bflow/contracts";
import { fail, ok } from "./errors.js";
import { resolveRoleProfile } from "./role-profiles.js";
import type {
  PlatformSessionIdentity,
  RoleEnvironmentResolverPort,
  RolePlatformRequirement
} from "./ports.js";

const MAX_IDENTIFIER_LENGTH = 200;
/** Task ids become path segments, so traversal characters are rejected at this boundary. */
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Keeps a deterministic identifier within IdentifierSchema by replacing an overlong tail with its digest. */
export function boundedIdentifier(value: string): string {
  if (value.length <= MAX_IDENTIFIER_LENGTH) return value;
  const digest = sha256Hex(value);
  return `${value.slice(0, MAX_IDENTIFIER_LENGTH - digest.length - 1)}-${digest}`;
}

export function sessionTrustScope(identity: PlatformSessionIdentity): Extract<TrustScope, { kind: "session" }> {
  return {
    kind: "session",
    machineId: identity.machineId,
    repositoryId: identity.repositoryId,
    workspaceRoot: identity.workspaceRoot,
    sessionId: identity.sessionId
  };
}

/** Returns an error message for an unsafe task id, or undefined when it may be used as a path segment. */
export function taskIdError(taskId: string | undefined): string | undefined {
  if (taskId === undefined) return undefined;
  return TASK_ID_PATTERN.test(taskId) ? undefined : "task id must be a safe path segment";
}

export class RoleEnvironmentResolver implements RoleEnvironmentResolverPort {
  environmentId(identity: PlatformSessionIdentity, requirement: RolePlatformRequirement): string {
    const task = (requirement.taskId ? `-${requirement.taskId}` : "") + (requirement.executionKey ? `-${requirement.executionKey}` : "");
    const profile = requirement.roleProfile ? `-profile-${requirement.roleProfile.pin.digest}` : "";
    const assignment = requirement.assignmentId ? `-assignment-${sha256Hex(requirement.assignmentId)}` : "";
    return boundedIdentifier(`env-${identity.sessionId}-g${identity.generation}-${requirement.role}${task}${profile}${assignment}`);
  }

  resolve(
    identity: PlatformSessionIdentity,
    requirement: RolePlatformRequirement,
    resolved: { readonly skillManifestDigest: string }
  ): OperationResult<AgentEnvironment> {
    try { if (requirement.roleProfile) requirement = resolveRoleProfile(requirement.roleProfile, requirement); }
    catch { return fail("validation", "role profile policy is incompatible or unsupported", { status: "unsupported" }); }
    if (!Number.isInteger(identity.generation) || identity.generation < 1)
      return fail("validation", "generation must be a positive integer");
    if (!isAbsolute(requirement.cwd)) return fail("validation", "role cwd must be absolute");
    const taskError = taskIdError(requirement.taskId);
    if (taskError) return fail("validation", taskError);
    const executionError = taskIdError(requirement.executionKey);
    if (executionError) return fail("validation", executionError);

    const shape = permissionShape(requirement);
    if (!shape.ok) return shape;

    const scope = sessionTrustScope(identity);
    const environmentId = this.environmentId(identity, requirement);
    const permissionProfile: PermissionProfile = {
      schemaVersion: 3,
      profileId: boundedIdentifier(`perm-${requirement.permissionMode}-${environmentId}`),
      mode: requirement.permissionMode,
      scope,
      filesystem: shape.value.filesystem,
      readableRoots: identity.workspaceRoot === requirement.cwd
        ? [identity.workspaceRoot]
        : [identity.workspaceRoot, requirement.cwd],
      writableRoots: shape.value.writableRoots,
      deniedRoots: [],
      isolation: shape.value.isolation,
      network: requirement.network ?? { mode: "deny", allowedHosts: [] },
      allowedTools: [...requirement.toolIds],
      deniedAction: "request_via_conversation",
      allowGlobalPermissionBypass: false
    };
    const configFingerprint = sha256Hex(canonicalReceiptJson({
      requirement,
      skillManifestDigest: resolved.skillManifestDigest,
      generation: identity.generation,
      permissionProfile
    }));
    const task = (requirement.taskId ? `-${requirement.taskId}` : "") + (requirement.executionKey ? `-${requirement.executionKey}` : "");
    const environment: AgentEnvironment = {
      schemaVersion: 3,
      environmentId,
      provider: requirement.provider,
      role: requirement.role,
      scope,
      cwd: requirement.cwd,
      stateDirectory: `${identity.stateDirectory}/gen-${identity.generation}/roles/${requirement.executionKey ? boundedIdentifier(`${requirement.role}${task}`) : `${requirement.role}${task}`}${requirement.roleProfile ? `/profiles/${requirement.roleProfile.pin.digest}` : ""}${requirement.assignmentId ? `/assignments/${sha256Hex(requirement.assignmentId)}` : ""}`,
      ...(requirement.roleProfile ? { roleProfile: requirement.roleProfile.pin } : {}),
      configFingerprint,
      permissionProfile,
      environmentVariables: { ...(requirement.environmentVariables ?? {}) },
      secretBindings: {},
      requiredCapabilityIds: [...requirement.capabilityIds],
      requiredMcpServiceIds: [...requirement.mcpServiceIds],
      skillManifestDigest: resolved.skillManifestDigest
    };
    const parsed = AgentEnvironmentSchema.safeParse(environment);
    if (!parsed.success)
      return fail("validation", `agent environment invalid: ${parsed.error.issues.map(issue => issue.message).join("; ")}`);
    return ok(parsed.data);
  }
}

type PermissionShape = OperationResult<{
  readonly filesystem: PermissionProfile["filesystem"];
  readonly writableRoots: string[];
  readonly isolation: PermissionProfile["isolation"];
}>;

function permissionShape(requirement: RolePlatformRequirement): PermissionShape {
  if (requirement.writablePaths?.length === 0 && requirement.permissionMode !== "unattended_isolated")
    return ok({ filesystem: "read_only", writableRoots: [], isolation: "provider_policy" });
  switch (requirement.permissionMode) {
    case "restricted":
      return ok({ filesystem: "read_only", writableRoots: [], isolation: "provider_policy" });
    case "workspace_auto":
      return ok({ filesystem: "workspace_write", writableRoots: requirement.writablePaths?.map(path => join(requirement.cwd, path)) ?? [requirement.cwd], isolation: "provider_policy" });
    case "unattended_isolated":
      // Never downgrade: unattended execution without verified OS/container isolation is refused.
      if (!requirement.isolation)
        return fail("validation", `unattended_isolated requires verified isolation for role ${requirement.role}`,
          { code: "unsupported_isolation" });
      return ok({ filesystem: requirement.writablePaths?.length === 0 ? "read_only" : "workspace_write", writableRoots: requirement.writablePaths?.map(path => join(requirement.cwd, path)) ?? [requirement.cwd], isolation: requirement.isolation.kind });
    default:
      return fail("validation", "unknown permission mode");
  }
}
