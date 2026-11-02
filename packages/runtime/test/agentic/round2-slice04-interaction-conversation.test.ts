import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fileSyncFailureTargets = new Map<string, string>();
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const targetPath = String(args[0]);
      for (const [prefix, code] of fileSyncFailureTargets) {
        if (targetPath.startsWith(prefix) && args[1] !== "r") {
          return new Proxy(handle, {
            get(target, prop, receiver) {
              if (prop === "sync") {
                return async () => {
                  throw Object.assign(new Error(`${code}: fsync unsupported on FUSE`), { code });
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
  ApprovalRequestSchema,
  PaneBindingSchema,
  RoleMessageSchema,
  SessionManifestSchema,
  WebChatMessageSchema,
  WebChatSendSchema,
  WebCommandSchema
} from "@bflow/contracts";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { boundConversationContext } from "../../src/agentic/conversation-context-budget.js";
import { ConversationInboxNotifier } from "../../src/agentic/conversation-inbox-notifier.js";
import { notificationBody, renderConversationNotice } from "../../src/agentic/conversation-notice-render.js";
import { HostConversationIntake } from "../../src/agentic/host-conversation.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { availableActions } from "../../src/interaction/actions.js";
import { WebInteractionAuthority } from "../../src/interaction/authority.js";
import { fixture as webCommandFixture, now as webNow } from "../interaction/web-command-fixtures.js";
import { ChatDeliveryStore } from "../../src/interaction/chat-delivery.js";
import { WebOperationStore } from "../../src/interaction/operation-store.js";
import { projectDecision, projectRun } from "../../src/interaction/views.js";
import { at, pending, run, state } from "../interaction/fixtures.js";

const cleanups: string[] = [];
afterEach(async () => {
  fileSyncFailureTargets.clear();
  vi.restoreAllMocks();
  for (const dir of cleanups.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const HAS_LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

async function runtimeConversationFixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), "round2-slice04-rt-"));
  cleanups.push(directory);
  const binding = PaneBindingSchema.parse({
    schemaVersion: 2,
    bindingId: "chat-binding",
    sessionId: "herdr-session",
    role: "conversation",
    agentId: "chat",
    paneId: "chat-pane",
    workspaceId: "workspace",
    tabId: "tab",
    provider: "claude",
    agentKind: "claude",
    cwd: directory,
    readOnlyWorkspace: true,
    permanent: true,
    session: { source: "herdr:claude", kind: "id", value: "native-chat" },
    isolationMode: "dedicated_pane",
    transportState: "idle",
    boundAt: at
  });
  const coordinator = PaneBindingSchema.parse({
    ...binding,
    role: "coordinator",
    bindingId: "coordinator-binding",
    agentId: "coordinator",
    paneId: "coordinator-pane",
    session: { source: "herdr:claude", kind: "id", value: "native-coordinator" }
  });
  const manifest = SessionManifestSchema.parse({
    schemaVersion: 2,
    sessionId: "herdr-session",
    workspaceRoot: directory,
    projectName: "round2-slice04",
    herdrWorkspaceId: "workspace",
    herdrTabId: "tab",
    status: "up",
    conversationSessionId: "chat-session",
    activeRunIds: [],
    attachTarget: { role: "conversation", paneId: binding.paneId },
    panes: [binding, coordinator],
    createdAt: at,
    updatedAt: at
  });
  const ports = {
    authenticateMessage: async () => true,
    panes: { getManifest: async () => ({ ok: true, value: manifest }) }
  } as unknown as AgenticRuntimePorts;
  const receipts = new HostReceiptJournal(directory, directory, "herdr-session");
  const runtime = new AgenticWorkflowRuntime(ports, {
    journalDirectory: join(directory, "runtime-journal"),
    repositoryPath: directory
  });
  const chat = await createAgenticConversationHost({
    runtime,
    manifest,
    contextDirectory: join(directory, "context"),
    noticeAliases: () => receipts.noticeAliases()
  });
  const intake = new HostConversationIntake(receipts, () => chat);
  const turn = (messageId: string, content: string) => ({
    messageId,
    content,
    conversationSessionId: "chat-session",
    userId: "human"
  });
  return { directory, binding, manifest, receipts, runtime, chat, intake, turn };
}

describe("Round 2 Slice 4 — HostConversationIntake, Runtime Interaction & Notice Hardening", () => {
  it("normalizes null/blank messageId in conversation_decide, formats actionable schema errors, and blocks inadmissible requirement changes BEFORE locking recordConversationIntent", async () => {
    const f = await runtimeConversationFixture();

    // 1. Create a run via conversation_decide with messageId: null and flat-schema null sibling keys
    await f.intake.receive(f.binding, f.turn("turn-1", "Tạo tính năng xuất CSV"));
    const created = (await f.intake.decide(f.binding, {
      messageId: null,
      decision: {
        intent: "workflow_request",
        directReply: null,
        clarifyingQuestions: null,
        cancellationInput: null,
        targetRunId: "",
        targetCorrelationId: null,
        requirementDraft: {
          title: "Xuất CSV",
          objective: "Thêm chức năng xuất CSV",
          kind: "feature",
          sddLevel: "lightweight",
          scopeDefined: true,
          acceptanceCriteriaDescriptions: ["Xuất file CSV đúng định dạng"],
          isRequirementChange: false
        }
      }
    })) as { ok: boolean; value: { runId: string } };
    expect(created.ok).toBe(true);
    const runId = created.value.runId;

    // 2. Immediately before any conversation-notice receipt exists, `Việc #1` alias is synthesized & exposed in getContext()
    const ctxBeforeNotice = (await f.chat.getContext()) as { runShortIds?: Record<string, string> };
    expect(ctxBeforeNotice.runShortIds?.["việc #1"]).toBe(runId);

    // 3. Invalid conversation_decide payload throws a concise, actionable Error naming the field path instead of raw multi-KB Zod JSON
    await f.intake.receive(f.binding, f.turn("turn-bad", "Chào bạn"));
    await expect(
      f.intake.decide(f.binding, {
        messageId: "   ",
        decision: { intent: "conversation_only", directReply: "   " }
      })
    ).rejects.toThrow(/Invalid conversation_decide.*directReply/i);
    // Turn must remain undecided so the model can immediately fix and succeed on the same turn
    expect(await f.receipts.conversationDecision("turn-bad")).toBeUndefined();
    const fixedBad = await f.intake.decide(f.binding, {
      messageId: "",
      decision: { intent: "conversation_only", directReply: "Xin chào!" }
    });
    expect(fixedBad).toMatchObject({ ok: true });

    // 4. Advance the Runtime run to coreCreated=true (`implementing`) in journal, then attempt in-place requirement revision via `Việc #1`.
    // validateDecision MUST reject BEFORE recordConversationIntent writes `conversation-intent`, so the model is NOT deadlocked
    // and can recover on the exact same user turn with `conversation_only`!
    const journalPath = join(f.directory, "runtime-journal", "state.json");
    const rawJournal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    rawJournal.runs[0].coreCreated = true;
    rawJournal.runs[0].status = "implementing";
    await fs.writeFile(journalPath, JSON.stringify(rawJournal));
    const reopenedRuntime = new AgenticWorkflowRuntime(
      {
        authenticateMessage: async () => true,
        panes: { getManifest: async () => ({ ok: true, value: f.manifest }) }
      } as unknown as AgenticRuntimePorts,
      { journalDirectory: join(f.directory, "runtime-journal"), repositoryPath: f.directory }
    );
    const reopenedChat = await createAgenticConversationHost({
      runtime: reopenedRuntime,
      manifest: f.manifest,
      contextDirectory: join(f.directory, "context"),
      noticeAliases: () => f.receipts.noticeAliases()
    });
    const reopenedIntake = new HostConversationIntake(f.receipts, () => reopenedChat);

    await reopenedIntake.receive(f.binding, f.turn("turn-revise-locked", "Sửa Việc #1 thêm xuất PDF"));
    await expect(
      reopenedIntake.decide(f.binding, {
        decision: {
          intent: "workflow_request",
          requirementDraft: {
            title: "Xuất CSV & PDF",
            objective: "Thêm xuất PDF vào Việc #1",
            kind: "feature",
            sddLevel: "lightweight",
            scopeDefined: true,
            acceptanceCriteriaDescriptions: ["Xuất được cả CSV và PDF"],
            isRequirementChange: true,
            targetRunId: "Việc #1"
          }
        }
      })
    ).rejects.toThrow(/already executing tasks|core/i);

    // Crucial invariant: recordConversationIntent MUST NOT have locked `turn-revise-locked`!
    expect(await f.receipts.conversationDecision("turn-revise-locked")).toBeUndefined();

    // Model immediately recovers on the SAME turn with conversation_only explaining to cancel/create a new run
    const recoveredReply = await reopenedIntake.decide(f.binding, {
      decision: {
        intent: "conversation_only",
        directReply: "Việc #1 đang thực thi tác vụ trong Core nên không thể sửa trực tiếp; bạn hãy hủy Việc #1 hoặc tạo công việc mới nhé."
      }
    });
    expect(recoveredReply).toMatchObject({ ok: true, value: { recognizedIntent: "conversation_only" } });
  });

  it("enables Web resume (`Tiếp tục`) after specialist capability preflight escalation (`requiredRole`) and after policy phase retirement", () => {
    // 1. Escalated run with requiredRole set on pendingAction (Runtime capability preflight blocked specialist before dispatch)
    const capBlocked = run("run-cap", {
      status: "escalated",
      pendingAction: {
        ...pending,
        recovery: "capability_repair",
        requiredRole: "architect",
        requiredCapabilities: ["repository.read"]
      }
    });
    const capResume = availableActions(capBlocked, state([capBlocked]), [], true, true).find(a => a.kind === "resume");
    expect(capResume).toMatchObject({
      kind: "resume",
      actionId: pending.actionId,
      enabled: true
    });
    expect(capResume?.disabledReason).toBeUndefined();

    // 2. Implementing run whose stuck policy phase was retired by operator (`phaseRetirement` without `resumeAuthorizedBy`)
    const retiredRun = run("run-retired", {
      status: "implementing",
      pendingAction: { ...pending, state: "queued" }
    });
    const retiredState = state([retiredRun]);
    retiredState.outbound.push({
      message: RoleMessageSchema.parse({
        schema_version: 2,
        message_id: "msg-policy-1",
        correlation_id: "c-run-retired",
        run_id: "run-retired",
        sender: { role: "coordinator" },
        recipient: { role: "architect" },
        type: "delegation.request",
        payload: retiredRun.delegation,
        artifact_references: [],
        occurred_at: at,
        idempotency_key: "msg-policy-1"
      }),
      status: "cancelled",
      selector: "architect",
      taskId: "policy-1",
      attemptId: "attempt-1",
      capabilities: ["repository.read"],
      phaseRetirement: {
        operationId: "msg-policy-1",
        retiredAt: at,
        userId: "human",
        conversationMessageId: "retire-turn-1"
      }
    });
    const retiredResume = availableActions(retiredRun, retiredState, [], true, true).find(a => a.kind === "resume");
    expect(retiredResume).toMatchObject({
      kind: "resume",
      actionId: pending.actionId,
      enabled: true
    });
  });

  it("never produces lone UTF-16 surrogates across views, context budget, notice rendering, and inbox notifications, and tolerates file sync EOPNOTSUPP in WebOperationStore/ChatDeliveryStore", async () => {
    // Emoji 🚀 is 2 UTF-16 code units (\uD83D\uDE80)
    const emojiWall = "X" + "🚀".repeat(9000); // odd boundary at any even slice index (120, 200, 300, 400, 1200, 2000, 16000)

    // 1. views.ts projectDecision & projectRun
    const r = run("r-emoji", {
      status: "awaiting_approval",
      approval: ApprovalRequestSchema.parse({
        schemaVersion: 2,
        approvalId: "design-emoji",
        runId: "r-emoji",
        sessionId: "conversation-1",
        target: { type: "specification", specId: "spec-1" },
        revision: 1,
        generation: 0,
        requestedBy: "coordinator",
        requestedAt: at,
        reason: emojiWall,
        evidence: [],
        idempotencyKey: "k-emoji",
        metadata: { kind: "user_decision", question: emojiWall, options: [emojiWall.slice(0, 251)] }
      })
    });
    const sources = {
      state: state([r]),
      sessionId: "conversation-1",
      observedAt: at,
      core: new Map(),
      ready: true,
      commandsSupported: true
    };
    const dec = projectDecision(sources, r, r.approval!, "user_decision");
    expect(HAS_LONE_SURROGATE.test(dec.question)).toBe(false);
    expect(HAS_LONE_SURROGATE.test(dec.options[0]!)).toBe(false);
    const projected = projectRun(sources, "r-emoji");
    expect(HAS_LONE_SURROGATE.test(JSON.stringify(projected))).toBe(false);

    // 2. conversation-context-budget.ts
    const bounded = boundConversationContext(
      {
        context: {
          messages: [{ id: "m1", content: "hi" }],
          pendingClarifications: {},
          runIdToCorrelationId: { "r-1": "c-1" },
          workflows: {
            "c-1": {
              correlationId: "c-1",
              runId: "r-1",
              title: emojiWall.slice(0, 251),
              objective: emojiWall.slice(0, 501),
              sdlcStatus: "implementing",
              activeApprovalIds: [],
              blockedReason: emojiWall.slice(0, 251),
              acceptanceCriteria: [{ id: "ac-1", status: "pending", required: true, description: emojiWall.slice(0, 251) }],
              updatedAt: at
            }
          }
        }
      },
      900
    );
    expect(HAS_LONE_SURROGATE.test(JSON.stringify(bounded))).toBe(false);

    // 3. conversation-notice-render.ts + conversation-inbox-notifier.ts
    const rendered = renderConversationNotice({
      messageId: "notice-emoji",
      type: "approval.request",
      shortId: "#1",
      summary: JSON.stringify({
        approvalId: "apr-emoji",
        runId: "r-emoji",
        metadata: { kind: "user_decision", question: emojiWall.slice(0, 2501), options: [emojiWall.slice(0, 601)] }
      })
    });
    const body = notificationBody(rendered, 120);
    expect(HAS_LONE_SURROGATE.test(rendered.display)).toBe(false);
    expect(HAS_LONE_SURROGATE.test(body)).toBe(false);

    let notifiedBody = "";
    const notifier = new ConversationInboxNotifier();
    await notifier.tick({
      provider: "claude",
      unsurfacedNotices: async () => [
        {
          messageId: "n-1",
          type: "conversation.progress",
          runId: "r-1",
          summary: JSON.stringify({ headline: emojiWall.slice(0, 1501) })
        }
      ],
      undisplayedNotices: async () => [],
      conversationPaneId: async () => undefined,
      agentStatus: async () => "idle",
      readPaneAnsi: async () => "",
      notify: async (_title, text) => {
        notifiedBody = text;
      },
      prompt: async () => {},
      now: () => 1_000
    });
    expect(HAS_LONE_SURROGATE.test(notifiedBody)).toBe(false);

    // 4. WebOperationStore & ChatDeliveryStore regular-file handle.sync() EOPNOTSUPP tolerance
    const fuseDir = await fs.mkdtemp(join(tmpdir(), "round2-slice04-fuse-stores-"));
    cleanups.push(fuseDir);
    fileSyncFailureTargets.set(fuseDir, "EOPNOTSUPP");

    const opDir = join(fuseDir, "ops");
    const chatDir = join(fuseDir, "chat");
    const wf = webCommandFixture();
    const authority = new WebInteractionAuthority("project-1", "host-1", () => webNow);
    authority.registerOwnerKey(wf.registration);
    const opStore = new WebOperationStore({
      directory: opDir,
      repository: fuseDir,
      sessionId: "host-1",
      projectId: "project-1"
    });
    const accepted = await opStore.accept(wf.command, wf.proof(), authority);
    expect(accepted.state).toBe("accepted");

    const chatStore = new ChatDeliveryStore(chatDir, "project-1", "herdr-session");
    const msgId = randomUUID();
    await chatStore.write({
      version: 1,
      projectId: "project-1",
      hostSessionId: "herdr-session",
      sequence: 1,
      principalId: "principal-1",
      input: WebChatSendSchema.parse({
        apiVersion: 1,
        projectId: "project-1",
        sessionId: "chat-session",
        runId: "run-1",
        messageId: msgId,
        content: "Xin chào FUSE"
      }),
      nonce: randomUUID(),
      nativeSessionId: "native-chat",
      paneId: "chat-pane",
      message: WebChatMessageSchema.parse({
        apiVersion: 1,
        messageId: msgId,
        sessionId: "chat-session",
        runId: "run-1",
        sender: "user",
        source: "web",
        content: "Xin chào FUSE",
        delivery: "queued",
        createdAt: at
      }),
      echoObserved: false,
      admitted: false,
      state: "queued",
      approvalContext: []
    });
    expect(await chatStore.all()).toHaveLength(1);
  });
});
