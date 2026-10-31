import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { QualityCommandOutcome } from "@bflow/quality-gates";
import { afterEach, describe, expect, it } from "vitest";
import { openFilesystemArtifactStore, type FilesystemArtifactStore } from "../../../artifact-store/src/index.js";
import { runAppSuite } from "../../src/agentic/app-check-runner.js";
import type { AppCheckSuite } from "../../src/agentic/app-check-config.js";
import {
  assertPinnedRevision,
  bindRunnerProfile,
  type RunnerProfile,
  verificationGit
} from "../../src/agentic/behavioral-runner.js";
import * as warmingModule from "../../src/agentic/dependency-warming.js";
import * as scopeModule from "../../src/agentic/developer-process-scope.js";
import { DeveloperProcessScopes } from "../../src/agentic/developer-process-scope.js";
import { measureTestIntegrity, validateTestIntegrityEvidence } from "../../src/agentic/host-test-integrity.js";
import { captureIntegratedChange } from "../../src/agentic/integration-change.js";
import { repositoryRead } from "../../src/agentic/repository-read.js";
import { validateAndStoreReworkResolution } from "../../src/agentic/rework-causality.js";
import { pinRunnerDefinitions } from "../../src/agentic/runner-provenance.js";
import { parseRunnerResult } from "../../src/agentic/runner-results.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { analyzeTestIntegrity } from "../../src/agentic/test-integrity.js";
import { VitestTestCodeFailure, parseVitestJson } from "../../src/agentic/vitest-json.js";

const execute = promisify(execFile);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

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
    executable: "/usr/bin/node",
    args: ["vitest", "run"],
    cwd,
    exitCode,
    signal: null,
    stdout: rendered,
    stderr,
    combinedOutput: rendered + stderr,
    durationMs: 12,
    timedOut: false,
    aborted: false,
    outputTruncated: false
  };
}

