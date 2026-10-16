import { z } from "zod";
import {
  AcceptanceCriterionSchema,
  VerificationResultSchema,
  type AcceptanceCriterion,
  type Specification
} from "@bflow/contracts";
import { parseContractOrP15Specification, parseSpecification, policyDetails } from "./schema.js";

const METHOD_RIGOR: Record<AcceptanceCriterion["verificationMethod"], number> = {
  e2e_test: 5,
  integration_test: 4,
  unit_test: 3,
  static_analysis: 2,
  typecheck: 2,
  lint: 2,
  manual_review: 1
};

export interface CriterionUpdatePatch {
  readonly description?: string;
  readonly category?: AcceptanceCriterion["category"];
  readonly verificationMethod?: AcceptanceCriterion["verificationMethod"];
  readonly required?: boolean;
  readonly mappedTaskIds?: readonly string[];
}

export interface CriterionEvaluation {
  readonly criterionId: string;
  readonly required: boolean;
  readonly status: "satisfied" | "failed" | "pending";
  readonly evidenceArtifactIds: readonly string[];
  readonly summary?: string;
}

export interface CriteriaEvaluationSummary {
  readonly allRequiredSatisfied: boolean;
  readonly evaluations: ReadonlyArray<CriterionEvaluation>;
}

export function addCriterionToDraft(
  specInput: unknown,
  criterionInput: unknown,
  mappedTaskIds: readonly string[] = []
): Specification {
  const spec = parseSpecification(specInput);
  const criterion = AcceptanceCriterionSchema.parse(criterionInput);
  const validatedMappedTaskIds = z.array(z.string().trim().min(1)).parse(mappedTaskIds);

  if (spec.status !== "draft" || spec.approvedBy !== undefined || spec.artifactRef !== undefined) {
    throw new Error("Cannot mutate acceptance criteria on a non-draft specification; create a new version");
  }

  if (criterion.status !== "pending" || criterion.evidenceArtifactIds.length > 0 || criterion.waiverReason !== undefined) {
    throw new Error("Draft criterion must start in pending status without evidence or waiver");
  }

  if (spec.acceptanceCriteria.some(existing => existing.id === criterion.id)) {
    throw new Error(`Duplicate acceptance criterion id: ${criterion.id}`);
  }

  const details = policyDetails(spec);
  const currentTraceability = details.traceability;
  const updatedTraceability = validatedMappedTaskIds.length > 0
    ? [...currentTraceability, { criterionId: criterion.id, taskIds: [...new Set(validatedMappedTaskIds)] }]
    : currentTraceability;
  const updatedTraceabilityTaskIds = [...new Set(updatedTraceability.flatMap(m => m.taskIds))].sort();

  let updatedTestStrategy = spec.testStrategy;
  if (updatedTestStrategy && criterion.required) {
    if (!updatedTestStrategy.criterionMappings.some(m => m.criterionId === criterion.id)) {
      updatedTestStrategy = {
        ...updatedTestStrategy,
        criterionMappings: [
          ...updatedTestStrategy.criterionMappings,
          { criterionId: criterion.id, testNames: [`test:${criterion.id}`] }
        ]
      };
    }
  }

  const updated = {
    ...spec,
    acceptanceCriteria: [...spec.acceptanceCriteria, criterion],
    traceabilityTaskIds: updatedTraceabilityTaskIds,
    ...(updatedTestStrategy ? { testStrategy: updatedTestStrategy } : {}),
    metadata: {
      ...spec.metadata,
      sdd: {
        ...details,
        traceability: updatedTraceability
      }
    }
  };

  return parseSpecification(updated);
}

