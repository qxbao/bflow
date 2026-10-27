import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { parseAppChecks, type AppCheckSuite } from "../../src/agentic/app-check-config.js";
import { AppCheckBrowserLeases } from "../../src/agentic/app-check-lease.js";
import { runAppSuite, type AppSuiteRun } from "../../src/agentic/app-check-runner.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";

const execute = promisify(execFile);
const CHROME = "/opt/google/chrome/chrome";
const FIXTURE = fileURLToPath(new URL("../fixtures/app-check/server.mjs", import.meta.url));
const GIT = ["-c", "user.name=bflow-test", "-c", "user.email=test@localhost", "-c", "commit.gpgSign=false"];

/** Real prerequisites, probed on this host: Linux Bubblewrap sandbox and a Chrome that answers --version. */
const sandboxAvailable = process.platform === "linux" && (await probeBehavioralSandbox()).status === "ready";
// A real headless launch on this host (not sandboxed): Chrome must print a dumped DOM. A failed launch disables the UI tests
// visibly through skipIf; a launch that succeeds but then fails inside the sandbox fails those tests (never a silent pass).
const browserAvailable = sandboxAvailable && await execute(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
  "--user-data-dir=" + join(tmpdir(), `bflow-chrome-probe-${process.pid}`), "--dump-dom", "about:blank"], { timeout: 30_000 })
  .then(result => result.stdout.includes("<html"), () => false);

// Runner temporaries go to a private scratch directory, so the leak check below cannot see other test files' runs.
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "bflow-runner-scratch-"));
process.env.TMPDIR = scratch;
afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

let root: string;
let repo: string;
let leaseDirectory: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "bflow-app-runner-test-")));
  leaseDirectory = join(root, "leases");
  repo = join(root, "source");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
});

