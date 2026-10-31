import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, open as openFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApprovalRequestSchema,
  DelegationRequestSchema,
  PaneBindingSchema,
  RoleMessageSchema,
  SessionManifestSchema,
  type PaneBinding,
  type RoleMessage
} from "@bflow/contracts";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { draft, workflow } from "../../../specification/test/fixtures.js";
import { readHostConfiguration } from "../../src/agentic/host-controller.js";
import { callHost } from "../../src/agentic/host-protocol.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { runAgenticHost } from "../../src/agentic/host.js";
import { AgenticJournal, parseAgenticJournalState, type JournalState, type Outbound } from "../../src/agentic/journal.js";
import { matchInboundPromptInboxStatus } from "../../src/agentic/native-delivery-status.js";
import { encodeNativePluginSelection } from "../../src/agentic/native-intent-selection.js";
import { deliverNativeHerdrMessage } from "../../src/agentic/native-plugin.js";
import { HerdrOutbox, unwrap } from "../../src/agentic/outbox.js";
import { unmeasuredPolicyPhaseRequests } from "../../src/agentic/phase-recovery.js";
import type { AgenticRuntimePorts } from "../../src/agentic/ports.js";
import { evaluateWatchdog, type RunFacts } from "../../src/agentic/run-watchdog.js";
import { TaskActivityLog } from "../../src/agentic/task-activity-log.js";
import { resolvePrivateRuntimeStateDirectory } from "../../src/private-state.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function createTempRoot(prefix = "bflow-r2-s6-"): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateHome = join(root, "xdg-state");
  await mkdir(stateHome, { mode: 0o700 });
  vi.stubEnv("XDG_STATE_HOME", stateHome);
  return root;
}

