import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebDirectorLaunchOptionsSchema } from "@bflow/contracts";
import type { ProviderCommandRunner } from "@bflow/agent-providers";
import {
  DirectorLaunchError,
  assertDirectorLaunchAllowed,
  buildDirectorLaunchPlan,
  inspectDirectorLaunchOptions,
  launchDirectorPlan,
  parseOpenArgs,
  runOpenCommand,
  type DirectorLaunchDeps,
  type DirectorOpenDeps
} from "../src/director-open.js";
import { DIRECTOR_START_ARGS, sanitizeDirectorLaunchEnvironment, selectDirectorTerminal } from "../src/director-terminal.js";
import { detectProvider } from "../src/director-commands.js";

let base: string;
let repo: string;
let bin: string;

const project = () => ({ projectId: "project-abc", canonicalPath: repo });
const okRunner = (): ProviderCommandRunner & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, async run(inv) { calls.push(`${inv.executable} ${inv.args.join(" ")}`); return { exitCode: 0, stdout: "1.2.3\n", stderr: "", started: true }; } };
};

async function exe(name: string, body = "exit 0"): Promise<string> {
  const file = join(bin, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

function deps(over: Partial<DirectorLaunchDeps> = {}): DirectorLaunchDeps {
  return {
    platform: "linux",
    env: { DISPLAY: ":0", PATH: bin },
    pathEntries: [bin],
    runner: okRunner(),
    isWsl: async () => false,
    checkSkill: async () => "current",
    versionCache: new Map(),
    now: () => new Date("2026-11-04T10:00:00.000Z"),
    earlyExitWindowMs: 300,
    ...over
  };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "bfo-")));
  repo = join(base, "my repo $HOME 'q'");
  bin = join(base, "bin");
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  await exe("claude"); await exe("codex"); await exe("xterm"); await exe("env", 'exec "$@"');
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

