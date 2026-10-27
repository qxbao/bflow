import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAgenticHost, resolvePrivateRuntimeStateDirectory, type AgenticHostPlatformOptions } from "@bflow/runtime";
import {
  defaultHostEnvironment,
  defaultMachineConfig,
  detectPlatform,
  isolatedPlatformProfile,
  SetupStateStore
} from "@bflow/machine-setup";
import { gitNexusStorageLockPath } from "../../../packages/tool-installer/src/index.js";
import { openLifecycleHost } from "../src/agentic-host.js";
import { EnvironmentLifecycle, identifyRepository, readEnvironmentConfig, runCli } from "../src/index.js";
import { wrapSetupComponents } from "../src/setup-gateway.js";
import { renderEnvironmentConfigYaml } from "../src/config-format.js";
import { HerdrProcesses } from "./fixtures/herdr-processes.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function repository() {
  const root = await realpath(await mkdtemp("/tmp/bflow-recovery-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  expect((await runCli(["init"], { cwd: root })).ok).toBe(true);
  const repository = await identifyRepository(root);
  const config = await readEnvironmentConfig(repository);
  return { repository, config, env: { ...process.env } };
}

describe.skipIf(process.platform === "win32")("persistent host recovery", () => {
  it("quiesces and shuts down the persisted platform even when current role selections differ", async () => {
    const input = await repository();
    const root = input.repository.root;
    const binary = join(root, "herdr.mjs");
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({running:false}));\n', { mode: 0o700 });
    const platform: AgenticHostPlatformOptions = {
      schemaVersion: 3, machineId: "old-machine", repositoryId: input.repository.id,
      roles: (["conversation", "coordinator"] as const).map(role => ({ role, provider: "codex", required: true,
        permissionMode: "restricted", capabilityIds: [], mcpServiceIds: [], toolIds: [], skillSelections: [] })),
      skillsStoreRoot: join(root, "skills"), approvedBuiltinSkillDigests: []
    };
    const existing = await ensureAgenticHost({ repositoryPath: root, sessionId: input.repository.sessionName, herdrBinary: binary, platform });
    cleanup.push(() => existing.shutdown().catch(() => undefined));
    const path = join(root, ".bflow/state/host", input.repository.sessionName, "host.json");
    const before = await readFile(path, "utf8");
    const host = await openLifecycleHost(input);
    expect((await host.quiesce({ timeoutMs: 5000 })).ok).toBe(true);
    expect(await host.runtime.findRuns({ limit: 1 })).toEqual({ ok: true, value: { items: [] } });
    await host.shutdown();
    await host.close();
    expect(await readFile(path, "utf8")).toBe(before);
  });

  // The fstat spy resolves descriptors through /proc/self/fd, which only exists on Linux.
  it.skipIf(process.platform !== "linux")("finds external private authority for status, quiesce and shutdown after a non-POSIX startup", async () => {
    const input = await repository();
    const stateHome = await mkdtemp("/tmp/bflow-private-recovery-");
    cleanup.push(() => rm(stateHome, { recursive: true, force: true }));
    const oldStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateHome;
    cleanup.push(async () => { if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldStateHome; });
    const observe = fs.fstatSync;
    const probe = vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, ...args: unknown[]) => {
      const stat = Reflect.apply(observe, fs, [fd, ...args]);
      return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(input.repository.root + "/.bflow/.private-state-probe-")
        ? Object.assign(stat, { mode: 0o100777 }) : stat;
    }) as typeof fs.fstatSync);
    cleanup.push(async () => { probe.mockRestore(); });
    const binary = join(stateHome, "herdr.mjs");
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({running:false}));\n', { mode: 0o700 });
    const existing = await ensureAgenticHost({ repositoryPath: input.repository.root, sessionId: input.repository.sessionName, herdrBinary: binary });
    cleanup.push(() => existing.shutdown().catch(() => undefined));
    const path = join(resolvePrivateRuntimeStateDirectory(input.repository.root), "host", input.repository.sessionName, "host.json");
    const before = await readFile(path, "utf8");
    const report = await new EnvironmentLifecycle(input.repository.root, { runner: new HerdrProcesses(),
      providerOverrides: { codex: { available: true, authenticated: true } } }).doctor();
    expect(report.checks.find(check => check.checkId === "private-runtime-state")).toMatchObject({
      status: "passed", message: expect.stringContaining(stateHome)
    });
    const host = await openLifecycleHost(input);
    expect(await host.runtime.findRuns({ limit: 1 })).toEqual({ ok: true, value: { items: [] } });
    expect((await host.quiesce({ timeoutMs: 5000 })).ok).toBe(true);
    await host.shutdown();
    await host.close();
    expect(await readFile(path, "utf8")).toBe(before);
    expect(fs.existsSync(join(input.repository.root, ".bflow/state/host"))).toBe(false);
  });

  it("preserves offline session ownership when provider preparation times out before starting Herdr", async () => {
    const input = await repository();
    const runner = new HerdrProcesses();
    const up = vi.fn();
    const prepareRoles = vi.fn(async (options: { signal?: AbortSignal }) => {
      await new Promise<void>((_, reject) => options.signal!.addEventListener("abort", () => reject(new Error("preparation aborted")), { once: true }));
    });
    const quiesce = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const integration = {
      prepareRoles,
      manager: { init: vi.fn(), up, down: vi.fn(), attach: vi.fn(), doctorSession: vi.fn(),
        getManifest: vi.fn(async () => ({ ok: true as const, value: null })) },
      runtime: { findRuns: vi.fn(async () => ({ ok: true as const, value: { items: [] } })), getRun: vi.fn() },
      quiesce, shutdownHost: vi.fn(async () => {}), close: vi.fn(async () => {})
    };
    const lifecycle = new EnvironmentLifecycle(input.repository.root, { runner, integration,
      providerOverrides: { codex: { available: true, authenticated: true }, claude: { available: true, authenticated: true } } });
    await expect(lifecycle.up(500)).rejects.toThrow(/timed out.*Automatic cleanup was not attempted because startup had not changed the session/s);
    expect(prepareRoles).toHaveBeenCalledOnce();
    expect(up).not.toHaveBeenCalled();
    expect(quiesce).not.toHaveBeenCalled();
    expect(integration.manager.down).not.toHaveBeenCalled();
    expect(integration.shutdownHost).not.toHaveBeenCalled();
    expect(runner.session(input.repository.sessionName).running).toBe(false);
    await expect(readFile(join(input.repository.root, ".bflow/state/operation.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves uncertain pane dispatch when no recoverable receipt exists", async () => {
    const input = await repository();
    const runner = new HerdrProcesses();
    const up = vi.fn(async (_session: string, options?: { signal?: AbortSignal }) => new Promise<never>((_, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new Error("dispatch interrupted")), { once: true });
    }));
    const quiesce = vi.fn();
    const integration = { prepareRoles: vi.fn(async () => {}),
      manager: { init: vi.fn(), up, down: vi.fn(), attach: vi.fn(), doctorSession: vi.fn(),
        getManifest: vi.fn(async () => ({ ok: true as const, value: null })) }, quiesce };
    const lifecycle = new EnvironmentLifecycle(input.repository.root, { runner, integration,
      providerOverrides: { codex: { available: true, authenticated: true }, claude: { available: true, authenticated: true } } });
    await expect(lifecycle.up(500)).rejects.toThrow(/delivery is uncertain.*no recoverable pane receipt/s);
    expect(up).toHaveBeenCalledOnce();
    expect(quiesce).not.toHaveBeenCalled();
    expect(runner.session(input.repository.sessionName).running).toBe(true);
    expect(JSON.parse(await readFile(join(input.repository.root, ".bflow/state/operation.json"), "utf8")).phase).toBe("manager_pending");
  });

  it("stops a retained offline host via bflow down when preflight failed before creating a manifest", async () => {
    const input = await repository();
    const root = input.repository.root;
    const binary = join(root, "herdr.mjs");
    await writeFile(binary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({running:false}));\n', { mode: 0o700 });
    const existing = await ensureAgenticHost({ repositoryPath: root, sessionId: input.repository.sessionName, herdrBinary: binary });
    cleanup.push(() => existing.shutdown().catch(() => undefined));
    const quiesce = vi.fn(async () => ({ ok: true as const, value: undefined }));
    const shutdownHost = vi.fn(async () => { await existing.shutdown(); });
    const integration = {
      manager: { init: vi.fn(), up: vi.fn(), down: vi.fn(), attach: vi.fn(), doctorSession: vi.fn(),
        getManifest: vi.fn(async () => ({ ok: true as const, value: null })) },
      runtime: { findRuns: vi.fn(async () => ({ ok: true as const, value: { items: [] } })), getRun: vi.fn() },
      quiesce, shutdownHost, close: vi.fn(async () => {})
    };
    const lifecycle = new EnvironmentLifecycle(root, { runner: new HerdrProcesses(), integration });
    await expect(lifecycle.down()).resolves.toMatchObject({ server: "stopped", manifest: null });
    expect(quiesce).toHaveBeenCalledOnce();
    expect(shutdownHost).toHaveBeenCalledOnce();
  });

  it("passes impactIndex with resolved executable, home and storageLockPath when approved GitNexus binary and home exist, and omits it when missing", async () => {
    const bflowHome = await realpath(await mkdtemp("/tmp/bflow-impact-home-"));
    cleanup.push(() => rm(bflowHome, { recursive: true, force: true }));
    const oldBflowHome = process.env.BFLOW_HOME;
    process.env.BFLOW_HOME = bflowHome;
    cleanup.push(async () => {
      if (oldBflowHome === undefined) delete process.env.BFLOW_HOME;
      else process.env.BFLOW_HOME = oldBflowHome;
    });

    // Case 1: binary and gitnexus-home are missing -> impactIndex is omitted
    const missingInput = await repository();
    const missingRoot = missingInput.repository.root;
    const herdrBinary = join(missingRoot, "herdr.mjs");
    await writeFile(herdrBinary, '#!/usr/bin/env node\nconsole.log(JSON.stringify({running:false}));\n', { mode: 0o700 });
    missingInput.config.environment.herdrBinary = herdrBinary;
    // Host resolution re-reads .bflow/config.yml; persist the override instead of diverging in memory.
    await writeFile(join(missingInput.repository.root, ".bflow/config.yml"), renderEnvironmentConfigYaml(missingInput.config));
    missingInput.env.BFLOW_HOME = bflowHome;

    const missingHost = await openLifecycleHost(missingInput);
    cleanup.push(() => missingHost.shutdown().catch(() => undefined));
    await missingHost.prepare({ signal: AbortSignal.abort() }).catch(() => undefined);
    const missingHostJson = JSON.parse(
      await readFile(join(missingRoot, ".bflow/state/host", missingInput.repository.sessionName, "host.json"), "utf8")
    ) as { impactIndex?: unknown };
    expect(missingHostJson.impactIndex).toBeUndefined();
    await missingHost.shutdown();
    await missingHost.close();

    // Case 2: approved binary and gitnexus-home exist -> impactIndex has all 3 paths
    const platform = isolatedPlatformProfile(detectPlatform(defaultHostEnvironment()), bflowHome);
    await mkdir(platform.paths.config, { recursive: true, mode: 0o700 });
    await mkdir(platform.paths.data, { recursive: true, mode: 0o700 });
    await mkdir(platform.paths.state, { recursive: true, mode: 0o700 });
    await mkdir(platform.paths.managedBin, { recursive: true, mode: 0o700 });
    const fakeGitNexus = join(platform.paths.managedBin, "gitnexus");
    await writeFile(fakeGitNexus, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
    const store = new SetupStateStore(platform.paths, { uid: platform.uid, now: () => new Date() });
    const config = defaultMachineConfig();
    config.toolPins = [
      {
        schemaVersion: 3,
        toolId: "gitnexus",
        installerId: "fixture",
        method: "npm",
        version: "1.6.12",
        source: "https://registry.npmjs.org/gitnexus/-/gitnexus-1.6.12.tgz",
        integrity: "a".repeat(64),
        platforms: ["linux", "darwin"],
        requiresElevation: false
      }
    ];
    const runner = { run: async () => ({ exitCode: 0, timedOut: false, stdout: "", stderr: "" }) };
    const serviceManager = {
      kind: "systemd-user" as const,
      unitPath: (id: string) => join(bflowHome, `${id}.service`),
      render: (def: unknown) => JSON.stringify(def),
      inspect: async () => ({ installed: false, digest: null, active: false }),
      install: async () => ({ ownedPaths: [], diagnostics: [], changed: true }),
      listInstalled: async () => [],
      remove: async () => ({ ownedPaths: [], diagnostics: [] })
    };
    const components = wrapSetupComponents([], {
      platform,
      store,
      config,
      runner,
      serviceManager,
      launchRequirements: [{ toolId: "gitnexus", executable: fakeGitNexus, args: ["mcp"], requirements: [] }]
    });
    await components[0]!.apply({ platform, runner, mode: "apply", now: () => new Date() });

    const gitnexusState = join(platform.paths.state, "gitnexus");
    const homeDir = join(gitnexusState, "gitnexus-home");
    await mkdir(homeDir, { recursive: true, mode: 0o700 });

    const readyInput = await repository();
    const readyRoot = readyInput.repository.root;
    const readyHerdr = join(readyRoot, "herdr.mjs");
    await writeFile(readyHerdr, '#!/usr/bin/env node\nconsole.log(JSON.stringify({running:false}));\n', { mode: 0o700 });
    readyInput.config.environment.herdrBinary = readyHerdr;
    // Host resolution re-reads .bflow/config.yml; persist the override instead of diverging in memory.
    await writeFile(join(readyInput.repository.root, ".bflow/config.yml"), renderEnvironmentConfigYaml(readyInput.config));
    readyInput.env.BFLOW_HOME = bflowHome;

    const readyHost = await openLifecycleHost(readyInput);
    cleanup.push(() => readyHost.shutdown().catch(() => undefined));
    await readyHost.prepare({ signal: AbortSignal.abort() }).catch(() => undefined);
    const readyHostJson = JSON.parse(
      await readFile(join(readyRoot, ".bflow/state/host", readyInput.repository.sessionName, "host.json"), "utf8")
    ) as { impactIndex?: unknown };
    expect(readyHostJson.impactIndex).toEqual({
      executable: fakeGitNexus,
      home: await realpath(homeDir),
      storageLockPath: gitNexusStorageLockPath(gitnexusState, await realpath(readyRoot))
    });
    await readyHost.shutdown();
    await readyHost.close();
  });
});

describe("terminateHostOwner", () => {
  it("refuses to signal a process that is not this session's host daemon", async () => {
    const { terminateHostOwner } = await import("../src/agentic-host.js");
    const dir = await realpath(await mkdtemp("/tmp/bflow-owner-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "owner.json"), JSON.stringify({ pid: process.pid }));
    await expect(terminateHostOwner(dir)).rejects.toThrow("refusing to signal");
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });
  it("is a no-op without an owner receipt", async () => {
    const { terminateHostOwner } = await import("../src/agentic-host.js");
    const dir = await realpath(await mkdtemp("/tmp/bflow-owner-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    await expect(terminateHostOwner(dir)).resolves.toBeUndefined();
  });
});

describe("environmentProcessRunner and probeAgyAccess isolation", () => {
  it("completes capture execution when a exited command leaves a grandchild holding stdout", async () => {
    const { environmentProcessRunner } = await import("../src/environment-process.js");
    const dir = await realpath(await mkdtemp("/tmp/bflow-runner-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const res = await environmentProcessRunner.run({
      executable: process.execPath,
      args: [
        "-e",
        "import('node:child_process').then(({ spawn }) => { spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'inherit' }).unref(); process.stdout.write('ok\\n'); process.exit(0); });"
      ],
      cwd: dir,
      timeoutMs: 3_000
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("ok\n");
  });

  it("isolates HOME and adopts onboarding.json when probing agy models access", async () => {
    const { probeAgyAccess } = await import("../src/agy-access.js");
    const nativeHome = await realpath(await mkdtemp("/tmp/bflow-agy-home-"));
    cleanup.push(() => rm(nativeHome, { recursive: true, force: true }));
    const cacheDir = join(nativeHome, ".gemini", "antigravity-cli", "cache");
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(join(cacheDir, "onboarding.json"), '{"onboardingComplete":true}\n', { mode: 0o600 });
    let observedHome: string | undefined;
    let observedOnboarding: string | undefined;
    const res = await probeAgyAccess(
      {
        async run(req) {
          observedHome = req.env?.["HOME"];
          if (observedHome) {
            observedOnboarding = await readFile(join(observedHome, ".gemini", "antigravity-cli", "cache", "onboarding.json"), "utf8");
          }
          return { exitCode: 0, stdout: "gemini-3.8-flash-medium\tGemini 3.8 Flash\n", stderr: "" };
        }
      },
      { cwd: nativeHome, env: { ...process.env, HOME: nativeHome }, timeoutMs: 5_000 }
    );
    expect(res.status).toBe("available");
    expect(observedHome).toBeDefined();
    expect(observedHome).not.toBe(nativeHome);
    expect(observedOnboarding).toBe('{"onboardingComplete":true}\n');
  });
});
