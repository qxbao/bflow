import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AgentBindingReceiptSchema, AgentExecutionHandleSchema, AgentProviderIdSchema, AgentResultSchema, AgentRoleSchema, ApprovalDecisionSchema,
  JsonValueSchema, RoleMessageSchema, RunQuerySchema, SessionManifestSchema,
  type AgentProviderId, type AgentRole, type RoleMessage, type SessionManifest, type RunStore
} from "@bflow/contracts";
import { authenticateNativeHerdrMessage } from "./herdr-ingress.js";
import { callHost } from "./host-protocol.js";
import { readHostConfiguration, type HostConfiguration, type RoleLaunchDescriptor } from "./host-controller.js";
import { digest, json, record, textField } from "./journal.js";
import { COORDINATOR_TOOLS } from "./tools.js";
import { USER_DECISION_TOOL, guardDirectUserInteraction, parseUserDecisionToolInput } from "./decision-routing.js";
import { openAgenticWorkspace, type AgenticWorkspaceHandle } from "./workspace.js";
import { unwrap } from "./outbox.js";
import { HostVerification, HostBehavioralFailure, DEFAULT_HOST_CHECKS } from "./host-verification.js";
import { HostReceiptJournal, type HumanHookProvenance } from "./host-receipts.js";
import { parseBehavioralCommands } from "./behavioral-runner.js";
import { HostDevelopment } from "./host-development.js";
import { redactString } from "../resilience/redaction.js";
import { createHostPlatformSession, launchMaterial, type HostAgentObservation, type HostPlatformSession, type StartupProof } from "./host-platform.js";
import {
  assertRoleToolReachability, BFLOW_LAUNCH_ID_ENV, LAUNCH_REACHABILITY_DIRECTORY, launchReceiptName, probeAllGateways, ProviderBootstrapPayloadSchema,
  ProviderStartedPayloadSchema, readLaunchReachabilityFact, removeLegacyRoleProbes, reportedReachabilityOf, resolveProbePlan, selectReachabilityFact,
  summarizeToolReachability, writeLaunchReachability, type ReachabilityExpectation, type ReachabilityFact, type ReachabilitySource,
  type RoleToolReachability, type ToolReachabilityRecord
} from "./tool-reachability.js";

const execute = promisify(execFile);
const roles = ["conversation", "coordinator", "specifier", "architect", "planner", "developer", "tester", "reviewer", "qa", "security"] as const;
const capabilities = { conversation: ["conversation"], coordinator: ["coordination", "planning", "specification"],
  specifier: ["specification"], architect: ["architecture"], planner: ["planning"], developer: ["implementation"],
  tester: ["testing"], reviewer: ["review"], qa: ["verification", "testing"], security: ["security"] };
