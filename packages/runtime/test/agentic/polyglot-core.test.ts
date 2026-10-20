import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { bindRunnerProfile, type RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { pinRunnerDefinitions, assertRunnerProvenance } from "../../src/agentic/runner-provenance.js";
import { collectRunnerReports } from "../../src/agentic/runner-reports.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { validateRunnerMount } from "../../src/agentic/behavioral-sandbox.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "polyglot-core-")); roots.push(path); return path; }
function profile(path: string): RunnerProfile { return { id: "auto-unit", command: "auto:unit", executable: process.execPath, args: ["--test"], reporter: "node_tap", method: "unit_test", levels: ["unit"], timeoutMs: 1000, checkoutDependencyRoots: [], dependencySource: path, source: "detected" }; }
it("pins Makefile, package scripts and runner configuration to original revision and rejects changes/additions", async () => {
  const cwd = await root();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(cwd, "Makefile"), "test:\n\tprintf original\n"); await writeFile(join(cwd, "package.json"), '{"scripts":{"test":"node --test"}}');
  git("add", "."); git("commit", "-m", "base");
  const detection = await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd)], notes: [] });
  if (detection.status !== "detected") throw new Error("missing profile");
  const command = bindRunnerProfile(detection.profiles[0]!, { testNames: ["behavior"], testPaths: ["test/a.test.js"] });
  await expect(assertRunnerProvenance(command, cwd, git("rev-parse", "HEAD"))).resolves.toBeUndefined();
  for (const path of ["Makefile", "package.json", "conftest.py"]) {
    await writeFile(join(cwd, path), "altered\n"); git("add", "."); git("commit", "-m", "tamper " + path);
    await expect(assertRunnerProvenance(command, cwd, git("rev-parse", "HEAD"))).rejects.toThrow("original revision");
  }
  expect(command.args).toEqual(["--test", "--test-name-pattern=^(?:behavior)$", "test/a.test.js"]);
});
it("collects bounded reports and rejects symlinks, special files and escaping paths", async () => {
  const path = await root(), checkout = join(path, "checkout"), reports = join(path, "reports");
  await mkdir(checkout); await mkdir(reports);
  await writeFile(join(reports, "result.xml"), "<testsuite/>");
  expect(await collectRunnerReports([join(reports, "*.xml")], checkout, reports)).toEqual(["<testsuite/>"]);
  await symlink(join(reports, "result.xml"), join(reports, "link.xml"));
  await expect(collectRunnerReports([join(reports, "link.xml")], checkout, reports)).rejects.toThrow("symlinks");
  await expect(collectRunnerReports(["../../etc/passwd"], checkout, reports)).rejects.toThrow("Unsafe");
});
it("probes sandbox availability with a structured unsupported outcome rather than executing unisolated", async () => {
  const result = await probeBehavioralSandbox();
  if (result.status === "ready") expect(result.executable.startsWith("/")).toBe(true);
  else expect(result).toMatchObject({ code: "verification_sandbox_unavailable", reason: expect.any(String) });
});
it("rejects home, credentials and namespace overriding mounts", async () => {
  for (const source of [process.env.HOME!, "/", "/usr", "/etc", "/home", "/tmp", "/home/u/.ssh", "/home/u/.m2/settings.xml"]) {
    await expect(validateRunnerMount({ source, target: source }, "/checkout")).rejects.toThrow();
  }
});
it("rejects unpinned automatic evidence and new root build hooks; permits mapped test changes before Red", async () => {
  const cwd = await root();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await mkdir(join(cwd, "test")); await writeFile(join(cwd, "test/a.test.js"), "before"); git("add", "."); git("commit", "-m", "base");
  const detection = await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd)], notes: [] });
  if (detection.status !== "detected") throw new Error("missing profile");
  const identities = { testNames: ["behavior"], testPaths: ["test/a.test.js"] };
  const command = bindRunnerProfile(detection.profiles[0]!, identities);
  await writeFile(join(cwd, "test/a.test.js"), "Red test bytes"); git("add", "."); git("commit", "-m", "test change");
  await expect(assertRunnerProvenance(command, cwd, git("rev-parse", "HEAD"))).resolves.toBeUndefined();
  await expect(assertRunnerProvenance(bindRunnerProfile(profile(cwd), identities), cwd, git("rev-parse", "HEAD"))).rejects.toThrow("no pinned");
  await writeFile(join(cwd, "build.rs"), "fn main(){}"); git("add", "."); git("commit", "-m", "new hook");
  await expect(assertRunnerProvenance(command, cwd, git("rev-parse", "HEAD"))).rejects.toThrow("original revision");
});
it("checks the original task base even if the host discovers a newer committed runner configuration", async () => {
  const cwd = await root();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(cwd, "Makefile"), "test:\n\ttrue\n"); git("add", "."); git("commit", "-m", "base"); const originalRevision = git("rev-parse", "HEAD");
  await writeFile(join(cwd, "Makefile"), "test:\n\tfalse\n"); git("add", "."); git("commit", "-m", "new host head");
  const detection = await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd)], notes: [] });
  if (detection.status !== "detected") throw new Error("missing profile");
  const command = { ...bindRunnerProfile(detection.profiles[0]!, { testNames: ["target"], testPaths: ["tests/a.test.js"] }), originalRevision };
  await expect(assertRunnerProvenance(command, cwd, git("rev-parse", "HEAD"))).rejects.toThrow("original task revision");
});
it("retains detected profile snapshots while repository HEAD advances", async () => {
  const { TestRunnerSource } = await import("../../src/agentic/task-commands.js");
  const cwd = await root();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(cwd, "README.md"), "a"); git("add", "."); git("commit", "-m", "first"); const first = git("rev-parse", "HEAD");
  let generation = 0;
  const source = new TestRunnerSource([], cwd, async () => ({ status: "detected", profiles: [{ ...profile(cwd), args: [String(++generation)] }], notes: [] }));
  await source.refresh(); await writeFile(join(cwd, "README.md"), "b"); git("add", "."); git("commit", "-m", "second");
  await source.refresh();
  expect(source.profiles[0]!.args).toEqual(["2"]);
  expect(source.profilesForRevision(first)[0]!.args).toEqual(["1"]);
});
it("assigns unique stable labels to nested projects whose flattened paths collide", async () => {
  const { detectTestRunners } = await import("../../src/agentic/runner-detection.js");
  const cwd = await root();
  const adapter = { id: "fixture", async detect() { return { notes: [], runners: ["a/b", "a-b"].map(projectDirectory => ({ adapterId: "go", version: "1.23", executable: "/usr/bin/true", projectDirectory, format: "go_json" as const, nameRule: "package.Test", mounts: [], environment: {}, protectedPaths: [], bind: () => ({ args: [] }) })) }; } };
  const result = await detectTestRunners(cwd, { adapters: [adapter] });
  expect(result.status).toBe("detected"); if (result.status !== "detected") throw new Error("missing catalog");
  expect(result.profiles).toHaveLength(6);
  expect(new Set(result.profiles.map(profile => profile.id)).size).toBe(6);
  expect(new Set(result.profiles.map(profile => profile.command)).size).toBe(6);
});
it("never executes repository Git smudge/process filters while creating the disposable measurement checkout", async () => {
  const { verificationGit } = await import("../../src/agentic/behavioral-runner.js");
  const cwd = await root(), checkout = await root(), sentinel = join(cwd, "filter-was-executed");
  await rm(checkout, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(cwd, ".gitattributes"), "*.txt filter=fixture\n"); await writeFile(join(cwd, "data.txt"), "committed bytes\n");
  git("add", "."); git("commit", "-m", "base");
  git("config", "filter.fixture.smudge", `touch '${sentinel}'; cat`); git("config", "filter.fixture.required", "true");
  try {
    await verificationGit(cwd, ["worktree", "add", "--detach", checkout, git("rev-parse", "HEAD")]);
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(checkout, "data.txt"), "utf8")).toBe("committed bytes\n");
  } finally { await verificationGit(cwd, ["worktree", "remove", "--force", checkout]).catch(() => undefined); }
});
it.each(["include", "worktree", "future-worktree"] as const)("does not execute Git filters inherited through %s configuration", async scope => {
  const { verificationGit } = await import("../../src/agentic/behavioral-runner.js");
  const cwd = await root(), checkout = join(await root(), "checkout"), sentinel = join(cwd, "filter-ran");
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(cwd, ".gitattributes"), "*.txt filter=fixture\n"); await writeFile(join(cwd, "data.txt"), "original\n");
  git("add", "."); git("commit", "-m", "base");
  const included = join(cwd, ".git", "included.config");
  await writeFile(included, `[filter "fixture"]\n smudge = "touch '${sentinel}'; cat"\n required = true\n`);
  if (scope === "include") git("config", "include.path", included);
  else if (scope === "worktree") { git("config", "extensions.worktreeConfig", "true"); git("config", "--worktree", "include.path", included); }
  else git("config", `includeIf.gitdir:${cwd}/.git/worktrees/.path`, included);
  try {
    await verificationGit(cwd, ["worktree", "add", "--detach", checkout, git("rev-parse", "HEAD")]);
    const { readFile } = await import("node:fs/promises");
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(checkout, "data.txt"), "utf8")).toBe("original\n");
  } finally { await verificationGit(cwd, ["worktree", "remove", "--force", checkout]).catch(() => undefined); }
});
it.each(["build-support/checks.gradle", "build-support/checks.gradle.kts", "build-support/checks.targets", "build-support/checks.props", "build-support/checks.cmake"])("freezes imported execution definitions at %s", async helper => {
  const cwd = await root();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await mkdir(join(cwd, "build-support")); await writeFile(join(cwd, "build.gradle"), `apply from: '${helper}'\n`); await writeFile(join(cwd, helper), "original test configuration\n");
  git("add", "."); git("commit", "-m", "base"); const originalRevision = git("rev-parse", "HEAD");
  const detection = await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd)], notes: [] });
  if (detection.status !== "detected") throw new Error("missing profile");
  const command = { ...bindRunnerProfile(detection.profiles[0]!, { testNames: ["target"], testPaths: ["tests/a.test.js"] }), originalRevision };
  await writeFile(join(cwd, helper), "disable tests and synthesize output\n"); git("add", "."); git("commit", "-m", "task replaces imported script");
  await expect(assertRunnerProvenance(command, cwd, git("rev-parse", "HEAD"))).rejects.toThrow("original revision");
});
it("rejects imported dependency sockets and credentials while allowing pnpm links inside the selected layout", async () => {
  const { validateDependencyTrees } = await import("../../src/agentic/behavioral-sandbox.js");
  const { createServer } = await import("node:net");
  const cwd = await root(), modules = join(cwd, "node_modules"), nested = join(cwd, "pkg/node_modules");
  await mkdir(join(modules, ".store/dep"), { recursive: true }); await mkdir(nested, { recursive: true });
  await writeFile(join(modules, ".store/dep/index.js"), "module.exports=4");
  await symlink("../../node_modules/.store/dep", join(nested, "dep"));
  await expect(validateDependencyTrees([modules, nested], cwd)).resolves.toBeUndefined();
  const server = createServer(); const socket = join(modules, "host.sock");
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(socket, accept); });
  try { await expect(validateDependencyTrees([modules, nested], cwd)).rejects.toThrow("Special file"); }
  finally { await new Promise<void>(accept => server.close(() => accept())); }
  await writeFile(join(modules, ".npmrc"), "sensitive fixture");
  await expect(validateDependencyTrees([modules], cwd)).rejects.toThrow("Credential");
});
it("pins a literal Gradle import with a custom suffix and rejects unresolvable dynamic imports", async () => {
  const cwd = await root();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(cwd, "build.gradle"), "apply from: 'checks.custom'\n"); await writeFile(join(cwd, "checks.custom"), "test setup\n");
  git("add", "."); git("commit", "-m", "static");
  const detected = await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd)], notes: [] });
  expect(detected.status).toBe("detected"); if (detected.status !== "detected") throw new Error("missing pin");
  expect(detected.profiles[0]!.definitionBlobs).toHaveProperty("checks.custom");
  await writeFile(join(cwd, "build.gradle"), "apply from: computeFile()\n"); git("add", "."); git("commit", "-m", "dynamic");
  expect(await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd)], notes: [] })).toMatchObject({ status: "unsupported", agentFixable: true });
});
it("resolves nested Gradle apply paths against the owning project, including custom-suffix imports", async () => {
  const cwd = await root();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await mkdir(join(cwd, "build-support"));
  await writeFile(join(cwd, "build.gradle"), "apply from: 'build-support/first.gradle'\n");
  await writeFile(join(cwd, "build-support/first.gradle"), "apply from: 'second.custom'\n");
  await writeFile(join(cwd, "second.custom"), "actual project script\n"); await writeFile(join(cwd, "build-support/second.custom"), "unrelated same-name file\n");
  git("add", "."); git("commit", "-m", "nested static scripts");
  const detection = await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd)], notes: [] });
  expect(detection.status).toBe("detected"); if (detection.status !== "detected") throw new Error("missing pin");
  expect(detection.profiles[0]!.definitionBlobs).toHaveProperty("second.custom");
});
it("resolves MSBuildProjectDirectory from the project root instead of a same-name imported-file decoy", async () => {
  const cwd = await root();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await mkdir(join(cwd, "build-support"));
  await writeFile(join(cwd, "Tests.csproj"), '<Project><Import Project="build-support/common.props"/></Project>');
  await writeFile(join(cwd, "build-support/common.props"), '<Project><Import Project="$(MSBuildProjectDirectory)/checks.custom"/></Project>');
  await writeFile(join(cwd, "checks.custom"), "actual runner definition\n");
  await writeFile(join(cwd, "build-support/checks.custom"), "same-name decoy\n");
  git("add", "."); git("commit", "-m", "original");
  const originalRevision = git("rev-parse", "HEAD");
  const detection = await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd)], notes: [] });
  expect(detection.status).toBe("detected"); if (detection.status !== "detected") throw new Error("missing pin");
  expect(detection.profiles[0]!.definitionBlobs).toHaveProperty("checks.custom");
  const command = { ...bindRunnerProfile(detection.profiles[0]!, { testNames: ["target"], testPaths: ["tests/a.test.js"] }), originalRevision };
  await writeFile(join(cwd, "checks.custom"), "disable tests\n"); git("add", "."); git("commit", "-m", "task mutation");
  await expect(assertRunnerProvenance(command, cwd, git("rev-parse", "HEAD"))).rejects.toThrow("original revision");
});
it.each(["shared.custom", "shared.gradle"])("pins %s helper imports separately for every consuming Gradle project", async shared => {
  const cwd = await root();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  for (const project of ["a", "b"]) {
    await mkdir(join(cwd, project));
    await writeFile(join(cwd, project, "build.gradle"), `apply from: '../${shared}'\n`);
    await writeFile(join(cwd, project, "checks.custom"), `${project} original definition\n`);
  }
  await writeFile(join(cwd, shared), "apply from: 'checks.custom'\n"); git("add", "."); git("commit", "-m", "shared original definitions");
  const originalRevision = git("rev-parse", "HEAD");
  const detection = await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd)], notes: [] });
  expect(detection.status).toBe("detected"); if (detection.status !== "detected") throw new Error("missing pin");
  expect(detection.profiles[0]!.definitionBlobs).toHaveProperty("a/checks.custom");
  expect(detection.profiles[0]!.definitionBlobs).toHaveProperty("b/checks.custom");
  const command = { ...bindRunnerProfile(detection.profiles[0]!, { testNames: ["target"], testPaths: ["tests/a.test.js"] }), originalRevision };
  await writeFile(join(cwd, "a/checks.custom"), "synthesize report\n"); git("add", "."); git("commit", "-m", "mutate one project import");
  await expect(assertRunnerProvenance(command, cwd, git("rev-parse", "HEAD"))).rejects.toThrow("original revision");
});
it("pins implicit MSBuild Directory.Build imports in each child project context", async () => {
  const cwd = await root();
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(cwd, "Directory.Build.props"), '<Project><Import Project="$(MSBuildProjectDirectory)/checks.custom"/></Project>');
  await writeFile(join(cwd, "checks.custom"), "root decoy\n");
  for (const project of ["a", "b"]) {
    await mkdir(join(cwd, project)); await writeFile(join(cwd, project, "Tests.csproj"), "<Project/>");
    await writeFile(join(cwd, project, "checks.custom"), `${project} execution definition\n`);
  }
  git("add", "."); git("commit", "-m", "implicit original definitions");
  const detection = await pinRunnerDefinitions(cwd, { status: "detected", profiles: [profile(cwd)], notes: [] });
  expect(detection.status).toBe("detected"); if (detection.status !== "detected") throw new Error("missing pin");
  expect(detection.profiles[0]!.definitionBlobs).toHaveProperty("a/checks.custom");
  expect(detection.profiles[0]!.definitionBlobs).toHaveProperty("b/checks.custom");
});
