import { createHash } from "node:crypto";
import type { Specification } from "@bflow/contracts";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Lifecycle fields are external; the immutable artifact represents reviewed requirements. */
export function contentBytes(spec: Specification): Buffer {
  const { status: _status, approvedBy: _approvedBy, artifactRef: _artifactRef, updatedAt: _updatedAt, ...content } = spec;
  return Buffer.from(canonicalJson(content), "utf8");
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
