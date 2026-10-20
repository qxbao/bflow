/** Fixed, non-user prompt the host may type into an idle Conversation pane to make it read its inbox. Never an approval. */
export const BFLOW_INBOX_NUDGE = "[bflow] Có cập nhật mới từ Runtime";

const RULE = /^\s*[─━]{8,}\s*$/u;
/** Empty prompt: `❯` followed only by spaces or no-break spaces. Any other text, including a ghost suggestion, is not empty. */
const EMPTY_CURRENT_PROMPT = /^\s*❯[\s ]*$/u;

/**
 * True only when the provider's visible input box is verifiably empty. Fails closed: any provider other than Claude,
 * any unrecognised layout, or any typed/placeholder text returns false, so a nudge never merges with a user draft.
 * Recognises the current Claude layout (rule, `❯` prompt, rule, optional status line) and the older boxed layout.
 */
export function isProviderInputEmpty(provider: string, visibleText: string): boolean {
  if (provider !== "claude") return false;
  const lines = visibleText.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return isCurrentLayoutEmpty(lines) || isBoxedLayoutEmpty(lines);
}

function isCurrentLayoutEmpty(lines: string[]): boolean {
  const prompt = lines.map((line, index) => ({ line, index })).filter(item => /^\s*❯/u.test(item.line)).pop();
  if (!prompt) return false;
  const { line, index } = prompt;
  if (!EMPTY_CURRENT_PROMPT.test(line)) return false;
  // Exactly one prompt line, between a rule above and a rule below; at most one status line may follow the lower rule.
  if (index < 1 || !RULE.test(lines[index - 1]!) || !RULE.test(lines[index + 1] ?? "")) return false;
  const tail = lines.slice(index + 2);
  return tail.length <= 1 && tail.every(item => !RULE.test(item) && !/❯/u.test(item));
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
