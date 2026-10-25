import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaneBinding } from "@bflow/contracts";
import { TaskActivityLog } from "../../src/agentic/task-activity-log.js";
import { handleTaskLogTool, taskLogAssignmentContext, toolActionHolderCandidates } from "../../src/agentic/task-log-tools.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const binding = (session = "native-1", role: PaneBinding["role"] = "developer"): PaneBinding => ({
  schemaVersion: 2, bindingId: "binding-dev", sessionId: "session-1", role, agentId: "dev-1", paneId: "pane-1",
  workspaceId: "workspace-1", tabId: "tab-1", provider: "codex", agentKind: "codex", cwd: "/repo",
  isolationMode: "dedicated_pane", readOnlyWorkspace: false, session: { source: "codex", kind: "id", value: session },
  transportState: "working", boundAt: "2026-10-20T00:00:00.000Z"
});
const state = (session = "native-1") => ({
  outbound: [{ status: "accepted", taskId: "task-1", attemptId: "attempt-1", message: { run_id: "run-1" },
    handle: { target: { paneId: "pane-1", agentId: "dev-1", session: { source: "codex", kind: "id", value: session } } } }],
  runs: [{ runId: "run-1", tasks: [{ taskId: "task-1" }] }]
});
async function fixture(logPath?: string) {
  const root = await mkdtemp(join(tmpdir(), "bflow-log-tools-")); roots.push(root);
  const activityLog = TaskActivityLog.open(logPath ?? join(root, "activity.jsonl"));
  const context = { role: "developer" as const, binding: binding(), activityLog, inspect: async () => state() };
  return { root, activityLog, context };
}

