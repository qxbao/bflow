import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, open as openFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalRequestSchema,
  canonicalReceiptJson,
  DelegationRequestSchema,
  PaneBindingSchema,
  RoleMessageSchema,
  SessionManifestSchema,
  type PaneBinding,
  type RoleMessage
} from "@bflow/contracts";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { draft, workflow } from "../../../specification/test/fixtures.js";
import { boundConversationContext } from "../../src/agentic/conversation-context-budget.js";
import { createExecutionResolutionReader } from "../../src/agentic/execution-binding.js";
import { startHerdrReceiptIngress } from "../../src/agentic/herdr-ingress.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { AgenticJournal, parseAgenticJournalState, type JournalState, type Outbound } from "../../src/agentic/journal.js";
import { reportNativeDeliveryUncertainty } from "../../src/agentic/native-delivery-status.js";
import { HerdrOutbox, unwrap } from "../../src/agentic/outbox.js";
import { unmeasuredPolicyPhaseRequests } from "../../src/agentic/phase-recovery.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { evaluateWatchdog, type RunFacts } from "../../src/agentic/run-watchdog.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { TaskDispatcher } from "../../src/dispatcher.js";
import { recoverWorkflowRun } from "../../src/recovery.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { createSampleWorkflowDefinition, createTestHarness } from "../unit/fixtures.js";

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true });
});

