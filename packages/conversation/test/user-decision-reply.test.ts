import { describe, expect, it } from "vitest";
import type { ApprovalRequest, RoleMessage } from "@bflow/contracts";
import {
  ConversationGateway,
  HerdrConversationBridge,
  InMemoryConversationContextStore,
  MockHerdrAgentTransport
} from "../src/index.js";

const SESSION_ID = "session-user-decision-reply";

function userDecisionRequest(): ApprovalRequest {
  return {
    schemaVersion: 2,
    approvalId: "apr-decision-reply",
    runId: "run-decision-reply",
    sessionId: SESSION_ID,
    status: "pending",
    target: { type: "task", taskId: "task-9" },
    revision: 1,
    generation: 0,
    requestedBy: "developer",
    requestedAt: "2031-01-01T00:00:00.000Z",
    reason: "Which storage backend?",
    evidence: [],
    idempotencyKey: "user-decision:reply",
    metadata: { kind: "user_decision", question: "Which storage backend?", options: ["SQLite", "Postgres"] }
  };
}

async function openWithDecision() {
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
    contextStore: new InMemoryConversationContextStore()
  });
  await gateway.initializeOrRecoverSession();
  const start = await gateway.handleUserTurn({
    sessionId: SESSION_ID,
    content: "Triển khai lưu trữ trong packages/storage",
    provenance: { origin: "user", authenticatedUser: true }
  });
  if (!start.ok) throw new Error(start.error.message);
  const request = userDecisionRequest();
  const prompt = {
    schema_version: 2,
    message_id: `decision-${request.approvalId}`,
    correlation_id: start.value.correlationId,
    run_id: request.runId,
    sender: { role: "runtime", agent_id: "runtime" },
    recipient: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" },
    type: "approval.request",
    payload: JSON.parse(JSON.stringify(request)) as unknown,
    artifact_references: []
  } as RoleMessage;
  const prompted = await gateway.handleCoordinatorRoleMessage(prompt);
  if (!prompted.ok) throw new Error(prompted.error.message);
  return { gateway, transport };
}

function turn(gateway: ConversationGateway, content: string) {
  return gateway.handleUserTurn({ sessionId: SESSION_ID, content, provenance: { origin: "user", authenticatedUser: true } });
}

describe("B3: user-decision replies report the chosen option, never an [APPROVED] marker", () => {
  it("tells the user which numbered option was chosen and sends its index and text to Coordinator", async () => {
    const { gateway, transport } = await openWithDecision();

    const reply = await turn(gateway, "apr-decision-reply: 2");

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.agentReply.content).toContain("Đã chọn phương án 2: Postgres");
    expect(reply.value.agentReply.content).not.toContain("[APPROVED]");
    expect(reply.value.agentReply.content).not.toContain("[APPROVED_BY_USER]");
    const sent = transport.sentRoleMessages.at(-1);
    expect(sent?.type).toBe("approval.decision");
    expect(sent?.payload).toMatchObject({
      approvalId: "apr-decision-reply",
      decision: "approved",
      metadata: { selectedOption: "Postgres", selectedOptionIndex: 2 }
    });
  });

  it("reports a refusal of a user decision without the [APPROVED]/[REJECTED] wording", async () => {
    const { gateway } = await openWithDecision();

    const reply = await turn(gateway, "apr-decision-reply: từ chối vì chưa rõ");

    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.value.agentReply.content).toContain("Đã từ chối câu hỏi apr-decision-reply");
    expect(reply.value.agentReply.content).not.toContain("[REJECTED]");
  });
});
