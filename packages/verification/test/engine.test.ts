import { describe, expect, it } from "vitest";
import { VerificationCycleSchema, VerificationResultSchema } from "@bflow/contracts";
import { VerificationEngine } from "../src/engine.js";
import { createVerificationPlan } from "../src/model.js";
import { fixture } from "./fixtures.js";

describe("VerificationEngine", () => {
  it("passes first attempt with independently executed tests, static checks and review evidence for every criterion", async () => {
    const f = await fixture();
    const engine = new VerificationEngine(f.ports);
    const change = await f.change();
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), change);
    expect(outcome.result.status).toBe("passed");
    expect(outcome.cycle.status).toBe("passed");
    expect(outcome.cycle.maxIterations).toBe(3);
    expect(outcome.cycle.history).toHaveLength(1);
    expect(outcome.result.evaluatedCriteria.map(c => c.criterionId).sort()).toEqual(["ac-1", "ac-review", "ac-types"]);
    expect(outcome.result.evaluatedCriteria.every(c => c.passed)).toBe(true);
    expect(outcome.result.evidenceArtifacts.every(a => f.store.records.has(a.artifactId))).toBe(true);
    expect(f.store.reads).toContain(change.patchArtifact.artifactId);
    expect(f.runners.every(runner => runner.calls.length === 1)).toBe(true);
    expect(VerificationResultSchema.safeParse(outcome.result).success).toBe(true);
    expect(VerificationCycleSchema.safeParse(outcome.cycle).success).toBe(true);
  });

  it.each(["validation", "transport_unavailable"] as const)("classifies a gate %s error without inventing an implementation failure", async code => {
    const f = await fixture();
    f.runners[0]!.evaluate = async () => ({ok:false,error: code === "validation"
      ? {code,retryable:false,message:"Independent evidence admission failed"}
      : {code,retryable:true,message:"Independent runner unavailable"}});
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan,engine.start(f.plan,"cycle-errors"),await f.change());
    expect(outcome.result.status).toBe(code === "validation" ? "inconclusive" : "blocked");
    expect(outcome.cycle.status).toBe("escalated");
  });

  it("records failed verification and a scoped developer repair before a fresh successful attempt", async () => {
    const f = await fixture();
    const runner = f.runners[0]!;
    runner.mode = "failed";
    const engine = new VerificationEngine(f.ports);
    const first = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(first.result.status).toBe("failed");
    expect(first.cycle.status).toBe("rework_required");
    runner.mode = "passed";
    const change = await f.change(2);
    const second = await engine.verify(f.plan, first.cycle, change, { repair: {
      taskId: f.plan.taskId, role: "developer", changeSetId: change.changeSetId,
      summary: "Corrected the target behavior after failed test"
    } });
    expect(second.result.status).toBe("passed");
    expect(second.cycle.currentIteration).toBe(2);
    expect(second.cycle.history.map(result => result.status)).toEqual(["failed", "passed"]);
    const auditDocuments = [...f.store.records.values()].map(record => Buffer.from(record.bytes).toString("utf8"));
    expect(auditDocuments.some(document => document.includes("Corrected the target behavior"))).toBe(true);
    expect(runner.calls).toHaveLength(2);
  });

  it("escalates repeated failures at configured loop limit and refuses a fourth attempt", async () => {
    const f = await fixture();
    f.runners[0]!.mode = "failed";
    const engine = new VerificationEngine(f.ports);
    let cycle = engine.start(f.plan, "cycle-1");
    for (let iteration = 1; iteration <= 3; iteration++) {
      const change = await f.change(iteration);
      const outcome = await engine.verify(f.plan, cycle, change, iteration === 1 ? {} : {
        repair: { taskId: "task-1", role: "developer", changeSetId: change.changeSetId,
          summary: `Repair attempt ${iteration}` }
      });
      expect(outcome.result.status).toBe("failed");
      cycle = outcome.cycle;
    }
    expect(cycle.status).toBe("escalated");
    expect(cycle.currentIteration).toBe(3);
    expect(cycle.history).toHaveLength(3);
    expect(cycle.escalation?.target).toBe("human_operator");
    await expect(engine.verify(f.plan, cycle, await f.change(4))).rejects.toThrow();
    expect(f.runners[0]!.calls).toHaveLength(3);
  });

  it("honors a nondefault loop limit", async () => {
    const f = await fixture({ maxIterations: 1 });
    f.runners[0]!.mode = "failed";
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.cycle.status).toBe("escalated");
    expect(outcome.cycle.maxIterations).toBe(1);
  });

  it("rejects an invalid test report instead of trusting a passed gate status", async () => {
    const f = await fixture();
    f.runners[0]!.mode = "malformed";
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("inconclusive");
    expect(outcome.cycle.status).toBe("escalated");
    expect(outcome.result.evaluatedCriteria.find(c => c.criterionId === "ac-1")?.passed).toBe(false);
  });

  it("escalates insufficient evidence without automatically retrying", async () => {
    const f = await fixture();
    f.runners[0]!.mode = "missing";
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("inconclusive");
    expect(outcome.cycle.status).toBe("escalated");
    expect(outcome.cycle.escalation?.evidenceArtifacts.length).toBeGreaterThan(0);
    expect(f.runners[0]!.calls).toHaveLength(1);
  });

  it("keeps test failure decisive when independent Reviewer approves", async () => {
    const f = await fixture();
    f.runners[0]!.mode = "failed";
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.qualityGateResults.find(result => result.gateId === "review-check")?.status).toBe("passed");
    expect(outcome.result.evaluatedCriteria.find(c => c.criterionId === "ac-1")?.passed).toBe(false);
    expect(outcome.result.findings.length).toBeGreaterThan(0);
    expect(outcome.result.findings.some(finding => JSON.stringify(finding.details).includes("developer"))).toBe(true);
    expect(outcome.result.findings.some(finding => JSON.stringify(finding.details).includes("task-1"))).toBe(true);
  });

  it("runs fresh workflow verification after integration even when task verification passed", async () => {
    const task = await fixture();
    const taskEngine = new VerificationEngine(task.ports);
    const taskResult = await taskEngine.verify(task.plan, taskEngine.start(task.plan, "task-cycle"), await task.change());
    expect(taskResult.result.status).toBe("passed");
    const workflow = await fixture({ scope: "workflow" });
    workflow.runners[0]!.mode = "failed";
    const workflowEngine = new VerificationEngine(workflow.ports);
    const integratedChange = await workflow.change(2);
    const outcome = await workflowEngine.verify(workflow.plan, workflowEngine.start(workflow.plan, "workflow-cycle"),
      integratedChange, { integration: { headCommitHash: integratedChange.headCommitHash, integratedTaskIds: ["task-1", "task-2"] } });
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.verificationScope).toBe("workflow");
    expect(workflow.runners.every(runner => runner.calls.length === 1)).toBe(true);
    expect(outcome.result.qualityGateResults.find(result => result.gateId === "test-check")?.status).toBe("failed");
  });

  it("requires explicit integration context for workflow-level verification", async () => {
    const f = await fixture({ scope: "workflow" });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("blocked");
    expect(outcome.cycle.status).toBe("escalated");
    expect(f.runners.every(runner => runner.calls.length === 0)).toBe(true);
  });

  it("escalates specification drift during checks and never rewrites requirements to pass", async () => {
    const f = await fixture();
    const originalSpec = structuredClone(f.specification);
    f.runners[0]!.rewriteObservation = observation => {
      f.setSpecification({ ...f.specification, version: 2, summary: "Changed requirement while verification runs" });
      return observation;
    };
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("escalated");
    expect(outcome.cycle.status).toBe("escalated");
    expect(f.plan.specification).toEqual(originalSpec);
  });

  it("keeps transport done and Developer self-assessment from establishing completion", async () => {
    const f = await fixture();
    f.runners[0]!.mode = "done";
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("inconclusive");
    expect(outcome.cycle.status).toBe("escalated");
    expect(outcome.result.evaluatedCriteria.some(criterion => !criterion.passed)).toBe(true);
  });

  it("refuses evidence from the implementer masquerading as an independent reviewer", async () => {
    const f = await fixture();
    f.runners[2]!.executorId = "developer-1";
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("inconclusive");
    expect(outcome.result.evaluatedCriteria.find(c => c.criterionId === "ac-review")?.passed).toBe(false);
  });

  it("validates gate/result bindings at ingress", async () => {
    const f = await fixture();
    f.runners[0]!.rewriteResult = result => ({ ...result, runId: "different-run" });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("inconclusive");
    expect(outcome.cycle.status).toBe("escalated");
  });

  it("rejects stale evidence bound to a different commit", async () => {
    const f = await fixture();
    f.runners[0]!.rewriteObservation = observation => ({ ...observation, sourceRevision: "b".repeat(40) });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("inconclusive");
    expect(outcome.cycle.status).toBe("escalated");
  });

  it("preserves blocked classification and escalates unavailable independent execution", async () => {
    const f = await fixture();
    f.runners[0]!.mode = "blocked";
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("blocked");
    expect(outcome.cycle.status).toBe("escalated");
  });

  it("requires a new scoped repair, attempt and commit before re-verifying", async () => {
    const f = await fixture();
    f.runners[0]!.mode = "failed";
    const engine = new VerificationEngine(f.ports);
    const originalChange = await f.change();
    const first = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), originalChange);
    await expect(engine.verify(f.plan, first.cycle, await f.change(2))).rejects.toThrow();
    await expect(engine.verify(f.plan, first.cycle, originalChange, { repair: {
      taskId: "task-1", role: "developer", changeSetId: originalChange.changeSetId, summary: "Retry without new code"
    } })).rejects.toThrow();
    const secondChange = await f.change(2);
    await expect(engine.verify(f.plan, first.cycle, secondChange, { repair: {
      taskId: "unrelated-task", role: "developer", changeSetId: secondChange.changeSetId, summary: "Unrelated repair"
    } })).rejects.toThrow();
    expect(f.runners[0]!.calls).toHaveLength(1);
  });

  it("blocks changes outside specification scope without dispatching checks", async () => {
    const f = await fixture();
    const engine = new VerificationEngine(f.ports);
    const change = await f.change();
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), { ...change,
      filesChanged: [{ path: "packages/unrelated/secret.ts", changeType: "modified", additions: 1, deletions: 1 }] });
    expect(outcome.result.status).toBe("escalated");
    expect(outcome.cycle.status).toBe("escalated");
    expect(f.runners.every(runner => runner.calls.length === 0)).toBe(true);
  });

  it("blocks corrupted patch bytes before invoking tools", async () => {
    const f = await fixture();
    const engine = new VerificationEngine(f.ports);
    const change = await f.change();
    const record = f.store.records.get(change.patchArtifact.artifactId)!;
    record.bytes = Buffer.from("tampered patch");
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), change);
    expect(outcome.result.status).toBe("blocked");
    expect(outcome.cycle.status).toBe("escalated");
    expect(f.runners.every(runner => runner.calls.length === 0)).toBe(true);
  });

  it("does not return passed if trusted evidence persistence fails", async () => {
    const f = await fixture();
    const engine = new VerificationEngine(f.ports);
    const change = await f.change();
    f.store.rejectWrites = true;
    await expect(engine.verify(f.plan, engine.start(f.plan, "cycle-1"), change)).rejects.toThrow();
  });

  it("reuses an unaffected passed check only with an explicit impact declaration and contiguous Git diff", async () => {
    const f = await fixture();
    const checks = f.input.checks.map(check => check.id === "type-check" ? {
      ...check, configuration: { ...check.configuration as Record<string, unknown>, dependsOnPaths: ["packages/example/types"] }
    } : check);
    const plan = createVerificationPlan({ ...f.input, checks });
    f.runners[0]!.mode = "failed";
    const engine = new VerificationEngine(f.ports);
    const firstChange = await f.change();
    const first = await engine.verify(plan, engine.start(plan, "cycle-1"), firstChange);
    f.runners[0]!.mode = "passed";
    const change = { ...await f.change(2), baseCommitHash: firstChange.headCommitHash };
    const second = await engine.verify(plan, first.cycle, change, { repair: {
      taskId: "task-1", role: "developer", changeSetId: change.changeSetId, summary: "Repaired target logic only"
    } });
    expect(second.result.status).toBe("passed");
    expect(f.runners[0]!.calls).toHaveLength(2);
    expect(f.runners[1]!.calls).toHaveLength(1);
    expect(f.runners[2]!.calls).toHaveLength(2);
    expect(JSON.stringify(second.result.metadata)).toContain("contiguous Git diff");
  });

  it("executes checks again when impact is known but Git revisions do not form a contiguous diff", async () => {
    const f = await fixture();
    const checks = f.input.checks.map(check => check.id === "type-check" ? {
      ...check, configuration: { ...check.configuration as Record<string, unknown>, dependsOnPaths: ["packages/example/types"] }
    } : check);
    const plan = createVerificationPlan({ ...f.input, checks });
    f.runners[0]!.mode = "failed";
    const engine = new VerificationEngine(f.ports);
    const first = await engine.verify(plan, engine.start(plan, "cycle-1"), await f.change());
    f.runners[0]!.mode = "passed";
    const change = await f.change(2);
    const second = await engine.verify(plan, first.cycle, change, { repair: {
      taskId: "task-1", role: "developer", changeSetId: change.changeSetId, summary: "Repair on different base"
    } });
    expect(second.result.status).toBe("passed");
    expect(f.runners.every(runner => runner.calls.length === 2)).toBe(true);
  });

  it("rejects edited cycle history before accepting a repair", async () => {
    const f = await fixture();
    f.runners[0]!.mode = "failed";
    const engine = new VerificationEngine(f.ports);
    const first = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    const edited = structuredClone(first.cycle);
    edited.history[0]!.findings = [];
    const change = await f.change(2);
    await expect(engine.verify(f.plan, edited, change, { repair: {
      taskId: "task-1", role: "developer", changeSetId: change.changeSetId, summary: "Repair with edited history"
    } })).rejects.toThrow("Cycle differs from persisted verification receipt");
    expect(f.runners[0]!.calls).toHaveLength(1);
  });

  it("reruns a dependency check when a renamed file originated inside its impact paths", async () => {
    const f = await fixture();
    const checks = f.input.checks.map(check => check.id === "type-check" ? {
      ...check, configuration: { ...check.configuration as Record<string, unknown>, dependsOnPaths: ["packages/example/types"] }
    } : check);
    const plan = createVerificationPlan({ ...f.input, checks });
    f.runners[0]!.mode = "failed";
    const engine = new VerificationEngine(f.ports);
    const firstChange = await f.change();
    const first = await engine.verify(plan, engine.start(plan, "cycle-1"), firstChange);
    f.runners[0]!.mode = "passed";
    const change = { ...await f.change(2), baseCommitHash: firstChange.headCommitHash,
      filesChanged: [{ path: "packages/example/src/types.ts", previousPath: "packages/example/types/index.ts",
        changeType: "renamed", additions: 0, deletions: 0 }] };
    const second = await engine.verify(plan, first.cycle, change, { repair: {
      taskId: "task-1", role: "developer", changeSetId: change.changeSetId, summary: "Renamed type definitions"
    } });
    expect(second.result.status).toBe("passed");
    expect(f.runners.every(runner => runner.calls.length === 2)).toBe(true);
  });

  it("treats a nonzero exit as failure even when a runner reports passed", async () => {
    const f = await fixture();
    f.runners[0]!.rewriteObservation = observation => ({ ...observation, exitCode: 1 });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.evaluatedCriteria.find(criterion => criterion.criterionId === "ac-1")?.passed).toBe(false);
  });

  it("rejects evidence from a stale attempt even at the same source revision", async () => {
    const f = await fixture();
    f.runners[0]!.rewriteObservation = observation => ({ ...observation, attemptId: "older-attempt" });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("inconclusive");
    expect(outcome.cycle.status).toBe("escalated");
  });

  it("rejects a tampered initial cycle bound to another iteration policy", async () => {
    const f = await fixture();
    const engine = new VerificationEngine(f.ports);
    const cycle = { ...engine.start(f.plan, "cycle-1"), maxIterations: 10 };
    await expect(engine.verify(f.plan, cycle, await f.change())).rejects.toThrow("Cycle does not match frozen plan");
    expect(f.runners.every(runner => runner.calls.length === 0)).toBe(true);
  });

  it("blocks integration context that identifies a different Git head", async () => {
    const f = await fixture({ scope: "workflow" });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-1"), await f.change(), {
      integration: { headCommitHash: "b".repeat(40), integratedTaskIds: ["task-1"] }
    });
    expect(outcome.result.status).toBe("blocked");
    expect(f.runners.every(runner => runner.calls.length === 0)).toBe(true);
  });

  it("escalates a validly stored specification artifact whose content differs from accepted requirements", async () => {
    const f = await fixture();
    const artifactRef = await f.store.seed("different-spec", "document", { ...f.specification, summary: "Different requirement" });
    const specification = { ...f.specification, artifactRef };
    f.setSpecification(specification);
    const plan = createVerificationPlan({ ...f.input, specification });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(plan, engine.start(plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("escalated");
    expect(f.runners.every(runner => runner.calls.length === 0)).toBe(true);
  });

  it("accepts the P15 stored pre-approval document when only approval lifecycle fields differ", async () => {
    const f = await fixture();
    const { artifactRef: _artifactRef, approvedBy: _approvedBy, ...body } = f.specification;
    const artifactRef = await f.store.seed("pre-approval-spec", "document", { ...body,
      status: "review_pending", updatedAt: "2026-10-15T01:00:00Z" });
    const specification = { ...f.specification, artifactRef };
    f.setSpecification(specification);
    const plan = createVerificationPlan({ ...f.input, specification });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(plan, engine.start(plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("passed");
  });

  it("bounds a hung runner without automatically retrying its unknown execution", async () => {
    const f = await fixture();
    const plan = createVerificationPlan({ ...f.input, checks: f.input.checks.map(check => ({ ...check,
      timeout: { executionTimeoutMs: 20, onTimeout: "block" } })) });
    let calls = 0;
    f.runners[0]!.evaluate = () => { calls++; return new Promise(() => {}); };
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(plan, engine.start(plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("blocked");
    expect(outcome.cycle.status).toBe("escalated");
    expect(JSON.stringify(outcome.result.findings)).toContain("remote stop is unproven");
    expect(calls).toBe(1);
  });

  it("accepts safe glob patterns in affectedPaths and verifies matching changed files", async () => {
    const f = await fixture();
    const { artifactRef: _oldRef, ...specDoc } = f.specification;
    const docWithGlob = { ...specDoc, affectedPaths: ["packages/**/*.ts"] };
    const artifactRef = await f.store.seed("spec-doc-glob", "document", docWithGlob);
    const specWithGlob = { ...docWithGlob, artifactRef };
    f.setSpecification(specWithGlob);
    const plan = createVerificationPlan({ ...f.input, specification: specWithGlob });
    const engine = new VerificationEngine(f.ports);
    const change = await f.change();
    const outcome = await engine.verify(plan, engine.start(plan, "cycle-1"), change);
    expect(outcome.result.status).toBe("passed");
  });

  it("supports waived acceptance criteria without mapped checks", async () => {
    const f = await fixture();
    const { artifactRef: _oldRef, ...specDoc } = f.specification;
    const docWithWaived = {
      ...specDoc,
      acceptanceCriteria: [
        ...specDoc.acceptanceCriteria,
        {
          id: "ac-waived",
          description: "Waived criterion for testing",
          category: "functional" as const,
          verificationMethod: "unit_test" as const,
          required: false,
          status: "waived" as const,
          waiverReason: "Temporarily waived for release",
          evidenceArtifactIds: []
        }
      ]
    };
    const artifactRef = await f.store.seed("spec-doc-waived", "document", docWithWaived);
    const specWithWaived = { ...docWithWaived, artifactRef };
    f.setSpecification(specWithWaived);
    const plan = createVerificationPlan({ ...f.input, specification: specWithWaived });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(plan, engine.start(plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("passed");
    const waived = outcome.result.evaluatedCriteria.find(c => c.criterionId === "ac-waived");
    expect(waived?.passed).toBe(true);
    expect(waived?.summary).toContain("Temporarily waived");
  });

  it("does not fail verification when an optional criterion fails", async () => {
    const f = await fixture();
    const { artifactRef: _oldRef, ...specDoc } = f.specification;
    const strategyWithOpt = {
      ...f.input.strategy,
      criterionMappings: [
        ...f.input.strategy.criterionMappings,
        { criterionId: "ac-opt", testNames: ["optional test"] }
      ]
    };
    const docWithOpt = {
      ...specDoc,
      acceptanceCriteria: [
        ...specDoc.acceptanceCriteria,
        {
          id: "ac-opt",
          description: "Optional performance criterion",
          category: "performance" as const,
          verificationMethod: "unit_test" as const,
          required: false,
          status: "pending" as const,
          evidenceArtifactIds: []
        }
      ],
      testStrategy: strategyWithOpt
    };
    const artifactRef = await f.store.seed("spec-doc-opt", "document", docWithOpt);
    const specWithOpt = { ...docWithOpt, artifactRef };
    f.setSpecification(specWithOpt);
    const checksWithOpt = f.input.checks.map(check => check.id === "test-check" ? {
      ...check,
      configuration: {
        ...check.configuration as Record<string, unknown>,
        criterionIds: ["ac-1", "ac-opt"],
        testNames: ["target-behavior", "optional test"]
      }
    } : check);
    const plan = createVerificationPlan({ ...f.input, specification: specWithOpt, strategy: strategyWithOpt, checks: checksWithOpt });
    const originalEvaluate = f.runners[0]!.evaluate.bind(f.runners[0]);
    f.runners[0]!.evaluate = async (ctx, opts) => {
      const res = await originalEvaluate(ctx, opts);
      if (res.ok && res.value.metadata?.verification) {
        const obs = res.value.metadata.verification as any;
        obs.criteria = [
          { criterionId: "ac-1", passed: true, summary: "ac-1 passed" },
          { criterionId: "ac-opt", passed: false, summary: "optional check failed" }
        ];
        obs.testNames = ["target-behavior", "optional test"];
      }
      return res;
    };
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(plan, engine.start(plan, "cycle-1"), await f.change());
    expect(outcome.result.status).toBe("passed");
    const optEval = outcome.result.evaluatedCriteria.find(c => c.criterionId === "ac-opt");
    expect(optEval?.passed).toBe(true);
    expect(optEval?.summary).toContain("Optional criterion not satisfied");
  });

  it("binds integrationCommitHash and integratedTaskIds into result metadata for workflow verification", async () => {
    const f = await fixture({ scope: "workflow" });
    const engine = new VerificationEngine(f.ports);
    const change = await f.change();
    const integration = { headCommitHash: change.headCommitHash, integratedTaskIds: ["task-1"] };
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle-workflow"), change, { integration });
    expect(outcome.result.status).toBe("passed");
    expect(outcome.result.metadata?.integrationCommitHash).toBe(change.headCommitHash);
    expect(outcome.result.metadata?.integratedTaskIds).toEqual(["task-1"]);
  });

  it("engine re-validation accepts waived plan and rejects tampered waiver", async () => {
    const f = await fixture({
      reviewWaiver: { kind: "deterministic_coverage", reason: "All criteria automated" }
    });
    const engine = new VerificationEngine(f.ports);
    const cycle = engine.start(f.plan, "cycle-waived");
    const outcome = await engine.verify(f.plan, cycle, await f.change());
    expect(outcome.result.status).toBe("passed");
    expect(outcome.cycle.status).toBe("passed");

    const tampered = {
      ...f.plan,
      reviewWaiver: { kind: "deterministic_coverage" as const, reason: "Tampered reason" }
    };
    expect(() => engine.start(tampered, "cycle-tampered")).toThrow("Verification plan was modified");
  });
});

describe("verification planning", () => {
  it("requires coverage for every acceptance criterion", async () => {
    const f = await fixture();
    expect(() => createVerificationPlan({ ...f.input, checks: f.input.checks.slice(1) })).toThrow();
  });
  it("requires independent review and preserves immutable accepted specification", async () => {
    const f = await fixture();
    expect(() => createVerificationPlan({ ...f.input, checks: f.input.checks.slice(0, 2) })).toThrow();
    expect(f.plan.specification.status).toBe("approved");
  });
  it("refuses unsafe repository paths before dispatch", async () => {
    const f = await fixture();
    expect(() => createVerificationPlan({ ...f.input,
      specification: { ...f.specification, affectedPaths: ["../../sensitive"] } })).toThrow();
    expect(f.runners.every(runner => runner.calls.length === 0)).toBe(true);
  });
  it("requires post-integration checks for workflow-level plans", async () => {
    const f = await fixture();
    expect(() => createVerificationPlan({ ...f.input, scope: "workflow" })).toThrow();
  });
  it("rejects unsupported loop limits", async () => {
    const f = await fixture();
    expect(() => createVerificationPlan({ ...f.input, maxIterations: 0 })).toThrow();
    expect(() => createVerificationPlan({ ...f.input, maxIterations: 11 })).toThrow();
  });
});
