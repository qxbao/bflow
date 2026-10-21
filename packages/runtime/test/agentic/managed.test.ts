import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedAdapters, managedAdapters, type ManagedAdapterHost } from "../../src/agentic/runner-adapters/managed.js";
import type { AdapterContext, AdapterRunner } from "../../src/agentic/runner-adapter.js";
import { parseRunnerResult } from "../../src/agentic/runner-results.js";
import { missingOfflineFixturePrerequisites } from "../helpers/offline-fixture-cache.js";

const temporary: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(files: Record<string, string>): Promise<AdapterContext> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-managed-"))); temporary.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content);
  }
  return { root, files: Object.keys(files) };
}

function host(homeDirectory: string, unavailable: string[] = []): ManagedAdapterHost {
  return { homeDirectory, async findTool(name) { return unavailable.includes(name) ? undefined : {
    executable: `/usr/bin/${name}`, version: "8.1.2",
    ...(name === "phpunit" ? { phpEntrypoint: true } : {}),
    ...(name === "php" ? { phpRuntime: { extensionDirectory: "/usr/lib/php/test", builtinExtensions: ["ctype", "dom", "filter", "json", "libxml", "mbstring", "phar", "tokenizer", "xml", "xmlwriter", "zlib"] } } : {})
  }; } };
}

async function detected(id: string, files: Record<string, string>) {
  const context = await fixture(files);
  const result = await createManagedAdapters(host(join(context.root, "home"))).find(adapter => adapter.id === id)!.detect(context);
  expect(result.notes).toEqual([]); expect(result.runners).toHaveLength(1);
  return { context, runner: result.runners[0]! };
}

describe("offline measurement fixture prerequisites", () => {
  it("requires the Maven lifecycle plugins even when JUnit and Surefire are cached", async () => {
    const context = await fixture(Object.fromEntries([
      ["junit/junit/4.13.2/junit-4.13.2", "org/apache/maven/plugins/maven-surefire-plugin/3.2.5/maven-surefire-plugin-3.2.5"]
        .flatMap(path => ["jar", "pom"].map(extension => [`cache/${path}.${extension}`, "cached artifact"]))
    ].flat()));
    const missing = await missingOfflineFixturePrerequisites({ adapterId: "maven", mounts: [{ source: join(context.root, "cache"), target: "/bflow-cache/maven" }] });
    expect(missing).toContain("Maven offline artifact org/apache/maven/plugins/maven-resources-plugin/3.3.1/maven-resources-plugin-3.3.1.jar");
    expect(missing.some(path => path.includes("junit-4.13.2"))).toBe(false);
    expect(missing.some(path => path.includes("maven-surefire-plugin-3.2.5"))).toBe(false);
  });

  it("requires Gradle offline descriptors as well as dependency JARs and POMs", async () => {
    const files: Record<string, string> = {};
    for (const [group, name, version] of [["junit", "junit", "4.13.2"], ["org.hamcrest", "hamcrest-core", "1.3"]]) {
      for (const extension of ["jar", "pom"]) files[`cache/files-2.1/${group}/${name}/${version}/hash/${name}-${version}.${extension}`] = "cached artifact";
    }
    const context = await fixture(files);
    const adapter = { adapterId: "gradle", mounts: [{ source: join(context.root, "cache"), target: "/bflow-cache/gradle/caches/modules-2" }] };
    expect(await missingOfflineFixturePrerequisites(adapter)).toEqual(["Gradle offline descriptor junit/junit/4.13.2", "Gradle offline descriptor org.hamcrest/hamcrest-core/1.3"]);
    for (const path of ["junit/junit/4.13.2", "org.hamcrest/hamcrest-core/1.3"]) {
      const descriptor = join(context.root, "cache/metadata-2.107/descriptors", path, "repo/descriptor.bin");
      await mkdir(dirname(descriptor), { recursive: true }); await writeFile(descriptor, "cached descriptor");
    }
    expect(await missingOfflineFixturePrerequisites(adapter)).toEqual([]);
  });

  it("requires net8 runtime and reference packs independently of the installed SDK and cached direct packages", async () => {
    const files: Record<string, string> = {};
    for (const [name, version] of [["microsoft.net.test.sdk", "17.11.1"], ["xunit", "2.9.2"], ["xunit.runner.visualstudio", "2.8.2"]]) {
      for (const file of [`${name}.${version}.nupkg`, `${name}.nuspec`, ".nupkg.metadata"]) files[`cache/${name}/${version}/${file}`] = "cached package";
    }
    files["packs/Microsoft.NETCore.App.Ref/9.0.1/ref/net9.0/System.Runtime.dll"] = "different target";
    files["shared/Microsoft.NETCore.App/9.0.1/System.Private.CoreLib.dll"] = "different target";
    const context = await fixture(files);
    const adapter = { adapterId: "dotnet", mounts: [
      { source: join(context.root, "cache"), target: "/bflow-cache/nuget" },
      { source: join(context.root, "packs"), target: "/sdk/packs" },
      { source: join(context.root, "shared"), target: "/sdk/shared" }
    ] };
    expect(await missingOfflineFixturePrerequisites(adapter)).toEqual([".NET 8 Microsoft.NETCore.App.Ref", ".NET 8 Microsoft.NETCore.App"]);
  });
});

