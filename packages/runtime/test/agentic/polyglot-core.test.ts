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
