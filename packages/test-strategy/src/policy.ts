import type { AcceptanceCriterion, ChangeClassification, RiskLevel, TddMode } from "@bflow/contracts";
import type { Assessment, TestLevel, VerificationMethod } from "./schema.js";

export const behavioralMethods: readonly VerificationMethod[] = ["unit_test", "integration_test", "e2e_test"];
const riskOrder: RiskLevel[] = ["low", "medium", "high", "critical"];
const levelFor: Partial<Record<VerificationMethod, TestLevel>> = {
  unit_test: "unit", integration_test: "integration", e2e_test: "e2e"
};
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const testFilePattern = /(^|\/)(__tests__|__fixtures__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;

export function evaluatePolicy(a: Assessment, criteria: AcceptanceCriterion[], paths: string[], specRisk: RiskLevel = "low") {
  const surfaces = new Set([...a.changeImpact.surfaces, a.taskType]);
  const has = (...names: Assessment["taskType"][]) => names.some(name => surfaces.has(name));
  const regression = has("bugfix") || criteria.some(c => c.category === "regression");
  const logic = has("domain_logic", "validation", "transformation", "state_machine");
  const api = has("api_contract");
  const requiredCriteria = criteria.filter(c => c.required);
  if (!requiredCriteria.length) throw new Error("Policy requires at least one required acceptance criterion");
  const executableCriterion = requiredCriteria.some(c => behavioralMethods.includes(c.verificationMethod));
  // Existing tests may verify an unchanged invariant (for example formatting).
  // Their presence alone does not create missing behavior for a meaningful Red.
  const executableTarget = executableCriterion && (a.changeImpact.behaviorChanged ||
    a.changeImpact.deterministic || a.changeImpact.regressionReproducible);
  const mislabeledDocs = a.taskType === "documentation" && paths.some(path => !/\.(md|mdx|txt|rst|adoc)$/i.test(path));
  const behavior = a.changeImpact.behaviorChanged || logic || api || executableTarget || mislabeledDocs;
  const elevated = a.changeImpact.securitySensitive || a.changeImpact.dataMigration || criteria.some(c => c.category === "security");
  const risk = riskOrder[Math.max(riskOrder.indexOf(specRisk), riskOrder.indexOf(a.riskClassification), elevated ? 2 : 0)]!;
  const highRisk = risk === "high" || risk === "critical";
  const methods: VerificationMethod[] = requiredCriteria.map(c => c.verificationMethod);
  methods.push(...a.conventions.requiredMethods);
  if (behavior && (logic || regression || api) && !methods.some(method => behavioralMethods.includes(method))) {
    methods.push(api ? "integration_test" : "unit_test");
  }
  if (has("configuration")) methods.push("typecheck", "static_analysis");
  if (has("infrastructure")) methods.push("integration_test", "static_analysis");
  if (has("ui_layout")) methods.push("manual_review");
  if (has("formatting")) methods.push("lint");
  if (behavior && (has("integration") || a.changeImpact.scope !== "local")) methods.push("integration_test");
  if (a.changeImpact.dataMigration) methods.push("typecheck", "static_analysis", "integration_test");
  if (highRisk) {
    methods.push("static_analysis", "manual_review");
    if (behavior) methods.push("integration_test");
  }
  const behavioralChecks = methods.filter(method => behavioralMethods.includes(method));
  const hasRunnableTest = behavioralChecks.length > 0 && behavioralChecks.every(method =>
    a.infrastructure.commands.some(c => c.method === method));
  const feasible = a.testability.level === "automated" && a.infrastructure.readiness === "ready" && hasRunnableTest;
  const suitable = behavior && ((logic && a.changeImpact.deterministic) ||
    (regression && a.changeImpact.regressionReproducible) || api ||
    (executableCriterion && !has("integration", "refactoring", "exploratory_spike")) ||
    (a.changeImpact.deterministic && !has("integration", "refactoring", "exploratory_spike")));
  const wantsRequired = suitable || (behavior && highRisk) || (behavior && a.conventions.tdd === "required");
  // Characterization: only test files change, so the current production code is the target and tests must already pass.
  // Bug/regression reproductions still need a failing Red, and domain_logic/bugfix may not be not_applicable (contract rule).
  const characterization = paths.length > 0 && paths.every(path => testFilePattern.test(path)) && !regression && !logic;
  let mode: TddMode;
  let reason: string;
  if (characterization) {
    mode = "not_applicable";
    reason = "The change touches only test files (characterization); the current production code is the target, so a meaningful Red phase does not exist.";
  } else if (feasible && wantsRequired) {
    mode = "required";
    reason = "A repeatable behavioral check is feasible and spec behavior, regression risk, or project convention requires test-first evidence.";
  } else if (behavior || logic || regression || has("integration", "refactoring", "exploratory_spike")) {
    mode = "recommended";
    reason = !feasible
      ? "Testability or test infrastructure is incomplete; establish an executable seam and retain all alternative verification obligations."
      : "Integration, refactoring, or exploratory work benefits from tests; a mandatory failing-test-first sequence is not justified by the current impact.";
  } else {
    mode = "not_applicable";
    reason = "The assessed change has no executable behavioral target for a meaningful Red phase; objective alternative verification remains mandatory.";
  }
  const classification: ChangeClassification = regression ? "bugfix" : logic ? "domain_logic" : api ? "api_contract" :
    has("refactoring", "integration", "infrastructure") ? "refactoring" : has("ui_layout") ? "ui_layout" :
    has("configuration") ? "configuration" : has("documentation", "formatting") ? "documentation" : "exploratory_spike";
  const requiredMethods = unique<VerificationMethod>(methods.length ? methods : ["manual_review"]);
  const levels = unique(requiredMethods.flatMap(method => levelFor[method] ? [levelFor[method]!] : []));
  const suggestedLevels = unique([
    ...levels,
    ...a.conventions.suggestedLevels,
    ...(regression && behavior ? ["regression" as const] : [])
  ]);
  const commands = unique(a.infrastructure.commands.filter(c => requiredMethods.includes(c.method)).map(c => c.command));
  const missing = requiredMethods.filter(method => method !== "manual_review" &&
    !a.infrastructure.commands.some(c => c.method === method));
  const conditions = [
    ...requiredCriteria.map(c => `${c.id}: ${c.description}; verify using ${c.verificationMethod}.`),
    ...missing.map(method => `Provision a runnable ${method} command before verification can complete.`)
  ];
  const evidence = mode === "required" ? [
    "Red: spec-derived tests fail with a nonzero exit code because target behavior is absent; retain trusted logs and the unchanged test revision.",
    "Green: implement minimally, then run the same tests successfully on the implementation revision; retain trusted logs.",
    "Refactor: review/refactor the implementation and rerun the same tests successfully; retain trusted logs even when no cleanup is needed."
  ] : characterization ? ["Characterization: record a successful run of the same tests on the current, unchanged production code (tests pass on current code) with trusted logs and criterion mappings; not_applicable does not waive verification."] : ["Record successful alternative verification with criterion mappings, method observations and trusted artifacts; not_applicable does not waive verification."];
  evidence.push("Cover every required method and acceptance criterion; independent VerificationResult evidence is mandatory.");
  return { mode, reason, classification, risk, methods: requiredMethods, levels, suggestedLevels, commands, conditions, evidence };
}
