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

  describe("workflow compaction", () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1) + minutes * 60_000).toISOString();
    const workflow = (index: number, sdlcStatus: string, activeApprovalIds: string[] = []) => ({
      correlationId: `corr-${index}`, sessionId: "s-1", delegationId: `del-${index}`, specificationId: `spec-${index}`, runId: `run-${index}`,
      title: `Yêu cầu ${index}`, objective: "o".repeat(1500), kind: "feature", sddLevel: "full", priority: "normal", sdlcStatus, revision: 4, generation: 1,
      activeApprovalIds, acceptanceCriteria: Array.from({ length: 5 }, (_, i) => ({ id: `AC-${i}`, status: "pending", required: true, description: "d".repeat(400) })),
      progressHistory: Array.from({ length: 30 }, (_, i) => ({ taskState: "running", note: `p${i} ` + "p".repeat(300) })),
      completedVerified: false, createdAt: at(0), updatedAt: at(index)
    });
    // The incident: six historical workflows (~13 KB each), two open ones, twenty long messages and a pending clarification.
    const incident = () => {
      const workflows = [workflow(0, "intake", ["apr-1"]), workflow(1, "clarifying"), ...[2, 3, 4, 5, 6, 7].map(index => workflow(index, index % 2 ? "cancelled" : "failed"))];
      return {
        messageId: "user-20", requiresConversationDecision: true, notices: [notice], undisplayed: [],
        context: {
          session: { sessionId: "s-1", status: "awaiting_user_approval" }, agentBusy: false,
          pendingClarifications: { "corr-1": { question: "Chọn A hay B?", options: ["A", "B"] } }, pendingApprovals, approvalWarnings,
          workflows: Object.fromEntries(workflows.map(item => [item.correlationId, item])),
          runIdToCorrelationId: Object.fromEntries(workflows.map(item => [item.runId, item.correlationId])),
          messages: Array.from({ length: 20 }, (_, index) => message(index + 1))
        }
      };
    };

    it("bounds the incident payload and keeps the newest turns, the decision and the pending clarification", () => {
      const bounded = boundConversationContext(incident()) as ReturnType<typeof incident>;
      expect(size(bounded)).toBeLessThanOrEqual(CONVERSATION_CONTEXT_BUDGET);
      expect(bounded.messageId).toBe("user-20");
      expect(bounded.requiresConversationDecision).toBe(true);
      const kept = bounded.context.messages as { messageId: string }[];
      expect(kept.at(-1)?.messageId).toBe("m-20");
      expect(bounded.context.pendingClarifications).toEqual({ "corr-1": { question: "Chọn A hay B?", options: ["A", "B"] } });
    });

    it("keeps identity, status and approvals of non-terminal workflows", () => {
      const bounded = boundConversationContext(incident()) as ReturnType<typeof incident>;
      expect(bounded.context.workflows["corr-0"]).toMatchObject({ correlationId: "corr-0", runId: "run-0", sdlcStatus: "intake", activeApprovalIds: ["apr-1"] });
      expect(bounded.context.workflows["corr-1"]).toMatchObject({ correlationId: "corr-1", runId: "run-1", sdlcStatus: "clarifying", activeApprovalIds: [] });
    });

    it("keeps approvals, warnings and notices unchanged even when they alone exceed the budget", () => {
      const heavyApprovals = { "apr-1": { approvalId: "apr-1", runId: "run-1", reason: "r".repeat(4000) } };
      const heavyWarnings = Array.from({ length: 3 }, () => "w".repeat(4000));
      const big = { ...incident(), notices: [{ ...notice, detail: "n".repeat(4000) }] };
      big.context = { ...big.context, pendingApprovals: heavyApprovals, approvalWarnings: heavyWarnings };
      const bounded = boundConversationContext(big) as ReturnType<typeof incident>;
      expect(bounded.notices).toEqual(big.notices);
      expect(bounded.context.pendingApprovals).toEqual(heavyApprovals);
      expect(bounded.context.approvalWarnings).toEqual(heavyWarnings);
    });

    it("drops terminal summaries oldest-first when needed, and counts what was dropped", () => {
      const terminal = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`corr-t-${index}`, workflow(index, "cancelled")]));
      const runs = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`run-${index}`, `corr-t-${index}`]));
      const big = { ...incident(), context: { ...incident().context, workflows: terminal, runIdToCorrelationId: runs, messages: [message(1, "short")] } };
      const bounded = boundConversationContext(big) as ReturnType<typeof incident>;
      const keptIds = Object.keys(bounded.context.workflows);
      expect(size(bounded)).toBeLessThanOrEqual(CONVERSATION_CONTEXT_BUDGET);
      expect(bounded.context).toHaveProperty("workflowsOmitted", 300 - keptIds.length);
      expect(bounded.context).toHaveProperty("runIndexOmitted", 300 - Object.keys(bounded.context.runIdToCorrelationId).length);
      expect(keptIds.at(-1)).toBe("corr-t-299");
      expect(keptIds).not.toContain("corr-t-0");
      expect(bounded.context.messages).toEqual([message(1, "short")]);
      expect(bounded.context).not.toHaveProperty("messagesOmitted");
    });

    it("truncates long open-workflow text and marks the cut", () => {
      const big = { ...incident(), context: { ...incident().context, workflows: { "corr-0": workflow(0, "intake", ["apr-1"]) }, messages: [] } };
      const bounded = boundConversationContext(big, 1000) as ReturnType<typeof incident>;
      const open = bounded.context.workflows["corr-0"] as { objective: string; acceptanceCriteria: { description: string }[] };
      expect(open.objective).toMatch(/^o{300}…\[truncated 1200 chars\]$/);
      expect(open.acceptanceCriteria[0]!.description).toMatch(/^d{120}…\[truncated 280 chars\]$/);
    });

    it("briefs open workflows without approvals before trimming any message", () => {
      const openIds = ["corr-open-0", "corr-open-1", "corr-open-2", "corr-open-3", "corr-open-4"];
      const brief = () => {
        const open = (index: number, sdlcStatus: string, activeApprovalIds: string[] = []) => ({
          correlationId: `corr-open-${index}`, sessionId: "s-1", delegationId: `del-${index}`, specificationId: `spec-${index}`, runId: `run-open-${index}`,
          title: `Yêu cầu mở ${index}`, objective: "o".repeat(1500), kind: "feature", sddLevel: "full", priority: "normal", sdlcStatus, revision: 4, generation: 1,
          activeApprovalIds, acceptanceCriteria: Array.from({ length: 5 }, (_, i) => ({ id: `AC-${i}`, status: "pending", required: true, description: "d".repeat(150) })),
          progressHistory: Array.from({ length: 3 }, (_, i) => ({ taskState: "running", note: `p${i} ` + "p".repeat(350) })),
          lastProgress: { taskState: "running", note: "l".repeat(300) }, completedVerified: false, createdAt: at(0), updatedAt: at(index)
        });
        const terminal = Array.from({ length: 3 }, (_, index) => ({ correlationId: `corr-done-${index}`, runId: `run-done-${index}`, title: `Đã xong ${index}`,
          sdlcStatus: "cancelled", objective: "t".repeat(1500), updatedAt: at(index) }));
        const workflows = [open(0, "intake", ["apr-1"]), open(1, "intake"), open(2, "intake"), open(3, "intake"), open(4, "specifying"), ...terminal];
        return {
          messageId: "user-20", requiresConversationDecision: true, notices: [notice], undisplayed: [],
          context: {
            session: { sessionId: "s-1", status: "awaiting_user_approval" }, agentBusy: false,
            pendingClarifications: { "corr-open-4": { question: "Chọn A hay B?", options: ["A", "B"] } }, pendingApprovals, approvalWarnings,
            workflows: Object.fromEntries(workflows.map(item => [item.correlationId, item])),
            runIdToCorrelationId: Object.fromEntries(workflows.map(item => [item.runId, item.correlationId])),
            messages: Array.from({ length: 20 }, (_, index) => message(index + 1))
          }
        };
      };

      const bounded = boundConversationContext(brief()) as ReturnType<typeof brief>;
      expect(size(bounded)).toBeLessThanOrEqual(CONVERSATION_CONTEXT_BUDGET);
      const kept = bounded.context.messages as { messageId: string }[];
      expect(kept.slice(-2).map(item => item.messageId)).toEqual(["m-19", "m-20"]);
      expect(bounded.context.pendingClarifications).toEqual({ "corr-open-4": { question: "Chọn A hay B?", options: ["A", "B"] } });
      for (const id of openIds) {
        expect(bounded.context.workflows[id]).toMatchObject({ correlationId: id, runId: id.replace("corr", "run"), sdlcStatus: expect.any(String) });
        expect(bounded.context.workflows[id]).toHaveProperty("activeApprovalIds");
      }
      // The approval-bearing workflow keeps its full compacted form, while the others are briefed.
      expect(bounded.context.workflows["corr-open-0"]).toHaveProperty("acceptanceCriteria");
      expect(bounded.context.workflows["corr-open-0"]).toHaveProperty("progressHistory");
      expect(bounded.context.workflows["corr-open-1"]).toHaveProperty("acceptanceCriteriaCount", 5);
      expect(bounded.context.workflows["corr-open-1"]).not.toHaveProperty("acceptanceCriteria");
      expect(bounded.context).toHaveProperty("workflowsBriefed", 4);
    });
  });
});
