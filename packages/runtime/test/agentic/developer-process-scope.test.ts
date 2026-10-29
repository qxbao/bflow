import { RolePaneManager } from "../../../pane-manager/src/role-pane-manager.js";
import { InMemorySessionManifestStore } from "../../../pane-manager/src/manifest-store.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DeveloperProcessScopes } from "../../src/agentic/developer-process-scope.js";
import { AgentExecutionHandleSchema, AgentRequestSchema, PaneBindingSchema, SessionManifestSchema } from "@bflow/contracts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function fixture(code: string, versioned = false) {
  const root = await mkdtemp(join(tmpdir(), "bflow-process-scope-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "original-bin"); await mkdir(bin);
  const provider = join(bin, "codex"); const script = `#!${process.execPath}\n${code}\n`;
  if(versioned){const binary=join(root,"2.1.312");await writeFile(binary,script,{mode:0o700});await symlink(binary,provider);}
  else await writeFile(provider, script, { mode: 0o700 });
  const manager = new DeveloperProcessScopes({ directory: join(root, "scopes") });
  const wrapped = await manager.prepare({ runId: "run-1", taskId: "run-1-task-1", executable: provider, executableDigest: hash(script), configFiles: [],
    material: { provider: "codex", argv: [], env: { PATH: bin + ":" + process.env.PATH }, launchId: "launch-1", launchFingerprint: "a".repeat(64) } });
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "binding-dev", sessionId: "session-1", role: "developer", paneGroup: "developer_worktree",
    agentId: "dev-1", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2", terminalId: "terminal-1", provider: "herdr", agentKind: "codex", cwd: root,
    worktreePath: root, session: { source: "herdr:codex", kind: "id", value: "native-1" }, isolationMode: "dedicated_pane", readOnlyWorkspace: false,
    transportState: "idle", boundAt: new Date().toISOString(), metadata: { processScopeId: wrapped.env.BFLOW_PROCESS_SCOPE_ID, runId: "run-1", taskId: "run-1-task-1", launchId: "launch-1", launchFingerprint: "a".repeat(64) } });
  const handle = AgentExecutionHandleSchema.parse({ executionId: "exec-1", requestId: "req-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1",
    idempotencyKey: "req-1", target: { transport: "herdr", agentId: binding.agentId, workspaceId: binding.workspaceId, tabId: binding.tabId,
      paneId: binding.paneId, terminalId: binding.terminalId, worktreePath: root, session: binding.session },
    correlation: { token: "req-1", provenance: "orchestrator", verified: false }, acceptedAt: new Date().toISOString() });
  return { root, bin, manager, wrapped, binding, handle };
}

