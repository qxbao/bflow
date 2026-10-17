import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SetupReceiptSchema, type ToolInstaller } from "@bflow/contracts";
import {
  MachineSetupService, NonInteractiveApprover, ToolInstallerRegistry, defaultMachineConfig,
  detectPlatform, digest, PathComponent, type CommandRunner, type MachineConfig, type MachineSetupServiceOptions,
  type PlatformProfile, type ToolInstallDescriptor
} from "../src/index.js";

let root: string;
let platform: PlatformProfile;
const versions: Record<string, string> = {
  node: "v22.13.0", pnpm: "12.5.1", git: "git version 2.40.0", herdr: "herdr 0.9.0",
  rtk: "rtk 0.33.0", gitnexus: "gitnexus 1.4.7", "chrome-devtools-mcp": "0.20.3"
};
const runner: CommandRunner = { run: async (argv) => ({
  exitCode: 0, stdout: versions[path.basename(argv[0]!)] ?? "", stderr: "", timedOut: false
}) };
async function executable(file: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
}
function service(options: Partial<MachineSetupServiceOptions> = {}) {
  return new MachineSetupService({
    host: { platform: "linux", arch: "x64", homeDir: path.join(root, "fallback"), hostname: "fallback",
      uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null,
      env: { HOME: path.join(root, "fallback"), SHELL: "/bin/bash", PATH: path.join(root, "bin") } },
    platform, runner, knownInstallDirs: () => [], approver: new NonInteractiveApprover(), ...options
  });
}
function pin(toolId: string, method: ToolInstallDescriptor["method"] = "npm"): ToolInstallDescriptor {
  return { schemaVersion: 3, toolId, installerId: "fixture", method, version: "1.4.7",
    source: "https://example.com/tool.tgz", integrity: "a".repeat(64), platforms: ["linux"], requiresElevation: false };
}
function registry(fail = false): ToolInstallerRegistry {
  const installed = new Set<string>();
  const receipt = (request: Parameters<ToolInstaller["apply"]>[0]) => SetupReceiptSchema.parse({
    schemaVersion: 3, receiptId: `receipt-${request.step.componentId}`, planId: request.planId,
    planDigest: request.planDigest, stepId: request.step.stepId, scope: request.step.scope,
    status: installed.has(request.step.componentId) ? "applied" : "failed",
    desiredStateDigest: request.step.desiredStateDigest,
    observedStateDigest: installed.has(request.step.componentId) ? request.step.desiredStateDigest : null,
    ownedPaths: [], observedAt: new Date().toISOString(), diagnostics: [], idempotencyKey: request.step.idempotencyKey
  });
  const installer: ToolInstaller = {
    installerId: "fixture",
    plan: async (request) => ({ ok: true, value: {
      schemaVersion: 3, stepId: `install:${request.toolId}`, action: "install_tool", componentId: request.toolId,
      level: "machine", scope: request.scope, dependsOn: [], desiredStateDigest: digest(request),
      expectedStateDigest: null, requiresApproval: true, rollback: "remove_owned_install", toolInstall: request,
      idempotencyKey: request.idempotencyKey
    } }),
    apply: async (request) => {
      if (fail) return { ok: false, error: { code: "validation", retryable: false, message: "fixture download failed" } };
      const destination = request.step.toolInstall!.destination;
      if (!path.isAbsolute(destination)) return { ok: false, error: { code: "validation", retryable: false, message: "absolute destination required" } };
      await executable(path.join(destination, "node_modules", ".bin", request.step.componentId));
      installed.add(request.step.componentId);
      return { ok: true, value: receipt(request) };
    },
    reconcile: async (request) => ({ ok: true, value: receipt(request) })
  };
  const out = new ToolInstallerRegistry();
  out.register(installer);
  return out;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "bflow-setup-integration-"));
  platform = detectPlatform({ platform: "linux", arch: "x64", homeDir: root, hostname: "isolated",
    uid: process.getuid?.() ?? null, gid: process.getgid?.() ?? null,
    env: { HOME: root, SHELL: "/bin/bash", PATH: path.join(root, "bin") } });
  await mkdir(path.join(root, "fallback"));
  for (const name of ["node", "pnpm", "git", "herdr"]) await executable(path.join(root, "bin", name));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("resolved setup integration", () => {
  it("uses the caller's isolated platform for observations and writes", async () => {
    const report = await service().run({ mode: "apply", assumeYes: true });
    expect(report.platform.homeDir).toBe(root);
    expect(report.outcome).toBe("applied");
    expect(await readFile(path.join(root, ".bashrc"), "utf8")).toContain(platform.paths.managedBin);
  });

  it("installs an owned launcher that a fresh shell can execute", async () => {
    const entrypoint = path.join(root, "cli entry'point.mjs");
    await writeFile(entrypoint, "console.log('launched:' + process.argv.slice(2).join('|'));\n");
    const report = await service({ launcher: { nodeBinary: process.execPath, entrypoint } }).run({ mode: "apply", assumeYes: true });
    expect(report.outcome).toBe("applied");
    const launcher = path.join(platform.paths.managedBin, "bflow");
    expect((await lstat(launcher)).mode & 0o777).toBe(0o755);
    const { stdout } = await promisify(execFile)("/bin/bash", ["--noprofile", "--rcfile", path.join(root, ".bashrc"), "-ic", "bflow 'argument with spaces'"],
      { env: { HOME: root, PATH: "/usr/bin:/bin" } });
    expect(stdout.trim().split("\n").at(-1)).toBe("launched:argument with spaces");
    const again = await service({ launcher: { nodeBinary: process.execPath, entrypoint } }).run({ mode: "apply", assumeYes: true });
    expect(again.outcome).toBe("healthy");
    await chmod(launcher, 0o644);
    const broken = await service({ launcher: { nodeBinary: process.execPath, entrypoint } }).run({ mode: "check" });
    expect(broken.outcome).toBe("changes_pending");
    const repaired = await service({ launcher: { nodeBinary: process.execPath, entrypoint } }).run({ mode: "apply", assumeYes: true });
    expect(repaired.outcome).toBe("applied");
    expect((await lstat(launcher)).mode & 0o777).toBe(0o755);
  });

  it("exposes bflow immediately through an existing user PATH directory", async () => {
    const userBin = path.join(root, ".local", "bin");
    await mkdir(userBin, { recursive: true });
    platform.pathEntries.push(userBin);
    const entrypoint = path.join(root, "cli.mjs");
    await writeFile(entrypoint, "console.log('immediate:' + process.argv[2]);\n");
    const report = await service({ launcher: { nodeBinary: process.execPath, entrypoint } }).run({ mode: "apply", assumeYes: true });
    expect(report.outcome).toBe("applied");
    const { stdout } = await promisify(execFile)("/bin/bash", ["--noprofile", "--norc", "-c", "bflow available"],
      { env: { HOME: root, PATH: `${userBin}:/usr/bin:/bin` } });
    expect(stdout.trim()).toBe("immediate:available");
  });

  it("preserves an existing launcher that Bflow does not own", async () => {
    const launcher = path.join(platform.paths.managedBin, "bflow");
    await executable(launcher);
    const original = await readFile(launcher, "utf8");
    const report = await service({ launcher: { nodeBinary: process.execPath, entrypoint: path.join(root, "cli.mjs") } })
      .run({ mode: "apply", assumeYes: true });
    expect(report.receipts.find((r) => r.stepId === "configure:path")?.status).toBe("failed");
    expect(await readFile(launcher, "utf8")).toBe(original);
    await expect(readFile(path.join(root, ".bashrc"))).rejects.toThrow();
  });

  it("persists the approved resolved config for subsequent setup runs", async () => {
    const config = { ...defaultMachineConfig(), skills: { catalogRef: "approved-catalog" } };
    const file = path.join(platform.paths.config, "machine.json");
    const dry = await service({ config }).run({ mode: "dry_run" });
    expect(dry.outcome).toBe("changes_pending");
    await expect(readFile(file)).rejects.toThrow();
    const applied = await service({ config }).run({ mode: "apply", assumeYes: true });
    expect(applied.outcome).toBe("applied");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(config);
    const again = await service().run({ mode: "check" });
    expect(again.configStatus).toBe("valid");
    expect(again.outcome).toBe("healthy");
  });

  it("uses explicit config and makes its provider and tool pins required", async () => {
    const config = { ...defaultMachineConfig(), providers: ["agy" as const], toolPins: [pin("gitnexus")] };
    const report = await service({ config, registry: registry() }).run({ mode: "dry_run" });
    expect(report.observations.find((o) => o.toolId === "agy")?.required).toBe(true);
    expect(report.observations.find((o) => o.toolId === "gitnexus")).toMatchObject({ required: true, status: "missing" });
    expect(report.plan?.steps.some((s) => s.componentId === "gitnexus")).toBe(true);
  });

  it("rejects malformed explicit config before any setup writes", async () => {
    const report = await service({ config: { ...defaultMachineConfig(), providers: ["unknown"] } as unknown as MachineConfig })
      .run({ mode: "apply", assumeYes: true });
    expect(report.outcome).toBe("blocked");
    expect(report.configStatus).toBe("invalid");
    await expect(readFile(path.join(root, ".bashrc"))).rejects.toThrow();
  });

  it("does not hide an invalid loaded file behind explicit config", async () => {
    await mkdir(platform.paths.config, { recursive: true });
    await writeFile(path.join(platform.paths.config, "machine.json"), "{ invalid");
    const report = await service({ config: defaultMachineConfig() }).run({ mode: "apply", assumeYes: true });
    expect(report.outcome).toBe("blocked");
    expect(report.configStatus).toBe("invalid");
    expect(await readFile(path.join(platform.paths.config, "machine.json"), "utf8")).toBe("{ invalid");
  });

  it("discovers managed installs, refreshes final observations and accepts an owned PATH block", async () => {
    const config = { ...defaultMachineConfig(), toolPins: [pin("gitnexus")] };
    const report = await service({ config, registry: registry() }).run({ mode: "apply", assumeYes: true });
    expect(report.receipts.find((r) => r.stepId === "install:gitnexus")?.status).toBe("applied");
    expect(report.observations.find((o) => o.toolId === "gitnexus")).toMatchObject({
      status: "path_missing", resolvedPath: path.join(platform.paths.data, "tools/gitnexus/node_modules/.bin/gitnexus")
    });
    expect(report.doctor?.healthy).toBe(true);
    expect(report.outcome).toBe("applied");
    expect(await readFile(path.join(root, ".bashrc"), "utf8")).toContain(path.join(platform.paths.data, "tools/gitnexus/node_modules/.bin"));
    const next = await service({ config }).run({ mode: "check" });
    expect(next.doctor?.healthy).toBe(true);
  });

  it("keeps a tool outside PATH unhealthy when no owned PATH block covers it", async () => {
    await executable(path.join(platform.paths.data, "tools/gitnexus/node_modules/.bin/gitnexus"));
    const report = await service({ config: { ...defaultMachineConfig(), toolPins: [pin("gitnexus")] } }).run({ mode: "check" });
    expect(report.doctor?.checks.find((c) => c.checkId === "tool-gitnexus")?.status).toBe("failed");
  });

  it("uses native integration observations for initial and post-install health", async () => {
    const config = { ...defaultMachineConfig(), toolPins: [pin("superpowers")] };
    const report = await service({ config, registry: registry(), additionalToolObservations: async (p, c) => {
      expect(c.toolPins[0]?.toolId).toBe("superpowers");
      const file = path.join(p.paths.data, "tools/superpowers/node_modules/.bin/superpowers");
      const present = await lstat(file).then(() => true, () => false);
      return [{ toolId: "superpowers", status: present ? "present" : "missing", resolvedPath: null,
        realPath: null, version: present ? "1.4.7" : null, binaryDigest: null, pathMissingDir: null,
        required: false, diagnostics: [] }];
    } }).run({ mode: "apply", assumeYes: true });
    expect(report.observations.find((o) => o.toolId === "superpowers")).toMatchObject({ status: "present", required: true });
    expect(report.doctor?.healthy).toBe(true);
    expect(report.outcome).toBe("applied");
  });

  it("reports a component planning failure while applying independent components", async () => {
    const report = await service({ components: (input) => [
      new PathComponent({ ...input, observations: [], env: {} }),
      { componentId: "role-skills", action: "resolve_skills", rollback: "none",
        observe: async () => ({ stateDigest: null, valid: true, diagnostics: [] }),
        desired: async () => { throw new Error("skill catalog unavailable"); },
        apply: async () => { throw new Error("cannot apply an unplanned component"); } }
    ] }).run({ mode: "apply", assumeYes: true });
    expect(report.receipts.find((r) => r.stepId === "configure:path")?.status).toBe("applied");
    expect(report.doctor?.healthy).toBe(false);
    expect(report.outcome).toBe("partially_applied");
    expect(report.diagnostics.join(" ")).toContain("skill catalog unavailable");
  });

  it("applies independent components even if a pinned install fails", async () => {
    const report = await service({ config: { ...defaultMachineConfig(), toolPins: [pin("gitnexus")] }, registry: registry(true) })
      .run({ mode: "apply", assumeYes: true });
    expect(report.receipts.find((r) => r.stepId === "install:gitnexus")?.status).toBe("failed");
    expect(report.receipts.find((r) => r.stepId === "configure:path")?.status).toBe("applied");
    expect(report.doctor?.healthy).toBe(false);
    expect(report.outcome).toBe("partially_applied");
    expect(await readFile(path.join(root, ".bashrc"), "utf8")).toContain(platform.paths.managedBin);
  });
});

