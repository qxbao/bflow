import type { OperationResult } from "@bflow/contracts";
import type { ChatDecision, ConversationContextSnapshot, IntentClassificationResult } from "./types.js";

/** Validate state references and completeness, without interpreting natural-language intent. */
export function resolveChatDecision(
  decision: ChatDecision, context: ConversationContextSnapshot
): OperationResult<IntentClassificationResult> {
  const invalid = (message: string): OperationResult<IntentClassificationResult> => ({ ok: false,
    error: { code: "validation", retryable: false, message } });
  const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);
  let targetCorrelationId = "targetCorrelationId" in decision ? decision.targetCorrelationId : undefined;
  let targetRunId = "targetRunId" in decision ? decision.targetRunId : undefined;

  if (decision.intent === "workflow_request") {
    const draft = decision.requirementDraft;
    if (!draft.scopeDefined || draft.acceptanceCriteriaDescriptions.length === 0 ||
        draft.acceptanceCriteriaDescriptions.some(description => !description.trim())) {
      return invalid("A workflow decision requires defined scope and non-empty acceptance criteria");
    }
    if ((targetCorrelationId && draft.targetCorrelationId && targetCorrelationId !== draft.targetCorrelationId) ||
        (targetRunId && draft.targetRunId && targetRunId !== draft.targetRunId)) {
      return invalid("Conflicting workflow targets in the Chat decision");
    }
    targetCorrelationId ??= draft.targetCorrelationId;
    targetRunId ??= draft.targetRunId;
    if (draft.isRequirementChange) {
      const workflow = targetRunId ? Object.values(context.workflows).find(item => item.runId === targetRunId) : undefined;
      if (!workflow || terminal(workflow.sdlcStatus) || (targetCorrelationId && targetCorrelationId !== workflow.correlationId)) {
        return invalid("A requirement change must identify one existing unfinished workflow");
      }
      targetCorrelationId = workflow.correlationId;
    } else if (targetRunId || (targetCorrelationId && !context.pendingClarifications[targetCorrelationId])) {
      return invalid("A new workflow may only continue a known pending clarification; existing runs require an explicit requirement change");
    }
  } else if (decision.intent === "clarify") {
    if (targetCorrelationId && !context.pendingClarifications[targetCorrelationId]) {
      return invalid("Unknown pending clarification in the Chat decision");
    }
  } else if (decision.intent === "cancellation_request") {
    const workflow = Object.values(context.workflows).find(item => item.runId === decision.cancellationInput.runId);
    if (!workflow || terminal(workflow.sdlcStatus) || (targetRunId && targetRunId !== workflow.runId) ||
        (targetCorrelationId && targetCorrelationId !== workflow.correlationId)) {
      return invalid("Cancellation must identify one existing unfinished workflow");
    }
    targetRunId = workflow.runId;
    targetCorrelationId = workflow.correlationId;
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
    ...(decision.intent === "workflow_request" || (decision.intent === "clarify" && decision.requirementDraft)
      ? { requirementDraft: decision.requirementDraft! } : {}),
    ...(decision.intent === "clarify" ? { clarifyingQuestions: decision.clarifyingQuestions } : {}),
    ...(decision.intent === "conversation_only" ? { directReply: decision.directReply } : {}),
    ...(decision.intent === "cancellation_request" ? { cancellationInput: {
      runId: decision.cancellationInput.runId,
      ...(decision.cancellationInput.taskId ? { taskId: decision.cancellationInput.taskId } : {}),
      ...(decision.cancellationInput.reason ? { reason: decision.cancellationInput.reason } : {})
    } } : {}),
    ...(targetCorrelationId ? { targetCorrelationId } : {}),
    ...(targetRunId ? { targetRunId } : {})
  } };
}
