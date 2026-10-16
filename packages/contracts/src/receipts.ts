import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { AgentExecutionHandleSchema, SubmissionCorrelationSchema } from "./agent.js";
import { ArtifactReferenceSchema } from "./artifact.js";
import { IdentifierSchema, IdempotencyKeySchema, IsoDateTimeSchema } from "./common.js";

export const AgentBindingReceiptSchema = z.object({
  schemaVersion: z.literal(1), receiptId: IdentifierSchema, issuerId: IdentifierSchema,
  handle: AgentExecutionHandleSchema,
  correlation: SubmissionCorrelationSchema.refine(c => c.verified && c.provenance !== "orchestrator", "Receipt requires verified remote/transport correlation"),
  observedAt: IsoDateTimeSchema,
  signature: z.object({ algorithm: z.literal("ed25519"), value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict()
}).strict();
export type AgentBindingReceipt = z.infer<typeof AgentBindingReceiptSchema>;

export function canonicalReceiptJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonicalReceiptJson).join(",")}]`;
  if (input !== null && typeof input === "object") return `{${Object.entries(input).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalReceiptJson(v)}`).join(",")}}`;
  return JSON.stringify(input) ?? "null";
}
export function receiptSigningBytes(receipt: AgentBindingReceipt): Uint8Array {
  const { signature: _signature, ...body } = AgentBindingReceiptSchema.parse(receipt);
  return Buffer.from(canonicalReceiptJson(body));
}
export function authenticateBindingReceipt(receipt: AgentBindingReceipt, publicKey: string): boolean {
  try {
    const key = createPublicKey(publicKey);
    return key.asymmetricKeyType === "ed25519" && verify(null, receiptSigningBytes(receipt), key, Buffer.from(receipt.signature.value, "base64"));
  } catch { return false; }
}
export const AgentBindingVerificationSchema = z.object({
  receipt: AgentBindingReceiptSchema, evidence: ArtifactReferenceSchema, verifiedAt: IsoDateTimeSchema
}).strict().superRefine((proof, ctx) => {
  const ref = proof.evidence, handle = proof.receipt.handle;
  if (!handle.target.paneId || !handle.target.session || handle.target.transport !== "herdr")
    ctx.addIssue({ code: "custom", message: "Authenticated Herdr receipt requires an explicit pane and agent session" });
  const bytes = Buffer.from(canonicalReceiptJson(proof.receipt));
  if (ref.runId !== handle.runId || ref.taskId !== handle.taskId || ref.kind !== "report" || ref.mediaType !== "application/json" ||
      createHash(ref.checksum.algorithm).update(bytes).digest("hex") !== ref.checksum.value ||
      ref.sizeBytes !== bytes.length) ctx.addIssue({ code: "custom", message: "Receipt evidence must identify the exact signed receipt bytes and execution owner" });
  if (Date.parse(proof.receipt.observedAt) < Date.parse(handle.acceptedAt) || Date.parse(proof.verifiedAt) < Date.parse(proof.receipt.observedAt))
    ctx.addIssue({ code: "custom", message: "Receipt observation must follow acceptance and precede verification" });
});
export type AgentBindingVerification = z.infer<typeof AgentBindingVerificationSchema>;
export const VerifyAgentBindingCommandSchema = z.object({
  runId: IdentifierSchema, taskId: IdentifierSchema, expectedVersion: z.number().int().nonnegative(),
  verification: AgentBindingVerificationSchema, occurredAt: IsoDateTimeSchema, idempotencyKey: IdempotencyKeySchema
}).strict().superRefine((command, ctx) => {
  if (command.runId !== command.verification.receipt.handle.runId || command.taskId !== command.verification.receipt.handle.taskId ||
      command.occurredAt !== command.verification.verifiedAt) ctx.addIssue({ code: "custom", message: "Binding verification command ownership/time mismatch" });
});
export type VerifyAgentBindingCommand = z.infer<typeof VerifyAgentBindingCommandSchema>;
