import { SpecificationSchema, type Specification } from "@bflow/contracts";
import { z } from "zod";

const guidance = 'P15 assess requires an explicit impact object; read planning_reference(section="specification") and supply metadata.sdd.assessment. Do not infer missing impact flags.';
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const OPTIONAL_SPECIFICATION_KEYS = [
  "runId",
  "version",
  "complexity",
  "riskLevel",
  "functionalRequirements",
  "nonFunctionalRequirements",
  "architectureNotes",
  "dataModelChanges",
  "securityConsiderations",
  "rollbackPlan",
  "proposedTestStrategy",
  "traceabilityTaskIds",
  "tddDecision",
  "testStrategy",
  "approvedBy",
  "approvedAt",
  "artifactRef",
  "metadata"
] as const;

function stripNullKeys(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...obj };
  for (const key of keys) {
    if (copy[key] === null) delete copy[key];
  }
  return copy;
}

function normalizeTddDecisionOptionals(value: unknown): unknown {
  if (!isObject(value)) return value;
  return stripNullKeys(value, ["taskId", "verifiedByGateId", "alternativeVerification", "verifiableConditions", "metadata"]);
}

function normalizeTestStrategyOptionals(value: unknown): unknown {
  if (!isObject(value)) return value;
  const copy = stripNullKeys(value, ["coverageThresholdPercent", "alternativeVerificationPlan", "notes", "metadata"]);
  if (isObject(copy.tddDecision)) copy.tddDecision = normalizeTddDecisionOptionals(copy.tddDecision);
  return copy;
}

export function normalizeSpecificationOptionals(value: unknown): unknown {
  if (!isObject(value)) return value;
  const copy = stripNullKeys(value, OPTIONAL_SPECIFICATION_KEYS);
  if (Array.isArray(copy.acceptanceCriteria)) {
    copy.acceptanceCriteria = copy.acceptanceCriteria.map(item =>
      isObject(item) ? stripNullKeys(item, ["waiverReason", "category", "status", "evidenceSummary", "verifiedBy", "notes"]) : item
    );
  }
  if (isObject(copy.tddDecision)) copy.tddDecision = normalizeTddDecisionOptionals(copy.tddDecision);
  if (isObject(copy.testStrategy)) copy.testStrategy = normalizeTestStrategyOptionals(copy.testStrategy);
  if (isObject(copy.metadata)) {
    const meta: Record<string, unknown> = { ...copy.metadata };
    if (isObject(meta.sdd)) {
      meta.sdd = stripNullKeys(meta.sdd, [
        "functionalRequirements",
        "nonFunctionalRequirements",
        "proposedTestStrategy",
        "designProposal",
        "technicalConstraints",
        "apiDataContracts",
        "risksAndTradeoffs",
        "migrationStrategy",
        "revisionReason"
      ]);
    }
    copy.metadata = meta;
  }
  return copy;
}

export function normalizeWorkflowDefinitionOptionals(value: unknown): unknown {
  if (!isObject(value)) return value;
  const copy = stripNullKeys(value, ["description", "maxConcurrency", "recoveryPolicy", "gates", "metadata"]);
  if (Array.isArray(copy.tasks)) {
    copy.tasks = copy.tasks.map(task => {
      if (!isObject(task)) return task;
      const cleaned = stripNullKeys(task, [
        "description",
        "roleProfile",
        "input",
        "rework",
        "dependsOn",
        "timeoutMs",
        "maxAttempts",
        "retryPolicy",
        "reworkTargetTaskId",
        "maxReworkCycles",
        "gateIds",
        "inputSchemaName",
        "outputSchemaName",
        "metadata"
      ]);
      if (typeof cleaned.roleProfile === "string" && cleaned.roleProfile.trim() === "") delete cleaned.roleProfile;
      if (isObject(cleaned.retry)) {
        cleaned.retry = stripNullKeys(cleaned.retry, ["multiplier", "retryableErrorCodes"]);
      }
      if (isObject(cleaned.timeout)) {
        cleaned.timeout = stripNullKeys(cleaned.timeout, ["heartbeatTimeoutMs", "deadline"]);
      }
      return cleaned;
    });
  }
  if (Array.isArray(copy.qualityGates)) {
    copy.qualityGates = copy.qualityGates.map(gate =>
      isObject(gate) ? stripNullKeys(gate, ["description", "configuration", "metadata"]) : gate
    );
  }
  if (Array.isArray(copy.gates)) {
    copy.gates = copy.gates.map(gate =>
      isObject(gate) ? stripNullKeys(gate, ["description", "taskId", "configuration", "metadata"]) : gate
    );
  }
  if (isObject(copy.recovery)) {
    copy.recovery = stripNullKeys(copy.recovery, ["eventInterval"]);
  }
  if (isObject(copy.recoveryPolicy)) {
    copy.recoveryPolicy = stripNullKeys(copy.recoveryPolicy, ["maxReworkIterations", "reconcileTimeoutMs", "metadata"]);
  }
  return copy;
}

/** Package-local assess precondition, in addition to the unchanged public Specification contract.
 * P15's exported classifyChange remains the sole validator of the assessment's fields. */
export const AssessmentSpecificationSchema = z.preprocess(
  normalizeSpecificationOptionals,
  SpecificationSchema.superRefine((spec, ctx) => {
    let value: unknown = spec;
    const path: string[] = [];
    for (const key of ["metadata", "sdd", "assessment"]) {
      value = isObject(value) ? value[key] : undefined;
      path.push(key);
      if (!isObject(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...path], message: guidance });
        return;
      }
    }
  })
);

export function parseCoordinatorAssessmentInput(input: unknown): Specification {
  return AssessmentSpecificationSchema.parse(input);
}

/** Preserve the authoritative policy's issues while locating them in the actual tool document. */
export function assessmentErrorAt(error: unknown, path: readonly string[]): never {
  if (error instanceof z.ZodError) throw new z.ZodError(error.issues.map(issue => ({ ...issue, path: [...path, ...issue.path] })));
  throw error;
}

/** The activity journal records a known schema location, never received values or arbitrary metadata keys. */
export function assessmentFailureSummary(error: unknown): string {
  if (!(error instanceof z.ZodError)) return "P15 assess failed; inspect tool error";
  const path: string[] = [];
  for (const key of ["specification", "metadata", "sdd", "assessment"]) {
    if (error.issues[0]?.path[path.length] !== key) break;
    path.push(key);
  }
  return `${path.join(".") || "assess"}: invalid input; read planning_reference`;
}
