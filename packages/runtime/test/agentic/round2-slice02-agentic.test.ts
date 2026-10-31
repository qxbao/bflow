import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRole, ContractError, MCPClientRegistration, OperationResult } from "@bflow/contracts";
import { HostPlatformSession } from "../../src/agentic/host-platform.js";
import { tokenEnvironmentName } from "../../src/platform/gateway-registrations.js";
import type { AgenticHostPlatformOptions, PlatformRoleOption } from "../../src/platform/host-options.js";
import type { PlatformReadinessService, PreparedRoleLaunch, RolePlatformRequirement } from "../../src/platform/index.js";
import { cleanups, fixture } from "../helpers/agentic-integration-fixture.js";
import { profile as roleProfileFixture } from "../platform/role-profile-fixture.js";

const localCleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const action of localCleanup.splice(0).reverse()) await action();
  for (const action of cleanups.splice(0).reverse()) await action();
});

const at = "2026-10-31T00:00:00.000Z";
const token = "bearer-secret-token-round2-0123456789";

const roleOption = (role: AgentRole, provider: "claude" | "codex" | "agy", required = true): PlatformRoleOption => ({
  role,
  provider,
  required,
  permissionMode: "restricted",
  capabilityIds: [`${role}-cap`, "repository.read"],
  mcpServiceIds: [],
  toolIds: [],
  skillSelections: []
});

const basePlatform: AgenticHostPlatformOptions = {
  schemaVersion: 3,
  machineId: "machine-1",
  repositoryId: "repo-1",
  roles: [
    roleOption("conversation", "codex"),
    roleOption("coordinator", "codex"),
    roleOption("reviewer", "codex"),
    roleOption("developer", "codex", false)
  ],
  skillsStoreRoot: "/var/lib/bflow/skills-store",
  approvedBuiltinSkillDigests: []
};

function makePrepared(role: AgentRole, provider: "claude" | "codex" | "agy", launchId: string, withProbe = false): PreparedRoleLaunch {
  const registration = {
    schemaVersion: 3,
    registrationId: `reg-${launchId}`,
    provider,
    role,
    scope: { kind: "session" },
    environmentId: `env-${launchId}`,
    serviceIds: ["svc-1"],
    allowedTools: ["query"],
    connection: {
      transport: "streamable_http",
      endpoint: "http://127.0.0.1:7777/mcp",
      token: `secret://runtime/reg-${launchId}`
    },
    configDigest: "a".repeat(64),
    expiresAt: at,
    idempotencyKey: `key-${launchId}`
  } as unknown as MCPClientRegistration;
  const envName = tokenEnvironmentName(registration.registrationId);
  return {
    role,
    provider,
    required: true,
    environment: { environmentId: `env-${role}`, configFingerprint: "b".repeat(64) } as PreparedRoleLaunch["environment"],
    profile: {
      executable: "/usr/bin/true",
      executableDigest: "c".repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      configFiles: []
    } as unknown as PreparedRoleLaunch["profile"],
    preflight: {} as PreparedRoleLaunch["preflight"],
    skills: {
      manifest: {
        schemaVersion: 3,
        manifestId: `m-${launchId}`,
        environmentId: `env-${role}`,
        scope: { kind: "session", machineId: "machine-1", repositoryId: "repo-1", workspaceRoot: "/repo", sessionId: "s1" },
        role,
        provider,
        digest: "0".repeat(64),
        skills: [],
        bindings: []
      },
      rendered: { provider, manifestDigest: "0".repeat(64), instructionText: "Pinned instructions", references: [] },
      diagnostics: []
    } as unknown as PreparedRoleLaunch["skills"],
    gateway: withProbe
      ? { registrations: [registration], observations: [], tokenEnvironment: { [envName]: token } }
      : { registrations: [], observations: [], tokenEnvironment: {} },
    launch: {
      argv: ["--provider", provider],
      env: withProbe ? { [envName]: token } : {},
      launchId,
      launchFingerprint: "a".repeat(64)
    }
  } as unknown as PreparedRoleLaunch;
}

