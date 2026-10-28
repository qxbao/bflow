import { posix } from "node:path";
import { z } from "zod";
import { JsonValueSchema } from "@bflow/contracts";
import { canonicalPlanDigest } from "../planning/index.js";

/**
 * Runtime-private models of the QA-only workflow extension (test an existing system without changing it). They never
 * cross a package boundary as public wire shapes: Core/RunStore/ArtifactStore/approval/grant data use `@bflow/contracts`.
 */
export const QA_SCHEMA_VERSION = 1 as const;
const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/);
const Text = z.string().trim().min(1).max(4000);

/** Every action a test may take on the target; the intake allow-list is checked at design time and again before each call. */
export const QA_ACTIONS = ["http_read", "http_mutate", "browser_navigate", "browser_interact"] as const;
export const QaActionSchema = z.enum(QA_ACTIONS);
export type QaAction = z.infer<typeof QaActionSchema>;
export const MUTATING_ACTIONS: readonly QaAction[] = ["http_mutate", "browser_interact"];

export const QaTaskKindSchema = z.enum(["design", "design-review", "execution", "adjudication", "report"]);
export type QaTaskKind = z.infer<typeof QaTaskKindSchema>;

/** Final, adjudicated outcome of one test case. */
export const QA_CLASSIFICATIONS = ["passed", "product_failure", "test_defect", "environment_failure", "blocked", "inconclusive"] as const;
export const QaClassificationSchema = z.enum(QA_CLASSIFICATIONS);
export type QaClassification = z.infer<typeof QaClassificationSchema>;

const OriginSchema = z.string().max(256).refine(value => {
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value; }
  catch { return false; }
}, "origin must be an exact scheme://host[:port] origin without path");
const RoutePath = z.string().min(1).max(2048).refine(value => value.startsWith("/") && !value.startsWith("//") && !value.includes("\\"),
  "path must be origin-relative");
const RelativePath = z.string().min(1).max(256);

function normalizedRelative(path: string): string | undefined {
  const normalized = posix.normalize(path.replace(/\\/g, "/")).replace(/\/$/, "");
  if (!path || path.startsWith("/") || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.includes("\0")) return undefined;
  return normalized;
}
export function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Intake of a QA-only request: the approved target and origins, product criteria under test, the action allow-list,
 * account/data policy, cleanup expectations, the writable test workspace and the protected product paths.
 */
export const QaIntakeSchema = z.object({
  schemaVersion: z.literal(QA_SCHEMA_VERSION),
  requestId: Id,
  sessionId: Id,
  title: Text,
  userStatements: z.array(z.object({ id: Id, text: Text }).strict()).min(1),
  target: z.object({
    environmentId: Id,
    /** `fixture` is an isolated throwaway environment; anything else needs an authenticated human access grant. */
    kind: z.enum(["fixture", "non_production", "production"]),
    /** Exact approved origins; the first is the primary origin for origin-relative URLs. Redirects never widen this list. */
    origins: z.array(OriginSchema).min(1).max(8),
    readinessPath: RoutePath.default("/"),
    /** Where the deployed build identity is observed. Absent or unobservable means the limitation is reported. */
    buildIdentity: z.object({ path: RoutePath.optional(), pointer: z.string().max(256).optional(), header: z.string().regex(/^[A-Za-z0-9-]+$/).optional() })
      .strict().optional()
  }).strict(),
  /** Product acceptance criteria under test. */
  criteria: z.array(z.object({ id: Id, description: Text, required: z.boolean().default(true) }).strict()).min(1),
  allowedActions: z.array(QaActionSchema).min(1),
  accountPolicy: z.object({
    accounts: z.array(z.object({ id: Id, kind: z.enum(["isolated_fixture", "shared_readonly"]), description: Text }).strict()).default([])
  }).strict().default({}),
  dataPolicy: z.object({
    /** Data created by tests carries this prefix so it is identifiable and never confused with real data. */
    fixturePrefix: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/),
    redactKeys: z.array(z.string().min(1).max(64)).default([]),
    redactHeaders: z.array(z.string().regex(/^[A-Za-z0-9-]+$/)).default([])
  }).strict(),
  cleanup: z.object({ required: z.boolean().default(true) }).strict().default({}),
  /** Repository-relative root of the writable test workspace (assets and report). */
  workspace: z.object({ assetRoot: RelativePath.default("qa") }).strict().default({}),
  /** Product source/deploy/config paths of the target; never writable, checked unchanged after execution. */
  protectedPaths: z.array(RelativePath).default([]),
  revision: z.number().int().positive().default(1)
}).strict().superRefine((intake, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  for (const list of [intake.userStatements.map(item => item.id), intake.criteria.map(item => item.id), intake.accountPolicy.accounts.map(item => item.id)])
    if (new Set(list).size !== list.length) issue("Duplicate intake identifier");
  if (!intake.criteria.some(item => item.required)) issue("At least one product criterion must be required");
  if (intake.target.kind === "production" && intake.allowedActions.some(action => MUTATING_ACTIONS.includes(action)))
    issue("Production targets cannot allow mutating actions");
  const assetRoot = normalizedRelative(intake.workspace.assetRoot);
  if (!assetRoot) issue("workspace.assetRoot must be a normalized repository-relative path");
  for (const path of intake.protectedPaths) {
    const normalized = normalizedRelative(path);
    if (!normalized) issue(`Protected path must be repository-relative: ${path}`);
    else if (assetRoot && overlaps(assetRoot, normalized)) issue(`The test workspace overlaps the protected product path ${path}`);
  }
});
export type QaIntake = z.infer<typeof QaIntakeSchema>;
export type QaIntakeInput = z.input<typeof QaIntakeSchema>;

