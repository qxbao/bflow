import type { AcceptanceCriterion, Specification } from "@bflow/contracts";
import type { AssessmentSchema } from "@bflow/test-strategy";
import type { z } from "zod";
import { classifyChange } from "@bflow/specification";

type Assessment = z.infer<typeof AssessmentSchema>;
type VerificationMethod = AcceptanceCriterion["verificationMethod"];

const DOC_PATTERN = /\.(md|mdx|txt|rst|adoc)$/i;
const UI_PATTERN = /\.(html|css|scss|sass|less|jsx|tsx|vue|svelte)$/i;
const INFRA_PATTERN = /(^|\/)(pom\.xml|build\.gradle(\.kts)?|package\.json|Dockerfile|docker-compose.*|\.github\/.*|scripts\/.*|Makefile)$/i;

function documentationOnly(paths: readonly string[], criteria: readonly AcceptanceCriterion[]): boolean {
  return paths.length > 0 && paths.every(path => DOC_PATTERN.test(path)) &&
    !criteria.some(criterion => ["unit_test", "integration_test", "e2e_test"].includes(criterion.verificationMethod));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
}

/**
 * Intersects affectedPaths with literal ownedPaths.
 * Handles exact path matches, directory ownership, and subpath narrowing.
 * When ownedPaths is undefined or empty (legacy caller), returns affectedPaths unchanged.
 */
export function intersectPathsWithOwned(
  affectedPaths: readonly string[],
  ownedPaths?: readonly string[]
): string[] {
  if (!ownedPaths || ownedPaths.length === 0) {
    return [...affectedPaths];
  }
  const normalizedOwned = ownedPaths.map(normalizeRepoPath).filter(Boolean);
  if (!normalizedOwned.length) {
    return [...affectedPaths];
  }
  const result = new Set<string>();
  for (const rawAffected of affectedPaths) {
    const affected = normalizeRepoPath(rawAffected);
    if (!affected) continue;
    for (const owned of normalizedOwned) {
      if (affected === owned || affected.startsWith(`${owned}/`)) {
        result.add(affected);
      } else if (owned.startsWith(`${affected}/`)) {
        result.add(owned);
      }
    }
  }
  return [...result];
}

/**
 * Projects a workflow assessment to a task surface based on its owned/affected paths and criteria.
 * - Documentation-only tasks (touching only docs and having no behavioral criteria) do not inherit
 *   infrastructure, configuration, or ui_layout methods.
 * - Code tasks preserve effective risk at or above the workflow risk classification.
 * - Tasks without UI files do not inherit ui_layout.
 */
export function taskPolicyAssessment(
  draftAssessmentInput: unknown,
  taskPaths: readonly string[],
  taskCriteria: readonly AcceptanceCriterion[],
  rootRiskLevel?: string
): unknown {
  const a = record(draftAssessmentInput) as unknown as Assessment;
  if (!a || typeof a !== "object" || !a.changeImpact || !Array.isArray(a.changeImpact.surfaces)) {
    return draftAssessmentInput;
  }
  const normalizedPaths = taskPaths.map(normalizeRepoPath);
  const isDocOnly = documentationOnly(normalizedPaths, taskCriteria);

  if (isDocOnly) {
    return {
      ...a,
      taskType: "documentation",
      changeImpact: {
        ...a.changeImpact,
        surfaces: ["documentation"],
        behaviorChanged: false,
        deterministic: true,
        regressionReproducible: false,
        securitySensitive: false,
        dataMigration: false,
        scope: "local"
      },
      testability: {
        level: "none",
        rationale: "Documentation task; verified via manual review"
      },
      riskClassification: "low",
      conventions: {
        ...a.conventions,
        tdd: "contextual",
        requiredMethods: taskCriteria.map(c => c.verificationMethod as VerificationMethod),
        suggestedLevels: []
      }
    };
  }

  // Code or infrastructure task: filter surfaces that do not match the task's paths
  const hasUi = normalizedPaths.some(p => UI_PATTERN.test(p));
  const hasInfra = normalizedPaths.some(p => INFRA_PATTERN.test(p));
  const filteredSurfaces = a.changeImpact.surfaces.filter(s => {
    if (s === "ui_layout" && !hasUi) return false;
    if (s === "infrastructure" && !hasInfra && a.taskType !== "infrastructure") return false;
    return true;
  });
  const surfaces = filteredSurfaces.length > 0 ? filteredSurfaces : [a.taskType];

  const RISK_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  const effectiveRootRank = RISK_RANK[rootRiskLevel ?? ""] ?? 0;
  const taskRiskRank = RISK_RANK[a.riskClassification ?? ""] ?? 1;
  const effectiveRiskRank = Math.max(taskRiskRank, effectiveRootRank);
  const effectiveRiskClassification = effectiveRiskRank === 4 ? "critical" : effectiveRiskRank === 3 ? "high" : effectiveRiskRank === 2 ? "medium" : "low";

  const taskMethods = new Set(taskCriteria.map(c => c.verificationMethod));
  const conventions = a.conventions ? {
    ...a.conventions,
    requiredMethods: a.conventions.requiredMethods
      ? a.conventions.requiredMethods.filter(m => taskMethods.has(m as any))
      : []
  } : undefined;

  return {
    ...a,
    changeImpact: {
      ...a.changeImpact,
      surfaces
    },
    riskClassification: effectiveRiskClassification,
    ...(conventions ? { conventions } : {})
  };
}

