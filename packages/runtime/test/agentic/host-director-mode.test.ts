import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DelegationRequestSchema, PaneBindingSchema, RoleMessageSchema, SessionManifestSchema, SessionManifestV3Schema, type SessionManifest } from "@bflow/contracts";
import { buildDelegationRequest } from "@bflow/conversation";
import { executeHostWatchdogPass } from "../../src/agentic/host.js";
import {
  assertManifestLayout, buildDirectorWorkDelegation, directorDefaultAgentKind, directorProgressCommand, ensureDirectorProgressPane, hostRolesFor,
  recordConversationNotice, startDirectorWork, workspaceDefaultAgentKind, type DelegationBuilder
} from "../../src/agentic/host-director-mode.js";
import { AdmissionRejectedError } from "../../src/agentic/runtime.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { TaskActivityLog } from "../../src/agentic/task-activity-log.js";
import { DirectorEndpoint } from "../../src/director/endpoint.js";
import { AgenticHostPlatformOptionsSchema } from "../../src/platform/host-options.js";
import { assertHostLayoutOptions } from "../../src/agentic/host-controller.js";

const T0 = "2026-11-03T10:00:00.000Z";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function directory(): Promise<string> { const d = await mkdtemp(join(tmpdir(), "host-director-mode-")); dirs.push(d); return d; }

function binding(role: string, overrides: Record<string, unknown> = {}) {
  return PaneBindingSchema.parse({ schemaVersion: 2, bindingId: `binding-${role}`, sessionId: "session-1", role,
    paneGroup: role === "conversation" ? "conversation" : "coordination", agentId: `${role}-agent`, workspaceId: "workspace-1", tabId: "tab-1",
    paneId: `pane-${role}`, provider: "codex", agentKind: "codex", cwd: "/tmp", isolationMode: "dedicated_pane", readOnlyWorkspace: role !== "developer",
    session: { source: "herdr:codex", kind: "id", value: `native-${role}` }, transportState: "idle", boundAt: T0, ...overrides });
}
function v3Manifest(): SessionManifest {
  return SessionManifestSchema.parse(SessionManifestV3Schema.parse({ schemaVersion: 3, sessionId: "session-1", projectName: "Test", workspaceRoot: "/tmp",
    herdrWorkspaceId: "workspace-1", herdrTabId: "tab-1", status: "up", conversationSessionId: "conv-session-1", activeRunIds: [],
    panes: [binding("planner")],
    progressPane: { tabId: "tab-progress", paneId: "pane-progress", command: ["bflow", "progress", "--follow"], phase: "running", restarts: [] },
    attachTarget: { role: "progress", tabId: "tab-progress", paneId: "pane-progress" }, createdAt: T0, updatedAt: T0 }));
}
function v2Manifest(): SessionManifest {
  return SessionManifestSchema.parse({ schemaVersion: 2, sessionId: "session-1", projectName: "Test", workspaceRoot: "/tmp",
    herdrWorkspaceId: "workspace-1", herdrTabId: "tab-1", status: "up", conversationSessionId: "conv-session-1", activeRunIds: [],
    panes: [binding("conversation", { agentKind: "claude", provider: "claude", session: { source: "herdr:claude", kind: "id", value: "native-conversation" } }),
      binding("coordinator", { agentKind: "claude", provider: "claude", session: { source: "herdr:claude", kind: "id", value: "native-coordinator" } })],
    attachTarget: { role: "conversation", paneId: "pane-conversation" }, createdAt: T0, updatedAt: T0 });
}

const platformRole = (role: string, provider = "codex") =>
  ({ role, provider, required: true, permissionMode: "restricted", capabilityIds: [], mcpServiceIds: [], toolIds: [], skillSelections: [] });
const platform = (roles: unknown[], layout?: "legacy_v2" | "director") => ({ schemaVersion: 3, ...(layout ? { layout } : {}), machineId: "machine-1",
  repositoryId: "repo-1", roles, skillsStoreRoot: "/machine/skills", approvedBuiltinSkillDigests: [] });

