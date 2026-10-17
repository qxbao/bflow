import { describe, expect, it } from "vitest";
import { ApprovalDecisionSchema, RoleMessageSchema, type ApprovalDecision, type ApprovalRequest } from "@bflow/contracts";
import {
  USER_DECISION_TOOL,
  buildDecisionRequestMessage,
  buildUserDecisionRequest,
  guardDirectUserInteraction,
  isUserDecisionRequest,
  parseUserDecisionToolInput,
  validateUserDecisionAnswer
} from "../../src/agentic/decision-routing.js";

const NOW = "2026-10-18T10:00:00.000Z";
const LATER = "2026-10-18T10:05:00.000Z";

const baseInput = {
  runId: "run-1",
  taskId: "task-1",
  question: "Which storage backend should we use?",
  options: ["SQLite", "Postgres"],
  context: "Both are supported by the existing adapters.",
  expiresInMinutes: 30
};

function makeRequest(overrides: Record<string, unknown> = {}): ApprovalRequest {
  return buildUserDecisionRequest({
    input: { ...baseInput, ...overrides },
    role: "developer",
    sessionId: "session-1",
    revision: 1,
    generation: 0,
    now: NOW
  });
}

function makeDecision(request: ApprovalRequest, overrides: Record<string, unknown> = {}): ApprovalDecision {
  return ApprovalDecisionSchema.parse({
    schemaVersion: 2,
    approvalId: request.approvalId,
    runId: request.runId,
    sessionId: request.sessionId,
    target: request.target,
    revision: request.revision,
    generation: request.generation,
    decision: "approved",
    decidedBy: "user-lead",
    decidedAt: LATER,
    feedbackArtifacts: [],
    idempotencyKey: "decision-key-1",
    metadata: { selectedOption: "SQLite" },
    ...overrides
  });
}