interface RoleConfiguration { socketPath: string; token: string; role: AgentRole; provider: AgentProviderId; herdrBinary: string; sessionId: string }
async function privateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 }); await chmod(path, 0o600);
}
async function readRoleConfiguration(path: string): Promise<RoleConfiguration> {
  const stat = await lstat(path); if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe role host configuration");
  const raw = record(JSON.parse(await readFile(path, "utf8")));
  // Legacy role files predate the provider field and always meant Claude.
  return { socketPath: textField(raw.socketPath), token: textField(raw.token), role: AgentRoleSchema.parse(raw.role), provider: AgentProviderIdSchema.parse(raw.provider ?? "claude"),
    herdrBinary: textField(raw.herdrBinary), sessionId: textField(raw.sessionId) };
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
const NATIVE_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PreToolUse"] as const;
function hookCommandFor(rolePath: string, event: string): string { return [process.execPath, fileURLToPath(import.meta.url), "hook", rolePath, event].map(shellQuote).join(" "); }

export const NON_USER_FACING_AUTONOMOUS_POLICY = [
  "You are a non-user-facing execution agent.",
  "The user does not monitor or read your pane.",
  "Do not ask the user questions. Do not wait for a user response. Do not request conversational permission to continue.",
  "Execute your assigned task autonomously using the tools, skills, and permissions available to you.",
  "When information is missing, make a reversible, low-risk assumption and record it.",
  "If a decision requires user approval, changes an approved specification, or exceeds your authority, send a structured escalation to Coordinator through Herdr and mark the task as blocked.",
  "Never treat the lack of a user response in your pane as permission to bypass a security or approval boundary.",
  "Do not claim success without verification evidence.",
  "When finished, emit a structured result and notify Coordinator."
].join("\n\n");

export const NON_USER_FACING_STRUCTURED_RESULT_REQUIREMENT =
  "Structured result requirements: Emit structured results with fields: status, summary, evidence, artifacts, blockers, requested_action, next_role (and optional assumptions). Specialist panes must never send messages to the user.";

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
  // The manifest of the latest activation attempt: diagnostics (`platform_status`) report its proofs even when it was refused.
  let attemptedManifest: SessionManifest | undefined;
  let quiesced = false, quiesceCompleted = false, closing = false;
  let scheduler: Promise<unknown> | undefined, schedulerError: string | undefined;
  const receipts = new HostReceiptJournal(join(configuration.directory, "authentication-receipts"), configuration.repositoryPath, configuration.sessionId);
  const roleTokens = new Map<string, AgentRole>();
  const launch: Record<string, RoleLaunchDescriptor> = {};
  /** H1: per prepared role launch with Gateway registrations, what its provider process must prove reachable. */
  const toolExpectations = new Map<AgentRole, ReachabilityExpectation>();
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
  const promptAssets = await import(new URL("../../../pane-manager/dist/index.js", import.meta.url).href);
  const platformRoles = configuration.platform?.roles ?? [];
  for (const role of roles) {
    const path = join(configuration.directory, role + ".json");
    const provider: AgentProviderId = platformRoles.find(option => option.role === role)?.provider ?? "claude";
    let roleConfig: RoleConfiguration;
    try { roleConfig = await readRoleConfiguration(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      roleConfig = { socketPath: configuration.socketPath, role, token: randomBytes(32).toString("hex"), provider, sessionId: configuration.sessionId, herdrBinary: binary };
      await privateFile(path, JSON.stringify(roleConfig)); }
    if (roleConfig.role !== role || roleConfig.socketPath !== configuration.socketPath || roleConfig.sessionId !== configuration.sessionId) throw new Error("Foreign role configuration");
    // Same token, new provider: a platform change is only admissible while no host owns the endpoint.
    if (roleConfig.provider !== provider) { roleConfig = { ...roleConfig, provider }; await privateFile(path, JSON.stringify(roleConfig)); }
    roleTokens.set(roleConfig.token, role);
    const mcpConfigFile = join(configuration.directory, role + ".mcp.json");
    const hooksSettingsFile = join(configuration.directory, role + ".hooks.json");
    await privateFile(mcpConfigFile, JSON.stringify({ mcpServers: { bflow: { type: "stdio", command: process.execPath, args: [executable, "mcp", path] } } }));
    const hooks = Object.fromEntries(NATIVE_HOOK_EVENTS.map(event => [event, [{ hooks: [{ type: "command", command: hookCommandFor(path, event), timeout: 30 }] }]]));
    await privateFile(hooksSettingsFile, JSON.stringify({ hooks }));
    let systemPrompt = `You are Bflow's ${role} in a dedicated Herdr pane. Use the bflow MCP tools. All cross-role messages must use send_role_message through native Herdr; never use files as a mailbox. Never fabricate evidence or approvals. `;
    const promptInput = await promptAssets.readBuiltinRolePrompt(role);
    const original = promptInput === null ? null : record(JsonValueSchema.parse(promptInput));
    if (["conversation", "coordinator"].includes(role) && !original) throw new Error(`The required original ${role} agent prompt is missing; reinstall the complete Bflow distribution.`);
    const basePrompt = original ? textField(original.prompt) : "";
    if (original) {
      textField(original.source);
      systemPrompt += basePrompt;
      if (role !== "conversation" && !basePrompt.includes("You are a non-user-facing execution agent.")) {
        systemPrompt += "\n\n" + NON_USER_FACING_AUTONOMOUS_POLICY + "\n\n" + NON_USER_FACING_STRUCTURED_RESULT_REQUIREMENT;
      }
      systemPrompt += "\n\nTrusted host integration instructions:\n";
    } else if (role !== "conversation") {
      systemPrompt += "\n\n" + NON_USER_FACING_AUTONOMOUS_POLICY + "\n\n" + NON_USER_FACING_STRUCTURED_RESULT_REQUIREMENT + "\n\nTrusted host integration instructions:\n";
    }
    if (role === "conversation") systemPrompt += "You are the sole user interface. The trusted UserPromptSubmit hook supplies the Conversation Gateway result as additional context. Greetings and questions need no workflow. Explain Gateway clarifications and forward the user's actual intent through that Gateway. Never call coordination tools or edit source. User approval comes exclusively from the trusted hook; an MCP call cannot approve.";
    else if (role === "coordinator") {
      systemPrompt += "Inspect the durable inbox, assess the spec and propose a schema-valid workflow. Runtime controls dispatch and quality/approval gates. Never edit source or approve human-required gates.";
    } else if (role === "developer") systemPrompt += "Read assignment_context and workspace_status for the exact accepted specification, owned paths and worktree. Native shell is disabled: use commit_changes with expectedHead for scoped commits and check_work for untrusted feedback. Required TDD: first edit/commit only configured testPaths, request_verification(red), then END YOUR TURN. Runtime sends a phase outcome to resume you. After independent Red, tests are frozen: authorize_implementation, edit source, commit, check_work, then request_verification(green) and yield. On Green receipt, refactor source if appropriate without editing Red tests, commit, request_verification(refactor) and yield. For non-required automated work, request_verification(verification) after a clean commit and yield. Submit implementation only when all required automated phase receipts exist. Manual docs evidence is requested after submission. Never modify accepted criteria/specification or claim your own feedback is independent acceptance.";
    else systemPrompt += "Read incoming RoleMessage. Inspect the exact assigned revision and criteria independently. Use host verification tools for evidence; never invent command output. Send replies through send_role_message with original correlation and causation. End your turn after sending.";
    if (role === "coordinator") systemPrompt += " Use planning_reference to read the shipped specification example, policy metadata schema and workflow contract before proposing a workflow. Specialist requests can gather project details; repository files are never a mailbox.";
    if (role !== "conversation") {
      systemPrompt += " Never ask the user questions directly or wait for user responses in your pane; make and record reversible low-risk assumptions, or escalate blockers/approvals to Coordinator via Herdr (RoleMessage) and mark the task blocked. Emit structured results (status, summary, evidence, artifacts, blockers, requested_action, next_role) with verification evidence before claiming completion.";
    }
    launch[role] = { systemPrompt, mcpConfigFile, hooksSettingsFile };
  }
  // P30 readiness is composed once per daemon. Without `platform` the legacy launch material above is served unchanged.
  const platformSession: HostPlatformSession | undefined = configuration.platform === undefined ? undefined : await createHostPlatformSession({
    platform: configuration.platform, repositoryPath: configuration.repositoryPath, sessionId: configuration.sessionId, directory: configuration.directory,
    issuerId, privateKeyPem: await readFile(keyPath, "utf8"), publicKeyPem: publicKey, hostCapabilities: capabilities,
    rolePrompt: role => launch[role]?.systemPrompt,
    hostLaunch: role => {
      const rolePath = join(configuration.directory, role + ".json");
      const hookEntries = Object.fromEntries(NATIVE_HOOK_EVENTS.map(event => [event, hookCommandFor(rolePath, event)]));
      return { mcpServers: { bflow: { command: process.execPath, args: [executable, "mcp", rolePath] } }, hooks: hookEntries };
    },
    nativeSessionHookCommand: role => hookCommandFor(join(configuration.directory, role + ".json"), "SessionStart")
  });
  const observeAgent = async (paneId: string): Promise<HostAgentObservation> => {
    const agent = record(record(record(JSON.parse(await herdr(["agent", "get", paneId]))).result).agent);
    const native = agent.agent_session ? record(agent.agent_session) : undefined;
    const status = agent.agent_status ?? agent.agentStatus;
    return { ...(typeof agent.name === "string" ? { name: agent.name } : {}), status: typeof status === "string" ? status : "unknown",
      ...(native ? { nativeSession: { source: String(native.source), kind: native.kind as "id" | "path" | "opaque", value: String(native.value) } } : {}) };
  };
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
  const nativeDeliver = async (message: RoleMessage, operationId = message.message_id) => {
    const sender = (await principal(AgentRoleSchema.parse(message.sender.role), textField(message.sender.pane_id)));
    if (message.sender.agent_id !== sender.agentId) throw new Error("Role message sender does not match authenticated pane");
    const previous = await receipts.nativeDelivery(operationId);
    if (previous) {
      const semanticMessage = (value: RoleMessage) => ({ ...value, message_id: undefined, occurred_at: undefined, idempotency_key: undefined });
      if (digest(semanticMessage(previous.message)) !== digest(semanticMessage(message))) throw new Error("Native operation already has a different immutable receipt; inspect its original result");
      if (previous.status === "acknowledged") return json({ delivered: true, messageId: previous.message.message_id });
      throw new Error("Native delivery is uncertain; reconcile the original operation before retrying");
    }
    if (!await receipts.recordNativeIntent(operationId, message)) throw new Error("Native delivery already started; reconcile before retrying");
    const socketPath = textField(record(JSON.parse(await herdr(["status", "server", "--json"]))).socket);
    await new Promise<void>((accept, reject) => {
      const socket = connect(socketPath); let output = "";
      socket.setTimeout(20_000, () => { socket.destroy(); reject(new Error("Native Herdr action timed out; reconcile before retry")); });
      socket.once("error", reject);
      socket.once("close", () => { if (!output.includes("\n")) reject(new Error("Native Herdr action closed before acknowledgement; reconcile before retry")); });
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
  const behavioralCommands = parseBehavioralCommands(configuration.behavioralCommands);
  const verification = new HostVerification(() => requireWorkspace().runtime, () => requireWorkspace().runtime.ports.artifactStore, receipts, behavioralCommands);
  const development = new HostDevelopment(() => requireWorkspace().runtime, behavioralCommands);
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
  const receiptPathOf = (role: AgentRole, paneId: string) => join(configuration.directory, "launch-receipts", launchReceiptName(role, paneId));
  const readLaunchReceipt = async (role: AgentRole, paneId: string): Promise<Record<string, unknown> | undefined> => {
    try { return record(JSON.parse(await readFile(receiptPathOf(role, paneId), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  };
  // Startup receipts (one per role and pane) have two writers: the provider SessionStart hook (`provider_started`, which
  // carries the native session id) and the MCP bootstrap (`provider_bootstrap`, reachability only). Both reach the
  // reachability precedence through this single serialized writer, so the first all-ok proof of a launch is kept.
  let startupWrites: Promise<unknown> = Promise.resolve();
  const writeStartupReceipt = (role: AgentRole, paneId: string, input: { readonly nativeSessionId?: string;
    readonly reachability?: { readonly launchId: string; readonly toolReachability: readonly ToolReachabilityRecord[]; readonly source: ReachabilitySource } }): Promise<void> => {
    const work = async (): Promise<void> => {
      const path = receiptPathOf(role, paneId);
      const stored = await readLaunchReceipt(role, paneId);
      const storedReported = stored === undefined ? undefined : reportedReachabilityOf(stored);
      const storedFact: ReachabilityFact | undefined = storedReported === undefined ? undefined : { launchId: storedReported.launchId, paneId,
        toolReachability: storedReported.toolReachability, source: stored?.reachabilitySource === "mcp_bootstrap" ? "mcp_bootstrap" : "hook" };
      const incoming = input.reachability === undefined ? undefined : { paneId, ...input.reachability };
      const chosen = incoming === undefined ? storedFact : selectReachabilityFact(storedFact, incoming);
      // A native session is only ever reported by the hook; without one the startup proof is the MCP bootstrap.
      const nativeSessionId = input.nativeSessionId ?? (typeof stored?.nativeSessionId === "string" ? stored.nativeSessionId : undefined);
      await mkdir(join(configuration.directory, "launch-receipts"), { recursive: true, mode: 0o700 });
      await privateFile(path, JSON.stringify({ role, paneId, source: nativeSessionId === undefined ? "mcp_bootstrap" : "hook",
        ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
        ...(chosen === undefined ? {} : { launchId: chosen.launchId, toolReachability: chosen.toolReachability, reachabilitySource: chosen.source }) }));
      if (incoming !== undefined) {
        const directory = join(configuration.directory, LAUNCH_REACHABILITY_DIRECTORY);
        const winner = selectReachabilityFact(await readLaunchReachabilityFact(directory, incoming.launchId), incoming);
        await writeLaunchReachability(directory, winner.launchId, winner.paneId, winner.toolReachability, winner.source);
      }
    };
    const run = startupWrites.then(work, work);
    startupWrites = run.catch(() => undefined);
    return run;
  };
  const activate = async (input: unknown) => {
    const accepted = SessionManifestSchema.parse(input);
    attemptedManifest = accepted;
    if (accepted.sessionId !== configuration.sessionId || accepted.workspaceRoot !== configuration.repositoryPath || accepted.status !== "up") throw new Error("Foreign or unready session manifest");
    if (workspace) { if (quiesced) throw new Error("Host is quiesced; reconcile and restart after shutdown"); return null; }
    // Launch receipts retained for this activation, keyed by role (H1 reads their reachability fields).
    const launchReceipts = new Map<AgentRole, Record<string, unknown>>();
    // Startup proof per role: `hook` (SessionStart receipt with the native session id) or `mcp_bootstrap` (the MCP child's
    // reachability receipt for this exact launch; its native session is Herdr's own observation, checked below).
    const startupPaths = new Map<AgentRole, "hook" | "mcp_bootstrap">();
    // An older pane may have a valid Herdr session but no Bflow tools/hooks.
    // Require a launch-local startup receipt for this exact pane: the hook's native session or the MCP bootstrap.
    for (const pane of accepted.panes) {
      if (!pane.permanent || pane.role === "developer") continue;
      const path = receiptPathOf(pane.role, pane.paneId);
      let receipt: Record<string, unknown>;
      try { receipt = record(JSON.parse(await readFile(path, "utf8"))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`[bflow:native-startup-pending] ${pane.role} pane ${pane.paneId} is still publishing ${path}; wait for its Bflow startup proof (SessionStart hook or MCP bootstrap).`);
        throw error;
      }
      const mismatch = () => new Error(`Pane '${pane.paneId}' has no matching native Bflow launch receipt; preserve it and reconcile provider startup`);
      if (receipt.role !== pane.role || receipt.paneId !== pane.paneId) throw mismatch();
      if (typeof receipt.nativeSessionId === "string") {
        if (!pane.session || receipt.nativeSessionId !== pane.session.value) throw mismatch();
        startupPaths.set(pane.role, "hook");
      } else {
        // The bootstrap receipt must name the launch this host prepared for the role (when one is prepared).
        const prepared = platformSession?.launchIdOf(pane.role);
        if (receipt.source !== "mcp_bootstrap" || typeof receipt.launchId !== "string" || (prepared !== undefined && receipt.launchId !== prepared)) throw mismatch();
        startupPaths.set(pane.role, "mcp_bootstrap");
      }
      launchReceipts.set(pane.role, receipt);
    }
    let nativeSessionsChanged = false;
    for (const pane of accepted.panes) {
      const actual = record(record(record(JSON.parse(await herdr(["agent", "get", pane.paneId]))).result).agent);
      const native = actual.agent_session ? record(actual.agent_session) : undefined;
      if (startupPaths.get(pane.role) === "mcp_bootstrap") {
        // No SessionStart hook registered this pane: Herdr's observed native session is the proof, registered here.
        if (!native) throw new Error(`[bflow:native-startup-pending] ${pane.role} pane ${pane.paneId} has bootstrap reachability but Herdr reports no native session yet.`);
        if (native.source !== `herdr:${pane.provider}` || native.kind !== "id" || (actual.name ?? actual.agent) !== pane.agentId)
          throw new Error(`Role ${pane.role} has no matching Bflow provider startup/native-session receipt; stop and recreate legacy bare panes`);
        if (!pane.session || pane.session.source !== native.source || pane.session.kind !== native.kind || pane.session.value !== native.value)
          throw new Error(`[bflow:native-startup-pending] ${pane.role} pane ${pane.paneId}: the manifest has not recorded Herdr's observed native session yet.`);
        const registered = nativeSessions.get(pane.paneId);
        if (registered?.role !== pane.role || registered.sessionId !== native.value) {
          nativeSessions.set(pane.paneId, { role: pane.role, sessionId: String(native.value) });
          nativeSessionsChanged = true;
        }
        continue;
      }
      const receipt = nativeSessions.get(pane.paneId);
      if (native && pane.session?.value === native.value && (!receipt || receipt.sessionId !== native.value))
        throw new Error(`[bflow:native-startup-pending] ${pane.role} pane ${pane.paneId} is still publishing its Bflow native-session receipt.`);
      if (!receipt || receipt.role !== pane.role || !native || native.source !== `herdr:${pane.provider}` || native.kind !== "id" || native.value !== receipt.sessionId ||
          pane.session?.value !== receipt.sessionId || (actual.name ?? actual.agent) !== pane.agentId)
        throw new Error(`Role ${pane.role} has no matching Bflow provider startup/native-session receipt; stop and recreate legacy bare panes`);
    }
    if (nativeSessionsChanged) await privateFile(join(configuration.directory, "native-sessions.json"), JSON.stringify(Object.fromEntries(nativeSessions)));
    // Native sessions are proven above. H1: each required role with Gateway registrations must prove, from inside its
    // launched provider process, that every registration reaches its allowed tools; only then is platform readiness checked.
    if (platformSession) {
      for (const [role, expectation] of toolExpectations) {
        const pane = accepted.panes.find(candidate => candidate.role === role);
        const required = platformRoles.find(option => option.role === role)?.required === true;
        if (!pane || !required) continue;
        assertRoleToolReachability(role, expectation, reportedReachabilityOf(launchReceipts.get(role) ?? {}));
      }
      await platformSession.verifyActivation(accepted.panes, observeAgent);
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
      ...(configuration.manifestDirectory ? { manifestDirectory: configuration.manifestDirectory } : {}),
      ...(platformSession ? { developerLaunches: {
        allocate: request => platformSession.allocateDeveloper(request.taskId, request.worktreePath),
        release: taskId => platformSession.releaseDeveloper(taskId),
        reachability: (launchId, paneId) => platformSession.developerReachability(launchId, paneId),
        degradation: () => platformSession.degradation()
      } } : {}), maxDeveloperCapacity: configuration.policy?.concurrency.maxConcurrency ?? configuration.maxDeveloperCapacity ?? 2,
      nativeIngressSocket: nativeSocket, bindingReceiptKeys: { [issuerId]: publicKey }, roleLaunch: launch,
      roleCapabilities: capabilities, taskChecks: [...DEFAULT_HOST_CHECKS, ...verification.behavioralChecks()],
      workflowChecks: [...DEFAULT_HOST_CHECKS, ...verification.behavioralChecks()], deterministicGates: [verification.deterministicGate(), ...verification.behavioralGates()],
      authenticateMessage: authenticateNativeHerdrMessage,
      authenticateResult: async (result, handle, message) => await authenticateNativeHerdrMessage(message) && result.requestId === handle.requestId && result.executionId === handle.executionId,
      authenticateEvidence: async (result, message) => await authenticateNativeHerdrMessage(message) && verification.authenticateEvidence(result),
      authenticateGateResult: async (result, message) => await authenticateNativeHerdrMessage(message) && verification.authenticateGate(result),
      projectApprovalRequired: () => configuration.policy?.sdd.approvalRequired === true,
      authorizeHuman: decision => receipts.authenticateHuman(decision),
      recoveredHumanDecisions: await receipts.humanDecisions(),
      onNativeDelivery: async message => { await receipts.recordNativeAcknowledgement(message); deliveredMessageIds.add(message.message_id); },
      onHumanDecision: async decision => { if (!humanHookProvenance) throw new Error("Human approval requires physical user input hook");
        await receipts.recordHuman(ApprovalDecisionSchema.parse(decision), humanHookProvenance); }
    });
    manifest = accepted;
    return null;
  };
  const deliveredMessageIds = new Set<string>();
  let humanHookProvenance: HumanHookProvenance | undefined;
  let userQueue: Promise<unknown> = Promise.resolve();
  const roleCall = async (role: AgentRole, input: unknown) => {
    const args = record(input); const name = textField(args.name); const parameters = record(JsonValueSchema.parse(args.arguments ?? {}));
    const binding = await principal(role, textField(args.paneId));
    const host = requireWorkspace();
    if (quiesced && !["host_status", "assignment_context", "inspect_review", "complete_review", "inspect_alternative_verification", "record_alternative_verification", "record_behavioral_verification", "submit_implementation"].includes(name)) throw new Error("Host is quiesced; new work is disabled while existing receipts can drain");
    if (name === "planning_reference") {
      if (role !== "coordinator") throw new Error("Only Coordinator reads host planning guidance");
      const section = textField(parameters.section);
      const references: Record<string, string[]> = { specification:["../../../../templates/node-typescript/specifications/docs.spec.json","../../../specification/dist/schema.js","../../../specification/dist/classification.js"],
        test_strategy:["../../../test-strategy/dist/schema.js","../../../../templates/node-typescript/specifications/bugfix.spec.json"], workflow:["../../../contracts/dist/workflow.js"] };
      const selected = references[section]; if (!selected) throw new Error("Unknown planning section: choose specification, test_strategy, workflow");
      return json({ references: await Promise.all(selected.map(async path => ({source:path,content:await readFile(new URL(path,import.meta.url),"utf8")}))),
        behavioralCommands: behavioralCommands.map(({ id, command, method, levels, testNames, testPaths, reporter }) =>
          ({ id, command, method, levels, testNames, testPaths, reporter: reporter ?? "node_tap" })) });
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
      const out = [...state.outbound as Record<string, unknown>[]].reverse().find(item => ["accepted", "released"].includes(String(item.status)) && record(item.message).type === "task.assignment" &&
        record(item.message).run_id === parameters.runId && item.taskId === parameters.taskId && item.handle && record(record(item.handle).target).paneId === binding.paneId);
      if (!out) throw new Error("No accepted assignment for this Developer");
      const run = record(await host.runtime.inspect(textField(parameters.runId)));
      const task = Array.isArray(run.tasks) ? run.tasks.map(record).find(item => item.taskId === parameters.taskId) : undefined;
      if (!task) throw new Error("Missing accepted task dossier");
      const strategy = record(record(task.spec).strategy);
      if (Array.isArray(strategy.targetCommands) && strategy.targetCommands.length)
        host.runtime.ports.policies.assertEvidenceComplete(strategy);
      const handle = AgentExecutionHandleSchema.parse(out.handle), original = RoleMessageSchema.parse(out.message);
      if (digest(handle.target.session) !== digest(binding.session) || handle.target.agentId !== binding.agentId)
        throw new Error("Implementation submission native assignment changed");
      const priorSubmission = await receipts.nativeDelivery(`implementation:${handle.requestId}`);
      if (priorSubmission) return nativeDeliver(priorSubmission.message, `implementation:${handle.requestId}`);
      if (out.status !== "accepted") throw new Error("Implementation assignment released without an authenticated submission receipt");
      const envelope = (type: RoleMessage["type"], payload: unknown) => RoleMessageSchema.parse({ schema_version: 2, message_id: randomUUID(), correlation_id: original.correlation_id,
        causation_id: original.message_id, run_id: original.run_id, sender: { role, agent_id: binding.agentId, pane_id: binding.paneId }, recipient: { role: "coordinator" }, type, payload: json(payload), artifact_references: [], occurred_at: new Date().toISOString(), idempotency_key: randomUUID() });
      const receipt = AgentBindingReceiptSchema.parse({ schemaVersion: 1, receiptId: `binding-${handle.requestId}`, issuerId, handle,
        correlation: { token: original.message_id, provenance: "transport", verified: true }, observedAt: new Date().toISOString(), signature: { algorithm: "ed25519", value: Buffer.alloc(64).toString("base64") } });
      const priorBinding = await receipts.nativeDelivery(`binding:${handle.requestId}`);
      await nativeDeliver(priorBinding?.message ?? envelope("execution.receipt", receipt), `binding:${handle.requestId}`);
      const snapshot = unwrap(await host.runtime.ports.engine.getSnapshot(handle.runId));
      const proof = snapshot?.tasks.find(task => task.taskId === handle.taskId)?.bindingVerification;
      if (!proof) throw new Error("Native binding has not been verified by Core");
      if (parameters.status !== undefined && parameters.status !== "succeeded") throw new Error("This tool currently accepts succeeded submissions only; report blockers with task.status");
      const result = AgentResultSchema.parse({ requestId: handle.requestId, attemptId: handle.attemptId, runId: handle.runId, taskId: handle.taskId, executionId: handle.executionId,
        status: "succeeded", verification: { status: "verified", correlation: proof.receipt.correlation, evidence: "Native Herdr host checked the actual assignment/session binding; independent acceptance is pending" },
        artifactProposals: [], retryable: false, startedAt: handle.acceptedAt, completedAt: new Date().toISOString() });
      return nativeDeliver(envelope("implementation.submitted", result), `implementation:${handle.requestId}`);
    }
    const envelope = (source: RoleMessage, type: RoleMessage["type"], payload: unknown, artifacts: RoleMessage["artifact_references"] = []) => RoleMessageSchema.parse({ schema_version: 2,
      message_id: randomUUID(), correlation_id: source.correlation_id, causation_id: source.message_id, run_id: source.run_id,
      sender: { role, agent_id: binding.agentId, pane_id: binding.paneId }, recipient: { role: "coordinator" }, type, payload: json(payload), artifact_references: artifacts,
      occurred_at: new Date().toISOString(), idempotency_key: randomUUID() });
    if (name === USER_DECISION_TOOL) {
      if (role === "conversation") throw new Error("Conversation asks the user directly; request_user_decision is for other roles");
      return host.runtime.requestUserDecision(binding, role, parseUserDecisionToolInput(parameters));
    }
    if (name === "inspect_review") return verification.inspectReview(binding, parameters);
    if (name === "workspace_status") return development.status(binding, parameters);
    if (name === "commit_changes") return development.commit(binding, parameters);
    if (name === "check_work") return development.check(binding, parameters);
    if (name === "request_verification") {
      const current = record(await development.status(binding, parameters));
      return host.runtime.requestPhaseVerification(binding, textField(current.runId), textField(current.taskId), textField(parameters.phase), textField(current.head));
    }
    if (name === "record_behavioral_verification") {
      if (!["qa", "tester"].includes(role)) throw new Error("Only independent QA/Tester may measure policy evidence");
      const state = record(await host.runtime.inspect());
      const requests = Array.isArray(state.outbound) ? state.outbound.map(record).filter(out => ["accepted", "released"].includes(String(out.status)) && out.handle &&
        record(record(out.handle).target).paneId === binding.paneId && record(record(out.handle).target).agentId === binding.agentId &&
        digest(record(record(out.handle).target).session) === digest(binding.session) && record(out.message).type === "verification.requested" &&
        record(out.message).run_id === parameters.runId && record(record(out.message).payload).kind === "conditional_evidence" &&
        record(record(out.message).payload).taskId === parameters.taskId && record(record(out.message).payload).phase === parameters.phase &&
        !String(out.error ?? "").startsWith("policy_phase_failed:")) : [];
      if (requests.length !== 1) throw new Error("No unique assigned policy-phase request for this verifier");
      const source = RoleMessageSchema.parse(requests[0]!.message);
      const applied = Array.isArray(state.inbox) ? state.inbox.map(record).find(item => item.status === "applied" &&
        record(item.message).causation_id === source.message_id && record(item.message).type === "verification.result") : undefined;
      if (applied) return json({ alreadyRecorded: true, verificationId: record(record(applied.message).payload).verificationId });
      if (requests[0]!.status !== "accepted") throw new Error("Policy verifier lease released without applied evidence; reconcile the original request");
      let completed: Awaited<ReturnType<HostVerification["behavioralEvidence"]>>;
      try {
        completed = await verification.behavioralEvidence(binding, parameters);
        if (record(completed.result.metadata?.conditionalTdd).sourceRevision !== record(source.payload).sourceRevision)
          throw new Error("Policy phase source changed after the request; reconcile before accepting evidence");
      } catch (error) {
        return host.runtime.recordPhaseFailure(binding, source.message_id, redactString(String(error)), error instanceof HostBehavioralFailure,
          error instanceof HostBehavioralFailure ? error.evidence : undefined);
      }
      return nativeDeliver(envelope(source, "verification.result", completed.result, completed.result.evidenceArtifacts), `behavioral:${completed.result.verificationId}`);
    }
    if (name === "inspect_alternative_verification") return verification.inspectAlternative(binding, parameters);
    if (name === "complete_review") {
      const completed = await verification.completeReview(binding, parameters);
      const state = record(await host.runtime.inspect());
      const out = (state.outbound as Record<string, unknown>[]).find(item => record(item.message).message_id === parameters.messageId);
      if (!out) throw new Error("Review causation unavailable");
      return nativeDeliver(envelope(RoleMessageSchema.parse(out.message), "review.verdict", completed.result, [completed.artifact]), `review:${textField(parameters.reviewId)}`);
    }
    if (name === "record_alternative_verification") {
      const completed = await verification.alternativeEvidence(binding, parameters);
      return nativeDeliver(envelope(RoleMessageSchema.parse(completed.assignment), "verification.result", completed.result, completed.result.evidenceArtifacts), `alternative:${textField(parameters.observationId)}`);
    }
    if (name === "propose_workflow") {
      if (configuration.policy?.verification.maxIterations !== undefined) {
        if (parameters.maxIterations !== undefined && parameters.maxIterations !== configuration.policy.verification.maxIterations) throw new Error("Verification limit is fixed by the project owner policy");
        parameters.maxIterations = configuration.policy.verification.maxIterations;
      }
      const spec = record(parameters.specification);
      if (configuration.policy?.sdd.minimumLevel === "full" && spec.level !== "full") throw new Error("Project policy requires a full specification");
      verification.assertSupported(spec, host.runtime.ports.policies.strategy.resolve(spec));
    }
    return host.tools.invoke(name, parameters, { role });
  };
  const physicalPrompts: {role: AgentRole; paneId: string; message: RoleMessage}[] = [];
  const dispatch = async (token: string, method: string, params: unknown): Promise<unknown> => {
    if (token !== configuration.token) {
      const role = roleTokens.get(token); if (!role) throw new Error("Host authentication failed");
      if (method === "tool_guard") {
        const input = record(params), hook = record(input.hook), binding = await principal(role, textField(input.paneId));
        if (hook.hook_event_name !== "PreToolUse" || !binding.session || hook.session_id !== binding.session.value)
          throw new Error("Tool guard native session mismatch");
        const tool = textField(hook.tool_name);
        const direct = guardDirectUserInteraction(role, tool);
        if (!direct.permitted) throw new Error(direct.reason);
        if (tool.startsWith("mcp__bflow__") || ["Read", "Glob", "Grep", "ToolSearch"].includes(tool)) return { permitted: true };
        if (role !== "developer" || !["Edit", "Write"].includes(tool)) throw new Error("Native mutation/command tool is unavailable for this role");
        await development.authorizeFileEdit(binding, hook); return { permitted: true };
      }
      if (method === "provider_started") {
        const receipt = ProviderStartedPayloadSchema.parse(params);
        // Reachability is keyed by launch, not role: concurrent Developers share a role and never overwrite each other's proof.
        await writeStartupReceipt(role, receipt.paneId, { nativeSessionId: receipt.nativeSessionId,
          ...(receipt.launchId === undefined || receipt.toolReachability === undefined ? {} :
            { reachability: { launchId: receipt.launchId, toolReachability: receipt.toolReachability, source: "hook" as const } }) });
        return { recorded: true };
      }
      if (method === "provider_bootstrap") {
        // Sent by the MCP child at provider startup, from the provider environment (no SessionStart hook needed).
        const payload = ProviderBootstrapPayloadSchema.parse(params);
        if (payload.paneId === undefined) throw new Error("provider_bootstrap requires the provider pane id");
        await writeStartupReceipt(role, payload.paneId, { reachability: { launchId: payload.launchId, toolReachability: payload.toolReachability, source: "mcp_bootstrap" } });
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
        const input = record(params); const binding = await principal(role, textField(input.paneId));
        const hook = record(input.hook); if (hook.hook_event_name !== "UserPromptSubmit") throw new Error("Physical user input hook required");
        const prompt = textField(hook.prompt), nativeSessionId = textField(hook.session_id);
        if (!binding.session || binding.session.value !== nativeSessionId) throw new Error("Physical user input native session mismatch");
        try { const candidate = JSON.parse(prompt); if (candidate && typeof candidate === "object" && ("schema_version" in candidate || "sender" in candidate || "type" in candidate)) throw new Error("Role envelopes cannot become authenticated human input"); }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        const work = userQueue.catch(() => undefined).then(async () => {
          const current = await principal(role, textField(input.paneId));
          if (digest({ ...current, transportState: undefined }) !== digest({ ...binding, transportState: undefined }))
            throw new Error("Physical user input pane changed while queued");
          const messageId = `user-${digest([hook.session_id, hook.prompt, hook.transcript_path, randomUUID()])}`;
          const userId = `local-user-${process.getuid?.() ?? "local"}`;
          humanHookProvenance = { origin: "UserPromptSubmit", binding, nativeSessionId, userId, messageId,
            conversationSessionId: manifest!.conversationSessionId, promptDigest: digest(prompt) };
          try { return await requireWorkspace().conversation.handleUserTurn({ sessionId: manifest!.conversationSessionId,
            messageId, content: prompt,
            provenance: { origin: "user", authenticatedUser: true, userId, paneId: input.paneId, channel: "herdr_attach" } }); }
          finally { humanHookProvenance = undefined; }
        }); userQueue = work; return work;
      }
      throw new Error("Role cannot call host lifecycle methods");
    }
    switch (method) {
      case "ping": return { active: !!workspace, quiesced, schedulerError: schedulerError ?? null };
      case "prepare": {
        // H1: legacy per-role plans never survive a new generation; launch-keyed plans are published by the session.
        await removeLegacyRoleProbes(configuration.directory, roles);
        toolExpectations.clear();
        if (!platformSession) return { roleLaunch: launch };
        const prepared = await platformSession.prepare();
        for (const [role, expectation] of prepared.reachability) toolExpectations.set(role, expectation);
        const roleLaunch = Object.fromEntries(Object.entries(launch).map(([role, descriptor]) => {
          const ready = prepared.launches.get(role as AgentRole);
          return [role, ready ? { ...descriptor, launch: launchMaterial(ready) } : descriptor];
        }));
        return { roleLaunch, platform: prepared.report };
      }
      case "platform_status": {
        // Legacy hosts (no platform) keep the original response shape exactly.
        if (!platformSession) return { report: null, status: { generation: null, launches: [] }, gatewayDiagnostic: null };
        const status = platformSession.status();
        const toolReachability: RoleToolReachability[] = [];
        for (const [role, expectation] of toolExpectations) {
          const pane = (attemptedManifest ?? manifest)?.panes.find(candidate => candidate.role === role);
          const receipt = pane === undefined ? undefined : await readLaunchReceipt(role, pane.paneId);
          toolReachability.push(summarizeToolReachability(role, expectation, receipt === undefined ? undefined : reportedReachabilityOf(receipt)));
        }
        // Dynamic Developers: one entry per active launch with Gateway registrations, keyed by its launchId.
        toolReachability.push(...await platformSession.developerToolReachability());
        // Proof source per permanent launch (no tokens): the SessionStart hook, the MCP bootstrap, or none yet.
        const startupProof: StartupProof[] = [];
        for (const pane of (attemptedManifest ?? manifest)?.panes ?? []) {
          if (!pane.permanent || pane.role === "developer") continue;
          const receipt = await readLaunchReceipt(pane.role, pane.paneId);
          const launchId = typeof receipt?.launchId === "string" ? receipt.launchId : undefined;
          startupProof.push({ role: pane.role, paneId: pane.paneId, ...(launchId === undefined ? {} : { launchId }),
            startupSource: receipt === undefined ? "none" : typeof receipt.nativeSessionId === "string" ? "hook" : "mcp_bootstrap",
            reachabilitySource: receipt?.toolReachability === undefined ? "none" : receipt.reachabilitySource === "mcp_bootstrap" ? "mcp_bootstrap" : "hook" });
        }
        return { ...status, toolReachability, startupProof };
      }
      case "activate": return activate(params);
      case "get_run": { const stored = unwrap(await (await getQueryStore()).get(textField(record(params).runId))); return stored?.snapshot ?? null; }
      case "find_runs": { const page = unwrap(await (await getQueryStore()).find(RunQuerySchema.parse(params))); return { ...page, items: page.items.map(item => item.snapshot) }; }
      case "quiesce": {
        quiesced = true;
        if (!workspace) {
          let cursor: string | undefined;
          do {
            const page = unwrap(await (await getQueryStore()).find({limit:100, ...(cursor ? {cursor} : {})}));
            if (page.items.some(item => !["succeeded", "failed", "cancelled"].includes(item.snapshot.status))) throw new Error("Persisted Core run requires activation/recovery before safe shutdown");
            cursor = page.nextCursor;
          } while (cursor);
          const journalModule = await import("./journal.js");
          const journal = new journalModule.AgenticJournal(resolve(configuration.repositoryPath, ".bflow/state/agentic/journal"), configuration.repositoryPath);
          await journal.exclusive(async state => {
            if (state.pendingCore.length || state.pendingVerifications.length || state.runs.some(run => !["completed", "cancelled", "failed"].includes(run.status)))
              throw new Error("Persisted agentic work requires activation/reconciliation before safe shutdown");
          });
          await platformSession?.shutdown();
          quiesceCompleted = true; return null;
        }
        await workspace.runtime.quiesce();
        if (scheduler) await Promise.race([scheduler, new Promise((_, reject) => setTimeout(() => reject(new Error("Outstanding verification has not drained; preserve the live session and retry shutdown after reconciliation")), 15_000))]);
        await requireWorkspace().tools.drain(); await userQueue;
        if (physicalPrompts.length || pumping) throw new Error("Inbound transport receipts are still draining; preserve session and retry shutdown");
        await platformSession?.shutdown();
        quiesceCompleted = true; return null;
      }
      case "checkpoint": return requireWorkspace().runtime.checkpoint(params);
      case "shutdown": {
        if (workspace && !quiesceCompleted) throw new Error("Quiesce and checkpoint before stopping the host");
        const status = record(JSON.parse(await herdr(["status", "server", "--json"])));
        if (status.running === true) throw new Error("Stop the named Herdr session before stopping its host");
        await platformSession?.shutdown();
        closing = true; setImmediate(() => { void close(); }); return null;
      }
      default: throw new Error("Unknown host operation");
    }
  };
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => undefined); socket.setTimeout(600_000, () => socket.destroy());
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
  // F5: reconcile Gateway registrations periodically; lost ones degrade their launches until `bflow up` relaunches them.
  let verifyingGateway = false;
  const gatewayTimer = setInterval(() => {
    if (!workspace || !platformSession || quiesced || closing || verifyingGateway) return;
    verifyingGateway = true;
    void platformSession.verifyGateway().then(check => {
      if (check.lost.length) process.stderr.write(`Bflow Gateway: ${check.lost.length} registration(s) lost; affected roles are held until bflow up relaunches them\n`);
    }, error => { process.stderr.write(`Bflow Gateway check: ${redactString(String(error))}\n`); }).finally(() => { verifyingGateway = false; });
  }, 30_000);
  gatewayTimer.unref();
  const close = async () => {
    closing = true; clearInterval(timer); clearInterval(pump); clearInterval(gatewayTimer); if (workspace) { await workspace.runtime.quiesce(); await scheduler; await workspace.close(); }
    queryStore?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(accept => server.close(() => accept())); await unlink(configuration.socketPath);
  };
  // Abrupt process signals are crashes, never graceful-shutdown receipts.
  process.once("SIGTERM", () => { void close().then(() => process.exit(0), () => process.exit(1)); });
}

export function availableTools(role: AgentRole) {
  const tools = [{ name: "host_status", description: "Read the durable host scheduler status" },
    { name: "assignment_context", description: "Read assignments addressed to this authenticated pane and the accepted specification" },
    { name: "send_role_message", description: "Send a schema-valid RoleMessage through the signed native Herdr plugin; parameters: {message: RoleMessage}" }];
  if (role !== "conversation") tools.push({ name: USER_DECISION_TOOL, description: "Ask the user a decision through Runtime and Conversation, then end your turn; parameters: runId, taskId, question, options?, context?, expiresInMinutes?" });
  if (role === "coordinator") tools.push(...COORDINATOR_TOOLS, {name:"planning_reference",description:"Read canonical shipped examples and exact metadata/contract definitions; section: specification, test_strategy, workflow"});
  if (role === "developer") tools.push({ name: "authorize_implementation", description: "Verify accepted spec and Red evidence; parameters: runId, taskId" }, { name: "submit_implementation", description: "Submit committed implementation under your exact native assignment binding; parameters: runId, taskId" });
  if (role === "developer") tools.push(
    { name: "workspace_status", description: "Inspect your assigned task worktree, current Git HEAD and recorded TDD phases; runId,taskId" },
    { name: "commit_changes", description: "Commit only approved owned files on your task branch with expectedHead and message. No shell, push or merge; runId,taskId,expectedHead,message" },
    { name: "check_work", description: "Run owner-configured checks as Developer feedback. This never counts as independent acceptance evidence; runId,taskId" },
    { name: "request_verification", description: "Ask Runtime to dispatch an independent QA phase, then end your turn. Phase: red,green,refactor,verification; runId,taskId,phase" });
  if (["reviewer", "qa", "tester"].includes(role)) tools.push(
    { name: "inspect_review", description: "Independently capture exact assigned diff before review; parameters: messageId" },
    { name: "complete_review", description: "Return a verdict after inspect_review; parameters: reviewId, messageId, summary, criteria:[{criterionId,passed,summary}]" });
  if (["qa", "tester"].includes(role)) tools.push({ name: "inspect_alternative_verification", description: "Capture exact committed diff and accepted dossier before evaluating criteria; parameters: runId,taskId" }, { name: "record_alternative_verification", description: "Capture actual committed documentation diff and independent manual acceptance evidence; parameters: observationId,runId,taskId,criteria:[{criterionId,passed,summary}]" });
  if (["qa", "tester"].includes(role)) tools.push({ name: "record_behavioral_verification", description: "Execute an assigned phase using the owner's argv, exact committed tests and real output; runId,taskId,phase. Never supply test output yourself." });
  const string = { type:"string", minLength:1 }, array = {type:"array",items:string}, object = {type:"object"};
  const argumentsByName: Record<string, {properties: Record<string, unknown>; required: string[]}> = {
    planning_reference:{properties:{section:{type:"string",enum:["specification","test_strategy","workflow"]}},required:["section"]},
    [USER_DECISION_TOOL]:{properties:{runId:string,taskId:string,question:{type:"string",minLength:1,maxLength:2000},
      options:{type:"array",items:{type:"string",minLength:1,maxLength:200},minItems:2,maxItems:6},
      context:{type:"string",maxLength:4000},expiresInMinutes:{type:"integer",minimum:1,maximum:1440}},required:["runId","taskId","question"]},
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
    record_alternative_verification:{properties:{observationId:string,runId:string,taskId:string,criteria:{type:"array",items:{type:"object",properties:{criterionId:string,passed:{type:"boolean"},summary:string},required:["criterionId","passed","summary"],additionalProperties:false}}},required:["observationId","runId","taskId","criteria"]},
    workspace_status:{properties:{runId:string,taskId:string},required:["runId","taskId"]},
    commit_changes:{properties:{runId:string,taskId:string,expectedHead:string,message:string},required:["runId","taskId","expectedHead","message"]},
    check_work:{properties:{runId:string,taskId:string},required:["runId","taskId"]},
    request_verification:{properties:{runId:string,taskId:string,phase:{type:"string",enum:["red","green","refactor","verification"]}},required:["runId","taskId","phase"]},
    record_behavioral_verification:{properties:{runId:string,taskId:string,phase:{type:"string",enum:["red","green","refactor","verification"]}},required:["runId","taskId","phase"]}
  };
  return tools.map(tool => ({ ...tool, inputSchema: { type: "object", ...(argumentsByName[tool.name] ?? {properties:{},required:[]}), additionalProperties:false } }));
}
/**
 * Startup reachability bootstrap. The provider spawns this MCP child at startup, inside its launch environment, so the
 * child can probe the launch's Gateway registrations without a SessionStart hook (Codex does not fire one at startup).
 * Runs once per process, in the background: MCP serving is never blocked, and the probes are individually time-bounded.
 * Only the token-free probe records and the pane id are sent, authenticated with the role token.
 */
function bootstrapProviderReachability(configuration: RoleConfiguration, roleConfigPath: string | undefined): void {
  if (process.env[BFLOW_LAUNCH_ID_ENV] === undefined || roleConfigPath === undefined) return;
  void (async () => {
    const plan = await resolveProbePlan(dirname(roleConfigPath), configuration.role, process.env);
    if (plan === undefined) return;
    const toolReachability = await probeAllGateways(plan, process.env, (url, init) => fetch(url, init));
    const paneId = process.env.HERDR_PANE_ID;
    await callHost(configuration.socketPath, configuration.token, "provider_bootstrap", { launchId: plan.launchId,
      ...(paneId === undefined || paneId.length === 0 ? {} : { paneId }), toolReachability, source: "mcp_bootstrap" }, 30_000);
  })().catch(error => { process.stderr.write(`Bflow provider bootstrap not recorded: ${redactString(String(error))}\n`); });
}

export async function runRoleMcp(configuration: RoleConfiguration, roleConfigPath?: string): Promise<void> {
  bootstrapProviderReachability(configuration, roleConfigPath);
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
      const measured = ["record_behavioral_verification", "check_work", "complete_review", "record_alternative_verification"].includes(String(params.name));
      const result = await callHost(configuration.socketPath, configuration.token, "role_call", { ...params, paneId: textField(process.env.HERDR_PANE_ID) }, measured ? 600_000 : 30_000);
      reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (error) { reply({ isError: true, content: [{ type: "text", text: String(error) }] }); }
  }
}
export async function runProviderHook(configuration: RoleConfiguration, event: string, roleConfigPath?: string): Promise<void> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) { size += Buffer.byteLength(chunk); if (size > 1024 * 1024) throw new Error("Oversized provider hook"); chunks.push(Buffer.from(chunk)); }
  const hook = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const paneId = textField(process.env.HERDR_PANE_ID);
  if (event === "SessionStart" || event === "Stop") {
    const session = textField(hook.session_id);
    if (event !== hook.hook_event_name) throw new Error("Provider hook event mismatch");
    if (hook.agent_id || process.env.CURSOR_VERSION || hook.cursor_version) return;
    const request = { id: `bflow-native-${Date.now()}`, method: "pane.report_agent_session", params: { pane_id: paneId,
      source: `herdr:${configuration.provider}`, agent: configuration.provider, seq: Date.now() * 1000, agent_session_id: session,
      ...(typeof hook.transcript_path === "string" ? { agent_session_path: hook.transcript_path } : {}),
      ...(typeof hook.source === "string" ? { session_start_source: hook.source } : {}) } };
    await new Promise<void>((accept, reject) => {
      const socket = connect(textField(process.env.HERDR_SOCKET_PATH)); let response = "";
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("Native session report timed out")); }); socket.once("error", reject);
      socket.once("close", () => { if (!response.includes("\n")) reject(new Error("Native session report closed before acknowledgement")); });
      socket.once("connect", () => socket.write(JSON.stringify(request) + "\n"));
      socket.on("data", chunk => { response += String(chunk); if (!response.includes("\n")) return; socket.end();
        try { record(JSON.parse(response.split("\n")[0]!)).error ? reject(new Error("Herdr rejected native provider session")) : accept(); } catch (error) { reject(error); } });
    });
    // H1: the probe runs here, inside the provider process, so it sees the launch environment Herdr passed to the provider.
    // The plan is selected by this launch's BFLOW_LAUNCH_ID (fails closed on a malformed id); the legacy role file is a fallback only.
    const plan = event === "SessionStart" && roleConfigPath !== undefined
      ? await resolveProbePlan(dirname(roleConfigPath), configuration.role, process.env) : undefined;
    const reachability = plan === undefined ? undefined : await probeAllGateways(plan, process.env, (url, init) => fetch(url, init));
    if (event === "SessionStart") await callHost(configuration.socketPath, configuration.token, "provider_started", { paneId, nativeSessionId: session,
      ...(plan === undefined || reachability === undefined ? {} : { launchId: plan.launchId, toolReachability: reachability }) });
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
  if (event === "PreToolUse") {
    try { await callHost(configuration.socketPath, configuration.token, "tool_guard", { paneId, hook }); }
    catch (error) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
        permissionDecisionReason: redactString(String(error)) } }) + "\n");
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2], path = process.argv[3];
  const task = !path ? Promise.reject(new Error("Host configuration path required")) : mode === "daemon" ? readHostConfiguration(path).then(runAgenticHost)
    : readRoleConfiguration(path).then(configuration => mode === "mcp" ? runRoleMcp(configuration, path) :mode === "hook" ? runProviderHook(configuration, textField(process.argv[4]), path) : Promise.reject(new Error("Unknown host mode")));
  task.catch(error => { process.stderr.write(redactString(String(error)) + "\n"); process.exitCode = 1; });
}
