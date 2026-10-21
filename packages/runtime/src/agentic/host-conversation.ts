import { z } from "zod";
import { JsonValueSchema, PaneBindingSchema, type JsonValue, type PaneBinding } from "@bflow/contracts";
import { digest, json, record } from "./journal.js";
import { redactString } from "../resilience/redaction.js";
import { HostReceiptJournal, type TrustedConversationTurn } from "./host-receipts.js";

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
  content: z.string().min(1), userId: z.string().min(1) }).strict();
const TRUSTED_APPROVAL = json({ intent: "trusted_approval" });
function identity(binding: PaneBinding): string {
  return digest({ ...binding, transportState: undefined, lastHeartbeatAt: undefined });
}

/** Host-owned user receipts are the only source of content/provenance for Chat's structured decisions. */
export class HostConversationIntake {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(readonly receipts: HostReceiptJournal, private readonly conversation: () => ConversationIntakePort) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.catch(() => undefined).then(work);
    this.pending = result;
    return result;
  }
  private userInput(turn: TrustedConversationTurn) {
    return { sessionId: turn.conversationSessionId, messageId: turn.messageId, content: turn.content, occurredAt: turn.occurredAt,
      provenance: { origin: "user", authenticatedUser: true, userId: turn.userId, paneId: turn.binding.paneId, channel: "herdr_attach" } };
  }
  receive(principal: PaneBinding, input: unknown): Promise<JsonValue> {
    return this.exclusive(async () => {
      const binding = PaneBindingSchema.parse(principal), turn = ReceivedTurnSchema.parse(input);
      if (binding.role !== "conversation" || !binding.session) throw new Error("Only authenticated Conversation receives user turns");
      const turns = await this.receipts.conversationTurns();
      const previous = turns.find(value => value.messageId === turn.messageId);
      if (previous && (identity(previous.binding) !== identity(binding) || previous.content !== turn.content ||
          previous.conversationSessionId !== turn.conversationSessionId || previous.userId !== turn.userId)) {
        throw new Error("Conflicting trusted user turn");
      }
      const trusted = previous ?? { binding, ...turn, occurredAt: new Date().toISOString(), sequence: (turns.at(-1)?.sequence ?? 0) + 1 };
      await this.receipts.recordConversationTurn(trusted);
      const saved = await this.receipts.conversationDecision(turn.messageId);
      if (saved?.result !== undefined) return json({ messageId: turn.messageId, requiresConversationDecision: false,
        result: saved.result, context: await this.conversation().getContext() });
      const trustedApproval = saved !== undefined && digest(saved.decision) === digest(TRUSTED_APPROVAL);
      if (saved && !trustedApproval) return json({ messageId: turn.messageId, requiresConversationDecision: true,
        decision: saved.decision, context: await this.conversation().getContext() });
      // This callback is executed only inside the authenticated physical-user hook. Models cannot invoke it.
      // The port replays a committed or queued approval for the same messageId instead of reapplying it.
      const approval = await this.conversation().handleTrustedApproval(this.userInput(trusted));
      if (approval === undefined) {
        // A recorded approval never falls back to Chat, which cannot complete a trusted_approval intent.
        if (trustedApproval) throw new Error("Recorded trusted approval no longer matches a pending or committed approval");
        return json({ messageId: turn.messageId, requiresConversationDecision: true, context: await this.conversation().getContext() });
      }
      const result = json(approval);
      if (record(result).ok !== true) {
        // Nothing is recorded, so the same user turn can be retried. The explanation reaches the provider as context, not as a thrown hook error.
        return json({ messageId: turn.messageId, requiresConversationDecision: false, approvalFailed: true,
          approvalFailure: { error: redactString(JSON.stringify(record(result).error ?? result)).slice(0, 2000), note: "The approval was NOT recorded and nothing was applied. Explain this failure to the user and ask what to do next; do not claim the approval succeeded." },
          context: await this.conversation().getContext() });
      }
      await this.receipts.recordConversationIntent(turn.messageId, TRUSTED_APPROVAL);
      // A durable FIFO acknowledgement is pending work; the next receive resumes it through the port.
      if (record(record(result).value).queuedBecauseBusy !== true) {
        await this.receipts.recordConversationResult(turn.messageId, TRUSTED_APPROVAL, result);
      }
      return json({ messageId: turn.messageId, requiresConversationDecision: false, result,
        context: await this.conversation().getContext() });
    });
  }
  /**
   * The pane's latest authenticated user turn when it still has no recorded decision. A Stop hook uses it to refuse ending the
   * turn silently: every ordinary user turn must reach conversation_decide (conversation_only is a valid decision).
   */
  pendingDecision(principal: PaneBinding): Promise<{ messageId: string; content: string } | undefined> {
    return this.exclusive(async () => {
      const binding = PaneBindingSchema.parse(principal);
      if (binding.role !== "conversation" || !binding.session) throw new Error("Only authenticated Conversation has user turns");
      const turn = (await this.receipts.conversationTurns()).filter(value => identity(value.binding) === identity(binding)).at(-1);
      if (!turn || await this.receipts.conversationDecision(turn.messageId) !== undefined) return undefined;
      return { messageId: turn.messageId, content: turn.content };
    });
  }
  decide(principal: PaneBinding, input: unknown): Promise<JsonValue> {
    return this.exclusive(async () => {
      const binding = PaneBindingSchema.parse(principal), args = DecisionCallSchema.parse(input);
      if (binding.role !== "conversation" || !binding.session) throw new Error("Only authenticated Conversation may decide user intent");
      const turns = await this.receipts.conversationTurns();
      const turn = args.messageId === undefined ? turns.filter(value => identity(value.binding) === identity(binding)).at(-1)
        : turns.find(value => value.messageId === args.messageId);
      if (!turn) throw new Error(args.messageId === undefined ? "No trusted user turn has been recorded for this Conversation pane" : "Unknown trusted user turn");
      const messageId = turn.messageId;
      if (identity(turn.binding) !== identity(binding)) throw new Error("Conversation decision pane/native session changed");
      const decision = json(await this.conversation().parseDecision(args.decision));
      const previous = await this.receipts.conversationDecision(messageId);
      if (previous && digest(previous.decision) !== digest(decision)) throw new Error("Conflicting Conversation decision for user turn");
      if (previous?.result !== undefined) return previous.result;
      if (!previous && turns.some(value => value.sequence > turn.sequence && identity(value.binding) === identity(binding)))
        throw new Error("Stale user turn; decide the latest trusted input");
      if (!previous) await this.conversation().validateDecision(decision);
      await this.receipts.recordConversationIntent(messageId, decision);
      // Gateway binds deterministic message/run/outbox ids to this trusted messageId and reconciles retries.
      const result = json(await this.conversation().handleUserTurn({ ...this.userInput(turn), conversationDecision: decision }));
      if (record(result).ok !== true) throw new Error(`Conversation decision failed: ${JSON.stringify(record(result).error)}`);
      // A durable FIFO acknowledgement is pending work, not a completed Chat decision.
      if (record(record(result).value).queuedBecauseBusy === true) return result;
      await this.receipts.recordConversationResult(messageId, decision, result);
      return result;
    });
  }
}
