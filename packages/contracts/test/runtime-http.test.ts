import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

const repository = { kind: "repository", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/workspace/repo-1" };
const policy = { schemaVersion: 3, kind: "runtime_http", toolId: "qa-http", role: "qa", repositoryId: "repo-1",
  scope: repository, digest: "a".repeat(64), origins: ["http://127.0.0.1:8123"], operations: ["http_read"] };
const grant = { schemaVersion: 3, kind: "runtime_http", toolId: "qa-http", role: "qa", grantId: "grant-1",
  scope: { ...repository, kind: "session", sessionId: "herdr-session-1" }, policyDigest: "a".repeat(64),
  origins: ["http://127.0.0.1:8123"], operations: ["http_read"] };
function schema(name: string) {
  const value = Reflect.get(contracts, name);
  expect(value, "Runtime HTTP authority requires a dedicated exported contract").toBeDefined();
  return value;
}

describe("Runtime HTTP authority contracts", () => {
  it("keeps repository desired policy distinct from the resolved session grant", () => {
    const desired = schema("RuntimeHttpPolicySchema"), resolved = schema("RuntimeHttpGrantSchema");
    expect(desired.parse(policy)).toEqual(policy); expect(resolved.parse(grant)).toEqual(grant);
    expect(desired.safeParse(grant).success).toBe(false); expect(resolved.safeParse(policy).success).toBe(false);
    expect(desired.safeParse({ ...policy, scope: grant.scope }).success).toBe(false);
    expect(desired.safeParse({ ...policy, repositoryId: "another-repo" }).success).toBe(false);
    expect(resolved.safeParse({ ...grant, scope: repository }).success).toBe(false);
  });

  it("rejects unapproved versions, provider roles, tool identities and invented CLI/MCP authority", () => {
    const desired = schema("RuntimeHttpPolicySchema"), resolved = schema("RuntimeHttpGrantSchema");
    for (const base of [policy, grant]) {
      const current = "grantId" in base ? resolved : desired;
      for (const bad of [{ ...base, schemaVersion: 2 }, { ...base, schemaVersion: 4 }, { ...base, role: "tester" },
        { ...base, kind: "stdio_mcp" }, { ...base, toolId: "browser" }, { ...base, serviceId: "pretend-http" },
        { ...base, cliIdentity: { executablePath: "/usr/bin/node", version: "22", digest: "b".repeat(64) } },
        { ...base, scope: { kind: "machine", machineId: "machine-1" } }])
        expect(current.safeParse(bad).success).toBe(false);
    }
  });

  it("accepts only exact normalized HTTP origins and rejects wildcard, credential and duplicate origins", () => {
    const resolved = schema("RuntimeHttpGrantSchema");
    for (const origin of ["https://example.test", "http://localhost:8123", "http://[::1]:8123"])
      expect(resolved.safeParse({ ...grant, origins: [origin] }).success).toBe(true);
    for (const origins of [[], ["*"], ["https://*.example.test"], ["https://user:secret@example.test"], ["https://example.test/"],
      ["https://example.test/path"], ["https://example.test?x=1"], ["file:///tmp/source"], ["http://127.0.0.1:08123"],
      ["https://example.test#fragment"], ["http://127.0.0.1:8123", "http://127.0.0.1:8123"]])
      expect(resolved.safeParse({ ...grant, origins }).success).toBe(false);
  });

  it("never derives HTTP writes or other tools from empty, duplicate or unknown operations", () => {
    const resolved = schema("RuntimeHttpGrantSchema");
    expect(resolved.safeParse({ ...grant, operations: ["http_read", "http_mutate"] }).success).toBe(true);
    for (const operations of [[], ["http_read", "http_read"], ["browser_navigate"], ["shell"], ["*"]])
      expect(resolved.safeParse({ ...grant, operations }).success).toBe(false);
  });

  it("leaves legacy CLI/MCP admission unchanged and refuses treating the new grant as either", () => {
    const resolved = schema("RuntimeHttpGrantSchema"); expect(resolved.safeParse(grant).success).toBe(true);
    expect(contracts.ResolvedToolGrantSchema.safeParse(grant).success).toBe(false);
    expect(contracts.ToolKindSchema.safeParse("runtime_http").success).toBe(false);
    expect(contracts.ResolvedToolGrantSchema.safeParse({ schemaVersion: 3, grantId: "legacy-cli", policyDigest: "a".repeat(64),
      toolId: "rtk", role: "developer", scope: grant.scope, kind: "cli_only", requiredness: "optional", triggers: ["routine_command"],
      operations: ["pipe"], cliIdentity: { executablePath: "/opt/rtk", version: "1", digest: "b".repeat(64) } }).success).toBe(true);
  });
});
