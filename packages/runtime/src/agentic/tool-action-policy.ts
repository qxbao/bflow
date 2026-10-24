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
  if (output.isError === true) return null;
  if (Array.isArray(output.content)) {
    const texts = output.content.flatMap(item => isRecord(item) && item.type === "text" ? [item] : []);
    if (texts.length !== 1 || typeof texts[0]!.text !== "string" || texts[0]!.text.length > 1_000_000) return null;
    try { output = JSON.parse(texts[0]!.text) as JsonValue; } catch { return null; }
    if (!isRecord(output)) return null;
  }
  const rawItems = Array.isArray(output.results) ? output.results : Array.isArray(output.memories) ? output.memories :
    Array.isArray(output.items) ? output.items : undefined;
  if (!rawItems) return null;
  if (rawItems.length === 0) return [];
  const accepted: Record<string, unknown>[] = [];
  for (const raw of rawItems) {
    if (!isRecord(raw)) return null;
    if (!isRecord(raw.provenance)) {
      // MemPalace's native fields are source evidence. The repository relation
      // comes from the operator-approved wing mapping, never from the upstream.
      if (raw.wing !== scope.wing || typeof raw.drawer_id !== "string" || !raw.drawer_id ||
          typeof raw.source_path !== "string" || !raw.source_path || typeof raw.text !== "string" ||
          typeof raw.filed_at !== "string" || !Number.isFinite(Date.parse(raw.filed_at))) return null;
      accepted.push({ ...raw, provenance: { wing: raw.wing, sourceId: raw.drawer_id, sourceReference: raw.source_path,
        timestamp: raw.filed_at, repositoryId: scope.repositoryId, repositoryBinding: "approved_wing_policy" } });
      continue;
    }
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
