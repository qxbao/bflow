import type { Specification, TestStrategy, WorkflowDefinition } from "@bflow/contracts";
import type { AgenticRuntimePorts } from "./ports.js";

export const FAST_PATH_MAX_PATHS = 5;

export const FAST_PATH_BLOCKERS = [
  "disabled",
  "not_trivial",
  "unresolved_questions",
  "full_sdd",
  "multi_task",
  "task_approval",
  "too_many_paths",
  "glob_paths",
  "tdd_required",
  "specialist_used"
] as const;

export type FastPathBlocker = (typeof FAST_PATH_BLOCKERS)[number];

export type FastPathMode = "auto" | "off";

export type FastPathClassification = ReturnType<AgenticRuntimePorts["policies"]["classifyChange"]>;

export interface FastPathDecision {
  eligible: boolean;
  blockers: FastPathBlocker[];
  reasons: string[];
}

export interface EvaluateFastPathInput {
  mode?: FastPathMode | undefined;
  classification: FastPathClassification;
  assessment?: unknown;
  delegationSddLevel?: Specification["level"] | undefined;
  draft: Pick<Specification, "level" | "affectedPaths"> & {
    metadata?: Specification["metadata"];
  };
  definition?: Pick<WorkflowDefinition, "tasks" | "dependencies"> | undefined;
  strategies?: readonly TestStrategy[] | undefined;
  specialistRequested?: boolean | undefined;
  followUpOrRevision?: boolean | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractUnresolvedQuestions(assessment: unknown): unknown[] | undefined {
  if (!isRecord(assessment)) return undefined;
  return Array.isArray(assessment.unresolvedQuestions) ? assessment.unresolvedQuestions : undefined;
}

function hasUnresolvedQuestions(input: EvaluateFastPathInput): boolean {
  const direct = extractUnresolvedQuestions(input.assessment);
  if (direct !== undefined && direct.length > 0) return true;
  const sdd = isRecord(input.draft.metadata) && isRecord(input.draft.metadata.sdd) ? input.draft.metadata.sdd : undefined;
  const fromDraft = sdd ? extractUnresolvedQuestions(sdd.assessment) : undefined;
  return fromDraft !== undefined && fromDraft.length > 0;
}

export function evaluateFastPath(input: EvaluateFastPathInput): FastPathDecision {
  const blockers: FastPathBlocker[] = [];
  const reasons: string[] = [];

  if (input.mode !== "auto") {
    blockers.push("disabled");
    reasons.push("fast-path mode is disabled");
  }

  if (input.classification.complexity !== "trivial") {
    blockers.push("not_trivial");
    reasons.push(`change complexity is ${input.classification.complexity}, not trivial`);
  }

  if (hasUnresolvedQuestions(input)) {
    blockers.push("unresolved_questions");
    reasons.push("assessment contains unresolved questions requiring clarification");
  }

  if (
    (input.delegationSddLevel !== undefined && input.delegationSddLevel !== "lightweight") ||
    input.draft.level !== "lightweight"
  ) {
    blockers.push("full_sdd");
    reasons.push("full SDD policy level is required");
  }

  if (input.definition !== undefined) {
    if (input.definition.tasks.length !== 1 || input.definition.dependencies.length !== 0) {
      blockers.push("multi_task");
      reasons.push("workflow definition must contain a single independent task without dependencies");
    }

    if (input.definition.tasks.some(task => task.requiresApproval === true)) {
      blockers.push("task_approval");
      reasons.push("workflow task requires human approval");
    }
  }

  if (input.draft.affectedPaths.length > FAST_PATH_MAX_PATHS) {
    blockers.push("too_many_paths");
    reasons.push(`affectedPaths count (${input.draft.affectedPaths.length}) exceeds maximum of ${FAST_PATH_MAX_PATHS}`);
  }

  if (input.draft.affectedPaths.some(path => /[*?]/.test(path))) {
    blockers.push("glob_paths");
    reasons.push("affectedPaths contains glob wildcard characters");
  }

  if (input.strategies !== undefined && input.strategies.some(strategy => strategy.tddDecision.mode === "required")) {
    blockers.push("tdd_required");
    reasons.push("TDD mode is required by test strategy");
  }

  if (input.specialistRequested === true) {
    blockers.push("specialist_used");
    reasons.push("specialist role was already requested");
  }

  if (input.followUpOrRevision === true) {
    reasons.push("recomputed for follow-up or requirement revision");
  }

  return {
    eligible: blockers.length === 0,
    blockers,
    reasons
  };
}
