import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AgentEnvironmentSchema,
  CURRENT_PLATFORM_SCHEMA_VERSION,
  type AgentEnvironment,
  type AgentProviderId
} from "@bflow/contracts";
import {
  AgyProviderAdapter,
  ClaudeProviderAdapter,
  CodexProviderAdapter,
  createFakeProviderRunner,
  createProviderProcessRunner
} from "../src/index.js";
import type {
  ProviderAdapterOptions,
  ProviderCommandInvocation,
  ProviderCommandOutcome,
  ProviderCommandRunner
} from "../src/types.js";

describe("profile-selected provider environments", () => {
  let root: string;
  let cwd: string;
  let stateDirectory: string;
  let executablePath: string;
  let previousHome: string | undefined;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "bflow-profile-provider-test-")));
    cwd = join(root, "workspace");
    stateDirectory = join(root, "state");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    executablePath = join(root, "provider-cli");
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(executablePath, 0o700);

    previousHome = process.env["HOME"];
    process.env["HOME"] = join(root, "process-home");
    await mkdir(process.env["HOME"], { recursive: true, mode: 0o700 });
  });

  afterAll(async () => {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  function createEnvironment(provider: AgentProviderId): AgentEnvironment {
    const permissionProfile = {
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      profileId: `profile-${provider}`,
      mode: "workspace_auto" as const,
      scope: {
        kind: "session" as const,
        machineId: "machine-profile-test",
        repositoryId: "repo-profile-test",
        workspaceRoot: cwd,
        sessionId: "session-profile-test"
      },
      filesystem: "workspace_write" as const,
      readableRoots: [cwd],
      writableRoots: [cwd],
      deniedRoots: [join(cwd, ".secret")],
      isolation: "provider_policy" as const,
      network: { mode: "deny" as const, allowedHosts: [] },
      allowedTools: ["Read", "Edit"],
      deniedAction: "request_via_conversation" as const,
      allowGlobalPermissionBypass: false
    };

    return AgentEnvironmentSchema.parse({
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      environmentId: `env-profile-${provider}`,
      provider,
      role: "developer",
      scope: permissionProfile.scope,
      cwd,
      stateDirectory,
      configFingerprint: "a".repeat(64),
      permissionProfile,
      environmentVariables: {},
      secretBindings: {},
      requiredCapabilityIds: [`${provider}-implementation`],
      requiredMcpServiceIds: [],
      skillManifestDigest: "0".repeat(64)
    });
  }

  async function createSelectedEnvironment(provider: AgentProviderId) {
    const profileRoot = join(root, `${provider}-profile-${Math.random().toString(36).slice(2)}`);
    const home = join(profileRoot, "home");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(join(profileRoot, "xdg", "config"), { recursive: true, mode: 0o700 });
    await mkdir(join(profileRoot, "xdg", "cache"), { recursive: true, mode: 0o700 });
    await mkdir(join(profileRoot, "xdg", "data"), { recursive: true, mode: 0o700 });
    await mkdir(join(profileRoot, "xdg", "state"), { recursive: true, mode: 0o700 });
    await mkdir(join(profileRoot, "tmp"), { recursive: true, mode: 0o700 });
    const codexHome = join(home, ".codex");
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const agyHome = join(home, ".gemini", "antigravity-cli");
    await mkdir(agyHome, { recursive: true, mode: 0o700 });
    const isolatorEnvironment = {
      HOME: home,
      PATH: "/usr/bin:/bin",
      XDG_CONFIG_HOME: join(profileRoot, "xdg", "config"),
      XDG_CACHE_HOME: join(profileRoot, "xdg", "cache"),
      XDG_DATA_HOME: join(profileRoot, "xdg", "data"),
      XDG_STATE_HOME: join(profileRoot, "xdg", "state"),
      TMPDIR: join(profileRoot, "tmp"),
      AI_ISOLATOR: "1",
      AI_ISOLATOR_HOME: profileRoot,
      AI_ISOLATOR_PROFILE: `${provider}-selected`,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: "",
      AGY_CONFIG_DIR: ""
    } as const;
    return { profileRoot, home, codexHome, agyHome, isolatorEnvironment };
  }

  function recordingRunner(
    calls: ProviderCommandInvocation[],
    globalServers: readonly string[] = [],
    override?: (invocation: ProviderCommandInvocation) => ProviderCommandOutcome | undefined
  ): ProviderCommandRunner {
    const fake = createFakeProviderRunner({ scenario: "healthy" });
    return {
      async run(invocation) {
        calls.push({
          ...invocation,
          args: [...invocation.args],
          ...(invocation.env ? { env: { ...invocation.env } } : {})
        });
        const overridden = override?.(invocation);
        if (overridden !== undefined) return overridden;
        if (invocation.args.includes("mcp") && invocation.args.includes("list")) {
          return { exitCode: 0, stdout: JSON.stringify(globalServers), stderr: "", started: true };
        }
        return fake.run(invocation);
      }
    };
  }

  function adapter(provider: AgentProviderId, options: ProviderAdapterOptions = {}) {
    const common = {
      ...options,
      executablePath,
      allowTestFilesystemOwnership: true
    };
    if (provider === "claude") return new ClaudeProviderAdapter(common);
    if (provider === "codex") return new CodexProviderAdapter(common);
    return new AgyProviderAdapter(common);
  }

  it.each(["claude", "codex", "agy"] as const)(
    "%s probes use the selected profile environment without inheriting the host environment",
    async (provider) => {
      const selected = await createSelectedEnvironment(provider);
      const calls: ProviderCommandInvocation[] = [];
      const adapterOptions = {
        runner: recordingRunner(calls),
        isolatorEnvironment: selected.isolatorEnvironment
      };
      const result = await adapter(provider, adapterOptions).checkHealth({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        environment: createEnvironment(provider),
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(result.ok).toBe(true);
      expect(calls.some((call) => call.args.includes("--version"))).toBe(true);
      expect(calls.some((call) => call.args.includes("--help"))).toBe(true);
      // Agy's native Herdr binding is not yet certified, so preflight deliberately stops
      // after native authentication and does not execute a model turn.
      expect(calls.some((call) => call.args.includes("ping"))).toBe(provider !== "agy");
      for (const call of calls) {
        expect(call.inheritEnvironment).toBe(false);
        expect(call.env).toMatchObject({
          HOME: selected.home,
          PATH: selected.isolatorEnvironment.PATH,
          XDG_CONFIG_HOME: selected.isolatorEnvironment.XDG_CONFIG_HOME,
          XDG_CACHE_HOME: selected.isolatorEnvironment.XDG_CACHE_HOME,
          XDG_DATA_HOME: selected.isolatorEnvironment.XDG_DATA_HOME,
          XDG_STATE_HOME: selected.isolatorEnvironment.XDG_STATE_HOME,
          TMPDIR: selected.isolatorEnvironment.TMPDIR,
          AI_ISOLATOR_HOME: selected.profileRoot
        });
      }
      if (provider === "agy") {
        expect(calls.find((call) => call.args.includes("models"))?.env?.["HOME"]).toBe(selected.home);
        expect(calls.some((call) => call.args.includes("ping"))).toBe(false);
        expect(await readFile(join(selected.agyHome, "settings.json"), "utf8").catch(() => "")).toBe("");
        expect(await readFile(join(stateDirectory, "agy-home", ".gemini", "antigravity-cli", "settings.json"), "utf8").catch(() => "")).toBe("");
      }
    }
  );

  it("uses the selected Codex home for inherited MCP and hook inspection instead of the machine home", async () => {
    const selected = await createSelectedEnvironment("codex");
    const machineHome = join(root, "machine-codex-home");
    const selectedScript = join(root, "selected-profile-hook.sh");
    await mkdir(machineHome, { recursive: true, mode: 0o700 });
    await mkdir(join(machineHome, ".codex"), { recursive: true, mode: 0o700 });
    await writeFile(join(machineHome, ".codex", "config.toml"), "[mcp_servers.machine_server]\ncommand = \"/bin/true\"\n", { mode: 0o600 });
    await writeFile(join(selected.codexHome, "config.toml"), "[mcp_servers.profile_server]\ncommand = \"/bin/true\"\n", { mode: 0o600 });
    await writeFile(selectedScript, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(join(selected.codexHome, "hooks.json"), JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: selectedScript }] }] }
    }), { mode: 0o600 });
    const calls: ProviderCommandInvocation[] = [];
    const result = await new CodexProviderAdapter({
      executablePath,
      runner: recordingRunner(calls, ["profile_server", "machine_server"]),
      isolatorEnvironment: selected.isolatorEnvironment,
      codexHomeDirectory: join(machineHome, ".codex"),
      codexHookApprovalPath: join(root, "machine-state", "codex-hook-approvals.json"),
      allowTestFilesystemOwnership: true
    }).checkHealth({
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      environment: createEnvironment("codex"),
      stage: "preflight",
      requestedAt: new Date().toISOString()
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("blocked");
      expect(result.value.checks.some((check) => check.code === "codex_global_hooks_approval_required")).toBe(true);
    }
    expect(calls.find((call) => call.args.includes("mcp") && call.args.includes("list"))?.env?.["CODEX_HOME"]).toBe(selected.codexHome);
    expect(calls.some((call) => call.args.includes("login") && call.args.includes("status"))).toBe(false);
    expect(calls.some((call) => call.args.includes("ping"))).toBe(false);
  });

  it("uses a linked Codex backend for readiness and launch without native login status or token argv", async () => {
    const selected = await createSelectedEnvironment("codex");
    const token = "synthetic-codex-lb-secret";
    const calls: ProviderCommandInvocation[] = [];
    const isolatorEnvironment = { ...selected.isolatorEnvironment, CODEX_LB_API_KEY: token };
    const codex = new CodexProviderAdapter({
      executablePath,
      runner: recordingRunner(calls),
      isolatorEnvironment,
      codexBackendUrl: "http://127.0.0.1:8787/v1",
      model: "gpt-6.1-sol",
      effort: "medium",
      codexHookApprovalPath: join(root, "machine-state", "codex-hook-approvals.json"),
      allowTestFilesystemOwnership: true
    });

    const health = await codex.checkHealth({
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      environment: createEnvironment("codex"),
      stage: "preflight",
      requestedAt: new Date().toISOString()
    });
    expect(health.ok).toBe(true);
    if (health.ok) expect(health.value.status).toBe("ready");
    expect(calls.some((call) => call.args.includes("login") && call.args.includes("status"))).toBe(false);

    const probe = calls.find((call) => call.args.includes("exec") && call.args.includes("ping"));
    expect(probe).toBeDefined();
    expect(probe?.inheritEnvironment).toBe(false);
    expect(probe?.env?.["CODEX_LB_API_KEY"]).toBe(token);
    expect(probe?.args).toEqual(expect.arrayContaining([
      'model_provider="codex-lb"',
      'model_providers.codex-lb.name="openai"',
      'model_providers.codex-lb.base_url="http://127.0.0.1:8787/backend-api/codex"',
      'model_providers.codex-lb.wire_api="responses"',
      "model_providers.codex-lb.supports_websockets=true",
      "model_providers.codex-lb.requires_openai_auth=false",
      'model_providers.codex-lb.http_headers={"x-openai-actor-authorization"="codex-lb"}',
      'model_providers.codex-lb.env_key="CODEX_LB_API_KEY"'
    ]));
    expect(probe?.args.join(" ")).not.toContain(token);
    const execIndex = probe!.args.indexOf("exec");
    expect(probe!.args.slice(execIndex + 1)).not.toContain("-c");
    expect(probe!.args.indexOf('model_reasoning_effort="medium"')).toBeLessThan(execIndex);
    for (const call of calls.filter((entry) => entry !== probe)) {
      expect(call.env?.["CODEX_LB_API_KEY"]).toBeUndefined();
    }

    const launch = await codex.prepareLaunch(createEnvironment("codex"));
    expect(launch.ok).toBe(true);
    if (launch.ok) {
      expect(launch.value.argv).toEqual(expect.arrayContaining([
        'model_provider="codex-lb"',
        'model_providers.codex-lb.base_url="http://127.0.0.1:8787/backend-api/codex"',
        'model_providers.codex-lb.env_key="CODEX_LB_API_KEY"'
      ]));
      expect(JSON.stringify(launch.value)).not.toContain(token);
    }
  });

  it("fails linked Codex readiness when backend execution is unauthorized", async () => {
    const selected = await createSelectedEnvironment("codex");
    const calls: ProviderCommandInvocation[] = [];
    const health = await new CodexProviderAdapter({
      executablePath,
      runner: recordingRunner(calls, [], (invocation) =>
        invocation.args.includes("exec") && invocation.args.includes("ping")
          ? { exitCode: 1, stdout: "", stderr: "HTTP 401 unauthorized", started: true }
          : undefined
      ),
      isolatorEnvironment: { ...selected.isolatorEnvironment, CODEX_LB_API_KEY: "synthetic-key" },
      codexBackendUrl: "http://127.0.0.1:8787",
      allowTestFilesystemOwnership: true
    }).checkHealth({
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      environment: createEnvironment("codex"),
      stage: "preflight",
      requestedAt: new Date().toISOString()
    });

    expect(health.ok).toBe(true);
    if (health.ok) {
      expect(health.value.status).toBe("blocked");
      const authentication = health.value.checks.find((check) => check.check === "authentication");
      expect(authentication?.status).toBe("failed");
      expect(authentication?.code).toBe("auth_missing");
    }
    expect(calls.some((call) => call.args.includes("exec") && call.args.includes("ping"))).toBe(true);
    expect(calls.some((call) => call.args.includes("login") && call.args.includes("status"))).toBe(false);
  });

  it("preserves direct Codex auth and backend selection when no linked backend is configured", async () => {
    const isolatedHome = join(root, "direct-codex-home");
    await mkdir(join(isolatedHome, ".codex"), { recursive: true, mode: 0o700 });
    const calls: ProviderCommandInvocation[] = [];
    const codex = new CodexProviderAdapter({
      executablePath,
      runner: recordingRunner(calls),
      codexHomeDirectory: join(isolatedHome, ".codex"),
      codexHookEnvironment: {
        HOME: isolatedHome,
        PATH: "/usr/bin:/bin",
        ORCA_AGENT_HOOK_ROOT: "",
        ORCA_AGENT_HOOK_ENDPOINT: ""
      },
      allowTestFilesystemOwnership: true
    });

    const health = await codex.checkHealth({
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      environment: createEnvironment("codex"),
      stage: "preflight",
      requestedAt: new Date().toISOString()
    });
    expect(health.ok).toBe(true);
    if (health.ok) expect(health.value.status).toBe("ready");
    expect(calls.some((call) => call.args.includes("login") && call.args.includes("status"))).toBe(true);
    const probe = calls.find((call) => call.args.includes("exec") && call.args.includes("ping"));
    expect(probe?.args.some((argument) => argument.includes("model_provider"))).toBe(false);
    expect(probe?.inheritEnvironment).toBeUndefined();

    const launch = await codex.prepareLaunch(createEnvironment("codex"));
    expect(launch.ok).toBe(true);
    if (launch.ok) expect(launch.value.argv.some((argument) => argument.includes("model_provider"))).toBe(false);
  });

  it("keeps process environment inheritance enabled by default and disables it when requested", async () => {
    const variable = "BFLOW_PROFILE_RUNNER_TEST";
    const previous = process.env[variable];
    process.env[variable] = "host-only";
    const runner = createProviderProcessRunner();
    try {
      const isolated = await runner.run({
        executable: process.execPath,
        args: ["-e", `process.stdout.write(process.env.${variable} ?? "missing")`],
        env: { EXPLICIT_PROFILE_VALUE: "selected" },
        inheritEnvironment: false
      });
      expect(isolated.exitCode).toBe(0);
      expect(isolated.stdout).toBe("missing");

      const legacy = await runner.run({
        executable: process.execPath,
        args: ["-e", `process.stdout.write(process.env.${variable} ?? "missing")`]
      });
      expect(legacy.exitCode).toBe(0);
      expect(legacy.stdout).toBe("host-only");
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });
});
