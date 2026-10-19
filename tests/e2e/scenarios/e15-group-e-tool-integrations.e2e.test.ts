import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import {
  SUPPORTED_CLI_COMMANDS,
  createDefaultHighLevelServices,
  runHighLevelCli,
  type HighLevelServices
} from "@bflow/cli";
import {
  CURRENT_PLATFORM_SCHEMA_VERSION,
  QualityGateResultSchema,
  SpecificationSchema,
  type AgentProviderId,
  type AgentRole,
  type QualityGate,
  type TrustScope
} from "@bflow/contracts";
import { DedicatedBrowserRuntime } from "@bflow/mcp-services";
import {
  RoleSkillBindingsSchema,
  SkillFileStore,
  SkillManager,
  SkillsSetupSynchronizer,
  bindRoleSkills,
  loadSkillCatalog
} from "@bflow/skills";
import { SpecificationEngine } from "@bflow/specification";
import { TestStrategyResolver } from "@bflow/test-strategy";
import {
  applyRtkConfiguration,
  createGitNexusService,
  ensureGitNexusIndex,
  planChromeSession,
  planRtkConfiguration,
  probeStdioMcp,
  rollbackRtkConfiguration,
  rtkProviderIntegration,
  runWithRtk,
  superpowersInstallRoute,
  verifyRtk,
  verifySuperpowersSkills,
  type ToolHost
} from "@bflow/tool-installer";
import { CheckConfigurationSchema, ObservationSchema } from "@bflow/verification";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

