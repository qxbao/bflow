import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEnvironmentSchema, type AgentEnvironment } from "@bflow/contracts";
import {
  CodexProviderAdapter, createFakeProviderRunner, createProviderExecutionProbeCoalescer, createSignedLaunchAttestation,
  type ProviderAdapterOptions, trustAllCodexHooks, type ProviderCommandInvocation, type ProviderCommandOutcome, type ProviderCommandRunner
} from "../src/index.js";

let root: string;
let binary: string;
let home: string;
let workspace: string;
let state: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "bflow-coalesce-")));
  binary = join(root, "codex");
  home = join(root, "home");
  workspace = join(root, "workspace");
  state = join(root, "state");
  await Promise.all([mkdir(home, { mode: 0o700 }), mkdir(workspace, { mode: 0o700 }), mkdir(state, { mode: 0o700 })]);
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await writeFile(join(home, "config.toml"), 'model = "gpt-6-luna"\n', { mode: 0o600 });
  await writeFile(join(home, "auth.json"), '{"account":"synthetic-account"}\n', { mode: 0o600 });
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

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

function harness(settings: { probeOutcome?: ProviderCommandOutcome; differentAccounts?: boolean; successfulResultTtlMs?: number; executionOutcome?: () => Promise<ProviderCommandOutcome | undefined> } = {}) {
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
      if (settings.executionOutcome) {
        const outcome = await settings.executionOutcome();
        if (outcome !== undefined) return outcome;
      }
      if (settings.probeOutcome) return settings.probeOutcome;
    }
    if (invocation.args.join(" ") === "login status") {
      authentications++;
      if (settings.differentAccounts) return { exitCode: 0, started: true, stdout: `Account ${authentications}`, stderr: "" };
    }
    return fake.run(invocation);
  } };
  const coalescer = createProviderExecutionProbeCoalescer({ runner, ...(settings.successfulResultTtlMs !== undefined ? { successfulResultTtlMs: settings.successfulResultTtlMs } : {}) });
  const adapter = (options: ProviderAdapterOptions = {}) => new CodexProviderAdapter({
    runner, executablePath: binary, codexHomeDirectory: home,
    codexHookEnvironment: { HOME: root, PATH: process.env["PATH"] ?? "" },
    codexHookApprovalPath: join(root, "approvals.json"), model: "gpt-6-luna", effort: "low",
    executionProbeCoalescer: coalescer, ...options
  });
  const health = (role: "conversation" | "reviewer", options: ProviderAdapterOptions = {}, env = environment(role)) => adapter(options).checkHealth({
    schemaVersion: 3, environment: env, stage: "preflight", requestedAt: new Date().toISOString()
  });
  return { adapter, health, commands, get probes() { return probes; }, get authentications() { return authentications; } };
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


