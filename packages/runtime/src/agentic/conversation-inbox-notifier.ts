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
  /** Durable host receipt for an advisory notification or safe-prompt failure; original inbox notice remains pending. */
  recordDeliveryFailure?(messageIds: readonly string[], reason: string): Promise<void>;
  /** Host-owned durable budget, reserved before typing; false requires manual Conversation input. */
  reserveNudge?(messageIds: readonly string[]): Promise<boolean>;
  now(): number;
}

/** OS notification attempts per notice before the advisory notification is given up (e.g. `herdr notification show` unsupported). */
export const MAX_NOTIFICATION_FAILURES = 3;

export type InboxTickOutcome = "idle" | "notified" | "nudged" | "nudge_backoff" | "nudge_exhausted" | "pane_unavailable" | "pane_busy" | "input_not_empty" | "delivery_failed";

/**
 * One inbox pass. User decisions and blocks are re-notified with backoff until displayed; other notices notify once. A notice
 * still unsurfaced (not yet in a Conversation turn's context) is nudged into an idle pane with an empty input box, and the nudge
 * is retried with backoff until a turn surfaces it. Delivery into the session never counts as surfaced.
 */
export class ConversationInboxNotifier {
  private readonly reminders = new Map<string, ReminderState>();
  private readonly retryNotifications = new Set<string>();
  /** Consecutive OS notification failures per notice; the advisory notification stops after MAX_NOTIFICATION_FAILURES (the nudge is separate). */
  private readonly notificationFailures = new Map<string, number>();
  private nudge: NudgeState | undefined;

  /** A recreated or resurfaced notice is new work: it is re-notified and nudged on the next pass. */
  forget(messageId: string): void {
    this.reminders.delete(messageId); this.retryNotifications.delete(messageId); this.notificationFailures.delete(messageId); this.nudge = undefined;
  }

  async tick(ports: ConversationInboxPorts): Promise<InboxTickOutcome> {
    const unsurfaced = await ports.unsurfacedNotices(), undisplayed = await ports.undisplayedNotices();
    if (!unsurfaced.length && !undisplayed.length) return "idle";
    const now = ports.now(), due: { id: string; body: string }[] = [];
    for (const notice of [...undisplayed, ...unsurfaced.filter(item => !undisplayed.some(other => other.messageId === item.messageId))]) {
      const rendered = renderConversationNotice(notice), userFacing = isUserFacingNotice(rendered);
      const state = this.reminders.get(notice.messageId);
      if (userFacing ? reminderDue(state, now) : state === undefined || this.retryNotifications.has(notice.messageId) && reminderDue(state, now)) {
        due.push({ id: notice.messageId, body: userFacing ? notificationBody(rendered) : rendered.display });
      }
    }
    if (due.length) {
      let notificationSucceeded = true;
      try { await ports.notify(`Bflow: ${due.length} cập nhật mới`, due.map(item => item.body).join("\n---\n").slice(0, 1200)); }
      catch (error) {
        notificationSucceeded = false;
        for (const item of due) {
          const failures = (this.notificationFailures.get(item.id) ?? 0) + 1;
          this.notificationFailures.set(item.id, failures);
          const exhausted = failures >= MAX_NOTIFICATION_FAILURES;
          this.reminders.set(item.id, { shows: (this.reminders.get(item.id)?.shows ?? 0) + 1, nextAt: exhausted ? Number.POSITIVE_INFINITY : now + 60_000 });
          if (exhausted) this.retryNotifications.delete(item.id); else this.retryNotifications.add(item.id);
        }
        await ports.recordDeliveryFailure?.(due.map(item => item.id), String(error));
        // The OS notification is advisory; still attempt the separate safe Conversation wake below.
      }
      if (notificationSucceeded) {
        for (const item of due) {
          this.retryNotifications.delete(item.id); this.notificationFailures.delete(item.id);
          const notice = [...undisplayed, ...unsurfaced].find(candidate => candidate.messageId === item.id);
          this.reminders.set(item.id, notice && isUserFacingNotice(renderConversationNotice(notice))
            ? afterReminder(this.reminders.get(item.id), now) : { shows: (this.reminders.get(item.id)?.shows ?? 0) + 1, nextAt: now + 60_000 });
        }
      }
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
    if (ports.reserveNudge && !await ports.reserveNudge([...new Set([...unsurfaced.map(item => item.messageId), ...due.map(item => item.id)])]))
      return "nudge_exhausted";
    this.nudge = afterNudge(this.nudge, key, now);
    try { await ports.prompt(paneId, BFLOW_INBOX_NUDGE); }
    catch (error) {
      await ports.recordDeliveryFailure?.(unsurfaced.map(item => item.messageId), String(error));
      return "delivery_failed";
    }
    return "nudged";
  }
}
