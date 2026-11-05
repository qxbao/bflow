import { z } from "zod";

/** One long-lived Claude Code process receives all Director turns on stdin. */
export function claudeDirectorArgs(): readonly string[] {
  return [
    "--dangerously-skip-permissions", "-p", "--input-format", "stream-json",
    "--output-format", "stream-json", "--verbose", "--permission-prompts", "none"
  ];
}

/** The JSONL frame used by Claude Code's documented streaming input mode. */
export function encodeClaudeDirectorPrompt(prompt: string): string {
  if (prompt.trim() === "") throw new Error("Claude Director prompt is empty");
  return JSON.stringify({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null });
}

const ResultSchema = z.object({
  type: z.literal("result"), subtype: z.literal("success"), is_error: z.literal(false),
  session_id: z.string().uuid()
}).passthrough();

export function classifyClaudeDirectorEvent(event: unknown):
  | { kind: "other" }
  | { kind: "turn_complete"; success: boolean; conversationId?: string } {
  if (typeof event !== "object" || event === null || !Object.hasOwn(event, "type") || (event as { type: unknown }).type !== "result")
    return { kind: "other" };
  const result = ResultSchema.safeParse(event);
  return result.success
    ? { kind: "turn_complete", success: true, conversationId: result.data.session_id }
    : { kind: "turn_complete", success: false };
}
