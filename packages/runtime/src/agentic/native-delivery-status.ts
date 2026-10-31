import { AgentBindingReceiptSchema, RoleMessageSchema, type RoleMessage } from "@bflow/contracts";
import { z } from "zod";
import { digest, textField } from "./journal.js";
import { parseNativeRoleMessage } from "./role-tool-schema.js";
import type { HostReceiptJournal } from "./host-receipts.js";

/** Recheck owned ACK evidence around a stale timeout report; never send the envelope again. */
export async function reportNativeDeliveryUncertainty(
  receipts: Pick<HostReceiptJournal, "nativeDelivery"> & Partial<Pick<HostReceiptJournal, "nativeRejection" | "recordNativeAcknowledgement">>,
  runtime: { reportUncertainNativeDelivery(message: RoleMessage, operationId: string, reason: string): Promise<void>;
    reconcileNativeDelivery(messageId: string): Promise<boolean>;
    nativeDeliveryInbox?(): Promise<unknown> },
  message: RoleMessage, operationId: string, reason: string
): Promise<boolean> {
  const acknowledged = async () => {
    const delivery = await receipts.nativeDelivery(operationId);
    if (!delivery || nativeMessageFingerprint(delivery.message) !== nativeMessageFingerprint(message))
      throw new Error("Native uncertainty report does not match its immutable intent");
    if (delivery.status === "acknowledged") {
      await runtime.reconcileNativeDelivery(delivery.message.message_id);
      return true;
    }
    if (typeof runtime.nativeDeliveryInbox === "function" && typeof receipts.nativeRejection === "function" &&
        typeof receipts.recordNativeAcknowledgement === "function") {
      const inspection = await inspectNativeDelivery(
        { nativeDelivery: async () => delivery, nativeRejection: id => receipts.nativeRejection!(id) },
        operationId,
        await runtime.nativeDeliveryInbox()
      );
      if (inspection.delivery === "applied") {
        await receipts.recordNativeAcknowledgement(delivery.message);
        await runtime.reconcileNativeDelivery(delivery.message.message_id);
        return true;
      }
    }
    return false;
  };
  if (await acknowledged()) return true;
  await runtime.reportUncertainNativeDelivery(message, operationId, reason);
  // The ACK callback can settle Runtime after our first read but before the report recreates its pending intent.
  return acknowledged();
}

/** Time an unacknowledged native intent must stay unacknowledged before it is reported as uncertain. */
export const NATIVE_ACK_GRACE_MS = 60_000;

/** Native ACK grace; `BFLOW_NATIVE_ACK_GRACE_MS` overrides it within 5 s–10 min. */
export function nativeAckGraceMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 5_000 && parsed <= 600_000 ? parsed : NATIVE_ACK_GRACE_MS;
}

/**
 * Debounces native delivery uncertainty. The intent is written before the transport side effect and the ACK arrives a
 * moment later, so a watchdog tick can observe an intent that is merely in flight. Only an intent observed unacknowledged
 * continuously for the whole grace period is due for an uncertainty report. Nothing is resent either way.
 */
export class NativeAckGrace {
  private readonly firstSeen = new Map<string, number>();
  constructor(private readonly graceMs = NATIVE_ACK_GRACE_MS) {
    if (!Number.isFinite(graceMs) || graceMs <= 0) throw new Error("Native ACK grace must be a positive number of milliseconds");
  }
  /** `pending` are the currently unacknowledged operation IDs; returns those whose grace has elapsed. */
  due(pending: readonly string[], now: number): string[] {
    const current = new Set(pending);
    for (const operationId of this.firstSeen.keys()) if (!current.has(operationId)) this.firstSeen.delete(operationId);
    const due: string[] = [];
    for (const operationId of current) {
      const first = this.firstSeen.get(operationId);
      if (first === undefined) this.firstSeen.set(operationId, now);
      else if (now - first >= this.graceMs) due.push(operationId);
    }
    return due;
  }
}

