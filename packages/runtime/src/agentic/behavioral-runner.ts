import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { QualityGateDefinitionSchema, type QualityGateDefinition } from "@bflow/contracts";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { record, textField } from "./journal.js";
import { parseNodeTap } from "./node-tap.js";
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
/** Launcher failures (bubblewrap or sandbox-exec) are infrastructure errors, never test results. */
const SANDBOX_ERROR = /^(?:bwrap|sandbox-exec):/;
const execute = promisify(execFile);
export async function verificationGit(cwd: string, args: string[]): Promise<string> {
  // The host passes the verified session root (or the new canonical detached checkout on recursive calls).
  // Git's global/system config is deliberately omitted, so trust only this exact root for this process.
  const canonicalCwd = await realpath(cwd);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  const options = { cwd: canonicalCwd, env, timeout: 30000, maxBuffer: 2 * 1024 * 1024 };
  const fixed = ["-c", "safe.directory=", "-c", `safe.directory=${canonicalCwd}`,
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "submodule.recurse=false"];
  // Git checkout/status can run smudge/clean/process filters before the test sandbox exists.
  // Disable every effective filter, including config includes and worktree scopes; global/system config is excluded above.
  let keys = "";
  try { keys = (await execute("git", [...fixed, "config", "--includes", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], options)).stdout; }
  catch (error) { if ((error as { code?: unknown }).code !== 1) throw error; }
  const filters = new Set(keys.trim().split("\n").filter(Boolean).map(key => {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key);
    if (!match || /[\0\r\n]/.test(match[1]!)) throw new Error("Invalid local Git filter definition");
    return match[1]!;
  }));
  for (const name of filters) fixed.push("-c", `filter.${name}.clean=`, "-c", `filter.${name}.smudge=`, "-c", `filter.${name}.process=`, "-c", `filter.${name}.required=false`);
  if (args[0] === "worktree" && args[1] === "add" && args[2] === "--detach" && args.length === 5) {
    const checkout = args[3]!, revision = args[4]!;
    // Conditional gitdir includes can become active only after the new worktree exists.
    // Register it without materializing files, then inspect its own effective configuration.
    const created = await execute("git", [...fixed, "worktree", "add", "--no-checkout", "--detach", checkout, revision], options);
    try { await verificationGit(checkout, ["reset", "--hard", revision]); }
    catch (error) { await verificationGit(cwd, ["worktree", "remove", "--force", checkout]).catch(() => undefined); throw error; }
    return created.stdout;
  }
  return (await execute("git", [...fixed, ...args], options)).stdout;
}
export async function assertPinnedRevision(cwd: string, revision: string) {
  if (!/^[a-f0-9]{40}$/.test(revision) || (await verificationGit(cwd, ["rev-parse", "HEAD"])).trim() !== revision || await verificationGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])) throw new Error("Verification needs a clean worktree at the pinned revision");
}
export { parseNodeTap } from "./node-tap.js";
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
  // Canonical path: Vitest reports resolved file names (macOS /var is a symlink to /private/var) and they are matched against the checkout.
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "bflow-behavioral-"))), checkout = join(temporary, "checkout");
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
    // Seatbelt cannot mount a tmpfs, so the sandboxed process writes only to a dedicated scratch sibling of the checkout.
    if (process.platform === "darwin") { const scratch = join(temporary, "tmp"); await mkdir(scratch, { mode: 0o700 }); env["TMPDIR"] = scratch; env["HOME"] = scratch; }
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
      const failure = prepareOutcome.spawnError ?? (SANDBOX_ERROR.test(prepareOutcome.stderr) ? prepareOutcome.stderr.trim()
        : prepareOutcome.outputTruncated ? "truncated prepare output" : prepareOutcome.timedOut ? "deadline exceeded" : prepareOutcome.aborted ? "aborted" : prepareOutcome.signal ? `signal ${prepareOutcome.signal}`
        : prepareOutcome.exitCode !== 0 ? `exit ${prepareOutcome.exitCode}` : undefined);
      if (failure !== undefined) throw new Error(`Behavioral runner infrastructure failure (prepare): ${failure}${outputTail(prepareOutcome)}`);
      await assertPinnedRevision(checkout, revision);
    }
    // The official JSON reporter omits runtime errors. A fixed host companion attests its onFinished errors argument.
    const reporter = (command.reporter === "vitest_json" || command.adapter?.format === "vitest_json") ? join(temporary, "vitest-runtime-reporter.mjs") : undefined;
    if (reporter) {
      const source = await readFile(fileURLToPath(new URL("../../dist/agentic/vitest-runtime-reporter.js", import.meta.url)), "utf8");
      // A standalone immutable copy avoids exposing the host source tree just to
      // satisfy Vite's optional source-map reads inside the empty namespace.
      await writeFile(reporter, source.replace(/^\/\/# sourceMappingURL=.*$/gm, ""), { mode: 0o600 });
    }
    if (invocation?.reportPaths?.length && (await collectRunnerReports(invocation.reportPaths, checkout, reportDirectory)).length) throw new Error("Behavioral report must not exist before the test command");
    const baseArgs = invocation?.args ?? command.args;
    const args = reporter ? [...baseArgs, `--reporter=${reporter}`] : baseArgs;
    const sandbox = await sandboxBehavior(command, checkout, args, reporter).catch(error => {
      throw new Error(`Behavioral runner infrastructure failure (sandbox preparation): ${String(error)}`, { cause: error });
    });
    const result = await runner.run({ ...sandbox, cwd: projectCwd, env, timeoutMs: command.timeoutMs, maxOutputBytes });
    if (!result.ok) throw new Error(`Behavioral command invocation failed: ${result.error.message}`);
    const outcome = result.value as QualityCommandOutcome;
    if (SANDBOX_ERROR.test(outcome.stderr)) throw new Error(`Behavioral sandbox failed: ${outcome.stderr.trim()}`);
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
