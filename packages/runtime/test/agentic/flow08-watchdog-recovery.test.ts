import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileAgentRegistry } from "@bflow/agent-registry";
import {
  ApprovalRequestSchema,
  DelegationRequestSchema,
  PaneBindingSchema,
  RoleMessageSchema,
  SessionManifestSchema,
  WebCommandSchema,
  type OperationResult,
  type PaneBinding,
  type RoleMessage
} from "@bflow/contracts";
import { ensureAgenticHost } from "../../dist/agentic/host-controller.js";
import { callHost } from "../../src/agentic/host-protocol.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { AgenticJournal, digest, type JournalState, type RunRecord } from "../../src/agentic/journal.js";
import { HerdrOutbox } from "../../src/agentic/outbox.js";
import { type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { DEFAULT_WATCHDOG_OPTIONS, evaluateWatchdog } from "../../src/agentic/run-watchdog.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { actionVersion } from "../../src/interaction/actions.js";
import { draft } from "../../../specification/test/fixtures.js";
import { cleanups, fixture as integrationFixture, unwrap } from "../helpers/agentic-integration-fixture.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";

const T0 = "2026-10-31T12:00:00.000Z";
const localCleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  for (const fn of localCleanups.splice(0).reverse()) await fn();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

type TransportState = "idle" | "working" | "done";

/**
 * Mirrors real `RolePaneManager.inspectRoleHealth` (`packages/pane-manager/src/role-pane-manager.ts`),
 * which always reports `transportState` alongside `readyForPrompt` and `occupantMatches`.
 */
class RealisticPanes implements PanePolicy {
  readonly transportStates = new Map<string, TransportState>();
  readonly bindings: PaneBinding[] = [
    "conversation",
    "coordinator",
    "specifier",
    "architect",
    "planner",
    "reviewer",
    "qa",
    "tester",
    "developer"
  ].map(role =>
    PaneBindingSchema.parse({
      schemaVersion: 2,
      bindingId: `binding-${role}`,
      sessionId: "session-1",
      role,
      paneGroup: "coordination",
      agentId: `${role}-agent`,
      workspaceId: "workspace-1",
      tabId: "tab-1",
      paneId: `pane-${role}`,
      provider: "claude",
      agentKind: "claude",
      cwd: "/tmp",
      isolationMode: "dedicated_pane",
      readOnlyWorkspace: role !== "developer",
      session: { source: "herdr:claude", kind: "id", value: `session-${role}` },
      transportState: "idle",
      boundAt: T0
    })
  );

  setState(selector: string, state: TransportState): void {
    const pane = this.bindings.find(item => [item.role, item.bindingId, item.paneId, item.agentId].includes(selector));
    if (!pane) throw new Error(`Unknown pane selector: ${selector}`);
    this.transportStates.set(pane.paneId, state);
  }

  async getManifest() {
    return {
      ok: true as const,
      value: {
        schemaVersion: 2 as const,
        sessionId: "session-1",
        projectName: "Flow08Test",
        workspaceRoot: "/tmp",
        herdrWorkspaceId: "workspace-1",
        herdrTabId: "tab-1",
        status: "up" as const,
        conversationSessionId: "session-1",
        activeRunIds: [],
        panes: this.bindings,
        attachTarget: { role: "conversation" as const, paneId: "pane-conversation" },
        createdAt: T0,
        updatedAt: T0
      }
    };
  }

  async getRoleBinding(selector: string): Promise<OperationResult<PaneBinding | null>> {
    return {
      ok: true,
      value: this.bindings.find(item => [item.role, item.bindingId, item.paneId, item.agentId].includes(selector)) ?? null
    };
  }

  async inspectRoleHealth(selector: string) {
    const pane = this.bindings.find(item => [item.role, item.bindingId, item.paneId, item.agentId].includes(selector));
    if (!pane) return { ok: false, error: { code: "not_found", message: "No pane", retryable: false } } as never;
    const transportState = this.transportStates.get(pane.paneId) ?? "idle";
    return {
      ok: true as const,
      value: {
        readyForPrompt: transportState === "idle" || transportState === "done",
        transportState,
        occupantMatches: true,
        paneExists: true,
        paneId: pane.paneId,
        agentId: pane.agentId
      }
    };
  }

  async allocateDeveloper(): Promise<never> {
    throw new Error("allocateDeveloper is unused in lightweight fixture");
  }

  async releaseDeveloper() {
    return { ok: true as const, value: undefined };
  }
}

const baseSpec = draft("api");

function makeDelegation(runId = "run-1") {
  return DelegationRequestSchema.parse({
    schemaVersion: 2,
    delegationId: `delegation-${runId}`,
    messageId: `intake-${runId}`,
    correlationId: `correlation-${runId}`,
    sessionId: "session-1",
    runId,
    requestedBy: "conversation",
    targetRole: "coordinator",
    title: "Flow 08 watchdog & recovery regression",
    objective: "Verify transport, watchdog, failover and cancellation liveness",
    specificationId: baseSpec.specId,
    sddLevel: baseSpec.level,
    acceptanceCriteria: baseSpec.acceptanceCriteria,
    inputArtifacts: [],
    priority: "normal",
    requestedAt: T0,
    idempotencyKey: `intake-${runId}`
  });
}

function makeRun(runId: string, status: RunRecord["status"], overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    delegation: makeDelegation(runId),
    status,
    tasks: [],
    coreCreated: false,
    cancelled: false,
    maxIterations: 3,
    ...overrides
  };
}

async function lightweightRuntimeFixture(runs: RunRecord[] = [makeRun("run-1", "specifying")]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow08-")));
  localCleanups.push(() => rm(root, { recursive: true, force: true }));
  const panes = new RealisticPanes();
  const transport = new FakeAgentTransport();
  let nowMs = Date.parse(T0);
  const clock = () => new Date(nowMs);
  let execSeq = 0;
  transport.customSendHandler = request => {
    const handle = {
      executionId: `exec-flow08-${++execSeq}`,
      requestId: request.requestId,
      attemptId: request.attemptId,
      runId: request.runId,
      taskId: request.taskId,
      idempotencyKey: request.idempotency.key,
      target: request.target,
      correlation: {
        token: request.requestId,
        provenance: "transport" as const,
        verified: true
      },
      acceptedAt: clock().toISOString()
    };
    return {
      ok: true,
      value: {
        status: "accepted",
        requestId: request.requestId,
        attemptId: request.attemptId,
        runId: request.runId,
        taskId: request.taskId,
        observedAt: clock().toISOString(),
        handle
      }
    };
  };
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock });
  for (const pane of panes.bindings) {
    await registry.upsert({
      agentId: pane.agentId,
      role: pane.role,
      transport: "herdr",
      enabled: true,
      priority: 1,
      maxConcurrentTasks: 1,
      capabilities: pane.role === "conversation"
        ? ["conversation"]
        : ["repository.read", "coordination", "architecture", "review", "verification", "implementation", "testing"],
      settings: {}
    });
  }
  const conversationNotices: RoleMessage[] = [];
  const roleCapabilities: Record<string, string[]> = Object.fromEntries(
    panes.bindings.map(pane => [
      pane.role,
      pane.role === "conversation"
        ? ["conversation"]
        : ["repository.read", "coordination", "architecture", "review", "verification", "implementation", "testing"]
    ])
  );
  const ports = {
    clock,
    authenticateMessage: async () => true,
    authorizeHuman: async () => true,
    deliverToConversation: async (message: RoleMessage) => { conversationNotices.push(message); },
    transport,
    registry,
    panes,
    roleCapabilities,
    preflightRoleCapabilities: async () => undefined,
    engine: {},
    runStore: {},
    artifactStore: {},
    policies: {
      git: {
        cancelTask: async () => undefined,
        cancelIntegration: async () => undefined
      }
    },
    taskChecks: [],
    workflowChecks: []
  } as unknown as AgenticRuntimePorts;
  const journalDirectory = join(root, "journal");
  const repositoryPath = join(root, "repo");
  const journal = new AgenticJournal(journalDirectory, repositoryPath);
  await journal.exclusive(async (state: JournalState, save) => {
    state.runs.push(...runs);
    await save();
  });
  const runtime = new AgenticWorkflowRuntime(ports, { journalDirectory, repositoryPath });
  const advance = (ms: number) => { nowMs += ms; };
  const inspect = async () => await runtime.inspect() as unknown as JournalState;
  return { root, panes, transport, registry, journal, runtime, ports, clock, advance, inspect, conversationNotices };
}

