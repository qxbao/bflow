import { AgentExecutionHandleSchema, DelegationRequestSchema, RoleMessageSchema, SpecificationSchema,
  type AgentRole, type PaneBinding } from "@bflow/contracts";
import { ProjectContextService, type RoleTaskContextBundle } from "../context/project-context-service.js";
import { digest, record } from "./journal.js";

const surveyRoles = new Set<AgentRole>(["coordinator", "specifier", "architect", "planner"]);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? record(value) : {};
const paths = (value: unknown): string[] => Array.isArray(value) ? value.filter((path): path is string => typeof path === "string" &&
  path.length > 0 && !/[?*\[\]]/.test(path) && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") &&
  path.split("/").every(part => part !== ".." && part !== "." && part !== "")) : [];

/** A pane id alone is reusable. Keep assignments scoped to the authenticated native binding. */
export function assignmentsForBinding(outbound: readonly unknown[], binding: PaneBinding): Record<string, unknown>[] {
  return outbound.map(record).filter(out => {
    if (!["accepted", "released"].includes(String(out.status)) || !out.handle || !binding.session) return false;
    const handle = AgentExecutionHandleSchema.parse(out.handle), message = RoleMessageSchema.parse(out.message);
    return handle.target.paneId === binding.paneId && handle.target.agentId === binding.agentId &&
      handle.target.workspaceId === binding.workspaceId && handle.target.tabId === binding.tabId &&
      digest(handle.target.session) === digest(binding.session) && message.recipient.role === binding.role &&
      (message.recipient.agent_id === undefined || message.recipient.agent_id === binding.agentId) &&
      (message.recipient.pane_id === undefined || message.recipient.pane_id === binding.paneId) &&
      (handle.target.worktreePath === undefined || handle.target.worktreePath === binding.worktreePath);
  });
}

/** Read-only enrichment of the existing assignment_context host tool. No journal, approval or scheduler mutations. */
export class AssignmentSurvey {
  private readonly cache = new Map<string, RoleTaskContextBundle>();
  constructor(private readonly repositoryPath: string) {}

  async prepare(binding: PaneBinding, outbound: readonly Record<string, unknown>[], runs: readonly Record<string, unknown>[],
    toolActions: readonly { toolId: string; status: string }[]) {
    if (!surveyRoles.has(binding.role)) return undefined;
    const latest = [...outbound].reverse().find(out => {
      const message = RoleMessageSchema.parse(out.message);
      return out.status === "accepted" && (message.type === "task.assignment" || message.type === "delegation.request");
    });
    if (!latest) return { status: "unavailable", reason: "No assignment for this native role binding; no repository survey was performed." };
    const message = RoleMessageSchema.parse(latest.message);
    const run = runs.find(item => item.runId === message.run_id);
    if (!run) return { status: "unavailable", reason: "Assignment has no matching Runtime run; no repository survey was performed." };
    const delegation = DelegationRequestSchema.parse(run.delegation);
    const assignmentDelegation = message.type === "delegation.request" ? DelegationRequestSchema.parse(message.payload) : undefined;
    const assignmentObjective = assignmentDelegation?.objective ?? delegation.objective;
    const task = Array.isArray(run.tasks) ? run.tasks.map(record).find(item => item.taskId === latest.taskId) : undefined;
    const specInput = object(task?.spec).specification ?? object(run.workflowSpec).specification;
    const specification = specInput === undefined ? undefined : SpecificationSchema.parse(specInput);
    // Scope comes exclusively from Runtime's accepted dossier/intake, never role tool arguments or source text.
    const affectedPaths = paths(specification?.affectedPaths ?? delegation.metadata?.affectedPaths);
    if (!affectedPaths.length) return { status: "limited", assignmentMessageId: message.message_id, runId: run.runId,
      reason: "Runtime has no literal affected paths yet. Scope is unknown; broad source scanning was omitted. Clarify through Runtime → Conversation if a human decision is needed." };
    const root = binding.worktreePath ?? this.repositoryPath;
    const service = new ProjectContextService(root);
    const key = digest([root, binding.role, binding.session, message.message_id, assignmentObjective, affectedPaths, specification]);
    const prior = this.cache.get(key);
    const drift = prior ? await service.detectContextDrift(prior) : undefined;
    const bundle = prior && !drift?.drifted ? prior : await service.prepareRoleTaskContext({
      role: binding.role, ...(typeof latest.taskId === "string" ? { taskId: latest.taskId } : {}), runId: delegation.runId,
      includeRoleInstructions: false,
      title: specification?.title ?? assignmentDelegation?.title ?? delegation.title,
      description: assignmentObjective + (specification ? "\nAccepted specification: " + specification.summary : ""),
      ownedPaths: affectedPaths, affectedPaths, acceptanceCriteria: specification?.acceptanceCriteria ?? delegation.acceptanceCriteria,
      // Bounded, proportional survey; a small scoped change does not require a whole-repository reverse specification.
      maxFiles: affectedPaths.length <= 2 ? 8 : 16, maxTotalBytes: affectedPaths.length <= 2 ? 24_000 : 40_000
    });
    this.cache.delete(key); this.cache.set(key, bundle);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
    const { baselineFiles: _baselineFiles, ...visibleContext } = bundle;
    const short = (items: readonly string[]) => items.slice(0, 8).map(item => item.slice(0, 240));
    const visibleDrift = drift ? { drifted: drift.drifted, checkedAt: drift.checkedAt, specVersionDrifted: drift.specVersionDrifted,
      reasons: short(drift.reasons), modifiedFiles: short(drift.modifiedFiles), deletedFiles: short(drift.deletedFiles), addedOwnedFiles: short(drift.addedOwnedFiles),
      counts: { reasons: drift.reasons.length, modifiedFiles: drift.modifiedFiles.length, deletedFiles: drift.deletedFiles.length, addedOwnedFiles: drift.addedOwnedFiles.length },
      detailsLimitedTo: 8 } : undefined;
    const gitnexus = toolActions.filter(action => action.toolId.toLowerCase().includes("gitnexus"));
    return { status: "prepared", assignmentMessageId: message.message_id, runId: run.runId, taskId: latest.taskId,
      scopeSource: specification ? "Runtime accepted specification dossier" : "Runtime admitted delegation metadata (not approved business requirements)",
      expectedBaseRevision: run.baseRevision ?? null, context: visibleContext,
      freshness: { state: drift?.drifted ? "refreshed_after_drift" : prior ? "checked" : "prepared", ...(visibleDrift ? { drift: visibleDrift } : {}),
        effect: "Diagnostic context only; no specification changes, replanning, approval, lease or task-status changes." },
      gitnexus: { status: "unverified", fallback: "bounded permitted source inspection",
        authorizedActions: gitnexus, limitation: gitnexus.some(action => action.status === "available")
          ? "A scoped action is authorized, but index revision/readiness is unverified. Use the existing invoke_tool_action only when useful; rely on index results only after proving this worktree and source revision match."
          : "No available scoped GitNexus action. Missing/stale index does not block this source survey." },
      authority: "Observed source is evidence of implementation, never approved business intent. Missing intent stays unknown. Human decisions use Runtime → Conversation." };
  }
}
