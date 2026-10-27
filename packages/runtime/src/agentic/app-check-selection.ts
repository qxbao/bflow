import type { Specification, TestStrategy } from "@bflow/contracts";
import { parseAppCheckIdentity, type AppCheckSuite } from "./app-check-config.js";
import { WorkflowProposalRejected, type WorkflowRejectionCode } from "./workflow-rejection.js";

/**
 * Splits real-app criteria out of a task or workflow proposal. An app-bound criterion is an active `e2e_test` criterion whose
 * mapped test names are real-app identities (`app:<suite>:<check>`). Those criteria are verified by the app gate, never by a
 * test runner, so the remaining (`rest`) specification and strategy are what the runner-based ingress rules see.
 */
type Criterion = Specification["acceptanceCriteria"][number];

export interface AppCriterionBinding {
  readonly criterion: Criterion;
  readonly suiteId: string;
  readonly checkIds: readonly string[];
  readonly identities: readonly string[];
}

export interface AppCriteriaSplit {
  readonly app: readonly AppCriterionBinding[];
  readonly rest: { readonly specification: Specification; readonly strategy: TestStrategy };
}

function reject(code: WorkflowRejectionCode, reason: string): never {
  throw new WorkflowProposalRejected({ code, reason, options: [] });
}

export function splitAppCriteria(specification: Specification, strategy: TestStrategy, suites: readonly AppCheckSuite[]): AppCriteriaSplit {
  const configured = new Map(suites.map(suite => [suite.id, new Set(suite.checks.map(check => check.id))]));
  const configuredList = suites.map(suite => `${suite.id}: ${suite.checks.map(check => check.id).join(", ")}`).join("; ") || "none";
  const isApp = (name: string) => parseAppCheckIdentity(name) !== undefined;

  for (const mapping of strategy.criterionMappings) {
    if (mapping.testNames.some(isApp) && mapping.testNames.some(name => !isApp(name)))
      reject("unsupported_verification", `Criterion ${mapping.criterionId} mixes real-app identities and other test names; split UI/API real-app checks into their own criterion`);
    for (const name of mapping.testNames) {
      const parsed = parseAppCheckIdentity(name);
      if (parsed && !configured.get(parsed.suiteId)?.has(parsed.checkId))
        reject("unsupported_verification", `unknown real-app check ${name}; configured: ${configuredList}`);
    }
  }

  const app: AppCriterionBinding[] = [];
  for (const criterion of specification.acceptanceCriteria) {
    const names = strategy.criterionMappings.filter(mapping => mapping.criterionId === criterion.id).flatMap(mapping => mapping.testNames);
    const appNames = names.filter(isApp);
    const active = criterion.required !== false && criterion.status !== "waived";
    if (appNames.length === 0 || !active) continue;
    if (criterion.verificationMethod !== "e2e_test")
      reject("unsupported_method", `Criterion ${criterion.id} maps real-app checks but uses ${criterion.verificationMethod}; real-app checks require verificationMethod e2e_test`);
    const suiteIds = [...new Set(appNames.map(name => parseAppCheckIdentity(name)!.suiteId))];
    if (suiteIds.length !== 1) reject("unsupported_verification", `Criterion ${criterion.id} spans several real-app suites; give each suite its own criterion`);
    const suiteId = suiteIds[0]!;
    if (!strategy.targetCommands.includes(`app:${suiteId}`))
      reject("unknown_test_command", `Criterion ${criterion.id} needs app:${suiteId} among the strategy targetCommands`);
    app.push({ criterion, suiteId,
      checkIds: [...new Set(appNames.map(name => parseAppCheckIdentity(name)!.checkId))],
      identities: [...new Set(appNames)] });
  }

  const automated = specification.acceptanceCriteria.filter(criterion => criterion.required !== false && criterion.status !== "waived" && criterion.verificationMethod !== "manual_review");
  if (strategy.tddDecision.mode === "required" && automated.length > 0 && automated.every(criterion => app.some(binding => binding.criterion.id === criterion.id)))
    reject("unsupported_verification", "real-app checks are verification evidence, not Red-Green-Refactor evidence; add a unit/integration criterion with a runner for the Red phase");

  const appIds = new Set(app.map(binding => binding.criterion.id));
  const suiteCommands = new Set(suites.map(suite => `app:${suite.id}`));
  return {
    app,
    rest: {
      specification: { ...specification, acceptanceCriteria: specification.acceptanceCriteria.filter(criterion => !appIds.has(criterion.id)) },
      strategy: { ...strategy,
        criterionMappings: strategy.criterionMappings.filter(mapping => !appIds.has(mapping.criterionId)),
        targetCommands: strategy.targetCommands.filter(command => !suiteCommands.has(command)) }
    }
  };
}
