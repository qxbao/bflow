import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { QualityGateDefinitionSchema, type ArtifactReference, type AgentRole, type JsonValue, type QualityGateDefinition } from "@bflow/contracts";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { json, record, textField } from "./journal.js";
import { BehavioralIdentityMismatch, NodeTapTestCodeFailure, parseNodeTap } from "./node-tap.js";
import { parseVitestJson } from "./vitest-json.js";
import { assertCheckoutDependencyRoot, sandboxBehavior } from "./behavioral-sandbox.js";
import type { AdapterRunner } from "./runner-adapter.js";
import { parseRunnerResult } from "./runner-results.js";
import { collectRunnerReports } from "./runner-reports.js";
import { assertRunnerProvenance } from "./runner-provenance.js";
import {
  parseRegressionResult,
  RegressionInfrastructureFailure,
  type RegressionObservation
} from "./regression-results.js";

export {
  parseRegressionResult,
  RegressionInfrastructureFailure,
  type RegressionFailure,
  type RegressionObservation
} from "./regression-results.js";

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
export type RegressionCommand = Omit<BoundBehavioralCommand, "testNames"> & { testNames: []; selection: "regression" };
export function bindRegressionProfile(profile: RunnerProfile, testPaths: string[], timeoutMs: number): RegressionCommand {
  if (profile.source !== "detected") throw new Error("Runner profiles must be Runtime-detected");
  if (profile.adapter !== undefined) throw new Error("Regression profile binding does not support adapter profiles");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(profile.id) || profile.command.length === 0 || profile.executable.includes("\0") || !isAbsolute(profile.executable)) throw new Error("Runner profile executable must be absolute and id must be safe");
  if (!["unit_test", "integration_test", "e2e_test"].includes(profile.method)) throw new Error("Unsupported behavioral method");
  const levels = strings(profile.levels, "levels") as BehavioralCommand["levels"];
  if (levels.some(level => !permittedLevels[profile.method].includes(level))) throw new Error("Behavioral test levels do not match method");
  if (profile.reporter !== "node_tap" && profile.reporter !== "vitest_json") throw new Error("Unsupported behavioral reporter");
  const args = strings(profile.args, "argv", false);
  const paths = strings(testPaths, "test paths");
  assertTestIdentities([], paths);
  if (paths.some(path => !testFilePattern.test(path))) throw new Error("Behavioral test paths must be committed test files");
  const checkoutDependencyRoots = strings(profile.checkoutDependencyRoots, "checkout dependency roots", false);
  for (const path of checkoutDependencyRoots) assertCheckoutDependencyRoot(path);
  if (!isAbsolute(profile.dependencySource) || profile.dependencySource.includes("\0")) throw new Error("Behavioral dependency source must be an absolute repository path");
  assertExecutionBounds(profile.timeoutMs, profile.maxOutputBytes);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 540_000) throw new Error("Invalid regression execution bounds");
  if (profile.prepare !== undefined) assertExecutionBounds(profile.prepare.timeoutMs, undefined);
  return {
    id: profile.id, command: profile.command, executable: profile.executable, args: [...args, ...paths],
    method: profile.method, levels, testNames: [], testPaths: paths, selection: "regression",
    reporter: profile.reporter, timeoutMs,
    ...(profile.maxOutputBytes === undefined ? {} : { maxOutputBytes: profile.maxOutputBytes }),
    checkoutDependencyRoots, dependencySource: profile.dependencySource,
    ...(profile.definitionBlobs ? { definitionBlobs: Object.fromEntries(Object.entries(profile.definitionBlobs).filter(([path]) => !paths.includes(path))) } : {}),
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
/**
 * `input` feeds stdin (for `hash-object --stdin`); `indexFile` points GIT_INDEX_FILE at a private scratch index so
 * callers can build trees without touching the repository's own index. Both are applied after the sanitized env.
 */
export async function verificationGit(cwd: string, args: string[], extra: { readonly input?: string; readonly indexFile?: string } = {}): Promise<string> {
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
  const runOptions = extra.indexFile === undefined ? options : { ...options, env: { ...env, GIT_INDEX_FILE: extra.indexFile } };
  if (extra.input === undefined) return (await execute("git", [...fixed, ...args], runOptions)).stdout;
  return new Promise<string>((resolve, reject) => {
    const child = execFile("git", [...fixed, ...args], runOptions, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
    // A broken pipe means git exited early; its exit status is the authoritative failure.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(extra.input);
  });
}
export async function assertPinnedRevision(cwd: string, revision: string) {
  if (!/^[a-f0-9]{40}$/.test(revision) || (await verificationGit(cwd, ["rev-parse", "HEAD"])).trim() !== revision || await verificationGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"])) throw new Error("Verification needs a clean worktree at the pinned revision");
}
export { parseNodeTap } from "./node-tap.js";
export interface BehavioralMeasurement {
  sourceRevision: string; command: string; commandId: string; method: BehavioralCommand["method"];
  testBlobs: Record<string, string>; testNames: string[]; testResults: { name: string; passed: boolean }[]; tests: number; passed: number; failed: number; targetFailure: boolean;
  outcome: QualityCommandOutcome;
  /** Optional context-only summary. Parser/gates always consume `outcome` raw bytes. */
  rtk?: { status: "compressed" | "passthrough" | "degraded"; executablePath: string; version: string; digest: string; filter: string;
    invocationId?: string;
    args: string[]; compressedOutput?: string; reasonCode?: string };
}
export interface RtkOutputRequest {
  readonly executablePath: string;
  readonly version: string;
  readonly digest: string;
  /** Exact approved runner profile ID, passed as RTK's filter name without shell parsing. */
  readonly filter: string;
  readonly required: boolean;
  readonly invocationId?: string;
  readonly onIntent?: () => Promise<void>;
  readonly onUnavailable?: (reasonCode: string) => Promise<void>;
  readonly onResult?: (result: { readonly status: "completed" | "failed"; readonly reasonCode?: string }) => Promise<void>;
}
export interface RtkOutputIntegration {
  readonly resolve: (input: { role: AgentRole; runId: string; taskId?: string; attemptId?: string; commandId: string; revision: string }) => Promise<RtkOutputRequest | undefined>;
  readonly consume: (invocationId: string, evidence: ArtifactReference) => Promise<void>;
}
export class RtkRequiredToolUnavailable extends Error {
  constructor(readonly reasonCode: string, message: string, readonly originalOutcome?: QualityCommandOutcome, readonly rawOutput?: string) {
    super(message); this.name = "RtkRequiredToolUnavailable";
  }
}
type SandboxedProcessResult = { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null;
  readonly stdout: string; readonly stderr: string; readonly timedOut: boolean; readonly truncated: boolean };
const RTK_FORMAT_TIMEOUT_MS = 5_000;
const RTK_FORMAT_MAX_BYTES = 262_144;

async function runSandboxedInput(sandbox: { executable: string; args: string[] }, childArgs: readonly string[], cwd: string,
  env: Readonly<Record<string, string>>, input: string): Promise<SandboxedProcessResult> {
  const separator = sandbox.args.lastIndexOf("--");
  if (separator < 0 || typeof sandbox.args[separator + 1] !== "string") throw new Error("RTK sandbox command is malformed");
  const args = [...sandbox.args.slice(0, separator + 1), sandbox.args[separator + 1]!, ...childArgs];
  return new Promise(resolve => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), truncated = false, timedOut = false, settled = false;
    const child = spawn(sandbox.executable, args, { cwd, env: { ...env }, shell: false, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, RTK_FORMAT_TIMEOUT_MS);
    const terminate = () => {
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* fall through */ }
      }
      child.kill("SIGKILL");
    };
    const take = (prior: Buffer, chunk: Buffer) => {
      const size = prior.length + chunk.length;
      if (size > RTK_FORMAT_MAX_BYTES) { truncated = true; terminate(); }
      return Buffer.concat([prior, chunk.subarray(0, Math.max(0, RTK_FORMAT_MAX_BYTES - prior.length))]);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = take(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = take(stderr, chunk); });
    child.once("error", error => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ exitCode: null, signal: null, stdout: "", stderr: error.name, timedOut: false, truncated: false });
    });
    child.once("close", (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut, truncated });
    });
    child.stdin.once("error", () => { /* closed stdin is reflected by the child's exit status */ });
    child.stdin.end(input);
  });
}

