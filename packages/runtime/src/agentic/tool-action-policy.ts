import type { JsonValue, ResolvedToolGrant } from "@bflow/contracts";

/** Host-side memory scope guard; the Gateway independently validates the negotiated upstream input schema. */
export function validateMemoryActionInput(grant: ResolvedToolGrant, operation: string, raw: JsonValue): void {
  const scope = grant.memoryScope;
  if (!scope) return;
  if (scope.access !== "read_only" || !["mempalace_search", "mempalace_status"].includes(operation))
    throw new Error("Memory grants are read only; this operation is not approved for scoped retrieval");
  if (operation !== "mempalace_search") return;
  if (!isRecord(raw) || raw.wing !== scope.wing) throw new Error("Memory search must name the exact granted wing");
  if (raw.repositoryId !== undefined && raw.repositoryId !== scope.repositoryId)
    throw new Error("Memory search repository does not match its granted scope");
}

/** Keeps memory content out of context unless the source returns verifiable provenance for the granted scope. */
export function validateMemoryActionOutput(grant: ResolvedToolGrant, operation: string, output: JsonValue): readonly Record<string, unknown>[] | null | undefined {
  const scope = grant.memoryScope;
  if (!scope || operation !== "mempalace_search") return undefined;
  if (!isRecord(output)) return null;
  const rawItems = Array.isArray(output.results) ? output.results : Array.isArray(output.memories) ? output.memories :
    Array.isArray(output.items) ? output.items : undefined;
  if (!rawItems) return null;
  if (rawItems.length === 0) return [];
  const accepted: Record<string, unknown>[] = [];
  for (const raw of rawItems) {
    if (!isRecord(raw) || !isRecord(raw.provenance)) return null;
    const provenance = raw.provenance;
    const timestamp = provenance.timestamp ?? provenance.createdAt ?? provenance.retrievedAt;
    const sourceReference = provenance.sourceId ?? provenance.source ?? provenance.uri;
    if (provenance.wing !== scope.wing || provenance.repositoryId !== scope.repositoryId ||
        typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)) ||
        typeof sourceReference !== "string" || sourceReference.length === 0) return null;
    accepted.push({ ...raw, provenance: { ...provenance, timestamp, sourceReference } });
  }
  return accepted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
