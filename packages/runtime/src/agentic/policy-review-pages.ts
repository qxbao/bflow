import { createHash } from "node:crypto";
import { z } from "zod";
import type { JsonValue } from "@bflow/contracts";
import { digest, json, record } from "./journal.js";

const MAX_BYTES = 16 * 1024 * 1024;
export const PolicyReviewPageInputSchema = z.object({
  runId: z.string().min(1), taskId: z.string().min(1), phase: z.enum(["green", "refactor", "verification"]),
  view: z.enum(["full", "page"]).optional(), cursor: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  offset: z.number().int().nonnegative().max(MAX_BYTES).optional()
}).strict();
export interface PolicyReviewPageScope { binding: string; runId: string; taskId: string; phase: string; stamp: string }
interface Packet { scope: string; body: Buffer; sha256: string; observationId: string; pageBytes: number; readThrough: number }
const instruction = "Read every page in nextOffset order with inspect_alternative_verification, the same runId/taskId/phase and cursor. Concatenate page strings and parse the complete JSON; sha256 covers its UTF-8 bytes. observationId is supplied only on the final page: attach it to the parsed result before judging every accepted criterion. Pages are captured inspection data, not approval or verification success. A stale cursor requires a fresh inspection at offset 0.";

/** Presentation only. The original observation and all phase evidence checks remain authoritative. */
export class PolicyReviewPages {
  private readonly packets = new Map<string, Packet>();
  private bytes = 0;
  constructor(private readonly maxPackets = 8, private readonly maxBytes = MAX_BYTES) {}
  open(scope: PolicyReviewPageScope, value: JsonValue, boundedProvider = false, forcePage = false): JsonValue {
    const full = Buffer.from(JSON.stringify(value), "utf8");
    if (!forcePage && full.length <= (boundedProvider ? 6000 : 48000)) return value;
    const { observationId, ...content } = record(value);
    const id = z.string().uuid().parse(observationId), body = Buffer.from(JSON.stringify(content), "utf8");
    if (body.length > this.maxBytes) throw new Error("policy_review_packet_too_large: split the reviewed scope; no evidence was accepted");
    const cursor = digest([scope, id]), packet: Packet = { scope: digest(scope), body,
      sha256: createHash("sha256").update(body).digest("hex"), observationId: id,
      pageBytes: boundedProvider ? 1600 : 8192, readThrough: 0 };
    const previous = this.packets.get(cursor);
    if (previous) { this.bytes -= previous.body.length; this.packets.delete(cursor); }
    while (this.packets.size >= this.maxPackets || this.bytes + body.length > this.maxBytes) {
      const oldest = this.packets.keys().next().value;
      if (oldest === undefined) throw new Error("policy_review_packet_capacity");
      this.bytes -= this.packets.get(oldest)!.body.length; this.packets.delete(oldest);
    }
    this.packets.set(cursor, packet); this.bytes += body.length;
    return this.read(scope, cursor, 0);
  }
  read(scope: PolicyReviewPageScope, cursorInput: string, offsetInput = 0): JsonValue {
    const cursor = z.string().regex(/^[a-f0-9]{64}$/).parse(cursorInput);
    const offset = z.number().int().nonnegative().max(MAX_BYTES).parse(offsetInput), packet = this.packets.get(cursor);
    if (!packet || packet.scope !== digest(scope)) throw new Error("policy_review_cursor_stale: role binding, request, phase or source changed; inspect again at offset 0");
    if (offset > packet.readThrough || offset > packet.body.length || offset < packet.body.length && (packet.body[offset]! & 0xc0) === 0x80)
      throw new Error("policy_review_offset_invalid: follow nextOffset in order");
    let end = Math.min(offset + packet.pageBytes, packet.body.length);
    while (end < packet.body.length && (packet.body[end]! & 0xc0) === 0x80) end--;
    packet.readThrough = Math.max(packet.readThrough, end);
    const complete = end === packet.body.length;
    return json({ code: "policy_review_paged", cursor, offset, nextOffset: complete ? null : end,
      totalBytes: packet.body.length, sha256: packet.sha256, page: packet.body.subarray(offset, end).toString("utf8"), complete,
      ...(complete ? { observationId: packet.observationId } : {}), instruction });
  }
}
