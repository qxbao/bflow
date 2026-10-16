import { z } from "zod";
import { ClaudeMemProjectReader } from "./integrations.js";
import { fileDigest, readRegular, sha256 } from "./files.js";
import { fileURLToPath } from "node:url";
import { ProjectMemoryConfigSchema } from "./memory-config.js";
const requestSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]).optional(),
  method: z.string(), params: z.unknown().optional() }).strict();
const tools = [
  { name: "memory_recent", description: "Read this repository's recent observations", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } },
  { name: "memory_search", description: "Text search within this repository's latest 100 observations", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 500 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["query"], additionalProperties: false } },
  { name: "memory_get", description: "Read selected observations after validating their repository", inputSchema: { type: "object", properties: { ids: { type: "array", minItems: 1, maxItems: 50, items: { type: "integer", minimum: 1 } } }, required: ["ids"], additionalProperties: false } }
];

async function main() {
  const [configPath, digest] = process.argv.slice(2);
  if (!configPath || !digest) throw new Error("Missing memory adapter configuration");
  const config = ProjectMemoryConfigSchema.parse(JSON.parse(await readRegular(configPath)));
  if (sha256(JSON.stringify(config)) !== digest || await fileDigest(fileURLToPath(import.meta.url)) !== config.serverDigest)
    throw new Error("Memory adapter integrity mismatch");
  const reader = new ClaudeMemProjectReader(config.endpoint, config.project);
  await reader.recent(1); // A live filtered query is required before this adapter announces readiness.
  let initialized = false, buffer = "", queue = Promise.resolve();
  const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
  const dispatch = async (raw: unknown) => {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) { write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }); return; }
    const request = parsed.data;
    if (request.id === undefined) return;
    const reply = (result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
    if (request.method === "initialize") {
      const params = z.object({ protocolVersion: z.string() }).passthrough().parse(request.params);
      const version = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(params.protocolVersion) ? params.protocolVersion : "2025-11-25";
      initialized = true;
      reply({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "bflow-project-memory", version: "0.1.0" } }); return;
    }
    if (!initialized) { write({ jsonrpc: "2.0", id: request.id, error: { code: -32002, message: "Not initialized" } }); return; }
    if (request.method === "ping") { reply({}); return; }
    if (request.method === "tools/list") { reply({ tools }); return; }
    if (request.method !== "tools/call") {
      write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }); return;
    }
    try {
      const call = z.object({ name: z.string(), arguments: z.unknown().optional() }).strict().parse(request.params);
      let result: unknown;
      if (call.name === "memory_recent") {
        const args = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict().parse(call.arguments ?? {});
        result = await reader.recent(args.limit);
      } else if (call.name === "memory_search") {
        const args = z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(50).optional() }).strict().parse(call.arguments);
        result = await reader.search(args.query, args.limit);
      } else if (call.name === "memory_get") {
        const args = z.object({ ids: z.array(z.number().int().positive()).min(1).max(50) }).strict().parse(call.arguments);
        result = await reader.getObservations(args.ids);
      } else throw new Error("Unknown tool");
      reply({ content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch { reply({ isError: true, content: [{ type: "text", text: "Project memory request rejected or worker unavailable" }] }); }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1_000_000) { process.stderr.write("Memory adapter input limit exceeded\n"); process.exit(1); }
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      queue = queue.then(async () => {
        try { await dispatch(JSON.parse(line)); }
        catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON-RPC request" } }); }
      });
    }
  });
  process.stdin.on("end", () => { void queue.then(() => { process.exitCode = 0; }); });
}

main().catch(() => { process.stderr.write("Bflow project memory adapter startup failed\n"); process.exitCode = 1; });
