import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMemPalaceService, trustedGatewayPolicy } from "../src/services.js";

it("declares scoped search read-only only for the managed memory launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "bflow-memory-policy-"));
  try {
    const service = await createMemPalaceService({ executable: process.execPath, version: "3.11.0",
      stateRoot: join(root, "state"), configRoot: join(root, "config"),
      operation: { schemaVersion: 3, scope: { kind: "machine", machineId: "machine" }, idempotencyKey: "memory-policy" } });
    expect(trustedGatewayPolicy(service)).toEqual({ readOnlyTools: ["mempalace_search"] });
    if (service.connection.kind !== "stdio_mcp") throw new Error("Expected managed stdio service");
    expect(trustedGatewayPolicy({ ...service, connection: { ...service.connection, argv: ["/unapproved/launcher"] } })).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
