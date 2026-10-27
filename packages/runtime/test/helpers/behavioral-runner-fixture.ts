import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { copyIsolatedNodeDependencies } from "./isolated-node-dependencies.js";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { PaneBindingSchema, SpecificationSchema } from "@bflow/contracts";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { TestStrategyResolver, recordEvidence } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { HostVerification } from "../../src/agentic/host-verification.js";
import { parseBehavioralCommands } from "../../src/agentic/behavioral-runner.js";
import type { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";

export const cleanups: (() => Promise<unknown>)[] = [];
export const testName = "ac-1: Target behavior matches expected output";
export const testSource = `const {test}=require('node:test'); const assert=require('node:assert/strict'); const value=require('../source.cjs'); test(${JSON.stringify(testName)},()=>assert.equal(value(2),4));\n`;
export const vitestCli = createRequire(import.meta.url).resolve("vitest/vitest.mjs");
export const vitestSource = `const value=require('../source.cjs'); it(${JSON.stringify(testName)},()=>expect(value(2)).toBe(4));\n`;
export async function fixture(taskType = "bugfix", reporter: "node_tap" | "vitest_json" = "node_tap") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-measurement-test-"))), cwd = join(root, "repo"); await mkdir(cwd); await mkdir(join(cwd, "test"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  await writeFile(join(cwd, "source.cjs"), "module.exports=x=>x+1;\n"); git("add", "."); git("commit", "-m", "baseline"); const base = git("rev-parse", "HEAD");
  const commit = (message: string) => { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  await writeFile(join(cwd, "test/behavior.test.cjs"), reporter === "vitest_json" ? vitestSource : testSource); const redRevision = commit("failing acceptance test");
  const sourceDependencies = fileURLToPath(new URL("../../../../node_modules", import.meta.url));
  const dependencies = join(root, "node_modules");
  if (reporter === "vitest_json") await copyIsolatedNodeDependencies(sourceDependencies, dependencies);
  const stagedVitest = join(dependencies, relative(sourceDependencies, vitestCli));
  const command = parseBehavioralCommands([{ id: "node-unit", command: "owner:test-unit", executable: process.execPath, args: reporter === "vitest_json" ? [stagedVitest, "run", "--globals", "--reporter=json", "--no-cache", "--maxWorkers=1", "--minWorkers=1", "test/behavior.test.cjs"] : ["--test", "--test-reporter=tap", "test/behavior.test.cjs"], ...(reporter === "vitest_json" ? { reporter, dependencyRoots: [dependencies] } : {}), method: "unit_test", levels: ["unit", "regression"], testNames: [testName], testPaths: ["test/behavior.test.cjs"],
    // A nested Vitest needs more than 3 s to start under full-suite load; deadline handling is covered with timeoutMs: 1 below.
    timeoutMs: reporter === "vitest_json" ? 15_000 : 3000 }])[0]!;
  const policyAssessment = assessment(taskType);
  const draft = SpecificationSchema.parse({ ...spec(assessment(taskType, { ...(taskType === "documentation" ? { changeImpact: { ...policyAssessment.changeImpact, behaviorChanged: false, deterministic: false, regressionReproducible: false } } : {}), infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: command.command, level: "unit" }] } })), affectedPaths: taskType === "documentation" ? ["guide.md"] : ["source.cjs", "test/behavior.test.cjs"] });
  let strategy = new TestStrategyResolver().resolve(draft);
  const opened = await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "behavioral-test" }); if (!opened.ok) throw new Error(opened.error.message);
  cleanups.push(async () => { opened.value.close(); await rm(root, { recursive: true, force: true }); });
  const bytes = Buffer.from(JSON.stringify(draft));
  const stored = await opened.value.put({ options: { artifactId: "accepted-spec", runId: "run-1", taskId: "task-1", kind: "document", mediaType: "application/json", idempotencyKey: "accepted-spec", expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length } }, content: (async function* () { yield bytes; })() });
  if (!stored.ok) throw new Error(stored.error.message);
  const specification = SpecificationSchema.parse({ ...draft, status: "approved", approvedBy: "architect", artifactRef: stored.value });
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "tester-binding", sessionId: "session-1", role: "tester", agentId: "independent-tester", paneId: "tester-pane", workspaceId: "workspace", tabId: "tab", provider: "test", agentKind: "test", cwd, isolationMode: "dedicated_pane", readOnlyWorkspace: true, transportState: "idle", boundAt: new Date().toISOString() });
  const assignment = { message_id: "assignment", type: "task.assignment", run_id: "run-1" };
  const runtime = { inspect: async (runId?: string) => runId ? { baseRevision: base, tasks: [{ taskId: "task-1", spec: { specification, strategy } }] } : { outbound: [{ taskId: "task-1", message: assignment, handle: { target: { agentId: "developer", paneId: "developer-pane", worktreePath: cwd } } }] }, ports: { policies: { recordEvidence } } } as unknown as AgenticWorkflowRuntime;
  const receiptsPath = join(root, "host-receipts");
  const host = new HostVerification(() => runtime, () => opened.value, new HostReceiptJournal(receiptsPath, cwd, "session-1"), [command]);
  return { cwd, git, commit, command, specification, redRevision, base, binding, host, store: opened.value, restart(commands = [command]) { return new HostVerification(() => runtime, () => opened.value, new HostReceiptJournal(receiptsPath, cwd, "session-1"), commands); }, get strategy() { return strategy; }, accept(result: unknown) { strategy = recordEvidence(strategy, result); } };
}
// Measurement launches require the production Bubblewrap namespace sandbox.
