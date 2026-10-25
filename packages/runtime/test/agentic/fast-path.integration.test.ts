import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentResultSchema,
  ApprovalDecisionSchema,
  QualityGateResultSchema,
  RoleMessageSchema,
  VerificationResultSchema,
  type PaneBinding,
  type QualityGate,
  type QualityGateContext,
  type RoleMessage,
  type Specification,
  type WorkflowDefinition
} from "@bflow/contracts";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { openSqliteRunStore } from "@bflow/persistence";
import { draft, workflow } from "../../../specification/test/fixtures.js";
import { DEFAULT_HOST_CHECKS, HostVerification } from "../../src/agentic/host-verification.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
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

class Panes implements PanePolicy {
  busy = new Set<string>();
  bindings: PaneBinding[] = [
    "conversation",
    "coordinator",
    "specifier",
    "architect",
    "planner",
    "reviewer",
    "qa",
    "tester"
  ].map(role => ({
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
  }));

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
    return {
      ok: true as const,
      value: { readyForPrompt: !this.busy.has(p.role), occupantMatches: true, paneId: p.paneId, agentId: p.agentId }
    };
  }

  async allocateDeveloper(request: { taskId: string; worktreePath: string; agentName: string }) {
    const old = this.bindings.find(p => p.agentId === request.agentName);
    if (old) return { ok: true as const, value: old };
    const p = {
      ...this.bindings[0]!,
      bindingId: request.agentName,
      role: "developer" as const,
      agentId: request.agentName,
      paneId: `pane-${request.agentName}`,
      cwd: request.worktreePath,
      worktreePath: request.worktreePath,
      readOnlyWorkspace: false
    };
    this.bindings.push(p);
    return { ok: true as const, value: p };
  }

  async releaseDeveloper() {
    return { ok: true as const, value: undefined };
  }
}