describe("authenticated task activity log tools", () => {
  it("reads the current specialist assignment and records a brief progress note", async () => {
    const f = await fixture();
    await f.activityLog.record({ kind: "assignment", role: "runtime", action: "task.assignment", runId: "run-1", taskId: "task-1" });
    await expect(handleTaskLogTool(f.context, "read_task_log", { runId: "run-1", taskId: "task-1" })).resolves.toMatchObject({ entries: [{ taskId: "task-1" }] });
    await expect(handleTaskLogTool(f.context, "log_task_step", { runId: "run-1", taskId: "task-1", action: "Committed the focused implementation" })).resolves.toMatchObject({ recorded: true });
    await expect(f.activityLog.read({ runId: "run-1", taskId: "task-1" })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "developer", action: "Committed the focused implementation" })
    ]));
  });

  it("rejects foreign run/task filters and stale native-session assignments", async () => {
    const f = await fixture();
    await expect(handleTaskLogTool(f.context, "read_task_log", { runId: "run-other", taskId: "task-1" })).rejects.toThrow("outside this pane");
    await expect(handleTaskLogTool(f.context, "log_task_step", { runId: "run-1", taskId: "task-other", action: "work" })).rejects.toThrow("outside this pane");
    const stale = { ...f.context, binding: binding("native-old") };
    await expect(handleTaskLogTool(stale, "read_task_log", { runId: "run-1", taskId: "task-1" })).rejects.toThrow("outside this pane");
    await expect(handleTaskLogTool(stale, "log_task_step", { runId: "run-1", taskId: "task-1", action: "work" })).rejects.toThrow("outside this pane");
  });

  it("attributes a completed reply to its exact historical assignment rather than a newer attempt", () => {
    const observed = state();
    Object.assign(observed.outbound[0]!.message, { message_id: "assignment-old", correlation_id: "correlation-1" });
    observed.outbound.push({ ...observed.outbound[0]!, attemptId: "attempt-new", message: { ...observed.outbound[0]!.message, message_id: "assignment-new" } });
    expect(taskLogAssignmentContext(observed, binding(), { runId: "run-1", assignmentMessageId: "assignment-old", correlationId: "correlation-1" })?.attemptId).toBe("attempt-1");
    expect(taskLogAssignmentContext(observed, binding(), { runId: "run-1", assignmentMessageId: "assignment-old", correlationId: "foreign" })).toBeUndefined();
  });
  it("requires specialist progress notes to name their task so the note is readable back", async () => {
    const f = await fixture();
    await expect(handleTaskLogTool(f.context, "log_task_step", { runId: "run-1", action: "started implementation" })).rejects.toThrow("taskId");
    await expect(handleTaskLogTool(f.context, "log_task_step", { runId: "run-1", taskId: "task-1", action: "started implementation" })).resolves.toMatchObject({ recorded: true });
    await expect(f.activityLog.read({ runId: "run-1", taskId: "task-1" })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "started implementation", taskId: "task-1" })
    ]));
  });

  it("lets Coordinator filter by a task within a current run, and refuses another run/task", async () => {
    const f = await fixture();
    const coordinator = { ...f.context, role: "coordinator" as const, binding: binding("coord-1", "coordinator") };
    await expect(handleTaskLogTool(coordinator, "read_task_log", { runId: "run-1", taskId: "task-1" })).resolves.toMatchObject({ entries: [] });
    await expect(handleTaskLogTool(coordinator, "read_task_log", { runId: "run-1", taskId: "task-other" })).rejects.toThrow("outside this Runtime run");
    await expect(handleTaskLogTool(coordinator, "read_task_log", { runId: "run-other", taskId: "task-1" })).rejects.toThrow("outside this Runtime session");
  });

  it("enforces read bounds and keeps business tool success when diagnostic storage fails", async () => {
    const f = await fixture();
    await expect(handleTaskLogTool(f.context, "read_task_log", { runId: "run-1", taskId: "task-1", lines: 101 })).rejects.toThrow("bounds");
    await expect(handleTaskLogTool(f.context, "read_task_log", { runId: "run-1", taskId: "task-1", maxBytes: 16_385 })).rejects.toThrow("bounds");
    await expect(handleTaskLogTool(f.context, "log_task_step", { runId: "run-1", taskId: "task-1", action: "x".repeat(121) })).rejects.toThrow("120 characters");
    const broken = { ...f.context, activityLog: TaskActivityLog.open(f.root) };
    await expect(handleTaskLogTool(broken, "log_task_step", { runId: "run-1", taskId: "task-1", action: "still succeeds" })).resolves.toMatchObject({ recorded: false });
  });

  it("provides native tool-log context only for the exact bound pane and session", () => {
    expect(taskLogAssignmentContext(state(), binding())).toEqual({ runId: "run-1", taskId: "task-1", attemptId: "attempt-1" });
    expect(taskLogAssignmentContext(state(), binding("old-native"))).toBeUndefined();
  });

  it("selects only one currently accepted handoff holder for mediated tool actions", () => {
    const pane = binding();
    const holder = { status: "accepted", message: { type: "verification.requested", recipient: { role: "developer", agent_id: "dev-1", pane_id: "pane-1" } },
      request: { requestId: "request-1" }, lease: { leaseId: "lease-1" },
      handle: { target: { paneId: "pane-1", agentId: "dev-1", workspaceId: "workspace-1", tabId: "tab-1", session: pane.session } } };
    expect(toolActionHolderCandidates({ outbound: [holder, { ...holder, status: "released" }] }, pane)).toEqual([holder]);
    expect(toolActionHolderCandidates({ outbound: [{ ...holder, status: "unknown_delivery" }] }, pane)).toEqual([]);
    expect(toolActionHolderCandidates({ outbound: [holder, { ...holder, request: { requestId: "request-2" } }] }, pane)).toHaveLength(2);
    expect(toolActionHolderCandidates({ outbound: [holder] }, binding("stale-native"))).toEqual([]);
  });

  it.each(["phase-task-1-red", "check-review-1"])("groups verification assignment %s by its business task", async transportTaskId => {
    const f = await fixture();
    const observed = state();
    observed.outbound[0]!.taskId = transportTaskId;
    Object.assign(observed.outbound[0]!.message, { type: "verification.requested", payload: { taskId: "task-1" } });
    const role = transportTaskId.startsWith("check-") ? "reviewer" as const : "qa" as const;
    const qa = { ...f.context, role, binding: { ...binding(), role }, inspect: async () => observed };
    await f.activityLog.record({ kind: "verification", role: "runtime", action: "verify", runId: "run-1", taskId: "task-1" });
    await expect(handleTaskLogTool(qa, "read_task_log", { runId: "run-1", taskId: "task-1" })).resolves.toMatchObject({ entries: [{ taskId: "task-1" }] });
    await expect(handleTaskLogTool(qa, "log_task_step", { runId: "run-1", taskId: transportTaskId, action: "Reviewing accepted criteria" })).resolves.toMatchObject({ recorded: true });
    expect(await f.activityLog.read({ runId: "run-1", taskId: "task-1" })).toEqual(expect.arrayContaining([expect.objectContaining({ action: "Reviewing accepted criteria", taskId: "task-1" })]));
    expect(taskLogAssignmentContext(observed, qa.binding)).toMatchObject({ taskId: "task-1" });
    await expect(handleTaskLogTool(qa, "read_task_log", { runId: "run-1", taskId: "other-task" })).rejects.toThrow("outside this pane");
  });
});
