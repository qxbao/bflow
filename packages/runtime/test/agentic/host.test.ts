import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgenticHost } from "../../dist/agentic/host-controller.js";
import { callHost } from "../../src/agentic/host-protocol.js";
import { LAUNCH_REACHABILITY_DIRECTORY, readLaunchReachability } from "../../src/agentic/tool-reachability.js";
import { openSqliteRunStore } from "@bflow/persistence";
import { workflow } from "../../../specification/test/fixtures.js";
import { SessionManifestSchema } from "@bflow/contracts";
const execute = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture(beforeEnsure?: () => void) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-test-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "herdr-fixture.mjs");
  await writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false})+"\\n");\n', { mode: 0o700 });
  const options = { repositoryPath: root, sessionId: "test-host", herdrBinary: binary };
  beforeEnsure?.();
  const controller = await ensureAgenticHost(options);
  let stopped = false;
  const shutdown = async () => { if (!stopped) { await controller.shutdown(); stopped = true; } };
  cleanup.push(shutdown);
  return {root, controller, options, shutdown};
}
// Agentic host startup uses Linux flock; one recovery case also inspects /proc.
describe.skipIf(process.platform !== "linux")("default durable host lifecycle and role MCP", () => {
  it("keeps hook runners isolated between repositories sharing a session name", async () => {
    const first = await fixture(), second = await fixture();
    const runnerOf = async (controller: typeof first.controller) => {
      const launch = await controller.prepare();
      const hooks = JSON.parse(await readFile(launch.roleLaunch.conversation!.hooksSettingsFile, "utf8"));
      return hooks.hooks.SessionStart[0].hooks[0].command.match(/^'([^']+)'/)[1] as string;
    };
    const firstRunner = await runnerOf(first.controller), secondRunner = await runnerOf(second.controller);
    expect(firstRunner).not.toBe(secondRunner);
    expect(await readFile(firstRunner, "utf8")).toContain(first.root);
    expect(await readFile(secondRunner, "utf8")).toContain(second.root);
    await first.shutdown();
    expect(await readFile(secondRunner, "utf8")).toContain(second.root);
  });

  it("pins owner verification authority and installs a fail-closed native edit hook", async () => {
    const f = await fixture(), launch = await f.controller.prepare();
    const hooks = JSON.parse(await readFile(launch.roleLaunch.developer!.hooksSettingsFile, "utf8"));
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain("PreToolUse");
    const config = JSON.parse(await readFile(launch.roleLaunch.developer!.mcpConfigFile, "utf8"));
    const host = fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url));
    const denied = await new Promise<string>((accept, reject) => {
      const child = spawn(process.execPath, [host, "hook", config.mcpServers.bflow.args[2], "PreToolUse"],
        { env: { ...process.env, HERDR_PANE_ID: "unassigned-pane" }, stdio: ["pipe", "pipe", "pipe"] });
      let output = "", errors = "";
      child.stdout.on("data", chunk => output += String(chunk)); child.stderr.on("data", chunk => errors += String(chunk));
      child.once("error", reject); child.once("exit", code => code === 0 ? accept(output) : reject(new Error(errors)));
      child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "unassigned-session", tool_name: "Write", tool_input: { file_path: join(f.root, "source.js"), content: "escape" } }));
    });
    expect(JSON.parse(denied).hookSpecificOutput.permissionDecision).toBe("deny");
    await expect(ensureAgenticHost({ ...f.options, behavioralCommands: [{ id: "owner-unit", command: "owner:unit", executable: process.execPath,
      args: ["--test", "--test-reporter=tap", "test.cjs"], method: "unit_test", levels: ["unit"],
      testNames: ["target"], testPaths: ["test.cjs"], timeoutMs: 1000 }] })).rejects.toThrow("configuration");
  });
  it("uses a short private Unix socket directory when TMPDIR exceeds socket limits", async () => {
    const previous = process.env.TMPDIR;
    try {
      const f = await fixture(() => { process.env.TMPDIR = "/tmp/" + "profile-directory-".repeat(12); });
      const config = JSON.parse(await readFile(join(f.root, ".bflow/state/host", f.options.sessionId, "host.json"), "utf8"));
      expect(Buffer.byteLength(config.socketPath.replace(/\.sock$/, ".native.sock"))).toBeLessThanOrEqual(103);
      expect((await f.controller.runtime.findRuns({ limit: 1 })).ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    }
  });
  it("recognizes Core succeeded runs as terminal independently of SDLC completed status", async () => {
    const f = await fixture();
    expect((await f.controller.runtime.findRuns({ limit: 100 })).ok).toBe(true);
    const opened = openSqliteRunStore({ filename: join(f.root, ".bflow/state/agentic/runs.db") });
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      const definition = workflow(), at = new Date().toISOString();
      expect((await opened.value.create({ definition, snapshot: { runId: "terminal-run", workflowId: definition.id,
        workflowVersion: definition.version, status: "succeeded", createdAt: at, updatedAt: at, version: 10, lastEventSequence: 10,
        tasks: definition.tasks.map(task => ({ taskId: task.id, status: "succeeded", attempt: 1, attemptId: `${task.id}-attempt`,
          generation: 0, version: 2, startedAt: at, completedAt: at })) } }, "terminal-run")).ok).toBe(true);
      expect((await f.controller.quiesce()).ok).toBe(true);
    } finally { opened.value.close(); }
  });

  it("refuses to activate existing native panes which never loaded Bflow's launch-local hook", async () => {
    const f = await fixture(), at = new Date().toISOString();
    const manifest = SessionManifestSchema.parse({ schemaVersion: 2, sessionId: f.options.sessionId,
      workspaceRoot: f.root, projectName: "old-panes", herdrWorkspaceId: "w1", herdrTabId: "t1", status: "up",
      conversationSessionId: "chat-session", activeRunIds: [], attachTarget: { role: "conversation", paneId: "p1" },
      panes: ["conversation", "coordinator"].map((role, index) => ({ schemaVersion: 2, bindingId: `b${index}`,
        sessionId: f.options.sessionId, role, agentId: `agent${index}`, paneId: `p${index + 1}`, workspaceId: "w1", tabId: "t1",
        provider: "claude", agentKind: "claude", cwd: f.root, readOnlyWorkspace: true, permanent: true,
        session: { source: "herdr:claude", kind: "id", value: `old-native-${index}` }, isolationMode: "dedicated_pane", transportState: "idle", boundAt: at })),
      createdAt: at, updatedAt: at });
    const result = await f.controller.activate(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("launch-receipts");
  });

  it("recovers an owned host killed before activation without replacing role credentials", async () => {
    const f = await fixture();
    const launch = await f.controller.prepare();
    const directory = join(f.root, ".bflow/state/host", f.options.sessionId);
    const owner = JSON.parse(await readFile(join(directory, "owner.json"), "utf8"));
    const command = await readFile(`/proc/${owner.pid}/cmdline`, "utf8");
    expect(command).toContain(join(directory, "host.json"));
    process.kill(owner.pid, "SIGKILL");
    await expect.poll(() => {
      try { process.kill(owner.pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }, { timeout: 5000, interval: 20 }).toBe(true);
    const recovered = await ensureAgenticHost(f.options);
    expect(await recovered.prepare()).toEqual(launch);
    expect(JSON.parse(await readFile(join(directory, "owner.json"), "utf8")).pid).not.toBe(owner.pid);
    expect((await recovered.runtime.findRuns({ limit: 100 })).ok).toBe(true);
  });

  it("survives client disconnect, prepares private launch config before activation, and queries real SQLite", async () => {
    const f = await fixture();
    const first = await f.controller.prepare();
    expect(first.roleLaunch.coordinator!.systemPrompt).toContain("technical lead");
    const chatOriginal = await readFile(new URL("../../../../agents/chat/system-prompt.md", import.meta.url), "utf8");
    const coordinatorOriginal = await readFile(new URL("../../../../agents/coordinator/system-prompt.md", import.meta.url), "utf8");
    expect(first.roleLaunch.conversation!.systemPrompt).toContain(chatOriginal);
    expect(first.roleLaunch.coordinator!.systemPrompt).toContain(coordinatorOriginal);
    const config = JSON.parse(await readFile(first.roleLaunch.coordinator!.mcpConfigFile,"utf8"));
    expect(config.mcpServers.bflow.args[1]).toBe("mcp");
    await f.controller.close();
    const next = await ensureAgenticHost(f.options);
    expect(await next.prepare()).toEqual(first);
    expect(await next.runtime.findRuns({limit:100})).toEqual({ok:true,value:{items:[]}});
    const opened = openSqliteRunStore({filename:join(f.root,".bflow/state/agentic/runs.db")}); if (!opened.ok) throw new Error(opened.error.message);
    try {
      const definition = workflow();
      const at = new Date().toISOString();
      const created = await opened.value.create({definition, snapshot:{runId:"stored-run",workflowId:definition.id,workflowVersion:definition.version,status:"queued",
        tasks:definition.tasks.map(task=>({taskId:task.id,status:"pending",attempt:0,generation:0,version:0})),createdAt:at,updatedAt:at,version:0,lastEventSequence:0}},"stored-run");
      expect(created.ok).toBe(true);
      const actual = await next.runtime.getRun("stored-run");
      expect(actual.ok && actual.value?.runId).toBe("stored-run");
      expect(actual.ok && actual.value && "definition" in actual.value).toBe(false);
    } finally { opened.value.close(); }
    // An unresolved persisted Core run must never receive an invented quiesce receipt.
    expect((await next.quiesce()).ok).toBe(false);
  });
  it("registers role-filtered MCP tools before any SessionManifest exists and rejects role lifecycle escalation", async () => {
    const f = await fixture(), launches = await f.controller.prepare();
    const config = JSON.parse(await readFile(launches.roleLaunch.conversation!.mcpConfigFile,"utf8"));
    const args = config.mcpServers.bflow.args as string[];
    const result = await new Promise<string>((accept,reject)=> {
      const child = spawn(process.execPath,args,{stdio:["pipe","pipe","pipe"]}); let output="", errors="";
      child.stdout.on("data",chunk=>output+=String(chunk)); child.stderr.on("data",chunk=>errors+=String(chunk)); child.once("error",reject);
      child.once("exit",code=>code===0?accept(output):reject(new Error(errors)));
      child.stdin.end(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05"}})+"\n"+JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list"})+"\n");
    });
    const response=result.trim().split("\n").map(line=>JSON.parse(line));
    const names=response[1].result.tools.map((tool:{name:string})=>tool.name);
    expect(names).toContain("host_status"); expect(names).not.toContain("propose_workflow"); expect(names).not.toContain("approve");
    const roleConfig=JSON.parse(await readFile(args[2]!,"utf8"));
    await expect(callHost(roleConfig.socketPath,roleConfig.token,"quiesce")).rejects.toThrow("Role cannot call host lifecycle");
    await expect(callHost(roleConfig.socketPath,"forged-token","user_prompt",{hook:{prompt:"approve",hook_event_name:"UserPromptSubmit"}})).rejects.toThrow("authentication");
  });
  it("reports the actual Claude SessionStart through Herdr's native session API and ignores subagent hooks", async () => {
    const f=await fixture(), launches=await f.controller.prepare();
    const config=JSON.parse(await readFile(launches.roleLaunch.conversation!.mcpConfigFile,"utf8"));
    const path=config.mcpServers.bflow.args[2] as string;
    const socketPath=join(f.root,"native.sock"), packets:unknown[]=[];
    const server=createServer(socket=>socket.once("data",chunk=>{packets.push(JSON.parse(String(chunk)));socket.end(JSON.stringify({result:{accepted:true}})+"\n");}));
    await new Promise<void>(accept=>server.listen(socketPath,accept));
    cleanup.push(()=>new Promise<void>(accept=>server.close(()=>accept())));
    const host=fileURLToPath(new URL("../../dist/agentic/host.js",import.meta.url));
    const invoke=async (payload:unknown)=> {
      const child=spawn(process.execPath,[resolve(host),"hook",path,"SessionStart"],{env:{...process.env,HERDR_PANE_ID:"real-pane",HERDR_SOCKET_PATH:socketPath},stdio:["pipe","pipe","pipe"]});
      let error="";child.stderr.on("data",chunk=>error+=String(chunk));
      const done=new Promise<void>((accept,reject)=>{child.once("error",reject);child.once("exit",code=>code===0?accept():reject(new Error(error)));});
      child.stdin.end(JSON.stringify(payload));await done;
    };
    await invoke({hook_event_name:"SessionStart",session_id:"actual-session",transcript_path:"/actual/transcript.jsonl",source:"startup"});
    expect(packets).toEqual([expect.objectContaining({method:"pane.report_agent_session",params:expect.objectContaining({source:"herdr:claude",agent_session_id:"actual-session",agent_session_path:"/actual/transcript.jsonl"})})]);
    await invoke({hook_event_name:"SessionStart",session_id:"subagent-session",agent_id:"subagent"});
    expect(packets).toHaveLength(1);
  });
});

