import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentExecutionHandleSchema,
  AgentLeaseSchema,
  AgentRequestSchema,
  ApprovalRequestSchema,
  ArtifactReferenceSchema,
  DelegationRequestSchema,
  PaneBindingSchema,
  RoleMessageSchema,
  SessionManifestSchema,
  SpecificationSchema,
  TestStrategySchema,
  type PaneBinding,
  type Specification
} from "@bflow/contracts";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { openSqliteRunStore } from "@bflow/persistence";
import { draft, workflow } from "../../../specification/test/fixtures.js";
import { CoreSession } from "../../src/agentic/core-session.js";
import { HostReceiptJournal, parseConversationResumeRequest } from "../../src/agentic/host-receipts.js";
import { AgenticJournal, digest, type JournalState } from "../../src/agentic/journal.js";
import { policyPhaseReviewAssignment } from "../../src/agentic/policy-phase-review.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { AgenticWorkflowRuntime, projectTaskSpecificationInput } from "../../src/agentic/runtime.js";
import { availableActions } from "../../src/interaction/actions.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of cleanups.splice(0).reverse()) await action();
});

async function tempDir(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function approvedSpecification(runId = "run-1", at = "2026-11-01T00:00:00.000Z"): Specification {
  const base = draft("bugfix");
  return SpecificationSchema.parse({
    ...base,
    runId,
    status: "approved",
    approvedBy: "coordinator",
    createdAt: at,
    updatedAt: at,
    artifactRef: ArtifactReferenceSchema.parse({
      trust: "stored",
      artifactId: `spec-art-${runId}`,
      runId,
      kind: "document",
      uri: `artifact://store-1/spec-art-${runId}`,
      mediaType: "application/json",
      checksum: { algorithm: "sha256", value: "a".repeat(64) },
      createdAt: at
    })
  });
}

describe("Round 3 Cross-Slice Integration Fixes", () => {
  it("Cross-Slice 1: AgenticJournal.exclusive blocks true awaited re-entrancy while allowing detached post-release callbacks", async () => {
    const root = await tempDir("bflow-r3-journal-");
    const journal = new AgenticJournal(join(root, "journal"), root);

    // True awaited re-entrancy inside active lock is rejected fail-closed
    await expect(
      journal.exclusive(async () => {
        await journal.exclusive(async () => "inner");
      })
    ).rejects.toThrow(/Re-entrant AgenticJournal lock acquisition/);

    // Detached callback scheduled while holding lock runs cleanly once outer lock exits
    let scheduledResult: Promise<string> | undefined;
    await journal.exclusive(async (state, save) => {
      state.version = 3;
      await save();
      scheduledResult = new Promise<string>((resolve, reject) => {
        setTimeout(() => {
          journal
            .exclusive(async inner => `version:${inner.version}`)
            .then(resolve, reject);
        }, 10);
      });
    });

    await expect(scheduledResult).resolves.toBe("version:3");
  });

  it("Cross-Slice 2: parseConversationResumeRequest and HostReceiptJournal resolve 'việc #k' and 'việc k' session aliases", async () => {
    expect(parseConversationResumeRequest("tiếp tục việc #2")).toEqual({ runId: "việc #2" });
    expect(parseConversationResumeRequest("tiếp tục việc 2")).toEqual({ runId: "việc #2" });
    expect(parseConversationResumeRequest("vui lòng tiếp tục Việc 1 nhé")).toEqual({ runId: "việc #1" });

    const root = await tempDir("bflow-r3-resume-alias-");
    const receipts = new HostReceiptJournal(join(root, "receipts"), root, "session-1");
    const convBinding = PaneBindingSchema.parse({
      schemaVersion: 2,
      bindingId: "conv-binding",
      sessionId: "session-1",
      role: "conversation",
      agentId: "conversation",
      paneId: "pane-conv",
      workspaceId: "ws",
      tabId: "tab",
      provider: "claude",
      agentKind: "claude",
      cwd: root,
      readOnlyWorkspace: true,
      isolationMode: "dedicated_pane",
      transportState: "idle",
      boundAt: "2026-11-01T00:00:00.000Z",
      session: { source: "herdr:claude", kind: "id", value: "conv-native-1" }
    });

    // Seed notice creating canonical alias "việc #1" -> "run-alpha-123"
    await receipts.appendConversationNotice(
      RoleMessageSchema.parse({
        schema_version: 2,
        message_id: "notice-blocked-1",
        correlation_id: "corr-1",
        run_id: "run-alpha-123",
        sender: { role: "runtime" },
        recipient: { role: "conversation" },
        type: "conversation.progress",
        payload: {
          kind: "workflow_blocked",
          sdlcStatus: "escalated",
          summary: "Run tạm dừng chờ tiếp tục"
        },
        artifact_references: [],
        occurred_at: "2026-11-01T00:00:01.000Z",
        idempotency_key: "notice-blocked-1"
      })
    );
    const aliases = await receipts.noticeAliases();
    expect(aliases.runShortIds["việc #1"]).toBe("run-alpha-123");

    await receipts.recordConversationTurn({
      binding: convBinding,
      messageId: "turn-resume-1",
      conversationSessionId: "session-1",
      userId: "user-1",
      sequence: 1,
      content: "tiếp tục việc 1",
      occurredAt: "2026-11-01T00:00:05.000Z"
    });

    const authorized = await receipts.authorizedConversationResumeTurn(convBinding, "turn-resume-1", "run-alpha-123");
    expect(authorized.messageId).toBe("turn-resume-1");
  });

  it("Cross-Slice 3: projectTaskSpecificationInput keeps testStrategy.specId and tddDecision.specId valid under SpecificationSchema", () => {
    const baseSpec = draft("api");
    expect(baseSpec.level).toBe("full");
    expect(baseSpec.testStrategy).toBeDefined();
    expect(baseSpec.tddDecision).toBeDefined();

    const fullDraft = SpecificationSchema.parse(baseSpec);
    const projected = projectTaskSpecificationInput(fullDraft, "task-a", baseSpec.acceptanceCriteria, "task-a", {
      policyVersion: 1
    });
    const parsed = SpecificationSchema.parse(projected);
    expect(parsed.specId).toBe(`${baseSpec.specId}-task-a`);
    expect(parsed.testStrategy?.specId).toBe(`${baseSpec.specId}-task-a`);
    expect(parsed.testStrategy?.tddDecision.specId).toBe(`${baseSpec.specId}-task-a`);
    expect(parsed.testStrategy?.tddDecision.taskId).toBe("task-a");
    expect(parsed.tddDecision?.specId).toBe(`${baseSpec.specId}-task-a`);
    expect(parsed.tddDecision?.taskId).toBe("task-a");
  });

  it("Cross-Slice 4 & 5: admits workflow-verification in withAssignedToolAction and transitions retirePolicyPhase directly to resumable resume_coordinator", async () => {
    const root = await tempDir("bflow-r3-runtime-");
    let at = new Date("2026-11-01T00:00:00.000Z");
    const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => at });
    const engine = new DeterministicWorkflowEngine();
    const storeRes = openSqliteRunStore({ filename: join(root, "runs.db") });
    if (!storeRes.ok) throw new Error(storeRes.error.message);
    const runStore = storeRes.value;
    cleanups.push(async () => runStore.close());
    const transport = new FakeAgentTransport();

    const makeBinding = (
      role: "conversation" | "coordinator" | "developer" | "reviewer" | "qa",
      paneId: string,
      sessionVal: string
    ): PaneBinding =>
      PaneBindingSchema.parse({
        schemaVersion: 2,
        bindingId: `${role}-binding`,
        sessionId: "session-1",
        role,
        agentId: role,
        paneId,
        workspaceId: "ws",
        tabId: "tab",
        provider: "claude",
        agentKind: "claude",
        cwd: root,
        ...(role === "developer" ? { worktreePath: root } : {}),
        readOnlyWorkspace: role !== "developer",
        isolationMode: "dedicated_pane",
        transportState: "idle",
        boundAt: at.toISOString(),
        session: { source: "herdr:claude", kind: "id", value: sessionVal }
      });

    const convBinding = makeBinding("conversation", "pane-conv", "sess-conv");
    const coordBinding = makeBinding("coordinator", "pane-coord", "sess-coord");
    const devBinding = makeBinding("developer", "pane-dev", "sess-dev");
    const reviewerBinding = makeBinding("reviewer", "pane-rev", "sess-rev");
    let qaBinding = makeBinding("qa", "pane-qa-1", "sess-qa-1");

    for (const [b, caps] of [
      [coordBinding, ["repository.read"]],
      [devBinding, ["implementation"]],
      [reviewerBinding, ["review", "repository.read"]],
      [qaBinding, ["testing", "repository.read"]]
    ] as const) {
      const upserted = await registry.upsert({
        agentId: b.agentId,
        role: b.role,
        transport: "herdr",
        enabled: true,
        priority: 1,
        maxConcurrentTasks: 2,
        capabilities: [...caps],
        settings: {}
      });
      if (!upserted.ok) throw new Error(upserted.error.message);
    }

    const ports = {
      registry,
      engine,
      transport,
      clock: () => at,
      roleCapabilities: {
        coordinator: ["repository.read"],
        developer: ["implementation"],
        reviewer: ["review", "repository.read"],
        qa: ["testing", "repository.read"]
      },
      preflightRoleCapabilities: async () => undefined,
      authorizePolicyPhaseRetirement: async () => true,
      hasPolicyPhaseReceipt: async () => false,
      deliverToConversation: async () => undefined,
      conversation: { deliver: async () => ({ ok: true as const, value: {} }) },
      runStore,
      policies: {
        assertEvidenceComplete: () => undefined
      },
      panes: {
        getManifest: async () => ({
          ok: true as const,
          value: SessionManifestSchema.parse({
            schemaVersion: 2,
            sessionId: "session-1",
            projectName: "bflow",
            workspaceRoot: root,
            herdrWorkspaceId: "ws",
            herdrTabId: "tab",
            conversationSessionId: "session-1",
            status: "up",
            activeRunIds: ["run-1", "run-wf"],
            attachTarget: { role: "conversation", paneId: "pane-conv" },
            createdAt: at.toISOString(),
            updatedAt: at.toISOString(),
            panes: [convBinding, coordBinding, devBinding, reviewerBinding, qaBinding]
          })
        }),
        getRoleBinding: async (selector: string) => ({
          ok: true as const,
          value:
            selector === "coordinator"
              ? coordBinding
              : selector === "developer"
                ? devBinding
                : selector === "reviewer"
                  ? reviewerBinding
                  : selector === "qa"
                    ? qaBinding
                    : convBinding
        }),
        inspectRoleHealth: async (selector: string) => {
          const b =
            selector === "coordinator"
              ? coordBinding
              : selector === "developer"
                ? devBinding
                : selector === "reviewer"
                  ? reviewerBinding
                  : qaBinding;
          return {
            ok: true as const,
            value: { readyForPrompt: true, occupantMatches: true, paneId: b.paneId, agentId: b.agentId }
          };
        }
      }
    } as unknown as AgenticRuntimePorts;

    const journalDir = join(root, "journal");
    const runtime = new AgenticWorkflowRuntime(ports, { journalDirectory: journalDir, repositoryPath: root });
    const journal = new AgenticJournal(journalDir, root);

    // 1) Test workflow-verification admission in withAssignedToolAction
    const revLeaseRes = await registry.acquireLease({
      leaseId: "lease-rev-wf",
      agentId: "reviewer",
      runId: "run-wf",
      taskId: "workflow-verification",
      attemptId: "attempt-wf-1",
      ttlMs: 300_000,
      requestedAt: at.toISOString(),
      idempotencyKey: "lease-rev-wf"
    });
    if (!revLeaseRes.ok) throw new Error(revLeaseRes.error.message);
    const revLease = AgentLeaseSchema.parse(revLeaseRes.value);
    const wfMessage = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "wf-review-msg-1",
      correlation_id: "corr-wf",
      run_id: "run-wf",
      sender: { role: "runtime" },
      recipient: {
        role: "reviewer",
        agent_id: reviewerBinding.agentId,
        pane_id: reviewerBinding.paneId
      },
      type: "verification.requested",
      payload: {
        taskId: "workflow-verification",
        input: { scope: "workflow" }
      },
      artifact_references: [],
      occurred_at: at.toISOString(),
      idempotency_key: "wf-review-msg-1"
    });
    const wfTarget = {
      transport: "herdr",
      agentId: "reviewer",
      workspaceId: reviewerBinding.workspaceId,
      tabId: reviewerBinding.tabId,
      paneId: reviewerBinding.paneId,
      session: reviewerBinding.session
    };
    const wfRequest = AgentRequestSchema.parse({
      requestId: "req-wf-1",
      runId: "run-wf",
      taskId: "workflow-verification",
      attemptId: "attempt-wf-1",
      role: "reviewer",
      target: wfTarget,
      instruction: JSON.stringify(wfMessage),
      inputs: [],
      context: wfMessage,
      attempt: 1,
      retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
      timeout: { executionTimeoutMs: 300_000, onTimeout: "block" },
      idempotency: { key: "req-wf-1", scope: "agent-request", fingerprint: digest(wfMessage) },
      createdAt: at.toISOString(),
      metadata: { leaseId: revLease.leaseId, fencingToken: revLease.fencingToken }
    });
    const wfHandle = AgentExecutionHandleSchema.parse({
      executionId: "exec-wf-1",
      requestId: "req-wf-1",
      runId: "run-wf",
      taskId: "workflow-verification",
      attemptId: "attempt-wf-1",
      idempotencyKey: "req-wf-1",
      target: wfTarget,
      correlation: { token: "corr-tok-wf", provenance: "transport", verified: true },
      acceptedAt: at.toISOString()
    });
    const wfSpec = approvedSpecification("run-wf", at.toISOString());
    const wfStrategy = TestStrategySchema.parse({
      schemaVersion: 2,
      strategyId: "strat-wf",
      specId: wfSpec.specId,
      tddDecision: {
        schemaVersion: 2,
        decisionId: "dec-wf",
        runId: "run-wf",
        taskId: "implement",
        specId: wfSpec.specId,
        mode: "recommended",
        rationale: "Bugfix verified with regression suite",
        verifiableConditions: ["Regression check passes"],
        changeClassification: "bugfix",
        requiresFailingTestFirst: false,
        decidedBy: "coordinator",
        decidedAt: at.toISOString()
      },
      requiredTestLevels: ["unit"],
      targetCommands: ["pnpm test"],
      independentVerificationRequired: true,
      criterionMappings: wfSpec.acceptanceCriteria.map(c => ({
        criterionId: c.id,
        testNames: ["wf-test"]
      })),
      createdAt: at.toISOString()
    });

    await journal.exclusive(async (state, save) => {
      state.runs.push({
        runId: "run-wf",
        status: "verifying",
        workflowVerificationPending: true,
        baseRevision: "a".repeat(40),
        maxIterations: 3,
        coreCreated: false,
        cancelled: false,
        delegation: DelegationRequestSchema.parse({
          schemaVersion: 2,
          delegationId: "del-wf",
          messageId: "intake-wf",
          sessionId: "session-1",
          correlationId: "corr-wf",
          runId: "run-wf",
          requestedBy: "conversation",
          targetRole: "coordinator",
          title: "WF review",
          objective: "Verify workflow review tool actions",
          specificationId: wfSpec.specId,
          sddLevel: wfSpec.level,
          acceptanceCriteria: wfSpec.acceptanceCriteria,
          inputArtifacts: [],
          priority: "normal",
          requestedAt: at.toISOString(),
          idempotencyKey: "intake-wf"
        }),
        tasks: [
          {
            taskId: "implement",
            outboundIds: [],
            worktrees: [],
            writerReleased: true,
            spec: {
              specification: wfSpec,
              request: ApprovalRequestSchema.parse({
                schemaVersion: 2,
                approvalId: "app-wf",
                runId: "run-wf",
                target: { type: "specification", specId: wfSpec.specId },
                revision: 1,
                generation: 0,
                requestedBy: "coordinator",
                requestedAt: at.toISOString(),
                reason: "Approve specification",
                evidence: [wfSpec.artifactRef!],
                idempotencyKey: "app-wf"
              }),
              strategy: wfStrategy
            }
          }
        ]
      } as unknown as JournalState["runs"][number]);
      state.outbound.push({
        message: wfMessage,
        selector: "reviewer",
        taskId: "workflow-verification",
        attemptId: "attempt-wf-1",
        capabilities: ["review"],
        status: "accepted",
        request: wfRequest,
        handle: wfHandle,
        lease: revLease
      });
      await save();
    });

    const wfAssignment = await runtime.withAssignedToolAction(reviewerBinding, async ctx => ctx);
    expect(wfAssignment).toMatchObject({
      runId: "run-wf",
      taskId: "workflow-verification",
      transportTaskId: "workflow-verification"
    });

    // Once workflowVerificationPending is false, workflow-verification tool action is rejected
    await journal.exclusive(async (state, save) => {
      state.runs.find(r => r.runId === "run-wf")!.workflowVerificationPending = false;
      await save();
    });
    await expect(runtime.withAssignedToolAction(reviewerBinding, async ctx => ctx)).rejects.toThrow(
      /Verification tool action has no current business task/
    );

    // 2) Test retirePolicyPhase transitioning coordinator_continuation -> resume_coordinator directly
    const def = workflow();
    const qaLeaseRes = await registry.acquireLease({
      leaseId: "lease-qa-1",
      agentId: "qa",
      runId: "run-1",
      taskId: "evidence-implement",
      attemptId: "qa-attempt-1",
      ttlMs: 60_000,
      requestedAt: at.toISOString(),
      idempotencyKey: "lease-qa-1"
    });
    if (!qaLeaseRes.ok) throw new Error(qaLeaseRes.error.message);
    const qaLease = AgentLeaseSchema.parse(qaLeaseRes.value);
    const qaBlockedReply = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "qa-blocked-reply-1",
      correlation_id: "corr-1",
      causation_id: "qa-phase-msg-1",
      run_id: "run-1",
      sender: { role: "qa", agent_id: qaBinding.agentId, pane_id: qaBinding.paneId },
      recipient: { role: "coordinator" },
      type: "task.status",
      payload: { status: "blocked", summary: "Sandbox temporarily unavailable" },
      artifact_references: [],
      occurred_at: at.toISOString(),
      idempotency_key: "qa-blocked-reply-1"
    });

    const run1Spec = approvedSpecification("run-1", at.toISOString());
    const run1Strategy = TestStrategySchema.parse({
      schemaVersion: 2,
      strategyId: "strat-1",
      specId: run1Spec.specId,
      tddDecision: {
        schemaVersion: 2,
        decisionId: "dec-1",
        runId: "run-1",
        taskId: "implement",
        specId: run1Spec.specId,
        mode: "required",
        rationale: "Required TDD red-green-refactor cycle",
        verifiableConditions: ["Red test fails before implementation"],
        changeClassification: "bugfix",
        requiresFailingTestFirst: true,
        decidedBy: "coordinator",
        decidedAt: at.toISOString()
      },
      requiredTestLevels: ["unit"],
      targetCommands: ["pnpm test"],
      independentVerificationRequired: true,
      criterionMappings: run1Spec.acceptanceCriteria.map(c => ({
        criterionId: c.id,
        testNames: ["red-test"]
      })),
      createdAt: at.toISOString(),
      metadata: { tddEvidence: [] }
    });

    const retireActionId = `next-${digest(["run-1", "qa-blocked-reply-1"])}`;
    await journal.exclusive(async (state, save) => {
      const run1Record = {
        runId: "run-1",
        status: "implementing",
        baseRevision: "b".repeat(40),
        maxIterations: 3,
        coreCreated: false,
        cancelled: false,
        definition: def,
        pendingAction: {
          actionId: retireActionId,
          kind: "coordinator_continuation",
          owner: "coordinator",
          reason: "QA blocked during Red measurement",
          sourceMessageId: "qa-blocked-reply-1",
          createdAt: at.toISOString(),
          state: "pending"
        },
        delegation: DelegationRequestSchema.parse({
          schemaVersion: 2,
          delegationId: "del-1",
          messageId: "intake-1",
          sessionId: "session-1",
          correlationId: "corr-1",
          runId: "run-1",
          requestedBy: "conversation",
          targetRole: "coordinator",
          title: "Retire policy phase",
          objective: "Verify direct resume after retirePolicyPhase",
          specificationId: run1Spec.specId,
          sddLevel: run1Spec.level,
          acceptanceCriteria: run1Spec.acceptanceCriteria,
          inputArtifacts: [],
          priority: "normal",
          requestedAt: at.toISOString(),
          idempotencyKey: "intake-1"
        }),
        tasks: [
          {
            taskId: "implement",
            outboundIds: [],
            worktrees: [],
            spec: {
              specification: run1Spec,
              request: ApprovalRequestSchema.parse({
                schemaVersion: 2,
                approvalId: "app-1",
                runId: "run-1",
                target: { type: "specification", specId: run1Spec.specId },
                revision: 1,
                generation: 0,
                requestedBy: "coordinator",
                requestedAt: at.toISOString(),
                reason: "Approve specification",
                evidence: [run1Spec.artifactRef!],
                idempotencyKey: "app-1"
              }),
              strategy: run1Strategy
            }
          }
        ]
      } as unknown as JournalState["runs"][number];
      state.runs.push(run1Record);
      const core = new CoreSession(ports, state, save);
      await core.create(run1Record);
      const advanced = await core.mutate("run-1", before =>
        engine.advance({
          runId: "run-1",
          expectedVersion: before.version,
          idempotencyKey: "adv1",
          occurredAt: at.toISOString()
        })
      );
      await core.flush();
      const attemptId = advanced.tasks[0]!.attemptId!;
      const qaReqMsg = RoleMessageSchema.parse({
        schema_version: 2,
        message_id: "qa-phase-msg-1",
        correlation_id: "corr-1",
        run_id: "run-1",
        sender: { role: "coordinator" },
        recipient: { role: "qa" },
        type: "verification.requested",
        payload: {
          kind: "conditional_evidence",
          runId: "run-1",
          taskId: "implement",
          phase: "red",
          sourceRevision: "b".repeat(40),
          implementationAttemptId: attemptId
        },
        artifact_references: [],
        occurred_at: at.toISOString(),
        idempotency_key: "qa-phase-msg-1"
      });
      const qaTarget = {
        transport: "herdr",
        agentId: qaBinding.agentId,
        workspaceId: qaBinding.workspaceId,
        tabId: qaBinding.tabId,
        paneId: qaBinding.paneId,
        session: qaBinding.session
      };
      state.outbound.push({
        message: qaReqMsg,
        selector: "qa",
        taskId: "evidence-implement",
        attemptId: "qa-attempt-1",
        capabilities: ["testing"],
        status: "accepted",
        request: AgentRequestSchema.parse({
          requestId: "req-qa-1",
          runId: "run-1",
          taskId: "evidence-implement",
          attemptId: "qa-attempt-1",
          role: "qa",
          target: qaTarget,
          instruction: JSON.stringify(qaReqMsg),
          inputs: [],
          context: qaReqMsg,
          attempt: 1,
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 300_000, onTimeout: "block" },
          idempotency: { key: "req-qa-1", scope: "agent-request", fingerprint: digest(qaReqMsg) },
          createdAt: at.toISOString(),
          metadata: { leaseId: qaLease.leaseId, fencingToken: qaLease.fencingToken }
        }),
        handle: AgentExecutionHandleSchema.parse({
          executionId: "exec-qa-1",
          requestId: "req-qa-1",
          runId: "run-1",
          taskId: "evidence-implement",
          attemptId: "qa-attempt-1",
          idempotencyKey: "req-qa-1",
          target: qaTarget,
          correlation: { token: "corr-tok-qa-1", provenance: "transport", verified: true },
          acceptedAt: at.toISOString()
        }),
        lease: qaLease
      });
      state.inbox.push({ message: qaBlockedReply, status: "applied" });
      await save();
    });

    // Replace QA pane & advance clock past lease TTL so retirement preconditions hold
    qaBinding = makeBinding("qa", "pane-qa-2", "sess-qa-2");
    at = new Date(at.getTime() + 120_000);

    await runtime.retirePolicyPhase({
      operationId: "qa-phase-msg-1",
      sessionId: "session-1",
      userMessageId: "user-retire-msg-1",
      userId: "user-1"
    });

    const postRetireState = (await runtime.inspect()) as unknown as JournalState;
    const postRetireRun = postRetireState.runs.find(r => r.runId === "run-1")!;
    expect(postRetireRun.pendingAction?.kind).toBe("resume_coordinator");

    // Web availableActions exposes an enabled "resume" action
    const webActions = availableActions(postRetireRun, postRetireState, [], true, true, false);
    const resumeAction = webActions.find(a => a.kind === "resume");
    expect(resumeAction?.enabled).toBe(true);

    // Physical human resume via Conversation succeeds without throwing "No matching recoverable blocker to resume"
    const resumed = await runtime.resumeBlockedRun("run-1", retireActionId, {
      conversationUserMessageId: "user-resume-msg-1"
    });
    expect(resumed).toMatchObject({ queued: true, actionId: retireActionId });
  });

  it("Cross-Slice 6: policyPhaseReviewAssignment anchors base on task.worktrees[0].baseCommitHash for dependent tasks", () => {
    const baseSpec = approvedSpecification("run-dep");
    const strategy = TestStrategySchema.parse({
      schemaVersion: 2,
      strategyId: "strat-dep",
      specId: baseSpec.specId,
      tddDecision: {
        schemaVersion: 2,
        decisionId: "dec-dep",
        runId: "run-dep",
        taskId: "task-2",
        specId: baseSpec.specId,
        mode: "recommended",
        rationale: "Manual review plus deterministic check",
        verifiableConditions: ["Dependent task changes satisfy criteria"],
        changeClassification: "bugfix",
        requiresFailingTestFirst: false,
        decidedBy: "coordinator",
        decidedAt: "2026-11-01T00:00:00.000Z"
      },
      requiredTestLevels: ["unit"],
      targetCommands: [],
      independentVerificationRequired: true,
      criterionMappings: baseSpec.acceptanceCriteria.map(c => ({
        criterionId: c.id,
        testNames: ["dep"]
      })),
      createdAt: "2026-11-01T00:00:00.000Z"
    });
    const devBinding = PaneBindingSchema.parse({
      schemaVersion: 2,
      bindingId: "dev-b",
      sessionId: "s-1",
      role: "developer",
      agentId: "dev-2",
      paneId: "pane-dev-2",
      workspaceId: "ws",
      tabId: "tab",
      provider: "claude",
      agentKind: "claude",
      cwd: "/repo/wt-2",
      worktreePath: "/repo/wt-2",
      readOnlyWorkspace: false,
      isolationMode: "dedicated_pane",
      transportState: "idle",
      boundAt: "2026-11-01T00:00:00.000Z",
      session: { source: "herdr:claude", kind: "id", value: "dev-sess-2" }
    });
    const qaBinding = PaneBindingSchema.parse({
      schemaVersion: 2,
      bindingId: "qa-b",
      sessionId: "s-1",
      role: "qa",
      agentId: "qa",
      paneId: "pane-qa",
      workspaceId: "ws",
      tabId: "tab",
      provider: "claude",
      agentKind: "claude",
      cwd: "/repo",
      readOnlyWorkspace: true,
      isolationMode: "dedicated_pane",
      transportState: "idle",
      boundAt: "2026-11-01T00:00:00.000Z",
      session: { source: "herdr:claude", kind: "id", value: "qa-sess-1" }
    });
    const runBase = "1".repeat(40);
    const depBase = "2".repeat(40);
    const attempt2PriorHead = "3".repeat(40);
    const candidateRev = "4".repeat(40);
    const expiresAt = new Date(Date.now() + 300_000).toISOString();

    const state = {
      outbound: [
        {
          taskId: "task-2",
          status: "accepted",
          message: RoleMessageSchema.parse({
            schema_version: 2,
            message_id: "assign-2",
            correlation_id: "c-dep",
            run_id: "run-dep",
            sender: { role: "runtime" },
            recipient: { role: "developer" },
            type: "task.assignment",
            payload: {},
            artifact_references: [],
            occurred_at: "2026-11-01T00:00:00.000Z",
            idempotency_key: "assign-2"
          }),
          handle: {
            executionId: "exec-dev-2",
            requestId: "req-dev-2",
            runId: "run-dep",
            taskId: "task-2",
            attemptId: "impl-attempt-2",
            idempotencyKey: "req-dev-2",
            target: {
              transport: "herdr",
              agentId: devBinding.agentId,
              paneId: devBinding.paneId,
              worktreePath: "/repo/wt-2",
              session: devBinding.session
            },
            correlation: { token: "corr-dev-2", provenance: "transport", verified: true },
            acceptedAt: "2026-11-01T00:00:00.000Z"
          }
        },
        {
          taskId: "evidence-task-2",
          status: "accepted",
          message: RoleMessageSchema.parse({
            schema_version: 2,
            message_id: "verify-2",
            correlation_id: "c-dep",
            run_id: "run-dep",
            sender: { role: "coordinator" },
            recipient: { role: "qa" },
            type: "verification.requested",
            payload: {
              kind: "conditional_evidence",
              runId: "run-dep",
              taskId: "task-2",
              phase: "verification",
              sourceRevision: candidateRev,
              implementationAttemptId: "impl-attempt-2",
              specification: baseSpec,
              strategy
            },
            artifact_references: [],
            occurred_at: "2026-11-01T00:00:00.000Z",
            idempotency_key: "verify-2"
          }),
          handle: {
            executionId: "exec-qa-2",
            requestId: "req-qa-2",
            runId: "run-dep",
            taskId: "evidence-task-2",
            attemptId: "qa-attempt-2",
            idempotencyKey: "req-qa-2",
            target: {
              transport: "herdr",
              agentId: qaBinding.agentId,
              paneId: qaBinding.paneId,
              session: qaBinding.session
            },
            correlation: { token: "corr-qa-2", provenance: "transport", verified: true },
            acceptedAt: "2026-11-01T00:00:00.000Z"
          },
          lease: {
            leaseId: "lease-qa-dep",
            agentId: qaBinding.agentId,
            runId: "run-dep",
            taskId: "evidence-task-2",
            attemptId: "qa-attempt-2",
            fencingToken: 1,
            version: 0,
            acquiredAt: "2026-11-01T00:00:00.000Z",
            expiresAt
          }
        }
      ]
    };

    const run = {
      runId: "run-dep",
      status: "implementing",
      baseRevision: runBase,
      tasks: [
        {
          taskId: "task-2",
          worktrees: [{ baseCommitHash: depBase }, { baseCommitHash: attempt2PriorHead }],
          spec: { specification: baseSpec, strategy }
        }
      ]
    };

    const assigned = policyPhaseReviewAssignment(state, run, qaBinding, "run-dep", "task-2", "verification");
    expect(assigned.base).toBe(depBase);
  });
});
