import { resolvePrivateRuntimeStateDirectory } from "../private-state.js";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ApprovalDecisionSchema, SessionManifestSchema, type ApprovalDecision, type OperationOptions, type OperationResult, type QualityGate, type RoleMessage
} from "@bflow/contracts";
import { AgenticWorkflowRuntime } from "./runtime.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "./ports.js";
import { createAgenticConversationHost, type AgenticConversationHost } from "./conversation.js";
import { startHerdrReceiptIngress, authenticateNativeHerdrMessage } from "./herdr-ingress.js";
import { CoordinatorTools } from "./tools.js";
import { record } from "./journal.js";
import { unwrap } from "./outbox.js";
import type { ReachabilityVerdict } from "./tool-reachability.js";

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
  /** Called after Conversation applied a Runtime outbox message; the host records it as a durable notice for the model. */
  onConversationNotice?: (message: RoleMessage) => Promise<void>;
  authenticateResult: AgenticRuntimePorts["authenticateResult"];
  authenticateEvidence: AgenticRuntimePorts["authenticateEvidence"];
  authenticateGateResult: AgenticRuntimePorts["authenticateGateResult"];
  authorizeHuman: AgenticRuntimePorts["authorizeHuman"];
  projectApprovalRequired?: AgenticRuntimePorts["projectApprovalRequired"];
  onHumanDecision?: (decision: ApprovalDecision) => Promise<void>;
  recoveredHumanDecisions?: readonly ApprovalDecision[];
  onNativeDelivery?: (message: RoleMessage) => Promise<void>;
  /** Provider launch configuration used for dynamic Developer panes. */
  roleLaunch?: Record<string, { systemPrompt: string; mcpConfigFile: string; hooksSettingsFile: string }>;
  /** P30: per-task Developer launch material from the platform readiness service; absent for legacy hosts. */
  developerLaunches?: DeveloperLaunchPort;
}
/** Launch material for one Developer task. `env` may carry bearer tokens: it is passed to Herdr only, never persisted. */
export interface DeveloperLaunchPort {
  allocate(request: { taskId: string; worktreePath: string }): Promise<{ provider: string; argv: readonly string[]; env: Readonly<Record<string, string>>; launchId: string; launchFingerprint: string }>;
  release(taskId: string): Promise<void>;
  /**
   * Reachability verdict of one launch's in-process Gateway probes, for the pane allocated to it. Throws for a launch
   * that is not active. Pane Manager stays unaware of Gateway: the verdict is computed by the host session.
   */
  reachability(launchId: string, paneId: string): Promise<ReachabilityVerdict>;
  /** Launches whose Gateway registration was lost (permanent roles by name, Developers by launch id). */
  degradation?(): { readonly roles: readonly string[]; readonly launchIds: readonly string[] };
}
/** Bound on waiting for a new Developer's provider process to prove Gateway reachability (Pane Manager's default operation timeout). */
export const DEVELOPER_STARTUP_TIMEOUT_MS = 30_000;
export interface DeveloperLaunchOptions {
  readonly startupTimeoutMs?: number;
  readonly now?: () => number;
}
type AllocatedPane = Extract<Awaited<ReturnType<PanePolicy["allocateDeveloper"]>>, { ok: true }>["value"];
interface PendingDeveloper { readonly taskId: string; readonly launchId: string; readonly allocated: AllocatedPane; readonly since: number }
/**
 * Pane policy whose Developer allocation carries a readiness-approved launch and whose release drops it.
 * A refused allocation releases its prepared launch so no Gateway registration or intent is leaked, and a
 * launched Developer pane is closed on release: its bearer token is revoked with the launch, so the running
 * agent must not be reused with a later launch.
 *
 * Dispatch gate: after the pane exists, the Developer must prove in-process Gateway reachability before its binding
 * is returned. While unproven the allocation is a retryable conflict; the allocated pane and launch are kept, so a
 * retry resumes the same launch instead of preparing another. A failed proof, or no proof within the startup
 * timeout, releases the launch and pane and is a non-retryable validation error.
 */
