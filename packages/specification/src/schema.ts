import {
  AgentRoleSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  SddPolicyLevelSchema,
  SpecificationSchema
} from "@bflow/contracts";
import type { OperationResult, Specification } from "@bflow/contracts";
import { z } from "zod";
import { canonicalJson } from "./content.js";
import { ChangeAssessmentSchema, classifyChange } from "./classification.js";
import type { ChangeAssessment } from "./classification.js";

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

export type PolicyDetails = z.infer<typeof PolicyDetailsSchema>;

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
    // Enum values only, so the proposer can correct the declared fields instead of guessing.
    issue(`classification must match assessed impact and affected paths: expected complexity ${classification.complexity}, riskLevel ${classification.riskLevel}, level ${classification.level}; got complexity ${spec.complexity}, riskLevel ${spec.riskLevel}, level ${spec.level}; derived from metadata.sdd.assessment and affectedPaths (${classification.reasons.join(", ")}), so correct an inaccurate assessment rather than the declared fields`, ["complexity"]);
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

export function parseContractOrP15Specification(input: unknown): Specification {
  const p15Result = SpecificationDocumentSchema.safeParse(input);
  if (p15Result.success) {
    return p15Result.data;
  }

  const contractSpec = SpecificationSchema.parse(input);
  const existingSdd = contractSpec.metadata?.sdd;

  const sddParsed = PolicyDetailsSchema.safeParse(existingSdd);
  if (sddParsed.success) {
    return {
      ...contractSpec,
      metadata: {
        ...contractSpec.metadata,
        sdd: JSON.parse(JSON.stringify(sddParsed.data))
      }
    };
  }

  const rawSdd = (existingSdd && typeof existingSdd === "object") ? (existingSdd as Record<string, unknown>) : {};
  const rawAssessment = (rawSdd.assessment && typeof rawSdd.assessment === "object") ? (rawSdd.assessment as Record<string, unknown>) : {};

  const kind = contractSpec.complexity === "trivial" ? "documentation" : "feature";
  const assessment: ChangeAssessment = {
    kind: (typeof rawAssessment.kind === "string" && ["documentation", "formatting", "feature", "bugfix", "refactoring", "configuration"].includes(rawAssessment.kind))
      ? (rawAssessment.kind as ChangeAssessment["kind"])
      : kind,
    behaviorChange: typeof rawAssessment.behaviorChange === "boolean"
      ? rawAssessment.behaviorChange
      : contractSpec.complexity !== "trivial",
    modules: Array.isArray(rawAssessment.modules) && rawAssessment.modules.length > 0
      ? rawAssessment.modules.map(String)
      : (contractSpec.affectedPaths.length > 0 ? [...contractSpec.affectedPaths] : ["root"]),
    securityImpact: Boolean(rawAssessment.securityImpact),
    publicApiImpact: Boolean(rawAssessment.publicApiImpact),
    dataSchemaImpact: typeof rawAssessment.dataSchemaImpact === "boolean"
      ? rawAssessment.dataSchemaImpact
      : Boolean(contractSpec.dataModelChanges),
    architectureImpact: typeof rawAssessment.architectureImpact === "boolean"
      ? rawAssessment.architectureImpact
      : contractSpec.complexity === "complex",
    migrationRequired: typeof rawAssessment.migrationRequired === "boolean"
      ? rawAssessment.migrationRequired
      : Boolean(contractSpec.dataModelChanges),
    risk: (typeof rawAssessment.risk === "string" && ["low", "medium", "high", "critical"].includes(rawAssessment.risk))
      ? (rawAssessment.risk as ChangeAssessment["risk"])
      : (contractSpec.riskLevel ?? "low"),
    unresolvedQuestions: Array.isArray(rawAssessment.unresolvedQuestions)
      ? rawAssessment.unresolvedQuestions.map(String)
      : []
  };

  let traceability: PolicyDetails["traceability"] = [];
  if (Array.isArray(rawSdd.traceability)) {
    const validMappings = rawSdd.traceability
      .filter((m): m is { criterionId: string; taskIds: string[] } =>
        typeof m === "object" && m !== null && typeof (m as any).criterionId === "string" && Array.isArray((m as any).taskIds) && (m as any).taskIds.length > 0
      )
      .map(m => ({ criterionId: String(m.criterionId), taskIds: m.taskIds.map(String) }));
    if (validMappings.length > 0) {
      traceability = validMappings;
    }
  }

  if (traceability.length === 0 && contractSpec.acceptanceCriteria.length > 0) {
    const defaultTaskIds = contractSpec.traceabilityTaskIds && contractSpec.traceabilityTaskIds.length > 0
      ? [...contractSpec.traceabilityTaskIds]
      : ["implement"];
    traceability = contractSpec.acceptanceCriteria.map(c => ({
      criterionId: c.id,
      taskIds: defaultTaskIds
    }));
  }

  const functionalRequirements = Array.isArray(rawSdd.functionalRequirements) && rawSdd.functionalRequirements.length > 0
    ? rawSdd.functionalRequirements.map(String)
    : (contractSpec.summary ? [contractSpec.summary] : [contractSpec.title]);

  const synthesizedDetails: PolicyDetails = {
    policyVersion: 1,
    assessment,
    functionalRequirements,
    proposedTestStrategy: typeof rawSdd.proposedTestStrategy === "string"
      ? rawSdd.proposedTestStrategy
      : (contractSpec.testStrategy ? "Test strategy defined in contract" : undefined),
    designProposal: typeof rawSdd.designProposal === "string" ? rawSdd.designProposal : undefined,
    technicalConstraints: Array.isArray(rawSdd.technicalConstraints) ? rawSdd.technicalConstraints.map(String) : [],
    apiDataContracts: Array.isArray(rawSdd.apiDataContracts) ? rawSdd.apiDataContracts.map(String) : [],
    risksAndTradeoffs: Array.isArray(rawSdd.risksAndTradeoffs) ? rawSdd.risksAndTradeoffs.map(String) : [],
    migrationStrategy: typeof rawSdd.migrationStrategy === "string" ? rawSdd.migrationStrategy : undefined,
    traceability,
    revisionReason: typeof rawSdd.revisionReason === "string" ? rawSdd.revisionReason : undefined
  };

  return {
    ...contractSpec,
    metadata: {
      ...contractSpec.metadata,
      sdd: JSON.parse(JSON.stringify(synthesizedDetails))
    }
  };
}

