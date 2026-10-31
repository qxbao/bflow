import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PaneBindingSchema,
  RoleMessageSchema,
  VerificationResultSchema,
  type PaneBinding,
  type QualityGate,
  type Specification
} from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { loadAgenticPolicies, type PanePolicy } from "../../src/agentic/ports.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { describeValidationError } from "../../src/agentic/role-message-feedback.js";
import { parseUserDecisionToolInput } from "../../src/agentic/decision-routing.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { cleanups as integrationCleanups, fixture as integrationFixture } from "../helpers/agentic-integration-fixture.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimeSrcRoot = join(testDir, "../../src");
const repoRoot = join(testDir, "../../../..");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const fn of integrationCleanups.splice(0).reverse()) await fn();
});

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test"
    }
  }).trim();

class TestPanes implements PanePolicy {
  busy = new Set<string>();
  missing = new Set<string>();
  releases: { taskId: string; closePane: boolean; removeWorktree: boolean }[] = [];
  bindings: PaneBinding[] = [
    "conversation",
    "coordinator",
    "specifier",
    "architect",
    "planner",
    "reviewer",
    "qa",
    "tester"
  ].map(role =>
    PaneBindingSchema.parse({
      schemaVersion: 2,
      bindingId: `binding-${role}`,
      sessionId: "session-1",
      role: role as PaneBinding["role"],
      paneGroup: "coordination",
      agentId: role,
      workspaceId: "workspace-1",
      tabId: "tab-1",
      paneId: `pane-${role}`,
      provider: "test",
      agentKind: "test",
      cwd: "/tmp",
      isolationMode: "dedicated_pane",
      readOnlyWorkspace: true,
      session: { source: "test", kind: "id", value: `session-${role}` },
      transportState: "idle",
      boundAt: new Date().toISOString()
    })
  );

  async getManifest() {
    return {
      ok: true as const,
      value: {
        schemaVersion: 2 as const,
        sessionId: "session-1",
        projectName: "Test",
        workspaceRoot: "/tmp",
        herdrWorkspaceId: "workspace-1",
        herdrTabId: "tab-1",
        status: "up" as const,
        conversationSessionId: "session-1",
        activeRunIds: [],
        panes: this.bindings,
        attachTarget: { role: "conversation" as const, paneId: "pane-conversation" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    };
  }

  async getRoleBinding(selector: string) {
    return {
      ok: true as const,
      value: this.bindings.find(p => [p.role, p.bindingId, p.paneId, p.agentId].includes(selector)) ?? null
    };
  }

  async inspectRoleHealth(selector: string) {
    const p = unwrap(await this.getRoleBinding(selector));
    if (!p) throw new Error("No pane");
    if (this.missing.has(p.paneId)) {
      return {
        ok: true as const,
        value: {
          readyForPrompt: false,
          occupantMatches: false,
          paneExists: false,
          paneId: p.paneId,
          agentId: p.agentId
        }
      };
    }
    return {
      ok: true as const,
      value: {
        readyForPrompt: !this.busy.has(p.role),
        occupantMatches: true,
        paneExists: true,
        paneId: p.paneId,
        agentId: p.agentId
      }
    };
  }

  async allocateDeveloper(request: { taskId: string; worktreePath: string; agentName: string; runId?: string }) {
    const old = this.bindings.find(p => p.agentId === request.agentName);
    if (old) return { ok: true as const, value: old };
    const p: PaneBinding = {
      ...this.bindings[0]!,
      bindingId: request.agentName,
      role: "developer",
      agentId: request.agentName,
      paneId: `pane-${request.agentName}`,
      cwd: request.worktreePath,
      worktreePath: request.worktreePath,
      readOnlyWorkspace: false,
      session: { source: "test", kind: "id", value: `session-${request.agentName}` },
      metadata: { taskId: request.taskId, ...(request.runId ? { runId: request.runId } : {}) }
    };
    this.bindings.push(p);
    return { ok: true as const, value: p };
  }

  async releaseDeveloper(request: { taskId: string; closePane: boolean; removeWorktree: boolean }) {
    const binding = this.bindings.find(p => p.metadata?.taskId === request.taskId);
    if (binding && git(binding.cwd, "status", "--porcelain")) {
      return {
        ok: false as const,
        error: { code: "conflict" as const, retryable: false, message: "Worktree contains uncommitted changes" }
      };
    }
    this.releases.push(request);
    if (binding) binding.metadata = { ...binding.metadata, allocationStatus: "released" };
    return { ok: true as const, value: undefined };
  }
}

function makeWorkflowSpec(
  runId: string,
  time: string,
  tdd = false
): { spec: Specification; def: ReturnType<typeof workflow> } {
  const spec: Specification = draft("documentation");
  spec.runId = runId;
  spec.specId = `spec-${runId}`;
  spec.createdAt = time;
  spec.updatedAt = time;
  spec.affectedPaths = ["guide.md"];
  spec.traceabilityTaskIds = ["implement"];
  (spec.metadata!.sdd as any).traceability[0].taskIds = spec.traceabilityTaskIds;
  spec.metadata!.conditionalTdd = {
    policyVersion: 1,
    taskId: "implement",
    taskType: tdd ? "domain_logic" : "documentation",
    changeImpact: {
      surfaces: [tdd ? "domain_logic" : "documentation"],
      behaviorChanged: tdd,
      deterministic: tdd,
      regressionReproducible: tdd,
      securitySensitive: false,
      dataMigration: false,
      scope: "local"
    },
    infrastructure: {
      readiness: "ready",
      commands: [{ method: "integration_test", command: "test-regression", level: "integration" }]
    },
    testability: {
      level: "automated",
      rationale: "Independent repeatable behavioral checks are available"
    },
    riskClassification: "low",
    conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] }
  };
  if (tdd) spec.acceptanceCriteria[0]!.verificationMethod = "integration_test";
  delete spec.testStrategy;
  delete spec.tddDecision;
  const def = workflow(spec.traceabilityTaskIds);
  def.maxConcurrency = 1;
  def.tasks.forEach(task => {
    (task as any).metadata = { ownedPaths: ["guide.md"] };
  });
  return { spec, def };
}