async function createOutboxHarness() {
  const root = await createTempRoot("bflow-r2-s6-outbox-");
  let at = new Date("2026-10-31T10:00:00.000Z");
  let devReady = true;
  let devHealthy = true;
  let healthCalls = 0;
  let recheckBindingAfterFirstRead: PaneBinding | undefined;
  let roleBindingReads = 0;
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json"), clock: () => at });
  const engine = new DeterministicWorkflowEngine();
  const transport = new FakeAgentTransport();
  const definition = workflow();
  const created = unwrap(await engine.createRun({ runId: "run-1", definition, idempotencyKey: "create", createdAt: at.toISOString() }));
  const running = unwrap(await engine.advance({ runId: "run-1", expectedVersion: created.snapshot.version, idempotencyKey: "advance", occurredAt: at.toISOString() }));
  const attemptId = running.snapshot.tasks[0]!.attemptId!;

  const devBinding: PaneBinding = PaneBindingSchema.parse({
    schemaVersion: 2,
    bindingId: "developer-binding",
    sessionId: "session-1",
    role: "developer",
    agentId: "developer",
    paneId: "pane-developer",
    workspaceId: "workspace",
    tabId: "tab",
    provider: "claude",
    agentKind: "claude",
    cwd: root,
    worktreePath: root,
    readOnlyWorkspace: false,
    isolationMode: "dedicated_pane",
    transportState: "idle",
    boundAt: at.toISOString(),
    session: { source: "herdr:claude", kind: "id", value: "dev-session" }
  });

  const convBinding: PaneBinding = PaneBindingSchema.parse({
    schemaVersion: 2,
    bindingId: "conversation-binding",
    sessionId: "session-1",
    role: "conversation",
    agentId: "conversation",
    paneId: "pane-conversation",
    workspaceId: "workspace",
    tabId: "tab",
    provider: "claude",
    agentKind: "claude",
    cwd: root,
    readOnlyWorkspace: true,
    isolationMode: "dedicated_pane",
    transportState: "idle",
    boundAt: at.toISOString(),
    session: { source: "herdr:claude", kind: "id", value: "conv-session" }
  });

  const ports = {
    registry,
    engine,
    transport,
    clock: () => at,
    roleCapabilities: { developer: ["implementation"] },
    conversation: { deliver: async () => ({ ok: true as const, value: {} }) },
    runStore: { appendEvents: async () => ({ ok: true as const, value: {} }) },
    panes: {
      getManifest: async () => ({
        ok: true as const,
        value: SessionManifestSchema.parse({
          schemaVersion: 2,
          sessionId: "session-1",
          projectName: "bflow-r2-s6",
          workspaceRoot: root,
          herdrWorkspaceId: "workspace",
          herdrTabId: "tab",
          status: "up",
          panes: [convBinding, devBinding],
          conversationSessionId: "conv-1",
          activeRunIds: ["run-1"],
          attachTarget: { role: "conversation", paneId: "pane-conversation" },
          createdAt: at.toISOString(),
          updatedAt: at.toISOString()
        })
      }),
      getRoleBinding: async () => {
        roleBindingReads++;
        if (recheckBindingAfterFirstRead && roleBindingReads >= 2) {
          return { ok: true as const, value: recheckBindingAfterFirstRead };
        }
        return { ok: true as const, value: devBinding };
      },
      inspectRoleHealth: async () => {
        healthCalls++;
        if (!devHealthy) {
          return {
            ok: false as const,
            error: { code: "not_found" as const, retryable: false, message: "Dynamic Developer pane closed" }
          };
        }
        return {
          ok: true as const,
          value: {
            role: "developer" as const,
            paneId: devBinding.paneId,
            agentId: devBinding.agentId,
            healthy: true,
            readyForPrompt: devReady,
            occupantMatches: true,
            transportState: "idle" as const,
            checkedAt: at.toISOString()
          }
        };
      }
    }
  } as unknown as AgenticRuntimePorts;

  const spec = draft("api");
  const state: JournalState = parseAgenticJournalState({
    version: 5,
    repository: root,
    runs: [{
      runId: "run-1",
      delegation: DelegationRequestSchema.parse({
        schemaVersion: 2,
        delegationId: "delegation-1",
        messageId: "intake-1",
        correlationId: "corr-1",
        sessionId: "conv-1",
        runId: "run-1",
        requestedBy: "conversation",
        targetRole: "coordinator",
        title: "Slice 6 Round 2 test",
        objective: "Verify task notice lifecycle",
        specificationId: spec.specId,
        sddLevel: spec.level,
        acceptanceCriteria: spec.acceptanceCriteria,
        inputArtifacts: [],
        priority: "normal",
        requestedAt: at.toISOString(),
        idempotencyKey: "intake-1"
      }),
      status: "implementing",
      maxIterations: 3,
      coreCreated: true,
      cancelled: false,
      tasks: [{
        taskId: "implement",
        spec: {
          specification: spec,
          strategy: spec.testStrategy!,
          request: ApprovalRequestSchema.parse({
            schemaVersion: 2,
            approvalId: "approval-1",
            runId: "run-1",
            target: { type: "run" },
            revision: 1,
            generation: 0,
            requestedBy: "coordinator",
            requestedAt: at.toISOString(),
            reason: "Approve design",
            evidence: [],
            idempotencyKey: "approve-1"
          })
        },
        worktrees: [],
        outboundIds: ["msg-assign-1"],
        writerReleased: false
      }]
    }],
    outbound: [],
    inbox: [],
    pendingCore: [],
    pendingVerifications: []
  }, root);

  const onBound = async (out: Outbound) => {
    if (out.message.type !== "task.assignment") return;
    const snapshot = unwrap(await engine.getSnapshot("run-1"))!, task = snapshot.tasks[0]!;
    if (task.agentExecution) return;
    unwrap(await engine.bindAgentExecution({
      runId: "run-1",
      taskId: "implement",
      expectedVersion: snapshot.version,
      attempt: task.attempt,
      handle: out.handle!,
      idempotencyKey: `bind:${out.handle!.requestId}`,
      occurredAt: at.toISOString()
    }));
  };

  const outbox = new HerdrOutbox(ports, state, async () => {}, () => at.toISOString());
  const parentMessage: RoleMessage = RoleMessageSchema.parse({
    schema_version: 2,
    message_id: "msg-assign-1",
    correlation_id: "corr-1",
    run_id: "run-1",
    sender: { role: "coordinator" },
    recipient: { role: "developer", agent_id: "developer", pane_id: "pane-developer" },
    type: "task.assignment",
    payload: { taskId: "implement" },
    artifact_references: [],
    occurred_at: at.toISOString(),
    idempotency_key: "msg-assign-1"
  });
  outbox.enqueue(parentMessage, "developer", "implement", attemptId, ["implementation"]);
  await outbox.flush(onBound);
  const parent = state.outbound[0]!;
  expect(parent.status).toBe("accepted");

  return {
    root,
    state,
    outbox,
    onBound,
    attemptId,
    parent,
    registry,
    devBinding,
    getHealthCalls: () => healthCalls,
    resetHealthCalls: () => { healthCalls = 0; },
    setDevReady: (value: boolean) => { devReady = value; },
    setDevHealthy: (value: boolean) => { devHealthy = value; },
    setRecheckBindingOnSecondRead: (binding: PaneBinding | undefined) => {
      roleBindingReads = 0;
      recheckBindingAfterFirstRead = binding;
    },
    advanceMs: (ms: number) => { at = new Date(at.getTime() + ms); }
  };
}

