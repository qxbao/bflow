import { describe, expect, it } from "vitest";
import { claudeDirectorArgs, classifyClaudeDirectorEvent, encodeClaudeDirectorPrompt } from "../src/director-wake-claude.js";

describe("Claude Director stream adapter", () => {
  it("keeps one Claude process open for streamed turns without putting a token in argv", () => {
    const args = claudeDirectorArgs();
    expect(args).toEqual([
      "--dangerously-skip-permissions", "-p", "--input-format", "stream-json",
      "--output-format", "stream-json", "--verbose", "--permission-prompts", "none"
    ]);
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--fork-session");
  });

  it("encodes each prompt as one complete user frame even when the prompt contains newlines", () => {
    const encoded = encodeClaudeDirectorPrompt("BFLOW_DIRECTOR_WAKE 123\nCheck the queue.");
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(encoded)).toEqual({
      type: "user", message: { role: "user", content: "BFLOW_DIRECTOR_WAKE 123\nCheck the queue." },
      parent_tool_use_id: null
    });
  });

  it("recognizes only a successful result with a concrete session ID as a completed turn", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    expect(classifyClaudeDirectorEvent({ type: "result", subtype: "success", is_error: false, session_id: id, result: "done" }))
      .toEqual({ kind: "turn_complete", success: true, conversationId: id });
    expect(classifyClaudeDirectorEvent({ type: "assistant", message: { content: [] } })).toEqual({ kind: "other" });
  });

  it("fails closed on error results and malformed result receipts", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    for (const event of [
      { type: "result", subtype: "error_max_turns", is_error: true, session_id: id },
      { type: "result", subtype: "success", is_error: true, session_id: id },
      { type: "result", subtype: "success", is_error: false, session_id: "not-a-uuid" },
      { type: "result", subtype: "success", session_id: id },
    ]) {
      expect(classifyClaudeDirectorEvent(event)).toEqual({ kind: "turn_complete", success: false });
    }
  });
});
