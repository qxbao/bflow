import { createHash } from "node:crypto";
import { MetadataSchema, SpecificationSchema, TddDecisionSchema, TestStrategySchema } from "@bflow/contracts";
import type { TestStrategy } from "@bflow/contracts";
import { AssessmentSchema, PolicySnapshotSchema } from "./schema.js";
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

export class TestStrategyResolver {
  resolve(input: unknown): TestStrategy {
    const spec = SpecificationSchema.parse(input);
    if (!spec.runId) throw new Error("Policy resolution requires Specification.runId");
    const assessment = AssessmentSchema.parse(spec.metadata?.conditionalTdd);
    const policy = evaluatePolicy(assessment, spec.acceptanceCriteria, spec.affectedPaths, spec.riskLevel);
    const digest = createHash("sha256").update(canonical({ specId: spec.specId, runId: spec.runId, version: spec.version,
      assessment, criteria: spec.acceptanceCriteria, paths: spec.affectedPaths, risk: policy.risk, updatedAt: spec.updatedAt })).digest("hex");
    const decision = TddDecisionSchema.parse({
      schemaVersion: 2, decisionId: `tdd-${digest}`, runId: spec.runId, taskId: assessment.taskId, specId: spec.specId,
      mode: policy.mode, rationale: `${policy.reason} Testability: ${assessment.testability.rationale} Effective risk: ${policy.risk}.`,
      verifiableConditions: policy.conditions, changeClassification: policy.classification,
      requiresFailingTestFirst: policy.mode === "required", decidedBy: "coordinator", decidedAt: spec.updatedAt
    });
    return TestStrategySchema.parse({
      schemaVersion: 2, strategyId: `strategy-${digest}`, specId: spec.specId, tddDecision: decision,
      requiredTestLevels: policy.levels, targetCommands: policy.commands, independentVerificationRequired: true,
      criterionMappings: spec.acceptanceCriteria.map(c => ({ criterionId: c.id, testNames: [`${c.id}: ${c.description}`] })),
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
      commands: p.commands, conditions: p.conditions, evidence: p.evidence,
      mappings: snapshot.acceptanceCriteria.map(c => ({ criterionId: c.id, testNames: [`${c.id}: ${c.description}`] }))
    };
    const actual = {
      mode: d.mode, classification: d.changeClassification, methods: snapshot.requiredVerificationMethods,
      levels: strategy.requiredTestLevels, commands: strategy.targetCommands, conditions: d.verifiableConditions,
      evidence: snapshot.evidenceRequirements, mappings: strategy.criterionMappings
    };
    if (canonical(expected) !== canonical(actual) || d.taskId !== snapshot.assessment.taskId ||
        canonical(snapshot.suggestedTestLevels) !== canonical(p.suggestedLevels) ||
        d.rationale !== `${p.reason} Testability: ${snapshot.assessment.testability.rationale} Effective risk: ${p.risk}.` ||
        d.requiresFailingTestFirst !== (p.mode === "required")) {
      throw new Error("Strategy violates the assessed conditional TDD policy");
    }
    return strategy;
  }

  /** Bind submitted policy back to the authoritative spec, including its assessment. */
  validateAgainstSpecification(input: unknown, specificationInput: unknown): TestStrategy {
    const strategy = this.validate(input);
    const expected = this.resolve(specificationInput);
    const withoutEvidence = { ...strategy, metadata: { conditionalTdd: strategy.metadata?.conditionalTdd } };
    if (canonical(withoutEvidence) !== canonical(expected)) throw new Error("Policy does not match the authoritative specification");
    return strategy;
  }
}
