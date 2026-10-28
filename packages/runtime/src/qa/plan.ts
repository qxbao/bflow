import { WorkflowDefinitionSchema, type WorkflowDefinition } from "@bflow/contracts";
import { QaTaskKindSchema, type QaIntake, type QaTaskKind } from "./model.js";

export const QA_WORKFLOW_ID = "bflow.qa-only";
export const QA_WORKFLOW_VERSION = "1";
export const QA_GATES = {
  design: "qa-design-verification",
  review: "qa-independent-review",
  execution: "qa-execution-integrity",
  adjudication: "qa-adjudication",
  report: "qa-report-integrity"
} as const;

/** Only these role/kind pairs may appear: there is no implementation, fix, deploy or install kind at all. */
const KIND_ROLES: Readonly<Record<QaTaskKind, readonly string[]>> = {
  design: ["tester", "qa"],
  "design-review": ["reviewer", "qa"],
  // Execution and the report are performed by Runtime through granted tools and workspace writes; no agent touches the target.
  execution: ["coordinator"],
  adjudication: ["qa", "reviewer"],
  report: ["coordinator"]
};
const ORDER: readonly QaTaskKind[] = ["design", "design-review", "execution", "adjudication", "report"];
const FORBIDDEN_TASK_METADATA = ["ownedPaths", "commands", "worktree", "branch", "install", "deploy", "patch", "conditionalTdd"];

export class QaWorkflowRejected extends Error {
  constructor(readonly code: "forbidden_task" | "invalid_dag" | "unsupported_definition", message: string) {
    super(message);
    this.name = "QaWorkflowRejected";
  }
}

const INSTRUCTIONS: Readonly<Record<QaTaskKind, string>> = {
  design: "Design test cases for the product criteria using only the approved origins and actions. Mutating cases need an isolated " +
    "fixture account, the ${fixturePrefix} data marker, cleanup and a read-only reconciliation probe. Never access the target yourself.",
  "design-review": "Independently review the test design: oracles match the criteria, scope and side effects are safe, cleanup is complete. Pin your verdict to its digest.",
  execution: "Runtime executes the approved test assets through granted tools under a resource lease.",
  adjudication: "Classify each executed case. Assertion failures are product_failure or test_defect with a rationale; Runtime-determined outcomes cannot be overridden.",
  report: "Runtime publishes the bug and evidence report in the test workspace. Finding a bug grants no authority to fix it."
};

function task(kind: QaTaskKind, role: string, intake: QaIntake, maxAttempts: number) {
  const gate = { design: QA_GATES.design, "design-review": QA_GATES.review, execution: QA_GATES.execution,
    adjudication: QA_GATES.adjudication, report: QA_GATES.report }[kind];
  return {
    id: kind, title: `QA ${kind}`, role, instruction: INSTRUCTIONS[kind],
    acceptanceCriteria: intake.criteria.map(item => item.id),
    retry: { maxAttempts, strategy: "fixed" as const, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
    rework: { maxReworks: 0, onExhausted: "require_human" as const },
    timeout: { executionTimeoutMs: 900_000, onTimeout: "block" as const },
    // The human approves the reviewed design before any side effect on the target.
    requiresApproval: kind === "design-review",
    qualityGates: [{ gateId: gate, phase: kind === "design" || kind === "adjudication" ? "before_completion" as const : "after_result" as const, required: true }],
    metadata: { qaKind: kind }
  };
}

/** Coordinator default plan: test design → independent review → execution → adjudication → bug/evidence report. */
export function planQaWorkflow(intake: QaIntake, maxIterations = 3): WorkflowDefinition {
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) throw new QaWorkflowRejected("unsupported_definition", "Invalid verification limit");
  const tasks = [
    task("design", "tester", intake, maxIterations),
    task("design-review", "reviewer", intake, 2),
    task("execution", "coordinator", intake, 1),
    task("adjudication", "qa", intake, maxIterations),
    task("report", "coordinator", intake, 1)
  ];
  return WorkflowDefinitionSchema.parse({
    schemaVersion: "1", id: QA_WORKFLOW_ID, name: `QA: ${intake.title}`, version: QA_WORKFLOW_VERSION,
    tasks, dependencies: ORDER.slice(1).map((kind, index) => ({ taskId: kind, dependsOnTaskId: ORDER[index]!, condition: "succeeded" as const })),
    qualityGates: qaGates(), maxConcurrency: 1, failurePolicy: "block",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" },
    metadata: { qaRequestId: intake.requestId, revision: intake.revision, environmentId: intake.target.environmentId }
  });
}

