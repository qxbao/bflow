import { digest } from "../agentic/journal.js";

/**
 * Keys that move without a domain change: observation times and a lease expiry that every heartbeat renews.
 * They stay in the DTOs for display but are removed before change detection, otherwise each heartbeat or read
 * would invalidate every connected browser (and a revisionToken built from them would never be stable).
 */
const VOLATILE_KEYS = new Set(["updatedAt", "observedAt", "leaseExpiresAt"]);
export function stableProjection(value: unknown): unknown {
  return Array.isArray(value) ? value.map(stableProjection)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !VOLATILE_KEYS.has(key)).map(([key, item]) => [key, stableProjection(item)])) : value;
}
export const projectionFingerprint = (views: unknown): string => digest(JSON.stringify(stableProjection(views)));
