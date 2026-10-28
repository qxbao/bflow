import type { AnalysisDocument, AnalysisFinding, AnalysisIntake, AnalysisSection, SurveyObservation } from "./model.js";

export interface AnalysisVerificationContext {
  readonly intake: AnalysisIntake;
  readonly outputSections: readonly AnalysisSection[];
  readonly observations: readonly SurveyObservation[];
  /** User decisions answered so far (intake carry-over plus elicitation approval). */
  readonly answeredDecisions: Readonly<Record<string, unknown>>;
  /** Elicitation questions that were confirmed with the user. */
  readonly elicitedQuestions: readonly { id: string; question: string; blocking: boolean }[];
}

export interface AnalysisVerification {
  readonly status: "passed" | "failed" | "blocked";
  readonly findings: readonly AnalysisFinding[];
  readonly checks: readonly { readonly check: string; readonly evaluated: number; readonly failed: number }[];
  /** Non-blocking decisions/questions that remain open and must be listed in the handoff. */
  readonly unresolved: readonly { readonly id: string; readonly question: string; readonly blocking: boolean }[];
}

/** Wording that cannot be tested without a number, an oracle or a decision. */
const VAGUE = /\b(fast|quick(ly)?|user[- ]friendly|easy|easily|intuitive|appropriate(ly)?|efficient(ly)?|robust|scalable|seamless(ly)?|as needed|etc\.?|tbd|todo|nhanh|dễ dùng|thân thiện|phù hợp|hợp lý|tối ưu)\b/i;
const HAS_NUMBER = /\d/;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.;:!]+$/, "").trim();
}

/**
 * Independent, deterministic analysis checks. A present file or a non-empty document is never enough: every
 * deliverable, reference, provenance and decision is checked against the intake and Runtime-recorded observations.
 */
