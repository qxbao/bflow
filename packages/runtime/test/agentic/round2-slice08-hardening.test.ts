import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

let simulatedWritableFileSyncErrorCode: string | undefined;

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const flags = args[1];
      if (simulatedWritableFileSyncErrorCode && typeof flags === "string" && flags.includes("w")) {
        const code = simulatedWritableFileSyncErrorCode;
        const origSync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (!simulatedWritableFileSyncErrorCode) return origSync();
          throw Object.assign(new Error(`${code}: simulated FUSE/NTFS fsync failure`), { code });
        };
      }
      return handle;
    }) as typeof actual.open
  };
});
import {
  ApprovalDecisionSchema,
  PaneBindingSchema,
  RoleMessageSchema,
  SpecificationSchema,
  type AgentExecutionHandle,
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
import {
  AssignmentContextInputSchema,
  InspectInputSchema,
  PlanningReferenceInputSchema,
  ReadProjectPolicyInputSchema
} from "../../src/agentic/mcp-output-views.js";
import { PolicyReviewPageInputSchema } from "../../src/agentic/policy-review-pages.js";
import { TaskHandoverReadInputSchema, taskHandoverAcknowledgement } from "../../src/agentic/task-handover-view.js";
import { TaskHandoverStore, admitHandover, type HandoverBinding } from "../../src/agentic/task-handover.js";
import { AssignmentSurvey } from "../../src/agentic/assignment-survey.js";
import { describeValidationError } from "../../src/agentic/role-message-feedback.js";
import { parseCoordinatorAssessmentInput } from "../../src/agentic/assessment-input.js";
import {
  PrototypeScopeSchema,
  acceptPrototypeScope,
  admitPrototypeVersion,
  settlePrototypeDecision
} from "../../src/agentic/prototype-review.js";
import { requirementRevisionGuidance } from "../../src/agentic/requirement-revision-guidance.js";
import { ProjectContextService, ArchitecturalDecisionStore } from "../../src/context/project-context-service.js";
import { publishHandover } from "../../src/handover/publish.js";
import { AnalysisPermissionDenied, AnalysisWorkflowRuntime } from "../../src/analysis/workflow.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimeSrcRoot = join(testDir, "../../src");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  simulatedWritableFileSyncErrorCode = undefined;
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function assertWellFormedUnicode(text: string): void {
  expect(LONE_SURROGATE_RE.test(text)).toBe(false);
  expect(text.includes("\uFFFD")).toBe(false);
}

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
  shellExited = new Set<string>();
  replaced = new Set<string>();
  notFoundHealth = new Set<string>();
  failAllocationFor = new Map<string, { code: "unavailable" | "conflict"; retryable: boolean; message: string }>();
  allocationCalls: string[] = [];
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
      workspaceId: "w1",
      tabId: "t1",
      paneId: role === "reviewer" ? "w1:pE" : `pane-${role}`,
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
        herdrWorkspaceId: "w1",
        herdrTabId: "t1",
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
    if (!p || this.notFoundHealth.has(p.paneId)) {
      return {
        ok: false as const,
        error: { code: "not_found" as const, retryable: false, message: `Pane '${selector}' not found` }
      } as never;
    }
    if (this.missing.has(p.paneId)) {
      return {
        ok: true as const,
        value: {
          status: "pane_missing",
          transportState: "disconnected",
          readyForPrompt: false,
          occupantMatches: false,
          paneExists: false,
          paneId: p.paneId,
          agentId: p.agentId
        }
      };
    }
    if (this.shellExited.has(p.paneId)) {
      return {
        ok: true as const,
        value: {
          status: "not_ready",
          transportState: "disconnected",
          readyForPrompt: false,
          occupantMatches: false,
          paneExists: true,
          paneId: p.paneId,
          agentId: p.agentId,
          reason: `Pane '${p.paneId}' exists at a shell prompt with no running agent`
        }
      };
    }
    if (this.replaced.has(p.paneId)) {
      return {
        ok: true as const,
        value: {
          status: "agent_replaced",
          transportState: "unknown",
          readyForPrompt: false,
          occupantMatches: false,
          paneExists: true,
          paneId: p.paneId,
          agentId: p.agentId,
          reason: `Agent occupant mismatch in pane '${p.paneId}'`
        }
      };
    }
    return {
      ok: true as const,
      value: {
        status: this.busy.has(p.role) || this.busy.has(p.paneId) ? "busy" : "ready",
        transportState: this.busy.has(p.role) || this.busy.has(p.paneId) ? "busy" : "idle",
        readyForPrompt: !this.busy.has(p.role) && !this.busy.has(p.paneId),
        occupantMatches: true,
        paneExists: true,
        paneId: p.paneId,
        agentId: p.agentId
      }
    };
  }

  async allocateDeveloper(request: { taskId: string; worktreePath: string; agentName: string; runId?: string }) {
    this.allocationCalls.push(request.taskId);
    const forced = this.failAllocationFor.get(request.taskId);
    if (forced) {
      return { ok: false as const, error: forced };
    }
    const old = this.bindings.find(p => p.agentId === request.agentName);
    if (old) return { ok: true as const, value: old };
    const p: PaneBinding = {
      ...this.bindings[0]!,
      bindingId: `bind-${request.agentName}`,
      role: "developer",
      agentId: request.agentName,
      paneId: `w2:p2`,
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
    if (!binding) {
      return {
        ok: false as const,
        error: { code: "not_found" as const, retryable: false, message: "Developer binding not found for release request" }
      };
    }
    if (git(binding.cwd, "status", "--porcelain")) {
      return {
        ok: false as const,
        error: { code: "conflict" as const, retryable: false, message: "Worktree contains uncommitted changes" }
      };
    }
    this.releases.push(request);
    binding.metadata = { ...binding.metadata, allocationStatus: "released" };
    return { ok: true as const, value: undefined };
  }
}

