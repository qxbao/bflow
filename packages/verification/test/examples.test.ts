import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { VerificationResultSchema } from "@bflow/contracts";

describe("structured verification result examples", () => {
  for (const name of ["passed", "failed", "inconclusive", "blocked", "escalated", "workflow-failed"] as const) {
    it(`${name} conforms to contracts v2`, async () => {
      const body: unknown = JSON.parse(await readFile(new URL(`../examples/${name}.json`, import.meta.url), "utf8"));
      const result = VerificationResultSchema.parse(body);
      expect(result.status).toBe(name === "workflow-failed" ? "failed" : name);
      expect(result.verificationScope).toBe(name === "workflow-failed" ? "workflow" : "task");
      expect(result.evaluatedCriteria.map(criterion => criterion.criterionId).sort()).toEqual(["ac-1", "ac-review", "ac-types"]);
    });
  }
});
