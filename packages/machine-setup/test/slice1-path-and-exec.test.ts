import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupReceiptSchema, type SetupReceipt, type SetupStep, type ToolInstaller } from "@bflow/contracts";
import {
  EnvironmentManifestSchema,
  MachineSetupService,
  NonInteractiveApprover,
  PATH_BLOCK_END,
  PATH_BLOCK_START,
  PathComponent,
  SetupStateStore,
  ToolInstallerRegistry,
  defaultMachineConfig,
  detectPlatform,
  digest,
  findExecutable,
  parseEnvironmentManifest,
  probeTools,
  type CommandRunner,
  type HostEnvironment,
  type PlatformProfile
} from "../src/index.js";

const NOW = new Date("2026-02-01T00:00:00.000Z");
const uid = typeof process.getuid === "function" ? process.getuid() : null;
const gid = typeof process.getgid === "function" ? process.getgid() : null;

let root: string;
let home: string;
let realBin: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bflow-s1-ms-")));
  home = path.join(root, "home");
  realBin = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(realBin, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeExecutable(dir: string, name: string, body = "#!/bin/sh\nexit 0\n"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await writeFile(target, body);
  await chmod(target, 0o755);
  return target;
}

describe("Slice 1 — Executable-Directory $PATH Hazard & Managed Tool Bin Paths", () => {
  it("findExecutable ignores +x provider subdirectories (claude/, codex/, agy/) on PATH and resolves real binaries", async () => {
    const poisonedSuperpowersDir = path.join(root, "tools", "superpowers");
    for (const provider of ["claude", "codex", "agy"]) {
      const subdir = path.join(poisonedSuperpowersDir, provider);
      await mkdir(subdir, { recursive: true, mode: 0o755 });
      await chmod(subdir, 0o755);
    }

    for (const provider of ["claude", "codex", "agy"]) {
      expect(await findExecutable(provider, [poisonedSuperpowersDir], "linux")).toBeNull();
    }

    const realClaude = await writeExecutable(realBin, "claude");
    const realCodex = await writeExecutable(realBin, "codex");
    const realAgy = await writeExecutable(realBin, "agy");

    expect(await findExecutable("claude", [poisonedSuperpowersDir, realBin], "linux")).toBe(realClaude);
    expect(await findExecutable("codex", [poisonedSuperpowersDir, realBin], "linux")).toBe(realCodex);
    expect(await findExecutable("agy", [poisonedSuperpowersDir, realBin], "linux")).toBe(realAgy);
  });

  it("probeTools discovers managed Python-wheel / archive binaries inside <data>/tools/<toolId>/bin", async () => {
    const platform = detectPlatform({
      platform: "linux",
      arch: "x64",
      env: { SHELL: "/bin/bash", PATH: realBin },
      homeDir: home,
      hostname: "box",
      uid: 1000,
      gid: 1000
    });
    const mempalaceBinDir = path.join(platform.paths.data, "tools", "mempalace", "bin");
    const mempalaceExe = await writeExecutable(mempalaceBinDir, "mempalace");

    const runner: CommandRunner = {
      async run(argv) {
        if (path.basename(argv[0]!) === "mempalace") {
          return { exitCode: 0, stdout: "mempalace 3.3.0\n", stderr: "", timedOut: false };
        }
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
    };

    const observations = await probeTools(platform, runner, {
      required: new Set(["mempalace"]),
      knownInstallDirs: (p) => [p.paths.managedBin]
    });
    const mempalace = observations.find((o) => o.toolId === "mempalace")!;
    expect(mempalace).toMatchObject({
      status: "path_missing",
      resolvedPath: mempalaceExe,
      pathMissingDir: mempalaceBinDir,
      version: "3.3.0",
      required: true
    });
  });

  it("MachineSetupService never adds non-CLI plugin bundle dirs (superpowers) to PATH and maps mempalace to tools/mempalace/bin", async () => {
    for (const name of ["node", "pnpm", "git", "herdr", "claude", "codex", "agy"]) {
      await writeExecutable(realBin, name);
    }
    const versions: Record<string, string> = {
      node: "v22.13.0",
      pnpm: "12.5.1",
      git: "git version 2.43.0",
      herdr: "herdr 0.9.5",
      claude: "2.1.104 (Claude Code)",
      codex: "codex-cli 0.120.0",
      agy: "1.4.2",
      rtk: "rtk 0.33.0",
      gitnexus: "1.6.12",
      mempalace: "mempalace 3.3.0"
    };
    const runner: CommandRunner = {
      async run(argv) {
        const base = path.basename(argv[0]!);
        return {
          exitCode: 0,
          stdout: versions[base] ? `${versions[base]}\n` : "",
          stderr: "",
          timedOut: false
        };
      }
    };
    const host: HostEnvironment = {
      platform: "linux",
      arch: "x64",
      homeDir: home,
      hostname: "testhost",
      uid,
      gid,
      env: { PATH: realBin, SHELL: "/bin/bash", HOME: home }
    };

    const cfgDir = path.join(home, ".config", "bflow");
    const dataDir = path.join(home, ".local", "share", "bflow");
    const stateDir = path.join(home, ".local", "state", "bflow");
    await mkdir(cfgDir, { recursive: true, mode: 0o700 });

    const sha = "a".repeat(64);
    const pins = [
      {
        schemaVersion: 3,
        toolId: "superpowers",
        installerId: "bflow-tools-native",
        method: "verified_archive",
        version: "5.0.7",
        source: "https://github.com/obra/superpowers/archive/refs/tags/v5.0.7.tar.gz",
        integrity: sha,
        platforms: ["linux"],
        requiresElevation: false
      },
      {
        schemaVersion: 3,
        toolId: "mempalace",
        installerId: "bflow-tools",
        method: "verified_archive",
        version: "3.3.0",
        source: "https://files.pythonhosted.org/packages/mempalace-3.3.0-py3-none-any.whl",
        integrity: sha,
        platforms: ["linux"],
        requiresElevation: false
      },
      {
        schemaVersion: 3,
        toolId: "rtk",
        installerId: "bflow-tools",
        method: "verified_archive",
        version: "0.33.0",
        source: "https://github.com/rtk-ai/rtk/releases/download/v0.33.0/rtk.tar.gz",
        integrity: sha,
        platforms: ["linux"],
        requiresElevation: false
      },
      {
        schemaVersion: 3,
        toolId: "gitnexus",
        installerId: "bflow-tools",
        method: "npm",
        version: "1.6.12",
        source: "https://registry.npmjs.org/gitnexus/-/gitnexus-1.6.12.tgz",
        integrity: sha,
        platforms: ["linux"],
        requiresElevation: false
      }
    ];
    await writeFile(
      path.join(cfgDir, "machine.json"),
      JSON.stringify({ ...defaultMachineConfig(), toolPins: pins }),
      { mode: 0o600 }
    );

    const installed = new Set<string>();
    const makeReceipt = (req: Parameters<ToolInstaller["apply"]>[0]): SetupReceipt =>
      SetupReceiptSchema.parse({
        schemaVersion: 3,
        receiptId: `rec-${req.step.componentId}`,
        planId: req.planId,
        planDigest: req.planDigest,
        stepId: req.step.stepId,
        scope: req.step.scope,
        status: installed.has(req.step.componentId) ? "applied" : "failed",
        desiredStateDigest: req.step.desiredStateDigest,
        observedStateDigest: installed.has(req.step.componentId) ? req.step.desiredStateDigest : null,
        ownedPaths: [],
        observedAt: NOW.toISOString(),
        diagnostics: [],
        idempotencyKey: req.step.idempotencyKey
      });

    const makeFakeInstaller = (installerId: string): ToolInstaller => ({
      installerId,
      plan: async (req) => ({
        ok: true,
        value: {
          schemaVersion: 3,
          stepId: `install_tool:${req.toolId}`,
          action: "install_tool",
          componentId: req.toolId,
          level: "machine",
          scope: req.scope,
          dependsOn: [],
          desiredStateDigest: digest(`${req.toolId}@${req.version}`),
          expectedStateDigest: null,
          requiresApproval: true,
          rollback: "remove_owned_install",
          toolInstall: req,
          idempotencyKey: req.idempotencyKey
        } satisfies SetupStep
      }),
      apply: async (req) => {
        if (req.step.componentId === "superpowers") {
          for (const p of ["claude", "codex", "agy"]) {
            await mkdir(path.join(dataDir, "tools", "superpowers", p), { recursive: true, mode: 0o755 });
          }
          await writeFile(path.join(dataDir, "tools", "superpowers", ".installed"), "ok");
        } else if (req.step.componentId === "mempalace") {
          await writeExecutable(path.join(dataDir, "tools", "mempalace", "bin"), "mempalace");
        } else if (req.step.componentId === "rtk") {
          await writeExecutable(path.join(dataDir, "tools", "rtk"), "rtk");
        } else if (req.step.componentId === "gitnexus") {
          await writeExecutable(path.join(dataDir, "tools", "gitnexus", "node_modules", ".bin"), "gitnexus");
        }
        installed.add(req.step.componentId);
        return { ok: true, value: makeReceipt(req) };
      },
      reconcile: async (req) => ({ ok: true, value: makeReceipt(req) })
    });

    const registry = new ToolInstallerRegistry();
    registry.register(makeFakeInstaller("bflow-tools"));
    registry.register(makeFakeInstaller("bflow-tools-native"));

    const svc = new MachineSetupService({
      host,
      runner,
      registry,
      approver: new NonInteractiveApprover(),
      now: () => NOW,
      knownInstallDirs: () => [],
      additionalToolObservations: async () => {
        const installed = await readFile(path.join(dataDir, "tools", "superpowers", ".installed"), "utf8").catch(
          () => null
        );
        return [
          {
            toolId: "superpowers",
            status: installed ? "present" : "missing",
            resolvedPath: null,
            realPath: null,
            version: installed ? "5.0.7" : null,
            binaryDigest: null,
            pathMissingDir: null,
            required: true,
            diagnostics: []
          }
        ];
      }
    });

    const report = await svc.run({ mode: "apply", assumeYes: true });
    expect(report.outcome).toBe("applied");

    const bashrc = await readFile(path.join(home, ".bashrc"), "utf8");
    const superpowersDir = path.join(dataDir, "tools", "superpowers");
    const bareMempalaceDir = path.join(dataDir, "tools", "mempalace");
    const mempalaceBinDir = path.join(dataDir, "tools", "mempalace", "bin");
    const rtkDir = path.join(dataDir, "tools", "rtk");
    const gitnexusBinDir = path.join(dataDir, "tools", "gitnexus", "node_modules", ".bin");

    expect(bashrc).not.toContain(superpowersDir);
    expect(bashrc).toContain(`'${mempalaceBinDir}'`);
    expect(bashrc).not.toContain(`'${bareMempalaceDir}'`);
    expect(bashrc).toContain(`'${rtkDir}'`);
    expect(bashrc).toContain(`'${gitnexusBinDir}'`);

    const envManifest = parseEnvironmentManifest(
      JSON.parse(await readFile(path.join(stateDir, "environment.json"), "utf8"))
    );
    expect(envManifest.ok).toBe(true);
    if (envManifest.ok) {
      expect(EnvironmentManifestSchema.parse(envManifest.value)).toEqual(envManifest.value);
      expect(envManifest.value.pathBlock?.dirs).not.toContain(superpowersDir);
      expect(envManifest.value.pathBlock?.dirs).not.toContain(bareMempalaceDir);
      expect(envManifest.value.pathBlock?.dirs).toContain(mempalaceBinDir);
    }
  });

  it("PathComponent prunes previously poisoned tools/superpowers and bare tools/mempalace entries from existing rc blocks", async () => {
    const platform: PlatformProfile = {
      os: "linux",
      arch: "x64",
      supportStatus: "supported",
      shell: "bash",
      shellPath: "/bin/bash",
      uid,
      gid,
      isRoot: false,
      elevationAvailable: false,
      homeDir: home,
      hostname: "testhost",
      machineId: "m-1",
      paths: {
        config: path.join(root, "cfg/bflow"),
        data: path.join(root, "data/bflow"),
        state: path.join(root, "state/bflow"),
        managedBin: path.join(home, ".local/bin")
      },
      pathEntries: ["/usr/bin"]
    };
    const superpowersDir = path.join(platform.paths.data, "tools", "superpowers");
    const bareMempalaceDir = path.join(platform.paths.data, "tools", "mempalace");
    const mempalaceBinDir = path.join(platform.paths.data, "tools", "mempalace", "bin");
    const customExternalDir = "/opt/custom/bin";

    const rcFile = path.join(home, ".bashrc");
    const lineFor = (d: string) => `case ":\${PATH}:" in *:'${d}':*) ;; *) PATH='${d}':"$PATH" ;; esac`;
    await writeFile(
      rcFile,
      [
        "# user header",
        PATH_BLOCK_START,
        lineFor(platform.paths.managedBin),
        lineFor(superpowersDir),
        lineFor(bareMempalaceDir),
        lineFor(customExternalDir),
        "export PATH",
        PATH_BLOCK_END,
        ""
      ].join("\n")
    );

    const store = new SetupStateStore(platform.paths, { uid, now: () => NOW });
    const component = new PathComponent({
      platform,
      store,
      observations: [{ pathMissingDir: mempalaceBinDir }],
      env: {}
    });

    expect(await component.desiredDirs()).toEqual([
      platform.paths.managedBin,
      customExternalDir,
      mempalaceBinDir
    ]);

    const ctx = {
      platform,
      mode: "apply" as const,
      now: () => NOW,
      runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) }
    };
    await component.apply(ctx);

    const updated = await readFile(rcFile, "utf8");
    expect(updated).not.toContain(superpowersDir);
    expect(updated).not.toContain(`'${bareMempalaceDir}'`);
    expect(updated).toContain(`'${customExternalDir}'`);
    expect(updated).toContain(`'${mempalaceBinDir}'`);
  });
});
