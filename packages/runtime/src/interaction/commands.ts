import { OperationResultSchema, WebCommandSchema, WebRunViewSchema, WebProjectSessionSchema, WebOperationSchema,
  ApprovalDecisionSchema, RoleMessageSchema, DelegationRequestSchema, CancellationRequestSchema, WebOperationResultSchema, type WebCommand, type WebRunView, type WebOperation, type WebOperationResult,
  type OperationResult, type ContractError } from "@bflow/contracts";
import { canonicalWebJson, type WebPrincipal } from "@bflow/contracts/web-host";
import { WebInteractionAuthority } from "./authority.js";
import { WebOperationStore } from "./operation-store.js";
import { record, digest } from "../agentic/journal.js";
import { z } from "zod";
import type { ApprovalDecision } from "@bflow/contracts";

const AdmissionResult = OperationResultSchema(WebOperationResultSchema);
const EffectRun = z.object({ decision: ApprovalDecisionSchema.optional(),
  userDecisions: z.record(z.object({ decision: ApprovalDecisionSchema.optional() }).passthrough()).optional(),
  prototype: z.object({ approvals: z.array(z.object({ decision: ApprovalDecisionSchema.optional() }).passthrough()) }).passthrough().optional(),
}).passthrough();
/** Private Runtime snapshot fields; each effect still uses the exported receipt schema. */
export function structuredDecisionEffects(input: unknown): ApprovalDecision[] {
  if (input === undefined) return [];
  const run = EffectRun.parse(input);
  return [run.decision, ...Object.values(run.userDecisions ?? {}).map(entry => entry.decision),
    ...(run.prototype?.approvals ?? []).map(entry => entry.decision)].filter((entry): entry is ApprovalDecision => entry !== undefined);
}
/** Both successful effects and definitive rejection receipts survive response
 * loss. Queued approval admission alone does not prove its Runtime effect. */
export async function observeStructuredDecision(command: Extract<WebCommand, { kind: "answer_decision" }>, cached: unknown | undefined,
  inbox: readonly unknown[], readRun: (runId: string) => Promise<unknown>, effectDecisions: readonly unknown[] = []): Promise<OperationResult<WebOperationResult> | undefined> {
  if (cached !== undefined) {
    const result = AdmissionResult.parse(cached);
    if (!result.ok) return result;
  }
  const matchesDecision = (input: unknown) => {
    const decision = ApprovalDecisionSchema.safeParse(input);
    return decision.success && decision.data.idempotencyKey === `web-decision-${command.commandId}` && decision.data.runId === command.runId &&
      decision.data.approvalId === command.decisionId && decision.data.revision === command.expectedVersion.revision &&
      decision.data.generation === command.expectedVersion.generation && digest(decision.data.target) === digest(command.expectedVersion.target) &&
      decision.data.decision === command.outcome;
  };
  let rejected = false;
  const applied = effectDecisions.some(matchesDecision) || inbox.some(raw => {
    const entry = record(raw), parsed = RoleMessageSchema.safeParse(entry.message);
    if (!parsed.success || parsed.data.type !== "approval.decision" || parsed.data.run_id !== command.runId) return false;
    const matches = matchesDecision(parsed.data.payload);
    if (matches && entry.status === "rejected") rejected = true;
    return matches && entry.status === "applied";
  });
  if (!applied && rejected) return failure("stale_version", command.commandId);
  const view = WebRunViewSchema.parse(await readRun(command.runId));
  if (view.runId !== command.runId) throw new Error("Decision run scope mismatch");
  if (!applied) {
    if (["completed", "failed", "cancelled"].includes(view.sdlcStatus) || view.continuedAsRunId)
      return failure("stale_version", command.commandId);
    return undefined;
  }
  return { ok: true, value: { kind: "interaction", runId: view.runId, currentRunId: view.currentRunId,
    ...(view.continuedAsRunId ? { continuedAsRunId: view.continuedAsRunId } : {}) } };
}
/** Recover an admission from its original immutable Runtime outbox identity,
 * including after a later revision replaced the current delegation. Delivery
 * can remain unknown: observing local admission does not resend remote work. */
