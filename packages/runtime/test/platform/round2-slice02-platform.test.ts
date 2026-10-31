import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  MCPClientRegistration,
  MCPServiceObservation,
  OperationOptions,
  OperationResult,
  ScopedOperation,
  TrustScope
} from "@bflow/contracts";
import { createFakeProviderRunner } from "@bflow/agent-providers";
import { SkillFileStore, SkillManager, bundleDigest, type BundleFiles } from "@bflow/skills";
import { Ed25519LaunchAttestationSigner } from "../../src/platform/attestation-signer.js";
import { createProviderAdapterFactory, createSkillResolver } from "../../src/platform/defaults.js";
import { RoleEnvironmentResolver } from "../../src/platform/environment.js";
import { ok } from "../../src/platform/errors.js";
import { GatewayControlClient } from "../../src/platform/gateway-control-client.js";
import { GatewayRegistrationManager } from "../../src/platform/gateway-registrations.js";
import { FileLaunchJournal, LaunchJournalCorruptionError } from "../../src/platform/launch-journal.js";
import type {
  GatewayControlPort,
  GatewayRegistrationGrant,
  PlatformSessionIdentity,
  RolePlatformRequirement
} from "../../src/platform/ports.js";
import { ProviderReadiness } from "../../src/platform/provider-readiness.js";
import { persistRoleProfileSnapshot } from "../../src/platform/role-profiles.js";
import { DefaultPlatformReadinessService } from "../../src/platform/service.js";
import { SkillSessionStore } from "../../src/platform/skills-session.js";
import { FileToolUsageLedger } from "../../src/platform/tool-usage-ledger.js";
import { profile as specialistProfile } from "./role-profile-fixture.js";

const ENDPOINT = "http://127.0.0.1:7777/mcp";
const originalOpen = fsPromises.open;
const originalEnvPath = process.env["PATH"];

class FakeGatewayControl implements GatewayControlPort {
  readonly registrations = new Map<string, { registration: MCPClientRegistration; bearerToken: string }>();
  services: MCPServiceObservation[] = [
    {
      schemaVersion: 3,
      serviceId: "svc-search",
      revision: 1,
      instanceId: "svc-search-1",
      status: "ready",
      protocolVersion: "2025-06-18",
      discoveredTools: ["search", "read"],
      ownership: "bflow",
      activeClientCount: 0,
      observedAt: "2026-10-31T00:00:00.000Z",
      diagnosticCode: "ok"
    }
  ];

  async register(
    registration: MCPClientRegistration,
    _options?: OperationOptions
  ): Promise<OperationResult<GatewayRegistrationGrant>> {
    const bearerToken = randomBytes(32).toString("hex");
    this.registrations.set(registration.registrationId, { registration, bearerToken });
    return ok({ registration, bearerToken });
  }

  async revoke(registrationId: string, _operation: ScopedOperation): Promise<OperationResult<void>> {
    this.registrations.delete(registrationId);
    return ok(undefined);
  }

  async list(scope: TrustScope): Promise<OperationResult<readonly MCPClientRegistration[]>> {
    return ok(
      [...this.registrations.values()]
        .map(entry => entry.registration)
        .filter(registration => JSON.stringify(registration.scope) === JSON.stringify(scope))
    );
  }

  async inspectServices(): Promise<OperationResult<readonly MCPServiceObservation[]>> {
    return ok(this.services);
  }
}

