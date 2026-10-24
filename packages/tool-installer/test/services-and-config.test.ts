import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServiceDefinition, MCPServiceObservation, ScopedOperation, MCPToolCallResult, MCPResourceLease } from "@bflow/contracts";
import type { ToolHost } from "../src/installer.js";
import { FileToolCapabilityRegistry, projectVerifiedServiceCapability } from "../src/integrations.js";
import { planRtkConfiguration, applyRtkConfiguration } from "../src/rtk-config.js";
import {
  createGitNexusService,
  createChromeService,
  ensureGatewayTool,
  BrowserPageSession
} from "../src/services.js";

// Keep RTK's real global-hook checks inside a disposable provider profile. This
// suite already injects the tool process; reading the operator's home is not part
// of its contract and made the idempotence test depend on personal hook layout.
const profile = vi.hoisted(() => ({ homeDirectory: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => {
      if (!profile.homeDirectory) throw new Error("RTK test profile was not initialized");
      return profile.homeDirectory;
    }
  };
});

const hash = (data: string) => createHash("sha256").update(data).digest("hex");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("rtk configuration planner and applicator", () => {
  beforeEach(async () => {
    profile.homeDirectory = await mkdtemp(join(tmpdir(), "bflow-rtk-profile-"));
    roots.push(profile.homeDirectory);
  });
  afterEach(() => { profile.homeDirectory = ""; });
  it("excludes --no-patch for codex provider but includes it for claude and agy", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-rtk-plan-"));
    roots.push(root);
    const repo = join(root, "repo");
    const state = join(root, "state");
    await mkdir(repo, { recursive: true });
    await mkdir(state, { recursive: true });
    const executable = join(root, "rtk");
    await writeFile(executable, "binary", { mode: 0o755 });

    const host: ToolHost = {
      async download() {},
      async run(_exe, args) {
        if (args.includes("--help")) {
          return { exitCode: 0, stdout: "--codex --agent antigravity --no-patch --no-trust-filters --dry-run", stderr: "" };
        }
        if (args.includes("--dry-run")) {
          return { exitCode: 0, stdout: "preview ok", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };

    const codexPlan = await planRtkConfiguration({ provider: "codex", executable, repositoryRoot: repo, stateRoot: state, host });
    expect(codexPlan.argv).toContain("--codex");
    expect(codexPlan.argv).not.toContain("--no-patch");
    expect(codexPlan.argv).toContain("--no-trust-filters");

    const claudePlan = await planRtkConfiguration({ provider: "claude", executable, repositoryRoot: repo, stateRoot: state, host });
    expect(claudePlan.argv).not.toContain("--codex");
    expect(claudePlan.argv).toContain("--no-patch");
    expect(claudePlan.argv).toContain("--no-trust-filters");

    const agyPlan = await planRtkConfiguration({ provider: "agy", executable, repositoryRoot: repo, stateRoot: state, host });
    expect(agyPlan.argv).toContain("--agent");
    expect(agyPlan.argv).toContain("antigravity");
    expect(agyPlan.argv).toContain("--no-patch");
  });

  it("applies RTK configuration idempotently and reports already_satisfied on repeat", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-rtk-apply-"));
    roots.push(root);
    const repo = join(root, "repo");
    const state = join(root, "state");
    await mkdir(repo, { recursive: true });
    await mkdir(state, { recursive: true });
    const executable = join(root, "rtk");
    await writeFile(executable, "binary", { mode: 0o755 });

    const host: ToolHost = {
      async download() {},
      async run(_exe, args) {
        if (args.includes("--help")) {
          return { exitCode: 0, stdout: "--codex --dry-run --no-trust-filters", stderr: "" };
        }
        if (args.includes("--dry-run")) {
          return { exitCode: 0, stdout: "preview ok", stderr: "" };
        }
        // When actually run, write the file
        await writeFile(join(repo, "RTK.md"), "# RTK instructions\n");
        return { exitCode: 0, stdout: "initialized", stderr: "" };
      }
    };

    const plan = await planRtkConfiguration({ provider: "codex", executable, repositoryRoot: repo, stateRoot: state, host });
    const first = await applyRtkConfiguration(plan, host);
    expect(first.status).toBe("applied");

    const second = await applyRtkConfiguration(plan, host);
    expect(second.status).toBe("already_satisfied");
  });

  it("rejects a symlinked global hooks file before invoking RTK and preserves its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-rtk-link-"));
    roots.push(root);
    const repo = join(root, "repo"), state = join(root, "state"), executable = join(root, "rtk");
    await mkdir(repo); await mkdir(state);
    await writeFile(executable, "binary", { mode: 0o755 });
    const hookDirectory = join(profile.homeDirectory, ".codex");
    await mkdir(hookDirectory);
    const target = join(profile.homeDirectory, "original-hooks.json");
    const content = JSON.stringify({ hooks: {} });
    await writeFile(target, content);
    const hookPath = join(hookDirectory, "hooks.json");
    await symlink(target, hookPath);
    let initCalls = 0;
    const host: ToolHost = {
      async download() {},
      async run(_executable, args) {
        if (args.includes("--help")) return { exitCode: 0, stdout: "--codex --dry-run", stderr: "" };
        if (args.includes("--dry-run")) return { exitCode: 0, stdout: "preview", stderr: "" };
        initCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    const plan = await planRtkConfiguration({ provider: "codex", executable, repositoryRoot: repo, stateRoot: state, host });
    await expect(applyRtkConfiguration(plan, host)).rejects.toThrow("Not a bounded regular file");
    expect(initCalls).toBe(0);
    expect(await readdir(repo)).toEqual([]);
    expect((await lstat(hookPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe(content);
  });

  it("rejects duplicate global and repository RTK hooks inside the isolated profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-rtk-duplicate-"));
    roots.push(root);
    const repo = join(root, "repo"), state = join(root, "state"), executable = join(root, "rtk");
    await mkdir(repo); await mkdir(state);
    await writeFile(executable, "binary", { mode: 0o755 });
    const content = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "rtk hook" }] }] } });
    const globalDirectory = join(profile.homeDirectory, ".codex"), localDirectory = join(repo, ".codex");
    await mkdir(globalDirectory); await mkdir(localDirectory);
    await writeFile(join(globalDirectory, "hooks.json"), content);
    await writeFile(join(localDirectory, "hooks.json"), content);
    let initCalls = 0;
    const host: ToolHost = {
      async download() {},
      async run(_executable, args) {
        if (args.includes("--help")) return { exitCode: 0, stdout: "--codex --dry-run", stderr: "" };
        if (args.includes("--dry-run")) return { exitCode: 0, stdout: "preview", stderr: "" };
        initCalls++;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    };
    const plan = await planRtkConfiguration({ provider: "codex", executable, repositoryRoot: repo, stateRoot: state, host });
    await expect(applyRtkConfiguration(plan, host)).rejects.toThrow("already hooked globally and locally");
    expect(initCalls).toBe(0);
    expect(await readFile(join(globalDirectory, "hooks.json"), "utf8")).toBe(content);
    expect(await readFile(join(localDirectory, "hooks.json"), "utf8")).toBe(content);
  });

});

