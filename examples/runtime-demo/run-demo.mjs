#!/usr/bin/env node
// Runs a feature or bugfix workflow against a copy of examples/sample-repo using the
// implemented packages: Core engine, SQLite RunStore, filesystem ArtifactStore,
// file-backed AgentRegistry, command QualityGate and Runtime orchestration.
//
// There is no live AI agent here. The OutboxTransport writes each prompt to a file and
// this script plays the operator: it copies prepared files from ./solutions into the
// workspace and reports each task result to Runtime. Only the QA quality gate executes
// a real command (`pnpm test`) inside the copied workspace.
//
// Usage (from the repository root, after `pnpm build`):
//   node examples/runtime-demo/run-demo.mjs [--workflow bugfix|feature] [--state-dir DIR]
//                                           [--skip-fix] [--cancel-if-blocked]
import { cp, mkdir, mkdtemp, readFile, readdir, realpath } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DeterministicWorkflowEngine } from "../../packages/core/dist/index.js";
import { openSqliteRunStore } from "../../packages/persistence/dist/index.js";
import { openFilesystemArtifactStore } from "../../packages/artifact-store/dist/index.js";
import {
  createAgentRegistry,
  loadWorkflowDefinition,
  seedMvpAgentRegistry,
  verifyWorkflowRolesRegistered
} from "../../packages/agent-registry/dist/index.js";
import { createDefaultSecurityPolicy, createPresetQualityGate } from "../../packages/quality-gates/dist/index.js";
import { createRuntimeService } from "../../packages/runtime/dist/index.js";
import { OutboxTransport } from "./outbox-transport.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    workflow: { type: "string", default: "bugfix" },
    "state-dir": { type: "string" },
    "skip-fix": { type: "boolean", default: false },
    "cancel-if-blocked": { type: "boolean", default: false }
  }
});
if (args.workflow !== "bugfix" && args.workflow !== "feature") {
  throw new Error("--workflow must be 'bugfix' or 'feature'");
}

function unwrap(result, step) {
  if (!result.ok) {
    console.error(`\n✗ ${step} failed:`, JSON.stringify(result.error, null, 2));
    process.exit(1);
  }
  return result.value;
}

function printSnapshot(label, snapshot) {
  console.log(`\n== ${label}: run ${snapshot.status} (version ${snapshot.version}, events ${snapshot.lastEventSequence})`);
  for (const task of snapshot.tasks) {
    const blockage = task.blockage ? `  blockage=${task.blockage.code}: ${task.blockage.message}` : "";
    console.log(`   ${task.taskId.padEnd(10)} ${task.status.padEnd(10)} attempt=${task.attempt} generation=${task.generation}${blockage}`);
  }
}

// Builds an untrusted proposal plus its bytes; Runtime verifies size/SHA-256 before storing it.
function proposal(runId, taskId, kind, logicalName, mediaType, content) {
  const bytes = Buffer.from(content, "utf8");
  const proposalId = `${taskId}-${kind}-${randomUUID().slice(0, 8)}`;
  return {
    proposalId,
    content,
    value: {
      proposalId,
      runId,
      taskId,
      kind,
      logicalName,
      mediaType,
      expectedIntegrity: {
        sizeBytes: bytes.byteLength,
        checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") }
      }
    }
  };
}

function resultWith(proposals, fields) {
  return {
    ...fields,
    proposals: proposals.map((p) => p.value),
    contentByProposalId: Object.fromEntries(proposals.map((p) => [p.proposalId, p.content]))
  };
}

async function listFiles(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name));
}

// ---------------------------------------------------------------------------
// 1. State directory, workspace copy and ports
// ---------------------------------------------------------------------------
// ArtifactStore rejects roots below symlinked ancestors (e.g. macOS /var -> /private/var).
const stateDir = args["state-dir"]
  ? await realpath(await mkdir(args["state-dir"], { recursive: true }).then(() => args["state-dir"]))
  : await mkdtemp(join(await realpath(tmpdir()), "bflow-demo-"));
const workspace = join(stateDir, "workspace");
await cp(join(here, "..", "sample-repo"), workspace, { recursive: true, errorOnExist: true, force: false });
console.log(`State directory: ${stateDir}`);
console.log(`Workspace copy:  ${workspace}`);

