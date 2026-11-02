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

const ALLOWED_CRITERIA_KEYS = new Set([
  "id", "description", "category", "verificationMethod", "required", "status", "evidenceArtifactIds", "waiverReason"
]);
const ALLOWED_ASSESSMENT_KEYS = new Set([
  "kind", "behaviorChange", "modules", "securityImpact", "publicApiImpact",
  "dataSchemaImpact", "architectureImpact", "migrationRequired", "risk", "unresolvedQuestions"
]);
const MISPLACED_SDD_KEYS = [
  "functionalRequirements",
  "nonFunctionalRequirements",
  "proposedTestStrategy",
  "designProposal",
  "technicalConstraints",
  "apiDataContracts",
  "risksAndTradeoffs",
  "migrationStrategy",
  "revisionReason"
] as const;

export function normalizeSpecificationOptionals(value: unknown): unknown {
  if (!isObject(value)) return value;
  const copy = stripNullKeys(value, OPTIONAL_SPECIFICATION_KEYS);
  stripEmptyStringKeys(copy, [
    "runId",
    "architectureNotes",
    "dataModelChanges",
    "securityConsiderations",
    "rollbackPlan",
    "approvedBy",
    "approvedAt"
  ]);
  if (typeof copy.approvedAt === "string" && copy.approvedAt.trim() === "") delete copy.approvedAt;
  if (typeof copy.affectedPaths === "string") {
    copy.affectedPaths = [copy.affectedPaths.trim()].filter(Boolean);
  }
  if (copy.scope === undefined || copy.scope === null) {
    copy.scope = { inScope: Array.isArray(copy.affectedPaths) && copy.affectedPaths.length ? copy.affectedPaths : ["."], outOfScope: [] };
  } else if (typeof copy.scope === "string") {
    copy.scope = { inScope: [copy.scope.trim()].filter(Boolean), outOfScope: [] };
  } else if (isObject(copy.scope)) {
    const rawScope = { ...copy.scope };
    if (typeof rawScope.inScope === "string") rawScope.inScope = [rawScope.inScope.trim()].filter(Boolean);
    if (rawScope.outOfScope === null || rawScope.outOfScope === undefined) rawScope.outOfScope = [];
    else if (typeof rawScope.outOfScope === "string") rawScope.outOfScope = [rawScope.outOfScope.trim()].filter(Boolean);
    for (const key of Object.keys(rawScope)) {
      if (key !== "inScope" && key !== "outOfScope") delete rawScope[key];
    }
    copy.scope = rawScope;
  }
  if (Array.isArray(copy.acceptanceCriteria)) {
    copy.acceptanceCriteria = copy.acceptanceCriteria.map(item => {
      if (!isObject(item)) return item;
      const cleanedItem = stripNullKeys(item, ["waiverReason", "category", "status", "evidenceSummary", "verifiedBy", "notes"]);
      if (cleanedItem.status !== "waived") stripEmptyStringKeys(cleanedItem, ["waiverReason"]);
      if (cleanedItem.evidenceArtifactIds === null || cleanedItem.evidenceArtifactIds === undefined) cleanedItem.evidenceArtifactIds = [];
      cleanedItem.required ??= true;
      cleanedItem.status ??= "pending";
      cleanedItem.category ??= "functional";
      cleanedItem.verificationMethod ??= "unit_test";
      for (const k of Object.keys(cleanedItem)) {
        if (!ALLOWED_CRITERIA_KEYS.has(k)) delete cleanedItem[k];
      }
      return cleanedItem;
    });
  }
  if (isObject(copy.tddDecision)) copy.tddDecision = normalizeTddDecisionOptionals(copy.tddDecision);
  if (isObject(copy.testStrategy)) copy.testStrategy = normalizeTestStrategyOptionals(copy.testStrategy);
  let meta = isObject(copy.metadata) ? stripNullKeys(copy.metadata, ["conditionalTdd"]) : {};
  if (isObject(meta.conditionalTdd)) {
    meta.conditionalTdd = normalizeConditionalTddOptionals(meta.conditionalTdd);
  }
  let cleanedSdd = isObject(meta.sdd) ? stripNullKeys(meta.sdd, MISPLACED_SDD_KEYS) : {};
  for (const misplaced of MISPLACED_SDD_KEYS) {
    if (copy[misplaced] !== undefined) {
      if (cleanedSdd[misplaced] === undefined && copy[misplaced] !== null) {
        cleanedSdd[misplaced] = copy[misplaced];
      }
      delete copy[misplaced];
    }
  }
  stripEmptyStringKeys(cleanedSdd, [
    "proposedTestStrategy",
    "designProposal",
    "migrationStrategy",
    "revisionReason"
  ]);
  if (isObject(cleanedSdd.assessment)) {
    const rawAss = { ...cleanedSdd.assessment };
    for (const key of Object.keys(rawAss)) {
      if (!ALLOWED_ASSESSMENT_KEYS.has(key)) delete rawAss[key];
    }
    if (typeof rawAss.modules === "string") rawAss.modules = [rawAss.modules.trim()].filter(Boolean);
    if (rawAss.unresolvedQuestions === null || rawAss.unresolvedQuestions === undefined) {
      rawAss.unresolvedQuestions = [];
    } else if (Array.isArray(rawAss.unresolvedQuestions)) {
      rawAss.unresolvedQuestions = rawAss.unresolvedQuestions.filter(q => q !== null && typeof q === "string" && q.trim().length > 0);
    }
    cleanedSdd.assessment = rawAss;
  }
  meta.sdd = cleanedSdd;
  copy.metadata = meta;

  if (!Array.isArray(copy.traceabilityTaskIds) || copy.traceabilityTaskIds.length === 0) {
    if (Array.isArray(cleanedSdd.traceability)) {
      copy.traceabilityTaskIds = [...new Set(cleanedSdd.traceability.flatMap((t: any) => Array.isArray(t?.taskIds) ? t.taskIds : [t?.taskIds]).filter(Boolean))];
    }
  }
  return copy;
}