describe.skipIf(process.platform !== "linux")("future Developer process supervision", () => {
  it("preserves the canonical provider entry name for Herdr when discovery resolves a versioned binary", async () => {
    const f=await fixture(`console.log('entry:'+require('node:path').basename(process.argv[1]));setInterval(()=>{},1000);`,true);
    const child=spawn(join(f.wrapped.env.PATH!.split(':')[0]!,'codex'),[],{cwd:f.root,env:{...process.env,...f.wrapped.env},stdio:['ignore','pipe','pipe']});
    cleanups.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});
    await expect.poll(()=>output,{timeout:10000}).toContain('entry:codex');
    await expect(f.manager.assertBindingReady(f.binding)).resolves.toBeUndefined();await f.manager.stopUnbound(f.binding);
  });
  it.skipIf(!existsSync("/usr/bin/zsh"))("keeps the supervised provider first after an interactive zsh startup without reading account rc files", async () => {
    const f = await fixture(`console.log('supervised-shell-ready');setInterval(()=>{},1000);`);
    const home=join(f.root,'account-home'),other=join(f.root,'account-bin');await mkdir(home);await mkdir(other);
    await writeFile(join(other,'codex'), '#!/bin/sh\necho unsupervised-provider\n', {mode:0o700});
    await writeFile(join(home,'.zshrc'), `export PATH='${other}':$PATH\n`);
    const child=spawn('/usr/bin/zsh',['-lic','codex'],{cwd:f.root,env:{...process.env,...f.wrapped.env,HOME:home},stdio:['ignore','pipe','pipe']});
    cleanups.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
    let output='',errors='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{errors+=String(chunk);});
    await expect.poll(()=>output+errors,{timeout:10000}).toContain('supervised-shell-ready');
    expect(output).not.toContain('unsupervised-provider');await expect(f.manager.assertBindingReady(f.binding)).resolves.toBeUndefined();
    expect(await readFile(join(home,'.zshrc'),'utf8')).toContain(other);
    expect(await f.manager.stopUnbound(f.binding)).toMatchObject({source:'linux_pid_namespace'});
  });
  it("proves namespace exit and stops a detached descendant while retaining the worktree and original PATH", async () => {
    const f = await fixture(`const fs=require('node:fs'),cp=require('node:child_process');
      fs.writeFileSync(process.env.PROBE_PATH,process.env.PATH);
      const child=cp.spawn(process.execPath,['-e',"const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.env.HEARTBEAT,'x'),20)"],{detached:true,cwd:'/',stdio:'ignore'});
      child.unref(); console.log('provider-ready'); setInterval(()=>{},1000);`);
    const env = { ...process.env, ...f.wrapped.env, PROBE_PATH: join(f.root, "path.txt"), HEARTBEAT: join(f.root, "heartbeat") };
    const child = spawn(join(f.wrapped.env.PATH!.split(":")[0]!, "codex"), [], { cwd: f.root, env, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const output = await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Supervisor exited before provider startup"); })]);
    expect(String(output[0])).toContain("provider-ready");
    expect(await readFile(join(f.root, "path.txt"), "utf8")).toBe(f.bin + ":" + process.env.PATH);
    await f.manager.pinDispatch(AgentRequestSchema.parse({ requestId: f.handle.requestId, runId: f.handle.runId, taskId: f.handle.taskId,
      attemptId: f.handle.attemptId, role: "developer", target: f.handle.target, instruction: "test", workingDirectory: f.root, inputs: [], attempt: 1,
      retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false }, timeout: { executionTimeoutMs: 1000, onTimeout: "block" },
      idempotency: { key: f.handle.idempotencyKey, scope: "agent-request", fingerprint: "a".repeat(64) }, createdAt: new Date().toISOString() }), f.binding);
    await f.manager.bindExecution(f.handle, f.binding);
    expect(await f.manager.hasStoppedProof(f.binding)).toBe(false);
    const proof = await f.manager.stop(f.handle, f.binding);
    expect(await f.manager.hasStoppedProof(f.binding)).toBe(true);
    expect(proof).toMatchObject({ source: "linux_pid_namespace", handle: f.handle });
    await new Promise(resolve => setTimeout(resolve, 80));
    const before = await readFile(join(f.root, "heartbeat"), "utf8").catch(() => "");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await readFile(join(f.root, "heartbeat"), "utf8").catch(() => "")).toBe(before);
    expect(await f.manager.stop(f.handle, f.binding)).toEqual(proof);
    const restarted = new DeveloperProcessScopes({ directory: join(f.root, "scopes") });
    expect(await restarted.stop(f.handle, f.binding)).toEqual(proof);
    expect(await restarted.stop({ ...f.handle, executionId: "foreign" }, f.binding)).toBeUndefined();
  });
  it("preserves PTY, Ctrl-C and resize while the supervisor remains alive", async () => {
    const f = await fixture(`if(!process.stdin.isTTY||!process.stdout.isTTY)process.exit(4);
      process.on('SIGINT',()=>console.log('interrupted'));
      process.stdout.on('resize',()=>console.log('size:'+process.stdout.columns+'x'+process.stdout.rows));
      console.log('tty-ready');setInterval(()=>{},1000);`);
    const driverCode = String.raw`import os,sys,pty,select,time,fcntl,termios,struct,json
pid,fd=pty.fork()
if pid==0: os.execv(sys.argv[1],[sys.argv[1]])
try:
    data=b''
    def until(text):
        global data
        deadline=time.monotonic()+10
        while text not in data:
            if time.monotonic()>deadline: raise RuntimeError('PTY observation deadline: '+repr(data))
            if select.select([fd],[],[],0.2)[0]: data+=os.read(fd,4096)
    until(b'tty-ready');os.write(fd,b'\x03');until(b'interrupted')
    fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',37,101,0,0));until(b'size:101x37')
    print(json.dumps({'tty':True,'interrupt':True,'resize':True}),flush=True)
    sys.stdin.readline()
finally:
    try: os.kill(pid,9)
    except ProcessLookupError: pass
    os.waitpid(pid,0);os.close(fd)
`;
    const driver = spawn("python3", ["-c", driverCode, join(f.wrapped.env.PATH!.split(":")[0]!, "codex")],
      { cwd: f.root, env: { ...process.env, ...f.wrapped.env }, stdio: ["pipe", "pipe", "pipe"] });
    let errors = ""; driver.stderr.on("data", chunk => { errors += String(chunk); });
    cleanups.push(async () => { if (!driver.stdin.writableEnded && !driver.stdin.destroyed) driver.stdin.end("done\n"); if (driver.exitCode === null && driver.signalCode === null) driver.kill("SIGKILL"); });
    const ready = await Promise.race([once(driver.stdout, "data"), once(driver, "exit").then(() => { throw new Error(errors); })]);
    expect(JSON.parse(String(ready[0]))).toEqual({ tty: true, interrupt: true, resize: true });
    const proof = await f.manager.stopUnbound(f.binding);
    expect(proof).toMatchObject({ source: "linux_pid_namespace" });
    driver.stdin.end("done\n");
  });
  it("recovers a dispatch-binding crash using the exact write-ahead request, then proves the namespace exit", async () => {
    const f = await fixture("console.log('provider-ready');setInterval(()=>{},1000)");
    const child = spawn(join(f.wrapped.env.PATH!.split(":")[0]!, "codex"), [], { cwd: f.root, env: { ...process.env, ...f.wrapped.env }, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    await once(child.stdout, "data");
    await f.manager.pinDispatch(AgentRequestSchema.parse({ requestId: f.handle.requestId, runId: f.handle.runId, taskId: f.handle.taskId,
      attemptId: f.handle.attemptId, role: "developer", target: f.handle.target, instruction: "test", workingDirectory: f.root, inputs: [], attempt: 1,
      retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false }, timeout: { executionTimeoutMs: 1000, onTimeout: "block" },
      idempotency: { key: f.handle.idempotencyKey, scope: "agent-request", fingerprint: "a".repeat(64) }, createdAt: new Date().toISOString() }), f.binding);
    // No bindExecution call: the daemon died after the transport accepted but before its extra scope binding persisted.
    const restarted = new DeveloperProcessScopes({ directory: join(f.root, "scopes") });
    expect(await restarted.stop(f.handle, f.binding)).toMatchObject({ source: "linux_pid_namespace", handle: f.handle });
  });
  it("seals a prepared scope so a delayed launcher cannot start after cancellation", async () => {
    const f = await fixture("require('node:fs').writeFileSync(process.env.MARKER,'started')");
    const stopping = f.manager.stopUnbound(f.binding).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    const root = join(f.wrapped.env.PATH!.split(":")[0]!, "..");
    await expect.poll(async () => readFile(join(root, "sealed.json"), "utf8").then(() => true, () => false)).toBe(true);
    const marker = join(f.root, "should-not-start");
    const child = spawn(join(f.wrapped.env.PATH!.split(":")[0]!, "codex"), [], { env: { ...process.env, ...f.wrapped.env, MARKER: marker }, stdio: "ignore" });
    await once(child, "exit");
    expect(child.exitCode).not.toBe(0);
    expect(await readFile(marker, "utf8").catch(() => undefined)).toBeUndefined();
    // Sealed before any witness: the provider provably never ran, so there is no stop to prove and nothing to wait for.
    expect(await stopping).toEqual({ value: undefined, error: undefined });
  });
  it("does not authorize provider execution when Bubblewrap's block pipe reaches EOF without an acknowledgement", async () => {
    const f = await fixture("require('node:fs').writeFileSync(process.env.MARKER,'started')");
    const root = join(f.wrapped.env.PATH!.split(":")[0]!, ".."), configPath = join(root, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")), marker = join(f.root, "no-ack-provider");
    const child = spawn(config.bwrap, ["--unshare-user", "--unshare-pid", "--die-with-parent", "--cap-drop", "ALL", "--bind", "/", "/", "--dev-bind", "/dev", "/dev",
      "--proc", "/proc", "--block-fd", "3", "--info-fd", "4", "--", config.python, join(root, "supervisor.py"), "entry", configPath],
      { env: { ...process.env, ...f.wrapped.env, MARKER: marker }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"] });
    try {
      const infoStream = child.stdio[4]!, chunks: Buffer[] = [];
      infoStream.on("data", chunk => { chunks.push(Buffer.from(chunk)); });
      await once(infoStream, "end");
      const initPid = JSON.parse(Buffer.concat(chunks).toString())['child-pid'];
      (child.stdio[3]! as import("node:stream").Writable).end(); // EOF, deliberately no authorization byte.
      await expect.poll(async () => {
        const children = (await readFile(`/proc/${initPid}/task/${initPid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
        for (const pid of children) if ((await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).includes("entry")) return true;
        return false;
      }, { timeout: 4000 }).toBe(true);
      expect(await readFile(marker, "utf8").catch(() => undefined)).toBeUndefined();
    } finally { const closed = once(child, "close"); child.kill("SIGKILL"); await closed; }
  });
  it("keeps unfinished files while retiring a stopped writer through the real Pane Manager proof callback", async () => {
    const f = await fixture("console.log('provider-ready');setInterval(()=>{},1000)");
    const unfinished = join(f.root, "guide.md"); await writeFile(unfinished, "unfinished documentation\n");
    const child = spawn(join(f.wrapped.env.PATH!.split(":")[0]!, "codex"), [], { env: { ...process.env, ...f.wrapped.env }, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    await once(child.stdout, "data");
    const store = new InMemorySessionManifestStore();
    const common = { ...f.binding, cwd: f.root, worktreePath: undefined, readOnlyWorkspace: true, permanent: true, metadata: {} };
    await store.save(SessionManifestSchema.parse({ schemaVersion: 2, sessionId: "session-1", projectName: "test", workspaceRoot: f.root,
      herdrWorkspaceId: "w1", herdrTabId: "w1:t1", status: "up", conversationSessionId: "conv-1", activeRunIds: [],
      panes: [f.binding, { ...common, bindingId: "chat", role: "conversation", paneGroup: "conversation", paneId: "chat", agentId: "chat" },
        { ...common, bindingId: "coord", role: "coordinator", paneGroup: "coordination", paneId: "coord", agentId: "coord" }],
      attachTarget: { role: "conversation", paneId: "chat" }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
    const panes = new RolePaneManager({ config: { sessionId: "session-1", projectName: "test", workspaceRoot: f.root, conversationSessionId: "conv-1" },
      store, runner: { run: async () => { throw new Error("No Herdr destructive mutation is permitted"); } },
      worktreeInspector: { inspect: async () => ({ ok: true, value: { exists: true, isClean: false, dirtyFiles: ["guide.md"] } }) },
      authorizeStoppedRetainedRelease: binding => f.manager.hasStoppedProof(binding) });
    expect((await panes.releaseDeveloper({ taskId: "run-1-task-1", closePane: false, removeWorktree: false })).ok).toBe(false);
    await f.manager.stopUnbound(f.binding);
    expect((await panes.releaseDeveloper({ taskId: "run-1-task-1", closePane: false, removeWorktree: false })).ok).toBe(true);
    expect(await readFile(unfinished, "utf8")).toBe("unfinished documentation\n");
    const saved = await store.load("session-1");
    expect(saved.ok && saved.value?.panes.find(p => p.bindingId === f.binding.bindingId)).toMatchObject({ readOnlyWorkspace: true,
      transportState: "cancelled", metadata: { allocationStatus: "released" } });
  });
  it("attaches a late accepted handle to the original stopped scope without fabricating delivery or an earlier observation", async () => {
    const f = await fixture("console.log('provider-ready');setInterval(()=>{},1000)");
    const child = spawn(join(f.wrapped.env.PATH!.split(":")[0]!, "codex"), [], { env: { ...process.env, ...f.wrapped.env }, stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    await once(child.stdout, "data");
    await f.manager.pinDispatch(AgentRequestSchema.parse({ requestId: f.handle.requestId, runId: f.handle.runId, taskId: f.handle.taskId,
      attemptId: f.handle.attemptId, role: "developer", target: f.handle.target, instruction: "test", workingDirectory: f.root, inputs: [], attempt: 1,
      retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false }, timeout: { executionTimeoutMs: 1000, onTimeout: "block" },
      idempotency: { key: f.handle.idempotencyKey, scope: "agent-request", fingerprint: "a".repeat(64) }, createdAt: new Date().toISOString() }), f.binding);
    const stopped = await f.manager.stopUnbound(f.binding); expect(stopped).toBeDefined();
    f.handle.acceptedAt = new Date().toISOString();
    const proof = await f.manager.stop(f.handle, f.binding);
    expect(proof?.handle).toEqual(f.handle);
    expect(Date.parse(proof!.observedAt)).toBeGreaterThanOrEqual(Date.parse(f.handle.acceptedAt));
    expect(await f.manager.stop(f.handle, f.binding)).toEqual(proof);
  });
  it("does not turn an empty never-started scope into stop proof", async () => {
    const f = await fixture("console.log('unused')");
    await expect(f.manager.bindExecution(f.handle, f.binding)).rejects.toThrow(/started|witness/i);
    expect(await f.manager.stop(f.handle, f.binding)).toBeUndefined();
  });
});
describe("legacy Developer bindings without a process scope", () => {
  it("keep pre-scope dispatch and stop semantics instead of failing closed or manufacturing proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "bflow-process-scope-legacy-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const manager = new DeveloperProcessScopes({ directory: join(root, "scopes") });
    const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "binding-dev", sessionId: "session-1", role: "developer", paneGroup: "developer_worktree",
      agentId: "dev-1", workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p2", terminalId: "terminal-1", provider: "herdr", agentKind: "codex", cwd: root,
      worktreePath: root, session: { source: "herdr:codex", kind: "id", value: "native-1" }, isolationMode: "dedicated_pane", readOnlyWorkspace: false,
      transportState: "idle", boundAt: new Date().toISOString(), metadata: { runId: "run-1", taskId: "run-1-task-1", launchId: "launch-1", launchFingerprint: "a".repeat(64) } });
    const handle = AgentExecutionHandleSchema.parse({ executionId: "exec-1", requestId: "req-1", attemptId: "attempt-1", runId: "run-1", taskId: "task-1",
      idempotencyKey: "req-1", target: { transport: "herdr", agentId: binding.agentId, workspaceId: binding.workspaceId, tabId: binding.tabId,
        paneId: binding.paneId, terminalId: binding.terminalId, worktreePath: root, session: binding.session },
      correlation: { token: "req-1", provenance: "orchestrator", verified: false }, acceptedAt: new Date().toISOString() });
    await expect(manager.assertBindingReady(binding)).resolves.toBeUndefined();
    await expect(manager.bindExecution(handle, binding)).resolves.toBeUndefined();
    expect(await manager.stop(handle, binding)).toBeUndefined();
    expect(await manager.stopUnbound(binding)).toBeUndefined();
    expect(await manager.hasStoppedProof(binding)).toBe(false);
    // A binding that claims a scope still fails closed when that scope is absent.
    const claimed = PaneBindingSchema.parse({ ...binding, metadata: { ...binding.metadata, processScopeId: "00000000-0000-4000-8000-000000000000" } });
    await expect(manager.assertBindingReady(claimed)).rejects.toThrow("no started, authenticated process-scope witness");
  });
});
