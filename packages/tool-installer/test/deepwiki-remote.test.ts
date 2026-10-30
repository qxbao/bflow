import { describe, expect, it } from "vitest";
import { MCPServiceDefinitionSchema } from "@bflow/contracts";
import * as services from "../src/services.js";
import { createToolCapability } from "../src/installer.js";

// Namespace access keeps this file compiling and loading before the implementation exists, so an absent export fails an assertion.
const api = services as Record<string, any>;
const TOOLS = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"];
const operation = { schemaVersion: 3 as const, scope: { kind: "machine" as const, machineId: "machine-1" }, idempotencyKey: "deepwiki-remote-test" };

describe("DeepWiki integration", () => {
  it("remote service defines the fixed HTTPS endpoint with three tools and no key", () => {
    expect(api.DEEPWIKI_MCP_ENDPOINT).toBe("https://mcp.deepwiki.com/mcp");
    expect(api.DEEPWIKI_SERVICE_ID).toBe("deepwiki");
    expect([...(api.DEEPWIKI_TOOLS ?? [])]).toEqual(TOOLS);
    expect(api.DEEPWIKI_TOOLS ?? []).not.toContain("ask_question");
    expect(typeof api.createDeepWikiRemoteService).toBe("function");

    const service = api.createDeepWikiRemoteService({ operation });
    expect(MCPServiceDefinitionSchema.safeParse(service).success).toBe(true);
    expect(service).toMatchObject({ serviceId: "deepwiki", connection: { kind: "native_remote_mcp", endpoint: "https://mcp.deepwiki.com/mcp", ownership: "external" },
      authentication: { mode: "none" }, tool: { toolId: "deepwiki", kind: "native_remote_mcp", operations: TOOLS,
        resource: { sharing: "concurrent", maxConcurrency: 16 }, required: false } });
    expect(service.connection.endpoint.startsWith("https://")).toBe(true);
    // No key, credential reference or bearer mode can be expressed, and the endpoint is not a parameter.
    expect(JSON.stringify(service)).not.toMatch(/secret:\/\/|credential|bearer|ctx7sk|api-key/i);
    expect(api.createDeepWikiRemoteService({ operation, required: true }).tool.required).toBe(true);
    expect(api.createDeepWikiRemoteService({ operation, endpoint: "https://evil.example.com/mcp", authenticated: true }).connection.endpoint).toBe("https://mcp.deepwiki.com/mcp");
    expect(api.createDeepWikiRemoteService({ operation, authenticated: true }).authentication).toEqual({ mode: "none" });

    // Read-only grants apply only to the exact hosted endpoint and tool identity.
    expect(api.trustedGatewayPolicy(service)).toEqual({ readOnlyTools: TOOLS });
    for (const endpoint of ["https://evil.example.com/mcp", "http://127.0.0.1:1/mcp", "https://mcp.deepwiki.com/other", "http://mcp.deepwiki.com/mcp"])
      expect(api.trustedGatewayPolicy({ ...service, connection: { kind: "native_remote_mcp", endpoint, ownership: "external" } }), endpoint).toBeUndefined();
    expect(api.trustedGatewayPolicy({ ...service, tool: { ...service.tool, toolId: "other" } })).toBeUndefined();

    expect(createToolCapability("deepwiki" as never, "hosted", "machine-1")).toMatchObject({ toolId: "deepwiki", kind: "native_remote_mcp", operations: TOOLS });
    // The retired service has no definition any more.
    for (const name of ["createContext7RemoteService", "CONTEXT7_MCP_ENDPOINT", "CONTEXT7_SERVICE_ID", "CONTEXT7_TOOLS", "CONTEXT7_API_KEY_SECRET_REF"]) expect(api[name], name).toBeUndefined();
  });
});