function makeWorkflowSpec(
  runId: string,
  time: string,
  options: { tdd?: boolean; taskIds?: string[] } = {}
): { spec: Specification; def: ReturnType<typeof workflow> } {
  const tdd = options.tdd ?? false;
  const taskIds = options.taskIds ?? ["implement"];
  const spec: Specification = draft("documentation");
  spec.runId = runId;
  spec.specId = `spec-${runId}`;
  spec.createdAt = time;
  spec.updatedAt = time;
  spec.affectedPaths = taskIds.map((_, idx) => (idx === 0 ? "guide.md" : `guide-${idx + 1}.md`));
  spec.traceabilityTaskIds = taskIds;
  (spec.metadata!.sdd as any).traceability[0].taskIds = spec.traceabilityTaskIds;
  spec.metadata!.conditionalTdd = {
    policyVersion: 1,
    taskId: taskIds[0]!,
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
  def.maxConcurrency = taskIds.length;
  def.dependencies = [];
  def.tasks.forEach((task, idx) => {
    (task as any).metadata = { ownedPaths: [idx === 0 ? "guide.md" : `guide-${idx + 1}.md`] };
  });
  return { spec, def };
}

async function createFixture(options: {
  tdd?: boolean;
  taskIds?: string[];
  stopDeveloperExecutionScope?: (handle: AgentExecutionHandle, binding: PaneBinding) => Promise<unknown>;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2-s8-")));
  const repository = join(root, "repo");
  await mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test");
  git(repository, "config", "user.email", "test@example.test");
  await writeFile(join(repository, "guide.md"), "initial\n");
  await writeFile(join(repository, "guide-2.md"), "initial-2\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "baseline");

  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "r2s8" }));
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
    preflightRoleCapabilities: async () => undefined,
    ...(options.stopDeveloperExecutionScope ? { stopDeveloperExecutionScope: options.stopDeveloperExecutionScope } : {}),
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
  const journal = new AgenticJournal(journalDirectory, repository);
  const runtime = new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath: repository });
  const tools = new CoordinatorTools(runtime);

  async function intake(runId = "run-1") {
    const time = clock().toISOString();
    const { spec, def } = makeWorkflowSpec(runId, time, { tdd: options.tdd, taskIds: options.taskIds });
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
    const state = await journal.exclusive(async s => structuredClone(s));
    const developer = state.outbound.find(o => o.message.run_id === runId && o.message.type === "task.assignment")!;
    return { spec, def, developer };
  }

  return {
    root,
    repository,
    journal,
    runtime,
    tools,
    panes,
    transport,
    engine,
    ports,
    conversationInbox,
    advance: (ms: number) => {
      timeOffset += ms;
    },
    state: () => journal.exclusive(async s => structuredClone(s)),
    intake,
    dispatch
  };
}

