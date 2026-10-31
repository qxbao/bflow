import { ChangeComplexitySchema, RiskLevelSchema, SddPolicyLevelSchema } from "@bflow/contracts";
import type { ChangeComplexity, OperationResult } from "@bflow/contracts";
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
  unresolvedQuestions: z.array(z.string().trim().min(1)).default([])
}).strict();

export type ChangeAssessment = z.infer<typeof ChangeAssessmentSchema>;

export const ClassificationSchema = z.object({
  complexity: ChangeComplexitySchema,
  level: SddPolicyLevelSchema,
  riskLevel: RiskLevelSchema,
  humanApprovalRequired: z.boolean(),
  reasons: z.array(z.string().min(1)).min(1)
}).strict();

export type Classification = z.infer<typeof ClassificationSchema>;

export function hasSecurityPathHint(paths: readonly string[]): boolean {
  return paths.some(path => /(?:security|auth|crypto|secret|permission|credential|rbac|token|jwt|oauth|acl|tls|cert|password|sanitize)/i.test(path));
}

export function hasPublicApiPathHint(paths: readonly string[]): boolean {
  return paths.some(path => /(?:^|[/\\])(?:contracts|openapi|proto|graphql)(?:[/\\]|\.|$)/i.test(path));
}

export function hasDataSchemaPathHint(paths: readonly string[]): boolean {
  return paths.some(path => /(?:^|[/\\])(?:migrations?|schema)(?:[/\\]|\.|$)|\.sql$/i.test(path));
}

export function classifyChange(input: unknown, affectedPaths: readonly string[] = []): Classification {
  const change = ChangeAssessmentSchema.parse(input);
  const paths = z.array(z.string().trim().min(1)).parse(affectedPaths);
  const reasons: string[] = [];
  // Conservative hints complement the explicit assessment, including docs about security.
  if (change.securityImpact || hasSecurityPathHint(paths)) {
    reasons.push("security impact");
  }
  if (change.publicApiImpact || hasPublicApiPathHint(paths)) {
    reasons.push("public API contract impact");
  }
  if (change.dataSchemaImpact || hasDataSchemaPathHint(paths)) {
    reasons.push("persistent data schema impact");
  }
  if (change.architectureImpact) reasons.push("architecture impact");
  const normalizedModules = change.modules.map(m => m.replace(/[/\\]+$/, "") || m);
  if (new Set(normalizedModules).size > 1) reasons.push("multiple modules affected");
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

export function classifyChangeSafe(
  input: unknown,
  affectedPaths: readonly string[] = []
): OperationResult<Classification> {
  try {
    const value = classifyChange(input, affectedPaths);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        error: {
          code: "validation",
          message: error.message,
          retryable: false,
          details: { issues: JSON.parse(JSON.stringify(error.issues)) }
        }
      };
    }
    return {
      ok: false,
      error: {
        code: "validation",
        message: error instanceof Error ? error.message : String(error),
        retryable: false
      }
    };
  }
}

export const RequiredSpecSectionsSchema = z.array(z.string().trim().min(1));
export type RequiredSpecSections = z.infer<typeof RequiredSpecSectionsSchema>;

export function getRequiredSpecSections(
  complexity: ChangeComplexity,
  migrationOrSchemaImpact = false
): string[] {
  if (complexity === "trivial") {
    return [
      "title",
      "summary",
      "problemStatement",
      "scope",
      "acceptanceCriteria",
      "affectedPaths"
    ];
  }
  if (complexity === "standard") {
    return [
      "title",
      "summary",
      "problemStatement",
      "scope",
      "acceptanceCriteria",
      "affectedPaths",
      "functionalRequirements",
      "proposedTestStrategy"
    ];
  }
  const sections = [
    "title",
    "summary",
    "problemStatement",
    "scope",
    "acceptanceCriteria",
    "affectedPaths",
    "functionalRequirements",
    "proposedTestStrategy",
    "designProposal",
    "technicalConstraints",
    "apiDataContracts",
    "risksAndTradeoffs",
    "architectureNotes",
    "securityConsiderations",
    "rollbackPlan",
    "testStrategy",
    "tddDecision"
  ];
  if (migrationOrSchemaImpact) {
    sections.push("dataModelChanges", "migrationStrategy");
  }
  return sections;
}
