import { QualityGateDefinitionSchema, type QualityGateDefinition, type Specification, type TestStrategy } from "@bflow/contracts";
import { verificationGit } from "./behavioral-runner.js";
import { bindRunnerProfile, testFilePattern, type BehavioralCommand, type BoundBehavioralCommand, type RunnerDetection, type RunnerProfile } from "./behavioral-runner.js";
import { PREPARE_TIMEOUT_MS, PROFILE_TIMEOUT_MS, detectTestRunners } from "./runner-detection.js";
import { detectTypecheck, type TypecheckProfile } from "./typecheck.js";
import { TaskBlocker } from "./blockers.js";

/**
 * Runtime-detected runner labels. Coordinators reference them in `infrastructure.commands` (command `auto:unit` or
 * `auto:integration`); the matching profile is bound per task from the accepted criteria and the committed test files.
 */
export const AUTOMATIC_RUNNERS = [
  { id: "auto-unit", command: "auto:unit", method: "unit_test", levels: ["unit", "regression"] },
  { id: "auto-integration", command: "auto:integration", method: "integration_test", levels: ["integration", "regression"] }
] as const;

export const AUTOMATIC_STATIC_COMMANDS = ["auto:static", "auto:static_analysis", "auto:typecheck"] as const;
export function automaticCheckMethod(command: string): "typecheck" | "static_analysis" { return command === "auto:typecheck" ? "typecheck" : "static_analysis"; }

export function isAutomaticStaticCommand(command: string): boolean {
  return (AUTOMATIC_STATIC_COMMANDS as readonly string[]).includes(command);
}

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

