import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMessageSchema } from "@bflow/contracts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });

async function fixture(role = "conversation", provider = "codex") {
  const root = await mkdtemp("/tmp/bf-hook-test-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, "host.sock"), calls: { method: string; params: unknown }[] = [];
  const server = createServer(socket => {
    let input = "";
    socket.on("data", chunk => {
      input += String(chunk);
      if (!input.includes("\n")) return;
      calls.push(JSON.parse(input.split("\n")[0]!));
      socket.end('{"ok":true,"value":{"accepted":true}}\n');
    });
  });
  await new Promise<void>(accept => server.listen(socketPath, accept));
  cleanup.push(() => new Promise<void>(accept => server.close(() => accept())));
  const path = join(root, "role.json");
  await writeFile(path, JSON.stringify({ socketPath, token: "role-token", role, provider, sessionId: "session", herdrBinary: "unused" }), { mode: 0o600 });
  return { calls, invoke: async (event: string, input: string) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url)), "hook", path, event], {
      env: { ...process.env, HERDR_PANE_ID: "pane-1", HERDR_SOCKET_PATH: "", BFLOW_ENVIRONMENT_ID: "env-test", BFLOW_LAUNCH_ID: "" },
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
  it.each(["conversation", "coordinator"])("ignores only the reserved Codex startup turn for %s", async role => {
    const f = await fixture(role);
    const prompt = "[bflow startup env-test] Reply only pong. Do not use tools or start a workflow.";
    expect((await f.invoke("UserPromptSubmit", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "native-1", prompt }))).code).toBe(0);
    expect(f.calls.map(call => call.method)).toEqual(role === "coordinator" ? ["provider_prompt_boundary"] : []);
  });
  it("selects the matching hook after unrelated plugin JSON", async () => {
    const f = await fixture();
    const result = await f.invoke("UserPromptSubmit", 'Plugin metadata: {"plugin":"example-plugin"}\n' + JSON.stringify({ ...prompt, prompt: "hello" }) + "\nfinished");
    expect(result.code).toBe(0);
    expect(f.calls).toEqual([expect.objectContaining({ method: "user_prompt", params: { paneId: "pane-1", hook: { ...prompt, prompt: "hello" } } })]);
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
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(f.calls).toEqual([]);
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
