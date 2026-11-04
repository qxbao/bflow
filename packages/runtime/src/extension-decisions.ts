import { ApprovalDecisionSchema, ApprovalRequestSchema, DomainEventSchema, canonicalReceiptJson, type ApprovalDecision,
  type ApprovalRequest, type RunStore } from "@bflow/contracts";

/** Shape only, never authority: callers authenticate the unchanged receipt before applying it. Web already pins the exact request version/evidence. */
export function isPlainWebExtensionDecision(decision: ApprovalDecision): boolean {
  return decision.metadata === undefined && /^web-decision-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(decision.idempotencyKey);
}

/** Recover the actual immutable request from authoritative events, never reconstruct an approval from a status projection. */
export async function extensionDecisionRequest(store: RunStore, input: ApprovalDecision, scope: string, now: string): Promise<ApprovalRequest> {
  const decision = ApprovalDecisionSchema.parse(input); let cursor: string | undefined; let request: ApprovalRequest | undefined;
  do {
    const page = await store.readEvents(decision.runId, { limit: 100, ...(cursor ? { cursor } : {}) });
    if (!page.ok) throw new Error("Cannot read authoritative extension approval request");
    for (const raw of page.value.items) {
      const event = DomainEventSchema.parse(raw);
      if (event.type === "approval.requested") {
        const candidate = ApprovalRequestSchema.parse(event.payload);
        if (candidate.approvalId === decision.approvalId) request = candidate;
      }
    }
    cursor = page.value.nextCursor;
  } while (cursor);
  if (!request || request.runId !== decision.runId || request.sessionId !== decision.sessionId ||
      request.metadata?.approvalScope !== scope || !isPlainWebExtensionDecision(decision) && decision.metadata?.approvalScope !== scope ||
      request.revision !== decision.revision || request.generation !== decision.generation || canonicalReceiptJson(request.target) !== canonicalReceiptJson(decision.target))
    throw new Error("Extension decision session/scope does not match its actual request");
  if (Date.parse(decision.decidedAt) < Date.parse(request.requestedAt) || Date.parse(decision.decidedAt) > Date.parse(now) ||
      request.expiresAt !== undefined && Date.parse(now) >= Date.parse(request.expiresAt))
    throw new Error("Extension human decision is stale or outside its request time");
  // Core remains authoritative for target/revision/generation compatibility and legal transitions.
  return request;
}
