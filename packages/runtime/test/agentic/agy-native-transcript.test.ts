import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAgyNativeTurn } from "../../src/agentic/agy-native-transcript.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bflow-agy-transcript-")));
  roots.push(root);
  const home = join(root, "home");
  const session = randomUUID();
  const logs = join(home, ".gemini", "antigravity-cli", "brain", session, ".system_generated", "logs");
  await mkdir(logs, { recursive: true, mode: 0o700 });
  for (const directory of [home, join(home, ".gemini"), join(home, ".gemini", "antigravity-cli"), join(home, ".gemini", "antigravity-cli", "brain"), join(home, ".gemini", "antigravity-cli", "brain", session), join(home, ".gemini", "antigravity-cli", "brain", session, ".system_generated"), logs]) await chmod(directory, 0o700);
  const transcriptPath = join(logs, "transcript_full.jsonl");
  const row = (step_index: number, source: string, content: string) => JSON.stringify({ step_index, source, type: "USER_INPUT", status: "DONE", created_at: "2026-10-23T00:00:00Z", content });
  const wrapped = (payload: string) => `<USER_REQUEST>\n${payload}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal metadata\n</ADDITIONAL_METADATA>`;
  return { root, home, session, transcriptPath, row, wrapped };
}

describe("readAgyNativeTurn", () => {
  const expectedMcpTool = { name: "workspace_write", arguments: { runId: "run-a", taskId: "task-a", path: "src/a.ts", content: "exact\n", expectedSha256: null } };
  const mcpCall = { name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: expectedMcpTool.name, Arguments: expectedMcpTool.arguments } };
  const plannerRow = (step_index: number, toolCalls: unknown, source = "MODEL", status = "DONE") =>
    JSON.stringify({ step_index, source, type: "PLANNER_RESPONSE", status, tool_calls: toolCalls });

  it("returns the exact pending MCP call and prospective operation step from the current planner", async () => {
    const f = await fixture();
    await writeFile(f.transcriptPath, f.row(0, "USER_EXPLICIT", f.wrapped("assignment-a")) + "\n" + plannerRow(4, [mcpCall]) + "\n", { mode: 0o600 });
    const input = { home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath, expectedMcpTool };
    const captured = await readAgyNativeTurn(input);
    expect(captured).toMatchObject({ prompt: "assignment-a", pendingTool: { stepIndex: 5, toolCall: mcpCall } });
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 5, toolCall: mcpCall } })).resolves.toMatchObject(captured);
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 6, toolCall: mcpCall } })).rejects.toThrow(/tool|step/i);
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 5, toolCall: { ...mcpCall, args: { ...mcpCall.args, ToolName: "other" } } } })).rejects.toThrow(/tool/i);
  });

  it.each([
    { ...mcpCall, name: "other" },
    { ...mcpCall, args: { ...mcpCall.args, ServerName: "other" } },
    { ...mcpCall, args: { ...mcpCall.args, ToolName: "workspace_read" } },
    { ...mcpCall, args: { ...mcpCall.args, Arguments: { ...expectedMcpTool.arguments, content: "changed" } } },
    { ...mcpCall, args: { ...mcpCall.args, Arguments: { ...expectedMcpTool.arguments, extra: true } } },
    { ...mcpCall, args: { ...mcpCall.args, extra: true } }
  ])("refuses a changed MCP planner operation %#", async toolCall => {
    const f = await fixture();
    await writeFile(f.transcriptPath, f.row(0, "USER_EXPLICIT", f.wrapped("assignment-a")) + "\n" + plannerRow(1, [toolCall]) + "\n", { mode: 0o600 });
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath, expectedMcpTool })).rejects.toThrow(/tool|planner/i);
  });

  it.each([
    plannerRow(2, [{ ...mcpCall, args: { ...mcpCall.args, ToolName: "other" } }]),
    plannerRow(2, []),
    plannerRow(2, [mcpCall], "MODEL", "RUNNING"),
    plannerRow(2, [mcpCall], "SYSTEM_SDK")
  ])("refuses an old MCP call after a successor planner or injected row %#", async successor => {
    const f = await fixture();
    await writeFile(f.transcriptPath, f.row(0, "USER_EXPLICIT", f.wrapped("assignment-a")) + "\n" + plannerRow(1, [mcpCall]) + "\n" + successor + "\n", { mode: 0o600 });
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath, expectedMcpTool })).rejects.toThrow(/tool|planner/i);
  });

  it("refuses a planner call already followed by an operation result, including a guessed next native index", async () => {
    const f = await fixture();
    const completed = JSON.stringify({ step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "completed" });
    await writeFile(f.transcriptPath, f.row(0, "USER_EXPLICIT", f.wrapped("assignment-a")) + "\n" + plannerRow(1, [mcpCall]) + "\n" + completed + "\n", { mode: 0o600 });
    const input = { home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath };
    await expect(readAgyNativeTurn({ ...input, expectedMcpTool })).rejects.toThrow(/tool|planner/i);
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 3, toolCall: mcpCall } })).rejects.toThrow(/tool|planner/i);
  });

  it.each(["DONE", "ERROR"])("binds sequential MCP batch operations after a %s result to their exact unconsumed slot", async status => {
    const f = await fixture();
    const second = { name: "workspace_status", arguments: { runId: "run-a", taskId: "task-a" } };
    const secondCall = { name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: second.name, Arguments: second.arguments } };
    const initial = f.row(0, "USER_EXPLICIT", f.wrapped("assignment-a")) + "\n" + plannerRow(9, [mcpCall, secondCall]) + "\n";
    const result = (step_index: number) => JSON.stringify({ step_index, source: "MODEL", type: "GENERIC", status, content: "tool result" }) + "\n";
    const input = { home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath };
    await writeFile(f.transcriptPath, initial, { mode: 0o600 });
    await expect(readAgyNativeTurn({ ...input, expectedMcpTool })).resolves.toMatchObject({ pendingTool: { stepIndex: 10, toolCall: mcpCall } });
    await expect(readAgyNativeTurn({ ...input, expectedMcpTool: second })).rejects.toThrow(/tool|planner/i);
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 10, toolCall: secondCall } })).rejects.toThrow(/tool|planner/i);
    await writeFile(f.transcriptPath, initial + result(10), { mode: 0o600 });
    await expect(readAgyNativeTurn({ ...input, expectedMcpTool: second })).resolves.toMatchObject({ pendingTool: { stepIndex: 11, toolCall: secondCall } });
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 11, toolCall: secondCall } })).resolves.toMatchObject({ prompt: "assignment-a" });
    await expect(readAgyNativeTurn({ ...input, expectedMcpTool })).rejects.toThrow(/tool|planner/i);
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 11, toolCall: mcpCall } })).rejects.toThrow(/tool|planner/i);
    await writeFile(f.transcriptPath, initial + result(10) + result(11), { mode: 0o600 });
    await expect(readAgyNativeTurn({ ...input, expectedMcpTool: second })).rejects.toThrow(/tool|planner/i);
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 12, toolCall: secondCall } })).rejects.toThrow(/tool|planner/i);
  });

  it.each([
    { step_index: 2, source: "SYSTEM_SDK", type: "GENERIC", status: "DONE" },
    { step_index: 2, source: "MODEL", type: "USER_INPUT", status: "DONE" },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING" },
    { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE" }
  ])("refuses a batch slot after a non-native, incomplete or non-contiguous result %#", async intervening => {
    const f = await fixture();
    await writeFile(f.transcriptPath, f.row(0, "USER_EXPLICIT", f.wrapped("assignment-a")) + "\n" + plannerRow(1, [mcpCall, mcpCall]) + "\n" + JSON.stringify(intervening) + "\n", { mode: 0o600 });
    const input = { home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath };
    await expect(readAgyNativeTurn({ ...input, expectedMcpTool })).rejects.toThrow(/tool|planner/i);
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: intervening.step_index + 1, toolCall: mcpCall } })).rejects.toThrow(/tool|planner/i);
  });

  it("cannot borrow the prior turn's MCP operation after a successor explicit input", async () => {
    const f = await fixture();
    const original = f.row(0, "USER_EXPLICIT", f.wrapped("assignment-a")) + "\n" + plannerRow(1, [mcpCall]) + "\n";
    await writeFile(f.transcriptPath, original, { mode: 0o600 });
    const input = { home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath };
    const priorAnchor = (await readAgyNativeTurn(input)).anchor;
    await writeFile(f.transcriptPath, original + f.row(4, "USER_EXPLICIT", f.wrapped("assignment-b")) + "\n", { mode: 0o600 });
    await expect(readAgyNativeTurn({ ...input, priorAnchor, expectedMcpTool })).rejects.toThrow(/tool|planner/i);
    await writeFile(f.transcriptPath, original + f.row(4, "USER_EXPLICIT", f.wrapped("assignment-b")) + "\n" + plannerRow(5, [mcpCall]) + "\n", { mode: 0o600 });
    await expect(readAgyNativeTurn({ ...input, priorAnchor, expectedMcpTool })).resolves.toMatchObject({ prompt: "assignment-b", pendingTool: { stepIndex: 6, toolCall: mcpCall } });
  });

  it("binds a pending native tool to the actual latest planner call and next transcript step", async () => {
    const f = await fixture();
    const toolCall = { name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: "workspace_status", Arguments: { runId: "run-a", taskId: "task-a" } } };
    const user = f.row(0, "USER_EXPLICIT", f.wrapped("assignment-a"));
    const planner = JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [toolCall] });
    await writeFile(f.transcriptPath, `${user}\n${planner}\n`, { mode: 0o600 });
    const input = { home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath };
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 2, toolCall } })).resolves.toMatchObject({ prompt: "assignment-a" });
    for (const stepIndex of [0, 1, 3]) await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex, toolCall } })).rejects.toThrow(/tool|step/i);
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 2, toolCall: { ...toolCall, args: { ...toolCall.args, Arguments: { runId: "other", taskId: "task-a" } } } } })).rejects.toThrow(/tool/i);
    const next = f.row(10, "USER_EXPLICIT", f.wrapped("assignment-b"));
    const nextPlanner = JSON.stringify({ step_index: 11, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [toolCall] });
    await writeFile(f.transcriptPath, `${user}\n${planner}\n${next}\n${nextPlanner}\n`, { mode: 0o600 });
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 2, toolCall } })).rejects.toThrow(/tool|step/i);
    await expect(readAgyNativeTurn({ ...input, pendingTool: { stepIndex: 12, toolCall } })).resolves.toMatchObject({ prompt: "assignment-b" });
  });

  it("never treats an injected tool description as a native planner call", async () => {
    const f = await fixture();
    const toolCall = { name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: "commit_changes", Arguments: {} } };
    await writeFile(f.transcriptPath, f.row(0, "USER_EXPLICIT", f.wrapped("assignment")) + "\n" +
      JSON.stringify({ step_index: 1, source: "SYSTEM_SDK", type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [toolCall] }) + "\n", { mode: 0o600 });
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath,
      pendingTool: { stepIndex: 2, toolCall } })).rejects.toThrow(/tool|planner/i);
  });

  it("selects the latest explicit input and preserves literal JSON escapes in the exact request", async () => {
    const f = await fixture();
    const first = f.row(0, "USER_EXPLICIT", f.wrapped('{"message_id":"first"}'));
    const sdk = f.row(1, "SYSTEM_SDK", f.wrapped("injected"));
    const payload = '{"message_id":"next","payload":{"text":"line\\nquote\\\"slash\\\\"}}';
    const selected = f.row(2, "USER_EXPLICIT", f.wrapped(payload));
    await writeFile(f.transcriptPath, `${first}\n${sdk}\n${selected}\n`, { mode: 0o644 });

    const result = await readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath });

    expect(result.prompt).toBe(payload);
    expect(result.anchor).toMatchObject({ transcriptPath: f.transcriptPath, stepIndex: 2, rowDigest: createHash("sha256").update(selected).digest("hex") });
    expect(result.anchor.prefixDigest).toBe(createHash("sha256").update(`${first}\n${sdk}\n${selected}\n`).digest("hex"));
  });

  it("rejects a changed transcript prefix when advancing from a prior native anchor", async () => {
    const f = await fixture();
    const first = f.row(0, "USER_EXPLICIT", f.wrapped("first"));
    await writeFile(f.transcriptPath, `${first}\n`, { mode: 0o600 });
    const prior = (await readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath })).anchor;
    const rewritten = f.row(0, "USER_EXPLICIT", f.wrapped("rewritten"));
    const next = f.row(2, "USER_EXPLICIT", f.wrapped("next"));
    await writeFile(f.transcriptPath, `${rewritten}\n${next}\n`, { mode: 0o600 });
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath, priorAnchor: prior })).rejects.toThrow(/prefix changed/i);
  });

  it("rejects duplicate or nonmonotonic step indexes", async () => {
    const f = await fixture();
    await writeFile(f.transcriptPath, `${f.row(0, "USER_EXPLICIT", f.wrapped("one"))}\n${f.row(0, "USER_EXPLICIT", f.wrapped("two"))}\n`, { mode: 0o600 });
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath })).rejects.toThrow(/step_index/i);
  });

  it("rejects a partial final JSONL row", async () => {
    const f = await fixture();
    await writeFile(f.transcriptPath, `${f.row(0, "USER_EXPLICIT", f.wrapped("complete"))}\n{"step_index":1`, { mode: 0o600 });
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath })).rejects.toThrow(/partial|malformed/i);
  });

  it("rejects oversized, malformed, or non-private transcripts", async () => {
    const f = await fixture();
    await writeFile(f.transcriptPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20), { mode: 0o600 });
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath })).rejects.toThrow(/16 MiB/i);
    await writeFile(f.transcriptPath, "{bad json}\n", { mode: 0o600 });
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath })).rejects.toThrow(/malformed JSONL/i);
    await chmod(f.transcriptPath, 0o664);
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: f.transcriptPath })).rejects.toThrow(/permissions|writable/i);
  });

  it("rejects a symlinked canonical transcript ancestor", async () => {
    const f = await fixture();
    const transcript = f.transcriptPath;
    const sessionRoot = join(f.home, ".gemini", "antigravity-cli", "brain", f.session);
    const moved = join(f.home, ".gemini", "antigravity-cli", "brain", `${f.session}-real`);
    await writeFile(transcript, `${f.row(0, "USER_EXPLICIT", f.wrapped("input"))}\n`, { mode: 0o600 });
    await rm(sessionRoot, { recursive: true });
    await symlink(moved, sessionRoot);
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: transcript })).rejects.toThrow(/symlink/i);
  });

  it("rejects transcript path substitution and symlink ancestors", async () => {
    const f = await fixture();
    await writeFile(f.transcriptPath, `${f.row(0, "USER_EXPLICIT", f.wrapped("input"))}\n`, { mode: 0o600 });
    const wrong = join(f.root, "other.jsonl");
    await writeFile(wrong, "{}\n", { mode: 0o600 });
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: f.session, transcriptPath: wrong })).rejects.toThrow(/canonical|expected/i);
    const brain = join(f.home, ".gemini", "antigravity-cli", "brain");
    const real = join(brain, f.session);
    const link = join(brain, "link-session");
    await symlink(real, link);
    await expect(readAgyNativeTurn({ home: f.home, nativeSessionId: "link-session", transcriptPath: join(link, ".system_generated/logs/transcript_full.jsonl") })).rejects.toThrow(/UUID|symlink|canonical/i);
  });
});
