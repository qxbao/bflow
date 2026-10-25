import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QualityGateContextSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { CheckConfigurationSchema } from "../../../verification/src/model.js";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import type { ImpactIndex } from "../../src/agentic/impact-index.js";
import { pinRunnerDefinitions } from "../../src/agentic/runner-provenance.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { regressionChecks, TestRunnerSource } from "../../src/agentic/task-commands.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const sandboxReady = (await probeBehavioralSandbox()).status === "ready";

function makeProfile(dependencySource: string, overrides: Partial<RunnerProfile> = {}): RunnerProfile {
  return {
    id: "node-tap-pnpm",
    command: "detected:node-tap",
    executable: process.execPath,
    args: ["--test", "--test-reporter=tap"],
    method: "unit_test",
    levels: ["unit", "regression"],
    reporter: "node_tap",
    timeoutMs: 30_000,
    definitionBlobs: {},
    checkoutDependencyRoots: [],
    dependencySource,
    source: "detected",
    ...overrides
  };
}

function makeGraphIndex(commit: string, map: Record<string, string[]>): ImpactIndex {
  return {
    async importersOf(input: { repositoryRoot: string; base: string; files: readonly string[] }) {
      if (input.base !== commit) {
        return { status: "unavailable", code: "commit_mismatch", detail: "commit mismatch" };
      }
      const impacted = new Set<string>();
      for (const path of input.files) {
        for (const dep of map[path] ?? []) impacted.add(dep);
      }
      return {
        status: "ok",
        indexCommit: commit,
        files: [...impacted].sort((a, b) => a.localeCompare(b))
      };
    }
  };
}

interface RepoSetupOptions {
  readonly files?: Record<string, string>;
  readonly profileOverrides?: Partial<RunnerProfile>;
  readonly graph?: Record<string, string[]>;
  readonly runBaseRevision?: string;
  readonly taskBaseCommitHash?: string;
}

