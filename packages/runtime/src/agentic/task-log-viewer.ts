import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { setInterval, clearInterval } from 'node:timers';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_ENTRIES = 8192;
const POLL_MS = 500;
const control = /[\u0000-\u001f\u007f-\u009f]/g;
const clean = (value: unknown, max = 80): string => String(value ?? '').replace(control, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function display(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const entry = value as Record<string, unknown>;
  const at = typeof entry.at === 'string' ? Date.parse(entry.at) : NaN;
  const time = Number.isFinite(at) ? new Date(at).toISOString().slice(11, 19) : '--:--:--';
  const kind = clean(entry.kind, 48).toLowerCase();
  const outcome = clean(entry.outcome, 48);
  const severity = /error|denied|failed|blocked/.test(`${kind} ${outcome}`.toLowerCase()) ? '!' : /requested|warning|retry|unknown/.test(`${kind} ${outcome}`.toLowerCase()) ? '~' : '·';
  const context = [entry.role && clean(entry.role, 24), entry.runId && `run:${clean(entry.runId, 16)}`, entry.taskId && `task:${clean(entry.taskId, 16)}`, entry.attemptId && `try:${clean(entry.attemptId, 12)}`].filter(Boolean).join(' ');
  const action = clean(entry.action, 100) || clean(entry.kind, 48) || 'activity';
  const result = outcome ? ` → ${outcome}` : '';
  const duration = typeof entry.durationMs === 'number' && Number.isFinite(entry.durationMs) ? ` (${Math.max(0, Math.min(86_400_000, Math.floor(entry.durationMs)))}ms)` : '';
  return `${time} ${severity} ${context ? `${context} ` : ''}${action}${result}${duration}`.slice(0, 320);
}

interface Snapshot { signature?: string; occurrences: Map<string, number> }

/** The writer replaces a bounded snapshot atomically, so compare full snapshots rather than truncating read chunks. */
async function readNew(path: string, state: Snapshot): Promise<string[]> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch { delete state.signature; return []; }
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > BigInt(MAX_FILE_BYTES)) return [];
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    if (signature === state.signature) return [];
    const bytes = Buffer.alloc(Number(info.size));
    let position = 0;
    while (position < bytes.length) {
      const read = await handle.read(bytes, position, bytes.length - position, position);
      if (!read.bytesRead) break;
      position += read.bytesRead;
    }
    const lines = bytes.subarray(0, position).toString('utf8').split('\n');
    lines.pop(); // A partial appended row waits for a later observation.
    const occurrences = new Map<string, number>();
    const output: string[] = [];
    for (const line of lines.slice(-MAX_ENTRIES)) {
      if (!line || Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; }
      const rendered = display(parsed);
      if (!rendered) continue;
      const identity = createHash('sha256').update(line).digest('hex');
      const count = (occurrences.get(identity) ?? 0) + 1;
      occurrences.set(identity, count);
      if (count > (state.occurrences.get(identity) ?? 0)) output.push(rendered);
    }
    state.signature = signature;
    state.occurrences = occurrences;
    return output;
  } finally { await handle.close(); }
}

const path = process.argv[2];
if (!path || path.length > 4096) process.exitCode = 2;
else {
  const state: Snapshot = { occurrences: new Map() };
  let stopped = false;
  let polling = false;
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try { for (const line of await readNew(path, state)) process.stdout.write(`${line}\n`); }
    catch { /* diagnostics must not take down the viewer */ }
    finally { polling = false; }
  };
  const timer = setInterval(() => { void poll(); }, POLL_MS);
  const stop = () => { stopped = true; clearInterval(timer); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  void poll();
}
