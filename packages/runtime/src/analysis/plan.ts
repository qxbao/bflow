import { WorkflowDefinitionSchema, type WorkflowDefinition } from "@bflow/contracts";
import { AnalysisTaskKindSchema, type AnalysisIntake, type AnalysisTaskKind } from "./model.js";
import { ANALYSIS_WORKFLOW_ID, type AnalysisPackPolicy } from "./pack.js";

export const ANALYSIS_GATES = {
  verification: "analysis-verification",
  review: "independent-review",
  publication: "publication-integrity"
} as const;

/** Only these role/kind pairs may appear; implementation, deploy and install work has no kind at all. */
const KIND_ROLES: Readonly<Record<AnalysisTaskKind, readonly string[]>> = {
  survey: ["architect", "specifier"],
  elicitation: ["specifier"],
  specification: ["specifier", "architect"],
  review: ["reviewer"],
  // Publication is executed by Runtime itself (artifact + document write); the Coordinator owns it, no agent edits files.
  publication: ["coordinator"]
};
const FORBIDDEN_TASK_METADATA = ["ownedPaths", "commands", "worktree", "branch", "install", "deploy", "conditionalTdd"];

export class AnalysisWorkflowRejected extends Error {
  constructor(readonly code: "forbidden_task" | "invalid_dag" | "unsupported_definition", message: string) {
    super(message);
    this.name = "AnalysisWorkflowRejected";
  }
}

const INSTRUCTIONS: Readonly<Record<AnalysisTaskKind, string>> = {
  survey: "Read only the permitted survey paths and report observations relevant to the request. Never edit, run or install anything.",
  elicitation: "List the business questions that must be decided by the user, marking which ones block the specification.",
  specification: "Write the analysis document (scope, FR/AC/NFR, business flows, glossary and only the requested context/data/API notes). " +
    "Give every statement its provenance: user, source observation, inference or open decision.",
  review: "Independently review the analysis document for consistency, traceability, testability and unresolved questions; pin your verdict to its digest.",
  publication: "Runtime publishes the approved handoff with sources and versions."
};

function task(kind: AnalysisTaskKind, role: string, intake: AnalysisIntake, maxAttempts: number, gates: string[]) {
  return {
    id: kind, title: `Analysis ${kind}`, role, instruction: INSTRUCTIONS[kind],
    acceptanceCriteria: intake.acceptanceCriteria.map(item => item.id),
    retry: { maxAttempts, strategy: "fixed" as const, initialDelayMs: 0, maxDelayMs: 0, jitter: false },
    rework: { maxReworks: 0, onExhausted: "require_human" as const },
    timeout: { executionTimeoutMs: 900_000, onTimeout: "block" as const },
    // Elicitation needs the user's business decisions; review needs human document approval.
    requiresApproval: kind === "elicitation" || kind === "review",
    qualityGates: gates.map(gateId => ({ gateId, phase: gateId === ANALYSIS_GATES.verification ? "before_completion" as const : "after_result" as const, required: true })),
    metadata: { analysisKind: kind }
  };
}

/** Coordinator default plan: allowed survey, elicitation, specification, independent review and publication only. */
export function planAnalysisWorkflow(intake: AnalysisIntake, policy: AnalysisPackPolicy, maxIterations = 3,
  options: { survey?: boolean } = {}): WorkflowDefinition {
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10) throw new AnalysisWorkflowRejected("unsupported_definition", "Invalid verification limit");
  const survey = intake.surveyPaths.length > 0 && options.survey !== false;
  const tasks = [
    ...(survey ? [task("survey", "architect", intake, 2, [])] : []),
    task("elicitation", "specifier", intake, 2, []),
    task("specification", "specifier", intake, maxIterations, [ANALYSIS_GATES.verification]),
    task("review", "reviewer", intake, 2, [ANALYSIS_GATES.review]),
    task("publication", "coordinator", intake, 1, [ANALYSIS_GATES.publication])
  ];
  const dependencies = [
    ...(survey ? [{ taskId: "specification", dependsOnTaskId: "survey", condition: "succeeded" as const }] : []),
    { taskId: "specification", dependsOnTaskId: "elicitation", condition: "succeeded" as const },
    { taskId: "review", dependsOnTaskId: "specification", condition: "succeeded" as const },
    { taskId: "publication", dependsOnTaskId: "review", condition: "succeeded" as const }
  ];
  return WorkflowDefinitionSchema.parse({
    schemaVersion: "1", id: ANALYSIS_WORKFLOW_ID, name: `Analysis: ${intake.title}`, version: policy.workflowVersion,
    tasks, dependencies, qualityGates: analysisGates(), maxConcurrency: 1, failurePolicy: "block",
    recovery: { checkpoint: "task-boundary", resumeStrategy: "checkpoint-then-replay", staleExecution: "reconcile" },
    metadata: { analysisRequestId: intake.requestId, revision: intake.revision, pack: { ...policy.pack } }
  });
}

