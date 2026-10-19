import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEnvironmentSchema, type AgentEnvironment } from "@bflow/contracts";
import {
  CodexProviderAdapter, createFakeProviderRunner, createProviderExecutionProbeCoalescer,
  type ProviderAdapterOptions, trustAllCodexHooks, type ProviderCommandInvocation, type ProviderCommandOutcome, type ProviderCommandRunner
} from "../src/index.js";

let root: string;
let binary: string;
let home: string;
let workspace: string;
let state: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bflow-coalesce-"));
  binary = join(root, "codex");
  home = join(root, "home");
  workspace = join(root, "workspace");
  state = join(root, "state");
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(workspace, { mode: 0o700 }), mkdir(state, { mode: 0o700 })]);
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(home, "config.toml"), 'model = "gpt-6-luna"\n', { mode: 0o600 });
  await writeFile(join(home, "auth.json"), '{"account":"synthetic-account"}\n', { mode: 0o600 });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function environment(role: "conversation" | "reviewer" = "conversation"): AgentEnvironment {
  const scope = { kind: "session", machineId: "machine", repositoryId: "repo", workspaceRoot: workspace, sessionId: "session" };
  return AgentEnvironmentSchema.parse({
    schemaVersion: 3, environmentId: `env-${role}`, provider: "codex", role, scope, cwd: workspace,
    stateDirectory: state, configFingerprint: (role === "conversation" ? "a" : "b").repeat(64),
    permissionProfile: { schemaVersion: 3, profileId: `perm-${role}`, mode: "workspace_auto", scope,
      filesystem: "workspace_write", readableRoots: [workspace], writableRoots: [workspace], deniedRoots: [],
      isolation: "provider_policy", network: { mode: "deny", allowedHosts: [] }, allowedTools: [],
      deniedAction: "request_via_conversation", allowGlobalPermissionBypass: false },
    environmentVariables: {}, secretBindings: {}, requiredCapabilityIds: [], requiredMcpServiceIds: [],
    skillManifestDigest: "0".repeat(64)
  });
}

function harness(settings: { probeOutcome?: ProviderCommandOutcome; differentAccounts?: boolean } = {}) {
  let probes = 0;
  let authentications = 0;
  const commands: ProviderCommandInvocation[] = [];
  const fake = createFakeProviderRunner();
  const runner: ProviderCommandRunner = { run: async invocation => {
    commands.push(invocation);
    if (invocation.args.includes("ping")) {
      probes++;
      // Simulate an external model request so other roles may arrive while it is in flight.
      await new Promise(resolve => setTimeout(resolve, 100));
      if (settings.probeOutcome) return settings.probeOutcome;
    }
    if (invocation.args.join(" ") === "login status") {
      authentications++;
      if (settings.differentAccounts) return { exitCode: 0, started: true, stdout: `Account ${authentications}`, stderr: "" };
    }
    return fake.run(invocation);
  } };
  const coalescer = createProviderExecutionProbeCoalescer({ runner });
  const adapter = (options: ProviderAdapterOptions = {}) => new CodexProviderAdapter({
    runner, executablePath: binary, codexHomeDirectory: home,
    codexHookEnvironment: { HOME: root, PATH: process.env["PATH"] ?? "" },
    codexHookApprovalPath: join(root, "approvals.json"), model: "gpt-6-luna", effort: "low",
    executionProbeCoalescer: coalescer, ...options
  });
  const health = (role: "conversation" | "reviewer", options: ProviderAdapterOptions = {}, env = environment(role)) => adapter(options).checkHealth({
    schemaVersion: 3, environment: env, stage: "preflight", requestedAt: new Date().toISOString()
  });
  return { health, commands, get probes() { return probes; }, get authentications() { return authentications; } };
}

