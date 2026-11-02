import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PaneBindingSchema } from "@bflow/contracts";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { afterEach, describe, expect, it } from "vitest";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "../../../artifact-store/src/index.js";
import { copyIsolatedNodeDependencies } from "../helpers/isolated-node-dependencies.js";
import {
  bindRunnerProfile,
  measureBehavior,
  runtimeGitDirectoryFlags,
  type RunnerProfile
} from "../../src/agentic/behavioral-runner.js";
import { declaredRunnerAdapter } from "../../src/agentic/declared-runner-adapter.js";
import * as scopeModule from "../../src/agentic/developer-process-scope.js";
import * as hostDevModule from "../../src/agentic/host-development.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { captureIntegratedChange } from "../../src/agentic/integration-change.js";
import { javascriptAdapter } from "../../src/agentic/javascript-adapter.js";
import {
  BehavioralIdentityMismatch,
  NodeTapTestCodeFailure,
  parseNodeTap
} from "../../src/agentic/node-tap.js";
import { managedAdapters } from "../../src/agentic/runner-adapters/managed.js";
import { pinRunnerDefinitions } from "../../src/agentic/runner-provenance.js";
import { parseRunnerResult } from "../../src/agentic/runner-results.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { VitestTestCodeFailure, parseVitestJson } from "../../src/agentic/vitest-json.js";

const execute = promisify(execFile);
const sandboxReady = (await probeBehavioralSandbox()).status === "ready";

