import { record } from "./journal.js";

/**
 * Serialized size budget for the Conversation UserPromptSubmit context (bytes of JSON). The hook header and MUST SHOW prefix
 * are counted against it too, so the whole additionalContext stays under the provider's hook output limit (~9.4 K characters).
 */
export const CONVERSATION_CONTEXT_BUDGET = 7000;

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const fieldsOf = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);

/** Caps long text and marks the cut, so the model knows the text is incomplete. */
const capText = (value: unknown, max: number): unknown => typeof value === "string" && value.length > max
  ? `${value.slice(0, max)}…[truncated ${value.length - max} chars]` : value;
const capFields = (value: unknown, max: number) => Object.fromEntries(Object.entries(fieldsOf(value)).map(([key, item]) => [key, capText(item, max)]));
const pick = (value: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(key => key in value).map(key => [key, value[key]]));
const isTerminal = (workflow: Record<string, unknown>) => TERMINAL_STATUSES.has(String(workflow.sdlcStatus));
const hasApprovals = (workflow: Record<string, unknown>) => Array.isArray(workflow.activeApprovalIds) && workflow.activeApprovalIds.length > 0;
/** Only open workflows without pending approvals are briefed; an approval keeps its detail for the model to act on. */
const isBriefable = (workflow: Record<string, unknown>) => !isTerminal(workflow) && !hasApprovals(workflow);

/** A finished workflow keeps only what identifies it; its history is no longer actionable. */
const summarizeTerminal = (workflow: Record<string, unknown>) => ({
  correlationId: workflow.correlationId, runId: workflow.runId, title: capText(workflow.title, 120), sdlcStatus: workflow.sdlcStatus, updatedAt: workflow.updatedAt
});

/** An open workflow keeps identity, status and approvals; its objective, criteria and recent progress are capped. */
const compactOpen = (workflow: Record<string, unknown>) => {
  const { acceptanceCriteria, progressHistory, lastProgress, ...rest } = workflow;
  return {
    ...capFields(rest, 300),
    ...(Array.isArray(acceptanceCriteria) ? { acceptanceCriteria: acceptanceCriteria.map(criterion => ({
      ...Object.fromEntries(["id", "status", "required"].map(key => [key, fieldsOf(criterion)[key]])), description: capText(fieldsOf(criterion).description, 120)
    })) } : {}),
    ...(Array.isArray(progressHistory) ? { progressHistory: progressHistory.slice(-3).map(entry => capFields(entry, 120)) } : {}),
    ...(lastProgress === undefined ? {} : { lastProgress: capFields(lastProgress, 120) })
  };
};

/** Under budget pressure an open workflow without approvals keeps identity, status, a criteria count and one progress line. */
const briefOpen = (workflow: Record<string, unknown>) => ({
  ...pick(workflow, ["correlationId", "runId", "sdlcStatus", "activeApprovalIds", "updatedAt"]),
  title: capText(workflow.title, 120), blockedReason: capText(workflow.blockedReason, 120),
  ...(Array.isArray(workflow.acceptanceCriteria) ? { acceptanceCriteriaCount: workflow.acceptanceCriteria.length } : {}),
  ...(workflow.lastProgress === undefined ? {} : { lastProgress: capText(JSON.stringify(workflow.lastProgress), 120) })
});

const compactWorkflow = (workflow: unknown, brief: boolean) => {
  const fields = fieldsOf(workflow);
  if (isTerminal(fields)) return summarizeTerminal(fields);
  return brief && isBriefable(fields) ? briefOpen(fields) : compactOpen(fields);
};

/**
 * Fits the hook context into the budget. Degradation runs in order: terminal summaries are dropped oldest-first, then open
 * workflows without approvals are briefed. Only after both does the history get trimmed, oldest first, so messages outrank
 * open-workflow detail. Clarifications are trimmed last of all. Notices, approvals, warnings and workflows with approvals are
 * never truncated, even when they alone exceed the budget, because the model must act on them. Each trim is counted.
 */
export function boundConversationContext(result: unknown, budget = CONVERSATION_CONTEXT_BUDGET): unknown {
  if (sizeOf(result) <= budget) return result;
  const whole = record(result), context = record(whole.context ?? {});
  if (!Array.isArray(context.messages)) return result;
  const messages = context.messages, clarifications = record(context.pendingClarifications ?? {});
  const workflows = record(context.workflows ?? {}), runs = record(context.runIdToCorrelationId ?? {});
  const terminal = Object.keys(workflows).filter(id => isTerminal(fieldsOf(workflows[id])))
    .sort((a, b) => String(fieldsOf(workflows[a]).updatedAt ?? "").localeCompare(String(fieldsOf(workflows[b]).updatedAt ?? "")));
  const render = (keep: number, keptClarifications: Record<string, unknown>, dropped: number, brief: boolean) => {
    const dropIds = new Set(terminal.slice(0, dropped));
    const kept = Object.entries(workflows).filter(([id]) => !dropIds.has(id));
    const keptWorkflows = Object.fromEntries(kept.map(([id, workflow]) => [id, compactWorkflow(workflow, brief)]));
    const briefed = brief ? kept.filter(([, workflow]) => isBriefable(fieldsOf(workflow))).length : 0;
    const keptIds = new Set(Object.keys(keptWorkflows));
    // Runs are restricted only when workflows were dropped, so run lookups never point at omitted workflows.
    const keptRuns = dropped === 0 ? runs : Object.fromEntries(Object.entries(runs).filter(([, id]) => keptIds.has(String(id))));
    const messagesOmitted = messages.length - keep;
    const clarificationsOmitted = Object.keys(clarifications).length - Object.keys(keptClarifications).length;
    const runIndexOmitted = Object.keys(runs).length - Object.keys(keptRuns).length;
    return { ...whole, context: { ...context, workflows: keptWorkflows, runIdToCorrelationId: keptRuns, messages: messages.slice(messages.length - keep), pendingClarifications: keptClarifications,
      ...(dropped > 0 ? { workflowsOmitted: dropped } : {}), ...(briefed > 0 ? { workflowsBriefed: briefed } : {}), ...(runIndexOmitted > 0 ? { runIndexOmitted } : {}),
      ...(messagesOmitted > 0 ? { messagesOmitted } : {}), ...(clarificationsOmitted > 0 ? { clarificationsOmitted } : {}) } };
  };
  // Degrade workflow state first, keeping the full history whenever it fits.
  const ladder: [number, boolean][] = [...Array.from({ length: terminal.length + 1 }, (_, dropped): [number, boolean] => [dropped, false]), [terminal.length, true]];
  for (const [dropped, brief] of ladder) {
    const candidate = render(messages.length, clarifications, dropped, brief);
    if (sizeOf(candidate) <= budget) return candidate;
  }
  const dropped = terminal.length;
  // Keep as much history as fits with clarifications; drop clarifications only when history alone cannot fit.
  for (let keep = messages.length; keep >= 0; keep--) {
    const candidate = render(keep, clarifications, dropped, true);
    if (sizeOf(candidate) <= budget) return candidate;
  }
  for (let keep = messages.length; keep >= 0; keep--) {
    const candidate = render(keep, {}, dropped, true);
    if (sizeOf(candidate) <= budget) return candidate;
  }
  return render(0, {}, dropped, true);
}