async function createFixture(options: { tdd?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-slice8-")));
  const repository = join(root, "repo");
  await mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test");
  git(repository, "config", "user.email", "test@example.test");
  await writeFile(join(repository, "guide.md"), "initial\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "baseline");

  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "slice8" }));
  cleanups.push(async () => {
    store.close();
    artifacts.close();
    await rm(root, { recursive: true, force: true });
  });

  const transport = new FakeAgentTransport();
  const panes = new TestPanes();
  const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys: {} });
  let timeOffset = 0;
  const clock = () => new Date(Date.now() + timeOffset);
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock });
  const checks = [
    {
      id: "review",
      name: "review",
      evaluator: "review",
      required: true,
      timeout: { executionTimeoutMs: 3000, onTimeout: "block" },
      configuration: {
        kind: "review",
        method: "manual_review",
        criterionIds: ["ac-1"],
        testNames: ["ac-1: The requested outcome is independently verifiable"],
        role: "reviewer",
        levels: []
      }
    },
    {
      id: "regression",
      name: "regression",
      evaluator: "regression",
      required: true,
      timeout: { executionTimeoutMs: 3000, onTimeout: "block" },
      configuration: {
        kind: "deterministic",
        method: "integration_test",
        command: "test-regression",
        criterionIds: options.tdd ? ["ac-1"] : [],
        testNames: options.tdd ? ["ac-1: The requested outcome is independently verifiable"] : [],
        role: "tester",
        levels: ["integration"]
      }
    }
  ] as any;
  const gates: QualityGate[] = checks.map((check: { id: string }) => ({
    id: check.id,
    evaluate: async () => {
      throw new Error("Quality gates not reached in unit scenario");
    }
  }));
  const conversationInbox: unknown[] = [];
  const ports = {
    engine,
    runStore: store,
    artifactStore: artifacts,
    registry,
    transport,
    panes,
    clock,
    policies: undefined as unknown as Awaited<ReturnType<typeof loadAgenticPolicies>>,
    deliverToConversation: async (message: unknown) => {
      conversationInbox.push(message);
    },
    roleCapabilities: {
      developer: ["implementation"],
      coordinator: ["coordination", "repository.read"],
      conversation: ["conversation"],
      specifier: ["specification", "repository.read"],
      architect: ["architecture", "repository.read"],
      planner: ["planning", "repository.read"],
      reviewer: ["review", "repository.read"],
      qa: ["verification", "testing", "repository.read"],
      tester: ["testing", "repository.read"]
    },
    taskChecks: checks,
    workflowChecks: checks,
    authenticateMessage: async () => true,
    authenticateResult: async () => true,
    authenticateEvidence: async () => true,
    authenticateGateResult: async () => true,
    authorizeHuman: async (decision: { decidedBy: string }) => decision.decidedBy === "human-1"
  };
  ports.policies = await loadAgenticPolicies({
    repositoryPath: repository,
    artifactStore: artifacts,
    gates,
    loadSpecification: id => runtime.loadSpecification(id),
    authorizeApprover: decision => ["coordinator", "human-1"].includes(decision.decidedBy)
  });

  const journalDirectory = join(root, "journal");
  const runtime = new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath: repository });
  const tools = new CoordinatorTools(runtime);

  async function intake(runId = "run-1") {
    const time = clock().toISOString();
    const { spec, def } = makeWorkflowSpec(runId, time, options.tdd ?? false);
    const intakeId = `intake-${runId}`;
    const delegation = {
      schemaVersion: 2,
      delegationId: `delegation-${runId}`,
      messageId: intakeId,
      correlationId: `correlation-${runId}`,
      sessionId: "session-1",
      runId,
      requestedBy: "conversation",
      targetRole: "coordinator",
      title: spec.title,
      objective: spec.summary,
      specificationId: spec.specId,
      sddLevel: spec.level,
      acceptanceCriteria: spec.acceptanceCriteria,
      inputArtifacts: [],
      priority: "normal",
      requestedAt: time,
      idempotencyKey: intakeId
    };
    await runtime.receiveHerdr(
      RoleMessageSchema.parse({
        schema_version: 2,
        message_id: intakeId,
        correlation_id: `correlation-${runId}`,
        run_id: runId,
        sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" },
        recipient: { role: "coordinator" },
        type: "delegation.request",
        payload: delegation,
        artifact_references: [],
        occurred_at: time,
        idempotency_key: intakeId
      })
    );
    return { spec, def };
  }

  async function dispatch(runId = "run-1") {
    const { spec, def } = await intake(runId);
    await runtime.proposeWorkflow(runId, spec, def);
    await runtime.tick();
    const developer = ((await runtime.inspect()) as any).outbound.find(
      (out: any) => out.message.run_id === runId && out.message.type === "task.assignment"
    );
    expect(developer.status).toBe("accepted");
    return { developer, spec, def };
  }

  return {
    root,
    repository,
    journalDirectory,
    journal: new AgenticJournal(journalDirectory, repository),
    runtime,
    tools,
    ports,
    transport,
    panes,
    conversationInbox,
    intake,
    dispatch,
    advance: (ms: number) => {
      timeOffset += ms;
    },
    state: async () => (await runtime.inspect()) as any
  };
}

