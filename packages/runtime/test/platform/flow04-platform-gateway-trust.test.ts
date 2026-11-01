import { createServer, type Server } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MCPClientRegistrationSchema,
  MCPResourceLeaseSchema,
  type MCPResourceLease,
  type MCPToolCall,
  type OperationResult
} from "@bflow/contracts";
import {
  createFakeProviderRunner,
  ensureCodexWorkspaceTrust,
  isCodexWorkspaceTrusted
} from "@bflow/agent-providers";
import { SkillFileStore, SkillManager, bundleDigest, type BundleFiles } from "@bflow/skills";
import { Ed25519LaunchAttestationSigner } from "../../src/platform/attestation-signer.js";
import { BrowserResourceTransactions } from "../../src/platform/browser-resource-transactions.js";
import { createProviderAdapterFactory, createSkillResolver } from "../../src/platform/defaults.js";
import { RoleEnvironmentResolver } from "../../src/platform/environment.js";
import { ok } from "../../src/platform/errors.js";
import { GatewayControlClient } from "../../src/platform/gateway-control-client.js";
import { FileLaunchJournal } from "../../src/platform/launch-journal.js";
import type { GatewayControlPort, PlatformSessionIdentity } from "../../src/platform/ports.js";
import { ProviderReadiness } from "../../src/platform/provider-readiness.js";
import { DefaultPlatformReadinessService } from "../../src/platform/service.js";
import { SkillSessionStore } from "../../src/platform/skills-session.js";

