import { execFile } from "node:child_process";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { AdapterContext, AdapterDetection, AdapterRunner, RunnerAdapter, RunnerIdentities, RunnerMount } from "../runner-adapter.js";

const runFile = promisify(execFile);
const VERSION_TIMEOUT_MS = 5_000;
const CONFIG_FILE = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|gradle\.lockfile|Gemfile(?:\.lock)?|\.rspec(?:-local)?|spec_helper\.rb|rails_helper\.rb|test_helper\.rb|composer\.(?:json|lock)|phpunit\.xml(?:\.dist)?|global\.json|NuGet\.Config|nuget\.config|Directory\.(?:Build|Packages)\.(?:props|targets)|CMakeLists\.txt|CTestTestfile\.cmake|CMakePresets\.json|Package\.(?:swift|resolved))$/i;
const DOTNET_PROJECT = /\.(?:cs|fs|vb)proj$/i;
const SAFE_FQN = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)+$/;

/** Runtime-authored reporter: helper bytes are mounted read-only, never supplied by the repository. */
const MINITEST_REPORTER = `require "minitest"
require "cgi"
class BflowMinitestReporter < Minitest::AbstractReporter
  def initialize(path)
    @path = path
    @results = []
    @mutex = Mutex.new
  end
  def record(result)
    @mutex.synchronize { @results << result }
  end
  def passed?
    @results.all? { |result| result.failures.empty? }
  end
  def report
    escape = ->(value) { CGI.escapeHTML(value.to_s.encode("UTF-8", invalid: :replace, undef: :replace)) }
    failures = 0
    errors = 0
    skipped = 0
    cases = @results.map do |result|
      klass = result.respond_to?(:klass) ? result.klass : result.class.name
      elements = result.failures.map do |failure|
        tag = if failure.is_a?(Minitest::Skip)
          skipped += 1
          "skipped"
        elsif failure.is_a?(Minitest::UnexpectedError) || !failure.is_a?(Minitest::Assertion)
          errors += 1
          "error"
        else
          failures += 1
          "failure"
        end
        type = tag == "failure" ? "Minitest::Assertion" : failure.class.name
        "<#{tag} type=\\"#{escape.call(type)}\\" message=\\"#{escape.call(failure.message)}\\">#{escape.call(Array(failure.backtrace).join("\\n"))}</#{tag}>"
      end.join
      "<testcase classname=\\"#{escape.call(klass)}\\" name=\\"#{escape.call(result.name)}\\">#{elements}</testcase>"
    end.join
    xml = "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?><testsuite name=\\"bflow-minitest\\" tests=\\"#{@results.length}\\" failures=\\"#{failures}\\" errors=\\"#{errors}\\" skipped=\\"#{skipped}\\">#{cases}</testsuite>"
    File.open(@path, "wb") { |file| file.write(xml) }
  end
end
`;

const MINITEST_LOADER = `report_path = ARGV.shift
separator = ARGV.index("--")
abort "missing Runtime test file boundary" unless report_path && separator && separator > 0
files = ARGV.shift(separator)
ARGV.shift
$LOAD_PATH.unshift(File.expand_path("lib", Dir.pwd), File.expand_path("test", Dir.pwd))
files.map { |path| File.dirname(File.expand_path(path, Dir.pwd)) }.uniq.each { |path| $LOAD_PATH.unshift(path) }
require "minitest/autorun"
Minitest.extensions << "bflow"
Minitest.singleton_class.send(:define_method, :plugin_bflow_init) do |_options|
  reporter << BflowMinitestReporter.new(report_path)
end
files.each { |path| require File.expand_path(path, Dir.pwd) }
`;

export interface ManagedTool {
  executable: string;
  version: string;
}
/** Private dependency injection for detection tests; role messages never populate this port. */
export interface ManagedAdapterHost {
  homeDirectory: string;
  findTool(name: string, versionArgs: string[]): Promise<ManagedTool | undefined>;
}

