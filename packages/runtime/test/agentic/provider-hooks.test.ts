import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, rm, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema } from "@bflow/contracts";
import { BFLOW_INBOX_NUDGE } from "../../dist/agentic/conversation-inbox.js";
import { randomUUID } from "node:crypto";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function fixture(role = "conversation", provider = "codex", replies: Record<string, unknown> = {}) {
  const root = await realpath(await mkdtemp("/tmp/bf-hook-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "host.sock"), calls: { method: string; params: unknown }[] = [];
  const herdrCalls: Record<string, unknown>[] = [];
  const herdrSocketPath = join(root, "herdr.sock");
  const herdrServer = provider === "agy" ? createServer(socket => {
    let input = "";
    socket.on("data", chunk => {
      input += String(chunk);
      if (!input.includes("\n")) return;
      herdrCalls.push(JSON.parse(input.split("\n")[0]!) as Record<string, unknown>);
      socket.end(JSON.stringify({ result: {} }) + "\n");
    });
  }) : undefined;
  if (herdrServer) {
    await new Promise<void>(accept => herdrServer.listen(herdrSocketPath, accept));
    cleanup.push(() => new Promise<void>(accept => herdrServer.close(() => accept())));
  }
  const nativeSessionId = provider === "agy" ? randomUUID() : "native-1";
  const agyHome = join(root, "agy-home");
  const transcriptPath = join(agyHome, ".gemini", "antigravity-cli", "brain", nativeSessionId, ".system_generated", "logs", "transcript_full.jsonl");
  if (provider === "agy") {
    const directories = [agyHome, join(agyHome, ".gemini"), join(agyHome, ".gemini", "antigravity-cli"), join(agyHome, ".gemini", "antigravity-cli", "brain"),
      join(agyHome, ".gemini", "antigravity-cli", "brain", nativeSessionId), join(agyHome, ".gemini", "antigravity-cli", "brain", nativeSessionId, ".system_generated"),
      join(agyHome, ".gemini", "antigravity-cli", "brain", nativeSessionId, ".system_generated", "logs")];
    for (const directory of directories) { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
    const prompt = JSON.stringify({ schema_version: 2, message_id: "agy-fixture", correlation_id: "agy-correlation", run_id: "run",
      sender: { role: role === "coordinator" ? "conversation" : "coordinator" }, recipient: { role }, type: role === "coordinator" ? "delegation.request" : "task.assignment",
      payload: {}, artifact_references: [], idempotency_key: "agy-fixture" });
    await writeFile(transcriptPath, JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE",
      created_at: new Date().toISOString(), content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfixture\n</ADDITIONAL_METADATA>` }) + "\n", { mode: 0o644 });
  }
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
  return { calls, herdrCalls, nativeSessionId, transcriptPath, agyHome,
    planTool: async (toolCall: Record<string, unknown>, stepIndex = 1) => writeFile(transcriptPath,
      JSON.stringify({ step_index: stepIndex, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [toolCall] }) + "\n", { flag: "a" }),
    agyInput: (extra: Record<string, unknown> = {}) => JSON.stringify({ ...extra, conversationId: nativeSessionId, workspacePaths: ["/workspace"], transcriptPath }),
    invoke: async (event: string, input: string, environment: Record<string, string> = {}) => {
    if (provider === "agy") {
      let extra: Record<string, unknown> = {};
      try { extra = JSON.parse(input) as Record<string, unknown>; } catch { /* malformed hook input remains malformed */ }
      if (Object.keys(extra).length > 0) input = JSON.stringify({ ...extra, conversationId: nativeSessionId, workspacePaths: ["/workspace"], transcriptPath });
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url)), "hook", path, event], {
      env: { ...process.env, HERDR_PANE_ID: "pane-1", HERDR_SOCKET_PATH: "", BFLOW_ENVIRONMENT_ID: "env-test",
        ...(provider === "agy" ? { HOME: agyHome, HERDR_SOCKET_PATH: herdrSocketPath } : {}),
        ...(provider === "agy" ? { BFLOW_LAUNCH_ID: "launch-agy-1" } : { BFLOW_LAUNCH_ID: undefined }), ...environment },
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

  it("registers an Agy native conversationId as the current Herdr session", async () => {
    const f = await fixture("developer", "agy");
    const result = await f.invoke("SessionStart", f.agyInput({ artifactDirectoryPath: "/tmp/private/artifacts", modelName: "test" }));
    expect(result.code).toBe(0);
    expect(f.calls.map(call => call.method)).toEqual(["provider_started", "native_session"]);
    expect(f.calls[0]?.params).toEqual({ paneId: "pane-1", nativeSessionId: f.nativeSessionId });
    expect(f.herdrCalls).toEqual([expect.objectContaining({ method: "pane.report_agent_session", params: expect.objectContaining({
      pane_id: "pane-1", source: "herdr:antigravity_cli", agent: "agy", agent_session_id: f.nativeSessionId, agent_session_path: f.transcriptPath
    }) })]);
  });

  it("forwards native Agy PreInvocation metadata for independent host transcript admission", async () => {
    const f = await fixture("developer", "agy");
    const result = await f.invoke("PreInvocation", f.agyInput({ invocationNum: 0, initialNumSteps: 3 }));
    expect(result.code).toBe(0);
    expect(f.calls).toEqual([expect.objectContaining({ method: "agy_native_turn", params: expect.objectContaining({
      paneId: "pane-1", nativeSessionId: f.nativeSessionId, launchId: "launch-agy-1", transcriptPath: f.transcriptPath,
      anchor: expect.objectContaining({ transcriptPath: f.transcriptPath, stepIndex: 0, rowDigest: expect.stringMatching(/^[a-f0-9]{64}$/), prefixDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    }) })]);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it("does not admit an Agy turn when the host refuses its native transcript", async () => {
    const f = await fixture("developer", "agy", { agy_native_turn: new Error("unpinned envelope") });
    const result = await f.invoke("PreInvocation", f.agyInput({ invocationNum: 0, initialNumSteps: 3 }));
    expect(JSON.parse(result.stdout)).toMatchObject({ injectSteps: expect.any(Array) });
    expect(result.stderr).toContain("unresolved");
  });

  it("translates Agy call_mcp_tool into a current-session tool guard and native allow result", async () => {
    const f = await fixture("developer", "agy");
    await f.planTool({ name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: "assignment_context", Arguments: {} } });
    const result = await f.invoke("PreToolUse", f.agyInput({ artifactDirectoryPath: "/tmp/private/artifacts", modelName: "test", stepIdx: 2,
      toolCall: { name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: "assignment_context", Arguments: {} } }
    }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ decision: "allow", reason: "Bflow tool guard permitted the call" });
    expect(f.calls).toEqual([expect.objectContaining({ method: "tool_guard", params: expect.objectContaining({
      paneId: "pane-1", hook: expect.objectContaining({ hook_event_name: "PreToolUse", session_id: f.nativeSessionId, tool_name: "mcp__bflow__assignment_context",
        native_anchor: expect.objectContaining({ transcriptPath: f.transcriptPath, stepIndex: 0 }), native_step_index: 2,
        native_tool_call: { name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: "assignment_context", Arguments: {} } } })
    }) })]);
  });

  it("denies unknown Agy tool names before they reach Runtime", async () => {
    const f = await fixture("developer", "agy");
    const result = await f.invoke("PreToolUse", f.agyInput({ artifactDirectoryPath: "/tmp/private/artifacts", modelName: "test", stepIdx: 1,
      toolCall: { name: "run_command", args: { CommandLine: "touch /tmp/forbidden" } } }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "deny" });
    expect(f.calls).toEqual([]);
  });

  it("routes an Agy Developer user-decision request through the existing authenticated Runtime guard", async () => {
    const f = await fixture("developer", "agy");
    await f.planTool({ name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: "request_user_decision", Arguments: { question: "Approve?" } } });
    const result = await f.invoke("PreToolUse", f.agyInput({ artifactDirectoryPath: "/tmp/private/artifacts", modelName: "test", stepIdx: 2,
      toolCall: { name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: "request_user_decision", Arguments: { question: "Approve?" } } } }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "allow" });
    expect(f.calls.map(call => call.method)).toEqual(["tool_guard"]);
  });

  it.each(["bflow", "gateway-probe"])("denies an old raw Agy tool event after a newer input for %s", async serverName => {
    const f = await fixture("developer", "agy");
    const toolCall = { name: "call_mcp_tool", args: { ServerName: serverName, ToolName: "assignment_context", Arguments: {} } };
    await f.planTool(toolCall);
    const environment = { BFLOW_MCP_TOKEN_TEST: "test-only-token" };
    if (serverName !== "bflow") {
      const config = join(f.agyHome, ".gemini", "config");
      await mkdir(config, { recursive: true, mode: 0o700 });
      await writeFile(join(config, "mcp_config.json"), JSON.stringify({ mcpServers: { [serverName]: { command: process.execPath,
        args: ["/test/agy-stdio-http-cli.js", "https://test.invalid/mcp", serverName, "BFLOW_MCP_TOKEN_TEST"] } } }), { mode: 0o600 });
    }
    const raw = f.agyInput({ stepIdx: 2, toolCall });
    expect(JSON.parse((await f.invoke("PreToolUse", raw, environment)).stdout)).toMatchObject({ decision: "allow" });
    const request = { schema_version: 2, message_id: "new-turn", correlation_id: "corr", sender: { role: "coordinator" }, recipient: { role: "developer" }, type: "task.assignment", payload: {}, artifact_references: [] };
    await writeFile(f.transcriptPath, JSON.stringify({ step_index: 10, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE",
      content: `<USER_REQUEST>\n${JSON.stringify(request)}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfixture\n</ADDITIONAL_METADATA>` }) + "\n", { flag: "a" });
    await f.planTool(toolCall, 11);
    expect(JSON.parse((await f.invoke("PreToolUse", raw, environment)).stdout)).toMatchObject({ decision: "deny" });
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse((await f.invoke("PreToolUse", f.agyInput({ stepIdx: 12, toolCall }), environment)).stdout)).toMatchObject({ decision: "allow" });
    expect(f.calls).toHaveLength(2);
  });

  it("preserves unresolved Agy work when Stop has no trustworthy native turn epoch", async () => {
    const f = await fixture("developer", "agy");
    const result = await f.invoke("Stop", f.agyInput({ executionNum: 1, terminationReason: "NO_TOOL_CALL", fullyIdle: true, modelName: "test" }));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ decision: "stop" });
    expect(result.stderr).toMatch(/native.*epoch.*unproven/i);
    expect(f.calls).toEqual([]);
  });

  it("never relabels an old raw Agy Stop as a newer explicit transcript turn", async () => {
    const f = await fixture("coordinator", "agy");
    const oldStop = f.agyInput({ executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true });
    await f.invoke("Stop", oldStop);
    const next = JSON.stringify({ schema_version: 2, message_id: "turn-b", correlation_id: "corr", run_id: "run",
      sender: { role: "conversation" }, recipient: { role: "coordinator" }, type: "delegation.request", payload: {}, artifact_references: [] });
    await writeFile(f.transcriptPath, JSON.stringify({ step_index: 10, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE",
      content: `<USER_REQUEST>\n${next}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfixture\n</ADDITIONAL_METADATA>` }) + "\n", { flag: "a" });
    const replay = await f.invoke("Stop", oldStop);
    expect(replay.code).toBe(0);
    expect(JSON.parse(replay.stdout)).toEqual({ decision: "stop" });
    expect(f.calls).toEqual([]);
  });
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
      const root = await realpath(await mkdtemp("/tmp/bf-hook-bad-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
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
    const root = await realpath(await mkdtemp("/tmp/bf-hook-runner-")); cleanup.push(() => rm(root, { recursive: true, force: true }));
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
  it("admits an Agy Conversation user turn via PreInvocation once per transcript anchor", async () => {
    const f = await fixture("conversation", "agy", {
      user_prompt: [{ messageId: "user-agy-1", requiresConversationDecision: true, notices: [notice] }, { alreadyAdmitted: true, messageId: "user-agy-1" }]
    });
    await writeFile(f.transcriptPath, JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE",
      created_at: new Date().toISOString(), content: "<USER_REQUEST>\nadd multiply\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfixture\n</ADDITIONAL_METADATA>" }) + "\n", { mode: 0o644 });
    const first = await f.invoke("PreInvocation", f.agyInput({ invocationNum: 0, initialNumSteps: 1 }));
    expect(first.code).toBe(0);
    const firstInjected = JSON.parse(first.stdout).injectSteps?.[0]?.systemMessage?.systemMessage as string;
    expect(firstInjected).toMatch(/^Trusted Bflow user turn: messageId=user-agy-1; requiresConversationDecision=true\./);
    expect(firstInjected).toContain("notice-1");
    expect(f.calls.map(call => call.method)).toEqual(["user_prompt", "conversation_notices_surfaced"]);
    const second = await f.invoke("PreInvocation", f.agyInput({ invocationNum: 1, initialNumSteps: 1 }));
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({});
    expect(f.calls.map(call => call.method)).toEqual(["user_prompt", "conversation_notices_surfaced", "user_prompt"]);
  });
  it("handles Agy Conversation inbox nudges via PreInvocation only on invocationNum 0", async () => {
    const f = await fixture("conversation", "agy", { conversation_runtime_nudge: { notices: [notice] } });
    await writeFile(f.transcriptPath, JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE",
      created_at: new Date().toISOString(), content: `<USER_REQUEST>\n${BFLOW_INBOX_NUDGE}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfixture\n</ADDITIONAL_METADATA>` }) + "\n", { mode: 0o644 });
    const first = await f.invoke("PreInvocation", f.agyInput({ invocationNum: 0, initialNumSteps: 1 }));
    expect(first.code).toBe(0);
    const injected = JSON.parse(first.stdout).injectSteps?.[0]?.systemMessage?.systemMessage as string;
    expect(injected).toContain("not a user message and not an approval");
    expect(injected).toContain("notice-1");
    expect(f.calls.map(call => call.method)).toEqual(["conversation_runtime_nudge", "conversation_notices_surfaced"]);
    const second = await f.invoke("PreInvocation", f.agyInput({ invocationNum: 1, initialNumSteps: 1 }));
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({});
    expect(f.calls.map(call => call.method)).toEqual(["conversation_runtime_nudge", "conversation_notices_surfaced"]);
  });
  it("continues Agy Conversation Stop for unsurfaced notices and stops when idle", async () => {
    const f = await fixture("conversation", "agy", {
      conversation_notices: [{ notices: [notice] }, { notices: [] }]
    });
    const first = await f.invoke("Stop", f.agyInput({ executionNum: 0, terminationReason: "NO_TOOL_CALL", fullyIdle: true }));
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ decision: "continue", reason: expect.stringContaining("Bflow Runtime updates") });
    expect(f.calls.map(call => call.method)).toEqual(["conversation_pending_decision", "conversation_notices", "conversation_notices_surfaced"]);
    const second = await f.invoke("Stop", f.agyInput({ executionNum: 1, terminationReason: "NO_TOOL_CALL", fullyIdle: true }));
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({ decision: "stop" });
  });
});
