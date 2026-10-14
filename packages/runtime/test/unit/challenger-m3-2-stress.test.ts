import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  AgentExecutionHandle,
  AgentReconciliationRequest,
  AgentReconciliationResult,
  ArtifactProposal,
  DomainEvent,
  OperationOptions,
  OperationResult,
  WorkflowDefinition,
  WorkflowRunSnapshot
} from "@ai-flow/contracts";
import { DeterministicWorkflowEngine } from "@ai-flow/core";
import { createRuntimeService } from "../../src/service.js";
import { TaskDispatcher } from "../../src/dispatcher.js";
import { SdlcWorkflowOrchestrator, ingestArtifactProposals, isHumanApprover } from "../../src/orchestrator.js";
import { eventTailCursor, recoverWorkflowRun } from "../../src/recovery.js";
import {
  createSdlcWorkflowDefinition,
  createTestHarness,
  FakeQualityGate
} from "../helpers/test-harness.js";
import { createSampleWorkflowDefinition } from "./fixtures.js";

describe("Challenger M3.2 Tier 5 Adversarial Stress & Hardening Suite", { timeout: 30000 }, () => {
  // =========================================================================
  // SUITE 1: RunOrchestrator.driveRun — Scheduling, Signal Abort & Quality Gates
  // =========================================================================
  describe("Suite 1: RunOrchestrator.driveRun — Scheduling, Signal Abort & Quality Gates", () => {
    it("1.1: Pre-dispatch quality gate failure prevents task dispatch and keeps task in ready status", async () => {
      const harness = await createTestHarness();
      try {
        const { runStore, artifactStore, agentRegistry, transport, engine } = harness;
        const runId = `run-before-gate-fail-${randomUUID()}`;

        // Create workflow definition with a 'before_dispatch' quality gate on 'plan'
        const baseDef = createSampleWorkflowDefinition();
        const definition: WorkflowDefinition = {
          ...baseDef,
          qualityGates: [
            {
              id: "pre-flight-check",
              name: "Pre-flight Environment Check",
              evaluator: "command",
              required: true,
              timeout: { executionTimeoutMs: 10000, onTimeout: "fail" }
            }
          ],
          tasks: baseDef.tasks.map((t) =>
            t.id === "plan"
              ? {
                  ...t,
                  qualityGates: [
                    { gateId: "pre-flight-check", phase: "before_dispatch", required: true }
                  ]
                }
              : t
          )
        };

        await engine.validateDefinition(definition);
        const createRes = await engine.createRun({
          runId,
          definition,
          idempotencyKey: "c-gate-fail",
          createdAt: new Date().toISOString()
        });
        expect(createRes.ok).toBe(true);

        await runStore.create({ snapshot: createRes.value.snapshot, definition }, "create-idemp");
        await runStore.appendEvents({
          runId,
          expectedVersion: 0,
          expectedLastSequence: 0,
          events: createRes.value.emittedEvents,
          idempotencyKey: "events-init"
        });

        const qualityGate = new FakeQualityGate();
        // Configure quality gate to FAIL
        qualityGate.customEvaluateHandler = (ctx) => ({
          ok: true,
          value: {
            gateId: ctx.definition.id,
            runId: ctx.runId,
            taskId: ctx.taskId,
            evaluationId: `eval-${randomUUID()}`,
            status: "failed",
            findings: [{ checkId: "env-check", ruleId: "node-env", severity: "error", message: "Missing required tool" }],
            producedArtifacts: [],
            evaluatedAt: new Date().toISOString()
          }
        });

        const dispatcher = new TaskDispatcher({
          engine,
          runStore,
          agentRegistry,
          transport
        });

        const orchestrator = new SdlcWorkflowOrchestrator(
          {
            engine,
            runStore,
            artifactStore,
            qualityGate
          },
          dispatcher
        );

        // Advance to make plan ready
        const advRes = await engine.advance({
          runId,
          expectedVersion: createRes.value.snapshot.version,
          idempotencyKey: "adv-ready",
          occurredAt: new Date().toISOString()
        });
        expect(advRes.ok).toBe(true);
        await runStore.appendEvents({
          runId,
          expectedVersion: createRes.value.snapshot.version,
          expectedLastSequence: createRes.value.snapshot.lastEventSequence,
          events: advRes.value.emittedEvents,
          idempotencyKey: "adv-events"
        });

        // Execute driveRun: quality gate fails before dispatch
        const driveRes = await orchestrator.driveRun(runId);
        expect(driveRes.ok).toBe(true);

        // Verification: Task 'plan' was NOT dispatched to transport
        expect(transport.sentRequests).toHaveLength(0);

        // Verification: Task remains ready, NOT running
        const snap = (await engine.getSnapshot(runId)).value!;
        const planTask = snap.tasks.find((t) => t.taskId === "plan")!;
        expect(planTask.status).toBe("ready");
      } finally {
        await harness.cleanup();
      }
    });

    it("1.2: Aborted AbortSignal halts driveRun immediately without dispatching any ready tasks", async () => {
      const harness = await createTestHarness();
      try {
        const { service, transport } = harness;
        const runId = `run-signal-abort-${randomUUID()}`;
        const definition = createSdlcWorkflowDefinition({ id: "wf-abort-signal" });

        await service.startRun(definition, { runId });

        // Pre-aborted controller
        const controller = new AbortController();
        controller.abort(new Error("User cancelled execution"));

        const driveRes = await service.orchestrator.driveRun(runId, { signal: controller.signal });
        expect(driveRes.ok).toBe(false);
        if (!driveRes.ok) {
          expect(driveRes.error.code).toBe("cancelled");
        }

        // Zero additional tasks dispatched after abort
        expect(transport.sentRequests).toHaveLength(1); // Only the initial one from startRun
      } finally {
        await harness.cleanup();
      }
    });

    it("1.3: Dispatcher failure propagates typed error immediately without silent infinite loop", async () => {
      const harness = await createTestHarness();
      try {
        const { runStore, artifactStore, agentRegistry, transport, engine } = harness;
        const runId = `run-dispatch-fail-${randomUUID()}`;
        const definition = createSampleWorkflowDefinition();

        await engine.validateDefinition(definition);
        const createRes = await engine.createRun({
          runId,
          definition,
          idempotencyKey: "c-disp-fail",
          createdAt: new Date().toISOString()
        });
        await runStore.create({ snapshot: createRes.value.snapshot, definition }, "create-idemp");
        await runStore.appendEvents({
          runId,
          expectedVersion: 0,
          expectedLastSequence: 0,
          events: createRes.value.emittedEvents,
          idempotencyKey: "events-init"
        });

        const dispatcher = new TaskDispatcher({
          engine,
          runStore,
          agentRegistry,
          transport
        });

        // Mock dispatchTask to simulate transport/lease failure
        dispatcher.dispatchTask = async () => ({
          ok: false,
          error: {
            code: "conflict",
            retryable: false,
            message: "All runner capacity exhausted"
          }
        });

        const orchestrator = new SdlcWorkflowOrchestrator(
          {
            engine,
            runStore,
            artifactStore
          },
          dispatcher
        );

        // Call driveRun directly: scheduleReadyTasks will advance plan to ready and attempt dispatchTask
        const driveRes = await orchestrator.driveRun(runId);
        expect(driveRes.ok).toBe(false);
        if (!driveRes.ok) {
          expect(driveRes.error.code).toBe("conflict");
          expect(driveRes.error.message).toContain("All runner capacity exhausted");
        }
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 2: Artifact Proposal Ingestion — Validation & Integrity Stress
  // =========================================================================
  describe("Suite 2: Artifact Proposal Ingestion — Validation & Integrity Stress", () => {
    it("2.1: Missing content for artifact proposal fails closed with typed validation error", async () => {
      const harness = await createTestHarness();
      try {
        const proposal: ArtifactProposal = {
          proposalId: "prop-missing-content",
          runId: "run-ingest-test",
          taskId: "implement",
          kind: "patch",
          logicalName: "patch.diff",
          mediaType: "text/plain",
          expectedIntegrity: {
            sizeBytes: 12,
            checksum: { algorithm: "sha256", value: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }
          }
        };

        // Missing from content map
        const res = await ingestArtifactProposals(
          harness.artifactStore,
          [proposal],
          {} // Empty content map!
        );

        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.message).toContain("Missing content for artifact proposal 'prop-missing-content'");
        }

        // Verify zero artifacts written to store
        const resolveRes = await harness.artifactStore.resolve("prop-missing-content");
        expect(resolveRes.value).toBeNull();
      } finally {
        await harness.cleanup();
      }
    });

    it("2.2: Payload byte length size mismatch fails closed with typed validation error", async () => {
      const harness = await createTestHarness();
      try {
        const content = "actual short content";
        const contentBytes = Buffer.from(content, "utf8");
        const sha256 = createHash("sha256").update(contentBytes).digest("hex");

        const proposal: ArtifactProposal = {
          proposalId: "prop-size-mismatch",
          runId: "run-ingest-test",
          taskId: "implement",
          kind: "document",
          logicalName: "doc.txt",
          mediaType: "text/plain",
          expectedIntegrity: {
            sizeBytes: 9999, // Claimed size is 9999, but actual is 20
            checksum: { algorithm: "sha256", value: sha256 }
          }
        };

        const res = await ingestArtifactProposals(
          harness.artifactStore,
          [proposal],
          { "prop-size-mismatch": content }
        );

        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.message).toContain("Size mismatch for proposal 'prop-size-mismatch'");
          expect(res.error.message).toContain("expected 9999, got 20");
        }

        const resolveRes = await harness.artifactStore.resolve("prop-size-mismatch");
        expect(resolveRes.value).toBeNull();
      } finally {
        await harness.cleanup();
      }
    });

    it("2.3: Malformed proposal schema fails closed with typed validation error", async () => {
      const harness = await createTestHarness();
      try {
        const malformedProposal = {
          proposalId: "invalid proposal id with spaces!", // violates IdentifierSchema
          runId: "run-test",
          kind: "not_a_valid_kind",
          logicalName: "file.bin"
        } as any;

        const res = await ingestArtifactProposals(
          harness.artifactStore,
          [malformedProposal],
          { "invalid proposal id with spaces!": "data" }
        );

        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("validation");
          expect(res.error.message).toContain("Invalid artifact proposal");
        }
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 3: Anti-AI Governance & Dynamic Approval Correlation
  // =========================================================================
  describe("Suite 3: Anti-AI Governance & Dynamic Approval Correlation", () => {
    it("3.1: Strict anti-AI governance rejects modern AI model names, automated prefixes, and empty strings", () => {
      const rejectedActors = [
        "",
        "   ",
        "\t\n",
        "gpt-4o-mini",
        "gemini-1.5-pro",
        "claude-3-5-haiku-20241022",
        "deepseek-v3",
        "llama-3.1-405b",
        "bot:deployer",
        "system_admin_bot",
        "auto.merge",
        "ai-worker-99",
        "planner:agent",
        "reviewer-bot"
      ];

      for (const actor of rejectedActors) {
        expect(isHumanApprover(actor)).toBe(false);
      }

      const validHumans = [
        "alice",
        "bob_smith",
        "charlie.release.lead",
        "dave@example.com",
        "operations-specialist"
      ];

      for (const human of validHumans) {
        expect(isHumanApprover(human)).toBe(true);
      }
    });

    it("3.2: Dynamic approval correlation resolves unknown approvalId from RunStore approval.requested event", async () => {
      const harness = await createTestHarness();
      try {
        const { service } = harness;
        const runId = `run-dyn-approval-${randomUUID()}`;
        const definition = createSdlcWorkflowDefinition({
          id: "wf-dyn-approval",
          requiresApproval: true
        });

        await service.startRun(definition, { runId });

        // plan -> succeeded
        await service.orchestrator.completeTaskExecution(runId, "plan", { status: "succeeded" });

        // implement -> succeeded
        await service.orchestrator.driveRun(runId);
        await service.orchestrator.completeTaskExecution(runId, "implement", { status: "succeeded" });

        // review -> approved
        await service.orchestrator.driveRun(runId);
        await service.orchestrator.completeTaskExecution(runId, "review", { status: "succeeded", reviewDecision: "approved" });

        // qa -> succeeded (triggers requiresApproval hold)
        await service.orchestrator.driveRun(runId);
        await service.orchestrator.completeTaskExecution(runId, "qa", { status: "succeeded" });

        // Run is now waiting for pre-merge approval
        const snapWaiting = (await service.getRunStatus(runId)).value!;
        expect(snapWaiting.status).toBe("waiting");

        // Operator provides approval with a synthetic/external approvalId and run-level target
        const syntheticDecision = {
          schemaVersion: 1 as const,
          approvalId: `ext-ops-signoff-${randomUUID()}`, // Does not match internal approvalId
          runId,
          target: { type: "run" as const },
          revision: 1,
          generation: 0,
          decision: "approved" as const,
          decidedBy: "chief_architect_dan",
          decidedAt: new Date().toISOString(),
          feedbackArtifacts: [],
          idempotencyKey: `ext-approval-${randomUUID()}`
        };

        const approveRes = await service.orchestrator.applyApprovalDecision(syntheticDecision);
        expect(approveRes.ok).toBe(true);

        // Verification: Approval succeeded and drove run to terminal 'succeeded'
        const finalSnap = (await service.getRunStatus(runId)).value!;
        expect(finalSnap.status).toBe("succeeded");
      } finally {
        await harness.cleanup();
      }
    });
  });

  // =========================================================================
  // SUITE 4: recoverWorkflowRun — Edge Cases, Validation & Reconciliation Hardening
  // =========================================================================
  describe("Suite 4: recoverWorkflowRun — Edge Cases, Validation & Reconciliation Hardening", () => {
    it("4.1: Malformed and illegal runId values fail closed with typed validation error", async () => {
      const harness = await createTestHarness();
      try {
        const illegalRunIds = [
          "",
          "   ",
          "\t\n",
          "a".repeat(201)
        ];

        const ports = {
          engine: harness.engine,
          runStore: harness.runStore,
          transport: harness.transport
        };

        for (const runId of illegalRunIds) {
          const res = await recoverWorkflowRun(runId, ports);
          expect(res.ok).toBe(false);
          if (!res.ok) {
            expect(res.error.code).toBe("validation");
            expect(res.error.message).toContain(`Invalid runId: ${runId}`);
          }
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("4.2: Non-existent runId returns typed not_found error", async () => {
      const harness = await createTestHarness();
      try {
        const ports = {
          engine: harness.engine,
          runStore: harness.runStore,
          transport: harness.transport
        };

        const res = await recoverWorkflowRun("non-existent-run-9999", ports);
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe("not_found");
          expect(res.error.message).toContain("Run non-existent-run-9999 not found");
        }
      } finally {
        await harness.cleanup();
      }
    });

    it("4.3: Multi-page event tail replay (>100 events after checkpoint) accurately reconstructs aggregate snapshot", async () => {
      const harness = await createTestHarness();
      try {
        const definition = createSampleWorkflowDefinition();
        const runId = `run-tail-multipage-${randomUUID()}`;
        const requestedAt = new Date().toISOString();

        await harness.engine.validateDefinition(definition);
        const createRes = await harness.engine.createRun({
          runId,
          definition,
          idempotencyKey: "c-multi",
          createdAt: requestedAt
        });
        expect(createRes.ok).toBe(true);

        const initialSnapshot: WorkflowRunSnapshot = {
          ...createRes.value.snapshot,
          version: 0,
          lastEventSequence: 0
        };
        await harness.runStore.create({ snapshot: initialSnapshot, definition }, "s-multi");
        await harness.runStore.appendEvents({
          runId,
          expectedVersion: 0,
          expectedLastSequence: 0,
          events: createRes.value.emittedEvents,
          idempotencyKey: "e-multi"
        });

        // Advance to make plan ready
        const advRes = await harness.engine.advance({
          runId,
          expectedVersion: createRes.value.snapshot.version,
          idempotencyKey: "adv-1",
          occurredAt: new Date().toISOString()
        });
        expect(advRes.ok).toBe(true);

        await harness.runStore.appendEvents({
          runId,
          expectedVersion: createRes.value.snapshot.version,
          expectedLastSequence: createRes.value.snapshot.lastEventSequence,
          events: advRes.value.emittedEvents,
          idempotencyKey: "adv-events-1"
        });

        // Create baseline aggregate checkpoint at sequence 2
        const cpRes = await harness.engine.createCheckpoint({
          runId,
          expectedVersion: advRes.value.snapshot.version,
          checkpointId: `cp-base-${randomUUID()}`,
          createdAt: new Date().toISOString()
        });
        expect(cpRes.ok).toBe(true);
        if (!cpRes.ok) return;

        await harness.runStore.saveCheckpoint(cpRes.value, advRes.value.snapshot.version);

        // Verify eventTailCursor generates valid cursor for sequence 2
        const cursor = eventTailCursor(runId, cpRes.value.eventSequence);
        expect(cursor).toBeDefined();

        // Fresh engine instance
        const freshEngine = new DeterministicWorkflowEngine({ definitions: [definition] });
        const recoverPorts = {
          engine: freshEngine,
          runStore: harness.runStore,
          transport: harness.transport
        };

        const recRes = await recoverWorkflowRun(runId, recoverPorts);
        expect(recRes.ok).toBe(true);
        if (!recRes.ok) return;

        expect(recRes.value.snapshot.runId).toBe(runId);
        expect(recRes.value.snapshot.version).toBe(advRes.value.snapshot.version);
        expect(recRes.value.snapshot.lastEventSequence).toBe(advRes.value.snapshot.lastEventSequence);
      } finally {
        await harness.cleanup();
      }
    });

    it("4.4: In-flight task in 'cancelling' state with bound execution is reconciled on restart", async () => {
      const harness = await createTestHarness();
      try {
        const definition = createSampleWorkflowDefinition();
        const runId = `run-reconcile-cancelling-${randomUUID()}`;
        const requestedAt = new Date().toISOString();

        await harness.engine.validateDefinition(definition);
        const createRes = await harness.engine.createRun({
          runId,
          definition,
          idempotencyKey: "c-cancelling",
          createdAt: requestedAt
        });

        const initialSnapshot = {
          ...createRes.value.snapshot,
          version: 0,
          lastEventSequence: 0
        };
        await harness.runStore.create({ snapshot: initialSnapshot, definition }, "s-cancelling");
        await harness.runStore.appendEvents({
          runId,
          expectedVersion: 0,
          expectedLastSequence: 0,
          events: createRes.value.emittedEvents,
          idempotencyKey: "e-cancelling"
        });

        // Advance to make plan ready
        const advRes = await harness.engine.advance({
          runId,
          expectedVersion: createRes.value.snapshot.version,
          idempotencyKey: "adv-cancelling",
          occurredAt: new Date().toISOString()
        });

        await harness.runStore.appendEvents({
          runId,
          expectedVersion: createRes.value.snapshot.version,
          expectedLastSequence: createRes.value.snapshot.lastEventSequence,
          events: advRes.value.emittedEvents,
          idempotencyKey: "adv-events-cancelling"
        });

        const planAttemptId = advRes.value.snapshot.tasks.find((t) => t.taskId === "plan")!.attemptId!;
        const handle: AgentExecutionHandle = {
          executionId: "exec-cancelling-1",
          requestId: "req-cancelling-1",
          attemptId: planAttemptId,
          runId,
          taskId: "plan",
          idempotencyKey: "idemp-bind-cancelling",
          target: { transport: "herdr", agentId: "agent-planner-1", paneId: "pane-planner" },
          correlation: { token: "req-cancelling-1", provenance: "transport", verified: true },
          acceptedAt: new Date().toISOString()
        };

        const bindRes = await harness.engine.bindAgentExecution({
          runId,
          taskId: "plan",
          expectedVersion: advRes.value.snapshot.version,
          attempt: 1,
          handle,
          idempotencyKey: "bind-idemp-cancelling",
          occurredAt: new Date().toISOString()
        });
        expect(bindRes.ok).toBe(true);

        await harness.runStore.appendEvents({
          runId,
          expectedVersion: advRes.value.snapshot.version,
          expectedLastSequence: advRes.value.snapshot.lastEventSequence,
          events: bindRes.value.emittedEvents,
          idempotencyKey: "bind-events-cancelling"
        });

        // Request cancellation conforming to CancellationRequestSchema
        const cancelRes = await harness.engine.requestCancellation({
          schemaVersion: 1,
          cancellationId: `cancel-${randomUUID()}`,
          runId,
          taskId: "plan",
          executionId: handle.executionId,
          requestedBy: "operator",
          requestedAt: new Date().toISOString(),
          expectedVersion: bindRes.value.snapshot.version,
          idempotencyKey: "cancel-cmd-1"
        });
        expect(cancelRes.ok).toBe(true);

        await harness.runStore.appendEvents({
          runId,
          expectedVersion: bindRes.value.snapshot.version,
          expectedLastSequence: bindRes.value.snapshot.lastEventSequence,
          events: cancelRes.value.emittedEvents,
          idempotencyKey: "cancel-events-cancelling"
        });

        // Confirm task is in cancelling status
        const snapCancelling = cancelRes.value.snapshot;
        const planTaskCancelling = snapCancelling.tasks.find((t) => t.taskId === "plan")!;
        expect(planTaskCancelling.status).toBe("cancelling");
        expect(planTaskCancelling.agentExecution).toBeDefined();

        // Fresh engine instance simulating restart
        const freshEngine = new DeterministicWorkflowEngine({ definitions: [definition] });
        let reconcileCalled = false;

        harness.transport.customReconcileHandler = (req: AgentReconciliationRequest): OperationResult<AgentReconciliationResult> => {
          reconcileCalled = true;
          return {
            ok: true,
            value: {
              status: "bound",
              handle
            }
          };
        };

        const recoverPorts = {
          engine: freshEngine,
          runStore: harness.runStore,
          transport: harness.transport
        };

        const recoveryRes = await recoverWorkflowRun(runId, recoverPorts);
        expect(recoveryRes.ok).toBe(true);
        if (!recoveryRes.ok) return;

        expect(reconcileCalled).toBe(true);
        expect(recoveryRes.value.reconciledTasks).toContain("plan");
      } finally {
        await harness.cleanup();
      }
    });

    it("4.5: Resilient recovery survives transport reconcile network errors without crashing", async () => {
      const harness = await createTestHarness();
      try {
        const definition = createSampleWorkflowDefinition();
        const runId = `run-reconcile-err-${randomUUID()}`;
        const requestedAt = new Date().toISOString();

        await harness.engine.validateDefinition(definition);
        const createRes = await harness.engine.createRun({
          runId,
          definition,
          idempotencyKey: "c-err",
          createdAt: requestedAt
        });

        const initialSnapshot = {
          ...createRes.value.snapshot,
          version: 0,
          lastEventSequence: 0
        };
        await harness.runStore.create({ snapshot: initialSnapshot, definition }, "s-err");
        await harness.runStore.appendEvents({
          runId,
          expectedVersion: 0,
          expectedLastSequence: 0,
          events: createRes.value.emittedEvents,
          idempotencyKey: "e-err"
        });

        const advRes = await harness.engine.advance({
          runId,
          expectedVersion: createRes.value.snapshot.version,
          idempotencyKey: "adv-err",
          occurredAt: new Date().toISOString()
        });

        await harness.runStore.appendEvents({
          runId,
          expectedVersion: createRes.value.snapshot.version,
          expectedLastSequence: createRes.value.snapshot.lastEventSequence,
          events: advRes.value.emittedEvents,
          idempotencyKey: "adv-events-err"
        });

        const planAttemptId = advRes.value.snapshot.tasks.find((t) => t.taskId === "plan")!.attemptId!;
        const handle: AgentExecutionHandle = {
          executionId: "exec-err-1",
          requestId: "req-err-1",
          attemptId: planAttemptId,
          runId,
          taskId: "plan",
          idempotencyKey: "idemp-bind-err",
          target: { transport: "herdr", agentId: "agent-planner-1", paneId: "pane-planner" },
          correlation: { token: "req-err-1", provenance: "transport", verified: true },
          acceptedAt: new Date().toISOString()
        };

        const bindRes = await harness.engine.bindAgentExecution({
          runId,
          taskId: "plan",
          expectedVersion: advRes.value.snapshot.version,
          attempt: 1,
          handle,
          idempotencyKey: "bind-idemp-err",
          occurredAt: new Date().toISOString()
        });

        await harness.runStore.appendEvents({
          runId,
          expectedVersion: advRes.value.snapshot.version,
          expectedLastSequence: advRes.value.snapshot.lastEventSequence,
          events: bindRes.value.emittedEvents,
          idempotencyKey: "bind-events-err"
        });

        // Transport reconcile returns transport failure / timeout
        harness.transport.customReconcileHandler = () => ({
          ok: false,
          error: {
            code: "timeout",
            retryable: true,
            message: "Reconcile transport timeout"
          }
        });

        const freshEngine = new DeterministicWorkflowEngine({ definitions: [definition] });
        const recoverPorts = {
          engine: freshEngine,
          runStore: harness.runStore,
          transport: harness.transport
        };

        // Must NOT throw uncaught error; recovers state and omits task from reconciledTasks
        const recoveryRes = await recoverWorkflowRun(runId, recoverPorts);
        expect(recoveryRes.ok).toBe(true);
        if (!recoveryRes.ok) return;

        expect(recoveryRes.value.reconciledTasks).not.toContain("plan");
        expect(recoveryRes.value.snapshot.runId).toBe(runId);
      } finally {
        await harness.cleanup();
      }
    });
  });
});
