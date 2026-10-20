import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AdapterContext, AdapterDetection, AdapterRunner, RunnerAdapter, RunnerIdentities, RunnerMount } from "../runner-adapter.js";

/** Host discovery is read-only. This port also makes missing toolchains deterministic in tests. */
export interface NativeHost {
  environment: NodeJS.ProcessEnv;
  home: string;
  probe(executable: string, args: string[]): Promise<string>;
}
const defaultHost: NativeHost = {
  environment: process.env,
  home: homedir(),
  probe: (executable, args) => new Promise((accept, reject) => {
    execFile(executable, args, { cwd: tmpdir(), timeout: 5000, maxBuffer: 65536,
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", LANG: "C", LC_ALL: "C", GOENV: "off", GOTOOLCHAIN: "local", GOWORK: "off", RUSTUP_AUTO_INSTALL: "0" } },
    (error, stdout, stderr) => error ? reject(error) : accept(stdout + stderr));
  })
};
const credential = /^(?:\.ssh|\.aws|\.azure|\.config|\.netrc|\.npmrc|credentials(?:\.toml)?|settings\.xml|gradle\.properties)$/i;
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch { return false; } }
function within(root: string, path: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith("../") && !isAbsolute(rel)); }
function inProject(project: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(p => !p || p === "." || p === "..") || /[\0\r\n]/.test(path)) throw new Error("runner_identity_invalid: unsafe test path");
  if (project === ".") return path;
  if (!path.startsWith(`${project}/`)) throw new Error("runner_identity_invalid: test is outside the selected project");
  return path.slice(project.length + 1);
}
function identities(value: RunnerIdentities): void {
  if (!value.testNames.length || !value.testPaths.length || value.testNames.some(n => !n || /[\0\r\n]/.test(n)) || new Set(value.testNames).size !== value.testNames.length)
    throw new Error("runner_identity_invalid: unique exact names and owned test paths are required");
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function executable(host: NativeHost, name: string, root: string): Promise<string | undefined> {
  for (const dir of (host.environment.PATH ?? "/usr/bin:/bin").split(":")) {
    if (!isAbsolute(dir)) continue;
    try {
      const path = await realpath(join(dir, name));
      // A repository-provided executable must never be run on the host during detection.
      if (within(root, path) || !(await lstat(path)).isFile()) continue;
      await access(path, constants.X_OK);
      return path;
    } catch { /* next PATH entry */ }
  }
  return undefined;
}
async function mount(path: string, host: NativeHost): Promise<RunnerMount | undefined> {
  try {
    const canonical = await realpath(path);
    if (canonical !== resolve(path) || within(canonical, resolve(host.home)) || canonical === "/" || canonical.split("/").some(p => credential.test(p))) return undefined;
    if (!(await lstat(canonical)).isDirectory() && !(await lstat(canonical)).isFile()) return undefined;
    return { source: canonical, target: canonical };
  } catch { return undefined; }
}
/** Cache roots may include SCM metadata. Reject credential-bearing caches instead of
 * exposing their config to untrusted tests; this never reads the host credential files. */
async function cacheMount(path: string, host: NativeHost): Promise<RunnerMount | undefined> {
  const candidate = await mount(path, host);
  if (!candidate) return undefined;
  const pending = [path]; let count = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return undefined; }
    for (const entry of entries) {
      if (++count > 100_000) return undefined;
      const child = join(directory, entry.name);
      if (credential.test(entry.name)) return undefined;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && ["config", "config.json", "config.toml", ".gitconfig"].includes(entry.name)) {
        const config = await safeText(child);
        if (/(?:https?:\/\/[^\s"'<>/]+@|(?:password|passwd|token|credential|authorization)\s*[=:])/i.test(config)) return undefined;
      }
    }
  }
  return candidate;
}
async function cacheMounts(paths: string[], host: NativeHost): Promise<RunnerMount[]> {
  const values = await Promise.all(paths.map(path => cacheMount(path, host)));
  return values.filter((value): value is RunnerMount => value !== undefined);
}
async function mounts(paths: string[], host: NativeHost): Promise<RunnerMount[]> {
  const result = await Promise.all([...new Set(paths)].map(path => mount(path, host)));
  return result.filter((value): value is RunnerMount => value !== undefined && !within("/usr", value.source));
}
function configs(context: AdapterContext, project: string, names: RegExp): string[] {
  return context.files.filter(path => names.test(basename(path)) && (project === "." || path.startsWith(`${project}/`))).sort();
}
function projects(context: AdapterContext, marker: RegExp): string[] {
  return [...new Set(context.files.filter(path => marker.test(basename(path))).map(path => dirname(path)))].sort();
}
async function safeText(path: string): Promise<string> {
  try { const info = await lstat(path); if (!info.isFile() || info.size > 1_048_576) return ""; return await readFile(path, "utf8"); } catch { return ""; }
}
async function children(path: string): Promise<string[]> { try { return await readdir(path); } catch { return []; } }
async function pythonEnvironments(context: AdapterContext, project: string, host: NativeHost): Promise<string[]> {
  const cwd = join(context.root, project), paths = [join(cwd, ".venv"), join(cwd, "venv")];
  if (host.environment.VIRTUAL_ENV && isAbsolute(host.environment.VIRTUAL_ENV)) paths.push(host.environment.VIRTUAL_ENV);
  const manifest = await safeText(join(cwd, "pyproject.toml"));
  // Poetry's own path hash; no `poetry run`/Pipenv shell executes on the host.
  const name = /(?:^|\n)name\s*=\s*["']([^"']+)["']/.exec(manifest)?.[1] ?? basename(cwd);
  const hash = createHash("sha256").update(cwd).digest("base64url").slice(0, 8);
  const poetryRoot = host.environment.POETRY_VIRTUALENVS_PATH ?? join(host.home, ".cache/pypoetry/virtualenvs");
  const prefix = `${name.toLowerCase().replace(/[^a-z0-9._-]/g, "_").slice(0, 42)}-${hash}-py`;
  for (const child of await children(poetryRoot)) if (child.startsWith(prefix)) paths.push(join(poetryRoot, child));
  const pipenvRoot = host.environment.WORKON_HOME ?? join(host.home, ".local/share/virtualenvs");
  const pipenvPrefix = `${basename(cwd).replace(/[ &$`!*"'()\[\]{}\\?]/g, "_").slice(0, 42)}-${hash}`;
  for (const child of await children(pipenvRoot)) if (child === pipenvPrefix) paths.push(join(pipenvRoot, child));
  return [...new Set(paths)];
}
async function pythonSites(prefix: string): Promise<string[]> {
  const result: string[] = [];
  for (const name of await children(join(prefix, "lib"))) if (/^python\d+\.\d+$/.test(name)) {
    for (const kind of ["site-packages", "dist-packages"]) {
      const path = join(prefix, "lib", name, kind);
      if (await exists(join(path, "pytest/__init__.py"))) result.push(path);
    }
  }
  return result;
}
async function detectPython(context: AdapterContext, host: NativeHost): Promise<AdapterDetection> {
  const runners: AdapterRunner[] = [], notes: string[] = [];
  for (const project of projects(context, /^(?:pyproject\.toml|pytest\.ini|setup\.cfg|setup\.py|requirements[^/]*\.txt|Pipfile)$/)) {
    const environments = await pythonEnvironments(context, project, host);
    const system = await executable(host, "python3", context.root) ?? await executable(host, "python", context.root);
    const choices = [...environments.map(prefix => ({ binary: join(prefix, "bin/python"), prefix, venv: true })), ...(system ? [{ binary: system, prefix: dirname(dirname(system)), venv: false }] : [])];
    let detected = false;
    for (const choice of choices) {
      try {
        const binary = await realpath(choice.binary);
        if (within(context.root, binary) || !(await lstat(binary)).isFile()) continue;
        const version = await host.probe(binary, ["--version"]);
        if (!/^Python 3\.\d+\.\d+/.test(version.trim())) continue;
        const sites = await pythonSites(choice.prefix);
        if (!sites.length && !choice.venv && choice.prefix === "/usr" && await exists("/usr/lib/python3/dist-packages/pytest/__init__.py")) sites.push("/usr/lib/python3/dist-packages");
        if (!sites.length) continue;
        const environment: Record<string, string> = { PYTHONDONTWRITEBYTECODE: "1", PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1", UV_OFFLINE: "1" };
        const extra = [join(dirname(dirname(binary)), "lib")];
        if (choice.venv) extra.push(join(choice.prefix, "lib"), join(choice.prefix, "pyvenv.cfg"));
        const protectedPaths = configs(context, project, /^(?:pyproject\.toml|pytest\.ini|setup\.(?:cfg|py)|tox\.ini|noxfile\.py|conftest\.py|sitecustomize\.py|usercustomize\.py|Pipfile(?:\.lock)?|poetry\.lock|uv\.lock|requirements[^/]*\.txt)$/);
        runners.push({ adapterId: "python", version: version.trim(), executable: choice.binary, projectDirectory: project, format: "junit",
          nameRule: "JUnit classname.name; e.g. tests.test_math.TestMath.test_add[param]. Exact pytest node IDs are derived from owned .py files.",
          environment, mounts: await mounts(extra, host), protectedPaths,
          bind(value, reportDirectory) {
            identities(value);
            const paths = value.testPaths.map(path => inProject(project, path));
            if (paths.some(path => !path.endsWith(".py"))) throw new Error("runner_identity_invalid: pytest requires Python test files");
            const nodes = value.testNames.map(name => {
              const matches = paths.filter(path => name.startsWith(`${path.slice(0, -3).replaceAll("/", ".")}.`));
              if (matches.length !== 1) throw new Error("runner_identity_invalid: pytest classname must uniquely identify an owned Python file");
              const path = matches[0]!, suffix = name.slice(path.slice(0, -3).replaceAll("/", ".").length + 1);
              const param = suffix.indexOf("["), before = param < 0 ? suffix : suffix.slice(0, param), after = param < 0 ? "" : suffix.slice(param);
              if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(before) || (after && !after.endsWith("]"))) throw new Error("runner_identity_invalid: malformed pytest identity");
              return `${path}::${before.replaceAll(".", "::")}${after}`;
            });
            const report = join(reportDirectory, "pytest.xml");
            return { args: ["-E", "-s", "-m", "pytest", "-o", "addopts=", "-o", "cache_dir=/tmp/bflow-pytest-cache", "-p", "no:cacheprovider", "--junitxml", report, "-o", "junit_family=xunit2", "--", ...nodes], reportPaths: [report] };
          }
        });
        detected = true; break;
      } catch { /* unusable environment: another installed environment may work */ }
    }
    if (!detected) notes.push(`python:${project}: runner_dependency_setup_required: installed Python/pytest environment unavailable; Coordinator can add a reviewed setup task`);
  }
  return { runners, notes };
}
async function detectGo(context: AdapterContext, host: NativeHost): Promise<AdapterDetection> {
  const runners: AdapterRunner[] = [], notes: string[] = [];
  const roots = projects(context, /^go\.mod$/);
  if (!roots.length) return { runners, notes };
  const binary = await executable(host, "go", context.root);
  if (!binary) return { runners, notes: ["go: runner_toolchain_setup_required: Go is unavailable"] };
  let version: string, goroot: string;
  try {
    version = (await host.probe(binary, ["version"])).trim();
    if (!/^go version go1\.\d+/.test(version)) throw new Error("unknown Go version");
    goroot = (await host.probe(binary, ["env", "GOROOT"])).trim();
    if (!isAbsolute(goroot) || !await exists(join(goroot, "pkg"))) throw new Error("invalid GOROOT");
  } catch { return { runners, notes: ["go: runner_toolchain_setup_required: Go toolchain probe failed"] }; }
  const toolMounts = await mounts([goroot], host);
  for (const project of roots) {
    const text = await safeText(join(context.root, project, "go.mod"));
    const module = /^module\s+(?:"([^"\r\n]+)"|([^\s]+))/m.exec(text)?.slice(1).find(Boolean);
    if (!module) { notes.push(`go:${project}: malformed go.mod module`); continue; }
    const cache = host.environment.GOMODCACHE ?? join(host.environment.GOPATH?.split(":")[0] ?? join(host.home, "go"), "pkg/mod");
    const dependencies = await cacheMounts([cache], host);
    runners.push({ adapterId: "go", version, executable: binary, projectDirectory: project, format: "go_json", mounts: [...toolMounts, ...dependencies],
      environment: { GOROOT: goroot, GOENV: "off", GOTOOLCHAIN: "local", GOWORK: "off", GOPROXY: "off", GOSUMDB: "off", GOFLAGS: "-mod=readonly", GOCACHE: "/tmp/bflow-go-build", GOMODCACHE: cache, CGO_ENABLED: "0" },
      protectedPaths: configs(context, project, /^(?:go\.(?:mod|sum|work)|go\.work\.sum)$/),
      nameRule: "Go import path + '.' + exact Test/subtest name; e.g. example.org/math.TestAdd/negative.",
      bind(value) {
        identities(value);
        const paths = value.testPaths.map(path => inProject(project, path));
        if (paths.some(path => !path.endsWith("_test.go"))) throw new Error("runner_identity_invalid: Go requires owned _test.go files");
        const packages = [...new Set(paths.map(dirname))];
        const selected = value.testNames.map(name => {
          const candidates = packages.map(path => ({ path, prefix: `${module}${path === "." ? "" : `/${path}`}.` })).filter(item => name.startsWith(item.prefix));
          if (candidates.length !== 1) throw new Error("runner_identity_invalid: Go identity must name an owned package");
          const test = name.slice(candidates[0]!.prefix.length);
          if (!/^(?:Test[A-Za-z0-9_]+|Example[A-Za-z0-9_]*|Fuzz[A-Za-z0-9_]+)(?:\/[^/\r\n]+)*$/.test(test)) throw new Error("runner_identity_invalid: unsupported Go test identity");
          return { package: candidates[0]!.path, test };
        });
        // A single Go -run applies to every package and slash segment. Cross-package or
        // sibling-subtest unions can execute unmapped tests, so split them into tasks.
        if (new Set(selected.map(item => item.package)).size !== 1 || (selected.length > 1 && selected.some(item => item.test.includes("/"))))
          throw new Error("runner_identity_invalid: split Go packages or subtest groups into separate tasks");
        const filter = selected.length === 1 ? selected[0]!.test.split("/").map(part => `^${escapeRegex(part)}$`).join("/") : `^(?:${selected.map(item => escapeRegex(item.test)).join("|")})$`;
        const pkg = selected[0]!.package;
        return { args: ["test", "-json", "-count=1", "-vet=off", "-run", filter, pkg === "." ? "." : `./${pkg}`] };
      }
    });
  }
  return { runners, notes };
}
async function detectRust(context: AdapterContext, host: NativeHost): Promise<AdapterDetection> {
  const runners: AdapterRunner[] = [], notes: string[] = [];
  const roots = projects(context, /^Cargo\.toml$/);
  if (!roots.length) return { runners, notes };
  let cargo = await executable(host, "cargo", context.root), rustc = await executable(host, "rustc", context.root);
  // Resolve rustup shims without exposing .rustup/settings.toml or the entire home.
  if (!cargo || basename(cargo) === "rustup") {
    const root = join(host.home, ".rustup/toolchains"), installed = (await children(root)).filter(name => /^(?:stable|\d+\.\d+\.\d+)-/.test(name)).sort();
    const preferred = installed.find(name => name.startsWith("stable-")) ?? installed.at(-1);
    if (preferred) { cargo = join(root, preferred, "bin/cargo"); rustc = join(root, preferred, "bin/rustc"); }
  }
  if (!cargo || !rustc) return { runners, notes: ["rust: runner_toolchain_setup_required: cargo/rustc are unavailable"] };
  let version: string;
  try { cargo = await realpath(cargo); rustc = await realpath(rustc); if (within(context.root, cargo) || within(context.root, rustc)) throw new Error("repository toolchain rejected"); version = (await host.probe(cargo, ["--version"])).trim(); if (!/^cargo 1\.\d+\.\d+/.test(version) || !/^rustc 1\.\d+\.\d+/.test((await host.probe(rustc, ["--version"])).trim())) throw new Error("invalid Rust toolchain"); }
  catch { return { runners, notes: ["rust: runner_toolchain_setup_required: cargo/rustc probe failed"] }; }
  const toolchain = dirname(dirname(cargo)), cargoHome = host.environment.CARGO_HOME ?? join(host.home, ".cargo");
  const paths = [join(toolchain, "bin"), join(toolchain, "lib")];
  const dependencies = await cacheMounts(["src", "cache", "index"].map(part => join(cargoHome, "registry", part)), host);
  for (const project of roots) runners.push({ adapterId: "rust", version, executable: cargo, projectDirectory: project, format: "rust_libtest", mounts: [...await mounts(paths, host), ...dependencies],
    environment: { CARGO_NET_OFFLINE: "true", CARGO_TARGET_DIR: "/tmp/bflow-cargo-target", CARGO_HOME: cargoHome, RUSTC: rustc, RUSTDOC: join(dirname(rustc), "rustdoc"), RUST_BACKTRACE: "0" },
    protectedPaths: configs(context, project, /^(?:Cargo\.(?:toml|lock)|config(?:\.toml)?|rust-toolchain(?:\.toml)?|build\.rs)$/),
    nameRule: "Exact stable Rust libtest identity, including module::test; exactly one identity per measurement.",
    bind(value) {
      identities(value);
      const paths = value.testPaths.map(path => inProject(project, path));
      if (value.testNames.length !== 1 || paths.some(path => !path.endsWith(".rs"))) throw new Error("runner_identity_invalid: Rust requires one exact test identity and owned Rust files");
      const name = value.testNames[0]!;
      if (!/^[A-Za-z_][\w:]*(?:[A-Za-z0-9_])?$/.test(name)) throw new Error("runner_identity_invalid: malformed Rust identity");
      const integration = [...new Set(paths.filter(path => /^tests\/[^/]+\.rs$/.test(path)).map(path => basename(path, ".rs")))];
      if (integration.length > 1 || (integration.length && paths.some(path => !path.startsWith("tests/")))) throw new Error("runner_identity_invalid: split Rust test targets into separate tasks");
      return { args: ["test", "--offline", "--locked", ...(integration.length ? ["--test", integration[0]!] : ["--lib"]), "--", name, "--exact", "--nocapture", "--test-threads=1"] };
    }
  });
  return { runners, notes };
}
export function createNativeAdapters(host: NativeHost = defaultHost): RunnerAdapter[] {
  return [{ id: "python", detect: context => detectPython(context, host) }, { id: "go", detect: context => detectGo(context, host) }, { id: "rust", detect: context => detectRust(context, host) }];
}
export const nativeAdapters: RunnerAdapter[] = createNativeAdapters();