describe("Codex readiness execution ping sharing", () => {
  it("reduces overlapping roles to one ping while each retains its own authentication and health", async () => {
    const h = harness();
    const [conversation, reviewer] = await Promise.all([h.health("conversation"), h.health("reviewer")]);
    expect(conversation.ok && conversation.value.status, JSON.stringify(conversation)).toBe("ready");
    expect(reviewer.ok && reviewer.value.status).toBe("ready");
    expect(conversation.ok && conversation.value.role).toBe("conversation");
    expect(reviewer.ok && reviewer.value.role).toBe("reviewer");
    expect(h.authentications).toBe(2);
    expect(h.probes).toBe(1);
  });

  it.each(["model", "effort", "cwd", "environment", "session", "binary"] as const)("keeps different %s contexts separate", async field => {
    const h = harness();
    const changed = environment("reviewer");
    let options: ProviderAdapterOptions = {};
    if (field === "model") options = { model: "another-model" };
    if (field === "effort") options = { effort: "high" };
    if (field === "cwd") { changed.cwd = join(workspace, "worktree"); await mkdir(changed.cwd); }
    if (field === "environment") changed.environmentVariables = { BUILD_ENV: "other" };
    if (field === "session") {
      changed.scope = { ...changed.scope, sessionId: "other-session" };
      changed.permissionProfile.scope = changed.scope;
    }
    if (field === "binary") {
      const alternate = join(root, "other-codex");
      await writeFile(alternate, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      options = { executablePath: alternate };
    }
    const results = await Promise.all([h.health("conversation"), h.health("reviewer", options, changed)]);
    expect(results.every(result => result.ok && result.value.status === "ready")).toBe(true);
    expect(h.probes).toBe(2);
  });

  it.each(["config.toml", "auth.json", "hooks.json"])("does not share across changed %s observations", async file => {
    const h = harness();
    const first = h.health("conversation");
    await expect.poll(() => h.probes).toBe(1);
    await writeFile(join(home, file), file === "config.toml" ? 'model = "new-model"\n' : file === "hooks.json" ? '{"hooks":{}}\n' : "{}\n", { mode: 0o600 });
    const second = h.health("reviewer");
    const results = await Promise.all([first, second]);
    expect(results[0]!.ok && results[0]!.value.status).toBe("blocked");
    expect(results[1]!.ok && results[1]!.value.status).toBe("ready");
    expect(h.probes).toBe(2);
  });

  it("keeps each role's environment permission check fresh even when pings share", async () => {
    const h = harness();
    const insecure = join(root, "insecure");
    await mkdir(insecure, { mode: 0o700 });
    await chmod(insecure, 0o755);
    const changed = environment("reviewer");
    changed.stateDirectory = insecure;
    const [first, second] = await Promise.all([h.health("conversation"), h.health("reviewer", {}, changed)]);
    expect(first.ok && first.value.status).toBe("ready");
    expect(second.ok && second.value.status).toBe("blocked");
    expect(second.ok && second.value.checks.some(check => check.code === "environment_insecure")).toBe(true);
    expect(h.probes).toBe(1);
  });
  it("keeps different freshly observed accounts separate", async () => {
    const h = harness({ differentAccounts: true });
    const results = await Promise.all([h.health("conversation"), h.health("reviewer")]);
    expect(results.every(result => result.ok && result.value.status === "ready")).toBe(true);
    expect(h.probes).toBe(2);
  });

  it.each(["missing-config", "missing-auth", "symlink-auth", "trust-all"])("falls back to separate probes for %s", async unavailable => {
    if (unavailable === "missing-config") await rm(join(home, "config.toml"));
    if (unavailable === "missing-auth") await rm(join(home, "auth.json"));
    if (unavailable === "symlink-auth") {
      await rm(join(home, "auth.json"));
      const alternate = join(root, "account.json");
      await writeFile(alternate, "{}\n", { mode: 0o600 });
      await symlink(alternate, join(home, "auth.json"));
    }
    if (unavailable === "trust-all") await trustAllCodexHooks({
      codexHomeDirectory: home, approvalStorePath: join(root, "approvals.json"),
      environment: { HOME: root, PATH: process.env["PATH"] ?? "" }, approvedBy: "operator"
    });
    const h = harness();
    const results = await Promise.all([h.health("conversation"), h.health("reviewer")]);
    expect(results.every(result => result.ok && result.value.status === "ready")).toBe(true);
    expect(h.probes).toBe(2);
  });

  it("does not accept an execution failure marked with a zero exit code", async () => {
    const h = harness({ probeOutcome: { exitCode: 0, started: true, stdout: "partial", stderr: "timed out", failure: "timeout" } });
    const results = await Promise.all([h.health("conversation"), h.health("reviewer")]);
    expect(results.every(result => result.ok && result.value.status === "blocked")).toBe(true);
    expect(h.probes).toBe(2);
  });

});