// Unix sockets and symlink rejection are POSIX features; this case does not start the flock-guarded host.
describe.skipIf(process.platform === "win32")("portable host path validation", () => {
  it("rejects a lost control acknowledgement and refuses symlinked state directories", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-boundary-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = join(root, "closed.sock"), server = createServer(socket => socket.once("data", () => socket.end()));
    await new Promise<void>(accept => server.listen(socketPath, accept));
    cleanup.push(() => new Promise<void>(accept => server.close(() => accept())));
    await expect(callHost(socketPath, "token", "ping")).rejects.toThrow("closed before acknowledgement");
    const outside = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-outside-")));
    cleanup.push(() => rm(outside, { recursive: true, force: true }));
    await symlink(outside, join(root, ".bflow"));
    await expect(ensureAgenticHost({ repositoryPath: root, sessionId: "boundary" })).rejects.toThrow("must not be symlinks");
  });
});


// P30 platform composition runs the real daemon: provider preflight, host-held signer and private state files.
describe.skipIf(process.platform !== "linux")("P30 platform host", () => {
  const option = (role: "conversation" | "coordinator" | "developer", provider: "claude" | "codex" | "agy", required: boolean) => ({
    role, provider, required, permissionMode: "restricted", capabilityIds: [], mcpServiceIds: [], toolIds: [], skillSelections: []
  });
  const platformFor = (root: string, overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 3, machineId: "machine-test", repositoryId: "repository-test",
    roles: [option("conversation", "codex", true), option("coordinator", "codex", true)],
    skillsStoreRoot: join(root, "skills-store"), approvedBuiltinSkillDigests: [], ...overrides
  });
  // Fake Herdr: answers `agent get <pane>` from agents/<pane>.json and reports the session as not running otherwise.
  const fakeHerdr = [
    "#!/usr/bin/env node",
    'import { readFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "const root = dirname(fileURLToPath(import.meta.url));",
    'const args = process.argv.slice(2); const rest = args[0] === "--session" ? args.slice(2) : args;',
    'if (rest[0] === "agent" && rest[1] === "get") process.stdout.write(JSON.stringify({ result: { agent: JSON.parse(readFileSync(join(root, "agents", rest[2] + ".json"), "utf8")) } }) + "\\n");',
    'else process.stdout.write(JSON.stringify({ running: false, socket: join(root, "herdr.sock") }) + "\\n");',
    ""
  ].join("\n");
  const fixture = async (platform?: (root: string) => Record<string, unknown>) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-host-platform-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, "herdr-fixture.mjs");
    await writeFile(binary, fakeHerdr, { mode: 0o700 });
    const base = { repositoryPath: root, sessionId: "platform-host", herdrBinary: binary };
    const config = platform === undefined ? base : { ...base, platform: platform(root) as never };
    const controller = await ensureAgenticHost(config);
    cleanup.push(() => controller.shutdown().catch(() => undefined));
    return { root, controller, config, directory: join(root, ".bflow/state/host", base.sessionId) };
  };

  it("keeps legacy hosts unchanged: no platform report and Claude role providers", async () => {
    const f = await fixture();
    expect(await f.controller.platformStatus()).toEqual({ report: null, status: { generation: null, launches: [] }, gatewayDiagnostic: null });
    expect(JSON.parse(await readFile(join(f.directory, "conversation.json"), "utf8")).provider).toBe("claude");
    const prepared = await f.controller.prepare();
    expect(prepared.platform).toBeUndefined();
    expect(Object.values(prepared.roleLaunch).every(launch => launch.launch === undefined)).toBe(true);
  });

  it("blocks prepare without launch material when a required provider is not ready, and persists codex role providers", async () => {
    const f = await fixture(root => platformFor(root));
    const prepared = await f.controller.prepare();
    expect(prepared.platform?.ready).toBe(false);
    expect(prepared.platform?.generation).toBe(1);
    expect(Object.values(prepared.roleLaunch).some(launch => launch.launch !== undefined)).toBe(false);
    expect(prepared.roleLaunch.conversation?.systemPrompt).toContain("Bflow's conversation");
    expect(JSON.parse(await readFile(join(f.directory, "conversation.json"), "utf8")).provider).toBe("codex");
    expect(JSON.parse(await readFile(join(f.directory, "developer.json"), "utf8")).provider).toBe("claude");
    const status = await f.controller.platformStatus();
    expect(status.report).toEqual(prepared.platform);
    expect(status.status).toEqual({ generation: 1, launches: [] });
    expect(status.gatewayDiagnostic).toBeNull();
    expect((await f.controller.prepare()).platform?.generation).toBe(2);
    // No bearer token or launch environment may reach any host file.
    for (const name of await readdir(f.directory)) {
      const content = await readFile(join(f.directory, name), "utf8").catch(() => "");
      expect(content).not.toContain("BFLOW_MCP_TOKEN_");
    }
  });

  it("rewrites a stopped host's platform in place, keeping its endpoint and token", async () => {
    const f = await fixture(root => platformFor(root));
    const before = JSON.parse(await readFile(join(f.directory, "host.json"), "utf8"));
    await f.controller.shutdown();
    const restarted = await ensureAgenticHost({ ...f.config, platform: platformFor(f.root, { machineId: "machine-other" }) } as never);
    cleanup.push(() => restarted.shutdown().catch(() => undefined));
    const after = JSON.parse(await readFile(join(f.directory, "host.json"), "utf8"));
    expect(after.platform.machineId).toBe("machine-other");
    expect(after.socketPath).toBe(before.socketPath);
    expect(after.token).toBe(before.token);
    expect(after.directory).toBe(before.directory);
    expect((await restarted.platformStatus()).report).toBeNull();
  });

  it("refuses to change the platform of a running host", async () => {
    const f = await fixture(root => platformFor(root));
    await expect(ensureAgenticHost({ ...f.config, platform: platformFor(f.root, { machineId: "machine-other" }) } as never))
      .rejects.toThrow("Persisted host platform differs; run bflow down before changing providers/roles");
  });

  it("requires a prepared platform launch for each required role before activation, and enforces the provider source", async () => {
    const f = await fixture(root => platformFor(root));
    const at = new Date().toISOString();
    const roles = ["conversation", "coordinator"] as const;
    await mkdir(join(f.root, "agents"), { recursive: true });
    for (const [index, role] of roles.entries()) {
      const pane = `p${index + 1}`, native = `native-${role}`;
      const token = JSON.parse(await readFile(join(f.directory, role + ".json"), "utf8"));
      await callHost(token.socketPath, token.token, "provider_started", { paneId: pane, nativeSessionId: native });
      await callHost(token.socketPath, token.token, "native_session", { paneId: pane, sessionId: native });
      await writeFile(join(f.root, "agents", pane + ".json"), JSON.stringify({ name: `${role}-agent`, agent_status: "idle",
        agent_session: { source: "herdr:codex", kind: "id", value: native } }));
    }
    const manifest = () => SessionManifestSchema.parse({ schemaVersion: 2, sessionId: f.config.sessionId,
      workspaceRoot: f.root, projectName: "platform", herdrWorkspaceId: "w1", herdrTabId: "t1", status: "up",
      conversationSessionId: "chat-session", activeRunIds: [], attachTarget: { role: "conversation", paneId: "p1" },
      panes: roles.map((role, index) => ({ schemaVersion: 2, bindingId: `b${index}`, sessionId: f.config.sessionId, role, agentId: `${role}-agent`,
        paneId: `p${index + 1}`, workspaceId: "w1", tabId: "t1", provider: "codex", agentKind: "codex", cwd: f.root, readOnlyWorkspace: true,
        permanent: true, session: { source: "herdr:codex", kind: "id", value: `native-${role}` }, isolationMode: "dedicated_pane",
        transportState: "idle", boundAt: at })),
      createdAt: at, updatedAt: at });
    // Herdr reports a Claude-native session for a Codex-provisioned pane: activation must refuse it.
    const agentFile = join(f.root, "agents", "p1.json");
    const reported = JSON.parse(await readFile(agentFile, "utf8"));
    await writeFile(agentFile, JSON.stringify({ ...reported, agent_session: { ...reported.agent_session, source: "herdr:claude" } }));
    const mismatch = await f.controller.activate(manifest());
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.message).toContain("has no matching Bflow provider startup/native-session receipt");
    await writeFile(agentFile, JSON.stringify(reported));
    const unprepared = await f.controller.activate(manifest());
    expect(unprepared.ok).toBe(false);
    if (!unprepared.ok) expect(unprepared.error.message).toContain("has no prepared launch in this host process");
  });

  // Codex does not fire SessionStart at startup: the MCP bootstrap receipt plus Herdr's observed native session prove startup.
  const codexRoles = ["conversation", "coordinator"] as const;
  const bootstrapReachability = [{ registrationId: "reg-bootstrap0001", envName: "BFLOW_MCP_TOKEN_REG_BOOTSTRAP0001", ok: true, discoveredTools: ["query"], code: null }];
  const codexManifest = (root: string, sessionId: string) => {
    const at = new Date().toISOString();
    return SessionManifestSchema.parse({ schemaVersion: 2, sessionId, workspaceRoot: root, projectName: "platform", herdrWorkspaceId: "w1", herdrTabId: "t1",
      status: "up", conversationSessionId: "chat-session", activeRunIds: [], attachTarget: { role: "conversation", paneId: "p1" },
      panes: codexRoles.map((role, index) => ({ schemaVersion: 2, bindingId: `b${index}`, sessionId, role, agentId: `${role}-agent`, paneId: `p${index + 1}`,
        workspaceId: "w1", tabId: "t1", provider: "codex", agentKind: "codex", cwd: root, readOnlyWorkspace: true, permanent: true,
        session: { source: "herdr:codex", kind: "id", value: `native-${role}` }, isolationMode: "dedicated_pane", transportState: "idle", boundAt: at })),
      createdAt: at, updatedAt: at });
  };
  const observeCodexPanes = async (root: string) => {
    await mkdir(join(root, "agents"), { recursive: true });
    for (const [index, role] of codexRoles.entries()) {
      await writeFile(join(root, "agents", `p${index + 1}.json`), JSON.stringify({ name: `${role}-agent`, agent_status: "idle",
        agent_session: { source: "herdr:codex", kind: "id", value: `native-${role}` } }));
    }
  };

  it.each(["herdr", "herdr:herdr", "herdr:claude"])("rejects native source %s for a Herdr-transported Codex pane", async source => {
    const f = await fixture(root => platformFor(root));
    await observeCodexPanes(f.root);
    for (const [index, role] of codexRoles.entries()) {
      const paneId = `p${index + 1}`, sessionId = `native-${role}`;
      const token = JSON.parse(await readFile(join(f.directory, role + ".json"), "utf8"));
      await callHost(token.socketPath, token.token, "provider_started", { paneId, nativeSessionId: sessionId });
      await callHost(token.socketPath, token.token, "native_session", { paneId, sessionId });
      const file = join(f.root, "agents", paneId + ".json");
      const agent = JSON.parse(await readFile(file, "utf8"));
      await writeFile(file, JSON.stringify({ ...agent, agent_session: { source, kind: "id", value: sessionId } }));
    }
    const manifest = codexManifest(f.root, f.config.sessionId);
    for (const pane of manifest.panes) { pane.provider = "herdr"; pane.session!.source = source; }
    const result = await f.controller.activate(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("has no matching Bflow provider startup/native-session receipt");
  });

  it("accepts a Codex pane proven by the MCP bootstrap and Herdr's observed native session, with no SessionStart receipt", async () => {
    const f = await fixture(root => platformFor(root));
    await observeCodexPanes(f.root);
    for (const [index, role] of codexRoles.entries()) {
      const token = JSON.parse(await readFile(join(f.directory, role + ".json"), "utf8"));
      await callHost(token.socketPath, token.token, "provider_bootstrap", { launchId: `launch-${role}`, paneId: `p${index + 1}`,
        toolReachability: bootstrapReachability, source: "mcp_bootstrap" });
    }
    const result = await f.controller.activate(codexManifest(f.root, f.config.sessionId));
    // Startup proof and native session are accepted; the refusal comes from the platform launch, which this fixture never prepares.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("has no prepared launch in this host process");
    expect(JSON.parse(await readFile(join(f.directory, "native-sessions.json"), "utf8"))).toMatchObject({
      p1: { role: "conversation", sessionId: "native-conversation" }, p2: { role: "coordinator", sessionId: "native-coordinator" } });
    expect((await f.controller.platformStatus()).startupProof).toEqual([
      { role: "conversation", paneId: "p1", launchId: "launch-conversation", startupSource: "mcp_bootstrap", reachabilitySource: "mcp_bootstrap" },
      { role: "coordinator", paneId: "p2", launchId: "launch-coordinator", startupSource: "mcp_bootstrap", reachabilitySource: "mcp_bootstrap" }]);
  });

  it("keeps a Codex pane pending when neither the SessionStart hook nor the MCP bootstrap has reported", async () => {
    const f = await fixture(root => platformFor(root));
    await observeCodexPanes(f.root);
    const result = await f.controller.activate(codexManifest(f.root, f.config.sessionId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("[bflow:native-startup-pending]");
    expect((await f.controller.platformStatus()).startupProof).toEqual([
      { role: "conversation", paneId: "p1", startupSource: "none", reachabilitySource: "none" },
      { role: "coordinator", paneId: "p2", startupSource: "none", reachabilitySource: "none" }]);
  });

  it("refuses a bootstrap receipt whose native session Herdr does not report as the manifest's Herdr session", async () => {
    const f = await fixture(root => platformFor(root));
    await observeCodexPanes(f.root);
    for (const [index, role] of codexRoles.entries()) {
      const token = JSON.parse(await readFile(join(f.directory, role + ".json"), "utf8"));
      await callHost(token.socketPath, token.token, "provider_bootstrap", { launchId: `launch-${role}`, paneId: `p${index + 1}`,
        toolReachability: bootstrapReachability, source: "mcp_bootstrap" });
    }
    const agentFile = join(f.root, "agents", "p1.json");
    const reported = JSON.parse(await readFile(agentFile, "utf8"));
    await writeFile(agentFile, JSON.stringify({ ...reported, agent_session: { source: "herdr:claude", kind: "id", value: "native-conversation" } }));
    const result = await f.controller.activate(codexManifest(f.root, f.config.sessionId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("has no matching Bflow provider startup/native-session receipt");
  });

  it("keeps the first all-ok reachability proof of a launch and records a later token revocation", async () => {
    const f = await fixture(root => platformFor(root));
    const token = JSON.parse(await readFile(join(f.directory, "conversation.json"), "utf8"));
    const send = (toolReachability: unknown) => callHost(token.socketPath, token.token, "provider_bootstrap",
      { launchId: "launch-precedence", paneId: "p1", toolReachability, source: "mcp_bootstrap" });
    const reachabilityDirectory = join(f.directory, LAUNCH_REACHABILITY_DIRECTORY);
    await send(bootstrapReachability);
    await send([{ ...bootstrapReachability[0], ok: false, discoveredTools: [], code: "token_env_missing" }]);
    expect((await readLaunchReachability(reachabilityDirectory, "launch-precedence"))?.reported.toolReachability).toEqual(bootstrapReachability);
    const revoked = [{ ...bootstrapReachability[0], ok: false, discoveredTools: [], code: "unauthorized" }];
    await send(revoked);
    expect((await readLaunchReachability(reachabilityDirectory, "launch-precedence"))?.reported.toolReachability).toEqual(revoked);
  });
});