export function updateCriterionInDraft(
  specInput: unknown,
  criterionId: string,
  patch: CriterionUpdatePatch
): Specification {
  const spec = parseSpecification(specInput);

  if (spec.status !== "draft" || spec.approvedBy !== undefined || spec.artifactRef !== undefined) {
    throw new Error("Cannot mutate acceptance criteria on a non-draft specification; create a new version");
  }

  const index = spec.acceptanceCriteria.findIndex(c => c.id === criterionId);
  const target = spec.acceptanceCriteria[index];
  if (index === -1 || !target) {
    throw new Error(`Acceptance criterion not found: ${criterionId}`);
  }

  const updatedCriterion: AcceptanceCriterion = {
    ...target,
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.category !== undefined ? { category: patch.category } : {}),
    ...(patch.verificationMethod !== undefined ? { verificationMethod: patch.verificationMethod } : {}),
    ...(patch.required !== undefined ? { required: patch.required } : {})
  };

  const updatedCriteria = [...spec.acceptanceCriteria];
  updatedCriteria[index] = updatedCriterion;

  const details = policyDetails(spec);
  let updatedTraceability = details.traceability;
  if (patch.mappedTaskIds !== undefined) {
    const validatedMappedTaskIds = z.array(z.string().trim().min(1)).parse(patch.mappedTaskIds);
    if (validatedMappedTaskIds.length > 0) {
      const existingMappingIndex = updatedTraceability.findIndex(m => m.criterionId === criterionId);
      const newMapping = { criterionId, taskIds: [...new Set(validatedMappedTaskIds)] };
      if (existingMappingIndex >= 0) {
        updatedTraceability = updatedTraceability.map((m, i) => i === existingMappingIndex ? newMapping : m);
      } else {
        updatedTraceability = [...updatedTraceability, newMapping];
      }
    } else {
      updatedTraceability = updatedTraceability.filter(m => m.criterionId !== criterionId);
    }
  }
  const updatedTraceabilityTaskIds = [...new Set(updatedTraceability.flatMap(m => m.taskIds))].sort();

  let updatedTestStrategy = spec.testStrategy;
  if (updatedTestStrategy && updatedCriterion.required) {
    if (!updatedTestStrategy.criterionMappings.some(m => m.criterionId === criterionId)) {
      updatedTestStrategy = {
        ...updatedTestStrategy,
        criterionMappings: [
          ...updatedTestStrategy.criterionMappings,
          { criterionId, testNames: [`test:${criterionId}`] }
        ]
      };
    }
  }

  const updated = {
    ...spec,
    acceptanceCriteria: updatedCriteria,
    traceabilityTaskIds: updatedTraceabilityTaskIds,
    ...(updatedTestStrategy ? { testStrategy: updatedTestStrategy } : {}),
    metadata: {
      ...spec.metadata,
      sdd: {
        ...details,
        traceability: updatedTraceability
      }
    }
  };

  return parseSpecification(updated);
}

export function removeCriterionFromDraft(
  specInput: unknown,
  criterionId: string
): Specification {
  const spec = parseSpecification(specInput);

  if (spec.status !== "draft" || spec.approvedBy !== undefined || spec.artifactRef !== undefined) {
    throw new Error("Cannot mutate acceptance criteria on a non-draft specification; create a new version");
  }

  if (!spec.acceptanceCriteria.some(c => c.id === criterionId)) {
    throw new Error(`Acceptance criterion not found: ${criterionId}`);
  }

  const updatedCriteria = spec.acceptanceCriteria.filter(c => c.id !== criterionId);
  const details = policyDetails(spec);
  const updatedTraceability = details.traceability.filter(m => m.criterionId !== criterionId);
  const updatedTraceabilityTaskIds = [...new Set(updatedTraceability.flatMap(m => m.taskIds))].sort();

  let updatedTestStrategy = spec.testStrategy;
  if (updatedTestStrategy) {
    updatedTestStrategy = {
      ...updatedTestStrategy,
      criterionMappings: updatedTestStrategy.criterionMappings.filter(m => m.criterionId !== criterionId)
    };
  }

  const updated = {
    ...spec,
    acceptanceCriteria: updatedCriteria,
    traceabilityTaskIds: updatedTraceabilityTaskIds,
    ...(updatedTestStrategy ? { testStrategy: updatedTestStrategy } : {}),
    metadata: {
      ...spec.metadata,
      sdd: {
        ...details,
        traceability: updatedTraceability
      }
    }
  };

  return parseSpecification(updated);
}

