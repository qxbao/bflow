import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema, SessionManifestSchema } from "@bflow/contracts";
import { ensureAgenticHost } from "../../dist/agentic/host-controller.js";
import { callHost } from "../../src/agentic/host-protocol.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
describe.skipIf(process.platform !== "linux")("Conversation decisions through the real host RPC", () => {
  it("records raw Vietnamese input, delegates only on Chat's decision, and blocks model approvals/direct delegation", async () => {
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
      'else if(rest[0]==="agent" && rest[1]==="get") { const conversation=rest[2]==="pane-chat"; console.log(JSON.stringify({result:{agent:{name:conversation?"chat":"coordinator",pane_id:rest[2],workspace_id:"workspace",tab_id:"tab",agent_status:"working",agent_session:{source:"herdr:claude",kind:"id",value:conversation?"native-chat":"native-coordinator"}}}})); }',
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
      panes: ["conversation", "coordinator"].map(role => ({ schemaVersion: 2, bindingId: `binding-${role}`, sessionId, role,
        agentId: role === "conversation" ? "chat" : "coordinator", paneId: role === "conversation" ? "pane-chat" : "pane-coordinator",
        workspaceId: "workspace", tabId: "tab", provider: "claude", agentKind: "claude", cwd: root, permanent: true, readOnlyWorkspace: true,
        isolationMode: "dedicated_pane", transportState: "idle", boundAt: at,
        session: { source: "herdr:claude", kind: "id", value: role === "conversation" ? "native-chat" : "native-coordinator" } })) });
    const manifestDirectory = join(root, ".bflow/state/panes"); await mkdir(manifestDirectory, { recursive: true });
    await writeFile(join(manifestDirectory, `${sessionId}.manifest.json`), JSON.stringify(manifest));
    for (const [role, config] of [["conversation", chat], ["coordinator", coordinator]] as const) {
      const binding = manifest.panes.find(pane => pane.role === role)!;
      await callHost(config.socketPath, config.token, "provider_started", { paneId: binding.paneId, nativeSessionId: binding.session!.value });
      await callHost(config.socketPath, config.token, "native_session", { paneId: binding.paneId, sessionId: binding.session!.value });
    }
    expect(await controller.activate(manifest)).toEqual({ ok: true, value: undefined });
    await expect(callHost(chat.socketPath, chat.token, "tool_guard", { paneId: "pane-chat", hook: {
      hook_event_name: "PreToolUse", session_id: "native-chat", tool_name: "mcp__bflow__conversation_decide" } })).resolves.toEqual({ permitted: true });
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
    const decision = { intent: "workflow_request", requirementDraft: { title: "Khảo sát quyền MCP", objective: "Liệt kê quyền MCP theo từng role",
      kind: "spike", sddLevel: "lightweight", priority: "normal", scopeDefined: true, isLargeTask: false, affectedPaths: [],
      acceptanceCriteriaDescriptions: ["Bảng role/server/nơi cấu hình/cơ chế chặn, chỉ đọc"], isRequirementChange: false } };
    await expect(callHost(coordinator.socketPath, coordinator.token, "role_call", { paneId: "pane-coordinator", name: "conversation_decide",
      arguments: { messageId: received.messageId, decision } })).rejects.toThrow("Only Conversation");
    const accepted = await invoke("conversation_decide", { messageId: received.messageId, decision });
    expect(accepted).toMatchObject({ ok: true, value: { recognizedIntent: "workflow_request" } });
    expect(await invoke("conversation_decide", { messageId: received.messageId, decision })).toEqual(accepted);
    const outbound = await readOutbound();
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.message).toMatchObject({ sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request",
      payload: { objective: decision.requirementDraft.objective, metadata: { codeChangesAuthorized: false } } });
    const calls = (await readFile(join(root, "herdr-calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.some(args => args[0] === "agent" && args[1] === "prompt")).toBe(false);
  }, 20_000);
});
