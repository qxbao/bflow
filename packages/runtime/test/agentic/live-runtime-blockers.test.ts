import { createServer } from "node:net";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalRequestSchema,
  DelegationRequestSchema,
  PaneBindingSchema,
  RoleMessageSchema,
  SessionManifestSchema,
  type PaneBinding,
  type SessionManifest
} from "@bflow/contracts";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { draft, workflow } from "../../../specification/test/fixtures.js";
import { renderConversationNotice } from "../../src/agentic/conversation-notice-render.js";
import * as hostModule from "../../src/agentic/host.js";
import { callHost } from "../../src/agentic/host-protocol.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { AgenticJournal, type JournalState, type Outbound } from "../../src/agentic/journal.js";
import { HerdrOutbox, unwrap } from "../../src/agentic/outbox.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const action of cleanups.splice(0).reverse()) await action();
});

async function tempDir(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function runtimeFixture() {
  const root = await tempDir("bflow-live-blockers-");
  let at = new Date("2026-11-01T00:00:00.000Z");
  let devReady = true;
  let coordReady = true;
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => at });
  const engine = new DeterministicWorkflowEngine();
  const transport = new FakeAgentTransport();
  const definition = workflow();
  const created = unwrap(await engine.createRun({ runId: "run-1", definition, idempotencyKey: "create", createdAt: at.toISOString() }));
  const running = unwrap(await engine.advance({ runId: "run-1", expectedVersion: created.snapshot.version, idempotencyKey: "advance", occurredAt: at.toISOString() }));
  const attemptId = running.snapshot.tasks[0]!.attemptId!;

  const devBinding: PaneBinding = PaneBindingSchema.parse({
    schemaVersion: 2, bindingId: "developer-binding", sessionId: "session-1", role: "developer",
    agentId: "developer", paneId: "pane-developer", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude",
    cwd: root, worktreePath: root, readOnlyWorkspace: false, isolationMode: "dedicated_pane", transportState: "idle",
    boundAt: at.toISOString(), session: { source: "herdr:claude", kind: "id", value: "dev-session" }
  });
  let coordBinding: PaneBinding = PaneBindingSchema.parse({
    schemaVersion: 2, bindingId: "coordinator-binding", sessionId: "session-1", role: "coordinator",
    agentId: "coordinator", paneId: "pane-coordinator-old", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude",
    cwd: root, readOnlyWorkspace: true, isolationMode: "dedicated_pane", transportState: "idle",
    boundAt: at.toISOString(), session: { source: "herdr:claude", kind: "id", value: "coord-session-old" }
  });
  const convBinding: PaneBinding = PaneBindingSchema.parse({
    schemaVersion: 2, bindingId: "conversation-binding", sessionId: "session-1", role: "conversation",
    agentId: "conversation", paneId: "pane-conversation", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude",
    cwd: root, readOnlyWorkspace: true, isolationMode: "dedicated_pane", transportState: "idle",
    boundAt: at.toISOString(), session: { source: "herdr:claude", kind: "id", value: "conv-session" }
  });

  const inspectRoleHealth = vi.fn(async (selector: string) => {
    const binding = selector === "coordinator" ? coordBinding : devBinding;
    const readyForPrompt = selector === "coordinator" ? coordReady : devReady;
    return {
      ok: true as const,
      value: { readyForPrompt, occupantMatches: true, paneId: binding.paneId, agentId: binding.agentId }
    };
  });

  const ports = {
    registry,
    engine,
    transport,
    clock: () => at,
    roleCapabilities: { developer: ["implementation"], coordinator: ["repository.read"] },
    conversation: { deliver: async () => ({ ok: true as const, value: {} }) },
    runStore: { appendEvents: async () => ({ ok: true as const, value: {} }) },
    panes: {
      getManifest: async () => ({
        ok: true as const,
        value: SessionManifestSchema.parse({
          schemaVersion: 2, sessionId: "session-1", projectName: "bflow-test", workspaceRoot: root,
          herdrWorkspaceId: "workspace", herdrTabId: "tab", conversationSessionId: "session-1",
          status: "up", activeRunIds: ["run-1"],
          attachTarget: { role: "conversation", paneId: "pane-conversation" },
          createdAt: at.toISOString(), updatedAt: at.toISOString(), panes: [convBinding, coordBinding, devBinding]
        })
      }),
      getRoleBinding: async (selector: string) => ({
        ok: true as const,
        value: selector === "coordinator" ? coordBinding : selector === "conversation" ? convBinding : devBinding
      }),
      inspectRoleHealth
    }
  } as unknown as AgenticRuntimePorts;

  const journalDirectory = join(root, "journal");
  const open = () => new AgenticJournal(journalDirectory, root);
  const call = <T>(action: (outbox: HerdrOutbox, state: JournalState, save: () => Promise<void>) => Promise<T>) =>
    open().exclusive((state, save) => action(new HerdrOutbox(ports, state, save), state, save));

  const onBound = async (out: Outbound) => {
    if (out.message.type !== "task.assignment") return;
    const snapshot = unwrap(await engine.getSnapshot("run-1"))!, task = snapshot.tasks[0]!;
    if (task.agentExecution) return;
    unwrap(await engine.bindAgentExecution({
      runId: "run-1", taskId: "implement", expectedVersion: snapshot.version, attempt: task.attempt,
      handle: out.handle!, idempotencyKey: `bind:${out.handle!.requestId}`, occurredAt: at.toISOString()
    }));
  };

  await call(async (outbox, state, save) => {
    const specification = draft("api");
    state.runs.push({
      runId: "run-1",
      delegation: DelegationRequestSchema.parse({
        schemaVersion: 2, delegationId: "delegation", messageId: "intake", correlationId: "correlation",
        sessionId: "session-1", runId: "run-1", requestedBy: "conversation", targetRole: "coordinator",
        title: "Live runtime blockers test", objective: "Deliver verified behavior", specificationId: specification.specId,
        sddLevel: specification.level, acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [],
        priority: "normal", requestedAt: at.toISOString(), idempotencyKey: "intake"
      }),
      status: "implementing",
      tasks: [{
        taskId: "implement",
        spec: {
          specification,
          strategy: specification.testStrategy!,
          request: ApprovalRequestSchema.parse({
            schemaVersion: 2, approvalId: "approval", runId: "run-1", target: { type: "run" },
            revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: at.toISOString(),
            reason: "Accept design", evidence: [], idempotencyKey: "approve"
          })
        },
        worktrees: [],
        outboundIds: ["assignment"],
        writerReleased: false
      }],
      maxIterations: 3,
      coreCreated: true,
      cancelled: false
    });
    const assignment = RoleMessageSchema.parse({
      schema_version: 2, message_id: "assignment", correlation_id: "correlation", run_id: "run-1",
      sender: { role: "coordinator" },
      recipient: { role: "developer", agent_id: "developer", pane_id: "pane-developer" },
      type: "task.assignment",
      payload: { phase: "implementation_authorized", taskId: "implement" },
      artifact_references: [], occurred_at: at.toISOString(), idempotency_key: "assignment"
    });
    outbox.enqueue(assignment, "developer", "implement", attemptId, ["implementation"]);
    await save();
    await outbox.flush(onBound);
  });

  return {
    root,
    ports,
    transport,
    journalDirectory,
    open,
    call,
    onBound,
    inspectRoleHealth,
    now: () => at,
    clock: (ms: number) => { at = new Date(at.getTime() + ms); },
    setCoordReady: (value: boolean) => { coordReady = value; },
    setDevReady: (value: boolean) => { devReady = value; },
    replaceCoordinatorPane: (paneId: string, sessionId: string) => {
      coordBinding = PaneBindingSchema.parse({
        ...coordBinding,
        bindingId: `coordinator-${paneId}`,
        paneId,
        session: { source: "herdr:claude", kind: "id", value: sessionId }
      });
    }
  };
}

