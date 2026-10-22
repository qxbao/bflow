import { createHash } from "node:crypto";
import { MetadataSchema, SpecificationSchema, TddDecisionSchema, TestStrategySchema } from "@bflow/contracts";
import type { TestStrategy } from "@bflow/contracts";
import { AssessmentSchema, PolicySnapshotSchema, type Assessment } from "./schema.js";
import { evaluatePolicy } from "./policy.js";

/** Key-order independent comparison also used for idempotent evidence receipts. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Parses the P16 assessment carried by `Specification.metadata.conditionalTdd`. Issues are reported with their full
 * specification path, so a proposal missing the assessment (for example one that only carries `metadata.sdd`) is told
 * which field to add instead of receiving a path-less "expected object, received undefined".
 */
function parseAssessment(input: unknown): Assessment {
  const parsed = AssessmentSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map(issue => `${["metadata", "conditionalTdd", ...issue.path].join(".")}: ${issue.message}`);
  const missing = input === undefined ? " The P16 conditional TDD assessment is required beside metadata.sdd." : "";
  throw new Error(`Invalid Specification.metadata.conditionalTdd assessment.${missing} ${issues.join("; ")}`);
}

export class TestStrategyResolver {
  resolve(input: unknown): TestStrategy {
    const spec = SpecificationSchema.innerType().parse(input);
    if (!spec.runId) throw new Error("Policy resolution requires Specification.runId");
    const seenCriteriaIds = new Set<string>();
    spec.acceptanceCriteria.forEach((criterion) => {
      if (seenCriteriaIds.has(criterion.id)) {
        throw new Error(`duplicate acceptance criterion id: ${criterion.id}`);
      }
      seenCriteriaIds.add(criterion.id);
    });
    if (spec.level === "full") {
      if (!spec.architectureNotes) throw new Error("architectureNotes is required for full SDD level");
      if (!spec.securityConsiderations) throw new Error("securityConsiderations is required for full SDD level");
      if (!spec.rollbackPlan) throw new Error("rollbackPlan is required for full SDD level");
    }
    if (spec.status === "approved") {
      if (!spec.approvedBy) throw new Error("approvedBy is required when specification is approved");
      if (!spec.artifactRef) throw new Error("artifactRef is required when specification is approved");
    }

    const assessment = parseAssessment(spec.metadata?.conditionalTdd);
    const policy = evaluatePolicy(assessment, spec.acceptanceCriteria, spec.affectedPaths, spec.riskLevel);
    const digest = createHash("sha256").update(canonical({
      specId: spec.specId, runId: spec.runId, version: spec.version,
      assessment, criteria: spec.acceptanceCriteria, paths: spec.affectedPaths, risk: policy.risk
    })).digest("hex");

    const decision = TddDecisionSchema.parse({
      schemaVersion: 2, decisionId: `tdd-${digest}`, runId: spec.runId, taskId: assessment.taskId, specId: spec.specId,
      mode: policy.mode, rationale: `${policy.reason} Testability: ${assessment.testability.rationale} Effective risk: ${policy.risk}.`,
      verifiableConditions: policy.conditions, changeClassification: policy.classification,
      requiresFailingTestFirst: policy.mode === "required", decidedBy: "coordinator", decidedAt: spec.updatedAt
    });

    const requiredCriteria = spec.acceptanceCriteria.filter(c => c.required !== false);
    const existingMappings = spec.testStrategy?.criterionMappings;
    const hasValidExistingMappings = Array.isArray(existingMappings) &&
      existingMappings.length > 0 &&
      requiredCriteria.every(c =>
        existingMappings.some(m => m.criterionId === c.id && Array.isArray(m.testNames) && m.testNames.length > 0 && m.testNames.every(t => typeof t === "string" && t.trim().length > 0))
      );

    const criterionMappings = hasValidExistingMappings
      ? existingMappings!
      : spec.acceptanceCriteria.map(c => ({ criterionId: c.id, testNames: [`${c.id}: ${c.description}`] }));

    return TestStrategySchema.parse({
      schemaVersion: 2, strategyId: `strategy-${digest}`, specId: spec.specId, tddDecision: decision,
      requiredTestLevels: policy.levels, targetCommands: policy.commands, independentVerificationRequired: true,
      criterionMappings,
      createdAt: spec.updatedAt,
      metadata: MetadataSchema.parse({ conditionalTdd: {
        policyVersion: 1, assessment, acceptanceCriteria: spec.acceptanceCriteria, affectedPaths: spec.affectedPaths,
        riskLevel: policy.risk, requiredVerificationMethods: policy.methods, suggestedTestLevels: policy.suggestedLevels,
        evidenceRequirements: policy.evidence
      } })
    });
  }

