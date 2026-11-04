import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { SessionManifestV3Schema, WebCommandSchema, type ApprovalDecision, type ApprovalRequest, type RoleMessage, type WebCommand } from "@bflow/contracts";
import { canonicalWebJson, WebPrincipalSchema, type WebPrincipal, webCommandFingerprint } from "@bflow/contracts/web-host";
import { buildDelegationRequest } from "@bflow/conversation";
import { buildAnalysisPack, type AnalysisDocument } from "../../src/index.js";
import { openWorkflowExtensionRuntimes } from "../../src/agentic/extension-composition.js";
import { createAgenticConversationHost, type AgenticConversationHost } from "../../src/agentic/conversation.js";
import { directorCoordinatorPort, recordConversationNotice, startDirectorWork, startDirectorExtension, resumeDirectorExtension } from "../../src/agentic/host-director-mode.js";
import { AgenticWorkflowRuntime } from "../../src/agentic/runtime.js";
import { CoordinatorTools } from "../../src/agentic/tools.js";
import { DirectorEndpoint } from "../../src/director/endpoint.js";
import { HostReceiptJournal } from "../../src/agentic/host-receipts.js";
import { WorkflowExtensionPump } from "../../src/agentic/extension-pump.js";
import { AppCheckBrowserLeases } from "../../src/agentic/app-check-lease.js";
import { WebInteractionAuthority } from "../../src/interaction/authority.js";
import { WebOperationStore } from "../../src/interaction/operation-store.js";
import { HostStructuredCommands, observeStructuredDecision } from "../../src/interaction/commands.js";
import { projectRun } from "../../src/interaction/views.js";
import { projectExtensionRoutes, mergeExtensionRun } from "../../src/agentic/extension-projection.js";
import { AgenticJournal, record } from "../../src/agentic/journal.js";
import { loadAgenticPolicies, type AgenticRuntimePorts, type PanePolicy } from "../../src/agentic/ports.js";
import { FakeAgentTransport } from "./fake-transport.js";
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message); return result.value;
}
import { nativeExtensionFixture } from "./native-extension.js";