describe("Round 2 Slice 8 — Live Incident #1: Cancellation Stop Wedges", () => {
  it("settles non-writer specialist pane w1:pE sitting at bare shell prompt (paneExists:true, agent exited) while still failing closed on agent_replaced", async () => {
    const f = await createFixture();
    await f.intake("run-1");
    await f.runtime.requestSpecialist("run-1", "reviewer", "Audit design", ["review"]);
    await f.runtime.flushOutbound();

    const specOut = (await f.state()).outbound.find(o => o.message.recipient.role === "reviewer")!;
    expect(specOut.status).toBe("accepted");
    expect(specOut.handle?.target.paneId).toBe("w1:pE");

    // Simulate Herdr returning `not_found` for agent target w1:pE while w1:pE still exists at a bare shell prompt
    f.transport.wait = async () => ({
      ok: false as const,
      error: { code: "not_found" as const, retryable: false, message: "No active agent in pane w1:pE" }
    });
    await f.runtime.cancel("run-1", "Operator cancelled");

    // 1) If a replacement occupant took over w1:pE, cancellation MUST fail closed
    f.panes.replaced.add("w1:pE");
    const replacedReport = await f.runtime.reconcileCancellation("run-1");
    expect(replacedReport.fullyStopped).toBe(false);
    expect((await f.state()).outbound.find(o => o.message.message_id === specOut.message.message_id)?.status).toBe("accepted");

    // 2) When w1:pE sits at bare shell prompt (status: not_ready, transportState: disconnected, occupantMatches: false), stop is confirmed
    f.panes.replaced.delete("w1:pE");
    f.panes.shellExited.add("w1:pE");
    const settledReport = await f.runtime.reconcileCancellation("run-1");
    expect(settledReport.fullyStopped).toBe(true);
    expect(settledReport.blockers).toEqual([]);
    expect((await f.state()).outbound.find(o => o.message.message_id === specOut.message.message_id)?.status).toBe("released");
  });

  it("stops and settles supervised Developer on reused pane w2:p2 even after historical leaseReacquisition expiry and prior released reuse binding", async () => {
    const scopeCalls: string[] = [];
    const f = await createFixture({
      stopDeveloperExecutionScope: async (handle, binding) => {
        scopeCalls.push(`${binding.bindingId}:${binding.paneId}`);
        return {
          source: "linux_pid_namespace" as const,
          handle,
          observedAt: f.ports.clock().toISOString(),
          scopeId: "00000000-0000-4000-8000-000000000001",
          bootId: "00000000-0000-4000-8000-000000000002",
          initPid: 4242,
          initStartTime: "100",
          namespace: "pid:[4026539999]",
          receiptDigest: "b".repeat(64)
        };
      }
    });
    const { developer } = await f.dispatch("run-1");
    const ownedBinding = f.panes.bindings.find(b => b.bindingId === developer.selector)!;

    // Prepend an older released Developer binding sharing paneId `w2:p2` (idle pane reuse)
    f.panes.bindings.unshift({
      ...ownedBinding,
      bindingId: "bind-old-released",
      agentId: "dev-old-released",
      worktreePath: "/tmp/old-worktree",
      cwd: "/tmp/old-worktree",
      session: { source: "test", kind: "id", value: "session-old" },
      metadata: { taskId: "run-0-old", runId: "run-0", allocationStatus: "released" }
    });

    // Also simulate a stale expired leaseReacquisition + expired lease on the assignment, and prune binding after stop proof
    await f.journal.exclusive(async (state, save) => {
      const out = state.outbound.find(o => o.message.message_id === developer.message.message_id)!;
      out.leaseReacquisition = {
        leaseId: "lease-reacq-1",
        agentId: ownedBinding.agentId,
        runId: "run-1",
        taskId: "implement",
        attemptId: out.attemptId,
        ttlMs: 1_000,
        requestedAt: f.ports.clock().toISOString(),
        idempotencyKey: "reacq-1"
      };
      await save();
    });
    f.advance(360_000);

    await f.runtime.cancel("run-1", "Operator cancelled");
    expect(scopeCalls).toContain(`${ownedBinding.bindingId}:w2:p2`);

    // Simulate binding pruned from manifest before reconciliation finishes releasing allocation metadata
    f.panes.bindings = f.panes.bindings.filter(b => b.bindingId !== ownedBinding.bindingId);

    const report = await f.runtime.reconcileCancellation("run-1");
    expect(report.fullyStopped).toBe(true);
    expect(report.blockers).toEqual([]);
    const snap = unwrap(await f.engine.getSnapshot("run-1"));
    expect(snap.status).toBe("cancelled");
  });
});

