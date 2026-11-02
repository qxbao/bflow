import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { AgentBindingReceiptSchema, AgentConfigurationSchema, PaneBindingSchema, ReleaseAgentLeaseRequestSchema,
  RoleMessageSchema, receiptSigningBytes, type AgentExecutionHandle, type RoleMessage } from "@bflow/contracts";
import * as runtime from "../../src/index.js";
import { AgenticJournal, digest, record } from "../../src/agentic/journal.js";
import { FakeAgentTransport } from "../helpers/fake-transport.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!result.ok) throw new Error(result.error.message); return result.value;
};

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-native-extension-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "repo"); await mkdir(repositoryPath);
  const journalDirectory = join(root, "delivery");
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });
  const transport = new FakeAgentTransport();
  const artifactStore = unwrap(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "native-extension" }));
  const keys = generateKeyPairSync("ed25519");
  const authenticated = new Set<string>();
  let authorized = true;
  const binding = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: "binding-specifier", sessionId: "session-native",
    role: "specifier", agentId: "native-analyst", paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1",
    provider: "codex", agentKind: "codex", cwd: repositoryPath, isolationMode: "dedicated_pane", readOnlyWorkspace: true,
    permanent: true, transportState: "idle", boundAt: new Date().toISOString(),
    session: { source: "herdr:codex", kind: "id", value: "native-session-1" } });
  unwrap(await registry.upsert(AgentConfigurationSchema.parse({ agentId: binding.agentId, role: binding.role, transport: "herdr",
    enabled: true, priority: 0, maxConcurrentTasks: 1, capabilities: ["repository.read", "specification"], settings: {} })));
  const journal = new AgenticJournal(journalDirectory, repositoryPath);
  const options = { repositoryPath, journalDirectory, sessionId: "session-native", registry, transport, artifactStore,
    panes: { getRoleBinding: async () => ({ ok: true, value: binding }), inspectRoleHealth: async () => ({ ok: true,
      value: { readyForPrompt: true, occupantMatches: true, paneId: binding.paneId, agentId: binding.agentId } }) },
    authorize: async () => { if (!authorized) throw new Error("Extension authority is no longer current"); },
    preflight: async (pane: unknown) => { expect(pane).toEqual(binding); },
    authenticateMessage: async (message: RoleMessage) => authenticated.has(digest(message)),
    bindingReceiptKeys: { "native-host": keys.publicKey.export({ type: "spki", format: "pem" }).toString() } };
  const create = () => {
    const factory = Reflect.get(runtime, "createNativeExtensionRolePort");
    expect(factory, "native delivery must be a functional Runtime port, not a logical SDK handle").toBeTypeOf("function");
    return factory(options);
  };
  const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "elicitation-message", correlation_id: "corr-native",
    run_id: "run-native", sender: { role: "coordinator" }, recipient: { role: "specifier" }, type: "delegation.request",
    payload: { instruction: "List business questions", context: {} }, artifact_references: [], idempotency_key: "elicitation-message" });
  const intent = { family: "analysis", runId: "run-native", taskId: "elicitation", attemptId: "attempt-1",
    requestKey: "native-elicitation", message, allowedReadPaths: ["src"], outputKind: "analysis.elicitation" };
  const deliver = async (bridge: ReturnType<typeof create>, handle: AgentExecutionHandle, overrides: Partial<RoleMessage> = {}) => {
    const unsigned = AgentBindingReceiptSchema.parse({ schemaVersion: 1, receiptId: `binding-${handle.requestId}`, issuerId: "native-host", handle,
      correlation: { token: message.message_id, provenance: "transport", verified: true }, observedAt: new Date().toISOString(),
      signature: { algorithm: "ed25519", value: Buffer.alloc(64).toString("base64") } });
    const receipt = AgentBindingReceiptSchema.parse({ ...unsigned, signature: { algorithm: "ed25519",
      value: sign(null, receiptSigningBytes(unsigned), keys.privateKey).toString("base64") } });
    const envelope = (type: RoleMessage["type"], payload: unknown, suffix: string) => RoleMessageSchema.parse({
      schema_version: 2, message_id: `native-${suffix}`, correlation_id: message.correlation_id, causation_id: message.message_id,
      run_id: message.run_id, sender: { role: binding.role, agent_id: binding.agentId, pane_id: binding.paneId },
      recipient: { role: "runtime" }, type, payload, artifact_references: [], idempotency_key: `native-${suffix}`, ...overrides });
    const bound = envelope("execution.receipt", receipt, "binding"); authenticated.add(digest(bound)); await bridge.receive(bound);
    const output = envelope("spec.draft", { kind: "extension.result", requestId: handle.requestId, output: { questions: [] } }, "output");
    authenticated.add(digest(output)); await bridge.receive(output);
    return { receipt, bound, output };
  };
  return { root, journal, registry, transport, binding, artifactStore, options, intent, create, deliver,
    trust: (message: RoleMessage) => authenticated.add(digest(message)), revoke: () => { authorized = false; } };
}