const skillBody = (name: string) =>
  `---\nname: ${name}\ndescription: Inspect an assigned task before implementation.\n---\n\n${[
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
  ]
    .map(h => `## ${h}\n\nUse the accepted task and preserve Runtime authority.`)
    .join("\n\n")}\n`;

const skillFiles = (name: string): BundleFiles => ({
  "SKILL.md": skillBody(name),
  "skill.json": JSON.stringify({
    version: "1.0.0",
    allowedRoles: ["developer"],
    supportedProviders: ["claude", "codex", "agy"],
    requiredCapabilityIds: [],
    requiredToolIds: [],
    dependencies: []
  })
});

describe("Round 2 Slice 2 — platform readiness & EISDIR hardening", () => {
  let baseDir: string;
  let workspace: string;
  let stateDirectory: string;
  let identity: PlatformSessionIdentity;
  let gatewayControl: FakeGatewayControl;
  let skillManager: SkillManager;
  let skillPin: { skillId: string; version: string; digest: string };
  let signer: Ed25519LaunchAttestationSigner;

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2-platform-")));
    workspace = join(baseDir, "workspace");
    stateDirectory = join(baseDir, "state");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(workspace, 0o700);
    await chmod(stateDirectory, 0o700);

    identity = {
      machineId: "machine-1",
      repositoryId: "repo-1",
      workspaceRoot: workspace,
      sessionId: "session-r2",
      generation: 1,
      stateDirectory
    };

    const files = skillFiles("inspect-task");
    const digest = bundleDigest(files);
    skillManager = new SkillManager({
      store: new SkillFileStore(join(baseDir, "skills-store")),
      supportedCommands: ["status", "help", "doctor"],
      approvedBuiltinDigests: [digest]
    });
    const installed = await skillManager.installBundle(files, { source: "builtin", expectedDigest: digest });
    skillPin = { skillId: installed.skillId, version: installed.version, digest: installed.digest };
    gatewayControl = new FakeGatewayControl();
    signer = Ed25519LaunchAttestationSigner.generate("bflow-r2-host");
  });

  afterEach(async () => {
    if (fsPromises.open !== originalOpen) {
      fsPromises.open = originalOpen;
      syncBuiltinESMExports();
    }
    if (originalEnvPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalEnvPath;
    await rm(baseDir, { recursive: true, force: true });
  });

  function requirement(overrides: Partial<RolePlatformRequirement> = {}): RolePlatformRequirement {
    return {
      role: "developer",
      provider: "claude",
      required: true,
      permissionMode: "workspace_auto",
      cwd: workspace,
      taskId: "task-deepwiki",
      capabilityIds: [],
      mcpServiceIds: [],
      toolIds: ["search"],
      skillSelections: [{ skill: skillPin, required: true }],
      ...overrides
    };
  }

  it("strips shadowing +x provider directories and empty/relative PATH segments colliding in the Developer task worktree cwd", async () => {
    const superpowersToolsDir = join(baseDir, "tools", "superpowers");
    await mkdir(join(superpowersToolsDir, "claude"), { recursive: true, mode: 0o755 });

    // Verified provider binary on PATH after shadowing segments
    const isolatedOptDir = join(baseDir, "opt-claude");
    await mkdir(isolatedOptDir, { recursive: true, mode: 0o755 });
    const explicitClaudeBin = join(isolatedOptDir, "claude");
    await writeFile(explicitClaudeBin, "#!/bin/sh\necho claude-ok\n", { mode: 0o755 });

    // Place a directory named `claude` inside the Developer's task worktree cwd (absent from process.cwd()!)
    // alongside an empty PATH segment ("") and relative segment (".").
    const worktreeCwd = join(baseDir, "worktrees", "task-deepwiki");
    await mkdir(join(worktreeCwd, "claude"), { recursive: true, mode: 0o755 });

    process.env["PATH"] = ["", ".", superpowersToolsDir, isolatedOptDir, "/usr/bin", "/bin"].join(delimiter);

    const journal = new FileLaunchJournal(join(stateDirectory, "launch-journal.jsonl"));
    const providers = new ProviderReadiness({
      factory: createProviderAdapterFactory({
        runner: createFakeProviderRunner({ scenario: "healthy" }),
        perProvider: {
          claude: {
            executablePath: explicitClaudeBin,
            allowTestFilesystemOwnership: true
          }
        }
      }),
      journal
    });
    const service = new DefaultPlatformReadinessService({
      environments: new RoleEnvironmentResolver(),
      skills: new SkillSessionStore({ resolver: createSkillResolver(skillManager) }),
      gateway: new GatewayRegistrationManager({ control: gatewayControl, endpoint: ENDPOINT }),
      providers,
      journal,
      signer,
      rolePrompt: role => `Role prompt for ${role}.`
    });

    const prepared = await service.prepareDeveloper(
      identity,
      requirement({ provider: "claude", cwd: worktreeCwd })
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const emittedPath = prepared.value.launch.env["PATH"];
    expect(emittedPath).toBeDefined();
    const emittedSegments = emittedPath!.split(delimiter);
    expect(emittedSegments).not.toContain(superpowersToolsDir);
    expect(emittedSegments).not.toContain("");
    expect(emittedSegments).not.toContain(".");
    expect(emittedSegments).toContain(isolatedOptDir);
  });

  it("FileLaunchJournal.entries throws LaunchJournalCorruptionError (mapped to corruption, never raw EISDIR) when journal path is a directory, and GatewayControlClient refuses directory locators cleanly", async () => {
    const journalDirPath = join(stateDirectory, "corrupt-dir-journal.jsonl");
    await mkdir(journalDirPath, { mode: 0o700 });

    const journal = new FileLaunchJournal(journalDirPath);
    await expect(journal.entries()).rejects.toBeInstanceOf(LaunchJournalCorruptionError);

    const locatorResult = await GatewayControlClient.fromLocator(journalDirPath);
    expect(locatorResult.ok).toBe(false);
    if (!locatorResult.ok) {
      expect(locatorResult.error.code).toBe("validation");
    }
  });

  it("tolerates FUSE/NTFS EINVAL on file handle.sync() across SkillSessionStore, GatewayRegistrationManager, persistRoleProfileSnapshot, FileLaunchJournal, and FileToolUsageLedger", async () => {
    fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      handle.sync = async () => {
        const err = new Error("EINVAL: invalid argument, fsync") as NodeJS.ErrnoException;
        err.code = "EINVAL";
        throw err;
      };
      return handle;
    }) as typeof originalOpen;
    syncBuiltinESMExports();

    const journal = new FileLaunchJournal(join(stateDirectory, "fuse-journal.jsonl"));
    await journal.append({
      kind: "released",
      launchId: "launch-fuse-1",
      recordedAt: "2026-10-31T00:00:00.000Z"
    });
    expect(await journal.entries()).toHaveLength(1);

    const skills = new SkillSessionStore({ resolver: createSkillResolver(skillManager) });
    const resolvedSkills = await skills.resolveForRole(identity, requirement(), "env-fuse-1");
    expect(resolvedSkills.ok).toBe(true);

    const gateway = new GatewayRegistrationManager({ control: gatewayControl, endpoint: ENDPOINT });
    const granted = await gateway.ensureForRole(identity, {
      role: "developer",
      provider: "claude",
      taskId: "task-fuse",
      environmentId: "env-fuse-1",
      serviceIds: ["svc-search"],
      allowedTools: ["search"],
      configDigest: "a".repeat(64)
    });
    expect(granted.ok).toBe(true);

    const prof = specialistProfile({ profileId: "fuse-prof", baseRole: "developer" });
    const savedProfilePath = await persistRoleProfileSnapshot(identity, prof);
    expect((await stat(savedProfilePath)).isFile()).toBe(true);

    const usageLedger = new FileToolUsageLedger(join(stateDirectory, "fuse-tool-usage.json"));
    await usageLedger.begin({
      schemaVersion: 3,
      role: "developer",
      sessionId: identity.sessionId,
      generation: identity.generation,
      invocationId: "inv-fuse-1",
      toolId: "rtk",
      operation: "pipe",
      status: "started",
      observedAt: "2026-10-31T00:00:00.000Z"
    });
    expect(await usageLedger.list()).toHaveLength(1);
  });

  it("maintains zero runtime value circular imports across all four Slice 2 source trees", async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const trees = [
      join(repoRoot, "packages/agent-providers/src"),
      join(repoRoot, "packages/pane-manager/src"),
      join(repoRoot, "packages/skills/src"),
      join(repoRoot, "packages/runtime/src/platform")
    ];

    async function collectTsFiles(dir: string): Promise<string[]> {
      const out: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await collectTsFiles(full)));
        else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
      }
      return out.sort();
    }

    const importStmtRegex =
      /(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:([\s\S]*?)\s+from\s+)?["'](\.[^"']+)["']/g;

    for (const tree of trees) {
      const files = await collectTsFiles(tree);
      const fileSet = new Set(files);
      const edges = new Map<string, string[]>();

      for (const file of files) {
        const src = await readFile(file, "utf8");
        const targets: string[] = [];
        for (const match of src.matchAll(importStmtRegex)) {
          const clause = (match[1] ?? "").trim();
          const specifier = match[2]!;
          if (clause.startsWith("{") && clause.endsWith("}")) {
            const inner = clause
              .slice(1, -1)
              .split(",")
              .map(s => s.trim())
              .filter(Boolean);
            if (inner.length > 0 && inner.every(s => s.startsWith("type "))) continue;
          }
          const candidate = resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));
          if (fileSet.has(candidate)) targets.push(candidate);
        }
        edges.set(file, targets);
      }

      const state = new Map<string, number>();
      const stack: string[] = [];
      const cycles: string[] = [];

      const dfs = (node: string) => {
        state.set(node, 1);
        stack.push(node);
        for (const next of edges.get(node) ?? []) {
          const st = state.get(next) ?? 0;
          if (st === 0) dfs(next);
          else if (st === 1) {
            const idx = stack.indexOf(next);
            cycles.push([...stack.slice(idx), next].join(" -> "));
          }
        }
        stack.pop();
        state.set(node, 2);
      };

      for (const file of files) {
        if ((state.get(file) ?? 0) === 0) dfs(file);
      }
      expect(cycles).toEqual([]);
    }
  });
});
