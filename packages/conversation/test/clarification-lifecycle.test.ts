import { describe, expect, it } from "vitest";
import {
  ConversationGateway,
  HerdrConversationBridge,
  InMemoryConversationContextStore,
  MockHerdrAgentTransport,
  type UserTurnInput
} from "../src/index.js";

const SESSION_ID = "session-clarification-lifecycle";
const START = Date.parse("2031-01-01T00:00:00.000Z");
const SCOPE_ANSWER = "Phạm vi packages/billing, xử lý tạo hóa đơn Stripe và kiểm thử bằng unit test";

function setup(clock: { nowMs: number }) {
  const transport = new MockHerdrAgentTransport();
  const bridge = new HerdrConversationBridge({
    transport,
    sessionId: SESSION_ID,
    conversationAgentId: "chat",
    conversationPaneId: "pane-chat",
    coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator" }
  });
  const gateway = new ConversationGateway({
    sessionId: SESSION_ID,
    herdrSessionId: `herdr-${SESSION_ID}`,
    conversationAgentId: "chat",
    paneId: "pane-chat",
    bridge,
    contextStore: new InMemoryConversationContextStore(),
    now: () => new Date(clock.nowMs).toISOString()
  });
  const turn = (input: Partial<UserTurnInput> & { content: string }) =>
    gateway.handleUserTurn({ sessionId: SESSION_ID, provenance: { origin: "user", authenticatedUser: true }, ...input });
  return { gateway, transport, turn };
}

describe("A2: pending clarifications are scoped and expire", () => {
  it("maps an answer without a correlation id only to the newest open clarification", async () => {
    const clock = { nowMs: START };
    const { gateway, turn } = setup(clock);
    const older = await turn({ content: "Thêm tính năng mới" });
    clock.nowMs += 60_000;
    const newer = await turn({ content: "Sửa lỗi parser" });
    if (!older.ok || !newer.ok) throw new Error("setup failed");
    expect(newer.value.recognizedIntent).toBe("clarify");

    const answer = await turn({ content: SCOPE_ANSWER });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.recognizedIntent).toBe("workflow_request");
    expect(answer.value.correlationId).toBe(newer.value.correlationId);
    expect(answer.value.delegationRequest?.title).toContain("parser");
    const snapshot = gateway.getContextSnapshot();
    expect(snapshot.pendingClarifications[newer.value.correlationId]).toBeUndefined();
    expect(snapshot.pendingClarifications[older.value.correlationId]?.originalRequestText).toBe("Thêm tính năng mới");
  });

  it("closes a clarification that has gone unanswered for 24 hours", async () => {
    const clock = { nowMs: START };
    const { gateway, turn } = setup(clock);
    const asked = await turn({ content: "Thêm tính năng mới" });
    if (!asked.ok) throw new Error("setup failed");
    clock.nowMs += 25 * 60 * 60 * 1000;

    const answer = await turn({ content: SCOPE_ANSWER });

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.recognizedIntent).not.toBe("workflow_request");
    expect(answer.value.correlationId).not.toBe(asked.value.correlationId);
    const snapshot = gateway.getContextSnapshot();
    expect(snapshot.pendingClarifications[asked.value.correlationId]).toBeUndefined();
    expect(snapshot.session.unresolvedQuestions).toEqual([]);
    expect(snapshot.session.status).not.toBe("awaiting_user_clarification");
  });

  it("keeps a clarification answerable just inside the 24-hour window", async () => {
    const clock = { nowMs: START };
    const { gateway, turn } = setup(clock);
    const asked = await turn({ content: "Thêm tính năng mới" });
    if (!asked.ok) throw new Error("setup failed");
    clock.nowMs += 23 * 60 * 60 * 1000;

    const answer = await turn({ content: SCOPE_ANSWER });

    expect(answer.ok && answer.value.recognizedIntent).toBe("workflow_request");
    expect(gateway.getContextSnapshot().pendingClarifications[asked.value.correlationId]).toBeUndefined();
  });

  it("records only the questions the user was actually asked, with no generic fallback entry", async () => {
    const clock = { nowMs: START };
    const { gateway, turn } = setup(clock);
    const asked = await turn({ content: "Thêm tính năng mới", messageId: "msg-clarify-1",
      conversationDecision: { intent: "clarify", clarifyingQuestions: ["Phạm vi nào được thay đổi?"] } });
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(gateway.getContextSnapshot().pendingClarifications[asked.value.correlationId]?.unresolvedQuestions).toEqual(["Phạm vi nào được thay đổi?"]);
    expect(gateway.getContextSnapshot().session.unresolvedQuestions).toEqual(["Phạm vi nào được thay đổi?"]);
  });
});