describe("component composition owns persisted machine config", () => {
  it("retains config generated by a composed component and binds the manifest plan", async () => {
    const { loadMachineConfig } = await import("../src/index.js");
    const generated = { ...defaultMachineConfig(), skills: { catalogRef: "verified-generated-services" } };
    const configFile = path.join(platform.paths.config, "machine.json");
    const options: MachineSetupServiceOptions = {
      config: defaultMachineConfig(), persistMachineConfig: false,
      decorateComponents: (components, input) => components.map(component => component.componentId !== "mcp-config" ? component : {
        componentId: "mcp-config", action: "register_mcp", rollback: "restore_owned_config",
        desired: async () => ({ digest: digest(generated), summary: "Configure verified services", targets: [configFile], machineWide: true, repairNeeded: false }),
        observe: async () => {
          const loaded = await loadMachineConfig(configFile);
          return { valid: loaded.status === "valid", stateDigest: loaded.status === "valid" ? digest(loaded.config) : null, diagnostics: [] };
        },
        apply: async () => {
          const written = await input.store.writeFileAtomic(configFile, JSON.stringify(generated), 0o600);
          if (!written.ok) throw new Error(written.error.message);
          return { ownedPaths: [configFile], diagnostics: [] };
        }
      })
    };
    const report = await service(options).run({ mode: "apply", assumeYes: true });
    expect(report.outcome).toBe("applied");
    expect(JSON.parse(await readFile(configFile, "utf8"))).toEqual(generated);
    const manifest = JSON.parse(await readFile(path.join(platform.paths.state, "environment.json"), "utf8"));
    expect(manifest.lastPlan.planId).toBe(report.plan?.planId);
    expect((await service(options).run({ mode: "apply", assumeYes: true })).outcome).toBe("healthy");
  });
});
