import { z } from "zod";
import { JsonValueSchema } from "@bflow/contracts";
import type { OperationResult } from "@bflow/contracts";
import type {
  MCPUpstreamJsonObject,
  MCPUpstreamToolDefinition,
  MCPUpstreamToolList
} from "./types.js";
import { err, ok } from "./types.js";

/** Bounds applied to upstream `tools/list` results before they are cached or advertised. */
export const MCP_TOOL_DEFINITION_LIMITS = Object.freeze({
  maxTools: 256,
  maxDefinitionBytes: 64 * 1024,
  maxNameLength: 256
});

const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

const UpstreamToolDefinitionSchema = z.object({
  name: z.string().min(1).max(MCP_TOOL_DEFINITION_LIMITS.maxNameLength),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: JsonObjectSchema.refine(
    schema => schema["type"] === undefined || schema["type"] === "object",
    { message: "inputSchema.type must be \"object\" when present" }
  ).optional(),
  outputSchema: JsonObjectSchema.optional(),
  annotations: JsonObjectSchema.optional()
});

export const DEFAULT_TOOL_INPUT_SCHEMA: MCPUpstreamJsonObject = Object.freeze({ type: "object" });

/**
 * Builds the MCP-compliant definition used when the gateway only knows a tool name
 * (for example, drivers that predate definition capture). Never reads upstream data.
 */
export function fallbackToolDefinition(name: string): MCPUpstreamToolDefinition {
  return { name, inputSchema: DEFAULT_TOOL_INPUT_SCHEMA };
}

/**
 * Validates the raw `result` object of an upstream `tools/list` response.
 * Any malformed, duplicate or oversized definition rejects the whole list (service failure);
 * unknown fields are stripped so only MCP Tool fields are ever advertised.
 * A missing `inputSchema` is replaced with `{ "type": "object" }` and reported in
 * `defaultedInputSchemaTools` so callers can diagnose it.
 */
export function normalizeUpstreamToolList(raw: unknown): OperationResult<MCPUpstreamToolList> {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as { tools?: unknown }).tools)) {
    return err({
      code: "validation",
      retryable: false,
      message: "Upstream tools/list result must contain a tools array"
    });
  }
  const rawTools = (raw as { tools: unknown[] }).tools;
  if (rawTools.length > MCP_TOOL_DEFINITION_LIMITS.maxTools) {
    return err({
      code: "validation",
      retryable: false,
      message: `Upstream tools/list exceeds ${MCP_TOOL_DEFINITION_LIMITS.maxTools} tools`
    });
  }

  const definitions: MCPUpstreamToolDefinition[] = [];
  const defaultedInputSchemaTools: string[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < rawTools.length; index++) {
    const item: unknown = rawTools[index];
    let size: number;
    try {
      size = Buffer.byteLength(JSON.stringify(item) ?? "", "utf8");
    } catch {
      return err({
        code: "validation",
        retryable: false,
        message: `Upstream tool definition at index ${index} is not serializable JSON`
      });
    }
    if (size > MCP_TOOL_DEFINITION_LIMITS.maxDefinitionBytes) {
      return err({
        code: "validation",
        retryable: false,
        message: `Upstream tool definition at index ${index} exceeds ${MCP_TOOL_DEFINITION_LIMITS.maxDefinitionBytes} bytes`
      });
    }

    const parsed = UpstreamToolDefinitionSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const location = issue?.path.length ? issue.path.join(".") : "(definition)";
      return err({
        code: "validation",
        retryable: false,
        message: `Upstream tool definition at index ${index} is malformed at ${location}`
      });
    }

    const data = parsed.data;
    if (seen.has(data.name)) {
      return err({
        code: "validation",
        retryable: false,
        message: `Upstream tools/list contains duplicate tool name at index ${index}`
      });
    }
    seen.add(data.name);

    if (data.inputSchema === undefined) {
      defaultedInputSchemaTools.push(data.name);
    }

    definitions.push({
      name: data.name,
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      inputSchema: data.inputSchema ?? DEFAULT_TOOL_INPUT_SCHEMA,
      ...(data.outputSchema !== undefined ? { outputSchema: data.outputSchema } : {}),
      ...(data.annotations !== undefined ? { annotations: data.annotations } : {})
    });
  }

  return ok({ definitions, defaultedInputSchemaTools });
}
