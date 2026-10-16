import { ChangeComplexitySchema, RiskLevelSchema, SddPolicyLevelSchema } from "@bflow/contracts";
import { z } from "zod";

/** Structured impact assessment, supplied by Analyst/Architect, never inferred from diff size. */
export const ChangeAssessmentSchema = z.object({
  kind: z.enum(["documentation", "formatting", "feature", "bugfix", "refactoring", "configuration"]),
  behaviorChange: z.boolean(),
  modules: z.array(z.string().trim().min(1)).min(1),
  securityImpact: z.boolean(),
  publicApiImpact: z.boolean(),
  dataSchemaImpact: z.boolean(),
  architectureImpact: z.boolean(),
  migrationRequired: z.boolean(),
  risk: RiskLevelSchema,
  unresolvedQuestions: z.array(z.string().trim().min(1))
}).strict();

export const ClassificationSchema = z.object({
  complexity: ChangeComplexitySchema,
  level: SddPolicyLevelSchema,
  riskLevel: RiskLevelSchema,
  humanApprovalRequired: z.boolean(),
  reasons: z.array(z.string().min(1)).min(1)
}).strict();

export function classifyChange(input: unknown, affectedPaths: readonly string[] = []) {
  const change = ChangeAssessmentSchema.parse(input);
  const paths = z.array(z.string().trim().min(1)).parse(affectedPaths);
  const reasons: string[] = [];
  // Conservative hints complement the explicit assessment, including docs about security.
  if (change.securityImpact || paths.some(path => /(?:security|auth|crypto|secret|permission|credential)/i.test(path))) {
    reasons.push("security impact");
  }
  if (change.publicApiImpact || paths.some(path => /(?:^|\/)(?:contracts|openapi|proto)(?:\/|\.|$)/i.test(path))) {
    reasons.push("public API contract impact");
  }
  if (change.dataSchemaImpact || paths.some(path => /(?:^|\/)(?:migrations?|schema)(?:\/|\.|$)/i.test(path))) {
    reasons.push("persistent data schema impact");
  }
  if (change.architectureImpact) reasons.push("architecture impact");
  if (new Set(change.modules).size > 1) reasons.push("multiple modules affected");
  if (change.migrationRequired) reasons.push("migration required");
  if (change.risk === "high" || change.risk === "critical") reasons.push("high declared risk");
  const complex = reasons.length > 0;
  const trivial = !complex && change.risk === "low" && !change.behaviorChange && change.kind !== "feature" && change.kind !== "bugfix";
  return ClassificationSchema.parse({
    complexity: complex ? "complex" : trivial ? "trivial" : "standard",
    level: complex || change.kind === "feature" ? "full" : "lightweight",
    riskLevel: change.risk === "critical" ? "critical" : complex ? "high" : trivial ? "low" : "medium",
    humanApprovalRequired: complex,
    reasons: complex ? reasons : [trivial ? "local change without behavioral impact" : "ordinary behavior change"]
  });
}
