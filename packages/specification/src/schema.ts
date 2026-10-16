import { SpecificationSchema } from "@bflow/contracts";
import { z } from "zod";
import { canonicalJson } from "./content.js";
import { ChangeAssessmentSchema, classifyChange } from "./classification.js";

const Text = z.string().trim().min(1);
export const PolicyDetailsSchema = z.object({
  policyVersion: z.literal(1),
  assessment: ChangeAssessmentSchema,
  functionalRequirements: z.array(Text),
  proposedTestStrategy: Text.optional(),
  designProposal: Text.optional(),
  technicalConstraints: z.array(Text),
  apiDataContracts: z.array(Text),
  risksAndTradeoffs: z.array(Text),
  migrationStrategy: Text.optional(),
  traceability: z.array(z.object({ criterionId: Text, taskIds: z.array(Text).min(1) }).strict()),
  revisionReason: Text.optional()
}).strict();

/** Same public Specification contract; P15 policy details live in namespaced metadata. */
export const SpecificationDocumentSchema = SpecificationSchema.superRefine((spec, ctx) => {
  const parsed = PolicyDetailsSchema.safeParse(spec.metadata?.sdd);
  const issue = (message: string, path: (string | number)[] = []) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
  if (!parsed.success) {
    for (const error of parsed.error.issues) issue(error.message, ["metadata", "sdd", ...error.path]);
    return;
  }
  const details = parsed.data;
  const classification = classifyChange(details.assessment, spec.affectedPaths);
  if (spec.complexity !== classification.complexity || spec.riskLevel !== classification.riskLevel || spec.level !== classification.level) {
    issue("classification must match assessed impact and affected paths", ["complexity"]);
  }
  if ([...spec.scope.inScope, ...spec.scope.outOfScope].some(item => !item.trim())) issue("scope entries cannot be blank", ["scope"]);
  if (!spec.version) issue("explicit specification version is required", ["version"]);
  if (Date.parse(spec.updatedAt) < Date.parse(spec.createdAt)) issue("updatedAt precedes createdAt", ["updatedAt"]);
  if (!spec.acceptanceCriteria.some(criterion => criterion.required)) issue("at least one criterion must be required", ["acceptanceCriteria"]);
  if (spec.complexity !== "trivial") {
    if (!details.functionalRequirements.length) issue("functional requirements are required", ["metadata", "sdd", "functionalRequirements"]);
    if (!details.proposedTestStrategy) issue("proposed test strategy is required", ["metadata", "sdd", "proposedTestStrategy"]);
  }
  if (spec.complexity === "complex") {
    for (const field of ["designProposal", "technicalConstraints", "apiDataContracts", "risksAndTradeoffs"] as const) {
      if (!details[field]?.length) issue(`${field} is required for complex changes`, ["metadata", "sdd", field]);
    }
    if (details.assessment.migrationRequired || classification.reasons.includes("persistent data schema impact")) {
      if (!details.migrationStrategy || !spec.dataModelChanges) issue("data changes require migration strategy and dataModelChanges", ["metadata", "sdd", "migrationStrategy"]);
    }
  }
  const criteria = new Set(spec.acceptanceCriteria.map(criterion => criterion.id));
  const seen = new Set<string>();
  const tasks = new Set<string>();
  for (const mapping of details.traceability) {
    if (!criteria.has(mapping.criterionId) || seen.has(mapping.criterionId)) issue("unknown or duplicate mapped criterion", ["metadata", "sdd", "traceability"]);
    if (new Set(mapping.taskIds).size !== mapping.taskIds.length) issue("duplicate mapped task", ["metadata", "sdd", "traceability"]);
    seen.add(mapping.criterionId);
    mapping.taskIds.forEach(task => tasks.add(task));
  }
  if (new Set(spec.traceabilityTaskIds).size !== spec.traceabilityTaskIds?.length ||
      JSON.stringify([...tasks].sort()) !== JSON.stringify([...(spec.traceabilityTaskIds ?? [])].sort())) {
    issue("traceabilityTaskIds must equal the unique mapped task IDs", ["traceabilityTaskIds"]);
  }
  if (spec.testStrategy) {
    if (spec.testStrategy.specId !== spec.specId) issue("test strategy references another spec", ["testStrategy", "specId"]);
    const mapped = new Set<string>();
    for (const mapping of spec.testStrategy.criterionMappings) {
      if (!criteria.has(mapping.criterionId) || mapped.has(mapping.criterionId)) issue("unknown or duplicate test criterion", ["testStrategy", "criterionMappings"]);
      mapped.add(mapping.criterionId);
    }
    if (spec.acceptanceCriteria.some(criterion => criterion.required && !mapped.has(criterion.id))) issue("test strategy must cover required criteria", ["testStrategy", "criterionMappings"]);
  }
  for (const decision of [spec.tddDecision, spec.testStrategy?.tddDecision]) {
    if (decision && (decision.specId !== spec.specId || (spec.runId && decision.runId !== spec.runId))) issue("TDD decision must match spec and run", ["tddDecision"]);
  }
  if (spec.tddDecision && spec.testStrategy && canonicalJson(spec.tddDecision) !== canonicalJson(spec.testStrategy.tddDecision)) {
    issue("TDD decisions must agree", ["tddDecision"]);
  }
});

export function parseSpecification(input: unknown) {
  return SpecificationDocumentSchema.parse(input);
}

export function policyDetails(input: unknown) {
  return PolicyDetailsSchema.parse(parseSpecification(input).metadata?.sdd);
}
