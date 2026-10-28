import { z } from "zod";
import { canonicalPlanDigest } from "../planning/index.js";

/**
 * Runtime-private models of the analysis-only (BA) workflow extension. They never cross a package boundary as
 * public wire shapes: Core/RunStore/ArtifactStore/approval data still use the exported `@bflow/contracts` schemas.
 */
export const ANALYSIS_SCHEMA_VERSION = 1 as const;
const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/);
const Text = z.string().trim().min(1).max(4000);

export const ANALYSIS_SECTIONS = [
  "scope", "functional_requirements", "acceptance_criteria", "nfr", "business_flows", "glossary",
  "context_notes", "data_notes", "api_notes"
] as const;
export const AnalysisSectionSchema = z.enum(ANALYSIS_SECTIONS);
export type AnalysisSection = z.infer<typeof AnalysisSectionSchema>;

/** Sections every BA handoff needs; context/data/API notes are produced only when the intake asks for them. */
export const CORE_ANALYSIS_SECTIONS: readonly AnalysisSection[] = [
  "scope", "functional_requirements", "acceptance_criteria", "nfr", "business_flows", "glossary"
];

export const AnalysisTaskKindSchema = z.enum(["survey", "elicitation", "specification", "review", "publication"]);
export type AnalysisTaskKind = z.infer<typeof AnalysisTaskKindSchema>;

/** Intake of an analysis request: what must be delivered and how the analysis work itself is accepted. */
export const AnalysisIntakeSchema = z.object({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  requestId: Id,
  sessionId: Id,
  title: Text,
  /** Verbatim user statements; the only `user` provenance source besides answered decisions. */
  userStatements: z.array(z.object({ id: Id, text: Text }).strict()).min(1),
  deliverables: z.array(AnalysisSectionSchema).min(1),
  /** Acceptance criteria of the analysis work (not of the future product). */
  acceptanceCriteria: z.array(z.object({ id: Id, description: Text, required: z.boolean().default(true) }).strict()).min(1),
  /** Business decisions the user must make; blocking ones stop specification until answered. */
  requiredDecisions: z.array(z.object({ id: Id, question: Text, blocking: z.boolean().default(true) }).strict()).default([]),
  /** Repository-relative read-only survey roots; empty means no source survey is permitted. */
  surveyPaths: z.array(z.string().min(1).max(256)).default([]),
  /** Repository-relative directory that receives the published handoff documents. */
  documentRoot: z.string().min(1).max(256).default("docs/analysis"),
  revision: z.number().int().positive().default(1),
  /** Prior run superseded by this revision. */
  supersedes: Id.optional(),
  /** Decisions answered on an earlier revision; they stay user-sourced. */
  answeredDecisions: z.record(Id, z.object({ answer: Text, decidedBy: Text, decidedAt: z.string().datetime({ offset: true }) }).strict()).default({}),
  revisionReason: Text.optional()
}).strict().superRefine((intake, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  if (!intake.deliverables.some(section => section === "acceptance_criteria") || !intake.deliverables.includes("functional_requirements"))
    issue("Analysis deliverables must include functional_requirements and acceptance_criteria");
  for (const list of [intake.userStatements.map(item => item.id), intake.acceptanceCriteria.map(item => item.id), intake.requiredDecisions.map(item => item.id)])
    if (new Set(list).size !== list.length) issue("Duplicate intake identifier");
  if (!intake.acceptanceCriteria.some(item => item.required)) issue("At least one analysis acceptance criterion must be required");
  if (intake.revision > 1 && (!intake.supersedes || !intake.revisionReason)) issue("A revision must name the superseded run and a reason");
});
export type AnalysisIntake = z.infer<typeof AnalysisIntakeSchema>;
export type AnalysisIntakeInput = z.input<typeof AnalysisIntakeSchema>;

export const ProvenanceKindSchema = z.enum(["user", "source", "inference", "open_decision"]);
/**
 * Every statement says where it comes from: `user` refs `intake:<id>` or `decision:<id>` (answered),
 * `source` refs `source:<path>#<sha256>` of a Runtime-recorded observation, `inference` refs the statement IDs it is
 * derived from, `open_decision` refs the unanswered `decision:<id>` it waits on.
 */