export function assertNoCriteriaWeakeningOnFailure(
  previousSpecInput: unknown,
  proposedSpecInput: unknown,
  failedVerificationInput: unknown,
  options?: { explicitUserRequirementChangeAuthorized?: boolean }
): void {
  const previousSpec = parseContractOrP15Specification(previousSpecInput);
  const proposedSpec = parseContractOrP15Specification(proposedSpecInput);
  const failedVerification = VerificationResultSchema.parse(failedVerificationInput);

  if (
    previousSpec.specId !== proposedSpec.specId ||
    previousSpec.sessionId !== proposedSpec.sessionId ||
    previousSpec.runId !== proposedSpec.runId
  ) {
    throw new Error("Criteria weakening check requires matching specification, session and run identity");
  }

  if (previousSpec.runId !== undefined && failedVerification.runId !== previousSpec.runId) {
    throw new Error("Verification runId does not match specification runId");
  }

  if (options?.explicitUserRequirementChangeAuthorized === true) {
    return;
  }

  const failedCriterionIds = failedVerification.evaluatedCriteria
    .filter(c => !c.passed)
    .map(c => c.criterionId);

  const prevCriteriaMap = new Map(previousSpec.acceptanceCriteria.map(c => [c.id, c]));
  const proposedCriteriaMap = new Map(proposedSpec.acceptanceCriteria.map(c => [c.id, c]));

  for (const id of failedCriterionIds) {
    const prevCriterion = prevCriteriaMap.get(id);
    const proposedCriterion = proposedCriteriaMap.get(id);

    if (!prevCriterion) {
      continue;
    }

    // (a) removed in proposedSpec
    if (!proposedCriterion) {
      throw new Error(`Cannot weaken or remove failed acceptance criterion ${id} to legitimize a failing implementation`);
    }

    // (b) changed from required: true to required: false
    if (prevCriterion.required && !proposedCriterion.required) {
      throw new Error(`Cannot weaken or remove failed acceptance criterion ${id} to legitimize a failing implementation`);
    }

    // (c) weakened in verificationMethod
    if (METHOD_RIGOR[proposedCriterion.verificationMethod] < METHOD_RIGOR[prevCriterion.verificationMethod]) {
      throw new Error(`Cannot weaken or remove failed acceptance criterion ${id} to legitimize a failing implementation`);
    }

    // (d) category changed
    if (prevCriterion.category !== proposedCriterion.category) {
      throw new Error(`Cannot weaken or remove failed acceptance criterion ${id} to legitimize a failing implementation`);
    }

    // (e) had its description altered while the verification is failing
    if (prevCriterion.description !== proposedCriterion.description) {
      throw new Error(`Cannot weaken or remove failed acceptance criterion ${id} to legitimize a failing implementation`);
    }
  }
}

export function evaluateCriteriaFromVerification(
  specInput: unknown,
  verificationInput: unknown
): CriteriaEvaluationSummary {
  const spec = parseContractOrP15Specification(specInput);
  const verification = VerificationResultSchema.parse(verificationInput);

  if (spec.runId !== undefined && verification.runId !== spec.runId) {
    throw new Error("Verification runId does not match specification runId");
  }

  const evaluations: CriterionEvaluation[] = [];

  for (const criterion of spec.acceptanceCriteria) {
    const matches = verification.evaluatedCriteria.filter(e => e.criterionId === criterion.id);

    if (matches.length === 0) {
      evaluations.push({
        criterionId: criterion.id,
        required: criterion.required,
        status: "pending",
        evidenceArtifactIds: criterion.evidenceArtifactIds
      });
    } else {
      const allPassed = matches.every(m => m.passed);
      const evidenceArtifactIds = [...new Set(matches.map(m => m.evidenceArtifactId))];
      const summary = matches.map(m => m.summary).join("; ");

      evaluations.push({
        criterionId: criterion.id,
        required: criterion.required,
        status: allPassed ? "satisfied" : "failed",
        evidenceArtifactIds,
        summary
      });
    }
  }

  const allRequiredSatisfied = spec.acceptanceCriteria
    .filter(c => c.required)
    .every(c => {
      const ev = evaluations.find(e => e.criterionId === c.id);
      return ev?.status === "satisfied";
    });

  return {
    allRequiredSatisfied,
    evaluations
  };
}
