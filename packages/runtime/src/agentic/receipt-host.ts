import { sign } from "node:crypto";
import { AgentBindingReceiptSchema, receiptSigningBytes, type AgentBindingReceipt, type AgentExecutionHandle, type SubmissionCorrelation } from "@bflow/contracts";
/** Trusted native-host API only. Never expose the signing key or this function as an agent tool. */
export function createSignedBindingReceipt(input: {
  receiptId: string; issuerId: string; handle: AgentExecutionHandle; correlation: SubmissionCorrelation;
  observedAt: string; privateKey: string;
}): AgentBindingReceipt {
  const receipt = AgentBindingReceiptSchema.parse({ schemaVersion: 1, receiptId: input.receiptId, issuerId: input.issuerId,
    handle: input.handle, correlation: input.correlation, observedAt: input.observedAt,
    signature: { algorithm: "ed25519", value: Buffer.alloc(64).toString("base64") } });
  return AgentBindingReceiptSchema.parse({ ...receipt, signature: { algorithm: "ed25519",
    value: sign(null, receiptSigningBytes(receipt), input.privateKey).toString("base64") } });
}
