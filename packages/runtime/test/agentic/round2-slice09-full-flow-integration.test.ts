import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApprovalDecisionSchema,
  ArtifactWriteOptionsSchema,
  PaneBindingSchema,
  QualityGateDefinitionSchema,
  QualityGateResultSchema,
  RoleMessageSchema,
  SessionManifestSchema,
  SpecificationSchema,
  WebCommandSchema,
  type PaneBinding,
  type QualityGate,
  type Specification
} from "@bflow/contracts";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { ChatDecisionSchema, resolveChatDecision } from "@bflow/conversation";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { createHerdrAdapter, type CommandInvocation, type CommandOutcome } from "@bflow/herdr-adapter";
import {
  createRolePaneManager,
  FileSessionManifestStore,
  readBuiltinRolePrompt,
  type AgentLaunchProfile,
  type HerdrSocketPort,
  type WorktreeCleanlinessResult,
  type WorktreeInspector
} from "@bflow/pane-manager";
import { openSqliteRunStore } from "@bflow/persistence";
import { SpecificationEngine } from "@bflow/specification";
import { TestStrategyResolver } from "@bflow/test-strategy";

import { executeCancellationReconciliation } from "../../../../apps/cli/src/cancel-reconciliation.js";
import { observeAuthoritativeRuntime } from "../../../../apps/cli/src/runtime-observation.js";
import { parseCoordinatorAssessmentInput } from "../../src/agentic/assessment-input.js";
import { behavioralChecks, parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { HostConversationIntake } from "../../src/agentic/host-conversation.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { AgenticJournal, digest } from "../../src/agentic/journal.js";
import { parseNodeTap, resolveExpectedIdentities } from "../../src/agentic/node-tap.js";
import { HerdrOutbox } from "../../src/agentic/outbox.js";
import { unmeasuredPolicyPhaseRequests } from "../../src/agentic/phase-recovery.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { TaskHandoverStore } from "../../src/agentic/task-handover.js";
import { taskHandoverAcknowledgement } from "../../src/agentic/task-handover-view.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { parseVitestJson } from "../../src/agentic/vitest-json.js";
import { actionVersion, availableActions } from "../../src/interaction/actions.js";
import { projectRun } from "../../src/interaction/views.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";

const testFileDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testFileDir, "../../../..");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

const unwrap = <T>(res: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
};

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
function assertWellFormedUnicode(value: string): void {
  expect(LONE_SURROGATE_RE.test(value)).toBe(false);
  expect(value.includes("\uFFFD")).toBe(false);
}

async function createTempDir(prefix = "bflow-r2-s9-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const xdgState = join(dir, "xdg-state");
  await mkdir(xdgState, { recursive: true, mode: 0o700 });
  vi.stubEnv("XDG_STATE_HOME", xdgState);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "safe.directory=*",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.fileMode=false",
      ...args
    ],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Slice9 Test",
        GIT_AUTHOR_EMAIL: "slice9@bflow.test",
        GIT_COMMITTER_NAME: "Slice9 Test",
        GIT_COMMITTER_EMAIL: "slice9@bflow.test"
      }
    }
  ).trim();
}

async function initGitRepo(repoPath: string): Promise<string> {
  await mkdir(join(repoPath, "src"), { recursive: true });
  await mkdir(join(repoPath, "test"), { recursive: true });
  git(repoPath, "init", "-b", "main");
  git(repoPath, "config", "user.name", "Slice9 Test");
  git(repoPath, "config", "user.email", "slice9@bflow.test");
  git(repoPath, "config", "core.fileMode", "false");
  await writeFile(join(repoPath, ".gitignore"), ".bflow/\n", "utf8");
  await writeFile(
    join(repoPath, "src/path-handler.js"),
    'export function normalizeVietnamesePath(input) {\n  return String(input ?? "").trim();\n}\n',
    "utf8"
  );
  await writeFile(
    join(repoPath, "test/path-handler.test.js"),
    [
      'import { describe, it } from "node:test";',
      'import assert from "node:assert/strict";',
      'import { normalizeVietnamesePath } from "../src/path-handler.js";',
      'describe("Suite", () => {',
      '  it("placeholder", () => { assert.equal(normalizeVietnamesePath(" a "), "a"); });',
      '  it.skip("bỏ qua nhánh phụ", () => {});',
      "});",
      ""
    ].join("\n"),
    "utf8"
  );
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "initial commit");
  return git(repoPath, "rev-parse", "HEAD");
}

class MemoryPanePolicy implements PanePolicy {
  busy = new Set<string>();
  bindings: PaneBinding[];
  activeRunIds: string[] = [];
  readonly workspaceRoot: string;

  constructor(workspaceRoot: string, sessionId = "s9-session", convSessionId = "s9-conv") {
    this.workspaceRoot = workspaceRoot;
    this.bindings = [
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
        sessionId,
        role,
        agentId: `${role}-agent`,
        paneId: `pane-${role}`,
        workspaceId: "w1",
        tabId: "t1",
        provider: "claude",
        agentKind: "claude",
        cwd: workspaceRoot,
        readOnlyWorkspace: role !== "developer",
        permanent: true,
        isolationMode: "dedicated_pane",
        transportState: "idle",
        boundAt: "2026-10-31T12:00:00.000Z",
        session: { source: "herdr:claude", kind: "id", value: `native-${role}` }
      })
    );
    this.#sessionId = sessionId;
    this.#convSessionId = convSessionId;
  }

  readonly #sessionId: string;
  readonly #convSessionId: string;

  async getManifest() {
    return {
      ok: true as const,
      value: SessionManifestSchema.parse({
        schemaVersion: 2,
        sessionId: this.#sessionId,
        projectName: "slice09-integration",
        workspaceRoot: this.workspaceRoot,
        herdrWorkspaceId: "w1",
        herdrTabId: "t1",
        status: "up",
        panes: this.bindings,
        conversationSessionId: this.#convSessionId,
        activeRunIds: this.activeRunIds,
        attachTarget: { role: "conversation", paneId: "pane-conversation" },
        createdAt: "2026-10-31T12:00:00.000Z",
        updatedAt: "2026-10-31T12:00:00.000Z"
      })
    };
  }

  async getRoleBinding(selector: string) {
    const active =
      this.bindings.find(
        b =>
          b.metadata?.allocationStatus !== "released" &&
          (b.bindingId === selector || b.paneId === selector || b.agentId === selector || b.role === selector)
      ) ??
      this.bindings.find(
        b => b.bindingId === selector || b.paneId === selector || b.agentId === selector || b.role === selector
      ) ??
      null;
    return { ok: true as const, value: active };
  }

  async inspectRoleHealth(selector: string) {
    const found = (await this.getRoleBinding(selector)).value;
    if (!found) {
      return { ok: false as const, error: { code: "not_found" as const, retryable: false, message: "missing binding" } };
    }
    const ready = !this.busy.has(found.paneId) && !this.busy.has(found.role) && !this.busy.has(found.agentId);
    return {
      ok: true as const,
      value: {
        role: found.role,
        paneId: found.paneId,
        agentId: found.agentId,
        status: ready ? ("healthy" as const) : ("transport_unresponsive" as const),
        paneExists: true,
        processAlive: true,
        occupantMatches: true,
        readyForPrompt: ready,
        interactiveReady: ready,
        launchPending: false,
        transportResponsive: ready,
        checkedAt: new Date().toISOString()
      }
    };
  }

  async allocateDeveloper(input: { taskId: string; worktreePath: string; agentKind?: string; agentName?: string }) {
    const idx = this.bindings.filter(b => b.role === "developer").length + 1;
    const binding = PaneBindingSchema.parse({
      schemaVersion: 2,
      bindingId: `dev-binding-${idx}`,
      sessionId: this.#sessionId,
      role: "developer",
      agentId: input.agentName ?? `dev-agent-${idx}`,
      paneId: `pane-dev-${idx}`,
      workspaceId: "w2",
      tabId: "t2",
      provider: input.agentKind ?? "claude",
      agentKind: input.agentKind ?? "claude",
      cwd: input.worktreePath,
      worktreePath: input.worktreePath,
      readOnlyWorkspace: false,
      permanent: false,
      isolationMode: "dedicated_pane",
      transportState: "idle",
      boundAt: new Date().toISOString(),
      session: { source: "herdr:claude", kind: "id", value: `native-dev-${idx}` },
      metadata: { taskId: input.taskId, allocationStatus: "active" }
    });
    this.bindings.push(binding);
    return { ok: true as const, value: binding };
  }

  async releaseDeveloper(input: { taskId: string }) {
    const idx = this.bindings.findIndex(
      b =>
        b.role === "developer" &&
        b.metadata?.allocationStatus !== "released" &&
        (b.metadata?.taskId === input.taskId || b.bindingId === input.taskId || b.paneId === input.taskId)
    );
    if (idx >= 0) {
      const prev = this.bindings[idx]!;
      this.bindings[idx] = PaneBindingSchema.parse({
        ...prev,
        transportState: "disconnected",
        metadata: { ...prev.metadata, allocationStatus: "released" }
      });
    }
    return { ok: true as const, value: { released: idx >= 0 } };
  }

  async registerRun(runId: string) {
    if (!this.activeRunIds.includes(runId)) this.activeRunIds.push(runId);
    return { ok: true as const, value: (await this.getManifest()).value };
  }

  async unregisterRun(runId: string) {
    this.activeRunIds = this.activeRunIds.filter(id => id !== runId);
    return { ok: true as const, value: (await this.getManifest()).value };
  }
}

function makeStandardSpec(params: {
  runId: string;
  specId: string;
  sessionId: string;
  criterionDescription: string;
  testName: string;
  testPath?: string;
  sourcePath?: string;
  command?: string;
}) {
  const testPath = params.testPath ?? "test/path-handler.test.js";
  const sourcePath = params.sourcePath ?? "src/path-handler.js";
  const command = params.command ?? "owner:unit";
  return {
    schemaVersion: 2 as const,
    specId: params.specId,
    runId: params.runId,
    sessionId: params.sessionId,
    level: "lightweight" as const,
    title: "Chuẩn hóa đường dẫn tiếng Việt",
    summary: "Xử lý chuẩn hóa NFC và khoảng trắng cho đường dẫn tiếng Việt.",
    problemStatement: "Đường dẫn tiếng Việt tổ hợp NFD và NFC chưa được đồng nhất.",
    scope: {
      inScope: [sourcePath, testPath],
      outOfScope: ["docs/"]
    },
    acceptanceCriteria: [
      {
        id: "ac-1",
        description: params.criterionDescription,
        category: "functional" as const,
        verificationMethod: "unit_test" as const,
        required: true,
        status: "pending" as const,
        evidenceArtifactIds: []
      }
    ],
    affectedPaths: [sourcePath, testPath],
    complexity: "standard" as const,
    riskLevel: "medium" as const,
    version: 1,
    traceabilityTaskIds: ["implement"],
    status: "draft" as const,
    createdBy: "coordinator",
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
      testStrategy: {
        schemaVersion: 2 as const,
        strategyId: `strategy-${params.specId}`,
        specId: params.specId,
        tddDecision: {
          schemaVersion: 2 as const,
          decisionId: `tdd-${params.specId}`,
          runId: params.runId,
          taskId: "implement",
          specId: params.specId,
          mode: "required" as const,
          rationale: "Domain logic change",
          verifiableConditions: ["ac-1"],
          changeClassification: "domain_logic" as const,
          requiresFailingTestFirst: true,
          decidedBy: "coordinator",
          decidedAt: "2026-10-31T00:00:00.000Z"
        },
        requiredTestLevels: ["unit" as const],
        targetCommands: [command],
        independentVerificationRequired: true,
        criterionMappings: [{ criterionId: "ac-1", testNames: [params.testName] }],
        createdAt: "2026-10-31T00:00:00.000Z"
      },
      metadata: {
        sdd: {
          policyVersion: 1,
          assessment: {
            kind: "bugfix",
            behaviorChange: true,
            modules: ["path-handler"],
            securityImpact: false,
            publicApiImpact: false,
            dataSchemaImpact: false,
            architectureImpact: false,
            migrationRequired: false,
            risk: "low",
            unresolvedQuestions: []
          },
          functionalRequirements: ["Chuẩn hóa NFC cho đường dẫn tiếng Việt"],
          proposedTestStrategy: "Kiểm thử đơn vị Red-Green-Refactor",
          technicalConstraints: [],
          apiDataContracts: [],
          risksAndTradeoffs: [],
          traceability: [{ criterionId: "ac-1", taskIds: ["implement"] }]
        },
        conditionalTdd: {
          policyVersion: 1,
          taskId: "implement",
          taskType: "domain_logic",
          changeImpact: {
            surfaces: ["domain_logic"],
            behaviorChanged: true,
            deterministic: true,
            regressionReproducible: true,
            securitySensitive: false,
            dataMigration: false,
            scope: "local"
          },
          infrastructure: {
            readiness: "ready",
            commands: [{ method: "unit_test", command, level: "unit" }]
          },
          testability: {
            level: "automated",
            rationale: "Independent repeatable behavioral checks are available"
          },
          riskClassification: "low",
          conventions: {
            tdd: "contextual",
            requiredMethods: [],
            suggestedLevels: []
          }
        }
      }
  };
}

function makeSingleTaskWorkflow(_taskAcceptanceDescription: string, ownedPaths = ["src/path-handler.js", "test/path-handler.test.js"]) {
  return {
    schemaVersion: "1" as const,
    id: "wf-slice09",
    name: "Workflow Slice 09",
    version: "1.0.0",
    tasks: [
      {
        id: "implement",
        title: "Triển khai chuẩn hóa đường dẫn tiếng Việt",
        role: "developer",
        instruction: "Thực hiện TDD Red -> Green -> Refactor cho src/path-handler.js",
        acceptanceCriteria: ["ac-1"],
        retry: {
          maxAttempts: 1,
          strategy: "fixed" as const,
          initialDelayMs: 0,
          maxDelayMs: 0,
          jitter: false
        },
        timeout: {
          executionTimeoutMs: 120_000,
          onTimeout: "block" as const
        },
        requiresApproval: false,
        qualityGates: [],
        metadata: {
          ownedPaths,
          requiredCapabilities: ["implementation"]
        }
      }
    ],
    dependencies: [],
    qualityGates: [],
    maxConcurrency: 1,
    failurePolicy: "block" as const,
    recovery: {
      checkpoint: "task-boundary" as const,
      resumeStrategy: "checkpoint-then-replay" as const,
      staleExecution: "reconcile" as const
    }
  };
}