async function setupRegressionFixture(options: RepoSetupOptions = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-regression-gate-")));
  const repository = join(root, "repo");
  await mkdir(repository, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd: repository,
      encoding: "utf8"
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");

  const writeFiles = async (files: Record<string, string>) => {
    for (const [relPath, content] of Object.entries(files)) {
      const fullPath = join(repository, relPath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf8");
      git("add", relPath);
    }
  };

  const initialFiles: Record<string, string> = options.files ?? {
    "package.json": JSON.stringify({ name: "reg-fixture", private: true }, null, 2) + "\n",
    "src/math.cjs": "module.exports = { add: (a, b) => a + b };\n",
    "test/math.test.cjs": [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const { add } = require('../src/math.cjs');",
      "test('add works', () => { assert.equal(add(1, 2), 3); });",
      ""
    ].join("\n")
  };
  await writeFiles(initialFiles);
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");

  const opened = await openFilesystemArtifactStore({
    root: join(root, "artifacts"),
    storeId: "regression-gate-test"
  });
  if (!opened.ok) throw new Error(opened.error.message);
  cleanups.push(async () => {
    opened.value.close();
    await rm(root, { recursive: true, force: true });
  });

  const buildHost = async (
    head: string,
    extra: {
      graph?: Record<string, string[]>;
      indexCommit?: string;
      profileOverrides?: Partial<RunnerProfile>;
      runBaseRevision?: string;
      taskBaseCommitHash?: string;
    } = {}
  ) => {
    const rawProfile = makeProfile(repository, {
      ...options.profileOverrides,
      ...extra.profileOverrides
    });
    const pinned = await pinRunnerDefinitions(repository, {
      status: "detected",
      profiles: [rawProfile],
      notes: []
    });
    if (pinned.status !== "detected") throw new Error(pinned.reason);
    const activeProfile = pinned.profiles[0]!;
    const source = new TestRunnerSource([], repository, async () => ({
      status: "detected",
      profiles: [activeProfile],
      notes: []
    }));
    await source.refresh();

    const taskBase = extra.taskBaseCommitHash ?? options.taskBaseCommitHash ?? base;
    const runBase = extra.runBaseRevision ?? options.runBaseRevision ?? base;
    const index = makeGraphIndex(
      extra.indexCommit ?? taskBase,
      extra.graph ?? options.graph ?? { "src/math.cjs": ["test/math.test.cjs"] }
    );

    const runtime = {
      inspect: async () => ({
        run: {
          runId: "run-1",
          baseRevision: runBase,
          tasks: [
            {
              taskId: "task-1",
              worktrees: [{ worktreeId: "wt-1", path: repository, baseCommitHash: taskBase }]
            }
          ]
        },
        outbound: []
      })
    } as unknown as AgenticWorkflowRuntime;

    const host = new HostVerification(
      () => runtime,
      () => opened.value,
      new HostReceiptJournal(join(root, "receipts"), repository, "session"),
      source,
      undefined,
      { scope: "affected", index }
    );
    const checks = regressionChecks([activeProfile]);
    const definition = checks[0]!;
    const gate = host.behavioralGates().find(item => item.id === definition.id);
    if (!gate) throw new Error(`Missing gate ${definition.id}`);
    const evaluate = async (opts: { taskId?: string; scope?: "task" | "workflow"; baseRevision?: string; sourceRevision?: string } = {}) => {
      const context = QualityGateContextSchema.parse({
        runId: "run-1",
        taskId: opts.taskId ?? "task-1",
        attemptId: "attempt-1",
        definition,
        artifacts: [],
        input: {
          sourceRevision: opts.sourceRevision ?? head,
          baseRevision: opts.baseRevision ?? taskBase,
          sourceWorktreePath: repository,
          specFingerprint: "a".repeat(64),
          scope: opts.scope ?? "task"
        }
      });
      const res = await gate.evaluate(context);
      if (!res.ok) throw new Error(res.error.message);
      return res.value;
    };
    return { host, definition, gate, evaluate, activeProfile };
  };

  return { root, repository, git, writeFiles, base, buildHost };
}

describe("host regression gate", () => {
  it("builds regression checks accepted by createVerificationPlan with criterionIds: []", () => {
    const profile = makeProfile("/repo");
    const checks = regressionChecks([profile]);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.id).toBe("host-regression-node-tap-pnpm");
    expect(checks[0]!.evaluator).toBe("host-regression-command");
    expect(checks[0]!.required).toBe(true);
    expect(checks[0]!.timeout.executionTimeoutMs).toBe(150_000);
    expect(checks[0]!.metadata).toEqual({ selection: "regression" });
    expect(checks[0]!.configuration).toMatchObject({
      kind: "deterministic",
      method: "unit_test",
      command: "detected:node-tap",
      criterionIds: [],
      testNames: [],
      role: "quality_gate",
      levels: ["regression"]
    });

    const parsedConfig = CheckConfigurationSchema.parse(checks[0]!.configuration);
    expect(parsedConfig.criterionIds).toEqual([]);
    expect(parsedConfig.testNames).toEqual([]);
    expect(parsedConfig.levels).toEqual(["regression"]);
  });

  it.skipIf(!sandboxReady)("passes when selected regression tests pass", async () => {
    const f = await setupRegressionFixture();
    await f.writeFiles({
      "src/math.cjs": "module.exports = { add: (a, b) => a + b + 0 };\n"
    });
    f.git("commit", "-m", "head-pass");
    const head = f.git("rev-parse", "HEAD");

    const { host, evaluate } = await f.buildHost(head);
    const result = await evaluate();

    expect(result.status).toBe("passed");
    expect(await host.authenticateGate(result)).toBe(true);
    const reg = result.metadata?.regression as Record<string, unknown>;
    expect(reg).toBeDefined();
    expect(reg.scope).toBe("graph");
    expect(reg.selectedTestPaths).toEqual(["test/math.test.cjs"]);
    expect(reg.testsRun).toBeGreaterThan(0);
    expect(reg.passed).toBe(1);
    expect(reg.failed).toBe(0);
    expect(reg.failures).toEqual([]);
  });

  it.skipIf(!sandboxReady)("fails with regression_failure when a selected test newly fails", async () => {
    const f = await setupRegressionFixture();
    await f.writeFiles({
      "src/math.cjs": "module.exports = { add: (a, b) => a - b };\n"
    });
    f.git("commit", "-m", "head-broken");
    const head = f.git("rev-parse", "HEAD");

    const { host, evaluate } = await f.buildHost(head);
    const result = await evaluate();

    expect(result.status).toBe("failed");
    expect(await host.authenticateGate(result)).toBe(true);
    expect(f.git("rev-parse", "HEAD")).toBe(head);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "regression_failure",
          severity: "error",
          location: "test/math.test.cjs",
          details: expect.objectContaining({ testName: "add works" })
        })
      ])
    );
    const reg = result.metadata?.regression as Record<string, unknown>;
    expect(reg.failures).toEqual([
      {
        testPath: "test/math.test.cjs",
        testName: "add works",
        classification: "regression_failure"
      }
    ]);
  });

  it.skipIf(!sandboxReady)("classifies failures present at base as pre_existing", async () => {
    const f = await setupRegressionFixture({
      files: {
        "package.json": JSON.stringify({ name: "reg-fixture", private: true }, null, 2) + "\n",
        "src/math.cjs": "module.exports = { add: (a, b) => a - b };\n",
        "test/math.test.cjs": [
          "const test = require('node:test');",
          "const assert = require('node:assert/strict');",
          "const { add } = require('../src/math.cjs');",
          "test('add works', () => { assert.equal(add(1, 2), 3); });",
          ""
        ].join("\n")
      }
    });
    await f.writeFiles({
      "src/math.cjs": "// touched comment\nmodule.exports = { add: (a, b) => a - b };\n"
    });
    f.git("commit", "-m", "head-still-broken");
    const head = f.git("rev-parse", "HEAD");

    const { host, evaluate } = await f.buildHost(head);
    const result = await evaluate();

    expect(result.status).toBe("passed");
    expect(await host.authenticateGate(result)).toBe(true);
    expect((result.metadata?.verification as { exitCode: number }).exitCode).toBe(0);
    expect(f.git("rev-parse", "HEAD")).toBe(head);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pre_existing_failure",
          severity: "warning",
          location: "test/math.test.cjs",
          details: expect.objectContaining({ testName: "add works" })
        })
      ])
    );
    const reg = result.metadata?.regression as Record<string, unknown>;
    expect(reg.failures).toEqual([
      {
        testPath: "test/math.test.cjs",
        testName: "add works",
        classification: "pre_existing"
      }
    ]);
  });

  it.skipIf(!sandboxReady)("test file added in the change is never pre_existing", async () => {
    const f = await setupRegressionFixture();
    await f.writeFiles({
      "src/math.cjs": "module.exports = { add: (a, b) => a + b };\n",
      "test/added.test.cjs": [
        "const test = require('node:test');",
        "const assert = require('node:assert/strict');",
        "test('newly added failing test', () => { assert.equal(1, 2); });",
        ""
      ].join("\n")
    });
    f.git("commit", "-m", "head-new-test");
    const head = f.git("rev-parse", "HEAD");

    const { host, evaluate } = await f.buildHost(head, {
      graph: { "src/math.cjs": ["test/math.test.cjs"] }
    });
    const result = await evaluate();

    expect(result.status).toBe("failed");
    expect(await host.authenticateGate(result)).toBe(true);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "regression_failure",
          severity: "error",
          location: "test/added.test.cjs",
          details: expect.objectContaining({ testName: "newly added failing test" })
        })
      ])
    );
  });

  it.skipIf(!sandboxReady)("blocks with regression_budget_exceeded on timeout", async () => {
    const f = await setupRegressionFixture({
      files: {
        "package.json": JSON.stringify({ name: "reg-fixture", private: true }, null, 2) + "\n",
        "src/math.cjs": "module.exports = { add: (a, b) => a + b };\n",
        "test/math.test.cjs": [
          "const test = require('node:test');",
          "test('slow test', async () => { await new Promise(resolve => setTimeout(resolve, 5000)); });",
          ""
        ].join("\n")
      },
      profileOverrides: { timeoutMs: 100 }
    });
    await f.writeFiles({
      "src/math.cjs": "module.exports = { add: (a, b) => a + b + 0 };\n"
    });
    f.git("commit", "-m", "head-timeout");
    const head = f.git("rev-parse", "HEAD");

    const { host, evaluate } = await f.buildHost(head, { profileOverrides: { timeoutMs: 100 } });
    const result = await evaluate();

    expect(result.status).toBe("blocked");
    expect(await host.authenticateGate(result)).toBe(true);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "regression_budget_exceeded",
          severity: "error",
          message: expect.stringContaining("mapped_only")
        })
      ])
    );
  });

  it.skipIf(!sandboxReady)("blocks with regression_infrastructure on runner crash", async () => {
    const crashArgs = ["-e", "process.stderr.write('Fatal runner crash\\n'); process.exit(2);"];
    const f = await setupRegressionFixture({
      profileOverrides: { args: crashArgs }
    });
    await f.writeFiles({
      "src/math.cjs": "module.exports = { add: (a, b) => a + b + 0 };\n"
    });
    f.git("commit", "-m", "head-crash");
    const head = f.git("rev-parse", "HEAD");

    const { host, evaluate } = await f.buildHost(head, { profileOverrides: { args: crashArgs } });
    const result = await evaluate();

    expect(result.status).toBe("blocked");
    expect(await host.authenticateGate(result)).toBe(true);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "regression_infrastructure",
          severity: "error"
        })
      ])
    );
  });

  it("docs-only change passes with docs_only and runs nothing", async () => {
    const f = await setupRegressionFixture();
    await f.writeFiles({
      "README.md": "# Documentation update\n"
    });
    f.git("commit", "-m", "docs-only");
    const head = f.git("rev-parse", "HEAD");

    const { host, evaluate } = await f.buildHost(head);
    const result = await evaluate();

    expect(result.status).toBe("passed");
    expect(await host.authenticateGate(result)).toBe(true);
    expect(result.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "docs_only",
          severity: "info"
        })
      ])
    );
    const reg = result.metadata?.regression as Record<string, unknown>;
    expect(reg.scope).toBe("none");
    expect(reg.testsRun).toBe(0);
    expect(reg.selectedTestPaths).toEqual([]);
  });

  it.skipIf(!sandboxReady)("workflow-level gate uses run.baseRevision as base", async () => {
    const f = await setupRegressionFixture();
    const runBase = f.base;
    await f.writeFiles({
      "src/math.cjs": "module.exports = { add: (a, b) => a + b + 1 - 1 };\n"
    });
    f.git("commit", "-m", "task-1-commit");
    const midCommit = f.git("rev-parse", "HEAD");

    await f.writeFiles({
      "README.md": "docs after task\n"
    });
    f.git("commit", "-m", "docs-commit");
    const head = f.git("rev-parse", "HEAD");

    // Task base is midCommit (diff midCommit..head is docs-only), but run.baseRevision is runBase (diff runBase..head touches src/math.cjs).
    const { host, evaluate } = await f.buildHost(head, {
      runBaseRevision: runBase,
      taskBaseCommitHash: midCommit,
      indexCommit: runBase,
      graph: { "src/math.cjs": ["test/math.test.cjs"] }
    });
    const result = await evaluate({
      taskId: "workflow-verification",
      scope: "workflow",
      baseRevision: runBase,
      sourceRevision: head
    });

    expect(result.status).toBe("passed");
    expect(await host.authenticateGate(result)).toBe(true);
    const reg = result.metadata?.regression as Record<string, unknown>;
    expect(reg.base).toBe(runBase);
    expect(reg.head).toBe(head);
    expect(reg.scope).toBe("graph");
    expect(reg.selectedTestPaths).toEqual(["test/math.test.cjs"]);
    expect(reg.testsRun).toBe(1);
  });
});