  /** Enforce policy in addition to the shared wire schema; never trust a submitted mode alone. */
  validate(input: unknown): TestStrategy {
    const strategy = TestStrategySchema.parse(input);
    const snapshot = PolicySnapshotSchema.parse(strategy.metadata?.conditionalTdd);
    const p = evaluatePolicy(snapshot.assessment, snapshot.acceptanceCriteria, snapshot.affectedPaths, snapshot.riskLevel);
    const d = strategy.tddDecision;
    const expected = {
      mode: p.mode, classification: p.classification, methods: p.methods, levels: p.levels,
      commands: p.commands, conditions: p.conditions, evidence: p.evidence
    };
    const actual = {
      mode: d.mode, classification: d.changeClassification, methods: snapshot.requiredVerificationMethods,
      levels: strategy.requiredTestLevels, commands: strategy.targetCommands, conditions: d.verifiableConditions,
      evidence: snapshot.evidenceRequirements
    };
    if (canonical(expected) !== canonical(actual) || d.taskId !== snapshot.assessment.taskId ||
        canonical(snapshot.suggestedTestLevels) !== canonical(p.suggestedLevels) ||
        d.rationale !== `${p.reason} Testability: ${snapshot.assessment.testability.rationale} Effective risk: ${p.risk}.` ||
        d.requiresFailingTestFirst !== (p.mode === "required")) {
      throw new Error("Strategy violates the assessed conditional TDD policy");
    }
    const requiredCriteria = snapshot.acceptanceCriteria.filter(c => c.required !== false);
    for (const criterion of requiredCriteria) {
      const mapping = strategy.criterionMappings.find(m => m.criterionId === criterion.id);
      if (!mapping || !Array.isArray(mapping.testNames) || mapping.testNames.length === 0 ||
          mapping.testNames.some(name => typeof name !== "string" || name.trim().length === 0)) {
        throw new Error(`Strategy lacks required criterion mapping for ${criterion.id}`);
      }
    }
    return strategy;
  }

  /** Bind submitted policy back to the authoritative spec, including its assessment. */
  validateAgainstSpecification(strategyInput: unknown, specInput: unknown, decisionInput?: unknown): TestStrategy {
    const strategy = this.validate(strategyInput);
    const expected = this.resolve(specInput);
    if (decisionInput !== undefined) {
      const decision = TddDecisionSchema.parse(decisionInput);
      if (decision.decisionId !== strategy.tddDecision.decisionId || decision.mode !== strategy.tddDecision.mode) {
        throw new Error("TDD decision does not match the strategy decision");
      }
    }
    const withoutEvidence = {
      ...strategy,
      createdAt: expected.createdAt,
      criterionMappings: expected.criterionMappings,
      tddDecision: {
        ...strategy.tddDecision,
        decidedAt: expected.tddDecision.decidedAt
      },
      metadata: { conditionalTdd: strategy.metadata?.conditionalTdd }
    };
    if (canonical(withoutEvidence) !== canonical(expected)) throw new Error("Policy does not match the authoritative specification");
    return strategy;
  }
}
