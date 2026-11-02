import { WebActivityEntrySchema, WebPageSchema, type WebActivityEntry } from "@bflow/contracts";
import { TaskActivityLog } from "../agentic/task-activity-log.js";

const PAGE_SIZE = 25;
const MAX_ENTRIES = 1000, MAX_BYTES = 512 * 1024;
const sliceSafe = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
};

/**
 * Read-only page of one run's diagnostic activity, newest first. The log is best-effort and not transactional, so a
 * missing, unreadable or empty file is an empty page: it proves neither that work succeeded nor that it failed.
 * Only the allowlisted fields leave the host; `reason`, `artifacts`, attempt ids and labels are never copied.
 */
export async function readRunActivityPage(
  logPath: string, runId: string, cursor: string | undefined, redact: (text: string) => string,
) {
  const shown = (text: string, max: number) => sliceSafe(redact(text), max).trim();
  const { entries } = await TaskActivityLog.open(logPath).readWithMeta({ runId, lines: MAX_ENTRIES, maxBytes: MAX_BYTES });
  const items: WebActivityEntry[] = [];
  for (const entry of entries.slice().reverse()) {
    if (!entry.id) continue;
    const outcome = entry.outcome === undefined ? "" : shown(entry.outcome, 240);
    const parsed = WebActivityEntrySchema.safeParse({
      entryId: entry.id, occurredAt: entry.at, kind: shown(entry.kind, 32), role: shown(entry.role, 32), action: shown(entry.action, 80),
      runId, ...(entry.taskId ? { taskId: entry.taskId } : {}), ...(outcome ? { outcome } : {}),
    });
    if (parsed.success) items.push(parsed.data);
  }
  // An unknown cursor (rotated out of the bounded log) restarts from the newest page instead of failing.
  const start = cursor === undefined ? -1 : items.findIndex(item => item.entryId === cursor);
  const rest = items.slice(start + 1), page = rest.slice(0, PAGE_SIZE);
  return WebPageSchema(WebActivityEntrySchema).parse({
    apiVersion: 1, items: page, ...(rest.length > page.length ? { nextCursor: page.at(-1)!.entryId } : {}),
  });
}
