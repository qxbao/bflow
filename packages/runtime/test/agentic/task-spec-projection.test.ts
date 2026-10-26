import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SpecificationSchema, TestStrategySchema } from "@bflow/contracts";
import { SpecificationEngine } from "../../../specification/src/index.js";
import { TestStrategyResolver } from "../../../test-strategy/src/index.js";
import { projectTaskSpecificationInput } from "../../src/agentic/runtime.js";

// Live run bf-b5679f4f2e725cadfef1 (Việc #1): a unit task (ac-1..ac-4) and a dependent integration task (ac-5) were
// rejected with "unknown or duplicate test criterion" because every task spec kept the workflow's full criterionMappings.
const historical = JSON.parse(await readFile(new URL("./fixtures/runner-proposal.json", import.meta.url), "utf8"));
const draft = SpecificationSchema.innerType().parse(historical.specification);

function reviewed(input: unknown) {
  const original = SpecificationSchema.innerType().parse(input);
  const strategy = TestStrategySchema.parse(new TestStrategyResolver().resolve(original));
  const engine = new SpecificationEngine({ artifactStore: undefined as never, authorizeApprover: () => true });
  return { strategy, specification: engine.createDraft({ ...original, testStrategy: strategy, tddDecision: strategy.tddDecision }) };
}

describe("per-task specification projection", () => {
  it("narrows the submitted criterion mappings to the task's criteria so split DAGs review", () => {
    expect(draft.testStrategy?.criterionMappings.map(mapping => mapping.criterionId)).toEqual(["ac-1", "ac-2", "ac-3"]);
    for (const [taskId, ids] of [["unit", ["ac-1", "ac-3"]], ["integration", ["ac-2"]]] as const) {
      const criteria = draft.acceptanceCriteria.filter(criterion => (ids as readonly string[]).includes(criterion.id));
      const { specification, strategy } = reviewed(projectTaskSpecificationInput(draft, taskId, criteria, "abc123"));
      expect(specification.acceptanceCriteria.map(criterion => criterion.id)).toEqual(ids);
      expect(strategy.criterionMappings.map(mapping => mapping.criterionId)).toEqual(ids);
      // The submitted test names survive the projection; they are what the independent runner must report.
      for (const mapping of strategy.criterionMappings)
        expect(mapping.testNames).toEqual(draft.testStrategy!.criterionMappings.find(item => item.criterionId === mapping.criterionId)!.testNames);
    }
  });

  it("still rejects a task whose own mapping is duplicated", () => {
    const criteria = draft.acceptanceCriteria.filter(criterion => criterion.id === "ac-2");
    const mapping = draft.testStrategy!.criterionMappings.find(item => item.criterionId === "ac-2")!;
    const duplicated = { ...draft, testStrategy: { ...draft.testStrategy!, criterionMappings: [mapping, mapping] } };
    expect(() => reviewed(projectTaskSpecificationInput(duplicated, "integration", criteria, "abc123")))
      .toThrow("unknown or duplicate test criterion");
  });
});
