import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema } from "@bflow/contracts";
import { BFLOW_INBOX_NUDGE } from "../../dist/agentic/conversation-inbox.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function fixture(role = "conversation", provider = "codex", replies: Record<string, unknown> = {}) {
  const root = await mkdtemp("/tmp/bf-hook-test-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "host.sock"), calls: { method: string; params: unknown }[] = [];
  const server = createServer(socket => {
    let input = "";
    socket.on("data", chunk => {
      input += String(chunk);
      if (!input.includes("\n")) return;
      const call = JSON.parse(input.split("\n")[0]!);
      calls.push(call);
      const reply = Array.isArray(replies[call.method]) ? (replies[call.method] as unknown[]).shift() : replies[call.method];
      if (reply === "__no_reply__") return;
      if (reply instanceof Error) { socket.end(JSON.stringify({ ok: false, error: { message: reply.message } }) + "\n"); return; }
      socket.end(JSON.stringify({ ok: true, value: reply ?? { accepted: true } }) + "\n");
    });
  });
  await new Promise<void>(accept => server.listen(socketPath, accept));
  cleanup.push(() => new Promise<void>(accept => server.close(() => accept())));
  const path = join(root, "role.json");
  await writeFile(path, JSON.stringify({ socketPath, token: "role-token", role, provider, sessionId: "session", herdrBinary: "unused" }), { mode: 0o600 });
  return { calls, invoke: async (event: string, input: string) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url)), "hook", path, event], {
      env: { ...process.env, HERDR_PANE_ID: "pane-1", HERDR_SOCKET_PATH: "", BFLOW_ENVIRONMENT_ID: "env-test", BFLOW_LAUNCH_ID: undefined },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += String(chunk));
    child.stderr.on("data", chunk => stderr += String(chunk));
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
      child.once("error", reject);
      child.once("exit", code => accept({ code, stdout, stderr }));
    });
    child.stdin.end(input);
    return done;
  } };
}

describe.skipIf(process.platform === "win32")("provider hook ingress", () => {
  const prompt = { hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: "ping" };
  it.each(["codex", "claude"])("forwards ordinary ping from the user for %s", async provider => {
    const f = await fixture("conversation", provider);
    expect((await f.invoke("UserPromptSubmit", JSON.stringify(prompt))).code).toBe(0);
    expect(f.calls.map(call => call.method)).toEqual(["user_prompt"]);
  });
  it.each(["conversation", "coordinator"].flatMap(role => [
    [role, "[bflow startup env-test] Reply only pong. Do not use tools or start a workflow."],
    [role, "[bflow startup env-test] Initialize the local Bflow session; do not send this prompt to the model."]
  ]))("blocks the reserved Codex startup turn before inference after registering %s", async (role, prompt) => {
    const f = await fixture(role);
    const result = await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt }));
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "block" });
    expect(f.calls.map(call => call.method)).toEqual(["provider_started", "native_session", ...(role === "coordinator" ? ["provider_prompt_boundary"] : [])]);
    expect(f.calls[0]?.params).toEqual({ paneId: "pane-1", nativeSessionId: "native-1" });
  });
  it("selects the matching hook after unrelated plugin JSON", async () => {
    const f = await fixture();
    const result = await f.invoke("UserPromptSubmit", 'Plugin metadata: {"plugin":"example-plugin"}\n' + JSON.stringify({ ...prompt, prompt: "hello" }) + "\nfinished");
    expect(result.code).toBe(0);
    expect(f.calls).toEqual([expect.objectContaining({ method: "user_prompt", params: { paneId: "pane-1", hook: { ...prompt, prompt: "hello" } } })]);
  });
  it("blocks local bootstrap when the host rejects startup registration", async () => {
    const f = await fixture("conversation", "codex", { provider_started: new Error("registration refused") });
    const result = await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1",
      prompt: "[bflow startup env-test] Initialize the local Bflow session; do not send this prompt to the model." }));
    expect(result.code).toBe(2);
    expect(result.stderr.trim()).not.toBe("");
    expect(f.calls.map(call => call.method)).toEqual(["provider_started"]);
  });
  it("blocks a hung bootstrap before the provider's external hook timeout", async () => {
    const f = await fixture("conversation", "codex", { provider_started: "__no_reply__" });
    const result = await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1",
      prompt: "[bflow startup env-test] Initialize the local Bflow session; do not send this prompt to the model." }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("local startup registration timed out; prompt denied");
    expect(f.calls.map(call => call.method)).toEqual(["provider_started"]);
  }, 25_000);
  it("refuses ambiguous hook objects instead of choosing a human prompt", async () => {
    const f = await fixture();
    const result = await f.invoke("UserPromptSubmit", JSON.stringify({ ...prompt, prompt: "approve" }) + "\n" + JSON.stringify({ ...prompt, prompt: "reject" }));
    expect(result.code).not.toBe(0);
    expect(f.calls).toEqual([]);
  });
  it.each(["", "broken JSON", '{"unrelated":true}',
    '{"hook_event_name":"PreToolUse","session_id":"native-1"}',
    '{"hook_event_name":"Stop","session_id":"native-1","tool_name":"Write"}'
  ])("denies tools on malformed hook input: %s", async input => {
    const f = await fixture("developer");
    const result = await f.invoke("PreToolUse", input);
    // Exit 2 with a stderr reason blocks in both Claude and Codex; the stdout deny stays for JSON readers.
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(result.stderr).toContain("Bflow PreToolUse guard denied the tool call");
    expect(f.calls).toEqual([]);
  });
});