describe("Round 2 Slice 6 Hardening — Outbox, Journal/FS, Socket Framing, Native Ingress, Watchdog", () => {
  it("Vector 1A: cancels queued task notices on permanent parent lease/recipient session loss without spinning across ticks, while preserving unsent state for continuation revival", async () => {
    const h = await createOutboxHarness();
    const noticeMsg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "msg-notice-lease-lost",
      correlation_id: "corr-1",
      causation_id: h.parent.message.message_id,
      run_id: "run-1",
      sender: { role: "coordinator" },
      recipient: { role: "developer", agent_id: "developer", pane_id: "pane-developer" },
      type: "task.status",
      payload: { kind: "policy_phase_outcome", taskId: "implement", phase: "red", status: "failed" },
      artifact_references: [],
      occurred_at: new Date().toISOString(),
      idempotency_key: "msg-notice-lease-lost"
    });
    const notice = h.outbox.enqueueTaskNotice(noticeMsg, h.parent);

    // Externally release the lease in FileAgentRegistry while journal parent.lease.expiresAt is still in the future.
    unwrap(await h.registry.releaseLease({
      leaseId: h.parent.lease!.leaseId,
      fencingToken: h.parent.lease!.fencingToken,
      expectedVersion: h.parent.lease!.version,
      releasedAt: new Date().toISOString(),
      idempotencyKey: "external-release-1"
    }));

    await h.outbox.flush(h.onBound);
    expect(notice.status).toBe("cancelled");
    expect(notice.request).toBeUndefined();
    expect(notice.handle).toBeUndefined();
    expect(notice.error).toMatch(/lease|expired|released/i);

    // Subsequent ticks must NOT keep re-probing inspectRoleHealth for the cancelled notice.
    h.state.runs[0]!.tasks[0]!.writerReleased = true;
    await h.outbox.flush(h.onBound);
    h.resetHealthCalls();
    await h.outbox.flush(h.onBound);
    expect(h.getHealthCalls()).toBe(0);

    // Also verify pre-transport TOCTOU recipient session/worktree drift cancels immediately instead of reverting to queued.
    const h2 = await createOutboxHarness();
    const notice2 = h2.outbox.enqueueTaskNotice(RoleMessageSchema.parse({
      ...noticeMsg,
      causation_id: h2.parent.message.message_id,
      message_id: "msg-notice-session-drift",
      idempotency_key: "msg-notice-session-drift"
    }), h2.parent);
    h2.setRecheckBindingOnSecondRead({
      ...h2.devBinding,
      session: { source: "herdr:claude", kind: "id", value: "different-dev-session" }
    });
    await h2.outbox.flush(h2.onBound);
    expect(notice2.status).toBe("cancelled");
    expect(notice2.error).toContain("Task notice recipient session or worktree changed");
  });

  it("Vector 1B: releases accepted task notices immediately when their parent assignment terminates so closed dynamic Developer panes are not polled every tick", async () => {
    const h = await createOutboxHarness();
    const noticeMsg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "msg-notice-accepted-1",
      correlation_id: "corr-1",
      causation_id: h.parent.message.message_id,
      run_id: "run-1",
      sender: { role: "coordinator" },
      recipient: { role: "developer", agent_id: "developer", pane_id: "pane-developer" },
      type: "task.status",
      payload: { kind: "result_reminder", taskId: "implement" },
      artifact_references: [],
      occurred_at: new Date().toISOString(),
      idempotency_key: "msg-notice-accepted-1"
    });
    const notice = h.outbox.enqueueTaskNotice(noticeMsg, h.parent);
    await h.outbox.flush(h.onBound);
    expect(notice.status).toBe("accepted");
    expect(notice.handle).toBeDefined();

    // Dynamic Developer finishes its turn, parent writer lease is released, and its dedicated pane is closed.
    h.state.runs[0]!.tasks[0]!.writerReleased = true;
    h.setDevHealthy(false);
    await h.outbox.flush(h.onBound);

    expect(h.parent.status).toBe("released");
    expect(notice.status).toBe("released");

    // Subsequent ticks must perform zero inspectRoleHealth calls.
    h.resetHealthCalls();
    await h.outbox.flush(h.onBound);
    expect(h.getHealthCalls()).toBe(0);
  });

  it("Vector 2A: tolerates FUSE/NTFS regular-file fsync EINVAL/ENOTSUP across private-state, AgenticJournal, HostReceiptJournal, and TaskActivityLog while failing closed on EIO", async () => {
    const root = await createTempRoot("bflow-r2-s6-fsync-");
    const repo = join(root, "fuse-repo");
    await mkdir(repo);

    // Emulate non-POSIX FUSE/NTFS mount where 0600 cannot be enforced AND regular-file fsyncSync throws EINVAL.
    const realFstatSync = fs.fstatSync;
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, ...args: unknown[]) => {
      const stat = Reflect.apply(realFstatSync, fs, [fd, ...args]);
      const fdPath = fs.readlinkSync(`/proc/self/fd/${fd}`);
      return fdPath.startsWith(repo + "/.bflow/.private-state-probe-") ? Object.assign(stat, { mode: 0o100777 }) : stat;
    }) as typeof fs.fstatSync);

    const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
      throw Object.assign(new Error("Invalid argument"), { code: "EINVAL" });
    });
    const externalDir = resolvePrivateRuntimeStateDirectory(repo);
    expect(externalDir).toContain("/bflow/repositories/");
    expect(fsyncSpy).toHaveBeenCalled();

    // Real I/O error (EIO) on regular-file fsyncSync must still fail closed!
    const repoEio = join(root, "eio-repo");
    await mkdir(repoEio);
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, ...args: unknown[]) => {
      const stat = Reflect.apply(realFstatSync, fs, [fd, ...args]);
      const fdPath = fs.readlinkSync(`/proc/self/fd/${fd}`);
      return fdPath.startsWith(repoEio + "/.bflow/.private-state-probe-") ? Object.assign(stat, { mode: 0o100777 }) : stat;
    }) as typeof fs.fstatSync);
    fsyncSpy.mockImplementation(() => {
      throw Object.assign(new Error("Input/output error"), { code: "EIO" });
    });
    expect(() => resolvePrivateRuntimeStateDirectory(repoEio)).toThrow(/Input\/output error|EIO/);
    vi.restoreAllMocks();

    // Now patch async FileHandle.prototype.sync to verify AgenticJournal, HostReceiptJournal, and TaskActivityLog tolerate ENOTSUP and fail closed on EIO.
    const probeHandle = await openFile(join(root, "fh-probe"), "w", 0o600);
    const fileHandleProto = Object.getPrototypeOf(probeHandle) as { sync: () => Promise<void> };
    await probeHandle.close();

    const syncSpy = vi.spyOn(fileHandleProto, "sync").mockRejectedValue(
      Object.assign(new Error("Operation not supported"), { code: "ENOTSUP" })
    );

    const journal = new AgenticJournal(join(root, "journal"), root);
    await journal.exclusive(async (state, save) => {
      state.version = 5;
      await save();
    });

    const receipts = new HostReceiptJournal(join(root, "receipts"), root, "session-1");
    await receipts.appendConversationNotice(RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "msg-fsync-notice",
      correlation_id: "corr-fsync",
      run_id: "run-1",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "conversation.progress",
      payload: { headline: "FUSE fsync ok" },
      artifact_references: [],
      occurred_at: new Date().toISOString(),
      idempotency_key: "msg-fsync-notice"
    }));

    const activity = TaskActivityLog.open(join(root, "activity", "events.jsonl"));
    expect(await activity.record({
      runId: "run-1",
      taskId: "task-1",
      kind: "progress",
      role: "runtime",
      action: "Recorded on FUSE mount"
    })).toBe(true);

    // Real EIO on FileHandle.sync must still fail closed across AgenticJournal, HostReceiptJournal, and TaskActivityLog.
    syncSpy.mockRejectedValue(Object.assign(new Error("Disk I/O failure"), { code: "EIO" }));
    const journalEio = new AgenticJournal(join(root, "journal-eio"), root);
    await expect(journalEio.exclusive(async (_state, save) => {
      await save();
    })).rejects.toThrow(/Disk I\/O failure|EIO/);
    await expect(receipts.appendConversationNotice(RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "msg-fsync-eio",
      correlation_id: "corr-fsync",
      run_id: "run-1",
      sender: { role: "runtime" },
      recipient: { role: "conversation" },
      type: "conversation.progress",
      payload: { headline: "Must fail closed on EIO" },
      artifact_references: [],
      occurred_at: new Date().toISOString(),
      idempotency_key: "msg-fsync-eio"
    }))).rejects.toThrow(/Disk I\/O failure|EIO/);
    expect(await activity.record({
      runId: "run-1",
      taskId: "task-1",
      kind: "error",
      role: "runtime",
      action: "Must fail closed on EIO"
    })).toBe(false);
  });

  it("Vector 2B: rejects symlinks/directories at journal state.json & lock, rejects oversized/symlink host.json, and fails fast on re-entrant AgenticJournal.exclusive()", async () => {
    const root = await createTempRoot("bflow-r2-s6-journal-");

    // 1. Symlink at state.json must be rejected (O_NOFOLLOW), never followed.
    const symlinkJournalDir = join(root, "journal-symlink");
    await mkdir(symlinkJournalDir, { mode: 0o700 });
    const outsideState = join(root, "outside-state.json");
    await writeFile(outsideState, JSON.stringify({
      version: 1,
      repository: root,
      runs: [],
      outbound: [],
      inbox: [],
      pendingCore: [],
      pendingVerifications: []
    }), { mode: 0o600 });
    await symlink(outsideState, join(symlinkJournalDir, "state.json"));
    const symlinkJournal = new AgenticJournal(symlinkJournalDir, root);
    await expect(symlinkJournal.exclusive(async () => "should-not-read-symlink")).rejects.toThrow();

    // 2. Directory at state.json must be rejected with EISDIR / non-regular-file error.
    const dirJournalDir = join(root, "journal-eisdir");
    await mkdir(join(dirJournalDir, "state.json"), { recursive: true, mode: 0o700 });
    const dirJournal = new AgenticJournal(dirJournalDir, root);
    await expect(dirJournal.exclusive(async () => "should-not-read-dir")).rejects.toThrow(/EISDIR|regular file/i);

    // 3. Re-entrant journal.exclusive() on the same directory must reject immediately instead of deadlocking forever.
    const reentrantJournal = new AgenticJournal(join(root, "journal-reentrant"), root);
    const outcome = await Promise.race([
      reentrantJournal.exclusive(async () => {
        return reentrantJournal.exclusive(async () => "nested");
      }).then(() => "resolved", error => String(error)),
      new Promise<string>(resolve => setTimeout(() => resolve("DEADLOCK_TIMEOUT"), 400))
    ]);
    expect(outcome).toMatch(/Re-entrant AgenticJournal lock acquisition/i);

    // 4. Oversized host.json (> 256 KB) must be rejected before unbounded parsing.
    const oversizedConfig = join(root, "oversized-host.json");
    await writeFile(oversizedConfig, JSON.stringify({
      repositoryPath: root,
      sessionId: "s1",
      directory: root,
      socketPath: join(root, "h.sock"),
      token: "t".repeat(300_000)
    }), { mode: 0o600 });
    await chmod(oversizedConfig, 0o600);
    await expect(readHostConfiguration(oversizedConfig)).rejects.toThrow(/Host configuration/i);
  });

  it("Vector 3A: preserves multi-byte UTF-8 characters split mid-byte-sequence across Unix socket chunks in both callHost and runAgenticHost RPC server", async () => {
    const root = await createTempRoot("bflow-r2-s6-utf8-");
    const socketPath = join(root, "split-utf8.sock");
    const vietnameseText = "Phê duyệt thiết kế kiến trúc hệ thống — 🚀 hoàn tất kiểm định";
    const fullPayload = Buffer.from(JSON.stringify({ ok: true, value: vietnameseText }) + "\n", "utf8");

    // Find exact mid-character split indices inside 3-byte 'ệ' (0xE1 0xBB 0x87) and 4-byte '🚀' (0xF0 0x9F 0x9A 0x80).
    const idx3Byte = fullPayload.indexOf(Buffer.from("ệ", "utf8")) + 1;
    const idx4Byte = fullPayload.indexOf(Buffer.from("🚀", "utf8")) + 2;
    expect(idx3Byte).toBeGreaterThan(1);
    expect(idx4Byte).toBeGreaterThan(idx3Byte);

    const server: Server = createServer(socket => {
      socket.once("data", () => {
        socket.write(fullPayload.subarray(0, idx3Byte));
        setTimeout(() => {
          socket.write(fullPayload.subarray(idx3Byte, idx4Byte));
          setTimeout(() => {
            socket.end(fullPayload.subarray(idx4Byte));
          }, 15);
        }, 15);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));

    const decoded = await callHost(socketPath, "secret-token", "ping");
    expect(decoded).toBe(vietnameseText);
    expect(String(decoded)).not.toContain("\uFFFD");

    // Also test runAgenticHost server receiving a request split mid-UTF-8 character!
    const hostDir = join(root, "host-daemon");
    await mkdir(hostDir, { mode: 0o700 });
    const hostSocket = join(root, "daemon.sock");
    const herdrBin = join(root, "fake-herdr.mjs");
    await writeFile(herdrBin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false})+"\\n");\n', { mode: 0o700 });
    const token = "owner-token-123456";
    await runAgenticHost({
      repositoryPath: root,
      sessionId: "utf8-host",
      directory: hostDir,
      socketPath: hostSocket,
      token,
      herdrBinary: herdrBin
    });
    cleanup.push(async () => {
      await callHost(hostSocket, token, "shutdown").catch(() => undefined);
    });

    // Send an RPC with multi-byte UTF-8 params split mid-character across socket writes; verify clean JSON parse + response.
    const reqBuf = Buffer.from(JSON.stringify({
      token,
      method: "ping",
      params: { note: vietnameseText }
    }) + "\n", "utf8");
    const reqSplit = reqBuf.indexOf(Buffer.from("ệ", "utf8")) + 1;
    const rawReply = await new Promise<string>((resolve, reject) => {
      const client = connect(hostSocket);
      const chunks: Buffer[] = [];
      client.once("error", reject);
      client.once("connect", () => {
        client.write(reqBuf.subarray(0, reqSplit));
        setTimeout(() => client.write(reqBuf.subarray(reqSplit)), 15);
      });
      client.on("data", chunk => chunks.push(Buffer.from(chunk)));
      client.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    expect(JSON.parse(rawReply.trim())).toMatchObject({ ok: true, value: { active: false, quiesced: false } });
  });

  it("Vector 3B: deliverNativeHerdrMessage rejects promptly instead of hanging forever when ingress sends >8192 bytes or closes prematurely without reply", async () => {
    const root = await createTempRoot("bflow-r2-s6-plugin-");
    const pluginDir = join(root, "plugin-cfg");
    await mkdir(join(pluginDir, "hosts"), { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    const keyFile = join(root, "signing.key");
    await writeFile(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    await chmod(keyFile, 0o600);

    const at = new Date().toISOString();
    const manifestFile = join(root, "manifest.json");
    await writeFile(manifestFile, JSON.stringify({
      schemaVersion: 2,
      sessionId: "sess-plugin",
      projectName: "plugin-test",
      workspaceRoot: root,
      herdrWorkspaceId: "ws-1",
      herdrTabId: "tab-1",
      status: "up",
      conversationSessionId: "conv-1",
      activeRunIds: ["run-1"],
      attachTarget: { role: "conversation", paneId: "%2" },
      panes: [{
        schemaVersion: 2,
        bindingId: "b-coord",
        sessionId: "sess-plugin",
        role: "coordinator",
        agentId: "coord-agent",
        paneId: "%1",
        workspaceId: "ws-1",
        tabId: "tab-1",
        provider: "claude",
        agentKind: "claude",
        cwd: root,
        readOnlyWorkspace: true,
        isolationMode: "dedicated_pane",
        transportState: "idle",
        boundAt: at,
        session: { source: "herdr:claude", kind: "id", value: "coord-native" }
      }, {
        schemaVersion: 2,
        bindingId: "b-conv",
        sessionId: "sess-plugin",
        role: "conversation",
        agentId: "conv-agent",
        paneId: "%2",
        workspaceId: "ws-1",
        tabId: "tab-1",
        provider: "claude",
        agentKind: "claude",
        cwd: root,
        readOnlyWorkspace: true,
        isolationMode: "dedicated_pane",
        transportState: "idle",
        boundAt: at,
        session: { source: "herdr:claude", kind: "id", value: "conv-native" }
      }],
      createdAt: at,
      updatedAt: at
    }), { mode: 0o600 });

    const herdrBin = join(root, "fake-herdr-plugin.mjs");
    await writeFile(herdrBin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:true,session:"sess-plugin"})+"\\n");\n', { mode: 0o700 });

    const message = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "msg-plugin-1",
      correlation_id: "corr-plugin-1",
      run_id: "run-1",
      sender: { role: "coordinator", pane_id: "%1", agent_id: "coord-agent" },
      recipient: { role: "conversation" },
      type: "conversation.progress",
      payload: { headline: "Kiểm tra ingress" },
      artifact_references: [],
      occurred_at: at,
      idempotency_key: "msg-plugin-1"
    });
    const receipts = new HostReceiptJournal(join(root, "authentication-receipts"), root, "sess-plugin");
    await receipts.recordNativeIntent("op-plugin-1", message);

    const makeEnv = (runtimeSocket: string): NodeJS.ProcessEnv => ({
      ...process.env,
      HERDR_ENV: "1",
      HERDR_PLUGIN_ID: "bflow.receipts",
      HERDR_PLUGIN_CONFIG_DIR: pluginDir,
      HERDR_BIN_PATH: herdrBin,
      HERDR_SOCKET_PATH: join(root, "herdr.sock"),
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
        selected_text: encodeNativePluginSelection("op-plugin-1", message),
        correlation_id: "corr-plugin-1",
        focused_pane_id: "%1",
        workspace_id: "ws-1"
      })
    });

    // Subcase 1: Oversized reply (> 8192 bytes) without closing socket -> must reject promptly, NEVER hang!
    const oversizedSocket = join(root, "ingress-oversized.sock");
    await writeFile(join(pluginDir, "hosts", "h1.json"), JSON.stringify({
      herdrSocketPath: join(root, "herdr.sock"),
      manifestFile,
      privateKeyFile: keyFile,
      issuerId: "host-1",
      runtimeSocket: oversizedSocket
    }), { mode: 0o600 });

    const openIngressSockets: import("node:net").Socket[] = [];
    const oversizedServer = createServer(socket => {
      openIngressSockets.push(socket);
      socket.once("data", () => {
        socket.write("x".repeat(9000));
      });
    });
    await new Promise<void>((resolve, reject) => { oversizedServer.once("error", reject); oversizedServer.listen(oversizedSocket, resolve); });
    cleanup.push(async () => {
      for (const s of openIngressSockets) s.destroy();
      await new Promise<void>(resolve => oversizedServer.close(() => resolve()));
    });

    const oversizedOutcome = await Promise.race([
      deliverNativeHerdrMessage(makeEnv(oversizedSocket)).then(() => "resolved", error => String(error)),
      new Promise<string>(resolve => setTimeout(() => resolve("HANG_TIMEOUT"), 600))
    ]);
    expect(oversizedOutcome).not.toBe("HANG_TIMEOUT");
    expect(oversizedOutcome).toMatch(/oversized|exceeds|rejected|closed/i);

    // Subcase 2: Premature socket destroy without writing JSON reply -> must reject promptly, NEVER hang!
    const resetSocket = join(root, "ingress-reset.sock");
    await writeFile(join(pluginDir, "hosts", "h1.json"), JSON.stringify({
      herdrSocketPath: join(root, "herdr.sock"),
      manifestFile,
      privateKeyFile: keyFile,
      issuerId: "host-1",
      runtimeSocket: resetSocket
    }), { mode: 0o600 });
    const resetServer = createServer(socket => {
      socket.once("data", () => { socket.destroy(); });
    });
    await new Promise<void>((resolve, reject) => { resetServer.once("error", reject); resetServer.listen(resetSocket, resolve); });
    cleanup.push(() => new Promise<void>(resolve => resetServer.close(() => resolve())));

    const resetOutcome = await Promise.race([
      deliverNativeHerdrMessage(makeEnv(resetSocket)).then(() => "resolved", error => String(error)),
      new Promise<string>(resolve => setTimeout(() => resolve("HANG_TIMEOUT"), 600))
    ]);
    expect(resetOutcome).not.toBe("HANG_TIMEOUT");
    expect(resetOutcome).not.toBe("resolved");
  });

  it("Vector 3C: matchInboundPromptInboxStatus deduplicates already-applied and already-rejected prompts whose sender was enriched with pane_id/agent_id while rejecting forged sender IDs or mutated payloads", () => {
    const at = new Date().toISOString();
    const rawOutboundPrompt = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "msg-delegation-1",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "conversation" },
      recipient: { role: "coordinator" },
      type: "delegation.request",
      payload: { objective: "Build feature" },
      artifact_references: [],
      occurred_at: at,
      idempotency_key: "msg-delegation-1"
    });
    const enrichedInboxMessage = RoleMessageSchema.parse({
      ...rawOutboundPrompt,
      sender: { role: "conversation", pane_id: "%2", agent_id: "conv-agent" }
    });

    // Applied row with enriched sender matches raw prompt (preventing bogus 'Transport sender binding unavailable' on replay/restart).
    expect(matchInboundPromptInboxStatus(
      [{ message: enrichedInboxMessage, status: "applied" }],
      rawOutboundPrompt
    )).toEqual({ status: "applied" });

    // Rejected row with enriched sender surfaces non-retryable rejection reason instead of retrying 5 times.
    expect(matchInboundPromptInboxStatus(
      [{ message: enrichedInboxMessage, status: "rejected", reason: "Run already superseded" }],
      rawOutboundPrompt
    )).toEqual({ status: "rejected", reason: "Run already superseded" });

    // Security invariant: explicit mismatched pane_id or mutated payload MUST NOT match!
    const mismatchedPanePrompt = RoleMessageSchema.parse({
      ...rawOutboundPrompt,
      sender: { role: "conversation", pane_id: "%99" }
    });
    expect(matchInboundPromptInboxStatus(
      [{ message: enrichedInboxMessage, status: "applied" }],
      mismatchedPanePrompt
    )).toEqual({ status: "absent" });
    expect(matchInboundPromptInboxStatus(
      [{ message: enrichedInboxMessage, status: "applied" }],
      RoleMessageSchema.parse({ ...rawOutboundPrompt, payload: { objective: "Tampered" } })
    )).toEqual({ status: "absent" });
  });

  it("Vector 4 & 5: recognizes non-capability failed conditional_evidence requests in unmeasuredPolicyPhaseRequests, suppresses false-positive watchdog stalls during active host verification, and evaluates circular journal imports cleanly", async () => {
    const h = await createOutboxHarness();
    const failedPhaseMsg = RoleMessageSchema.parse({
      schema_version: 2,
      message_id: "msg-phase-failed-delivery",
      correlation_id: "corr-1",
      run_id: "run-1",
      sender: { role: "coordinator" },
      recipient: { role: "qa" },
      type: "verification.requested",
      payload: {
        kind: "conditional_evidence",
        taskId: "implement",
        phase: "red",
        implementationAttemptId: h.attemptId,
        sourceRevision: "b".repeat(40)
      },
      artifact_references: [],
      occurred_at: new Date().toISOString(),
      idempotency_key: "msg-phase-failed-delivery"
    });
    h.state.outbound.push({
      message: failedPhaseMsg,
      selector: "qa",
      status: "failed",
      deliveryAttempts: 5,
      error: "Transport delivery exhausted after 5 attempts"
    });

    // A non-capability delivery-exhausted conditional_evidence request has no measurement and cannot self-recover:
    // unmeasuredPolicyPhaseRequests MUST include it so explicit resume can authorize a fresh measurement!
    const unmeasured = unmeasuredPolicyPhaseRequests(h.state, h.state.runs[0]!);
    expect(unmeasured.map(item => item.message.message_id)).toEqual(["msg-phase-failed-delivery"]);

    // Capability-preflight failures are re-queued directly by resumeBlockedRun, so they must NOT be marked as orphan phase failures.
    h.state.outbound.at(-1)!.error = "RoleCapabilityPreflightError: QA capability missing";
    expect(unmeasuredPolicyPhaseRequests(h.state, h.state.runs[0]!)).toEqual([]);

    // Watchdog: active host sandbox verification on run-1 suppresses false-positive stall while still reconciling notices.
    const runFact: RunFacts = {
      runId: "run-1",
      status: "implementing",
      live: true,
      lastActivityAt: 1_000,
      awaitingHuman: false,
      activeHandoff: false,
      acceptedRoles: ["developer", "qa"],
      acceptedPanes: [
        { role: "developer", paneId: "pane-developer" },
        { role: "qa", paneId: "pane-qa" }
      ],
      runtimeWork: false,
      pendingDecisions: []
    };
    const actionsWhileHostVerifying = evaluateWatchdog({
      now: 250_000,
      runs: [runFact],
      notices: [],
      panes: [
        { role: "developer", paneId: "pane-developer", status: "idle" },
        { role: "qa", paneId: "pane-qa", status: "unknown" }
      ],
      activeVerificationRunIds: ["run-1"]
    } as Parameters<typeof evaluateWatchdog>[0]);
    expect(actionsWhileHostVerifying.filter(a => a.kind === "stalled")).toEqual([]);

    // Vector 5: Verify circular ESM imports (rework-causality <-> journal and prototype-review <-> journal) evaluate cleanly without TDZ.
    const reworkMod = await import("../../src/agentic/rework-causality.js");
    const protoMod = await import("../../src/agentic/prototype-review.js");
    expect(reworkMod.ReworkResolutionDossierSchema).toBeDefined();
    expect(protoMod.PrototypeRecordSchema).toBeDefined();
  });
});
