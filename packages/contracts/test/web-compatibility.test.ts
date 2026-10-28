import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  JsonValueSchema,
  PaneBindingSchema
} from "../src/index.js";

// Pre-approval fixtures only: no new public schema or synthetic host ingress.
// Runtime's journal replay tests remain the authority for envelope acceptance.
const fixtureSchema = z.object({
  case: z.enum(["design", "delivery", "user_decision"]),
  request: ApprovalRequestSchema,
  decision: ApprovalDecisionSchema,
  nativeReceipt: z.object({
    version: z.literal(1), repository: z.string(), sessionId: z.string(),
    kind: z.literal("human"), id: z.string(),
    payload: z.object({
      decision: ApprovalDecisionSchema,
      provenance: z.object({
        origin: z.literal("UserPromptSubmit"), binding: PaneBindingSchema,
        nativeSessionId: z.string(), conversationSessionId: z.string(),
        userId: z.string(), messageId: z.string(), promptDigest: z.string()
      }).strict()
    }).strict(),
    checksum: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(),
  // These are data for the future WebCommandSchema RED tests, not a parser.
  proposedWebCommand: z.record(JsonValueSchema)
}).strict();
const raw: unknown = JSON.parse(readFileSync(new URL(
  "./fixtures/local-web/approval-bundle.json", import.meta.url
), "utf8"));
const fixtures = z.array(fixtureSchema).length(3).parse(raw);

// Lowercase ASCII keys in the native journal fixture use this canonical form.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

describe("D-WEB-01 pre-approval native compatibility vectors", () => {
  it("includes design, delivery and specialist user-decision cases", () => {
    expect(fixtures.map(fixture => fixture.case)).toEqual(["design", "delivery", "user_decision"]);
  });

  for (const fixture of fixtures) {
    it(`${fixture.case}: current exported schemas roundtrip the native payload unchanged`, () => {
      const { request, decision, nativeReceipt } = fixture;
      expect(ApprovalRequestSchema.parse(request)).toEqual(request);
      expect(ApprovalDecisionSchema.parse(decision)).toEqual(decision);
      expect(PaneBindingSchema.parse(nativeReceipt.payload.provenance.binding))
        .toEqual(nativeReceipt.payload.provenance.binding);
      expect(nativeReceipt.payload.decision).toEqual(decision);
      expect({
        approvalId: decision.approvalId, runId: decision.runId, target: decision.target,
        revision: decision.revision, generation: decision.generation
      }).toEqual({
        approvalId: request.approvalId, runId: request.runId, target: request.target,
        revision: request.revision, generation: request.generation
      });
      expect(nativeReceipt.payload.provenance.binding.session?.value)
        .toBe(nativeReceipt.payload.provenance.nativeSessionId);
      expect(nativeReceipt.payload.provenance.userId).toBe(decision.decidedBy);
    });

    it(`${fixture.case}: static v1 checksum and identity are stable`, () => {
      const { checksum, ...envelope } = fixture.nativeReceipt;
      expect(createHash("sha256").update(canonical(envelope)).digest("hex")).toBe(checksum);
      expect(envelope.id).toBe(fixture.decision.approvalId);
      expect(envelope.sessionId).toBe(envelope.payload.provenance.binding.sessionId);
    });

    it(`${fixture.case}: existing approval parsing rejects omitted revision/target/generation`, () => {
      for (const key of ["target", "revision", "generation"] as const) {
        const input = { ...fixture.decision };
        Reflect.deleteProperty(input, key);
        expect(ApprovalDecisionSchema.safeParse(input).success).toBe(false);
      }
      expect(ApprovalDecisionSchema.safeParse({ ...fixture.decision, authenticatedUser: true }).success).toBe(false);
      expect(ApprovalDecisionSchema.safeParse({ ...fixture.decision, schemaVersion: 99 }).success).toBe(false);
    });
  }
});