const systemHost: ManagedAdapterHost = {
  homeDirectory: homedir(),
  async findTool(name, versionArgs) {
    // Command names are Runtime constants, never repository or agent input.
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return undefined;
    try {
      const found = await runFile("/bin/sh", ["-c", `command -v ${name}`], {
        cwd: "/", env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeout: VERSION_TIMEOUT_MS, maxBuffer: 16_384
      });
      const executable = await realpath(found.stdout.trim());
      if (!isAbsolute(executable) || !(await lstat(executable)).isFile()) return undefined;
      const result = await runFile(executable, versionArgs, {
        cwd: "/", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C", MAVEN_SKIP_RC: "true", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1",
          ...(name === "rspec" && /\/(?:\.gem|\.local\/share\/gem)\/ruby\/\d+\.\d+\.\d+\/bin\/rspec$/.test(executable) ? { GEM_PATH: dirname(dirname(executable)) } : {}) },
        timeout: VERSION_TIMEOUT_MS, maxBuffer: 65_536
      });
      const output = `${result.stdout}\n${result.stderr}`.replace(/\u001b\[[\d;]*m/g, "");
      const version = /\b\d+\.\d+(?:\.\d+)?(?:[.-][A-Za-z0-9.-]+)?\b/.exec(output)?.[0];
      return version ? { executable, version } : undefined;
    } catch { return undefined; }
  }
};

function safeRelative(path: string): boolean {
  return !!path && !isAbsolute(path) && !path.startsWith("-") && !/[\\:\0\r\n]/.test(path)
    && !path.split("/").some(part => !part || part === "." || part === "..");
}

function protectedPaths(context: AdapterContext): string[] {
  // Ancestor/aggregator configuration can affect nested projects; freeze it along with local definitions.
  return context.files.filter(path => safeRelative(path) && (CONFIG_FILE.test(path) || DOTNET_PROJECT.test(path)
    || /(?:^|\/)(?:\.mvn|\.github\/workflows|gradle\/dependency-locks)\//.test(path)
    || /(?:^|\/)(?:Makefile|justfile|Taskfile\.ya?ml|conftest\.py|noxfile\.py|tox\.ini)$/.test(path)));
}

function validateSelection(identities: RunnerIdentities, project: string): void {
  if (!identities.testNames.length || new Set(identities.testNames).size !== identities.testNames.length
    || !identities.testPaths.length || new Set(identities.testPaths).size !== identities.testPaths.length
    || identities.testNames.some(name => !name.trim() || /[\0\r\n]/.test(name))) {
    throw new Error("runner_identity_unselectable: exact unique test names and committed test paths are required");
  }
  if (identities.testPaths.some(path => !safeRelative(path) || (project !== "." && !path.startsWith(`${project}/`)))) {
    throw new Error("runner_identity_unselectable: test path is outside this adapter project");
  }
}

function fqnNames(identities: RunnerIdentities): string[] {
  if (identities.testNames.some(name => !SAFE_FQN.test(name))) {
    throw new Error("runner_identity_unselectable: this toolchain requires exact Class.method identities; parameterized identities require a reporter/setup task");
  }
  return identities.testNames;
}

function pathInProject(path: string, project: string): string {
  return project === "." ? path : path.slice(project.length + 1);
}

function escapedRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

async function canonicalMount(source: string, target: string, home: string): Promise<RunnerMount | undefined> {
  try {
    const canonical = await realpath(source);
    const hostHome = resolve(home);
    // No broad roots or credential/config directories. A symlink escaping its explicitly selected subtree is rejected.
    if (canonical !== resolve(source) || canonical === hostHome || canonical === "/" || canonical === dirname(hostHome)
      || /(?:^|\/)(?:\.ssh|\.aws|\.azure|\.config|\.gnupg|\.docker)(?:\/|$)/.test(canonical)) return undefined;
    if (!(await lstat(canonical)).isDirectory() && !(await lstat(canonical)).isFile()) return undefined;
    return { source: canonical, target };
  } catch { return undefined; }
}

async function mountTool(tool: ManagedTool, home: string): Promise<RunnerMount[]> {
  // /usr is already read-only in the sandbox. For externally installed distributions, mount only their version directory.
  if (tool.executable.startsWith("/usr/") || tool.executable.startsWith("/bin/")) return [];
  const bin = dirname(tool.executable);
  const root = basename(bin) === "bin" ? dirname(bin) : tool.executable;
  const mount = await canonicalMount(root, root, home);
  if (!mount) throw new Error("runner_toolchain_unavailable: unsafe or noncanonical toolchain location");
  return [mount];
}