export function verifyAnalysisDocument(document: AnalysisDocument, context: AnalysisVerificationContext): AnalysisVerification {
  const findings: AnalysisFinding[] = [];
  const checks = new Map<string, { evaluated: number; failed: number }>();
  const check = (name: string, ok: boolean, finding?: () => AnalysisFinding) => {
    const entry = checks.get(name) ?? { evaluated: 0, failed: 0 };
    entry.evaluated++;
    if (!ok) { entry.failed++; if (finding) findings.push(finding()); }
    checks.set(name, entry);
  };
  const { intake } = context;
  const statements = [
    ...document.scope.inScope, ...document.scope.outOfScope, ...document.functionalRequirements, ...document.acceptanceCriteria,
    ...document.nfrs, ...document.businessFlows, ...document.glossary, ...document.notes
  ];
  const ids = new Map<string, number>();
  for (const item of [...statements, ...document.openQuestions]) ids.set(item.id, (ids.get(item.id) ?? 0) + 1);
  for (const [id, count] of ids) check("consistency.unique_ids", count === 1,
    () => ({ code: "duplicate_id", severity: "error", ids: [id], message: `Identifier ${id} is used ${count} times` }));
  const requirementIds = new Set(document.functionalRequirements.map(item => item.id));
  const statementIds = new Set(statements.map(item => item.id));

  // Output policy and intake deliverables: each requested section must exist with content; unrequested notes are refused.
  const sectionItems: Record<AnalysisSection, number> = {
    scope: document.scope.inScope.length, functional_requirements: document.functionalRequirements.length,
    acceptance_criteria: document.acceptanceCriteria.length, nfr: document.nfrs.length, business_flows: document.businessFlows.length,
    glossary: document.glossary.length, context_notes: document.notes.filter(item => item.kind === "context").length,
    data_notes: document.notes.filter(item => item.kind === "data").length, api_notes: document.notes.filter(item => item.kind === "api").length
  };
  for (const section of intake.deliverables) {
    check("traceability.deliverables", context.outputSections.includes(section),
      () => ({ code: "deliverable_missing", severity: "error", ids: [section], message: `Deliverable ${section} is outside the pinned output policy` }));
    check("traceability.deliverables", sectionItems[section] > 0,
      () => ({ code: "empty_section", severity: "error", ids: [section], message: `Requested deliverable ${section} is empty` }));
  }
  for (const kind of ["context", "data", "api"] as const)
    check("consistency.requested_notes_only", sectionItems[`${kind}_notes`] === 0 || intake.deliverables.includes(`${kind}_notes`),
      () => ({ code: "deliverable_missing", severity: "error", ids: [`${kind}_notes`], message: `${kind} notes were not requested; include only notes the request needs` }));

  // Provenance: every statement distinguishes user, source observation, inference and open decision.
  const userRefs = new Set([...intake.userStatements.map(item => `intake:${item.id}`),
    ...Object.keys(context.answeredDecisions).map(id => `decision:${id}`)]);
  const sourceRefs = new Set(context.observations.map(item => `source:${item.path}#${item.sha256}`));
  const decisionIds = new Set([...intake.requiredDecisions.map(item => item.id), ...context.elicitedQuestions.map(item => item.id),
    ...document.openQuestions.map(item => item.id)]);
  for (const item of statements) {
    const { kind, refs } = item.provenance;
    const valid = kind === "user" ? refs.every(ref => userRefs.has(ref))
      : kind === "source" ? refs.every(ref => sourceRefs.has(ref))
      : kind === "inference" ? refs.every(ref => statementIds.has(ref) && ref !== item.id)
      : refs.every(ref => ref.startsWith("decision:") && decisionIds.has(ref.slice(9)) && !Object.hasOwn(context.answeredDecisions, ref.slice(9)));
    check(`provenance.${kind}`, valid, () => ({ code: "provenance_invalid", severity: "error", ids: [item.id],
      message: kind === "source" ? `${item.id} cites a source that Runtime did not observe at that digest`
        : kind === "user" ? `${item.id} cites no user statement or answered decision`
        : kind === "inference" ? `${item.id} must name the statements it is inferred from`
        : `${item.id} must reference an unanswered decision` }));
  }

  // Traceability FR <-> AC <-> flows, and analysis acceptance criteria coverage.
  for (const requirement of document.functionalRequirements)
    check("traceability.fr_to_ac", document.acceptanceCriteria.some(item => item.requirementIds.includes(requirement.id)),
      () => ({ code: "fr_without_ac", severity: "error", ids: [requirement.id], message: `${requirement.id} has no acceptance criterion` }));
  for (const criterion of document.acceptanceCriteria) {
    check("traceability.ac_to_fr", criterion.requirementIds.length > 0 && criterion.requirementIds.every(id => requirementIds.has(id)),
      () => ({ code: criterion.requirementIds.length ? "dangling_reference" : "ac_without_fr", severity: "error", ids: [criterion.id],
        message: `${criterion.id} must trace to existing functional requirements` }));
    check("testability.acceptance_criteria", [criterion.given, criterion.when, criterion.then, criterion.oracle].every(text => text.trim().length >= 3),
      () => ({ code: "ac_incomplete", severity: "error", ids: [criterion.id], message: `${criterion.id} needs given/when/then and an observable oracle` }));
  }
  for (const flow of document.businessFlows)
    check("traceability.flows", flow.requirementIds.every(id => requirementIds.has(id)),
      () => ({ code: "dangling_reference", severity: "error", ids: [flow.id], message: `${flow.id} references unknown requirements` }));
  for (const criterion of intake.acceptanceCriteria.filter(item => item.required)) {
    const coverage = document.criteriaCoverage.find(item => item.criterionId === criterion.id);
    check("traceability.analysis_criteria", coverage !== undefined && coverage.statementIds.every(id => statementIds.has(id)),
      () => ({ code: "analysis_criterion_uncovered", severity: "error", ids: [criterion.id], message: `Analysis criterion ${criterion.id} is not covered by existing statements` }));
  }

  // Testability: vague wording in requirements/criteria needs a number or an explicit decision.
  for (const item of [...document.functionalRequirements, ...document.acceptanceCriteria]) {
    const text = "oracle" in item && "then" in item ? `${item.text} ${String(item.then)} ${String(item.oracle)}` : item.text;
    const match = VAGUE.exec(text);
    check("testability.wording", !match || HAS_NUMBER.test(text) || item.provenance.kind === "open_decision",
      () => ({ code: "untestable_wording", severity: "error", ids: [item.id], message: `${item.id} uses untestable wording '${match![0]}' without a measurable threshold` }));
  }

  // NFR: accepted ones need metric/oracle/workload/threshold; otherwise they are explicitly undecided with a decision.
  for (const nfr of document.nfrs) {
    const accepted = nfr.status === "accepted" && [nfr.metric, nfr.oracle, nfr.workload, nfr.threshold].every(value => value !== undefined);
    const undecided = nfr.status === "undecided" && nfr.decisionId !== undefined && decisionIds.has(nfr.decisionId) &&
      !Object.hasOwn(context.answeredDecisions, nfr.decisionId);
    check("testability.nfr", accepted || undecided, () => ({ code: "nfr_incomplete", severity: "error", ids: [nfr.id],
      message: nfr.status === "accepted" ? `${nfr.id} needs metric, oracle, workload and threshold` : `${nfr.id} must reference an open decision` }));
  }

  // Consistency: scope contradictions and glossary conflicts.
  const outScope = new Set(document.scope.outOfScope.map(item => normalize(item.text)));
  for (const item of document.scope.inScope)
    check("consistency.scope", !outScope.has(normalize(item.text)),
      () => ({ code: "scope_conflict", severity: "error", ids: [item.id], message: `${item.id} is both in and out of scope` }));
  const terms = new Map<string, string>();
  for (const entry of document.glossary) {
    const key = normalize(entry.term), existing = terms.get(key);
    check("consistency.glossary", existing === undefined || existing === normalize(entry.text),
      () => ({ code: "glossary_conflict", severity: "error", ids: [entry.id], message: `Term '${entry.term}' has conflicting definitions` }));
    terms.set(key, normalize(entry.text));
  }

  // Unresolved questions: a blocking one stops the workflow until the user decides; others are carried into the handoff.
  const questions = [...intake.requiredDecisions, ...context.elicitedQuestions, ...document.openQuestions]
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index);
  const unresolved = questions.filter(item => !Object.hasOwn(context.answeredDecisions, item.id));
  for (const question of unresolved)
    check("decisions.unresolved", !question.blocking, () => ({ code: "blocking_decision_unresolved", severity: "blocking", ids: [question.id],
      message: `Business decision ${question.id} must be made by the user: ${question.question}` }));
  for (const question of unresolved.filter(item => !item.blocking))
    findings.push({ code: "unresolved_question", severity: "warning", ids: [question.id], message: `Open question carried into the handoff: ${question.question}` });

  const status = findings.some(item => item.severity === "blocking") ? "blocked"
    : findings.some(item => item.severity === "error") ? "failed" : "passed";
  return { status, findings, unresolved: unresolved.map(item => ({ id: item.id, question: item.question, blocking: item.blocking })),
    checks: [...checks].map(([name, value]) => ({ check: name, ...value })).sort((a, b) => a.check.localeCompare(b.check)) };
}