async function outboxFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-slice6-")));
  cleanup.push(root);
  let at = new Date("2026-10-31T06:00:00.000Z");
  let ready = true;
  const registryFile = join(root, "registry.json");
  const registry = new FileAgentRegistry({ stateFile: registryFile, clock: () => at });
  const engine = new DeterministicWorkflowEngine();
  const transport = new FakeAgentTransport();
  const definition = workflow();
  const created = unwrap(await engine.createRun({ runId: "run-1", definition, idempotencyKey: "create", createdAt: at.toISOString() }));
  const running = unwrap(await engine.advance({ runId: "run-1", expectedVersion: created.snapshot.version, idempotencyKey: "advance", occurredAt: at.toISOString() }));
  const attemptId = running.snapshot.tasks[0]!.attemptId!;
  let devBinding: PaneBinding = PaneBindingSchema.parse({
    schemaVersion: 2, bindingId: "developer-binding", sessionId: "session-1", role: "developer",
    agentId: "developer", paneId: "pane-developer", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude",
    cwd: root, worktreePath: root, readOnlyWorkspace: false, isolationMode: "dedicated_pane", transportState: "idle",
    boundAt: at.toISOString(), session: { source: "herdr:claude", kind: "id", value: "dev-session" }
  });
  let qaReady = true;
  const qaBinding: PaneBinding = PaneBindingSchema.parse({
    schemaVersion: 2, bindingId: "qa-binding", sessionId: "session-1", role: "qa",
    agentId: "qa", paneId: "pane-qa", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude",
    cwd: root, worktreePath: root, readOnlyWorkspace: true, isolationMode: "dedicated_pane", transportState: "idle",
    boundAt: at.toISOString(), session: { source: "herdr:claude", kind: "id", value: "qa-session" }
  });
  const convBinding: PaneBinding = PaneBindingSchema.parse({
    schemaVersion: 2, bindingId: "conversation-binding", sessionId: "session-1", role: "conversation",
    agentId: "conversation", paneId: "pane-conversation", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude",
    cwd: root, readOnlyWorkspace: true, isolationMode: "dedicated_pane", transportState: "idle",
    boundAt: at.toISOString(), session: { source: "herdr:claude", kind: "id", value: "conv-session" }
  });
  const coordBinding: PaneBinding = PaneBindingSchema.parse({
    schemaVersion: 2, bindingId: "coordinator-binding", sessionId: "session-1", role: "coordinator",
    agentId: "coordinator", paneId: "pane-coordinator", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude",
    cwd: root, readOnlyWorkspace: true, isolationMode: "dedicated_pane", transportState: "idle",
    boundAt: at.toISOString(), session: { source: "herdr:claude", kind: "id", value: "coord-session" }
  });
  const ports = {
    registry, engine, transport, clock: () => at,
    roleCapabilities: { developer: ["implementation"], qa: ["repository.read"], coordinator: ["repository.read"] },
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
          createdAt: at.toISOString(), updatedAt: at.toISOString(), panes: [convBinding, coordBinding, devBinding, qaBinding]
        })
      }),
      getRoleBinding: async (selector: string) => ({
        ok: true as const,
        value: selector === "qa" ? qaBinding : selector === "coordinator" ? coordBinding : selector === "conversation" ? convBinding : devBinding
      }),
      inspectRoleHealth: async (selector: string) => {
        const b = selector === "qa" ? qaBinding : devBinding;
        const r = selector === "qa" ? qaReady : ready;
        return { ok: true as const, value: { readyForPrompt: r, occupantMatches: true, paneId: b.paneId, agentId: b.agentId } };
      }
    }
  } as unknown as AgenticRuntimePorts;
  const journalDirectory = join(root, "journal");
  const open = () => new AgenticJournal(journalDirectory, root);
  const call = <T>(action: (outbox: HerdrOutbox, state: JournalState, save: () => Promise<void>) => Promise<T>) =>
    open().exclusive((state, save) => action(new HerdrOutbox(ports, state, save), state, save));
  const message = (id: string, type: "task.assignment" | "task.status" = "task.status", payload: Record<string, unknown> = { phase: "implementation_authorized", taskId: "implement" }) =>
    RoleMessageSchema.parse({
      schema_version: 2, message_id: id, correlation_id: "correlation", run_id: "run-1",
      sender: { role: "coordinator" },
      recipient: { role: "developer", agent_id: "developer", pane_id: "pane-developer" },
      type, payload, artifact_references: [], occurred_at: at.toISOString(), idempotency_key: id
    });
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
        title: "Slice 6 test", objective: "Deliver verified behavior", specificationId: specification.specId,
        sddLevel: specification.level, acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [],
        priority: "normal", requestedAt: at.toISOString(), idempotencyKey: "intake"
      }),
      status: "implementing",
      tasks: [{
        taskId: "implement",
        spec: {
          specification, strategy: specification.testStrategy!,
          request: ApprovalRequestSchema.parse({
            schemaVersion: 2, approvalId: "approval", runId: "run-1", target: { type: "run" },
            revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: at.toISOString(),
            reason: "Accept design", evidence: [], idempotencyKey: "approve"
          })
        },
        worktrees: [], outboundIds: ["assignment"], writerReleased: false
      }],
      maxIterations: 3, coreCreated: true, cancelled: false
    });
    outbox.enqueue(message("assignment", "task.assignment"), "developer", "implement", attemptId, ["implementation"]);
    await save();
    await outbox.flush(onBound);
  });
  const parent = (state: JournalState) => state.outbound.find(out => out.message.message_id === "assignment")!;
  return {
    root, ports, registry, engine, transport, journalDirectory, open, call, message, onBound, parent,
    now: () => at,
    clock: (ms: number) => { at = new Date(at.getTime() + ms); },
    setDevReady: (v: boolean) => { ready = v; },
    setQaReady: (v: boolean) => { qaReady = v; }
  };
}

