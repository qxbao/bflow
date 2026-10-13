import { z } from "zod";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema)
  ])
);

export const IdentifierSchema = z.string().trim().min(1).max(200);
export const IdempotencyKeySchema = z.string().trim().min(1).max(512);
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const MetadataSchema = z.record(JsonValueSchema);

export const PageRequestSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional()
  })
  .strict();

export type PageRequest = z.infer<typeof PageRequestSchema>;

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}
