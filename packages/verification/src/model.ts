import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AcceptanceCriterionSchema, IdentifierSchema, QualityGateDefinitionSchema,
  SpecificationSchema, TestStrategySchema, VerificationScopeSchema
} from "@bflow/contracts";

export const MethodSchema = AcceptanceCriterionSchema.innerType().shape.verificationMethod;
// These are package-local configuration/metadata codecs, not new wire contracts.
export const CheckConfigurationSchema = z.object({
  kind: z.enum(["deterministic", "review"]),
  method: MethodSchema,
  command: z.string().min(1).optional(),
  criterionIds: z.array(IdentifierSchema),
  testNames: z.array(z.string().min(1)),
  role: z.enum(["quality_gate", "tester", "reviewer", "qa"]),
  measuresCoverage: z.boolean().optional(),
  // Exhaustive impact declaration by the trusted host; absent means global impact.
  dependsOnPaths: z.array(z.string().min(1)).min(1).optional(),
  levels: z.array(z.enum(["unit", "integration", "e2e", "property", "regression", "smoke"]))
}).strict().superRefine((v, ctx) => {
  if (v.kind === "deterministic" && (!v.command || v.method === "manual_review"))
    ctx.addIssue({ code: "custom", message: "deterministic checks need a command and automated method" });
  const permitted: Record<string, string[]> = { unit_test: ["unit", "property", "regression"],
    integration_test: ["integration", "regression", "smoke"], e2e_test: ["e2e", "regression", "smoke"] };
  if (v.measuresCoverage && v.kind !== "deterministic")
    ctx.addIssue({ code: "custom", message: "Coverage measurements require a deterministic check" });
  if (v.levels.some(level => !permitted[v.method]?.includes(level)))
    ctx.addIssue({ code: "custom", message: "Test levels must correspond to the executable test method" });
  if (v.kind === "review" && (v.method !== "manual_review" || !["reviewer", "qa"].includes(v.role)))
    ctx.addIssue({ code: "custom", message: "review requires manual_review and reviewer/qa" });
});
export type CheckConfiguration = z.infer<typeof CheckConfigurationSchema>;
export const ObservationSchema = z.object({
  schemaVersion: z.literal(2),
  checkId: IdentifierSchema,
  runId: IdentifierSchema,
  taskId: IdentifierSchema,
  attemptId: IdentifierSchema,
  sourceRevision: z.string().regex(/^[a-f0-9]{7,40}$/i),
  specFingerprint: z.string().length(64),
  scope: VerificationScopeSchema,
  independentExecution: z.literal(true),
  isolated: z.literal(true),
  executorId: IdentifierSchema,
  role: z.enum(["quality_gate", "tester", "reviewer", "qa"]),
  method: MethodSchema,
  command: z.string().min(1).optional(),
  exitCode: z.number().int().optional(),
  coveragePercent: z.number().min(0).max(100).optional(),
  testNames: z.array(z.string().min(1)),
  criteria: z.array(z.object({
    criterionId: IdentifierSchema,
    passed: z.boolean(),
    summary: z.string().trim().min(1)
  }).strict()),
  summary: z.string().trim().min(1)
}).strict();
export type Observation = z.infer<typeof ObservationSchema>;

export const PlanInputSchema = z.object({
  runId: IdentifierSchema,
  taskId: IdentifierSchema,
  scope: VerificationScopeSchema,
  specification: SpecificationSchema,
  strategy: TestStrategySchema,
  checks: z.array(QualityGateDefinitionSchema).min(1),
  implementerIds: z.array(IdentifierSchema).min(1),
  maxIterations: z.number().int().min(1).max(10).default(3)
}).strict();
export type VerificationPlan = z.infer<typeof PlanInputSchema> & {
  planId: string;
  specFingerprint: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function safePath(path: string): boolean {
  return !path.startsWith("/") && !path.includes("\\") && !path.includes(":") && !/[*?]/.test(path) &&
    path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}
export function covers(prefix: string, path: string): boolean {
  return prefix === path || path.startsWith(`${prefix.replace(/\/$/, "")}/`);
}
export function createVerificationPlan(input: unknown): VerificationPlan {
  const value = PlanInputSchema.parse(input);
  const { specification: spec, strategy, checks } = value;
  if (spec.status !== "approved" || spec.runId !== value.runId || strategy.specId !== spec.specId ||
      strategy.tddDecision.runId !== value.runId ||
      (strategy.tddDecision.taskId !== undefined && value.scope === "task" && strategy.tddDecision.taskId !== value.taskId))
    throw new Error("Approved specification, strategy and run/task must agree");
  if ((spec.testStrategy && digest(spec.testStrategy) !== digest(strategy)) ||
      (spec.tddDecision && digest(spec.tddDecision) !== digest(strategy.tddDecision)))
    throw new Error("Conflicting specification strategy or TDD decision");
  if (spec.artifactRef?.runId !== value.runId || spec.artifactRef.kind !== "document" || spec.artifactRef.mediaType !== "application/json")
    throw new Error("Specification evidence must be a stored JSON document in the same run");
  if (!spec.affectedPaths.every(safePath)) throw new Error("Affected paths must be safe literal repository paths");
  const criteria = new Set(spec.acceptanceCriteria.map(c => c.id));
  const mappings = new Map<string, string[]>();
  for (const mapping of strategy.criterionMappings) {
    if (!criteria.has(mapping.criterionId) || mappings.has(mapping.criterionId)) throw new Error("Invalid criterion mapping");
    mappings.set(mapping.criterionId, mapping.testNames);
  }
  const ids = new Set<string>();
  const configs = checks.map(check => {
    if (ids.has(check.id) || !check.required) throw new Error("Checks must have unique IDs and be required");
    ids.add(check.id);
    const config = CheckConfigurationSchema.parse(check.configuration);
    if (new Set(config.criterionIds).size !== config.criterionIds.length || config.criterionIds.some(id => !criteria.has(id)))
      throw new Error("Unknown or duplicate check criterion");
    if (config.dependsOnPaths?.some(path => !safePath(path))) throw new Error("Unsafe check dependency path");
    return config;
  });
  if (!configs.some(c => c.kind === "review")) throw new Error("An independent Reviewer or QA check is required");
  for (const criterion of spec.acceptanceCriteria) {
    const names = mappings.get(criterion.id);
    if (!names || !configs.some(c => c.method === criterion.verificationMethod && c.criterionIds.includes(criterion.id) &&
        names.every(name => c.testNames.includes(name)))) throw new Error(`No complete check mapping for ${criterion.id}`);
  }
  if (strategy.coverageThresholdPercent !== undefined && !configs.some(c => c.measuresCoverage))
    throw new Error("Coverage threshold needs a configured aggregate coverage check");
  for (const command of strategy.targetCommands)
    if (!configs.some(c => c.kind === "deterministic" && c.command === command)) throw new Error(`Unconfigured strategy command: ${command}`);
  for (const level of strategy.requiredTestLevels)
    if (!configs.some(c => c.kind === "deterministic" && c.levels.includes(level))) throw new Error(`Missing test level: ${level}`);
  if (value.scope === "workflow" && !configs.some(c => c.kind === "deterministic" && (c.levels.includes("integration") || c.levels.includes("e2e") || c.levels.includes("regression"))))
    throw new Error("Workflow verification needs post-integration regression/integration/E2E checks");
  return { ...value, planId: `plan-${digest(value)}`, specFingerprint: digest(spec) };
}
