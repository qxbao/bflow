import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RepositoryToolPolicySchema,
  ResolvedToolGrantSchema,
  type AgentRole,
  type ContractError,
  type OperationOptions,
  type OperationResult
} from "@bflow/contracts";
import { HostPlatformSession } from "../../src/agentic/host-platform.js";
import { openPersistedAgenticHost } from "../../src/agentic/host-controller.js";
import { callHost } from "../../src/agentic/host-protocol.js";
import type {
  AgenticHostPlatformOptions,
  PlatformRoleOption
} from "../../src/platform/host-options.js";
import type {
  PlatformReadinessService,
  PreparedRoleLaunch,
  RolePlatformRequirement
} from "../../src/platform/index.js";
import { resolvePrivateRuntimeStateDirectory } from "../../src/private-state.js";
import { profile as roleProfileFixture } from "../platform/role-profile-fixture.js";

const cleanups: Array<() => Promise<unknown>> = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise<void>(resolveServer => {
          server.close(() => resolveServer());
        })
    )
  );
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => undefined);
  }
});

const AT = "2026-10-31T00:00:00.000Z";

function roleOption(
  role: AgentRole,
  provider: "claude" | "codex" | "agy" = "codex",
  required = true
): PlatformRoleOption {
  return {
    role,
    provider,
    required,
    permissionMode: "restricted",
    capabilityIds: ["repository.read", `${role}-cap`],
    mcpServiceIds: [],
    toolIds: [],
    skillSelections: []
  };
}

function makePreparedLaunch(
  role: AgentRole,
  provider: "claude" | "codex" | "agy",
  launchId: string
): PreparedRoleLaunch {
  return {
    role,
    provider,
    required: true,
    environment: {
      environmentId: `env-${role}`,
      configFingerprint: "b".repeat(64)
    } as PreparedRoleLaunch["environment"],
    profile: {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      configFiles: []
    } as unknown as PreparedRoleLaunch["profile"],
    preflight: {} as PreparedRoleLaunch["preflight"],
    skills: {} as PreparedRoleLaunch["skills"],
    gateway: { registrations: [], observations: [], tokenEnvironment: {} },
    launch: {
      argv: ["--test"],
      env: {},
      launchId,
      launchFingerprint: "a".repeat(64)
    }
  } as unknown as PreparedRoleLaunch;
}

function makeFakeService(overrides: Partial<PlatformReadinessService> = {}): PlatformReadinessService {
  return {
    prepareSession: async () => ({
      ok: true,
      value: {
        report: { ready: true, generation: 1, roles: [], checkedAt: AT },
        launches: [
          makePreparedLaunch("conversation", "codex", "launch-conv"),
          makePreparedLaunch("coordinator", "codex", "launch-coord")
        ]
      }
    }),
    verifyActivated: async () => ({ ok: true, value: {} as never }),
    assertFresh: () =>
      ({
        ok: false,
        error: { code: "not_found", retryable: false, message: "unused" } as ContractError
      }) as OperationResult<never>,
    prepareDeveloper: async () => ({
      ok: true,
      value: makePreparedLaunch("developer", "codex", "launch-dev")
    }),
    releaseLaunch: async () => ({ ok: true, value: undefined }),
    shutdown: async () => ({ ok: true, value: undefined }),
    status: () => ({
      generation: 1,
      launches: [{ launchId: "launch-coord", role: "coordinator", provider: "codex", state: "activated" }]
    }),
    ...overrides
  } as unknown as PlatformReadinessService;
}

