import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostDevelopment } from "../../src/agentic/host-development.js";
import { HostBehavioralFailure } from "../../src/agentic/host-verification.js";
import { ArtifactWriteOptionsSchema } from "@bflow/contracts";
import { probeBehavioralSandbox } from "../../src/agentic/sandbox-readiness.js";
import { workflow } from "../../../specification/test/fixtures.js";
import { cleanups, unwrap, git, connectedPhaseFixture } from "../helpers/agentic-integration-fixture.js";

afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

// AgenticJournal persists changes under POSIX flock; these integration cases exercise that boundary.
describe.skipIf((await probeBehavioralSandbox()).status !== "ready")("connected independent policy phases", () => {
  it("runs the registered host test-integrity gate at task and integrated workflow revisions with stored evidence", async () => {
    const f = await connectedPhaseFixture("node_tap");
    await f.addTests(); expect((await f.measure("red")).status).toBe("failed");
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "module.exports=x=>x*2;\n"); await f.commit("Green: double the input");
    await f.measure("green"); await f.measure("refactor");
    await f.submit("implement", null); await f.tickWithReviews(); await f.tickWithReviews();
    const run = await f.inspect();
    expect(run.tasks[0].cycle.status).toBe("passed"); expect(run.workflowCycle.status).toBe("passed");
    expect(f.integrityCalls.map(context => (context.input as any).scope)).toEqual(["task", "workflow"]);
    const scopes = [{ result: run.tasks[0].cycle.history[0], candidate: f.currentHead(), base: run.tasks[0].worktrees[0].baseCommitHash },
      { result: run.workflowCycle.history[0], candidate: run.workflowChange.headCommitHash, base: run.baseRevision }];
    for (const { result, candidate, base } of scopes) {
      const gate = result.qualityGateResults.find((gate: any) => gate.gateId === "host-test-integrity");
      expect(gate.status).toBe("passed"); expect(gate.metadata.verification.sourceRevision).toBe(candidate);
      const reference = gate.metadata.evidence;
      expect(unwrap(await f.ports.artifactStore.resolve(reference.artifactId))).toEqual(reference);
      const chunks: Buffer[] = []; for await (const chunk of f.ports.artifactStore.get(reference)) chunks.push(Buffer.from(unwrap(chunk)));
      expect(JSON.parse(Buffer.concat(chunks).toString("utf8")).testIntegrity).toMatchObject({ baseRevision: base, candidateRevision: candidate });
    }
  }, 120_000);

  it("sends a candidate with a literal-tautology assertion to bounded rework despite passing behavioral measurements", async () => {
    const f = await connectedPhaseFixture("vitest_json");
    await f.addTests(); expect((await f.measure("red")).status).toBe("failed");
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "module.exports=x=>x*2;\n"); await f.commit("Green: double the input");
    await f.measure("green"); await f.measure("refactor");
    // Model an untrusted producer bypassing HostDevelopment's frozen-test guard: Runtime still has to inspect the actual committed candidate.
    await writeFile(join(f.developer.worktreePath!, f.testPath), f.testSource.replace("()=>expect(double(2)).toBe(4)", "()=>{expect(double(2)).toBe(4);expect(1).toBe(1);}"));
    git(f.developer.worktreePath!, "add", f.testPath); git(f.developer.worktreePath!, "commit", "-m", "Adversarial literal assertion");
    await f.submit("implement", null); await f.tickWithReviews(true);
    const run = await f.inspect();
    expect(run.tasks[0].cycle.status, JSON.stringify({ error: run.error, findings: run.tasks[0].cycle.history[0]?.findings })).toBe("rework_required");
    const result = run.tasks[0].cycle.history[0];
    const gate = result.qualityGateResults.find((gate: any) => gate.gateId === "host-test-integrity");
    expect(gate.status).toBe("failed"); expect(gate.findings.some((finding: any) => finding.code === "TI_LITERAL_TAUTOLOGY" && finding.severity === "error")).toBe(true);
    expect(result.qualityGateResults.find((gate: any) => gate.gateId === "host-behavioral-real-regression").status).toBe("passed");
    expect(run.workflowCycle).toBeUndefined();
    expect(f.integrityCalls.map(context => (context.input as any).scope)).toEqual(["task"]);
  }, 120_000);

  it("freezes Red test files bound by an automatic runner profile exactly like owner test files", async () => {
    const f = await connectedPhaseFixture("node_tap", 3, true);
    await f.addTests();
    expect((await f.measure("red")).status).toBe("failed");
    expect(await f.runtime.authorizeImplementation("run-1", "implement")).toMatchObject({ authorized: true });
    await expect(f.edit(f.testPath)).rejects.toThrow("frozen");
  });
  it("failed Green measurements reject the same revision and escalate at the configured bound", async () => {
    const f = await connectedPhaseFixture("node_tap", 2);
    await f.addTests(); await f.measure("red");
    for (let failureNumber = 1; failureNumber <= 2; failureNumber++) {
      await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), `module.exports=x=>x+${failureNumber + 2};\n`); await f.commit(`Incomplete repair ${failureNumber}`);
      const { pending, head } = await f.request("green");
      let failure: unknown;
      try { await f.verification.behavioralEvidence(f.qa, { runId: "run-1", taskId: "implement", phase: "green" }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(HostBehavioralFailure);
      const result = await f.runtime.recordPhaseFailure(f.qa, pending.message.message_id, String(failure), true, (failure as HostBehavioralFailure).evidence) as any;
      expect(result).toMatchObject({ maxIterations: 2 });
      expect((await f.dossier()).strategy.metadata.tddEvidence).toHaveLength(1);
      if (failureNumber === 1) {
        await expect(f.runtime.requestPhaseVerification(f.developer, "run-1", "implement", "green", head)).rejects.toThrow("already failed the phase");
        await f.runtime.flushOutbound();
        const notice = (await f.runtime.inspect() as any).outbound.find((out: any) => out.message.payload.kind === "policy_phase_outcome" && out.message.payload.phase === "green");
        expect(notice.status).toBe("accepted"); expect(notice.parentAssignmentId).toBe(f.original.message.message_id);
        const failed = (await f.runtime.inspect() as any).outbound.find((out: any) => out.error?.startsWith("policy_phase_failed:"));
        expect(notice.message.artifact_references).toContainEqual(failed.phaseFailureEvidence);
        expect(notice.message.payload.failureFindings).toMatchObject([{ criterionId: "ac-1", summary: expect.stringContaining("The requested outcome is independently verifiable") }]);
      } else expect(result.status).toBe("escalated");
    }
    expect((await f.inspect()).error).toContain("repair limit exhausted");
    await expect(f.edit(f.sourcePath)).rejects.toThrow();
    const before = f.transport.sentRequests.filter(request => ["developer", "qa"].includes(request.role)).length; await f.runtime.tick();
    expect(f.transport.sentRequests.filter(request => ["developer", "qa"].includes(request.role))).toHaveLength(before);
    const history = (await f.runtime.inspect() as any).outbound.filter((out: any) => out.error?.startsWith("policy_phase_failed:"));
    expect(history).toHaveLength(2); expect(history.every((out: any) => out.status === "released" && out.phaseFailureEvidence?.trust === "stored")).toBe(true);
  }, 120_000);

  it("delivers verified failed criterion summaries to the pinned writer and authenticated readback", async () => {
    const f = await connectedPhaseFixture("node_tap");
    await f.addTests();
    await f.measure("red");
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "module.exports=x=>x*2;\n"); await f.commit("Candidate with a mobile layout issue");
    const { pending, head } = await f.request("green");
    const body = Buffer.from(JSON.stringify({ runId: "run-1", taskId: "implement", attemptId: f.original.handle.attemptId,
      sourceRevision: head, phase: "green", observation: { revision: head },
      criteria: [{ criterionId: "ac-1", passed: false, summary: "Mobile layout still overflows the viewport" }], accepted: false }));
    const artifactId = `manual-phase-failure-${head.slice(0, 12)}`;
    const evidence = unwrap(await f.ports.artifactStore.put({ options: ArtifactWriteOptionsSchema.parse({ artifactId, runId: "run-1", taskId: "implement",
      kind: "test-result", mediaType: "application/json", expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(body).digest("hex") }, sizeBytes: body.length },
      idempotencyKey: artifactId }), content: (async function* () { yield body; })() }));
    await f.runtime.recordPhaseFailure(f.qa, pending.message.message_id, "Independent review found a mobile layout failure", true, evidence);
    await f.runtime.flushOutbound();
    const state = await f.runtime.inspect() as any;
    const notice = state.outbound.find((out: any) => out.message.payload.kind === "policy_phase_outcome" && out.message.payload.phase === "green");
    expect(notice.status).toBe("accepted");
    expect(notice.message.payload).toMatchObject({ implementationAttemptId: f.original.handle.attemptId, sourceRevision: head,
      failureFindings: [{ criterionId: "ac-1", summary: "Mobile layout still overflows the viewport" }] });
    expect(notice.message.artifact_references).toContainEqual((state.outbound.find((out: any) => out.message.message_id === pending.message.message_id) as any).phaseFailureEvidence);
    f.restart();
    expect(await f.runtime.readPolicyFailureContext(f.developer, "run-1", "implement", f.original.handle.attemptId)).toMatchObject({
      runId: "run-1", taskId: "implement", attemptId: f.original.handle.attemptId,
      failures: [{ phase: "green", sourceRevision: head, findings: [{ criterionId: "ac-1", summary: "Mobile layout still overflows the viewport" }] }]
    });
  }, 120_000);

  it("escalates repairable failures without mapped findings instead of delivering a generic repair notice", async () => {
    const f = await connectedPhaseFixture("node_tap");
    await f.addTests(); await f.measure("red");
    await f.edit(f.sourcePath); await writeFile(join(f.developer.worktreePath!, f.sourcePath), "module.exports=x=>x+3;\n"); await f.commit("Candidate with an unmapped failing check");
    const { pending, head } = await f.request("green");
    const body = Buffer.from(JSON.stringify({ runId: "run-1", taskId: "implement", attemptId: f.original.handle.attemptId,
      sourceRevision: head, phase: "green", observation: { revision: head }, criteria: [], accepted: false }));
    const artifactId = `unmapped-phase-failure-${head.slice(0, 12)}`;
    const evidence = unwrap(await f.ports.artifactStore.put({ options: ArtifactWriteOptionsSchema.parse({ artifactId, runId: "run-1", taskId: "implement",
      kind: "test-result", mediaType: "application/json", expectedIntegrity: { checksum: { algorithm: "sha256", value: createHash("sha256").update(body).digest("hex") }, sizeBytes: body.length },
      idempotencyKey: artifactId }), content: (async function* () { yield body; })() }));
    await f.runtime.recordPhaseFailure(f.qa, pending.message.message_id, "Mapped criterion finding unavailable", true, evidence);
    await f.runtime.flushOutbound();
    const state = await f.runtime.inspect() as any, request = state.outbound.find((out: any) => out.message.message_id === pending.message.message_id);
    expect(state.outbound.some((out: any) => out.message.payload.kind === "policy_phase_outcome" && out.message.payload.outcomeId === pending.message.message_id)).toBe(false);
    expect(state.runs[0]).toMatchObject({ status: "escalated", pendingAction: { kind: "resume_coordinator", recovery: "manual",
      sourceMessageId: pending.message.message_id, reason: expect.stringContaining("verified mapped criterion finding") } });
    expect(request).toMatchObject({ phaseFailure: { summary: "Mapped criterion finding unavailable", repairable: true }, phaseFailureEvidence: evidence });
    expect(state.runs[0].maxIterations).toBe(3);
    expect(await f.runtime.readPolicyFailureContext(f.developer, "run-1", "implement", f.original.handle.attemptId)).toMatchObject({
      actionable: false, reason: expect.stringContaining("verified mapped criterion findings"),
      failures: [{ requestId: pending.message.message_id, evidenceArtifacts: [evidence] }]
    });
  }, 120_000);

  it("rechecks host environment on the same authenticated assignment after local prerequisites are fixed", async () => {
    const f = await connectedPhaseFixture("node_tap");
    await f.addTests();
    let ready = false;
    const checked: string[] = [];
    f.ports.preflightTaskEnvironment = async input => {
      checked.push(`${input.runId}:${input.taskId}:${input.attemptId}`);
      return ready ? { status: "ready", mode: "host_mounted_pinned", checkedAt: new Date().toISOString(), checks: ["host-runner", "verification-sandbox"] }
        : { status: "blocked", checkedAt: new Date().toISOString(), code: "task_runner_unavailable", reason: "Pinned runner is unavailable",
          recovery: "Restore it, then refresh this assignment." };
    };
    const blocked = await f.development.check(f.developer, { runId: "run-1", taskId: "implement" }) as any;
    expect(blocked).toMatchObject({ status: "blocked", classification: "infrastructure", independentAcceptanceEvidence: false });
    ready = true;
    const refreshed = await f.development.check(f.developer, { runId: "run-1", taskId: "implement" }) as any;
    expect(refreshed).toMatchObject({ independentAcceptanceEvidence: false,
      environmentReadiness: { status: "ready", mode: "host_mounted_pinned", checks: ["host-runner", "verification-sandbox"] } });
    expect(checked).toEqual(Array(2).fill(`run-1:implement:${f.original.handle.attemptId}`));
    expect((await f.runtime.inspect() as any).outbound.filter((out: any) => out.message.type === "task.assignment")).toHaveLength(1);
  }, 120_000);
});
