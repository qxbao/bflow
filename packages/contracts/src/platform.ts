import { z } from "zod";
import { IdentifierSchema, IdempotencyKeySchema } from "./common.js";

/** Independent of RoleMessage v2, event v1/v2 and aggregate codec v2. */
export const CURRENT_PLATFORM_SCHEMA_VERSION = 3 as const;
export const PlatformSchemaVersionSchema = z.literal(CURRENT_PLATFORM_SCHEMA_VERSION);
export const AgentProviderIdSchema = z.enum(["claude", "codex", "agy"]);
export type AgentProviderId = z.infer<typeof AgentProviderIdSchema>;
export const ConfigurationLevelSchema = z.enum(["machine", "repository", "session"]);
export type ConfigurationLevel = z.infer<typeof ConfigurationLevelSchema>;
export const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const SafeArgumentSchema = z.string().refine(value => !value.includes("\0"), "NUL is forbidden");
export const NonEmptyArgumentSchema = SafeArgumentSchema.refine(value => value.trim().length > 0, "value is required");
export const SecretReferenceSchema = z.string().regex(/^secret:\/\/[A-Za-z0-9._/-]+$/);

/** Canonicalization, symlink containment and ownership are checked by the host. */
export const TrustScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("machine"), machineId: IdentifierSchema }).strict(),
  z.object({ kind: z.literal("repository"), machineId: IdentifierSchema,
    repositoryId: IdentifierSchema, workspaceRoot: NonEmptyArgumentSchema }).strict(),
  z.object({ kind: z.literal("session"), machineId: IdentifierSchema,
    repositoryId: IdentifierSchema, workspaceRoot: NonEmptyArgumentSchema, sessionId: IdentifierSchema }).strict()
]);
export type TrustScope = z.infer<typeof TrustScopeSchema>;

/** Scope containment only; canonical filesystem containment is a separate host check. */
export function isTrustScopeWithin(candidate: TrustScope, authority: TrustScope): boolean {
  if (candidate.machineId !== authority.machineId) return false;
  if (authority.kind === "machine") return true;
  if (candidate.kind === "machine" || candidate.repositoryId !== authority.repositoryId ||
      candidate.workspaceRoot !== authority.workspaceRoot) return false;
  return authority.kind === "repository" || (candidate.kind === "session" && candidate.sessionId === authority.sessionId);
}

export const ScopedOperationSchema = z.object({
  schemaVersion: PlatformSchemaVersionSchema,
  scope: TrustScopeSchema,
  idempotencyKey: IdempotencyKeySchema
}).strict();
export type ScopedOperation = z.infer<typeof ScopedOperationSchema>;