describe("mcp services integration", () => {
  it("projects only the exact ready service operations from a matching Gateway observation", () => {
    const service: MCPServiceDefinition = {
      schemaVersion: 3, serviceId: "gitnexus-r1", revision: 2,
      scope: { kind: "repository", machineId: "m1", repositoryId: "r1", workspaceRoot: "/repo" },
      tool: { schemaVersion: 3, toolId: "gitnexus", kind: "stdio_mcp", version: "1.6.12",
        operations: ["query", "context", "impact"], required: true,
        resource: { sharing: "exclusive", resourceKey: "gitnexus-r1" } },
      connection: { kind: "stdio_mcp", executable: "/opt/bflow/gitnexus", argv: ["mcp"], environmentBindings: {},
        executableDigest: hash("exe"), ownership: "bflow", bridgeRequired: true },
      authentication: { mode: "none" }, healthTimeoutMs: 15000, idleTimeoutMs: 60000, restartLimit: 2
    };
    const observation: MCPServiceObservation = { schemaVersion: 3, serviceId: service.serviceId, revision: service.revision,
      instanceId: "gitnexus-instance", status: "ready", protocolVersion: "2025-11-25",
      discoveredTools: ["query", "context", "impact", "unapproved_extra"], ownership: "bflow", activeClientCount: 0,
      observedAt: new Date().toISOString(), diagnosticCode: "ready" };
    expect(projectVerifiedServiceCapability({ service, observation })).toMatchObject({ status: "ready", toolId: "gitnexus",
      serviceId: service.serviceId, operations: ["query", "context", "impact"] });
    expect(projectVerifiedServiceCapability({ service, observation: { ...observation, revision: 1 } }).status).toBe("blocked");
    expect(projectVerifiedServiceCapability({ service, observation: { ...observation, discoveredTools: ["query", "context"] } }).status).toBe("blocked");
  });

  it("creates valid GitNexus service definition with isolation and exclusive lease key", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-nexus-svc-"));
    roots.push(root);
    const repo = join(root, "repo");
    const state = join(root, "state");
    const config = join(root, "config");
    await mkdir(repo, { recursive: true });
    await mkdir(state, { recursive: true });
    await mkdir(config, { recursive: true });
    const executable = join(root, "gitnexus");
    await writeFile(executable, "binary", { mode: 0o755 });

    const operation: ScopedOperation = {
      schemaVersion: 3,
      scope: { kind: "repository", machineId: "m1", repositoryId: "repo-1", workspaceRoot: repo },
      idempotencyKey: "op-1"
    };

    const service = await createGitNexusService({
      executable,
      version: "1.6.12",
      repositoryRoot: repo,
      stateRoot: state,
      configRoot: config,
      operation
    });

    expect(service.schemaVersion).toBe(3);
    expect(service.tool.toolId).toBe("gitnexus");
    expect(service.tool.resource.sharing).toBe("exclusive");
    expect(service.connection.kind).toBe("stdio_mcp");
    expect(service.connection.ownership).toBe("bflow");
    expect(service.connection.bridgeRequired).toBe(true);
  });

  it("creates Chrome DevTools service definition with task profile ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-chrome-svc-"));
    roots.push(root);
    const managed = join(root, "managed");
    const config = join(root, "config");
    await mkdir(managed, { recursive: true });
    await mkdir(config, { recursive: true });
    const browserExe = join(root, "chrome");
    const serverExe = join(root, "chrome-devtools-mcp");
    await writeFile(browserExe, "#!/bin/sh\necho \"Google Chrome 150\"\n", { mode: 0o755 });
    await writeFile(serverExe, "#!/bin/sh\necho \"server 1.11.0\"\n", { mode: 0o755 });

    const operation: ScopedOperation = {
      schemaVersion: 3,
      scope: { kind: "repository", machineId: "m1", repositoryId: "repo-1", workspaceRoot: root },
      idempotencyKey: "op-chrome"
    };

    const service = await createChromeService({
      managedRoot: managed,
      repositoryId: "repo-1",
      taskId: "task-101",
      browserExecutable: browserExe,
      serverExecutable: serverExe,
      version: "1.11.0",
      configRoot: config,
      operation
    });

    expect(service.tool.toolId).toBe("chrome-devtools-mcp");
    expect(service.tool.resource.sharing).toBe("exclusive");
    const spec = JSON.parse(await (await import("node:fs/promises")).readFile(service.connection.argv[1]!, "utf8"));
    expect(spec.argv).toContain("--headless");
    expect(spec.argv).toContain("--no-usage-statistics");
  });

  it("ensures Gateway tool only publishes capability when verified and ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-gw-ensure-"));
    roots.push(root);
    const registryFile = join(root, "capabilities.json");
    const registry = new FileToolCapabilityRegistry(registryFile);

    const service: MCPServiceDefinition = {
      schemaVersion: 3,
      serviceId: "svc-1",
      revision: 1,
      scope: { kind: "repository", machineId: "m1", repositoryId: "r1", workspaceRoot: root },
      tool: {
        schemaVersion: 3,
        toolId: "gitnexus",
        kind: "stdio_mcp",
        version: "1.0.0",
        operations: ["query", "context"],
        required: false,
        resource: { sharing: "exclusive", resourceKey: "res-1" }
      },
      connection: {
        kind: "stdio_mcp",
        executable: process.execPath,
        executableDigest: hash("node"),
        argv: ["launcher.js"],
        environmentBindings: {},
        ownership: "bflow",
        bridgeRequired: true
      },
      authentication: { mode: "none" },
      healthTimeoutMs: 15_000,
      idleTimeoutMs: 60_000,
      restartLimit: 2
    };

    const operation: ScopedOperation = {
      schemaVersion: 3,
      scope: { kind: "repository", machineId: "m1", repositoryId: "r1", workspaceRoot: root },
      idempotencyKey: "op-1"
    };

    // Case 1: Manager returns not ready or missing required tools
    const failingManager = {
      async ensure() {
        return {
          ok: true as const,
          value: {
            schemaVersion: 3 as const,
            serviceId: "svc-1",
            revision: 1,
            instanceId: "inst-1",
            status: "starting" as const,
            ownership: "bflow" as const,
            activeClientCount: 0,
            discoveredTools: ["query"],
            diagnosticCode: "starting",
            observedAt: new Date().toISOString()
          }
        };
      }
    };

    await expect(ensureGatewayTool({
      manager: failingManager,
      service,
      operation,
      registry,
      scopeKey: "r1",
      requiredTools: ["query", "context"]
    })).rejects.toThrow("Gateway has not verified");

    expect((await registry.list("r1")).find(c => c.toolId === "gitnexus")).toBeUndefined();

    // Case 2: Manager returns fully ready with all required tools
    const successManager = {
      async ensure() {
        return {
          ok: true as const,
          value: {
            schemaVersion: 3 as const,
            serviceId: "svc-1",
            revision: 1,
            instanceId: "inst-1",
            status: "ready" as const,
            protocolVersion: "2025-11-25",
            ownership: "bflow" as const,
            activeClientCount: 0,
            discoveredTools: ["query", "context"],
            diagnosticCode: "ready",
            observedAt: new Date().toISOString()
          }
        };
      }
    };

    const result = await ensureGatewayTool({
      manager: successManager,
      service,
      operation,
      registry,
      scopeKey: "r1",
      requiredTools: ["query", "context"]
    });

    expect(result.ok).toBe(true);
    const cap = (await registry.list("r1")).find(c => c.toolId === "gitnexus");
    expect(cap).toBeDefined();
    expect(cap?.version).toBe("1.0.0");
  });

  it("manages exclusive browser page session lifecycle and leases", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-browser-session-"));
    roots.push(root);
    const stateFile = join(root, "session-state.json");
    const specFile = join(root, "spec.json");

    const spec = {
      schemaVersion: 3 as const,
      executable: process.execPath,
      executableDigest: hash(await (await import("node:fs/promises")).readFile(process.execPath)),
      argv: ["chrome"],
      cwd: root,
      environment: {},
      browserOwner: { taskId: "task-1", repositoryId: "repo-1", profileDir: root }
    };
    await writeFile(specFile, JSON.stringify(spec));
    const specDigest = hash(JSON.stringify(spec));

    const service: MCPServiceDefinition = {
      schemaVersion: 3,
      serviceId: "chrome-svc",
      revision: 1,
      scope: { kind: "repository", machineId: "m1", repositoryId: "repo-1", workspaceRoot: root },
      tool: {
        schemaVersion: 3,
        toolId: "chrome-devtools-mcp",
        kind: "stdio_mcp",
        version: "1.11.0",
        operations: ["new_page", "list_pages"],
        required: false,
        resource: { sharing: "exclusive", resourceKey: "chrome-res-key" }
      },
      connection: {
        kind: "stdio_mcp",
        executable: process.execPath,
        executableDigest: hash("node"),
        argv: ["service-launcher.js", specFile, specDigest],
        environmentBindings: {},
        ownership: "bflow",
        bridgeRequired: true
      },
      authentication: { mode: "none" },
      healthTimeoutMs: 15_000,
      idleTimeoutMs: 60_000,
      restartLimit: 2
    };

    const operation: ScopedOperation = {
      schemaVersion: 3,
      scope: { kind: "repository", machineId: "m1", repositoryId: "repo-1", workspaceRoot: root },
      idempotencyKey: "op-browser"
    };

    const mockLease: MCPResourceLease = {
      schemaVersion: 3,
      leaseId: "lease-100",
      registrationId: "reg-1",
      serviceId: "chrome-svc",
      resourceKey: "chrome-res-key",
      fencingToken: 1,
      acquiredAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    };

    let acquired = false;
    let released = false;
    const mockGateway = {
      async acquireResource() {
        acquired = true;
        return { ok: true as const, value: mockLease };
      },
      async call(callReq: any) {
        return {
          ok: true as const,
          value: {
            schemaVersion: 3 as const,
            callId: callReq.callId,
            status: "completed" as const,
            output: { content: [{ type: "text", text: "page created" }] },
            observedAt: new Date().toISOString()
          }
        };
      },
      async reconcileCall() {
        return {
          ok: true as const,
          value: {
            schemaVersion: 3 as const,
            callId: "c",
            status: "completed" as const,
            output: {},
            observedAt: new Date().toISOString()
          }
        };
      },
      async renewResource() {
        return { ok: true as const, value: { ...mockLease, expiresAt: new Date(Date.now() + 120_000).toISOString() } };
      },
      async releaseResource() {
        released = true;
        return { ok: true as const, value: undefined };
      }
    };

    const session = new BrowserPageSession({
      gateway: mockGateway as any,
      service,
      operation,
      registrationId: "reg-1",
      taskId: "task-1",
      stateFile
    });

    // Rejects if taskId doesn't match
    await expect(session.acquire("task-other")).rejects.toThrow("Browser profile is owned by another task");

    // Successful acquire
    await session.acquire("task-1");
    expect(acquired).toBe(true);

    // Call tool
    const callResult = await session.call("task-1", "new_page", { url: "about:blank" });
    expect(callResult.status).toBe("completed");

    // Renew lease
    await session.renew();

    // Release
    await session.release();
    expect(released).toBe(true);
  });
});