async function optionalMount(source: string, target: string, host: ManagedAdapterHost): Promise<RunnerMount[]> {
  const mount = await canonicalMount(source, target, host.homeDirectory);
  return mount ? [mount] : [];
}

async function baseRunner(context: AdapterContext, project: string, adapterId: string, tool: ManagedTool, host: ManagedAdapterHost): Promise<Omit<AdapterRunner, "format" | "nameRule" | "bind">> {
  return {
    adapterId, version: tool.version, executable: tool.executable, projectDirectory: project,
    mounts: await mountTool(tool, host.homeDirectory), environment: {}, protectedPaths: protectedPaths(context)
  };
}

async function rubyBase(context: AdapterContext, project: string, adapterId: string, tool: ManagedTool, rubyTool: ManagedTool, host: ManagedAdapterHost) {
  const base = await baseRunner(context, project, adapterId, tool, host);
  base.mounts.push(...await mountTool(rubyTool, host.homeDirectory));
  base.mounts.push(...await optionalMount(join(context.root, project, "vendor/bundle"), join(context.root, project, "vendor/bundle"), host));
  base.environment = { PATH: `${dirname(rubyTool.executable)}:/usr/bin:/bin`, BUNDLE_IGNORE_CONFIG: "1", BUNDLE_FROZEN: "true", BUNDLE_DISABLE_VERSION_CHECK: "true" };
  const rubyApi = /^(\d+\.\d+)\./.exec(rubyTool.version)?.[1];
  if (rubyApi) {
    const api = `${rubyApi}.0`, gemPaths = [`/usr/lib/ruby/gems/${api}`, "/usr/share/rubygems-integration/all"];
    for (const root of [join(host.homeDirectory, ".gem/ruby", api), join(host.homeDirectory, ".local/share/gem/ruby", api), `/var/lib/gems/${api}`]) {
      const mounts = await optionalMount(root, root, host);
      if (mounts.length) { base.mounts.push(...mounts); gemPaths.push(root); }
    }
    base.environment.GEM_PATH = gemPaths.join(":");
  }
  return base;
}

async function javaEnvironment(host: ManagedAdapterHost): Promise<{ mounts: RunnerMount[]; environment: Record<string, string> }> {
  const java = await host.findTool("java", ["-version"]);
  if (!java) throw new Error("runner_toolchain_unavailable: Java runtime not detected");
  const javaHome = dirname(dirname(java.executable));
  const mounts = await mountTool(java, host.homeDirectory);
  // Debian splits JVM security configuration out of /usr. Only this system Java configuration is imported.
  try {
    const security = await realpath(join(javaHome, "conf/security/java.security"));
    const config = dirname(dirname(security));
    if (/^\/etc\/java-[A-Za-z0-9._-]+$/.test(config)) {
      // management/ may contain a host's JMX passwords. Import only public JVM policy/launcher files.
      const entries = (await readdir(config)).filter(name => /^(?:jvm-[A-Za-z0-9_-]+\.cfg|logging\.properties)$/.test(name));
      for (const entry of [...entries, "security/java.security", "security/java.policy", "security/default.policy", "security/blocked.certs", "security/nss.cfg", "security/public_suffix_list.dat", "security/policy"]) {
        mounts.push(...await optionalMount(join(config, entry), join(config, entry), host));
      }
    }
  } catch { /* Other JVM distributions keep configuration inside their toolchain root. */ }
  return { mounts, environment: { JAVA_HOME: javaHome } };
}