function makeDefaultVerificationChecks(testName = "Suite xử lý đường dẫn tiếng Việt") {
  const checks = [
    QualityGateDefinitionSchema.parse({
      id: "review",
      name: "Independent review",
      evaluator: "review",
      required: true,
      timeout: { executionTimeoutMs: 30_000, onTimeout: "block" },
      metadata: { bindAcceptedCriteria: true },
      configuration: { kind: "review", method: "manual_review", criterionIds: ["ac-1"], testNames: [], role: "reviewer", levels: [] }
    }),
    QualityGateDefinitionSchema.parse({
      id: "owner-unit",
      name: "Unit behavioral check",
      evaluator: "behavioral",
      required: true,
      timeout: { executionTimeoutMs: 30_000, onTimeout: "block" },
      configuration: {
        kind: "deterministic",
        method: "unit_test",
        command: "owner:unit",
        criterionIds: ["ac-1"],
        testNames: [testName],
        role: "tester",
        levels: ["unit", "regression"]
      }
    })
  ];
  const gates: QualityGate[] = checks.map(c => ({
    id: c.id,
    evaluate: async () => {
      throw new Error(`Gate ${c.id} not invoked in this scenario`);
    }
  }));
  return { checks, gates };
}

describe("Round 2 Slice 9 — Cross-Slice Red-Team & Full-Flow Integration", () => {
  describe("Seam A — Task Notices, Verifier Recovery & Outbox <-> Runtime Continuation (Slice 6 <-> Slice 8 <-> Slice 4)", () => {
    it("A1: clears out.request across all expired-parent-lease cancellation paths, escalates queued phase-notice cancellation on flush, and revives with fresh fencingToken on Web resume", async () => {
      const root = await createTempDir("bflow-s9-seam-a1-");
      const repoPath = join(root, "repo");
      await initGitRepo(repoPath);

      let now = new Date("2026-10-31T12:00:00.000Z");
      const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => now });
      const engine = new DeterministicWorkflowEngine();
      const transport = new FakeAgentTransport();
      const panes = new MemoryPanePolicy(repoPath);
      const runStore = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
      cleanups.push(() => {
        runStore.close();
      });
      const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "s9-a1" }));
      cleanups.push(() => {
        artifacts.close();
      });
      let runtime!: AgenticWorkflowRuntime;
      const { checks: a1Checks, gates: a1Gates } = makeDefaultVerificationChecks();
      const policies = await loadAgenticPolicies({
        repositoryPath: repoPath,
        artifactStore: artifacts,
        gates: a1Gates,
        loadSpecification: id => runtime.loadSpecification(id),
        authorizeApprover: () => true,
        clock: () => now
      });

      const ports: AgenticRuntimePorts = {
        engine,
        registry,
        transport,
        runStore,
        artifactStore: artifacts,
        panes,
        policies,
        deliverToConversation: async () => undefined,
        taskChecks: a1Checks,
        workflowChecks: a1Checks,
        roleCapabilities: {
          conversation: ["conversation"],
          coordinator: ["coordination", "specification", "planning", "repository.read"],
          developer: ["implementation"],
          qa: ["verification", "testing", "repository.read"],
          reviewer: ["review", "repository.read"]
        },
        preflightRoleCapabilities: async () => undefined,
        authenticateMessage: async () => true,
        authenticateResult: async () => true,
        authenticateEvidence: async () => true,
        authenticateGateResult: async () => true,
        authorizeHuman: async () => true,
        clock: () => now
      };

      const journalDirectory = join(root, "journal");
      runtime = new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath: repoPath });

      // 1. Direct Outbox check: pre-populated `out.request` on an unsent task notice whose parent lease expired
      //    during pre-send renewal (line 535) AND startup reconcile (line 387) MUST delete `out.request` so
      //    `reviveUnsent` (`!notice.request && !notice.handle && notice.error?.includes("parent lease is expired")`) matches!
      const intakeMsg = RoleMessageSchema.parse({
        schema_version: 2,
        message_id: "msg-intake-a1",
        correlation_id: "corr-a1",
        run_id: "run-a1",
        sender: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
        recipient: { role: "coordinator" },
        type: "delegation.request",
        payload: {
          schemaVersion: 2,
          delegationId: "del-a1",
          messageId: "msg-intake-a1",
          correlationId: "corr-a1",
          runId: "run-a1",
          sessionId: "s9-conv",
          requestedBy: "conversation",
          targetRole: "coordinator",
          title: "Chuẩn hóa đường dẫn",
          objective: "Chuẩn hóa NFC cho đường dẫn tiếng Việt",
          specificationId: "spec-a1",
          sddLevel: "lightweight",
          acceptanceCriteria: [
            {
              id: "ac-1",
              description: "Chuẩn hóa NFC chính xác",
              category: "functional",
              verificationMethod: "unit_test",
              required: true,
              status: "pending",
              evidenceArtifactIds: []
            }
          ],
          inputArtifacts: [],
          priority: "normal",
          requestedAt: now.toISOString(),
          idempotencyKey: "idemp-a1"
        },
        artifact_references: [],
        occurred_at: now.toISOString(),
        idempotency_key: "idemp-intake-a1"
      });

      await runtime.receiveHerdr(intakeMsg);
      const runId = "run-a1";
      await runtime.flushOutbound();

      const spec = makeStandardSpec({
        runId,
        specId: "spec-a1",
        sessionId: "s9-conv",
        criterionDescription: "Chuẩn hóa NFC chính xác",
        testName: "Suite xử lý đường dẫn tiếng Việt"
      });
      const def = makeSingleTaskWorkflow("Chuẩn hóa NFC chính xác");
      await runtime.proposeWorkflow(runId, spec, def, 3);
      await runtime.tick();

      // Approve design if awaiting_approval
      const runStateAfterProposal = (await runtime.inspect(runId)) as Record<string, unknown>;
      if (runStateAfterProposal.status === "awaiting_approval" && runStateAfterProposal.approval) {
        const approval = runStateAfterProposal.approval as { approvalId: string };
        const decision = ApprovalDecisionSchema.parse({
          schemaVersion: 2,
          decisionId: "dec-design-a1",
          approvalId: approval.approvalId,
          runId,
          decision: "approved",
          decidedBy: "user-1",
          decidedAt: now.toISOString(),
          provenance: { origin: "user", authenticatedUser: true, userId: "user-1", paneId: "pane-conversation", channel: "herdr_attach" },
          idempotencyKey: "idemp-dec-design-a1"
        });
        await runtime.receiveHerdr(
          RoleMessageSchema.parse({
            schema_version: 2,
            message_id: "msg-approve-a1",
            correlation_id: "corr-a1",
            run_id: runId,
            sender: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
            recipient: { role: "coordinator" },
            type: "approval.decision",
            payload: decision,
            artifact_references: [],
            occurred_at: now.toISOString(),
            idempotency_key: "idemp-approve-a1"
          })
        );
      }
      await runtime.tick();

      // Developer assignment is now accepted; commit a Red test in Developer's worktree and request Red verification.
      const inspected1 = (await runtime.inspect()) as {
        runs: Array<{ runId: string; status?: string; error?: string; tasks: Array<{ taskId: string; worktrees: Array<{ worktreePath: string }> }> }>;
        outbound: Array<{ message: { message_id: string; type: string; run_id?: string }; status: string; lease?: { leaseId: string; fencingToken: number; expiresAt: string }; handle?: { target: { paneId?: string } } }>;
      };
      expect(inspected1.runs.find(r => r.runId === runId)?.error).toBeUndefined();
      const devAssignment = inspected1.outbound.find(o => o.message.run_id === runId && o.message.type === "task.assignment")!;
      expect(devAssignment.status).toBe("accepted");
      const initialFence = devAssignment.lease!.fencingToken;
      const initialLeaseId = devAssignment.lease!.leaseId;
      const devBinding = (await panes.getRoleBinding(devAssignment.handle!.target.paneId!)).value!;
      const worktreePath = devBinding.worktreePath!;

      await writeFile(
        join(worktreePath, "test/path-handler.test.js"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { normalizeVietnamesePath } from "../src/path-handler.js";\ntest("Suite xử lý đường dẫn tiếng Việt", () => { assert.equal(normalizeVietnamesePath("Vie\\u0323\\u0302t"), "Việt"); });\n',
        "utf8"
      );
      git(worktreePath, "add", "test/path-handler.test.js");
      git(worktreePath, "commit", "-m", "red test");
      const redHead = git(worktreePath, "rev-parse", "HEAD");

      await runtime.requestPhaseVerification(devBinding, runId, "implement", "red", redHead);
      await runtime.flushOutbound();

      const inspected2 = (await runtime.inspect()) as {
        outbound: Array<{ message: { message_id: string; type: string; run_id?: string; payload: Record<string, unknown> }; status: string }>;
      };
      const qaReq = inspected2.outbound.find(
        o => o.message.run_id === runId && o.message.type === "verification.requested" && o.message.payload.phase === "red"
      )!;
      expect(qaReq.status).toBe("accepted");
      const qaBinding = (await panes.getRoleBinding("qa")).value!;

      // Reproduce genuine pre-populated `out.request` on an unsent task notice:
      // 1) QA records a repairable phase failure, and on the first `flushOutbound()` transport returns a proven temporary rejection ->
      //    HerdrOutbox builds `out.request` (pinning old lease/fence) and leaves `out.status = "queued"` (no `handle`)!
      const failureBytes = Buffer.from(JSON.stringify({ runId, taskId: "implement",
        attemptId: qaReq.message.payload.implementationAttemptId, sourceRevision: redHead, phase: "red",
        observation: { revision: redHead }, criteria: [{ criterionId: "ac-1", passed: false,
          summary: "Failed mapped test: Suite xử lý đường dẫn tiếng Việt" }], accepted: false }));
      const failureArtifactId = `a1-phase-failure-${redHead.slice(0, 12)}`;
      const failureEvidence = unwrap(await artifacts.put({ options: ArtifactWriteOptionsSchema.parse({ artifactId: failureArtifactId, runId,
        taskId: "implement", kind: "test-result", mediaType: "application/json",
        expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(failureBytes).digest("hex") }, sizeBytes: failureBytes.length },
        idempotencyKey: failureArtifactId }), content: (async function* () { yield failureBytes; })() }));
      await runtime.recordPhaseFailure(qaBinding, qaReq.message.message_id, "Behavioral test code failed without assertion", true, failureEvidence);
      transport.customSendHandler = req => ({
        ok: true,
        value: {
          status: "rejected",
          requestId: req.requestId,
          attemptId: req.attemptId,
          runId: req.runId,
          taskId: req.taskId,
          observedAt: now.toISOString(),
          reason: "Recipient temporarily busy"
        }
      });
      await runtime.flushOutbound();
      delete transport.customSendHandler;

      const whileBusy = (await runtime.inspect()) as {
        outbound: Array<Record<string, unknown>>;
      };
      const queuedWithRequest = whileBusy.outbound.find(o =>
        String((o.message as { message_id: string }).message_id).startsWith("phase-notice-")
      )!;
      expect(queuedWithRequest.status).toBe("queued");
      expect(queuedWithRequest.request).toBeDefined();
      expect(queuedWithRequest.handle).toBeUndefined();

      // 2) Before the next flush retry, advance clock past the 5-minute Registry lease TTL (>300s)!
      now = new Date(now.getTime() + 360_000);

      // `flushOutbound()` retries `renew(notice)` against Registry, gets permanent authority error `"Lease expired or released"`,
      // MUST clear `out.request` on cancellation, AND MUST immediately escalate the run with `pendingAction`!
      await runtime.flushOutbound();

      const afterFlush = (await runtime.inspect()) as {
        runs: Array<Record<string, unknown>>;
        outbound: Array<Record<string, unknown>>;
      };
      const cancelledNotice = afterFlush.outbound.find(o =>
        String((o.message as { message_id: string }).message_id).startsWith("phase-notice-")
      )!;
      expect(cancelledNotice.status).toBe("cancelled");
      expect(String(cancelledNotice.error)).toContain("parent lease is expired");
      expect(cancelledNotice.request).toBeUndefined();

      // Run MUST immediately be escalated with pendingAction (NOT wedged in "implementing" without pendingAction!)
      const escalatedRun = afterFlush.runs.find(r => r.runId === runId)!;
      expect(escalatedRun.status).toBe("escalated");
      expect(escalatedRun.pendingAction).toBeDefined();

      // Verify Web UI / Interaction projection enables `resume` with well-formed Vietnamese blocker summary
      const runForView = escalatedRun as Parameters<typeof availableActions>[0];
      const actions = availableActions(runForView, afterFlush as never, [], true, true);
      const resumeAction = actions.find(a => a.kind === "resume")!;
      expect(resumeAction.enabled).toBe(true);
      const coreSnapA1 = unwrap(await engine.getSnapshot(runId))!;
      const projected = projectRun(
        {
          state: { ...afterFlush, pendingCore: [] } as never,
          sessionId: "s9-conv",
          observedAt: now.toISOString(),
          core: new Map([[runId, coreSnapA1]]),
          ready: true,
          commandsSupported: true
        },
        runId
      );
      assertWellFormedUnicode(JSON.stringify(projected));

      // Coordinator direct resume_run on expired writer lease must remain rejected with actionable owner-resume guidance
      const tools = new CoordinatorTools(runtime);
      const pendingAction = escalatedRun.pendingAction as { actionId: string };
      await expect(
        tools.invoke("resume_run", { runId, actionId: pendingAction.actionId, messageId: null }, { role: "coordinator" })
      ).rejects.toThrow(/owner resume/i);

      // Explicit owner Web `resume` recovers the task lease under a NEW higher fencingToken and revives + delivers the cancelled phase-notice!
      const webCmd = WebCommandSchema.parse({
        apiVersion: 1,
        projectId: "proj-s9-a1",
        kind: "resume",
        commandId: "11111111-1111-4111-8111-111111111111",
        runId,
        actionId: pendingAction.actionId,
        expectedVersion: actionVersion(runForView, "resume")
      });
      await runtime.resumeBlockedRun(runId, pendingAction.actionId, { webCommand: webCmd });
      await runtime.flushOutbound();

      const afterResume = (await runtime.inspect()) as {
        runs: Array<Record<string, unknown>>;
        outbound: Array<Record<string, unknown>>;
      };
      const resumedRun = afterResume.runs.find(r => r.runId === runId)!;
      expect(resumedRun.status).toBe("implementing");

      const revivedParent = afterResume.outbound.find(
        o => (o.message as { message_id: string }).message_id === devAssignment.message.message_id
      )!;
      const newLease = revivedParent.lease as { leaseId: string; fencingToken: number };
      expect(newLease.leaseId).not.toBe(initialLeaseId);
      expect(newLease.fencingToken).toBeGreaterThan(initialFence);

      const deliveredNotice = afterResume.outbound.find(
        o => (o.message as { message_id: string }).message_id === (cancelledNotice.message as { message_id: string }).message_id
      )!;
      // Parent is still active (`writerReleased` is false), so accepted task notice stays `"accepted"` with fresh lease metadata!
      expect(deliveredNotice.status).toBe("accepted");
      expect(deliveredNotice.handle).toBeDefined();
      expect((deliveredNotice.request as { metadata: { leaseId: string; fencingToken: number } }).metadata).toEqual({
        leaseId: newLease.leaseId,
        fencingToken: newLease.fencingToken
      });
    });

    it("A2: recovers unmeasured conditional_evidence QA phases (both active-Developer TDD phase via CoordinatorTools resume_run with null optionals AND post-submit alternative evidence via Web resume)", async () => {
      const root = await createTempDir("bflow-s9-seam-a2-");
      const repoPath = join(root, "repo");
      await initGitRepo(repoPath);

      let now = new Date();
      const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => now });
      const engine = new DeterministicWorkflowEngine();
      const transport = new FakeAgentTransport();
      const panes = new MemoryPanePolicy(repoPath);
      const runStore = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
      cleanups.push(() => {
        runStore.close();
      });
      const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "s9-a1" }));
      cleanups.push(() => {
        artifacts.close();
      });
      let runtime!: AgenticWorkflowRuntime;
      const { checks: a1Checks, gates: a1Gates } = makeDefaultVerificationChecks();
      const policies = await loadAgenticPolicies({
        repositoryPath: repoPath,
        artifactStore: artifacts,
        gates: a1Gates,
        loadSpecification: id => runtime.loadSpecification(id),
        authorizeApprover: () => true,
        clock: () => now
      });

      const ports: AgenticRuntimePorts = {
        engine,
        registry,
        transport,
        runStore,
        artifactStore: artifacts,
        panes,
        policies,
        deliverToConversation: async () => undefined,
        taskChecks: a1Checks,
        workflowChecks: a1Checks,
        automaticAlternativeEvidence: true,
        roleCapabilities: {
          conversation: ["conversation"],
          coordinator: ["coordination", "specification", "planning", "repository.read"],
          developer: ["implementation"],
          qa: ["verification", "testing", "repository.read"],
          reviewer: ["review", "repository.read"]
        },
        preflightRoleCapabilities: async () => undefined,
        authenticateMessage: async () => true,
        authenticateResult: async () => true,
        authenticateEvidence: async () => true,
        authenticateGateResult: async () => true,
        authorizeHuman: async () => true,
        clock: () => now
      };

      runtime = new AgenticWorkflowRuntime(ports, {
        journalDirectory: join(root, "journal"),
        repositoryPath: repoPath
      });
      const tools = new CoordinatorTools(runtime);

      // --- Part 1: Active-Developer TDD phase where QA stops without recording evidence ---
      await runtime.receiveHerdr(
        RoleMessageSchema.parse({
          schema_version: 2,
          message_id: "msg-intake-a2-1",
          correlation_id: "corr-a2-1",
          run_id: "run-a2-1",
          sender: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
          recipient: { role: "coordinator" },
          type: "delegation.request",
          payload: {
            schemaVersion: 2,
            delegationId: "del-a2-1",
            messageId: "msg-intake-a2-1",
            correlationId: "corr-a2-1",
            runId: "run-a2-1",
            sessionId: "s9-conv",
            requestedBy: "conversation",
            targetRole: "coordinator",
            title: "Chuẩn hóa đường dẫn",
            objective: "Chuẩn hóa đường dẫn tiếng Việt",
            specificationId: "spec-a2-1",
            sddLevel: "lightweight",
            acceptanceCriteria: [
              {
                id: "ac-1",
                description: "Chuẩn hóa NFC chính xác",
                category: "functional",
                verificationMethod: "unit_test",
                required: true,
                status: "pending",
                evidenceArtifactIds: []
              }
            ],
            inputArtifacts: [],
            priority: "normal",
            requestedAt: now.toISOString(),
            idempotencyKey: "idemp-a2-1"
          },
          artifact_references: [],
          occurred_at: now.toISOString(),
          idempotency_key: "idemp-intake-a2-1"
        })
      );
      const run1 = "run-a2-1";
      await runtime.flushOutbound();

      await runtime.proposeWorkflow(
        run1,
        makeStandardSpec({
          runId: run1,
          specId: "spec-a2-1",
          sessionId: "s9-conv",
          criterionDescription: "Chuẩn hóa NFC chính xác",
          testName: "Suite xử lý đường dẫn tiếng Việt"
        }),
        makeSingleTaskWorkflow("Chuẩn hóa NFC chính xác"),
        3
      );
      await runtime.tick();

      const r1AfterPropose = (await runtime.inspect(run1)) as Record<string, unknown>;
      if (r1AfterPropose.status === "awaiting_approval" && r1AfterPropose.approval) {
        const approval = r1AfterPropose.approval as { approvalId: string };
        await runtime.receiveHerdr(
          RoleMessageSchema.parse({
            schema_version: 2,
            message_id: "msg-approve-a2-1",
            correlation_id: "corr-a2-1",
            run_id: run1,
            sender: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
            recipient: { role: "coordinator" },
            type: "approval.decision",
            payload: ApprovalDecisionSchema.parse({
              schemaVersion: 2,
              decisionId: "dec-a2-1",
              approvalId: approval.approvalId,
              runId: run1,
              decision: "approved",
              decidedBy: "user-1",
              decidedAt: now.toISOString(),
              provenance: { origin: "user", authenticatedUser: true, userId: "user-1", paneId: "pane-conversation", channel: "herdr_attach" },
              idempotencyKey: "idemp-dec-a2-1"
            }),
            artifact_references: [],
            occurred_at: now.toISOString(),
            idempotency_key: "idemp-approve-a2-1"
          })
        );
      }
      await runtime.tick();

      const state1 = (await runtime.inspect()) as {
        outbound: Array<{ message: { message_id: string; type: string; run_id?: string }; handle?: { target: { paneId?: string } } }>;
      };
      const devOut1 = state1.outbound.find(o => o.message.run_id === run1 && o.message.type === "task.assignment")!;
      const devBinding1 = (await panes.getRoleBinding(devOut1.handle!.target.paneId!)).value!;
      await writeFile(join(devBinding1.worktreePath!, "test/path-handler.test.js"), "// red test\n", "utf8");
      git(devBinding1.worktreePath!, "add", "test/path-handler.test.js");
      git(devBinding1.worktreePath!, "commit", "-m", "red commit");
      const head1 = git(devBinding1.worktreePath!, "rev-parse", "HEAD");

      await runtime.requestPhaseVerification(devBinding1, run1, "implement", "red", head1);
      await runtime.flushOutbound();

      // QA stops its turn without recording evidence -> unmeasuredPolicyPhaseRequests -> coordinator_continuation
      const qaBinding = (await panes.getRoleBinding("qa")).value!;
      now = new Date(Date.now() + 1_000);
      await runtime.specialistTurnStopped(qaBinding, "qa", now.toISOString());
      await runtime.flushOutbound();

      const afterStop1 = (await runtime.inspect()) as {
        runs: Array<Record<string, unknown>>;
        outbound: Array<Record<string, unknown>>;
      };
      const rawRun1 = afterStop1.runs.find(r => r.runId === run1)!;
      expect(rawRun1.status).toBe("implementing");
      expect(unmeasuredPolicyPhaseRequests(afterStop1 as never, rawRun1 as never)).toHaveLength(1);
      const pending1 = rawRun1.pendingAction as { actionId: string; kind: string; state: string };
      expect(pending1.kind).toBe("coordinator_continuation");
      expect(pending1.state).toBe("pending");

      // Web/Interaction view enables `resume`
      const actions1 = availableActions(rawRun1 as never, afterStop1 as never, [], true, true);
      expect(actions1.find(a => a.kind === "resume")?.enabled).toBe(true);

      // CoordinatorTools.invoke("resume_run") with null optional field (`messageId: null`)
      const resumeRes1 = (await tools.invoke(
        "resume_run",
        { runId: run1, actionId: pending1.actionId, messageId: null },
        { role: "coordinator" }
      )) as { queued: boolean; actionId: string };
      expect(resumeRes1.queued).toBe(true);
      await runtime.flushOutbound();

      const afterCoordResume = (await runtime.inspect()) as {
        runs: Array<Record<string, unknown>>;
        outbound: Array<{ message: { message_id: string; type: string; run_id?: string; payload: Record<string, unknown> }; status: string }>;
      };
      expect(afterCoordResume.runs.find(r => r.runId === run1)!.status).toBe("implementing");
      const retryNotice = afterCoordResume.outbound.find(
        o =>
          o.message.run_id === run1 &&
          o.message.payload.kind === "policy_phase_outcome" &&
          o.message.payload.status === "retry"
      );
      expect(retryNotice?.status).toBe("accepted");

      // Developer can now re-request verification for the exact same revision and get a fresh QA request!
      const freshQa = (await runtime.requestPhaseVerification(devBinding1, run1, "implement", "red", head1)) as {
        queued: boolean;
        messageId: string;
      };
      expect(freshQa.queued).toBe(true);
      await runtime.flushOutbound();
      const afterFreshQa = (await runtime.inspect()) as {
        outbound: Array<{ message: { message_id: string }; status: string }>;
      };
      expect(afterFreshQa.outbound.find(o => o.message.message_id === freshQa.messageId)?.status).toBe("accepted");
      // Release run1's QA slot so Part 2 can independently lease `qa-agent` for post-submission alternative verification:
      now = new Date(Math.max(now.getTime(), Date.now()) + 50_000);
      await runtime.flushOutbound();

      // --- Part 2: Post-submission `automaticAlternativeEvidence` (`not_applicable` docs task) where QA exhausts transport ---
      await mkdir(join(repoPath, "docs"), { recursive: true });
      await writeFile(join(repoPath, "docs/guide.md"), "# Hướng dẫn\n", "utf8");
      git(repoPath, "add", "docs/guide.md");
      git(repoPath, "commit", "-m", "add docs guide");

      await runtime.receiveHerdr(
        RoleMessageSchema.parse({
          schema_version: 2,
          message_id: "msg-intake-a2-2",
          correlation_id: "corr-a2-2",
          run_id: "run-a2-2",
          sender: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
          recipient: { role: "coordinator" },
          type: "delegation.request",
          payload: {
            schemaVersion: 2,
            delegationId: "del-a2-2",
            messageId: "msg-intake-a2-2",
            correlationId: "corr-a2-2",
            runId: "run-a2-2",
            sessionId: "s9-conv",
            requestedBy: "conversation",
            targetRole: "coordinator",
            title: "Cập nhật tài liệu hướng dẫn",
            objective: "Bổ sung hướng dẫn tiếng Việt vào docs/guide.md",
            specificationId: "spec-a2-2",
            sddLevel: "lightweight",
            acceptanceCriteria: [
              {
                id: "ac-1",
                description: "Tài liệu hướng dẫn tiếng Việt rõ ràng",
                category: "functional",
                verificationMethod: "manual_review",
                required: true,
                status: "pending",
                evidenceArtifactIds: []
              }
            ],
            inputArtifacts: [],
            priority: "normal",
            requestedAt: now.toISOString(),
            idempotencyKey: "idemp-a2-2"
          },
          artifact_references: [],
          occurred_at: now.toISOString(),
          idempotency_key: "idemp-intake-a2-2"
        })
      );
      const run2 = "run-a2-2";
      await runtime.flushOutbound();

      const docsSpec = {
        schemaVersion: 2 as const,
        specId: "spec-a2-2",
        runId: run2,
        sessionId: "s9-conv",
        level: "lightweight" as const,
        title: "Cập nhật tài liệu hướng dẫn",
        summary: "Bổ sung hướng dẫn tiếng Việt vào docs/guide.md",
        problemStatement: "Thiếu hướng dẫn tiếng Việt",
        scope: { inScope: ["docs/guide.md"], outOfScope: ["src/"] },
        acceptanceCriteria: [
          {
            id: "ac-1",
            description: "Tài liệu hướng dẫn tiếng Việt rõ ràng",
            category: "functional" as const,
            verificationMethod: "manual_review" as const,
            required: true,
            status: "pending" as const,
            evidenceArtifactIds: []
          }
        ],
        affectedPaths: ["docs/guide.md"],
        complexity: "trivial" as const,
        riskLevel: "low" as const,
        version: 1,
        traceabilityTaskIds: ["implement"],
        status: "draft" as const,
        createdBy: "coordinator",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        metadata: {
          sdd: {
            policyVersion: 1,
            assessment: {
              kind: "documentation",
              behaviorChange: false,
              modules: ["docs"],
              securityImpact: false,
              publicApiImpact: false,
              dataSchemaImpact: false,
              architectureImpact: false,
              migrationRequired: false,
              risk: "low",
              unresolvedQuestions: []
            },
            functionalRequirements: [],
            technicalConstraints: [],
            apiDataContracts: [],
            risksAndTradeoffs: [],
            traceability: [{ criterionId: "ac-1", taskIds: ["implement"] }]
          },
          conditionalTdd: {
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
              commands: []
            },
            testability: {
              level: "none",
              rationale: "Documentation content clarity requires human/QA review"
            },
            riskClassification: "low",
            conventions: {
              tdd: "contextual",
              requiredMethods: [],
              suggestedLevels: []
            }
          }
        }
      };

      await runtime.proposeWorkflow(
        run2,
        docsSpec,
        makeSingleTaskWorkflow("Tài liệu hướng dẫn tiếng Việt rõ ràng", ["docs/guide.md"]),
        3
      );
      await runtime.tick();

      const state2 = (await runtime.inspect()) as {
        outbound: Array<{
          message: { message_id: string; type: string; run_id?: string };
          handle?: {
            requestId: string;
            attemptId: string;
            executionId: string;
            correlation: Record<string, unknown>;
            target: { paneId?: string; agentId: string };
          };
        }>;
      };
      const devOut2 = state2.outbound.find(o => o.message.run_id === run2 && o.message.type === "task.assignment")!;
      const devBinding2 = (await panes.getRoleBinding(devOut2.handle!.target.paneId!)).value!;
      await writeFile(join(devBinding2.worktreePath!, "docs/guide.md"), "# Hướng dẫn\n\nNội dung chi tiết.\n", "utf8");
      git(devBinding2.worktreePath!, "add", "docs/guide.md");
      git(devBinding2.worktreePath!, "commit", "-m", "update docs guide");

      await runtime.receiveHerdr(
        RoleMessageSchema.parse({
          schema_version: 2,
          message_id: "msg-dev-submit-a2-2",
          correlation_id: "corr-a2-2",
          causation_id: devOut2.message.message_id,
          run_id: run2,
          sender: { role: "developer", agent_id: devBinding2.agentId, pane_id: devBinding2.paneId },
          recipient: { role: "coordinator" },
          type: "implementation.submitted",
          payload: {
            requestId: devOut2.handle!.requestId,
            attemptId: devOut2.handle!.attemptId,
            runId: run2,
            taskId: "implement",
            executionId: devOut2.handle!.executionId,
            status: "succeeded",
            verification: {
              status: "verified",
              evidence: "Đã cập nhật docs/guide.md",
              correlation: devOut2.handle!.correlation
            },
            output: { summary: "Đã cập nhật docs/guide.md" },
            artifactProposals: [],
            retryable: false,
            startedAt: now.toISOString(),
            completedAt: now.toISOString()
          },
          artifact_references: [],
          occurred_at: now.toISOString(),
          idempotency_key: "idemp-dev-submit-a2-2"
        })
      );
      await runtime.flushOutbound();

      // Advance clock >= 45s past `acceptedAt` while QA pane is prompt-ready without recording alternative evidence -> `flushOutbound()` releases `alternative-...`
      // AND MUST immediately surface `run.pendingAction` (`coordinator_continuation`) without needing any extra transaction!
      now = new Date(Math.max(now.getTime(), Date.now()) + 50_000);
      await runtime.flushOutbound();

      const afterTransportFail = (await runtime.inspect()) as {
        runs: Array<Record<string, unknown>>;
        outbound: Array<{ message: { message_id: string; type: string; run_id?: string }; status: string }>;
      };
      const rawRun2 = afterTransportFail.runs.find(r => r.runId === run2)!;
      expect(rawRun2.status).toBe("implementing");
      const pending2 = rawRun2.pendingAction as { actionId: string; kind: string; state: string };
      expect(pending2).toBeDefined();
      expect(pending2.kind).toBe("coordinator_continuation");
      expect(pending2.state).toBe("pending");
      expect(availableActions(rawRun2 as never, afterTransportFail as never, [], true, true).find(a => a.kind === "resume")?.enabled).toBe(true);

      // Trigger Web `resume` -> preserves `"implementing"` and enqueues + delivers a fresh QA `alternative-...` request!
      const webCmd2 = WebCommandSchema.parse({
        apiVersion: 1,
        projectId: "proj-s9-a2",
        kind: "resume",
        commandId: "22222222-2222-4222-8222-222222222222",
        runId: run2,
        actionId: pending2.actionId,
        expectedVersion: actionVersion(rawRun2 as never, "resume")
      });
      await runtime.resumeBlockedRun(run2, pending2.actionId, { webCommand: webCmd2 });
      await runtime.flushOutbound();

      const afterWebResume2 = (await runtime.inspect()) as {
        runs: Array<Record<string, unknown>>;
        outbound: Array<{ message: { message_id: string; type: string; run_id?: string; payload: Record<string, unknown> }; status: string }>;
      };
      expect(afterWebResume2.runs.find(r => r.runId === run2)!.status).toBe("implementing");
      const freshAltRequests = afterWebResume2.outbound.filter(
        o =>
          o.message.run_id === run2 &&
          o.message.type === "verification.requested" &&
          o.message.payload.kind === "conditional_evidence" &&
          o.status === "accepted"
      );
      expect(freshAltRequests).toHaveLength(1);
    }, 120_000);
  });

  describe("Seam B — Cancellation & Vanished/Bare-Shell/Reused Panes (Slice 3 <-> Slice 2 <-> Slice 6 <-> Slice 8 <-> Slice 4 <-> Slice 1)", () => {
    it("B1: cancels cleanly to 'cancelled' when specialist pane w1:pE dropped to bare shell AND Developer pane w2:p2 was reused from a prior released task", async () => {
      const root = await createTempDir("bflow-s9-seam-b1-");
      const repoPath = join(root, "repo");
      await initGitRepo(repoPath);

      let now = new Date("2026-10-31T14:00:00.000Z");
      const promptFile = join(root, "role-prompt.md");
      await writeFile(promptFile, "# Role Instructions\nFollow Bflow v3 rules.\n", "utf8");

      //Stateful fake Herdr CLI + Socket runner wired to REAL `createHerdrAdapter` + REAL `createRolePaneManager` + `FileSessionManifestStore`!
      const workspacesMap = new Map<string, { id: string; label: string; activeTabId: string }>();
      const tabsMap = new Map<string, { id: string; wsId: string; label: string }>();
      const panesMap = new Map<string, { id: string; wsId: string; tabId: string; cwd: string; agent: string | null }>();
      const agentsMap = new Map<
        string,
        { name: string; kind: string; paneId: string; status: string; sessionId: string; interactiveReady: boolean }
      >();
      let reusedDevPaneNext = false;
      let wsSeq = 0;
      let tabSeq = 0;
      let paneSeq = 0;

      const flag = (args: readonly string[], key: string): string | undefined => {
        const idx = args.indexOf(key);
        return idx >= 0 ? args[idx + 1] : undefined;
      };

      const reply = (result: Record<string, unknown>): CommandOutcome => ({
        exitCode: 0,
        stdout: JSON.stringify({ id: "1", result }),
        stderr: ""
      });
      const fail = (code: string, message: string): CommandOutcome => ({
        exitCode: 1,
        stdout: "",
        stderr: JSON.stringify({ id: "1", error: { code, message } })
      });

      const paneIdsForRoles = ["w1:pA", "w1:pB", "w1:pQ", "w1:pE"];
      let rolePaneCursor = 0;

      const nextPaneId = (forWorktreeRoot = false): string => {
        if (!forWorktreeRoot && rolePaneCursor < paneIdsForRoles.length) {
          return paneIdsForRoles[rolePaneCursor++]!;
        }
        if (forWorktreeRoot) {
          return `w2:pRoot-${++paneSeq}`;
        }
        if (reusedDevPaneNext || !panesMap.has("w2:p2")) {
          reusedDevPaneNext = false;
          return "w2:p2";
        }
        return `w2:p${++paneSeq + 2}`;
      };

      const workspaceJson = (id: string) => {
        const ws = workspacesMap.get(id)!;
        return {
          workspace_id: id,
          label: ws.label,
          active_tab_id: ws.activeTabId,
          focused: false,
          pane_count: [...panesMap.values()].filter(p => p.wsId === id).length,
          tab_count: [...tabsMap.values()].filter(t => t.wsId === id).length,
          agent_status: "idle",
          number: 1
        };
      };
      const tabJson = (id: string) => {
        const t = tabsMap.get(id)!;
        return {
          tab_id: id,
          workspace_id: t.wsId,
          number: 1,
          label: t.label,
          focused: false,
          pane_count: [...panesMap.values()].filter(p => p.tabId === id).length,
          agent_status: "idle"
        };
      };
      const paneJson = (id: string) => {
        const p = panesMap.get(id)!;
        return {
          pane_id: p.id,
          terminal_id: `term-${p.id}`,
          workspace_id: p.wsId,
          tab_id: p.tabId,
          focused: false,
          agent: p.agent,
          agent_status: "idle",
          revision: 1,
          cwd: p.cwd
        };
      };
      const createWs = (cwd: string, label: string, forWorktree = false) => {
        const wsId = `w${++wsSeq}`;
        const tabId = `t${++tabSeq}`;
        const paneId = nextPaneId(forWorktree);
        workspacesMap.set(wsId, { id: wsId, label, activeTabId: tabId });
        tabsMap.set(tabId, { id: tabId, wsId, label: "1" });
        panesMap.set(paneId, { id: paneId, wsId, tabId, cwd, agent: null });
        return {
          type: "workspace_created",
          workspace: workspaceJson(wsId),
          tab: tabJson(tabId),
          root_pane: paneJson(paneId)
        };
      };
      const createTab = (wsId: string, cwd: string, label: string) => {
        const tabId = `t${++tabSeq}`;
        const paneId = nextPaneId(false);
        tabsMap.set(tabId, { id: tabId, wsId, label });
        panesMap.set(paneId, { id: paneId, wsId, tabId, cwd, agent: null });
        return {
          type: "tab_created",
          tab: tabJson(tabId),
          root_pane: paneJson(paneId)
        };
      };

      const agentInfoJson = (a: {
        name: string;
        kind: string;
        paneId: string;
        status: string;
        sessionId: string;
        interactiveReady: boolean;
      }) => {
        const p = panesMap.get(a.paneId)!;
        const sess = { source: "herdr:claude", kind: "id" as const, value: a.sessionId };
        return {
          name: a.name,
          agent: a.kind,
          pane_id: a.paneId,
          terminal_id: `term-${a.paneId}`,
          workspace_id: p.wsId,
          tab_id: p.tabId,
          focused: false,
          agent_status: a.status,
          revision: 1,
          cwd: p.cwd,
          interactive_ready: a.interactiveReady,
          launch_pending: false,
          session: sess,
          agent_session: sess
        };
      };

      const herdrRunner = {
        async run(inv: CommandInvocation): Promise<CommandOutcome> {
          const [domain, action, ...rest] = inv.args;
          if (domain === "--version") {
            return { exitCode: 0, stdout: "herdr 0.9.5\n", stderr: "" };
          }
          if (domain === "api" && action === "schema") {
            return { exitCode: 0, stdout: "protocol: 22\nschema_version: 1\n", stderr: "" };
          }
          if (domain === "system" && action === "capabilities") {
            return reply({
              type: "capabilities",
              version: "0.9.5",
              protocol_version: 22,
              supported_agents: ["claude"],
              features: ["agent_wait", "pane_process_info"]
            });
          }
          if (domain === "workspace" && action === "list") {
            return reply({ type: "workspace_list", workspaces: [...workspacesMap.keys()].map(workspaceJson) });
          }
          if (domain === "workspace" && action === "create") {
            return reply(createWs(flag(rest, "--cwd") ?? repoPath, flag(rest, "--label") ?? "ws", false));
          }
          if (domain === "workspace" && action === "focus") {
            return workspacesMap.has(rest[0]!)
              ? reply({ type: "workspace_info", workspace: workspaceJson(rest[0]!) })
              : fail("workspace_not_found", "workspace_not_found");
          }
          if (domain === "tab" && action === "create") {
            return reply(createTab(flag(rest, "--workspace")!, flag(rest, "--cwd") ?? repoPath, flag(rest, "--label") ?? "tab"));
          }
          if (domain === "tab" && action === "list") {
            const ws = flag(rest, "--workspace");
            return reply({
              type: "tab_list",
              tabs: [...tabsMap.keys()].filter(id => !ws || tabsMap.get(id)!.wsId === ws).map(tabJson)
            });
          }
          if (domain === "tab" && (action === "focus" || action === "rename")) {
            return tabsMap.has(rest[0]!)
              ? reply({ type: "tab_info", tab: tabJson(rest[0]!) })
              : reply({ type: "tab_info", tab: { tab_id: rest[0] ?? "t1" } });
          }
          if (domain === "pane" && action === "split") {
            const src = panesMap.get(rest[0]!);
            if (!src) return fail("pane_not_found", `pane ${rest[0]} not found`);
            const paneId = nextPaneId(false);
            const cwd = flag(rest, "--cwd") ?? src.cwd;
            panesMap.set(paneId, { id: paneId, wsId: src.wsId, tabId: src.tabId, cwd, agent: null });
            return reply({ type: "pane_info", pane: paneJson(paneId) });
          }
          if (domain === "pane" && action === "list") {
            const ws = flag(rest, "--workspace");
            const list = [...panesMap.values()].filter(p => !ws || p.wsId === ws).map(p => paneJson(p.id));
            return reply({ type: "pane_list", panes: list });
          }
          if (domain === "pane" && action === "layout") {
            const targetId = flag(rest, "--pane") ?? rest[0]!;
            const p = panesMap.get(targetId);
            if (!p) return fail("pane_not_found", `pane ${targetId} not found`);
            const siblings = [...panesMap.values()].filter(x => x.tabId === p.tabId);
            return reply({
              type: "pane_layout",
              layout: {
                workspace_id: p.wsId,
                tab_id: p.tabId,
                panes: siblings.map((s, idx) => ({ pane_id: s.id, rect: { x: idx * 40, y: 0, width: 40, height: 40 } })),
                splits: []
              }
            });
          }
          if (domain === "pane" && (action === "get" || action === "focus" || action === "rename")) {
            const p = panesMap.get(rest[0]!);
            if (!p) return fail("pane_not_found", `pane ${rest[0]} not found`);
            return reply({ type: "pane_info", pane: paneJson(p.id) });
          }
          if (domain === "pane" && action === "close") {
            const id = rest[0]!;
            panesMap.delete(id);
            for (const [aName, a] of agentsMap) if (a.paneId === id) agentsMap.delete(aName);
            return reply({ type: "ok" });
          }
          if (domain === "pane" && action === "process-info") {
            const id = flag(rest, "--pane") ?? rest[0]!;
            const p = panesMap.get(id);
            if (!p) return fail("pane_not_found", `pane ${id} not found`);
            return reply({
              type: "pane_process_info",
              process_info: {
                pane_id: id,
                shell_pid: 4242,
                foreground_process_group_id: 4242,
                foreground_processes: p.agent ? [{ pid: 4300, command: "claude" }] : []
              }
            });
          }
          if (domain === "worktree" && (action === "create" || action === "open")) {
            const wtPath = flag(rest, "--path")!;
            const label = flag(rest, "--label") ?? wtPath;
            const created = createWs(wtPath, label, true);
            const wsId = (created.workspace as { workspace_id: string }).workspace_id;
            return reply({
              ...created,
              type: action === "create" ? "worktree_created" : "worktree_opened",
              worktree: {
                path: wtPath,
                label,
                branch: flag(rest, "--branch") ?? null,
                is_linked_worktree: true,
                is_detached: false,
                is_bare: false,
                is_prunable: false,
                open_workspace_id: wsId
              }
            });
          }
          if (domain === "agent" && action === "start") {
            const name = rest[0]!;
            const paneId = flag(rest, "--pane")!;
            const p = panesMap.get(paneId);
            if (!p) return fail("pane_not_found", `pane ${paneId} not found`);
            const kind = flag(rest, "--kind") ?? "claude";
            p.agent = kind;
            const sessionId = `sess-${name}`;
            const entry = { name, kind, paneId, status: "idle", sessionId, interactiveReady: true };
            agentsMap.set(name, entry);
            return reply({
              type: "agent_started",
              argv: [],
              agent: agentInfoJson(entry)
            });
          }
          if (domain === "agent" && action === "list") {
            return reply({
              type: "agent_list",
              agents: [...agentsMap.values()].map(agentInfoJson)
            });
          }
          if (domain === "agent" && (action === "get" || action === "status" || action === "focus")) {
            const target = rest[0]!;
            const a = agentsMap.get(target) ?? [...agentsMap.values()].find(x => x.paneId === target);
            if (!a) return { exitCode: 1, stdout: "", stderr: `error: agent target ${target} not found` };
            const info = agentInfoJson(a);
            return reply(action === "status" ? { type: "agent_status", status: info, agent: info } : { type: "agent_info", agent: info });
          }
          if (domain === "agent" && (action === "send" || action === "prompt")) {
            const target = rest[0]!;
            const a = agentsMap.get(target) ?? [...agentsMap.values()].find(x => x.paneId === target);
            if (!a) return { exitCode: 1, stdout: "", stderr: `error: agent target ${target} not found` };
            a.status = "working";
            const info = agentInfoJson(a);
            if (action === "prompt") {
              return reply({ type: "agent_prompted", agent: info });
            }
            return reply({
              type: "agent_sent",
              pane_id: a.paneId,
              agent: a.kind,
              agent_status: "working",
              submitted: true,
              delivery_id: `deliv-${Date.now()}`
            });
          }
          if (domain === "agent" && (action === "interrupt" || action === "send-keys")) {
            const target = rest[0]!;
            const a = agentsMap.get(target) ?? [...agentsMap.values()].find(x => x.paneId === target);
            if (!a) return { exitCode: 1, stdout: "", stderr: `error: agent target ${target} not found` };
            a.status = "idle";
            return reply({ type: "ok", pane_id: a.paneId, interrupted: true });
          }
          if (domain === "agent" && action === "wait") {
            const target = rest[0]!;
            const a = agentsMap.get(target) ?? [...agentsMap.values()].find(x => x.paneId === target);
            if (!a) return { exitCode: 1, stdout: "", stderr: `error: agent target ${target} not found` };
            const info = { ...agentInfoJson(a), revision: 2 };
            return reply({
              type: "agent_wait_completed",
              matched: a.status,
              elapsed_ms: 5,
              agent: info,
              status: info
            });
          }
          return fail("unsupported", `unsupported command: ${inv.args.join(" ")}`);
        }
      };

      const herdrSocket: HerdrSocketPort = {
        async request<T>(method: string, params?: Readonly<Record<string, unknown>>) {
          if (method === "workspace.create") {
            return {
              ok: true as const,
              value: createWs(String(params?.["cwd"] ?? repoPath), String(params?.["label"] ?? "ws"), false) as unknown as T
            };
          }
          if (method === "tab.create") {
            return {
              ok: true as const,
              value: createTab(
                String(params?.["workspace_id"] ?? ""),
                String(params?.["cwd"] ?? repoPath),
                String(params?.["label"] ?? "tab")
              ) as unknown as T
            };
          }
          if (method === "pane.split") {
            const srcPaneId = String(params?.["target_pane_id"] ?? params?.["pane_id"] ?? "");
            const cwd = typeof params?.["cwd"] === "string" ? params["cwd"] : undefined;
            const out = await herdrRunner.run({
              executable: "herdr",
              args: ["pane", "split", srcPaneId, ...(cwd ? ["--cwd", cwd] : [])]
            });
            if (out.exitCode !== 0) {
              return { ok: false as const, error: { code: "not_found" as const, retryable: false, message: out.stderr } };
            }
            const parsed = JSON.parse(out.stdout) as { result: T };
            return { ok: true as const, value: parsed.result };
          }
          if (method === "worktree.create" || method === "worktree.open") {
            const action = method === "worktree.create" ? "create" : "open";
            const wtPath = String(params?.["path"] ?? params?.["cwd"] ?? "");
            const out = await herdrRunner.run({
              executable: "herdr",
              args: ["worktree", action, "--path", wtPath]
            });
            const parsed = JSON.parse(out.stdout) as { result: T };
            return { ok: true as const, value: parsed.result };
          }
          if (method === "agent.start") {
            const name = String(params?.["name"] ?? "");
            const paneId = String(params?.["pane_id"] ?? "");
            const kind = String(params?.["agent"] ?? "claude");
            const out = await herdrRunner.run({
              executable: "herdr",
              args: ["agent", "start", name, "--pane", paneId, "--kind", kind]
            });
            const parsed = JSON.parse(out.stdout) as { result: T };
            return { ok: true as const, value: parsed.result };
          }
          return {
            ok: false as const,
            error: { code: "unsupported" as const, retryable: false, message: `socket unsupported ${method}` }
          };
        }
      };

      const chatPrompt = (await readBuiltinRolePrompt("chat"))!.source;
      const coordPrompt = (await readBuiltinRolePrompt("coordinator"))!.source;
      const analystPrompt = (await readBuiltinRolePrompt("analyst"))!.source;
      const qaPrompt = (await readBuiltinRolePrompt("qa-verifier"))!.source;
      const devPrompt = (await readBuiltinRolePrompt("developer"))!.source;

      const makeLaunch = (id: string, sourceFile: string): AgentLaunchProfile => ({
        provider: "claude",
        launchId: id,
        launchFingerprint: `fp-${id}`,
        env: { BFLOW_LAUNCH_ID: id },
        argv: ["--append-system-prompt-file", sourceFile]
      });

      const manifestPath = join(repoPath, ".bflow/state/session.json");
      const manifestStore = new FileSessionManifestStore(manifestPath);
      const cleanInspector: WorktreeInspector = {
        async inspect(wtPath: string): Promise<{ ok: true; value: WorktreeCleanlinessResult }> {
          if (!existsSync(wtPath)) return { ok: true, value: { exists: false, isClean: true, dirtyFiles: [] } };
          const status = git(wtPath, "status", "--porcelain=v1", "--untracked-files=normal");
          const dirty = status ? status.split("\n").filter(Boolean) : [];
          return { ok: true, value: { exists: true, isClean: dirty.length === 0, dirtyFiles: dirty } };
        }
      };

      const paneManager = createRolePaneManager({
        config: {
          sessionId: "s9-seam-b",
          projectName: "slice09-seam-b",
          workspaceRoot: repoPath,
          defaultAgentKind: "claude",
          maxDeveloperCapacity: 2,
          permanentRoles: ["chat", "coordinator", "analyst", "qa-verifier"],
          roleConfigs: {
            chat: { agentKind: "claude", launch: makeLaunch("l-chat", chatPrompt) },
            coordinator: { agentKind: "claude", launch: makeLaunch("l-coord", coordPrompt) },
            analyst: { agentKind: "claude", launch: makeLaunch("l-spec", analystPrompt) },
            "qa-verifier": { agentKind: "claude", launch: makeLaunch("l-qa", qaPrompt) },
            developer: { agentKind: "claude", launch: makeLaunch("l-dev", devPrompt) }
          }
        },
        runner: herdrRunner,
        socket: herdrSocket,
        store: manifestStore,
        worktreeInspector: cleanInspector
      });

      unwrap(await paneManager.initializeTopology());
      const specifierBinding = unwrap(await paneManager.getRoleBinding("specifier"))!;
      expect(specifierBinding.paneId).toBe("w1:pE");

      // Step 1: Allocate a prior Developer task on `w2:p2` and release it, leaving a historical `"released"` `w2:p2` binding in SessionManifest!
      const priorWt = join(repoPath, ".bflow/state/worktrees/prior-task");
      await mkdir(priorWt, { recursive: true });
      const priorAlloc = unwrap(
        await paneManager.allocateDeveloper({
          taskId: "prior-run-task-0",
          worktreePath: priorWt,
          launch: makeLaunch("l-dev-prior", devPrompt)
        })
      );
      expect(priorAlloc.paneId).toBe("w2:p2");
      unwrap(await paneManager.releaseDeveloper({ taskId: "prior-run-task-0", closePane: false, removeWorktree: false }));
      const manifestAfterPriorRelease = unwrap(await paneManager.getManifest())!;
      const releasedPriorBinding = manifestAfterPriorRelease.panes.find(p => p.bindingId === priorAlloc.bindingId)!;
      expect(releasedPriorBinding.metadata?.allocationStatus).toBe("released");
      panesMap.delete("w2:p2");
      agentsMap.delete(priorAlloc.agentId);
      await rm(priorWt, { recursive: true, force: true });

      // Tell fake Herdr to reuse pane ID `w2:p2` on the next Developer split!
      reusedDevPaneNext = true;
      const hostPanesProxy = new Proxy(paneManager, {
        get(target, prop, receiver) {
          if (prop === "allocateDeveloper") {
            return (req: Parameters<typeof paneManager.allocateDeveloper>[0]) =>
              target.allocateDeveloper({
                ...req,
                launch: req.launch ?? makeLaunch(`l-dev-${req.taskId}`, devPrompt)
              });
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === "function" ? val.bind(target) : val;
        }
      });

      // Wire REAL `HerdrCliTransport` (`createHerdrAdapter`), `FileAgentRegistry`, `openSqliteRunStore`, `GitOrchestrator`, and `AgenticWorkflowRuntime`!
      const herdrTransport = createHerdrAdapter({
        runner: herdrRunner,
        clock: () => now
      });
      // For correlated stop proof on live `w2:p2` while preserving REAL `HerdrCliTransport.wait` `not_found` for bare-shell `w1:pE`:
      const realWait = herdrTransport.wait.bind(herdrTransport);
      const transportProxy = new Proxy(herdrTransport, {
        get(target, prop, receiver) {
          if (prop === "wait") {
            return async (handle: Parameters<typeof realWait>[0], options?: Parameters<typeof realWait>[1]) => {
              const res = await realWait(handle, options);
              if (!res.ok) return res;
              if (handle.target.paneId === "w2:p2" && res.value.state === "idle") {
                return {
                  ok: true as const,
                  value: { ...res.value, handle, correlationVerified: true, observedAt: now.toISOString() }
                };
              }
              return res;
            };
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === "function" ? val.bind(target) : val;
        }
      });

      const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => now });
      const engine = new DeterministicWorkflowEngine();
      const dbDir = join(repoPath, ".bflow/state/agentic");
      await mkdir(dbDir, { recursive: true });
      const runStore = unwrap(openSqliteRunStore({ filename: join(dbDir, "runs.db") }));
      cleanups.push(() => {
        runStore.close();
      });
      const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "s9-a1" }));
      cleanups.push(() => {
        artifacts.close();
      });
      let runtime!: AgenticWorkflowRuntime;
      const { checks: b1Checks, gates: b1Gates } = makeDefaultVerificationChecks();
      const policies = await loadAgenticPolicies({
        repositoryPath: repoPath,
        artifactStore: artifacts,
        worktreeRoot: join(repoPath, ".bflow/state/worktrees"),
        gates: b1Gates,
        loadSpecification: id => runtime.loadSpecification(id),
        authorizeApprover: () => true,
        clock: () => now
      });

      runtime = new AgenticWorkflowRuntime(
        {
          engine,
          registry,
          transport: transportProxy,
          runStore,
          artifactStore: artifacts,
          panes: hostPanesProxy,
          policies,
          deliverToConversation: async () => undefined,
          taskChecks: b1Checks,
          workflowChecks: b1Checks,
          roleCapabilities: {
            conversation: ["conversation"],
            coordinator: ["coordination", "specification", "planning", "repository.read"],
            specifier: ["specification", "repository.read"],
            developer: ["implementation"],
            qa: ["verification", "testing", "repository.read"],
            reviewer: ["review", "repository.read"]
          },
          preflightRoleCapabilities: async () => undefined,
          authenticateMessage: async () => true,
          authenticateResult: async () => true,
          authenticateEvidence: async () => true,
          authenticateGateResult: async () => true,
          authorizeHuman: async () => true,
          clock: () => now
        },
        { journalDirectory: join(root, "journal"), repositoryPath: repoPath }
      );

      // Start Run B1, dispatch BOTH a `specifier` specialist on `w1:pE` AND a Developer task reusing `w2:p2`!
      const chatBindingB1 = unwrap(await paneManager.getRoleBinding("conversation"))!;
      const manifestB1 = unwrap(await paneManager.getManifest())!;
      await runtime.receiveHerdr(
        RoleMessageSchema.parse({
          schema_version: 2,
          message_id: "msg-intake-b1",
          correlation_id: "corr-b1",
          run_id: "run-b1",
          sender: { role: "conversation", agent_id: chatBindingB1.agentId, pane_id: chatBindingB1.paneId },
          recipient: { role: "coordinator" },
          type: "delegation.request",
          payload: {
            schemaVersion: 2,
            delegationId: "del-b1",
            messageId: "msg-intake-b1",
            correlationId: "corr-b1",
            runId: "run-b1",
            sessionId: manifestB1.conversationSessionId,
            requestedBy: "conversation",
            targetRole: "coordinator",
            title: "Kiểm thử hủy run trên pane tái sử dụng",
            objective: "Xác nhận hủy run giải phóng sạch worktree và lease",
            specificationId: "spec-b1",
            sddLevel: "lightweight",
            acceptanceCriteria: [
              {
                id: "ac-1",
                description: "Xử lý hủy run sạch sẽ",
                category: "functional",
                verificationMethod: "unit_test",
                required: true,
                status: "pending",
                evidenceArtifactIds: []
              }
            ],
            inputArtifacts: [],
            priority: "normal",
            requestedAt: now.toISOString(),
            idempotencyKey: "idemp-b1"
          },
          artifact_references: [],
          occurred_at: now.toISOString(),
          idempotency_key: "idemp-intake-b1"
        })
      );
      const runId = "run-b1";
      await runtime.flushOutbound();

      // Dispatch specialist on `w1:pE`
      await runtime.requestSpecialist(runId, "specifier", "Khảo sát yêu cầu trước khi hủy", ["specification"]);
      await runtime.flushOutbound();

      // Propose workflow & approve design so Developer allocates on reused pane `w2:p2`!
      await runtime.proposeWorkflow(
        runId,
        makeStandardSpec({
          runId,
          specId: "spec-b1",
          sessionId: manifestB1.conversationSessionId,
          criterionDescription: "Xử lý hủy run sạch sẽ",
          testName: "Suite xử lý đường dẫn tiếng Việt"
        }),
        makeSingleTaskWorkflow("Xử lý hủy run sạch sẽ"),
        3
      );
      await runtime.tick();

      const afterProposal = (await runtime.inspect(runId)) as Record<string, unknown>;
      if (afterProposal.status === "awaiting_approval" && afterProposal.approval) {
        const approval = afterProposal.approval as { approvalId: string };
        await runtime.receiveHerdr(
          RoleMessageSchema.parse({
            schema_version: 2,
            message_id: "msg-approve-b1",
            correlation_id: "corr-b1",
            run_id: runId,
            sender: { role: "conversation", agent_id: chatBindingB1.agentId, pane_id: chatBindingB1.paneId },
            recipient: { role: "coordinator" },
            type: "approval.decision",
            payload: ApprovalDecisionSchema.parse({
              schemaVersion: 2,
              decisionId: "dec-b1",
              approvalId: approval.approvalId,
              runId,
              decision: "approved",
              decidedBy: "user-1",
              decidedAt: now.toISOString(),
              provenance: { origin: "user", authenticatedUser: true, userId: "user-1", paneId: "w1:pA", channel: "herdr_attach" },
              idempotencyKey: "idemp-dec-b1"
            }),
            artifact_references: [],
            occurred_at: now.toISOString(),
            idempotency_key: "idemp-approve-b1"
          })
        );
      }
      await runtime.tick();

      // Verify `SessionManifest` cleanly replaced the prior `"released"` `w2:p2` binding with the new `"active"` `w2:p2` binding
      // (preserving `SessionManifestSchema`'s unique-`paneId` invariant), AND `getRoleBinding` / `inspectRoleHealth` select the ACTIVE occupant!
      const manifestNow = unwrap(await paneManager.getManifest())!;
      const w2p2Bindings = manifestNow.panes.filter(p => p.paneId === "w2:p2");
      expect(w2p2Bindings).toHaveLength(1);
      expect(w2p2Bindings[0]!.agentId).not.toBe(priorAlloc.agentId);
      expect(w2p2Bindings[0]!.metadata?.allocationStatus).toBe("active");

      const selectedByPaneId = unwrap(await paneManager.getRoleBinding("w2:p2"))!;
      expect(selectedByPaneId.bindingId).toBe(w2p2Bindings[0]!.bindingId);
      expect(selectedByPaneId.metadata?.allocationStatus).toBe("active");
      const selectedByRole = unwrap(await paneManager.getRoleBinding("developer"))!;
      expect(selectedByRole.bindingId).toBe(w2p2Bindings[0]!.bindingId);
      const healthByPaneId = unwrap(await paneManager.inspectRoleHealth("w2:p2"));
      expect(healthByPaneId.status).toBe("working");
      expect(healthByPaneId.occupantMatches).toBe(true);
      expect(healthByPaneId.agentId).toBe(w2p2Bindings[0]!.agentId);

      // Now simulate specialist pane `w1:pE` dropping to a bare shell AND advance clock past lease TTL (>5m) to exercise expired-TTL stop path!
      const specPane = panesMap.get("w1:pE")!;
      specPane.agent = null;
      for (const [name, agent] of agentsMap) {
        if (agent.paneId === "w1:pE") agentsMap.delete(name);
      }
      now = new Date(now.getTime() + 360_000);

      // Cancel run and reconcile via CLI `executeCancellationReconciliation`!
      await runtime.cancel(runId, "Người dùng yêu cầu hủy run");
      const report = await executeCancellationReconciliation(runId, {
        cwd: repoPath,
        reconcileCancellation: id => runtime.reconcileCancellation(id)
      });

      expect(report.runId).toBe(runId);
      expect(report.fullyStopped).toBe(true);
      expect(report.blockers).toEqual([]);
      expect(report.retainedWorktrees).toEqual([selectedByPaneId.worktreePath!]);
      expect(unwrap(await engine.getSnapshot(runId))!.status).toBe("cancelled");

      // Verify `observeAuthoritativeRuntime` (`bflow status`)!
      // Slice 8 retains cancelled worktrees for inspection, and Slice 1 surfaces lingering clean worktrees until operator cleanup:
      const finalManifest = unwrap(await paneManager.getManifest());
      const observationBeforeCleanup = await observeAuthoritativeRuntime({
        repositoryRoot: repoPath,
        sessionName: "s9-seam-b",
        server: "running",
        manifest: finalManifest
      });
      expect(observationBeforeCleanup.activeRuns).toEqual([]);
      expect(observationBeforeCleanup.activeRunsCheck.status).toBe("pass");
      expect(observationBeforeCleanup.managedWorktrees).toEqual([
        expect.objectContaining({ path: selectedByPaneId.worktreePath!, dirty: false })
      ]);
      expect(observationBeforeCleanup.managedWorktreesCheck.status).toBe("warning");

      await rm(selectedByPaneId.worktreePath!, { recursive: true, force: true });
      const observation = await observeAuthoritativeRuntime({
        repositoryRoot: repoPath,
        sessionName: "s9-seam-b",
        server: "running",
        manifest: finalManifest
      });
      expect(observation.activeRuns).toEqual([]);
      expect(observation.activeRunsCheck.status).toBe("pass");
      expect(observation.managedWorktrees).toEqual([]);
      expect(observation.managedWorktreesCheck.status).toBe("pass");
    });
  });

  describe("Seam C — Full End-to-End Agentic SDLC Flow Under Real-World Hostile Inputs", () => {
    it("C1: completes full multi-package SDLC flow under flat-schema null/empty fields, NFC vs NFD Vietnamese identities, nested Vitest/TAP skips+ANSI Red assertion, task handover binding checks, and Git worktree integration", async () => {
      const root = await createTempDir("bflow-s9-seam-c1-");
      const repoPath = join(root, "repo");
      await initGitRepo(repoPath);

      const now = new Date();
      const nfcCriterion = "Xử lý đường dẫn tiếng Việt chuẩn NFC và loại bỏ khoảng trắng thừa";
      const nfdCriterion = nfcCriterion.normalize("NFD");
      const nfcTestTitle = "Suite > xử lý đường dẫn tiếng Việt";
      const nfdTestTitle = nfcTestTitle.normalize("NFD");
      expect(nfcCriterion).not.toBe(nfdCriterion);
      expect(nfcTestTitle).not.toBe(nfdTestTitle);

      // 0. Verify NFC vs NFD `"Việc #1"` alias resolution in `ChatDecisionSchema` + `resolveChatDecision` AND behavioral parsers!
      const flatStatusDecision = ChatDecisionSchema.parse({
        intent: "status_query",
        directReply: "",
        clarifyingQuestions: [],
        requirementDraft: null,
        cancellationInput: null,
        targetRunId: "Vie\u0323\u0302c #1",
        targetCorrelationId: ""
      });
      const resolvedAlias = resolveChatDecision(flatStatusDecision, {
        session: {
          sessionId: "s9-conv",
          herdrSessionName: "s9-session",
          projectRoot: repoPath,
          createdAt: now.toISOString(),
          lastActiveAt: now.toISOString(),
          turnCount: 1
        },
        recentTurns: [],
        pendingClarifications: {},
        pendingApprovals: {},
        workflows: {
          "corr-1": {
            correlationId: "corr-1",
            sessionId: "s9-conv",
            runId: "run-existing-1",
            title: "Chuẩn hóa tiếng Việt",
            sdlcStatus: "implementing",
            updatedAt: now.toISOString()
          }
        },
        runShortIds: { "việc #1": "run-existing-1" }
      });
      expect(resolvedAlias.ok).toBe(true);
      if (resolvedAlias.ok) {
        expect(resolvedAlias.value.targetRunId).toBe("run-existing-1");
      }

      // Direct hostile parser verification: nested `describe`/`it`, NFD vs NFC Vietnamese titles,
      // `@testing-library/dom`-style ANSI-colored Red assertion failure, AND sibling `it.skip` / `describe.todo`!
      const vitestFile = join(repoPath, "test/path-handler.test.js");
      const ansiTestingLibFailure =
        "\u001b[31mTestingLibraryElementError: Unable to find an accessible element with the role \"heading\" and name `Đường dẫn tiếng Việt`\u001b[39m\n    at Object.getElementError (/node_modules/@testing-library/dom/dist/config.js:37:19)";
      const vitestRedReport = {
        numTotalTestSuites: 3,
        numPassedTestSuites: 0,
        numFailedTestSuites: 2,
        numPendingTestSuites: 1,
        numTotalTests: 3,
        numPassedTests: 0,
        numFailedTests: 1,
        numPendingTests: 1,
        numTodoTests: 1,
        startTime: 1730386800000,
        success: false,
        snapshot: { failure: false, didUpdate: false },
        testResults: [
          {
            name: vitestFile,
            status: "failed",
            startTime: 1730386800000,
            endTime: 1730386800050,
            message: "",
            assertionResults: [
              {
                ancestorTitles: ["Suite"],
                title: "xử lý đường dẫn tiếng Việt".normalize("NFC"),
                fullName: "Suite " + "xử lý đường dẫn tiếng Việt".normalize("NFC"),
                status: "failed",
                failureMessages: [ansiTestingLibFailure]
              },
              {
                ancestorTitles: ["Suite"],
                title: "bỏ qua trường hợp phụ",
                fullName: "Suite bỏ qua trường hợp phụ",
                status: "skipped",
                failureMessages: []
              },
              {
                ancestorTitles: ["Suite", "Tương lai"],
                title: "todo kiểm thử mở rộng",
                fullName: "Suite Tương lai todo kiểm thử mở rộng",
                status: "todo",
                failureMessages: []
              }
            ]
          }
        ]
      };
      const parsedVitestRed = parseVitestJson(
        {
          executable: process.execPath,
          args: ["vitest"],
          cwd: repoPath,
          exitCode: 1,
          signal: null,
          stdout: JSON.stringify(vitestRedReport),
          stderr: "BFLOW_VITEST_RUNTIME_ERRORS=0\n",
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          durationMs: 50
        },
        [nfdTestTitle],
        true
      );
      expect(parsedVitestRed.targetFailure).toBe(true);
      expect(parsedVitestRed.failed).toBe(1);
      expect(parsedVitestRed.testNames).toEqual([nfdTestTitle]);

      const tapSubtestOutput = [
        "TAP version 13",
        "# Subtest: Suite",
        `    # Subtest: ${"xử lý đường dẫn tiếng Việt".normalize("NFC")}`,
        `    not ok 1 - ${"xử lý đường dẫn tiếng Việt".normalize("NFC")}`,
        "      ---",
        "      duration_ms: 2.1",
        "      failureType: 'testCodeFailure'",
        "      error: 'Unable to find an element with text: Việt Nam'",
        "      code: 'ERR_TEST_FAILURE'",
        "      name: 'TestingLibraryElementError'",
        "      stack: |-",
        "        Object.getElementError (node_modules/@testing-library/dom/dist/config.js:37:19)",
        "      ...",
        "    # Subtest: sibling skip",
        "    ok 2 - sibling skip # SKIP",
        "    # Subtest: sibling todo",
        "    ok 3 - sibling todo # TODO",
        "    1..3",
        "not ok 1 - Suite",
        "  ---",
        "  duration_ms: 4.0",
        "  type: 'suite'",
        "  failureType: 'subtestsFailed'",
        "  error: '1 subtest failed'",
        "  code: 'ERR_TEST_FAILURE'",
        "  ...",
        "1..1",
        "# tests 3",
        "# suites 1",
        "# pass 0",
        "# fail 1",
        "# cancelled 0",
        "# skipped 1",
        "# todo 1",
        "# duration_ms 8.5",
        ""
      ].join("\n");
      const parsedTapRed = parseNodeTap(
        {
          executable: process.execPath,
          args: ["--test"],
          cwd: repoPath,
          exitCode: 1,
          signal: null,
          stdout: tapSubtestOutput,
          stderr: "",
          timedOut: false,
          aborted: false,
          outputTruncated: false,
          durationMs: 10
        },
        [nfdTestTitle],
        true
      );
      expect(parsedTapRed.targetFailure).toBe(true);
      expect(parsedTapRed.testNames).toEqual([nfdTestTitle]);
      expect(
        resolveExpectedIdentities(
          [{ ancestors: ["Suite"], title: "xử lý đường dẫn tiếng Việt".normalize("NFC"), rawName: nfcTestTitle }],
          [nfdTestTitle]
        )
      ).toEqual({ matched: true, canonicalNames: [nfdTestTitle] });

      // 1. Wire FULL multi-package SDLC stack:
      //    HostConversationIntake + createAgenticConversationHost + AgenticWorkflowRuntime + HostVerification +
      //    SpecificationEngine + TestStrategyResolver + TaskHandoverStore + GitOrchestrator (real Git worktrees)!
      const ownerCommands = parseBehavioralCommands([
        {
          id: "unit",
          command: "owner:unit",
          executable: process.execPath,
          args: ["--test", "--test-reporter=tap", "test/path-handler.test.js"],
          method: "unit_test",
          levels: ["unit", "regression"],
          testNames: [nfdTestTitle],
          testPaths: ["test/path-handler.test.js"],
          reporter: "node_tap",
          timeoutMs: 30_000
        }
      ]);

      const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => new Date() });
      const engine = new DeterministicWorkflowEngine();
      const transport = new FakeAgentTransport();
      const panes = new MemoryPanePolicy(repoPath);
      const runStore = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
      cleanups.push(() => {
        runStore.close();
      });
      const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "s9-a1" }));
      cleanups.push(() => {
        artifacts.close();
      });
      const handoverStore = new TaskHandoverStore(join(root, "handovers"));
      const receipts = new HostReceiptJournal(join(root, "receipts"), repoPath, "s9-session");

      const reviewerCheckDef = QualityGateDefinitionSchema.parse({
        id: "host-reviewer",
        name: "Independent reviewer",
        evaluator: "native-herdr-review",
        required: true,
        timeout: { executionTimeoutMs: 120_000, onTimeout: "block" },
        metadata: { bindAcceptedCriteria: true },
        configuration: { kind: "review", method: "manual_review", criterionIds: [], testNames: [], role: "reviewer", levels: [] }
      });

      let runtimeRef!: AgenticWorkflowRuntime;
      const hostVerification = new HostVerification(
        () => runtimeRef,
        () => artifacts,
        receipts,
        ownerCommands,
        undefined,
        undefined,
        [],
        { suites: [] },
        [reviewerCheckDef]
      );

      // Provide a direct deterministic behavioral gate for task/workflow verification cycles while testing real Git + Reviewer + Handover + Spec + Strategy!
      const behavioralGateDef = behavioralChecks(ownerCommands)[0]!;
      const fastBehavioralGate: QualityGate = {
        id: behavioralGateDef.id,
        evaluate: async raw => {
          const ctx = raw as { runId: string; taskId?: string; attemptId?: string; input?: Record<string, unknown> };
          const input = (ctx.input ?? {}) as Record<string, unknown>;
          const wt = String(input.sourceWorktreePath ?? repoPath);
          const rev = String(input.sourceRevision ?? git(wt, "rev-parse", "HEAD"));
          const content = readFileSync(join(wt, "src/path-handler.js"), "utf8");
          const passed = content.includes('normalize("NFC")');
          const gateResult = QualityGateResultSchema.parse({
            gateId: behavioralGateDef.id,
            runId: ctx.runId,
            ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
            evaluationId: `eval-${createHash("sha256").update(`${ctx.runId}:${ctx.taskId ?? "wf"}:${rev}`).digest("hex").slice(0, 16)}`,
            status: passed ? "passed" : "failed",
            findings: [],
            producedArtifacts: [],
            evaluatedAt: new Date().toISOString(),
            metadata: {
              verification: {
                schemaVersion: 2,
                checkId: behavioralGateDef.id,
                runId: ctx.runId,
                taskId: ctx.taskId,
                attemptId: ctx.attemptId,
                sourceRevision: rev,
                specFingerprint: input.specFingerprint,
                scope: input.scope,
                independentExecution: true,
                isolated: true,
                executorId: "bflow-host-test-runner",
                role: "quality_gate",
                method: "unit_test",
                command: "owner:unit",
                exitCode: passed ? 0 : 1,
                testNames: [nfcTestTitle],
                criteria: [{ criterionId: "ac-1", passed, summary: "1/1 observed tests passed" }],
                summary: "1/1 observed tests passed"
              }
            }
          });
          await receipts.recordGate(gateResult);
          return {
            ok: true as const,
            value: gateResult
          };
        }
      };

      const reviewerGate: QualityGate = {
        id: reviewerCheckDef.id,
        evaluate: (...args) => runtimeRef.herdrQualityGate(reviewerCheckDef.id).evaluate(...args)
      };

      const policies = await loadAgenticPolicies({
        repositoryPath: repoPath,
        artifactStore: artifacts,
        worktreeRoot: join(repoPath, ".bflow/state/worktrees"),
        gates: [fastBehavioralGate, reviewerGate],
        loadSpecification: id => runtimeRef.loadSpecification(id),
        authorizeApprover: () => true,
        clock: () => new Date()
      });

      const deliveredConversationNotices: unknown[] = [];
      let conversationHostRef: Awaited<ReturnType<typeof createAgenticConversationHost>> | undefined;

      runtimeRef = new AgenticWorkflowRuntime(
        {
          engine,
          registry,
          transport,
          runStore,
          artifactStore: artifacts,
          panes,
          policies,
          handoverStore,
          deliverToConversation: async message => {
            deliveredConversationNotices.push(message);
            if (conversationHostRef) {
              await conversationHostRef.receiveRuntime(message);
              await receipts.appendConversationNotice(message);
            }
          },
          taskChecks: [behavioralGateDef, reviewerCheckDef],
          workflowChecks: [behavioralGateDef, reviewerCheckDef],
          authenticateGateResult: result => hostVerification.authenticateGate(result),
          authenticateEvidence: result => hostVerification.authenticateEvidence(result),
          authenticateResult: async () => true,
          authorizeHuman: decision => receipts.authenticateHuman(decision),
          roleCapabilities: {
            conversation: ["conversation"],
            coordinator: ["coordination", "specification", "planning", "repository.read"],
            developer: ["implementation"],
            reviewer: ["review", "repository.read"],
            qa: ["verification", "testing", "repository.read"]
          },
          preflightRoleCapabilities: async () => undefined,
          authenticateMessage: async () => true,
          clock: () => new Date()
        },
        { journalDirectory: join(root, "journal"), repositoryPath: repoPath }
      );
      cleanups.push(() => runtimeRef.quiesce());

      const manifest = (await panes.getManifest()).value;
      const convPaneForReceipts = (await panes.getRoleBinding("conversation")).value!;
      conversationHostRef = await createAgenticConversationHost({
        runtime: runtimeRef,
        manifest,
        contextDirectory: join(root, "conv-context"),
        onHumanDecision: decision =>
          receipts.recordHuman(ApprovalDecisionSchema.parse(decision), {
            origin: "UserPromptSubmit",
            binding: convPaneForReceipts,
            nativeSessionId: convPaneForReceipts.session!.value,
            conversationSessionId: "s9-conv",
            userId: decision.decidedBy,
            messageId: `turn-${decision.approvalId}`,
            promptDigest: createHash("sha256").update("đồng ý").digest("hex")
          }),
        noticeAliases: () => receipts.noticeAliases()
      });

      const intake = new HostConversationIntake(receipts, () => conversationHostRef!);
      const convBinding = (await panes.getRoleBinding("conversation")).value!;

      // Step 2: Authenticated user turn + `conversation_decide` with LLM flat-schema `null`/`""` sibling fields & NFC Vietnamese criteria!
      await intake.receive(convBinding, {
        messageId: "user-turn-c1",
        conversationSessionId: "s9-conv",
        content: "Hãy triển khai chuẩn hóa đường dẫn tiếng Việt chuẩn NFC cho src/path-handler.js (Việc #1)",
        userId: "user-c1"
      });

      const decideRes = (await intake.decide(convBinding, {
        messageId: null,
        decision: {
          intent: "workflow_request",
          directReply: "",
          clarifyingQuestions: [],
          targetRunId: null,
          targetCorrelationId: "",
          cancellationInput: null,
          requirementDraft: {
            title: "Chuẩn hóa đường dẫn tiếng Việt",
            objective: "Chuẩn hóa chuỗi đường dẫn tiếng Việt sang NFC và trim khoảng trắng",
            kind: "bugfix",
            sddLevel: "lightweight",
            priority: null,
            scopeDefined: true,
            isLargeTask: null,
            affectedPaths: ["src/path-handler.js", "test/path-handler.test.js"],
            acceptanceCriteriaDescriptions: null,
            verificationMethods: null,
            acceptanceCriteria: [{ description: nfcCriterion, verificationMethod: "unit_test" }],
            isRequirementChange: null,
            codeChangesAuthorized: null,
            targetRunId: "",
            targetCorrelationId: null,
            investigationTasks: null
          }
        }
      })) as Record<string, unknown>;
      expect(decideRes.ok).toBe(true);
      await runtimeRef.flushOutbound();

      const afterIntake = (await runtimeRef.inspect()) as {
        runs: Array<{ runId: string; delegation: { specificationId: string; sessionId: string } }>;
      };
      expect(afterIntake.runs).toHaveLength(1);
      const runId = afterIntake.runs[0]!.runId;
      const specId = afterIntake.runs[0]!.delegation.specificationId;

      // Step 3: Coordinator `assess` + `propose_workflow` with hostile `null` optional fields AND NFD Vietnamese criterion + NFD mapped test name!
      const baseSpecForC1 = makeStandardSpec({
        runId,
        specId,
        sessionId: "s9-conv",
        criterionDescription: nfdCriterion,
        testName: nfcTestTitle
      });
      const rawSpecWithNullsAndNfd = {
        ...baseSpecForC1,
        architectureNotes: null,
        dataModelChanges: null,
        securityConsiderations: null,
        rollbackPlan: null,
        approvedBy: null,
        artifactRef: null,
        tddDecision: null,
        testStrategy: {
          ...baseSpecForC1.testStrategy,
          coverageThresholdPercent: null,
          metadata: null
        },
        acceptanceCriteria: [
          {
            id: "ac-1",
            description: nfdCriterion,
            category: "functional",
            verificationMethod: "unit_test",
            required: true,
            status: "pending",
            evidenceArtifactIds: [],
            waiverReason: null
          }
        ]
      };

      const rawWorkflowWithNulls = {
        ...makeSingleTaskWorkflow(nfdCriterion),
        description: null,
        metadata: null,
        recovery: {
          checkpoint: "task-boundary",
          eventInterval: null,
          resumeStrategy: "checkpoint-then-replay",
          staleExecution: "reconcile"
        },
        tasks: [
          {
            ...makeSingleTaskWorkflow(nfdCriterion).tasks[0]!,
            description: null,
            roleProfile: null,
            rework: null,
            retry: {
              maxAttempts: 1,
              strategy: "fixed",
              initialDelayMs: 0,
              maxDelayMs: 0,
              multiplier: null,
              jitter: false,
              retryableErrorCodes: null
            },
            timeout: {
              executionTimeoutMs: 120_000,
              heartbeatTimeoutMs: null,
              deadline: null,
              onTimeout: "block"
            }
          }
        ]
      };

      const tools = new CoordinatorTools(runtimeRef);
      const assessed = (await tools.invoke("assess", { specification: rawSpecWithNullsAndNfd }, { role: "coordinator" })) as {
        complexity: string;
        level: string;
      };
      expect(assessed.complexity).toBe("standard");
      expect(assessed.level).toBe("lightweight");

      // Verify `TestStrategyResolver` (`required`), `SpecificationEngine` traceability, AND `HostVerification.assertSupported` with NFD testName & null optionals!
      const normalizedSpec = parseCoordinatorAssessmentInput(rawSpecWithNullsAndNfd);
      const resolver = new TestStrategyResolver();
      const resolvedStrategy = resolver.resolve(normalizedSpec);
      expect(resolvedStrategy.tddDecision.mode).toBe("required");

      const specEngine = new SpecificationEngine({
        artifactStore: artifacts,
        authorizeApprover: () => true
      });
      const specWithStrategy: Specification = SpecificationSchema.parse({
        ...normalizedSpec,
        tddDecision: resolvedStrategy.tddDecision,
        testStrategy: resolvedStrategy
      });
      const draftValidation = specEngine.createDraft(specWithStrategy);
      expect(draftValidation.traceabilityTaskIds).toEqual(["implement"]);

      expect(() =>
        hostVerification.assertSupported(rawSpecWithNullsAndNfd, resolvedStrategy, rawWorkflowWithNulls)
      ).not.toThrow();

      await tools.invoke(
        "propose_workflow",
        {
          runId,
          specification: rawSpecWithNullsAndNfd,
          definition: rawWorkflowWithNulls,
          maxIterations: null
        },
        { role: "coordinator" }
      );
      await runtimeRef.tick();

      // Approve design gate via trusted user turn if awaiting_approval
      const afterPropose = (await runtimeRef.inspect(runId)) as Record<string, unknown>;
      if (afterPropose.status === "awaiting_approval" && afterPropose.approval) {
        const designApproveRes = (await intake.receive(convBinding, {
          messageId: "user-approve-design-c1",
          conversationSessionId: "s9-conv",
          content: "đồng ý",
          userId: "user-c1"
        })) as Record<string, unknown>;
        expect(designApproveRes.requiresConversationDecision).toBe(false);
        await runtimeRef.tick();
      }

      // Step 4: Developer worktree allocated by real `GitOrchestrator`! Test `propose_task_handover` binding mismatch & null optionals!
      const stateDev = (await runtimeRef.inspect()) as {
        outbound: Array<{
          message: { message_id: string; type: string; run_id?: string };
          status: string;
          handle?: {
            requestId: string;
            executionId: string;
            attemptId: string;
            correlation: Record<string, unknown>;
            target: { paneId?: string };
          };
        }>;
      };
      const devAssignment = stateDev.outbound.find(o => o.message.run_id === runId && o.message.type === "task.assignment")!;
      expect(devAssignment.status).toBe("accepted");
      const devBinding = (await panes.getRoleBinding(devAssignment.handle!.target.paneId!)).value!;
      const wtPath = devBinding.worktreePath!;

      const readHandover1 = (await runtimeRef.taskHandover(devBinding, {})) as {
        binding: Record<string, unknown>;
      };
      expect(readHandover1.binding).toBeDefined();

      // Wrong `attemptId` -> actionable `handover_binding_mismatch` naming `attemptId`
      const badHandover = taskHandoverAcknowledgement(
        await runtimeRef.taskHandover(devBinding, {
          runId: null,
          taskId: null,
          proposal: {
            schemaVersion: 1,
            binding: { ...readHandover1.binding, attemptId: "wrong-attempt-id-999" },
            content: {
              nextAction: "Viết kiểm thử Red tiếng Việt",
              decisions: null,
              disprovedHypotheses: null,
              untestedAngles: null,
              references: null
            }
          }
        })
      ) as { handover: { status: string; code: string; reason: string } };
      expect(badHandover.handover.status).toBe("rejected");
      expect(badHandover.handover.code).toBe("handover_binding_mismatch");
      expect(badHandover.handover.reason).toContain("attemptId");

      // Correct binding + `null` optional fields (including `ReworkSourceLocationSchema` `endLine: null, symbol: null`) -> ACCEPTED!
      const goodHandover = taskHandoverAcknowledgement(
        await runtimeRef.taskHandover(devBinding, {
          runId: null,
          taskId: null,
          proposal: {
            schemaVersion: 1,
            binding: readHandover1.binding,
            content: {
              nextAction: "Viết kiểm thử Red tiếng Việt rồi yêu cầu QA đo Red",
              decisions: ["Chuẩn hóa NFC bằng String.prototype.normalize('NFC')"],
              disprovedHypotheses: null,
              untestedAngles: null,
              references: [
                {
                  kind: "source",
                  location: { path: "src/path-handler.js", startLine: 1, endLine: null, symbol: null }
                }
              ]
            }
          }
        })
      ) as { handover: { status: string } };
      expect(goodHandover.handover.status).toBe("accepted");

      // Step 5: Behavioral TDD Red -> Green -> Refactor with real `VerificationResult` receipts validated by `TestStrategyResolver`!
      await writeFile(
        join(wtPath, "test/path-handler.test.js"),
        [
          'import { describe, it } from "node:test";',
          'import assert from "node:assert/strict";',
          'import { normalizeVietnamesePath } from "../src/path-handler.js";',
          'describe("Suite", () => {',
          '  it("placeholder", () => { assert.equal(normalizeVietnamesePath(" a "), "a"); });',
          '  it("xử lý đường dẫn tiếng Việt", () => {',
          '    assert.equal(normalizeVietnamesePath("  Vie\\u0323\\u0302t/Nam  "), "Việt/Nam");',
          "  });",
          '  it.skip("bỏ qua nhánh phụ", () => {});',
          "});",
          ""
        ].join("\n"),
        "utf8"
      );
      git(wtPath, "add", "test/path-handler.test.js");
      git(wtPath, "commit", "-m", "test: add Red test for Vietnamese NFC path normalization");
      const redRev = git(wtPath, "rev-parse", "HEAD");
      const testBlobHash = git(wtPath, "rev-parse", "HEAD:test/path-handler.test.js");

      const qaBinding = (await panes.getRoleBinding("qa")).value!;
      const runPhase = async (phase: "red" | "green" | "refactor", revision: string, passed: boolean) => {
        const req = (await runtimeRef.requestPhaseVerification(devBinding, runId, "implement", phase, revision)) as {
          messageId: string;
        };
        await runtimeRef.flushOutbound();
        const phaseStartedAt = new Date().toISOString();
        const artBytes = Buffer.from(JSON.stringify({ phase, revision, passed }), "utf8");
        const artifactId = `art-${phase}-${revision.slice(0, 8)}`;
        const art = unwrap(
          await artifacts.put({
            options: ArtifactWriteOptionsSchema.parse({
              artifactId,
              runId,
              taskId: "implement",
              kind: "test-result",
              mediaType: "application/json",
              expectedIntegrity: {
                checksum: { algorithm: "sha256", value: createHash("sha256").update(artBytes).digest("hex") },
                sizeBytes: artBytes.length
              },
              idempotencyKey: artifactId
            }),
            content: (async function* () {
              yield artBytes;
            })()
          })
        );
        const phaseCompletedAt = new Date(Math.max(Date.now(), Date.parse(art.createdAt) + 1)).toISOString();
        const inspectedForStrategy = (await runtimeRef.inspect(runId)) as {
          tasks: Array<{ taskId: string; spec: { strategy: { specId: string; tddDecision: { decisionId: string } } } }>;
        };
        const taskStrategy = inspectedForStrategy.tasks.find(t => t.taskId === "implement")!.spec.strategy;
        const verResult = {
          schemaVersion: 2 as const,
          verificationId: `host-behavioral-${phase}-${revision.slice(0, 12)}`,
          runId,
          taskId: "implement",
          cycleNumber: 1,
          attemptId: `attempt-qa-${phase}`,
          status: passed ? ("passed" as const) : ("failed" as const),
          independentExecution: true as const,
          evaluatedCriteria: [
            {
              criterionId: "ac-1",
              passed,
              evidenceArtifactId: art.artifactId,
              command: "owner:unit",
              exitCode: passed ? 0 : 1,
              summary: passed ? "1/1 observed tests passed" : "0/1 observed tests passed"
            }
          ],
          qualityGateResults: [],
          evidenceArtifacts: [art],
          findings: [],
          verifiedBy: "qa" as const,
          startedAt: phaseStartedAt,
          completedAt: phaseCompletedAt,
          metadata: {
            conditionalTdd: {
              phase,
              decisionId: taskStrategy.tddDecision.decisionId,
              specId: taskStrategy.specId,
              sourceRevision: revision,
              testRevision: redRev,
              testNames: [nfdTestTitle],
              ...(phase === "red" ? { failureKind: "target_behavior" } : {}),
              observations: [
                {
                  method: "unit_test",
                  criterionId: "ac-1",
                  evidenceArtifactId: art.artifactId,
                  command: "owner:unit",
                  exitCode: passed ? 0 : 1,
                  summary: passed ? "1/1 observed tests passed" : "0/1 observed tests passed"
                }
              ]
            },
            hostBehavioralMeasurements: [
              {
                commandId: "unit",
                testNames: [nfdTestTitle],
                testBlobs: { "test/path-handler.test.js": testBlobHash }
              }
            ],
            hostVerifierBinding: qaBinding
          }
        };
        await receipts.recordEvidence(verResult as never);
        await runtimeRef.receiveHerdr(
          RoleMessageSchema.parse({
            schema_version: 2,
            message_id: `msg-qa-${phase}`,
            correlation_id: afterIntake.runs[0] ? ((await runtimeRef.inspect(runId)) as { delegation: { correlationId: string } }).delegation.correlationId : "corr-c1",
            causation_id: req.messageId,
            run_id: runId,
            sender: { role: "qa", agent_id: qaBinding.agentId, pane_id: qaBinding.paneId },
            recipient: { role: "coordinator" },
            type: "verification.result",
            payload: verResult,
            artifact_references: [art],
            occurred_at: now.toISOString(),
            idempotency_key: `idemp-qa-${phase}`
          })
        );
        await runtimeRef.flushOutbound();
      };

      await runPhase("red", redRev, false);

      // Authorize implementation after Red
      const authImpl = (await tools.invoke("authorize_implementation", { runId, taskId: "implement" }, { role: "developer" })) as {
        authorized: boolean;
      };
      expect(authImpl.authorized).toBe(true);

      // Implement Green
      await writeFile(
        join(wtPath, "src/path-handler.js"),
        'export function normalizeVietnamesePath(input) {\n  return String(input ?? "").trim().normalize("NFC");\n}\n',
        "utf8"
      );
      git(wtPath, "add", "src/path-handler.js");
      git(wtPath, "commit", "-m", "feat: normalize Vietnamese path to NFC");
      const greenRev = git(wtPath, "rev-parse", "HEAD");
      await runPhase("green", greenRev, true);

      // Refactor commit preserving frozen Red test blob
      await writeFile(
        join(wtPath, "src/path-handler.js"),
        'export function normalizeVietnamesePath(input) {\n  const raw = String(input ?? "").trim();\n  return raw.normalize("NFC");\n}\n',
        "utf8"
      );
      git(wtPath, "add", "src/path-handler.js");
      git(wtPath, "commit", "-m", "refactor: clarify Vietnamese path normalization");
      const refactorRev = git(wtPath, "rev-parse", "HEAD");
      await runPhase("refactor", refactorRev, true);

      // Submit implementation -> triggers Task Verification (behavioral gate + Reviewer `inspectReview` / `completeReview` with null optionals!)
      const runCorrelationId = ((await runtimeRef.inspect(runId)) as { delegation: { correlationId: string } }).delegation.correlationId;
      const submitAt = new Date().toISOString();
      await runtimeRef.receiveHerdr(
        RoleMessageSchema.parse({
          schema_version: 2,
          message_id: "msg-dev-submit-c1",
          correlation_id: runCorrelationId,
          causation_id: devAssignment.message.message_id,
          run_id: runId,
          sender: { role: "developer", agent_id: devBinding.agentId, pane_id: devBinding.paneId },
          recipient: { role: "coordinator" },
          type: "implementation.submitted",
          payload: {
            requestId: devAssignment.handle!.requestId,
            attemptId: devAssignment.handle!.attemptId,
            runId,
            taskId: "implement",
            executionId: devAssignment.handle!.executionId,
            status: "succeeded",
            verification: {
              status: "verified",
              evidence: "Hoàn thành chuẩn hóa NFC cho đường dẫn tiếng Việt",
              correlation: devAssignment.handle!.correlation
            },
            output: { summary: "Hoàn thành chuẩn hóa NFC cho đường dẫn tiếng Việt" },
            artifactProposals: [],
            retryable: false,
            startedAt: now.toISOString(),
            completedAt: submitAt
          },
          artifact_references: [],
          occurred_at: submitAt,
          idempotency_key: "idemp-dev-submit-c1"
        })
      );

      // Reviewer answers `herdrQualityGate("review")` concurrently while `tick()` evaluates task & post-integration workflow verification!
      const reviewerBinding = (await panes.getRoleBinding("reviewer")).value!;
      const answeredReviews = new Set<string>();
      const tickWithConcurrentReviewer = async (tag: string) => {
        let tickDone = false;
        const tickPromise = runtimeRef.tick().finally(() => {
          tickDone = true;
        });
        while (!tickDone) {
          const snap = (await runtimeRef.inspect()) as {
            outbound: Array<{ message: { message_id: string; type: string; run_id?: string; recipient: { role: string } }; status: string }>;
          };
          const pending = snap.outbound.filter(
            o =>
              o.message.run_id === runId &&
              o.message.type === "verification.requested" &&
              o.message.recipient.role === "reviewer" &&
              o.status === "accepted" &&
              !answeredReviews.has(o.message.message_id)
          );
          for (const req of pending) {
            answeredReviews.add(req.message.message_id);
            const inspectedRev = (await hostVerification.inspectReview(reviewerBinding, {
              messageId: req.message.message_id
            })) as { reviewId: string };
            const completed = await hostVerification.completeReview(reviewerBinding, {
              reviewId: inspectedRev.reviewId,
              messageId: req.message.message_id,
              summary: `Đánh giá độc lập đạt yêu cầu (${tag})`,
              criteria: [{ criterionId: "ac-1", passed: true, summary: "Chuẩn hóa NFC hoạt động đúng với đầu vào NFD/NFC" }],
              testIntegrityVerdicts: null,
              findingVerdicts: null,
              findings: null
            });
            await runtimeRef.receiveHerdr(
              RoleMessageSchema.parse({
                schema_version: 2,
                message_id: `msg-rev-verdict-${tag}-${req.message.message_id}`,
                correlation_id: runCorrelationId,
                causation_id: req.message.message_id,
                run_id: runId,
                sender: { role: "reviewer", agent_id: reviewerBinding.agentId, pane_id: reviewerBinding.paneId },
                recipient: { role: "coordinator" },
                type: "review.verdict",
                payload: completed.result,
                artifact_references: [completed.artifact],
                occurred_at: new Date().toISOString(),
                idempotency_key: `idemp-rev-${tag}-${req.message.message_id}`
              })
            );
          }
          if (!tickDone) {
            await new Promise(r => setTimeout(r, 15));
          }
        }
        await tickPromise;
      };

      // 1) Task verification tick -> Reviewer answers task review -> task succeeds!
      await tickWithConcurrentReviewer("task");
      const afterTaskVerify = (await runtimeRef.inspect(runId)) as { status: string; error?: string };
      expect(afterTaskVerify.error).toBeUndefined();
      // 2) Integration + Workflow verification tick -> GitOrchestrator integrates branch & Reviewer answers workflow review!
      await tickWithConcurrentReviewer("workflow");
      await runtimeRef.flushOutbound();
      const afterWfVerify = (await runtimeRef.inspect(runId)) as { status: string; error?: string };
      expect(afterWfVerify.error).toBeUndefined();
      expect(answeredReviews.size).toBeGreaterThanOrEqual(1);

      // Delivery approval gate -> user approves -> run reaches `"completed"`!
      const beforeFinalApproval = (await runtimeRef.inspect(runId)) as { status: string; approval?: { approvalId: string } };
      if (beforeFinalApproval.status === "awaiting_approval" && beforeFinalApproval.approval) {
        const finalApproveRes = (await intake.receive(convBinding, {
          messageId: "user-approve-delivery-c1",
          conversationSessionId: "s9-conv",
          content: "đồng ý",
          userId: "user-c1"
        })) as Record<string, unknown>;
        expect(finalApproveRes.requiresConversationDecision).toBe(false);
        expect(finalApproveRes.approvalFailed).not.toBe(true);
        await runtimeRef.flushOutbound();
        await runtimeRef.tick();
      }

      const finalRun = (await runtimeRef.inspect(runId)) as {
        status: string;
        workflowChange?: { headCommitHash: string };
      };
      expect(finalRun.status).toBe("completed");
      expect(finalRun.workflowChange?.headCommitHash).toMatch(/^[a-f0-9]{40}$/);

      const coreSnap = unwrap(await engine.getSnapshot(runId));
      expect(coreSnap.status).toBe("succeeded");

      for (const notice of deliveredConversationNotices) {
        assertWellFormedUnicode(JSON.stringify(notice));
      }
    }, 120_000);
  });

  describe("Seam D — Global Monorepo Intra-Package ESM Value-Cycle Audit", () => {
    it("D1: verifies 0 intra-package runtime ESM value-import cycles across all 24 workspace packages and apps", () => {
      const pkgRoots: Array<{ id: string; srcDir: string }> = [];
      for (const group of ["packages", "apps"]) {
        const groupDir = join(repoRoot, group);
        for (const name of readdirSync(groupDir).sort()) {
          const pkgDir = join(groupDir, name);
          if (existsSync(join(pkgDir, "package.json"))) {
            pkgRoots.push({ id: `${group}/${name}`, srcDir: join(pkgDir, "src") });
          }
        }
      }
      expect(pkgRoots.length).toBeGreaterThanOrEqual(24);

      const walkTs = (dir: string): string[] => {
        if (!existsSync(dir)) return [];
        const files: string[] = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) files.push(...walkTs(full));
          else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(full);
        }
        return files.sort();
      };

      const resolveRelative = (fromFile: string, specifier: string, fileSet: ReadonlySet<string>): string | null => {
        if (!specifier.startsWith(".")) return null;
        const base = resolve(dirname(fromFile), specifier);
        const candidates = [
          base,
          base.replace(/\.js$/, ".ts"),
          base.replace(/\.js$/, ".tsx"),
          base.replace(/\.jsx$/, ".tsx"),
          `${base}.ts`,
          `${base}.tsx`,
          join(base, "index.ts"),
          join(base, "index.tsx")
        ];
        for (const candidate of candidates) {
          if (fileSet.has(candidate)) return candidate;
        }
        return null;
      };

      const extractValueImports = (filePath: string, fileSet: ReadonlySet<string>): string[] => {
        const sourceText = readFileSync(filePath, "utf8");
        const sf = ts.createSourceFile(
          filePath,
          sourceText,
          ts.ScriptTarget.Latest,
          true,
          filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );
        const edges = new Set<string>();
        for (const stmt of sf.statements) {
          if (ts.isImportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
            const clause = stmt.importClause;
            if (clause) {
              if (clause.isTypeOnly) continue;
              if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
                if (clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(el => el.isTypeOnly)) {
                  continue;
                }
              }
            }
            const target = resolveRelative(filePath, stmt.moduleSpecifier.text, fileSet);
            if (target && target !== filePath) edges.add(target);
          } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
            if (stmt.isTypeOnly) continue;
            if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
              if (stmt.exportClause.elements.length > 0 && stmt.exportClause.elements.every(el => el.isTypeOnly)) {
                continue;
              }
            }
            const target = resolveRelative(filePath, stmt.moduleSpecifier.text, fileSet);
            if (target && target !== filePath) edges.add(target);
          }
        }
        return [...edges];
      };

      const cycles: Array<{ pkg: string; files: string[] }> = [];
      for (const pkg of pkgRoots) {
        const files = walkTs(pkg.srcDir);
        const fileSet = new Set(files);
        const graph = new Map<string, string[]>();
        for (const file of files) {
          graph.set(file, extractValueImports(file, fileSet));
        }

        let index = 0;
        const indices = new Map<string, number>();
        const lowlink = new Map<string, number>();
        const onStack = new Set<string>();
        const stack: string[] = [];

        const strongConnect = (v: string) => {
          indices.set(v, index);
          lowlink.set(v, index);
          index++;
          stack.push(v);
          onStack.add(v);

          for (const w of graph.get(v) ?? []) {
            if (!indices.has(w)) {
              strongConnect(w);
              lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
            } else if (onStack.has(w)) {
              lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
            }
          }

          if (lowlink.get(v) === indices.get(v)) {
            const scc: string[] = [];
            let w: string;
            do {
              w = stack.pop()!;
              onStack.delete(w);
              scc.push(w);
            } while (w !== v);
            if (scc.length > 1) {
              cycles.push({ pkg: pkg.id, files: scc.map(f => relative(repoRoot, f)).sort() });
            }
          }
        };

        for (const file of files) {
          if (!indices.has(file)) strongConnect(file);
        }
      }

      expect(cycles).toEqual([]);
    });
  });
});
