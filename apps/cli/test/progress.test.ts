import { afterEach, describe, expect, it, vi } from "vitest";
import { CliProgress } from "../src/progress.js";
import { main } from "../src/bin.js";
import { formatSetupPreview, stripAnsi } from "../src/presentation.js";
import type { CliIo } from "../src/types.js";
import { SetupReceiptSchema, type SetupApplyRequest, type ToolInstaller } from "@bflow/contracts";
import { executeSetupCommand } from "../src/setup-integration.js";

afterEach(() => { vi.useRealTimers(); process.exitCode = 0; });

function collector(raw = true) {
  const lines: string[] = [], chunks: string[] = [];
  const io: CliIo = { stdout: line => lines.push(line), stderr: line => lines.push(line),
    progress: line => lines.push(line), ...(raw ? { stderrRaw: (chunk: string) => chunks.push(chunk) } : {}) };
  return { io, lines, chunks };
}

describe("interactive progress", () => {
  it("formats approval plans without losing targets, commands or manual approval flags", () => {
    const text = "Planned steps (1):\n- configure:path [approval, machine-wide] configure managed PATH\n    target: /home/user/.bashrc\n    command: installer --token=secret\nManual action required:\n- codex: Run codex login";
    const formatted = formatSetupPreview(text, true);
    expect(stripAnsi(formatted)).toContain("[1] Make bflow and installed tools available in the terminal [requires approval; this account]");
    expect(stripAnsi(formatted)).toContain("configure:path");
    expect(stripAnsi(formatted)).toContain("- /home/user/.bashrc");
    expect(stripAnsi(formatted)).toContain("Run codex login");
    expect(formatted).toContain("\x1b[2m");
    expect(formatted).not.toContain("token=secret");
    expect(formatSetupPreview(text)).not.toContain("\x1b");
  });
  it("numbers phases, keeps details transient and sanitized, animates and cleans up", () => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector();
    const progress = new CliProgress({ enabled: true, color: true, io });
    progress.step("Installing tools");
    progress.detail("Running installer\r\x1b[31m\npassword=secret");
    vi.advanceTimersByTime(250);
    expect(new Set(chunks).size).toBeGreaterThan(2);
    expect(lines).toHaveLength(1);
    expect(chunks.join("")).toContain("password=[REDACTED]");
    expect(lines.join("")).not.toContain("password=secret");
    progress.step("Checking tools");
    expect(lines.map(stripAnsi).filter(l => /^\[\d+\]/.test(l))).toEqual(["[1] Installing tools", "[2] Checking tools"]);
    progress.stop();
    expect(chunks.at(-1)).toBe("\r\x1b[2K");
    const count = chunks.length;
    vi.advanceTimersByTime(1000);
    progress.detail("too late");
    expect(chunks).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("deduplicates observations and retains failures while ordinary details stay mutable", () => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector();
    const progress = new CliProgress({ enabled: true, io });
    progress.step("Checking providers");
    progress.detail("Waiting for coordinator (pane-1)");
    const count = chunks.length;
    progress.detail("Waiting for coordinator (pane-1)");
    expect(chunks).toHaveLength(count);
    progress.detail("Waiting for verifier (pane-2)");
    progress.event("provider auth: failed");
    expect(lines.join("\n")).toContain("provider auth: failed");
    expect(lines.join("\n")).not.toContain("Waiting for");
    progress.stop();
  });

  it("counts inspected units without claiming success or estimating unknown work", () => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector();
    const progress = new CliProgress({ enabled: true, io, columns: () => 160 });
    progress.step("Checking backends");
    progress.units(0, 3, "Backends inspected");
    progress.units(1, 3, "Backends inspected");
    expect(stripAnsi(chunks.at(-1)!)).toContain("1/3 Backends inspected");
    expect(stripAnsi(chunks.at(-1)!)).toContain("[##----]");
    progress.important("backend-2: unavailable");
    progress.units(2, 3, "Backends inspected");
    progress.units(3, 3, "Backends inspected");
    expect(stripAnsi(chunks.at(-1)!)).toContain("3/3 Backends inspected");
    expect(stripAnsi(chunks.at(-1)!)).toContain("[######]");
    expect(chunks.join("")).not.toMatch(/100%|success|healthy/);
    expect(lines.join("\n")).toContain("backend-2: unavailable");
    const count = chunks.length;
    progress.units(4, 3, "invalid"); progress.units(0, 0, "invalid");
    expect(chunks).toHaveLength(count);
    progress.step("Waiting for provider authentication");
    vi.advanceTimersByTime(200);
    expect(stripAnsi(chunks.at(-1)!)).not.toMatch(/\d+\/\d+|%/);
    progress.stop();
  });

  it("never emits animation or cursor control to line collectors or disabled outputs", () => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector(false);
    const progress = new CliProgress({ enabled: true, io });
    progress.step("Loading"); progress.detail("Observed result"); progress.stop();
    expect(lines.join("\n")).not.toContain("\x1b");
    expect(chunks).toEqual([]);
    const disabled = new CliProgress({ enabled: false, io: collector().io });
    disabled.step("hidden"); disabled.detail("hidden"); disabled.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps free-form fractions indeterminate and safe across animation ticks", () => {
    vi.useFakeTimers();
    const { io, chunks } = collector();
    const progress = new CliProgress({ enabled: true, io, columns: () => 160 });
    progress.step("Checking tools");
    for (const detail of ["1/0 optional checks", "8/3 optional checks", "1/3 diagnostic text"]) {
      expect(() => progress.detail(detail)).not.toThrow();
      expect(() => vi.advanceTimersByTime(200)).not.toThrow();
      expect(chunks.at(-1)).toContain("Working");
      expect(chunks.at(-1)).not.toContain("#");
    }
    progress.units(1, 3, "Tools inspected");
    expect(chunks.at(-1)).toContain("[##----]");
    progress.detail("1/3 Tools inspected");
    expect(chunks.at(-1)).toContain("Working");
    progress.units(1, 3, "Tools inspected");
    expect(chunks.at(-1)).toContain("[##----]");
    progress.stop();
  });

  it("retains validated counts when updates are deferred behind a confirmation", async () => {
    vi.useFakeTimers();
    const { io, chunks } = collector();
    const progress = new CliProgress({ enabled: true, io });
    await progress.confirmation(async () => { progress.units(2, 3, "Tools inspected"); });
    expect(chunks.at(-1)).toContain("[####--]");
    progress.stop();
  });

  it("suspends redraws while a confirmation is pending, then resumes on the next step", async () => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector();
    const progress = new CliProgress({ enabled: true, io });
    progress.step("Planning");
    let approve!: (value: boolean) => void;
    const pending = progress.confirmation(() => new Promise<boolean>(resolve => { approve = resolve; }));
    const count = chunks.length;
    vi.advanceTimersByTime(2000);
    expect(chunks).toHaveLength(count);
    expect(lines.join("\n")).toContain("[2] Waiting for your confirmation");
    expect(lines.join("\n")).not.toContain("setup plan");
    approve(false);
    expect(await pending).toBe(false);
    progress.step("Reporting declined setup");
    vi.advanceTimersByTime(100);
    expect(chunks.length).toBeGreaterThan(count);
    progress.stop();
  });

  it("defers late observations until the operator finishes typing", async () => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector();
    const progress = new CliProgress({ enabled: true, io });
    progress.step("Planning");
    let approve!: (value: boolean) => void;
    const pending = progress.confirmation(() => new Promise<boolean>(resolve => { approve = resolve; }));
    const lineCount = lines.length, chunkCount = chunks.length;
    progress.detail("A late process observation");
    progress.event("late check: checking");
    progress.event("late check: complete");
    vi.advanceTimersByTime(1000);
    expect(lines).toHaveLength(lineCount);
    expect(chunks).toHaveLength(chunkCount);
    approve(false);
    expect(await pending).toBe(false);
    expect(chunks.join("")).toContain("A late process observation");
    expect(lines.join("\n")).toContain("[3] late check");
    expect(vi.getTimerCount()).toBe(0);
    progress.stop();
  });

  it("restarts the skeleton when the same step runs again", () => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector();
    const progress = new CliProgress({ enabled: true, io });
    progress.event("probe: checking");
    progress.event("probe: complete");
    expect(vi.getTimerCount()).toBe(0);
    progress.event("probe: checking");
    expect(lines.filter(line => /^\[\d+\]/.test(line))).toEqual(["[1] probe", "[2] probe"]);
    const count = chunks.length;
    vi.advanceTimersByTime(200);
    expect(chunks.length).toBeGreaterThan(count);
    progress.stop();
  });

  it("bounds buffered observations during a long confirmation", async () => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector();
    const progress = new CliProgress({ enabled: true, io });
    await progress.confirmation(async () => {
      for (let index = 0; index < 75; index++) progress.detail(`Observation ${index}: token=secret`);
      expect(lines).toHaveLength(1);
      return true;
    });
    expect(chunks.join("")).toContain("25 progress updates omitted while awaiting input");
    expect(lines.filter(line => line.includes("Observation"))).toHaveLength(0);
    expect(chunks.join("")).toContain("Observation 74");
    expect(lines.join("\n")).not.toContain("token=secret");
    progress.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves important failures when ordinary observations overflow during a prompt", async () => {
    const { io, lines } = collector();
    const progress = new CliProgress({ enabled: true, io });
    await progress.confirmation(async () => {
      progress.important("Required authentication check failed");
      for (let index = 0; index < 75; index++) progress.detail(`Observation ${index}`);
      return false;
    });
    progress.stop();
    expect(lines.join("\n")).toContain("Required authentication check failed");
  });

  it("discards deferred updates when stopped during a confirmation", async () => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector();
    const progress = new CliProgress({ enabled: true, io });
    await progress.confirmation(async () => {
      progress.detail("Late update");
      progress.stop();
      return false;
    });
    expect(lines.join("\n")).not.toContain("Late update");
    expect(chunks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves the receiver of I/O methods", () => {
    vi.useFakeTimers();
    const io = new StatefulIo();
    const progress = new CliProgress({ enabled: true, io });
    progress.step("Inspecting");
    expect(io.progressLines.join("\n")).toContain("[1] Inspecting");
    expect(io.rawChunks.length).toBeGreaterThan(0);
    progress.stop();
  });

  it("bounds mutable lines to terminal width and keeps completion on the same step", () => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector();
    const progress = new CliProgress({ enabled: true, io, columns: () => 24 });
    progress.event("probe tools: checking");
    progress.detail("A very long detail message with emoji 🛠️ and Vietnamese nội dung");
    expect(stripAnsi(chunks.at(-1)!).length).toBeLessThan(24);
    progress.event("probe tools: complete");
    expect(lines.filter(line => /^\[\d+\]/.test(line))).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    progress.stop();
  });

  it("cannot fail a command when a progress writer throws", () => {
    vi.useFakeTimers();
    const fail = () => { throw new Error("broken writer"); };
    const progress = new CliProgress({ enabled: true, io: { stdout: fail, stderr: fail, stderrRaw: fail } });
    expect(() => { progress.step("Step"); progress.detail("Detail"); progress.stop(); }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});

class StatefulIo implements CliIo {
  readonly out: string[] = [];
  readonly errors: string[] = [];
  readonly progressLines: string[] = [];
  readonly rawChunks: string[] = [];
  stdout(message: string): void { this.out.push(message); }
  stderr(message: string): void { this.errors.push(message); }
  progress(message: string): void { this.progressLines.push(message); }
  stderrRaw(chunk: string): void { this.rawChunks.push(chunk); }
}

describe("setup installer progress boundaries", () => {
  it.each([false, true])("reports checking exactly when reconciliation starts (timeout=%s)", async timedOut => {
    const { cp, mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { basename, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const { detectPlatform, defaultHostEnvironment, defaultMachineConfig, ToolInstallerRegistry } = await import("@bflow/machine-setup");
    const root = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "bflow-install-progress-")));
    const bin = join(root, "bin");
    const steps: string[] = [], observations: (string | undefined)[] = [];
    let installed = false, applications = 0;
    const receipt = (request: SetupApplyRequest) => SetupReceiptSchema.parse({
      schemaVersion: 3, receiptId: "fixture-receipt", planId: request.planId, planDigest: request.planDigest,
      stepId: request.step.stepId, scope: request.step.scope, status: installed ? "applied" : "failed",
      desiredStateDigest: request.step.desiredStateDigest,
      observedStateDigest: installed ? request.step.desiredStateDigest : null,
      ownedPaths: [], observedAt: new Date().toISOString(), diagnostics: [], idempotencyKey: request.step.idempotencyKey
    });
    const installer: ToolInstaller = {
      installerId: "fixture",
      plan: async request => ({ ok: true, value: {
        schemaVersion: 3, stepId: "install:gitnexus", action: "install_tool", componentId: request.toolId,
        level: "machine", scope: request.scope, dependsOn: [], desiredStateDigest: "b".repeat(64),
        expectedStateDigest: null, requiresApproval: true, rollback: "none", toolInstall: request, idempotencyKey: request.idempotencyKey
      } }),
      apply: async request => {
        applications++;
        if (timedOut) return { ok: false, error: { code: "timeout", message: "Fixture timeout", retryable: true, retrySafety: "observation_only" } };
        installed = true;
        return { ok: true, value: receipt(request) };
      },
      reconcile: async request => {
        observations.push(steps.at(-1));
        return { ok: true, value: receipt(request) };
      }
    };
    const registry = new ToolInstallerRegistry(); registry.register(installer);
    try {
      await mkdir(bin);
      // Exercise real skill setup without coupling installer phase timing to the full catalog size.
      // setup-outcomes.test.ts retains the bundled-catalog integration coverage.
      const catalogDir = join(root, "catalog");
      await mkdir(join(catalogDir, "roles"), { recursive: true });
      await cp(fileURLToPath(new URL("../../../skills/core/using-bflow", import.meta.url)), join(catalogDir, "core", "using-bflow"), { recursive: true });
      await writeFile(join(catalogDir, "roles", "bindings.json"), JSON.stringify({ schemaVersion: 3, bindings: { conversation: ["using-bflow"] } }));
      for (const name of ["node", "git", "pnpm", "herdr"]) await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const platform = detectPlatform({ ...defaultHostEnvironment(), platform: "linux", homeDir: root,
        env: { HOME: root, PATH: bin, SHELL: "/bin/bash", XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") } });
      const versions: Record<string, string> = { node: "v22.13.0", git: "git version 2.45.0", pnpm: "12.5.1", herdr: "herdr 0.9.5" };
      await executeSetupCommand({ command: "setup", mode: "apply", yes: true, json: false, help: false }, { cwd: root, setup: {
        platform, toolInstaller: registry, catalogDir,
        machineConfig: { ...defaultMachineConfig(), toolPins: [{ schemaVersion: 3, toolId: "gitnexus", installerId: "fixture", method: "npm", version: "1.4.7",
          source: "https://example.com/tool.tgz", integrity: "a".repeat(64), platforms: ["linux"], requiresElevation: false }] },
        runner: { run: async argv => ({ exitCode: 0, timedOut: false, stderr: "", stdout: versions[basename(argv[0]!)] ?? "" }) }
      } }, step => steps.push(step));
      expect(applications).toBe(1);
      expect(observations).toHaveLength(timedOut ? 1 : 2);
      expect(observations.every(step => step === "Checking installation of gitnexus...")).toBe(true);
      expect(steps.filter(step => step === "Checking installation of gitnexus...")).toHaveLength(observations.length);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("entrypoint progress forwarding", () => {
  it.each([false, true])("forwards stateful I/O methods (dedicated progress=%s)", async dedicated => {
    const io = new StatefulIo();
    if (!dedicated) Object.defineProperty(io, "progress", { value: undefined });
    const result = await main(["status", "run-1"], { io,
      runtime: { getRun: async () => ({ ok: false, error: { code: "not_found", message: "run missing", retryable: false } }) } as any,
      presentation: { interactive: true } });
    expect(result.ok).toBe(false);
    expect((dedicated ? io.progressLines : io.errors).join("\n")).toContain("[1] Executing status command");
    expect(io.rawChunks.length).toBeGreaterThan(0);
    expect(io.errors.filter(line => line.includes("Error ["))).toHaveLength(1);
  });

  it("connects setup process details and its real confirmation boundary to the renderer", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { detectPlatform, defaultHostEnvironment, defaultMachineConfig, ToolInstallerRegistry } = await import("@bflow/machine-setup");
    const root = await (await import("node:fs/promises")).realpath(await mkdtemp(join(tmpdir(), "bflow-progress-")));
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const name of ["node", "git", "pnpm", "herdr"]) await writeFile(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const platform = detectPlatform({ ...defaultHostEnvironment(), homeDir: root,
      env: { PATH: bin, SHELL: "/bin/bash", XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state") } });
    const { io, lines, chunks } = collector();
    let confirmations = 0;
    try {
      const result = await main(["setup"], { cwd: root, io, presentation: { interactive: true, stderrColor: true }, setup: {
        platform, machineConfig: defaultMachineConfig(), toolInstaller: new ToolInstallerRegistry(),
        runner: { run: async () => ({ exitCode: 0, timedOut: false, stderr: "", stdout: "secret account diagnostic" }) },
        confirm: async preview => {
          confirmations++;
          expect(lines.join("\n")).toContain("Waiting for your confirmation");
          expect(chunks.at(-1)).toBe("\r\x1b[2K");
          expect(preview).toContain("[1]");
          return false;
        }
      } });
      expect(confirmations).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(chunks.join("")).toMatch(/Running (node|git|pnpm|herdr)/);
      expect(lines.join("\n")).not.toMatch(/exit 0 \(\d+\.\ds\)/);
      expect(lines.slice(0, -1).join("\n")).not.toContain("secret account diagnostic");
      expect(lines.join("\n")).not.toContain("[..]");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("forwards progress before completion and cleans up on failure (throw=%s)", async throws => {
    vi.useFakeTimers();
    const { io, lines, chunks } = collector();
    const operation = vi.fn(async () => {
      expect(lines.join("\n")).toContain("[1] Executing status command");
      vi.advanceTimersByTime(200);
      if (throws) throw new Error("runtime failed");
      return { ok: false as const, error: { code: "not_found" as const, message: "run missing", retryable: false } };
    });
    const result = await main(["status", "run-1"], { io, runtime: { getRun: operation } as any,
      presentation: { interactive: true, stderrColor: true } });
    expect(result.ok).toBe(false);
    expect(lines.at(-1)).toContain("Error [");
    const count = chunks.length;
    vi.advanceTimersByTime(1000);
    expect(chunks).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps JSON entirely free of progress even with an interactive raw writer", async () => {
    const { io, lines, chunks } = collector();
    const result = await main(["status", "run-1", "--json"], { io,
      runtime: { getRun: async () => ({ ok: false, error: { code: "not_found", message: "run missing", retryable: false } }) } as any,
      presentation: { interactive: true, stderrColor: true } });
    expect(result.exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).ok).toBe(false);
    expect(chunks).toEqual([]);
  });
});
