import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentRoleSchema } from "./agent-roles.js";
import { IdentifierSchema } from "./common.js";
import { AgentProviderIdSchema, Sha256DigestSchema } from "./platform.js";
import { canonicalReceiptJson } from "./receipts.js";

export const ROLE_PROFILE_FEATURE = "custom-specialist-profiles-v1" as const;
export const SpecialistRoleSchema = AgentRoleSchema.exclude(["conversation", "coordinator"]);
export type SpecialistRole = z.infer<typeof SpecialistRoleSchema>;
export const ExactProfileVersionSchema = z.string().max(100).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "an exact version is required");
export const RoleProfilePinSchema = z.object({ profileId: IdentifierSchema, version: ExactProfileVersionSchema, digest: Sha256DigestSchema }).strict();
export type RoleProfilePin = z.infer<typeof RoleProfilePinSchema>;

const pathScope = z.string().min(1).max(1000).refine(value => !value.startsWith("/") && !/[\\\0*?\[\]{}]/.test(value) &&
  value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..") &&
  !value.split("/").includes(".git") && !value.startsWith(".bflow"), "scope must be a safe repository-relative file/directory prefix");
const uniqueStrings = (schema: z.ZodType<string>) => z.array(schema).max(1000).refine(values => new Set(values).size === values.length, "duplicates are forbidden");
const ToolRestriction = z.object({ toolId: IdentifierSchema, operations: uniqueStrings(IdentifierSchema) }).strict();
const tools = z.array(ToolRestriction).max(1000).refine(values => new Set(values.map(v => v.toolId)).size === values.length, "tool IDs must be unique");
export const RoleProfileRestrictionsSchema = z.object({
  readablePaths: uniqueStrings(pathScope).optional(), writablePaths: uniqueStrings(pathScope).optional(), deniedPaths: uniqueStrings(pathScope).optional(),
  capabilityIds: uniqueStrings(IdentifierSchema).optional(), tools: tools.optional(), networkHosts: uniqueStrings(IdentifierSchema).optional()
}).strict();
export type RoleProfileRestrictions = z.infer<typeof RoleProfileRestrictionsSchema>;
export const CustomRoleProfileSchema = z.object({
  schemaVersion: z.literal(3), profileId: IdentifierSchema, version: ExactProfileVersionSchema,
  displayName: z.string().trim().min(1).max(200).refine(v => !/[\x00-\x1f\x7f]/.test(v)), baseRole: SpecialistRoleSchema,
  additionalInstructions: z.string().refine(v => Buffer.byteLength(v, "utf8") <= 65536 && !v.includes("\0"), "instructions must be at most 64 KiB without NUL"),
  skillPins: z.array(z.object({ skillId: IdentifierSchema, version: ExactProfileVersionSchema, digest: Sha256DigestSchema }).strict()).max(1000)
    .refine(values => new Set(values.map(v => v.skillId)).size === values.length, "skill IDs must be unique"),
  toolRequirements: tools,
  preferences: z.object({ provider: AgentProviderIdSchema.optional(), model: z.string().trim().min(1).max(200).optional(),
    effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]).optional() }).strict().optional(),
  restrictions: RoleProfileRestrictionsSchema
}).strict().superRefine((profile, ctx) => {
  if (profile.preferences?.provider === "agy" && profile.preferences.effort !== undefined)
    ctx.addIssue({ code: "custom", message: "Agy effort is encoded in the model name", path: ["preferences", "effort"] });
});
export type CustomRoleProfile = z.infer<typeof CustomRoleProfileSchema>;
export function pinRoleProfile(input: unknown): RoleProfilePin {
  const definition = CustomRoleProfileSchema.parse(input);
  return { profileId: definition.profileId, version: definition.version,
    digest: createHash("sha256").update(canonicalReceiptJson(definition)).digest("hex") };
}
export function sameRoleProfilePin(a: RoleProfilePin | undefined, b: RoleProfilePin | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.profileId === b.profileId && a.version === b.version && a.digest === b.digest;
}
export const ResolvedRoleProfileSnapshotSchema = z.object({
  schemaVersion: z.literal(3), pin: RoleProfilePinSchema, definition: CustomRoleProfileSchema,
  baseRolePolicyDigest: Sha256DigestSchema, resolutionPolicyVersion: z.literal(ROLE_PROFILE_FEATURE)
}).strict().superRefine((snapshot, ctx) => {
  if (!sameRoleProfilePin(snapshot.pin, pinRoleProfile(snapshot.definition))) ctx.addIssue({ code: "custom", message: "profile definition/pin digest mismatch" });
});
export type ResolvedRoleProfileSnapshot = z.infer<typeof ResolvedRoleProfileSnapshotSchema>;
export const SpecialistProfileSelectionSchema = z.object({ role: SpecialistRoleSchema, profile: RoleProfilePinSchema }).strict();
export type SpecialistProfileSelection = z.infer<typeof SpecialistProfileSelectionSchema>;
export const RoleProfileCatalogSchema = z.array(ResolvedRoleProfileSnapshotSchema).max(128).superRefine((snapshots, ctx) => {
  const ids = snapshots.map(s => `${s.pin.profileId}@${s.pin.version}`);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "profile ID/version must be unique" });
});
export const ExecutorLineageSchema = z.object({ schemaVersion: z.literal(3), executorId: IdentifierSchema,
  launchId: IdentifierSchema, nativeSessionId: IdentifierSchema, bindingId: IdentifierSchema,
  predecessorExecutorId: IdentifierSchema.optional(), assignmentIds: uniqueStrings(IdentifierSchema),
  freshContext: z.boolean(), purpose: z.enum(["implementation", "verification", "specialist"])
}).strict().superRefine((value, ctx) => {
  if (!value.freshContext && !value.predecessorExecutorId) ctx.addIssue({ code: "custom", message: "successor context requires authenticated predecessor" });
});
export type ExecutorLineage = z.infer<typeof ExecutorLineageSchema>;