/** Static gate definitions for affected-scope regression checks on detected JS profiles (no adapter). */
export function regressionChecks(profiles: readonly RunnerProfile[]): QualityGateDefinition[] {
  const seen = new Set<string>();
  return profiles
    .filter(profile => {
      if (profile.adapter) return false;
      const key = JSON.stringify([
        profile.executable,
        profile.args,
        profile.reporter,
        profile.dependencySource ?? "",
        profile.prepare ?? null
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(profile => QualityGateDefinitionSchema.parse({
      id: `host-regression-${profile.id}`,
      name: `Independent regression ${profile.command}`,
      evaluator: "host-regression-command",
      required: true,
      timeout: {
        executionTimeoutMs: Math.min(540_000, profile.timeoutMs * 3) + 60_000,
        onTimeout: "block"
      },
      metadata: { selection: "regression" },
      configuration: {
        kind: "deterministic",
        method: profile.method,
        command: profile.command,
        criterionIds: [],
        testNames: [],
        role: "quality_gate",
        levels: ["regression"]
      }
    }));
}

/**
 * Owner commands (`.bflow/verification.json`, optional override) or Runtime-detected runner profiles. Owner configuration
 * disables automatic detection entirely, so existing owner-configured hosts keep their exact behaviour.
 */
export class TestRunnerSource {
  private compiler: TypecheckProfile | undefined;
  private readonly compilerSnapshots = new Map<string, TypecheckProfile>();
  get typecheck() { return this.compiler; }
  typecheckForRevision(revision?: string) { return revision ? this.compilerSnapshots.get(revision) ?? this.compiler : this.compiler; }
  private detection: RunnerDetection | undefined;
  private revision: string | undefined;
  private readonly snapshots = new Map<string, RunnerProfile[]>();
  constructor(readonly owner: readonly BehavioralCommand[], readonly repositoryRoot?: string,
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
      this.compiler = this.detection.status === "detected" ? await detectTypecheck(this.repositoryRoot!, this.detection.profiles) : undefined;
      if (revision && this.compiler) this.compilerSnapshots.set(revision, this.compiler);
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
function safeTestPath(path: string): boolean {
  return !path.startsWith("/") && !path.includes("\\") && !path.includes(":") &&
    path.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
}
function selectTestPaths(profile: RunnerProfile, candidatePaths: readonly string[], specification: Specification, ownedPaths?: readonly string[]) {
  const project = profile.adapter?.projectDirectory;
  const inProjectScope = (path: string) =>
    safeTestPath(path) && testFilePattern.test(path) && matchesRunnerFile(profile, path) &&
    (project === undefined || project === "." || path.startsWith(project + "/"));
  const inOwnedScope = (path: string) =>
    ownedPaths === undefined || ownedPaths.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
  const scoped = unique(candidatePaths.filter(path => inProjectScope(path) && inOwnedScope(path)));
  const adapter = profile.adapter?.adapterId;
  if ((adapter === "rust" || adapter === "cargo") && scoped.length > 0) {
    const relativeToProject = (path: string) =>
      project !== undefined && project !== "." && path.startsWith(project + "/") ? path.slice(project.length + 1) : path;
    const isCargoIntegrationTest = (path: string) => /^tests\/[^/]+\.rs$/.test(relativeToProject(path));
    const isDedicatedRustUnitTest = (path: string) =>
      !isCargoIntegrationTest(path) && /(?:^|\/)tests\.rs$|_tests?\.rs$|(?:^|\/)tests\/.*\.rs$/.test(relativeToProject(path));
    const allProjectPaths = unique(candidatePaths.filter(inProjectScope));
    const specHasIntegrationCriterion = specification.acceptanceCriteria.some(
      item => item.required !== false && item.status !== "waived" && item.verificationMethod === "integration_test"
    );
    const integrationTests = scoped.filter(isCargoIntegrationTest);
    const dedicatedUnitTests = scoped.filter(isDedicatedRustUnitTest);
    if (profile.method === "integration_test" && integrationTests.length > 0) return integrationTests;
    if (integrationTests.length > 0 && (!specHasIntegrationCriterion || profile.method !== "unit_test")) return integrationTests;
    if (dedicatedUnitTests.length > 0) return dedicatedUnitTests;
    const methodHasExternalDedicatedTests = profile.method === "integration_test"
      ? allProjectPaths.some(isCargoIntegrationTest)
      : allProjectPaths.some(isDedicatedRustUnitTest) || (!specHasIntegrationCriterion && allProjectPaths.some(isCargoIntegrationTest));
    if (methodHasExternalDedicatedTests && ownedPaths !== undefined) {
      return [];
    }
    if (specHasIntegrationCriterion && profile.method === "unit_test") {
      const nonIntegration = scoped.filter(path => !isCargoIntegrationTest(path));
      if (nonIntegration.length > 0) return nonIntegration;
    }
  }
  return scoped;
}
export function automaticTestPaths(profile: RunnerProfile, specification: Specification, ownedPaths?: readonly string[]) {
  return selectTestPaths(profile, specification.affectedPaths, specification, ownedPaths);
}
export function observedTestPaths(profile: RunnerProfile, changedPaths: readonly string[], ownedPaths: readonly string[] | undefined, specification: Specification) {
  return selectTestPaths(profile, changedPaths, specification, ownedPaths);
}

export interface TaskCommandInput {
  owner: readonly BehavioralCommand[]; profiles: readonly RunnerProfile[];
  strategy: TestStrategy; specification: Specification; ownedPaths?: readonly string[] | undefined;
}
export interface ObservedTaskCommandSelection {
  commands: BoundBehavioralCommand[];
  coverageGaps: string[];
}

/**
 * The single resolver for Verification and Development: owner commands selected by the strategy, plus every selected
 * automatic profile that has test identities. Profiles without identities are omitted; assertSupported reports why.
 */
export function resolveTaskCommands(input: TaskCommandInput & { changedPaths: readonly string[] }): ObservedTaskCommandSelection;
export function resolveTaskCommands(input: TaskCommandInput): BoundBehavioralCommand[];
export function resolveTaskCommands(input: TaskCommandInput & { changedPaths?: readonly string[] }): BoundBehavioralCommand[] | ObservedTaskCommandSelection {
  const observed = input.changedPaths !== undefined;
  const selectedPaths = (profile: RunnerProfile, ownedPaths?: readonly string[]) =>
    observed ? observedTestPaths(profile, input.changedPaths!, ownedPaths, input.specification)
      : automaticTestPaths(profile, input.specification, ownedPaths);
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
      const testPaths = selectedPaths(profile, observed ? input.ownedPaths : undefined);
      if (!testPaths.length) return false;
      try { bindRunnerProfile(profile, { testNames: unique(mapping.testNames), testPaths }); return true; } catch { return false; }
    });
    if (matches.length === 0 && observed) continue;
    if (matches.length !== 1) throw new TaskBlocker("runner_identity_unselectable", `runner_identity_unselectable: criterion ${criterion.id} needs one unambiguous selected runner; split ambiguous criterion mappings`);
    const profile = matches[0]!, testPaths = selectedPaths(profile, input.ownedPaths);
    if (!testPaths.length) continue;
    try { bindRunnerProfile(profile, { testNames: unique(mapping.testNames), testPaths }); }
    catch (error) { if (input.ownedPaths !== undefined) continue; throw error; }
    namesByProfile.set(profile, unique([...(namesByProfile.get(profile) ?? []), ...mapping.testNames]));
  }
  const bound = [...namesByProfile].map(([profile, testNames]) => bindRunnerProfile(profile, {
    testNames, testPaths: selectedPaths(profile, input.ownedPaths)
  }));
  const commands = [...owner, ...bound];
  if (!commands.length && !observed && input.ownedPaths === undefined && input.specification.acceptanceCriteria.some(item => item.required !== false && item.status !== "waived" && item.verificationMethod !== "manual_review")) {
    throw new TaskBlocker("runner_identity_unselectable", "runner_identity_unselectable: no behavioral runner command could be bound for required criteria; verify test files and criterion mappings");
  }
  const commandBudget = (command: BoundBehavioralCommand) =>
    command.timeoutMs + (command.prepare?.timeoutMs ?? command.adapter?.prepare?.timeoutMs ?? command.adapter?.bind(command, "/tmp/bflow-profile-validation").prepare?.timeoutMs ?? 0) + 90000;
  const budgetExceeded = input.ownedPaths !== undefined
    ? commands.reduce((total, command) => total + commandBudget(command), 0) > 540000
    : commands.some(command => commandBudget(command) > 540000);
  if (bound.length && budgetExceeded)
    throw new Error("runner_identity_unselectable: split selected runners into tasks within the independent execution deadline");
  if (!observed) return commands;
  const changed = new Set(input.changedPaths);
  return { commands, coverageGaps: unique(input.specification.affectedPaths.filter(path =>
    safeTestPath(path) && testFilePattern.test(path) && !changed.has(path))) };
}

const TEST_PATH_RULE = "List the expected test files or test directories in specification.affectedPaths. Runtime measures the test files that the committed task diff actually changes, restricted to the selected adapter language, its project directory and the task ownership; each required criterion needs at least one of its mapped tests to run. Split tasks whose criterion identities cannot be selected unambiguously.";
const VITEST_NAME_RULE = "vitest reports fullName: describe titles plus the test title joined by a single space. Use exactly that string in criterionMappings.testNames.";
const TAP_NAME_RULE = "node --test reports the test title only. Use exactly that string in criterionMappings.testNames.";

/** Planning view for Coordinator: owner entries as before, detected profiles with their naming rules and the detection status. */
export function describeTestRunners(source: TestRunnerSource) {
  const detection = source.current;
  return {
    testRunners: [
      ...(source.typecheck ? [{ id: "auto-typecheck", command: "auto:typecheck", method: "typecheck", levels: [] as string[],
        source: "detected", reporter: "host_compiler", version: source.typecheck.version, projects: source.typecheck.projects,
        testPathRule: "Independent sandboxed TypeScript build of all detected tsconfig.json projects at the pinned revision; compiler diagnostics fail the check.",
        testNameRule: "Compiler evidence, not test identities. Select auto:typecheck for typecheck criteria and infrastructure commands." }] : []),
      ...source.owner.map(({ id, command, method, levels, testNames, testPaths, reporter }) =>
        ({ id, command, method, levels, testNames, testPaths, reporter: reporter ?? "node_tap", source: "owner" })),
      ...source.profiles.map(profile => ({
        id: profile.id, command: profile.command, method: profile.method, levels: profile.levels, reporter: profile.reporter, source: "detected",
        testPathRule: TEST_PATH_RULE, testNameRule: profile.adapter?.nameRule ?? (profile.reporter === "vitest_json" ? VITEST_NAME_RULE : TAP_NAME_RULE),
        ...(profile.adapter ? { adapter: profile.adapter.adapterId, version: profile.adapter.version, projectDirectory: profile.adapter.projectDirectory, resultFormat: profile.adapter.format } : {})
      })),
      ...(source.automatic && detection?.status === "detected" ? [{
        id: "auto-static", command: "auto:static", method: "static_analysis", levels: [] as string[], reporter: "host_static", source: "detected",
        testPathRule: "Host git diff --check plus syntax check of changed JavaScript (node --check), JSON, and TypeScript when its compiler is detected; other changed code fails closed.",
        testNameRule: "Policy static_analysis check; include {\"method\":\"static_analysis\",\"command\":\"auto:static\"} in metadata.conditionalTdd.infrastructure.commands when high-risk or security-sensitive policy requires static_analysis."
      }] : [])
    ],
    testRunnerDetection: !source.automatic ? { status: "owner" }
      : detection?.status === "detected" ? { status: "detected", notes: detection.notes }
      : detection?.status === "unsupported" ? { status: "unsupported", reason: detection.reason, remediation: detection.remediation }
      : { status: "unsupported", reason: "Test runner detection has not run yet", remediation: [] }
  };
}
