import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNativeAdapters, type NativeHost } from "./native.js";
import type { AdapterContext, AdapterRunner } from "../runner-adapter.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(files: Record<string, string>): Promise<AdapterContext> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-runner-")));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  return { root, files: Object.keys(files) };
}
async function hostTool(name: string): Promise<{ path: string; home: string }> {
  const context = await fixture({ [`bin/${name}`]: "host tool fixture" });
  const home = (await fixture({ ".keep": "" })).root;
  const path = join(context.root, "bin", name); await chmod(path, 0o755);
  return { path, home };
}
function fakeHost(home: string, toolPath: string, probe: NativeHost["probe"]): NativeHost {
  return { home, environment: { PATH: dirname(toolPath) }, probe };
}
function runner(value: AdapterRunner | undefined): AdapterRunner { if (!value) throw new Error("expected runner"); return value; }

describe("Python native runner", () => {
  async function python(files: Record<string, string> = {}): Promise<{ context: AdapterContext; host: NativeHost }> {
    const tool = await hostTool("python3");
    const context = await fixture({ "pyproject.toml": '[project]\nname="math"', "conftest.py": "", "tests/test_math.py": "", ...files });
    await mkdir(join(context.root, ".venv/bin"), { recursive: true });
    await symlink(tool.path, join(context.root, ".venv/bin/python"));
    await mkdir(join(context.root, ".venv/lib/python3.12/site-packages/pytest"), { recursive: true });
    await writeFile(join(context.root, ".venv/lib/python3.12/site-packages/pytest/__init__.py"), "");
    await writeFile(join(context.root, ".venv/pyvenv.cfg"), "home=/usr/bin");
    return { context, host: fakeHost(tool.home, tool.path, async (_exe, args) => { expect(args).toEqual(["--version"]); return "Python 3.12.3\n"; }) };
  }
  it("finds uv/in-project Poetry/Pipenv venvs and binds exact JUnit classname.name identities", async () => {
    const { context, host } = await python({ "uv.lock": "", "poetry.lock": "", "Pipfile.lock": "" });
    const result = await createNativeAdapters(host)[0]!.detect(context);
    const profile = runner(result.runners[0]);
    expect(profile.adapterId).toBe("python");
    expect(profile.executable).toBe(join(context.root, ".venv/bin/python"));
    expect(profile.environment).toMatchObject({ PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1", PIP_NO_INDEX: "1", UV_OFFLINE: "1" });
    expect(profile.protectedPaths).toEqual(["Pipfile.lock", "conftest.py", "poetry.lock", "pyproject.toml", "uv.lock"]);
    expect(profile.mounts.map(value => value.source)).toContain(join(context.root, ".venv/lib"));
    expect(profile.bind({ testNames: ["tests.test_math.TestMath.test_add[param.with.dot]"], testPaths: ["tests/test_math.py"] }, "/tmp/reports")).toEqual({
      args: ["-E", "-s", "-m", "pytest", "-o", "addopts=", "-o", "cache_dir=/tmp/bflow-pytest-cache", "-p", "no:cacheprovider", "--junitxml", "/tmp/reports/pytest.xml", "-o", "junit_family=xunit2", "--", "tests/test_math.py::TestMath::test_add[param.with.dot]"], reportPaths: ["/tmp/reports/pytest.xml"]
    });
  });
  it("rejects unmapped names, unsafe files, names without a classname and duplicate identities", async () => {
    const { context, host } = await python();
    const profile = runner((await createNativeAdapters(host)[0]!.detect(context)).runners[0]);
    for (const input of [
      { testNames: ["test_add"], testPaths: ["tests/test_math.py"] },
      { testNames: ["tests.test_math.test_add"], testPaths: ["../tests/test_math.py"] },
      { testNames: ["tests.test_math.test_add"], testPaths: ["tests/test_other.py"] },
      { testNames: ["tests.test_math.test_add", "tests.test_math.test_add"], testPaths: ["tests/test_math.py"] }
    ]) expect(() => profile.bind(input, "/tmp/reports")).toThrow("runner_identity_invalid");
  });
  it("does not execute repository-provided Python during detection", async () => {
    const { context, host } = await python();
    await rm(join(context.root, ".venv/bin/python")); await writeFile(join(context.root, ".venv/bin/python"), "repo binary");
    host.environment.PATH = join(context.root, ".venv/bin");
    let probes = 0; host.probe = async () => { probes++; return "Python 3.12.3"; };
    const result = await createNativeAdapters(host)[0]!.detect(context);
    expect(result.runners).toEqual([]); expect(probes).toBe(0);
    expect(result.notes.join()).toContain("runner_dependency_setup_required");
  });
  it("detects Python subprojects while rejecting cross-project ownership", async () => {
    const { context, host } = await python({ "services/py/pyproject.toml": "[project]\nname='py'", "services/py/tests/test_math.py": "" });
    host.environment.VIRTUAL_ENV = join(context.root, ".venv");
    const profiles = (await createNativeAdapters(host)[0]!.detect(context)).runners;
    expect(profiles.map(value => value.projectDirectory)).toEqual([".", "services/py"]);
    expect(profiles[1]!.bind({ testNames: ["tests.test_math.test_add"], testPaths: ["services/py/tests/test_math.py"] }, "/tmp/reports").args.at(-1)).toBe("tests/test_math.py::test_add");
    expect(() => profiles[1]!.bind({ testNames: ["tests.test_math.test_add"], testPaths: ["tests/test_math.py"] }, "/tmp/reports")).toThrow("outside");
  });
});

describe("Go native runner", () => {
  async function go(files: Record<string, string> = {}): Promise<{ context: AdapterContext; host: NativeHost }> {
    const tool = await hostTool("go");
    await mkdir(join(dirname(dirname(tool.path)), "pkg"));
    const context = await fixture({ "go.mod": "module example.org/math\n\ngo 1.23\n", "go.sum": "", "math_test.go": "", "sub/math_test.go": "", ...files });
    const host = fakeHost(tool.home, tool.path, async (_exe, args) => args[0] === "version" ? "go version go1.23.4 linux/amd64" : dirname(dirname(tool.path)));
    await mkdir(join(tool.home, "go/pkg/mod"), { recursive: true });
    return { context, host };
  }
  it("probes version and GOROOT, mounts only toolchain/module cache, and anchors every subtest segment", async () => {
    const { context, host } = await go();
    const profile = runner((await createNativeAdapters(host)[1]!.detect(context)).runners[0]);
    expect(profile.environment).toMatchObject({ GOPROXY: "off", GOSUMDB: "off", GOTOOLCHAIN: "local", GOFLAGS: "-mod=readonly", CGO_ENABLED: "0" });
    expect(profile.mounts.some(value => value.source === host.home)).toBe(false);
    expect(profile.mounts.map(value => value.source)).toContain(join(host.home, "go/pkg/mod"));
    expect(profile.bind({ testNames: ["example.org/math/sub.TestAdd/a+b"], testPaths: ["sub/math_test.go"] }, "/tmp/r").args).toEqual(["test", "-json", "-count=1", "-vet=off", "-run", "^TestAdd$/^a\\+b$", "./sub"]);
    expect(profile.protectedPaths).toEqual(["go.mod", "go.sum"]);
  });
  it("supports exact top-level unions and examples without running all suite tests", async () => {
    const { context, host } = await go();
    const profile = runner((await createNativeAdapters(host)[1]!.detect(context)).runners[0]);
    expect(profile.bind({ testNames: ["example.org/math.TestAdd", "example.org/math.Example"], testPaths: ["math_test.go"] }, "/tmp/r").args).toContain("^(?:TestAdd|Example)$");
  });
  it("rejects names outside owned packages and cross-package/subtest unions", async () => {
    const { context, host } = await go();
    const profile = runner((await createNativeAdapters(host)[1]!.detect(context)).runners[0]);
    for (const input of [
      { testNames: ["example.org/math.TestAdd"], testPaths: ["sub/math_test.go"] },
      { testNames: ["example.org/math.TestAdd", "example.org/math/sub.TestAdd"], testPaths: ["math_test.go", "sub/math_test.go"] },
      { testNames: ["example.org/math.TestAdd/a", "example.org/math.TestAdd/b"], testPaths: ["math_test.go"] },
      { testNames: ["example.org/math.TestAdd"], testPaths: ["math.go"] }
    ]) expect(() => profile.bind(input, "/tmp/r")).toThrow("runner_identity_invalid");
  });
  it("fails closed when the version or GOROOT probe is invalid", async () => {
    const { context, host } = await go(); host.probe = async () => "unrecognized";
    const result = await createNativeAdapters(host)[1]!.detect(context);
    expect(result.runners).toEqual([]); expect(result.notes.join()).toContain("probe failed");
  });
});

describe("Rust native runner", () => {
  async function rust(): Promise<{ context: AdapterContext; host: NativeHost }> {
    const tool = await hostTool("cargo");
    await writeFile(join(dirname(tool.path), "rustc"), "host rustc"); await chmod(join(dirname(tool.path), "rustc"), 0o755);
    await mkdir(join(dirname(dirname(tool.path)), "lib"));
    await mkdir(join(tool.home, ".cargo/registry/src"), { recursive: true });
    await writeFile(join(tool.home, ".cargo/credentials.toml"), "secret-not-mounted");
    const context = await fixture({ "Cargo.toml": "[package]\nname='math'\nversion='0.1.0'", "Cargo.lock": "", ".cargo/config.toml": "", "build.rs": "", "src/lib.rs": "", "tests/math.rs": "" });
    return { context, host: fakeHost(tool.home, tool.path, async exe => exe.endsWith("rustc") ? "rustc 1.83.0 (build)" : "cargo 1.83.0 (build)") };
  }
  it("selects one exact libtest name, locks offline dependencies and excludes credentials", async () => {
    const { context, host } = await rust();
    const profile = runner((await createNativeAdapters(host)[2]!.detect(context)).runners[0]);
    expect(profile.environment).toMatchObject({ CARGO_NET_OFFLINE: "true", CARGO_TARGET_DIR: "/tmp/bflow-cargo-target" });
    expect(profile.mounts.map(value => value.source)).toContain(join(host.home, ".cargo/registry/src"));
    expect(profile.mounts.some(value => value.source.endsWith(".cargo") || value.source.includes("credentials"))).toBe(false);
    expect(profile.protectedPaths).toEqual([".cargo/config.toml", "Cargo.lock", "Cargo.toml", "build.rs"]);
    expect(profile.bind({ testNames: ["tests::addition"], testPaths: ["src/lib.rs"] }, "/tmp/r").args).toEqual(["test", "--offline", "--locked", "--lib", "--", "tests::addition", "--exact", "--nocapture", "--test-threads=1"]);
    expect(profile.bind({ testNames: ["addition"], testPaths: ["tests/math.rs"] }, "/tmp/r").args).toContain("math");
  });
  it("rejects ambiguous targets and multiple name filters", async () => {
    const { context, host } = await rust();
    const profile = runner((await createNativeAdapters(host)[2]!.detect(context)).runners[0]);
    for (const input of [
      { testNames: ["add", "subtract"], testPaths: ["src/lib.rs"] },
      { testNames: ["add"], testPaths: ["src/lib.rs", "tests/math.rs"] },
      { testNames: ["add"], testPaths: ["tests/math.rs", "tests/other.rs"] },
      { testNames: ["add"], testPaths: ["Cargo.toml"] }
    ]) expect(() => profile.bind(input, "/tmp/r")).toThrow("runner_identity_invalid");
  });
});

it("reports separate missing toolchains in a polyglot manifest inventory", async () => {
  const context = await fixture({ "go.mod": "module x\ngo 1.23\n", "Cargo.toml": "[package]\nname='x'", "pyproject.toml": "[project]\nname='x'", "package.json": '{}' });
  const adapters = createNativeAdapters({ environment: { PATH: "" }, home: "/unavailable", probe: async () => { throw new Error("must not probe missing executable"); } });
  const results = await Promise.all(adapters.map(adapter => adapter.detect(context)));
  expect(results.flatMap(result => result.runners)).toEqual([]);
  expect(results.flatMap(result => result.notes)).toHaveLength(3);
  expect(results[0]!.notes.join()).toContain("runner_dependency_setup_required");
});

it("exposes all three installed native adapters for a monorepo and isolates task selection", async () => {
  const tools = await fixture({ "bin/go": "tool", "bin/python3": "tool", "bin/cargo": "tool", "bin/rustc": "tool", "lib/.keep": "", "pkg/.keep": "" });
  for (const name of ["go", "python3", "cargo", "rustc"]) await chmod(join(tools.root, "bin", name), 0o755);
  const home = (await fixture({ ".keep": "" })).root;
  const context = await fixture({ "services/go/go.mod": "module example/go\ngo 1.23", "services/go/math_test.go": "", "services/python/pyproject.toml": "[project]\nname='py'", "services/python/tests/test_math.py": "", "services/rust/Cargo.toml": "[package]\nname='rust'", "services/rust/Cargo.lock": "", "services/rust/src/lib.rs": "", "package.json": "{}" });
  await mkdir(join(context.root, "services/python/.venv/bin"), { recursive: true });
  await symlink(join(tools.root, "bin/python3"), join(context.root, "services/python/.venv/bin/python"));
  await mkdir(join(context.root, "services/python/.venv/lib/python3.12/site-packages/pytest"), { recursive: true });
  await writeFile(join(context.root, "services/python/.venv/lib/python3.12/site-packages/pytest/__init__.py"), "");
  const host = fakeHost(home, join(tools.root, "bin/go"), async (path, args) => path.endsWith("/go") ? args[0] === "version" ? "go version go1.23.4 linux/amd64" : tools.root : path.endsWith("cargo") ? "cargo 1.83.0" : path.endsWith("rustc") ? "rustc 1.83.0" : "Python 3.12.3");
  const profiles = (await Promise.all(createNativeAdapters(host).map(adapter => adapter.detect(context)))).flatMap(result => result.runners);
  expect(profiles.map(profile => [profile.adapterId, profile.projectDirectory])).toEqual([["python", "services/python"], ["go", "services/go"], ["rust", "services/rust"]]);
  for (const profile of profiles) expect(() => profile.bind({ testNames: ["wrong"], testPaths: ["other/test.py"] }, "/tmp/r")).toThrow("runner_identity_invalid");
});

it("omits Cargo index caches containing credential-bearing Git configuration", async () => {
  const tools = await fixture({ "bin/cargo": "tool", "bin/rustc": "tool", "lib/.keep": "" });
  await chmod(join(tools.root, "bin/cargo"), 0o755); await chmod(join(tools.root, "bin/rustc"), 0o755);
  const home = (await fixture({ ".cargo/registry/index/private/.git/config": '[remote "origin"]\nurl = https://private-token@example.test/index', ".cargo/credentials.toml": "private-token" })).root;
  const context = await fixture({ "Cargo.toml": "[package]\nname='math'" });
  const host = fakeHost(home, join(tools.root, "bin/cargo"), async path => path.endsWith("rustc") ? "rustc 1.83.0" : "cargo 1.83.0");
  const profile = runner((await createNativeAdapters(host)[2]!.detect(context)).runners[0]);
  expect(profile.mounts.some(value => value.source.startsWith(home))).toBe(false);
});