describe("host options layout", () => {
  it("director layout refuses Conversation/Coordinator roles and accepts specialist-only roles", () => {
    expect(() => AgenticHostPlatformOptionsSchema.parse(platform([platformRole("coordinator"), platformRole("planner")], "director")))
      .toThrow("director layout platform roles must not include coordinator");
    expect(() => AgenticHostPlatformOptionsSchema.parse(platform([platformRole("conversation"), platformRole("planner")], "director")))
      .toThrow("director layout platform roles must not include conversation");
    expect(AgenticHostPlatformOptionsSchema.parse(platform([platformRole("planner"), platformRole("developer")], "director")).layout).toBe("director");
  });
  it("legacy_v2 (explicit or absent) still requires Conversation and Coordinator", () => {
    expect(() => AgenticHostPlatformOptionsSchema.parse(platform([platformRole("conversation"), platformRole("planner")])))
      .toThrow("platform roles must include coordinator");
    expect(() => AgenticHostPlatformOptionsSchema.parse(platform([platformRole("conversation"), platformRole("planner")], "legacy_v2")))
      .toThrow("platform roles must include coordinator");
    expect(AgenticHostPlatformOptionsSchema.parse(platform([platformRole("conversation"), platformRole("coordinator")])).layout).toBeUndefined();
  });
  it("host configuration layout must agree with the platform layout and carry a bounded progress command", () => {
    expect(() => assertHostLayoutOptions({ layout: "director", platform: { layout: "director" }, progressCommand: ["bflow", "progress", "--follow"] })).not.toThrow();
    expect(() => assertHostLayoutOptions({})).not.toThrow();
    expect(() => assertHostLayoutOptions({ layout: "director", platform: {} })).toThrow("Host platform layout does not match host layout");
    expect(() => assertHostLayoutOptions({ platform: { layout: "director" } })).toThrow("Host platform layout does not match host layout");
    expect(() => assertHostLayoutOptions({ layout: "v3" })).toThrow("Invalid host layout");
    expect(() => assertHostLayoutOptions({ layout: "director", progressCommand: [] })).toThrow("Invalid host progress command");
    expect(() => assertHostLayoutOptions({ layout: "director", progressCommand: ["bflow", ""] })).toThrow("Invalid host progress command");
  });
});

describe("host roles and workspace composition", () => {
  const roles = ["conversation", "coordinator", "specifier", "planner", "developer"] as const;
  it("director layout hosts no Conversation/Coordinator role", () => {
    expect(hostRolesFor("director", roles)).toEqual(["specifier", "planner", "developer"]);
    expect(hostRolesFor(undefined, roles)).toEqual([...roles]);
    expect(hostRolesFor("legacy_v2", roles)).toEqual([...roles]);
  });
  it("selects the default agent kind from the first specialist role, else Claude", () => {
    expect(directorDefaultAgentKind([platformRole("planner", "codex"), platformRole("developer", "agy")])).toBe("codex");
    expect(directorDefaultAgentKind([platformRole("conversation", "agy"), platformRole("developer", "claude")])).toBe("claude");
    expect(directorDefaultAgentKind([platformRole("coordinator", "codex")])).toBe("claude");
    expect(directorDefaultAgentKind([])).toBe("claude");
  });
  it("workspace default agent kind: v2 keeps the Coordinator pane kind, v3 uses the host value", () => {
    expect(workspaceDefaultAgentKind(v2Manifest(), "codex")).toBe("claude");
    expect(workspaceDefaultAgentKind(v3Manifest(), "codex")).toBe("codex");
    expect(workspaceDefaultAgentKind(v3Manifest(), undefined)).toBe("claude");
  });
  it("manifest version must match the host layout", () => {
    expect(() => assertManifestLayout(v3Manifest(), "director")).not.toThrow();
    expect(() => assertManifestLayout(v2Manifest(), undefined)).not.toThrow();
    expect(() => assertManifestLayout(v2Manifest(), "director")).toThrow("Session manifest layout does not match host configuration");
    expect(() => assertManifestLayout(v3Manifest(), "legacy_v2")).toThrow("Session manifest layout does not match host configuration");
  });
  it("progress command comes from the manifest, then the host configuration", () => {
    expect(directorProgressCommand(v3Manifest(), ["other"])).toEqual(["bflow", "progress", "--follow"]);
    const { progressPane: _pane, ...rest } = v3Manifest() as Extract<SessionManifest, { schemaVersion: 3 }>;
    const initializing = SessionManifestSchema.parse({ ...rest, status: "initializing" });
    expect(directorProgressCommand(initializing, ["bflow", "progress"])).toEqual(["bflow", "progress"]);
    expect(() => directorProgressCommand(initializing, undefined)).toThrow("no progress pane command");
  });
  it("progress pane reconciliation never throws and records progress_pane_unavailable", async () => {
    const log = vi.fn(async () => undefined);
    expect(await ensureDirectorProgressPane({ ensureProgressPane: async () => ({ ok: true, value: {} }) }, log)).toBe(true);
    expect(await ensureDirectorProgressPane({ ensureProgressPane: async () => ({ ok: false, error: { code: "not_found", retryable: false, message: "gone" } }) }, log)).toBe(false);
    expect(await ensureDirectorProgressPane({ ensureProgressPane: async () => { throw new Error("herdr down"); } }, log)).toBe(false);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(call => (call as unknown as [{ action: string }])[0].action)).toEqual(["progress_pane_unavailable", "progress_pane_unavailable"]);
  });
});

