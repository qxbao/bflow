import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digest, detectPlatform, defaultHostEnvironment } from "@bflow/machine-setup";
import { RuntimeHttpPolicySchema } from "@bflow/contracts";
import { EnvironmentConfigEnvironmentSchema, initializeEnvironmentConfig, readEnvironmentConfig } from "../src/environment-config.js";
import { identifyRepository } from "../src/repository.js";
import { parseConfigYaml, renderEnvironmentConfigYaml } from "../src/config-format.js";
import * as platform from "../src/platform-options.js";
import { loadMachineSkillCatalog } from "../src/skill-catalog.js";
import { loadExecutionResolution } from "../src/execution-preview.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-http-policy-")); roots.push(root);
  execFileSync("git", ["init", "--quiet", root]); await initializeEnvironmentConfig({ cwd: root });
  const repository = await identifyRepository(root), config = await readEnvironmentConfig(repository);
  const machineId = detectPlatform(defaultHostEnvironment()).machineId;
  const body = { schemaVersion: 3, repositoryId: repository.id, kind: "runtime_http", toolId: "qa-http", role: "qa",
    scope: { kind: "repository", machineId, repositoryId: repository.id, workspaceRoot: repository.root },
    origins: ["http://127.0.0.1:8123"], operations: ["http_read"] };
  const policy = RuntimeHttpPolicySchema.parse({ ...body, digest: digest(body) });
  return { root, machineId, repository, config, policy, input: { repository, config, env: {} } };
}
function resolver(name: string) { const value = Reflect.get(platform, name); expect(value).toBeTypeOf("function"); return value; }

describe("Runtime HTTP repository policy and startup grant admission", () => {
  it("retains explicit policy through strict environment parsing and configuration rendering without adding defaults", async () => {
    const f = await fixture(); expect(Reflect.get(EnvironmentConfigEnvironmentSchema.parse(f.config.environment), "runtimeHttpPolicy")).toBeUndefined();
    const environment = EnvironmentConfigEnvironmentSchema.parse({ ...f.config.environment, runtimeHttpPolicy: f.policy });
    const rendered = renderEnvironmentConfigYaml({ ...f.config, environment });
    expect(Reflect.get(EnvironmentConfigEnvironmentSchema.parse((parseConfigYaml(rendered) as any).environment), "runtimeHttpPolicy")).toEqual(f.policy);
  });

  it("binds a stable startup grant to exact repository policy and the actual host session, with no CLI/MCP identity", async () => {
    const f = await fixture(), read = resolver("resolveRuntimeHttpPolicy"), issue = resolver("resolveRuntimeHttpGrant");
    const input = { ...f.input, config: { ...f.config, environment: { ...f.config.environment, runtimeHttpPolicy: f.policy } } };
    const policy = read(input, f.machineId); expect(policy).toEqual(f.policy);
    const scope = { machineId: f.machineId, repositoryId: f.repository.id, workspaceRoot: f.root, sessionId: f.repository.sessionName };
    const grant = issue(policy, scope); expect(grant).toMatchObject({ kind: "runtime_http", toolId: "qa-http", role: "qa", policyDigest: f.policy.digest,
      origins: ["http://127.0.0.1:8123"], operations: ["http_read"], scope: { ...scope, kind: "session" } });
    expect(grant.serviceId).toBeUndefined(); expect(grant.cliIdentity).toBeUndefined(); expect(issue(policy, scope)).toEqual(grant);
    expect(issue(policy, { ...scope, sessionId: "another-host-session" }).grantId).not.toBe(grant.grantId);
    expect(read(f.input, f.machineId)).toBeUndefined(); expect(issue(undefined, scope)).toBeUndefined();
  });

  it("rejects altered policy digests and foreign repository/machine/workspace identities", async () => {
    const f = await fixture(), read = resolver("resolveRuntimeHttpPolicy"), issue = resolver("resolveRuntimeHttpGrant");
    const input = (policy: unknown) => ({ ...f.input, config: { ...f.config, environment: { ...f.config.environment, runtimeHttpPolicy: policy } } });
    expect(() => read(input({ ...f.policy, digest: "f".repeat(64) }), f.machineId)).toThrow(/digest/i);
    for (const change of [{ machineId: "another-machine" }, { repositoryId: "another-repo" }, { workspaceRoot: "/another-root" }]) {
      const bad = { ...f.policy, scope: { ...f.policy.scope, ...change } };
      expect(() => read(input(bad), f.machineId)).toThrow();
      expect(() => issue(f.policy, { machineId: f.machineId, repositoryId: f.repository.id, workspaceRoot: f.root,
        sessionId: f.repository.sessionName, ...change })).toThrow();
    }
  });

  it("carries Runtime grants separately in host options and fingerprints their policy in side-effect-free preview", async () => {
    const f = await fixture(); f.config.environment = EnvironmentConfigEnvironmentSchema.parse({ ...f.config.environment, runtimeHttpPolicy: f.policy });
    const context = { machineId: f.machineId, stateDirectory: join(f.root, "state"), dataDirectory: join(f.root, "data"),
      codexHomeDirectory: join(f.root, "codex"), codexProcessHomeDirectory: f.root, codexHookApprovalPath: join(f.root, "hooks.json"),
      skills: await loadMachineSkillCatalog() };
    const options = await platform.buildHostPlatformOptions(f.input, { context, fileExists: () => false });
    expect(Reflect.get(options, "runtimeHttpPolicy")).toEqual(f.policy);
    expect(Reflect.get(options, "runtimeHttpGrants")).toEqual([expect.objectContaining({ scope: expect.objectContaining({ sessionId: f.repository.sessionName }),
      operations: ["http_read"], kind: "runtime_http" })]);
    expect(options.toolGrants?.some(grant => grant.toolId === "qa-http") ?? false).toBe(false);
    for (const role of options.roles) expect(role.toolIds).not.toContain("qa-http");
    const first = await loadExecutionResolution(f.input);
    const { digest: _, ...body } = f.policy;
    f.config.environment.runtimeHttpPolicy = RuntimeHttpPolicySchema.parse({ ...body, origins: ["http://127.0.0.1:8124"],
      digest: digest({ ...body, origins: ["http://127.0.0.1:8124"] }) });
    const changed = await loadExecutionResolution(f.input);
    expect(changed.components.toolPolicy).not.toBe(first.components.toolPolicy);
  });
});