async function prepareRtk(command: BoundBehavioralCommand, checkout: string, request: RtkOutputRequest): Promise<{
  readonly sandbox: { executable: string; args: string[] }; readonly cwd: string; readonly env: Record<string, string>; readonly args: string[];
}> {
  if (!isAbsolute(request.executablePath) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.version) ||
      !/^[a-f0-9]{64}$/.test(request.digest) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.filter))
    throw new RtkRequiredToolUnavailable("rtk_identity_invalid", "RTK identity or profile filter is invalid");
  const info = await lstat(request.executablePath).catch(() => undefined);
  if (!info) throw new RtkRequiredToolUnavailable("rtk_binary_unavailable", "Pinned RTK executable is absent");
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || await realpath(request.executablePath) !== request.executablePath)
    throw new RtkRequiredToolUnavailable("rtk_binary_unavailable", "Pinned RTK executable is not a canonical regular file");
  const bytes = await readFile(request.executablePath);
  if (createHash("sha256").update(bytes).digest("hex") !== request.digest)
    throw new RtkRequiredToolUnavailable("rtk_binary_drift", "Pinned RTK executable digest changed");
  const cwd = join(checkout, ".bflow-rtk-scratch");
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const sandboxExecutable = join(cwd, "rtk");
  await writeFile(sandboxExecutable, bytes, { flag: "wx", mode: 0o700 });
  if (createHash("sha256").update(await readFile(sandboxExecutable)).digest("hex") !== request.digest)
    throw new RtkRequiredToolUnavailable("rtk_binary_copy_drift", "Pinned RTK scratch copy failed its digest check");
  const config = join(cwd, "config"), data = join(cwd, "data"), cache = join(cwd, "cache");
  await Promise.all([config, data, cache].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  const env = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: cwd,
    TMPDIR: cwd, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_CACHE_HOME: cache };
  const formatter: BoundBehavioralCommand = { id: `rtk-${command.id}`, command: "rtk pipe", executable: sandboxExecutable,
    args: [], method: command.method, levels: command.levels, testNames: command.testNames, testPaths: command.testPaths,
    timeoutMs: RTK_FORMAT_TIMEOUT_MS, checkoutDependencyRoots: [], dependencySource: cwd };
  const sandbox = await sandboxBehavior(formatter, cwd, []);
  const version = await runSandboxedInput(sandbox, ["--version"], cwd, env, "");
  if (version.exitCode !== 0 || !version.stdout.includes(request.version))
    throw new RtkRequiredToolUnavailable("rtk_version_mismatch", `Pinned RTK version probe failed (exit=${String(version.exitCode)}, signal=${String(version.signal)}, timedOut=${version.timedOut})`);
  const help = await runSandboxedInput(sandbox, ["pipe", "--help"], cwd, env, "");
  if (help.exitCode !== 0 || !/stdin/i.test(help.stdout) || !help.stdout.includes("--filter"))
    throw new RtkRequiredToolUnavailable("rtk_stdin_filter_unsupported", "Pinned RTK does not expose a supported stdin filter");
  const sample = "RTK probe line\nRTK probe line\n";
  const args = request.filter === "auto" ? ["pipe"] : ["pipe", "--filter", request.filter];
  const probe = await runSandboxedInput(sandbox, args, cwd, env, sample);
  if (probe.exitCode !== 0 || probe.timedOut || probe.truncated || !probe.stdout.trim())
    throw new RtkRequiredToolUnavailable("rtk_filter_unavailable", "Pinned RTK filter failed its bounded stdin probe");
  return { sandbox, cwd, env, args };
}
/** Bounded diagnostic tail for a failed prepare step. */
function outputTail(outcome: QualityCommandOutcome): string {
  const stderr = outcome.stderr.trim().slice(-1_000), stdout = outcome.stdout.trim().slice(-1_000);
  return [stderr ? `stderr: ${stderr}` : "", stdout ? `stdout: ${stdout}` : ""].filter(Boolean).map(part => ` ${part}`).join("");
}
export interface RegressionMeasurement {
  sourceRevision: string; commandId: string; testBlobs: Record<string, string>;
  observation: RegressionObservation; outcome: QualityCommandOutcome;
}
async function runMeasurementCommand(command: BoundBehavioralCommand, cwd: string, revision: string,
  options: { readonly rtk?: RtkOutputRequest } = {}): Promise<{
  outcome: QualityCommandOutcome; testBlobs: Record<string, string>; checkout: string;
  reports?: Awaited<ReturnType<typeof collectRunnerReports>>; rtk?: BehavioralMeasurement["rtk"];
}> {
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
  let added = false, rtkIntentOpen = false, rtkSettled = false;
  try {
    await verificationGit(cwd, ["worktree", "add", "--detach", checkout, revision]); added = true;
    let rtkContext: Awaited<ReturnType<typeof prepareRtk>> | undefined;
    let rtkResult: BehavioralMeasurement["rtk"];
    if (options.rtk) {
      const rtkWorkspace = join(temporary, "rtk-workspace");
      await mkdir(rtkWorkspace, { mode: 0o700 });
      try { rtkContext = await prepareRtk(command, rtkWorkspace, options.rtk); }
      catch (error) {
        const reasonCode = error instanceof RtkRequiredToolUnavailable ? error.reasonCode : "rtk_probe_failed";
        await options.rtk.onUnavailable?.(reasonCode);
        if (options.rtk.required) {
          if (error instanceof RtkRequiredToolUnavailable) throw error;
          throw new RtkRequiredToolUnavailable("rtk_probe_failed", "Pinned RTK could not be safely probed before the command");
        }
        rtkResult = { status: "degraded", executablePath: options.rtk.executablePath, version: options.rtk.version,
          digest: options.rtk.digest, filter: options.rtk.filter,
          args: ["pipe", "--filter", options.rtk.filter], ...(options.rtk.invocationId ? { invocationId: options.rtk.invocationId } : {}), reasonCode };
      }
    }
    if (rtkContext && options.rtk?.onIntent) {
      try { await options.rtk.onIntent(); rtkIntentOpen = true; }
      catch { throw new RtkRequiredToolUnavailable("rtk_usage_intent_failed", "RTK invocation intent could not be stored before running the command"); }
    }
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
    if (options.rtk && rtkContext) {
      const raw = outcome.stdout + (outcome.stderr ? `\n[stderr]\n${outcome.stderr}` : "");
      try {
        const formatted = await runSandboxedInput(rtkContext.sandbox, rtkContext.args, rtkContext.cwd, rtkContext.env, raw);
        const compressed = formatted.exitCode === 0 && formatted.signal === null && !formatted.timedOut && !formatted.truncated && !!formatted.stdout.trim();
        const reasonCode = formatted.timedOut ? "rtk_timeout" : formatted.truncated ? "rtk_output_truncated" : "rtk_filter_failed";
        let resultRecorded = true;
        try {
          if (options.rtk.onResult) { rtkSettled = true; await options.rtk.onResult(compressed ? { status: "completed" } : { status: "failed", reasonCode }); }
        }
        catch { resultRecorded = false; }
        rtkResult = compressed && resultRecorded
          ? { status: Buffer.byteLength(formatted.stdout) < Buffer.byteLength(raw) ? "compressed" : "passthrough", executablePath: options.rtk.executablePath, version: options.rtk.version, digest: options.rtk.digest,
              filter: options.rtk.filter, args: [...rtkContext.args], ...(options.rtk.invocationId ? { invocationId: options.rtk.invocationId } : {}), compressedOutput: formatted.stdout }
          : { status: "degraded", executablePath: options.rtk.executablePath, version: options.rtk.version, digest: options.rtk.digest,
              filter: options.rtk.filter, args: [...rtkContext.args], ...(options.rtk.invocationId ? { invocationId: options.rtk.invocationId } : {}),
              reasonCode: resultRecorded ? reasonCode : "rtk_usage_result_failed" };
        if (options.rtk.required && (!compressed || !resultRecorded))
          throw new RtkRequiredToolUnavailable(resultRecorded ? reasonCode : "rtk_usage_result_failed",
            "Required RTK formatting failed after the original command; raw command evidence was retained", outcome, raw);
      } catch {
        if (options.rtk.required) {
          const raw = outcome.stdout + (outcome.stderr ? `\n[stderr]\n${outcome.stderr}` : "");
          throw new RtkRequiredToolUnavailable("rtk_filter_failed",
            "Required RTK formatting failed after the original command; raw command evidence was retained", outcome, raw);
        }
        if (options.rtk.onResult) {
          rtkSettled = true;
          await options.rtk.onResult({ status: "failed", reasonCode: "rtk_filter_failed" }).catch(() => undefined);
        }
        rtkResult = { status: "degraded", executablePath: options.rtk.executablePath, version: options.rtk.version, digest: options.rtk.digest,
          filter: options.rtk.filter, args: [...rtkContext.args], ...(options.rtk.invocationId ? { invocationId: options.rtk.invocationId } : {}), reasonCode: "rtk_filter_failed" };
      }
    }
    // Tracked files must match the revision and no non-ignored untracked file may exist. Prepared checkouts may also hold
    // git-ignored outputs (build output, dependency mountpoints), so only owner commands keep the strict ignored-file check.
    await assertPinnedRevision(checkout, revision);
    const relaxed = command.prepare !== undefined || command.checkoutDependencyRoots !== undefined;
    if (!relaxed && await verificationGit(checkout, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all", "-z"])) throw new Error("Behavioral execution generated files outside the committed revision");
    await assertPinnedRevision(cwd, revision);
    const reports = invocation?.reportPaths ? await collectRunnerReports(invocation.reportPaths, checkout, reportDirectory) : undefined;
    return { outcome, testBlobs, checkout, ...(reports ? { reports } : {}), ...(rtkResult ? { rtk: rtkResult } : {}) };
  } finally {
    if (rtkIntentOpen && !rtkSettled && options.rtk?.onResult) {
      rtkSettled = true;
      await options.rtk.onResult({ status: "failed", reasonCode: "runner_aborted_before_rtk_result" }).catch(() => undefined);
    }
    if (added) await verificationGit(cwd, ["worktree", "remove", "--force", checkout]);
    await rm(temporary, { recursive: true, force: true });
  }
}
/** Parser failure that keeps the original message and carries bounded, JSON-safe runner evidence for audit and Conversation. */
export class BehavioralMeasurementError extends Error {
  constructor(readonly original: unknown, readonly diagnostics: JsonValue) { super(original instanceof Error ? original.message : String(original)); }
}
export function measurementDiagnostics(command: { readonly command: string; readonly testNames: readonly string[] }, outcome: QualityCommandOutcome, error: unknown): JsonValue {
  const bounded = (values: readonly string[]) => values.slice(0, 100).map(value => value.slice(0, 200));
  return json({ command: command.command, cwd: outcome.cwd, exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut,
    stdoutTail: outcome.stdout.slice(-4096), stderrTail: outcome.stderr.slice(-4096), expectedNames: bounded(command.testNames),
    ...(error instanceof BehavioralIdentityMismatch ? { observedNames: bounded(error.observedNames) } : {}) });
}
/** Runs only committed bytes in a new detached worktree; it has no host credentials or inherited Node/Git overrides. */
export async function measureBehavior(command: BoundBehavioralCommand, cwd: string, revision: string,
  options: { readonly rtk?: RtkOutputRequest } = {}): Promise<BehavioralMeasurement> {
  const { outcome, testBlobs, reports, rtk: rtkResult } = await runMeasurementCommand(command, cwd, revision, options);
  let parsed: ReturnType<typeof parseNodeTap> | ReturnType<typeof parseVitestJson>;
  try {
    parsed = command.adapter ? parseRunnerResult(command.adapter.format, outcome, command.testNames, reports, command.adapter.failureExitCodes, command.testPaths)
      : command.reporter === "vitest_json" ? parseVitestJson(outcome, command.testNames, command.checkoutDependencyRoots !== undefined) : parseNodeTap(outcome, command.testNames, command.checkoutDependencyRoots !== undefined, command.testPaths);
  } catch (error) {
    if (error instanceof NodeTapTestCodeFailure) {
      if (rtkResult) throw new NodeTapTestCodeFailure(error.outcome, error.failedTestNames, rtkResult);
      throw error;
    }
    throw new BehavioralMeasurementError(error, measurementDiagnostics(command, outcome, error));
  }
  return { sourceRevision: revision, command: command.command, commandId: command.id, method: command.method, testBlobs, ...parsed, outcome,
    ...(rtkResult ? { rtk: rtkResult } : {}) };
}
export async function measureRegression(command: RegressionCommand, cwd: string, revision: string): Promise<RegressionMeasurement> {
  let run: Awaited<ReturnType<typeof runMeasurementCommand>>;
  try {
    run = await runMeasurementCommand(command, cwd, revision);
  } catch (error) {
    if (error instanceof RegressionInfrastructureFailure) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new RegressionInfrastructureFailure(
      message.includes("deadline exceeded") ? `regression_budget_exceeded: ${message}` : message,
      error instanceof Error ? { cause: error } : undefined
    );
  }
  const observation = parseRegressionResult(run.outcome, command.reporter ?? "node_tap", run.checkout);
  return {
    sourceRevision: revision,
    commandId: command.id,
    testBlobs: run.testBlobs,
    observation,
    outcome: run.outcome
  };
}