const hostEntry = fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url));
async function run(command: string, args: string[], input = "{}"): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HERDR_PANE_ID: "pane-1" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += String(chunk));
  child.stderr.on("data", chunk => stderr += String(chunk));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((accept, reject) => {
    child.once("error", reject); child.once("exit", code => accept({ code, stdout, stderr }));
  });
  child.stdin.end(input);
  return done;
}

describe.skipIf(process.platform === "win32")("fail-closed PreToolUse hook entry", () => {
  const tool = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "native-1", tool_name: "Bash", tool_input: { command: "rm -rf ." } });
  it.each([
    ["a missing role configuration", async () => "/tmp/bf-hook-missing-" + process.pid + "/role.json"],
    ["a corrupt role configuration", async () => {
      const root = await mkdtemp("/tmp/bf-hook-bad-"); cleanup.push(() => rm(root, { recursive: true, force: true }));
      const path = join(root, "role.json"); await writeFile(path, "{not json", { mode: 0o600 }); return path;
    }]
  ])("denies with exit 2 and a deny JSON on %s", async (_label, configPath) => {
    const result = await run(process.execPath, [hostEntry, "hook", await configPath(), "PreToolUse"], tool);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout.trim()).hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(result.stderr.trim()).not.toBe("");
  });
  it("keeps non-tool hooks on their ordinary failure status", async () => {
    const result = await run(process.execPath, [hostEntry, "hook", "/tmp/bf-hook-missing-" + process.pid + "/role.json", "Stop"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });
  it("maps a crashing hook process to a blocking exit 2 in the launch runner", async () => {
    const { hookRunnerScript } = await import("../../dist/agentic/host.js");
    const root = await mkdtemp("/tmp/bf-hook-runner-"); cleanup.push(() => rm(root, { recursive: true, force: true }));
    const crashing = join(root, "crash.mjs"), runner = join(root, "role.sh");
    await writeFile(crashing, "process.exit(1);\n");
    await writeFile(runner, hookRunnerScript(process.execPath, crashing, join(root, "role.json")), { mode: 0o700 });
    const blocked = await run(runner, ["PreToolUse"], tool);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain("Bflow PreToolUse guard exited with status 1; tool call denied");
    const blockedPrompt = await run(runner, ["UserPromptSubmit"]);
    expect(blockedPrompt.code).toBe(2);
    expect(blockedPrompt.stderr).toContain("prompt denied");
    const other = await run(runner, ["Stop"]);
    expect(other.code).toBe(1);
    await writeFile(crashing, "process.stdout.write('{\"ok\":1}'); process.exit(2);\n");
    expect((await run(runner, ["PreToolUse"], tool)).code).toBe(2);
    await writeFile(crashing, "process.exit(0);\n");
    expect((await run(runner, ["PreToolUse"], tool)).code).toBe(0);
  });
});