describe("executeHostWatchdogPass in a Director session", () => {
  function setup(directorSession: boolean) {
    const now = Date.parse(T0) + 3 * 60 * 60_000;
    const runs = [{ runId: "run-1", status: "awaiting_approval", live: true, lastActivityAt: Date.parse(T0), awaitingHuman: false, activeHandoff: false,
      runtimeWork: false, acceptedRoles: [], acceptedPanes: [], pendingDecisions: [{ approvalId: "apr-1", requestedAt: T0 }],
      pendingDecisionRequests: [] }, { runId: "run-2", status: "implementing", live: true, lastActivityAt: Date.parse(T0), awaitingHuman: false,
      activeHandoff: false, runtimeWork: false, acceptedRoles: ["planner"], acceptedPanes: [], pendingDecisions: [], pendingDecisionRequests: [] }];
    const runtime = {
      resumeRecoverableRuns: vi.fn(async () => undefined),
      watchdogSnapshot: vi.fn(async () => runs as never),
      reportWorkflowBlocked: vi.fn(async () => undefined),
      reportRunStalled: vi.fn(async () => undefined),
      ports: { panes: { getManifest: vi.fn(async () => ({ ok: true as const, value: v3Manifest() })) } }
    };
    const receipts = {
      conversationNoticeStates: vi.fn(async () => [{ messageId: "decision-apr-1", approvalId: "apr-1", runId: "run-1", surfaced: true, displayed: false, resends: 0, since: T0 }]),
      appendConversationNotice: vi.fn(async () => true), resurfaceConversationNotice: vi.fn(async () => undefined)
    };
    const workspace = { runtime, conversation: { reconcileApprovals: vi.fn(async () => undefined) } };
    const pass = () => executeHostWatchdogPass({ readState: () => ({ workspace, manifest: v3Manifest(), quiesced: false, closing: false }),
      receipts, inbox: { forget: vi.fn() }, activeHostVerifications: new Map(), watchdogReported: new Set(), observeAgent: async () => ({ status: "idle" }),
      now, directorSession });
    return { runtime, receipts, pass };
  }
  it("skips display-ack notices but still resumes runs and reports stalls", async () => {
    const director = setup(true);
    await director.pass();
    expect(director.runtime.resumeRecoverableRuns).toHaveBeenCalledTimes(1);
    expect(director.receipts.conversationNoticeStates).not.toHaveBeenCalled();
    expect(director.receipts.appendConversationNotice).not.toHaveBeenCalled();
    expect(director.receipts.resurfaceConversationNotice).not.toHaveBeenCalled();
    expect(director.runtime.reportWorkflowBlocked).not.toHaveBeenCalled();
    expect(director.runtime.reportRunStalled).toHaveBeenCalledWith("run-2", expect.stringContaining("run-2@"));
  });
  it("a v2 session keeps the display-ack resurface path", async () => {
    const legacy = setup(false);
    await legacy.pass();
    expect(legacy.receipts.conversationNoticeStates).toHaveBeenCalled();
    expect(legacy.receipts.resurfaceConversationNotice).toHaveBeenCalledWith("decision-apr-1");
  });
});

const work = { key: "director:msg-user-1", title: "Thêm API", objective: "Thêm endpoint /health", kind: "feature" as const,
  acceptanceCriteria: [{ description: "GET /health trả 200", verificationMethod: "unit_test" as const }],
  sddLevel: "lightweight" as const, priority: "normal" as const, requestedAt: T0 };

