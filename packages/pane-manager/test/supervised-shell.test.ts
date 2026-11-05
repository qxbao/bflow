import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createRolePaneManager } from "../src/role-pane-manager.js";
import { InMemorySessionManifestStore } from "../src/manifest-store.js";
import type { AgentLaunchProfile, CommandInvocation, CommandOutcome, HerdrCommandRunner } from "../src/types.js";

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function eventuallyFile(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try { return await readFile(path, "utf8"); } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  throw new Error(`No shell output at ${path}`);
}

class ShellHerdr implements HerdrCommandRunner {
  readonly calls: CommandInvocation[] = [];
  failBootstrap = false;
  unknownBootstrap = false;
  deliverUnknown = false;
  bootstrapSent = false;
  changedIdentity: "terminal" | "pid" | "busy" | undefined;
  unsupportedShell = false;
  constructor(readonly child: ChildProcessWithoutNullStreams, readonly proof: string) {}
  async run(invocation: CommandInvocation): Promise<CommandOutcome> {
    this.calls.push(invocation);
    const [domain, action] = invocation.args;
    const reply = (result: Record<string, unknown>) => ({ exitCode: 0, stdout: JSON.stringify({ id: "1", result }), stderr: "" });
    const changed = this.bootstrapSent ? this.changedIdentity : undefined;
    const pane = { pane_id: "pane-1", terminal_id: changed === "terminal" ? "replaced-terminal" : "term-1", workspace_id: "ws-1", tab_id: "tab-1", focused: false, agent: null, agent_status: "idle", revision: 1 };
    if (domain === "agent" && action === "list") return reply({ type: "agent_list", agents: [] });
    if (domain === "pane" && ["get", "rename"].includes(action!)) return reply({ type: "pane_info", pane });
    if (domain === "pane" && action === "process-info") {
      const shellPid = this.unsupportedShell ? process.pid : changed === "pid" ? this.child.pid! + 1 : this.child.pid;
      return reply({ type: "pane_process_info", process_info: {
        pane_id: "pane-1", shell_pid: shellPid,
        foreground_process_group_id: changed === "busy" ? this.child.pid! + 1 : shellPid, foreground_processes: []
      } });
    }
    if (domain === "pane" && action === "run") {
      this.bootstrapSent = true;
      if (!this.failBootstrap && (!this.unknownBootstrap || this.deliverUnknown)) this.child.stdin.write(invocation.args[3] + "\n");
      if (this.unknownBootstrap) return { exitCode: null, stdout: "", stderr: "", failure: "timeout", started: true };
      return reply({ type: "ok" });
    }
    if (domain === "agent" && action === "start") {
      this.child.stdin.write("codex\n");
      await eventuallyFile(this.proof);
      return reply({ type: "agent_started", agent: { ...pane, name: "dev-test", agent: "codex", interactive_ready: true,
        launch_pending: false, agent_session: { source: "herdr:codex", kind: "id", value: "native-1" } } });
    }
    throw new Error(`Unexpected command ${domain} ${action}`);
  }
}

async function fixture(shell: "bash" | "zsh", shadow = "all") {
  const root = await mkdtemp(join(tmpdir(), "bflow shell ' quoted-")); roots.push(root);
  const scopeId = randomUUID(), scope = join(root, scopeId), bin = join(scope, "bin"), startup = join(scope, "shell"), decoy = join(root, "decoy");
  for (const path of [scope, bin, startup, decoy]) await mkdir(path, { mode: 0o700 });
  const proof = join(root, "proof");
  for (const [path, value] of [[join(bin, "codex"), "supervised"], [join(decoy, "codex"), "bypass"]]) {
    await writeFile(path!, `#!/bin/sh\nprintf '%s' ${quote(value!)} > ${quote(proof)}\n`, { mode: 0o500 });
  }
  const hostile = [
    `export PATH=${quote(decoy)}:$PATH`,
    ...(shadow === "all" || shadow === "alias" ? [`alias codex=${quote(quote(join(decoy, "codex")))}`] : []),
    ...(shadow === "all" || shadow === "function" ? [`function codex() { ${quote(join(decoy, "codex"))}; }`] : []),
    ...(shell === "bash" ? [`hash -p ${quote(join(decoy, "codex"))} codex`, `PROMPT_COMMAND=${quote(`export PATH=${quote(decoy)}:$PATH`)}`] : [`precmd() { export PATH=${quote(decoy)}:$PATH; }`])
  ].join("\n");
  const rc = join(startup, shell === "bash" ? "hostile.bashrc" : ".zshrc");
  await writeFile(rc, hostile);
  const launch: AgentLaunchProfile = { provider: "codex", launchId: "launch-1", launchFingerprint: "fingerprint-1", argv: [], env: {
    PATH: `${bin}:/usr/bin:/bin`, HOME: root, ZDOTDIR: startup, BFLOW_PROCESS_SCOPE_ID: scopeId, BFLOW_MCP_TOKEN_DEV: "never-print-this-token"
  } };
  const child = spawn(shell === "bash" ? "/bin/bash" : "/usr/bin/zsh", shell === "bash" ? ["--noprofile", "--rcfile", rc, "-i"] : ["-d", "-i"], { env: { ...process.env, ...launch.env }, stdio: "pipe" });
  children.push(child); child.stdout.resume(); child.stderr.resume();
  const runner = new ShellHerdr(child, proof), store = new InMemorySessionManifestStore();
  const manager = () => createRolePaneManager({ config: { sessionId: "test-session", projectName: "test", workspaceRoot: root }, runner, store,
    worktreeInspector: { inspect: async () => ({ ok: true, value: { exists: false, isClean: true, dirtyFiles: [] } }) } });
  const request = { role: "developer" as const, paneId: "pane-1", workspaceId: "ws-1", tabId: "tab-1", cwd: root, agentName: "dev-test", agentKind: "codex", launch };
  return { root, scope, runner, manager, request, launch, proof, child };
}