export const NativeIssueSchema = z.object({ path: z.string(), code: z.string(), message: z.string() }).strict();
/** Only the trusted native binding signature is replaced in flight. All other fields remain immutable. */
export function nativeMessageFingerprint(message: RoleMessage): string {
  return digest(message.type === "execution.receipt"
    ? { ...message, payload: { ...AgentBindingReceiptSchema.parse(message.payload), signature: undefined } } : message);
}
export function nativeEnvelopeIssues(message: RoleMessage): z.infer<typeof NativeIssueSchema>[] {
  try { parseNativeRoleMessage(message); return []; }
  catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return error.issues.map(issue => ({ path: issue.path.join("."), code: issue.code, message: issue.message }));
  }
}
/** Only a signature-verified rejection before receive() may produce this private observation. */
export const NativeRejectionSchema = z.object({ code: z.literal("native_envelope_rejected"), message: RoleMessageSchema,
  issues: z.array(NativeIssueSchema).min(1) }).strict().superRefine((value, context) => {
    const issues = nativeEnvelopeIssues(value.message);
    if (!issues.length || digest(issues) !== digest(value.issues)) context.addIssue({ code: "custom", message: "Native refusal must match the invalid envelope" });
  });

const InboxRowsSchema = z.array(z.object({ message: RoleMessageSchema, status: z.enum(["received", "applied", "rejected"]), reason: z.string().optional() }).strict());
/** Read-only diagnostics. Absence, timeout, provider done and invalid legacy fields never grant resend authority. */
export async function inspectNativeDelivery(receipts: Pick<HostReceiptJournal, "nativeDelivery" | "nativeRejection">,
  operationIdInput: string, inboxInput: unknown) {
  const operationId = textField(operationIdInput), native = await receipts.nativeDelivery(operationId);
  if (!native) return { operationId, delivery: "not_found" as const, resendAllowed: false as const };
  const message = native.message, rejection = await receipts.nativeRejection(message.message_id);
  if (rejection && nativeMessageFingerprint(rejection.message) !== nativeMessageFingerprint(message)) throw new Error("Native rejection conflicts with delivery intent");
  if (rejection && native.status === "acknowledged") throw new Error("Native delivery has conflicting ACK and rejection evidence");
  const rows = InboxRowsSchema.parse(inboxInput).filter(row => row.message.message_id === message.message_id ||
    message.idempotency_key !== undefined && row.message.idempotency_key === message.idempotency_key);
  const conflict = rows.some(row => nativeMessageFingerprint(row.message) !== nativeMessageFingerprint(message));
  const inbox = conflict ? "conflicting" : rows.find(row => row.status === "applied")?.status ?? rows[0]?.status ?? "absent";
  const delivery = conflict ? "unknown_delivery" : native.status === "acknowledged" ? "acknowledged"
    : inbox === "applied" ? "applied" : inbox === "received" ? "received" : inbox === "rejected" ? "rejected_after_admission"
    : rejection ? "rejected_before_admission" : "unknown_delivery";
  if (rejection && inbox !== "absent") throw new Error("Pre-admission rejection conflicts with Runtime inbox evidence");
  return { operationId, messageId: message.message_id, ...(message.run_id ? { runId: message.run_id } : {}),
    correlationId: message.correlation_id, ...(message.causation_id ? { causationId: message.causation_id } : {}),
    senderRole: message.sender.role, recipientRole: message.recipient.role, type: message.type,
    delivery, inbox, nativeEnvelopeIssues: nativeEnvelopeIssues(message), resendAllowed: false as const,
    next: rejection ? "The original envelope was refused before admission. Correct the producer; this observation does not replay or authorize a replacement."
      : delivery === "unknown_delivery" ? "Preserve the original intent. Reconcile authoritative native receipt/inbox evidence before any retry."
      : "Delivery evidence exists; independent business acceptance and human gates still apply." };
}
