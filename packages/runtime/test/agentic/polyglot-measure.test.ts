import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HostVerification } from "../../src/agentic/host-verification.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { bindRunnerProfile, measureBehavior, type RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { detectTestRunners } from "../../src/agentic/runner-detection.js";
import { SpecificationSchema, TestStrategySchema } from "@bflow/contracts";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import { createNativeAdapters } from "../../src/agentic/runner-adapters/native.js";
import { TestRunnerSource, describeTestRunners, resolveTaskCommands } from "../../src/agentic/task-commands.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const installedDependencies = fileURLToPath(new URL("../../../../node_modules", import.meta.url));
const sandboxReady = probeBehavioralSandbox();
type Phase = "pass" | "assertion Red" | "infrastructure error";
interface Fixture { files: Record<string, string>; names: string[]; paths: string[] }
interface RunnerCase {
  id: string;
  fixture(phase: Phase): Fixture;
  select(profile: RunnerProfile): boolean;
  /** JavaScript fixtures reuse installed packages without fetching or running package scripts. */
  dependency?: { name: string; major?: number };
}
async function repository(files: Record<string, string>) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "bflow-polyglot-measure-")));
  roots.push(cwd);
  for (const [path, content] of Object.entries({ ".gitignore": "node_modules/\n.venv/\nvenv/\ntarget/\nbuild/\n.gradle/\nbin/\nobj/\n__pycache__/\n.pytest_cache/\n", ...files })) {
    await mkdir(dirname(join(cwd, path)), { recursive: true }); await writeFile(join(cwd, path), content);
  }
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Polyglot Measurement Fixture"); git("config", "user.email", "polyglot@example.test");
  git("add", "."); git("commit", "-m", "pin test and production fixture");
  return { cwd, git, revision: git("rev-parse", "HEAD") };
}
function jsFixture(phase: Phase, runner: "node" | "jest" | "mocha" | "vitest"): Fixture {
  const value = phase === "pass" ? "return 4;" : phase === "assertion Red" ? "return 5;" : 'throw new TypeError("runtime infrastructure");';
  const declaration = runner === "node" ? "const {test}=require('node:test');" : runner === "mocha" ? "const test=it;" : "";
  return {
    files: {
      "package.json": JSON.stringify(runner === "node" ? { scripts: { test: "node --test" } } : { devDependencies: { [runner]: "*" } }),
      "src/value.cjs": `module.exports=()=>{${value}};\n`,
      "tests/behavior.test.cjs": `${declaration} const assert=require('node:assert/strict'); test('target',()=>assert.equal(require('../src/value.cjs')(),4));\n`,
      // Running the whole repository as a substitute for the selected file must fail.
      "tests/unmapped.test.cjs": `${declaration} const assert=require('node:assert/strict'); test('unmapped sentinel',()=>assert.fail('must not execute'));\n`
    }, names: ["target"], paths: ["tests/behavior.test.cjs"]
  };
}
const cases: RunnerCase[] = [
  { id: "node --test", fixture: phase => jsFixture(phase, "node"), select: profile => !profile.adapter && profile.reporter === "node_tap" },
  ...[1, 2, 3].map(major => ({ id: `vitest ${major}`, dependency: { name: "vitest", major }, fixture: (phase: Phase) => jsFixture(phase, "vitest"), select: (profile: RunnerProfile) => !profile.adapter && profile.reporter === "vitest_json" })),
  ...["jest", "mocha"].map(id => ({ id, dependency: { name: id }, fixture: (phase: Phase) => jsFixture(phase, id as "jest" | "mocha"), select: (profile: RunnerProfile) => profile.adapter?.adapterId === id })),
  {
    id: "python pytest", select: profile => profile.adapter?.adapterId === "python",
    fixture: phase => ({ files: {
      "pyproject.toml": '[project]\nname="bflow-measure-fixture"\nversion="0.0.0"\n',
      "value.py": phase === "infrastructure error" ? 'def value():\n    raise TypeError("runtime infrastructure")\n' : `def value():\n    return ${phase === "pass" ? 4 : 5}\n`,
      "tests/test_behavior.py": "from value import value\n\ndef test_target():\n    assert value() == 4\n\ndef test_unmapped_sentinel():\n    assert False, 'must not execute'\n"
    }, names: ["tests.test_behavior.test_target"], paths: ["tests/test_behavior.py"] })
  },
  {
    id: "go", select: profile => profile.adapter?.adapterId === "go",
    fixture: phase => ({ files: {
      "go.mod": "module example.org/bflowfixture\n\ngo 1.20\n",
      "value.go": `package fixture\nfunc Value() int { ${phase === "infrastructure error" ? 'panic("runtime infrastructure")' : `return ${phase === "pass" ? 4 : 5}`} }\n`,
      "value_test.go": 'package fixture\nimport "testing"\nfunc TestTarget(t *testing.T) { if got:=Value(); got!=4 { t.Errorf("assert expected 4, got %d",got) } }\nfunc TestUnmapped(t *testing.T) { t.Fatal("must not execute") }\n'
    }, names: ["example.org/bflowfixture.TestTarget"], paths: ["value_test.go"] })
  },
  {
    id: "rust cargo", select: profile => profile.adapter?.adapterId === "rust",
    fixture: phase => ({ files: {
      "Cargo.toml": '[package]\nname="bflow-measure-fixture"\nversion="0.0.0"\nedition="2021"\n',
      "Cargo.lock": 'version = 3\n\n[[package]]\nname = "bflow-measure-fixture"\nversion = "0.0.0"\n',
      "src/lib.rs": `pub fn value() -> i32 { ${phase === "infrastructure error" ? 'panic!("runtime infrastructure")' : phase === "pass" ? "4" : "5"} }\n#[cfg(test)] mod tests;\n`,
      "src/tests.rs": '#[test]\nfn target() { assert_eq!(crate::value(), 4); }\n#[test]\nfn unmapped() { panic!("must not execute"); }\n'
    }, names: ["tests::target"], paths: ["src/tests.rs"] })
  },
  {
    id: "maven Surefire", select: profile => profile.adapter?.adapterId === "maven",
    fixture: phase => ({ files: {
      "pom.xml": '<project><modelVersion>4.0.0</modelVersion><groupId>bflow.fixture</groupId><artifactId>measurement</artifactId><version>1</version><properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency></dependencies><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>3.3.1</version></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.11.0</version></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin></plugins></build></project>',
      "src/main/java/example/Value.java": `package example; public class Value { public static int value() { ${phase === "infrastructure error" ? 'throw new IllegalStateException("runtime infrastructure");' : `return ${phase === "pass" ? 4 : 5};`} } }`,
      "src/test/java/example/BehaviorTest.java": 'package example; import org.junit.Test; import static org.junit.Assert.*; public class BehaviorTest { @Test public void target() { assertEquals(4,Value.value()); } @Test public void unmapped() { fail("must not execute"); } }'
    }, names: ["example.BehaviorTest.target"], paths: ["src/test/java/example/BehaviorTest.java"] })
  }

  ,{
    id: "Gradle JUnit", select: profile => profile.adapter?.adapterId === "gradle",
    fixture: phase => ({ files: {
      "settings.gradle": "rootProject.name='bflow-fixture'\n",
      "build.gradle": "plugins { id 'java' }\nrepositories { mavenCentral() }\ndependencies { testImplementation 'junit:junit:4.13.2' }\n",
      "src/main/java/example/Value.java": `package example; public class Value { public static int value() { ${phase === "infrastructure error" ? 'throw new IllegalStateException("runtime infrastructure");' : `return ${phase === "pass" ? 4 : 5};`} } }`,
      "src/test/java/example/BehaviorTest.java": 'package example; import org.junit.Test; import static org.junit.Assert.*; public class BehaviorTest { @Test public void target() { assertEquals(4,Value.value()); } @Test public void unmapped(){ fail("must not execute"); } }'
    }, names: ["example.BehaviorTest.target"], paths: ["src/test/java/example/BehaviorTest.java"] })
  },
  {
    id: "dotnet TRX", select: profile => profile.adapter?.adapterId === "dotnet",
    fixture: phase => ({ files: {
      "Behavior.csproj": '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><IsTestProject>true</IsTestProject></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.11.1"/><PackageReference Include="xunit" Version="2.9.2"/><PackageReference Include="xunit.runner.visualstudio" Version="2.8.2"/></ItemGroup></Project>',
      "src/Value.cs": `namespace Fixture; public static class Value { public static int Read() { ${phase === "infrastructure error" ? 'throw new System.InvalidOperationException("runtime infrastructure");' : `return ${phase === "pass" ? 4 : 5};`} } }`,
      "tests/BehaviorTest.cs": 'namespace Fixture; public class BehaviorTest { [Xunit.Fact] public void Target(){ Xunit.Assert.Equal(4,Value.Read()); } [Xunit.Fact] public void Unmapped(){ Xunit.Assert.True(false); } }'
    }, names: ["Fixture.BehaviorTest.Target"], paths: ["tests/BehaviorTest.cs"] })
  },
  {
    id: "RSpec JSON", select: profile => profile.adapter?.adapterId === "rspec",
    fixture: phase => ({ files: {
      "Gemfile": 'source "https://rubygems.org"\ngem "rspec"\n',
      "value.rb": `def value; ${phase === "infrastructure error" ? 'raise TypeError, "runtime infrastructure"' : phase === "pass" ? "4" : "5"}; end\n`,
      "spec/behavior_spec.rb": 'require_relative "../value"\nRSpec.describe "Behavior" do\n  it("target") { expect(value).to eq(4) }\n  it("unmapped") { fail "must not execute" }\nend\n'
    }, names: ["Behavior target"], paths: ["spec/behavior_spec.rb"] })
  },
  {
    id: "Minitest JUnit", select: profile => profile.adapter?.adapterId === "minitest",
    fixture: phase => ({ files: {
      "Gemfile": 'source "https://rubygems.org"\ngem "minitest"\n',
      "value.rb": `def value; ${phase === "infrastructure error" ? 'raise TypeError, "runtime infrastructure"' : phase === "pass" ? "4" : "5"}; end\n`,
      "test/behavior_test.rb": 'require "minitest/autorun"\nrequire_relative "../value"\nclass BehaviorTest < Minitest::Test\n  def test_target; assert_equal 4,value; end\n  def test_unmapped; flunk "must not execute"; end\nend\n'
    }, names: ["BehaviorTest.test_target"], paths: ["test/behavior_test.rb"] })
  },
  {
    id: "PHPUnit JUnit", select: profile => profile.adapter?.adapterId === "phpunit",
    fixture: phase => ({ files: {
      "composer.json": '{"require-dev":{"phpunit/phpunit":"*"}}',
      "value.php": `<?php namespace Fixture; function value() { ${phase === "infrastructure error" ? 'throw new \\TypeError("runtime infrastructure");' : `return ${phase === "pass" ? 4 : 5};`} }`,
      "tests/BehaviorTest.php": '<?php namespace Fixture; require __DIR__."/../value.php"; final class BehaviorTest extends \\PHPUnit\\Framework\\TestCase { public function testTarget(): void { $this->assertSame(4,value()); } public function testUnmapped(): void { $this->fail("must not execute"); } }'
    }, names: ["Fixture\\BehaviorTest.testTarget"], paths: ["tests/BehaviorTest.php"] })
  }

];

