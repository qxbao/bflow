import { IdempotencyKeySchema, JsonValueSchema, RoleMessageSchema, SpecificationSchema, type AgentRole, type RoleMessage } from "@bflow/contracts";
import { z } from "zod";

/** Provider discovery only. Exported Zod contracts remain the authoritative ingress validators,
 * including cross-field refinements which JSON Schema cannot represent. No defaults are applied. */
function render(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema === JsonValueSchema) return {}; // Any JSON value; avoid expanding its recursive definition.
  if (schema instanceof z.ZodEffects) return render(schema.innerType());
  if (schema instanceof z.ZodOptional) return render(schema.unwrap());
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    return { type: "object", properties: Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, render(value)])),
      required: Object.entries(shape).filter(([, value]) => !value.isOptional()).map(([key]) => key),
      additionalProperties: schema._def.unknownKeys !== "strict" };
  }
  if (schema instanceof z.ZodString) return { type: "string",
    ...(schema.minLength === null ? {} : { minLength: schema.minLength }),
    ...(schema.maxLength === null ? {} : { maxLength: schema.maxLength }),
    ...Object.assign({}, ...schema._def.checks.map(check => check.kind === "regex" ? { pattern: check.regex.source }
      : check.kind === "datetime" ? { format: "date-time" } : {})) };
  if (schema instanceof z.ZodNumber) return { type: schema.isInt ? "integer" : "number",
    ...Object.assign({}, ...schema._def.checks.map(check => check.kind === "min"
      ? { [check.inclusive ? "minimum" : "exclusiveMinimum"]: check.value }
      : check.kind === "max" ? { [check.inclusive ? "maximum" : "exclusiveMaximum"]: check.value } : {})) };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodLiteral) return { type: typeof schema.value, const: schema.value };
  if (schema instanceof z.ZodEnum) return { type: "string", enum: schema.options };
  if (schema instanceof z.ZodArray) return { type: "array", items: render(schema.element),
    ...(schema._def.minLength === null ? {} : { minItems: schema._def.minLength.value }),
    ...(schema._def.maxLength === null ? {} : { maxItems: schema._def.maxLength.value }) };
  if (schema instanceof z.ZodRecord) return { type: "object", additionalProperties: render(schema.valueSchema) };
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) return { anyOf: schema.options.map(render) };
  // Fail visibly if contracts acquire a new shape instead of silently advertising an opaque object.
  throw new Error(`Unsupported role tool schema: ${schema._def.typeName}`);
}

export const specificationToolSchema = render(SpecificationSchema);
const roleMessageToolSchema = render(RoleMessageSchema);
export const nativeRoleMessageToolSchema = {
  ...roleMessageToolSchema,
  required: [...roleMessageToolSchema.required as string[], "idempotency_key"]
};

/** Native Runtime ingress needs a stable key even though the general RoleMessage contract permits omission. */
export function parseNativeRoleMessage(input: unknown): RoleMessage {
  const message = RoleMessageSchema.parse(input);
  IdempotencyKeySchema.parse(message.idempotency_key, { path: ["idempotency_key"] });
  return message;
}

export function roleReplyExample(role: AgentRole): RoleMessage {
  return parseNativeRoleMessage({ schema_version: 2, message_id: "new-reply-id", correlation_id: "incoming-correlation-id",
    causation_id: "incoming-message-id", run_id: "incoming-run-id", sender: { role },
    recipient: { role: role === "coordinator" ? "conversation" : "coordinator" }, type: "task.status",
    payload: { status: "blocked", summary: "Describe the actual outcome", evidence: [], artifacts: [],
      blockers: ["Describe the actual blocker"], requested_action: "review", next_role: role === "coordinator" ? "conversation" : "coordinator" },
    artifact_references: [], idempotency_key: "stable-reply-key" });
}

export function roleReplyGuidance(role: AgentRole): string {
  return ` For send_role_message, the structured result is payload inside a complete RoleMessage v2. Envelope example (replace placeholders): ${JSON.stringify(roleReplyExample(role))}. Generate message_id and idempotency_key once per new reply; preserve incoming correlation_id and run_id and set causation_id to incoming message_id. Include artifact_references: [] when there are no stored artifacts. Only ArtifactStore can supply trusted references; payload artifacts are proposals. Sender agent_id/pane_id are host-bound. A delivery error or timeout is not proof of non-delivery: inspect/reconcile the original operation, never create a new ID/key or resend an uncertain delivery.`;
}