describe("provider start arguments", () => {
  it("uses the exact fixed /bflow-start prompt per provider", () => {
    expect(DIRECTOR_START_ARGS.claude).toEqual(["--dangerously-skip-permissions", "/bflow-start"]);
    expect(DIRECTOR_START_ARGS.codex).toEqual(["--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "$bflow-start"]);
    expect(DIRECTOR_START_ARGS.agy).toEqual(["-i", "/bflow-start"]);
  });
});

describe("environment sanitization", () => {
  it("drops Herdr/Orca/isolator/nested provider context and Bflow credentials, keeps user config, adds a scoped provider hint", () => {
    const env = sanitizeDirectorLaunchEnvironment({
      PATH: "/usr/bin", HOME: "/home/u", ANTHROPIC_API_KEY: "k", CODEX_HOME: "/home/u/.codex", BFLOW_HOME: "/b",
      HERDR_PANE_ID: "p1", HERDR_SESSION: "s", HERDR_CONFIG_PATH: "/c", ORCA_PANE_KEY: "o", AI_ISOLATOR_PROFILE: "x",
      CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CODEX_SANDBOX: "seatbelt", CODEX_THREAD_ID: "t", ANTIGRAVITY_AGENT: "1", AGY_SESSION: "a",
      BFLOW_DIRECTOR_TOKEN: "tid.secretsecretsecretsecret", BFLOW_MCP_TOKEN_X: "t", BFLOW_ROLE: "developer", BFLOW_RUN_ID: "r", UNDEF: undefined
    }, "codex");
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", ANTHROPIC_API_KEY: "k", CODEX_HOME: "/home/u/.codex", BFLOW_HOME: "/b", BFLOW_DIRECTOR_PROVIDER: "codex" });
  });

  it("detectProvider honours only a valid scoped launcher hint", () => {
    expect(detectProvider({ BFLOW_DIRECTOR_PROVIDER: "agy", CLAUDECODE: "1" })).toBe("agy");
    expect(detectProvider({ BFLOW_DIRECTOR_PROVIDER: "evil", CLAUDECODE: "1" })).toBe("claude");
    expect(detectProvider({ BFLOW_DIRECTOR_PROVIDER: "codex" })).toBe("codex");
  });
});

describe("terminal selection", () => {
  const found = (names: string[]) => async (name: string) => names.includes(name) ? `/usr/bin/${name}` : null;
  it("Linux picks the first available known terminal by executable availability", async () => {
    const t = await selectDirectorTerminal({ platform: "linux", env: { DISPLAY: ":0" }, isWsl: async () => false, find: found(["xterm", "konsole"]) });
    expect(t).toEqual({ available: true, kind: "konsole", executable: "/usr/bin/konsole" });
  });
  it("Linux without DISPLAY/WAYLAND is manual", async () => {
    const t = await selectDirectorTerminal({ platform: "linux", env: {}, isWsl: async () => false, find: found(["gnome-terminal"]) });
    expect(t.available).toBe(false);
  });
  it("Linux Wayland only is enough", async () => {
    const t = await selectDirectorTerminal({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, isWsl: async () => false, find: found(["foot"]) });
    expect(t).toMatchObject({ available: true, kind: "foot" });
  });
  it("SSH session is manual on every platform", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const t = await selectDirectorTerminal({ platform, env: { DISPLAY: ":0", SSH_CONNECTION: "1 2 3 4" }, isWsl: async () => false, find: found(["xterm", "osascript"]) });
      expect(t.available).toBe(false);
    }
  });
  it("Linux with display but no known terminal is manual", async () => {
    const t = await selectDirectorTerminal({ platform: "linux", env: { DISPLAY: ":0" }, isWsl: async () => false, find: found([]) });
    expect(t.available).toBe(false);
  });
  it("macOS uses osascript Terminal; missing osascript is manual", async () => {
    expect(await selectDirectorTerminal({ platform: "darwin", env: {}, isWsl: async () => false, find: found(["osascript"]) }))
      .toEqual({ available: true, kind: "macos_terminal", executable: "/usr/bin/osascript" });
    expect((await selectDirectorTerminal({ platform: "darwin", env: {}, isWsl: async () => false, find: found([]) })).available).toBe(false);
  });
  it("WSL prefers wt.exe + wsl.exe, otherwise falls back to Linux desktop or manual", async () => {
    expect(await selectDirectorTerminal({ platform: "linux", env: {}, isWsl: async () => true, find: found(["wt.exe", "wsl.exe"]) }))
      .toMatchObject({ available: true, kind: "windows_terminal" });
    expect((await selectDirectorTerminal({ platform: "linux", env: {}, isWsl: async () => true, find: found(["xterm"]) })).available).toBe(false);
    expect(await selectDirectorTerminal({ platform: "linux", env: { DISPLAY: ":0" }, isWsl: async () => true, find: found(["xterm"]) }))
      .toMatchObject({ available: true, kind: "xterm" });
  });
  it("unknown/native Windows platforms are manual", async () => {
    expect((await selectDirectorTerminal({ platform: "win32", env: {}, isWsl: async () => false, find: found(["wt.exe"]) })).available).toBe(false);
    expect((await selectDirectorTerminal({ platform: "freebsd", env: { DISPLAY: ":0" }, isWsl: async () => false, find: found(["xterm"]) })).available).toBe(false);
  });
});