export function normalizeWorkflowDefinitionOptionals(value: unknown): unknown {
  if (!isObject(value)) return value;
  const copy = stripNullKeys(value, ["description", "maxConcurrency", "recoveryPolicy", "gates", "metadata"]);
  stripEmptyStringKeys(copy, ["description"]);
  if (copy.schemaVersion === undefined || copy.schemaVersion === 1) copy.schemaVersion = "1";
  copy.version = typeof copy.version === "string" && copy.version.trim() !== "" ? copy.version.trim() : "1";
  copy.name = typeof copy.name === "string" && copy.name.trim() !== "" ? copy.name.trim() : String(copy.id ?? "workflow");
  if (typeof copy.maxConcurrency !== "number" || copy.maxConcurrency < 1) copy.maxConcurrency = 2;
  if (!["fail-fast", "continue-independent", "block"].includes(String(copy.failurePolicy))) copy.failurePolicy = "fail-fast";
  if (!isObject(copy.recovery)) {
    copy.recovery = { checkpoint: "task-boundary", resumeStrategy: "replay", staleExecution: "reconcile" };
  } else {
    copy.recovery = {
      checkpoint: ["disabled", "task-boundary", "event-interval"].includes(String(copy.recovery.checkpoint)) ? copy.recovery.checkpoint : "task-boundary",
      resumeStrategy: ["replay", "checkpoint-then-replay"].includes(String(copy.recovery.resumeStrategy)) ? copy.recovery.resumeStrategy : "replay",
      staleExecution: ["reconcile", "retry", "block"].includes(String(copy.recovery.staleExecution)) ? copy.recovery.staleExecution : "reconcile",
      ...(typeof copy.recovery.eventInterval === "number" ? { eventInterval: copy.recovery.eventInterval } : {})
    };
  }
  if (!Array.isArray(copy.dependencies)) copy.dependencies = [];
  if (!Array.isArray(copy.qualityGates)) copy.qualityGates = [];
  delete copy.recoveryPolicy;
  delete copy.gates;

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
      cleaned.title = typeof cleaned.title === "string" && cleaned.title.trim() !== "" ? cleaned.title.trim() : String(cleaned.id);
      cleaned.role = typeof cleaned.role === "string" && cleaned.role.trim() !== "" ? cleaned.role.trim() : "developer";
      cleaned.instruction = typeof cleaned.instruction === "string" && cleaned.instruction.trim() !== ""
        ? cleaned.instruction.trim()
        : (typeof cleaned.description === "string" && cleaned.description.trim() !== "" ? cleaned.description.trim() : cleaned.title);
      cleaned.requiresApproval = typeof cleaned.requiresApproval === "boolean" ? cleaned.requiresApproval : false;
      if (!Array.isArray(cleaned.qualityGates)) cleaned.qualityGates = [];
      if (typeof cleaned.acceptanceCriteria === "string") cleaned.acceptanceCriteria = [cleaned.acceptanceCriteria];
      else if (!Array.isArray(cleaned.acceptanceCriteria)) cleaned.acceptanceCriteria = [];

      const rawTimeout = isObject(cleaned.timeout) ? cleaned.timeout : undefined;
      const execMs = typeof cleaned.timeout === "number"
        ? cleaned.timeout
        : (typeof rawTimeout?.executionTimeoutMs === "number"
          ? (rawTimeout.executionTimeoutMs as number)
          : (typeof (task as Record<string, unknown>).timeoutMs === "number" ? ((task as Record<string, unknown>).timeoutMs as number) : 300_000));
      cleaned.timeout = {
        ...(rawTimeout ?? {}),
        executionTimeoutMs: execMs,
        onTimeout: ["fail", "retry", "block"].includes(String(rawTimeout?.onTimeout)) ? (rawTimeout!.onTimeout as string) : "fail"
      };

      // Keep a contract-shaped RetryPolicy intact; only fill missing fields with contract defaults.
      const rawRetry = isObject(cleaned.retry) ? cleaned.retry : undefined;
      const maxAtt = typeof cleaned.retry === "number"
        ? cleaned.retry
        : (typeof rawRetry?.maxAttempts === "number"
          ? (rawRetry.maxAttempts as number)
          : (typeof (task as Record<string, unknown>).maxAttempts === "number" ? ((task as Record<string, unknown>).maxAttempts as number) : 3));
      const initialDelay = typeof rawRetry?.initialDelayMs === "number" ? (rawRetry.initialDelayMs as number)
        : typeof rawRetry?.backoffMs === "number" ? (rawRetry.backoffMs as number) : 1000;
      const { backoffMs: _legacyBackoff, ...retryRest } = rawRetry ?? {};
      cleaned.retry = {
        ...retryRest,
        maxAttempts: maxAtt,
        strategy: ["fixed", "linear", "exponential"].includes(String(rawRetry?.strategy)) ? rawRetry!.strategy : "fixed",
        initialDelayMs: initialDelay,
        maxDelayMs: typeof rawRetry?.maxDelayMs === "number" ? rawRetry.maxDelayMs : Math.max(initialDelay, 60_000),
        jitter: typeof rawRetry?.jitter === "boolean" ? rawRetry.jitter : false,
        ...(typeof rawRetry?.multiplier === "number" ? { multiplier: rawRetry.multiplier as number } : {}),
        ...(Array.isArray(rawRetry?.retryableErrorCodes) ? { retryableErrorCodes: rawRetry.retryableErrorCodes } : {})
      };

      if (isObject(cleaned.metadata)) {
        const taskMeta = stripNullKeys(cleaned.metadata, ["conditionalTdd", "forbiddenPaths", "requiredCapabilities"]);
        if (typeof taskMeta.ownedPaths === "string") taskMeta.ownedPaths = [taskMeta.ownedPaths.trim()].filter(Boolean);
        if (isObject(taskMeta.conditionalTdd)) {
          taskMeta.conditionalTdd = normalizeConditionalTddOptionals(taskMeta.conditionalTdd);
        }
        cleaned.metadata = taskMeta;
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
