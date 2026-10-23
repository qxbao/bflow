import { z } from "zod";
import { IsoDateTimeSchema, RoleMessageSchema } from "@bflow/contracts";

export const NativeDiagnosticFenceAuthoritySchema = z.object({
  operationId: z.string().min(1).max(200), sessionId: z.string().min(1),
  userMessageId: z.string().min(1), userId: z.string().min(1)
}).strict();
export type NativeDiagnosticFenceAuthority = z.infer<typeof NativeDiagnosticFenceAuthoritySchema>;

/** A cancellation tombstone, never an ACK, refusal receipt or task result. Scope is deliberately narrow. */
export const NativeDiagnosticFenceSchema = NativeDiagnosticFenceAuthoritySchema.extend({
  message: RoleMessageSchema, decidedAt: IsoDateTimeSchema,
  disposition: z.literal("fenced_without_delivery_claim")
}).strict().superRefine((value, context) => {
  const message = value.message, payload = message.payload;
  if (message.sender.role !== "coordinator" || message.recipient.role !== "conversation" || message.type !== "task.status" ||
      !message.sender.agent_id || !message.sender.pane_id ||
      payload === null || typeof payload !== "object" || Array.isArray(payload) || payload.status !== "blocked" ||
      typeof payload.summary !== "string" || !payload.summary.trim())
    context.addIssue({ code: "custom", message: "Only a stale blocked Coordinator diagnostic to Conversation can be fenced" });
});
export type NativeDiagnosticFence = z.infer<typeof NativeDiagnosticFenceSchema>;

export function parseNativeDiagnosticFenceCommand(content: string): string | undefined {
  return /^fence diagnostic ([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/u.exec(content.trim())?.[1];
}

export function parsePolicyPhaseRetirementCommand(content: string): string | undefined {
  return /^retire policy phase ([A-Za-z0-9][A-Za-z0-9._:-]{0,199})$/u.exec(content.trim())?.[1];
}
