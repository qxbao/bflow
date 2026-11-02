import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { DeterministicWorkflowEngine } from "@bflow/core";
import { FileAgentRegistry } from "@bflow/agent-registry";
import { openFilesystemArtifactStore } from "@bflow/artifact-store";
import { openSqliteRunStore } from "@bflow/persistence";
import { AgentBindingReceiptSchema, AgentConfigurationSchema, PaneBindingSchema, RoleMessageSchema, receiptSigningBytes,
  type AgentExecutionHandle, type AgentRequest, type OperationResult } from "@bflow/contracts";
import { AnalysisWorkflowRuntime, QaWorkflowRuntime, buildAnalysisPack, createNativeExtensionRolePort } from "../../src/index.js";
import type { NativeExtensionRolePort } from "../../src/agentic/extension-delivery.js";
import { AppCheckBrowserLeases } from "../../src/agentic/app-check-lease.js";
import { FakeAgentTransport } from "./fake-transport.js";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const value = <T>(result: OperationResult<T>): T => { if (!result.ok) throw new Error(result.error.message); return result.value; };

export async function nativeExtensionFixture(family: "analysis" | "qa", sessionId = "session-native") {
  const root = await mkdtemp(join(tmpdir(), "bflow-extension-sdk-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"); await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/health.ts"), "export const healthy = true;\n");
  const journalPath = join(root, "native-sdk.json");
  const runStore = value(openSqliteRunStore({ filename: join(root, "runs.db") })); cleanups.push(() => runStore.close());
  const artifactStore = value(await openFilesystemArtifactStore({ root: join(root, "artifacts"), storeId: "native-sdk" }));
  const keys = generateKeyPairSync("ed25519");
  const bindingReceiptKeys = { host: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const registry = new FileAgentRegistry({ stateFile: join(root, "registry.json") });
  const transport = new FakeAgentTransport();
  const panes = new Map<string, ReturnType<typeof PaneBindingSchema.parse>>();
  for (const [role, capability] of [["architect", "architecture"], ["specifier", "specification"], ["reviewer", "review"], ["tester", "testing"], ["qa", "testing"]]) {
    const pane = PaneBindingSchema.parse({ schemaVersion: 2, bindingId: `binding-${role}`, sessionId: sessionId, role,
      agentId: `actual-${role}`, paneId: `w:${role}`, workspaceId: "w", tabId: "w:t", provider: "codex", agentKind: "codex",
      cwd: repo, isolationMode: "dedicated_pane", readOnlyWorkspace: true, permanent: true, transportState: "idle",
      boundAt: new Date().toISOString(), session: { source: "herdr:codex", kind: "id", value: `native-${role}` } });
    panes.set(role!, pane);
    value(await registry.upsert(AgentConfigurationSchema.parse({ agentId: pane.agentId, role, transport: "herdr", enabled: true,
      priority: 0, maxConcurrentTasks: 1, capabilities: ["repository.read", capability], settings: {} })));
  }
  const requests = new Map<string, AgentRequest>(), handles = new Map<string, AgentExecutionHandle>();
  let loseAck = false, missingReceipt = false;
  transport.customSendHandler = request => {
    requests.set(request.requestId, request);
    const handle: AgentExecutionHandle = { executionId: `herdr-${request.taskId}`, requestId: request.requestId, attemptId: request.attemptId,
      runId: request.runId, taskId: request.taskId, idempotencyKey: request.idempotency.key, target: request.target,
      correlation: { token: request.requestId, provenance: "orchestrator", verified: false }, acceptedAt: new Date().toISOString() };
    handles.set(request.requestId, handle);
    if (loseAck) { loseAck = false; throw new Error("lost acknowledgement after native acceptance"); }
    return { ok: true, value: { status: "accepted", requestId: request.requestId, attemptId: request.attemptId,
      runId: request.runId, taskId: request.taskId, observedAt: handle.acceptedAt, handle } };
  };
  transport.customReconcileHandler = request => ({ ok: true, value: { status: "bound", handle: handles.get(request.requestId)! } });
  let bridge: NativeExtensionRolePort;
  const createBridge = () => createNativeExtensionRolePort({ repositoryPath: repo, journalDirectory: join(root, "delivery"),
    sessionId: sessionId, registry, transport, artifactStore, bindingReceiptKeys,
    authorize: async () => {}, preflight: async () => {}, authenticateMessage: async () => true,
    panes: { getRoleBinding: async role => ({ ok: true, value: panes.get(role)! }), inspectRoleHealth: async selector => {
      const pane = [...panes.values()].find(item => item.bindingId === selector)!;
      return { ok: true, value: { readyForPrompt: true, occupantMatches: true, paneId: pane.paneId, agentId: pane.agentId } };
    } } });
  bridge = createBridge();
  const native: NativeExtensionRolePort = {
    snapshot: () => bridge.snapshot(), validatePrompt: (message, binding) => bridge.validatePrompt(message, binding),
    prepare: intent => bridge.prepare(intent), dispatch: request => bridge.dispatch(request), receive: message => bridge.receive(message),
    reconcile: id => bridge.reconcile(id),
    waitResult: async id => {
      const request = requests.get(id)!, handle = handles.get(id)!, wire = RoleMessageSchema.parse(request.context);
      const assignment = (wire.payload as { intent: { message: { payload: Record<string, any> } } }).intent.message.payload;
      const output = request.taskId === "survey" ? { observations: [{ path: "src/health.ts", note: "Health state exists" }] } : request.taskId === "elicitation" ? { questions: [] }
        : request.taskId === "design" ? { design: { schemaVersion: 1, title: "Health design", cases: [{ id: "TC-1", title: "Health",
          criterionIds: ["AC-1"], sideEffect: "none", expected: "healthy", steps: [{ kind: "http", method: "GET", url: "/health", expect: { status: 200 } }], cleanup: [] }],
          criteriaCoverage: [{ criterionId: "AC-1", caseIds: ["TC-1"] }] } }
        : { verdict: "approved", designDigest: assignment.context.design.digest, findings: [] };
      const envelope = (type: "execution.receipt" | "spec.draft", payload: unknown) => RoleMessageSchema.parse({ schema_version: 2,
        message_id: `${type}-${id}`, correlation_id: wire.correlation_id, causation_id: wire.message_id, run_id: request.runId,
        sender: wire.recipient, recipient: { role: "runtime" }, type, payload, artifact_references: [], idempotency_key: `${type}-${id}` });
      const unsigned = AgentBindingReceiptSchema.parse({ schemaVersion: 1, receiptId: `receipt-${id}`, issuerId: "host", handle,
        correlation: { token: wire.message_id, provenance: "transport", verified: true }, observedAt: new Date().toISOString(),
        signature: { algorithm: "ed25519", value: Buffer.alloc(64).toString("base64") } });
      const receipt = { ...unsigned, signature: { algorithm: "ed25519", value: sign(null, receiptSigningBytes(unsigned), keys.privateKey).toString("base64") } };
      if (!missingReceipt) await bridge.receive(envelope("execution.receipt", receipt));
      await bridge.receive(envelope("spec.draft", { kind: "extension.result", requestId: id, output }));
      return bridge.waitResult(id);
    }
  };
  const roles = { native, dispatch: async () => { throw new Error("legacy logical delivery must never be selected"); } };
  const open = async () => {
    bridge = createBridge();
    const engine = new DeterministicWorkflowEngine({ bindingReceiptKeys });
    const common = { engine, runStore, artifactStore, roles, repositoryRoot: repo, journalPath,
      authorizeHuman: () => true, now: () => new Date().toISOString() };
    const sdk = family === "analysis" ? await AnalysisWorkflowRuntime.open(common) : await QaWorkflowRuntime.open({ ...common,
      tools: {}, grants: [], leases: new AppCheckBrowserLeases(join(root, "leases")) });
    return { sdk, engine };
  };
  const start = async (sdk: AnalysisWorkflowRuntime | QaWorkflowRuntime) => {
    if (sdk instanceof AnalysisWorkflowRuntime) {
      const pack = buildAnalysisPack({ id: "native-ba", version: "1" });
      await sdk.start({ runId: "run-native", pack, packPin: { id: pack.id, version: pack.version, digest: pack.digest }, intake: {
        schemaVersion: 1, requestId: "ba-native", sessionId: sessionId, title: "Native BA", userStatements: [{ id: "U-1", text: "Specify health" }],
        deliverables: ["scope", "functional_requirements", "acceptance_criteria", "nfr", "business_flows", "glossary"],
        acceptanceCriteria: [{ id: "AC-1", description: "Traceable health specification", required: true }],
        requiredDecisions: [{ id: "D-1", question: "Who owns health?", blocking: true }], surveyPaths: ["src"], documentRoot: "docs/ba" } });
    } else await sdk.start({ runId: "run-native", intake: { schemaVersion: 1, requestId: "qa-native", sessionId: sessionId, title: "Native QA",
      userStatements: [{ id: "U-1", text: "Check health without changing the product" }],
      target: { environmentId: "fixture", kind: "fixture", origins: ["http://127.0.0.1:8123"], readinessPath: "/health" },
      criteria: [{ id: "AC-1", description: "Health returns HTTP 200" }], allowedActions: ["http_read"], accountPolicy: { accounts: [] },
      dataPolicy: { fixturePrefix: "native-qa", redactKeys: [] }, cleanup: { required: true }, workspace: { assetRoot: "qa" }, protectedPaths: [] } });
  };
  return { root, repo, runStore, artifactStore, native, open, start, transport, handles, journalPath, loseAck: () => { loseAck = true; }, omitReceipt: () => { missingReceipt = true; } };
}