/**
 * The specification input reviewed for one DAG task: its own criteria, traceability and conditional TDD assessment.
 * Intersects affectedPaths with ownedPaths so documentation tasks do not inherit unrelated code/infra paths.
 */
export function projectTaskSpecificationInput(
  draft: Specification,
  taskId: string,
  criteria: readonly AcceptanceCriterion[],
  specIdSuffix: string,
  conditionalTdd: unknown = draft.metadata?.conditionalTdd,
  ownedPaths?: readonly string[]
): Specification {
  const ids = new Set(criteria.map(criterion => criterion.id));
  const sdd = record(draft.metadata?.sdd);
  const projectedSpecId = `${draft.specId}-${specIdSuffix}`;
  const projectedPaths = intersectPathsWithOwned(draft.affectedPaths, ownedPaths);
  const rootRisk = draft.riskLevel ?? (draft.metadata?.sdd as any)?.assessment?.risk;
  const projectedTdd = taskPolicyAssessment(conditionalTdd, projectedPaths, criteria, rootRisk);
  // A documentation dossier has its own assessed impact. Keeping the root's riskLevel
  // here would reintroduce its implementation checks when the strategy is resolved.
  // The root dossier, its policy union and the bundled human approval remain unchanged.
  const documentationAssessment = documentationOnly(projectedPaths, criteria) ? {
    kind: "documentation" as const, behaviorChange: false, modules: [taskId],
    securityImpact: false, publicApiImpact: false, dataSchemaImpact: false,
    architectureImpact: false, migrationRequired: false, risk: "low" as const, unresolvedQuestions: []
  } : undefined;
  const classification = documentationAssessment ? classifyChange(documentationAssessment, projectedPaths) : undefined;

  return {
    ...draft,
    ...(classification ? { riskLevel: classification.riskLevel, complexity: classification.complexity, level: classification.level } : {}),
    specId: projectedSpecId,
    affectedPaths: projectedPaths,
    acceptanceCriteria: [...criteria],
    traceabilityTaskIds: [taskId],
    ...(draft.testStrategy
      ? {
          testStrategy: {
            ...draft.testStrategy,
            specId: projectedSpecId,
            tddDecision: { ...draft.testStrategy.tddDecision, specId: projectedSpecId, taskId },
            criterionMappings: draft.testStrategy.criterionMappings.filter(mapping => ids.has(mapping.criterionId))
          }
        }
      : {}),
    ...(draft.tddDecision ? { tddDecision: { ...draft.tddDecision, specId: projectedSpecId, taskId } } : {}),
    metadata: {
      ...draft.metadata,
      sdd: { ...sdd, ...(documentationAssessment ? { assessment: documentationAssessment } : {}),
        traceability: criteria.map(c => ({ criterionId: c.id, taskIds: [taskId] })) },
      conditionalTdd: { ...record(projectedTdd), taskId }
    }
  } as Specification;
}
