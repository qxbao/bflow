import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirSyncErrorByPath = new Map<string, string>();
const syncDirSyncErrorByFd = new Map<number, string>();

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      const errCode = dirSyncErrorByPath.get(String(args[0]));
      if (errCode) {
        try {
          if (actual.fstatSync(fd).isDirectory()) {
            syncDirSyncErrorByFd.set(fd, errCode);
          }
        } catch {
          // ignore
        }
      }
      return fd;
    }) as typeof actual.openSync,
    closeSync: ((fd: number) => {
      syncDirSyncErrorByFd.delete(fd);
      return actual.closeSync(fd);
    }) as typeof actual.closeSync,
    fsyncSync: ((fd: number) => {
      const errCode = syncDirSyncErrorByFd.get(fd);
      if (errCode) {
        throw Object.assign(new Error(`${errCode}: simulated directory fsync failure`), { code: errCode });
      }
      return actual.fsyncSync(fd);
    }) as typeof actual.fsyncSync
  };
});

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const errCode = dirSyncErrorByPath.get(String(args[0]));
      if (errCode) {
        const st = await handle.stat().catch(() => undefined);
        if (st?.isDirectory()) {
          return new Proxy(handle, {
            get(target, prop, receiver) {
              if (prop === "sync") {
                return async () => {
                  throw Object.assign(new Error(`${errCode}: simulated directory sync failure`), { code: errCode });
                };
              }
              const value = Reflect.get(target, prop, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
          });
        }
      }
      return handle;
    }) as typeof actual.open
  };
});

import {
  PaneBindingSchema,
  RoleMessageSchema,
  VerificationResultSchema,
  type PaneBinding,
  type QualityGate,
  type Specification
} from "@bflow/contracts";
import { webCommandFingerprint } from "@bflow/contracts/web-host";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openSqliteRunStore } from "@bflow/persistence";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { resolvePrivateRuntimeStateDirectory } from "../../src/private-state.js";
import { AgenticJournal } from "../../src/agentic/journal.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { TaskHandoverStore, handoverRevision } from "../../src/agentic/task-handover.js";
import { TaskLogPane } from "../../src/agentic/task-log-pane.js";
import { ChatDeliveryStore } from "../../src/interaction/chat-delivery.js";
import { WebOperationStore } from "../../src/interaction/operation-store.js";
import type { WebInteractionAuthority } from "../../src/interaction/authority.js";
import { contentDigestOf, manifestFiles, publishPackage } from "../../src/handover/publish.js";
import { HANDOVER_EXPORTER_VERSION, type HandoverManifest } from "../../src/handover/schema.js";
import { readExecutionRepositorySnapshot } from "../../src/agentic/execution-binding.js";
import { loadAgenticPolicies, type PanePolicy } from "../../src/agentic/ports.js";
import { availableTools } from "../../src/agentic/host.js";
import { createAgenticConversationHost } from "../../src/agentic/conversation.js";
import { buildDecisionRequestMessage, buildUserDecisionRequest } from "../../src/agentic/decision-routing.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import { draft, workflow } from "../../../specification/test/fixtures.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimeSrcRoot = join(testDir, "../../src");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  dirSyncErrorByPath.clear();
  syncDirSyncErrorByFd.clear();
  vi.restoreAllMocks();
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

async function collectTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await nodeFsPromises.readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collectTsFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

