import { spawn } from "node:child_process";
import { z } from "zod";

const envelopeSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.number(), z.string()]).optional(),
  result: z.unknown().optional(), error: z.object({ code: z.number(), message: z.string() }).passthrough().optional() }).passthrough();
const initializedSchema = z.object({ protocolVersion: z.string().min(1), capabilities: z.object({}).passthrough(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).passthrough() }).passthrough();
const toolsSchema = z.object({ tools: z.array(z.object({ name: z.string().min(1), inputSchema: z.object({}).passthrough() }).passthrough()) }).passthrough();

/** Explicit setup probe only. Runtime connections remain owned by MCPServiceManager. */
export async function probeStdioMcp(input: {
  executable: string; argv: readonly string[]; cwd?: string; timeoutMs?: number;
  environment?: Record<string, string>; requiredTools: readonly string[];
  call?: { name: string; arguments: Record<string, unknown> };
}): Promise<{ protocolVersion: string; discoveredTools: string[]; callResult?: unknown }> {
  const child = spawn(input.executable, [...input.argv], { shell: false, cwd: input.cwd,
    env: { ...process.env, ...input.environment }, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  let buffer = "", bytes = 0, nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let failure: Error | null = null;
  const rejectAll = (error: Error) => { failure = error; for (const item of pending.values()) item.reject(error); pending.clear(); };
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.on("error", rejectAll);
  child.on("close", () => rejectAll(new Error("MCP server exited before completing the probe")));
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) rejectAll(new Error("MCP output limit exceeded")); });
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length; buffer += chunk.toString();
    if (bytes > 2_000_000 || buffer.length > 1_000_000) { rejectAll(new Error("MCP output limit exceeded")); return; }
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = envelopeSchema.parse(JSON.parse(line));
        if (typeof message.id !== "number") continue;
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id);
        if (message.error) item.reject(new Error(`MCP error ${message.error.code}`)); else item.resolve(message.result);
      } catch { rejectAll(new Error("MCP server emitted an invalid JSON-RPC message")); }
    }
  });
  const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++nextId; pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const timeout = setTimeout(() => rejectAll(new Error("MCP startup or tool probe timed out")), input.timeoutMs ?? 30_000);
  try {
    const initialization = initializedSchema.parse(await request("initialize", { protocolVersion: "2025-11-25",
      capabilities: {}, clientInfo: { name: "bflow-tool-installer", version: "0.1.0" } }));
    if (!["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(initialization.protocolVersion))
      throw new Error("MCP server negotiated an unsupported protocol");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = toolsSchema.parse(await request("tools/list", {}));
    const discoveredTools = tools.tools.map(tool => tool.name);
    if (!discoveredTools.length || input.requiredTools.some(tool => !discoveredTools.includes(tool))) throw new Error("Required MCP tools unavailable");
    const callResult = input.call ? await request("tools/call", input.call) : undefined;
    if (callResult && typeof callResult === "object" && "isError" in callResult && callResult.isError === true)
      throw new Error("MCP functional tool probe returned an error");
    return { protocolVersion: initialization.protocolVersion, discoveredTools, ...(callResult === undefined ? {} : { callResult }) };
  } finally {
    clearTimeout(timeout); child.stdin.end();
    const kill = (signal: NodeJS.Signals) => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* already exited */ }
    };
    kill("SIGTERM");
    const forced = setTimeout(() => kill("SIGKILL"), 2000);
    await closed; clearTimeout(forced);
  }
}
