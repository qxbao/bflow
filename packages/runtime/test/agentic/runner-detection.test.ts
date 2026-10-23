import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import { detectTestRunners, parseTscBuildArgs } from "../../src/agentic/runner-detection.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string> = {}, setup?: (root: string) => Promise<void>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner-detection-")));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await setup?.(root);
  return root;
}

const manifest = (value: unknown) => JSON.stringify(value);
const vitest2Files = {
  "package.json": manifest({ devDependencies: { vitest: "^2.1.8" }, scripts: { build: "tsc -b" } }),
  "node_modules/vitest/package.json": '{"version":"2.1.9"}',
  "node_modules/vitest/vitest.mjs": "",
  "node_modules/typescript/bin/tsc": ""
};

describe("detectTestRunners", () => {
  it("detects vitest 2 with unit and integration profiles, nested dependency roots and a tsc prepare", async () => {
    const root = await fixture(vitest2Files, async dir => {
      await mkdir(join(dir, "packages/a/node_modules/dep"), { recursive: true });
      await writeFile(join(dir, "packages/a/node_modules/dep/package.json"), "{}");
      await mkdir(join(dir, "node_modules/foo/node_modules/bar"), { recursive: true });
      await writeFile(join(dir, "node_modules/foo/node_modules/bar/package.json"), "{}");
      await mkdir(join(dir, ".git/node_modules/x"), { recursive: true });
      await mkdir(join(dir, ".claude/worktrees/w/node_modules/x"), { recursive: true });
      await mkdir(join(dir, "dist/node_modules/x"), { recursive: true });
      await mkdir(join(dir, "packages/link"), { recursive: true });
      await symlink(join(dir, "node_modules"), join(dir, "packages/link/node_modules"), "dir");
    });
    const result = await detectTestRunners(root, { nodeExecutable: process.execPath });
    if (result.status !== "detected") throw new Error(JSON.stringify(result));
    const entry = join(root, "node_modules/vitest/vitest.mjs");
    const executable = await realpath(process.execPath);
    expect(result.notes).toEqual(expect.arrayContaining(["vitest 2.1.9", "prepare: tsc -b"]));
    expect(result.profiles).toHaveLength(6);
    const [unit, integration] = result.profiles;
    const expectedArgs = ["node_modules/vitest/vitest.mjs", "run", "--globals", "--reporter=json", "--no-cache", "--maxWorkers=1", "--minWorkers=1"];
    expect(unit).toEqual({
      id: "auto-unit", command: "auto:unit", executable, args: expectedArgs, method: "unit_test", levels: ["unit", "regression"],
      reporter: "vitest_json", timeoutMs: 180_000, maxOutputBytes: 4_194_304, checkoutDependencyRoots: ["node_modules", "packages/a/node_modules"],
      dependencySource: root, prepare: { args: ["node_modules/typescript/bin/tsc", "-b"], timeoutMs: 120_000 }, source: "detected"
    });
    expect(integration).toEqual({ ...unit, id: "auto-integration", command: "auto:integration", method: "integration_test", levels: ["integration", "regression"] });
    expect(entry.startsWith(root)).toBe(true);
    // The profiles must satisfy the same safety rules as owner-configured commands, including the aggregate budget.
    const commands = result.profiles.slice(0, 2).map(profile => ({
      id: profile.id, command: profile.command, executable: profile.executable, args: profile.args, method: profile.method, levels: profile.levels,
      testNames: ["a test"], testPaths: ["a.test.ts"], reporter: profile.reporter, timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes,
      dependencyRoots: profile.checkoutDependencyRoots.map(path => join(root, path))
    }));
    expect(() => parseBehavioralCommands(commands)).not.toThrow();
    expect(result.profiles.slice(0, 2).reduce((total, profile) => total + profile.timeoutMs + 90_000, 0)).toBeLessThanOrEqual(540_000);
  });

  it("fails closed when the root node_modules is a symlink", async () => {
    const root = await fixture({ "package.json": manifest({ devDependencies: { vitest: "^2.1.8" } }) }, async dir => {
      await mkdir(join(dir, "real-modules/vitest"), { recursive: true });
      await writeFile(join(dir, "real-modules/vitest/package.json"), '{"version":"2.1.9"}');
      await writeFile(join(dir, "real-modules/vitest/vitest.mjs"), "");
      await symlink(join(dir, "real-modules"), join(dir, "node_modules"), "dir");
    });
    const result = await detectTestRunners(root);
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.reason).toContain("node_modules");
  });

  it("rejects unrecognized vitest major versions and names the version", async () => {
    const root = await fixture({ ...vitest2Files, "node_modules/vitest/package.json": '{"version":"4.2.4"}' });
    const result = await detectTestRunners(root);
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.reason).toContain("4.2.4");
  });

  it("reports vitest declared but not installed as not installed", async () => {
    const root = await fixture({ "package.json": manifest({ devDependencies: { vitest: "^2.1.8" } }), "node_modules/.keep": "" });
    const result = await detectTestRunners(root);
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.reason).toContain("not installed");
  });

  it("detects the node --test runner with TAP output", async () => {
    const root = await fixture({ "package.json": manifest({ scripts: { test: "node --test" } }), "node_modules/.keep": "" });
    const result = await detectTestRunners(root);
    if (result.status !== "detected") throw new Error(JSON.stringify(result));
    expect(result.profiles.slice(0, 2).map(profile => [profile.id, profile.reporter, profile.args])).toEqual([
      ["auto-unit", "node_tap", ["--test", "--test-reporter=tap"]],
      ["auto-integration", "node_tap", ["--test", "--test-reporter=tap"]]
    ]);
    expect(result.profiles[0]!.prepare).toBeUndefined();
    expect(result.profiles[0]!.checkoutDependencyRoots).toEqual(["node_modules"]);
  });

  it("forwards allowlisted node flags that precede --test and rejects unknown ones", async () => {
    const flagged = await fixture({ "package.json": manifest({ scripts: { test: "node --experimental-strip-types --disable-warning=ExperimentalWarning --test test/*.test.ts" } }) });
    const result = await detectTestRunners(flagged);
    if (result.status !== "detected") throw new Error(JSON.stringify(result));
    expect(result.profiles[0]!.args).toEqual(["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test", "--test-reporter=tap"]);
    const unknown = await fixture({ "package.json": manifest({ scripts: { test: "node --require ./evil.js --test" } }) });
    expect((await detectTestRunners(unknown)).status).toBe("unsupported");
  });

  it("supports a dependency-free node --test repository without node_modules", async () => {
    const root = await fixture({ "package.json": manifest({ scripts: { test: "node --test" } }) });
    const result = await detectTestRunners(root);
    if (result.status !== "detected") throw new Error(JSON.stringify(result));
    expect(result.profiles[0]!.checkoutDependencyRoots).toEqual([]);
  });

  it("returns unsupported with remediation when no runner is present", async () => {
    const root = await fixture({ "package.json": manifest({ scripts: { test: "echo ok" } }), "node_modules/.keep": "" });
    const result = await detectTestRunners(root);
    expect(result.status).toBe("unsupported");
    if (result.status !== "unsupported") return;
    expect(result.remediation).toHaveLength(1);
    expect(result.remediation[0]).toContain("Coordinator");
    expect(JSON.stringify(result.remediation)).not.toContain("verification.json");
  });

  it("does not run a build script that is not a plain tsc invocation", async () => {
    const root = await fixture({ ...vitest2Files, "package.json": manifest({ devDependencies: { vitest: "^2.1.8" }, scripts: { build: "tsc -b && rm -rf /" } }) });
    const result = await detectTestRunners(root);
    if (result.status !== "detected") throw new Error(JSON.stringify(result));
    expect(result.profiles[0]!.prepare).toBeUndefined();
    expect(result.notes.some(note => note.includes("prepare skipped"))).toBe(true);
    expect(result.notes.some(note => note.startsWith("prepare:"))).toBe(false);
  });

  it("notes a missing build step when workspace packages export dist without a supported build", async () => {
    const root = await fixture({
      ...vitest2Files,
      "package.json": manifest({ devDependencies: { vitest: "^2.1.8" }, scripts: { build: "pnpm -r build" } }),
      "packages/a/package.json": manifest({ name: "a", exports: { ".": { import: "./dist/index.js" } } })
    });
    const result = await detectTestRunners(root);
    if (result.status !== "detected") throw new Error(JSON.stringify(result));
    expect(result.profiles[0]!.prepare).toBeUndefined();
    expect(result.notes).toContain("build step not detected; tests importing dist may fail");
  });

  it("accepts the tsc build forms and rejects shell syntax", () => {
    expect(parseTscBuildArgs("tsc -b")).toEqual(["-b"]);
    expect(parseTscBuildArgs("tsc --build")).toEqual(["--build"]);
    expect(parseTscBuildArgs("tsc -b packages/core")).toEqual(["-b", "packages/core"]);
    expect(parseTscBuildArgs("tsc")).toEqual([]);
    expect(parseTscBuildArgs("tsc -b ../escape")).toBeUndefined();
    expect(parseTscBuildArgs("tsc -b /abs")).toBeUndefined();
    expect(parseTscBuildArgs("tsc -b $(id)")).toBeUndefined();
    expect(parseTscBuildArgs("tsc --noEmit")).toBeUndefined();
    expect(parseTscBuildArgs("tsc -p tsconfig.json")).toEqual(["-p", "tsconfig.json"]);
    expect(parseTscBuildArgs("tsc --project packages/app/tsconfig.json")).toEqual(["--project", "packages/app/tsconfig.json"]);
    expect(parseTscBuildArgs("tsc -p ../escape.json")).toBeUndefined();
    expect(parseTscBuildArgs("tsc -p a.json b.json")).toBeUndefined();
    expect(parseTscBuildArgs("tsc -p tsconfig.json --noEmit")).toBeUndefined();
  });

  it("detects the real repository runner", async () => {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
    const result = await detectTestRunners(repositoryRoot);
    if (result.status !== "detected") throw new Error(JSON.stringify(result));
    const [unit] = result.profiles;
    expect(unit!.args[0]).toBe("node_modules/vitest/vitest.mjs");
    expect(unit!.reporter).toBe("vitest_json");
    expect(result.notes.some(note => /^vitest 2\./.test(note))).toBe(true);
    expect(unit!.prepare?.args).toEqual(["node_modules/typescript/bin/tsc", "-b"]);
    expect(unit!.checkoutDependencyRoots).toEqual(expect.arrayContaining(["node_modules", "packages/runtime/node_modules"]));
  });
});
