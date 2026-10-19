import { describe, expect, it } from "vitest";
import { MCPServiceDefinitionSchema } from "@bflow/contracts";
import { CONTEXT7_API_KEY_SECRET_REF, CONTEXT7_MCP_ENDPOINT, CONTEXT7_SERVICE_ID, createContext7RemoteService, trustedGatewayPolicy } from "../src/services.js";
import { createToolCapability } from "../src/installer.js";

const operation = { schemaVersion: 3 as const, scope: { kind: "machine" as const, machineId: "machine-1" }, idempotencyKey: "context7-remote-test" };

describe("hosted Context7 service definition", () => {
  it("is a remote, shared, concurrent service on the fixed hosted endpoint with no local process", () => {
    const service = createContext7RemoteService({ operation, authenticated: false });
    expect(MCPServiceDefinitionSchema.safeParse(service).success).toBe(true);
    expect(service).toMatchObject({ serviceId: CONTEXT7_SERVICE_ID, connection: { kind: "native_remote_mcp", endpoint: CONTEXT7_MCP_ENDPOINT, ownership: "external" },
      authentication: { mode: "none" }, tool: { toolId: "context7", kind: "native_remote_mcp", operations: ["resolve-library-id", "query-docs"],
        resource: { sharing: "concurrent", maxConcurrency: 16 }, required: false } });
    expect(CONTEXT7_MCP_ENDPOINT).toBe("https://mcp.context7.com/mcp");
  });

  it("authenticates with a secret reference, never a value", () => {
    const service = createContext7RemoteService({ operation, authenticated: true });
    expect(service.authentication).toEqual({ mode: "bearer", credential: CONTEXT7_API_KEY_SECRET_REF });
    expect(JSON.stringify(service)).not.toMatch(/ctx7sk/);
    expect(createContext7RemoteService({ operation, authenticated: true, required: true }).tool.required).toBe(true);
  });

  it("declares the two tools read-only only for the exact hosted endpoint", () => {
    const hosted = createContext7RemoteService({ operation, authenticated: false });
    expect(trustedGatewayPolicy(hosted)).toEqual({ readOnlyTools: ["resolve-library-id", "query-docs"] });
    expect(trustedGatewayPolicy({ ...hosted, connection: { kind: "native_remote_mcp", endpoint: "https://evil.example.com/mcp", ownership: "external" } })).toBeUndefined();
    expect(trustedGatewayPolicy({ ...hosted, tool: { ...hosted.tool, toolId: "other" } })).toBeUndefined();
    expect(trustedGatewayPolicy({ ...hosted, connection: { kind: "native_remote_mcp", endpoint: "http://127.0.0.1:1/mcp", ownership: "external" } })).toBeUndefined();
  });

  it("describes the capability for catalogs and inventories", () => {
    expect(createToolCapability("context7", "hosted", "machine-1")).toMatchObject({ kind: "native_remote_mcp", operations: ["resolve-library-id", "query-docs"] });
  });
});
