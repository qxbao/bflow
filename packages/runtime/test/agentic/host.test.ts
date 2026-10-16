import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAgenticHost } from "../../dist/agentic/host-controller.js";
import { callHost } from "../../src/agentic/host-protocol.js";
import { openSqliteRunStore } from "@bflow/persistence";
import { workflow } from "../../../specification/test/fixtures.js";
import { SessionManifestSchema } from "@bflow/contracts";
const execute = promisify(execFile);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function fixture() {
  const root = await mkdtemp("/tmp/bflow-host-test-");
  const binary = join(root, "herdr-fixture.mjs");
  await writeFile(binary, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({running:false})+"\\n");\n', { mode: 0o700 });
  const options = { repositoryPath: root, sessionId: "test-host", herdrBinary: binary };
  const controller = await ensureAgenticHost(options);
  cleanup.push(async () => { await controller.shutdown(); await rm(root, {recursive:true, force:true}); });
  return {root, controller, options};
}
describe("default durable host lifecycle and role MCP", () => {
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
