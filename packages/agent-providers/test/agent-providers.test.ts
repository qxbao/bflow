import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  ClaudeProviderAdapter,
  CodexProviderAdapter,
  createDefaultProviderRegistry,
  createFakeProviderRunner,
  createHealthCheck,
  createProviderProcessRunner,
  computeFileSha256,
  createSignedLaunchAttestation,
  formatProviderDiagnosticReport,
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
  let fakeBinaryPath: string;
  let testIssuerId: string;
  let testPrivateKeyPem: string;
  let testPublicKeyPem: string;

  beforeAll(async () => {
    testBaseDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-provider-tests-")));
    testCwd = join(testBaseDir, "workspace");
    testStateDir = join(testBaseDir, "state");

    await mkdir(testCwd, { recursive: true, mode: 0o700 });
    await mkdir(testStateDir, { recursive: true, mode: 0o700 });

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
      }
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
        `${quote("args")}=[${["/opt/bflow/host.js", "mcp", "/opt/bflow/developer.json"].map(quote).join(",")}]},` +
        `${quote("gateway-dev")}={${quote("url")}=${quote("http://127.0.0.1:4317/mcp")},` +
        `${quote("bearer_token_env_var")}=${quote("BFLOW_GATEWAY_TOKEN")}}}`;
      expect(argv).toContain(expectedMcp);

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
});
