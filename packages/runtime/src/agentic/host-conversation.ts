import { z } from "zod";
import { JsonValueSchema, PaneBindingSchema, type JsonValue, type PaneBinding } from "@bflow/contracts";
import { digest, json, record } from "./journal.js";
import { redactString } from "../resilience/redaction.js";
import { HostReceiptJournal, AgyNativeAnchorSchema, parseConversationResumeRequest, type TrustedConversationTurn } from "./host-receipts.js";
import { parseNativeDiagnosticFenceCommand, parsePolicyPhaseRetirementCommand, parseWorkflowReviewReplacementCommand } from "./native-diagnostic-fence.js";

interface ConversationIntakePort {
  getContext(): Promise<unknown>;
  parseDecision(input: unknown): Promise<unknown>;
  validateDecision(input: unknown): Promise<void>;
  handleUserTurn(input: unknown): Promise<unknown>;
  handleTrustedApproval(input: unknown): Promise<unknown | undefined>;
}
/** messageId is optional: the host binds the decision to this pane's latest authenticated user turn, so a model never has to copy it. */
const DecisionCallSchema = z.object({ messageId: z.string().min(1).optional(), decision: JsonValueSchema }).strict();
const ReceivedTurnSchema = z.object({ messageId: z.string().min(1), conversationSessionId: z.string().min(1),
  content: z.string().min(1), userId: z.string().min(1),
  agyLaunchId: z.string().min(1).optional(), agyAnchor: AgyNativeAnchorSchema.optional(), source: z.literal("local_web").optional(), runId: z.string().min(1).optional() }).strict();
const TRUSTED_APPROVAL = json({ intent: "trusted_approval" });
function identity(binding: PaneBinding): string {
  return digest({ ...binding, transportState: undefined, lastHeartbeatAt: undefined });
}