export function parseSpecification(input: unknown) {
  return SpecificationDocumentSchema.parse(input);
}

export function policyDetails(input: unknown): PolicyDetails {
  const spec = parseContractOrP15Specification(input);
  return PolicyDetailsSchema.parse(spec.metadata?.sdd);
}

export function validateSpecificationDocument(input: unknown): OperationResult<Specification> {
  const result = SpecificationDocumentSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    error: {
      code: "validation",
      message: result.error.message,
      retryable: false,
      details: { issues: JSON.parse(JSON.stringify(result.error.issues)) }
    }
  };
}

export const SpecDraftPayloadSchema = z
  .object({
    specId: IdentifierSchema,
    specLevel: SddPolicyLevelSchema,
    title: z.string().trim().min(1),
    authorRole: AgentRoleSchema,
    summary: z.string().trim().min(1),
    affectedPaths: z.array(z.string().trim().min(1)).min(1)
  })
  .strict();
export type SpecDraftPayload = z.infer<typeof SpecDraftPayloadSchema>;

export const SpecApprovedPayloadSchema = z
  .object({
    specId: IdentifierSchema,
    approvedBy: z.string().trim().min(1),
    approvedAt: IsoDateTimeSchema,
    notes: z.string().trim().min(1).optional()
  })
  .strict();
export type SpecApprovedPayload = z.infer<typeof SpecApprovedPayloadSchema>;