export function withDeveloperLaunches(base: PanePolicy, launches: DeveloperLaunchPort, launchOptions: DeveloperLaunchOptions = {}): PanePolicy {
  const timeoutMs = launchOptions.startupTimeoutMs ?? DEVELOPER_STARTUP_TIMEOUT_MS;
  const now = launchOptions.now ?? Date.now;
  const pending = new Map<string, PendingDeveloper>();
  /** Proven Developers by task: their pane and launch, so a degraded launch can be held back from new prompts. */
  const ready = new Map<string, { readonly paneId: string; readonly launchId: string }>();
  /** Releases a Developer that failed its gate: pane closed, launch and registrations revoked. Reports a release failure too. */
  const retire = async (taskId: string, callOptions: OperationOptions | undefined): Promise<string | undefined> => {
    pending.delete(taskId); ready.delete(taskId);
    await base.releaseDeveloper({ taskId, closePane: true, removeWorktree: false }, callOptions);
    try { await launches.release(taskId); return undefined; }
    catch (error) { return String(error); }
  };
  const failClosed = async (entry: PendingDeveloper, reason: string, callOptions: OperationOptions | undefined): Promise<OperationResult<AllocatedPane>> => {
    const releaseFailure = await retire(entry.taskId, callOptions);
    return { ok: false, error: { code: "validation", retryable: false,
      message: `Developer ${entry.taskId} ${reason}; its pane and launch were released${releaseFailure === undefined ? "" : `, but the launch release failed: ${releaseFailure}`}` } };
  };
  return {
    getManifest: options => base.getManifest(options),
    getRoleBinding: (role, options) => base.getRoleBinding(role, options),
    // A degraded launch (Gateway registration lost) stays unready: the outbox keeps its messages queued, never drops them.
    async inspectRoleHealth(role, options) {
      const health = await base.inspectRoleHealth(role, options);
      if (!health.ok || !health.value.readyForPrompt || launches.degradation === undefined) return health;
      const degraded = launches.degradation();
      const developer = [...ready.values()].find(item => item.paneId === health.value.paneId);
      if (degraded.roles.includes(role) || (developer !== undefined && degraded.launchIds.includes(developer.launchId)))
        return { ok: true, value: { ...health.value, readyForPrompt: false } };
      return health;
    },
    async allocateDeveloper(request, callOptions) {
      let entry = pending.get(request.taskId);
      if (entry === undefined) {
        let launch;
        try { launch = await launches.allocate({ taskId: request.taskId, worktreePath: request.worktreePath }); }
        catch (error) { return { ok: false, error: { code: "validation", retryable: false, message: String(error) } }; }
        // Carried as a widened value: the PanePolicy request type predates the launch fields Pane Manager accepts.
        const allocation = { ...request, agentKind: launch.provider, launch };
        const allocated = await base.allocateDeveloper(allocation, callOptions);
        if (!allocated.ok) {
          try { await launches.release(request.taskId); } catch { /* the refused allocation's error is the one to report */ }
          return allocated;
        }
        entry = { taskId: request.taskId, launchId: launch.launchId, allocated: allocated.value, since: now() };
        pending.set(request.taskId, entry);
      }
      let verdict: ReachabilityVerdict;
      try { verdict = await launches.reachability(entry.launchId, entry.allocated.paneId); }
      catch (error) { return failClosed(entry, `has no readable reachability record: ${String(error)}`, callOptions); }
      if (verdict.state === "ready") {
        pending.delete(entry.taskId);
        ready.set(entry.taskId, { paneId: entry.allocated.paneId, launchId: entry.launchId });
        return { ok: true, value: entry.allocated };
      }
      if (verdict.state === "pending") {
        if (now() - entry.since < timeoutMs) {
          return { ok: false, error: { code: "conflict", retryable: true,
            message: `Developer ${entry.taskId} has not proven Gateway tool reachability from its provider process yet: ${verdict.reason}`,
            details: { stage: "developer_startup" } } };
        }
        return failClosed(entry, `did not prove Gateway tool reachability within ${timeoutMs} ms (${verdict.reason})`, callOptions);
      }
      return failClosed(entry, `cannot reach Gateway registration ${verdict.registrationId} from its provider process ` +
        `(${verdict.envName}: ${verdict.code}; ${verdict.reason})`, callOptions);
    },
    async releaseDeveloper(request, callOptions) {
      pending.delete(request.taskId); ready.delete(request.taskId);
      const released = await base.releaseDeveloper({ ...request, closePane: true }, callOptions);
      // Already released: the binding is gone, so the launch is already dropped as well.
      if (!released.ok && released.error.code !== "not_found") return released;
      try { await launches.release(request.taskId); }
      catch (error) { return { ok: false, error: { code: "conflict", retryable: true, message: String(error) } }; }
      return released.ok ? released : { ok: true, value: undefined };
    }
  };
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
    const topology = paneModule.getRoleTopologySpec(role);
    if (!topology || topology.contractRole !== role) continue;
    const args = await paneModule.buildProviderRoleLaunchFromFiles({ ...launch, agentKind: manifest.panes.find(p => p.role === "coordinator")!.agentKind, role });
    roleConfigs[topology.topologyRole] = { args };
  }
  const rolePanes: PanePolicy = new paneModule.RolePaneManager({ config: { sessionId: options.sessionId,
    projectName: manifest.projectName, workspaceRoot: repository, conversationSessionId: manifest.conversationSessionId,
    maxDeveloperCapacity: options.maxDeveloperCapacity ?? 2,
    defaultAgentKind: manifest.panes.find(p => p.role === "coordinator")!.agentKind,
    roleConfigs }, runner, store: manifestStore });
  const panes: PanePolicy = options.developerLaunches ? withDeveloperLaunches(rolePanes, options.developerLaunches) : rolePanes;
  const directory = options.storageDirectory ?? resolve(resolvePrivateRuntimeStateDirectory(repository), "agentic");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runStore = unwrap<any>(persistenceModule.openSqliteRunStore({ filename: resolve(directory, "runs.db") }));
  let artifactStore: any;
  try {
    artifactStore = unwrap(await artifactsModule.openFilesystemArtifactStore({ root: resolve(directory, "artifacts"), storeId: options.sessionId }));
    let runtime: AgenticWorkflowRuntime;
    let conversation: AgenticConversationHost | undefined;
    const approvedBundles = new Map<string, ApprovalDecision>();
    for (const decision of options.recoveredHumanDecisions ?? []) {
      const parsed = ApprovalDecisionSchema.parse(decision);
      if (!await options.authorizeHuman(parsed)) throw new Error("Recovered human decision is not authenticated");
      approvedBundles.set(parsed.approvalId, parsed);
    }
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
      automaticAlternativeEvidence: true, roleCapabilities: options.roleCapabilities, maxConcurrency: options.maxDeveloperCapacity ?? 2, taskChecks: options.taskChecks, workflowChecks: options.workflowChecks,
      authenticateMessage: async message => await authenticateNativeHerdrMessage(message) || await options.authenticateMessage(message),
      deliverToConversation: async message => {
        if (!conversation) throw new Error("Conversation host is not ready");
        await conversation.receiveRuntime(message); await options.onConversationNotice?.(message);
      }, authenticateResult: options.authenticateResult,
      authenticateEvidence: options.authenticateEvidence, authenticateGateResult: options.authenticateGateResult,
      authorizeHuman: async decision => { const authorized = await options.authorizeHuman(decision);
        if (authorized) approvedBundles.set(decision.approvalId, decision); return authorized; },
      ...(options.projectApprovalRequired ? { projectApprovalRequired: options.projectApprovalRequired } : {})
    }, { journalDirectory: resolve(directory, "journal"), repositoryPath: repository });
    await runtime.initialize();
    conversation = await createAgenticConversationHost({ runtime, manifest, contextDirectory: resolve(directory, "conversation"),
      ...(options.onHumanDecision ? { onHumanDecision: options.onHumanDecision } : {}),
      ...(options.recoveredHumanDecisions ? { recoveredHumanDecisions: options.recoveredHumanDecisions } : {}) });
    const tools = new CoordinatorTools(runtime);
    const ingress = options.nativeIngressSocket ? await startHerdrReceiptIngress({ socketPath: options.nativeIngressSocket,
      publicKeys: options.bindingReceiptKeys ?? {}, receive: async message => {
        const result = message.recipient.role === "conversation" ? await conversation!.receiveHerdr(message) : await runtime.receiveHerdr(message);
        await options.onNativeDelivery?.(message); return result;
      }, failed: (message, error) => runtime.reportInboundFailure(message, String(error)) }) : undefined;
    return { runtime, conversation, tools, async close() { await tools.drain(); await ingress?.close(); artifactStore.close(); runStore.close(); } };
  } catch (error) { artifactStore?.close(); runStore.close(); throw error; }
}