describe("Codex successful completed model ping reuse", () => {
  it("reuses only the execution probe while checking authentication and each role's permissions freshly", async () => {
    const h = harness({ successfulResultTtlMs: 30_000 });
    const first = await h.health("conversation");
    expect(first.ok && first.value.status).toBe("ready");
    const second = await h.health("reviewer");
    expect(second.ok && second.value.status).toBe("ready");
    expect(second.ok && second.value.role).toBe("reviewer");
    expect(h.authentications).toBe(2);
    expect(h.probes).toBe(1);
    await chmod(state, 0o755);
    const blocked = await h.health("reviewer");
    expect(blocked.ok && blocked.value.status).toBe("blocked");
    expect(blocked.ok && blocked.value.checks.some(check => check.code === "environment_insecure")).toBe(true);
    expect(h.authentications).toBe(3);
    expect(h.probes).toBe(1);
  });

  it("checks native launch readiness again after successful activated health while reusing only the model ping", async () => {
    const h = harness({ successfulResultTtlMs: 30_000 });
    await h.health("conversation");
    const keys = generateKeyPairSync("ed25519");
    const nativeSession = { source: "codex", kind: "id" as const, value: "native-session" };
    const live = { paneId: "pane", nativeSession, transportState: "idle" as const, interactiveReady: true };
    const adapter = h.adapter({ liveObservation: live,
      trustedIssuerKeys: { test: keys.publicKey.export({ type: "spki", format: "pem" }).toString() } });
    const env = environment();
    const launch = await adapter.prepareLaunch(env);
    expect(launch.ok, JSON.stringify(launch)).toBe(true);
    if (!launch.ok) throw new Error("launch preparation failed");
    const attestation = createSignedLaunchAttestation({ receiptId: "receipt", issuerId: "test",
      launchId: launch.value.launchId, launchFingerprint: launch.value.launchFingerprint, sessionId: "session", paneId: "pane", nativeSession,
      observedAt: new Date().toISOString(), privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    const request = { schemaVersion: 3 as const, environment: env, stage: "activated" as const,
      launchProfile: launch.value, launchAttestation: attestation, requestedAt: new Date().toISOString() };
    const ready = await adapter.checkHealth(request);
    expect(ready.ok && ready.value.status, JSON.stringify(ready)).toBe("ready");
    live.interactiveReady = false;
    const blocked = await adapter.checkHealth(request);
    expect(blocked.ok && blocked.value.status).toBe("blocked");
    expect(blocked.ok && blocked.value.checks.some(check => check.code === "native_binding_not_interactive_ready")).toBe(true);
    expect(h.authentications).toBe(3);
    expect(h.probes).toBe(1);
  });

  it.each(["config.toml", "auth.json", "hooks.json", "binary", "instructions", "session", "environment", "account"])(
    "runs a fresh execution probe after completed %s snapshot changes", async field => {
      const h = harness({ successfulResultTtlMs: 30_000, differentAccounts: field === "account" });
      const first = await h.health("conversation");
      expect(first.ok && first.value.status).toBe("ready");
      const changed = environment("reviewer");
      if (field === "binary") await writeFile(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      else if (field === "instructions") await writeFile(join(workspace, "AGENTS.md"), "new instructions\n");
      else if (field === "session") {
        changed.scope = { ...changed.scope, sessionId: "second-session" };
        changed.permissionProfile.scope = changed.scope;
      } else if (field === "environment") changed.environmentVariables = { BUILD_ENV: "new" };
      else if (field !== "account") await writeFile(join(home, field), field === "config.toml" ? 'model = "changed"\n' : field === "hooks.json" ? '{"hooks":{}}\n' : '{"account":"changed"}\n', { mode: 0o600 });
      const second = await h.health("reviewer", {}, changed);
      expect(second.ok && second.value.status, JSON.stringify(second)).toBe("ready");
      expect(h.probes).toBe(2);
    }
  );

  it("expires completed execution reuse after 30 seconds without caching full health", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const h = harness({ successfulResultTtlMs: 30_000 });
    await h.health("conversation");
    now = 29_999;
    await h.health("reviewer");
    expect(h.probes).toBe(1);
    now = 30_000;
    await h.health("reviewer");
    expect(h.probes).toBe(2);
    expect(h.authentications).toBe(3);
  });
});


describe("Codex config-selected model probe dependencies", () => {
  function dependencyOutcome(path: string) {
    return async (): Promise<ProviderCommandOutcome | undefined> => {
      try { if (await readFile(path, "utf8") === "allowed\n") return undefined; } catch { /* Provider cannot load required input. */ }
      return { exitCode: 1, started: true, stdout: "", stderr: "instruction input unavailable" };
    };
  }

  it.each(["global", "profile", "project"] as const)("invalidates %s model_instructions_file content and removal with unchanged config", async layer => {
    const instructions = join(root, "external-instructions.md");
    await writeFile(instructions, "allowed\n", { mode: 0o600 });
    const config = layer === "project" ? join(workspace, ".codex", "config.toml") : join(home, "config.toml");
    if (layer === "project") await mkdir(join(workspace, ".codex"), { mode: 0o700 });
    await writeFile(config, `${layer === "profile" ? 'profile = "team"\n[profiles.team]\n' : ""}model_instructions_file = ${JSON.stringify(instructions)}\n`, { mode: 0o600 });
    const h = harness({ successfulResultTtlMs: 30_000, executionOutcome: dependencyOutcome(instructions) });
    expect((await h.health("conversation")).ok).toBe(true);
    const unchanged = await h.health("reviewer");
    expect(unchanged.ok && unchanged.value.status).toBe("ready");
    expect(h.probes).toBe(1);
    await writeFile(instructions, "changed\n", { mode: 0o600 });
    const changed = await h.health("reviewer");
    expect(changed.ok && changed.value.status).toBe("blocked");
    expect(h.probes).toBe(2);
    await writeFile(instructions, "allowed\n", { mode: 0o600 });
    const restored = await h.health("conversation");
    expect(restored.ok && restored.value.status).toBe("ready");
    await rm(instructions);
    const missing = await h.health("reviewer");
    expect(missing.ok && missing.value.status).toBe("blocked");
    expect(h.probes).toBe(4);
  });

  it.each(["global", "profile", "project"] as const)("tracks %s project_doc_fallback_filenames through creation and change", async layer => {
    const config = layer === "project" ? join(workspace, ".codex", "config.toml") : join(home, "config.toml");
    if (layer === "project") await mkdir(join(workspace, ".codex"), { mode: 0o700 });
    await writeFile(config, `${layer === "profile" ? 'profile = "team"\n[profiles.team]\n' : ""}project_doc_fallback_filenames = ["CUSTOM.instructions.md"]\n`, { mode: 0o600 });
    const h = harness({ successfulResultTtlMs: 30_000 });
    await h.health("conversation");
    await h.health("reviewer");
    expect(h.probes).toBe(1);
    const document = join(workspace, "CUSTOM.instructions.md");
    await writeFile(document, "first\n", { mode: 0o600 });
    await h.health("reviewer");
    expect(h.probes).toBe(2);
    await writeFile(document, "second\n", { mode: 0o600 });
    await h.health("reviewer");
    expect(h.probes).toBe(3);
  });

  it.each(["global", "profile", "project"] as const)("invalidates removed %s fallback documents without changing config", async layer => {
    const config = layer === "project" ? join(workspace, ".codex", "config.toml") : join(home, "config.toml");
    if (layer === "project") await mkdir(join(workspace, ".codex"), { mode: 0o700 });
    await writeFile(config, `${layer === "profile" ? 'profile = "team"\n[profiles.team]\n' : ""}project_doc_fallback_filenames = ["CUSTOM.instructions.md"]\n`, { mode: 0o600 });
    const document = join(workspace, "CUSTOM.instructions.md");
    await writeFile(document, "allowed\n", { mode: 0o600 });
    const h = harness({ successfulResultTtlMs: 30_000, executionOutcome: dependencyOutcome(document) });
    const first = await h.health("conversation");
    expect(first.ok && first.value.status).toBe("ready");
    await rm(document);
    const second = await h.health("reviewer");
    expect(second.ok && second.value.status).toBe("blocked");
    expect(h.probes).toBe(2);
  });

  it.each([
    'model_instructions_file = "relative-instructions.md"',
    '[profiles.team]\nmodel_instructions_file = "../instructions.md"',
    'model_instructions_file = 42',
    'project_doc_fallback_filenames = ["../outside.md"]',
    '[profiles.team]\nproject_doc_fallback_filenames = ["docs/instructions.md"]'
  ])("uses individual pings when config dependencies are ambiguous: %s", async config => {
    await writeFile(join(home, "config.toml"), config + "\n", { mode: 0o600 });
    const h = harness({ successfulResultTtlMs: 30_000 });
    const results = await Promise.all([h.health("conversation"), h.health("reviewer")]);
    expect(results.every(result => result.ok && result.value.status === "ready")).toBe(true);
    expect(h.probes).toBe(2);
    await h.health("reviewer");
    expect(h.probes).toBe(3);
  });

  it.each([
    'experimental_instructions_file = "/unobserved/legacy.md"',
    'model_catalog_json = "/unobserved/models.json"',
    '[profiles.team]\nmodel_catalog_json = "/unobserved/models.json"',
    'future_input_file = "/unobserved/input.md"',
    '[profiles.team]\nfuture_document_path = "../instructions.md"',
    '[experimental]\nfile_input = "/unobserved/input.md"'
  ])("does not assume an unfamiliar file selector is self-contained: %s", async config => {
    await writeFile(join(home, "config.toml"), config + "\n", { mode: 0o600 });
    const h = harness({ successfulResultTtlMs: 30_000 });
    const results = await Promise.all([h.health("conversation"), h.health("reviewer")]);
    expect(results.every(result => result.ok && result.value.status === "ready")).toBe(true);
    expect(h.probes).toBe(2);
    await h.health("reviewer");
    expect(h.probes).toBe(3);
  });

  it.each(["missing", "symlink", "directory", "home-directory"] as const)("does not coalesce an unsafe %s required instruction dependency", async kind => {
    const instructions = kind === "home-directory" ? home : join(root, "required.md");
    if (kind === "directory") await mkdir(instructions);
    if (kind === "symlink") {
      await writeFile(join(root, "target.md"), "allowed\n", { mode: 0o600 });
      await symlink(join(root, "target.md"), instructions);
    }
    await writeFile(join(home, "config.toml"), `model_instructions_file = ${JSON.stringify(instructions)}\n`, { mode: 0o600 });
    const h = harness({ successfulResultTtlMs: 30_000 });
    await Promise.all([h.health("conversation"), h.health("reviewer")]);
    expect(h.probes).toBe(2);
  });
});
