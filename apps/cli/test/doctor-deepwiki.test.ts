import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@bflow/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@bflow/runtime")>(),
  diagnoseVerificationSandbox: vi.fn(async () => ({ checkId: "runtime-verification-sandbox",
    name: "Independent verification sandbox", status: "passed", message: "Sandbox probe passed" }))
}));
import { defaultEnvironmentConfig, identifyRepository, runDoctorDiagnostics, type EnvironmentProcessRequest, type EnvironmentProcessRunner, type RepositoryIdentity } from "../src/index.js";
import * as health from "../src/docs-health.js";

const TOOLS = ["ask_wiki_question", "read_wiki_contents", "read_wiki_structure"];

/** Real git, nothing else installed: every other executable is reported missing. */
class GitOnlyRunner implements EnvironmentProcessRunner {
  async run(request: EnvironmentProcessRequest) {
    if (request.executable === "git") {
      return { exitCode: 0, stdout: execFileSync("git", request.args, { cwd: request.cwd, env: { ...process.env, ...request.env }, encoding: "utf8" }), stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: `command not found: ${request.executable}` };
  }
}

const target = { endpoint: "http://127.0.0.1:1/mcp", token: "agent-token", registrationId: "reg-1" };
const readiness = (overrides: Record<string, unknown> = {}) => async () => ({ gateway: "running" as const, status: "ready" as const, discoveredTools: TOOLS, observedAt: "2026-10-30T00:00:00.000Z", ageMs: 1000, ...overrides });
function caller(options: { list?: unknown; call?: unknown } = {}) {
  const calls: Array<{ tool: string; args: unknown }> = [];
  return { calls, make: () => ({
    listTools: async () => (options.list ?? { ok: true, tools: TOOLS }) as never,
    callTool: async (tool: string, args: unknown) => { calls.push({ tool, args }); return (options.call ?? { ok: true, isError: false, text: "- 1 Overview\n- 2 Reconciler" }) as never; }
  }) };
}
const network = { ok: false, error: { code: "transport_unavailable", message: "The Gateway is not reachable.", details: { kind: "network" } } };
function evaluate(options: { enabled?: boolean; required?: boolean; caller?: ReturnType<typeof caller>; readiness?: ReturnType<typeof readiness> }) {
  const fake = options.caller ?? caller();
  const api = health as Record<string, any>;
  return api.evaluateDeepWikiHealth({ deepwiki: { enabled: options.enabled ?? true, required: options.required ?? false },
    roles: [{ role: "developer", cli: "claude" }, { role: "reviewer", cli: "codex" }, { role: "conversation", cli: "claude" }], grantedRoles: ["developer", "reviewer"],
    stateDirectory: "/nonexistent-state", machineId: "m1", repository: undefined, env: {}, probe: true,
    deps: { readiness: options.readiness ?? readiness(), access: async () => ({ mode: "agent", target }), caller: fake.make } });
}

describe("DeepWiki integration", () => {
  let dir: string;
  let repository: RepositoryIdentity;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bflow-dwdoctor-"));
    execFileSync("git", ["init", "--quiet"], { cwd: dir });
    repository = await identifyRepository(dir, new GitOnlyRunner());
    await mkdir(join(dir, ".bflow"), { recursive: true });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const doctor = (deepwiki: { enabled?: boolean; required?: boolean }, deepwikiHealth?: () => Promise<unknown>) => {
    const config = JSON.parse(JSON.stringify(defaultEnvironmentConfig(repository, "doctor", new Date("2026-10-17T00:00:00.000Z"), "claude")));
    config.environment.deepwiki = deepwiki;
    return runDoctorDiagnostics({ repository, config, runner: new GitOnlyRunner(), env: process.env, dependencies: deepwikiHealth ? { deepwikiHealth } as never : {},
      probeSession: async () => false, intent: async () => null, statePath: (name: string) => resolve(dir, ".bflow/state", name) } as never);
  };

  it("doctor reports readiness and network failure", async () => {
    expect(typeof (health as Record<string, unknown>).evaluateDeepWikiHealth).toBe("function");
    expect((health as Record<string, unknown>).evaluateContext7Health).toBeUndefined();

    // Ready: the Gateway lists the service, discovery names the three tools, a real read call works, and no key is involved.
    const fake = caller();
    const ready = await evaluate({ caller: fake });
    expect(ready).toMatchObject({ enabled: true, required: false, state: "healthy", probe: { mode: "agent" } });
    expect(ready.checks.map((check: { id: string }) => check.id)).toEqual(expect.arrayContaining(["enabled", "gateway", "service", "connection", "discovery", "read_wiki_structure"]));
    expect(ready.checks.some((check: { id: string }) => check.id === "authentication")).toBe(false);
    expect(ready.checks.find((check: { id: string }) => check.id === "service").message).toContain("DeepWiki");
    expect(fake.calls).toEqual([{ tool: "read_wiki_structure", args: { repoName: expect.stringMatching(/^[\w.-]+\/[\w.-]+$/) } }]);
    expect(JSON.stringify(ready)).not.toMatch(/context7|api key/i);
    expect(ready.providers).toEqual(expect.arrayContaining([{ provider: "claude", granted: true, roles: ["developer"] }, { provider: "codex", granted: true, roles: ["reviewer"] }]));

    // Network failure: optional DeepWiki degrades, required DeepWiki is unavailable, and the cause is named.
    const down = { list: network, call: network };
    const degraded = await evaluate({ caller: caller(down) });
    expect(degraded.state).toBe("degraded");
    const failing = degraded.checks.filter((check: { status: string }) => check.status === "fail");
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.some((check: { failureKind?: string }) => check.failureKind === "network")).toBe(true);
    expect(JSON.stringify(failing)).toMatch(/deepwiki\.com/i);
    expect(JSON.stringify(degraded)).not.toMatch(/context7|api key/i);
    expect((await evaluate({ required: true, caller: caller(down) })).state).toBe("unavailable");
    expect((await evaluate({ enabled: false, caller: fake })).state).toBe("disabled");
    // A Gateway that does not list the service is reported as such, not probed.
    const missing = await evaluate({ readiness: readiness({ status: "missing", discoveredTools: [] }), caller: caller() });
    expect(missing.checks.find((check: { id: string }) => check.id === "service")).toMatchObject({ status: "fail" });

    // The doctor command carries the same result: warning when optional, failure when required, nothing when disabled.
    const unhealthy = (required: boolean) => async () => evaluate({ required, caller: caller(down) });
    const optional = await doctor({ enabled: true, required: false }, unhealthy(false));
    expect(optional.checks.filter((check: { checkId: string }) => check.checkId.startsWith("deepwiki-")).length).toBeGreaterThan(0);
    expect(optional.checks.filter((check: { checkId: string }) => check.checkId.startsWith("context7-"))).toEqual([]);
    expect(optional.checks.find((check: { checkId: string }) => check.checkId === "deepwiki-degraded")?.message).toMatch(/degraded mode/);
    expect(optional.checks.filter((check: { checkId: string; status: string }) => check.checkId.startsWith("deepwiki-") && check.status === "failed")).toEqual([]);
    const required = await doctor({ enabled: true, required: true }, unhealthy(true));
    expect(required.checks.some((check: { checkId: string; status: string }) => check.checkId.startsWith("deepwiki-") && check.status === "failed")).toBe(true);
    expect(required.healthy).toBe(false);
    const off = await doctor({ enabled: false });
    expect(off.checks.some((check: { checkId: string }) => check.checkId.startsWith("deepwiki-") || check.checkId.startsWith("context7-"))).toBe(false);
    await writeFile(join(dir, ".bflow/.keep"), "");
  });
});