describe("Slice 8.1: static imports eliminate ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", () => {
  it("contains zero runtime dynamic import() expressions in owned runtime, ports, and handover modules", async () => {
    for (const rel of ["agentic/runtime.ts", "agentic/ports.ts", "handover/sources.ts"]) {
      const source = await readFile(join(runtimeSrcRoot, rel), "utf8");
      expect(source, `${rel} should use static top-level imports instead of dynamic import()`).not.toMatch(/\bimport\s*\(/);
    }
  });
});

describe("Slice 8.2: parent lease validation & per-run isolation prevent Task notice parent lease crashes", () => {
  it("expires a Developer user decision after the 5-minute task lease expired without crashing tick() or starving sibling runs", async () => {
    const f = await createFixture();
    const { developer } = await f.dispatch("run-1");
    const devBinding = f.panes.bindings.find(p => p.paneId === developer.handle.target.paneId)!;

    const decisionRes = (await f.runtime.requestUserDecision(
      devBinding,
      "developer",
      parseUserDecisionToolInput({
        runId: "run-1",
        taskId: "implement",
        question: "Which markdown heading level should guide.md use?",
        options: ["Use H1", "Use H2"],
        expiresInMinutes: 30
      })
    )) as any;
    expect(decisionRes.status).toBe("pending");

    const run2 = await f.intake("run-2");
    await f.runtime.proposeWorkflow("run-2", run2.spec, run2.def);

    // Advance 35 minutes: both Developer's 5-min task.assignment lease and the 30-min user decision have expired.
    f.advance(35 * 60_000);

    await expect(f.runtime.tick()).resolves.toBeDefined();

    const state = await f.state();
    const firstRun = state.runs.find((r: any) => r.runId === "run-1");
    expect(firstRun.userDecisions[decisionRes.approvalId].status).toBe("expired");
    expect(firstRun.status).toBe("escalated");
    expect(firstRun.pendingAction).toMatchObject({ kind: "resume_coordinator", state: "pending" });

    // Sibling run-2 must still have been scheduled and flushed without starvation.
    const run2Dev = state.outbound.find(
      (out: any) => out.message.run_id === "run-2" && out.message.type === "task.assignment"
    );
    expect(run2Dev?.status).toBe("accepted");
  });

  it("persists human user-decision answers even when the Developer's 5-minute lease already expired", async () => {
    const f = await createFixture();
    const { developer } = await f.dispatch("run-1");
    const devBinding = f.panes.bindings.find(p => p.paneId === developer.handle.target.paneId)!;

    const decisionRes = (await f.runtime.requestUserDecision(
      devBinding,
      "developer",
      parseUserDecisionToolInput({
        runId: "run-1",
        taskId: "implement",
        question: "Confirm guide format?",
        options: ["Short", "Full"],
        expiresInMinutes: 60
      })
    )) as any;

    // 6 minutes later: decision is still valid (60m), but Developer's 5m task lease has expired.
    f.advance(6 * 60_000);
    const now = f.ports.clock().toISOString();

    await expect(
      f.runtime.receiveHerdr(
        RoleMessageSchema.parse({
          schema_version: 2,
          message_id: "human-dec-1",
          correlation_id: "correlation-run-1",
          run_id: "run-1",
          sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" },
          recipient: { role: "coordinator" },
          type: "approval.decision",
          payload: {
            schemaVersion: 2,
            approvalId: decisionRes.approvalId,
            sessionId: "session-1",
            runId: "run-1",
            target: { type: "task", taskId: "implement" },
            revision: 1,
            generation: 0,
            decision: "approved",
            decidedBy: "human-1",
            reason: "Short format",
            feedbackArtifacts: [],
            idempotencyKey: "human-dec-1",
            metadata: { selectedOption: "Short" },
            decidedAt: now
          },
          artifact_references: [],
          occurred_at: now,
          idempotency_key: "human-dec-1"
        })
      )
    ).resolves.toMatchObject({ accepted: true });

    const run = (await f.state()).runs.find((r: any) => r.runId === "run-1");
    expect(run.userDecisions[decisionRes.approvalId].status).toBe("answered");
    expect(run.status).toBe("escalated");
  });

  it("recovers unapplied repairable phaseFailure when parent Developer lease was already released without bricking transactions or sibling runs", async () => {
    const f = await createFixture();
    const { developer } = await f.dispatch("run-1");

    // Seed an unapplied repairable phaseFailure whose parent Developer task.assignment is already released.
    await f.journal.exclusive(async (state, save) => {
      const parent = state.outbound.find(o => o.message.message_id === developer.message.message_id)!;
      parent.status = "released";
      state.outbound.push({
        message: RoleMessageSchema.parse({
          schema_version: 2,
          message_id: "qa-phase-req-1",
          correlation_id: "correlation-run-1",
          causation_id: parent.message.message_id,
          run_id: "run-1",
          sender: { role: "coordinator" },
          recipient: { role: "qa" },
          type: "verification.requested",
          payload: {
            kind: "conditional_evidence",
            taskId: "implement",
            phase: "verification",
            implementationAttemptId: parent.attemptId,
            headCommitHash: "a".repeat(40)
          },
          artifact_references: [],
          occurred_at: f.ports.clock().toISOString(),
          idempotency_key: "qa-phase-req-1"
        }),
        selector: "qa",
        taskId: "implement-verification",
        attemptId: `${parent.attemptId}-verification`,
        capabilities: ["verification"],
        status: "failed",
        attempts: 1,
        error: "policy_phase_failed: target check failed",
        phaseFailure: {
          summary: "Target check failed and needs Developer repair",
          repairable: true,
          applied: false
        }
      });
      await save();
    });

    const run2 = await f.intake("run-2");
    await f.runtime.proposeWorkflow("run-2", run2.spec, run2.def);

    await expect(f.runtime.watchdogSnapshot()).resolves.toBeDefined();
    await expect(f.runtime.tick()).resolves.toBeDefined();

    const state = await f.state();
    const phaseReq = state.outbound.find((o: any) => o.message.message_id === "qa-phase-req-1");
    expect(phaseReq.phaseFailure.applied).toBe(true);
    expect(state.runs.find((r: any) => r.runId === "run-1").status).toBe("escalated");
    expect(
      state.outbound.find((o: any) => o.message.run_id === "run-2" && o.message.type === "task.assignment")?.status
    ).toBe("accepted");
  });

  it("applies verification.result cleanly without throwing when Developer parent lease expired during QA measurement", async () => {
    const f = await createFixture({ tdd: true });
    const { developer } = await f.dispatch("run-1");
    const devBinding = f.panes.bindings.find(p => p.paneId === developer.handle.target.paneId)!;
    const head = git(devBinding.worktreePath!, "rev-parse", "HEAD");

    // QA pane is busy for 6 minutes on prior work before accepting verification.requested:
    // Developer's 5m lease (t=0..5m) expires at t=5m, while QA acquires a fresh lease (t=6m..11m) at flush.
    f.panes.busy.add("qa");
    await f.runtime.requestPhaseVerification(devBinding, "run-1", "implement", "red", head);
    f.advance(6 * 60_000);
    f.panes.busy.delete("qa");
    await f.runtime.flushOutbound();
    const qaReq = (await f.state()).outbound.find((o: any) => o.message.type === "verification.requested");
    expect(qaReq.status).toBe("accepted");

    const now = f.ports.clock().toISOString();
    const runState = (await f.state()).runs[0];
    const strategy = runState.tasks[0].spec.strategy;
    const bytes = Buffer.from("red-phase-output");
    const storedArtifact = unwrap(
      await f.ports.artifactStore.put({
        options: {
          artifactId: randomUUID(),
          runId: "run-1",
          taskId: "implement",
          kind: "test-result",
          mediaType: "text/plain",
          expectedIntegrity: {
            checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
            sizeBytes: bytes.length
          },
          idempotencyKey: randomUUID()
        },
        content: (async function* () {
          yield bytes;
        })()
      })
    );
    const verificationResult = VerificationResultSchema.parse({
      schemaVersion: 2,
      verificationId: randomUUID(),
      runId: "run-1",
      taskId: "implement",
      cycleNumber: 1,
      attemptId: randomUUID(),
      status: "failed",
      independentExecution: true,
      evaluatedCriteria: [
        {
          criterionId: "ac-1",
          passed: false,
          evidenceArtifactId: storedArtifact.artifactId,
          summary: "Observed Red failure",
          command: "test-regression",
          exitCode: 1
        }
      ],
      qualityGateResults: [],
      evidenceArtifacts: [storedArtifact],
      findings: [],
      verifiedBy: qaReq.message.recipient.role,
      startedAt: storedArtifact.createdAt,
      completedAt: now,
      metadata: {
        conditionalTdd: {
          phase: "red",
          decisionId: strategy.tddDecision.decisionId,
          specId: strategy.specId,
          sourceRevision: head,
          testRevision: head,
          testNames: strategy.criterionMappings[0].testNames,
          failureKind: "target_behavior",
          observations: [
            {
              method: "integration_test",
              criterionId: "ac-1",
              evidenceArtifactId: storedArtifact.artifactId,
              summary: "Independent Red observation",
              command: "test-regression",
              exitCode: 1
            }
          ]
        }
      }
    });

    await expect(
      f.runtime.receiveHerdr(
        RoleMessageSchema.parse({
          schema_version: 2,
          message_id: "qa-ver-reply-1",
          correlation_id: qaReq.message.correlation_id,
          causation_id: qaReq.message.message_id,
          run_id: "run-1",
          sender: {
            role: qaReq.message.recipient.role,
            agent_id: qaReq.handle.target.agentId,
            pane_id: qaReq.handle.target.paneId
          },
          recipient: { role: "coordinator" },
          type: "verification.result",
          payload: verificationResult,
          artifact_references: [storedArtifact],
          occurred_at: now,
          idempotency_key: "qa-ver-reply-1"
        })
      )
    ).resolves.toMatchObject({ accepted: true });

    const state = await f.state();
    expect(state.inbox.find((i: any) => i.message.message_id === "qa-ver-reply-1").status).toBe("applied");
    expect(state.runs[0].status).toBe("escalated");
  });
});

describe("Slice 8.3: cancellation after lease expiry, child notices & vanished non-writer specialist panes", () => {
  it("interrupts and fully reconciles a cancelled Developer execution whose 5-minute lease expired BEFORE cancel() and releases accepted child notices", async () => {
    const f = await createFixture();
    const { developer } = await f.dispatch("run-1");

    // Seed an accepted child task.status notice attached to the Developer assignment before lease expiry.
    await f.journal.exclusive(async (state, save) => {
      const parent = state.outbound.find(o => o.message.message_id === developer.message.message_id)!;
      state.outbound.push({
        message: RoleMessageSchema.parse({
          schema_version: 2,
          message_id: "child-notice-1",
          correlation_id: parent.message.correlation_id,
          causation_id: parent.message.message_id,
          run_id: "run-1",
          sender: { role: "coordinator" },
          recipient: {
            role: "developer",
            agent_id: parent.handle!.target.agentId,
            pane_id: parent.handle!.target.paneId
          },
          type: "task.status",
          payload: { kind: "policy_phase_outcome", taskId: "implement", phase: "red", status: "passed", summary: "ok" },
          artifact_references: [],
          occurred_at: f.ports.clock().toISOString(),
          idempotency_key: "child-notice-1"
        }),
        selector: parent.selector,
        taskId: "implement",
        attemptId: parent.attemptId,
        capabilities: [],
        parentAssignmentId: parent.message.message_id,
        lease: parent.lease,
        request: { ...parent.request!, target: parent.handle!.target },
        handle: {
          ...parent.handle!,
          executionId: "exec-child-notice-1",
          requestId: "req-child-notice-1",
          idempotencyKey: "child-notice-1"
        },
        status: "accepted",
        attempts: 1
      });
      await save();
    });

    // Advance 6 minutes BEFORE cancel() is called — reproducing a hung Developer whose 5-minute lease already expired.
    f.advance(360_000);

    await f.runtime.cancel("run-1", "User clicked Cancel after 6 minutes");
    await f.runtime.tick();

    const afterInterrupt = (await f.state()).outbound.find(
      (o: any) => o.message.message_id === developer.message.message_id
    );
    expect(afterInterrupt.cancelRequested).toBe(true);
    expect(afterInterrupt.leaseRenewal).toBeUndefined();
    expect(f.transport.cancelledHandles.map(h => h.executionId)).toContain(developer.handle.executionId);

    f.transport.customWaitHandler = handle => ({
      ok: true,
      value: { handle, state: "idle", observedAt: f.ports.clock().toISOString(), correlationVerified: true }
    });
    await f.runtime.tick();

    const state = await f.state();
    const settled = state.outbound.find((o: any) => o.message.message_id === developer.message.message_id);
    const childNotice = state.outbound.find((o: any) => o.message.message_id === "child-notice-1");
    expect(settled.status).toBe("released");
    expect(settled.cancellationLeaseDisposition).toBe("expired");
    expect(childNotice.status).toBe("released");
    expect(state.runs[0].cancelReconciled).toBe(true);
    expect(((await f.ports.engine.getSnapshot("run-1")) as any).value.status).toBe("cancelled");
  });

  it("refuses to interrupt a replacement pane occupant when the original Developer lease already expired before cancel()", async () => {
    const f = await createFixture();
    const { developer } = await f.dispatch("run-1");
    f.advance(360_000);

    const devPane = f.panes.bindings.find(p => p.paneId === developer.handle.target.paneId)!;
    devPane.session = { source: "test", kind: "id", value: "replacement-native-session" };

    await f.runtime.cancel("run-1", "User cancelled after replacement");
    await f.runtime.tick();

    expect(f.transport.cancelledHandles).toHaveLength(0);
    const out = (await f.state()).outbound.find((o: any) => o.message.message_id === developer.message.message_id);
    expect(out.cancelRequested).toBeUndefined();
    expect(out.error).toContain("binding was replaced");
  });

  it("settles a cancelled non-writer specialist whose Herdr pane vanished (not_found) without fabricating stop proof, while retaining vanished unsupervised Developer writers", async () => {
    const f = await createFixture();
    await f.intake("run-1");
    await f.runtime.requestSpecialist("run-1", "reviewer", "Audit docs", ["review"]);
    await f.runtime.tick();

    const reviewer = (await f.state()).outbound.find((o: any) => o.message.recipient.role === "reviewer");
    expect(reviewer.status).toBe("accepted");

    // Simulate Herdr target pane w1:pE vanished before/during cancellation reconciliation.
    f.panes.missing.add(reviewer.handle.target.paneId);
    f.transport.customWaitHandler = () => ({
      ok: false,
      error: { code: "not_found", retryable: false, message: "agent target pane-reviewer not found" }
    });

    await f.runtime.cancel("run-1", "Cancel stalled specialist run");
    await f.runtime.tick();
    const report = await f.runtime.reconcileCancellation("run-1");
    expect(report.fullyStopped).toBe(true);
    expect(report.blockers).toEqual([]);

    const settledReviewer = (await f.state()).outbound.find((o: any) => o.message.message_id === reviewer.message.message_id);
    expect(settledReviewer.status).toBe("released");
    expect(settledReviewer.cancellationStopProof).toBeUndefined();

    // Contrast: an unsupervised Developer writer whose pane vanished MUST still fail closed and retain its worktree!
    const fWriter = await createFixture();
    const { developer } = await fWriter.dispatch("run-writer");
    fWriter.panes.missing.add(developer.handle.target.paneId);
    fWriter.transport.customWaitHandler = () => ({
      ok: false,
      error: { code: "not_found", retryable: false, message: "agent target pane-dev not found" }
    });
    await fWriter.runtime.cancel("run-writer", "Cancel writer with vanished pane");
    await fWriter.runtime.tick();
    const writerReport = await fWriter.runtime.reconcileCancellation("run-writer");
    expect(writerReport.fullyStopped).toBe(false);
    const devAfter = (await fWriter.state()).outbound.find(
      (o: any) => o.message.message_id === developer.message.message_id
    );
    expect(devAfter.status).toBe("accepted");
    expect(((await fWriter.ports.engine.getSnapshot("run-writer")) as any).value.status).toBe("cancelling");
  });
});

describe("Slice 8.4: MCP role tools on escalated/paused runs, RoleMessage feedback & rework handover selection", () => {
  it("allows Coordinator report_progress and request_user_decision on an escalated/paused run without overwriting escalated status", async () => {
    const f = await createFixture();
    await f.intake("run-1");

    const sourceId = "phase-fail-1";
    await f.journal.exclusive(async (state, save) => {
      const run = state.runs[0]!;
      run.status = "escalated";
      run.error = "Expired writer lease requires owner resume";
      run.pendingAction = {
        actionId: `next-${digest(["run-1", sourceId])}`,
        kind: "resume_coordinator",
        owner: "coordinator",
        reason: "Expired writer lease requires owner resume",
        sourceMessageId: sourceId,
        createdAt: f.ports.clock().toISOString(),
        state: "pending",
        previousStatus: "implementing",
        recovery: "manual"
      };
      await save();
    });

    await expect(
      f.tools.invoke(
        "report_progress",
        {
          runId: "run-1",
          headline: "Run is blocked awaiting explicit owner resume",
          questions: ["Please confirm resume in Conversation or Web UI"]
        },
        { role: "coordinator" }
      )
    ).resolves.toMatchObject({ queued: true });

    expect((await f.state()).runs[0].status).toBe("escalated");

    const coordinatorBinding = f.panes.bindings.find(p => p.role === "coordinator")!;
    await expect(
      f.runtime.requestUserDecision(
        coordinatorBinding,
        "coordinator",
        parseUserDecisionToolInput({
          runId: "run-1",
          taskId: "planning",
          question: "How should Coordinator proceed with the blocked run?",
          options: ["Wait for owner resume", "Cancel run"]
        })
      )
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("includes actionable non-retry guidance when Coordinator calls resume_run on an expired writer lease and hints on invalid task.blocked RoleMessage", async () => {
    const f = await createFixture();
    const { developer } = await f.dispatch("run-1");

    const sourceId = "qa-lease-1";
    const actionId = `next-${digest(["run-1", sourceId])}`;
    await f.journal.exclusive(async (state, save) => {
      const run = state.runs[0]!;
      run.status = "escalated";
      run.pendingAction = {
        actionId,
        kind: "resume_coordinator",
        owner: "coordinator",
        reason: "Developer lease expired",
        sourceMessageId: sourceId,
        createdAt: f.ports.clock().toISOString(),
        state: "pending",
        previousStatus: "implementing",
        recovery: "manual"
      };
      state.outbound.push({
        message: RoleMessageSchema.parse({
          schema_version: 2,
          message_id: sourceId,
          correlation_id: "correlation-run-1",
          causation_id: developer.message.message_id,
          run_id: "run-1",
          sender: { role: "coordinator" },
          recipient: { role: "qa" },
          type: "verification.requested",
          payload: {
            kind: "conditional_evidence",
            taskId: "implement",
            phase: "verification",
            implementationAttemptId: developer.attemptId,
            headCommitHash: "a".repeat(40)
          },
          artifact_references: [],
          occurred_at: f.ports.clock().toISOString(),
          idempotency_key: sourceId
        }),
        selector: "qa",
        taskId: "implement-verification",
        attemptId: `${developer.attemptId}-verification`,
        capabilities: ["verification"],
        status: "failed",
        attempts: 1,
        phaseFailure: {
          summary: "Developer lease expired during policy repair",
          repairable: true,
          leaseRecoveryRequired: true,
          applied: true
        }
      });
      await save();
    });
    f.advance(360_000);

    await expect(
      f.runtime.resumeBlockedRun("run-1", actionId)
    ).rejects.toThrow(/Expired writer lease requires authenticated explicit owner resume.*report_progress/i);

    const invalid = RoleMessageSchema.safeParse({
      schema_version: 2,
      message_id: "bad-msg-1",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "coordinator" },
      recipient: { role: "conversation" },
      type: "task.blocked",
      payload: { summary: "Blocked" },
      artifact_references: [],
      idempotency_key: "bad-msg-1"
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      const formatted = describeValidationError(invalid.error);
      expect(formatted).toContain("task.status");
      expect(describeValidationError(String(invalid.error))).toBe(formatted);
    }

    const coordinatorPrompt = await readFile(join(repoRoot, "agents/coordinator/system-prompt.md"), "utf8");
    // The prompt must steer to the valid type; naming invented types is forbidden by agent-behavior-policies.
    expect(coordinatorPrompt).toContain('type: "task.status"');
    expect(coordinatorPrompt).not.toContain("task.blocked");
  });

  it("resolves read_task_handover to the active accepted assignment when a prior released assignment shares the same Developer pane", async () => {
    const f = await createFixture();
    const { developer } = await f.dispatch("run-1");
    const devBinding = f.panes.bindings.find(p => p.paneId === developer.handle.target.paneId)!;

    await f.journal.exclusive(async (state, save) => {
      const current = state.outbound.find(o => o.message.message_id === developer.message.message_id)!;
      const prior = structuredClone(current);
      prior.message.message_id = "prior-released-assignment";
      prior.message.idempotency_key = "prior-released-assignment";
      prior.status = "released";
      prior.attemptId = "prior-attempt-0";
      prior.handle!.requestId = "prior-req-0";
      prior.handle!.attemptId = "prior-attempt-0";
      state.outbound.unshift(prior);
      await save();
    });

    const context = (await f.runtime.taskHandover(devBinding, {})) as any;
    expect(context.binding).toMatchObject({
      runId: "run-1",
      taskId: "implement",
      assignmentId: developer.message.message_id
    });
    expect(context.handover.code).not.toBe("handover_assignment_unavailable");
  });
});

describe("Slice 8.5: terminal run transitions and Coordinator actions clear dangling pendingAction", () => {
  it("clears coordinator_continuation on proposeWorkflow and clears pendingAction when a run is cancelled or completed", async () => {
    const f = await createFixture();
    const { spec, def } = await f.intake("run-1");

    await f.journal.exclusive(async (state, save) => {
      state.runs[0]!.pendingAction = {
        actionId: `next-${digest(["run-1", "spec-reply-1"])}`,
        kind: "coordinator_continuation",
        owner: "coordinator",
        reason: "Continue planning after specialist reply",
        sourceMessageId: "spec-reply-1",
        createdAt: f.ports.clock().toISOString(),
        state: "pending"
      };
      await save();
    });

    await f.runtime.proposeWorkflow("run-1", spec, def);
    expect((await f.state()).runs[0].pendingAction).toBeUndefined();

    await f.journal.exclusive(async (state, save) => {
      state.runs[0]!.pendingAction = {
        actionId: `next-${digest(["run-1", "spec-reply-2"])}`,
        kind: "coordinator_continuation",
        owner: "coordinator",
        reason: "Stale continuation before cancel",
        sourceMessageId: "spec-reply-2",
        createdAt: f.ports.clock().toISOString(),
        state: "queued"
      };
      await save();
    });

    await f.runtime.cancel("run-1", "Cancel run with queued pendingAction");
    expect((await f.state()).runs[0].pendingAction).toBeUndefined();

    // Full delivery approval -> completed must clear any dangling pendingAction, and restart must heal legacy journals.
    const fComplete = await integrationFixture();
    await fComplete.runtime.proposeWorkflow("run-1", fComplete.spec, fComplete.def);
    await fComplete.runtime.tick();
    await fComplete.evidence("implement");
    await fComplete.submit();
    await fComplete.runtime.tick();
    await fComplete.runtime.tick();
    expect((await fComplete.inspect()).status).toBe("awaiting_approval");

    const completeJournal = new AgenticJournal(join(fComplete.root, "journal"), fComplete.repository);
    await completeJournal.exclusive(async (state, save) => {
      state.runs[0]!.pendingAction = {
        actionId: `next-${digest(["run-1", "msg-complete-1"])}`,
        kind: "coordinator_continuation",
        owner: "coordinator",
        reason: "Dangling continuation before delivery approval",
        sourceMessageId: "msg-complete-1",
        createdAt: new Date().toISOString(),
        state: "pending"
      };
      await save();
    });

    await fComplete.approve();
    const completedRun = await fComplete.inspect();
    expect(completedRun.status).toBe("completed");
    expect(completedRun.pendingAction).toBeUndefined();

    // Also verify startup healing when an older journal persisted pendingAction on an already-completed run (real RUN #9).
    await completeJournal.exclusive(async (state, save) => {
      state.runs[0]!.pendingAction = {
        actionId: `next-${digest(["run-1", "legacy-run9"])}`,
        kind: "coordinator_continuation",
        owner: "coordinator",
        reason: "Legacy dangling continuation on completed run",
        sourceMessageId: "legacy-run9",
        createdAt: new Date().toISOString(),
        state: "pending"
      };
      await save();
    });
    const restarted = new AgenticWorkflowRuntime(fComplete.ports, {
      journalDirectory: join(fComplete.root, "journal"),
      repositoryPath: fComplete.repository
    });
    await restarted.initialize();
    expect(((await restarted.inspect()) as any).runs[0].pendingAction).toBeUndefined();
  }, 90_000);
});
