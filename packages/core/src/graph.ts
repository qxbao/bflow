import type {
  ApprovalDecision,
  QualityGateBinding,
  TaskDependency,
  TaskState,
  WorkflowDefinition,
  WorkflowRunSnapshot
} from "@bflow/contracts";

export interface GateOutcome {
  readonly taskId?: string;
  readonly gateId: string;
  readonly phase: QualityGateBinding["phase"];
  readonly generation: number;
  readonly attemptId?: string;
  readonly status: "passed" | "failed" | "blocked" | "error";
}

export interface SchedulingContext {
  readonly approvals: ReadonlyMap<string, ApprovalDecision>;
  readonly gates: readonly GateOutcome[];
}

export interface DependencyIndex {
  readonly prerequisites: ReadonlyMap<string, readonly TaskDependency[]>;
  readonly dependents: ReadonlyMap<string, readonly TaskDependency[]>;
}

const completedStatuses = new Set<TaskState["status"]>(["succeeded", "failed", "cancelled"]);
const capacityStatuses = new Set<TaskState["status"]>(["running", "waiting", "blocked", "cancelling"]);

export function buildDependencyIndex(definition: WorkflowDefinition): DependencyIndex {
  const prerequisites = new Map<string, TaskDependency[]>();
  const dependents = new Map<string, TaskDependency[]>();
  for (const task of definition.tasks) {
    prerequisites.set(task.id, []);
    dependents.set(task.id, []);
  }
  for (const dependency of definition.dependencies) {
    prerequisites.get(dependency.taskId)?.push(dependency);
    dependents.get(dependency.dependsOnTaskId)?.push(dependency);
  }
  return { prerequisites, dependents };
}

export function approvalKey(taskId: string, generation: number): string {
  return `${taskId}\u0000${generation}`;
}

export function taskApprovalSatisfied(
  definition: WorkflowDefinition,
  task: TaskState,
  approvals: ReadonlyMap<string, ApprovalDecision>
): boolean {
  const taskDefinition = definition.tasks.find((candidate) => candidate.id === task.taskId);
  if (taskDefinition?.requiresApproval !== true) return true;
  return approvals.get(approvalKey(task.taskId, task.generation))?.decision === "approved";
}

export function requiredGatesSatisfied(
  definition: WorkflowDefinition,
  task: TaskState,
  gates: readonly GateOutcome[],
  phases: readonly QualityGateBinding["phase"][]
): boolean {
  const taskDefinition = definition.tasks.find((candidate) => candidate.id === task.taskId);
  if (taskDefinition === undefined) return false;
  return taskDefinition.qualityGates
    .filter((binding) => binding.required && phases.includes(binding.phase))
    .every((binding) =>
      gates.some(
        (gate) =>
          gate.taskId === task.taskId &&
          gate.gateId === binding.gateId &&
          gate.phase === binding.phase &&
          gate.generation === task.generation &&
          gate.attemptId === task.attemptId &&
          gate.status === "passed"
      )
    );
}

export function taskBusinessSucceeded(
  definition: WorkflowDefinition,
  task: TaskState,
  context: SchedulingContext
): boolean {
  return (
    task.status === "succeeded" &&
    taskApprovalSatisfied(definition, task, context.approvals) &&
    requiredGatesSatisfied(definition, task, context.gates, ["after_result", "before_completion"])
  );
}

export function dependenciesSatisfied(
  definition: WorkflowDefinition,
  snapshot: WorkflowRunSnapshot,
  taskId: string,
  context: SchedulingContext,
  index = buildDependencyIndex(definition)
): boolean {
  const states = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
  return (index.prerequisites.get(taskId) ?? []).every((dependency) => {
    const prerequisite = states.get(dependency.dependsOnTaskId);
    if (prerequisite === undefined) return false;
    if (dependency.condition === "completed") return completedStatuses.has(prerequisite.status);
    return taskBusinessSucceeded(definition, prerequisite, context);
  });
}

export function dependencyPermanentlyUnsatisfied(
  definition: WorkflowDefinition,
  snapshot: WorkflowRunSnapshot,
  taskId: string,
  context: SchedulingContext,
  index = buildDependencyIndex(definition)
): boolean {
  const states = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
  return (index.prerequisites.get(taskId) ?? []).some((dependency) => {
    if (dependency.condition === "completed") return false;
    const prerequisite = states.get(dependency.dependsOnTaskId);
    if (prerequisite === undefined) return false;
    if (prerequisite.status === "failed" || prerequisite.status === "cancelled") return true;
    if (prerequisite.status !== "succeeded") return false;
    const decision = context.approvals.get(approvalKey(prerequisite.taskId, prerequisite.generation))?.decision;
    if (decision === "rejected") return true;
    if (decision !== "changes_requested") return false;
    const policy = definition.tasks.find((task) => task.id === prerequisite.taskId)?.rework;
    return prerequisite.generation >= (policy?.maxReworks ?? 0) && (policy?.onExhausted ?? "fail") === "fail";
  });
}

export function selectRunnableTasks(
  definition: WorkflowDefinition,
  snapshot: WorkflowRunSnapshot,
  context: SchedulingContext
): readonly string[] {
  const active = snapshot.tasks.filter((task) => capacityStatuses.has(task.status)).length;
  const available = Math.max(0, definition.maxConcurrency - active);
  if (available === 0) return [];
  const index = buildDependencyIndex(definition);

  return definition.tasks
    .map((task) => snapshot.tasks.find((state) => state.taskId === task.id))
    .filter((task): task is TaskState => task !== undefined && task.status === "ready")
    .filter((task) => dependenciesSatisfied(definition, snapshot, task.taskId, context, index))
    .filter((task) => requiredGatesSatisfied(definition, task, context.gates, ["before_dispatch"]))
    .slice(0, available)
    .map((task) => task.taskId);
}

export function isTerminalTaskStatus(status: TaskState["status"]): boolean {
  return completedStatuses.has(status);
}
