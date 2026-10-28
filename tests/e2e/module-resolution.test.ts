import { expect, it } from "vitest";
import { WebCommandSchema as RootWebCommandSchema } from "@bflow/contracts";
import { WebCommandSchema } from "@bflow/contracts/web";
import { webCommandFingerprint } from "@bflow/contracts/web-host";

it("loads web subpaths and the package root from the same contracts under E2E source aliases", () => {
  expect(WebCommandSchema).toBe(RootWebCommandSchema);
  const command = WebCommandSchema.parse({
    apiVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000001",
    projectId: "resolver-regression",
    kind: "create_request",
    title: "Export report",
    requestKind: "feature",
    objective: "Export a report",
    acceptanceCriteria: [{ description: "Report opens", verificationMethod: "unit_test" }],
    constraints: []
  });
  expect(webCommandFingerprint(command)).toMatch(/^[a-f0-9]{64}$/);
});
