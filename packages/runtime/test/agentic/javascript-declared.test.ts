import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { javascriptAdapter } from "../../src/agentic/javascript-adapter.js";
import { declaredRunnerAdapter } from "../../src/agentic/declared-runner-adapter.js";
import { pinRunnerDefinitions, assertRunnerProvenance } from "../../src/agentic/runner-provenance.js";
import { bindRunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { detectTestRunners } from "../../src/agentic/runner-detection.js";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(files: Record<string, string>) { const root = await realpath(await mkdtemp(join(tmpdir(), "js-declared-"))); roots.push(root); for (const [path, text] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); } return root; }
it.each(["jest", "mocha"] as const)("detects %s installed metadata and selects exact names and files without shell argv", async id => {
  const entry = id === "jest" ? "jest/bin/jest.js" : "mocha/bin/mocha.js";
  const root = await fixture({ "package.json": JSON.stringify({ devDependencies: { [id]: "*" } }), [`node_modules/${id}/package.json`]: '{"version":"29.7.0"}', [`node_modules/${entry}`]: "" });
  const result = await javascriptAdapter.detect({ root, files: ["package.json"] });
  expect(result.runners).toHaveLength(1);
  const invocation = result.runners[0]!.bind({ testNames: ["suite literal.*"], testPaths: ["tests/a.test.js"] }, "/tmp/reports");
  expect(invocation.args).toContain(id === "jest" ? "--testNamePattern=^(?:suite literal\\.\\*)$" : "--grep=^(?:suite literal\\.\\*)$");
  expect(invocation.args).toContain("tests/a.test.js");
});
it("classifies ordinary Make/tox/nox definitions as reviewed agent setup, never as exit-code evidence", async () => {
  const root = await fixture({ Makefile: "test:\n\ttrue\n", "tox.ini": "[testenv]\ncommands=pytest\n", "noxfile.py": "" });
  const result = await declaredRunnerAdapter.detect({ root, files: ["Makefile", "tox.ini", "noxfile.py"] });
  expect(result.runners).toEqual([]); expect(result.notes).toHaveLength(3);
  expect(result.notes.every(note => note.includes("runner_reporter_required"))).toBe(true);
});
it("uses pinned declared target argv and blocks a task changing its Makefile", async context => {
  const root = await fixture({ Makefile: "test:\n\t@echo $(BFLOW_TEST_NAMES) $(BFLOW_TEST_FILES) $(BFLOW_JUNIT_OUTPUT)\n" });
  const detected = await declaredRunnerAdapter.detect({ root, files: ["Makefile"] });
  if (!detected.runners.length) { context.skip(); return; } // make is optional; no execution fallback.
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("add", "."); git("commit", "-m", "original");
  const catalog = await detectTestRunners(root, { adapters: [declaredRunnerAdapter] });
  expect(catalog.status).toBe("detected"); if (catalog.status !== "detected") throw new Error("missing declared adapter");
  const command = bindRunnerProfile(catalog.profiles[0]!, { testNames: ["Suite.target"], testPaths: ["tests/a.test.js"] });
  const before = command.adapter!.bind(command, "/tmp/reports");
  for (const name of ["Suite.$(shell touch sentinel)", "Suite.`touch sentinel`", "Suite.target; true", "Suite.target\nfalse"])
    expect(() => command.adapter!.bind({ ...command, testNames: [name] }, "/tmp/reports")).toThrow("safe literal");
  await writeFile(join(root, "Makefile"), "test:\n\tfalse\n"); git("add", "."); git("commit", "-m", "task attempts replacement");
  expect(command.adapter!.bind(command, "/tmp/reports")).toEqual(before);
  await expect(assertRunnerProvenance(command, root, git("rev-parse", "HEAD"))).rejects.toThrow("original revision");
});
it("rejects uncommitted runner-definition edits at detection", async () => {
  const root = await fixture({ "package.json": '{"scripts":{"test":"node --test"}}' });
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("add", "."); git("commit", "-m", "base");
  await writeFile(join(root, "package.json"), '{"scripts":{"test":"echo unsafe"}}');
  const result = await pinRunnerDefinitions(root, { status: "detected", profiles: [], notes: [] });
  expect(result).toMatchObject({ status: "unsupported", agentFixable: true });
});
it.each(["vitest", "node"] as const)("discovers nested %s projects and binds paths relative to their project", async runner => {
  const root = await fixture({ "web/package.json": JSON.stringify(runner === "vitest" ? { devDependencies: { vitest: "2.1.9" } } : { scripts: { test: "node --test" } }), ...(runner === "vitest" ? { "web/node_modules/vitest/package.json": '{"version":"2.1.9"}', "web/node_modules/vitest/vitest.mjs": "" } : {}) });
  const detection = await detectTestRunners(root);
  expect(detection.status).toBe("detected"); if (detection.status !== "detected") throw new Error(detection.reason);
  const selected = detection.profiles.find(profile => profile.method === "unit_test" && profile.adapter?.adapterId === runner)!;
  expect(selected.adapter?.projectDirectory).toBe("web");
  const command = selected.adapter!.bind({ testNames: ["target"], testPaths: ["web/tests/a.test.js"] }, "/tmp/reports");
  expect(command.args).toContain("tests/a.test.js"); expect(command.args).not.toContain("web/tests/a.test.js");
});
it("routes generated CTest build directories to agent setup rather than claiming their host outputs can be measured", async () => {
  const root = await fixture({ "CMakeLists.txt": "enable_testing()\n", "build/CTestTestfile.cmake": "add_test(target /host/build/test)\n" });
  const result = await detectTestRunners(root);
  expect(result).toMatchObject({ status: "unsupported", agentFixable: true, reason: expect.stringContaining("runner_build_setup_required") });
});
