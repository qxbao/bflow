import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseDirectorArgs, runDirectorCommand, runDirectorHookSafely, detectProvider, defaultDirectorDeps, type DirectorCommandDeps } from "../src/director-commands.js";
import { armCodexDirectorWatch, cancelCodexDirectorWatch, readCodexDirectorWatchStatus, runCodexDirectorWatch } from "../src/director-wake.js";
import { readUserStopIntent, writeUserStopIntent } from "../src/user-stop-intent.js";

function make(over: Partial<DirectorCommandDeps> & { stdinText?: string } = {}) {
  const out: string[] = []; const err: string[] = [];
  const stdin = new PassThrough();
  if (over.stdinText !== undefined) { stdin.end(over.stdinText); }
  const ownerCall = vi.fn(async (_o: unknown, method: string) => method === "director_register" ? { token: "tid.secretsecretsecretsecret", cursor: "m4.i0.r", session: { presence: "present" } } : { recorded: true });
  const deps: DirectorCommandDeps = {
    cwd: "/repo",
    identify: async () => ({ root: "/repo", sessionName: "bf-abc" }),
    ensureUp: async () => {},
    ownerCall: ownerCall as never,
    toolCall: vi.fn(async () => ({ ok: true })) as never,
    runMcp: vi.fn(async () => {}) as never,
    env: {},
    stdin,
    stdout: { write: (c: string) => { out.push(c); } },
    stderr: { write: (c: string) => { err.push(c); } },
    ...over
  };
  return { deps, out, err, ownerCall };
}
const parse = (a: string[]) => { const r = parseDirectorArgs(a); if (!r.ok) throw new Error(r.message); return r.value; };

describe("director parser", () => {
  it("accepts the four subcommands and rejects unknown ones", () => {
    expect(parse(["start", "--provider", "codex", "--json"])).toMatchObject({ sub: "start", provider: "codex", json: true });
    expect(parse(["call", "inspect", "--json", "{}"])).toMatchObject({ sub: "call", tool: "inspect", argsJson: "{}" });
    expect(parse(["mcp"])).toEqual({ sub: "mcp" });
    expect(parse(["hook", "codex"])).toEqual({ sub: "hook", provider: "codex" });
    expect(parse(["suspend", "m4.i0.b2.rZmVlZDox"])).toEqual({ sub: "suspend", cursor: "m4.i0.b2.rZmVlZDox" });
    expect(parse(["watch", "123e4567-e89b-42d3-a456-426614174001"])).toMatchObject({ sub: "watch" });
    expect(parse(["watch-status"])).toEqual({ sub: "watch-status" });
    expect(parseDirectorArgs(["bogus"]).ok).toBe(false);
    expect(parseDirectorArgs(["hook", "agy"]).ok).toBe(false);
    expect(parseDirectorArgs(["start", "--provider", "x"]).ok).toBe(false);
  });
  it("detects provider from the environment", () => {
    expect(detectProvider({ CLAUDECODE: "1" })).toBe("claude");
    expect(detectProvider({ CODEX_HOME: "/x" })).toBe("codex");
    expect(detectProvider({ AGY_FOO: "1" })).toBe("agy");
    expect(detectProvider({})).toBe("claude");
  });
});

