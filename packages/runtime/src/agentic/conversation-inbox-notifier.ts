import { afterNudge, afterReminder, BFLOW_INBOX_NUDGE, isProviderInputEmpty, nudgeDue, reminderDue, stripGhostSuggestion,
  type NudgeState, type ReminderState } from "./conversation-inbox.js";
import { isUserFacingNotice, notificationBody, renderConversationNotice, type NoticeLike } from "./conversation-notice-render.js";
import { digest } from "./journal.js";

/** Host effects the inbox notifier needs; the daemon backs them with receipts and the Herdr CLI. */
export interface ConversationInboxPorts {
  readonly provider: string;
  unsurfacedNotices(): Promise<readonly NoticeLike[]>;
  undisplayedNotices(): Promise<readonly NoticeLike[]>;
  conversationPaneId(): Promise<string | undefined>;
  agentStatus(paneId: string): Promise<string>;
  /** Visible pane snapshot with ANSI styling, so Claude's dim ghost suggestion is distinguishable from a typed draft. */
  readPaneAnsi(paneId: string): Promise<string>;
  notify(title: string, body: string): Promise<void>;
  prompt(paneId: string, text: string): Promise<void>;
  now(): number;
}

export type InboxTickOutcome = "idle" | "notified" | "nudged" | "nudge_backoff" | "pane_unavailable" | "pane_busy" | "input_not_empty";

/**
 * One inbox pass. User decisions and blocks are re-notified with backoff until displayed; other notices notify once. A notice
 * still unsurfaced (not yet in a Conversation turn's context) is nudged into an idle pane with an empty input box, and the nudge
 * is retried with backoff until a turn surfaces it. Delivery into the session never counts as surfaced.
 */
export class ConversationInboxNotifier {
  private readonly reminders = new Map<string, ReminderState>();
  private nudge: NudgeState | undefined;

  /** A recreated or resurfaced notice is new work: it is re-notified and nudged on the next pass. */
  forget(messageId: string): void { this.reminders.delete(messageId); this.nudge = undefined; }

  async tick(ports: ConversationInboxPorts): Promise<InboxTickOutcome> {
    const unsurfaced = await ports.unsurfacedNotices(), undisplayed = await ports.undisplayedNotices();
    if (!unsurfaced.length && !undisplayed.length) return "idle";
    const now = ports.now(), due: { id: string; body: string }[] = [];
    for (const notice of [...undisplayed, ...unsurfaced.filter(item => !undisplayed.some(other => other.messageId === item.messageId))]) {
      const rendered = renderConversationNotice(notice), userFacing = isUserFacingNotice(rendered);
      const state = this.reminders.get(notice.messageId);
      if (userFacing ? reminderDue(state, now) : state === undefined) {
        due.push({ id: notice.messageId, body: userFacing ? notificationBody(rendered) : rendered.display });
        this.reminders.set(notice.messageId, userFacing ? afterReminder(state, now) : { shows: 1, nextAt: Number.POSITIVE_INFINITY });
      }
    }
    if (due.length) {
      try { await ports.notify(`Bflow: ${due.length} cập nhật mới`, due.map(item => item.body).join("\n---\n").slice(0, 1200)); }
      catch { /* the notification is advisory; the nudge below is the wake-up */ }
    }
    // Nudge for unsurfaced notices, or for user-facing notices that were just re-shown.
    if (!unsurfaced.length && !due.some(item => undisplayed.some(notice => notice.messageId === item.id))) return due.length ? "notified" : "idle";
    const key = digest([...unsurfaced.map(notice => notice.messageId), ...due.map(item => item.id)].sort());
    if (!nudgeDue(this.nudge, key, now)) return "nudge_backoff";
    const paneId = await ports.conversationPaneId();
    if (!paneId) return "pane_unavailable";
    // Re-checked immediately before submission; any doubt (busy, draft, unknown layout) skips the nudge until the next pass.
    if (await ports.agentStatus(paneId) !== "idle") return "pane_busy";
    if (!isProviderInputEmpty(ports.provider, stripGhostSuggestion(await ports.readPaneAnsi(paneId)))) return "input_not_empty";
    this.nudge = afterNudge(this.nudge, key, now);
    await ports.prompt(paneId, BFLOW_INBOX_NUDGE);
    return "nudged";
  }
}
