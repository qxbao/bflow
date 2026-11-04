import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeHttpGrantSchema, RuntimeHttpPolicySchema } from "@bflow/contracts";
import * as runtime from "../../src/index.js";
import { createExecutionResolutionReader } from "../../src/agentic/execution-binding.js";

const scope = { machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/workspace/repo-1", sessionId: "herdr-session" };
const body = { schemaVersion: 3, kind: "runtime_http", toolId: "qa-http", role: "qa", repositoryId: scope.repositoryId,
  scope: { kind: "repository", machineId: scope.machineId, repositoryId: scope.repositoryId, workspaceRoot: scope.workspaceRoot },
  origins: ["http://127.0.0.1:8123"], operations: ["http_read"] };
const policy = RuntimeHttpPolicySchema.parse({ ...body, digest: runtime.canonicalPlanDigest(body) });
const grant = RuntimeHttpGrantSchema.parse({ schemaVersion: 3, kind: "runtime_http", toolId: "qa-http", role: "qa", grantId: "runtime-read-1",
  scope: { kind: "session", ...scope }, policyDigest: policy.digest, origins: body.origins, operations: body.operations });
const action = { runId: "run-1", toolId: "qa-http", action: "http_read", origin: "http://127.0.0.1:8123" };
function factory() { const value = Reflect.get(runtime, "createRuntimeHttpAuthority"); expect(value).toBeTypeOf("function"); return value; }

describe("host Runtime HTTP grant authority", () => {
  it.each(["removed", "malformed", "elevated"] as const)("revokes the pinned grant when real owner configuration is %s", async change => {
    const root = await mkdtemp(join(tmpdir(), "runtime-http-config-"));
    try {
      const path = join(root, "config.json"); await writeFile(path, JSON.stringify({ runtimeHttpPolicy: policy }));
      const read = await createExecutionResolutionReader({ schemaVersion: 3,
        plan: { schemaVersion: 3, resolverVersion: "1", policyVersion: "1", repository: { revision: "fixture" }, mode: "intake" },
        files: [{ component: "configuration", path, format: "json" }] });
      const authorize = factory()({ ...scope, policy, grants: [grant], revalidate: async () => { await read(); } });
      await authorize(action);
      await writeFile(path, change === "malformed" ? "{" : JSON.stringify(change === "removed" ? {} : {
        runtimeHttpPolicy: { ...policy, operations: ["http_read", "http_mutate"] } }));
      await expect(authorize(action)).rejects.toMatchObject({ code: "execution_plan_drift" });
      await expect(authorize({ ...action, action: "http_mutate" })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("allows only the pinned origin and operation under exact host session/repository/machine authority", async () => {
    const create = factory(), authorize = create({ ...scope, policy, grants: [grant], revalidate: async () => {} });
    await expect(authorize(action)).resolves.toBeUndefined();
    for (const change of [{ action: "http_mutate" }, { origin: "http://127.0.0.1:8124" }, { origin: "http://127.0.0.1:8123/path" },
      { toolId: "browser" }, { action: "shell" }]) await expect(authorize({ ...action, ...change })).rejects.toThrow();
    for (const bad of [{ sessionId: "conversation-session" }, { machineId: "machine-2" }, { repositoryId: "repo-2" }, { workspaceRoot: "/another" }])
      await expect(create({ ...scope, ...bad, policy, grants: [grant], revalidate: async () => {} })(action)).rejects.toThrow();
  });

  it("fails closed without policy, current watcher or grant and does not accept a CLI/MCP stand-in", async () => {
    const create = factory();
    for (const input of [{ policy: undefined, grants: [] }, { policy, grants: [] }, { policy, grants: [grant], revalidate: undefined }])
      await expect(create({ ...scope, revalidate: async () => {}, ...input })(action)).rejects.toThrow();
    expect(() => create({ ...scope, policy, grants: [{ ...grant, kind: "stdio_mcp", serviceId: "qa-http" }], revalidate: async () => {} })).toThrow();
  });

  it("rejects copied digests, broadened grants and multiple ambiguous grants before revalidation", async () => {
    const create = factory();
    const widened = [{ ...grant, policyDigest: "f".repeat(64) }, { ...grant, origins: [...grant.origins, "https://outside.test"] },
      { ...grant, operations: ["http_read", "http_mutate"] }, { ...grant, scope: { ...grant.scope, sessionId: "wrong" } }];
    for (const candidate of widened) {
      const authorize = create({ ...scope, policy, grants: [candidate], revalidate: async () => { throw new Error("must not consult current policy for foreign grant"); } });
      await expect(authorize(action)).rejects.toThrow(/grant|scope|authority|policy/i);
    }
    await expect(create({ ...scope, policy: { ...policy, digest: "f".repeat(64) }, grants: [grant], revalidate: async () => {} })(action)).rejects.toThrow(/digest|policy/i);
    await expect(create({ ...scope, policy, grants: [grant, { ...grant, grantId: "duplicate-authority" }], revalidate: async () => {} })(action)).rejects.toThrow(/ambiguous|grant/i);
  });

  it("rechecks the pinned owner policy every time and never adopts a broader replacement after revocation", async () => {
    let current = true;
    const authorize = factory()({ ...scope, policy, grants: [grant], revalidate: async () => { if (!current) throw new Error("runtime_http_policy_drift"); } });
    await authorize(action); current = false;
    await expect(authorize(action)).rejects.toThrow("runtime_http_policy_drift");
    await expect(authorize({ ...action, action: "http_mutate" })).rejects.toThrow();
  });
});