/** Runtime-owned gate definitions; the verification gate drives Core's bounded verification retry. */
function analysisGates() {
  const gate = (id: string, name: string, retry: boolean) => ({ id, name, evaluator: `analysis:${id}`, required: true,
    timeout: { executionTimeoutMs: 60_000, onTimeout: "block" as const }, ...(retry ? { metadata: { boundedVerificationRetry: true } } : {}) });
  return [
    gate(ANALYSIS_GATES.verification, "Analysis consistency, traceability and testability", true),
    gate(ANALYSIS_GATES.review, "Independent analysis review", false),
    gate(ANALYSIS_GATES.publication, "Handoff publication integrity", false)
  ];
}

function kindOf(taskMetadata: unknown): AnalysisTaskKind {
  const kind = AnalysisTaskKindSchema.safeParse((taskMetadata as Record<string, unknown> | undefined)?.analysisKind);
  if (!kind.success) throw new AnalysisWorkflowRejected("forbidden_task", "Every analysis task needs an analysisKind of survey, elicitation, specification, review or publication");
  return kind.data;
}

/**
 * Validates a Coordinator-proposed DAG against analysis-only policy and returns it with Runtime-owned gates and
 * approval points. Agent-defined gates, implementation roles, write/command metadata and missing stages are refused.
 */
export function assertAnalysisOnlyWorkflow(input: unknown, intake: AnalysisIntake, policy: AnalysisPackPolicy, maxIterations = 3): WorkflowDefinition {
  const parsed = WorkflowDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new AnalysisWorkflowRejected("unsupported_definition", "Invalid workflow definition");
  const definition = parsed.data;
  if (definition.id !== ANALYSIS_WORKFLOW_ID || definition.version !== policy.workflowVersion)
    throw new AnalysisWorkflowRejected("unsupported_definition", "Workflow is not the pinned analysis workflow");
  if (definition.qualityGates.length || definition.tasks.some(item => item.qualityGates.length))
    throw new AnalysisWorkflowRejected("forbidden_task", "Analysis gates are Runtime-owned; agent-defined gates are refused");
  const kinds = new Map<string, AnalysisTaskKind>();
  for (const item of definition.tasks) {
    const kind = kindOf(item.metadata);
    if (!KIND_ROLES[kind].includes(item.role))
      throw new AnalysisWorkflowRejected("forbidden_task", `Task ${item.id}: role '${item.role}' cannot perform ${kind}; implementation/deploy/install tasks are not allowed`);
    const metadata = item.metadata ?? {};
    const forbidden = FORBIDDEN_TASK_METADATA.filter(key => Object.hasOwn(metadata, key));
    if (forbidden.length) throw new AnalysisWorkflowRejected("forbidden_task", `Task ${item.id} carries implementation metadata: ${forbidden.join(", ")}`);
    if (item.id !== kind) throw new AnalysisWorkflowRejected("invalid_dag", `Task ${item.id} must be named after its kind ${kind}`);
    kinds.set(item.id, kind);
  }
  const counts = (kind: AnalysisTaskKind) => [...kinds.values()].filter(value => value === kind).length;
  for (const kind of ["elicitation", "specification", "review", "publication"] as const)
    if (counts(kind) !== 1) throw new AnalysisWorkflowRejected("invalid_dag", `Analysis workflow needs exactly one ${kind} task`);
  if (counts("survey") > (intake.surveyPaths.length ? 1 : 0))
    throw new AnalysisWorkflowRejected("forbidden_task", "A source survey requires permitted survey paths in the intake");
  if (definition.dependencies.some(item => item.condition !== "succeeded"))
    throw new AnalysisWorkflowRejected("invalid_dag", "Analysis dependencies must require verified success");
  const before = (from: string, to: string): boolean => {
    const seen = new Set<string>(); const stack = [to];
    while (stack.length) {
      const current = stack.pop()!;
      for (const dependency of definition.dependencies.filter(item => item.taskId === current)) {
        if (dependency.dependsOnTaskId === from) return true;
        if (!seen.has(dependency.dependsOnTaskId)) { seen.add(dependency.dependsOnTaskId); stack.push(dependency.dependsOnTaskId); }
      }
    }
    return false;
  };
  const order: [string, string][] = [["elicitation", "specification"], ["specification", "review"], ["review", "publication"],
    ...(kinds.has("survey") ? [["survey", "specification"] as [string, string]] : [])];
  for (const [from, to] of order)
    if (!before(from, to)) throw new AnalysisWorkflowRejected("invalid_dag", `${to} must depend on ${from}`);
  // Runtime fixes approval points, retry bounds and gates: a proposal cannot remove a human decision.
  const planned = planAnalysisWorkflow(intake, policy, maxIterations, { survey: kinds.has("survey") });
  return WorkflowDefinitionSchema.parse({ ...planned, name: definition.name, maxConcurrency: 1,
    tasks: planned.tasks.map(item => ({ ...item, title: definition.tasks.find(candidate => candidate.id === item.id)?.title ?? item.title,
      role: definition.tasks.find(candidate => candidate.id === item.id)?.role ?? item.role })) });
}