export async function observeStructuredAdmission(command: WebCommand, outbound: readonly unknown[], readRun: (runId: string) => Promise<unknown>)
  : Promise<OperationResult<WebOperationResult> | undefined> {
  if (command.kind === "answer_decision") return undefined;
  let runId: string | undefined;
  for (const raw of outbound) {
    const parsed = RoleMessageSchema.safeParse(record(raw).message);
    if (!parsed.success) continue;
    const message = parsed.data;
    if (command.kind === "resume") {
      const payload = message.payload !== null && typeof message.payload === "object" && !Array.isArray(message.payload) ? message.payload : {};
      if (message.sender.role === "runtime" && message.recipient.role === "coordinator" && message.type === "task.status" &&
        message.run_id === command.runId && payload.kind === "resume_run" && payload.webCommandId === command.commandId)
        runId = command.runId;
    } else {
      if (message.sender.role !== "conversation" || message.recipient.role !== "coordinator" || message.type !== "delegation.request" ||
        message.message_id !== `web-delegation-${command.commandId}`) continue;
      const payload = DelegationRequestSchema.safeParse(message.payload);
      if (!payload.success || payload.data.messageId !== message.message_id || payload.data.metadata?.userInteractionCommandId !== command.commandId ||
        payload.data.runId !== message.run_id || !message.run_id || ("runId" in command && command.runId !== undefined && command.runId !== message.run_id)) continue;
      if (command.kind === "cancel") {
        const cancellation = CancellationRequestSchema.safeParse(payload.data.metadata?.cancellationRequest);
        if (payload.data.metadata?.action !== "cancel" || !cancellation.success || cancellation.data.runId !== command.runId ||
          cancellation.data.requestedBy !== "conversation" || cancellation.data.reason !== command.reason) continue;
      } else if (payload.data.metadata?.action === "cancel") continue;
      runId = message.run_id;
    }
    if (runId) break;
  }
  if (!runId) return undefined;
  const view = WebRunViewSchema.parse(await readRun(runId));
  if (view.runId !== runId) throw new Error("Admission run scope mismatch");
  return { ok: true, value: { kind: "interaction", runId, currentRunId: view.currentRunId,
    ...(view.continuedAsRunId ? { continuedAsRunId: view.continuedAsRunId } : {}) } };
}
type Reason = "forbidden" | "invalid_request" | "stale_version" | "operation_not_allowed" | "operation_conflict" | "unavailable";
class Refusal extends Error { constructor(readonly reason: Reason) { super(reason); } }
function failure(reason: Reason, operationId?: string): OperationResult<never> {
  const error: ContractError = reason === "unavailable"
    ? { code: "transport_unavailable", retryable: true, message: "Activated Conversation/Coordinator host is unavailable.", details: { reason } }
    : ["stale_version", "operation_conflict"].includes(reason)
      ? { code: "conflict", retryable: true, message: "Interaction conflicts with current authority; review the exact current version.", details: { reason, ...(operationId ? { operationId } : {}) } }
      : { code: "validation", retryable: false, message: "Interaction is not allowed for this scope or state.", details: { reason } };
  return { ok: false, error };
}
export interface StructuredCommandPorts {
  authority: WebInteractionAuthority; store: WebOperationStore;
  ready(): boolean; conversationSessionId(): string;
  run(runId: string): Promise<unknown>; session(): Promise<unknown>;
  admit(command: WebCommand, principal: WebPrincipal, acceptedAt: string): Promise<unknown>;
  /** Observation only; never dispatch an unresolved command. */
  reconcile(command: WebCommand, principal: WebPrincipal): Promise<unknown | undefined>;
}
/** Host calls this under the same serialized user boundary as native intake.
 * Conversation owns admission; this adapter never creates a delegation itself. */