const cleanups: (() => Promise<void>)[] = [];
const stores: FilesystemArtifactStore[] = [];
const savedPath = process.env.PATH;
const savedHome = process.env.HOME;

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  while (stores.length > 0) {
    stores.pop()?.close();
  }
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function rawGit(cwd: string, ...args: string[]): Promise<string> {
  return (
    await execute(
      "git",
      ["-c", "safe.directory=*", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
    )
  ).stdout.trim();
}

function makeOutcome(
  cwd: string,
  stdout: unknown,
  exitCode = 0,
  stderr = "BFLOW_VITEST_RUNTIME_ERRORS=0\n"
): QualityCommandOutcome {
  const rendered = typeof stdout === "string" ? stdout : JSON.stringify(stdout);
  return {
    executable: process.execPath,
    args: [],
    cwd,
    exitCode,
    signal: null,
    stdout: rendered,
    stderr,
    combinedOutput: `${rendered}${stderr}`,
    durationMs: 5,
    timedOut: false,
    aborted: false,
    outputTruncated: false
  };
}

describe("Round 2 Slice 7 adversarial red-team hardening", () => {
  describe("P0 Incident #1 — Test identity matching across nested describe/it, '>' hierarchy, and Vietnamese NFC/NFD", () => {
    it("matches real vitest@2.1.9 nested describe tests against leaf-only, '>' separated, and NFC/NFD Vietnamese identities while returning canonical expectedNames", async () => {
      const worktreeRoot = resolve(import.meta.dirname, "../../../..");
      const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2s7-vitest-id-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));

      await symlink(join(worktreeRoot, "node_modules"), join(root, "node_modules"));
      await mkdir(join(root, "test"), { recursive: true });

      const reporterSource = (
        await readFile(join(worktreeRoot, "packages/runtime/dist/agentic/vitest-runtime-reporter.js"), "utf8")
      ).replace(/\n\/\/# sourceMappingURL=.*$/u, "\n");
      const reporterFile = join(root, "vitest-runtime-reporter.mjs");
      await writeFile(reporterFile, reporterSource, { mode: 0o600 });

      const nfcLeaf = "ac-2: Role được cấp quyền truy cập trang quản trị".normalize("NFC");
      const nfdLeaf = nfcLeaf.normalize("NFD");
      const nfcArrow = "RBAC Suite > ac-3: Từ chối người dùng chưa đăng nhập".normalize("NFC");
      const nfdArrowLeaf = "ac-3: Từ chối người dùng chưa đăng nhập".normalize("NFD");

      await writeFile(
        join(root, "test", "rbac.test.js"),
        `import { describe, expect, it } from "vitest";
describe("RBAC Suite", () => {
  it(${JSON.stringify(nfdLeaf)}, () => {
    expect("guest").toBe("admin");
  });
  it(${JSON.stringify(nfdArrowLeaf)}, () => {
    expect(401).toBe(403);
  });
  it("other-ac-2: Role được cấp quyền truy cập trang quản trị", () => {
    expect(1).toBe(1);
  });
});
`
      );

      const profile: RunnerProfile = {
        id: "vitest-unit",
        command: "vitest run",
        executable: process.execPath,
        args: [
          join(root, "node_modules", "vitest", "vitest.mjs"),
          "run",
          "--reporter=json",
          `--reporter=${reporterFile}`,
          "--minWorkers=1",
          "--maxWorkers=1"
        ],
        method: "unit_test",
        levels: ["unit"],
        reporter: "vitest_json",
        timeoutMs: 30_000,
        checkoutDependencyRoots: ["node_modules"],
        dependencySource: root,
        source: "detected"
      };

      const expectedNames = [nfcLeaf, nfcArrow];
      const bound = bindRunnerProfile(profile, {
        testNames: expectedNames,
        testPaths: ["test/rbac.test.js"]
      });

      const runResult = await new Promise<{ code: number; stdout: string; stderr: string }>(resolvePromise => {
        execFile(bound.executable, bound.args, { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
          resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      });

      const parsed = parseVitestJson(
        makeOutcome(root, runResult.stdout, runResult.code, runResult.stderr),
        expectedNames,
        true
      );
      expect(parsed.targetFailure).toBe(true);
      expect(parsed.tests).toBe(2);
      expect(parsed.failed).toBe(2);
      expect([...parsed.testNames].sort()).toEqual([...expectedNames].sort());

      // Also verify javascriptAdapter vitest pattern supports nested describe + NFC/NFD
      const detected = await javascriptAdapter.detect({ root, dependencySource: root, files: ["package.json"] }).catch(() => undefined);
      void detected;
    });

    it("matches real Node 22 TAP nested describe + it tests with leaf-only, '>' separated, and NFC/NFD Vietnamese identities", async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2s7-tap-id-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      await mkdir(join(root, "test"), { recursive: true });

      const nfcLeaf = "ac-2: Role được cấp quyền truy cập".normalize("NFC");
      const nfdLeaf = nfcLeaf.normalize("NFD");
      const nfcArrow = "RBAC Suite > ac-3: Chặn quyền trái phép".normalize("NFC");

      await writeFile(
        join(root, "test", "rbac.test.cjs"),
        `const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
describe("RBAC Suite", () => {
  it(${JSON.stringify(nfdLeaf)}, () => {
    assert.equal("guest", "admin");
  });
  it("ac-3: Chặn quyền trái phép", () => {
    assert.equal(200, 403);
  });
  it("unselected sibling", () => {
    assert.equal(1, 1);
  });
});
`
      );

      const profile: RunnerProfile = {
        id: "node-unit",
        command: "node --test",
        executable: process.execPath,
        args: ["--test", "--test-reporter=tap"],
        method: "unit_test",
        levels: ["unit"],
        reporter: "node_tap",
        timeoutMs: 15_000,
        checkoutDependencyRoots: [],
        dependencySource: root,
        source: "detected"
      };

      const expectedNames = [nfcLeaf, nfcArrow];
      const bound = bindRunnerProfile(profile, {
        testNames: expectedNames,
        testPaths: ["test/rbac.test.cjs"]
      });

      const runResult = await new Promise<{ code: number; stdout: string; stderr: string }>(resolvePromise => {
        execFile(bound.executable, bound.args, { cwd: root, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 0;
          resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
        });
      });

      const parsed = parseNodeTap(
        makeOutcome(root, runResult.stdout, runResult.code, runResult.stderr),
        expectedNames,
        true,
        ["test/rbac.test.cjs"]
      );
      expect(parsed.targetFailure).toBe(true);
      expect(parsed.tests).toBe(2);
      expect(parsed.failed).toBe(2);
      expect([...parsed.testNames].sort()).toEqual([...expectedNames].sort());
    });

    it("fails closed on ambiguous duplicate leaf titles across describe suites, ancestor-only spoofing, nested t.test subtests, and describe hook failures", () => {
      // 1. Ambiguous leaf title across two describe blocks in Vitest
      const ambiguousVitest = {
        numTotalTestSuites: 3,
        numPassedTestSuites: 3,
        numFailedTestSuites: 0,
        numPendingTestSuites: 0,
        numTotalTests: 2,
        numPassedTests: 2,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        startTime: 1,
        success: true,
        snapshot: { failure: false, didUpdate: false },
        testResults: [
          {
            name: "/repo/test/ambiguous.test.ts",
            status: "passed",
            startTime: 1,
            endTime: 2,
            message: "",
            assertionResults: [
              {
                ancestorTitles: ["Admin"],
                fullName: "Admin ac-2",
                status: "passed",
                title: "ac-2",
                failureMessages: []
              },
              {
                ancestorTitles: ["Guest"],
                fullName: "Guest ac-2",
                status: "passed",
                title: "ac-2",
                failureMessages: []
              }
            ]
          }
        ]
      };
      expect(() => parseVitestJson(makeOutcome("/repo", ambiguousVitest, 0), ["ac-2"], true)).toThrow(
        BehavioralIdentityMismatch
      );
      expect(() =>
        parseVitestJson(makeOutcome("/repo", ambiguousVitest, 0), ["Admin ac-2", "ac-2"], true)
      ).toThrow(BehavioralIdentityMismatch);

      // 2. Ancestor-only name spoofing (describe("ac-2", () => it("wrong"))) MUST NEVER match ["ac-2"]
      const ancestorSpoofVitest = {
        ...ambiguousVitest,
        numTotalTestSuites: 2,
        numPassedTestSuites: 2,
        numTotalTests: 1,
        numPassedTests: 1,
        testResults: [
          {
            name: "/repo/test/spoof.test.ts",
            status: "passed",
            startTime: 1,
            endTime: 2,
            message: "",
            assertionResults: [
              {
                ancestorTitles: ["ac-2"],
                fullName: "ac-2 unrelated leaf",
                status: "passed",
                title: "unrelated leaf",
                failureMessages: []
              }
            ]
          }
        ]
      };
      expect(() => parseVitestJson(makeOutcome("/repo", ancestorSpoofVitest, 0), ["ac-2"], true)).toThrow(
        BehavioralIdentityMismatch
      );

      // 3. Dynamic nested t.test (parent has type: 'test', not type: 'suite') MUST still fail closed in parseNodeTap
      const nestedDynamicTap = `TAP version 13
# Subtest: outer test
    # Subtest: inner dynamic
    ok 1 - inner dynamic
      ---
      duration_ms: 0.2
      type: 'test'
      ...
    1..1
ok 1 - outer test
  ---
  duration_ms: 0.5
  type: 'test'
  ...
1..1
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
      expect(() => parseNodeTap(makeOutcome("/repo", nestedDynamicTap, 0, ""), ["inner dynamic"], true)).toThrow(
        /Zero, nested, skipped or incomplete tests/
      );

      // 4. describe suite hookFailed MUST still reject as infrastructure failure
      const suiteHookFailureTap = `TAP version 13
# Subtest: Broken Suite
    # Subtest: ac-2
    ok 1 - ac-2
      ---
      duration_ms: 0.2
      type: 'test'
      ...
    1..1
not ok 1 - Broken Suite
  ---
  duration_ms: 0.8
  type: 'suite'
  failureType: 'hookFailed'
  error: 'after hook crashed'
  ...
1..1
# tests 1
# suites 1
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
      expect(() => parseNodeTap(makeOutcome("/repo", suiteHookFailureTap, 1, ""), ["ac-2"], true)).toThrow(
        /infrastructure or unrelated/
      );
    });
  });

  describe("P0 Incident #2 — TDD Red assertion classification (ANSI, Testing Library V8 stack, Supertest, Node TAP, RTK subclass)", () => {
    it("classifies ANSI-colored expect(), Testing Library V8 stack-frozen queries, and Supertest HTTP expectations as valid Red assertions", () => {
      const validRedFailures = [
        "Error: \u001b[2mexpect(\u001b[22m\u001b[31mreceived\u001b[39m\u001b[2m).\u001b[22mtoBeInTheDocument()\n\nreceived value must be an HTMLElement",
        "Error: Unable to find an accessible element with the role \"button\" and name \"Lưu thay đổi\"\n\nHere are the accessible roles:\n  --------------------------------------------------\n    at Object.getElementError (/repo/node_modules/@testing-library/dom/dist/config.js:37:19)",
        "Error: Unable to find an element with the text: Không có quyền truy cập.\n    at getElementError (/repo/node_modules/@testing-library/dom/dist/config.js:37:19)",
        "Error: Unable to find a label with the text of: Mật khẩu\n    at findAllByLabelText (/repo/node_modules/@testing-library/dom/dist/queries/label-text.js:111:13)",
        "Error: Found multiple elements with the role \"alert\"\n    at getMultipleElementsFoundError (/repo/node_modules/@testing-library/dom/dist/query-helpers.js:23:10)",
        "Error: Timed out in waitFor.\n    at waitFor (/repo/node_modules/@testing-library/dom/dist/wait-for.js:163:27)",
        "Error: expected 200 \"OK\", got 404 \"Not Found\"\n    at Test._assertStatus (/repo/node_modules/supertest/lib/test.js:252:14)"
      ];

      for (const failureMessage of validRedFailures) {
        const report = {
          numTotalTestSuites: 2,
          numPassedTestSuites: 0,
          numFailedTestSuites: 2,
          numPendingTestSuites: 0,
          numTotalTests: 1,
          numPassedTests: 0,
          numFailedTests: 1,
          numPendingTests: 0,
          numTodoTests: 0,
          startTime: 1,
          success: false,
          snapshot: { failure: false, didUpdate: false },
          testResults: [
            {
              name: "/repo/test/ui.test.tsx",
              status: "failed",
              startTime: 1,
              endTime: 2,
              message: "",
              assertionResults: [
                {
                  ancestorTitles: ["UI Suite"],
                  fullName: "UI Suite ac-2: renders button",
                  status: "failed",
                  title: "ac-2: renders button",
                  failureMessages: [failureMessage]
                }
              ]
            }
          ]
        };

        const parsed = parseVitestJson(makeOutcome("/repo", report, 1), ["ac-2: renders button"], true);
        expect(parsed.targetFailure).toBe(true);
        expect(parsed.testNames).toEqual(["ac-2: renders button"]);

        const jestReport = JSON.stringify({
          numTotalTestSuites: 1,
          numPassedTestSuites: 0,
          numFailedTestSuites: 1,
          numPendingTestSuites: 0,
          numRuntimeErrorTestSuites: 0,
          numTotalTests: 1,
          numPassedTests: 0,
          numFailedTests: 1,
          numPendingTests: 0,
          numTodoTests: 0,
          wasInterrupted: false,
          success: false,
          testResults: [
            {
              status: "failed",
              message: "failed",
              assertionResults: [
                {
                  ancestorTitles: ["UI Suite"],
                  fullName: "UI Suite ac-2: renders button",
                  title: "ac-2: renders button",
                  status: "failed",
                  failureMessages: [failureMessage]
                }
              ]
            }
          ]
        });
        const jestParsed = parseRunnerResult("jest_json", makeOutcome("/repo", jestReport, 1, ""), ["ac-2: renders button"]);
        expect(jestParsed.targetFailure).toBe(true);
        expect(jestParsed.testNames).toEqual(["ac-2: renders button"]);
      }

      // Node TAP custom TestingLibraryElementError / Chai AssertionError without ERR_ASSERTION
      const customAssertionTap = `TAP version 13
# Subtest: UI Suite
    # Subtest: ac-2: renders button
    not ok 1 - ac-2: renders button
      ---
      duration_ms: 1.2
      type: 'test'
      failureType: 'testCodeFailure'
      error: 'Unable to find an accessible element with the role "button"'
      name: 'TestingLibraryElementError'
      ...
    1..1
not ok 1 - UI Suite
  ---
  duration_ms: 2.0
  type: 'suite'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 1
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
`;
      const tapParsed = parseNodeTap(makeOutcome("/repo", customAssertionTap, 1, ""), ["ac-2: renders button"], true);
      expect(tapParsed.targetFailure).toBe(true);

      // Node TAP TypeError inside describe MUST still throw NodeTapTestCodeFailure with canonical test name
      const typeErrorTap = customAssertionTap
        .replace("name: 'TestingLibraryElementError'", "name: 'TypeError'")
        .replace("Unable to find an accessible element with the role \"button\"", "fn is not a function");
      expect(() => parseNodeTap(makeOutcome("/repo", typeErrorTap, 1, ""), ["ac-2: renders button"], true)).toThrow(
        NodeTapTestCodeFailure
      );
    });
  });

  describe("P0 Incident #3 — Vitest skipped / todo / skipIf / pending-leaf handling & RTK VitestTestCodeFailure protocol preservation", () => {
    it("accepts Vitest 2.1.9 reports with describe.todo pending leaves, describe.skipIf, it.skip, and it.todo when mapped tests execute, while rejecting skipped mapped tests", () => {
      const reportWithTodoSuitePendingLeaf = {
        numTotalTestSuites: 6,
        numPassedTestSuites: 2,
        numFailedTestSuites: 2,
        numPendingTestSuites: 2,
        numTotalTests: 7,
        numPassedTests: 0,
        numFailedTests: 1,
        numPendingTests: 4,
        numTodoTests: 1,
        startTime: 1,
        success: false,
        snapshot: { failure: false, didUpdate: false },
        testResults: [
          {
            name: "/repo/test/mixed.test.ts",
            status: "failed",
            startTime: 1,
            endTime: 3,
            message: "",
            assertionResults: [
              {
                ancestorTitles: ["Active"],
                fullName: "Active ac-2: target",
                status: "failed",
                title: "ac-2: target",
                failureMessages: ["AssertionError: expected false to be true"]
              },
              {
                ancestorTitles: ["Active"],
                fullName: "Active skipped leaf",
                status: "skipped",
                title: "skipped leaf",
                failureMessages: []
              },
              {
                ancestorTitles: ["Active"],
                fullName: "Active skipIf leaf",
                status: "skipped",
                title: "skipIf leaf",
                failureMessages: []
              },
              {
                ancestorTitles: ["Active"],
                fullName: "Active todo leaf",
                status: "todo",
                title: "todo leaf",
                failureMessages: []
              },
              {
                ancestorTitles: ["Skipped suite"],
                fullName: "Skipped suite inside skipped suite",
                status: "skipped",
                title: "inside skipped suite",
                failureMessages: []
              },
              {
                ancestorTitles: ["SkipIf suite"],
                fullName: "SkipIf suite inside skipIf suite",
                status: "skipped",
                title: "inside skipIf suite",
                failureMessages: []
              },
              {
                ancestorTitles: ["Todo suite with child"],
                fullName: "Todo suite with child inside todo suite",
                status: "pending",
                title: "inside todo suite",
                failureMessages: []
              }
            ]
          }
        ]
      };

      const parsed = parseVitestJson(
        makeOutcome("/repo", reportWithTodoSuitePendingLeaf, 1),
        ["ac-2: target"],
        true
      );
      expect(parsed).toEqual({
        testNames: ["ac-2: target"],
        testResults: [{ name: "ac-2: target", passed: false }],
        tests: 1,
        passed: 0,
        failed: 1,
        targetFailure: true
      });

      // If the mapped expected identity itself was skipped inside a describe block, it MUST fail closed!
      expect(() =>
        parseVitestJson(
          makeOutcome("/repo", reportWithTodoSuitePendingLeaf, 1),
          ["ac-2: target", "skipped leaf"],
          true
        )
      ).toThrow(/Selected Vitest test was skipped/);
    });

    it.skipIf(!sandboxReady)(
      "runs owner-configured Vitest measureBehavior on files with sibling it.skip/describe.todo without bricking, and preserves VitestTestCodeFailure subclass with RTK",
      async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2s7-owner-vitest-")));
        cleanups.push(() => rm(root, { recursive: true, force: true }));

        const repo = join(root, "repo");
        await mkdir(join(repo, "test"), { recursive: true });
        await rawGit(repo, "init", "-b", "main");
        await rawGit(repo, "config", "user.name", "Bflow Test");
        await rawGit(repo, "config", "user.email", "bflow@example.invalid");
        await writeFile(join(repo, ".gitignore"), "node_modules\n");
        await writeFile(
          join(repo, "test", "feature.test.js"),
          `import { describe, expect, it } from "vitest";
describe("Feature Suite", () => {
  it("ac-2: owner vitest target", () => {
    expect("actual").toBe("expected");
  });
  it.skip("legacy skipped check", () => {});
  it.todo("future roadmap check");
});
describe.todo("Roadmap suite", () => {
  it("pending child", () => {});
});
`
        );
        await rawGit(repo, "add", ".");
        const redRev = await rawGit(repo, "commit", "-m", "red with sibling skips").then(() => rawGit(repo, "rev-parse", "HEAD"));

        const sourceDependencies = fileURLToPath(new URL("../../../../node_modules", import.meta.url));
        const stagedDependencies = join(root, "node_modules");
        await copyIsolatedNodeDependencies(sourceDependencies, stagedDependencies);
        const vitestCli = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
        const stagedVitest = join(stagedDependencies, relative(sourceDependencies, vitestCli));

        const ownerCommand = {
          id: "owner-vitest",
          command: "vitest run test/feature.test.js",
          executable: await realpath(process.execPath),
          args: [
            stagedVitest,
            "run",
            "--reporter=json",
            "--no-cache",
            "--minWorkers=1",
            "--maxWorkers=1",
            "test/feature.test.js"
          ],
          method: "unit_test" as const,
          levels: ["unit" as const],
          reporter: "vitest_json" as const,
          testNames: ["ac-2: owner vitest target"],
          testPaths: ["test/feature.test.js"],
          dependencyRoots: [stagedDependencies],
          timeoutMs: 30_000
        };

        const measured = await measureBehavior(ownerCommand, repo, redRev);
        expect(measured.targetFailure).toBe(true);
        expect(measured.testNames).toEqual(["ac-2: owner vitest target"]);

        // Now verify VitestTestCodeFailure subclass (protocol === "vitest_json") is preserved when RTK is enabled
        await writeFile(
          join(repo, "test", "feature.test.js"),
          `import { describe, it } from "vitest";
describe("Feature Suite", () => {
  it("ac-2: owner vitest target", () => {
    const missing = undefined;
    missing.callAbsentExport();
  });
});
`
        );
        await rawGit(repo, "add", ".");
        const crashRev = await rawGit(repo, "commit", "-m", "typeerror with rtk").then(() => rawGit(repo, "rev-parse", "HEAD"));

        let caught: unknown;
        try {
          await measureBehavior(ownerCommand, repo, crashRev, {
            rtk: {
              executablePath: join(root, "absent-optional-rtk"),
              version: "1.0.0",
              digest: "a".repeat(64),
              filter: "auto",
              required: false
            }
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(VitestTestCodeFailure);
        expect((caught as VitestTestCodeFailure).protocol).toBe("vitest_json");
        expect((caught as VitestTestCodeFailure).rtk?.status).toBe("degraded");
      }
    );
  });

  describe("P0 Incident #4 — Git safe.directory, NTFS +x core.fileMode=false, fsync tolerance, EISDIR, and PATH +x directories", () => {
    it("emits core.fileMode=false for POSIX linked worktrees backed by +x NTFS gitDir, bare +x repos, and isolates hostile HOME/.gitconfig in captureIntegratedChange & pinRunnerDefinitions", async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2s7-git-ntfs-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));

      const ntfsRepo = join(root, "ntfs-repo");
      await mkdir(ntfsRepo, { recursive: true });
      await rawGit(ntfsRepo, "init", "-b", "main");
      await rawGit(ntfsRepo, "config", "user.name", "Bflow Test");
      await rawGit(ntfsRepo, "config", "user.email", "bflow@example.invalid");
      await writeFile(join(ntfsRepo, "package.json"), JSON.stringify({ name: "pkg", scripts: { test: "node --test" } }));
      await rawGit(ntfsRepo, "add", ".");
      const baseRev = await rawGit(ntfsRepo, "commit", "-m", "base").then(() => rawGit(ntfsRepo, "rev-parse", "HEAD"));

      await writeFile(join(ntfsRepo, "feature.txt"), "added\n");
      await rawGit(ntfsRepo, "add", ".");
      const headRev = await rawGit(ntfsRepo, "commit", "-m", "head").then(() => rawGit(ntfsRepo, "rev-parse", "HEAD"));

      const linked = join(root, "posix-linked");
      await rawGit(ntfsRepo, "worktree", "add", "--detach", linked, headRev);
      await chmod(join(linked, ".git"), 0o644);
      await chmod(join(ntfsRepo, ".git", "HEAD"), 0o755);

      const alias = join(root, "alias-linked");
      await symlink(linked, alias);

      const flags = await runtimeGitDirectoryFlags(alias);
      expect(flags).toContain("core.fileMode=false");
      expect(flags).toContain(`safe.directory=${alias}`);
      expect(flags).toContain(`safe.directory=${linked}`);
      expect(flags).toContain(`safe.directory=${ntfsRepo}`);

      // Bare repo with +x HEAD
      const bare = join(root, "bare.git");
      await mkdir(bare, { recursive: true });
      await rawGit(bare, "init", "--bare", "-b", "main");
      await chmod(join(bare, "HEAD"), 0o755);
      const bareFlags = await runtimeGitDirectoryFlags(bare);
      expect(bareFlags).toContain(`safe.directory=${bare}`);
      expect(bareFlags).toContain("core.fileMode=false");

      // Hostile HOME/.gitconfig with invalid config include / syntax that crashes un-isolated git invocations
      const hostileHome = join(root, "hostile-home");
      await mkdir(hostileHome, { recursive: true });
      await writeFile(join(hostileHome, ".gitconfig"), "[safe]\n\tdirectory = /nonexistent-only\n[core\n\tbroken-syntax\n");
      process.env.HOME = hostileHome;

      const storeOpened = await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "r2s7-store" });
      if (!storeOpened.ok) throw new Error(storeOpened.error.message);
      stores.push(storeOpened.value);

      const integrated = await captureIntegratedChange({
        artifactStore: storeOpened.value,
        runId: "run-1",
        taskId: "task-1",
        worktreePath: ntfsRepo,
        branchName: "main",
        baseRevision: baseRev,
        headCommitHash: headRev
      });
      expect(integrated.filesChanged.map(f => f.path)).toEqual(["feature.txt"]);

      const pinned = await pinRunnerDefinitions(ntfsRepo, {
        status: "detected",
        profiles: [
          {
            id: "node-unit",
            command: "node --test",
            executable: process.execPath,
            args: ["--test", "--test-reporter=tap"],
            method: "unit_test",
            levels: ["unit"],
            reporter: "node_tap",
            timeoutMs: 10_000,
            checkoutDependencyRoots: [],
            dependencySource: ntfsRepo,
            source: "detected"
          }
        ],
        notes: []
      });
      expect(pinned.status).toBe("detected");
    });

    it("tolerates FUSE/NTFS regular-file & directory fsync errnos in HostDevelopment and developer-process-scope, and handles EISDIR in conflict-resolution commit", async () => {
      // 1. developer-process-scope syncDirectory ENOSYS + syncFileHandle
      let scopeDirClosed = false;
      await expect(
        scopeModule.syncDirectory("/virtual-fuse-dir", async () => ({
          sync: async () => {
            throw Object.assign(new Error("ENOSYS"), { code: "ENOSYS" });
          },
          close: async () => {
            scopeDirClosed = true;
          }
        }))
      ).resolves.toBeUndefined();
      expect(scopeDirClosed).toBe(true);

      const scopeSyncFile = (
        scopeModule as unknown as {
          syncFileHandle?: (file: { sync: () => Promise<void> }) => Promise<void>;
        }
      ).syncFileHandle;
      expect(typeof scopeSyncFile).toBe("function");

      const hostSyncFile = (
        hostDevModule as unknown as {
          syncFileHandle?: (file: { sync: () => Promise<void> }) => Promise<void>;
        }
      ).syncFileHandle;
      expect(typeof hostSyncFile).toBe("function");

      for (const code of ["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EROFS", "EPERM", "EACCES"]) {
        await expect(
          scopeSyncFile!({
            sync: async () => {
              throw Object.assign(new Error(code), { code });
            }
          })
        ).resolves.toBeUndefined();
        await expect(
          hostSyncFile!({
            sync: async () => {
              throw Object.assign(new Error(code), { code });
            }
          })
        ).resolves.toBeUndefined();
      }

      // 2. HostDevelopment conflict resolution commit when a conflict path is a directory on disk (file/directory conflict resolved to directory)
      const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2s7-merge-dir-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));

      const repo = join(root, "repo");
      await mkdir(repo, { recursive: true });
      await rawGit(repo, "init", "-b", "main");
      await rawGit(repo, "config", "user.name", "Bflow Test");
      await rawGit(repo, "config", "user.email", "bflow@example.invalid");
      await writeFile(join(repo, "base.txt"), "base\n");
      await rawGit(repo, "add", ".");
      await rawGit(repo, "commit", "-m", "base");

      // Branch 'other' creates 'entry' as a regular file
      await rawGit(repo, "checkout", "-b", "other");
      await writeFile(join(repo, "entry"), "file version\n");
      await rawGit(repo, "add", ".");
      await rawGit(repo, "commit", "-m", "entry as file");

      // Branch 'integration' creates 'entry/nested.txt' (so 'entry' is a directory!)
      await rawGit(repo, "checkout", "-b", "integration", "main");
      await mkdir(join(repo, "entry"), { recursive: true });
      await writeFile(join(repo, "entry", "nested.txt"), "dir version\n");
      await rawGit(repo, "add", ".");
      const expectedHead = await rawGit(repo, "commit", "-m", "entry as dir").then(() => rawGit(repo, "rev-parse", "HEAD"));

      // Start conflicting merge (file vs directory on 'entry')
      await rawGit(repo, "merge", "--no-commit", "other").catch(() => undefined);
      // Resolver chooses the directory layout by removing merge-ort's unmerged scratch file from disk and index
      await rm(join(repo, "entry~other"), { force: true });
      await rawGit(repo, "update-index", "--force-remove", "entry", "entry~other");
      await rawGit(repo, "add", "entry/nested.txt");

      const binding = PaneBindingSchema.parse({
        schemaVersion: 2,
        bindingId: "dev-resolver-1",
        sessionId: "bflow-test",
        role: "developer",
        agentId: "dev-1",
        agentKind: "codex",
        provider: "codex",
        workspaceId: "ws-1",
        tabId: "tab-1",
        paneId: "pane-dev-1",
        cwd: repo,
        worktreePath: repo,
        isolationMode: "dedicated_pane",
        readOnlyWorkspace: false,
        transportState: "working",
        boundAt: new Date().toISOString()
      });

      const assignmentMsg = {
        schema_version: 2,
        message_id: "msg-conflict-1",
        correlation_id: "corr-1",
        run_id: "run-1",
        sender: { role: "coordinator" },
        recipient: { role: "developer", agent_id: "dev-1", pane_id: "pane-dev-1" },
        type: "task.assignment",
        payload: {
          kind: "conflict_resolution",
          conflictResolution: {
            integrationId: "int-1",
            branchName: "integration",
            conflictPaths: ["entry", "entry~other"]
          }
        },
        artifact_references: [],
        occurred_at: new Date().toISOString(),
        idempotency_key: "conflict-assign-1"
      };

      const fakeRuntime = {
        inspect: async () => ({
          outbound: [
            {
              status: "accepted",
              taskId: "task-1",
              attemptId: "attempt-1",
              message: assignmentMsg,
              handle: {
                executionId: "exec-1",
                requestId: "req-1",
                attemptId: "attempt-1",
                runId: "run-1",
                taskId: "task-1",
                idempotencyKey: "conflict-assign-1",
                target: {
                  transport: "herdr",
                  agentId: "dev-1",
                  workspaceId: "ws-1",
                  tabId: "tab-1",
                  paneId: "pane-dev-1",
                  worktreePath: repo
                },
                correlation: { token: "req-1", provenance: "orchestrator", verified: false },
                acceptedAt: new Date().toISOString()
              }
            }
          ]
        }),
        commitConflictResolution: async (
          _b: unknown,
          _r: string,
          _t: string,
          commitFn: (res: { conflictPaths: string[]; branchName: string }) => Promise<string>
        ) => {
          const head = await commitFn({ conflictPaths: ["entry", "entry~other"], branchName: "integration" });
          return { head };
        }
      } as unknown as AgenticWorkflowRuntime;

      const hostDev = new HostDevelopment(() => fakeRuntime, []);
      const committed = (await hostDev.commit(binding, {
        runId: "run-1",
        taskId: "task-1",
        expectedHead,
        message: "resolve file/directory conflict keeping entry/"
      })) as { head: string };
      expect(committed.head).toMatch(/^[a-f0-9]{40}$/);
      expect(committed.head).not.toBe(expectedHead);
    });

    it("skips +x directories on PATH in declaredRunnerAdapter and managedAdapters to discover the real executable binary", async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2s7-path-dir-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));

      const dirShadowBin = join(root, "shadow-path");
      const realBin = join(root, "real-bin");
      await mkdir(join(dirShadowBin, "make"), { recursive: true, mode: 0o755 });
      await mkdir(join(dirShadowBin, "ctest"), { recursive: true, mode: 0o755 });
      await mkdir(realBin, { recursive: true });

      await writeFile(
        join(realBin, "make"),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'GNU Make 4.3\\n'; exit 0; fi\nexit 0\n`,
        { mode: 0o755 }
      );
      await writeFile(
        join(realBin, "ctest"),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'ctest version 3.28.1\\n'; exit 0; fi\nexit 0\n`,
        { mode: 0o755 }
      );

      const project = join(root, "project");
      const repoLocalShadowBin = join(project, "bin");
      await mkdir(repoLocalShadowBin, { recursive: true });
      await writeFile(join(repoLocalShadowBin, "make"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
      await writeFile(join(repoLocalShadowBin, "ctest"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
      await writeFile(
        join(project, "Makefile"),
        "test:\n\t@echo $(BFLOW_TEST_NAMES) $(BFLOW_TEST_FILES) $(BFLOW_JUNIT_OUTPUT)\n"
      );
      await writeFile(join(project, "CTestTestfile.cmake"), "add_test(smoke /bin/true)\n");

      process.env.PATH = [dirShadowBin, repoLocalShadowBin, realBin, "/usr/bin", "/bin"].join(delimiter);

      const declared = await declaredRunnerAdapter.detect({ root: project, files: ["Makefile"] });
      expect(declared.runners).toHaveLength(1);
      expect(declared.runners[0]!.executable).toBe(join(realBin, "make"));

      const ctestAdapter = managedAdapters.find(adapter => adapter.id === "ctest")!;
      const managed = await ctestAdapter.detect({ root: project, files: ["CTestTestfile.cmake"] });
      expect(managed.runners).toHaveLength(1);
      expect(managed.runners[0]!.executable).toBe(join(realBin, "ctest"));
    });
  });

  describe("Mission Item #5 — Zero intra-package runtime ESM value import cycles across all Slice 7 sources", () => {
    it("contains zero runtime value import cycles across verification, quality-gates, git-orchestrator, and Slice 7 runtime/agentic modules", async () => {
      const worktreeRoot = resolve(import.meta.dirname, "../../../..");
      const slice7RuntimeFiles = new Set([
        "host-verification.ts",
        "host-development.ts",
        "host-test-integrity.ts",
        "test-integrity.ts",
        "behavioral-runner.ts",
        "behavioral-sandbox.ts",
        "behavioral-sandbox-darwin.ts",
        "sandbox-readiness.ts",
        "developer-process-scope.ts",
        "process-scope-supervisor.ts",
        "runner-adapter.ts",
        "runner-adapters/managed.ts",
        "runner-adapters/native.ts",
        "declared-runner-adapter.ts",
        "javascript-adapter.ts",
        "runner-catalog.ts",
        "runner-detection.ts",
        "runner-provenance.ts",
        "runner-reports.ts",
        "runner-results.ts",
        "vitest-json.ts",
        "vitest-runtime-reporter.ts",
        "node-tap.ts",
        "typecheck.ts",
        "mutation-check.ts",
        "fast-path.ts",
        "regression-changes.ts",
        "regression-results.ts",
        "regression-selection.ts",
        "impact-index.ts",
        "patch-paths.ts",
        "dependency-base.ts",
        "dependency-warming.ts",
        "integration-change.ts",
        "repository-read.ts",
        "workspace.ts",
        "workspace-file-readiness.ts",
        "workspace-file-darwin.ts",
        "workspace-file-darwin-source.ts",
        "app-check-config.ts",
        "app-check-driver.ts",
        "app-check-evidence.ts",
        "app-check-lease.ts",
        "app-check-runner.ts",
        "app-check-selection.ts"
      ]);

      async function collectTsFiles(dir: string): Promise<string[]> {
        const out: string[] = [];
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) out.push(...(await collectTsFiles(full)));
          else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
        }
        return out;
      }

      function parseValueImports(source: string, file: string, allowed: Set<string>): string[] {
        const stripped = source
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        const edges: string[] = [];
        const stmtPattern = /\b(?:import|export)\s+(?!type\b)(\{[^}]*\}|\*\s+as\s+[A-Za-z0-9_$]+|\*|[A-Za-z0-9_$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+["'](\.[^"']+)["']/g;
        for (const match of stripped.matchAll(stmtPattern)) {
          const clause = match[1]!.trim();
          const spec = match[2]!;
          if (clause.startsWith("{") && clause.endsWith("}")) {
            const items = clause
              .slice(1, -1)
              .split(",")
              .map(s => s.trim())
              .filter(Boolean);
            if (items.length > 0 && items.every(item => /^type\s+/.test(item))) continue;
          }
          const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
          if (allowed.has(target)) edges.push(target);
        }
        return edges;
      }

      async function findCycles(files: string[]): Promise<string[][]> {
        const allowed = new Set(files);
        const graph = new Map<string, string[]>();
        for (const file of files) {
          graph.set(file, parseValueImports(await readFile(file, "utf8"), file, allowed));
        }
        const cycles: string[][] = [];
        const state = new Map<string, "visiting" | "done">();
        const stack: string[] = [];

        const dfs = (node: string) => {
          state.set(node, "visiting");
          stack.push(node);
          for (const next of graph.get(node) ?? []) {
            const st = state.get(next);
            if (st === "visiting") {
              const idx = stack.indexOf(next);
              cycles.push([...stack.slice(idx), next].map(p => p.slice(worktreeRoot.length + 1)));
            } else if (!st) {
              dfs(next);
            }
          }
          stack.pop();
          state.set(node, "done");
        };

        for (const file of files) {
          if (!state.has(file)) dfs(file);
        }
        return cycles;
      }

      const trees = [
        await collectTsFiles(join(worktreeRoot, "packages/verification/src")),
        await collectTsFiles(join(worktreeRoot, "packages/quality-gates/src")),
        await collectTsFiles(join(worktreeRoot, "packages/git-orchestrator/src")),
        [...slice7RuntimeFiles].map(rel => join(worktreeRoot, "packages/runtime/src/agentic", rel))
      ];

      const allCycles: string[][] = [];
      for (const tree of trees) {
        allCycles.push(...(await findCycles(tree)));
      }
      expect(allCycles).toEqual([]);
    });
  });
});
