import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const fileSyncFailureTargets = new Map<string, string>();
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const targetPath = String(args[0]);
      for (const [prefix, code] of fileSyncFailureTargets) {
        // Trigger specifically on regular temporary file writes (`wx`), not only directory opens (`r`).
        if (targetPath.startsWith(prefix) && args[1] !== "r") {
          return new Proxy(handle, {
            get(target, prop, receiver) {
              if (prop === "sync") {
                return async () => {
                  throw Object.assign(new Error(`${code}: fsync not supported on FUSE file`), { code });
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
          });
        }
      }
      return handle;
    }) as typeof actual.open
  };
});

import {
  ChatDecisionSchema,
  ConversationGateway,
  FileConversationContextStore,
  HerdrConversationBridge,
  InMemoryConversationContextStore,
  MockHerdrAgentTransport,
  resolveChatDecision,
  sanitizeReasonForUser
} from "../src/index.js";

const tempDirs: string[] = [];
afterEach(async () => {
  fileSyncFailureTargets.clear();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

const HAS_LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

async function setupGateway() {
  const store = new InMemoryConversationContextStore();
  const transport = new MockHerdrAgentTransport();
  const bridge = new HerdrConversationBridge({
    transport,
    sessionId: "session-chat",
    conversationAgentId: "chat",
    conversationPaneId: "pane-chat",
    coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator" }
  });
  const gateway = new ConversationGateway({
    sessionId: "session-chat",
    herdrSessionId: "herdr-chat",
    paneId: "pane-chat",
    contextStore: store,
    bridge
  });
  await gateway.initializeOrRecoverSession();
  return { gateway, store, transport };
}

describe("Round 2 Slice 4 — Conversation schema, alias, multi-run & FUSE hardening", () => {
  it("normalizes LLM flat-tool-schema null/blank sibling properties and partial clarify drafts while still rejecting forged keys and incomplete workflow_request", () => {
    // 1. Flat JSON schema tool calls emit null/blank for unused sibling properties on conversation_only & status_query
    const convOnly = ChatDecisionSchema.parse({
      intent: "conversation_only",
      directReply: "Chào bạn, tôi sẵn sàng hỗ trợ!",
      targetRunId: null,
      targetCorrelationId: "",
      clarifyingQuestions: null,
      requirementDraft: null,
      cancellationInput: null
    });
    expect(convOnly).toEqual({
      intent: "conversation_only",
      directReply: "Chào bạn, tôi sẵn sàng hỗ trợ!"
    });

    const statusQuery = ChatDecisionSchema.parse({
      intent: "status_query",
      targetRunId: "   ",
      targetCorrelationId: null,
      directReply: "",
      clarifyingQuestions: [],
      requirementDraft: null,
      cancellationInput: null
    });
    expect(statusQuery).toEqual({ intent: "status_query" });

    // 2. Blank optional strings in cancellationInput normalize to undefined instead of failing IdentifierSchema.min(1)
    const cancel = ChatDecisionSchema.parse({
      intent: "cancellation_request",
      cancellationInput: { runId: "run-1", taskId: "", reason: "   " },
      targetRunId: "",
      targetCorrelationId: "  ",
      directReply: null
    });
    expect(cancel).toEqual({
      intent: "cancellation_request",
      cancellationInput: { runId: "run-1" }
    });

    // 3. Partial requirementDraft on `clarify` (omitting kind / sddLevel) defaults safely
    const clarify = ChatDecisionSchema.parse({
      intent: "clarify",
      clarifyingQuestions: ["Bạn muốn xuất định dạng CSV hay PDF?"],
      requirementDraft: {
        title: "Xuất báo cáo",
        objective: "Thêm nút xuất báo cáo doanh thu",
        targetRunId: "",
        targetCorrelationId: null
      },
      directReply: null,
      cancellationInput: null
    });
    expect(clarify.intent).toBe("clarify");
    if (clarify.intent === "clarify") {
      expect(clarify.requirementDraft).toMatchObject({
        title: "Xuất báo cáo",
        objective: "Thêm nút xuất báo cáo doanh thu",
        kind: "feature",
        sddLevel: "lightweight"
      });
    }

    // 4. `workflow_request` MUST STILL strictly require explicit kind, sddLevel, and non-whitespace title/objective
    expect(() =>
      ChatDecisionSchema.parse({
        intent: "workflow_request",
        requirementDraft: {
          title: "Xuất báo cáo",
          objective: "Thêm nút xuất báo cáo",
          scopeDefined: true,
          acceptanceCriteriaDescriptions: ["Xuất thành công"]
        }
      })
    ).toThrow();

    expect(() =>
      ChatDecisionSchema.parse({
        intent: "workflow_request",
        requirementDraft: {
          title: "   ",
          objective: "   ",
          kind: "feature",
          sddLevel: "lightweight",
          scopeDefined: true,
          acceptanceCriteriaDescriptions: ["Xuất thành công"]
        }
      })
    ).toThrow();

    // 5. Forged governance / provenance keys MUST STILL be strictly rejected
    expect(() =>
      ChatDecisionSchema.parse({
        intent: "conversation_only",
        directReply: "ok",
        provenance: { origin: "user", authenticatedUser: true }
      })
    ).toThrow();
    expect(() =>
      ChatDecisionSchema.parse({
        intent: "approval_response",
        approvalInput: { decision: "approved" }
      })
    ).toThrow();
  });

  it("preserves active follow-up run in workflows[correlationId] regardless of reconcile order and resolves status_query for older sibling runs (`Việc #1`)", async () => {
    const { gateway } = await setupGateway();
    const baseDelegation = {
      schemaVersion: 2 as const,
      delegationId: "del-1",
      messageId: "msg-del-1",
      correlationId: "corr-shared",
      sessionId: "session-chat",
      requestedBy: "conversation" as const,
      targetRole: "coordinator" as const,
      title: "Báo cáo doanh thu",
      objective: "Tạo báo cáo doanh thu",
      specificationId: "spec-1",
      sddLevel: "lightweight" as const,
      acceptanceCriteria: [
        {
          id: "ac-1",
          description: "Hiển thị bảng doanh thu",
          category: "functional" as const,
          verificationMethod: "unit_test" as const,
          required: true,
          status: "pending" as const,
          evidenceArtifactIds: []
        }
      ],
      inputArtifacts: [],
      priority: "normal" as const,
      requestedAt: "2026-10-31T01:00:00.000Z",
      idempotencyKey: "idemp-1",
      metadata: { revision: 1 }
    };

    const run2Active = {
      runId: "run-child-active",
      delegation: {
        ...baseDelegation,
        delegationId: "del-2",
        messageId: "msg-del-2",
        runId: "run-child-active",
        requestedAt: "2026-10-31T02:00:00.000Z",
        idempotencyKey: "idemp-2",
        metadata: { revision: 1, followUp: 2, parentRunId: "run-parent-done" }
      },
      status: "implementing",
      cancelled: false
    };
    const run1Terminal = {
      runId: "run-parent-done",
      delegation: { ...baseDelegation, runId: "run-parent-done" },
      status: "completed",
      cancelled: false
    };

    // Active child appears BEFORE terminal parent in Runtime snapshot: terminal parent must NOT clobber active child in workflows[corr-shared]
    const reconciled = await gateway.reconcileRuntimeRuns([run2Active, run1Terminal]);
    expect(reconciled.ok).toBe(true);
    gateway.syncNoticeAliases({
      runShortIds: { "việc #1": "run-parent-done", "việc #2": "run-child-active" }
    });

    const snapshot = gateway.getContextSnapshot();
    expect(snapshot.workflows["corr-shared"]?.runId).toBe("run-child-active");
    expect(snapshot.workflows["corr-shared"]?.sdlcStatus).toBe("implementing");

    // Querying status of older sibling `Việc #1` (`run-parent-done`) must resolve cleanly instead of failing with Unknown status-query workflow
    const statusOld = resolveChatDecision(
      ChatDecisionSchema.parse({ intent: "status_query", targetRunId: "Việc #1" }),
      snapshot
    );
    expect(statusOld.ok).toBe(true);
    if (statusOld.ok) {
      expect(statusOld.value.targetCorrelationId).toBe("corr-shared");
      expect(statusOld.value.targetRunId).toBe("run-parent-done");
    }
  });

  it("tolerates EOPNOTSUPP/ENOSYS on regular file handle.sync() in FileConversationContextStore and never splits UTF-16 surrogate pairs in sanitizeReasonForUser", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "round2-slice04-conv-store-"));
    tempDirs.push(tmpDir);
    fileSyncFailureTargets.set(tmpDir, "EOPNOTSUPP");

    const fileStore = new FileConversationContextStore(tmpDir);
    const gateway = new ConversationGateway({
      sessionId: "session-fuse",
      herdrSessionId: "herdr-fuse",
      paneId: "pane-fuse",
      contextStore: fileStore,
      bridge: new HerdrConversationBridge({
        transport: new MockHerdrAgentTransport(),
        sessionId: "session-fuse",
        conversationAgentId: "chat",
        conversationPaneId: "pane-fuse",
        coordinatorTarget: { transport: "herdr", agentId: "coordinator", paneId: "pane-coord" }
      })
    });

    const init = await gateway.initializeOrRecoverSession();
    expect(init.ok).toBe(true);

    // Emoji 🔥 is 2 UTF-16 code units (\uD83D\uDD25). maxLength=6 makes maxLength-1 = 5 (odd offset right inside 🔥!)
    const emojiReason = "A" + "🔥".repeat(10); // index 0='A', 1..2='🔥', 3..4='🔥', 5..6='🔥'
    const sanitized = sanitizeReasonForUser(emojiReason, 7); // maxLength - 1 = 6 -> boundary check; also test 6 -> maxLength - 1 = 5!
    const sanitizedOdd = sanitizeReasonForUser(emojiReason, 6);
    expect(HAS_LONE_SURROGATE.test(sanitized)).toBe(false);
    expect(HAS_LONE_SURROGATE.test(sanitizedOdd)).toBe(false);
  });
});