function qaGates() {
  const gate = (id: string, name: string, retry: boolean) => ({ id, name, evaluator: `qa:${id}`, required: true,
    timeout: { executionTimeoutMs: 60_000, onTimeout: "block" as const }, ...(retry ? { metadata: { boundedVerificationRetry: true } } : {}) });
  return [
    gate(QA_GATES.design, "Test design scope, coverage and safety", true),
    gate(QA_GATES.review, "Independent test design review", false),
    gate(QA_GATES.execution, "Execution integrity (lease, mutations, product unchanged)", false),
    gate(QA_GATES.adjudication, "Result adjudication consistency", true),
    gate(QA_GATES.report, "Report integrity", false)
  ];
}

/**
 * Validates a Coordinator-proposed DAG against QA-only policy and returns it with Runtime-owned gates, retry bounds and
 * the design approval point. Implementation/fix roles, write/command metadata, agent gates and missing stages are refused.
 */
export function assertQaOnlyWorkflow(input: unknown, intake: QaIntake, maxIterations = 3): WorkflowDefinition {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new QaWorkflowRejected("unsupported_definition", "Invalid workflow definition");
  const definition = parsed.data;
  if (definition.id !== QA_WORKFLOW_ID || definition.version !== QA_WORKFLOW_VERSION)
    throw new QaWorkflowRejected("unsupported_definition", "Workflow is not the QA-only workflow");
  if (definition.qualityGates.length || definition.tasks.some(item => item.qualityGates.length))
    throw new QaWorkflowRejected("forbidden_task", "QA gates are Runtime-owned; agent-defined gates are refused");
  const planned = planQaWorkflow(intake, maxIterations);
  const roles = new Map<string, string>();
  for (const item of definition.tasks) {
    const kind = QaTaskKindSchema.safeParse((item.metadata as Record<string, unknown> | undefined)?.qaKind);
    if (!kind.success) throw new QaWorkflowRejected("forbidden_task", `Task ${item.id} is not a QA task; implementation, fix, deploy and install work is not allowed`);
    if (item.id !== kind.data) throw new QaWorkflowRejected("invalid_dag", `Task ${item.id} must be named after its kind ${kind.data}`);
    if (!KIND_ROLES[kind.data].includes(item.role))
      throw new QaWorkflowRejected("forbidden_task", `Task ${item.id}: role '${item.role}' cannot perform ${kind.data}`);
    const forbidden = FORBIDDEN_TASK_METADATA.filter(key => Object.hasOwn(item.metadata ?? {}, key));
    if (forbidden.length) throw new QaWorkflowRejected("forbidden_task", `Task ${item.id} carries implementation metadata: ${forbidden.join(", ")}`);
    if (roles.has(item.id)) throw new QaWorkflowRejected("invalid_dag", `Duplicate task ${item.id}`);
    roles.set(item.id, item.role);
  }
  if (ORDER.some(kind => !roles.has(kind))) throw new QaWorkflowRejected("invalid_dag", `QA workflow needs exactly: ${ORDER.join(", ")}`);
  if (definition.dependencies.some(item => item.condition !== "succeeded"))
    throw new QaWorkflowRejected("invalid_dag", "QA dependencies must require verified success");
  for (let index = 1; index < ORDER.length; index++)
    if (!definition.dependencies.some(item => item.taskId === ORDER[index] && item.dependsOnTaskId === ORDER[index - 1]))
      throw new QaWorkflowRejected("invalid_dag", `${ORDER[index]} must depend on ${ORDER[index - 1]}`);
  // Runtime fixes gates, approval point and retry bounds: a proposal can choose eligible roles and titles only.
  return WorkflowDefinitionSchema.parse({ ...planned, name: definition.name,
    tasks: planned.tasks.map(item => ({ ...item, role: roles.get(item.id)!, title: definition.tasks.find(other => other.id === item.id)!.title })) });
}
