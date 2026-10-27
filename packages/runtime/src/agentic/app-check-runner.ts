import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { JsonValueSchema } from "@bflow/contracts";
import type { AppCheck, AppCheckSuite } from "./app-check-config.js";
import { AppCheckBrowserLeases, AppCheckLeaseLockTimeout, type AppCheckLease } from "./app-check-lease.js";
import { assertPinnedRevision, verificationGit } from "./behavioral-runner.js";
import { probeBehavioralSandbox } from "./sandbox-readiness.js";
import { validateDependencyTrees } from "./behavioral-sandbox.js";

/**
 * Runs one owner real-app suite against a committed revision inside the Linux Bubblewrap sandbox. The app is started by
 * the owner argv from a private checkout of the revision (never from the developer worktree); UI checks run in a headless
 * Chrome that the driver controls over CDP pipes. Nothing is faked: a missing prerequisite returns a `blocked` outcome
 * with a prerequisite code and launches nothing.
 *
 * Driver location: the compiled driver is `dist/agentic/app-check-driver.js`. The same relative path
 * `../../dist/agentic/app-check-driver.js` resolves from both `src/agentic/` (vitest) and `dist/agentic/` (runtime),
 * so no build-time variable is needed. Tests build the package first; a missing driver is reported as blocked.
 */

export const APP_CHECK_BLOCK_CODES = [
  "app_check_platform_unsupported", "app_check_sandbox_unavailable", "app_check_app_missing", "app_check_dependency_missing",
  "app_check_browser_missing", "app_check_source_not_pinned", "app_check_driver_failed", "app_check_browser_busy",
  "app_check_browser_lease_lost", "app_check_browser_lease_expired", "app_check_timeout"
] as const;
export type AppCheckBlockCode = (typeof APP_CHECK_BLOCK_CODES)[number];

export interface AppCheckBlocked {
  readonly status: "blocked";
  readonly code: AppCheckBlockCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly holder?: string;
  readonly expiresAt?: string;
}

export interface AppCheckFinding {
  readonly checkId?: string;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, string | number | boolean | null>;
}

