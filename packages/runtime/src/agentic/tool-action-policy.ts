import { RepositoryToolPolicySchema, ResolvedToolGrantSchema, ToolUsageRecordSchema,
  type AgentRole, type JsonValue, type RepositoryToolPolicy, type ResolvedToolGrant, type ToolUsageRecord } from "@bflow/contracts";
import type { AgenticHostPlatformOptions } from "../platform/host-options.js";
import { digest } from "./journal.js";

export interface ToolActionAssignmentIdentity { readonly runId: string; readonly taskId?: string; readonly attemptId?: string; }
/** One browser transaction per authenticated assignment attempt, shared across all its browser actions. */
export function browserTransactionId(sessionId: string, role: AgentRole, assignment: { readonly runId: string; readonly attemptId?: string }): string {
  return `browser-${digest([sessionId, role, assignment.runId, assignment.attemptId ?? ""]).slice(0, 48)}`;
}
export function toolActionInvocationId(sessionId: string, role: AgentRole, actionId: string, toolId: string, operation: string,
  assignment?: ToolActionAssignmentIdentity): string {
  return `tool-${digest([sessionId, assignment?.runId ?? "", assignment?.taskId ?? "", assignment?.attemptId ?? "", role,
    actionId, toolId, operation]).slice(0, 48)}`;
}

/** Explicit completed repeats get a fresh identity; unresolved delivery always blocks advancement. */
export function nextToolActionInvocationId(baseId: string, existing: readonly ToolUsageRecord[]): string {
  let ordinal = 0;
  while (true) {
    const candidate = ordinal === 0 ? baseId : `${baseId}-r${ordinal}`;
    const record = existing.find(item => item.invocationId === candidate);
    if (!record) return candidate;
    if (record.status === "started" || record.status === "unknown")
      throw new Error("Tool action delivery is unresolved; reconcile before another invocation");
    ordinal++;
  }
}

