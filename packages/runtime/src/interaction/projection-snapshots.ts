import { parseAgenticJournalState, type JournalState } from "../agentic/journal.js";

function immutable(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) immutable(child);
  Object.freeze(value);
}

/** Private read-only projection cache. Only exact owned bytes may reuse ingress validation. */
export class ProjectionSnapshots {
  private readonly entries = new Map<string, { bytes: Buffer; state: JournalState }>();
  parse(path: string, repository: string, bytes: Buffer): JournalState {
    const key = JSON.stringify([path, repository]), cached = this.entries.get(key);
    if (cached?.bytes.equals(bytes)) return cached.state;
    const owned = Buffer.from(bytes);
    const state = parseAgenticJournalState(JSON.parse(owned.toString("utf8")), repository);
    immutable(state);
    this.entries.delete(key);
    this.entries.set(key, { bytes: owned, state });
    while (this.entries.size > 4) this.entries.delete(this.entries.keys().next().value!);
    return state;
  }
}