async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  await execute("mkdir", ["-p", repo]);
  await execute("git", ["init", "-q", repo]);
  await copyFile(FIXTURE, join(repo, "server.mjs"));
  for (const [name, content] of Object.entries(files)) await writeFile(join(repo, name), content);
  await execute("git", ["-C", repo, "add", "-A"]);
  await execute("git", ["-C", repo, ...GIT, "commit", "-q", "-m", "fixture"]);
  return (await execute("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
}

function suiteOf(mode: string, checks: unknown[], overrides: Record<string, unknown> = {}): AppCheckSuite {
  const [suite] = parseAppChecks([{
    id: "web",
    app: { executable: process.execPath, args: ["server.mjs"], port: 4173, readyPath: "/health", startTimeoutMs: 8000, env: { FIXTURE_MODE: mode }, dependencyRoots: [] },
    ...(checks.some(check => (check as { kind: string }).kind === "ui") ? { browser: { executable: CHROME, resourceKey: "app-check-browser" } } : {}),
    contract: { kind: "openapi", path: "/openapi.json" },
    timeoutMs: 60_000,
    checks,
    ...overrides
  }]);
  return suite!;
}

const homeCheck = (overrides: Record<string, unknown> = {}) => ({ id: "home", kind: "ui", path: "/",
  viewport: { width: 1280, height: 800 }, expect: { selectors: ["[data-testid=title]"], text: ["Welcome"] }, timeoutMs: 15_000, ...overrides });
const itemsCheck = (overrides: Record<string, unknown> = {}) => ({ id: "items-api", kind: "api",
  request: { method: "GET", path: "/api/items" },
  expect: { status: 200, headers: { "content-type": { contains: "application/json" } }, json: [{ pointer: "/0/name", equals: "apple" }, { pointer: "", type: "array", minItems: 1 }] },
  timeoutMs: 5000, ...overrides });

const nowIso = () => new Date().toISOString();

function completed(run: AppSuiteRun) {
  if (run.status !== "completed") throw new Error(`expected completed run, got ${run.status} ${run.status === "blocked" ? run.code + ": " + run.message : ""}`);
  return run;
}
function codes(run: AppSuiteRun): string[] {
  return run.status === "completed" ? run.findings.map(finding => finding.code) : [];
}
async function gitWorktrees(): Promise<number> {
  return (await execute("git", ["-C", repo, "worktree", "list", "--porcelain"])).stdout.split("\n").filter(line => line.startsWith("worktree ")).length;
}
async function appCheckTemporaries(): Promise<string[]> {
  return (await readdir(scratch)).filter(name => name.startsWith("bflow-app-check-")).sort();
}

describe.skipIf(!sandboxAvailable)("runAppSuite preflight and ingress (Bubblewrap sandbox)", () => {
  it("blocks a missing browser before any lease or process exists", async () => {
    const revision = await makeRepo();
    const suite = suiteOf("good", [homeCheck()], { browser: { executable: "/nonexistent/chrome", resourceKey: "app-check-browser" } });
    const run = await runAppSuite({ repository: repo, revision, suite, leases: new AppCheckBrowserLeases(leaseDirectory) });
    expect(run).toMatchObject({ status: "blocked", code: "app_check_browser_missing", retryable: false });
    expect(existsSync(join(leaseDirectory, "app-check-leases.json"))).toBe(false);
  });

  it("blocks a missing app executable", async () => {
    const revision = await makeRepo();
    const [suite] = parseAppChecks([{ id: "web", app: { executable: "/nonexistent/node", args: [], port: 4173 }, timeoutMs: 60_000, checks: [itemsCheck()] }]);
    const run = await runAppSuite({ repository: repo, revision, suite: suite! });
    expect(run).toMatchObject({ status: "blocked", code: "app_check_app_missing" });
  });

  it("blocks a dependency tree that contains credential material", async () => {
    const revision = await makeRepo();
    const dependencies = join(root, "deps", "node_modules");
    await mkdir(dependencies, { recursive: true });
    await writeFile(join(dependencies, ".npmrc"), "//registry.example/:_authToken=secret\n");
    const [suite] = parseAppChecks([{ id: "web", app: { executable: process.execPath, args: ["server.mjs"], port: 4173, dependencyRoots: [dependencies] }, timeoutMs: 60_000, checks: [itemsCheck()] }]);
    const run = await runAppSuite({ repository: repo, revision, suite: suite! });
    expect(run).toMatchObject({ status: "blocked", code: "app_check_dependency_missing" });
    expect(run.status === "blocked" && run.message).toMatch(/Credential material/);
  });

  it("blocks a missing dependency root", async () => {
    const revision = await makeRepo();
    const [suite] = parseAppChecks([{ id: "web", app: { executable: process.execPath, args: ["server.mjs"], port: 4173, dependencyRoots: ["/nonexistent/node_modules"] }, timeoutMs: 60_000, checks: [itemsCheck()] }]);
    const run = await runAppSuite({ repository: repo, revision, suite: suite! });
    expect(run).toMatchObject({ status: "blocked", code: "app_check_dependency_missing" });
  });

  it("refuses a dirty source worktree so uncommitted bytes are never the thing that gets judged", async () => {
    const revision = await makeRepo();
    const original = await readFile(join(repo, "server.mjs"), "utf8");
    await writeFile(join(repo, "server.mjs"), original.replace("apple", "uncommitted"));
    const run = await runAppSuite({ repository: repo, revision, suite: suiteOf("good", [itemsCheck()]) });
    expect(run).toMatchObject({ status: "blocked", code: "app_check_source_not_pinned" });
    expect(await gitWorktrees()).toBe(1);
  });

  it("rejects selection of an unknown check id", async () => {
    const revision = await makeRepo();
    await expect(runAppSuite({ repository: repo, revision, suite: suiteOf("good", [itemsCheck()]), checkIds: ["nope"] }))
      .rejects.toThrow(/unknown real-app check nope/);
  });

  it("blocks busy browser leases and starts nothing", async () => {
    const revision = await makeRepo();
    const leases = new AppCheckBrowserLeases(leaseDirectory);
    await leases.acquire("app-check-browser", "other-run", 600_000);
    const suite = suiteOf("good", [homeCheck()], { browser: { executable: "/usr/bin/true", resourceKey: "app-check-browser" } });
    const run = await runAppSuite({ repository: repo, revision, suite, leases, holder: "this-run" });
    expect(run).toMatchObject({ status: "blocked", code: "app_check_browser_busy", retryable: true, holder: "other-run" });
    expect(run).toMatchObject({ expiresAt: expect.stringMatching(/^\d{4}-/) });
    expect(await gitWorktrees()).toBe(1);
  });
});

/** A stand-in driver (ESM, outside the repository) that writes a fixed result; used to test host-side validation only. */
async function fakeDriver(checks: unknown[], appReady = true): Promise<string> {
  const file = join(root, "fake-driver.mjs");
  const result = { schemaVersion: 1, instanceId: randomUUID(), origin: "http://127.0.0.1:4173", appReady, appStdoutTail: "", appStderrTail: "",
    startedAt: nowIso(), finishedAt: nowIso(), checks };
  await writeFile(file, `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(process.argv[3], JSON.stringify(${JSON.stringify(result)}));
void readFileSync;\n`);
  return file;
}
const passedCheck = (checkId: string) => ({ checkId, kind: "api", status: "passed", startedAt: nowIso(), finishedAt: nowIso(), findings: [], observations: {} });

describe.skipIf(!sandboxAvailable)("runAppSuite driver result validation (Bubblewrap sandbox, fake driver)", () => {
  it("blocks a driver result that reports a check that was not selected", async () => {
    const revision = await makeRepo();
    const driverPath = await fakeDriver([passedCheck("items-api"), passedCheck("ghost")]);
    const run = await runAppSuite({ repository: repo, revision, suite: suiteOf("good", [itemsCheck()]), driverPath });
    expect(run).toMatchObject({ status: "blocked", code: "app_check_driver_failed" });
  }, 60_000);
  it("blocks a driver result that duplicates a checkId", async () => {
    const revision = await makeRepo();
    const driverPath = await fakeDriver([passedCheck("items-api"), passedCheck("items-api")]);
    const run = await runAppSuite({ repository: repo, revision, suite: suiteOf("good", [itemsCheck()]), driverPath });
    expect(run).toMatchObject({ status: "blocked", code: "app_check_driver_failed" });
  }, 60_000);
  it("blocks a not-ready result that nevertheless carries check results", async () => {
    const revision = await makeRepo();
    const driverPath = await fakeDriver([passedCheck("items-api")], false);
    const run = await runAppSuite({ repository: repo, revision, suite: suiteOf("good", [itemsCheck()]), driverPath });
    expect(run).toMatchObject({ status: "blocked", code: "app_check_driver_failed" });
  }, 60_000);
});

describe.skipIf(!sandboxAvailable)("runAppSuite API checks (Bubblewrap sandbox, no browser)", () => {
  it("passes a good API and leaves no checkout or temporary directory behind", async () => {
    const revision = await makeRepo();
    const before = await appCheckTemporaries();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("good", [itemsCheck()]) }));
    expect(run).toMatchObject({ appReady: true, passed: true, findings: [], selectedCheckIds: ["items-api"] });
    expect(run.checkoutTree).toMatch(/^[a-f0-9]{40}$/);
    expect(run.driver.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.driver.checks[0]).toMatchObject({ checkId: "items-api", kind: "api", status: "passed", observations: { status: 200 } });
    expect(run.lease).toBeUndefined();
    expect(await gitWorktrees()).toBe(1);
    expect(await appCheckTemporaries()).toEqual(before);
  }, 60_000);

  it("fails a wrong API response with a finding that points at the failing pointer", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("wrongapi", [itemsCheck()]) }));
    expect(run.passed).toBe(false);
    expect(codes(run)).toEqual(["api_assertion_failed"]);
    expect(run.findings[0]!.details?.assertion).toContain("/0/name");
  }, 60_000);

  it("reports a route that the OpenAPI contract does not declare while still executing the request", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("contractgap", [itemsCheck({ expect: { status: 200, json: [{ pointer: "/0/name", equals: "apple" }] } })]) }));
    expect(codes(run)).toEqual(["api_route_not_in_contract"]);
    expect(run.driver.checks[0]!.observations).toMatchObject({ status: 200 });
  }, 60_000);

  it("reports an unreachable contract on every API check", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("contractmissing", [itemsCheck({ expect: { status: 200, json: [{ pointer: "/0/name", equals: "apple" }] } })]) }));
    expect(codes(run)).toEqual(["api_contract_unavailable"]);
  }, 60_000);

  it("reports an app that never answers readiness as not ready, with no check results", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("wrongport", [itemsCheck()], { app: { executable: process.execPath, args: ["server.mjs"], port: 4173, readyPath: "/health", startTimeoutMs: 2000, env: { FIXTURE_MODE: "wrongport" }, dependencyRoots: [] } }) }));
    expect(run).toMatchObject({ appReady: false, passed: false });
    expect(codes(run)).toEqual(["app_not_ready"]);
    expect(run.driver.checks).toEqual([]);
  }, 60_000);

  it("reports an app that exits during startup as app_exited with its exit status", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("exit", [itemsCheck()]) }));
    expect(run.appReady).toBe(false);
    expect(codes(run)).toEqual(["app_exited"]);
    expect(run.driver.appExit).toEqual({ code: 3, signal: null });
    expect(run.driver.appStderrTail).toContain("fixture fatal startup error");
  }, 60_000);

  it("kills a run that exceeds the hard deadline and leaves no process behind", async () => {
    const revision = await makeRepo();
    const marker = `marker-${Date.now()}`;
    const suite = suiteOf("hang", [itemsCheck({ timeoutMs: 10_000 })], { app: { executable: process.execPath, args: ["server.mjs", `--marker=${marker}`], port: 4173, readyPath: "/health", startTimeoutMs: 8000, env: { FIXTURE_MODE: "hang" }, dependencyRoots: [] } });
    const started = Date.now();
    const run = await runAppSuite({ repository: repo, revision, suite, deadlineMs: 3000 });
    expect(run).toMatchObject({ status: "blocked", code: "app_check_timeout" });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(spawnSync("pgrep", ["-f", marker]).stdout.toString().trim()).toBe("");
    expect(await gitWorktrees()).toBe(1);
  }, 60_000);
});