function hasBinaryAt(path: string): boolean {
  try {
    execFileSync(path, ["--version"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  return execFileSync(
    "git",
    ["-c", "user.name=QA", "-c", "user.email=qa@bflow.local", "-c", "commit.gpgsign=false", ...args],
    { cwd, env, encoding: "utf8" }
  ).trim();
}

function extractCommandOutput(res: { envelope?: { result?: { output?: unknown } | undefined } | undefined }): {
  outcome?: string;
  steps?: Array<{ id: string; data?: Record<string, unknown> }>;
} {
  return (res.envelope?.result?.output ?? {}) as {
    outcome?: string;
    steps?: Array<{ id: string; data?: Record<string, unknown> }>;
  };
}

function gitNexusIndexHarness(repositoryRoot: string, refreshedBeforeWriterLock = false) {
  let indexed = false, statusCalls = 0, analyzeCalls = 0;
  const observations: string[] = [];
  const host: ToolHost = {
    async download() { throw new Error("GitNexus indexing harness must not download"); },
    async run(executable, args) {
      if (executable === "git" && args[0] === "rev-parse")
        return { exitCode: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n", stderr: "" };
      if (executable === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "status") {
        expect(args).toEqual(["status", "--json"]);
        statusCalls += 1;
        // Simulate another writer only in the explicit race scenario. Otherwise
        // both the initial read and locked recheck remain stale until analyze.
        if (refreshedBeforeWriterLock && statusCalls > 1) indexed = true;
        observations.push(indexed ? "status:registered" : "status:not-indexed");
        return { exitCode: 0, stdout: indexed
          ? `Partial index found...\n${JSON.stringify({ schemaVersion: 1, repository: repositoryRoot, status: "registered" })}`
          : JSON.stringify({ schemaVersion: 1, repository: repositoryRoot, error: "not-indexed" }), stderr: "" };
      }
      if (args[0] === "analyze") {
        expect(args).toEqual(["analyze", repositoryRoot, "--index-only"]);
        analyzeCalls += 1;
        observations.push("analyze");
        indexed = true;
        return { exitCode: 0, stdout: "indexed", stderr: "" };
      }
      throw new Error(`Unexpected harness command: ${executable} ${args.join(" ")}`);
    }
  };
  return { host, observations, get analyzeCalls() { return analyzeCalls; } };
}

describe("E15 — Group E: Tool Integrations, Role Skills & Unified Commands (Harness + Real Tool Binaries)", () => {
  let tmpRoot: string;
  let rtkRepoDir: string;
  let rtkStateDir: string;
  const livePlatformEnabled = process.env.BFLOW_TEST_LIVE_PLATFORM === "1";

  beforeAll(() => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "bflow-e2e-group-e-")));
    chmodSync(tmpRoot, 0o700);
    rtkRepoDir = join(tmpRoot, "rtk-repo");
    rtkStateDir = join(tmpRoot, "rtk-state");
    mkdirSync(rtkRepoDir, { mode: 0o700 });
    mkdirSync(rtkStateDir, { mode: 0o700 });
    git(rtkRepoDir, "init", "-q", "-b", "main");
    writeFileSync(join(rtkRepoDir, "README.md"), "# RTK Test\n");
    git(rtkRepoDir, "add", ".");
    git(rtkRepoDir, "commit", "-q", "-m", "init");
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it.skipIf(!livePlatformEnabled)("[LIVE TOOL] verifies RTK 0.42.4 binary, provider routes, idempotent configuration apply/rollback, and proxy execution", async () => {
    const rtkBin = process.env.BFLOW_TEST_RTK_BIN ?? "rtk";
    expect(hasBinaryAt(rtkBin), `RTK binary required for live platform checks: ${rtkBin}`).toBe(true);

    const rtkVerified = await verifyRtk(rtkBin, "0.42.4");
    expect(rtkVerified).toBe(true);

    const routeClaude = await rtkProviderIntegration("claude", rtkBin);
    const routeCodex = await rtkProviderIntegration("codex", rtkBin);
    const routeAgy = await rtkProviderIntegration("agy", rtkBin);
    expect(routeClaude.supported).toBe(true);
    expect(routeCodex.supported).toBe(true);
    expect(routeAgy.supported).toBe(true);
    expect(routeAgy.configureCommand).toContain("antigravity");

    const planAgy = await planRtkConfiguration({
      provider: "agy",
      executable: rtkBin,
      repositoryRoot: rtkRepoDir,
      stateRoot: rtkStateDir
    });
    const apply1 = await applyRtkConfiguration(planAgy);
    const apply2 = await applyRtkConfiguration(planAgy);
    expect(apply1.status).toBe("applied");
    expect(apply2.status).toBe("already_satisfied");
    await rollbackRtkConfiguration(apply1.receiptPath);

    const filteredRun = await runWithRtk(rtkBin, ["git", "status"], false);
    const proxyRun = await runWithRtk(rtkBin, ["git", "status", "--short"], true);
    expect(filteredRun.exitCode).toBe(0);
    expect(proxyRun.exitCode).toBe(0);
  });

  it("[HARNESS] handles GitNexus not-indexed to indexed status with leading warnings", async () => {
    const gnStateDir = join(tmpRoot, "gn-state-harness");
    mkdirSync(gnStateDir, { mode: 0o700 });
    const canonicalRtkRepo = realpathSync(rtkRepoDir);
    const harness = gitNexusIndexHarness(canonicalRtkRepo);
    const harnessObservation = await ensureGitNexusIndex({
      repositoryRoot: rtkRepoDir, stateRoot: gnStateDir, executable: "gitnexus", host: harness.host
    });
    expect(harnessObservation.status).toBe("indexed");
    expect(harness.analyzeCalls).toBe(1);
    expect(harness.observations).toEqual(["status:not-indexed", "status:not-indexed", "analyze", "status:registered"]);
  });

  it("[HARNESS] avoids GitNexus analysis when another writer refreshes the index before the locked recheck", async () => {
    const gnStateDir = join(tmpRoot, "gn-state-concurrent-refresh");
    mkdirSync(gnStateDir, { mode: 0o700 });
    const harness = gitNexusIndexHarness(realpathSync(rtkRepoDir), true);
    const observation = await ensureGitNexusIndex({
      repositoryRoot: rtkRepoDir, stateRoot: gnStateDir, executable: "gitnexus", host: harness.host
    });
    expect(observation.status).toBe("fresh");
    expect(harness.analyzeCalls).toBe(0);
    expect(harness.observations).toEqual(["status:not-indexed", "status:registered"]);
  });

  it.skipIf(!livePlatformEnabled)("[LIVE TOOL] verifies GitNexus 1.6.12 repository indexing, status schema, and live stdio MCP tools", async () => {
    const gnBin = process.env.BFLOW_TEST_GITNEXUS_BIN ?? "gitnexus";
    expect(hasBinaryAt(gnBin), `GitNexus binary required for live platform checks: ${gnBin}`).toBe(true);

    const gnStateDir = join(tmpRoot, "gn-state");
    const gnConfigDir = join(tmpRoot, "gn-config");
    mkdirSync(gnStateDir, { mode: 0o700 });
    mkdirSync(gnConfigDir, { mode: 0o700 });
    const canonicalRtkRepo = realpathSync(rtkRepoDir);

    // Real GitNexus status schema ("registered" vs "up-to-date") and stdio MCP negotiation.
    const rawStatusOut = execFileSync(gnBin, ["status", "--json"], {
      cwd: rtkRepoDir,
      encoding: "utf8",
      timeout: 15_000
    });
    const jsonLine = rawStatusOut
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const parsedRealStatus = JSON.parse(jsonLine!) as { schemaVersion: number; repository: string; error?: string };
    expect(parsedRealStatus.schemaVersion).toBe(1);
    expect(realpathSync(parsedRealStatus.repository)).toBe(canonicalRtkRepo);

    const realSchemaHarness = gitNexusIndexHarness(canonicalRtkRepo);
    const gnRealSchemaObs = await ensureGitNexusIndex({
      repositoryRoot: rtkRepoDir, stateRoot: join(tmpRoot, "gn-state-real-schema"), executable: gnBin,
      host: realSchemaHarness.host
    });
    // QA-P34-08 fixed: gitnexus 1.6.12 status="registered" (with leading warning line) is accepted as indexed
    expect(gnRealSchemaObs.status).toBe("indexed");
    expect(realSchemaHarness.analyzeCalls).toBe(1);

    // 3. Real GitNexus service definition & real stdio MCP server negotiation
    const gnServiceDef = await createGitNexusService({
      executable: gnBin,
      version: "1.6.12",
      repositoryRoot: rtkRepoDir,
      stateRoot: gnStateDir,
      configRoot: gnConfigDir,
      operation: {
        schemaVersion: CURRENT_PLATFORM_SCHEMA_VERSION,
        scope: {
          kind: "repository",
          machineId: "machine-qa-01",
          repositoryId: "repo-alpha",
          workspaceRoot: rtkRepoDir
        },
        idempotencyKey: "idem-create-gn-svc"
      }
    });
    expect(gnServiceDef.serviceId).toContain("gitnexus");

    const gnMcpProbe = await probeStdioMcp({
      executable: gnBin,
      argv: ["mcp"],
      requiredTools: ["query", "impact", "context"],
      timeoutMs: 20_000
    });
    expect(gnMcpProbe.discoveredTools).toEqual(expect.arrayContaining(["query", "impact", "context"]));
  }, 60_000);

  it("[HARNESS / INJECTED BROWSER LAUNCHER] verifies Chrome profile planning, SingletonLock rejection, and page ownership", async () => {
    const chromeManagedRoot = join(tmpRoot, "chrome-managed");
    mkdirSync(chromeManagedRoot, { mode: 0o700 });
    const fakeChromeExecutable = join(tmpRoot, "fake-chrome");
    writeFileSync(fakeChromeExecutable, "#!/usr/bin/env bash\necho 'Google Chrome 130.0.0.0'\n", { mode: 0o700 });
    const fakeChromeMcpServer = join(tmpRoot, "fake-chrome-devtools-mcp.sh");
    writeFileSync(fakeChromeMcpServer, '#!/usr/bin/env bash\necho "chrome-devtools-mcp 0.1.0"\n', { mode: 0o755 });

    const chromePlanReady = await planChromeSession({
      managedRoot: chromeManagedRoot,
      repositoryId: "repo-alpha",
      taskId: "task-ui-1",
      browserExecutable: fakeChromeExecutable,
      serverExecutable: fakeChromeMcpServer
    });
    expect(chromePlanReady.status).toBe("ready");
    expect(chromePlanReady.profileDir).toContain("repo-alpha/task-ui-1");

    writeFileSync(join(chromePlanReady.profileDir, "SingletonLock"), "locked", { mode: 0o600 });
    const chromePlanLocked = await planChromeSession({
      managedRoot: chromeManagedRoot,
      repositoryId: "repo-alpha",
      taskId: "task-ui-1",
      browserExecutable: fakeChromeExecutable,
      serverExecutable: fakeChromeMcpServer
    });
    expect(chromePlanLocked.status).toBe("profile_locked");
    expect(chromePlanLocked.diagnostic).toContain("SingletonLock");

    const browserRuntimeDir = join(tmpRoot, "browser-runtime");
    mkdirSync(browserRuntimeDir, { mode: 0o700 });
    const browserScope: Extract<TrustScope, { kind: "session" }> = {
      kind: "session",
      machineId: "machine-qa-01",
      repositoryId: "repo-alpha",
      workspaceRoot: rtkRepoDir,
      sessionId: "sess-ui-1"
    };
    const browserRt = new DedicatedBrowserRuntime({
      browserProfilesRoot: browserRuntimeDir,
      executablePath: fakeChromeExecutable,
      launcher: {
        probeBinary: async () => ({ ok: true, value: { version: "Google Chrome 130.0.0.0" } }),
        launch: async (opts) => ({
          ok: true,
          value: {
            pid: process.pid,
            debuggingHost: opts.debuggingHost,
            debuggingPort: opts.debuggingPort,
            supportsBrowserContexts: true,
            isAlive: () => true,
            getMemoryRssBytes: async () => 50 * 1024 * 1024,
            probeDebuggingEndpoint: async () => true,
            createBrowserContext: async () => "ctx-1",
            disposeBrowserContext: async () => {},
            stop: async () => {},
            onCrash: () => () => {}
          }
        })
      }
    });
    const callerDev1 = { registrationId: "agent-claude-dev-1", runId: "run-1", taskId: "task-ui-1", scope: browserScope };
    const callerDev2 = { registrationId: "agent-codex-dev-2", runId: "run-1", taskId: "task-ui-2", scope: browserScope };
    const pageRes = await browserRt.openPage(callerDev1, "http://127.0.0.1:3000");
    expect(pageRes.ok).toBe(true);
    if (!pageRes.ok) return;

    const navOwnerRes = await browserRt.navigatePage(callerDev1, pageRes.value.pageId, "http://127.0.0.1:3000/dashboard");
    const navOtherRes = await browserRt.navigatePage(callerDev2, pageRes.value.pageId, "http://127.0.0.1:3000/hijack");
    expect(navOwnerRes.ok).toBe(true);
    expect(navOtherRes.ok).toBe(false);
    if (!navOtherRes.ok) {
      expect(navOtherRes.error.code).toBe("conflict");
      expect(navOtherRes.error.details).toEqual(
        expect.objectContaining({ diagnosticCode: "page_ownership_conflict" })
      );
    }
  });

  it("[HARNESS / REAL CATALOG] verifies Superpowers routes, 33 catalog skills across 10 roles x 3 providers, and fail-closed missing tool enforcement", async () => {
    expect(superpowersInstallRoute("claude").command).toContain("plugin install superpowers");
    expect(superpowersInstallRoute("codex").command).toContain("codex plugin add superpowers");
    expect(superpowersInstallRoute("agy").command).toContain("agy plugin install https://github.com/obra/superpowers");

    const skillsCatalogRoot = resolve(REPO_ROOT, "skills");
    const catalogSkills = await loadSkillCatalog(skillsCatalogRoot, {
      source: "builtin",
      supportedCommands: SUPPORTED_CLI_COMMANDS
    });
    expect(catalogSkills).toHaveLength(33);

    const bflowSkillIds = catalogSkills.map((s) => s.definition.skillId);
    const spValid = verifySuperpowersSkills(
      ["using-superpowers", "brainstorming", "test-driven-development", "systematic-debugging"],
      bflowSkillIds
    );
    const spMissingEntry = verifySuperpowersSkills(["brainstorming"], bflowSkillIds);
    expect(spValid.ready).toBe(true);
    expect(spMissingEntry.ready).toBe(false);
    expect(spMissingEntry.diagnostic).toContain("using-superpowers");

    const skillStoreRoot = join(tmpRoot, "skills-store");
    mkdirSync(skillStoreRoot, { mode: 0o700 });
    const skillStore = new SkillFileStore(skillStoreRoot);
    const skillManager = new SkillManager({
      store: skillStore,
      supportedCommands: SUPPORTED_CLI_COMMANDS,
      approvedBuiltinDigests: catalogSkills.map((s) => s.definition.digest)
    });

    for (const item of catalogSkills) {
      await skillManager.installBundle(item.files, {
        source: "builtin",
        expectedDigest: item.definition.digest
      });
    }
    const installedList = await skillManager.list();
    expect(installedList).toHaveLength(33);

    const bindingsRaw = JSON.parse(readFileSync(join(skillsCatalogRoot, "roles/bindings.json"), "utf8")) as unknown;
    const parsedBindings = RoleSkillBindingsSchema.parse(bindingsRaw);
    const sessionScope: Extract<TrustScope, { kind: "session" }> = {
      kind: "session",
      machineId: "machine-qa-01",
      repositoryId: "repo-alpha",
      workspaceRoot: rtkRepoDir,
      sessionId: "sess-skills-01"
    };
    const allCapabilityIds = [...new Set(installedList.flatMap((d) => d.requiredCapabilityIds))];
    const allToolIds = [...new Set(installedList.flatMap((d) => d.requiredToolIds))];

    await expect(
      skillManager.resolve({
        manifestId: "manifest-missing-tool",
        environmentId: "env-missing-tool",
        scope: sessionScope,
        role: "qa",
        provider: "claude",
        capabilityIds: allCapabilityIds,
        toolIds: [],
        selections: bindRoleSkills(parsedBindings.bindings, "qa", installedList)
      })
    ).rejects.toThrow(/Missing skill tool:/);

    const roles = Object.keys(parsedBindings.bindings) as AgentRole[];
    expect(roles).toHaveLength(10);
    const providers: AgentProviderId[] = ["claude", "codex", "agy"];

    for (const role of roles) {
      const selections = bindRoleSkills(parsedBindings.bindings, role, installedList);
      for (const provider of providers) {
        const synced = await skillManager.sync({
          manifestId: `manifest-${role}-${provider}`,
          environmentId: `env-${role}-${provider}`,
          scope: sessionScope,
          role,
          provider,
          capabilityIds: allCapabilityIds,
          toolIds: allToolIds,
          selections
        });
        expect(synced.manifest.skills.length).toBeGreaterThan(0);
        expect(synced.rendered.instructionText).toContain(
          "Bflow Conditional TDD, leases, gates and human approval remain authoritative"
        );
        if (role === "conversation") {
          expect(synced.rendered.instructionText).toContain(
            "Only present authenticated Runtime decision requests to the user."
          );
        } else {
          expect(synced.rendered.instructionText).toContain(
            "Route every question or approval through Runtime → Herdr → Conversation; disable native direct questions/elicitation."
          );
        }
      }
    }
  });

  // This end-to-end command sequence creates/integrates real Git worktrees through the Linux flock journal.
  it.skipIf(process.platform !== "linux")("[HARNESS + REAL CLI] exercises all 9 P29 commands with real worktrees and explicit platform ports", async () => {
    const hlRepo = join(tmpRoot, "hl-repo");
    mkdirSync(join(hlRepo, "src/math"), { recursive: true, mode: 0o700 });
    git(hlRepo, "init", "-q", "-b", "main");
    // GitIntegrationEngine performs its merge with repository configuration only; CI has no global identity.
    git(hlRepo, "config", "user.name", "Bflow E15 Test");
    git(hlRepo, "config", "user.email", "bflow-e15@example.invalid");
    writeFileSync(
      join(hlRepo, "src/math/average.ts"),
      "export const average = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;\n"
    );
    writeFileSync(join(hlRepo, ".gitignore"), ".bflow/state/\n.bflow/plans/\nspec.json\nverify-plan.json\n");
    writeFileSync(
      join(hlRepo, "package.json"),
      JSON.stringify({ name: "hl-qa-fixture", packageManager: "pnpm@12.5.1", scripts: { test: "vitest" } })
    );
    git(hlRepo, "add", ".");
    git(hlRepo, "commit", "-q", "-m", "initial commit");

    const storeRes = await openFilesystemArtifactStore({
      root: join(hlRepo, ".bflow/state/cli/artifacts"),
      storeId: "bflow-cli"
    });
    expect(storeRes.ok).toBe(true);
    if (!storeRes.ok) return;
    const hlStore = storeRes.value;

    const specExample = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "packages/specification/examples/standard.json"), "utf8")
    ) as Record<string, unknown>;
    specExample["runId"] = "run-1";
    const metadata = (specExample["metadata"] ?? {}) as Record<string, unknown>;
    metadata["conditionalTdd"] = {
      policyVersion: 1,
      taskId: "implement",
      taskType: "bugfix",
      changeImpact: {
        surfaces: ["bugfix"],
        behaviorChanged: true,
        deterministic: true,
        regressionReproducible: true,
        securitySensitive: false,
        dataMigration: false,
        scope: "local"
      },
      infrastructure: {
        readiness: "ready",
        commands: [{ method: "unit_test", command: "pnpm test:math", level: "unit" }]
      },
      testability: { level: "automated", rationale: "Pure arithmetic function." },
      riskClassification: "medium",
      conventions: { tdd: "contextual", requiredMethods: [], suggestedLevels: [] }
    };
    specExample["metadata"] = metadata;

    const specEngine = new SpecificationEngine({ artifactStore: hlStore, authorizeApprover: () => false });
    const reviewedSpec = await specEngine.submitForReview(specExample);
    const approvedSpec = SpecificationSchema.parse({ ...reviewedSpec, status: "approved", approvedBy: "human-owner" });
    hlStore.close();

    const specPath = join(hlRepo, "spec.json");
    writeFileSync(specPath, JSON.stringify(approvedSpec, null, 2));

    const defaultServices = await createDefaultHighLevelServices();
    const makeGate = (id: string): QualityGate => ({
      id,
      async evaluate(context) {
        const config = CheckConfigurationSchema.parse(context.definition.configuration);
        const input = context.input as {
          sourceRevision: string;
          specFingerprint: string;
          scope: "task" | "workflow";
        };
        const observation = ObservationSchema.parse({
          schemaVersion: 2,
          checkId: id,
          runId: context.runId,
          taskId: context.taskId,
          attemptId: context.attemptId,
          sourceRevision: input.sourceRevision,
          specFingerprint: input.specFingerprint,
          scope: input.scope,
          independentExecution: true,
          isolated: true,
          executorId: "independent-verifier",
          role: config.role,
          method: config.method,
          ...(config.command ? { command: config.command, exitCode: 0 } : {}),
          testNames: config.testNames,
          criteria: config.criterionIds.map((criterionId) => ({ criterionId, passed: true, summary: "Verified" })),
          summary: "Independent check passed"
        });
        return {
          ok: true,
          value: QualityGateResultSchema.parse({
            gateId: id,
            runId: context.runId,
            taskId: context.taskId,
            evaluationId: `${id}-${context.attemptId}`,
            status: "passed",
            findings: [],
            producedArtifacts: [],
            evaluatedAt: new Date().toISOString(),
            metadata: { verification: observation }
          })
        };
      }
    });

    const skillsCatalogRoot = resolve(REPO_ROOT, "skills");
    const catalogSkills = await loadSkillCatalog(skillsCatalogRoot, {
      source: "builtin",
      supportedCommands: SUPPORTED_CLI_COMMANDS
    });
    const skillStoreRoot = join(tmpRoot, "hl-skills-store");
    mkdirSync(skillStoreRoot, { mode: 0o700 });
    chmodSync(skillStoreRoot, 0o700);
    const skillStore = new SkillFileStore(skillStoreRoot);
    const skillManager = new SkillManager({
      store: skillStore,
      supportedCommands: SUPPORTED_CLI_COMMANDS,
      approvedBuiltinDigests: catalogSkills.map((s) => s.definition.digest)
    });
    const skillsSyncPort = new SkillsSetupSynchronizer(
      skillManager,
      skillStore,
      catalogSkills.map((s) => ({
        root: s.directory,
        source: "builtin" as const,
        expectedDigest: s.definition.digest
      }))
    );

    const hlMachineRoot = join(tmpRoot, "hl-machine");
    for (const sub of ["config", "data", "state", "data/bin"]) {
      const p = join(hlMachineRoot, sub);
      mkdirSync(p, { recursive: true, mode: 0o700 });
      chmodSync(p, 0o700);
    }
    const basePlatform = await defaultServices.machine.platform();

    const fullServices: HighLevelServices = {
      ...defaultServices,
      machine: {
        ...defaultServices.machine,
        platform: async () => ({
          ...basePlatform,
          paths: {
            config: join(hlMachineRoot, "config"),
            data: join(hlMachineRoot, "data"),
            state: join(hlMachineRoot, "state"),
            managedBin: join(hlMachineRoot, "data", "bin")
          }
        })
      },
      gates: [makeGate("test-0"), makeGate("review")],
      skills: () => skillsSyncPort,
      mcpGateway: {
        async status() {
          return {
            reachable: true,
            version: "0.1.0",
            backends: [{ serviceId: "gitnexus", state: "healthy", detail: "Ready via Gateway" }]
          };
        }
      }
    };

    // 1. repo inspect
    const cmdRepoInspect = await runHighLevelCli(["repo", "inspect", "--json"], { cwd: hlRepo, services: fullServices });
    expect(cmdRepoInspect.ok).toBe(true);
    expect(extractCommandOutput(cmdRepoInspect).outcome).toBe("inspected");

    // 2. task plan (--write)
    const cmdTaskPlan = await runHighLevelCli(["task", "plan", "--spec", specPath, "--write", "--json"], {
      cwd: hlRepo,
      services: fullServices
    });
    expect(cmdTaskPlan.ok).toBe(true);
    expect(extractCommandOutput(cmdTaskPlan).outcome).toBe("planned");
    const planWorkflowPath = join(
      hlRepo,
      ".bflow/plans",
      `${approvedSpec.specId.replace(/[^A-Za-z0-9._-]/g, "_")}.workflow.json`
    );

    // 3. task implement
    const cmdTaskImplement = await runHighLevelCli(
      [
        "task",
        "implement",
        "implement",
        "--run",
        "run-1",
        "--spec",
        specPath,
        "--workflow",
        planWorkflowPath,
        "--owned-path",
        "src/math",
        "--json"
      ],
      { cwd: hlRepo, services: fullServices }
    );
    expect(cmdTaskImplement.ok).toBe(true);
    const implOut = extractCommandOutput(cmdTaskImplement);
    expect(implOut.outcome).toBe("prepared");
    const taskWorktreePath = implOut.steps?.find((s) => s.id === "prepare-worktree")?.data?.["worktreePath"] as
      | string
      | undefined;
    expect(taskWorktreePath).toBeDefined();

    // 4. verify before & after implementation commit
    const strategy = new TestStrategyResolver().resolve(approvedSpec);
    const criterionIds = approvedSpec.acceptanceCriteria.map((c) => c.id);
    const testNames = strategy.criterionMappings.flatMap((m) => m.testNames);
    const verifyPlanPath = join(hlRepo, "verify-plan.json");
    writeFileSync(
      verifyPlanPath,
      JSON.stringify(
        {
          runId: "run-1",
          taskId: "implement",
          scope: "task",
          specification: approvedSpec,
          strategy,
          implementerIds: ["developer-1"],
          maxIterations: 3,
          checks: [
            {
              id: "test-0",
              name: "test-0",
              evaluator: "test-0",
              required: true,
              timeout: { executionTimeoutMs: 5000, onTimeout: "block" },
              configuration: {
                kind: "deterministic",
                method: "unit_test",
                command: strategy.targetCommands[0],
                criterionIds,
                testNames,
                role: "tester",
                levels: [...strategy.requiredTestLevels]
              }
            },
            {
              id: "review",
              name: "review",
              evaluator: "review",
              required: true,
              timeout: { executionTimeoutMs: 5000, onTimeout: "block" },
              configuration: {
                kind: "review",
                method: "manual_review",
                criterionIds: [],
                testNames: [],
                role: "reviewer",
                levels: []
              }
            }
          ]
        },
        null,
        2
      )
    );

    const cmdVerifyBeforeCommit = await runHighLevelCli(
      ["verify", "implement", "--run", "run-1", "--plan", verifyPlanPath, "--json"],
      { cwd: hlRepo, services: fullServices }
    );
    expect(cmdVerifyBeforeCommit.ok).toBe(false);
    expect(["not_passed", "failed"]).toContain(extractCommandOutput(cmdVerifyBeforeCommit).outcome);

    if (taskWorktreePath) {
      writeFileSync(
        join(taskWorktreePath, "src/math/average.ts"),
        "export const average = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;\n"
      );
      git(taskWorktreePath, "add", "src/math/average.ts");
      git(taskWorktreePath, "commit", "-q", "-m", "fix empty array average");
    }

    const cmdVerify = await runHighLevelCli(
      ["verify", "implement", "--run", "run-1", "--plan", verifyPlanPath, "--json"],
      { cwd: hlRepo, services: fullServices }
    );
    expect(cmdVerify.ok).toBe(true);
    expect(extractCommandOutput(cmdVerify).outcome).toBe("passed");

    // 5. git prepare (without --yes -> approval_required; with --yes -> integration_prepared)
    const cmdGitPreparePreview = await runHighLevelCli(
      ["git", "prepare", "run-1", "--workflow", planWorkflowPath, "--json"],
      { cwd: hlRepo, services: fullServices }
    );
    expect(cmdGitPreparePreview.ok).toBe(false);
    expect(extractCommandOutput(cmdGitPreparePreview).outcome).toBe("approval_required");

    const cmdGitPrepareYes = await runHighLevelCli(
      ["git", "prepare", "run-1", "--workflow", planWorkflowPath, "--yes", "--json"],
      { cwd: hlRepo, services: fullServices }
    );
    expect(cmdGitPrepareYes.ok, JSON.stringify(cmdGitPrepareYes.envelope)).toBe(true);
    expect(extractCommandOutput(cmdGitPrepareYes).outcome).toBe("integration_prepared");

    // 6. mcp status & 8. skills sync: absent Gateway stays not-ready; default skills wiring remains available.
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const defaultXdgConfigHome = join(tmpRoot, "default-cli-xdg");
    process.env.XDG_CONFIG_HOME = defaultXdgConfigHome;
    mkdirSync(defaultXdgConfigHome, { recursive: true, mode: 0o700 });
    try {
      const cmdMcpStatusDefaultCli = await runHighLevelCli(["mcp", "status", "--json"], { cwd: hlRepo });
      expect(cmdMcpStatusDefaultCli.ok).toBe(false);
      expect(extractCommandOutput(cmdMcpStatusDefaultCli).outcome).toBe("not_ready");
      const mcpData = (cmdMcpStatusDefaultCli.envelope?.result.output as { data: { gateway: unknown; backends: unknown[] } }).data;
      expect(mcpData.gateway).toMatchObject({ configured: false, reachable: false });
      expect(mcpData.backends).toEqual([]);
    } finally {
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }

    // 7. tool status
    const cmdToolStatus = await runHighLevelCli(["tool", "status", "--json"], {
      cwd: hlRepo,
      services: fullServices
    });
    expect(["ready", "not_ready"]).toContain(extractCommandOutput(cmdToolStatus).outcome);

    // 8. skills sync: QA-P34-02 fixed — 1st run on empty store converges immediately with outcome="synced", 2nd run returns "already_synced"
    const cmdSkillsSyncWiredFirst = await runHighLevelCli(["skills", "sync", "--allow-machine-scope", "--json"], {
      cwd: hlRepo,
      services: fullServices
    });
    expect(cmdSkillsSyncWiredFirst.ok).toBe(true);
    expect(extractCommandOutput(cmdSkillsSyncWiredFirst).outcome).toBe("synced");

    const cmdSkillsSyncWiredSecond = await runHighLevelCli(["skills", "sync", "--allow-machine-scope", "--json"], {
      cwd: hlRepo,
      services: fullServices
    });
    expect(cmdSkillsSyncWiredSecond.ok).toBe(true);
    expect(extractCommandOutput(cmdSkillsSyncWiredSecond).outcome).toBe("already_synced");

    // 9. agent check (claude) — QA-P34-05: real authenticated claude reports "ready"; unconfigured/unauthenticated host reports "not_ready"
    const cmdAgentCheckClaude = await runHighLevelCli(["agent", "check", "claude", "--json"], {
      cwd: hlRepo,
      services: fullServices
    });
    if (livePlatformEnabled) {
      expect(cmdAgentCheckClaude.ok).toBe(true);
      expect(extractCommandOutput(cmdAgentCheckClaude).outcome).toBe("ready");
    } else {
      expect(["ready", "not_ready"]).toContain(extractCommandOutput(cmdAgentCheckClaude).outcome);
      expect(cmdAgentCheckClaude.ok).toBe(extractCommandOutput(cmdAgentCheckClaude).outcome === "ready");
      if (!cmdAgentCheckClaude.ok) {
        expect(cmdAgentCheckClaude.exitCode).toBe(3);
      }
    }
  }, 180_000);
});