async function createIntegrationHarness(options: {
  fastPathMode?: "auto" | "off";
  scenario: "refactor" | "docs";
}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-fast-path-int-")));
  const repository = join(root, "repo");
  await mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test");
  git(repository, "config", "user.email", "test@example.test");
  await writeFile(join(repository, "guide.md"), "initial\n");
  await mkdir(join(repository, "src"), { recursive: true });
  await mkdir(join(repository, "test"), { recursive: true });
  await writeFile(join(repository, "src/double.cjs"), "module.exports = x => x * 2;\n");
  await writeFile(
    join(repository, "test/double.test.cjs"),
    "const test = require('node:test'); const assert = require('node:assert/strict'); const double = require('../src/double.cjs'); test('doubles input', () => { assert.equal(double(3), 6); });\n"
  );
  git(repository, "add", ".");
  git(repository, "commit", "-m", "baseline");

  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "fast-path-int" }));
  cleanups.push(async () => {
    store.close();
    artifacts.close();
    await rm(root, { recursive: true, force: true });
  });

  const transport = new FakeAgentTransport();
  const panes = new Panes();
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const bindingReceiptKeys = { "native-test-host": publicKey };
  const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys });
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });

  let runtime: AgenticWorkflowRuntime;
  const receipts = new HostReceiptJournal(join(root, "host-receipts"), repository, "session-1");
  const verification = new HostVerification(() => runtime, () => artifacts, receipts, []);

  const unitCheck = {
    id: "host-behavioral-unit",
    name: "Host behavioral unit runner",
    evaluator: "host-behavioral-unit",
    required: true,
    timeout: { executionTimeoutMs: 30_000, onTimeout: "block" as const },
    metadata: { bindAcceptedCriteria: true, bindMethodTestNames: true },
    configuration: {
      kind: "deterministic",
      method: "unit_test",
      command: "node --test test/double.test.cjs",
      criterionIds: ["ac-1"],
      testNames: ["doubles input"],
      role: "tester",
      levels: ["unit"]
    }
  };

  const checks = [
    ...DEFAULT_HOST_CHECKS,
    ...(options.scenario === "refactor" ? [unitCheck] : [])
  ] as any[];

  const gates: QualityGate[] = [
    ...DEFAULT_HOST_CHECKS.filter(c => (c.configuration as any).kind === "review").map(check => ({
      id: check.id,
      evaluate: async (context: QualityGateContext, opts?: Parameters<QualityGate["evaluate"]>[1]) => {
        let done = false;
        const promise = runtime.herdrQualityGate(check.id).evaluate(context, opts).finally(() => {
          done = true;
        });
        while (!done) {
          await new Promise(r => setTimeout(r, 15));
          if (!done) await respondToPendingReviews();
        }
        return promise;
      }
    })),
    verification.deterministicGate(),
    {
      id: "host-behavioral-unit",
      evaluate: async (context: QualityGateContext) => {
        const config = context.definition.configuration as any;
        const input = context.input as any;
        execFileSync(process.execPath, ["--test", "test/double.test.cjs"], {
          cwd: input.sourceWorktreePath,
          encoding: "utf8"
        });
        return {
          ok: true as const,
          value: QualityGateResultSchema.parse({
            gateId: context.definition.id,
            runId: context.runId,
            taskId: context.taskId!,
            evaluationId: randomUUID(),
            status: "passed",
            findings: [],
            producedArtifacts: [],
            evaluatedAt: new Date().toISOString(),
            metadata: {
              verification: {
                schemaVersion: 2,
                checkId: "host-behavioral-unit",
                runId: context.runId,
                taskId: context.taskId,
                attemptId: context.attemptId,
                sourceRevision: input.sourceRevision,
                specFingerprint: input.specFingerprint,
                scope: input.scope,
                independentExecution: true,
                isolated: true,
                executorId: "bflow-host-behavioral-runner",
                role: "tester",
                method: "unit_test",
                command: "node --test test/double.test.cjs",
                exitCode: 0,
                testNames: config.testNames,
                criteria: config.criterionIds.map((criterionId: string) => ({
                  criterionId,
                  passed: true,
                  summary: "Host behavioral runner verified doubles input"
                })),
                summary: "Host behavioral runner verified doubles input"
              }
            }
          })
        };
      }
    }
  ];

  const policies = await loadAgenticPolicies({
    repositoryPath: repository,
    artifactStore: artifacts,
    gates,
    loadSpecification: id => runtime.loadSpecification(id),
    authorizeApprover: decision => ["coordinator", "human-1"].includes(decision.decidedBy)
  });

  const conversationInbox: RoleMessage[] = [];
  const ports: AgenticRuntimePorts = {
    engine,
    runStore: store,
    artifactStore: artifacts,
    registry,
    transport,
    panes,
    policies,
    deliverToConversation: async (message: RoleMessage) => {
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
      qa: ["verification", "repository.read", "testing"],
      tester: ["testing", "repository.read"]
    },
    taskChecks: checks,
    workflowChecks: checks,
    fastPathMode: options.fastPathMode ?? "auto",
    authenticateMessage: async () => true,
    authenticateResult: async () => true,
    authenticateEvidence: async () => true,
    authenticateGateResult: async () => true,
    authorizeHuman: async decision => decision.decidedBy === "human-1",
    projectApprovalRequired: () => true
  };

  const runtimeOptions = { journalDirectory: join(root, "journal"), repositoryPath: repository };
  runtime = new AgenticWorkflowRuntime(ports, runtimeOptions);
  let tools = new CoordinatorTools(runtime);

  const time = new Date().toISOString();
  const spec: Specification = draft("documentation");
  spec.createdAt = time;
  spec.updatedAt = time;

  if (options.scenario === "refactor") {
    spec.affectedPaths = ["src/double.cjs", "test/double.test.cjs"];
    spec.acceptanceCriteria = [
      {
        id: "ac-1",
        description: "The requested outcome is independently verifiable",
        category: "functional",
        verificationMethod: "unit_test",
        required: true,
        status: "pending",
        evidenceArtifactIds: []
      }
    ];
    (spec.metadata!.sdd as any).assessment = {
      kind: "refactoring",
      behaviorChange: false,
      modules: ["example"],
      securityImpact: false,
      publicApiImpact: false,
      dataSchemaImpact: false,
      architectureImpact: false,
      migrationRequired: false,
      risk: "low",
      unresolvedQuestions: []
    };
    spec.metadata!.conditionalTdd = {
      policyVersion: 1,
      taskId: "implement",
      taskType: "refactoring",
      changeImpact: {
        surfaces: ["refactoring"],
        behaviorChanged: false,
        deterministic: true,
        regressionReproducible: false,
        securitySensitive: false,
        dataMigration: false,
        scope: "local"
      },
      infrastructure: {
        readiness: "ready",
        commands: [
          { method: "unit_test", command: "node --test test/double.test.cjs", level: "unit" },
          { method: "integration_test", command: "git diff --check", level: "integration" }
        ]
      },
      testability: { level: "automated", rationale: "Automated node:test runner" },
      riskClassification: "low",
      conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] }
    };
  } else {
    spec.affectedPaths = ["guide.md"];
    spec.metadata!.conditionalTdd = {
      policyVersion: 1,
      taskId: "implement",
      taskType: "documentation",
      changeImpact: {
        surfaces: ["documentation"],
        behaviorChanged: false,
        deterministic: false,
        regressionReproducible: false,
        securitySensitive: false,
        dataMigration: false,
        scope: "local"
      },
      infrastructure: {
        readiness: "ready",
        commands: [{ method: "integration_test", command: "git diff --check", level: "integration" }]
      },
      testability: { level: "automated", rationale: "Documentation change" },
      riskClassification: "low",
      conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] }
    };
  }

  const def: WorkflowDefinition = workflow(["implement"]);
  def.tasks[0]!.metadata = { ownedPaths: [...spec.affectedPaths], forbiddenPaths: ["secrets"] };

  const delegation = {
    schemaVersion: 2,
    delegationId: "delegation-1",
    messageId: "intake-1",
    correlationId: "correlation-1",
    sessionId: "session-1",
    runId: "run-1",
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
    idempotencyKey: "intake-1"
  };

  const envelope = (type: string, payload: unknown, extra: any = {}) =>
    RoleMessageSchema.parse({
      schema_version: 2,
      message_id: randomUUID(),
      correlation_id: "correlation-1",
      run_id: "run-1",
      sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" },
      recipient: { role: "coordinator" },
      type,
      payload,
      artifact_references: [],
      idempotency_key: randomUUID(),
      ...extra
    });

  await runtime.receiveHerdr(envelope("delegation.request", delegation, { message_id: "intake-1", idempotency_key: "intake-1" }));

  const inspect = async () => (await runtime.inspect("run-1")) as any;

  async function submit(fileChange?: { file: string; content: string }) {
    const state = (await runtime.inspect()) as any;
    const outbound = [...state.outbound].reverse().find((out: any) => out.taskId === "implement" && out.message.type === "task.assignment");
    const handle = outbound.handle;
    const path = handle.target.worktreePath;
    const file = fileChange?.file ?? spec.affectedPaths[0]!;
    await writeFile(join(path, file), fileChange?.content ?? `updated ${randomUUID()}\n`);
    git(path, "add", file);
    git(path, "commit", "-m", "implement");
    const result = AgentResultSchema.parse({
      requestId: handle.requestId,
      attemptId: handle.attemptId,
      runId: "run-1",
      taskId: "implement",
      executionId: handle.executionId,
      status: "succeeded",
      verification: {
        status: "verified",
        evidence: "Authenticated test-host result",
        correlation:
          unwrap(await ports.engine.getSnapshot("run-1"))!.tasks.find(task => task.taskId === "implement")!.bindingVerification?.receipt
            .correlation ?? handle.correlation
      },
      artifactProposals: [],
      retryable: false,
      startedAt: handle.acceptedAt,
      completedAt: new Date().toISOString()
    });
    await runtime.receiveHerdr(
      envelope("implementation.submitted", result, {
        causation_id: outbound.message.message_id,
        sender: { role: "developer", agent_id: handle.target.agentId, pane_id: handle.target.paneId }
      })
    );
  }

  async function evidence(taskId = "implement", phase: "red" | "green" | "refactor" | "verification" = "verification") {
    const run = await inspect();
    const task = run.tasks.find((t: any) => t.taskId === taskId);
    const strategy = task.spec.strategy;
    const startedAt = new Date().toISOString();
    const bytes = Buffer.from(`${taskId}-${phase}-${randomUUID()}`);
    const ref = unwrap(
      await artifacts.put({
        options: {
          artifactId: randomUUID(),
          runId: "run-1",
          taskId,
          kind: "test-result",
          mediaType: "text/plain",
          expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length },
          idempotencyKey: randomUUID()
        },
        content: (async function* () {
          yield bytes;
        })()
      })
    );
    const method = spec.acceptanceCriteria[0]!.verificationMethod;
    const cmd = (spec.metadata?.conditionalTdd as any)?.infrastructure?.commands?.[0]?.command;
    const cmdFields = method !== "manual_review" && cmd ? { command: cmd, exitCode: 0 } : {};
    const result = VerificationResultSchema.parse({
      schemaVersion: 2,
      verificationId: randomUUID(),
      runId: "run-1",
      taskId,
      cycleNumber: 1,
      attemptId: randomUUID(),
      status: "passed",
      independentExecution: true,
      evaluatedCriteria: [{ criterionId: "ac-1", passed: true, evidenceArtifactId: ref.artifactId, summary: "Observed target behavior", ...cmdFields }],
      qualityGateResults: [],
      evidenceArtifacts: [ref],
      findings: [],
      verifiedBy: "tester",
      startedAt,
      completedAt: new Date().toISOString(),
      metadata: {
        conditionalTdd: {
          phase,
          decisionId: strategy.tddDecision.decisionId,
          specId: strategy.specId,
          sourceRevision: "implementation-source",
          testRevision: "unchanged-tests",
          testNames: strategy.criterionMappings[0].testNames,
          observations: [{ method, criterionId: "ac-1", evidenceArtifactId: ref.artifactId, summary: "Independent observation", ...cmdFields }]
        }
      }
    });
    await runtime.receiveHerdr(envelope("verification.result", result, { sender: { role: "tester" } }));
  }

  async function approve() {
    const run = await inspect();
    const request = run.approval;
    const approved = ApprovalDecisionSchema.parse({
      schemaVersion: 2,
      approvalId: request.approvalId,
      runId: "run-1",
      sessionId: "session-1",
      target: request.target,
      revision: request.revision,
      generation: request.generation,
      decision: "approved",
      decidedBy: "human-1",
      decidedAt: new Date().toISOString(),
      feedbackArtifacts: [],
      idempotencyKey: randomUUID()
    });
    await runtime.receiveHerdr(envelope("approval.decision", approved));
  }

  const repliedGateMessages = new Set<string>();
  const respondToPendingReviews = async () => {
    const state = (await runtime.inspect()) as any;
    for (const out of state.outbound) {
      if (
        out.status === "accepted" &&
        !repliedGateMessages.has(out.message.message_id) &&
        (out.message.recipient.role === "reviewer" || out.message.recipient.role === "qa") &&
        out.message.type === "verification.requested"
      ) {
        repliedGateMessages.add(out.message.message_id);
        const ctx = out.message.payload;
        const cfg = ctx.definition?.configuration ?? {};
        const input = ctx.input ?? {};
        const gateResult = QualityGateResultSchema.parse({
          gateId: ctx.definition.id,
          runId: ctx.runId,
          taskId: ctx.taskId,
          evaluationId: randomUUID(),
          status: "passed",
          findings: [],
          producedArtifacts: [],
          evaluatedAt: new Date().toISOString(),
          metadata: {
            verification: {
              schemaVersion: 2,
              checkId: ctx.definition.id,
              runId: ctx.runId,
              taskId: ctx.taskId,
              attemptId: ctx.attemptId,
              sourceRevision: input.sourceRevision,
              specFingerprint: input.specFingerprint,
              scope: input.scope,
              independentExecution: true,
              isolated: true,
              executorId: `herdr-${out.message.recipient.role}`,
              role: out.message.recipient.role,
              method: cfg.method ?? "manual_review",
              testNames: cfg.testNames ?? [],
              criteria: (cfg.criterionIds ?? []).map((criterionId: string) => ({
                criterionId,
                passed: true,
                summary: "Herdr review passed"
              })),
              summary: "Herdr review passed"
            }
          }
        });
        await runtime.receiveHerdr(
          envelope("review.verdict", gateResult, {
            causation_id: out.message.message_id,
            sender: {
              role: out.message.recipient.role,
              agent_id: out.handle.target.agentId,
              pane_id: out.handle.target.paneId
            }
          })
        );
      }
    }
  };

  return {
    root,
    repository,
    ports,
    get runtime() {
      return runtime;
    },
    get tools() {
      return tools;
    },
    spec,
    def,
    transport,
    conversationInbox,
    inspect,
    submit,
    evidence,
    approve,
    respondToPendingReviews,
    restartRuntime: async () => {
      ports.engine = new DeterministicWorkflowEngine({ bindingReceiptKeys });
      runtime = new AgenticWorkflowRuntime(ports, runtimeOptions);
      tools = new CoordinatorTools(runtime);
      await runtime.initialize();
      return runtime;
    }
  };
}