describe.skipIf(!browserAvailable)("runAppSuite UI checks (real headless Chrome in the sandbox)", () => {
  it("passes a rendered page and API, binds the browser lease and returns a PNG screenshot", async () => {
    const revision = await makeRepo();
    const leases = new AppCheckBrowserLeases(leaseDirectory);
    const suite = suiteOf("good", [homeCheck({ screenshot: true }), itemsCheck()]);
    const run = completed(await runAppSuite({ repository: repo, revision, suite, leases, holder: "run-good" }));
    expect(run).toMatchObject({ appReady: true, passed: true, findings: [] });
    expect(run.browserVersion).toMatch(/Chrome/);
    expect(run.lease).toMatchObject({ resourceKey: "app-check-browser", fencingToken: 1 });
    expect(run.screenshots.map(shot => shot.checkId)).toEqual(["home"]);
    expect([...run.screenshots[0]!.png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // The run released its lease, so the next acquisition is the following fencing token.
    expect(await leases.acquire("app-check-browser", "next-run", 60_000)).toMatchObject({ ok: true, lease: { fencingToken: 2 } });
  }, 90_000);

  it("reports an uncaught page error", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("pageerror", [homeCheck({ expect: { selectors: ["#app"], text: ["Hello"] } })]), leases: new AppCheckBrowserLeases(leaseDirectory) }));
    expect(run.passed).toBe(false);
    expect(codes(run)).toContain("ui_page_error");
  }, 90_000);

  it("reports a console error", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("consoleerror", [homeCheck({ expect: { selectors: [], text: ["Hello"] } })]), leases: new AppCheckBrowserLeases(leaseDirectory) }));
    expect(codes(run)).toContain("ui_console_error");
  }, 90_000);

  it("reports a sub-resource that answers 500", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("subresource500", [homeCheck({ expect: { selectors: [], text: ["Hello"] } })]), leases: new AppCheckBrowserLeases(leaseDirectory) }));
    expect(codes(run)).toContain("ui_http_error");
    expect(run.findings.find(finding => finding.code === "ui_http_error")?.details).toMatchObject({ status: 500, main: false });
  }, 90_000);

  it("rejects a selector that exists only in template markup, never rendered visibly", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("staticonly", [homeCheck({ expect: { selectors: ["[data-testid=ready]"], text: ["Ready"] }, timeoutMs: 4000 })]), leases: new AppCheckBrowserLeases(leaseDirectory) }));
    expect(run.passed).toBe(false);
    expect(codes(run)).toEqual(["ui_expect_missing"]);
  }, 90_000);

  it("waits for a selector that is rendered after a delay, within the check timeout", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("delayed", [homeCheck({ expect: { selectors: ["[data-testid=ready]"], text: ["Ready"] }, timeoutMs: 8000 })]), leases: new AppCheckBrowserLeases(leaseDirectory) }));
    expect(run.passed).toBe(true);
  }, 90_000);

  it("reports horizontal overflow on a narrow viewport", async () => {
    const revision = await makeRepo();
    const run = completed(await runAppSuite({ repository: repo, revision, suite: suiteOf("wide", [homeCheck({ viewport: { width: 375, height: 667 }, expect: { selectors: [], text: ["Wide page"] }, noHorizontalOverflow: true, timeoutMs: 8000 })]), leases: new AppCheckBrowserLeases(leaseDirectory) }));
    expect(codes(run)).toEqual(["ui_horizontal_overflow"]);
  }, 90_000);

  it("fails with a lease-lost prerequisite when another holder takes over mid-run and discards results", async () => {
    const revision = await makeRepo();
    const clock = { now: Date.parse("2026-10-27T00:00:00.000Z") };
    const leases = new AppCheckBrowserLeases(leaseDirectory, () => new Date(clock.now));
    const suite = suiteOf("delayed", [homeCheck({ expect: { selectors: ["[data-testid=ready]"], text: ["Ready"] }, timeoutMs: 8000 })]);
    const running = runAppSuite({ repository: repo, revision, suite, leases, holder: "lease-lost-run", renewIntervalMs: 50 });
    const stateFile = join(leaseDirectory, "app-check-leases.json");
    for (let attempt = 0; attempt < 400; attempt++) {
      const state = existsSync(stateFile) ? JSON.parse(await readFile(stateFile, "utf8")) : undefined;
      if (state?.resources?.["app-check-browser"]?.current?.holder === "lease-lost-run") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    clock.now += suite.timeoutMs + 60_000;
    const intruder = await leases.acquire("app-check-browser", "intruder", 600_000);
    const run = await running;
    if (run.status !== "blocked") throw new Error(`expected blocked run, got ${run.status}`);
    // A renewal that observes the takeover reports lost; one that observes only the clock jump reports expired.
    expect(["app_check_browser_lease_lost", "app_check_browser_lease_expired"]).toContain(run.code);
    if (intruder.ok) await leases.release(intruder.lease);
  }, 90_000);
});