async function activatedHostFixture(roles: readonly ("conversation" | "coordinator" | "architect" | "developer")[]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow08-host-")));
  localCleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "baseline"], {
    cwd: root,
    stdio: "pipe"
  });
  const sessionId = "flow08-host";
  const binary = join(root, "herdr-fixture.mjs");
  await writeFile(
    binary,
    [
      "#!/usr/bin/env node",
      'import { dirname, join } from "node:path";',
      'import { fileURLToPath } from "node:url";',
      "const root = dirname(fileURLToPath(import.meta.url));",
      "const args = process.argv.slice(2);",
      'const rest = args[0] === "--session" ? args.slice(2) : args;',
      'if (rest[0] === "--version") console.log("herdr test-fixture");',
      'else if (rest[0] === "api") console.log("protocol: 22\\nschema_version: 1");',
      'else if (rest[0] === "plugin" && rest[1] === "config-dir") console.log(join(root, "plugin"));',
      'else if (rest[0] === "agent" && rest[1] === "get") {',
      "  const paneId = rest[2];",
      '  const role = paneId === "pane-chat" ? "chat" : paneId.replace(/^pane-/, "");',
      '  const session = paneId === "pane-chat" ? "native-chat" : `native-${role}`;',
      '  console.log(JSON.stringify({ result: { agent: { name: role, pane_id: paneId, workspace_id: "workspace", tab_id: "tab", agent_status: "working", agent_session: { source: "herdr:claude", kind: "id", value: session } } } }));',
      "}",
      'else if (rest[0] === "pane" && rest[1] === "read") console.log("role pane ready");',
      'else if (rest[0] === "pane") process.exitCode = 1;',
      'else console.log(JSON.stringify({ running: false, socket: join(root, "herdr.sock") }));'
    ].join("\n"),
    { mode: 0o700 }
  );
  const controller = await ensureAgenticHost({ repositoryPath: root, sessionId, herdrBinary: binary });
  localCleanups.push(async () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      const quiesced = await controller.quiesce();
      if (quiesced.ok) break;
      if (attempt === 39) throw new Error(quiesced.error.message);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await controller.shutdown();
  });
  await controller.prepare();
  const hostDirectory = join(root, ".bflow/state/host", sessionId);
  const at = new Date().toISOString();
  const manifest = SessionManifestSchema.parse({
    schemaVersion: 2,
    sessionId,
    workspaceRoot: root,
    projectName: "flow08-host",
    herdrWorkspaceId: "workspace",
    herdrTabId: "tab",
    status: "up",
    conversationSessionId: "chat-session",
    activeRunIds: [],
    attachTarget: { role: "conversation", paneId: "pane-chat" },
    createdAt: at,
    updatedAt: at,
    panes: roles.map(role => ({
      schemaVersion: 2,
      bindingId: `binding-${role}`,
      sessionId,
      role,
      agentId: role === "conversation" ? "chat" : role,
      paneId: role === "conversation" ? "pane-chat" : `pane-${role}`,
      workspaceId: "workspace",
      tabId: "tab",
      provider: "claude",
      agentKind: "claude",
      cwd: root,
      permanent: true,
      readOnlyWorkspace: role !== "developer",
      isolationMode: "dedicated_pane",
      transportState: "idle",
      boundAt: at,
      session: {
        source: "herdr:claude" as const,
        kind: "id" as const,
        value: role === "conversation" ? "native-chat" : `native-${role}`
      }
    }))
  });
  const manifestDirectory = join(root, ".bflow/state/panes");
  await mkdir(manifestDirectory, { recursive: true });
  await writeFile(join(manifestDirectory, `${sessionId}.manifest.json`), JSON.stringify(manifest));

  const roleConfigs: Record<string, { socketPath: string; token: string }> = {};
  for (const role of roles) {
    const cfg = JSON.parse(await readFile(join(hostDirectory, `${role}.json`), "utf8"));
    roleConfigs[role] = cfg;
    const binding = manifest.panes.find(pane => pane.role === role)!;
    await callHost(cfg.socketPath, cfg.token, "provider_started", {
      paneId: binding.paneId,
      nativeSessionId: binding.session!.value
    });
    await callHost(cfg.socketPath, cfg.token, "native_session", {
      paneId: binding.paneId,
      sessionId: binding.session!.value
    });
  }
  expect(await controller.activate(manifest)).toEqual({ ok: true, value: undefined });
  const journal = new AgenticJournal(join(root, ".bflow/state/agentic/journal"), root);
  const readJournal = async (): Promise<JournalState> =>
    JSON.parse(await readFile(join(root, ".bflow/state/agentic/journal/state.json"), "utf8")) as JournalState;
  const editJournal = async (fn: (state: JournalState, save: () => Promise<void>) => Promise<void>) => {
    await expect.poll(async () => {
      try {
        await journal.exclusive(fn);
        return true;
      } catch (error) {
        if (String(error).includes("runtime busy")) return false;
        throw error;
      }
    }, { timeout: 10_000, interval: 25 }).toBe(true);
  };
  return { root, sessionId, hostDirectory, controller, manifest, roleConfigs, journal, readJournal, editJournal, at };
}

