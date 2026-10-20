import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { QualityGateDefinitionSchema, type QualityGateDefinition } from "@bflow/contracts";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { digest, record, textField } from "./journal.js";
import { parseVitestJson } from "./vitest-json.js";
import { assertCheckoutDependencyRoot, sandboxBehavior } from "./behavioral-sandbox.js";
import type { AdapterRunner } from "./runner-adapter.js";
import { parseRunnerResult } from "./runner-results.js";
import { collectRunnerReports } from "./runner-reports.js";
import { assertRunnerProvenance } from "./runner-provenance.js";

export interface BehavioralCommand {
  id: string; command: string; executable: string; args: string[];
  method: "unit_test" | "integration_test" | "e2e_test";
  levels: ("unit" | "integration" | "e2e" | "property" | "regression" | "smoke")[];
  testNames: string[]; testPaths: string[]; reporter?: "node_tap" | "vitest_json"; timeoutMs: number; maxOutputBytes?: number;
  dependencyRoots?: string[];
}
/**
 * Runtime-detected runner (no owner file): executable/argv/prepare come only from Runtime's own repository detection, never
 * from a role message. Test identities are bound per task from the accepted strategy and the task's committed test files.
 */
export interface RunnerProfile {
  id: string; command: string; executable: string; args: string[];
  method: BehavioralCommand["method"]; levels: BehavioralCommand["levels"]; reporter: NonNullable<BehavioralCommand["reporter"]>;
  timeoutMs: number; maxOutputBytes?: number;
  /** Repository-relative `node_modules` directories mounted read-only at the same relative path inside the measurement checkout. */
  checkoutDependencyRoots: string[];
  /** Absolute repository root the dependency roots are read from. */
  dependencySource: string;
  /** Optional sandboxed build before the tests (e.g. `tsc -b`); it may only create git-ignored files. */
  prepare?: { args: string[]; timeoutMs: number };
  source: "detected";
  adapter?: AdapterRunner;
  definitionBlobs?: Record<string, string>;
}
/** Detection outcome; `unsupported` carries a user-facing reason and what an agent or Runtime could do about it. */
export type RunnerDetection =
  | { status: "detected"; profiles: RunnerProfile[]; notes: string[] }
  | { status: "unsupported"; reason: string; remediation: string[]; agentFixable?: boolean };
