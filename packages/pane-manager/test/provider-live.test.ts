import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildProviderRoleLaunchFromFiles } from "../src/provider-launch.js";

const execute = promisify(execFile);
const enabled = process.env.BFLOW_LIVE_CLAUDE === "1";

describe.skipIf(!enabled)("actual Claude launch with isolated Herdr native session hook", () => {
  it("reports the provider session and receives a real model response without global hook changes", async () => {
    const directory = await mkdtemp("/tmp/bflow-claude-");
    const config = join(directory, "config"), data = join(directory, "data"), auth = join(directory, "claude");
    await Promise.all([mkdir(config), mkdir(data), mkdir(auth, { mode: 0o700 })]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_") && key !== "CLAUDECODE"));
    const originalHome = process.env.HOME!;
    // Read existing login into a private disposable profile; never modify the original profile/credentials.
    await copyFile(join(process.env.CLAUDE_CONFIG_DIR ?? join(originalHome, ".claude"), ".credentials.json"), join(auth, ".credentials.json"));
    await copyFile(join(originalHome, ".claude.json"), join(auth, ".claude.json"));
    Object.assign(env, { XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_RUNTIME_DIR: directory,
      TMPDIR: "/tmp", ZDOTDIR: directory, HERDR_CONFIG_PATH: join(config, "config.toml"),
      HERDR_SESSION: "claude-provider", CLAUDE_CONFIG_DIR: auth });
    await writeFile(join(directory, ".zshrc"), "# isolated Bflow test shell\n");
    const binary = process.env.BFLOW_HERDR_BIN ?? "herdr";
    const raw = async (args: string[]) => (await execute(binary, ["--session", "claude-provider", ...args], { env, timeout: 35_000, maxBuffer: 1024 * 1024 })).stdout;
    const call = async (args: string[]) => JSON.parse(await raw(args));
    const receipt = join(directory, "native-session.json"), hook = join(directory, "session-hook.mjs");
    await writeFile(hook, [
      "import {writeFileSync} from 'node:fs'; import {connect} from 'node:net';",
      "let input='';for await(const chunk of process.stdin)input+=chunk;const event=JSON.parse(input);",
      "if(event.hook_event_name!=='SessionStart'||!event.session_id)throw new Error('Native session missing');",
      `writeFileSync(${JSON.stringify(receipt)},JSON.stringify({sessionId:event.session_id,paneId:process.env.HERDR_PANE_ID}),{mode:0o600});`,
      "const request={id:'bflow-native-'+Date.now(),method:'pane.report_agent_session',params:{pane_id:process.env.HERDR_PANE_ID,source:'herdr:claude',agent:'claude',seq:Date.now()*1000,agent_session_id:event.session_id,agent_session_path:event.transcript_path,session_start_source:event.source}};",
      "await new Promise((accept,reject)=>{const socket=connect(process.env.HERDR_SOCKET_PATH);socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('Session report timeout'));});socket.on('error',reject);socket.once('connect',()=>socket.write(JSON.stringify(request)+'\\n'));socket.on('data',chunk=>{const result=JSON.parse(String(chunk));socket.end();result.error?reject(new Error('Herdr rejected native session')):accept();});});"
    ].join("\n"), { mode: 0o600 });
    const server = spawn(binary, ["--session", "claude-provider", "server"], { env, stdio: "ignore" });
    try {
      await expect.poll(async () => { try { return (await call(["status", "server", "--json"])).running; } catch { return false; } }, { timeout: 10_000, interval: 100 }).toBe(true);
      const created = (await call(["workspace", "create", "--cwd", directory, "--label", "Bflow Claude provider test", "--no-focus"])).result;
      const paneId = created.root_pane.pane_id;
      const mcpServer = join(directory, "probe-mcp.mjs"), mcpReceipt = join(directory, "mcp-called");
      await writeFile(mcpServer, [
        "import readline from 'node:readline';import{writeFileSync}from'node:fs';",
        "readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.id===undefined)return;let result={};",
        "if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'bflow-launch-probe',version:'1'}};",
        "else if(request.method==='tools/list')result={tools:[{name:'probe',description:'Read the Bflow launch probe context. Call this before reporting readiness.',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};",
        `else if(request.method==='tools/call'){writeFileSync(${JSON.stringify(mcpReceipt)},'called',{mode:0o600});result={content:[{type:'text',text:'Bflow trusted host ready. Reply BFLOW_CLAUDE_READY.'}]};}`,
        "process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');});"
      ].join("\n"));
      const mcpConfigFile = join(directory, "mcp.json"), hooksSettingsFile = join(directory, "hooks.json");
      await writeFile(mcpConfigFile, JSON.stringify({ mcpServers: { bflow: { command: process.execPath, args: [mcpServer] } } }), { mode: 0o600 });
      await writeFile(hooksSettingsFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `node '${hook}'`, timeout: 10 }] }] } }), { mode: 0o600 });
      const args = await buildProviderRoleLaunchFromFiles({ agentKind: "claude", role: "conversation",
        systemPrompt: "You are Bflow Conversation. Never edit source or dispatch specialists. For this probe answer BFLOW_CLAUDE_READY.",
        mcpConfigFile, hooksSettingsFile });
      try { await call(["agent", "start", "chat", "--kind", "claude", "--pane", paneId, "--timeout", "20000", "--", ...args]); }
      catch (error) {
        // Claude's first-use trust choice is answered only for this generated, disposable workspace/profile.
        const screen = await raw(["pane", "read", paneId, "--source", "recent", "--lines", "35"]);
        if (!screen.includes("Quick safety check") || !screen.includes(directory)) throw error;
        await raw(["pane", "send-keys", paneId, "down", "enter"]);
      }
      await expect.poll(async () => { try { return JSON.parse(await readFile(receipt, "utf8")).paneId; } catch { return undefined; } }, { timeout: 15_000, interval: 100 }).toBe(paneId);
      await call(["agent", "focus", paneId]);
      let agent: any;
      await expect.poll(async () => { agent = (await call(["agent", "get", paneId])).result.agent; return agent.agent_status === "idle" && !!agent.agent_session; }, { timeout: 15_000, interval: 100 }).toBe(true);
      const native = JSON.parse(await readFile(receipt, "utf8"));
      expect(agent.agent_session).toMatchObject({ source: "herdr:claude", kind: "id", value: native.sessionId });
      const result = await call(["agent", "prompt", paneId, "Call the bflow probe MCP tool, then reply exactly BFLOW_CLAUDE_READY", "--wait", "--timeout", "20000"]);
      expect(result.result.type).toBe("agent_prompted");
      expect(await readFile(mcpReceipt, "utf8")).toBe("called");
      const screen = await raw(["pane", "read", paneId, "--source", "recent", "--lines", "35"]);
      expect(screen).toContain("● BFLOW_CLAUDE_READY");
      console.info(JSON.stringify({ evidence: "real-claude-native-session-and-reply", provider: "claude",
        authenticatedNativeSessionObserved: true, modelReplyObserved: true, mcpToolInvoked: true, globalHooksModified: false }));
    } finally {
      await call(["session", "stop", "claude-provider"]).catch(() => undefined);
      if (server.exitCode === null) server.kill("SIGTERM");
      await rm(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