describe("director suspend", () => {
  it("reports a failed wake for diagnosis", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-status-"));
    try {
      await armCodexDirectorWatch({ root: dir, sessionName: "bf-abc", threadId: "123e4567-e89b-42d3-a456-426614174000", cursor: "m4.i0.b2.rZmVlZDox", spawn: async () => {} });
      const { deps, out } = make({ identify: async () => ({ root: dir, sessionName: "bf-abc" }) });
      expect(await runDirectorCommand(parse(["watch-status"]), deps)).toBe(0);
      expect(out.join("")).toContain("armed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("authenticates and arms a watcher for the current Codex thread", async () => {
    const suspendWatch = vi.fn(async () => undefined);
    const { deps, out } = make({ env: { BFLOW_DIRECTOR_TOKEN: "tid.secretsecretsecretsecret", CODEX_THREAD_ID: "123e4567-e89b-42d3-a456-426614174000" }, suspendWatch });
    expect(await runDirectorCommand(parse(["suspend", "m4.i0.b2.rZmVlZDox"]), deps)).toBe(0);
    expect(deps.toolCall).toHaveBeenCalledWith({ repositoryPath: "/repo", sessionId: "bf-abc" }, "tid.secretsecretsecretsecret", "inspect", { view: "summary" });
    expect(suspendWatch).toHaveBeenCalledWith({ root: "/repo", sessionName: "bf-abc", cursor: "m4.i0.b2.rZmVlZDox", threadId: "123e4567-e89b-42d3-a456-426614174000", token: "tid.secretsecretsecretsecret" });
    expect(out.join("")).toContain("watching");
  });
  it("refuses to suspend without a Codex thread", async () => {
    const suspendWatch = vi.fn(async () => undefined);
    const { deps } = make({ env: { BFLOW_DIRECTOR_TOKEN: "tid.secretsecretsecretsecret" }, suspendWatch });
    expect(await runDirectorCommand(parse(["suspend", "m4.i0.b2.rZmVlZDox"]), deps)).toBe(1);
    expect(suspendWatch).not.toHaveBeenCalled();
  });
});

describe("director start", () => {
  it("resolves startup before an observational read can resurrect the stopped legacy host", async () => {
    const { EnvironmentLifecycle } = await import("../src/environment.js");
    const status = vi.spyOn(EnvironmentLifecycle.prototype, "status").mockImplementation(async () => {
      throw new Error("The status query resurrected a host with stale startup authority");
    });
    const up = vi.spyOn(EnvironmentLifecycle.prototype, "up").mockResolvedValue({} as never);
    try {
      const deps = await defaultDirectorDeps("/repo");
      await expect(deps.ensureUp("/repo")).resolves.toBeUndefined();
      expect(up).toHaveBeenCalledOnce();
      expect(status).not.toHaveBeenCalled();
    } finally { status.mockRestore(); up.mockRestore(); }
  });
  it("prints one JSON object with the token", async () => {
    const { deps, out, ownerCall } = make({ env: { CODEX_HOME: "/h" } });
    expect(await runDirectorCommand(parse(["start", "--json"]), deps)).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: true, token: "tid.secretsecretsecretsecret", cursor: "m4.i0.r", sessionId: "bf-abc", repositoryRoot: "/repo", provider: "codex", presence: "present" });
    expect(ownerCall).toHaveBeenCalledWith({ repositoryPath: "/repo", sessionId: "bf-abc" }, "director_register", { provider: "codex" });
  });
  it("returns the current Codex thread id so the MCP suspend tool needs no shell token", async () => {
    const { deps, out } = make({ env: { CODEX_HOME: "/h", CODEX_THREAD_ID: "123e4567-e89b-42d3-a456-426614174000" } });
    expect(await runDirectorCommand(parse(["start", "--json"]), deps)).toBe(0);
    expect(JSON.parse(out[0]!).threadId).toBe("123e4567-e89b-42d3-a456-426614174000");
  });
  it("does not cancel a watcher when a start command cannot register", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-start-"));
    try {
      await armCodexDirectorWatch({ root: dir, sessionName: "bf-abc", threadId: "123e4567-e89b-42d3-a456-426614174000", cursor: "m4.i0.b2.rZmVlZDox", spawn: async () => {} });
      const { deps } = make({ identify: async () => ({ root: dir, sessionName: "bf-abc" }), env: { CODEX_HOME: "/h" },
        ownerCall: (async () => { throw new Error("Host unavailable"); }) as never });
      expect(await runDirectorCommand(parse(["start", "--json"]), deps)).toBe(1);
      const { readCodexDirectorWatchStatus } = await import("../src/director-wake.js");
      expect(await readCodexDirectorWatchStatus(dir, "bf-abc")).toBe("armed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("reports a fix when ensureUp fails", async () => {
    const { deps, out } = make({ ensureUp: async () => { throw new Error("Host unavailable"); } });
    expect(await runDirectorCommand(parse(["start", "--json"]), deps)).toBe(1);
    const body = JSON.parse(out[0]!);
    expect(body.ok).toBe(false);
    expect(body.fix).toContain("bflow");
  });
  it.each([
    "Host Bflow đang chạy với bố cục hoặc cấu hình cũ. Chạy `bflow down` rồi `bflow up` để chuyển sang phiên Director. (Persisted host platform differs; run bflow down before changing providers/roles)",
    "Persisted host execution sources differ; quiesce the existing host before re-resolution",
    "Persisted host layout differs; run bflow down before changing the session layout"
  ])("gives a checked restart instead of init for host startup drift: %s", async message => {
    const { deps, out } = make({ ensureUp: async () => { throw new Error(message); } });
    expect(await runDirectorCommand(parse(["start", "--json"]), deps)).toBe(1);
    const body = JSON.parse(out[0]!);
    expect(body.fix).toContain("bflow down");
    expect(body.fix).toContain("bflow director start");
    expect(body.fix).not.toContain("bflow init");
  });
  it.each([
    "Permanent role 'planner' cannot use agent name 'planner': unowned or incompatible agent in pane 'w3:p34'. No topology changes were made. Inspect bflow doctor; configure a different role agentName before retrying bflow up.",
    "Native session changed for planner in pane 'w3:p34'; refusing to adopt or close it.",
    "Restored terminal for planner is working; preserve its work before retrying bflow up.",
    "Restored planner identity changed in pane 'w3:p34' (name, provider, topology, terminal or native session differs). Preserve its work and inspect bflow doctor."
  ])("preserves topology recovery guidance instead of suggesting init: %s", async message => {
    const { deps, out, ownerCall } = make({ ensureUp: async () => { throw new Error(message); } });
    expect(await runDirectorCommand(parse(["start", "--json"]), deps)).toBe(1);
    const body = JSON.parse(out[0]!);
    expect(body.fix).toContain("bflow doctor");
    expect(body.fix).toContain("bflow up");
    expect(body.fix).not.toContain("bflow init");
    expect(ownerCall).not.toHaveBeenCalled();
  });
  it.each(["EPERM", "EACCES"])("gives a usable Director launch command for a denied Unix socket (%s)", async code => {
    const { deps, out, ownerCall } = make({ env: { BFLOW_DIRECTOR_PROVIDER: "codex" }, ensureUp: async () => {
      throw new Error(`Agentic host exited during startup (exit code 1): Host Unix socket permission denied (listen ${code}); see /repo/host.log`);
    } });
    expect(await runDirectorCommand(parse(["start", "--json"]), deps)).toBe(1);
    const body = JSON.parse(out[0]!);
    expect(body.message).toContain(`listen ${code}`);
    expect(body.fix).toContain("bflow open --provider codex");
    expect(body.fix).not.toContain("bflow doctor");
    expect(ownerCall).not.toHaveBeenCalled();
  });
});

