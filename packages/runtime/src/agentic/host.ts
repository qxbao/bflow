import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AgentBindingReceiptSchema, AgentExecutionHandleSchema, AgentResultSchema, AgentRoleSchema, ApprovalDecisionSchema,
  JsonValueSchema, RoleMessageSchema, RunQuerySchema, SessionManifestSchema,
  type AgentRole, type ApprovalDecision, type RoleMessage, type SessionManifest, type RunStore
} from "@bflow/contracts";
import { authenticateNativeHerdrMessage } from "./herdr-ingress.js";
import { callHost } from "./host-protocol.js";
import { readHostConfiguration, type HostConfiguration, type RoleLaunchDescriptor } from "./host-controller.js";
import { digest, json, record, textField } from "./journal.js";
import { COORDINATOR_TOOLS } from "./tools.js";
import { openAgenticWorkspace, type AgenticWorkspaceHandle } from "./workspace.js";
import { unwrap } from "./outbox.js";
import { HostVerification, DEFAULT_HOST_CHECKS } from "./host-verification.js";
import { redactString } from "../resilience/redaction.js";

const execute = promisify(execFile);
const roles = ["conversation", "coordinator", "specifier", "architect", "planner", "developer", "tester", "reviewer", "qa", "security"] as const;
const capabilities = { conversation: ["conversation"], coordinator: ["coordination", "planning", "specification"],
  specifier: ["specification"], architect: ["architecture"], planner: ["planning"], developer: ["implementation"],
  tester: ["testing"], reviewer: ["review"], qa: ["verification", "testing"], security: ["security"] };