describe("Flow-04 HostPlatformSession, host-protocol wall-clock framing, and host-controller boot.lock/deadline hardening", () => {
  it("HostPlatformSession.allocateProfileSpecialist guards missing base role templates, forces required=true for optional base roles, and surfaces blocking diagnostics", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow04-hostplat-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const observedSpecialistReqs: RolePlatformRequirement[] = [];
    let sessionCallCount = 0;
    const service = makeFakeService({
      prepareSession: async (_identity, reqs) => {
        sessionCallCount += 1;
        if (sessionCallCount === 1) {
          return {
            ok: true,
            value: {
              report: { ready: true, generation: 1, roles: [], checkedAt: AT },
              launches: [
                makePreparedLaunch("conversation", "codex", "launch-conv"),
                makePreparedLaunch("coordinator", "codex", "launch-coord")
              ]
            }
          };
        }
        observedSpecialistReqs.push(...reqs);
        return {
          ok: true,
          value: {
            report: {
              ready: false,
              generation: 1,
              roles: [
                {
                  role: reqs[0]!.role,
                  provider: reqs[0]!.provider,
                  required: reqs[0]!.required,
                  status: "blocked",
                  checks: [],
                  message: "Codex binary missing required capability"
                }
              ],
              checkedAt: AT
            },
            launches: []
          }
        };
      }
    });

    const qaProfile = roleProfileFixture({ profileId: "perf-qa", baseRole: "qa" });
    const reviewerProfile = roleProfileFixture({ profileId: "sec-rev", baseRole: "reviewer" });

    // `qa` is configured as optional (`required: false`), `reviewer` is intentionally absent from `roles`
    const platform: AgenticHostPlatformOptions = {
      schemaVersion: 3,
      machineId: "machine-1",
      repositoryId: "repo-1",
      roles: [
        roleOption("conversation", "codex", true),
        roleOption("coordinator", "codex", true),
        roleOption("qa", "codex", false)
      ],
      roleProfiles: [qaProfile, reviewerProfile],
      skillsStoreRoot: "/var/lib/bflow/skills-store",
      approvedBuiltinSkillDigests: []
    };

    const host = new HostPlatformSession({
      service,
      platform,
      repositoryPath: root,
      sessionId: "s-flow04",
      stateDirectory: join(root, "state"),
      generationFile: join(root, "gen.json"),
      launchesFile: join(root, "launches.json"),
      probeDirectory: join(root, "probes"),
      reachabilityDirectory: join(root, "reachability"),
      hostCapabilities: {}
    });
    await host.prepare();

    // 1. Missing `reviewer` base role template fails cleanly instead of TypeError crash
    await expect(
      host.allocateProfileSpecialist({
        runId: "run-1",
        taskId: "task-rev",
        role: "reviewer",
        roleProfile: reviewerProfile
      })
    ).rejects.toThrow(/has no configured platform template|is not configured/);

    // 2. Optional `qa` base role (`required: false`) is promoted to `required: true` and surfaces exact blocking message
    await expect(
      host.allocateProfileSpecialist({
        runId: "run-1",
        taskId: "task-qa",
        role: "qa",
        roleProfile: qaProfile
      })
    ).rejects.toThrow("Profiled specialist launch readiness is blocked: Codex binary missing required capability");
    expect(observedSpecialistReqs).toHaveLength(1);
    expect(observedSpecialistReqs[0]?.required).toBe(true);
  });

  it("HostPlatformSession.invokeTool keeps 5s default and caps verifyGateway at 5s while honoring explicit caller timeouts up to 120s", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow04-invoke-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const verifyTimeouts: Array<number | undefined> = [];
    const invokeTimeouts: Array<number | undefined> = [];

    const service = makeFakeService({
      assertFresh: () => ({ ok: true, value: {} as never }),
      verifyGateway: async (opts?: OperationOptions) => {
        verifyTimeouts.push(opts?.timeoutMs);
        return { ok: true, value: { checkedAt: AT, healthy: true, lost: [], uncertain: false } };
      },
      invokeTool: async (
        _id,
        _role,
        _taskId,
        _svc,
        _op,
        _input,
        callId,
        opts?: OperationOptions
      ) => {
        invokeTimeouts.push(opts?.timeoutMs);
        return {
          ok: true,
          value: {
            schemaVersion: 3,
            callId,
            status: "completed",
            output: {},
            observedAt: AT
          }
        };
      }
    });

    const scope = {
      kind: "session" as const,
      machineId: "machine-1",
      repositoryId: "repo-1",
      workspaceRoot: root,
      sessionId: "s-invoke"
    };
    const policy = RepositoryToolPolicySchema.parse({
      schemaVersion: 3,
      repositoryId: "repo-1",
      scope: {
        kind: "repository",
        machineId: "machine-1",
        repositoryId: "repo-1",
        workspaceRoot: root
      },
      digest: "b".repeat(64),
      requirements: [
        {
          toolId: "deepwiki",
          kind: "native_remote_mcp",
          serviceId: "deepwiki",
          operations: ["ask_wiki_question"],
          requiredness: "optional",
          roles: ["coordinator"],
          triggers: ["external_documentation"]
        }
      ]
    });
    const grant = ResolvedToolGrantSchema.parse({
      schemaVersion: 3,
      grantId: "grant-dw",
      policyDigest: policy.digest,
      toolId: "deepwiki",
      kind: "native_remote_mcp",
      requiredness: "optional",
      role: "coordinator",
      scope,
      triggers: ["external_documentation"],
      serviceId: "deepwiki",
      operations: ["ask_wiki_question"]
    });

    const host = new HostPlatformSession({
      service,
      platform: {
        schemaVersion: 3,
        machineId: "machine-1",
        repositoryId: "repo-1",
        roles: [roleOption("conversation"), roleOption("coordinator")],
        skillsStoreRoot: "/var/lib/bflow/skills-store",
        approvedBuiltinSkillDigests: [],
        toolPolicy: policy,
        toolGrants: [grant]
      },
      repositoryPath: root,
      sessionId: "s-invoke",
      stateDirectory: join(root, "state"),
      generationFile: join(root, "gen.json"),
      launchesFile: join(root, "launches.json"),
      probeDirectory: join(root, "probes"),
      reachabilityDirectory: join(root, "reachability"),
      hostCapabilities: {}
    });
    await host.prepare();

    // 1. Default (undefined options) -> 5,000ms for both verifyGateway and invokeTool
    const defaultRes = await host.invokeTool(
      "coordinator",
      undefined,
      "deepwiki",
      "deepwiki",
      "ask_wiki_question",
      "external_documentation",
      { question: "default" },
      "call-default"
    );
    expect(defaultRes.ok).toBe(true);

    // 2. Explicit 60,000ms -> verifyGateway capped at 5,000ms, invokeTool receives 60,000ms
    const explicitRes = await host.invokeTool(
      "coordinator",
      undefined,
      "deepwiki",
      "deepwiki",
      "ask_wiki_question",
      "external_documentation",
      { question: "slow" },
      "call-60s",
      false,
      { timeoutMs: 60_000 }
    );
    expect(explicitRes.ok).toBe(true);

    // 3. Explicit 300,000ms -> clamped at 120,000ms max
    const clampedRes = await host.invokeTool(
      "coordinator",
      undefined,
      "deepwiki",
      "deepwiki",
      "ask_wiki_question",
      "external_documentation",
      { question: "huge" },
      "call-clamped",
      false,
      { timeoutMs: 300_000 }
    );
    expect(clampedRes.ok).toBe(true);

    expect(verifyTimeouts).toEqual([5_000, 5_000, 5_000]);
    expect(invokeTimeouts).toEqual([5_000, 60_000, 120_000]);
  });

  it("callHost enforces a true wall-clock timeout under trickling chunks, reassembles split multi-byte UTF-8 frames, and rejects non-positive timeouts before connect", async () => {
    const shortDir = await mkdtemp(join("/tmp", "bf04-proto-"));
    cleanups.push(() => rm(shortDir, { recursive: true, force: true }));
    const socketPath = join(shortDir, "host.sock");

    let mode: "trickle" | "split-utf8" | "object-error" | "empty-error" = "trickle";
    const activeTimers = new Set<ReturnType<typeof setInterval>>();
    cleanups.push(async () => {
      for (const timer of activeTimers) clearInterval(timer);
      activeTimers.clear();
    });

    const server = createServer(socket => {
      socket.on("data", chunk => {
        if (!chunk.toString("utf8").includes("\n")) return;
        if (mode === "trickle") {
          socket.write('{"ok":true,"value":"');
          const trickle = setInterval(() => {
            if (!socket.destroyed) socket.write("a");
          }, 15);
          activeTimers.add(trickle);
          socket.on("close", () => {
            clearInterval(trickle);
            activeTimers.delete(trickle);
          });
          return;
        }
        if (mode === "object-error") {
          socket.end(`${JSON.stringify({ ok: false, error: { message: "old native operation" } })}\n`);
          return;
        }
        if (mode === "empty-error") {
          socket.end(`${JSON.stringify({ ok: false, error: "" })}\n`);
          return;
        }
        const payload = Buffer.from(
          `${JSON.stringify({ ok: true, value: { greeting: "Báo cáo tiến độ 🛠️ hoàn tất" } })}\n`,
          "utf8"
        );
        const emojiPos = payload.indexOf(Buffer.from("🛠️", "utf8"));
        socket.write(payload.subarray(0, emojiPos + 2));
        setTimeout(() => socket.write(payload.subarray(emojiPos + 2)), 10);
      });
    });
    servers.push(server);
    await new Promise<void>(resolveListen => server.listen(socketPath, resolveListen));

    // 1. Non-positive timeout rejects immediately without hanging
    await expect(callHost(socketPath, "tok", "ping", {}, 0)).rejects.toThrow("timed out after 0ms");

    // 2. Trickling bytes every 15ms cannot defeat the 90ms wall-clock timeout
    const startedAt = Date.now();
    await expect(callHost(socketPath, "tok", "ping", {}, 90)).rejects.toThrow("timed out after 90ms");
    expect(Date.now() - startedAt).toBeLessThan(400);

    // 3. Split multi-byte UTF-8 reply decodes intact
    mode = "split-utf8";
    const value = await callHost(socketPath, "tok", "ping", {}, 5_000);
    expect(value).toEqual({ greeting: "Báo cáo tiến độ 🛠️ hoàn tất" });

    // 4. Structured error object `{ ok: false, error: { message } }` and malformed empty error reject immediately without hanging `finish()`
    mode = "object-error";
    await expect(callHost(socketPath, "tok", "ping", {}, 5_000)).rejects.toThrow("old native operation");
    mode = "empty-error";
    await expect(callHost(socketPath, "tok", "ping", {}, 5_000)).rejects.toThrow("Expected nonempty string");
  });

  it("openPersistedAgenticHost waits cleanly across concurrent boot.lock contention and fails closed on expired prepare deadlines without dispatching", async () => {
    const repoDir = await realpath(await mkdtemp(join(tmpdir(), "bflow-flow04-ctrl-")));
    const shortDir = await mkdtemp(join("/tmp", "bf04-ctrl-"));
    cleanups.push(() => rm(repoDir, { recursive: true, force: true }));
    cleanups.push(() => rm(shortDir, { recursive: true, force: true }));

    const sessionId = "sess-ctrl-04";
    const hostDir = resolve(resolvePrivateRuntimeStateDirectory(repoDir), "host", sessionId);
    await mkdir(hostDir, { recursive: true, mode: 0o700 });

    const socketPath = join(shortDir, "ctrl.sock");
    const token = "f".repeat(64);
    let prepareRequests = 0;

    const fakeDaemon = createServer(socket => {
      let buf = "";
      socket.on("data", chunk => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl)) as { token: string; method: string };
        if (req.token !== token) {
          socket.end(JSON.stringify({ ok: false, error: "unauthorized" }) + "\n");
          return;
        }
        if (req.method === "ping") {
          socket.end(JSON.stringify({ ok: true, value: "pong" }) + "\n");
          return;
        }
        if (req.method === "prepare") {
          prepareRequests += 1;
          socket.end(
            JSON.stringify({
              ok: true,
              value: { launches: {} }
            }) + "\n"
          );
          return;
        }
        socket.end(JSON.stringify({ ok: false, error: `unexpected ${req.method}` }) + "\n");
      });
    });
    servers.push(fakeDaemon);
    await new Promise<void>(resolveListen => fakeDaemon.listen(socketPath, resolveListen));

    await writeFile(
      join(hostDir, "host.json"),
      JSON.stringify({
        repositoryPath: repoDir,
        sessionId,
        directory: hostDir,
        socketPath,
        token
      }),
      { mode: 0o600 }
    );

    // Hold `boot.lock` via flock for 180ms while openPersistedAgenticHost starts concurrently
    const lockHandle = await open(join(hostDir, "boot.lock"), "a+", 0o600);
    const holder = spawn("flock", ["3", "-c", "sleep 0.18"], {
      stdio: ["ignore", "ignore", "ignore", lockHandle.fd]
    });
    await lockHandle.close();

    const controller = await openPersistedAgenticHost({ repositoryPath: repoDir, sessionId });
    await new Promise<void>(resolveHolder => holder.once("close", () => resolveHolder()));

    // Expired deadline on `prepare` MUST reject before writing a prepare request to the daemon socket
    await expect(
      controller.prepare({ deadline: new Date(Date.now() - 1000).toISOString() })
    ).rejects.toThrow("timed out");
    expect(prepareRequests).toBe(0);
  });
});
