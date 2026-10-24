/** Fixed, non-user prompt the host may type into an idle Conversation pane to make it read its inbox. Never an approval. */
export const BFLOW_INBOX_NUDGE = "[bflow] Có cập nhật mới từ Runtime";

const RULE = /^\s*[─━]{8,}\s*$/u;
/** Empty prompt: `❯` or `>` followed only by spaces or no-break spaces. Any other text, including a ghost suggestion, is not empty. */
const EMPTY_CURRENT_PROMPT = /^\s*[❯>][\s ]*$/u;

/**
 * True only when the provider's visible input box is verifiably empty. Supports observed Claude and Codex layouts;
 * any unrecognised layout or typed text returns false, so a nudge never merges with a user draft.
 * Recognises the current Claude layout (rule, `❯` prompt, rule, optional status line) and the older boxed layout.
 */
export function isProviderInputEmpty(provider: string, visibleText: string): boolean {
  const lines = visibleText.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (provider === "codex") {
    const index = lines.map((line, index) => ({ line, index })).filter(item => /^\s*›/u.test(item.line)).pop()?.index;
    if (index === undefined || !/^\s*›\s*$/u.test(lines[index]!)) return false;
    const footer = lines.slice(index + 1).filter(line => line.trim() !== "");
    return footer.length === 2 && /\s·\s+(?:\/|~\/|[A-Za-z]:\\)/u.test(footer[0]!) &&
      /^\s*\?\s+for shortcuts\b/u.test(footer[1]!);
  }
  if (provider !== "claude" && provider !== "agy") return false;
  return isCurrentLayoutEmpty(lines) || isBoxedLayoutEmpty(lines);
}

/**
 * ANSI snapshot → plain text with the `❯` prompt line's faint (SGR 2) runs removed. After every turn Claude shows its next-prompt
 * suggestion as dim ghost text after `❯`, which a text snapshot cannot tell from a typed draft; a typed draft renders normally,
 * so it survives and still fails the empty check. Every other line only loses its escape sequences.
 */
export function stripGhostSuggestion(ansiText: string): string {
  return ansiText.split(/\r?\n/).map(line => {
    const plain = line.replace(/\x1b\[[0-9;:]*[@-~]/g, "");
    const prompt = line.includes("❯") || line.includes("›") || /^\s*>(?:[\s ]|$)/u.test(plain);
    let out = "", faint = false;
    for (let index = 0; index < line.length;) {
      const csi = /^\x1b\[([0-9;:]*)([@-~])/.exec(line.slice(index));
      if (csi) {
        if (csi[2] === "m") faint = sgrFaint(csi[1]!, faint);
        index += csi[0].length; continue;
      }
      if (line[index] === "\x1b") { index++; continue; }
      if (!prompt || !faint) out += line[index];
      index++;
    }
    return out;
  }).join("\n");
}

/** Faint state after one SGR sequence; skips extended-colour arguments so `38;2;…` never reads as faint, while `38;5;8` (Agy placeholder grey) is treated as ghost text on prompt lines. */
function sgrFaint(parameters: string, faint: boolean): boolean {
  const codes = parameters === "" ? [0] : parameters.split(/[;:]/).map(code => Number(code || 0));
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]!;
    if (code === 38) {
      if (codes[index + 1] === 5) {
        faint = codes[index + 2] === 8;
        index += 2;
        continue;
      }
      index += codes[index + 1] === 2 ? 4 : 1;
      continue;
    }
    if (code === 48 || code === 58) { index += codes[index + 1] === 5 ? 2 : codes[index + 1] === 2 ? 4 : 1; continue; }
    if (code === 0 || code === 22 || code === 39) faint = false;
    else if (code === 2) faint = true;
  }
  return faint;
}

/** Nudge retry backoff while a notice stays unsurfaced (pane busy, typed nudge lost): 5 s, 10 s, 20 s, then 60 s. */
export const NUDGE_BACKOFF_MS = [5_000, 10_000, 20_000, 60_000] as const;
export interface NudgeState { readonly key: string; readonly attempts: number; readonly nextAt: number }
/** A different set of waiting notices is new work: it is nudged immediately instead of inheriting an older backoff. */
export function nudgeDue(state: NudgeState | undefined, key: string, now: number): boolean {
  return state === undefined || state.key !== key || now >= state.nextAt;
}
export function afterNudge(state: NudgeState | undefined, key: string, now: number): NudgeState {
  const attempts = state?.key === key ? state.attempts + 1 : 1;
  return { key, attempts, nextAt: now + NUDGE_BACKOFF_MS[Math.min(attempts - 1, NUDGE_BACKOFF_MS.length - 1)]! };
}
/** Inbox check period; `BFLOW_INBOX_CHECK_MS` overrides it within 500 ms–30 s. */
export function inboxCheckIntervalMs(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 500 && parsed <= 30_000 ? parsed : 2_000;
}

function isCurrentLayoutEmpty(lines: string[]): boolean {
  const prompt = lines.map((line, index) => ({ line, index })).filter(item => /^\s*[❯>]/u.test(item.line)).pop();
  if (!prompt) return false;
  const { line, index } = prompt;
  if (!EMPTY_CURRENT_PROMPT.test(line)) return false;
  // Exactly one prompt line, between a rule above and a rule below; at most one status line may follow the lower rule.
  if (index < 1 || !RULE.test(lines[index - 1]!) || !RULE.test(lines[index + 1] ?? "")) return false;
  const tail = lines.slice(index + 2);
  return tail.length <= 1 && tail.every(item => !RULE.test(item) && !/[❯>]/u.test(item));
}

function isBoxedLayoutEmpty(lines: string[]): boolean {
  const bottom = lines[lines.length - 1], prompt = lines[lines.length - 2];
  if (bottom === undefined || prompt === undefined) return false;
  return /^\s*╰─+╯?\s*$/u.test(bottom) && /^\s*│\s*[>❯]\s*│?\s*$/u.test(prompt);
}

/** Reminder backoff after each show of a user-facing notice: 60 s, 120 s, 240 s, then 600 s. */
export const REMINDER_BACKOFF_MS = [60_000, 120_000, 240_000, 600_000] as const;

export interface ReminderState { readonly shows: number; readonly nextAt: number }

/** Delay before the next show, given how many times the notice has been shown (1 or more). */
export function reminderDelayMs(shows: number): number {
  return REMINDER_BACKOFF_MS[Math.min(Math.max(shows, 1), REMINDER_BACKOFF_MS.length) - 1]!;
}

/** Whether a notice is due for a reminder now. A notice never shown before is due immediately. */
export function reminderDue(state: ReminderState | undefined, now: number): boolean {
  return state === undefined || now >= state.nextAt;
}

/** State after one more show at `now`. */
export function afterReminder(state: ReminderState | undefined, now: number): ReminderState {
  const shows = (state?.shows ?? 0) + 1;
  return { shows, nextAt: now + reminderDelayMs(shows) };
}
