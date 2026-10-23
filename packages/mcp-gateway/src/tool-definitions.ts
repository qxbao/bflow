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

const SUPPORTED_SCHEMA_KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties",
  "description", "title", "default", "examples", "deprecated"]);
const SUPPORTED_JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** Reject definitions whose constraints this Gateway cannot faithfully enforce. */
export function isSupportedJsonSchema(schema: unknown): schema is MCPUpstreamJsonObject {
  const visit = (rule: unknown, depth: number): boolean => {
    if (depth > 32 || rule === null || typeof rule !== "object" || Array.isArray(rule)) return false;
    const s = rule as Record<string, unknown>;
    if (Object.keys(s).some(key => !SUPPORTED_SCHEMA_KEYWORDS.has(key))) return false;
    if (s.type !== undefined && !(typeof s.type === "string" ? SUPPORTED_JSON_TYPES.has(s.type) :
      Array.isArray(s.type) && s.type.length > 0 && new Set(s.type).size === s.type.length &&
      s.type.every(type => typeof type === "string" && SUPPORTED_JSON_TYPES.has(type)))) return false;
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some(name => typeof name !== "string") ||
        new Set(s.required).size !== s.required.length)) return false;
    if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0)) return false;
    for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]) {
      const value = s[key];
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || (key.startsWith("min") && value < 0))) return false;
    }
    if (s.minimum !== undefined && s.maximum !== undefined && (s.minimum as number) > (s.maximum as number)) return false;
    if (s.minLength !== undefined && s.maxLength !== undefined && (s.minLength as number) > (s.maxLength as number)) return false;
    if (s.minItems !== undefined && s.maxItems !== undefined && (s.minItems as number) > (s.maxItems as number)) return false;
    if (s.minProperties !== undefined && s.maxProperties !== undefined && (s.minProperties as number) > (s.maxProperties as number)) return false;
    if (s.properties !== undefined && (s.properties === null || typeof s.properties !== "object" || Array.isArray(s.properties) ||
        Object.values(s.properties).some(child => !visit(child, depth + 1)))) return false;
    if (s.items !== undefined && !visit(s.items, depth + 1)) return false;
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean" && !visit(s.additionalProperties, depth + 1)) return false;
    return true;
  };
  return visit(schema, 0);
}

/** Fail-closed validation for the common JSON Schema subset used by MCP tool definitions. */
export function validateJsonSchema(value: unknown, schema: MCPUpstreamJsonObject): boolean {
  const visit = (candidate: unknown, rule: unknown, depth: number): boolean => {
    if (depth > 32 || !rule || typeof rule !== "object" || Array.isArray(rule)) return false;
    const s = rule as Record<string, unknown>;
    if (!isSupportedJsonSchema(rule)) return false;
    if ("const" in s && JSON.stringify(candidate) !== JSON.stringify(s.const)) return false;
    if (Array.isArray(s.enum) && !s.enum.some((item) => JSON.stringify(item) === JSON.stringify(candidate))) return false;
    const validType = (type: unknown): boolean => {
      switch (type) {
        case "object": return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
        case "array": return Array.isArray(candidate);
        case "string": return typeof candidate === "string";
        case "number": return typeof candidate === "number" && Number.isFinite(candidate);
        case "integer": return typeof candidate === "number" && Number.isInteger(candidate);
        case "boolean": return typeof candidate === "boolean";
        case "null": return candidate === null;
        default: return false;
      }
    };
    if (s.type !== undefined && !(Array.isArray(s.type) ? s.type.some(validType) : validType(s.type))) return false;
    if (typeof candidate === "string") {
      if (typeof s.minLength === "number" && candidate.length < s.minLength) return false;
      if (typeof s.maxLength === "number" && candidate.length > s.maxLength) return false;
    }
    if (typeof candidate === "number") {
      if (typeof s.minimum === "number" && candidate < s.minimum) return false;
      if (typeof s.maximum === "number" && candidate > s.maximum) return false;
    }
    if (Array.isArray(candidate)) {
      if (typeof s.minItems === "number" && candidate.length < s.minItems) return false;
      if (typeof s.maxItems === "number" && candidate.length > s.maxItems) return false;
      if (s.items !== undefined && !candidate.every((item) => visit(item, s.items, depth + 1))) return false;
    }
    if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
      const object = candidate as Record<string, unknown>;
      const props = s.properties && typeof s.properties === "object" && !Array.isArray(s.properties) ? s.properties as Record<string, unknown> : {};
      if (Array.isArray(s.required) && s.required.some((key) => typeof key !== "string" || !(key in object))) return false;
      if (typeof s.minProperties === "number" && Object.keys(object).length < s.minProperties) return false;
      if (typeof s.maxProperties === "number" && Object.keys(object).length > s.maxProperties) return false;
      if (s.additionalProperties === false && Object.keys(object).some((key) => !(key in props))) return false;
      for (const [key, child] of Object.entries(object)) if (key in props && !visit(child, props[key], depth + 1)) return false;
      if (s.additionalProperties && typeof s.additionalProperties === "object" &&
          Object.entries(object).some(([key, child]) => !(key in props) && !visit(child, s.additionalProperties, depth + 1))) return false;
    } else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined ||
        s.minProperties !== undefined || s.maxProperties !== undefined) {
      return false;
    }
    if (!Array.isArray(candidate) && s.items !== undefined) return false;
    return true;
  };
  return visit(value, schema, 0);
}

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
    if (data.inputSchema !== undefined && !isSupportedJsonSchema(data.inputSchema)) {
      return err({ code: "validation", retryable: false,
        message: `Upstream tool definition at index ${index} uses a schema keyword this Gateway cannot enforce` });
    }
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