export interface AppCheckRunCompleted {
  readonly status: "completed";
  /** True only when the app became ready and every selected check has zero findings. */
  readonly passed: boolean;
  readonly appReady: boolean;
  readonly findings: AppCheckFinding[];
  readonly driver: AppCheckDriverResult;
  readonly selectedCheckIds: string[];
  readonly checkoutTree: string;
  readonly command: { readonly executable: string; readonly args: string[] };
  readonly envKeys: string[];
  readonly envDigest: string;
  readonly driverSha256: string;
  readonly lease?: { readonly leaseId: string; readonly resourceKey: string; readonly fencingToken: number; readonly acquiredAt: string; readonly expiresAt: string };
  readonly browserVersion?: string;
  readonly screenshots: { readonly checkId: string; readonly png: Buffer }[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

export type AppSuiteRun = AppCheckBlocked | AppCheckRunCompleted;

export interface RunAppSuiteOptions {
  /** Source repository whose committed `revision` is served; it must be clean and pinned to the revision. */
  readonly repository: string;
  readonly revision: string;
  readonly suite: AppCheckSuite;
  /** Subset of check ids to run; defaults to every check in the suite. */
  readonly checkIds?: readonly string[];
  /** Required when the selection contains UI checks. */
  readonly leases?: AppCheckBrowserLeases;
  readonly holder?: string;
  readonly driverPath?: string;
  /** Hard deadline for the sandboxed run; defaults to the suite timeout. Tests lower it to exercise the kill path. */
  readonly deadlineMs?: number;
  /** Lease renewal period; defaults to min(30 s, ttl/3). Tests lower it to observe lease loss mid-run. */
  readonly renewIntervalMs?: number;
}

const DEFAULT_DRIVER = fileURLToPath(new URL("../../dist/agentic/app-check-driver.js", import.meta.url));
const SCREENSHOT_LIMIT = 5 * 1024 * 1024;
const TAIL = 2048;
const LEASE_RENEW_MAX_MS = 30_000;
const LEASE_TAIL_MS = 30_000;

const nowIso = () => new Date().toISOString();
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 3)}...` : text;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CheckResultSchema = z.object({
  checkId: z.string().regex(SAFE_ID),
  kind: z.enum(["ui", "api"]),
  status: z.enum(["passed", "failed"]),
  startedAt: z.string().max(64),
  finishedAt: z.string().max(64),
  findings: z.array(z.object({
    code: z.string().min(1).max(64),
    message: z.string().max(2048),
    details: z.record(z.union([z.string().max(512), z.number(), z.boolean(), z.null()])).optional()
  }).strict()).max(50),
  observations: z.record(JsonValueSchema),
  screenshot: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/).optional()
}).strict();
/** Strict ingress schema for the driver's result file; the driver is a separate process and is never trusted blindly. */
export const AppCheckDriverResultSchema = z.object({
  schemaVersion: z.literal(1),
  instanceId: z.string().uuid(),
  origin: z.string().max(256),
  appReady: z.boolean(),
  appExit: z.object({ code: z.number().int().nullable(), signal: z.string().max(32).nullable() }).strict().optional(),
  appStdoutTail: z.string().max(8192),
  appStderrTail: z.string().max(8192),
  notReadyReason: z.enum(["app_exited", "app_not_ready"]).optional(),
  readyAt: z.string().max(64).optional(),
  browserReady: z.boolean().optional(),
  browserVersion: z.string().max(256).optional(),
  browserFailure: z.string().max(2048).optional(),
  startedAt: z.string().max(64),
  finishedAt: z.string().max(64),
  checks: z.array(CheckResultSchema).max(50),
  driverError: z.string().max(2048).optional()
}).strict();
export type AppCheckDriverResult = z.infer<typeof AppCheckDriverResultSchema>;

interface PlanFile {
  readonly schemaVersion: 1;
  readonly checkout: string;
  readonly port: number;
  readonly app: { readonly executable: string; readonly args: string[]; readonly env: Record<string, string>; readonly readyPath: string; readonly startTimeoutMs: number };
  readonly contract?: { readonly path: string };
  readonly browser?: { readonly executable: string };
  readonly checks: AppCheck[];
}

const blocked = (code: AppCheckBlockCode, message: string, extra: { holder?: string; expiresAt?: string } = {}): AppCheckBlocked =>
  ({ status: "blocked", code, message: clip(message, 2048), retryable: code === "app_check_browser_busy", ...extra });

function selectChecks(suite: AppCheckSuite, checkIds: readonly string[] | undefined): AppCheck[] {
  if (checkIds === undefined) return suite.checks;
  const unknown = checkIds.filter(id => !suite.checks.some(check => check.id === id));
  if (unknown.length > 0) throw new Error(`unknown real-app check ${unknown.join(", ")} in suite ${suite.id}`);
  const selected = suite.checks.filter(check => checkIds.includes(check.id));
  if (selected.length === 0) throw new Error(`no real-app checks selected in suite ${suite.id}`);
  return selected;
}

async function executableReal(path: string): Promise<string | undefined> {
  try {
    const real = await realpath(path);
    await access(real, constants.X_OK);
    return real;
  } catch { return undefined; }
}

async function canonicalDirectory(path: string): Promise<boolean> {
  try { return (await lstat(path)).isDirectory() && await realpath(path) === path; }
  catch { return false; }
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

/** Node resolves the module type from the nearest package.json; the sandbox must expose that file for the driver to load as ESM. */
async function nearestPackageJson(file: string): Promise<string | undefined> {
  let directory = dirname(file);
  for (;;) {
    const candidate = join(directory, "package.json");
    if (await exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Bubblewrap arguments modeled on sandboxBehavior: empty namespace, committed checkout, read-only app/driver/browser trees. */
async function sandboxArguments(input: {
  checkout: string; planPath: string; resultDirectory: string; driverFile: string; nodeFile: string; appFile: string;
  suite: AppCheckSuite; browserDirectory?: string;
}): Promise<string[]> {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/dev/shm"];
  if (await exists("/etc/hosts")) args.push("--ro-bind", "/etc/hosts", "/etc/hosts");
  if (await exists("/etc/fonts")) args.push("--ro-bind", "/etc/fonts", "/etc/fonts");
  args.push("--dir", "/tmp/bflow-home", "--bind", input.checkout, input.checkout, "--chdir", input.checkout);
  const mounted = new Set<string>();
  const bindReadOnly = (source: string, target: string) => {
    if (mounted.has(target) || target.startsWith("/usr/")) return;
    mounted.add(target);
    args.push("--ro-bind", source, target);
  };
  bindReadOnly(input.nodeFile, process.execPath);
  bindReadOnly(input.driverFile, input.driverFile);
  const packageJson = await nearestPackageJson(input.driverFile);
  if (packageJson) bindReadOnly(packageJson, packageJson);
  bindReadOnly(input.appFile, input.suite.app.executable);
  // Dependency roots keep their absolute host paths; the owner's app.env (for example NODE_PATH) must point at them.
  for (const root of input.suite.app.dependencyRoots) bindReadOnly(root, root);
  if (input.browserDirectory) bindReadOnly(input.browserDirectory, input.browserDirectory);
  args.push("--bind", input.resultDirectory, input.resultDirectory, "--ro-bind", input.planPath, input.planPath);
  args.push("--", process.execPath, input.driverFile, input.planPath, join(input.resultDirectory, "result.json"));
  return args;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch { /* group already gone */ }
}

/**
 * Runs one owner real-app suite. Preflight (platform, sandbox, app, dependencies, browser, pinned source) happens before
 * any checkout, lease or process is created. The checkout, temp directory, lease and sandbox are always cleaned up.
 */
export async function runAppSuite(options: RunAppSuiteOptions): Promise<AppSuiteRun> {
  const startedAt = nowIso();
  if (!/^[a-f0-9]{40}$/.test(options.revision)) throw new Error("Real-app check revision must be a full commit identity");
  const suite = options.suite;
  const selected = selectChecks(suite, options.checkIds);
  const uiSelected = selected.some(check => check.kind === "ui");
  const driverFile = await realpath(options.driverPath ?? DEFAULT_DRIVER).catch(() => undefined);

  // Preflight: each failure returns a prerequisite code before anything is launched.
  if (process.platform !== "linux") return blocked("app_check_platform_unsupported", `Real-app checks require Linux; this host is ${process.platform}`);
  const sandbox = await probeBehavioralSandbox(options.repository);
  if (sandbox.status !== "ready") return blocked("app_check_sandbox_unavailable", sandbox.reason);
  const appFile = await executableReal(suite.app.executable);
  if (!appFile) return blocked("app_check_app_missing", `app executable ${suite.app.executable} is missing or not executable`);
  for (const root of suite.app.dependencyRoots) {
    if (!(await canonicalDirectory(root))) return blocked("app_check_dependency_missing", `dependency root ${root} is missing or not a canonical directory`);
  }
  // Same inspection as the behavioral sandbox: no credential material, special files, or symlinks that escape the trees.
  try { await validateDependencyTrees(suite.app.dependencyRoots, options.repository); }
  catch (error) { return blocked("app_check_dependency_missing", `dependency trees failed inspection: ${(error as Error).message}`); }
  let browserFile: string | undefined;
  if (uiSelected && suite.browser) {
    browserFile = await executableReal(suite.browser.executable);
    if (!browserFile) return blocked("app_check_browser_missing", `browser executable ${suite.browser.executable} is missing or not executable`);
  }
  if (!driverFile) return blocked("app_check_driver_failed", "The real-app driver is not built; run pnpm --filter @bflow/runtime build");
  try { await assertPinnedRevision(options.repository, options.revision); }
  catch (error) { return blocked("app_check_source_not_pinned", `real-app checks need a clean source worktree at the pinned revision: ${(error as Error).message}`); }
  if (uiSelected && !options.leases) throw new Error("UI real-app checks require an AppCheckBrowserLeases instance");

  const temporary = await realpath(await mkdtemp(join(tmpdir(), "bflow-app-check-")));
  const checkout = join(temporary, "checkout");
  const resultDirectory = join(temporary, "result");
  let added = false;
  let lease: AppCheckLease | undefined;
  let renewTimer: NodeJS.Timeout | undefined;
  let child: ChildProcess | undefined;
  // Hoisted so that finally releases the most recent lease, not the original object after renewals.
  const current: { lease: AppCheckLease | undefined } = { lease: undefined };
  try {
    await verificationGit(options.repository, ["worktree", "add", "--detach", checkout, options.revision]);
    added = true;
    const checkoutTree = (await verificationGit(options.repository, ["rev-parse", `${options.revision}^{tree}`])).trim();
    await mkdir(resultDirectory, { mode: 0o700 });

    const ttlMs = suite.timeoutMs + LEASE_TAIL_MS;
    const leases = options.leases;
    if (uiSelected && leases && suite.browser) {
      const holder = options.holder ?? `app-check-${randomUUID()}`;
      let acquired;
      try { acquired = await leases.acquire(suite.browser.resourceKey, holder, ttlMs); }
      catch (error) {
        if (error instanceof AppCheckLeaseLockTimeout) return blocked("app_check_browser_busy", "the browser lease state is locked by another writer; retry later");
        throw error;
      }
      if (!acquired.ok) return blocked("app_check_browser_busy", `the browser resource is held by ${acquired.holder} until ${acquired.expiresAt}`,
        { holder: acquired.holder, expiresAt: acquired.expiresAt });
      lease = acquired.lease;
      current.lease = lease;
    }

    let leaseFailure: "app_check_browser_lease_lost" | "app_check_browser_lease_expired" | undefined;
    let timedOut = false;
    const abortForLease = (code: "app_check_browser_lease_lost" | "app_check_browser_lease_expired") => {
      leaseFailure ??= code;
      if (child) killGroup(child, "SIGKILL");
    };
    if (lease && leases) {
      let renewing = false;
      renewTimer = setInterval(() => {
        if (renewing || leaseFailure || !current.lease) return;
        renewing = true;
        leases.renew(current.lease, ttlMs).then(renewed => {
          if (renewed.ok) current.lease = renewed.lease;
          else abortForLease(renewed.code === "lease_expired" ? "app_check_browser_lease_expired" : "app_check_browser_lease_lost");
        }, () => abortForLease("app_check_browser_lease_lost")).finally(() => { renewing = false; });
      }, options.renewIntervalMs ?? Math.min(LEASE_RENEW_MAX_MS, Math.floor(ttlMs / 3)));
    }

    const planPath = join(temporary, "plan.json");
    const plan: PlanFile = {
      schemaVersion: 1, checkout: await realpath(checkout), port: suite.app.port,
      app: { executable: suite.app.executable, args: suite.app.args, env: suite.app.env, readyPath: suite.app.readyPath, startTimeoutMs: suite.app.startTimeoutMs },
      ...(suite.contract ? { contract: { path: suite.contract.path } } : {}),
      ...(suite.browser && uiSelected ? { browser: { executable: suite.browser.executable } } : {}),
      checks: selected
    };
    await writeFile(planPath, JSON.stringify(plan), { mode: 0o600 });

    const sandboxArgs = await sandboxArguments({
      checkout: plan.checkout, planPath, resultDirectory, driverFile, nodeFile: await realpath(process.execPath), appFile,
      suite, ...(browserFile ? { browserDirectory: dirname(browserFile) } : {})
    });
    const bwrap = sandbox.executable;
    const stderr = { text: "" };
    child = spawn(bwrap, sandboxArgs, { cwd: temporary, detached: true, stdio: ["ignore", "ignore", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "C" } });
    child.stderr?.on("data", (chunk: Buffer) => { stderr.text = clip(stderr.text + chunk.toString("utf8"), TAIL); });
    const sandboxed = child;
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | "error">(resolve => {
      const timer = setTimeout(() => { timedOut = true; killGroup(sandboxed, "SIGKILL"); }, options.deadlineMs ?? suite.timeoutMs);
      sandboxed.on("error", () => { clearTimeout(timer); resolve("error"); });
      sandboxed.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    if (renewTimer) { clearInterval(renewTimer); renewTimer = undefined; }
    if (exit === "error") return blocked("app_check_driver_failed", `the sandbox could not be started: ${stderr.text}`);
    if (timedOut) return blocked("app_check_timeout", `real-app checks exceeded ${options.deadlineMs ?? suite.timeoutMs} ms and were killed`);
    if (leaseFailure) return blocked(leaseFailure, "the browser lease was lost while the checks were running; results were discarded");
    if (current.lease && leases) {
      const confirmed = await leases.assertCurrent(current.lease);
      if (!confirmed.ok) return blocked(confirmed.code === "lease_expired" ? "app_check_browser_lease_expired" : "app_check_browser_lease_lost",
        "the browser lease is no longer current; results were discarded");
    }

    let driver: AppCheckDriverResult;
    try {
      const raw = JSON.parse(await readFile(join(resultDirectory, "result.json"), "utf8")) as unknown;
      const parsed = AppCheckDriverResultSchema.safeParse(raw);
      if (!parsed.success) return blocked("app_check_driver_failed", "the driver result failed strict validation");
      driver = parsed.data;
    } catch {
      return blocked("app_check_driver_failed", `the driver produced no result: ${stderr.text}`);
    }
    if (driver.driverError) return blocked("app_check_driver_failed", `the driver failed: ${driver.driverError}`);
    if (uiSelected && driver.browserReady === false) return blocked("app_check_browser_missing", `the browser did not start: ${driver.browserFailure ?? "unknown"}`);
    // The reported set must equal the selected set exactly: no unselected, duplicate or missing check results.
    const reported = driver.checks.map(result => result.checkId);
    const exact = new Set(reported).size === reported.length && reported.length === selected.length && selected.every(check => reported.includes(check.id));
    if (driver.appReady ? !exact : reported.length > 0)
      return blocked("app_check_driver_failed", driver.appReady ? "the driver must report exactly the selected checks, once each"
        : "a driver result for an app that did not become ready must not carry check results");

    const findings: AppCheckFinding[] = [];
    if (!driver.appReady) findings.push({ code: driver.notReadyReason ?? "app_not_ready", message: `the candidate app did not become ready at ${suite.app.readyPath}`,
      details: { stderr: clip(driver.appStderrTail, 512) } });
    for (const result of driver.checks) {
      for (const finding of result.findings) findings.push({ checkId: result.checkId, code: finding.code, message: finding.message, ...(finding.details ? { details: finding.details } : {}) });
    }
    const screenshots: { checkId: string; png: Buffer }[] = [];
    for (const result of driver.checks) {
      if (!result.screenshot) continue;
      const file = join(resultDirectory, result.screenshot);
      try {
        const info = await stat(file);
        if (info.isFile() && info.size <= SCREENSHOT_LIMIT) screenshots.push({ checkId: result.checkId, png: await readFile(file) });
      } catch { /* screenshot absent; it never affects pass/fail */ }
    }
    const passed = driver.appReady && selected.every(check => driver.checks.find(result => result.checkId === check.id)?.status === "passed");
    const envEntries = Object.entries(suite.app.env).sort(([a], [b]) => a.localeCompare(b));
    const leaseOut = current.lease;
    return {
      status: "completed", passed, appReady: driver.appReady, findings, driver,
      selectedCheckIds: selected.map(check => check.id), checkoutTree,
      command: { executable: suite.app.executable, args: [...suite.app.args] },
      envKeys: envEntries.map(([key]) => key),
      envDigest: createHash("sha256").update(JSON.stringify(envEntries)).digest("hex"),
      driverSha256: createHash("sha256").update(await readFile(driverFile)).digest("hex"),
      ...(leaseOut ? { lease: { leaseId: leaseOut.leaseId, resourceKey: leaseOut.resourceKey, fencingToken: leaseOut.fencingToken, acquiredAt: leaseOut.acquiredAt, expiresAt: leaseOut.expiresAt } } : {}),
      ...(driver.browserVersion ? { browserVersion: driver.browserVersion } : {}),
      screenshots, startedAt, finishedAt: nowIso()
    };
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    if (child && child.exitCode === null && child.signalCode === null) killGroup(child, "SIGKILL");
    const held = current.lease;
    if (held && options.leases) await options.leases.release(held).catch(() => undefined);
    if (added) await verificationGit(options.repository, ["worktree", "remove", "--force", checkout]).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}
