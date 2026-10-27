import { z } from "zod";
import { type JsonValue } from "@bflow/contracts";
import { AGY_INLINE_REPLY_BYTES } from "./agy-assignment-admission.js";
import { digest, json, record } from "./journal.js";
import { HANDOVER_WARNING } from "./task-handover.js";

export const TaskHandoverReadInputSchema = z.object({
  runId: z.string().min(1).optional(), taskId: z.string().min(1).optional(),
  view: z.enum(["full", "page"]).optional(), cursor: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  offset: z.number().int().nonnegative().safe().optional()
}).strict();
const pageInstruction = "Reassemble page strings in offset order and parse the complete JSON before continuing. Fetch every nextOffset with the same cursor using read_task_handover. Pages retain exact host requirements, approvals and blockers; no partial page grants authority. On stale cursor restart at offset 0.";

/** Bounded transport view only: canonical handover and authoritative host state are never truncated. */
export function taskHandoverView(value: unknown, input: unknown = {}, bounded = false): JsonValue {
  const query = TaskHandoverReadInputSchema.parse(input), raw = JSON.stringify(value), bytes = Buffer.from(raw, "utf8"), cursor = digest(value);
  if (query.cursor !== undefined && query.cursor !== cursor) throw new Error("handover_cursor_stale: context changed; restart at offset 0");
  const offset = query.offset ?? 0;
  if (offset > 0 && !query.cursor) throw new Error("handover_cursor_required");
  if (offset > bytes.length || offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new Error("handover_offset_invalid");
  if (query.view !== "page" && offset === 0 && (!bounded || bytes.length <= AGY_INLINE_REPLY_BYTES)) return json(value);
  // JSON escaping may double page bytes; 1600 leaves room for cursor, warning and instructions within 8500 bytes.
  let end = Math.min(offset + 1600, bytes.length);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return json({ code: "handover_context_paged", contextTrust: "untrusted_handover_with_host_authority", cursor, offset,
    nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length, page: bytes.subarray(offset, end).toString("utf8"),
    instruction: pageInstruction, warning: HANDOVER_WARNING });
}
/** Automatic assignment/workspace context points at the complete paged reader for bounded providers. */
export function deferredTaskHandover(value: unknown): JsonValue {
  const binding = record(record(value).binding ?? {});
  return json({ code: "handover_context_deferred", readWith: { tool: "read_task_handover", runId: binding.runId, taskId: binding.taskId },
    instruction: "Read the complete current handover and host authority with read_task_handover before continuing; follow all nextOffset pages. Current approvals, blockers and policy remain in force." });
}
/** Acknowledgement is not a context reload; avoid echoing the entire stored body. */
export function taskHandoverAcknowledgement(value: unknown): JsonValue {
  const context = record(value), result = record(context.handover);
  return json({ binding: context.binding, handover: { status: result.status, code: result.code, warning: result.warning },
    instruction: "Read read_task_handover for the host-selected context and current authority. This receipt is not approval or success evidence." });
}