describe("director call", () => {
  it("requires BFLOW_DIRECTOR_TOKEN", async () => {
    const { deps, out } = make();
    expect(await runDirectorCommand(parse(["call", "inspect", "--json"]), deps)).toBe(1);
    expect(out.join("")).toContain("BFLOW_DIRECTOR_TOKEN chưa được đặt");
  });
  it("reports every syntax error as one JSON object on stdout with exit 1", async () => {
    for (const [argsJson, expected] of [['{"token":"x"}', "token"], ["[1]", "đối tượng"], ["{nope", "JSON"]] as const) {
      const { deps, out, err } = make({ env: { BFLOW_DIRECTOR_TOKEN: "a.b" } });
      expect(await runDirectorCommand(parse(["call", "inspect", argsJson]), deps)).toBe(1);
      expect(out).toHaveLength(1);
      const body = JSON.parse(out[0]!);
      expect(body.ok).toBe(false);
      expect(body.message).toContain(expected);
      expect(err).toEqual([]);
      expect(deps.toolCall).not.toHaveBeenCalled();
    }
    const { deps, out } = make();
    expect(await runDirectorCommand(parse(["call", "inspect"]), deps)).toBe(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false });
  });
  it("a missing tool name fails to parse so the binary can print JSON", () => {
    expect(parseDirectorArgs(["call"]).ok).toBe(false);
  });
  it("forwards a valid call", async () => {
    const { deps, out } = make({ env: { BFLOW_DIRECTOR_TOKEN: "a.b" } });
    expect(await runDirectorCommand(parse(["call", "inspect", '{"x":1}']), deps)).toBe(0);
    expect(deps.toolCall).toHaveBeenCalledWith({ repositoryPath: "/repo", sessionId: "bf-abc" }, "a.b", "inspect", { x: 1 });
    expect(JSON.parse(out[0]!)).toEqual({ ok: true });
  });
});