export const ProvenanceSchema = z.object({ kind: ProvenanceKindSchema, refs: z.array(z.string().min(1).max(512)).min(1) }).strict();
const Statement = { id: Id, text: Text, provenance: ProvenanceSchema };

export const AnalysisDocumentSchema = z.object({
  schemaVersion: z.literal(ANALYSIS_SCHEMA_VERSION),
  title: Text,
  scope: z.object({ inScope: z.array(z.object(Statement).strict()), outOfScope: z.array(z.object(Statement).strict()) }).strict(),
  functionalRequirements: z.array(z.object(Statement).strict()),
  acceptanceCriteria: z.array(z.object({ ...Statement, requirementIds: z.array(Id),
    given: Text, when: Text, then: Text, oracle: Text }).strict()),
  nfrs: z.array(z.object({ ...Statement, category: Text, status: z.enum(["accepted", "undecided"]),
    metric: Text.optional(), oracle: Text.optional(), workload: Text.optional(), threshold: Text.optional(),
    decisionId: Id.optional() }).strict()),
  businessFlows: z.array(z.object({ ...Statement, requirementIds: z.array(Id),
    steps: z.array(z.object({ actor: Text, action: Text }).strict()).min(1) }).strict()),
  glossary: z.array(z.object({ ...Statement, term: Text }).strict()),
  notes: z.array(z.object({ ...Statement, kind: z.enum(["context", "data", "api"]) }).strict()),
  /** Questions found during analysis, besides the intake's required decisions. */
  openQuestions: z.array(z.object({ id: Id, question: Text, blocking: z.boolean() }).strict()),
  /** Which statements satisfy each analysis acceptance criterion of the intake. */
  criteriaCoverage: z.array(z.object({ criterionId: Id, statementIds: z.array(Id).min(1) }).strict())
}).strict();
export type AnalysisDocument = z.infer<typeof AnalysisDocumentSchema>;

export const SurveyObservationSchema = z.object({ path: z.string().min(1).max(256), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(), note: Text }).strict();
export type SurveyObservation = z.infer<typeof SurveyObservationSchema>;

/** Role outputs are parsed strictly at ingress: any write, command or task proposal is a permission denial. */
const FORBIDDEN_OUTPUT_KEYS = ["writes", "files", "patch", "commands", "proposedTasks", "install", "deploy"] as const;
export const RoleOutputSchemas = {
  survey: z.object({ observations: z.array(z.object({ path: z.string().min(1).max(256), note: Text }).strict()).min(1) }).strict(),
  elicitation: z.object({ questions: z.array(z.object({ id: Id, question: Text, blocking: z.boolean() }).strict()) }).strict(),
  specification: z.object({ document: AnalysisDocumentSchema }).strict(),
  review: z.object({ verdict: z.enum(["approved", "changes_requested"]), documentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    findings: z.array(z.object({ id: Id, severity: z.enum(["blocking", "advisory"]), statementIds: z.array(Id), note: Text }).strict()) }).strict()
} as const;
export type RoleOutput<K extends Exclude<AnalysisTaskKind, "publication">> = z.infer<(typeof RoleOutputSchemas)[K]>;

export function forbiddenOutputKeys(output: unknown): string[] {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return [];
  return FORBIDDEN_OUTPUT_KEYS.filter(key => Object.hasOwn(output, key));
}

export function analysisDigest(value: unknown): string {
  return canonicalPlanDigest(value);
}

export type AnalysisFindingCode =
  | "empty_section" | "deliverable_missing" | "duplicate_id" | "dangling_reference" | "provenance_invalid"
  | "fr_without_ac" | "ac_without_fr" | "analysis_criterion_uncovered" | "untestable_wording" | "ac_incomplete"
  | "nfr_incomplete" | "scope_conflict" | "glossary_conflict" | "blocking_decision_unresolved" | "unresolved_question"
  | "review_not_independent" | "review_stale" | "review_changes_requested";
export interface AnalysisFinding {
  readonly code: AnalysisFindingCode;
  readonly severity: "blocking" | "error" | "warning";
  readonly ids: readonly string[];
  readonly message: string;
}
