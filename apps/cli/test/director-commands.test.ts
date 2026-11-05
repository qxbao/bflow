import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseDirectorArgs, runDirectorCommand, runDirectorHookSafely, detectProvider, defaultDirectorDeps, type DirectorCommandDeps } from "../src/director-commands.js";

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
