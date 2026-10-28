import { canonicalReceiptJson, RoleProfileCatalogSchema, RoleProfilePinSchema, ResolvedRoleProfileSnapshotSchema, sameRoleProfilePin,
  type RoleProfilePin, type ResolvedRoleProfileSnapshot, type TaskDefinition, type PaneBinding, type AgentSessionLocator, type ExecutorLineage
} from "@bflow/contracts";

export function selectRoleProfile(catalog: readonly ResolvedRoleProfileSnapshot[] | undefined, role: string,
  pin: RoleProfilePin | undefined, required: readonly string[] = []): ResolvedRoleProfileSnapshot | undefined {
  if (pin === undefined) return undefined;
  const parsed = RoleProfilePinSchema.parse(pin);
  const snapshots = RoleProfileCatalogSchema.parse(catalog ?? []);
  const snapshot = snapshots.find(value => sameRoleProfilePin(value.pin, parsed));
  if (!snapshot || snapshot.definition.baseRole !== role) throw new Error("Selected profile is unavailable or incompatible with its governance role");
  const allowed = snapshot.definition.restrictions.capabilityIds;
  if (allowed && required.some(capability => !allowed.includes(capability))) throw new Error("Profile capability restriction conflicts with assignment requirements");
  return snapshot;
}
const within = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/");
export function narrowProfileTask(task: TaskDefinition, snapshot: ResolvedRoleProfileSnapshot | undefined): TaskDefinition {
  if (!snapshot) return task;
  const restriction = snapshot.definition.restrictions;
  const original = task.metadata?.ownedPaths;
  if (!Array.isArray(original) || !original.every((path): path is string => typeof path === "string")) throw new Error("Profile task requires literal accepted ownership");
  let owned = [...original];
  if (restriction.writablePaths !== undefined) owned = [...new Set(original.flatMap(path => restriction.writablePaths!.flatMap(prefix =>
    within(path, prefix) ? [path] : within(prefix, path) ? [prefix] : [])))];
  const denied = restriction.deniedPaths ?? [];
  owned = owned.filter(path => !denied.some(prefix => within(path, prefix)));
  if (!owned.length) throw new Error("Profile has no writable scope within the task assignment");
  return { ...task, roleProfile: snapshot.pin, metadata: { ...task.metadata, ownedPaths: owned,
    forbiddenPaths: [...new Set([...(Array.isArray(task.metadata?.forbiddenPaths) ? task.metadata.forbiddenPaths.filter((v): v is string => typeof v === "string") : []), ...denied])] } };
}
export function assertProfileSnapshotCurrent(snapshot: ResolvedRoleProfileSnapshot, catalog: readonly ResolvedRoleProfileSnapshot[] | undefined): void {
  const parsed = ResolvedRoleProfileSnapshotSchema.parse(snapshot);
  const current = selectRoleProfile(catalog, parsed.definition.baseRole, parsed.pin);
  if (current === undefined || canonicalReceiptJson(current) !== canonicalReceiptJson(parsed)) throw new Error("Pinned role profile snapshot drift; replan or restore the accepted profile");
}
export function assertProfileBinding(snapshot: ResolvedRoleProfileSnapshot | undefined, pane: PaneBinding): void {
  if (!sameRoleProfilePin(snapshot?.pin, pane.roleProfile) || snapshot && snapshot.definition.baseRole !== pane.role)
    throw new Error("Profile assignment and native pane pin/governance role mismatch");
}
export function assertProfileToolAction(snapshot: ResolvedRoleProfileSnapshot | undefined, toolId: string, operation: string): void {
  const tools = snapshot?.definition.restrictions.tools;
  if (tools !== undefined && !tools.some(tool => tool.toolId === toolId && tool.operations.includes(operation)))
    throw new Error("Tool operation is denied by the pinned profile restriction");
}
type Executor = { agentId: string; session?: AgentSessionLocator | undefined; executorLineage?: ExecutorLineage | undefined };
/** Labels and profile IDs never establish independent execution. Native identities and authenticated lineage do. */
export function assertIndependentProfileExecutor(candidate: Executor, implementers: readonly Executor[]): void {
  const nativeKey = (value: Executor) => value.session && `${value.session.source}:${value.session.kind}:${value.session.value}`;
  const roots = (value: Executor) => [value.executorLineage?.executorId, value.executorLineage?.predecessorExecutorId].filter(Boolean);
  if (implementers.some(implementation => implementation.agentId === candidate.agentId ||
      nativeKey(candidate) !== undefined && nativeKey(candidate) === nativeKey(implementation) ||
      roots(candidate).some(root => roots(implementation).includes(root)))) throw new Error("Independent verifier is an implementation executor or successor");
}
