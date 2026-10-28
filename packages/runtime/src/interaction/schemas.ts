import { z } from "zod";
import { IdentifierSchema, WebRunQuerySchema, WebCommandSchema } from "@bflow/contracts";
import { WebPrincipalSchema } from "@bflow/contracts/web-host";
export const InteractionExecuteSchema = z.object({ command: WebCommandSchema, principal: WebPrincipalSchema }).strict();
export const InteractionOperationSchema = z.object({ projectId: IdentifierSchema, operationId: z.string().uuid() }).strict();
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
