import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { expect } from "vitest";
import { RoleMessageSchema, VerificationResultSchema, type PaneBinding, type QualityFinding, type QualityGate, type RoleMessage, type Specification } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { FakeAgentTransport } from "./fake-transport.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

export const cleanups: (() => Promise<void>)[] = [];
export const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

export const git = (cwd: string, ...args: string[]) =>
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

export class ReworkTestPanes implements PanePolicy {
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
      value:
        this.bindings.find(p => [p.role, p.bindingId, p.paneId, p.agentId].includes(selector)) ?? null
    };
  }

  async inspectRoleHealth(selector: string) {
    const p = unwrap(await this.getRoleBinding(selector));
    if (!p) throw new Error("No pane");
    return {
      ok: true as const,
      value: { readyForPrompt: true, occupantMatches: true, paneId: p.paneId, agentId: p.agentId }
    };
  }

  async allocateDeveloper(request: { taskId: string; worktreePath: string; agentName: string }) {
    const existing = this.bindings.find(p => p.agentId === request.agentName);
    if (existing) {
      const updated = { ...existing, cwd: request.worktreePath, worktreePath: request.worktreePath };
      this.bindings = this.bindings.map(p => (p.agentId === request.agentName ? updated : p));
      return { ok: true as const, value: updated };
    }
    const created: PaneBinding = {
      ...this.bindings[0]!,
      bindingId: request.agentName,
      role: "developer" as const,
      agentId: request.agentName,
      paneId: `pane-${request.agentName}`,
      cwd: request.worktreePath,
      worktreePath: request.worktreePath,
      readOnlyWorkspace: false,
      session: { source: "test", kind: "id", value: `session-${request.agentName}` }
    };
    this.bindings.push(created);
    return { ok: true as const, value: created };
  }

  async releaseDeveloper() {
    return { ok: true as const, value: undefined };
  }
}

export interface ReviewerScriptResult {
  readonly summary: string;
  readonly criteriaPassed: boolean;
  readonly findingVerdicts?: readonly {
    readonly findingId: string;
    readonly verdict: "confirmed" | "rejected";
    readonly summary: string;
  }[];
  readonly findings?: readonly QualityFinding[];
}

