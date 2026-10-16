import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TddDecisionSchema, TestStrategySchema } from "@bflow/contracts";
import { TestStrategyResolver } from "../src/index.js";
import { assessment, nonBehavior, spec } from "./fixtures.js";

const resolver = new TestStrategyResolver();
describe("risk-based conditional TDD", () => {
  it.each(["domain_logic", "bugfix", "api_contract", "validation", "transformation", "state_machine"])("requires test-first for testable %s", task => {
    const strategy = resolver.resolve(spec(assessment(task)));
    expect(strategy.tddDecision.mode).toBe("required");
    expect(strategy.tddDecision.requiresFailingTestFirst).toBe(true);
    expect(TestStrategySchema.safeParse(strategy).success).toBe(true);
    expect(strategy.metadata.conditionalTdd.evidenceRequirements.join(" ")).toMatch(/Red.*Green.*refactor/i);
  });
  it.each(["integration", "refactoring", "exploratory_spike"])("recommends for %s", task => {
    expect(resolver.resolve(spec(assessment(task))).tddDecision.mode).toBe("recommended");
  });
  it.each(["documentation", "formatting", "ui_layout", "infrastructure", "configuration"])("uses alternative verification for pure %s", task => {
    const strategy = resolver.resolve(spec(nonBehavior(task), "manual_review"));
    expect(strategy.tddDecision.mode).toBe("not_applicable");
    expect(strategy.metadata.conditionalTdd.requiredVerificationMethods.length).toBeGreaterThan(0);
    expect(strategy.metadata.conditionalTdd.evidenceRequirements.length).toBeGreaterThan(0);
  });
  it.each(["documentation", "formatting", "configuration", "ui_layout"])("cannot hide business logic behind %s label", task => {
    const a = assessment(task);
    a.changeImpact.surfaces.push("domain_logic");
    expect(resolver.resolve(spec(a)).tddDecision.mode).toBe("required");
  });
  it("promotes an automated acceptance criterion even with a misleading doc label", () => {
    const a = nonBehavior("documentation");
    a.testability.level = "automated";
    a.changeImpact.deterministic = true;
    expect(resolver.resolve(spec(a)).tddDecision.mode).toBe("required");
  });
  it("does not require TDD mechanically for behaviorless bugfixes", () => {
    expect(resolver.resolve(spec(nonBehavior("bugfix"), "manual_review")).tddDecision.mode).toBe("recommended");
  });
  it("keeps untestable domain logic recommended, with a setup requirement", () => {
    const a = nonBehavior("domain_logic");
    const strategy = resolver.resolve(spec(a));
    expect(strategy.tddDecision.mode).toBe("recommended");
    expect(strategy.tddDecision.rationale).toMatch(/testability|infrastructure/i);
  });
  it("does not invent commands when infrastructure is absent", () => {
    const a = assessment("domain_logic", { infrastructure: { readiness: "absent", commands: [] } });
    const strategy = resolver.resolve(spec(a));
    expect(strategy.tddDecision.mode).toBe("recommended");
    expect(strategy.targetCommands).toEqual([]);
    expect(strategy.tddDecision.verifiableConditions.join(" ")).toMatch(/provision/i);
  });
  it.each(["high", "critical"])("strengthens %s risk integration", riskClassification => {
    const strategy = resolver.resolve(spec(assessment("integration", { riskClassification })));
    expect(strategy.tddDecision.mode).toBe("required");
    expect(strategy.metadata.conditionalTdd.requiredVerificationMethods).toEqual(expect.arrayContaining(["manual_review", "static_analysis", "integration_test"]));
  });
  it("security impact raises low declared risk", () => {
    const a = assessment("integration"); a.changeImpact.securitySensitive = true;
    expect(resolver.resolve(spec(a)).metadata.conditionalTdd.riskLevel).toBe("high");
  });
  it("takes the maximum of spec and assessment risk", () => {
    const s = spec(assessment("integration")); s.riskLevel = "critical";
    expect(resolver.resolve(s).tddDecision.mode).toBe("required");
  });
  it("high risk documentation still uses alternative verification", () => {
    const a = nonBehavior("documentation"); a.riskClassification = "critical";
    expect(resolver.resolve(spec(a, "manual_review")).tddDecision.mode).toBe("not_applicable");
  });
  it("honors project conventions without overriding pure documentation", () => {
    const a = assessment("integration"); a.conventions.tdd = "required";
    expect(resolver.resolve(spec(a)).tddDecision.mode).toBe("required");
    const doc = nonBehavior("documentation"); doc.conventions.tdd = "required";
    expect(resolver.resolve(spec(doc, "manual_review")).tddDecision.mode).toBe("not_applicable");
  });
  it("preserves every criterion and project verification convention", () => {
    const a = assessment(); a.conventions.requiredMethods = ["lint"]; a.conventions.suggestedLevels = ["property"];
    const strategy = resolver.resolve(spec(a));
    expect(strategy.criterionMappings).toHaveLength(1);
    expect(strategy.metadata.conditionalTdd.requiredVerificationMethods).toContain("lint");
    expect(strategy.metadata.conditionalTdd.suggestedTestLevels).toContain("property");
  });
  it("produces deterministic decisions and validates its own output", () => {
    const s = spec(); const strategy = resolver.resolve(s);
    expect(resolver.resolve(s)).toEqual(strategy);
    expect(resolver.validate(strategy)).toEqual(strategy);
  });
  it("rejects missing rationale at contract ingress", () => {
    const decision = resolver.resolve(spec()).tddDecision;
    expect(() => TddDecisionSchema.parse({ ...decision, rationale: "  " })).toThrow();
  });
  it("rejects a downgraded strategy even if the base contract permits recommended", () => {
    const strategy = resolver.resolve(spec());
    strategy.tddDecision.mode = "recommended"; strategy.tddDecision.requiresFailingTestFirst = false;
    expect(() => resolver.validate(strategy)).toThrow(/policy/i);
  });
  it("rejects stripped criterion mappings and methods", () => {
    const strategy = resolver.resolve(spec()); strategy.criterionMappings = [];
    expect(() => resolver.validate(strategy)).toThrow();
  });
  it.each([null, {}, { metadata: { conditionalTdd: {} } }])("rejects invalid input %j", input => {
    expect(() => resolver.resolve(input)).toThrow();
  });
  it("requires explicit assessment and run binding", () => {
    const s = spec(); delete s.runId;
    expect(() => resolver.resolve(s)).toThrow();
    const other = spec(); other.metadata = {};
    expect(() => resolver.resolve(other)).toThrow();
  });
  it("rejects partial infrastructure as a claim that test-first is mandatory", () => {
    const a = assessment(); a.infrastructure.readiness = "partial";
    expect(resolver.resolve(spec(a)).tddDecision.mode).toBe("recommended");
  });
  it("code paths contradicting a documentation-only label retain verification", () => {
    const s = spec(nonBehavior("documentation"), "manual_review"); s.affectedPaths.push("src/authorization.ts");
    expect(resolver.resolve(s).tddDecision.mode).toBe("recommended");
  });
  it("a mixed refactor with reproducible regression requires TDD", () => {
    const a = assessment("refactoring"); a.changeImpact.surfaces.push("bugfix");
    expect(resolver.resolve(spec(a)).tddDecision.mode).toBe("required");
  });
  it("data migrations require typecheck, static_analysis, integration and review evidence", () => {
    const a = assessment("configuration"); a.changeImpact.dataMigration = true;
    const strategy = resolver.resolve(spec(a));
    expect(strategy.metadata.conditionalTdd.requiredVerificationMethods).toEqual(expect.arrayContaining([
      "typecheck", "static_analysis", "integration_test", "manual_review"
    ]));
  });
  it("does not let caller humanOverride metadata suppress policy", () => {
    const s = spec(); s.metadata!.humanOverrideApproved = true;
    expect(resolver.resolve(s).tddDecision.mode).toBe("required");
  });
  it("rejects all-optional criteria as a way to skip verification", () => {
    const s = spec(); s.acceptanceCriteria[0]!.required = false;
    expect(() => resolver.resolve(s)).toThrow();
  });
  it("rebinds policy to authoritative spec and detects altered assessments", () => {
    const s = spec(); const strategy = resolver.resolve(s);
    expect(resolver.validateAgainstSpecification(strategy, s)).toEqual(strategy);
    const changed = spec(nonBehavior("documentation"), "manual_review");
    expect(() => resolver.validateAgainstSpecification(resolver.resolve(changed), s)).toThrow();
  });
  it("decision identity changes with criterion, risk and task revisions", () => {
    const s = spec(); const first = resolver.resolve(s).tddDecision.decisionId;
    s.acceptanceCriteria[0]!.description = "Updated expected behavior";
    expect(resolver.resolve(s).tddDecision.decisionId).not.toBe(first);
  });
  it("the documented contract example resolves to required", () => {
    const example: unknown = JSON.parse(readFileSync(new URL("../examples/domain-logic.spec.json", import.meta.url), "utf8"));
    expect(resolver.resolve(example).tddDecision.mode).toBe("required");
  });
  it("preferred TDD does not create a Red phase for pure documentation", () => {
    const a = nonBehavior("documentation"); a.conventions.tdd = "preferred";
    expect(resolver.resolve(spec(a, "manual_review")).tddDecision.mode).toBe("not_applicable");
  });
  it("formatting with existing regression tests does not need an artificial Red", () => {
    const a = nonBehavior("formatting"); a.testability.level = "automated";
    const strategy = resolver.resolve(spec(a));
    expect(strategy.tddDecision.mode).toBe("not_applicable");
    expect(strategy.targetCommands).toContain("pnpm test:unit");
  });
  it("does not require Red when a behavioral criterion lacks its test command", () => {
    const s = spec();
    s.acceptanceCriteria.push({ ...s.acceptanceCriteria[0]!, id: "ac-browser", verificationMethod: "e2e_test" });
    const strategy = resolver.resolve(s);
    expect(strategy.tddDecision.mode).toBe("recommended");
    expect(strategy.tddDecision.verifiableConditions.join(" ")).toMatch(/Provision a runnable e2e_test/);
  });
  it("resolves draft level: 'full' specification before testStrategy and tddDecision are attached", () => {
    const s = spec();
    s.level = "full";
    s.architectureNotes = "Valid arch notes";
    s.securityConsiderations = "Valid security considerations";
    s.rollbackPlan = "Valid rollback plan";
    expect(s.testStrategy).toBeUndefined();
    expect(s.tddDecision).toBeUndefined();
    const strategy = resolver.resolve(s);
    expect(strategy).toBeDefined();
    expect(strategy.tddDecision.mode).toBe("required");
  });
  it("updating spec.updatedAt upon approval does not invalidate strategyId or decisionId", () => {
    const s = spec();
    const strategy1 = resolver.resolve(s);
    s.updatedAt = "2026-10-16T02:00:00Z";
    s.status = "approved";
    s.approvedBy = "lead";
    s.artifactRef = {
      trust: "stored",
      artifactId: "spec-art",
      runId: s.runId!,
      taskId: "task-1",
      kind: "document",
      mediaType: "application/json",
      uri: `artifact://${s.runId}/spec-art`,
      checksum: { algorithm: "sha256", value: "a".repeat(64) },
      createdAt: s.updatedAt
    };
    const strategy2 = resolver.resolve(s);
    expect(strategy2.strategyId).toBe(strategy1.strategyId);
    expect(strategy2.tddDecision.decisionId).toBe(strategy1.tddDecision.decisionId);
    expect(() => resolver.validateAgainstSpecification(strategy1, s)).not.toThrow();
  });
  it("allows custom non-empty testNames in strategy criterion mappings", () => {
    const s = spec();
    const strategy = resolver.resolve(s);
    strategy.criterionMappings = [{ criterionId: "ac-1", testNames: ["should round properly"] }];
    expect(resolver.validate(strategy)).toBeDefined();
    expect(resolver.validateAgainstSpecification(strategy, s)).toBeDefined();
  });
});
