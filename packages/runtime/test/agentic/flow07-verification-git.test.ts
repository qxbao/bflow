import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentResultSchema,
  QualityGateContextSchema,
  RoleMessageSchema,
  VerificationResultSchema,
  type PaneBinding,
  type QualityGate,
  type RoleMessage,
  type Specification
} from "@bflow/contracts";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { GitIntegrationEngine } from "@bflow/git-orchestrator";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { loadAgenticPolicies, type AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { parseBehavioralCommands, type RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import type { ImpactIndex } from "../../src/agentic/impact-index.js";
import { pinRunnerDefinitions } from "../../src/agentic/runner-provenance.js";
import { regressionChecks, TestRunnerSource } from "../../src/agentic/task-commands.js";
import { parseNodeTap } from "../../src/agentic/node-tap.js";
import { parseRegressionResult } from "../../src/agentic/regression-results.js";
import { classifyChanges } from "../../src/agentic/regression-changes.js";
import { selectRegressionTests } from "../../src/agentic/regression-selection.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { measureTestIntegrity } from "../../src/agentic/host-test-integrity.js";
import { analyzeTestIntegrity } from "../../src/agentic/test-integrity.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { ReworkTestPanes, unwrap as unwrapResult } from "../helpers/rework-causality-fixture.js";
import { fixture as p19Fixture, cleanups as p19Cleanups, git as p19Git } from "../helpers/agentic-integration-fixture.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

const execFileAsync = promisify(execFile);
const sandboxReady = (await probeBehavioralSandbox()).status === "ready";
const localCleanups: (() => Promise<void>)[] = [];
const savedPath = process.env.PATH;

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  for (const fn of localCleanups.splice(0).reverse()) await fn();
  for (const fn of p19Cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
});

function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
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
}

function makeCommandOutcome(
  cwd: string,
  stdout: string,
  exitCode = 0,
  stderr = ""
): QualityCommandOutcome {
  return {
    executable: process.execPath,
    args: [],
    cwd,
    exitCode,
    signal: null,
    stdout,
    stderr,
    combinedOutput: `${stdout}${stderr}`,
    durationMs: 10,
    timedOut: false,
    aborted: false,
    outputTruncated: false
  };
}

