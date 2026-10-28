import { z } from "zod";
import { IdentifierSchema, WebRunQuerySchema } from "@bflow/contracts";
/** Private control requests. Public payloads use only frozen exported web schemas. */
export const InteractionQuerySchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("session"), projectId: IdentifierSchema })
    .strict(),
  z
    .object({
      kind: z.literal("runs"),
      projectId: IdentifierSchema,
      query: WebRunQuerySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("run"),
      projectId: IdentifierSchema,
      runId: IdentifierSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal("decisions"), projectId: IdentifierSchema })
    .strict(),
]);