const delivery = RoleMessageSchema.parse({ schema_version: 2, message_id: "delegation", correlation_id: "correlation", run_id: "run",
  sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {}, artifact_references: [], idempotency_key: "delegation" });
describe("provider delegation turns", () => {
  it.each([JSON.stringify(delivery), '\n\n<pasted_content id="c03a">\n' + JSON.stringify(delivery) + '\n</pasted_content id="c03a">'])("forwards an exact whole role delivery including provider paste wrapping", async prompt => {
    const f = await fixture("coordinator", "claude");
    expect((await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt }))).code).toBe(0);
    expect(f.calls).toEqual([expect.objectContaining({ method: "transport_prompt", params: { paneId: "pane-1", nativeSessionId: "native-1", message: delivery } })]);
  });
  it.each([
    'prose <pasted_content id="a">' + JSON.stringify(delivery) + '</pasted_content id="a">',
    '<pasted_content id="a">' + JSON.stringify(delivery) + '</pasted_content id="b">',
    '<pasted_content id="a">' + JSON.stringify(delivery) + '</pasted_content id="a"><pasted_content id="b">' + JSON.stringify(delivery) + '</pasted_content id="b">'
  ])("rejects mixed, mismatched and multiple paste wrappers", async prompt => {
    const f = await fixture("conversation", "claude");
    expect((await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt }))).code).not.toBe(0);
    expect(f.calls).toEqual([]);
  });
  it("reports the authenticated Coordinator Stop without interpreting model prose", async () => {
    const f = await fixture("coordinator", "claude");
    expect((await f.invoke("Stop", JSON.stringify({ hook_event_name: "Stop", session_id: "native-1", last_assistant_message: "Tools denied" }))).code).toBe(0);
    expect(f.calls).toEqual([expect.objectContaining({ method: "provider_stopped", params: { paneId: "pane-1", nativeSessionId: "native-1" } })]);
  });
  it("ignores subagent stops", async () => {
    const f = await fixture("coordinator", "claude");
    await f.invoke("Stop", JSON.stringify({ hook_event_name: "Stop", session_id: "native-1", agent_id: "child" }));
    expect(f.calls).toEqual([]);
  });
});

describe("provider paste content boundaries", () => {
  it("preserves literal paste tags inside a complete JSON envelope", async () => {
    const f = await fixture("coordinator", "claude"), message = { ...delivery, payload: { objective: 'Explain <pasted_content id="x"> in docs' } };
    await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: JSON.stringify(message) }));
    expect(f.calls).toEqual([expect.objectContaining({ method: "transport_prompt", params: expect.objectContaining({ message }) })]);
  });
  it("keeps ordinary pasted human code as Conversation dialogue", async () => {
    const f = await fixture("conversation", "claude"), prompt = '<pasted_content id="code">\nconst example = 123;\n</pasted_content id="code">';
    expect((await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt }))).code).toBe(0);
    expect(f.calls).toEqual([expect.objectContaining({ method: "user_prompt", params: expect.objectContaining({ hook: expect.objectContaining({ prompt }) }) })]);
  });
});


it("marks ordinary Coordinator dialogue as a new non-delegation turn boundary", async () => {
  const f = await fixture("coordinator");
  expect((await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: "ordinary dialogue" }))).code).toBe(0);
  expect(f.calls).toEqual([expect.objectContaining({ method: "provider_prompt_boundary", params: { paneId: "pane-1", nativeSessionId: "native-1" } })]);
});