describe("native extension delivery", () => {
  it("admits provider prompts only for the exact persisted native assignment and current pane/session", async () => {
    const f = await fixture(), bridge = f.create(), request = await bridge.prepare(f.intent);
    expect(bridge.validatePrompt).toBeTypeOf("function");
    const original = await f.journal.exclusive(async state => structuredClone(state.outbound[0]!.message));
    await expect(bridge.validatePrompt(original, f.binding)).rejects.toThrow(/accepted|dispatch/i);
    await bridge.dispatch(request);
    await expect(bridge.validatePrompt(original, f.binding)).resolves.toBeUndefined();
    await expect(bridge.validatePrompt({ ...original, payload: { instruction: "different" } }, f.binding)).rejects.toThrow(/changed|match/i);
    await expect(bridge.validatePrompt(original, { ...f.binding, session: { ...f.binding.session!, value: "another-native-session" } }))
      .rejects.toThrow(/session|binding|target/i);
    const snapshot = await bridge.snapshot();
    expect(snapshot.outbound[0]).toMatchObject({ request, status: "accepted" });
    expect(f.transport.sentRequests).toHaveLength(1);
  });
  it("persists the actual prepared request and lease before send, then retains the immutable returned handle", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent);
    expect(f.transport.sentRequests).toHaveLength(0);
    f.transport.customSendHandler = req => {
      expect(req).toEqual(request);
      const retained = JSON.parse(readFileSync(join(f.root, "delivery/state.json"), "utf8"));
      expect(retained.outbound[0]).toMatchObject({ status: "sending", request });
      expect(retained.outbound[0].lease.fencingToken).toBeGreaterThan(0);
      return { ok: true, value: { status: "accepted", requestId: req.requestId, attemptId: req.attemptId, runId: req.runId,
        taskId: req.taskId, observedAt: new Date().toISOString(), handle: { executionId: "real-returned-execution",
          requestId: req.requestId, attemptId: req.attemptId, runId: req.runId, taskId: req.taskId, idempotencyKey: req.idempotency.key,
          target: req.target, correlation: { token: req.requestId, provenance: "transport", verified: true }, acceptedAt: new Date().toISOString() } } };
    };
    const handle = await bridge.dispatch(request);
    expect(handle.executionId).toBe("real-returned-execution");
    const state = await f.journal.exclusive(async state => state);
    expect(state.runs).toHaveLength(0); // Delivery WAL is not a second workflow engine.
    expect(state.outbound[0]).toMatchObject({ request, handle, status: "accepted" });
    expect(await f.create().dispatch(request)).toEqual(handle);
    expect(f.transport.sentRequests).toHaveLength(1);
  });

  it("recovers a Registry acquisition acknowledgement lost before request persistence", async () => {
    const f = await fixture(); const acquire = f.registry.acquireLease.bind(f.registry); let lose = true;
    f.registry.acquireLease = async (request, operation) => {
      const result = await acquire(request, operation);
      if (lose) { lose = false; throw new Error("Registry acknowledgement lost"); }
      return result;
    };
    await expect(f.create().prepare(f.intent)).rejects.toThrow("Registry acknowledgement lost");
    const prepared = await f.create().prepare(f.intent);
    const handle = await f.create().dispatch(prepared);
    expect(handle.requestId).toBe(prepared.requestId);
    expect(f.transport.sentRequests).toHaveLength(1);
  });

  it("holds a lost acknowledgement across restart and permits a send only after not_delivered reconciliation", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent);
    f.transport.customSendHandler = () => { throw new Error("Acknowledgement lost"); };
    await expect(bridge.dispatch(request)).rejects.toThrow(/unknown|reconcil/i);
    await expect(f.create().dispatch(request)).rejects.toThrow(/unknown|reconcil/i);
    expect(f.transport.sentRequests).toHaveLength(1);
    f.transport.customReconcileHandler = req => ({ ok: true, value: { status: "not_delivered", requestId: req.requestId,
      retrySafe: true, observedAt: new Date().toISOString() } });
    expect(await f.create().reconcile(request.requestId)).toEqual({ status: "not_delivered" });
    f.transport.customSendHandler = undefined;
    await f.create().dispatch(request);
    expect(f.transport.sentRequests).toHaveLength(2);
  });

  it("rechecks current authority and the Registry fence after preparation before transport", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent);
    const lease = await f.journal.exclusive(async state => state.outbound[0]!.lease!);
    unwrap(await f.registry.releaseLease(ReleaseAgentLeaseRequestSchema.parse({ leaseId: lease.leaseId, fencingToken: lease.fencingToken,
      expectedVersion: lease.version, releasedAt: new Date().toISOString(), idempotencyKey: "release-before-send" })));
    await expect(bridge.dispatch(request)).rejects.toThrow();
    expect(f.transport.sentRequests).toHaveLength(0);
    f.revoke(); await expect(bridge.prepare({ ...f.intent, requestKey: "revoked" })).rejects.toThrow("authority");
  });

  it("does not send if the fence is revoked during the last awaited authority check", async () => {
    const f = await fixture(); let checks = 0;
    f.options.authorize = async () => {
      if (++checks !== 3) return;
      const state = JSON.parse(readFileSync(join(f.root, "delivery/state.json"), "utf8")), lease = state.outbound[0].lease;
      unwrap(await f.registry.releaseLease(ReleaseAgentLeaseRequestSchema.parse({ leaseId: lease.leaseId,
        fencingToken: lease.fencingToken, expectedVersion: lease.version, releasedAt: new Date().toISOString(),
        idempotencyKey: "revoke-during-authority-check" })));
    };
    const bridge = f.create(), request = await bridge.prepare(f.intent);
    await expect(bridge.dispatch(request)).rejects.toThrow();
    expect(f.transport.sentRequests).toHaveLength(0);
  });

  it("accepts only authenticated correlated output with a genuine binding signature and stored evidence", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent), handle = await bridge.dispatch(request);
    const raw = RoleMessageSchema.parse({ schema_version: 2, message_id: "untrusted", correlation_id: "corr-native",
      causation_id: f.intent.message.message_id, run_id: "run-native", sender: { role: "specifier", agent_id: f.binding.agentId,
        pane_id: f.binding.paneId }, recipient: { role: "runtime" }, type: "spec.draft", payload: { kind: "extension.result",
        requestId: request.requestId, output: { questions: [] } }, artifact_references: [], idempotency_key: "untrusted" });
    await expect(bridge.receive(raw)).rejects.toThrow(/authentic/i);
    const { receipt } = await f.deliver(bridge, handle);
    const outcome = await f.create().waitResult(request.requestId);
    expect(outcome).toMatchObject({ handle, receipt, output: { questions: [] }, sender: { role: "specifier", agent_id: f.binding.agentId } });
    expect(outcome.evidence.trust).toBe("stored");
    const chunks: Uint8Array[] = [];
    for await (const item of f.artifactStore.get(outcome.evidence)) chunks.push(unwrap(item));
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ questions: [] });
  });

  it("rejects a signed envelope from the wrong native actor without completing the accepted execution", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent), handle = await bridge.dispatch(request);
    await expect(f.deliver(bridge, handle, { sender: { role: "specifier", agent_id: "other-analyst", pane_id: "w2:p4" } }))
      .rejects.toThrow(/binding|sender|actor/i);
    expect(await bridge.reconcile(request.requestId)).toEqual({ status: "bound", handle });
  });

  it("retains an early authenticated output until its actual binding receipt arrives", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent), handle = await bridge.dispatch(request);
    const early = RoleMessageSchema.parse({ schema_version: 2, message_id: "native-output", correlation_id: "corr-native",
      causation_id: f.intent.message.message_id, run_id: "run-native", sender: { role: "specifier", agent_id: f.binding.agentId,
        pane_id: f.binding.paneId }, recipient: { role: "runtime" }, type: "spec.draft", payload: { kind: "extension.result",
        requestId: request.requestId, output: { questions: [] } }, artifact_references: [], idempotency_key: "native-output" });
    f.trust(early); await expect(bridge.receive(early)).rejects.toThrow(/binding receipt/i);
    expect(await f.journal.exclusive(async state => state.inbox.find(item => item.message.message_id === early.message_id)?.status)).toBe("received");
    await f.deliver(bridge, handle);
    expect((await f.create().waitResult(request.requestId)).output).toEqual({ questions: [] });
  });

  it("acknowledges the exact immutable result once even after its task authority was revoked", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent), handle = await bridge.dispatch(request);
    const sent = await f.deliver(bridge, handle), first = await bridge.waitResult(request.requestId);
    f.revoke(); await bridge.receive(sent.bound); await bridge.receive(sent.output);
    expect((await bridge.waitResult(request.requestId)).evidence).toEqual(first.evidence);
    expect(await f.journal.exclusive(async state => state.inbox.filter(item => item.message.message_id === sent.output.message_id).length)).toBe(1);
  });

  it("rejects a binding signature from another trusted-key context", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent), handle = await bridge.dispatch(request);
    f.options.bindingReceiptKeys["native-host"] = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    await expect(f.deliver(bridge, handle)).rejects.toThrow(/signature|authentic/i);
  });

  it("refuses internal Runtime tasks and paths outside the normalized read scope before sending", async () => {
    const f = await fixture(), bridge = f.create();
    await expect(bridge.prepare({ ...f.intent, taskId: "publication", outputKind: "analysis.publication" })).rejects.toThrow(/scope/i);
    await expect(bridge.prepare({ ...f.intent, allowedReadPaths: ["../private"] })).rejects.toThrow();
    expect(f.transport.sentRequests).toHaveLength(0);
  });

  it("recovers a real process exit after server acceptance but before the returned handle was persisted", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent);
    const worker = `
      import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
      import {createNativeExtensionRolePort} from '@bflow/runtime';
      import {FileAgentRegistry} from '@bflow/agent-registry'; import {openFilesystemArtifactStore} from '@bflow/artifact-store';
      import {AgentExecutionHandleSchema,AgentRequestSchema,AgentSubmissionReceiptSchema,PaneBindingSchema} from '@bflow/contracts';
      const input=JSON.parse(process.argv[1]),binding=PaneBindingSchema.parse(input.binding);
      const opened=await openFilesystemArtifactStore({root:join(input.root,'artifacts'),storeId:'native-extension'});
      if(!opened.ok)throw new Error(opened.error.message);
      const port=createNativeExtensionRolePort({repositoryPath:join(input.root,'repo'),journalDirectory:join(input.root,'delivery'),
        sessionId:'session-native',registry:new FileAgentRegistry({stateFile:join(input.root,'registry.json')}),artifactStore:opened.value,
        panes:{getRoleBinding:async()=>({ok:true,value:binding}),inspectRoleHealth:async()=>({ok:true,value:{readyForPrompt:true,
          occupantMatches:true,paneId:binding.paneId,agentId:binding.agentId}})},authorize:async()=>{},preflight:async()=>{},
        authenticateMessage:async()=>false,bindingReceiptKeys:input.keys,
        transport:{send:async req=>{const handle=AgentExecutionHandleSchema.parse({executionId:'accepted-before-process-exit',
          requestId:req.requestId,attemptId:req.attemptId,runId:req.runId,taskId:req.taskId,idempotencyKey:req.idempotency.key,
          target:req.target,correlation:{token:req.requestId,provenance:'transport',verified:true},acceptedAt:new Date().toISOString()});
          const receipt=AgentSubmissionReceiptSchema.parse({status:'accepted',requestId:req.requestId,attemptId:req.attemptId,
            runId:req.runId,taskId:req.taskId,observedAt:new Date().toISOString(),handle});
          await writeFile(join(input.root,'server-receipt.json'),JSON.stringify(receipt));process.exit(97);}}});
      await port.dispatch(AgentRequestSchema.parse(input.request));process.exit(3);
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker, JSON.stringify({ root: f.root,
      binding: f.binding, keys: f.options.bindingReceiptKeys, request })], { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let stderr = ""; child.stderr.on("data", chunk => { stderr += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    expect(code, stderr).toBe(97);
    expect(await f.journal.exclusive(async state => state.outbound[0]!.status)).toBe("sending");
    await expect(f.create().dispatch(request)).rejects.toThrow(/unknown|reconcil/i);
    const actual = JSON.parse(readFileSync(join(f.root, "server-receipt.json"), "utf8"));
    f.transport.customReconcileHandler = () => ({ ok: true, value: { status: "bound", handle: actual.handle } });
    expect(await f.create().reconcile(request.requestId)).toEqual({ status: "bound", handle: actual.handle });
    expect(await f.create().dispatch(request)).toEqual(actual.handle);
    expect(f.transport.sentRequests).toHaveLength(0);
    await f.deliver(bridge, actual.handle);
    expect((await bridge.waitResult(request.requestId)).handle.executionId).toBe("accepted-before-process-exit");
  });

  it("refuses a corrupted output projection that no longer matches the native message and stored artifact", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent), handle = await bridge.dispatch(request);
    await f.deliver(bridge, handle);
    await f.journal.exclusive(async (state, save) => {
      const projection = state.inbox.find(item => item.message.sender.role === "runtime" &&
        record(item.message.payload).kind === "extension.output.recorded")!;
      projection.message = RoleMessageSchema.parse({ ...projection.message, payload: { kind: "extension.output.recorded",
        requestId: request.requestId, data: { sender: { role: "specifier", agent_id: f.binding.agentId, pane_id: f.binding.paneId },
          output: { questions: [{ id: "injected", question: "Not the actual native output", blocking: false }] } } } });
      await save();
    });
    await expect(f.create().waitResult(request.requestId)).rejects.toThrow(/projection|evidence|integrity|output/i);
  });

  it("recovers result persistence when the lease-release acknowledgement is lost", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent), handle = await bridge.dispatch(request);
    const release = f.registry.releaseLease.bind(f.registry); let lose = true;
    f.registry.releaseLease = async (input, operation) => {
      const result = await release(input, operation);
      if (lose) { lose = false; throw new Error("Release acknowledgement lost"); }
      return result;
    };
    await expect(f.deliver(bridge, handle)).rejects.toThrow("Release acknowledgement lost");
    const outcome = await f.create().waitResult(request.requestId);
    expect(outcome.output).toEqual({ questions: [] });
    expect(await f.journal.exclusive(async state => state.outbound[0]!.status)).toBe("released");
    expect(f.transport.sentRequests).toHaveLength(1);
  });

  it("does not return native acceptance when its actual evidence is unavailable in ArtifactStore", async () => {
    const f = await fixture(), bridge = f.create(); const request = await bridge.prepare(f.intent), handle = await bridge.dispatch(request);
    await f.deliver(bridge, handle); const outcome = await bridge.waitResult(request.requestId);
    const get = f.artifactStore.get.bind(f.artifactStore);
    f.artifactStore.get = (reference, operation) => get(reference.artifactId === outcome.evidence.artifactId
      ? { ...reference, artifactId: "absent-native-output", uri: reference.uri.replace(/[^/]+$/, "absent-native-output") } : reference, operation);
    await expect(f.create().waitResult(request.requestId)).rejects.toThrow(/evidence|integrity/i);
  });
});