export async function createReworkFixture(options: { maxIterations?: number; legacyVerdicts?: "partial" | "absent" | "durable"; retryAttempts?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-rework-causality-")));
  const repository = join(root, "repo");
  await mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test");
  git(repository, "config", "user.email", "test@example.test");
  const testName = "ac-1: The requested outcome is independently verifiable";
  await mkdir(join(repository, "test"), { recursive: true });
  await writeFile(
    join(repository, "test/rework.test.cjs"),
    `const { test } = require("node:test"); const assert = require("node:assert/strict"); test(${JSON.stringify(testName)}, () => assert.equal(1, 1));\n`
  );
  await writeFile(join(repository, "guide.md"), "line 1\nline 2\nline 3\n");
  await writeFile(join(repository, "notes.md"), "notes line 1\nnotes line 2\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "baseline");

  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "rework-store" }));
  cleanups.push(async () => {
    store.close();
    artifacts.close();
    await rm(root, { recursive: true, force: true });
  });

  const transport = new FakeAgentTransport();
  const panes = new ReworkTestPanes();
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const bindingReceiptKeys = { "native-test-host": publicKey };
  const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys });
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });

  let runtime!: AgenticWorkflowRuntime;
  const receipts = new HostReceiptJournal(join(root, "host-receipts"), repository, "session-1");
  const checkCommand = parseBehavioralCommands([
    {
      id: "test-regression",
      command: "test-regression",
      executable: process.execPath,
      args: ["--test", "--test-reporter=tap", "test/rework.test.cjs"],
      method: "integration_test",
      levels: ["integration"],
      testNames: [testName],
      testPaths: ["test/rework.test.cjs"],
      timeoutMs: 5_000
    }
  ])[0]!;
  const verification = new HostVerification(() => runtime, () => artifacts, receipts, [checkCommand]);
  const development = new HostDevelopment(() => runtime, [checkCommand]);

  const checks = [
    {
      id: "review",
      name: "review",
      evaluator: "review",
      required: true,
      timeout: { executionTimeoutMs: 10_000, onTimeout: "block" },
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
      timeout: { executionTimeoutMs: 5_000, onTimeout: "block" },
      configuration: {
        kind: "deterministic",
        method: "integration_test",
        command: "test-regression",
        criterionIds: [],
        testNames: [],
        role: "tester",
        levels: ["integration"]
      }
    }
  ] as any;

  let reviewerHandler: ((inspected: Record<string, unknown>, message: RoleMessage) => Promise<ReviewerScriptResult> | ReviewerScriptResult) | undefined;
  const reviewInspections: Record<string, unknown>[] = [];

  const gates: QualityGate[] = [
    {
      id: "review",
      evaluate: (...args) => runtime.herdrQualityGate("review").evaluate(...args)
    },
    {
      id: "regression",
      evaluate: async context => {
        const config = context.definition.configuration as any;
        const input = context.input as any;
        return {
          ok: true,
          value: {
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
                checkId: "regression",
                runId: context.runId,
                taskId: context.taskId,
                attemptId: context.attemptId,
                sourceRevision: input.sourceRevision,
                specFingerprint: input.specFingerprint,
                scope: input.scope,
                independentExecution: true,
                isolated: true,
                executorId: "independent-test-host",
                role: config.role,
                method: config.method,
                command: config.command,
                exitCode: 0,
                testNames: config.testNames,
                criteria: [],
                summary: "Regression suite passed"
              }
            }
          }
        };
      }
    }
  ];

  // Automatically service `verification.requested` messages sent to `reviewer` through the real HostVerification tools.
  const originalSend = transport.send.bind(transport);
  transport.send = async (request, sendOptions) => {
    const receipt = await originalSend(request, sendOptions);
    const parsed = JSON.parse(request.instruction) as RoleMessage;
    if (parsed.type === "verification.requested" && parsed.recipient.role === "reviewer") {
      queueMicrotask(() => {
        void (async () => {
          const reviewerBinding = panes.bindings.find(b => b.role === "reviewer")!;
          const inspected = (await verification.inspectReview(reviewerBinding, {
            messageId: parsed.message_id
          })) as Record<string, unknown>;
          reviewInspections.push(inspected);
          const scripted: ReviewerScriptResult = reviewerHandler
            ? await reviewerHandler(inspected, parsed)
            : {
                summary: "Independent review passed",
                criteriaPassed: true,
                ...(inspected.reworkResolution
                  ? {
                      findingVerdicts: (
                        (inspected.reworkResolution as any).findingResolutions as { findingId: string }[]
                      ).map(item => ({
                        findingId: item.findingId,
                        verdict: "confirmed" as const,
                        summary: `Independently confirmed ${item.findingId}`
                      }))
                    }
                  : {})
              };
          const completed = await verification.completeReview(reviewerBinding, {
            reviewId: inspected.reviewId,
            messageId: parsed.message_id,
            summary: scripted.summary,
            criteria: [
              {
                criterionId: "ac-1",
                passed: scripted.criteriaPassed,
                summary: scripted.summary
              }
            ],
            ...(scripted.findingVerdicts ? { findingVerdicts: scripted.findingVerdicts } : {}),
            ...(scripted.findings ? { findings: scripted.findings } : {})
          });
          if (inspected.reworkResolution && options.legacyVerdicts && options.legacyVerdicts !== "durable") {
            // A trusted old host receipt: authentication alone does not prove per-finding coverage.
            completed.result = {...completed.result, evaluationId: `legacy-${completed.result.evaluationId}`,
              metadata: {...completed.result.metadata, findingVerdicts: options.legacyVerdicts === "partial"
                ? scripted.findingVerdicts?.slice(0,1) : undefined}} as any;
            if (options.legacyVerdicts === "absent") delete completed.result.metadata!.findingVerdicts;
            delete completed.result.metadata!.reworkVerification;
            await receipts.recordGate(completed.result);
          }
          await runtime.receiveHerdr(
            envelope("review.verdict", completed.result, {
              sender: {
                role: "reviewer",
                agent_id: reviewerBinding.agentId,
                pane_id: reviewerBinding.paneId
              },
              causation_id: parsed.message_id,
              artifact_references: [completed.artifact]
            })
          );
        })();
      });
    }
    return receipt;
  };

  const policies = await loadAgenticPolicies({
    repositoryPath: repository,
    artifactStore: artifacts,
    gates,
    loadSpecification: id => runtime.loadSpecification(id),
    authorizeApprover: decision => ["coordinator", "human-1"].includes(decision.decidedBy)
  });

  const verify = policies.verification.verify.bind(policies.verification);
  let durableFailureInjected = false;
  policies.verification.verify = async (...args) => {
    const outcome = await verify(...args);
    if (options.legacyVerdicts === "durable" && args[1].history.length && outcome.result.status === "passed") {
      const legacy = structuredClone(outcome);
      for (const gate of legacy.result.qualityGateResults) {
        delete gate.metadata?.findingVerdicts;
        delete gate.metadata?.reworkVerification;
      }
      legacy.cycle.history[legacy.cycle.history.length - 1] = legacy.result;
      if (!durableFailureInjected) {
        durableFailureInjected = true;
        const resolve = artifacts.resolve.bind(artifacts);
        artifacts.resolve = async (...resolveArgs) => {
          artifacts.resolve = resolve;
          throw new Error("Injected crash boundary after pending outcome persistence");
        };
      }
      return legacy;
    }
    return outcome;
  };

  const conversationInbox: RoleMessage[] = [];
  const ports: AgenticRuntimePorts = {
    engine,
    runStore: store,
    artifactStore: artifacts,
    registry,
    transport,
    panes,
    policies,
    deliverToConversation: async message => {
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
      qa: ["verification", "repository.read"],
      tester: ["testing", "repository.read"]
    },
    taskChecks: checks,
    workflowChecks: checks,
    authenticateMessage: async () => true,
    authenticateResult: async () => true,
    authenticateEvidence: async () => true,
    authenticateGateResult: async result => verification.authenticateGate(result),
    authorizeHuman: async decision => decision.decidedBy === "human-1",
    projectApprovalRequired: () => false
  };

  const runtimeOptions = { journalDirectory: join(root, "journal"), repositoryPath: repository };
  runtime = new AgenticWorkflowRuntime(ports, runtimeOptions);

  const spec: Specification = draft("documentation");
  const time = new Date().toISOString();
  spec.createdAt = time;
  spec.updatedAt = time;
  spec.affectedPaths = ["guide.md", "notes.md"];
  spec.traceabilityTaskIds = ["implement"];
  (spec.metadata!.sdd as any).traceability[0].taskIds = ["implement"];
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
      commands: [{ method: "integration_test", command: "test-regression", level: "integration" }]
    },
    testability: { level: "automated", rationale: "Independent repeatable checks are available" },
    riskClassification: "low",
    conventions: { tdd: "contextual", requiredMethods: ["integration_test"], suggestedLevels: ["integration"] }
  };
  delete spec.testStrategy;
  delete spec.tddDecision;

  const def = workflow(["implement"]);
  def.tasks[0]!.retry.maxAttempts = options.retryAttempts ?? 1;
  def.tasks[0] = {
    ...def.tasks[0]!,
    metadata: { ownedPaths: ["guide.md", "notes.md"] }
  } as any;

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

  await runtime.receiveHerdr(envelope("delegation.request", delegation, { message_id: "intake-1", idempotency_key: "intake-1" }));
  await runtime.proposeWorkflow("run-1", spec, def, options.maxIterations ?? 3);
  await runtime.tick();

  const inspectRun = async () => (await runtime.inspect("run-1")) as any;
  const inspectState = async () => (await runtime.inspect()) as any;

  async function recordAlternativeEvidence(taskId = "implement") {
    const run = await inspectRun();
    const task = run.tasks.find((t: any) => t.taskId === taskId);
    const strategy = task.spec.strategy;
    const startedAt = new Date().toISOString();
    const bytes = Buffer.from(`${taskId}-verification-${randomUUID()}`);
    const ref = unwrap(
      await artifacts.put({
        options: {
          artifactId: randomUUID(),
          runId: "run-1",
          taskId,
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
    const method = spec.acceptanceCriteria[0]!.verificationMethod;
    const result = VerificationResultSchema.parse({
      schemaVersion: 2,
      verificationId: randomUUID(),
      runId: "run-1",
      taskId,
      cycleNumber: 1,
      attemptId: randomUUID(),
      status: "passed",
      independentExecution: true,
      evaluatedCriteria: [
        {
          criterionId: "ac-1",
          passed: true,
          evidenceArtifactId: ref.artifactId,
          summary: "Observed target behavior"
        }
      ],
      qualityGateResults: [],
      evidenceArtifacts: [ref],
      findings: [],
      verifiedBy: "tester",
      startedAt,
      completedAt: new Date().toISOString(),
      metadata: {
        conditionalTdd: {
          phase: "verification",
          decisionId: strategy.tddDecision.decisionId,
          specId: strategy.specId,
          sourceRevision: "implementation-source",
          testRevision: "unchanged-tests",
          testNames: strategy.criterionMappings[0].testNames,
          observations: [
            {
              method,
              criterionId: "ac-1",
              evidenceArtifactId: ref.artifactId,
              summary: "Independent observation"
            },
            {
              method: "integration_test",
              criterionId: "ac-1",
              evidenceArtifactId: ref.artifactId,
              command: "test-regression",
              exitCode: 0,
              summary: "Independent regression observation"
            }
          ]
        }
      }
    });
    await runtime.receiveHerdr(envelope("verification.result", result, { sender: { role: "tester" } }));
  }

  async function activeAssignment(taskId = "implement") {
    const state = await inspectState();
    const outbound = [...state.outbound]
      .reverse()
      .find((out: any) => out.taskId === taskId && out.message.type === "task.assignment");
    expect(outbound).toBeDefined();
    expect(outbound.handle).toBeDefined();
    const developerBinding = panes.bindings.find(
      b => b.role === "developer" && b.paneId === outbound.handle.target.paneId
    )!;
    expect(developerBinding).toBeDefined();
    return { outbound, handle: outbound.handle, developerBinding };
  }

  return {
    root,
    repository,
    get runtime() {
      return runtime;
    },
    restart() {
      runtime = new AgenticWorkflowRuntime(
        { ...ports, engine: new DeterministicWorkflowEngine({ bindingReceiptKeys }) },
        runtimeOptions
      );
      return runtime;
    },
    ports,
    artifacts,
    clearLegacyVerdicts() { delete options.legacyVerdicts; },
    development,
    verification,
    panes,
    envelope,
    inspectRun,
    inspectState,
    recordAlternativeEvidence,
    activeAssignment,
    reviewInspections,
    setReviewerHandler(
      fn:
        | ((inspected: Record<string, unknown>, message: RoleMessage) => Promise<ReviewerScriptResult> | ReviewerScriptResult)
        | undefined
    ) {
      reviewerHandler = fn;
    }
  };
}