export function rtkRequirement(policy: RepositoryToolPolicy | undefined, role: AgentRole, commandId: string) {
  const matches = policy?.requirements.filter(item => item.toolId === "rtk" && item.kind === "cli_only" &&
    item.roles.includes(role) && item.triggers.includes("routine_command") && item.operations.includes("pipe") &&
    (item.cliCommandProfiles === undefined || item.cliCommandProfiles.includes(commandId))) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

/** Scoped usage view intentionally spans generations so an unknown receipt remains visible after host restart. */
export function visibleToolUsage(records: readonly ToolUsageRecord[], sessionId: string, role: AgentRole,
  assignment?: { readonly runId: string; readonly taskId: string }): ToolUsageRecord[] {
  return records.filter(item => item.sessionId === sessionId && item.role === role &&
    (assignment === undefined || item.runId === assignment.runId && item.taskId === assignment.taskId));
}

/** Creates deterministic per-task evidence for eligible actions a role did not use before its task turn ended. */
export function uninvokedToolDispositions(input: { policy: RepositoryToolPolicy; grants: readonly ResolvedToolGrant[]; role: AgentRole;
  sessionId: string; repositoryId: string; repositoryPath: string; generation: number; assignment: ToolActionAssignmentIdentity & { readonly runId: string };
  existing: readonly ToolUsageRecord[]; observedAt: string }): ToolUsageRecord[] {
  const result: ToolUsageRecord[] = [];
  for (const requirement of input.policy.requirements.filter(item => item.roles.includes(input.role))) {
    const candidates = input.grants.filter(grant => grant.role === input.role && grant.toolId === requirement.toolId && grant.policyDigest === input.policy.digest &&
      grant.requiredness === requirement.requiredness && requirement.operations.every(operation => grant.operations.includes(operation)) &&
      requirement.triggers.every(trigger => grant.triggers.includes(trigger)) && (requirement.serviceId === undefined || grant.serviceId === requirement.serviceId) &&
      grant.scope.kind === "session" && grant.scope.sessionId === input.sessionId && grant.scope.repositoryId === input.repositoryId &&
      grant.scope.workspaceRoot === input.repositoryPath);
    const grant = candidates.length === 1 ? candidates[0] : undefined;
    for (const operation of requirement.operations) {
      if (input.existing.some(item => item.sessionId === input.sessionId && item.runId === input.assignment.runId &&
          (input.assignment.taskId === undefined || item.taskId === input.assignment.taskId) && item.role === input.role && item.toolId === requirement.toolId &&
          item.operation === operation && item.status !== "skipped")) continue;
      for (const trigger of requirement.triggers) {
        const invocationId = toolActionInvocationId(input.sessionId, input.role, trigger, requirement.toolId, operation, input.assignment);
        if (input.existing.some(item => item.invocationId === invocationId)) continue;
        const status = grant ? "skipped" as const : requirement.requiredness === "required" ? "blocked" as const : "degraded" as const;
        const serviceId = grant?.serviceId ?? requirement.serviceId;
        result.push(ToolUsageRecordSchema.parse({ schemaVersion: 3, runId: input.assignment.runId,
          ...(input.assignment.taskId ? { taskId: input.assignment.taskId } : {}),
          role: input.role, sessionId: input.sessionId, generation: input.generation, invocationId, toolId: requirement.toolId,
          ...(serviceId ? { serviceId } : {}), operation, status, reasonCode: grant ? "trigger_not_used" : requirement.requiredness === "required" ? "required_grant_unavailable" :
              candidates.length > 1 ? "ambiguous_grant" : "optional_grant_unavailable", observedAt: input.observedAt }));
      }
    }
  }
  return result;
}

/** Safe, role-specific action catalogue for assignment_context; never includes Gateway credentials or CLI identity. */
export function describeToolActions(role: AgentRole, platform: AgenticHostPlatformOptions | undefined,
  sessionId: string, repositoryPath: string) {
  const policy = platform?.toolPolicy === undefined ? undefined : RepositoryToolPolicySchema.parse(platform.toolPolicy);
  if (!policy || !platform) return [];
  const grants = (platform.toolGrants ?? []).map(item => ResolvedToolGrantSchema.parse(item));
  return policy.requirements.filter(requirement => requirement.roles.includes(role)).map(requirement => {
    const matches = grants.filter(grant => grant.role === role && grant.toolId === requirement.toolId && grant.policyDigest === policy.digest &&
      grant.requiredness === requirement.requiredness && requirement.operations.every(operation => grant.operations.includes(operation)) &&
      requirement.triggers.every(trigger => grant.triggers.includes(trigger)) &&
      (requirement.serviceId === undefined || requirement.serviceId === grant.serviceId) && grant.scope.kind === "session" &&
      grant.scope.sessionId === sessionId && grant.scope.repositoryId === platform.repositoryId && grant.scope.workspaceRoot === repositoryPath);
    const grant = matches.length === 1 ? matches[0] : undefined;
    const serviceId = grant?.serviceId ?? requirement.serviceId;
    return { toolId: requirement.toolId, kind: requirement.kind, requiredness: requirement.requiredness, triggers: requirement.triggers,
      operations: requirement.operations, ...(requirement.capabilityIds ? { capabilityIds: requirement.capabilityIds } : {}),
      ...(serviceId ? { serviceId } : {}), ...(requirement.memoryScope ? { memoryScope: requirement.memoryScope } : {}),
      scope: { kind: "session" as const, sessionId, repositoryId: platform.repositoryId, workspaceRoot: repositoryPath },
      status: grant ? "available" as const : requirement.requiredness === "required" ? "blocked" as const : "degraded" as const,
      ...(!grant ? { reasonCode: matches.length > 1 ? "ambiguous_grant" : "grant_unavailable" } : {}) };
  });
}

/** Host-side memory scope guard; the Gateway independently validates the negotiated upstream input schema. */
export function validateMemoryActionInput(grant: ResolvedToolGrant, operation: string, raw: JsonValue): void {
  const scope = grant.memoryScope;
  if (!scope) return;
  if (scope.access !== "read_only" || !["mempalace_search", "mempalace_status"].includes(operation))
    throw new Error("Memory grants are read only; this operation is not approved for scoped retrieval");
  if (operation !== "mempalace_search") return;
  if (!isRecord(raw) || raw.wing !== scope.wing) throw new Error("Memory search must name the exact granted wing");
  if (raw.repositoryId !== undefined && raw.repositoryId !== scope.repositoryId)
    throw new Error("Memory search repository does not match its granted scope");
}

/** Keeps memory content out of context unless the source returns verifiable provenance for the granted scope. */
export function validateMemoryActionOutput(grant: ResolvedToolGrant, operation: string, output: JsonValue): readonly Record<string, unknown>[] | null | undefined {
  const scope = grant.memoryScope;
  if (!scope || operation !== "mempalace_search") return undefined;
  if (Array.isArray(output)) output = { content: output } as JsonValue;
  if (!isRecord(output)) return null;
  if (output.isError === true) return null;
  if (Array.isArray(output.content)) {
    const texts = output.content.flatMap(item => isRecord(item) && item.type === "text" ? [item] : []);
    if (texts.length !== 1 || typeof texts[0]!.text !== "string" || texts[0]!.text.length > 1_000_000) return null;
    try { output = JSON.parse(texts[0]!.text) as JsonValue; } catch { return null; }
    if (!isRecord(output)) return null;
  }
  const rawItems = Array.isArray(output.results) ? output.results : Array.isArray(output.memories) ? output.memories :
    Array.isArray(output.items) ? output.items : undefined;
  if (!rawItems) return null;
  if (rawItems.length === 0) return [];
  const accepted: Record<string, unknown>[] = [];
  for (const raw of rawItems) {
    if (!isRecord(raw)) return null;
    if (!isRecord(raw.provenance)) {
      // MemPalace's native fields are source evidence. The repository relation
      // comes from the operator-approved wing mapping, never from the upstream.
      if (raw.wing !== scope.wing || typeof raw.drawer_id !== "string" || !raw.drawer_id ||
          typeof raw.source_path !== "string" || !raw.source_path || typeof raw.text !== "string" ||
          typeof raw.filed_at !== "string" || !Number.isFinite(Date.parse(raw.filed_at))) return null;
      accepted.push({ ...raw, provenance: { wing: raw.wing, sourceId: raw.drawer_id, sourceReference: raw.source_path,
        timestamp: raw.filed_at, repositoryId: scope.repositoryId, repositoryBinding: "approved_wing_policy" } });
      continue;
    }
    const provenance = raw.provenance;
    const timestamp = provenance.timestamp ?? provenance.createdAt ?? provenance.retrievedAt;
    const sourceReference = provenance.sourceId ?? provenance.source ?? provenance.uri;
    if (provenance.wing !== scope.wing || provenance.repositoryId !== scope.repositoryId ||
        typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)) ||
        typeof sourceReference !== "string" || sourceReference.length === 0) return null;
    accepted.push({ ...raw, provenance: { ...provenance, timestamp, sourceReference } });
  }
  return accepted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
