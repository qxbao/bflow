import { describe, expect, it } from "vitest";
import { RoleMessageSchema, SpecificationSchema } from "@bflow/contracts";
import { availableTools } from "../../src/agentic/host.js";
import { parseNativeRoleMessage, roleReplyExample, roleReplyGuidance } from "../../src/agentic/role-tool-schema.js";
import { ChangeAssessmentSchema } from "../../../specification/src/classification.js";

// These are the schemas actually returned by the provider MCP tools/list path.
const input = (role: "architect" | "coordinator", name: string) =>
  availableTools(role).find(tool => tool.name === name)!.inputSchema as any;

describe("native role tool schema guidance", () => {
  it("exposes pinned role instructions to Coordinator and Developer without granting repository or provider-home access", () => {
    for (const provider of ["agy", "claude", "codex"] as const) {
      for (const role of ["coordinator", "developer"] as const) {
        const tools = availableTools(role, provider);
        const read = tools.find(tool => tool.name === "read_pinned_instructions");
        expect(read, `${provider}/${role} must be able to inspect its pinned instructions`).toBeDefined();
        expect(read!.inputSchema).toMatchObject({ additionalProperties: false, required: [],
          properties: { skillId: { type: "string", minLength: 1 } } });
        expect(read!.inputSchema.properties).not.toHaveProperty("path");
      }
      expect(availableTools("developer", provider).some(tool => tool.name === "repository_read")).toBe(false);
      expect(availableTools("conversation", provider).some(tool => tool.name === "read_pinned_instructions")).toBe(false);
    }
  });

  it("gives only Developers bounded workspace file tools with explicit replacement preconditions", () => {
    for (const provider of ["agy", "claude", "codex"] as const) {
      const tools = availableTools("developer", provider);
      const read = tools.find(tool => tool.name === "read_workspace_file");
      const write = tools.find(tool => tool.name === "write_workspace_file");
      expect(read).toBeDefined();
      expect(write).toBeDefined();
      expect(read!.inputSchema).toMatchObject({ required: ["runId", "taskId", "path"], additionalProperties: false });
      expect(write!.inputSchema).toMatchObject({ required: ["runId", "taskId", "path", "content", "expectedSha256"], additionalProperties: false,
        properties: { content: { type: "string", maxLength: 131072 }, expectedSha256: { anyOf: [{ type: "string", pattern: "^[a-f0-9]{64}$" }, { type: "null" }] } } });
      for (const role of ["conversation", "coordinator", "architect", "reviewer", "qa"] as const)
        expect(availableTools(role, provider).some(tool => ["read_workspace_file", "write_workspace_file"].includes(tool.name))).toBe(false);
    }
  });

  it("creates a contract-valid Architect reply example without inventing stored references", () => {
    const example = roleReplyExample("architect");
    expect(RoleMessageSchema.parse(example)).toEqual(example);
    expect(parseNativeRoleMessage(example)).toMatchObject({ sender: { role: "architect" }, recipient: { role: "coordinator" }, artifact_references: [], idempotency_key: "stable-reply-key" });
    expect(roleReplyGuidance("architect")).toContain(JSON.stringify(example));
    for (const field of ["artifact_references", "idempotency_key"]) {
      const invalid = { ...example } as Record<string, unknown>;
      delete invalid[field];
      expect(() => parseNativeRoleMessage(invalid)).toThrow(field);
    }
    expect(() => parseNativeRoleMessage({ ...example, unexpected: true })).toThrow("unexpected");
    expect(() => parseNativeRoleMessage({ ...example, recipient: { role: "architect" } })).toThrow("different");
  });
  it("advertises the full strict RoleMessage envelope and native idempotency requirement", () => {
    const schema = input("architect", "send_role_message").properties.message;
    expect(schema.required).toEqual(expect.arrayContaining(["schema_version", "message_id", "correlation_id", "sender", "recipient", "type", "payload", "artifact_references", "idempotency_key"]));
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.artifact_references).toMatchObject({ type: "array", items: { type: "object" } });
    expect(schema.properties.schema_version).toMatchObject({ const: 2 });
    expect(schema.properties.sender.properties.role.anyOf).toEqual(expect.arrayContaining([expect.objectContaining({ enum: expect.arrayContaining(["architect"]) })]));
    expect(schema.properties.idempotency_key).toMatchObject({ type: "string", minLength: 1 });
    expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(RoleMessageSchema.innerType().shape).sort());
  });

  it("advertises Specification v2 including strict nested criteria for assess and propose_workflow", () => {
    for (const name of ["assess", "propose_workflow"]) {
      const schema = input("coordinator", name).properties.specification;
      expect(schema.required).toEqual(expect.arrayContaining(["schemaVersion", "specId", "sessionId", "level", "summary", "problemStatement", "scope", "status", "createdBy", "createdAt", "updatedAt"]));
      expect(schema.properties.schemaVersion).toMatchObject({ const: 2 });
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual(Object.keys(SpecificationSchema.innerType().shape).sort());
      expect(schema.properties.acceptanceCriteria.items.required).toEqual(expect.arrayContaining(["id", "description", "status", "evidenceArtifactIds"]));
      expect(schema.properties.acceptanceCriteria.items.additionalProperties).toBe(false);
      expect(schema.properties.scope.required).toEqual(["inScope", "outOfScope"]);
      expect(schema.properties.version).toMatchObject({ type: "integer", exclusiveMinimum: 0 });
    }
  });

  it("advertises assess's required P15 impact object while keeping proposal discovery compatible", () => {
    const spec = input("coordinator", "assess").properties.specification;
    expect(spec.required).toContain("metadata");
    expect(spec.properties.metadata.required).toEqual(["sdd"]);
    expect(spec.properties.metadata.properties.sdd.required).toEqual(["assessment"]);
    const assessment = spec.properties.metadata.properties.sdd.properties.assessment;
    // Detect drift against P15's exported schema without importing the leaf into production Runtime.
    expect([...assessment.required].sort()).toEqual(Object.keys(ChangeAssessmentSchema.shape).sort());
    expect(Object.keys(assessment.properties).sort()).toEqual(Object.keys(ChangeAssessmentSchema.shape).sort());
    expect(assessment.properties.kind.enum).toEqual(ChangeAssessmentSchema.shape.kind.options);
    expect(assessment.properties.risk.enum).toEqual(ChangeAssessmentSchema.shape.risk.options);
    expect(assessment.additionalProperties).toBe(false);
    expect(input("coordinator", "propose_workflow").properties.specification.required).not.toContain("metadata");
  });
});