function adapter(id: string, manifests: (path: string) => boolean, detectProject: (context: AdapterContext, manifest: string, host: ManagedAdapterHost) => Promise<AdapterDetection>, host: ManagedAdapterHost): RunnerAdapter {
  return {
    id,
    async detect(context) {
      const runners: AdapterRunner[] = [], notes: string[] = [];
      for (const manifest of context.files.filter(path => safeRelative(path) && manifests(path)).sort()) {
        try {
          const result = await detectProject(context, manifest, host);
          runners.push(...result.runners); notes.push(...result.notes);
        } catch (error) { notes.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return { runners, notes };
    }
  };
}

function missing(id: string, tool: string): AdapterDetection {
  return { runners: [], notes: [`${id}: runner_toolchain_unavailable: ${tool} was not found with a verified version; Coordinator should schedule an isolated setup task`] };
}

export function createManagedAdapters(host: ManagedAdapterHost = systemHost): RunnerAdapter[] {
  const maven = adapter("maven", path => basename(path) === "pom.xml", async (context, manifest) => {
    const tool = await host.findTool("mvn", ["--version"]);
    if (!tool) return missing("maven", "Maven");
    const project = dirname(manifest), base = await baseRunner(context, project, "maven", tool, host);
    if (!tool.executable.startsWith("/usr/")) {
      // Maven distributions contain conf/settings.xml, which may hold credentials. Import runtime pieces only.
      const mavenHome = dirname(dirname(tool.executable));
      base.mounts = await optionalMount(tool.executable, tool.executable, host);
      for (const part of ["boot", "lib", "bin/m2.conf"]) {
        base.mounts.push(...await optionalMount(join(mavenHome, part), join(mavenHome, part), host));
      }
    }
    const java = await javaEnvironment(host);
    base.mounts.push(...java.mounts, ...await optionalMount(join(host.homeDirectory, ".m2/repository"), "/bflow-cache/maven", host));
    // The Debian launcher needs m2.conf, while settings.xml may contain credentials and is deliberately absent.
    try {
      const launcher = await realpath(join(dirname(tool.executable), "m2.conf"));
      if (launcher === "/etc/maven/m2.conf") base.mounts.push(...await optionalMount(launcher, launcher, host));
    } catch { /* Self-contained distributions need no extra mount. */ }
    base.environment = { ...java.environment, MAVEN_SKIP_RC: "true" };
    return { runners: [{ ...base, format: "junit", nameRule: "classname.name (fully qualified Java/Kotlin test class, dot, method)", bind(identities) {
      validateSelection(identities, project);
      const selectors = fqnNames(identities).map(name => name.replace(/\.([^.]+)$/, "#$1"));
      return { args: ["--offline", "--batch-mode", "--no-transfer-progress", "-Dmaven.repo.local=/bflow-cache/maven", `-Dtest=${selectors.join(",")}`, "-DfailIfNoTests=true", "-Dsurefire.failIfNoSpecifiedTests=true", "test"], reportPaths: [`${project === "." ? "" : `${project}/`}target/surefire-reports/TEST-*.xml`] };
    } }], notes: [] };
  }, host);

  const gradle = adapter("gradle", path => /^build\.gradle(?:\.kts)?$/.test(basename(path)), async (context, manifest) => {
    const tool = await host.findTool("gradle", ["--version"]);
    if (!tool) return missing("gradle", "Gradle");
    const project = dirname(manifest), base = await baseRunner(context, project, "gradle", tool, host);
    const java = await javaEnvironment(host);
    base.mounts.push(...java.mounts, ...await optionalMount(join(host.homeDirectory, ".gradle/caches/modules-2"), "/bflow-cache/gradle/caches/modules-2", host));
    // GRADLE_RO_DEP_CACHE is Gradle's documented read-only dependency cache, not a writable user home.
    base.environment = { ...java.environment, GRADLE_USER_HOME: "/tmp/bflow-gradle", GRADLE_RO_DEP_CACHE: "/bflow-cache/gradle/caches/modules-2" };
    return { runners: [{ ...base, format: "junit", nameRule: "classname.name (fully qualified Java/Kotlin class, dot, method)", bind(identities) {
      validateSelection(identities, project);
      return { args: ["--offline", "--no-daemon", "--console=plain", "--no-build-cache", "--rerun-tasks", "test", ...fqnNames(identities).flatMap(name => ["--tests", name])], reportPaths: [`${project === "." ? "" : `${project}/`}build/test-results/test/TEST-*.xml`] };
    } }], notes: [] };
  }, host);

  const dotnet = adapter("dotnet", path => DOTNET_PROJECT.test(path), async (context, manifest) => {
    const tool = await host.findTool("dotnet", ["--version"]);
    if (!tool) return missing("dotnet", "dotnet");
    const xml = await readFile(join(context.root, manifest), "utf8");
    if (!/<(?:IsTestProject)>\s*true\s*<\//i.test(xml) && !/Microsoft\.NET\.Test\.Sdk|xunit|nunit|MSTest/i.test(xml)) return { runners: [], notes: [] };
    const project = dirname(manifest), base = await baseRunner(context, project, "dotnet", tool, host);
    // Never mount the whole ~/.dotnet: it may contain authentication and telemetry state.
    base.mounts = await optionalMount(tool.executable, tool.executable, host);
    for (const part of ["host", "sdk", "shared", "packs", "sdk-manifests"]) {
      base.mounts.push(...await optionalMount(join(dirname(tool.executable), part), join(dirname(tool.executable), part), host));
    }
    base.mounts.push(...await optionalMount(join(host.homeDirectory, ".nuget/packages"), "/bflow-cache/nuget", host));
    base.environment = { DOTNET_ROOT: dirname(tool.executable), DOTNET_CLI_HOME: "/tmp/bflow-dotnet", NUGET_PACKAGES: "/bflow-cache/nuget", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" };
    return { runners: [{ ...base, format: "trx", nameRule: "fully qualified test class.method (TRX UnitTest TestMethod.className + name)", bind(identities, reports) {
      validateSelection(identities, project);
      return { args: ["test", basename(manifest), "--no-restore", "--nologo", "--filter", fqnNames(identities).map(name => `FullyQualifiedName=${name}`).join("|"), "--logger", "trx;LogFileName=results.trx", "--results-directory", reports], reportPaths: [`${reports}/results.trx`] };
    } }], notes: [] };
  }, host);

  const ruby = adapter("ruby", path => basename(path) === "Gemfile", async (context, manifest) => {
    const project = dirname(manifest), gemfile = await readFile(join(context.root, manifest), "utf8");
    const hasRspec = /\brspec\b/.test(gemfile), hasMinitest = /\bminitest\b/.test(gemfile);
    if (!hasRspec && !hasMinitest) return { runners: [], notes: ["ruby: runner_reporter_required: Coordinator should schedule a reviewed structured test-runner setup task"] };
    const rubyTool = await host.findTool("ruby", ["--version"]);
    if (!rubyTool) return missing("ruby", "Ruby");
    const runners: AdapterRunner[] = [], notes: string[] = [];
    if (hasRspec) {
      const tool = await host.findTool("rspec", ["--version"]);
      if (!tool) notes.push(...missing("rspec", "RSpec").notes);
      else {
        const base = await rubyBase(context, project, "rspec", tool, rubyTool, host);
        runners.push({ ...base, format: "rspec_json", nameRule: "RSpec example.full_description (nested descriptions joined with one space)", bind(identities, reports) {
          validateSelection(identities, project);
          return { args: ["--format", "json", "--out", `${reports}/rspec.json`, ...identities.testNames.flatMap(name => ["--example", `\\A${escapedRegex(name)}\\z`]), "--", ...identities.testPaths.map(path => pathInProject(path, project))], reportPaths: [`${reports}/rspec.json`] };
        } });
      }
    }
    if (hasMinitest) {
      const minitest = await host.findTool("ruby", ["-r", "minitest", "-e", "abort unless defined?(Minitest::AbstractReporter) && defined?(Minitest::UnexpectedError) && defined?(Minitest::Skip); print Minitest::VERSION"]);
      if (!minitest) notes.push(...missing("minitest", "reporter-capable Minitest").notes);
      else {
        const base = await rubyBase(context, project, "minitest", { ...rubyTool, version: `Ruby ${rubyTool.version}; Minitest ${minitest.version}` }, rubyTool, host);
        runners.push({ ...base, format: "junit", helpers: [{ name: "minitest-reporter.rb", content: MINITEST_REPORTER }], nameRule: "classname.name (Ruby class namespace, dot, Minitest method; selection uses Class#method)", bind(identities, reports) {
          validateSelection(identities, project);
          const names = identities.testNames.map(name => {
            // Minitest::Spec class names can be descriptions containing spaces and dots.
            const conventional = name.lastIndexOf(".test_"), dot = conventional > 0 ? conventional : name.indexOf(".");
            const klass = name.slice(0, dot), method = name.slice(dot + 1);
            if (dot < 1 || !klass.trim() || !method.trim()) throw new Error("runner_identity_unselectable: Minitest requires exact Class.method identities");
            return `${klass}#${method}`;
          });
          return { args: ["-r", `${reports}/minitest-reporter.rb`, "-e", MINITEST_LOADER, `${reports}/minitest.xml`, ...identities.testPaths.map(path => pathInProject(path, project)), "--", "--name", `/\\A(?:${names.map(escapedRegex).join("|")})\\z/`], reportPaths: [`${reports}/minitest.xml`] };
        } });
      }
    }
    return { runners, notes };
  }, host);

  const php = adapter("phpunit", path => basename(path) === "composer.json", async (context, manifest) => {
    const project = dirname(manifest);
    let composer: unknown;
    try { composer = JSON.parse(await readFile(join(context.root, manifest), "utf8")); } catch { return { runners: [], notes: ["phpunit: malformed composer.json"] }; }
    if (!composer || typeof composer !== "object" || !/phpunit\/phpunit/.test(JSON.stringify(composer))) return { runners: [], notes: [] };
    const phpTool = await host.findTool("php", ["--version"]);
    if (!phpTool) return missing("phpunit", "PHP");
    let tool = await host.findTool("phpunit", ["--version"]);
    const localEntry = join(context.root, project, "vendor/phpunit/phpunit/phpunit");
    let local = false;
    try {
      await access(localEntry);
      const installed: unknown = JSON.parse(await readFile(join(context.root, project, "vendor/composer/installed.json"), "utf8"));
      const packages = Array.isArray(installed) ? installed : installed && typeof installed === "object" && "packages" in installed ? installed.packages : undefined;
      const pkg = Array.isArray(packages) ? packages.find((p: unknown) => p && typeof p === "object" && "name" in p && p.name === "phpunit/phpunit") as { version?: unknown } | undefined : undefined;
      if (typeof pkg?.version === "string") { tool = { executable: phpTool.executable, version: pkg.version }; local = true; }
    } catch { /* The global version-checked PHPUnit can still be used. */ }
    if (!tool) return missing("phpunit", "PHPUnit");
    const base = await baseRunner(context, project, "phpunit", tool, host);
    base.mounts.push(...await mountTool(phpTool, host.homeDirectory));
    // Only dependency content, never composer auth.json/config.json or the entire Composer home.
    base.mounts.push(...await optionalMount(join(context.root, project, "vendor"), join(context.root, project, "vendor"), host));
    return { runners: [{ ...base, format: "junit", nameRule: "classname.name (PHP namespace-qualified class, dot, test method)", bind(identities, reports) {
      validateSelection(identities, project);
      if (identities.testNames.some(name => !/^[A-Za-z_][A-Za-z0-9_\\]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error("runner_identity_unselectable: PHPUnit requires exact Namespace\\Class.method identities");
      const filter = `/^(?:${identities.testNames.map(name => escapedRegex(name.replace(/\.([^.]+)$/, "::$1"))).join("|")})$/`;
      return { args: [...(local ? ["vendor/phpunit/phpunit/phpunit"] : []), "--do-not-cache-result", "--log-junit", `${reports}/phpunit.xml`, "--filter", filter, ...identities.testPaths.map(path => pathInProject(path, project))], reportPaths: [`${reports}/phpunit.xml`] };
    } }], notes: [] };
  }, host);

  const ctest = adapter("ctest", path => basename(path) === "CTestTestfile.cmake", async (context, manifest) => {
    const tool = await host.findTool("ctest", ["--version"]);
    if (!tool) return missing("ctest", "CTest");
    const [major = 0, minor = 0] = tool.version.split(".").map(Number);
    if (major < 3 || (major === 3 && minor < 21)) return { runners: [], notes: ["ctest: runner_reporter_required: installed CTest predates --output-junit"] };
    const project = dirname(manifest), base = await baseRunner(context, project, "ctest", tool, host);
    return { runners: [{ ...base, format: "junit", failureExitCodes: [8], nameRule: "CTest testcase.name (classname empty); one CTest registration is one test identity", bind(identities, reports) {
      validateSelection(identities, project);
      return { args: ["--output-on-failure", "--no-tests=error", "--output-junit", `${reports}/ctest.xml`, "-R", `^(${identities.testNames.map(escapedRegex).join("|")})$`], reportPaths: [`${reports}/ctest.xml`] };
    } }], notes: [] };
  }, host);

  return [maven, gradle, dotnet, ruby, php, ctest];
}

export const managedAdapters: RunnerAdapter[] = createManagedAdapters();