describe.skipIf(process.platform !== "linux")("Slice 6 outbox, leases, journal, ingress & watchdog hardening", () => {
  it("Cluster 1A: records unsent cancelled control-outcome task notices on expired parent lease without aborting runtime transactions", async () => {
    const f = await outboxFixture();
    const sentBefore = f.transport.sentRequests.length;
    // Expire the parent Developer assignment lease (> 300s TTL)
    f.clock(305_000);

    // Arbitrary notices MUST still throw synchronously so reminder/rejection callers fall back cleanly
    await f.call(async (outbox, state) => {
      expect(() => outbox.enqueueTaskNotice(f.message("arbitrary-notice"), f.parent(state)))
        .toThrow("Task notice parent lease is expired or mismatched");
    });

    // Control-outcome notices (policy_phase_outcome, user_decision_answer) MUST NOT crash the transaction:
    // they record a durable unsent "cancelled" notice with the lease error so phaseFailure/userDecision commits cleanly
    // and reviveUnsent can revive them if owner recovery later authorizes recoverTaskLease.
    await f.call(async (outbox, state, save) => {
      const p = f.parent(state);
      const policyNotice = outbox.enqueueTaskNotice(
        f.message("policy-outcome-1", "task.status", {
          kind: "policy_phase_outcome", phase: "red", taskId: "implement", outcome: "failed", summary: "Runner failed"
        }),
        p
      );
      expect(policyNotice.status).toBe("cancelled");
      expect(policyNotice.request).toBeUndefined();
      expect(policyNotice.handle).toBeUndefined();
      expect(policyNotice.parentAssignmentId).toBe(p.message.message_id);
      expect(policyNotice.error).toContain("Task notice parent lease is expired or mismatched");

      const decisionNotice = outbox.enqueueTaskNotice(
        f.message("decision-answer-1", "task.status", {
          kind: "user_decision_answer", approvalId: "apr-1", status: "expired", taskId: "implement"
        }),
        p
      );
      expect(decisionNotice.status).toBe("cancelled");
      expect(decisionNotice.error).toContain("Task notice parent lease is expired or mismatched");
      await save();
      await outbox.flush(f.onBound);
    });
    expect(f.transport.sentRequests).toHaveLength(sentBefore);

    // End-to-end runtime.tick() regression: unapplied phaseFailure (without implementationAttemptId) + expired pending user decision
    // under an expired Developer assignment lease MUST settle cleanly on tick() instead of crashing 6,648x in a row!
    await f.call(async (outbox, state, save) => {
      const failedPhase = outbox.enqueue(RoleMessageSchema.parse({
        ...f.message("failed-phase-no-attempt"),
        type: "verification.requested",
        recipient: { role: "qa" },
        payload: {
          kind: "conditional_evidence",
          phase: state.runs[0]!.tasks[0]!.spec.strategy.tddDecision.mode === "required" ? "red" : "verification",
          taskId: "implement",
          sourceRevision: "a".repeat(40)
        }
      }), "qa");
      failedPhase.status = "released";
      failedPhase.phaseFailure = { summary: "QA runner crashed", repairable: false, applied: false };

      state.runs[0]!.coreCreated = false;
      state.runs[0]!.userDecisions = {
        "apr-expired-1": {
          request: ApprovalRequestSchema.parse({
            schemaVersion: 2, approvalId: "apr-expired-1", runId: "run-1", target: { type: "task", taskId: "implement" },
            revision: 1, generation: 0, requestedBy: "developer", requestedAt: "2026-10-31T06:00:00.000Z",
            expiresAt: "2026-10-31T06:01:00.000Z", reason: "Clarify edge case", evidence: [], idempotencyKey: "ud-1",
            metadata: { kind: "user_decision", question: "Use strict mode?", options: ["Yes", "No"], requestedByRole: "developer" }
          }),
          role: "developer",
          paneId: "pane-developer",
          agentId: "developer",
          taskId: "implement",
          status: "pending"
        }
      };
      await save();
    });

    const runtime = new AgenticWorkflowRuntime(f.ports, { journalDirectory: f.journalDirectory, repositoryPath: f.root });
    await expect(runtime.tick()).resolves.toBeDefined();
    await f.call(async (_outbox, state) => {
      const failedPhase = state.outbound.find(item => item.message.message_id === "failed-phase-no-attempt")!;
      expect(failedPhase.phaseFailure?.applied).toBe(true);
      expect(state.runs[0]!.userDecisions?.["apr-expired-1"]?.status).toBe("expired");
    });
    expect(f.transport.sentRequests).toHaveLength(sentBefore);
  });

  it("Cluster 1B: catches expired non-assignment lease renewal in step() without spinning deliveryAttempts, and tie-breaks unmeasuredPolicyPhaseRequests", async () => {
    const f = await outboxFixture();
    await f.call(async (outbox, _state, save) => {
      outbox.enqueue(RoleMessageSchema.parse({
        ...f.message("qa-phase-1"),
        type: "verification.requested",
        recipient: { role: "qa", agent_id: "qa", pane_id: "pane-qa" },
        payload: { kind: "conditional_evidence", phase: "red", taskId: "implement", sourceRevision: "b".repeat(40) }
      }), "qa", "phase-red", "attempt-red", []);
      await save();
      await outbox.flush(f.onBound);
    });
    // QA pane stays busy past lease expiration
    f.setQaReady(false);
    f.clock(305_000);
    await f.call(async (outbox, state) => {
      await outbox.flush(f.onBound);
      const qaOut = state.outbound.find(item => item.message.message_id === "qa-phase-1")!;
      expect(qaOut.status).toBe("accepted");
      expect(qaOut.deliveryAttempts).toBeUndefined();
      expect(qaOut.error).toBeDefined();
    });

    // Tie-break two released requests for the same (taskId, phase, implementationAttemptId) with identical occurred_at
    await f.call(async (_outbox, state) => {
      const expectedPhase = state.runs[0]!.tasks[0]!.spec.strategy.tddDecision.mode === "required" ? "red" : "verification";
      const sameTime = "2026-10-31T06:00:00.000Z";
      const makePhase = (id: string): Outbound => ({
        message: RoleMessageSchema.parse({
          ...f.message(id),
          occurred_at: sameTime,
          type: "verification.requested",
          recipient: { role: "qa" },
          payload: { kind: "conditional_evidence", phase: expectedPhase, taskId: "implement", implementationAttemptId: "att-1", sourceRevision: "c".repeat(40) }
        }),
        status: "released",
        selector: "qa",
        taskId: `message-${id}`,
        attemptId: `attempt-${id}`,
        capabilities: ["repository.read"]
      });
      const older = makePhase("phase-same-ts-1");
      const newer = makePhase("phase-same-ts-2");
      const snapshot: JournalState = { ...structuredClone(state), outbound: [...structuredClone(state.outbound), older, newer] };
      const unmeasured = unmeasuredPolicyPhaseRequests(snapshot, snapshot.runs[0]!);
      expect(unmeasured.map(u => u.message.message_id)).toEqual(["phase-same-ts-2"]);
    });
  });

  it("Cluster 2: retries transient cross-process flock contention on AgenticJournal instead of immediately failing with Agentic runtime busy", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-slice6-journal-")));
    cleanup.push(root);
    const journalDir = join(root, "journal");
    const journal = new AgenticJournal(journalDir, root);
    await journal.exclusive(async (_state, save) => { await save(); });

    // Hold flock externally for 150ms in a separate OS process
    const holder = spawn("flock", [join(journalDir, "lock"), "-c", "echo locked; sleep 0.15"], { stdio: ["ignore", "pipe", "ignore"] });
    const holderClosed = new Promise<void>(resolve => {
      if (holder.exitCode !== null) resolve();
      else holder.once("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      holder.once("error", reject);
      holder.stdout!.once("data", () => resolve());
    });
    const anotherInstance = new AgenticJournal(journalDir, root);
    const result = await anotherInstance.exclusive(async state => state.version);
    expect(result).toBe(1);
    await holderClosed;

    // Also verify bounded lockWaitMs still rejects with Agentic runtime busy when lock is held past deadline
    const longHolder = spawn("flock", [join(journalDir, "lock"), "-c", "echo locked; sleep 0.35"], { stdio: ["ignore", "pipe", "ignore"] });
    const longClosed = new Promise<void>(resolve => {
      if (longHolder.exitCode !== null) resolve();
      else longHolder.once("close", () => resolve());
    });
    await new Promise<void>((resolve, reject) => {
      longHolder.once("error", reject);
      longHolder.stdout!.once("data", () => resolve());
    });
    const impatient = new AgenticJournal(journalDir, root, { lockWaitMs: 60 });
    await expect(impatient.exclusive(async state => state.version)).rejects.toThrow("Agentic runtime busy");
    await longClosed;
  });

  it("Cluster 3: keeps herdr-ingress socket alive while receive() awaits journal lock, and reconciles uncertain native deliveries already applied in Runtime inbox", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-slice6-ingress-")));
    cleanup.push(root);
    const socketPath = join(root, "ingress.sock");
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    const message = RoleMessageSchema.parse({
      schema_version: 2, message_id: "dev-result-1", correlation_id: "corr-1", run_id: "run-1",
      causation_id: "assignment", idempotency_key: "dev-result-1",
      sender: { role: "developer", agent_id: "developer", pane_id: "pane-developer" },
      recipient: { role: "coordinator" },
      type: "task.status", payload: { status: "completed", summary: "Done" }, artifact_references: [],
      occurred_at: "2026-10-31T06:00:00.000Z"
    });

    const ingress = await startHerdrReceiptIngress({
      socketPath,
      publicKeys: { "host-1": publicKey },
      readTimeoutMs: 60,
      receive: async () => {
        // Simulate waiting 160ms on a contended journal lock AFTER the packet has been received
        await new Promise(resolve => setTimeout(resolve, 160));
      }
    } as Parameters<typeof startHerdrReceiptIngress>[0] & { readTimeoutMs?: number });

    try {
      const packet = {
        issuerId: "host-1",
        message,
        signature: sign(null, Buffer.from(canonicalReceiptJson(message)), privateKey).toString("base64")
      };
      const rawReply = await new Promise<string>((resolve, reject) => {
        const client = connect(socketPath);
        let buf = "";
        client.once("error", reject);
        client.once("connect", () => client.write(JSON.stringify(packet) + "\n"));
        client.on("data", chunk => { buf += String(chunk); });
        client.once("close", () => resolve(buf));
      });
      expect(JSON.parse(rawReply.trim())).toEqual({ ok: true, messageId: "dev-result-1" });
    } finally {
      await ingress.close();
    }

    // Native delivery uncertainty reconciliation when Runtime's durable inbox ALREADY applied the exact message
    const receipts = new HostReceiptJournal(join(root, "receipts"), root, "session-1");
    await receipts.recordNativeIntent("op-applied-1", message);
    const reportUncertain = vi.fn();
    const reconcileNative = vi.fn(async () => true);
    const settled = await reportNativeDeliveryUncertainty(
      receipts,
      {
        reportUncertainNativeDelivery: reportUncertain,
        reconcileNativeDelivery: reconcileNative,
        nativeDeliveryInbox: async () => [{ message, status: "applied" as const }]
      } as Parameters<typeof reportNativeDeliveryUncertainty>[1] & { nativeDeliveryInbox?: () => Promise<unknown> },
      message,
      "op-applied-1",
      "Native ingress reply timed out"
    );
    expect(settled).toBe(true);
    expect(reportUncertain).not.toHaveBeenCalled();
    expect(reconcileNative).toHaveBeenCalledWith("dev-result-1");
    expect((await receipts.nativeDelivery("op-applied-1"))?.status).toBe("acknowledged");
  });

  it("Cluster 4: backs off ExecutionPlanDriftError in HerdrOutbox.flush() instead of hammering readExecutionResolution on every tick", async () => {
    const f = await outboxFixture();
    const profilePath = join(f.root, "profile.json");
    await writeFile(profilePath, '{"model":"pinned"}');
    const reader = await createExecutionResolutionReader({
      schemaVersion: 3,
      plan: { schemaVersion: 3, resolverVersion: "1", policyVersion: "1", mode: "intake", repository: { revision: "base" } },
      files: [{ component: "profile", path: profilePath, format: "json" }]
    });
    let reads = 0;
    f.ports.readExecutionResolution = async () => {
      reads++;
      return reader();
    };
    const pinned = await reader();
    await f.call(async (outbox, state, save) => {
      state.runs[0]!.executionPlan = pinned.plan;
      outbox.enqueue(f.message("drift-assignment", "task.assignment"), "developer", "implement", "attempt-drift", ["implementation"]);
      await save();
    });
    // Introduce drift before flush
    await writeFile(profilePath, '{"model":"drifted"}');
    reads = 0;

    await f.call(async (outbox, state) => {
      await outbox.flush(f.onBound);
      const item = state.outbound.find(o => o.message.message_id === "drift-assignment")!;
      expect(item.status).toBe("queued");
      expect(item.deliveryAttempts).toBe(1);
      expect(item.nextAttemptAt).toBeDefined();
      expect(Date.parse(item.nextAttemptAt!)).toBeGreaterThan(f.now().getTime());
    });
    const readsAfterFirstFlush = reads;

    // Immediate next tick (500ms later, still within backoff window) MUST NOT re-invoke readExecutionResolution
    f.clock(500);
    await f.call(async (outbox) => { await outbox.flush(f.onBound); });
    expect(reads).toBe(readsAfterFirstFlush);
  });

  it("Cluster 5: flags disconnected/cancelled/blocked holder panes as stalled in evaluateWatchdog, guards non-positive context budgets, and propagates RunStore appendEvents errors", async () => {
    const T0 = Date.parse("2026-10-31T06:00:00.000Z");
    const baseRun: RunFacts = {
      runId: "run-stall-1",
      status: "implementing",
      live: true,
      lastActivityAt: T0,
      awaitingHuman: false,
      activeHandoff: false,
      acceptedRoles: ["developer"],
      acceptedPanes: [{ role: "developer", paneId: "pane-dev-1" }],
      pendingDecisions: []
    };

    for (const deadStatus of ["disconnected", "cancelled", "blocked"] as const) {
      expect(evaluateWatchdog({
        now: T0 + 185_000,
        runs: [baseRun],
        notices: [],
        panes: [{ role: "developer", paneId: "pane-dev-1", status: deadStatus }]
      })).toEqual([
        { kind: "stalled", runId: "run-stall-1", episodeKey: `run-stall-1@${T0}`, idleSince: T0, holders: ["developer"] }
      ]);
    }

    for (const activeOrUnreadable of ["working", "starting", "accepted", "unavailable"] as const) {
      expect(evaluateWatchdog({
        now: T0 + 185_000,
        runs: [baseRun],
        notices: [],
        panes: [{ role: "developer", paneId: "pane-dev-1", status: activeOrUnreadable }]
      })).toEqual([]);
    }

    // Negative/zero remaining budget preserves notices/approvals while degrading history/clarifications cleanly
    const compacted = boundConversationContext({
      notices: [{ messageId: "n-1", text: "Important notice" }],
      pendingApprovals: [{ approvalId: "a-1" }],
      context: {
        messages: [{ role: "user", content: "hello" }],
        pendingClarifications: { c1: { question: "q" } },
        workflows: { wf1: { correlationId: "wf1", runId: "r1", sdlcStatus: "completed", updatedAt: "2026-10-31T06:00:00.000Z" } },
        runIdToCorrelationId: { r1: "wf1" }
      }
    }, -250) as Record<string, unknown>;
    expect(compacted.notices).toEqual([{ messageId: "n-1", text: "Important notice" }]);
    expect(compacted.pendingApprovals).toEqual([{ approvalId: "a-1" }]);
    expect((compacted.context as Record<string, unknown>).messages).toEqual([]);

    // recoverWorkflowRun & TaskDispatcher MUST propagate RunStore.appendEvents failures instead of returning ok:true with diverged state
    const harness = await createTestHarness();
    try {
      const definition = createSampleWorkflowDefinition();
      const runId = "run-store-err-1";
      const createdAt = "2026-10-31T06:00:00.000Z";
      await harness.engine.validateDefinition(definition);
      const createRes = unwrap(await harness.engine.createRun({ runId, definition, idempotencyKey: "c1", createdAt }));
      unwrap(await harness.runStore.create({ snapshot: { ...createRes.snapshot, version: 0, lastEventSequence: 0 }, definition }, "s1"));
      unwrap(await harness.runStore.appendEvents({ runId, expectedVersion: 0, expectedLastSequence: 0, events: createRes.emittedEvents, idempotencyKey: "e1" }));

      const dispatcher = new TaskDispatcher({
        engine: harness.engine,
        runStore: harness.runStore,
        agentRegistry: harness.agentRegistry,
        transport: harness.transport
      });
      unwrap(await dispatcher.scheduleReadyTasks(runId));

      // Force unknown_delivery -> reconcile bound -> fail appendEvents on reconciliation persistence
      vi.spyOn(harness.transport, "send").mockResolvedValueOnce({
        ok: true,
        value: {
          requestId: "placeholder",
          attemptId: "placeholder",
          runId,
          taskId: "plan",
          status: "unknown_delivery",
          reason: "simulated transport timeout",
          observedAt: createdAt
        } as never
      });
      const snapBefore = unwrap(await harness.engine.getSnapshot(runId))!;
      const taskBefore = snapBefore.tasks.find(t => t.taskId === "plan")!;
      vi.spyOn(harness.transport, "reconcile").mockImplementationOnce(async (req) => ({
        ok: true,
        value: {
          status: "bound",
          handle: {
            executionId: "exec-1",
            requestId: req.requestId,
            attemptId: taskBefore.attemptId!,
            runId,
            taskId: "plan",
            idempotencyKey: req.idempotencyKey,
            target: req.target,
            correlation: { token: req.requestId, provenance: "transport", verified: true },
            acceptedAt: createdAt
          }
        }
      }));
      const realAppend = harness.runStore.appendEvents.bind(harness.runStore);
      let callCount = 0;
      vi.spyOn(harness.runStore, "appendEvents").mockImplementation(async (req, opts) => {
        callCount++;
        // Call 1 is persistDispatchIntent; Call 2 is recon-events persistence
        if (callCount === 2) {
          return { ok: false, error: { code: "storage_error", message: "Simulated SQLite I/O failure", retryable: true } } as never;
        }
        return realAppend(req, opts);
      });
      const dispatchRes = await dispatcher.dispatchTask(definition, snapBefore, "plan", "Execute plan");
      expect(dispatchRes.ok).toBe(false);

      // Also verify recoverWorkflowRun (recovery.ts:213) propagates appendEvents failure during bound-task reconciliation
      vi.restoreAllMocks();
      const runId2 = "run-store-err-2";
      const createRes2 = unwrap(await harness.engine.createRun({ runId: runId2, definition, idempotencyKey: "c2", createdAt }));
      unwrap(await harness.runStore.create({ snapshot: { ...createRes2.snapshot, version: 0, lastEventSequence: 0 }, definition }, "s2"));
      unwrap(await harness.runStore.appendEvents({ runId: runId2, expectedVersion: 0, expectedLastSequence: 0, events: createRes2.emittedEvents, idempotencyKey: "e2" }));
      const adv2 = unwrap(await harness.engine.advance({ runId: runId2, expectedVersion: createRes2.snapshot.version, idempotencyKey: "adv2", occurredAt: createdAt }));
      unwrap(await harness.runStore.appendEvents({ runId: runId2, expectedVersion: createRes2.snapshot.version, expectedLastSequence: createRes2.snapshot.lastEventSequence, events: adv2.emittedEvents, idempotencyKey: "e2-adv" }));
      const boundHandle = unwrap(await dispatcher.dispatchTask(definition, adv2.snapshot, "plan", "Execute plan"));

      const freshEngine = new DeterministicWorkflowEngine({ definitions: [definition] });
      const origRecord = freshEngine.recordDeliveryReconciliation.bind(freshEngine);
      vi.spyOn(freshEngine, "recordDeliveryReconciliation").mockImplementationOnce(async (cmd, opts) => {
        const res = await origRecord(cmd, opts);
        if (!res.ok) return res;
        return {
          ok: true,
          value: {
            snapshot: { ...res.value.snapshot, version: res.value.snapshot.version + 1, lastEventSequence: res.value.snapshot.lastEventSequence + 1 },
            emittedEvents: [adv2.emittedEvents[0]!]
          }
        };
      });
      vi.spyOn(harness.transport, "reconcile").mockResolvedValueOnce({
        ok: true,
        value: { status: "bound", handle: boundHandle }
      });
      vi.spyOn(harness.runStore, "appendEvents").mockResolvedValueOnce({
        ok: false,
        error: { code: "storage_error", message: "Simulated recovery appendEvents failure", retryable: true }
      } as never);
      const recRes = await recoverWorkflowRun(runId2, { engine: freshEngine, runStore: harness.runStore, transport: harness.transport });
      expect(recRes.ok).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});