const runId = `demo-${args.workflow}-${randomUUID().slice(0, 8)}`;
const definition = unwrap(
  loadWorkflowDefinition(args.workflow, { id: `${args.workflow}-demo`, maxReworks: 1 }),
  "loadWorkflowDefinition"
);
const gateDefinition = definition.qualityGates[0];

async function openPorts() {
  const runStore = unwrap(openSqliteRunStore({ filename: join(stateDir, "runs.sqlite") }), "openSqliteRunStore");
  const artifactStore = unwrap(
    await openFilesystemArtifactStore({ root: join(stateDir, "artifacts"), storeId: "demo" }),
    "openFilesystemArtifactStore"
  );
  const agentRegistry = createAgentRegistry({ stateFile: join(stateDir, "registry.json") });
  const securityPolicy = unwrap(createDefaultSecurityPolicy({ allowedRootDirs: [workspace] }), "createDefaultSecurityPolicy");
  // Runtime uses one QualityGate port; its gateId must match the workflow's gate definition.
  const qualityGate = unwrap(
    createPresetQualityGate({
      gateId: gateDefinition.id,
      checkKind: "unit_test",
      workingDirectory: workspace,
      securityPolicy,
      timeoutMs: 60_000
    }),
    "createPresetQualityGate"
  );
  const transport = new OutboxTransport({ outboxDir: join(stateDir, "outbox") });
  const service = createRuntimeService({
    // A fresh engine must be given the workflow definition to recover runs after restart.
    engine: new DeterministicWorkflowEngine({ definitions: [definition] }),
    runStore,
    artifactStore,
    agentRegistry,
    transport,
    qualityGate,
    runtimeId: "runtime-demo"
  });
  unwrap(await service.init({ runtimeId: "runtime-demo" }), "service.init");
  return { runStore, artifactStore, agentRegistry, service, close: () => { artifactStore.close(); runStore.close(); } };
}

let ports = await openPorts();

// Register the four MVP roles. Models are configuration data only in this demo.
unwrap(
  await seedMvpAgentRegistry(ports.agentRegistry, {
    developer: { provider: "anthropic", kind: "claude-code", model: "claude-sonnet-5-5" }
  }),
  "seedMvpAgentRegistry"
);
unwrap(await verifyWorkflowRolesRegistered(definition, ports.agentRegistry, runId), "verifyWorkflowRolesRegistered");

// ---------------------------------------------------------------------------
// 2. Start: Runtime persists the run, dispatches the first ready task to the transport
// ---------------------------------------------------------------------------
const roleTask = (role) => definition.tasks.find((task) => task.role === role).id;
const [planTask, devTask, reviewTask, qaTask] = ["planner", "developer", "reviewer", "qa"].map(roleTask);
const issueFile = args.workflow === "bugfix" ? "BUG-001-discount.md" : "FEATURE-001-format-price.md";
const issue = await readFile(join(workspace, "issues", issueFile), "utf8");

let snapshot = unwrap(
  await ports.service.startRun(definition, { runId, input: { issue: issueFile } }),
  "startRun"
);
printSnapshot(`Started ${definition.id}`, snapshot);
console.log(`   prompts written to ${join(stateDir, "outbox")}`);

// ---------------------------------------------------------------------------
// 3. Planner result (operator-provided)
// ---------------------------------------------------------------------------
const plan = proposal(runId, planTask, "document", "plan.md", "text/markdown",
  `# Plan for ${issueFile}\n\n${issue}\n`);
unwrap(await ports.service.orchestrator.completeTaskExecution(runId, planTask,
  resultWith([plan], { status: "succeeded", summary: "Plan written from the issue description" })), "complete plan");
snapshot = unwrap(await ports.service.orchestrator.driveRun(runId), "driveRun after plan");
printSnapshot("Plan recorded, developer dispatched", snapshot);