describe("Round 2 Slice 8 — Live Incident #2: Unmeasured Verifier Phase & Developer Allocation Recovery", () => {
  it("recovers an unmeasured released conditional_evidence QA phase via Coordinator resume_run and queues retry notice even when Developer pane is momentarily busy", async () => {
    const f = await createFixture({ tdd: true });
    const { developer } = await f.dispatch("run-1");
    const devBinding = f.panes.bindings.find(p => p.bindingId === developer.selector)!;
    const qaBinding = f.panes.bindings.find(p => p.role === "qa")!;
    const head = git(devBinding.worktreePath!, "rev-parse", "HEAD");

    const phaseReq = (await f.runtime.requestPhaseVerification(devBinding, "run-1", "implement", "red", head)) as {
      messageId: string;
    };
    await f.runtime.flushOutbound();

    // QA ends its turn without calling record_behavioral_verification, and outbox releases QA's lease
    await f.runtime.specialistTurnStopped(qaBinding, "qa", f.ports.clock().toISOString(), phaseReq.messageId);
    await f.runtime.flushOutbound();

    const stateAfterStop = await f.state();
    const orphan = stateAfterStop.outbound.find(o => o.message.message_id === phaseReq.messageId)!;
    expect(orphan.status).toBe("released");
    const runAfterStop = stateAfterStop.runs.find(r => r.runId === "run-1")!;
    expect(runAfterStop.pendingAction).toMatchObject({
      kind: "coordinator_continuation",
      state: "pending",
      sourceMessageId: phaseReq.messageId
    });

    // Developer pane is momentarily busy while its writer lease is still valid when Coordinator invokes resume_run
    f.panes.busy.add(devBinding.paneId);
    const resumed = await f.tools.invoke(
      "resume_run",
      {
        runId: "run-1",
        actionId: runAfterStop.pendingAction!.actionId
      },
      { role: "coordinator" }
    );
    expect(resumed).toMatchObject({ queued: true, actionId: runAfterStop.pendingAction!.actionId });

    const stateAfterResume = await f.state();
    const retryNotice = stateAfterResume.outbound.find(
      o =>
        o.message.type === "task.status" &&
        (o.message.payload as any)?.kind === "policy_phase_outcome" &&
        (o.message.payload as any)?.status === "retry"
    );
    expect(retryNotice).toBeDefined();

    // Once Developer pane is ready, retry notice delivers and Developer can request a fresh Red measurement
    f.panes.busy.delete(devBinding.paneId);
    await f.runtime.flushOutbound();
    const reRequested = (await f.runtime.requestPhaseVerification(devBinding, "run-1", "implement", "red", head)) as {
      messageId: string;
    };
    expect(reRequested.messageId).not.toBe(phaseReq.messageId);
  });

  it("halts sibling allocation on escalated Developer allocation failure and clears stale pendingAction without duplicate worktrees on resume + tick", async () => {
    const f = await createFixture({ taskIds: ["implement", "implement-2"] });
    f.panes.failAllocationFor.set("run-1-implement", {
      code: "unavailable",
      retryable: false,
      message: "Temporary Herdr socket refusal"
    });

    const { spec, def } = await f.intake("run-1");
    await f.runtime.proposeWorkflow("run-1", spec, def);
    await f.runtime.tick();

    // Sibling task `implement-2` MUST NOT be allocated after `implement` already escalated the run
    expect(f.panes.allocationCalls).toEqual(["run-1-implement"]);
    const pausedRun = (await f.state()).runs[0]!;
    expect(pausedRun.status).toBe("escalated");
    expect(pausedRun.pendingAction?.sourceMessageId).toMatch(/^developer-allocation-/);

    // Repair allocation and resume + tick
    f.panes.failAllocationFor.delete("run-1-implement");
    await f.runtime.resumeBlockedRun("run-1", pausedRun.pendingAction!.actionId);
    await f.runtime.tick();

    const recoveredRun = (await f.state()).runs[0]!;
    expect(recoveredRun.status).toBe("implementing");
    expect(recoveredRun.error).toBeUndefined();
    expect(recoveredRun.pendingAction).toBeUndefined();
    expect(recoveredRun.tasks.find(t => t.taskId === "implement")!.worktrees).toHaveLength(1);
    expect(recoveredRun.tasks.find(t => t.taskId === "implement-2")!.worktrees).toHaveLength(1);
    const assignments = (await f.state()).outbound.filter(o => o.message.type === "task.assignment");
    expect(assignments).toHaveLength(2);
  });
});

