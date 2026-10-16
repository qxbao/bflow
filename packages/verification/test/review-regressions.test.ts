import { describe, expect, it } from "vitest";
import { VerificationEngine } from "../src/engine.js";
import { createVerificationPlan } from "../src/model.js";
import { fixture, now } from "./fixtures.js";

const repair = (changeSetId: string) => ({ repair: {
  taskId: "task-1", role: "developer", changeSetId, summary: "Scoped correction after independent verification"
} });

describe("P17 review regressions", () => {
  it.each(["attemptId", "changeSetId", "headCommitHash"] as const)("rejects %s used before the immediately previous iteration", async field => {
    const f = await fixture();
    f.runners[0]!.mode = "failed";
    const engine = new VerificationEngine(f.ports);
    const first = await engine.verify(f.plan, engine.start(f.plan, "cycle"), await f.change());
    const secondChange = await f.change(2);
    const second = await engine.verify(f.plan, first.cycle, secondChange, repair(secondChange.changeSetId));
    const third = { ...await f.change(3), [field]: field === "attemptId" ? first.result.attemptId : first.result.changeSet![field] };
    await expect(engine.verify(f.plan, second.cycle, third, repair(third.changeSetId))).rejects.toThrow(/new|used|fresh/i);
    expect(f.runners[0]!.calls).toHaveLength(2);
  });

  it("does not mark a criterion passed when another planned check of it has invalid evidence", async () => {
    const f = await fixture();
    const checks = f.input.checks.map(check => check.id === "type-check" ? { ...check,
      configuration: { ...check.configuration as Record<string, unknown>, criterionIds: ["ac-types", "ac-1"] }
    } : check);
    const plan = createVerificationPlan({ ...f.input, checks });
    f.runners[1]!.mode = "missing";
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(plan, engine.start(plan, "cycle"), await f.change());
    expect(outcome.result.status).toBe("inconclusive");
    expect(outcome.result.evaluatedCriteria.find(c => c.criterionId === "ac-1")?.passed).toBe(false);
  });

  it("reruns a review whose nonzero exit contradicted its passing gate status", async () => {
    const f = await fixture();
    const checks = f.input.checks.map(check => check.id === "review-check" ? { ...check,
      configuration: { ...check.configuration as Record<string, unknown>, dependsOnPaths: ["packages/example/review-scope"] }
    } : check);
    const plan = createVerificationPlan({ ...f.input, checks });
    f.runners[2]!.rewriteObservation = observation => ({ ...observation, exitCode: 1 });
    const engine = new VerificationEngine(f.ports);
    const originalChange = await f.change();
    const first = await engine.verify(plan, engine.start(plan, "cycle"), originalChange);
    expect(first.result.status).toBe("failed");
    f.runners[2]!.rewriteObservation = observation => ({ ...observation, exitCode: 0 });
    const change = { ...await f.change(2), baseCommitHash: originalChange.headCommitHash };
    const second = await engine.verify(plan, first.cycle, change, repair(change.changeSetId));
    expect(second.result.status).toBe("passed");
    expect(f.runners[2]!.calls).toHaveLength(2);
  });

  it.each(["2026-10-15T01:00:00Z", "2026-10-17T01:00:00Z"])("rejects check evidence evaluated outside this execution window: %s", async evaluatedAt => {
    const f = await fixture();
    f.runners[0]!.rewriteResult = result => ({ ...result, evaluatedAt });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle"), await f.change());
    expect(outcome.result.status).toBe("inconclusive");
    expect(outcome.cycle.status).toBe("escalated");
  });

  it("rejects glob expressions masquerading as exhaustive literal impact paths", async () => {
    const f = await fixture();
    const checks = f.input.checks.map(check => ({ ...check,
      configuration: { ...check.configuration as Record<string, unknown>, dependsOnPaths: ["packages/example/**/*.ts"] }
    }));
    expect(() => createVerificationPlan({ ...f.input, checks })).toThrow(/path|glob/i);
  });

  it("blocks workflow acceptance when integrated tasks omit authoritative specification tasks", async () => {
    const f = await fixture({ scope: "workflow" });
    const document = { ...f.specification, traceabilityTaskIds: ["task-1", "task-2"] };
    const artifactRef = await f.store.seed("workflow-spec", "document", document);
    const specification = { ...document, artifactRef };
    f.setSpecification(specification);
    const plan = createVerificationPlan({ ...f.input, specification });
    const change = await f.change();
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(plan, engine.start(plan, "cycle"), change,
      { integration: { headCommitHash: change.headCommitHash, integratedTaskIds: ["task-1"] } });
    expect(outcome.result.status).toBe("blocked");
    expect(f.runners.every(runner => runner.calls.length === 0)).toBe(true);
  });

  it("passes and forwards complete workflow integration provenance to the independent runner", async () => {
    const f = await fixture({ scope: "workflow" });
    const document = { ...f.specification, traceabilityTaskIds: ["task-1", "task-2"] };
    const artifactRef = await f.store.seed("complete-workflow-spec", "document", document);
    const specification = { ...document, artifactRef };
    f.setSpecification(specification);
    const plan = createVerificationPlan({ ...f.input, specification });
    const change = await f.change();
    const engine = new VerificationEngine(f.ports);
    const integration = { headCommitHash: change.headCommitHash, integratedTaskIds: ["task-1", "task-2"] };
    const outcome = await engine.verify(plan, engine.start(plan, "cycle"), change, { integration });
    expect(outcome.result.status).toBe("passed");
    expect(f.runners[0]!.calls[0]!.input).toMatchObject({ integration });
  });

  it("reports each failing check and criterion even when another check already emitted an error", async () => {
    const f = await fixture();
    f.runners[0]!.mode = "failed";
    f.runners[2]!.mode = "failed";
    f.runners[2]!.rewriteResult = result => ({ ...result, findings: [], evaluatedAt: now });
    const engine = new VerificationEngine(f.ports);
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "cycle"), await f.change());
    expect(outcome.result.findings.some(finding => typeof finding.details === "object" &&
      finding.details !== null && !Array.isArray(finding.details) && finding.details.checkId === "review-check" &&
      finding.details.criterionId === "ac-review" && finding.details.responsibleRole === "developer")).toBe(true);
  });
});