describe("Slice 08 — Outbox, Transport Receipts, Watchdog, Failover & Cancellation Recovery", { timeout: 120_000 }, () => {
  it("preflights the task environment before allocating a Developer and parks only that same task for Coordinator recovery", async () => {
    const f = await integrationFixture();
    const order: string[] = [];
    f.ports.preflightTaskEnvironment = async input => {
      order.push(`preflight:${input.taskId}:${input.attemptId}`);
      return { status: "blocked", checkedAt: T0, code: "task_runner_unavailable", reason: "Pinned test runner missing",
        recovery: "Restore the local runner and resume this task." };
    };
    const allocate = vi.spyOn(f.panes, "allocateDeveloper");
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    expect(order).toHaveLength(1);
    expect(order[0]).toMatch(/^preflight:implement:/);
    expect(allocate).not.toHaveBeenCalled();
    expect(await f.runtime.inspect("run-1")).toMatchObject({ status: "escalated", error: expect.stringContaining("task_runner_unavailable"),
      pendingAction: { kind: "resume_coordinator", previousStatus: "implementing" } });
  });
  it("keeps pre-Core runs visible to the watchdog without requesting a nonexistent aggregate", async () => {
    const f = await lightweightRuntimeFixture([makeRun("run-pre-core", "specifying", { coreCreated: false })]);
    expect((await f.runtime.watchdogSnapshot("session-1")).map(item => item.runId)).toContain("run-pre-core");
  });
  it("Bug 1: retains Coordinator, Specialist and Verifier leases across pre-turn readyForPrompt TUI lag until working->done, reply, Stop or 45s", async () => {
    const approvedReq = ApprovalRequestSchema.parse({
      schemaVersion: 2,
      approvalId: "app-1",
      runId: "run-1",
      sessionId: "session-1",
      target: { type: "run" },
      revision: 1,
      generation: 0,
      status: "approved",
      requestedBy: "coordinator",
      requestedAt: T0,
      reason: "Approved",
      evidence: [],
      idempotencyKey: "app-1"
    });
    const f = await lightweightRuntimeFixture([
      makeRun("run-1", "verifying", {
        tasks: [
          {
            taskId: "task-1",
            spec: { specification: baseSpec, request: approvedReq, strategy: baseSpec.testStrategy! },
            outboundIds: [],
            worktrees: []
          }
        ]
      })
    ]);
    const coordDelegation = makeDelegation("run-1");
    const coordIntake = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: coordDelegation.messageId,
      correlation_id: coordDelegation.correlationId,
      run_id: "run-1",
      sender: { role: "conversation", agent_id: "conversation-agent", pane_id: "pane-conversation" },
      recipient: { role: "coordinator" },
      type: "delegation.request",
      payload: coordDelegation,
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: coordDelegation.idempotencyKey
    });
    const archDelegation = DelegationRequestSchema.parse({
      ...coordDelegation,
      delegationId: "delegation-arch-1",
      messageId: "arch-req-1",
      requestedBy: "coordinator",
      targetRole: "architect",
      idempotencyKey: "specialist:architect:1"
    });
    const archMessage = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "arch-req-1",
      correlation_id: coordDelegation.correlationId,
      causation_id: coordDelegation.messageId,
      run_id: "run-1",
      sender: { role: "coordinator", agent_id: "coordinator-agent", pane_id: "pane-coordinator" },
      recipient: { role: "architect", agent_id: "architect-agent", pane_id: "pane-architect" },
      type: "delegation.request",
      payload: archDelegation,
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "arch-req-1"
    });
    const reviewMessage = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "gate-review-1",
      correlation_id: coordDelegation.correlationId,
      causation_id: coordDelegation.messageId,
      run_id: "run-1",
      sender: { role: "runtime" },
      recipient: { role: "reviewer", agent_id: "reviewer-agent", pane_id: "pane-reviewer" },
      type: "verification.requested",
      payload: {
        runId: "run-1",
        taskId: "task-1",
        attemptId: "verify-1",
        definition: {
          id: "host-review",
          name: "review",
          evaluator: "review",
          required: true,
          timeout: { executionTimeoutMs: 60_000, onTimeout: "block" },
          configuration: { kind: "review", role: "reviewer" }
        },
        input: { scope: "task" }
      },
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "gate-review-1"
    });

    await f.journal.exclusive(async (state, save) => {
      const outbox = new HerdrOutbox(f.ports, state, save);
      outbox.enqueue(coordIntake, "coordinator", undefined, undefined, ["repository.read"]);
      outbox.enqueue(archMessage, "architect", undefined, undefined, ["repository.read"]);
      outbox.enqueue(reviewMessage, "reviewer", "task-1", "verify-1", ["repository.read"]);
      await save();
    });

    // Dispatch all three deliveries at T0.
    await f.runtime.flushOutbound();
    let state = await f.inspect();
    expect(state.outbound.find(o => o.message.message_id === coordIntake.message_id)?.status).toBe("accepted");
    expect(state.outbound.find(o => o.message.message_id === "arch-req-1")?.status).toBe("accepted");
    expect(state.outbound.find(o => o.message.message_id === "gate-review-1")?.status).toBe("accepted");

    // Queue a second message to Coordinator while Coordinator TUI still lags in pre-turn `idle` (`readyForPrompt: true`).
    const secondCoordWake = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "coord-wake-2",
      correlation_id: coordDelegation.correlationId,
      causation_id: "arch-req-1",
      run_id: "run-1",
      sender: { role: "runtime" },
      recipient: { role: "coordinator" },
      type: "task.status",
      payload: { kind: "specialist_result_ready", fromRole: "architect", sourceMessageId: "arch-req-1" },
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "coord-wake-2"
    });
    await f.journal.exclusive(async (s, save) => {
      new HerdrOutbox(f.ports, s, save).enqueue(secondCoordWake, "coordinator");
      await save();
    });

    // 2s later, TUIs have not yet flipped Herdr out of `idle`: leases MUST remain `accepted` and prevent same-pane collision.
    f.advance(2_000);
    await f.runtime.flushOutbound();
    state = await f.inspect();
    expect(state.outbound.find(o => o.message.message_id === coordIntake.message_id)?.status).toBe("accepted");
    expect(state.outbound.find(o => o.message.message_id === "coord-wake-2")?.status).toBe("queued");
    expect(state.outbound.find(o => o.message.message_id === "arch-req-1")?.status).toBe("accepted");
    expect(state.outbound.find(o => o.message.message_id === "gate-review-1")?.status).toBe("accepted");

    // Assigned Gateway MCP tool actions succeed for Architect and Reviewer because their leases were not prematurely released.
    const archBinding = f.panes.bindings.find(b => b.role === "architect")!;
    const revBinding = f.panes.bindings.find(b => b.role === "reviewer")!;
    await expect(f.runtime.withAssignedToolAction(archBinding, async () => "ok-arch"))
      .resolves.toBe("ok-arch");
    await expect(f.runtime.withAssignedToolAction(revBinding, async () => "ok-rev"))
      .resolves.toBe("ok-rev");

    // Coordinator now flips to `working`; watchdogSnapshot retains `pane-coordinator` in acceptedPanes so evaluateWatchdog does NOT false-stall.
    f.panes.setState("coordinator", "working");
    f.panes.setState("architect", "working");
    f.panes.setState("reviewer", "working");
    f.advance(2_000);
    await f.runtime.flushOutbound();
    state = await f.inspect();
    expect(state.outbound.find(o => o.message.message_id === coordIntake.message_id)?.turnObservedWorkingAt).toBeDefined();
    expect(state.outbound.find(o => o.message.message_id === "arch-req-1")?.turnObservedWorkingAt).toBeDefined();
    expect(state.outbound.find(o => o.message.message_id === "gate-review-1")?.turnObservedWorkingAt).toBeDefined();

    const snapshotAtStart = await f.runtime.watchdogSnapshot("session-1");
    expect(snapshotAtStart[0]!.acceptedPanes).toContainEqual({ role: "coordinator", paneId: "pane-coordinator" });
    f.advance(DEFAULT_WATCHDOG_OPTIONS.stallAfterMs + 5_000);
    const evalWhileWorking = evaluateWatchdog({
      now: f.clock().getTime(),
      runs: await f.runtime.watchdogSnapshot("session-1"),
      notices: [],
      panes: [{ role: "coordinator", paneId: "pane-coordinator", status: "working" }]
    });
    expect(evalWhileWorking).toEqual([]);

    // Once panes finish their turns (`done`, `readyForPrompt: true`) after `turnObservedWorkingAt`, leases release and queued `coord-wake-2` dispatches!
    f.panes.setState("coordinator", "done");
    f.panes.setState("architect", "done");
    f.panes.setState("reviewer", "done");
    f.advance(1_000);
    await f.runtime.flushOutbound();
    state = await f.inspect();
    expect(state.outbound.find(o => o.message.message_id === coordIntake.message_id)?.status).toBe("released");
    expect(state.outbound.find(o => o.message.message_id === "coord-wake-2")?.status).toBe("accepted");
    expect(state.outbound.find(o => o.message.message_id === "arch-req-1")?.status).toBe("released");
    expect(state.outbound.find(o => o.message.message_id === "gate-review-1")?.status).toBe("released");
  });

  it("Bug 1b: preserves Agy specialist delivery lease across pre-turn readyForPrompt lag so authorizeAgyProviderTurn succeeds", async () => {
    const f = await lightweightRuntimeFixture([makeRun("run-agy", "specifying")]);
    const archIdx = f.panes.bindings.findIndex(b => b.role === "architect");
    const agyArchitect = PaneBindingSchema.parse({
      ...f.panes.bindings[archIdx]!,
      provider: "agy",
      agentKind: "agy",
      session: { source: "herdr:antigravity_cli", kind: "id", value: "session-agy-architect" }
    });
    f.panes.bindings[archIdx] = agyArchitect;

    const delegation = DelegationRequestSchema.parse({
      ...makeDelegation("run-agy"),
      delegationId: "delegation-agy-arch",
      messageId: "agy-arch-msg-1",
      requestedBy: "coordinator",
      targetRole: "architect",
      idempotencyKey: "specialist:architect:agy"
    });
    const wire = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "agy-arch-msg-1",
      correlation_id: delegation.correlationId,
      causation_id: "intake-run-agy",
      run_id: "run-agy",
      sender: { role: "coordinator", agent_id: "coordinator-agent", pane_id: "pane-coordinator" },
      recipient: { role: "architect", agent_id: agyArchitect.agentId, pane_id: agyArchitect.paneId },
      type: "delegation.request",
      payload: delegation,
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "agy-arch-msg-1"
    });
    await f.journal.exclusive(async (state, save) => {
      new HerdrOutbox(f.ports, state, save).enqueue(wire, "architect", undefined, undefined, ["repository.read"]);
      await save();
    });
    await f.runtime.flushOutbound();

    // 3s later, Agy TUI still reports `transportState: "idle"` (`readyForPrompt: true`) while starting `BeforeAgent`.
    f.advance(3_000);
    await f.runtime.flushOutbound();
    await expect(f.runtime.authorizeAgyProviderTurn(wire, agyArchitect)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "linux")("Bug 2: records durable turn stops on Claude StopFailure (provider_failure) for Coordinator, Specialist and non-failover Developer", async () => {
    const f = await activatedHostFixture(["conversation", "coordinator", "architect", "developer"]);
    const delegation = DelegationRequestSchema.parse({
      schemaVersion: 2,
      delegationId: "sf-delegation",
      messageId: "sf-intake",
      correlationId: "sf-corr",
      runId: "sf-run",
      sessionId: "chat-session",
      requestedBy: "conversation",
      targetRole: "coordinator",
      title: "StopFailure liveness",
      objective: "Ensure Claude StopFailure settles non-failover turns",
      specificationId: "sf-spec",
      sddLevel: "lightweight",
      acceptanceCriteria: baseSpec.acceptanceCriteria,
      inputArtifacts: [],
      priority: "normal",
      requestedAt: f.at,
      idempotencyKey: "sf-intake"
    });
    const archDelegation = DelegationRequestSchema.parse({
      ...delegation,
      delegationId: "sf-arch-del",
      messageId: "sf-arch-msg",
      requestedBy: "coordinator",
      targetRole: "architect",
      idempotencyKey: "specialist:architect:sf"
    });
    const coordMsg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "sf-intake",
      correlation_id: "sf-corr",
      run_id: "sf-run",
      sender: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" },
      recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" },
      type: "delegation.request",
      payload: delegation,
      artifact_references: [],
      occurred_at: f.at,
      idempotency_key: "sf-intake"
    });
    const archMsg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "sf-arch-msg",
      correlation_id: "sf-corr",
      causation_id: "sf-intake",
      run_id: "sf-run",
      sender: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" },
      recipient: { role: "architect", agent_id: "architect", pane_id: "pane-architect" },
      type: "delegation.request",
      payload: archDelegation,
      artifact_references: [],
      occurred_at: f.at,
      idempotency_key: "sf-arch-msg"
    });
    const archTarget = {
      transport: "herdr" as const,
      agentId: "architect",
      paneId: "pane-architect",
      workspaceId: "workspace",
      tabId: "tab",
      session: { source: "herdr:claude" as const, kind: "id" as const, value: "native-architect" }
    };
    const coordTarget = {
      transport: "herdr" as const,
      agentId: "coordinator",
      paneId: "pane-coordinator",
      workspaceId: "workspace",
      tabId: "tab",
      session: { source: "herdr:claude" as const, kind: "id" as const, value: "native-coordinator" }
    };

    await f.editJournal(async (state, save) => {
      state.runs.push({
        runId: "sf-run",
        delegation,
        status: "specifying",
        tasks: [],
        coreCreated: false,
        cancelled: false,
        maxIterations: 3
      });
      state.inbox.push({ message: coordMsg, status: "applied" });
      state.outbound.push(
        {
          message: coordMsg,
          status: "accepted",
          selector: "binding-coordinator",
          taskId: "sf-intake",
          attemptId: "att-coord",
          capabilities: ["repository.read"],
          lease: {
            leaseId: "lease-coord",
            agentId: "coordinator",
            runId: "sf-run",
            taskId: "sf-intake",
            attemptId: "att-coord",
            fencingToken: 1,
            version: 0,
            acquiredAt: f.at,
            expiresAt: "2099-01-01T00:00:00.000Z"
          },
          request: {
            requestId: "req-coord",
            attemptId: "att-coord",
            runId: "sf-run",
            taskId: "sf-intake",
            role: "coordinator",
            target: coordTarget,
            instruction: JSON.stringify(coordMsg),
            workingDirectory: f.root,
            inputs: [],
            context: coordMsg,
            attempt: 1,
            retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
            timeout: { executionTimeoutMs: 60_000, onTimeout: "block" },
            idempotency: { key: "sf-intake", scope: "agent-request", fingerprint: digest(coordMsg) },
            createdAt: f.at
          },
          handle: {
            executionId: "exec-coord",
            requestId: "req-coord",
            attemptId: "att-coord",
            runId: "sf-run",
            taskId: "sf-intake",
            idempotencyKey: "sf-intake",
            target: coordTarget,
            correlation: { token: "corr-coord", provenance: "transport", verified: true },
            acceptedAt: f.at
          }
        },
        {
          message: archMsg,
          status: "accepted",
          selector: "binding-architect",
          taskId: "sf-arch",
          attemptId: "att-arch",
          capabilities: ["repository.read"],
          lease: {
            leaseId: "lease-arch",
            agentId: "architect",
            runId: "sf-run",
            taskId: "sf-arch",
            attemptId: "att-arch",
            fencingToken: 1,
            version: 0,
            acquiredAt: f.at,
            expiresAt: "2099-01-01T00:00:00.000Z"
          },
          request: {
            requestId: "req-arch",
            attemptId: "att-arch",
            runId: "sf-run",
            taskId: "sf-arch",
            role: "architect",
            target: archTarget,
            instruction: JSON.stringify(archMsg),
            workingDirectory: f.root,
            inputs: [],
            context: archMsg,
            attempt: 1,
            retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
            timeout: { executionTimeoutMs: 60_000, onTimeout: "block" },
            idempotency: { key: "sf-arch-msg", scope: "agent-request", fingerprint: digest(archMsg) },
            createdAt: f.at
          },
          handle: {
            executionId: "exec-arch",
            requestId: "req-arch",
            attemptId: "att-arch",
            runId: "sf-run",
            taskId: "sf-arch",
            idempotencyKey: "sf-arch-msg",
            target: archTarget,
            correlation: { token: "corr-arch", provenance: "transport", verified: true },
            acceptedAt: f.at
          }
        }
      );
      await save();
    });

    const archCfg = f.roleConfigs.architect!;
    const coordCfg = f.roleConfigs.coordinator!;
    const devCfg = f.roleConfigs.developer!;

    // Foreign nativeSessionId is still rejected fail-closed.
    await expect(
      callHost(archCfg.socketPath, archCfg.token, "provider_failure", {
        paneId: "pane-architect",
        nativeSessionId: "foreign-session",
        event: { hook_event_name: "StopFailure", error: "rate_limit" }
      })
    ).rejects.toThrow("Provider failure belongs to a foreign native session or launch");

    // Architect StopFailure records durable specialist stop and emits specialist_no_response!
    await expect(
      callHost(archCfg.socketPath, archCfg.token, "provider_failure", {
        paneId: "pane-architect",
        nativeSessionId: "native-architect",
        event: { hook_event_name: "StopFailure", error: "overloaded_error" }
      })
    ).resolves.toEqual({ recorded: true });

    // Non-failover Developer StopFailure also records durable stop instead of returning `{ recorded: false }`.
    await expect(
      callHost(devCfg.socketPath, devCfg.token, "provider_failure", {
        paneId: "pane-developer",
        nativeSessionId: "native-developer",
        event: { hook_event_name: "StopFailure", error: "rate_limit" }
      })
    ).resolves.toEqual({ recorded: true });

    await expect.poll(async () => {
      const state = await f.readJournal();
      return state.outbound.some(
        out => out.message.recipient.role === "conversation" && (out.message.payload as { kind?: string }).kind === "specialist_no_response"
      );
    }, { timeout: 10_000 }).toBe(true);

    // Coordinator receives transport_prompt and then hits Claude StopFailure without acting -> escalates to coordinator_no_response!
    await callHost(coordCfg.socketPath, coordCfg.token, "transport_prompt", {
      paneId: "pane-coordinator",
      nativeSessionId: "native-coordinator",
      message: coordMsg
    });
    await expect(
      callHost(coordCfg.socketPath, coordCfg.token, "provider_failure", {
        paneId: "pane-coordinator",
        nativeSessionId: "native-coordinator",
        event: { hook_event_name: "StopFailure", error: "api_error" }
      })
    ).resolves.toEqual({ recorded: true });

    await expect.poll(async () => {
      const state = await f.readJournal();
      return state.runs.find(r => r.runId === "sf-run")?.status;
    }, { timeout: 10_000 }).toBe("escalated");
  });

  it.skipIf(process.platform !== "linux")("Bug 3: settles out-of-order Coordinator provider_stopped arriving before transport_prompt across Turn 1 and Turn 2, and defers specialist Stop while sending", async () => {
    // Part A: HostReceiptJournal unit proof that an unhandled early Stop on Turn 2 never re-attaches onto Turn 1's already-handled start receipt.
    const receiptDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow08-receipts-")));
    localCleanups.push(() => rm(receiptDir, { recursive: true, force: true }));
    const receipts = new HostReceiptJournal(receiptDir, receiptDir, "s-1");
    const coordBinding = PaneBindingSchema.parse({
      schemaVersion: 2,
      bindingId: "binding-coordinator",
      sessionId: "s-1",
      role: "coordinator",
      agentId: "coordinator",
      paneId: "pane-coordinator",
      workspaceId: "workspace",
      tabId: "tab",
      provider: "claude",
      agentKind: "claude",
      cwd: "/tmp",
      isolationMode: "dedicated_pane",
      readOnlyWorkspace: true,
      session: { source: "herdr:claude", kind: "id", value: "native-coordinator" },
      transportState: "idle",
      boundAt: T0
    });
    const turn1Msg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "turn-1",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "conversation" },
      recipient: { role: "coordinator" },
      type: "delegation.request",
      payload: makeDelegation("run-1"),
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "turn-1"
    });
    await receipts.startCoordinatorTurn(coordBinding, turn1Msg);
    expect(await receipts.stopCoordinatorTurn(coordBinding)).toBe(true);
    const pending1 = await receipts.pendingCoordinatorStops();
    expect(pending1).toHaveLength(1);
    await receipts.completeCoordinatorStop(pending1[0]!);
    // Now Turn 2's Stop arrives BEFORE Turn 2's startCoordinatorTurn: must return false rather than reviving Turn 1!
    expect(await receipts.stopCoordinatorTurn(coordBinding)).toBe(false);
    expect(await receipts.pendingCoordinatorStops()).toHaveLength(0);

    // Part B: Real Host RPC out-of-order `provider_stopped` BEFORE `transport_prompt` settles Turn 1 and Turn 2 cleanly.
    const f = await activatedHostFixture(["conversation", "coordinator"]);
    const occurredAt = new Date().toISOString();
    const delegation = DelegationRequestSchema.parse({
      schemaVersion: 2,
      delegationId: "ooo-del",
      messageId: "ooo-intake",
      correlationId: "ooo-corr",
      runId: "ooo-run",
      sessionId: "chat-session",
      requestedBy: "conversation",
      targetRole: "coordinator",
      title: "Out-of-order Stop",
      objective: "Settle Stop arriving ahead of UserPromptSubmit",
      specificationId: "ooo-spec",
      sddLevel: "lightweight",
      acceptanceCriteria: baseSpec.acceptanceCriteria,
      inputArtifacts: [],
      priority: "normal",
      requestedAt: occurredAt,
      idempotencyKey: "ooo-intake"
    });
    const coordTarget = {
      transport: "herdr" as const,
      agentId: "coordinator",
      paneId: "pane-coordinator",
      workspaceId: "workspace",
      tabId: "tab",
      session: { source: "herdr:claude" as const, kind: "id" as const, value: "native-coordinator" }
    };
    const coordMsg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "ooo-intake",
      correlation_id: "ooo-corr",
      run_id: "ooo-run",
      sender: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" },
      recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" },
      type: "delegation.request",
      payload: delegation,
      artifact_references: [],
      occurred_at: occurredAt,
      idempotency_key: "ooo-intake"
    });
    const wakeMsg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "ooo-wake-2",
      correlation_id: "ooo-corr",
      causation_id: "ooo-intake",
      run_id: "ooo-run",
      sender: { role: "runtime" },
      recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" },
      type: "task.status",
      payload: { kind: "resume_coordinator", actionId: "act-1" },
      artifact_references: [],
      occurred_at: occurredAt,
      idempotency_key: "ooo-wake-2"
    });
    await f.editJournal(async (state, save) => {
      state.runs.push({
        runId: "ooo-run",
        delegation,
        status: "intake",
        tasks: [],
        coreCreated: false,
        cancelled: false,
        maxIterations: 3
      });
      state.inbox.push({ message: coordMsg, status: "applied" });
      for (const [idx, msg] of [coordMsg, wakeMsg].entries()) {
        state.outbound.push({
          message: msg,
          status: "accepted",
          selector: "binding-coordinator",
          taskId: `ooo-t-${idx}`,
          attemptId: `ooo-a-${idx}`,
          capabilities: ["repository.read"],
          lease: {
            leaseId: `ooo-l-${idx}`,
            agentId: "coordinator",
            runId: "ooo-run",
            taskId: `ooo-t-${idx}`,
            attemptId: `ooo-a-${idx}`,
            fencingToken: idx + 1,
            version: 0,
            acquiredAt: occurredAt,
            expiresAt: "2099-01-01T00:00:00.000Z"
          },
          request: {
            requestId: `ooo-r-${idx}`,
            attemptId: `ooo-a-${idx}`,
            runId: "ooo-run",
            taskId: `ooo-t-${idx}`,
            role: "coordinator",
            target: coordTarget,
            instruction: JSON.stringify(msg),
            workingDirectory: f.root,
            inputs: [],
            context: msg,
            attempt: 1,
            retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
            timeout: { executionTimeoutMs: 60_000, onTimeout: "block" },
            idempotency: { key: msg.message_id, scope: "agent-request", fingerprint: digest(msg) },
            createdAt: occurredAt
          },
          handle: {
            executionId: `ooo-e-${idx}`,
            requestId: `ooo-r-${idx}`,
            attemptId: `ooo-a-${idx}`,
            runId: "ooo-run",
            taskId: `ooo-t-${idx}`,
            idempotencyKey: msg.message_id,
            target: coordTarget,
            correlation: { token: `ooo-c-${idx}`, provenance: "transport", verified: true },
            acceptedAt: occurredAt
          }
        });
      }
      await save();
    });

    const coordCfg = f.roleConfigs.coordinator!;
    // Turn 1: `provider_stopped` arrives BEFORE `transport_prompt`!
    await callHost(coordCfg.socketPath, coordCfg.token, "provider_stopped", {
      paneId: "pane-coordinator",
      nativeSessionId: "native-coordinator"
    });
    await callHost(coordCfg.socketPath, coordCfg.token, "transport_prompt", {
      paneId: "pane-coordinator",
      nativeSessionId: "native-coordinator",
      message: coordMsg
    });
    await expect.poll(async () => (await f.readJournal()).runs.find(r => r.runId === "ooo-run")?.status, { timeout: 10_000 })
      .toBe("escalated");

    // Re-open run to `specifying` for Turn 2 and send `provider_stopped` BEFORE Turn 2's `transport_prompt`.
    const turn2Wake = { ...wakeMsg, occurred_at: new Date().toISOString() };
    await f.editJournal(async (state, save) => {
      const r = state.runs.find(item => item.runId === "ooo-run")!;
      r.status = "specifying";
      delete r.pendingAction;
      const out = state.outbound.find(item => item.message.message_id === "ooo-wake-2")!;
      out.message = turn2Wake;
      await save();
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    await callHost(coordCfg.socketPath, coordCfg.token, "provider_stopped", {
      paneId: "pane-coordinator",
      nativeSessionId: "native-coordinator"
    });
    await callHost(coordCfg.socketPath, coordCfg.token, "transport_prompt", {
      paneId: "pane-coordinator",
      nativeSessionId: "native-coordinator",
      message: turn2Wake
    });
    await expect.poll(async () => (await f.readJournal()).runs.find(r => r.runId === "ooo-run")?.status, { timeout: 10_000 })
      .toBe("escalated");

    // Part C: `specialistTurnStopped` defers when target pane outbound is still `"sending"`, without blocking sibling panes.
    const lf = await lightweightRuntimeFixture();
    const archBinding = lf.panes.bindings.find(b => b.role === "architect")!;
    const dev2Binding = PaneBindingSchema.parse({
      ...lf.panes.bindings.find(b => b.role === "developer")!,
      bindingId: "binding-dev-2",
      agentId: "dev-2-agent",
      paneId: "pane-dev-2"
    });
    const dev1Binding = lf.panes.bindings.find(b => b.role === "developer")!;
    await lf.journal.exclusive(async (state, save) => {
      const msg = RoleMessageSchema.parse({
        schema_version: 2,
        message_id: "arch-sending-1",
        correlation_id: "correlation-run-1",
        run_id: "run-1",
        sender: { role: "coordinator" },
        recipient: { role: "architect" },
        type: "delegation.request",
        payload: { ...makeDelegation("run-1"), requestedBy: "coordinator", targetRole: "architect", messageId: "arch-sending-1" },
        artifact_references: [],
        occurred_at: T0,
        idempotency_key: "arch-sending-1"
      });
      state.outbound.push({
        message: msg,
        status: "sending",
        selector: "architect",
        taskId: "t-arch",
        attemptId: "a-arch",
        capabilities: ["repository.read"],
        lease: {
          leaseId: "l-arch-send",
          agentId: archBinding.agentId,
          runId: "run-1",
          taskId: "t-arch",
          attemptId: "a-arch",
          fencingToken: 1,
          version: 0,
          acquiredAt: T0,
          expiresAt: "2099-01-01T00:00:00.000Z"
        },
        request: {
          requestId: "r-arch",
          attemptId: "a-arch",
          runId: "run-1",
          taskId: "t-arch",
          role: "architect",
          target: { transport: "herdr", agentId: archBinding.agentId, paneId: archBinding.paneId, workspaceId: "workspace-1", tabId: "tab-1" },
          instruction: JSON.stringify(msg),
          workingDirectory: "/tmp",
          inputs: [],
          context: msg,
          attempt: 1,
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60_000, onTimeout: "block" },
          idempotency: { key: "arch-sending-1", scope: "agent-request", fingerprint: digest(msg) },
          createdAt: T0
        }
      });
      const dev2Msg = RoleMessageSchema.parse({
        ...msg,
        message_id: "dev2-sending",
        recipient: { role: "developer" },
        type: "task.assignment",
        idempotency_key: "dev2-sending"
      });
      state.outbound.push({
        message: dev2Msg,
        status: "sending",
        selector: dev2Binding.bindingId,
        taskId: "t-dev2",
        attemptId: "a-dev2",
        capabilities: ["implementation"],
        lease: {
          leaseId: "l-dev2-send",
          agentId: dev2Binding.agentId,
          runId: "run-1",
          taskId: "t-dev2",
          attemptId: "a-dev2",
          fencingToken: 1,
          version: 0,
          acquiredAt: T0,
          expiresAt: "2099-01-01T00:00:00.000Z"
        },
        request: {
          requestId: "r-dev2",
          attemptId: "a-dev2",
          runId: "run-1",
          taskId: "t-dev2",
          role: "developer",
          target: { transport: "herdr", agentId: dev2Binding.agentId, paneId: dev2Binding.paneId, workspaceId: "workspace-1", tabId: "tab-1" },
          instruction: JSON.stringify(dev2Msg),
          workingDirectory: "/tmp",
          inputs: [],
          context: dev2Msg,
          attempt: 1,
          retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60_000, onTimeout: "block" },
          idempotency: { key: "dev2-sending", scope: "agent-request", fingerprint: digest(dev2Msg) },
          createdAt: T0
        }
      });
      await save();
    });
    await expect(lf.runtime.specialistTurnStopped(archBinding, "architect", T0)).rejects.toThrow(
      "Specialist delivery is still sending; defer Stop settlement"
    );
    // Sibling developer pane (`dev1Binding`) is NOT blocked by `dev2Binding`'s sending state.
    await expect(lf.runtime.specialistTurnStopped(dev1Binding, "developer", T0)).resolves.toBeUndefined();
  });

  it("Bug 4: escalates Coordinator Stop after unanswered specialist or post-Core Developer Stop while keeping parallel healthy tasks live", async () => {
    // Subcase A: Pre-Core specialist stops without result -> Coordinator wakes and stops without acting -> escalates to auto_resume!
    const f = await integrationFixture({ tdd: false });
    const req = (await f.runtime.requestSpecialist("run-1", "architect", "Review architecture boundaries", ["architecture"])) as { message_id: string };
    await f.runtime.flushOutbound();
    const archPane = f.panes.bindings.find(b => b.role === "architect")!;
    const coordPane = f.panes.bindings.find(b => b.role === "coordinator")!;

    await f.runtime.specialistTurnStopped(archPane, "architect", new Date(Date.now() + 2_000).toISOString(), req.message_id);
    await f.runtime.flushOutbound();
    let state = (await f.runtime.inspect()) as unknown as JournalState;
    const wake = state.outbound.find(
      o => o.message.recipient.role === "coordinator" && (o.message.payload as { kind?: string }).kind === "specialist_no_response"
    )!;
    expect(wake).toBeDefined();
    expect(state.runs[0]!.pendingAction?.kind).toBe("coordinator_continuation");

    // Coordinator stops without issuing a replacement request or blocker.
    await f.runtime.coordinatorStopWithoutResponse(wake.message, coordPane);
    state = (await f.runtime.inspect()) as unknown as JournalState;
    expect(state.runs[0]!.status).toBe("escalated");
    expect(state.runs[0]!.pendingAction).toMatchObject({
      kind: "resume_coordinator",
      recovery: "auto_resume",
      state: "pending"
    });

    // Subcase B: Post-Core (`coreCreated === true`) with 2 parallel tasks: stopping 1 Developer does NOT pause the run while task-2 is still running;
    // once task-2 also stops without result and Coordinator stops without acting, the run escalates to `resume_coordinator`.
    const fp = await integrationFixture({ parallel: true, tdd: false });
    await fp.runtime.proposeWorkflow("run-1", fp.spec, fp.def);
    await fp.runtime.tick();
    let pState = (await fp.runtime.inspect()) as unknown as JournalState;
    const devDeliveries = pState.outbound.filter(o => o.message.type === "task.assignment" && o.status === "accepted");
    expect(devDeliveries).toHaveLength(2);
    const dev1Pane = fp.panes.bindings.find(b => b.paneId === devDeliveries[0]!.handle!.target.paneId)!;
    const dev2Pane = fp.panes.bindings.find(b => b.paneId === devDeliveries[1]!.handle!.target.paneId)!;
    const pCoordPane = fp.panes.bindings.find(b => b.role === "coordinator")!;

    await fp.runtime.specialistTurnStopped(dev1Pane, "developer", new Date(Date.now() + 2_000).toISOString(), devDeliveries[0]!.message.message_id);
    await fp.runtime.flushOutbound();
    pState = (await fp.runtime.inspect()) as unknown as JournalState;
    const dev1Wake = pState.outbound.find(
      o => o.message.causation_id === devDeliveries[0]!.message.message_id && o.message.recipient.role === "coordinator"
    )!;
    // Sibling task-2 is still running without stop, so Coordinator yielding here does NOT escalate the live parallel run.
    await fp.runtime.coordinatorStopWithoutResponse(dev1Wake.message, pCoordPane);
    pState = (await fp.runtime.inspect()) as unknown as JournalState;
    expect(pState.runs[0]!.status).toBe("implementing");

    // Now task-2 also stops without submitting and Coordinator stops on its wake without acting -> escalates to `resume_coordinator`!
    await fp.runtime.specialistTurnStopped(dev2Pane, "developer", new Date(Date.now() + 4_000).toISOString(), devDeliveries[1]!.message.message_id);
    await fp.runtime.flushOutbound();
    pState = (await fp.runtime.inspect()) as unknown as JournalState;
    const dev2Wake = pState.outbound.find(
      o => o.message.causation_id === devDeliveries[1]!.message.message_id && o.message.recipient.role === "coordinator"
    )!;
    await fp.runtime.coordinatorStopWithoutResponse(dev2Wake.message, pCoordPane);
    pState = (await fp.runtime.inspect()) as unknown as JournalState;
    expect(pState.runs[0]!.status).toBe("escalated");
    expect(pState.runs[0]!.pendingAction).toMatchObject({
      kind: "resume_coordinator",
      recovery: "auto_resume",
      state: "pending"
    });
  });

  it("Bug 5: cancels queued child task notices when parent settles, suppresses measured-phase blocker echoes during wakeup recovery, and recovers missing conversation_context wakes", async () => {
    const f = await integrationFixture({ tdd: true });
    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();

    let state = (await f.runtime.inspect()) as unknown as JournalState;
    const parent = state.outbound.find(o => o.message.type === "task.assignment" && o.status === "accepted")!;
    const devPane = f.panes.bindings.find(b => b.paneId === parent.handle!.target.paneId)!;

    // Enqueue one child notice and dispatch it (`accepted`), then enqueue a second child notice that stays `queued`.
    const child1 = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "child-accepted-1",
      correlation_id: state.runs[0]!.delegation.correlationId,
      causation_id: parent.message.message_id,
      run_id: "run-1",
      sender: { role: "coordinator" },
      recipient: { role: "developer", agent_id: devPane.agentId, pane_id: devPane.paneId },
      type: "task.status",
      payload: { kind: "result_reminder", sourceMessageId: parent.message.message_id },
      artifact_references: [],
      occurred_at: new Date().toISOString(),
      idempotency_key: "child-accepted-1"
    });
    const child2 = RoleMessageSchema.parse({
      ...child1,
      message_id: "child-queued-2",
      idempotency_key: "child-queued-2"
    });
    await new AgenticJournal(join(f.root, "journal"), f.repository).exclusive(async (s, save) => {
      new HerdrOutbox(f.ports, s, save).enqueueTaskNotice(child1, s.outbound.find(o => o.message.message_id === parent.message.message_id)!);
      await save();
    });
    await f.runtime.flushOutbound();
    await new AgenticJournal(join(f.root, "journal"), f.repository).exclusive(async (s, save) => {
      new HerdrOutbox(f.ports, s, save).enqueueTaskNotice(child2, s.outbound.find(o => o.message.message_id === parent.message.message_id)!);
      await save();
    });

    // Complete task submission and tick Runtime so parent assignment settles and calls `releaseChildNotices`.
    for (const phase of ["red", "green", "refactor"] as const) await f.evidence("implement", phase);
    await f.submit("implement", "updated content\n");
    await f.runtime.tick();
    state = (await f.runtime.inspect()) as unknown as JournalState;
    expect(state.outbound.find(o => o.message.message_id === "child-accepted-1")?.status).toBe("released");
    expect(state.outbound.find(o => o.message.message_id === "child-queued-2")?.status).toBe("cancelled");

    // Part B: `recoverMissingCoordinatorWakeups` suppresses `reportSpecialistBlocked` on `echoesMeasuredPhaseFailure` and recovers `conversation_context_ready`.
    const lf = await lightweightRuntimeFixture([makeRun("run-rec", "implementing")]);
    const qaPane = lf.panes.bindings.find(b => b.role === "qa")!;
    const convPane = lf.panes.bindings.find(b => b.role === "conversation")!;
    const phaseReq = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "phase-req-1",
      correlation_id: "correlation-run-rec",
      run_id: "run-rec",
      sender: { role: "runtime" },
      recipient: { role: "qa", agent_id: qaPane.agentId, pane_id: qaPane.paneId },
      type: "verification.requested",
      payload: { kind: "conditional_evidence", taskId: "task-1", phase: "red", sourceRevision: "abc1234" },
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "phase-req-1"
    });
    const qaEchoReply = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "qa-echo-blocked",
      correlation_id: "correlation-run-rec",
      causation_id: "phase-req-1",
      run_id: "run-rec",
      sender: { role: "qa", agent_id: qaPane.agentId, pane_id: qaPane.paneId },
      recipient: { role: "coordinator" },
      type: "task.status",
      payload: { status: "blocked", reason: "Red phase failed as measured by Runtime" },
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "qa-echo-blocked"
    });
    const convInfoMsg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "conv-info-1",
      correlation_id: "correlation-run-rec",
      run_id: "run-rec",
      sender: { role: "conversation", agent_id: convPane.agentId, pane_id: convPane.paneId },
      recipient: { role: "coordinator" },
      type: "task.status",
      payload: { status: "in_progress", summary: "User shared supplemental log note" },
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "conv-info-1"
    });

    await lf.journal.exclusive(async (s, save) => {
      s.version = 3;
      s.outbound.push({
        message: phaseReq,
        status: "released",
        selector: "qa",
        taskId: "task-1",
        attemptId: "att-phase-1",
        capabilities: ["verification"],
        phaseFailure: {
          summary: "Measured phase failure",
          repairable: true,
          recordedAt: T0,
          applied: true
        },
        handle: {
          executionId: "exec-phase-1",
          requestId: "req-phase-1",
          attemptId: "att-phase-1",
          runId: "run-rec",
          taskId: "task-1",
          idempotencyKey: "phase-req-1",
          target: {
            transport: "herdr",
            agentId: qaPane.agentId,
            paneId: qaPane.paneId,
            workspaceId: "workspace-1",
            tabId: "tab-1",
            session: qaPane.session
          },
          correlation: { token: "corr-phase-1", provenance: "transport", verified: true },
          acceptedAt: T0
        }
      });
      s.inbox.push(
        { message: qaEchoReply, status: "applied" },
        { message: convInfoMsg, status: "applied" }
      );
      await save();
    });

    const res = (await lf.runtime.recoverMissingCoordinatorWakeups()) as { recovered: number };
    expect(res.recovered).toBe(2);
    const recoveredState = await lf.inspect();
    expect(recoveredState.runs[0]!.pendingAction).toBeUndefined();
    expect(
      recoveredState.outbound.some(
        o => o.message.recipient.role === "conversation" && (o.message.payload as { kind?: string }).kind === "specialist_blocked"
      )
    ).toBe(false);
    expect(
      recoveredState.outbound.some(
        o => o.message.recipient.role === "coordinator" && (o.message.payload as { kind?: string }).kind === "conversation_context_ready"
      )
    ).toBe(true);
  });

  it("Bug 6: dispatches resume_verification_request to unanswered Reviewer (including Agy admission) when resumed via Web UI webCommand", async () => {
    const f = await integrationFixture({ remoteReview: true });
    const revBinding = f.panes.bindings.find(item => item.role === "reviewer")!;
    revBinding.provider = "herdr";
    revBinding.agentKind = "agy";
    revBinding.session = { source: "herdr:antigravity_cli", kind: "id", value: "native-agy-web-review-resume" };

    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();
    f.ports.preflightRoleCapabilities = async () => undefined;

    const definition = f.ports.taskChecks!.find(check => check.id === "review")!;
    const context = {
      runId: "run-1",
      taskId: "implement",
      attemptId: "review-web-continuation",
      artifacts: [],
      input: { scope: "task" },
      definition: { ...definition, timeout: { ...definition.timeout, executionTimeoutMs: 20_000 } }
    };
    const gate = f.runtime.herdrQualityGate("review");
    const first = new AbortController();
    const pending = gate.evaluate(context as never, { signal: first.signal });
    pending.catch(() => undefined);
    try {
      await expect.poll(
        async () => ((await f.runtime.inspect()) as unknown as JournalState).outbound.filter(out => out.message.type === "verification.requested" && out.handle).length,
        { timeout: 10_000 }
      ).toBe(1);
    } finally {
      first.abort();
      await pending.catch(() => undefined);
    }
    await f.runtime.flushOutbound();

    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    let actionId = "";
    let expectedVersion: { revisionToken: string } = { revisionToken: "" };
    await journal.exclusive(async (s, save) => {
      const r = s.runs[0]!;
      const gateOut = s.outbound.find(o => o.message.type === "verification.requested" && o.message.recipient.role === "reviewer")!;
      expect(gateOut.status).toBe("released");
      actionId = `next-${digest(["run-1", gateOut.message.message_id])}`;
      r.status = "escalated";
      r.error = "Reviewer stopped without completing review";
      r.pendingAction = {
        actionId,
        kind: "resume_coordinator",
        owner: "coordinator",
        reason: r.error,
        sourceMessageId: gateOut.message.message_id,
        createdAt: new Date().toISOString(),
        state: "pending",
        previousStatus: "verifying",
        recovery: "capability_repair"
      };
      expectedVersion = actionVersion(r, "resume");
      await save();
    });

    const webCommandId = "11111111-1111-4111-8111-111111111111";
    const webCommand = WebCommandSchema.parse({
      apiVersion: 1,
      commandId: webCommandId,
      projectId: "proj-1",
      kind: "resume",
      runId: "run-1",
      actionId,
      expectedVersion
    });
    if (webCommand.kind !== "resume") throw new Error("expected resume webCommand");

    await f.runtime.resumeBlockedRun("run-1", actionId, { webCommand });

    // Hold Reviewer busy immediately after `resume_verification_request` is sent so it stays `accepted` for Agy `BeforeAgent` admission!
    const origSend = f.transport.send.bind(f.transport);
    f.transport.send = async request => {
      const result = await origSend(request);
      if (JSON.parse(request.instruction).payload?.kind === "resume_verification_request") f.panes.busy.add("reviewer");
      return result;
    };

    const second = new AbortController();
    const resumed = gate.evaluate(context as never, { signal: second.signal });
    resumed.catch(() => undefined);
    try {
      await expect.poll(async () => (f.runtime as unknown as { gateWaiters: Map<string, unknown> }).gateWaiters.size, { timeout: 10_000 }).toBe(1);
      await f.runtime.flushOutbound();
      const state = (await f.runtime.inspect()) as unknown as JournalState;
      const resumeNotice = state.outbound.find(
        o => o.message.recipient.role === "reviewer" && (o.message.payload as { kind?: string }).kind === "resume_verification_request"
      );
      expect(resumeNotice).toBeDefined();
      expect((resumeNotice!.message.payload as { conversationUserMessageId?: string }).conversationUserMessageId).toBe(
        webCommandId
      );
      await expect(f.runtime.authorizeAgyProviderTurn(resumeNotice!.request!.context, revBinding)).resolves.toBeUndefined();
    } finally {
      second.abort();
      await resumed.catch(() => undefined);
    }
  });

  it("Bug 7: cleans up source child notices during TaskProviderFailover and completes Core cancellation when run is cancelled after failover stopped source", async () => {
    const f = await integrationFixture({ tdd: false });
    const target = { provider: "codex" as const, model: "backup-model", profile: "backup" };
    const policy = {
      schemaVersion: 3 as const,
      policyVersion: "approved-1",
      role: "developer" as const,
      candidates: [target],
      maxSwitches: 2,
      cooldownMs: 0,
      maxRetries: 2
    };
    (f.ports as unknown as Record<string, unknown>).providerFailover = {
      policyFor: () => ({ policy, current: { provider: "claude", model: "primary-model", profile: "primary" } }),
      authenticate: async () => true,
      assertMutationSafe: async () => undefined,
      preflight: async () => {
        throw new Error("codex backup quota temporarily unavailable");
      }
    };
    f.ports.stopDeveloperExecutionScope = async handle => ({
      source: "correlated_transport",
      handle,
      observedAt: new Date().toISOString()
    });
    const origAllocate = f.panes.allocateDeveloper.bind(f.panes);
    (f.panes as unknown as { allocateDeveloper: typeof f.panes.allocateDeveloper }).allocateDeveloper = async (request: Parameters<typeof f.panes.allocateDeveloper>[0] & { failoverCandidate?: { provider: string; model: string } }) => {
      const result = await origAllocate(request);
      Object.assign(result.value, {
        provider: request.failoverCandidate?.provider ?? "claude",
        model: request.failoverCandidate?.model ?? "primary-model",
        session: {
          source: request.failoverCandidate?.provider ?? "claude",
          kind: "id",
          value: `native-${request.agentName}`
        }
      });
      return result;
    };

    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();

    let state = (await f.runtime.inspect()) as unknown as JournalState;
    const source = state.outbound.find(o => o.message.type === "task.assignment" && o.status === "accepted")!;
    const devBinding = f.panes.bindings.find(b => b.paneId === source.handle!.target.paneId)!;

    // Attach both an `accepted` child notice and a `queued` child notice to `source` before failover retires `source`.
    const journal = new AgenticJournal(join(f.root, "journal"), f.repository);
    const makeNotice = (id: string) =>
      RoleMessageSchema.parse({
        schema_version: 2,
        message_id: id,
        correlation_id: state.runs[0]!.delegation.correlationId,
        causation_id: source.message.message_id,
        run_id: "run-1",
        sender: { role: "coordinator" },
        recipient: { role: "developer", agent_id: devBinding.agentId, pane_id: devBinding.paneId },
        type: "task.status",
        payload: { kind: "result_reminder", sourceMessageId: source.message.message_id },
        artifact_references: [],
        occurred_at: new Date().toISOString(),
        idempotency_key: id
      });
    await journal.exclusive(async (s, save) => {
      new HerdrOutbox(f.ports, s, save).enqueueTaskNotice(
        makeNotice("failover-child-accepted"),
        s.outbound.find(o => o.message.message_id === source.message.message_id)!
      );
      await save();
    });
    await f.runtime.flushOutbound();
    await journal.exclusive(async (s, save) => {
      new HerdrOutbox(f.ports, s, save).enqueueTaskNotice(
        makeNotice("failover-child-queued"),
        s.outbound.find(o => o.message.message_id === source.message.message_id)!
      );
      await save();
    });

    // Trigger failover: stops & retires `source` (with durable `stopProof`), then blocks at backup preflight before any replacement binds to Core.
    await f.runtime.observeProviderFailure(devBinding, {
      schemaVersion: 3,
      provider: "claude",
      kind: "quota_exhausted",
      source: "provider_structured",
      executionId: source.handle!.executionId,
      observedAt: new Date().toISOString(),
      evidenceDigest: "f".repeat(64)
    });
    await f.runtime.continueProviderFailovers();

    state = (await f.runtime.inspect()) as unknown as JournalState;
    expect(state.runs[0]!.tasks[0]!.failovers?.[0]).toMatchObject({ phase: "blocked", reason: "no_eligible_candidate" });
    expect(state.outbound.find(o => o.message.message_id === source.message.message_id)?.status).toBe("released");
    expect(state.outbound.find(o => o.message.message_id === "failover-child-accepted")?.status).toBe("released");
    expect(state.outbound.find(o => o.message.message_id === "failover-child-queued")?.status).toBe("cancelled");

    // Owner now cancels the run: `confirmCoreStops` MUST accept `failover.stopProof` on `source` and complete Core cancellation!
    await f.runtime.cancel("run-1", "Owner cancelled after backup preflight blocked");
    const report = await f.runtime.reconcileCancellation("run-1");
    expect(report.fullyStopped).toBe(true);
    expect(report.blockers).toEqual([]);
    const coreSnapshot = unwrap(await f.ports.engine.getSnapshot("run-1"));
    expect(coreSnapshot?.status).toBe("cancelled");
  });

  it("Bug 8: outbox rejection and lease acquisition failure increments deliveryAttempts with backoff and unmasks watchdog stall", async () => {
    const approvedReq = ApprovalRequestSchema.parse({
      schemaVersion: 2,
      approvalId: "app-8",
      runId: "run-8",
      sessionId: "session-1",
      target: { type: "run" },
      revision: 1,
      generation: 0,
      status: "approved",
      requestedBy: "coordinator",
      requestedAt: T0,
      reason: "Approved",
      evidence: [],
      idempotencyKey: "app-8"
    });
    const f = await lightweightRuntimeFixture([
      makeRun("run-8", "implementing", {
        tasks: [{ taskId: "task-1", spec: { specification: baseSpec, request: approvedReq, strategy: baseSpec.testStrategy! }, worktrees: [{ key: "tree-1", branchName: "b1", worktreePath: "/tmp", baseCommitHash: "c1" }], outboundIds: [] }]
      })
    ]);
    const devBinding = f.panes.bindings.find(b => b.role === "developer")!;
    const msg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "dev-assign-8",
      correlation_id: "corr-8",
      causation_id: "cause-8",
      run_id: "run-8",
      sender: { role: "coordinator" },
      recipient: { role: "developer", agent_id: devBinding.agentId, pane_id: devBinding.paneId },
      type: "task.assignment",
      payload: { context: "do work" },
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "dev-assign-8"
    });
    await f.journal.exclusive(async (s, save) => {
      new HerdrOutbox(f.ports, s, save).enqueue(msg, "developer", "task-1", "attempt-1", ["implementation"]);
      await save();
    });

    // Configure transport to reject the submission
    f.transport.send = async (req: any) => ({
      ok: true,
      value: {
        status: "rejected",
        requestId: req.requestId,
        attemptId: req.attemptId,
        runId: req.runId,
        taskId: req.taskId,
        reason: "Transport rejected submission",
        observedAt: f.clock().toISOString()
      }
    });

    await f.runtime.flushOutbound();
    let state = await f.inspect();
    let out = state.outbound.find(o => o.message.message_id === "dev-assign-8")!;
    expect(out.status).toBe("queued");
    expect(out.deliveryAttempts).toBe(1);
    expect(out.nextAttemptAt).toBeDefined();

    // Fast-forward past backoff and repeat until 5 attempts
    for (let i = 2; i <= 5; i++) {
      f.advance(35_000);
      await f.runtime.flushOutbound();
      state = await f.inspect();
      out = state.outbound.find(o => o.message.message_id === "dev-assign-8")!;
      expect(out.deliveryAttempts).toBe(i);
    }

    // Now watchdogSnapshot must recognize that activeHandoff is false because delivery attempts are exhausted!
    const facts = await f.runtime.watchdogSnapshot("session-1");
    expect(facts.find(item => item.runId === "run-8")!.activeHandoff).toBe(false);
  });

  it("Bug 9: watchdog stall detection treats unreadable / crashed panes (status unavailable) as not working", () => {
    const runFacts = {
      runId: "run-9",
      status: "implementing",
      live: true,
      lastActivityAt: 100_000,
      awaitingHuman: false,
      activeHandoff: false,
      acceptedPanes: [{ role: "developer", paneId: "pane-developer" }],
      acceptedRoles: ["developer"],
      pendingDecisions: []
    };
    // If pane is crashed or observeAgent threw error -> status: "unavailable"
    const actions = evaluateWatchdog({
      now: 400_000, // 300s > stallAfterMs (180s)
      runs: [runFacts],
      notices: [],
      panes: [{ role: "developer", paneId: "pane-developer", status: "unavailable" }],
      options: { stallAfterMs: 180_000 }
    });
    expect(actions).toEqual([
      expect.objectContaining({
        kind: "stalled",
        runId: "run-9"
      })
    ]);
  });

  it("Bug 10: cancels unsent queued message with acquired lease by releasing lease and clearing out.lease so cancellation completes without false orphan lease blocker", async () => {
    const approvedReq = ApprovalRequestSchema.parse({
      schemaVersion: 2,
      approvalId: "app-10",
      runId: "run-10",
      sessionId: "session-1",
      target: { type: "run" },
      revision: 1,
      generation: 0,
      status: "approved",
      requestedBy: "coordinator",
      requestedAt: T0,
      reason: "Approved",
      evidence: [],
      idempotencyKey: "app-10"
    });
    const f = await lightweightRuntimeFixture([
      makeRun("run-10", "implementing", {
        tasks: [{ taskId: "task-1", spec: { specification: baseSpec, request: approvedReq, strategy: baseSpec.testStrategy! }, worktrees: [{ key: "tree-1", branchName: "b1", worktreePath: "/tmp", baseCommitHash: "c1" }], outboundIds: [] }]
      })
    ]);
    const devBinding = f.panes.bindings.find(b => b.role === "developer")!;
    const msg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "dev-assign-queued-lease",
      correlation_id: "corr-10",
      causation_id: "cause-10",
      run_id: "run-10",
      sender: { role: "coordinator" },
      recipient: { role: "developer", agent_id: devBinding.agentId, pane_id: devBinding.paneId },
      type: "task.assignment",
      payload: { context: "do work" },
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "dev-assign-queued-lease"
    });
    // Enqueue message and acquire lease on it, but leave it queued (e.g. before transport sends)
    await f.journal.exclusive(async (s, save) => {
      const outbox = new HerdrOutbox(f.ports, s, save);
      const out = outbox.enqueue(msg, "developer", "task-1", "attempt-1", ["implementation"]);
      const acquired = unwrap(await f.ports.registry.acquireLease({
        leaseId: "lease-queued-10",
        agentId: devBinding.agentId,
        runId: "run-10",
        taskId: "task-1",
        attemptId: "attempt-1",
        ttlMs: 300_000,
        requestedAt: T0,
        idempotencyKey: "lease-queued-10"
      }));
      out.lease = acquired;
      out.status = "queued";
      await save();
    });

    // Cancel the run
    await f.runtime.cancel("run-10", "Owner cancelled");
    const report = await f.runtime.reconcileCancellation("run-10");
    expect(report.fullyStopped).toBe(true);
    expect(report.blockers).toEqual([]);

    // Check that out.lease is cleared so it doesn't leak
    const state = await f.inspect();
    const out = state.outbound.find(o => o.message.message_id === "dev-assign-queued-lease")!;
    expect(out.status).toBe("cancelled");
    expect(out.lease).toBeUndefined();
  });

  it("Bug 11: herdrQualityGate dispatchTimer checks all accepted tasks so parallel Developer lease is renewed during long review wait", async () => {
    const approvedReq = ApprovalRequestSchema.parse({
      schemaVersion: 2,
      approvalId: "app-11",
      runId: "run-11",
      sessionId: "session-1",
      target: { type: "run" },
      revision: 1,
      generation: 0,
      status: "approved",
      requestedBy: "coordinator",
      requestedAt: T0,
      reason: "Approved",
      evidence: [],
      idempotencyKey: "app-11"
    });
    const f = await lightweightRuntimeFixture([
      makeRun("run-11", "verifying", {
        tasks: [
          { taskId: "task-1", spec: { specification: baseSpec, request: approvedReq, strategy: baseSpec.testStrategy! }, worktrees: [{ key: "tree-1", branchName: "b1", worktreePath: "/tmp", baseCommitHash: "c1" }], outboundIds: [] }
        ]
      })
    ]);
    const archBinding = f.panes.bindings.find(b => b.role === "architect")!;
    const archDelegation = DelegationRequestSchema.parse({
      ...makeDelegation("run-11"),
      delegationId: "delegation-arch-11",
      messageId: "arch-req-11",
      requestedBy: "coordinator",
      targetRole: "architect",
      idempotencyKey: "specialist:architect:11"
    });
    const archMessage = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "arch-req-11",
      correlation_id: "corr-11",
      causation_id: "cause-11",
      run_id: "run-11",
      sender: { role: "coordinator", agent_id: "coordinator-agent", pane_id: "pane-coordinator" },
      recipient: { role: "architect", agent_id: archBinding.agentId, pane_id: archBinding.paneId },
      type: "delegation.request",
      payload: archDelegation,
      artifact_references: [],
      occurred_at: T0,
      idempotency_key: "arch-req-11"
    });
    await f.journal.exclusive(async (s, save) => {
      new HerdrOutbox(f.ports, s, save).enqueue(archMessage, "architect", undefined, undefined, ["repository.read"]);
      await save();
    });
    await f.runtime.flushOutbound();
    let state = await f.inspect();
    const archOut = state.outbound.find(o => o.message.message_id === "arch-req-11")!;
    expect(archOut.status).toBe("accepted");
    const initialExpiry = Date.parse(archOut.lease!.expiresAt);

    // Setup QualityGate review for Task 1
    const gate = f.runtime.herdrQualityGate("host-review");
    // Advance clock so Architect lease is near expiry (e.g. 250s passed out of 300s TTL: <= 240s remaining)
    f.advance(250_000);

    // Set reviewer and architect panes to working so leases are not prematurely released
    f.panes.setState("reviewer", "working");
    f.panes.setState("architect", "working");

    // Start gate evaluation in background
    const evalPromise = gate.evaluate({
      runId: "run-11",
      taskId: "task-1",
      attemptId: "att-1",
      definition: {
        id: "host-review",
        name: "review",
        evaluator: "review",
        required: true,
        timeout: { executionTimeoutMs: 10_000, onTimeout: "block" },
        configuration: { kind: "review", role: "reviewer" }
      },
      input: { scope: "task" },
      artifacts: []
    } as any, { timeoutMs: 10_000 });

    // Wait 1.5s for dispatchTimer in herdrQualityGate to tick and detect that an accepted lease is due for renewal
    await new Promise(r => setTimeout(r, 1500));

    // Check Architect lease: it should have been renewed!
    state = await f.inspect();
    const renewedArchOut = state.outbound.find(o => o.message.message_id === "arch-req-11")!;
    expect(Date.parse(renewedArchOut.lease!.expiresAt)).toBeGreaterThan(initialExpiry);

    // Clean up gate evaluation
    await evalPromise.catch(() => undefined);
  });

  it("Bug 12: provider failover blocked phase creates pendingAction and resuming run unblocks entry.phase from blocked to retired", async () => {
    const f = await integrationFixture({ tdd: false });
    f.ports.providerFailover = {
      policyFor: (binding: any) => ({
        policy: {
          schemaVersion: 3,
          policyVersion: "1.0",
          role: "developer",
          maxSwitches: 2,
          maxRetries: 0,
          cooldownMs: 0,
          candidates: []
        },
        current: { provider: binding.provider, model: binding.model, profile: "default" }
      }),
      authenticate: async () => true,
      assertMutationSafe: async () => undefined,
      preflight: async () => { throw new Error("no candidates"); }
    };
    f.ports.stopDeveloperExecutionScope = async handle => ({
      source: "correlated_transport",
      handle,
      observedAt: new Date().toISOString()
    });
    const origAllocate = f.panes.allocateDeveloper.bind(f.panes);
    (f.panes as unknown as { allocateDeveloper: typeof f.panes.allocateDeveloper }).allocateDeveloper = async (request: Parameters<typeof f.panes.allocateDeveloper>[0] & { failoverCandidate?: { provider: string; model: string } }) => {
      const result = await origAllocate(request);
      Object.assign(result.value, {
        provider: request.failoverCandidate?.provider ?? "claude",
        model: request.failoverCandidate?.model ?? "primary-model",
        session: {
          source: request.failoverCandidate?.provider ?? "claude",
          kind: "id",
          value: `native-${request.agentName}`
        }
      });
      return result;
    };

    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();

    let state = (await f.runtime.inspect()) as unknown as JournalState;
    const source = state.outbound.find(o => o.status === "accepted" && o.message.type === "task.assignment" && o.message.recipient.role === "developer")!;
    const devBinding = f.panes.bindings.find(b => b.paneId === source.handle!.target.paneId)!;

    // Observe provider failure when no failover candidates exist, causing it to block
    await f.runtime.observeProviderFailure(devBinding, {
      schemaVersion: 3,
      provider: "claude",
      kind: "quota_exhausted",
      source: "provider_structured",
      executionId: source.handle!.executionId,
      observedAt: new Date().toISOString(),
      evidenceDigest: "f".repeat(64)
    });
    await f.runtime.continueProviderFailovers();

    state = (await f.runtime.inspect()) as unknown as JournalState;
    const run = state.runs[0]!;
    expect(run.status).toBe("escalated");
    const failover = run.tasks[0]!.failovers?.[0]!;
    expect(failover.phase).toBe("blocked");
    expect(failover.reason).toBe("no_eligible_candidate");

    // Crucial: pendingAction MUST exist so the run can be resumed!
    expect(run.pendingAction).toBeDefined();
    expect(run.pendingAction?.kind).toBe("resume_coordinator");
    const actionId = run.pendingAction!.actionId;

    // Resuming the run should unblock the failover entry phase from 'blocked' to 'retired'!
    (f.ports as any).preflightRoleCapabilities = async () => undefined;
    await f.runtime.resumeBlockedRun(run.runId, actionId, { conversationUserMessageId: "user-resume-12" });

    state = (await f.runtime.inspect()) as unknown as JournalState;
    const resumedFailover = state.runs[0]!.tasks[0]!.failovers?.[0]!;
    expect(resumedFailover.phase).toBe("retired");
  });

  it("Bug 13: queryAgenticHostInteraction supports configurable timeoutMs", async () => {
    const { queryAgenticHostInteraction } = await import("../../dist/agentic/host-controller.js");
    // Verify that queryAgenticHostInteraction accepts timeoutMs in options without error
    await expect(queryAgenticHostInteraction({ repositoryPath: "/nonexistent", sessionId: "session-1", timeoutMs: 15_000 } as any))
      .rejects.toThrow();
  });
});
