import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DelegationRequestSchema, RoleMessageSchema, SessionManifestSchema } from "@bflow/contracts";
import { ensureAgenticHost } from "../../dist/agentic/host-controller.js";
import { callHost } from "../../src/agentic/host-protocol.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function hostFixture(includeDeveloper = false, conversationProvider: "claude" | "codex" = "claude") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-chat-rpc-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "fixture baseline"], { cwd: root, stdio: "pipe" });
  const sessionId = "chat-rpc", binary = join(root, "herdr-fixture.mjs");
  const convSource = `herdr:${conversationProvider}`;
  await writeFile(binary, [
    '#!/usr/bin/env node',
    'import { appendFileSync } from "node:fs";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    'const root = dirname(fileURLToPath(import.meta.url)); const args = process.argv.slice(2); const rest = args[0] === "--session" ? args.slice(2) : args;',
    'appendFileSync(join(root,"herdr-calls.jsonl"), JSON.stringify(rest)+"\\n");',
    'if(rest[0]==="--version") console.log("herdr test-fixture");',
    'else if(rest[0]==="api") console.log("protocol: 22\\nschema_version: 1");',
    'else if(rest[0]==="plugin" && rest[1]==="config-dir") console.log(join(root,"plugin"));',
    `else if(rest[0]==="agent" && rest[1]==="get") { const conversation=rest[2]==="pane-chat", developer=rest[2]==="pane-developer"; console.log(JSON.stringify({result:{agent:{name:conversation?"chat":developer?"developer":"coordinator",pane_id:rest[2],workspace_id:"workspace",tab_id:"tab",agent_status:"working",agent_session:{source:conversation?${JSON.stringify(convSource)}:"herdr:claude",kind:"id",value:conversation?"native-chat":developer?"native-developer":"native-coordinator"}}}})); }`,
    'else if(rest[0]==="pane" && rest[1]==="read") console.log("coordinator waiting for architect reply token=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");',
    'else if(rest[0]==="pane") process.exitCode=1;',
    'else console.log(JSON.stringify({running:false,socket:join(root,"herdr.sock")}));'
  ].join("\n"), { mode: 0o700 });
  const controller = await ensureAgenticHost({ repositoryPath: root, sessionId, herdrBinary: binary });
  cleanups.push(async () => { await controller.quiesce(); await controller.shutdown(); });
  const launches = await controller.prepare(), hostDirectory = join(root, ".bflow/state/host", sessionId);
  expect(launches.roleLaunch.conversation!.systemPrompt).toContain("conversation_decide");
  const chat = JSON.parse(await readFile(join(hostDirectory, "conversation.json"), "utf8"));
  if (conversationProvider !== "claude") {
    chat.provider = conversationProvider;
    await writeFile(join(hostDirectory, "conversation.json"), JSON.stringify(chat), { mode: 0o600 });
  }
  const coordinator = JSON.parse(await readFile(join(hostDirectory, "coordinator.json"), "utf8"));
  const at = new Date().toISOString();
  const manifest = SessionManifestSchema.parse({ schemaVersion: 2, sessionId, workspaceRoot: root, projectName: "chat-rpc",
    herdrWorkspaceId: "workspace", herdrTabId: "tab", status: "up", conversationSessionId: "chat-session", activeRunIds: [],
    attachTarget: { role: "conversation", paneId: "pane-chat" }, createdAt: at, updatedAt: at,
    panes: ["conversation", "coordinator", ...(includeDeveloper ? ["developer"] : [])].map(role => {
      const provider = role === "conversation" ? conversationProvider : "claude";
      return { schemaVersion: 2, bindingId: `binding-${role}`, sessionId, role,
        agentId: role === "conversation" ? "chat" : role, paneId: role === "conversation" ? "pane-chat" : `pane-${role}`,
        workspaceId: "workspace", tabId: "tab", provider, agentKind: provider, cwd: root, permanent: true, readOnlyWorkspace: true,
        isolationMode: "dedicated_pane", transportState: "idle", boundAt: at,
        session: { source: `herdr:${provider}` as "herdr:claude" | "herdr:codex", kind: "id", value: role === "conversation" ? "native-chat" : `native-${role}` } };
    }) });
  const manifestDirectory = join(root, ".bflow/state/panes"); await mkdir(manifestDirectory, { recursive: true });
  await writeFile(join(manifestDirectory, `${sessionId}.manifest.json`), JSON.stringify(manifest));
  const developer = includeDeveloper ? JSON.parse(await readFile(join(hostDirectory, "developer.json"), "utf8")) : undefined;
  for (const [role, config] of [["conversation", chat], ["coordinator", coordinator], ...(developer ? [["developer", developer]] : [])] as const) {
    const binding = manifest.panes.find(pane => pane.role === role)!;
    await callHost(config.socketPath, config.token, "provider_started", { paneId: binding.paneId, nativeSessionId: binding.session!.value });
    await callHost(config.socketPath, config.token, "native_session", { paneId: binding.paneId, sessionId: binding.session!.value });
  }
  expect(await controller.activate(manifest)).toEqual({ ok: true, value: undefined });
  return { root, sessionId, hostDirectory, launches, chat, coordinator, developer, at };
}

