import type { Specification } from "@bflow/contracts";
import { HighLevelError, validationError } from "../envelope.js";
import { readJsonFile, resolveInput, type HighLevelContext, type StepLog } from "../context.js";
import { requestDigest } from "../journal.js";

export interface LoadedSpecification {
  readonly spec: Specification;
  readonly path: string;
  readonly digest: string;
}

/** Ingress: contract schema plus P15 SDD metadata validation. */
export async function loadSpecification(ctx: HighLevelContext, log: StepLog, path: string): Promise<LoadedSpecification> {
  const resolved = resolveInput(ctx, path);
  return log.check("load-specification", async () => {
    const raw = await readJsonFile(resolved, "Specification");
    let spec: Specification;
    try {
      spec = ctx.services.specification.parse(raw);
    } catch (error) {
      throw new HighLevelError(validationError(`Invalid specification '${resolved}': ${(error as Error).message}`,
        { reason: "invalid_specification", path: resolved }));
    }
    return { spec, path: resolved, digest: requestDigest(JSON.parse(JSON.stringify(spec))) };
  }, value => ({ specId: value.spec.specId, version: value.spec.version ?? null, status: value.spec.status,
    level: value.spec.level, digest: value.digest }));
}

/** Task identifiers the specification traces to, in first-seen order. */
export function tracedTaskIds(spec: Specification): string[] {
  const ids: string[] = [...(spec.traceabilityTaskIds ?? [])];
  const sdd = spec.metadata?.sdd as { traceability?: { taskIds?: unknown }[] } | undefined;
  for (const mapping of sdd?.traceability ?? [])
    for (const id of Array.isArray(mapping.taskIds) ? mapping.taskIds : [])
      if (typeof id === "string") ids.push(id);
  return [...new Set(ids)];
}

/** Governance gate for implementation and verification: only an approved, stored specification. */
export function assertApproved(spec: Specification): void {
  if (spec.status !== "approved" || spec.approvedBy === undefined || spec.artifactRef === undefined)
    throw new HighLevelError(validationError(
      `Specification '${spec.specId}' is '${spec.status}'; implementation requires an approved specification with a stored artifact`,
      { reason: "specification_not_approved", status: spec.status }), 3);
}
