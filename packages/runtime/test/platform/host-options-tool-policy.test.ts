import { describe, expect, it } from "vitest";
import { AgenticHostPlatformOptionsSchema } from "../../src/platform/host-options.js";

const base = {
  schemaVersion: 3,
  machineId: "machine-1",
  repositoryId: "repo-1",
  roles: [
    { role: "conversation", provider: "codex", required: true, permissionMode: "restricted", capabilityIds: [], mcpServiceIds: [], toolIds: [], skillSelections: [] },
    { role: "coordinator", provider: "codex", required: true, permissionMode: "restricted", capabilityIds: [], mcpServiceIds: [], toolIds: [], skillSelections: [] }
  ],
  skillsStoreRoot: "/machine/skills",
  approvedBuiltinSkillDigests: []
} as const;

const policy = {
  schemaVersion: 3,
  repositoryId: "repo-1",
  scope: { kind: "repository", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo" },
  digest: "a".repeat(64),
  requirements: [{ toolId: "context7", kind: "native_remote_mcp", serviceId: "context7", operations: ["query_docs"], requiredness: "optional",
    roles: ["coordinator"], triggers: ["external_documentation"] }]
} as const;

const grant = {
  schemaVersion: 3,
  grantId: "grant-context7",
  policyDigest: "a".repeat(64),
  toolId: "context7",
  kind: "native_remote_mcp",
  requiredness: "optional",
  role: "coordinator",
  scope: { kind: "session", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo", sessionId: "session-1" },
  triggers: ["external_documentation"],
  serviceId: "context7",
  operations: ["query_docs"]
} as const;

describe("Runtime host tool-policy wire fields", () => {
  it("keeps older host options valid and parses the exported policy and grant envelopes", () => {
    expect(AgenticHostPlatformOptionsSchema.parse(base)).toMatchObject({ schemaVersion: 3 });
    expect(AgenticHostPlatformOptionsSchema.parse({ ...base, toolPolicy: policy, toolGrants: [grant] }))
      .toMatchObject({ toolPolicy: policy, toolGrants: [grant] });
  });

  it("rejects malformed and unknown grant fields at the host ingress", () => {
    expect(AgenticHostPlatformOptionsSchema.safeParse({ ...base, toolGrants: [{ ...grant, operations: [" "] }] }).success).toBe(false);
    expect(AgenticHostPlatformOptionsSchema.safeParse({ ...base, toolGrants: [{ ...grant, unexpected: true }] }).success).toBe(false);
  });
});
