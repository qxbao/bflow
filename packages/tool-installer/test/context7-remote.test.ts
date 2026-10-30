import { describe, expect, it } from "vitest";
import { MCPServiceDefinitionSchema } from "@bflow/contracts";
import { DEEPWIKI_MCP_ENDPOINT, DEEPWIKI_SERVICE_ID, DEEPWIKI_TOOLS, createDeepWikiRemoteService, trustedGatewayPolicy } from "../src/services.js";
import { createToolCapability } from "../src/installer.js";

const operation = { schemaVersion: 3 as const, scope: { kind: "machine" as const, machineId: "machine-1" }, idempotencyKey: "deepwiki-remote-legacy-test" };
const TOOLS = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"];

// File name kept from the Context7 era: this suite carries the legacy hosted-service regression coverage over to DeepWiki.
describe("hosted DeepWiki service definition (migrated from Context7)", () => {
  it("is a remote, shared, concurrent service on the fixed hosted endpoint with no local process", () => {
    const service = createDeepWikiRemoteService({ operation });
    expect(MCPServiceDefinitionSchema.safeParse(service).success).toBe(true);
    expect(service).toMatchObject({ serviceId: DEEPWIKI_SERVICE_ID, connection: { kind: "native_remote_mcp", endpoint: DEEPWIKI_MCP_ENDPOINT, ownership: "external" },
      authentication: { mode: "none" }, tool: { toolId: "deepwiki", kind: "native_remote_mcp", operations: TOOLS,
        resource: { sharing: "concurrent", maxConcurrency: 16 }, required: false } });
    expect(DEEPWIKI_MCP_ENDPOINT).toBe("https://mcp.deepwiki.com/mcp");
    expect([...DEEPWIKI_TOOLS]).toEqual(TOOLS);
  });

  it("never carries a credential reference or key material and honours required", () => {
    const service = createDeepWikiRemoteService({ operation, required: true });
    expect(service.authentication).toEqual({ mode: "none" });
    expect(JSON.stringify(service)).not.toMatch(/ctx7sk|secret:\/\/|bearer/i);
    expect(service.tool.required).toBe(true);
  });

  it("declares the three tools read-only only for the exact hosted endpoint", () => {
    const hosted = createDeepWikiRemoteService({ operation });
    expect(trustedGatewayPolicy(hosted)).toEqual({ readOnlyTools: TOOLS });
    expect(trustedGatewayPolicy({ ...hosted, connection: { kind: "native_remote_mcp", endpoint: "https://evil.example.com/mcp", ownership: "external" } })).toBeUndefined();
    expect(trustedGatewayPolicy({ ...hosted, tool: { ...hosted.tool, toolId: "other" } })).toBeUndefined();
    expect(trustedGatewayPolicy({ ...hosted, connection: { kind: "native_remote_mcp", endpoint: "http://127.0.0.1:1/mcp", ownership: "external" } })).toBeUndefined();
  });

  it("describes the capability for catalogs and inventories", () => {
    expect(createToolCapability("deepwiki", "hosted", "machine-1")).toMatchObject({ kind: "native_remote_mcp", operations: TOOLS });
  });
});
