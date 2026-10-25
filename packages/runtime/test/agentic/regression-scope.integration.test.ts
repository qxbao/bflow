import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { QualityGateContextSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { createGitNexusImpactIndex } from "../../src/agentic/impact-index.js";
import { pinRunnerDefinitions } from "../../src/agentic/runner-provenance.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { regressionChecks, TestRunnerSource } from "../../src/agentic/task-commands.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

const gitNexusBin =
  process.env.BFLOW_GITNEXUS_BIN ??
  join(homedir(), ".local/share/bflow/tools/gitnexus/node_modules/.bin/gitnexus");
const hasGitNexusBin = existsSync(gitNexusBin);
const sandboxProbe = await probeBehavioralSandbox();
const sandboxReady = sandboxProbe.status === "ready";
const canRunLiveIntegration = hasGitNexusBin && sandboxReady;

if (!canRunLiveIntegration) {
  const reasons: string[] = [];
  if (!hasGitNexusBin) reasons.push(`GitNexus binary not found at ${gitNexusBin}`);
  if (!sandboxReady) reasons.push(`behavioral sandbox unavailable (${sandboxProbe.status})`);
  console.info(`[regression-scope.integration] skipping live integration test: ${reasons.join("; ")}`);
}

function makeNodeTapProfile(dependencySource: string): RunnerProfile {
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
    source: "detected"
  };
}

