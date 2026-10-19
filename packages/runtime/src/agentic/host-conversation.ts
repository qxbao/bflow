import { z } from "zod";
import { JsonValueSchema, PaneBindingSchema, type JsonValue, type PaneBinding } from "@bflow/contracts";
import { digest, json, record } from "./journal.js";
import { HostReceiptJournal, type TrustedConversationTurn } from "./host-receipts.js";

interface ConversationIntakePort {
  getContext(): Promise<unknown>;
  parseDecision(input: unknown): Promise<unknown>;
  validateDecision(input: unknown): Promise<void>;
  handleUserTurn(input: unknown): Promise<unknown>;
  handleTrustedApproval(input: unknown): Promise<unknown | undefined>;
}
const DecisionCallSchema = z.object({ messageId: z.string().min(1), decision: JsonValueSchema }).strict();
const ReceivedTurnSchema = z.object({ messageId: z.string().min(1), conversationSessionId: z.string().min(1),
  content: z.string().min(1), userId: z.string().min(1) }).strict();
function identity(binding: PaneBinding): string { return digest({ ...binding, transportState: undefined }); }

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
      const trusted = { binding, ...turn, occurredAt: previous?.occurredAt ?? new Date().toISOString(), sequence: previous?.sequence ?? (turns.at(-1)?.sequence ?? 0) + 1 };
      await this.receipts.recordConversationTurn(trusted);
      const saved = await this.receipts.conversationDecision(turn.messageId);
      if (saved?.result !== undefined) return json({ messageId: turn.messageId, requiresConversationDecision: false,
        result: saved.result, context: await this.conversation().getContext() });
      // This callback is executed only inside the authenticated physical-user hook. Models cannot invoke it.
      const approval = await this.conversation().handleTrustedApproval(this.userInput(trusted));
      if (approval !== undefined) {
        const decision = json({ intent: "trusted_approval" });
        await this.receipts.recordConversationIntent(turn.messageId, decision);
        await this.receipts.recordConversationResult(turn.messageId, decision, json(approval));
        return json({ messageId: turn.messageId, requiresConversationDecision: false, result: approval,
          context: await this.conversation().getContext() });
      }
      return json({ messageId: turn.messageId, requiresConversationDecision: true, context: await this.conversation().getContext() });
    });
  }
  decide(principal: PaneBinding, input: unknown): Promise<JsonValue> {
    return this.exclusive(async () => {
      const binding = PaneBindingSchema.parse(principal), args = DecisionCallSchema.parse(input);
      if (binding.role !== "conversation" || !binding.session) throw new Error("Only authenticated Conversation may decide user intent");
      const turns = await this.receipts.conversationTurns(), turn = turns.find(value => value.messageId === args.messageId);
      if (!turn) throw new Error("Unknown trusted user turn");
      if (identity(turn.binding) !== identity(binding)) throw new Error("Conversation decision pane/native session changed");
      const decision = json(await this.conversation().parseDecision(args.decision));
      const previous = await this.receipts.conversationDecision(args.messageId);
      if (previous && digest(previous.decision) !== digest(decision)) throw new Error("Conflicting Conversation decision for user turn");
      if (previous?.result !== undefined) return previous.result;
      if (!previous && turns.some(value => value.sequence > turn.sequence && identity(value.binding) === identity(binding)))
        throw new Error("Stale user turn; decide the latest trusted input");
      if (!previous) await this.conversation().validateDecision(decision);
      await this.receipts.recordConversationIntent(args.messageId, decision);
      // Gateway binds deterministic message/run/outbox ids to this trusted messageId and reconciles retries.
      const result = json(await this.conversation().handleUserTurn({ ...this.userInput(turn), conversationDecision: decision }));
      if (record(result).ok !== true) throw new Error(`Conversation decision failed: ${JSON.stringify(record(result).error)}`);
      // A durable FIFO acknowledgement is pending work, not a completed Chat decision.
      if (record(record(result).value).queuedBecauseBusy === true) return result;
      await this.receipts.recordConversationResult(args.messageId, decision, result);
      return result;
    });
  }
}
