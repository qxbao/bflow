import { describe, expect, it } from "vitest";
import type { ResolvedToolGrant } from "@bflow/contracts";
import { validateMemoryActionInput, validateMemoryActionOutput } from "../../src/agentic/tool-action-policy.js";

const grant: ResolvedToolGrant = { schemaVersion: 3, grantId: "memory-grant", policyDigest: "a".repeat(64), toolId: "mempalace",
  kind: "native_remote_mcp", requiredness: "optional", role: "coordinator",
  scope: { kind: "session", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo", sessionId: "session-1" },
  triggers: ["prior_context"], serviceId: "memory-service", operations: ["mempalace_search"],
  memoryScope: { wing: "engineering", repositoryId: "repo-1", access: "read_only" } };

describe("Runtime memory tool action policy", () => {
  it("validates real MemPalace MCP result fields and labels the repository binding as policy-derived", () => {
    const note = { drawer_id: "drawer-1", text: "Historical note", wing: "engineering", room: "decisions",
      source_path: "/approved/notes/design.md", filed_at: "2026-10-24T10:06:19.726007" };
    const envelope = (entry: typeof note) => ({ content: [{ type: "text", text: JSON.stringify({ results: [entry] }) }] });
    const result = validateMemoryActionOutput(grant, "mempalace_search", envelope(note));
    expect(result).toHaveLength(1);
    expect(result?.[0]?.provenance).toMatchObject({ sourceId: "drawer-1", sourceReference: note.source_path,
      timestamp: note.filed_at, repositoryId: "repo-1", repositoryBinding: "approved_wing_policy" });
    expect(validateMemoryActionOutput(grant, "mempalace_search", envelope({ ...note, wing: "other" }))).toBeNull();
    expect(validateMemoryActionOutput(grant, "mempalace_search", envelope({ ...note, source_path: "" }))).toBeNull();
  });
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
