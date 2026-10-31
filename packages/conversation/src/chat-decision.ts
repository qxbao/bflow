import type { OperationResult } from "@bflow/contracts";
import { resolveDraftCriteria } from "./delegation-builder.js";
import type { ChatDecision, ConversationContextSnapshot, ExtractedRequirementDraft, IntentClassificationResult } from "./types.js";

const WORK_ALIAS_REGEX = /^việc\s*#([1-9]\d*)(?:\s*[:—–-].*)?$/iu;

function resolveWorkRunAlias(raw: string | undefined, context: ConversationContextSnapshot): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const match = WORK_ALIAS_REGEX.exec(trimmed);
  if (!match) return trimmed;
  return context.runShortIds?.[`việc #${match[1]}`] ?? trimmed;
}

/** Validate state references and completeness, without interpreting natural-language intent. */
export function resolveChatDecision(
  decision: ChatDecision, context: ConversationContextSnapshot
): OperationResult<IntentClassificationResult> {
  const invalid = (message: string): OperationResult<IntentClassificationResult> => ({ ok: false,
    error: { code: "validation", retryable: false, message } });
  const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
  let cancellationRunIds: string[] | undefined;
  let closeSessionClarifications = false;
  let resolvedClarificationCorrelationId: string | undefined;
  let targetCorrelationId = "targetCorrelationId" in decision ? decision.targetCorrelationId?.trim() : undefined;
  let targetRunId = resolveWorkRunAlias("targetRunId" in decision ? decision.targetRunId : undefined, context);
  let normalizedDraft: ExtractedRequirementDraft | undefined =
    "requirementDraft" in decision && decision.requirementDraft
      ? {
          ...decision.requirementDraft,
          ...(decision.requirementDraft.targetRunId !== undefined
            ? { targetRunId: resolveWorkRunAlias(decision.requirementDraft.targetRunId, context) }
            : {}),
          ...(decision.requirementDraft.targetCorrelationId !== undefined
            ? { targetCorrelationId: decision.requirementDraft.targetCorrelationId.trim() }
            : {})
        }
      : undefined;

  if (decision.intent === "workflow_request") {
    const draft = normalizedDraft!;
    const criteria = resolveDraftCriteria(draft);
    if (!criteria.ok) return invalid(criteria.error.message);
    if (!draft.scopeDefined || criteria.value.length === 0 ||
        criteria.value.some(criterion => !criterion.description.trim())) {
      return invalid("A workflow decision requires defined scope and non-empty acceptance criteria");
    }
    if ((targetCorrelationId && draft.targetCorrelationId && targetCorrelationId !== draft.targetCorrelationId) ||
        (targetRunId && draft.targetRunId && targetRunId !== draft.targetRunId)) {
      return invalid("Conflicting workflow targets in the Chat decision");
    }
    targetCorrelationId ??= draft.targetCorrelationId;
    targetRunId ??= draft.targetRunId;
    if (draft.isRequirementChange) {
      if (targetCorrelationId && context.pendingClarifications[targetCorrelationId] && targetRunId) {
        resolvedClarificationCorrelationId = targetCorrelationId;
        targetCorrelationId = undefined;
      }
      const workflow = targetRunId
        ? Object.values(context.workflows).find(item => item.runId === targetRunId)
        : targetCorrelationId
          ? context.workflows[targetCorrelationId]
          : undefined;
      if (!workflow || terminal(workflow.sdlcStatus) || !workflow.runId ||
          (targetRunId && workflow.runId !== targetRunId) ||
          (targetCorrelationId && targetCorrelationId !== workflow.correlationId)) {
        return invalid("A requirement change must identify one existing unfinished workflow");
      }
      targetRunId = workflow.runId;
      targetCorrelationId = workflow.correlationId;
      normalizedDraft = { ...draft, targetRunId, targetCorrelationId };
    } else if (targetRunId || (targetCorrelationId && !context.pendingClarifications[targetCorrelationId])) {
      return invalid("A new workflow may only continue a known pending clarification; existing runs require an explicit requirement change");
    }
  } else if (decision.intent === "clarify") {
    const draftTargetRunId = normalizedDraft?.targetRunId;
    const draftTargetCorrId = normalizedDraft?.targetCorrelationId;
    if ((targetCorrelationId && draftTargetCorrId && targetCorrelationId !== draftTargetCorrId) ||
        (targetRunId && draftTargetRunId && targetRunId !== draftTargetRunId)) {
      return invalid("Conflicting workflow targets in the Chat decision");
    }
    targetCorrelationId ??= draftTargetCorrId;
    targetRunId ??= draftTargetRunId;
    if (targetCorrelationId && context.pendingClarifications[targetCorrelationId]) {
      if (targetRunId) {
        const wf = Object.values(context.workflows).find(item => item.runId === targetRunId);
        if (!wf || terminal(wf.sdlcStatus)) {
          return invalid("Unknown pending clarification in the Chat decision");
        }
        targetRunId = undefined;
      }
    } else if (targetCorrelationId || targetRunId) {
      const byCorr = targetCorrelationId ? context.workflows[targetCorrelationId] : undefined;
      const byRun = targetRunId ? Object.values(context.workflows).find(item => item.runId === targetRunId) : undefined;
      if ((targetCorrelationId && (!byCorr || terminal(byCorr.sdlcStatus))) ||
          (targetRunId && (!byRun || terminal(byRun.sdlcStatus))) ||
          (byCorr && byRun && byCorr.correlationId !== byRun.correlationId)) {
        return invalid("Unknown pending clarification in the Chat decision");
      }
      // Allocate a fresh pendingClarification correlation ID so it never overwrites context.workflows[corrId]
      targetCorrelationId = undefined;
      targetRunId = undefined;
      if (normalizedDraft) {
        const { targetCorrelationId: _c, targetRunId: _r, ...restDraft } = normalizedDraft;
        normalizedDraft = restDraft;
      }
    }
  } else if (decision.intent === "cancellation_request") {
    const cancel = decision.cancellationInput;
    const known = [...Object.values(context.workflows), ...Object.values(context.runtimeCancellationTargets ?? {}).map(run => ({
      runId: run.runId, sessionId: run.delegation.sessionId, correlationId: run.delegation.correlationId }))];
    if ("runId" in cancel) {
      cancellationRunIds = [resolveWorkRunAlias(cancel.runId, context)!];
    } else if ("runIds" in cancel) {
      const resolvedIds = cancel.runIds.map(id => resolveWorkRunAlias(id, context)!);
      if (new Set(resolvedIds).size !== resolvedIds.length) {
        return invalid("Duplicate cancellation run IDs");
      }
      cancellationRunIds = resolvedIds;
    } else {
      closeSessionClarifications = true;
      cancellationRunIds = [...new Set(known.filter(item => item.sessionId === context.session.sessionId).map(item => item.runId).filter((id): id is string => id !== undefined))];
      if (cancellationRunIds.length === 0 && Object.keys(context.pendingClarifications).length === 0) {
        return invalid("Cancellation must identify existing workflows in the current session");
      }
      if (targetRunId && !known.some(item => item.sessionId === context.session.sessionId && item.runId === targetRunId)) {
        return invalid("Cancellation must identify existing workflows in the current session");
      }
      if (targetCorrelationId &&
          !known.some(item => item.sessionId === context.session.sessionId && item.correlationId === targetCorrelationId) &&
          !context.pendingClarifications[targetCorrelationId]) {
        return invalid("Cancellation must identify existing workflows in the current session");
      }
    }
    if (!closeSessionClarifications) {
      for (const runId of cancellationRunIds) {
        const workflow = known.find(item => item.runId === runId);
        if (!workflow || workflow.sessionId !== context.session.sessionId || (targetRunId && (cancellationRunIds.length !== 1 || targetRunId !== workflow.runId)) ||
            (targetCorrelationId && (cancellationRunIds.length !== 1 || targetCorrelationId !== workflow.correlationId))) {
          return invalid("Cancellation must identify existing workflows in the current session");
        }
      }
    } else {
      for (const runId of cancellationRunIds) {
        const workflow = known.find(item => item.runId === runId && item.sessionId === context.session.sessionId);
        if (!workflow) {
          return invalid("Cancellation must identify existing workflows in the current session");
        }
      }
    }
    if (cancellationRunIds.length === 1) {
      targetRunId = cancellationRunIds[0];
      targetCorrelationId = known.find(item => item.runId === targetRunId)!.correlationId;
    } else if (closeSessionClarifications) {
      targetRunId = undefined;
      if (targetCorrelationId && !context.pendingClarifications[targetCorrelationId]) {
        targetCorrelationId = undefined;
      }
    }
  } else if (decision.intent === "status_query" && (targetRunId || targetCorrelationId)) {
    const workflow = targetCorrelationId ? context.workflows[targetCorrelationId] :
      Object.values(context.workflows).find(item => item.runId === targetRunId);
    if (!workflow || (targetRunId && targetRunId !== workflow.runId)) return invalid("Unknown status-query workflow");
    targetCorrelationId = workflow.correlationId;
    targetRunId = workflow.runId;
  }

  return { ok: true, value: {
    confidence: 1, rationale: "Conversation Agent supplied a structured intent decision.", clarifyingQuestions: [],
    intent: decision.intent,
    ...(decision.intent === "workflow_request" || (decision.intent === "clarify" && normalizedDraft)
      ? { requirementDraft: normalizedDraft! } : {}),
    ...(decision.intent === "clarify" ? { clarifyingQuestions: decision.clarifyingQuestions } : {}),
    ...(decision.intent === "conversation_only" ? { directReply: decision.directReply } : {}),
    ...(decision.intent === "cancellation_request" ? { cancellationInput: {
      runIds: cancellationRunIds!,
      ...("taskId" in decision.cancellationInput && decision.cancellationInput.taskId ? { taskId: decision.cancellationInput.taskId } : {}),
      ...(decision.cancellationInput.reason ? { reason: decision.cancellationInput.reason } : {}),
      ...(closeSessionClarifications ? { closeSessionClarifications: true } : {})
    } } : {}),
    ...(targetCorrelationId ? { targetCorrelationId } : {}),
    ...(targetRunId ? { targetRunId } : {}),
    ...(resolvedClarificationCorrelationId ? { resolvedClarificationCorrelationId } : {})
  } };
}
