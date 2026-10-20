import { record } from "./journal.js";

/** Serialized size budget for the Conversation UserPromptSubmit context (bytes of JSON). */
export const CONVERSATION_CONTEXT_BUDGET = 8 * 1024;

const sizeOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Fits the hook context into the budget. Only conversation history and old clarifications are trimmed, oldest first;
 * notices, approvals, warnings and workflow state are never touched, even when they alone exceed the budget, because
 * the model must act on them. Each trim is counted so the model knows history is incomplete.
 */
export function boundConversationContext(result: unknown, budget = CONVERSATION_CONTEXT_BUDGET): unknown {
  if (sizeOf(result) <= budget) return result;
  const whole = record(result), context = record(whole.context ?? {});
  if (!Array.isArray(context.messages)) return result;
  const messages = context.messages, clarifications = record(context.pendingClarifications ?? {});
  const render = (keep: number, keptClarifications: Record<string, unknown>) => {
    const messagesOmitted = messages.length - keep;
    const clarificationsOmitted = Object.keys(clarifications).length - Object.keys(keptClarifications).length;
    return { ...whole, context: { ...context, messages: messages.slice(messages.length - keep), pendingClarifications: keptClarifications,
      ...(messagesOmitted > 0 ? { messagesOmitted } : {}), ...(clarificationsOmitted > 0 ? { clarificationsOmitted } : {}) } };
  };
  // Keep as much history as fits with clarifications; drop clarifications only when history alone cannot fit.
  for (let keep = messages.length; keep >= 0; keep--) {
    const candidate = render(keep, clarifications);
    if (sizeOf(candidate) <= budget) return candidate;
  }
  for (let keep = messages.length; keep >= 0; keep--) {
    const candidate = render(keep, {});
    if (sizeOf(candidate) <= budget) return candidate;
  }
  return render(0, {});
}
