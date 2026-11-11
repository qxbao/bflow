import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertStaticAnalyzersAvailableSync,
  assertTrustedExecutable,
  buildStaticAnalyzers,
  checkBalancedExpressions,
  createJvmCompileAnalyzer,
  createOwnerAnalyzer,
  githubActionsAnalyzer,
  javascriptAnalyzer,
  jsonAnalyzer,
  jvmCompileAnalyzer,
  parseStaticAnalyzers,
  shellAnalyzer,
  whitespaceAnalyzer,
  xmlAnalyzer,
  yamlAnalyzer
} from "../../src/agentic/static-analyzers.js";
import { WorkflowProposalRejected } from "../../src/agentic/workflow-rejection.js";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => {});
  }
});

async function createTestRepo() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-static-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd: root,
      encoding: "utf8"
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  await writeFile(join(root, "README.md"), "# Test Repo\n");
  git("add", ".");
  git("commit", "-m", "initial commit");
  const baseRevision = git("rev-parse", "HEAD");
  const commit = (msg: string) => {
    git("add", ".");
    git("commit", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  return { root, git, baseRevision, commit };
}

describe("static-analyzers", () => {
  describe("checkBalancedExpressions", () => {
    it("accepts valid ${{ ... }} expressions", () => {
      expect(checkBalancedExpressions("echo ${{ github.sha }}")).toBe(true);
      expect(checkBalancedExpressions("run: ${{ matrix.node }} and ${{ matrix.os }}")).toBe(true);
    });

    it("rejects unclosed ${{ expressions", () => {
      expect(checkBalancedExpressions("echo ${{ github.sha")).toBe(false);
      expect(checkBalancedExpressions("${{ broken")).toBe(false);
    });

    it("rejects nested ${{ expressions", () => {
      expect(checkBalancedExpressions("echo ${{ ${{ nested }} }}")).toBe(false);
    });

    it("accepts literal braces or }} in shell scripts or JSON outside expressions", () => {
      // Must not reject legitimate shell commands or json with braces/}}
      expect(checkBalancedExpressions("awk '{print $1}}' file.txt")).toBe(true);
      expect(checkBalancedExpressions("echo '{\"key\": \"value\"}}'")).toBe(true);
      expect(checkBalancedExpressions("if [ -z \"$X\" ]; then echo \"}};\" fi")).toBe(true);
    });
  });

  describe("yamlAnalyzer and duplicate key rejection", () => {
    it("passes valid YAML with unique keys", async () => {
      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "config.yml"), "server:\n  port: 8080\n  host: 127.0.0.1\n");
      const rev = commit("add valid config");
      const result = await yamlAnalyzer.run({ cwd: root, revision: rev, files: ["config.yml"] });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("YAML check passed for config.yml");
    });

    it("rejects YAML with duplicate keys", async () => {
      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "duplicate.yml"), "name: one\nname: two\n");
      const rev = commit("add duplicate keys");
      const result = await yamlAnalyzer.run({ cwd: root, revision: rev, files: ["duplicate.yml"] });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Map keys must be unique");
    });

    it("rejects malformed YAML syntax", async () => {
      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "broken.yml"), "name: [broken\n");
      const rev = commit("add broken yaml");
      const result = await yamlAnalyzer.run({ cwd: root, revision: rev, files: ["broken.yml"] });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("YAML parse error");
    });
  });

  describe("githubActionsAnalyzer", () => {
    it("passes valid workflow with runs-on string, array, and object form", async () => {
      const { root, commit } = await createTestRepo();
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      const workflow = `
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: |
          awk '{print $1}}' file.txt
          echo '{"ok": true}}'
  multi:
    runs-on: [self-hosted, linux]
    steps:
      - run: echo multi
  grouped:
    runs-on:
      group: test-runners
      labels: [ubuntu-22.04]
    steps:
      - run: echo grouped
`;
      await writeFile(join(root, ".github/workflows/ci.yml"), workflow);
      const rev = commit("add valid ci workflow");
      const result = await githubActionsAnalyzer.run({
        cwd: root,
        revision: rev,
        files: [".github/workflows/ci.yml"]
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Phân tích cú pháp và cấu trúc. Không chứng minh hành vi CI.");
    });

    it("passes valid reusable workflow calls without runs-on or steps", async () => {
      const { root, commit } = await createTestRepo();
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      const caller = `
name: Caller
on:
  workflow_call:
jobs:
  call:
    uses: octo-org/shared/.github/workflows/reusable.yml@main
    with:
      env: prod
`;
      await writeFile(join(root, ".github/workflows/caller.yml"), caller);
      const rev = commit("add caller workflow");
      const result = await githubActionsAnalyzer.run({
        cwd: root,
        revision: rev,
        files: [".github/workflows/caller.yml"]
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("Workflow check passed for .github/workflows/caller.yml");
    });

    it("rejects reusable workflow call that also specifies steps", async () => {
      const { root, commit } = await createTestRepo();
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      const badCaller = `
name: Bad Caller
on: push
jobs:
  call:
    uses: octo-org/shared/.github/workflows/reusable.yml@main
    steps:
      - run: echo disallowed
`;
      await writeFile(join(root, ".github/workflows/bad-caller.yml"), badCaller);
      const rev = commit("add bad caller");
      const result = await githubActionsAnalyzer.run({
        cwd: root,
        revision: rev,
        files: [".github/workflows/bad-caller.yml"]
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("cannot specify 'steps'");
    });

    it("rejects ordinary job missing steps or runs-on", async () => {
      const { root, commit } = await createTestRepo();
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      const noSteps = `
name: No Steps
on: push
jobs:
  test:
    runs-on: ubuntu-latest
`;
      await writeFile(join(root, ".github/workflows/no-steps.yml"), noSteps);
      const rev = commit("add no steps workflow");
      const result = await githubActionsAnalyzer.run({
        cwd: root,
        revision: rev,
        files: [".github/workflows/no-steps.yml"]
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("must specify a non-empty 'steps' array");
    });

    it("rejects step specifying both run and uses", async () => {
      const { root, commit } = await createTestRepo();
      await mkdir(join(root, ".github/workflows"), { recursive: true });
      const both = `
name: Both
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        run: echo both
`;
      await writeFile(join(root, ".github/workflows/both.yml"), both);
      const rev = commit("add both run and uses step");
      const result = await githubActionsAnalyzer.run({
        cwd: root,
        revision: rev,
        files: [".github/workflows/both.yml"]
      });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("cannot specify both 'run' and 'uses'");
    });
  });

  describe("javascriptAnalyzer and jsonAnalyzer", () => {
    it("passes valid JS and rejects invalid JS", async () => {
      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "valid.js"), "const x = 42;\nmodule.exports = { x };\n");
      const rev1 = commit("add valid js");
      const res1 = await javascriptAnalyzer.run({ cwd: root, revision: rev1, files: ["valid.js"] });
      expect(res1.exitCode).toBe(0);

      await writeFile(join(root, "invalid.js"), "const x = ;\n");
      const rev2 = commit("add invalid js");
      const res2 = await javascriptAnalyzer.run({ cwd: root, revision: rev2, files: ["invalid.js"] });
      expect(res2.exitCode).toBe(1);
      expect(res2.output).toContain("JavaScript syntax error in invalid.js");
    });

    it("passes valid JSON and rejects invalid JSON", async () => {
      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "valid.json"), '{"name": "test", "count": 10}\n');
      const rev1 = commit("add valid json");
      const res1 = await jsonAnalyzer.run({ cwd: root, revision: rev1, files: ["valid.json"] });
      expect(res1.exitCode).toBe(0);

      await writeFile(join(root, "invalid.json"), '{"name": "test",\n');
      const rev2 = commit("add invalid json");
      const res2 = await jsonAnalyzer.run({ cwd: root, revision: rev2, files: ["invalid.json"] });
      expect(res2.exitCode).toBe(1);
      expect(res2.output).toContain("JSON syntax error in invalid.json");
    });
  });

  describe("shellAnalyzer", () => {
    it("rejects bash-only syntax in a script explicitly declaring POSIX sh", async () => {
      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "script.sh"), "#!/bin/sh\nvalues=(one two)\n");
      const revision = commit("add bash syntax to sh script");
      const result = await shellAnalyzer.run({ cwd: root, revision, files: ["script.sh"] });
      expect(result.exitCode).not.toBe(0);
    });

    it("keeps Bash syntax valid when a .sh script explicitly declares Bash", async () => {
      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "script.sh"), "#!/usr/bin/env bash\nvalues=(one two)\n");
      const revision = commit("add explicit bash script");
      const result = await shellAnalyzer.run({ cwd: root, revision, files: ["script.sh"] });
      expect(result.exitCode).toBe(0);
    });
    it("detects shell availability and validates shell syntax", async () => {
      const detect = await shellAnalyzer.detect({ cwd: "." });
      expect(detect.status).toBe("available");

      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "script.sh"), "#!/bin/sh\nset -eu\necho 'hello world'\n");
      const rev1 = commit("add valid shell");
      const res1 = await shellAnalyzer.run({ cwd: root, revision: rev1, files: ["script.sh"] });
      expect(res1.exitCode).toBe(0);

      await writeFile(join(root, "broken.sh"), "#!/bin/sh\nif [ a = b\n");
      const rev2 = commit("add broken shell");
      const res2 = await shellAnalyzer.run({ cwd: root, revision: rev2, files: ["broken.sh"] });
      expect(res2.exitCode).toBeGreaterThanOrEqual(1);
      expect(res2.output).toContain("Shell syntax error in broken.sh");
    });
  });

  describe("jvmCompileAnalyzer", () => {
    it("compiles committed Java tests with the real offline Maven sandbox and rejects invalid test source", async test => {
      const { root, commit } = await createTestRepo();
      try { execFileSync("mvn", ["--version"], { stdio: "ignore" }); }
      catch { test.skip(); return; }
      if ((await probeBehavioralSandbox(root)).status !== "ready") { test.skip(); return; }
      await writeFile(join(root, ".gitignore"), "target/\n");
      await writeFile(join(root, "pom.xml"), '<project><modelVersion>4.0.0</modelVersion><groupId>bflow.acceptance</groupId><artifactId>compile</artifactId><version>1</version><properties><maven.compiler.release>17</maven.compiler.release></properties><build><plugins><plugin><artifactId>maven-resources-plugin</artifactId><version>3.3.1</version></plugin><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.11.0</version></plugin></plugins></build></project>\n');
      const base = commit("configure offline compiler");
      const runners = new TestRunnerSource([], root);
      expect((await runners.refresh())?.status).toBe("detected");
      const file = "src/test/java/CompileOnlyTest.java";
      await mkdir(join(root, "src/test/java"), { recursive: true });
      await writeFile(join(root, file), "class CompileOnlyTest {}\n");
      const revision = commit("add valid test source");
      const passed = await jvmCompileAnalyzer.run({ cwd: root, base, revision, files: [file], testPaths: [file], runners });
      if (/Cannot access .*offline|has not been downloaded|could not be resolved/i.test(passed.output)) {
        console.info(`Offline Java compiler fixture unavailable: ${passed.output}`);
        test.skip(); return;
      }
      expect(passed.exitCode, passed.output).toBe(0);
      await writeFile(join(root, file), "class CompileOnlyTest { invalid java }\n");
      const invalid = commit("introduce invalid test source");
      const failed = await jvmCompileAnalyzer.run({ cwd: root, base, revision: invalid, files: [file], testPaths: [file], runners });
      expect(failed.exitCode, failed.output).not.toBe(0);
      expect(failed.output).toMatch(/compilation|expected/i);
      expect(failed.output).not.toContain("Runner definitions differ");
    }, 60_000);
    it("selects the nearest JVM project and forwards the original revision and selected test paths", async () => {
      const { root, commit, baseRevision } = await createTestRepo();
      const file = "group/leaf/src/test/java/LeafTest.java";
      await mkdir(join(root, "group/leaf/src/test/java"), { recursive: true });
      await writeFile(join(root, file), "class LeafTest {}\n");
      const revision = commit("add leaf test");
      const profiles = ["group", "group/leaf"].map(project => ({
        id: `maven-${project}`, command: "auto:unit", timeoutMs: 60_000,
        adapter: { adapterId: "maven", projectDirectory: project }
      })) as RunnerProfile[];
      const calls: unknown[][] = [];
      const analyzer = createJvmCompileAnalyzer(async (...args) => {
        calls.push(args);
        return { exitCode: 0, output: "compiled" };
      });
      const result = await analyzer.run({ cwd: root, base: baseRevision, revision, files: [file],
        testPaths: [file], runners: { profilesForRevision: () => profiles } as any });
      expect(result.exitCode).toBe(0);
      expect((calls[0]![0] as RunnerProfile).adapter?.projectDirectory).toBe("group/leaf");
      expect(calls[0]!.slice(1)).toEqual([root, revision, baseRevision, [file]]);
    });

    it("recalculates the shared deadline before compiling the next project", async () => {
      const { root, commit } = await createTestRepo();
      await mkdir(join(root, "one")); await mkdir(join(root, "two"));
      await writeFile(join(root, "one/One.java"), "class One {}\n");
      await writeFile(join(root, "two/Two.java"), "class Two {}\n");
      const revision = commit("add independent projects");
      let now = Date.now(); const deadlineAt = now + 40_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const compiled: string[] = [];
      const analyzer = createJvmCompileAnalyzer(async profile => {
        compiled.push(profile.adapter!.projectDirectory);
        now += 45_000;
        return { exitCode: 0, output: "compiled" };
      });
      const profiles = ["one", "two"].map(project => ({ id: `maven-${project}`, command: "auto:unit",
        timeoutMs: 60_000, adapter: { adapterId: "maven", projectDirectory: project } })) as RunnerProfile[];
      const result = await analyzer.run({ cwd: root, revision, files: ["one/One.java", "two/Two.java"],
        deadlineAt, runners: { profilesForRevision: () => profiles } as any });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("deadline");
      expect(compiled).toEqual(["one"]);
    });
    it("fails when cwd does not exist or revision is invalid", async () => {
      const res = await jvmCompileAnalyzer.run({
        cwd: "/does-not-exist",
        revision: "invalid",
        files: ["Broken.java"]
      });
      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("JVM compile check cannot read committed file at revision invalid");
    });

    it("invokes runner boundary with revision-pinned offline sandboxed Maven test-compile args", async () => {
      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "Test.java"), "public class Test {}\n");
      const rev = commit("add test java");

      let receivedProfile: RunnerProfile | undefined;
      let receivedRevision: string | undefined;

      const mockRunner = async (profile: RunnerProfile, cwd: string, revision: string) => {
        receivedProfile = profile;
        receivedRevision = revision;
        return { exitCode: 0, output: "Mock compiler output" };
      };

      const customJvm = createJvmCompileAnalyzer(mockRunner);
      const fakeRunners = {
        profilesForRevision: () => [
          {
            id: "maven",
            command: "mvn",
            executable: "/usr/bin/mvn",
            args: ["test"],
            method: "integration_test" as const,
            levels: ["integration" as const],
            reporter: "node_tap" as const,
            timeoutMs: 60000,
            checkoutDependencyRoots: [],
            dependencySource: root,
            source: "detected" as const,
            adapter: {
              adapterId: "maven",
              version: "3.9.6",
              executable: "/usr/bin/mvn",
              projectDirectory: ".",
              format: "junit" as const,
              nameRule: "fqn",
              mounts: [],
              environment: {},
              protectedPaths: [],
              bind: () => ({ args: ["test"] })
            }
          }
        ]
      } as any;

      const res = await customJvm.run({
        cwd: root,
        revision: rev,
        files: ["Test.java"],
        runners: fakeRunners
      });

      expect(res.exitCode).toBe(0);
      expect(receivedRevision).toBe(rev);
      expect(receivedProfile?.args).toEqual([
        "--offline",
        "--batch-mode",
        "--no-transfer-progress",
        "-Dmaven.repo.local=/bflow-cache/maven",
        "test-compile"
      ]);
    });

    it("reports nonzero exit code when compiler runner fails", async () => {
      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "Broken.java"), "class Broken { invalid syntax }\n");
      const rev = commit("add broken java");

      const mockRunner = async () => ({
        exitCode: 1,
        output: "[ERROR] Broken.java:1: ';' expected"
      });

      const customJvm = createJvmCompileAnalyzer(mockRunner);
      const fakeRunners = {
        profilesForRevision: () => [
          {
            id: "maven",
            command: "mvn",
            executable: "/usr/bin/mvn",
            args: ["test"],
            method: "integration_test" as const,
            levels: ["integration" as const],
            reporter: "node_tap" as const,
            timeoutMs: 60000,
            checkoutDependencyRoots: [],
            dependencySource: root,
            source: "detected" as const
          }
        ]
      } as any;

      const res = await customJvm.run({
        cwd: root,
        revision: rev,
        files: ["Broken.java"],
        runners: fakeRunners
      });

      expect(res.exitCode).toBe(1);
      expect(res.output).toContain("[ERROR] Broken.java:1: ';' expected");
    });

    it("correctly selects JVM project by scope among independent projects and fails unmapped files", async () => {
      const { root, commit } = await createTestRepo();
      await mkdir(join(root, "services/auth"), { recursive: true });
      await mkdir(join(root, "services/billing"), { recursive: true });
      await mkdir(join(root, "other"), { recursive: true });
      await writeFile(join(root, "services/auth/Auth.java"), "public class Auth {}\n");
      await writeFile(join(root, "services/billing/Billing.java"), "public class Billing {}\n");
      await writeFile(join(root, "other/Unmapped.java"), "public class Unmapped {}\n");
      const rev = commit("add services");

      const compiledProjects: string[] = [];
      const mockCompilerRunner = async (profile: any) => {
        const proj = profile.adapter?.projectDirectory;
        compiledProjects.push(proj);
        if (proj === "services/auth") {
          return { exitCode: 1, output: "[ERROR] Auth.java compilation failed" };
        }
        return { exitCode: 0, output: `Project ${proj} compiled` };
      };

      const customJvm = createJvmCompileAnalyzer(mockCompilerRunner);
      const runners = {
        profilesForRevision: () => [
          {
            id: "maven-billing",
            command: "auto:billing",
            timeoutMs: 30000,
            adapter: { adapterId: "maven", projectDirectory: "services/billing" }
          },
          {
            id: "maven-auth",
            command: "auto:auth",
            timeoutMs: 30000,
            adapter: { adapterId: "maven", projectDirectory: "services/auth" }
          }
        ]
      } as any;

      // 1. Files in services/billing: compiles only services/billing
      compiledProjects.length = 0;
      const billingRes = await customJvm.run({
        cwd: root,
        revision: rev,
        files: ["services/billing/Billing.java"],
        runners
      });
      expect(billingRes.exitCode).toBe(0);
      expect(compiledProjects).toEqual(["services/billing"]);

      // 2. Broken sibling in services/auth: compiles services/auth and fails
      compiledProjects.length = 0;
      const authRes = await customJvm.run({
        cwd: root,
        revision: rev,
        files: ["services/auth/Auth.java"],
        runners
      });
      expect(authRes.exitCode).toBe(1);
      expect(compiledProjects).toEqual(["services/auth"]);
      expect(authRes.output).toContain("Auth.java compilation failed");

      // 3. Unmapped file fails with explicit error
      const unmappedRes = await customJvm.run({
        cwd: root,
        revision: rev,
        files: ["other/Unmapped.java"],
        runners
      });
      expect(unmappedRes.exitCode).toBe(1);
      expect(unmappedRes.output).toContain("does not belong to any detected JVM project");

      // 4. Expired deadline fails without running compiler
      compiledProjects.length = 0;
      const expiredRes = await customJvm.run({
        cwd: root,
        revision: rev,
        files: ["services/billing/Billing.java"],
        deadlineAt: Date.now() - 1000,
        runners
      });
      expect(expiredRes.exitCode).toBe(1);
      expect(expiredRes.output).toContain("deadline expired");
      expect(compiledProjects).toEqual([]);
    });
  });

  describe("owner static analyzer and trusted executable validation", () => {
    it("passes an option-like committed filename as data to a real sandboxed owner tool", async test => {
      const { root, commit } = await createTestRepo();
      if ((await probeBehavioralSandbox(root)).status !== "ready") { test.skip(); return; }
      await writeFile(join(root, "--help"), "committed-file-marker\n");
      const revision = commit("add option-like filename");
      const executable = execFileSync("which", ["cat"], { encoding: "utf8" }).trim();
      const analyzer = createOwnerAnalyzer({ id: "read-file", executable,
        args: [], include: ["*"], timeoutMs: 30_000 }, root);
      const result = await analyzer.run({ cwd: root, revision, files: ["--help"] });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toContain("committed-file-marker");
    });
    it("does not invoke an owner analyzer after its deadline has expired", async () => {
      const { root, commit } = await createTestRepo();
      await writeFile(join(root, "input.rs"), "fn main() {}\n");
      const revision = commit("add analyzer input");
      let invoked = false;
      const analyzer = createOwnerAnalyzer({ id: "deadline-check", executable: process.execPath,
        args: [], include: ["*.rs"], timeoutMs: 30_000 }, root, async () => {
        invoked = true; return { exitCode: 0, output: "unchecked success" };
      });
      const result = await analyzer.run({ cwd: root, revision, files: ["input.rs"], deadlineAt: Date.now() - 1 });
      expect(result.exitCode).not.toBe(0);
      expect(invoked).toBe(false);
    });
    it("assertTrustedExecutable validates absolute, executable, and outside repository", async () => {
      const { root } = await createTestRepo();
      const outsideDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-outside-exec-")));
      cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));

      const outsideExec = join(outsideDir, "my-tool.sh");
      await writeFile(outsideExec, "#!/bin/sh\nexit 0\n");
      await chmod(outsideExec, 0o755);

      // Outside repo and executable -> passes
      const resolved = await assertTrustedExecutable(outsideExec, root);
      expect(resolved).toBe(outsideExec);

      // Relative path -> rejected
      await expect(assertTrustedExecutable("my-tool.sh", root)).rejects.toThrow("must be absolute");

      // Inside repository -> rejected
      const insideExec = join(root, "inside-tool.sh");
      await writeFile(insideExec, "#!/bin/sh\nexit 0\n");
      await chmod(insideExec, 0o755);
      await expect(assertTrustedExecutable(insideExec, root)).rejects.toThrow("must be outside repository");

      // Symlink escaping to repo -> rejected
      const symlinkPath = join(outsideDir, "symlink-to-repo");
      await symlink(insideExec, symlinkPath);
      await expect(assertTrustedExecutable(symlinkPath, root)).rejects.toThrow("must be outside repository");

      // Non-executable -> rejected
      const nonExec = join(outsideDir, "not-exec.sh");
      await writeFile(nonExec, "#!/bin/sh\nexit 0\n");
      await chmod(nonExec, 0o644);
      await expect(assertTrustedExecutable(nonExec, root)).rejects.toThrow("not executable");
    });

    it("parseStaticAnalyzers rejects duplicate IDs, unsafe includes, and relative executables", () => {
      // Duplicate IDs
      expect(() =>
        parseStaticAnalyzers([
          { id: "tool-a", executable: "/usr/bin/tool", include: ["*.rs"] },
          { id: "tool-a", executable: "/usr/bin/tool", include: ["*.go"] }
        ])
      ).toThrow("Duplicate static analyzer id: tool-a");

      // Relative executable
      expect(() =>
        parseStaticAnalyzers([{ id: "tool-b", executable: "bin/tool", include: ["*.rs"] }])
      ).toThrow("must be an absolute path");

      // Path traversal in include
      expect(() =>
        parseStaticAnalyzers([{ id: "tool-c", executable: "/usr/bin/tool", include: ["../escape.rs"] }])
      ).toThrow("must be a safe repository-relative path");

      // Reserved built-in IDs
      for (const reserved of ["whitespace", "yaml", "jvm-compile", "json", "shell", "xml"]) {
        expect(() =>
          parseStaticAnalyzers([{ id: reserved, executable: "/usr/bin/tool", include: ["*.txt"] }])
        ).toThrow(`Owner static analyzer ID '${reserved}' is reserved for built-in analyzer`);
        expect(() =>
          createOwnerAnalyzer({ id: reserved, executable: "/usr/bin/tool", args: [], include: ["*.txt"], timeoutMs: 30000 })
        ).toThrow(`Owner static analyzer ID '${reserved}' is reserved for built-in analyzer`);
      }
    });

    it("executes custom owner runner with deadline and revision files", async () => {
      const { root, commit } = await createTestRepo();
      const outsideDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-outside-tool-")));
      cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));

      const outsideExec = join(outsideDir, "runner.sh");
      await writeFile(outsideExec, "#!/bin/sh\nexit 0\n");
      await chmod(outsideExec, 0o755);

      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/lib.rs"), "pub fn ok() {}\n");
      const rev = commit("add rust file");

      let calledWithFiles: readonly string[] = [];
      const customRunner = async (cfg: any, cwd: string, revision: string, files: readonly string[]) => {
        calledWithFiles = files;
        return { exitCode: 0, output: "Rust analyzer passed" };
      };

      const analyzer = createOwnerAnalyzer(
        {
          id: "rust-check",
          executable: outsideExec,
          args: ["check"],
          include: ["src/**/*.rs"],
          timeoutMs: 30000
        },
        root,
        customRunner
      );

      expect(analyzer.matches("src/lib.rs")).toBe(true);
      expect(analyzer.matches("src/other.js")).toBe(false);

      const res = await analyzer.run({
        cwd: root,
        revision: rev,
        files: ["src/lib.rs"]
      });
      expect(res.exitCode).toBe(0);
      expect(calledWithFiles).toEqual(["src/lib.rs"]);
    });
  });

  describe("assertStaticAnalyzersAvailableSync", () => {
    it("throws static_analyzer_missing when an unhandled file extension is planned", () => {
      const analyzers = buildStaticAnalyzers();
      expect(() =>
        assertStaticAnalyzersAvailableSync(["src/main.rs"], analyzers)
      ).toThrowError(WorkflowProposalRejected);

      try {
        assertStaticAnalyzersAvailableSync(["src/main.rs"], analyzers);
      } catch (err: any) {
        expect(err.rejection.code).toBe("static_analyzer_missing");
        expect(err.rejection.reason).toContain("No static analyzer configured for src/main.rs");
      }
    });

    it("throws static_analyzer_missing when JVM runner is missing for Java files", () => {
      const analyzers = buildStaticAnalyzers();
      const emptyRunners = { current: { status: "detected", profiles: [] }, profiles: [] } as any;
      try {
        assertStaticAnalyzersAvailableSync(["src/Main.java"], analyzers, emptyRunners);
      } catch (err: any) {
        expect(err.rejection.code).toBe("static_analyzer_missing");
        expect(err.rejection.reason).toContain("JVM compilation analyzer requires detected Maven or Gradle runner");
      }
    });

    it("passes when all planned file extensions have matching available analyzers", () => {
      const analyzers = buildStaticAnalyzers();
      expect(() =>
        assertStaticAnalyzersAvailableSync(
          [".github/workflows/ci.yml", "package.json", "script.sh"],
          analyzers
        )
      ).not.toThrow();
    });

    it("accepts Java files when owner analyzer is available even if built-in JVM runner is absent", async () => {
      const outsideDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-outside-java-")));
      cleanups.push(() => rm(outsideDir, { recursive: true, force: true }));
      const javaChecker = join(outsideDir, "java-check.sh");
      await writeFile(javaChecker, "#!/bin/sh\nexit 0\n");
      await chmod(javaChecker, 0o755);

      const analyzers = buildStaticAnalyzers([
        { id: "owner-java", executable: javaChecker, args: [], include: ["**/*.java"], timeoutMs: 30000 }
      ]);
      const emptyRunners = { current: { status: "detected", profiles: [] }, profiles: [] } as any;

      // Built-in JVM runner is absent, but owner analyzer handles Java files -> passes
      expect(() =>
        assertStaticAnalyzersAvailableSync(["src/Main.java"], analyzers, emptyRunners)
      ).not.toThrow();
    });

    it("whitespace alone never counts as satisfying a code or config file", () => {
      // Only whitespace analyzer provided
      const whitespaceOnly = buildStaticAnalyzers().filter(a => a.id === "whitespace");
      expect(() =>
        assertStaticAnalyzersAvailableSync(["src/App.java"], whitespaceOnly)
      ).toThrowError(WorkflowProposalRejected);
    });
  });
});
