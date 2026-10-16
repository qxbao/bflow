import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { SessionManifestSchema, type ApprovalDecision, type QualityGate, type RoleMessage } from "@bflow/contracts";
import { AgenticWorkflowRuntime } from "./runtime.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "./ports.js";
import { createAgenticConversationHost, type AgenticConversationHost } from "./conversation.js";
import { startHerdrReceiptIngress, authenticateNativeHerdrMessage } from "./herdr-ingress.js";
import { CoordinatorTools } from "./tools.js";
import { record } from "./journal.js";
import { unwrap } from "./outbox.js";

export interface OpenAgenticWorkspaceOptions {
  repositoryPath: string; sessionId: string; herdrBinary?: string;
  bindingReceiptKeys?: Readonly<Record<string, string>>;
  nativeIngressSocket?: string;
  /** Existing P12/P13 session manifests; defaults to .bflow/state/panes. No duplicate topology is created. */
  manifestDirectory?: string; storageDirectory?: string; maxDeveloperCapacity?: number;
  roleCapabilities: AgenticRuntimePorts["roleCapabilities"];
  taskChecks: AgenticRuntimePorts["taskChecks"]; workflowChecks: AgenticRuntimePorts["workflowChecks"];
  /** Deterministic host runners. Review checks are always routed through Herdr. */
  deterministicGates: readonly QualityGate[];
  authenticateMessage: AgenticRuntimePorts["authenticateMessage"];
  authenticateResult: AgenticRuntimePorts["authenticateResult"];
  authenticateEvidence: AgenticRuntimePorts["authenticateEvidence"];
  authenticateGateResult: AgenticRuntimePorts["authenticateGateResult"];
  authorizeHuman: AgenticRuntimePorts["authorizeHuman"];
  projectApprovalRequired?: AgenticRuntimePorts["projectApprovalRequired"];
  onHumanDecision?: (decision: ApprovalDecision) => Promise<void>;
  onNativeDelivery?: (message: RoleMessage) => Promise<void>;
  /** Provider launch configuration used for dynamic Developer panes. */
  roleLaunch?: Record<string, { systemPrompt: string; mcpConfigFile: string; hooksSettingsFile: string }>;
}
export interface AgenticWorkspaceHandle {
  runtime: AgenticWorkflowRuntime; conversation: AgenticConversationHost; tools: CoordinatorTools;
  close(): Promise<void>;
}
/** Actual P12 session + P13 panes + P14 dialogue + P15–P18 policies + existing Core/SQLite/Registry/ArtifactStore. */
export async function openAgenticWorkspace(options: OpenAgenticWorkspaceOptions): Promise<AgenticWorkspaceHandle> {
  const repository = await realpath(options.repositoryPath);
  const paneModule = await import(new URL("../../../pane-manager/dist/index.js", import.meta.url).href);
  const herdrModule = await import(new URL("../../../herdr-adapter/dist/index.js", import.meta.url).href);
  const coreModule = await import(new URL("../../../core/dist/index.js", import.meta.url).href);
  const persistenceModule = await import(new URL("../../../persistence/dist/index.js", import.meta.url).href);
  const artifactsModule = await import(new URL("../../../artifact-store/dist/index.js", import.meta.url).href);
  const registryModule = await import(new URL("../../../agent-registry/dist/index.js", import.meta.url).href);
  const manifestStore = new paneModule.FileSessionManifestStore(options.manifestDirectory ?? resolve(repository, ".bflow/state/panes"));
  const manifest = SessionManifestSchema.parse(unwrap(await manifestStore.load(options.sessionId)));
  if (manifest.workspaceRoot !== repository || manifest.sessionId !== options.sessionId || manifest.status !== "up")
    throw new Error("Run bflow up for this repository/session before opening its Agentic Runtime");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("HERDR_") && key !== "HERDR_CONFIG_PATH") delete env[key];
  env.HERDR_SESSION = options.sessionId;
  const baseRunner = paneModule.createProcessRunner(options.herdrBinary ?? "herdr");
  const runner = { run: (invocation: { args: readonly string[]; signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number }) =>
    baseRunner.run({ ...invocation, cwd: repository, env }) };
  const transport = herdrModule.createHerdrAdapter({ runner });
  // Verify the available Herdr version/protocol before opening persistent resources or allocating agents.
  unwrap(await transport.initialize({ runtimeId: `p19-${options.sessionId}`, configuration: {}, recoveryMode: true, initializedAt: new Date().toISOString() }));
  const roleConfigs: Record<string, unknown> = {};
  for (const [role, launch] of Object.entries(options.roleLaunch ?? {})) {
    const args = await paneModule.buildProviderRoleLaunchFromFiles({ ...launch, agentKind: manifest.panes.find(p => p.role === "coordinator")!.agentKind, role });
    roleConfigs[role] = { args };
  }
  const panes: PanePolicy = new paneModule.RolePaneManager({ config: { sessionId: options.sessionId,
    projectName: manifest.projectName, workspaceRoot: repository, conversationSessionId: manifest.conversationSessionId,
    maxDeveloperCapacity: options.maxDeveloperCapacity ?? 2,
    defaultAgentKind: manifest.panes.find(p => p.role === "coordinator")!.agentKind,
    roleConfigs }, runner, store: manifestStore });
  const directory = options.storageDirectory ?? resolve(repository, ".bflow/state/agentic");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runStore = unwrap<any>(persistenceModule.openSqliteRunStore({ filename: resolve(directory, "runs.db") }));
  let artifactStore: any;
  try {
    artifactStore = unwrap(await artifactsModule.openFilesystemArtifactStore({ root: resolve(directory, "artifacts"), storeId: options.sessionId }));
    let runtime: AgenticWorkflowRuntime;
    const approvedBundles = new Map<string, ApprovalDecision>();
    const checks = [...options.taskChecks, ...options.workflowChecks];
    const reviewIds = [...new Set(checks.filter(check => record(check.configuration).kind === "review").map(check => check.id))];
    const gates = [...options.deterministicGates.filter(gate => !reviewIds.includes(gate.id)), ...reviewIds.map(id => ({ id,
      evaluate: (...args: Parameters<QualityGate["evaluate"]>) => runtime.herdrQualityGate(id).evaluate(...args) }))];
    const policies = await loadAgenticPolicies({ repositoryPath: repository, artifactStore, gates,
      loadSpecification: id => runtime.loadSpecification(id),
      authorizeApprover: (decision, humanRequired) => {
        if (!humanRequired && decision.decidedBy === "coordinator") return true;
        const approvalId = decision.metadata?.approvedBundleId;
        const source = typeof approvalId === "string" ? approvedBundles.get(approvalId) : undefined;
        return source?.decision === "approved" && source.runId === decision.runId && source.sessionId === decision.sessionId &&
          source.decidedBy === decision.decidedBy && source.decidedAt === decision.decidedAt;
      } });
    runtime = new AgenticWorkflowRuntime({ engine: new coreModule.DeterministicWorkflowEngine({ bindingReceiptKeys: options.bindingReceiptKeys }), runStore, artifactStore,
      registry: new registryModule.FileAgentRegistry({ stateFile: resolve(directory, "registry.json") }), transport, panes, policies,
      roleCapabilities: options.roleCapabilities, maxConcurrency: options.maxDeveloperCapacity ?? 2, taskChecks: options.taskChecks, workflowChecks: options.workflowChecks,
      authenticateMessage: async message => await authenticateNativeHerdrMessage(message) || await options.authenticateMessage(message), authenticateResult: options.authenticateResult,
      authenticateEvidence: options.authenticateEvidence, authenticateGateResult: options.authenticateGateResult,
      authorizeHuman: async decision => { const authorized = await options.authorizeHuman(decision);
        if (authorized) approvedBundles.set(decision.approvalId, decision); return authorized; },
      ...(options.projectApprovalRequired ? { projectApprovalRequired: options.projectApprovalRequired } : {})
    }, { journalDirectory: resolve(directory, "journal"), repositoryPath: repository });
    await runtime.initialize();
    const conversation = await createAgenticConversationHost({ runtime, manifest, contextDirectory: resolve(directory, "conversation"), ...(options.onHumanDecision ? { onHumanDecision: options.onHumanDecision } : {}) });
    const tools = new CoordinatorTools(runtime);
    const ingress = options.nativeIngressSocket ? await startHerdrReceiptIngress({ socketPath: options.nativeIngressSocket,
      publicKeys: options.bindingReceiptKeys ?? {}, receive: async message => {
        const result = message.recipient.role === "conversation" ? await conversation.receiveHerdr(message) : await runtime.receiveHerdr(message);
        await options.onNativeDelivery?.(message); return result;
      } }) : undefined;
    return { runtime, conversation, tools, async close() { await tools.drain(); await ingress?.close(); artifactStore.close(); runStore.close(); } };
  } catch (error) { artifactStore?.close(); runStore.close(); throw error; }
}
