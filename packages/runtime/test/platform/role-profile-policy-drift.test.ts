import { expect, it } from "vitest";
import * as profiles from "../../src/platform/role-profiles.js";

it("binds builtin prompt and actual host/provider policy bytes instead of a release label", () => {
  const bytes = { builtinPrompt: "Builtin role policy", hostPolicy: "Host instructions and scope checks", providerPolicy: "Native permissions" };
  const before = profiles.computeRolePolicyDigest("developer", bytes);
  expect(before).toMatch(/^[a-f0-9]{64}$/);
  for (const key of Object.keys(bytes) as (keyof typeof bytes)[]) {
    expect(profiles.computeRolePolicyDigest("developer", { ...bytes, [key]: `${bytes[key]} changed` })).not.toBe(before);
  }
  expect(profiles.computeRolePolicyDigest("reviewer", bytes)).not.toBe(before);
});