for (const candidate of cases) describe(`production independent measurement: ${candidate.id}`, () => {
  for (const phase of ["pass", "assertion Red", "infrastructure error"] as const) it(phase, async context => {
    const readiness = await sandboxReady;
    if (readiness.status !== "ready") {
      context.skip(); // Explicit unsupported-host skip: never substitute an unsandboxed run.
      return;
    }
    if (candidate.dependency) {
      let version: string;
      try { version = String(JSON.parse(await readFile(join(installedDependencies, candidate.dependency.name, "package.json"), "utf8")).version); }
      catch { context.skip(); return; } // Runner package is not installed on this host.
      if (candidate.dependency.major !== undefined && Number(version.split(".")[0]) !== candidate.dependency.major) { context.skip(); return; }
    }
    const fixture = candidate.fixture(phase), repo = await repository(fixture.files);
    if (candidate.dependency) {
      await cp(await realpath(installedDependencies), join(repo.cwd, "node_modules"), { recursive: true, verbatimSymlinks: true });
    }
    const detected = await detectTestRunners(repo.cwd);
    const profile = detected.status === "detected" ? detected.profiles.find(value => value.method === "unit_test" && candidate.select(value)) : undefined;
    if (!profile && !candidate.dependency && candidate.id !== "node --test") { context.skip(); return; } // Toolchain or ready test environment is unavailable.
    expect(profile, detected.status === "unsupported" ? detected.reason : detected.notes.join("; ")).toBeDefined();
    if (!profile) throw new Error("installed runner was not detected");
    const command = bindRunnerProfile(profile, { testNames: fixture.names, testPaths: fixture.paths });
    if (phase === "infrastructure error") {
      await expect(measureBehavior(command, repo.cwd, repo.revision)).rejects.toThrow();
    } else {
      const measured = await measureBehavior(command, repo.cwd, repo.revision);
      expect(measured).toMatchObject({ sourceRevision: repo.revision, tests: 1, testNames: fixture.names,
        passed: phase === "pass" ? 1 : 0, failed: phase === "pass" ? 0 : 1, targetFailure: phase !== "pass" });
      expect(measured.testResults).toEqual([{ name: fixture.names[0], passed: phase === "pass" }]);
    }
    expect(repo.git("status", "--porcelain")).toBe("");
    expect(repo.git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  }, 180_000);
});

it("catalogs Go + Python + TypeScript together and resolves the accepted task to its own adapter", async () => {
  const tools = await repository({ "bin/go": "host Go fixture", "bin/python3": "host Python fixture", "pkg/.keep": "" });
  const home = await repository({ ".keep": "synthetic home, never mounted" });
  for (const name of ["go", "python3"]) await chmod(join(tools.cwd, "bin", name), 0o755);
  const repo = await repository({
    "package.json": JSON.stringify({ devDependencies: { vitest: "2.1.9" } }),
    "node_modules/vitest/package.json": '{"version":"2.1.9"}', "node_modules/vitest/vitest.mjs": "", // Discovery fixture; no process executes this file.
    "tests/behavior.test.ts": "import {test,expect} from 'vitest'; test('TypeScript target',()=>expect(2+2).toBe(4));",
    "go/go.mod": "module example.org/fixture\n\ngo 1.20\n", "go/value_test.go": "package fixture\n",
    "python/pyproject.toml": '[project]\nname="python-fixture"\n', "python/tests/test_behavior.py": "def test_target(): assert 2+2 == 4\n"
  });
  await mkdir(join(repo.cwd, "python/.venv/bin"), { recursive: true });
  await symlink(join(tools.cwd, "bin/python3"), join(repo.cwd, "python/.venv/bin/python"));
  await mkdir(join(repo.cwd, "python/.venv/lib/python3.12/site-packages/pytest"), { recursive: true });
  await writeFile(join(repo.cwd, "python/.venv/lib/python3.12/site-packages/pytest/__init__.py"), "");
  const adapters = createNativeAdapters({ home: home.cwd, environment: { PATH: join(tools.cwd, "bin") },
    probe: async (path, args) => path.endsWith("/go") ? args[0] === "version" ? "go version go1.23.4 linux/amd64" : tools.cwd : "Python 3.12.3" });
  const source = new TestRunnerSource([], repo.cwd, root => detectTestRunners(root, { adapters }));
  const detected = await source.refresh();
  expect(detected, detected?.status === "unsupported" ? detected.reason : "").toMatchObject({ status: "detected" });
  const catalog = describeTestRunners(source);
  const wanted = [
    { command: "auto:unit:javascript", path: "tests/behavior.test.ts", name: "TypeScript target", adapter: undefined },
    { command: "auto:unit:go:go", path: "go/value_test.go", name: "example.org/fixture.TestTarget", adapter: "go" },
    { command: "auto:unit:python:python", path: "python/tests/test_behavior.py", name: "tests.test_behavior.test_target", adapter: "python" }
  ];
  for (const target of wanted) {
    const selectedProfile = source.profiles.find(profile => target.adapter === undefined ? profile.command === target.command : profile.method === "unit_test" && profile.adapter?.adapterId === target.adapter && target.path.startsWith(profile.adapter.projectDirectory + "/"));
    expect(selectedProfile).toBeDefined(); target.command = selectedProfile!.command;
    expect(catalog.testRunners.some(entry => entry.command === target.command)).toBe(true);
    const assessed = assessment("domain_logic", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: target.command, level: "unit" }] } });
    const specification = SpecificationSchema.parse({ ...spec(assessed, "unit_test"), affectedPaths: wanted.map(value => value.path) });
    const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification), criterionMappings: [{ criterionId: "ac-1", testNames: [target.name] }] });
    const commands = resolveTaskCommands({ owner: [], profiles: source.profiles, specification, strategy, ownedPaths: [target.path] });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: target.command, testNames: [target.name], testPaths: [target.path] });
    expect(commands[0]!.adapter?.adapterId).toBe(target.adapter);
  }
  const native = wanted.filter(target => target.adapter !== undefined);
  const assessed = assessment("domain_logic", { infrastructure: { readiness: "ready", commands: native.map(target => ({ method: "unit_test", command: target.command, level: "unit" })) } });
  const base = spec(assessed, "unit_test");
  const specification = SpecificationSchema.parse({ ...base, affectedPaths: native.map(target => target.path), acceptanceCriteria: native.map((target, index) => ({ ...base.acceptanceCriteria[0], id: `ac-${index + 1}` })) });
  const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification), criterionMappings: native.map((target, index) => ({ criterionId: `ac-${index + 1}`, testNames: [target.name] })) });
  const checks = new HostVerification(() => ({} as AgenticWorkflowRuntime), () => { throw new Error("unused"); }, undefined, source).behavioralChecks(specification, strategy);
  expect(checks).toHaveLength(2);
  for (const target of native) {
    const check = checks.find(item => (item.configuration as { command: string }).command === target.command)!;
    expect(check.metadata?.boundRunnerIdentities).toBe(true);
    expect((check.configuration as { testNames: string[] }).testNames).toEqual([target.name]);
  }
  const bound = resolveTaskCommands({ owner: [], profiles: source.profiles, specification, strategy });
  expect(bound).toHaveLength(2);
  for (const target of native) expect(bound.find(command => command.command === target.command)).toMatchObject({ testNames: [target.name], testPaths: [target.path] });
  const pythonTask = resolveTaskCommands({ owner: [], profiles: source.profiles, specification, strategy, ownedPaths: [native[1]!.path] });
  expect(pythonTask).toHaveLength(1); expect(pythonTask[0]!.testNames).toEqual([native[1]!.name]);

});
