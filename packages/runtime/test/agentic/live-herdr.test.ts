import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { AgentRequestSchema, RoleMessageSchema } from "@bflow/contracts";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { createHerdrAdapter } from "@bflow/herdr-adapter";
import { startHerdrReceiptIngress, authenticateNativeHerdrMessage } from "../../src/agentic/herdr-ingress.js";
import { workflow } from "../../../specification/test/fixtures.js";
const execute = promisify(execFile);
const unwrap = <T>(r: {ok:true;value:T}|{ok:false;error:{message:string}}): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };

describe.runIf(process.env.BFLOW_LIVE_HERDR === "1")("installed Herdr native receipt transport (no model/provider)", () => {
  it("initializes by protocol and delivers a signed RoleMessage through an actual Herdr plugin without inventing binding proof", async () => {
    const directory = await mkdtemp("/tmp/hbr-");
    const configRoot = join(directory, "config"); const dataRoot = join(directory, "data");
    await mkdir(configRoot); await mkdir(dataRoot);
    const binary = process.env.BFLOW_HERDR_BIN ?? "herdr";
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_")));
    Object.assign(env, { XDG_CONFIG_HOME: configRoot, XDG_DATA_HOME: dataRoot, XDG_RUNTIME_DIR: directory,
      TMPDIR: "/tmp", ZDOTDIR: directory, HERDR_CONFIG_PATH: join(configRoot, "config.toml"), HERDR_SESSION: "smoke" });
    await writeFile(join(directory, ".zshrc"), "# isolated Herdr smoke shell\n");
    const call = async (args: string[]) => (await execute(binary, ["--session", "smoke", ...args], { env, timeout: 15_000 })).stdout;
    const server = spawn(binary, ["--session", "smoke", "server"], { env, stdio: "ignore" });
    let ingress: Awaited<ReturnType<typeof startHerdrReceiptIngress>> | undefined;
    try {
      await expect.poll(async () => { try { return JSON.parse(await call(["status", "server", "--json"])).running; } catch { return false; } }, { timeout: 10_000, interval: 50 }).toBe(true);
      const created = JSON.parse(await call(["workspace", "create", "--cwd", directory, "--label", "Bflow native receipt smoke", "--no-focus"])).result;
      const pane = created.root_pane;
      // A real custom native process owns this test pane. It is deliberately not represented as an AI-model E2E test.
      const actor = join(directory, "native-actor.mjs");
      await writeFile(actor, [
        "import {spawnSync} from 'node:child_process';",
        "import readline from 'node:readline';",
        "let sequence=Date.now();",
        "function report(){const r=spawnSync(process.env.HERDR_BIN_PATH??'herdr',['pane','report-agent',process.env.HERDR_PANE_ID,'--source','bflow-native-smoke','--agent','bflow-native-smoke','--state','idle','--seq',String(++sequence),'--agent-session-id','native-smoke-session'],{env:process.env,encoding:'utf8'});if(r.status!==0)process.stdout.write(r.stderr);}",
        "readline.createInterface({input:process.stdin}).on('line',()=>report());",
        "setInterval(report,400);report();"
      ].join("\n"));
      await call(["pane", "run", pane.pane_id, `node ${actor}`]);
      let agent: any;
      try {
      await expect.poll(async () => { try { agent = JSON.parse(await call(["agent", "get", pane.pane_id])).result.agent; return agent.agent === "bflow-native-smoke"; } catch { return false; } }, { timeout: 10_000, interval: 100 }).toBe(true);
      } catch (error) { throw new Error(String(error) + " Last agent: " + JSON.stringify(agent) + " Native pane: " + await call(["pane", "read", pane.pane_id, "--source", "recent", "--lines", "20"])); }
      const paneModule = await import(new URL("../../../pane-manager/dist/index.js", import.meta.url).href);
      const processRunner = paneModule.createProcessRunner(binary);
      const transport = createHerdrAdapter({ runner: { run: invocation => processRunner.run({ ...invocation, env, cwd: directory }) } });
      const initialized = unwrap(await transport.initialize({ runtimeId: "native-smoke", configuration: {}, recoveryMode: false, initializedAt: new Date().toISOString() }));
      expect(initialized.protocolVersion).toBe("22");
      const definition = workflow(); const engineKeys = generateKeyPairSync("ed25519");
      const privateKey = engineKeys.privateKey.export({type:"pkcs8",format:"pem"}).toString();
      const publicKey = engineKeys.publicKey.export({type:"spki",format:"pem"}).toString();
      const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys: { "native-live-host": publicKey } });
      const start = unwrap(await engine.createRun({ runId: "live-run", definition: definition as any, idempotencyKey: "create-live", createdAt: new Date().toISOString() }));
      const running = unwrap(await engine.advance({ runId: "live-run", expectedVersion: start.snapshot.version, idempotencyKey: "advance-live", occurredAt: new Date().toISOString() }));
      const task = running.snapshot.tasks[0]!;
      const target = { transport: "herdr", agentId: agent.name ?? agent.agent, paneId: pane.pane_id, workspaceId: pane.workspace_id,
        tabId: pane.tab_id, terminalId: pane.terminal_id,
        ...(agent.agent_session ? { session: { source: agent.agent_session.source, kind: agent.agent_session.kind, value: agent.agent_session.value } } : {}) };
      const assignmentId = randomUUID();
      const request = AgentRequestSchema.parse({ requestId: randomUUID(), attemptId: task.attemptId, runId: "live-run", taskId: task.taskId,
        role: "developer", target, instruction: JSON.stringify({ message_id: assignmentId, type: "task.assignment" }), inputs: [], attempt: 1,
        retry: definition.tasks[0]!.retry, timeout: definition.tasks[0]!.timeout,
        idempotency: { key: "native-live-send", scope: "agent-request", fingerprint: assignmentId }, createdAt: new Date().toISOString() });
      const receipt = unwrap(await transport.send(request));
      if (receipt.status === "accepted") {
        unwrap(await engine.bindAgentExecution({ runId: "live-run", taskId: task.taskId, expectedVersion: running.snapshot.version,
          attempt: task.attempt, handle: receipt.handle, idempotencyKey: "bind-live", occurredAt: new Date().toISOString() }));
        expect(receipt.handle.correlation.verified).toBe(false);
      } else if (receipt.status === "unknown_delivery") {
        // Actual operation-level incompatibility is observed, not inferred from the CLI release label.
        expect(receipt.resendAllowed).toBe(false);
      }
      const runtimeSocket = join(directory, "ingress.sock"); let received = false;
      ingress = await startHerdrReceiptIngress({ socketPath: runtimeSocket, publicKeys: { "native-live-host": publicKey }, receive: async message => {
        expect(await authenticateNativeHerdrMessage(message)).toBe(true);
        expect(message.type).toBe("task.status"); expect(message.causation_id).toBe(assignmentId);
        received = true;
      } });
      const nativeKey = join(directory, "native-key.pem"); await writeFile(nativeKey, privateKey, {mode:0o600});
      const manifestFile = join(directory, "manifest.json");
      await writeFile(manifestFile, JSON.stringify({ schemaVersion: 2, sessionId: "smoke", projectName: "native smoke", workspaceRoot: directory,
        herdrWorkspaceId: pane.workspace_id, herdrTabId: pane.tab_id, status: "initializing", conversationSessionId: "chat", activeRunIds: ["live-run"],
        panes: [{ schemaVersion: 2, bindingId: "native-binding", sessionId: "smoke", role: "developer", agentId: target.agentId,
          workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id, provider: "native-smoke", agentKind: "native-smoke", cwd: directory,
          isolationMode: "dedicated_pane", readOnlyWorkspace: true, transportState: "idle", boundAt: new Date().toISOString() }],
        attachTarget: {role:"conversation",paneId:pane.pane_id}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
      const pluginRoot = fileURLToPath(new URL("../../../../agents/coordinator/herdr-receipts", import.meta.url));
      await call(["plugin", "link", pluginRoot]);
      const configDirs: string[] = [];
      async function find(path: string, depth = 0): Promise<void> {
        if (depth > 6) return;
        for (const entry of await readdir(path, {withFileTypes:true})) if (entry.isDirectory()) {
          const child = join(path, entry.name); if (entry.name === "bflow.receipts") configDirs.push(child); else await find(child, depth + 1);
        }
      }
      await find(configRoot); expect(configDirs.length).toBeGreaterThan(0);
      const foreignManifestFile = join(directory, "foreign-manifest.json");
      const { readFile } = await import("node:fs/promises");
      const foreignManifest = JSON.parse(await readFile(manifestFile, "utf8"));
      foreignManifest.sessionId = "another-session";
      foreignManifest.panes = foreignManifest.panes.map((binding: Record<string, unknown>) => ({ ...binding, sessionId: "another-session" }));
      await writeFile(foreignManifestFile, JSON.stringify(foreignManifest));
      for (const path of configDirs) {
        const hosts = join(path, "hosts"); await mkdir(hosts, { recursive: true, mode: 0o700 });
        await writeFile(join(hosts, "smoke.json"), JSON.stringify({ issuerId: "native-live-host", privateKeyFile: nativeKey, runtimeSocket, manifestFile }), {mode:0o600});
        // Pane/workspace IDs repeat in different named sessions. Select only the
        // actual native session even when a foreign manifest has identical IDs.
        await writeFile(join(hosts, "foreign.json"), JSON.stringify({ issuerId: "native-live-host", privateKeyFile: nativeKey, runtimeSocket, manifestFile: foreignManifestFile }), {mode:0o600});
      }
      const at = new Date().toISOString();
      const message = RoleMessageSchema.parse({ schema_version: 2, message_id: randomUUID(), correlation_id: "live-correlation", causation_id: assignmentId, run_id: "live-run",
        sender: {role:"developer",agent_id:target.agentId,pane_id:target.paneId}, recipient:{role:"coordinator"}, type:"task.status", artifact_references: [], occurred_at: at, idempotency_key: randomUUID(),
        payload: { headline: "Real native Herdr transport smoke", state: "running" } });
      const socketPath = JSON.parse(await call(["status", "server", "--json"])).socket;
      await new Promise<void>((accept, reject) => {
        const socket = connect(socketPath); let output = "";
        socket.setTimeout(15_000, () => {socket.destroy();reject(new Error("Herdr action timeout"));}); socket.once("error",reject);
        socket.once("connect", () => socket.write(JSON.stringify({id:"invoke-binding-receipt",method:"plugin.action.invoke",params:{plugin_id:"bflow.receipts",action_id:"deliver",
          context:{selected_text:JSON.stringify(message),correlation_id:assignmentId,focused_pane_id:target.paneId,workspace_id:target.workspaceId}}}) + "\n"));
        socket.on("data", chunk => { output += chunk; if (output.includes("\n")) {socket.end(); const result=JSON.parse(output.split("\n")[0]!); result.error ? reject(new Error(JSON.stringify(result.error))) : accept();} });
      });
      await expect.poll(() => received, {timeout:10_000,interval:50}).toBe(true);
      const snapshot = unwrap(await engine.getSnapshot("live-run"))!;
      expect(snapshot.tasks[0]!.bindingVerification).toBeUndefined();
      expect(snapshot.tasks[0]!.status).toBe("running"); // authenticated acknowledgement is still not business success
      expect(await authenticateNativeHerdrMessage(message)).toBe(false);
      console.info(JSON.stringify({ evidence: "herdr-native-plugin-message", protocol: initialized.protocolVersion,
        session: "smoke", runId: "live-run", taskId: task.taskId, assignmentId, messageId: message.message_id,
        agentId: target.agentId, paneId: target.paneId, workspaceId: target.workspaceId, tabId: target.tabId,
        nativeSessionObserved: target.session !== undefined, submissionStatus: receipt.status,
        authenticatedMessageReceived: received, bindingVerified: false, taskStatus: snapshot.tasks[0]!.status,
        modelProviderUsed: false }));
    } finally {
      await ingress?.close();
      await call(["session", "stop", "smoke"]).catch(() => undefined); if (server.exitCode === null) server.kill("SIGTERM");
      await rm(directory, {recursive:true,force:true});
    }
  }, 60_000);
});
