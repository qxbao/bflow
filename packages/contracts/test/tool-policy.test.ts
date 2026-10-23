import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import { artifactReference, now } from "./fixtures.js";

const digest = "a".repeat(64);
const repoScope = {
  kind: "repository" as const,
  machineId: "machine-1",
  repositoryId: "repo-1",
  workspaceRoot: "/workspace/repo-1"
};

describe("tool policy v3 contracts", () => {
  it("exports all approved tool policy and usage schemas", () => {
    expect(contracts.RepositoryToolPolicySchema).toBeDefined();
    expect(contracts.RoleToolRequirementSchema).toBeDefined();
    expect(contracts.ResolvedToolGrantSchema).toBeDefined();
    expect(contracts.ToolActionRequestSchema).toBeDefined();
    expect(contracts.ToolUsageRecordSchema).toBeDefined();
  });

  it("keeps policy IDs, requiredness, roles and triggers distinct", () => {
    const schema = contracts.RepositoryToolPolicySchema;
    expect(schema).toBeDefined();
    if (!schema) return;
    const policy = {
      schemaVersion: 3,
      repositoryId: "repo-1",
      scope: repoScope,
      digest,
      requirements: [{
        toolId: "context7",
        kind: "native_remote_mcp",
        requiredness: "optional",
        roles: ["developer"],
        triggers: ["external_documentation"],
        operations: ["search"]
      }]
    };
    expect(schema.safeParse(policy).success).toBe(true);
    expect(schema.safeParse({ ...policy, schemaVersion: 2 }).success).toBe(false);
    expect(schema.safeParse({ ...policy, extraPermission: true }).success).toBe(false);
  });

  it("requires exact operation and service identity for resolved MCP grants", () => {
    const schema = contracts.ResolvedToolGrantSchema;
    expect(schema).toBeDefined();
    if (!schema) return;
    const grant = {
      schemaVersion: 3,
      grantId: "grant-1",
      policyDigest: digest,
      toolId: "context7",
      capabilityIds: ["docs.read"],
      kind: "native_remote_mcp",
      requiredness: "required",
      role: "developer",
      scope: { ...repoScope, kind: "session", sessionId: "session-1" },
      triggers: ["external_documentation"],
      serviceId: "context7-service",
      operations: ["search", "fetch"]
    };
    expect(schema.safeParse(grant).success).toBe(true);
    expect(schema.safeParse({ ...grant, serviceId: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...grant, operations: [] }).success).toBe(false);
    expect(schema.safeParse({ ...grant, operations: ["search", "search"] }).success).toBe(false);
  });

  it("requires a trusted executable identity for CLI grants and denies service fields", () => {
    const schema = contracts.ResolvedToolGrantSchema;
    expect(schema).toBeDefined();
    if (!schema) return;
    const grant = {
      schemaVersion: 3,
      grantId: "grant-2",
      policyDigest: digest,
      toolId: "rtk",
      capabilityIds: ["command.output.compress"],
      kind: "cli_only",
      requiredness: "optional",
      role: "developer",
      scope: { ...repoScope, kind: "session", sessionId: "session-1" },
      triggers: ["routine_command"],
      operations: ["run"],
      cliCommandProfiles: ["test-runner"],
      cliIdentity: { executablePath: "/opt/tools/rtk", version: "1.2.3", digest }
    };
    expect(schema.safeParse(grant).success).toBe(true);
    expect(schema.safeParse({ ...grant, cliIdentity: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...grant, serviceId: "fake-mcp" }).success).toBe(false);
  });

  it("limits memory scope to repository and read-only access", () => {
    const schema = contracts.ResolvedToolGrantSchema;
    expect(schema).toBeDefined();
    if (!schema) return;
    const grant = {
      schemaVersion: 3,
      grantId: "grant-3",
      policyDigest: digest,
      toolId: "mempalace",
      capabilityIds: ["memory.search"],
      kind: "native_remote_mcp",
      requiredness: "optional",
      role: "developer",
      scope: { ...repoScope, kind: "session", sessionId: "session-1" },
      triggers: ["prior_context"],
      serviceId: "memory-service",
      operations: ["search"],
      memoryScope: { wing: "engineering", repositoryId: "repo-1", access: "read_only" }
    };
    expect(schema.safeParse(grant).success).toBe(true);
    expect(schema.safeParse({ ...grant, memoryScope: { ...grant.memoryScope, access: "read_write" } }).success).toBe(false);
    expect(schema.safeParse({ ...grant, memoryScope: { ...grant.memoryScope, repositoryId: "other" } }).success).toBe(false);
  });

  it("accepts agent-supplied action data without allowing an agent to assert its identity", () => {
    const schema = contracts.ToolActionRequestSchema;
    expect(schema).toBeDefined();
    if (!schema) return;
    const action = { schemaVersion: 3, actionId: "action-1", toolId: "context7", operation: "search", input: { query: "API" } };
    expect(schema.safeParse(action).success).toBe(true);
    expect(schema.safeParse({ ...action, role: "developer" }).success).toBe(false);
    expect(schema.safeParse({ ...action, principalId: "agent-controlled" }).success).toBe(false);
    expect(schema.safeParse({ ...action, schemaVersion: 2 }).success).toBe(false);
  });

  it("records tool usage without raw payloads and requires evidence for consumed results", () => {
    const schema = contracts.ToolUsageRecordSchema;
    expect(schema).toBeDefined();
    if (!schema) return;
    const record = {
      schemaVersion: 3,
      runId: "run-1",
      taskId: "task-1",
      role: "developer",
      sessionId: "session-1",
      generation: 2,
      invocationId: "invocation-1",
      toolId: "context7",
      serviceId: "context7-service",
      operation: "search",
      status: "completed",
      consumption: { status: "consumed", source: "accepted_artifact", evidenceReferences: [{ ...artifactReference, taskId: "task-1" }] },
      reasonCode: "result_linked",
      observedAt: now
    };
    expect(schema.safeParse(record).success).toBe(true);
    expect(schema.safeParse({ ...record, consumption: { ...record.consumption, evidenceReferences: [] } }).success).toBe(false);
    expect(schema.safeParse({ ...record, rawInput: { token: "secret" } }).success).toBe(false);
    expect(schema.safeParse({ ...record, generation: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...record, status: "failed" }).success).toBe(false);
    expect(schema.safeParse({ ...record, taskId: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...record, status: "completed", reasonCode: undefined }).success).toBe(true);
  });
});
