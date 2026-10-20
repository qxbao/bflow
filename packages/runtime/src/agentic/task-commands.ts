import { QualityGateDefinitionSchema, type QualityGateDefinition, type Specification, type TestStrategy } from "@bflow/contracts";
import { bindRunnerProfile, testFilePattern, type BehavioralCommand, type BoundBehavioralCommand, type RunnerDetection, type RunnerProfile } from "./behavioral-runner.js";
import { PREPARE_TIMEOUT_MS, PROFILE_TIMEOUT_MS, detectTestRunners } from "./runner-detection.js";

/**
 * Runtime-detected runner labels. Coordinators reference them in `infrastructure.commands` (command `auto:unit` or
 * `auto:integration`); the matching profile is bound per task from the accepted criteria and the committed test files.
 */
export const AUTOMATIC_RUNNERS = [
  { id: "auto-unit", command: "auto:unit", method: "unit_test", levels: ["unit", "regression"] },
  { id: "auto-integration", command: "auto:integration", method: "integration_test", levels: ["integration", "regression"] }
] as const;

export type AutomaticRunner = (typeof AUTOMATIC_RUNNERS)[number];

/** Static gate definitions for the automatic runners; their test identities are bound when the verification plan is built. */
export function automaticChecks(): QualityGateDefinition[] {
  return AUTOMATIC_RUNNERS.map(runner => QualityGateDefinitionSchema.parse({
    id: `host-behavioral-${runner.id}`, name: `Independent ${runner.command}`, evaluator: "host-behavioral-command", required: true,
    timeout: { executionTimeoutMs: PROFILE_TIMEOUT_MS + PREPARE_TIMEOUT_MS + 60_000, onTimeout: "block" },
    metadata: { bindAcceptedCriteria: true, bindMethodTestNames: true },
    configuration: { kind: "deterministic", method: runner.method, command: runner.command, criterionIds: [], testNames: [], role: "quality_gate", levels: [...runner.levels] }
  }));
}

/**
 * Owner commands (`.bflow/verification.json`, optional override) or Runtime-detected runner profiles. Owner configuration
 * disables automatic detection entirely, so existing owner-configured hosts keep their exact behaviour.
 */
export class TestRunnerSource {
  private detection: RunnerDetection | undefined;
  constructor(readonly owner: readonly BehavioralCommand[], private readonly repositoryRoot?: string,
    private readonly detect: (repositoryRoot: string) => Promise<RunnerDetection> = root => detectTestRunners(root)) {}
  /** True when no owner command exists and a repository is available for detection. */
  get automatic(): boolean { return this.owner.length === 0 && this.repositoryRoot !== undefined; }
  /** Latest detection result; undefined before the first refresh or in owner mode. */
  get current(): RunnerDetection | undefined { return this.detection; }
  get profiles(): RunnerProfile[] { return this.detection?.status === "detected" ? [...this.detection.profiles] : []; }
  /**
   * Detects once. An unsupported result is retried on every call, because dependencies may have been installed since;
   * a host restart is never required.
   */
  async refresh(): Promise<RunnerDetection | undefined> {
    if (!this.automatic) return undefined;
    if (this.detection?.status !== "detected") this.detection = await this.detect(this.repositoryRoot!);
    return this.detection;
  }
}

export function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }

/** Test identities for one automatic profile: mapped names of the active criteria with its method, and the test files in scope. */
export function automaticIdentities(profile: RunnerProfile, specification: Specification, strategy: TestStrategy, ownedPaths?: readonly string[] | undefined) {
  const criteria = specification.acceptanceCriteria.filter(criterion => criterion.required !== false && criterion.status !== "waived" && criterion.verificationMethod === profile.method);
  const testNames = unique(criteria.flatMap(criterion => strategy.criterionMappings.find(mapping => mapping.criterionId === criterion.id)?.testNames ?? []));
  const testPaths = unique(specification.affectedPaths.filter(path => testFilePattern.test(path) &&
    (ownedPaths === undefined || ownedPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`)))));
  return testNames.length && testPaths.length ? { testNames, testPaths } : undefined;
}

export interface TaskCommandInput {
  owner: readonly BehavioralCommand[]; profiles: readonly RunnerProfile[];
  strategy: TestStrategy; specification: Specification; ownedPaths?: readonly string[] | undefined;
}

/**
 * The single resolver for Verification and Development: owner commands selected by the strategy, plus every selected
 * automatic profile that has test identities. Profiles without identities are omitted; assertSupported reports why.
 */
export function resolveTaskCommands(input: TaskCommandInput): BoundBehavioralCommand[] {
  const targets = new Set(input.strategy.targetCommands);
  const owner: BoundBehavioralCommand[] = input.owner.filter(command => targets.has(command.command));
  const bound = input.profiles.filter(profile => targets.has(profile.command)).flatMap(profile => {
    const identities = automaticIdentities(profile, input.specification, input.strategy, input.ownedPaths);
    return identities ? [bindRunnerProfile(profile, identities)] : [];
  });
  return [...owner, ...bound];
}

const TEST_PATH_RULE = "Test files must be listed in specification.affectedPaths (a test/ or tests/ directory or a .test/.spec suffix), committed in the task, and owned by the task.";
const VITEST_NAME_RULE = "vitest reports fullName: describe titles plus the test title joined by a single space. Use exactly that string in criterionMappings.testNames.";
const TAP_NAME_RULE = "node --test reports the test title only. Use exactly that string in criterionMappings.testNames.";

/** Planning view for Coordinator: owner entries as before, detected profiles with their naming rules and the detection status. */
export function describeTestRunners(source: TestRunnerSource) {
  const detection = source.current;
  return {
    testRunners: [
      ...source.owner.map(({ id, command, method, levels, testNames, testPaths, reporter }) =>
        ({ id, command, method, levels, testNames, testPaths, reporter: reporter ?? "node_tap", source: "owner" })),
      ...source.profiles.map(profile => ({
        id: profile.id, command: profile.command, method: profile.method, levels: profile.levels, reporter: profile.reporter, source: "detected",
        testPathRule: TEST_PATH_RULE, testNameRule: profile.reporter === "vitest_json" ? VITEST_NAME_RULE : TAP_NAME_RULE
      }))
    ],
    testRunnerDetection: !source.automatic ? { status: "owner" }
      : detection?.status === "detected" ? { status: "detected", notes: detection.notes }
      : detection?.status === "unsupported" ? { status: "unsupported", reason: detection.reason, remediation: detection.remediation }
      : { status: "unsupported", reason: "Test runner detection has not run yet", remediation: [] }
  };
}