describe.skipIf(process.platform === "win32")("Conversation inbox hooks", () => {
  const notice = { messageId: "notice-1" };
  it("blocks Stop once for unsurfaced Runtime notices, then marks them surfaced", async () => {
    const f = await fixture("conversation", "claude", { conversation_notices: { notices: [notice] } });
    const result = await f.invoke("Stop", JSON.stringify({ hook_event_name: "Stop", session_id: "native-1", stop_hook_active: false }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "block", reason: expect.stringContaining("Bflow Runtime updates") });
    expect(f.calls.map(call => call.method)).toEqual(["conversation_pending_decision", "conversation_notices", "conversation_notices_surfaced"]);
    expect(f.calls[2]!.params).toMatchObject({ messageIds: ["notice-1"], nativeSessionId: "native-1" });
  });
  it("stays silent on Stop with no unsurfaced notices, even when stop_hook_active is set", async () => {
    const f = await fixture("conversation", "claude", { conversation_notices: { notices: [] } });
    const result = await f.invoke("Stop", JSON.stringify({ hook_event_name: "Stop", session_id: "native-1", stop_hook_active: true }));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(f.calls.map(call => call.method)).toEqual(["conversation_pending_decision", "conversation_notices"]);
  });
  it("never blocks a non-Claude Stop, leaving notices for the next user turn", async () => {
    const f = await fixture("conversation", "codex", { conversation_notices: { notices: [notice] } });
    const result = await f.invoke("Stop", JSON.stringify({ hook_event_name: "Stop", session_id: "native-1" }));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(f.calls.map(call => call.method)).not.toContain("conversation_notices_surfaced");
  });
  it("answers the inbox nudge without creating a user turn", async () => {
    const f = await fixture("conversation", "claude", { conversation_runtime_nudge: { notices: [notice] } });
    const result = await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: BFLOW_INBOX_NUDGE }));
    expect(result.code).toBe(0);
    expect(f.calls.map(call => call.method)).toEqual(["conversation_runtime_nudge", "conversation_notices_surfaced"]);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    expect(context).toContain("not a user message and not an approval");
    expect(context).toContain("notice-1");
    expect(f.calls[1]!.params).toMatchObject({ messageIds: ["notice-1"], nativeSessionId: "native-1" });
    expect(f.calls.map(call => call.method)).not.toContain("user_prompt");
    expect(f.calls.map(call => call.method)).not.toContain("conversation_decide");
  });
  it("keeps a large Conversation turn context within the provider hook output cap", async () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({ messageId: `m-${index}`, sender: "user", content: "x".repeat(900) }));
    const workflows = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`corr-${index}`, { correlationId: `corr-${index}`, runId: `run-${index}`,
      title: `Yêu cầu ${index}`, objective: "o".repeat(12000), sdlcStatus: "cancelled", updatedAt: `2026-10-20T00:0${index}:00.000Z` }]));
    const reply = { messageId: "user-1", requiresConversationDecision: true, notices: [notice], undisplayed: [],
      context: { session: { sessionId: "s-1", status: "active" }, agentBusy: false, pendingClarifications: {}, pendingApprovals: {}, approvalWarnings: [],
        workflows, runIdToCorrelationId: {}, messages } };
    const f = await fixture("conversation", "claude", { user_prompt: [reply] });
    const result = await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: "hello" }));
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
    expect(context.length).toBeLessThanOrEqual(7200);
    expect(context.startsWith("Trusted Bflow user turn: messageId=user-1; requiresConversationDecision=true. ")).toBe(true);
  });
  it("gives each consecutive Conversation turn its own messageId in the header", async () => {
    const turn = (messageId: string) => ({ messageId, requiresConversationDecision: true, notices: [], undisplayed: [], context: { messages: [] } });
    const f = await fixture("conversation", "claude", { user_prompt: [turn("user-1"), turn("user-2")] });
    const first = await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: "one" }));
    const second = await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: "two" }));
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toMatch(/^Trusted Bflow user turn: messageId=user-1;/);
    expect(JSON.parse(second.stdout).hookSpecificOutput.additionalContext).toMatch(/^Trusted Bflow user turn: messageId=user-2;/);
  });
  it("surfaces notices with a real user turn only after its context is emitted", async () => {
    const f = await fixture("conversation", "claude", { user_prompt: { messageId: "user-1", notices: [notice] } });
    const result = await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt: "hello" }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("notice-1");
    expect(f.calls.map(call => call.method)).toEqual(["user_prompt", "conversation_notices_surfaced"]);
  });
});
