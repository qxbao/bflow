import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgyProviderAdapter,
  ClaudeProviderAdapter,
  CodexProviderAdapter,
  createDefaultProviderRegistry,
  createProviderProcessRunner,
  createSignedLaunchAttestation
} from "@bflow/agent-providers";
import { environmentProcessRunner, namedSessionEnvironment } from "@bflow/cli";
import {
  CURRENT_PLATFORM_SCHEMA_VERSION,
  type AgentEnvironment,
  type AgentProviderId,
  type MCPClientRegistration,
  type MCPServiceObservation,
  type SkillManifest
} from "@bflow/contracts";
import { afterEach, describe, expect, it } from "vitest";

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

describe("Scenario E12 (Group B) — Agent Providers Verification (Claude, Codex, Agy)", () => {
  const tempDirs: string[] = [];

  function makeTempDir(prefix = "bflow-e12-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    chmodSync(dir, 0o700);
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function makeScope(workspaceRoot: string) {
    return {
      kind: "session" as const,
      machineId: "machine-e12-01",
      repositoryId: "repo-e12-01",
      workspaceRoot,
      sessionId: "sess-e12-01"
    };
  }

  function makeEnvironment(
    provider: AgentProviderId,
    workspaceRoot: string,
    stateDir: string,
    options?: {
      mode?: "restricted" | "workspace_auto" | "unattended_isolated";
      isolation?: "provider_policy" | "os_sandbox" | "container";
      skillManifestDigest?: string;
      requiredMcpServiceIds?: string[];
    }
  ): AgentEnvironment {
    const scope = makeScope(workspaceRoot);
    const mode = options?.mode ?? "workspace_auto";
    const filesystem = mode === "restricted" ? ("read_only" as const) : ("workspace_write" as const);
    const isolation =
      options?.isolation ?? (mode === "unattended_isolated" ? ("os_sandbox" as const) : ("provider_policy" as const));

    return {
      schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
      environmentId: `env-${provider}-${mode}`,
      provider,
      role: "developer",
      scope,
      cwd: workspaceRoot,
      stateDirectory: stateDir,
      configFingerprint: sha256Hex(`cfg-${provider}-${mode}-${workspaceRoot}`),
      permissionProfile: {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        profileId: `prof-${provider}-${mode}`,
        mode,
        scope,
        filesystem,
        readableRoots: [workspaceRoot],
        writableRoots: filesystem === "workspace_write" ? [workspaceRoot] : [],
        deniedRoots: ["/etc"],
        isolation,
        network: { mode: "deny", allowedHosts: [] },
        allowedTools: ["Read", "Edit", "Bash"],
        deniedAction: "request_via_conversation",
        allowGlobalPermissionBypass: false
      },
      environmentVariables: {
        CUSTOM_ROLE_VAR: "propagated-ok"
      },
      secretBindings: {},
      requiredCapabilityIds: ["implementation"],
      requiredMcpServiceIds: options?.requiredMcpServiceIds ?? [],
      skillManifestDigest: options?.skillManifestDigest ?? "a".repeat(64)
    };
  }

  function createFakeProviderBin(
    dir: string,
    provider: AgentProviderId,
    options?: { unauthenticated?: boolean }
  ): string {
    const binPath = join(dir, provider);
    const unauth = options?.unauthenticated === true;
    const script = `#!/usr/bin/env bash
if [[ "$*" == *"--version"* ]]; then
  if [[ "${provider}" == "claude" ]]; then echo "2.1.301 (Claude Code)"; fi
  if [[ "${provider}" == "codex" ]]; then echo "codex-cli 0.162.0"; fi
  if [[ "${provider}" == "agy" ]]; then echo "Antigravity CLI 1.4.0"; fi
  exit 0
fi
if [[ "$*" == *"--help"* ]]; then
  echo "Usage: ${provider} --print --output-format json --append-system-prompt-file --mcp-config --strict-mcp-config --permission-mode --setting-sources --settings --add-dir --full-auto --sandbox --ask-for-approval --cd --config --mode --workspace --model --dangerously-skip-permissions --dangerously-bypass-approvals-and-sandbox --trust --restricted --disable-slash-commands --tools --allowedTools --disallowedTools --no-daemon --enable --dangerously-bypass-hook-trust"
  echo "Subcommands: exec mcp auth login models"
  exit 0
fi
if [[ "$1" == "auth" && "$2" == "status" ]]; then
  if [[ "${unauth}" == "true" ]]; then
    echo '{"loggedIn":false}'
    exit 1
  fi
  echo '{"loggedIn":true,"authMethod":"claude.ai"}'
  exit 0
fi
if [[ "$1" == "login" && "$2" == "status" ]]; then
  if [[ "${unauth}" == "true" ]]; then
    echo "Not logged in" >&2
    exit 1
  fi
  echo "Logged in using ChatGPT"
  exit 0
fi
if [[ "$1" == "models" ]]; then
  if [[ "${unauth}" == "true" ]]; then
    echo "Error: not authenticated" >&2
    exit 1
  fi
  echo "Available models: Gemini 3 Flash"
  exit 0
fi
echo '{"status":"ok","reply":"READY_OK"}'
exit 0
`;
    writeFileSync(binPath, script, { mode: 0o700 });
    chmodSync(binPath, 0o700);
    return binPath;
  }

  describe("[HARNESS / MOCK] All 9 Provider Verification Dimensions Across Claude, Codex, and Agy", () => {
    it.each(["claude", "codex", "agy"] as const)(
      "verifies %s binary detection, auth, launch profile, env propagation, permission modes, workspace trust, MCP, skills, and activated readiness",
      async (provider) => {
        const root = makeTempDir(`bflow-e12-${provider}-`);
        const binDir = join(root, "bin");
        const workspaceDir = join(root, "workspace");
        const stateDir = join(root, "state");
        mkdirSync(binDir, { mode: 0o700 });
        mkdirSync(workspaceDir, { mode: 0o700 });
        mkdirSync(stateDir, { mode: 0o700 });
        chmodSync(binDir, 0o700);
        chmodSync(workspaceDir, 0o700);
        chmodSync(stateDir, 0o700);

        const binPath = createFakeProviderBin(binDir, provider);
        const runner = createProviderProcessRunner();

        // 1. Execution readiness requires more than version check: test unauthenticated binary first
        const unauthDir = join(root, "unauth-bin");
        mkdirSync(unauthDir, { mode: 0o700 });
        chmodSync(unauthDir, 0o700);
        const unauthBin = createFakeProviderBin(unauthDir, provider, { unauthenticated: true });
        const unauthRegistry = createDefaultProviderRegistry({
          [provider]: { executablePath: unauthBin, runner }
        });
        const unauthEnv = makeEnvironment(provider, workspaceDir, stateDir);
        const unauthHealth = await unauthRegistry.checkHealth({
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          environment: unauthEnv,
          stage: "preflight",
          requestedAt: new Date().toISOString()
        });
        expect(unauthHealth.ok).toBe(true);
        if (unauthHealth.ok) {
          expect(unauthHealth.value.checks.find((c) => c.check === "version")?.code).toBe("version_ok");
          expect(unauthHealth.value.checks.find((c) => c.check === "authentication")?.status).toBe("failed");
          expect(unauthHealth.value.status).toBe("blocked");
        }

        // 2. Permission mode enforcement: unattended_isolated without verified sandbox is rejected
        const noSandboxRegistry = createDefaultProviderRegistry({
          [provider]: { executablePath: binPath, runner, osSandboxPath: "/nonexistent/bwrap" }
        });
        const unattendedEnv = makeEnvironment(provider, workspaceDir, stateDir, {
          mode: "unattended_isolated",
          isolation: "os_sandbox"
        });
        const unattendedNoSandbox = await noSandboxRegistry.checkHealth({
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          environment: unattendedEnv,
          stage: "preflight",
          requestedAt: new Date().toISOString()
        });
        expect(unattendedNoSandbox.ok).toBe(true);
        if (unattendedNoSandbox.ok) {
          expect(unattendedNoSandbox.value.status).toBe("blocked");
          expect(unattendedNoSandbox.value.checks.find((c) => c.check === "permissions")?.status).toBe("failed");
        }

        // 3. Full prepareLaunch + activated checkHealth with MCP, skills, env propagation, and signed launch attestation
        const keyPair = generateKeyPairSync("ed25519");
        const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
        const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

        const skillContent = "# Role Skill\nFollow Bflow SDD and Conditional TDD policies.\n";
        const skillDigest = sha256Hex(skillContent);
        const scope = makeScope(workspaceDir);
        const mcpReg: MCPClientRegistration = {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          registrationId: `mcp-reg-${provider}`,
          provider,
          role: "developer",
          scope,
          environmentId: `env-${provider}-workspace_auto`,
          serviceIds: ["gitnexus"],
          allowedTools: ["query", "impact"],
          connection: {
            transport: "stdio",
            executable: binPath,
            executableDigest: sha256Hex(readFileSync(binPath, "utf8")),
            argv: ["mcp"],
            token: "secret://mcp-token-1"
          },
          configDigest: "b".repeat(64),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          idempotencyKey: `idem-mcp-${provider}`
        };
        const mcpObs: MCPServiceObservation = {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          serviceId: "gitnexus",
          revision: 1,
          instanceId: "inst-gn-1",
          status: "ready",
          protocolVersion: "2024-11-05",
          discoveredTools: ["query", "impact"],
          ownership: "bflow",
          activeClientCount: 1,
          observedAt: new Date().toISOString(),
          diagnosticCode: "ready"
        };
        const skillManifest: SkillManifest = {
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          manifestId: `manifest-${provider}`,
          environmentId: `env-${provider}-workspace_auto`,
          role: "developer",
          provider,
          scope,
          digest: skillDigest,
          skills: [
            {
              schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
              skillId: "bflow-tdd",
              version: "1.0.0",
              digest: skillDigest,
              source: "builtin",
              entrypoint: "SKILL.md",
              description: "Conditional TDD skill",
              allowedRoles: ["developer"],
              supportedProviders: ["claude", "codex", "agy"],
              requiredCapabilityIds: [],
              requiredToolIds: [],
              dependencies: [],
              instructionOnly: true
            }
          ],
          bindings: [
            {
              schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
              bindingId: `bind-${provider}-bflow-tdd`,
              role: "developer",
              provider,
              scope,
              skill: {
                skillId: "bflow-tdd",
                version: "1.0.0",
                digest: skillDigest
              },
              required: true
            }
          ]
        };

        const fullEnv = makeEnvironment(provider, workspaceDir, stateDir, {
          skillManifestDigest: skillDigest,
          requiredMcpServiceIds: ["gitnexus"]
        });

        const fullRegistry = createDefaultProviderRegistry({
          [provider]: {
            executablePath: binPath,
            runner,
            mcpRegistrations: [mcpReg],
            mcpObservations: [mcpObs],
            skillManifest,
            renderedSkillsContent: skillContent,
            trustedIssuerKeys: { "herdr-host": publicKey },
            liveObservation: {
              paneId: "w1:p5",
              agentName: `dev-${provider}`,
              transportState: "idle",
              interactiveReady: true,
              nativeSession: { source: provider, kind: "id", value: `native-${provider}-1` }
            }
          }
        });

        const launchRes = await fullRegistry.prepareLaunch(fullEnv);
        expect(launchRes.ok).toBe(true);
        if (!launchRes.ok) return;

        const profile = launchRes.value;
        expect(profile.environment.environmentVariables["CUSTOM_ROLE_VAR"]).toBe("propagated-ok");
        expect(profile.interaction).toBe("no_direct_user_input");
        expect(profile.configFiles.length).toBeGreaterThanOrEqual(3);
        for (const cf of profile.configFiles) {
          expect(existsSync(cf.path)).toBe(true);
        }

        // Preflight health is "ready" for all 3 providers
        const preflightHealth = await fullRegistry.checkHealth({
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          environment: fullEnv,
          stage: "preflight",
          requestedAt: new Date(Date.now() + 25).toISOString()
        });
        expect(preflightHealth.ok).toBe(true);
        if (preflightHealth.ok) {
          expect(preflightHealth.value.status).toBe("ready");
          expect(preflightHealth.value.checks.every((c) => c.status === "passed")).toBe(true);
        }

        const attestation = createSignedLaunchAttestation({
          receiptId: `att-${provider}-1`,
          issuerId: "herdr-host",
          launchId: profile.launchId,
          launchFingerprint: profile.launchFingerprint,
          sessionId: "sess-e12-01",
          paneId: "w1:p5",
          nativeSession: { source: provider, kind: "id", value: `native-${provider}-1` },
          observedAt: new Date().toISOString(),
          privateKeyPem: privateKey
        });

        const activatedHealth = await fullRegistry.checkHealth({
          schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
          environment: fullEnv,
          stage: "activated",
          launchProfile: profile,
          launchAttestation: attestation,
          requestedAt: new Date(Date.now() + 50).toISOString()
        });
        expect(activatedHealth.ok).toBe(true);
        if (activatedHealth.ok) {
          expect(activatedHealth.value.stage).toBe("activated");
          if (provider === "agy") {
            expect(activatedHealth.value.status).toBe("unsupported");
            expect(activatedHealth.value.checks.find((c) => c.check === "native_binding")?.code).toBe(
              "native_binding_unsupported"
            );
          } else {
            expect(activatedHealth.value.status).toBe("ready");
            expect(activatedHealth.value.checks.every((c) => c.status === "passed")).toBe(true);
          }
        }
      }
    );
  });

  describe("[REAL PROVIDER / LIVE HOST] Live Binary, Auth, Readiness & Herdr Pane Verification", () => {
    it("verifies live Claude (2.1.301), Codex (0.162.0), and Agy (1.4.0) preflight readiness and launch profile compilation (QA-P34-03..06 fixed)", async () => {
      const root = makeTempDir("bflow-e12-live-");
      const stateDir = join(root, "state");
      mkdirSync(stateDir, { mode: 0o700 });
      chmodSync(stateDir, 0o700);
      await environmentProcessRunner.run({
        executable: "git",
        args: ["init"],
        cwd: root,
        timeoutMs: 10_000
      });
      const runner = createProviderProcessRunner();

      // 1. Claude 2.1.301 live preflight check & prepareLaunch (QA-P34-05 fixed)
      const claudeAdapter = new ClaudeProviderAdapter({ runner });
      const claudeEnv = makeEnvironment("claude", root, stateDir, {
        mode: "restricted",
        skillManifestDigest: "0".repeat(64)
      });
      const claudePreflight = await claudeAdapter.checkHealth({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        environment: claudeEnv,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(claudePreflight.ok).toBe(true);
      if (claudePreflight.ok) {
        expect(claudePreflight.value.status).toBe("ready");
        expect(claudePreflight.value.checks.every((c) => c.status === "passed")).toBe(true);
      }
      const claudeLaunch = await claudeAdapter.prepareLaunch(claudeEnv);
      expect(claudeLaunch.ok).toBe(true);
      if (claudeLaunch.ok) {
        expect(claudeLaunch.value.argv).toContain("--append-system-prompt-file");
        expect(claudeLaunch.value.argv).toContain("--permission-mode");
      }

      // 2. Codex 0.162.0 live preflight check & prepareLaunch (QA-P34-03 fixed: 512 MiB cap)
      const codexAdapter = new CodexProviderAdapter({ runner });
      const codexEnv = makeEnvironment("codex", root, stateDir, {
        mode: "workspace_auto",
        skillManifestDigest: "0".repeat(64)
      });
      const codexPreflight = await codexAdapter.checkHealth({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        environment: codexEnv,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(codexPreflight.ok).toBe(true);
      if (codexPreflight.ok) {
        expect(codexPreflight.value.checks.filter((c) => c.status !== "passed")).toEqual([]);
        expect(codexPreflight.value.status).toBe("ready");
      }
      const codexLaunch = await codexAdapter.prepareLaunch(codexEnv);
      expect(codexLaunch.ok).toBe(true);

      // 3. Agy 1.4.0 live preflight check & prepareLaunch (QA-P34-04 & QA-P34-06 fixed)
      const agyAdapter = new AgyProviderAdapter({ runner, model: "gemini-3.8-flash-low" });
      const agyEnv = makeEnvironment("agy", root, stateDir, {
        mode: "restricted",
        skillManifestDigest: "0".repeat(64)
      });
      const agyPreflight = await agyAdapter.checkHealth({
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        environment: agyEnv,
        stage: "preflight",
        requestedAt: new Date().toISOString()
      });
      expect(agyPreflight.ok).toBe(true);
      if (agyPreflight.ok) {
        expect(agyPreflight.value.checks.filter((c) => c.status !== "passed")).toEqual([]);
        expect(agyPreflight.value.status).toBe("ready");
      }
      const agyLaunch = await agyAdapter.prepareLaunch(agyEnv);
      expect(agyLaunch.ok).toBe(true);
      expect(existsSync(join(stateDir, "agy-home", ".gemini", "antigravity-cli", "settings.json"))).toBe(true);
    }, 90_000);

    it("starts real Herdr panes for Claude, Codex, and Agy in an isolated live Herdr 0.9.5 session", async () => {
      const root = makeTempDir("bflow-e12-herdr-");
      const sessionName = `bflow-e12-${process.pid}`;
      const baseEnv: Record<string, string | undefined> = {
        ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HERDR_"))),
        XDG_CONFIG_HOME: join(root, "cfg"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_RUNTIME_DIR: root,
        TMPDIR: "/tmp",
        HERDR_CONFIG_PATH: join(root, "cfg/config.toml"),
        ZDOTDIR: root,
        HERDR_SESSION: sessionName
      };
      mkdirSync(baseEnv.XDG_CONFIG_HOME!, { recursive: true });
      mkdirSync(baseEnv.XDG_DATA_HOME!, { recursive: true });
      writeFileSync(baseEnv.HERDR_CONFIG_PATH!, "# E12 isolated Herdr config\n");
      writeFileSync(join(root, ".zshrc"), "# isolated\n");

      const callHerdr = (args: string[]) =>
        environmentProcessRunner.run({
          executable: "herdr",
          args: ["--session", sessionName, ...args],
          cwd: root,
          env: namedSessionEnvironment(sessionName, baseEnv),
          timeoutMs: 15_000
        });

      const server = spawn("herdr", ["--session", sessionName, "server"], {
        env: namedSessionEnvironment(sessionName, baseEnv),
        stdio: "ignore"
      });

      try {
        await expect
          .poll(
            async () => {
              try {
                const st = await callHerdr(["status", "server", "--json"]);
                return st.exitCode === 0 && JSON.parse(st.stdout).running === true;
              } catch {
                return false;
              }
            },
            { timeout: 10_000, interval: 100 }
          )
          .toBe(true);

        const wsCreate = await callHerdr(["workspace", "create", "--cwd", root, "--label", "Providers", "--no-focus"]);
        expect(wsCreate.exitCode).toBe(0);
        const wsCreated = (
          JSON.parse(wsCreate.stdout) as {
            result: { root_pane: { pane_id: string }; workspace: { workspace_id: string } };
          }
        ).result;
        const pane1 = wsCreated.root_pane.pane_id;

        const split2 = await callHerdr(["pane", "split", pane1, "--direction", "right", "--cwd", root, "--no-focus"]);
        expect(split2.exitCode).toBe(0);
        const pane2 = (JSON.parse(split2.stdout) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;

        const split3 = await callHerdr(["pane", "split", pane2, "--direction", "down", "--cwd", root, "--no-focus"]);
        expect(split3.exitCode).toBe(0);
        const pane3 = (JSON.parse(split3.stdout) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;

        const panes = [pane1, pane2, pane3];
        const providers = ["claude", "codex", "agy"] as const;
        const actorScript = join(root, "pane-actor.mjs");
        writeFileSync(
          actorScript,
          [
            "import { spawnSync } from 'node:child_process';",
            "const [provider, sessionId] = process.argv.slice(2);",
            "let seq = Date.now();",
            "function report() {",
            "  spawnSync(process.env.HERDR_BIN_PATH ?? 'herdr', [",
            "    'pane', 'report-agent', process.env.HERDR_PANE_ID,",
            "    '--source', `bflow:${provider}`, '--agent', `bflow-${provider}`,",
            "    '--state', 'idle', '--seq', String(++seq),",
            "    '--agent-session-id', sessionId",
            "  ], { env: process.env, encoding: 'utf8' });",
            "}",
            "setInterval(report, 250);",
            "report();"
          ].join("\n")
        );

        for (const [idx, provider] of providers.entries()) {
          const paneId = panes[idx]!;
          const runRes = await callHerdr([
            "pane",
            "run",
            paneId,
            `node ${actorScript} ${provider} sess-${provider}-${idx}`
          ]);
          expect(runRes.exitCode).toBe(0);
        }

        await expect
          .poll(
            async () => {
              const agentList = await callHerdr(["agent", "list"]);
              if (agentList.exitCode !== 0) return [];
              const agents = (
                JSON.parse(agentList.stdout) as {
                  result: { agents: Array<{ agent: string; pane_id: string }> };
                }
              ).result.agents;
              return agents.map((a) => a.agent).sort();
            },
            { timeout: 10_000, interval: 150 }
          )
          .toEqual(["bflow-agy", "bflow-claude", "bflow-codex"]);
      } finally {
        await callHerdr(["session", "stop", sessionName]).catch(() => {});
        if (server.exitCode === null) server.kill("SIGTERM");
      }
    }, 45_000);
  });
});
