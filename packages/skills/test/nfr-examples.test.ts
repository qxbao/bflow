import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AcceptanceCriterionSchema, SpecificationSchema } from "@bflow/contracts";

const exampleUrl = new URL(
  "../../../skills/sdlc/specification-driven-development/nfr-examples.md",
  import.meta.url,
);

describe("published NFR criterion examples", () => {
  it("parses every published JSON criterion in an existing draft Specification", async () => {
    const markdown = await readFile(exampleUrl, "utf8");
    const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)];
    expect(blocks).toHaveLength(4);
    const criteria = blocks.map((block) => AcceptanceCriterionSchema.parse(JSON.parse(block[1]!)));
    expect(new Set(criteria.map((criterion) => criterion.id)).size).toBe(4);
    expect(criteria.map((criterion) => criterion.category)).toEqual([
      "performance", "security", "non_functional", "performance",
    ]);
    for (const criterion of criteria) {
      expect(criterion.status).toBe("pending");
      expect(criterion.evidenceArtifactIds).toEqual([]);
      expect(criterion.waiverReason).toBeUndefined();
    }
    const spec = SpecificationSchema.parse({
      schemaVersion: 2, specId: "spec-nfr-example", sessionId: "session-example",
      level: "lightweight", title: "Illustrative NFR draft", summary: "Not an approved project SLA",
      problemStatement: "Vague NFRs lack reproducible acceptance conditions",
      scope: { inScope: ["Changed endpoint and storage path"], outOfScope: [] },
      acceptanceCriteria: criteria, affectedPaths: ["example-service"], status: "draft",
      createdBy: "specifier", createdAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
    });
    expect(spec.acceptanceCriteria).toHaveLength(4);
    // Schema validity is independent of evidence. Quantified prose cannot satisfy a criterion.
    expect(AcceptanceCriterionSchema.safeParse({
      ...criteria[0], status: "satisfied",
    }).success).toBe(false);
    // The strict public contract has no private NFR protocol fields.
    expect(AcceptanceCriterionSchema.safeParse({
      ...criteria[0], metric: "latency", threshold: 250,
    }).success).toBe(false);
  });
});
