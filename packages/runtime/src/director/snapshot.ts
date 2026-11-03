import {
  AgentRoleSchema,
  DirectorProgressRunSchema,
  DirectorProgressSnapshotSchema,
  DirectorProgressTaskSchema,
  SdlcWorkStatusSchema,
  TaskStatusSchema,
  type DirectorPresence,
  type DirectorProgressRun,
  type DirectorProgressSnapshot,
  type DirectorProgressTask,
  type DirectorSession,
  type ParkedIssue
} from "@bflow/contracts";

export interface DirectorSnapshotInput {
  /** Raw AgenticWorkflowRuntime.inspect() state: `{ runs, outbound, inbox }`. */
  readonly state: unknown;
  readonly presence: DirectorPresence;
  readonly session: DirectorSession | null;
  readonly issues: readonly ParkedIssue[];
  readonly now: Date;
}

const MAX_RUNS = 100;
const MAX_TASKS = 1000;
const TERMINAL_RUN = new Set(["completed", "failed", "cancelled"]);

const rec = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);
const cut = (value: string, max: number): string => (value.length > max ? value.slice(0, max) : value);

/**
 * Journal tasks carry no TaskStatus (Core owns it), so an explicit `status` is used when valid and otherwise the status is derived
 * from the task's result and verification cycle. Fields searched for pending counts: run.approval/run.decision (approvals) and
 * run.userDecisions[*].status === "pending" (questions).
 */
function taskStatus(task: Record<string, unknown>): ReturnType<typeof TaskStatusSchema.safeParse> {
  if (task.status !== undefined) return TaskStatusSchema.safeParse(task.status);
  const result = text(rec(task.result).status);
  const cycle = text(rec(task.cycle).status);
  if (result === "succeeded") return TaskStatusSchema.safeParse(cycle === "passed" ? "succeeded" : "running");
  if (result === "failed" || cycle === "failed") return TaskStatusSchema.safeParse("failed");
  if (result === "blocked" || cycle === "blocked" || cycle === "escalated") return TaskStatusSchema.safeParse("blocked");
  if (cycle === "rework_required") return TaskStatusSchema.safeParse("retrying");
  if (Array.isArray(task.outboundIds) && task.outboundIds.length > 0) return TaskStatusSchema.safeParse("running");
  return TaskStatusSchema.safeParse("pending");
}

// TaskStatusSchema values that end a task; every other status is live.
const TERMINAL_TASK: ReadonlySet<string> = new Set(["succeeded", "failed", "cancelled"]);

function buildTask(value: unknown, roles: ReadonlyMap<string, string>, runEnded: boolean): DirectorProgressTask | undefined {
  const task = rec(value);
  const taskKey = text(task.taskId);
  const status = taskStatus(task);
  if (!taskKey || !status.success) return undefined;
  // A run that has ended cannot have live tasks: show what was left unfinished as cancelled.
  if (runEnded && !TERMINAL_TASK.has(status.data)) status.data = "cancelled";
  const spec = rec(rec(task.spec).specification);
  const role = AgentRoleSchema.safeParse(roles.get(taskKey));
  const parsed = DirectorProgressTaskSchema.safeParse({
    taskKey,
    title: cut(text(spec.title) ?? taskKey, 200),
    status: status.data,
    ...(role.success ? { role: role.data } : {})
  });
  return parsed.success ? parsed.data : undefined;
}

function buildRun(value: unknown): DirectorProgressRun | undefined {
  const run = rec(value);
  const runId = text(run.runId);
  if (!runId) return undefined;
  const definition = rec(run.definition);
  const roles = new Map<string, string>();
  if (Array.isArray(definition.tasks)) {
    for (const def of definition.tasks) {
      const d = rec(def);
      const id = text(d.id);
      const role = text(d.role);
      if (id && role) roles.set(id, role);
    }
  }
  const tasks: DirectorProgressTask[] = [];
  if (Array.isArray(run.tasks)) {
    for (const raw of run.tasks) {
      if (tasks.length >= MAX_TASKS) break;
      const built = buildTask(raw, roles, run.cancelled === true || TERMINAL_RUN.has(String(run.status)));
      if (built) tasks.push(built);
    }
  }
  const title = text(rec(rec(run.workflowSpec).specification).title) ?? text(definition.name) ?? text(definition.id) ?? runId;
  const status = SdlcWorkStatusSchema.safeParse(run.status);
  const parsed = DirectorProgressRunSchema.safeParse({
    runId,
    title: cut(title, 200),
    sdlcStatus: status.success ? status.data : "intake",
    tasks
  });
  return parsed.success ? parsed.data : undefined;
}

/** Pure projection of Runtime inspect state to a bounded progress snapshot. Malformed runs/tasks are skipped, never thrown on. */
export function buildDirectorProgressSnapshot(input: DirectorSnapshotInput): DirectorProgressSnapshot {
  const rawRuns = Array.isArray(rec(input.state).runs) ? (rec(input.state).runs as unknown[]) : [];
  const recent = rawRuns.slice(-MAX_RUNS);
  const runs: DirectorProgressRun[] = [];
  let pendingApprovals = 0;
  let pendingQuestions = 0;
  for (const raw of recent) {
    const built = buildRun(raw);
    if (!built) continue;
    runs.push(built);
    const run = rec(raw);
    if (run.cancelled === true || TERMINAL_RUN.has(String(run.status))) continue;
    const approval = rec(run.approval);
    if (text(approval.approvalId) && rec(run.decision).approvalId !== approval.approvalId) pendingApprovals += 1;
    for (const entry of Object.values(rec(run.userDecisions))) if (rec(entry).status === "pending") pendingQuestions += 1;
  }
  return DirectorProgressSnapshotSchema.parse({
    schemaVersion: 1,
    generatedAt: input.now.toISOString(),
    director: {
      presence: input.presence,
      ...(input.session ? { provider: input.session.provider, heartbeatAt: input.session.heartbeatAt } : {})
    },
    runs,
    pendingApprovals,
    pendingQuestions,
    issues: input.issues
  });
}
