import { RoleMessageSchema, type JsonValue } from "@bflow/contracts";
import { record } from "../agentic/journal.js";
import type { WebOperationStore } from "./operation-store.js";

const object = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? record(value) : {};

/** Owner startup only, before intake: the prior daemon is gone and queueHerdr durably
 * enqueues cancellation before any cancellation effect. Absence from its retained
 * journal proves this command never crossed that boundary. Never replay a mutation.
 */
export async function recoverUnqueuedWebCancellations(store: WebOperationStore, snapshot: JsonValue, now: string): Promise<string[]> {
  const state = object(snapshot);
  if (typeof state.repository !== "string" || !state.repository || !Array.isArray(state.runs) || !Array.isArray(state.outbound) || !Array.isArray(state.inbox) ||
      !Array.isArray(state.pendingCore) || state.pendingCore.length) return [];
  const parsed = [...state.outbound, ...state.inbox].map(item => RoleMessageSchema.safeParse(object(item).message));
  if (parsed.some(message => !message.success)) return []; // Incomplete projection is never negative proof.
  const messages = parsed.flatMap(message => message.success ? [message.data] : []);
  const recovered: string[] = [];
  for (const receipt of await store.records()) {
    const { command, principal } = receipt.payload;
    if (command.kind !== "cancel" || receipt.repository !== state.repository) continue;
    const run = state.runs.map(object).find(run => run.runId === command.runId);
    const native = run?.nativeDeliveries ?? [];
    if (!run || run.cancelled || ["cancelled", "completed", "failed"].includes(String(run.status)) ||
        !Array.isArray(native) || native.length) continue;
    const messageId = `web-delegation-${command.commandId}`, key = `web-cancel-${command.commandId}`;
    if (messages.some(message => message.message_id === messageId || message.idempotency_key === key ||
        object(object(message.payload).metadata).userInteractionCommandId === command.commandId)) continue;
    const current = await store.read(principal.principalId, command.commandId);
    if (!current || current.state !== "reconciliation_required" ||
        !await store.hasDispatchIntent(principal.principalId, command.commandId)) continue;
    // settle also requires the immutable running marker. Accepted-only commands stay uncertain.
    await store.settle(principal.principalId, command.commandId, { ...current, state: "failed", updatedAt: now,
      error: { apiVersion: 1, code: "operation_not_allowed", retryable: false, operationId: command.commandId,
        correlationId: command.commandId, message: "Cancellation was not enqueued before the host stopped; submit a new cancellation request." } });
    recovered.push(command.commandId);
  }
  return recovered;
}