export type BoundBehavioralCommand = BehavioralCommand & Partial<Pick<RunnerProfile, "checkoutDependencyRoots" | "dependencySource" | "prepare" | "adapter" | "definitionBlobs">> & { reportDirectory?: string; originalRevision?: string };
const permittedLevels: Record<BehavioralCommand["method"], readonly string[]> = {
  unit_test: ["unit", "property", "regression"], integration_test: ["integration", "regression", "smoke"], e2e_test: ["e2e", "regression", "smoke"]
};
/** Bound test files must live in a test directory or carry a test/spec suffix; owner configuration is not restricted this way. */
export const testFilePattern = /(^|\/)(test|tests|__tests__|spec|Specs|Tests)\/|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.(py|go|rb|dart|exs)$|Spec\.rb$|(?:Test|Tests|Spec)\.(java|kt|cs|php|swift|cpp|cc|cxx)$|(^|\/)src\/.*\.rs$/;
function strings(value: unknown, name: string, nonempty = true): string[] {
  if (!Array.isArray(value) || nonempty && !value.length || value.some(item => typeof item !== "string" || !item.length || item.includes("\0"))) throw new Error(`Invalid behavioral ${name}`);
  return [...value];
}
/** Shared identity rules for owner configuration and Runtime-bound profiles. */
function assertTestIdentities(testNames: readonly string[], testPaths: readonly string[]): void {
  if (new Set(testNames).size !== testNames.length || new Set(testPaths).size !== testPaths.length || testPaths.some(path => path.startsWith("/") || path.includes("\\") || path.includes(":") || path.split("/").some(part => !part || part === "." || part === ".."))) throw new Error("Behavioral test identities/paths must be unique and safe");
}
function assertExecutionBounds(timeoutMs: unknown, maxOutputBytes: unknown): void {
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 300_000 || maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || Number(maxOutputBytes) < 1 || Number(maxOutputBytes) > 4_194_304)) throw new Error("Invalid behavioral execution bounds");
}
/** This configuration is trusted owner input, never a role message or executable shell string. */
export function parseBehavioralCommands(input: unknown): BehavioralCommand[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("behavioralCommands must be an array");
  const commands = input.map(raw => {
    const value = record(raw);
    if (Object.keys(value).some(key => !["id", "command", "executable", "args", "method", "levels", "testNames", "testPaths", "timeoutMs", "maxOutputBytes", "reporter", "dependencyRoots"].includes(key))) throw new Error("Unknown behavioral command configuration field");
    const id = textField(value.id), command = textField(value.command), executable = textField(value.executable);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || executable.includes("\0") || !isAbsolute(executable)) throw new Error("Behavioral executable must be an absolute owner-configured path and id must be safe");
    if (!["unit_test", "integration_test", "e2e_test"].includes(String(value.method))) throw new Error("Unsupported behavioral method");
    const method = value.method as BehavioralCommand["method"], levels = strings(value.levels, "levels") as BehavioralCommand["levels"];
    if (levels.some(level => !permittedLevels[method].includes(level))) throw new Error("Behavioral test levels do not match method");
    if (value.reporter !== undefined && value.reporter !== "node_tap" && value.reporter !== "vitest_json") throw new Error("Unsupported behavioral reporter");
    const args = strings(value.args, "argv", false), testNames = strings(value.testNames, "test names"), testPaths = strings(value.testPaths, "test paths");
    const dependencyRoots = value.dependencyRoots === undefined ? undefined : strings(value.dependencyRoots, "dependency roots", false);
    if (dependencyRoots?.some(path => !isAbsolute(path) || path.split("/").some(part => part === ".." || part === ".") || !path.endsWith("/node_modules"))) throw new Error("Behavioral dependency roots must be absolute node_modules directories");
    assertTestIdentities(testNames, testPaths);
    assertExecutionBounds(value.timeoutMs, value.maxOutputBytes);
    return { id, command, executable, args, method, levels, testNames, testPaths, ...(dependencyRoots === undefined ? {} : { dependencyRoots }), ...(value.reporter === undefined ? {} : { reporter: value.reporter as NonNullable<BehavioralCommand["reporter"]> }), timeoutMs: Number(value.timeoutMs), ...(value.maxOutputBytes === undefined ? {} : { maxOutputBytes: Number(value.maxOutputBytes) }) };
  });
  if (new Set(commands.map(value => value.id)).size !== commands.length || new Set(commands.map(value => value.command)).size !== commands.length) throw new Error("Duplicate behavioral command identity");
  // One measured MCP request must finish inside its ten-minute transport deadline,
  // including bounded checkout/setup/cleanup for every configured command.
  if (commands.reduce((total, command) => total + command.timeoutMs + 90_000, 0) > 540_000) throw new Error("Aggregate behavioral execution budget exceeds the host deadline");
  return commands;
}
/** Binds a Runtime-detected profile to test identities from the accepted strategy and the task's committed test files. */
export function bindRunnerProfile(profile: RunnerProfile, identities: { testNames: string[]; testPaths: string[] }): BoundBehavioralCommand {
  if (profile.source !== "detected") throw new Error("Runner profiles must be Runtime-detected");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile.id) || profile.command.length === 0 || profile.executable.includes("\0") || !isAbsolute(profile.executable)) throw new Error("Runner profile executable must be absolute and id must be safe");
  if (!["unit_test", "integration_test", "e2e_test"].includes(profile.method)) throw new Error("Unsupported behavioral method");
  const levels = strings(profile.levels, "levels") as BehavioralCommand["levels"];
  if (levels.some(level => !permittedLevels[profile.method].includes(level))) throw new Error("Behavioral test levels do not match method");
  if (profile.reporter !== "node_tap" && profile.reporter !== "vitest_json") throw new Error("Unsupported behavioral reporter");
  const args = strings(profile.args, "argv", false);
  const testNames = strings(identities.testNames, "test names"), testPaths = strings(identities.testPaths, "test paths");
  assertTestIdentities(testNames, testPaths);
  if (testPaths.some(path => !testFilePattern.test(path))) throw new Error("Behavioral test paths must be committed test files");
  // A dependency-free repository (for example node --test without node_modules) has no roots to mount.
  const checkoutDependencyRoots = strings(profile.checkoutDependencyRoots, "checkout dependency roots", false);
  for (const path of checkoutDependencyRoots) assertCheckoutDependencyRoot(path);
  if (!isAbsolute(profile.dependencySource) || profile.dependencySource.includes("\0")) throw new Error("Behavioral dependency source must be an absolute repository path");
  assertExecutionBounds(profile.timeoutMs, profile.maxOutputBytes);
  if (profile.prepare !== undefined) assertExecutionBounds(profile.prepare.timeoutMs, undefined);
  profile.adapter?.bind({ testNames, testPaths }, "/tmp/bflow-profile-validation");
  const filter = "^(?:" + testNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")$";
  const selectedArgs = profile.adapter ? [...args] : [...args, ...(profile.reporter === "vitest_json" ? [`--testNamePattern=${filter}`] : args.includes("--test") ? [`--test-name-pattern=${filter}`] : []), ...testPaths];
  return {
    id: profile.id, command: profile.command, executable: profile.executable, args: selectedArgs,
    method: profile.method, levels, testNames, testPaths, reporter: profile.reporter, timeoutMs: profile.timeoutMs,
    ...(profile.maxOutputBytes === undefined ? {} : { maxOutputBytes: profile.maxOutputBytes }),
    checkoutDependencyRoots, dependencySource: profile.dependencySource,
    ...(profile.adapter ? { adapter: profile.adapter } : {}),
    ...(profile.definitionBlobs ? { definitionBlobs: Object.fromEntries(Object.entries(profile.definitionBlobs).filter(([path]) => !testPaths.includes(path))) } : {}),
    ...(profile.prepare === undefined ? {} : { prepare: { args: strings(profile.prepare.args, "prepare argv"), timeoutMs: profile.prepare.timeoutMs } })
  };
}
export function behavioralChecks(commands: readonly BehavioralCommand[]): QualityGateDefinition[] {
  return commands.map(command => QualityGateDefinitionSchema.parse({ id: `host-behavioral-${command.id}`, name: `Independent ${command.id}`, evaluator: "host-behavioral-command", required: true,
    timeout: { executionTimeoutMs: command.timeoutMs + 60_000, onTimeout: "block" }, metadata: { bindAcceptedCriteria: true },
    configuration: { kind: "deterministic", method: command.method, command: command.command, criterionIds: [], testNames: command.testNames, role: "quality_gate", levels: command.levels } }));
}
const execute = promisify(execFile);
export async function verificationGit(cwd: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], { cwd, env, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
}
export async function assertPinnedRevision(cwd: string, revision: string) {
  if (!/^[a-f0-9]{40}$/.test(revision) || (await verificationGit(cwd, ["rev-parse", "HEAD"])).trim() !== revision || await verificationGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])) throw new Error("Verification needs a clean worktree at the pinned revision");
}
/** Supported measurement protocol: complete, flat Node test-runner TAP with assertion diagnostics. */
export function parseNodeTap(outcome: QualityCommandOutcome, expectedNames: readonly string[], nameSelection = false) {
  if (outcome.spawnError || outcome.timedOut || outcome.aborted || outcome.outputTruncated || outcome.signal || outcome.exitCode === null) throw new Error("Behavioral runner infrastructure failure (spawn, deadline, signal or truncated output)");
  const output = outcome.stdout.replace(/\r\n/g, "\n");
  if (!output.startsWith("TAP version 13\n") || /^Bail out!/m.test(output)) throw new Error("Behavioral runner requires complete Node TAP output");
  const allResults = [...output.matchAll(/^(not ok|ok) (\d+) - (.+)\n([\s\S]*?)(?=^(?:not ok|ok) \d+ - |^1\.\.\d+\s*$)/gm)];
  const count = (label: string) => { const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, "gm"))]; if (matches.length !== 1) throw new Error("Incomplete TAP counters"); return Number(matches[0]![1]); };
  const filtered = nameSelection ? allResults.filter(result => result[1] === "ok" && result[3]!.endsWith(" # SKIP test name does not match pattern") && !expectedNames.includes(result[3]!.replace(/ # SKIP test name does not match pattern$/, ""))) : [];
  const results = allResults.filter(result => !filtered.includes(result));
  const total = count("tests"), tests = results.length, passed = count("pass"), failed = count("fail");
  if (!tests || count("cancelled") || count("skipped") !== filtered.length || count("todo") || total !== allResults.length || passed + failed !== tests || !new RegExp(`^1\\.\\.${total}$`, "m").test(output) || allResults.some((result, index) => Number(result[2]) !== index + 1)) throw new Error("Zero, nested, skipped or incomplete tests cannot prove behavior");
  const names = results.map(result => result[3]!);
  if (digest([...names].sort()) !== digest([...expectedNames].sort())) throw new Error("Observed test names differ from owner-configured identities");
  const failures = results.filter(result => result[1] === "not ok");
  if (failures.length !== failed || results.filter(result => result[1] === "ok").length !== passed || (failed === 0 ? outcome.exitCode !== 0 : outcome.exitCode !== 1)) throw new Error("TAP result contradicts process exit code");
  const targetFailure = failed > 0 && failures.every(result => /^\s+failureType: 'testCodeFailure'$/m.test(result[4]!) && /^\s+code: 'ERR_ASSERTION'$/m.test(result[4]!));
  if (failed && !targetFailure) throw new Error("Behavioral failure is infrastructure or unrelated, not an assertion regression");
  return { testNames: names, testResults: results.map(result => ({ name: result[3]!, passed: result[1] === "ok" })), tests, passed, failed, targetFailure };
}
export interface BehavioralMeasurement {
  sourceRevision: string; command: string; commandId: string; method: BehavioralCommand["method"];
  testBlobs: Record<string, string>; testNames: string[]; testResults: { name: string; passed: boolean }[]; tests: number; passed: number; failed: number; targetFailure: boolean;
  outcome: QualityCommandOutcome;
}
/** Bounded diagnostic tail for a failed prepare step. */
function outputTail(outcome: QualityCommandOutcome): string {
  const stderr = outcome.stderr.trim().slice(-1_000), stdout = outcome.stdout.trim().slice(-1_000);
  return [stderr ? `stderr: ${stderr}` : "", stdout ? `stdout: ${stdout}` : ""].filter(Boolean).map(part => ` ${part}`).join("");
}
/** Runs only committed bytes in a new detached worktree; it has no host credentials or inherited Node/Git overrides. */
export async function measureBehavior(command: BoundBehavioralCommand, cwd: string, revision: string): Promise<BehavioralMeasurement> {
  await assertPinnedRevision(cwd, revision);
  await assertRunnerProvenance(command, cwd, revision);
  const testBlobs: Record<string, string> = {};
  for (const path of command.testPaths) {
    const entry = (await verificationGit(cwd, ["ls-tree", revision, "--", path])).trim();
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t/.exec(entry);
    if (!match) throw new Error(`Behavioral test identity must be a committed regular file: ${path}`);
    testBlobs[path] = match[1]!;
  }
  Object.assign(testBlobs, command.definitionBlobs ?? {});
  const temporary = await mkdtemp(join(tmpdir(), "bflow-behavioral-")), checkout = join(temporary, "checkout");
  let added = false;
  try {
    await verificationGit(cwd, ["worktree", "add", "--detach", checkout, revision]); added = true;
    const reportDirectory = join(temporary, "reports");
    if (command.adapter) {
      await mkdir(reportDirectory, { mode: 0o700 });
      for (const helper of command.adapter.helpers ?? []) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(helper.name) || Buffer.byteLength(helper.content) > 65536) throw new Error("Invalid Runtime runner helper");
        await writeFile(join(reportDirectory, helper.name), helper.content, { mode: 0o400 });
      }
      command = { ...command, reportDirectory };
    }
    const invocation = command.adapter?.bind({ testNames: command.testNames, testPaths: command.testPaths }, reportDirectory);
    if (invocation?.reportPaths?.length && (await collectRunnerReports(invocation.reportPaths, checkout, reportDirectory)).length) throw new Error("Behavioral report must not exist before execution");
    const projectCwd = command.adapter && command.adapter.projectDirectory !== "." ? join(checkout, command.adapter.projectDirectory) : checkout;
    const module = await import(new URL("../../../quality-gates/dist/index.js", import.meta.url).href);
    const runner = module.createQualityCommandRunner();
    const env: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: "/tmp/bflow-home", TMPDIR: "/tmp", ...(command.adapter?.environment ?? {}) };
    const maxOutputBytes = command.maxOutputBytes ?? 1_048_576;
    // A Runtime-detected profile may run a sandboxed build first (e.g. `tsc -b`); it gets the same boundary, its own deadline, and may only leave git-ignored outputs.
    const preparation = invocation?.prepare ?? command.adapter?.prepare ?? (command.prepare ? { ...command.prepare, executable: command.executable } : undefined);
    if (preparation) {
      const prepareSandbox = await sandboxBehavior({ ...command, executable: preparation.executable }, checkout, preparation.args).catch(error => {
        throw new Error(`Behavioral runner infrastructure failure (prepare): ${String(error)}`, { cause: error });
      });
      const prepared = await runner.run({ ...prepareSandbox, cwd: projectCwd, env, timeoutMs: preparation.timeoutMs, maxOutputBytes });
      if (!prepared.ok) throw new Error(`Behavioral runner infrastructure failure (prepare): ${prepared.error.message}`);
      const prepareOutcome = prepared.value as QualityCommandOutcome;
      const failure = prepareOutcome.spawnError ?? (prepareOutcome.stderr.startsWith("bwrap:") ? prepareOutcome.stderr.trim()
        : prepareOutcome.outputTruncated ? "truncated prepare output" : prepareOutcome.timedOut ? "deadline exceeded" : prepareOutcome.aborted ? "aborted" : prepareOutcome.signal ? `signal ${prepareOutcome.signal}`
        : prepareOutcome.exitCode !== 0 ? `exit ${prepareOutcome.exitCode}` : undefined);
      if (failure !== undefined) throw new Error(`Behavioral runner infrastructure failure (prepare): ${failure}${outputTail(prepareOutcome)}`);
    }
    // The official JSON reporter omits runtime errors. A fixed host companion attests its onFinished errors argument.
    const reporter = command.reporter === "vitest_json" ? join(temporary, "vitest-runtime-reporter.mjs") : undefined;
    if (reporter) {
      const source = await readFile(fileURLToPath(new URL("../../dist/agentic/vitest-runtime-reporter.js", import.meta.url)), "utf8");
      // A standalone immutable copy avoids exposing the host source tree just to
      // satisfy Vite's optional source-map reads inside the empty namespace.
      await writeFile(reporter, source.replace(/^\/\/# sourceMappingURL=.*$/gm, ""), { mode: 0o600 });
    }
    const args = invocation?.args ?? (reporter ? [...command.args, `--reporter=${reporter}`] : command.args);
    const sandbox = await sandboxBehavior(command, checkout, args, reporter).catch(error => {
      throw new Error(`Behavioral runner infrastructure failure (sandbox preparation): ${String(error)}`, { cause: error });
    });
    const result = await runner.run({ ...sandbox, cwd: projectCwd, env, timeoutMs: command.timeoutMs, maxOutputBytes });
    if (!result.ok) throw new Error(`Behavioral command invocation failed: ${result.error.message}`);
    const outcome = result.value as QualityCommandOutcome;
    if (outcome.stderr.startsWith("bwrap:")) throw new Error(`Behavioral sandbox failed: ${outcome.stderr.trim()}`);
    // Tracked files must match the revision and no non-ignored untracked file may exist. Prepared checkouts may also hold
    // git-ignored outputs (build output, dependency mountpoints), so only owner commands keep the strict ignored-file check.
    await assertPinnedRevision(checkout, revision);
    const relaxed = command.prepare !== undefined || command.checkoutDependencyRoots !== undefined;
    if (!relaxed && await verificationGit(checkout, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all", "-z"])) throw new Error("Behavioral execution generated files outside the committed revision");
    await assertPinnedRevision(cwd, revision);
    const parsed = command.adapter ? parseRunnerResult(command.adapter.format, outcome, command.testNames,
      invocation?.reportPaths ? await collectRunnerReports(invocation.reportPaths, checkout, reportDirectory) : undefined, command.adapter.failureExitCodes)
      : command.reporter === "vitest_json" ? parseVitestJson(outcome, command.testNames, command.checkoutDependencyRoots !== undefined) : parseNodeTap(outcome, command.testNames, command.checkoutDependencyRoots !== undefined);
    return { sourceRevision: revision, command: command.command, commandId: command.id, method: command.method, testBlobs, ...parsed, outcome };
  } finally {
    if (added) await verificationGit(cwd, ["worktree", "remove", "--force", checkout]);
    await rm(temporary, { recursive: true, force: true });
  }
}