describe.skipIf(process.platform !== "linux")("supervised provider shell startup", () => {
  it.each(["bash" as const, ...(existsSync("/usr/bin/zsh") ? ["zsh" as const] : [])])("executes the scope wrapper after hostile %s startup", async shell => {
    const f = await fixture(shell);
    const result = await f.manager().startAgentInPane(f.request);
    expect(result).toMatchObject({ ok: true });
    expect(await readFile(f.proof, "utf8")).toBe("supervised");
    expect(JSON.stringify(f.runner.calls)).not.toContain("never-print-this-token");
  });
  it("refuses an acknowledged bootstrap without a matching acknowledgement", async () => {
    const f = await fixture("bash"); f.runner.failBootstrap = true;
    const result = await f.manager().startAgentInPane(f.request);
    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.runner.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start")).toHaveLength(0);
  });
  it("never resends an uncertain bootstrap, including after manager reconstruction", async () => {
    const f = await fixture("bash"); f.runner.unknownBootstrap = true;
    expect(await f.manager().startAgentInPane(f.request)).toMatchObject({ ok: false });
    f.runner.unknownBootstrap = false;
    expect(await f.manager().startAgentInPane(f.request)).toMatchObject({ ok: false });
    expect(f.runner.calls.filter(call => call.args[0] === "pane" && call.args[1] === "run")).toHaveLength(1);
    expect(f.runner.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start")).toHaveLength(0);
  });
  it.each(["alias", "function", "path"])("restores canonical resolution despite provider %s shadowing", async shadow => {
    const f = await fixture("bash", shadow);
    expect(await f.manager().startAgentInPane(f.request)).toMatchObject({ ok: true });
    expect(await readFile(f.proof, "utf8")).toBe("supervised");
  });
  it("reconciles an executed bootstrap after lost acknowledgement without replay", async () => {
    const f = await fixture("bash"); f.runner.unknownBootstrap = true; f.runner.deliverUnknown = true;
    expect(await f.manager().startAgentInPane(f.request)).toMatchObject({ ok: false });
    f.runner.unknownBootstrap = false;
    expect(await f.manager().startAgentInPane(f.request)).toMatchObject({ ok: true });
    expect(f.runner.calls.filter(call => call.args[0] === "pane" && call.args[1] === "run")).toHaveLength(1);
    expect(await readFile(f.proof, "utf8")).toBe("supervised");
  });
  it.each(["terminal", "pid", "busy"] as const)("refuses native start when the %s changes after bootstrap", async change => {
    const f = await fixture("bash"); f.runner.changedIdentity = change;
    expect(await f.manager().startAgentInPane(f.request)).toMatchObject({ ok: false });
    expect(f.runner.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start")).toHaveLength(0);
  });
  it("fails closed for an unsupported shell executable", async () => {
    const f = await fixture("bash"); f.runner.unsupportedShell = true;
    expect(await f.manager().startAgentInPane(f.request)).toMatchObject({ ok: false });
    expect(f.runner.calls.filter(call => call.args[0] === "pane" && call.args[1] === "run")).toHaveLength(0);
    expect(f.runner.calls.filter(call => call.args[0] === "agent" && call.args[1] === "start")).toHaveLength(0);
  });
  it("rejects malformed scope fields before any Herdr side effect", async () => {
    const f = await fixture("bash");
    for (const env of [
      { ...f.launch.env, BFLOW_PROCESS_SCOPE_ID: "../scope" },
      { ...f.launch.env, PATH: "/usr/bin:/bin" },
      { ...f.launch.env, ZDOTDIR: "/tmp/unrelated" }
    ]) {
      expect(await f.manager().startAgentInPane({ ...f.request, launch: { ...f.launch, env } }))
        .toMatchObject({ ok: false, error: { code: "validation" } });
      expect(f.runner.calls).toHaveLength(0);
    }
  });
});