async function writeRepoFiles(root: string, files: Record<string, string>) {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(root, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
}

describe("regression scope GitNexus integration", () => {
  it.skipIf(!canRunLiveIntegration)(
    "selects and runs affected tests via GitNexus import closure and widens on config or content drift",
    async () => {
      const workspace = await realpath(await mkdtemp(join(tmpdir(), "bflow-reg-scope-int-")));
      const repo = join(workspace, "repo");
      const home = join(workspace, "gitnexus-home");
      const lockPath = join(workspace, "gitnexus-storage.lock");
      await mkdir(repo, { recursive: true });
      await mkdir(home, { recursive: true });

      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
          cwd,
          encoding: "utf8"
        }).trim();

      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.name", "Test");
      git(repo, "config", "user.email", "test@bflow.invalid");

      await writeRepoFiles(repo, {
        "package.json": JSON.stringify({ name: "reg-scope-live", private: true, type: "module" }, null, 2) + "\n",
        "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
        "src/report.ts":
          'import { add } from "./math.ts";\nexport function formatSum(a: number, b: number): string {\n  return `sum=${add(a, b)}`;\n}\n',
        "src/config.ts": "export const LIMIT = 10;\n",
        "src/other.ts": "export function unrelated(): boolean {\n  return true;\n}\n",
        "test/math.test.ts": [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'import { add } from "../src/math.ts";',
          'test("math add", () => { assert.equal(add(1, 2), 3); });',
          ""
        ].join("\n"),
        "test/report.test.ts": [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'import { formatSum } from "../src/report.ts";',
          'test("report formatSum", () => { assert.equal(formatSum(1, 2), "sum=3"); });',
          ""
        ].join("\n"),
        "test/config.test.ts": [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'import { LIMIT } from "../src/config.ts";',
          'test("config LIMIT", () => { assert.equal(LIMIT >= 10, true); });',
          ""
        ].join("\n"),
        "test/other.test.ts": [
          'import test from "node:test";',
          'import assert from "node:assert/strict";',
          'import { unrelated } from "../src/other.ts";',
          'test("other unrelated", () => { assert.equal(unrelated(), true); });',
          ""
        ].join("\n")
      });

      git(repo, "add", ".");
      git(repo, "commit", "-qm", "base");
      const base = git(repo, "rev-parse", "HEAD");

      await promisify(execFile)(gitNexusBin, ["analyze", "--index-only", "--skip-skills"], {
        cwd: repo,
        env: {
          ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
          GITNEXUS_HOME: home,
          GITNEXUS_SHARED_STORE: "off"
        }
      });

      const opened = await openFilesystemArtifactStore({
        root: join(workspace, "artifacts"),
        storeId: "regression-scope-integration"
      });
      if (!opened.ok) throw new Error(opened.error.message);
      cleanups.push(async () => {
        opened.value.close();
        await rm(workspace, { recursive: true, force: true });
      });

      const pinned = await pinRunnerDefinitions(repo, {
        status: "detected",
        profiles: [makeNodeTapProfile(repo)],
        notes: []
      });
      if (pinned.status !== "detected") throw new Error(pinned.reason);
      const activeProfile = pinned.profiles[0]!;
      const source = new TestRunnerSource([], repo, async () => ({
        status: "detected",
        profiles: [activeProfile],
        notes: []
      }));
      await source.refresh();

      const index = createGitNexusImpactIndex({
        executable: gitNexusBin,
        home,
        storageLockPath: lockPath
      });

      const evaluateWorktree = async (taskId: string, branchName: string, changes: Record<string, string>) => {
        const worktree = join(workspace, branchName);
        git(repo, "worktree", "add", "-q", "-b", branchName, worktree, base);
        await writeRepoFiles(worktree, changes);
        git(worktree, "add", ".");
        git(worktree, "commit", "-qm", branchName);
        const head = git(worktree, "rev-parse", "HEAD");

        const runtime = {
          inspect: async () => ({
            run: {
              runId: "run-int-1",
              baseRevision: base,
              tasks: [
                {
                  taskId,
                  worktrees: [{ worktreeId: `wt-${taskId}`, path: worktree, baseCommitHash: base }]
                }
              ]
            },
            outbound: []
          })
        } as unknown as AgenticWorkflowRuntime;

        const host = new HostVerification(
          () => runtime,
          () => opened.value,
          new HostReceiptJournal(join(workspace, `receipts-${taskId}`), repo, "session"),
          source,
          undefined,
          { scope: "affected", index }
        );

        const definition = regressionChecks([activeProfile])[0]!;
        const gate = host.behavioralGates().find(item => item.id === definition.id);
        if (!gate) throw new Error(`Missing gate ${definition.id}`);

        const context = QualityGateContextSchema.parse({
          runId: "run-int-1",
          taskId,
          attemptId: `attempt-${taskId}`,
          definition,
          artifacts: [],
          input: {
            sourceRevision: head,
            baseRevision: base,
            sourceWorktreePath: worktree,
            specFingerprint: "a".repeat(64),
            scope: "task"
          }
        });
        const res = await gate.evaluate(context);
        if (!res.ok) throw new Error(res.error.message);
        expect(await host.authenticateGate(res.value)).toBe(true);
        return res.value;
      };

      // 1. Change add (src/math.ts) -> ["test/math.test.ts", "test/report.test.ts"]
      const mathResult = await evaluateWorktree("task-math", "wt-math", {
        "src/math.ts": "export function add(a: number, b: number): number {\n  return a + b + 0;\n}\n"
      });
      expect(mathResult.status).toBe("passed");
      const mathReg = mathResult.metadata?.regression as Record<string, unknown>;
      expect(mathReg.scope).toBe("graph");
      expect(mathReg.testPaths).toEqual(["test/math.test.ts", "test/report.test.ts"]);
      expect(mathReg.selectedTestPaths).toEqual(["test/math.test.ts", "test/report.test.ts"]);
      expect(mathReg.testsRun).toBe(2);

      // 2. Change LIMIT (src/config.ts) -> ["test/config.test.ts"]
      const configResult = await evaluateWorktree("task-config", "wt-config", {
        "src/config.ts": "export const LIMIT = 20;\n"
      });
      expect(configResult.status).toBe("passed");
      const configReg = configResult.metadata?.regression as Record<string, unknown>;
      expect(configReg.scope).toBe("graph");
      expect(configReg.testPaths).toEqual(["test/config.test.ts"]);
      expect(configReg.selectedTestPaths).toEqual(["test/config.test.ts"]);
      expect(configReg.testsRun).toBe(1);

      // 3. Change vitest.config.ts -> scope: "full" (all 4 tests)
      const fullResult = await evaluateWorktree("task-full", "wt-full", {
        "vitest.config.ts": "export default {};\n"
      });
      expect(fullResult.status).toBe("passed");
      const fullReg = fullResult.metadata?.regression as Record<string, unknown>;
      expect(fullReg.scope).toBe("full");
      expect(fullReg.testPaths).toEqual([
        "test/config.test.ts",
        "test/math.test.ts",
        "test/other.test.ts",
        "test/report.test.ts"
      ]);
      expect(fullReg.testsRun).toBe(4);

      // 4. Modify uncommitted tracked file in main checkout (content_drift) -> widens with index_unavailable:
      await writeFile(join(repo, "src/other.ts"), "export function unrelated(): boolean {\n  return false;\n}\n", "utf8");
      const driftResult = await evaluateWorktree("task-drift", "wt-drift", {
        "src/config.ts": "export const LIMIT = 30;\n"
      });
      expect(driftResult.status).toBe("passed");
      const driftReg = driftResult.metadata?.regression as {
        scope: string;
        testPaths: string[];
        widening: Array<{ path: string; scope: string; reason: string }>;
      };
      expect(["package", "full"]).toContain(driftReg.scope);
      expect(driftReg.widening.length).toBeGreaterThan(0);
      expect(driftReg.widening.some(w => w.reason.startsWith("index_unavailable:content_drift"))).toBe(true);
    },
    180_000
  );
});
