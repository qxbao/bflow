import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentResultSchema,
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
import {
  FAST_PATH_DESIGN_AUTO_APPROVED_NOTICE,
  FAST_PATH_TASK_WAIVER_NOTICE,
  FAST_PATH_WORKFLOW_WAIVER_NOTICE
} from "../../src/agentic/conversation-notice-render.js";
import { DEFAULT_HOST_CHECKS, HostVerification } from "../../src/agentic/host-verification.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
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

async function setupFixture(options: {
  fastPathMode?: "auto" | "off";
  humanApproval?: boolean;
  automatedRefactor?: boolean;
  failDeterministicOnce?: boolean;
  customWaiverPolicy?: boolean;
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-fast-path-run-")));
  const repository = join(root, "repo");
  await mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test");
  git(repository, "config", "user.email", "test@example.test");
  await writeFile(join(repository, "guide.md"), "initial\n");
  await mkdir(join(repository, "src"), { recursive: true });
  await writeFile(join(repository, "src/helper.ts"), "export const v = 1;\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "baseline");

  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "fast-path" }));
  cleanups.push(async () => {
    store.close();
    artifacts.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const transport = new FakeAgentTransport();
  const panes = new Panes();
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const bindingReceiptKeys = { "native-test-host": publicKey };
  const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys });
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });

  const calls: QualityGateContext[] = [];
  let failDeterministicRemaining = options.failDeterministicOnce ? 1 : 0;

  const deterministicCheck = {
    id: "unit-runner",
    name: "Unit test runner",
    evaluator: "unit-runner",
    required: true,
    timeout: { executionTimeoutMs: 30_000, onTimeout: "block" as const },
    metadata: { bindAcceptedCriteria: true, bindMethodTestNames: true },
    configuration: {
      kind: "deterministic",
      method: "unit_test",
      command: "pnpm test:unit",
      criterionIds: ["ac-1"],
      testNames: ["ac-1: The requested outcome is independently verifiable"],
      role: "tester",
      levels: ["unit"]
    }
  };

  const checks = [
    // Explicit injected legacy policy exercises the underlying waiver engine; the default host policy always keeps integrity.
    ...DEFAULT_HOST_CHECKS.filter(check => !options.customWaiverPolicy || check.id !== "host-test-integrity"),
    ...(options.automatedRefactor ? [deterministicCheck] : [])
  ] as any[];

  let runtime: AgenticWorkflowRuntime;
  const receipts = new HostReceiptJournal(join(root, "host-receipts"), repository, "session-1");
  const verification = new HostVerification(() => runtime, () => artifacts, receipts, []);

  const gates: QualityGate[] = [
    verification.testIntegrityGate(),
    ...DEFAULT_HOST_CHECKS.filter(c => (c.configuration as any).kind === "review").map(check => ({
      id: check.id,
      evaluate: async (context: QualityGateContext) => {
        calls.push(context);
        const config = context.definition.configuration as any;
        const input = context.input as any;
        return {
          ok: true as const,
          value: {
            gateId: context.definition.id,
            runId: context.runId,
            taskId: context.taskId!,
            evaluationId: randomUUID(),
            status: "passed" as const,
            findings: [],
            producedArtifacts: [],
            evaluatedAt: new Date().toISOString(),
            metadata: {
              verification: {
                schemaVersion: 2,
                checkId: check.id,
                runId: context.runId,
                taskId: context.taskId,
                attemptId: context.attemptId,
                sourceRevision: input.sourceRevision,
                specFingerprint: input.specFingerprint,
                scope: input.scope,
                independentExecution: true,
                isolated: true,
                executorId: `independent-${config.role}`,
                role: config.role,
                method: config.method,
                testNames: config.testNames,
                criteria: config.criterionIds.map((criterionId: string) => ({
                  criterionId,
                  passed: true,
                  summary: "Independent review passed"
                })),
                summary: "Independent review passed"
              }
            }
          }
        };
      }
    })),
    {
      id: "host-git-integrity",
      evaluate: async (context: QualityGateContext) => {
        calls.push(context);
        const config = context.definition.configuration as any;
        const input = context.input as any;
        return {
          ok: true as const,
          value: {
            gateId: context.definition.id,
            runId: context.runId,
            taskId: context.taskId!,
            evaluationId: randomUUID(),
            status: "passed" as const,
            findings: [],
            producedArtifacts: [],
            evaluatedAt: new Date().toISOString(),
            metadata: {
              verification: {
                schemaVersion: 2,
                checkId: "host-git-integrity",
                runId: context.runId,
                taskId: context.taskId,
                attemptId: context.attemptId,
                sourceRevision: input.sourceRevision,
                specFingerprint: input.specFingerprint,
                scope: input.scope,
                independentExecution: true,
                isolated: true,
                executorId: "bflow-host-git-check",
                role: "quality_gate",
                method: config.method,
                command: "git diff --check",
                exitCode: 0,
                testNames: [],
                criteria: [],
                summary: "Exact committed diff passed git diff --check"
              }
            }
          }
        };
      }
    },
    {
      id: "unit-runner",
      evaluate: async (context: QualityGateContext) => {
        calls.push(context);
        const config = context.definition.configuration as any;
        const input = context.input as any;
        const passed = failDeterministicRemaining <= 0;
        if (failDeterministicRemaining > 0) failDeterministicRemaining -= 1;
        return {
          ok: true as const,
          value: {
            gateId: context.definition.id,
            runId: context.runId,
            taskId: context.taskId!,
            evaluationId: randomUUID(),
            status: passed ? ("passed" as const) : ("failed" as const),
            findings: passed
              ? []
              : [
                  {
                    code: "unit_failed",
                    severity: "error" as const,
                    message: "Unit test failed",
                    details: { taskId: context.taskId, responsibleRole: "developer", requiresNewTaskIfOutsideScope: true }
                  }
                ],
            producedArtifacts: [],
            evaluatedAt: new Date().toISOString(),
            metadata: {
              verification: {
                schemaVersion: 2,
                checkId: "unit-runner",
                runId: context.runId,
                taskId: context.taskId,
                attemptId: context.attemptId,
                sourceRevision: input.sourceRevision,
                specFingerprint: input.specFingerprint,
                scope: input.scope,
                independentExecution: true,
                isolated: true,
                executorId: "independent-test-host",
                role: "tester",
                method: "unit_test",
                command: "pnpm test:unit",
                exitCode: passed ? 0 : 1,
                testNames: config.testNames,
                criteria: config.criterionIds.map((criterionId: string) => ({
                  criterionId,
                  passed,
                  summary: passed ? "Unit test passed" : "Unit test failed"
                })),
                summary: passed ? "Unit test passed" : "Unit test failed"
              }
            }
          }
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
    projectApprovalRequired: () => options.humanApproval === true
  };

  const runtimeOptions = { journalDirectory: join(root, "journal"), repositoryPath: repository };
  runtime = new AgenticWorkflowRuntime(ports, runtimeOptions);

  const time = new Date().toISOString();
  const spec: Specification = draft("documentation");
  spec.createdAt = time;
  spec.updatedAt = time;
  if (options.automatedRefactor) {
    spec.affectedPaths = ["src/helper.ts"];
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
          { method: "unit_test", command: "pnpm test:unit", level: "unit" },
          { method: "integration_test", command: "git diff --check", level: "integration" }
        ]
      },
      testability: { level: "automated", rationale: "Automated unit and diff checks cover refactoring" },
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

  async function submit(fileChange?: { file: string; content: string }) {
    const state = (await runtime.inspect()) as any;
    const outbound = [...state.outbound].reverse().find((out: any) => out.taskId === "implement" && out.message.type === "task.assignment");
    const handle = outbound.handle;
    const path = handle.target.worktreePath;
    const file = fileChange?.file ?? spec.affectedPaths[0]!;
    await writeFile(join(path, file), fileChange?.content ?? `updated ${randomUUID()}\n`);
    git(path, "add", file);
    git(path, "commit", "-m", "implement");
    const reworkContext = outbound.message.payload?.reworkContext as
      | { reworkGeneration: number; findings: { findingId: string; code: string; message: string }[] }
      | undefined;
    const headRevision = git(path, "rev-parse", "HEAD");
    const findingResolutions = reworkContext?.findings.map(finding => ({
      findingId: finding.findingId,
      disposition: "addressed",
      rootCause: `Root cause for ${finding.code}: ${finding.message}`,
      sourceLocations: [{ path: file, startLine: 1, endLine: 1 }],
      repairSummary: `Updated ${file} to resolve ${finding.code} (${finding.findingId})`,
      discriminatingCheck: {
        kind: "quality_gate",
        target: finding.code,
        beforeOutcome: `Failed with ${finding.code}: ${finding.message}`,
        afterOutcome: `Resolved ${finding.code} in ${file} at ${headRevision}`
      },
      evidence: {
        sourceRevision: headRevision,
        reworkGeneration: reworkContext.reworkGeneration,
        summary: `Verified ${file} at revision ${headRevision} for generation ${reworkContext.reworkGeneration}`
      }
    }));
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
      ...(findingResolutions ? { output: { findingResolutions } } : {}),
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

  return {
    root,
    repository,
    ports,
    policies,
    get runtime() {
      return runtime;
    },
    set runtime(next: AgenticWorkflowRuntime) {
      runtime = next;
    },
    spec,
    def,
    delegation,
    envelope,
    calls,
    conversationInbox,
    transport,
    inspect,
    evidence,
    submit
  };
}

describe("Task 3, 5, 6: Runtime fast-path decision, autonomous design approval, and task/workflow review waivers", { timeout: 120_000 }, () => {
  it("proposeWorkflow records fastPath active for eligible single-task trivial run", async () => {
    const f = await setupFixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const run = await f.inspect();
    expect(run.fastPath).toMatchObject({
      status: "active",
      blockers: [],
      reasons: []
    });
    expect(run.fastPath.classificationDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("proposeWorkflow records fastPath inactive with blockers for standard/complex change and ignores agent-supplied fastPath metadata", async () => {
    const f = await setupFixture();
    const complexSpec = draft("api");
    complexSpec.createdAt = f.spec.createdAt;
    complexSpec.updatedAt = f.spec.updatedAt;
    complexSpec.metadata = {
      ...complexSpec.metadata,
      fastPath: { status: "active", eligible: true },
      conditionalTdd: {
        policyVersion: 1,
        taskId: "implement",
        taskType: "api_contract",
        changeImpact: {
          surfaces: ["api_contract"],
          behaviorChanged: true,
          deterministic: true,
          regressionReproducible: true,
          securitySensitive: false,
          dataMigration: false,
          scope: "cross_module"
        },
        infrastructure: {
          readiness: "ready",
          commands: [
            { method: "unit_test", command: "pnpm test:unit", level: "unit" },
            { method: "integration_test", command: "git diff --check", level: "integration" }
          ]
        },
        testability: { level: "automated", rationale: "Automated tests" },
        riskClassification: "high",
        conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] }
      }
    };
    const strategy = f.policies.strategy.resolve(complexSpec);
    complexSpec.testStrategy = strategy;
    complexSpec.tddDecision = strategy.tddDecision;
    const complexDef = workflow(["implement"]);
    complexDef.metadata = { fastPath: { status: "active", eligible: true } };
    complexDef.tasks[0]!.metadata = { ownedPaths: [...complexSpec.affectedPaths], forbiddenPaths: ["secrets"] };

    const statePath = join(f.root, "journal/state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.runs[0].delegation.acceptanceCriteria = complexSpec.acceptanceCriteria;
    await writeFile(statePath, JSON.stringify(state));
    const reopened = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });

    await reopened.proposeWorkflow("run-1", complexSpec, complexDef);
    const run = (await reopened.inspect("run-1")) as any;
    expect(run.fastPath.status).toBe("inactive");
    expect(run.fastPath.blockers).toEqual(expect.arrayContaining(["not_trivial", "full_sdd", "tdd_required"]));
  });

  it("auto-accepts design for active fast-path even when approvalRequired is true and keeps retry autonomous", async () => {
    const f = await setupFixture({ humanApproval: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.flushOutbound();
    const run = await f.inspect();
    expect(run.fastPath.status).toBe("active");
    expect(run.status).not.toBe("awaiting_approval");
    expect(run.decision?.decidedBy).toBe("coordinator");
    expect(f.conversationInbox.filter(m => m.type === "approval.request")).toHaveLength(0);
    expect(
      f.conversationInbox.some(
        m => m.type === "conversation.progress" && (m.payload as any)?.headline === FAST_PATH_DESIGN_AUTO_APPROVED_NOTICE
      )
    ).toBe(true);

    const retryResult = (await f.runtime.proposeWorkflow("run-1", f.spec, f.def)) as any;
    expect(retryResult.fastPath).toEqual(run.fastPath);
    expect(retryResult.decision?.decidedBy).toBe("coordinator");
  });

  it("still requires human design approval when fastPath is inactive and approvalRequired is true", async () => {
    const f = await setupFixture({ fastPathMode: "off", humanApproval: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.flushOutbound();
    const run = await f.inspect();
    expect(run.fastPath.status).toBe("inactive");
    expect(run.fastPath.blockers).toContain("disabled");
    expect(run.status).toBe("awaiting_approval");
    expect(run.approvalKind).toBe("design");
    expect(f.conversationInbox.filter(m => m.type === "approval.request")).toHaveLength(1);
  });

  it("requirement revision recomputes fastPath", async () => {
    const f = await setupFixture({ fastPathMode: "off", humanApproval: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    expect((await f.inspect()).fastPath.status).toBe("inactive");

    f.ports.fastPathMode = "auto";
    const revTime = new Date().toISOString();
    const revDelegation = {
      ...f.delegation,
      delegationId: "delegation-2",
      messageId: "intake-2",
      objective: "Revised summary",
      requestedAt: revTime,
      idempotencyKey: "intake-2",
      metadata: { isRequirementChange: true, revision: 2 }
    };
    await f.runtime.receiveHerdr(
      f.envelope("delegation.request", revDelegation, { message_id: "intake-2", idempotency_key: "intake-2" })
    );

    const revisedSpec = { ...f.spec, summary: "Revised summary", updatedAt: revTime };
    await f.runtime.proposeWorkflow("run-1", revisedSpec, f.def);
    const revisedRun = await f.inspect();
    expect(revisedRun.fastPath.status).toBe("active");
    expect(revisedRun.fastPath.reasons).toContain("recomputed for follow-up or requirement revision");
  });

  it("default host policy never waives independent review while test integrity is required", async () => {
    const f=await setupFixture({automatedRefactor:true,humanApproval:true});
    await f.runtime.proposeWorkflow("run-1",f.spec,f.def);await f.runtime.tick();
    await f.submit({file:"src/helper.ts",content:"export const v = 2;\n"});await f.evidence("implement");
    await f.runtime.tick();await f.runtime.tick();
    const run=await f.inspect();
    expect(run.fastPath).toMatchObject({status:"downgraded",downgrade:{reason:"test_integrity_requires_independent_review",scope:"task"}});
    expect(run.tasks[0].verificationPlan.reviewWaiver).toBeUndefined();expect(run.workflowVerificationPlan.reviewWaiver).toBeUndefined();
    for(const plan of [run.tasks[0].verificationPlan,run.workflowVerificationPlan])expect(plan.checks.map((check:any)=>check.id)).toEqual(expect.arrayContaining(["host-test-integrity","host-reviewer","host-qa"]));
    expect(run.tasks[0].cycle.history[0].qualityGateResults.find((gate:any)=>gate.gateId==="host-test-integrity").status).toBe("passed");
    expect(f.calls.filter(c=>c.definition.id==="host-reviewer")).toHaveLength(2);
  });

  it("an explicit custom policy without integrity preserves deterministic task waiver and its rework plan", async () => {
    const f = await setupFixture({ automatedRefactor: true, humanApproval: true, failDeterministicOnce: true, customWaiverPolicy: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    await f.submit({ file: "src/helper.ts", content: "export const v = 2;\n" });
    await f.evidence("implement");
    await f.runtime.tick();

    const afterIter1 = await f.inspect();
    const firstPlan = afterIter1.tasks[0].verificationPlan;
    expect(firstPlan.reviewWaiver).toMatchObject({ kind: "deterministic_coverage" });
    expect(firstPlan.checks.map((c: any) => c.id)).toEqual(["host-git-integrity", "unit-runner"]);
    expect(afterIter1.tasks[0].cycle.status).toBe("rework_required");
    expect(
      f.conversationInbox.some(
        m => m.type === "conversation.progress" && (m.payload as any)?.headline === FAST_PATH_TASK_WAIVER_NOTICE
      )
    ).toBe(true);

    // Dispatch rework and verify that the same waived plan is reused
    await f.runtime.tick();
    await f.submit({ file: "src/helper.ts", content: "export const v = 3;\n" });
    await f.runtime.tick();
    await f.runtime.tick();
    await f.runtime.flushOutbound();

    const afterIter2 = await f.inspect();
    expect(afterIter2.tasks[0].verificationPlan.planId).toBe(firstPlan.planId);
    expect(afterIter2.tasks[0].cycle.status).toBe("passed");
    expect(afterIter2.status).toBe("awaiting_approval");
    expect(afterIter2.approvalKind).toBe("delivery");
    expect(afterIter2.workflowVerificationPlan.reviewWaiver).toMatchObject({
      kind: "identical_integrated_tree"
    });
    expect(
      f.conversationInbox.some(
        m => m.type === "conversation.progress" && (m.payload as any)?.headline === FAST_PATH_WORKFLOW_WAIVER_NOTICE
      )
    ).toBe(true);
    expect(f.conversationInbox.filter(m => m.type === "approval.request")).toHaveLength(1);
  });

  it("an explicit custom policy without integrity retains docs task review and identical-tree workflow waiver", async () => {
    const f = await setupFixture({ humanApproval: true, customWaiverPolicy: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    await f.submit({ file: "guide.md", content: "updated docs\n" });
    await f.evidence("implement");
    await f.runtime.tick();
    await f.runtime.tick();

    const afterRun = await f.inspect();
    expect(afterRun.fastPath.status).toBe("active");
    expect(afterRun.tasks[0].verificationPlan.reviewWaiver).toBeUndefined();
    expect(afterRun.tasks[0].verificationPlan.checks.map((c: any) => c.id)).toContain("host-reviewer");
    expect(afterRun.tasks[0].verificationPlan.checks.map((c: any) => c.id)).toContain("host-qa");
    expect(afterRun.workflowVerificationPlan.reviewWaiver).toMatchObject({
      kind: "identical_integrated_tree"
    });
    expect(afterRun.workflowVerificationPlan.checks.map((c: any) => c.id)).toEqual(["host-git-integrity"]);
    const reviewCalls = f.calls.filter(c => c.definition.id === "host-reviewer");
    const qaCalls = f.calls.filter(c => c.definition.id === "host-qa");
    expect(reviewCalls).toHaveLength(1);
    expect(qaCalls).toHaveLength(1);
    expect(reviewCalls[0]!.input).toMatchObject({ scope: "task" });
  });

  it("legacy journal without fastPath keeps standard checks", async () => {
    const f = await setupFixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    await f.submit({ file: "guide.md", content: "legacy docs\n" });
    await f.evidence("implement");
    const statePath = join(f.root, "journal/state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    delete state.runs[0].fastPath;
    await writeFile(statePath, JSON.stringify(state));

    const reopened = new AgenticWorkflowRuntime(f.ports, { journalDirectory: join(f.root, "journal"), repositoryPath: f.repository });
    f.runtime = reopened;
    await reopened.tick();
    await reopened.tick();

    const inspected = (await reopened.inspect("run-1")) as any;
    expect(inspected.fastPath).toBeUndefined();
    expect(inspected.tasks[0].verificationPlan.checks.map((c: any) => c.id)).toContain("host-reviewer");
    expect(inspected.workflowVerificationPlan.checks.map((c: any) => c.id)).toContain("host-reviewer");
  });

  it("an explicit custom policy without integrity still downgrades on P17 waiver rejection", async () => {
    const f = await setupFixture({ automatedRefactor: true, humanApproval: true, customWaiverPolicy: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    const origCreate = f.policies.createVerificationPlan.bind(f.policies);
    f.policies.createVerificationPlan = (input: any) => {
      if (input.reviewWaiver) {
        throw new Error("review_waiver_unmapped_criterion: simulated rejection");
      }
      return origCreate(input);
    };
    await f.runtime.tick();
    await f.submit({ file: "src/helper.ts", content: "export const v = 2;\n" });
    await f.evidence("implement");
    await f.runtime.tick();

    const inspected = await f.inspect();
    expect(inspected.fastPath.status).toBe("downgraded");
    expect(inspected.fastPath.downgrade).toMatchObject({
      reason: "waiver_rejected:review_waiver_unmapped_criterion",
      scope: "task"
    });
    expect(inspected.tasks[0].verificationPlan.checks.map((c: any) => c.id)).toContain("host-reviewer");
    expect(
      f.conversationInbox.some(
        m =>
          m.type === "conversation.progress" &&
          typeof (m.payload as any)?.headline === "string" &&
          (m.payload as any).headline.includes("Không đi đường tắt được")
      )
    ).toBe(true);
  });

  it("an explicit custom policy without integrity still downgrades workflow waiver on tree mismatch or incomplete task", async () => {
    const f = await setupFixture({ automatedRefactor: true, humanApproval: true, customWaiverPolicy: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    let callCount = 0;
    f.policies.git.treeOf = async () => (callCount++ === 0 ? "a".repeat(40) : "b".repeat(40));

    await f.runtime.tick();
    await f.submit({ file: "src/helper.ts", content: "export const v = 2;\n" });
    await f.evidence("implement");
    await f.runtime.tick();
    await f.runtime.tick();

    const inspected = await f.inspect();
    expect(inspected.fastPath.status).toBe("downgraded");
    expect(inspected.fastPath.downgrade).toMatchObject({
      reason: "tree_mismatch",
      scope: "workflow"
    });
    expect(inspected.workflowVerificationPlan.checks.map((c: any) => c.id)).toContain("host-reviewer");

    const state = JSON.parse(await readFile(join(f.root, "journal/state.json"), "utf8"));
    const runClone = structuredClone(state.runs[0]);
    runClone.fastPath = { ...runClone.fastPath, status: "active" };
    delete runClone.fastPath.downgrade;
    delete runClone.workflowVerificationPlan;
    runClone.tasks[0].cycle.status = "in_progress";
    const plan = (f.runtime as any).verificationPlan(state, runClone, undefined, {
      taskTree: "a".repeat(40),
      integratedTree: "a".repeat(40)
    });
    expect(runClone.fastPath.status).toBe("downgraded");
    expect(runClone.fastPath.downgrade).toMatchObject({
      reason: "task_not_passed",
      scope: "workflow"
    });
    expect(plan.checks.map((c: any) => c.id)).toContain("host-reviewer");
  });
});
