import { createInterface } from "node:readline";
import type { JsonValue } from "@bflow/contracts";
import { redactString } from "../resilience/redaction.js";
import { DIRECTOR_TOOLS } from "./tools.js";

export interface DirectorMcpOptions {
  call(name: string, token: string, args: Record<string, JsonValue>): Promise<unknown>;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

const MAX_LINE_BYTES = 4 * 1024 * 1024;
const INPUT_SCHEMA = {
  type: "object",
  properties: { token: { type: "string", description: "Director token from bflow director start" } },
  required: ["token"],
  additionalProperties: true
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Line-delimited JSON-RPC MCP server. Each tools/call runs independently so a long wait never blocks other calls. */
export async function runDirectorMcp(options: DirectorMcpOptions): Promise<void> {
  const known = new Set(DIRECTOR_TOOLS.map(tool => tool.name));
  const pending = new Set<Promise<void>>();
  const send = (message: unknown) => { options.output.write(JSON.stringify(message) + "\n"); };
  const handleCall = async (id: unknown, params: Record<string, unknown>) => {
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
    const fail = (text: string, token?: string) => {
      let safe = redactString(text);
      if (token) safe = safe.split(token).join("[REDACTED]");
      reply({ isError: true, content: [{ type: "text", text: safe }] });
    };
    const name = params.name;
    if (typeof name !== "string" || !known.has(name)) { fail("Unknown Director tool"); return; }
    const { token, ...rest } = isRecord(params.arguments) ? params.arguments : {} as Record<string, unknown>;
    if (typeof token !== "string" || token.length === 0) { fail("token is required"); return; }
    try {
      const result = await options.call(name, token, rest as Record<string, JsonValue>);
      reply({ content: [{ type: "text", text: JSON.stringify(result) ?? "null" }] });
    } catch (error) { fail(String(error), token); }
  };
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) { process.stderr.write("Oversized Director MCP request ignored\n"); continue; }
    let request: unknown;
    try { request = JSON.parse(line); } catch { continue; }
    if (!isRecord(request) || request.id === undefined) continue;
    const id = request.id;
    switch (request.method) {
      case "initialize":
        send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "bflow", version: "0.1.0" } } });
        break;
      case "ping": send({ jsonrpc: "2.0", id, result: {} }); break;
      case "tools/list":
        send({ jsonrpc: "2.0", id, result: { tools: DIRECTOR_TOOLS.map(tool => ({ name: tool.name, description: tool.description, inputSchema: INPUT_SCHEMA })) } });
        break;
      case "tools/call": {
        const task: Promise<void> = handleCall(id, isRecord(request.params) ? request.params : {})
          .catch(() => undefined).finally(() => { pending.delete(task); });
        pending.add(task);
        break;
      }
      default: send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    }
  }
  await Promise.all(pending);
}
