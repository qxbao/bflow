import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SpecificationSchema, TestStrategySchema, type PaneBinding } from "@bflow/contracts";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { assessment, spec } from "../../../test-strategy/test/fixtures.js";
import type { RunnerProfile } from "../../src/agentic/behavioral-runner.js";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { TestRunnerSource } from "../../src/agentic/task-commands.js";
import { git } from "../helpers/agentic-integration-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });

async function developerFixture(affectedPaths: string[]) {
  const ws = await realpath(await mkdtemp(join(tmpdir(), "bflow-observed-dev-")));
  roots.push(ws);
  git(ws, "init", "-b", "main"); git(ws, "config", "user.name", "Test"); git(ws, "config", "user.email", "test@example.test");
  await mkdir(join(ws, "src"), { recursive: true }); await mkdir(join(ws, "test"), { recursive: true });
  await writeFile(join(ws, "package.json"), '{"name":"demo"}\n'); await writeFile(join(ws, "src/math.ts"), "export const add = () => 0;\n");
  git(ws, "add", "."); git(ws, "commit", "-m", "baseline");
  const baseCommit = git(ws, "rev-parse", "HEAD");
  const assessed = assessment("bugfix", { infrastructure: { readiness: "ready", commands: [{ method: "unit_test", command: "auto:unit", level: "unit" }] } });
  const specification = SpecificationSchema.parse({ ...spec(assessed, "unit_test"), affectedPaths });
  const tddEvidence: unknown[] = [];
  const strategy = TestStrategySchema.parse({ ...new TestStrategyResolver().resolve(specification),
    criterionMappings: [{ criterionId: "ac-1", testNames: ["adds"] }] });
  const profile: RunnerProfile = { id: "node-unit", command: "auto:unit", executable: process.execPath, args: ["--test"], method: "unit_test",
    levels: ["unit"], reporter: "node_tap", timeoutMs: 30_000, checkoutDependencyRoots: [], dependencySource: ws, definitionBlobs: {}, source: "detected" };
  const runners = new TestRunnerSource([], ws, async () => ({ status: "detected", profiles: [profile], notes: [] }));
  await runners.refresh();
  const pane: PaneBinding = { schemaVersion: 2, bindingId: "b-dev", sessionId: "s-1", role: "developer", paneGroup: "developer_worktree", agentId: "dev-1",
    workspaceId: "w-1", tabId: "t-1", paneId: "p-1", provider: "herdr", agentKind: "codex", cwd: ws, worktreePath: ws, isolationMode: "dedicated_pane",
    readOnlyWorkspace: false, permanent: false, transportState: "idle", boundAt: "2026-10-31T00:00:00.000Z" };
  const runtime = {
    inspect: async () => ({ outbound: [{ status: "accepted", message: { schema_version: 2, message_id: "m-1", correlation_id: "c-1", run_id: "run-1",
      sender: { role: "coordinator" }, recipient: { role: "developer", agent_id: "dev-1", pane_id: "p-1" }, type: "task.assignment", payload: {},
      artifact_references: [], occurred_at: "2026-10-31T00:00:00.000Z", idempotency_key: "m-1" },
      handle: { executionId: "e-1", requestId: "r-1", attemptId: "a-1", runId: "run-1", taskId: "task-1", idempotencyKey: "m-1",
        target: { transport: "herdr", agentId: "dev-1", workspaceId: "w-1", tabId: "t-1", paneId: "p-1", worktreePath: ws },
        correlation: { token: "r-1", provenance: "orchestrator", verified: false }, acceptedAt: "2026-10-31T00:00:00.000Z" } }] }),
    withDeveloperWorkspace: async (_b: unknown, _r: string, _t: string, cb: (...args: any[]) => Promise<unknown>) =>
      cb({ worktrees: [{ baseCommitHash: baseCommit, branchName: "main" }], spec: { specification, strategy: { ...strategy, metadata: { ...strategy.metadata, tddEvidence } } } },
        { metadata: { ownedPaths: ["src", "test"], forbiddenPaths: [] } }),
    ports: { policies: { assertReadyToImplement: (value: any) => {
      if (value.tddDecision.mode === "required" && !value.metadata.tddEvidence.length) throw new Error("Red evidence is required before implementation"); } } } };
  return { ws, pane, tddEvidence, development: new HostDevelopment(() => runtime as never, runners) };
}

it("lets the Developer write the Red test inside a planned test directory, but not production code, before Red", async () => {
  const f = await developerFixture(["src/math.ts", "test"]);
  const production = (await f.development.readWorkspaceFile(f.pane, { path: "src/math.ts" })) as any;

  await expect(f.development.writeWorkspaceFile(f.pane, { path: "test/math.test.cjs", content: "// red\n", expectedSha256: null }))
    .resolves.toMatchObject({ written: true, created: true });
  await expect(f.development.writeWorkspaceFile(f.pane, { path: "src/math.ts", content: "export const add = () => 2;\n", expectedSha256: production.sha256 }))
    .rejects.toThrow(/Red evidence is required/);
});

it("freezes the committed Red test of a planned directory after Red while production code stays editable", async () => {
  const f = await developerFixture(["src/math.ts", "test"]);
  await f.development.writeWorkspaceFile(f.pane, { path: "test/math.test.cjs", content: "// red\n", expectedSha256: null });
  const red = (await f.development.commit(f.pane, { expectedHead: git(f.ws, "rev-parse", "HEAD"), message: "red test" })) as any;
  f.tddEvidence.push({ metadata: { conditionalTdd: { phase: "red", sourceRevision: red.head } } });
  const redTest = (await f.development.readWorkspaceFile(f.pane, { path: "test/math.test.cjs" })) as any;
  const production = (await f.development.readWorkspaceFile(f.pane, { path: "src/math.ts" })) as any;

  await expect(f.development.writeWorkspaceFile(f.pane, { path: "test/math.test.cjs", content: "// cheated\n", expectedSha256: redTest.sha256 }))
    .rejects.toThrow(/frozen/i);
  await expect(f.development.writeWorkspaceFile(f.pane, { path: "src/math.ts", content: "export const add = () => 2;\n", expectedSha256: production.sha256 }))
    .resolves.toMatchObject({ written: true });
});
