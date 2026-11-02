import {
  WebAgentTranscriptSchema, WebWorkforceExcerptsSchema, type SessionManifest, type WebAgentExcerpt,
} from "@bflow/contracts";
import type { JournalState } from "../agentic/journal.js";
import { listWorkforcePanes, projectWorkforce, type Listed } from "./workforce.js";

const EXCERPT_LINES = 4, EXCERPT_MAX = 600, TRANSCRIPT_MAX = 64000, MAX_ITEMS = 100;
const EXCERPT_READ_LINES = 60, TRANSCRIPT_READ_LINES = 400, READ_CONCURRENCY = 4;

/** Keeps the tail of `text`, never starting on half of a surrogate pair. */
function tailSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  const start = text.length - max, code = text.charCodeAt(start);
  return text.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start);
}

const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const ESC_OTHER = /\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[ -/]*[0-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Strips ANSI and control sequences and trailing spaces; keeps line breaks. */
export function cleanTerminalText(raw: string): string {
  return raw.replace(OSC, "").replace(CSI, "").replace(ESC_OTHER, "").replace(/\r\n?/g, "\n").replace(CONTROL, "")
    .split("\n").map(line => line.replace(/[ \t]+$/, "")).join("\n");
}

const BOX_EDGE = /^[\s─-╿▀-▟]+|[\s─-╿▀-▟]+$/gu;
const PROMPT = /^[>❯›](?:\s|$)/u;
const FOOTER: readonly RegExp[] = [
  /esc to interrupt/i, /ctrl\s*\+\s*[a-z]/i, /shift\s*\+\s*tab/i, /\? for shortcuts/i,
  /^(?:[⏵▶►»>]+\s*)?(?:accept edits|auto-accept edits|bypass permissions|plan mode|auto mode)\b/i,
  /\b(?:permission mode|full[- ]access|read[- ]only|workspace[- ]write)\b.*\b(?:on|mode)\b/i,
  /\b\d{1,3}(?:\.\d+)?\s*%\s*(?:context|left|used|remaining|full)/i, /\bcontext\s+(?:left|window|remaining|used)\b/i,
  /\b[\d.,]+\s*[kKmM]?\s*tokens?\b/i, /\b(?:\d{1,3}%)\s*·/u,
];
const meaningful = (line: string): string | undefined => {
  const text = line.replace(BOX_EDGE, "");
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return undefined;
  if (PROMPT.test(text) || /^[>❯›]$/u.test(text)) return undefined;
  return FOOTER.some(pattern => pattern.test(text)) ? undefined : text;
};

/** The last meaningful output of a cleaned terminal snapshot: at most four lines, tail-cut to 600 characters. */
export function excerptOf(cleanText: string): string | undefined {
  const lines: string[] = [];
  for (const line of cleanText.split("\n")) {
    const text = meaningful(line);
    if (text !== undefined) lines.push(text);
  }
  const text = tailSafe(lines.slice(-EXCERPT_LINES).join("\n"), EXCERPT_MAX).replace(/^\s+/, "");
  return text === "" ? undefined : text;
}

export interface TranscriptSources {
  manifest: SessionManifest;
  state: JournalState;
  sessionId: string;
  projectId: string;
  observedAt: string;
  /** The strict redactor (secrets and absolute paths). */
  redact: (text: string) => string;
  readPane: (paneId: string, lines: number) => Promise<string>;
}

const read = async (s: TranscriptSources, item: Listed, lines: number): Promise<string | undefined> => {
  try {
    const raw = await s.readPane(item.pane.paneId, lines);
    return s.redact(cleanTerminalText(typeof raw === "string" ? raw : ""));
  } catch {
    return undefined;
  }
};

async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Last meaningful output of the panes that are working or hold open work, plus the Conversation pane. */
export async function readWorkforceExcerpts(s: TranscriptSources) {
  const listed = listWorkforcePanes(s.manifest, Date.parse(s.observedAt));
  const view = projectWorkforce({ state: s.state, sessionId: s.sessionId, observedAt: s.observedAt, core: new Map(), ready: true,
    manifest: s.manifest, projectId: s.projectId, redact: s.redact, redactOption: s.redact });
  const busy = new Set(view.agents.filter(agent => agent.work.length > 0).map(agent => agent.instanceId));
  const wanted = listed.slice(0, MAX_ITEMS).filter(item => item.allocation === "active" &&
    (busy.has(item.instanceId) || item.pane.transportState === "working" || item.role === "conversation"));
  const texts = await mapBounded(wanted, READ_CONCURRENCY, async item => {
    const text = await read(s, item, EXCERPT_READ_LINES);
    return text === undefined ? undefined : excerptOf(text);
  });
  const items: WebAgentExcerpt[] = [];
  wanted.forEach((item, i) => {
    const text = texts[i];
    if (text) items.push({ instanceId: item.instanceId, text, observedAt: s.observedAt });
  });
  return { ok: true as const, value: WebWorkforceExcerptsSchema.parse({
    apiVersion: 1, projectId: s.projectId, sessionId: s.sessionId, items, observedAt: s.observedAt }) };
}

/** Read-only terminal snapshot of one listed agent. It is unverified text and never task evidence. */
export async function readAgentTranscript(s: TranscriptSources, instanceId: string) {
  const item = listWorkforcePanes(s.manifest, Date.parse(s.observedAt)).find(candidate => candidate.instanceId === instanceId);
  if (!item)
    return { ok: false as const, error: { code: "not_found" as const, retryable: false as const, message: "Agent not found in this session." } };
  const cleaned = await read(s, item, TRANSCRIPT_READ_LINES);
  if (cleaned === undefined)
    return { ok: false as const, error: { code: "transport_unavailable" as const, retryable: true as const, message: "Terminal output is unavailable for this agent." } };
  const truncated = cleaned.length > TRANSCRIPT_MAX;
  return { ok: true as const, value: WebAgentTranscriptSchema.parse({
    apiVersion: 1, projectId: s.projectId, sessionId: s.sessionId, instanceId, source: "terminal_snapshot",
    text: tailSafe(cleaned, TRANSCRIPT_MAX), truncated, observedAt: s.observedAt }) };
}