describe("Round 2 Slice 8 — Live Incident #3: Role MCP Tool Null/Empty Optionals & Actionable Errors", () => {
  it("normalizes null and empty-string optional arguments across CoordinatorTools and owned MCP schemas", async () => {
    const f = await createFixture();
    const { spec, def } = await f.intake("run-1");

    const coordPrincipal = { role: "coordinator" as const };

    // report_progress with questions: null
    await expect(
      f.tools.invoke("report_progress", { runId: "run-1", headline: "Planning underway", questions: null }, coordPrincipal)
    ).resolves.toBeDefined();

    // request_specialist with requiredCapabilities: null, roleProfile: null
    await expect(
      f.tools.invoke(
        "request_specialist",
        {
          runId: "run-1",
          role: "architect",
          objective: "Check boundaries",
          requiredCapabilities: null,
          roleProfile: null
        },
        coordPrincipal
      )
    ).resolves.toBeDefined();

    // propose_workflow with maxIterations: null (previously Number(null) === 0 -> "Invalid verification limit")
    await expect(
      f.tools.invoke(
        "propose_workflow",
        {
          runId: "run-1",
          specification: spec,
          definition: def,
          maxIterations: null
        },
        coordPrincipal
      )
    ).resolves.toBeDefined();
    expect((await f.state()).runs[0]!.maxIterations).toBe(3);

    // inspect with null/empty optionals
    await expect(
      f.tools.invoke("inspect", { runId: "run-1", view: null, taskId: "", cursor: null }, coordPrincipal)
    ).resolves.toBeDefined();

    // resume_run on active run without matching blocker reports current run status & pendingAction diagnostics
    await expect(
      f.runtime.resumeBlockedRun("run-1", "next-nonexistent")
    ).rejects.toThrow(/No matching recoverable blocker to resume.*status=.*activeActionId=/i);

    // Owned Zod input schemas accept null / "" on optional properties without breaking existing omitted-field shapes
    expect(PlanningReferenceInputSchema.parse({ section: null, view: null, includeRunners: null })).toEqual({
      section: "all"
    });
    expect(InspectInputSchema.parse({ runId: null, view: "", taskId: null, cursor: "" })).toEqual({});
    expect(AssignmentContextInputSchema.parse({ view: null, surveyView: "", includeReleased: null })).toEqual({});
    expect(
      ReadProjectPolicyInputSchema.parse({ filePath: null, view: "", heading: null, knownDigests: null })
    ).toEqual({});
    expect(
      TaskHandoverReadInputSchema.parse({ runId: null, taskId: "", view: null, cursor: "", offset: null })
    ).toEqual({});
    expect(
      PolicyReviewPageInputSchema.parse({
        runId: "run-1",
        taskId: "implement",
        phase: "green",
        view: null,
        cursor: "",
        offset: null
      })
    ).toEqual({ runId: "run-1", taskId: "implement", phase: "green" });

    // parseCoordinatorAssessmentInput tolerates null on optional Specification fields
    expect(() =>
      parseCoordinatorAssessmentInput({
        ...spec,
        architectureNotes: null,
        securityConsiderations: null,
        rollbackPlan: null
      })
    ).not.toThrow();
  });

  it("accepts null/omitted optional handover arrays & null optional source location fields, and reports exact mismatched fields on handover rejection", async () => {
    const f = await createFixture();
    const { developer } = await f.dispatch("run-1");
    const devBinding = f.panes.bindings.find(p => p.bindingId === developer.selector)!;

    // runtime.taskHandover tolerates null/empty runId & taskId on read and propose
    const readRes = (await f.runtime.taskHandover(devBinding, { runId: null, taskId: "" })) as any;
    expect(readRes.handover.status).toBe("absent");
    const currentBinding: HandoverBinding = readRes.binding;

    // admitHandover tolerates null optional arrays and null optional ReworkSourceLocation fields
    const admitted = admitHandover(
      {
        schemaVersion: 1,
        binding: currentBinding,
        content: {
          nextAction: "Verify edge case",
          decisions: null,
          disprovedHypotheses: undefined,
          untestedAngles: null,
          references: [{ kind: "source", location: { path: "guide.md", startLine: 1, endLine: null, symbol: null } }]
        }
      },
      currentBinding
    );
    expect(admitted.status).toBe("accepted");

    // Stale revision on binding reports exact mismatched field in reason and preserves it through taskHandoverAcknowledgement
    const mismatched = admitHandover(
      {
        schemaVersion: 1,
        binding: { ...currentBinding, revision: "f".repeat(40) },
        content: { nextAction: "Continue" }
      },
      currentBinding
    );
    expect(mismatched).toMatchObject({
      status: "rejected",
      code: "handover_binding_mismatch",
      reason: expect.stringContaining("revision")
    });
    const ack = taskHandoverAcknowledgement({ binding: currentBinding, handover: mismatched }) as any;
    expect(ack.handover.reason).toContain("revision");

    // describeValidationError calls out null passed for optional RoleMessage fields
    const roleMsgParse = RoleMessageSchema.safeParse({
      schema_version: 2,
      message_id: "m-1",
      correlation_id: "c-1",
      causation_id: null,
      run_id: "run-1",
      sender: { role: "developer" },
      recipient: { role: "coordinator" },
      type: "task.status",
      payload: { status: "blocked", summary: "Need help" },
      artifact_references: [],
      idempotency_key: "m-1"
    });
    expect(roleMsgParse.success).toBe(false);
    if (!roleMsgParse.success) {
      expect(describeValidationError(roleMsgParse.error)).toMatch(/omit optional|causation_id/i);
    }
  });
});

