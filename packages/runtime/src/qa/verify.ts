import { MUTATING_ACTIONS, QaTestDesignSchema, type QaFinding, type QaIntake, type QaStep, type QaTestDesign } from "./model.js";
import { actionOf, checkDesignUrl, placeholders } from "./scope.js";

export interface QaDesignVerification {
  readonly status: "passed" | "failed";
  readonly findings: readonly QaFinding[];
  readonly checks: readonly { check: string; passed: boolean }[];
}

const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "x-auth-token"]);

/** Variables every case may use besides the ones it captures itself. */
export const BUILTIN_VARIABLES = ["fixturePrefix"] as const;

/**
 * Deterministic test-design checks (gate `qa-design-verification`): criteria coverage, action allow-list, approved
 * origins, side-effect declaration, isolated accounts, fixture data prefix, cleanup and read-only reconciliation.
 * A file or a review verdict is never enough on its own; failing designs return to the designer with these findings.
 */
export function verifyQaDesign(input: QaTestDesign, intake: QaIntake): QaDesignVerification {
  const design = QaTestDesignSchema.parse(input);
  const findings: QaFinding[] = [];
  const add = (code: QaFinding["code"], ids: string[], message: string, severity: QaFinding["severity"] = "error") =>
    findings.push({ code, severity, ids, message });
  const criteria = new Map(intake.criteria.map(item => [item.id, item]));
  const accounts = new Map(intake.accountPolicy.accounts.map(item => [item.id, item]));

  const caseIds = design.cases.map(item => item.id);
  for (const id of new Set(caseIds.filter((item, index) => caseIds.indexOf(item) !== index))) add("duplicate_id", [id], `Duplicate test case ${id}`);

  for (const testCase of design.cases) {
    for (const criterionId of testCase.criterionIds)
      if (!criteria.has(criterionId)) add("unknown_criterion", [testCase.id, criterionId], `${testCase.id} references unknown criterion ${criterionId}`);
    const all: { phase: string; step: QaStep }[] = [...testCase.steps.map(step => ({ phase: "step", step })),
      ...testCase.cleanup.map(step => ({ phase: "cleanup", step })), ...(testCase.reconcile ? [{ phase: "reconcile", step: testCase.reconcile as QaStep }] : [])];
    const reported = new Set<string>();
    const once = (code: QaFinding["code"], message: string) => {
      if (reported.has(code)) return;
      reported.add(code);
      add(code, [testCase.id], message);
    };
    for (const { phase, step } of all) {
      const action = actionOf(step);
      if (!intake.allowedActions.includes(action)) once("action_not_allowed", `${testCase.id} ${phase} uses ${action}, which the intake does not allow`);
      const url = step.url;
      if (url !== undefined) {
        const checked = checkDesignUrl(url, intake);
        if (!checked.ok) once(checked.code, `${testCase.id} ${phase}: ${checked.message}`);
      }
      // Credentials come only from the account port at execution time; test assets are written to the repository.
      if (step.kind === "http" && Object.keys(step.headers ?? {}).some(name => CREDENTIAL_HEADERS.has(name.toLowerCase())))
        once("credential_in_design", `${testCase.id} ${phase} embeds a credential header; use an intake account instead`);
      if (step.kind === "browser" && (step.op === "navigate" ? !step.url : !step.selector || step.op === "fill" && step.value === undefined))
        once("browser_step_incomplete", `${testCase.id} browser ${step.op} step is incomplete`);
    }
    const mutating = [...testCase.steps, ...testCase.cleanup].some(step => MUTATING_ACTIONS.includes(actionOf(step)));
    if (testCase.steps.some(step => MUTATING_ACTIONS.includes(actionOf(step))) && testCase.sideEffect !== "mutating")
      once("side_effect_undeclared", `${testCase.id} mutates the target but declares no side effect`);
    if (testCase.account !== undefined) {
      const account = accounts.get(testCase.account);
      if (!account) once("unknown_account", `${testCase.id} uses an account that the intake does not declare`);
      else if (mutating && account.kind !== "isolated_fixture") once("account_not_permitted", `${testCase.id} mutates with the shared read-only account ${account.id}`);
    }
    if (testCase.sideEffect === "mutating") {
      const isolated = testCase.account !== undefined && accounts.get(testCase.account)?.kind === "isolated_fixture";
      if (!isolated && intake.target.kind !== "fixture") once("isolated_account_missing", `${testCase.id} has side effects but no isolated fixture account`);
      for (const step of testCase.steps)
        if (step.kind === "http" && ["POST", "PUT", "PATCH"].includes(step.method) && step.body !== undefined && !placeholders(step.body).includes("fixturePrefix"))
          once("fixture_prefix_missing", `${testCase.id} creates data without the \${fixturePrefix} marker`);
      if (intake.cleanup.required && testCase.cleanup.length === 0) once("cleanup_missing", `${testCase.id} has side effects but no cleanup`);
    }
    if (testCase.reconcile && !["GET", "HEAD"].includes(testCase.reconcile.method))
      once("reconcile_not_read_only", `${testCase.id} reconciliation probe must be read-only`);
    // Variables: steps see builtins and earlier captures; reconcile/cleanup also see every capture of the case.
    const known = new Set<string>(BUILTIN_VARIABLES);
    for (const step of testCase.steps) {
      for (const name of placeholders(step)) if (!known.has(name)) once("unknown_variable", `${testCase.id} uses \${${name}} before it is captured`);
      if (step.kind === "http") for (const name of Object.keys(step.capture ?? {})) known.add(name);
    }
    for (const name of Object.keys(testCase.reconcile?.capture ?? {})) known.add(name);
    for (const step of [...testCase.cleanup, ...(testCase.reconcile ? [testCase.reconcile] : [])])
      for (const name of placeholders(step)) if (!known.has(name)) once("unknown_variable", `${testCase.id} cleanup uses \${${name}}, which is never captured`);
  }

  const derived = new Map<string, Set<string>>();
  for (const testCase of design.cases) for (const id of testCase.criterionIds) derived.set(id, new Set([...derived.get(id) ?? [], testCase.id]));
  for (const criterion of intake.criteria)
    if (criterion.required && !derived.has(criterion.id)) add("criterion_uncovered", [criterion.id], `Required criterion ${criterion.id} has no test case`);
  for (const entry of design.criteriaCoverage) {
    const expected = derived.get(entry.criterionId) ?? new Set<string>();
    if (entry.caseIds.length !== expected.size || entry.caseIds.some(id => !expected.has(id)))
      add("coverage_mismatch", [entry.criterionId], `Coverage of ${entry.criterionId} does not match the cases that reference it`);
  }
  for (const id of derived.keys())
    if (!design.criteriaCoverage.some(entry => entry.criterionId === id)) add("coverage_mismatch", [id], `Coverage table omits ${id}`);

  const failed = (codes: QaFinding["code"][]) => findings.some(item => codes.includes(item.code));
  const checks = [
    { check: "criteria_coverage", passed: !failed(["unknown_criterion", "criterion_uncovered", "coverage_mismatch"]) },
    { check: "scope", passed: !failed(["action_not_allowed", "origin_not_approved", "invalid_url"]) },
    { check: "side_effects", passed: !failed(["side_effect_undeclared", "isolated_account_missing", "account_not_permitted", "unknown_account", "fixture_prefix_missing"]) },
    { check: "cleanup_and_recovery", passed: !failed(["cleanup_missing", "reconcile_not_read_only", "unknown_variable"]) },
    { check: "well_formed", passed: !failed(["duplicate_id", "browser_step_incomplete"]) },
    { check: "no_embedded_credentials", passed: !failed(["credential_in_design"]) }
  ];
  return { status: findings.some(item => item.severity === "error") ? "failed" : "passed", findings, checks };
}
