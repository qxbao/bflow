import { z } from "zod";
import { WorkflowDefinitionSchema } from "@bflow/contracts";
import { canonicalJson } from "./content.js";
import { parseSpecification, policyDetails } from "./schema.js";

export interface TraceabilityMatrix {
  readonly criterionToTasks: Record<string, readonly string[]>;
  readonly taskToCriteria: Record<string, readonly string[]>;
  readonly orphanCriterionIds: readonly string[];
  readonly unmappedWorkflowTaskIds: readonly string[];
  readonly unknownMappedTaskIds: readonly string[];
  readonly valid: boolean;
}

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

export function buildTraceabilityMatrix(specInput: unknown, workflowInput?: unknown): TraceabilityMatrix {
  const spec = parseSpecification(specInput);
  const mappings = policyDetails(spec).traceability;
  const criteriaIds = spec.acceptanceCriteria.map(c => c.id);

  const criterionToTasks: Record<string, readonly string[]> = {};
  for (const id of criteriaIds) {
    const mapping = mappings.find(m => m.criterionId === id);
    criterionToTasks[id] = mapping ? [...mapping.taskIds] : [];
  }

  const orphanCriterionIds = criteriaIds
    .filter(id => !mappings.some(m => m.criterionId === id && m.taskIds.length > 0))
    .sort();

  const mappedTasks = new Set(mappings.flatMap(m => m.taskIds));

  let unmappedWorkflowTaskIds: readonly string[] = [];
  let unknownMappedTaskIds: readonly string[] = [];
  const allTaskIds = new Set<string>(mappedTasks);

  if (workflowInput !== undefined) {
    const workflow = WorkflowDefinitionSchema.parse(workflowInput);
    const workflowTasks = new Set(workflow.tasks.map(t => t.id));
    workflow.tasks.forEach(t => allTaskIds.add(t.id));

    unmappedWorkflowTaskIds = workflow.tasks
      .map(t => t.id)
      .filter(id => !mappedTasks.has(id))
      .sort();

    unknownMappedTaskIds = [...mappedTasks]
      .filter(id => !workflowTasks.has(id))
      .sort();
  }

  const taskToCriteria: Record<string, readonly string[]> = {};
  for (const taskId of [...allTaskIds].sort()) {
    const mappedCriterionIds = mappings
      .filter(m => m.taskIds.includes(taskId))
      .map(m => m.criterionId)
      .sort();
    taskToCriteria[taskId] = mappedCriterionIds;
  }

  const valid = orphanCriterionIds.length === 0 &&
    unmappedWorkflowTaskIds.length === 0 &&
    unknownMappedTaskIds.length === 0;

  return {
    criterionToTasks,
    taskToCriteria,
    orphanCriterionIds,
    unmappedWorkflowTaskIds,
    unknownMappedTaskIds,
    valid
  };
}

const TOP_LEVEL_REQUIREMENT_FIELDS = [
  "title",
  "summary",
  "problemStatement",
  "scope",
  "affectedPaths",
  "architectureNotes",
  "dataModelChanges",
  "securityConsiderations",
  "rollbackPlan",
  "level",
  "complexity",
  "riskLevel"
] as const;

const SDD_REQUIREMENT_FIELDS = [
  "functionalRequirements",
  "proposedTestStrategy",
  "designProposal",
  "technicalConstraints",
  "apiDataContracts",
  "risksAndTradeoffs",
  "migrationStrategy",
  "assessment"
] as const;