describe("Round 2 Slice 8 — Area 4: EISDIR & FUSE/NTFS fsync Tolerance", () => {
  it("handles trailing-slash directory affectedPaths and symlinked docs/adr in AssignmentSurvey & ProjectContextService, and rejects directory targets in AnalysisWorkflowRuntime", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2-s8-fs-")));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    const repo = join(root, "repo");
    const externalAdr = join(root, "external-adr");
    await mkdir(join(repo, "skills/use-context7"), { recursive: true });
    await mkdir(join(repo, "docs"), { recursive: true });
    await mkdir(externalAdr, { recursive: true });
    await writeFile(join(externalAdr, "0001-ext.md"), "# 1. External ADR\nStatus: Accepted\n");
    await symlink(externalAdr, join(repo, "docs/adr"));
    await writeFile(join(repo, "skills/use-context7/SKILL.md"), "# Context Skill\nDetails\n");
    git(repo, "init", "-b", "main");
    git(repo, "add", "skills/use-context7/SKILL.md");
    git(repo, "commit", "-m", "init");

    const binding = PaneBindingSchema.parse({
      schemaVersion: 2,
      bindingId: "b-coord",
      sessionId: "s-1",
      role: "coordinator",
      agentId: "coordinator",
      workspaceId: "w1",
      tabId: "t1",
      paneId: "w1:p1",
      provider: "test",
      agentKind: "test",
      cwd: repo,
      worktreePath: repo,
      isolationMode: "dedicated_pane",
      readOnlyWorkspace: true,
      session: { source: "test", kind: "id", value: "sess-coord" },
      transportState: "idle",
      boundAt: new Date().toISOString()
    });
    const delegation = {
      schemaVersion: 2,
      delegationId: "del-1",
      messageId: "msg-1",
      correlationId: "corr-1",
      sessionId: "s-1",
      runId: "run-dir-1",
      requestedBy: "conversation",
      targetRole: "coordinator",
      title: "Update skill directory",
      objective: "Inspect skills/use-context7/ directory",
      specificationId: "spec-dir-1",
      sddLevel: "lightweight",
      acceptanceCriteria: [
        {
          id: "ac-1",
          description: "Survey directory safely",
          category: "functional",
          verificationMethod: "manual_review",
          required: true,
          status: "pending",
          evidenceArtifactIds: []
        }
      ],
      inputArtifacts: [],
      priority: "normal",
      requestedAt: new Date().toISOString(),
      idempotencyKey: "msg-1",
      metadata: { affectedPaths: ["skills/use-context7/"] }
    };
    const msg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "msg-1",
      correlation_id: "corr-1",
      run_id: "run-dir-1",
      sender: { role: "conversation" },
      recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "w1:p1" },
      type: "delegation.request",
      payload: delegation,
      artifact_references: [],
      occurred_at: new Date().toISOString(),
      idempotency_key: "msg-1"
    });
    const handle = {
      executionId: "exec-1",
      requestId: "req-1",
      attemptId: "att-1",
      runId: "run-dir-1",
      taskId: "intake",
      idempotencyKey: "msg-1",
      target: {
        transport: "herdr",
        agentId: "coordinator",
        paneId: "w1:p1",
        workspaceId: "w1",
        tabId: "t1",
        worktreePath: repo,
        session: binding.session
      },
      correlation: { token: "t", provenance: "transport", verified: true },
      acceptedAt: new Date().toISOString()
    };

    const survey = new AssignmentSurvey(repo);
    const prepared = await survey.prepare(binding, [{ status: "accepted", message: msg, handle }], [{ runId: "run-dir-1", delegation }], []);
    expect(prepared?.status).toBe("prepared");
    expect((prepared as any).context.includedFiles).toContain("skills/use-context7/SKILL.md");

    // AnalysisWorkflowRuntime writeDocument rejects existing directory target with AnalysisPermissionDenied instead of EISDIR
    await mkdir(join(repo, "docs/analysis/req-1/r1/analysis.md"), { recursive: true });
    const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "an-1" }));
    const runStore = unwrap(openSqliteRunStore({ filename: join(root, "an-runs.db") }));
    cleanups.push(async () => {
      runStore.close();
      artifacts.close();
    });
    const analysisRuntime = await AnalysisWorkflowRuntime.open({
      engine: new DeterministicWorkflowEngine(),
      runStore,
      artifactStore: artifacts,
      roles: { dispatch: async () => ({ agentId: "specifier", output: {} }) },
      repositoryRoot: repo,
      journalPath: join(root, "analysis-journal.json"),
      authorizeHuman: () => true,
      now: () => new Date().toISOString()
    });
    await expect(
      (analysisRuntime as any).writeDocument(
        { intake: { documentRoot: "docs/analysis", requestId: "req-1", revision: 1 } },
        "docs/analysis/req-1/r1/analysis.md",
        "# Content\n"
      )
    ).rejects.toBeInstanceOf(AnalysisPermissionDenied);
  });

  it("tolerates FUSE/NTFS EINVAL on regular-file fsync in TaskHandoverStore and ArchitecturalDecisionStore", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2-s8-fsync-")));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });

    simulatedWritableFileSyncErrorCode = "EINVAL";

    const handoverBinding: HandoverBinding = {
      runId: "run-1",
      taskId: "task-1",
      assignmentId: "assign-1",
      attempt: 1,
      attemptId: "att-1",
      generation: 0,
      reworkGeneration: 0,
      worktreePath: root,
      revision: "a".repeat(40),
      specId: "spec-1",
      specVersion: 1,
      specFingerprint: "b".repeat(64),
      requirementFingerprint: "c".repeat(64)
    };
    const admitted = admitHandover(
      {
        schemaVersion: 1,
        binding: handoverBinding,
        content: { nextAction: "Proceed", decisions: [], disprovedHypotheses: [], untestedAngles: [], references: [] }
      },
      handoverBinding
    );
    expect(admitted.status).toBe("accepted");
    if (!("envelope" in admitted)) throw new Error("expected envelope");

    const handoverStore = new TaskHandoverStore(join(root, "handovers"));
    await expect(handoverStore.write(admitted.envelope)).resolves.toBeUndefined();
    expect((await handoverStore.read("run-1", "task-1")).status).toBe("accepted");

    const adrStore = new ArchitecturalDecisionStore(root);
    await expect(
      adrStore.recordDecision({
        decisionId: "ADR-999",
        title: "NTFS FUSE Sync",
        status: "accepted",
        summary: "Tolerate EINVAL on regular-file fsync",
        affectedPaths: ["packages/runtime"]
      })
    ).resolves.toMatchObject({ decisionId: "ADR-999" });
  });
});

