import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { PolicyReviewPages } from "../../src/agentic/policy-review-pages.js";
const scope = { binding: "native-qa-1", runId: "r", taskId: "t", phase: "green", stamp: "lease-request-revision-1" };
const packet = () => ({ observationId: randomUUID(), observation: { diff: "漢字🙂\"\\\n".repeat(16000) }, dossier: { requirements: ["Keep every criterion"] } });
it("preserves small replies and caps full-view large packets without revealing an early judgment id", () => {
  const pages = new PolicyReviewPages(), small = { observationId: randomUUID(), dossier: { a: 1 } };
  expect(pages.open(scope, small)).toBe(small);
  const raw = packet(), first = pages.open(scope, raw) as any;
  expect(first.code).toBe("policy_review_paged"); expect(JSON.stringify(first)).not.toContain(raw.observationId);
  expect(() => pages.read(scope, first.cursor, first.totalBytes)).toThrow("offset_invalid");
  expect(pages.read(scope, first.cursor, 0)).toEqual(first);
});
it.each(["binding", "stamp", "runId", "taskId", "phase"] as const)("rejects a page after %s scope changes", key => {
  const pages = new PolicyReviewPages(), first = pages.open(scope, packet()) as any;
  expect(() => pages.read({ ...scope, [key]: "changed" }, first.cursor, first.nextOffset)).toThrow("cursor_stale");
});
it("keeps every UTF-8 byte and bounds encoded Agy pages while withholding observation until the final page", () => {
  const pages = new PolicyReviewPages(), value = packet(); let current = pages.open(scope, value, true) as any;
  const first = current, parts: string[] = [];
  while (true) {
    expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThan(8500); parts.push(current.page);
    if (current.nextOffset === null) break;
    expect(current.observationId).toBeUndefined();
    current = pages.read(scope, first.cursor, current.nextOffset) as any;
  }
  expect(current.observationId).toBe(value.observationId);
  const { observationId: _id, ...expected } = value;
  expect(JSON.parse(parts.join(""))).toEqual(expected);
});
it("evicts bounded retained packets and rejects a payload larger than the cache without losing existing packets", () => {
  const pages = new PolicyReviewPages(1, 65536), value = () => ({ observationId: randomUUID(), diff: "x".repeat(50000) });
  const first = pages.open(scope, value()) as any, second = pages.open(scope, value()) as any;
  expect(() => pages.read(scope, first.cursor)).toThrow("cursor_stale");
  expect(() => pages.open(scope, packet())).toThrow("packet_too_large");
  expect(pages.read(scope, second.cursor)).toEqual(second);
});