// ---------------------------------------------------------------------------
// 4. Developer result: copy prepared solution files into the workspace
// ---------------------------------------------------------------------------
const solutionDir = join(here, "solutions", args.workflow);
const changed = [];
for (const file of await listFiles(solutionDir)) {
  const rel = relative(solutionDir, file);
  // --skip-fix only adds the new tests, simulating an agent that claims success without fixing the code.
  if (args["skip-fix"] && rel.startsWith("src")) continue;
  await cp(file, join(workspace, rel), { force: true });
  changed.push({ path: rel, content: await readFile(file, "utf8") });
}
const patch = proposal(runId, devTask, "patch", "changes.json", "application/json", JSON.stringify(changed, null, 2));
unwrap(await ports.service.orchestrator.completeTaskExecution(runId, devTask,
  resultWith([patch], { status: "succeeded", summary: `Changed ${changed.map((c) => c.path).join(", ")}` })), "complete developer task");
snapshot = unwrap(await ports.service.orchestrator.driveRun(runId), "driveRun after developer");
printSnapshot("Developer result recorded, reviewer dispatched", snapshot);

// ---------------------------------------------------------------------------
// 5. Simulated process restart while the reviewer task is running
// ---------------------------------------------------------------------------
ports.close();
ports = await openPorts();
snapshot = unwrap(await ports.service.resume(runId), "resume after restart");
printSnapshot("Restarted process: recovered from checkpoint/events and reconciled the outbox", snapshot);

// ---------------------------------------------------------------------------
// 6. Reviewer approves; the review task then requires human approval
// ---------------------------------------------------------------------------
const review = proposal(runId, reviewTask, "report", "review.md", "text/markdown",
  "# Review\n\nChange matches the acceptance criteria. No findings.\n");
snapshot = unwrap(await ports.service.orchestrator.completeTaskExecution(runId, reviewTask,
  resultWith([review], { status: "succeeded", reviewDecision: "approved", reviewReason: "Criteria met" })), "complete review");
// Driving the run again does not dispatch QA while the approval request is open.
snapshot = unwrap(await ports.service.orchestrator.driveRun(runId), "driveRun before approval");
printSnapshot("Review recorded, approval requested (QA not dispatched yet)", snapshot);

snapshot = unwrap(await ports.service.approve(runId, { taskId: reviewTask, decidedBy: "demo-operator" }), "human approval");
printSnapshot("Human approved review, QA dispatched", snapshot);

// ---------------------------------------------------------------------------
// 7. QA result; the after_result gate runs `pnpm test` independently in the workspace
// ---------------------------------------------------------------------------
const qaReport = proposal(runId, qaTask, "report", "qa.md", "text/markdown", "# QA\n\nAgent reports tests passed.\n");
snapshot = unwrap(await ports.service.orchestrator.completeTaskExecution(runId, qaTask,
  resultWith([qaReport], { status: "succeeded", summary: "QA agent claims all tests pass" })), "complete qa");
snapshot = unwrap(await ports.service.getRun(runId), "getRun");
printSnapshot("Final state", snapshot);

// ---------------------------------------------------------------------------
// 8. Evidence: gate results from the event log and stored artifacts
// ---------------------------------------------------------------------------
const events = unwrap(await ports.runStore.readEvents(runId, { limit: 500 }), "readEvents").items;
for (const event of events.filter((e) => e.type === "quality_gate.evaluated")) {
  const findings = event.payload.findings.map((f) => f.code).join(", ") || "none";
  console.log(`\nQuality gate ${event.payload.gateId} on ${event.taskId}: ${event.payload.status} (findings: ${findings})`);
}

if (snapshot.status === "blocked" && args["cancel-if-blocked"]) {
  snapshot = unwrap(
    await ports.service.cancel({ runId, reason: "Demo: abandon blocked run", requestedBy: "demo-operator" }),
    "cancel"
  );
  printSnapshot("Operator cancelled the blocked run", snapshot);
}

const artifacts = unwrap(await ports.artifactStore.find({ runId }), "artifactStore.find").items;
console.log(`\nStored artifacts (${artifacts.length}):`);
for (const a of artifacts) console.log(`   ${a.kind.padEnd(8)} ${a.artifactId}  ${a.uri}`);

ports.close();
console.log(`\nInspect later with:\n  node examples/runtime-demo/inspect-run.mjs --state-dir ${stateDir} --run-id ${runId}`);
