import { z } from "zod";
import { IdentifierSchema } from "./common.js";
import { PlatformSchemaVersionSchema, Sha256DigestSchema, TrustScopeSchema } from "./platform.js";

// D-EXT-QA-HTTP: additive Runtime authority, approved separately from CLI/MCP tool policy.
// These grants never grant provider network access and must not enter the Gateway tool-grant union.
const Origin = z.string().min(1).max(256).refine(value => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value && !url.hostname.includes("*");
  } catch { return false; }
}, "Runtime HTTP origins must be exact normalized HTTP(S) origins without credentials or wildcards");
const Origins = z.array(Origin).min(1).max(8).refine(values => new Set(values).size === values.length, "origins must be unique");
const Operations = z.array(z.enum(["http_read", "http_mutate"])).min(1).max(2)
  .refine(values => new Set(values).size === values.length, "operations must be unique");
const Authority = {
  schemaVersion: PlatformSchemaVersionSchema,
  kind: z.literal("runtime_http"),
  toolId: z.literal("qa-http"),
  role: z.literal("qa"),
  scope: TrustScopeSchema,
  origins: Origins,
  operations: Operations
};

/** Repository-owner desired authority. A policy alone cannot authorize target activity or approve a QA design. */
export const RuntimeHttpPolicySchema = z.object({ ...Authority, repositoryId: IdentifierSchema, digest: Sha256DigestSchema })
  .strict().superRefine((policy, context) => {
    if (policy.scope.kind !== "repository")
      context.addIssue({ code: "custom", path: ["scope"], message: "Runtime HTTP policy requires repository scope" });
    else if (policy.scope.repositoryId !== policy.repositoryId)
      context.addIssue({ code: "custom", path: ["repositoryId"], message: "Runtime HTTP policy repository identity mismatch" });
  });
export type RuntimeHttpPolicy = z.infer<typeof RuntimeHttpPolicySchema>;

/** Startup policy bound to one host session; Runtime must also intersect it with the human-approved QA intake. */
export const RuntimeHttpGrantSchema = z.object({ ...Authority, grantId: IdentifierSchema, policyDigest: Sha256DigestSchema })
  .strict().superRefine((grant, context) => {
    if (grant.scope.kind !== "session")
      context.addIssue({ code: "custom", path: ["scope"], message: "Runtime HTTP grant requires host session scope" });
  });
export type RuntimeHttpGrant = z.infer<typeof RuntimeHttpGrantSchema>;
