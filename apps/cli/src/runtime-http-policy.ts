import { createHash } from "node:crypto";
import { canonicalReceiptJson, RuntimeHttpGrantSchema, RuntimeHttpPolicySchema,
  type RuntimeHttpGrant, type RuntimeHttpPolicy } from "@bflow/contracts";
import { digest } from "@bflow/machine-setup";
import type { EnvironmentCompositionInput } from "./environment.js";

interface HostScope { machineId: string; repositoryId: string; workspaceRoot: string; sessionId: string }

function checkedPolicy(input: unknown, scope: Omit<HostScope, "sessionId">): RuntimeHttpPolicy {
  const policy = RuntimeHttpPolicySchema.parse(input), { digest: expected, ...body } = policy;
  if (digest(body) !== expected) throw new Error("Runtime HTTP policy digest does not match its canonical contents");
  if (policy.repositoryId !== scope.repositoryId || policy.scope.kind !== "repository" || policy.scope.machineId !== scope.machineId ||
      policy.scope.repositoryId !== scope.repositoryId || policy.scope.workspaceRoot !== scope.workspaceRoot)
    throw new Error("Runtime HTTP policy identity must match this machine and repository");
  return policy;
}

/** Desired repository authority only. It creates no service, executable, session or target side effect. */
export function resolveRuntimeHttpPolicy(input: EnvironmentCompositionInput, machineId: string): RuntimeHttpPolicy | undefined {
  const policy = input.config.environment.runtimeHttpPolicy;
  return policy === undefined ? undefined : checkedPolicy(policy, { machineId, repositoryId: input.repository.id, workspaceRoot: input.repository.root });
}

/** Startup upper bound; the host still requires exact human-approved intake before invoking HTTP. */
export function resolveRuntimeHttpGrant(input: RuntimeHttpPolicy | undefined, scope: HostScope): RuntimeHttpGrant | undefined {
  if (input === undefined) return undefined;
  const policy = checkedPolicy(input, scope);
  const grantScope = { kind: "session" as const, ...scope };
  const key = createHash("sha256").update(canonicalReceiptJson({ policyDigest: policy.digest, scope: grantScope })).digest("hex").slice(0, 40);
  return RuntimeHttpGrantSchema.parse({ schemaVersion: 3, kind: "runtime_http", grantId: `runtime-http-${key}`, policyDigest: policy.digest,
    toolId: "qa-http", role: "qa", scope: grantScope, origins: policy.origins, operations: policy.operations });
}
