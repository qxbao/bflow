import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentResultSchema,
  QualityFindingSchema,
  RoleMessageSchema,
  VerificationResultSchema,
  type PaneBinding,
  type QualityFinding,
  type QualityGate,
  type RoleMessage,
  type Specification
} from "@bflow/contracts";
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
import { ReworkResolutionDossierSchema } from "../../src/agentic/rework-causality.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

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

class ReworkTestPanes implements PanePolicy {
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

interface ReviewerScriptResult {
  readonly summary: string;
  readonly criteriaPassed: boolean;
  readonly findingVerdicts?: readonly {
    readonly findingId: string;
    readonly verdict: "confirmed" | "rejected";
    readonly summary: string;
  }[];
  readonly findings?: readonly QualityFinding[];
}

async function createReworkFixture(options: { maxIterations?: number; legacyVerdicts?: "partial" | "absent" | "durable" } = {}) {
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

describe("Rework root-cause explanation & independent verification through Runtime/host", () => {
  it.each([undefined, "partial", "absent", "durable"] as const)("enforces independent finding coverage through Runtime/host (legacy verdicts: %s)", async legacyVerdicts => {
    const f = await createReworkFixture({legacyVerdicts});
    await f.recordAlternativeEvidence("implement");

    // Initial implementation attempt (cycle 1)
    const initial = await f.activeAssignment("implement");
    await writeFile(join(initial.handle.target.worktreePath, "guide.md"), "draft v1\nline 2\n");
    await writeFile(join(initial.handle.target.worktreePath, "notes.md"), "notes draft v1\nline 2\n");
    git(initial.handle.target.worktreePath, "add", "guide.md", "notes.md");
    git(initial.handle.target.worktreePath, "commit", "-m", "initial implementation");

    // Reviewer emits TWO distinct error findings that share the exact same `code` ("missing_invariant")
    f.setReviewerHandler(() => ({
      summary: "Two distinct files violate missing_invariant",
      criteriaPassed: false,
      findings: [
        QualityFindingSchema.parse({
          severity: "error",
          code: "missing_invariant",
          message: "guide.md omits boundary condition A on line 1",
          location: "guide.md:1",
          details: { filePath: "guide.md", line: 1 }
        }),
        QualityFindingSchema.parse({
          severity: "error",
          code: "missing_invariant",
          message: "notes.md omits rollback invariant B on line 2",
          location: "notes.md:2",
          details: { filePath: "notes.md", line: 2 }
        })
      ]
    }));

    const firstResult = AgentResultSchema.parse({
      requestId: initial.handle.requestId,
      attemptId: initial.handle.attemptId,
      runId: "run-1",
      taskId: "implement",
      executionId: initial.handle.executionId,
      status: "succeeded",
      verification: {
        status: "verified",
        evidence: "Initial submission",
        correlation: initial.handle.correlation
      },
      artifactProposals: [],
      retryable: false,
      startedAt: initial.handle.acceptedAt,
      completedAt: new Date().toISOString()
    });
    await f.runtime.receiveHerdr(
      f.envelope("implementation.submitted", firstResult, {
        causation_id: initial.outbound.message.message_id,
        sender: {
          role: "developer",
          agent_id: initial.handle.target.agentId,
          pane_id: initial.handle.target.paneId
        }
      })
    );

    // Run verification for cycle 1 -> transitions to rework_required and dispatches rework assignment
    await f.runtime.tick();
    await f.runtime.tick();

    const afterCycle1 = await f.inspectRun();
    expect(afterCycle1.tasks[0].cycle.status).toBe("rework_required");

    // Inspect rework assignment via HostDevelopment.status()
    const rework = await f.activeAssignment("implement");
    const devStatus = (await f.development.status(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;

    expect(devStatus.reworkContext).toBeDefined();
    expect(devStatus.reworkContext.reworkGeneration).toBe(1);
    expect(devStatus.reworkContext.findings).toHaveLength(2);
    const [finding1, finding2] = devStatus.reworkContext.findings;
    expect(finding1.code).toBe("missing_invariant");
    expect(finding2.code).toBe("missing_invariant");
    // Must NOT merge findings with the same code: findingIds must be distinct and preserve their locations
    expect(finding1.findingId).not.toBe(finding2.findingId);
    expect(finding1).toMatchObject({ location: "guide.md:1", filePath: "guide.md", line: 1 });
    expect(finding2).toMatchObject({ location: "notes.md:2", filePath: "notes.md", line: 2 });

    // Developer fixes both files in the worktree and commits via HostDevelopment.commit()
    await writeFile(
      join(rework.handle.target.worktreePath, "guide.md"),
      "boundary condition A enforced\nline 2\n"
    );
    await writeFile(
      join(rework.handle.target.worktreePath, "notes.md"),
      "notes draft v1\nrollback invariant B documented\n"
    );
    const committed = (await f.development.commit(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement",
      expectedHead: devStatus.head,
      message: "fix both missing_invariant findings"
    })) as any;
    expect(committed.head).not.toBe(devStatus.reworkContext.failedRevision);

    // Developer runs HostDevelopment.check() (`check_work`) to obtain an ArtifactStore reference bound to HEAD + reworkGeneration
    const checkWork = (await f.development.check(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;
    expect(checkWork.reworkGeneration).toBe(1);
    expect(checkWork.sourceRevision).toBe(committed.head);
    expect(checkWork.evidence.artifactId).toMatch(/^check-work-/);

    const findingResolutions = [
      {
        findingId: finding1.findingId,
        disposition: "addressed",
        rootCause: "guide.md was written from draft template without boundary condition A on line 1",
        sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 1 }],
        repairSummary: "Added explicit boundary condition A specification on line 1 of guide.md",
        discriminatingCheck: {
          kind: "manual_review",
          target: "guide.md:1",
          beforeOutcome: "guide.md line 1 lacked boundary condition A",
          afterOutcome: "guide.md line 1 states boundary condition A enforced"
        },
        evidence: {
          artifactRef: checkWork.evidence,
          sourceRevision: committed.head,
          reworkGeneration: 1,
          summary: "check_work artifact at repaired HEAD confirms guide.md update"
        }
      },
      {
        findingId: finding2.findingId,
        disposition: "addressed",
        rootCause: "notes.md omitted rollback invariant B on line 2 during initial drafting",
        sourceLocations: ["notes.md:2-2"],
        repairSummary: "Documented rollback invariant B on line 2 of notes.md",
        discriminatingCheck: {
          kind: "manual_review",
          target: "notes.md:2",
          beforeOutcome: "notes.md line 2 only had placeholder text",
          afterOutcome: "notes.md line 2 documents rollback invariant B"
        },
        evidence: {
          artifactRef: checkWork.evidence,
          sourceRevision: committed.head,
          reworkGeneration: 1,
          summary: "check_work artifact at repaired HEAD confirms notes.md update"
        }
      }
    ];

    // Prepare submission through host's prepareReworkSubmission entrypoint
    const dossier = await f.runtime.prepareReworkSubmission(
      rework.developerBinding,
      "run-1",
      "implement",
      findingResolutions,
      "succeeded"
    );
    expect(dossier).toBeDefined();
    expect(dossier!.findingResolutions[1]!.sourceLocations).toEqual([
      { path: "notes.md", startLine: 2, endLine: 2 }
    ]);
    // Crucial invariant: Developer claiming "addressed" NEVER closes findings before independent verification
    expect(dossier!.verificationOutcome.status).toBe("pending_independent_verification");
    expect(dossier!.verificationOutcome.closedFindingIds).toEqual([]);
    expect(dossier!.verificationOutcome.openFindingIds).toEqual([
      finding1.findingId,
      finding2.findingId
    ]);

    const reworkResult = AgentResultSchema.parse({
      requestId: rework.handle.requestId,
      attemptId: rework.handle.attemptId,
      runId: "run-1",
      taskId: "implement",
      executionId: rework.handle.executionId,
      status: "succeeded",
      verification: {
        status: "verified",
        evidence: "Rework submission with dossier",
        correlation: rework.handle.correlation
      },
      output: { reworkResolution: dossier } as any,
      artifactProposals: [],
      retryable: false,
      startedAt: rework.handle.acceptedAt,
      completedAt: new Date().toISOString()
    });
    await f.runtime.receiveHerdr(
      f.envelope("implementation.submitted", reworkResult, {
        causation_id: rework.outbound.message.message_id,
        sender: {
          role: "developer",
          agent_id: rework.handle.target.agentId,
          pane_id: rework.handle.target.paneId
        }
      })
    );

    // Before tick() runs independent verification, the stored dossier is still pending_independent_verification
    const beforeVerifyRun = await f.inspectRun();
    expect(beforeVerifyRun.tasks[0].reworkResolutions).toHaveLength(1);
    expect(beforeVerifyRun.tasks[0].reworkResolutions[0].verificationOutcome.status).toBe(
      "pending_independent_verification"
    );

    // Reviewer now inspects the rework dossier via inspect_review and confirms both findings
    f.setReviewerHandler(inspected => {
      expect(inspected.reworkResolution).toBeDefined();
      expect((inspected.reworkResolution as any).findingResolutions).toHaveLength(2);
      return {
        summary: "Independently verified both missing_invariant fixes",
        criteriaPassed: true,
        findingVerdicts: [
          {
            findingId: finding1.findingId,
            verdict: "confirmed",
            summary: "Verified guide.md line 1 fix"
          },
          {
            findingId: finding2.findingId,
            verdict: "confirmed",
            summary: "Verified notes.md line 2 fix"
          }
        ]
      };
    });

    await f.runtime.tick();

    let afterVerifyRun = await f.inspectRun();
    if (legacyVerdicts === "durable") {
      const persisted = JSON.parse(await readFile(join(f.root,"journal","state.json"),"utf8"));
      expect(persisted.pendingVerifications).toHaveLength(1);
      expect(persisted.pendingVerifications[0].outcome.result.status).toBe("passed");
      f.restart();
      await f.runtime.tick();
      afterVerifyRun = await f.inspectRun();
    }
    if (legacyVerdicts) {
      expect(afterVerifyRun.tasks[0].cycle.status).toBe("escalated");
      expect(afterVerifyRun.tasks[0].cycle.history.at(-1).status).toBe("inconclusive");
      expect(afterVerifyRun.tasks[0].reworkResolutions[0].verificationOutcome.status).toBe("escalated_blocked");
      expect(afterVerifyRun.tasks[0].reworkResolutions[0].verificationOutcome.closedFindingIds).toEqual([]);
      f.restart();
      const recovered = await f.inspectRun();
      expect(recovered.tasks[0].reworkResolutions[0].verificationOutcome.findingVerdicts).toEqual([]);
      expect(recovered.tasks[0].cycle.status).toBe("escalated");
      const originalGeneration = recovered.tasks[0].reworkResolutions[0].reworkGeneration;
      f.clearLegacyVerdicts();
      await f.runtime.retryVerification("run-1");
      await f.runtime.tick();
      const retried = await f.inspectRun();
      expect(retried.tasks[0].cycle.status).toBe("passed");
      expect(retried.tasks[0].cycle.currentIteration).toBe(1);
      expect(retried.tasks[0].reworkResolutions[0].reworkGeneration).toBe(originalGeneration);
      expect(retried.tasks[0].reworkResolutions[0].verificationOutcome.status).toBe("verified_closed");
      return;
    }
    expect(afterVerifyRun.tasks[0].cycle.status).toBe("passed");
    const settledDossier = ReworkResolutionDossierSchema.parse(
      afterVerifyRun.tasks[0].reworkResolutions[0]
    );
    expect(settledDossier.verificationOutcome.status).toBe("verified_closed");
    expect(settledDossier.verificationOutcome.closedFindingIds).toEqual([
      finding1.findingId,
      finding2.findingId
    ]);
    expect(settledDossier.verificationOutcome.openFindingIds).toEqual([]);
    expect(settledDossier.verificationOutcome.findingVerdicts).toHaveLength(2);
  }, 120_000);

  it("rejects rework submissions with missing finding explanations or wrong revision/generation evidence without silently closing findings", async () => {
    const f = await createReworkFixture();
    await f.recordAlternativeEvidence("implement");

    // Cycle 1 fails review with 2 findings
    const initial = await f.activeAssignment("implement");
    await writeFile(join(initial.handle.target.worktreePath, "guide.md"), "v1\n");
    git(initial.handle.target.worktreePath, "add", "guide.md");
    git(initial.handle.target.worktreePath, "commit", "-m", "v1");

    f.setReviewerHandler(() => ({
      summary: "Two defects found",
      criteriaPassed: false,
      findings: [
        QualityFindingSchema.parse({
          severity: "error",
          code: "defect_alpha",
          message: "Alpha defect in guide.md",
          location: "guide.md:1"
        }),
        QualityFindingSchema.parse({
          severity: "error",
          code: "defect_beta",
          message: "Beta defect in guide.md",
          location: "guide.md:1"
        })
      ]
    }));

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
          requestId: initial.handle.requestId,
          attemptId: initial.handle.attemptId,
          runId: "run-1",
          taskId: "implement",
          executionId: initial.handle.executionId,
          status: "succeeded",
          verification: {
            status: "verified",
            evidence: "Initial submission",
            correlation: initial.handle.correlation
          },
          artifactProposals: [],
          retryable: false,
          startedAt: initial.handle.acceptedAt,
          completedAt: new Date().toISOString()
        }),
        {
          causation_id: initial.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: initial.handle.target.agentId,
            pane_id: initial.handle.target.paneId
          }
        }
      )
    );

    await f.runtime.tick();
    await f.runtime.tick();

    const rework = await f.activeAssignment("implement");
    const devStatus = (await f.development.status(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;
    const [alphaFinding, betaFinding] = devStatus.reworkContext.findings;
    const staleCheckWork = (await f.development.check(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;

    await writeFile(join(rework.handle.target.worktreePath, "guide.md"), "v2 fixed\n");
    const committed = (await f.development.commit(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement",
      expectedHead: devStatus.head,
      message: "v2 fix"
    })) as any;

    // 1. Omitting findingResolutions entirely must be rejected
    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        undefined,
        "succeeded"
      )
    ).rejects.toThrow(/missing required root-cause findingResolutions/);

    // 2. Explaining only 1 of 2 assigned findings must be rejected (missing betaFinding)
    const makeValidEntry = (finding: any, overrides: Record<string, unknown> = {}) => ({
      findingId: finding.findingId,
      disposition: "addressed",
      rootCause: `Root cause for ${finding.code} in guide.md`,
      sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 1 }],
      repairSummary: `Fixed ${finding.code} in guide.md`,
      discriminatingCheck: {
        kind: "manual_review",
        target: "guide.md:1",
        beforeOutcome: `Failed ${finding.code}`,
        afterOutcome: `Passed ${finding.code}`
      },
      evidence: {
        sourceRevision: committed.head,
        reworkGeneration: 1,
        summary: `Verified at ${committed.head}`
      },
      ...overrides
    });

    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        [makeValidEntry(alphaFinding)],
        "succeeded"
      )
    ).rejects.toThrow(new RegExp(`Missing findingId\\(s\\): ${betaFinding.findingId}`));

    // 3. Evidence with wrong sourceRevision (failedRevision instead of committed HEAD) must be rejected
    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        [
          makeValidEntry(alphaFinding, {
            evidence: {
              sourceRevision: devStatus.reworkContext.failedRevision,
              reworkGeneration: 1,
              summary: "Stale revision evidence"
            }
          }),
          makeValidEntry(betaFinding)
        ],
        "succeeded"
      )
    ).rejects.toThrow(/evidence\.sourceRevision .* must match the current worktree HEAD/);

    // 4. Evidence referencing a stored check_work artifact recorded at the stale (pre-commit) revision must be rejected
    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        [
          makeValidEntry(alphaFinding, {
            evidence: {
              artifactRef: staleCheckWork.evidence,
              sourceRevision: committed.head,
              reworkGeneration: 1,
              summary: "Artifact recorded before commit"
            }
          }),
          makeValidEntry(betaFinding)
        ],
        "succeeded"
      )
    ).rejects.toThrow(/check_work artifact recorded at revision/);

    // 5. Evidence with wrong reworkGeneration must be rejected
    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        [
          makeValidEntry(alphaFinding, {
            evidence: {
              sourceRevision: committed.head,
              reworkGeneration: 99,
              summary: "Wrong generation"
            }
          }),
          makeValidEntry(betaFinding)
        ],
        "succeeded"
      )
    ).rejects.toThrow(/evidence\.reworkGeneration \(99\) must match active reworkGeneration \(1\)/);

    // 6. Direct receiveHerdr of an implementation.submitted message without findingResolutions marks inbox rejected and does not advance task
    await expect(
      f.runtime.receiveHerdr(
        f.envelope(
          "implementation.submitted",
          AgentResultSchema.parse({
            requestId: rework.handle.requestId,
            attemptId: rework.handle.attemptId,
            runId: "run-1",
            taskId: "implement",
            executionId: rework.handle.executionId,
            status: "succeeded",
            verification: {
              status: "verified",
              evidence: "Missing rework explanation",
              correlation: rework.handle.correlation
            },
            artifactProposals: [],
            retryable: false,
            startedAt: rework.handle.acceptedAt,
            completedAt: new Date().toISOString()
          }),
          {
            message_id: "bad-rework-submit-1",
            idempotency_key: "bad-rework-submit-1",
            causation_id: rework.outbound.message.message_id,
            sender: {
              role: "developer",
              agent_id: rework.handle.target.agentId,
              pane_id: rework.handle.target.paneId
            }
          }
        )
      )
    ).rejects.toThrow(/missing required root-cause findingResolutions/);

    const stateAfterReject = await f.inspectState();
    const rejectedInbox = stateAfterReject.inbox.find(
      (item: any) => item.message.message_id === "bad-rework-submit-1"
    );
    expect(rejectedInbox?.status).toBe("rejected");
    const runAfterReject = await f.inspectRun();
    expect(runAfterReject.tasks[0].reworkResolutions ?? []).toHaveLength(0);
  }, 120_000);

  it("supports disputed findings with reproduction evidence and reason, and blocked rework findings via the existing blocker escalation flow", async () => {
    const f = await createReworkFixture();
    await f.recordAlternativeEvidence("implement");

    // Cycle 1 fails with one real defect in guide.md and one non-reproducible finding in notes.md
    const initial = await f.activeAssignment("implement");
    await writeFile(join(initial.handle.target.worktreePath, "guide.md"), "guide v1\n");
    git(initial.handle.target.worktreePath, "add", "guide.md");
    git(initial.handle.target.worktreePath, "commit", "-m", "v1");

    f.setReviewerHandler(() => ({
      summary: "One real defect and one suspected issue",
      criteriaPassed: false,
      findings: [
        QualityFindingSchema.parse({
          severity: "error",
          code: "guide_typo",
          message: "guide.md is missing section header",
          location: "guide.md:1"
        }),
        QualityFindingSchema.parse({
          severity: "error",
          code: "phantom_race",
          message: "Suspected race condition in notes.md line 1",
          location: "notes.md:1"
        })
      ]
    }));

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
          requestId: initial.handle.requestId,
          attemptId: initial.handle.attemptId,
          runId: "run-1",
          taskId: "implement",
          executionId: initial.handle.executionId,
          status: "succeeded",
          verification: {
            status: "verified",
            evidence: "Initial submission",
            correlation: initial.handle.correlation
          },
          artifactProposals: [],
          retryable: false,
          startedAt: initial.handle.acceptedAt,
          completedAt: new Date().toISOString()
        }),
        {
          causation_id: initial.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: initial.handle.target.agentId,
            pane_id: initial.handle.target.paneId
          }
        }
      )
    );

    await f.runtime.tick();
    await f.runtime.tick();

    const rework = await f.activeAssignment("implement");
    const devStatus = (await f.development.status(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;
    const [guideFinding, disputedFinding] = devStatus.reworkContext.findings;

    // Modify ONLY guide.md (notes.md is untouched because disputedFinding could not be reproduced)
    await writeFile(join(rework.handle.target.worktreePath, "guide.md"), "# Section Header\nguide v2\n");
    const committed = (await f.development.commit(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement",
      expectedHead: devStatus.head,
      message: "fix guide.md and dispute phantom_race with reproduction evidence"
    })) as any;
    const checkWork = (await f.development.check(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;

    // Disputed finding WITHOUT disputeReason must be rejected
    await expect(
      f.runtime.prepareReworkSubmission(
        rework.developerBinding,
        "run-1",
        "implement",
        [
          {
            findingId: guideFinding.findingId,
            disposition: "addressed",
            rootCause: "guide.md omitted markdown heading on line 1",
            sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 2 }],
            repairSummary: "Added # Section Header to guide.md",
            discriminatingCheck: {
              kind: "manual_review",
              target: "guide.md:1",
              beforeOutcome: "No header on line 1",
              afterOutcome: "# Section Header present on line 1"
            },
            evidence: {
              artifactRef: checkWork.evidence,
              sourceRevision: committed.head,
              reworkGeneration: 1,
              summary: "Verified guide.md header"
            }
          },
          {
            findingId: disputedFinding.findingId,
            disposition: "disputed",
            rootCause: "notes.md is static markdown and has no concurrent state mutation",
            sourceLocations: [{ path: "notes.md", startLine: 1, endLine: 2 }],
            repairSummary: "No change to notes.md; retained reproduction check output",
            discriminatingCheck: {
              kind: "unit_test",
              target: "unit-check",
              beforeOutcome: "unit-check exits 0 against unmodified notes.md",
              afterOutcome: "unit-check exits 0 with deterministic output"
            },
            evidence: {
              artifactRef: checkWork.evidence,
              sourceRevision: committed.head,
              reworkGeneration: 1,
              summary: "Reproduction run in check_work shows zero failure on notes.md"
            }
          }
        ],
        "succeeded"
      )
    ).rejects.toThrow(/disputeReason is required/);

    // Now supply valid disputeReason and evidence for the disputed finding
    const dossier = await f.runtime.prepareReworkSubmission(
      rework.developerBinding,
      "run-1",
      "implement",
      [
        {
          findingId: guideFinding.findingId,
          disposition: "addressed",
          rootCause: "guide.md omitted markdown heading on line 1",
          sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 2 }],
          repairSummary: "Added # Section Header to guide.md",
          discriminatingCheck: {
            kind: "manual_review",
            target: "guide.md:1",
            beforeOutcome: "No header on line 1",
            afterOutcome: "# Section Header present on line 1"
          },
          evidence: {
            artifactRef: checkWork.evidence,
            sourceRevision: committed.head,
            reworkGeneration: 1,
            summary: "Verified guide.md header"
          }
        },
        {
          findingId: disputedFinding.findingId,
          disposition: "disputed",
          disputeReason:
            "Finding cannot be reproduced: notes.md is a static document and unit-check passes deterministically",
          rootCause: "notes.md is static markdown and has no concurrent state mutation",
          sourceLocations: [{ path: "notes.md", startLine: 1, endLine: 2 }],
          repairSummary: "No change to notes.md; preserved reproduction evidence and rationale",
          discriminatingCheck: {
            kind: "unit_test",
            target: "unit-check",
            beforeOutcome: "unit-check exits 0 against unmodified notes.md",
            afterOutcome: "unit-check exits 0 with deterministic output"
          },
          evidence: {
            artifactRef: checkWork.evidence,
            sourceRevision: committed.head,
            reworkGeneration: 1,
            summary: "Reproduction run in check_work shows zero failure on notes.md"
          }
        }
      ],
      "succeeded"
    );

    expect(dossier).toBeDefined();
    expect(dossier!.findingResolutions[1]!.disposition).toBe("disputed");
    expect(dossier!.findingResolutions[1]!.disputeReason).toContain("cannot be reproduced");

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
          requestId: rework.handle.requestId,
          attemptId: rework.handle.attemptId,
          runId: "run-1",
          taskId: "implement",
          executionId: rework.handle.executionId,
          status: "succeeded",
          verification: {
            status: "verified",
            evidence: "Rework with disputed finding",
            correlation: rework.handle.correlation
          },
          output: { reworkResolution: dossier } as any,
          artifactProposals: [],
          retryable: false,
          startedAt: rework.handle.acceptedAt,
          completedAt: new Date().toISOString()
        }),
        {
          causation_id: rework.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: rework.handle.target.agentId,
            pane_id: rework.handle.target.paneId
          }
        }
      )
    );

    f.setReviewerHandler(inspected => {
      const resolutions = (inspected.reworkResolution as any).findingResolutions;
      expect(resolutions[1].disposition).toBe("disputed");
      expect(resolutions[1].disputeReason).toContain("cannot be reproduced");
      return {
        summary: "Confirmed guide.md fix and accepted disputed notes.md finding based on reproduction evidence",
        criteriaPassed: true,
        findingVerdicts: [
          {
            findingId: guideFinding.findingId,
            verdict: "confirmed",
            summary: "Header added"
          },
          {
            findingId: disputedFinding.findingId,
            verdict: "confirmed",
            summary: "Reproduction evidence confirms notes.md has no race condition"
          }
        ]
      };
    });

    await f.runtime.tick();
    const afterVerify = await f.inspectRun();
    expect(afterVerify.tasks[0].cycle.status).toBe("passed");
    expect(afterVerify.tasks[0].reworkResolutions[0].verificationOutcome.status).toBe(
      "verified_closed"
    );
  }, 120_000);

  it("keeps findings open when Developer claims 'addressed' but independent Reviewer rejects the explanation, and escalates when maxIterations is exhausted", async () => {
    // Configure maxIterations = 2 so cycle 1 failure + cycle 2 Reviewer rejection exhausts the iteration budget
    const f = await createReworkFixture({ maxIterations: 2 });
    await f.recordAlternativeEvidence("implement");

    // Cycle 1: Initial implementation fails review
    const initial = await f.activeAssignment("implement");
    await writeFile(join(initial.handle.target.worktreePath, "guide.md"), "buggy v1\n");
    git(initial.handle.target.worktreePath, "add", "guide.md");
    git(initial.handle.target.worktreePath, "commit", "-m", "v1");

    f.setReviewerHandler(() => ({
      summary: "Calculation invariant broken in guide.md",
      criteriaPassed: false,
      findings: [
        QualityFindingSchema.parse({
          severity: "error",
          code: "broken_invariant",
          message: "guide.md still uses buggy formula",
          location: "guide.md:1"
        })
      ]
    }));

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
          requestId: initial.handle.requestId,
          attemptId: initial.handle.attemptId,
          runId: "run-1",
          taskId: "implement",
          executionId: initial.handle.executionId,
          status: "succeeded",
          verification: {
            status: "verified",
            evidence: "Initial submission",
            correlation: initial.handle.correlation
          },
          artifactProposals: [],
          retryable: false,
          startedAt: initial.handle.acceptedAt,
          completedAt: new Date().toISOString()
        }),
        {
          causation_id: initial.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: initial.handle.target.agentId,
            pane_id: initial.handle.target.paneId
          }
        }
      )
    );

    await f.runtime.tick();
    await f.runtime.tick();

    // Cycle 2 (reworkGeneration = 1): Developer submits all required fields claiming `disposition: "addressed"`,
    // but only makes a superficial edit that does not actually fix the defect.
    const rework = await f.activeAssignment("implement");
    const devStatus = (await f.development.status(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;
    const [assignedFinding] = devStatus.reworkContext.findings;

    await writeFile(
      join(rework.handle.target.worktreePath, "guide.md"),
      "superficial v2 (still buggy)\n"
    );
    const committed = (await f.development.commit(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement",
      expectedHead: devStatus.head,
      message: "claim fixed"
    })) as any;
    const checkWork = (await f.development.check(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;

    const dossier = await f.runtime.prepareReworkSubmission(
      rework.developerBinding,
      "run-1",
      "implement",
      [
        {
          findingId: assignedFinding.findingId,
          disposition: "addressed",
          rootCause: "Claimed root cause: wording on line 1 was outdated",
          sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 1 }],
          repairSummary: "Updated line 1 text to superficial v2",
          discriminatingCheck: {
            kind: "manual_review",
            target: "guide.md:1",
            beforeOutcome: "Had buggy v1",
            afterOutcome: "Has superficial v2"
          },
          evidence: {
            artifactRef: checkWork.evidence,
            sourceRevision: committed.head,
            reworkGeneration: 1,
            summary: "Developer self-reported check"
          }
        }
      ],
      "succeeded"
    );

    expect(dossier!.verificationOutcome.status).toBe("pending_independent_verification");

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
          requestId: rework.handle.requestId,
          attemptId: rework.handle.attemptId,
          runId: "run-1",
          taskId: "implement",
          executionId: rework.handle.executionId,
          status: "succeeded",
          verification: {
            status: "verified",
            evidence: "Superficial rework submission",
            correlation: rework.handle.correlation
          },
          output: { reworkResolution: dossier } as any,
          artifactProposals: [],
          retryable: false,
          startedAt: rework.handle.acceptedAt,
          completedAt: new Date().toISOString()
        }),
        {
          causation_id: rework.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: rework.handle.target.agentId,
            pane_id: rework.handle.target.paneId
          }
        }
      )
    );

    // Independent Reviewer inspects the Developer's reworkResolution and REJECTS it!
    // Notice we set criteriaPassed: true to prove that rejecting a findingVerdict alone fails the review gate!
    f.setReviewerHandler(inspected => {
      expect(inspected.reworkResolution).toBeDefined();
      return {
        summary: "Developer superficial edit did not fix the broken_invariant root cause",
        criteriaPassed: true,
        findingVerdicts: [
          {
            findingId: assignedFinding.findingId,
            verdict: "rejected",
            summary: "guide.md line 1 still contains the buggy formula; root cause was not addressed"
          }
        ]
      };
    });

    await f.runtime.tick();

    const afterExhaustion = await f.inspectRun();
    // Because maxIterations = 2 is now exhausted (2 failed verification cycles), the cycle and run escalate
    expect(afterExhaustion.tasks[0].cycle.status).toBe("escalated");
    expect(afterExhaustion.tasks[0].cycle.history).toHaveLength(2);
    expect(afterExhaustion.status).toBe("escalated");
    expect(afterExhaustion.error).toContain("Verification iteration limit exhausted");

    // The rework dossier must NOT mark the finding closed; it records exhausted_failed with the finding still open
    const finalDossier = ReworkResolutionDossierSchema.parse(
      afterExhaustion.tasks[0].reworkResolutions[0]
    );
    expect(finalDossier.verificationOutcome.status).toBe("exhausted_failed");
    expect(finalDossier.verificationOutcome.closedFindingIds).toEqual([]);
    expect(finalDossier.verificationOutcome.openFindingIds).toEqual([assignedFinding.findingId]);
    expect(finalDossier.verificationOutcome.findingVerdicts[0]).toMatchObject({
      findingId: assignedFinding.findingId,
      verdict: "rejected"
    });
  }, 120_000);

  it("preserves backward compatibility with legacy journal/checkpoint state lacking reworkResolutions without fabricating historical data, and records blocked rework dispositions via task.status", async () => {
    const f = await createReworkFixture({ maxIterations: 3 });
    await f.recordAlternativeEvidence("implement");

    // Cycle 1 fails review
    const initial = await f.activeAssignment("implement");
    await writeFile(join(initial.handle.target.worktreePath, "guide.md"), "v1\n");
    git(initial.handle.target.worktreePath, "add", "guide.md");
    git(initial.handle.target.worktreePath, "commit", "-m", "v1");

    f.setReviewerHandler(() => ({
      summary: "Needs external contract update",
      criteriaPassed: false,
      findings: [
        QualityFindingSchema.parse({
          severity: "error",
          code: "needs_contract_change",
          message: "Requires out-of-scope contract change",
          location: "guide.md:1"
        })
      ]
    }));

    await f.runtime.receiveHerdr(
      f.envelope(
        "implementation.submitted",
        AgentResultSchema.parse({
          requestId: initial.handle.requestId,
          attemptId: initial.handle.attemptId,
          runId: "run-1",
          taskId: "implement",
          executionId: initial.handle.executionId,
          status: "succeeded",
          verification: {
            status: "verified",
            evidence: "Initial submission",
            correlation: initial.handle.correlation
          },
          artifactProposals: [],
          retryable: false,
          startedAt: initial.handle.acceptedAt,
          completedAt: new Date().toISOString()
        }),
        {
          causation_id: initial.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: initial.handle.target.agentId,
            pane_id: initial.handle.target.paneId
          }
        }
      )
    );

    await f.runtime.tick();
    await f.runtime.tick();

    // Simulate a legacy checkpoint/journal state by removing `reworkResolutions` from the persisted journal JSON
    const journalPath = join(f.root, "journal", "state.json");
    const rawJournal = JSON.parse(await readFile(journalPath, "utf8"));
    delete rawJournal.runs[0].tasks[0].reworkResolutions;
    await writeFile(journalPath, JSON.stringify(rawJournal, null, 2));

    // Restart runtime and inspect: must load cleanly without fabricating historical reworkResolutions
    f.restart();
    const recovered = await f.inspectRun();
    expect(recovered.tasks[0].reworkResolutions).toBeUndefined();

    // Developer reports the rework finding as `blocked` via `task.status` with `findingResolutions` (no new commit needed)
    const rework = await f.activeAssignment("implement");
    const devStatus = (await f.development.status(rework.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;
    const [blockedFinding] = devStatus.reworkContext.findings;

    await f.runtime.receiveHerdr(
      f.envelope(
        "task.status",
        {
          status: "blocked",
          summary: "Blocked on out-of-scope contract change",
          blockers: ["Cannot modify packages/contracts from Developer ownedPaths"],
          findingResolutions: [
            {
              findingId: blockedFinding.findingId,
              disposition: "blocked",
              blockerReason: "Finding requires modifying packages/contracts outside ownedPaths",
              rootCause: "guide.md references a field not yet present in shared contracts",
              sourceLocations: [{ path: "guide.md", startLine: 1, endLine: 1 }],
              repairSummary: "No code edit made; escalating out-of-scope requirement to Coordinator",
              discriminatingCheck: {
                kind: "manual_review",
                target: "guide.md:1",
                beforeOutcome: "Blocked on shared contract",
                afterOutcome: "Awaiting Coordinator scope/contract decision"
              },
              evidence: {
                sourceRevision: devStatus.reworkContext.failedRevision,
                reworkGeneration: 1,
                summary: "Inspected guide.md at failedRevision; requires Coordinator escalation"
              }
            }
          ]
        },
        {
          causation_id: rework.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: rework.handle.target.agentId,
            pane_id: rework.handle.target.paneId
          }
        }
      )
    );

    const afterBlocked = await f.inspectRun();
    expect(afterBlocked.error).toContain("Specialist developer blocked");
    expect(afterBlocked.pendingAction?.kind).toBe("coordinator_continuation");
    expect(afterBlocked.tasks[0].reworkResolutions).toHaveLength(1);
    expect(afterBlocked.tasks[0].reworkResolutions[0].verificationOutcome.status).toBe(
      "escalated_blocked"
    );
    expect(afterBlocked.tasks[0].reworkResolutions[0].findingResolutions[0].disposition).toBe(
      "blocked"
    );
  }, 120_000);
});
