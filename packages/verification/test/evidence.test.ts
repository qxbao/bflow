import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { VerificationEngine } from "../src/engine.js";
import { CheckConfigurationSchema, createVerificationPlan } from "../src/model.js";
import { fixture } from "./fixtures.js";

async function coverageFixture() {
  const f = await fixture();
  const strategy = { ...f.input.strategy, coverageThresholdPercent: 80 };
  const document = { ...f.specification, testStrategy: strategy };
  const artifactRef = await f.store.seed("coverage-spec", "document", document);
  const specification = { ...document, artifactRef };
  const checks = f.input.checks.map(check => ({ ...check,
    configuration: { ...CheckConfigurationSchema.parse(check.configuration),
      ...(check.id === "test-check" ? { measuresCoverage: true } : {}) }
  }));
  const plan = createVerificationPlan({ ...f.input, strategy, specification, checks });
  f.setSpecification(specification);
  return { ...f, plan };
}

describe("coverage policy and proposal evidence", () => {
  it.each([[90, "passed"], [65, "failed"], [undefined, "inconclusive"]] as const)(
    "uses aggregate coverage %s independently of a passing runner report", async (coveragePercent, expected) => {
      const f = await coverageFixture();
      f.runners[0]!.rewriteObservation = observation => ({ ...observation,
        ...(coveragePercent !== undefined ? { coveragePercent } : {}) });
      const engine = new VerificationEngine(f.ports);
      const outcome = await engine.verify(f.plan, engine.start(f.plan, "coverage-cycle"), await f.change());
      expect(outcome.result.status).toBe(expected);
    });

  it("reruns a below-threshold measurement even if its runner reported passed and paths appear unaffected", async () => {
    const f = await coverageFixture();
    const checks = f.plan.checks.map(check => check.id === "test-check" ? { ...check,
      configuration: { ...CheckConfigurationSchema.parse(check.configuration), dependsOnPaths: ["packages/example/coverage"] }
    } : check);
    const plan = createVerificationPlan({ ...f.input, specification: f.plan.specification, strategy: f.plan.strategy, checks });
    f.runners[0]!.rewriteObservation = observation => ({ ...observation, coveragePercent: 65 });
    const engine = new VerificationEngine(f.ports);
    const original = await f.change();
    const first = await engine.verify(plan, engine.start(plan, "coverage-cycle"), original);
    expect(first.result.status).toBe("failed");
    f.runners[0]!.rewriteObservation = observation => ({ ...observation, coveragePercent: 90 });
    const change = { ...await f.change(2), baseCommitHash: original.headCommitHash };
    const second = await engine.verify(plan, first.cycle, change, { repair: {
      taskId: "task-1", role: "developer", changeSetId: change.changeSetId, summary: "Corrected missing aggregate coverage evidence"
    } });
    expect(second.result.status).toBe("passed");
    expect(f.runners[0]!.calls).toHaveLength(2);
  });

  it("rejects a strategy coverage threshold with no measuring capability", async () => {
    const f = await fixture();
    const strategy = { ...f.input.strategy, coverageThresholdPercent: 80 };
    expect(() => createVerificationPlan({ ...f.input, strategy,
      specification: { ...f.specification, testStrategy: strategy } })).toThrow(/coverage/i);
  });

  it("does not permit review/static analysis to impersonate integration execution", () => {
    for (const method of ["manual_review", "typecheck", "lint", "static_analysis"] as const) {
      expect(CheckConfigurationSchema.safeParse({ kind: method === "manual_review" ? "review" : "deterministic",
        method, role: method === "manual_review" ? "reviewer" : "quality_gate", command: "pnpm check",
        criterionIds: [], testNames: [], levels: ["integration"] }).success).toBe(false);
    }
  });

  it.each([true, false])("ingests proposal bytes before acceptance when materialized=%s", async materialized => {
    const f = await fixture();
    const bytes = Buffer.from("Independent test runner stdout: assertion passed\n");
    const proposal = {
      proposalId: "test-log-proposal", runId: "run-1", taskId: "task-1", kind: "log" as const,
      logicalName: "test.log", mediaType: "text/plain",
      expectedIntegrity: { checksum: { algorithm: "sha256" as const,
        value: createHash("sha256").update(bytes).digest("hex") }, sizeBytes: bytes.length }
    };
    f.runners[0]!.rewriteResult = result => ({ ...result, producedArtifacts: [proposal] });
    const engine = new VerificationEngine({ ...f.ports,
      ...(materialized ? { readProposal: async function* () { yield bytes; } } : {}) });
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "proposal-cycle"), await f.change());
    expect(outcome.result.status).toBe(materialized ? "passed" : "inconclusive");
    if (materialized) {
      const output = outcome.result.evidenceArtifacts.find(ref => ref.artifactId.startsWith("verification-output-"));
      expect(output).toBeDefined();
      expect(f.store.records.get(output!.artifactId)?.bytes).toEqual(new Uint8Array(bytes));
    }
  });

  it("refuses corrupted materialized runner evidence", async () => {
    const f = await fixture();
    f.runners[0]!.rewriteResult = result => ({ ...result, producedArtifacts: [{
      proposalId: "corrupted-log", runId: "run-1", taskId: "task-1", kind: "log", logicalName: "test.log",
      mediaType: "text/plain", expectedIntegrity: { checksum: { algorithm: "sha256", value: "a".repeat(64) } }
    }] });
    const engine = new VerificationEngine({ ...f.ports, readProposal: async function* () { yield Buffer.from("different bytes"); } });
    const outcome = await engine.verify(f.plan, engine.start(f.plan, "corruption-cycle"), await f.change());
    expect(outcome.result.status).toBe("inconclusive");
    expect(outcome.cycle.status).toBe("escalated");
  });
});