const JsonAssertion = z.object({ pointer: z.string().max(256).refine(value => value === "" || value.startsWith("/")),
  equals: JsonValueSchema.optional(), exists: z.boolean().optional() }).strict()
  .refine(value => (value.equals !== undefined) !== (value.exists !== undefined), "json assertion needs exactly one of equals or exists");
export const HttpStepSchema = z.object({
  kind: z.literal("http"),
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  /** Origin-relative path (primary origin) or absolute URL on an approved origin; `${var}` placeholders are substituted. */
  url: z.string().min(1).max(2048),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(4096)).optional(),
  body: JsonValueSchema.optional(),
  /** Variables captured from the JSON response by pointer, for later steps and cleanup. */
  capture: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/), z.string().max(256)).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  expect: z.object({ status: z.number().int().min(100).max(599).optional(), json: z.array(JsonAssertion).max(32).optional(),
    bodyContains: z.array(z.string().min(1).max(1024)).max(16).optional() }).strict().optional()
}).strict();
export const BrowserStepSchema = z.object({
  kind: z.literal("browser"),
  op: z.enum(["navigate", "assert_visible", "click", "fill"]),
  url: z.string().min(1).max(2048).optional(),
  selector: z.string().min(1).max(512).optional(),
  text: z.string().max(1024).optional(),
  value: z.string().max(4096).optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional()
}).strict();
export const QaStepSchema = z.discriminatedUnion("kind", [HttpStepSchema, BrowserStepSchema]);
export type QaHttpStep = z.infer<typeof HttpStepSchema>;
export type QaBrowserStep = z.infer<typeof BrowserStepSchema>;
export type QaStep = z.infer<typeof QaStepSchema>;

export const QaCaseSchema = z.object({
  id: Id,
  title: Text,
  criterionIds: z.array(Id).min(1),
  sideEffect: z.enum(["none", "mutating"]),
  /** Account the case runs as; mutating cases need an isolated fixture account unless the whole target is a fixture. */
  account: Id.optional(),
  expected: Text,
  steps: z.array(QaStepSchema).min(1).max(20),
  /** Read-only probe that settles whether an uncertain mutation was applied; it may capture IDs for cleanup. */
  reconcile: HttpStepSchema.optional(),
  cleanup: z.array(QaStepSchema).max(10).default([])
}).strict();
export type QaCase = z.infer<typeof QaCaseSchema>;

export const QaTestDesignSchema = z.object({
  schemaVersion: z.literal(QA_SCHEMA_VERSION),
  title: Text,
  cases: z.array(QaCaseSchema).min(1).max(100),
  criteriaCoverage: z.array(z.object({ criterionId: Id, caseIds: z.array(Id).min(1) }).strict())
}).strict();
export type QaTestDesign = z.input<typeof QaTestDesignSchema>;
export type QaTestDesignParsed = z.infer<typeof QaTestDesignSchema>;

/** Role outputs are parsed strictly at ingress: any write, patch, command or fix proposal is a permission denial. */
const FORBIDDEN_OUTPUT_KEYS = ["writes", "files", "patch", "productPatch", "fix", "commands", "proposedTasks", "install", "deploy"] as const;
export const QaRoleOutputSchemas = {
  design: z.object({ design: QaTestDesignSchema }).strict(),
  "design-review": z.object({ verdict: z.enum(["approved", "changes_requested"]), designDigest: z.string().regex(/^[a-f0-9]{64}$/),
    findings: z.array(z.object({ id: Id, severity: z.enum(["blocking", "advisory"]), caseIds: z.array(Id), note: Text }).strict()) }).strict(),
  adjudication: z.object({ executionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    verdicts: z.array(z.object({ caseId: Id, classification: QaClassificationSchema, rationale: Text }).strict()) }).strict()
} as const;

export function forbiddenOutputKeys(output: unknown): string[] {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return [];
  return FORBIDDEN_OUTPUT_KEYS.filter(key => Object.hasOwn(output, key));
}

export function qaDigest(value: unknown): string {
  return canonicalPlanDigest(value);
}

export type QaFindingCode =
  | "duplicate_id" | "unknown_criterion" | "criterion_uncovered" | "coverage_mismatch" | "action_not_allowed" | "origin_not_approved"
  | "invalid_url" | "side_effect_undeclared" | "isolated_account_missing" | "account_not_permitted" | "unknown_account" | "fixture_prefix_missing"
  | "cleanup_missing" | "reconcile_not_read_only" | "browser_step_incomplete" | "unknown_variable" | "credential_in_design"
  | "review_not_independent" | "review_stale" | "review_changes_requested"
  | "adjudication_not_independent" | "adjudication_stale" | "verdict_missing" | "verdict_unknown_case" | "classification_override"
  | "execution_integrity" | "product_changed" | "report_integrity";
export interface QaFinding {
  readonly code: QaFindingCode;
  readonly severity: "error" | "warning";
  readonly ids: readonly string[];
  readonly message: string;
}
