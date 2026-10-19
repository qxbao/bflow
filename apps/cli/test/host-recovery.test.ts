import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureAgenticHost, type AgenticHostPlatformOptions } from "@bflow/runtime";
import { openLifecycleHost } from "../src/agentic-host.js";
import { EnvironmentLifecycle, identifyRepository, readEnvironmentConfig, runCli } from "../src/index.js";
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

  it("cleans up a preparation timeout with no pane receipt before any role dispatch", async () => {
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
    await expect(lifecycle.up(500)).rejects.toThrow(/timed out.*Automatic cleanup completed successfully/s);
    expect(prepareRoles).toHaveBeenCalledOnce();
    expect(up).not.toHaveBeenCalled();
    expect(quiesce).toHaveBeenCalledOnce();
    expect(runner.session(input.repository.sessionName).running).toBe(false);
    expect(JSON.parse(await readFile(join(input.repository.root, ".bflow/state/operation.json"), "utf8")).phase).toBe("down");
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
});
