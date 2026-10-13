import { z } from "zod";
import { JsonValueSchema } from "./common.js";

const errorFields = {
  message: z.string().min(1),
  details: JsonValueSchema.optional()
};

export const ContractErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("validation"), retryable: z.literal(false), ...errorFields }).strict(),
  z
    .object({
      code: z.literal("conflict"),
      retryable: z.literal(true),
      version: z
        .object({
          expected: z.number().int().nonnegative(),
          actual: z.number().int().nonnegative()
        })
        .strict()
        .optional(),
      ...errorFields
    })
    .strict(),
  z
    .object({
      code: z.literal("timeout"),
      retryable: z.literal(true),
      retrySafety: z.enum(["not_started", "observation_only"]),
      ...errorFields
    })
    .strict(),
  z.object({ code: z.literal("cancelled"), retryable: z.literal(false), ...errorFields }).strict(),
  z.object({ code: z.literal("transport_unavailable"), retryable: z.literal(true), ...errorFields }).strict(),
  z
    .object({
      code: z.literal("unknown_delivery"),
      retryable: z.literal(false),
      manualInterventionRequired: z.literal(true),
      ...errorFields
    })
    .strict(),
  z.object({ code: z.literal("corruption"), retryable: z.literal(false), ...errorFields }).strict(),
  z
    .object({
      code: z.literal("unsupported_version"),
      retryable: z.literal(false),
      supportedVersions: z.array(z.number().int().nonnegative()).min(1),
      receivedVersion: z.number().int().nonnegative(),
      ...errorFields
    })
    .strict(),
  z.object({ code: z.literal("not_found"), retryable: z.literal(false), ...errorFields }).strict()
]);

export type ContractError = z.infer<typeof ContractErrorSchema>;

export type OperationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContractError };

export function OperationResultSchema<TSchema extends z.ZodTypeAny>(valueSchema: TSchema) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: valueSchema }).strict(),
    z.object({ ok: z.literal(false), error: ContractErrorSchema }).strict()
  ]);
}
