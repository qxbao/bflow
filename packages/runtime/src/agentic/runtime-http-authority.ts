import { z } from "zod";
import { IdentifierSchema, RuntimeHttpGrantSchema, RuntimeHttpPolicySchema,
  type RuntimeHttpGrant, type RuntimeHttpPolicy } from "@bflow/contracts";
import { canonicalPlanDigest } from "../planning/index.js";

const Action = z.object({ runId: IdentifierSchema, toolId: z.literal("qa-http"), action: z.enum(["http_read", "http_mutate"]),
  origin: z.string().min(1).max(256) }).strict();
export interface RuntimeHttpAction { runId: string; toolId: string; action: string; origin: string }

/** Host-only authority. It neither approves a design nor grants a native provider any network tool. */
export function createRuntimeHttpAuthority(options: {
  policy?: RuntimeHttpPolicy; grants: readonly RuntimeHttpGrant[];
  machineId: string; repositoryId: string; workspaceRoot: string; sessionId: string;
  revalidate?: () => Promise<void>;
}): (input: RuntimeHttpAction) => Promise<void> {
  // Parse/copy at ingress so a caller cannot mutate its original snapshot to elevate a live grant.
  const policy = options.policy === undefined ? undefined : RuntimeHttpPolicySchema.parse(options.policy);
  const grants = z.array(RuntimeHttpGrantSchema).parse(options.grants);
  return async input => {
    const action = Action.parse(input);
    if (!policy || !options.revalidate) throw new Error("Runtime HTTP policy/grant authority requires a current pinned policy watcher");
    const { digest, ...body } = policy;
    if (canonicalPlanDigest(body) !== digest) throw new Error("Runtime HTTP policy digest mismatch");
    if (policy.scope.kind !== "repository" || policy.repositoryId !== options.repositoryId || policy.scope.machineId !== options.machineId ||
        policy.scope.repositoryId !== options.repositoryId || policy.scope.workspaceRoot !== options.workspaceRoot)
      throw new Error("Runtime HTTP policy scope differs from the host authority");
    if (grants.length !== 1) throw new Error("Runtime HTTP grant is missing or ambiguous");
    const grant = grants[0]!;
    if (grant.policyDigest !== digest || grant.scope.kind !== "session" || grant.scope.sessionId !== options.sessionId ||
        grant.scope.machineId !== options.machineId || grant.scope.repositoryId !== options.repositoryId || grant.scope.workspaceRoot !== options.workspaceRoot ||
        grant.origins.some(origin => !policy.origins.includes(origin)) || grant.operations.some(operation => !policy.operations.includes(operation)))
      throw new Error("Runtime HTTP grant scope or policy authority mismatch");
    if (!policy.origins.includes(action.origin) || !grant.origins.includes(action.origin) ||
        !policy.operations.includes(action.action) || !grant.operations.includes(action.action))
      throw new Error("Runtime HTTP origin/operation exceeds the pinned policy/grant authority");
    // The caller fence-checks after this last awaited policy check and immediately before the target effect.
    await options.revalidate();
  };
}