describe("director hook", () => {
  it("cancels a suspended watcher on a real terminal prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-hook-"));
    try {
      const state = await armCodexDirectorWatch({ root: dir, sessionName: "bf-abc", threadId: "123e4567-e89b-42d3-a456-426614174000", cursor: "m4.i0.b2.rZmVlZDox", spawn: async () => {} });
      const { deps } = make({ cwd: dir, identify: async () => ({ root: dir, sessionName: "bf-abc" }), stdinText: '{"prompt":"hello","session_id":"123e4567-e89b-42d3-a456-426614174000"}' });
      expect(await runDirectorCommand(parse(["hook", "codex"]), deps)).toBe(0);
      const { isCodexDirectorWakePrompt } = await import("../src/director-wake.js");
      expect(await isCodexDirectorWakePrompt(dir, "bf-abc", `BFLOW_DIRECTOR_WAKE ${state.generation} m4.i0.b2.rZmVlZDox`)).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("keeps the Director watcher armed for a prompt from a foreign Codex session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-hook-"));
    try {
      await armCodexDirectorWatch({ root: dir, sessionName: "bf-abc", threadId: "123e4567-e89b-42d3-a456-426614174000", cursor: "m4.i0.b2.rZmVlZDox", spawn: async () => {} });
      const { deps } = make({ cwd: dir, identify: async () => ({ root: dir, sessionName: "bf-abc" }),
        stdinText: '{"prompt":"hello","session_id":"123e4567-e89b-42d3-a456-426614174999"}',
        ownerCall: (async () => ({ recorded: false })) as never });
      expect(await runDirectorCommand(parse(["hook", "codex"]), deps)).toBe(0);
      const { readCodexDirectorWatchStatus } = await import("../src/director-wake.js");
      expect(await readCodexDirectorWatchStatus(dir, "bf-abc")).toBe("armed");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not record the generated wake as a user message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-hook-"));
    try {
      const state = await armCodexDirectorWatch({ root: dir, sessionName: "bf-abc", threadId: "123e4567-e89b-42d3-a456-426614174000", cursor: "m4.i0.b2.rZmVlZDox", spawn: async () => {} });
      const prompt = `BFLOW_DIRECTOR_WAKE ${state.generation} m4.i0.b2.rZmVlZDox\nBflow có sự kiện mới.`;
      const { deps, ownerCall } = make({ cwd: dir, identify: async () => ({ root: dir, sessionName: "bf-abc" }), stdinText: JSON.stringify({ prompt }) });
      expect(await runDirectorCommand(parse(["hook", "codex"]), deps)).toBe(0);
      expect(ownerCall).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("does not record a wake that was queued just before manual input cancelled the watcher", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-hook-"));
    try {
      const state = await armCodexDirectorWatch({ root: dir, sessionName: "bf-abc", threadId: "123e4567-e89b-42d3-a456-426614174000", cursor: "m4.i0.b2.rZmVlZDox", spawn: async () => {} });
      await cancelCodexDirectorWatch(dir, "bf-abc");
      const prompt = `BFLOW_DIRECTOR_WAKE ${state.generation} m4.i0.b2.rZmVlZDox\nBflow có sự kiện mới.`;
      const { deps, ownerCall } = make({ cwd: dir, identify: async () => ({ root: dir, sessionName: "bf-abc" }), stdinText: JSON.stringify({ prompt }) });
      expect(await runDirectorCommand(parse(["hook", "codex"]), deps)).toBe(0);
      expect(ownerCall).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("still records a real user prompt if the private watcher marker is corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-hook-"));
    try {
      const markerDir = join(dir, ".bflow", "state", "director-watch");
      await mkdir(markerDir, { recursive: true });
      await writeFile(join(markerDir, "bf-abc.json"), "{broken");
      const { deps, ownerCall } = make({ cwd: dir, identify: async () => ({ root: dir, sessionName: "bf-abc" }), stdinText: '{"prompt":"hello"}' });
      expect(await runDirectorCommand(parse(["hook", "codex"]), deps)).toBe(0);
      expect(ownerCall).toHaveBeenCalledOnce();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("skips inside a Herdr pane", async () => {
    const { deps, out, ownerCall } = make({ env: { HERDR_PANE_ID: "p1" }, stdinText: '{"prompt":"hi"}' });
    expect(await runDirectorCommand(parse(["hook", "claude"]), deps)).toBe(0);
    expect(ownerCall).not.toHaveBeenCalled(); expect(out).toEqual([]);
  });
  it("records the prompt with a 3s timeout", async () => {
    const { deps, out, ownerCall } = make({ stdinText: '{"prompt":"hello"}' });
    expect(await runDirectorCommand(parse(["hook", "codex"]), deps)).toBe(0);
    expect(ownerCall).toHaveBeenCalledWith({ repositoryPath: "/repo", sessionId: "bf-abc" }, "director_hook_note", { provider: "codex", prompt: "hello" }, 3000);
    expect(out).toEqual([]);
  });
  it("sends the provider session_id when present", async () => {
    const { deps, ownerCall } = make({ stdinText: '{"prompt":"hello","session_id":"sess-1"}' });
    expect(await runDirectorCommand(parse(["hook", "claude"]), deps)).toBe(0);
    expect(ownerCall).toHaveBeenCalledWith({ repositoryPath: "/repo", sessionId: "bf-abc" }, "director_hook_note", { provider: "claude", prompt: "hello", sessionId: "sess-1" }, 3000);
  });
  it("swallows ownerCall errors", async () => {
    const { deps, out } = make({ stdinText: '{"prompt":"hello"}', ownerCall: (async () => { throw new Error("boom"); }) as never });
    expect(await runDirectorCommand(parse(["hook", "claude"]), deps)).toBe(0);
    expect(out).toEqual([]);
  });
  it("swallows broken stdin", async () => {
    const { deps, out, ownerCall } = make({ stdinText: "{not json" });
    expect(await runDirectorCommand(parse(["hook", "claude"]), deps)).toBe(0);
    expect(ownerCall).not.toHaveBeenCalled(); expect(out).toEqual([]);
  });
});

describe("director mcp", () => {
  it("handles director_suspend locally with MCP token and thread id", async () => {
    const suspendWatch = vi.fn(async () => undefined);
    const { deps } = make({ suspendWatch, runMcp: (async options => {
      const result = await options.call("director_suspend", "tid.secretsecretsecretsecret", { cursor: "m4.i0.b2.rZmVlZA", threadId: "123e4567-e89b-42d3-a456-426614174000" });
      expect(result).toMatchObject({ status: "watching" });
    }) as never });
    expect(await runDirectorCommand(parse(["mcp"]), deps)).toBe(0);
    expect(suspendWatch).toHaveBeenCalledOnce();
  });
  it("delegates to runMcp without writing to stdout", async () => {
    const { deps, out } = make();
    expect(await runDirectorCommand(parse(["mcp"]), deps)).toBe(0);
    expect(deps.runMcp).toHaveBeenCalled(); expect(out).toEqual([]);
  });
});

describe("director hook termination", () => {
  it("resolves within the deadline on a never-closing stdin and pauses it", async () => {
    const stdin = new PassThrough();
    const { deps, out, ownerCall } = make({ stdin, hookStdinDeadlineMs: 50 });
    const started = Date.now();
    expect(await runDirectorCommand(parse(["hook", "claude"]), deps)).toBe(0);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(stdin.destroyed || stdin.isPaused()).toBe(true);
    expect(ownerCall).not.toHaveBeenCalled(); expect(out).toEqual([]);
  });
  it("exits 0 with empty stdout when dependency loading fails", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const before = write.mock.calls.length;
    expect(await runDirectorHookSafely("claude", async () => { throw new Error("cannot load"); }, {})).toBe(0);
    expect(write.mock.calls.length).toBe(before);
    write.mockRestore();
  });
});

describe("user stop intent", () => {
  const threadId = "123e4567-e89b-42d3-a456-426614174000";
  const tokenValue = "tid.secretsecretsecretsecret";
  async function stoppedRepo() {
    const dir = await mkdtemp(join(tmpdir(), "director-stop-"));
    await writeUserStopIntent(dir, { version: 1, repositoryId: "repo-1", sessionName: "bf-abc", source: "web", requestedAt: "2026-11-09T10:00:00.000Z" });
    return { dir, identify: async () => ({ root: dir, sessionName: "bf-abc", id: "repo-1" }) };
  }

  it("parses --restart for director start", () => {
    expect(parse(["start", "--json"])).toMatchObject({ sub: "start", restart: false });
    expect(parse(["start", "--restart", "--json"])).toMatchObject({ sub: "start", restart: true });
  });

  it("director start refuses with session_stopped_by_user and never calls ensureUp", async () => {
    const { dir, identify } = await stoppedRepo();
    try {
      const ensureUp = vi.fn(async () => {});
      const { deps, out, ownerCall } = make({ identify, ensureUp });
      expect(await runDirectorCommand(parse(["start", "--json"]), deps)).toBe(1);
      const body = JSON.parse(out[0]!);
      expect(body).toMatchObject({ ok: false, code: "session_stopped_by_user" });
      expect(body.message).toContain("Người dùng đã dừng phiên");
      expect(body.fix).toContain("--restart");
      expect(ensureUp).not.toHaveBeenCalled();
      expect(ownerCall).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("director start --restart clears the intent and then calls ensureUp", async () => {
    const { dir, identify } = await stoppedRepo();
    try {
      let intentAtUp: unknown = "unset";
      const ensureUp = vi.fn(async () => { intentAtUp = await readUserStopIntent(dir, "repo-1", "bf-abc"); });
      const { deps } = make({ identify, ensureUp });
      expect(await runDirectorCommand(parse(["start", "--restart", "--json"]), deps)).toBe(0);
      expect(ensureUp).toHaveBeenCalledWith("/repo", { restart: true });
      expect(intentAtUp).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("director start refuses on a corrupt stop marker (safe direction)", async () => {
    const { dir } = await stoppedRepo();
    try {
      await writeFile(join(dir, ".bflow", "state", "user-stop.json"), "{broken");
      const ensureUp = vi.fn(async () => {});
      const { deps, out } = make({ identify: async () => ({ root: dir, sessionName: "bf-abc", id: "repo-1" }), ensureUp });
      expect(await runDirectorCommand(parse(["start", "--json"]), deps)).toBe(1);
      expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, code: "session_stopped_by_user" });
      expect(ensureUp).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("director start without an intent keeps calling ensureUp as before", async () => {
    const ensureUp = vi.fn(async () => {});
    const { deps } = make({ ensureUp });
    expect(await runDirectorCommand(parse(["start", "--json"]), deps)).toBe(0);
    expect(ensureUp).toHaveBeenCalledOnce();
  });

  it("runMcp turns a connection error into session_stopped_by_user when the user stopped the session", async () => {
    const { dir, identify } = await stoppedRepo();
    try {
      const toolCall = vi.fn(async () => { throw new Error("connect ENOENT /tmp/host.sock"); });
      let caught: unknown;
      const { deps } = make({ identify, toolCall: toolCall as never, runMcp: (async options => {
        try { await options.call("director_wait", tokenValue, { cursor: "m1" }); } catch (error) { caught = error; }
      }) as never });
      expect(await runDirectorCommand(parse(["mcp"]), deps)).toBe(0);
      expect((caught as Error).message).toMatch(/^session_stopped_by_user:/);
      expect((caught as Error).message).toContain("--restart");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("runMcp keeps the original connection error when the user did not stop the session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-nostop-"));
    try {
      let caught: unknown;
      const { deps } = make({ identify: async () => ({ root: dir, sessionName: "bf-abc", id: "repo-1" }),
        toolCall: (async () => { throw new Error("connect ENOENT /tmp/host.sock"); }) as never,
        runMcp: (async options => { try { await options.call("director_wait", tokenValue, {}); } catch (error) { caught = error; } }) as never });
      await runDirectorCommand(parse(["mcp"]), deps);
      expect((caught as Error).message).toBe("connect ENOENT /tmp/host.sock");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("runMcp does not rewrite non-connection errors even after a stop", async () => {
    const { dir, identify } = await stoppedRepo();
    try {
      let caught: unknown;
      const { deps } = make({ identify, toolCall: (async () => { throw new Error("Director token rejected"); }) as never,
        runMcp: (async options => { try { await options.call("inspect", tokenValue, {}); } catch (error) { caught = error; } }) as never });
      await runDirectorCommand(parse(["mcp"]), deps);
      expect((caught as Error).message).toBe("Director token rejected");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("runMcp refuses director_suspend after a stop without arming a watcher", async () => {
    const { dir, identify } = await stoppedRepo();
    try {
      const suspendWatch = vi.fn(async () => undefined);
      let caught: unknown;
      const { deps } = make({ identify, suspendWatch, runMcp: (async options => {
        try { await options.call("director_suspend", tokenValue, { cursor: "m4.i0.b2.rZmVlZA", threadId }); } catch (error) { caught = error; }
      }) as never });
      await runDirectorCommand(parse(["mcp"]), deps);
      expect((caught as Error).message).toMatch(/^session_stopped_by_user:/);
      expect(suspendWatch).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("director call reports session_stopped_by_user for a connection error after a stop", async () => {
    const { dir, identify } = await stoppedRepo();
    try {
      const { deps, out } = make({ identify, env: { BFLOW_DIRECTOR_TOKEN: tokenValue },
        toolCall: (async () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); }) as never });
      expect(await runDirectorCommand(parse(["call", "inspect", "--json", "{}"]), deps)).toBe(1);
      expect(JSON.parse(out[0]!).message).toMatch(/^session_stopped_by_user:/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("director suspend refuses after a stop", async () => {
    const { dir, identify } = await stoppedRepo();
    try {
      const suspendWatch = vi.fn(async () => undefined);
      const { deps, err } = make({ identify, suspendWatch, env: { BFLOW_DIRECTOR_TOKEN: tokenValue, CODEX_THREAD_ID: threadId } });
      expect(await runDirectorCommand(parse(["suspend", "m4.i0.b2.rZmVlZDox"]), deps)).toBe(1);
      expect(err.join("")).toContain("session_stopped_by_user");
      expect(suspendWatch).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("the watch command passes a stop probe that sees the intent", async () => {
    const { dir, identify } = await stoppedRepo();
    try {
      const watch = vi.fn(async (input: { stopped?: () => Promise<boolean> }) => { expect(await input.stopped?.()).toBe(true); });
      const { deps } = make({ identify, watch: watch as never, env: { BFLOW_DIRECTOR_TOKEN: tokenValue } });
      expect(await runDirectorCommand(parse(["watch", "123e4567-e89b-42d3-a456-426614174001"]), deps)).toBe(0);
      expect(watch).toHaveBeenCalledOnce();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("end to end: armed watcher, Web stop, stale wake, director_wait and director start all end without a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "director-e2e-stop-"));
    try {
      const identify = async () => ({ root: dir, sessionName: "bf-abc", id: "repo-1" });
      const state = await armCodexDirectorWatch({ root: dir, sessionName: "bf-abc", threadId, cursor: "m4.i0.b2.rZmVlZDox", spawn: async () => {} });
      // The user stops the session from Web: the intent is durable and the watcher is cancelled.
      await writeUserStopIntent(dir, { version: 1, repositoryId: "repo-1", sessionName: "bf-abc", source: "web", operationId: "op-1", requestedAt: new Date().toISOString() });
      await cancelCodexDirectorWatch(dir, "bf-abc");
      expect(await readCodexDirectorWatchStatus(dir, "bf-abc")).toBe("cancelled");
      // The old watcher process finds the session stopped and never queues a wake.
      let queued = 0;
      await runCodexDirectorWatch({ root: dir, sessionName: "bf-abc", generation: state.generation,
        stopped: async () => (await readUserStopIntent(dir, "repo-1", "bf-abc")) !== undefined,
        wait: async () => { throw new Error("connect ENOENT"); }, queue: async () => { queued++; }, delay: async () => {} });
      expect(queued).toBe(0);
      // A wake queued earlier still reaches the Director: director_wait learns the user stopped the session.
      let caught: unknown;
      const ensureUp = vi.fn(async () => {});
      const { deps: mcpDeps } = make({ identify, ensureUp, toolCall: (async () => { throw new Error("connect ENOENT /tmp/host.sock"); }) as never,
        runMcp: (async options => { try { await options.call("director_wait", tokenValue, { cursor: "m4" }); } catch (error) { caught = error; } }) as never });
      await runDirectorCommand(parse(["mcp"]), mcpDeps);
      expect((caught as Error).message).toMatch(/^session_stopped_by_user:/);
      // The Director then runs `director start` without --restart: refused, ensureUp never called.
      const { deps: startDeps, out } = make({ identify, ensureUp });
      expect(await runDirectorCommand(parse(["start", "--json"]), startDeps)).toBe(1);
      expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, code: "session_stopped_by_user" });
      expect(ensureUp).not.toHaveBeenCalled();

      // Explicit restart with --restart clears the stop intent and calls ensureUp({ restart: true })
      const { deps: restartDeps, out: restartOut } = make({ cwd: dir, identify, ensureUp });
      expect(await runDirectorCommand(parse(["start", "--restart", "--json"]), restartDeps)).toBe(0);
      expect(JSON.parse(restartOut[0]!)).toMatchObject({ ok: true });
      expect(ensureUp).toHaveBeenCalledWith(dir, { restart: true });
      expect(await readUserStopIntent(dir, "repo-1", "bf-abc")).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
