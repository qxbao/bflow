import { describe, expect, it } from "vitest";
import { RepositoryToolPolicySchema, ResolvedToolGrantSchema, ToolUsageRecordSchema, type ResolvedToolGrant } from "@bflow/contracts";
import { toolActionInvocationId, uninvokedToolDispositions, validateMemoryActionInput, validateMemoryActionOutput,
  visibleToolUsage, nextToolActionInvocationId, rtkRequirement } from "../../src/agentic/tool-action-policy.js";

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
  it("accepts the Gateway stdio driver's raw MCP content array", () => {
    const note = { drawer_id: "drawer-fixture", text: "Sanitized historical note", wing: "engineering", room: "decisions",
      source_path: "/approved/notes/fixture.md", filed_at: "2026-10-24T10:06:19.726007" };
    const gatewayOutput = [{ type: "text", text: JSON.stringify({ results: [note] }) }];

    expect(validateMemoryActionOutput(grant, "mempalace_search", gatewayOutput as never)).toMatchObject([{
      text: note.text, provenance: { wing: note.wing, sourceId: note.drawer_id, sourceReference: note.source_path,
        repositoryId: "repo-1", repositoryBinding: "approved_wing_policy" }
    }]);
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

  it("creates stable per-task skip/degraded/blocked records without invoking optional tools", () => {
    const policy = RepositoryToolPolicySchema.parse({ schemaVersion: 3, repositoryId: "repo-1",
      scope: { kind: "repository", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo" }, digest: "b".repeat(64),
      requirements: [{ toolId: "mempalace", kind: "native_remote_mcp", serviceId: "memory-service", operations: ["mempalace_search"],
        requiredness: "optional", roles: ["coordinator"], triggers: ["prior_context"], memoryScope: grant.memoryScope }] });
    const assignment = { runId: "run-1", taskId: "task-1", attemptId: "attempt-1" };
    const shared = { policy, role: "coordinator" as const, sessionId: "session-1", repositoryId: "repo-1", repositoryPath: "/repo",
      generation: 4, assignment, existing: [], observedAt: new Date().toISOString() };
    const scopedGrant = ResolvedToolGrantSchema.parse({ ...grant, policyDigest: policy.digest });
    const skipped = uninvokedToolDispositions({ ...shared, grants: [scopedGrant] });
    expect(skipped).toMatchObject([{ runId: "run-1", taskId: "task-1", role: "coordinator", status: "skipped", reasonCode: "trigger_not_used" }]);
    expect(skipped[0]?.invocationId).toBe(toolActionInvocationId("session-1", "coordinator", "prior_context", "mempalace", "mempalace_search", assignment));
    expect(uninvokedToolDispositions({ ...shared, grants: [] })).toMatchObject([{ status: "degraded", reasonCode: "optional_grant_unavailable" }]);
    const requiredPolicy = RepositoryToolPolicySchema.parse({ ...policy, digest: "c".repeat(64), requirements: policy.requirements.map(item => ({ ...item, requiredness: "required" })) });
    expect(uninvokedToolDispositions({ ...shared, policy: requiredPolicy, grants: [] })).toMatchObject([{ status: "blocked", reasonCode: "required_grant_unavailable" }]);
    const used = ToolUsageRecordSchema.parse({ ...skipped[0], status: "completed", reasonCode: undefined,
      observedAt: new Date().toISOString() });
    expect(uninvokedToolDispositions({ ...shared, grants: [scopedGrant], existing: [used] })).toEqual([]);
  });

  it("keeps old-generation unknown usage visible only to the matching authenticated run/task", () => {
    const record = ToolUsageRecordSchema.parse({ schemaVersion: 3, runId: "run-1", taskId: "task-1", role: "coordinator", sessionId: "session-1",
      generation: 1, invocationId: "action-old-generation", toolId: "mempalace", serviceId: "memory-service", operation: "mempalace_search",
      status: "unknown", reasonCode: "unknown_delivery", observedAt: new Date().toISOString() });
    expect(visibleToolUsage([record], "session-1", "coordinator", { runId: "run-1", taskId: "task-1" })).toEqual([record]);
    expect(visibleToolUsage([record], "session-1", "coordinator", { runId: "run-2", taskId: "task-1" })).toEqual([]);
  });

  it("gives an explicit repeat a distinct identity but never advances past unresolved delivery", () => {
    const completed = ToolUsageRecordSchema.parse({ schemaVersion: 3, runId: "run-1", taskId: "task-1", role: "developer",
      sessionId: "session-1", generation: 1, invocationId: "rtk-base", toolId: "rtk", operation: "pipe",
      status: "completed", observedAt: new Date().toISOString() });
    expect(nextToolActionInvocationId("rtk-base", [completed])).toBe("rtk-base-r1");
    expect(nextToolActionInvocationId("rtk-base", [{ ...completed, generation: 7 }])).toBe("rtk-base-r1");
    expect(() => nextToolActionInvocationId("rtk-base", [{ ...completed, status: "unknown" }])).toThrow(/unresolved/);
    expect(() => nextToolActionInvocationId("rtk-base", [{ ...completed, status: "started" }])).toThrow(/unresolved/);
  });

  it("does not infer RTK authority or a generation requirement without repository policy", () => {
    expect(rtkRequirement(undefined, "developer", "unit-test")).toBeUndefined();
  });
});
