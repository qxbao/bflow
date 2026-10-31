import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { findExecutable, McpConfigFileSchema } from "@bflow/machine-setup";
import type { JsonValue, MCPServiceDefinition } from "@bflow/contracts";
import type { CommandSpec } from "../args.js";
import { HIGH_LEVEL_EXIT_CODES, HighLevelError, notFoundError } from "../envelope.js";
import { describeError, guarded, reportUnits, StepLog, type HighLevelHandler } from "../context.js";

export const MCP_STATUS_SPEC: CommandSpec = {
  name: "mcp.status",
  behavior: { summary: "Check the shared MCP Gateway and each configured backend", mutates: "none", retry: "read_only", permissionFlags: [], outcomes: ["ready", "not_ready", "failed"] },
  words: ["mcp", "status"],
  positionals: [],
  flags: { "--service": { type: "string", multiple: true } }
};

type BackendState = "healthy" | "degraded" | "unavailable" | "unknown" | "invalid";

async function localCheck(service: MCPServiceDefinition, pathEntries: readonly string[]): Promise<{ state: BackendState; detail: string }> {
  const connection = service.connection;
  if (connection.kind !== "stdio_mcp")
    return { state: "unknown", detail: `Remote endpoint ${connection.endpoint} is probed only through the Gateway` };
  const path = isAbsolute(connection.executable) ? connection.executable
    : await findExecutable(connection.executable, pathEntries, process.platform);
  if (path === null) return { state: "unavailable", detail: `Executable '${connection.executable}' not found` };
  try {
    const info = await stat(path);
    if (!info.isFile()) return { state: "unavailable", detail: `Executable '${path}' is not a regular file` };
    if (process.platform !== "win32") await access(path, constants.X_OK);
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    if (digest !== connection.executableDigest) return { state: "invalid", detail: `Executable digest of ${path} does not match the pinned digest` };
  } catch (error) {
    return { state: "unavailable", detail: `Cannot execute or read ${path}: ${describeError(error)}` };
  }
  return { state: "unknown", detail: `Pinned executable present at ${path}; liveness requires the Gateway bridge` };
}

/** Read-only status of the shared MCP Gateway and configured backends. Never starts or stops a worker. */
export const mcpStatus: HighLevelHandler = async (args, ctx) => {
  const log = new StepLog(undefined, ctx.onProgress);
  return guarded("mcp.status", log, {}, async () => {
    const platform = await log.check("detect-platform", () => ctx.services.machine.platform(), value => ({ machineId: value.machineId }));
    const file = join(platform.paths.config, "mcp.json");
    const config = await log.check("read-mcp-config", async () => {
      let text: string;
      try { text = await readFile(file, "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" as const, services: [] as MCPServiceDefinition[] };
        throw error;
      }
      let raw: unknown;
      try { raw = JSON.parse(text); } catch { return { state: "invalid" as const, reason: "not JSON", services: [] as MCPServiceDefinition[] }; }
      const parsed = McpConfigFileSchema.safeParse(raw);
      if (!parsed.success) return { state: "invalid" as const, reason: parsed.error.issues.map(i => i.message).join("; "), services: [] as MCPServiceDefinition[] };
      return { state: "valid" as const, services: Object.values(parsed.data.services), managedIds: parsed.data.managedIds };
    }, value => ({ path: file, state: value.state, services: value.services.length }));

    const selected = args.lists.get("--service");
    const missing = (selected ?? []).filter(id => !config.services.some(s => s.serviceId === id));
    if (missing.length > 0)
      throw new HighLevelError(notFoundError(`Unknown MCP service(s): ${missing.join(", ")}`, { reason: "service_not_found",
        known: config.services.map(s => s.serviceId) }));

    const gateway = await log.check("probe-gateway", async () => {
      if (ctx.services.mcpGateway === undefined)
        return { configured: false, reachable: false, reason: "Shared MCP Gateway is not configured on this host", backends: [] };
      try {
        const status = await ctx.services.mcpGateway.status(ctx.signal !== undefined ? { signal: ctx.signal } : undefined);
        return { configured: true, ...status };
      } catch (error) {
        return { configured: true, reachable: false, reason: describeError(error), backends: [] };
      }
    }, value => ({ configured: value.configured, reachable: value.reachable }));

    const services = config.services.filter(s => selected === undefined || selected.includes(s.serviceId));
    const backends = [];
    reportUnits(ctx, 0, services.length, "MCP backends inspected");
    for (const service of services) {
      const local = await localCheck(service, platform.pathEntries);
      const reported = gateway.backends.find(b => b.serviceId === service.serviceId);
      const state: BackendState = local.state === "invalid" || local.state === "unavailable" ? local.state : reported?.state ?? local.state;
      backends.push({
        serviceId: service.serviceId, kind: service.connection.kind, revision: service.revision, state,
        healthy: state === "healthy", local: local.detail, ...(reported?.detail !== undefined ? { gateway: reported.detail } : {})
      });
      reportUnits(ctx, backends.length, services.length, "MCP backends inspected");
    }
    const ready = gateway.reachable && config.state !== "invalid" && backends.every(b => b.healthy);
    const data: JsonValue = JSON.parse(JSON.stringify({
      gateway: { configured: gateway.configured, reachable: gateway.reachable, ...("reason" in gateway ? { reason: gateway.reason } : {}),
        ...("version" in gateway && gateway.version !== undefined ? { version: gateway.version } : {}) },
      config: { path: file, state: config.state, ...("reason" in config ? { reason: config.reason } : {}) },
      backends
    })) as JsonValue;
    return {
      command: "mcp.status", outcome: ready ? "ready" : "not_ready", status: "succeeded",
      exitCode: ready ? HIGH_LEVEL_EXIT_CODES.SUCCESS : HIGH_LEVEL_EXIT_CODES.NOT_READY, steps: log.steps, data
    };
  });
};
