import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalRequestSchema, DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema, type PaneBinding } from "@bflow/contracts";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { draft, workflow } from "../../../specification/test/fixtures.js";
import { AgenticJournal, digest, type JournalState, type Outbound } from "../../src/agentic/journal.js";
import { HerdrOutbox, unwrap } from "../../src/agentic/outbox.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";

const cleanup: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(options: { nativePending?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-task-notices-"))); cleanup.push(root);
  let at = new Date("2026-10-16T10:00:00.000Z"), ready = true;
  const registryFile = join(root, "registry.json"), registry = new FileAgentRegistry({ stateFile: registryFile, clock: () => at });
  const engine = new DeterministicWorkflowEngine(), transport = new FakeAgentTransport();
  const definition = workflow();
  const created = unwrap(await engine.createRun({ runId: "run-1", definition, idempotencyKey: "create", createdAt: at.toISOString() }));
  const running = unwrap(await engine.advance({ runId: "run-1", expectedVersion: created.snapshot.version, idempotencyKey: "advance", occurredAt: at.toISOString() }));
  const attemptId = running.snapshot.tasks[0]!.attemptId!;
  let binding: PaneBinding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "developer-binding", sessionId: "session-1", role: "developer",
    agentId: "developer", paneId: "pane-developer", workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude", cwd: root,
    worktreePath: root, readOnlyWorkspace: false, isolationMode: "dedicated_pane", transportState: "idle", boundAt: at.toISOString(),
    ...(options.nativePending ? { metadata: { launchId: "launch-test", nativeSessionPending: true } }
      : { session: { source: "herdr:claude", kind: "id", value: "native-session" } }) });
  const ports = { registry, engine, transport, clock: () => at, roleCapabilities: { developer: ["implementation"] }, panes: {
    getRoleBinding: async () => ({ ok: true as const, value: binding }), inspectRoleHealth: async () => ({ ok: true as const,
      value: { readyForPrompt: ready, occupantMatches: true, paneId: binding.paneId, agentId: binding.agentId } })
  } } as unknown as AgenticRuntimePorts;
  const journalDirectory = join(root, "journal");
  const open = () => new AgenticJournal(journalDirectory, root);
  const call = <T>(action: (outbox: HerdrOutbox, state: JournalState, save: () => Promise<void>) => Promise<T>) => open().exclusive((state, save) => action(new HerdrOutbox(ports, state, save), state, save));
  const message = (id: string, type: "task.assignment" | "task.status" = "task.status") => RoleMessageSchema.parse({ schema_version: 2, message_id: id,
    correlation_id: "correlation", run_id: "run-1", sender: { role: "coordinator" }, recipient: { role: "developer", agent_id: "developer", pane_id: "pane-developer" },
    type, payload: { phase: "implementation_authorized", taskId: "implement" }, artifact_references: [], occurred_at: at.toISOString(), idempotency_key: id });
  const onBound = vi.fn(async (out: Outbound) => {
    if (out.message.type !== "task.assignment") return;
    const snapshot = unwrap(await engine.getSnapshot("run-1"))!, task = snapshot.tasks[0]!;
    if (task.agentExecution) { expect(task.agentExecution).toEqual(out.handle); return; }
    unwrap(await engine.bindAgentExecution({ runId: "run-1", taskId: "implement", expectedVersion: snapshot.version, attempt: task.attempt,
      handle: out.handle!, idempotencyKey: `bind:${out.handle!.requestId}`, occurredAt: at.toISOString() }));
  });
  await call(async (outbox, state, save) => {
    const specification = draft("api");
    state.runs.push({ runId: "run-1", delegation: DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "delegation", messageId: "intake",
      correlationId: "correlation", sessionId: "session-1", runId: "run-1", requestedBy: "conversation", targetRole: "coordinator", title: "Task notice test",
      objective: "Deliver verified behavior", specificationId: specification.specId, sddLevel: specification.level, acceptanceCriteria: specification.acceptanceCriteria, inputArtifacts: [], priority: "normal",
      requestedAt: at.toISOString(), idempotencyKey: "intake" }), status: "implementing", tasks: [{ taskId: "implement", spec: { specification,
        strategy: specification.testStrategy!, request: ApprovalRequestSchema.parse({ schemaVersion: 2, approvalId: "approval", runId: "run-1", target: { type: "run" },
          revision: 1, generation: 0, requestedBy: "coordinator", requestedAt: at.toISOString(), reason: "Accept design", evidence: [], idempotencyKey: "approve" }) },
        worktrees: [], outboundIds: ["assignment"], writerReleased: false }], maxIterations: 3, coreCreated: true, cancelled: false });
    outbox.enqueue(message("assignment", "task.assignment"), "developer", "implement", attemptId, ["implementation"]);
    await save(); await outbox.flush(onBound);
  });
  const parent = (state: JournalState) => state.outbound.find(out => out.message.message_id === "assignment")!;
  const notice = async (id = "notice") => call(async (outbox, state, save) => { const result = outbox.enqueueTaskNotice(message(id), parent(state)); await save(); return result; });
  const registryState = async () => JSON.parse(await readFile(registryFile, "utf8"));
  return { root, ports, registry, registryFile, journalDirectory, transport, engine, call, open, message, parent, notice, onBound, registryState,
    clock: (milliseconds: number) => { at = new Date(at.getTime() + milliseconds); }, ready: (value: boolean) => { ready = value; },
    replace: (patch: Partial<PaneBinding>) => { binding = { ...binding, ...patch }; } };
}
// AgenticJournal.exclusive uses Linux flock to serialize durable notices.
describe.skipIf(process.platform !== "linux")("task notices borrowing active assignment authority", () => {
  it("holds a platform assignment before Registry or transport until its native session is persisted", async () => {
    const f = await fixture({ nativePending: true });
    expect(f.transport.sentRequests).toHaveLength(0);
    expect(f.onBound).not.toHaveBeenCalled();
    await f.call(async (_outbox, state) => {
      expect(f.parent(state)).toMatchObject({ status: "queued" });
      expect(f.parent(state).lease).toBeUndefined();
      expect(f.parent(state).request).toBeUndefined();
    });
    f.replace({ session: { source: "herdr:claude", kind: "id", value: "late-native-session" } });
    await f.call(async (outbox, state) => {
      await outbox.flush(f.onBound);
      expect(f.parent(state).handle?.target.session?.value).toBe("late-native-session");
    });
    expect(f.transport.sentRequests).toHaveLength(1);
  });

  it("sends through a one-slot Registry without another assignment, Core binding, or lease release", async () => {
    const f = await fixture();
    const acquire = vi.spyOn(f.registry, "acquireLease"), release = vi.spyOn(f.registry, "releaseLease");
    await f.notice();
    await f.call(async (outbox, state) => { await outbox.flush(f.onBound);
      const child = state.outbound.find(out => out.parentAssignmentId)!;
      expect(child.status).toBe("accepted"); expect(child.assignment).toBeUndefined();
      expect(child.lease).toEqual(f.parent(state).lease); expect(child.request!.metadata?.leaseId).toBe(f.parent(state).lease!.leaseId);
      expect(child.request!.metadata?.fencingToken).toBe(f.parent(state).lease!.fencingToken);
      await outbox.release(child); await outbox.renew(f.parent(state));
    });
    expect(acquire).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
    expect(f.transport.sentRequests).toHaveLength(2);
    expect(f.transport.sentRequests.map(request => JSON.parse(request.instruction).type)).toEqual(["task.assignment", "task.status"]);
    expect(f.onBound.mock.calls.every(([out]) => !out.parentAssignmentId)).toBe(true);
    expect(Object.values((await f.registryState()).leases)).toHaveLength(1);
    expect(Object.values((await f.registryState()).leases).every((value: any) => value.active)).toBe(true);
    const execution = unwrap(await f.engine.getSnapshot("run-1"))!.tasks[0]!.agentExecution;
    expect(execution?.requestId).toBe(f.transport.sentRequests[0]!.requestId);
  });
  it("reloads serialized parent links and propagates renewal versions to every notice", async () => {
    const f = await fixture(); await f.notice("first"); await f.notice("second");
    await f.call(async (outbox, state) => {
      const children = state.outbound.filter(out => out.parentAssignmentId);
      await outbox.renew(children[0]!);
      expect(children.every(child => digest(child.lease) === digest(f.parent(state).lease))).toBe(true);
    });
    await f.call(async (outbox, state) => { await outbox.flush(f.onBound); expect(state.outbound.every(out => out.lease!.version === f.parent(state).lease!.version)).toBe(true); });
    await f.call(async (outbox, state) => { await outbox.release(state.outbound.find(out => out.parentAssignmentId)!); await outbox.renew(f.parent(state)); });
    expect(f.transport.sentRequests).toHaveLength(3);
  });
  it("recovers a Registry renewal committed before the journal lease update", async () => {
    const f = await fixture(); await f.notice();
    await f.open().exclusive(async (state, save) => {
      let writes = 0;
      const outbox = new HerdrOutbox(f.ports, state, async () => { if (++writes === 2) throw new Error("crash after registry commit"); await save(); });
      await expect(outbox.renew(f.parent(state))).rejects.toThrow("crash");
    });
    f.clock(1000);
    await f.call(async (outbox, state) => {
      expect(f.parent(state).leaseRenewal).toBeDefined();
      await outbox.renew(f.parent(state));
      expect(f.parent(state).leaseRenewal).toBeUndefined();
      expect(state.outbound.every(out => digest(out.lease) === digest(f.parent(state).lease))).toBe(true);
      await outbox.flush(f.onBound);
    });
    expect(f.transport.sentRequests).toHaveLength(2);
  });
  it("keeps exact unknown delivery across reopen and only resends after proven not_delivered", async () => {
    const f = await fixture(); await f.notice();
    f.transport.customSendHandler = () => ({ ok: false, error: { code: "timeout", retryable: true, message: "lost ACK" } });
    await f.call(async outbox => outbox.flush(f.onBound)); const count = f.transport.sentRequests.length;
    const first = f.transport.sentRequests.at(-1)!;
    await f.call(async (outbox, state) => { await outbox.flush(f.onBound); expect(state.outbound.at(-1)!.status).toBe("unknown_delivery"); });
    expect(f.transport.sentRequests).toHaveLength(count);
    f.transport.customReconcileHandler = () => ({ ok: true, value: { status: "not_delivered", requestId: first.requestId, retrySafe: true, observedAt: new Date().toISOString() } });
    delete f.transport.customSendHandler;
    await f.call(async outbox => { await outbox.reconcile("notice", f.onBound); await outbox.flush(f.onBound); });
    expect(f.transport.sentRequests).toHaveLength(count + 1); expect(f.transport.sentRequests.at(-1)).toEqual(first);
  });
  it.each(["released", "expired", "stopped", "terminal", "replaced"])("refuses %s parent authority before notice transport", async condition => {
    const f = await fixture(); await f.notice();
    if (condition === "expired") f.clock(300_001);
    if (condition === "replaced") f.replace({ session: { source: "herdr:claude", kind: "id", value: "replacement-session" } });
    await f.call(async (outbox, state, save) => {
      const parent = f.parent(state);
      if (condition === "released") await outbox.release(parent);
      if (condition === "stopped") parent.cancelRequested = true;
      if (condition === "terminal") state.runs[0]!.status = "completed";
      await save(); await outbox.flush(f.onBound);
      expect(state.outbound.at(-1)!.status).toBe("cancelled");
      if (condition !== "replaced") expect(() => outbox.enqueueTaskNotice(f.message("another"), parent)).toThrow();
    });
    expect(f.transport.sentRequests).toHaveLength(1);
  });
  it("rejects a parent lease released externally even when the journal still appears active", async () => {
    const f = await fixture(); await f.notice();
    await f.call(async (_outbox, state) => {
      const lease = f.parent(state).lease!;
      unwrap(await f.registry.releaseLease({ leaseId: lease.leaseId, fencingToken: lease.fencingToken, expectedVersion: lease.version,
        releasedAt: new Date().toISOString(), idempotencyKey: "external-release" }));
    });
    await f.call(async outbox => outbox.flush(f.onBound));
    expect(f.transport.sentRequests).toHaveLength(1);
  });
  it("does not treat a replayed renewal receipt as current authority after an external release", async () => {
    const f = await fixture(); await f.notice();
    await f.open().exclusive(async (state, save) => {
      let writes = 0;
      const outbox = new HerdrOutbox(f.ports, state, async () => { if (++writes === 2) throw new Error("crash"); await save(); });
      await expect(outbox.renew(f.parent(state))).rejects.toThrow("crash");
    });
    const persisted = Object.values((await f.registryState()).leases)[0] as { lease: { leaseId: string; fencingToken: number; version: number } };
    unwrap(await f.registry.releaseLease({ leaseId: persisted.lease.leaseId, fencingToken: persisted.lease.fencingToken, expectedVersion: persisted.lease.version,
      releasedAt: new Date().toISOString(), idempotencyKey: "released-after-renewal" }));
    await f.call(async (outbox, state) => { await expect(outbox.renew(f.parent(state))).rejects.toThrow("released"); });
    expect(f.transport.sentRequests).toHaveLength(1);
  });
  it("checks actual Core cancellation even when the task journal still appears active", async () => {
    const f = await fixture(); await f.notice();
    const snapshot = unwrap(await f.engine.getSnapshot("run-1"))!;
    unwrap(await f.engine.requestCancellation({ schemaVersion: 1, cancellationId: "cancel", runId: "run-1", requestedBy: "human",
      requestedAt: new Date().toISOString(), expectedVersion: snapshot.version, idempotencyKey: "cancel" }));
    await f.call(async (outbox, state) => { await outbox.flush(f.onBound); expect(state.outbound.at(-1)!.status).toBe("cancelled"); });
    expect(f.transport.sentRequests).toHaveLength(1);
  });
  it("rejects altered serialized parent links and mismatched shared lease versions", async () => {
    const f = await fixture(); await f.notice();
    const path = join(f.journalDirectory, "state.json"), original = await readFile(path, "utf8");
    for (const alteration of [ (value: any) => { value.outbound[1].parentAssignmentId = "missing"; },
      (value: any) => { value.outbound[1].lease.version += 1; } ]) {
      const value = JSON.parse(original); alteration(value); await writeFile(path, JSON.stringify(value));
      await expect(f.call(async () => undefined)).rejects.toThrow("task notice");
    }
  });
});

