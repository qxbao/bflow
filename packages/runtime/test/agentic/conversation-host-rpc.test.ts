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
async function hostFixture(includeDeveloper = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-chat-rpc-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "fixture baseline"], { cwd: root, stdio: "pipe" });
  const sessionId = "chat-rpc", binary = join(root, "herdr-fixture.mjs");
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
    'else if(rest[0]==="agent" && rest[1]==="get") { const conversation=rest[2]==="pane-chat", developer=rest[2]==="pane-developer"; console.log(JSON.stringify({result:{agent:{name:conversation?"chat":developer?"developer":"coordinator",pane_id:rest[2],workspace_id:"workspace",tab_id:"tab",agent_status:"working",agent_session:{source:"herdr:claude",kind:"id",value:conversation?"native-chat":developer?"native-developer":"native-coordinator"}}}})); }',
    'else if(rest[0]==="pane" && rest[1]==="read") console.log("coordinator waiting for architect reply token=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789");',
    'else if(rest[0]==="pane") process.exitCode=1;',
    'else console.log(JSON.stringify({running:false,socket:join(root,"herdr.sock")}));'
  ].join("\n"), { mode: 0o700 });
  const controller = await ensureAgenticHost({ repositoryPath: root, sessionId, herdrBinary: binary });
  cleanups.push(async () => { await controller.quiesce(); await controller.shutdown(); });
  const launches = await controller.prepare(), hostDirectory = join(root, ".bflow/state/host", sessionId);
  expect(launches.roleLaunch.conversation!.systemPrompt).toContain("conversation_decide");
  const chat = JSON.parse(await readFile(join(hostDirectory, "conversation.json"), "utf8"));
  const coordinator = JSON.parse(await readFile(join(hostDirectory, "coordinator.json"), "utf8"));
  const at = new Date().toISOString();
  const manifest = SessionManifestSchema.parse({ schemaVersion: 2, sessionId, workspaceRoot: root, projectName: "chat-rpc",
    herdrWorkspaceId: "workspace", herdrTabId: "tab", status: "up", conversationSessionId: "chat-session", activeRunIds: [],
    attachTarget: { role: "conversation", paneId: "pane-chat" }, createdAt: at, updatedAt: at,
    panes: ["conversation", "coordinator", ...(includeDeveloper ? ["developer"] : [])].map(role => ({ schemaVersion: 2, bindingId: `binding-${role}`, sessionId, role,
      agentId: role === "conversation" ? "chat" : role, paneId: role === "conversation" ? "pane-chat" : `pane-${role}`,
      workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude", cwd: root, permanent: true, readOnlyWorkspace: true,
      isolationMode: "dedicated_pane", transportState: "idle", boundAt: at,
      session: { source: "herdr:claude", kind: "id", value: role === "conversation" ? "native-chat" : `native-${role}` } })) });
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
        session_id: "native-chat", prompt: "[bflow] Có cập nhật mới từ Runtime" }),
      env: { ...process.env, HERDR_PANE_ID: "pane-chat", HERDR_SOCKET_PATH: "" }, encoding: "utf8" });
    await expect(invoke("conversation_decide", { decision })).rejects.toThrow(/Runtime nudge/);
    await expect(invoke("conversation_decide", { messageId: received.messageId, decision })).rejects.toThrow(/Runtime nudge/);
    await expect(invoke("resume_run", { runId: "run-existing" })).rejects.toThrow(/Runtime nudge/);
    await expect(callHost(chat.socketPath, chat.token, "tool_guard", { paneId: "pane-chat", hook: {
      hook_event_name: "PreToolUse", session_id: "native-chat", tool_name: "mcp__bflow__conversation_decide" } })).rejects.toThrow(/Runtime nudge/);
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
});