describe.skipIf(process.platform === "win32")("Native role schemas and Conversation through the real host RPC", () => {
  it("serves a source-backed repository survey through the real authenticated assignment_context tool", async () => {
    const f = await hostFixture();
    const { AgenticJournal } = await import("../../src/agentic/journal.js");
    const { availableTools } = await import("../../dist/agentic/host.js");
    const { draft } = await import("../../../specification/test/fixtures.js");
    await mkdir(join(f.root, "packages/example/src"), { recursive: true });
    await writeFile(join(f.root, "packages/example/src/behavior.ts"), "export function existingBehavior() { return 'old result'; }\n");
    const delegation = DelegationRequestSchema.parse({ schemaVersion: 2, delegationId: "survey-delegation", messageId: "survey-assignment",
      correlationId: "survey-corr", runId: "survey-run", sessionId: "chat-session", requestedBy: "conversation", targetRole: "coordinator",
      title: "Inspect existing behavior", objective: "Find existingBehavior and related tests", specificationId: "survey-spec", sddLevel: "lightweight",
      acceptanceCriteria: draft().acceptanceCriteria, inputArtifacts: [], priority: "normal", requestedAt: f.at, idempotencyKey: "survey-assignment",
      metadata: { affectedPaths: ["packages/example/src"] } });
    const target = { transport: "herdr", agentId: "coordinator", paneId: "pane-coordinator", workspaceId: "workspace", tabId: "tab",
      session: { source: "herdr:claude", kind: "id" as const, value: "native-coordinator" } };
    const message = RoleMessageSchema.parse({ schema_version: 2, message_id: "survey-assignment", correlation_id: "survey-corr", run_id: "survey-run",
      sender: { role: "conversation" }, recipient: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" },
      type: "delegation.request", payload: delegation, artifact_references: [], occurred_at: f.at, idempotency_key: "survey-assignment" });
    const journal = new AgenticJournal(join(f.root, ".bflow/state/agentic/journal"), f.root);
    await expect.poll(async () => { try { await journal.exclusive(async (state, save) => {
      state.runs.push({ runId: "survey-run", delegation, status: "specifying", tasks: [], coreCreated: false, cancelled: false, maxIterations: 3 });
      state.outbound.push({ message, status: "accepted", selector: "binding-coordinator", taskId: "survey-task", attemptId: "survey-attempt", capabilities: ["repository.read"],
        request: { requestId: "survey-request", attemptId: "survey-attempt", runId: "survey-run", taskId: "survey-task", role: "coordinator", target,
          instruction: "Inspect existing behavior", inputs: [], attempt: 1, retry: { maxAttempts: 1, strategy: "fixed", initialDelayMs: 0, maxDelayMs: 0, jitter: false },
          timeout: { executionTimeoutMs: 60000, onTimeout: "block" }, idempotency: { key: "survey-assignment", scope: "agent-request", fingerprint: "survey" }, createdAt: f.at },
        lease: { leaseId: "survey-lease", agentId: "coordinator", runId: "survey-run", taskId: "survey-task", attemptId: "survey-attempt", fencingToken: 1, version: 0,
          acquiredAt: f.at, expiresAt: "2099-01-01T00:00:00.000Z" },
        handle: { executionId: "survey-execution", requestId: "survey-request", attemptId: "survey-attempt", runId: "survey-run", taskId: "survey-task",
          idempotencyKey: "survey-assignment", target, correlation: { token: "survey-request", provenance: "orchestrator", verified: false }, acceptedAt: f.at } });
      await save();
    }); return true; } catch (error) { if (String(error).includes("runtime busy")) return false; throw error; }
    }, { timeout: 10_000, interval: 25 }).toBe(true);
    await callHost(f.coordinator.socketPath, f.coordinator.token, "provider_tools_list", { paneId: "pane-coordinator",
      toolNames: availableTools("coordinator").map(tool => tool.name) });
    const result = await callHost(f.coordinator.socketPath, f.coordinator.token, "role_call", { paneId: "pane-coordinator", name: "assignment_context",
      arguments: { paths: ["/untrusted/role/supplied/path"] } }) as any;
    expect(result.repositorySurvey).toMatchObject({ status: "prepared", assignmentMessageId: "survey-assignment", runId: "survey-run", taskId: "survey-task" });
    expect(result.repositorySurvey.context.formattedPromptContext).toContain("packages/example/src/behavior.ts");
    expect(result.repositorySurvey.context.formattedPromptContext).toContain("old result");
    expect(result.repositorySurvey.context.baselineFiles).toBeUndefined();
    expect(JSON.stringify(result.repositorySurvey)).not.toContain("/untrusted/role/supplied/path");
    expect(f.launches.roleLaunch.coordinator!.systemPrompt).toContain("read repositorySurvey");
    await expect(callHost(f.chat.socketPath, f.chat.token, "role_call", { paneId: "pane-coordinator", name: "assignment_context", arguments: {} })).rejects.toThrow();
  }, 20_000);

  it("serves Developer policy through authenticated MCP while refusing another role's pane", async () => {
    const f = await hostFixture(true), developer = f.developer!;
    const read = (paneId: string) => callHost(developer.socketPath, developer.token, "role_call", {
      paneId, name: "read_pinned_instructions", arguments: {} });
    const result = await read("pane-developer") as { role: string; instructions: string; source: string };
    expect(result).toMatchObject({ role: "developer", source: "authenticated role launch policy" });
    expect(result.instructions).toContain("read_pinned_instructions");
    expect(result.instructions).toContain("Only skills selected by the verified current launch SkillManifest");
    await expect(callHost(developer.socketPath, developer.token, "role_call", {
      paneId: "pane-developer", name: "read_pinned_instructions", arguments: { skillId: "using-superpowers" }
    })).rejects.toThrow("not selected");
    await expect(read("pane-coordinator")).rejects.toThrow();
  });

  it("rejects malformed native envelopes before intent, accepts v2 assessment, and never repeats uncertain delivery", async () => {
    const { root, sessionId, hostDirectory, launches, coordinator } = await hostFixture();
    expect(launches.roleLaunch.architect!.systemPrompt).toContain('"artifact_references":[]');
    expect(launches.roleLaunch.architect!.systemPrompt).toContain('"idempotency_key":"stable-reply-key"');
    const coordinatorCall = (name: string, args: unknown) => callHost(coordinator.socketPath, coordinator.token, "role_call", { paneId: "pane-coordinator", name, arguments: args });
    await expect(coordinatorCall("inspect_native_delivery", { operationId: "missing" })).resolves.toMatchObject({ delivery: "not_found", resendAllowed: false });
    const activity = await readFile(join(root, ".bflow/state/agentic/task-activity.jsonl"), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error;
    });
    expect(activity).not.toContain("inspect_native_delivery:");
    const reply = { schema_version: 2, message_id: "native-validation", correlation_id: "corr-validation", run_id: "run-validation",
      sender: { role: "coordinator" }, recipient: { role: "runtime" }, type: "task.status", payload: {},
      artifact_references: [], idempotency_key: "native-validation" };
    const { artifact_references: _refs, ...withoutReferences } = reply;
    await expect(coordinatorCall("send_role_message", { message: withoutReferences })).rejects.toThrow("artifact_references");
    const { idempotency_key: _key, ...withoutKey } = reply;
    expect((await readdir(join(hostDirectory, "authentication-receipts"))).filter(name => name.startsWith("native-intent-"))).toEqual([]);
    const { draft } = await import("../../../specification/test/fixtures.js");
    const v2 = draft("documentation");
    await expect(coordinatorCall("assess", { specification: v2 })).resolves.toMatchObject({ complexity: "trivial", clarificationRequired: false });
    await expect(coordinatorCall("assess", { specification: { ...v2, metadata: {} } })).rejects.toThrow("metadata");
    const assessActivity = (await readFile(join(root, ".bflow/state/agentic/task-activity.jsonl"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    expect(assessActivity.find(entry => entry.action === "assess:failed")?.outcome).toContain("specification.metadata.sdd");
    await expect(coordinatorCall("assess", { specification: { schemaVersion: "1", id: "old-id", description: "old shape", sddLevel: "lightweight", acceptanceCriteria: v2.acceptanceCriteria.map(({ status: _status, evidenceArtifactIds: _ids, ...criterion }) => criterion) } })).rejects.toThrow();
    // A valid [] reaches native delivery. Losing its acknowledgement reserves the original operation;
    // a repeated call must not invoke the plugin again, even after reopening the receipt journal.
    let nativeCalls = 0;
    const native = createServer(socket => socket.once("data", () => { nativeCalls++; socket.destroy(); }));
    await new Promise<void>(accept => native.listen(join(root, "herdr.sock"), accept));
    cleanups.push(() => new Promise<void>((accept, reject) => native.close(error => error ? reject(error) : accept())));
    // The producer derives a stable key before writing a new intent; uncertain retries still preserve the exact envelope.
    await expect(coordinatorCall("send_role_message", { message: withoutKey })).rejects.toThrow("before acknowledgement");
    await expect(coordinatorCall("send_role_message", { message: reply })).rejects.toThrow("uncertain");
    await expect(coordinatorCall("inspect_native_delivery", { operationId: reply.message_id })).resolves.toMatchObject({ delivery: "unknown_delivery", inbox: "absent", resendAllowed: false });
    expect(nativeCalls).toBe(1);
    const { HostReceiptJournal } = await import("../../src/agentic/host-receipts.js");
    const receipts = new HostReceiptJournal(join(hostDirectory, "authentication-receipts"), root, sessionId);
    expect(await receipts.nativeDelivery(reply.message_id)).toMatchObject({ status: "unknown_delivery", message: { ...reply,
      sender: { role: "coordinator", agent_id: "coordinator", pane_id: "pane-coordinator" } } });
    await expect(coordinatorCall("send_role_message", { message: { ...reply, idempotency_key: "replacement-key" } })).rejects.toThrow("uncertain");
    expect(nativeCalls).toBe(1);
  }, 20_000);

  it("fences Runtime nudge tools from historical human turns and accepts the next real turn once", async () => {
    const { root, chat, hostDirectory } = await hostFixture();
    const invoke = (name: string, args: unknown) => callHost(chat.socketPath, chat.token, "role_call", { paneId: "pane-chat", name, arguments: args });
    const received = await callHost(chat.socketPath, chat.token, "user_prompt", { paneId: "pane-chat", hook: {
      hook_event_name: "UserPromptSubmit", session_id: "native-chat", prompt: "Yêu cầu gốc chưa được xử lý" } }) as { messageId: string };
    const decision = { intent: "conversation_only", directReply: "Existing turn recorded" };
    const nudge = execFileSync(process.execPath, [fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url)),
      "hook", join(hostDirectory, "conversation.json"), "UserPromptSubmit"], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit",
        session_id: "native-chat", prompt: "🔔 Bflow có tin mới" }),
      env: { ...process.env, HERDR_PANE_ID: "pane-chat", HERDR_SOCKET_PATH: "" }, encoding: "utf8" });
    await expect(invoke("conversation_decide", { decision })).rejects.toThrow(/Runtime nudge/);
    await expect(invoke("conversation_decide", { messageId: received.messageId, decision })).rejects.toThrow(/Runtime nudge/);
    await expect(invoke("resume_run", { runId: "run-existing" })).rejects.toThrow(/Runtime nudge/);
    await expect(callHost(chat.socketPath, chat.token, "tool_guard", { paneId: "pane-chat", hook: {
      hook_event_name: "PreToolUse", session_id: "native-chat", tool_name: "mcp__bflow__conversation_decide" } })).rejects.toThrow(/Runtime nudge/);
    await expect(callHost(chat.socketPath, chat.token, "tool_guard", { paneId: "pane-chat", hook: {
      hook_event_name: "PreToolUse", session_id: "native-chat", tool_name: "mcp__bflow__read_updates" } })).resolves.toEqual({ permitted: true });
    expect(await invoke("read_updates", {})).toEqual({ updates: [], remaining: 0 });
    expect(JSON.parse(nudge).hookSpecificOutput.additionalContext).toContain("requiresConversationDecision=false");
    const fresh = await callHost(chat.socketPath, chat.token, "user_prompt", { paneId: "pane-chat", hook: {
      hook_event_name: "UserPromptSubmit", session_id: "native-chat", prompt: "Báo trạng thái trước" } });
    expect(fresh).toMatchObject({ recoverableUserTurns: [{ messageId: received.messageId, content: "Yêu cầu gốc chưa được xử lý" }] });
    const completed = await invoke("conversation_decide", { decision });
    expect(await invoke("conversation_decide", { decision })).toEqual(completed);
    expect(await callHost(chat.socketPath, chat.token, "conversation_pending_decision", { paneId: "pane-chat", nativeSessionId: "native-chat" }))
      .toMatchObject({ messageId: received.messageId, requiresExplicitMessageId: true });
    const recovered = await invoke("conversation_decide", { messageId: received.messageId, decision });
    expect(await invoke("conversation_decide", { messageId: received.messageId, decision })).toEqual(recovered);
    await expect(invoke("resume_run", { runId: "run-existing", messageId: received.messageId })).rejects.toThrow("current authenticated");
    const { HostReceiptJournal } = await import("../../src/agentic/host-receipts.js");
    const receipts = new HostReceiptJournal(join(hostDirectory, "authentication-receipts"), root, "chat-rpc");
    expect(await receipts.conversationTurns()).toHaveLength(2);
    expect(await receipts.humanDecisions()).toEqual([]);
  }, 20_000);

  it("keeps an explicit user resume request out of new workflow creation", async () => {
    const { root, chat } = await hostFixture();
    await callHost(chat.socketPath, chat.token, "user_prompt", { paneId: "pane-chat", hook: {
      hook_event_name: "UserPromptSubmit", session_id: "native-chat", prompt: "resume run-existing" } });
    await expect(callHost(chat.socketPath, chat.token, "role_call", { paneId: "pane-chat", name: "conversation_decide", arguments: {
      decision: { intent: "workflow_request", requirementDraft: { title: "Resume", objective: "Continue existing work", kind: "spike",
        sddLevel: "lightweight", priority: "normal", scopeDefined: true, isLargeTask: false, affectedPaths: [],
        acceptanceCriteriaDescriptions: ["Preserve existing criteria"], isRequirementChange: false } }
    } })).rejects.toThrow(/resume_run/);
    const journalFile = join(root, ".bflow/state/agentic/journal/state.json");
    const state = JSON.parse(await readFile(journalFile, "utf8").catch(error => {
      if (error.code === "ENOENT") return '{"outbound":[]}';
      throw error;
    }));
    expect(state.outbound).toEqual([]);
  }, 20_000);

  it("enforces Conversation permissions and redacted read-only pane scope", async () => {
    const { root, chat, coordinator, at } = await hostFixture();
    await expect(callHost(chat.socketPath, chat.token, "tool_guard", { paneId: "pane-chat", hook: {
      hook_event_name: "PreToolUse", session_id: "native-chat", tool_name: "mcp__bflow__conversation_decide" } })).resolves.toEqual({ permitted: true });
    // Native shell: Codex exec_command and Claude Bash share the read-only allowlist; Conversation has no native shell.
    const guard = (config: { socketPath: string; token: string }, paneId: string, session: string, tool: string, toolInput: unknown) =>
      callHost(config.socketPath, config.token, "tool_guard", { paneId, hook: { hook_event_name: "PreToolUse", session_id: session, tool_name: tool, tool_input: toolInput } });
    await expect(guard(coordinator, "pane-coordinator", "native-coordinator", "exec_command", { cmd: "rg -n 'foo|bar' packages | head -20" })).resolves.toEqual({ permitted: true });
    await expect(guard(coordinator, "pane-coordinator", "native-coordinator", "Bash", { command: "git log --oneline -5" })).resolves.toEqual({ permitted: true });
    await expect(guard(coordinator, "pane-coordinator", "native-coordinator", "shell", { command: ["bash", "-lc", "cat README.md"] })).resolves.toEqual({ permitted: true });
    await expect(guard(coordinator, "pane-coordinator", "native-coordinator", "exec_command", { cmd: "cat README.md; rm -rf ." })).rejects.toThrow("';' (command chaining)");
    await expect(guard(coordinator, "pane-coordinator", "native-coordinator", "Bash", { command: "npm test" })).rejects.toThrow("program 'npm' is not allowlisted for the coordinator role");
    await expect(guard(coordinator, "pane-coordinator", "native-coordinator", "Edit", { file_path: "a" })).rejects.toThrow("Native mutation tool 'Edit' is unavailable for the coordinator role");
    await expect(guard(chat, "pane-chat", "native-chat", "exec_command", { cmd: "ls" })).rejects.toThrow("Conversation has no native shell");
    await expect(guard(chat, "pane-chat", "native-chat", "Bash", { command: "git status" })).rejects.toThrow("Conversation has no native shell");
    const prompt = "Yêu cầu workflow loại spike, sddLevel lightweight: khảo sát quyền MCP của từng role. Chỉ đọc.";
    const received = await callHost(chat.socketPath, chat.token, "user_prompt", { paneId: "pane-chat", hook: {
      hook_event_name: "UserPromptSubmit", session_id: "native-chat", prompt } }) as { messageId: string; requiresConversationDecision: boolean };
    expect(received.requiresConversationDecision).toBe(true);
    const readOutbound = async (): Promise<{ message: Record<string, unknown> }[]> => {
      try { return JSON.parse(await readFile(join(root, ".bflow/state/agentic/journal/state.json"), "utf8")).outbound; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    };
    expect(await readOutbound()).toEqual([]);
    const invoke = (name: string, args: unknown) => callHost(chat.socketPath, chat.token, "role_call", { paneId: "pane-chat", name, arguments: args });
    await expect(invoke("conversation_decide", { messageId: received.messageId, decision: { intent: "approval_response", approvalInput: { decision: "approved" } } })).rejects.toThrow();
    const direct = RoleMessageSchema.parse({ schema_version: 2, message_id: "model-delegation", correlation_id: "corr-model", run_id: "run-model",
      sender: { role: "conversation", agent_id: "chat", pane_id: "pane-chat" }, recipient: { role: "coordinator" }, type: "delegation.request",
      payload: {}, artifact_references: [], occurred_at: at, idempotency_key: "model-delegation" });
    await expect(invoke("send_role_message", { message: direct })).rejects.toThrow("conversation_decide");
    // Conversation may read other panes (read-only, redacted); nobody else may, and it cannot read itself.
    const pane = await invoke("read_role_pane", { role: "coordinator", lines: 20 }) as { content: string; paneId: string };
    expect(pane.paneId).toBe("pane-coordinator"); expect(pane.content).toContain("waiting for architect reply"); expect(pane.content).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");
    await expect(invoke("read_role_pane", { role: "conversation" })).rejects.toThrow("already owns");
    await expect(invoke("read_role_pane", { role: "coordinator", lines: 5000 })).rejects.toThrow("lines");
    await expect(invoke("read_role_pane", { role: "architect" })).rejects.toThrow("No architect pane");
    await expect(callHost(coordinator.socketPath, coordinator.token, "role_call", { paneId: "pane-coordinator", name: "read_role_pane", arguments: { role: "conversation" } })).rejects.toThrow("Only Conversation");
    const decision = { intent: "workflow_request", requirementDraft: { title: "Khảo sát quyền MCP", objective: "Liệt kê quyền MCP theo từng role",
      kind: "spike", sddLevel: "lightweight", priority: "normal", scopeDefined: true, isLargeTask: false, affectedPaths: [],
      acceptanceCriteriaDescriptions: ["Bảng role/server/nơi cấu hình/cơ chế chặn, chỉ đọc"], isRequirementChange: false } };
    await expect(callHost(coordinator.socketPath, coordinator.token, "role_call", { paneId: "pane-coordinator", name: "conversation_decide",
      arguments: { messageId: received.messageId, decision } })).rejects.toThrow("Only Conversation");
  }, 20_000);

  it("records raw Vietnamese input and delegates/resumes exactly once on the existing run", async () => {
    const { root, chat, coordinator, at } = await hostFixture();
    const prompt = "Yêu cầu workflow loại spike, sddLevel lightweight: khảo sát quyền MCP của từng role. Chỉ đọc.";
    const received = await callHost(chat.socketPath, chat.token, "user_prompt", { paneId: "pane-chat", hook: {
      hook_event_name: "UserPromptSubmit", session_id: "native-chat", prompt } }) as { messageId: string; requiresConversationDecision: boolean };
    expect(received.requiresConversationDecision).toBe(true);
    const readOutbound = async (): Promise<{ message: Record<string, unknown> }[]> => {
      try { return JSON.parse(await readFile(join(root, ".bflow/state/agentic/journal/state.json"), "utf8")).outbound; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    };
    expect(await readOutbound()).toEqual([]);
    const invoke = (name: string, args: unknown) => callHost(chat.socketPath, chat.token, "role_call", { paneId: "pane-chat", name, arguments: args });
    const decision = { intent: "workflow_request", requirementDraft: { title: "Khảo sát quyền MCP", objective: "Liệt kê quyền MCP theo từng role",
      kind: "spike", sddLevel: "lightweight", priority: "normal", scopeDefined: true, isLargeTask: false, affectedPaths: [],
      acceptanceCriteriaDescriptions: ["Bảng role/server/nơi cấu hình/cơ chế chặn, chỉ đọc"], isRequirementChange: false } };
    const accepted = await invoke("conversation_decide", { messageId: received.messageId, decision });
    expect(accepted).toMatchObject({ ok: true, value: { recognizedIntent: "workflow_request" } });
    expect(await invoke("conversation_decide", { messageId: received.messageId, decision })).toEqual(accepted);
    const outbound = await readOutbound();
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.message).toMatchObject({ sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request",
      payload: { objective: decision.requirementDraft.objective, metadata: { codeChangesAuthorized: false } } });
    await expect(invoke("resume_run", { runId: "run-unknown", messageId: received.messageId })).rejects.toThrow(/explicit|resume request/i);
    const { AgenticJournal, digest } = await import("../../src/agentic/journal.js");
    const { availableTools } = await import("../../src/agentic/host.js");
    const admitted = DelegationRequestSchema.parse(outbound[0]!.message.payload);
    const journal = new AgenticJournal(join(root, ".bflow/state/agentic/journal"), root);
    const sourceMessageId = "blocked-source", actionId = `next-${digest([admitted.runId, sourceMessageId])}`;
    await expect.poll(async () => {
      try { await journal.exclusive(async (state, save) => {
      const existingRun = state.runs.find(run => run.runId === admitted.runId);
      const blockedRun = { runId: admitted.runId!, delegation: admitted, status: "escalated", tasks: [], coreCreated: false,
        cancelled: false, maxIterations: 3, pendingAction: { actionId, kind: "resume_coordinator", owner: "coordinator",
          reason: "Read capability repaired", sourceMessageId, createdAt: at, state: "pending", previousStatus: "specifying", recovery: "manual" } } as const;
      if (existingRun) Object.assign(existingRun, blockedRun);
      else state.runs.push(blockedRun as any);
      await save();
      }); return true; } catch (error) { if (String(error).includes("runtime busy")) return false; throw error; }
    }, { timeout: 10_000, interval: 25 }).toBe(true);
    await callHost(coordinator.socketPath, coordinator.token, "provider_tools_list", { paneId: "pane-coordinator",
      toolNames: availableTools("coordinator").map(tool => tool.name) });
    await expect(invoke("resume_run", { runId: admitted.runId, messageId: received.messageId })).rejects.toThrow(/explicit|resume request/i);
    await expect(invoke("resume_run", { runId: admitted.runId, messageId: "fabricated" })).rejects.toThrow();
    const resumeTurn = await callHost(chat.socketPath, chat.token, "user_prompt", { paneId: "pane-chat", hook: {
      hook_event_name: "UserPromptSubmit", session_id: "native-chat", prompt: "tiếp tục" } }) as { messageId: string };
    const resumed = await invoke("resume_run", { runId: admitted.runId, messageId: resumeTurn.messageId });
    expect(resumed).toMatchObject({ queued: true, actionId });
    expect(await invoke("resume_run", { runId: admitted.runId, messageId: resumeTurn.messageId })).toEqual(resumed);
    expect((await readOutbound()).filter(item => (item.message.payload as any)?.kind === "resume_run")).toHaveLength(1);
    await expect(invoke("conversation_decide", { decision: { intent: "workflow_request", requirementDraft: decision.requirementDraft } }))
      .rejects.toThrow(/resume_run/);
    const completedResume = await invoke("conversation_decide", { decision: { intent: "conversation_only", directReply: "Run resumed" } });
    expect(await invoke("conversation_decide", { decision: { intent: "conversation_only", directReply: "Run resumed" } })).toEqual(completedResume);
    expect((await readOutbound()).filter(item => item.message.type === "delegation.request")).toHaveLength(1);
    const calls = (await readFile(join(root, "herdr-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.some(args => args[0] === "agent" && args[1] === "prompt")).toBe(false);
  }, 20_000);

  it("serves rendered updates via read_updates only to Conversation, marks surfaced after return, and respects budget", async () => {
    const { root, sessionId, hostDirectory, chat, coordinator, at } = await hostFixture();
    const { availableTools } = await import("../../src/agentic/host.js");
    const { HostReceiptJournal } = await import("../../src/agentic/host-receipts.js");
    for (const provider of ["claude", "codex", "agy"] as const) {
      const tool = availableTools("conversation", provider).find(item => item.name === "read_updates");
      expect(tool).toBeDefined();
      expect(tool!.description).toMatch(/display-only|never.*approve/i);
      expect(tool!.description).toContain('xem chi tiết #n');
      expect(tool!.inputSchema).toEqual({
        type: "object",
        properties: {
          ref: { type: "string", minLength: 1, maxLength: 64 },
          detail: { type: "boolean" }
        },
        required: [],
        additionalProperties: false
      });
    }
    expect(availableTools("coordinator").some(item => item.name === "read_updates")).toBe(false);
    expect(availableTools("developer").some(item => item.name === "read_updates")).toBe(false);

    await expect(callHost(coordinator.socketPath, coordinator.token, "tool_guard", {
      paneId: "pane-coordinator",
      hook: { hook_event_name: "PreToolUse", session_id: "native-coordinator", tool_name: "mcp__bflow__read_updates", tool_input: {} }
    })).rejects.toThrow(/Conversation/i);
    await expect(callHost(coordinator.socketPath, coordinator.token, "role_call", {
      paneId: "pane-coordinator", name: "read_updates", arguments: {}
    })).rejects.toThrow("Only Conversation reads inbox updates");
    await expect(callHost(coordinator.socketPath, coordinator.token, "role_call", {
      paneId: "pane-coordinator", name: "read_updates", arguments: { ref: "#1", detail: true }
    })).rejects.toThrow("Only Conversation reads inbox updates");
    await expect(callHost(chat.socketPath, chat.token, "role_call", {
      paneId: "pane-chat", name: "read_updates", arguments: { messageId: "not-allowed" }
    })).rejects.toThrow();

    const receipts = new HostReceiptJournal(join(hostDirectory, "authentication-receipts"), root, sessionId);
    const makeNotice = (id: string, type: string, payload: Record<string, unknown>) => RoleMessageSchema.parse({
      schema_version: 2, message_id: id, correlation_id: "corr-u", run_id: "run-u",
      sender: { role: "coordinator" }, recipient: { role: "conversation" }, type,
      payload, artifact_references: [], occurred_at: at, idempotency_key: id
    });
    await receipts.appendConversationNotice(makeNotice("upd-plain", "task.status", { status: "working", title: "Cấu hình cơ sở dữ liệu" }));
    await receipts.appendConversationNotice(makeNotice("upd-blocked", "conversation.progress", {
      kind: "coordinator_no_response", reason: "Coordinator dừng mà chưa giao bước tiếp — Authorization: Bearer secret-xyz"
    }));
    await receipts.appendConversationNotice(makeNotice("upd-decision", "approval.request", {
      approvalId: "apr-read-updates-1", runId: "run-u",
      evidence: [{ kind: "specification", uri: "artifact://store/spec-db" }],
      metadata: { kind: "user_decision", requestedByRole: "architect", question: "Chọn Postgres hay SQLite?", options: ["Postgres", "SQLite"] }
    }));

    // On-demand detail lookup via { ref, detail: true } returns redacted technical details without marking notices surfaced or displayed.
    const blockedDetail = (await callHost(chat.socketPath, chat.token, "role_call", {
      paneId: "pane-chat", name: "read_updates", arguments: { ref: "#1", detail: true }
    }) as { detail: Record<string, unknown> }).detail;
    expect(blockedDetail).toMatchObject({
      shortId: "#1",
      runLabel: "Việc #1: Cấu hình cơ sở dữ liệu",
      messageId: "upd-blocked",
      type: "conversation.progress",
      senderRole: "coordinator",
      runId: "run-u",
      correlationId: "corr-u",
      reason: "Coordinator dừng mà chưa giao bước tiếp — Authorization: Bearer [REDACTED]"
    });
    expect(String(blockedDetail.summary)).not.toContain("secret-xyz");
    // Only the MCP server's post-reply surfaced acknowledgement may omit the native session; every other notice method still binds it.
    await expect(callHost(chat.socketPath, chat.token, "conversation_notices_displayed", { paneId: "pane-chat", messageIds: [] }))
      .rejects.toThrow(/nonempty string|native session mismatch/);
    await expect(callHost(chat.socketPath, chat.token, "conversation_notices_surfaced", { paneId: "pane-chat", nativeSessionId: "other-session", messageIds: [] }))
      .rejects.toThrow("Conversation notice native session mismatch");
    await expect(callHost(chat.socketPath, chat.token, "conversation_notices_surfaced", { paneId: "pane-chat", messageIds: [] })).resolves.toBeDefined();

    const decisionDetail = (await callHost(chat.socketPath, chat.token, "role_call", {
      paneId: "pane-chat", name: "read_updates", arguments: { ref: "Việc #1", detail: true }
    }) as { detail: Record<string, unknown> }).detail;
    expect(decisionDetail).toMatchObject({
      shortId: "#2",
      runLabel: "Việc #1: Cấu hình cơ sở dữ liệu",
      messageId: "upd-decision",
      type: "approval.request",
      approvalId: "apr-read-updates-1",
      runId: "run-u",
      artifacts: ["artifact://store/spec-db"]
    });
    expect((await receipts.unsurfacedConversationNotices()).map(item => item.messageId)).toEqual(["upd-plain", "upd-blocked", "upd-decision"]);
    expect(await receipts.undisplayedUserFacingNotices()).toEqual([]);

    await expect(callHost(chat.socketPath, chat.token, "role_call", {
      paneId: "pane-chat", name: "read_updates", arguments: { ref: "#99", detail: true }
    })).rejects.toThrow(/Unknown|not found/i);
    await expect(callHost(chat.socketPath, chat.token, "role_call", {
      paneId: "pane-chat", name: "read_updates", arguments: { ref: "Việc #99", detail: true }
    })).rejects.toThrow(/Unknown|not found/i);
    await expect(callHost(chat.socketPath, chat.token, "role_call", {
      paneId: "pane-chat", name: "read_updates", arguments: { detail: true }
    })).rejects.toThrow(/ref/i);

    const first = await callHost(chat.socketPath, chat.token, "role_call", {
      paneId: "pane-chat", name: "read_updates", arguments: {}
    }) as { updates: { messageId: string; kind: string; text: string }[]; remaining: number };
    expect(first.remaining).toBe(0);
    expect(first.updates.map(item => item.messageId)).toEqual(["upd-decision", "upd-blocked", "upd-plain"]);
    expect(first.updates.map(item => item.kind)).toEqual(["user_decision", "blocked", "update"]);
    expect(first.updates[0]!.text).toContain("Chọn Postgres hay SQLite?");
    expect(first.updates[0]!.text).not.toContain('"metadata"');
    expect(await receipts.unsurfacedConversationNotices()).toEqual([]);

    // User-facing undisplayed notices remain visible until displayed; plain non-ack updates do not repeat after surfacing.
    const second = await callHost(chat.socketPath, chat.token, "role_call", {
      paneId: "pane-chat", name: "read_updates", arguments: {}
    }) as { updates: { messageId: string; kind: string; text: string }[]; remaining: number };
    expect(second.updates.map(item => item.messageId)).toEqual(["upd-decision", "upd-blocked"]);

    await receipts.markConversationNoticesDisplayed(["upd-decision", "upd-blocked"]);
    for (let index = 0; index < 12; index++) {
      await receipts.appendConversationNotice(makeNotice(`bulk-${index}`, "conversation.progress", {
        headline: `Bước tiến độ số ${index} ${"dữ liệu ".repeat(120)}`
      }));
    }
    const paged = await callHost(chat.socketPath, chat.token, "role_call", {
      paneId: "pane-chat", name: "read_updates", arguments: {}
    }) as { updates: { messageId: string; kind: string; text: string }[]; remaining: number };
    expect(paged.updates.length).toBeGreaterThan(0);
    expect(paged.updates.length).toBeLessThan(12);
    expect(paged.remaining).toBe(12 - paged.updates.length);
    expect((await receipts.unsurfacedConversationNotices()).length).toBe(paged.remaining);
  }, 20_000);

  it("delivers dynamic turnContext and updates through read_updates and recoverableUserTurns through conversation_decide on codex while keeping UserPromptSubmit fixed", async () => {
    const { root, sessionId, hostDirectory, chat, at } = await hostFixture(false, "codex");
    const { CODEX_CONVERSATION_NUDGE_MARKER, CODEX_CONVERSATION_USER_TURN_MARKER } = await import("../../src/agentic/host.js");
    const { HostReceiptJournal } = await import("../../src/agentic/host-receipts.js");
    const receipts = new HostReceiptJournal(join(hostDirectory, "authentication-receipts"), root, sessionId);
    const invoke = (name: string, args: unknown) => callHost(chat.socketPath, chat.token, "role_call", { paneId: "pane-chat", name, arguments: args });
    const runHook = (prompt: string) => JSON.parse(execFileSync(process.execPath, [
      fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url)),
      "hook", join(hostDirectory, "conversation.json"), "UserPromptSubmit"
    ], {
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-chat", prompt }),
      env: { ...process.env, HERDR_PANE_ID: "pane-chat", HERDR_SOCKET_PATH: "" },
      encoding: "utf8"
    })).hookSpecificOutput.additionalContext as string;

    const firstHookOut = runHook("Yêu cầu 1 chưa xử lý");
    expect(firstHookOut).toBe(CODEX_CONVERSATION_USER_TURN_MARKER);

    await receipts.appendConversationNotice(RoleMessageSchema.parse({
      schema_version: 2, message_id: "codex-decision-1", correlation_id: "corr-codex", run_id: "run-codex",
      sender: { role: "coordinator" }, recipient: { role: "conversation" }, type: "approval.request",
      payload: {
        approvalId: "apr-codex-1", runId: "run-codex",
        expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
        metadata: { kind: "user_decision", requestedByRole: "coordinator", question: "Chọn phương án cache nào?", options: ["Fixed marker", "Giữ hook động"] }
      },
      artifact_references: [], occurred_at: at, idempotency_key: "codex-decision-1"
    }));

    const nudgeHookOut = runHook("🔔 Bflow có tin mới");
    expect(nudgeHookOut).toBe(CODEX_CONVERSATION_NUDGE_MARKER);
    // Notice was NOT surfaced by the codex UserPromptSubmit hook; it awaits read_updates or Stop.
    expect((await receipts.unsurfacedConversationNotices()).map(n => n.messageId)).toEqual(["codex-decision-1"]);

    const nudgeUpdates = await invoke("read_updates", {}) as {
      updates: { messageId: string; kind: string; text: string }[];
      remaining: number;
      turnContext: Record<string, any>;
    };
    expect(nudgeUpdates.updates).toHaveLength(1);
    expect(nudgeUpdates.updates[0]!.messageId).toBe("codex-decision-1");
    expect(nudgeUpdates.updates[0]!.text).toContain("Chọn phương án cache nào?");
    expect(nudgeUpdates.updates[0]!.text).toMatch(/còn \d+ phút \(hết hạn lúc /u);
    expect(nudgeUpdates.turnContext).toMatchObject({
      requiresConversationDecision: false,
      runtimeNudge: true,
      recoverableUserTurns: [{ content: "Yêu cầu 1 chưa xử lý" }],
      context: { session: { sessionId: "chat-session" } }
    });
    expect(await receipts.unsurfacedConversationNotices()).toEqual([]);

    const secondHookOut = runHook("Kiểm tra trạng thái trước");
    expect(secondHookOut).toBe(CODEX_CONVERSATION_USER_TURN_MARKER);
    expect(secondHookOut).toBe(firstHookOut);

    const userTurnUpdates = await invoke("read_updates", {}) as {
      updates: { messageId: string; kind: string; text: string }[];
      remaining: number;
      turnContext: Record<string, any>;
    };
    expect(userTurnUpdates.turnContext).toMatchObject({
      messageId: expect.stringMatching(/^user-/),
      requiresConversationDecision: true,
      recoverableUserTurns: [{ content: "Yêu cầu 1 chưa xử lý" }],
      context: { session: { sessionId: "chat-session" } }
    });

    const decided = await invoke("conversation_decide", {
      decision: { intent: "conversation_only", directReply: "Đã kiểm tra trạng thái" }
    }) as Record<string, any>;
    expect(decided).toMatchObject({
      ok: true,
      recoverableUserTurns: [{ content: "Yêu cầu 1 chưa xử lý" }],
      turnContext: {
        requiresConversationDecision: false,
        recoverableUserTurns: [{ content: "Yêu cầu 1 chưa xử lý" }]
      }
    });
    const firstTurnId = decided.recoverableUserTurns[0]!.messageId as string;
    await invoke("conversation_decide", {
      messageId: firstTurnId,
      decision: { intent: "conversation_only", directReply: "Đã xử lý yêu cầu 1" }
    });

    const submitUserTurn = (prompt: string) => callHost(chat.socketPath, chat.token, "user_prompt", {
      paneId: "pane-chat",
      hook: { hook_event_name: "UserPromptSubmit", session_id: "native-chat", prompt }
    });

    // Approval failure on codex: read_updates and conversation_decide expose the failure details.
    await submitUserTurn("apr-missing-99: 1");
    const failedUpdates = await invoke("read_updates", {}) as { turnContext: Record<string, any> };
    expect(failedUpdates.turnContext).toMatchObject({
      requiresConversationDecision: false,
      approvalFailed: true,
      approvalFailure: {
        error: expect.stringContaining("apr-missing-99"),
        note: expect.stringContaining("The approval was NOT recorded")
      }
    });
    await expect(invoke("conversation_decide", {
      decision: { intent: "conversation_only", directReply: "Thử lại" }
    })).rejects.toThrow(/Trusted approval failed:.*The approval was NOT recorded.*apr-missing-99/);

    // Unrecorded approval warning (turnWarnings) + valid trusted_approval on codex + CONVERSATION_CONTEXT_BUDGET bounding.
    const { AgenticJournal } = await import("../../src/agentic/journal.js");
    const { CONVERSATION_CONTEXT_BUDGET } = await import("../../src/agentic/conversation-context-budget.js");
    const { buildUserDecisionRequest } = await import("../../src/agentic/decision-routing.js");
    const { draft } = await import("../../../specification/test/fixtures.js");
    const journal = new AgenticJournal(join(root, ".bflow/state/agentic/journal"), root);
    const runId = "run-codex-approval";
    const correlationId = "corr-codex-approval";
    const delegation = DelegationRequestSchema.parse({
      schemaVersion: 2,
      delegationId: "del-codex-approval",
      messageId: "msg-codex-approval",
      correlationId,
      runId,
      sessionId: "chat-session",
      requestedBy: "conversation",
      targetRole: "coordinator",
      title: "Kiểm thử cache prefix",
      objective: "Kiểm tra approval và budget trên codex",
      specificationId: "spec-codex-approval",
      sddLevel: "lightweight",
      acceptanceCriteria: draft().acceptanceCriteria,
      inputArtifacts: [],
      priority: "normal",
      requestedAt: at,
      idempotencyKey: "msg-codex-approval"
    });
    const reqA = buildUserDecisionRequest({
      input: { runId, taskId: "task-a", question: "Câu hỏi A?", options: ["Phương án A", "Phương án B"], expiresInMinutes: 20 },
      role: "coordinator",
      sessionId: "chat-session",
      revision: 1,
      generation: 1,
      now: at
    });
    const reqB = buildUserDecisionRequest({
      input: { runId, taskId: "task-b", question: "Câu hỏi B?", options: ["Phương án C", "Phương án D"], expiresInMinutes: 20 },
      role: "coordinator",
      sessionId: "chat-session",
      revision: 1,
      generation: 1,
      now: at
    });
    await expect.poll(async () => {
      try {
        await journal.exclusive(async (state, save) => {
          state.runs.push({
            runId,
            delegation,
            status: "implementing",
            tasks: [],
            coreCreated: false,
            cancelled: false,
            maxIterations: 3,
            userDecisions: {
              [reqA.approvalId]: { request: reqA, role: "coordinator", agentId: "coordinator", paneId: "pane-coordinator", taskId: "task-a", status: "pending" },
              [reqB.approvalId]: { request: reqB, role: "coordinator", agentId: "coordinator", paneId: "pane-coordinator", taskId: "task-b", status: "pending" }
            }
          });
          await save();
        });
        return true;
      } catch (error) {
        if (String(error).includes("runtime busy")) return false;
        throw error;
      }
    }, { timeout: 10_000, interval: 25 }).toBe(true);

    // Bare "1" with 2 pending approvals cannot be auto-recorded -> sets turnWarnings on both read_updates and conversation_decide.
    await submitUserTurn("1");
    const ambiguousDecided = await invoke("conversation_decide", {
      decision: { intent: "conversation_only", directReply: `Hiện có 2 câu hỏi đang chờ, bạn chọn mã cụ thể nhé. ${"Chi tiết ".repeat(650)}` }
    }) as Record<string, any>;
    expect(ambiguousDecided.approvalWarnings?.some((w: string) => w.includes(reqA.approvalId) && w.includes(reqB.approvalId))).toBe(true);

    // Exact approval reply "<approvalId>: 1" succeeds in the trusted hook -> read_updates exposes result and bounds turnContext within CONVERSATION_CONTEXT_BUDGET.
    await submitUserTurn(`${reqA.approvalId}: 1`);
    const approvedUpdates = await invoke("read_updates", {}) as { turnContext: Record<string, any> };
    expect(approvedUpdates.turnContext).toMatchObject({
      requiresConversationDecision: false,
      result: { ok: true, value: { recognizedIntent: "approval_response" } },
      context: { messagesOmitted: expect.any(Number) }
    });
    expect(approvedUpdates.turnContext.context.messagesOmitted).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(approvedUpdates.turnContext), "utf8")).toBeLessThanOrEqual(CONVERSATION_CONTEXT_BUDGET);
    await expect(invoke("conversation_decide", {
      decision: { intent: "conversation_only", directReply: "Không được phép ghi đè" }
    })).rejects.toThrow(/Conflicting Conversation decision.*requiresConversationDecision=false.*"recognizedIntent":"approval_response"/);
  }, 30_000);
});