describe.skipIf(process.platform !== "linux")("live runtime blockers regressions", () => {
  it("Blocker 1a: preserves human-readable verdict/headline on oversized >4096B verification.result and conversation.progress notices without false truncation alarms", async () => {
    const root = await tempDir("bflow-blocker1-notices-");
    const receipts = new HostReceiptJournal(join(root, "receipts"), root, "session-1");
    const bigChecks = Array.from({ length: 40 }, (_, index) => ({
      checkId: `check-${index}`,
      name: `suite-${index}`,
      passed: true,
      output: "ok ".repeat(50)
    }));

    // 1. Oversized verification.result with explicit summary prose
    await receipts.appendConversationNotice(RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "ver-summary-big",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "verification.result",
      payload: {
        title: "Cập nhật giao diện Web",
        status: "passed",
        summary: "Tất cả 12 kiểm tra đơn vị và tích hợp đều đạt",
        checks: bigChecks
      },
      artifact_references: [],
      idempotency_key: "ver-summary-big"
    }));

    // 2. Oversized verification.result with bare status enum (no summary field)
    await receipts.appendConversationNotice(RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "ver-status-big",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "verification.result",
      payload: {
        status: "passed",
        checks: bigChecks
      },
      artifact_references: [],
      idempotency_key: "ver-status-big"
    }));

    // 3. Oversized verification.result with escalation.reason
    await receipts.appendConversationNotice(RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "ver-escalation-big",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "verification.result",
      payload: {
        status: "blocked",
        escalation: { reason: "Sandbox Bubblewrap thiếu quyền userns trên máy này" },
        checks: bigChecks
      },
      artifact_references: [],
      idempotency_key: "ver-escalation-big"
    }));

    // 4. Oversized conversation.progress with headline
    await receipts.appendConversationNotice(RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "prog-headline-big",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "coordinator" },
      recipient: { role: "conversation" },
      type: "conversation.progress",
      payload: {
        sdlcStatus: "integrating",
        headline: "Hoàn tất đồng bộ nhánh tính năng trước khi bàn giao",
        diagnostics: bigChecks
      },
      artifact_references: [],
      idempotency_key: "prog-headline-big"
    }));

    // 5. Genuinely truncated conversation.clarification where questions[] were lost in >4096B summary MUST still warn
    await receipts.appendConversationNotice(RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "clarify-truncated-questions",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "coordinator" },
      recipient: { role: "conversation" },
      type: "conversation.clarification",
      payload: {
        headline: "Cần làm rõ hai chi tiết",
        padding: "x".repeat(5000),
        questions: ["Giữ tương thích API v1 không?"]
      },
      artifact_references: [],
      idempotency_key: "clarify-truncated-questions"
    }));

    const notices = Object.fromEntries((await receipts.unsurfacedConversationNotices()).map(item => [item.messageId, item]));

    expect(notices["ver-summary-big"]!.truncated).toBe(true);
    const renderedSummary = renderConversationNotice(notices["ver-summary-big"]!);
    expect(renderedSummary.display).toContain("Tất cả 12 kiểm tra đơn vị và tích hợp đều đạt");
    expect(renderedSummary.display).not.toContain("bị cắt ngắn");

    expect(notices["ver-status-big"]!.truncated).toBe(true);
    const renderedStatus = renderConversationNotice(notices["ver-status-big"]!);
    expect(renderedStatus.display).toContain("Kết quả kiểm tra đạt yêu cầu");
    expect(renderedStatus.display).not.toContain("bị cắt ngắn");
    expect(renderedStatus.display).not.toMatch(/\bpassed\b/i);

    expect(notices["ver-escalation-big"]!.truncated).toBe(true);
    const renderedEscalation = renderConversationNotice(notices["ver-escalation-big"]!);
    expect(renderedEscalation.display).toContain("Sandbox Bubblewrap thiếu quyền userns trên máy này");
    expect(renderedEscalation.display).not.toContain("bị cắt ngắn");

    expect(notices["prog-headline-big"]!.truncated).toBe(true);
    const renderedProgress = renderConversationNotice(notices["prog-headline-big"]!);
    expect(renderedProgress.display).toContain("Hoàn tất đồng bộ nhánh tính năng trước khi bàn giao");
    expect(renderedProgress.display).not.toContain("bị cắt ngắn");

    expect(notices["clarify-truncated-questions"]!.truncated).toBe(true);
    const renderedClarify = renderConversationNotice(notices["clarify-truncated-questions"]!);
    expect(renderedClarify.display).toContain("Cần làm rõ hai chi tiết");
    expect(renderedClarify.display).toContain("bị cắt ngắn");
  });

  it("Blocker 1b: Claude/Agy inbox nudge context tells Conversation that updates are already supplied and avoids redundant read_updates calls", () => {
    const notice = {
      messageId: "notice-1",
      type: "conversation.progress",
      senderRole: "coordinator",
      runId: "run-1",
      runLabel: "Việc #1: Thêm tooltip",
      summary: JSON.stringify({ headline: "Đang kiểm tra tích hợp" }),
      truncated: false
    };
    const buildNudge = (hostModule as Record<string, unknown>).buildConversationNudgeContext as ((reply: unknown) => string) | undefined;
    expect(typeof buildNudge).toBe("function");
    const context = buildNudge!({ notices: [notice] });
    expect(context).toContain("MUST SHOW TO USER:");
    expect(context).toContain(renderConversationNotice(notice).display);
    expect(context).toContain("không cần gọi lại read_updates");
    expect(context).not.toContain("Nếu cần xem lại các cập nhật đang chờ, hãy gọi read_updates.");
    for (const forbidden of ['{"', "messageId", "message_id", "payload", "notice-1"]) {
      expect(context).not.toContain(forbidden);
    }
    expect(buildNudge!({ notices: [] })).toContain("No new Runtime updates.");
  });

  it("Blocker 2: executeHostWatchdogPass aborts cleanly without TypeError when manifest clears or host quiesces across await boundaries", async () => {
    const executeWatchdog = (hostModule as Record<string, unknown>).executeHostWatchdogPass as ((deps: unknown) => Promise<void>) | undefined;
    expect(typeof executeWatchdog).toBe("function");

    const activeManifest = SessionManifestSchema.parse({
      schemaVersion: 2,
      sessionId: "session-1",
      projectName: "bflow-test",
      workspaceRoot: "/tmp/bflow-test",
      herdrWorkspaceId: "workspace",
      herdrTabId: "tab",
      conversationSessionId: "conv-session-1",
      status: "up",
      activeRunIds: ["run-1"],
      attachTarget: { role: "conversation", paneId: "pane-conversation" },
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      panes: [
        PaneBindingSchema.parse({
          schemaVersion: 2,
          bindingId: "conv-binding",
          sessionId: "session-1",
          role: "conversation",
          agentId: "conversation",
          paneId: "pane-conversation",
          workspaceId: "workspace",
          tabId: "tab",
          provider: "claude",
          agentKind: "claude",
          cwd: "/tmp/bflow-test",
          readOnlyWorkspace: true,
          isolationMode: "dedicated_pane",
          transportState: "idle",
          boundAt: "2026-11-01T00:00:00.000Z",
          session: { source: "herdr:claude", kind: "id", value: "conv-native" }
        }),
        PaneBindingSchema.parse({
          schemaVersion: 2,
          bindingId: "coord-binding",
          sessionId: "session-1",
          role: "coordinator",
          agentId: "coordinator",
          paneId: "pane-coordinator",
          workspaceId: "workspace",
          tabId: "tab",
          provider: "claude",
          agentKind: "claude",
          cwd: "/tmp/bflow-test",
          readOnlyWorkspace: true,
          isolationMode: "dedicated_pane",
          transportState: "idle",
          boundAt: "2026-11-01T00:00:00.000Z",
          session: { source: "herdr:claude", kind: "id", value: "coord-native" }
        })
      ]
    });

    let currentManifest: SessionManifest | undefined = activeManifest;
    let quiesced = false;
    const closing = false;
    const watchdogSnapshot = vi.fn(async () => []);
    const reportRunStalled = vi.fn(async () => undefined);
    const workspace = {
      runtime: {
        resumeRecoverableRuns: vi.fn(async () => {
          // Simulate host deactivation / manifest clearing while resumeRecoverableRuns awaits I/O
          currentManifest = undefined;
        }),
        watchdogSnapshot,
        reportWorkflowBlocked: vi.fn(async () => undefined),
        reportRunStalled,
        ports: { panes: { getManifest: vi.fn() } }
      },
      conversation: { reconcileApprovals: vi.fn(async () => undefined) }
    };

    await expect(executeWatchdog!({
      readState: () => ({ workspace, manifest: currentManifest, quiesced, closing }),
      receipts: { conversationNoticeStates: vi.fn(async () => []), appendConversationNotice: vi.fn(), resurfaceConversationNotice: vi.fn() },
      inbox: { forget: vi.fn() },
      activeHostVerifications: new Map<string, number>(),
      watchdogReported: new Set<string>(),
      observeAgent: vi.fn(async () => ({ status: "idle" })),
      now: Date.now()
    })).resolves.toBeUndefined();
    expect(watchdogSnapshot).not.toHaveBeenCalled();

    // Also verify quiescing mid-snapshot stops before reporting false stalls into a quiesced runtime
    currentManifest = activeManifest;
    workspace.runtime.resumeRecoverableRuns.mockImplementationOnce(async () => undefined);
    watchdogSnapshot.mockImplementationOnce(async () => {
      quiesced = true;
      return [{
        runId: "run-1",
        status: "implementing",
        live: true,
        lastActivityAt: 0,
        awaitingHuman: false,
        activeHandoff: false,
        runtimeWork: false,
        acceptedRoles: [],
        acceptedPanes: [],
        pendingDecisions: [],
        pendingDecisionRequests: []
      }] as never;
    });

    await expect(executeWatchdog!({
      readState: () => ({ workspace, manifest: currentManifest, quiesced, closing }),
      receipts: { conversationNoticeStates: vi.fn(async () => []), appendConversationNotice: vi.fn(), resurfaceConversationNotice: vi.fn() },
      inbox: { forget: vi.fn() },
      activeHostVerifications: new Map<string, number>(),
      watchdogReported: new Set<string>(),
      observeAgent: vi.fn(async () => ({ status: "idle" })),
      now: Date.now()
    })).resolves.toBeUndefined();
    expect(reportRunStalled).not.toHaveBeenCalled();
  });

  it("Blocker 3: canEnqueueTaskNotice returns false when task.writerReleased is true even before outbox flushes parent to released", async () => {
    const f = await runtimeFixture();
    const runtime = new AgenticWorkflowRuntime(f.ports, { journalDirectory: f.journalDirectory, repositoryPath: f.root });

    await f.call(async (outbox, state, save) => {
      const parent = state.outbound.find(item => item.message.message_id === "assignment")!;
      expect(parent.status).toBe("accepted");
      state.runs[0]!.tasks[0]!.writerReleased = true;

      // Mirror check: HerdrOutbox.enqueueTaskNotice rejects writerReleased parents synchronously...
      const probe = RoleMessageSchema.parse({
        schema_version: 2, message_id: "probe-notice", correlation_id: "correlation", run_id: "run-1",
        sender: { role: "coordinator" },
        recipient: { role: "developer", agent_id: "developer", pane_id: "pane-developer" },
        type: "task.status",
        payload: { phase: "implementation_authorized", taskId: "implement" },
        artifact_references: [], occurred_at: f.now().toISOString(), idempotency_key: "probe-notice"
      });
      expect(() => outbox.enqueueTaskNotice(probe, parent)).toThrow("Task notice parent execution is stopped or terminal");

      // ...so AgenticWorkflowRuntime.canEnqueueTaskNotice MUST also return false!
      const canEnqueue = (runtime as unknown as {
        canEnqueueTaskNotice(journalState: JournalState, parentAssignment: Outbound | undefined): boolean;
      }).canEnqueueTaskNotice(state, parent);
      expect(canEnqueue).toBe(false);
      await save();
    });
  });

  it("Blocker 4: HerdrOutbox.flush releases accepted Coordinator transport messages when session restart replaced the Coordinator paneId", async () => {
    const f = await runtimeFixture();
    // Coordinator receives an approval.decision on pane-coordinator-old and stays busy when session goes down
    f.setCoordReady(true);
    await f.call(async (outbox, _state, save) => {
      const decisionMsg = RoleMessageSchema.parse({
        schema_version: 2,
        message_id: "approval-decision-old-pane",
        correlation_id: "correlation",
        run_id: "run-1",
        sender: { role: "runtime" },
        recipient: { role: "coordinator" },
        type: "approval.decision",
        payload: { approvalId: "approval", status: "approved", decidedBy: "user-1", decidedAt: f.now().toISOString() },
        artifact_references: [],
        occurred_at: f.now().toISOString(),
        idempotency_key: "approval-decision-old-pane"
      });
      outbox.enqueue(decisionMsg, "coordinator", "approval-wakeup", "attempt-approval-1", ["repository.read"]);
      await save();
      await outbox.flush(f.onBound);
    });

    await f.call(async (_outbox, state) => {
      const oldOut = state.outbound.find(item => item.message.message_id === "approval-decision-old-pane")!;
      expect(oldOut.status).toBe("accepted");
      expect(oldOut.handle?.target.paneId).toBe("pane-coordinator-old");
    });

    // Simulate `bflow down && bflow up`: Coordinator now runs on a new paneId, and its old lease expires (or session restarted)
    f.replaceCoordinatorPane("pane-coordinator-new", "coord-session-new");
    f.clock(305_000);
    f.inspectRoleHealth.mockClear();

    // First flush after restart MUST settle the stale Coordinator transport message to "released"
    await f.call(async (outbox, state) => {
      await outbox.flush(f.onBound);
      const oldOut = state.outbound.find(item => item.message.message_id === "approval-decision-old-pane")!;
      expect(oldOut.status).toBe("released");
    });

    // Subsequent flushes MUST NOT keep polling inspectRoleHealth("coordinator") forever for that settled message,
    // AND a new Coordinator message on the new pane MUST acquire the Coordinator Registry slot without lease_conflict!
    f.inspectRoleHealth.mockClear();
    await f.call(async (outbox) => {
      await outbox.flush(f.onBound);
    });
    const coordinatorPolls = f.inspectRoleHealth.mock.calls.filter(([selector]) => selector === "coordinator");
    expect(coordinatorPolls).toHaveLength(0);

    await f.call(async (outbox, state, save) => {
      const newResume = RoleMessageSchema.parse({
        schema_version: 2,
        message_id: "resume-new-pane",
        correlation_id: "correlation",
        run_id: "run-1",
        sender: { role: "runtime" },
        recipient: { role: "coordinator" },
        type: "task.status",
        payload: { kind: "resume_run", taskId: "implement" },
        artifact_references: [],
        occurred_at: f.now().toISOString(),
        idempotency_key: "resume-new-pane"
      });
      outbox.enqueue(newResume, "coordinator", "resume-wakeup", "attempt-resume-2", ["repository.read"]);
      await save();
      await outbox.flush(f.onBound);
      const freshOut = state.outbound.find(item => item.message.message_id === "resume-new-pane")!;
      expect(freshOut.status).toBe("accepted");
      expect(freshOut.handle?.target.paneId).toBe("pane-coordinator-new");
    });

    // Also verify a quick (< 300s TTL) session restart immediately frees the Coordinator transport slot without waiting 5 minutes
    f.replaceCoordinatorPane("pane-coordinator-third", "coord-session-third");
    f.clock(10_000);
    await f.call(async (outbox, state, save) => {
      await outbox.flush(f.onBound);
      const replacedWithinTtl = state.outbound.find(item => item.message.message_id === "resume-new-pane")!;
      expect(replacedWithinTtl.status).toBe("released");

      const immediateWakeup = RoleMessageSchema.parse({
        schema_version: 2,
        message_id: "resume-third-pane",
        correlation_id: "correlation",
        run_id: "run-1",
        sender: { role: "runtime" },
        recipient: { role: "coordinator" },
        type: "task.status",
        payload: { kind: "resume_run", taskId: "implement" },
        artifact_references: [],
        occurred_at: f.now().toISOString(),
        idempotency_key: "resume-third-pane"
      });
      outbox.enqueue(immediateWakeup, "coordinator", "resume-wakeup-3", "attempt-resume-3", ["repository.read"]);
      await save();
      await outbox.flush(f.onBound);
      const thirdOut = state.outbound.find(item => item.message.message_id === "resume-third-pane")!;
      expect(thirdOut.status).toBe("accepted");
      expect(thirdOut.handle?.target.paneId).toBe("pane-coordinator-third");
    });
  });

  it("Blocker 5: callHost always rejects (never leaves an unresolved promise) on object or malformed error payloads", async () => {
    const root = await tempDir("bflow-blocker5-proto-");
    const socketPath = join(root, "proto.sock");
    const replies: unknown[] = [
      { ok: false, error: { message: "unpinned envelope" } },
      { ok: false, error: null }
    ];
    const server = createServer(socket => {
      let input = "";
      socket.on("data", chunk => {
        input += String(chunk);
        if (!input.includes("\n")) return;
        socket.end(JSON.stringify(replies.shift() ?? { ok: false }) + "\n");
      });
    });
    await new Promise<void>(resolve => server.listen(socketPath, () => resolve()));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));

    await expect(callHost(socketPath, "tok", "agy_native_turn", {}, 2_000)).rejects.toThrow("unpinned envelope");
    await expect(callHost(socketPath, "tok", "agy_native_turn", {}, 2_000)).rejects.toThrow();
  });
});
