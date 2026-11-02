import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoleMessageSchema } from "@bflow/contracts";
import { encodeNativePluginSelection, resolveNativePluginSelection } from "../../src/agentic/native-intent-selection.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function message(bytes = 0) { return RoleMessageSchema.parse({ schema_version: 2, message_id: "native-measurement-1", correlation_id: "correlation",
  run_id: "run-1", sender: { role: "qa", agent_id: "qa", pane_id: "w1:p2" }, recipient: { role: "coordinator" }, type: "task.status",
  payload: { status: "blocked", detail: "漢字🙂".repeat(bytes) }, artifact_references: [], occurred_at: "2026-10-29T20:00:00.000Z", idempotency_key: "native-measurement-1" }); }
it("preserves inline legacy envelopes and never consults an intent store for them", async () => {
 const input=message(), read=vi.fn(); expect(await resolveNativePluginSelection(encodeNativePluginSelection("op",input),read)).toEqual(input);expect(read).not.toHaveBeenCalled();
});
it("carries a small digest-bound reference instead of an oversized environment entry, preserving every payload byte", async () => {
 const input=message(20000), selection=encodeNativePluginSelection("behavioral:measurement",input);
 expect(Buffer.byteLength(JSON.stringify({selected_text:selection}))).toBeLessThan(2000);
 expect(selection).not.toContain(input.payload.detail);
 expect(await resolveNativePluginSelection(selection,async op=>op==="behavioral:measurement"?{message:input,status:"unknown_delivery"}:undefined)).toEqual(input);
});
it.each(["missing","acknowledged","refused","changed","wrong-id"])("refuses %s native references without manufacturing an envelope", async mode=>{
 const input=message(20000), selection=encodeNativePluginSelection("op",input);
 const read=async()=>mode==="missing"?undefined:{message:mode==="changed"?{...input,payload:{status:"blocked",detail:"changed"}}:mode==="wrong-id"?{...input,message_id:"other"}:input,
  status:mode==="acknowledged"?"acknowledged" as const:"unknown_delivery" as const,rejected:mode==="refused"};
 await expect(resolveNativePluginSelection(selection,read)).rejects.toThrow(/intent|immutable/i);
});
it("resolves only validated private journal receipts in the selected repository/session", async()=>{
 const root=await mkdtemp(join(tmpdir(),"native-intent-ref-"));roots.push(root);
 const journal=new HostReceiptJournal(join(root,"receipts"),root,"session-1"), input=message(20000);
 await journal.recordNativeIntent("op",input);
 const selection=encodeNativePluginSelection("op",input);
 expect(await resolveNativePluginSelection(selection,op=>journal.nativeDelivery(op))).toEqual(input);
 const foreign=new HostReceiptJournal(join(root,"receipts"),root,"other-session");
 await expect(resolveNativePluginSelection(selection,op=>foreign.nativeDelivery(op))).rejects.toThrow();
});

import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { generateKeyPairSync, verify } from "node:crypto";
import { SessionManifestSchema, canonicalReceiptJson } from "@bflow/contracts";
import { deliverNativeHerdrMessage } from "../../src/agentic/native-plugin.js";
it("loads the host-written reference in the native plugin and signs the exact full envelope", async () => {
 const root=await mkdtemp(join(tmpdir(),"native-ref-plugin-"));roots.push(root);
 const repo=join(root,"repo"),host=join(root,"host"),config=join(root,"config"),at=new Date().toISOString();
 for(const dir of [repo,host,join(config,"hosts")])await mkdir(dir,{recursive:true,mode:0o700});
 const key=generateKeyPairSync("ed25519"),keyPath=join(host,"native-key.pem"),manifestPath=join(root,"manifest.json"),socketPath=join(root,"runtime.sock");
 await writeFile(keyPath,key.privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600});
 const panes=["conversation","coordinator","qa"].map((role,index)=>({schemaVersion:2,bindingId:`binding-${role}`,sessionId:"session-1",role,
  paneGroup:"coordination",agentId:role,workspaceId:"w1",tabId:"w1:t1",paneId:`w1:p${index}`,provider:"claude",agentKind:"claude",cwd:repo,
  isolationMode:"dedicated_pane",readOnlyWorkspace:true,transportState:"idle",boundAt:at}));
 const manifest=SessionManifestSchema.parse({schemaVersion:2,sessionId:"session-1",projectName:"probe",workspaceRoot:repo,herdrWorkspaceId:"w1",herdrTabId:"w1:t1",
  status:"up",conversationSessionId:"conversation-1",activeRunIds:[],panes,attachTarget:{role:"conversation",paneId:"w1:p0"},createdAt:at,updatedAt:at});
 await writeFile(manifestPath,JSON.stringify(manifest));
 await writeFile(join(config,"hosts","session-1.json"),JSON.stringify({issuerId:"issuer",privateKeyFile:keyPath,runtimeSocket:socketPath,manifestFile:manifestPath,herdrSocketPath:"fake-herdr"}));
 const binary=join(root,"herdr");await writeFile(binary,'#!/usr/bin/env node\nconsole.log(JSON.stringify({running:true,session:"session-1"}));\n',{mode:0o700});
 const original=message(20000),journal=new HostReceiptJournal(join(host,"authentication-receipts"),repo,"session-1");await journal.recordNativeIntent("op",original);
 let packet:any;const server=createServer(socket=>{socket.setEncoding("utf8");let text="";socket.on("data",chunk=>{text+=String(chunk);if(text.includes("\n")){packet=JSON.parse(text.split("\n")[0]!);socket.end('{"ok":true}\n');}});});
 await new Promise<void>(resolve=>server.listen(socketPath,resolve));
 try {
  await deliverNativeHerdrMessage({...process.env,HERDR_ENV:"1",HERDR_PLUGIN_ID:"bflow.receipts",HERDR_PLUGIN_CONFIG_DIR:config,HERDR_SOCKET_PATH:"fake-herdr",HERDR_BIN_PATH:binary,
   HERDR_PLUGIN_CONTEXT_JSON:JSON.stringify({selected_text:encodeNativePluginSelection("op",original),focused_pane_id:"w1:p2",workspace_id:"w1"})});
  expect(packet.message).toEqual(original);expect(packet.issuerId).toBe("issuer");
  expect(verify(null,Buffer.from(canonicalReceiptJson(packet.message)),key.publicKey,Buffer.from(packet.signature,"base64"))).toBe(true);
 } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
