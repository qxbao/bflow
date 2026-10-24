import { describe, expect, it } from "vitest";
import type { ResolvedToolGrant } from "@bflow/contracts";
import { validateMemoryActionInput, validateMemoryActionOutput } from "../../src/agentic/tool-action-policy.js";

const grant: ResolvedToolGrant = { schemaVersion: 3, grantId: "memory-grant", policyDigest: "a".repeat(64), toolId: "mempalace",
  kind: "native_remote_mcp", requiredness: "optional", role: "coordinator",
  scope: { kind: "session", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo", sessionId: "session-1" },
  triggers: ["prior_context"], serviceId: "memory-service", operations: ["mempalace_search"],
  memoryScope: { wing: "engineering", repositoryId: "repo-1", access: "read_only" } };

describe("Runtime memory tool action policy", () => {
  it("requires exact granted wing and repository context before a memory search", () => {
    expect(() => validateMemoryActionInput(grant, "mempalace_search", { wing: "engineering", query: "design" })).not.toThrow();
    expect(() => validateMemoryActionInput(grant, "mempalace_search", { wing: "global", query: "design" })).toThrow(/wing/);
    expect(() => validateMemoryActionInput(grant, "mempalace_search", { wing: "engineering", repositoryId: "other" })).toThrow(/repository/);
  });

  it("denies memory operations outside the read-only retrieval surface", () => {
    expect(() => validateMemoryActionInput(grant, "mempalace_write", { wing: "engineering" })).toThrow(/read.only/);
  });

  it("requires each returned memory entry to carry matching scope and source timestamp provenance", () => {
    const output = { results: [{ text: "Historical note", provenance: { wing: "engineering", repositoryId: "repo-1",
      timestamp: "2026-10-24T00:00:00.000Z", sourceId: "note-1" } }] };
    expect(validateMemoryActionOutput(grant, "mempalace_search", output)).toHaveLength(1);
    expect(validateMemoryActionOutput(grant, "mempalace_search", { results: [{ text: "Unattributed" }] })).toBeNull();
  });
});
