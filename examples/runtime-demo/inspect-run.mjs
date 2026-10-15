#!/usr/bin/env node
// Prints the stored state of a run created by run-demo.mjs: RunStore projection, latest
// checkpoint, event history, pending approvals, quality-gate results, a pre-merge governance
// check and stored artifacts.
//
// Usage (from the repository root, after `pnpm build`):
//   node examples/runtime-demo/inspect-run.mjs --state-dir DIR [--run-id ID] [--show ARTIFACT_ID]
// Without --run-id it lists the runs in the state directory.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openSqliteRunStore } from "../../packages/persistence/dist/index.js";
import { openFilesystemArtifactStore } from "../../packages/artifact-store/dist/index.js";
import { evaluateAutomatedVsHumanGovernance, isHumanApprover } from "../../packages/quality-gates/dist/index.js";

const { values: args } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "run-id": { type: "string" },
    show: { type: "string" }
  }
});
if (!args["state-dir"]) throw new Error("--state-dir is required");

function unwrap(result, step) {
  if (!result.ok) throw new Error(`${step}: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

const runStore = unwrap(openSqliteRunStore({ filename: join(args["state-dir"], "runs.sqlite") }), "openSqliteRunStore");
const artifactStore = unwrap(
  await openFilesystemArtifactStore({ root: join(args["state-dir"], "artifacts"), storeId: "demo" }),
  "openFilesystemArtifactStore"
);

try {
  if (!args["run-id"]) {
    const runs = unwrap(await runStore.find({ limit: 100 }), "find").items;
    for (const run of runs) {
      console.log(`${run.snapshot.runId}  ${run.snapshot.workflowId}  ${run.snapshot.status}  updated ${run.snapshot.updatedAt}`);
    }
  } else if (args.show) {
    const reference = unwrap(await artifactStore.resolve(args.show), "resolve");
    if (!reference || reference.runId !== args["run-id"]) throw new Error(`Artifact ${args.show} not found for run`);
    // get() verifies size and checksum before yielding any bytes.
    for await (const chunk of artifactStore.get(reference)) process.stdout.write(unwrap(chunk, "get"));
  } else {
    const runId = args["run-id"];
    const stored = unwrap(await runStore.get(runId), "get");
    if (!stored) throw new Error(`Run ${runId} not found`);
    const { snapshot } = stored;
    console.log(`Run ${runId}: ${snapshot.status} (workflow ${snapshot.workflowId}@${snapshot.workflowVersion}, version ${snapshot.version})`);
    console.log("Tasks (RunStore query projection):");
    for (const task of snapshot.tasks) {
      const blockage = task.blockage ? `  blockage=${task.blockage.code}: ${task.blockage.message}` : "";
      console.log(`  ${task.taskId.padEnd(10)} ${task.status.padEnd(10)} attempt=${task.attempt} generation=${task.generation}${blockage}`);
    }

    const checkpoint = unwrap(await runStore.loadLatestCheckpoint(runId), "loadLatestCheckpoint");
    console.log(checkpoint
      ? `Latest checkpoint: ${checkpoint.checkpointId} codec=${checkpoint.codec.name}@${checkpoint.codec.version} at event ${checkpoint.eventSequence}`
      : "Latest checkpoint: none");

    const events = [];
    let cursor;
    do {
      const page = unwrap(await runStore.readEvents(runId, cursor ? { cursor, limit: 200 } : { limit: 200 }), "readEvents");
      events.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);

    console.log(`\nEvents (${events.length}):`);
    for (const event of events) {
      if (event.type === "command.completed") continue;
      console.log(`  #${String(event.sequence).padStart(3)} ${event.occurredAt}  ${event.type}${event.taskId ? `  [${event.taskId}]` : ""}`);
    }

    const decided = new Set(events.filter((e) => e.type === "approval.decided").map((e) => e.payload.approvalId));
    const pending = events.filter((e) => e.type === "approval.requested" && !decided.has(e.payload.approvalId));
    console.log(`\nPending approvals: ${pending.length === 0 ? "none" : ""}`);
    for (const e of pending) console.log(`  ${e.payload.approvalId} target=${JSON.stringify(e.payload.target)} reason=${e.payload.reason}`);

    console.log("\nQuality gate results:");
    for (const e of events.filter((e) => e.type === "quality_gate.evaluated")) {
      console.log(`  ${e.payload.gateId} [${e.taskId}] ${e.payload.status}`);
      for (const f of e.payload.findings) console.log(`    - ${f.severity} ${f.code}: ${f.message}`);
    }

    // Automated gates and the human approval are evaluated as separate controls.
    const gateResults = events.filter((e) => e.type === "quality_gate.evaluated").map((e) => e.payload);
    const humanDecision = events
      .filter((e) => e.type === "approval.decided" && isHumanApprover(e.payload.decidedBy))
      .map((e) => e.payload)
      .at(-1);
    const humanRequest = humanDecision &&
      events.find((e) => e.type === "approval.requested" && e.payload.approvalId === humanDecision.approvalId)?.payload;
    console.log("\nPre-merge governance:");
    if (gateResults.length === 0) {
      console.log("  no quality gate results recorded — cannot proceed");
    } else {
      const governance = unwrap(evaluateAutomatedVsHumanGovernance({
        runId,
        automatedGateResults: gateResults,
        requiresHumanApproval: true,
        ...(humanRequest ? { approvalRequest: humanRequest } : {}),
        ...(humanDecision ? { humanApprovalDecision: humanDecision } : {})
      }), "evaluateAutomatedVsHumanGovernance");
      console.log(`  automated gates: ${governance.automatedChecksStatus}`);
      console.log(`  human approval:  ${governance.humanApprovalStatus}${governance.humanApproverId ? ` by ${governance.humanApproverId}` : ""}`);
      console.log(`  run status:      ${snapshot.status}`);
      const ready = governance.canProceedToDelivery && snapshot.status === "succeeded";
      console.log(`  ready for merge review: ${ready ? "YES" : "NO"}`);
    }

    const artifacts = unwrap(await artifactStore.find({ runId }), "find").items;
    console.log(`\nArtifacts (${artifacts.length}):`);
    for (const a of artifacts) {
      console.log(`  ${a.kind.padEnd(8)} ${a.artifactId}  ${a.taskId ?? "-"}  ${a.mediaType}  ${a.sizeBytes ?? "?"} bytes  ${a.checksum.algorithm}=${a.checksum.value.slice(0, 12)}…`);
    }
    console.log("\nPrint one with --show <artifactId>.");
  }
} finally {
  artifactStore.close();
  runStore.close();
}
