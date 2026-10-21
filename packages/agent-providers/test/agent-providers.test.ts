import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AgentEnvironment,
  AgentEnvironmentSchema,
  type AgentHealthRequest,
  type AgentLaunchProfile,
  type AgentProviderId,
  CURRENT_PLATFORM_SCHEMA_VERSION,
  type MCPClientRegistration,
  type PermissionProfile,
  type SkillManifest
} from "@bflow/contracts";
import {
  AgyProviderAdapter,
  approveCodexHooks,
  trustAllCodexHooks,
  revokeAllCodexHookTrust,
  ClaudeProviderAdapter,
  CodexProviderAdapter,
  codexStartupPrompt,
  type DetectedProviderCapabilities,
  type InheritedIsolation,
  createDefaultProviderRegistry,
  createFakeProviderRunner,
  createHealthCheck,
  createProviderProcessRunner,
  computeFileSha256,
  createSignedLaunchAttestation,
  formatProviderDiagnosticReport,
  inspectCodexHooks,
  resolveAndVerifyExecutable,
  scrubDiagnosticText,
  validateProviderEnvironment,
  verifyLaunchAttestation
} from "../src/index.js";
import { buildHerdrAgentStartCommand } from "../src/herdr-command.js";

describe("@bflow/agent-providers", () => {
  let testBaseDir: string;
  let testCwd: string;
  let testStateDir: string;
  let testCodexHome: string;
  let fakeBinaryPath: string;
  let testIssuerId: string;
  let testPrivateKeyPem: string;
  let testPublicKeyPem: string;

  beforeAll(async () => {
    testBaseDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-provider-tests-")));
    testCwd = join(testBaseDir, "workspace");
    testStateDir = join(testBaseDir, "state");
    testCodexHome = join(testBaseDir, "codex-home");

    await mkdir(testCwd, { recursive: true, mode: 0o700 });
    await mkdir(testStateDir, { recursive: true, mode: 0o700 });
    await mkdir(testCodexHome, { recursive: true, mode: 0o700 });

    fakeBinaryPath = join(testBaseDir, "mock-binary");
    await writeFile(fakeBinaryPath, "#!/bin/sh\necho ok\n", { mode: 0o700 });

    testIssuerId = "bflow-test-issuer";
    const keyPair = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    testPrivateKeyPem = keyPair.privateKey;
    testPublicKeyPem = keyPair.publicKey;
  });

  afterAll(async () => {
    try {
      await rm(testBaseDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function createTestEnvironment(
    provider: AgentProviderId,
    mode: "restricted" | "workspace_auto" | "unattended_isolated" = "workspace_auto",
    overrides?: Partial<AgentEnvironment>
  ): AgentEnvironment {
    const permissionProfile: PermissionProfile = {
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      profileId: `perm-${provider}-${mode}`,
      mode,
      scope: {
        kind: "session",
        machineId: "mach-1",
        repositoryId: "repo-1",
        workspaceRoot: testCwd,
        sessionId: "sess-1"
      },
      filesystem: mode === "restricted" ? "read_only" : "workspace_write",
      readableRoots: [testCwd],
      writableRoots: mode === "restricted" ? [] : [testCwd],
      deniedRoots: [join(testCwd, ".secret")],
      isolation: mode === "unattended_isolated" ? "os_sandbox" : "provider_policy",
      network: {
        mode: "deny",
        allowedHosts: []
      },
      allowedTools: ["Read", "Edit"],
      deniedAction: "request_via_conversation",
      allowGlobalPermissionBypass: false
    };

    return AgentEnvironmentSchema.parse({
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      environmentId: `env-${provider}-${Date.now()}`,
      provider,
      role: "developer",
      scope: {
        kind: "session",
        machineId: "mach-1",
        repositoryId: "repo-1",
        workspaceRoot: testCwd,
        sessionId: "sess-1"
      },
      cwd: testCwd,
      stateDirectory: testStateDir,
      configFingerprint: "a".repeat(64),
      permissionProfile,
      environmentVariables: {
        BUILD_ENV: "test"
      },
      secretBindings: {
        API_TOKEN: "secret://vault/dev-token"
      },
      requiredCapabilityIds: [`${provider}-implementation`],
      requiredMcpServiceIds: [],
      skillManifestDigest: "0".repeat(64),
      ...overrides
    });
  }

  describe("1. Diagnostics and Secret Scrubbing", () => {
    it.each([
      '--password "first credential-tail"',
      '--password "first credential-tail',
      "SERVICE_TOKEN='first credential-tail'",
      'SERVICE_TOKEN="first credential-tail',
      '--password "first credential-tail\\',
      '{"access_token":"first credential-tail"}',
      '{"password":"first credential-tail"}',
      '{"client_secret":"first credential-tail"}'
    ])("redacts quoted credential tails even in incomplete provider output: %s", (input) => {
      expect(scrubDiagnosticText(input)).not.toContain("credential-tail");
    });
    it("redacts opaque flag and environment credentials before provider health crosses a package boundary", () => {
      const values = ["synthetic-private-password", "synthetic-private-key", "synthetic-private-env"];
      const text = 'auth failed: --password "synthetic-private-password" --api-key=synthetic-private-key SERVICE_TOKEN=synthetic-private-env';
      const check = createHealthCheck("authentication", "failed", "auth_missing", text, text);
      for (const value of values) expect(JSON.stringify(check)).not.toContain(value);
    });
    it("scrubs Bearer tokens, OpenAI/Anthropic/Google/GitHub API keys, and emails", () => {
      const sensitive =
        "Error: Bearer abc.123_xyz-token failed with sk-proj-1234567890abcdef and AIzaSyD12345. " +
        "GitHub token ghp_abcdef123456 leaked by user@example.com! " +
        "Line 2 with \x00control\x07chars and multiline\n\twhitespace.";

      const scrubbed = scrubDiagnosticText(sensitive);
      expect(scrubbed).not.toContain("abc.123_xyz-token");
      expect(scrubbed).not.toContain("sk-proj-1234567890abcdef");
      expect(scrubbed).not.toContain("AIzaSyD12345");
      expect(scrubbed).not.toContain("ghp_abcdef123456");
      expect(scrubbed).not.toContain("user@example.com");
      expect(scrubbed).toContain("Bearer [REDACTED]");
      expect(scrubbed).toContain("[REDACTED_API_KEY]");
      expect(scrubbed).toContain("[REDACTED_TOKEN]");
      expect(scrubbed).toContain("[REDACTED_EMAIL]");
      expect(scrubbed).not.toContain("\n");
      expect(scrubbed).not.toContain("\0");
      expect(scrubbed.length).toBeLessThanOrEqual(240);
    });

    it("formats diagnostic report with structured cause and remediation", () => {
      const check1 = createHealthCheck("binary", "passed", "binary_ok", "Binary verified.");
      const check2 = createHealthCheck(
        "authentication",
        "failed",
        "auth_expired",
        "OAuth token Bearer sk-ant-secret-123 expired for dev@example.com",
        "Run 'claude auth login' to re-authenticate."
      );

      const report = formatProviderDiagnosticReport({
        schemaVersion: 3,
        environmentId: "env-1",
        provider: "claude",
        role: "developer",
        configFingerprint: "0".repeat(64),
        stage: "preflight",
        status: "blocked",
        checkedAt: new Date().toISOString(),
        validUntil: new Date(Date.now() + 60_000).toISOString(),
        checks: [check1, check2]
      });

      expect(report.status).toBe("blocked");
      expect(report.failedChecks).toHaveLength(1);
      expect(report.failedChecks[0]?.check).toBe("authentication");
      expect(report.failedChecks[0]?.cause).not.toContain("sk-ant-secret-123");
      expect(report.failedChecks[0]?.cause).not.toContain("dev@example.com");
      expect(report.failedChecks[0]?.remediation).toBe("Run 'claude auth login' to re-authenticate.");
    });
  });

  describe("2. Process Runner and Fake Runner", () => {
    it("createProviderProcessRunner rejects NUL bytes and invalid arguments", async () => {
      const runner = createProviderProcessRunner();
      const outcome = await runner.run({
        executable: "/bin/echo\0bad",
        args: ["hello"]
      });
      expect(outcome.started).toBe(false);
      expect(outcome.failure).toBe("invalid_arguments");

      const outcome2 = await runner.run({
        executable: "/bin/echo",
        args: ["hello\0world"]
      });
      expect(outcome2.started).toBe(false);
      expect(outcome2.failure).toBe("invalid_arguments");
    });

    it("createFakeProviderRunner simulates normal responses and scenarios", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const versionOutcome = await runner.run({
        executable: "claude",
        args: ["--version"]
      });
      expect(versionOutcome.exitCode).toBe(0);
      expect(versionOutcome.stdout).toContain("2.1.301");

      const authOutcome = await runner.run({
        executable: "claude",
        args: ["auth", "status", "--json"]
      });
      expect(authOutcome.exitCode).toBe(0);
      expect(JSON.parse(authOutcome.stdout).authenticated).toBe(true);

      const expiredRunner = createFakeProviderRunner({ scenario: "auth_expired" });
      const expiredOutcome = await expiredRunner.run({
        executable: "claude",
        args: ["auth", "status", "--json"]
      });
      expect(expiredOutcome.exitCode).not.toBe(0);
      expect(expiredOutcome.stdout).toContain('"status":"expired"');
    });
  });

  describe("3. Provider Registry and Adapters", () => {
    it("createDefaultProviderRegistry registers claude, codex, and agy descriptors", () => {
      const registry = createDefaultProviderRegistry();
      expect(registry.has("claude")).toBe(true);
      expect(registry.has("codex")).toBe(true);
      expect(registry.has("agy")).toBe(true);

      const descriptors = registry.listDescriptors();
      expect(descriptors).toHaveLength(3);
      expect(descriptors.map((d) => d.provider).sort()).toEqual(["agy", "claude", "codex"]);
      expect(descriptors.find((d) => d.provider === "claude")?.supportsUnattended).toBe(true);
      expect(descriptors.find((d) => d.provider === "codex")?.supportsUnattended).toBe(true);
      expect(descriptors.find((d) => d.provider === "agy")?.supportsUnattended).toBe(false);
    });

    it("rejects unsupported schema version at registry ingress", async () => {
      const registry = createDefaultProviderRegistry();
      const env = createTestEnvironment("claude");
      const result = await registry.checkHealth({
        ...({ schemaVersion: 2 } as unknown as AgentHealthRequest),
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unsupported_version");
        if (result.error.code === "unsupported_version") {
          expect(result.error.supportedVersions).toEqual([3]);
          expect(result.error.receivedVersion).toBe(2);
        }
      }
    });

    it("rejects unknown provider at registry ingress", async () => {
      const registry = createDefaultProviderRegistry();
      const env = createTestEnvironment("claude");
      // @ts-expect-error testing unknown provider
      env.provider = "unknown-provider";

      const result = await registry.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("validation");
      }
    });
  });

  describe("4. Preflight and Activated Health Checks", () => {
    it("Claude passes preflight and produces deterministic prepareLaunch profile", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude", "workspace_auto");
      const healthResult = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(healthResult.ok).toBe(true);
      if (healthResult.ok) {
        expect(healthResult.value.status).toBe("ready");
        expect(healthResult.value.checks).toHaveLength(8);
        expect(healthResult.value.checks.every((c) => c.status === "passed")).toBe(true);
      }

      const launchResult = await adapter.prepareLaunch(env);
      expect(launchResult.ok).toBe(true);
      if (launchResult.ok) {
        const profile = launchResult.value;
        expect(profile.argv).toContain("--restricted");
        expect(profile.argv).toContain("--permission-mode");
        expect(profile.argv).toContain("dontAsk");
        expect(profile.argv).toContain("--tools");
        expect(profile.argv).toContain("Read,Glob,Grep,Edit,Write");
        expect(profile.configFiles).toHaveLength(3);
        expect(profile.launchFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(profile.interaction).toBe("no_direct_user_input");
      }
    });

    it("Claude applies configured model and effort to both readiness probe and launch", async () => {
      const calls: string[][] = [];
      const runner = createFakeProviderRunner({ scenario: "healthy", customHandler: invocation => {
        calls.push([...invocation.args]);
        return undefined;
      } });
      const adapter = new ClaudeProviderAdapter({ runner, executablePath: fakeBinaryPath, allowTestFilesystemOwnership: true,
        model: "sonnet", effort: "high" });
      const env = createTestEnvironment("claude", "workspace_auto");
      const health = await adapter.checkHealth({ schemaVersion: 3, environment: env, stage: "preflight", requestedAt: new Date().toISOString() });
      expect(health.ok && health.value.status).toBe("ready");
      const launch = await adapter.prepareLaunch(env);
      expect(launch.ok).toBe(true);
      if (launch.ok) expect(launch.value.argv).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "high"]));
      expect(calls.some(args => args.includes("sonnet") && args.includes("--effort") && args.includes("high"))).toBe(true);
    });

    it("rejects an effort level unsupported by the selected provider before running provider commands", async () => {
      const calls: string[][] = [];
      const runner = createFakeProviderRunner({ customHandler: invocation => {
        calls.push([...invocation.args]);
        return undefined;
      } });
      const adapter = new ClaudeProviderAdapter({ runner, executablePath: fakeBinaryPath, allowTestFilesystemOwnership: true,
        effort: "minimal" });
      const health = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("claude", "workspace_auto"),
        stage: "preflight", requestedAt: new Date().toISOString() });
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.status).toBe("unsupported");
        expect(health.value.checks[0]?.code).toBe("unsupported_effort");
      }
      expect(calls).toEqual([]);
    });

    it("rejects Agy effort on direct prepareLaunch before commands or launch material are created", async () => {
      const calls: string[][] = [];
      const runner = createFakeProviderRunner({ customHandler: invocation => {
        calls.push([...invocation.args]);
        return undefined;
      } });
      const adapter = new AgyProviderAdapter({ runner, executablePath: fakeBinaryPath, allowTestFilesystemOwnership: true,
        effort: "high" });
      const result = await adapter.prepareLaunch(createTestEnvironment("agy", "workspace_auto"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("encoded in the configured model name");
      expect(calls).toEqual([]);
    });

    it("Conversation role uses conversation interaction and empty tools", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude", "restricted", { role: "conversation" });
      const launchResult = await adapter.prepareLaunch(env);
      expect(launchResult.ok).toBe(true);
      if (launchResult.ok) {
        const profile = launchResult.value;
        expect(profile.interaction).toBe("conversation");
        const toolsIndex = profile.argv.indexOf("--tools");
        expect(profile.argv[toolsIndex + 1]).toBe("");
      }
    });

    it("Activated stage passes with valid Ed25519 signed attestation", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        trustedIssuerKeys: {
          [testIssuerId]: testPublicKeyPem
        },
        liveObservation: {
          paneId: "pane-1",
          transportState: "idle",
          interactiveReady: true
        }
      });

      const env = createTestEnvironment("claude", "workspace_auto");
      const launchResult = await adapter.prepareLaunch(env);
      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;

      const profile = launchResult.value;
      const attestation = createSignedLaunchAttestation({
        receiptId: "receipt-1",
        issuerId: testIssuerId,
        launchId: profile.launchId,
        launchFingerprint: profile.launchFingerprint,
        sessionId: env.scope.sessionId,
        paneId: "pane-1",
        nativeSession: {
          source: "claude",
          kind: "id",
          value: "claude-session-123"
        },
        observedAt: new Date().toISOString(),
        privateKeyPem: testPrivateKeyPem
      });

      const verifyCheck = verifyLaunchAttestation(
        attestation,
        { [testIssuerId]: testPublicKeyPem },
        { launchProfile: profile, sessionId: env.scope.sessionId }
      );
      expect(verifyCheck.valid).toBe(true);

      const activatedResult = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "activated",
        launchProfile: profile,
        launchAttestation: attestation,
        requestedAt: new Date().toISOString()
      });

      expect(activatedResult.ok).toBe(true);
      if (activatedResult.ok) {
        expect(activatedResult.value.status).toBe("ready");
        expect(activatedResult.value.checks).toHaveLength(9);
        expect(activatedResult.value.checks.find((c) => c.check === "native_binding")?.status).toBe("passed");
        expect(activatedResult.value.launchAttestation).toBeDefined();
      }
    });

    it("Activated stage fails when process is not interactiveReady or transport is starting", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        trustedIssuerKeys: {
          [testIssuerId]: testPublicKeyPem
        },
        liveObservation: {
          paneId: "pane-1",
          transportState: "starting",
          interactiveReady: false
        }
      });

      const env = createTestEnvironment("claude", "workspace_auto");
      const launchResult = await adapter.prepareLaunch(env);
      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;

      const profile = launchResult.value;
      const attestation = createSignedLaunchAttestation({
        receiptId: "receipt-1",
        issuerId: testIssuerId,
        launchId: profile.launchId,
        launchFingerprint: profile.launchFingerprint,
        sessionId: env.scope.sessionId,
        paneId: "pane-1",
        nativeSession: {
          source: "claude",
          kind: "id",
          value: "claude-session-123"
        },
        observedAt: new Date().toISOString(),
        privateKeyPem: testPrivateKeyPem
      });

      const activatedResult = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "activated",
        launchProfile: profile,
        launchAttestation: attestation,
        requestedAt: new Date().toISOString()
      });

      expect(activatedResult.ok).toBe(true);
      if (activatedResult.ok) {
        expect(activatedResult.value.status).toBe("blocked");
        const nativeCheck = activatedResult.value.checks.find((c) => c.check === "native_binding");
        expect(nativeCheck?.status).toBe("failed");
        expect(nativeCheck?.code).toBe("native_binding_not_interactive_ready");
      }
    });

    it("Codex passes preflight and produces deterministic prepareLaunch profile", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new CodexProviderAdapter({
        codexHomeDirectory: testCodexHome,
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        model: "o3-mini"
      });

      const env = createTestEnvironment("codex", "workspace_auto");
      const healthResult = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(healthResult.ok).toBe(true);
      if (healthResult.ok) {
        expect(healthResult.value.status).toBe("ready");
        expect(healthResult.value.checks).toHaveLength(8);
      }

      const launchResult = await adapter.prepareLaunch(env);
      expect(launchResult.ok).toBe(true);
      if (launchResult.ok) {
        const profile = launchResult.value;
        expect(profile.argv).toContain("--no-daemon");
        expect(profile.argv).toContain("--sandbox");
        expect(profile.argv).toContain("workspace-write");
        expect(profile.argv).toContain("--ask-for-approval");
        expect(profile.argv).toContain("never");
        expect(profile.argv).toContain("--model");
        expect(profile.argv).toContain("o3-mini");
        expect(profile.argv.at(-1)).toBe(codexStartupPrompt(env.environmentId));
      }
    });

    it("Codex applies configured model and reasoning effort to both readiness probe and launch", async () => {
      const calls: string[][] = [];
      const runner = createFakeProviderRunner({ scenario: "healthy", customHandler: invocation => {
        calls.push([...invocation.args]);
        return undefined;
      } });
      const adapter = new CodexProviderAdapter({ codexHomeDirectory: testCodexHome, runner, executablePath: fakeBinaryPath, allowTestFilesystemOwnership: true,
        model: "o3-mini", effort: "high" });
      const env = createTestEnvironment("codex", "workspace_auto");
      const health = await adapter.checkHealth({ schemaVersion: 3, environment: env, stage: "preflight", requestedAt: new Date().toISOString() });
      expect(health.ok && health.value.status).toBe("ready");
      const launch = await adapter.prepareLaunch(env);
      expect(launch.ok).toBe(true);
      if (launch.ok) expect(launch.value.argv).toEqual(expect.arrayContaining(["--model", "o3-mini", "model_reasoning_effort=\"high\""]));
      expect(calls.some(args => args.includes("o3-mini") && args.some(arg => arg.includes("model_reasoning_effort=\"high\"")))).toBe(true);
    });

    it("Agy passes preflight and produces deterministic prepareLaunch profile in plan mode", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new AgyProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("agy", "restricted");
      const healthResult = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(healthResult.ok).toBe(true);
      if (healthResult.ok) {
        expect(healthResult.value.status).toBe("ready");
        expect(healthResult.value.checks).toHaveLength(8);
      }

      const launchResult = await adapter.prepareLaunch(env);
      expect(launchResult.ok).toBe(true);
      if (launchResult.ok) {
        const profile = launchResult.value;
        expect(profile.argv).toContain("--sandbox");
        expect(profile.argv).toContain("--mode");
        expect(profile.argv).toContain("plan");
        expect(profile.argv).toContain("--disable-slash-commands");
      }
    });

    it("Rejects checkHealth and prepareLaunch when AbortSignal is cancelled", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude");
      const controller = new AbortController();
      controller.abort();

      const healthRes = await adapter.checkHealth(
        {
          schemaVersion: 3,
          environment: env,
          stage: "preflight",
          requestedAt: new Date().toISOString()
        },
        { signal: controller.signal }
      );
      expect(healthRes.ok).toBe(false);
      if (!healthRes.ok) {
        expect(healthRes.error.code).toBe("cancelled");
      }

      const launchRes = await adapter.prepareLaunch(env, { signal: controller.signal });
      expect(launchRes.ok).toBe(false);
      if (!launchRes.ok) {
        expect(launchRes.error.code).toBe("cancelled");
      }
    });

    it("Rejects forged Ed25519 signature in verifyLaunchAttestation", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });
      const env = createTestEnvironment("claude");
      const launchResult = await adapter.prepareLaunch(env);
      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;

      const profile = launchResult.value;
      const forgedAttestation = {
        schemaVersion: 3 as const,
        receiptId: "receipt-fake",
        issuerId: testIssuerId,
        launchId: profile.launchId,
        launchFingerprint: profile.launchFingerprint,
        sessionId: env.scope.sessionId,
        paneId: "pane-1",
        nativeSession: {
          source: "claude",
          kind: "id" as const,
          value: "session-fake"
        },
        observedAt: new Date().toISOString(),
        signature: {
          algorithm: "ed25519" as const,
          // 86 chars of 'A' + '=='
          value: "A".repeat(86) + "=="
        }
      };

      const verification = verifyLaunchAttestation(forgedAttestation, {
        [testIssuerId]: testPublicKeyPem
      });
      expect(verification.valid).toBe(false);
      expect(verification.code).toBe("invalid_signature");
    });
  });

  describe("5. All 8 Failure Scenarios", () => {
    const firecrawlAuthLog = '2026-10-21T03:23:21.702902Z ERROR rmcp::transport::worker: AuthRequired Bearer opaqueCredential123';
    const missingLbKey = 'ERROR: Missing environment variable: `CODEX_LB_API_KEY`.';

    it.each([
      ["", `${missingLbKey}\n${firecrawlAuthLog}`],
      ["", `${firecrawlAuthLog}\n${missingLbKey}`],
      [missingLbKey, firecrawlAuthLog]
    ])("reports the missing environment variable ahead of asynchronous MCP auth logs (%s, %s)", async (stdout, stderr) => {
      const runner = createFakeProviderRunner({ customHandler: invocation => invocation.args.includes("exec")
        ? { exitCode: 1, started: true, stdout, stderr } : undefined });
      const adapter = new CodexProviderAdapter({ runner, executablePath: fakeBinaryPath, codexHomeDirectory: testCodexHome });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("codex"), stage: "preflight", requestedAt: new Date().toISOString() });
      if (!result.ok) throw new Error("Expected a validated health result");
      expect(result.value.status).toBe("blocked");
      const check = result.value.checks.find(item => item.check === "authentication");
      expect(check?.message).toContain('Missing environment variable: `CODEX_LB_API_KEY`');
      expect(check?.message).not.toContain("AuthRequired");
      expect(check?.code).toBe("environment_variable_missing");
      expect(check?.remediation).toMatch(/export.*same terminal/i);
      expect(JSON.stringify(result)).not.toContain("opaqueCredential123");
    });

    it("keeps an upstream rate limit ahead of an incidental MCP authentication error", async () => {
      const runner = createFakeProviderRunner({ customHandler: invocation => invocation.args.includes("exec")
        ? { exitCode: 1, started: true, stdout: "", stderr: `ERROR: upstream returned 429 Too Many Requests\n${firecrawlAuthLog}` } : undefined });
      const adapter = new CodexProviderAdapter({ runner, executablePath: fakeBinaryPath, codexHomeDirectory: testCodexHome });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("codex"), stage: "preflight", requestedAt: new Date().toISOString() });
      if (!result.ok) throw new Error("Expected a validated health result");
      expect(result.value.status).toBe("blocked");
      expect(result.value.checks.find(item => item.check === "authentication")).toMatchObject({ code: "probe_failed", message: expect.stringContaining("429 Too Many Requests") });
    });

    it("accepts a successful model ping despite incidental MCP authentication logs", async () => {
      const runner = createFakeProviderRunner({ customHandler: invocation => invocation.args.includes("exec")
        ? { exitCode: 0, started: true, stdout: "pong", stderr: firecrawlAuthLog } : undefined });
      const adapter = new CodexProviderAdapter({ runner, executablePath: fakeBinaryPath, codexHomeDirectory: testCodexHome });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("codex"), stage: "preflight", requestedAt: new Date().toISOString() });
      if (!result.ok) throw new Error("Expected a validated health result");
      expect(result.value.checks.find(item => item.check === "authentication")).toMatchObject({ status: "passed", code: "auth_ok" });
    });

    it("preserves authoritative runner timeout over missing-variable output", async () => {
      const runner = createFakeProviderRunner({ customHandler: invocation => invocation.args.includes("exec")
        ? { exitCode: null, started: true, failure: "timeout", stdout: "", stderr: missingLbKey } : undefined });
      const adapter = new CodexProviderAdapter({ runner, executablePath: fakeBinaryPath, codexHomeDirectory: testCodexHome });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("codex"), stage: "preflight", requestedAt: new Date().toISOString() });
      if (!result.ok) throw new Error("Expected a validated health result");
      expect(result.value.status).toBe("blocked");
      expect(result.value.checks.find(item => item.check === "authentication")).toMatchObject({ code: "timeout", remediation: expect.stringContaining("startupTimeoutMs") });
    });

    it.each([
      ["I will check authentication.\ntokens used\n123", "ERROR: upstream returned 429 Too Many Requests", "probe_failed"],
      ["", "OpenAI Codex\nprovider: auth-proxy\nERROR: connection reset by peer", "probe_failed"],
      ["", "ERROR: OAuth access token expired", "auth_expired"],
      ["", "ERROR: Your API key has expired", "auth_expired"],
      ["", '{"error":{"code":"api_key_expired"}}', "auth_expired"],
      ["", "ERROR: authentication failed: invalid API key", "auth_missing"],
      ["", "ERROR: HTTP 401 Unauthorized", "auth_missing"],
      ["ERROR: authentication failed", "ERROR: connection reset by peer", "probe_failed"],
      ['{"error":{"message":"invalid API key"}}', "OpenAI Codex\nmodel: supported-model", "auth_missing"],
      ["", 'ERROR: request failed\n{\n  "error": {\n    "message": "OAuth access token expired",\n    "type": "authentication_error"\n  }\n}', "auth_expired"],
      ["", 'ERROR: request failed\n{\n  "error": {\n    "message": "The model `missing` does not exist",\n    "code": "model_not_found"\n  }\n}', "incompatible_model"]
    ])("classifies the actual probe failure without treating incidental auth/token text as expiry (%s, %s)", async (stdout, stderr, code) => {
      const runner = createFakeProviderRunner({ customHandler: invocation => invocation.args.includes("exec")
        ? { exitCode: 1, started: true, stdout, stderr } : undefined });
      const adapter = new CodexProviderAdapter({ runner, executablePath: fakeBinaryPath, codexHomeDirectory: testCodexHome });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("codex"), stage: "preflight", requestedAt: new Date().toISOString() });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected a validated health result");
      expect(result.value.status).toBe("blocked");
      const check = result.value.checks.find(check => check.check === "authentication");
      expect(check?.code).toBe(code);
      if (code === "probe_failed") expect(check?.remediation).not.toMatch(/re-authenticate/i);
    });

    it("keeps the trailing upstream error visible after a long Codex startup banner and redacts credentials", async () => {
      const stderr = "Reading additional input from stdin...\nOpenAI Codex v0.163.0\n" +
        "workdir: /workspace\nmodel: supported-model\nprovider: custom-provider\n".repeat(8) +
        '\x1b[31mERROR: upstream returned 429 Too Many Requests; SERVICE_TOKEN="opaque\ncredential-tail"\x1b[0m\n' +
        "tokens used\n123\n";
      const runner = createFakeProviderRunner({ customHandler: invocation => invocation.args.includes("exec")
        ? { exitCode: 1, started: true, stdout: "", stderr } : undefined });
      const adapter = new CodexProviderAdapter({ runner, executablePath: fakeBinaryPath, codexHomeDirectory: testCodexHome });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("codex"), stage: "preflight", requestedAt: new Date().toISOString() });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected a validated health result");
      const check = result.value.checks.find(check => check.check === "authentication");
      expect(result.value.status).toBe("blocked");
      expect(check?.code).toBe("probe_failed");
      expect(check?.message).toContain("429 Too Many Requests");
      expect(check?.message).toContain("[REDACTED]");
      expect(check?.message.length).toBeLessThanOrEqual(240);
      expect(JSON.stringify(result)).not.toMatch(/opaque|credential-tail/);
    });

    it("reports runner failure details when a failed probe has no output", async () => {
      const runner = createFakeProviderRunner({ customHandler: invocation => invocation.args.includes("exec")
        ? { exitCode: null, started: false, failure: "spawn", cause: "spawn codex EAGAIN", stdout: "", stderr: "" } : undefined });
      const adapter = new CodexProviderAdapter({ runner, executablePath: fakeBinaryPath, codexHomeDirectory: testCodexHome });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("codex"), stage: "preflight", requestedAt: new Date().toISOString() });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected a validated health result");
      expect(result.value.status).toBe("blocked");
      expect(result.value.checks.find(check => check.check === "authentication")?.message).toContain("EAGAIN");
    });

    it.each([
      ["pong\nOpenAI Codex\nmodel: supported-model\nsandbox: workspace-write\napproval: never", "probe_failed"],
      ["OpenAI Codex\nmodel: supported-model\nError: directory does not exist", "probe_failed"],
      ["OpenAI Codex\nmodel: supported-model\nError: The model `missing-model` does not exist", "incompatible_model"]
    ])("classifies failed probes from explicit errors: %s", async (stderr, code) => {
      const runner = createFakeProviderRunner({ customHandler: invocation => invocation.args.includes("exec")
        ? { exitCode: 1, stdout: "", stderr } : undefined });
      const adapter = new CodexProviderAdapter({ runner, executablePath: fakeBinaryPath, codexHomeDirectory: testCodexHome });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("codex"), stage: "preflight", requestedAt: new Date().toISOString() });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.checks.find(check => check.check === "authentication")?.code).toBe(code);
    });

    it("uses the verified canonical executable for probes whose cwd differs from the host", async () => {
      const probes: Array<{ executable: string; cwd?: string }> = [];
      const runner = createFakeProviderRunner({ customHandler(invocation) {
        if (invocation.args.includes("exec")) probes.push({ executable: invocation.executable, cwd: invocation.cwd });
        return undefined;
      } });
      const adapter = new CodexProviderAdapter({ runner, executablePath: relative(process.cwd(), fakeBinaryPath),
        codexHomeDirectory: testCodexHome });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("codex"), stage: "preflight", requestedAt: new Date().toISOString() });
      expect(result.ok).toBe(true);
      expect(probes).toEqual([expect.objectContaining({ executable: fakeBinaryPath, cwd: testCwd })]);
    });

    it("verifies Codex against the same PATH used by its child commands", async () => {
      const bin = join(testBaseDir, "selected-bin");
      await mkdir(bin, { mode: 0o700 });
      await writeFile(join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const adapter = new CodexProviderAdapter({ runner: createFakeProviderRunner({ scenario: "success" }),
        codexHomeDirectory: testCodexHome, codexHookEnvironment: { HOME: testBaseDir, PATH: bin } });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("codex"), stage: "preflight", requestedAt: new Date().toISOString() });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.checks.find(check => check.check === "binary")?.message).toContain(join(bin, "codex"));
    });

    it.each([0o600, 0o777])("preserves the actual binary verification failure for mode %s", async (mode) => {
      const binary = join(testBaseDir, `unsafe-binary-${mode}`);
      await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode });
      await chmod(binary, mode);
      const adapter = new ClaudeProviderAdapter({ runner: createFakeProviderRunner({ scenario: "success" }), executablePath: binary });
      const result = await adapter.checkHealth({ schemaVersion: 3, environment: createTestEnvironment("claude"), stage: "preflight", requestedAt: new Date().toISOString() });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.checks.find(check => check.check === "binary")?.code).toBe(mode === 0o600 ? "binary_not_executable" : "binary_untrusted");
    });

    it("1. Missing binary fails with binary_missing", async () => {
      const runner = createFakeProviderRunner({ scenario: "missing_binary" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: "/nonexistent/binary",
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude");
      const result = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("blocked");
        const binaryCheck = result.value.checks.find((c) => c.check === "binary");
        expect(binaryCheck?.status).toBe("failed");
        expect(binaryCheck?.code).toBe("binary_missing");
      }
    });

    it("2. Outdated version fails with outdated_version", async () => {
      const runner = createFakeProviderRunner({ scenario: "outdated_version" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        minimumVersion: "2.0.0",
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude");
      const result = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("blocked");
        const versionCheck = result.value.checks.find((c) => c.check === "version");
        expect(versionCheck?.status).toBe("failed");
        expect(versionCheck?.code).toBe("outdated_version");
      }
    });

    it("3. Auth expired fails with auth_expired and redacts tokens", async () => {
      const runner = createFakeProviderRunner({ scenario: "auth_expired" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude");
      const result = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("blocked");
        const authCheck = result.value.checks.find((c) => c.check === "authentication");
        expect(authCheck?.status).toBe("failed");
        expect(authCheck?.code).toBe("auth_expired");
        expect(authCheck?.message).not.toContain("sk-secret-12345");
        expect(authCheck?.message).not.toContain("user@example.com");
      }
    });

    it("4. Permission denied fails with permission_denied", async () => {
      const runner = createFakeProviderRunner({ scenario: "permission_denied" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude");
      const result = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("blocked");
        const authCheck = result.value.checks.find((c) => c.check === "authentication");
        expect(authCheck?.status).toBe("failed");
        expect(authCheck?.code).toBe("permission_denied");
      }
    });

    it("5. Invalid flag fails during capability/launch check with invalid_flag", async () => {
      const runner = createFakeProviderRunner({ scenario: "invalid_flag" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude");
      const result = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("blocked");
        const permCheck = result.value.checks.find((c) => c.check === "permissions");
        const launchCheck = result.value.checks.find((c) => c.check === "launch_arguments");
        expect(permCheck?.status).toBe("failed");
        expect(permCheck?.code).toBe("invalid_flag");
        expect(launchCheck?.status).toBe("failed");
        expect(launchCheck?.code).toBe("invalid_flag");
      }

      const launchRes = await adapter.prepareLaunch(env);
      expect(launchRes.ok).toBe(false);
      if (!launchRes.ok) {
        expect(launchRes.error.code).toBe("validation");
      }
    });

    it("6. Insecure environment or injection attempt fails", async () => {
      // Test dangerous LD_PRELOAD injection
      const envWithInjection = createTestEnvironment("claude", "workspace_auto", {
        environmentVariables: {
          LD_PRELOAD: "/tmp/evil.so"
        }
      });

      const validationResult = await validateProviderEnvironment(envWithInjection, {
        allowTestFilesystemOwnership: true
      });
      expect(validationResult.valid).toBe(false);
      expect(validationResult.code).toBe("environment_injection_attempt");

      // Test secret token in environmentVariables
      const envWithSecret = createTestEnvironment("claude", "workspace_auto", {
        environmentVariables: {
          CUSTOM_VAR: "sk-ant-api03-secret123456"
        }
      });
      const secretValidation = await validateProviderEnvironment(envWithSecret, {
        allowTestFilesystemOwnership: true
      });
      expect(secretValidation.valid).toBe(false);
      expect(secretValidation.code).toBe("secret_value_in_environment_variables");

      // Test insecure directory permissions (0o755)
      const insecureDir = join(testBaseDir, "insecure-state");
      await mkdir(insecureDir, { recursive: true, mode: 0o755 });
      await chmod(insecureDir, 0o755);

      const envInsecure = createTestEnvironment("claude", "workspace_auto", {
        stateDirectory: insecureDir
      });
      const permValidation = await validateProviderEnvironment(envInsecure, {
        allowTestFilesystemOwnership: true
      });
      expect(permValidation.valid).toBe(false);
      expect(permValidation.code).toBe("environment_insecure");
    });

    it("7. Incompatible model fails with incompatible_model", async () => {
      const runner = createFakeProviderRunner({ scenario: "incompatible_model" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude");
      const result = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("blocked");
        const authCheck = result.value.checks.find((c) => c.check === "authentication");
        expect(authCheck?.status).toBe("failed");
        expect(authCheck?.code).toBe("incompatible_model");
      }
    });

    it("8. Agent blocked fails with agent_blocked", async () => {
      const runner = createFakeProviderRunner({ scenario: "agent_blocked" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude");
      const result = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe("blocked");
        const authCheck = result.value.checks.find((c) => c.check === "authentication");
        expect(authCheck?.status).toBe("failed");
        expect(authCheck?.code).toBe("agent_blocked");
      }
    });
  });

  describe("6. Provider-Specific Permission Rules", () => {
    it("Claude detects --dangerously-skip-permissions, never enables it, supports --add-dir, and blocks sensitive paths", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const caps = await adapter.detectCapabilities();
      expect(caps.supportsDangerouslySkipPermissions).toBe(true);
      expect(caps.supportsAddDirFlag).toBe(true);

      const extraWorktree = join(testCwd, "worktree-dev-1");
      await mkdir(extraWorktree, { recursive: true, mode: 0o700 });

      const baseEnv = createTestEnvironment("claude", "workspace_auto");
      const env: AgentEnvironment = {
        ...baseEnv,
        permissionProfile: {
          ...baseEnv.permissionProfile,
          readableRoots: [testCwd, extraWorktree],
          writableRoots: [testCwd, extraWorktree]
        }
      };

      const launchResult = await adapter.prepareLaunch(env);
      expect(launchResult.ok).toBe(true);
      if (launchResult.ok) {
        const argv = launchResult.value.argv;
        expect(argv).not.toContain("--dangerously-skip-permissions");
        expect(argv).toContain("--add-dir");
        expect(argv).toContain(extraWorktree);
        const disallowedIdx = argv.indexOf("--disallowedTools");
        expect(disallowedIdx).toBeGreaterThanOrEqual(0);
        const disallowedStr = argv[disallowedIdx + 1]!;
        expect(disallowedStr).toContain("./.git/**");
        expect(disallowedStr).toContain("./.bflow/**");
        expect(disallowedStr).toContain("~/.ssh/**");
        expect(disallowedStr).toContain("AskUserQuestion");
      }
    });

    it("Codex strictly separates approval policy from sandbox and forbids danger-full-access", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new CodexProviderAdapter({
        codexHomeDirectory: testCodexHome,
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("codex", "workspace_auto");
      const launchResult = await adapter.prepareLaunch(env);
      expect(launchResult.ok).toBe(true);
      if (launchResult.ok) {
        const argv = launchResult.value.argv;
        expect(argv).toContain("--no-daemon");
        expect(argv).toContain("--sandbox");
        expect(argv).toContain("workspace-write");
        expect(argv).toContain("--ask-for-approval");
        expect(argv).toContain("never");
        expect(argv).not.toContain("danger-full-access");
        expect(argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
        expect(argv).toContain("web_search=\"disabled\"");
      }
    });

    it("Agy detects --dangerously-skip-permissions by version, writes permissions.allow/workspaceTrust, omits unverified --mcp-config, and reports unsupported for unattended_isolated and activated", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new AgyProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const caps = await adapter.detectCapabilities();
      expect(caps.supportsDangerouslySkipPermissions).toBe(true);

      const wsEnv = createTestEnvironment("agy", "workspace_auto");
      const launchRes = await adapter.prepareLaunch(wsEnv);
      expect(launchRes.ok).toBe(true);
      if (launchRes.ok) {
        expect(launchRes.value.argv).toContain("--sandbox");
        expect(launchRes.value.argv).toContain("--mode");
        expect(launchRes.value.argv).toContain("accept-edits");
        expect(launchRes.value.argv).not.toContain("--dangerously-skip-permissions");
        expect(launchRes.value.argv).not.toContain("--mcp-config");

        const settingsFileEntry = launchRes.value.configFiles.find((cf) => cf.path.endsWith(".settings.json"));
        expect(settingsFileEntry).toBeDefined();
        const settingsJson = JSON.parse(await readFile(settingsFileEntry!.path, "utf8")) as {
          permissions?: { allow?: string[]; deny?: string[] };
          workspaceTrust?: { enabled?: boolean; trustedFolders?: string[] };
        };
        expect(settingsJson.permissions?.allow).toContain(`Read(${testCwd}/**)`);
        expect(settingsJson.permissions?.allow).toContain(`Edit(${testCwd}/**)`);
        expect(settingsJson.permissions?.deny).toContain("AskUserQuestion");
        expect(settingsJson.workspaceTrust?.enabled).toBe(true);
        expect(settingsJson.workspaceTrust?.trustedFolders).toContain(testCwd);
      }

      const env = createTestEnvironment("agy", "unattended_isolated");
      const healthResult = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });

      expect(healthResult.ok).toBe(true);
      if (healthResult.ok) {
        expect(healthResult.value.status).toBe("unsupported");
        const permCheck = healthResult.value.checks.find((c) => c.check === "permissions");
        expect(permCheck?.status).toBe("failed");
        expect(permCheck?.code).toBe("agy_unattended_unsupported");
      }

      const agyProfile = launchRes.value!;
      const agyAttestation = createSignedLaunchAttestation({
        receiptId: "receipt-agy-1",
        issuerId: testIssuerId,
        launchId: agyProfile.launchId,
        launchFingerprint: agyProfile.launchFingerprint,
        sessionId: wsEnv.scope.sessionId,
        paneId: "pane-agy-1",
        nativeSession: {
          source: "agy",
          kind: "id",
          value: "agy-sess-1"
        },
        observedAt: new Date().toISOString(),
        privateKeyPem: testPrivateKeyPem
      });

      const activatedRes = await adapter.checkHealth({
        schemaVersion: 3,
        environment: wsEnv,
        stage: "activated",
        launchProfile: agyProfile,
        launchAttestation: agyAttestation,
        requestedAt: new Date().toISOString()
      });
      expect(activatedRes.ok).toBe(true);
      if (activatedRes.ok) {
        expect(activatedRes.value.status).toBe("unsupported");
        expect(activatedRes.value.checks.find((c) => c.check === "native_binding")?.code).toBe(
          "native_binding_unsupported"
        );
      }
    });

    it("Claude and Codex verify OS sandbox binary for unattended_isolated mode", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const env = createTestEnvironment("claude", "unattended_isolated");

      // Missing OS sandbox binary -> unsupported
      const unsupportedAdapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        osSandboxPath: "/nonexistent/bwrap",
        allowTestFilesystemOwnership: true
      });
      const unsupportedRes = await unsupportedAdapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(unsupportedRes.ok).toBe(true);
      if (unsupportedRes.ok) {
        expect(unsupportedRes.value.status).toBe("unsupported");
        expect(unsupportedRes.value.checks.find((c) => c.check === "permissions")?.code).toBe(
          "unattended_isolation_unsupported"
        );
      }

      // Present executable OS sandbox binary -> ready
      const readyAdapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        osSandboxPath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });
      const readyRes = await readyAdapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(readyRes.ok).toBe(true);
      if (readyRes.ok) {
        expect(readyRes.value.status).toBe("ready");
      }
    });
  });

  describe("7. Herdr Agent Start Command", () => {
    it("builds valid herdr agent start command passing argv after --", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });

      const env = createTestEnvironment("claude", "workspace_auto");
      const launchResult = await adapter.prepareLaunch(env);
      expect(launchResult.ok).toBe(true);
      if (!launchResult.ok) return;

      const profile = launchResult.value;
      const cmd = buildHerdrAgentStartCommand(profile, {
        agentName: "dev-agent",
        paneId: "pane-42",
        timeoutMs: 60_000
      });

      expect(cmd.executable).toBe("herdr");
      expect(cmd.args.slice(0, 7)).toEqual([
        "agent",
        "start",
        "dev-agent",
        "--kind",
        "claude",
        "--pane",
        "pane-42"
      ]);
      expect(cmd.args).toContain("--timeout");
      expect(cmd.args).toContain("60000");
      expect(cmd.args).toContain("--");

      const doubleDashIdx = cmd.args.indexOf("--");
      expect(cmd.args.slice(doubleDashIdx + 1)).toEqual(profile.argv);

      // Verify no tokens in argv
      for (const arg of cmd.args) {
        expect(arg).not.toMatch(/sk-[A-Za-z0-9_-]+/);
        expect(arg).not.toMatch(/secret:\/\//);
      }

      // Verify isolated environment variables
      expect(cmd.env["BFLOW_PROVIDER"]).toBe("claude");
      expect(cmd.env["BFLOW_ROLE"]).toBe("developer");
      expect(cmd.env["BFLOW_PERMISSION_MODE"]).toBe("workspace_auto");
      expect(cmd.env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]).toBe("1");
    });

    it("rejects invalid agent names or multiline arguments", () => {
      const profile: AgentLaunchProfile = {
        schemaVersion: 3,
        launchId: "launch-1",
        environment: createTestEnvironment("claude"),
        providerVersion: "2.1.301",
        executable: fakeBinaryPath,
        executableDigest: "0".repeat(64),
        argv: ["--arg", "multi\nline"],
        configFiles: [],
        launchFingerprint: "0".repeat(64),
        interaction: "no_direct_user_input",
        expiresAt: new Date(Date.now() + 3600_000).toISOString()
      };

      expect(() => {
        buildHerdrAgentStartCommand(profile, {
          agentName: "INVALID_NAME",
          paneId: "pane-1"
        });
      }).toThrow(/Invalid agentName/);

      expect(() => {
        buildHerdrAgentStartCommand(profile, {
          agentName: "validname",
          paneId: "pane-1"
        });
      }).toThrow(/newline characters/);
    });
  });

  describe("8. Argon Review Hardening Tests", () => {
    it("resolveAndVerifyExecutable resolves PATH binaries and rejects non-executable or world-writable binaries", async () => {
      const binDir = join(testBaseDir, "custom-bin");
      await mkdir(binDir, { recursive: true, mode: 0o700 });
      const customClaude = join(binDir, "claude");
      await writeFile(customClaude, "#!/bin/sh\necho ok\n", { mode: 0o700 });

      const resolved = await resolveAndVerifyExecutable("claude", {
        searchPath: binDir,
        allowTestFilesystemOwnership: true
      });
      expect(resolved.canonicalPath).toBe(customClaude);
      expect(resolved.digest).toMatch(/^[a-f0-9]{64}$/);

      const nonExec = join(binDir, "non-exec");
      await writeFile(nonExec, "not executable", { mode: 0o600 });
      await chmod(nonExec, 0o600);
      await expect(
        resolveAndVerifyExecutable(nonExec, { allowTestFilesystemOwnership: true })
      ).rejects.toThrow(/execute permissions/);

      const worldWritable = join(binDir, "world-writable");
      await writeFile(worldWritable, "#!/bin/sh\n", { mode: 0o777 });
      await chmod(worldWritable, 0o777);
      await expect(
        resolveAndVerifyExecutable(worldWritable, { allowTestFilesystemOwnership: true })
      ).rejects.toThrow(/group\/world writable/);
    });

    it("Validates MCPClientRegistration scope/expiry and SkillManifest role/digest", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const env = createTestEnvironment("claude", "workspace_auto", {
        requiredMcpServiceIds: ["bflow-gateway"],
        skillManifestDigest: "b".repeat(64)
      });

      const validSkillManifest: SkillManifest = {
        schemaVersion: 3,
        manifestId: "manifest-dev-1",
        environmentId: env.environmentId,
        scope: env.scope,
        role: "developer",
        provider: "claude",
        skills: [],
        bindings: [],
        digest: "b".repeat(64)
      };

      const adapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        mcpRegistrations: [
          {
            schemaVersion: 3,
            registrationId: "reg-1",
            scope: env.scope,
            environmentId: env.environmentId,
            provider: "claude",
            role: "developer",
            serviceIds: ["bflow-gateway"],
            allowedTools: ["mcp__bflow-gateway__ping"],
            connection: {
              transport: "stdio",
              executable: fakeBinaryPath,
              executableDigest: "c".repeat(64),
              argv: ["--stdio"],
              token: "secret://mcp/gateway-token"
            },
            configDigest: "d".repeat(64),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            idempotencyKey: "idem-reg-1"
          }
        ],
        skillManifest: validSkillManifest
      });

      const healthRes = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(healthRes.ok).toBe(true);
      if (healthRes.ok) {
        expect(healthRes.value.status).toBe("ready");
        expect(healthRes.value.checks.find((c) => c.check === "mcp")?.status).toBe("passed");
        expect(healthRes.value.checks.find((c) => c.check === "skills")?.status).toBe("passed");
      }

      // Role mismatch in SkillManifest
      const badSkillAdapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        skillManifest: {
          ...validSkillManifest,
          role: "reviewer"
        }
      });
      const badSkillRes = await badSkillAdapter.checkHealth({
        schemaVersion: 3,
        environment: createTestEnvironment("claude", "workspace_auto", {
          skillManifestDigest: "b".repeat(64)
        }),
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(badSkillRes.ok).toBe(true);
      if (badSkillRes.ok) {
        expect(badSkillRes.value.status).toBe("blocked");
        expect(badSkillRes.value.checks.find((c) => c.check === "skills")?.code).toBe(
          "skill_manifest_role_mismatch"
        );
      }
    });

    it("Activated stage detects pane mismatch, nativeSession mismatch, and config file tampering", async () => {
      const runner = createFakeProviderRunner({ scenario: "healthy" });
      const env = createTestEnvironment("claude", "workspace_auto");
      const baseAdapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true
      });
      const launchRes = await baseAdapter.prepareLaunch(env);
      expect(launchRes.ok).toBe(true);
      if (!launchRes.ok) return;

      const profile = launchRes.value;
      const attestation = createSignedLaunchAttestation({
        receiptId: "receipt-hardening",
        issuerId: testIssuerId,
        launchId: profile.launchId,
        launchFingerprint: profile.launchFingerprint,
        sessionId: env.scope.sessionId,
        paneId: "pane-expected",
        nativeSession: {
          source: "claude",
          kind: "id",
          value: "native-sess-expected"
        },
        observedAt: new Date().toISOString(),
        privateKeyPem: testPrivateKeyPem
      });

      // Pane mismatch
      const paneMismatchAdapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        trustedIssuerKeys: { [testIssuerId]: testPublicKeyPem },
        liveObservation: {
          paneId: "pane-wrong",
          transportState: "idle",
          interactiveReady: true
        }
      });
      const paneRes = await paneMismatchAdapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "activated",
        launchProfile: profile,
        launchAttestation: attestation,
        requestedAt: new Date().toISOString()
      });
      expect(paneRes.ok).toBe(true);
      if (paneRes.ok) {
        expect(paneRes.value.status).toBe("blocked");
        expect(paneRes.value.checks.find((c) => c.check === "native_binding")?.code).toBe(
          "native_binding_pane_mismatch"
        );
      }

      // Config file tampering after prepareLaunch
      const promptFile = profile.configFiles[0]!.path;
      await writeFile(promptFile, "tampered prompt content", { mode: 0o600 });

      const tamperAdapter = new ClaudeProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        trustedIssuerKeys: { [testIssuerId]: testPublicKeyPem },
        liveObservation: {
          paneId: "pane-expected",
          transportState: "idle",
          interactiveReady: true
        }
      });
      const tamperRes = await tamperAdapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "activated",
        launchProfile: profile,
        launchAttestation: attestation,
        requestedAt: new Date().toISOString()
      });
      expect(tamperRes.ok).toBe(true);
      if (tamperRes.ok) {
        expect(tamperRes.value.status).toBe("blocked");
        expect(tamperRes.value.checks.find((c) => c.check === "native_binding")?.code).toBe(
          "native_binding_config_mismatch"
        );
      }
    });
  });

  describe("9. Host MCP servers, Gateway registrations and native hooks", () => {
    const HOST_COMMAND = "/opt/bflow/node";
    const hostServers = {
      bflow: { command: HOST_COMMAND, args: ["/opt/bflow/host.js", "mcp", "/opt/bflow/developer.json"] }
    };
    const hostHooks = {
      SessionStart: "/opt/bflow/host.js hook session-start",
      UserPromptSubmit: "/opt/bflow/host.js hook prompt",
      Stop: "/opt/bflow/host.js hook stop",
      PreToolUse: "/opt/bflow/host.js hook pre-tool"
    };
    const tokenEnvironmentNames = { "gateway-dev": "BFLOW_GATEWAY_TOKEN" };

    function gatewayRegistration(env: AgentEnvironment, provider: AgentProviderId): MCPClientRegistration {
      return {
        schemaVersion: 3,
        registrationId: "gateway-dev",
        scope: env.scope,
        environmentId: env.environmentId,
        provider,
        role: "developer",
        serviceIds: ["bflow-gateway"],
        allowedTools: ["mcp__bflow-gateway__ping"],
        connection: {
          transport: "streamable_http",
          endpoint: "http://127.0.0.1:4317/mcp",
          token: "secret://mcp/gateway-token"
        },
        configDigest: "d".repeat(64),
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
        idempotencyKey: "idem-gateway-dev"
      };
    }

    async function readLaunchText(profile: AgentLaunchProfile): Promise<string> {
      const contents = await Promise.all(profile.configFiles.map((file) => readFile(file.path, "utf8")));
      return [...contents, ...profile.argv].join("\n");
    }

    const quote = (value: string): string => JSON.stringify(value);

    it.each(["conversation", "coordinator"] as const)("permits the configured host MCP for Claude %s without Gateway registrations", async role => {
      const env = createTestEnvironment("claude", "restricted", { role });
      const adapter = new ClaudeProviderAdapter({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        hostMcpServers: hostServers
      });
      const result = await adapter.prepareLaunch(env);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const argv = result.value.argv;
      expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("dontAsk");
      expect(argv[argv.indexOf("--tools") + 1]).toBe("");
      expect(argv[argv.indexOf("--allowedTools") + 1]).toBe("mcp__bflow__*");
      const settings = JSON.parse(await readFile(result.value.configFiles[2]!.path, "utf8"));
      expect(settings.permissions.allow).toEqual(["mcp__bflow__*"]);
    });

    it("Claude renders host bflow stdio, streamable_http Gateway entry and all four native hooks", async () => {
      const env = createTestEnvironment("claude");
      const adapter = new ClaudeProviderAdapter({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        hostMcpServers: hostServers,
        hostHooks,
        mcpRegistrations: [gatewayRegistration(env, "claude")],
        mcpTokenEnvironmentNames: tokenEnvironmentNames
      });
      const res = await adapter.prepareLaunch(env);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const mcp = JSON.parse(await readFile(res.value.configFiles[1]!.path, "utf8")) as unknown;
      expect(mcp).toEqual({
        mcpServers: {
          bflow: { command: HOST_COMMAND, args: ["/opt/bflow/host.js", "mcp", "/opt/bflow/developer.json"] },
          "gateway-dev": {
            type: "http",
            url: "http://127.0.0.1:4317/mcp",
            headers: { Authorization: "Bearer ${BFLOW_GATEWAY_TOKEN}" }
          }
        }
      });

      const permitted = res.value.argv[res.value.argv.indexOf("--allowedTools") + 1]!.split(",");
      expect(permitted).toEqual(["Read", "Glob", "Grep", "Edit", "Write", "mcp__bflow__*", "mcp__gateway-dev__*"]);
      const permissions = JSON.parse(await readFile(res.value.configFiles[2]!.path, "utf8")).permissions;
      expect(permissions.allow).toEqual(["Read,Glob,Grep,Edit,Write", "mcp__bflow__*", "mcp__gateway-dev__*"]);

      const settings = JSON.parse(await readFile(res.value.configFiles[2]!.path, "utf8")) as { hooks: unknown };
      const hook = (command: string) => [{ hooks: [{ type: "command", command, timeout: 30 }] }];
      expect(settings.hooks).toEqual({
        SessionStart: hook(hostHooks.SessionStart),
        UserPromptSubmit: hook(hostHooks.UserPromptSubmit),
        Stop: hook(hostHooks.Stop),
        PreToolUse: hook(hostHooks.PreToolUse)
      });
    });

    it("Codex renders host and Gateway entries as TOML with bearer_token_env_var and all four hooks", async () => {
      const env = createTestEnvironment("codex");
      const adapter = new CodexProviderAdapter({
        codexHomeDirectory: testCodexHome,
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        hostMcpServers: hostServers,
        hostHooks,
        mcpRegistrations: [gatewayRegistration(env, "codex")],
        mcpTokenEnvironmentNames: tokenEnvironmentNames
      });
      const res = await adapter.prepareLaunch(env);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const argv = res.value.argv;

      const expectedMcp =
        `mcp_servers={${quote("bflow")}={${quote("command")}=${quote(HOST_COMMAND)},` +
        `${quote("args")}=[${["/opt/bflow/host.js", "mcp", "/opt/bflow/developer.json"].map(quote).join(",")}],` +
        `${quote("env_vars")}=[${["HERDR_PANE_ID", "BFLOW_LAUNCH_ID"].map(quote).join(",")}],` +
        `${quote("default_tools_approval_mode")}=${quote("approve")}},` +
        `${quote("gateway-dev")}={${quote("url")}=${quote("http://127.0.0.1:4317/mcp")},` +
        `${quote("bearer_token_env_var")}=${quote("BFLOW_GATEWAY_TOKEN")},` +
        `${quote("default_tools_approval_mode")}=${quote("approve")}}}`;
      expect(argv).toContain(expectedMcp);
      // Only the stdio host server forwards env; the URL gateway entry above carries no env_vars.
      expect(argv.filter(arg => arg.includes(`${quote("env_vars")}=`))).toHaveLength(1);

      const hookTable = (command: string) =>
        `[{${quote("hooks")}=[{${quote("type")}=${quote("command")},${quote("command")}=${quote(command)},${quote("timeout")}=30}]}]`;
      const expectedHooks =
        "hooks={" +
        Object.entries(hostHooks)
          .map(([event, command]) => `${quote(event)}=${hookTable(command)}`)
          .join(",") +
        "}";
      expect(argv).toContain(expectedHooks);
      expect(argv).toEqual(expect.arrayContaining(["--enable", "hooks", "--dangerously-bypass-hook-trust"]));

      const mcp = JSON.parse(await readFile(res.value.configFiles[1]!.path, "utf8")) as unknown;
      expect(mcp).toEqual({
        mcpServers: {
          bflow: { command: HOST_COMMAND, args: ["/opt/bflow/host.js", "mcp", "/opt/bflow/developer.json"] },
          "gateway-dev": { url: "http://127.0.0.1:4317/mcp", bearer_token_env_var: "BFLOW_GATEWAY_TOKEN" }
        }
      });
    });

    it("writes only the token variable name, never the token value, into files or argv", async () => {
      const fakeToken = "fake-gateway-token-7f3a91c2e5";
      process.env["BFLOW_GATEWAY_TOKEN"] = fakeToken;
      try {
        for (const provider of ["claude", "codex"] as const) {
          const env = createTestEnvironment(provider);
          const adapter =
            provider === "claude"
              ? new ClaudeProviderAdapter({
                  runner: createFakeProviderRunner({ scenario: "healthy" }),
                  executablePath: fakeBinaryPath,
                  allowTestFilesystemOwnership: true,
                  hostMcpServers: hostServers,
                  hostHooks,
                  mcpRegistrations: [gatewayRegistration(env, provider)],
                  mcpTokenEnvironmentNames: tokenEnvironmentNames
                })
              : new CodexProviderAdapter({
        codexHomeDirectory: testCodexHome,
                  runner: createFakeProviderRunner({ scenario: "healthy" }),
                  executablePath: fakeBinaryPath,
                  allowTestFilesystemOwnership: true,
                  hostMcpServers: hostServers,
                  hostHooks,
                  mcpRegistrations: [gatewayRegistration(env, provider)],
                  mcpTokenEnvironmentNames: tokenEnvironmentNames
                });
          const res = await adapter.prepareLaunch(env);
          expect(res.ok).toBe(true);
          if (!res.ok) return;
          const text = await readLaunchText(res.value);
          expect(text).not.toContain(fakeToken);
          expect(text).toContain("BFLOW_GATEWAY_TOKEN");
        }
      } finally {
        delete process.env["BFLOW_GATEWAY_TOKEN"];
      }
    });

    it("fails validation when a streamable_http registration has no token environment mapping", async () => {
      for (const provider of ["claude", "codex"] as const) {
        const env = createTestEnvironment(provider);
        const adapter =
          provider === "claude"
            ? new ClaudeProviderAdapter({
                runner: createFakeProviderRunner({ scenario: "healthy" }),
                executablePath: fakeBinaryPath,
                allowTestFilesystemOwnership: true,
                mcpRegistrations: [gatewayRegistration(env, provider)]
              })
            : new CodexProviderAdapter({
        codexHomeDirectory: testCodexHome,
                runner: createFakeProviderRunner({ scenario: "healthy" }),
                executablePath: fakeBinaryPath,
                allowTestFilesystemOwnership: true,
                mcpRegistrations: [gatewayRegistration(env, provider)]
              });
        const res = await adapter.prepareLaunch(env);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatchObject({ code: "validation" });
        if (!res.ok) expect(res.error.message).toMatch(/no token environment variable mapping/);
      }
    });

    it("rejects malformed token environment names, host server names, and relative host commands", async () => {
      const env = createTestEnvironment("claude");
      const base = {
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        mcpRegistrations: [gatewayRegistration(env, "claude")]
      };
      const cases = [
        {
          options: { ...base, mcpTokenEnvironmentNames: { "gateway-dev": "gateway-token" } },
          message: /Token environment variable name/
        },
        {
          options: {
            ...base,
            mcpTokenEnvironmentNames: tokenEnvironmentNames,
            hostMcpServers: { Bflow: { command: HOST_COMMAND, args: [] } }
          },
          message: /must match/
        },
        {
          options: {
            ...base,
            mcpTokenEnvironmentNames: tokenEnvironmentNames,
            hostMcpServers: { bflow: { command: "node", args: [] } }
          },
          message: /must be an absolute path/
        }
      ];
      for (const testCase of cases) {
        const res = await new ClaudeProviderAdapter(testCase.options).prepareLaunch(env);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.message).toMatch(testCase.message);
      }
    });

    it("fails validation when a host MCP server name collides with a registration", async () => {
      const env = createTestEnvironment("claude");
      const adapter = new ClaudeProviderAdapter({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        hostMcpServers: { "gateway-dev": { command: HOST_COMMAND, args: [] } },
        mcpRegistrations: [gatewayRegistration(env, "claude")],
        mcpTokenEnvironmentNames: tokenEnvironmentNames
      });
      const res = await adapter.prepareLaunch(env);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toMatch(/collides with a Bflow host MCP server/);
    });

    it("Agy fails closed for streamable_http registrations and for host MCP servers without --mcp-config", async () => {
      const env = createTestEnvironment("agy");
      const httpAdapter = new AgyProviderAdapter({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        mcpRegistrations: [gatewayRegistration(env, "agy")],
        mcpTokenEnvironmentNames: tokenEnvironmentNames
      });
      const httpRes = await httpAdapter.prepareLaunch(env);
      expect(httpRes.ok).toBe(false);
      if (!httpRes.ok) expect(httpRes.error.message).toMatch(/environment-referenced bearer token/);

      const hostAdapter = new AgyProviderAdapter({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        hostMcpServers: hostServers
      });
      const hostRes = await hostAdapter.prepareLaunch(env);
      expect(hostRes.ok).toBe(false);
      if (!hostRes.ok) expect(hostRes.error.message).toMatch(/--mcp-config/);
    });

    it("reports unsupported when hooks are required by a provider without native hooks", async () => {
      const env = createTestEnvironment("agy");
      const adapter = new AgyProviderAdapter({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        hostHooks: { SessionStart: hostHooks.SessionStart }
      });
      const res = await adapter.prepareLaunch(env);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toMatch(/does not support native hooks/);

      const health = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.status).toBe("unsupported");
        expect(health.value.checks.find((c) => c.check === "launch_arguments")?.code).toBe("native_hooks_unsupported");
      }
    });

    it("keeps legacy nativeSessionHookCommand as a single SessionStart hook with timeout 10", async () => {
      const env = createTestEnvironment("claude");
      const adapter = new ClaudeProviderAdapter({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        nativeSessionHookCommand: "/opt/bflow/legacy-hook"
      });
      const res = await adapter.prepareLaunch(env);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const settings = JSON.parse(await readFile(res.value.configFiles[2]!.path, "utf8")) as { hooks: unknown };
      expect(settings.hooks).toEqual({
        SessionStart: [{ hooks: [{ type: "command", command: "/opt/bflow/legacy-hook", timeout: 10 }] }]
      });
    });

    it("hostHooks.SessionStart supersedes nativeSessionHookCommand", async () => {
      const env = createTestEnvironment("claude");
      const adapter = new ClaudeProviderAdapter({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        nativeSessionHookCommand: "/opt/bflow/legacy-hook",
        hostHooks: { SessionStart: hostHooks.SessionStart }
      });
      const res = await adapter.prepareLaunch(env);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const settings = JSON.parse(await readFile(res.value.configFiles[2]!.path, "utf8")) as { hooks: unknown };
      expect(settings.hooks).toEqual({
        SessionStart: [{ hooks: [{ type: "command", command: hostHooks.SessionStart, timeout: 30 }] }]
      });
    });

    it("configFiles digests cover the rendered hooks and change when a hook changes", async () => {
      const env = createTestEnvironment("claude");
      const build = (stop: string) =>
        new ClaudeProviderAdapter({
          runner: createFakeProviderRunner({ scenario: "healthy" }),
          executablePath: fakeBinaryPath,
          allowTestFilesystemOwnership: true,
          hostHooks: { ...hostHooks, Stop: stop }
        }).prepareLaunch(env);

      const first = await build(hostHooks.Stop);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const firstSettings = first.value.configFiles[2]!;
      expect(firstSettings.digest).toBe(await computeFileSha256(firstSettings.path));
      const firstDigest = firstSettings.digest;
      const firstFingerprint = first.value.launchFingerprint;

      const second = await build("/opt/bflow/host.js hook stop --changed");
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.configFiles[2]!.digest).not.toBe(firstDigest);
      expect(second.value.configFiles[2]!.digest).toBe(await computeFileSha256(firstSettings.path));
      expect(second.value.launchFingerprint).not.toBe(firstFingerprint);
    });
  });

  describe("10. Codex inherited global MCP servers and hooks (L3 isolation)", () => {
    const LIST_MCP = (names: readonly string[]): string =>
      JSON.stringify(
        names.map((name) => ({
          name,
          enabled: true,
          disabled_reason: null,
          transport: { type: "stdio", command: "/usr/bin/true", args: [], env: null, env_vars: [], cwd: null },
          startup_timeout_sec: null,
          tool_timeout_sec: null,
          auth_status: "unsupported"
        }))
      );

    function codexRunner(options: {
      readonly globalServers?: readonly string[];
      readonly listExit?: number;
      readonly invocations?: Array<readonly string[]>;
      readonly invocationEnvs?: Array<Readonly<Record<string, string | undefined>>>;
    }) {
      return createFakeProviderRunner({
        scenario: "healthy",
        customHandler: (invocation) => {
          options.invocations?.push([...invocation.args]);
          options.invocationEnvs?.push({ ...(invocation.env ?? {}) });
          if (invocation.args.slice(-3).join(" ") === "mcp list --json") {
            if ((options.listExit ?? 0) !== 0) {
              return { exitCode: options.listExit ?? 1, stdout: "", stderr: "list failed", started: true };
            }
            return { exitCode: 0, stdout: LIST_MCP(options.globalServers ?? []), stderr: "", started: true };
          }
          return undefined;
        }
      });
    }

    async function freshCodexHome(files: Record<string, string> = {}): Promise<string> {
      const home = join(testBaseDir, `codex-home-${Math.random().toString(36).slice(2)}`);
      await mkdir(home, { recursive: true, mode: 0o700 });
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(home, name), content, { mode: 0o600 });
      }
      return home;
    }

    function codexAdapter(
      runner: ReturnType<typeof createFakeProviderRunner>,
      codexHomeDirectory: string,
      extra?: {
        hostMcpServers?: Record<string, { command: string; args: string[] }>;
        trustedIssuerKeys?: Readonly<Record<string, string>>;
        liveObservation?: import("../src/types.js").LiveReadinessObservation;
      }
    ): CodexProviderAdapter {
      return new CodexProviderAdapter({
        runner,
        executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true,
        codexHomeDirectory,
        codexHookApprovalPath: join(testStateDir, "codex-hook-approvals.json"),
        ...(extra?.hostMcpServers ? { hostMcpServers: extra.hostMcpServers } : {}),
        ...(extra?.trustedIssuerKeys ? { trustedIssuerKeys: extra.trustedIssuerKeys } : {}),
        ...(extra?.liveObservation ? { liveObservation: extra.liveObservation } : {})
      });
    }

    const bflowServer = { bflow: { command: "/usr/bin/true", args: ["--serve"] } };

    it("disables the reviewed retired plugin in MCP enumeration, probes and launches without changing global config", async () => {
      const config = '[plugins."claude-mem@claude-mem-local"]\nenabled=true\n';
      const home = await freshCodexHome({ "config.toml": config });
      // A missing cache must not block when the exact plugin is disabled in every execution path.
      const invocations: Array<readonly string[]> = [];
      const adapter = codexAdapter(codexRunner({ globalServers: [], invocations }), home, { hostMcpServers: bflowServer });
      const env = createTestEnvironment("codex", "workspace_auto");
      const health = await adapter.checkHealth({ schemaVersion: 3, environment: env, stage: "preflight", requestedAt: new Date().toISOString() });
      expect(health.ok && health.value.status).toBe("ready");
      const disabled = "plugins.claude-mem@claude-mem-local.enabled=false";
      expect(invocations.find(args => args.includes("ping"))).toContain(disabled);
      expect(invocations.find(args => args.includes("mcp"))).toContain(disabled);
      const launch = await adapter.prepareLaunch(env);
      expect(launch.ok).toBe(true);
      if (launch.ok) {
        expect(launch.value.argv).toContain(disabled);
        expect(launch.value.argv).not.toContain('plugins."claude-mem@claude-mem-local".enabled=false');
      }
      expect(await readFile(join(home, "config.toml"), "utf8")).toBe(config);
    });

    it("keeps a retired plugin disabled when it is enabled during MCP enumeration", async () => {
      const home = await freshCodexHome();
      const invocations: Array<readonly string[]> = [];
      const fallback = createFakeProviderRunner({ scenario: "healthy" });
      const runner = { async run(invocation: Parameters<typeof fallback.run>[0]) {
        invocations.push([...invocation.args]);
        if (invocation.args.slice(-3).join(" ") === "mcp list --json") {
          await writeFile(join(home, "config.toml"), '[plugins."claude-mem@claude-mem-local"]\nenabled=true\n', { mode: 0o600 });
          return { exitCode: 0, stdout: "[]", stderr: "", started: true };
        }
        return fallback.run(invocation);
      } };
      const health = await codexAdapter(runner, home).checkHealth({ schemaVersion: 3,
        environment: createTestEnvironment("codex", "workspace_auto"), stage: "preflight", requestedAt: new Date().toISOString() });
      expect(health.ok && health.value.status).toBe("ready");
      expect(invocations.find(args => args.includes("ping"))).toContain("plugins.claude-mem@claude-mem-local.enabled=false");
    });

    it("disables exactly the global MCP servers after the Bflow mcp_servers table and leaves Bflow servers untouched", async () => {
      const home = await freshCodexHome({ "config.toml": "[mcp_servers.gitnexus]\ncommand = \"/usr/bin/true\"\n[mcp_servers.playwright]\ncommand = \"/usr/bin/true\"\n" });
      const adapter = codexAdapter(codexRunner({ globalServers: ["gitnexus", "playwright"] }), home, {
        hostMcpServers: bflowServer
      });
      const env = createTestEnvironment("codex", "workspace_auto");
      const result = await adapter.prepareLaunch(env);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const argv = result.value.argv;
      const tableIndex = argv.findIndex((arg) => arg.startsWith("mcp_servers="));
      const gitnexusIndex = argv.indexOf("mcp_servers.gitnexus.enabled=false");
      const playwrightIndex = argv.indexOf("mcp_servers.playwright.enabled=false");
      expect(tableIndex).toBeGreaterThanOrEqual(0);
      expect(gitnexusIndex).toBeGreaterThan(tableIndex);
      expect(playwrightIndex).toBeGreaterThan(tableIndex);
      expect(argv.filter((arg) => arg.startsWith("mcp_servers.") && arg.endsWith(".enabled=false"))).toEqual([
        "mcp_servers.gitnexus.enabled=false",
        "mcp_servers.playwright.enabled=false"
      ]);
      expect(argv.some((arg) => arg.includes("mcp_servers.bflow.enabled"))).toBe(false);
      expect(argv[tableIndex]).toContain('"bflow"');
    });

    it("never overrides plugin-provided MCP servers that have no config.toml table (live: invalid transport)", async () => {
      // Live finding (codex-cli 0.162.0): a Codex plugin can expose `mcp-search` without a config table;
      // `mcp_servers.mcp-search.enabled=false` made Codex abort loading its config.
      const home = await freshCodexHome({ "config.toml": "[mcp_servers.gitnexus]\ncommand = \"/usr/bin/true\"\n" });
      const adapter = codexAdapter(codexRunner({ globalServers: ["gitnexus", "mcp-search"] }), home, { hostMcpServers: bflowServer });
      const result = await adapter.prepareLaunch(createTestEnvironment("codex", "workspace_auto"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.argv.filter((arg) => arg.startsWith("mcp_servers.") && arg.endsWith(".enabled=false"))).toEqual(["mcp_servers.gitnexus.enabled=false"]);
      expect(result.value.argv.some((arg) => arg.includes("mcp-search"))).toBe(false);
    });

    it("adds no MCP disables when the user has no global MCP servers, while keeping retired plugins disabled", async () => {
      const home = await freshCodexHome();
      const adapter = codexAdapter(codexRunner({ globalServers: [] }), home, { hostMcpServers: bflowServer });
      const result = await adapter.prepareLaunch(createTestEnvironment("codex", "workspace_auto"));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.argv.some((arg) => arg.startsWith("mcp_servers.") && arg.endsWith(".enabled=false"))).toBe(false);
        expect(result.value.argv).toContain("plugins.claude-mem@claude-mem-local.enabled=false");
        expect(result.value.argv).toContain("plugins.claude-mem@thedotmack.enabled=false");
      }
    });

    it("changes the launch fingerprint when the global MCP server set changes", async () => {
      const home = await freshCodexHome({ "config.toml": "[mcp_servers.gitnexus]\ncommand = \"/usr/bin/true\"\n[mcp_servers.playwright]\ncommand = \"/usr/bin/true\"\n" });
      const env = createTestEnvironment("codex", "workspace_auto");
      const first = await codexAdapter(codexRunner({ globalServers: ["gitnexus"] }), home, {
        hostMcpServers: bflowServer
      }).prepareLaunch(env);
      const second = await codexAdapter(codexRunner({ globalServers: ["gitnexus", "playwright"] }), home, {
        hostMcpServers: bflowServer
      }).prepareLaunch(env);
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.value.launchFingerprint).not.toBe(first.value.launchFingerprint);
      }
    });

    it("passes the same isolation arguments to the readiness probe so global servers are not started there", async () => {
      const home = await freshCodexHome({ "config.toml": "[mcp_servers.gitnexus]\ncommand = \"/usr/bin/true\"\n" });
      const invocations: Array<readonly string[]> = [];
      const adapter = codexAdapter(
        codexRunner({ globalServers: ["gitnexus"], invocations }),
        home,
        { hostMcpServers: bflowServer }
      );
      const health = await adapter.checkHealth({
        schemaVersion: 3,
        environment: createTestEnvironment("codex", "workspace_auto"),
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(health.ok).toBe(true);
      if (health.ok) expect(health.value.status).toBe("ready");
      const probe = invocations.find((args) => args.includes("ping"));
      expect(probe).toEqual(["-c", "plugins.claude-mem@claude-mem-local.enabled=false",
        "-c", "plugins.claude-mem@thedotmack.enabled=false", "-c", "mcp_servers.gitnexus.enabled=false", "exec", "ping"]);
    });

    it("fails closed with codex_global_mcp_not_isolated when a global server name cannot be disabled safely", async () => {
      const home = await freshCodexHome({ "config.toml": "[mcp_servers.\"my.server\"]\ncommand = \"/usr/bin/true\"\n" });
      const adapter = codexAdapter(codexRunner({ globalServers: ["my.server"] }), home, { hostMcpServers: bflowServer });
      const env = createTestEnvironment("codex", "workspace_auto");

      const launch = await adapter.prepareLaunch(env);
      expect(launch.ok).toBe(false);
      if (!launch.ok) expect(launch.error.message).toContain("codex_global_mcp_not_isolated");

      const health = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.status).toBe("blocked");
        const mcp = health.value.checks.find((check) => check.check === "mcp");
        expect(mcp?.status).toBe("failed");
        expect(mcp?.code).toBe("codex_global_mcp_not_isolated");
        expect(mcp?.remediation).toBeTruthy();
      }
    });

    it("fails closed when a global server shares a name with a Bflow launch server", async () => {
      const home = await freshCodexHome({ "config.toml": "[mcp_servers.bflow]\ncommand = \"/usr/bin/true\"\n" });
      const adapter = codexAdapter(codexRunner({ globalServers: ["bflow"] }), home, { hostMcpServers: bflowServer });
      const launch = await adapter.prepareLaunch(createTestEnvironment("codex", "workspace_auto"));
      expect(launch.ok).toBe(false);
      if (!launch.ok) expect(launch.error.message).toContain("codex_global_mcp_not_isolated");
    });

    it("fails closed when the global MCP servers cannot be enumerated at all", async () => {
      // config.toml exists but is unreadable as a file, so neither the list nor the fallback can establish the set.
      const home = await freshCodexHome();
      await mkdir(join(home, "config.toml"), { recursive: true });
      const adapter = codexAdapter(codexRunner({ listExit: 1 }), home, { hostMcpServers: bflowServer });
      const launch = await adapter.prepareLaunch(createTestEnvironment("codex", "workspace_auto"));
      expect(launch.ok).toBe(false);
      if (!launch.ok) expect(launch.error.message).toContain("codex_global_mcp_not_isolated");
    });

    it("falls back to config.toml table names when codex mcp list fails and disables them", async () => {
      const home = await freshCodexHome({
        "config.toml": [
          'model = "gpt-5"',
          "[mcp_servers.gitnexus]",
          'url = "http://127.0.0.1:8932/mcp"',
          '[mcp_servers."chrome.devtools".env]',
          'FOO = "bar"',
          "[mcp_servers.playwright]",
          'command = "npx"'
        ].join("\n")
      });
      const adapter = codexAdapter(codexRunner({ listExit: 1 }), home, { hostMcpServers: bflowServer });
      const launch = await adapter.prepareLaunch(createTestEnvironment("codex", "workspace_auto"));
      expect(launch.ok).toBe(false);
      // The quoted dotted name cannot be disabled through the dotted override, so the fallback fails closed for it.
      if (!launch.ok) expect(launch.error.message).toContain("codex_global_mcp_not_isolated");

      const homeOk = await freshCodexHome({
        "config.toml": "[mcp_servers.gitnexus]\nurl = \"http://127.0.0.1:8932/mcp\"\n\n[mcp_servers.playwright]\ncommand = \"npx\"\n"
      });
      const okLaunch = await codexAdapter(codexRunner({ listExit: 1 }), homeOk, {
        hostMcpServers: bflowServer
      }).prepareLaunch(createTestEnvironment("codex", "workspace_auto"));
      expect(okLaunch.ok).toBe(true);
      if (okLaunch.ok) {
        expect(okLaunch.value.argv).toEqual(
          expect.arrayContaining(["mcp_servers.gitnexus.enabled=false", "mcp_servers.playwright.enabled=false"])
        );
      }
    });

    it("fails closed with codex_global_hooks_not_isolated when hooks.json defines global hooks", async () => {
      const script = join(testBaseDir, "personal-hook.sh");
      await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const home = await freshCodexHome({
        "hooks.json": JSON.stringify({
          hooks: { Stop: [{ hooks: [{ type: "command", command: script }] }] }
        })
      });
      const invocations: Array<readonly string[]> = [];
      const adapter = codexAdapter(codexRunner({ globalServers: [], invocations }), home);
      const env = createTestEnvironment("codex", "workspace_auto");

      const launch = await adapter.prepareLaunch(env);
      expect(launch.ok).toBe(false);
      if (!launch.ok) expect(launch.error.message).toContain("codex_global_hooks_approval_required");

      const health = await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.status).toBe("blocked");
        const auth = health.value.checks.find((check) => check.check === "authentication");
        expect(auth?.code).toBe("codex_global_hooks_approval_required");
      }
      expect(invocations.some(args => args.includes("ping"))).toBe(false);
      expect(invocations.some(args => args[0] === "login")).toBe(false);
    });

    it("fails closed when config.toml defines hooks inline", async () => {
      const home = await freshCodexHome({
        "config.toml": `[hooks]\nInterrupt = [{ hooks = [{ type = "command", command = ${JSON.stringify(fakeBinaryPath)} }] }]\n`
      });
      const adapter = codexAdapter(codexRunner({ globalServers: [] }), home);
      const launch = await adapter.prepareLaunch(createTestEnvironment("codex", "workspace_auto"));
      expect(launch.ok).toBe(false);
      if (!launch.ok) expect(launch.error.message).toContain("codex_global_hooks_approval_required");
    });

    it("treats an empty hooks.json as no global hooks", async () => {
      const home = await freshCodexHome({ "hooks.json": JSON.stringify({ hooks: {} }) });
      const adapter = codexAdapter(codexRunner({ globalServers: [] }), home, { hostMcpServers: bflowServer });
      const launch = await adapter.prepareLaunch(createTestEnvironment("codex", "workspace_auto"));
      expect(launch.ok).toBe(true);
    });

    it("permits operator-trusted unsupported hooks while retaining provider permissions and MCP isolation", async () => {
      const home = await freshCodexHome({ "hooks.json": "uninspectable hook configuration",
        "config.toml": '[mcp_servers.external]\ncommand = "/usr/bin/true"\n' });
      await chmod(join(home, "hooks.json"), 0o777);
      const runner = codexRunner({ globalServers: ["external"] });
      const hostHooks = { SessionStart: "/opt/bflow/session-start", PreToolUse: "/opt/bflow/check-tool" };
      const adapter = new CodexProviderAdapter({ runner, executablePath: fakeBinaryPath, allowTestFilesystemOwnership: true,
        codexHomeDirectory: home, codexHookApprovalPath: join(testStateDir, "codex-hook-approvals.json"),
        hostMcpServers: bflowServer, hostHooks });
      const env = createTestEnvironment("codex", "workspace_auto");
      expect((await adapter.prepareLaunch(env)).ok).toBe(false);
      const options = { codexHomeDirectory: home, approvalStorePath: join(testStateDir, "codex-hook-approvals.json") };
      await trustAllCodexHooks({ ...options, approvedBy: "operator" });
      const prepared = await adapter.prepareLaunch(env);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.value.argv).toContain("mcp_servers.external.enabled=false");
      expect(prepared.value.argv).toContain("--dangerously-bypass-hook-trust");
      expect(prepared.value.argv).toContain("workspace-write");
      const settings = JSON.parse(await readFile(prepared.value.configFiles.find(file => file.path.endsWith(".settings.json"))!.path, "utf8"));
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(hostHooks.PreToolUse);
      const before = await inspectCodexHooks(options);
      await writeFile(join(home, "hooks.json"), "future uninspectable hooks");
      expect((await inspectCodexHooks(options)).digest).toBe(before.digest);
      expect((await adapter.prepareLaunch(env)).ok).toBe(true);
      await revokeAllCodexHookTrust(options);
      expect((await adapter.prepareLaunch(env)).ok).toBe(false);
    });

    it("runs probes only after exact approval and blocks activation when an approved snapshot drifts", async () => {
      const script = join(testBaseDir, "approved-hook.sh");
      await writeFile(script, "#!/bin/sh\nprintf 'first\\n'\n", { mode: 0o700 });
      const home = await freshCodexHome({
        "hooks.json": JSON.stringify({ hooks: { SessionStart: [{ matcher: "codex", hooks: [{ type: "command", command: script }] }] } })
      });
      const hookEnvironment = { HOME: testBaseDir, PATH: process.env["PATH"] ?? "/usr/bin:/bin", ORCA_AGENT_HOOK_ROOT: "", ORCA_AGENT_HOOK_ENDPOINT: "" };
      const options = { codexHomeDirectory: home, approvalStorePath: join(testStateDir, "codex-hook-approvals.json"), environment: hookEnvironment };
      const before = await inspectCodexHooks(options);
      await approveCodexHooks(before, { ...options, expectedDigest: before.digest, approvedBy: "test-operator" });
      const invocations: Array<readonly string[]> = [];
      const invocationEnvs: Array<Readonly<Record<string, string | undefined>>> = [];
      const runner = codexRunner({ globalServers: [], invocations, invocationEnvs });
      const observation = { paneId: "pane-hook-test", transportState: "idle" as const, interactiveReady: true };
      const adapter = new CodexProviderAdapter({ runner, executablePath: fakeBinaryPath, allowTestFilesystemOwnership: true,
        codexHomeDirectory: home, codexHookApprovalPath: options.approvalStorePath, trustedIssuerKeys: { [testIssuerId]: testPublicKeyPem },
        codexHookEnvironment: hookEnvironment,
        liveObservation: observation });
      const env = createTestEnvironment("codex", "workspace_auto");
      const health = await adapter.checkHealth({ schemaVersion: 3, environment: env, stage: "preflight", requestedAt: new Date().toISOString() });
      expect(health.ok && health.value.status).toBe("ready");
      expect(invocations.some(args => args.includes("ping"))).toBe(true);
      expect(invocationEnvs.find((env, index) => invocations[index]?.includes("ping"))).toMatchObject({ CODEX_HOME: home });
      expect(invocationEnvs.find((env, index) => invocations[index]?.includes("ping"))).toMatchObject({ HOME: testBaseDir, ORCA_AGENT_HOOK_ROOT: "", ORCA_AGENT_HOOK_ENDPOINT: "" });
      const prepared = await adapter.prepareLaunch(env);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      const attestation = createSignedLaunchAttestation({ receiptId: "hook-trust-receipt", issuerId: testIssuerId,
        launchId: prepared.value.launchId, launchFingerprint: prepared.value.launchFingerprint, sessionId: env.scope.sessionId,
        paneId: observation.paneId, nativeSession: { source: "codex", kind: "id", value: "codex-native-session" },
        observedAt: new Date().toISOString(), privateKeyPem: testPrivateKeyPem });

      await writeFile(script, "#!/bin/sh\nprintf 'second\\n'\n", { mode: 0o700 });
      const changed = await inspectCodexHooks(options);
      await approveCodexHooks(changed, { ...options, expectedDigest: changed.digest, approvedBy: "test-operator" });
      const activated = await adapter.checkHealth({ schemaVersion: 3, environment: env, stage: "activated",
        launchProfile: prepared.value, launchAttestation: attestation, requestedAt: new Date().toISOString() });
      expect(activated.ok).toBe(true);
      if (activated.ok) {
        expect(activated.value.status).toBe("blocked");
        expect(activated.value.checks.find(check => check.code === "codex_global_hooks_snapshot_drift")).toBeDefined();
      }
    });

    it.each([false, true])("rejects hook changes during launch preparation even when newly approved: %s", async reapprove => {
      const script = join(testBaseDir, `changing-hook-${reapprove}.sh`);
      await writeFile(script, "#!/bin/sh\nprintf first\n", { mode: 0o700 });
      const home = await freshCodexHome({ "hooks.json": JSON.stringify({ hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: script }] }]
      } }) });
      const hookEnvironment = { HOME: testBaseDir, PATH: process.env.PATH ?? "/usr/bin:/bin", ORCA_AGENT_HOOK_ROOT: "", ORCA_AGENT_HOOK_ENDPOINT: "" };
      const options = { codexHomeDirectory: home, approvalStorePath: join(testStateDir, "codex-hook-approvals.json"), environment: hookEnvironment };
      const reviewed = await inspectCodexHooks(options);
      await approveCodexHooks(reviewed, { ...options, expectedDigest: reviewed.digest, approvedBy: "test-operator" });
      class ChangingAdapter extends CodexProviderAdapter {
        protected override async compileArgv(environment: AgentEnvironment,
          files: { promptFile: string; mcpConfigFile: string; settingsFile: string },
          capabilities: DetectedProviderCapabilities, inherited: InheritedIsolation) {
          const compiled = await super.compileArgv(environment, files, capabilities, inherited);
          await writeFile(script, "#!/bin/sh\nprintf changed\n");
          if (reapprove) {
            const changed = await inspectCodexHooks(options);
            await approveCodexHooks(changed, { ...options, expectedDigest: changed.digest, approvedBy: "test-operator" });
          }
          return compiled;
        }
      }
      const adapter = new ChangingAdapter({ runner: codexRunner({ globalServers: [] }), executablePath: fakeBinaryPath,
        allowTestFilesystemOwnership: true, codexHomeDirectory: home, codexHookApprovalPath: options.approvalStorePath,
        codexHookEnvironment: hookEnvironment });
      const result = await adapter.prepareLaunch(createTestEnvironment("codex", "workspace_auto"));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/changed|approval_required/);
    });

    it("writes nothing into the user Codex home (only the adapter state directory is written)", async () => {
      const home = await freshCodexHome({
        "config.toml": "[mcp_servers.gitnexus]\nurl = \"http://127.0.0.1:8932/mcp\"\n"
      });
      const listFiles = async (dir: string): Promise<string[]> => {
        const out: string[] = [];
        for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
          if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
        }
        return out.sort();
      };
      const before = await listFiles(home);
      const beforeContent = await readFile(join(home, "config.toml"), "utf8");

      const adapter = codexAdapter(codexRunner({ globalServers: ["gitnexus"] }), home, { hostMcpServers: bflowServer });
      const env = createTestEnvironment("codex", "workspace_auto");
      await adapter.checkHealth({
        schemaVersion: 3,
        environment: env,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      const launch = await adapter.prepareLaunch(env);
      expect(launch.ok).toBe(true);

      expect(await listFiles(home)).toEqual(before);
      expect(await readFile(join(home, "config.toml"), "utf8")).toBe(beforeContent);
    });
  });
});
