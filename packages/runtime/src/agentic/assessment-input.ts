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

function stripEmptyStringKeys(obj: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) {
    if (typeof obj[key] === "string" && (obj[key] as string).trim() === "") delete obj[key];
  }
}

function normalizeConditionalTddOptionals(value: unknown): unknown {
  if (!isObject(value)) return value;
  const copy = stripNullKeys(value, ["conventions"]);
  if (isObject(copy.conventions)) {
    copy.conventions = stripNullKeys(copy.conventions, ["tdd", "requiredMethods", "suggestedLevels"]);
  }
  if (isObject(copy.infrastructure) && Array.isArray(copy.infrastructure.commands)) {
    copy.infrastructure = {
      ...copy.infrastructure,
      commands: copy.infrastructure.commands.map(cmd => {
        if (!isObject(cmd)) return cmd;
        const cleanedCmd = stripNullKeys(cmd, ["level"]);
        stripEmptyStringKeys(cleanedCmd, ["level"]);
        return cleanedCmd;
      })
    };
  }
  return copy;
}

function normalizeTddDecisionOptionals(value: unknown): unknown {
  if (!isObject(value)) return value;
  const copy = stripNullKeys(value, ["taskId", "verifiedByGateId", "alternativeVerification", "verifiableConditions", "metadata"]);
  stripEmptyStringKeys(copy, ["taskId", "verifiedByGateId"]);
  return copy;
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
  stripEmptyStringKeys(copy, [
    "runId",
    "architectureNotes",
    "dataModelChanges",
    "securityConsiderations",
    "rollbackPlan",
    "approvedBy"
  ]);
  if (isObject(copy.scope) && copy.scope.outOfScope === null) {
    copy.scope = { ...copy.scope, outOfScope: [] };
  }
  if (Array.isArray(copy.acceptanceCriteria)) {
    copy.acceptanceCriteria = copy.acceptanceCriteria.map(item => {
      if (!isObject(item)) return item;
      const cleanedItem = stripNullKeys(item, ["waiverReason", "category", "status", "evidenceSummary", "verifiedBy", "notes"]);
      if (cleanedItem.status !== "waived") stripEmptyStringKeys(cleanedItem, ["waiverReason"]);
      if (cleanedItem.evidenceArtifactIds === null) cleanedItem.evidenceArtifactIds = [];
      return cleanedItem;
    });
  }
  if (isObject(copy.tddDecision)) copy.tddDecision = normalizeTddDecisionOptionals(copy.tddDecision);
  if (isObject(copy.testStrategy)) copy.testStrategy = normalizeTestStrategyOptionals(copy.testStrategy);
  if (isObject(copy.metadata)) {
    const meta = stripNullKeys(copy.metadata, ["conditionalTdd"]);
    if (isObject(meta.conditionalTdd)) {
      meta.conditionalTdd = normalizeConditionalTddOptionals(meta.conditionalTdd);
    }
    if (isObject(meta.sdd)) {
      const cleanedSdd = stripNullKeys(meta.sdd, [
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
      stripEmptyStringKeys(cleanedSdd, [
        "proposedTestStrategy",
        "designProposal",
        "migrationStrategy",
        "revisionReason"
      ]);
      if (isObject(cleanedSdd.assessment) && cleanedSdd.assessment.unresolvedQuestions === null) {
        cleanedSdd.assessment = { ...cleanedSdd.assessment, unresolvedQuestions: [] };
      }
      meta.sdd = cleanedSdd;
    }
    copy.metadata = meta;
  }
  return copy;
}

export function normalizeWorkflowDefinitionOptionals(value: unknown): unknown {
  if (!isObject(value)) return value;
  const copy = stripNullKeys(value, ["description", "maxConcurrency", "recoveryPolicy", "gates", "metadata"]);
  stripEmptyStringKeys(copy, ["description"]);
  if (copy.dependencies === null) copy.dependencies = [];
  if (copy.qualityGates === null) copy.qualityGates = [];
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
      stripEmptyStringKeys(cleaned, ["description", "roleProfile"]);
      if (cleaned.qualityGates === null) cleaned.qualityGates = [];
      if (isObject(cleaned.metadata)) {
        const taskMeta = stripNullKeys(cleaned.metadata, ["conditionalTdd", "forbiddenPaths", "requiredCapabilities"]);
        if (isObject(taskMeta.conditionalTdd)) {
          taskMeta.conditionalTdd = normalizeConditionalTddOptionals(taskMeta.conditionalTdd);
        }
        cleaned.metadata = taskMeta;
      }
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
    copy.qualityGates = copy.qualityGates.map(gate => {
      if (!isObject(gate)) return gate;
      const cleanedGate = stripNullKeys(gate, ["description", "configuration", "metadata"]);
      stripEmptyStringKeys(cleanedGate, ["description"]);
      return cleanedGate;
    });
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