export function detectSpecChanges(previousInput: unknown, nextInput: unknown, workflowInput?: unknown) {
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
  const unchangedCriterionIds = [...before.keys()].filter(id => after.has(id) && canonicalJson(before.get(id)) === canonicalJson(after.get(id)));

  const omit = (input: typeof previous) => {
    const { version: _version, updatedAt: _updated, status: _status, approvedBy: _approver,
      artifactRef: _ref, acceptanceCriteria: _criteria, ...rest } = input;
    const details = policyDetails(input);
    const { revisionReason: _reason, ...requirements } = details;
    return { ...rest, metadata: { ...rest.metadata, sdd: requirements } };
  };
  const globalRequirementsChanged = canonicalJson(omit(previous)) !== canonicalJson(omit(next));

  const changedFields: string[] = [];
  for (const field of TOP_LEVEL_REQUIREMENT_FIELDS) {
    if (canonicalJson((previous as Record<string, unknown>)[field]) !== canonicalJson((next as Record<string, unknown>)[field])) {
      changedFields.push(field);
    }
  }
  const prevDetails = policyDetails(previous);
  const nextDetails = policyDetails(next);
  for (const field of SDD_REQUIREMENT_FIELDS) {
    if (canonicalJson((prevDetails as Record<string, unknown>)[field]) !== canonicalJson((nextDetails as Record<string, unknown>)[field])) {
      changedFields.push(field);
    }
  }

  const changed = new Set([...addedCriterionIds, ...removedCriterionIds, ...changedCriterionIds]);
  const mappings = [...policyDetails(previous).traceability, ...policyDetails(next).traceability];
  const affectedTaskIds = [...new Set(mappings.filter(mapping => globalRequirementsChanged || changed.has(mapping.criterionId)).flatMap(mapping => mapping.taskIds))].sort();

  let transitivelyAffectedTaskIds = affectedTaskIds;
  if (workflowInput !== undefined) {
    const workflow = WorkflowDefinitionSchema.parse(workflowInput);
    const queue = [...affectedTaskIds];
    const visited = new Set<string>(affectedTaskIds);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const dep of workflow.dependencies) {
        const fromId = dep.dependsOnTaskId ?? (dep as unknown as { from?: string }).from;
        const toId = dep.taskId ?? (dep as unknown as { to?: string }).to;
        if (fromId === current && toId !== undefined && !visited.has(toId)) {
          visited.add(toId);
          queue.push(toId);
        }
      }
    }
    transitivelyAffectedTaskIds = [...visited].sort();
  }

  return {
    addedCriterionIds,
    removedCriterionIds,
    changedCriterionIds,
    unchangedCriterionIds,
    changedFields,
    globalRequirementsChanged,
    affectedTaskIds,
    transitivelyAffectedTaskIds,
    requiresReapproval: globalRequirementsChanged || changed.size > 0
  };
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/^\.\//, "").replace(/^\//, "");
  const regexStr = normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOB_DOUBLE_STAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOB_DOUBLE_STAR\}\}/g, ".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${regexStr}$`);
}

function pathMatchesPattern(pattern: string, filePath: string): boolean {
  if (
    filePath.startsWith("/") ||
    filePath.startsWith("\\") ||
    filePath.split(/[/\\]/).includes("..") ||
    filePath.split(/[/\\]/).includes(".")
  ) {
    return false;
  }

  const normPattern = pattern.replace(/^\.\//, "").replace(/^\//, "");
  const normPath = filePath;

  if (normPattern === normPath) return true;
  if (normPattern === "**" || normPattern === "*") return true;

  if (normPattern.endsWith("/**")) {
    const base = normPattern.slice(0, -3);
    if (normPath === base || normPath.startsWith(`${base}/`)) return true;
  }

  if (normPattern.endsWith("/")) {
    if (normPath.startsWith(normPattern)) return true;
  } else if (!/[*?]/.test(normPattern) && !/\.[a-z0-9]+$/i.test(normPattern)) {
    if (normPath.startsWith(`${normPattern}/`)) return true;
  }

  try {
    const regex = globToRegExp(normPattern);
    if (regex.test(normPath)) return true;
  } catch {
    // fallback
  }

  return false;
}

export function validateChangedFilesScope(
  specInput: unknown,
  changedPathsInput: unknown
): { withinScope: boolean; outOfScopePaths: string[] } {
  const spec = parseSpecification(specInput);
  const validatedPaths = z.array(z.string().trim().min(1)).parse(changedPathsInput);
  const outOfScopePaths = validatedPaths.filter(
    changedPath => !spec.affectedPaths.some(pattern => pathMatchesPattern(pattern, changedPath))
  );
  return {
    withinScope: outOfScopePaths.length === 0,
    outOfScopePaths
  };
}