describe("managed-language runner adapters", () => {
  it("probes a first-run .NET SDK with disposable writable state and reads the SDK version after its welcome banner", async () => {
    const tools = await fixture({ "bin/dotnet": `#!/bin/sh
test "$1" = "--version" || exit 2
test "$HOME" = "$DOTNET_CLI_HOME" || exit 3
test "$DOTNET_NOLOGO" = "1" || exit 4
/bin/mkdir -p "$DOTNET_CLI_HOME/.dotnet" || exit 5
printf '%s\\n' "$DOTNET_CLI_HOME" > "\${0%/*}/probe-home"
printf 'Welcome to .NET 8.0!\\nSDK Version: 8.0.408\\n\\n8.0.408\\n'
` });
    await chmod(join(tools.root, "bin/dotnet"), 0o755);
    vi.stubEnv("PATH", join(tools.root, "bin"));
    const context = await fixture({ "Test.csproj": "<Project><IsTestProject>true</IsTestProject></Project>" });
    const result = await managedAdapters.find(adapter => adapter.id === "dotnet")!.detect(context);
    expect(result.runners[0], result.notes.join(" ")).toMatchObject({ version: "8.0.408" });
    const probeHome = (await readFile(join(tools.root, "bin/probe-home"), "utf8")).trim();
    expect(probeHome).not.toBe(context.root);
    expect(existsSync(probeHome)).toBe(false);
  });

  it("rejects a .NET welcome banner without a verified SDK version line and removes failed probe state", async () => {
    const tools = await fixture({ "bin/dotnet": `#!/bin/sh
printf '%s\\n' "$DOTNET_CLI_HOME" > "\${0%/*}/probe-home"
printf 'Welcome to .NET 8.0!\\nSDK Version: 8.0.408\\n'
` });
    await chmod(join(tools.root, "bin/dotnet"), 0o755);
    vi.stubEnv("PATH", join(tools.root, "bin"));
    const context = await fixture({ "Test.csproj": "<Project><IsTestProject>true</IsTestProject></Project>" });
    const result = await managedAdapters.find(adapter => adapter.id === "dotnet")!.detect(context);
    expect(result.runners).toEqual([]);
    const probeHome = (await readFile(join(tools.root, "bin/probe-home"), "utf8")).trim();
    expect(probeHome).toBeTruthy();
    expect(existsSync(probeHome)).toBe(false);
  });

  it("probes Gradle with disposable writable state and reads the Gradle version after its welcome banner", async () => {
    const tools = await fixture({
      "bin/gradle": `#!/bin/sh
test "$1" = "--version" || exit 2
test "$HOME" = "$GRADLE_USER_HOME" || exit 3
/bin/mkdir -p "$GRADLE_USER_HOME/.gradle" || exit 5
printf '%s\\n' "$GRADLE_USER_HOME" > "\${0%/*}/probe-home"
printf 'Welcome to Gradle 8.5!\\n\\n------------------------------------------------------------\\nGradle 8.5\\n------------------------------------------------------------\\n'
`,
      "bin/java": `#!/bin/sh
test "$1" = "-version" || exit 2
printf 'openjdk version "17.0.9" 2023-10-17\\n' >&2
`
    });
    await chmod(join(tools.root, "bin/gradle"), 0o755);
    await chmod(join(tools.root, "bin/java"), 0o755);
    vi.stubEnv("PATH", join(tools.root, "bin"));
    const context = await fixture({ "build.gradle": "plugins { id 'java' }" });
    const result = await managedAdapters.find(adapter => adapter.id === "gradle")!.detect(context);
    expect(result.runners[0], result.notes.join(" ")).toMatchObject({ version: "8.5" });
    const probeHome = (await readFile(join(tools.root, "bin/probe-home"), "utf8")).trim();
    expect(probeHome).not.toBe(context.root);
    expect(existsSync(probeHome)).toBe(false);
  });

  it("rejects a Gradle welcome banner without a verified version and removes failed probe state", async () => {
    const tools = await fixture({ "bin/gradle": `#!/bin/sh
printf '%s\\n' "$GRADLE_USER_HOME" > "\${0%/*}/probe-home"
printf 'Welcome to Gradle!\\nBroken banner without version\\n'
` });
    await chmod(join(tools.root, "bin/gradle"), 0o755);
    vi.stubEnv("PATH", join(tools.root, "bin"));
    const context = await fixture({ "build.gradle": "plugins { id 'java' }" });
    const result = await managedAdapters.find(adapter => adapter.id === "gradle")!.detect(context);
    expect(result.runners).toEqual([]);
    const probeHome = (await readFile(join(tools.root, "bin/probe-home"), "utf8")).trim();
    expect(probeHome).toBeTruthy();
    expect(existsSync(probeHome)).toBe(false);
  });

  it("detects nested Maven with fixed offline argv and exact Class#method selectors", async () => {
    const { runner } = await detected("maven", { "service/pom.xml": "<project/>", "service/.mvn/jvm.config": "-Xmx256m", "service/src/test/java/a/FeatureTest.java": "", ".github/workflows/test.yml": "" });
    expect(runner).toMatchObject({ adapterId: "maven", projectDirectory: "service", format: "junit", environment: { MAVEN_SKIP_RC: "true", JAVA_HOME: "/usr" } });
    expect(runner.protectedPaths).toContain("service/.mvn/jvm.config");
    expect(runner.bind({ testNames: ["a.FeatureTest.accepts", "a.FeatureTest.rejects"], testPaths: ["service/src/test/java/a/FeatureTest.java"] }, "/tmp/reports")).toEqual({
      args: ["--offline", "--batch-mode", "--no-transfer-progress", "-Dmaven.repo.local=/bflow-cache/maven", "-Dtest=a.FeatureTest#accepts,a.FeatureTest#rejects", "-DfailIfNoTests=true", "-Dsurefire.failIfNoSpecifiedTests=true", "test"], reportPaths: ["service/target/surefire-reports/TEST-*.xml"]
    });
  });

  it("detects Gradle Kotlin with read-only dependency cache, no daemon, and exact filters", async () => {
    const { runner } = await detected("gradle", { "app/build.gradle.kts": "plugins {}", "app/settings.gradle.kts": "", "app/src/test/kotlin/FooTest.kt": "" });
    expect(runner.environment).toMatchObject({ GRADLE_USER_HOME: "/tmp/bflow-gradle", GRADLE_RO_DEP_CACHE: "/bflow-cache/gradle/caches" });
    expect(runner.bind({ testNames: ["org.FooTest.target"], testPaths: ["app/src/test/kotlin/FooTest.kt"] }, "/tmp/reports")).toEqual({
      args: ["--offline", "--no-daemon", "--console=plain", "--no-build-cache", "--rerun-tasks", "test", "--tests", "org.FooTest.target"], reportPaths: ["app/build/test-results/test/TEST-*.xml"]
    });
  });

  it("detects .NET test projects, excludes libraries, and restores from the isolated offline cache before exact FQN selection", async () => {
    const { runner, context } = await detected("dotnet", { "tests/Behavior.csproj": '<Project><PackageReference Include="Microsoft.NET.Test.Sdk"/></Project>', "lib/Lib.csproj": "<Project/>", "tests/Test.cs": "", "tests/Directory.Build.props": "" });
    expect(runner.format).toBe("trx"); expect(runner.projectDirectory).toBe("tests");
    expect(runner.protectedPaths).toContain("tests/Directory.Build.props");
    const invocation = runner.bind({ testNames: ["Example.Behavior.passes", "Example.Behavior.fails"], testPaths: ["tests/Test.cs"] }, "/tmp/reports");
    expect(invocation.args).toEqual(["test", "Behavior.csproj", "--no-restore", "--nologo", "--filter", "FullyQualifiedName=Example.Behavior.passes|FullyQualifiedName=Example.Behavior.fails", "--logger", "trx;LogFileName=results.trx", "--results-directory", "/tmp/reports"]);
    expect(invocation.prepare).toMatchObject({ executable: "/usr/bin/dotnet", args: ["restore", "Behavior.csproj", "--source", "/bflow-cache/nuget", "--packages", "/bflow-cache/nuget", "--ignore-failed-sources", "--disable-parallel", "--configfile", "/tmp/reports/NuGet.Config"] });
    expect(runner.helpers![0]!.content).toContain("<clear/>");
    expect(runner.mounts.some(mount => mount.source === join(context.root, "home/.dotnet"))).toBe(false);
  });

  it("uses native RSpec JSON and anchored full-description regexes, never Gemfile scripts", async () => {
    const { runner } = await detected("ruby", { Gemfile: 'gem "rspec"', ".rspec": "--format malicious", "spec/a_spec.rb": "" });
    expect(runner).toMatchObject({ adapterId: "rspec", format: "rspec_json", environment: { BUNDLE_IGNORE_CONFIG: "1", BUNDLE_FROZEN: "true" } });
    expect(runner.protectedPaths).toContain(".rspec");
    expect(runner.bind({ testNames: ["a feature (safe) works?"], testPaths: ["spec/a_spec.rb"] }, "/tmp/reports").args).toEqual(["--format", "json", "--out", "/tmp/reports/rspec.json", "--example", "\\Aa feature \\(safe\\) works\\?\\z", "--", "spec/a_spec.rb"]);
  });

  it("detects Minitest with a Runtime helper and binds exact qualified methods without repository loader code", async () => {
    const { runner } = await detected("ruby", { "app/Gemfile": 'gem "minitest"', "app/test/feature_test.rb": "" });
    expect(runner).toMatchObject({ adapterId: "minitest", format: "junit", version: "Ruby 8.1.2; Minitest 8.1.2", helpers: [{ name: "minitest-reporter.rb" }] });
    const bound = runner.bind({ testNames: ["Example::BehaviorTest.test_target", "Example::BehaviorTest.test_[name]"], testPaths: ["app/test/feature_test.rb"] }, "/tmp/reports");
    expect(bound.args.slice(0, 3)).toEqual(["-r", "/tmp/reports/minitest-reporter.rb", "-e"]);
    expect(bound.args.slice(4)).toEqual(["/tmp/reports/minitest.xml", "test/feature_test.rb", "--", "--name", "/\\A(?:Example::BehaviorTest#test_target|Example::BehaviorTest#test_\\[name\\])\\z/"]);
    expect(bound.args[3]).toContain('files.each { |path| require File.expand_path(path, Dir.pwd) }');
    expect(runner.helpers![0]!.content).toContain('failure.is_a?(Minitest::UnexpectedError)');
    expect(runner.helpers![0]!.content).toContain('type = tag == "failure" ? "Minitest::Assertion"');
    expect(bound.reportPaths).toEqual(["/tmp/reports/minitest.xml"]);
    expect(runner.bind({ testNames: ["billing edge.case.test_0001_accepts [value]"], testPaths: ["app/test/feature_test.rb"] }, "/tmp/reports").args.at(-1)).toBe("/\\A(?:billing edge\\.case#test_0001_accepts \\[value\\])\\z/");
    expect(() => runner.bind({ testNames: ["test_target"], testPaths: ["app/test/feature_test.rb"] }, "/tmp/reports")).toThrow("runner_identity_unselectable");
  });

  it("detects both Minitest and RSpec in the same project and probes reporter capabilities", async () => {
    const context = await fixture({ Gemfile: 'gem "minitest"\ngem "rspec"' }), probes: string[][] = [];
    const injected = host(context.root);
    injected.findTool = async (name, args) => { probes.push([name, ...args]); return { executable: `/usr/bin/${name}`, version: "5.25.5" }; };
    const result = await createManagedAdapters(injected).find(adapter => adapter.id === "ruby")!.detect(context);
    expect(result.runners.map(runner => runner.adapterId)).toEqual(["rspec", "minitest"]);
    expect(probes).toContainEqual(["ruby", "-r", "minitest", "-e", "abort unless defined?(Minitest::AbstractReporter) && defined?(Minitest::UnexpectedError) && defined?(Minitest::Skip); print Minitest::VERSION"]);
  });

  it("reports an unavailable Minitest reporter API as an agent setup task", async () => {
    const context = await fixture({ Gemfile: 'gem "minitest"' });
    const injected = host(context.root);
    injected.findTool = async (name, args) => args.includes("minitest") ? undefined : { executable: `/usr/bin/${name}`, version: "3.3.0" };
    const result = await createManagedAdapters(injected).find(adapter => adapter.id === "ruby")!.detect(context);
    expect(result.runners).toHaveLength(0); expect(result.notes.join(" ")).toContain("runner_toolchain_unavailable");
    expect(result.notes.join(" ")).toContain("Coordinator");
  });

  it("accepts the Minitest JUnit shape and distinguishes assertion, runtime error, skip and invalid identity", () => {
    const outcome = { exitCode: 0, stdout: "", stderr: "", timedOut: false, outputTruncated: false };
    const report = (body: string, attributes = 'failures="0" errors="0" skipped="0"') => `<?xml version="1.0" encoding="UTF-8"?><testsuite name="bflow-minitest" tests="1" ${attributes}><testcase classname="Example::BehaviorTest" name="test_target">${body}</testcase></testsuite>`;
    expect(parseRunnerResult("junit", outcome, ["Example::BehaviorTest.test_target"], [report("")])).toMatchObject({ tests: 1, passed: 1, failed: 0 });
    expect(parseRunnerResult("junit", { ...outcome, exitCode: 1 }, ["Example::BehaviorTest.test_target"], [report('<failure type="Minitest::Assertion" message="Expected 5, got 4">test/feature_test.rb:8</failure>', 'failures="1" errors="0" skipped="0"')])).toMatchObject({ failed: 1, targetFailure: true });
    for (const xml of [report('<error type="Minitest::UnexpectedError" message="NoMethodError"/>', 'failures="0" errors="1" skipped="0"'), report('<skipped type="Minitest::Skip"/>', 'failures="0" errors="0" skipped="1"')]) expect(() => parseRunnerResult("junit", { ...outcome, exitCode: 1 }, ["Example::BehaviorTest.test_target"], [xml])).toThrow();
    expect(() => parseRunnerResult("junit", outcome, ["Example::BehaviorTest.other"], [report("")])).toThrow();
  });

  it("detects PHPUnit with JUnit and exact namespace-qualified method filters", async () => {
    const { runner } = await detected("phpunit", { "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}', "composer.lock": "{}", "tests/FooTest.php": "" });
    const invocation = runner.bind({ testNames: ["Tests.FooTest.test_ok"], testPaths: ["tests/FooTest.php"] }, "/tmp/reports");
    expect(runner.executable).toBe("/usr/bin/php");
    expect(invocation.args).toEqual(["-n", "/usr/bin/phpunit", "--do-not-cache-result", "--log-junit", "/tmp/reports/phpunit.xml", "--filter", "/^(?:Tests\\\\FooTest::test_ok)$/", "tests/FooTest.php"]);
    expect(runner.protectedPaths).toEqual(["composer.json", "composer.lock"]);
  });

  it("round-trips PHPUnit dotted JUnit classnames to exact PHP namespace filters", async () => {
    const { runner } = await detected("phpunit", { "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}', "tests/BehaviorTest.php": "" });
    const names = ["Vendor.Tests.BehaviorTest.testTarget"];
    const invocation = runner.bind({ testNames: names, testPaths: ["tests/BehaviorTest.php"] }, "/tmp/reports");
    expect(invocation.args[invocation.args.indexOf("--filter") + 1]).toBe("/^(?:Vendor\\\\Tests\\\\BehaviorTest::testTarget)$/");
    // PHPUnit JunitXmlLogger emits both class=PHP\Class and classname=PHP.Class.
    const report = '<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase class="Vendor\\Tests\\BehaviorTest" classname="Vendor.Tests.BehaviorTest" name="testTarget"/></testsuite>';
    const outcome = { exitCode: 0, stdout: "", stderr: "", timedOut: false, outputTruncated: false };
    expect(parseRunnerResult("junit", outcome, names, [report])).toMatchObject({ testNames: names, passed: 1 });
    const red = report.replace('failures="0"', 'failures="1"').replace('/></testsuite>', '><failure type="PHPUnit\\Framework\\ExpectationFailedException">Failed asserting that 5 is identical to 4.</failure></testcase></testsuite>');
    expect(parseRunnerResult("junit", { ...outcome, exitCode: 1 }, names, [red])).toMatchObject({ failed: 1, targetFailure: true });
    expect(() => runner.bind({ testNames: ["Vendor\\Tests\\BehaviorTest.testTarget"], testPaths: ["tests/BehaviorTest.php"] }, "/tmp/reports")).toThrow("runner_identity_unselectable");
  });

  it("loads only required public PHP modules explicitly without host ini files or Composer credentials", async () => {
    const context = await fixture({ "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}', "modules/dom.so": "module", "modules/99-credentials.ini": "SECRET" });
    const injected = host(context.root), original = injected.findTool;
    injected.findTool = async (...args) => {
      const tool = await original(...args);
      return args[0] === "php" && tool ? { ...tool, phpRuntime: { extensionDirectory: join(context.root, "modules"), builtinExtensions: tool.phpRuntime!.builtinExtensions.filter(name => name !== "dom") } } : tool;
    };
    const result = await createManagedAdapters(injected).find(adapter => adapter.id === "phpunit")!.detect(context);
    expect(result.notes).toEqual([]);
    const runner = result.runners[0]!;
    expect(runner.mounts).toEqual([{ source: join(context.root, "modules/dom.so"), target: join(context.root, "modules/dom.so") }]);
    expect(runner.bind({ testNames: ["BehaviorTest.testTarget"], testPaths: ["tests/BehaviorTest.php"] }, "/tmp/reports").args.slice(0, 4))
      .toEqual(["-n", "-d", `extension=${join(context.root, "modules/dom.so")}`, "/usr/bin/phpunit"]);
  });

  it("reports unavailable PHPUnit extension capability before measurement", async () => {
    const context = await fixture({ "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}' });
    const injected = host(context.root), original = injected.findTool;
    injected.findTool = async (...args) => {
      const tool = await original(...args);
      return args[0] === "php" && tool ? { ...tool, phpRuntime: { extensionDirectory: join(context.root, "missing"), builtinExtensions: [] } } : tool;
    };
    const result = await createManagedAdapters(injected).find(adapter => adapter.id === "phpunit")!.detect(context);
    expect(result.runners).toEqual([]);
    expect(result.notes.join(" ")).toContain("runner_toolchain_unavailable");
    expect(result.notes.join(" ")).toContain("PHP extension libxml");
  });

  it("rejects a version-verified shell PHPUnit launcher before advertising a PHP runner", async () => {
    const tools = await fixture({
      "bin/php": `#!/bin/sh
test "$1" = "-n" || exit 9
case "$2" in
  --version) printf 'PHP 8.3.1 (cli)\\n';;
  -r) printf '%s' '{"extensionDirectory":"/usr/lib/php/test","builtinExtensions":["ctype","dom","filter","json","libxml","mbstring","phar","tokenizer","xml","xmlwriter","zlib"]}';;
  *) exit 10;;
esac
`,
      "bin/phpunit": "#!/bin/sh\nprintf 'PHPUnit 11.5.0 by Sebastian Bergmann and contributors.\\n'\n"
    });
    for (const name of ["php", "phpunit"]) await chmod(join(tools.root, "bin", name), 0o755);
    vi.stubEnv("PATH", join(tools.root, "bin"));
    const context = await fixture({ "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}' });
    const result = await managedAdapters.find(adapter => adapter.id === "phpunit")!.detect(context);
    expect(result.runners).toEqual([]);
    expect(result.notes.join(" ")).toContain("runner_setup_required");
    expect(result.notes.join(" ")).toContain("PHP/PHAR entrypoint");
  });

  for (const [kind, entrypoint] of [
    ["PHP script", "#!/usr/bin/env php\n<?php echo 'PHPUnit 11.5.0';\n"],
    ["PHAR stub", "#!/usr/bin/env php\n<?php Phar::mapPhar(); __HALT_COMPILER(); ?>\r\narchive fixture"]
  ]) it(`preserves a validated global PHPUnit ${kind} with the isolated PHP runtime`, async () => {
    const tools = await fixture({
      "bin/php": `#!/bin/sh
if test "$1" != "-n"; then
  test "$1" = "\${0%/*}/phpunit" && test "$2" = "--version" || exit 9
  printf 'PHPUnit 11.5.0 by Sebastian Bergmann and contributors.\\n'
  exit 0
fi
case "$2" in
  --version) printf 'PHP 8.3.1 (cli)\\n';;
  -r) printf '%s' '{"extensionDirectory":"/usr/lib/php/test","builtinExtensions":["ctype","dom","filter","json","libxml","mbstring","phar","tokenizer","xml","xmlwriter","zlib"]}';;
  *) exit 10;;
esac
`,
      "bin/phpunit": entrypoint!
    });
    for (const name of ["php", "phpunit"]) await chmod(join(tools.root, "bin", name), 0o755);
    vi.stubEnv("PATH", join(tools.root, "bin"));
    const context = await fixture({ "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}' });
    const result = await managedAdapters.find(adapter => adapter.id === "phpunit")!.detect(context);
    expect(result.notes).toEqual([]);
    expect(result.runners[0]).toMatchObject({ executable: join(tools.root, "bin/php"), version: "11.5.0" });
    expect(result.runners[0]!.bind({ testNames: ["BehaviorTest.testTarget"], testPaths: ["tests/BehaviorTest.php"] }, "/tmp/reports").args.slice(0, 2))
      .toEqual(["-n", join(tools.root, "bin/phpunit")]);
  });

  it("rejects a Composer PHPUnit shell entrypoint using metadata and file inspection without executing it", async () => {
    const context = await fixture({
      "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}',
      "vendor/phpunit/phpunit/phpunit": "#!/bin/sh\ntouch executed-wrapper\n",
      "vendor/composer/installed.json": '{"packages":[{"name":"phpunit/phpunit","version":"11.5.0"}]}'
    });
    const result = await createManagedAdapters(host(context.root, ["phpunit"])).find(adapter => adapter.id === "phpunit")!.detect(context);
    expect(result.runners).toEqual([]);
    expect(result.notes.join(" ")).toContain("runner_setup_required");
    expect(existsSync(join(context.root, "executed-wrapper"))).toBe(false);
  });

  it("uses the same isolated PHP runtime for a Composer-installed PHPUnit without a global launcher", async () => {
    const context = await fixture({
      "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}',
      "vendor/phpunit/phpunit/phpunit": "<?php // dependency fixture",
      "vendor/composer/installed.json": '{"packages":[{"name":"phpunit/phpunit","version":"11.5.0"}]}'
    });
    const result = await createManagedAdapters(host(context.root, ["phpunit"])).find(adapter => adapter.id === "phpunit")!.detect(context);
    expect(result.notes).toEqual([]);
    const runner = result.runners[0]!;
    expect(runner).toMatchObject({ executable: "/usr/bin/php", version: "11.5.0" });
    expect(runner.bind({ testNames: ["BehaviorTest.testTarget"], testPaths: ["tests/BehaviorTest.php"] }, "/tmp/reports").args.slice(0, 2))
      .toEqual(["-n", "vendor/phpunit/phpunit/phpunit"]);
    expect(runner.mounts).toEqual([{ source: join(context.root, "vendor"), target: join(context.root, "vendor") }]);
  });

  it("selects CTest registrations exactly using JUnit on supported versions", async () => {
    const { runner } = await detected("ctest", { "build/CTestTestfile.cmake": "add_test(test-a ...)" });
    expect(runner.bind({ testNames: ["test-a [one]"], testPaths: ["build/CTestTestfile.cmake"] }, "/tmp/reports").args).toEqual(["--output-on-failure", "--no-tests=error", "--output-junit", "/tmp/reports/ctest.xml", "-R", "^(test-a \\[one\\])$"]);
  });

  it("detects multiple ecosystems in a single monorepo without short-circuiting", async () => {
    const context = await fixture({ "jvm/pom.xml": "<project/>", "net/Net.csproj": "<Project><IsTestProject>true</IsTestProject></Project>", "ruby/Gemfile": 'gem "rspec"', "php/composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}' });
    const detections = await Promise.all(createManagedAdapters(host(context.root)).map(adapter => adapter.detect(context)));
    expect(detections.flatMap(result => result.runners).map(runner => `${runner.adapterId}:${runner.projectDirectory}`)).toEqual(["maven:jvm", "dotnet:net", "rspec:ruby", "phpunit:php"]);
  });

  it("fails closed on ambiguous selectors, duplicate identities and cross-project paths", async () => {
    const { runner } = await detected("maven", { "jvm/pom.xml": "<project/>" });
    for (const testNames of [[], ["a.Test.*"], ["a.Test.ok|other"], ["a.Test.ok", "a.Test.ok"], ["a.Test.foo[0]"]]) {
      expect(() => runner.bind({ testNames, testPaths: ["jvm/src/test/java/Test.java"] }, "/tmp/reports")).toThrow("runner_identity_unselectable");
    }
    for (const path of ["../Test.java", "other/Test.java", "/jvm/Test.java", "jvm/../Test.java"]) {
      expect(() => runner.bind({ testNames: ["a.Test.ok"], testPaths: [path] }, "/tmp/reports")).toThrow("runner_identity_unselectable");
    }
  });

  it("mounts only canonical dependency subtrees, excludes settings and rejects symlink escapes", async () => {
    const context = await fixture({ "pom.xml": "<project/>", "home/.m2/repository/a.jar": "jar", "home/.m2/settings.xml": "SECRET", "home/.ssh/id_rsa": "SECRET" });
    const detection = await createManagedAdapters(host(join(context.root, "home"))).find(adapter => adapter.id === "maven")!.detect(context);
    expect(detection.runners[0]!.mounts).toEqual([{ source: join(context.root, "home/.m2/repository"), target: "/bflow-cache/maven" }]);
    await rm(join(context.root, "home/.m2/repository"), { recursive: true });
    await symlink(join(context.root, "home/.ssh"), join(context.root, "home/.m2/repository"));
    const rejected = await createManagedAdapters(host(join(context.root, "home"))).find(adapter => adapter.id === "maven")!.detect(context);
    expect(rejected.runners[0]!.mounts).toEqual([]);
  });

  it("reports unavailable toolchains as structured setup reasons without executing project code", async () => {
    const context = await fixture({ "pom.xml": "<project/>" });
    const result = await createManagedAdapters(host(context.root, ["mvn"])).find(adapter => adapter.id === "maven")!.detect(context);
    expect(result.runners).toEqual([]); expect(result.notes.join(" ")).toContain("runner_toolchain_unavailable");
  });

  it("imports external Maven runtime pieces without its credential-capable conf/settings.xml", async () => {
    const context = await fixture({ "pom.xml": "<project/>", "home/sdk/maven/bin/mvn": "binary", "home/sdk/maven/bin/m2.conf": "runtime config", "home/sdk/maven/boot/launcher.jar": "jar", "home/sdk/maven/lib/maven.jar": "jar", "home/sdk/maven/conf/settings.xml": "SECRET" });
    const injected = host(join(context.root, "home"));
    injected.findTool = async name => ({ executable: name === "mvn" ? join(context.root, "home/sdk/maven/bin/mvn") : `/usr/bin/${name}`, version: "3.9.9" });
    const result = await createManagedAdapters(injected).find(adapter => adapter.id === "maven")!.detect(context);
    expect(result.runners[0]!.mounts.map(mount => mount.source)).toEqual([
      join(context.root, "home/sdk/maven/bin/mvn"), join(context.root, "home/sdk/maven/boot"),
      join(context.root, "home/sdk/maven/lib"), join(context.root, "home/sdk/maven/bin/m2.conf")
    ]);
    expect(result.runners[0]!.mounts.some(mount => mount.source.endsWith("/maven") || mount.source.includes("settings.xml"))).toBe(false);
  });

  it("probes installed Maven and Java versions rather than trusting manifest declarations", async () => {
    const context = await fixture({ "pom.xml": "<project/>" });
    const result = await managedAdapters.find(adapter => adapter.id === "maven")!.detect(context);
    if (!existsSync("/usr/bin/mvn")) { expect(result.runners).toEqual([]); return; }
    expect(result.runners[0]?.version).toMatch(/^\d+\.\d+/);
    expect(result.runners[0]?.executable).toContain("maven");
  });
});

function hasTool(name: string): boolean {
  try { execFileSync("/bin/sh", ["-c", `command -v ${name}`], { stdio: "ignore" }); return true; } catch { return false; }
}

function hasWorkingSandbox(): boolean {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return false;
  try {
    execFileSync("/usr/bin/bwrap", ["--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--", "/usr/bin/true"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch { return false; }
}

// These are explicit coverage gaps on hosts without a toolchain, never fake-runner evidence.
for (const { id, tool, files } of [
  { id: "gradle", tool: "gradle", files: { "build.gradle": "plugins { id 'java' }" } },
  { id: "dotnet", tool: "dotnet", files: { "Test.csproj": "<Project><IsTestProject>true</IsTestProject></Project>" } },
  { id: "ruby", tool: "rspec", files: { Gemfile: 'gem "rspec"' } },
  { id: "phpunit", tool: "phpunit", files: { "composer.json": '{"require-dev":{"phpunit/phpunit":"*"}}' } },
  { id: "ctest", tool: "ctest", files: { "CTestTestfile.cmake": "" } }
] as { id: string; tool: string; files: Record<string, string> }[]) {
  it.skipIf(!hasTool(tool))(`${id}: installed toolchain detection verifies its actual version`, async () => {
    const context = await fixture(files);
    const result = await managedAdapters.find(adapter => adapter.id === id)!.detect(context);
    expect(result.runners[0], result.notes.join(" ")).toBeDefined();
    expect(result.runners[0]!.version).toMatch(/\d+\.\d+/);
  });
}

export async function runManagedSandbox(runner: AdapterRunner, root: string, args: string[], helpersDirectory?: string) {
  const sandboxArgs = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", root, root, "--chdir", join(root, runner.projectDirectory)];
  for (const mount of runner.mounts) sandboxArgs.push("--ro-bind", mount.source, mount.target);
  if (helpersDirectory) for (const helper of runner.helpers ?? []) {
    const path = join(helpersDirectory, helper.name); sandboxArgs.push("--ro-bind", path, path);
  }
  const env = { PATH: "/usr/bin:/bin", HOME: "/tmp", LANG: "C.UTF-8", ...runner.environment };
  try { return { code: 0, output: execFileSync("/usr/bin/bwrap", [...sandboxArgs, "--", runner.executable, ...args], { env, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1_048_576 }) }; }
  catch (error) {
    const failure = error as { status: number; stdout: Buffer; stderr: Buffer };
    return { code: failure.status, output: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}` };
  }
}

describe.skipIf(!hasTool("mvn") || !hasWorkingSandbox())("Maven in a real offline sandbox", () => {
  it("reports the exact mapped test for pass, assertion Red, and runtime infrastructure error", async test => {
    const context = await fixture({
      "pom.xml": '<project><modelVersion>4.0.0</modelVersion><groupId>bflow.fixture</groupId><artifactId>runner</artifactId><version>1</version><properties><maven.compiler.source>17</maven.compiler.source><maven.compiler.target>17</maven.compiler.target></properties><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency></dependencies><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>3.3.1</version></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.11.0</version></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-surefire-plugin</artifactId><version>3.2.5</version></plugin></plugins></build></project>',
      "src/test/java/example/BehaviorTest.java": 'package example; import org.junit.Test; import static org.junit.Assert.*; public class BehaviorTest { @Test public void target() { assertEquals(4, 2+2); } @Test public void neverSelected() { fail("must not execute"); } }'
    });
    const detection = await managedAdapters.find(adapter => adapter.id === "maven")!.detect(context);
    const runner = detection.runners[0]!; expect(runner, detection.notes.join(" ")).toBeDefined();
    const missingArtifacts = await missingOfflineFixturePrerequisites(runner);
    if (missingArtifacts.length) {
      console.info(`Maven offline fixture unavailable: missing ${missingArtifacts.join(", ")}`);
      test.skip(); // Installed Maven is insufficient: this fixture requires the pinned offline artifacts above.
      return;
    }
    for (const [label, body, expectedCode, reportTag] of [["pass", "assertEquals(4, 2+2);", 0, ""], ["red", "assertEquals(5, 2+2);", 1, '<failure message='], ["infrastructure", 'throw new IllegalStateException("runtime infrastructure");', 1, '<error message=']] as const) {
      await writeFile(join(context.root, "src/test/java/example/BehaviorTest.java"), `package example; import org.junit.Test; import static org.junit.Assert.*; public class BehaviorTest { @Test public void target() { ${body} } @Test public void neverSelected() { fail("must not execute"); } }`);
      const reports = join(context.root, "reports", label); await mkdir(reports, { recursive: true });
      const invocation = runner.bind({ testNames: ["example.BehaviorTest.target"], testPaths: ["src/test/java/example/BehaviorTest.java"] }, reports);
      const result = await runManagedSandbox(runner, context.root, invocation.args);
      expect(result.code, result.output).toBe(expectedCode);
      const xml = await readFile(join(context.root, "target/surefire-reports/TEST-example.BehaviorTest.xml"), "utf8");
      expect(xml).toContain('name="target" classname="example.BehaviorTest"');
      expect(xml).not.toContain('name="neverSelected"');
      if (reportTag) expect(xml).toContain(reportTag);
    }
  }, 180_000);
});

describe.skipIf(!hasTool("ruby") || !hasWorkingSandbox())("Minitest in a real offline sandbox (requires Ruby/Minitest)", () => {
  it("emits exact pass, assertion Red and unexpected-error records from the Runtime helper", async context => {
    const repo = await fixture({ Gemfile: 'gem "minitest"', "test/behavior_test.rb": "" });
    const detection = await managedAdapters.find(adapter => adapter.id === "ruby")!.detect(repo);
    const runner = detection.runners.find(candidate => candidate.adapterId === "minitest");
    if (!runner) { context.skip(); return; }
    for (const [label, body, code] of [["pass", "assert_equal 4, 2 + 2", 0], ["red", "assert_equal 5, 2 + 2", 1], ["runtime", 'raise NoMethodError, "runtime infrastructure"', 1]] as const) {
      await writeFile(join(repo.root, "test/behavior_test.rb"), `require "minitest/autorun"\nclass BehaviorTest < Minitest::Test\n def test_target\n ${body}\n end\n def test_never_selected\n flunk "must not execute"\n end\nend\n`);
      const reports = join(repo.root, "reports", label); await mkdir(reports, { recursive: true });
      for (const helper of runner.helpers!) await writeFile(join(reports, helper.name), helper.content);
      const invocation = runner.bind({ testNames: ["BehaviorTest.test_target"], testPaths: ["test/behavior_test.rb"] }, reports);
      const result = await runManagedSandbox(runner, repo.root, invocation.args, reports);
      expect(result.code, result.output).toBe(code);
      const xml = await readFile(join(reports, "minitest.xml"), "utf8");
      expect(xml).toContain('classname="BehaviorTest" name="test_target"'); expect(xml).not.toContain('name="test_never_selected"');
      const outcome = { exitCode: result.code, stdout: result.output, stderr: "", timedOut: false, outputTruncated: false };
      if (label === "runtime") expect(() => parseRunnerResult("junit", outcome, ["BehaviorTest.test_target"], [xml])).toThrow();
      else expect(parseRunnerResult("junit", outcome, ["BehaviorTest.test_target"], [xml])).toMatchObject({ tests: 1, passed: label === "pass" ? 1 : 0, failed: label === "red" ? 1 : 0 });
    }
  }, 120_000);
});
