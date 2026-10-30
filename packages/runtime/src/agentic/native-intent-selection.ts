import { z } from "zod";
import { IdentifierSchema, RoleMessageSchema, type RoleMessage } from "@bflow/contracts";
import { digest } from "./journal.js";

const NativeIntentReferenceSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("bflow_native_intent_ref"),
  operationId: z.string().min(1).max(1024), messageId: IdentifierSchema,
  messageDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
/** Herdr launches actions with the context in an environment entry. Keep that entry below execve limits. */
export function encodeNativePluginSelection(operationId: string, input: unknown): string {
  const message = RoleMessageSchema.parse(input), inline = JSON.stringify(message);
  if (Buffer.byteLength(inline, "utf8") <= 32768) return inline;
  return JSON.stringify(NativeIntentReferenceSchema.parse({ schemaVersion: 1, kind: "bflow_native_intent_ref",
    operationId, messageId: message.message_id, messageDigest: digest(message) }));
}
/** A reference never names a file or supplies message bytes. Only this host's validated private intent may resolve it. */
export async function resolveNativePluginSelection(selection: string,
  readIntent: (operationId: string) => Promise<{ message: unknown; status: "unknown_delivery" | "acknowledged"; rejected?: boolean } | undefined>): Promise<RoleMessage> {
  const input: unknown = JSON.parse(selection);
  if (input === null || typeof input !== "object" || !("kind" in input) || input.kind !== "bflow_native_intent_ref")
    return RoleMessageSchema.parse(input);
  const reference = NativeIntentReferenceSchema.parse(input), delivery = await readIntent(reference.operationId);
  if (!delivery || delivery.status !== "unknown_delivery" || delivery.rejected)
    throw new Error("Native intent reference is missing, acknowledged or refused; reconcile without replay");
  const message = RoleMessageSchema.parse(delivery.message);
  if (message.message_id !== reference.messageId || digest(message) !== reference.messageDigest)
    throw new Error("Native intent reference differs from the immutable recorded message");
  return message;
}
