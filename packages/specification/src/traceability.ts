import { WorkflowDefinitionSchema } from "@bflow/contracts";
import { canonicalJson } from "./content.js";
import { parseSpecification, policyDetails } from "./schema.js";

export function validateTraceability(input: unknown, workflowInput: unknown): void {
  const spec = parseSpecification(input);
  const workflow = WorkflowDefinitionSchema.parse(workflowInput);
  const mappings = policyDetails(spec).traceability;
  const tasks = new Set(workflow.tasks.map(task => task.id));
  const mappedTasks = new Set(mappings.flatMap(mapping => mapping.taskIds));
  if (spec.acceptanceCriteria.some(criterion => !mappings.some(mapping => mapping.criterionId === criterion.id))) {
    throw new Error("Every acceptance criterion must map to a task");
  }
  if ([...mappedTasks].some(task => !tasks.has(task)) || [...tasks].some(task => !mappedTasks.has(task))) {
    throw new Error("Workflow tasks must exactly match specification traceability");
  }
}

export function detectSpecChanges(previousInput: unknown, nextInput: unknown) {
  const previous = parseSpecification(previousInput);
  const next = parseSpecification(nextInput);
  if (previous.specId !== next.specId || previous.sessionId !== next.sessionId || previous.runId !== next.runId) {
    throw new Error("Change detection requires the same specification, session and run");
  }
  const before = new Map(previous.acceptanceCriteria.map(criterion => [criterion.id, criterion]));
  const after = new Map(next.acceptanceCriteria.map(criterion => [criterion.id, criterion]));
  const addedCriterionIds = [...after.keys()].filter(id => !before.has(id));
  const removedCriterionIds = [...before.keys()].filter(id => !after.has(id));
  const changedCriterionIds = [...before.keys()].filter(id => after.has(id) && canonicalJson(before.get(id)) !== canonicalJson(after.get(id)));
  const omit = (input: typeof previous) => {
    const { version: _version, updatedAt: _updated, status: _status, approvedBy: _approver,
      artifactRef: _ref, acceptanceCriteria: _criteria, ...rest } = input;
    const details = policyDetails(input);
    const { revisionReason: _reason, ...requirements } = details;
    return { ...rest, metadata: { ...rest.metadata, sdd: requirements } };
  };
  const globalRequirementsChanged = canonicalJson(omit(previous)) !== canonicalJson(omit(next));
  const changed = new Set([...addedCriterionIds, ...removedCriterionIds, ...changedCriterionIds]);
  const mappings = [...policyDetails(previous).traceability, ...policyDetails(next).traceability];
  const affectedTaskIds = [...new Set(mappings.filter(mapping => globalRequirementsChanged || changed.has(mapping.criterionId)).flatMap(mapping => mapping.taskIds))].sort();
  return { addedCriterionIds, removedCriterionIds, changedCriterionIds, globalRequirementsChanged, affectedTaskIds,
    requiresReapproval: globalRequirementsChanged || changed.size > 0 };
}