describe("Flow 07 — Verification, Rework Causality & Git Delivery red-team regressions", () => {
  it("scopes test-integrity to Reviewer, accepts prompt-shaped findings & optional nulls, rejects no-commit rework submissions, preserves attempt-1 baseline on attempt 2+, and settles multi-gate Reviewer + QA finding verdicts", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow07-multigate-")));
    const repository = join(root, "repo");
    await mkdir(join(repository, "test"), { recursive: true });
    gitSync(repository, "init", "-b", "main");
    gitSync(repository, "config", "user.name", "Test");
    gitSync(repository, "config", "user.email", "test@example.test");

    const testName = "ac-1: The requested outcome is independently verifiable";
    await writeFile(
      join(repository, "test/rework.test.cjs"),
      `const { test } = require("node:test");\nconst assert = require("node:assert/strict");\ntest(${JSON.stringify(testName)}, () => {\n  const computed = 1 + 1;\n  assert.equal(computed, 2);\n});\n`
    );
    await writeFile(join(repository, "guide.md"), "line 1\nline 2\n");
    await writeFile(join(repository, "notes.md"), "notes line 1\nnotes line 2\n");
    gitSync(repository, "add", ".");
    gitSync(repository, "commit", "-m", "baseline");

    const store = unwrapResult(openSqliteRunStore({ filename: join(root, "runs.db") }));
    const artifacts = unwrapResult(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "flow07-store" }));
    localCleanups.push(async () => {
      store.close();
      artifacts.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    const transport = new FakeAgentTransport();
    const panes = new ReworkTestPanes();
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys: { "native-test-host": publicKey } });
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

    const taskChecks = [
      {
        id: "host-reviewer",
        name: "Independent Reviewer",
        evaluator: "review",
        required: true,
        timeout: { executionTimeoutMs: 30_000, onTimeout: "block" },
        configuration: {
          kind: "review",
          method: "manual_review",
          criterionIds: ["ac-1"],
          testNames: [testName],
          role: "reviewer",
          levels: []
        }
      },
      {
        id: "host-qa",
        name: "Independent QA",
        evaluator: "review",
        required: true,
        timeout: { executionTimeoutMs: 30_000, onTimeout: "block" },
        configuration: {
          kind: "review",
          method: "manual_review",
          criterionIds: ["ac-1"],
          testNames: [testName],
          role: "qa",
          levels: []
        }
      },
      {
        id: "regression",
        name: "regression",
        evaluator: "regression",
        required: true,
        timeout: { executionTimeoutMs: 15_000, onTimeout: "block" },
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

    const gates: QualityGate[] = [
      { id: "host-reviewer", evaluate: (...args) => runtime.herdrQualityGate("host-reviewer").evaluate(...args) },
      { id: "host-qa", evaluate: (...args) => runtime.herdrQualityGate("host-qa").evaluate(...args) },
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

    const envelope = (type: RoleMessage["type"], payload: unknown, extra: Partial<RoleMessage> = {}): RoleMessage =>
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

    const reviewErrors: unknown[] = [];
    let onReviewRequest!: (role: "reviewer" | "qa", message: RoleMessage) => Promise<void>;
    const runDetachedFromJournal = AsyncLocalStorage.snapshot();
    const originalSend = transport.send.bind(transport);
    transport.send = async (request, sendOptions) => {
      const receipt = await originalSend(request, sendOptions);
      const parsed = JSON.parse(request.instruction) as RoleMessage;
      if (parsed.type === "verification.requested" && (parsed.recipient.role === "reviewer" || parsed.recipient.role === "qa")) {
        const role = parsed.recipient.role;
        runDetachedFromJournal(() => {
          setTimeout(() => {
            void onReviewRequest(role, parsed).catch(err => reviewErrors.push(err));
          }, 0);
        });
      }
      return receipt;
    };

    const policies = await loadAgenticPolicies({
      artifactStore: artifacts,
      repositoryPath: repository,
      gates,
      loadSpecification: id => runtime.loadSpecification(id),
      authorizeApprover: () => true
    });

    const ports: AgenticRuntimePorts = {
      engine,
      runStore: store,
      artifactStore: artifacts,
      registry,
      transport,
      panes,
      policies,
      authenticateMessage: async () => true,
      deliverToConversation: async () => {},
      authenticateResult: async () => true,
      authenticateGateResult: async result => verification.authenticateGate(result),
      authenticateEvidence: async () => true,
      authorizeHuman: async () => true,
      projectApprovalRequired: () => false,
      roleCapabilities: {
        developer: ["implementation"],
        coordinator: ["coordination", "repository.read"],
        conversation: ["conversation"],
        specifier: ["specification", "repository.read"],
        architect: ["architecture", "repository.read"],
        planner: ["planning", "repository.read"],
        reviewer: ["review", "repository.read"],
        qa: ["verification", "review", "repository.read"],
        tester: ["testing", "repository.read"]
      },
      taskChecks,
      workflowChecks: taskChecks
    };

    runtime = new AgenticWorkflowRuntime(ports, { journalDirectory: join(root, "journal"), repositoryPath: repository });

    const spec: Specification = draft("documentation");
    const time = new Date().toISOString();
    spec.createdAt = time;
    spec.updatedAt = time;
    spec.affectedPaths = ["guide.md", "notes.md", "test/rework.test.cjs"];
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
    def.tasks[0]!.retry.maxAttempts = 3;
    def.tasks[0] = {
      ...def.tasks[0]!,
      metadata: { ownedPaths: ["guide.md", "notes.md", "test/rework.test.cjs"] }
    } as any;

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
    await runtime.proposeWorkflow("run-1", spec, def, 3);
    await runtime.tick();

    // Record alternative evidence so task implementation submission can proceed to independent verification
    {
      const runSnap = (await runtime.inspect("run-1")) as any;
      const task = runSnap.tasks.find((t: any) => t.taskId === "implement");
      const strategy = task.spec.strategy;
      const startedAt = new Date().toISOString();
      const bytes = Buffer.from(`implement-verification-${randomUUID()}`);
      const ref = unwrapResult(
        await artifacts.put({
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
      const method = spec.acceptanceCriteria[0]!.verificationMethod;
      const altResult = VerificationResultSchema.parse({
        schemaVersion: 2,
        verificationId: randomUUID(),
        runId: "run-1",
        taskId: "implement",
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
      await runtime.receiveHerdr(envelope("verification.result", altResult, { sender: { role: "tester" } }));
    }

    const getActiveAssignment = async () => {
      const state = (await runtime.inspect()) as any;
      const outbound = [...state.outbound]
        .reverse()
        .find((item: any) => item.message.run_id === "run-1" && item.message.type === "task.assignment" && item.taskId === "implement" && item.status === "accepted");
      const developerBinding = panes.bindings.find(b => b.agentId === outbound.handle.target.agentId)!;
      return { outbound, handle: outbound.handle, developerBinding };
    };

    // Cycle 1: Developer weakens test/rework.test.cjs (`assert.ok(computed)`) and leaves defects in guide.md + notes.md
    const attempt1 = await getActiveAssignment();
    await writeFile(
      join(attempt1.handle.target.worktreePath, "test/rework.test.cjs"),
      `const { test } = require("node:test");\nconst assert = require("node:assert/strict");\ntest(${JSON.stringify(testName)}, () => {\n  const computed = 1 + 1;\n  assert.ok(computed);\n});\n`
    );
    await writeFile(join(attempt1.handle.target.worktreePath, "guide.md"), "draft without boundary A\nline 2\n");
    await writeFile(join(attempt1.handle.target.worktreePath, "notes.md"), "notes without QA check\nline 2\n");
    gitSync(attempt1.handle.target.worktreePath, "add", ".");
    gitSync(attempt1.handle.target.worktreePath, "commit", "-m", "attempt 1 with weakened assertion");
    const attempt1Head = gitSync(attempt1.handle.target.worktreePath, "rev-parse", "HEAD");

    onReviewRequest = async (role, parsed) => {
      const binding = panes.bindings.find(b => b.role === role)!;
      const inspected = (await verification.inspectReview(binding, { messageId: parsed.message_id })) as any;
      if (role === "reviewer") {
        const tiFinding = inspected.testIntegrityObservation.report.findings[0];
        // Verify actionable missing test-integrity findingId guidance
        await expect(
          verification.completeReview(binding, {
            reviewId: inspected.reviewId,
            messageId: parsed.message_id,
            summary: "Missing testIntegrityVerdicts check",
            criteria: [{ criterionId: "ac-1", passed: false, summary: "fail" }]
          })
        ).rejects.toThrow(new RegExp(`missing findingId\\(s\\): ${tiFinding.id}`));

        // Verify actionable criterionId mismatch guidance once testIntegrityVerdicts is provided
        await expect(
          verification.completeReview(binding, {
            reviewId: inspected.reviewId,
            messageId: parsed.message_id,
            summary: "Bad criteria test",
            criteria: [{ criterionId: "wrong-ac", passed: false, summary: "wrong" }],
            testIntegrityVerdicts: [
              {
                findingId: tiFinding.id,
                verdict: "confirmed_violation",
                reason: "Developer weakened assert.equal(computed, 2) to assert.ok(computed) without owner exception",
                evidence: [
                  {
                    revision: String(inspected.observation.revision).toUpperCase(),
                    path: "test/rework.test.cjs",
                    line: 5,
                    excerpt: "  assert.ok(computed);"
                  }
                ]
              }
            ]
          })
        ).rejects.toThrow(/missing criterionId\(s\): ac-1.*unexpected criterionId\(s\): wrong-ac/);
        // Verify uppercase SHA-1 hex in testIntegrityVerdicts is accepted and line-mismatch gives preview
        await expect(
          verification.completeReview(binding, {
            reviewId: inspected.reviewId,
            messageId: parsed.message_id,
            summary: "Bad line preview check",
            criteria: [{ criterionId: "ac-1", passed: false, summary: "fail" }],
            testIntegrityVerdicts: [
              {
                findingId: tiFinding.id,
                verdict: "confirmed_violation",
                reason: "Assertion was weakened to truthiness check by candidate commit",
                evidence: [
                  {
                    revision: String(inspected.observation.revision).toUpperCase(),
                    path: "test/rework.test.cjs",
                    line: 5,
                    excerpt: "totally wrong line text"
                  }
                ]
              }
            ]
          })
        ).rejects.toThrow(/committed: "  assert\.ok\(computed\);"/);

        // Submit prompt-shaped finding (`category`, `file`, `line: "1-2"`, `evidence`, `suggestedRemediation: null`)
        const completed = await verification.completeReview(binding, {
          reviewId: inspected.reviewId,
          messageId: parsed.message_id,
          summary: "Reviewer rejected weakened assertion and missing boundary A",
          criteria: [{ criterionId: "ac-1", passed: false, summary: "Boundary A missing" }],
          findings: [
            {
              category: "correctness",
              severity: "error",
              file: "guide.md",
              line: "1-2",
              evidence: "guide.md omits boundary A",
              suggestedRemediation: null
            }
          ],
          testIntegrityVerdicts: [
            {
              findingId: tiFinding.id,
              verdict: "confirmed_violation",
              reason: "Developer weakened assert.equal(computed, 2) to assert.ok(computed) without owner exception",
              evidence: [
                {
                  revision: String(inspected.observation.revision).toUpperCase(),
                  path: "test/rework.test.cjs",
                  line: 5,
                  excerpt: "  assert.ok(computed);"
                }
              ]
            }
          ]
        });
        await runtime.receiveHerdr(
          envelope("review.verdict", completed.result, {
            sender: { role: "reviewer", agent_id: binding.agentId, pane_id: binding.paneId },
            causation_id: parsed.message_id,
            artifact_references: [completed.artifact]
          })
        );
      } else {
        // QA must NOT receive testIntegrityObservation, and empty [] testIntegrityVerdicts is harmlessly ignored
        expect(inspected.testIntegrityObservation).toBeUndefined();
        expect(inspected.reviewRequirements.requiredTestIntegrityFindingIds).toEqual([]);
        const completed = await verification.completeReview(binding, {
          reviewId: inspected.reviewId,
          messageId: parsed.message_id,
          summary: "QA found missing rollback note in notes.md",
          criteria: [{ criterionId: "ac-1", passed: false, summary: "notes.md missing QA invariant" }],
          testIntegrityVerdicts: [],
          findings: [
            {
              code: "qa_invariant_missing",
              severity: "error",
              message: "notes.md omits QA rollback note",
              filePath: "notes.md",
              line: null,
              details: null
            }
          ]
        });
        await runtime.receiveHerdr(
          envelope("review.verdict", completed.result, {
            sender: { role: "qa", agent_id: binding.agentId, pane_id: binding.paneId },
            causation_id: parsed.message_id,
            artifact_references: [completed.artifact]
          })
        );
      }
    };

    const submitDeveloperAttempt = async (
      active: Awaited<ReturnType<typeof getActiveAssignment>>,
      metadata?: Record<string, unknown>
    ) => {
      const result = AgentResultSchema.parse({
        requestId: active.handle.requestId,
        attemptId: active.handle.attemptId,
        runId: "run-1",
        taskId: "implement",
        executionId: active.handle.executionId,
        status: "succeeded",
        verification: { status: "verified", evidence: "Submitted", correlation: active.handle.correlation },
        artifactProposals: [],
        retryable: false,
        startedAt: active.handle.acceptedAt,
        completedAt: new Date().toISOString(),
        ...(metadata ? { metadata } : {})
      });
      await runtime.receiveHerdr(
        envelope("implementation.submitted", result, {
          causation_id: active.outbound.message.message_id,
          sender: {
            role: "developer",
            agent_id: active.handle.target.agentId,
            pane_id: active.handle.target.paneId
          }
        })
      );
    };

    await submitDeveloperAttempt(attempt1);
    await runtime.tick();
    expect(reviewErrors).toEqual([]);
    await runtime.tick();

    const runAfterCycle1 = (await runtime.inspect("run-1")) as any;
    expect(runAfterCycle1.tasks[0].cycle.status).toBe("rework_required");

    // Attempt 2: worktree is branched from attempt1Head (`worktrees[1].baseCommitHash === attempt1Head`)
    const attempt2 = await getActiveAssignment();
    const devStatus2 = (await development.status(attempt2.developerBinding, { runId: "run-1", taskId: "implement" })) as any;
    expect(devStatus2.reworkContext.failedRevision).toBe(attempt1Head);
    expect(devStatus2.reworkContext.findings.length).toBeGreaterThanOrEqual(2);

    // 1. Disputed-only rework submission WITHOUT a new commit (`HEAD === failedRevision`) must fail synchronously for `succeeded`
    const noCommitCheck = (await development.check(attempt2.developerBinding, { runId: "run-1", taskId: "implement" })) as any;
    const disputedOnly = devStatus2.reworkContext.findings.map((f: any) => ({
      findingId: f.findingId,
      disposition: "disputed",
      rootCause: "Claiming false positive without any commit on the rework branch",
      disputeReason: "Claiming false positive at failedRevision without advancing HEAD",
      blockerReason: null,
      reproductionSteps: "",
      hypothesisConfirmed: null,
      sourceLocations: ["guide.md:1-1"],
      repairSummary: "No code change made; disputing all findings at failedRevision",
      discriminatingCheck: {
        kind: "manual_review",
        target: "guide.md:1",
        command: null,
        exitCode: null,
        beforeOutcome: "guide.md line 1 unchanged",
        afterOutcome: "guide.md line 1 still unchanged"
      },
      evidence: {
        runId: null,
        taskId: "",
        attemptId: null,
        coreGeneration: null,
        artifactRef: noCommitCheck.evidence,
        sourceRevision: attempt1Head,
        reworkGeneration: 1,
        summary: "Checked at failedRevision without advancing HEAD"
      }
    }));
    await expect(
      runtime.prepareReworkSubmission(attempt2.developerBinding, "run-1", "implement", disputedOnly, "succeeded")
    ).rejects.toThrow(/has no new commit after failedRevision/);

    // 2. First commit on Attempt 2 fixes guide.md + notes.md while keeping `test.skip` to verify Attempt 2+ baseline integrity!
    await writeFile(join(attempt2.handle.target.worktreePath, "guide.md"), "boundary A enforced\nline 2\n");
    await writeFile(join(attempt2.handle.target.worktreePath, "notes.md"), "QA rollback note documented\nline 2\n");
    await development.commit(attempt2.developerBinding, {
      runId: "run-1",
      taskId: "implement",
      expectedHead: devStatus2.head,
      message: "fix docs while leaving test.skip to test baseline"
    });
    const midHead = gitSync(attempt2.handle.target.worktreePath, "rev-parse", "HEAD");
    // dossierFor(runId, taskId): verify originalRevision is worktrees[0].baseCommitHash (NOT attempt1Head!)
    const midDossier = await (verification as any).dossierFor("run-1", "implement");
    expect(midDossier.originalRevision).not.toBe(attempt1Head);
    const midIntegrity = await measureTestIntegrity(
      attempt2.handle.target.worktreePath,
      midDossier.originalRevision,
      midHead
    );
    expect(midIntegrity.findings.length).toBeGreaterThan(0);

    // Now Developer properly restores `test(...)` in `test/rework.test.cjs`, commits, checks work, and submits resolutions with optional `null`/`""` fields!
    await writeFile(
      join(attempt2.handle.target.worktreePath, "test/rework.test.cjs"),
      `const { test } = require("node:test");\nconst assert = require("node:assert/strict");\ntest(${JSON.stringify(testName)}, () => {\n  const computed = 1 + 1;\n  assert.equal(computed, 2);\n});\n`
    );
    const repairedCommit = (await development.commit(attempt2.developerBinding, {
      runId: "run-1",
      taskId: "implement",
      expectedHead: midHead,
      message: "restore test execution without test.skip"
    })) as any;
    const repairedCheck = (await development.check(attempt2.developerBinding, {
      runId: "run-1",
      taskId: "implement"
    })) as any;

    const resolutions2 = devStatus2.reworkContext.findings.map((f: any) => ({
      findingId: f.findingId,
      disposition: "addressed",
      rootCause: `Addressed root cause for ${f.code} in ${f.filePath ?? "task files"}`,
      hypothesisConfirmed: null,
      disputeReason: null,
      blockerReason: "",
      reproductionSteps: null,
      sourceLocations: [`${f.filePath ?? "guide.md"}:1-1`],
      repairSummary: `Repaired ${f.code} and restored strict assertion oracle`,
      discriminatingCheck: {
        kind: "manual_review",
        target: `${f.filePath ?? "guide.md"}:1`,
        command: null,
        exitCode: null,
        beforeOutcome: `Before repair: ${f.code} failed`,
        afterOutcome: `After repair: ${f.code} resolved`
      },
      evidence: {
        runId: null,
        taskId: "",
        attemptId: null,
        coreGeneration: null,
        artifactRef: repairedCheck.evidence,
        sourceRevision: repairedCommit.head,
        reworkGeneration: 1,
        summary: `Verified repaired HEAD ${repairedCommit.head} via check_work`
      }
    }));

    const preparedDossier = await runtime.prepareReworkSubmission(
      attempt2.developerBinding,
      "run-1",
      "implement",
      resolutions2,
      "succeeded"
    );

    // On Cycle 2 verification: Reviewer ONLY verdicts its own gate's requiredFindingVerdictIds, and QA ONLY verdicts its own gate's requiredFindingVerdictIds!
    let reviewerRequiredIds: string[] = [];
    let qaRequiredIds: string[] = [];
    onReviewRequest = async (role, parsed) => {
      const binding = panes.bindings.find(b => b.role === role)!;
      const inspected = (await verification.inspectReview(binding, { messageId: parsed.message_id })) as any;
      const reqIds: string[] = inspected.reviewRequirements.requiredFindingVerdictIds;
      if (role === "reviewer") {
        reviewerRequiredIds = reqIds;
        expect(reqIds.length).toBeGreaterThan(0);
        expect(inspected.reviewRequirements.optionalFindingVerdictIds.length).toBeGreaterThan(0);
      } else {
        qaRequiredIds = reqIds;
        expect(reqIds.length).toBeGreaterThan(0);
        expect(inspected.reviewRequirements.optionalFindingVerdictIds.length).toBeGreaterThan(0);
      }

      const completed = await verification.completeReview(binding, {
        reviewId: inspected.reviewId,
        messageId: parsed.message_id,
        summary: `${role} independently confirmed scoped rework findings`,
        criteria: [{ criterionId: "ac-1", passed: true, summary: "Verified" }],
        findingVerdicts: reqIds.map(findingId => ({
          findingId,
          verdict: "confirmed",
          summary: `${role} confirmed ${findingId}`,
          location: null,
          file: "guide.md",
          line: "1"
        }))
      });
      await runtime.receiveHerdr(
        envelope("review.verdict", completed.result, {
          sender: { role, agent_id: binding.agentId, pane_id: binding.paneId },
          causation_id: parsed.message_id,
          artifact_references: [completed.artifact]
        })
      );
    };

    await submitDeveloperAttempt(attempt2, { reworkResolution: preparedDossier });
    await runtime.tick();
    expect(reviewErrors).toEqual([]);

    // Reviewer and QA had disjoint per-gate required IDs whose union covered 100% of rework findings!
    expect(reviewerRequiredIds.some(id => qaRequiredIds.includes(id))).toBe(false);
    const allFindingIds = devStatus2.reworkContext.findings.map((f: any) => f.findingId).sort();
    expect([...new Set([...reviewerRequiredIds, ...qaRequiredIds])].sort()).toEqual(allFindingIds);

    const finalRun = (await runtime.inspect("run-1")) as any;
    expect({
      status: finalRun.tasks[0].cycle.status,
      escalation: finalRun.tasks[0].cycle.escalation
    }).toEqual({ status: "passed", escalation: undefined });
  }, 240_000);

  it.skipIf(!sandboxReady)("compares regressionGate against worktrees[0].baseCommitHash on rework attempt 2+ without detaching the live task worktree", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow07-regbase-")));
    const repo = join(root, "repo");
    await mkdir(join(repo, "src"), { recursive: true });
    await mkdir(join(repo, "test"), { recursive: true });
    localCleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

    gitSync(repo, "init", "-b", "main");
    gitSync(repo, "config", "user.name", "Test");
    gitSync(repo, "config", "user.email", "test@example.test");
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "reg-demo", private: true }, null, 2) + "\n");
    await writeFile(join(repo, "src/math.cjs"), "module.exports = { add: (a, b) => a + b };\n");
    await writeFile(
      join(repo, "test/math.test.cjs"),
      `const test = require("node:test");\nconst assert = require("node:assert/strict");\nconst { add } = require("../src/math.cjs");\ntest("adds numbers", () => assert.equal(add(2, 3), 5));\n`
    );
    gitSync(repo, "add", ".");
    gitSync(repo, "commit", "-m", "clean baseline");
    const base0 = gitSync(repo, "rev-parse", "HEAD");

    // Attempt 1 branch introduces a regression (`a - b`)
    const wt1 = join(root, "wt-attempt-1");
    gitSync(repo, "worktree", "add", "-b", "task/attempt-1", wt1, base0);
    await writeFile(join(wt1, "src/math.cjs"), "module.exports = { add: (a, b) => a - b };\n");
    gitSync(wt1, "add", ".");
    gitSync(wt1, "commit", "-m", "attempt 1 breaks add");
    const head1 = gitSync(wt1, "rev-parse", "HEAD");

    // Attempt 2 branch is based on head1 (`worktrees[1].baseCommitHash === head1`) and still leaves `add` broken
    const wt2 = join(root, "wt-attempt-2");
    gitSync(repo, "worktree", "add", "-b", "task/attempt-2", wt2, head1);
    await writeFile(join(wt2, "src/notes.cjs"), "module.exports = { note: 'attempt 2' };\n");
    gitSync(wt2, "add", ".");
    gitSync(wt2, "commit", "-m", "attempt 2 touches notes but leaves add broken");
    const head2 = gitSync(wt2, "rev-parse", "HEAD");

    const artifacts = unwrapResult(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "reg-store" }));
    localCleanups.push(async () => artifacts.close());

    const rawProfile: RunnerProfile = {
      id: "node-tap-pnpm",
      command: "detected:node-tap",
      executable: process.execPath,
      args: ["--test", "--test-reporter=tap"],
      method: "unit_test",
      levels: ["unit", "regression"],
      reporter: "node_tap",
      timeoutMs: 30_000,
      definitionBlobs: {},
      checkoutDependencyRoots: [],
      dependencySource: repo,
      source: "detected"
    };
    const pinned = await pinRunnerDefinitions(repo, { status: "detected", profiles: [rawProfile], notes: [] });
    if (pinned.status !== "detected") throw new Error(pinned.reason);
    const activeProfile = pinned.profiles[0]!;
    const source = new TestRunnerSource([], repo, async () => ({ status: "detected", profiles: [activeProfile], notes: [] }));
    await source.refresh();

    const index: ImpactIndex = {
      async importersOf(input) {
        if (input.base !== base0) return { status: "unavailable", code: "commit_mismatch", detail: "commit mismatch" };
        return { status: "ok", indexCommit: base0, files: ["test/math.test.cjs"] };
      }
    };

    const fakeRuntime = {
      inspect: async (runId?: string) => {
        const runRecord = {
          runId: "run-reg",
          baseRevision: base0,
          tasks: [
            {
              taskId: "task-math",
              worktrees: [
                { key: "k1", worktreePath: wt1, branchName: "task/attempt-1", baseCommitHash: base0 },
                { key: "k2", worktreePath: wt2, branchName: "task/attempt-2", baseCommitHash: head1 }
              ]
            }
          ]
        };
        return runId ? runRecord : { runs: [runRecord], outbound: [] };
      }
    } as unknown as AgenticWorkflowRuntime;

    const hostVerification = new HostVerification(
      () => fakeRuntime,
      () => artifacts,
      new HostReceiptJournal(join(root, "receipts"), repo, "session-1"),
      source,
      undefined,
      { scope: "affected", index }
    );
    const definition = regressionChecks([activeProfile])[0]!;
    const gate = hostVerification.behavioralGates().find(g => g.id === definition.id)!;
    const evaluation = await gate.evaluate(
      QualityGateContextSchema.parse({
        runId: "run-reg",
        taskId: "task-math",
        attemptId: "attempt-2",
        definition,
        artifacts: [],
        input: {
          scope: "task",
          sourceRevision: head2,
          baseRevision: head1,
          sourceWorktreePath: wt2,
          specFingerprint: "a".repeat(64)
        }
      })
    );

    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) throw new Error(evaluation.error.message);
    // Must detect the regression against base0 (NOT excuse it against head1!)
    expect(evaluation.value.status).toBe("failed");
    expect(evaluation.value.findings.some(f => f.code === "regression_failure")).toBe(true);
    // And wt2 must remain attached to branch `task/attempt-2` at `head2` (never detached!)
    expect(gitSync(wt2, "symbolic-ref", "-q", "--short", "HEAD")).toBe("task/attempt-2");
    expect(gitSync(wt2, "rev-parse", "HEAD")).toBe(head2);
  }, 60_000);

  it("parses real Node 24 TAP output with escaped '#', '\\\\', literal '# SKIP' inside test names, and actual SKIP/TODO directives", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow07-tap24-")));
    localCleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const suiteFile = join(root, "tap-edge.test.cjs");
    await writeFile(
      suiteFile,
      `const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
describe("Suite #1 \\\\ Core", () => {
  it("ac-1: handles C# & #hashtag \\\\ paths", () => {
    assert.equal(1, 1);
  });
  it("ac-2: literal # SKIP inside title", () => {
    assert.equal(2, 2);
  });
  it("genuinely skipped case", { skip: "not applicable on linux" }, () => {
    assert.fail("must not run");
  });
  it("genuinely todo case", { todo: "future work" }, () => {});
});
`
    );

    const { stdout, stderr } = await execFileAsync(process.execPath, ["--test", "--test-reporter=tap", suiteFile], {
      cwd: root,
      encoding: "utf8"
    });
    const outcome = makeCommandOutcome(root, stdout, 0, stderr);

    const expectedNames = [
      "Suite #1 \\ Core > ac-1: handles C# & #hashtag \\ paths",
      "ac-2: literal # SKIP inside title"
    ];
    // nameSelection = true filters unselected # SKIP / # TODO siblings while preserving literal `# SKIP` inside title!
    const behavioral = parseNodeTap(outcome, expectedNames, true, ["tap-edge.test.cjs"]);
    expect(behavioral.failed).toBe(0);
    expect(behavioral.tests).toBe(2);
    expect([...behavioral.testNames].sort()).toEqual([...expectedNames].sort());

    const regression = parseRegressionResult(outcome, "node_tap", root);
    expect(regression.passed).toBe(2);
    expect(regression.skipped).toBe(2);
    expect(regression.failed).toBe(0);
  });

  it("classifies .d.ts, test setup files, Vitest non-suite test helpers, and deleted sub-packages safely under regressionScope: 'affected'", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow07-affected-")));
    localCleanups.push(() => rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

    const writeRepoFiles = async (files: Record<string, string>) => {
      for (const [relPath, content] of Object.entries(files)) {
        const fullPath = join(repo, relPath);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf8");
      }
    };

    gitSync(repo, "init", "-b", "main");
    await writeRepoFiles({
      "package.json": JSON.stringify({ name: "affected-demo", type: "module" }),
      "src/service.ts": "export const run = () => 'ok';\n",
      "test/fixtures.ts": "import { run } from '../src/service.js';\nexport const fixtureRun = run;\n",
      "test/service.test.ts": "import { fixtureRun } from './fixtures.js';\nfixtureRun();\n",
      "packages/removed/package.json": JSON.stringify({ name: "@demo/removed" }),
      "packages/removed/src/index.ts": "export const old = 1;\n"
    });
    gitSync(repo, "add", ".");
    gitSync(repo, "commit", "-m", "base");
    const base = gitSync(repo, "rev-parse", "HEAD");

    // 1. Editing test/fixtures.ts traverses reverse imports to select test/service.test.ts WITHOUT passing test/fixtures.ts as a runnable Vitest suite
    await writeFile(join(repo, "test/fixtures.ts"), "import { run } from '../src/service.js';\nexport const fixtureRun = () => run();\n");
    gitSync(repo, "add", ".");
    gitSync(repo, "commit", "-m", "edit test helper");
    const headHelper = gitSync(repo, "rev-parse", "HEAD");

    const vitestProfile: RunnerProfile = {
      id: "vitest",
      command: "vitest run",
      executable: process.execPath,
      args: ["vitest", "run"],
      method: "unit_test",
      levels: ["unit", "regression"],
      reporter: "vitest_json",
      timeoutMs: 30_000,
      checkoutDependencyRoots: [],
      dependencySource: repo,
      source: "detected"
    };
    const index: ImpactIndex = {
      async importersOf(input) {
        if (input.files.includes("test/fixtures.ts")) {
          return { status: "ok", indexCommit: input.base, files: ["test/service.test.ts"] };
        }
        return { status: "ok", indexCommit: input.base, files: [] };
      }
    };

    const helperSelected = await selectRegressionTests({
      worktreePath: repo,
      repositoryRoot: repo,
      base,
      head: headHelper,
      profile: vitestProfile,
      scope: "affected",
      index
    });
    expect(helperSelected.scope).toBe("graph");
    expect(helperSelected.testPaths).toEqual(["test/service.test.ts"]);

    // 2. .d.ts and test/setup.ts widen instead of running 0 tests or passing .d.ts as a test file
    const dtsClassified = classifyChanges([{ path: "src/types.d.ts", status: "M" }], () => undefined);
    expect(dtsClassified.tier).toBe("full");
    const setupClassified = classifyChanges(
      [{ path: "packages/pkg-a/test/setup.ts", status: "M" }],
      path => (path.startsWith("packages/pkg-a/") ? "packages/pkg-a" : undefined)
    );
    expect(setupClassified.tier).toBe("package");
    expect(setupClassified.packageRoots).toEqual(["packages/pkg-a"]);

    // 3. Deleting an entire sub-package (packages/removed/package.json absent at HEAD) widens to "full"
    await unlink(join(repo, "packages/removed/package.json"));
    await unlink(join(repo, "packages/removed/src/index.ts"));
    gitSync(repo, "add", "-A");
    gitSync(repo, "commit", "-m", "delete subpackage");
    const headDeleted = gitSync(repo, "rev-parse", "HEAD");

    const deletedSelected = await selectRegressionTests({
      worktreePath: repo,
      repositoryRoot: repo,
      base: headHelper,
      head: headDeleted,
      profile: vitestProfile,
      scope: "affected",
      index
    });
    expect(deletedSelected.scope).toBe("full");
    expect(deletedSelected.testPaths).toEqual(["test/service.test.ts"]);
  });

  it("excludes an attacker-planted repository-local bwrap even when repositoryRoot is passed via a symlink with a trailing slash", async () => {
    const outer = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow07-bwrap-")));
    localCleanups.push(() => rm(outer, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    const realRepo = join(outer, "real-repo");
    const symlinkRepo = join(outer, "linked-repo");
    const repoBin = join(realRepo, "bin");
    const markerFile = join(outer, "poison-executed");

    await mkdir(repoBin, { recursive: true });
    await symlink(realRepo, symlinkRepo);
    const fakeBwrap = join(repoBin, "bwrap");
    await writeFile(
      fakeBwrap,
      `#!/bin/sh\necho poisoned > ${JSON.stringify(markerFile)}\nexit 0\n`
    );
    await chmod(fakeBwrap, 0o755);

    process.env.PATH = `${join(symlinkRepo, "bin")}${delimiter}${savedPath ?? ""}`;
    const report = await probeBehavioralSandbox(`${symlinkRepo}/`);
    if (report.bwrapPath !== undefined && report.bwrapPath !== null) {
      expect(await realpath(report.bwrapPath)).not.toBe(await realpath(fakeBwrap));
    }
    await expect(readFile(markerFile, "utf8")).rejects.toThrow();
  });

  it("bounds corrupt pendingVerifications entries (including missing verificationId) to 3 attempts instead of spinning tick() forever", async () => {
    const f = await p19Fixture();
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();

    // Stub journal.exclusive over an in-memory snapshot containing malformed pendingVerifications lacking verificationId
    // to exercise recordVerificationFailure's digest-based fallback when verificationId is absent.
    const realJournal = (f.runtime as any).journal;
    const baseState = await realJournal.exclusive(async (state: any) => structuredClone(state));
    baseState.pendingVerifications.push(
      { job: { runId: "run-1", taskId: "implement" }, outcome: { malformed: true } },
      { job: { malformed: true }, outcome: { malformed: true } }
    );
    (f.runtime as any).journal = {
      exclusive: async (fn: (state: any, save: () => Promise<void>) => Promise<unknown>) =>
        fn(baseState, async () => {}),
      project: async (select: (state: any) => unknown) => select(baseState)
    };

    try {
      await f.runtime.tick();
      await f.runtime.tick();
      await f.runtime.tick();

      // Orphan entry was evicted on the 3rd failure; run-1 entry was marked stuck=true and escalated run-1
      expect(baseState.pendingVerifications).toHaveLength(1);
      expect(baseState.pendingVerifications[0].attempts).toBe(3);
      expect(baseState.pendingVerifications[0].stuck).toBe(true);
      const run = baseState.runs.find((r: any) => r.runId === "run-1");
      expect(run.status).toBe("escalated");
      expect(run.error).toContain("Verification delivery/storage requires reconciliation");

      // 4th tick must NOT increment attempts further or spin on the stuck entry
      await f.runtime.tick();
      expect(baseState.pendingVerifications[0].attempts).toBe(3);
    } finally {
      (f.runtime as any).journal = realJournal;
    }
  }, 120_000);

  it("integrates dependent task-1 -> task-2 branches cleanly in GitIntegrationEngine", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow07-depgit-")));
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    localCleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

    gitSync(repo, "init", "-b", "main");
    gitSync(repo, "config", "user.name", "Test");
    gitSync(repo, "config", "user.email", "test@example.test");
    await writeFile(join(repo, "README.md"), "# Base\n");
    gitSync(repo, "add", ".");
    gitSync(repo, "commit", "-m", "initial");
    const baseRevision = gitSync(repo, "rev-parse", "HEAD");

    const artifacts = unwrapResult(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "dep-git-store" }));
    localCleanups.push(async () => artifacts.close());
    const engine = await GitIntegrationEngine.open({
      repositoryPath: repo,
      artifactStore: artifacts,
      worktreeRoot: join(root, "worktrees")
    });

    const t1 = await engine.prepareTask({
      runId: "run-dep",
      taskId: "task-1",
      attemptId: "attempt-1",
      baseRevision,
      ownedPaths: ["pkg-a"],
      forbiddenPaths: [],
      developerId: "dev-1"
    });
    await mkdir(join(t1.worktreePath, "pkg-a"), { recursive: true });
    await writeFile(join(t1.worktreePath, "pkg-a/api.ts"), "export const version = 1;\n");
    gitSync(t1.worktreePath, "add", "pkg-a/api.ts");
    gitSync(t1.worktreePath, "commit", "-m", "task-1 adds pkg-a/api.ts");
    const c1 = await engine.collectTask(t1.key);

    // task-2 depends on task-1 and branches from c1.headCommitHash while owning ONLY ["pkg-b"]
    const t2 = await engine.prepareTask({
      runId: "run-dep",
      taskId: "task-2",
      attemptId: "attempt-1",
      baseRevision: c1.headCommitHash,
      dependencyHeads: [c1.headCommitHash],
      ownedPaths: ["pkg-b"],
      forbiddenPaths: [],
      developerId: "dev-2"
    });
    // task-2 sees task-1's committed file in its worktree
    expect(await readFile(join(t2.worktreePath, "pkg-a/api.ts"), "utf8")).toContain("version = 1");
    await mkdir(join(t2.worktreePath, "pkg-b"), { recursive: true });
    await writeFile(join(t2.worktreePath, "pkg-b/consumer.ts"), "import { version } from '../pkg-a/api.js';\nexport const v = version;\n");
    gitSync(t2.worktreePath, "add", "pkg-b/consumer.ts");
    gitSync(t2.worktreePath, "commit", "-m", "task-2 consumes pkg-a/api.ts");
    const c2 = await engine.collectTask(t2.key);
    expect(c2.filesChanged.map(f => f.path)).toEqual(["pkg-b/consumer.ts"]);

    const integration = await engine.beginIntegration({
      runId: "run-dep",
      integrationId: "int-dep",
      baseRevision,
      tasks: [
        { taskKey: t1.key, dependsOn: [] },
        { taskKey: t2.key, dependsOn: [t1.key] }
      ]
    });
    expect(integration.status).toBe("awaiting_verification");
    expect(await readFile(join(integration.worktreePath, "pkg-a/api.ts"), "utf8")).toContain("version = 1");
    expect(await readFile(join(integration.worktreePath, "pkg-b/consumer.ts"), "utf8")).toContain("export const v = version");
  }, 60_000);

  it("restores conflicted MERGE_HEAD when P18 rejects conflict-resolver Attempt 1's commit, succeeds on Attempt 2, and recovers transient 'ready' integrations through workflow verification", async () => {
    const f = await p19Fixture({ parallel: true, conflict: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    await f.evidence("implement");
    await f.evidence("other");
    await f.submit("implement", "first branch\n");
    await f.submit("other", "second branch\n");
    await f.runtime.tick();
    await f.runtime.tick();

    const resolvers = async () =>
      ((await f.runtime.inspect()) as any).outbound.filter(
        (out: any) => out.message.type === "task.assignment" && out.message.payload.kind === "conflict_resolution"
      );

    // Attempt 1 is assigned on the conflicted integration worktree
    const [attempt1Assignment] = await resolvers();
    expect(attempt1Assignment.status).toBe("accepted");
    const resolver1: PaneBinding = f.panes.bindings.find(b => b.paneId === attempt1Assignment.handle.target.paneId)!;
    const worktree = resolver1.worktreePath!;
    const development = new HostDevelopment(() => f.runtime, []);

    // Attempt 1 resolves guide.md BUT also pre-stages an out-of-scope file (`git add unowned.txt`),
    // so the merge commit is created on disk and then REJECTED by P18 `acceptConflictResolution` (`outside_ownership`)!
    await writeFile(join(worktree, "guide.md"), "first branch\nsecond branch\n");
    await writeFile(join(worktree, "unowned.txt"), "out of scope file\n");
    p19Git(worktree, "add", "unowned.txt");
    const headBeforeAttempt1 = p19Git(worktree, "rev-parse", "HEAD");
    const rejected = (await development.commit(resolver1, {
      expectedHead: headBeforeAttempt1,
      message: "Attempt 1 merge commit with out-of-scope staged file"
    })) as any;

    expect(rejected.committed).toBe(true);
    expect(rejected.accepted).toBe(false);
    expect(String(rejected.reason)).toContain("P18 rejected the resolution commit");

    // Crucial: restoreRejectedConflictMerge must have rolled back the rejected merge commit, removed unowned.txt,
    // and restored MERGE_HEAD + unmerged conflict markers on guide.md so Attempt 2 can resolve the conflict!
    expect(p19Git(worktree, "rev-parse", "HEAD")).toBe(headBeforeAttempt1);
    expect(p19Git(worktree, "diff", "--name-only", "--diff-filter=U")).toBe("guide.md");
    await expect(readFile(join(worktree, "unowned.txt"), "utf8")).rejects.toThrow();

    // Next tick settles Attempt 1 and assigns Attempt 2 with previousFailures context
    await f.runtime.tick();
    const allResolvers = await resolvers();
    expect(allResolvers).toHaveLength(2);
    const attempt2Assignment = allResolvers[1];
    expect(attempt2Assignment.status).toBe("accepted");
    expect(attempt2Assignment.message.payload.previousFailures[0]).toContain("P18 rejected the resolution commit");

    // Attempt 2 resolves guide.md cleanly within scope and commits
    const resolver2: PaneBinding = f.panes.bindings.find(b => b.paneId === attempt2Assignment.handle.target.paneId)!;
    await development.authorizeFileEdit(resolver2, {
      tool_name: "Write",
      tool_input: { file_path: join(worktree, "guide.md") }
    });
    await writeFile(join(worktree, "guide.md"), "first branch\nsecond branch\n");
    const accepted = (await development.commit(resolver2, {
      expectedHead: p19Git(worktree, "rev-parse", "HEAD"),
      message: "Attempt 2 clean conflict resolution"
    })) as any;
    expect(accepted).toMatchObject({ committed: true, accepted: true });

    // Simulate an interrupted transient `"ready"` status on P18's integration journal before `integrate()` runs,
    // verifying `integrate()` calls `resumeIntegration(...)` instead of wedging!
    const runMid = await f.inspect();
    const origGetIntegration = f.ports.policies.git.getIntegration.bind(f.ports.policies.git);
    let injectedTransientReady = false;
    let resumeCalled = false;
    const origResume = f.ports.policies.git.resumeIntegration.bind(f.ports.policies.git);
    f.ports.policies.git.getIntegration = async key => {
      const rec = await origGetIntegration(key);
      if (!injectedTransientReady && key === runMid.integrationKey) {
        injectedTransientReady = true;
        return { ...rec, status: "ready" };
      }
      return rec;
    };
    f.ports.policies.git.resumeIntegration = async key => {
      resumeCalled = true;
      return origResume(key);
    };

    for (let i = 0; i < 5 && (await f.inspect()).status !== "awaiting_approval"; i++) {
      await f.runtime.tick();
    }
    expect(resumeCalled).toBe(true);
    const finalRun = await f.inspect();
    expect(finalRun.status).toBe("awaiting_approval");
    expect(finalRun.approvalKind).toBe("delivery");
    expect(finalRun.workflowCycle.status).toBe("passed");
    expect((await origGetIntegration(finalRun.integrationKey)).status).toBe("verified");
  }, 240_000);

  it("detects test weakening, disabling, tautologies, and foreign require() in CommonJS test files instead of treating top-level require bindings as local shadows", () => {
    const baseRev = "a".repeat(40);
    const candRev = "b".repeat(40);
    const baseCjs = [
      'const { test, describe } = require("node:test");',
      'const assert = require("node:assert/strict");',
      'describe("math", () => {',
      '  test("adds", () => {',
      "    assert.equal(add(1, 2), 3);",
      "  });",
      "});"
    ].join("\n");
    const weakenedCjs = [
      'const { test, describe } = require("node:test");',
      'const assert = require("node:assert/strict");',
      'describe("math", () => {',
      '  test.skip("adds", () => {',
      "    assert.ok(add(1, 2));",
      "    assert.equal(1, 1);",
      "  });",
      "});"
    ].join("\n");

    const report = analyzeTestIntegrity({
      baseRevision: baseRev,
      candidateRevision: candRev,
      files: [{ path: "test/math.test.cjs", base: baseCjs, candidate: weakenedCjs }]
    });
    const ruleIds = report.findings.map(f => f.ruleId);
    expect(ruleIds).toContain("TI_TEST_DISABLED");
    expect(ruleIds).toContain("TI_ASSERTION_WEAKENED");
    expect(ruleIds).toContain("TI_LITERAL_TAUTOLOGY");
    expect(ruleIds).not.toContain("TI_SHADOWED_TEST_API");

    // Foreign CommonJS require('./custom-assert') must NOT be proved as a literal tautology
    const foreignReport = analyzeTestIntegrity({
      baseRevision: baseRev,
      candidateRevision: candRev,
      files: [
        {
          path: "test/foreign.test.cjs",
          base: 'const { test } = require("node:test");\ntest("x", () => run());\n',
          candidate: 'const { test } = require("node:test");\nconst { expect } = require("./custom");\ntest("x", () => expect(1).toBe(1));\n'
        }
      ]
    });
    expect(foreignReport.findings.some(f => f.classification === "proven_violation")).toBe(false);
    expect(foreignReport.findings.map(f => f.ruleId)).toContain("TI_UNSUPPORTED_ASSERTION_API");
  });
});