describe("Round 2 Slice 8 — Area 5: Intra-Package ESM Circular Imports & Surrogate/UTF-8 Safe Truncation", () => {
  it("has zero circular ESM value imports involving owned Slice 8 modules", async () => {
    const ownedAgenticFiles = new Set([
      "runtime.ts",
      "cancellation-stop.ts",
      "ports.ts",
      "tools.ts",
      "role-tool-schema.ts",
      "tool-action-policy.ts",
      "tool-reachability.ts",
      "mcp-output-views.ts",
      "policy-phase-review.ts",
      "policy-prompt.ts",
      "policy-evidence-view.ts",
      "policy-review-pages.ts",
      "rework-causality.ts",
      "role-message-feedback.ts",
      "workflow-rejection.ts",
      "assessment-input.ts",
      "assignment-survey.ts",
      "prototype-review.ts",
      "requirement-revision-guidance.ts",
      "task-handover.ts",
      "task-handover-view.ts"
    ]);
    const dirs = ["agentic", "context", "handover", "planning", "analysis", "qa", "data"];
    const allFiles = new Set<string>();
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) await walk(full);
        else if (ent.isFile() && ent.name.endsWith(".ts")) allFiles.add(resolve(full));
      }
    };
    for (const d of dirs) await walk(join(runtimeSrcRoot, d));

    const importRe = /(?:import|export)\s+(?!type\b)(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/g;
    const adj = new Map<string, string[]>();
    for (const file of allFiles) {
      const src = await readFile(file, "utf8");
      const edges: string[] = [];
      for (const m of src.matchAll(importRe)) {
        let target = resolve(dirname(file), m[1]!);
        if (target.endsWith(".js")) target = `${target.slice(0, -3)}.ts`;
        if (allFiles.has(target)) edges.push(target);
      }
      adj.set(file, edges);
    }

    const isOwnedSlice8 = (absPath: string) => {
      const rel = relative(runtimeSrcRoot, absPath).replace(/\\/g, "/");
      if (rel.startsWith("agentic/")) return ownedAgenticFiles.has(rel.slice("agentic/".length));
      return dirs.filter(d => d !== "agentic").some(d => rel.startsWith(`${d}/`));
    };

    const visited = new Set<string>();
    const stack = new Set<string>();
    const pathStack: string[] = [];
    const ownedCycles: string[][] = [];
    const dfs = (u: string) => {
      visited.add(u);
      stack.add(u);
      pathStack.push(u);
      for (const v of adj.get(u) ?? []) {
        if (!visited.has(v)) dfs(v);
        else if (stack.has(v)) {
          const cycle = pathStack.slice(pathStack.indexOf(v)).concat(v);
          if (cycle.some(isOwnedSlice8)) {
            ownedCycles.push(cycle.map(p => relative(runtimeSrcRoot, p)));
          }
        }
      }
      stack.delete(u);
      pathStack.pop();
    };
    for (const f of allFiles) if (!visited.has(f)) dfs(f);

    expect(ownedCycles).toEqual([]);
  });

  it("never splits UTF-16 surrogate pairs or UTF-8 multibyte sequences across Slice 8 truncation boundaries", async () => {
    // 1) describeValidationError (MAX_FEEDBACK_LENGTH = 1500 -> slice boundary at 1499)
    // Place 🚀 (\uD83D\uDE80, 2 UTF-16 code units) at index 1498..1499
    const feedbackInput = `${"a".repeat(1498)}🚀extra-tail`;
    const feedbackOut = describeValidationError(feedbackInput);
    assertWellFormedUnicode(feedbackOut);

    // 2) requirementRevisionGuidance (slice boundaries at 200 and 2000)
    const blockerAt199 = `${"b".repeat(199)}🚀tail-text`;
    const guidance = requirementRevisionGuidance(
      {
        requested_action: "authorized_requirement_revision",
        summary: "Scope exceeds lightweight SDD",
        blockers: [blockerAt199]
      },
      "run-1"
    );
    expect(guidance).toBeDefined();
    assertWellFormedUnicode(guidance!.blockers[0]!);

    // 3) Prototype review reason truncation (slice boundaries at 4000 and 2000)
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2-s8-utf8-")));
    const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "art"), storeId: "proto1" }));
    cleanups.push(async () => {
      artifacts.close();
      await rm(root, { recursive: true, force: true });
    });
    const putArt = async (artifactId: string, body: string, mediaType: string) => {
      const bytes = Buffer.from(body, "utf8");
      return unwrap(
        await artifacts.put({
          options: {
            artifactId,
            runId: "run-proto-1",
            taskId: "prototype",
            kind: "report",
            mediaType,
            expectedIntegrity: {
              checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
              sizeBytes: bytes.length
            },
            idempotencyKey: artifactId
          },
          content: (async function* () {
            yield bytes;
          })()
        })
      );
    };
    const manifestArt = await putArt("art-manifest", "{}", "application/json");
    const fileArt = await putArt("art-proto-index", "<div>mock</div>", "text/html");

    const longPurpose = `${"p".repeat(1998)}🚀`;
    const flowIds = Array.from({ length: 20 }, (_, i) => `flow-boundary-identifier-number-${String(i + 1).padStart(2, "0")}-${"x".repeat(25)}`);
    const scope = PrototypeScopeSchema.parse({
      purpose: longPurpose,
      flows: flowIds.map(id => ({ id, description: "Main flow" })),
      allowedPaths: ["prototype/index.html"],
      artifacts: ["index.html"],
      criteria: [{ id: "c-1", description: "Renders safely", flowIds }],
      disposition: "evolvable",
      environment: "mock",
      dataPolicy: "synthetic",
      maxRevisions: 3
    });
    const scopeRes = acceptPrototypeScope(undefined, scope, {
      requirementRevision: 1,
      productCriterionIds: ["ac-1"],
      now: new Date().toISOString()
    });
    const flowDigests = Object.fromEntries(scope.flows.map(f => [f.id, "b".repeat(64)]));
    const admittedVer = admitPrototypeVersion(scopeRes.record, {
      runId: "run-proto-1",
      sessionId: "sess-1",
      now: new Date().toISOString(),
      version: {
        manifest: manifestArt,
        manifestDigest: "a".repeat(64),
        files: [
          {
            path: "prototype/index.html",
            mediaType: "text/html",
            flowIds,
            artifact: fileArt
          }
        ],
        flowDigests,
        summary: "Prototype summary"
      }
    });
    assertWellFormedUnicode(admittedVer.approval.request.reason);

    const feedbackReasonAt1999 = `${"r".repeat(1999)}🚀tail-feedback`;
    const protoDecision = ApprovalDecisionSchema.parse({
      schemaVersion: 2,
      approvalId: admittedVer.approval.request.approvalId,
      runId: "run-proto-1",
      sessionId: "sess-1",
      target: admittedVer.approval.request.target,
      revision: admittedVer.approval.request.revision,
      generation: admittedVer.approval.request.generation,
      decision: "changes_requested",
      decidedBy: "human-1",
      decidedAt: new Date().toISOString(),
      reason: feedbackReasonAt1999,
      feedbackArtifacts: [],
      idempotencyKey: "proto-decision-1"
    });
    expect(settlePrototypeDecision(scopeRes.record, admittedVer.approval, protoDecision)).toBe("revision_requested");
    assertWellFormedUnicode(scopeRes.record.feedback[0]!.reason);

    // 4) ProjectContextService UTF-8 byte truncation (maxBytesPerFile cutting mid-4-byte emoji 🚀)
    const repoDir = join(root, "utf8-repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, "emoji.ts"), `export const msg = "${"🚀".repeat(200)}";\n`, "utf8");
    const ctxSvc = new ProjectContextService(repoDir);
    const selected = await ctxSvc.selectFilesForTask({
      role: "developer",
      taskId: "t-1",
      title: "Emoji truncation",
      description: "Ensure no U+FFFD on multibyte boundary",
      ownedPaths: ["emoji.ts"],
      affectedPaths: ["emoji.ts"],
      maxBytesPerFile: 60, // 37-byte suffix + 23-byte body (20 ASCII + 3 bytes into 4-byte 🚀!)
      maxTotalBytes: 500
    });
    expect(selected.includedFiles).toHaveLength(1);
    expect(selected.includedFiles[0]!.truncated).toBe(true);
    expect(selected.includedFiles[0]!.content).toContain('export const msg = "');
    assertWellFormedUnicode(selected.includedFiles[0]!.content);
  });
});