describe("start_work in a Director session", () => {
  const build = buildDelegationRequest as unknown as DelegationBuilder;
  it("admits Runtime work as requestedBy director and never uses the Conversation bridge", async () => {
    const admitDirectorWork = vi.fn(async (request: unknown) => {
      const parsed = DelegationRequestSchema.parse(request);
      return { runId: parsed.runId!, correlationId: parsed.correlationId, admission: "new" as const };
    });
    const delegateDirectorWork = vi.fn();
    const log = vi.fn(async () => undefined);
    const result = await startDirectorWork({ manifest: v3Manifest, build, admitDirectorWork, log }, work);
    expect(delegateDirectorWork).not.toHaveBeenCalled();
    expect(admitDirectorWork).toHaveBeenCalledTimes(1);
    const request = DelegationRequestSchema.parse((admitDirectorWork.mock.calls[0] as unknown[])[0]);
    expect(request).toMatchObject({ requestedBy: "director", targetRole: "coordinator", sessionId: "conv-session-1", runId: result.runId,
      correlationId: result.correlationId, metadata: { origin: "director" } });
    expect(result.runId).toBe(`run-${result.correlationId}`);
    expect(result.status).toBe("queued");
    expect(log).toHaveBeenCalledWith({ kind: "tool", action: "director:start_work:completed", outcome: "implementation" });
    // Deterministic: the same key yields the identical delegation.
    await startDirectorWork({ manifest: v3Manifest, build, admitDirectorWork, log }, work);
    expect(DelegationRequestSchema.parse((admitDirectorWork.mock.calls[1] as unknown[])[0])).toEqual(request);
  });
  it("keeps the builder's structure apart from the Director overrides", () => {
    const built = buildDirectorWorkDelegation(build, work, "conv-session-1");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const reference = buildDelegationRequest({ sessionId: "conv-session-1", correlationId: built.value.correlationId, runId: built.value.runId,
      messageId: built.value.messageId, previousDelegationId: built.value.delegationId, idempotencyKey: built.value.idempotencyKey,
      requestedAt: T0, revision: 1, draft: { title: work.title, objective: work.objective, kind: work.kind, sddLevel: work.sddLevel, priority: work.priority,
        scopeDefined: true, isLargeTask: false, affectedPaths: [], acceptanceCriteriaDescriptions: [], acceptanceCriteria: work.acceptanceCriteria,
        isRequirementChange: false } } as never);
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(Object.keys(built.value).sort()).toEqual(Object.keys(reference.value).sort());
    expect({ ...built.value, requestedBy: "conversation", metadata: { ...built.value.metadata, origin: undefined } })
      .toEqual({ ...reference.value, metadata: { ...reference.value.metadata, origin: undefined } });
  });
  it("reports an admission refusal as start_work refused and logs director:start_work:failed", async () => {
    const log = vi.fn(async () => undefined);
    await expect(startDirectorWork({ manifest: v3Manifest, build, log,
      admitDirectorWork: async () => { throw new AdmissionRejectedError("Run is cancelled; requirement revisions are not accepted"); } }, work))
      .rejects.toThrow("start_work refused: Run is cancelled");
    expect(log).toHaveBeenCalledWith({ kind: "error", action: "director:start_work:failed", outcome: "validation" });
  });
  it("refuses outside an active Director manifest", async () => {
    const admitDirectorWork = vi.fn();
    const log = vi.fn(async () => undefined);
    await expect(startDirectorWork({ manifest: v2Manifest, build, admitDirectorWork, log }, work)).rejects.toThrow("Director work requires an active Director session");
    expect(admitDirectorWork).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", action: "director:start_work:failed" }));
  });
});

describe("Conversation notice mirror", () => {
  const blocked = RoleMessageSchema.parse({ schema_version: 2, message_id: "blocked-1", correlation_id: "corr-1", run_id: "run-42",
    sender: { role: "runtime" }, recipient: { role: "conversation" }, type: "conversation.progress", artifact_references: [],
    payload: { kind: "workflow_blocked", reason: "Handoff refused", runId: "run-42", headline: "Việc bị chặn" }, occurred_at: T0, idempotency_key: "blocked-1" });
  async function compose() {
    const root = await directory();
    const activity = TaskActivityLog.open(join(root, "task-activity.jsonl"));
    const receipts = new HostReceiptJournal(join(root, "receipts"), "/tmp/bflow-director-mode-repo", "session-1", activity);
    const endpoint = new DirectorEndpoint({ directory: join(root, "director"), repositoryRoot: root, feed: { read: () => ({ items: [] }) },
      inspect: async () => ({}), coordinator: { invoke: async () => null } });
    return { receipts, endpoint };
  }
  it("writes the receipt and a user-audience mailbox item with the #n code", async () => {
    const { receipts, endpoint } = await compose();
    const log = vi.fn(async () => undefined);
    const deps = { appendNotice: (message: never) => receipts.appendConversationNoticeReceipt(message),
      mirror: (message: never, rendered: { text: string; code?: string }) => endpoint.mirrorUserNotice(message, rendered), log };
    await recordConversationNotice(deps, blocked);
    await recordConversationNotice(deps, blocked);
    const items = await endpoint.readMailbox({ audience: "user" });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ audience: "user", messageId: "blocked-1", code: "#1", runId: "run-42" });
    expect(items[0]!.text?.length).toBeGreaterThan(0);
    expect(await endpoint.readMailbox({ audience: "director" })).toHaveLength(0);
    expect((await receipts.noticeAliases()).approvalShortIds).toEqual({});
    expect(log).not.toHaveBeenCalled();
  });
  it("a mirror failure is logged and never fails the notice; v2 has no mirror", async () => {
    const { receipts } = await compose();
    const log = vi.fn(async () => undefined);
    await expect(recordConversationNotice({ appendNotice: message => receipts.appendConversationNoticeReceipt(message),
      mirror: async () => { throw new Error("mailbox full"); }, log }, blocked)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", action: "director_notice_mirror_failed" }));
    const appendNotice = vi.fn(async () => ({ created: true, notice: { messageId: "x" } }));
    await recordConversationNotice({ appendNotice, mirror: undefined, log }, blocked);
    expect(appendNotice).toHaveBeenCalledTimes(1);
  });
});