class TestPanes implements PanePolicy {
  busy = new Set<string>();
  missing = new Set<string>();
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
    return {
      ok: true as const,
      value: {
        readyForPrompt: !this.busy.has(p.role),
        occupantMatches: true,
        paneExists: !this.missing.has(p.paneId),
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
    if (binding) binding.metadata = { ...binding.metadata, allocationStatus: "released" };
    return { ok: true as const, value: undefined };
  }
}

function makeWorkflowSpec(runId: string, time: string, tdd = false): { spec: Specification; def: ReturnType<typeof workflow> } {
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

async function createRuntimeFixture(options: { tdd?: boolean } = {}) {
  const root = await nodeFsPromises.realpath(await nodeFsPromises.mkdtemp(join(tmpdir(), "bflow-slice9-")));
  const repository = join(root, "repo");
  await nodeFsPromises.mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test");
  git(repository, "config", "user.email", "test@example.test");
  await nodeFsPromises.writeFile(join(repository, "guide.md"), "initial\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "baseline");

  let timeOffset = 0;
  const clock = () => new Date(Date.now() + timeOffset);
  const store = unwrap(openSqliteRunStore({ filename: join(root, "runs.db") }));
  const artifacts = unwrap(
    await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "slice9", clock: () => clock().getTime() })
  );
  cleanups.push(async () => {
    store.close();
    artifacts.close();
    await nodeFsPromises.rm(root, { recursive: true, force: true });
  });

  const transport = new FakeAgentTransport();
  const panes = new TestPanes();
  const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys: {} });
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
      throw new Error("Quality gates not reached");
    }
  }));
  const ports = {
    engine,
    runStore: store,
    artifactStore: artifacts,
    registry,
    transport,
    panes,
    clock,
    policies: undefined as unknown as Awaited<ReturnType<typeof loadAgenticPolicies>>,
    deliverToConversation: async () => {},
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
        recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" },
        type: "delegation.request",
        payload: delegation,
        artifact_references: [],
        occurred_at: time,
        idempotency_key: intakeId
      })
    );
    await runtime.tick();
    return { spec, def };
  }

  return {
    root,
    repository,
    store,
    artifacts,
    engine,
    registry,
    panes,
    transport,
    runtime,
    tools,
    journalDirectory,
    clock,
    advanceTime: (ms: number) => {
      timeOffset += ms;
    },
    intake
  };
}

