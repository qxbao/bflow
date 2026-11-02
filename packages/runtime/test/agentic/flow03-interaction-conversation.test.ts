import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalRequestSchema, RoleMessageSchema, WebCommandSchema } from "@bflow/contracts";
import { HostChat, ChatPreDispatchError } from "../../src/interaction/chat.js";
import { availableActions } from "../../src/interaction/actions.js";
import { hostInteractionQuery } from "../../src/interaction/views.js";
import { interactionProjectId } from "../../src/interaction/client.js";
import { structuredHostFixture } from "../interaction/structured-host-fixture.js";
import { at, pending, run, state } from "../interaction/fixtures.js";
import { unwrap } from "../helpers/agentic-integration-fixture.js";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Slice 03: Interaction, Structured Commands, Chat Delivery & Conversation Gateway", () => {
  it("Vector 1 & 2: preserves slash-route user_decision options in hostInteractionQuery while still redacting host secrets, allowing end-to-end Web selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "flow03-query-options-"));
    tempDirs.push(root);
    const repositoryPath = join(root, "repo");
    const hostDir = join(root, "state/host/host-1");
    const manifestDir = join(repositoryPath, ".bflow/state/panes");
    await mkdir(hostDir, { recursive: true });
    await mkdir(manifestDir, { recursive: true });
    await mkdir(join(root, "state/agentic/journal"), { recursive: true });

    const secretToken = "sec-tok-991122334455";
    const socketPath = join(hostDir, "host.sock");
    await writeFile(
      join(manifestDir, "host-1.manifest.json"),
      JSON.stringify({
        schemaVersion: 2,
        sessionId: "host-1",
        projectName: "Flow03",
        workspaceRoot: repositoryPath,
        herdrWorkspaceId: "ws",
        herdrTabId: "tab",
        status: "up",
        conversationSessionId: "conversation-1",
        activeRunIds: ["run-1"],
        panes: [
          {
            schemaVersion: 2,
            bindingId: "b-conv",
            sessionId: "host-1",
            role: "conversation",
            agentId: "conv",
            workspaceId: "ws",
            tabId: "tab",
            paneId: "pane-conv",
            provider: "claude",
            agentKind: "claude",
            cwd: repositoryPath,
            isolationMode: "dedicated_pane",
            readOnlyWorkspace: true,
            transportState: "idle",
            boundAt: at
          },
          {
            schemaVersion: 2,
            bindingId: "b-coord",
            sessionId: "host-1",
            role: "coordinator",
            agentId: "coord",
            workspaceId: "ws",
            tabId: "tab",
            paneId: "pane-coord",
            provider: "claude",
            agentKind: "claude",
            cwd: repositoryPath,
            isolationMode: "dedicated_pane",
            readOnlyWorkspace: true,
            transportState: "idle",
            boundAt: at
          }
        ],
        attachTarget: { role: "conversation", paneId: "pane-conv" },
        createdAt: at,
        updatedAt: at
      })
    );

    const r = run("run-1", { status: "implementing" });
    r.userDecisions = {
      "apr-route": {
        request: ApprovalRequestSchema.parse({
          schemaVersion: 2,
          approvalId: "apr-route",
          runId: "run-1",
          sessionId: "conversation-1",
          status: "pending",
          target: { type: "task", taskId: "task-1" },
          revision: 1,
          generation: 0,
          requestedBy: "architect",
          requestedAt: at,
          reason: `Choose public endpoint (token=${secretToken} ${socketPath})`,
          evidence: [],
          idempotencyKey: "apr-route",
          metadata: {
            kind: "user_decision",
            question: "Choose public endpoint",
            options: [
              "Keep /api/v1/users",
              "Migrate to /api/v2/users",
              `Leak ${secretToken} at ${repositoryPath}/internal`
            ]
          }
        }),
        role: "architect",
        agentId: "arch-1",
        paneId: "pane-arch",
        taskId: "task-1",
        status: "pending"
      }
    };
    await writeFile(
      join(root, "state/agentic/journal/state.json"),
      JSON.stringify({ ...state([r]), repository: repositoryPath })
    );

    const projectId = interactionProjectId(repositoryPath);
    const queried = await hostInteractionQuery(
      {
        repositoryPath,
        sessionId: "host-1",
        directory: hostDir,
        socketPath,
        token: secretToken,
        herdrBinary: "herdr"
      },
      { kind: "run", projectId, runId: "run-1" },
      { ready: true, commandsSupported: true }
    );
    expect(queried.ok).toBe(true);
    if (!queried.ok) return;
    const projectedDecision = queried.value.decisions.find(d => d.decisionId === "apr-route")!;
    expect(projectedDecision.options[0]).toBe("Keep /api/v1/users");
    expect(projectedDecision.options[1]).toBe("Migrate to /api/v2/users");
    expect(projectedDecision.options[2]).not.toContain(secretToken);
    expect(projectedDecision.options[2]).not.toContain(repositoryPath);
    expect(JSON.stringify(queried)).not.toContain(secretToken);
    expect(JSON.stringify(queried)).not.toContain(socketPath);
  });

  it("Vector 1: rejects invalid user_decision outcomes and reason-less test-integrity approvals in HostStructuredCommands without poisoning pending decisions", async () => {
    const f = await structuredHostFixture();
    const runId = await f.create();
      await f.journal.exclusive(async (s, save) => {
        const r = s.runs.find(item => item.runId === runId)!;
        r.status = "verifying";
        r.userDecisions = {
          "apr-ti-1": {
            request: ApprovalRequestSchema.parse({
              schemaVersion: 2,
              approvalId: "apr-ti-1",
              runId,
              sessionId: "session-1",
              status: "pending",
              target: { type: "task", taskId: "task-1" },
              revision: 1,
              generation: 0,
              requestedBy: "reviewer",
              requestedAt: new Date().toISOString(),
              reason: "Approve test-integrity exception?",
              evidence: [],
              idempotencyKey: "apr-ti-1",
                metadata: {
                  kind: "user_decision",
                  testIntegrityException: {
                    runId,
                    taskId: "task-1",
                    attemptId: "attempt-1",
                    baseRevision: "a".repeat(40),
                    candidateRevision: "b".repeat(40),
                    specFingerprint: "c".repeat(64),
                    scope: "task",
                    reviewMessageId: "review-msg-1",
                    findingId: "TI-1",
                    evidence: {
                      trust: "stored",
                      artifactId: "ti-evidence-1",
                      runId,
                      taskId: "task-1",
                      kind: "test-result",
                      uri: "artifact://test/ti-evidence-1",
                      mediaType: "application/json",
                      checksum: { algorithm: "sha256", value: "d".repeat(64) },
                      createdAt: at
                    }
                  },
                  question: "Approve test-integrity exception?",
                  options: ["Approve test-integrity exception", "Reject test-integrity exception"]
                }
            }),
            role: "reviewer",
            agentId: "rev-1",
            paneId: "pane-rev",
            taskId: "task-1",
            status: "pending"
          },
          "apr-open-1": {
            request: ApprovalRequestSchema.parse({
              schemaVersion: 2,
              approvalId: "apr-open-1",
              runId,
              sessionId: "session-1",
              status: "pending",
              target: { type: "task", taskId: "task-1" },
              revision: 1,
              generation: 0,
              requestedBy: "developer",
              requestedAt: new Date().toISOString(),
              reason: "What retry backoff should we use?",
              evidence: [],
              idempotencyKey: "apr-open-1",
              metadata: {
                kind: "user_decision",
                question: "What retry backoff should we use?"
              }
            }),
            role: "developer",
            agentId: "dev-1",
            paneId: "pane-dev",
            taskId: "task-1",
            status: "pending"
          }
        };
        await save();
      });
      await f.chat.reconcileApprovals();
      const view = await f.runView(runId);
      const tiDecision = view.decisions.find(d => d.decisionId === "apr-ti-1")!;
      const openDecision = view.decisions.find(d => d.decisionId === "apr-open-1")!;

      // 1. changes_requested on user_decision is rejected before acceptance
      const changesCmd = WebCommandSchema.parse({
        apiVersion: 1,
        commandId: randomUUID(),
        projectId: "project-1",
        kind: "answer_decision",
        runId,
        decisionId: tiDecision.decisionId,
        expectedVersion: tiDecision.expectedVersion,
        outcome: "changes_requested",
        reason: "Change this",
        selectedOption: "Approve test-integrity exception"
      });
      expect(await f.commands.execute(changesCmd, f.proof(changesCmd))).toMatchObject({
        ok: false,
        error: { code: "validation", details: { reason: "operation_not_allowed" } }
      });

      // 2. Approving test-integrity exception without owner reason is rejected
      const reasonlessTiCmd = WebCommandSchema.parse({
        apiVersion: 1,
        commandId: randomUUID(),
        projectId: "project-1",
        kind: "answer_decision",
        runId,
        decisionId: tiDecision.decisionId,
        expectedVersion: tiDecision.expectedVersion,
        outcome: "approved",
        selectedOption: "Approve test-integrity exception"
      });
      expect(await f.commands.execute(reasonlessTiCmd, f.proof(reasonlessTiCmd))).toMatchObject({
        ok: false,
        error: { code: "validation", details: { reason: "operation_not_allowed" } }
      });

      // 3. Open-ended user_decision without reason text is rejected
      const blankOpenCmd = WebCommandSchema.parse({
        apiVersion: 1,
        commandId: randomUUID(),
        projectId: "project-1",
        kind: "answer_decision",
        runId,
        decisionId: openDecision.decisionId,
        expectedVersion: openDecision.expectedVersion,
        outcome: "approved"
      });
      expect(await f.commands.execute(blankOpenCmd, f.proof(blankOpenCmd))).toMatchObject({
        ok: false,
        error: { code: "validation", details: { reason: "operation_not_allowed" } }
      });

      // 4. Subsequent valid answers still succeed cleanly because nothing was poisoned
      const validTiCmd = WebCommandSchema.parse({
        apiVersion: 1,
        commandId: randomUUID(),
        projectId: "project-1",
        kind: "answer_decision",
        runId,
        decisionId: tiDecision.decisionId,
        expectedVersion: tiDecision.expectedVersion,
        outcome: "approved",
        selectedOption: "Approve test-integrity exception",
        reason: "Documented temporary waiver at exact candidate revision"
      });
      expect(await f.commands.execute(validTiCmd, f.proof(validTiCmd))).toMatchObject({ ok: true });
  });

  it("Vector 1 & 4: preserves follow-up lineage across Web revise_request and advances Conversation activeRunId & completed child status across changes_requested", async () => {
    const f = await structuredHostFixture();
    const parentRunId = await f.create();
      const designDecision = await f.approval(parentRunId);
      const changesCmd = WebCommandSchema.parse({
        apiVersion: 1,
        commandId: randomUUID(),
        projectId: "project-1",
        kind: "answer_decision",
        runId: parentRunId,
        decisionId: designDecision.decisionId,
        expectedVersion: designDecision.expectedVersion,
        outcome: "changes_requested",
        reason: "Split export into streaming chunks"
      });
      expect(await f.commands.execute(changesCmd, f.proof(changesCmd))).toMatchObject({ ok: true });

      // Deliver queued approval.decision into Runtime so follow-up child run is created
      const snap = (await f.runtime.inspect()) as any;
      const decisionMsg = snap.outbound.find((o: any) => o.message.type === "approval.decision" && o.message.run_id === parentRunId)!.message;
      await f.runtime.receiveHerdr(decisionMsg);

      const parentViewBefore = await f.runView(parentRunId);
      const childRunId = parentViewBefore.continuedAsRunId!;
      expect(childRunId).toBe(`${parentRunId}-r2`);

      // Conversation context reconciliation must advance activeRunId to childRunId
      const ctx1 = (await f.chat.getContext()) as any;
      expect(ctx1.session.activeRunId).toBe(childRunId);

      // Revise childRunId via Web revise_request before Core starts
      const childViewBefore = await f.runView(childRunId);
      const reviseAction = childViewBefore.availableActions.find(a => a.kind === "revise_request")!;
      expect(reviseAction.enabled).toBe(true);
      const reviseCmd = WebCommandSchema.parse({
        apiVersion: 1,
        commandId: randomUUID(),
        projectId: "project-1",
        kind: "revise_request",
        runId: childRunId,
        expectedVersion: reviseAction.expectedVersion,
        objective: "Export report with streaming chunks and CSV option",
        acceptanceCriteria: [{ description: "Streams chunks cleanly", verificationMethod: "unit_test" }],
        constraints: ["Memory bounded"]
      });
      expect(unwrap(await f.commands.execute(reviseCmd, f.proof(reviseCmd))).state).toBe("applied");

      // Deliver revision delegation into Runtime
      const snap2 = (await f.runtime.inspect()) as any;
      const revMsg = snap2.outbound.find((o: any) => o.message.message_id === `web-delegation-${reviseCmd.commandId}`)!.message;
      await f.runtime.receiveHerdr(revMsg);

      // Parent -> child lineage on WebRunView MUST remain intact!
      const parentViewAfter = await f.runView(parentRunId);
      const childViewAfter = await f.runView(childRunId);
      expect(parentViewAfter.continuedAsRunId).toBe(childRunId);
      expect(parentViewAfter.currentRunId).toBe(childRunId);
      expect(childViewAfter.originRunId).toBe(parentRunId);
      expect(childViewAfter.parentRunId).toBe(parentRunId);

      // When childRunId completes while parentRunId remains 'escalated', Conversation must NOT revert workflow to parentRunId
      await f.journal.exclusive(async (s, save) => {
        const child = s.runs.find(r => r.runId === childRunId)!;
        child.status = "completed";
        await save();
      });
      const ctx2 = (await f.chat.getContext()) as any;
      const workflows = Object.values(ctx2.workflows) as any[];
      expect(workflows).toHaveLength(1);
      expect(workflows[0]).toMatchObject({ runId: childRunId, sdlcStatus: "completed" });
      expect(ctx2.session.activeRunId).toBeUndefined();
  });

  it("Vector 2: disables resume in availableActions when retiredToResume is paired with non-resume_coordinator or when approval wait is expired / blocked by another pending decision", () => {
    // 1. retiredToResume with pendingAction.kind === 'reconcile_delivery' and non-escalated status must NOT enable resume
    const r1 = run("r1", {
      status: "implementing",
      pendingAction: { ...pending, kind: "reconcile_delivery", state: "pending" }
    });
    const j1 = state([r1]);
    j1.outbound.push({
      message: RoleMessageSchema.parse({
        schema_version: 2,
        message_id: "ver-1",
        correlation_id: "c-r1",
        run_id: "r1",
        sender: { role: "coordinator" },
        recipient: { role: "qa" },
        type: "verification.requested",
        payload: { kind: "conditional_evidence", taskId: "t1", phase: "red" },
        artifact_references: [],
        occurred_at: at,
        idempotency_key: "ver-1"
      }),
      status: "cancelled",
      selector: "qa",
      taskId: "t1",
      attemptId: "a1",
      capabilities: [],
      phaseRetirement: {
        sessionId: "conversation-1",
        operationId: "ver-1",
        userId: "u1",
        userMessageId: "m1",
        blockedReplyId: "b1",
        decidedAt: at,
        disposition: "retired_without_measurement_claim"
      }
    } as any);
    const resume1 = availableActions(r1, j1, [], true, true).find(a => a.kind === "resume")!;
    expect(resume1).toMatchObject({ enabled: false, disabledReason: "action_not_pending" });

    // 2. previousStatus === 'awaiting_approval' when r.approval is missing/expired while another pending decision exists must disable resume with decision_required
    const r2 = run("r2", {
      status: "escalated",
      approvalKind: "delivery",
      pendingAction: { ...pending, previousStatus: "awaiting_approval", state: "pending" }
    });
    const otherPendingDecision = {
      decisionId: "apr-proto",
      runId: "r2",
      kind: "approval" as const,
      status: "pending" as const,
      question: "Prototype?",
      options: [],
      evidence: [],
      expectedVersion: {
        revisionToken: "a".repeat(64),
        approvalId: "apr-proto",
        target: { type: "run" as const },
        revision: 1,
        generation: 0,
        evidenceDigest: "b".repeat(64)
      }
    };
    const resume2 = availableActions(r2, state([r2]), [otherPendingDecision], true, true).find(a => a.kind === "resume")!;
    expect(resume2).toMatchObject({ enabled: false, disabledReason: "decision_required" });
  });

  it("Vector 3: HostChat reconciles observed admissions in pump() before echoing, settles rejected stale chat approvals without wedging FIFO, and handles pre-dispatch busy/session races cleanly", async () => {
    // 1. pump() after crash checks observeAdmission BEFORE re-calling admit()
    const dir1 = await mkdtemp(join(tmpdir(), "flow03-chat-pump-"));
    tempDirs.push(dir1);
    let wire1 = "";
    let admitted1 = false;
    let admitCalls = 0;
    const msg1 = {
      apiVersion: 1 as const,
      messageId: "11111111-1111-4111-8111-111111111111",
      projectId: "p",
      sessionId: "conv",
      content: "first turn"
    };
    const opts1 = {
      directory: dir1,
      projectId: "p",
      hostSessionId: "host",
      session: async () => ({ sessionId: "conv", nativeSessionId: "native", paneId: "pane", provider: "claude", ready: true, busy: false }),
      prompt: async (w: string) => { wire1 = w; },
      admit: async () => {
        admitCalls++;
        admitted1 = true;
        throw new Error("crash after durable intake");
      },
      observeAdmission: async () => (admitted1 ? { messageId: msg1.messageId } : undefined)
    };
    const chat1 = new HostChat(opts1);
    await chat1.send(msg1, "user");
    await expect(chat1.echo({ nativeSessionId: "native", paneId: "pane", prompt: wire1 })).rejects.toThrow();
    const restarted1 = new HostChat(opts1);
    await restarted1.pump();
    expect(admitCalls).toBe(1);
    expect((await restarted1.list("conv")).items[0]?.delivery).toBe("delivered");

    // 2. Deterministic stale approval rejection in echo() settles record to failed and unblocks FIFO queue for next message
    const dir2 = await mkdtemp(join(tmpdir(), "flow03-chat-stale-"));
    tempDirs.push(dir2);
    const wires2: string[] = [];
    let settledOnWeb = false;
    const staleDecision = {
      schemaVersion: 2,
      approvalId: "apr-1",
      runId: "run",
      sessionId: "conv",
      target: { type: "run" },
      revision: 1,
      generation: 0,
      decision: "approved",
      decidedBy: "user",
      decidedAt: at,
      feedbackArtifacts: [],
      idempotencyKey: "k-1"
    };
    let chat2!: HostChat;
    chat2 = new HostChat({
      directory: dir2,
      projectId: "p",
      hostSessionId: "host",
      session: async () => ({ sessionId: "conv", nativeSessionId: "native", paneId: "pane", provider: "claude", ready: true, busy: false }),
      approvalContext: async () =>
        settledOnWeb
          ? []
          : [
              {
                decisionId: "apr-1",
                runId: "run",
                kind: "approval",
                status: "pending",
                question: "Approve?",
                options: [],
                evidence: [],
                expectedVersion: {
                  revisionToken: "v1",
                  approvalId: "apr-1",
                  target: { type: "run" },
                  revision: 1,
                  generation: 0,
                  evidenceDigest: "a".repeat(64)
                }
              }
            ],
      prompt: async (w: string) => { wires2.push(w); },
      admit: async (id: string, content: string) => {
        if (content === "1") await chat2.recordApproval(id, staleDecision);
        return { messageId: id, content };
      }
    });
    const mStale = {
      apiVersion: 1 as const,
      messageId: "22222222-2222-4222-8222-222222222222",
      projectId: "p",
      sessionId: "conv",
      runId: "run",
      content: "1"
    };
    const mNext = {
      apiVersion: 1 as const,
      messageId: "33333333-3333-4333-8333-333333333333",
      projectId: "p",
      sessionId: "conv",
      runId: "run",
      content: "Xin chào tiếp theo"
    };
    await chat2.send(mStale, "user");
    settledOnWeb = true;
    await expect(chat2.echo({ nativeSessionId: "native", paneId: "pane", prompt: wires2[0]! })).rejects.toThrow(/Stale chat approval/);
    expect((await chat2.list("conv")).items.find(i => i.messageId === mStale.messageId)?.delivery).toBe("failed");

    // Subsequent chat message MUST NOT be wedged!
    await chat2.send(mNext, "user");
    expect(wires2).toHaveLength(2);
    await chat2.echo({ nativeSessionId: "native", paneId: "pane", prompt: wires2[1]! });
    expect((await chat2.list("conv")).items.find(i => i.messageId === mNext.messageId)?.delivery).toBe("delivered");

    // 3. Pre-dispatch busy race (e.g. BFLOW_INBOX_NUDGE fired right before prompt()) reverts message to 'queued' instead of poisoning as 'unknown_delivery'
    const dir3 = await mkdtemp(join(tmpdir(), "flow03-chat-predispatch-"));
    tempDirs.push(dir3);
    let nudgedRightBeforePrompt = true;
    const wires3: string[] = [];
    const chat3 = new HostChat({
      directory: dir3,
      projectId: "p",
      hostSessionId: "host",
      session: async () => ({ sessionId: "conv", nativeSessionId: "native", paneId: "pane", provider: "claude", ready: true, busy: false }),
      prompt: async (w: string) => {
        if (nudgedRightBeforePrompt) {
          throw new ChatPreDispatchError("busy", "Conversation pane nudged right before prompt");
        }
        wires3.push(w);
      },
      admit: async (id: string) => ({ messageId: id })
    });
    const mRace = {
      apiVersion: 1 as const,
      messageId: "44444444-4444-4444-8444-444444444444",
      projectId: "p",
      sessionId: "conv",
      content: "after nudge"
    };
    const queuedMsg = await chat3.send(mRace, "user");
    expect(queuedMsg.delivery).toBe("queued");
    expect(wires3).toHaveLength(0);
    nudgedRightBeforePrompt = false;
    await chat3.pump();
    expect(wires3).toHaveLength(1);
  });
});
