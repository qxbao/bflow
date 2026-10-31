import { redactString } from "../resilience/redaction.js";

/**
 * Invalid RoleMessages one sender may produce for the same assignment before Runtime hands the run to the Coordinator
 * (an automatic, bounded `auto_resume`). Earlier ones are returned to the sender so it can fix and resend.
 */
export const INVALID_ROLE_MESSAGE_LIMIT = 3;
const MAX_FEEDBACK_LENGTH = 1500;

interface IssueLike { path?: unknown; message?: unknown }
function appendRoleMessageHint(fieldPath: string, message: string): string {
  if (fieldPath === "type") {
    const inventedTaskStatus = /received ['"]task\.(blocked|failed|completed|inconclusive|progress)['"]/i.exec(message);
    if (inventedTaskStatus) {
      const mapped = inventedTaskStatus[1]!.toLowerCase() === "progress" ? "blocked" : inventedTaskStatus[1]!.toLowerCase();
      return `${message} (hint: RoleMessage has no 'task.${inventedTaskStatus[1]}' type; use type 'task.status' with payload.status '${mapped}', or call report_progress / request_user_decision for user communication)`;
    }
  }
  return message;
}
function issueText(issues: readonly IssueLike[]): string | undefined {
  const parts = issues.flatMap(issue => {
    if (typeof issue?.message !== "string") return [];
    const fieldPath = Array.isArray(issue.path) && issue.path.length ? issue.path.map(String).join(".") : "(message)";
    return [`${fieldPath}: ${appendRoleMessageHint(fieldPath, issue.message)}`];
  });
  return parts.length ? parts.join("; ") : undefined;
}
/** Zod issues embedded in an error's text (String(ZodError) is the JSON issue list), when present. */
function embeddedIssues(text: string): string | undefined {
  const start = text.indexOf("[");
  if (start < 0) return undefined;
  for (let end = text.lastIndexOf("]"); end > start; end = text.lastIndexOf("]", end - 1)) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return issueText(parsed as IssueLike[]);
    } catch { /* not this bracket pair */ }
  }
  return undefined;
}
/**
 * Readable, bounded and redacted validation feedback for the sending agent: each field path with its schema message, e.g.
 * `payload.status: Invalid enum value`. Falls back to the error text itself when it carries no structured issues.
 */
export function describeValidationError(error: unknown): string {
  const issues = typeof error === "object" && error !== null && Array.isArray((error as { issues?: unknown }).issues)
    ? issueText((error as { issues: IssueLike[] }).issues) : undefined;
  const text = issues ?? embeddedIssues(String(error)) ?? String(error);
  const clean = redactString(text).replace(/\s+/g, " ").trim();
  return clean.length > MAX_FEEDBACK_LENGTH ? `${clean.slice(0, MAX_FEEDBACK_LENGTH - 1)}…` : clean;
}
/** An inbound failure caused by the message's own content (schema/unsupported type), not by transport or Runtime state. */
export function isMessageContentFailure(reason: string): boolean {
  return /ZodError|invalid_type|invalid_enum_value|invalid_union|invalid_literal|invalid_value|unrecognized_keys|Unsupported inbound message|Rework submission|Invalid rework findingResolution|Rework finding '/.test(reason);
}
