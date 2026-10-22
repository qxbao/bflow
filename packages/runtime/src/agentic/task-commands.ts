import { QualityGateDefinitionSchema, type QualityGateDefinition, type Specification, type TestStrategy } from "@bflow/contracts";
import { verificationGit } from "./behavioral-runner.js";
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

export interface AutomaticRunner { id: string; command: string; method: BehavioralCommand["method"]; levels: readonly string[] }

/** Static gate definitions for the automatic runners; their test identities are bound when the verification plan is built. */
export function automaticChecks(runners: readonly AutomaticRunner[] = AUTOMATIC_RUNNERS): QualityGateDefinition[] {
  return runners.map(runner => QualityGateDefinitionSchema.parse({
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
  private revision: string | undefined;
  private readonly snapshots = new Map<string, RunnerProfile[]>();
  constructor(readonly owner: readonly BehavioralCommand[], private readonly repositoryRoot?: string,
    private readonly detect: (repositoryRoot: string) => Promise<RunnerDetection> = root => detectTestRunners(root)) {}
  /** True when no owner command exists and a repository is available for detection. */
  get automatic(): boolean { return this.owner.length === 0 && this.repositoryRoot !== undefined; }
  /** Latest detection result; undefined before the first refresh or in owner mode. */
  get current(): RunnerDetection | undefined { return this.detection; }
  get profiles(): RunnerProfile[] { return this.detection?.status === "detected" ? [...this.detection.profiles] : []; }
  /** Profiles already discovered for the task's original repository revision remain authoritative while HEAD advances. */
  profilesForRevision(revision?: string): RunnerProfile[] { return revision && this.snapshots.has(revision) ? [...this.snapshots.get(revision)!] : this.profiles; }
  get availableProfiles(): RunnerProfile[] { return [...new Map([...this.snapshots.values()].flat().concat(this.profiles).map(profile => [profile.id, profile])).values()]; }
  /**
   * Detects once. An unsupported result is retried on every call, because dependencies may have been installed since;
   * a host restart is never required.
   */
  async refresh(): Promise<RunnerDetection | undefined> {
    if (!this.automatic) return undefined;
    const revision = await verificationGit(this.repositoryRoot!, ["rev-parse", "HEAD"]).then(value => value.trim()).catch(() => undefined);
    if (this.detection?.status !== "detected" || revision !== this.revision) {
      this.detection = await this.detect(this.repositoryRoot!); this.revision = revision;
      if (revision && this.detection.status === "detected") this.snapshots.set(revision, [...this.detection.profiles]);
    }
    return this.detection;
  }
}

export function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }

/** Test identities for one automatic profile: mapped names of the active criteria with its method, and the test files in scope. */
function matchesRunnerFile(profile: RunnerProfile, path: string): boolean {
  const adapter = profile.adapter?.adapterId ?? "javascript";
  const patterns: Record<string, RegExp> = { javascript: /\.[cm]?[jt]sx?$/, vitest: /\.[cm]?[jt]sx?$/, node: /\.[cm]?[jt]sx?$/, jest: /\.[cm]?[jt]sx?$/, mocha: /\.[cm]?[jt]sx?$/,
    python: /\.py$/, pytest: /\.py$/, go: /_test\.go$/, rust: /\.rs$/, cargo: /\.rs$/, maven: /\.(?:java|kt)$/, gradle: /\.(?:java|kt)$/, dotnet: /\.(?:cs|fs|vb)$/, rspec: /\.rb$/, minitest: /\.rb$/, phpunit: /\.php$/, ctest: /\.(?:c|cc|cpp|cxx|cmake)$/ };
  return patterns[adapter]?.test(path) ?? true;
}
export function automaticTestPaths(profile: RunnerProfile, specification: Specification, ownedPaths?: readonly string[]) {
  const project = profile.adapter?.projectDirectory;
  return unique(specification.affectedPaths.filter(path => testFilePattern.test(path) && matchesRunnerFile(profile, path) &&
    (project === undefined || project === "." || path.startsWith(project + "/")) &&
    (ownedPaths === undefined || ownedPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`)))));
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
  const selected = input.profiles.filter(profile => targets.has(profile.command));
  const namesByProfile = new Map<RunnerProfile, string[]>();
  for (const criterion of input.specification.acceptanceCriteria.filter(item => item.required !== false && item.status !== "waived")) {
    const mapping = input.strategy.criterionMappings.find(item => item.criterionId === criterion.id);
    if (!mapping?.testNames.length || !selected.some(profile => profile.method === criterion.verificationMethod)) {
      continue;
    }
    const matches = selected.filter(profile => {
      if (profile.method !== criterion.verificationMethod) return false;
      const testPaths = automaticTestPaths(profile, input.specification);
      if (!testPaths.length) return false;
      try { bindRunnerProfile(profile, { testNames: unique(mapping.testNames), testPaths }); return true; } catch { return false; }
    });
    if (matches.length !== 1) throw new Error(`runner_identity_unselectable: criterion ${criterion.id} needs one unambiguous selected runner; split ambiguous criterion mappings`);
    const profile = matches[0]!, testPaths = automaticTestPaths(profile, input.specification, input.ownedPaths);
    if (!testPaths.length) continue;
    try { bindRunnerProfile(profile, { testNames: unique(mapping.testNames), testPaths }); }
    catch (error) { if (input.ownedPaths !== undefined) continue; throw error; }
    namesByProfile.set(profile, unique([...(namesByProfile.get(profile) ?? []), ...mapping.testNames]));
  }
  const bound = [...namesByProfile].map(([profile, testNames]) => bindRunnerProfile(profile, {
    testNames, testPaths: automaticTestPaths(profile, input.specification, input.ownedPaths)
  }));
  const commands = [...owner, ...bound];
  if (!commands.length && input.ownedPaths === undefined && input.specification.acceptanceCriteria.some(item => item.required !== false && item.status !== "waived" && item.verificationMethod !== "manual_review")) {
    throw new Error("runner_identity_unselectable: no behavioral runner command could be bound for required criteria; verify test files and criterion mappings");
  }
  const commandBudget = (command: BoundBehavioralCommand) =>
    command.timeoutMs + (command.prepare?.timeoutMs ?? command.adapter?.prepare?.timeoutMs ?? command.adapter?.bind(command, "/tmp/bflow-profile-validation").prepare?.timeoutMs ?? 0) + 90000;
  const budgetExceeded = input.ownedPaths !== undefined
    ? commands.reduce((total, command) => total + commandBudget(command), 0) > 540000
    : commands.some(command => commandBudget(command) > 540000);
  if (bound.length && budgetExceeded)
    throw new Error("runner_identity_unselectable: split selected runners into tasks within the independent execution deadline");
  return commands;
}

const TEST_PATH_RULE = "Test files must be listed in specification.affectedPaths, use the selected adapter language and its project directory, be committed, and belong to the task ownership. Split tasks whose criterion identities cannot be selected unambiguously.";
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
        testPathRule: TEST_PATH_RULE, testNameRule: profile.adapter?.nameRule ?? (profile.reporter === "vitest_json" ? VITEST_NAME_RULE : TAP_NAME_RULE),
        ...(profile.adapter ? { adapter: profile.adapter.adapterId, version: profile.adapter.version, projectDirectory: profile.adapter.projectDirectory, resultFormat: profile.adapter.format } : {})
      }))
    ],
    testRunnerDetection: !source.automatic ? { status: "owner" }
      : detection?.status === "detected" ? { status: "detected", notes: detection.notes }
      : detection?.status === "unsupported" ? { status: "unsupported", reason: detection.reason, remediation: detection.remediation }
      : { status: "unsupported", reason: "Test runner detection has not run yet", remediation: [] }
  };
}
