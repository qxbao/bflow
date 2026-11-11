import { expect, it } from "vitest";
import { VerificationEngine } from "../src/engine.js";
import { createVerificationPlan } from "../src/model.js";
import { FakeToolRunner, fixture } from "./fixtures.js";

it("accepts a host observed test subset when every required criterion has a reported mapped leaf", async () => {
  const f = await fixture();
  const strategy = { ...f.input.strategy, criterionMappings: f.input.strategy.criterionMappings.map(mapping =>
    mapping.criterionId === "ac-1" ? { ...mapping, testNames: ["target-behavior", "future-behavior"] } : mapping) };
  const { artifactRef: _oldRef, ...original } = f.specification;
  const document = { ...original, testStrategy: strategy };
  const artifactRef = await f.store.seed("observed-spec", "document", document);
  const specification = { ...document, artifactRef };
  f.setSpecification(specification);
  const checks = f.input.checks.map(check => check.id === "test-check" ? { ...check, id: "host-behavioral-auto-unit",
    metadata: { observedDiffIdentity: true },
    configuration: { ...check.configuration as Record<string, unknown>, command: "pnpm test:unit", role: "quality_gate",
      testNames: ["target-behavior", "future-behavior"] } } : check);
  const plan = createVerificationPlan({ ...f.input, specification, strategy, checks });
  const host = new FakeToolRunner("host-behavioral-auto-unit");
  host.rewriteObservation = observation => ({ ...observation, testNames: ["target-behavior"] });
  host.rewriteResult = result => ({ ...result, metadata: { ...result.metadata,
    hostExecution: { sourceRevision: result.metadata?.verification &&
      (result.metadata.verification as { sourceRevision: string }).sourceRevision,
      testNames: ["target-behavior"], testResults: [{ name: "target-behavior", passed: true }],
      testBlobs: { "test/target.test.ts": "a".repeat(40) } } } });
  const engine = new VerificationEngine({ ...f.ports, gates: [host, ...f.runners.slice(1)] });

  const outcome = await engine.verify(plan, engine.start(plan, "observed-cycle"), await f.change());

  expect(outcome.result.status).toBe("passed");
  expect(outcome.result.evaluatedCriteria.find(item => item.criterionId === "ac-1")?.passed).toBe(true);
});

it("routes a failed host selection with no runner command to ordinary developer rework", async () => {
  const f = await fixture();
  const checks = f.input.checks.map(check => check.id === "test-check" ? { ...check, id: "host-behavioral-auto-unit",
    metadata: { observedDiffIdentity: true },
    configuration: { ...check.configuration as Record<string, unknown>, role: "quality_gate" } } : check);
  const plan = createVerificationPlan({ ...f.input, checks });
  const host = new FakeToolRunner("host-behavioral-auto-unit");
  host.mode = "failed";
  host.rewriteObservation = observation => {
    const { command: _command, exitCode: _exitCode, ...rest } = observation;
    return { ...rest, testNames: [],
    criteria: [{ criterionId: "ac-1", passed: false, summary: "No mapped test was committed" }],
    summary: "No test command was launched; committed task diff contains no mapped test" };
  };
  host.rewriteResult = result => ({ ...result,
    findings: [{ code: "criterion_without_test", severity: "error", message: "No committed mapped test",
      details: { criterionId: "ac-1", fixableBy: "developer" } }],
    metadata: { ...result.metadata,
      hostExecution: { sourceRevision: result.metadata?.verification &&
        (result.metadata.verification as { sourceRevision: string }).sourceRevision,
        testNames: [], testResults: [], testBlobs: {} } } });
  const engine = new VerificationEngine({ ...f.ports, gates: [host, ...f.runners.slice(1)] });

  const outcome = await engine.verify(plan, engine.start(plan, "missing-tests-cycle"), await f.change());

  if (outcome.result.status !== "failed") throw new Error(JSON.stringify({ status: outcome.result.status, findings: outcome.result.findings }));
  expect(outcome.result.status).toBe("failed");
  expect(outcome.cycle.status).toBe("rework_required");
  expect(outcome.result.findings).toContainEqual(expect.objectContaining({ code: "criterion_without_test" }));
});