describe.skipIf(process.platform !== "linux")("durable lease release recovery", () => {
  it("replays the exact release after Registry commit before journal save and a delayed clock", async () => {
    const f = await fixture(), release = vi.spyOn(f.registry, "releaseLease");
    await f.open().exclusive(async (state, save) => {
      let writes = 0;
      const outbox = new HerdrOutbox(f.ports, state, async () => {
        if (++writes === 2) throw new Error("simulated process death");
        await save();
      });
      await expect(outbox.release(f.parent(state))).rejects.toThrow("simulated process death");
    });
    const first = release.mock.calls[0]![0];
    f.clock(600_000);
    await f.call(async (outbox, state) => {
      expect(f.parent(state).status).toBe("accepted");
      expect(f.parent(state).leaseRelease).toEqual(first);
      await expect(outbox.renew(f.parent(state))).rejects.toThrow("release is pending");
      await outbox.release(f.parent(state));
      expect(f.parent(state).status).toBe("released");
      expect(f.parent(state).leaseRelease).toBeUndefined();
      await outbox.release(f.parent(state));
    });
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls[1]![0]).toEqual(first);
    expect(Object.values((await f.registryState()).leases).every((entry: any) => !entry.active)).toBe(true);
  });
  it("flush finishes pending release before renewing or delivering a borrowed notice", async () => {
    const f = await fixture(); await f.notice();
    await f.open().exclusive(async (state, save) => {
      let writes = 0;
      const outbox = new HerdrOutbox(f.ports, state, async () => { await save(); if (++writes === 1) throw new Error("crash before Registry release"); });
      await expect(outbox.release(f.parent(state))).rejects.toThrow("crash");
    });
    const renew = vi.spyOn(f.registry, "renewLease");
    await f.call(async (outbox, state) => {
      expect(() => outbox.enqueueTaskNotice(f.message("another"), f.parent(state))).toThrow("active parent");
      await outbox.flush(f.onBound);
      expect(f.parent(state).status).toBe("released");
      expect(state.outbound.at(-1)!.status).toBe("cancelled");
    });
    expect(renew).not.toHaveBeenCalled();
    expect(f.transport.sentRequests).toHaveLength(1);
  });
  it("rejects persisted release requests with altered lease identity, version or fencing", async () => {
    const f = await fixture();
    await f.open().exclusive(async (state, save) => {
      const outbox = new HerdrOutbox(f.ports, state, async () => { await save(); throw new Error("crash after intent"); });
      await expect(outbox.release(f.parent(state))).rejects.toThrow("crash");
    });
    const path = join(f.journalDirectory, "state.json"), original = await readFile(path, "utf8");
    for (const field of ["leaseId", "expectedVersion", "fencingToken"]) {
      const value = JSON.parse(original);
      value.outbound[0].leaseRelease[field] = field === "leaseId" ? "foreign" : value.outbound[0].leaseRelease[field] + 1;
      await writeFile(path, JSON.stringify(value));
      await expect(f.call(async () => undefined)).rejects.toThrow("Invalid pending outbound lease release");
    }
  });
});