describe("Task 7: End-to-end fast-path integration tests", { timeout: 120_000 }, () => {
  it("Scenario A: refactor with behavioral runner auto-approves design, skips task & workflow review, and requests delivery approval", async () => {
    const h = await createIntegrationHarness({ scenario: "refactor", fastPathMode: "auto" });
    const principal = { role: "coordinator" as const };

    const assessed = (await h.tools.invoke("assess", { specification: h.spec }, principal)) as any;
    expect(assessed.fastPath).toEqual({ eligible: true, blockers: [] });

    await h.tools.invoke(
      "propose_workflow",
      { runId: "run-1", specification: h.spec, definition: h.def, maxIterations: 3 },
      principal
    );
    await h.runtime.flushOutbound();

    const afterPropose = await h.inspect();
    expect(afterPropose.fastPath.status).toBe("active");
    expect(afterPropose.decision?.decidedBy).toBe("coordinator");
    expect(h.conversationInbox.filter(m => m.type === "approval.request")).toHaveLength(0);

    await h.runtime.tick();
    await h.submit({ file: "src/double.cjs", content: "module.exports = function double(x) { return x * 2; };\n" });
    await h.evidence("implement");

    await h.runtime.tick();
    await h.runtime.tick();
    await h.runtime.flushOutbound();

    const finalRun = await h.inspect();
    expect(finalRun.status).toBe("awaiting_approval");
    expect(finalRun.approvalKind).toBe("delivery");

    const sentRoles = h.transport.sentRequests.map(r => r.role);
    expect(sentRoles.filter(r => r === "reviewer")).toHaveLength(0);
    expect(sentRoles.filter(r => r === "qa").length).toBeLessThanOrEqual(1);
    expect(h.conversationInbox.filter(m => m.type === "approval.request")).toHaveLength(1);
  });

  it("Scenario B & C: docs-only fast-path skips workflow review vs mode=off baseline runs review at both levels", async () => {
    const runDocsFlow = async (mode: "auto" | "off") => {
      const h = await createIntegrationHarness({ scenario: "docs", fastPathMode: mode });
      const principal = { role: "coordinator" as const };
      await h.tools.invoke(
        "propose_workflow",
        { runId: "run-1", specification: h.spec, definition: h.def, maxIterations: 3 },
        principal
      );
      await h.runtime.flushOutbound();

      if (mode === "off") {
        const afterPropose = await h.inspect();
        expect(afterPropose.status).toBe("awaiting_approval");
        expect(afterPropose.approvalKind).toBe("design");
        await h.approve();
      }

      await h.runtime.tick();
      await h.submit({ file: "guide.md", content: "updated guide\n" });
      await h.evidence("implement");

      await h.runtime.tick();
      await h.runtime.tick();
      await h.runtime.flushOutbound();

      const finalRun = await h.inspect();
      expect(finalRun.status).toBe("awaiting_approval");
      expect(finalRun.approvalKind).toBe("delivery");

      return {
        reviewer: h.transport.sentRequests.filter(r => r.role === "reviewer").length,
        qa: h.transport.sentRequests.filter(r => r.role === "qa").length
      };
    };

    const fastCounts = await runDocsFlow("auto");
    expect(fastCounts.reviewer).toBe(1);
    expect(fastCounts.qa).toBeLessThanOrEqual(2);

    const offCounts = await runDocsFlow("off");
    expect(offCounts.reviewer).toBe(2);
    expect(offCounts.qa).toBe(2);
  });

  it("Scenario D: host restart mid-verification preserves run.fastPath and task.verificationPlan", async () => {
    const h = await createIntegrationHarness({ scenario: "refactor", fastPathMode: "auto" });
    await h.runtime.proposeWorkflow("run-1", h.spec, h.def, 3);
    await h.runtime.tick();
    await h.submit({ file: "src/double.cjs", content: "module.exports = function double(x) { return x * 2; };\n" });
    await h.evidence("implement");

    await h.runtime.tick();
    const beforeRestart = await h.inspect();
    const savedFastPath = beforeRestart.fastPath;
    const savedPlanId = beforeRestart.tasks[0].verificationPlan.planId;
    expect(savedFastPath.status).toBe("active");
    expect(beforeRestart.tasks[0].verificationPlan.reviewWaiver).toMatchObject({ kind: "deterministic_coverage" });

    await h.restartRuntime();
    const afterRestart = await h.inspect();
    expect(afterRestart.fastPath).toEqual(savedFastPath);
    expect(afterRestart.tasks[0].verificationPlan.planId).toBe(savedPlanId);
  });
});
