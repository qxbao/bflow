import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createFakeProviderRunner } from "@bflow/agent-providers";
import { probeConfiguredProviderModels } from "../../src/agentic/provider-model-diagnostics.js";
import { AgenticHostPlatformOptionsSchema } from "../../src/platform/host-options.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("explicitly executes each required provider/profile/model once without launching roles", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-deep-model-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "codex"), binary = join(root, "provider");
  await mkdir(home, { mode: 0o700 });
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const invocations: { args: readonly string[]; env?: Readonly<Record<string, string>> }[] = [];
  const runner = createFakeProviderRunner({ customHandler: invocation => {
    invocations.push(invocation);
    return invocation.args.includes("ping") && invocation.args.includes("quota-model")
      ? { exitCode: 1, started: true, stdout: "", stderr: "ERROR: quota exhausted" } : undefined;
  } });
  const platform = AgenticHostPlatformOptionsSchema.parse({
    schemaVersion: 3, machineId: "machine", repositoryId: "repo", skillsStoreRoot: join(root, "skills"),
    approvedBuiltinSkillDigests: [], codexHomeDirectory: home, codexHookApprovalPath: join(root, "approvals.json"),
    roles: ["conversation", "coordinator", "reviewer", "qa"].map((role, index) => ({
      role, provider: "codex", required: index < 3, model: index < 2 ? "valid-model" : "quota-model",
      permissionMode: "restricted", capabilityIds: [], mcpServiceIds: [], toolIds: [], skillSelections: []
    }))
  });
  const results = await probeConfiguredProviderModels({
    platform, workspaceRoot: root, sessionId: "diagnostic-session", environment: { HOME: root, PATH: process.env.PATH }
  }, undefined, { factoryOptions: { runner, perProvider: { codex: { executablePath: binary } } } });
  expect(results.map(result => result.status)).toEqual(["ready", "blocked"]);
  expect(results[1]?.checks.find(check => check.check === "authentication")?.message).toContain("quota exhausted");
  const probes = invocations.filter(invocation => invocation.args.includes("ping"));
  expect(probes).toHaveLength(2);
  expect(probes.map(probe => probe.args[probe.args.indexOf("--model") + 1])).toEqual(["valid-model", "quota-model"]);
  expect(invocations.some(invocation => invocation.args.includes("agent") || invocation.args.includes("server"))).toBe(false);
});

it("never substitutes ambient credentials when a selected profile cannot be resolved", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-deep-profile-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let executions = 0;
  const platform = AgenticHostPlatformOptionsSchema.parse({
    schemaVersion: 3, machineId: "machine", repositoryId: "repo", skillsStoreRoot: root, approvedBuiltinSkillDigests: [],
    roles: ["conversation", "coordinator"].map(role => ({ role, provider: "claude", profileName: "missing",
      required: true, permissionMode: "restricted", capabilityIds: [], mcpServiceIds: [], toolIds: [], skillSelections: [] }))
  });
  const results = await probeConfiguredProviderModels({ platform, workspaceRoot: root, sessionId: "test" }, undefined, {
    factoryOptions: { runner: { run: async () => { executions++; throw new Error("must not execute"); } } },
    profiles: { resolve: async () => ({ ok: false, error: { code: "validation", retryable: false, message: "Selected profile missing" } }) }
  });
  expect(executions).toBe(0);
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ status: "error", message: "Selected profile missing" });
});
