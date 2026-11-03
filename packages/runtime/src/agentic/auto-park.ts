import { taskLogBusinessTaskId } from "./task-log-tools.js";
import { VerificationCycleSchema, VerificationResultSchema, GitChangeSetSchema, type AgentExecutionHandle, type ParkedIssueKind, type WorkflowRunSnapshot } from "@bflow/contracts";
import type { JournalState, Outbound, RunRecord, TaskRecord } from "./journal.js";
import { digest } from "./journal.js";

export interface AutoParkPolicy { enabled: boolean; maxAutoResumesBeforePark: number }
export interface AutoParkState extends Pick<JournalState, "runs" | "outbound" | "pendingVerifications"> {
  snapshots: Readonly<Record<string, WorkflowRunSnapshot>>;
}
export interface AutoParkCandidate {
  runId: string; taskId: string; kind: ParkedIssueKind; reason: string; episodeKey: string; resumeAttempts: number; evidence: string[];
}
export const STRUCTURAL_DELIVERY_BLOCKERS = /^(Recipient pane unavailable|No capable agent in recipient pane|Pinned request or recipient changed|Recipient [\w-]+ not ready since )/;
export const VERIFICATION_ATTEMPT_LIMIT = 3;
const FINAL_TASK = "workflow-verification";
const summaries: Record<ParkedIssueKind, string> = {
  transport_failure: "Task bị kẹt hoặc lỗi giao sau khi hết số lần tự phục hồi.",
  provider_failure: "Provider đã hết ngân sách chuyển hoặc chưa dừng được execution cũ.",
  rework_exhausted: "Task đã hết số lần sửa lại; cần xem dossier và làm rõ tiêu chí.",
  verification_exhausted: "Kiểm chứng task đã hết số lần thử; cần sửa môi trường trước khi thử lại.",
  user_decision_pending: "Task đang chờ quyết định của người dùng.",
  environment: "Môi trường thực thi cần được kiểm tra.",
  other: "Assignment liên tục gửi tin không hợp lệ; cần kiểm tra trước khi thử lại."
};
export const autoParkSuggestedAction: Record<ParkedIssueKind, string> = {
  transport_failure: "Kiểm tra pane vai trong Herdr rồi bflow queue retry <id>",
  provider_failure: "Kiểm tra hạn mức/đăng nhập provider rồi retry",
  rework_exhausted: "Xem dossier rework; tách task hoặc làm rõ tiêu chí rồi retry",
  verification_exhausted: "Chạy lại verification sau khi sửa môi trường",
  user_decision_pending: "Trả lời quyết định đang chờ",
  environment: "Kiểm tra môi trường rồi retry",
  other: "Kiểm tra tin nhắn của assignment rồi retry"
};
function jobField(job: unknown, key: string): unknown { return job !== null && typeof job === "object" ? Reflect.get(job, key) : undefined; }
/** A durable, schema-valid outcome of the current coroutine is the only verification wait park may settle. */
export function exhaustedTaskVerification(item: JournalState["pendingVerifications"][number], run: RunRecord, task: TaskRecord, attemptId: string | undefined): boolean {
  if (!item.stuck || (item.attempts ?? 0) < VERIFICATION_ATTEMPT_LIMIT || !attemptId || !task.cycle || !task.changeSet) return false;
  const cycle = VerificationCycleSchema.safeParse(jobField(item.outcome, "cycle"));
  const result = VerificationResultSchema.safeParse(jobField(item.outcome, "result"));
  const sourceCycle = VerificationCycleSchema.safeParse(jobField(item.job, "cycle"));
  const change = GitChangeSetSchema.safeParse(jobField(item.job, "change"));
  return cycle.success && sourceCycle.success && result.success && change.success &&
    jobField(item.job, "runId") === run.runId && jobField(item.job, "taskId") === task.taskId &&
    jobField(jobField(item.job, "plan"), "scope") === "task" &&
    [cycle.data, sourceCycle.data, result.data, change.data].every(value => value.runId === run.runId && value.taskId === task.taskId) &&
    cycle.data.cycleId === task.cycle.cycleId && sourceCycle.data.cycleId === task.cycle.cycleId &&
    digest(sourceCycle.data) === digest(task.cycle) && cycle.data.specId === task.spec.specification.specId &&
    sourceCycle.data.specId === task.spec.specification.specId &&
    result.data.attemptId === attemptId && change.data.attemptId === attemptId && task.changeSet.attemptId === attemptId &&
    change.data.changeSetId === task.changeSet.changeSetId && result.data.changeSet?.changeSetId === task.changeSet.changeSetId;
}
export function autoParkRelated(state: AutoParkState, run: RunRecord, taskId: string): Outbound[] {
  return state.outbound.filter(out => out.message.run_id === run.runId && (out.taskId === taskId || taskLogBusinessTaskId(out) === taskId));
}
function proofMatches(proof: Outbound["cancellationStopProof"], handle: AgentExecutionHandle, now: number): boolean {
  return !!proof && digest(proof.handle) === digest(handle) && Date.parse(proof.observedAt) >= Date.parse(handle.acceptedAt) && Date.parse(proof.observedAt) <= now;
}
function stopped(out: Outbound, task: TaskRecord, now: number): boolean {
  if (!out.handle) return true;
  const proof = out.parkStop?.proof ?? out.cancellationStopProof ?? task.failovers?.find(entry =>
    digest(entry.sourceHandle) === digest(out.handle) && entry.stopProof)?.stopProof;
  return proofMatches(proof, out.handle, now);
}
function exhaustedRework(run: RunRecord, task: TaskRecord, current: WorkflowRunSnapshot["tasks"][number]): boolean {
  const cycle = task.cycle;
  return !!current.attemptId && current.status === "blocked" && ["quality_gate", "manual_intervention"].includes(current.blockage?.code ?? "") &&
    cycle?.status === "escalated" && cycle.currentIteration >= cycle.maxIterations &&
    cycle.runId === run.runId && cycle.taskId === task.taskId && cycle.specId === task.spec.specification.specId && cycle.history.at(-1)?.attemptId === current.attemptId &&
    task.changeSet?.attemptId === current.attemptId && run.definition?.tasks.find(item => item.id === task.taskId)?.rework?.onExhausted === "require_human";
}
/** Strict selection: delivery/human/proof checks are read-only and never infer success from transport state. */
export function selectAutoParkCandidates(state: AutoParkState, policy: AutoParkPolicy, now: number): AutoParkCandidate[] {
  return select(state, policy, now, false);
}
/** Preparation is allowed to request a stop, but never to park/release a live execution. All other fences are identical. */
export function selectAutoParkStopCandidates(state: AutoParkState, policy: AutoParkPolicy, now: number): AutoParkCandidate[] {
  return select(state, policy, now, true);
}
function select(state: AutoParkState, policy: AutoParkPolicy, now: number, preparing: boolean): AutoParkCandidate[] {
  if (!policy.enabled || !Number.isFinite(now)) return [];
  const candidates: AutoParkCandidate[] = [];
  for (const run of state.runs) {
    if (run.delegation.requestedBy !== "director" || run.cancelled || run.supersededBy ||
        ["cancelled", "failed", "completed"].includes(run.status) || run.nativeDeliveries?.length) continue;
    for (const task of run.tasks) {
      const current = state.snapshots[run.runId]?.tasks.find(item => item.taskId === task.taskId);
      if (task.taskId === FINAL_TASK || !run.definition?.tasks.some(item => item.id === task.taskId) || !current || task.parked ||
          !["pending", "ready", "blocked", "waiting", "running"].includes(current.status)) continue;
      const activeFailovers = task.failovers?.filter(entry => !["dispatched", "cancelled"].includes(entry.phase)) ?? [];
      const exhaustedFailover = activeFailovers.some(entry => entry.phase === "blocked" &&
        ["switch_budget_exhausted", "old_execution_stop_budget_exhausted"].includes(entry.reason ?? ""));
      // Other continuation holds need their own reconciliation or owner action; a manual action is not a spent switch budget.
      if (activeFailovers.length && !exhaustedFailover) continue;
      const related = autoParkRelated(state, run, task.taskId);
      if (related.some(out => ["unknown_delivery", "sending"].includes(out.status))) continue;
      if (run.approval?.status === "pending" && run.decision?.approvalId !== run.approval.approvalId &&
          (run.approval.target.type !== "task" || run.approval.target.taskId === task.taskId) ||
          Object.values(run.userDecisions ?? {}).some(item => item.status === "pending" && item.taskId === task.taskId)) continue;
      const pending = state.pendingVerifications.filter(item => jobField(item.job, "runId") === run.runId && jobField(item.job, "taskId") === task.taskId);
      if (pending.some(item => !exhaustedTaskVerification(item, run, task, current.attemptId)) || task.verificationPending && !pending.length) continue;
      const executions = related.filter(out => !out.parentAssignmentId && out.handle && (out.status === "accepted" || out.handle.executionId === current.agentExecution?.executionId));
      if (!preparing && (executions.some(out => !stopped(out, task, now)) || current.agentExecution &&
          !executions.some(out => digest(out.handle) === digest(current.agentExecution) && stopped(out, task, now)) ||
          task.failovers?.some(entry => !["dispatched", "cancelled"].includes(entry.phase) && !proofMatches(entry.stopProof, entry.sourceHandle, now) &&
            !executions.some(out => out.handle?.executionId === entry.sourceHandle.executionId && stopped(out, task, now))))) continue;
      let kind: ParkedIssueKind | undefined;
      if (exhaustedFailover) kind = "provider_failure";
      else if (exhaustedRework(run, task, current)) kind = "rework_exhausted";
      else if (pending.some(item => item.stuck && (item.attempts ?? 0) >= VERIFICATION_ATTEMPT_LIMIT)) kind = "verification_exhausted";
      else {
        const action = run.pendingAction;
        const source = action && related.find(out => out.message.message_id === action.sourceMessageId);
        if (run.status === "escalated" && action?.state === "pending" && source &&
            ["task.assignment", "verification.requested"].includes(source.message.type) && taskLogBusinessTaskId(source) === task.taskId &&
            (action.recovery === "manual" || action.recovery === "auto_resume" && (action.resumeAttempts ?? 0) >= policy.maxAutoResumesBeforePark))
          kind = STRUCTURAL_DELIVERY_BLOCKERS.test(action.reason) ? "transport_failure" : action.reason.includes("refused messages") ? "other" : "transport_failure";
      }
      if (!kind) continue;
      const episode = Math.max(0, ...(task.parkHistory ?? []).map(item => item.episode)) + 1;
      candidates.push({ runId: run.runId, taskId: task.taskId, kind, reason: summaries[kind], episodeKey: `${run.runId}:${task.taskId}:${episode}`,
        resumeAttempts: run.pendingAction?.resumeAttempts ?? 0, evidence: (task.reworkResolutions ?? []).map(item => item.artifactRef.uri) });
    }
  }
  return candidates;
}
