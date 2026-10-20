import { describe, expect, it } from "vitest";
import { CONVERSATION_CONTEXT_BUDGET, boundConversationContext } from "../../src/agentic/conversation-context-budget.js";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const message = (index: number, text = "x".repeat(900)) => ({ messageId: `m-${index}`, sender: "user", content: `${index} ${text}` });
const notice = { messageId: "notice-1", kind: "user_decision", headline: "Quyết định cần bạn", options: ["A", "B"] };
const pendingApprovals = { "apr-1": { approvalId: "apr-1", runId: "run-1", reason: "Human design approval required" } };
const approvalWarnings = ["Runtime đang chờ quyết định của người dùng (apr-9, run run-9) nhưng Conversation không đăng ký được: stale."];

function turn(messages: unknown[], clarifications: Record<string, unknown> = {}) {
  return {
    messageId: "user-1", requiresConversationDecision: true,
    notices: [notice], undisplayed: [],
    context: {
      session: { sessionId: "s-1", status: "awaiting_user_approval" }, agentBusy: false,
      pendingClarifications: clarifications, pendingApprovals, approvalWarnings, workflows: { w1: { activeApprovalIds: ["apr-1"] } },
      runIdToCorrelationId: { "run-1": "corr-1" }, messages
    }
  };
}

describe("Conversation hook context budget", () => {
  it("returns a small context unchanged", () => {
    const small = turn([message(1, "short")]);
    expect(boundConversationContext(small)).toEqual(small);
    expect(size(boundConversationContext(small))).toBeLessThanOrEqual(CONVERSATION_CONTEXT_BUDGET);
  });

  it("keeps notices, approvals and warnings intact while trimming a large history to the budget", () => {
    const messages = Array.from({ length: 200 }, (_, index) => message(index + 1));
    const bounded = boundConversationContext(turn(messages)) as ReturnType<typeof turn>;
    expect(size(bounded)).toBeLessThanOrEqual(CONVERSATION_CONTEXT_BUDGET);
    expect(bounded.notices).toEqual([notice]);
    expect(bounded.context.pendingApprovals).toEqual(pendingApprovals);
    expect(bounded.context.approvalWarnings).toEqual(approvalWarnings);
    expect(bounded.context.workflows).toEqual({ w1: { activeApprovalIds: ["apr-1"] } });
    expect(bounded.context.session).toEqual({ sessionId: "s-1", status: "awaiting_user_approval" });
    // The newest turns survive and the trim is visible to the model.
    const kept = bounded.context.messages as { messageId: string }[];
    expect(kept.at(-1)?.messageId).toBe("m-200");
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(200);
    expect(bounded.context).toHaveProperty("messagesOmitted", 200 - kept.length);
  });

  it("drops clarifications only after the message history is exhausted, and says so", () => {
    const clarifications = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`corr-${index}`, { question: "y".repeat(800) }]));
    const bounded = boundConversationContext(turn([message(1, "short")], clarifications)) as ReturnType<typeof turn>;
    expect(size(bounded)).toBeLessThanOrEqual(CONVERSATION_CONTEXT_BUDGET);
    expect(bounded.context.pendingClarifications).toEqual({});
    expect(bounded.context).toHaveProperty("clarificationsOmitted", 40);
    expect(bounded.context.messages).toEqual([message(1, "short")]);
    expect(bounded.notices).toEqual([notice]);
  });

  it("when notices alone exceed the budget, history is fully dropped and notices are never truncated", () => {
    const hugeNotice = { messageId: "notice-big", kind: "user_decision", headline: "h", detail: "z".repeat(3 * CONVERSATION_CONTEXT_BUDGET) };
    const big = { ...turn([message(1), message(2)]), notices: [hugeNotice] };
    const bounded = boundConversationContext(big) as ReturnType<typeof turn>;
    expect(bounded.notices).toEqual([hugeNotice]);
    expect(bounded.context.messages).toEqual([]);
    expect(bounded.context).toHaveProperty("messagesOmitted", 2);
    expect(bounded.context.pendingApprovals).toEqual(pendingApprovals);
  });
});