export class HostStructuredCommands {
  constructor(readonly ports: StructuredCommandPorts) {}
  async validate(command: WebCommand): Promise<void> {
    if (!this.ports.ready()) throw new Refusal("unavailable");
    if (command.kind === "create_request") return;
    let view: WebRunView | undefined;
    if ("runId" in command && command.runId) {
      view = WebRunViewSchema.parse(await this.ports.run(command.runId));
      if (view.runId !== command.runId || view.sessionId !== this.ports.conversationSessionId()) throw new Refusal("forbidden");
      if (["completed", "failed", "cancelled"].includes(view.sdlcStatus) || view.continuedAsRunId) throw new Refusal("stale_version");
    }
    if (command.kind === "answer_clarification") {
      const questions = view ? view.clarifications : WebProjectSessionSchema.parse(await this.ports.session())
        .pendingIntakes.find(intake => intake.intakeId === command.intakeId)?.clarifications;
      const question = questions?.find(question => question.questionId === command.questionId);
      if (!question || canonicalWebJson(question.expectedVersion) !== canonicalWebJson(command.expectedVersion)) throw new Refusal("stale_version");
      return;
    }
    if (!view) throw new Refusal("forbidden");
    const action = view.availableActions.find(action => action.kind === command.kind &&
      (command.kind !== "resume" || action.actionId === command.actionId) &&
      (command.kind !== "answer_decision" || action.actionId === command.decisionId));
    if (!action || canonicalWebJson(action.expectedVersion) !== canonicalWebJson(command.expectedVersion)) throw new Refusal("stale_version");
    if (!action.enabled) throw new Refusal("operation_not_allowed");
    if (command.kind === "answer_decision") {
      const decision = view.decisions.find(decision => decision.decisionId === command.decisionId);
      if (!decision || decision.status !== "pending" || decision.expiresAt && Date.parse(decision.expiresAt) <= Date.now() ||
        canonicalWebJson(decision.expectedVersion) !== canonicalWebJson(command.expectedVersion)) throw new Refusal("stale_version");
      if (decision.kind !== "user_decision" && command.selectedOption !== undefined ||
        command.selectedOption !== undefined && !decision.options.includes(command.selectedOption) ||
        decision.kind === "user_decision" && decision.options.length && command.outcome === "approved" && command.selectedOption === undefined)
        throw new Refusal("operation_not_allowed");
    }
  }
  async execute(input: unknown, proof: unknown): Promise<OperationResult<WebOperation>> {
    let command: WebCommand, principal: WebPrincipal;
    try { command = WebCommandSchema.parse(input); principal = this.ports.authority.verify(command, proof); }
    catch { return failure("forbidden"); }
    try {
      const previous = await this.ports.store.read(principal.principalId, command.commandId);
      if (!previous) await this.validate(command);
      const accepted = await this.ports.store.accept(command, principal, this.ports.authority);
      if (!await this.ports.store.begin(principal.principalId, command.commandId)) return this.readOperation(principal.principalId, command.commandId);
      try {
        await this.validate(command);
        const result = AdmissionResult.parse(await this.ports.admit(command, principal, accepted.updatedAt));
        if (result.ok && command.kind === "answer_decision") {
          // Admission queues a human decision; final effect/lineage awaits normal
          // Runtime/Herdr processing. Never predict a follow-up child from a click.
          return this.readOperation(principal.principalId, command.commandId);
        }
        await this.settle(accepted, principal, result);
      } catch {
        await this.ports.store.settle(principal.principalId, command.commandId, { ...accepted, state: "reconciliation_required" });
      }
      return { ok: true, value: (await this.ports.store.read(principal.principalId, command.commandId))! };
    } catch (error) {
      return failure(error instanceof Refusal ? error.reason : "operation_conflict", command.commandId);
    }
  }
  private async settle(operation: WebOperation, principal: WebPrincipal, result: OperationResult<WebOperationResult>): Promise<void> {
    const uncertain = !result.ok && ["unknown_delivery", "timeout", "corruption", "transport_unavailable", "cancelled"].includes(result.error.code);
    const value = result.ok ? { ...operation, state: "applied", result: result.value } : uncertain
      ? { ...operation, state: "reconciliation_required" }
      : { ...operation, state: "failed", error: { apiVersion: 1, code: result.error.code === "conflict" ? "stale_version" : "operation_not_allowed",
        message: "Conversation refused this exact interaction.", retryable: false, operationId: operation.operationId, correlationId: operation.operationId } };
    await this.ports.store.settle(principal.principalId, operation.operationId, WebOperationSchema.parse(value));
  }
  async readOperation(principalId: string, commandId: string): Promise<OperationResult<WebOperation>> {
    const current = await this.ports.store.read(principalId, commandId);
    if (!current) return { ok: false, error: { code: "not_found", retryable: false, message: "Interaction operation not found." } };
    if (["applied", "failed"].includes(current.state)) return { ok: true, value: current };
    const intent = (await this.ports.store.records()).find(record => record.id === commandId && record.payload.principal.principalId === principalId)!;
    const raw = await this.ports.reconcile(intent.payload.command, intent.payload.principal);
    if (raw !== undefined) {
      // A result in Conversation proves the admission happened. An accepted-only
      // intent after restart may lack a dispatch marker; seal that gap only from
      // the observation, never by re-admitting the command.
      await this.ports.store.reconcileDispatch(principalId, commandId);
      await this.settle(intent.payload.operation, intent.payload.principal, AdmissionResult.parse(raw));
    }
    return { ok: true, value: (await this.ports.store.read(principalId, commandId))! };
  }
}
