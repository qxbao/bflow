import { z } from "zod";
import { IsoDateTimeSchema, RoleMessageSchema } from "@bflow/contracts";

export const NativeDiagnosticFenceAuthoritySchema = z.object({
  operationId: z.string().min(1).max(200), sessionId: z.string().min(1),
  userMessageId: z.string().min(1), userId: z.string().min(1)
}).strict();
export type NativeDiagnosticFenceAuthority = z.infer<typeof NativeDiagnosticFenceAuthoritySchema>;

/** Singleton specialist roles whose retired pane's blocked report to the Coordinator can be fenced; never Developers, Runtime or Conversation. */
export const FENCEABLE_SPECIALIST_ROLES: readonly string[] = ["planner", "architect", "specifier", "reviewer", "qa", "tester", "security"];

/** A cancellation tombstone, never an ACK, refusal receipt or task result. Scope is deliberately narrow. */
export const NativeDiagnosticFenceSchema = NativeDiagnosticFenceAuthoritySchema.extend({
  message: RoleMessageSchema, decidedAt: IsoDateTimeSchema,
  disposition: z.literal("fenced_without_delivery_claim")
}).strict().superRefine((value, context) => {
  const message = value.message, payload = message.payload;
  const route = message.sender.role === "coordinator" && message.recipient.role === "conversation" ||
    FENCEABLE_SPECIALIST_ROLES.includes(message.sender.role) && message.recipient.role === "coordinator";
  if (!route || message.type !== "task.status" ||
      !message.sender.agent_id || !message.sender.pane_id ||
      payload === null || typeof payload !== "object" || Array.isArray(payload) || payload.status !== "blocked" ||
      typeof payload.summary !== "string" || !payload.summary.trim())
    context.addIssue({ code: "custom", message: "Only a stale blocked Coordinator diagnostic to Conversation, or a stale blocked specialist report to the Coordinator, can be fenced" });
});
export type NativeDiagnosticFence = z.infer<typeof NativeDiagnosticFenceSchema>;

export function parseNativeDiagnosticFenceCommand(content: string): string | undefined {
  return /^fence diagnostic ([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/u.exec(content.trim())?.[1];
}

export function parsePolicyPhaseRetirementCommand(content: string): string | undefined {
  return /^retire policy phase ([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/u.exec(content.trim())?.[1];
}

/** Exact physical command only; prose/quotes never authorize another verifier invocation. */
export function parseWorkflowReviewReplacementCommand(content: string): string | undefined {
  return /^replace workflow review ([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/u.exec(content.trim())?.[1];
}

export const BFLOW_SOS_TRIGGER = "BFLOWSOS";

/** Exact match only (`BFLOWSOS`); partial matches, surrounding prose, or different casing never trigger SOS. */
export function isBflowSosCommand(content: string): boolean {
  return content === BFLOW_SOS_TRIGGER;
}