describe("Flow-04 platform dynamic worktree trust, GatewayControlClient 4 MiB framing, and expired stale_lease cleanup", () => {
  let baseDir: string;
  const servers: Server[] = [];

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow04-plat-")));
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        server =>
          new Promise<void>(resolve => {
            server.close(() => resolve());
          })
      )
    );
    await rm(baseDir, { recursive: true, force: true });
  });

  async function buildMinimalSkills() {
    const skillRoot = join(baseDir, "skills");
    const headings = [
      "Supported roles",
      "Prerequisites",
      "Trigger conditions",
      "Required inputs",
      "Expected outputs",
      "Procedure",
      "Bflow commands",
      "Verification requirements",
      "Error handling",
      "Escalation rules",
      "Concrete examples"
    ];
    const files: BundleFiles = {
      "SKILL.md": `---\nname: flow04-skill\ndescription: Inspect an assigned task before implementation.\n---\n\n${headings
        .map(h => `## ${h}\n\nUse the accepted task and preserve Runtime authority.`)
        .join("\n\n")}\n`,
      "skill.json": JSON.stringify({
        version: "1.0.0",
        allowedRoles: ["developer"],
        supportedProviders: ["claude", "codex", "agy"],
        requiredCapabilityIds: [],
        requiredToolIds: [],
        dependencies: []
      })
    };
    const digest = bundleDigest(files);
    const manager = new SkillManager({
      store: new SkillFileStore(skillRoot),
      supportedCommands: ["status", "help", "doctor"],
      approvedBuiltinDigests: [digest]
    });
    const installed = await manager.installBundle(files, {
      source: "builtin",
      expectedDigest: digest
    });
    return {
      skills: new SkillSessionStore({ resolver: createSkillResolver(manager) }),
      pin: {
        skillId: installed.skillId,
        version: installed.version,
        digest: installed.digest
      }
    };
  }

  it("propagates workspaceRoot trust to dynamic Developer worktrees for Codex (native_auth_compatible & isolator) and Claude, and injects MCP_TOOL_TIMEOUT with override support", async () => {
    const workspaceRoot = join(baseDir, "repo");
    const worktreeNative = join(workspaceRoot, ".bflow", "worktrees", "task-native");
    const worktreeIsolator = join(workspaceRoot, ".bflow", "worktrees", "task-isolator");
    const worktreeClaude = join(workspaceRoot, ".bflow", "worktrees", "task-claude");
    for (const dir of [workspaceRoot, worktreeNative, worktreeIsolator, worktreeClaude]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    }

    const codexBin = join(baseDir, "codex");
    const claudeBin = join(baseDir, "claude");
    await writeFile(codexBin, "#!/bin/sh\necho codex\n", { mode: 0o700 });
    await writeFile(claudeBin, "#!/bin/sh\necho claude\n", { mode: 0o700 });

    // 1. Native OAuth Codex home (no static API key -> native_auth_compatible)
    const nativeProcessHome = join(baseDir, "native-home");
    const nativeCodexHome = join(nativeProcessHome, ".codex");
    await mkdir(nativeCodexHome, { recursive: true, mode: 0o700 });
    await writeFile(
      join(nativeCodexHome, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt_123" } }),
      { mode: 0o600 }
    );
    const nativeConfig = join(nativeCodexHome, "config.toml");
    expect(await ensureCodexWorkspaceTrust(workspaceRoot, nativeConfig)).toBe("trusted");

    // 2. Isolator Codex profile
    const isolatorRoot = join(baseDir, "isolator");
    const isolatorProfileRoot = join(isolatorRoot, "profiles", "codex--team");
    for (const sub of ["home", "config", "cache", "data", "state", "tmp"]) {
      await mkdir(join(isolatorProfileRoot, sub), { recursive: true, mode: 0o700 });
    }
    const isolatorCodexHome = join(isolatorProfileRoot, "home", ".codex");
    await mkdir(isolatorCodexHome, { recursive: true, mode: 0o700 });
    await writeFile(
      join(isolatorProfileRoot, "profile.env"),
      "AI_ISOLATOR_TOOL=codex\nAI_ISOLATOR_PROFILE=team\nAI_ISOLATOR_CREATED_AT=2026-10-20T00:00:00Z\n",
      { mode: 0o600 }
    );
    const isolatorConfig = join(isolatorCodexHome, "config.toml");
    expect(await ensureCodexWorkspaceTrust(workspaceRoot, isolatorConfig)).toBe("trusted");

    // 3. Claude home with workspaceRoot trusted
    const claudeHome = join(baseDir, "claude-home");
    const claudeConfigDir = join(claudeHome, ".claude");
    await mkdir(claudeConfigDir, { recursive: true, mode: 0o700 });
    const claudeStateFile = join(claudeConfigDir, ".claude.json");
    await writeFile(
      claudeStateFile,
      JSON.stringify({ projects: { [workspaceRoot]: { hasTrustDialogAccepted: true } } }),
      { mode: 0o600 }
    );

    const { skills, pin } = await buildMinimalSkills();
    const stateDirectory = join(baseDir, "platform-state");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const journal = new FileLaunchJournal(join(stateDirectory, "journal.jsonl"));
    const providers = new ProviderReadiness({
      factory: createProviderAdapterFactory({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        perProvider: {
          codex: { executablePath: codexBin, allowTestFilesystemOwnership: true },
          claude: { executablePath: claudeBin, allowTestFilesystemOwnership: true }
        }
      }),
      journal
    });
    const service = new DefaultPlatformReadinessService({
      isolatorStateRoot: isolatorRoot,
      codexLaunchEnvironment: { HOME: nativeProcessHome, CODEX_HOME: nativeCodexHome },
      environments: new RoleEnvironmentResolver(),
      skills,
      providers,
      journal,
      signer: Ed25519LaunchAttestationSigner.generate("flow04-host"),
      rolePrompt: role => `Role prompt for ${role}.`,
      hostLaunch: () => ({
        mcpServers: {
          bflow: { command: process.execPath, args: ["/opt/bflow/host.js", "mcp", "/opt/bflow/role.json"] }
        }
      })
    });

    const identity: PlatformSessionIdentity = {
      machineId: "machine-1",
      repositoryId: "repo-1",
      workspaceRoot,
      sessionId: "sess-flow04",
      generation: 1,
      stateDirectory
    };

    const devNative = await service.prepareDeveloper(identity, {
      role: "developer",
      provider: "codex",
      required: true,
      taskId: "t-native",
      cwd: worktreeNative,
      permissionMode: "workspace_auto",
      capabilityIds: [],
      mcpServiceIds: [],
      toolIds: [],
      skillSelections: [{ skill: pin, required: true }]
    });
    expect(devNative.ok).toBe(true);
    expect(await isCodexWorkspaceTrusted(worktreeNative, nativeConfig)).toBe(true);

    const devIsolator = await service.prepareDeveloper(identity, {
      role: "developer",
      provider: "codex",
      profileName: "team",
      required: true,
      taskId: "t-isolator",
      cwd: worktreeIsolator,
      permissionMode: "workspace_auto",
      capabilityIds: [],
      mcpServiceIds: [],
      toolIds: [],
      skillSelections: [{ skill: pin, required: true }]
    });
    expect(devIsolator.ok).toBe(true);
    expect(await isCodexWorkspaceTrusted(worktreeIsolator, isolatorConfig)).toBe(true);

    const prevHome = process.env["HOME"];
    const prevClaudeDir = process.env["CLAUDE_CONFIG_DIR"];
    process.env["HOME"] = claudeHome;
    process.env["CLAUDE_CONFIG_DIR"] = claudeConfigDir;
    try {
      const devClaude = await service.prepareDeveloper(identity, {
        role: "developer",
        provider: "claude",
        required: true,
        taskId: "t-claude",
        cwd: worktreeClaude,
        permissionMode: "workspace_auto",
        capabilityIds: [],
        mcpServiceIds: [],
        toolIds: [],
        skillSelections: [{ skill: pin, required: true }]
      });
      expect(devClaude.ok).toBe(true);
      if (devClaude.ok) {
        expect(devClaude.value.launch.env["MCP_TIMEOUT"]).toBe("120000");
        expect(devClaude.value.launch.env["MCP_TOOL_TIMEOUT"]).toBe("600000");
      }

      const devClaudeCustom = await service.prepareDeveloper(identity, {
        role: "developer",
        provider: "claude",
        required: true,
        taskId: "t-claude-custom",
        cwd: worktreeClaude,
        permissionMode: "workspace_auto",
        capabilityIds: [],
        mcpServiceIds: [],
        toolIds: [],
        skillSelections: [{ skill: pin, required: true }],
        environmentVariables: { MCP_TOOL_TIMEOUT: "900000" }
      });
      expect(devClaudeCustom.ok).toBe(true);
      if (devClaudeCustom.ok) {
        expect(devClaudeCustom.value.launch.env["MCP_TOOL_TIMEOUT"]).toBe("900000");
      }
    } finally {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      if (prevClaudeDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = prevClaudeDir;
    }

    const updatedClaudeState = JSON.parse(await readFile(claudeStateFile, "utf8")) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(updatedClaudeState.projects[worktreeClaude]?.hasTrustDialogAccepted).toBe(true);
  });

  it("GatewayControlClient handles >1 MiB multi-chunk split-UTF-8 replies up to 4 MiB, rejects >4 MiB, and enforces expired deadlines", async () => {
    const shortDir = await mkdtemp(join("/tmp", "bf04-gwc-"));
    try {
      const socketPath = join(shortDir, "gw.sock");
      const token = "a".repeat(64);
      const generation = "gen-flow04-1234567890";
      const locatorPath = join(shortDir, "locator.json");
      await writeFile(
        locatorPath,
        JSON.stringify({
          socketPath,
          token,
          generation,
          endpoint: "http://127.0.0.1:4317/mcp"
        }),
        { mode: 0o600 }
      );
      await chmod(locatorPath, 0o600);

      let mode: "large-utf8" | "oversized" = "large-utf8";
      const largePayload = `Kết quả kiểm tra 🚀 ${"x".repeat(1_800_000)}`;
      const server = createServer(socket => {
        let reqBuf = "";
        socket.on("data", chunk => {
          reqBuf += chunk.toString("utf8");
          if (!reqBuf.includes("\n")) return;
          if (mode === "oversized") {
            socket.write(`{"ok":true,"value":"${"z".repeat(4 * 1024 * 1024 + 128)}"}\n`);
            return;
          }
          const reply = Buffer.from(
            `${JSON.stringify({
              ok: true,
              value: {
                schemaVersion: 3,
                callId: "call-large-1",
                status: "completed",
                output: { snapshot: largePayload },
                observedAt: "2026-10-31T00:00:00.000Z"
              }
            })}\n`,
            "utf8"
          );
          // Split right inside the 4-byte emoji UTF-8 sequence!
          const emojiIdx = reply.indexOf(Buffer.from("🚀", "utf8"));
          const splitPoint = emojiIdx + 2;
          socket.write(reply.subarray(0, splitPoint));
          setTimeout(() => {
            socket.write(reply.subarray(splitPoint));
          }, 10);
        });
      });
      servers.push(server);
      await new Promise<void>(resolve => server.listen(socketPath, resolve));

      const opened = await GatewayControlClient.fromLocator(locatorPath);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const client = opened.value;

      const callReq: MCPToolCall = {
        schemaVersion: 3,
        callId: "call-large-1",
        idempotencyKey: "call-large-1",
        registrationId: "reg-1",
        serviceId: "chrome-devtools",
        tool: "take_snapshot",
        input: {}
      };

      // 1. Expired deadline fails closed before dispatch with retrySafety: "not_started"
      const expired = await client.invokeTool(callReq, {
        deadline: new Date(Date.now() - 1000).toISOString()
      });
      expect(expired).toMatchObject({
        ok: false,
        error: { code: "timeout", retrySafety: "not_started" }
      });

      // 2. ~1.8 MiB split-UTF-8 reply succeeds intact
      const largeRes = await client.invokeTool(callReq, { timeoutMs: 10_000 });
      expect(largeRes.ok).toBe(true);
      if (largeRes.ok) {
        expect((largeRes.value.output as { snapshot: string }).snapshot).toBe(largePayload);
      }

      // 3. >4 MiB reply fails closed with corruption
      mode = "oversized";
      const oversizedRes = await client.invokeTool(callReq, { timeoutMs: 10_000 });
      expect(oversizedRes).toMatchObject({
        ok: false,
        error: { code: "corruption" }
      });
    } finally {
      await rm(shortDir, { recursive: true, force: true });
    }
  });

  it("BrowserResourceTransactions.finish closes settled transactions whose expired lease was superseded (stale_lease), while rejecting non-expired stale_lease", async () => {
    const scope = {
      kind: "session" as const,
      machineId: "machine-1",
      repositoryId: "repo-1",
      workspaceRoot: "/repo",
      sessionId: "session-1"
    };
    const identity: PlatformSessionIdentity = {
      ...scope,
      generation: 1,
      stateDirectory: join(baseDir, "browser-tx")
    };
    let now = new Date("2026-10-31T10:00:00.000Z");
    const reg = MCPClientRegistrationSchema.parse({
      schemaVersion: 3,
      registrationId: "reg-qa",
      role: "qa",
      provider: "claude",
      environmentId: "env-qa",
      scope,
      serviceIds: ["chrome-service"],
      allowedTools: ["navigate_page"],
      configDigest: "a".repeat(64),
      expiresAt: "2026-10-31T12:00:00.000Z",
      idempotencyKey: "reg-qa",
      connection: {
        transport: "streamable_http",
        endpoint: "http://127.0.0.1:7777/mcp",
        token: "secret://bflow/test"
      }
    });

    let activeLease: MCPResourceLease | undefined;
    let returnStaleLeaseOnRelease = false;
    const control: GatewayControlPort = {
      register: async () => {
        throw new Error("unused");
      },
      revoke: async () => ok(undefined),
      list: async () => ok([]),
      inspectServices: async () => ok([]),
      async acquireResource(request) {
        activeLease = MCPResourceLeaseSchema.parse({
          schemaVersion: 3,
          leaseId: "lease-1",
          registrationId: request.registrationId,
          serviceId: request.serviceId,
          resourceKey: request.resourceKey,
          fencingToken: 1,
          acquiredAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60_000).toISOString()
        });
        return ok(activeLease);
      },
      async renewResource(request) {
        activeLease = MCPResourceLeaseSchema.parse({
          ...request.lease,
          expiresAt: new Date(now.getTime() + 60_000).toISOString()
        });
        return ok(activeLease);
      },
      async releaseResource() {
        if (returnStaleLeaseOnRelease) {
          return {
            ok: false,
            error: {
              code: "conflict",
              retryable: false,
              message: "Lease superseded by fencing token 2",
              details: { diagnosticCode: "stale_lease" }
            }
          };
        }
        return ok(undefined);
      },
      async invokeTool(request) {
        return ok({
          schemaVersion: 3,
          callId: request.callId,
          status: "completed",
          output: {},
          observedAt: now.toISOString()
        });
      },
      async reconcileToolCall(request) {
        return ok({
          schemaVersion: 3,
          callId: request.callId,
          status: "completed",
          output: {},
          observedAt: now.toISOString()
        });
      }
    };

    const transactions = new BrowserResourceTransactions(control, () => now);
    const call: MCPToolCall = {
      schemaVersion: 3,
      callId: "call-1",
      idempotencyKey: "call-1",
      registrationId: reg.registrationId,
      serviceId: "chrome-service",
      tool: "navigate_page",
      input: { url: "https://example.test" }
    };
    const invoked = await transactions.invoke(
      identity,
      reg,
      call,
      { id: "tx-1", resourceKey: "chrome-profile" },
      false
    );
    expect(invoked.ok).toBe(true);

    // 1. Before lease expiry, stale_lease conflict is NOT silently closed
    returnStaleLeaseOnRelease = true;
    const prematureFinish = await transactions.finish(identity, "qa", "tx-1");
    expect(prematureFinish.ok).toBe(false);

    // 2. Once lease has expired and all calls are settled, superseded stale_lease closes cleanly!
    now = new Date(now.getTime() + 120_000);
    const expiredFinish = await transactions.finish(identity, "qa", "tx-1");
    expect(expiredFinish).toEqual(ok(undefined));
  });
});