describe("buildDirectorLaunchPlan", () => {
  it("builds shell-free argv with the canonical cwd and a correctly quoted manual command (spaces, $, quotes)", async () => {
    const plan = await buildDirectorLaunchPlan(project(), "codex", deps({ findTerminal: async () => ({ available: true, kind: "xterm", executable: "/usr/bin/xterm" }) }));
    expect(plan.cwd).toBe(repo);
    expect(plan.argv).toEqual([join(bin, "codex"), "--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "$bflow-start"]);
    expect(plan.manualCommand).toBe(`cd '${repo.replace(/'/g, "'\\''")}' && BFLOW_DIRECTOR_PROVIDER=codex 'codex' '--no-daemon' '--dangerously-bypass-approvals-and-sandbox' '$bflow-start'`);
    expect(plan.terminal).toEqual({ kind: "xterm", executable: "/usr/bin/xterm", args: ["-e", join(bin, "env"), "BFLOW_DIRECTOR_PROVIDER=codex", join(bin, "codex"), "--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "$bflow-start"] });
    expect(plan.env.BFLOW_DIRECTOR_PROVIDER).toBe("codex");
    // The manual command round-trips through a POSIX shell to exactly the planned words.
    const { execFileSync } = await import("node:child_process");
    const echoed = execFileSync("/bin/sh", ["-c", plan.manualCommand.replace(/ && BFLOW_DIRECTOR_PROVIDER=codex 'codex'/, " && printf '%s\\n' \"$PWD\" ")], { env: { PATH: "/usr/bin:/bin" } }).toString();
    expect(echoed).toBe(`${repo}\n--no-daemon\n--dangerously-bypass-approvals-and-sandbox\n$bflow-start\n`);
  });

  it("uses only the requested invocation flags without login, install, hook trust or credential changes", async () => {
    for (const provider of ["claude", "codex"] as const) {
      const plan = await buildDirectorLaunchPlan(project(), provider, deps({ env: { DISPLAY: ":0", BFLOW_DIRECTOR_TOKEN: "tid.secretsecretsecretsecret" } }));
      const words = [...plan.argv, ...(plan.terminal?.args ?? []), plan.manualCommand].join(" ");
      expect(words).not.toMatch(/--yolo|login|install|trust|full-auto|secretsecret/);
      expect(plan.argv.slice(1)).toEqual(provider === "codex"
        ? ["--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "$bflow-start"]
        : ["--dangerously-skip-permissions", "/bflow-start"]);
      expect(Object.keys(plan.env)).not.toContain("BFLOW_DIRECTOR_TOKEN");
    }
  });

  it("macOS plan passes the quoted command line as an osascript argv item, not inside AppleScript source", async () => {
    const plan = await buildDirectorLaunchPlan(project(), "claude", deps({ platform: "darwin", findTerminal: async () => ({ available: true, kind: "macos_terminal", executable: "/usr/bin/osascript" }) }));
    const args = plan.terminal!.args;
    const line = args[args.length - 1]!;
    expect(line).toBe(`cd '${repo.replace(/'/g, "'\\''")}' && BFLOW_DIRECTOR_PROVIDER=claude '${join(bin, "claude")}' '--dangerously-skip-permissions' '/bflow-start'`);
    expect(args.slice(0, -1).join(" ")).not.toContain(repo);
  });

  it("WSL plan uses wsl.exe --exec and falls back to manual when an argument contains ';'", async () => {
    const wt = async () => ({ available: true as const, kind: "windows_terminal" as const, executable: "/mnt/c/wt.exe" });
    const plan = await buildDirectorLaunchPlan(project(), "claude", deps({ env: { WSL_DISTRO_NAME: "Ubuntu" }, findTerminal: wt }));
    if (repo.includes(";")) throw new Error("fixture");
    expect(plan.terminal!.args).toEqual(["new-tab", "wsl.exe", "-d", "Ubuntu", "--cd", repo, "--exec", join(bin, "env"), "BFLOW_DIRECTOR_PROVIDER=claude", join(bin, "claude"), "--dangerously-skip-permissions", "/bflow-start"]);
    const semi = join(base, "a;b");
    await mkdir(semi, { recursive: true });
    const p2 = await buildDirectorLaunchPlan({ projectId: "p", canonicalPath: semi }, "claude", deps({ findTerminal: wt }));
    expect(p2.terminal).toBeUndefined();
    expect(p2.terminalUnavailableReason).toMatch(/;/);
  });

  it("no desktop yields a plan without terminal (manual only)", async () => {
    const plan = await buildDirectorLaunchPlan(project(), "claude", deps({ env: {} }));
    expect(plan.terminal).toBeUndefined();
    expect(plan.terminalUnavailableReason).toBeTruthy();
  });

  it.each([
    ["codex", ["--no-daemon", "--dangerously-bypass-approvals-and-sandbox", "$bflow-start"]],
    ["claude", ["--dangerously-skip-permissions", "/bflow-start"]]
  ] as const)("the %s manual command delivers the launch flags and literal prompt to the executable", async (provider, expected) => {
    const captureBin = await mkdtemp(join(base, "capture-"));
    const executable = join(captureBin, provider);
    await writeFile(executable, '#!/bin/sh\nprintf \'%s\\n\' "$BFLOW_DIRECTOR_PROVIDER" "$@"\n', { mode: 0o755 });
    const plan = await buildDirectorLaunchPlan(project(), provider, deps({ env: {}, pathEntries: [captureBin] }));
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync("/bin/sh", ["-c", plan.manualCommand], { env: { PATH: captureBin } }).toString();
    expect(output.trimEnd().split("\n")).toEqual([provider, ...expected]);
  });

  it("refuses a non-canonical repository path and a missing provider binary or skill", async () => {
    const link = join(base, "link");
    await symlink(repo, link).catch(() => {});
    await expect(buildDirectorLaunchPlan({ projectId: "p", canonicalPath: link }, "claude", deps()))
      .rejects.toMatchObject({ code: "repository_invalid" });
    await expect(buildDirectorLaunchPlan(project(), "agy", deps())).rejects.toMatchObject({ code: "provider_unavailable" });
    await expect(buildDirectorLaunchPlan(project(), "claude", deps({ checkSkill: async () => "missing" }))).rejects.toMatchObject({ code: "skill_missing" });
  });
});

describe("inspectDirectorLaunchOptions", () => {
  it("returns a contract-valid options object: missing binary unavailable, never 'ready' from install alone", async () => {
    const runner = okRunner();
    const options = await inspectDirectorLaunchOptions(project(), deps({ runner }));
    expect(WebDirectorLaunchOptionsSchema.parse(options)).toEqual(options);
    const by = Object.fromEntries(options.providers.map(p => [p.provider, p]));
    expect(by.claude!.state).toBe("available");
    expect(by.codex!.state).toBe("unverified");
    expect(by.codex!.reason).toMatch(/chưa kiểm/i);
    expect(by.agy!.state).toBe("unavailable");
    expect(by.agy!.manualCommand).toContain("'agy' '-i' '/bflow-start'");
    expect(options.terminal.available).toBe(true);
    expect(options.observedAt).toBe("2026-11-04T10:00:00.000Z");
    // Only bounded version probes, never a model probe.
    expect(runner.calls.every(c => c.endsWith(" --version"))).toBe(true);
  });

  it("version timeout is unverified, version is cached, skill missing is unavailable", async () => {
    const calls: number[] = [];
    const runner: ProviderCommandRunner = { async run(inv) { calls.push(inv.timeoutMs ?? -1); return { exitCode: null, stdout: "", stderr: "", started: true, failure: "timeout" }; } };
    const options = await inspectDirectorLaunchOptions(project(), deps({ runner }));
    expect(options.providers.find(p => p.provider === "claude")).toMatchObject({ state: "unverified" });
    expect(calls.every(t => t > 0 && t <= 5000)).toBe(true);

    const cache = new Map();
    const counted = okRunner();
    await inspectDirectorLaunchOptions(project(), deps({ runner: counted, versionCache: cache }));
    await inspectDirectorLaunchOptions(project(), deps({ runner: counted, versionCache: cache }));
    expect(counted.calls.length).toBe(2); // claude + codex once each

    const noSkill = await inspectDirectorLaunchOptions(project(), deps({ checkSkill: async () => "missing" }));
    expect(noSkill.providers.find(p => p.provider === "claude")).toMatchObject({ state: "unavailable" });
    expect(noSkill.providers.find(p => p.provider === "claude")!.reason).toMatch(/bflow init --update/);
  });

  it("no desktop reports terminal unavailable with a reason", async () => {
    const options = await inspectDirectorLaunchOptions(project(), deps({ env: {} }));
    expect(options.terminal.available).toBe(false);
    expect(options.terminal.reason).toBeTruthy();
  });
});

describe("presence guard", () => {
  it("active/waiting/unknown need replaceActive; absent and stopped host do not (no kill semantics)", () => {
    for (const presence of ["active", "waiting", "unknown"] as const) {
      expect(() => assertDirectorLaunchAllowed(presence, false)).toThrow(DirectorLaunchError);
      expect(() => assertDirectorLaunchAllowed(presence, true)).not.toThrow();
    }
    expect(() => assertDirectorLaunchAllowed("absent", false)).not.toThrow();
    expect(() => assertDirectorLaunchAllowed("host_stopped", false)).not.toThrow();
  });
});

describe("launchDirectorPlan", () => {
  const plan = async (terminalExe: string | null) => buildDirectorLaunchPlan(project(), "claude", deps({
    findTerminal: async () => terminalExe === null ? { available: false, reason: "no desktop" } : { available: true, kind: "xterm", executable: terminalExe }
  }));

  it("manual_command without a terminal never spawns", async () => {
    const spawn = vi.fn();
    const r = await launchDirectorPlan(await plan(null), { presence: "absent", deps: deps({ spawn: spawn as never }) });
    expect(r).toMatchObject({ mode: "manual_command", launchedAt: "2026-11-04T10:00:00.000Z" });
    expect(r.manualCommand).toContain("'/bflow-start'");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses an active Director before any effect", async () => {
    const spawn = vi.fn();
    await expect(launchDirectorPlan(await plan("/usr/bin/xterm"), { presence: "active", deps: deps({ spawn: spawn as never }) }))
      .rejects.toMatchObject({ code: "director_active" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("cancelled before spawn opens nothing", async () => {
    const spawn = vi.fn(); const controller = new AbortController(); controller.abort();
    await expect(launchDirectorPlan(await plan("/usr/bin/xterm"), { presence: "absent", signal: controller.signal, deps: deps({ spawn: spawn as never }) }))
      .rejects.toMatchObject({ code: "launch_cancelled" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("a long-lived terminal is terminal_opened and spawned detached, shell-free, stdio ignored, sanitized env", async () => {
    const marker = join(base, "args.txt");
    const term = await exe("term-ok", `printf '%s\\n' "$PWD" "$@" "$HERDR_PANE_ID" "$BFLOW_DIRECTOR_PROVIDER" > '${marker}'; /bin/sleep 5`);
    const p = await plan(term);
    const r = await launchDirectorPlan(p, { presence: "absent", deps: deps({ env: { DISPLAY: ":0", HERDR_PANE_ID: "pane" }, earlyExitWindowMs: 1500 }) });
    expect(r.mode).toBe("terminal_opened");
    await vi.waitFor(async () => expect((await readFile(marker, "utf8")).split("\n")).toEqual(
      [repo, "-e", join(bin, "env"), "BFLOW_DIRECTOR_PROVIDER=claude", join(bin, "claude"), "--dangerously-skip-permissions", "/bflow-start", "", "claude", ""]));
  });

  it("checks spawn options", async () => {
    const calls: unknown[][] = [];
    const { EventEmitter } = await import("node:events");
    const spawn = (...a: unknown[]) => { calls.push(a); const c = new EventEmitter() as EventEmitter & { unref(): void }; c.unref = () => {}; setImmediate(() => c.emit("spawn")); return c; };
    await launchDirectorPlan(await plan("/usr/bin/xterm"), { presence: "absent", deps: deps({ spawn: spawn as never, earlyExitWindowMs: 10 }) });
    expect(calls).toHaveLength(1);
    expect(calls[0]![2]).toMatchObject({ cwd: repo, detached: true, stdio: "ignore", shell: false });
  });

  it("a terminal client that exits 0 quickly (handoff) is terminal_opened", async () => {
    const term = await exe("term-handoff", "exit 0");
    expect((await launchDirectorPlan(await plan(term), { presence: "absent", deps: deps() })).mode).toBe("terminal_opened");
  });

  it("an early non-zero exit is uncertain: typed error with manual command, spawned exactly once, never retried", async () => {
    const counter = join(base, "count.txt");
    const term = await exe("term-fail", `echo x >> '${counter}'; exit 3`);
    // A wide window: macOS may delay the first exec of a freshly written file.
    const err = await launchDirectorPlan(await plan(term), { presence: "absent", deps: deps({ earlyExitWindowMs: 5000 }) }).catch(e => e);
    expect(err).toBeInstanceOf(DirectorLaunchError);
    expect(err).toMatchObject({ code: "launch_uncertain" });
    expect(err.manualCommand).toContain("/bflow-start");
    await new Promise(r => setTimeout(r, 200));
    expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("a spawn error before start (missing terminal binary) is not opened and falls back to manual without retrying other terminals", async () => {
    const r = await launchDirectorPlan(await plan(join(bin, "does-not-exist")), { presence: "absent", deps: deps() });
    expect(r.mode).toBe("manual_command");
  });

  it("a concurrent duplicate launch for the same repository is refused while the first is in flight", async () => {
    const term = await exe("term-slow", "/bin/sleep 5");
    const p = await plan(term);
    const first = launchDirectorPlan(p, { presence: "absent", deps: deps({ earlyExitWindowMs: 1500 }) });
    await expect(launchDirectorPlan(p, { presence: "absent", deps: deps() })).rejects.toMatchObject({ code: "launch_in_progress" });
    expect((await first).mode).toBe("terminal_opened");
  });
});

describe("bflow open", () => {
  it("parses flags", () => {
    expect(parseOpenArgs([])).toEqual({ ok: true, value: { provider: undefined, replaceActive: false, json: false, help: false } });
    expect(parseOpenArgs(["--provider", "codex", "--replace-active", "--json"])).toEqual({ ok: true, value: { provider: "codex", replaceActive: true, json: true, help: false } });
    expect(parseOpenArgs(["--provider", "x"]).ok).toBe(false);
    expect(parseOpenArgs(["--command", "rm"]).ok).toBe(false);
  });

  function openDeps(over: Partial<DirectorOpenDeps> = {}) {
    const out: string[] = []; const err: string[] = [];
    const d: DirectorOpenDeps = {
      cwd: repo,
      identify: async () => ({ root: repo, projectId: "project-abc" }),
      readPresence: async () => "absent",
      launch: deps({ env: {} }),
      stdout: { write: c => { out.push(c); } },
      stderr: { write: c => { err.push(c); } },
      ...over
    };
    return { d, out, err };
  }

  it("prints the manual command when no terminal is available, picking the first available provider", async () => {
    const { d, out } = openDeps();
    expect(await runOpenCommand({ provider: undefined, replaceActive: false, json: true, help: false }, d)).toBe(0);
    const res = JSON.parse(out.join(""));
    expect(res).toMatchObject({ ok: true, mode: "manual_command", provider: "claude" });
    expect(res.manualCommand).toContain("'claude' '--dangerously-skip-permissions' '/bflow-start'");
    expect(JSON.stringify(res)).not.toMatch(/token/i);
  });

  it("refuses an active Director without --replace-active, and explains how to confirm", async () => {
    const { d, out, err } = openDeps({ readPresence: async () => "waiting" });
    expect(await runOpenCommand({ provider: "claude", replaceActive: false, json: false, help: false }, d)).not.toBe(0);
    // Text-mode errors go to stderr (like usage errors); stdout stays empty.
    expect(err.join("")).toMatch(/--replace-active/);
    expect(out.join("")).toBe("");
    const ok = openDeps({ readPresence: async () => "waiting" });
    expect(await runOpenCommand({ provider: "claude", replaceActive: true, json: false, help: false }, ok.d)).toBe(0);
  });

  it("an automatically chosen unverified provider is announced with its reason on stderr", async () => {
    const runner: ProviderCommandRunner = { async run() { return { exitCode: null, stdout: "", stderr: "", started: true, failure: "timeout" }; } };
    const launch = deps({ env: {}, runner });
    const expected = (await inspectDirectorLaunchOptions(project(), deps({ env: {}, runner }))).providers.find(p => p.provider === "claude")!;
    expect(expected.state).toBe("unverified");
    const { d, out, err } = openDeps({ launch });
    expect(await runOpenCommand({ provider: undefined, replaceActive: false, json: false, help: false }, d)).toBe(0);
    expect(err.join("")).toContain("Chọn claude dù chưa xác minh được");
    expect(expected.reason).toBeTruthy(); expect(err.join("")).toContain(expected.reason!.replace(/\.$/, ""));
    expect(out.join("")).toContain("'claude' '--dangerously-skip-permissions' '/bflow-start'");
  });

  it("reports an unavailable provider with its reason", async () => {
    const { d, out } = openDeps();
    expect(await runOpenCommand({ provider: "agy", replaceActive: false, json: true, help: false }, d)).not.toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: false, code: "provider_unavailable" });
  });
});

describe('explicit ai-isolator Director selection',()=>{
 it('launches the requested existing profile through ai-isolator instead of the native provider',async()=>{
  const state=join(base,'isolator'),profile=join(state,'profiles','codex--work');
  for(const name of ['home','config','cache','data','state','tmp'])await mkdir(join(profile,name),{recursive:true,mode:0o700});
  await chmod(profile,0o700);await writeFile(join(profile,'profile.env'),'AI_ISOLATOR_TOOL=codex\nAI_ISOLATOR_PROFILE=work\n',{mode:0o600});
  const helper=await exe('ai-isolator');
  const selected=deps({env:{PATH:bin,DISPLAY:':0',HOME:base,AI_ISOLATOR_HOME:state},...{profileName:'work'}} as Partial<DirectorLaunchDeps>);
  const plan=await buildDirectorLaunchPlan(project(),'codex',selected);
  expect(plan.argv).toEqual([helper,'run','codex','--name','work','--',...DIRECTOR_START_ARGS.codex]);
  expect(plan.manualCommand).toContain("'--name' 'work'");
  expect(plan.terminal?.args).toContain('AI_ISOLATOR_HOME='+state);
  expect(plan.env.AI_ISOLATOR_HOME).toBe(state);
 });
 it('refuses a missing selected profile without silently launching native',async()=>{
  const selected=deps({env:{PATH:bin,DISPLAY:':0',HOME:base,AI_ISOLATOR_HOME:join(base,'isolator')},...{profileName:'missing'}} as Partial<DirectorLaunchDeps>);
  await expect(buildDirectorLaunchPlan(project(),'codex',selected)).rejects.toMatchObject({code:'profile_unavailable'});
 });
});

it('revalidates a profile immediately before terminal dispatch and refuses drift',async()=>{
 const state=join(base,'isolator-drift'),profile=join(state,'profiles','codex--work');
 for(const name of ['home','config','cache','data','state','tmp'])await mkdir(join(profile,name),{recursive:true,mode:0o700});
 await chmod(profile,0o700);const metadata=join(profile,'profile.env');await writeFile(metadata,'AI_ISOLATOR_TOOL=codex\nAI_ISOLATOR_PROFILE=work\n',{mode:0o600});
 const selected=deps({env:{PATH:bin,DISPLAY:':0',HOME:base,AI_ISOLATOR_HOME:state},profileName:'work'});
 const plan=await buildDirectorLaunchPlan(project(),'codex',selected);const spawn=vi.fn();
 await writeFile(metadata,'AI_ISOLATOR_TOOL=claude\nAI_ISOLATOR_PROFILE=work\n');
 await expect(launchDirectorPlan(plan,{presence:'absent',deps:{...selected,spawn:spawn as never}})).rejects.toMatchObject({code:'profile_unavailable'});
 expect(spawn).not.toHaveBeenCalled();
});
it('parses an explicit profile only with a provider and refuses path injection',()=>{
 expect(parseOpenArgs(['--provider','codex','--profile','personal'])).toMatchObject({ok:true,value:{provider:'codex',profileName:'personal'}});
 expect(parseOpenArgs(['--profile','personal'])).toMatchObject({ok:false});
 expect(parseOpenArgs(['--provider','codex','--profile','../personal'])).toMatchObject({ok:false});
});