describe("Round 2 Slice 2 — HostPlatformSession & TaskProviderFailover hardening", () => {
  it("HostPlatformSession.allocateProfileSpecialist releases prior same-taskId launch on reallocation and rolls back cleanly when probe publication fails", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2-host-profile-")));
    localCleanup.push(() => rm(root, { recursive: true, force: true }));

    let seq = 0;
    const released: string[] = [];
    const profile = roleProfileFixture({ profileId: "sec-reviewer", baseRole: "reviewer" });

    const service: PlatformReadinessService = {
      prepareSession: async (_identity, reqs: readonly RolePlatformRequirement[]) => {
        if (reqs.length === 1 && reqs[0]?.roleProfile) {
          const launchId = `launch-prof-${++seq}`;
          return {
            ok: true,
            value: {
              report: { ready: true, generation: 1, roles: [], checkedAt: at },
              launches: [makePrepared("reviewer", "codex", launchId, true)]
            }
          };
        }
        return {
          ok: true,
          value: {
            report: { ready: true, generation: 1, roles: [], checkedAt: at },
            launches: [
              makePrepared("conversation", "codex", "launch-conv"),
              makePrepared("coordinator", "codex", "launch-coord"),
              makePrepared("reviewer", "codex", "launch-rev")
            ]
          }
        };
      },
      verifyActivated: async () => ({ ok: true, value: {} as never }),
      assertFresh: () => ({
        ok: false,
        error: { code: "not_found", retryable: false, message: "unused" } as ContractError
      }) as OperationResult<never>,
      prepareDeveloper: async () => ({ ok: true, value: makePrepared("developer", "codex", "launch-dev", true) }),
      releaseLaunch: async launchId => {
        released.push(launchId);
        return { ok: true, value: undefined };
      },
      shutdown: async () => ({ ok: true, value: undefined }),
      status: () => ({ generation: 1, launches: [] })
    };

    const probeDirectory = join(root, "probes");
    const host = new HostPlatformSession({
      service,
      platform: { ...basePlatform, roleProfiles: [profile] },
      repositoryPath: root,
      sessionId: "s-r2",
      stateDirectory: join(root, "state"),
      generationFile: join(root, "gen.json"),
      launchesFile: join(root, "launches.json"),
      probeDirectory,
      reachabilityDirectory: join(root, "reachability"),
      hostCapabilities: { reviewer: ["repository.read"] }
    });
    await host.prepare();

    // First specialist allocation for task-spec-1
    const first = await host.allocateProfileSpecialist({
      runId: "run-1",
      taskId: "task-spec-1",
      role: "reviewer",
      roleProfile: profile
    });
    expect(first.launchId).toBe("launch-prof-1");
    expect((await stat(join(probeDirectory, "launch-prof-1.json"))).isFile()).toBe(true);

    // Reallocation for the same taskId MUST release launch-prof-1 and remove its probe file!
    const second = await host.allocateProfileSpecialist({
      runId: "run-1",
      taskId: "task-spec-1",
      role: "reviewer",
      roleProfile: profile
    });
    expect(second.launchId).toBe("launch-prof-2");
    expect(released).toContain("launch-prof-1");
    expect(host.hasActiveDeveloperLaunch("launch-prof-1")).toBe(false);
    expect(host.hasActiveDeveloperLaunch("launch-prof-2")).toBe(true);
    await expect(stat(join(probeDirectory, "launch-prof-1.json"))).rejects.toMatchObject({ code: "ENOENT" });

    // Failure during probe publication (probeDirectory replaced by a regular file) MUST release launch-prof-3 and leave no stale state
    await rm(probeDirectory, { recursive: true, force: true });
    await writeFile(probeDirectory, "blocking-file", { mode: 0o600 });
    await expect(
      host.allocateProfileSpecialist({
        runId: "run-1",
        taskId: "task-spec-fail",
        role: "reviewer",
        roleProfile: profile
      })
    ).rejects.toThrow();
    expect(released).toContain("launch-prof-3");
    expect(host.hasActiveDeveloperLaunch("launch-prof-3")).toBe(false);
  });

  it("HostPlatformSession.allocateDeveloper still removes published probe file and preserves primary error when processScopes.prepare and releaseLaunch both throw", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-r2-host-dev-rollback-")));
    localCleanup.push(() => rm(root, { recursive: true, force: true }));

    const probeDirectory = join(root, "probes");
    const service: PlatformReadinessService = {
      prepareSession: async () => ({
        ok: true,
        value: {
          report: { ready: true, generation: 1, roles: [], checkedAt: at },
          launches: [
            makePrepared("conversation", "codex", "launch-conv"),
            makePrepared("coordinator", "codex", "launch-coord"),
            makePrepared("reviewer", "codex", "launch-rev")
          ]
        }
      }),
      verifyActivated: async () => ({ ok: true, value: {} as never }),
      assertFresh: () => ({
        ok: false,
        error: { code: "not_found", retryable: false, message: "unused" } as ContractError
      }) as OperationResult<never>,
      prepareDeveloper: async () => ({ ok: true, value: makePrepared("developer", "codex", "launch-dev-rollback", true) }),
      releaseLaunch: async () => {
        throw new Error("secondary release crash");
      },
      shutdown: async () => ({ ok: true, value: undefined }),
      status: () => ({ generation: 1, launches: [] })
    };

    const host = new HostPlatformSession({
      service,
      platform: basePlatform,
      repositoryPath: root,
      sessionId: "s-r2-dev",
      stateDirectory: join(root, "state"),
      generationFile: join(root, "gen.json"),
      launchesFile: join(root, "launches.json"),
      probeDirectory,
      reachabilityDirectory: join(root, "reachability"),
      hostCapabilities: {},
      processScopes: {
        assertReady: async () => ({ python: "/usr/bin/python3", bwrap: "/usr/bin/bwrap" }),
        prepare: async () => {
          throw new Error("primary process scope prepare failure");
        }
      } as never
    });
    await host.prepare();

    await expect(host.allocateDeveloper("task-dev-1", join(root, "wt"), "run-1")).rejects.toThrow(
      "primary process scope prepare failure"
    );
    await expect(stat(join(probeDirectory, "launch-dev-rollback.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(host.hasActiveDeveloperLaunch("launch-dev-rollback")).toBe(false);
  });

  it("TaskProviderFailover resolves the exact failing Developer binding when multiple Developers are concurrently active in SessionManifest (no false source_binding_changed escalation)", async () => {
    const f = await fixture();
    const target = { provider: "codex" as const, model: "backup-model", profile: "backup" };
    const policy = {
      schemaVersion: 3 as const,
      policyVersion: "approved-multi-dev",
      role: "developer" as const,
      candidates: [target],
      maxSwitches: 2,
      cooldownMs: 0,
      maxRetries: 2
    };

    (f.ports as Record<string, unknown>)["providerFailover"] = {
      policyFor: () => ({ policy, current: { provider: "claude", model: "primary-model", profile: "primary" } }),
      authenticate: async () => true,
      assertMutationSafe: async () => undefined,
      preflight: async () => undefined
    };
    f.ports.stopDeveloperExecutionScope = async handle => ({
      source: "correlated_transport",
      handle,
      observedAt: new Date().toISOString()
    });

    const allocate = f.panes.allocateDeveloper.bind(f.panes);
    (f.panes as unknown as Record<string, unknown>)["allocateDeveloper"] = async (request: Record<string, unknown>) => {
      const result = await allocate(request as never);
      const candidate = request["failoverCandidate"] as { provider?: string; model?: string } | undefined;
      Object.assign(result.value, {
        provider: candidate?.provider ?? "claude",
        model: candidate?.model ?? "primary-model",
        session: {
          source: candidate?.provider ?? "claude",
          kind: "id",
          value: `native-${String(request["agentName"])}`
        }
      });
      return result;
    };

    await f.runtime.proposeWorkflow("run-1", f.spec, f.def);
    await f.runtime.tick();

    // Insert another concurrently active Developer pane EARLIER in f.panes.bindings so getRoleBinding("developer") returns the sibling Developer!
    const currentDev = f.panes.bindings.find(item => item.role === "developer")!;
    const siblingDeveloper = {
      ...structuredClone(currentDev),
      bindingId: "binding-sibling-dev",
      paneId: "pane-sibling-dev",
      agentId: "dev-sibling-task",
      worktreePath: `${currentDev.worktreePath}-sibling`,
      session: { source: "claude", kind: "id" as const, value: "native-sibling" }
    };
    f.panes.bindings.unshift(siblingDeveloper);

    const statePath = join(f.runtimeOptions.journalDirectory, "state.json");
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      outbound: {
        message: { type: string };
        selector: string;
        handle: { executionId: string; target: { paneId: string } };
      }[];
    };
    const out = persisted.outbound.find(item => item.message.type === "task.assignment")!;
    // Simulate persisted role-level selector ("developer") when multiple Developer bindings exist in SessionManifest
    out.selector = "developer";
    await writeFile(statePath, JSON.stringify(persisted, null, 2), "utf8");
    const failingBinding = f.panes.bindings.find(item => item.paneId === out.handle.target.paneId)!;

    await f.runtime.observeProviderFailure(failingBinding, {
      schemaVersion: 3,
      provider: "claude",
      kind: "quota_exhausted",
      source: "provider_structured",
      executionId: out.handle.executionId,
      observedAt: new Date().toISOString(),
      evidenceDigest: "a".repeat(64)
    });
    await f.runtime.continueProviderFailovers();
    await f.runtime.flushOutbound();

    const inspectedRun = (await f.runtime.inspect("run-1")) as {
      tasks: { failovers: { phase: string; reason?: string }[] }[];
    };
    expect(inspectedRun.tasks[0]?.failovers[0]?.reason).not.toBe("source_binding_changed");
    expect(inspectedRun.tasks[0]?.failovers[0]?.phase).toBe("dispatched");
  });
});
