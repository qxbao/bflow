import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { IdentifierSchema, ProviderNativeFailureEventSchema } from "@bflow/contracts";
import { z } from "zod";

const inputSchema = z.object({ path: z.string().min(1), root: z.string().min(1), nativeSessionId: z.string().min(1), acceptedAt: z.string().datetime({ offset: true }) }).strict();
const frameSchema = z.object({ timestamp: z.string().datetime({ offset: true }), type: z.literal("event_msg"), payload: z.object({ type: z.string() }).passthrough() });
/** Bounded, read-only native evidence. The host supplies the launch-owned root, never a task-supplied file. */
export async function readCodexFailure(raw: unknown) {
  const input = inputSchema.parse(raw);
  try {
    // Symlinked ancestors (macOS /var, /tmp) are allowed; a symlinked transcript file is not.
    const root = await realpath(input.root), path = await realpath(input.path), child = relative(root, path);
    if (path !== resolve(await realpath(dirname(input.path)), basename(input.path)) || !child || child === ".." || child.startsWith("../") || resolve(root, child) !== path) return;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()) return;
      // Native metadata includes the system instructions (the observed header exceeds 16 KiB).
      // Read only its first line, in bounded chunks; never recover authority from an incomplete header.
      const first = Buffer.alloc(Math.min(512 * 1024, stat.size));
      let headerBytes = 0, headerEnd = -1;
      while (headerBytes < first.length && headerEnd < 0) {
        const { bytesRead } = await file.read(first, headerBytes, Math.min(16 * 1024, first.length - headerBytes), headerBytes);
        if (!bytesRead) return;
        const newline = first.indexOf(10, headerBytes);
        headerBytes += bytesRead;
        if (newline >= 0 && newline < headerBytes) headerEnd = newline;
      }
      if (headerEnd < 0 && headerBytes < stat.size) return;
      const metadata = z.object({ type: z.literal("session_meta"), payload: z.object({ id: z.literal(input.nativeSessionId) }) }).safeParse(
        JSON.parse(first.subarray(0, headerEnd < 0 ? headerBytes : headerEnd).toString("utf8")));
      if (!metadata.success) return;
      const length = Math.min(512 * 1024, stat.size), tail = Buffer.alloc(length), start = stat.size - length;
      await file.read(tail, 0, length, start);
      const rows = tail.toString("utf8").split("\n");
      if (start > 0) rows.shift();
      let result: { event: z.infer<typeof ProviderNativeFailureEventSchema>; observedAt: string } | undefined;
      let currentTurn: string | undefined;
      for (const row of rows) {
        if (!row || row.length > 64 * 1024) continue;
        let decoded: unknown;
        try { decoded = JSON.parse(row); } catch { continue; }
        const frame = frameSchema.safeParse(decoded);
        if (!frame.success || Date.parse(frame.data.timestamp) < Date.parse(input.acceptedAt)) continue;
        const payload = frame.data.payload;
        if (["task_started", "turn_started"].includes(payload.type)) {
          result = undefined;
          const turn = IdentifierSchema.safeParse(payload.turn_id);
          currentTurn = turn.success ? turn.data : undefined;
        } else if (payload.type === "user_message") result = undefined;
        if (payload.type === "task_complete") {
          const turn = IdentifierSchema.safeParse(payload.turn_id);
          if (!currentTurn || !turn.success) { result = undefined; continue; }
          // A terminal frame may arrive from an older turn. Never attach it to this execution or infer a missing anchor.
          if (turn.data !== currentTurn) continue;
          // Terminal success/malformed failure supersedes an intermediate retry error from the same turn.
          result = undefined;
        }
        const event = ProviderNativeFailureEventSchema.safeParse(decoded);
        if (event.success && "payload" in event.data) result = { event: event.data, observedAt: frame.data.timestamp };
      }
      const after = await file.stat();
      if (after.ino !== stat.ino || after.size < stat.size) return;
      return result;
    } finally { await file.close(); }
  } catch { return; }
}
