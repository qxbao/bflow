import { JsonValueSchema, type JsonValue } from "@bflow/contracts";
import { RoleOutputSchemas } from "../analysis/model.js";
import { QaRoleOutputSchemas } from "../qa/model.js";

export const NATIVE_EXTENSION_OUTPUT_BYTES = 1024 * 1024;

/** Native envelopes prove origin, not correctness. Delegate semantic output to the existing extension schemas. */
export function parseNativeExtensionOutput(scope: { family: string; taskId: string }, input: unknown): JsonValue {
  const json = JsonValueSchema.parse(input), encoded = JSON.stringify(json);
  if (Buffer.byteLength(encoded) > NATIVE_EXTENSION_OUTPUT_BYTES) throw new Error("Native extension output exceeds its size bound");
  if (scope.family === "analysis") {
    switch (scope.taskId) {
      case "survey": return JsonValueSchema.parse(RoleOutputSchemas.survey.parse(json));
      case "elicitation": return JsonValueSchema.parse(RoleOutputSchemas.elicitation.parse(json));
      case "specification": return JsonValueSchema.parse(RoleOutputSchemas.specification.parse(json));
      case "review": return JsonValueSchema.parse(RoleOutputSchemas.review.parse(json));
    }
  } else if (scope.family === "qa") {
    switch (scope.taskId) {
      case "design": return JsonValueSchema.parse(QaRoleOutputSchemas.design.parse(json));
      case "design-review": return JsonValueSchema.parse(QaRoleOutputSchemas["design-review"].parse(json));
      case "adjudication": return JsonValueSchema.parse(QaRoleOutputSchemas.adjudication.parse(json));
    }
  }
  throw new Error("Unknown or Runtime-internal extension output kind");
}