interface RoleConfiguration { socketPath: string; token: string; role: AgentRole; herdrBinary: string; sessionId: string }
async function privateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 }); await chmod(path, 0o600);
}
async function readRoleConfiguration(path: string): Promise<RoleConfiguration> {
  const stat = await lstat(path); if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe role host configuration");
  const raw = record(JSON.parse(await readFile(path, "utf8")));
  return { socketPath: textField(raw.socketPath), token: textField(raw.token), role: AgentRoleSchema.parse(raw.role), herdrBinary: textField(raw.herdrBinary), sessionId: textField(raw.sessionId) };
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

/** Long-lived composition owner. Startup is separate from activation to support provider MCP startup. */
export async function runAgenticHost(configuration: HostConfiguration): Promise<void> {
  const binary = configuration.herdrBinary ?? "herdr";
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.startsWith("HERDR_") && key !== "HERDR_CONFIG_PATH") delete environment[key];
  environment.HERDR_SESSION = configuration.sessionId;
  const herdr = async (args: string[]) => (await execute(binary, ["--session", configuration.sessionId, ...args], { cwd: configuration.repositoryPath, env: environment, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  let workspace: AgenticWorkspaceHandle | undefined;
  let queryStore: (RunStore & {close(): void}) | undefined;
  let manifest: SessionManifest | undefined;
  let quiesced = false, quiesceCompleted = false, closing = false;
  let scheduler: Promise<unknown> | undefined, schedulerError: string | undefined;
  const humanDecisions = new Map<string, ApprovalDecision>();
  const roleTokens = new Map<string, AgentRole>();
  const launch: Record<string, RoleLaunchDescriptor> = {};
  const executable = fileURLToPath(import.meta.url);
  const nativeSocket = configuration.socketPath.replace(/\.sock$/, ".native.sock");
  const issuerId = `bflow-${createHash("sha256").update(configuration.repositoryPath + configuration.sessionId).digest("hex").slice(0, 24)}`;
  const keyPath = join(configuration.directory, "native-key.pem");
  const publicPath = join(configuration.directory, "native-public.pem");
  try { await lstat(keyPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const pair = generateKeyPairSync("ed25519");
    await privateFile(keyPath, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    await privateFile(publicPath, pair.publicKey.export({ type: "spki", format: "pem" }).toString());
  }
  const publicKey = await readFile(publicPath, "utf8");
  for (const role of roles) {
    const path = join(configuration.directory, role + ".json");
    let roleConfig: RoleConfiguration;
    try { roleConfig = await readRoleConfiguration(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      roleConfig = { socketPath: configuration.socketPath, role, token: randomBytes(32).toString("hex"), sessionId: configuration.sessionId, herdrBinary: binary };
      await privateFile(path, JSON.stringify(roleConfig)); }
    if (roleConfig.role !== role || roleConfig.socketPath !== configuration.socketPath || roleConfig.sessionId !== configuration.sessionId) throw new Error("Foreign role configuration");
    roleTokens.set(roleConfig.token, role);
    const mcpConfigFile = join(configuration.directory, role + ".mcp.json");
    const hooksSettingsFile = join(configuration.directory, role + ".hooks.json");
    await privateFile(mcpConfigFile, JSON.stringify({ mcpServers: { bflow: { type: "stdio", command: process.execPath, args: [executable, "mcp", path] } } }));
    const hookCommand = (event: string) => [process.execPath, executable, "hook", path, event].map(shellQuote).join(" ");
    const hooks = Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop"].map(event => [event, [{ hooks: [{ type: "command", command: hookCommand(event), timeout: 30 }] }]]));
    await privateFile(hooksSettingsFile, JSON.stringify({ hooks }));
    let systemPrompt = `You are Bflow's ${role} in a dedicated Herdr pane. Use the bflow MCP tools. All cross-role messages must use send_role_message through native Herdr; never use files as a mailbox. Never fabricate evidence or approvals. `;
    if (role === "conversation") systemPrompt += "You are the sole user interface. The trusted UserPromptSubmit hook supplies the Conversation Gateway result as additional context. Greetings and questions need no workflow. Explain Gateway clarifications and forward the user's actual intent through that Gateway. Never call coordination tools or edit source. User approval comes exclusively from the trusted hook; an MCP call cannot approve.";
    else if (role === "coordinator") {
      try { systemPrompt += await readFile(new URL("../../../../agents/coordinator/system-prompt.md", import.meta.url), "utf8"); }
      catch { systemPrompt += "Inspect the durable inbox, assess the spec, propose a schema-valid workflow. Runtime controls all dispatch and quality/approval gates. Never edit source or approve human-required gates."; }
    } else if (role === "developer") systemPrompt += "Read assignment_context for your exact accepted specification and worktree. Never change approved criteria/specification. Call authorize_implementation before production edits. Commit only assigned paths in your task worktree. Call submit_implementation after committing, then end your turn. You cannot grant yourself evidence or approvals.";
    else systemPrompt += "Read incoming RoleMessage. Inspect the exact assigned revision and criteria independently. Use host verification tools for evidence; never invent command output. Send replies through send_role_message with original correlation and causation. End your turn after sending.";
    if (role === "coordinator") systemPrompt += " Use planning_reference to read the shipped specification example, policy metadata schema and workflow contract before proposing a workflow. Specialist requests can gather project details; repository files are never a mailbox.";
    launch[role] = { systemPrompt, mcpConfigFile, hooksSettingsFile };
  }
  const requireWorkspace = () => { if (!workspace) throw new Error("Bflow host awaits an up SessionManifest; retry only after bflow up completes"); return workspace; };
  const principal = async (role: AgentRole, paneId: string) => {
    const host = requireWorkspace();
    const current = SessionManifestSchema.parse(unwrap(await host.runtime.ports.panes.getManifest()));
    const binding = current.panes.find(pane => pane.role === role && pane.paneId === paneId);
    if (!binding) throw new Error("MCP role/pane is outside the current session manifest");
    const agent = record(record(record(JSON.parse(await herdr(["agent", "get", paneId]))).result).agent);
    const native = agent.agent_session ? record(agent.agent_session) : undefined;
    if ((agent.name ?? agent.agent) !== binding.agentId || agent.pane_id !== binding.paneId || agent.workspace_id !== binding.workspaceId ||
        !binding.session || !native || native.source !== binding.session.source || native.kind !== binding.session.kind || native.value !== binding.session.value)
      throw new Error("MCP pane occupant/native session changed");
    return binding;
  };
  const nativeDeliver = async (message: RoleMessage) => {
    const sender = (await principal(AgentRoleSchema.parse(message.sender.role), textField(message.sender.pane_id)));
    if (message.sender.agent_id !== sender.agentId) throw new Error("Role message sender does not match authenticated pane");
    const socketPath = textField(record(JSON.parse(await herdr(["status", "server", "--json"]))).socket);
    await new Promise<void>((accept, reject) => {
      const socket = connect(socketPath); let output = "";
      socket.setTimeout(20_000, () => { socket.destroy(); reject(new Error("Native Herdr action timed out; reconcile before retry")); });
      socket.once("error", reject);
      socket.once("connect", () => socket.write(JSON.stringify({ id: message.message_id, method: "plugin.action.invoke", params: { plugin_id: "bflow.receipts", action_id: "deliver",
        context: { selected_text: JSON.stringify(message), correlation_id: message.causation_id ?? message.message_id, focused_pane_id: sender.paneId, workspace_id: sender.workspaceId } } }) + "\n"));
      socket.on("data", chunk => { output += String(chunk); if (output.length > 1024 * 1024) { socket.destroy(); reject(new Error("Oversized native response")); }
        if (output.includes("\n")) { socket.end(); try { const response = record(JSON.parse(output.split("\n")[0]!)); if (response.error) reject(new Error(JSON.stringify(response.error))); else accept(); } catch (error) { reject(error); } } });
    });
    // The plugin action is asynchronous. Wait for signed ingress acknowledgement, never resend.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (deliveredMessageIds.has(message.message_id)) return json({ delivered: true, messageId: message.message_id });
      await new Promise(accept => setTimeout(accept, 30));
    }
    throw new Error("Native delivery acknowledgement is uncertain; inspect/reconcile before replay");
  };
  const verification = new HostVerification(() => requireWorkspace().runtime, () => requireWorkspace().runtime.ports.artifactStore);
  const nativeSessions = new Map<string, {role: AgentRole; sessionId: string}>();
  try { for (const [pane, value] of Object.entries(record(JSON.parse(await readFile(join(configuration.directory, "native-sessions.json"), "utf8"))))) {
    const session = record(value); nativeSessions.set(pane, { role: AgentRoleSchema.parse(session.role), sessionId: textField(session.sessionId) });
  } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const getQueryStore = async () => {
    if (workspace) return workspace.runtime.ports.runStore;
    if (!queryStore) {
      const module = await import(new URL("../../../persistence/dist/index.js", import.meta.url).href);
      const storage = resolve(configuration.repositoryPath, ".bflow/state/agentic"); await mkdir(storage, {recursive:true, mode:0o700});
      queryStore = unwrap(module.openSqliteRunStore({ filename: join(storage, "runs.db") })) as RunStore & {close():void};
    }
    return queryStore!;
  };
  const activate = async (input: unknown) => {
    const accepted = SessionManifestSchema.parse(input);
    if (accepted.sessionId !== configuration.sessionId || accepted.workspaceRoot !== configuration.repositoryPath || accepted.status !== "up") throw new Error("Foreign or unready session manifest");
    if (workspace) { if (quiesced) throw new Error("Host is quiesced; reconcile and restart after shutdown"); return null; }
    // An older pane may have a valid Herdr session but no Bflow tools/hooks.
    // Require the launch-local hook receipt for this exact native session.
    for (const pane of accepted.panes) {
      if (!pane.permanent || pane.role === "developer") continue;
      const receipt = record(JSON.parse(await readFile(join(configuration.directory, "launch-receipts", digest([pane.role, pane.paneId]) + ".json"), "utf8")));
      if (!pane.session || receipt.role !== pane.role || receipt.paneId !== pane.paneId || receipt.nativeSessionId !== pane.session.value) {
        throw new Error(`Pane '${pane.paneId}' has no matching native Bflow launch receipt; preserve it and reconcile provider startup`);
      }
    }
    for (const pane of accepted.panes) {
      const receipt = nativeSessions.get(pane.paneId);
      const actual = record(record(record(JSON.parse(await herdr(["agent", "get", pane.paneId]))).result).agent);
      const native = actual.agent_session ? record(actual.agent_session) : undefined;
      if (!receipt || receipt.role !== pane.role || !native || native.source !== "herdr:claude" || native.kind !== "id" || native.value !== receipt.sessionId ||
          pane.session?.value !== receipt.sessionId || (actual.name ?? actual.agent) !== pane.agentId)
        throw new Error(`Role ${pane.role} has no matching Bflow provider startup/native-session receipt; stop and recreate legacy bare panes`);
    }
    queryStore?.close(); queryStore = undefined;
    const pluginRoot = fileURLToPath(new URL("../../../../agents/coordinator/herdr-receipts", import.meta.url));
    await herdr(["plugin", "link", pluginRoot]);
    const pluginDirectory = (await herdr(["plugin", "config-dir", "bflow.receipts"])).trim();
    await mkdir(join(pluginDirectory, "hosts"), { recursive: true, mode: 0o700 });
    const manifestFile = join(configuration.manifestDirectory ?? resolve(configuration.repositoryPath, ".bflow/state/panes"), configuration.sessionId + ".manifest.json");
    await privateFile(join(pluginDirectory, "hosts", configuration.sessionId + ".json"), JSON.stringify({ issuerId, privateKeyFile: keyPath, runtimeSocket: nativeSocket, manifestFile,
      herdrSocketPath: textField(record(JSON.parse(await herdr(["status", "server", "--json"]))).socket) }));
    workspace = await openAgenticWorkspace({ repositoryPath: configuration.repositoryPath, sessionId: configuration.sessionId, herdrBinary: binary,
      ...(configuration.manifestDirectory ? { manifestDirectory: configuration.manifestDirectory } : {}), maxDeveloperCapacity: configuration.policy?.concurrency.maxConcurrency ?? configuration.maxDeveloperCapacity ?? 2,
      nativeIngressSocket: nativeSocket, bindingReceiptKeys: { [issuerId]: publicKey }, roleLaunch: launch,
      roleCapabilities: capabilities, taskChecks: DEFAULT_HOST_CHECKS, workflowChecks: DEFAULT_HOST_CHECKS, deterministicGates: [verification.deterministicGate()],
      authenticateMessage: authenticateNativeHerdrMessage,
      authenticateResult: async (result, handle, message) => await authenticateNativeHerdrMessage(message) && result.requestId === handle.requestId && result.executionId === handle.executionId,
      authenticateEvidence: async (result, message) => await authenticateNativeHerdrMessage(message) && verification.authenticateEvidence(result),
      authenticateGateResult: async (result, message) => await authenticateNativeHerdrMessage(message) && verification.authenticateGate(result),
      projectApprovalRequired: () => configuration.policy?.sdd.approvalRequired === true,
      authorizeHuman: async decision => digest(humanDecisions.get(decision.approvalId)) === digest(decision),
      onNativeDelivery: async message => { deliveredMessageIds.add(message.message_id); },
      onHumanDecision: async decision => { if (!humanHookActive) throw new Error("Human approval requires physical user input hook"); humanDecisions.set(decision.approvalId, ApprovalDecisionSchema.parse(decision)); }
    });
    manifest = accepted;
    return null;
  };
  const deliveredMessageIds = new Set<string>();
  let humanHookActive = false;
  let userQueue: Promise<unknown> = Promise.resolve();
  const roleCall = async (role: AgentRole, input: unknown) => {
    const args = record(input); const name = textField(args.name); const parameters = record(JsonValueSchema.parse(args.arguments ?? {}));
    const binding = await principal(role, textField(args.paneId));
    const host = requireWorkspace();
    if (quiesced && !["host_status", "assignment_context", "inspect_review", "complete_review", "inspect_alternative_verification", "record_alternative_verification", "submit_implementation"].includes(name)) throw new Error("Host is quiesced; new work is disabled while existing receipts can drain");
    if (name === "planning_reference") {
      if (role !== "coordinator") throw new Error("Only Coordinator reads host planning guidance");
      const section = textField(parameters.section);
      const references: Record<string, string[]> = { specification:["../../../../templates/node-typescript/specifications/docs.spec.json","../../../specification/dist/schema.js","../../../specification/dist/classification.js"],
        test_strategy:["../../../test-strategy/dist/schema.js","../../../../templates/node-typescript/specifications/bugfix.spec.json"], workflow:["../../../contracts/dist/workflow.js"] };
      const selected = references[section]; if (!selected) throw new Error("Unknown planning section: choose specification, test_strategy, workflow");
      return json(await Promise.all(selected.map(async path => ({source:path,content:await readFile(new URL(path,import.meta.url),"utf8")}))));
    }
    if (name === "host_status") return json({ active: !!workspace, quiesced, schedulerRunning: !!scheduler, schedulerError: schedulerError ?? null });
    if (name === "send_role_message") {
      const message = RoleMessageSchema.parse(parameters.message);
      if (message.sender.role !== role || message.sender.agent_id !== binding.agentId || message.sender.pane_id !== binding.paneId) throw new Error("Cannot impersonate another role");
      if (["approval.decision", "execution.receipt", "implementation.submitted", "verification.result", "review.verdict"].includes(message.type)) throw new Error("Use the dedicated authenticated host tool for this message type");
      return nativeDeliver(message);
    }
    if (name === "assignment_context") {
      const state = record(await host.runtime.inspect());
      const outbound = (state.outbound as Record<string, unknown>[]).filter(out => {
        if (!out.handle) return false;
        return record(record(out.handle).target).paneId === binding.paneId && ["accepted", "released"].includes(String(out.status));
      });
      return json({ assignments: outbound, runs: (state.runs as Record<string, unknown>[]).filter(run => outbound.some(out => record(out.message).run_id === run.runId)) });
    }
    if (name === "submit_implementation") {
      if (role !== "developer") throw new Error("Only the assigned Developer may submit implementation");
      const state = record(await host.runtime.inspect());
      const out = [...state.outbound as Record<string, unknown>[]].reverse().find(item => item.status === "accepted" && record(item.message).type === "task.assignment" &&
        record(item.message).run_id === parameters.runId && item.taskId === parameters.taskId && item.handle && record(record(item.handle).target).paneId === binding.paneId);
      if (!out) throw new Error("No accepted assignment for this Developer");
      const handle = AgentExecutionHandleSchema.parse(out.handle), original = RoleMessageSchema.parse(out.message);
      const envelope = (type: RoleMessage["type"], payload: unknown) => RoleMessageSchema.parse({ schema_version: 2, message_id: randomUUID(), correlation_id: original.correlation_id,
        causation_id: original.message_id, run_id: original.run_id, sender: { role, agent_id: binding.agentId, pane_id: binding.paneId }, recipient: { role: "coordinator" }, type, payload: json(payload), artifact_references: [], occurred_at: new Date().toISOString(), idempotency_key: randomUUID() });
      const receipt = AgentBindingReceiptSchema.parse({ schemaVersion: 1, receiptId: `binding-${handle.requestId}`, issuerId, handle,
        correlation: { token: original.message_id, provenance: "transport", verified: true }, observedAt: new Date().toISOString(), signature: { algorithm: "ed25519", value: Buffer.alloc(64).toString("base64") } });
      await nativeDeliver(envelope("execution.receipt", receipt));
      const snapshot = unwrap(await host.runtime.ports.engine.getSnapshot(handle.runId));
      const proof = snapshot?.tasks.find(task => task.taskId === handle.taskId)?.bindingVerification;
      if (!proof) throw new Error("Native binding has not been verified by Core");
      if (parameters.status !== undefined && parameters.status !== "succeeded") throw new Error("This tool currently accepts succeeded submissions only; report blockers with task.status");
      const result = AgentResultSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId: handle.runId, taskId: handle.taskId, executionId: handle.executionId,
        status: "succeeded", verification: { status: "verified", correlation: proof.receipt.correlation, evidence: "Native Herdr host checked the actual assignment/session binding; independent acceptance is pending" },
        artifactProposals: [], retryable: false, startedAt: handle.acceptedAt, completedAt: new Date().toISOString() });
      return nativeDeliver(envelope("implementation.submitted", result));
    }
    const envelope = (source: RoleMessage, type: RoleMessage["type"], payload: unknown, artifacts: RoleMessage["artifact_references"] = []) => RoleMessageSchema.parse({ schema_version: 2,
      message_id: randomUUID(), correlation_id: source.correlation_id, causation_id: source.message_id, run_id: source.run_id,
      sender: { role, agent_id: binding.agentId, pane_id: binding.paneId }, recipient: { role: "coordinator" }, type, payload: json(payload), artifact_references: artifacts,
      occurred_at: new Date().toISOString(), idempotency_key: randomUUID() });
    if (name === "inspect_review") return verification.inspectReview(binding, parameters);
    if (name === "inspect_alternative_verification") return verification.inspectAlternative(binding, parameters);
    if (name === "complete_review") {
      const completed = await verification.completeReview(binding, parameters);
      const state = record(await host.runtime.inspect());
      const out = (state.outbound as Record<string, unknown>[]).find(item => record(item.message).message_id === parameters.messageId);
      if (!out) throw new Error("Review causation unavailable");
      return nativeDeliver(envelope(RoleMessageSchema.parse(out.message), "review.verdict", completed.result, [completed.artifact]));
    }
    if (name === "record_alternative_verification") {
      const completed = await verification.alternativeEvidence(binding, parameters);
      return nativeDeliver(envelope(RoleMessageSchema.parse(completed.assignment), "verification.result", completed.result, completed.result.evidenceArtifacts));
    }
    if (name === "propose_workflow") {
      if (configuration.policy?.verification.maxIterations !== undefined) {
        if (parameters.maxIterations !== undefined && parameters.maxIterations !== configuration.policy.verification.maxIterations) throw new Error("Verification limit is fixed by the project owner policy");
        parameters.maxIterations = configuration.policy.verification.maxIterations;
      }
      const spec = record(parameters.specification);
      if (configuration.policy?.sdd.minimumLevel === "full" && spec.level !== "full") throw new Error("Project policy requires a full specification");
      if (!Array.isArray(spec.affectedPaths) || spec.affectedPaths.some(path => typeof path !== "string" || !/\.(md|txt|rst)$/i.test(path)) ||
          !Array.isArray(spec.acceptanceCriteria) || spec.acceptanceCriteria.some(criterion => record(criterion).verificationMethod !== "manual_review"))
        throw new Error("Default host supports documentation with manual review criteria; behavioral development requires configured independent runners");
    }
    return host.tools.invoke(name, parameters, { role });
  };
  const physicalPrompts: {role: AgentRole; paneId: string; message: RoleMessage}[] = [];
  const dispatch = async (token: string, method: string, params: unknown): Promise<unknown> => {
    if (token !== configuration.token) {
      const role = roleTokens.get(token); if (!role) throw new Error("Host authentication failed");
      if (method === "provider_started") {
        const receipt = record(params), paneId = textField(receipt.paneId), nativeSessionId = textField(receipt.nativeSessionId);
        const directory = join(configuration.directory, "launch-receipts");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await privateFile(join(directory, digest([role, paneId]) + ".json"), JSON.stringify({ role, paneId, nativeSessionId }));
        return { recorded: true };
      }
      if (method === "role_call") return roleCall(role, params);
      if (method === "native_session") {
        const input = record(params); nativeSessions.set(textField(input.paneId), {role, sessionId:textField(input.sessionId)});
        await privateFile(join(configuration.directory, "native-sessions.json"), JSON.stringify(Object.fromEntries(nativeSessions)));
        return {registered:true};
      }
      if (method === "transport_prompt") {
        const input = record(params), message = RoleMessageSchema.parse(input.message);
        // Enqueue only: agent.prompt may still own Runtime's journal while this hook runs.
        physicalPrompts.push({ role, paneId: textField(input.paneId), message });
        return { queued: true };
      }
      if (method === "user_prompt") {
        if (role !== "conversation" || quiesced) throw new Error("Only active Conversation accepts user input");
        const input = record(params); await principal(role, textField(input.paneId));
        const hook = record(input.hook); if (hook.hook_event_name !== "UserPromptSubmit") throw new Error("Physical user input hook required");
        const prompt = textField(hook.prompt); textField(hook.session_id);
        try { const candidate = JSON.parse(prompt); if (candidate && typeof candidate === "object" && ("schema_version" in candidate || "sender" in candidate || "type" in candidate)) throw new Error("Role envelopes cannot become authenticated human input"); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        const work = userQueue.catch(() => undefined).then(async () => {
          humanHookActive = true;
          try { return requireWorkspace().conversation.handleUserTurn({ sessionId: manifest!.conversationSessionId,
            messageId: `user-${digest([hook.session_id, hook.prompt, hook.transcript_path, randomUUID()])}`, content: prompt,
            provenance: { origin: "user", authenticatedUser: true, userId: `local-user-${process.getuid?.() ?? "local"}`, paneId: input.paneId, channel: "herdr_attach" } }); }
          finally { humanHookActive = false; }
        }); userQueue = work; return work;
      }
      throw new Error("Role cannot call host lifecycle methods");
    }
    switch (method) {
      case "ping": return { active: !!workspace, quiesced, schedulerError: schedulerError ?? null };
      case "prepare": return { roleLaunch: launch };
      case "activate": return activate(params);
      case "get_run": { const stored = unwrap(await (await getQueryStore()).get(textField(record(params).runId))); return stored?.snapshot ?? null; }
      case "find_runs": { const page = unwrap(await (await getQueryStore()).find(RunQuerySchema.parse(params))); return { ...page, items: page.items.map(item => item.snapshot) }; }
      case "quiesce": {
        quiesced = true;
        if (!workspace) {
          let cursor: string | undefined;
          do {
            const page = unwrap(await (await getQueryStore()).find({limit:100, ...(cursor ? {cursor} : {})}));
            if (page.items.some(item => !["completed", "failed", "cancelled"].includes(item.snapshot.status))) throw new Error("Persisted Core run requires activation/recovery before safe shutdown");
            cursor = page.nextCursor;
          } while (cursor);
          const journalModule = await import("./journal.js");
          const journal = new journalModule.AgenticJournal(resolve(configuration.repositoryPath, ".bflow/state/agentic/journal"), configuration.repositoryPath);
          await journal.exclusive(async state => {
            if (state.pendingCore.length || state.pendingVerifications.length || state.runs.some(run => !["completed", "cancelled", "failed"].includes(run.status)))
              throw new Error("Persisted agentic work requires activation/reconciliation before safe shutdown");
          });
          quiesceCompleted = true; return null;
        }
        await workspace.runtime.quiesce();
        if (scheduler) await Promise.race([scheduler, new Promise((_, reject) => setTimeout(() => reject(new Error("Outstanding verification has not drained; preserve the live session and retry shutdown after reconciliation")), 15_000))]);
        await requireWorkspace().tools.drain(); await userQueue;
        if (physicalPrompts.length || pumping) throw new Error("Inbound transport receipts are still draining; preserve session and retry shutdown");
        quiesceCompleted = true; return null;
      }
      case "checkpoint": return requireWorkspace().runtime.checkpoint(params);
      case "shutdown": {
        if (workspace && !quiesceCompleted) throw new Error("Quiesce and checkpoint before stopping the host");
        const status = record(JSON.parse(await herdr(["status", "server", "--json"])));
        if (status.running === true) throw new Error("Stop the named Herdr session before stopping its host");
        closing = true; setImmediate(() => { void close(); }); return null;
      }
      default: throw new Error("Unknown host operation");
    }
  };
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => undefined); socket.setTimeout(35_000, () => socket.destroy());
    let input = "", started = false;
    socket.on("data", chunk => { if (started) return; input += String(chunk);
      if (Buffer.byteLength(input) > 4 * 1024 * 1024) { socket.destroy(); return; }
      if (!input.includes("\n")) return; started = true;
      void (async () => { const value = record(JSON.parse(input.split("\n")[0]!)); const result = await dispatch(textField(value.token), textField(value.method), JsonValueSchema.parse(value.params));
        socket.end(JSON.stringify({ ok: true, value: result ?? null }) + "\n"); })().catch(error => socket.end(JSON.stringify({ ok: false, error: String(error) }) + "\n"));
    });
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(configuration.socketPath, accept); });
  await chmod(configuration.socketPath, 0o600);
  await privateFile(join(configuration.directory,"owner.json"), JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  let pumping = false;
  const pump = setInterval(() => {
    if (!workspace || pumping || !physicalPrompts.length) return;
    pumping = true;
    void (async () => {
      while (physicalPrompts.length) {
        const incoming = physicalPrompts.shift()!;
        const binding = await principal(incoming.role, incoming.paneId);
        const state = record(await requireWorkspace().runtime.inspect());
        const outbound = (state.outbound as Record<string, unknown>[]).find(item => item.request &&
          record(record(item.request).target).paneId === binding.paneId && digest(record(item.request).context) === digest(incoming.message));
        if (!outbound) throw new Error("Inbound provider prompt is not an exact Runtime outbox delivery");
        const message = incoming.message;
        const current = SessionManifestSchema.parse(unwrap(await requireWorkspace().runtime.ports.panes.getManifest()));
        const sender = current.panes.find(pane => pane.role === message.sender.role && (!message.sender.pane_id || pane.paneId === message.sender.pane_id));
        if (!sender) throw new Error("Transport sender binding unavailable");
        // Specialist assignments remain in their model turn; only authoritative receivers apply inbox state.
        if (["coordinator", "runtime", "conversation"].includes(message.recipient.role))
          await nativeDeliver(RoleMessageSchema.parse({ ...message, sender: { ...message.sender, pane_id: sender.paneId, agent_id: sender.agentId } }));
      }
    })().catch(error => { schedulerError = redactString(String(error)); process.stderr.write(`Bflow inbound: ${schedulerError}\n`); }).finally(() => { pumping = false; });
  }, 100);
  const timer = setInterval(() => {
    if (!workspace || quiesced || closing || scheduler) return;
    const task = workspace.runtime.tick(); scheduler = task;
    void task.then(() => { schedulerError = undefined; }, error => { schedulerError = redactString(String(error)); process.stderr.write(`Bflow scheduler: ${schedulerError}\n`); }).finally(() => { if (scheduler === task) scheduler = undefined; });
  }, 500);
  const close = async () => {
    closing = true; clearInterval(timer); clearInterval(pump); if (workspace) { await workspace.runtime.quiesce(); await scheduler; await workspace.close(); }
    queryStore?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(accept => server.close(() => accept())); await unlink(configuration.socketPath);
  };
  // Abrupt process signals are crashes, never graceful-shutdown receipts.
  process.once("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}

function availableTools(role: AgentRole) {
  const tools = [{ name: "host_status", description: "Read the durable host scheduler status" },
    { name: "assignment_context", description: "Read assignments addressed to this authenticated pane and the accepted specification" },
    { name: "send_role_message", description: "Send a schema-valid RoleMessage through the signed native Herdr plugin; parameters: {message: RoleMessage}" }];
  if (role === "coordinator") tools.push(...COORDINATOR_TOOLS, {name:"planning_reference",description:"Read canonical shipped examples and exact metadata/contract definitions; section: specification, test_strategy, workflow"});
  if (role === "developer") tools.push({ name: "authorize_implementation", description: "Verify accepted spec and Red evidence; parameters: runId, taskId" }, { name: "submit_implementation", description: "Submit committed implementation under your exact native assignment binding; parameters: runId, taskId" });
  if (["reviewer", "qa", "tester"].includes(role)) tools.push(
    { name: "inspect_review", description: "Independently capture exact assigned diff before review; parameters: messageId" },
    { name: "complete_review", description: "Return a verdict after inspect_review; parameters: reviewId, messageId, summary, criteria:[{criterionId,passed,summary}]" });
  if (["qa", "tester"].includes(role)) tools.push({ name: "inspect_alternative_verification", description: "Capture exact committed diff and accepted dossier before evaluating criteria; parameters: runId,taskId" }, { name: "record_alternative_verification", description: "Capture actual committed documentation diff and independent manual acceptance evidence; parameters: observationId,runId,taskId,criteria:[{criterionId,passed,summary}]" });
  const string = { type:"string", minLength:1 }, array = {type:"array",items:string}, object = {type:"object"};
  const argumentsByName: Record<string, {properties: Record<string, unknown>; required: string[]}> = {
    planning_reference:{properties:{section:{type:"string",enum:["specification","test_strategy","workflow"]}},required:["section"]},
    inspect:{properties:{runId:string},required:[]}, report_progress:{properties:{runId:string,headline:string,questions:array},required:["runId","headline"]},
    assess:{properties:{specification:object},required:["specification"]},
    request_specialist:{properties:{runId:string,role:string,objective:string,requiredCapabilities:array},required:["runId","role","objective","requiredCapabilities"]},
    propose_workflow:{properties:{runId:string,specification:object,definition:object,maxIterations:{type:"integer",minimum:1,maximum:10}},required:["runId","specification","definition"]},
    reconcile_delivery:{properties:{messageId:string},required:["messageId"]}, authorize_implementation:{properties:{runId:string,taskId:string},required:["runId","taskId"]},
    accept_conflict_resolution:{properties:{runId:string,taskKey:string,resolutionCommitHash:string},required:["runId","taskKey","resolutionCommitHash"]},
    cancel:{properties:{runId:string,reason:string},required:["runId","reason"]},
    send_role_message:{properties:{message:object},required:["message"]}, submit_implementation:{properties:{runId:string,taskId:string},required:["runId","taskId"]},
    inspect_review:{properties:{messageId:string},required:["messageId"]},
    complete_review:{properties:{reviewId:string,messageId:string,summary:string,criteria:{type:"array",items:{type:"object",properties:{criterionId:string,passed:{type:"boolean"},summary:string},required:["criterionId","passed","summary"],additionalProperties:false}}},required:["reviewId","messageId","summary","criteria"]},
    inspect_alternative_verification:{properties:{runId:string,taskId:string},required:["runId","taskId"]},
    record_alternative_verification:{properties:{observationId:string,runId:string,taskId:string,criteria:{type:"array",items:{type:"object",properties:{criterionId:string,passed:{type:"boolean"},summary:string},required:["criterionId","passed","summary"],additionalProperties:false}}},required:["observationId","runId","taskId","criteria"]}
  };
  return tools.map(tool => ({ ...tool, inputSchema: { type: "object", ...(argumentsByName[tool.name] ?? {properties:{},required:[]}), additionalProperties:false } }));
}
export async function runRoleMcp(configuration: RoleConfiguration): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error("Oversized MCP request");
    let request: Record<string, unknown>;
    try { request = record(JSON.parse(line)); } catch { continue; }
    if (request.id === undefined) continue;
    const reply = (result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
    try {
      if (request.method === "initialize") { reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "bflow", version: "0.1.0" } }); continue; }
      if (request.method === "tools/list") { reply({ tools: availableTools(configuration.role) }); continue; }
      if (request.method === "ping") { reply({}); continue; }
      if (request.method !== "tools/call") throw new Error("Unsupported MCP method");
      const params = record(request.params); if (!availableTools(configuration.role).some(tool => tool.name === params.name)) throw new Error("Tool is unavailable for this role");
      const result = await callHost(configuration.socketPath, configuration.token, "role_call", { ...params, paneId: textField(process.env.HERDR_PANE_ID) });
      reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (error) { reply({ isError: true, content: [{ type: "text", text: String(error) }] }); }
  }
}
export async function runProviderHook(configuration: RoleConfiguration, event: string): Promise<void> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += Buffer.byteLength(chunk); if (size > 1024 * 1024) throw new Error("Oversized provider hook"); chunks.push(Buffer.from(chunk)); }
  const hook = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const paneId = textField(process.env.HERDR_PANE_ID);
  if (event === "SessionStart" || event === "Stop") {
    const session = textField(hook.session_id);
    if (event !== hook.hook_event_name) throw new Error("Provider hook event mismatch");
    if (hook.agent_id || process.env.CURSOR_VERSION || hook.cursor_version) return;
    const request = { id: `bflow-native-${Date.now()}`, method: "pane.report_agent_session", params: { pane_id: paneId,
      source: "herdr:claude", agent: "claude", seq: Date.now() * 1000, agent_session_id: session,
      ...(typeof hook.transcript_path === "string" ? { agent_session_path: hook.transcript_path } : {}),
      ...(typeof hook.source === "string" ? { session_start_source: hook.source } : {}) } };
    await new Promise<void>((accept, reject) => {
      const socket = connect(textField(process.env.HERDR_SOCKET_PATH)); let response = "";
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("Native session report timed out")); }); socket.once("error", reject);
      socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.on("data", chunk => { response += String(chunk); if (!response.includes("\n")) return; socket.end();
        try { record(JSON.parse(response.split("\n")[0]!)).error ? reject(new Error("Herdr rejected native provider session")) : accept(); } catch (error) { reject(error); } });
    });
    if (event === "SessionStart") await callHost(configuration.socketPath, configuration.token, "provider_started", { paneId, nativeSessionId: session });
    if (event === "SessionStart") await callHost(configuration.socketPath, configuration.token, "native_session", {paneId, sessionId:session});
  }
  if (event === "UserPromptSubmit") {
    let message: RoleMessage | undefined;
    try { message = RoleMessageSchema.parse(JSON.parse(textField(hook.prompt))); } catch { /* ordinary user dialogue */ }
    if (message) {
      await callHost(configuration.socketPath, configuration.token, "transport_prompt", { paneId, message });
      return;
    }
  }
  if (event === "UserPromptSubmit" && configuration.role === "conversation") {
    const result = await callHost(configuration.socketPath, configuration.token, "user_prompt", { paneId, hook });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Trusted Bflow Conversation Gateway result: " + JSON.stringify(result) } }) + "\n");
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2], path = process.argv[3];
  const task = !path ? Promise.reject(new Error("Host configuration path required")) : mode === "daemon" ? readHostConfiguration(path).then(runAgenticHost)
    : readRoleConfiguration(path).then(configuration => mode === "mcp" ? runRoleMcp(configuration) : mode === "hook" ? runProviderHook(configuration, textField(process.argv[4])) : Promise.reject(new Error("Unknown host mode")));
  task.catch(error => { process.stderr.write(redactString(String(error)) + "\n"); process.exitCode = 1; });
}