describe("Slice 7 verification, runners, sandbox, process scope, and test-integrity hardening", () => {
  describe("Cluster 1: PATH +x directory EISDIR & FUSE/NTFS directory fsync", () => {
    it.skipIf(process.platform !== "linux")(
      "skips +x directories named after provider CLIs or tools and empty PATH segments in DeveloperProcessScopes",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "bflow-s7-scope-"));
        cleanups.push(() => rm(root, { recursive: true, force: true }));

        // Exact reproduction of ~/.local/share/bflow/tools/superpowers/{claude,codex,agy} (+x directories on PATH)
        const superpowers = join(root, "superpowers");
        await mkdir(join(superpowers, "codex"), { recursive: true, mode: 0o755 });
        await mkdir(join(superpowers, "claude"), { recursive: true, mode: 0o755 });
        await mkdir(join(superpowers, "agy"), { recursive: true, mode: 0o755 });
        await mkdir(join(superpowers, "python3"), { recursive: true, mode: 0o755 });
        await mkdir(join(superpowers, "bwrap"), { recursive: true, mode: 0o755 });

        const realBin = join(root, "real-bin");
        await mkdir(realBin, { mode: 0o755 });
        const script = `#!${process.execPath}\nprocess.exit(0);\n`;
        const provider = join(realBin, "codex");
        await writeFile(provider, script, { mode: 0o700 });

        process.env.PATH = `${ delimiter }${superpowers}${delimiter}${savedPath ?? "/usr/bin:/bin"}`;
        const manager = new DeveloperProcessScopes({ directory: join(root, "scopes") });
        const wrapped = await manager.prepare({
          runId: "run-s7",
          taskId: "task-s7",
          executable: provider,
          executableDigest: sha256(script),
          configFiles: [],
          material: {
            provider: "codex",
            argv: [],
            env: { PATH: `${delimiter}${superpowers}${delimiter}${realBin}${delimiter}${savedPath ?? "/usr/bin:/bin"}` },
            launchId: "launch-s7",
            launchFingerprint: "a".repeat(64)
          }
        });

        expect(wrapped.env.BFLOW_PROCESS_SCOPE_ID).toBeDefined();
        const scopeDir = join(root, "scopes", wrapped.env.BFLOW_PROCESS_SCOPE_ID!);
        const linkedTarget = await realpath(join(scopeDir, "provider", "codex"));
        expect(linkedTarget).toBe(await realpath(provider));
      }
    );

    it("tolerates benign FUSE/NTFS directory fsync errnos in DeveloperProcessScopes syncDirectory while rethrowing EIO", async () => {
      const syncDirectory = (
        scopeModule as unknown as {
          syncDirectory?: (
            dirPath: string,
            openDirectory?: (path: string, flags: string) => Promise<{ sync: () => Promise<void>; close: () => Promise<void> }>
          ) => Promise<void>;
        }
      ).syncDirectory;
      expect(typeof syncDirectory).toBe("function");

      for (const code of ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EACCES", "EBADF", "EROFS"]) {
        let closed = false;
        await expect(
          syncDirectory!("/fuse-scope-dir", async () => ({
            sync: async () => {
              throw Object.assign(new Error(`dir sync ${code}`), { code });
            },
            close: async () => {
              closed = true;
            }
          }))
        ).resolves.toBeUndefined();
        expect(closed).toBe(true);
      }

      await expect(
        syncDirectory!("/fuse-scope-dir", async () => ({
          sync: async () => {
            throw Object.assign(new Error("real EIO"), { code: "EIO" });
          },
          close: async () => {}
        }))
      ).rejects.toThrow("real EIO");
    });

    it.skipIf(process.platform !== "linux")(
      "ignores +x directories named bwrap on PATH without polluting sandbox failure diagnostics",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "bflow-s7-bwrap-dir-"));
        cleanups.push(() => rm(root, { recursive: true, force: true }));

        const fakeBin = join(root, "bin");
        await mkdir(join(fakeBin, "bwrap"), { recursive: true, mode: 0o755 });
        process.env.PATH = `${delimiter}${fakeBin}`;

        const readiness = await probeBehavioralSandbox("/nonexistent-repo");
        expect(readiness).toEqual({
          status: "unsupported",
          code: "verification_sandbox_unavailable",
          reason: "Bubblewrap executable not found outside the repository on PATH; install the distribution bubblewrap package"
        });
      }
    );

    it.skipIf(process.platform !== "linux")(
      "rejects a +x directory configured as app.executable with app_check_app_missing",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "bflow-s7-appcheck-dir-"));
        cleanups.push(() => rm(root, { recursive: true, force: true }));

        const dirAsExecutable = join(root, "not-a-binary");
        await mkdir(dirAsExecutable, { mode: 0o755 });

        const suite: AppCheckSuite = {
          id: "api-smoke",
          timeoutMs: 10_000,
          app: {
            executable: dirAsExecutable,
            args: [],
            env: {},
            port: 4123,
            readyPath: "/health",
            startTimeoutMs: 2_000,
            dependencyRoots: []
          },
          checks: [{ id: "health", kind: "api", method: "GET", path: "/health", expectStatus: 200 }]
        };

        const outcome = await runAppSuite({
          repository: root,
          revision: "a".repeat(40),
          suite
        });
        expect(outcome.status).toBe("blocked");
        if (outcome.status === "blocked") {
          expect(outcome.code).toBe("app_check_app_missing");
        }
      }
    );

    it("skips +x directory masquerading as npm-cli.js during findNpm discovery", async () => {
      const findNpm = (
        warmingModule as unknown as {
          findNpm?: (repositoryRoot: string) => Promise<{ node: string; npmRoot: string }>;
        }
      ).findNpm;
      expect(typeof findNpm).toBe("function");

      const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-s7-npm-dir-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));

      // Decoy: npm/bin/npm-cli.js is a +x DIRECTORY containing index.js (which `node <dir>` would execute!)
      const decoyNpmRoot = join(root, "decoy", "npm");
      const decoyCliDir = join(decoyNpmRoot, "bin", "npm-cli.js");
      await mkdir(decoyCliDir, { recursive: true, mode: 0o755 });
      await writeFile(join(decoyNpmRoot, "package.json"), JSON.stringify({ name: "npm" }));
      await writeFile(join(decoyCliDir, "index.js"), `console.log("10.8.0");\n`);
      const decoyPathBin = join(root, "decoy-path");
      await mkdir(decoyPathBin, { mode: 0o755 });
      await symlink(decoyCliDir, join(decoyPathBin, "npm"));

      // Real: npm/bin/npm-cli.js is an actual regular executable file
      const validNpmRoot = join(root, "valid", "npm");
      const validCliFile = join(validNpmRoot, "bin", "npm-cli.js");
      await mkdir(join(validNpmRoot, "bin"), { recursive: true, mode: 0o755 });
      await writeFile(join(validNpmRoot, "package.json"), JSON.stringify({ name: "npm" }));
      await writeFile(validCliFile, `#!/usr/bin/env node\nconsole.log("10.9.1");\n`, { mode: 0o755 });
      const validPathBin = join(root, "valid-path");
      await mkdir(validPathBin, { mode: 0o755 });
      await symlink(validCliFile, join(validPathBin, "npm"));

      process.env.PATH = `${decoyPathBin}${delimiter}${validPathBin}`;
      const discovered = await findNpm!("/nonexistent-repo");
      expect(discovered.npmRoot).toBe(validNpmRoot);
    });
  });

  describe("Cluster 2: Vitest & Jest filtered suite counters, stderr noise, and assertion classification", () => {
    it("accepts filtered Vitest runs with numPendingTestSuites, unselected todo tests, all-skipped sibling files, and stderr logs", () => {
      const report = {
        numTotalTestSuites: 5,
        numPassedTestSuites: 2,
        numFailedTestSuites: 0,
        numPendingTestSuites: 3,
        numTotalTests: 4,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 2,
        numTodoTests: 1,
        startTime: 1700000000000,
        success: true,
        snapshot: { failure: false, didUpdate: false },
        testResults: [
          {
            name: "/repo/test/active.test.ts",
            status: "passed",
            startTime: 1700000000000,
            endTime: 1700000000010,
            message: "",
            assertionResults: [
              {
                ancestorTitles: ["ActiveSuite"],
                fullName: "ActiveSuite runs selected target",
                status: "passed",
                title: "runs selected target",
                failureMessages: []
              },
              {
                ancestorTitles: ["SkippedSuite"],
                fullName: "SkippedSuite filtered out",
                status: "skipped",
                title: "filtered out",
                failureMessages: []
              },
              {
                ancestorTitles: ["SkippedSuite"],
                fullName: "SkippedSuite future todo item",
                status: "todo",
                title: "future todo item",
                failureMessages: []
              }
            ]
          },
          {
            name: "/repo/test/unselected-sibling.test.ts",
            status: "pending",
            startTime: 1700000000000,
            endTime: 1700000000002,
            message: "",
            assertionResults: [
              {
                ancestorTitles: ["OtherSuite"],
                fullName: "OtherSuite other test",
                status: "skipped",
                title: "other test",
                failureMessages: []
              }
            ]
          }
        ]
      };

      const parsed = parseVitestJson(
        makeOutcome(
          "/repo",
          report,
          0,
          "(node:1234) ExperimentalWarning: Something\nSUT stderr diagnostic\nBFLOW_VITEST_RUNTIME_ERRORS=0\n"
        ),
        ["ActiveSuite runs selected target"],
        true
      );
      expect(parsed).toEqual({
        testNames: ["ActiveSuite runs selected target"],
        testResults: [{ name: "ActiveSuite runs selected target", passed: true }],
        tests: 1,
        passed: 1,
        failed: 0,
        targetFailure: false
      });

      // Unfiltered mode (nameSelection = false) MUST remain strict and reject pending suites/todos
      expect(() => parseVitestJson(makeOutcome("/repo", report, 0), ["ActiveSuite runs selected target"], false)).toThrow(
        /Zero, skipped, todo or incomplete Vitest tests/
      );
      // Duplicate or non-zero runtime error markers MUST still be rejected
      expect(() =>
        parseVitestJson(
          makeOutcome("/repo", report, 0, "BFLOW_VITEST_RUNTIME_ERRORS=0\nBFLOW_VITEST_RUNTIME_ERRORS=1\n"),
          ["ActiveSuite runs selected target"],
          true
        )
      ).toThrow(/Vitest runtime errors or missing trusted reporter completion/);
    });

    it("recognizes modern Vitest, Chai, Testing Library, .rejects.toThrow, and expect.extend assertion failures while rejecting code crashes", () => {
      const assertionMessages = [
        "AssertionError: expected 1 to be 2",
        "VitestAssertionError: expected false to be true",
        "ChaiError: expected 'a' to equal 'b'",
        "TestingLibraryElementError: Unable to find an element with the text: Submit",
        "HtmlElementTypeError: Received value must be an HTMLElement or an SVGElement",
        "Error: expect(received).toHaveTextContent(expected)\n\nExpected: \"Ready\"",
        "Error: promise resolved \"42\" instead of rejecting\n    at _Assertion.__VITEST_REJECTS__ (file:///node_modules/@vitest/expect/dist/index.js:1400:19)",
        "Error: expected widget state to be valid\n    at Proxy.expectWrapper (file:///node_modules/@vitest/expect/dist/index.js:1619:27)"
      ];

      for (const failureMessage of assertionMessages) {
        const report = {
          numTotalTestSuites: 1,
          numPassedTestSuites: 0,
          numFailedTestSuites: 1,
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
              name: "/repo/test/red.test.ts",
              status: "failed",
              startTime: 1,
              endTime: 2,
              message: "",
              assertionResults: [
                {
                  ancestorTitles: [],
                  fullName: "red assertion case",
                  status: "failed",
                  title: "red assertion case",
                  failureMessages: [failureMessage]
                }
              ]
            }
          ]
        };

        const parsed = parseVitestJson(makeOutcome("/repo", report, 1), ["red assertion case"], false);
        expect(parsed.targetFailure).toBe(true);
        expect(parsed.failed).toBe(1);
      }

      const codeCrashMessages = [
        "TypeError: Cannot read properties of undefined (reading 'run')",
        "ReferenceError: missingSymbol is not defined",
        "SyntaxError: Unexpected token '{'",
        "Error: Cannot find module './missing.js'",
        "Error: database connection refused"
      ];

      for (const crashMessage of codeCrashMessages) {
        const report = {
          numTotalTestSuites: 1,
          numPassedTestSuites: 0,
          numFailedTestSuites: 1,
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
              name: "/repo/test/crash.test.ts",
              status: "failed",
              startTime: 1,
              endTime: 2,
              message: "",
              assertionResults: [
                {
                  ancestorTitles: [],
                  fullName: "crash case",
                  status: "failed",
                  title: "crash case",
                  failureMessages: [crashMessage]
                }
              ]
            }
          ]
        };

        expect(() => parseVitestJson(makeOutcome("/repo", report, 1), ["crash case"], false)).toThrow(
          VitestTestCodeFailure
        );
      }
    });

    it("executes real vitest@2.1.9 via bindRunnerProfile across top-level it, nested describe, describe.todo, .rejects.toThrow, and expect.extend", async () => {
      const worktreeRoot = resolve(import.meta.dirname, "../../../..");
      const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-s7-live-vitest-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));

      await symlink(join(worktreeRoot, "node_modules"), join(root, "node_modules"));
      await mkdir(join(root, "test"), { recursive: true });

      const reporterSource = (
        await readFile(join(worktreeRoot, "packages/runtime/dist/agentic/vitest-runtime-reporter.js"), "utf8")
      ).replace(/\n\/\/# sourceMappingURL=.*$/u, "\n");
      const reporterFile = join(root, "vitest-runtime-reporter.mjs");
      await writeFile(reporterFile, reporterSource, { mode: 0o600 });

      await writeFile(
        join(root, "test", "alpha.test.js"),
        `import { describe, expect, it } from "vitest";
expect.extend({
  toMatchDomainInvariant(received) {
    return { pass: received === "ready", message: () => "expected domain invariant ready" };
  }
});
it("top level target", () => {
  console.error("benign stderr diagnostic during test");
  expect("draft").toMatchDomainInvariant();
});
describe("Outer", () => {
  describe("Inner", () => {
    it("nested async target", async () => {
      await expect(Promise.resolve("ok")).rejects.toThrow("expected failure");
    });
    it("unselected sibling", () => {
      expect(1).toBe(1);
    });
  });
});
describe.todo("Planned roadmap suite", () => {
  it("future test", () => {});
});
`
      );
      await writeFile(
        join(root, "test", "beta.test.js"),
        `import { describe, expect, it } from "vitest";
describe("BetaUnselected", () => {
  it("never matched", () => {
    expect(true).toBe(true);
  });
});
`
      );

      const vitestCli = join(root, "node_modules", "vitest", "vitest.mjs");
      const profile: RunnerProfile = {
        id: "vitest-unit",
        command: "vitest run",
        executable: process.execPath,
        args: [
          vitestCli,
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

      const bound = bindRunnerProfile(profile, {
        testNames: ["top level target", "Outer Inner nested async target"],
        testPaths: ["test/alpha.test.js", "test/beta.test.js"]
      });

      const runResult = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolvePromise => {
        execFile(bound.executable, bound.args, { cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
          const exitCode = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 0;
          resolvePromise({ code: exitCode, stdout: String(stdout), stderr: String(stderr) });
        });
      });

      const parsed = parseVitestJson(
        makeOutcome(root, runResult.stdout, runResult.code ?? 1, runResult.stderr),
        bound.testNames,
        true
      );
      expect(parsed.targetFailure).toBe(true);
      expect(parsed.failed).toBe(2);
      expect(parsed.passed).toBe(0);
      expect(parsed.testNames.sort()).toEqual(["Outer Inner nested async target", "top level target"]);
    });

    it("accepts filtered Jest JSON reports with pending sibling suites and TestingLibraryElementError assertions", () => {
      const jestJson = JSON.stringify({
        numTotalTestSuites: 2,
        numPassedTestSuites: 0,
        numFailedTestSuites: 1,
        numPendingTestSuites: 1,
        numRuntimeErrorTestSuites: 0,
        numTotalTests: 2,
        numPassedTests: 0,
        numFailedTests: 1,
        numPendingTests: 1,
        numTodoTests: 0,
        wasInterrupted: false,
        success: false,
        testResults: [
          {
            name: "/repo/test/ui.test.ts",
            status: "failed",
            message: "UI assertion failed",
            assertionResults: [
              {
                ancestorTitles: ["Form"],
                title: "renders error banner",
                fullName: "Form renders error banner",
                status: "failed",
                failureMessages: ["TestingLibraryElementError: Unable to find role=\"alert\""]
              }
            ]
          },
          {
            name: "/repo/test/other.test.ts",
            status: "pending",
            message: "",
            assertionResults: [
              {
                ancestorTitles: ["Other"],
                title: "skipped by testNamePattern",
                fullName: "Other skipped by testNamePattern",
                status: "pending",
                failureMessages: []
              }
            ]
          }
        ]
      });

      const parsed = parseRunnerResult("jest_json", makeOutcome("/repo", jestJson, 1, ""), ["Form renders error banner"]);
      expect(parsed).toEqual({
        testNames: ["Form renders error banner"],
        testResults: [{ name: "Form renders error banner", passed: false }],
        tests: 1,
        passed: 0,
        failed: 1,
        targetFailure: true
      });
    });
  });

  describe("Cluster 3: runtime Git helpers on FUSE/NTFS (safe.directory, linked worktrees, core.fileMode)", () => {
    it("handles linked worktrees, core.fileMode=true +x metadata, and isolated HOME across verificationGit, captureIntegratedChange, pinRunnerDefinitions, rework-causality, and repositoryRead", async () => {
      const cacheParent = resolve(import.meta.dirname, "../../../..", "node_modules", ".cache");
      await mkdir(cacheParent, { recursive: true });
      const mountRoot = await realpath(await mkdtemp(join(cacheParent, "bflow-s7-rt-fuse-")));
      cleanups.push(() => rm(mountRoot, { recursive: true, force: true }));

      const isolatedHome = await realpath(await mkdtemp(join(tmpdir(), "bflow-s7-rt-home-")));
      cleanups.push(() => rm(isolatedHome, { recursive: true, force: true }));

      const repo = join(mountRoot, "repo");
      await mkdir(join(repo, "src"), { recursive: true });
      await rawGit(repo, "init", "-b", "main");
      await rawGit(repo, "config", "user.name", "Bflow Test");
      await rawGit(repo, "config", "user.email", "bflow@example.invalid");
      await writeFile(join(repo, "package.json"), JSON.stringify({ name: "s7-fixture", version: "1.0.0" }) + "\n");
      await writeFile(join(repo, "src", "app.ts"), "export const v = 1;\n");
      await rawGit(repo, "add", ".");
      await rawGit(repo, "commit", "-m", "base");
      const base = await rawGit(repo, "rev-parse", "HEAD");

      // Enable core.fileMode=true and force +x on .git/HEAD and tracked files (reproducing fuseblk/NTFS even on POSIX tmpfs)
      await rawGit(repo, "config", "core.fileMode", "true");
      await chmod(join(repo, ".git", "HEAD"), 0o755);
      await chmod(join(repo, "package.json"), 0o755);
      await chmod(join(repo, "src", "app.ts"), 0o755);

      const linkedWorktree = join(mountRoot, "linked-task");
      await rawGit(repo, "-c", "core.fileMode=false", "worktree", "add", "-b", "task/s7", linkedWorktree, base);
      await writeFile(join(linkedWorktree, "src", "app.ts"), "export const v = 2;\n");
      await chmod(join(linkedWorktree, ".git"), 0o755);
      await chmod(join(linkedWorktree, "package.json"), 0o755);
      await chmod(join(linkedWorktree, "src", "app.ts"), 0o755);
      await rawGit(linkedWorktree, "-c", "core.fileMode=false", "add", "src/app.ts");
      await rawGit(linkedWorktree, "-c", "core.fileMode=false", "commit", "-m", "candidate");
      const head = await rawGit(linkedWorktree, "rev-parse", "HEAD");

      // Isolate HOME so global ~/.gitconfig safe.directory=* cannot rescue missing safe.directory flags
      process.env.HOME = isolatedHome;

      // 1. verificationGit & assertPinnedRevision on linked worktree with core.fileMode=true & +x metadata
      await expect(assertPinnedRevision(linkedWorktree, head)).resolves.toBeUndefined();
      expect((await verificationGit(join(linkedWorktree, "src"), ["rev-parse", "HEAD"])).trim()).toBe(head);

      // 2. repositoryRead git status & diff on linked worktree
      const readStatus = (await repositoryRead(linkedWorktree, { op: "git", action: "status" })) as { output: string };
      expect(readStatus.output).not.toContain("M \"src/app.ts\"");
      expect(readStatus.output).not.toContain("M \"package.json\"");

      // 3. pinRunnerDefinitions
      const detection = await pinRunnerDefinitions(linkedWorktree, {
        status: "detected",
        notes: [],
        profiles: [
          {
            id: "vitest-unit",
            command: "vitest run",
            executable: process.execPath,
            args: ["vitest"],
            method: "unit_test",
            levels: ["unit"],
            reporter: "vitest_json",
            timeoutMs: 10_000,
            checkoutDependencyRoots: [],
            dependencySource: linkedWorktree,
            source: "detected"
          }
        ]
      });
      expect(detection.status).toBe("detected");

      // 4. captureIntegratedChange
      const storeOpened = await openFilesystemArtifactStore({ root: join(isolatedHome, "artifacts"), storeId: "s7-rt-store" });
      if (!storeOpened.ok) throw new Error(storeOpened.error.message);
      const store = storeOpened.value;
      stores.push(store);

      const integrated = await captureIntegratedChange({
        artifactStore: store,
        runId: "run-s7",
        taskId: "task-s7",
        worktreePath: linkedWorktree,
        branchName: "task/s7",
        baseRevision: base,
        headCommitHash: head
      });
      expect(integrated.filesChanged.map(f => f.path)).toEqual(["src/app.ts"]);

      // 5. rework-causality validateAndStoreReworkResolution (inspectWorktreeRevision -> gitInWorktree)
      const dossier = await validateAndStoreReworkResolution({
        reworkContext: {
          schemaVersion: 1,
          runId: "run-s7",
          taskId: "task-s7",
          attempt: 1,
          attemptId: "attempt-1",
          reworkGeneration: 1,
          coreGeneration: 1,
          cycleId: "cycle-1",
          failedVerificationId: "verify-1",
          failedCycleNumber: 1,
          failedRevision: base,
          remainingIterations: 2,
          maxIterations: 3,
          findings: [
            {
              findingId: "f-1",
              findingIndex: 0,
              reworkGeneration: 1,
              verificationId: "verify-1",
              cycleNumber: 1,
              code: "check_failed",
              severity: "error",
              message: "Expected v = 2"
            }
          ]
        },
        findingResolutionsInput: [
          {
            findingId: "f-1",
            disposition: "addressed",
            rootCause: "v remained 1 in src/app.ts",
            hypothesisConfirmed: true,
            sourceLocations: [{ path: "src/app.ts", startLine: 1, endLine: 1 }],
            repairSummary: "Updated exported constant v to 2",
            discriminatingCheck: {
              kind: "unit_test",
              target: "src/app.ts",
              beforeOutcome: "v was 1 (failed)",
              afterOutcome: "v is 2 (passed)",
              exitCode: 0
            },
            evidence: {
              reworkGeneration: 1,
              sourceRevision: head,
              summary: "Verified v = 2 at new HEAD"
            }
          }
        ],
        worktreePath: linkedWorktree,
        ownedPaths: ["src"],
        submissionStatus: "succeeded",
        submittedByAgentId: "dev-s7",
        submittedAt: "2026-10-31T08:00:00Z",
        artifactStore: store
      });
      expect(dossier.submittedRevision).toBe(head);
    });
  });

  describe("Cluster 4C: test-integrity multi-line evidence anchors & Vitest/Node assert aliases", () => {
    it("accepts multi-line committed Reviewer evidence excerpts in validateTestIntegrityEvidence while rejecting fabricated lines", async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-s7-ti-multiline-")));
      cleanups.push(() => rm(root, { recursive: true, force: true }));

      await mkdir(join(root, "test"), { recursive: true });
      await rawGit(root, "init", "-b", "main");
      await rawGit(root, "config", "user.name", "Bflow Test");
      await rawGit(root, "config", "user.email", "bflow@example.invalid");

      await writeFile(
        join(root, "test", "calc.test.ts"),
        `import { expect, test } from "vitest";\ntest(\n  "computes sum",\n  () => {\n    expect(1 + 2).toBe(3);\n  }\n);\n`
      );
      await rawGit(root, "add", ".");
      await rawGit(root, "commit", "-m", "base");
      const base = await rawGit(root, "rev-parse", "HEAD");

      await writeFile(
        join(root, "test", "calc.test.ts"),
        `import { expect, test } from "vitest";\nconst add = (a: number, b: number) => a + b;\ntest(\n  "computes total",\n  () => {\n    expect(add(1, 2)).toEqual(3);\n  }\n);\n`
      );
      await rawGit(root, "add", ".");
      await rawGit(root, "commit", "-m", "candidate");
      const candidate = await rawGit(root, "rev-parse", "HEAD");

      const report = await measureTestIntegrity(root, base, candidate);
      expect(report.findings.length).toBeGreaterThan(0);

      // Multi-line excerpt starting at line 3 matching lines 3-7 of candidate
      await expect(
        validateTestIntegrityEvidence(root, report, [
          {
            findingId: report.findings[0]!.id,
            verdict: "equivalent",
            reason: "Extracted local add helper with identical arithmetic assertion semantics",
            evidence: [
              {
                revision: candidate,
                path: "test/calc.test.ts",
                line: 3,
                excerpt: `test(\n  "computes total",\n  () => {\n    expect(add(1, 2)).toEqual(3);\n  }`
              }
            ]
          }
        ])
      ).resolves.toBeUndefined();

      // Fabricated second line in multi-line excerpt MUST still be rejected
      await expect(
        validateTestIntegrityEvidence(root, report, [
          {
            findingId: report.findings[0]!.id,
            verdict: "equivalent",
            reason: "Fabricated multi-line excerpt test",
            evidence: [
              {
                revision: candidate,
                path: "test/calc.test.ts",
                line: 3,
                excerpt: `test(\n  "FABRICATED TITLE",\n  () => {`
              }
            ]
          }
        ])
      ).rejects.toThrow(/Test-integrity evidence excerpt does not match/);
    });

    it("recognizes Vitest named assert imports without false TI_UNSUPPORTED_ASSERTION_API and detects node:assert strict alias tautologies/weakening", () => {
      const base = "a".repeat(40);
      const candidate = "b".repeat(40);

      // 1. `import { assert, it } from "vitest"` unchanged/refactored cleanly -> NO TI_UNSUPPORTED_ASSERTION_API
      const cleanVitestAssert = analyzeTestIntegrity({
        baseRevision: base,
        candidateRevision: candidate,
        files: [
          {
            path: "test/vitest-assert.test.ts",
            base: `import { assert, it } from "vitest";\nit("checks value", () => {\n  assert.equal(compute(), 42);\n});\n`,
            candidate: `import { assert, it } from "vitest";\nit("checks value", () => {\n  assert.equal(compute(), 42);\n});\n`
          }
        ]
      });
      expect(cleanVitestAssert.findings.filter(f => f.ruleId === "TI_UNSUPPORTED_ASSERTION_API")).toEqual([]);

      // 2. `import { strict as assert } from "node:assert"` tautology & assertion weakening MUST be caught
      const strictAliasWeakened = analyzeTestIntegrity({
        baseRevision: base,
        candidateRevision: candidate,
        files: [
          {
            path: "test/node-strict-alias.test.ts",
            base: `import { test } from "node:test";\nimport { strict as assert } from "node:assert";\ntest("checks auth", () => {\n  assert.equal(verifyToken(), true);\n});\n`,
            candidate: `import { test } from "node:test";\nimport { strict as assert } from "node:assert";\ntest("checks auth", () => {\n  assert.equal(true, true);\n});\n`
          }
        ]
      });
      expect(strictAliasWeakened.findings.map(f => f.ruleId)).toContain("TI_LITERAL_TAUTOLOGY");
    });
  });
});