describe("P30 T8 user decision routing", () => {
  describe("parseUserDecisionToolInput", () => {
    it("accepts a valid input and trims text", () => {
      const parsed = parseUserDecisionToolInput({ ...baseInput, question: "  Pick one?  " });
      expect(parsed.question).toBe("Pick one?");
      expect(parsed.options).toEqual(["SQLite", "Postgres"]);
    });

    it("accepts the minimal input without options, context or expiry", () => {
      const parsed = parseUserDecisionToolInput({ runId: "run-1", taskId: "task-1", question: "Proceed?" });
      expect(parsed).toEqual({ runId: "run-1", taskId: "task-1", question: "Proceed?" });
    });

    it("rejects unknown keys", () => {
      expect(() => parseUserDecisionToolInput({ ...baseInput, extra: true })).toThrow(/Unknown user decision input key/);
    });

    it("enforces question bounds", () => {
      expect(() => parseUserDecisionToolInput({ ...baseInput, question: "   " })).toThrow(/question/);
      expect(() => parseUserDecisionToolInput({ ...baseInput, question: "x".repeat(2001) })).toThrow(/question/);
      expect(() => parseUserDecisionToolInput({ ...baseInput, question: "x".repeat(2000) })).not.toThrow();
    });

    it("enforces option count, length and uniqueness", () => {
      expect(() => parseUserDecisionToolInput({ ...baseInput, options: ["only"] })).toThrow(/2\.\.6/);
      expect(() => parseUserDecisionToolInput({ ...baseInput, options: ["a", "b", "c", "d", "e", "f", "g"] })).toThrow(/2\.\.6/);
      expect(() => parseUserDecisionToolInput({ ...baseInput, options: ["a", "b", "c", "d", "e", "f"] })).not.toThrow();
      expect(() => parseUserDecisionToolInput({ ...baseInput, options: ["Same", "same"] })).toThrow(/unique/);
      expect(() => parseUserDecisionToolInput({ ...baseInput, options: ["ok", "x".repeat(201)] })).toThrow(/options\[1\]/);
    });

    it("enforces context and expiry bounds", () => {
      expect(() => parseUserDecisionToolInput({ ...baseInput, context: "x".repeat(4001) })).toThrow(/context/);
      expect(() => parseUserDecisionToolInput({ ...baseInput, expiresInMinutes: 0 })).toThrow(/expiresInMinutes/);
      expect(() => parseUserDecisionToolInput({ ...baseInput, expiresInMinutes: 1441 })).toThrow(/expiresInMinutes/);
      expect(() => parseUserDecisionToolInput({ ...baseInput, expiresInMinutes: 1.5 })).toThrow(/expiresInMinutes/);
      expect(() => parseUserDecisionToolInput({ ...baseInput, expiresInMinutes: 1440 })).not.toThrow();
    });

    it("rejects non-object input", () => {
      expect(() => parseUserDecisionToolInput(null)).toThrow(/object/);
      expect(() => parseUserDecisionToolInput([])).toThrow(/object/);
    });
  });

  describe("buildUserDecisionRequest", () => {
    it("builds a schemaVersion 2 task-scoped pending request with user_decision metadata", () => {
      const request = makeRequest();
      expect(request.schemaVersion).toBe(2);
      expect(request.status).toBe("pending");
      expect(request.target).toEqual({ type: "task", taskId: "task-1" });
      expect(request.requestedBy).toBe("developer");
      expect(request.reason).toBe(baseInput.question);
      expect(request.evidence).toEqual([]);
      expect(request.requestedAt).toBe(NOW);
      expect(request.expiresAt).toBe(LATER.replace("10:05", "10:30"));
      expect(request.metadata).toMatchObject({
        kind: "user_decision",
        question: baseInput.question,
        options: ["SQLite", "Postgres"],
        context: baseInput.context,
        requestedByRole: "developer"
      });
      expect(isUserDecisionRequest(request)).toBe(true);
    });

    it("omits expiresAt and optional metadata when not requested", () => {
      const request = buildUserDecisionRequest({
        input: { runId: "run-1", taskId: "task-1", question: "Proceed?" },
        role: "reviewer",
        sessionId: "session-1",
        revision: 2,
        generation: 1,
        now: NOW
      });
      expect(request).not.toHaveProperty("expiresAt");
      expect(request.metadata).not.toHaveProperty("options");
      expect(request.metadata).not.toHaveProperty("context");
      expect(request.metadata?.kind).toBe("user_decision");
    });

    it("derives deterministic approvalId and idempotencyKey from the bound identity", () => {
      const first = makeRequest();
      const second = makeRequest({ expiresInMinutes: 5 });
      expect(second.approvalId).toBe(first.approvalId);
      expect(second.idempotencyKey).toBe(first.idempotencyKey);

      const otherQuestion = makeRequest({ question: "Another question?" });
      expect(otherQuestion.approvalId).not.toBe(first.approvalId);

      const otherRevision = buildUserDecisionRequest({
        input: baseInput, role: "developer", sessionId: "session-1", revision: 2, generation: 0, now: NOW
      });
      expect(otherRevision.approvalId).not.toBe(first.approvalId);

      const otherRole = buildUserDecisionRequest({
        input: baseInput, role: "reviewer", sessionId: "session-1", revision: 1, generation: 0, now: NOW
      });
      expect(otherRole.approvalId).not.toBe(first.approvalId);
    });

    it("rejects the conversation role because Conversation asks the user directly", () => {
      expect(() => buildUserDecisionRequest({
        input: baseInput, role: "conversation", sessionId: "session-1", revision: 1, generation: 0, now: NOW
      })).toThrow(/Conversation/);
    });

    it("rejects roles outside AgentRoleSchema", () => {
      expect(() => buildUserDecisionRequest({
        input: baseInput, role: "intruder" as never, sessionId: "session-1", revision: 1, generation: 0, now: NOW
      })).toThrow(/Unknown agent role/);
    });

    it("rejects a non-timestamp now", () => {
      expect(() => buildUserDecisionRequest({
        input: baseInput, role: "developer", sessionId: "session-1", revision: 1, generation: 0, now: "tomorrow"
      })).toThrow(/ISO-8601/);
    });
  });

  describe("isUserDecisionRequest", () => {
    it("is false for design and task approvals without the marker", () => {
      const design = { metadata: { bundleFingerprint: "abc" } };
      expect(isUserDecisionRequest(design)).toBe(false);
      expect(isUserDecisionRequest({})).toBe(false);
      expect(isUserDecisionRequest({ metadata: ["user_decision"] })).toBe(false);
      expect(isUserDecisionRequest({ metadata: { kind: "other" } })).toBe(false);
    });
  });

  describe("validateUserDecisionAnswer", () => {
    it("returns the outcome and selected option for a valid answer", () => {
      const request = makeRequest();
      expect(validateUserDecisionAnswer(request, makeDecision(request), LATER)).toEqual({
        outcome: "approved",
        selectedOption: "SQLite"
      });
    });

    it("returns a rejection reason without requiring an option", () => {
      const request = makeRequest();
      const decision = makeDecision(request, { decision: "rejected", reason: "Neither", metadata: undefined });
      expect(validateUserDecisionAnswer(request, decision, LATER)).toEqual({ outcome: "rejected", reason: "Neither" });
    });

    it("throws for a request that is not a user decision", () => {
      const request = makeRequest();
      const plain = { ...request, metadata: { bundleFingerprint: "x" } } as ApprovalRequest;
      expect(() => validateUserDecisionAnswer(plain, makeDecision(request), LATER)).toThrow(/Not a user-decision/);
    });

    it.each([
      ["approvalId", { approvalId: "other" }, /approvalId/],
      ["runId", { runId: "run-other" }, /runId/],
      ["sessionId", { sessionId: "session-other" }, /sessionId/],
      ["target", { target: { type: "task", taskId: "task-other" } }, /target/],
      ["revision", { revision: 9 }, /revision/],
      ["generation", { generation: 9 }, /generation/]
    ])("rejects a mismatched %s", (_label, override, pattern) => {
      const request = makeRequest();
      const decision = makeDecision(request, override);
      expect(() => validateUserDecisionAnswer(request, decision, LATER)).toThrow(pattern);
    });

    it("rejects a decision dated before the request", () => {
      const request = makeRequest();
      const decision = makeDecision(request, { decidedAt: "2026-10-18T09:59:00.000Z" });
      expect(() => validateUserDecisionAnswer(request, decision, LATER)).toThrow(/predates/);
    });

    it("rejects a decision dated in the future", () => {
      const request = makeRequest();
      const decision = makeDecision(request, { decidedAt: "2026-10-18T10:10:00.000Z" });
      expect(() => validateUserDecisionAnswer(request, decision, LATER)).toThrow(/future/);
    });

    it("rejects an answer once expiry is reached", () => {
      const request = makeRequest();
      const decision = makeDecision(request, { decidedAt: "2026-10-18T10:20:00.000Z" });
      expect(() => validateUserDecisionAnswer(request, decision, "2026-10-18T10:30:00.000Z")).toThrow(/expired/);
      expect(() => validateUserDecisionAnswer(request, decision, "2026-10-18T10:29:59.000Z")).not.toThrow();
    });

    it("rejects an approval that selects no option", () => {
      const request = makeRequest();
      const decision = makeDecision(request, { metadata: undefined });
      expect(() => validateUserDecisionAnswer(request, decision, LATER)).toThrow(/must select one of the offered options/);
    });

    it("rejects an approval whose selected option is not offered", () => {
      const request = makeRequest();
      const decision = makeDecision(request, { metadata: { selectedOption: "MySQL" } });
      expect(() => validateUserDecisionAnswer(request, decision, LATER)).toThrow(/must select one of the offered options/);
    });

    it("rejects a non-approval whose selected option is not offered", () => {
      const request = makeRequest();
      const decision = makeDecision(request, { decision: "changes_requested", reason: "Clarify", metadata: { selectedOption: "MySQL" } });
      expect(() => validateUserDecisionAnswer(request, decision, LATER)).toThrow(/not one of the offered options/);
    });

    it("rejects a non-string selectedOption", () => {
      const request = makeRequest();
      const decision = makeDecision(request, { metadata: { selectedOption: 3 } });
      expect(() => validateUserDecisionAnswer(request, decision, LATER)).toThrow(/must be a string/);
    });

    it("accepts a free-text approval when the question has no options", () => {
      const request = makeRequest({ options: undefined });
      const decision = makeDecision(request, { metadata: undefined, reason: "Use the existing module" });
      expect(validateUserDecisionAnswer(request, decision, LATER)).toEqual({
        outcome: "approved",
        reason: "Use the existing module"
      });
    });
  });

  describe("buildDecisionRequestMessage", () => {
    it("produces a valid schema_version 2 approval.request addressed to Conversation with run_id", () => {
      const request = makeRequest();
      const message = buildDecisionRequestMessage({
        request,
        correlationId: "corr-1",
        sender: { role: "runtime", agent_id: "runtime", pane_id: "pane-runtime" },
        conversation: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" }
      });
      expect(RoleMessageSchema.safeParse(message).success).toBe(true);
      expect(message.schema_version).toBe(2);
      expect(message.type).toBe("approval.request");
      expect(message.run_id).toBe("run-1");
      expect(message.recipient.role).toBe("conversation");
      expect(message.message_id).toBe(`decision-${request.approvalId}`);
      expect(message.payload).toEqual(JSON.parse(JSON.stringify(request)));
      expect(message.idempotency_key).toBe(request.idempotencyKey);
    });

    it("is deterministic for the same request", () => {
      const request = makeRequest();
      const params = {
        request,
        correlationId: "corr-1",
        sender: { role: "runtime" as const },
        conversation: { role: "conversation" as const }
      };
      expect(buildDecisionRequestMessage(params)).toEqual(buildDecisionRequestMessage(params));
    });

    it("rejects a specialist sender because specialists cannot address Conversation", () => {
      const request = makeRequest();
      expect(() => buildDecisionRequestMessage({
        request,
        correlationId: "corr-1",
        sender: { role: "developer" },
        conversation: { role: "conversation" }
      })).toThrow(/from runtime/);
    });

    it("rejects a recipient other than Conversation", () => {
      const request = makeRequest();
      expect(() => buildDecisionRequestMessage({
        request,
        correlationId: "corr-1",
        sender: { role: "runtime" },
        conversation: { role: "coordinator" }
      })).toThrow(/Conversation/);
    });
  });

  describe("guardDirectUserInteraction", () => {
    it("denies AskUserQuestion for a developer and points to the decision tool", () => {
      const result = guardDirectUserInteraction("developer", "AskUserQuestion");
      expect(result.permitted).toBe(false);
      if (result.permitted) return;
      expect(result.reason).toContain(`mcp__bflow__${USER_DECISION_TOOL}`);
    });

    it("denies MCP elicitation tools for specialist roles", () => {
      expect(guardDirectUserInteraction("coordinator", "mcp__github__elicitation_request").permitted).toBe(false);
      expect(guardDirectUserInteraction("reviewer", "mcp__any__Elicit").permitted).toBe(false);
    });

    it("permits AskUserQuestion for the conversation role", () => {
      expect(guardDirectUserInteraction("conversation", "AskUserQuestion")).toEqual({ permitted: true });
    });

    it("does not grant anything for ordinary tools", () => {
      expect(guardDirectUserInteraction("developer", "Edit")).toEqual({ permitted: true });
      expect(guardDirectUserInteraction("developer", "mcp__bflow__request_user_decision")).toEqual({ permitted: true });
    });
  });
});