/** Host-owned user receipts are the only source of content/provenance for Chat's structured decisions. */
export class HostConversationIntake {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly receipts: HostReceiptJournal, private readonly conversation: () => ConversationIntakePort,
    private readonly fenceDiagnostic?: (turn: TrustedConversationTurn, operationId: string) => Promise<JsonValue>,
    private readonly retirePolicyPhase?: (turn: TrustedConversationTurn, operationId: string) => Promise<JsonValue>,
    private readonly replaceWorkflowReview?: (turn: TrustedConversationTurn, operationId: string) => Promise<JsonValue>) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => undefined).then(work);
    this.pending = result;
    return result;
  }
  private userInput(turn: TrustedConversationTurn) {
    return { sessionId: turn.conversationSessionId, messageId: turn.messageId, content: turn.content, occurredAt: turn.occurredAt, ...(turn.runId?{runId:turn.runId}:{}),
      provenance: { origin: "user", authenticatedUser: true, userId: turn.userId, paneId: turn.binding.paneId, ...(turn.source === "local_web" ? {} : { channel: "herdr_attach" }) } };
  }
  /** Only unfinished ordinary turns explicitly interrupted by a Runtime nudge are recoverable; no approval or old resume authority. */
  private async recoverableTurns(binding: PaneBinding): Promise<TrustedConversationTurn[]> {
    const turns: TrustedConversationTurn[] = [];
    for (const turn of await this.receipts.conversationTurns()) {
      if (identity(turn.binding) !== identity(binding) || parseConversationResumeRequest(turn.content) || (parseNativeDiagnosticFenceCommand(turn.content) || parsePolicyPhaseRetirementCommand(turn.content) || parseWorkflowReviewReplacementCommand(turn.content)) ||
          await this.receipts.conversationDecision(turn.messageId) !== undefined ||
          await this.receipts.conversationApprovalFailure(turn.messageId) !== undefined) continue;
      if (await this.receipts.wasConversationTurnNudged(turn)) turns.push(turn);
    }
    return turns;
  }
  private async reply(binding: PaneBinding, value: Record<string, unknown>): Promise<JsonValue> {
    const recoverable = await this.recoverableTurns(binding);
    return json({ ...value, ...(recoverable.length ? { recoverableUserTurns: recoverable.map(({ messageId, content }) => ({ messageId, content })) } : {}),
      context: await this.conversation().getContext() });
  }
  receive(principal: PaneBinding, input: unknown): Promise<JsonValue> {
    return this.exclusive(async () => {
      const binding = PaneBindingSchema.parse(principal), turn = ReceivedTurnSchema.parse(input);
      if (binding.role !== "conversation" || !binding.session) throw new Error("Only authenticated Conversation receives user turns");
      const turns = await this.receipts.conversationTurns();
      const previous = turns.find(value => value.messageId === turn.messageId);
      if (previous && (identity(previous.binding) !== identity(binding) || previous.content !== turn.content ||
          previous.conversationSessionId !== turn.conversationSessionId || previous.userId !== turn.userId || previous.source !== turn.source || previous.runId !== turn.runId)) {
        throw new Error("Conflicting trusted user turn");
      }
      const trusted = previous ?? { binding, ...turn, occurredAt: new Date().toISOString(), sequence: (turns.at(-1)?.sequence ?? 0) + 1 };
      await this.receipts.recordConversationTurn(trusted);
      const saved = await this.receipts.conversationDecision(turn.messageId);
      if (saved?.result !== undefined) return this.reply(binding, { messageId: turn.messageId, requiresConversationDecision: false, result: saved.result });
      const phaseRetirement = parsePolicyPhaseRetirementCommand(trusted.content);
      const reviewReplacement = parseWorkflowReviewReplacementCommand(trusted.content);
      const operationId = parseNativeDiagnosticFenceCommand(trusted.content) ?? phaseRetirement ?? reviewReplacement;
      if (operationId !== undefined) {
        const intent = json({ intent: reviewReplacement ? "trusted_workflow_review_replacement" : phaseRetirement ? "trusted_policy_phase_retirement" : "trusted_native_diagnostic_fence", operationId });
        if (saved && digest(saved.decision) !== digest(intent)) throw new Error("Conflicting physical diagnostic fence command");
        await this.receipts.recordConversationIntent(turn.messageId, intent);
        let result: JsonValue;
        try {
          const apply = reviewReplacement ? this.replaceWorkflowReview : phaseRetirement ? this.retirePolicyPhase : this.fenceDiagnostic;
          if (!apply) throw new Error("This host does not support this physical fence command");
          result = json(await apply(trusted, operationId));
        } catch (error) {
          result = json({ ok: false, error: { code: "diagnostic_fence_failed", message: redactString(String(error)).slice(0, 2000) },
            note: "Inspect the fence state for this exact operation; no delivery is inferred and the original message must not be resent." });
        }
        await this.receipts.recordConversationResult(turn.messageId, intent, result);
        return this.reply(binding, { messageId: turn.messageId, requiresConversationDecision: false, result });
      }
      const failed = await this.receipts.conversationApprovalFailure(turn.messageId);
      if (failed) return this.reply(binding, { messageId: turn.messageId, requiresConversationDecision: false, approvalFailed: true,
        approvalFailure: { error: failed.error, note: failed.note } });
      const trustedApproval = saved !== undefined && digest(saved.decision) === digest(TRUSTED_APPROVAL);
      if (saved && !trustedApproval) return this.reply(binding, { messageId: turn.messageId, requiresConversationDecision: true, decision: saved.decision });
      // This callback is executed only inside the authenticated physical-user hook. Models cannot invoke it.
      // The port replays a committed or queued approval for the same messageId instead of reapplying it.
      const approval = await this.conversation().handleTrustedApproval(this.userInput(trusted));
      if (approval === undefined) {
        // A recorded approval never falls back to Chat, which cannot complete a trusted_approval intent.
        if (trustedApproval) throw new Error("Recorded trusted approval no longer matches a pending or committed approval");
        return this.reply(binding, { messageId: turn.messageId, requiresConversationDecision: true });
      }
      const result = json(approval);
      if (record(result).ok !== true) {
        // No approval or model decision is recorded. Keep its failed hook disposition so Stop cannot reinterpret it as ordinary input.
        const approvalFailure = { error: redactString(JSON.stringify(record(result).error ?? result)).slice(0, 2000),
          note: "The approval was NOT recorded and nothing was applied. Explain this failure to the user and ask what to do next; do not claim the approval succeeded." };
        await this.receipts.recordApprovalFailure(turn.messageId, approvalFailure);
        return this.reply(binding, { messageId: turn.messageId, requiresConversationDecision: false, approvalFailed: true, approvalFailure });
      }
      await this.receipts.recordConversationIntent(turn.messageId, TRUSTED_APPROVAL);
      // A durable FIFO acknowledgement is pending work; the next receive resumes it through the port.
      if (record(record(result).value).queuedBecauseBusy !== true) {
        await this.receipts.recordConversationResult(turn.messageId, TRUSTED_APPROVAL, result);
      }
      return this.reply(binding, { messageId: turn.messageId, requiresConversationDecision: false, result });
    });
  }
  runtimeNudge(principal: PaneBinding): Promise<void> {
    return this.exclusive(() => this.receipts.recordConversationRuntimeNudge(principal));
  }
  inspectTurn(principal: PaneBinding): Promise<JsonValue> {
    return this.exclusive(async () => {
      const binding = PaneBindingSchema.parse(principal);
      if (binding.role !== "conversation" || !binding.session) throw new Error("Only authenticated Conversation has user turns");
      const turn = (await this.receipts.conversationTurns()).filter(value => identity(value.binding) === identity(binding)).at(-1);
      const isNudge = await this.receipts.isConversationRuntimeNudge(binding);
      const saved = turn && !isNudge ? await this.receipts.conversationDecision(turn.messageId) : undefined;
      const failed = turn && !isNudge ? await this.receipts.conversationApprovalFailure(turn.messageId) : undefined;
      const trustedApproval = saved !== undefined && digest(saved.decision) === digest(TRUSTED_APPROVAL);
      const liveTrustedResult = turn && !isNudge && trustedApproval && saved?.result === undefined
        ? await this.conversation().handleTrustedApproval(this.userInput(turn))
        : undefined;
      const resolvedResult = saved?.result !== undefined
        ? saved.result
        : liveTrustedResult !== undefined
          ? json(liveTrustedResult)
          : undefined;
      const requiresConversationDecision = !isNudge && turn !== undefined && failed === undefined && resolvedResult === undefined && !trustedApproval;
      return this.reply(binding, {
        ...(turn && !isNudge ? { messageId: turn.messageId } : {}),
        requiresConversationDecision,
        ...(isNudge ? { runtimeNudge: true } : {}),
        ...(failed ? { approvalFailed: true, approvalFailure: { error: failed.error, note: failed.note } } : {}),
        ...(resolvedResult !== undefined ? { result: resolvedResult } : saved?.decision !== undefined ? { decision: saved.decision } : {})
      });
    });
  }
  pendingApprovalFailure(principal: PaneBinding): Promise<{ messageId: string; error: string; note: string } | undefined> {
    return this.exclusive(async () => {
      const binding = PaneBindingSchema.parse(principal);
      if (binding.role !== "conversation" || !binding.session) throw new Error("Only authenticated Conversation has approval outcomes");
      if (await this.receipts.isConversationRuntimeNudge(binding)) return undefined;
      const turn = (await this.receipts.conversationTurns()).filter(value => identity(value.binding) === identity(binding)).at(-1);
      if (!turn || await this.receipts.conversationDecision(turn.messageId) !== undefined) return undefined;
      return this.receipts.conversationApprovalFailure(turn.messageId);
    });
  }
  /**
   * The latest ordinary input is decided first. Explicitly suspended ordinary turns remain recoverable afterward by their original
   * message IDs. A Runtime nudge itself authorizes neither path; failed approval hooks are reported through their trusted disposition.
   */
  pendingDecision(principal: PaneBinding): Promise<{ messageId: string; content: string; requiresExplicitMessageId?: true } | undefined> {
    return this.exclusive(async () => {
      const binding = PaneBindingSchema.parse(principal);
      if (binding.role !== "conversation" || !binding.session) throw new Error("Only authenticated Conversation has user turns");
      if (await this.receipts.isConversationRuntimeNudge(binding)) return undefined;
      const turn = (await this.receipts.conversationTurns()).filter(value => identity(value.binding) === identity(binding)).at(-1);
      const latest = turn ? await this.receipts.conversationDecision(turn.messageId) : undefined;
      if (turn && (parseNativeDiagnosticFenceCommand(turn.content) || parsePolicyPhaseRetirementCommand(turn.content) || parseWorkflowReviewReplacementCommand(turn.content))) return undefined;
      if (turn && latest?.result === undefined) {
        // An ordinary intent is not a committed correction/cancellation; retain its exact retry ahead of older work.
        if (await this.receipts.conversationApprovalFailure(turn.messageId) === undefined &&
            (!latest || digest(latest.decision) !== digest(TRUSTED_APPROVAL)))
          return { messageId: turn.messageId, content: turn.content };
        // A pending/failed trusted approval cannot become an ordinary decision or authorize older work.
        return undefined;
      }
      const recovered = (await this.recoverableTurns(binding)).find(value => value.messageId !== turn?.messageId);
      return recovered === undefined ? undefined : { messageId: recovered.messageId, content: recovered.content, requiresExplicitMessageId: true };
    });
  }
  decide(principal: PaneBinding, input: unknown): Promise<JsonValue> {
    return this.exclusive(async () => {
      const binding = PaneBindingSchema.parse(principal), args = DecisionCallSchema.parse(input);
      if (binding.role !== "conversation" || !binding.session) throw new Error("Only authenticated Conversation may decide user intent");
      await this.receipts.assertConversationUserTurn(binding);
      const turns = await this.receipts.conversationTurns();
      const turn = args.messageId === undefined ? turns.filter(value => identity(value.binding) === identity(binding)).at(-1)
        : turns.find(value => value.messageId === args.messageId);
      if (!turn) throw new Error(args.messageId === undefined ? "No trusted user turn has been recorded for this Conversation pane" : "Unknown trusted user turn");
      if ((parseNativeDiagnosticFenceCommand(turn.content) || parsePolicyPhaseRetirementCommand(turn.content) || parseWorkflowReviewReplacementCommand(turn.content))) throw new Error("Diagnostic fencing requires the physical user hook; model decisions cannot authorize it");
      const messageId = turn.messageId;
      if (identity(turn.binding) !== identity(binding)) throw new Error("Conversation decision pane/native session changed");
      const approvalFailure = await this.receipts.conversationApprovalFailure(messageId);
      if (approvalFailure !== undefined && await this.receipts.conversationDecision(messageId) === undefined)
        throw new Error(`Trusted approval failed: ${approvalFailure.note} Runtime error: ${approvalFailure.error}. Report this trusted failure to the user. Do not decide, approve or retry it automatically.`);
      const decision = json(await this.conversation().parseDecision(args.decision));
      if (parseConversationResumeRequest(turn.content) && record(decision).intent === "workflow_request")
        throw new Error("An explicit resume request must use resume_run with the existing runId, then conversation_only; preserve the existing acceptance criteria.");
      const previous = await this.receipts.conversationDecision(messageId);
      if (previous && digest(previous.decision) === digest(TRUSTED_APPROVAL)) {
        const trustedResult = previous.result !== undefined
          ? previous.result
          : json((await this.conversation().handleTrustedApproval(this.userInput(turn))) ?? { decision: previous.decision });
        throw new Error(
          `Conflicting Conversation decision for user turn: this turn was already handled by the trusted approval hook (requiresConversationDecision=false). ` +
          `Do not call conversation_decide; inspect the trusted result (or call read_updates): ${JSON.stringify(trustedResult)}`
        );
      }
      if (previous && digest(previous.decision) !== digest(decision)) throw new Error("Conflicting Conversation decision for user turn");
      if (previous?.result !== undefined) return previous.result;
      if (turns.some(value => value.sequence > turn.sequence && identity(value.binding) === identity(binding))) {
        const latest = turns.filter(value => identity(value.binding) === identity(binding)).at(-1)!;
        const recoverable = args.messageId !== undefined && (await this.recoverableTurns(binding)).some(value => value.messageId === messageId);
        if (!previous && !recoverable) throw new Error("Stale user turn; decide the latest trusted input");
        if ((await this.receipts.conversationDecision(latest.messageId))?.result === undefined)
          throw new Error("Decide the latest trusted input before recovering a suspended user turn; consider newer corrections or cancellation");
      }
      if (!previous) await this.conversation().validateDecision(decision);
      await this.receipts.recordConversationIntent(messageId, decision);
      // Gateway binds deterministic message/run/outbox ids to this trusted messageId and reconciles retries.
      const rawResult = json(await this.conversation().handleUserTurn({ ...this.userInput(turn), conversationDecision: decision }));
      if (record(rawResult).ok !== true) throw new Error(`Conversation decision failed: ${JSON.stringify(record(rawResult).error)}`);
      // A durable FIFO acknowledgement is pending work, not a completed Chat decision.
      if (record(record(rawResult).value).queuedBecauseBusy === true) return rawResult;
      const remainingRecoverable = (await this.recoverableTurns(binding)).filter(value => value.messageId !== messageId);
      const result = remainingRecoverable.length && typeof rawResult === "object" && rawResult !== null && !Array.isArray(rawResult)
        ? json({ ...rawResult, recoverableUserTurns: remainingRecoverable.map(({ messageId: id, content }) => ({ messageId: id, content })) })
        : rawResult;
      await this.receipts.recordConversationResult(messageId, decision, result);
      return result;
    });
  }
}