/** Production Director/Conversation/native SDK composition with signed fake specialist results; never live-provider evidence. */
export async function directorNativeFlow() {
  const native = await nativeExtensionFixture("analysis", "session-1");
  const parent = { transport: new FakeAgentTransport(), spec: {}, def: {} };
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: native.repo });
  execFileSync("git", ["add", "."], { cwd: native.repo });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "baseline"], { cwd: native.repo });
  const pack = buildAnalysisPack({ id: "director-analysis-e2e", version: "1" });
  const pin = { id: pack.id, version: pack.version, digest: pack.digest };
  const intake = { schemaVersion: 1 as const, requestId: "health-analysis", sessionId: "session-1", title: "Health analysis",
    userStatements: [{ id: "U-1", text: "Specify the health flag and its owner without changing the source." },
      { id: "U-2", text: "Health checks should respond within100 ms at p95 for5 concurrent callers." }],
    deliverables: ["scope", "functional_requirements", "acceptance_criteria", "nfr", "business_flows", "glossary", "data_notes"] as const,
    acceptanceCriteria: [{ id: "AAC-1", description: "Traceable health FR/AC and measurable-or-undecided NFRs", required: true }],
    requiredDecisions: [{ id: "D-1", question: "Which team owns the health flag?", blocking: true }], surveyPaths: ["src"], documentRoot: "docs/analysis" };
  native.setOutput((request, assignment) => {
    if (request.taskId === "survey") return { observations: [{ path: "src/health.ts", note: "The existing module exposes healthy=true" }] };
    if (request.taskId === "elicitation") return { questions: [] };
    if (request.taskId === "review") return { verdict: "approved", documentDigest: assignment.context.document.digest, findings: [] };
    if (request.taskId !== "specification") throw new Error(`Unexpected native task ${request.taskId}`);
    const observation = assignment.context.observations[0], source = `source:${observation.path}#${observation.sha256}`;
    const document: AnalysisDocument = { schemaVersion: 1, title: "Health analysis", scope: {
      inScope: [{ id: "S-1", text: "Health flag and ownership", provenance: { kind: "user", refs: ["intake:U-1"] } }],
      outOfScope: [{ id: "S-2", text: "Changing the application", provenance: { kind: "inference", refs: ["S-1"] } }] },
      functionalRequirements: [
        { id: "FR-1", text: `${assignment.context.decisions["D-1"].answer} owns the health flag`, provenance: { kind: "user", refs: ["decision:D-1"] } },
        { id: "FR-2", text: "The existing healthy flag has value true", provenance: { kind: "source", refs: [source] } }],
      acceptanceCriteria: [
        { id: "AC-1", text: "Owner is recorded", requirementIds: ["FR-1"], given: "the owner decision is accepted", when: "the analysis is published",
          then: "the owner is recorded", oracle: "the named team equals the human decision", provenance: { kind: "inference", refs: ["FR-1"] } },
        { id: "AC-2", text: "Flag value is traced", requirementIds: ["FR-2"], given: "the observed health module", when: "healthy is inspected",
          then: "the value is true", oracle: "the pinned source exports healthy=true", provenance: { kind: "source", refs: [source] } }],
      nfrs: [
        { id: "NFR-1", category: "performance", text: "Health check latency", status: "accepted", metric: "p95 response time", oracle: "HTTP timing report",
          workload: "5 concurrent callers", threshold: "100 ms", provenance: { kind: "user", refs: ["intake:U-2"] } },
        { id: "NFR-2", category: "availability", text: "Availability target", status: "undecided", decisionId: "D-2",
          provenance: { kind: "open_decision", refs: ["decision:D-2"] } }],
      businessFlows: [{ id: "BF-1", text: "Monitor health", requirementIds: ["FR-1", "FR-2"], provenance: { kind: "inference", refs: ["FR-1", "FR-2"] },
        steps: [{ actor: "Owner", action: "Checks the health flag" }, { actor: "System", action: "Returns the existing flag" }] }],
      glossary: [{ id: "G-1", term: "Healthy flag", text: "The boolean exported by the observed module", provenance: { kind: "source", refs: [source] } }],
      notes: [{ id: "N-1", kind: "data", text: "The flag is boolean", provenance: { kind: "source", refs: [source] } }],
      openQuestions: [{ id: "D-2", question: "What availability target should the owner choose?", blocking: false }],
      criteriaCoverage: [{ criterionId: "AAC-1", statementIds: ["FR-1", "FR-2", "AC-1", "AC-2", "NFR-1", "NFR-2", "BF-1"] }] };
    return { document };
  });
  const at = new Date().toISOString();
  const manifest = SessionManifestV3Schema.parse({ schemaVersion: 3, sessionId: "session-1", conversationSessionId: "session-1",
    projectName: "Director BA fixture", workspaceRoot: native.repo, herdrWorkspaceId: "w", herdrTabId: "w:t", status: "up", activeRunIds: [],
    panes: [...native.panes.values()], attachTarget: { role: "progress", tabId: "w:t", paneId: "w:progress" },
    progressPane: { tabId: "w:t", paneId: "w:progress", command: ["bflow", "progress"], phase: "running", restarts: [] }, createdAt: at, updatedAt: at });
  const panes: PanePolicy = {
    getManifest: async () => ({ ok: true, value: manifest }),
    getRoleBinding: async selector => ({ ok: true, value: [...native.panes.values()].find(pane => [pane.role, pane.bindingId, pane.paneId].includes(selector)) ?? null }),
    inspectRoleHealth: async selector => { const pane = native.panes.get(selector); return { ok: true, value: {
      readyForPrompt: !!pane, occupantMatches: !!pane, paneId: pane?.paneId ?? selector, agentId: pane?.agentId ?? selector } }; },
    allocateDeveloper: async () => { throw new Error("A BA-only run must never allocate a Developer"); },
    releaseDeveloper: async () => ({ ok: true, value: undefined })
  };
  const directory = join(native.root, "host-sdk"), notices: RoleMessage[] = [], failures: unknown[] = [];
  const webKeys = generateKeyPairSync("ed25519"), issuedCommands: WebCommand[] = [];
  const webContext = new AsyncLocalStorage<{ command: WebCommand; principal: WebPrincipal; acceptedAt: string }>();
  let webCommands: HostStructuredCommands, webStore: WebOperationStore, authority: WebInteractionAuthority;
  const receipts = new HostReceiptJournal(join(native.root, "notices"), native.repo, "session-1");
  let runtime: AgenticWorkflowRuntime, chat: AgenticConversationHost, endpoint!: DirectorEndpoint;
  let composed: Awaited<ReturnType<typeof openWorkflowExtensionRuntimes>>, pump: WorkflowExtensionPump;
  const authorized = (decision: ApprovalDecision) => webStore.authenticateHuman(decision, "session-1");
  const publish = async (message: RoleMessage) => {
    await chat.receiveRuntime(message);
    await recordConversationNotice({ requireMirror: true, appendNotice: notice => receipts.appendConversationNoticeReceipt(notice),
      mirror: (notice, rendered) => endpoint.mirrorUserNotice(notice, rendered), log: async () => {} }, message);
    notices.push(message);
  };
  const open = async () => {
    const { engine } = await native.open();
    webStore = new WebOperationStore({ directory: join(native.root, "web-receipts"), repository: native.repo, sessionId: "session-1", projectId: "project-1" });
    authority = new WebInteractionAuthority("project-1", "session-1");
    authority.registerOwnerKey({ issuerId: "issuer-1", keyId: "key-1", principalId: "human-1", projectId: "project-1", hostSessionId: "session-1",
      publicKey: webKeys.publicKey.export({ type: "spki", format: "pem" }).toString() });
    composed = await openWorkflowExtensionRuntimes({ repositoryPath: native.repo, sessionId: "session-1", directory, admissionOrigin: "director",
      engine, runStore: native.runStore, artifactStore: native.artifactStore, native: native.native, authorizeHuman: authorized,
      now: () => new Date().toISOString(), readPack: async () => pack,
      isLegacyImplementationRun: async runId => { try { await runtime.inspect(runId); return true; } catch { return false; } },
      publishToConversation: publish, qa: { tools: {}, grants: [], leases: new AppCheckBrowserLeases(join(native.root, "leases")) } });
    const policies = await loadAgenticPolicies({ repositoryPath: native.repo, artifactStore: native.artifactStore, gates: [],
      loadSpecification: id => runtime.loadSpecification(id), authorizeApprover: () => false });
    const ports: AgenticRuntimePorts = { engine, runStore: native.runStore, artifactStore: native.artifactStore,
      registry: native.registry, transport: parent.transport, panes, policies, taskChecks: [], workflowChecks: [],
      roleCapabilities: { specifier: ["specification", "repository.read"], architect: ["architecture", "repository.read"], reviewer: ["review", "repository.read"] },
      authenticateMessage: async () => false, authenticateResult: async () => false, authenticateEvidence: async () => false, authenticateGateResult: async () => false,
      authorizeHuman: (decision: ApprovalDecision) => authorized(decision), deliverToConversation: publish,
      workflowExtensionOwns: (runId: string) => composed.host.owns(runId),
      workflowExtensionStarted: async (runId: string) => await composed.host.owns(runId) && record(await composed.host.inspect(runId)).coreCreated === true,
      inspectWorkflowExtension: (runId: string) => composed.host.inspect(runId), cancelWorkflowExtension: (runId: string, reason: string) => composed.host.cancel(runId, reason),
      director: { deliver: async (message: RoleMessage) => endpoint.deliverRuntimeMessage(message), present: async () => true,
        upsertIssue: async (input: Parameters<DirectorEndpoint["upsertIssue"]>[0]) => { await endpoint.upsertIssue(input); } } };
    runtime = new AgenticWorkflowRuntime(ports, { journalDirectory: join(native.root, "parent-journal"), repositoryPath: native.repo });
    await runtime.reconcileWorkflowExtensionCancellations();
    pump = new WorkflowExtensionPump(composed.host, async (runId, error) => { failures.push({ runId, error }); });
    endpoint = new DirectorEndpoint({ directory: join(native.root, "director"), repositoryRoot: native.repo, feed: { read: () => ({ items: [] }) },
      inspect: () => runtime.inspect(), pollMs: 10,
      work: { start: input => startDirectorWork({ manifest: () => manifest, build: buildDelegationRequest as unknown as import("../../src/agentic/host-director-mode.js").DelegationBuilder,
        admitExtension: request => composed.host.admit(request), admitDirectorWork: request => runtime.admitDirectorWork(request), log: async () => {} }, input) },
      coordinator: directorCoordinatorPort({ planningReference: async () => ({}), log: async () => {},
        invoke: async (name, input, principal) => {
          const deps = { manifest: () => manifest, extensions: composed.host, readRun: (runId: string) => runtime.inspect(runId) };
          if (name === "start_extension") return startDirectorExtension({ ...deps, wake: runId => pump.wake(runId) }, principal, input);
          if (name === "resume_run" && typeof input.runId === "string" && await composed.host.owns(input.runId))
            return resumeDirectorExtension({ ...deps, wakeStarted: runId => pump.wakeStarted(runId) }, principal, input);
          if (name === "inspect" && typeof input.runId === "string" && await composed.host.owns(input.runId))
            return mergeExtensionRun(await runtime.inspect(input.runId), await composed.host.inspect(input.runId));
          return new CoordinatorTools(runtime).invoke(name, input, principal);
        } }) });
    chat = await createAgenticConversationHost({ runtime, manifest, extensions: composed.host, contextDirectory: join(native.root, "conversation") });
    chat.configureStructuredInteraction({
      authorize: async (command, principal) => canonicalWebJson(webContext.getStore()?.command ?? null) === canonicalWebJson(command) &&
        canonicalWebJson(webContext.getStore()?.principal ?? null) === canonicalWebJson(principal),
      now: () => webContext.getStore()?.acceptedAt ?? new Date().toISOString(),
      approval: (decision, command, principal) => webStore.recordHumanDecision(principal.principalId, command.commandId, decision, "session-1"),
      resume: async command => ({ ok: true, value: { kind: "interaction", runId: command.runId, currentRunId: command.runId } }) });
    const runView = async (runId: string) => {
      const state = await new AgenticJournal(join(native.root, "parent-journal"), native.repo).exclusive(async state => structuredClone(state));
      const routes = await new AgenticJournal(join(directory, "routes"), native.repo).exclusive(async state => structuredClone(state));
      const projected = projectExtensionRoutes(state, routes, "session-1");
      const snapshot = unwrap(await engine.getSnapshot(runId));
      return projectRun({ state: projected, sessionId: "session-1", observedAt: new Date().toISOString(), ready: true, commandsSupported: true,
        core: new Map(snapshot ? [[runId, snapshot]] : []) }, runId);
    };
    webCommands = new HostStructuredCommands({ authority, store: webStore, ready: () => true, conversationSessionId: () => "session-1", run: runView,
      session: async () => { throw new Error("No pending pre-run intake"); },
      admit: (command, principal, acceptedAt) => webContext.run({ command, principal, acceptedAt }, () => chat.handleStructuredInteraction(command, principal)),
      reconcile: async command => {
        if (command.kind !== "answer_decision") return undefined;
        const view = record(await composed.host.inspect(command.runId));
        return observeStructuredDecision(command, await chat.readStructuredInteraction(command.commandId), [], runView,
          Array.isArray(view.appliedDecisions) ? view.appliedDecisions : []);
      } });
    native.setAuthorize((intent, binding) => composed.host.authorizeNative(intent, binding));
    return endpoint.register({ provider: "codex" });
  };
  let session = await open();
  const user = await endpoint.appendWebMessage({ messageId: randomUUID(), text: "Lập tài liệu phân tích sức khỏe, giữ nguyên mã nguồn" });
  const start = () => endpoint.call(session.token, "start_work", { title: intake.title, objective: intake.userStatements[0]!.text,
    acceptanceCriteria: [{ description: intake.acceptanceCriteria[0]!.description, verificationMethod: "manual_review" }],
    sddLevel: "lightweight", kind: "spike", nativeFamily: "analysis", userMessageSeq: user.seq });
  const answer = async (request: ApprovalRequest, answers?: Record<string, string>) => {
    const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical)}]` : value !== null && typeof value === "object"
      ? `{${Object.entries(value).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)}}` : JSON.stringify(value);
    const token = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
    const command = WebCommandSchema.parse({ apiVersion: 1, commandId: randomUUID(), projectId: "project-1", kind: "answer_decision", runId: request.runId,
      decisionId: request.approvalId, outcome: "approved", ...(answers ? { reason: Object.entries(answers).map(([id, text]) => `${id}: ${text}`).join("\n") } : {}),
      expectedVersion: { revisionToken: token(request), approvalId: request.approvalId, target: request.target, revision: request.revision,
        generation: request.generation, evidenceDigest: token(request.evidence) } });
    const principalBody = { schemaVersion: 1, source: "local_web", issuerId: "issuer-1", keyId: "key-1", principalId: "human-1", browserSessionId: "browser-1",
      projectId: command.projectId, hostSessionId: "session-1", capability: "user_interaction", commandId: command.commandId,
      commandDigest: webCommandFingerprint(command), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(), nonce: randomUUID(),
      };
    const principal = WebPrincipalSchema.parse({ ...principalBody, signature: { algorithm: "ed25519",
      value: sign(null, Buffer.from(canonicalWebJson(principalBody), "utf8"), webKeys.privateKey).toString("base64") } });
    issuedCommands.push(command);
    return webCommands.execute(command, principal);
  };
  return { parent, native, intake, pin, notices, receipts, failures, start, answer, publish,
    get runtime() { return runtime; }, get host() { return composed.host; }, get pump() { return pump; }, get chat() { return chat; },
    get endpoint() { return endpoint; }, get token() { return session.token; }, get engine() { return runtime.ports.engine; },
    get webCommands() { return webCommands; }, get webStore() { return webStore; }, issuedCommands,
    async restart() { session = await open(); } };
}