describe("Slice 9 (Wave 3) cross-slice integration & glue hardening", () => {
  it("guards all remaining Runtime directory fsync/sync sites against FUSE/NTFS EINVAL while preserving real EIO failures", async () => {
    const root = await nodeFsPromises.realpath(await nodeFsPromises.mkdtemp(join(tmpdir(), "bflow-slice9-fsync-")));
    cleanups.push(async () => {
      await nodeFsPromises.rm(root, { recursive: true, force: true });
    });

    // 1. AgenticJournal
    const journalDir = join(root, "journal");
    await nodeFsPromises.mkdir(journalDir, { recursive: true, mode: 0o700 });
    dirSyncErrorByPath.set(journalDir, "EINVAL");
    const journal = new AgenticJournal(journalDir, root);
    const sampleJournalMsg = (id: string) =>
      RoleMessageSchema.parse({
        schema_version: 2,
        message_id: id,
        correlation_id: "corr-1",
        run_id: "run-1",
        sender: { role: "conversation", agent_id: "conversation", pane_id: "pane-conversation" },
        recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" },
        type: "task.status",
        payload: { status: "working" },
        artifact_references: [],
        occurred_at: "2026-10-31T10:00:00.000Z",
        idempotency_key: id
      });
    await expect(
      journal.exclusive(async (state, save) => {
        state.inbox.push({ message: sampleJournalMsg("m-1"), receivedAt: "2026-10-31T10:00:00.000Z", status: "received" });
        await save();
      })
    ).resolves.toBeUndefined();
    dirSyncErrorByPath.set(journalDir, "EIO");
    await expect(
      journal.exclusive(async (state, save) => {
        state.inbox.push({ message: sampleJournalMsg("m-2"), receivedAt: "2026-10-31T10:00:01.000Z", status: "received" });
        await save();
      })
    ).rejects.toThrow(/EIO/);
    dirSyncErrorByPath.delete(journalDir);

    // 2. HostReceiptJournal
    const receiptDir = join(root, "receipts");
    await nodeFsPromises.mkdir(receiptDir, { recursive: true, mode: 0o700 });
    dirSyncErrorByPath.set(receiptDir, "EINVAL");
    const receipts = new HostReceiptJournal(receiptDir, root, "session-1");
    const coordPaneSample = new TestPanes().bindings.find(b => b.role === "coordinator")!;
    await expect(receipts.recordCoordinatorBoundary(coordPaneSample)).resolves.toBeUndefined();

    // 3. TaskHandoverStore
    const handoverDir = join(root, "handovers");
    await nodeFsPromises.mkdir(handoverDir, { recursive: true, mode: 0o700 });
    dirSyncErrorByPath.set(handoverDir, "EINVAL");
    const handovers = new TaskHandoverStore(handoverDir);
    await expect(
      handovers.write({
        schemaVersion: 1,
        binding: {
          runId: "run-1",
          taskId: "task-1",
          assignmentId: "assign-1",
          attempt: 1,
          attemptId: "attempt-1",
          generation: 0,
          reworkGeneration: 0,
          worktreePath: root,
          revision: "a".repeat(40),
          specId: "spec-1",
          specVersion: 1,
          specFingerprint: "b".repeat(64),
          requirementFingerprint: "c".repeat(64)
        },
        content: {
          nextAction: "Verify green tests",
          decisions: [],
          disprovedHypotheses: [],
          untestedAngles: [],
          references: []
        }
      })
    ).resolves.toBeUndefined();

    // 4. TaskLogPane receipt persistence
    const paneStateDir = join(root, "pane-log-state");
    await nodeFsPromises.mkdir(paneStateDir, { recursive: true, mode: 0o700 });
    dirSyncErrorByPath.set(paneStateDir, "EINVAL");
    const logPane = new TaskLogPane({
      directory: paneStateDir,
      repositoryPath: root,
      sessionId: "session-1",
      logPath: join(root, "activity.jsonl"),
      herdr: async (args: string[]) => {
        if (args[0] === "tab" && args[1] === "create") {
          return JSON.stringify({ result: { tab_id: "tab-log", pane_id: "pane-log", terminal_id: "term-log" } });
        }
        if (args[0] === "pane" && args[1] === "list") {
          return JSON.stringify({
            result: {
              panes: [{ pane_id: "pane-log", tab_id: "tab-log", terminal_id: "term-log", process_name: "node", command: "task-log-viewer" }]
            }
          });
        }
        return JSON.stringify({ result: { ok: true } });
      }
    });
    // Trigger receipt write via ensure; even if viewer readiness settles later, directory EINVAL must never fail saveReceipt.
    await expect((logPane as any).saveReceipt({
      version: 1,
      repositoryPath: root,
      sessionId: "session-1",
      workspaceId: "ws-1",
      phase: "tab_create_intent"
    })).resolves.toBeUndefined();

    // 5. ChatDeliveryStore
    const chatDir = join(root, "chat-delivery");
    await nodeFsPromises.mkdir(chatDir, { recursive: true, mode: 0o700 });
    dirSyncErrorByPath.set(chatDir, "EINVAL");
    const chatStore = new ChatDeliveryStore(chatDir, "proj-1", "session-1");
    const msgId = randomUUID();
    await expect(
      chatStore.write({
        version: 1,
        projectId: "proj-1",
        hostSessionId: "session-1",
        sequence: 1,
        principalId: "principal-1",
        input: { apiVersion: 1, projectId: "proj-1", sessionId: "conv-1", messageId: msgId, content: "Xin chào" },
        nonce: randomUUID(),
        nativeSessionId: "native-1",
        paneId: "pane-chat",
        message: {
          apiVersion: 1,
          messageId: msgId,
          sessionId: "conv-1",
          sender: "user",
          content: "Xin chào",
          createdAt: "2026-10-31T10:00:00.000Z",
          delivery: "queued",
          source: "web"
        },
        echoObserved: false,
        admitted: true,
        state: "queued",
        approvalContext: []
      })
    ).resolves.toBeUndefined();

    // 6. WebOperationStore
    const webOpDir = join(root, "web-ops");
    await nodeFsPromises.mkdir(webOpDir, { recursive: true, mode: 0o700 });
    dirSyncErrorByPath.set(webOpDir, "EINVAL");
    const webStore = new WebOperationStore({
      directory: webOpDir,
      repository: root,
      sessionId: "session-1",
      projectId: "proj-1"
    });
    const cmdId = randomUUID();
    const webCmd = {
      apiVersion: 1 as const,
      commandId: cmdId,
      projectId: "proj-1",
      kind: "cancel" as const,
      runId: "run-1",
      expectedVersion: { revisionToken: "rev-1" },
      reason: "stop"
    };
    const fakeAuthority = {
      verify: (_cmd: unknown, principal: any) => principal
    } as unknown as WebInteractionAuthority;
    await expect(
      webStore.accept(
        webCmd,
        {
          schemaVersion: 1,
          source: "local_web",
          issuerId: "issuer-1",
          keyId: "key-1",
          principalId: "principal-1",
          browserSessionId: "browser-1",
          projectId: "proj-1",
          hostSessionId: "session-1",
          capability: "user_interaction",
          commandId: cmdId,
          commandDigest: webCommandFingerprint(webCmd),
          issuedAt: "2026-10-31T10:00:00.000Z",
          expiresAt: "2026-10-31T10:00:30.000Z",
          nonce: randomUUID(),
          signature: { algorithm: "ed25519", value: Buffer.alloc(64, 7).toString("base64") }
        },
        fakeAuthority
      )
    ).resolves.toMatchObject({ operationId: cmdId, state: "accepted" });

    // 7. Handover package publishPackage
    const exportParent = join(root, "exports");
    await nodeFsPromises.mkdir(exportParent, { recursive: true, mode: 0o700 });
    dirSyncErrorByPath.set(exportParent, "EINVAL");
    const pkgBytes = Buffer.from("hello handover\n", "utf8");
    const pkgFiles = [{ path: "handover.md", bytes: pkgBytes, mediaType: "text/markdown" }];
    const manifestEntries = manifestFiles(pkgFiles) as HandoverManifest["files"];
    const pkgManifest: HandoverManifest = {
      schemaVersion: 1,
      format: "bflow.handover.manifest",
      status: "partial",
      snapshot: {
        runId: "run-1",
        snapshotId: createHash("sha256").update("snap-1").digest("hex"),
        integratedRevision: null
      },
      contentDigest: contentDigestOf(manifestEntries),
      files: manifestEntries,
      sources: [],
      exporter: { name: "bflow-handover", version: HANDOVER_EXPORTER_VERSION },
      exportedAt: "2026-10-31T10:00:00.000Z"
    };
    await expect(publishPackage(join(exportParent, "pkg-1"), pkgFiles, pkgManifest)).resolves.toBeUndefined();

    // 8. resolvePrivateRuntimeStateDirectory (pinLocation synchronous fsyncSync on .bflow/state)
    const repoSimulatedFuse = join(root, "fuse-repo");
    const stateHome = join(root, "xdg-state");
    await nodeFsPromises.mkdir(join(repoSimulatedFuse, ".bflow", "state"), { recursive: true, mode: 0o777 });
    await nodeFsPromises.mkdir(stateHome, { recursive: true, mode: 0o700 });
    // Force external private state relocation by pre-creating the deterministic external directory
    const canonicalFuseRepo = nodeFs.realpathSync(repoSimulatedFuse);
    const repoHash = createHash("sha256").update(canonicalFuseRepo).digest("hex");
    const externalState = join(stateHome, "bflow", "repositories", repoHash, "state");
    await nodeFsPromises.mkdir(externalState, { recursive: true, mode: 0o700 });
    dirSyncErrorByPath.set(join(canonicalFuseRepo, ".bflow", "state"), "EINVAL");
    const prevXdg = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    try {
      expect(resolvePrivateRuntimeStateDirectory(canonicalFuseRepo)).toBe(externalState);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prevXdg;
    }
  });

  it("applies runtimeGitDirectoryFlags across execution-binding, task-handover, and ports.git.treeOf on 0777 fuseblk & isolated HOME", async () => {
    const root = await nodeFsPromises.realpath(await nodeFsPromises.mkdtemp(join(tmpdir(), "bflow-slice9-git-")));
    const isolatedHome = join(root, "isolated-home");
    const repo = join(root, "repo");
    const linkedWt = join(root, "linked-wt");
    await nodeFsPromises.mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    await nodeFsPromises.mkdir(repo, { recursive: true, mode: 0o755 });
    cleanups.push(async () => {
      await nodeFsPromises.rm(root, { recursive: true, force: true });
    });

    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.test");
    // Leave core.fileMode=true in repo config while chmodding tracked files and .git/HEAD to 0777 (simulating fuseblk mount)
    git(repo, "config", "core.fileMode", "true");
    await nodeFsPromises.writeFile(join(repo, "README.md"), "clean file\n", { mode: 0o644 });
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "init");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "worktree", "add", "-b", "task-branch", linkedWt, "HEAD");

    // Simulate fuseblk mount forcing executable bits on non-executable files & Git metadata
    await nodeFsPromises.chmod(join(repo, "README.md"), 0o777);
    await nodeFsPromises.chmod(join(repo, ".git", "HEAD"), 0o777);
    await nodeFsPromises.chmod(join(linkedWt, "README.md"), 0o777);
    await nodeFsPromises.chmod(join(linkedWt, ".git"), 0o777);

    // Hostile global gitconfig in isolated HOME that clears safe.directory unless explicitly overridden per invocation
    await nodeFsPromises.writeFile(join(isolatedHome, ".gitconfig"), "[safe]\n\tdirectory =\n", "utf8");

    const prevHome = process.env.HOME;
    process.env.HOME = isolatedHome;
    try {
      const snapshot = await readExecutionRepositorySnapshot(repo);
      expect(snapshot.revision).toBe(head);
      // Must NOT falsely treat chmod 0777 README.md as dirty when .git/HEAD also has 0777 fuseblk mode bits!
      expect(Object.keys(snapshot.dirtyDigests)).toEqual(["@git-index"]);

      await expect(handoverRevision(linkedWt)).resolves.toBe(head);

      const artifacts = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "slice9-git" }));
      try {
        const policies = await loadAgenticPolicies({
          repositoryPath: repo,
          artifactStore: artifacts,
          gates: [],
          loadSpecification: () => undefined,
          authorizeApprover: () => true
        });
        const tree = await policies.git.treeOf(head);
        expect(tree).toMatch(/^[a-f0-9]{40}$/);
      } finally {
        artifacts.close();
      }
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("eliminates all Function('specifier', 'return import(specifier)') VM-breaking calls and restricts lazy import() to Darwin sandbox + daemon host startup", async () => {
    const files = await collectTsFiles(runtimeSrcRoot);
    const allowedLazyImportFiles = new Set([
      "agentic/behavioral-sandbox.ts",
      "agentic/sandbox-readiness.ts",
      // Daemon-only startup modules remain lazy so short-lived `node host.js hook` CLI subprocesses stay <100ms
      "agentic/host.ts",
      "agentic/workspace.ts",
      "agentic/conversation.ts"
    ]);
    const vmBypassOffenders: string[] = [];
    const unexpectedLazyOffenders: string[] = [];
    for (const file of files) {
      const rel = relative(runtimeSrcRoot, file).replaceAll("\\", "/");
      const source = await nodeFsPromises.readFile(file, "utf8");
      if (/Function\s*\(\s*["']specifier["']/.test(source)) {
        vmBypassOffenders.push(rel);
      }
      if (/\bawait\s+import\s*\(/.test(source) && !allowedLazyImportFiles.has(rel)) {
        unexpectedLazyOffenders.push(rel);
      }
    }
    expect(vmBypassOffenders).toEqual([]);
    expect(unexpectedLazyOffenders).toEqual([]);
  });

  it("aligns conversation_decide MCP tool JSON Schema with Slice 4 ChatDecisionSchema (clarify maxItems: 8 + targetRunId)", () => {
    const tool = availableTools("conversation").find(item => item.name === "conversation_decide");
    expect(tool).toBeDefined();
    const variants = (tool!.inputSchema as any).properties.decision.oneOf as any[];
    const clarify = variants.find(v => v.properties?.intent?.const === "clarify");
    expect(clarify).toBeDefined();
    expect(clarify.properties.clarifyingQuestions.maxItems).toBe(8);
    expect(clarify.properties.targetRunId).toEqual({ type: "string", minLength: 1 });
    expect(clarify.properties.targetCorrelationId).toEqual({ type: "string", minLength: 1 });
  });

  it("renews both QA verifier and waiting Developer leases during long host behavioral measurements (>5 minutes)", async () => {
    const fx = await createRuntimeFixture({ tdd: true });
    const { spec, def } = await fx.intake("run-tdd-heartbeat");
    await fx.runtime.proposeWorkflow("run-tdd-heartbeat", spec, def);
    await fx.runtime.tick();

    const state1 = await fx.runtime.inspect();
    const run1 = (state1.runs as any[])[0]!;
    if (run1.approval && !run1.decision) {
      await fx.runtime.applyHumanDecision({
        schemaVersion: 2,
        decisionId: "dec-1",
        approvalId: run1.approval.approvalId,
        runId: "run-tdd-heartbeat",
        status: "approved",
        decidedBy: "human-1",
        decidedAt: fx.clock().toISOString(),
        idempotencyKey: "dec-1"
      });
      await fx.runtime.tick();
    }

    const devPane = fx.panes.bindings.find(b => b.role === "developer")!;
    // Commit a failing test file in the Developer worktree so Red phase revision differs from baseline
    await nodeFsPromises.writeFile(join(devPane.cwd, "guide.md"), "red test draft\n", "utf8");
    git(devPane.cwd, "add", "guide.md");
    git(devPane.cwd, "commit", "-m", "red test");
    const devHead = git(devPane.cwd, "rev-parse", "HEAD");

    // Request independent Red verification
    await fx.runtime.requestPhaseVerification(devPane, "run-tdd-heartbeat", "implement", "red", devHead);
    await fx.runtime.tick();

    const state2 = await fx.runtime.inspect();
    const qaReq = (state2.outbound as any[]).find(
      o => o.message.type === "verification.requested" && o.message.payload?.kind === "conditional_evidence"
    );
    expect(qaReq).toBeDefined();
    const assignedVerifierPane = fx.panes.bindings.find(b => b.paneId === qaReq.handle.target.paneId)!;
    // QA is actively executing record_behavioral_verification in its pane turn (readyForPrompt: false)
    fx.panes.busy.add(assignedVerifierPane.role);

    // Simulate an 8-minute host behavioral measurement with lease heartbeats (surpassing the 5-minute 300_000ms initial lease TTL
    // even when no scheduler tick runs for 4 minutes at a time!)
    fx.advanceTime(240_000); // +4m
    await fx.runtime.renewPolicyMeasurementLease(assignedVerifierPane, qaReq.message.message_id);
    fx.advanceTime(240_000); // +8m total (> 5m initial TTL!)
    await fx.runtime.renewPolicyMeasurementLease(assignedVerifierPane, qaReq.message.message_id);
    await fx.runtime.tick(); // Scheduler tick while measurement is still running must NOT retire or release qaReq!

    const stateMid = await fx.runtime.inspect();
    const qaReqMid = (stateMid.outbound as any[]).find(o => o.message.message_id === qaReq.message.message_id);
    expect(qaReqMid.phaseRetirement).toBeUndefined();
    expect(qaReqMid.status).toBe("accepted");
    fx.panes.busy.delete(assignedVerifierPane.role);

    // Complete Red measurement at minute 8
    const runMid = (stateMid.runs as any[])[0]!;
    const strategy = runMid.tasks[0]!.spec.strategy;
    const redBytes = Buffer.from(JSON.stringify({ phase: "red", failed: 1 }), "utf8");
    const redStartedAt = fx.clock().toISOString();
    const artifact = unwrap(
      await fx.artifacts.put({
        options: {
          artifactId: randomUUID(),
          runId: "run-tdd-heartbeat",
          taskId: "implement",
          kind: "test-result",
          mediaType: "application/json",
          expectedIntegrity: {
            checksum: { algorithm: "sha256", value: createHash("sha256").update(redBytes).digest("hex") },
            sizeBytes: redBytes.length
          },
          idempotencyKey: randomUUID()
        },
        content: (async function* () {
          yield redBytes;
        })()
      })
    );
    const verificationResult = VerificationResultSchema.parse({
      schemaVersion: 2,
      verificationId: randomUUID(),
      runId: "run-tdd-heartbeat",
      taskId: "implement",
      cycleNumber: 1,
      attemptId: randomUUID(),
      status: "failed",
      independentExecution: true,
      evaluatedCriteria: [
        {
          criterionId: "ac-1",
          passed: false,
          evidenceArtifactId: artifact.artifactId,
          summary: "Observed expected Red test failure",
          command: "test-regression",
          exitCode: 1
        }
      ],
      qualityGateResults: [],
      evidenceArtifacts: [artifact],
      findings: [],
      verifiedBy: assignedVerifierPane.agentId,
      startedAt: redStartedAt,
      completedAt: fx.clock().toISOString(),
      metadata: {
        conditionalTdd: {
          phase: "red",
          failureKind: "target_behavior",
          decisionId: strategy.tddDecision.decisionId,
          specId: strategy.specId,
          sourceRevision: qaReq.message.payload.sourceRevision,
          testRevision: qaReq.message.payload.sourceRevision,
          testNames: strategy.criterionMappings[0].testNames,
          observations: [
            {
              method: "integration_test",
              criterionId: "ac-1",
              evidenceArtifactId: artifact.artifactId,
              summary: "Independent Red failure observation",
              command: "test-regression",
              exitCode: 1
            }
          ]
        }
      }
    });
    await fx.runtime.receiveHerdr(
      RoleMessageSchema.parse({
        schema_version: 2,
        message_id: "ver-reply-red-1",
        correlation_id: "correlation-run-tdd-heartbeat",
        causation_id: qaReq.message.message_id,
        run_id: "run-tdd-heartbeat",
        sender: {
          role: assignedVerifierPane.role,
          agent_id: assignedVerifierPane.agentId,
          pane_id: assignedVerifierPane.paneId
        },
        recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" },
        type: "verification.result",
        payload: verificationResult,
        artifact_references: [artifact],
        occurred_at: fx.clock().toISOString(),
        idempotency_key: "ver-reply-red-1"
      })
    );
    await fx.runtime.tick();

    const stateFinal = await fx.runtime.inspect();
    const runFinal = (stateFinal.runs as any[])[0]!;
    expect(runFinal.status).toBe("implementing");
    const phaseNotice = (stateFinal.outbound as any[]).find(
      o => o.parentAssignmentId !== undefined && o.message.payload?.phase === "red"
    );
    expect(phaseNotice).toBeDefined();
    expect(phaseNotice.status).toBe("accepted");
  });

  it("anchors recordCoordinatorNoNextAction auto-resume createdAt at Stop time rather than stale coordinator_continuation createdAt", async () => {
    const fx = await createRuntimeFixture({ tdd: false });
    await fx.intake("run-stop-anchor");
    await fx.runtime.requestSpecialist("run-stop-anchor", "architect", "Review architecture", ["architecture"]);
    await fx.runtime.tick();

    const stateDispatched = await fx.runtime.inspect();
    const archOut = (stateDispatched.outbound as any[]).find(
      o => o.message.run_id === "run-stop-anchor" && o.message.recipient.role === "architect"
    )!;
    expect(archOut.status).toBe("accepted");

    const blockedOccurredAt = fx.clock().toISOString();
    const blockedMsg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "arch-blocked-1",
      correlation_id: "correlation-run-stop-anchor",
      causation_id: archOut.message.message_id,
      run_id: "run-stop-anchor",
      sender: { role: "architect", agent_id: "architect", pane_id: "pane-architect" },
      recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" },
      type: "task.status",
      payload: { status: "blocked", summary: "Need ADR clarification" },
      artifact_references: [],
      occurred_at: blockedOccurredAt,
      idempotency_key: "arch-blocked-1"
    });
    await fx.runtime.receiveHerdr(blockedMsg);
    await fx.runtime.tick();

    const stateBefore = await fx.runtime.inspect();
    const runBefore = (stateBefore.runs as any[])[0]!;
    expect(runBefore.pendingAction?.kind).toBe("coordinator_continuation");
    const continuationCreatedAt = runBefore.pendingAction.createdAt;
    // Deliver blockedMsg to Coordinator in FakeAgentTransport/providerDelivery so Stop attributes to that turn
    const coordWake = (stateBefore.outbound as any[]).find(
      o => o.message.recipient.role === "coordinator" && o.message.message_id === "arch-blocked-1"
    ) ?? { message: blockedMsg };
    void coordWake;

    // Coordinator works for 45 seconds before stopping without recording a workflow next action
    fx.advanceTime(45_000);
    const stopTimeIso = fx.clock().toISOString();
    const coordPane = fx.panes.bindings.find(b => b.role === "coordinator")!;
    const intakeMsg = (stateBefore.inbox as any[]).find(i => i.message.message_id === "intake-run-stop-anchor")!.message;
    // Ensure intakeMsg has a provider delivery record by checking coordinatorTurnStopped or coordinatorStopWithoutResponse
    const coordDelivery = (stateBefore.outbound as any[]).find(o => o.message.recipient.role === "coordinator")
      ?? (await (async () => {
        await fx.runtime.queueHerdr(blockedMsg);
        await fx.runtime.tick();
        const s = await fx.runtime.inspect();
        return (s.outbound as any[]).find(o => o.message.message_id === "arch-blocked-1")!;
      })());
    void intakeMsg;

    await fx.runtime.coordinatorStopWithoutResponse(coordDelivery.message, coordPane);

    const stateAfterStop = await fx.runtime.inspect();
    const runAfterStop = (stateAfterStop.runs as any[])[0]!;
    expect(runAfterStop.pendingAction?.kind).toBe("resume_coordinator");
    const anchoredCreatedAt = runAfterStop.pendingAction.createdAt as string;
    expect(Date.parse(anchoredCreatedAt)).toBeGreaterThanOrEqual(Date.parse(stopTimeIso));
    expect(Date.parse(anchoredCreatedAt) - Date.parse(continuationCreatedAt)).toBeGreaterThanOrEqual(45_000);

    // Duplicate Stop replay for the same turn keeps the anchored createdAt stable
    fx.advanceTime(5_000);
    await fx.runtime.coordinatorStopWithoutResponse(coordDelivery.message, coordPane);
    const stateReplay = await fx.runtime.inspect();
    expect((stateReplay.runs as any[])[0]!.pendingAction?.createdAt).toBe(anchoredCreatedAt);
  });

  it("serializes AgenticConversationHost across concurrent receiveRuntime and reconciles multi-approval ambiguity even when one approval is already cached", async () => {
    const fx = await createRuntimeFixture({ tdd: false });
    await fx.intake("run-chat-race");
    const manifest = unwrap(await fx.panes.getManifest());
    const chatHost = await createAgenticConversationHost({
      runtime: fx.runtime,
      manifest,
      contextDirectory: join(fx.root, "chat-context")
    });

    const at = fx.clock().toISOString();
    const reqA = buildUserDecisionRequest({
      input: { runId: "run-chat-race", taskId: "task-a", question: "Câu hỏi A?", options: ["Phương án A1", "Phương án A2"], expiresInMinutes: 20 },
      role: "coordinator",
      sessionId: "session-1",
      revision: 1,
      generation: 1,
      now: at
    });
    const reqB = buildUserDecisionRequest({
      input: { runId: "run-chat-race", taskId: "task-b", question: "Câu hỏi B?", options: ["Phương án B1", "Phương án B2"], expiresInMinutes: 20 },
      role: "coordinator",
      sessionId: "session-1",
      revision: 1,
      generation: 1,
      now: at
    });

    // Deliver reqA first so Conversation already caches 1 pending approval (Object.keys(pendingApprovals).length === 1),
    // while Runtime durably holds BOTH reqA and reqB (reqB's notice has not arrived via chatPump yet).
    const journal = new AgenticJournal(fx.journalDirectory, fx.repository);
    await journal.exclusive(async (state, save) => {
      const run = state.runs.find(r => r.runId === "run-chat-race")!;
      run.userDecisions = {
        [reqA.approvalId]: { request: reqA, role: "coordinator", agentId: "coordinator", paneId: "pane-coordinator", taskId: "task-a", status: "pending" },
        [reqB.approvalId]: { request: reqB, role: "coordinator", agentId: "coordinator", paneId: "pane-coordinator", taskId: "task-b", status: "pending" }
      };
      await save();
    });
    await chatHost.receiveRuntime(
      buildDecisionRequestMessage({
        request: reqA,
        correlationId: "correlation-run-chat-race",
        sender: { role: "runtime" },
        conversation: { role: "conversation" }
      })
    );

    // Fire concurrent receiveRuntime (simulating background chatPump progress save) and handleTrustedApproval("1")
    const progressMsg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "race-progress-1",
      correlation_id: "correlation-run-chat-race",
      run_id: "run-chat-race",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "conversation.progress",
      payload: { headline: "Đang xử lý song song", sdlcStatus: "planning" },
      artifact_references: [],
      occurred_at: at,
      idempotency_key: "race-progress-1"
    });
    const [, trustedOut] = await Promise.all([
      chatHost.receiveRuntime(progressMsg),
      chatHost.handleTrustedApproval({
        sessionId: "session-1",
        messageId: "turn-ambiguous-1",
        content: "1",
        occurredAt: at,
        provenance: { origin: "user", authenticatedUser: true, userId: "human-1", paneId: "pane-conversation", channel: "herdr_attach" }
      })
    ]);

    // Must NOT auto-approve reqA! Instead it reconciles reqB and records the unrecorded ambiguity warning.
    expect(trustedOut).toBeUndefined();
    const ctx = (await chatHost.getContext()) as { pendingApprovals: Record<string, unknown>; approvalWarnings: string[] };
    expect(Object.keys(ctx.pendingApprovals).sort()).toEqual([reqA.approvalId, reqB.approvalId].sort());
    expect(ctx.approvalWarnings.some(w => w.includes(reqA.approvalId) && w.includes(reqB.approvalId))).toBe(true);
  });
});
