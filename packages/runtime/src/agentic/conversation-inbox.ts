/** Fixed, non-user prompt the host may type into an idle Conversation pane to make it read its inbox. Never an approval. */
export const BFLOW_INBOX_NUDGE = "[bflow] Có cập nhật mới từ Runtime";

/**
 * True only when the provider's visible input box is verifiably empty. Fails closed: any provider other than Claude,
 * any unrecognised layout, or any typed/placeholder text returns false, so a nudge never merges with a user draft.
 */
export function isProviderInputEmpty(provider: string, visibleText: string): boolean {
  if (provider !== "claude") return false;
  const lines = visibleText.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  const bottom = lines[lines.length - 1], prompt = lines[lines.length - 2];
  if (bottom === undefined || prompt === undefined) return false;
  return /^\s*╰─+╯?\s*$/u.test(bottom) && /^\s*│\s*[>❯]\s*│?\s*$/u.test(prompt);
}
