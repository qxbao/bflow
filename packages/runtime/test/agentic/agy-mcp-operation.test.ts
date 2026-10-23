import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const nativeToolCall = { name: "call_mcp_tool", args: { ServerName: "bflow", ToolName: "host_status", Arguments: {} } };
const operation = { nativeSessionId: "native-session", anchor: { transcriptPath: "/home/private/transcript_full.jsonl", device: "1", inode: "2",
  stepIndex: 3, rowDigest: "a".repeat(64), prefixDigest: "b".repeat(64) }, nativeStepIndex: 5, nativeToolCall };

async function invoke(options: { provider?: string; launchId?: string | null; refuseContext?: boolean } = {}) {
  const root = await mkdtemp("/tmp/bf-agy-mcp-");
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const calls: { method: string; params: any }[] = [], socketPath = join(root, "host.sock");
  const server = createServer(socket => {
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]!); calls.push(request);
      socket.end(JSON.stringify(options.refuseContext && request.method === "agy_mcp_operation"
        ? { ok: false, error: { message: "old native operation" } }
        : { ok: true, value: request.method === "agy_mcp_operation" ? operation : { active: true } }) + "\n");
    });
  });
  await new Promise<void>(accept => server.listen(socketPath, accept));
  cleanup.push(() => new Promise<void>(accept => server.close(() => accept())));
  const config = join(root, "role.json");
  await writeFile(config, JSON.stringify({ socketPath, token: "role-token", role: "coordinator", provider: options.provider ?? "agy",
    sessionId: "session", herdrBinary: "unused" }), { mode: 0o600 });
  const home = join(root, "private-home"); await mkdir(home, { mode: 0o700 });
  // No launch-probe plan: bootstrap is independent of this tools/call test.
  const env = { ...process.env, HOME: home, HERDR_PANE_ID: "pane-1", BFLOW_LAUNCH_ID: options.launchId === null ? undefined : options.launchId ?? "launch-1" };
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/agentic/host.js", import.meta.url)), "mcp", config], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
  const done = new Promise<void>((accept, reject) => { child.once("error", reject); child.once("exit", () => accept()); });
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "host_status", arguments: {} } }) + "\n");
  await done;
  return { calls, response: JSON.parse(stdout.trim()), stderr };
}

describe("native Agy MCP operation identity", () => {
  it("captures native operation proof before dispatch and forwards the original launch and proof unchanged", async () => {
    const f = await invoke();
    expect(f.response.result.isError).not.toBe(true);
    expect(f.calls.map(call => call.method)).toEqual(["agy_mcp_operation", "role_call"]);
    expect(f.calls[0]!.params).toEqual({ paneId: "pane-1", launchId: "launch-1", name: "host_status", arguments: {} });
    expect(f.calls[1]!.params).toEqual({ paneId: "pane-1", launchId: "launch-1", name: "host_status", arguments: {}, nativeAgyOperation: operation });
  });
  it("does not dispatch a tool if the host refuses its original native operation", async () => {
    const f = await invoke({ refuseContext: true });
    expect(f.response.result.isError).toBe(true);
    expect(f.calls.map(call => call.method)).toEqual(["agy_mcp_operation"]);
  });
  it("refuses an Agy MCP child without launch identity before dispatch", async () => {
    const f = await invoke({ launchId: null });
    expect(f.response.result.isError).toBe(true); expect(f.calls).toEqual([]);
  });
  it("retains the existing non-Agy MCP call path", async () => {
    const f = await invoke({ provider: "claude" });
    expect(f.response.result.isError).not.toBe(true);
    expect(f.calls).toEqual([expect.objectContaining({ method: "role_call", params: { name: "host_status", arguments: {}, paneId: "pane-1", launchId: "launch-1" } })]);
  });
});
